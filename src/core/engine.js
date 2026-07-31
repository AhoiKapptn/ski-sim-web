import * as THREE from 'three';

/**
 * Renderer + scene + camera bootstrap.
 * Owns nothing game-specific; subsystems attach to `scene`.
 *
 * ---------------------------------------------------------------------------
 * WHY `antialias: false`
 * ---------------------------------------------------------------------------
 * The scene is never drawn to the default framebuffer. `postfx.render()` draws
 * it into `sceneRT` (a HalfFloat render target) and the only thing that ever
 * touches the drawing buffer is the final fullscreen film-pass quad — two
 * triangles with no interior edges, which MSAA cannot improve. With
 * `antialias: true` the browser still allocates a multisampled default
 * framebuffer and resolves it on every present: at DPR 2 (3200x1800) that is a
 * 4x-sampled RGBA8 resolve of 5.76 Mpx per frame, bought for nothing. Spatial
 * AA is done inside the post chain (TAA, and SMAA when TAA is off — see
 * `postfx.js`, `smaaPass.enabled = PARAMS.smaa.enabled || !PARAMS.taa.enabled`).
 *
 * The one path that *would* lose from this is `postfx.js:1280`, which falls back
 * to `renderer.render(scene, camera)` straight to the default framebuffer when
 * `postfx.enabled === false`. Nothing in `src/` or `tools/` sets that flag; it
 * exists as a debug ablation ("render with every post pass off"). `main.js`
 * detects that fallback and warns once, so the loss can never be silent, and
 * `?aa=1` brings the multisampled backbuffer back for anyone who needs it.
 *
 * ---------------------------------------------------------------------------
 * RESOLUTION SCALE
 * ---------------------------------------------------------------------------
 * `setPixelRatio(min(devicePixelRatio, maxPixelRatio) * resolutionScale)`.
 * Every post-processing render target is sized from
 * `renderer.getDrawingBufferSize()` (postfx.js:1039) or from
 * `renderer.getPixelRatio()` (`postfx.setSize`), so this one number scales the
 * whole fragment cost of the frame — on a Retina display the default is DPR 2,
 * i.e. 5.76 Mpx, 4x the 1.44 Mpx that headless Chrome measures at DPR 1.
 * `resolutionScale = 0.75` renders 2400x1350 and lets the film pass' sharpen
 * (postfx.js:1183) carry the perceived resolution.
 *
 * ---------------------------------------------------------------------------
 * ADAPTIVE RESOLUTION — why this exists, and the measurements behind it
 * ---------------------------------------------------------------------------
 * MEASURED, at the resolution the game is actually played at. Headless Chrome
 * reports DPR 1, so every reading in this project's history was of a 1600x900 =
 * 1.44 Mpx backbuffer; a Retina Mac renders 3200x1800 = 5.76 Mpx. Driving the
 * canonical linked-carve path (tools/frametime.mjs) the presented frame interval
 * is:
 *
 *     DPR 1 (1.44 Mpx):  p50 16.70  p95 17.50  p99 17.90  over20   3/839 frames
 *     DPR 2 (5.76 Mpx):  p50 34.00  p95 40.20  p99 42.80  over20 404/405 frames
 *
 * i.e. at DPR 2 EVERY frame misses 20 ms and 65% of them miss 33 ms. That is the
 * whole of the reported "lagging". It is not the CPU: `update()` costs 0.4 ms
 * p50 and submitting the frame costs 1.1 ms, so ~96% of a 34 ms frame is GPU
 * fragment work. Interleaved ABBA ablation at DPR 2 (tools/gpu-breakdown.mjs)
 * puts it in the scene render — the terrain snow shader alone is 15.7 ms
 * min-of-N (4/4 pairs) and the whole post chain only 3.5 ms — and replacing
 * every scene material with a trivial one takes the interval straight back to
 * the 16.70 ms vsync lock.
 *
 * Fitting the two-point resolution sweep (tools/perf-ab.mjs --preset rscale
 * --dpr 2, 8/8 pairs) gives
 *
 *     frame ms  ~=  7.7 ms fixed  +  4.37 ms per megapixel
 *
 * and 0.75 scale (3.24 Mpx) measured −11.0 ms min-of-N on interval p50 with
 * over-33 ms frames going from 14.3/s to ZERO. Resolution is by a wide margin
 * the largest lever in the frame, and unlike every other one it is continuous.
 *
 * NOTE the recorded figure in CLAUDE.md ("~5.1 ms per megapixel plus a ~18.5 ms
 * resolution-independent floor") does not reproduce here: an 18.5 ms floor would
 * put DPR 1 at 25.8 ms, i.e. under 40 fps, and DPR 1 measures a clean 16.70 ms
 * vsync lock. The floor is ~7.7 ms on this build.
 *
 * So: rather than cut resolution for everyone, or leave a Retina machine at 30
 * fps, the scale is driven by the frame time. It only ever moves when frames are
 * ALREADY being missed, so a machine that can afford native resolution renders
 * at native resolution and is bit-identical to before.
 *
 * Four rules, each of which is a way this could have gone wrong:
 *   1. It is FROZEN while `__harness.perf.recording` is true. An adaptive knob
 *      that moves during a measurement silently invalidates every A/B this repo
 *      takes — the two arms would be fighting the scaler instead of each other.
 *   2. Discrete steps, not a continuous solve. Every change reallocates ~12
 *      post-processing render targets (postfx sizes them from
 *      getDrawingBufferSize), so a continuous controller would spend the frame
 *      it just saved on reallocation and would never settle.
 *   3. Rate-limited and hysteretic: it needs sustained evidence over a window to
 *      step down, more to step back up, and it will not move more often than
 *      `HOLD_MS`. Otherwise it oscillates on the first 40 ms frame and the image
 *      visibly breathes.
 *   4. It does nothing below `MIN_MPX`. At DPR 1 the frame has ~2 ms of margin
 *      and there is nothing to win, so a DPR-1 session never touches it.
 *
 * Defaults: aa off, scale 1, adaptive OFF. It is opt-in because it is the only
 * lever here that spends image quality (see the note at `adaptive` below).
 * Enabled, it holds 60 fps by dropping to at worst 0.7 linear = 49% of the
 * pixels, and only while frames are actually being missed.
 *
 * Override per-session with query params — no rebuild needed:
 *
 *     ?aa=1          multisampled default framebuffer (debug ablations)
 *     ?rscale=0.75   render at 75% linear resolution (pins it; disables adaptive)
 *     ?maxdpr=1      clamp device pixel ratio (what headless Chrome sees)
 *     ?adaptive=0    never move the resolution scale
 *     ?adaptive=1    force adaptive on even below MIN_MPX
 *     ?fpstarget=30  budget in fps the controller aims to hold (default 60)
 *     ?rfloor=0.6    lowest linear scale it may fall to (default 0.7)
 *
 * or at runtime via `window.__harness.gfx`.
 */
