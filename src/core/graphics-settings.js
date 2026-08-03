/**
 * Alpine — graphics settings MODEL.
 *
 * The knob registry, the presets, the apply logic and the persistence. There is
 * NO DOM in this file and there must never be: `src/ui/settings.js` renders the
 * panel purely from `registry` + `describe(id)` + `readouts()`, so the panel has
 * no idea what a megapixel or a vsync rung is and this file has no idea what a
 * `<div>` is. That seam is the reason a knob can be added here in one object
 * literal and appear in the UI with no UI change at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS ALLOWED TO CLAIM
 * ---------------------------------------------------------------------------
 * Every descriptor carries a `cost` field, and it is not decoration:
 *
 *     'gpu'   measured to change the frame, on this build, with a citation
 *     'cpu'   changes CPU/update work or draw submission
 *     'look'  changes the image and NOTHING ELSE — no branch, no pass, no
 *             geometry. It buys zero frames.
 *     'ui'    overlay / audio, outside the render entirely
 *
 * The distinction is load-bearing, and it is why THE PRESETS ONLY MOVE KNOBS
 * WHOSE COST IS NOT 'look'. A "low" preset that turns the snow sparkle down is
 * a lie: `uSparkle` is a multiplier on a term that is computed either way
 * (snow-material.js:1943 — no branch), so the frame is bit-for-bit the same
 * speed and the player has paid for nothing with their image quality. Look
 * knobs are in the panel because players want them; they are marked, and a
 * preset leaves them alone. `presetInvariant: true` says so per knob.
 *
 * CLAUDE.md's traps are the reason this file is shaped the way it is:
 *
 *  - trap 8: NEVER an fps counter. The presented interval is quantised to
 *    multiples of the refresh period, so "42 fps" does not exist — it is two
 *    rungs alternating. `info().frame` reports the RUNG, and it does so from
 *    `gfx.info().lastDecision`, i.e. from the measurement the resolution
 *    controller is already taking. This file adds no sampler of its own.
 *  - trap 6: `renderer.info.render.*` is reset at the top of every
 *    `renderer.render()`, and the post chain makes a dozen a frame, so it reads
 *    the last fullscreen quad. Triangles here are counted off the scene graph
 *    (`sceneTriangles()`), throttled, or taken from `terrain.meshInfo()`.
 *  - trap 5 / engine.js rule 1: a resolution change reallocates ~12 post
 *    targets, so it is applied LAST, bracketed in `gfx.freeze()`, and NOTHING
 *    is applied at all while `__harness.perf.recording` is true.
 *
 * ---------------------------------------------------------------------------
 * PERSISTENCE — and why it is a hazard rather than a convenience
 * ---------------------------------------------------------------------------
 * Every capture tool in `tools/` boots the real page. A stale "low" preset in
 * localStorage would therefore silently change `shoot.mjs`' screenshots and make
 * CLAUDE.md's measured quality-baseline table unreproducible — a whole class of
 * phantom regression, arriving from a place nobody would think to look. So:
 *
 *   - the key is versioned (`alpine.gfx.v1`); a schema mismatch DROPS the
 *     document and re-derives from defaults rather than trying to migrate;
 *   - nothing is written until the player changes something. A fresh profile has
 *     no key, boots on `auto`, and `applyAll()` writes NOTHING to any subsystem
 *     (see `applied`), so the build is bit-identical to one without this file;
 *   - **`?gfx=default` bypasses the stored document entirely.** That is the
 *     escape hatch for any tool or any bug report: add it and you are looking at
 *     the shipped configuration whatever is in storage. `?gfx=off` is a synonym.
 *   - every single storage access is inside try/catch. Puppeteer partitions
 *     storage and Safari throws on `localStorage` in some private modes; a throw
 *     at module scope here would take `harness.ready` down with it and every
 *     capture tool in the repo would fail with a blank page.
 *
 * Precedence is **query string > stored document > preset default**. `engine.js`
 * treats `?rscale=`, `?rfloor=`, `?adaptive=`, `?fpstarget=` and `?maxdpr=` as
 * explicit instructions, so a knob whose parameter is present is marked
 * `overriddenBy` and is never applied — the panel shows it as externally set
 * instead of fighting the URL and losing.
 *
 * ---------------------------------------------------------------------------
 * FEATURE DETECTION
 * ---------------------------------------------------------------------------
 * Every subsystem, and every method on it, is optional. Three of the biggest
 * levers in the registry (`terrain.setShaderQuality`, `terrain.setMeshQuality`,
 * `terrain.setShadowRings`) plus `postfx.setQuality` and `sky.setShadowQuality`
 * are being added by other people; this file must work today, with whatever
 * exists, and pick them up the moment they land. So availability is re-tested on
 * every read (`avail(s)`) rather than snapshotted at construction, and an
 * unavailable knob is reported to the UI with a reason instead of being hidden —
 * a knob that silently disappears is indistinguishable from one that never
 * existed.
 *
 * ---------------------------------------------------------------------------
 * REJECTED KNOBS — do not add these back without re-reading the code
 * ---------------------------------------------------------------------------
 * Every one of these was on the list of "verified working" knobs handed to this
 * file. One CRASHES, two would trade a documented quality baseline for an
 * unmeasured saving, one saves nothing and breaks the chairlift, and one is
 * gameplay geometry. Written down so the next person does not have to find out
 * the same way.
 *
 *  - **`scatter.riders.length = N`. This crashes.** `seedRiders()`
 *    (scatter.js:5973) iterates `for (let i = 0; i < RIDERS; i++)` against the
 *    module-level constant `RIDERS = 12`, not against `riders.length`, and
 *    dereferences `riders[i].rest` — so with the array truncated the next cut
 *    (a teleport, `harness.setPlayer`, a respawn, or the very first frame)
 *    throws `TypeError: Cannot read properties of undefined`. Line 5989 does the
 *    same through `pairFollower(riders[i - 1])`. A rider-count knob needs a
 *    `setRiderCount()` inside `scatter.js` that moves `RIDERS` with it; it
 *    cannot be done from outside.
 *  - `terrain.snowUniforms.uForestAmount = 0` does skip a real block of five
 *    fbm octaves (snow-material.js:1797 branches on it) — and it deletes the
 *    distant canopy, which is two rows of CLAUDE.md's quality baseline
 *    ("distant conifer band RGB (43,58,68)", "treeline ÷ adjacent snow 0.36").
 *    A knob that trades a documented baseline for an unmeasured saving is not a
 *    quality setting.
 *  - `uRockAmount = 0` gates the entire rock path (`snRockOn`,
 *    snow-material.js:662) and is therefore a genuine GPU lever — and it turns
 *    the massif into a snowdrift. Not shippable at any tier.
 *  - `scatter.uniforms.uMinR` is a screen-space MINIMUM WIDTH for thin props,
 *    not an LOD threshold: it inflates sub-pixel geometry so a 6 cm haul rope
 *    stops shimmering (scatter.js:3355). Lowering it makes the chairlift cable
 *    vanish and the chairs hang in mid-air. It culls nothing.
 *  - `draglift.group.visible` is gameplay geometry (you ride the thing), and
 *    hiding it hits CLAUDE.md trap 3 anyway: `visible = false` ablations get
 *    SLOWER whenever hiding an object exposes what is behind it.
 */

// ---------------------------------------------------------------------------
// Small helpers. No allocation in anything called per frame — nothing here is.
// ---------------------------------------------------------------------------
const STORE_KEY = 'alpine.gfx.v1';
const SCHEMA = 1;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Is `k` a callable method on `o`? The one test the whole file leans on. */
const isFn = (o, k) => typeof o?.[k] === 'function';
const near = (a, b) => Math.abs(a - b) < 1e-6;
/** Read something off a subsystem that may not have it, at module scope. */
const safeGet = (fn) => { try { return fn(); } catch (e) { return undefined; } };

/** Snap to the descriptor's step grid, then clamp. Keeps 0.7 from being 0.7000001. */
function snap(v, d) {
  const step = d.step || 0.01;
  const n = Math.round((v - d.min) / step) * step + d.min;
  return +clamp(n, d.min, d.max).toFixed(6);
}

/**
 * Where a frame time sits on the display's vsync ladder — the ONLY honest way
 * to describe frame pacing in this project (CLAUDE.md trap 8). Same shape as
 * `debug-perf.js`' `rungOf`, deliberately re-implemented rather than imported:
 * that module is dev-only and is stripped from a production build.
 */
function rungOf(ms, tick) {
  if (!(tick > 0) || !(ms > 0)) return null;
  const k = Math.max(1, Math.round(ms / tick));
  const at = k * tick;
  return { k, at: +at.toFixed(2), hz: +(1000 / at).toFixed(1), clean: Math.abs(ms - at) < tick * 0.18 };
}

