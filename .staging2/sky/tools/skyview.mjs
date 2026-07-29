/** Renders tone-mapped views of the sky dome alone (sun disc, cloud decks). */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

const VIEWS = [
  ['sun-noon', 0.5, null, 0, 14],
  ['sun-day', 0.335, null, 0, 14],
  ['sun-golden', 0.265, null, 0, 14],
  ['sun-golden-wide', 0.265, null, 0, 50],
  ['clouds-day', 0.335, 26, 90, 60],
  ['clouds-golden', 0.265, 22, 120, 60],
];

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5213, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/tools/probe.html?views`;

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 300000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: 560, height: 560, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

let code = 0;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__probeReady === true', { timeout: 60000 });
  await fs.mkdir(path.join(ROOT, 'shots/probe'), { recursive: true });
  for (const [name, tod, el, az, fov] of VIEWS) {
    await page.evaluate((a) => window.__view(...a), [tod, el, az, fov]);
    await new Promise((r) => setTimeout(r, 120));
    const canvas = await page.$('canvas');
    await canvas.screenshot({ path: path.join(ROOT, `shots/probe/${name}.png`) });
    console.log('✓ ' + name);
  }
} catch (e) {
  console.error('skyview failed: ' + (e?.message ?? e));
  code = 1;
} finally {
  if (errs.length) { errs.slice(0, 10).forEach((e) => console.error('  ' + e)); code = 1; }
  await browser.close();
  await server.close();
  process.exit(code);
}
