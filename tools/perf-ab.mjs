/**
 * Interleaved A/B frame-cost runner. Referenced by src/world/sky.js:680; this is
 * the file that was missing.
 *
 *   node tools/perf-ab.mjs --preset dpr                       # 1x vs 2x backbuffer
 *   node tools/perf-ab.mjs --preset rscale --cycles 6
 *   node tools/perf-ab.mjs --preset postfx --dpr 2
 *   node tools/perf-ab.mjs --a "d.postfx.params.bloom.enabled=false" \
 *                          --b "d.postfx.params.bloom.enabled=true" \
 *                          --label-a "bloom off" --label-b "bloom on"
 *   node tools/perf-ab.mjs --preset dpr --prod                # built bundle, not the dev server
 *   node tools/perf-ab.mjs --preset aa                        # reloads the page per arm
 *   node tools/perf-ab.mjs --preset taa --straight            # coast, for contrast
 *
 * WHY IT IS BUILT THIS WAY — every rule here is a scar
 * ----------------------------------------------------
 * 1. BOTH VARIANTS RUN INSIDE ONE PAGE SESSION, alternating on a timer. The same
 *    unmodified build has measured 60, 54 and exactly 30.0 fps on this machine
 *    within an hour, because headless Chrome mode-locks to divisions of the
 *    refresh rate by load at launch. Two separate process launches therefore
 *    compare two compositor moods, not two builds. Nothing here ever compares
 *    across launches.
 * 2. ORDER IS BALANCED (A,B,B,A per cycle by default). A straight A,B,A,B leaves
 *    any monotone drift — thermal, or the GPU warming up — inside every pair
 *    with the same sign. ABBA cancels it to first order.
 * 3. IT REPORTS PER-PAIR DELTAS, MIN-OF-N AND A SIGN TEST, never a mean of
 *    absolute numbers. The median paired delta and the number of pairs pointing
 *    the same way are the result; the absolute level is noise.
 * 4. IT REPORTS THE TAIL, NOT FPS. p99, max and count-over-20 ms survive the
 *    vsync mode lock — a 40 ms frame is 40 ms whatever mode the compositor is in
 *    — where p50 of the presented interval is pinned to 16.7 and resolves
 *    nothing.
 * 5. THE PRIMARY STATISTIC IS GPU TIME PER FRAME, from
 *    EXT_disjoint_timer_query_webgl2 (available on this ANGLE/Metal build; the
 *    tool says so at startup if it is not, and falls back to CPU wall clock with
 *    `--sync-gpu`, which folds a gl.finish() into the measured render span).
 *    Presented frame interval CANNOT resolve a change that leaves both arms
 *    under the refresh period; GPU time can. But its ABSOLUTE value on this
 *    backend is ~2.5x the presented interval — ANGLE builds it from command
 *    buffer timestamps that include queue gaps — so read the DELTA and the
 *    ratio, never the level. Validated: on the 1x-vs-2x backbuffer A/B it
 *    scaled 2.00x where the presented interval scaled 1.85x.
 * 6. THE PLAYER CARVES. The reported symptom is "lags when curving", and a
 *    stationary or straight-line player never loads the spray emitter, the
 *    tracks trench writer, the camera shake or the g-force paths. This is the
 *    blind spot in `shoot.mjs --perf`, which measures a stationary skier.
 *    `--straight` is available for contrast; carving is the default.
 * 7. EVERY WINDOW STARTS FROM THE SAME PLACE with the path replayed from t=0, so
 *    the two arms ski identical ground. Otherwise the second arm is always
 *    measured further down the mountain.
 *
 * VARIANTS ARE JUST JAVASCRIPT. `--a` / `--b` are function bodies evaluated in
 * the page with `h` = window.__harness and `d` = window.__harness.debug, so any
 * future owner can A/B their own knob without touching this file:
 *
 *   --a "d.postfx.params.taa.feedback=0.5" --b "d.postfx.params.taa.feedback=0.78"
 *   --a "d.scatter.setDensity?.(0.5)"      --b "d.scatter.setDensity?.(1.0)"
 *   --a "h.gfx.setResolutionScale(0.75)"   --b "h.gfx.setResolutionScale(1)"
 *
 * A variant that needs a settling period longer than one window (a knob that
 * rebuilds geometry, say) should raise --settle.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT, makeArgs, startServer, launch, boot, installPath, measureWindow, sleep,
} from './frametime.mjs';

// ---- presets ----------------------------------------------------------------
/**
 * Known-answer presets come first deliberately: `dpr` MUST show a large
 * fragment-bound difference. If it does not, the tool is broken, not the build.
 */
