import * as THREE from 'three';
import { createEngine } from './core/engine.js';
import { createState } from './core/state.js';
import { Terrain } from './world/terrain.js';
import { createSky } from './world/sky.js';
import { createScatter } from './world/scatter.js';
import { createBranding } from './world/branding.js';
import { createDragLift } from './world/draglift.js';
import { createResort } from './game/resort.js';
import { createSkier } from './player/skier.js';
import { SkiPhysics } from './player/physics.js';
import { createControls } from './player/controls.js';
import { createChaseCam } from './player/camera.js';
import { createSpray } from './fx/spray.js';
import { createTracks } from './fx/tracks.js';
import { createPostFX } from './fx/postfx.js';
import { createAudio } from './audio/audio.js';
import { createHUD } from './ui/hud.js';

const container = document.getElementById('app');
const { renderer, scene, camera, gfx } = createEngine(container);

const state = createState();
const terrain = new Terrain();
scene.add(terrain.mesh ?? terrain.group);

const sky = createSky(scene, renderer);
const scatter = createScatter(scene, terrain);
const branding = createBranding(scene, terrain, scatter);
const skier = createSkier(scene);
const physics = new SkiPhysics(terrain);
const controls = createControls();
const chaseCam = createChaseCam(camera);
const spray = createSpray(scene);
const tracks = createTracks(scene, terrain);
const postfx = createPostFX(renderer, scene, camera);
const audio = createAudio();
const hud = createHUD();

// The second lift and the resort loop. `draglift` places itself off the CHAIR
// line (scatter's published placement seam), so both lifts move together if the
// corridor ever does; `resort` owns `state.mode` and every "the player is not
// skiing right now" case — see src/game/resort.js.
const draglift = createDragLift(scene, terrain, { towers: scatter.lift.towers });
const resort = createResort({
  scene, terrain, scatter, sky, camera, chaseCam, physics, skier, audio, draglift, state,
});

physics.reset(state, state.pos.x, state.pos.z, state.heading);

// The engine owns the backbuffer size (it also drives the resolution-scale knob),
// so postfx is resized from there rather than from a second resize listener —
// otherwise a `gfx.setResolutionScale()` would move the drawing buffer without
// postfx's render targets following it.
gfx.onResize((w, h) => postfx.setSize(w, h));
addEventListener('pointerdown', () => audio.start(), { once: true });
addEventListener('keydown', () => audio.start(), { once: true });

// Subsystems that need per-frame updates, in dependency order.
const SYSTEMS = [terrain, sky, scatter, draglift, branding, skier, spray, tracks, postfx, audio, hud];

/**
 * Subsystems that make no sense while the player is on the chair or inside the
 * hut: the rig is hidden, there are no edges on snow, and — the one that is a
 * real bug rather than wasted work — `tracks` would stamp a carve trench up the
 * whole piste from a chair twenty metres in the air, because it only knows how
 * to draw a ribbon between last frame's contact point and this one's.
 *
 * The T-bar deliberately is NOT in this case: a drag lift really does track its
 * own lane up the hill, and the rider is on his skis the whole way.
 */
const SUSPENDED = new Set([skier, spray, tracks]);
const rideSuspends = () => state.mode === 'lift' || state.mode === 'hut';

/**
 * The one subsystem that has to see the RIDE's clock rather than the wall clock.
 *
 * A chairlift is honest at 4.6 m/s and unwatchable at 4 km, so `resort` runs the
 * middle of a ride as a timelapse (`resort.timeScale`). The chairs coming the
 * other way are scatter's, integrated from its own `chairPhase += dt * 4.6`, and
 * the whole reason resort copies that 4.6 is to stay in step with them. Scaling
 * one and not the other would put the player's chair through the down-side line
 * at eight times the closing speed — so scatter gets the same clock.
 *
 * Nothing else does. The clouds, the wind, the audio and the HUD's smoothing all
 * want real seconds, and none of them are in shot next to a moving reference.
 */
const dtFor = (sys, dt) => (sys === scatter ? dt * resort.timeScale : dt);

