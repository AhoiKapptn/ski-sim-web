import * as THREE from 'three';

/**
 * Alpine — dev-only performance ablation panel.  `pnpm dev` only.
 *
 * WHY THIS EXISTS
 * ---------------
 * The frame cost of this build is dominated by FRAGMENT work at the resolution
 * the game is actually played at (see CLAUDE.md trap 5 and the engine.js
 * header): on a Retina display the backbuffer is 5.76 Mpx and ~96% of a 34 ms
 * frame is GPU shading. Every headless measurement in this project's history
 * ran at 1.44 Mpx, so the ranking of "what is heavy" that the tools produce is
 * not necessarily the ranking a player on a real display experiences.
 *
 * This panel puts the ablations in the player's hands: press a digit, watch the
 * frame time, press `M` for a repeatable benchmark. Nine subsystems, plus the
 * resolution knob — which is the one lever that is both continuous and, by a
 * wide margin, the largest.
 *
 * FOUR THINGS THAT WOULD OTHERWISE MAKE EVERY READING A LIE
 * ---------------------------------------------------------
 * 1. `engine.js`' adaptive resolution controller. It is ON by default above
 *    2.5 Mpx and it reacts to frame time, so switching a subsystem off makes it
 *    RAISE the resolution and eat the win — the fps reading barely moves and the
 *    conclusion is "that subsystem was free". So the panel pins the resolution
 *    the moment you ablate, change resolution, or measure, and says so in the
 *    header. It does NOT pin merely by being open — see `holdResolution()` for
 *    the measured reason that distinction matters. `P` toggles it by hand, `R`
 *    hands the controller back.
 * 2. fps is the wrong statistic. The presented frame interval is quantised to
 *    the display's tick, so at 60 Hz an fps counter can only ever say 60 or 30
 *    and a real 15% win can read as zero. The panel reports the interval in
 *    milliseconds — p50, p99, and the count of frames over 20 ms — which is
 *    what CLAUDE.md's trap 1 says to quote. `over20` in particular moves
 *    smoothly where fps does not.
 * 3. Two readings taken while skiing different bits of the mountain are not
 *    comparable. `M` teleports to the canonical `hero` start and replays
 *    `tools/frametime.mjs`' linked-carve script, so every row in the table
 *    measured the same run. `L` measures wherever you are, for the cases where
 *    that is the point.
 * 4. Hiding an object can make the frame SLOWER, because whatever was behind it
 *    now has to be shaded (CLAUDE.md trap 3 — hiding near trees once cost
 *    22 ms). A negative result here is information, not a bug.
 *
 * One measured non-bug, recorded so the next person does not chase it: cycling
 * an arm off and back on with the SIM FROZEN (`__setAuto(false)`) does not
 * restore the previous image for another hundred-odd frames. That is TAA, not a
 * state leak in this file — a frozen camera makes every pixel "still", so the
 * resolve runs at `PARAMS.taa.feedbackStill = 0.97` and the ablated frames bleed
 * out slowly. Verified: with the post chain off (key `8`) the same off/on cycle
 * restores the frame exactly, 154.86 against a 154.6 baseline. Nothing about it
 * is visible while the sim is running.
 *
 * KEYS
 * ----
 *   D      DIAGNOSE — start here if the toggles all read the same. ~10 s.
 *   F      resolution sweep — walks the ladder and reports which rungs LOCK
 *   1..9   toggle a subsystem (see TOGGLES below)
 *   0      cycle the resolution scale: 100 → 85 → 75 → 60 → 50 → 100 %
 *   H      toggle the DOM HUD (it is not WebGL, so no other key touches it)
 *   M      canonical benchmark: teleport to `hero`, scripted linked carves,
 *          1.6 s settle + 6 s measured, appended to the table
 *   L      measure 6 s live, where you are, with your own input
 *   R      everything back on, resolution back to 100%
 *   Z      everything off — the floor this scene can reach
 *   C      copy the results table to the clipboard
 *   P      pin / unpin the adaptive resolution controller by hand
 *   `      show / hide the panel (hidden at boot; a plain `pnpm dev` session is
 *          then byte-for-byte a normal session — the panel changes nothing
 *          until you press a key)
 *
 * Digits are ignored while `state.mode === 'hut'`, where they are the drinks
 * menu (controls.js `pick`).
 *
 * WHAT `D` IS FOR, AND WHY IT MATTERS MORE THAN THE NINE TOGGLES
 * -------------------------------------------------------------
 * Every toggle above answers "is THIS subsystem expensive". None of them can
 * answer the question that comes first: **is the frame limited by anything this
 * game draws at all.** If it is not — if the interval is set by the display, by
 * a throttled compositor, or by a software rasteriser — then all nine arms read
 * identical and the honest conclusion is "look outside the renderer", not
 * "nothing is heavy". That failure mode is indistinguishable from "nothing
 * helps" unless you measure the FLOOR.
 *
 * So `D` runs two windows and compares them:
 *
 *   shipped   the frame exactly as it is now, with `harness.perf`'s
 *             per-subsystem CPU attribution running
 *   floor     no simulation, every subsystem hidden, shadow map frozen, HUD
 *             gone, resolution at the 25% clamp — i.e. an almost empty scene
 *
 * If `floor` is close to `shipped`, the renderer is not the pacer and the
 * verdict says so, with the environment facts that explain it: the unmasked GL
 * renderer string (a software rasteriser is the single most likely "everything
 * is equally slow" cause), the real backbuffer in megapixels, devicePixelRatio,
 * whether this is a dev build, and the best achievable interval — which is the
 * display tick, and tells you the refresh rate the browser is actually pacing
 * to. A 30 Hz external display and a disabled GPU both look exactly like "the
 * game is slow and nothing fixes it".
 *
 * If `floor` is far below `shipped`, the scene genuinely is the cost, the
 * headroom figure says how much there is to win, and the CPU split (update vs
 * submit vs waiting) says which half of the frame to attack.
 *
 * `window.__dbg` exposes the same API for the console.
 */

// ---------------------------------------------------------------------------
// The canonical run, lifted verbatim from tools/frametime.mjs so a reading from
// this panel and a reading from the CLI describe the same path.
// ---------------------------------------------------------------------------
const HERO_START = [0, 700, Math.PI];
const CARVE = { lead: 1.2, amp: 0.85, period: 2.6 };

function carveAt(t) {
  if (t < CARVE.lead) return { steer: 0, crouch: 1, brake: 0, jump: false };
  const u = ((t - CARVE.lead) * 2 * Math.PI) / CARVE.period;
  const s = Math.sin(u);
  return {
    steer: CARVE.amp * (s < 0 ? -1 : 1) * Math.pow(Math.abs(s), 0.55),
    crouch: 0, brake: 0, jump: false,
  };
}

const RES_STEPS = [1.0, 0.85, 0.75, 0.6, 0.5];

const pct = (sorted, p) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] : 0);
const r2 = (v) => Math.round(v * 100) / 100;