const PRESETS = {
  dpr: {
    labelA: 'backbuffer 1x (1600x900, 1.44 Mpx)',
    labelB: 'backbuffer 2x (3200x1800, 5.76 Mpx)',
    a: 'h.gfx.setPixelRatio(1)',
    b: 'h.gfx.setPixelRatio(2)',
    settle: 2500,   // reallocates every post render target
  },
  rscale: {
    labelA: 'resolution scale 0.75',
    labelB: 'resolution scale 1.00',
    a: 'h.gfx.setResolutionScale(0.75)',
    b: 'h.gfx.setResolutionScale(1)',
    settle: 2500,
  },
  aa: {
    // Cannot be switched at runtime — WebGL context attributes are fixed at
    // creation — so this one reloads the page between arms. Handled specially.
    // Still one browser process and one compositor session, which is what rule 1
    // is actually protecting; but each arm pays a fresh boot, so give it more
    // --cycles than usual before believing a small delta.
    labelA: 'antialias:false (default framebuffer single-sampled)',
    labelB: 'antialias:true  (MSAA default framebuffer)',
    reloadA: '?aa=0', reloadB: '?aa=1',
  },
  postfx: {
    labelA: 'post chain OFF (raw scene to screen)',
    labelB: 'post chain ON',
    a: 'd.postfx.enabled=false',
    b: 'd.postfx.enabled=true',
  },
  taa: {
    labelA: 'TAA off (SMAA takes over)',
    labelB: 'TAA on',
    a: 'd.postfx.params.taa.enabled=false',
    b: 'd.postfx.params.taa.enabled=true',
  },
  bloom: {
    labelA: 'bloom off', labelB: 'bloom on',
    a: 'd.postfx.params.bloom.enabled=false',
    b: 'd.postfx.params.bloom.enabled=true',
  },
  dof: {
    labelA: 'dof off', labelB: 'dof on',
    a: 'd.postfx.params.dof.enabled=false',
    b: 'd.postfx.params.dof.enabled=true',
  },
};

// ---- stats ------------------------------------------------------------------
const STATS = [
  ['gpu.p50', (r) => r.gpu?.p50, 'ms'],
  ['gpu.p99', (r) => r.gpu?.p99, 'ms'],
  ['render.p50', (r) => r.render?.p50, 'ms'],
  ['render.p99', (r) => r.render?.p99, 'ms'],
  ['update.p50', (r) => r.update?.p50, 'ms'],
  ['interval.p50', (r) => r.frameInterval?.p50, 'ms'],
  ['interval.p99', (r) => r.frameInterval?.p99, 'ms'],
  ['interval.max', (r) => r.frameInterval?.max, 'ms'],
  // Rates, not counts: a slower arm presents fewer frames in the same wall
  // clock, so a raw "frames over 20 ms" count can go DOWN as the build gets
  // slower. Per second is the honest form.
  ['over20/s', (r) => r.over20 / (r.windowMs / 1000), '1/s'],
  ['over33/s', (r) => r.over33 / (r.windowMs / 1000), '1/s'],
];

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v) ? '   -  ' : (+v).toFixed(n).padStart(6));

async function apply(page, src) {
  if (!src) return;
  await page.evaluate((s) => {
    // eslint-disable-next-line no-new-func
    const fn = new Function('h', 'd', s);
    fn(window.__harness, window.__harness.debug);
  }, src);
}

// ---- main -------------------------------------------------------------------
const { arg, num, flag } = makeArgs();

