/**
 * Where does this machine actually stand, at the resolution the game is PLAYED at?
 *
 *   node tools/perf-baseline.mjs --w 2560 --h 1440 --dpr 2
 *   node tools/perf-baseline.mjs --w 1728 --h 1117 --dpr 2 --seconds 8
 *
 * Every other tool in here answers "is A faster than B". This one answers the
 * prior question nobody had asked at the right pixel count: what is the cost
 * CURVE on this display, and where does the shipped controller land on it?
 *
 * Two phases, deliberately in this order:
 *
 *   A — SHIPPED DEFAULTS, controller LIVE. Samples rAF intervals in-page
 *       directly rather than through `perf.start()`, because `perf.recording`
 *       freezes the controller (engine.js rule 1) and freezing it here would
 *       measure something no player ever sees. Reports where the ladder settled
 *       and what the frame looked like once it had.
 *
 *   B — PINNED RUNG SWEEP, controller frozen. Walks the ladder from 1.0 down,
 *       measuring each rung over the canonical carve. This is the cost curve at
 *       THIS display size — the thing CLAUDE.md trap 5 warns must never be
 *       extrapolated from the 1.4-5.8 Mpx fit, because at 9 Mpx the real cost is
 *       77.5 ms where every linear fit predicts 40-54.
 *
 * Both phases quote the RUNG STRUCTURE, not fps: the presented interval is
 * quantised to multiples of the refresh period, so "37 fps" is really two rungs
 * alternating (CLAUDE.md trap 8). `displayTick` is reported per phase.
 */
import { startServer, launch, boot, installPath, measureWindow, makeArgs, STARTS, sleep, printReport } from './frametime.mjs';

const { arg, num, flag } = makeArgs();
const opts = {
  w: num('w', 2560), h: num('h', 1440), dpr: num('dpr', 2),
  seconds: num('seconds', 6),
  start: arg('start', 'hero'),
  liveSeconds: num('live-seconds', 25),
  prod: flag('prod'),
  sweep: !flag('no-sweep'),
  rungs: (arg('rungs', '1.0,0.8,0.6,0.5,0.4') || '').split(',').map(Number),
};

const f = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v) ? '  -  ' : (+v).toFixed(n));

/**
 * Sample presented intervals in-page WITHOUT `perf.start()`, so the adaptive
 * controller keeps running. Returns the interval distribution plus a trace of
 * every resolution change the controller made while we watched.
 */
async function watchLive(page, ms) {
  await page.evaluate(() => {
    window.__bl = { iv: [], mpx: [], last: 0 };
    const tick = (now) => {
      const s = window.__bl;
      if (s.last) { s.iv.push(now - s.last); s.mpx.push(window.__harness.gfx.info().megapixels); }
      s.last = now;
      s.raf = requestAnimationFrame(tick);
    };
    window.__bl.raf = requestAnimationFrame(tick);
  });
  await sleep(ms);
  return page.evaluate(() => {
    cancelAnimationFrame(window.__bl.raf);
    const iv = window.__bl.iv, mpx = window.__bl.mpx;
    const q = (a, p) => { const v = a.slice().sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))]; };
    // Last 40% of the window: after the ladder has settled.
    const tailFrom = Math.floor(iv.length * 0.6);
    const tail = iv.slice(tailFrom);
    return {
      n: iv.length,
      all: { p50: q(iv, 0.5), p95: q(iv, 0.95), p99: q(iv, 0.99), max: Math.max(...iv) },
      settled: tail.length > 10 ? {
        p50: q(tail, 0.5), p95: q(tail, 0.95), p99: q(tail, 0.99), max: Math.max(...tail),
        over20: tail.filter((v) => v > 20).length, over33: tail.filter((v) => v > 33).length,
        n: tail.length,
      } : null,
      mpxStart: mpx[0], mpxEnd: mpx[mpx.length - 1],
      mpxMin: Math.min(...mpx), mpxMax: Math.max(...mpx),
      gfx: window.__harness.gfx.info(),
    };
  });
}