export function createDebugPanel(ctx) {
  const {
    renderer, scene, camera, gfx, state, harness,
    terrain, sky, scatter, spray, tracks, postfx, draglift, branding,
  } = ctx;
  if (typeof document === 'undefined') return null;

  // -------------------------------------------------------------------------
  // Scene lookups. Everything is resolved lazily and cached: the scatter pools
  // exist at boot but `resort` builds the hut interior later, and `branding`
  // only unhides its group once its two PNGs are in the atlas.
  // -------------------------------------------------------------------------
  const byName = (root, names) => {
    const set = new Set(names);
    const out = [];
    root?.traverse?.((o) => { if (set.has(o.name)) out.push(o); });
    return out;
  };

  const cache = new Map();
  const lookup = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn() || []);
    return cache.get(key);
  };

  const riderMeshes = () => lookup('riders', () => byName(scatter?.group,
    ['riders-skis', 'riders-legL', 'riders-legR', 'riders-upper', 'riders-arms', 'riders-spray']));

  // Pool meshes carry the pool's `name` (scatter.js Pool constructor). tree0/1
  // are the two geometry LODs, tree2 the impostor card, clust/mass the
  // multi-stem canopy cards that carry the distant forest.
  const treeMeshes = () => lookup('trees', () => byName(scatter?.group,
    ['tree0', 'tree1', 'tree2', 'clust', 'mass']));

  // Everything else scatter owns, plus the two lift structures and the slope
  // branding. Hiding `buildings` takes the restaurant shell with it, so this
  // one is worth leaving alone while `state.mode === 'hut'`.
  const propMeshes = () => lookup('props', () => {
    const out = byName(scatter?.group, ['rock0', 'rock1', 'log0', 'log1', 'drift0', 'drift1',
      'chairlift', 'snow-guns', 'slalom', 'bnet', 'bnet-posts', 'buildings']);
    if (draglift?.group) out.push(draglift.group);
    if (branding?.group) out.push(branding.group);
    return out;
  });

  const skyMesh = () => lookup('sky', () => byName(scene, ['sky']));

  // -------------------------------------------------------------------------
  // Terrain snow-shader ablation.
  //
  // The naive version of this — swap in a MeshBasicMaterial — cannot answer the
  // question it looks like it answers: a trivial fragment program lets the
  // linker dead-strip the vertex program too, so it measures the displacement
  // AND the shading together (CLAUDE.md, interface hazards). Worse, the
  // undisplaced plane drops the skier through the mountain and you cannot ski
  // the benchmark.
  //
  // `material.userData.createDepthMaterial()` is the terrain's own shadow-pass
  // material: byte-for-byte the SAME vertex program, including the height-field
  // displacement, with a fragment shader that writes depth and nothing else.
  // Flipping it to BasicDepthPacking makes it a readable grey instead of packed
  // RGBA noise. So the arm holds geometry, silhouette, physics and the vertex
  // cost fixed and removes only the snow shader's fragment work — which the
  // ablation in engine.js' header puts at ≥14.4 ms of a 34 ms DPR-2 frame,
  // against 3.6–8.3 ms for the whole rest of the scene.
  //
  // `customDepthMaterial` on each ring is untouched, so the terrain still casts
  // its real shadow while this is on.
  // -------------------------------------------------------------------------
  let cheapTerrain = null;
  function terrainCheapMaterial() {
    if (cheapTerrain) return cheapTerrain;
    cheapTerrain = terrain.material.userData.createDepthMaterial();
    cheapTerrain.depthPacking = THREE.BasicDepthPacking;
    cheapTerrain.side = THREE.FrontSide;
    cheapTerrain.name = 'terrain-ablated';
    return cheapTerrain;
  }

  function setTerrainShader(on) {
    const mat = on ? terrain.material : terrainCheapMaterial();
    for (const l of terrain.levels) l.mesh.material = mat;
  }

  // -------------------------------------------------------------------------
  // Shadows. Flipping `renderer.shadowMap.enabled` removes both the shadow
  // render passes and the PCF sampling from every lit fragment shader, but the
  // shadow defines are baked into the program cache key, so every material in
  // the scene relinks. That is a one-off multi-frame stall on the toggle — the
  // panel says so — and it is why this is not something to hammer.
  // -------------------------------------------------------------------------
  function setShadows(on) {
    renderer.shadowMap.enabled = on;
    scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) for (const x of m) x.needsUpdate = true;
      else m.needsUpdate = true;
    });
    if (on) renderer.shadowMap.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Subsystems whose cost is partly CPU-side get their `update` neutered as
  // well as their mesh hidden — main.js walks the SYSTEMS array and calls
  // `s.update?.()` on the live object, so replacing the property is enough.
  // -------------------------------------------------------------------------
  const stashed = new Map();
  function setUpdate(sys, key, on) {
    if (!sys) return;
    if (on) {
      if (stashed.has(key)) { sys.update = stashed.get(key); stashed.delete(key); }
    } else if (!stashed.has(key)) {
      stashed.set(key, sys.update);
      sys.update = () => {};
    }
  }

  const setVisible = (list, on) => { for (const o of list) o.visible = on; };

  // -------------------------------------------------------------------------
  // The nine. `hint` is what the panel prints next to each row: an honest note
  // about what the arm does and does not isolate, because the whole point of
  // this file is a number somebody can trust.
  // -------------------------------------------------------------------------
  const TOGGLES = [
    {
      key: '1', name: 'Snow spray',
      hint: '34k particle slots, alpha-blended over the near frame',
      apply(on) { setVisible(spray?.mesh ? [spray.mesh] : [], on); setUpdate(spray, 'spray', on); },
    },
    {
      key: '2', name: 'Other skiers',
      hint: '5 instanced rigs + their puffs, recycled around the player',
      apply(on) { setVisible(riderMeshes(), on); },
    },
    {
      key: '3', name: 'Trees & forest',
      hint: 'tree LOD0/1, impostor cards, cluster + canopy-mass cards',
      apply(on) { setVisible(treeMeshes(), on); },
    },
    {
      key: '4', name: 'World props',
      hint: 'rocks, drifts, logs, both lifts, buildings, nets, banners',
      apply(on) { setVisible(propMeshes(), on); },
    },
    {
      key: '5', name: 'Ski tracks',
      hint: 'trench ribbon + the deformation render target it stamps',
      apply(on) { setVisible(tracks?.mesh ? [tracks.mesh] : [], on); setUpdate(tracks, 'tracks', on); },
    },
    {
      key: '6', name: 'Shadows',
      hint: 'both cascades — RELINKS EVERY SHADER, expect a stall on the toggle',
      apply(on) { setShadows(on); },
    },
    {
      key: '7', name: 'Sky dome',
      hint: 'drawn last with early-Z, so this only pays for visible sky',
      apply(on) { setVisible(skyMesh(), on); },
    },
    {
      key: '8', name: 'Post chain',
      hint: 'TAA, bloom, DoF, motion blur, grade, film — one blit instead',
      apply(on) { if (postfx) postfx.enabled = on; },
    },
    {
      key: '9', name: 'Terrain snow shader',
      hint: 'same vertex program + displacement, depth-grey fragments',
      apply(on) { setTerrainShader(on); },
    },
  ];

  /** `on` per toggle; true means the subsystem is running. */
  const enabled = TOGGLES.map(() => true);

  /**
   * The DOM HUD. Not one of the nine, because it is not WebGL and no WebGL
   * ablation can see it: a full-viewport DOM tree that rewrites text every
   * frame is repainted and recomposited by the browser AFTER our rAF returns,
   * so its cost lands in the gap between frames and looks like "the GPU is
   * slow". Worth one key of its own.
   */
  let hudOn = true;
  function setHud(on) {
    hudOn = on;
    const el = document.getElementById('alp-hud');
    if (el) el.style.display = on ? '' : 'none';
  }

  // Start from whatever scale the adaptive controller had already settled on,
  // rather than assuming 100%. Assuming it would mean the first press of `0`
  // silently RAISED the resolution on a machine that had stepped down to cope,
  // and every reading after that described a build the player never runs.
  const nearestRes = (s) => {
    let best = 0;
    for (let i = 1; i < RES_STEPS.length; i++) {
      if (Math.abs(RES_STEPS[i] - s) < Math.abs(RES_STEPS[best] - s)) best = i;
    }
    return best;
  };
  let resIdx = nearestRes(gfx.info().resolutionScale);

  /**
   * Compact signature of the current arm, e.g. `12--5----@100%`. The scale is
   * read live rather than from `resIdx`, so a row can never claim a resolution
   * the frame was not rendered at.
   */
  function signature() {
    const off = TOGGLES.map((t, i) => (enabled[i] ? '-' : t.key)).join('');
    const info = gfx.info();
    // A pinned pixel ratio overrides the scale entirely, so quoting the scale
    // then would name a resolution nothing was rendered at.
    const res = info._explicitPixelRatio != null
      ? `dpr${info._explicitPixelRatio}` : `${Math.round(info.resolutionScale * 100)}%`;
    return `${off}${hudOn ? '' : 'H'}@${res}`;
  }

  function setToggle(i, on) {
    if (enabled[i] === on) return;
    // An ablation with the controller live measures the controller: it sees the
    // frame get cheaper and spends the win on pixels.
    holdResolution();
    enabled[i] = on;
    try { TOGGLES[i].apply(on); } catch (e) {
      console.warn(`[dbg] toggle ${TOGGLES[i].name} failed:`, e);
      enabled[i] = !on;
    }
    render();
  }

  function setRes(i) {
    holdResolution();
    resIdx = ((i % RES_STEPS.length) + RES_STEPS.length) % RES_STEPS.length;
    gfx.setResolutionScale(RES_STEPS[resIdx]);
    render();
  }

  // -------------------------------------------------------------------------
  // Adaptive resolution: frozen for as long as the panel exists. Without this
  // the controller cancels out every win you measure — see the header.
  // -------------------------------------------------------------------------
  /**
   * MEASURED, and the reason this is not simply held for the session.
   *
   * The first cut of this panel called `gfx.freeze()` on construction. Because
   * the panel loads automatically under `pnpm dev`, that DISABLED the shipped
   * adaptive resolution controller in every dev session — `gfx.info()` reported
   * `_nSamples: 0` and `lastDecision: null` after 14 seconds, i.e. the
   * controller had not looked at a single frame. It also silently broke
   * `tools/adaptive-test.mjs`, which drives the dev server: `step-down` and
   * `force-dpr1` started failing with `events 0`, and because the panel was
   * present in BOTH arms of an A/B against `git HEAD`, the failure looked
   * pre-existing. A debug tool that changes the thing it measures, in the
   * default configuration, for every consumer, is worse than no tool.
   *
   * So the controller runs normally until something is done that a moving
   * resolution would corrupt — an ablation, a manual resolution change, or a
   * measurement. Those call `holdResolution()`. Until then `pnpm dev` behaves
   * exactly like a production session, which is the only way any of this
   * panel's numbers describe the game anyone actually plays.
   */
  let frozen = false;
  function setFrozen(on) {
    if (on === frozen) return;
    if (on) gfx.freeze(); else gfx.unfreeze();
    frozen = on;
    render();
  }
  /** Pin the resolution for a measurement or an ablation. Idempotent. */
  const holdResolution = () => setFrozen(true);

  // -------------------------------------------------------------------------
  // Frame-interval ring. Deliberately NOT `harness.perf`: starting that swaps
  // main.js onto its instrumented update path, and the panel should measure the
  // frame the player is actually getting.
  // -------------------------------------------------------------------------
  const RING = 180;
  const ring = new Float32Array(RING);
  let ringN = 0, ringHead = 0, lastT = performance.now();

  function ringStats(n = ringN) {
    const take = Math.min(n, ringN);
    if (take < 2) return null;
    const v = new Float64Array(take);
    for (let i = 0; i < take; i++) v[i] = ring[(ringHead - 1 - i + RING) % RING];
    const s = Float64Array.from(v).sort();
    let o20 = 0, o33 = 0;
    for (let i = 0; i < take; i++) { if (v[i] > 20) o20++; if (v[i] > 33) o33++; }
    return {
      n: take, p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99),
      max: s[take - 1], over20: o20, over33: o33,
    };
  }

  // Draw calls per FRAME. `renderer.info` is reset at the top of every
  // `renderer.render()` and the post chain makes a dozen per frame, so the
  // naive read reports the last fullscreen quad — `calls: 1`. Manual reset,
  // done from this module's rAF, which runs after main.js' (both re-register at
  // the top of their own callback, so the order established at boot holds).
  let ownInfo = false;
  let lastCalls = 0, lastTris = 0;

  // -------------------------------------------------------------------------
  // Measurement.
  // -------------------------------------------------------------------------
  const rows = [];
  let run = null;       // { mode, phase, t0, samples[], speedSum, speedN, label }

  function startRun(kind) {
    if (run) return;
    holdResolution();
    const settleMs = kind === 'bench' ? (CARVE.lead * 1000 + 400) : 400;
    run = {
      kind, phase: 'settle', until: performance.now() + settleMs,
      samples: [], speedSum: 0, speedN: 0, calls: 0, callsN: 0,
    };
    if (kind === 'bench') {
      harness.setPlayer(HERO_START[0], HERO_START[1], HERO_START[2]);
      run.t0 = performance.now();
      // controls.js reads `.steer/.crouch/.brake/.jump` off this object every
      // frame, so a plain object rewritten per frame is enough — no second rAF.
      window.__inputOverride = { steer: 0, crouch: 1, brake: 0, jump: false };
    }
    render();
  }

  /** controls.js samples `__inputOverride` every frame; keep it current. */
  function driveCarve(now, t0) {
    const ov = window.__inputOverride;
    if (!ov) return;
    const c = carveAt((now - t0) / 1000);
    ov.steer = c.steer;
    ov.crouch = c.crouch;
  }

  function tickRun(now, dtMs) {
    if (scripted) driveCarve(now, scripted.t0);
    if (!run) return;
    if (run.kind === 'bench') driveCarve(now, run.t0);
    if (run.phase === 'settle') {
      if (now >= run.until) { run.phase = 'record'; run.until = now + 6000; }
      return;
    }
    run.samples.push(dtMs);
    run.speedSum += state.speed || 0; run.speedN++;
    if (lastCalls) { run.calls += lastCalls; run.callsN++; }
    if (now >= run.until) finishRun();
  }

  function finishRun() {
    const v = Float64Array.from(run.samples).sort();
    let o20 = 0, o33 = 0;
    for (const x of run.samples) { if (x > 20) o20++; if (x > 33) o33++; }
    const info = gfx.info();
    rows.push({
      kind: run.kind, cfg: signature(),
      n: v.length,
      p50: pct(v, 0.5), p95: pct(v, 0.95), p99: pct(v, 0.99), max: v[v.length - 1],
      over20: o20, over33: o33,
      mpx: info.megapixels,
      calls: run.callsN ? Math.round(run.calls / run.callsN) : 0,
      speed: run.speedN ? (run.speedSum / run.speedN) * 3.6 : 0,
    });
    if (run.kind === 'bench') window.__inputOverride = null;
    run = null;
    console.table(rows.map((r) => ({
      run: r.kind, config: r.cfg, 'p50 ms': r2(r.p50), 'p99 ms': r2(r.p99),
      'over 20ms': `${Math.round((100 * r.over20) / r.n)}%`, Mpx: r.mpx,
      calls: r.calls, 'km/h': Math.round(r.speed),
    })));
    render();
  }

  /**
   * What Δp50 is measured against. An all-on row is the meaningful reference —
   * "how much did switching this off buy" — so it wins over row order; without
   * one, the first row measured is the best available anchor.
   */
  const baseRow = () => rows.find((r) => r.cfg.startsWith('---------')) || rows[0];

  // -------------------------------------------------------------------------
  // Diagnosis. See the header for what this answers that the nine cannot.
  // -------------------------------------------------------------------------

  /** Frame-driven timers, so a phase can await real presented frames. */
  const waiters = [];
  const waitMs = (ms) => new Promise((res) => waiters.push({ at: performance.now() + ms, res }));
  let collecting = null;
  let quiet = false;          // suppress panel repaints inside a window
  let note = '';
  let diagnosis = null;

  async function collect(ms) {
    collecting = [];
    await waitMs(ms);
    const v = collecting;
    collecting = null;
    return v;
  }

  function summarise(v) {
    if (!v || v.length < 4) return null;
    const s = Float64Array.from(v).sort();
    let o20 = 0, o33 = 0;
    for (const x of v) { if (x > 20) o20++; if (x > 33) o33++; }
    return {
      n: v.length, min: s[0], p10: pct(s, 0.1), p25: pct(s, 0.25), p50: pct(s, 0.5),
      p95: pct(s, 0.95), p99: pct(s, 0.99),
      max: s[s.length - 1], over20: o20, over33: o33,
    };
  }

  /**
   * Everything about this machine that changes what the numbers mean. The
   * renderer string is first because a software rasteriser explains "slow, and
   * nothing I switch off helps" completely, and nothing else in this file
   * would ever reveal it.
   */
  function snapshotEnv() {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const info = gfx.info();
    const glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '(masked)';
    return {
      glRenderer,
      glVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '(masked)',
      software: /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(glRenderer),
      devicePixelRatio,
      window: [innerWidth, innerHeight],
      screen: [screen.width, screen.height],
      backbuffer: info.drawingBuffer,
      megapixels: info.megapixels,
      resolutionScale: info.resolutionScale,
      maxPixelRatio: info.maxPixelRatio,
      adaptive: info.adaptive,
      build: harness.dev ? 'vite dev (dev-only branches ARE live)' : 'production bundle',
      cores: navigator.hardwareConcurrency,
      hidden: document.hidden,
    };
  }

  /**
   * Nearest plausible refresh rate to a measured tick, or null if it is odd.
   *
   * 8% and not 6%: the estimator is a low percentile of presented intervals and
   * Chrome's begin-frame jitter puts a few of them a fraction under the true
   * tick, so a clean 60 Hz lock estimates at ~15.7 ms = 63.7 Hz. A 6% band
   * rejected that and reported "not a standard refresh" for an ordinary
   * display; the gaps between real refresh rates are far wider than 8%.
   */
  function refreshFor(minMs) {
    const hz = 1000 / minMs;
    let best = null, bestErr = 0.08;
    for (const r of [240, 165, 144, 120, 100, 90, 75, 60, 50, 48, 30, 24]) {
      const err = Math.abs(hz - r) / r;
      if (err < bestErr) { best = r; bestErr = err; }
    }
    return best;
  }

  let busy = false;
  // Display tick. `engine.js`' controller estimates this continuously from the
  // spacing of presented intervals and is the better source — it sees the whole
  // session, where this panel only sees its own floor window. Fall back to the
  // floor estimate when the controller has not settled on one (below MIN_MPX it
  // never runs at all).
  let floorTick = 0;
  const tickMs = () => gfx.info().displayTick || floorTick;
  let scripted = null;        // { t0 } — drives the canonical carve from tick()
  const sweepRows = [];

  /**
   * Where a frame time sits on the display's vsync ladder. This is the whole
   * reason a 23.5 ms frame on a 144 Hz panel feels worse than a 20.8 ms one:
   * 20.8 is a rung and presents cleanly, 23.5 is between rungs and presents as
   * an alternating mix. `clean` is what you are actually trying to buy.
   */
  function rungOf(ms) {
    const T = tickMs();
    if (!T || !(ms > 0)) return null;
    const k = Math.max(1, Math.round(ms / T));
    const at = k * T;
    return { k, at, hz: 1000 / at, clean: Math.abs(ms - at) < T * 0.18 };
  }

  /**
   * Resolution sweep. Pixels are the one lever that is continuous, so the
   * question "can this machine reach the next rung down at all" is answered by
   * walking the ladder — not by ablating subsystems one at a time.
   *
   * Every rung is measured from the SAME start with the SAME scripted carve:
   * the forest belt costs more than the open piste, so letting the run
   * continue between rungs would confound resolution with terrain.
   */
  async function sweep() {
    if (busy || run) return;
    busy = true;
    holdResolution();
    const savedScale = gfx.info().resolutionScale;
    const savedExplicitPR = gfx.info()._explicitPixelRatio;
    sweepRows.length = 0;
    const SW = [1.0, 0.85, 0.75, 0.6, 0.5, 0.4];
    try {
      window.__inputOverride = { steer: 0, crouch: 1, brake: 0, jump: false };
      for (let i = 0; i < SW.length; i++) {
        quiet = false;
        note = `resolution sweep ${i + 1}/${SW.length} — ${Math.round(SW[i] * 100)}%…`;
        render();
        quiet = true;
        gfx.setResolutionScale(SW[i]);
        harness.setPlayer(HERO_START[0], HERO_START[1], HERO_START[2]);
        scripted = { t0: performance.now() };
        await waitMs(CARVE.lead * 1000 + 600);
        const iv = summarise(await collect(2500));
        const info = gfx.info();
        if (iv) sweepRows.push({ scale: SW[i], mpx: info.megapixels, ...iv });
      }
    } catch (e) {
      console.warn('[dbg] sweep failed:', e);
    } finally {
      scripted = null;
      window.__inputOverride = null;
      gfx.setResolutionScale(savedScale);
      if (savedExplicitPR !== null && savedExplicitPR !== undefined) gfx.setPixelRatio(savedExplicitPR);
      quiet = false;
      note = '';
      busy = false;
      console.log(sweepText());
      render();
    }
  }

  function sweepText() {
    if (!sweepRows.length) return '';
    const T = tickMs();
    const head = T
      ? `resolution sweep · display tick ${r2(T)} ms ≈ ${Math.round(1000 / T)} Hz`
        + ` · rungs ${[1, 2, 3, 4].map((k) => r2(k * T)).join(' / ')} ms`
      : 'resolution sweep (run D first for the display tick)';
    const body = sweepRows.map((r) => {
      const g = rungOf(r.p50);
      return [`${Math.round(r.scale * 100)}%`, `${r.mpx} Mpx`, `p50 ${r2(r.p50)}`,
        `p99 ${r2(r.p99)}`, `>20ms ${Math.round((100 * r.over20) / r.n)}%`,
        g ? `${g.clean ? 'locked' : 'between rungs'} ${r2(g.at)} ms ≈ ${Math.round(g.hz)} Hz` : '',
      ].join('\t');
    });
    return [head, ...body].join('\n');
  }

  async function diagnose() {
    if (busy || run) return;
    busy = true;
    holdResolution();
    const env = snapshotEnv();
    const savedToggles = enabled.slice();
    const savedScale = gfx.info().resolutionScale;
    // `setResolutionScale` clears an explicitly pinned pixel ratio (engine.js),
    // and the floor phase calls it. Without this, running a diagnosis inside a
    // session that had pinned the backbuffer — every tool in tools/ does —
    // would silently hand back a different resolution than it borrowed.
    const savedExplicitPR = gfx.info()._explicitPixelRatio;
    const savedShadowAuto = renderer.shadowMap.autoUpdate;
    diagnosis = null;

    try {
      // --- A: the frame as it ships -----------------------------------------
      note = '1/3 — measuring the frame as it ships…';
      render();
      quiet = true;
      harness.perf.start({ capacity: 2000 });
      const shippedIv = summarise(await collect(4000));
      const rep = harness.perf.stop();

      // --- B: the floor ------------------------------------------------------
      // Everything this game draws, removed. Shadows are frozen rather than
      // switched off: toggle 6 relinks every shader in the scene, and a
      // multi-second link storm inside a timing window is worse than the two
      // scene passes it would have saved on an already-empty scene.
      quiet = false;
      note = '2/3 — measuring the floor: no sim, empty scene, 25% resolution…';
      render();
      quiet = true;
      window.__setAuto?.(false);
      renderer.shadowMap.autoUpdate = false;
      for (let i = 0; i < TOGGLES.length; i++) if (i !== 5) setToggle(i, false);
      setHud(false);
      gfx.setResolutionScale(0.25);
      await waitMs(1500);
      const floorIv = summarise(await collect(3000));

      // --- C: put it all back ------------------------------------------------
      quiet = false;
      note = '3/3 — restoring…';
      render();
      quiet = true;
      // Scale first, then the pin: `setPixelRatio` overrides the scale but does
      // not reset it, and leaving 0.25 behind in the engine would have the
      // panel reporting a resolution the frame is not rendered at.
      gfx.setResolutionScale(savedScale);
      if (savedExplicitPR !== null && savedExplicitPR !== undefined) gfx.setPixelRatio(savedExplicitPR);
      renderer.shadowMap.autoUpdate = savedShadowAuto;
      for (let i = 0; i < TOGGLES.length; i++) setToggle(i, savedToggles[i]);
      setHud(true);
      window.__setAuto?.(true);
      await waitMs(600);

      floorTick = floorIv ? floorIv.p25 : 0;
      diagnosis = verdict(env, shippedIv, floorIv, rep);
      console.log(diagnosisText());
      console.log('[dbg] raw:', { env, shipped: shippedIv, floor: floorIv, perf: rep });
    } catch (e) {
      console.warn('[dbg] diagnosis failed:', e);
      diagnosis = { lines: ['diagnosis failed: ' + (e?.message ?? e)], env, headline: 'error' };
    } finally {
      quiet = false;
      note = '';
      busy = false;
      render();
    }
  }

  /**
   * Turn the two windows into a statement. The ordering matters: the first
   * question is always "is the renderer the pacer at all", because if it is not
   * then every per-subsystem number below it is a distraction.
   */
  function verdict(env, shipped, floor, rep) {
    const lines = [];
    const L = [];
    if (!shipped || !floor) return { headline: 'not enough frames', lines: ['window too short'], env };

    // p25, not min and not p10: the minimum can be one short interval after a
    // long one (reading as twice the real refresh), and p10 sits inside
    // Chrome's begin-frame jitter and estimates a clean 60 Hz lock at 63.7 Hz.
    // The lower quartile of an almost-empty scene is the tick the compositor
    // is actually offering.
    const tick = gfx.info().displayTick || floor.p25;
    const hz = refreshFor(tick);
    const gain = shipped.p50 - floor.p50;
    const rendererIsPacer = gain > Math.max(2, shipped.p50 * 0.2);
    // Is the SHIPPED frame simply hitting the refresh? If so the interval is
    // vsync and no amount of ablation can move it — the complaint, if there is
    // one, is about the tail.
    const meeting = shipped.p50 <= tick * 1.15;

    let headline;
    if (env.software) {
      headline = 'NO GPU — this page is rendering in software';
      L.push(`the WebGL renderer is "${env.glRenderer}", a software rasteriser.`);
      L.push('nothing in this codebase can be optimised around that. Turn on hardware');
      L.push('acceleration in the browser (chrome://gpu will say why it is off).');
    } else if (rendererIsPacer) {
      headline = 'THE SCENE IS THE COST';
      L.push(`emptying the scene took p50 ${r2(shipped.p50)} → ${r2(floor.p50)} ms,`);
      L.push(`i.e. ${r2(gain)} ms of the frame is work this game does — the toggles`);
      L.push('above can find it. Ablate one at a time and watch p50, not fps.');
      L.push(`floor / display tick: ${r2(tick)} ms${hz ? ` ≈ ${hz} Hz` : ''}`);
    } else if (meeting) {
      headline = hz && hz <= 30
        ? `THE DISPLAY IS PACING AT ${hz} Hz`
        : 'THE FRAME IS MEETING THE REFRESH — throughput is not the problem';
      L.push(`stripping the scene to nothing moved p50 only ${r2(gain)} ms`);
      L.push(`(${r2(shipped.p50)} → ${r2(floor.p50)} ms), and the full frame already sits`);
      L.push(`on the ${r2(tick)} ms tick${hz ? ` (≈ ${hz} Hz)` : ''}. The interval is vsync, not work.`);
      L.push('That is why every toggle read the same: there was nothing to win.');
      if (hz && hz <= 30) {
        L.push('');
        L.push(`  → but ${hz} Hz is the whole complaint. That is the DISPLAY, not the game:`);
        L.push('    an external monitor at 4K@30 over HDMI, a mirrored or scaled display,');
        L.push('    macOS Low Power Mode, or Chrome\'s Energy Saver. Check the refresh rate');
        L.push('    in System Settings → Displays before touching any more code.');
      } else {
        L.push('');
        L.push('  → so if it still feels bad, the complaint is STUTTER, not frame rate.');
        L.push('    Read the tail below — p99, over-33 and shader links — not p50.');
      }
    } else {
      headline = 'SOMETHING OUTSIDE THE RENDERER IS EATING THE FRAME';
      L.push(`with the scene EMPTY, no simulation and a quarter-resolution backbuffer,`);
      L.push(`the frame still takes ${r2(floor.p50)} ms against a ${r2(tick)} ms tick`);
      L.push(`${hz ? `(≈ ${hz} Hz)` : ''} — and the full scene only costs ${r2(gain)} ms more.`);
      L.push('So this is not the renderer and it is not vsync. Look at, in order:');
      L.push('  · the DOM HUD — key H. It repaints outside our rAF and no WebGL');
      L.push('    ablation can see it.');
      L.push('  · other tabs, extensions, or a screen recorder sharing the GPU.');
      L.push('  · the compositor: a scaled/mirrored display, or a very large window.');
      L.push('  · the "outside our code" figure below — that is the browser, not us.');
    }
    if (env.hidden) L.push('  → document.hidden is TRUE: the tab is throttled by the browser.');

    // CPU split. `rep.update` and `rep.render` are wall time inside our own two
    // calls; whatever is left of the interval is the browser, the driver and
    // the wait for the swap — and if that residue is most of the frame, no
    // amount of JavaScript is the answer.
    const upd = rep?.update?.p50 ?? 0;
    const rnd = rep?.render?.p50 ?? 0;
    const outside = Math.max(0, shipped.p50 - upd - rnd);
    L.push('');
    L.push(`where the ${r2(shipped.p50)} ms goes:  update ${r2(upd)} ms`
      + `  ·  submit ${r2(rnd)} ms  ·  GPU + swap wait ${r2(outside)} ms`);
    L.push('  (a large "GPU + swap wait" is NORMAL when the frame meets vsync — it is'
      + ' the wait,\n   not a cost. It only means something when the frame is missing.)');
    if (upd > 4) {
      const top = Object.entries(rep.sys || {}).sort((a, b) => b[1].p50 - a[1].p50).slice(0, 4);
      L.push(`  → CPU-bound in update. Heaviest: ${top.map(([k, v]) => `${k} ${r2(v.p50)}`).join(', ')} ms`);
    }
    if (rnd > 8 && !rendererIsPacer) {
      L.push('  → submit is expensive but the scene is not the pacer: that is draw-call');
      L.push(`    overhead on the main thread (${rep.drawCalls?.last ?? '?'} calls/frame).`);
    }

    L.push('');
    L.push(`tail: ${shipped.over20}/${shipped.n} frames over 20 ms, `
      + `${shipped.over33}/${shipped.n} over 33 ms · p99 ${r2(shipped.p99)} · max ${r2(shipped.max)} ms`);
    if (rep?.shaderLinks?.length) {
      L.push(`  → ${rep.shaderLinks.length} shader link(s) DURING the window — each one is a`);
      L.push('    multi-frame stall. That is a hitch, not a frame-rate problem.');
    }

    // What the shipped controller is aiming at, and whether the target is even
    // on this panel's ladder. On 60 and 120 Hz it always is and this is a
    // formality; on 144 Hz it is the difference between a clean lock and a
    // permanent two-rung alternation.
    const info = gfx.info();
    if (info.vsyncLadder) {
      const onLadder = Math.abs(info.lockMs - 1000 / info.targetFps) < 0.2;
      L.push('');
      L.push(`adaptive target: ${info.targetFps} fps = ${r2(1000 / info.targetFps)} ms`
        + ` → aiming at the ${r2(info.lockMs)} ms rung (${Math.round(1000 / info.lockMs)} fps)`);
      if (!onLadder) {
        L.push(`  → ${info.targetFps} fps is NOT on this panel's ladder`
          + ` (${info.vsyncLadder.map((v) => r2(v)).join(' / ')} ms).`);
        L.push(`    The reachable rates are ${info.vsyncLadder
          .map((v) => Math.round(1000 / v)).join(' / ')} fps and nothing between them.`);
        // The next rung DOWN in frame rate is the next one UP in milliseconds.
        // Found by value rather than by index: `lockMs` and the ladder are both
        // rounded for display, so an equality search on them is fragile.
        const nextRung = info.vsyncLadder.find((v) => v > info.lockMs + 0.1);
        if (nextRung) {
          L.push(`    Aiming at ${Math.round(1000 / info.lockMs)} fps costs resolution;`
            + ` ?fpstarget=${Math.round(1000 / nextRung)} picks the next rung down`);
          L.push('    and buys a lot of it back, for a lock that is just as smooth.');
        }
      }
    }

    L.push('');
    L.push(`gpu:        ${env.glRenderer}`);
    L.push(`window:     ${env.window[0]}×${env.window[1]} css · DPR ${env.devicePixelRatio}`
      + ` · screen ${env.screen[0]}×${env.screen[1]}`);
    L.push(`backbuffer: ${env.backbuffer[0]}×${env.backbuffer[1]} = ${env.megapixels} Mpx`
      + ` at ${Math.round(env.resolutionScale * 100)}% scale`);
    L.push(`build:      ${env.build}`);
    if (harness.dev) {
      L.push('  → dev build. Some costs here do not exist in `pnpm build && pnpm preview`;');
      L.push('    if the numbers matter, confirm them against a production bundle.');
    }
    lines.push(...L);
    return { headline, lines, env, shipped, floor };
  }

  function diagnosisText() {
    if (!diagnosis) return '';
    return `── perf diagnosis ─────────────────────────────\n${diagnosis.headline}\n\n`
      + diagnosis.lines.join('\n') + '\n───────────────────────────────────────────────';
  }

  function tableText() {
    const base = baseRow();
    const head = ['config', 'run', 'n', 'p50', 'p99', 'max', '>20ms', '>33ms', 'Mpx', 'calls', 'km/h', 'Δp50'];
    const body = rows.map((r) => [
      r.cfg, r.kind, r.n, r2(r.p50), r2(r.p99), r2(r.max),
      `${Math.round((100 * r.over20) / r.n)}%`, `${Math.round((100 * r.over33) / r.n)}%`,
      r.mpx, r.calls, Math.round(r.speed),
      base && base !== r ? `${r.p50 - base.p50 > 0 ? '+' : ''}${r2(r.p50 - base.p50)}` : '',
    ].join('\t'));
    const table = rows.length ? [head.join('\t'), ...body].join('\n') : '(no ablation rows)';
    return [diagnosis ? diagnosisText() : '', sweepText(), table]
      .filter(Boolean).join('\n\n');
  }

  // -------------------------------------------------------------------------
  // DOM.
  // -------------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