// Same list, named, for per-subsystem frame-time attribution. `update()` walks
// SYSTEMS on the hot path and STEPS only while `perf` is recording, so the
// instrumented order is identical to the live one by construction.
const STEPS = [
  ['controls', controls], ['resort', resort], ['physics', physics], ['chaseCam', chaseCam],
  ['terrain', terrain], ['sky', sky], ['scatter', scatter], ['draglift', draglift],
  ['branding', branding], ['skier', skier], ['spray', spray], ['tracks', tracks], ['postfx', postfx],
  ['audio', audio], ['hud', hud],
];
const STEP_NAMES = STEPS.map((s) => s[0]);

/**
 * The mode branch. `resort.update()` runs before physics because it is the thing
 * that decides whether physics runs at all this frame, and after controls
 * because boarding a lift is an input. Exactly three subsystems change
 * behaviour with the mode, and all three are here rather than testing
 * `state.mode` inside themselves:
 *
 *   physics    integrates only while skiing (resort owns the rider otherwise)
 *   chaseCam   frames the rider while skiing or on the T-bar; on the chair and
 *              in the hut the camera IS the feature and resort drives it
 *   SUSPENDED  see above
 */
function stepPlayer(dt) {
  resort.update(dt, state);
  const skiing = state.mode === 'ski';
  if (skiing) physics.update(dt, state);
  if (skiing || state.mode === 'drag') {
    chaseCam.update(dt, state);
    resort.postCamera(dt, state);      // eases out of a ride into the run
  } else {
    resort.updateCamera(dt, state);
  }
}

function update(dt) {
  // `perf.inFrame` and not `perf.recording`: a `harness.step()` from a capture
  // tool runs outside the rAF frame and must not write into a recorded slot.
  if (perf.inFrame) return updateInstrumented(dt);
  controls.update(dt, state);
  // Capture tools (tools/flyby.mjs) drive a scripted run by pinning the input
  // after the live sampler has written it.
  if (harness.__scripted) Object.assign(state.input, harness.__scripted);
  stepPlayer(dt);
  const skip = rideSuspends();
  for (const s of SYSTEMS) {
    if (skip && SUSPENDED.has(s)) continue;
    s.update?.(dtFor(s, dt), state);
  }
}

/**
 * Byte-for-byte the same call order as `update()`, with a `performance.now()`
 * between each step. Only ever reached while recording, so the shipping frame
 * pays one boolean test. This is how a spike gets ATTRIBUTED to a subsystem
 * without every subsystem owner having to instrument their own file — see
 * `perf.mark()` for the finer-grained hook they can add themselves.
 */
function updateInstrumented(dt) {
  let t0 = performance.now();
  controls.update(dt, state);
  if (harness.__scripted) Object.assign(state.input, harness.__scripted);
  let t1 = performance.now(); perf.step(0, t1 - t0); t0 = t1;
  resort.update(dt, state);
  t1 = performance.now(); perf.step(1, t1 - t0); t0 = t1;
  const skiing = state.mode === 'ski';
  if (skiing) physics.update(dt, state);
  t1 = performance.now(); perf.step(2, t1 - t0); t0 = t1;
  if (skiing || state.mode === 'drag') { chaseCam.update(dt, state); resort.postCamera(dt, state); }
  else resort.updateCamera(dt, state);
  t1 = performance.now(); perf.step(3, t1 - t0); t0 = t1;
  const skip = rideSuspends();
  for (let i = 0; i < SYSTEMS.length; i++) {
    if (!(skip && SUSPENDED.has(SYSTEMS[i]))) SYSTEMS[i].update?.(dtFor(SYSTEMS[i], dt), state);
    t1 = performance.now(); perf.step(4 + i, t1 - t0); t0 = t1;
  }
}

function renderFrame(dt) {
  perf.checkFallback();
  postfx.render(dt);
}