const server = await startServer({ prod: opts.prod, port: 5307 });
const { browser, page, errors } = await launch(opts);
let code = 0;
try {
  // Phase A needs the controller alive, so do NOT let boot() freeze it.
  const env = await boot(page, server.url, { freezeAdaptive: false });
  console.log(`build: ${server.mode}   gpu: ${env.gpu}`);
  console.log(`viewport: ${opts.w}x${opts.h} @ dpr ${opts.dpr}  ->  native ${(opts.w * opts.dpr * opts.h * opts.dpr / 1e6).toFixed(2)} Mpx`);
  console.log(`booted backbuffer: ${env.gfx.drawingBuffer.join('x')} (${env.gfx.megapixels} Mpx)  scale=${env.gfx.resolutionScale} adaptive=${env.gfx.adaptive}`);

  await installPath(page, { lead: 1.2, amp: 0.85, period: 2.6 });

  // ---- phase A: what the player gets ---------------------------------------
  const [x, z, hd] = STARTS[opts.start] ?? STARTS.hero;
  await page.evaluate((x, z, hd) => { window.__setAuto?.(true); window.__path.restart(x, z, hd); }, x, z, hd);
  console.log(`\n===== phase A — shipped defaults, controller LIVE, ${opts.liveSeconds}s carve =====`);
  const live = await watchLive(page, opts.liveSeconds * 1000);
  console.log(`   whole window   p50 ${f(live.all.p50)}  p95 ${f(live.all.p95)}  p99 ${f(live.all.p99)}  max ${f(live.all.max)}  (n=${live.n})`);
  if (live.settled) {
    console.log(`   SETTLED (last 40%)  p50 ${f(live.settled.p50)}  p95 ${f(live.settled.p95)}  p99 ${f(live.settled.p99)}  max ${f(live.settled.max)}`
      + `   over20 ${live.settled.over20}/${live.settled.n}  over33 ${live.settled.over33}/${live.settled.n}`);
  }
  console.log(`   backbuffer travelled ${f(live.mpxStart)} -> ${f(live.mpxEnd)} Mpx  (min ${f(live.mpxMin)} max ${f(live.mpxMax)})`);
  console.log(`   ladder: scale ${live.gfx.resolutionScale}  step ${live.gfx.adaptiveStep}/${live.gfx.adaptiveMaxStep}  events ${live.gfx.adaptiveEvents}`);
  console.log(`   displayTick ${f(live.gfx.displayTick, 3)} ms (${live.gfx.displayHz} Hz)  lockMs ${f(live.gfx.lockMs)}  vsyncLadder ${JSON.stringify(live.gfx.vsyncLadder)}`);
  if (live.gfx.adaptiveLog?.length) console.log(`   steps: ${live.gfx.adaptiveLog.map((s) => `${s.from}->${s.to}@${(s.t / 1000).toFixed(1)}s`).join('  ')}`);
  if (live.gfx.lastDecision) console.log(`   lastDecision ${JSON.stringify(live.gfx.lastDecision)}`);

  // ---- phase B: the cost curve on THIS display -----------------------------
  if (opts.sweep) {
    console.log(`\n===== phase B — pinned rung sweep, controller frozen =====`);
    await page.evaluate(() => window.__harness.gfx.freeze());
    console.log(`   scale      Mpx     p50     p95     p99     max   over20  over33   cpu upd/rnd`);
    const rows = [];
    for (const s of opts.rungs) {
      await page.evaluate((s) => window.__harness.gfx.setResolutionScale(s), s);
      await sleep(400);
      const r = await measureWindow(page, { start: opts.start, settleMs: 1800, dwellMs: opts.seconds * 1000, gpuTimer: false });
      const mpx = await page.evaluate(() => window.__harness.gfx.info().megapixels);
      rows.push({ scale: s, mpx, r });
      console.log(`   ${String(s).padEnd(6)}  ${f(mpx).padStart(6)}  ${f(r.frameInterval.p50).padStart(6)}  ${f(r.frameInterval.p95).padStart(6)}`
        + `  ${f(r.frameInterval.p99).padStart(6)}  ${f(r.frameInterval.max).padStart(6)}  ${String(r.over20).padStart(6)}  ${String(r.over33).padStart(6)}`
        + `   ${f(r.update.p50)}/${f(r.render.p50)}`);
    }
    // Slope between the extremes actually measured — never extrapolated.
    if (rows.length >= 2) {
      const a = rows[rows.length - 1], b = rows[0];
      const slope = (b.r.frameInterval.p50 - a.r.frameInterval.p50) / (b.mpx - a.mpx);
      console.log(`\n   measured slope over [${f(a.mpx)}, ${f(b.mpx)}] Mpx: ${f(slope)} ms/Mpx`
        + `   implied fixed floor: ${f(a.r.frameInterval.p50 - slope * a.mpx)} ms`);
      console.log(`   (the curve is superlinear past ~5.8 Mpx — do not extrapolate this fit, CLAUDE.md trap 5)`);
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