#alp-dbg{position:fixed;left:10px;top:10px;z-index:9999;font:11px/1.45 ui-monospace,
 SFMono-Regular,Menlo,monospace;color:#dfe7ee;background:rgba(8,12,18,.82);
 border:1px solid rgba(150,180,210,.22);border-radius:6px;padding:8px 10px;
 max-width:640px;user-select:none}
/* No backdrop-filter. It re-blurs a fullscreen canvas on the compositor every
   frame, which is a real cost that would land inside the very measurement this
   panel exists to take — and hud.js already refuses it for the same reason. */
#alp-dbg.hidden{display:none}
#alp-dbg s{text-decoration:none;color:#7f93a6}
#alp-dbg h4{margin:0 0 5px;font:600 11px/1.3 inherit;letter-spacing:.09em;
 text-transform:uppercase;color:#8fb4d6}
#alp-dbg .now{margin:0 0 7px;font-size:12px}
#alp-dbg .now b{color:#fff;font-weight:600}
#alp-dbg .now s{color:#7f93a6;text-decoration:none}
#alp-dbg .warn{color:#e8b25c}
#alp-dbg ul{list-style:none;margin:0 0 7px;padding:0}
#alp-dbg li{display:flex;gap:7px;align-items:baseline;cursor:pointer;padding:1px 3px;
 border-radius:3px;margin:0 -3px}
