/**
 * Alpine — procedural audio.
 *
 * Everything is synthesised: no files, no decoded assets. The graph is
 *
 *   snow noise ─┬─ carve  (resonant BP, tracks speed·edge)  ─┐
 *               ├─ skid   (broad gritty BP + shaper)         ├─ snowBus ─ pan ─┐
 *               ├─ powder (LP whoosh)                        │                 │
 *               └─ rumble (sub LP, ski chatter)              ┘                 │
 *   wind noise ─┬─ low BP (body)                                               ├─ dry ─┐
 *               └─ high BP (moving cutoff, buffeting)  ─ windBus ───────────────┘       │
 *   transients (edge-set chirp, pole plant, landing thud, hockey stop) ─────────────────┤
 *                                                                                       │
 *                        ┌──────── convolver (generated alpine-bowl IR) ── return ──────┤
 *                        └── sends ◄──────────────────────────────────────────────      │
 *                                                            preMaster ─ comp ─ tanh ─ out
 *
 * All AudioParams are driven from `update(dt, state)`; nothing is on a timer.
 * Verify analytically with `node tools/audio-probe.mjs`.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (cur, tgt, dt, tau) => cur + (tgt - cur) * (1 - Math.exp(-dt / (tau > 1e-4 ? tau : 1e-4)));

// ---------------------------------------------------------------- tuning ----
const TOP_SPEED = 33;      // m/s that maps to "full" intensity (~119 km/h)
const MASTER = 0.85;

// ------------------------------------------------------------ noise banks ---
/**
 * Every generated buffer is DC-blocked before use: these buffers loop, so any
 * residual mean becomes a constant offset in the mix (pink noise in particular
 * carries a lot of sub-Hz energy).
 */
function removeDC(d) {
  let m = 0;
  for (let i = 0; i < d.length; i++) m += d[i];
  m /= d.length;
  for (let i = 0; i < d.length; i++) d[i] -= m;
}

function fillWhite(d, gain = 1) {
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * gain;
  removeDC(d);
}

/** Pink-ish noise (Paul Kellet economy filter) — the natural spectrum for wind. */
function fillPink(d, gain = 1) {
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22 * gain;
  }
  removeDC(d);
}

/** Band-limited very low frequency noise, used as a granular amplitude modulator. */
function fillLFNoise(d, sr, cutoff, gain = 1) {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
  let y1 = 0, y2 = 0, peak = 1e-6;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    y1 += a * (w - y1);
    y2 += a * (y1 - y2);
    d[i] = y2;
    const m = Math.abs(y2);
    if (m > peak) peak = m;
  }
  const k = gain / peak;
  for (let i = 0; i < d.length; i++) d[i] *= k;
  removeDC(d);
}

function makeBuffer(ctx, seconds, channels, fill) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let c = 0; c < channels; c++) fill(buf.getChannelData(c), c);
  return buf;
}

/**
 * Impulse response for a wide open alpine bowl: a short diffuse tail with
 * progressive HF damping (snow absorbs treble), a handful of early reflections
 * off the bowl walls, and two sparse, dark, distant valley slaps.
 */
function makeAlpineIR(ctx, seconds = 3.1) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const decay = 1.85 + ch * 0.07;         // slight L/R decorrelation
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // one-pole LP whose cutoff collapses over time -> snowy, dark tail
      const a = 0.62 * Math.exp(-t * 0.65) + 0.05;
      lp += a * ((Math.random() * 2 - 1) - lp);
      const attack = t < 0.014 ? t / 0.014 : 1;
      d[i] = lp * Math.exp(-t * decay) * attack * 0.6;
    }
    // early reflections + distant valley returns (short dark noise bursts)
    const taps = [
      [0.019 + ch * 0.0013, 0.42, 0.006],
      [0.034 + ch * 0.0021, -0.33, 0.008],
      [0.057 + ch * 0.0009, 0.27, 0.010],
      [0.091 + ch * 0.0031, 0.21, 0.014],
      [0.137 + ch * 0.0017, -0.16, 0.018],
      [0.352 + ch * 0.0140, 0.13, 0.055],   // valley wall
      [0.641 + ch * 0.0190, 0.075, 0.080],  // far ridge
      [1.010 + ch * 0.0230, 0.038, 0.110],
    ];
    for (const [tt, amp, w] of taps) {
      const start = Math.floor(tt * sr);
      const n = Math.floor(w * sr);
      let s = 0;
      for (let i = 0; i < n && start + i < len; i++) {
        s += 0.35 * ((Math.random() * 2 - 1) - s);           // dark burst
        const env = Math.sin((Math.PI * i) / n);
        d[start + i] += s * amp * env;
      }
    }
  }
  return buf;
}

