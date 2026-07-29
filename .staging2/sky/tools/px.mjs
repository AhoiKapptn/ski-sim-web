/**
 * Tiny PNG region sampler (sky agent's measurement tool).
 *   node tools/px.mjs shots/mine/hero.png x,y,w,h [x,y,w,h ...]
 * Prints mean sRGB + mean linear for each rect.
 * Pure node: zlib inflate + PNG unfilter, no deps.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export function readPNG(file) {
  const buf = fs.readFileSync(file);
  let p = 8;
  let w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit PNGs');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    const line = raw.subarray(q, q + stride); q += stride;
    const o = y * stride, prev = o - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[o + x - ch] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = (x >= ch && y > 0) ? out[prev + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[o + x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export function rect(img, x, y, w, h) {
  let r = 0, g = 0, b = 0, lr = 0, lg = 0, lb = 0, n = 0;
  for (let j = y; j < y + h; j++) {
    if (j < 0 || j >= img.h) continue;
    for (let i = x; i < x + w; i++) {
      if (i < 0 || i >= img.w) continue;
      const o = (j * img.w + i) * img.ch;
      const R = img.data[o] / 255, G = img.data[o + 1] / 255, B = img.data[o + 2] / 255;
      r += R; g += G; b += B;
      lr += s2l(R); lg += s2l(G); lb += s2l(B);
      n++;
    }
  }
  return {
    srgb: [r / n * 255, g / n * 255, b / n * 255].map((v) => +v.toFixed(1)),
    lin: [lr / n, lg / n, lb / n].map((v) => +v.toFixed(4)),
    br: +((lb / n) / Math.max(lr / n, 1e-6)).toFixed(3),
  };
}

if (process.argv[1] && process.argv[1].endsWith('px.mjs')) {
  const file = process.argv[2];
  const img = readPNG(file);
  const rects = process.argv.slice(3);
  if (!rects.length) rects.push(`0,0,${img.w},${img.h}`);
  for (const r of rects) {
    const [x, y, w, h] = r.split(',').map(Number);
    const s = rect(img, x, y, w, h);
    console.log(`${r.padEnd(20)} srgb=${JSON.stringify(s.srgb)} lin=${JSON.stringify(s.lin)} B/R=${s.br}`);
  }
}
