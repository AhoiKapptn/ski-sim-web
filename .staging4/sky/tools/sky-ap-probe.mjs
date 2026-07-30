/**
 * Aerial-perspective measurement probe (sky.js).
 *
 *   node tools/sky-ap-probe.mjs --only hero,closeup
 *
 * For each canonical framing it
 *   1. raymarches the authoritative heightfield (terrain.height) through every
 *      8th pixel to get a per-pixel *world distance*,
 *   2. reads the presented framebuffer back with gl.readPixels,
 *   3. buckets the pixels by distance and reports, per band, the display
 *      luminance mean / p05 / p95, the internal contrast (p95-p05)/mean, and
 *      the B/R ratio (the blue shift).
 *
 * The headline number is INTERNAL CONTRAST of the 2.5-5 km band: how much
 * luminance variation a distant ridge still has left after aerial perspective.
 * A cardboard cutout measures near 0.
 *
 * It also reports the fog model's own transmittance at a set of distances, and
 * scans the horizon for a hard horizontal discontinuity (the "haze band").
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
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const OUTJSON = arg('json', '');
const SWEEP = arg('sweep', '');   // e.g. --sweep "hazeGain=1.0,1.2,1.4;aerialDensity=0.0006,0.0008"
const SET = arg('set', '');       // e.g. --set "hazeGain=1.2,aerialDensity=0.0008"

/** "a=1,2;b=3" -> [ {a:1,b:3}, {a:2,b:3} ] */
function parseSweep(spec) {
  if (!spec) return [null];
  const axes = spec.split(';').filter(Boolean).map((ax) => {
    const [k, vs] = ax.split('=');
    return [k.trim(), vs.split(',').map((v) => (v.includes('|') ? v.split('|').map(Number) : Number(v)))];
  });
  let combos = [{}];
  for (const [k, vals] of axes) {
    const next = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [k]: v });
    combos = next;
  }
  return combos;
}
function parseSet(spec) {
  if (!spec) return null;
  const o = {};
  for (const kv of spec.split(',')) {
    const [k, v] = kv.split('=');
    o[k.trim()] = v.includes('|') ? v.split('|').map(Number) : Number(v);
  }
  return o;
}

const SHOTS = {
  hero:    { x: 0,    z: 700,  heading: Math.PI, settle: 90 },
  ridge:   { x: -260, z: 300,  heading: Math.PI * 0.86, settle: 120 },
  trees:   { x: 180,  z: 120,  heading: Math.PI * 1.1,  settle: 140 },
  steep:   { x: -40,  z: -260, heading: Math.PI,        settle: 200 },
  closeup: { x: 60,   z: 480,  heading: Math.PI * 0.95, settle: 60 },
};

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 5211, strictPort: false, host: '127.0.0.1' },
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
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

