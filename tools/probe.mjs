/**
 * Generic in-page probe: boots the app headless and evaluates a JS expression
 * given as argv[2] (async function body, `h` = window.__harness).
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';

const ROOT = process.cwd();
const body = process.argv[2] ?? 'return 1';
const shotDir = process.argv[3] || null;

const server = await createServer({
  root: ROOT, configFile: ROOT + '/vite.config.js', logLevel: 'error',
  server: { port: 5311, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const q = process.env.PQ ? '?' + process.env.PQ : '';
const url = `http://127.0.0.1:${server.httpServer.address().port}/${q}`;
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));
  const out = await page.evaluate(new Function('shot', `return (async (h) => { ${body} })(window.__harness)`), shotDir);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  if (shotDir) {
    await fs.mkdir(shotDir, { recursive: true });
    await page.screenshot({ path: shotDir + '/probe.png' });
  }
} catch (e) {
  console.error('ERR', e.message);
} finally {
  if (errs.length) console.error('--- page errors ---\n' + errs.slice(0, 20).join('\n'));
  await browser.close();
  await server.close();
  process.exit(0);
}
