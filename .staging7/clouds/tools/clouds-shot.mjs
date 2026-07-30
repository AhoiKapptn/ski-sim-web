/**
 * Self-contained visual capture harness.
 *
 *   node tools/shoot.mjs --out shots/myrun            # all shots
 *   node tools/shoot.mjs --out shots/x --only hero,ridge
 *   node tools/shoot.mjs --out shots/x --w 1920 --h 1080 --perf
 *
 * Spawns its own Vite dev server + headless Chrome, so nothing needs to be
 * running beforehand. Exits non-zero on console errors, WebGL context loss, or
 * blank/black frames — an agent can trust a zero exit to mean "it rendered".
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const flag = (k) => argv.includes('--' + k);

const OUT = path.resolve(ROOT, arg('out', 'shots/latest'));
const W = +arg('w', 1600), H = +arg('h', 900);
const ONLY = arg('only', '')?.split(',').filter(Boolean);
const PERF = flag('perf');
const SET = arg('set', '');   // JS run against window.__harness.debug before each shot

/**
 * Canonical camera framings. Keep these stable — side-by-side comparisons across
 * iterations are only meaningful if the framing never moves.
 */
const SHOTS = {
  hero:    { x: 0,    z: 700,  heading: Math.PI, settle: 90,  desc: 'Signature third-person chase, mid-slope' },
  ridge:   { x: -260, z: 300,  heading: Math.PI * 0.86, settle: 120, desc: 'Ridge line with distant peaks' },
  trees:   { x: 180,  z: 120,  heading: Math.PI * 1.1,  settle: 140, desc: 'Through the treeline' },
  steep:   { x: -40,  z: -260, heading: Math.PI,        settle: 200, desc: 'Steep pitch, high speed' },
  closeup: { x: 60,   z: 480,  heading: Math.PI * 0.95, settle: 60,  desc: 'Close on skier + snow surface' },
};

// ---- image stats (raw PNG decode via canvas in-page is easier) ---------------
async function frameStats(page) {
  return page.evaluate(() => window.__harness.stats());
}

// ---- main -------------------------------------------------------------------
const server = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error',
  server: { port: 5199, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: [
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox',
    '--force-color-profile=srgb',
    // NB: do NOT add --disable-frame-rate-limit. It starves the headless
    // compositor of presented frames and Page.captureScreenshot hangs forever.
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const ignorable = (u = '') => /favicon|\.ico($|\?)/i.test(u);
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !ignorable(m.location()?.url) && !/favicon/i.test(t)) errors.push('console: ' + t);
});
page.on('requestfailed', (r) => { if (!ignorable(r.url())) errors.push('requestfailed: ' + r.url() + ' ' + r.failure()?.errorText); });

await fs.mkdir(OUT, { recursive: true });

let exitCode = 0;
const report = { url, viewport: [W, H], shots: [], errors, perf: null };

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200)); // let async assets/shaders finish

  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const e = gl.getExtension('WEBGL_debug_renderer_info');
    return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  report.gpu = gpu;

  const names = ONLY.length ? ONLY : Object.keys(SHOTS);
  for (const name of names) {
    const s = SHOTS[name];
    if (!s) { errors.push(`unknown shot: ${name}`); exitCode = 1; continue; }

    await page.evaluate(() => window.__setAuto?.(false));
    if (SET) {
      await page.evaluate((src) => {
        const d = window.__harness.debug;
        // eslint-disable-next-line no-new-func
        new Function('d', 'sky', src)(d, d.sky);
      }, SET);
    }
    await page.evaluate((s) => {
      window.__harness.setPlayer(s.x, s.z, s.heading);
      window.__harness.step(1 / 60, s.settle);   // settle sim (camera lag, particles, streaming)
    }, s);
    // A few more discrete frames so temporal effects (TAA, motion blur) converge.
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => window.__harness.step(1 / 60, 1));
      await new Promise((r) => setTimeout(r, 32));
    }

    const stats = await frameStats(page);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });

    const bad = stats.lost || stats.stddev < 2.0 || stats.mean < 3 || stats.mean > 252;
    if (bad) exitCode = 1;
    report.shots.push({ name, desc: s.desc, file: path.relative(ROOT, file), ...stats, blank: bad });
    console.log(`${bad ? '✗' : '✓'} ${name.padEnd(9)} mean=${stats.mean?.toFixed(1)} sd=${stats.stddev?.toFixed(1)}  ${path.relative(ROOT, file)}`);
  }

  if (PERF) {
    await page.evaluate(() => { window.__harness.frames = 0; window.__setAuto?.(true); });
    await new Promise((r) => setTimeout(r, 4000));
    const frames = await page.evaluate(() => window.__harness.frames);
    report.perf = { fps: +(frames / 4).toFixed(1) };
    console.log(`⏱  ${report.perf.fps} fps @ ${W}x${H}`);
  }
} catch (e) {
  errors.push('harness: ' + (e?.message ?? String(e)));
  exitCode = 1;
} finally {
  if (errors.length) {
    exitCode = 1;
    console.error('\n--- errors ---');
    for (const e of errors.slice(0, 40)) console.error('  ' + e);
  }
  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
  process.exit(exitCode);
}