// --- frame-time instrumentation ----------------------------------------------
/**
 * `window.__harness.perf` — per-frame histogram with spike attribution.
 *
 * Why a histogram and not an fps counter: `--perf` counts vsync-presented frames
 * over 4 s, so it can only ever report ~60 or ~30 and it reports which mode the
 * compositor happens to be holding, never the margin. Stalls are a TAIL
 * statistic, and the mode-lock corrupts means, not tails — a 40 ms frame is
 * 40 ms whatever mode the compositor is in.
 *
 * API
 * ---
 *   perf.start({ capacity = 5400, gpuTimer = false, syncGPU = false })
 *        Begin recording. Allocates the ring buffer; recording itself is a
 *        handful of writes into typed arrays, no allocation per frame.
 *   perf.stop()               → report (also stops recording)
 *   perf.report()             → summary over what is currently in the ring
 *   perf.frames()             → raw per-frame records, oldest first
 *   perf.reset()              → clear the ring, keep recording
 *   perf.recording            → bool. When false the loop does one `if` and
 *                               nothing else, so this cannot become the thing
 *                               it measures.
 *   perf.mark(name, value=1)  → tag the frame currently being built. No-op when
 *                               not recording. Other modules may call this to
 *                               attribute their own spikes WITHOUT this file
 *                               knowing about them, e.g.
 *                                   window.__harness?.perf?.mark('scatter-drain', n)
 *                               Values for the same name within one frame are
 *                               summed; report() lists, per mark name, the
 *                               frames it appeared on and the p99/max frame time
 *                               of those frames versus the frames without it.
 *
 * Channels recorded per frame
 * ---------------------------
 *   t        performance.now() at frame start — absolute wall clock, so slow
 *            thermal drift is distinguishable from a discrete code spike
 *            (report().drift splits the window into quarters).
 *   dt       ms since the previous frame start (the presented interval)
 *   upd      ms inside update()
 *   rnd      ms inside renderFrame(); includes a gl.finish() when syncGPU
 *   gpu      ms from EXT_disjoint_timer_query_webgl2 when gpuTimer is on,
 *            else -1. Resolved asynchronously and back-filled into the frame
 *            it belongs to.
 *   calls    renderer.info.render.calls — draw calls for the WHOLE frame.
 *            `info` is put into manual-reset mode while recording, because
 *            three resets it at the top of every renderer.render() and the post
 *            chain makes a dozen of those per frame; read naively it reports
 *            the final fullscreen quad, i.e. `calls: 1`.
 *   tris     renderer.info.render.triangles, same treatment
 *   progs    renderer.info.programs.length     — ANY increase after the first
 *            few frames is a lazy shader link, and that frame's `rnd` IS the
 *            cost of the link. report().shaderLinks lists them WITH the shader
 *            name of the program that linked.
 *   geos     renderer.info.memory.geometries   — a jump means an upload
 *   texs     renderer.info.memory.textures
 *   sys      per-subsystem CPU ms (see updateInstrumented)
 *
 * `dt` and `rnd` measure different things and both are needed. `dt` is what the
 * user feels but is quantised to the vsync interval, so it resolves nothing
 * below the refresh period. `rnd` with `syncGPU: true` drains the GPU inside the
 * frame and therefore measures the real cost of the frame even when the frame
 * still fits in 16.7 ms — it is only comparable within one session.
 *
 * MEASURED CAVEAT on `gpu`: EXT_disjoint_timer_query_webgl2 IS exposed on this
 * ANGLE/Metal build and its values track load faithfully — across a 1x/2x
 * backbuffer A/B it scaled 2.00x while the presented interval scaled 1.85x —
 * but its ABSOLUTE value runs ~2.5x the presented frame interval, which is
 * impossible for real GPU busy time. ANGLE derives it from command-buffer
 * timestamps that include queue/scheduling gaps. Treat it as a sensitive
 * relative metric, never as "the frame took N ms on the GPU".
 */
