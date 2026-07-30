/**
 * Decomposes the impostor card's brightness: renders the hero framing with the
 * card material's albedo forced to a series of known constants, so the lighting
 * + fog transfer function for a card can be solved instead of guessed.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5511, strictPort: false, host: '127.0.0.1' },
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
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1000));

await page.evaluate(() => {
  window.__setAuto?.(false);
  window.__harness.setPlayer(0, 700, Math.PI);
  window.__harness.step(1 / 60, 90);
});
for (let i = 0; i < 12; i++) {
  await page.evaluate(() => window.__harness.step(1 / 60, 1));
  await new Promise((r) => setTimeout(r, 32));
}

// The sample set is built by flashing the vegetation pure emissive green — the
// existing shader patches (LOD dissolve, stochastic alpha) stay in place, so the
// mask is exactly the silhouette the cards actually draw, unbiased by how bright
// they happen to be. A difference mask cannot be used: the white cards differ
// from the snow behind them by only a few levels, so they would drop out of
// their own measurement.
const applyVeg = (code) => page.evaluate((code) => {
  window.__harness.debug.scatter.group.traverse((o) => {
    if (!o.isInstancedMesh || !/^(tree0|tree1|tree2|clust|mass)$/.test(o.name || '')) return;
    // eslint-disable-next-line no-new-func
    new Function('m', 'name', code)(o.material, o.name);
  });
}, code);
const setVeg = (vis) => page.evaluate((vis) => {
  window.__harness.debug.scatter.group.traverse((o) => {
    if (o.isInstancedMesh && /^(tree0|tree1|tree2|clust|mass)$/.test(o.name || '')) o.visible = vis;
  });
}, vis);

const shot = async () => page.screenshot({ encoding: 'base64' });
// materials are shared between meshes, so only save on the first visit
await applyVeg('if (!m.__c) { m.__c = m.color.clone(); m.__e = m.emissive.clone(); m.__f = m.fog; }'
  + 'm.color.setRGB(0,0,0); m.emissive.setRGB(0,0.35,0); m.fog = false; m.needsUpdate = true;');
await new Promise((r) => setTimeout(r, 900));
const maskB64 = await shot();
await applyVeg('m.color.copy(m.__c); m.emissive.copy(m.__e); m.fog = m.__f; m.needsUpdate = true;');
await new Promise((r) => setTimeout(r, 900));
await setVeg(false);
await new Promise((r) => setTimeout(r, 900));
const offB64 = await shot();
await setVeg(true);
await new Promise((r) => setTimeout(r, 900));

await page.evaluate(async ({ maskB64, offB64 }) => {
  const load = (b) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b; });
  const [a, b] = await Promise.all([load(maskB64), load(offB64)]);
  const w = a.width, h = a.height;
  const ca = new OffscreenCanvas(w, h), cb = new OffscreenCanvas(w, h);
  const xa = ca.getContext('2d'), xb = cb.getContext('2d');
  xa.drawImage(a, 0, 0); xb.drawImage(b, 0, 0);
  const A = xa.getImageData(0, 0, w, h).data, B = xb.getImageData(0, 0, w, h).data;
  const hit = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const i = k * 4;
    hit[k] = (A[i + 1] > A[i] + 40 && A[i + 1] > A[i + 2] + 40) ? 1 : 0;
  }
  const er = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let ok = 1;
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (!hit[(y + dy) * w + x + dx]) { ok = 0; break; }
    er[y * w + x] = ok;
  }
  window.__mask = er;
  let n = 0, L = 0;
  for (let k = 0; k < er.length; k++) if (er[k]) { n++; L += 0.2126 * B[k * 4] + 0.7152 * B[k * 4 + 1] + 0.0722 * B[k * 4 + 2]; }
  window.__maskN = n; window.__bgL = L / Math.max(1, n);
}, { maskB64, offB64 });
console.log('mask px', await page.evaluate(() => window.__maskN),
  'bg luma', (await page.evaluate(() => window.__bgL)).toFixed(1));

const sample = async (label, apply) => {
  await page.evaluate((apply) => {
    const g = window.__harness.debug.scatter.group;
    g.traverse((o) => {
      if (!o.isInstancedMesh) return;
      const veg = /^(tree0|tree1|tree2|clust|mass)$/.test(o.name || '');
      if (!veg) return;
      // eslint-disable-next-line no-new-func
      new Function('m', 'name', apply)(o.material, o.name);
    });
  }, apply);
  await new Promise((r) => setTimeout(r, 500));
  const buf = await page.screenshot({ encoding: 'base64' });
  const r = await page.evaluate(async (buf) => {
    const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + buf; });
    const c = new OffscreenCanvas(im.width, im.height); const x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, im.width, im.height).data;
    const m = window.__mask;
    let n = 0, R = 0, G = 0, B = 0, L = 0;
    for (let k = 0; k < m.length; k++) if (m[k]) {
      n++; R += d[k * 4]; G += d[k * 4 + 1]; B += d[k * 4 + 2];
      L += 0.2126 * d[k * 4] + 0.7152 * d[k * 4 + 1] + 0.0722 * d[k * 4 + 2];
    }
    return { rgb: [R / n, G / n, B / n].map((v) => +v.toFixed(1)),
      luma: +(L / n).toFixed(1), ratio: +((L / n) / window.__bgL).toFixed(3) };
  }, buf);
  console.log(label.padEnd(28), JSON.stringify(r));
};

await sample('as-authored', 'return;');
await sample('albedo=black', 'm.color.setRGB(0,0,0); m.needsUpdate=true;');
await sample('albedo=0.25x', 'm.color.setRGB(0.25,0.25,0.25);');
await sample('albedo=1.0x', 'm.color.setRGB(1,1,1);');
await sample('black+rough1+noenv', 'm.color.setRGB(0,0,0); m.envMapIntensity=0; m.needsUpdate=true;');
await sample('black, fog OFF', 'm.color.setRGB(0,0,0); m.envMapIntensity=1; m.fog=false; m.needsUpdate=true;');
await sample('authored, fog OFF', 'm.color.setRGB(1,1,1); m.fog=false; m.needsUpdate=true;');
await page.evaluate(() => { window.__harness.debug.postfx.params
  ? (window.__harness.debug.postfx.params.bloom.enabled = false) : 0; });
await sample('authored, fog OFF, bloom?', 'm.color.setRGB(1,1,1); m.fog=false; m.needsUpdate=true;');
await sample('authored, fog ON, bloom?', 'm.color.setRGB(1,1,1); m.fog=true; m.needsUpdate=true;');

await browser.close();
await server.close();
process.exit(0);
