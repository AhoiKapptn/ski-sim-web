/**
 * "Where does the frame go" — per-subsystem GPU attribution by interleaved ABBA
 * ablation, all inside ONE page session.
 *
 *   node tools/gpu-breakdown.mjs --dpr 2                  # the resolution the game is played at
 *   node tools/gpu-breakdown.mjs --dpr 2 --only snow,trees
 *   node tools/gpu-breakdown.mjs --dpr 1 --cycles 3
 *   node tools/gpu-breakdown.mjs --list
 *
 * `tools/perf-ab.mjs` answers "is A faster than B" for ONE knob. This answers
 * "which subsystem is the frame", by running a whole list of ablations against a
 * shared baseline arm without ever leaving the session — so every delta is
 * measured against a baseline window that sits immediately beside it in time and
 * the numbers are mutually comparable, which deltas from separate process
 * launches are not (see the mode-lock note in perf-ab.mjs).
 *
 * ---------------------------------------------------------------------------
 * WHY THE ABLATIONS LOOK LIKE THIS — trap 3 is the whole design constraint
 * ---------------------------------------------------------------------------
 * `visible = false` is not usable here. CLAUDE.md records that hiding the near
 * trees made the frame 22 ms SLOWER, because the sky and distant terrain behind
 * them then had to be shaded. Every ablation below therefore holds geometry,
 * depth writes, draw-call count and screen coverage EXACTLY as shipped, and
 * changes only how expensive it is to shade a covered pixel:
 *
 *   - `snow`, `trees`, `skier` swap the material for a MeshBasicMaterial that
 *     keeps the same `side`, `alphaTest` and `map`, so the alpha-tested cutout
 *     of a conifer card is bit-identical and nothing behind it is exposed.
 *   - `shadowdraw` sets `renderer.shadowMap.autoUpdate = false`. The shadow map
 *     stops being RE-RENDERED but is still bound and still sampled by every
 *     receiver, so not one shader is recompiled and not one lookup is skipped:
 *     this isolates the two shadow *draw* passes and nothing else.
 *   - the post-chain entries just switch a pass off. A fullscreen quad has no
 *     occluders, so trap 3 cannot apply to them.
 *
 * MEASURED CAVEAT ON THE PRIMARY METRIC. This tool reports the presented frame
 * interval, not the GPU timer query, and that is deliberate:
 *
 *   - `gl.finish()` DOES NOT DRAIN THE GPU on Chrome's command-buffer path.
 *     Measured with the known-answer `dpr` preset: quadrupling the pixel count
 *     moved the presented interval +18.35 ms in 6/6 pairs and moved the
 *     gl.finish()-bracketed render span by 0.00 ms. `--sync-gpu` is therefore
 *     not a GPU proxy on this machine, whatever perf-ab.mjs' header claims.
 *   - EXT_disjoint_timer_query_webgl2 over-attributes cost to a chain of MANY
 *     SMALL PASSES, because ANGLE derives it from command-buffer timestamps that
 *     include queue and scheduling gaps and each pass is its own submission.
 *     Measured: switching the whole post chain off moved the GPU timer by
 *     −34.8 ms (median pair) and the presented interval by only −3.3 ms, a
 *     factor of 13. Any per-pass breakdown built on the timer query is fiction.
 *   - At DPR 2 this build runs at 30-48 ms and rAF is NOT vsync-locked there
 *     (the intervals are 34.0/40.2/42.8/48, which are not multiples of 16.7), so
 *     the presented interval is a genuine continuous measure of frame cost.
 *     At DPR 1 it pins to 16.70 and can only ever report a FLOOR — so a DPR 1
 *     run of this tool measures nothing unless an arm falls off 60 fps. Run it
 *     at --dpr 2.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT, makeArgs, startServer, launch, boot, installPath, measureWindow, sleep,
} from './frametime.mjs';

// ---- page-side ablation kit --------------------------------------------------
/**
 * Installed once per session as `window.__abl`. Every entry is
 * `{ on(), off() }`; `off()` must restore the shipped state exactly, because the
 * baseline arm of every pair is just "everything off".
 */
