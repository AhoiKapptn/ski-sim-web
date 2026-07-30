/**
 * PAIRED A/B frame-cost probe.
 *
 * The machine this runs on is shared with other agents, so absolute fps from a
 * single browser launch is worthless: the same unmodified build measured 16.7,
 * 22.7 and 45.4 ms per frame within one hour. What IS reliable is an A/B taken
 * inside ONE page, alternating the two variants every ~1.5 s, so any contention
 * hits both arms equally and the paired difference survives.
 *
 * Variant B is produced by string-substituting the sky shader back to some
 * earlier form (see VARIANTS), which is the only subsystem whose cost can be
 * switched at runtime without touching the scene graph.
 *
 *   node tools/perf-ab.mjs --variant orig-clouds --cycles 6
 *   node tools/perf-ab.mjs --variant no-clouds --shot ridge --w 2560 --h 1440
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };

const W = +arg('w', 2560), H = +arg('h', 1440);
const SHOT = arg('shot', 'hero');
const CYCLES = +arg('cycles', 6);
const SECS = +arg('secs', 1.5);
const VARIANT = arg('variant', 'no-clouds');

const SHOTS = {
  hero:    { x: 0,    z: 700,  heading: Math.PI, settle: 90 },
  ridge:   { x: -260, z: 300,  heading: Math.PI * 0.86, settle: 120 },
  trees:   { x: 180,  z: 120,  heading: Math.PI * 1.1,  settle: 140 },
  steep:   { x: -40,  z: -260, heading: Math.PI,        settle: 200 },
  closeup: { x: 60,   z: 480,  heading: Math.PI * 0.95, settle: 60 },
};

// Each variant is a list of [find, replace] applied to the sky fragment shader
// to build arm B. Arm A is always the shader as the source file ships it.
const VARIANTS = {
  'no-clouds': [
    ['vec4 ci = cirrusLayer( dir, cameraPosition, skyCol, dpx );', 'vec4 ci = vec4(0.0);'],
    ['vec4 ci = cirrusLayer( dir, cameraPosition, skyCol );', 'vec4 ci = vec4(0.0);'],
    [/vec4 ac = cloudLayer\([^;]*;/, 'vec4 ac = vec4(0.0);'],
    [/vec4 cu = cloudLayer\([^;]*;/, 'vec4 cu = vec4(0.0);'],
  ],
  // Undo the horizon early-outs added this pass.
  'orig-earlyout': [
    ['if ( dir.y < max( 0.010, yFade * 0.16 ) ) return vec4( 0.0 );', 'if ( dir.y < 0.010 ) return vec4( 0.0 );'],
    ['if ( dir.y < 0.05 || uCirrus <= 0.001 ) return vec4( 0.0 );', 'if ( dir.y < 0.02 || uCirrus <= 0.001 ) return vec4( 0.0 );'],
  ],
  'no-cu': [[/vec4 cu = cloudLayer\([^;]*;/, 'vec4 cu = vec4(0.0);']],
  'no-ac': [[/vec4 ac = cloudLayer\([^;]*;/, 'vec4 ac = vec4(0.0);']],
  'no-ci': [['vec4 ci = cirrusLayer( dir, cameraPosition, skyCol, dpx );', 'vec4 ci = vec4(0.0);']],
  // the cumulus parallax slab
  'no-dtop': [['1.55, 1.55, 1.25, 0.40, 0.26 );', '0.0, 1.55, 1.25, 0.40, 0.26 );']],
  // the two horizontal self-shadow taps
  'no-shadowtaps': [
    ['float s1 = cloudShape( p1, cloudWarp( p1 ), covL, soft, quality, fp );', 'float s1 = 0.3;'],
    ['float s3 = cloudShape( p3, cloudWarp( p3 ), covL, soft, quality, fp );', 'float s3 = 0.3;'],
  ],
  // all three erosion octaves
  'no-erosion': [['if ( quality > 0 ) {\n    // Erode the edges', 'if ( false ) {\n    // Erode the edges']],
  // the 4 x cloudWarp domain warp
  'no-warp': [['vec2 cloudWarp( vec2 p ) {', 'vec2 cloudWarp( vec2 p ) { return vec2( 0.0 );']],
  // the per-region weather field
  'no-weather': [['float wCov  = fbm2(   p0 * 0.075 + vec2(  3.3,  1.7 ) );', 'float wCov = 0.5;']],
  // Undo the screen-space octave LOD: force every tap to full detail.
  'orig-lod': [
    ['return 1.0 - smoothstep( 0.42, 0.95, fp * freq );', 'return 1.0;'],
  ],
  // Both of this pass's sky changes at once = the shader as pass 7 shipped it.
  'orig-clouds': [
    ['if ( dir.y < max( 0.010, yFade * 0.16 ) ) return vec4( 0.0 );', 'if ( dir.y < 0.010 ) return vec4( 0.0 );'],
    ['if ( dir.y < 0.05 || uCirrus <= 0.001 ) return vec4( 0.0 );', 'if ( dir.y < 0.02 || uCirrus <= 0.001 ) return vec4( 0.0 );'],
    ['return 1.0 - smoothstep( 0.42, 0.95, fp * freq );', 'return 1.0;'],
  ],
};

const subs = VARIANTS[VARIANT];
if (!subs) { console.error('variants: ' + Object.keys(VARIANTS).join(', ')); process.exit(2); }

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5310, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 300000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('console: ' + m.text()); });

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));

const s = SHOTS[SHOT];
await page.evaluate(() => window.__setAuto(false));
await page.evaluate((s) => {
  window.__harness.setPlayer(s.x, s.z, s.heading);
  window.__harness.step(1 / 60, s.settle);
}, s);

// Build both shader sources once, in-page.
const built = await page.evaluate((subsSrc) => {
  const m = window.__harness.debug.sky.material;
  window.__A = m.fragmentShader;
  let b = window.__A;
  const applied = [];
  for (const [find, flags, rep] of subsSrc) {
    const f = flags === null ? find : new RegExp(find, flags);
    const before = b;
    b = b.replace(f, rep);
    applied.push(before !== b);
  }
  window.__B = b;
  window.__setSky = (which) => {
    m.fragmentShader = which === 'A' ? window.__A : window.__B;
    m.needsUpdate = true;
  };
  return { applied, same: window.__A === window.__B };
}, subs.map(([f, r]) => (f instanceof RegExp ? [f.source, f.flags, r] : [f, null, r])));

console.log('  subs applied: ' + JSON.stringify(built.applied));
if (built.same) {
  console.error('SUBSTITUTION FAILED: ' + JSON.stringify(built));
  await browser.close(); await server.close(); process.exit(3);
}

await page.evaluate(() => {
  window.__deltas = [];
  let prev = performance.now();
  const tick = () => { const n = performance.now(); window.__deltas.push(n - prev); prev = n; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});

async function measure(which) {
  await page.evaluate((w) => window.__setSky(w), which);
  await new Promise((r) => setTimeout(r, 400));           // recompile + settle
  await page.evaluate(() => { window.__deltas.length = 0; });
  await new Promise((r) => setTimeout(r, SECS * 1000));
  return page.evaluate(() => {
    const d = window.__deltas.slice().sort((a, b) => a - b);
    return { med: d[Math.floor(d.length / 2)], n: d.length };
  });
}

// warm both programs before the first measured cycle
await measure('A'); await measure('B');

const A = [], B = [];
for (let c = 0; c < CYCLES; c++) {
  const a = await measure('A');
  const b = await measure('B');
  A.push(a.med); B.push(b.med);
  console.log(`  cycle${c}  A=${a.med.toFixed(2)}ms  B=${b.med.toFixed(2)}ms  diff=${(b.med - a.med).toFixed(2)}ms`);
}
const med = (v) => { const s = v.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const diffs = A.map((a, i) => B[i] - a);
console.log(`A = this build          median ${med(A).toFixed(2)} ms`);
console.log(`B = ${VARIANT.padEnd(18)} median ${med(B).toFixed(2)} ms`);
console.log(`PAIRED B-A median ${med(diffs).toFixed(2)} ms  (all: ${diffs.map((d) => d.toFixed(2)).join(' ')})  @ ${W}x${H} ${SHOT}`);
if (errors.length) console.error('errors:\n  ' + errors.slice(0, 8).join('\n  '));
await browser.close(); await server.close(); process.exit(0);
