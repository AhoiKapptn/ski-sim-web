/**
 * Lighting measurement probe.
 *
 *   node tools/skylight-probe.mjs [--only hero,ridge]
 *
 * Renders the real scene into a Float32 render target (no post) and reports
 * LINEAR radiance, classified by how much of the key light actually reaches the
 * pixel (measured by re-rendering with the sun off — not guessed from pixels).
 * Then re-renders the normal post-processed frame and reports the DISPLAY code
 * values of the very same pixels, so "linear ratio" and "what a reviewer
 * eyedroppers" are always quoted side by side.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };

const SHOTS = {
  hero:    { x: 0,    z: 700,  heading: Math.PI, settle: 90 },
  ridge:   { x: -260, z: 300,  heading: Math.PI * 0.86, settle: 120 },
  trees:   { x: 180,  z: 120,  heading: Math.PI * 1.1,  settle: 140 },
  steep:   { x: -40,  z: -260, heading: Math.PI,        settle: 200 },
  closeup: { x: 60,   z: 480,  heading: Math.PI * 0.95, settle: 60 },
};
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const W = +arg('w', 1600), H = +arg('h', 900);

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5211, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 240000,
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
await new Promise((r) => setTimeout(r, 1500));

await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  window.__T = THREE;
  const d = window.__harness.debug;
  const r = d.renderer;
  const size = r.getSize(new THREE.Vector2());
  const w = size.x | 0, h = size.y | 0;
  window.__W = w; window.__H = h;
  window.__rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType, format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace, depthBuffer: true, stencilBuffer: false, samples: 0,
  });
  window.__rt.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
  window.__depthMat = new THREE.ShaderMaterial({
    uniforms: { tD: { value: window.__rt.depthTexture }, uNear: { value: 0.1 }, uFar: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0);} ',
    fragmentShader: `precision highp float; varying vec2 vUv; uniform sampler2D tD;
      uniform float uNear, uFar;
      void main(){ float z = texture2D(tD, vUv).x; float ndc = z*2.0-1.0;
        gl_FragColor = vec4((2.0*uNear*uFar)/(uFar+uNear-ndc*(uFar-uNear)), 0.0, 0.0, 1.0); }`,
  });
  window.__depthRT = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace });
  window.__quadScene = new THREE.Scene();
  window.__quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), window.__depthMat));
  window.__quadCam = new THREE.Camera();
  window.__c2d = document.createElement('canvas');
  window.__c2d.width = w; window.__c2d.height = h;
  window.__ctx = window.__c2d.getContext('2d', { willReadFrequently: true });
});

const f = (n, k = 3) => (n === null || n === undefined || Number.isNaN(n)) ? ' n/a' : n.toFixed(k);
const rgb = (s) => s ? `${f(s.r)}/${f(s.g)}/${f(s.b)}` : ' n/a';
const drgb = (s) => s ? `${f(s.dr, 0)},${f(s.dg, 0)},${f(s.db, 0)}` : 'n/a';

const names = ONLY.length ? ONLY : Object.keys(SHOTS);

for (const name of names) {
  const s = SHOTS[name];
  await page.evaluate(() => window.__setAuto?.(false));
  await page.evaluate((s) => {
    window.__harness.setPlayer(s.x, s.z, s.heading);
    window.__harness.step(1 / 60, s.settle);
  }, s);
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.__harness.step(1 / 60, 1));
    await new Promise((r) => setTimeout(r, 25));
  }

  const res = await page.evaluate(() => {
    const THREE = window.__T;
    const d = window.__harness.debug;
    const r = d.renderer, scene = d.scene, cam = d.camera;
    const rt = window.__rt, w = window.__W, h = window.__H;
    const sun = d.sky?.sun ?? scene.getObjectByProperty('isDirectionalLight', true);
    const skyMesh = scene.getObjectByName('sky');

    const prevRT = r.getRenderTarget(), prevTM = r.toneMapping, prevOCS = r.outputColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    const grab = (t) => { r.setRenderTarget(rt); r.clear(true, true, true); r.render(scene, cam);
      r.readRenderTargetPixels(rt, 0, 0, w, h, t); r.setRenderTarget(null); };

    const A = new Float32Array(w * h * 4); grab(A);
    const keep = sun.intensity; sun.intensity = 0;
    const B = new Float32Array(w * h * 4); grab(B);
    sun.intensity = keep;

    const skyVis = skyMesh ? skyMesh.visible : true;
    if (skyMesh) skyMesh.visible = false;
    const pc = new THREE.Color(); r.getClearColor(pc); const pa = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    const C = new Float32Array(w * h * 4); grab(C);

    // terrain-only mask: alpha > 0 == a terrain pixel (rules out trees/props)
    const terrainGrp = scene.getObjectByName('terrain');
    const hidden = [];
    if (terrainGrp) for (const o of scene.children) {
      if (o !== terrainGrp && o.visible && o.type !== 'DirectionalLight') { o.visible = false; hidden.push(o); }
    }
    const M = new Float32Array(w * h * 4); grab(M);
    window.__depthMat.uniforms.uNear.value = cam.near;
    window.__depthMat.uniforms.uFar.value = cam.far;
    const readDepth = (dst) => {
      r.setRenderTarget(rt); r.clear(true, true, true); r.render(scene, cam); r.setRenderTarget(null);
      r.setRenderTarget(window.__depthRT); r.render(window.__quadScene, window.__quadCam);
      r.readRenderTargetPixels(window.__depthRT, 0, 0, w, h, dst);
      r.setRenderTarget(null);
    };
    const DM = new Float32Array(w * h * 4); readDepth(DM);   // terrain-only depth
    for (const o of hidden) o.visible = true;
    r.setClearColor(pc, pa);
    if (skyMesh) skyMesh.visible = skyVis;

    const D = new Float32Array(w * h * 4); readDepth(D);      // full-scene depth

    // clear-sky reference: same dome with the cloud decks switched off, so a
    // pixel's cloud contribution (and therefore cloud top vs base) is isolated.
    const su = d.sky.uniforms;
    const cd = su.uCloudDensity.value, cr = su.uCirrus.value;
    su.uCloudDensity.value = 0; su.uCirrus.value = 0;
    const K = new Float32Array(w * h * 4); grab(K);
    su.uCloudDensity.value = cd; su.uCirrus.value = cr;
    r.setRenderTarget(prevRT);
    r.toneMapping = prevTM; r.outputColorSpace = prevOCS;

    // final graded frames, same pixels — sun on, then sun off (== "all in shadow")
    window.__harness.step(1 / 60, 1);
    window.__ctx.drawImage(r.domElement, 0, 0, w, h);
    const P = window.__ctx.getImageData(0, 0, w, h).data;   // top-down
    sun.intensity = 0;
    window.__harness.step(1 / 60, 1); window.__harness.step(1 / 60, 1);
    window.__ctx.drawImage(r.domElement, 0, 0, w, h);
    const Q = window.__ctx.getImageData(0, 0, w, h).data;
    sun.intensity = keep;
    window.__harness.step(1 / 60, 1);

    const lum = (i, b) => 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
    const acc = () => ({ n: 0, L: [], r: [], g: [], b: [], dr: 0, dg: 0, db: 0 });
    const push = (o, i, S, T) => {
      o.n++; o.L.push(lum(i, S)); o.r.push(S[i]); o.g.push(S[i + 1]); o.b.push(S[i + 2]);
      const y = (i / 4 / w) | 0, x = (i / 4) % w;
      const j = (((h - 1 - y) * w) + x) * 4;
      o.dr += T[j]; o.dg += T[j + 1]; o.db += T[j + 2];
    };
    const med = (a) => { if (!a.length) return null; const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
    const fin = (o) => o.n < 12 ? null : {
      n: o.n, lum: med(o.L), r: med(o.r), g: med(o.g), b: med(o.b),
      br: med(o.b) / Math.max(med(o.r), 1e-5),
      dr: o.dr / o.n, dg: o.dg / o.n, db: o.db / o.n,
    };

    // lit = the snow as rendered; skylit = the SAME pixels with the key off.
    const lit = acc(), skylit = acc(), shade = acc(), skyHor = acc(), skyZen = acc();
    const farBands = [[600, 1200], [1200, 2400], [2400, 5000], [5000, 30000]].map((b) => ({ b, a: acc(), s: 0 }));
    const hist = new Array(10).fill(0);
    const cloudL = [];

    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (C[i + 3] < 0.5) {                       // sky
        if (y / h > 0.52 && y / h < 0.60) push(skyHor, i, A, P);
        if (y / h > 0.88) push(skyZen, i, A, P);
        // opaque cloud: at least 55% of this pixel's radiance is not clear sky
        const la0 = lum(i, A), lk = lum(i, K);
        if (la0 > 1e-4 && Math.abs(la0 - lk) / la0 > 0.55) cloudL.push(la0);
        continue;
      }
      // "terrain" only if the terrain-only pass shows the SAME surface depth —
      // otherwise a tree in front of terrain would be counted as snow.
      const dist = D[i];
      const isTerrain = M[i + 3] >= 0.5 && Math.abs(DM[i] - dist) < 0.01 * dist + 0.5;
      const la = lum(i, A), lb = lum(i, B);
      const mx = Math.max(A[i], A[i + 1], A[i + 2]), mn = Math.min(A[i], A[i + 1], A[i + 2]);
      if (mx < 1e-4) continue;
      const frac = (la - lb) / Math.max(la, 1e-5);
      if (isTerrain && (mx - mn) / mx < 0.34 && frac > 0.7 && la > 0.12) {
        for (const fb of farBands) if (dist >= fb.b[0] && dist < fb.b[1]) { push(fb.a, i, A, P); fb.s += dist; }
      }
      if (dist > 220 || !isTerrain) continue;
      // NB the threshold has to be loose enough to keep *shadowed* snow, whose
      // chroma is ~0.6 because skylight is blue. A tight one silently threw
      // every shadow pixel away and reported "0% in shade".
      if ((mx - mn) / mx > 0.70) continue;        // not snow-ish
      hist[Math.min(9, Math.max(0, (frac * 10) | 0))]++;
      if (frac > 0.55 && la > 0.25) { push(lit, i, A, P); push(skylit, i, B, Q); }
      else if (frac < 0.08) push(shade, i, A, P);
    }

    // skyline: terrain just below the horizon vs sky just above it
    let maxRatio = 0, sumR = 0, nR = 0;
    for (let x = 20; x < w - 20; x += 8) {
      let ys = -1;
      for (let y = h - 3; y > 2; y--) { if (C[(y * w + x) * 4 + 3] >= 0.5) { ys = y; break; } }
      if (ys < 8 || ys > h - 10) continue;
      const iG = ((ys - 4) * w + x) * 4, iS = ((ys + 7) * w + x) * 4;
      if (C[iG + 3] < 0.5 || C[iS + 3] >= 0.5) continue;
      const lg = lum(iG, A), ls = lum(iS, A);
      if (ls < 1e-4) continue;
      const ratio = lg / ls; sumR += ratio; nR++; if (ratio > maxRatio) maxRatio = ratio;
    }

    const tot = hist.reduce((a, b) => a + b, 0) || 1;
    const sk = d.sky;
    return {
      lit: fin(lit), skylit: fin(skylit), shade: fin(shade),
      skyHor: fin(skyHor), skyZen: fin(skyZen),
      far: farBands.map((fb) => ({ lo: fb.b[0], hi: fb.b[1], d: fb.a.n ? fb.s / fb.a.n : null, s: fin(fb.a) })),
      hist: hist.map((v) => +(100 * v / tot).toFixed(1)),
      cloud: (() => {
        if (cloudL.length < 200) return null;
        const s = cloudL.sort((a, b) => a - b);
        const p = (q) => s[Math.min(s.length - 1, (s.length * q) | 0)];
        return { n: s.length, p05: p(0.05), p50: p(0.5), p95: p(0.95), ratio: p(0.05) / Math.max(p(0.95), 1e-5) };
      })(),
      shadowFrac: +(100 * (hist[0] + hist[1] + hist[2]) / tot).toFixed(1),
      skylineMax: nR ? maxRatio : null, skylineMean: nR ? sumR / nR : null,
      sunElevDeg: sk?.getSunElevation ? sk.getSunElevation() * 180 / Math.PI : null,
      sunIntensity: sun.intensity, envIntensity: scene.environmentIntensity,
      domeZen: sk?.sampleSky ? sk.sampleSky(88, Math.PI * 0.5) : null,
      domeHor: sk?.sampleSky ? sk.sampleSky(4, Math.PI * 0.5) : null,
      haze: (() => { const c = scene.fog.color.clone().convertSRGBToLinear();
        return [c.r, c.g, c.b, c.b / Math.max(c.r, 1e-5), scene.fog.density]; })(),
      // The canonical framings simply do not contain enough 3 km sunlit snow to
      // take a median of, so evaluate the shipped aerial-perspective integral
      // (terrain.js SNOW_AERIAL, verbatim) for a ridge 3 km out and 250 m up,
      // fed with the sunlit-snow radiance measured above. Model, not pixels —
      // labelled as such.
      ridge3km: (() => {
        const tu = d.terrain && (d.terrain.snowUniforms
          || (d.terrain.material && d.terrain.material.userData.snowUniforms));
        if (!tu || !lit.n) return null;
        const Hs = tu.uAerialHeight.value, D = tu.uAerialDensity.value;
        const air = tu.uAerialColor.value;
        const camY = cam.position.y, dy = 250, dist = Math.hypot(3000, dy);
        const e0 = Math.exp(-Math.max(camY, -200) / Hs);
        const e1 = Math.exp(-Math.max(camY + dy, -200) / Hs);
        const t = dist * Hs / dy * (e0 - e1);
        const f = Math.min(1, Math.max(0, 1 - Math.exp(-D * t)));
        const L = fin(lit);
        const R = L.r + (air.r - L.r) * f, G = L.g + (air.g - L.g) * f, B = L.b + (air.b - L.b) * f;
        return { f, lum: 0.2126 * R + 0.7152 * G + 0.0722 * B, br: B / Math.max(R, 1e-5) };
      })(),
    };
  });

  const stops = (a, b) => Math.log2(a / b);
  const dl = (a, b) => 0.2126 * (a.dr - b.dr) + 0.7152 * (a.dg - b.dg) + 0.0722 * (a.db - b.db);
  console.log(`\n=== ${name}  sun ${f(res.sunElevDeg, 1)}deg  key ${f(res.sunIntensity, 2)}  env ${f(res.envIntensity, 3)}`);
  console.log(`  SUNLIT snow   lin ${f(res.lit?.lum)}  ${rgb(res.lit)}  B/R ${f(res.lit?.br)}   disp ${drgb(res.lit)}  n=${res.lit?.n}`);
  console.log(`  SKYLIT (same px, key off)  lin ${f(res.skylit?.lum)}  ${rgb(res.skylit)}  B/R ${f(res.skylit?.br)}   disp ${drgb(res.skylit)}`);
  if (res.lit && res.skylit)
    console.log(`  >> KEY:FILL ${f(res.lit.lum / res.skylit.lum, 2)}x  ${f(stops(res.lit.lum, res.skylit.lum), 2)} stops   display gap ${f(dl(res.lit, res.skylit), 0)} codes`);
  if (res.shade) console.log(`  in-frame cast shadow  lin ${f(res.shade.lum)}  B/R ${f(res.shade.br)}  disp ${drgb(res.shade)}  n=${res.shade.n}`);
  for (const fb of res.far) if (fb.s)
    console.log(`  far ${fb.lo}-${fb.hi}m (~${f(fb.d, 0)}m)  lin ${f(fb.s.lum)}  B/R ${f(fb.s.br)}  disp ${drgb(fb.s)}  n=${fb.s.n}`);
  console.log(`  sky horizon  lin ${f(res.skyHor?.lum)}  B/R ${f(res.skyHor?.br)}  disp ${drgb(res.skyHor)}`);
  console.log(`  sky zenith   lin ${f(res.skyZen?.lum)}  B/R ${f(res.skyZen?.br)}  disp ${drgb(res.skyZen)}`);
  if (res.domeZen) console.log(`  dome analytic  zenith ${res.domeZen.map((v) => f(v)).join('/')}  horizon ${res.domeHor.map((v) => f(v)).join('/')}`);
  if (res.haze) console.log(`  haze colour  ${res.haze.slice(0, 3).map((v) => f(v)).join('/')}  B/R ${f(res.haze[3])}  density ${f(res.haze[4], 5)}`);
  if (res.ridge3km) console.log(`  MODEL sunlit ridge @3km  lin ${f(res.ridge3km.lum)}  B/R ${f(res.ridge3km.br)}  (haze fraction ${f(res.ridge3km.f, 2)})`);
  console.log(`  skyline terrain/sky  max ${f(res.skylineMax, 2)}  mean ${f(res.skylineMean, 2)}`);
  if (res.cloud) console.log(`  cloud  top(p95) ${f(res.cloud.p95)}  med ${f(res.cloud.p50)}  base(p05) ${f(res.cloud.p05)}   base/top ${f(res.cloud.ratio, 3)}  n=${res.cloud.n}`);
  console.log(`  sun-frac hist(0..1) ${res.hist.join(' ')}   in shade: ${f(res.shadowFrac, 1)}%`);
}

if (errors.length) { console.error('\n--- errors ---'); errors.slice(0, 20).forEach((e) => console.error('  ' + e)); }
await browser.close();
await server.close();
process.exit(0);
