/**
 * Ad-hoc "what if" rig: set snow-material uniforms from the command line, then
 * capture the hero framing plus a 1:1 crop of the far range.
 *
 *   node tools/terrain-what-if.mjs --set uTreeLine=1400,uForestAmount=1 --out shots/wi
 *
 * Used to prove a shader path is reached at all before spending an iteration
 * tuning a number that turns out to be multiplied by zero.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SET = (arg('set', '') || '').split(',').filter(Boolean)
  .map((s) => { const [k, v] = s.split('='); return [k, +v]; });
const OUT = path.resolve(ROOT, arg('out', 'shots/whatif'));

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5222, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 180000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('ERR ' + e.message));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(() => window.__setAuto?.(false));
await page.evaluate(() => {
  window.__harness.setPlayer(0, 700, Math.PI);
  window.__harness.step(1 / 60, 90);
});
for (let i = 0; i < 12; i++) {
  await page.evaluate(() => window.__harness.step(1 / 60, 1));
  await new Promise((r) => setTimeout(r, 32));
}
if (SET.length) {
  // terrain.update() rewrites the aerial uniforms every frame from the sky's
  // fog, so an override has to be re-applied after each step, not just once.
  await page.evaluate((SET) => {
    const t = window.__harness.debug.terrain;
    const u = t.snowUniforms;
    const pin = () => { for (const [k, v] of SET) if (u[k]) u[k].value = v; };
    const orig = t.update.bind(t);
    t.update = (dt, st) => { orig(dt, st); pin(); };
    pin();
  }, SET);
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.__harness.step(1 / 60, 1));
    await new Promise((r) => setTimeout(r, 32));
  }
}
await fs.mkdir(OUT, { recursive: true });
await page.screenshot({ path: path.join(OUT, 'hero.png') });
await page.screenshot({ path: path.join(OUT, 'crop-farpeaks.png'), clip: { x: 320, y: 140, width: 640, height: 340 } });

// Surface facts at points on the across-valley range, so the shader's gates can
// be checked against real numbers instead of guessed.
const pts = await page.evaluate(() => {
  const t = window.__harness.debug.terrain;
  const out = [];
  for (const [x, z] of [[-2500, -2820], [-1050, -3020], [250, -2600], [-600, -2400],
    [1600, -2900], [-3000, -1800], [900, -2300], [-1800, -2300]]) {
    const n = t.normal(x, z, 2.0);
    out.push({ x, z, h: +t.height(x, z).toFixed(0), steepRad: +Math.acos(n.y).toFixed(3) });
  }
  return out;
});
console.log(JSON.stringify(pts));

// Contract check: both documented normal() call conventions, and a finite,
// gradient-free height everywhere including well outside the baked map.
const contract = await page.evaluate(() => {
  const t = window.__harness.debug.terrain;
  const THREE_V3 = t.normal(0, 0, undefined).constructor;
  const out = { ok: true, notes: [] };
  const tmp = new THREE_V3();
  for (const [x, z] of [[0, 700], [-260, 300], [180, 120], [-40, -260],
    [3000, -3000], [5200, -5200], [-9000, 1000], [0, 8000]]) {
    const h = t.height(x, z);
    const na = t.normal(x, z, tmp);          // analytic, into caller's vector
    const nb = t.normal(x, z, 2.0);          // finite-differenced footprint
    const finite = Number.isFinite(h)
      && Number.isFinite(na.x) && Math.abs(na.length() - 1) < 1e-4
      && Number.isFinite(nb.x) && Math.abs(nb.length() - 1) < 1e-4;
    const agree = na.dot(nb);                // must not be wildly different
    if (!finite || agree < 0.55) {
      out.ok = false;
      out.notes.push({ x, z, h, agree: +agree.toFixed(3), finite });
    }
    if (na !== tmp) { out.ok = false; out.notes.push('normal(x,z,vec3) did not write the caller vector'); }
  }
  // continuity across the backdrop blend seam
  let maxJump = 0;
  for (let s = 3400; s < 7400; s += 4) {
    const a = t.height(s, 120), b = t.height(s + 4, 120);
    maxJump = Math.max(maxJump, Math.abs(b - a));
  }
  out.maxSeamJumpPer4m = +maxJump.toFixed(2);
  return out;
});
console.log('CONTRACT ' + JSON.stringify(contract));
await browser.close();
await server.close();
process.exit(0);