#alp-dbg li:hover{background:rgba(120,160,200,.14)}
#alp-dbg li em{font-style:normal;color:#6f8496;width:9px;flex:none}
#alp-dbg li span{width:152px;flex:none}
#alp-dbg li i{font-style:normal;color:#66798a;font-size:10px;overflow:hidden;
 white-space:nowrap;text-overflow:ellipsis}
#alp-dbg li.off span{color:#e0623f}
#alp-dbg li.off em{color:#e0623f}
#alp-dbg li.on span{color:#9fd6a2}
#alp-dbg .keys{color:#6f8496;font-size:10px;border-top:1px solid rgba(150,180,210,.16);
 padding-top:5px;margin-top:2px}
#alp-dbg .keys b{color:#a9c4dc;font-weight:600}
#alp-dbg table{border-collapse:collapse;margin:6px 0 2px;font-size:10px;width:100%}
#alp-dbg th{text-align:right;color:#6f8496;font-weight:400;padding:1px 5px 1px 0}
#alp-dbg td{text-align:right;padding:1px 5px 1px 0;color:#c6d4e0}
#alp-dbg th:first-child,#alp-dbg td:first-child{text-align:left}
#alp-dbg td.win{color:#9fd6a2}
#alp-dbg td.lose{color:#e0623f}
#alp-dbg .busy{color:#e8b25c;margin:4px 0 0}
#alp-dbg .diag{white-space:pre-wrap;font-size:10.5px;line-height:1.5;margin:6px 0 0;
 padding:6px 8px;background:rgba(20,30,44,.72);border-left:2px solid #8fb4d6;
 border-radius:3px;color:#c6d4e0}
