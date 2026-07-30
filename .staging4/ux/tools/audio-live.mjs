/**
 * Does the audio graph actually respond to the GAME, not just to a hand-written
 * state array?
 *
 *   node tools/audio-live.mjs [--seconds 45] [--json shots/audio/live.json]
 *
 * Step 1 records the real `state` at 120 Hz while the actual physics runs a
 * scripted line (build speed -> linked carves -> tuck -> pop -> land -> carves ->
 * hockey stop). Step 2 replays that recording, frame for frame, into
 * `createAudio({context: OfflineAudioContext})` and measures:
 *
 *   - how many of each transient the run fires (edge-set, pole, chatter,
 *     landing, hockey stop) — proof they trigger at all,
 *   - per-second RMS against per-second speed, and the correlation between them
 *     — proof the level actually tracks the state rather than idling,
 *   - peak / DC / non-finite over the whole render.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SECONDS = +arg('seconds', 45);
const SR = +arg('sr', 48000);
const JSONOUT = arg('json', 'shots/audio/live.json');

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 5233, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 600000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox',
    '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('console: ' + m.text()); });

let out = null, code = 0;
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));

  out = await page.evaluate(async (SECONDS, SR) => {
    const H = window.__harness;
    window.__setAuto?.(false);
    H.setPlayer(0, 700, Math.PI);

    const inputAt = (t) => {
      if (t < 8) return { steer: 0, crouch: 0, jump: false, brake: 0 };
      if (t < 20) return { steer: Math.sin((t - 8) * 1.1) * 0.5, crouch: 0, jump: false, brake: 0 };
      if (t < 29) return { steer: 0, crouch: 1, jump: false, brake: 0 };
      if (t < 33) return { steer: 0.05, crouch: t < 29.6 ? 1 : 0, jump: t > 29.9 && t < 30.05, brake: 0 };
      if (t < 39) return { steer: Math.sin((t - 33) * 1.1) * 0.55, crouch: 0, jump: false, brake: 0 };
      return { steer: 0.95, crouch: 0, jump: false, brake: 1 };
    };

    // ---- step 1: record the real state -------------------------------------
    const DT = 1 / 120;
    const n = Math.round(SECONDS / DT);
    const rec = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) {
      H.__scripted = inputAt(i * DT);
      H.step(DT, 1);
      const s = H.state, o = i * 8;
      rec[o] = s.speed; rec[o + 1] = s.edge; rec[o + 2] = s.carving ? 1 : 0;
      rec[o + 3] = s.airborne ? 1 : 0; rec[o + 4] = s.vel.y; rec[o + 5] = s.input.brake;
      rec[o + 6] = s.crouch; rec[o + 7] = s.gForce;
    }

    // ---- step 2: replay it into the audio graph ----------------------------
    const { createAudio } = await import('/src/audio/audio.js');
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(SECONDS * SR), sampleRate: SR });
    const events = {};
    const audio = createAudio({
      context: ctx,
      onEvent: (kind, a) => {
        const e = (events[kind] ??= { n: 0, min: 9, max: -9, sum: 0 });
        e.n++; e.sum += a; if (a < e.min) e.min = a; if (a > e.max) e.max = a;
      },
    });

    const state = {
      pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
      speed: 0, heading: 0, pitch: 0, roll: 0, edge: 0,
      carving: false, airborne: false, crouch: 0, gForce: 0,
      airTime: 0, distance: 0, time: 0,
      input: { steer: 0, crouch: 0, jump: false, brake: 0 },
    };
    for (let i = 0; i < n; i++) {
      const t = i * DT;
      if (t >= SECONDS - DT) break;
      ctx.suspend(t).then(() => {
        const o = i * 8;
        state.speed = rec[o]; state.edge = rec[o + 1];
        state.carving = rec[o + 2] > 0.5; state.airborne = rec[o + 3] > 0.5;
        state.vel.y = rec[o + 4]; state.input.brake = rec[o + 5];
        state.crouch = rec[o + 6]; state.gForce = rec[o + 7];
        state.time = t;
        audio.update(DT, state);
        ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1);

    // ---- measure ------------------------------------------------------------
    const secs = Math.floor(SECONDS);
    const perSec = [];
    for (let k = 0; k < secs; k++) {
      let sq = 0, pk = 0;
      const a = k * SR, b = Math.min((k + 1) * SR, L.length);
      for (let i = a; i < b; i++) {
        const m = (L[i] + R[i]) * 0.5;
        sq += m * m;
        const ap = Math.max(Math.abs(L[i]), Math.abs(R[i]));
        if (ap > pk) pk = ap;
      }
      const rms = Math.sqrt(sq / (b - a));
      // mean speed over the same second
      let sp = 0, c = 0;
      for (let i = Math.floor(k / DT); i < Math.floor((k + 1) / DT) && i < n; i++) { sp += rec[i * 8]; c++; }
      perSec.push({ t: k, kmh: +((sp / Math.max(c, 1)) * 3.6).toFixed(1), rms: +rms.toFixed(5), peak: +pk.toFixed(4) });
    }
    // Pearson correlation between km/h and rms in dB
    const xs = perSec.map((p) => p.kmh);
    const ys = perSec.map((p) => 20 * Math.log10(Math.max(p.rms, 1e-9)));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    const corr = sxy / Math.sqrt(sxx * syy);

    let gPeak = 0, gSum = 0, gSq = 0, bad = 0;
    for (let i = 0; i < L.length; i++) {
      const ap = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (ap > gPeak) gPeak = ap;
      if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) bad++;
      const m = (L[i] + R[i]) * 0.5; gSum += m; gSq += m * m;
    }

    for (const k of Object.keys(events)) {
      events[k].mean = +(events[k].sum / events[k].n).toFixed(3);
      events[k].min = +events[k].min.toFixed(3);
      events[k].max = +events[k].max.toFixed(3);
      delete events[k].sum;
    }
    return {
      seconds: SECONDS, events, perSec,
      speedKmh: { max: +(Math.max(...xs)).toFixed(1), mean: +mx.toFixed(1) },
      corrSpeedLevel: +corr.toFixed(3),
      globalPeak: +gPeak.toFixed(5), globalRms: +Math.sqrt(gSq / L.length).toFixed(5),
      globalDc: +(gSum / L.length).toFixed(7), nonFinite: bad,
    };
  }, SECONDS, SR);
} catch (e) {
  errors.push('live: ' + (e?.message ?? String(e)));
  code = 1;
} finally {
  await browser.close();
  await server.close();
}

if (out) {
  console.log(`\nlive run: ${out.seconds}s, mean ${out.speedKmh.mean} km/h, peak ${out.speedKmh.max} km/h`);
  console.log(`peak=${out.globalPeak}  rms=${out.globalRms}  dc=${out.globalDc}  nonFinite=${out.nonFinite}`);
  console.log('\ntransients fired by the real physics:');
  for (const [k, v] of Object.entries(out.events)) {
    console.log(`  ${k.padEnd(9)} n=${String(v.n).padStart(4)}  amount ${v.min}..${v.max} (mean ${v.mean})`);
  }
  console.log(`\nspeed -> level correlation (km/h vs dB, per second): r=${out.corrSpeedLevel}`);
  const spark = out.perSec.map((p) => '▁▂▃▄▅▆▇█'[Math.max(0, Math.min(7,
    Math.round((20 * Math.log10(Math.max(p.rms, 1e-9)) + 60) / 6)))]).join('');
  console.log('level  ' + spark);
  console.log('speed  ' + out.perSec.map((p) => '▁▂▃▄▅▆▇█'[Math.max(0, Math.min(7, Math.round(p.kmh / 13)))]).join(''));

  const ck = (name, ok, detail) => { console.log(`${ok ? '✓' : '✗'} ${name.padEnd(52)} ${detail}`); if (!ok) code = 1; };
  ck('landings fire', (out.events.land?.n ?? 0) > 0, `n=${out.events.land?.n ?? 0}`);
  ck('edge-sets fire', (out.events.edge?.n ?? 0) > 0, `n=${out.events.edge?.n ?? 0}`);
  ck('ski chatter fires on terrain hops', (out.events.chatter?.n ?? 0) > 0, `n=${out.events.chatter?.n ?? 0}`);
  ck('hockey stop fires', (out.events.stop?.n ?? 0) > 0, `n=${out.events.stop?.n ?? 0}`);
  ck('chatter outnumbers full landings (no drum solo)',
    (out.events.chatter?.n ?? 0) >= (out.events.land?.n ?? 0) * 0.8,
    `${out.events.chatter?.n ?? 0} chatter vs ${out.events.land?.n ?? 0} landings`);
  ck('level tracks speed (r > 0.8)', out.corrSpeedLevel > 0.8, `r=${out.corrSpeedLevel}`);
  ck('no clipping', out.globalPeak < 0.95, `peak=${out.globalPeak}`);
  ck('all samples finite', out.nonFinite === 0, `nonFinite=${out.nonFinite}`);

  const p = path.resolve(ROOT, JSONOUT);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(out, null, 2));
  console.log(`\n→ ${path.relative(ROOT, p)}`);
}
if (errors.length) { code = 1; console.error(errors.join('\n')); }
process.exit(code);
