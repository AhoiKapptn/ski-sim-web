/**
 * WHAT IS IN THE RESOLUTION-INDEPENDENT FLOOR?
 *
 *   node tools/floor-probe.mjs --w 2560 --h 1440 --dpr 2
 *
 * `tools/perf-baseline.mjs` measured, on a 14.75 Mpx display, that the frame is
 * roughly `9 ms fixed + 2.9 ms/Mpx` — and that the adaptive ladder bottoms out
 * at 2.36 Mpx (16% of native) STILL missing the 16.67 ms lock. A ~9 ms fixed
 * term with only ~1.7 ms of CPU in it means ~7 ms of GPU work that no amount of
 * resolution cutting can reach, and this project has never measured it: every
 * ablation in tools/ was designed around fragment cost, because trap 5 had
 * established pixels as the lever and pixels really are the lever for the
 * SLOPE. They are not the lever for the intercept.
 *
 * THE METHOD, and why it is the honest one here:
 *
 * Each ablation is measured at TWO pinned resolutions, 2.36 Mpx and 9.44 Mpx.
 * A cost that is resolution-independent (vertex programs, the shadow geometry
 * pass, draw-call submission, CPU) shows the SAME ABSOLUTE DELTA at both. A
 * fragment cost shows a delta that scales with the pixel count — 4x here. So
 * the ratio of the two deltas classifies the cost, and neither reading has to
 * be trusted in absolute terms. That sidesteps trap 7 (the GPU timer's level is
 * meaningless) and trap 1 (mode locks corrupt means): a mode lock would have to
 * hit both resolutions with the same sign and magnitude to fake a classification.
 *
 * Trap 3 still applies — `visible = false` on the terrain exposes the sky behind
 * it — so the arms that hide geometry are read as LOWER BOUNDS on the saving,
 * and the `outer-rings` arm is the one that matters most because what it exposes
 * is the analytic far field, which is nearly free.
 */
import { startServer, launch, boot, installPath, measureWindow, makeArgs, sleep } from './frametime.mjs';

const { arg, num, flag } = makeArgs();
const opts = {
  w: num('w', 2560), h: num('h', 1440), dpr: num('dpr', 2),
  seconds: num('seconds', 5),
  start: arg('start', 'hero'),
  reps: num('reps', 2),
  scales: (arg('scales', '0.4,0.8') || '').split(',').map(Number),
  prod: flag('prod'),
};

const f = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v) ? '  -  ' : (+v).toFixed(n));

/**
 * Page-side ablations. Every one must restore EXACTLY on off() — the baseline
 * arm is "everything off", so a leaky restore contaminates every later pair.
 */
const ABL_SRC = `(function () {
  const h = window.__harness, d = h.debug, r = d.renderer;
  const saved = {};
  const relink = () => { d.scene.traverse((o) => { if (o.material) { const m = Array.isArray(o.material) ? o.material : [o.material]; m.forEach((x) => { x.needsUpdate = true; }); } }); };
  const hide = (key, list) => { saved[key] = list.map((o) => [o, o.visible]); list.forEach((o) => { o.visible = false; }); };
  const show = (key) => { (saved[key] || []).forEach(([o, v]) => { o.visible = v; }); delete saved[key]; };

  const levels = d.terrain.levels || [];
  const scatterRoots = [];
  d.scene.traverse((o) => {
    if ((o.isInstancedMesh || o.isMesh) && /tree|clust|foliage|shrub|rock|talus|boulder/i.test((o.name||'') + '|' + ((o.parent&&o.parent.name)||''))) scatterRoots.push(o);
  });

  window.__fl = {
    counts: {
      levels: levels.length,
      levelRes: levels.map((l) => l.mesh.geometry && l.mesh.geometry.attributes.position.count),
      levelTris: levels.map((l) => (l.mesh.geometry && l.mesh.geometry.index ? l.mesh.geometry.index.count / 3 : 0)),
      scatterRoots: scatterRoots.length,
    },
    arms: {
      // The three outer clipmap rings: 512x512 each, and CLAUDE.md records them
      // as 1.28 M of the 2.63 M triangles in the scene. What they expose when
      // hidden is the analytic far field, not sky, so this is close to a clean
      // vertex-cost read.
      'outer-rings': {
        on() { hide('outer', levels.slice(6).map((l) => l.mesh)); },
        off() { show('outer'); },
      },
      // Rings 5..8 — the whole coarse half of the clipmap.
      'coarse-rings': {
        on() { hide('coarse', levels.slice(5).map((l) => l.mesh)); },
        off() { show('coarse'); },
      },
      // The entire shadow pass: a second geometry submission of everything that
      // casts, plus the PCF taps in the main pass. Costs a shader relink both
      // ways, so this arm is slow to switch but it is the big structural one.
      'shadows': {
        on() { saved.sm = r.shadowMap.enabled; r.shadowMap.enabled = false; relink(); },
        off() { r.shadowMap.enabled = saved.sm; relink(); },
      },
      // Shadow map resolution only — no relink, so this isolates the shadow
      // RENDER cost from the main-pass PCF tap cost.
      'shadow-map-quarter': {
        on() {
          const ls = []; d.scene.traverse((o) => { if (o.isLight && o.shadow) ls.push(o); });
          saved.sml = ls.map((l) => [l, l.shadow.mapSize.x, l.shadow.mapSize.y]);
          ls.forEach((l) => { l.shadow.mapSize.setScalar(Math.max(256, l.shadow.mapSize.x / 4)); if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; } });
        },
        off() { (saved.sml || []).forEach(([l, x, y]) => { l.shadow.mapSize.set(x, y); if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; } }); delete saved.sml; },
      },
      'scatter': {
        on() { hide('scat', scatterRoots); },
        off() { show('scat'); },
      },
      // The whole post chain, replaced by a direct render. Pure fragment +
      // bandwidth, so it is the CONTROL for this experiment: its delta MUST
      // scale with resolution. If it does not, the method is broken.
      'postfx': {
        on() { saved.pf = d.postfx.enabled; d.postfx.enabled = false; },
        off() { d.postfx.enabled = saved.pf; },
      },
    },
    info() { return this.counts; },
  };
})()`;

