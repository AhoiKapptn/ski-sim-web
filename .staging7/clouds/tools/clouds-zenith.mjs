/**
 * clouds-zenith.mjs — deep-sky colour, measured over ONE fixed pixel set.
 *
 *   node tools/clouds-zenith.mjs <reference.png> <variant.png> ...
 *
 * The mask (bluest decile of the sky) is taken from the FIRST image and then
 * applied unchanged to every other, so the numbers compare like for like. The
 * per-image "bluest decile" that clouds-probe.mjs reports re-selects its own
 * pixels, which hides a level change behind a set change.
 */
import { execFileSync } from 'node:child_process';

const files = process.argv.slice(2);
const load = (f) => {
  const wh = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim()
    .split(',').map(Number);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', 'format=rgb24',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  return { W: wh[0], H: wh[1], raw };
};

const ref = load(files[0]);
const { W, H } = ref;

// sky = scan each column top-down until terrain
const sky = [];
for (let x = 0; x < W; x++) {
  for (let y = 0; y < H; y++) {
    const i = (y * W + x) * 3;
    const r = ref.raw[i], g = ref.raw[i + 1], b = ref.raw[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (b / Math.max(r, 1) < 1.03 || lum < 60) break;
    sky.push([b / Math.max(r, 1), i]);
  }
}
sky.sort((a, z) => z[0] - a[0]);
const mask = sky.slice(0, Math.round(sky.length * 0.10)).map((v) => v[1]);
const mask2 = sky.slice(0, Math.round(sky.length * 0.02)).map((v) => v[1]);

const stat = (img, idx) => {
  let r = 0, g = 0, b = 0;
  for (const i of idx) { r += img.raw[i]; g += img.raw[i + 1]; b += img.raw[i + 2]; }
  const n = idx.length;
  r /= n; g /= n; b /= n;
  return { rgb: [r, g, b], lum: 0.2126 * r + 0.7152 * g + 0.0722 * b, br: b / r };
};

for (const f of files) {
  const img = load(f);
  if (img.W !== W || img.H !== H) { console.log(f, 'size mismatch'); continue; }
  const a = stat(img, mask), c = stat(img, mask2);
  console.log(`${f.split('/').pop().padEnd(16)} decile rgb=(${a.rgb.map((v) => v.toFixed(0)).join(',')}) ` +
    `L=${a.lum.toFixed(1)} B/R=${a.br.toFixed(2)}   top2% rgb=(${c.rgb.map((v) => v.toFixed(0)).join(',')}) ` +
    `L=${c.lum.toFixed(1)} B/R=${c.br.toFixed(2)}`);
}
