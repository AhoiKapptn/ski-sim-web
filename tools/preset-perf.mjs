/**
 * What does each graphics preset actually BUY, at the real display size?
 *
 *   node tools/preset-perf.mjs --w 2560 --h 1440 --dpr 2
 *
 * The presets are a promise to the player: pick a lower one and the game gets
 * smoother. That promise is checkable, and until it is checked it is decoration.
 *
 * Each preset is measured with the resolution controller LIVE, because the
 * presets configure the controller (its floor, its target, whether it runs at
 * all) and freezing it would measure a configuration no player ever gets. So
 * this samples rAF in-page rather than going through `perf.start()`, which
 * freezes the controller by design (engine.js rule 1).
 *
 * Read the RUNG, not the millisecond (CLAUDE.md trap 8): the presented interval
 * is quantised to the refresh period, so what matters is which rung the frame
 * settles on and how much of the window misses it — not the mean.
 */
import { startServer, launch, boot, installPath, makeArgs, sleep, STARTS } from './frametime.mjs';

const { arg, num, flag } = makeArgs();
const opts = {
  w: num('w', 2560), h: num('h', 1440), dpr: num('dpr', 2),
  dwell: num('dwell', 14),           // seconds watched per preset
  start: arg('start', 'hero'),
  presets: (arg('presets', 'ultra,high,medium,low,auto') || '').split(',').filter(Boolean),
  prod: flag('prod'),
};
const f = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v) ? '  -  ' : (+v).toFixed(n));

const server = await startServer({ prod: opts.prod, port: 5313 });
const { browser, page, errors } = await launch(opts);
let code = 0;
try {
  const env = await boot(page, server.url, { freezeAdaptive: false });
  console.log(`gpu: ${env.gpu}   build: ${server.mode}`);
  console.log(`viewport ${opts.w}x${opts.h} @dpr ${opts.dpr} -> native ${(opts.w * opts.dpr * opts.h * opts.dpr / 1e6).toFixed(2)} Mpx\n`);
  await installPath(page, { lead: 1.2, amp: 0.85, period: 2.6 });
  const [x, z, hd] = STARTS[opts.start] ?? STARTS.hero;

  console.log('preset    Mpx    tris     p50    p95    p99    max   >20ms   >33ms   rung');
  for (const p of opts.presets) {
    await page.evaluate((p, x, z, hd) => {
      window.__harness.settings.setPreset(p);
      window.__setAuto(true);
      window.__path.restart(x, z, hd);
    }, p, x, z, hd);
    // Let the preset's shader relinks and ring rebuilds finish, and let the
    // controller find its rung, before the window we keep.
    await sleep(6000);
    await page.evaluate(() => {
      window.__pp = { iv: [], last: 0 };
      const t = (now) => {
        const s = window.__pp;
        if (s.last) s.iv.push(now - s.last);
        s.last = now; s.raf = requestAnimationFrame(t);
      };
      window.__pp.raf = requestAnimationFrame(t);
    });
    await sleep(opts.dwell * 1000);
    const r = await page.evaluate(() => {
      cancelAnimationFrame(window.__pp.raf);
      const iv = window.__pp.iv;
      const q = (a, pp) => { const v = a.slice().sort((m, n) => m - n); return v[Math.min(v.length - 1, Math.floor(pp * (v.length - 1) + 0.5))]; };
      const g = window.__harness.gfx.info();
      const mi = window.__harness.debug.terrain.meshInfo?.();
      // Which vsync rung is the frame sitting on, and how cleanly?
      const tick = g.displayTick || 0;
      const p50 = q(iv, 0.5);
      const k = tick ? Math.round(p50 / tick) : 0;
      const onRung = tick ? iv.filter((v) => Math.abs(v - k * tick) < tick * 0.25).length / iv.length : 0;
      return {
        n: iv.length, p50, p95: q(iv, 0.95), p99: q(iv, 0.99), max: Math.max(...iv),
        over20: iv.filter((v) => v > 20).length, over33: iv.filter((v) => v > 33).length,
        mpx: g.megapixels, scale: g.resolutionScale, tick, k, onRung,
        tris: mi ? mi.triangles : null,
      };
    });
    const rung = r.tick ? `${r.k}x${f(r.tick)}=${f(r.k * r.tick)} (${(r.onRung * 100).toFixed(0)}% on it)` : '?';
    console.log(`${p.padEnd(8)} ${f(r.mpx).padStart(5)}  ${r.tris ? (r.tris / 1e6).toFixed(2) + 'M' : '  -  '}`
      + `  ${f(r.p50).padStart(6)} ${f(r.p95).padStart(6)} ${f(r.p99).padStart(6)} ${f(r.max).padStart(6)}`
      + `  ${String(r.over20).padStart(4)}/${r.n}  ${String(r.over33).padStart(4)}/${r.n}  ${rung}`);
  }
} catch (e) {
  errors.push('harness: ' + (e?.message ?? String(e)));
  code = 1;
} finally {
  if (errors.length) { code = 1; console.error('\n--- errors ---'); errors.slice(0, 12).forEach((e) => console.error('  ' + e)); }
  await browser.close();
  await server.close();
  process.exit(code);
}
