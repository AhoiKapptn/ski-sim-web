/**
 * clouds-probe.mjs — measures sky/cloud statistics from a rendered PNG.
 *
 *   node tools/clouds-probe.mjs shots/mine/hero.png [--crop W:H:X:Y]
 *
 * Reports:
 *   - bluest-decile mean RGB + B/R      (deep sky / zenith colour)
 *   - cloud fraction, cloud brightness histogram spread
 *   - cloud "blob" size distribution via a horizontal run-length scan on the
 *     binarised cloud mask -> mean/median/p90 run length and its coefficient of
 *     variation. A single-scale deck has a TIGHT distribution (low CV); a real
 *     multi-scale sky has a broad one.
 *   - clustering: variance of cloud fraction across a 8x4 grid of tiles,
 *     normalised. Even tiling -> near zero. Real clumping -> large.
 */
import { execFileSync } from 'node:child_process';

const argsAll = process.argv.slice(2);
const cropI0 = argsAll.indexOf('--crop');
const files = argsAll.filter((a, i) => !a.startsWith('--') && !(cropI0 >= 0 && i === cropI0 + 1));
if (files.length > 1) {
  for (const f of files) {
    const j = JSON.parse(execFileSync(process.execPath,
      [process.argv[1], f, ...(cropI0 >= 0 ? ['--crop', argsAll[cropI0 + 1]] : [])],
      { maxBuffer: 1 << 26 }).toString());
    console.log(
      `${f.split('/').pop().padEnd(14)} deep=${JSON.stringify(j.deepSky.rgb)} B/R=${j.deepSky.BR}` +
      `  frac=${j.cloudFrac}  hRun p50=${j.hRun.p50} p90=${j.hRun.p90} p99=${j.hRun.p99} cv=${j.hRun.cv}` +
      `  vMean=${j.vRun.mean} aspect=${j.aspect}  clusterCV=${j.clusterCV}` +
      `  lum p05=${j.cloudLum.p05.toFixed(0)} p50=${j.cloudLum.p50.toFixed(0)} p95=${j.cloudLum.p95.toFixed(0)}`);
  }
  process.exit(0);
}

const args = argsAll;
const file = args[0];
const cropI = args.indexOf('--crop');
const crop = cropI >= 0 ? args[cropI + 1] : null;

const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
let [W, H] = probe.split(',').map(Number);
let vf = 'format=rgb24';
if (crop) {
  const [cw, ch] = crop.split(':').map(Number);
  vf = `crop=${crop},format=rgb24`;
  W = cw; H = ch;
}
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', vf,
  '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });

const px = (x, y) => {
  const i = (y * W + x) * 3;
  return [raw[i], raw[i + 1], raw[i + 2]];
};

// ---- sky mask: bluish or near-white pixels in the upper part of the frame ----
// Terrain in these shots is either grey rock (B/R ~1.0, dark) or snow. We take
// the sky as everything above the highest ridge in each column is unreliable, so
// instead: scan each column top-down and stop at the first pixel that is clearly
// terrain (low luminance AND B/R < 1.02) — clouds and sky both stay above it.
const mask = new Uint8Array(W * H);
for (let x = 0; x < W; x++) {
  for (let y = 0; y < H; y++) {
    const [r, g, b] = px(x, y);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const br = b / Math.max(r, 1);
    if (br < 1.03 || lum < 60) break;         // hit terrain
    mask[y * W + x] = 1;
  }
}
let nSky = 0;
for (let i = 0; i < mask.length; i++) nSky += mask[i];

// ---- bluest decile (deep sky) ----------------------------------------------
const skyPx = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (!mask[y * W + x]) continue;
  const [r, g, b] = px(x, y);
  skyPx.push([b / Math.max(r, 1), r, g, b]);
}
skyPx.sort((a, z) => z[0] - a[0]);
const dec = skyPx.slice(0, Math.max(1, Math.round(skyPx.length * 0.10)));
const mean = (arr, k) => arr.reduce((s, v) => s + v[k], 0) / arr.length;
const decRGB = [mean(dec, 1), mean(dec, 2), mean(dec, 3)];
const decBR = mean(dec, 0);

// top 2% — the deepest zenith blue actually present
const top2 = skyPx.slice(0, Math.max(1, Math.round(skyPx.length * 0.02)));
const t2RGB = [mean(top2, 1), mean(top2, 2), mean(top2, 3)];