const server = await startServer({ prod: opts.prod, port: 5308 });
const { browser, page, errors } = await launch(opts);
let code = 0;
try {
  const env = await boot(page, server.url);        // freezes the controller for the session
  console.log(`gpu: ${env.gpu}`);
  console.log(`viewport ${opts.w}x${opts.h} @dpr ${opts.dpr}  native ${(opts.w * opts.dpr * opts.h * opts.dpr / 1e6).toFixed(2)} Mpx`);
  await installPath(page, { lead: 1.2, amp: 0.85, period: 2.6 });
  await page.evaluate(ABL_SRC);
  const counts = await page.evaluate(() => window.__fl.info());
  console.log(`clipmap: ${counts.levels} levels, triangles ${counts.levelTris.map((t) => (t / 1000).toFixed(0) + 'k').join(' ')}`
    + `  = ${(counts.levelTris.reduce((a, b) => a + b, 0) / 1e6).toFixed(2)} M`);
  console.log(`scatter roots ablated: ${counts.scatterRoots}`);

  const armNames = await page.evaluate(() => Object.keys(window.__fl.arms));
  const results = {};   // results[arm][scale] = best ms saved

  for (const scale of opts.scales) {
    await page.evaluate((s) => window.__harness.gfx.setResolutionScale(s), scale);
    await sleep(400);
    const mpx = await page.evaluate(() => window.__harness.gfx.info().megapixels);
    console.log(`\n===== pinned scale ${scale}  (${f(mpx)} Mpx) =====`);

    // ABBA per arm: base, arm, arm, base — so a slow drift cancels in the pairs.
    for (const name of armNames) {
      const pairs = [];
      for (let rep = 0; rep < opts.reps; rep++) {
        const b1 = await measureWindow(page, { start: opts.start, settleMs: 1500, dwellMs: opts.seconds * 1000, gpuTimer: false });
        await page.evaluate((n) => window.__fl.arms[n].on(), name);
        await sleep(name === 'shadows' ? 2500 : 400);
        const a1 = await measureWindow(page, { start: opts.start, settleMs: 1500, dwellMs: opts.seconds * 1000, gpuTimer: false });
        await page.evaluate((n) => window.__fl.arms[n].off(), name);
        await sleep(name === 'shadows' ? 2500 : 400);
        pairs.push(+(b1.frameInterval.p50 - a1.frameInterval.p50).toFixed(2));
      }
      // min-of-N on the SAVING: the smallest saving observed is the safest claim.
      const best = Math.min(...pairs);
      (results[name] ||= {})[scale] = { best, pairs, mpx };
      console.log(`   ${name.padEnd(20)} saves ${f(best).padStart(6)} ms   pairs [${pairs.join(', ')}]`);
    }
  }

  // ---- classification -------------------------------------------------------
  if (opts.scales.length >= 2) {
    const lo = Math.min(...opts.scales), hi = Math.max(...opts.scales);
    const pxRatio = results[armNames[0]][hi].mpx / results[armNames[0]][lo].mpx;
    console.log(`\n===== classification (pixel ratio between arms: ${f(pxRatio)}x) =====`);
    console.log(`   arm                  @${f(results[armNames[0]][lo].mpx)}Mpx  @${f(results[armNames[0]][hi].mpx)}Mpx   ratio   verdict`);
    for (const name of armNames) {
      const a = results[name][lo].best, b = results[name][hi].best;
      const ratio = Math.abs(a) < 0.15 ? NaN : b / a;
      // A fragment cost scales with pixels; a vertex/submit/CPU cost does not.
      // Judged against the actual pixel ratio, with a wide band because these
      // are quantised presented intervals, not clean measurements.
      let verdict;
      if (Number.isNaN(ratio)) verdict = b > 1 ? 'FRAGMENT (invisible at low res)' : 'negligible';
      else if (ratio > pxRatio * 0.55) verdict = 'FRAGMENT (scales with pixels)';
      else if (ratio < 1.6) verdict = '>>> FIXED (resolution-independent)';
      else verdict = 'MIXED';
      console.log(`   ${name.padEnd(20)} ${f(a).padStart(8)}  ${f(b).padStart(8)}  ${f(ratio).padStart(6)}   ${verdict}`);
    }
  }
} catch (e) {
  errors.push('harness: ' + (e?.message ?? String(e)));
  code = 1;
} finally {
  if (errors.length) { code = 1; console.error('\n--- errors ---'); errors.slice(0, 20).forEach((e) => console.error('  ' + e)); }
  await browser.close();
  await server.close();
  process.exit(code);
}