/**
 * Soft saturator. A WaveShaper maps input −1..1 across the whole curve and
 * clamps beyond that, so the curve domain must be −1..1: unity slope at the
 * origin, hard ceiling of tanh(drive)/drive*... at full scale. With drive 1 the
 * output can never exceed 0.762, which is the graph's analytic no-clip proof.
 */
function makeTanhCurve(n = 4096, drive = 1.0) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / drive;
  }
  return c;
}

/** Mild asymmetric grit for the skid voice. */
function makeGritCurve(n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 2.4) * 0.7 + x * 0.3;
  }
  return c;
}

// ================================================================= factory ===
/**
 * @param {{context?: BaseAudioContext, autostart?: boolean, volume?: number}} [opts]
 *   `context` lets the offline probe render the exact same graph.
 */
export function createAudio(opts = {}) {
  let ctx = opts.context ?? null;
  let running = false;
  let built = false;
  let N = null;              // node bag

  // --- smoothed / tracked scalars (kept alive even before start) ------------
  const s = {
    speed: 0, edge: 0, absEdge: 0, carve: 0, brake: 0, air: 0, crouch: 0,
    gCarve: 0, gSkid: 0, gPowder: 0, gRumble: 0, gWind: 0, gWindHi: 0,
    pan: 0, carveFreq: 1800, skidFreq: 1100, powderFreq: 500, windFreq: 900,
    grain: 0, buffet: 0, sendAmt: 0.12,
  };
  let lastEdgeSign = 0;
  let sinceChirp = 10, sinceStop = 10, sincePole = 10;
  let wasAir = false, airVy = 0, airDur = 0;
  let prevSpeed = 0;

  // ------------------------------------------------------------- build -----
  function build() {
    if (built) return;
    built = true;
    const sr = ctx.sampleRate;

    // ---- master chain: sum -> compressor -> soft clip -> out
    const out = ctx.createGain();
    out.gain.value = opts.volume ?? MASTER;

    const shaper = ctx.createWaveShaper();
    // drive 1.4 -> curve ceiling 0.632; with MASTER 0.85 the pre-overshoot
    // ceiling is 0.537, leaving room for the 2x-oversampler's ringing.
    shaper.curve = makeTanhCurve(4096, 1.4);
    shaper.oversample = '2x';

    // Gentle bus glue + a hard ceiling from the tanh stage above; the bed sits
    // well below threshold so transients keep their crest factor.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;

    // DC blocker: the bed loops forever, any offset would bias the limiter.
    const dcBlock = ctx.createBiquadFilter();
    dcBlock.type = 'highpass'; dcBlock.frequency.value = 24; dcBlock.Q.value = 0.6;

    const preMaster = ctx.createGain();
    preMaster.gain.value = 2.6;      // drive into the glue comp / tanh ceiling
    preMaster.connect(dcBlock);
    dcBlock.connect(comp);
    comp.connect(shaper);
    shaper.connect(out);
    out.connect(ctx.destination);

    // ---- reverb (generated alpine bowl IR)
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = makeAlpineIR(ctx, 3.1);
    const revIn = ctx.createGain();
    revIn.gain.value = 1;
    const revHP = ctx.createBiquadFilter();
    revHP.type = 'highpass'; revHP.frequency.value = 220;   // keep the low end dry
    const revOut = ctx.createGain();
    revOut.gain.value = 0.55;
    revIn.connect(revHP); revHP.connect(conv); conv.connect(revOut); revOut.connect(preMaster);

    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(preMaster);

    // Bed duck: transients connect straight to `dry`, the continuous beds go
    // through this, so an impact briefly clears room for itself.
    const bedDuck = ctx.createGain();
    bedDuck.gain.value = 1;
    bedDuck.connect(dry);

    // ---- shared noise banks
    const white = makeBuffer(ctx, 4.0, 2, (d) => fillWhite(d));
    const pink = makeBuffer(ctx, 4.0, 2, (d) => fillPink(d));
    const shortN = makeBuffer(ctx, 1.5, 2, (d) => fillWhite(d));
    const grainBuf = makeBuffer(ctx, 6.0, 1, (d) => fillLFNoise(d, sr, 26, 1.0));
    const buffetBuf = makeBuffer(ctx, 7.0, 1, (d) => fillLFNoise(d, sr, 7, 1.0));

    // Two beds: white for the bright carve shear, pink for the darker
    // skid / powder / chatter voices. Keeps the voices spectrally distinct.
    const snowSrc = ctx.createBufferSource();
    snowSrc.buffer = white; snowSrc.loop = true;
    const snowDark = ctx.createBufferSource();
    snowDark.buffer = pink; snowDark.loop = true; snowDark.playbackRate.value = 1.13;
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = pink; windSrc.loop = true; windSrc.playbackRate.value = 0.87;
    const grainSrc = ctx.createBufferSource();
    grainSrc.buffer = grainBuf; grainSrc.loop = true;
    const buffetSrc = ctx.createBufferSource();
    buffetSrc.buffer = buffetBuf; buffetSrc.loop = true;

    // ---- snow bus
    const snowBus = ctx.createGain();
    snowBus.gain.value = 1;
    const pan = ctx.createStereoPanner();
    snowBus.connect(pan); pan.connect(bedDuck);
    const snowSend = ctx.createGain();
    snowSend.gain.value = 0.1;
    snowBus.connect(snowSend); snowSend.connect(revIn);

    // voice helper: chain of filters -> gain -> snowBus, with granular AM
    function voice(filters, grainDepth, src = snowSrc) {
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      let node = src;
      for (const f of filters) { node.connect(f); node = f; }
      node.connect(g);
      g.connect(snowBus);
      let depth = null;
      if (grainDepth > 0) {
        depth = ctx.createGain();
        depth.gain.value = 0;
        grainSrc.connect(depth);
        depth.connect(g.gain);      // audio-rate AM -> granular texture
      }
      return { gain: g, depth, grainDepth };
    }

    const bq = (type, freq, q, gain) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      if (gain !== undefined) f.gain.value = gain;
      return f;
    };

    // the dark bed gets its own sub-sonic trim before it fans out to the voices
    const darkHP = ctx.createBiquadFilter();
    darkHP.type = 'highpass'; darkHP.frequency.value = 34; darkHP.Q.value = 0.6;
    snowDark.connect(darkHP);

    // carve: firm-snow shear — resonant, bright, pitched
    const carveHP = bq('highpass', 700, 0.7);
    const carveBP = bq('bandpass', 2000, 2.6);
    const carveRes = bq('peaking', 3600, 7.0, 9);
    const carve = voice([carveHP, carveBP, carveRes], 0.35);

    // skid: broader, grittier, lower centroid (pink bed)
    const skidBP = bq('bandpass', 1100, 0.62);
    const skidGrit = ctx.createWaveShaper();
    skidGrit.curve = makeGritCurve(); skidGrit.oversample = '2x';
    const skidLS = bq('lowshelf', 320, 0.7, 5);
    const skidLP = bq('lowpass', 4200, 0.6);
    const skid = voice([skidBP, skidGrit, skidLS, skidLP], 0.62, darkHP);

    // powder: soft muffled whoosh — two cascaded poles so it is genuinely dark
    const powLP = bq('lowpass', 520, 0.9);
    const powLP2 = bq('lowpass', 900, 0.5);
    const powHP = bq('highpass', 90, 0.6);
    const powder = voice([powLP, powLP2, powHP], 0.8, darkHP);

    // rumble: ski chatter / board contact body
    const rumLP = bq('lowpass', 110, 1.4);
    const rumble = voice([rumLP], 0.5, darkHP);

    // ---- wind bus
    const windBus = ctx.createGain();
    windBus.gain.value = 0.0001;
    windBus.connect(bedDuck);
    const windSend = ctx.createGain();
    windSend.gain.value = 0.05;
    windBus.connect(windSend); windSend.connect(revIn);

    const windLo = bq('bandpass', 150, 0.55);
    const windLoG = ctx.createGain(); windLoG.gain.value = 0.85;
    const windHi = bq('bandpass', 900, 1.15);
    const windHiG = ctx.createGain(); windHiG.gain.value = 0.55;
    const windHP = bq('highpass', 60, 0.7);
    windSrc.connect(windHP);
    windHP.connect(windLo); windLo.connect(windLoG); windLoG.connect(windBus);
    windHP.connect(windHi); windHi.connect(windHiG); windHiG.connect(windBus);

    // slow drifting cutoff so wind is never static
    const lfoA = ctx.createOscillator(); lfoA.frequency.value = 0.17;
    const lfoAg = ctx.createGain(); lfoAg.gain.value = 240;
    const lfoB = ctx.createOscillator(); lfoB.frequency.value = 0.43; lfoB.type = 'triangle';
    const lfoBg = ctx.createGain(); lfoBg.gain.value = 95;
    lfoA.connect(lfoAg); lfoAg.connect(windHi.frequency);
    lfoB.connect(lfoBg); lfoBg.connect(windHi.frequency);

    // airborne buffeting: LF-noise AM on the wind bus
    const buffetDepth = ctx.createGain(); buffetDepth.gain.value = 0;
    buffetSrc.connect(buffetDepth); buffetDepth.connect(windBus.gain);

    const t0 = ctx.currentTime;
    snowSrc.start(t0); snowDark.start(t0); windSrc.start(t0);
    grainSrc.start(t0); buffetSrc.start(t0);
    lfoA.start(t0); lfoB.start(t0);

    N = {
      out, comp, shaper, preMaster, dry, bedDuck, revIn, revOut, conv,
      snowBus, pan, snowSend, carve, skid, powder, rumble,
      carveBP, carveRes, carveHP, skidBP, powLP, powLP2, rumLP,
      windBus, windLo, windHi, windLoG, windHiG, buffetDepth, windSend,
      shortN, sources: [snowSrc, snowDark, windSrc, grainSrc, buffetSrc, lfoA, lfoB],
    };
  }

  // ------------------------------------------------------- one-shot voices --
  function burst(t, o) {
    const src = ctx.createBufferSource();
    src.buffer = N.shortN;
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'bandpass';
    f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(Math.max(30, o.f0), t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(30, o.f1), t + o.dur * (o.sweep ?? 1));
    const g = ctx.createGain();
    const atk = o.atk ?? 0.006;
    const peak = Math.max(1e-4, o.gain);
    g.gain.setValueAtTime(1e-4, t);
    g.gain.exponentialRampToValueAtTime(peak, t + atk);
    if (o.hold) g.gain.setValueAtTime(peak, t + atk + o.hold);
    g.gain.exponentialRampToValueAtTime(1e-4, t + o.dur);
    src.connect(f); f.connect(g);
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(o.pan ?? 0, -1, 1);
    g.connect(p); p.connect(N.dry);
    let sg = null;
    if (o.send) {
      sg = ctx.createGain(); sg.gain.value = o.send;
      p.connect(sg); sg.connect(N.revIn);
    }
    src.start(t, Math.random() * 1.0);
    src.stop(t + o.dur + 0.06);
    // explicit teardown: a run can fire thousands of these
    src.onended = () => {
      try { src.disconnect(); f.disconnect(); g.disconnect(); p.disconnect(); sg?.disconnect(); } catch { /* ignore */ }
    };
  }

  function tone(t, o) {
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1 ?? o.f0), t + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1e-4, t);
    g.gain.exponentialRampToValueAtTime(Math.max(1e-4, o.gain), t + (o.atk ?? 0.004));
    g.gain.exponentialRampToValueAtTime(1e-4, t + o.dur);
    osc.connect(g); g.connect(N.dry);
    let sg = null;
    if (o.send) { sg = ctx.createGain(); sg.gain.value = o.send; g.connect(sg); sg.connect(N.revIn); }
    osc.start(t); osc.stop(t + o.dur + 0.05);
    osc.onended = () => {
      try { osc.disconnect(); g.disconnect(); sg?.disconnect(); } catch { /* ignore */ }
    };
  }

  /**
   * Edge-set: the ski biting — a short upward-sweeping resonant chirp.
   * `lvl` ties the transient to the current bed level so a gentle turn at
   * walking pace does not fire the same bang as a 100 km/h carve.
   */
  function edgeSet(t, intensity, panPos, lvl) {
    const a = clamp(intensity, 0, 1);
    const k = 0.18 + 0.82 * clamp(lvl, 0, 1.1);
    burst(t, {
      // Q stays under ~7: past that the bandpass rings into a whistle and the
      // random noise excursions produce wild peaks.
      f0: 700 + 500 * a, f1: 2200 + 2600 * a, q: 4.0 + 3.0 * a,
      dur: 0.16 + 0.06 * a, atk: 0.008, gain: (0.055 + 0.2 * a) * k,
      pan: panPos * 0.5, send: 0.16,
    });
    burst(t + 0.004, {
      type: 'highpass', f0: 3200, q: 0.7,
      dur: 0.075, atk: 0.003, gain: (0.03 + 0.09 * a) * k, pan: panPos * 0.5,
    });
  }

  /** Pole plant: a tiny dry tick with a snowy tail. */
  function polePlant(t, a, panPos, lvl) {
    const k = (0.25 + 0.75 * clamp(lvl, 0, 1.1)) * a;
    burst(t, { f0: 1500, f1: 900, q: 3.0, dur: 0.05, atk: 0.002, gain: 0.05 * k, pan: panPos });
    burst(t + 0.006, { type: 'highpass', f0: 4200, q: 0.7, dur: 0.12, atk: 0.004, gain: 0.028 * k, pan: panPos, send: 0.25 });
  }

  /** Landing: sub thud + compression whump + snow splash, scaled by impact. */
  function landing(t, impact) {
    const a = clamp(impact, 0, 1);
    // clear room for the impact, then let the bed swell back in
    const dk = N.bedDuck.gain;
    dk.cancelScheduledValues(t);
    dk.setValueAtTime(1, t);
    dk.linearRampToValueAtTime(1 - 0.55 * a, t + 0.022);
    dk.linearRampToValueAtTime(1 - 0.18 * a, t + 0.16);
    dk.linearRampToValueAtTime(1, t + 0.45);
    tone(t, { f0: 96 + 40 * a, f1: 34, dur: 0.20 + 0.14 * a, atk: 0.005, gain: 0.30 + 0.42 * a, send: 0.10 });
    burst(t + 0.002, { type: 'lowpass', f0: 900 + 900 * a, f1: 190, q: 1.1, dur: 0.24 + 0.18 * a, atk: 0.006, gain: 0.22 + 0.30 * a, send: 0.14 });
    burst(t + 0.012, { f0: 1600 + 1400 * a, f1: 420, q: 0.8, dur: 0.34 + 0.3 * a, atk: 0.012, gain: 0.09 + 0.20 * a, send: 0.30 });
    if (a > 0.55) tone(t + 0.03, { type: 'triangle', f0: 190, f1: 62, dur: 0.16, gain: 0.10 * a });
  }

  /** Hockey stop: a hard, bright scrape that blooms then dies. */
  function hockeyStop(t, intensity, panPos) {
    const a = clamp(intensity, 0, 1);
    burst(t, {
      f0: 1400, f1: 3400 + 1800 * a, q: 1.6, sweep: 0.35,
      dur: 0.55 + 0.35 * a, atk: 0.03, hold: 0.10 + 0.12 * a,
      gain: 0.20 + 0.28 * a, pan: panPos * 0.4, send: 0.26,
    });
    burst(t + 0.01, {
      type: 'lowpass', f0: 700, f1: 240, q: 0.9,
      dur: 0.4 + 0.2 * a, atk: 0.02, gain: 0.12 + 0.18 * a, pan: panPos * 0.4,
    });
    tone(t, { f0: 150, f1: 55, dur: 0.22, gain: 0.14 * a });
  }

  // ------------------------------------------------------------- update ----
  function update(dt, state) {
    if (!state) return;
    const d = clamp(dt || 0, 0, 0.1);

    const speed = state.speed ?? 0;
    const edge = clamp(state.edge ?? 0, -1, 1);
    const absEdge = Math.abs(edge);
    const airborne = state.airborne ? 1 : 0;
    const brake = clamp(state.input?.brake ?? 0, 0, 1);
    const carving = state.carving ? 1 : 0;
    const vy = state.vel?.y ?? 0;

    sinceChirp += d; sinceStop += d; sincePole += d;

    // ---- event detection (runs even before the context exists) ------------
    const events = [];
    const sign = absEdge > 0.24 ? Math.sign(edge) : 0;
    if (sign !== 0 && sign !== lastEdgeSign && sinceChirp > 0.16 && speed > 3.5) {
      const inten = clamp(absEdge * 0.6 + (speed / TOP_SPEED) * 0.7, 0, 1);
      events.push(['edge', inten, edge]);
      sinceChirp = 0;
      if (speed > 4 && speed < 24 && sincePole > 0.5 && Math.random() < 0.55) {
        events.push(['pole', clamp(0.4 + speed / 30, 0, 1), edge]);
        sincePole = 0;
      }
    }
    if (sign !== 0) lastEdgeSign = sign;

    if (airborne) { airDur += d; airVy = Math.min(airVy, vy); }
    if (wasAir && !airborne) {
      const impact = clamp((-airVy) / 17 + airDur * 0.25, 0.08, 1);
      events.push(['land', impact, 0]);
      airDur = 0; airVy = 0;
    }
    if (!wasAir && airborne) { airVy = 0; }
    wasAir = !!airborne;

    const decel = (prevSpeed - speed) / Math.max(d, 1e-3);
    if (!airborne && brake > 0.5 && speed > 6 && decel > 6 && sinceStop > 0.85) {
      events.push(['stop', clamp(decel / 26 + brake * 0.4, 0, 1), edge]);
      sinceStop = 0;
    }
    prevSpeed = speed;

    // ---- continuous targets ----------------------------------------------
    const sp = clamp(speed / TOP_SPEED, 0, 1.25);
    const spCurve = Math.pow(sp, 0.75);
    const ground = 1 - airborne;

    s.carve = smooth(s.carve, carving * (0.3 + 0.7 * absEdge), d, 0.09);
    s.brake = smooth(s.brake, brake, d, 0.06);
    s.air = smooth(s.air, airborne, d, 0.05);
    s.absEdge = smooth(s.absEdge, absEdge, d, 0.08);
    s.speed = smooth(s.speed, speed, d, 0.12);

    const g = 1 - s.air;                 // grounded blend, smoothed
    const firm = s.carve;                // carving on firm snow
    const skidAmt = clamp((1 - firm) * (0.35 + 0.65 * s.absEdge) + s.brake * 0.9, 0, 1.3);
    const powAmt = clamp(0.55 - 0.4 * s.absEdge - 0.25 * s.brake, 0, 1);

    // Bed levels are deliberately conservative: the transients need headroom
    // above them or the limiter eats every landing.
    const tCarve = g * firm * spCurve * 0.24 * (0.35 + 0.65 * sp);
    const tSkid = g * skidAmt * spCurve * 0.19;
    const tPowder = g * powAmt * Math.pow(sp, 0.6) * 0.21;
    const tRumble = g * spCurve * 0.20 * (0.5 + 0.5 * s.absEdge);

    s.gCarve = smooth(s.gCarve, tCarve, d, 0.07);
    s.gSkid = smooth(s.gSkid, tSkid, d, 0.07);
    s.gPowder = smooth(s.gPowder, tPowder, d, 0.11);
    s.gRumble = smooth(s.gRumble, tRumble, d, 0.09);

    // spectral targets: everything gets brighter and tighter with speed & edge
    s.carveFreq = smooth(s.carveFreq, 1500 + 3300 * sp + 1500 * absEdge * sp, d, 0.10);
    s.skidFreq = smooth(s.skidFreq, 780 + 1500 * sp + 400 * s.brake, d, 0.10);
    s.powderFreq = smooth(s.powderFreq, 340 + 780 * sp, d, 0.16);
    // The chase cam sits behind the skier, so the skier's edge axis is the
    // camera's screen-x axis: a left-foot carve pans to screen left.
    s.pan = smooth(s.pan, -edge * 0.32, d, 0.12);
    s.grain = smooth(s.grain, 0.55 * (1 - firm * 0.5) + 0.25 * s.brake, d, 0.15);

    // wind: near silence at rest, roaring flat out; buffeting in the air
    const tWind = Math.pow(sp, 1.7) * 0.21 * (1 + 0.3 * s.air);
    s.gWind = smooth(s.gWind, tWind, d, 0.13);
    s.windFreq = smooth(s.windFreq, 620 + 2100 * Math.pow(sp, 1.15), d, 0.18);
    s.buffet = smooth(s.buffet, s.air * tWind * 0.85, d, 0.10);
    s.sendAmt = smooth(s.sendAmt, 0.07 + 0.16 * sp, d, 0.3);

    if (!N || !running) return;

    // ---- write params ------------------------------------------------------
    const t = ctx.currentTime;
    const tau = 0.03;
    const set = (p, v) => p.setTargetAtTime(v, t, tau);

    const vC = Math.max(1e-4, s.gCarve);
    const vS = Math.max(1e-4, s.gSkid);
    const vP = Math.max(1e-4, s.gPowder);
    const vR = Math.max(1e-4, s.gRumble);
    set(N.carve.gain.gain, vC);
    set(N.skid.gain.gain, vS);
    set(N.powder.gain.gain, vP);
    set(N.rumble.gain.gain, vR);
    if (N.carve.depth) set(N.carve.depth.gain, vC * s.grain * N.carve.grainDepth);
    if (N.skid.depth) set(N.skid.depth.gain, vS * s.grain * N.skid.grainDepth);
    if (N.powder.depth) set(N.powder.depth.gain, vP * s.grain * N.powder.grainDepth);
    if (N.rumble.depth) set(N.rumble.depth.gain, vR * s.grain * N.rumble.grainDepth);

    set(N.carveBP.frequency, clamp(s.carveFreq, 300, 9000));
    set(N.carveRes.frequency, clamp(s.carveFreq * 1.7, 400, 14000));
    N.carveRes.Q.setTargetAtTime(3 + 7 * clamp(s.absEdge, 0, 1), t, 0.08);
    set(N.skidBP.frequency, clamp(s.skidFreq, 200, 6000));
    set(N.powLP.frequency, clamp(s.powderFreq, 120, 3000));
    set(N.powLP2.frequency, clamp(s.powderFreq * 1.6, 160, 4000));
    set(N.rumLP.frequency, 70 + 90 * sp);
    set(N.pan.pan, clamp(s.pan, -1, 1));
    set(N.snowSend.gain, s.sendAmt);

    set(N.windBus.gain, Math.max(1e-4, s.gWind));
    set(N.windHi.frequency, clamp(s.windFreq, 120, 9000));
    N.windHi.Q.setTargetAtTime(0.8 + 1.6 * s.air, t, 0.1);
    set(N.windLoG.gain, 0.55 + 0.55 * s.air);
    set(N.buffetDepth.gain, s.buffet);

    // ---- fire transients ---------------------------------------------------
    const at = t + 0.012;
    for (const [kind, a, e] of events) {
      if (kind === 'edge') edgeSet(at, a, e, sp);
      else if (kind === 'pole') polePlant(at + 0.05, a, -e * 0.6, sp);
      else if (kind === 'land') landing(at, a);
      else if (kind === 'stop') hockeyStop(at, a, e);
    }
  }

  // -------------------------------------------------------------- start ----
  function start() {
    if (running) return;
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch { return; }
    }
    try { build(); } catch (e) { return; }
    running = true;
    if (ctx.resume) { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }
  }

  if (opts.context) { build(); running = opts.autostart !== false; }

  const api = {
    start,
    update,
    get context() { return ctx; },
    get nodes() { return N; },
    setVolume(v) { if (N) N.out.gain.value = clamp(v, 0, 1.5); },
    stop() {
      running = false;
      if (N) N.out.gain.value = 0;
    },
  };
  if (typeof window !== 'undefined') window.__alpineAudio = api;
  return api;
}