const KIT_SRC = `(function () {
  const h = window.__harness, d = h.debug;
  // Collect the meshes we ablate ONCE, so the pairing cannot drift as LOD rings
  // and pools come and go mid-session.
  const groups = {
    snow: [], trees: [], skier: [], sky: [], rocks: [],
    tracks: [], spray: [], lift: [], markers: [], other: [],
  };
  function classify(o) {
    if (!(o.isMesh || o.isInstancedMesh || o.isPoints)) return;
    const n = (o.name || '') + '|' + (o.parent && o.parent.name || '');
    if (/terrain/.test(n)) groups.snow.push(o);
    else if (/track|trench/i.test(n)) groups.tracks.push(o);
    else if (/spray|plume|powder/i.test(n)) groups.spray.push(o);
    else if (/tree|clust|foliage|shrub/i.test(n)) groups.trees.push(o);
    else if (/^sky/.test(o.name || '')) groups.sky.push(o);
    else if (/rock|talus|boulder/i.test(n)) groups.rocks.push(o);
    else if (/lift|chair|pylon|cable|tower/i.test(n)) groups.lift.push(o);
    else if (/marker|gate|fence|sign|flag|pole/i.test(n)) groups.markers.push(o);
    else if (/skier|rider|ski\\b|board/i.test(n)) groups.skier.push(o);
    else groups.other.push(o);
  }
  d.scene.traverse(classify);

  // ---------------------------------------------------------------------------
  // Gutting a material, WITHOUT constructing a new one.
  //
  // There is no THREE handle on the page, and more importantly a substitute
  // material would be the wrong instrument anyway: the snow shader does its
  // terrain DISPLACEMENT in the vertex program (snow-material.js installs it
  // through onBeforeCompile), so anything that drops the vertex shader moves the
  // geometry and the ablation stops being about shading at all.
  //
  // So the original onBeforeCompile is left to run in full — vertex program,
  // uniforms and defines exactly as shipped — and only the FRAGMENT body is
  // replaced afterwards. The replacement is built out of three's own map /
  // alphaMap / alphaTest chunks (three resolves #include in a supplied
  // fragmentShader), so the alpha-tested cutout of a conifer card comes out
  // bit-identical and nothing behind it is ever exposed. That is what keeps this
  // clear of trap 3.
  // ---------------------------------------------------------------------------
  const CHEAP_FRAG = [
    'precision highp float;',
    '#include <common>',
    '#include <uv_pars_fragment>',
    '#include <map_pars_fragment>',
    '#include <alphamap_pars_fragment>',
    '#include <alphatest_pars_fragment>',
    'void main() {',
    '  vec4 diffuseColor = vec4( 0.62, 0.69, 0.76, 1.0 );',
    '  #include <map_fragment>',
    '  #include <alphamap_fragment>',
    '  #include <alphatest_fragment>',
    '  gl_FragColor = vec4( diffuseColor.rgb, 1.0 );',
    '}',
  ].join('\\n');

  const gutted = [];
  function gut(m) {
    if (!m || m.__ablOn) return;
    if (!('__ablOBC' in m)) {
      m.__ablOBC = m.onBeforeCompile;
      m.__ablKey = m.customProgramCacheKey;
    }
    const origOBC = m.__ablOBC, origKey = m.__ablKey;
    m.onBeforeCompile = function (shader, renderer) {
      if (origOBC) origOBC.call(this, shader, renderer);
      shader.fragmentShader = CHEAP_FRAG;
    };
    m.customProgramCacheKey = function () {
      return (origKey ? origKey.call(this) : '') + '|ablated';
    };
    m.needsUpdate = true;
    m.__ablOn = true;
    gutted.push(m);
  }
  function ungut(m) {
    if (!m || !m.__ablOn) return;
    m.onBeforeCompile = m.__ablOBC;
    m.customProgramCacheKey = m.__ablKey;
    m.needsUpdate = true;
    m.__ablOn = false;
  }
  function swapGroup(list) {
    for (const o of list) {
      const m = o.material;
      if (Array.isArray(m)) m.forEach(gut); else gut(m);
    }
  }
  function unswapAll() {
    for (const m of gutted) ungut(m);
    gutted.length = 0;
  }

  const P = d.postfx.params;
  const A = {
    // --- scene shading cost (coverage-preserving material swaps) -------------
    snow:   { desc: 'terrain snow/rock shader -> MeshBasicMaterial (same coverage)', on: () => swapGroup(groups.snow), off: unswapAll },
    // Split the terrain by clipmap ring. LEVEL_RES ramps to 512 for levels 6-8,
    // which is 1.28 M of the scene's 2.63 M triangles and was justified in
    // terrain.js with "measured cost at 1600x900 was nil (60.3 fps against
    // 60.0)" — an fps number, at DPR 1, where the frame is vsync-locked and a
    // real cost cannot show up at all. This says what those rings cost where it
    // matters.
    snownear: { desc: 'terrain LOD 0-5 (near+mid rings) -> basic',
      meshes: () => groups.snow.filter((o) => !/lod[678]/.test(o.name || '')),
      on: () => swapGroup(A.snownear.meshes()), off: unswapAll },
    snowfar:  { desc: 'terrain LOD 6-8 (the 512-res skyline rings) -> basic',
      meshes: () => groups.snow.filter((o) => /lod[678]/.test(o.name || '')),
      on: () => swapGroup(A.snowfar.meshes()), off: unswapAll },
    trees:  { desc: 'conifer cards + clusters -> basic (same map + alphaTest)',      on: () => swapGroup(groups.trees), off: unswapAll },
    rocks:  { desc: 'scatter rocks/talus -> basic',                                  on: () => swapGroup(groups.rocks), off: unswapAll },
    skier:  { desc: 'skier + riders -> basic',                                       on: () => swapGroup(groups.skier), off: unswapAll },
    sky:    { desc: 'sky dome shader -> basic',                                      on: () => swapGroup(groups.sky),   off: unswapAll },
    tracks: { desc: 'carve trench ribbon -> basic (it runs the FULL snow shader)',    on: () => swapGroup(groups.tracks), off: unswapAll },
    spray:  { desc: 'snow spray particles -> basic',                                  on: () => swapGroup(groups.spray), off: unswapAll },
    lift:   { desc: 'chairlift, cable and towers -> basic',                           on: () => swapGroup(groups.lift), off: unswapAll },
    markers:{ desc: 'piste markers, gates, fences -> basic',                          on: () => swapGroup(groups.markers), off: unswapAll },
    other:  { desc: 'everything else in the scene -> basic',                          on: () => swapGroup(groups.other), off: unswapAll },
    allscene: { desc: 'EVERY scene material -> basic (scene shading floor)',
      on: () => { for (const k of Object.keys(groups)) swapGroup(groups[k]); },
      off: unswapAll },

    // --- the two shadow map DRAW passes, with sampling left intact -----------
    shadowdraw: {
      desc: 'shadow maps not re-rendered (still bound + sampled)',
      on: () => { d.renderer.shadowMap.autoUpdate = false; },
      off: () => { d.renderer.shadowMap.autoUpdate = true; },
    },

    // --- post chain ---------------------------------------------------------
    post:   { desc: 'whole post chain off', on: () => { d.postfx.enabled = false; }, off: () => { d.postfx.enabled = true; } },
    taa:    { desc: 'TAA resolve off (SMAA takes over)', on: () => { P.taa.enabled = false; }, off: () => { P.taa.enabled = true; } },
    bloom:  { desc: 'bloom off',  on: () => { P.bloom.enabled = false; }, off: () => { P.bloom.enabled = true; } },
    dof:    { desc: 'DOF off',    on: () => { P.dof.enabled = false; },   off: () => { P.dof.enabled = true; } },
    motion: { desc: 'motion blur off', on: () => { P.motion.enabled = false; }, off: () => { P.motion.enabled = true; } },
    grain:  { desc: 'film grain amplitude 0 (pass still runs)', on: () => { P.film.grain = 0; }, off: () => { P.film.grain = 0.012; } },
  };

  // SHARED-MATERIAL GUARD. This cost a wasted measurement round: terrain.js
  // creates ONE snow material (terrain.js:1302) and assigns the same instance to
  // all nine clipmap LOD meshes (terrain.js:2651), so an attempt to ablate
  // "LOD 6-8" gutted the material that LOD 0-5 are also drawn with. Both arms
  // measured the whole terrain, agreed with each other beautifully, and meant
  // nothing. The self-check cannot catch it — the frame really does change, just
  // not in the way the entry claims. So any ablation naming a strict subset of
  // the meshes that share a material is refused outright.
  function sharedWarnings() {
    const owners = new Map();               // material -> [mesh names]
    for (const [g, list] of Object.entries(groups)) {
      for (const o of list) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          if (!owners.has(m)) owners.set(m, []);
          owners.get(m).push(g + ':' + (o.name || o.type));
        }
      }
    }
    const out = [];
    for (const [, names] of owners) {
      const gs = new Set(names.map((n) => n.split(':')[0]));
      if (names.length > 1) out.push({ groups: [...gs], meshes: names });
    }
    return out;
  }
  /** Meshes outside the given list that would be hit via a shared material. */
  function collateral(list) {
    const mats = new Set();
    for (const o of list) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m) mats.add(m);
    }
    const hit = [];
    for (const [, all] of Object.entries(groups)) {
      for (const o of all) {
        if (list.indexOf(o) >= 0) continue;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) if (m && mats.has(m)) { hit.push(o.name || o.type); break; }
      }
    }
    return hit;
  }

  window.__abl = {
    names: Object.keys(A),
    desc: (k) => A[k] && A[k].desc,
    counts: () => Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
    /** Meshes an entry would ablate as collateral through a shared material. */
    collateralFor(k) {
      if (!A[k] || !A[k].meshes) return [];
      return collateral(A[k].meshes());
    },
    sharedWarnings,
    on(k) { A[k] && A[k].on(); },
    off(k) { A[k] && A[k].off(); },
    allOff() { for (const k of Object.keys(A)) { try { A[k].off(); } catch (e) {} } },
  };
  return window.__abl.counts();
})`;

