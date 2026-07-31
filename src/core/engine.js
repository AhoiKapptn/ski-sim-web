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
 * Fitting the resolution sweep (tools/perf-ab.mjs --preset rscale --dpr 2, 8/8
 * pairs, plus an independent ascending sweep) gives
 *
 *     frame ms  ~=  8-12 ms fixed  +  3-5 ms per megapixel,  valid 1.4-5.8 Mpx
 *
 * and 0.75 scale (3.24 Mpx) measured −11.0 ms min-of-N on interval p50 with
 * over-33 ms frames going from 14.3/s to ZERO. Resolution is by a wide margin
 * the largest lever in the frame, and unlike every other one it is continuous.
 *
 * Two cautions on that fit. CLAUDE.md trap 5 records "~5.1 ms per megapixel plus
 * a ~18.5 ms resolution-independent floor": the SLOPE reproduces (an independent
 * ascending pass gives 5.21 ms/Mpx) but the FLOOR does not — an 18.5 ms floor
 * would put DPR 1 at 25.8 ms, under 40 fps, and DPR 1 measures a clean 16.70 ms
 * vsync lock. And the model is only linear inside the window above: at 9.0 Mpx
 * the real cost is 77.5 ms where every linear fit predicts 40-54. DO NOT
 * extrapolate it — which is exactly why the up-step predictor below prefers
 * points it has actually observed to anything it has fitted.
 *
 * So: rather than cut resolution for everyone, or leave a Retina machine at 30
 * fps, the scale is driven by the frame time. It only ever moves when frames are
 * ALREADY being missed, so a machine that can afford native resolution renders
 * at native resolution and is bit-identical to before.
 *
 * Five rules, each of which is a way this went wrong in review:
 *   1. It is FROZEN while `__harness.perf.recording` is true, while
 *      `gfx.freeze()` is held, and whenever `gfx.setPixelRatio()` has pinned the
 *      backbuffer. An adaptive knob that moves during a measurement silently
 *      invalidates every A/B this repo takes. `perf.recording` alone was NOT
 *      enough: a tool's settle window runs before `perf.start()`, and a step used
 *      to clear the pin outright, so `perf-ab.mjs --preset dpr` had its 5.76 Mpx
 *      arm turned into 0.706 Mpx before recording even began.
 *   2. Discrete steps, not a continuous solve. Every change reallocates ~12
 *      post-processing render targets (postfx sizes them from
 *      getDrawingBufferSize), so a continuous controller would spend the frame
 *      it just saved on reallocation and would never settle.
 *   3. Rate-limited and hysteretic: both p70 and p30 must be over budget to step
 *      down, so a handful of spike frames cannot ratchet the resolution away, and
 *      it will not move more often than `HOLD_MS`.
 *   4. It does nothing below `MIN_MPX`, so a DPR-1 session is bit-identical. Note
 *      that ENABLING the feature must not bypass this guard — `?adaptive=1` used
 *      to set the bypass flag as a side effect, so "verified inert at DPR 1" was
 *      vacuous. `?adaptive=force` is the bypass; it exists for testing.
 *   5. It must be able to come back UP. The first cut could not: the up-test
 *      asked for the interval to be 20% UNDER budget, i.e. 13.33 ms at 60 fps,
 *      which is below the vsync period and therefore unsatisfiable while frames
 *      are presenting. That made it a one-way ratchet for any target above
 *      ~48 fps — and combined with trap 1 (this build spontaneously locks to
 *      exactly 30.0 fps, which is never a regression) one spurious mode lock
 *      would have destroyed the resolution permanently. The test is now "is the
 *      frame meeting vsync, and does the measured cost/Mpx say it would still
 *      meet it one step up".
 *
 * Defaults: aa off, scale 1, adaptive ON above MIN_MPX (2.5 Mpx) with a 0.7
 * floor. Independent review measured the quality cost at that floor as −0.3% to
 * −5.4% snow micro-contrast, ≤0.4 L* and ≤0.003 B/R, no rings, no fireflies and
 * corduroy still parallel — against the alternative of every frame missing 20 ms.
 * `?adaptive=0` opts out. It does NOT hold a locked 60 at 5.76 Mpx (0.7 measures
 * p50 21.8 / p99 25.7 ms); what it guarantees is no frame over 33 ms.
 *
 * Override per-session with query params — no rebuild needed:
 *
 *     ?aa=1            multisampled default framebuffer (debug ablations)
 *     ?rscale=0.75     render at 75% linear resolution, and PIN it (adaptive off
 *                      unless ?adaptive= is also given explicitly)
 *     ?maxdpr=1        clamp device pixel ratio (what headless Chrome sees)
 *     ?adaptive=0      never move the resolution scale
 *     ?adaptive=1      enable (still inert below MIN_MPX)
 *     ?adaptive=force  enable AND bypass the MIN_MPX guard — testing only
 *     ?fpstarget=30    budget in fps the controller aims to hold (default 60)
 *     ?rfloor=0.6      lowest linear scale it may fall to (default 0.7)
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
  // Ladder of linear scales; pixel counts are 100%, 81%, 64%, 49%, 36% of native.
  // Coarse on purpose (rule 2). MEASURED at a 5.76 Mpx backbuffer: at 0.7 the
  // interval is p50 21.8 / p99 25.7 ms with ZERO frames over 33 ms — so 0.7 turns
  // "every frame misses 33 ms" into "no frame does", but it is NOT a locked 60.
  // 0.7 is the default floor because 36% of native is a large visible cut to make
  // on someone's behalf; `?rfloor=0.6` goes further.
  const STEPS = [1.0, 0.9, 0.8, 0.7, 0.6];
  let minScale = num('rfloor', opts.minResolutionScale ?? 0.7);
  /** Deepest ladder index the floor allows. */
  const maxStep = () => {
    let m = 0;
    for (let i = 0; i < STEPS.length; i++) if (STEPS[i] >= minScale - 1e-6) m = i;
    return m;
  };
  /**
   * The ladder index nearest a given scale. `stepIndex` is ALWAYS derived from
   * `resolutionScale` through this, never tracked independently — they were two
   * variables before and they desynchronised: with `?rscale=0.6` the scale was
   * 0.6 while the index was still 0, so the first step *down* assigned
   * `STEPS[1] = 0.9` and RAISED the resolution to 2.25x the pixels while trying
   * to reduce cost.
   */
  const nearestStep = (s) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < STEPS.length; i++) {
      const d = Math.abs(STEPS[i] - s);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  const MIN_MPX = 2.5;         // below this there is nothing to win (rule 4)
  const HOLD_MS = 900;         // no more than one step per this (rule 3)
  const WINDOW = 45;           // frames of evidence per decision

  // `?rscale=` / `opts.resolutionScale` is an explicit instruction about the
  // resolution. The header documents it as pinning, so it pins: the controller
  // is off unless adaptive was ALSO asked for explicitly. (This was computed and
  // then never read, so the documented behaviour did not exist.)
  const adaptiveQ = qs.get('adaptive');
  const rscalePinned = qs.get('rscale') !== null || opts.resolutionScale !== undefined;
  const adaptiveAsked = adaptiveQ !== null || opts.adaptive !== undefined;

  // DEFAULT ON above MIN_MPX. Below it the controller is inert, so a DPR-1
  // machine is bit-identical to before; above it the alternative is the measured
  // status quo of every frame missing 20 ms. `?adaptive=0` opts out.
  let adaptive = adaptiveQ === '0' ? false
    : (adaptiveQ === '1' || adaptiveQ === 'force') ? true
    : (opts.adaptive ?? !rscalePinned);

  // SEPARATE CONCERN from enabling. `?adaptive=1` used to set this too, which
  // meant the flag that turns the feature on also bypassed the MIN_MPX guard —
  // so "verified inert at DPR 1" was vacuous: at 1.44 Mpx it would step. Only
  // `?adaptive=force` bypasses the guard now.
  const forceAdaptive = adaptiveQ === 'force' || opts.forceAdaptive === true;

  let targetFps = num('fpstarget', opts.targetFps ?? 60);
  const budget = () => 1000 / Math.max(15, targetFps);

  // Preallocated: this ran `Array.prototype.slice` + `sort` twice per frame,
  // ~5400 allocations/s, to decide mostly NOT to act. Adding GC churn to the
  // frame tail in a project that quotes p99 is the wrong trade.
  const samples = new Float32Array(WINDOW);
  const scratch = new Float32Array(WINDOW);
  let nSamples = 0, sampleAt = 0;
  let lastChange = 0, lastFrame = 0;
  let adaptiveEvents = 0;
  let freezeDepth = 0;
  let upVotes = 0;             // consecutive windows agreeing that we may go up
  let lastDecision = null;     // diagnostics: why the last window did or did not move
  const _v2 = new THREE.Vector2();

  // Observed cost per ladder step, for the up-step prediction below.
  const obsMs = new Float32Array(STEPS.length).fill(-1);
  const obsMpx = new Float32Array(STEPS.length).fill(-1);
  // Own log of steps taken. `perf.mark()` cannot be used here: it is a no-op
  // unless `perf.recording`, and the controller returns early whenever perf IS
  // recording, so that call could never once have fired.
  const stepLog = [];

  function pct(n, p) {
    scratch.set(samples.subarray(0, n));
    const v = scratch.subarray(0, n);
    v.sort();
    return v[Math.min(n - 1, Math.floor(p * (n - 1) + 0.5))];
  }

  const mpxNow = () => {
    const s = renderer.getDrawingBufferSize(_v2);
    return (s.x * s.y) / 1e6;
  };
  /** Megapixels the backbuffer would have at ladder index `i`. Scale is linear,
   *  so pixels go as its square. */
  const mpxAt = (i) => mpxNow() * (STEPS[i] * STEPS[i]) / Math.max(resolutionScale * resolutionScale, 1e-6);

  /**
   * Predicted frame cost at `i`, in ms.
   *
   * Prefers a two-point fit through whatever steps have actually been observed
   * this session — the frame is `fixed + slope * Mpx` and both terms are real
   * (measured on this build: roughly 8-12 ms fixed and 3-5 ms/Mpx over
   * 1.4-5.8 Mpx). With fewer than two observations it falls back to assuming
   * ALL cost is fragment cost, which over-predicts and therefore only ever
   * makes the controller more reluctant to step up.
   */
  function predictMs(i, curMs) {
    if (obsMs[i] >= 0) return obsMs[i];
    let lo = -1, hi = -1;
    for (let k = 0; k < STEPS.length; k++) {
      if (obsMs[k] < 0) continue;
      if (lo < 0 || obsMpx[k] < obsMpx[lo]) lo = k;
      if (hi < 0 || obsMpx[k] > obsMpx[hi]) hi = k;
    }
    const target = mpxAt(i);
    if (lo >= 0 && hi >= 0 && obsMpx[hi] - obsMpx[lo] > 0.25) {
      const slope = (obsMs[hi] - obsMs[lo]) / (obsMpx[hi] - obsMpx[lo]);
      const fixed = obsMs[lo] - slope * obsMpx[lo];
      return Math.max(curMs, fixed + slope * target);
    }
    return curMs * (target / Math.max(mpxNow(), 1e-3));
  }

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
    if (!adaptive || freezeDepth > 0) return;
    // Rule 1: never move while the frame-time harness is recording...
    if (typeof window !== 'undefined' && window.__harness?.perf?.recording) return;
    // ...and never move while something has pinned the backbuffer with
    // setPixelRatio(). `perf-ab.mjs --preset dpr` pins its arms that way, and a
    // step used to clear `explicitPixelRatio` outright and throw the pinned arm
    // away — 5.76 Mpx became 0.706 Mpx during the unprotected settle window
    // before `perf.start()`. Use gfx.freeze() to bracket a window explicitly.
    if (explicitPixelRatio !== null) return;

    const idx = nearestStep(resolutionScale);
    if (!forceAdaptive && mpxNow() < MIN_MPX && idx === 0) return;

    samples[sampleAt++ % WINDOW] = now - prev;
    if (nSamples < WINDOW) nSamples++;
    if (nSamples < WINDOW || now - lastChange < HOLD_MS) return;

    const b = budget();
    // p70/p30 rather than a mean: the mean is dragged around by the vsync mode
    // lock (CLAUDE.md trap 1) while a persistent miss shows up across the whole
    // distribution regardless of which mode the compositor is holding.
    const p70 = pct(nSamples, 0.70);
    const p30 = pct(nSamples, 0.30);

    // Record what this step actually costs, for predictMs().
    obsMs[idx] = p70;
    obsMpx[idx] = mpxNow();

    // Every decision is recorded, not just the ones that move, so "why did it not
    // step" is answerable from `gfx.info().lastDecision` instead of by guessing.
    lastDecision = {
      t: Math.round(now), idx, scale: resolutionScale, mpx: +mpxNow().toFixed(3),
      budget: +b.toFixed(2), p70: +p70.toFixed(2), p30: +p30.toFixed(2),
      downTest: p70 > b * 1.12 && p30 > b * 1.05,
      atFloor: idx >= maxStep(),
      meeting: p70 <= b * 1.02,
      predictUp: idx > 0 ? +predictMs(idx - 1, p70).toFixed(2) : null,
      predictLimit: +(b * 0.95).toFixed(2),
      upVotes,
    };

    let next = idx;
    // DOWN. Both percentiles must be over budget, so a handful of spike frames
    // cannot ratchet the resolution down — the bulk of the distribution has to
    // be slow.
    //
    // HONEST LIMIT: a spurious vsync half-rate lock (trap 1 — this build has
    // spontaneously held exactly 30.0 fps) is NOT distinguishable from a genuine
    // 33 ms frame using the presented interval alone, and this controller has
    // nothing else to go on. It will step down on a mode lock. What makes that
    // survivable rather than permanent is that the up-step below actually works:
    // when the lock lifts, the resolution comes back. It did not work before,
    // which is what turned a mode lock into irreversible damage.
    if (p70 > b * 1.12 && p30 > b * 1.05) {
      if (idx < maxStep()) next = idx + 1;
      upVotes = 0;
    } else if (idx > 0) {
      // UP. The old test was `p30 < b * 0.80`, i.e. 13.33 ms at 60 fps — BELOW
      // the 16.67 ms vsync period, so it was unsatisfiable whenever frames were
      // presenting and the controller was a one-way ratchet for any target above
      // ~48 fps. The question is not "is the frame 20% under budget", which
      // vsync forbids; it is "is the frame MEETING vsync, and would it still
      // meet it after paying for the extra pixels".
      const meeting = p70 <= b * 1.02;
      // TWO consecutive agreeing windows before going up. Stepping up is the
      // risky direction — it can immediately re-trigger a step down, and the
      // observed failure mode was 0.8 -> 0.9 -> 0.8 -> 0.7 inside 12 s when
      // background load moved p70 from 33 to 75 ms. Down-steps stay
      // single-window, because being slow is the condition that matters.
      if (meeting && predictMs(idx - 1, p70) < b * 0.95) upVotes++;
      else upVotes = 0;
      if (upVotes >= 2) { next = idx - 1; upVotes = 0; }
    }

    if (next !== idx) {
      resolutionScale = STEPS[next];
      applyResolution();
      lastChange = now;
      adaptiveEvents++;
      if (stepLog.length < 200) {
        stepLog.push({ t: Math.round(now), from: STEPS[idx], to: STEPS[next], p70: +p70.toFixed(2), p30: +p30.toFixed(2) });
      }
    }
    // Whether or not anything moved, start a fresh window. Without this the
    // controller re-ran two percentile sorts EVERY frame in perpetuity once it
    // was sitting at the floor with the budget still unmet — which is the normal
    // steady state, because the floor does not reach 60 fps.
    nSamples = 0; sampleAt = 0;
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
    /**
     * 1 = native (capped by maxPixelRatio). 0.75 renders 56% of the pixels.
     *
     * The controller derives its ladder position from this value every frame
     * rather than tracking an index of its own, so setting the scale by hand and
     * then letting the controller act cannot produce a step in the wrong
     * direction. It also drops any stale cost observations, which describe a
     * different resolution.
     */
    setResolutionScale(s) {
      const n = Math.max(0.25, Math.min(2, +s || 1));
      if (n === resolutionScale && explicitPixelRatio === null) return gfx.info();
      resolutionScale = n;
      explicitPixelRatio = null;
      obsMs.fill(-1); obsMpx.fill(-1);
      nSamples = 0; sampleAt = 0;
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
      nSamples = 0; sampleAt = 0;
      return gfx.info();
    },
    /**
     * Suspend the controller without changing the mode, for the duration of a
     * measurement. Reentrant, so nested windows are safe. `perf.recording`
     * already freezes it, but a measurement tool's SETTLE window runs before
     * `perf.start()` and was unprotected — bracket the whole window with this.
     */
    freeze() { freezeDepth++; return gfx.info(); },
    unfreeze() { freezeDepth = Math.max(0, freezeDepth - 1); nSamples = 0; sampleAt = 0; return gfx.info(); },
    get frozen() { return freezeDepth > 0; },

    /** Lowest linear scale the controller may fall to. */
    get minResolutionScale() { return minScale; },
    setMinResolutionScale(n) {
      minScale = Math.max(0.4, Math.min(1, +n || 0.7));
      // Only ever pull the scale back UP to the new floor; never push it down.
      if (resolutionScale < minScale - 1e-6) {
        resolutionScale = STEPS[maxStep()];
        obsMs.fill(-1); obsMpx.fill(-1);
        nSamples = 0; sampleAt = 0;
        applyResolution();
      }
      return gfx.info();
    },
    /** Frame budget the controller aims to hold, in fps. */
    get targetFps() { return targetFps; },
    setTargetFps(n) {
      targetFps = Math.max(15, Math.min(240, +n || 60));
      // The recorded costs are still valid (they are ms at a resolution), but the
      // decision they feed has changed, so re-gather evidence before acting.
      nSamples = 0; sampleAt = 0;
      return gfx.info();
    },
    /** Put the ladder back to native and leave it there. */
    resetAdaptive() {
      resolutionScale = 1;
      explicitPixelRatio = null;
      obsMs.fill(-1); obsMpx.fill(-1);
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
        adaptiveForced: forceAdaptive,
        rscalePinned,
        frozen: freezeDepth > 0,
        // Derived, never stored — see `nearestStep`.
        adaptiveStep: nearestStep(resolutionScale),
        adaptiveSteps: STEPS,
        adaptiveMaxStep: maxStep(),
        adaptiveEvents,
        adaptiveLog: stepLog.slice(-12),
        lastDecision,
        minResolutionScale: minScale,
        targetFps,
      };
    },
  };

  requestAnimationFrame(sampleLoop);

  return { renderer, scene, camera, gfx };
}
