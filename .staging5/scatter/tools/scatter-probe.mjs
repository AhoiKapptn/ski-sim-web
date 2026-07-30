/**
 * Scatter probe: measures the treeline.
 *
 *   node tools/scatter-probe.mjs --shot hero
 *
 * Captures the same framing twice — once normally, once with every tree pool
 * hidden — and reports the mean luminance of ONLY the pixels that changed
 * (i.e. the actual tree pixels) against the snow/background they replaced.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const OUT = path.resolve(ROOT, arg('out', 'shots/probe'));
const W = +arg('w', 1600), H = +arg('h', 900);
const SHOTS = {
  hero: { x: 0, z: 700, heading: Math.PI, settle: 90 },
  ridge: { x: -260, z: 300, heading: Math.PI * 0.86, settle: 120 },
  trees: { x: 180, z: 120, heading: Math.PI * 1.1, settle: 140 },
};
const which = (arg('shot', 'hero')).split(',');

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5311, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 180000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await fs.mkdir(OUT, { recursive: true });
let code = 0;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));

  const settle = async (s) => {
    await page.evaluate(() => window.__setAuto?.(false));
    await page.evaluate((s) => {
      window.__harness.setPlayer(s.x, s.z, s.heading);
      window.__harness.step(1 / 60, s.settle);
    }, s);
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => window.__harness.step(1 / 60, 1));
      await new Promise((r) => setTimeout(r, 32));
    }
  };
  // `only` restricts which vegetation pool is shown, so the white-spike
  // contribution can be attributed to one LOD band.
  const setTrees = (vis, only) => page.evaluate(({ vis, only }) => {
    const g = window.__harness.debug.scatter.group;
    const out = [];
    g.traverse((o) => {
      if (!o.isInstancedMesh) return;
      if (/^(tree0|tree1|tree2|clust|mass)$/.test(o.name || '')) {
        o.visible = vis && (!only || o.name === only);
        out.push([o.name, o.count, o.visible]);
      }
    });
    return out;
  }, { vis, only });

  await settle(SHOTS[which[0]] || SHOTS.hero);
  const info = await page.evaluate(() => {
    const g = window.__harness.debug.scatter.group;
    const r = window.__harness.debug.renderer;
    r.info.autoReset = false; r.info.reset();
    window.__harness.debug.postfx.render(1 / 60);
    const out = { pools: [], render: { calls: r.info.render.calls, tris: r.info.render.triangles } };
    r.info.autoReset = true;
    g.traverse((o) => {
      if (!o.isInstancedMesh) return;
      const m = o.material;
      out.pools.push({
        name: o.name, count: o.count, cap: o.instanceMatrix.count,
        mat: { alphaTest: m.alphaTest, rough: m.roughness, side: m.side,
          atoc: m.alphaToCoverage, mapUUIDshort: m.map ? m.map.uuid.slice(0, 6) : null },
        aTint: o.geometry.attributes.aTint
          ? [Math.min(...o.geometry.attributes.aTint.array), Math.max(...o.geometry.attributes.aTint.array)] : null,
        instColor: o.instanceColor ? (() => {
          const a = o.instanceColor.array; const n = Math.max(1, o.count);
          let s = [0, 0, 0];
          for (let i = 0; i < n; i++) { s[0] += a[i * 3]; s[1] += a[i * 3 + 1]; s[2] += a[i * 3 + 2]; }
          return s.map((v) => +(v / n).toFixed(3));
        })() : null,
      });
    });
    return out;
  });

  const results = {};
  const ONLY = arg('pool', '') || null;
  for (const name of which) {
    const s = SHOTS[name];
    await settle(s);
    await setTrees(true, ONLY);
    await new Promise((r) => setTimeout(r, 900));
    const a = path.join(OUT, `${name}-on.png`);
    await page.screenshot({ path: a });
    await setTrees(false);
    // No sim steps: the clouds, spray and grain must stay frozen so the only
    // pixels that differ are the ones the trees actually covered. The page keeps
    // presenting rAF frames with auto=false, so TAA reconverges on its own.
    await new Promise((r) => setTimeout(r, 900));
    const b = path.join(OUT, `${name}-off.png`);
    await page.screenshot({ path: b });
    await setTrees(true, ONLY);

    const dataA = 'data:image/png;base64,' + (await fs.readFile(a)).toString('base64');
    const dataB = 'data:image/png;base64,' + (await fs.readFile(b)).toString('base64');
    const r = await page.evaluate(async ({ dataA, dataB }) => {
      const load = (d) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = d; });
      const [ia, ib] = await Promise.all([load(dataA), load(dataB)]);
      const w = ia.width, h = ia.height;
      const ca = new OffscreenCanvas(w, h), cb = new OffscreenCanvas(w, h);
      const xa = ca.getContext('2d'), xb = cb.getContext('2d');
      xa.drawImage(ia, 0, 0); xb.drawImage(ib, 0, 0);
      const A = xa.getImageData(0, 0, w, h), B = xb.getImageData(0, 0, w, h);
      const M = xa.createImageData(w, h);
      const hits = new Uint8Array(w * h);
      for (let i = 0, k = 0; i < A.data.length; i += 4, k++) {
        const d = Math.abs(A.data[i]-B.data[i]) + Math.abs(A.data[i+1]-B.data[i+1]) + Math.abs(A.data[i+2]-B.data[i+2]);
        hits[k] = d > 30 ? 1 : 0;
      }
      // erode 5x5: kills TAA/grain speckle, keeps solid tree bodies
      const er = new Uint8Array(w * h);
      for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
        let ok = 1;
        for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++)
          if (!hits[(y + dy) * w + (x + dx)]) { ok = 0; break; }
        er[y * w + x] = ok;
      }
      let n = 0, sT = 0, sB = 0, sr = 0, sg = 0, sb = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const lA = 0.2126 * A.data[i] + 0.7152 * A.data[i+1] + 0.0722 * A.data[i+2];
        const lB = 0.2126 * B.data[i] + 0.7152 * B.data[i+1] + 0.0722 * B.data[i+2];
        const hit = er[i >> 2] === 1;
        M.data[i] = hit ? A.data[i] : 0; M.data[i+1] = hit ? A.data[i+1] : 0;
        M.data[i+2] = hit ? A.data[i+2] : 0; M.data[i+3] = 255;
        if (hit) { n++; sT += lA; sB += lB; sr += A.data[i]; sg += A.data[i+1]; sb += A.data[i+2]; }
      }
      xa.putImageData(M, 0, 0);
      const blob = await ca.convertToBlob({ type: 'image/png' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return { n, T: sT / Math.max(1, n), Bg: sB / Math.max(1, n),
               rgb: [sr / Math.max(1, n), sg / Math.max(1, n), sb / Math.max(1, n)], mask: btoa(s) };
    }, { dataA, dataB });
    await fs.writeFile(path.join(OUT, `${name}-mask.png`), Buffer.from(r.mask, 'base64'));
    results[name] = {
      treePixels: r.n, treeLuma: +r.T.toFixed(1), bgLuma: +r.Bg.toFixed(1),
      ratio: +(r.T / Math.max(1e-3, r.Bg)).toFixed(3),
      treeRGB: r.rgb.map((v) => +v.toFixed(1)),
    };
    console.log(name, JSON.stringify(results[name]));
  }
  console.log(JSON.stringify(info, null, 1));
  await fs.writeFile(path.join(OUT, 'probe.json'), JSON.stringify({ info, results }, null, 2));
} catch (e) {
  errors.push('probe: ' + (e?.message ?? String(e)));
  code = 1;
} finally {
  if (errors.length) { code = 1; console.error(errors.slice(0, 20).join('\n')); }
  await browser.close();
  await server.close();
  process.exit(code);
}