function createPerf(renderer, stepNames) {
  const gl = renderer.getContext();
  const info = renderer.info;
  const NSTEP = stepNames.length;

  let cap = 0, len = 0, head = 0;
  let t = null, dt = null, upd = null, rnd = null, gpu = null;
  let calls = null, tris = null, progs = null, geos = null, texs = null;
  let marks = null, steps = null, linkNames = null;
  // Program cache keys seen so far, so a link can be NAMED and not merely
  // counted. `info.programs[i].name` is the material's shader name.
  const known = new Set();
  let lastProgCount = -1;

  let recording = false;
  let fallbackWarned = false;
  let pending = null;          // marks for the frame being built
  let prevT = 0, tStart = 0, tUpd = 0;
  let idx = -1;                // ring slot of the frame being built

  // --- GPU timer queries -----------------------------------------------------
  // EXT_disjoint_timer_query_webgl2 is present in this headless Chrome on the
  // Metal ANGLE backend. Only one TIME_ELAPSED query may be active at a time,
  // so there is exactly one in flight per frame; results are polled on later
  // frames and written back into the slot they came from. three does not use
  // timer queries anywhere, so there is no conflict.
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const inflight = [];         // { q, slot, epoch }
  let gpuActive = false;
  let gpuTimer = false;
  let syncGPU = false;
  let epoch = 0;               // bumped on reset so stale results are dropped

  function drainGPU() {
    for (let i = inflight.length - 1; i >= 0; i--) {
      const e = inflight[i];
      if (!gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE)) continue;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(e.q, gl.QUERY_RESULT);
      if (!disjoint && e.epoch === epoch && gpu && e.slot < cap) gpu[e.slot] = ns / 1e6;
      gl.deleteQuery(e.q);
      inflight.splice(i, 1);
    }
  }

  function alloc(capacity) {
    cap = Math.max(60, capacity | 0);
    t = new Float64Array(cap); dt = new Float32Array(cap);
    upd = new Float32Array(cap); rnd = new Float32Array(cap); gpu = new Float32Array(cap).fill(-1);
    calls = new Int32Array(cap); tris = new Float64Array(cap); progs = new Int32Array(cap);
    geos = new Int32Array(cap); texs = new Int32Array(cap);
    marks = new Array(cap).fill(null);
    linkNames = new Array(cap).fill(null);
    steps = new Float32Array(cap * NSTEP);
    len = 0; head = 0;
  }

  // --- statistics ------------------------------------------------------------
  const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))] : 0);
  const round = (v) => +(+v).toFixed(3);

  function order() {                       // ring slots, oldest first
    const out = new Array(len);
    const start = len < cap ? 0 : head;
    for (let i = 0; i < len; i++) out[i] = (start + i) % cap;
    return out;
  }

  function summarise(values) {
    if (!values.length) return null;
    const s = Float64Array.from(values).sort();
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return {
      n: values.length,
      mean: round(mean),
      min: round(s[0]),
      p50: round(pct(s, 0.5)), p95: round(pct(s, 0.95)), p99: round(pct(s, 0.99)),
      max: round(s[s.length - 1]),
    };
  }

  let inFrame = false;

  const api = {
    get recording() { return recording; },
    get inFrame() { return inFrame; },
    get gpuTimerAvailable() { return !!ext; },
    get gpuTimerEnabled() { return gpuTimer; },
    get syncGPU() { return syncGPU; },

    start(opts = {}) {
      alloc(opts.capacity ?? 5400);        // 90 s at 60 Hz
      gpuTimer = !!opts.gpuTimer && !!ext;
      syncGPU = !!opts.syncGPU;
      epoch++;
      known.clear();
      for (const p of renderer.info.programs || []) known.add(p.cacheKey);
      lastProgCount = renderer.info.programs ? renderer.info.programs.length : 0;
      // `info.render` is reset at the top of EVERY renderer.render() call, and
      // the post chain makes a dozen of them per frame, so reading it after the
      // frame reports the last pass only — one fullscreen quad, one draw call.
      // Take manual control while recording so the counters are per FRAME.
      // Nothing else in src/ reads renderer.info.
      info.autoReset = false;
      recording = true;
      prevT = performance.now();
      return { gpuTimer, syncGPU, gpuTimerAvailable: !!ext, capacity: cap };
    },

    stop(opts) {
      if (ext && inflight.length) drainGPU();
      const r = api.report(opts);
      // Whatever is still in flight can never be attributed now; free it rather
      // than leaking query objects across A/B cycles.
      for (const e of inflight) gl.deleteQuery(e.q);
      inflight.length = 0;
      recording = false;
      gpuTimer = false;
      syncGPU = false;
      inFrame = false;
      info.autoReset = true;
      return r;
    },

    reset() { if (cap) { len = 0; head = 0; epoch++; gpu.fill(-1); prevT = performance.now(); } },

    mark(name, value = 1) {
      if (!recording) return;
      if (pending === null) pending = Object.create(null);
      pending[name] = (pending[name] || 0) + value;
    },

    // --- called by the render loop; never call these yourself ---------------
    frameStart(now) {
      if (ext && inflight.length) drainGPU();
      inFrame = true;
      info.reset();                        // per-frame draw-call / triangle totals
      idx = head;
      head = (head + 1) % cap;
      if (len < cap) len++;
      t[idx] = now;
      dt[idx] = now - prevT;
      prevT = now;
      gpu[idx] = -1;
      steps.fill(0, idx * NSTEP, idx * NSTEP + NSTEP);
      tStart = now;
    },

    /** Per-subsystem timing slot, written by updateInstrumented(). */
    step(i, ms) { steps[idx * NSTEP + i] = ms; },

    updateDone() {
      tUpd = performance.now();
      upd[idx] = tUpd - tStart;
      // The query brackets the RENDER span only. ANGLE's Metal backend
      // implements TIME_ELAPSED from command-buffer GPU timestamps, so anything
      // bracketed that is not GL work inflates the result — with the query
      // opened before update() it read ~2.5x the presented frame interval,
      // which is impossible for real GPU busy time.
      if (gpuTimer && !gpuActive) {
        const q = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        inflight.push({ q, slot: idx, epoch });
        gpuActive = true;
      }
    },

    frameEnd() {
      if (gpuActive) { gl.endQuery(ext.TIME_ELAPSED_EXT); gpuActive = false; }
      // gl.finish() makes the CPU wall clock a proxy for GPU cost. It changes
      // absolute numbers (it serialises CPU and GPU) but changes them the same
      // way for both arms of an A/B, which is the only claim ever made from it.
      if (syncGPU) gl.finish();
      const now = performance.now();
      rnd[idx] = now - tUpd;
      const r = info.render, m = info.memory;
      calls[idx] = r.calls; tris[idx] = r.triangles;
      const np = info.programs ? info.programs.length : 0;
      progs[idx] = np;
      if (np !== lastProgCount) {
        // Rare (a handful of times per session), so the O(n) scan is free in
        // aggregate and buys the NAME of the program that just cost this frame.
        const added = [];
        for (const p of info.programs) {
          if (!known.has(p.cacheKey)) { known.add(p.cacheKey); added.push(p.name || p.type || '?'); }
        }
        lastProgCount = np;
        if (added.length) linkNames[idx] = added;
      }
      geos[idx] = m.geometries; texs[idx] = m.textures;
      marks[idx] = pending;
      pending = null;
      inFrame = false;
    },

    /** Raw per-frame records, oldest first. */
    frames() {
      if (!cap) return [];
      return order().map((i, k) => {
        const sys = {};
        for (let s = 0; s < NSTEP; s++) sys[stepNames[s]] = steps[i * NSTEP + s];
        return {
          i: k, t: t[i], dt: dt[i], upd: upd[i], rnd: rnd[i], gpu: gpu[i],
          calls: calls[i], tris: tris[i], progs: progs[i], geos: geos[i], texs: texs[i],
          marks: marks[i] ? { ...marks[i] } : null, sys,
        };
      });
    },

    /**
     * One-shot warning if the post chain is bypassed. `postfx.js:1280` renders
     * straight to the default framebuffer when `postfx.enabled === false`, and
     * `engine.js` no longer requests a multisampled default framebuffer, so that
     * debug path is single-sampled. Nothing in the repo sets that flag; this
     * exists so the change can never degrade a path silently. `?aa=1` restores
     * MSAA for the session.
     */
    checkFallback() {
      if (fallbackWarned || postfx.enabled !== false || gfx.antialias) return;
      fallbackWarned = true;
      console.warn('[perf] postfx.enabled === false: the scene is going straight to a '
        + 'SINGLE-SAMPLED default framebuffer (engine.js sets antialias:false because the '
        + 'post chain owns AA). Edges in this ablation will alias. Reload with ?aa=1 for MSAA.');
    },

    /**
     * Summary. Frame 0 of the window is dropped: its `dt` is measured against
     * whatever happened before recording started.
     */
    report(opts = {}) {
      const spikeMs = opts.spikeMs ?? 20;
      const ord = order().slice(1);
      if (!ord.length) return { n: 0 };

      const dts = [], upds = [], rnds = [], gpus = [];
      let over20 = 0, over33 = 0, over50 = 0;
      for (const i of ord) {
        dts.push(dt[i]); upds.push(upd[i]); rnds.push(rnd[i]);
        if (gpu[i] >= 0) gpus.push(gpu[i]);
        if (dt[i] > 20) over20++;
        if (dt[i] > 33) over33++;
        if (dt[i] > 50) over50++;
      }

      // Shader links: any growth in the program cache after the first frames.
      const shaderLinks = [];
      for (let k = 1; k < ord.length; k++) {
        const a = ord[k - 1], b = ord[k];
        if (progs[b] > progs[a]) {
          shaderLinks.push({
            frame: k, t: round(t[b]), added: progs[b] - progs[a],
            programs: progs[b], dtMs: round(dt[b]), renderMs: round(rnd[b]),
            names: linkNames[b] || null,
          });
        }
      }

      // Spikes, with everything needed to attribute them.
      const spikes = [];
      for (let k = 1; k < ord.length && spikes.length < 40; k++) {
        const b = ord[k], a = ord[k - 1];
        if (dt[b] <= spikeMs) continue;
        const top = [];
        for (let s = 0; s < NSTEP; s++) {
          const ms = steps[b * NSTEP + s];
          if (ms > 0.3) top.push([stepNames[s], round(ms)]);
        }
        top.sort((x, y) => y[1] - x[1]);
        spikes.push({
          sys: Object.fromEntries(top.slice(0, 4)),
          frame: k, t: round(t[b]), dtMs: round(dt[b]),
          updateMs: round(upd[b]), renderMs: round(rnd[b]),
          gpuMs: gpu[b] >= 0 ? round(gpu[b]) : null,
          calls: calls[b], dCalls: calls[b] - calls[a],
          triangles: tris[b],
          dPrograms: progs[b] - progs[a], dGeometries: geos[b] - geos[a], dTextures: texs[b] - texs[a],
          marks: marks[b] ? { ...marks[b] } : null,
        });
      }

      // Wall-clock drift: quarters of the window. A monotone rise across all
      // four is thermal/steady-state drift, not a discrete code spike.
      const q = Math.max(1, Math.floor(ord.length / 4));
      const drift = [];
      for (let s = 0; s + q <= ord.length && drift.length < 4; s += q) {
        const seg = ord.slice(s, s + q).map((i) => dt[i]);
        const segR = ord.slice(s, s + q).map((i) => rnd[i]);
        drift.push({ p50dt: round(pct(Float64Array.from(seg).sort(), 0.5)), p50render: round(pct(Float64Array.from(segR).sort(), 0.5)) });
      }

      // Per mark name: does the frame cost more when the mark is present?
      const markNames = new Set();
      for (const i of ord) if (marks[i]) for (const k in marks[i]) markNames.add(k);
      const markStats = {};
      for (const name of markNames) {
        const withM = [], withoutM = [];
        let sum = 0;
        for (const i of ord) {
          if (marks[i] && marks[i][name] !== undefined) { withM.push(dt[i]); sum += marks[i][name]; }
          else withoutM.push(dt[i]);
        }
        markStats[name] = { frames: withM.length, valueSum: sum, with: summarise(withM), without: summarise(withoutM) };
      }

      // Per-subsystem CPU time. p99/max is the interesting column: a system that
      // costs 0.2 ms typically and 9 ms every 20th frame is a periodic hitch and
      // is invisible in a mean.
      const sys = {};
      for (let s = 0; s < NSTEP; s++) {
        const v = ord.map((i) => steps[i * NSTEP + s]);
        const summary = summarise(v);
        if (summary && (summary.max > 0.05 || summary.mean > 0.02)) sys[stepNames[s]] = summary;
      }

      const first = t[ord[0]], last = t[ord[ord.length - 1]];
      return {
        n: ord.length,
        windowMs: round(last - first),
        frameInterval: summarise(dts),
        update: summarise(upds),
        render: summarise(rnds),
        gpu: gpus.length ? summarise(gpus) : null,
        gpuTimer: gpuTimer ? 'on' : (ext ? 'off' : 'unavailable'),
        syncGPU,
        over20, over33, over50,
        drawCalls: { first: calls[ord[0]], last: calls[ord[ord.length - 1]], max: Math.max(...ord.map((i) => calls[i])) },
        triangles: { last: tris[ord[ord.length - 1]] },
        programs: { first: progs[ord[0]], last: progs[ord[ord.length - 1]] },
        memory: {
          geometries: [geos[ord[0]], geos[ord[ord.length - 1]]],
          textures: [texs[ord[0]], texs[ord[ord.length - 1]]],
        },
        sys,
        shaderLinks,
        spikes,
        drift,
        marks: markStats,
      };
    },
  };
  return api;
}
const perf = createPerf(renderer, STEP_NAMES);

