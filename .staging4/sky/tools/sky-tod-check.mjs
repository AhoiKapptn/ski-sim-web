/**
 * Time-of-day sanity sweep for sky.js.
 *
 * Steps the sun across the whole day and asserts that nothing in the derived
 * lighting goes non-finite, negative, or absurd: the haze colour, the horizon
 * tints, the key light and the frame's own mean/stddev. Cheap regression guard
 * for the fact that the horizon-band tint and the aerial-perspective ceiling
 * are both functions of solar elevation.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 5221, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 180000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 450 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let bad = 0;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => window.__setAuto?.(false));

  for (let i = 0; i <= 20; i++) {
    const t = 0.16 + (i / 20) * 0.68;    // dawn -> dusk
    const r = await page.evaluate((t) => {
      const sky = window.__harness.debug.sky;
      sky.setTimeOfDay(t);
      window.__harness.step(1 / 60, 2);
      const s = window.__harness.stats();
      const u = sky.uniforms;
      const fin = (a) => a.every((v) => Number.isFinite(v) && v >= -1e-6);
      return {
        t: +t.toFixed(3),
        elev: +(sky.getSunElevation() * 180 / Math.PI).toFixed(1),
        sunI: +sky.sun.intensity.toFixed(2),
        cool: sky.hazeInfo.cool.map((v) => +v.toFixed(3)),
        coolLum: +sky.hazeInfo.coolLum.toFixed(3),
        skyRidgeLum: +sky.hazeInfo.skyRidgeLum.toFixed(3),
        hT: u.uHorizonTint.value.toArray().map((v) => +v.toFixed(2)),
        hC: u.uHorizonTintCool.value.toArray().map((v) => +v.toFixed(2)),
        mean: +s.mean.toFixed(1), sd: +s.stddev.toFixed(1),
        ok: fin(sky.hazeInfo.cool) && fin(u.uHorizonTint.value.toArray())
          && fin(u.uHorizonTintCool.value.toArray())
          && Number.isFinite(sky.sun.intensity) && sky.sun.intensity >= 0
          && sky.hazeInfo.coolLum <= sky.hazeInfo.skyRidgeLum * 1.02 + 1e-6,
      };
    }, t);
    if (!r.ok || !(r.mean > 1) || !(r.sd > 0.5)) { bad++; console.log('  ✗', JSON.stringify(r)); }
    else console.log(`  ok t=${r.t} elev=${String(r.elev).padStart(6)}  sunI=${String(r.sunI).padStart(6)}  hazeLum=${r.coolLum}/${r.skyRidgeLum}  hT=${r.hT}  hC=${r.hC}  frame mean=${r.mean} sd=${r.sd}`);
  }
  await page.evaluate(() => window.__harness.debug.sky.setTimeOfDay(0.335));
} catch (e) {
  errors.push(String(e?.message ?? e));
  bad++;
} finally {
  if (errors.length) { bad++; console.error('--- errors ---'); errors.slice(0, 10).forEach((e) => console.error('  ' + e)); }
  await browser.close();
  await server.close();
  console.log(bad ? `FAIL (${bad})` : 'PASS');
  process.exit(bad ? 1 : 0);
}
