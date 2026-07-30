/**
 * Raw-buffer treeline measurement.
 *
 * Renders straight through `renderer.render()` (NO post chain: no bloom, no
 * DOF, no TAA, no motion blur) and reads the back buffer, so what is measured is
 * purely the scatter material + lighting + fog. The silhouette mask comes from
 * an emissive-green flash of the same materials, which keeps the LOD dissolve
 * and the stochastic alpha intact.
 *
 *   node tools/scatter-raw.mjs --shot hero
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SHOTS = {
  hero: { x: 0, z: 700, heading: Math.PI, settle: 90 },
  ridge: { x: -260, z: 300, heading: Math.PI * 0.86, settle: 120 },
  trees: { x: 180, z: 120, heading: Math.PI * 1.1, settle: 140 },
};
// LOD-continuity sweep: the same stand approached in 40 m steps, so a value
// mismatch between bands shows up as a step in the ratio rather than as a pop
// nobody can screenshot.
for (let z = 700; z >= 460; z -= 40) SHOTS['z' + z] = { x: 0, z, heading: Math.PI, settle: 90 };

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5611, strictPort: false, host: '127.0.0.1' },
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
await page.evaluate((p) => { window.__POOL = p || null; }, arg('pool', ''));

await page.evaluate(() => {
  window.__RAW = {
    veg(fn) {
      const only = window.__POOL;
      window.__harness.debug.scatter.group.traverse((o) => {
        if (!o.isInstancedMesh || !/^(tree0|tree1|tree2|clust|mass)$/.test(o.name || '')) return;
        if (only && o.name !== only) { o.visible = false; return; }
        fn(o);
      });
    },
    grab(post) {
      const d = window.__harness.debug;
      d.renderer.setRenderTarget(null);
      if (post) d.postfx.render(1 / 60); else d.renderer.render(d.scene, d.camera);
      const gl = d.renderer.getContext();
      const w = d.renderer.domElement.width, h = d.renderer.domElement.height;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return { buf, w, h };
    },
  };
});

for (const name of (arg('shot', 'hero')).split(',')) {
  const s = SHOTS[name];
  await page.evaluate((s) => {
    window.__setAuto?.(false);
    window.__harness.setPlayer(s.x, s.z, s.heading);
    window.__harness.step(1 / 60, s.settle);
  }, s);
  await new Promise((r) => setTimeout(r, 300));

  const out = await page.evaluate((variants) => {
    const R = window.__RAW;
    // 1. silhouette mask
    R.veg((o) => {
      const m = o.material;
      if (!m.__save) m.__save = { c: m.color.clone(), e: m.emissive.clone(), f: m.fog, ei: m.emissiveIntensity };
      m.color.setRGB(0, 0, 0); m.emissive.setRGB(0, 1, 0); m.emissiveIntensity = 1; m.fog = false; m.needsUpdate = true;
    });
    const M = R.grab();
    const w = M.w, h = M.h;
    const hit = new Uint8Array(w * h);
    const hitS = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) {
      const i = k * 4;
      hit[k] = (M.buf[i + 1] > M.buf[i] + 25 && M.buf[i + 1] > M.buf[i + 2] + 25) ? 1 : 0;
      hitS[k] = (M.buf[i + 1] > M.buf[i] + 110 && M.buf[i + 1] > M.buf[i + 2] + 110) ? 1 : 0;
    }
    const erode = (src) => {
      const m = new Uint8Array(w * h);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        let ok = 1;
        for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (!src[(y + dy) * w + x + dx]) { ok = 0; break; }
        m[y * w + x] = ok;
      }
      return m;
    };
    const mask = erode(hit);
    const maskS = new Uint8Array(w * h);
    // 2. background under the mask
    R.veg((o) => { o.visible = false; });
    R.veg(() => {});
    const B = R.grab(false);
    const BP = R.grab(true);
    R.veg((o) => { o.visible = true; });
    let n = 0, bgL = 0, bgLP = 0, nS = 0, bgLPS = 0;
    for (let k = 0; k < mask.length; k++) if (mask[k]) {
      n++;
      bgL += 0.2126 * B.buf[k * 4] + 0.7152 * B.buf[k * 4 + 1] + 0.0722 * B.buf[k * 4 + 2];
      bgLP += 0.2126 * BP.buf[k * 4] + 0.7152 * BP.buf[k * 4 + 1] + 0.0722 * BP.buf[k * 4 + 2];
    }
    // BOX: the dense right-hand stand only — this is where a viewer reads
    // "wall of conifers", and it is solid coverage, not fringe.
    const BOX = [1150, 280, 1550, 450];
    for (let y = BOX[1]; y < BOX[3]; y++) for (let x = BOX[0]; x < BOX[2]; x++) {
      const k = (h - 1 - y) * w + x;
      if (!mask[k]) continue;
      maskS[k] = 1; nS++;
      bgLPS += 0.2126 * BP.buf[k * 4] + 0.7152 * BP.buf[k * 4 + 1] + 0.0722 * BP.buf[k * 4 + 2];
    }
    bgL /= Math.max(1, n); bgLP /= Math.max(1, n); bgLPS /= Math.max(1, nS);

    // dump the mask and the authored frame for eyeballing
    const dump = (px, flipG) => {
      const c = new OffscreenCanvas(w, h); const x = c.getContext('2d');
      const id = x.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
        const src = ((h - 1 - y) * w + xx) * 4, dst = (y * w + xx) * 4;
        id.data[dst] = px[src]; id.data[dst + 1] = px[src + 1];
        id.data[dst + 2] = px[src + 2]; id.data[dst + 3] = 255;
      }
      x.putImageData(id, 0, 0);
      return c;
    };
    const maskPx = new Uint8Array(w * h * 4);
    for (let k = 0; k < mask.length; k++) { const v = mask[k] ? 255 : 0; maskPx[k * 4] = v; maskPx[k * 4 + 1] = v; maskPx[k * 4 + 2] = v; }
    R.veg((o) => {
      const m = o.material;
      m.color.copy(m.__save.c); m.emissive.copy(m.__save.e);
      m.emissiveIntensity = m.__save.ei; m.fog = m.__save.f; m.needsUpdate = true;
    });
    // 4x zoom on the right-hand treeline, so the actual pixel structure of a
    // distant stand can be looked at rather than guessed
    const zoom = (px, bx, by, bw, bh, k) => {
      const c = new OffscreenCanvas(bw * k, bh * k); const x = c.getContext('2d');
      const id = x.createImageData(bw * k, bh * k);
      for (let y = 0; y < bh * k; y++) for (let xx = 0; xx < bw * k; xx++) {
        const sx = bx + ((xx / k) | 0), sy = by + ((y / k) | 0);
        const src = ((h - 1 - sy) * w + sx) * 4, dst = (y * bw * k + xx) * 4;
        id.data[dst] = px[src]; id.data[dst + 1] = px[src + 1];
        id.data[dst + 2] = px[src + 2]; id.data[dst + 3] = 255;
      }
      x.putImageData(id, 0, 0);
      return c;
    };
    window.__dumps = [['mask', dump(maskPx)], ['bg', dump(B.buf)], ['flash', dump(M.buf)],
      ['raw', dump(R.grab(false).buf)], ['post', dump(R.grab(true).buf)],
      ['zoom', zoom(R.grab(true).buf, 1150, 280, 400, 170, 3)]];

    const res = { maskPx: n, corePx: nS, bgLuma: +bgL.toFixed(1), bgLumaPost: +bgLP.toFixed(1), bgCore: +bgLPS.toFixed(1), variants: {} };
    for (const [label, code] of variants) {
      R.veg((o) => {
        const m = o.material;
        if (!m.__save.map) { m.__save.map = m.map; m.__save.at = m.alphaTest; }
        m.map = m.__save.map; m.alphaTest = m.__save.at;
        m.color.copy(m.__save.c); m.emissive.copy(m.__save.e);
        m.emissiveIntensity = m.__save.ei; m.fog = m.__save.f;
        if (m.__save.env === undefined) { m.__save.env = m.envMapIntensity; m.__save.r = m.roughness; m.__save.mt = m.metalness; }
        m.envMapIntensity = m.__save.env; m.roughness = m.__save.r; m.metalness = m.__save.mt;
        // eslint-disable-next-line no-new-func
        new Function('m', 'name', code)(m, o.name);
        m.needsUpdate = true;
      });
      const F = R.grab(true);
      let L = 0, r = 0, g = 0, b = 0, LS = 0;
      for (let k = 0; k < mask.length; k++) if (mask[k]) {
        L += 0.2126 * F.buf[k * 4] + 0.7152 * F.buf[k * 4 + 1] + 0.0722 * F.buf[k * 4 + 2];
        r += F.buf[k * 4]; g += F.buf[k * 4 + 1]; b += F.buf[k * 4 + 2];
      }
      for (let k = 0; k < maskS.length; k++) if (maskS[k]) {
        LS += 0.2126 * F.buf[k * 4] + 0.7152 * F.buf[k * 4 + 1] + 0.0722 * F.buf[k * 4 + 2];
      }
      res.variants[label] = {
        luma: +(L / n).toFixed(1), ratio: +((L / n) / bgLP).toFixed(3),
        boxLuma: +(LS / nS).toFixed(1), boxRatio: +((LS / nS) / bgLPS).toFixed(3),
        rgb: [r / n, g / n, b / n].map((v) => +v.toFixed(1)) };
    }
    // final diagnostic dump: the same framing with the cards forced to an
    // opaque black quad. Anything that is not black here is NOT the card.
    R.veg((o) => {
      const m = o.material;
      m.map = null; m.alphaTest = 0; m.color.setRGB(0, 0, 0); m.fog = false;
      m.emissive.setRGB(0, 0, 0); m.envMapIntensity = 0; m.roughness = 1; m.needsUpdate = true;
    });
    window.__dumps.push(['black', dump(R.grab(true).buf)]);
    window.__dumps.push(['blackzoom', zoom(R.grab(true).buf, 1150, 280, 400, 170, 3)]);
    R.veg((o) => {
      const m = o.material;
      m.map = m.__save.map; m.alphaTest = m.__save.at;
      m.color.copy(m.__save.c); m.emissive.copy(m.__save.e);
      m.envMapIntensity = m.__save.env; m.roughness = m.__save.r;
      m.emissiveIntensity = m.__save.ei; m.fog = m.__save.f; m.needsUpdate = true;
    });
    return res;
  }, [
    ['as-authored', 'return;'],
    ['flat 0.0', 'm.map=null; m.alphaTest=0; m.color.setRGB(0,0,0); m.fog=false;'],
    ['flat 0.0 envInt0', 'm.map=null; m.alphaTest=0; m.color.setRGB(0,0,0); m.fog=false; m.envMapIntensity=0;'],
    ['flat 0.0 rough1', 'm.map=null; m.alphaTest=0; m.color.setRGB(0,0,0); m.fog=false; m.roughness=1; m.metalness=0;'],
    ['flat 0.0 emis0', 'm.map=null; m.alphaTest=0; m.color.setRGB(0,0,0); m.fog=false; m.emissive.setRGB(0,0,0);'],
    ['flat 0.0 all off', 'm.map=null; m.alphaTest=0; m.color.setRGB(0,0,0); m.fog=false; m.envMapIntensity=0; m.roughness=1; m.emissive.setRGB(0,0,0);'],
    ['flat 0.2 envInt0', 'm.map=null; m.alphaTest=0; m.color.setRGB(0.2,0.2,0.2); m.fog=false; m.envMapIntensity=0;'],
  ]);
  const dumps = await page.evaluate(async () => {
    const out = [];
    for (const [nm, c] of window.__dumps) {
      const blob = await c.convertToBlob({ type: 'image/png' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      out.push([nm, btoa(s)]);
    }
    return out;
  });
  await fs.mkdir(path.resolve(ROOT, 'shots/raw'), { recursive: true });
  for (const [nm, b64] of dumps) {
    await fs.writeFile(path.resolve(ROOT, `shots/raw/${name}-${nm}.png`), Buffer.from(b64, 'base64'));
  }
  console.log(name, 'maskPx', out.maskPx, 'boxPx', out.corePx, 'bgLuma', out.bgLumaPost, 'boxBg', out.bgCore);
  for (const k of Object.keys(out.variants)) console.log('  ', k.padEnd(22), JSON.stringify(out.variants[k]));
}

await browser.close();
await server.close();
process.exit(0);
