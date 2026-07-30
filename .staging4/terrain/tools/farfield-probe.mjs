/**
 * Far-field terrain probe.
 *
 *   node tools/farfield-probe.mjs
 *
 * Measures, for the canonical `hero` framing:
 *   - linear-luminance mean / sd and B/R ratio inside rectangles on the distant
 *     range, the mid mountain and the near snow
 *   - the same with scene fog (aerial perspective) forced off, which separates
 *     "the geometry is flat" from "the AP washed it out"
 *   - CPU-side roughness of the height field along a transect across the far
 *     range, band-passed at 400 m / 150 m / 60 m
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const W = +arg('w', 1600), H = +arg('h', 900);
const OUT = arg('out', '');

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5211, strictPort: false, host: '127.0.0.1' },
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

// Regions in screen px (top-left origin), for a 1600x900 hero frame.
const RECTS = {
  farPyramid: [370, 260, 540, 445],  // interior of the big far cone, ~4.2 km
  farRidge: [600, 320, 880, 430],    // the far ridge line right of it
  farLeft: [10, 330, 300, 420],      // the left horizon band / map-edge plain
  midRight: [1430, 165, 1595, 330],  // mid mountain, ~1.5 km
  nearSnow: [200, 620, 700, 860],    // near piste
};

const measure = async (label) => page.evaluate((RECTS, W, H, label) => {
  const r = window.__harness.debug.renderer;
  window.__harness.step(1 / 60, 0);
  const gl = r.getContext();
  const w = r.domElement.width, h = r.domElement.height;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const s2l = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const out = { label };
  for (const [k, [x0, y0, x1, y1]] of Object.entries(RECTS)) {
    let sum = 0, sum2 = 0, n = 0, sr = 0, sb = 0, sg = 0;
    const sx = w / W, sy = h / H;
    for (let y = Math.round(y0 * sy); y < Math.round(y1 * sy); y++) {
      const gy = h - 1 - y;
      for (let x = Math.round(x0 * sx); x < Math.round(x1 * sx); x++) {
        const i = (gy * w + x) * 4;
        const R = s2l(buf[i]), G = s2l(buf[i + 1]), B = s2l(buf[i + 2]);
        const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        sum += l; sum2 += l * l; n++; sr += R; sg += G; sb += B;
      }
    }
    const mean = sum / n;
    out[k] = {
      lum: +mean.toFixed(4),
      sd: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(4),
      contrast: +(Math.sqrt(Math.max(0, sum2 / n - mean * mean)) / Math.max(1e-5, mean)).toFixed(4),
      BR: +((sb / n) / Math.max(1e-5, sr / n)).toFixed(4),
      G: +(sg / n).toFixed(4),
    };
  }
  return out;
}, RECTS, W, H, label);

const withFog = await measure('fog-on');

// 1:1 crops of the far field, so faceting and noise character can actually be
// judged instead of guessed at from a downsampled full frame.
if (OUT) {
  const dir = path.resolve(ROOT, OUT);
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, 'full.png') });
  const CROPS = {
    'crop-farpeaks': { x: 320, y: 140, width: 640, height: 340 },
    'crop-farleft': { x: 0, y: 200, width: 420, height: 300 },
    'crop-midright': { x: 1180, y: 120, width: 420, height: 320 },
  };
  for (const [n, clip] of Object.entries(CROPS)) {
    await page.screenshot({ path: path.join(dir, n + '.png'), clip });
  }
}

const apInfo = await page.evaluate(() => {
  const d = window.__harness.debug;
  const u = d.terrain.snowUniforms;
  const cam = d.camera;
  const out = {
    fog: d.scene.fog ? { type: d.scene.fog.isFogExp2 ? 'exp2' : 'linear', density: d.scene.fog.density, color: d.scene.fog.color.getHexString() } : null,
    uAerialDensity: u.uAerialDensity.value,
    uAerialHeight: u.uAerialHeight.value,
    uAerialColor: u.uAerialColor.value.toArray().map((v) => +v.toFixed(3)),
    camY: +cam.position.y.toFixed(1),
    fov: cam.fov,
  };
  // extinction fraction f at a few sample points on the far range
  const Hs = u.uAerialHeight.value, dens = u.uAerialDensity.value;
  const e0 = Math.exp(-Math.max(cam.position.y, -200) / Hs);
  out.f = {};
  for (const [name, [x, z]] of Object.entries({ farRange: [250, -3150], farWall: [-1300, -3560], mid: [1520, 1310] })) {
    const y = d.terrain.height(x, z);
    const dx = x - cam.position.x, dy = y - cam.position.y, dz = z - cam.position.z;
    const dist = Math.hypot(dx, dy, dz);
    const e1 = Math.exp(-Math.max(y, -200) / Hs);
    const t = Math.abs(dy) < 1 ? dist * e0 : dist * Hs / dy * (e0 - e1);
    out.f[name] = { dist: +dist.toFixed(0), y: +y.toFixed(0), f: +(1 - Math.exp(-dens * Math.max(t, 0))).toFixed(3) };
  }
  return out;
});

// Aerial perspective off: kill both the scene fog and the terrain shader's own
// aerial term, then re-render.
await page.evaluate(() => {
  const d = window.__harness.debug;
  const t = d.terrain;
  window.__apSaved = { density: d.scene.fog?.density ?? 0 };
  if (d.scene.fog) d.scene.fog.density = 0;
  t.snowUniforms.uAerialDensity.value = 0;
  t.__freezeAP = true;
  const orig = t.update.bind(t);
  t.update = (dt, st) => { orig(dt, st); t.snowUniforms.uAerialDensity.value = 0; };
});
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => window.__harness.step(1 / 60, 1));
  await new Promise((r) => setTimeout(r, 32));
}
const noFog = await measure('fog-off');
if (OUT) {
  await fs.mkdir(path.resolve(ROOT, OUT), { recursive: true });
  await page.screenshot({ path: path.join(path.resolve(ROOT, OUT), 'nofog.png') });
}

// CPU height-field roughness across the far range.
const rough = await page.evaluate(() => {
  const t = window.__harness.debug.terrain;
  const res = {};
  // transect along x at the far range crest (z = -3000) and the background wall
  for (const z of [-3000, -3500]) {
    const N = 1200, x0 = -3800, x1 = 3800;
    const h = new Float64Array(N);
    for (let i = 0; i < N; i++) h[i] = t.height(x0 + (x1 - x0) * i / (N - 1), z);
    const step = (x1 - x0) / (N - 1);
    const band = (lam) => {
      // high-pass: h - boxblur(h, lam)
      const k = Math.max(1, Math.round(lam / step / 2));
      let s = 0, n = 0;
      for (let i = 0; i < N; i++) {
        let a = 0, c = 0;
        for (let j = Math.max(0, i - k); j <= Math.min(N - 1, i + k); j++) { a += h[j]; c++; }
        const d = h[i] - a / c;
        s += d * d; n++;
      }
      return +Math.sqrt(s / n).toFixed(2);
    };
    res['z' + z] = { rms400: band(400), rms150: band(150), rms60: band(60) };
  }
  // vertical relief of the field beyond the map edge (the flat plain)
  res.edge = {
    h_3900: +t.height(0, -3900).toFixed(1),
    h_4200: +t.height(0, -4200).toFixed(1),
    h_5000: +t.height(0, -5000).toFixed(1),
    h_8000: +t.height(0, -8000).toFixed(1),
    hx_5000: +t.height(-5000, -1000).toFixed(1),
  };
  return res;
});

console.log(JSON.stringify({ apInfo, withFog, noFog, rough, errors: errors.slice(0, 10) }, null, 2));
await browser.close();
await server.close();
process.exit(0);
