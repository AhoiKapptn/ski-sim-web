/**
 * Real-rAF-loop performance probe with subsystem ablation.
 *
 *   node tools/perf-probe.mjs                       # baseline, hero framing
 *   node tools/perf-probe.mjs --shot ridge
 *   node tools/perf-probe.mjs --ablate sky,trees    # named ablations
 *   node tools/perf-probe.mjs --list
 *
 * Measures the ACTUAL requestAnimationFrame loop by reading window.__harness.frames
 * over wall-clock windows, exactly like tools/shoot.mjs --perf does, plus rAF
 * delta histograms captured in-page. It never uses harness.step(), which does
 * not reproduce the free-running frame cost.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const flag = (k) => argv.includes('--' + k);

const W = +arg('w', 1600), H = +arg('h', 900);
const SHOT = arg('shot', 'hero');
const WINDOWS = +arg('windows', 3);
const SECS = +arg('secs', 3);
const AUTO = !flag('static');
const ABLATE = (arg('ablate', '') || '').split(',').filter(Boolean);

const SHOTS = {
  hero:    { x: 0,    z: 700,  heading: Math.PI, settle: 90 },
  ridge:   { x: -260, z: 300,  heading: Math.PI * 0.86, settle: 120 },
  trees:   { x: 180,  z: 120,  heading: Math.PI * 1.1,  settle: 140 },
  steep:   { x: -40,  z: -260, heading: Math.PI,        settle: 200 },
  closeup: { x: 60,   z: 480,  heading: Math.PI * 0.95, settle: 60 },
};

// ---- ablations, applied in-page --------------------------------------------
// Each is a function body string run with `d` = window.__harness.debug.
const ABLATIONS = {
  'sky-off': `d.scene.getObjectByName('sky').visible = false;`,
  'clouds-off': `(() => {
      const m = d.sky.material;
      m.fragmentShader = m.fragmentShader
        .replace('vec4 ci = cirrusLayer( dir, cameraPosition, skyCol );', 'vec4 ci = vec4(0.0);')
        .replace(/vec4 ac = cloudLayer\\([^;]*;/, 'vec4 ac = vec4(0.0);')
        .replace(/vec4 cu = cloudLayer\\([^;]*;/, 'vec4 cu = vec4(0.0);');
      m.needsUpdate = true;
    })();`,
  'cumulus-off': `(() => {
      const m = d.sky.material;
      m.fragmentShader = m.fragmentShader.replace(/vec4 cu = cloudLayer\\([^;]*;/, 'vec4 cu = vec4(0.0);');
      m.needsUpdate = true;
    })();`,
  'cumulus-relief-off': `(() => {
      const m = d.sky.material;
      m.fragmentShader = m.fragmentShader.replace('1.55, 1.55, 1.25, 0.40, 0.26 );', '0.0, 1.55, 1.25, 0.40, 0.26 );');
      m.needsUpdate = true;
    })();`,
  'cumulus-shadow-off': `(() => {
      const m = d.sky.material;
      m.fragmentShader = m.fragmentShader
        .replace('float s1 = cloudShape( p1, cloudWarp( p1 ), covL, soft, quality );', 'float s1 = 0.3;')
        .replace('float s3 = cloudShape( p3, cloudWarp( p3 ), covL, soft, quality );', 'float s3 = 0.3;');
      m.needsUpdate = true;
    })();`,
  'ac-off': `(() => {
      const m = d.sky.material;
      m.fragmentShader = m.fragmentShader.replace(/vec4 ac = cloudLayer\\([^;]*;/, 'vec4 ac = vec4(0.0);');
      m.needsUpdate = true;
    })();`,
  'cirrus-off': `(() => {
      const m = d.sky.material;
      m.fragmentShader = m.fragmentShader.replace('vec4 ci = cirrusLayer( dir, cameraPosition, skyCol );', 'vec4 ci = vec4(0.0);');
      m.needsUpdate = true;
    })();`,
  'scatter-off': `d.scatter.group.visible = false;`,
  'trees-g1-off': `d.scatter.group.traverse(o => { if (o.isInstancedMesh && /g1|tree1/i.test(o.name)) o.visible = false; });`,
  'postfx-off': `(() => { const p = d.postfx; if (p.setEnabled) p.setEnabled(false); else if (p.composer) p.__off = true; })();`,
  'shadows-off': `d.renderer.shadowMap.enabled = false; d.scene.traverse(o=>{ if(o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.needsUpdate=true);} });`,
  'terrain-off': `(d.terrain.mesh ?? d.terrain.group).visible = false;`,
  'skier-off': `d.scene.traverse(o => { if (/skier|rig/i.test(o.name)) o.visible = false; });`,
  'half-res': `d.renderer.setPixelRatio(0.5); d.postfx.setSize(window.innerWidth, window.innerHeight);`,
  'near-cascade-off': `d.sky.sunNear.castShadow = false;`,
  'far-cascade-off': `d.sky.sun.castShadow = false;`,
  'scatter-noshadow': `d.scatter.group.traverse(o => { if (o.isInstancedMesh) o.castShadow = false; });`,
  'tree1-noshadow': `d.scatter.group.traverse(o => { if (o.name === 'tree1') o.castShadow = false; });`,
  'tree1-half': `d.scatter.group.traverse(o => { if (o.name === 'tree1') o.count = Math.floor(o.count / 2); });`,
  // undo BOTH of this pass's sky changes, so a snapshot taken with this on is
  // the pass-7 sky rendered from bit-identical simulation state
  'orig-clouds': `(() => {
      const m = d.sky.material;
      m.fragmentShader = m.fragmentShader
        .replace('if ( dir.y < max( 0.010, yFade * 0.16 ) ) return vec4( 0.0 );', 'if ( dir.y < 0.010 ) return vec4( 0.0 );')
        .replace('if ( dir.y < 0.05 || uCirrus <= 0.001 ) return vec4( 0.0 );', 'if ( dir.y < 0.02 || uCirrus <= 0.001 ) return vec4( 0.0 );')
        .replace('return 1.0 - smoothstep( 0.42, 0.95, fp * freq );', 'return 1.0;');
      m.needsUpdate = true;
    })();`,
};

if (flag('list')) { console.log(Object.keys(ABLATIONS).join('\n')); process.exit(0); }

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5300, strictPort: false, host: '127.0.0.1' },
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

const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const e = gl.getExtension('WEBGL_debug_renderer_info');
  return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log('  gpu: ' + gpu);

const s = SHOTS[SHOT];
await page.evaluate(() => window.__setAuto(false));

// Ablations are applied BEFORE the settle, and the settle is a fixed number of
// discrete steps, so an ablated run and a baseline run reach the snapshot with
// bit-identical simulation state. Applying them after the settle made every A/B
// image differ by four frames of skier travel, which swamps the shader change.
for (const name of ABLATE) {
  if (!ABLATIONS[name]) { console.error('unknown ablation ' + name); process.exit(2); }
  await page.evaluate(`(function(){ const d = window.__harness.debug; ${ABLATIONS[name]} })()`);
}
await new Promise((r) => setTimeout(r, 600));   // shader recompiles

const SNAP = arg('snap', '');
if (SNAP) {
  // Freeze the cloud clock before the settle, so two snaps are comparable pixel
  // for pixel: uTime otherwise advances with wall-clock frames.
  await page.evaluate(() => {
    const u = window.__harness.debug.sky.uniforms;
    Object.defineProperty(u.uTime, 'value', { get: () => 12.5, set: () => {} });
  });
}

await page.evaluate((s) => {
  window.__harness.setPlayer(s.x, s.z, s.heading);
  window.__harness.step(1 / 60, s.settle);
}, s);
await new Promise((r) => setTimeout(r, 500));

if (flag('stats')) {
  const st = await page.evaluate(() => {
    const by = {};
    window.__harness.debug.scatter.group.traverse((o) => {
      if (!o.isInstancedMesh || !o.count) return;
      const tri = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
      const e = by[o.name] || (by[o.name] = { pools: 0, inst: 0, tri: 0 });
      e.pools++; e.inst += o.count; e.tri += tri * o.count;
    });
    return by;
  });
  let total = 0;
  for (const [k, v] of Object.entries(st).sort((a, b) => b[1].tri - a[1].tri)) {
    total += v.tri;
    console.log(`  ${k.padEnd(12)} pools=${String(v.pools).padStart(3)} inst=${String(v.inst).padStart(5)} tris=${(v.tri / 1e3).toFixed(1)}k`);
  }
  console.log(`  TOTAL scatter tris ${(total / 1e6).toFixed(3)}M`);
}

if (SNAP) {
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.__harness.step(1 / 60, 1));
    await new Promise((r) => setTimeout(r, 32));
  }
  await page.screenshot({ path: path.resolve(ROOT, SNAP) });
}

// in-page rAF delta capture, independent of the app's own loop
await page.evaluate(() => {
  window.__deltas = [];
  let prev = performance.now();
  const tick = () => {
    const n = performance.now();
    window.__deltas.push(n - prev);
    prev = n;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.evaluate((auto) => window.__setAuto(auto), AUTO);

const fpsList = [];
for (let i = 0; i < WINDOWS; i++) {
  await page.evaluate(() => { window.__harness.frames = 0; window.__deltas.length = 0; });
  await new Promise((r) => setTimeout(r, SECS * 1000));
  const out = await page.evaluate((secs) => {
    const d = window.__deltas.slice().sort((a, b) => a - b);
    const q = (p) => d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : 0;
    const info = window.__harness.debug.renderer.info;
    return {
      fps: +(window.__harness.frames / secs).toFixed(1),
      n: d.length,
      med: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p99: +q(0.99).toFixed(2),
      tris: info.render.triangles, calls: info.render.calls,
    };
  }, SECS);
  fpsList.push(out);
  console.log(`  win${i} ${out.fps} fps  medΔ=${out.med}ms p90=${out.p90} p99=${out.p99}  tris=${out.tris} calls=${out.calls}`);
}
const avg = fpsList.reduce((a, b) => a + b.fps, 0) / fpsList.length;
const medAvg = fpsList.reduce((a, b) => a + b.med, 0) / fpsList.length;
console.log(`RESULT ${SHOT} ${AUTO ? 'auto' : 'static'} [${ABLATE.join('+') || 'baseline'}] avg=${avg.toFixed(1)} fps  medFrame=${medAvg.toFixed(2)} ms`);
if (errors.length) console.error('errors:\n  ' + errors.slice(0, 10).join('\n  '));

await browser.close();
await server.close();
process.exit(0);
