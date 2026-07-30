/**
 * Per-subsystem CPU cost inside the real rAF loop.
 *
 * Wraps update() on the live subsystem handles and reports the distribution of
 * each one's per-frame cost while the sim free-runs. This is where a streaming
 * hitch shows up: a subsystem whose median is 0.1 ms but whose p99 is 8 ms
 * costs no average frame time and still drops one frame in a hundred below the
 * vsync deadline.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const W = +arg('w', 1600), H = +arg('h', 900), SECS = +arg('secs', 12);

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5320, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 300000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror: ' + e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));

await page.evaluate(() => {
  const d = window.__harness.debug;
  window.__t = {};
  for (const k of ['terrain', 'sky', 'scatter', 'skier', 'spray', 'tracks', 'postfx', 'physics']) {
    const o = d[k];
    if (!o || typeof o.update !== 'function') continue;
    const orig = o.update.bind(o);
    window.__t[k] = [];
    o.update = (...a) => { const t0 = performance.now(); const r = orig(...a); window.__t[k].push(performance.now() - t0); return r; };
  }
  // whole-frame deltas too
  window.__t.__frame = [];
  let prev = performance.now();
  const tick = () => { const n = performance.now(); window.__t.__frame.push(n - prev); prev = n; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__setAuto(true);
});

await new Promise((r) => setTimeout(r, 1000));
await page.evaluate(() => { for (const k in window.__t) window.__t[k].length = 0; });
await new Promise((r) => setTimeout(r, SECS * 1000));

const out = await page.evaluate(() => {
  const res = {};
  for (const [k, v] of Object.entries(window.__t)) {
    const s = v.slice().sort((a, b) => a - b);
    if (!s.length) continue;
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    res[k] = { n: s.length, sum: v.reduce((a, b) => a + b, 0),
      med: q(0.5), p95: q(0.95), p99: q(0.99), max: s[s.length - 1] };
  }
  return res;
});
console.log(`  ${'subsystem'.padEnd(10)} ${'med'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)} ${'max'.padStart(8)} ${'mean'.padStart(7)}`);
for (const [k, v] of Object.entries(out).sort((a, b) => b[1].sum - a[1].sum)) {
  console.log(`  ${k.padEnd(10)} ${v.med.toFixed(2).padStart(7)} ${v.p95.toFixed(2).padStart(7)} ${v.p99.toFixed(2).padStart(7)} ${v.max.toFixed(2).padStart(8)} ${(v.sum / v.n).toFixed(2).padStart(7)}`);
}
await browser.close(); await server.close(); process.exit(0);