const presetName = arg('preset', null);
const preset = presetName ? PRESETS[presetName] : null;
if (presetName && !preset) {
  console.error(`unknown preset "${presetName}". known: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(2);
}

const opts = {
  a: arg('a', preset?.a ?? null),
  b: arg('b', preset?.b ?? null),
  labelA: arg('label-a', preset?.labelA ?? 'A'),
  labelB: arg('label-b', preset?.labelB ?? 'B'),
  reloadA: preset?.reloadA ?? null,
  reloadB: preset?.reloadB ?? null,
  cycles: num('cycles', 4),
  dwell: num('dwell', 2000),
  settle: num('settle', preset?.settle ?? 1800),
  order: arg('order', 'abba'),
  w: num('w', 1600), h: num('h', 900), dpr: num('dpr', 1),
  start: arg('start', 'hero'),
  lead: num('lead', 1.2),
  amp: num('carve-amp', 0.85),
  period: num('carve-period', 2.6),
  straight: flag('straight'),
  prod: flag('prod'),
  syncGPU: flag('sync-gpu'),
  gpuTimer: !flag('no-gpu-timer'),
  json: arg('json', null),
};

if (!opts.a && !opts.b && !opts.reloadA) {
  console.error('nothing to compare. Use --preset <name> or --a "<js>" --b "<js>".');
  console.error(`presets: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(2);
}

const server = await startServer({ prod: opts.prod, port: 5311 });
const { browser, page, errors } = await launch(opts);
let code = 0;
const runs = [];

try {
  const env = await boot(page, server.url);
  console.log(`build: ${server.mode}   import.meta.env.DEV=${env.dev}`);
  console.log(`gpu: ${env.gpu}`);
  console.log(`viewport ${opts.w}x${opts.h} @ dpr ${opts.dpr} -> backbuffer ${env.gfx.drawingBuffer.join('x')} (${env.gfx.megapixels} Mpx), antialias=${env.gfx.antialias}`);
  console.log(`path: ${opts.straight ? 'STRAIGHT COAST' : `linked carves, amp ${opts.amp}, period ${opts.period}s`} from "${opts.start}"`);
  if (env.gpuTimerAvailable) {
    console.log('gpu timer: EXT_disjoint_timer_query_webgl2 available — primary statistic is GPU ms/frame');
  } else {
    console.log('gpu timer: EXT_disjoint_timer_query_webgl2 NOT AVAILABLE.');
    console.log('           Falling back to CPU wall clock. Without --sync-gpu that measures only the');
    console.log('           time to SUBMIT the frame, which understates GPU-bound work; with --sync-gpu');
    console.log('           a gl.finish() is folded into the render span and it becomes a GPU proxy that');
    console.log('           is comparable within this session only.');
  }
  console.log(`A = ${opts.labelA}\nB = ${opts.labelB}`);
  console.log(`${opts.cycles} cycles of "${opts.order}", settle ${opts.settle} ms, dwell ${opts.dwell} ms each\n`);

  await installPath(page, { lead: opts.lead, amp: opts.amp, period: opts.period, straight: opts.straight });

  const seq = opts.order.toLowerCase() === 'abab' ? ['A', 'B'] : ['A', 'B', 'B', 'A'];

  for (let c = 0; c < opts.cycles; c++) {
    for (const armName of seq) {
      const isA = armName === 'A';
      if (opts.reloadA) {
        // Context-attribute variants need a fresh page.
        const q = isA ? opts.reloadA : opts.reloadB;
        await page.goto(server.url + q, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 120000 });
        await sleep(1500);
        await installPath(page, { lead: opts.lead, amp: opts.amp, period: opts.period, straight: opts.straight });
      } else {
        await apply(page, isA ? opts.a : opts.b);
      }
      const r = await measureWindow(page, {
        start: opts.start,
        settleMs: Math.max(opts.settle, opts.lead * 1000 + 400),
        dwellMs: opts.dwell,
        gpuTimer: opts.gpuTimer,
        syncGPU: opts.syncGPU,
      });
      const gfx = await page.evaluate(() => window.__harness.gfx.info());
      runs.push({ cycle: c, arm: armName, report: r, gfx });
      const g = r.gpu ? `${f(r.gpu.p50)} ms gpu` : `${f(r.render.p50)} ms render`;
      process.stdout.write(`  c${c} ${armName}: ${g}   interval p50 ${f(r.frameInterval.p50)} p99 ${f(r.frameInterval.p99)}`
        + `  over20 ${f(r.over20 / (r.windowMs / 1000), 1)}/s  (n=${r.n})\n`);
    }
  }

  // --- pairing -------------------------------------------------------------
  // Consecutive (A,B) or (B,A) windows form a pair; delta is always B - A, so a
  // negative delta means B is cheaper.
  const pairs = [];
  for (let i = 0; i + 1 < runs.length; i += 2) {
    const x = runs[i], y = runs[i + 1];
    if (x.arm === y.arm) continue;
    pairs.push(x.arm === 'A' ? { A: x, B: y } : { A: y, B: x });
  }

  console.log(`\n════ ${pairs.length} pairs, delta = B − A (negative ⇒ B cheaper) ════`);
  const summary = {};
  for (const [name, get, unit] of STATS) {
    const av = pairs.map((p) => get(p.A.report)).filter((v) => v !== undefined && v !== null);
    const bv = pairs.map((p) => get(p.B.report)).filter((v) => v !== undefined && v !== null);
    if (av.length !== pairs.length || bv.length !== pairs.length) continue;
    const deltas = pairs.map((p) => get(p.B.report) - get(p.A.report));
    const pos = deltas.filter((d) => d > 0).length;
    const med = median(deltas);
    const minA = Math.min(...av), minB = Math.min(...bv);
    summary[name] = {
      unit, A: av, B: bv, deltas,
      medianDelta: med, minA, minB, minDelta: minB - minA,
      pairsWhereBHigher: pos, pairs: pairs.length,
    };
    console.log(`${name.padEnd(13)} A min ${f(minA)}  B min ${f(minB)}  |  min Δ ${f(minB - minA)}`
      + `  median pair Δ ${f(med)}  |  B higher in ${pos}/${pairs.length} pairs`);
    console.log(`${''.padEnd(13)} per-pair Δ: ${deltas.map((d) => f(d)).join(' ')}`);
  }

  // --- verdict --------------------------------------------------------------
  // GPU time when the timer query gave us any; otherwise CPU render time, which
  // only means something if --sync-gpu drained the GPU inside the span (the
  // caveat is printed below).
  const primary = summary['gpu.p50'] ? 'gpu.p50' : 'render.p50';
  const s = summary[primary];
  if (s) {
    const consistent = Math.max(s.pairsWhereBHigher, s.pairs - s.pairsWhereBHigher);
    const dir = s.medianDelta > 0 ? 'B is MORE expensive' : 'B is LESS expensive';
    console.log(`\nverdict on ${primary}: ${dir} by ${Math.abs(s.medianDelta).toFixed(2)} ms `
      + `(median of ${s.pairs} paired deltas), min-of-N Δ ${s.minDelta.toFixed(2)} ms, `
      + `direction consistent in ${consistent}/${s.pairs} pairs.`);
    if (consistent < Math.ceil(s.pairs * 0.75)) {
      console.log('  ^ the sign is NOT consistent across pairs. Treat this as "no measurable difference",');
      console.log('    whatever the median says, and re-run with more --cycles or a longer --dwell.');
    }
    if (!summary['gpu.p50'] && !opts.syncGPU) {
      console.log('  ^ CAVEAT: this is CPU submit time, not GPU time. Re-run with --sync-gpu for a GPU proxy.');
    }
  }

  const sysA = pairs[0]?.A.report.sys ?? {};
  const sysB = pairs[0]?.B.report.sys ?? {};
  const names = [...new Set([...Object.keys(sysA), ...Object.keys(sysB)])];
  if (names.length) {
    console.log('\nper-subsystem cpu p50 / p99 ms (first pair only — use tools/frametime.mjs for the full picture)');
    for (const n of names.sort()) {
      console.log(`  ${n.padEnd(10)} A ${f(sysA[n]?.p50)} / ${f(sysA[n]?.p99)}   B ${f(sysB[n]?.p50)} / ${f(sysB[n]?.p99)}`);
    }
  }

  if (opts.json) {
    const out = path.resolve(ROOT, opts.json);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify({ env, opts, runs, summary }, null, 2));
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