export function createEngine(container, opts = {}) {
  const qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const num = (key, fallback) => {
    const v = qs.get(key);
    const n = v === null ? NaN : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };

  // MSAA on the default framebuffer: off by default, see the note above.
  const antialias = qs.get('aa') === '1' ? true : qs.get('aa') === '0' ? false : (opts.antialias ?? false);

  const renderer = new THREE.WebGLRenderer({
    antialias,
    powerPreference: 'high-performance',
    stencil: false,
    logarithmicDepthBuffer: false,
  });

  let maxPixelRatio = num('maxdpr', opts.maxPixelRatio ?? 2);
  let resolutionScale = num('rscale', opts.resolutionScale ?? 1);
  let explicitPixelRatio = null;   // set by gfx.setPixelRatio(), overrides both

  // --- adaptive resolution controller ---------------------------------------
  // See the header. Steps are coarse on purpose (rule 2) and the ladder is
  // linear scale, so the pixel counts are 100%, 81%, 64%, 49% of native.
  // MEASURED on this machine at a 5.76 Mpx backbuffer: the ladder bottoms out at
  // 0.7 with interval p50 21.8 ms, p99 25.7 ms and ZERO frames over 33 ms — so
  // 0.7 converts "every frame misses 33 ms" into "no frame does", but it is not a
  // locked 60. The fit (7.7 + 4.37/Mpx) says a locked 60 needs ~2.06 Mpx, i.e.
  // scale 0.6. 0.7 is the default floor because 36% of native pixels is a large
  // visible cut to make on someone's behalf; `?rfloor=0.6` goes the rest of the way.
  const STEPS = [1.0, 0.9, 0.8, 0.7, 0.6];
  let minScale = num('rfloor', opts.minResolutionScale ?? 0.7);
  const maxStep = () => {
    let m = 0;
    for (let i = 0; i < STEPS.length; i++) if (STEPS[i] >= minScale - 1e-6) m = i;
    return m;
  };
  const MIN_MPX = 2.5;         // below this there is nothing to win (rule 4)
  const HOLD_MS = 900;         // no more than one step per this (rule 3)
  const WINDOW = 45;           // frames of evidence per decision
  let stepIndex = 0;
  // `?rscale=` is an explicit instruction from the operator; do not fight it.
  const rscalePinned = qs.get('rscale') !== null || opts.resolutionScale !== undefined;
  // DEFAULT OFF, deliberately. Resolution is the largest lever in the frame but
  // it is the one lever that spends image quality, and this project's quality
  // baseline is measured and defended (CLAUDE.md). It is also the one knob that
  // could silently invalidate every future measurement taken here, because a
  // controller that moves between two arms of an A/B is measuring itself. So it
  // ships as an opt-in with the numbers attached rather than as a decision made
  // on the operator's behalf: `?adaptive=1`, or `gfx.setAdaptive(true)`, or
  // `createEngine(el, { adaptive: true })`.
  let adaptive = qs.get('adaptive') === '0' ? false
    : qs.get('adaptive') === '1' ? true
    : (opts.adaptive ?? false);
  const forceAdaptive = qs.get('adaptive') === '1';
  // The budget. 60 fps unless asked otherwise. `downMs` carries a little slack
  // over the vsync period so a frame that lands at 17.1 ms is not treated as a
  // miss; `upMs` is well under it, so stepping back up cannot immediately
  // re-trigger a step down (hysteresis).
  let targetFps = num('fpstarget', opts.targetFps ?? 60);
  const budget = () => 1000 / Math.max(15, targetFps);
  let samples = new Float32Array(WINDOW);
  let nSamples = 0, sampleAt = 0;
  let lastChange = 0, lastFrame = 0;
  let adaptiveEvents = 0;
  const _v2 = new THREE.Vector2();

  const pctOf = (arr, n, p) => {
    const v = Array.prototype.slice.call(arr, 0, n).sort((a, b) => a - b);
    return v[Math.min(n - 1, Math.floor(p * (n - 1) + 0.5))];
  };

  /**
   * One rAF of its own. Deliberately NOT a hook into main.js' loop: a separate
   * rAF callback is invoked once per presented frame whatever else is
   * registered, so this needs no cooperation from the render loop and cannot be
   * forgotten by a future edit to it. The cost when idle is one subtraction.
   */
  function sampleLoop(now) {
    requestAnimationFrame(sampleLoop);
    const prev = lastFrame;
    lastFrame = now;
    if (!prev) return;
    if (!adaptive) return;
    // Rule 1: never move while the frame-time harness is recording.
    if (typeof window !== 'undefined' && window.__harness?.perf?.recording) return;
    const s = renderer.getDrawingBufferSize(_v2);
    if (!forceAdaptive && (s.x * s.y) / 1e6 < MIN_MPX && stepIndex === 0) return;

    samples[sampleAt++ % WINDOW] = now - prev;
    if (nSamples < WINDOW) nSamples++;
    if (nSamples < WINDOW || now - lastChange < HOLD_MS) return;

    const b = budget();
    // p70, not the mean: the mean is dragged around by the vsync mode lock
    // (CLAUDE.md trap 1) while a persistent miss shows up in the upper half of
    // the distribution regardless of which mode the compositor is holding.
    const p70 = pctOf(samples, nSamples, 0.70);
    const p30 = pctOf(samples, nSamples, 0.30);

    let next = stepIndex;
    if (p70 > b * 1.12) next = Math.min(maxStep(), stepIndex + 1);
    // Step back up only with real headroom, and only if the frame would still
    // fit after paying the ~1/0.81 more pixels the step up costs.
    else if (stepIndex > 0 && p30 < b * 0.80) next = stepIndex - 1;

    if (next !== stepIndex) {
      stepIndex = next;
      resolutionScale = STEPS[stepIndex];
      explicitPixelRatio = null;
      applyResolution();
      lastChange = now;
      nSamples = 0; sampleAt = 0;      // the old samples describe the old size
      adaptiveEvents++;
      // Tag the frame so `perf.report().marks` can show what the reallocation
      // cost, instead of it turning up as an unexplained spike.
      window.__harness?.perf?.mark?.('rscale-step', STEPS[stepIndex]);
    }
  }

  const resizeHooks = [];
  const pixelRatio = () => (explicitPixelRatio !== null
    ? explicitPixelRatio
    : Math.max(0.25, Math.min(devicePixelRatio, maxPixelRatio) * resolutionScale));

  /**
   * Re-applies pixel ratio + backbuffer size and notifies anything that sized
   * itself from the drawing buffer (postfx). Call after changing either knob.
   */
  function applyResolution() {
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(innerWidth, innerHeight);
    const w = innerWidth, h = innerHeight;
    for (const fn of resizeHooks) fn(w, h);
  }

  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.15, 12000);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    applyResolution();
  });

  /**
   * Resolution / backbuffer control. Exposed as `window.__harness.gfx` so
   * `tools/perf-ab.mjs` can A/B it inside one page session.
   */
  const gfx = {
    /** True if the default framebuffer is multisampled. */
    antialias,
    /** Register a callback run after any resolution change: (w, h) in CSS px. */
    onResize(fn) { resizeHooks.push(fn); return () => resizeHooks.splice(resizeHooks.indexOf(fn), 1); },
    get resolutionScale() { return resolutionScale; },
    /** 1 = native (capped by maxPixelRatio). 0.75 renders 56% of the pixels. */
    setResolutionScale(s) {
      const n = Math.max(0.25, Math.min(2, +s || 1));
      if (n === resolutionScale && explicitPixelRatio === null) return gfx.info();
      resolutionScale = n;
      explicitPixelRatio = null;
      applyResolution();
      return gfx.info();
    },
    get maxPixelRatio() { return maxPixelRatio; },
    setMaxPixelRatio(n) {
      const v = Math.max(0.25, Math.min(4, +n || 1));
      if (v === maxPixelRatio && explicitPixelRatio === null) return gfx.info();
      maxPixelRatio = v;
      explicitPixelRatio = null;
      applyResolution();
      return gfx.info();
    },
    /**
     * Absolute backbuffer scale, ignoring devicePixelRatio and both knobs above.
     * This is what `tools/perf-ab.mjs --preset dpr` swaps, so a DPR-1 headless
     * session can measure the DPR-2 fragment cost the user actually pays.
     */
    setPixelRatio(p) {
      const v = Math.max(0.25, Math.min(4, +p || 1));
      if (explicitPixelRatio === v) return gfx.info();
      explicitPixelRatio = v;
      applyResolution();
      return gfx.info();
    },

    // --- adaptive resolution -------------------------------------------------
    /**
     * Turn the frame-time-driven resolution controller on or off. Off pins
     * whatever scale is current. See the header for the measurements and for the
     * four rules the controller obeys — in particular that it is frozen while
     * `__harness.perf.recording`, so it can never move during an A/B.
     */
    get adaptive() { return adaptive; },
    setAdaptive(on) {
      adaptive = !!on;
      if (!adaptive) { nSamples = 0; sampleAt = 0; }
      return gfx.info();
    },
    /** Lowest linear scale the controller may fall to. */
    get minResolutionScale() { return minScale; },
    setMinResolutionScale(n) {
      minScale = Math.max(0.4, Math.min(1, +n || 0.7));
      if (stepIndex > maxStep()) {
        stepIndex = maxStep();
        resolutionScale = STEPS[stepIndex];
        explicitPixelRatio = null;
        applyResolution();
      }
      return gfx.info();
    },
    /** Frame budget the controller aims to hold, in fps. */
    get targetFps() { return targetFps; },
    setTargetFps(n) {
      targetFps = Math.max(15, Math.min(240, +n || 60));
      nSamples = 0; sampleAt = 0;
      return gfx.info();
    },
    /** Put the ladder back to native and leave it there. */
    resetAdaptive() {
      stepIndex = 0;
      resolutionScale = 1;
      explicitPixelRatio = null;
      nSamples = 0; sampleAt = 0;
      applyResolution();
      return gfx.info();
    },

    info() {
      const s = renderer.getDrawingBufferSize(_v2);
      return {
        antialias,
        devicePixelRatio,
        maxPixelRatio,
        resolutionScale,
        pixelRatio: renderer.getPixelRatio(),
        drawingBuffer: [s.x, s.y],
        megapixels: +((s.x * s.y) / 1e6).toFixed(3),
        adaptive,
        adaptiveStep: stepIndex,
        adaptiveSteps: STEPS,
        adaptiveEvents,
        minResolutionScale: minScale,
        targetFps,
      };
    },
  };

  requestAnimationFrame(sampleLoop);

  return { renderer, scene, camera, gfx };
}