#alp-dbg .diag b{display:block;color:#e8b25c;letter-spacing:.06em;margin-bottom:4px}`;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'alp-dbg';
  // Hidden at boot. `pnpm dev` must look and behave like the real game until
  // somebody asks it not to — see holdResolution().
  root.className = 'hidden';
  document.body.appendChild(root);

  root.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) setToggle(+li.dataset.i, !enabled[+li.dataset.i]);
  });

  let visible = false;
  let lastPaint = 0;

  function render(now = performance.now()) {
    if (!visible) return;
    lastPaint = now;
    const s = ringStats(120);
    const info = gfx.info();
    const live = s
      ? `<b>${r2(s.p50)} ms</b> <s>p50</s>  <b>${r2(s.p99)}</b> <s>p99</s>  `
        + `<b>${s.over20}</b><s>/${s.n} &gt;20ms</s>  <s>≈</s><b>${Math.round(1000 / s.p50)}</b><s> fps</s>`
      : 'warming up…';
    // The presented interval is quantised to the display tick, so a frame with
    // headroom reports the tick and NOTHING else — every arm reads the same and
    // the honest conclusion is "cannot tell from here", not "nothing helps".
    const censored = s && s.over20 === 0 && s.p99 < s.p50 * 1.3;
    // Where the current frame sits on the display's ladder. On a high-refresh
    // panel this is most of the story: 20.8 ms locks cleanly at 144 Hz and
    // 23.5 ms does not, and the difference is felt long before it is measured.
    const g = s && rungOf(s.p50);
    const ladder = g
      ? `<br><s>tick</s> <b>${r2(tickMs())} ms</b> <s>≈ ${Math.round(1000 / tickMs())} Hz · rungs</s> `
        + [1, 2, 3, 4].map((k) => (k === g.k ? `<b>${r2(k * tickMs())}</b>` : r2(k * tickMs()))).join(' / ')
        + ` <s>ms</s> — ${g.clean
          ? `<b>locked to ${Math.round(g.hz)} Hz</b>`
          : '<span class="warn">between rungs: this presents as judder</span>'}`
      : '';

    const cfgRows = TOGGLES.map((t, i) => `<li data-i="${i}" class="${enabled[i] ? 'on' : 'off'}">`
      + `<em>${t.key}</em><span>${enabled[i] ? '' : '✕ '}${t.name}</span><i>${t.hint}</i></li>`).join('');

    const base = baseRow();
    const table = rows.length ? `<table><tr>
      <th>config</th><th>p50</th><th>p99</th><th>&gt;20ms</th><th>Mpx</th><th>calls</th><th>km/h</th><th>Δp50</th></tr>`
      + rows.map((r) => {
        const d = base && base !== r ? r.p50 - base.p50 : null;
        const cls = d === null ? '' : d < -0.5 ? 'win' : d > 0.5 ? 'lose' : '';
        return `<tr><td>${r.cfg}${r.kind === 'live' ? ' <s>live</s>' : ''}</td>`
          + `<td>${r2(r.p50)}</td><td>${r2(r.p99)}</td>`
          + `<td>${Math.round((100 * r.over20) / r.n)}%</td><td>${r.mpx}</td>`
          + `<td>${r.calls}</td><td>${Math.round(r.speed)}</td>`
          + `<td class="${cls}">${d === null ? '—' : (d > 0 ? '+' : '') + r2(d)}</td></tr>`;
      }).join('') + '</table>'
      + (rows.every((r) => r.over20 === 0)
        ? '<p class="busy">every row met vsync — these Δp50s are all zero because the'
          + ' frame had headroom, not because the arms are free.</p>' : '')
      : '';

    const busyMsg = run
      ? `<p class="busy">${run.kind === 'bench' ? 'benchmark' : 'live measure'}: `
        + `${run.phase === 'settle' ? 'settling' : `recording ${run.samples.length} frames`}…</p>`
      : '';

    const diag = diagnosis
      ? `<div class="diag"><b>${diagnosis.headline}</b>\n${diagnosis.lines.join('\n')}</div>` : '';

    const sweepTable = sweepRows.length ? `<table><tr><th>scale</th><th>Mpx</th><th>p50</th>
      <th>p99</th><th>&gt;20ms</th><th>presents as</th></tr>`
      + sweepRows.map((r) => {
        const rg = rungOf(r.p50);
        return `<tr><td>${Math.round(r.scale * 100)}%</td><td>${r.mpx}</td>`
          + `<td>${r2(r.p50)}</td><td>${r2(r.p99)}</td>`
          + `<td>${Math.round((100 * r.over20) / r.n)}%</td>`
          + `<td class="${rg && rg.clean ? 'win' : 'lose'}">${rg
            ? `${rg.clean ? 'locked' : 'judder'} ${Math.round(rg.hz)} Hz` : '—'}</td></tr>`;
      }).join('') + '</table>' : '';

    root.innerHTML = rootHTML(live, ladder, info, censored, cfgRows, diag, busyMsg, table, sweepTable);
  }

  /** Split out only so render() stays readable; no logic lives here. */
  function rootHTML(live, ladder, info, censored, cfgRows, diag, busyMsg, table, sweepTable) {
    return `<h4>perf ablation — dev only</h4>
      <p class="now">${live}<br>
        <s>backbuffer</s> <b>${info.drawingBuffer[0]}×${info.drawingBuffer[1]}</b>
        <s>= ${info.megapixels} Mpx · pixel ratio ${r2(info.pixelRatio)}
        (device ${info.devicePixelRatio}, scale ${Math.round(info.resolutionScale * 100)}%)</s>${ladder}
        &nbsp; <s>calls</s> <b>${lastCalls}</b>
        ${frozen ? '' : '<br><span class="warn">adaptive resolution is LIVE — it will eat your wins</span>'}
        ${censored ? '<br><span class="warn">frame is vsync-locked with headroom — differences cannot'
          + ' resolve here. Measure where it actually stutters.</span>' : ''}
      </p>
      <ul>${cfgRows}</ul>
      <div class="keys"><b>D</b> diagnose — start here &nbsp; <b>F</b> resolution sweep (~30 s) &nbsp;
        <b>0</b> resolution ${Math.round(info.resolutionScale * 100)}% &nbsp;
        <b>H</b> DOM hud ${hudOn ? 'on' : 'OFF'} &nbsp;
        <b>M</b> benchmark (hero + scripted carve) &nbsp; <b>L</b> measure live &nbsp;
        <b>R</b> reset &nbsp; <b>Z</b> all off &nbsp; <b>C</b> copy report &nbsp;
        <b>P</b> adaptive ${frozen ? 'frozen' : 'LIVE'} &nbsp; <b>\`</b> hide</div>
      ${note ? `<p class="busy">${note}</p>` : ''}${busyMsg}${diag}${sweepTable}${table}`;
  }

  // -------------------------------------------------------------------------
  // Keys.
  // -------------------------------------------------------------------------
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target?.tagName || '')) return;

    // Opening the panel is not itself a measurement, so it does NOT freeze the
    // resolution controller — see holdResolution(). Closing it hands the
    // controller back whatever happened while it was open, so a session can
    // never be left silently pinned behind a hidden panel.
    if (e.code === 'Backquote') {
      visible = !visible;
      root.classList.toggle('hidden', !visible);
      if (!visible) setFrozen(false);
      render();
      return;
    }
    if (!visible) return;

    // In the hut the number row is the drinks menu (controls.js `pick`).
    const digit = /^Digit([0-9])$/.exec(e.code) || /^Numpad([0-9])$/.exec(e.code);
    if (digit && state.mode !== 'hut') {
      const n = +digit[1];
      if (n === 0) setRes(resIdx + 1);
      else setToggle(n - 1, !enabled[n - 1]);
      return;
    }

    switch (e.code) {
      case 'KeyD': diagnose(); break;
      // NB `F`, not `S`: controls.js binds W/S to tuck and A/D to steer, so a
      // panel key on those doubles as a control input. `D` is the one
      // unavoidable overlap (steer right) and a tap of it is harmless — the
      // steer ramp needs a sustained hold to build any edge at all.
      case 'KeyF': sweep(); break;
      case 'KeyH': setHud(!hudOn); render(); break;
      case 'KeyM': startRun('bench'); break;
      case 'KeyL': startRun('live'); break;
      case 'KeyR':
        for (let i = 0; i < TOGGLES.length; i++) setToggle(i, true);
        setRes(0);
        setHud(true);
        setFrozen(false);      // back to a normal session
        break;
      case 'KeyZ':
        for (let i = 0; i < TOGGLES.length; i++) setToggle(i, false);
        break;
      case 'KeyP': setFrozen(!frozen); break;
      case 'KeyC':
        navigator.clipboard?.writeText(tableText());
        console.log(tableText());
        break;
      default: break;
    }
  });

  // -------------------------------------------------------------------------
  // Our own rAF. Registered after main.js' loop and re-registered at the top of
  // the callback, exactly as main.js does, so it stays behind the render for
  // the life of the session and the per-frame `info` read is a whole frame.
  // -------------------------------------------------------------------------
  function tick() {
    requestAnimationFrame(tick);
    const now = performance.now();
    const dtMs = now - lastT;
    lastT = now;
    ring[ringHead] = dtMs;
    ringHead = (ringHead + 1) % RING;
    if (ringN < RING) ringN++;
    if (collecting) collecting.push(dtMs);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (now >= waiters[i].at) { waiters[i].res(); waiters.splice(i, 1); }
    }

    // `harness.perf` takes `info` over while it records; don't fight it.
    if (visible && !harness.perf.recording) {
      if (!ownInfo) { renderer.info.autoReset = false; ownInfo = true; }
      lastCalls = renderer.info.render.calls;
      lastTris = renderer.info.render.triangles;
      renderer.info.reset();
    } else if (ownInfo) {
      // Hand `info` back exactly as it was found. Leaving autoReset false in a
      // hidden panel would quietly break anything else that reads it.
      renderer.info.autoReset = true;
      ownInfo = false;
    }

    tickRun(now, dtMs);
    // `quiet` holds the panel still inside a measurement window: rewriting
    // innerHTML forces a layout the frame would not otherwise pay for, and it
    // would land in the very interval being recorded.
    if (visible && !quiet && now - lastPaint > 250) render(now);
  }
  requestAnimationFrame(tick);

  // main.js warns once when `postfx.enabled === false`, on the grounds that the
  // scene then goes straight to a single-sampled default framebuffer. That
  // stopped being true when postfx.js started routing the ablation through the
  // composer with every optional pass off (postfx.js, `if (!api.enabled)`) —
  // exactly one fullscreen quad still touches the drawing buffer. The warning
  // would send whoever reads this panel's numbers chasing an AA regression that
  // does not exist, so it is silenced here rather than left to mislead.
  if (harness?.perf) harness.perf.checkFallback = () => {};

  render();

  const api = {
    toggles: TOGGLES.map((t) => t.name),
    get config() { return signature(); },
    set(i, on) { setToggle(i - 1, !!on); },
    resolution(scale) { setRes(RES_STEPS.indexOf(scale) >= 0 ? RES_STEPS.indexOf(scale) : resIdx); },
    bench() { startRun('bench'); },
    measure() { startRun('live'); },
    diagnose,
    sweep,
    sweepRows,
    get tickMs() { return tickMs(); },
    get diagnosis() { return diagnosis; },
    hud(on) { setHud(!!on); render(); },
    env: snapshotEnv,
    rows,
    table: tableText,
    stats: () => ringStats(),
    get triangles() { return lastTris; },
  };
  window.__dbg = api;
  return api;
}
