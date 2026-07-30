/**
 * Analytical verification of the procedural audio graph.
 *
 *   node tools/audio-probe.mjs [--json shots/audio/probe.json] [--sr 48000]
 *
 * Renders `createAudio({context: OfflineAudioContext})` in headless Chrome over a
 * scripted state sequence (rest -> cruise -> hard carve -> straight schuss -> tuck ->
 * jump -> landing -> hockey stop -> coast) by suspending the offline context every 1/60 s and calling
 * `update(dt, state)` exactly as main.js would. The rendered buffer is then measured
 * per segment: RMS, peak, crest factor, DC offset, spectral centroid and stereo width.
 *
 * Assertions (exit 1 if any fail):
 *   - peak < 1.0 everywhere (no clipping) and no non-finite samples
 *   - |DC| < 0.002 (no offset / integrator runaway)
 *   - level and spectral centroid both rise monotonically across the REAL speed
 *     range the physics produces (30 -> 72 -> 90 km/h), not a fantasy 0-120
 *   - the landing segment shows a clear transient (crest factor well above the bed)
 *   - the tail decays back toward the rest floor (no runaway feedback)
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const JSONOUT = arg('json', 'shots/audio/probe.json');
const SR = +arg('sr', 48000);

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 5222, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 300000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('console: ' + m.text()); });

let exitCode = 0;
let result = null;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  result = await page.evaluate(async (SR) => {
    const { createAudio } = await import('/src/audio/audio.js');

    // ---------------- scripted run -----------------------------------------
    // Each segment: label, duration, and a state generator f(u) with u in 0..1.
    // Speeds are the MEASURED envelope of the current physics, not guesses
    // (tools/ux-trace.mjs / tools/ux-trace2.mjs):
    //   rest 0 · cruise 8.3 m/s (30 km/h) · carving 13-18 (47-65)
    //   straight schuss 20 (72) · tuck 25 (90) · touchdown vy −2..−9.6 m/s.
    const SEG = [
      ['rest', 1.3, () => ({ speed: 0.15, edge: 0, carving: false, airborne: false })],
      ['cruise', 2.0, (u) => ({
        speed: 6.5 + 3.2 * u, edge: 0.3 * Math.sin(u * Math.PI * 2.0),
        carving: false, airborne: false, gForce: 0.2,
      })],
      ['carve', 2.6, (u) => ({
        speed: 13 + 5 * u, edge: 0.85 * Math.sin(u * Math.PI * 3.0),
        carving: true, airborne: false, gForce: 2.2,
      })],
      ['fast', 2.0, () => ({ speed: 20, edge: 0.04, carving: false, airborne: false })],
      ['tuck', 2.2, (u) => ({ speed: 22 + 3.2 * u, edge: 0.03, carving: false, airborne: false, crouch: 1 })],
      ['air', 1.1, (u) => ({
        speed: 24, edge: 0.05, carving: false, airborne: true,
        vy: -1.5 - 8 * u,
      })],
      ['landing', 1.2, (u) => ({
        speed: 21 - 2 * u, edge: -0.25, carving: true, airborne: false, gForce: 1.4,
      })],
      ['stop', 1.6, (u) => ({
        speed: Math.max(0.4, 17 - 17 * Math.min(1, u * 1.6)),
        edge: 0.95, carving: false, airborne: false, brake: 1,
      })],
      ['tail', 1.4, () => ({ speed: 0.2, edge: 0, carving: false, airborne: false })],
    ];
    const total = SEG.reduce((a, s) => a + s[1], 0);

    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(total * SR), sampleRate: SR });
    const audio = createAudio({ context: ctx });

    const DT = 1 / 60;
    const state = {
      pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
      speed: 0, heading: 0, pitch: 0, roll: 0, edge: 0,
      carving: false, airborne: false, crouch: 0, gForce: 0,
      airTime: 0, distance: 0, time: 0,
      input: { steer: 0, crouch: 0, jump: false, brake: 0 },
    };

    // Register a suspend callback for every simulation tick before rendering.
    const marks = [];
    for (let t = 0; t < total - DT; t += DT) marks.push(t);
    for (const t of marks) {
      ctx.suspend(t).then(() => {
        // find the segment for this time
        let acc = 0, seg = SEG[SEG.length - 1], u = 1;
        for (const s of SEG) {
          if (t < acc + s[1]) { seg = s; u = (t - acc) / s[1]; break; }
          acc += s[1];
        }
        const v = seg[2](u);
        state.speed = v.speed;
        state.edge = v.edge;
        state.carving = !!v.carving;
        state.airborne = !!v.airborne;
        state.gForce = v.gForce ?? 0;
        state.crouch = v.crouch ?? 0;
        state.vel.y = v.vy ?? 0;
        state.input.brake = v.brake ?? 0;
        state.time += DT;
        audio.update(DT, state);
        ctx.resume();
      });
    }

    const rendered = await ctx.startRendering();

    // ---------------- measurement ------------------------------------------
    const L = rendered.getChannelData(0), R = rendered.getChannelData(1);

    // radix-2 FFT (in-place, real input)
    function fftMag(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
          let cr = 1, ci = 0;
          for (let k = 0; k < len / 2; k++) {
            const ur = re[i + k], ui = im[i + k];
            const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
            const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
            re[i + k] = ur + vr; im[i + k] = ui + vi;
            re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
            const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
          }
        }
      }
      return re;
    }

    function centroid(ch, from, to) {
      const N = 4096;
      let num = 0, den = 0, frames = 0;
      for (let start = from; start + N < to; start += N) {
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let i = 0; i < N; i++) {
          const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));  // hann
          re[i] = ch[start + i] * w;
        }
        fftMag(re, im);
        let n2 = 0, d2 = 0;
        for (let k = 1; k < N / 2; k++) {
          const mag = Math.hypot(re[k], im[k]);
          const f = (k * SR) / N;
          n2 += mag * f; d2 += mag;
        }
        if (d2 > 1e-9) { num += n2 / d2; frames++; }
      }
      return frames ? num / frames : 0;
    }

    function measure(t0, t1, label) {
      const a = Math.floor(t0 * SR), b = Math.min(Math.floor(t1 * SR), L.length);
      let sum = 0, sq = 0, peak = 0, bad = 0, wsum = 0;
      // 20 ms sliding window peak, for transient detection
      const win = Math.floor(SR * 0.02);
      let winMaxRms = 0, acc = 0, cnt = 0;
      for (let i = a; i < b; i++) {
        const l = L[i], r = R[i];
        if (!Number.isFinite(l) || !Number.isFinite(r)) bad++;
        const m = (l + r) * 0.5;
        sum += m; sq += m * m;
        const ap = Math.max(Math.abs(l), Math.abs(r));
        if (ap > peak) peak = ap;
        wsum += Math.abs(l - r);
        acc += m * m; cnt++;
        if (cnt === win) { winMaxRms = Math.max(winMaxRms, Math.sqrt(acc / cnt)); acc = 0; cnt = 0; }
      }
      const n = b - a;
      const rms = Math.sqrt(sq / n);
      return {
        seg: label,
        t: [+t0.toFixed(2), +t1.toFixed(2)],
        rms: +rms.toFixed(6),
        rmsDb: +(20 * Math.log10(Math.max(rms, 1e-9))).toFixed(2),
        peak: +peak.toFixed(6),
        crest: +(peak / Math.max(rms, 1e-9)).toFixed(2),
        winRms: +winMaxRms.toFixed(6),
        dc: +(sum / n).toFixed(6),
        centroidHz: Math.round(centroid(L, a, b)),
        width: +(wsum / n / Math.max(rms, 1e-9)).toFixed(3),
        nonFinite: bad,
      };
    }

    const out = [];
    let acc = 0;
    for (const s of SEG) {
      // trim 60 ms at each edge so smoothing ramps don't smear the segment stats
      out.push(measure(acc + 0.06, acc + s[1] - 0.06, s[0]));
      acc += s[1];
    }
    // transient detail: the 200 ms bed before the event vs the 120 ms after it
    const landT = SEG.slice(0, 6).reduce((a, s) => a + s[1], 0);   // end of 'air'
    out.push(measure(landT - 0.2, landT, 'landing:before'));
    out.push(measure(landT, landT + 0.12, 'landing:transient'));
    const stopT = SEG.slice(0, 7).reduce((a, s) => a + s[1], 0);   // end of 'landing'
    out.push(measure(stopT - 0.2, stopT, 'stop:before'));
    out.push(measure(stopT, stopT + 0.2, 'stop:transient'));

    // ---------------- wind in isolation ------------------------------------
    // The brief is specific: "wind should be near-silent at rest and genuinely
    // roaring at 75 km/h, with level AND brightness both scaling". Measured
    // inside the full mix that is confounded by the snow bed, so this is a
    // second render of the same graph with the snow bus muted, holding a
    // straight-line schuss at each speed of interest.
    const WSPEED = [0, 8.33, 16.67, 20.83, 25.5];   // m/s = 0/30/60/75/92 km/h
    const HOLD = 1.5;
    const ctxW = new OfflineAudioContext({
      numberOfChannels: 2, length: Math.ceil(WSPEED.length * HOLD * SR), sampleRate: SR,
    });
    const audioW = createAudio({ context: ctxW });
    audioW.nodes.snowBus.gain.value = 0;             // wind only
    const stW = {
      pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
      speed: 0, heading: 0, pitch: 0, roll: 0, edge: 0,
      carving: false, airborne: false, crouch: 0, gForce: 0,
      airTime: 0, distance: 0, time: 0,
      input: { steer: 0, crouch: 0, jump: false, brake: 0 },
    };
    const totalW = WSPEED.length * HOLD;
    for (let t = 0; t < totalW - DT; t += DT) {
      const tt = t;
      ctxW.suspend(tt).then(() => {
        stW.speed = WSPEED[Math.min(WSPEED.length - 1, Math.floor(tt / HOLD))];
        audioW.update(DT, stW);
        ctxW.resume();
      });
    }
    const renderedW = await ctxW.startRendering();
    const WL = renderedW.getChannelData(0), WR = renderedW.getChannelData(1);
    const wind = WSPEED.map((sp, i) => {
      // skip the first 0.5 s of each hold so the smoothing ramp has settled
      const a = Math.floor((i * HOLD + 0.5) * SR), b = Math.floor((i * HOLD + HOLD - 0.02) * SR);
      let sq = 0, pk = 0;
      for (let k = a; k < b; k++) {
        const m = (WL[k] + WR[k]) * 0.5;
        sq += m * m;
        const ap = Math.max(Math.abs(WL[k]), Math.abs(WR[k]));
        if (ap > pk) pk = ap;
      }
      const rms = Math.sqrt(sq / (b - a));
      return {
        kmh: +(sp * 3.6).toFixed(0),
        rms: +rms.toFixed(6),
        rmsDb: +(20 * Math.log10(Math.max(rms, 1e-9))).toFixed(2),
        peak: +pk.toFixed(5),
        centroidHz: Math.round(centroid(WL, a, b)),
      };
    });

    let gPeak = 0, gBad = 0, gSum = 0, gSq = 0;
    for (let i = 0; i < L.length; i++) {
      const ap = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (ap > gPeak) gPeak = ap;
      if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) gBad++;
      const m = (L[i] + R[i]) * 0.5;
      gSum += m; gSq += m * m;
    }
    return {
      sampleRate: SR, duration: +total.toFixed(2),
      globalPeak: +gPeak.toFixed(6), globalDc: +(gSum / L.length).toFixed(7),
      globalRms: +Math.sqrt(gSq / L.length).toFixed(6),
      nonFinite: gBad, segments: out, wind,
    };
  }, SR);
} catch (e) {
  errors.push('probe: ' + (e?.message ?? String(e)));
  exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

if (!result) {
  console.error('--- errors ---');
  errors.forEach((e) => console.error('  ' + e));
  process.exit(1);
}

// ------------------------------------------------------------- report -------
const by = Object.fromEntries(result.segments.map((s) => [s.seg, s]));
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nsampleRate=${result.sampleRate}  duration=${result.duration}s  ` +
  `globalPeak=${result.globalPeak}  globalRms=${result.globalRms}  globalDc=${result.globalDc}\n`);
console.log(pad('segment', 20) + pad('rms', 11) + pad('rms dB', 9) + pad('peak', 10) +
  pad('crest', 8) + pad('centroid', 10) + pad('dc', 11) + 'width');
for (const s of result.segments) {
  console.log(pad(s.seg, 20) + pad(s.rms.toFixed(5), 11) + pad(s.rmsDb.toFixed(1), 9) +
    pad(s.peak.toFixed(4), 10) + pad(s.crest.toFixed(2), 8) + pad(s.centroidHz + ' Hz', 10) +
    pad(s.dc.toFixed(5), 11) + s.width.toFixed(2));
}

const checks = [];
const ck = (name, ok, detail) => { checks.push({ name, ok, detail }); if (!ok) exitCode = 1; };

ck('no clipping, with headroom (global peak < 0.95)', result.globalPeak < 0.95, `peak=${result.globalPeak}`);
ck('all samples finite', result.nonFinite === 0, `nonFinite=${result.nonFinite}`);
// DC is judged relative to signal level: a 40 Hz landing thud legitimately
// carries a large mean inside a 120 ms window, so the absolute test only makes
// sense across the whole render.
ck('no DC offset over the full render (|dc| < 1e-3)',
  Math.abs(result.globalDc) < 1e-3, `globalDc=${result.globalDc} (rms ${result.globalRms})`);
ck('per-segment DC at least 20 dB below signal',
  result.segments.every((s) => Math.abs(s.dc) / Math.max(s.rms, 1e-6) < 0.1),
  'max dc/rms=' + Math.max(...result.segments.map((s) => Math.abs(s.dc) / Math.max(s.rms, 1e-6))).toFixed(4));
ck('rest is near silent (< -50 dB)', by.rest.rmsDb < -50, `${by.rest.rmsDb} dB`);
// The important assertion for this round: the mapping has to be graded across
// the speeds the game ACTUALLY produces, not across a 0-120 km/h fantasy range.
ck('level rises monotonically 30 -> 72 -> 90 km/h',
  by.fast.rms > by.cruise.rms * 1.6 && by.tuck.rms > by.fast.rms * 1.15,
  `cruise ${by.cruise.rmsDb} -> fast ${by.fast.rmsDb} -> tuck ${by.tuck.rmsDb} dB ` +
  `(+${(by.tuck.rmsDb - by.cruise.rmsDb).toFixed(1)} dB across the real range)`);
ck('centroid rises monotonically 30 -> 72 -> 90 km/h',
  by.fast.centroidHz > by.cruise.centroidHz * 1.1 && by.tuck.centroidHz > by.fast.centroidHz,
  `${by.cruise.centroidHz} -> ${by.fast.centroidHz} -> ${by.tuck.centroidHz} Hz`);
ck('level rises rest -> cruise -> carve',
  by.cruise.rms > by.rest.rms * 4 && by.carve.rms > by.cruise.rms * 1.5,
  `${by.rest.rmsDb} -> ${by.cruise.rmsDb} -> ${by.carve.rmsDb} dB`);
ck('carving is the bright voice (centroid above cruise and above a skidded stop)',
  by.carve.centroidHz > by.cruise.centroidHz && by.carve.centroidHz > by.stop.centroidHz,
  `carve ${by.carve.centroidHz} vs cruise ${by.cruise.centroidHz} vs stop ${by.stop.centroidHz} Hz`);
ck('airborne cuts the snow bed and leaves wind (level held, no ski shear)',
  by.air.rms > by.cruise.rms && by.air.centroidHz < by.carve.centroidHz,
  `air ${by.air.centroidHz} Hz @ ${by.air.rmsDb} dB vs carve ${by.carve.centroidHz} Hz`);
const onset = (a, b) => by[a].winRms / Math.max(by[b].rms, 1e-9);
// Peak alone is a poor transient test against a noise bed (noise crest is
// already ~4-5), so the onset is judged on short-window RMS, with peak only
// required not to be swallowed.
ck('landing is a clear onset (>= 2.5x the bed it lands into)',
  onset('landing:transient', 'landing:before') >= 2.5 &&
  by['landing:transient'].peak > by['landing:before'].peak * 1.15,
  `+${(20 * Math.log10(onset('landing:transient', 'landing:before'))).toFixed(1)} dB ` +
  `(winRms ${by['landing:transient'].winRms.toFixed(4)} vs bed rms ${by['landing:before'].rms.toFixed(4)}), ` +
  `peak ${by['landing:transient'].peak.toFixed(3)} vs ${by['landing:before'].peak.toFixed(3)}`);
ck('hockey stop is a bright onset',
  onset('stop:transient', 'stop:before') >= 1.8 &&
  by['stop:transient'].centroidHz > by.cruise.centroidHz,
  `+${(20 * Math.log10(onset('stop:transient', 'stop:before'))).toFixed(1)} dB @ ${by['stop:transient'].centroidHz} Hz`);
ck('tail decays back to the floor (no runaway)',
  by.tail.rms < by.carve.rms * 0.12,
  `tail ${by.tail.rmsDb} dB vs carve ${by.carve.rmsDb} dB`);
// ---- wind, measured in isolation (snow bus muted) --------------------------
console.log('\nwind only (snow bus muted):');
console.log(pad('  km/h', 10) + pad('rms', 11) + pad('rms dB', 9) + pad('peak', 10) + 'centroid');
for (const w of result.wind) {
  console.log(pad('  ' + w.kmh, 10) + pad(w.rms.toFixed(5), 11) + pad(w.rmsDb.toFixed(1), 9) +
    pad(w.peak.toFixed(4), 10) + w.centroidHz + ' Hz');
}
console.log('');
const W = Object.fromEntries(result.wind.map((w) => [w.kmh, w]));
ck('wind is silent at rest (< -80 dB)', W[0].rmsDb < -80, `${W[0].rmsDb} dB`);
ck('wind level rises monotonically 30 -> 60 -> 75 -> 92 km/h',
  W[30].rms < W[60].rms && W[60].rms < W[75].rms && W[75].rms < W[92].rms,
  `${W[30].rmsDb} -> ${W[60].rmsDb} -> ${W[75].rmsDb} -> ${W[92].rmsDb} dB`);
ck('wind roars at 75 km/h (>= 18 dB over a 30 km/h cruise)',
  W[75].rmsDb - W[30].rmsDb >= 18, `+${(W[75].rmsDb - W[30].rmsDb).toFixed(1)} dB`);
ck('wind brightness rises with speed too (centroid 30 -> 92 at least doubles)',
  W[60].centroidHz > W[30].centroidHz && W[75].centroidHz > W[60].centroidHz &&
  W[92].centroidHz > W[75].centroidHz && W[92].centroidHz > W[30].centroidHz * 2,
  `${W[30].centroidHz} -> ${W[60].centroidHz} -> ${W[75].centroidHz} -> ${W[92].centroidHz} Hz`);

ck('stereo field is non-degenerate',
  result.segments.some((s) => s.width > 0.05), 'max width=' + Math.max(...result.segments.map((s) => s.width)).toFixed(3));

console.log('');
for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${pad(c.name, 52)} ${c.detail}`);
if (errors.length) { exitCode = 1; console.error('\n--- errors ---'); errors.forEach((e) => console.error('  ' + e)); }

const outPath = path.resolve(ROOT, JSONOUT);
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify({ ...result, checks }, null, 2));
console.log(`\n→ ${path.relative(ROOT, outPath)}`);
process.exit(exitCode);
