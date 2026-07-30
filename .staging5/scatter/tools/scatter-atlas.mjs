/** Dumps the live impostor atlases and their opaque-texel mean colour. */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const OUT = path.resolve(ROOT, arg('out', 'shots/atlas'));

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5411, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 180000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 800));
await fs.mkdir(OUT, { recursive: true });

const res = await page.evaluate(() => {
  const g = window.__harness.debug.scatter.group;
  const seen = new Map();
  g.traverse((o) => {
    if (!o.isInstancedMesh || !o.material?.map) return;
    if (!seen.has(o.name)) seen.set(o.name, o.material);
  });
  const out = [];
  for (const [name, m] of seen) {
    const img = m.map.image;            // DataTexture: { data, width, height }
    const w = img.width, h = img.height;
    const d = img.data;
    let n = 0, r = 0, gg = 0, b = 0, na = 0;
    const at = m.alphaTest * 255;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] >= at) { n++; r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
      if (d[i + 3] > 8) na++;
    }
    out.push({ name, size: [w, h], alphaTest: m.alphaTest, coverage: +(n / (w * h)).toFixed(3),
      meanOpaqueRGB: [r / n, gg / n, b / n].map((v) => +v.toFixed(1)) });
  }
  return out;
});
console.log(JSON.stringify(res, null, 1));

const dumps = await page.evaluate(async () => {
  const g = window.__harness.debug.scatter.group;
  const seen = new Map();
  g.traverse((o) => { if (o.isInstancedMesh && o.material?.map && !seen.has(o.name)) seen.set(o.name, o.material); });
  const out = [];
  for (const [name, m] of seen) {
    const img = m.map.image;
    const w = img.width, h = img.height;
    const c = new OffscreenCanvas(w, h);
    const x = c.getContext('2d');
    const id = x.createImageData(w, h);
    // rows are flipped on upload; flip back so the dump reads right way up
    for (let y = 0; y < h; y++) for (let i = 0; i < w * 4; i++) {
      id.data[y * w * 4 + i] = img.data[(h - 1 - y) * w * 4 + i];
    }
    // composite over mid grey so alpha is visible
    for (let i = 0; i < id.data.length; i += 4) {
      const a = id.data[i + 3] / 255;
      id.data[i] = id.data[i] * a + 128 * (1 - a);
      id.data[i + 1] = id.data[i + 1] * a + 128 * (1 - a);
      id.data[i + 2] = id.data[i + 2] * a + 128 * (1 - a);
      id.data[i + 3] = 255;
    }
    x.putImageData(id, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    out.push([name, btoa(s)]);
  }
  return out;
});
for (const [name, b64] of dumps) {
  await fs.writeFile(path.join(OUT, `${name}.png`), Buffer.from(b64, 'base64'));
}
await browser.close();
await server.close();
process.exit(0);
