/**
 * File-level interleaved A/B.
 *
 * For changes that cannot be switched at runtime (geometry, LOD band limits,
 * instance counts) the only honest comparison on a machine whose throughput
 * drifts by 2-3x over an hour is to ALTERNATE the two builds run by run and
 * take a paired median. Absolute fps from a block of A runs followed by a block
 * of B runs is meaningless here.
 *
 *   node tools/perf-file-ab.mjs --file src/world/scatter.js --alt /tmp/scatter-b.js --runs 6
 *
 * Restores the original file on exit, including on Ctrl-C.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };

const FILE = path.resolve(ROOT, arg('file', 'src/world/scatter.js'));
const ALT = path.resolve(arg('alt', ''));
const RUNS = +arg('runs', 6);
const SHOT = arg('shot', 'hero');
const W = arg('w', '2400'), H = arg('h', '1350');

const ORIG = fs.readFileSync(FILE, 'utf8');
const ALTSRC = fs.readFileSync(ALT, 'utf8');
const restore = () => fs.writeFileSync(FILE, ORIG);
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(1); });

function run() {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'tools/perf-probe.mjs'),
      '--shot', SHOT, '--static', '--windows', '2', '--secs', '2.5', '--w', W, '--h', H],
    { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => {
      const m = out.match(/medFrame=([\d.]+) ms/);
      m ? res(+m[1]) : rej(new Error('no result:\n' + out));
    });
  });
}

const A = [], B = [];
for (let i = 0; i < RUNS; i++) {
  fs.writeFileSync(FILE, ORIG); const a = await run();
  fs.writeFileSync(FILE, ALTSRC); const b = await run();
  A.push(a); B.push(b);
  console.log(`  run${i}  A=${a.toFixed(2)}ms  B=${b.toFixed(2)}ms  diff=${(b - a).toFixed(2)}ms`);
}
restore();
const med = (v) => { const s = v.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const diffs = A.map((a, i) => B[i] - a);
// MIN, not mean. A browser launch lands in one of two states here — the same
// build measures 17.4 ms or 31.5 ms depending only on the launch — so the mean
// is a mixture and the paired difference is dominated by which state each arm
// drew. The minimum over N launches estimates the fast state, which is the one
// that matters and the only one that is a property of the build.
const mn = (v) => Math.min(...v);
console.log(`A(this) min=${mn(A).toFixed(2)} med=${med(A).toFixed(2)}   B(alt) min=${mn(B).toFixed(2)} med=${med(B).toFixed(2)}   MIN B-A ${(mn(B) - mn(A)).toFixed(2)} ms`);
console.log(`  A runs: ${A.map((x) => x.toFixed(2)).join(' ')}`);
console.log(`  B runs: ${B.map((x) => x.toFixed(2)).join(' ')}`);
console.log(`  all diffs: ${diffs.map((d) => d.toFixed(2)).join(' ')}   @ ${W}x${H} ${SHOT}`);