// ---------------------------------------------------------------------------
// Storage. Every access wrapped — see the header.
// ---------------------------------------------------------------------------
const store = {
  read() {
    try {
      const raw = globalThis.localStorage?.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },
  write(obj) {
    try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  },
  clear() {
    try { globalThis.localStorage?.removeItem(STORE_KEY); return true; }
    catch (e) { return false; }
  },
};

// ---------------------------------------------------------------------------
// Groups. Order here is the order the panel renders them in.
// ---------------------------------------------------------------------------
const GROUPS = [
  {
    id: 'res', title: 'Resolution',
    note: 'The only continuous lever in the frame, and by a wide margin the largest: '
      + '~2.5 ms per megapixel on a ~8.7 ms floor, measured on the real 2560x1440 DPR-2 target.',
  },
  {
    id: 'post', title: 'Post-processing',
    note: 'Scales with the backbuffer, so the old "3.5 ms" figure was a 5.76 Mpx number and is '
      + 'several times that on a 14.7 Mpx display. Still smaller than the terrain snow shader.',
  },
  {
    id: 'world', title: 'World detail',
    note: 'The terrain snow shader alone is over half of all scene shading cost.',
  },
  { id: 'shadow', title: 'Shadows', note: 'Two extra depth passes, and PCF taps in every lit fragment.' },
  { id: 'fx', title: 'Effects', note: '' },
  { id: 'ui', title: 'Interface', note: '' },
];

// ---------------------------------------------------------------------------
// THE REGISTRY
//
// Descriptor fields:
//   id, group, label, hint      identity and the one-line why
//   type                        'bool' | 'range' | 'enum'
//   min/max/step/fmt            for 'range'
//   options / optionsOf(s)      for 'enum'; [{ v, label }]
//   defOf(s)                    the SHIPPED value, read off the live subsystem
//                               wherever possible so `auto` is provably inert
//   guessed                     true when defOf could not read the real value
//   cost                        'gpu' | 'cpu' | 'look' | 'ui'   (see header)
//   hitch                       true if applying it stalls a frame or more
//   reload                      true if it can only take effect on a page load
//   toQuery(v)                  [name, value] for the reload queue
//   qs                          query params that OVERRIDE this knob
//   avail(s)                    feature detection; false ⇒ shown, disabled
//   why                         why it is unavailable, for the panel
//   apply(v, s)                 write it to the live scene. MUST be idempotent.
//   liveOf(s)                   the actual live value, when it can differ from
//                               the setting (adaptive resolution)
//   macro(v)                    a patch applied to OTHER knobs (tier knobs)
//   presetInvariant             presets leave it alone
// ---------------------------------------------------------------------------
const REGISTRY = [
  // ======================================================================
  // Resolution
  // ======================================================================
  {
    id: 'adaptiveRes', group: 'res', label: 'Adaptive resolution', type: 'bool',
    cost: 'gpu', qs: ['adaptive'],
    hint: 'Lets engine.js drive the resolution off the frame time. It only ever moves when frames are '
      + 'already being missed, and it can come back up. Off pins whatever scale is current.',
    defOf: (s) => (isFn(s.gfx, 'info') ? !!s.gfx.info().adaptive : true),
    avail: (s) => isFn(s.gfx, 'setAdaptive'),
    apply(v, s) { if (isFn(s.gfx, 'setAdaptive')) s.gfx.setAdaptive(v); },
  },
  {
    // CONSTRAINT: with the controller ON this is a FLOOR, not a setting.
    // `gfx.setResolutionScale`'s own docstring warns the controller may climb
    // above whatever you set, so the label says "minimum" and the panel shows
    // the live actual scale next to it (`liveOf`).
    //
    // A lower bound is not a target, and the two directions are therefore NOT
    // symmetric:
    //
    //   - LOWERING it must not drop the resolution. "Render no worse than 50%"
    //     is permission, not an instruction, and a fast machine that grants the
    //     permission should keep rendering at native. (The `low` preset gives
    //     immediate relief through `maxDpr` instead, which on a Retina panel is
    //     a 4x fragment cut and is not a lower bound at all.)
    //   - RAISING it above what is currently being rendered has to act at once,
    //     and it cannot be left to `setMinResolutionScale`: engine.js pulls the
    //     scale to `STEPS[maxStep()]` there, which is the DEEPEST rung the floor
    //     allows rather than the shallowest, and under the megapixel relaxation
    //     that can be the rung it was already on. Verified against the engine:
    //     raising the floor 0.5 -> 0.7 can leave the render at 0.5.
    //
    //     It hands the ladder back at NATIVE (`resetAdaptive`) rather than
    //     pinning it at the new floor, because pinning at a lower bound is not
    //     what a lower bound means — that is exactly the boot state, and the
    //     controller then finds the rung the way it always does.
    //
    // Both of those are conditional on the SETTING having moved (`ctx.changed`).
    // A forced re-assert must not fight the controller: it is legitimately
    // allowed below this knob's value by engine.js' FLOOR_MPX relaxation, and
    // yanking it back to native on every `applyAll({ force: true })` would
    // silently undo a decision it had just made for good reasons.
    id: 'resolution', group: 'res', label: 'Minimum resolution', type: 'range',
    min: 0.4, max: 1.0, step: 0.1, cost: 'gpu', hitch: true,
    // Applied dead last of everything, after the rest of the resolution group.
    // `setMaxPixelRatio` reallocates the backbuffer too, so doing this one first
    // would pay for the ~12 post-target reallocation twice, and this is the one
    // that also resets the TAA history.
    phase: 2,
    qs: ['rscale', 'rfloor'],
    fmt: (v) => Math.round(v * 100) + '%',
    hint: 'Linear scale, so pixels go as its square: 0.7 renders 49% of them. The ladder engine.js walks is '
      + '1.0 / 0.9 / 0.8 / 0.7 / 0.6 / 0.5 / 0.4. Changing it reallocates ~12 render targets and resets the '
      + 'TAA history, so expect one hitch and a few aliased frames.',
    defOf: (s) => (isFn(s.gfx, 'info') ? s.gfx.info().minResolutionScale : 0.7),
    liveOf: (s) => (isFn(s.gfx, 'info') ? s.gfx.info().resolutionScale : undefined),
    avail: (s) => isFn(s.gfx, 'setResolutionScale') || isFn(s.gfx, 'setMinResolutionScale'),
    apply(v, s, ctx) {
      const g = s.gfx;
      if (!g) return;
      const info = isFn(g, 'info') ? g.info() : null;
      const adaptive = info ? !!info.adaptive : false;
      const live = info ? info.resolutionScale : 1;
      if (!adaptive) {
        // Controller off: the knob is a hard pin. `setResolutionScale` early-outs
        // on an unchanged value, so this stays idempotent.
        if (isFn(g, 'setResolutionScale')) g.setResolutionScale(v);
      } else if (ctx?.changed && live < v - 1e-6) {
        if (isFn(g, 'resetAdaptive')) g.resetAdaptive();
        else if (isFn(g, 'setResolutionScale')) g.setResolutionScale(v);
      }
      if (isFn(g, 'setMinResolutionScale')) g.setMinResolutionScale(v);
    },
  },
  {
    // CONSTRAINT: on a high-refresh panel this is a REAL choice, not a
    // formality. 60 forces the 13.89 ms rung on a 144 Hz display and therefore
    // a low resolution; 48 takes the 20.83 ms rung and buys the pixels back for
    // a lock that is just as smooth. So the options are built from the panel's
    // OWN ladder (`gfx.info().vsyncLadder`), measured this session, rather than
    // from a list of round numbers.
    id: 'fpsTarget', group: 'res', label: 'Frame rate target', type: 'enum',
    cost: 'gpu', qs: ['fpstarget'], presetInvariant: true, numeric: true,
    hint: 'What the adaptive controller aims at. It aims at the fastest vsync RUNG that still meets this, '
      + 'because a frame time between rungs presents as two rungs alternating — which is what "the '
      + 'performance is bad" usually describes. Rungs marked below are this display’s own.',
    defOf: (s) => (isFn(s.gfx, 'info') ? s.gfx.info().targetFps : 60),
    avail: (s) => isFn(s.gfx, 'setTargetFps'),
    optionsOf(s) {
      const info = isFn(s.gfx, 'info') ? s.gfx.info() : null;
      const seen = new Set();
      const out = [];
      const push = (fps, label) => {
        const n = Math.round(fps);
        if (!(n >= 15 && n <= 240) || seen.has(n)) return;
        seen.add(n);
        out.push({ v: n, label });
      };
      const lad = info && info.vsyncLadder;
      if (lad) for (const ms of lad) push(1000 / ms, Math.round(1000 / ms) + ' fps · ' + ms.toFixed(1) + ' ms rung');
      for (const n of [120, 90, 72, 60, 48, 40, 30]) push(n, n + ' fps');
      out.sort((a, b) => b.v - a.v);
      return out;
    },
    apply(v, s) { if (isFn(s.gfx, 'setTargetFps')) s.gfx.setTargetFps(v); },
  },
  {
    id: 'maxDpr', group: 'res', label: 'Pixel density cap', type: 'enum',
    cost: 'gpu', hitch: true, qs: ['maxdpr'], numeric: true,
    options: [
      { v: 1, label: '1× — 1.44 Mpx at 1600×900' },
      { v: 1.25, label: '1.25×' },
      { v: 1.5, label: '1.5×' },
      { v: 2, label: '2× — native on a Retina panel' },
    ],
    hint: 'Caps devicePixelRatio. A Retina Mac renders 4× the fragments of the 1600×900 every '
      + 'measurement in this project’s history was taken at, and every post target is sized from the '
      + 'drawing buffer, so this scales the whole post chain with it.',
    defOf: (s) => (isFn(s.gfx, 'info') ? s.gfx.info().maxPixelRatio : 2),
    avail: (s) => isFn(s.gfx, 'setMaxPixelRatio'),
    apply(v, s) { if (isFn(s.gfx, 'setMaxPixelRatio')) s.gfx.setMaxPixelRatio(v); },
  },
  {
    // The one knob that cannot be applied live: `antialias` is a WebGL CONTEXT
    // ATTRIBUTE, fixed when the context is created. It goes in the reload queue
    // and comes back as `?aa=1`, which engine.js already reads.
    //
    // Preset-invariant on purpose: presets must not be able to queue a reload
    // behind the player's back, and a session booted with `?aa=1` (a debug
    // ablation) must not have it silently taken away by picking "High".
    id: 'antialias', group: 'res', label: 'MSAA backbuffer', type: 'bool',
    cost: 'gpu', reload: true, presetInvariant: true,
    hint: 'Off by design: the scene is never drawn to the default framebuffer, so MSAA can only antialias '
      + 'the final fullscreen quad — two triangles with no interior edges. Spatial AA is TAA (or SMAA '
      + 'when TAA is off). Only useful as a debug ablation, and it needs a page reload.',
    defOf: (s) => (isFn(s.gfx, 'info') ? !!s.gfx.info().antialias : false),
    avail: () => true,
    toQuery: (v) => ['aa', v ? '1' : '0'],
    apply() { /* reload-only; see applyReload() */ },
  },

  // ======================================================================
  // Post-processing
  // ======================================================================
  {
    // Tier knob. `postfx.setQuality` is being added by another agent right now;
    // until it lands the fallback below does what can be done from outside,
    // which is the master bypass plus the four `.enabled` flags. Those are
    // pushed to uniforms every frame, so writes take effect immediately.
    id: 'postQuality', group: 'post', label: 'Post-processing', type: 'enum',
    cost: 'gpu',
    options: [
      { v: 'off', label: 'Off — bypass, no grade, no AA' },
      { v: 'low', label: 'Low' },
      { v: 'medium', label: 'Medium' },
      { v: 'high', label: 'High' },
      { v: 'ultra', label: 'Ultra — uncapped depth of field' },
    ],
    hint: '"Off" is the master bypass: the scene goes straight to the default framebuffer with no tone '
      + 'grade and no antialiasing at all, so it looks wrong as well as cheap. The 3.5 ms figure once '
      + 'quoted here was measured at 5.76 Mpx; the chain scales with the backbuffer, so on a 14.7 Mpx '
      + 'display it is several times that. High vs Ultra is the far-field depth of field: Ultra lets its '
      + 'blur radius grow with resolution (3.3 px at 5K), High caps it at 2 px, which is what the effect '
      + 'was authored and reviewed at.',
    defOf: (s) => (isFn(s.postfx, 'getQuality') ? s.postfx.getQuality() : 'high'),
    guessed: (s) => !isFn(s.postfx, 'getQuality'),
    avail: (s) => !!s.postfx,
    // A tier is a macro over the individual flags: switching tiers rewrites
    // them, so the individual knobs (applied AFTER this one, by `order`) never
    // silently undo the tier they were just set from.
    // TAA is deliberately NOT in here, and postfx.js' own tier table leaves it
    // out for the same reason: it is the frame's only spatial AA, and switching
    // it off swaps two full-res passes for SMAA's rather than removing them.
    // Whether to run it is a look decision, not a rung on a quality ladder.
    //
    // Every tier from 'medium' up enables all three. Enumerating the tiers that
    // are ON, rather than testing for 'high', is what stops a new tier being
    // silently treated as the cheapest one — which is exactly what happened when
    // 'ultra' was added above and this line still read `v === 'high'`: the ultra
    // preset turned bloom, depth of field and motion blur OFF.
    macro: (v) => {
      const full = v === 'medium' || v === 'high' || v === 'ultra';
      return { bloom: full, dof: full, motionBlur: full };
    },
    apply(v, s) {
      if (!s.postfx) return;
      // Always assert the bypass ourselves. `setQuality` may or may not own it,
      // and a tier change that left `enabled === false` behind would look like
      // the whole post chain had died.
      const want = v !== 'off';
      if (s.postfx.enabled !== want) s.postfx.enabled = want;
      if (isFn(s.postfx, 'setQuality')) s.postfx.setQuality(v);
    },
  },
  {
    id: 'taa', group: 'post', label: 'Temporal AA', type: 'bool', cost: 'gpu',
    hint: 'The only spatial AA in the frame when it is on; SMAA takes over automatically when it is off. '
      + 'It is also the source of the tree shimmer (per-pixel temporal SD over the crowns: 6.95 codes with '
      + 'it on, 0.013 with it off) and it averages some of the snow spray away.',
    defOf: (s) => (s.postfx?.params?.taa ? !!s.postfx.params.taa.enabled : true),
    avail: (s) => !!s.postfx?.params?.taa,
    apply(v, s) { const p = s.postfx?.params?.taa; if (p && p.enabled !== v) p.enabled = v; },
  },
  {
    id: 'bloom', group: 'post', label: 'Bloom', type: 'bool', cost: 'gpu',
    hint: 'A five-mip pyramid. Thresholded at 2.6 exposed-linear so only speculars, the sun disc and ice '
      + 'glints bloom — never the snow field.',
    defOf: (s) => (s.postfx?.params?.bloom ? !!s.postfx.params.bloom.enabled : true),
    avail: (s) => !!s.postfx?.params?.bloom,
    apply(v, s) { const p = s.postfx?.params?.bloom; if (p && p.enabled !== v) p.enabled = v; },
  },
  {
    id: 'dof', group: 'post', label: 'Depth of field', type: 'bool', cost: 'gpu',
    hint: 'Autofocus on the skier, plus a far ramp that only starts at 260 m. One gather pass.',
    defOf: (s) => (s.postfx?.params?.dof ? !!s.postfx.params.dof.enabled : true),
    avail: (s) => !!s.postfx?.params?.dof,
    apply(v, s) { const p = s.postfx?.params?.dof; if (p && p.enabled !== v) p.enabled = v; },
  },
  {
    id: 'motionBlur', group: 'post', label: 'Motion blur', type: 'bool', cost: 'gpu',
    hint: 'A 1/125 s sports shutter, capped at 4 px, and flatly zero under 55 km/h. One gather pass.',
    defOf: (s) => (s.postfx?.params?.motion ? !!s.postfx.params.motion.enabled : true),
    avail: (s) => !!s.postfx?.params?.motion,
    apply(v, s) { const p = s.postfx?.params?.motion; if (p && p.enabled !== v) p.enabled = v; },
  },
  {
    id: 'sharpen', group: 'post', label: 'Sharpening', type: 'range',
    min: 0, max: 0.7, step: 0.02, cost: 'look', presetInvariant: true,
    fmt: (v) => v.toFixed(2),
    hint: 'In the film pass, and it is what carries the perceived resolution when the adaptive controller '
      + 'has stepped down. Free — the tap happens either way.',
    defOf: (s) => (s.postfx?.params?.film ? s.postfx.params.film.sharpen : 0.32),
    avail: (s) => !!s.postfx?.params?.film,
    apply(v, s) { const p = s.postfx?.params?.film; if (p && !near(p.sharpen, v)) p.sharpen = v; },
  },
  {
    id: 'grain', group: 'post', label: 'Film grain', type: 'range',
    min: 0, max: 0.03, step: 0.002, cost: 'look', presetInvariant: true,
    fmt: (v) => (v <= 0 ? 'off' : v.toFixed(3)),
    hint: 'Shadow-biased 1.6×. Free — a multiply on a hash that is computed either way.',
    defOf: (s) => (s.postfx?.params?.film ? s.postfx.params.film.grain : 0.012),
    avail: (s) => !!s.postfx?.params?.film,
    apply(v, s) { const p = s.postfx?.params?.film; if (p && !near(p.grain, v)) p.grain = v; },
  },

  // ======================================================================
  // World detail
  // ======================================================================
  {
    // THE lever, if it lands. Measured with complement arms, 2/2 pairs: the
    // terrain snow shader alone is >= 14.4 ms (censored by the vsync floor)
    // against 3.6-8.3 ms for the ENTIRE rest of the scene. No post pass, no
    // shadow pass and no CPU subsystem is measurable against it.
    id: 'terrainShader', group: 'world', label: 'Snow shader', type: 'enum',
    // The tier is part of `customProgramCacheKey`, so switching it costs one
    // shader link for the main material and one for each depth material — a
    // visible hitch. `snow-material.js` says so in as many words: "this is a
    // settings-menu action, not something to drive from a frame loop". Marking it
    // is what puts the warning in front of the player before they drag it.
    cost: 'gpu', hitch: true,
    // FOUR tiers, matching the names `postfx.setQuality` and
    // `terrain.setMeshQuality` already use. This list and the PRESETS table have
    // to agree: `coerce` validates an enum against these options and silently
    // falls back to the default when it cannot find the value, so a preset
    // naming a tier that is missing here does not error — it quietly does
    // nothing. (It had already happened: the presets named 'ultra' while this
    // list stopped at 'high'.)
    options: [{ v: 'low', label: 'Low' }, { v: 'medium', label: 'Medium' },
      { v: 'high', label: 'High' }, { v: 'ultra', label: 'Ultra' }],
    hint: 'Over half of all scene shading cost lives in this one program: >=14.4 ms against 3.6-8.3 ms for '
      + 'everything else in the scene, at 5.76 Mpx. If any knob in this panel is going to move the frame '
      + 'onto a different vsync rung, it is this one.',
    defOf: (s) => (isFn(s.terrain, 'getShaderQuality') ? s.terrain.getShaderQuality() : 'high'),
    guessed: (s) => !isFn(s.terrain, 'getShaderQuality'),
    avail: (s) => isFn(s.terrain, 'setShaderQuality'),
    why: 'terrain.setShaderQuality() is not in this build yet',
    apply(v, s) { if (isFn(s.terrain, 'setShaderQuality')) s.terrain.setShaderQuality(v); },
  },
  {
    id: 'terrainMesh', group: 'world', label: 'Terrain mesh', type: 'enum',
    cost: 'gpu', hitch: true,
    options: [{ v: 'low', label: 'Low' }, { v: 'medium', label: 'Medium' },
      { v: 'high', label: 'High' }, { v: 'ultra', label: 'Ultra' }],
    // Restated against the measurements that actually landed. The earlier text
    // here claimed 2.63 M clipmap triangles and that "vertex cost does not scale
    // with pixels, so this is the one world knob a resolution change cannot
    // substitute for" — both retired. 2.63 M was the whole MAIN PASS, not the
    // clipmap; the clipmap was 1.65 M and is now 1.19 M at Ultra after a dead
    // ring was deleted. And an interleaved A/B of rings 7+8 at DPR 2 came out
    // NOT RESOLVABLE (median 0.6 ms, sign 6/10), so the outer rings were a waste
    // problem, not the fixed-cost lever they were briefly believed to be.
    hint: 'Clipmap tessellation and reach. 1.19 M triangles at Ultra (12.3 km), 0.93 M at High (8.2 km), '
      + '0.55 M at Low (6.6 km). Trimming the last ring costs reach, not facet quality — so the visible '
      + 'change is distant peaks past the reach fading out, not the near ground getting blockier. '
      + 'Rebuilding the rings stalls a frame.',
    defOf: (s) => (isFn(s.terrain, 'getMeshQuality') ? s.terrain.getMeshQuality() : 'high'),
    guessed: (s) => !isFn(s.terrain, 'getMeshQuality'),
    avail: (s) => isFn(s.terrain, 'setMeshQuality'),
    why: 'terrain.setMeshQuality() is not in this build yet',
    apply(v, s) { if (isFn(s.terrain, 'setMeshQuality')) s.terrain.setMeshQuality(v); },
  },
  {
    id: 'cirrus', group: 'world', label: 'Cirrus veil', type: 'range',
    min: 0, max: 0.3, step: 0.01, cost: 'gpu',
    fmt: (v) => (v <= 0.001 ? 'off' : v.toFixed(2)),
    hint: 'The one cloud deck with a true zero-cost early-out (sky.js:980 returns on uCirrus <= 0.001), '
      + 'worth -0.10 ms at 5.76 Mpx. The cumulus and altocumulus decks cost 1.20 and 0.30 ms and CANNOT be '
      + 'switched off from a uniform — uDeckMask multiplies after the march, it does not skip it.',
    defOf: (s) => (s.sky?.params ? s.sky.params.cirrus : 0.11),
    avail: (s) => !!(s.sky?.params && s.sky?.uniforms?.uCirrus),
    apply(v, s) {
      // Write BOTH: the uniform is what the shader reads this frame, and
      // `params` is what a later `sky.refresh()` would re-derive from. Note we
      // deliberately do NOT call refresh() — it re-runs apply(), which resets
      // `scene.environmentIntensity` to the module default and would clobber
      // the ambient knob below.
      if (s.sky?.params) s.sky.params.cirrus = v;
      const u = s.sky?.uniforms?.uCirrus;
      if (u && !near(u.value, v)) u.value = v;
    },
  },
  {
    id: 'snowDetail', group: 'world', label: 'Snow detail normals', type: 'range',
    min: 0, max: 2.4, step: 0.1, cost: 'look', presetInvariant: true,
    fmt: (v) => v.toFixed(1),
    hint: 'Strength of the detail normals on the snow. A multiplier on taps that happen either way, so it '
      + 'buys no frames — and it is what CLAUDE.md’s near-piste micro-contrast baseline '
      + '(74.1 L* / sd 10.6) is measured against. Moving it moves that row.',
    defOf: (s) => (s.terrain?.snowUniforms?.uDetailStrength ? s.terrain.snowUniforms.uDetailStrength.value : 1.7),
    avail: (s) => !!s.terrain?.snowUniforms?.uDetailStrength,
    apply(v, s) {
      const u = s.terrain?.snowUniforms?.uDetailStrength;
      if (u && !near(u.value, v)) u.value = v;
    },
  },
  {
    id: 'snowSparkle', group: 'world', label: 'Snow sparkle', type: 'range',
    min: 0, max: 200, step: 10, cost: 'look', presetInvariant: true,
    fmt: (v) => (v <= 0 ? 'off' : String(Math.round(v))),
    hint: 'Specular gain on the ice-crystal glints. No branch behind it (snow-material.js:1943), so this '
      + 'is taste, not performance.',
    defOf: (s) => (s.terrain?.snowUniforms?.uSparkle ? s.terrain.snowUniforms.uSparkle.value : 110),
    avail: (s) => !!s.terrain?.snowUniforms?.uSparkle,
    apply(v, s) {
      const u = s.terrain?.snowUniforms?.uSparkle;
      if (u && !near(u.value, v)) u.value = v;
    },
  },
  {
    id: 'snowGrain', group: 'world', label: 'Snow grain', type: 'range',
    min: 0, max: 1, step: 0.1, cost: 'look', presetInvariant: true,
    fmt: (v) => Math.round(v * 100) + '%',
    hint: 'The 3.3 cm band that survives to 18 m. Taste; costs nothing either way.',
    defOf: (s) => (s.terrain?.snowUniforms?.uGrainFade ? s.terrain.snowUniforms.uGrainFade.value : 1.0),
    avail: (s) => !!s.terrain?.snowUniforms?.uGrainFade,
    apply(v, s) {
      const u = s.terrain?.snowUniforms?.uGrainFade;
      if (u && !near(u.value, v)) u.value = v;
    },
  },
  {
    id: 'treeSway', group: 'world', label: 'Tree sway', type: 'range',
    min: 0, max: 0.12, step: 0.005, cost: 'look', presetInvariant: true,
    fmt: (v) => (v <= 0 ? 'still' : v.toFixed(3)),
    hint: 'Wind amplitude on the instanced foliage, in the vertex shader. The shader runs either way — '
      + 'this is a motion preference, not a performance one.',
    defOf: (s) => (s.scatter?.uniforms?.uSway ? s.scatter.uniforms.uSway.value : 0.055),
    avail: (s) => !!s.scatter?.uniforms?.uSway,
    apply(v, s) {
      const u = s.scatter?.uniforms?.uSway;
      if (u && !near(u.value, v)) u.value = v;
    },
  },

  // ======================================================================
  // Shadows
  // ======================================================================
  {
    id: 'shadows', group: 'shadow', label: 'Shadows', type: 'bool',
    cost: 'gpu', hitch: true,
    hint: 'Off removes two depth passes AND the PCF sampling from every lit fragment shader. The shadow '
      + 'defines are part of the program cache key, so toggling this RELINKS every material in the scene '
      + '— a multi-frame stall. Not something to hammer.',
    defOf: (s) => (s.renderer?.shadowMap ? !!s.renderer.shadowMap.enabled : true),
    avail: (s) => !!s.renderer?.shadowMap && !!s.scene,
    apply(v, s) {
      const r = s.renderer;
      if (!r?.shadowMap || !s.scene) return;
      // Idempotence matters more here than anywhere else in the file: writing
      // the value it already has would relink every material for nothing.
      if (!!r.shadowMap.enabled === !!v) return;
      r.shadowMap.enabled = !!v;
      // Copied verbatim from the working implementation at
      // src/core/debug-perf.js:222-231 rather than reinvented.
      s.scene.traverse((o) => {
        const m = o.material;
        if (!m) return;
        if (Array.isArray(m)) for (const x of m) x.needsUpdate = true;
        else m.needsUpdate = true;
      });
      if (v) r.shadowMap.needsUpdate = true;
    },
  },
  {
    id: 'shadowMap', group: 'shadow', label: 'Shadow map size', type: 'enum',
    cost: 'gpu', hitch: true, numeric: true,
    options: [
      { v: 1024, label: '1024' },
      { v: 2048, label: '2048' },
      { v: 4096, label: '4096 — shipped' },
    ],
    hint: 'The far cascade; the near cascade tracks it at half. The whole shadow pass measures ~3.2 ms of '
      + 'a 39 ms frame at 9.44 Mpx, and halving both maps quarters the rasterisation and the depth '
      + 'bandwidth. The size is a uniform, not a #define, so this costs a render-target reallocation and '
      + 'NO shader relink — unlike the Shadows switch above.',
    // Prefer the owner's own census. It is the same number today, but it is the
    // one `setShadowQuality` maintains, and reading the light's `mapSize`
    // directly would go stale the moment sky.js grows a cascade.
    defOf: (s) => (isFn(s.sky, 'shadowInfo') ? s.sky.shadowInfo().far : (s.sky?.sun?.shadow?.mapSize?.x || 4096)),
    avail: (s) => isFn(s.sky, 'setShadowQuality') || !!s.sky?.sun?.shadow,
    apply(v, s) {
      // Prefer the owner's API if it exists — it knows what else has to move
      // with the texel footprint (normalBias is in world units and has to track
      // it, sky.js:1240).
      if (isFn(s.sky, 'setShadowQuality')) {
        s.sky.setShadowQuality({ farMap: v, nearMap: Math.max(512, Math.round(v / 2)) });
        return;
      }
      // Fallback. `mapSize` alone does nothing: three only allocates when
      // `shadow.map` is null, so the old target has to be disposed and dropped.
      const set = (light, n) => {
        const sh = light?.shadow;
        if (!sh || sh.mapSize.x === n) return;
        sh.mapSize.set(n, n);
        if (sh.map) { sh.map.dispose(); sh.map = null; }
        sh.needsUpdate = true;
      };
      set(s.sky?.sun, v);
      set(s.sky?.sunNear, Math.max(512, Math.round(v / 2)));
    },
  },
  {
    id: 'shadowRings', group: 'shadow', label: 'Shadow-casting rings', type: 'range',
    // 0..8: `terrain.setShadowRings` clamps to LEVELS, which is 8 in this build.
    // The shipped value is 5 — levels 0..4, i.e. out to 614 m.
    min: 0, max: 8, step: 1, cost: 'gpu',
    fmt: (v) => (v <= 0 ? 'none' : String(Math.round(v))),
    hint: 'How many clipmap rings are drawn into the sun-shadow map. Shipped at 5, which reaches 614 m. '
      + 'Fewer is less depth-pass geometry; 0 disables terrain self-shadowing entirely.',
    // Readable from `meshInfo()`, so this is a real value rather than a guess —
    // which means `auto` reproduces it exactly and the panel can be trusted.
    defOf: (s) => {
      const mi = isFn(s.terrain, 'meshInfo') ? s.terrain.meshInfo() : null;
      const n = mi && mi.shadowRings;
      return Number.isFinite(n) ? n : 5;
    },
    guessed: (s) => !Number.isFinite(
      isFn(s.terrain, 'meshInfo') ? safeGet(() => s.terrain.meshInfo().shadowRings) : NaN),
    avail: (s) => isFn(s.terrain, 'setShadowRings'),
    why: 'terrain.setShadowRings() is not in this build yet',
    apply(v, s) { if (isFn(s.terrain, 'setShadowRings')) s.terrain.setShadowRings(Math.round(v)); },
  },
  {
    id: 'shadowSoftness', group: 'shadow', label: 'Shadow softness', type: 'range',
    min: 0, max: 5, step: 0.5, cost: 'look', presetInvariant: true,
    fmt: (v) => v.toFixed(1) + ' px',
    hint: 'PCF kernel spread on the far cascade, in shadow-map texels (2.0 is about 32 cm on the ground). '
      + 'It spreads the taps, it does not add any — so this is a look knob.',
    defOf: (s) => (s.sky?.sun?.shadow ? s.sky.sun.shadow.radius : 2.0),
    avail: (s) => !!s.sky?.sun?.shadow,
    apply(v, s) {
      const sh = s.sky?.sun?.shadow;
      if (sh && !near(sh.radius, v)) sh.radius = v;
    },
  },

  // ======================================================================
  // Effects
  // ======================================================================
  {
    id: 'spray', group: 'fx', label: 'Snow spray', type: 'range',
    min: 0, max: 1.5, step: 0.1, cost: 'cpu',
    fmt: (v) => (v <= 0 ? 'off' : Math.round(v * 100) + '%'),
    hint: 'Emission rate across all six spray sources (root, rooster, sheet, veil, crystal, air). '
      + 'Hitch-free: it changes how many particles are spawned, not how they are drawn.',
    defOf: () => 1,
    avail: (s) => !!s.spray?.gain,
    apply(v, s) {
      const g = s.spray?.gain;
      if (!g) return;
      // Multiply the CAPTURED base, not the live value, so repeated applies
      // cannot compound. `_base` is snapshotted onto this descriptor at
      // construction — see the note on REGISTRY being module-level below.
      for (const k in g) {
        const want = (this._base?.[k] ?? 1) * v;
        if (!near(g[k], want)) g[k] = want;
      }
    },
  },
  {
    id: 'tracks', group: 'fx', label: 'Ski tracks', type: 'bool',
    cost: 'look', presetInvariant: true,
    hint: 'The persistent carve trenches. Hiding them saves nothing worth measuring and can cost: '
      + 'CLAUDE.md trap 3 — hiding an object exposes what is behind it, and the piste under the '
      + 'ribbon is painted by the full snow shader.',
    defOf: (s) => (s.tracks?.mesh ? !!s.tracks.mesh.visible : true),
    avail: (s) => !!s.tracks?.mesh,
    apply(v, s) { const m = s.tracks?.mesh; if (m && m.visible !== v) m.visible = v; },
  },
  {
    id: 'banners', group: 'fx', label: 'Sponsor banners', type: 'bool',
    cost: 'look', presetInvariant: true,
    hint: 'The slope-side boards. One merged geometry, one atlas, one draw call — so this is a '
      + 'preference, not a saving. The atlas is shared with the hut and is not touched here.',
    defOf: (s) => (s.branding?.group ? !!s.branding.group.visible : true),
    // The group boots hidden until the two brand PNGs are composited, so `true`
    // is the right default whatever `visible` reads right now.
    avail: (s) => !!s.branding?.group,
    apply(v, s) {
      const g = s.branding?.group;
      // Only ever force it OFF, or back to on once the atlas is ready. Turning
      // it on before `branding.ready` resolves would show the procedural
      // fallback, which the module deliberately hides.
      if (!g) return;
      if (!v) { if (g.visible) g.visible = false; return; }
      const ready = s.branding.ready;
      if (ready && isFn(ready, 'then')) ready.then(() => { g.visible = true; }).catch(() => {});
      else g.visible = true;
    },
  },
  {
    id: 'ambient', group: 'fx', label: 'Ambient light', type: 'range',
    min: 0.2, max: 0.8, step: 0.02, cost: 'look', presetInvariant: true,
    fmt: (v) => v.toFixed(2),
    hint: 'Intensity of the PMREM sky dome used as fill. It is the shipped 0.46 for a reason — every '
      + 'row of CLAUDE.md’s quality baseline was measured at it. Costs nothing either way.',
    defOf: (s) => (typeof s.scene?.environmentIntensity === 'number' ? s.scene.environmentIntensity : 0.46),
    avail: (s) => !!s.scene,
    apply(v, s) {
      if (s.scene && !near(s.scene.environmentIntensity, v)) s.scene.environmentIntensity = v;
    },
  },

  // ======================================================================
  // Interface
  // ======================================================================
  {
    id: 'hud', group: 'ui', label: 'HUD', type: 'bool',
    cost: 'ui', presetInvariant: true,
    hint: 'The speed block, run stats and the resort layer. A DOM overlay — zero cost in the three.js '
      + 'frame either way.',
    defOf: () => true,
    avail: (s) => isFn(s.hud, 'setVisible'),
    apply(v, s) { if (isFn(s.hud, 'setVisible')) s.hud.setVisible(v); },
  },
  {
    id: 'volume', group: 'ui', label: 'Volume', type: 'range',
    min: 0, max: 1, step: 0.05, cost: 'ui', presetInvariant: true,
    fmt: (v) => (v <= 0 ? 'muted' : Math.round(v * 100) + '%'),
    hint: 'Master gain on the procedural audio graph.',
    // audio.js exposes no getter, so 1 is a GUESS and is never written on its
    // own account — see `applied` in the factory.
    defOf: () => 1,
    guessed: () => true,
    avail: (s) => isFn(s.audio, 'setVolume'),
    apply(v, s) { if (isFn(s.audio, 'setVolume')) s.audio.setVolume(v); },
  },
];

// REGISTRY is module-level and therefore SHARED between instances, and one
// descriptor (`spray`) has a captured base value stashed on it. This factory is
// meant to be a singleton — `main.js` builds one. If a second instance ever
// becomes necessary, the per-instance state on descriptors has to move into the
// closure first.
//
// Registry order IS apply order, and two orderings are load-bearing:
//   - `adaptiveRes` before `resolution`, because the floor knob reads whether
//     the controller is on to decide if it is a floor or a pin;
//   - `postQuality` before the three member flags its macro writes, so an
//     explicit flag always wins over the tier that seeded it.
// The resolution group is applied after everything else and the resolution
// SCALE after that — `phaseOf` in `applyAll`, not this array's order.
REGISTRY.forEach((d, i) => { d.order = i; });

// ---------------------------------------------------------------------------
// PRESETS
//
// Sparse patches. A knob not named here goes back to its DEFAULT when a preset
// is chosen, and a `presetInvariant` knob is left exactly as the player has it.
// Only knobs whose `cost` is not 'look' appear, on purpose — see the header.
//
// `auto` is the empty patch: every knob at its shipped default, which is what
// the game does with no settings at all. That is what makes a fresh profile,
// and every capture tool in tools/, bit-identical to a build without this file.
// ---------------------------------------------------------------------------
const PRESETS = {
  auto: {},
  low: {
    adaptiveRes: true, resolution: 0.5, maxDpr: 1,
    // postfx's own 'low' tier, NOT the bypass. The bypass ('off') is reachable by
    // hand and is a debug ablation: it sends the scene straight to the default
    // framebuffer, so it loses ACES tonemapping and the whole grade as well as
    // all antialiasing. That is not a cheap image, it is a WRONG one, and it does
    // not belong in a preset a struggling machine will land on. postfx's 'low'
    // keeps TAA, the grade and the film pass and drops bloom, DOF, motion blur
    // and chromatic aberration — 8 to 12 sub-full-res passes and one full-res
    // one.
    postQuality: 'low',
    terrainShader: 'low', terrainMesh: 'low',
    cirrus: 0,
    shadows: false, shadowMap: 1024, shadowRings: 2,
    spray: 0.4,
  },
  medium: {
    adaptiveRes: true, resolution: 0.6, maxDpr: 1.5,
    postQuality: 'medium',
    terrainShader: 'medium', terrainMesh: 'medium',
    shadows: true, shadowMap: 2048, shadowRings: 3,
    spray: 0.8,
  },
  high: {
    adaptiveRes: true, resolution: 0.8, maxDpr: 2,
    postQuality: 'high',
    terrainShader: 'ultra', terrainMesh: 'high',
    shadows: true, shadowMap: 4096,
    spray: 1,
  },
  // Native, pinned, controller off. This is the only preset that turns the
  // adaptive controller OFF, and that is the whole meaning of "ultra": you have
  // asked for the pixels and you accept the frame time.
  ultra: {
    adaptiveRes: false, resolution: 1.0, maxDpr: 2,
    // The top tier of every subsystem that has one. `terrainMesh: 'ultra'` is
    // the 12.3 km clipmap reach that covers the camera's far plane, and
    // `postQuality: 'ultra'` is the uncapped far-field depth of field — i.e.
    // this preset is the look exactly as it shipped before any of it was tiered.
    postQuality: 'ultra',
    terrainShader: 'ultra', terrainMesh: 'ultra',
    shadows: true, shadowMap: 4096,
    spray: 1,
  },
};
const PRESET_NAMES = ['auto', 'low', 'medium', 'high', 'ultra'];

/**
 * SELF-CHECK, at module load. This exists because the failure it catches is
 * silent: `coerce` validates an enum value against the option list and falls
 * back to the default when it does not find it, so a preset naming a tier that
 * the registry does not offer does not throw — the preset just quietly stops
 * changing that knob, and looks like it worked. That happened twice while this
 * file was being written (presets naming 'ultra' against a low/medium/high
 * option list, and a `postQuality` macro that still tested for `=== 'high'`
 * after a fourth tier was added). A few dozen comparisons once per page is a
 * cheap price for never debugging it a third time.
 */
(() => {
  const ids = new Set(REGISTRY.map((d) => d.id));
  const problems = [];
  for (const name of PRESET_NAMES) {
    const patch = PRESETS[name] || {};
    for (const id in patch) {
      const d = REGISTRY.find((x) => x.id === id);
      if (!d) { problems.push(`preset '${name}' names unknown knob '${id}'`); continue; }
      if (d.presetInvariant) problems.push(`preset '${name}' sets presetInvariant knob '${id}'`);
      if (d.cost === 'look') problems.push(`preset '${name}' moves look-only knob '${id}'`);
      if (d.type === 'enum' && d.options && !d.options.some((o) => o.v === patch[id])) {
        problems.push(`preset '${name}': '${id}' has no option '${patch[id]}'`
          + ` (have ${d.options.map((o) => o.v).join(', ')})`);
      }
      if (d.type === 'range' && !(patch[id] >= d.min && patch[id] <= d.max)) {
        problems.push(`preset '${name}': '${id}' = ${patch[id]} is outside ${d.min}..${d.max}`);
      }
    }
  }
  // A tier knob's macro must only name knobs that exist.
  for (const d of REGISTRY) {
    if (typeof d.macro !== 'function') continue;
    const seen = new Set();
    for (const opt of (d.options || [])) for (const k in (d.macro(opt.v) || {})) seen.add(k);
    for (const k of seen) if (!ids.has(k)) problems.push(`macro on '${d.id}' names unknown knob '${k}'`);
  }
  if (problems.length) console.warn('[gfx] registry/preset mismatch:\n  ' + problems.join('\n  '));
})();

// ===========================================================================

export function createGraphicsSettings(subsystems = {}) {
  const S = subsystems || {};
  const byId = new Map(REGISTRY.map((d) => [d.id, d]));

  const qs = (() => {
    try { return new URLSearchParams(globalThis.location?.search || ''); }
    catch (e) { return new URLSearchParams(); }
  })();
  /** `?gfx=default` (or `=off`) ignores the stored document. Documented in the header. */
  const bypassStore = /^(default|off|none|0)$/i.test(qs.get('gfx') || '');

  /** Swallow anything a subsystem getter throws; a settings panel may not crash the game. */
  const safe = (fn) => { try { return fn(); } catch (e) { return undefined; } };
  const formatCount = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + ' M'
    : n >= 1e3 ? (n / 1e3).toFixed(0) + ' k' : String(n));

  // Spray gains are relative to whatever the module shipped with, so capture
  // the base once. Applying the knob repeatedly must not compound.
  const sprayDesc = byId.get('spray');
  sprayDesc._base = S.spray?.gain
    ? { ...S.spray.gain }
    : { root: 1, rooster: 1, sheet: 1, veil: 1, crystal: 1, air: 1 };

  /**
   * The shipped value of every knob, read off the LIVE subsystem wherever one
   * exists. Snapshotted once, at construction, before anything has been
   * applied — so this is genuinely "the build without this file".
   */
  const DEFAULTS = Object.create(null);
  const GUESSED = Object.create(null);
  for (const d of REGISTRY) {
    let v;
    try { v = d.defOf(S); } catch (e) { v = undefined; }
    DEFAULTS[d.id] = coerce(d, v, undefined);
    try { GUESSED[d.id] = typeof d.guessed === 'function' ? !!d.guessed(S) : false; }
    catch (e) { GUESSED[d.id] = true; }
  }

  /**
   * What we have actually WRITTEN to the scene, initialised to the boot state.
   * `applyAll` only writes a knob whose value differs from this, which buys
   * three things at once:
   *   - `auto` at boot writes literally nothing, so a capture tool sees the
   *     shipped build (the persistence hazard in the header);
   *   - a knob whose default had to be GUESSED (no getter exists yet) is never
   *     written on the strength of the guess;
   *   - `renderer.shadowMap.enabled` is never re-asserted, which matters
   *     because writing it relinks every material in the scene.
   * `applyAll({ force: true })` re-asserts everything, for when something else
   * has moved a value behind our back.
   */
  const applied = { ...DEFAULTS };

  // --- the document ---------------------------------------------------------
  let preset = 'auto';
  const values = Object.create(null);

  function coerce(d, v, fallback) {
    if (v === undefined || v === null) return fallback;
    if (d.type === 'bool') return !!v;
    if (d.type === 'range') {
      const n = +v;
      return Number.isFinite(n) ? snap(n, d) : fallback;
    }
    // enum
    const opts = optionsFor(d);
    const want = d.numeric ? +v : v;
    for (const o of opts) if (o.v === want) return o.v;
    return fallback;
  }

  function optionsFor(d) {
    if (typeof d.optionsOf === 'function') {
      try { return d.optionsOf(S) || []; } catch (e) { return d.options || []; }
    }
    return d.options || [];
  }

  const isAvailable = (d) => {
    try { return d.avail ? !!d.avail(S) : true; } catch (e) { return false; }
  };

  /** Which query parameter, if any, is an explicit external instruction. */
  function overriddenBy(d) {
    if (!d.qs) return null;
    for (const k of d.qs) if (qs.has(k)) return '?' + k;
    // engine.js reports its own view of this, which also catches
    // `opts.resolutionScale` passed by main.js rather than by the URL.
    if (d.id === 'resolution' && isFn(S.gfx, 'info') && S.gfx.info().rscalePinned) return '?rscale';
    return null;
  }

  const valueOf = (id) => (id in values ? values[id] : DEFAULTS[id]);

  // --- load ----------------------------------------------------------------
  /**
   * Precedence: query string > stored document > preset default.
   *
   * A named preset is RE-DERIVED from the table rather than restored from the
   * stored values, so a preset that gets re-tuned in a later build takes effect
   * for everyone who chose it by name. Only 'custom' restores literal values.
   */
  function load() {
    if (bypassStore) return;
    const doc = store.read();
    if (!doc || typeof doc !== 'object') return;
    if (doc.v !== SCHEMA) {
      // Drop and re-derive. Migration is not worth the surface area: the whole
      // document is reconstructible from a preset name in one click.
      store.clear();
      return;
    }
    const src = doc.values && typeof doc.values === 'object' ? doc.values : {};
    const restore = (pick) => {
      for (const id in src) {
        const d = byId.get(id);
        if (!d || !pick(d)) continue;           // knob retired since it was stored
        const v = coerce(d, src[id], undefined);
        if (v !== undefined) values[id] = v;
      }
    };

    const p = typeof doc.preset === 'string' ? doc.preset : 'auto';
    if (PRESET_NAMES.includes(p)) {
      preset = p;
      // A `presetInvariant` knob belongs to the PLAYER, not to the preset, so it
      // has to be restored even under a named preset — and it has to be restored
      // BEFORE `presetValues()` runs, because that function passes such knobs
      // through unchanged by reading the current value. Getting this wrong threw
      // away the volume and HUD settings of anyone who had also picked a preset,
      // and it would have been invisible until someone noticed their sound was
      // loud again after a reload.
      restore((d) => d.presetInvariant);
      Object.assign(values, presetValues(p));
    } else {
      preset = 'custom';
      restore(() => true);
    }
    // Reload-queued knobs are a special case: their stored value describes the
    // NEXT page load, and this page already booted with whatever the URL said.
    // Seeding them from the document would show a pending reload on every boot.
    for (const d of REGISTRY) if (d.reload) values[d.id] = DEFAULTS[d.id];
  }

  function persist() {
    if (bypassStore) return false;
    // `values` carries the full document rather than only the diff, because a
    // 'custom' document has to survive a change of DEFAULTS.
    const out = Object.create(null);
    for (const d of REGISTRY) out[d.id] = valueOf(d.id);
    return store.write({ v: SCHEMA, preset, values: out, at: Date.now() });
  }

  /**
   * A knob a preset must pass through unchanged. Two cases, and the second is
   * not cosmetic: a knob pinned by the query string can never be APPLIED, so
   * writing a preset's value into it would leave the stored document describing
   * something that is not on screen — the panel would read "50%" next to a
   * backbuffer rendering at 100% and `matchPreset` would then disagree with
   * itself about which preset is in force.
   */
  const passThrough = (d) => d.presetInvariant || !!overriddenBy(d);

  function presetValues(name) {
    const patch = PRESETS[name] || {};
    const out = Object.create(null);
    for (const d of REGISTRY) {
      if (passThrough(d)) { out[d.id] = valueOf(d.id); continue; }
      out[d.id] = d.id in patch ? coerce(d, patch[d.id], DEFAULTS[d.id]) : DEFAULTS[d.id];
    }
    // Tier knobs own their member flags, so run their macros over the result.
    for (const d of REGISTRY) {
      if (typeof d.macro !== 'function' || !(d.id in patch)) continue;
      const m = d.macro(out[d.id]) || {};
      for (const k in m) {
        const md = byId.get(k);
        if (md && !passThrough(md)) out[k] = coerce(md, m[k], out[k]);
      }
    }
    return out;
  }

  // --- apply ---------------------------------------------------------------
  /**
   * Never touch anything while a measurement is in flight. `perf.recording` is
   * the same flag engine.js' controller respects (rule 1); a settings write in
   * the middle of an interleaved A/B would invalidate both arms and there would
   * be no trace of it in the log.
   */
  const recording = () => {
    try { return !!globalThis.window?.__harness?.perf?.recording; } catch (e) { return false; }
  };

  /**
   * Apply phase. 0 = everything, 1 = the rest of the backbuffer knobs, 2 = the
   * resolution scale itself. Explicit `phase` on a descriptor wins; otherwise
   * anything in the resolution group is phase 1 and everything else is 0.
   */
  // A hoisted `function`, deliberately, not a `const` arrow. `applyAll()` is
  // called from this constructor and from `set()`, and a `const` here sits in the
  // temporal dead zone until this line runs — so any future call ordering that
  // reaches `applyAll` earlier throws "phaseOf is not defined" with a stack that
  // points at the wrong place. Observed once for real, during a Vite dep
  // re-optimisation reload that ran the module graph in a partially loaded state.
  function phaseOf(d) {
    return Number.isFinite(d.phase) ? d.phase : (d.group === 'res' ? 1 : 0);
  }

  function applyOne(d, v, changed = true) {
    if (d.reload) return false;                       // queued, not applied
    if (!isAvailable(d)) return false;
    if (overriddenBy(d)) return false;                // the URL wins
    // `changed` distinguishes "the player moved this" from "we are re-asserting
    // the same value". Only the resolution knob cares, and it cares a great deal
    // — see its apply().
    try { d.apply(v, S, { changed }); } catch (e) {
      console.warn('[gfx] applying ' + d.id + ' failed:', e);
      return false;
    }
    applied[d.id] = v;
    return true;
  }

  /**
   * Apply the whole document.
   *
   * RESOLUTION IS LAST, and the whole pass is bracketed in `gfx.freeze()`:
   *   - a resolution change reallocates ~12 post-processing render targets, so
   *     doing it first and then changing something else wastes the realloc;
   *   - the controller must not react to the frames we are stalling with a
   *     shadow-map realloc and a whole-scene material relink. `freeze()` is
   *     reentrant, so nesting inside somebody else's window is safe.
   */
  function applyAll(opts = {}) {
    if (recording()) return { applied: 0, skipped: 'perf.recording' };
    const force = !!opts.force;
    let n = 0;
    const frozen = isFn(S.gfx, 'freeze');
    if (frozen) S.gfx.freeze();
    try {
      for (const pass of [0, 1, 2]) {
        for (const d of REGISTRY) {
          if (phaseOf(d) !== pass) continue;
          const v = valueOf(d.id);
          const changed = applied[d.id] !== v;
          if (!force && !changed) continue;
          if (applyOne(d, v, changed)) n++;
        }
      }
    } finally {
      if (frozen && isFn(S.gfx, 'unfreeze')) S.gfx.unfreeze();
    }
    return { applied: n };
  }

  // --- public API ----------------------------------------------------------
  function set(id, value) {
    const d = byId.get(id);
    if (!d) return undefined;
    if (recording()) return valueOf(id);
    const v = coerce(d, value, undefined);
    if (v === undefined) return valueOf(id);
    if (overriddenBy(d)) return valueOf(id);          // externally pinned

    const patch = { [id]: v };
    if (typeof d.macro === 'function') {
      const m = d.macro(v) || {};
      for (const k in m) {
        const md = byId.get(k);
        if (md) patch[k] = coerce(md, m[k], valueOf(k));
      }
    }
    for (const k in patch) values[k] = patch[k];
    preset = matchPreset();
    persist();

    // One knob, one freeze window — a resolution change here is exactly the
    // reallocation applyAll's ordering exists to protect.
    const frozen = isFn(S.gfx, 'freeze');
    if (frozen) S.gfx.freeze();
    try {
      // Registry order, so a tier knob lands before the flags it just seeded.
      for (const k of Object.keys(patch).sort((a, b) => byId.get(a).order - byId.get(b).order)) {
        applyOne(byId.get(k), patch[k]);
      }
    } finally {
      if (frozen && isFn(S.gfx, 'unfreeze')) S.gfx.unfreeze();
    }
    return valueOf(id);
  }

  /**
   * Is the document still exactly one of the named presets? Keeps the panel
   * from reading "Custom" after a change that happened to land back on a preset,
   * and is how `set()` decides whether to say "custom" at all.
   */
  function matchPreset() {
    for (const name of PRESET_NAMES) {
      const pv = presetValues(name);
      let ok = true;
      for (const d of REGISTRY) {
        if (passThrough(d)) continue;
        const a = valueOf(d.id), b = pv[d.id];
        if (typeof a === 'number' && typeof b === 'number' ? !near(a, b) : a !== b) { ok = false; break; }
      }
      if (ok) return name;
    }
    return 'custom';
  }

  function setPreset(name) {
    if (!PRESET_NAMES.includes(name)) return preset;
    const pv = presetValues(name);
    for (const d of REGISTRY) values[d.id] = pv[d.id];
    preset = name;
    persist();
    applyAll();
    return preset;
  }

  function reset() {
    for (const d of REGISTRY) delete values[d.id];
    preset = 'auto';
    store.clear();
    applyAll();
    return preset;
  }

  // --- the reload queue ----------------------------------------------------
  const reloadKnobs = REGISTRY.filter((d) => d.reload);
  const pending = () => reloadKnobs.filter((d) => valueOf(d.id) !== DEFAULTS[d.id]);

  /**
   * Rewrite the query string and reload. `engine.js` reads these parameters at
   * construction, so this is the only way an `antialias` change can take
   * effect: it is a WebGL context attribute.
   *
   * Existing parameters are preserved — including `?gfx=default`, deliberately:
   * if the session was booted asking for shipped defaults, reloading it should
   * still ask for shipped defaults.
   */
  function applyReload() {
    const list = pending();
    if (!list.length) return false;
    let p;
    try { p = new URLSearchParams(globalThis.location.search || ''); }
    catch (e) { return false; }
    for (const d of list) {
      if (!isFn(d, 'toQuery')) continue;
      const [k, v] = d.toQuery(valueOf(d.id));
      p.set(k, String(v));
    }
    try {
      const s = p.toString();
      globalThis.location.search = s ? '?' + s : '';
      return true;
    } catch (e) { return false; }
  }

  // --- readouts ------------------------------------------------------------
  /**
   * Scene triangles, counted off the scene graph.
   *
   * NOT `renderer.info.render.triangles`: three resets `info` at the top of
   * every `renderer.render()` and the post chain makes about a dozen per frame,
   * so the naive read reports the last fullscreen quad — CLAUDE.md trap 6, which
   * has produced a confident wrong answer here before. Traversal is O(objects)
   * and is throttled to 2 Hz because only the settings panel ever asks.
   */
  let triCache = { at: -1e9, tris: 0, objects: 0 };
  function sceneTriangles() {
    const now = (globalThis.performance?.now?.() ?? Date.now());
    if (now - triCache.at < 500) return triCache;
    let tris = 0, objects = 0;
    if (S.scene) {
      S.scene.traverse((o) => {
        if (!o.visible || !o.isMesh) return;
        const g = o.geometry;
        if (!g) return;
        const idx = g.index ? g.index.count : (g.attributes?.position?.count || 0);
        const inst = o.isInstancedMesh ? Math.max(0, o.count) : 1;
        tris += (idx / 3) * inst;
        objects += 1;
      });
    }
    triCache = { at: now, tris: Math.round(tris), objects };
    return triCache;
  }

  function info() {
    const g = isFn(S.gfx, 'info') ? S.gfx.info() : null;
    const tick = g && g.displayTick ? g.displayTick : 0;
    const dec = g && g.lastDecision ? g.lastDecision : null;
    const tri = sceneTriangles();
    const mi = isFn(S.terrain, 'meshInfo') ? safe(() => S.terrain.meshInfo()) : null;

    // The controller's real deepest rung. `setMinResolutionScale` is NOT the
    // whole story: engine.js also allows a rung UNDER the linear floor whenever
    // it still yields 1.4 Mpx (FLOOR_MPX), unless `?rfloor=` made the floor an
    // explicit instruction. Reporting only the knob would be a lie on a large
    // display.
    const steps = g && g.adaptiveSteps;
    const controllerFloor = steps && Number.isFinite(g.adaptiveMaxStep)
      ? steps[g.adaptiveMaxStep] : null;

    return {
      // resolution
      drawingBuffer: g ? g.drawingBuffer : null,
      megapixels: g ? g.megapixels : null,
      resolutionScale: g ? g.resolutionScale : null,
      minResolutionScale: g ? g.minResolutionScale : null,
      controllerFloorScale: controllerFloor,
      devicePixelRatio: g ? g.devicePixelRatio : null,
      maxPixelRatio: g ? g.maxPixelRatio : null,
      pixelRatio: g ? g.pixelRatio : null,
      adaptive: g ? g.adaptive : null,
      adaptiveEvents: g ? g.adaptiveEvents : null,
      rscalePinned: g ? g.rscalePinned : false,
      frozen: g ? g.frozen : false,
      simPaused: g ? !!g.simPaused : false,
      // pacing — RUNGS, never fps. See CLAUDE.md trap 8.
      displayTick: tick || null,
      displayHz: g ? g.displayHz : null,
      vsyncLadder: g ? g.vsyncLadder : null,
      lockMs: g ? g.lockMs : null,
      targetFps: g ? g.targetFps : null,
      /** Is the frame time the controller aims at actually presentable here? */
      targetOnLadder: !!(g && tick && Math.abs(g.lockMs - 1000 / g.targetFps) < tick * 0.02),
      /**
       * The last decision window engine.js' own controller took — the only
       * frame-time measurement in this build that costs nothing extra. Null
       * whenever the controller is not sampling (adaptive off, backbuffer under
       * 2.5 Mpx, frozen, or a tool has paused the sim), which is honest: this
       * file does NOT start a sampler of its own to fill the gap.
       */
      frame: dec ? {
        p70: dec.p70, p30: dec.p30, lock: dec.lock, lateFrac: dec.lateFrac,
        rung: rungOf(dec.p70, tick),
        between: !!(tick && !rungOf(dec.p70, tick)?.clean),
      } : null,
      // scene
      triangles: tri.tris,
      meshes: tri.objects,
      meshInfo: mi || null,
      shadow: isFn(S.sky, 'shadowInfo') ? safe(() => S.sky.shadowInfo()) || null : null,
    };
  }

  /**
   * The readouts, pre-formatted. This exists so `ui/settings.js` can render the
   * live section without knowing what a megapixel or a vsync rung is — the file
   * split in the header is only real if the UI never has to interpret a number.
   */
  function readouts() {
    const i = info();
    const rows = [];
    const push = (label, value, note) => rows.push({ label, value, note: note || '' });

    if (i.drawingBuffer) {
      push('Backbuffer', i.drawingBuffer[0] + '×' + i.drawingBuffer[1],
        i.megapixels.toFixed(2) + ' Mpx');
    }
    if (i.resolutionScale != null) {
      const floorTxt = i.controllerFloorScale != null && !near(i.controllerFloorScale, i.minResolutionScale)
        ? 'floor ' + Math.round(i.minResolutionScale * 100) + '% · controller may reach '
          + Math.round(i.controllerFloorScale * 100) + '%'
        : 'floor ' + Math.round(i.minResolutionScale * 100) + '%';
      push('Rendering at', Math.round(i.resolutionScale * 100) + '%', floorTxt);
    }
    if (i.pixelRatio != null) {
      push('Pixel density', i.pixelRatio.toFixed(2) + '×',
        'display ' + (i.devicePixelRatio || 1) + '×, capped at ' + i.maxPixelRatio + '×');
    }
    push('Adaptive', i.adaptive ? 'on' : 'off',
      i.frozen ? 'frozen for a measurement'
        : i.rscalePinned ? 'resolution pinned by the URL'
        : (i.adaptiveEvents ? i.adaptiveEvents + ' step' + (i.adaptiveEvents === 1 ? '' : 's') + ' this session' : ''));

    // --- pacing. NEVER an fps number: the rung, or nothing. -----------------
    if (i.displayHz) {
      push('Display', i.displayHz.toFixed(1) + ' Hz', 'refresh tick ' + i.displayTick.toFixed(2) + ' ms');
      if (i.vsyncLadder) {
        push('Presentable', i.vsyncLadder.map((m) => m.toFixed(1)).join(' / ') + ' ms',
          'nothing between these exists');
      }
      push('Aiming at', i.lockMs.toFixed(2) + ' ms',
        i.targetOnLadder ? 'the ' + i.targetFps + ' fps target is on this ladder'
          : i.targetFps + ' fps is NOT a rung here — aiming at the fastest rung that meets it');
    } else {
      push('Display', 'not yet measured',
        'inferred from the spacing of presented intervals; it needs a few seconds of unpaused play');
    }
    if (i.frame) {
      const r = i.frame.rung;
      let note = !r ? ''
        : i.frame.between
          ? 'BETWEEN RUNGS — ' + Math.round(i.frame.lateFrac * 100) + '% of frames a whole tick late'
          : 'locked on rung ' + r.k + ' (' + r.at.toFixed(1) + ' ms)';
      // Opening this panel pauses the simulation, and a paused frame is not a
      // gameplay frame — engine.js' controller stops sampling, so this is the
      // last window measured BEFORE the panel went up. Saying so is the whole
      // difference between a stale number and a lie.
      if (i.simPaused || i.frozen) note += (note ? ' · ' : '') + 'measured before the sim was paused';
      push('Last window', i.frame.p70.toFixed(1) + ' ms', note);
    } else {
      push('Last window', 'not sampled',
        'the resolution controller is the only frame-time source here, and it is not running');
    }

    // Shadow map texel footprint. This is the number that decides whether a
    // shadow edge reads as an edge, and it is the one thing a map-size setting
    // cannot be judged without.
    if (i.shadow) {
      push('Shadow cascades', i.shadow.far + ' / ' + i.shadow.near,
        i.shadow.farTexelCm + ' cm and ' + i.shadow.nearTexelCm + ' cm per texel on the ground');
    }
    push('Scene triangles', formatCount(i.triangles), i.meshes + ' visible meshes');
    // A WHITELIST, not a dump of every key. `terrain.meshInfo()` is a diagnostic
    // census — per-level resolutions, hole sizes, extents — and printing all of
    // it turns the one section a player might read into a debug log. Four
    // numbers: how much geometry, how far it reaches, and what casts.
    const mi2 = i.meshInfo;
    if (mi2) {
      if (Number.isFinite(mi2.triangles)) {
        push('Terrain mesh', formatCount(mi2.triangles) + ' tris',
          (mi2.tier ? mi2.tier + ' tier · ' : '') + (mi2.levels || 0) + ' clipmap rings'
          + (Number.isFinite(mi2.reach) ? ' · reaches ' + (mi2.reach / 1000).toFixed(1) + ' km' : ''));
      }
      if (Number.isFinite(mi2.shadowRings)) {
        push('Casting rings', String(mi2.shadowRings),
          Number.isFinite(mi2.receiveRings) ? mi2.receiveRings + ' rings receive' : '');
      }
    }
    return rows;
  }

  /** Everything the panel needs about one knob, and nothing it has to interpret. */
  function describe(id) {
    const d = byId.get(id);
    if (!d) return null;
    const v = valueOf(id);
    const opts = d.type === 'enum' ? optionsFor(d).slice() : null;
    // Keep the current value representable even if the dynamic option list
    // (the vsync ladder) does not contain it on this display.
    if (opts && !opts.some((o) => o.v === v)) opts.unshift({ v, label: String(v) });
    const over = overriddenBy(d);
    const avail = isAvailable(d);
    let live;
    if (isFn(d, 'liveOf')) live = safe(() => d.liveOf(S));
    return {
      id, label: d.label, group: d.group, type: d.type, hint: d.hint,
      cost: d.cost, hitch: !!d.hitch, reload: !!d.reload,
      presetInvariant: !!d.presetInvariant,
      value: v,
      text: format(d, v),
      def: DEFAULTS[id],
      changed: typeof v === 'number' && typeof DEFAULTS[id] === 'number'
        ? !near(v, DEFAULTS[id]) : v !== DEFAULTS[id],
      guessedDefault: !!GUESSED[id],
      options: opts,
      min: d.min, max: d.max, step: d.step,
      available: avail,
      why: avail ? '' : (d.why || 'not available in this build'),
      overriddenBy: over,
      pendingReload: !!d.reload && v !== DEFAULTS[id],
      liveValue: live,
      liveText: live === undefined ? '' : format(d, live),
    };
  }

  function format(d, v) {
    if (v === undefined || v === null) return '—';
    if (d.type === 'bool') return v ? 'On' : 'Off';
    if (d.type === 'enum') {
      const o = optionsFor(d).find((x) => x.v === v);
      return o ? o.label : String(v);
    }
    return isFn(d, 'fmt') ? d.fmt(v) : String(v);
  }

  /** Step an enum or a range by `dir` (-1 / +1). Returns the new value. */
  function nudge(id, dir) {
    const d = byId.get(id);
    if (!d) return undefined;
    const v = valueOf(id);
    if (d.type === 'bool') return set(id, dir > 0 ? true : dir < 0 ? false : !v);
    if (d.type === 'enum') {
      const opts = optionsFor(d);
      let at = opts.findIndex((o) => o.v === v);
      if (at < 0) at = 0;
      const next = opts[clamp(at + (dir > 0 ? 1 : -1), 0, opts.length - 1)];
      return next ? set(id, next.v) : v;
    }
    return set(id, snap(v + dir * (d.step || 0.01), d));
  }

  // --- the auto-tuner ------------------------------------------------------
  /**
   * WHY THIS EXISTS. `engine.js`' resolution controller is the only adaptive
   * thing in the build, and it has exactly one lever: pixels. Measured on the
   * owner's 5K panel (2560x1440 at DPR 2 = 14.75 Mpx), that lever ran out — the
   * ladder reached its floor and the frame STILL missed the rung. A controller at
   * its floor with `meeting: false` is a controller telling you it has nothing
   * left to spend, and before this it just sat there.
   *
   * The measured shape of the fix, per-preset at 14.75 Mpx, p50 / % of frames
   * sitting on the rung / frames over 33 ms:
   *
   *     auto (shipped defaults)  2.36 Mpx  16.90  63%   31/587
   *     high                     2.36 Mpx  16.70  71%   20/613
   *     medium                   2.98 Mpx  16.70  94%    1/697
   *     low                      3.69 Mpx  16.70  100%   0/719
   *
   * Read the resolution column: the LOWER quality tiers end up rendering MORE
   * pixels, because cheaper pixels are pixels the resolution controller can
   * afford to keep. Quality tier and resolution are not two ways to spend the
   * same budget — spending on the tier BUYS resolution. That is the whole reason
   * a quality ladder belongs underneath the resolution ladder rather than beside
   * it.
   *
   * So: while the preset is `auto`, if the resolution controller reports itself
   * pinned at its floor and still not meeting the rung, step the quality ladder
   * down one rung and let the controller climb back. One-way and hysteretic.
   *
   * WHY IT CANNOT DISTURB A MEASUREMENT OR A CAPTURE:
   *   - it only runs while the preset is `auto`;
   *   - it refuses while `perf.recording`, while `gfx.frozen`, and while the sim
   *     is paused — and `__setAuto(false)` is how every capture tool in tools/
   *     starts, within ~1.2 s of boot;
   *   - it needs CONSECUTIVE_DISTRESS windows of sustained distress spread over
   *     several seconds before it acts, which no capture session lasts in an
   *     unpaused state.
   *   Net effect: it is inert in every tool, and `auto` stays the empty patch
   *   until a real player is really missing frames.
   *
   * ONE-WAY, deliberately. Stepping back up needs a cost signal this build does
   * not have: the presented interval is quantised, so "comfortable" at a locked
   * 16.67 ms is indistinguishable from "3 ms of headroom" (trap 5's whole
   * argument). Guessing upward would hunt, and every hop costs a shader relink
   * plus a clipmap rebuild — far more visible than the resolution controller's
   * render-target churn. A player who wants the quality back picks a preset.
   */
  const AUTO_LADDER = ['high', 'medium', 'low'];   // steps taken, in order
  const AUTO_CHECK_MS = 2500;
  const CONSECUTIVE_DISTRESS = 3;                  // ~7.5 s before acting
  let autoStep = -1;                               // index into AUTO_LADDER
  let distress = 0;
  let autoTimer = null;

  /** Is the resolution controller out of road? Its own report, not our guess. */
  function controllerStuck() {
    if (!isFn(S.gfx, 'info')) return false;
    const g = S.gfx.info();
    if (!g.adaptive || g.frozen || g.simPaused) return false;
    const d = g.lastDecision;
    if (!d) return false;
    // `atFloor` means the ladder has no deeper rung it is allowed to take.
    // `meeting` false means the frame is over the rung it aims at. `lateFrac`
    // catches the judder case the percentile test cannot see: a rung whose true
    // cost sits between two ticks presents as an alternating mix, so p30 reads
    // under and p70 reads over and the controller parks there.
    return !!d.atFloor && (d.meeting === false || d.lateFrac > 0.25);
  }

  function autoTick() {
    if (preset !== 'auto' || recording()) { distress = 0; return; }
    if (autoStep >= AUTO_LADDER.length - 1) return;      // already at the bottom
    if (!controllerStuck()) { distress = 0; return; }
    if (++distress < CONSECUTIVE_DISTRESS) return;
    distress = 0;
    const next = AUTO_LADDER[++autoStep];
    // Apply the preset's knobs but KEEP the preset named `auto`, so the panel
    // still reads "Auto" and a later `setPreset('auto')` is a real reset. The
    // player asked the game to look after itself; this is it doing that.
    const pv = presetValues(next);
    for (const d of REGISTRY) {
      if (d.presetInvariant || overriddenBy(d)) continue;
      // NEVER take the preset's RESOLUTION knobs. This is the whole correctness
      // condition of the tuner and it is not obvious: `resolution` is a FLOOR
      // (`gfx.setMinResolutionScale`), so applying `high`'s 0.8 forces the
      // controller UP to 9.44 Mpx on a machine that just told us it could not
      // afford 2.36. Measured, when this filter was missing: stepping to `high`
      // took the backbuffer 2.36 -> 7.22 Mpx and the frame to p50 33.20 ms with
      // 155 of 305 frames over 33 — far worse than the distress it was reacting
      // to, for the ~10 s the controller needed to climb back down. Each step
      // did it again.
      //
      // The division of labour is the point: the resolution controller owns HOW
      // MANY pixels, and it is already at its floor. The tuner's only job is to
      // make each pixel CHEAPER so that floor becomes affordable — and, as the
      // per-preset table above shows, so the controller can then climb.
      if (d.group === 'res') continue;
      if (pv[d.id] !== undefined) values[d.id] = pv[d.id];
    }
    const frozen = isFn(S.gfx, 'freeze');
    if (frozen) S.gfx.freeze();
    try {
      for (const pass of [0, 1, 2]) {
        for (const d of REGISTRY) {
          if (phaseOf(d) !== pass) continue;
          const v = valueOf(d.id);
          if (applied[d.id] === v) continue;
          applyOne(d, v);
        }
      }
    } finally { if (frozen && isFn(S.gfx, 'unfreeze')) S.gfx.unfreeze(); }
    persist();
    // Loud on purpose: a silent quality drop is indistinguishable from a bug,
    // and this is exactly the kind of thing that gets reported as one.
    console.info(`[gfx] auto: the resolution controller is pinned at its floor and still `
      + `missing the rung — stepping quality down to "${next}". Pick a preset in the `
      + `graphics panel (Escape) to override.`);
  }

  /** The tier `auto` has descended to, or null if it has not had to. */
  function autoState() {
    return { stepped: autoStep >= 0 ? AUTO_LADDER[autoStep] : null, distress };
  }

  // --- boot ---------------------------------------------------------------
  load();
  // Applying at construction is safe and is what the lead wires: with no stored
  // document this writes NOTHING (see `applied`), so a capture tool's page is
  // the shipped build.
  applyAll();
  try {
    if (typeof setInterval === 'function') {
      autoTimer = setInterval(autoTick, AUTO_CHECK_MS);
      // Node keeps its event loop alive for a pending timer, so an unref'd
      // handle is the difference between "a probe imports this module" and "a
      // probe imports this module and never exits". Browsers have no unref.
      if (autoTimer && typeof autoTimer.unref === 'function') autoTimer.unref();
    }
  } catch (e) { /* non-browser host; the tuner is optional */ }

  const api = {
    // --- the contract ------------------------------------------------------
    applyAll,
    setPreset,
    getPreset: () => preset,
    set,
    get: (id) => valueOf(id),
    registry: REGISTRY,
    info,
    reset,
    get pendingReload() { return pending().length > 0; },
    applyReload,

    // --- extras the panel uses; see the header on the model/view split -----
    groups: GROUPS,
    presets: PRESET_NAMES,
    describe,
    readouts,
    nudge,
    defaults: DEFAULTS,
    /** True when `?gfx=default` is in force, i.e. storage is being ignored. */
    storageBypassed: bypassStore,
    /** Which query parameters are currently overriding a knob, for the footer. */
    overrides: () => REGISTRY.map((d) => ({ id: d.id, by: overriddenBy(d) })).filter((x) => x.by),

    // --- the auto-tuner ----------------------------------------------------
    /** What `auto` has had to do, for a readout and for tests. */
    autoState,
    /** Run one tuner check immediately. Tests only — normally on a timer. */
    autoTick,
    /** Stop the tuner. Call from a tool that wants a guaranteed-static config. */
    stopAutoTune() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } },
  };
  return api;
}