// ---- cloud mask -------------------------------------------------------------
// Cloud = sky pixel whose B/R is low (whitened) relative to the CLEAR sky IN THE
// SAME ROW. A per-row threshold is essential: the clear sky whitens steeply
// toward the horizon, so one global threshold calls the bottom of the dome
// "cloud" everywhere and the statistics become meaningless.
const cloud = new Uint8Array(W * H);
let nCloud = 0;
for (let y = 0; y < H; y++) {
  const row = [];
  for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    const [r, , b] = px(x, y);
    row.push(b / Math.max(r, 1));
  }
  if (row.length < 40) continue;
  row.sort((a, b) => a - b);
  const clear = row[Math.round(0.92 * (row.length - 1))];
  const thr = 1.0 + (clear - 1.0) * 0.62;
  for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    const [r, , b] = px(x, y);
    if (b / Math.max(r, 1) < thr) { cloud[y * W + x] = 1; nCloud++; }
  }
}

// ---- run lengths (horizontal chord through clouds) --------------------------
const runs = [];
for (let y = 0; y < H; y++) {
  let run = 0;
  for (let x = 0; x < W; x++) {
    if (cloud[y * W + x]) run++;
    else { if (run >= 3) runs.push(run); run = 0; }
  }
  if (run >= 3) runs.push(run);
}
runs.sort((a, b) => a - b);
const rMean = runs.reduce((s, v) => s + v, 0) / Math.max(runs.length, 1);
const rSd = Math.sqrt(runs.reduce((s, v) => s + (v - rMean) ** 2, 0) / Math.max(runs.length, 1));
const q = (f) => runs[Math.min(runs.length - 1, Math.max(0, Math.round(f * runs.length)))] ?? 0;

// vertical chords too (vertical development / non-lozenge-ness)
const vruns = [];
for (let x = 0; x < W; x++) {
  let run = 0;
  for (let y = 0; y < H; y++) {
    if (cloud[y * W + x]) run++;
    else { if (run >= 3) vruns.push(run); run = 0; }
  }
  if (run >= 3) vruns.push(run);
}
vruns.sort((a, b) => a - b);
const vMean = vruns.reduce((s, v) => s + v, 0) / Math.max(vruns.length, 1);
const vSd = Math.sqrt(vruns.reduce((s, v) => s + (v - vMean) ** 2, 0) / Math.max(vruns.length, 1));

// ---- clustering: cloud fraction variance over tiles -------------------------
const TX = 8, TY = 4;
const fr = [];
for (let ty = 0; ty < TY; ty++) for (let tx = 0; tx < TX; tx++) {
  let s = 0, c = 0;
  for (let y = Math.floor(ty * H / TY); y < Math.floor((ty + 1) * H / TY); y++)
    for (let x = Math.floor(tx * W / TX); x < Math.floor((tx + 1) * W / TX); x++) {
      if (!mask[y * W + x]) continue;
      c++; s += cloud[y * W + x];
    }
  if (c > 300) fr.push(s / c);
}
const fMean = fr.reduce((s, v) => s + v, 0) / Math.max(fr.length, 1);
const fSd = Math.sqrt(fr.reduce((s, v) => s + (v - fMean) ** 2, 0) / Math.max(fr.length, 1));

// ---- cloud tonal spread (are all undersides the same grey?) -----------------
const cl = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (cloud[y * W + x]) {
    const [r, g, b] = px(x, y);
    cl.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
}
cl.sort((a, b) => a - b);
const cq = (f) => cl[Math.min(cl.length - 1, Math.round(f * cl.length))] ?? 0;

const out = {
  file, W, H,
  skyPixels: nSky,
  deepSky: { rgb: decRGB.map((v) => +v.toFixed(1)), BR: +decBR.toFixed(3) },
  zenithTop2: { rgb: t2RGB.map((v) => +v.toFixed(1)), BR: +mean(top2, 0).toFixed(3) },
  cloudFrac: +(nCloud / Math.max(nSky, 1)).toFixed(4),
  hRun: {
    n: runs.length, mean: +rMean.toFixed(1), sd: +rSd.toFixed(1),
    cv: +(rSd / Math.max(rMean, 1e-6)).toFixed(3),
    p10: q(0.10), p50: q(0.50), p90: q(0.90), p99: q(0.99),
  },
  vRun: {
    n: vruns.length, mean: +vMean.toFixed(1),
    cv: +(vSd / Math.max(vMean, 1e-6)).toFixed(3),
  },
  aspect: +(rMean / Math.max(vMean, 1e-6)).toFixed(2),
  clusterCV: +(fSd / Math.max(fMean, 1e-6)).toFixed(3),
  cloudLum: { p05: cq(0.05), p25: cq(0.25), p50: cq(0.50), p75: cq(0.75), p95: cq(0.95) },
};
console.log(JSON.stringify(out, null, 2));
