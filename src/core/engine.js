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
 *   5. It must be able to come back UP. This took THREE attempts, and the first
 *      two failed the same way — a threshold below the refresh period, which a
 *      presented interval can never go under:
 *        - `p30 < b * 0.80` = 13.33 ms at 60 fps. Unsatisfiable.
 *        - then `predictMs(...) < b * 0.95` = 15.83 ms. Also unsatisfiable, and
 *          worse, this was written directly underneath a comment correctly
 *          diagnosing the first one.
 *      A third, independent blocker sat behind them: cost observations were never
 *      aged out, and the reading stored for a ladder index is by construction the
 *      over-budget value that caused the step down in the first place — measured
 *      frozen at 25.3 ms for 24 s while the real frame was 16.7 ms.
 *      A FOURTH arrived by yet another route and is the reason the fix below is
 *      shaped the way it is. The guard that decided "this frame is vsync-pinned,
 *      so its cost is unknowable" was itself a threshold — a session-monotone
 *      minimum interval — and it could slide underneath the value it had to be
 *      above. Observed drifting 16.7 -> 15.1 ms inside a minute, in roughly 2 of
 *      5 sessions, after which the guard could never fire and the ratchet was
 *      back, silently, for the rest of the session.
 *
 *      That is the same defect three times over, so the fix is to delete the
 *      CLASS rather than move the number: there is no fallback prediction and
 *      therefore no threshold guarding one. THE PRESENTED INTERVAL IS ALWAYS
 *      QUANTISED — the headless begin-frame tick is 8.33 ms and every clean
 *      interval observed is an integer multiple of it (16.7, 25.0, 33.3, 41.7,
 *      50.0, 58.3, 66.7) — so it is an upper bound on an unknown cost, always,
 *      and nothing can be inferred by scaling it. `predictMs` returns a number
 *      only when it has a fresh measurement of the target rung or a two-point
 *      fit through fresh measurements; otherwise it says "unknown".
 *
 *      All four are fixed, and the up-test is now:
 *        meeting (p70 <= b*1.02)  AND  affordable  AND  not in backoff,
 *      confirmed over two consecutive windows, where `affordable` is true when
 *      the cost is unknown — i.e. it PROBES, and lets the reliable down-step
 *      undo a bad guess, rather than inventing a prediction.
 *
 *      This matters far beyond tidiness. Trap 1 says this build spontaneously
 *      locks to exactly 30.0 fps and that such a reading is never a regression;
 *      the controller cannot tell that from a genuine 33 ms frame (p70 33.4 /
 *      p30 32.6 is exactly 2x16.7) and WILL step down on it. Reversibility, not
 *      detection, is what makes that survivable — so while the up-path was
 *      broken, one spurious mode lock cost the player 51% of their pixels for the
 *      rest of the session with no way back short of a reload.
 *
 * KNOWN, ACCEPTED BEHAVIOUR: it takes occasional FALSE DOWN-STEPS on compositor
 * flutter. Measured on a scene with every material gutted — literally no shading
 * work at all — it still stepped 1 -> 0.9 on p70 33.3 / p30 25, and 1 -> 0.9 ->
 * 0.8 on p70 25 / p30 20.8, recovering 9 s and 16 s later. This is trap 1: those
 * are 4-tick and 3-tick intervals handed out by the compositor, not frame cost,
 * and the presented interval carries nothing that distinguishes them from real
 * load. It is self-correcting because the up-path works, which is the whole
 * argument for the up-path — but a player can see a resolution change that has
 * no relation to what is on screen. Fixing it properly needs a cost signal that
 * is not the presented interval, and this build does not have one (the GPU timer
 * is inflated by submission count; gl.finish() does not drain — see trap 7).
 *
 * Defaults: aa off, adaptive ON above MIN_MPX (2.5 Mpx) with a 0.7 floor that
 * RELAXES BY DISPLAY SIZE (see FLOOR_MPX below: a rung under 0.7 is allowed
 * whenever it still renders >= 2.3 Mpx), and a START capped at INIT_MPX
 * (5.8 Mpx) so a fullscreen 5K display does not boot into a 15 s slideshow
 * while the ladder walks down. Independent review measured the quality cost of
 * the 0.7 floor on a 5.76 Mpx backbuffer as −0.3% to −5.4% snow
 * micro-contrast, ≤0.4 L* and ≤0.003 B/R, no rings, no fireflies and corduroy
 * still parallel — against the alternative of every frame missing 20 ms.
 * `?adaptive=0` opts out. It does NOT hold a locked 60 at 5.76 Mpx (0.7
 * measures p50 21.8 / p99 25.7 ms); what it guarantees is no frame over 33 ms
 * — a guarantee that only holds because of the Mpx-based floor: at a
 * fullscreen 14.7 Mpx backbuffer the old 0.7 fraction still rendered 7.2 Mpx,
 * which is slower than the "before" this feature was built against.
 *
 * Override per-session with query params — no rebuild needed:
 *
 *     ?aa=1            multisampled default framebuffer (debug ablations)
 *     ?rscale=0.75     render at 75% linear resolution, and PIN it (adaptive off
 *                      unless ?adaptive= is also given explicitly). NOTE: if you
 *                      DO ask for both, "pin" means only the starting point —
 *                      `nearestStep` puts the scale on the ladder and the
 *                      controller may then climb ABOVE the value you gave, up to
 *                      1.0, once the frame has headroom. Use `?adaptive=0` (the
 *                      default with ?rscale) for a scale that cannot move.
 *     ?maxdpr=1        clamp device pixel ratio (what headless Chrome sees)
 *     ?adaptive=0      never move the resolution scale
 *     ?adaptive=1      enable (still inert below MIN_MPX)
 *     ?adaptive=force  enable AND bypass the MIN_MPX guard — testing only
 *     ?fpstarget=30    budget in fps the controller aims to hold (default 60)
 *     ?rfloor=0.6      lowest linear scale it may fall to (default 0.7, and an
 *                      explicit value is honoured to the letter — the
 *                      display-size relaxation only applies to the default)
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
  const STEPS = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
  let minScale = num('rfloor', opts.minResolutionScale ?? 0.7);
  // Was the floor an explicit instruction? An explicit `?rfloor=` is honoured
  // to the letter, like `?rscale=`. Only the DEFAULT floor gets the
  // display-size relaxation below.
  const rfloorExplicit = qs.get('rfloor') !== null || opts.minResolutionScale !== undefined;
  /**
   * The FLOOR IS IN MEGAPIXELS, not only in scale — the 0.7 default was
   * calibrated on a 5.76 Mpx backbuffer (1600x900 CSS at DPR 2), where it
   * renders 2.8 Mpx and costs -0.3% to -5.4% micro-contrast. Nobody ever
   * measured a real fullscreen window: a 16" MacBook is 7.7 Mpx and a 5K
   * display is 14.7 Mpx, where the same 0.7 still renders 7.2 Mpx — measured
   * at p50 53.3 ms NATIVE (n=224, every frame over 33 ms) — so the controller
   * bottomed out deep in slideshow territory and its "no frame over 33 ms"
   * guarantee silently broke exactly on the displays that needed it. The
   * cost curve is also superlinear past ~5.8 Mpx (77.5 ms at 9.0 Mpx where
   * every linear fit predicts 40-54; CLAUDE.md trap 5), which is why the
   * breakage grows faster than the display does.
   *
   * So a rung below the linear floor is allowed when it still yields at least
   * FLOOR_MPX. The first cut of this was 2.3 Mpx, derived from HEADLESS
   * frame costs — and a real, headed browser on a live desktop is 3-5 ms
   * SLOWER per frame than headless Chrome at the same megapixels (real
   * compositor, real 120 Hz pacing, the desktop behind it). Measured in
   * headed Brave on the 16" MBP (1728x866 CSS at DPR 2 = 5.99 Mpx native,
   * pinned rungs, uncontended, canonical carve):
   *
   *     scale 1.0  5.99 Mpx   p50 31.0 ms          0.7  2.93 Mpx   p50 20.5
   *     scale 0.8  3.83 Mpx   p50 23.6             0.6  2.15 Mpx   p50 17.4
   *                                                0.5  1.50 Mpx   p50 12.7-14.9
   *
   * i.e. the rung that actually holds 60 fps in the game's real environment is
   * 0.5-0.6, and a 2.3 Mpx cutoff forbade it — the controller sat pinned at
   * 0.7 with downTest=true, wanting a rung it was not allowed. atFloor+
   * downTest is exactly that signature in gfx.info().lastDecision.
   *
   * 1.4 Mpx is the floor instead, because 1.44 Mpx (1600x900) is the
   * resolution every quality review and screenshot of this project was judged
   * at — the documented look of the game IS the look at this pixel count. The
   * floor is only permission, not a target: machines that meet budget at a
   * higher rung never descend to it.
   */
  const FLOOR_MPX = 1.4;
  /** Native (scale-1) megapixels, before the renderer exists on first call. */
  const nativeMpx = () => {
    const pr = Math.min(devicePixelRatio || 1, maxPixelRatio);
    return (innerWidth * pr * innerHeight * pr) / 1e6;
  };
  /** Deepest ladder index the floor allows. */
  const maxStep = () => {
    let m = 0;
    for (let i = 0; i < STEPS.length; i++) {
      const ok = STEPS[i] >= minScale - 1e-6
        || (!rfloorExplicit && nativeMpx() * STEPS[i] * STEPS[i] >= FLOOR_MPX);
      if (ok) m = i;
    }
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
  // Boot frames are not gameplay frames: `main.js` links programs at frames 30,
  // 120, 300 and 600, and the clipmap and scatter pools are still streaming in.
  // Reacting to them means reacting to shader-link stalls. It also keeps the
  // controller out of the way of `shoot.mjs`, which boots, waits ~1.2 s and then
  // pauses the sim — without this grace period it had already stepped to 0.9 by
  // then and `--dpr 2` screenshots came out at 4.67 Mpx instead of 5.76.
  //
  // 2.5 s, down from 4. The capture-tool half of the argument no longer needs
  // the length: `__setAuto(false)` now pauses the controller directly (see
  // `simPaused`), and every capture tool pauses within ~1.2 s of boot. What the
  // grace still has to cover is the link stalls, and those are over by ~2 s.
  // The cost of every extra grace second is a second of the player's FIRST
  // IMPRESSION spent at a rung the machine may not afford — measured in headed
  // Brave, the whole pre-settle stretch runs 25-38 ms/frame.
  const START_GRACE_MS = 2500;
  let firstFrameAt = 0;
  // A first impression is also why the boot phase decides on less evidence: 24
  // frames instead of 45. At 30 ms/frame the full window is 1.4 s of visible
  // chop per decision; the boot phase trades statistical confidence for
  // reaction time, and a wrong step is corrected one window later anyway.
  const BOOT_WINDOW = 24;
  const BOOT_PHASE_MS = 8000;   // after the grace; boot calibration lives here too

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

  // --- capped START, in megapixels -------------------------------------------
  // The controller always began at scale 1 and walked down one rung per
  // HOLD_MS-plus-a-45-frame-window — which at the 53 ms frames a fullscreen 5K
  // display produces natively is a 15-20 s slideshow after every boot before
  // it even reaches the floor. The walk exists to find the UNKNOWN budget rung;
  // there is nothing unknown about the start being over the top of the measured
  // cost window (5.8 Mpx, past which the cost curve is superlinear — trap 5).
  // So when the controller is on and nothing is pinned, the starting rung is
  // the largest one at or under INIT_MPX, and the ladder still climbs from
  // there if the machine turns out to afford more. Every backbuffer at or
  // under 5.8 Mpx — which includes every configuration this project has ever
  // measured or reviewed — starts at native exactly as before.
  const INIT_MPX = 5.8;
  if (adaptive && !rscalePinned && explicitPixelRatio === null) {
    for (let i = 0; i < STEPS.length; i++) {
      if (nativeMpx() * STEPS[i] * STEPS[i] <= INIT_MPX || i === maxStep()) {
        if (STEPS[i] < resolutionScale) resolutionScale = STEPS[i];
        break;
      }
    }
  }

  let targetFps = num('fpstarget', opts.targetFps ?? 60);
  const budget = () => 1000 / Math.max(15, targetFps);

  // --- the vsync ladder ------------------------------------------------------
  /**
   * MEASURED, on a 144 Hz display, and the reason this exists.
   *
   * Every threshold below used to be a fraction of `budget()` — 16.67 ms at the
   * shipped target of 60 fps. That is not a frame time a display can present.
   * The presented interval is quantised to multiples of the refresh period, so
   * on a given panel the only frame times that exist are:
   *
   *      60 Hz    16.7  33.3  50.0        (budget IS a rung)
   *     120 Hz     8.3  16.7  25.0  33.3  (budget IS a rung)
   *     144 Hz     6.9  13.9  20.8  27.8  (budget is NOT a rung)
   *
   * On 60 and 120 Hz panels 16.67 ms is itself a rung, so aiming at the budget
   * and aiming at a rung are the same instruction and nothing in this
   * controller's history could tell them apart. On 144 Hz they are different,
   * and the difference is a permanent judder:
   *
   *   - `meeting` accepted anything at or under 17.0 ms, so the controller would
   *     happily settle on a rung whose true cost was ~16 ms. There is no 16 ms
   *     rung at 144 Hz: it presents as an alternating 13.9 / 20.8 mix.
   *   - the judder test then saw those 20.8 ms samples, stepped down, met budget
   *     comfortably at 13.9, and after the 20 s backoff climbed straight back
   *     into the same rung. A 20-second hunting cycle, each hop reallocating
   *     ~12 render targets.
   *
   * Measured on the reporter's machine: 5.16 Mpx at scale 0.9, p50 23.5 ms —
   * between the 20.8 and 27.8 rungs — with 163 of 171 frames over 20 ms but
   * only 4 over 33. That distribution is not "37 fps", it is two rungs
   * alternating, which is what the complaint actually was.
   *
   * So the controller now measures the tick and aims at the fastest RUNG that
   * still meets the target, rather than at the target itself. At 60 and 120 Hz
   * that is 16.67 ms exactly as before — the change is a no-op on every display
   * this project has ever been measured on. At 144 Hz it is 13.89 ms, which is
   * a frame time that can actually be presented, and the hunting stops.
   *
   * NOTE the target itself is still a choice, and on a high-refresh panel it is
   * a real one: 60 fps forces the 13.89 ms rung and therefore a lower
   * resolution, where `?fpstarget=48` picks the 20.83 ms rung and buys back a
   * lot of pixels for a lock that is still perfectly smooth. `gfx.info()`
   * reports the ladder so the choice can be made on numbers.
   */
  let displayTick = 0;               // ms; 0 = not yet known

  /**
   * Estimate the refresh period from the sample window.
   *
   * It cannot be read from the fastest frame observed: on a machine that is
   * missing every frame, the fundamental is never presented — at 144 Hz a
   * struggling scene shows 20.8 and 27.8 and never once 6.9. So the tick is
   * inferred from the SPACING of the observed levels instead, which survives
   * that: 20.8 and 27.8 are 3 and 4 multiples of 6.94, and no larger period
   * explains both.
   *
   * Derived from the data rather than snapped to a list of standard refresh
   * rates, because snapping mis-assigns — 13.89 ms sits within 4% of 75 Hz's
   * 13.33 ms, which is well inside any tolerance loose enough to absorb
   * Chrome's begin-frame jitter.
   */
  function estimateTick(n) {
    if (n < 20) return;
    const lo = pct(n, 0.05);         // robust fastest interval
    if (!(lo > 1)) return;
    // Largest candidate first: the fundamental is the LARGEST period that
    // explains every level. Smaller ones always fit better and always would.
    for (let k = 1; k <= 5; k++) {
      const T = lo / k;
      if (T < 3.5) break;            // faster than ~285 Hz is not a display
      const tol = T * 0.12;
      let fit = 0;
      for (let i = 0; i < n; i++) {
        const m = samples[i] / T;
        if (Math.abs(m - Math.round(m)) * T <= tol) fit++;
      }
      if (fit / n < 0.85) continue;
      // REFINE, and this step is load-bearing rather than cosmetic. `lo` is a
      // low percentile, so it sits at the bottom of the jitter and T starts
      // BELOW the true period: measured, a clean 60 Hz lock seeded T = 16.2
      // against a real 16.70. Everything downstream is a threshold the frame
      // has to satisfy, so a tick that is 3% low makes `meeting`
      // (p70 <= lock * 1.02 = 16.52) unsatisfiable BY A PERFECT LOCK — the
      // one-way ratchet of rule 5, arriving by a fifth route.
      //
      // So solve for the period that best explains the levels, rather than
      // trusting the seed: with each sample assigned to its multiple, the
      // least-squares T is sum(m*s) / sum(m*m). Recovers 16.70 from a 16.2
      // seed, and 6.944 from the 13.89/20.83 pair a 144 Hz panel presents.
      let sm = 0, smm = 0;
      for (let i = 0; i < n; i++) {
        const m = Math.round(samples[i] / T);
        if (m >= 1 && Math.abs(samples[i] - m * T) <= tol) { sm += m * samples[i]; smm += m * m; }
      }
      displayTick = smm > 0 ? sm / smm : T;
      return;
    }
    // Nothing fits: the frame is free-running, or the compositor is not pacing
    // us. Leave the previous estimate rather than inventing one.
  }

  /**
   * The frame time to actually aim at: the fastest rung that still meets the
   * target. Falls back to the raw budget when the tick is unknown, and also
   * when no rung at all fits under the budget — that second case matters,
   * because a window in which every frame is (say) a clean 20.8 ms estimates
   * the tick AS 20.8, and treating that as the aim would stop the descent that
   * is about to reveal the real fundamental.
   */
  function lockMs() {
    const b = budget();
    if (!displayTick) return b;
    // +2% of a tick so an exact multiple (60 Hz: 16.667 / 16.667) cannot land
    // on 0.99999 and floor to the rung below.
    const k = Math.floor((b + displayTick * 0.02) / displayTick);
    return k >= 1 ? k * displayTick : b;
  }

  /** The first few rungs, for diagnostics and for choosing a target. */
  const ladder = () => (displayTick
    ? [1, 2, 3, 4].map((k) => +(k * displayTick).toFixed(2)) : null);

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

  // --- "a tool is driving this page" ----------------------------------------
  // `window.__setAuto(false)` pauses the simulation, and every capture tool in
  // tools/ does exactly that before it starts stepping and screenshotting. A
  // paused sim is not a gameplay frame, so the controller has no business acting
  // on its frame time — and acting is actively harmful: a step reallocates ~12
  // postfx render targets, and doing that while `Page.captureScreenshot` is in
  // flight makes `shoot.mjs --dpr 2` time out and fail. (Found by running it.)
  //
  // `main.js` installs `__setAuto` after `createEngine` returns, so the hook is
  // installed lazily on the first rAF tick and is one boolean test thereafter.
  // This keeps shoot.mjs and flyby.mjs correct without either of them — files
  // this module does not own — having to know the controller exists.
  let simPaused = false;
  let setAutoHooked = false;
  function hookSetAuto() {
    if (setAutoHooked || typeof window === 'undefined') return;
    if (typeof window.__setAuto !== 'function') return;
    const orig = window.__setAuto;
    window.__setAuto = (v) => { simPaused = !v; return orig(v); };
    setAutoHooked = true;
  }
  const _v2 = new THREE.Vector2();

  // Observed cost per ladder step, for the up-step prediction below. Timestamped
  // and aged out: a reading taken under load must not outlive the load.
  const obsMs = new Float32Array(STEPS.length).fill(-1);
  const obsMpx = new Float32Array(STEPS.length).fill(-1);
  const obsAt = new Float64Array(STEPS.length);
  const OBS_TTL_MS = 4000;
  // Backoff per ladder index, set when we step DOWN out of it. Without this the
  // "probe upward when censored" path below hunts: 0.7 reads 16.7 (censored) ->
  // step up to 0.8 -> 20 ms -> step down to 0.7 -> repeat every few seconds, and
  // the image visibly breathes. A step down is evidence that that index was too
  // expensive a moment ago; respect it for a while, then let it be retried.
  const upBlockUntil = new Float64Array(STEPS.length);
  // 8 s was enough to stop the original 0.7 <-> 0.8 flip-flop, but a real run
  // crosses cost boundaries with the TERRAIN — the forest belt is dearer than
  // the open piste — so an 8 s retry re-probed a known-expensive rung several
  // times per descent, and every hop reallocates ~12 render targets (a visible
  // hitch) and visibly changes sharpness. A rung that was too expensive stays
  // distrusted for 20 s; the terrain the player is on changes slower than that.
  const UP_BACKOFF_MS = 20000;
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
   * Predicted frame cost at `i`, in ms, or `null` when the inputs are censored
   * and no honest prediction exists.
   *
   * Prefers a two-point fit through steps actually observed RECENTLY — the frame
   * is `fixed + slope * Mpx` and both terms are real (roughly 8-12 ms fixed and
   * 3-5 ms/Mpx over 1.4-5.8 Mpx on this build).
   *
   * TWO THINGS THAT MADE THIS BLOCK EVERY UP-STEP AT THE SHIPPED TARGET:
   *
   * 1. Observations never expired. The reading stored at a ladder index is the
   *    p70 recorded while passing THROUGH it, which is by construction a value
   *    that was over budget — that is why it stepped down. Measured: `predictUp`
   *    frozen at 25.3 ms for 24 s while the real frame was 16.7 ms. They now
   *    carry a timestamp and are ignored after OBS_TTL_MS.
   *
   * 2. A vsync-locked `curMs` carries NO information about headroom. At 16.7 ms
   *    on a 60 Hz display the GPU may have taken 3 ms or 16 ms; the presented
   *    interval cannot tell you which. Scaling it by the pixel ratio — the old
   *    fallback — therefore invents a number: 16.7 * (0.8/0.7)^2 = 21.8 ms,
   *    which exceeds any budget at 60 fps and blocks the step forever. When the
   *    frame is sitting on the refresh period this returns `null`, meaning
   *    "unknowable", and the caller probes upward instead. That is what a
   *    dynamic-resolution ladder is for, and it is safe precisely because the
   *    down-step is reliable.
   */
  function predictMs(i, curMs, now) {
    const fresh = (k) => obsMs[k] >= 0 && (now - obsAt[k]) < OBS_TTL_MS;
    if (fresh(i)) return obsMs[i];
    let lo = -1, hi = -1;
    for (let k = 0; k < STEPS.length; k++) {
      if (!fresh(k)) continue;
      if (lo < 0 || obsMpx[k] < obsMpx[lo]) lo = k;
      if (hi < 0 || obsMpx[k] > obsMpx[hi]) hi = k;
    }
    const target = mpxAt(i);
    if (lo >= 0 && hi >= 0 && obsMpx[hi] - obsMpx[lo] > 0.25) {
      const slope = (obsMs[hi] - obsMs[lo]) / (obsMpx[hi] - obsMpx[lo]);
      const fixed = obsMs[lo] - slope * obsMpx[lo];
      return Math.max(curMs, fixed + slope * target);
    }
    // NO FALLBACK. There used to be one — `curMs * (target / mpxNow())`, i.e.
    // "assume the frame is entirely fragment-bound" — guarded by a test for
    // whether `curMs` was sitting on the refresh period. Both the fallback and
    // its guard were wrong, and the guard was the same defect as `b*0.80` and
    // `b*0.95` arriving by a third route: a threshold that a vsync-locked frame
    // has to satisfy, derived from a running minimum that could slide underneath
    // it. Measured drifting 16.7 -> 15.1 inside a minute, and below ~15.7 the
    // guard could never fire again and the controller became a one-way ratchet
    // for the rest of the session, silently.
    //
    // The fallback is unsound in the first place, which is why the guard existed
    // and why deleting both is the real fix. THE PRESENTED INTERVAL IS ALWAYS
    // QUANTISED: in headless Chrome the begin-frame tick is 8.33 ms and every
    // clean interval observed is an integer multiple of it (16.7, 25.0, 33.3,
    // 41.7, 50.0, 58.3, 66.7). A frame is never presented at its true cost, only
    // at the next tick boundary at or after it — so `curMs` is an upper bound on
    // an unknown value, and scaling an upper bound by a pixel ratio invents a
    // number. There is no threshold that makes that sound.
    //
    // So: with no fresh measurement of the target rung and no two-point fit, the
    // honest answer is "unknown", and the caller probes. That is a decision the
    // ladder can undo; a fabricated prediction is not.
    return null;
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
    hookSetAuto();
    if (!firstFrameAt) firstFrameAt = now;
    if (now - firstFrameAt < START_GRACE_MS) return;
    if (!adaptive || freezeDepth > 0 || simPaused) return;
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

    const bootPhase = now - firstFrameAt < START_GRACE_MS + BOOT_PHASE_MS;
    const effWindow = bootPhase ? BOOT_WINDOW : WINDOW;
    samples[sampleAt++ % WINDOW] = now - prev;
    if (nSamples < WINDOW) nSamples++;
    if (nSamples < effWindow || now - lastChange < HOLD_MS) return;

    const b = budget();
    // p70/p30 rather than a mean: the mean is dragged around by the vsync mode
    // lock (CLAUDE.md trap 1) while a persistent miss shows up across the whole
    // distribution regardless of which mode the compositor is holding.
    const p70 = pct(nSamples, 0.70);
    const p30 = pct(nSamples, 0.30);
    // Every threshold below is measured against the RUNG, not the budget. On a
    // 60 or 120 Hz panel these are the same number; on 144 Hz they are not, and
    // aiming at a frame time the display cannot present is what made the
    // controller hunt. See the `displayTick` block above.
    estimateTick(nSamples);
    const lock = lockMs();
    // A rung is judder when the window straddles it. The old constant was
    // `b * 1.2` = 20 ms, justified as "between the ticks of both a 60 Hz and a
    // 120 Hz panel" — true for those two, false at 144 Hz where 20.83 IS a
    // rung. Half a tick above the aim is the same idea expressed in the unit
    // that actually governs it, and it reproduces the old value closely on the
    // panels the old value was measured on (120 Hz: 20.83 against 20.0).
    const lateAbove = displayTick ? lock + displayTick * 0.5 : b * 1.2;
    // Record what this step actually costs, for predictMs(), WITH a timestamp.
    obsMs[idx] = p70;
    obsMpx[idx] = mpxNow();
    obsAt[idx] = now;

    // The up-step limit must be satisfiable BY A VSYNC-LOCKED FRAME. It was
    // `b * 0.95` = 15.83 ms at 60 fps, which is below the 16.67 ms refresh
    // period — the identical error to the `b * 0.80` it replaced, one level
    // down. It matches the `meeting` test now.
    const upLimit = lock * 1.02;
    const predUp = idx > 0 ? predictMs(idx - 1, p70, now) : null;

    // Every decision is recorded, not just the ones that move, so "why did it not
    // step" is answerable from `gfx.info().lastDecision` instead of by guessing.
    lastDecision = {
      t: Math.round(now), idx, scale: resolutionScale, mpx: +mpxNow().toFixed(3),
      budget: +b.toFixed(2), p70: +p70.toFixed(2), p30: +p30.toFixed(2),
      // What the thresholds are really measured against, and the ladder it came
      // from. `lock` differing from `budget` means this is a panel whose refresh
      // does not divide the target — read the ladder before trusting any fps.
      tick: displayTick ? +displayTick.toFixed(2) : null,
      lock: +lock.toFixed(2),
      // Reported so the tick structure is visible in a log: every clean value
      // here is an integer multiple of the measured tick (8.33 ms in headless
      // Chrome, whatever the panel says elsewhere).
      tickMultiple: +(p70 / (displayTick || 8.3333)).toFixed(2),
      downTest: p70 > lock * 1.12 && p30 > lock * 1.05,
      // fraction of the window landing a whole tick late — the judder signal
      lateFrac: +(Array.prototype.reduce.call(samples.subarray(0, nSamples),
        (a, v) => a + (v > lateAbove ? 1 : 0), 0) / nSamples).toFixed(2),
      atFloor: idx >= maxStep(),
      meeting: p70 <= lock * 1.02,
      predictUp: predUp === null ? 'censored' : +predUp.toFixed(2),
      predictLimit: +upLimit.toFixed(2),
      upBlockedMs: idx > 0 ? Math.max(0, Math.round(upBlockUntil[idx - 1] - now)) : 0,
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
    //
    // THE JUDDER TEST, second clause. On a 120 Hz panel (every ProMotion Mac)
    // the presented interval quantises to 8.33 ms ticks, so a rung whose true
    // cost is 17-18 ms presents as an alternating 16.7 / 25.0 mix — visible
    // judder — and the percentile test cannot see it: p70 reads 25 (over) but
    // p30 reads 16.7 (under), so the controller PARKED there, juddering,
    // indefinitely. Measured in headed Brave on the 16" MBP: rung 0.6 in the
    // forest belt reads exactly that mix. The test that closes the dead zone
    // is a FRACTION, not a percentile: if more than a third of the window
    // lands a whole tick late (> b * 1.2 = 20 ms at 60 fps — a value that
    // sits between the ticks of both a 60 Hz and a 120 Hz panel, so a clean
    // 16.7 lock can never trip it), the rung is producing judder and is too
    // expensive, whatever p30 says.
    // 0.25, down from a first cut at 0.35: measured in headed Brave, rung 0.6
    // on the early piste hovered at 25-34% late — mean interval ~19 ms,
    // plainly choppy to look at — and sat under the 0.35 gate for ten seconds.
    // A clean 60 lock reads 0% late, so the risk of lowering the gate is only
    // spurious down-steps on compositor flutter, which the up-path undoes.
    let late = 0;
    for (let k = 0; k < nSamples; k++) if (samples[k] > lateAbove) late++;
    const judder = late / nSamples > 0.25;
    if ((p70 > lock * 1.12 && p30 > lock * 1.05) || judder) {
      if (idx < maxStep()) {
        // BOOT CALIBRATION: during the first seconds after the grace period the
        // start rung (capped at INIT_MPX, not measured) can be several rungs
        // over budget, and walking down one rung per window is 3-4 render-target
        // reallocations — each a visible hitch — plus ~10 s of 25-30 ms frames
        // as the player's FIRST IMPRESSION of the game. While inside the boot
        // phase, jump one extra rung per ~5 ms of measured overshoot in ONE
        // step (one reallocation). This is not a fabricated prediction in the
        // trap-5 sense: it is deliberately conservative in the safe direction,
        // and the next window corrects it — downward overshoot is exactly the
        // error the reliable up-path exists to undo.
        const extra = bootPhase ? Math.floor(Math.max(0, p70 - lock) / 5) : 0;
        next = Math.min(maxStep(), idx + 1 + extra);
        // This index was too expensive a moment ago. Don't come straight back.
        upBlockUntil[idx] = now + UP_BACKOFF_MS;
      }
      upVotes = 0;
    } else if (idx > 0) {
      // UP. The old test asked for the interval to be 20% UNDER budget
      // (`b * 0.80` = 13.33 ms at 60 fps), which is below the refresh period and
      // therefore unsatisfiable while frames are presenting. The question is not
      // "is the frame under budget", which vsync forbids; it is "is the frame
      // MEETING vsync, and would it still meet it after paying for the pixels".
      const meeting = p70 <= lock * 1.02;
      // ┌─────────────────────────────────────────────────────────────────────┐
      // │ `predUp === null ||` IS THE LOAD-BEARING CLAUSE AT 60 Hz. DO NOT     │
      // │ REMOVE IT. Every up-step at the shipped 60 fps target goes through   │
      // │ it and never evaluates `upLimit` at all, because a frame that is     │
      // │ `meeting` at 60 fps is by definition pinned to the tick and so has   │
      // │ no prediction. `upLimit` only bites below ~59 fps.                   │
      // │                                                                      │
      // │ Consequence for anyone refactoring: reverting `upLimit` from b*1.02  │
      // │ back to b*0.95 leaves the whole regression suite GREEN while         │
      // │ restoring the ratchet for every target under 59 fps. Verified by     │
      // │ mutation. The case that catches THIS clause is `step-up-at-60`;      │
      // │ mutating it to `predUp !== null && predUp <= upLimit` turns that     │
      // │ case red with the original round-2 signature.                        │
      // └─────────────────────────────────────────────────────────────────────┘
      // null means "no recent measurement of that rung and no fit", i.e. the
      // cost there is genuinely unknown — see predictMs. Probing is the only way
      // to find out, and it is safe because the down-step is reliable and the
      // backoff stops it hunting.
      const affordable = predUp === null || predUp <= upLimit;
      const blocked = now < upBlockUntil[idx - 1];
      // TWO consecutive agreeing windows before going up. Stepping up is the
      // risky direction — it can immediately re-trigger a step down, and the
      // observed failure mode was 0.8 -> 0.9 -> 0.8 -> 0.7 inside 12 s when
      // background load moved p70 from 33 to 75 ms. Down-steps stay
      // single-window, because being slow is the condition that matters.
      if (meeting && affordable && !blocked) upVotes++;
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
      obsMs.fill(-1); obsMpx.fill(-1); obsAt.fill(0); upBlockUntil.fill(0);
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
        obsMs.fill(-1); obsMpx.fill(-1); obsAt.fill(0); upBlockUntil.fill(0);
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
      obsMs.fill(-1); obsMpx.fill(-1); obsAt.fill(0); upBlockUntil.fill(0);
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
        simPaused,
        _nSamples: nSamples,
        _graceMs: firstFrameAt ? Math.round(performance.now() - firstFrameAt) : -1,
        _explicitPixelRatio: explicitPixelRatio,
        // Derived, never stored — see `nearestStep`.
        adaptiveStep: nearestStep(resolutionScale),
        adaptiveSteps: STEPS,
        adaptiveMaxStep: maxStep(),
        adaptiveEvents,
        adaptiveLog: stepLog.slice(-12),
        lastDecision,
        minResolutionScale: minScale,
        targetFps,
        // The panel this session is actually being presented on, and the frame
        // times it can present. `lockMs` is what the controller aims at; when it
        // differs from `1000/targetFps` the target is not on this panel's ladder
        // and the reachable rates are `1000 / ladder[k]`, nothing in between.
        displayTick: displayTick ? +displayTick.toFixed(3) : null,
        displayHz: displayTick ? +(1000 / displayTick).toFixed(1) : null,
        vsyncLadder: ladder(),
        lockMs: +lockMs().toFixed(2),
      };
    },
  };

  requestAnimationFrame(sampleLoop);

  return { renderer, scene, camera, gfx };
}