// --- harness hooks (tools/shoot.mjs depends on these) ------------------------
const harness = {
  ready: false,
  frames: 0,
  state,
  // Frame-time histogram + spike attribution. See createPerf() above for the
  // full API; `perf.mark(label, value)` is the hook other modules may call.
  perf,
  // Backbuffer / resolution-scale control (src/core/engine.js).
  gfx,
  // Vite dev-mode branches (e.g. spray.js' every-20th-frame full-array scan)
  // are live for anyone running `pnpm dev` and absent from a production build,
  // so any measurement has to say which one it measured.
  dev: !!import.meta.env?.DEV,
  // Live subsystem handles, so diagnostics can measure the scene instead of
  // guessing from pixels (e.g. compare the rig's ski base against terrain
  // height to prove a grounding bug).
  debug: {
    terrain, sky, scatter, skier, physics, spray, tracks, postfx, chaseCam, camera, scene, renderer,
    // The resort loop. `resort.enter('lift' | 'drag' | 'hut' | 'ski')` forces a
    // mode so the feature can be screenshot; `resort.goto('chair-mid')` parks the
    // player next to an interaction so the contact prompt can be. `resort.info()`
    // dumps the ride state and the placement it read out of scatter.
    resort, draglift,
    // Slope-side sponsor branding. `branding.ready` resolves when its two brand
    // PNGs are in the atlas; until then its group is hidden (see below).
    branding,
  },
  setPlayer(x, z, heading = Math.PI) {
    // A teleport ends whatever the player was doing: capture tools expect
    // setPlayer to leave them on the snow, whichever mode the session was in.
    resort.enter('ski', { x, z, heading });
    physics.reset(state, x, z, heading);
    controls.update(0, state);
    chaseCam.update(1, state); // snap, don't spring, on teleport
  },
  step(dt = 1 / 60, n = 1) {
    for (let i = 0; i < n; i++) update(dt);
    renderFrame(dt);
  },
  warmShaders,
  stats() {
    renderFrame(1 / 60);
    const gl = renderer.getContext();
    if (gl.isContextLost()) return { lost: true };
    const w = renderer.domElement.width, h = renderer.domElement.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, sum2 = 0, n = 0;
    for (let i = 0; i < buf.length; i += 4 * 17) {
      const l = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      sum += l; sum2 += l * l; n++;
    }
    const mean = sum / n;
    return { lost: false, mean, stddev: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
  },
};
window.__harness = harness;

let auto = true;
window.__setAuto = (v) => { auto = v; };

// --- shader warm-up ----------------------------------------------------------
/**
 * Link every program up front instead of the first time each mesh happens to be
 * drawn. Before this, nothing in `src/` called `compile()`, so a program linked
 * mid-run whenever a material first became visible — a discrete multi-frame
 * stall with no other symptom. `perf.report().shaderLinks` is what makes those
 * visible: any growth in `renderer.info.programs.length` after the first frames
 * is a link, and that frame's render time IS its cost.
 *
 * `renderer.compile()` walks materials with `scene.traverse`, NOT
 * `traverseVisible` (three.module.js:17427) — only the *light* gathering pass
 * uses traverseVisible. So the scatter pools that sit at `visible = count > 0`
 * (scatter.js:2961) are compiled here even while they are empty, and no
 * `visible` flag has to be touched to warm them.
 *
 * Called again a few frames in, because materials created lazily during the
 * first updates are not in the graph at boot. Repeat calls are cache hits.
 */
function warmShaders(label = 'boot') {
  const before = renderer.info.programs?.length ?? 0;
  const t0 = performance.now();
  try {
    renderer.compile(scene, camera);
  } catch (e) {
    console.warn('[warmShaders] compile failed:', e?.message ?? e);
    return null;
  }
  const r = {
    label, ms: +(performance.now() - t0).toFixed(1),
    programs: [before, renderer.info.programs?.length ?? 0],
  };
  warmShaders.log.push(r);
  return r;
}
warmShaders.log = [];
const WARM_AT = new Set([30, 120, 300, 600]);

// --- ?resort= : start the session in a resort mode ---------------------------
/**
 * `?resort=lift|drag|hut|chair-mid|chair-bottom|tbar` puts the player straight
 * into a mode (or next to the interaction that starts it) a few frames after
 * boot, so a reviewer can SEE the feature with `pnpm dev` and a URL instead of
 * having to write a puppeteer script:
 *
 *   ?resort=hut&drink=beer          sitting in the restaurant with a beer
 *   ?resort=hut&drink=beer&beat=1   ...and play the look across at the counter
 *   ?resort=lift&at=mid&progress=.4 on the chair, 40% up from the mid-station
 *   ?resort=lift&to=summit          the full line rather than the mid-station leg
 *   ?resort=drag&progress=.45       on the T-bar
 *   ?resort=tbar                    standing at the T-bar with the prompt up
 *
 * Deliberately applied a few frames in, not at boot: the terrain and scatter
 * around the destination have to stream in first, and the chair-clearance test
 * needs scatter's chairs to exist.
 */
function applyStartMode() {
  let q;
  try { q = new URLSearchParams(location.search); } catch { return; }
  const which = q.get('resort');
  if (!which) return;
  const o = {};
  if (q.has('at')) o.at = q.get('at');
  if (q.has('to')) o.to = q.get('to');
  if (q.has('progress')) o.progress = +q.get('progress');
  if (q.has('drink')) o.drink = q.get('drink');
  if (q.has('beat')) o.beat = true;
  if (which === 'lift' || which === 'drag' || which === 'hut' || which === 'ski') resort.enter(which, o);
  else resort.goto(which);
}

// --- loop --------------------------------------------------------------------
let prev = performance.now();
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min((now - prev) / 1000, 0.05);
  prev = now;
  // When paused we still present frames — the capture harness needs a live swap
  // chain to screenshot, it just must not advance the simulation.
  if (perf.recording) {
    // Instrumented path: one extra boolean test on the shipping frame.
    perf.frameStart(now);
    if (auto) update(dt);
    perf.updateDone();
    renderFrame(dt);
    perf.frameEnd();
  } else {
    if (auto) update(dt);
    renderFrame(dt);
  }
  harness.frames++;
  if (harness.frames === 12) applyStartMode();
  // Further passes as the graph fills in: LOD rings, pooled meshes and anything
  // the first seconds of streaming adds. Everything already linked is a cache
  // hit, so the later passes are cheap unless there is genuinely something new —
  // and if there is, this is where it gets paid instead of mid-run.
  if (WARM_AT.has(harness.frames)) warmShaders('frame' + harness.frames);
}

warmShaders('boot');
loop();

// `branding` composites its two brand PNGs asynchronously and keeps its group
// hidden until they are in its atlas, so a capture taken before that contains no
// branding at all. Every capture tool gates on `harness.ready`, so flipping it
// synchronously would have quietly produced a whole review's worth of shots with
// the sponsor boards missing — which is why the module hides rather than falls
// back: absent is loud, wrong artwork is silent. ~200 ms, and it cannot reject.
branding.ready.then(() => {
  harness.ready = true;
  document.getElementById('boot').classList.add('gone');
});
