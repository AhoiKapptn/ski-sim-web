/**
 * Linear-luminance statistics over a rectangle of any image file, so our frames
 * and downloaded reference photography can be compared on the same numbers.
 *
 *   node tools/img-stats.mjs <file> x0,y0,x1,y1 [more rects...]
 *
 * Coordinates are fractions of width/height (0..1), so rectangles mean the same
 * thing across images of different sizes. Decoding is done in headless Chrome —
 * no image library, no new dependency.
 */
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs/promises';

const [file, ...rects] = process.argv.slice(2);
if (!file || !rects.length) {
  console.error('usage: node tools/img-stats.mjs <file> x0,y0,x1,y1 ...');
  process.exit(2);
}
const buf = await fs.readFile(path.resolve(file));
const ext = path.extname(file).slice(1).toLowerCase();
const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
const out = await page.evaluate(async (dataUrl, rects) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const s2l = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const res = { size: [c.width, c.height], rects: [] };
  for (const r of rects) {
    const [fx0, fy0, fx1, fy1] = r.split(',').map(Number);
    const x0 = Math.round(fx0 * c.width), y0 = Math.round(fy0 * c.height);
    const w = Math.max(1, Math.round((fx1 - fx0) * c.width));
    const h = Math.max(1, Math.round((fy1 - fy0) * c.height));
    const d = ctx.getImageData(x0, y0, w, h).data;
    let s = 0, s2 = 0, n = 0, sr = 0, sg = 0, sb = 0;
    const lum = [];
    for (let i = 0; i < d.length; i += 4) {
      const R = s2l(d[i]), G = s2l(d[i + 1]), B = s2l(d[i + 2]);
      const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      s += L; s2 += L * L; n++; sr += R; sg += G; sb += B;
      lum.push(L);
    }
    lum.sort((a, b) => a - b);
    const mean = s / n;
    const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    res.rects.push({
      rect: r,
      lum: +mean.toFixed(4),
      sd: +sd.toFixed(4),
      contrast: +(sd / Math.max(1e-5, mean)).toFixed(4),
      p05: +lum[Math.floor(n * 0.05)].toFixed(4),
      p95: +lum[Math.floor(n * 0.95)].toFixed(4),
      dynamic: +(lum[Math.floor(n * 0.95)] / Math.max(1e-4, lum[Math.floor(n * 0.05)])).toFixed(2),
      BR: +((sb / n) / Math.max(1e-5, sr / n)).toFixed(4),
    });
  }
  return res;
}, dataUrl, rects);
console.log(JSON.stringify(out, null, 1));
await browser.close();
process.exit(0);