let code = 0;
const out = {};
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));

  const names = ONLY.length ? ONLY : Object.keys(SHOTS);
  for (const name of names) {
    const s = SHOTS[name];
    await page.evaluate(() => window.__setAuto?.(false));
    await page.evaluate((s) => {
      window.__harness.setPlayer(s.x, s.z, s.heading);
      window.__harness.step(1 / 60, s.settle);
    }, s);
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => window.__harness.step(1 / 60, 1));
      await new Promise((r) => setTimeout(r, 24));
    }

    const combos = SWEEP ? parseSweep(SWEEP) : [parseSet(SET)];
    for (const combo of combos) {
    if (combo) {
      await page.evaluate((c) => {
        Object.assign(window.__harness.debug.sky.params, c);
        window.__harness.debug.sky.refresh();
      }, combo);
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.__harness.step(1 / 60, 1));
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    const res = await page.evaluate((STRIDE) => {
      const D = window.__harness.debug;
      const cam = D.camera, terrain = D.terrain, renderer = D.renderer;
      cam.updateMatrixWorld();

      // ---- read the presented frame -------------------------------------
      window.__harness.step(1 / 60, 0);
      const gl = renderer.getContext();
      const w = renderer.domElement.width, h = renderer.domElement.height;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      // readPixels is bottom-up
      const px = (x, y) => { const i = ((h - 1 - y) * w + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]]; };

      // ---- manual unproject ----------------------------------------------
      const Pi = cam.projectionMatrixInverse.elements;
      const Mw = cam.matrixWorld.elements;
      const camPos = [Mw[12], Mw[13], Mw[14]];
      function rayDir(ndcx, ndcy) {
        // view-space point at ndc z = 0
        const x = Pi[0] * ndcx + Pi[4] * ndcy + Pi[8] * 0 + Pi[12];
        const y = Pi[1] * ndcx + Pi[5] * ndcy + Pi[9] * 0 + Pi[13];
        const z = Pi[2] * ndcx + Pi[6] * ndcy + Pi[10] * 0 + Pi[14];
        const ww = Pi[3] * ndcx + Pi[7] * ndcy + Pi[11] * 0 + Pi[15];
        let vx = x / ww, vy = y / ww, vz = z / ww;
        const l = Math.hypot(vx, vy, vz); vx /= l; vy /= l; vz /= l;
        return [
          Mw[0] * vx + Mw[4] * vy + Mw[8] * vz,
          Mw[1] * vx + Mw[5] * vy + Mw[9] * vz,
          Mw[2] * vx + Mw[6] * vy + Mw[10] * vz,
        ];
      }

      const MAXT = 14000;
      function march(d) {
        if (d[1] > 0.35) return -1;              // steeply up: sky
        let t = 2, prev = camPos[1] - terrain.height(camPos[0], camPos[2]);
        while (t < MAXT) {
          const x = camPos[0] + d[0] * t, y = camPos[1] + d[1] * t, z = camPos[2] + d[2] * t;
          const cur = y - terrain.height(x, z);
          if (cur <= 0) {
            // bisect once for a tighter distance
            let lo = t - Math.max(4, t * 0.012), hi = t;
            for (let k = 0; k < 12; k++) {
              const m = (lo + hi) * 0.5;
              const yy = camPos[1] + d[1] * m;
              if (yy - terrain.height(camPos[0] + d[0] * m, camPos[2] + d[2] * m) <= 0) hi = m; else lo = m;
            }
            return (lo + hi) * 0.5;
          }
          prev = cur;
          t += Math.max(4, t * 0.012);
        }
        return -1;
      }

      const skyMod0 = D.sky;
      // sun direction (world), from the key light
      let sunL = null;
      D.scene.traverse((o) => { if (!sunL && o.isDirectionalLight) sunL = o; });
      const sp = sunL.position, sl = Math.hypot(sp.x, sp.y, sp.z);
      const sunDir = [sp.x / sl, sp.y / sl, sp.z / sl];
      const _n = { x: 0, y: 1, z: 0 };

      // ---- bucket by distance --------------------------------------------
      const BANDS = [
        ['near   <150m', 0, 150],
        ['mid  150-800', 150, 800],
        ['far  0.8-2 km', 800, 2000],
        ['FAR  2-3.5 km', 2000, 3500],
        ['FAR  3.5-6 km', 3500, 6000],
        ['edge  >6 km', 6000, 1e9],
      ];
      const acc = BANDS.map(() => ({ lum: [], r: 0, g: 0, b: 0, n: 0, ymin: 1e9, ymax: -1e9 }));
      const sky = { lum: [], r: 0, g: 0, b: 0, n: 0, ymin: 1e9, ymax: -1e9 };
      // lit / shaded split of the distant ridges (2.5-6 km)
      const face = { lit: [], shade: [], litRGB: [0, 0, 0], shadeRGB: [0, 0, 0] };
      // same split, but resolved by distance so "a 3 km ridge" can be checked
      const faceBy = [[2500, 4000, [], []], [4000, 6000, [], []]];
      // distance map for the horizon scan
      const dmap = new Float32Array(Math.ceil(w / STRIDE) * Math.ceil(h / STRIDE));
      const gw = Math.ceil(w / STRIDE);

      for (let y = 0; y < h; y += STRIDE) {
        for (let x = 0; x < w; x += STRIDE) {
          const ndcx = (x + 0.5) / w * 2 - 1;
          const ndcy = 1 - (y + 0.5) / h * 2;
          const d = rayDir(ndcx, ndcy);
          const t = march(d);
          dmap[(y / STRIDE | 0) * gw + (x / STRIDE | 0)] = t;
          const c = px(x, y);
          const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          if (t < 0) {
            sky.lum.push(L); sky.r += c[0]; sky.g += c[1]; sky.b += c[2]; sky.n++;
            if (y < sky.ymin) sky.ymin = y; if (y > sky.ymax) sky.ymax = y;
            continue;
          }
          for (let bi = 0; bi < BANDS.length; bi++) {
            if (t >= BANDS[bi][1] && t < BANDS[bi][2]) {
              const a = acc[bi];
              a.lum.push(L); a.r += c[0]; a.g += c[1]; a.b += c[2]; a.n++;
              if (y < a.ymin) a.ymin = y; if (y > a.ymax) a.ymax = y;
              break;
            }
          }
          // lit vs shaded faces of the distant ridge
          if (t >= 2500 && t < 6000) {
            const hx = camPos[0] + d[0] * t, hz = camPos[2] + d[2] * t;
            const nv = terrain.normal(hx, hz, 12);   // epsilon form, ~3 px footprint at 4 km
            const ndl = nv.x * sunDir[0] + nv.y * sunDir[1] + nv.z * sunDir[2];
            const fb = faceBy.find((q) => t >= q[0] && t < q[1]);
            if (ndl > 0.45) { face.lit.push(L); face.litRGB[0] += c[0]; face.litRGB[1] += c[1]; face.litRGB[2] += c[2]; if (fb) fb[2].push(L); }
            else if (ndl < 0.10) { face.shade.push(L); face.shadeRGB[0] += c[0]; face.shadeRGB[1] += c[1]; face.shadeRGB[2] += c[2]; if (fb) fb[3].push(L); }
          }
        }
      }

      function pct(arr, p) {
        if (!arr.length) return 0;
        const s = Float64Array.from(arr).sort();
        return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
      }
      function stat(a) {
        if (!a.n) return null;
        const mean = a.lum.reduce((s, v) => s + v, 0) / a.n;
        const p05 = pct(a.lum, 0.05), p50 = pct(a.lum, 0.5), p95 = pct(a.lum, 0.95);
        let s2 = 0; for (const v of a.lum) s2 += (v - mean) * (v - mean);
        return {
          n: a.n, mean: +mean.toFixed(1), sd: +Math.sqrt(s2 / a.n).toFixed(1),
          p05: +p05.toFixed(1), p50: +p50.toFixed(1), p95: +p95.toFixed(1),
          contrast: +((p95 - p05) / Math.max(mean, 1)).toFixed(3),
          BR: +((a.b / a.n) / Math.max(a.r / a.n, 1)).toFixed(3),
          rgb: [Math.round(a.r / a.n), Math.round(a.g / a.n), Math.round(a.b / a.n)],
        };
      }

      const bands = {};
      BANDS.forEach((b, i) => {
        const st = stat(acc[i]);
        if (st) { st.rows = [acc[i].ymin, acc[i].ymax]; bands[b[0]] = st; }
      });
      const skyStat = stat(sky);

      // ---- THE headline number -------------------------------------------
      // lit vs shaded faces of the 2.5-6 km ridges, display luminance.
      const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
      const mLit = mean(face.lit), mShade = mean(face.shade);
      const ridge = {
        nLit: face.lit.length, nShade: face.shade.length,
        lit: +mLit.toFixed(1), shade: +mShade.toFixed(1),
        litP50: +pct(face.lit, 0.5).toFixed(1), shadeP50: +pct(face.shade, 0.5).toFixed(1),
        // (lit - shade) / lit  ->  "internal luminance variation"
        variation: +((mLit - mShade) / Math.max(mLit, 1)).toFixed(3),
        ratio: +(mLit / Math.max(mShade, 1)).toFixed(3),
        byRange: faceBy.map((q) => {
          const a = mean(q[2]), b = mean(q[3]);
          return { km: `${q[0] / 1000}-${q[1] / 1000}`, lit: +a.toFixed(1), shade: +b.toFixed(1), nLit: q[2].length, nShade: q[3].length, variation: +((a - b) / Math.max(a, 1)).toFixed(3) };
        }),
        litRGB: face.lit.length ? face.litRGB.map((v) => Math.round(v / face.lit.length)) : null,
        shadeRGB: face.shade.length ? face.shadeRGB.map((v) => Math.round(v / face.shade.length)) : null,
      };

      // ---- horizon scan: largest vertical luminance jump per column, in the
      // rows where terrain distance crosses 5 km or goes to sky ------------
      const gh = Math.ceil(h / STRIDE);
      let worst = { jump: 0, x: -1, y: -1 };
      const jumps = [];
      for (let gx = 0; gx < gw; gx++) {
        for (let gy = 1; gy < gh; gy++) {
          const x = gx * STRIDE, y0 = (gy - 1) * STRIDE, y1 = gy * STRIDE;
          const c0 = px(x, y0), c1 = px(x, y1);
          const L0 = 0.2126 * c0[0] + 0.7152 * c0[1] + 0.0722 * c0[2];
          const L1 = 0.2126 * c1[0] + 0.7152 * c1[1] + 0.0722 * c1[2];
          const t0 = dmap[(gy - 1) * gw + gx], t1 = dmap[gy * gw + gx];
          // only care about far/sky boundaries
          if (t0 > 2500 && t1 > 2500) {
            const j = Math.abs(L1 - L0);
            if (j > worst.jump) worst = { jump: +j.toFixed(1), x, y: y1, t0: +t0.toFixed(0), t1: +t1.toFixed(0), L0: +L0.toFixed(1), L1: +L1.toFixed(1) };
            if (j > 8) jumps.push({ x, y: y1, j: +j.toFixed(1), t0: +t0.toFixed(0), t1: +t1.toFixed(0) });
          }
        }
      }
      // Is the biggest set of jumps aligned on one row? (a hard horizontal band)
      const rowHist = {};
      for (const j of jumps) rowHist[j.y] = (rowHist[j.y] || 0) + 1;
      const topRows = Object.entries(rowHist).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([y, n]) => ({ y: +y, cols: n }));

      // ---- silhouette test: is the far ridge still darker than the sky? ----
      // For every column, find the topmost terrain hit beyond 2.5 km and compare
      // it with the sky 3 grid rows above it.
      const sil = { n: 0, ridge: 0, sky: 0, inverted: 0, dmin: 1e9 };
      for (let gx = 0; gx < gw; gx++) {
        for (let gy = 2; gy < gh; gy++) {
          const t = dmap[gy * gw + gx];
          if (t > 2500 && dmap[(gy - 1) * gw + gx] < 0) {
            const x = gx * STRIDE;
            const cR = px(x, gy * STRIDE + STRIDE);       // just inside the ridge
            const cS = px(x, Math.max(0, (gy - 3) * STRIDE)); // sky above it
            const LR = 0.2126 * cR[0] + 0.7152 * cR[1] + 0.0722 * cR[2];
            const LS = 0.2126 * cS[0] + 0.7152 * cS[1] + 0.0722 * cS[2];
            sil.n++; sil.ridge += LR; sil.sky += LS;
            if (LR >= LS) sil.inverted++;
            if (LS - LR < sil.dmin) sil.dmin = LS - LR;
            break;
          }
        }
      }
      const silhouette = sil.n ? {
        n: sil.n, ridge: +(sil.ridge / sil.n).toFixed(1), sky: +(sil.sky / sil.n).toFixed(1),
        gap: +((sil.sky - sil.ridge) / sil.n).toFixed(1),
        invertedCols: sil.inverted, minGap: +sil.dmin.toFixed(1),
      } : null;

      // ---- horizon strip (the map-edge plain) ------------------------------
      let sx0 = 1e9, sx1 = -1e9, sy0 = 1e9, sy1 = -1e9, sn = 0;
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
        if (dmap[gy * gw + gx] > 6000) {
          sn++;
          if (gx * STRIDE < sx0) sx0 = gx * STRIDE; if (gx * STRIDE > sx1) sx1 = gx * STRIDE;
          if (gy * STRIDE < sy0) sy0 = gy * STRIDE; if (gy * STRIDE > sy1) sy1 = gy * STRIDE;
        }
      }
      // where in the world is that strip? (is it the map-edge taper plain?)
      const stripPts = [];
      for (let gy = 0; gy < gh && stripPts.length < 6; gy++) {
        for (let gx = 0; gx < gw && stripPts.length < 6; gx++) {
          const t = dmap[gy * gw + gx];
          if (t > 6000) {
            const ndcx = (gx * STRIDE + 0.5) / w * 2 - 1;
            const ndcy = 1 - (gy * STRIDE + 0.5) / h * 2;
            const d = rayDir(ndcx, ndcy);
            const hx = camPos[0] + d[0] * t, hz = camPos[2] + d[2] * t;
            stripPts.push({ px: [gx * STRIDE, gy * STRIDE], d: +t.toFixed(0), x: +hx.toFixed(0), z: +hz.toFixed(0), y: +terrain.height(hx, hz).toFixed(1) });
          }
        }
      }
      const strip = sn ? { n: sn, x: [sx0, sx1], y: [sy0, sy1], pts: stripPts } : null;

      // ---- clear-sky luminance profile vs elevation -------------------------
      // Clouds are brighter than clear sky, so the 10th percentile in each
      // elevation bin is the clear sky. Compared against the reference photos
      // this is the "is the low sky milky?" test.
      const binN = 9, bins = [];
      for (let i = 0; i < binN; i++) bins.push([]);
      for (let y = 0; y < h; y += STRIDE) {
        for (let x = 0; x < w; x += STRIDE * 2) {
          if (dmap[(y / STRIDE | 0) * gw + (x / STRIDE | 0)] >= 0) continue;
          const ndcx = (x + 0.5) / w * 2 - 1, ndcy = 1 - (y + 0.5) / h * 2;
          const d = rayDir(ndcx, ndcy);
          const el = Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180 / Math.PI;
          const bi = Math.floor(el / 6);
          if (bi < 0 || bi >= binN) continue;
          const c = px(x, y);
          bins[bi].push([0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], c[2] / Math.max(c[0], 1)]);
        }
      }
      const skyProfile = bins.map((b, i) => {
        if (b.length < 8) return null;
        b.sort((p, q) => p[0] - q[0]);
        const k = Math.floor(b.length * 0.10);
        return { el: i * 6 + 3, n: b.length, clearL: +b[k][0].toFixed(1), clearBR: +b[k][1].toFixed(2) };
      }).filter(Boolean);
      const skyModel = [1, 3, 6, 10, 20, 35, 60, 88].map((e) => {
        const c = skyMod0.sampleSky(e, Math.PI * 0.5);
        const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        return { el: e, lin: +L.toFixed(3), BR: +(c[2] / Math.max(c[0], 1e-6)).toFixed(2) };
      });

      // ---- fog model self-report ------------------------------------------
      const skyMod = D.sky;
      const P = skyMod.params;
      const su = terrain.snowUniforms;
      const Hs = su.uAerialHeight.value, dens = su.uAerialDensity.value;
      const camY = camPos[1];
      const model = [];
      for (const dd of [500, 1000, 2000, 3000, 4000, 5000, 7000]) {
        // horizontal-ish ray at the same altitude as the camera
        const e0 = Math.exp(-Math.max(camY, -200) / Hs);
        const t = dd * e0;
        model.push({ d: dd, terrainF: +(1 - Math.exp(-dens * t)).toFixed(3) });
      }
      return {
        camPos: camPos.map((v) => +v.toFixed(1)),
        bands, sky: skyStat, ridge, silhouette, strip, worstJump: worst, topRows,
        params: { aerialDensity: P.aerialDensity, fogDensity: P.fogDensity, fogHeight: P.fogHeight },
        terrainAP: { density: dens, height: Hs, color: su.uAerialColor.value.toArray().map((v) => +v.toFixed(3)) },
        haze: JSON.parse(JSON.stringify(skyMod.hazeInfo)), skyProfile, skyModel,
        model,
      };
    }, 8);

    out[name + (combo ? ' ' + JSON.stringify(combo) : '')] = res;
    const b = res.bands;
    console.log(`\n=== ${name}   cam y=${res.camPos[1]}${combo ? '   ' + JSON.stringify(combo) : ''}`);
    for (const k of Object.keys(b)) {
      const s = b[k];
      console.log(`  ${k.padEnd(14)} n=${String(s.n).padStart(5)}  mean=${String(s.mean).padStart(5)} sd=${String(s.sd).padStart(5)} p05=${String(s.p05).padStart(5)} p95=${String(s.p95).padStart(5)}  contrast=${s.contrast.toFixed(3)}  B/R=${s.BR}  rgb=${s.rgb.join(',')} rows=${s.rows.join('-')}`);
    }
    if (res.sky) console.log(`  ${'SKY'.padEnd(14)} n=${String(res.sky.n).padStart(5)}  mean=${String(res.sky.mean).padStart(5)} sd=${String(res.sky.sd).padStart(5)} p05=${String(res.sky.p05).padStart(5)} p95=${String(res.sky.p95).padStart(5)}  B/R=${res.sky.BR}  rgb=${res.sky.rgb.join(',')}`);
    const r = res.ridge;
    console.log(`  >> RIDGE 2.5-6km  lit(n=${r.nLit})=${r.lit} rgb=${r.litRGB}   shaded(n=${r.nShade})=${r.shade} rgb=${r.shadeRGB}`);
    console.log(`  >> internal luminance variation = ${(r.variation * 100).toFixed(1)}%   lit/shade = ${r.ratio}`);
    console.log(`  >> by range: ${r.byRange.map((q) => `${q.km}km lit=${q.lit} shade=${q.shade} var=${(q.variation * 100).toFixed(1)}% (n=${q.nLit}/${q.nShade})`).join('   ')}`);
    if (res.silhouette) console.log(`  >> SILHOUETTE cols=${res.silhouette.n} ridge=${res.silhouette.ridge} sky=${res.silhouette.sky} gap=${res.silhouette.gap} minGap=${res.silhouette.minGap} invertedCols=${res.silhouette.invertedCols}`);
    console.log(`  >6km horizon strip: ${JSON.stringify(res.strip)}`);
    console.log(`  worst far/sky vertical jump: ${JSON.stringify(res.worstJump)}`);
    console.log(`  rows with most >8-code jumps: ${JSON.stringify(res.topRows)}`);
    console.log(`  terrain AP: dens=${res.terrainAP.density.toExponential(3)} H=${res.terrainAP.height} col=${res.terrainAP.color.join(',')}`);
    console.log(`  terrain fog fraction vs distance: ${res.model.map((m) => `${m.d}m:${m.terrainF}`).join('  ')}`);
    console.log(`  clear-sky rendered profile: ${res.skyProfile.map((p) => `${p.el}deg:L${p.clearL}/BR${p.clearBR}`).join('  ')}`);
    console.log(`  sky model (linear, pre-expo): ${res.skyModel.map((p) => `${p.el}deg:${p.lin}/BR${p.BR}`).join('  ')}`);
    console.log(`  hazeInfo: coolLum=${res.haze.coolLum.toFixed(3)} skyRidgeLum=${res.haze.skyRidgeLum.toFixed(3)} clampedMask=${res.haze.clamped} cool=${res.haze.cool.map((v)=>v.toFixed(3)).join(',')} raw=${res.haze.coolRaw.map((v)=>v.toFixed(3)).join(',')}`);
    }
  }
} catch (e) {
  errors.push('probe: ' + (e?.message ?? String(e)));
  code = 1;
} finally {
  if (errors.length) { code = 1; console.error('--- errors ---'); errors.slice(0, 20).forEach((e) => console.error('  ' + e)); }
  if (OUTJSON) await fs.writeFile(path.resolve(ROOT, OUTJSON), JSON.stringify(out, null, 2));
  await browser.close();
  await server.close();
  process.exit(code);
}