// ---- stats ------------------------------------------------------------------
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v) ? '   -  ' : (+v).toFixed(n).padStart(7));

/**
 * Presented intervals cannot fall below the refresh period, so any arm at or
 * under this is censored and its delta is only a lower bound. 17.5 leaves a
 * little room over the 16.70 ms this machine reports.
 */
const VSYNC_FLOOR = 17.5;

const STATS = [
  ['interval.p50', (r) => r.frameInterval?.p50],
  ['interval.p99', (r) => r.frameInterval?.p99],
  ['over20/s', (r) => r.over20 / (r.windowMs / 1000)],
  ['over33/s', (r) => r.over33 / (r.windowMs / 1000)],
];

// ---- main -------------------------------------------------------------------
const { arg, num, flag } = makeArgs();
const opts = {
  cycles: num('cycles', 2),
  dwell: num('dwell', 2200),
  settle: num('settle', 1700),
  w: num('w', 1600), h: num('h', 900), dpr: num('dpr', 2),
  start: arg('start', 'hero'),
  lead: num('lead', 1.2), amp: num('carve-amp', 0.85), period: num('carve-period', 2.6),
  straight: flag('straight'),
  prod: flag('prod'),
  only: arg('only', null),
  json: arg('json', null),
  list: flag('list'),
};

