/**
 * Tile a directory of PNGs into one contact sheet, so a reviewer can take in a
 * whole capture run at a glance.
 *
 *   node tools/contact-sheet.mjs shots/run1 shots/run1/sheet.png
 *   node tools/contact-sheet.mjs shots/a shots/cmp.png --vs shots/b   # A/B rows
 *
 * Uses ffmpeg (already on PATH); no image libraries needed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const argv = process.argv.slice(2);

// --- A/B mode: stack two arbitrary images side by side, unlabelled ------------
// Used for blind comparison against reference screenshots, whose filenames and
// formats never match our capture names.
if (argv[0] === '--ab') {
  const [, left, right, outFile] = argv;
  if (!left || !right || !outFile) {
    console.error('usage: node tools/contact-sheet.mjs --ab <left> <right> <out.png>');
    process.exit(2);
  }
  await run('ffmpeg', ['-y', '-i', left, '-i', right,
    '-filter_complex',
    // Match heights so the pair reads fairly; pad rather than distort.
    `[0:v]scale=-2:900[l];[1:v]scale=-2:900[r];[l][r]hstack=inputs=2,pad=iw+24:ih:0:0:black[v]`,
    '-map', '[v]', '-frames:v', '1', outFile]);
  console.log(`A/B: ${outFile}  (left=${left}  right=${right})`);
  process.exit(0);
}

const [dir, out] = argv;
const vsIdx = argv.indexOf('--vs');
const vsDir = vsIdx > 0 ? argv[vsIdx + 1] : null;

if (!dir || !out) {
  console.error('usage: node tools/contact-sheet.mjs <shotsDir> <out.png> [--vs <otherDir>]');
  console.error('       node tools/contact-sheet.mjs --ab <left> <right> <out.png>');
  process.exit(2);
}

const IMG = /\.(png|jpe?g|webp|avif)$/i;
const pngs = async (d) =>
  (await fs.readdir(d)).filter((f) => IMG.test(f) && !f.includes('sheet') && !f.includes('cmp')).sort();

const a = await pngs(dir);
if (!a.length) { console.error('no PNGs in ' + dir); process.exit(2); }

const CELL_W = 640;

async function tile(files, baseDir, outFile, cols) {
  const inputs = files.flatMap((f) => ['-i', path.join(baseDir, f)]);
  const n = files.length;
  const rows = Math.ceil(n / cols);
  // Scale every input to a common width, then xstack them into a grid.
  const scale = files.map((_, i) => `[${i}:v]scale=${CELL_W}:-1[s${i}]`).join(';');
  const layout = files
    .map((_, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      return `${c === 0 ? '0' : Array.from({ length: c }, (_, k) => `w${k}`).join('+')}_${r === 0 ? '0' : Array.from({ length: r }, (_, k) => `h${k * cols}`).join('+')}`;
    })
    .join('|');
  const filter = `${scale};${files.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${n}:layout=${layout}:fill=black[v]`;
  await run('ffmpeg', ['-y', ...inputs, '-filter_complex', filter, '-map', '[v]', '-frames:v', '1', outFile]);
  return { n, rows, cols };
}

if (vsDir) {
  // Pair matching filenames side by side: [A|B] per row.
  const b = await pngs(vsDir);
  const common = a.filter((f) => b.includes(f));
  if (!common.length) { console.error('no shared filenames between the two dirs'); process.exit(2); }
  const tmp = path.join(path.dirname(out), '.pairs');
  await fs.mkdir(tmp, { recursive: true });
  for (const f of common) {
    await run('ffmpeg', ['-y', '-i', path.join(dir, f), '-i', path.join(vsDir, f),
      '-filter_complex', `[0:v]scale=${CELL_W}:-1[l];[1:v]scale=${CELL_W}:-1[r];[l][r]hstack=inputs=2[v]`,
      '-map', '[v]', '-frames:v', '1', path.join(tmp, f)]);
  }
  const r = await tile(common, tmp, out, 1);
  await fs.rm(tmp, { recursive: true, force: true });
  console.log(`contact sheet: ${out} (${r.n} pairs, left=${dir} right=${vsDir})`);
} else {
  const cols = a.length <= 2 ? a.length : a.length <= 6 ? 2 : 3;
  const r = await tile(a, dir, out, cols);
  console.log(`contact sheet: ${out} (${r.n} shots, ${r.cols}x${r.rows})`);
}