const server = await startServer({ prod: opts.prod, port: 5321 });
const { browser, page, errors } = await launch(opts);
let code = 0;
const out = [];

try {
  const env = await boot(page, server.url);
  const counts = await page.evaluate((src) => eval(src)(), KIT_SRC);
  const names = await page.evaluate(() => window.__abl.names);

  if (opts.list) {
    for (const n of names) console.log(`  ${n.padEnd(12)} ${await page.evaluate((k) => window.__abl.desc(k), n)}`);
    console.log('\nablated mesh counts:', JSON.stringify(counts));
    await browser.close(); await server.close(); process.exit(0);
  }

  const want = opts.only ? opts.only.split(',').map((s) => s.trim()).filter((s) => names.includes(s)) : names;

  console.log(`build: ${server.mode}   DEV=${env.dev}   gpu: ${env.gpu}`);
  console.log(`backbuffer ${env.gfx.drawingBuffer.join('x')} (${env.gfx.megapixels} Mpx) dpr=${opts.dpr} antialias=${env.gfx.antialias}`);
  console.log(`path: ${opts.straight ? 'straight coast' : `linked carves amp ${opts.amp} period ${opts.period}s`} from "${opts.start}"`);
  console.log(`ablated mesh counts: ${JSON.stringify(counts)}`);
  if (opts.dpr < 2) {
    console.log('WARNING: at dpr 1 the presented interval pins to 16.70 ms (vsync). This run can only');
    console.log('         report a FLOOR — an ablation that saves 5 ms will read as saving 0.');
  }
  console.log(`\nprimary metric: presented frame interval. delta = ablated − baseline (negative ⇒ the`);
  console.log(`ablated subsystem was costing that much). ${opts.cycles} ABBA cycles per entry.\n`);

  await installPath(page, { lead: opts.lead, amp: opts.amp, period: opts.period, straight: opts.straight });

  const win = async () => measureWindow(page, {
    start: opts.start,
    settleMs: Math.max(opts.settle, opts.lead * 1000 + 400),
    dwellMs: opts.dwell, gpuTimer: false, syncGPU: false,
  });

  for (const name of want) {
    const desc = await page.evaluate((k) => window.__abl.desc(k), name);
    process.stdout.write(`── ${name}: ${desc}\n`);

    // SELF-CHECK. A "no measurable difference" verdict is worthless if the
    // ablation never took effect — a typo'd param path or a material that was
    // already gutted both read as a clean null result. So prove the frame
    // actually changed before believing any timing from it.
    const chk = await page.evaluate(async (k) => {
      window.__abl.allOff();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const a = window.__harness.stats();
      window.__abl.on(k);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const b = window.__harness.stats();
      window.__abl.allOff();
      return { base: a.mean, abl: b.mean, dSd: b.stddev - a.stddev };
    }, name);
    const dMean = Math.abs(chk.abl - chk.base);
    process.stdout.write(`     self-check: frame mean ${chk.base.toFixed(2)} -> ${chk.abl.toFixed(2)}`
      + ` (Δ ${dMean.toFixed(2)}, Δsd ${chk.dSd.toFixed(2)})`
      + `${dMean < 0.15 && Math.abs(chk.dSd) < 0.15 ? '   *** NO VISIBLE EFFECT — timing below is not evidence ***' : ''}\n`);

    // SHARED-MATERIAL GUARD (see the kit). Refuse rather than report a number
    // that is silently about a different set of meshes than the label says.
    const coll = await page.evaluate((k) => window.__abl.collateralFor(k), name);
    if (coll.length) {
      console.log(`     *** REFUSED: this subset shares a material instance with ${coll.length} mesh(es)`);
      console.log(`         outside it — ${coll.slice(0, 6).join(', ')}${coll.length > 6 ? ', …' : ''}.`);
      console.log('         Gutting the subset guts those too, so the arm is not the ablation named.');
      console.log('         Give those meshes their own material instance first, or drop this entry.\n');
      continue;
    }
    const runs = [];
    // ABBA: baseline, ablated, ablated, baseline — cancels monotone drift.
    for (let c = 0; c < opts.cycles; c++) {
      for (const armName of ['A', 'B', 'B', 'A']) {
        const isBase = armName === 'A';
        await page.evaluate((k, ab) => { window.__abl.allOff(); if (!ab) window.__abl.on(k); }, name, isBase);
        const r = await win();
        runs.push({ arm: armName, report: r });
        process.stdout.write(`     ${isBase ? 'base    ' : 'ablated '} p50 ${f(r.frameInterval.p50)} p99 ${f(r.frameInterval.p99)}`
          + `  over33 ${f(r.over33 / (r.windowMs / 1000), 1)}/s (n=${r.n})\n`);
      }
    }
    await page.evaluate(() => window.__abl.allOff());

    const pairs = [];
    for (let i = 0; i + 1 < runs.length; i += 2) {
      const x = runs[i], y = runs[i + 1];
      if (x.arm === y.arm) continue;
      pairs.push(x.arm === 'A' ? { base: x, abl: y } : { base: y, abl: x });
    }
    const row = { name, desc, pairs: pairs.length, stats: {} };
    for (const [sn, get] of STATS) {
      const bv = pairs.map((p) => get(p.base.report));
      const av = pairs.map((p) => get(p.abl.report));
      const deltas = pairs.map((p, i) => av[i] - bv[i]);
      const neg = deltas.filter((x) => x < 0).length;
      row.stats[sn] = {
        baseMin: Math.min(...bv), ablMin: Math.min(...av),
        minDelta: Math.min(...av) - Math.min(...bv),
        medianDelta: median(deltas), deltas,
        cheaperInPairs: neg, pairs: pairs.length,
      };
    }
    const s = row.stats['interval.p50'];
    // VSYNC CENSORING. Once an arm lands on the refresh period the presented
    // interval cannot go lower, so the delta stops being a measurement of the
    // ablation and becomes a lower bound on it. This bit me on the two biggest
    // entries in the first run — `snow` and `allscene` both bottomed out at
    // 16.70 and their "−15.7 / −27.3 ms" were floors, not costs.
    row.clamped = s.ablMin < VSYNC_FLOOR;
    console.log(`     => interval p50  base min ${f(s.baseMin)}  ablated min ${f(s.ablMin)}  |  min-of-N Δ ${f(s.minDelta)} ms`
      + `  median pair Δ ${f(s.medianDelta)} ms  |  cheaper in ${s.cheaperInPairs}/${s.pairs} pairs`);
    console.log(`        per-pair Δ: ${s.deltas.map((x) => f(x)).join(' ')}`);
    const p99 = row.stats['interval.p99'];
    console.log(`        p99 min-of-N Δ ${f(p99.minDelta)} ms   over33/s ${f(row.stats['over33/s'].baseMin, 1)} -> ${f(row.stats['over33/s'].ablMin, 1)}`);
    if (row.clamped) {
      console.log(`        ^ the ablated arm hit the ${VSYNC_FLOOR} ms VSYNC FLOOR. This Δ is a LOWER BOUND on the`);
      console.log('          cost, not the cost: the frame had spare budget the presented interval cannot show.');
      console.log('          To resolve it, raise the load (--dpr 2 is already on) or ablate something smaller.');
    }
    if (s.cheaperInPairs !== 0 && s.cheaperInPairs !== s.pairs) {
      console.log('        ^ sign NOT consistent across pairs — treat as no measurable difference.');
    }
    console.log('');
    out.push(row);
  }

  // --- ranked summary --------------------------------------------------------
  const ranked = [...out].sort((a, b) => a.stats['interval.p50'].minDelta - b.stats['interval.p50'].minDelta);
  console.log('════ ranked by min-of-N saving on interval p50 (most expensive subsystem first) ════');
  for (const r of ranked) {
    const s = r.stats['interval.p50'];
    const consistent = s.cheaperInPairs === s.pairs ? ' ' : (s.cheaperInPairs === 0 ? ' (no effect)' : ' (INCONSISTENT)');
    console.log(`  ${r.name.padEnd(12)} ${r.clamped ? '>=' : '  '}${f(s.minDelta)} ms  (median pair ${f(s.medianDelta)})  ${s.cheaperInPairs}/${s.pairs}${consistent}`
      + `${r.clamped ? '  [LOWER BOUND — hit vsync floor]' : ''}`);
  }

  if (opts.json) {
    const p = path.resolve(ROOT, opts.json);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify({ env, opts, counts, out }, null, 2));
    console.log(`\nwrote ${opts.json}`);
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
