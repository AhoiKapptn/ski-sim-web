/**
 * Capture harness for src/world/branding.js.
 *
 *   node tools/brand-shot.mjs --out shots/brand [--dpr 2] [--only hero,b0,b1]
 *
 * branding.js is not wired into main.js (the branding agent does not own that
 * file), so this tool installs it the same way main.js will: it dynamically
 * imports the module in the page and constructs it against
 * `__harness.debug.{scene, terrain, scatter}`. Everything else — the Vite
 * server, the Chrome flags, the error gating, the canonical framings — is
 * shoot.mjs' behaviour, so a shot from here is comparable with one from there.
 *
 * On top of the framings it reports, for each placed object:
 *   * its projected screen rect, so a crop can be verified to CONTAIN the thing
 *     it claims to measure (CLAUDE.md trap 4),
 *   * true per-frame draw calls with `renderer.info.autoReset = false`
 *     (trap 6 — the naive read is 1),
 * and writes the branding atlas out as `atlas.png` so the procedurally
 * composited panels can be A/B'd against the original artwork.
 *
 * Exits non-zero on console errors, a blank frame, if the real PNGs did not load
 * (a screenshot of the fallback letterforms must never be mistaken for a
 * screenshot of the brand), or if the module was renderable BEFORE its artwork
 * was composited — which is the same failure one step earlier, and the only
 * thing standing between a future main.js and a whole directory of shots that
 * quietly contain the stand-in letterforms.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const flag = (k) => argv.includes('--' + k);

const OUT = path.resolve(ROOT, arg('out', 'shots/brand'));
const W = +arg('w', 1600), H = +arg('h', 900);
const DPR = +arg('dpr', 1);
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const NOBRAND = flag('nobrand');   // A/B: same framings with the module absent
// --fallback blocks the two brand PNGs, which is the only way to exercise the
// procedural fallback letterforms and to prove that a failed load degrades to a
// plausible board rather than to a blank white panel or an exception.
const FALLBACK = flag('fallback');
// --noseam constructs the module with scatter withheld, which is the only way to
// exercise the two standalone paths: the formula centreline and the local
// radiance estimate. Both are otherwise dead code, and dead code that has never
// run is not a fallback.
const NOSEAM = flag('noseam');

// Canonical framings, byte-identical to shoot.mjs, plus one per placed object
// (added at runtime from the module's own item list).
const SHOTS = {
  hero: { x: 0, z: 700, heading: Math.PI, settle: 90 },
  ridge: { x: -260, z: 300, heading: Math.PI * 0.86, settle: 120 },
  closeup: { x: 60, z: 480, heading: Math.PI * 0.95, settle: 60 },
};

const server = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error',
  server: { port: 5201, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: true,
  // 300 s, not 180: at --dpr 2 the drawing buffer is 3200x1800 and
  // Page.captureScreenshot on this ANGLE/Metal path took longer than 180 s to
  // return, so every DPR-2 run died in the harness rather than in the render.
  // The DPR-2 shots are the only ones where the print resolves, so this matters.
  protocolTimeout: 300000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const ignorable = (u = '') => /favicon|\.ico($|\?)/i.test(u) || (FALLBACK && /\/brand\//.test(u));
if (FALLBACK) {
  await page.setRequestInterception(true);
  page.on('request', (r) => (/\/brand\//.test(r.url()) ? r.abort() : r.continue()));
}
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !ignorable(m.location()?.url) && !/favicon/i.test(t)) errors.push('console: ' + t);
});
page.on('requestfailed', (r) => { if (!ignorable(r.url())) errors.push('requestfailed: ' + r.url() + ' ' + r.failure()?.errorText); });

await fs.mkdir(OUT, { recursive: true });
let exitCode = 0;
const report = { url, viewport: [W, H], dpr: DPR, nobrand: NOBRAND, shots: [], errors };

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));

  if (!NOBRAND) {
    // --- the wiring main.js will do, done from outside -----------------------
    const info = await page.evaluate(async (noseam) => {
      const m = await import('/src/world/branding.js');
      const h = window.__harness;
      const b = m.createBranding(h.debug.scene, h.debug.terrain, noseam ? null : h.debug.scatter);
      h.debug.branding = b;              // as main.js will expose it
      window.__brand = b;
      // The module must NOT be renderable before its artwork is composited, or a
      // capture can silently contain the fallback letterforms. Asserted here so
      // the guarantee is enforced by the tool and not just by the comment.
      const hiddenBeforeReady = b.group.visible === false;
      await b.ready;
      h.debug.renderer.info.autoReset = false;
      return {
        loaded: b.loaded, tris: b.debug.tris,
        gate: { hiddenBeforeReady, visibleAfterReady: b.group.visible === true },
        centreline: b.debug.centrelineCheck(),
        items: b.debug.items,
        // the ambient the panels are actually lit by, so the standalone estimate
        // can be checked against the one scatter hands over
        radiance: {
          bounce: b.debug.uniforms.uBounce.value.toArray().map((v) => +v.toFixed(4)),
          sky: b.debug.uniforms.uSkyFill.value.toArray().map((v) => +v.toFixed(4)),
        },
      };
    }, NOSEAM);
    report.branding = info;
    const cl = info.centreline;
    console.log(`   branding: ${info.loaded}, ${info.tris} tris, ${info.items.length} objects`);
    // --noseam withholds scatter, which makes `centre` the formula itself, so the
    // check compares the formula against the formula. It used to print
    // "worst 0.000 m" for that, which reads as a passing validation and is not
    // one. Say so instead.
    console.log(cl.validates
      ? `   centreline: reconstructed from the scatter seam, agrees with the documented`
        + ` formula to ${cl.worstErrM.toFixed(4)} m (worst at z ${cl.atZ}; recovered`
        + ` LIFT_OFFSET ${cl.liftOffset?.toFixed(2)})`
      : `   centreline: FORMULA FALLBACK — scatter was withheld, so there is nothing to`
        + ` compare against and this run validates no seam`);
    console.log(`   ambient: bounce ${info.radiance.bounce.join('/')}  sky ${info.radiance.sky.join('/')}`);
    console.log(`   ready gate: hidden before ready ${info.gate.hiddenBeforeReady}, `
      + `visible after ${info.gate.visibleAfterReady}`);
    const want = FALLBACK ? 'failed' : 'assets';
    if (info.loaded !== want) errors.push(`branding load state ${info.loaded}, expected ${want}`);
    if (!info.gate.hiddenBeforeReady) errors.push('branding was renderable before ready resolved — '
      + 'a capture can silently contain the fallback letterforms');
    if (!info.gate.visibleAfterReady) errors.push('branding never became visible after ready resolved');

    // atlas out, so the composited panels can be looked at directly
    const png = await page.evaluate(() => window.__brand.debug.canvas.toDataURL('image/png'));
    await fs.writeFile(path.join(OUT, 'atlas.png'), Buffer.from(png.split(',')[1], 'base64'));

    for (const it of info.items) {
      const nm = `${it.kind}-z${Math.round(it.z)}`;
      // Stand the player where they would really ski past it: on the corridor,
      // two thirds of the way out toward the object's own offset, ~23 m above it.
      // Two traps here, both of which produced framings with the subject off
      // screen on the first pass:
      //   * the centreline is NOT x = 0 (it wanders +-112 m), so the lateral
      //     position has to come from the item's own `cx`;
      //   * `step(1/60, settle)` SKIS. 80 settle frames at 15 m/s is 20 m of
      //     travel, which had already carried the camera past the subject before
      //     the shutter. So settle further uphill, then snap into the framing.
      SHOTS[nm] = { x: it.cx + it.off * 0.65, z: it.z + 26, settleZ: it.z + 50,
        heading: Math.PI, settle: 80 };
      // ...and one straight at the printed face from 4.5 m. Not a distance the
      // game is played at: this is the shot a reviewer needs to judge whether the
      // artwork itself is right, under the scene's own light. The chase cam owns
      // `camera`, so this drives it directly and renders through
      // `harness.stats()`, which is the one hook that presents a frame WITHOUT
      // running update() and having chaseCam snap the camera back.
      SHOTS[nm + '-face'] = { free: it, settleZ: it.z + 40, x: it.cx + it.off * 0.5,
        z: it.z + 26, heading: Math.PI, settle: 60 };
    }
  }

  report.drawingBuffer = await page.evaluate(() => {
    // trap 6: without this every per-frame counter reads the last fullscreen quad
    window.__harness.debug.renderer.info.autoReset = false;
    const c = window.__harness.debug.renderer.domElement;
    return [c.width, c.height];
  });
  console.log(`   ${W}x${H} @ dpr ${DPR} -> ${report.drawingBuffer.join('x')}`);

  const names = ONLY.length ? ONLY : Object.keys(SHOTS);
  for (const name of names) {
    const s = SHOTS[name];
    if (!s) { errors.push('unknown shot: ' + name); exitCode = 1; continue; }
    await page.evaluate(() => window.__setAuto?.(false));
    await page.evaluate((s) => {
      window.__harness.setPlayer(s.x, s.settleZ ?? s.z, s.heading);
      window.__harness.step(1 / 60, s.settle);
      if (s.settleZ) {                       // snap into the framing, then hold
        window.__harness.setPlayer(s.x, s.z, s.heading);
        window.__harness.step(1 / 60, 2);
      }
      window.__harness.debug.branding?.update(1 / 60, window.__harness.state);
    }, s);
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => window.__harness.step(1 / 60, 1));
      await new Promise((r) => setTimeout(r, 32));
    }
    // True per-frame draw calls. `info` is reset at the top of EVERY
    // renderer.render() and the post chain makes a dozen a frame, so this needs
    // autoReset = false (set above) and a reset immediately before one frame —
    // the naive read is 1. Taken before the free-camera pass because `step()`
    // runs update(), and update() lets chaseCam take the camera back.
    const calls = await page.evaluate(() => {
      const r = window.__harness.debug.renderer;
      r.info.reset();
      window.__harness.step(1 / 60, 1);
      return { calls: r.info.render.calls, tris: r.info.render.triangles };
    });

    let stats;
    if (s.free) {
      // park the camera 4.5 m off the printed face and present, repeatedly, so
      // the TAA history is built at THIS camera and not at the chase cam's
      for (let i = 0; i < 16; i++) {
        stats = await page.evaluate((it) => {
          const cam = window.__harness.debug.camera;
          const cy = it.y - it.h * 0.45;
          const camX = it.x + it.nx * 4.5, camZ = it.z + it.nz * 4.5;
          // The eye height has to be measured off the ground UNDER THE CAMERA,
          // not off the object's. Every panel here faces uphill, so the camera
          // stands 4.5 m up the fall line where the snow is ~1 m higher, and
          // `cy + 0.35` therefore buried the eye a metre INSIDE the slope: all
          // three -face shots came back with a corduroy wall across the
          // foreground and a view through the terrain's back faces. This is the
          // one framing whose whole purpose is judging the artwork, so it has to
          // be the one framing that is not compromised.
          const y = Math.max(cy + 0.35,
            window.__harness.debug.terrain.height(camX, camZ) + 1.6);
          cam.position.set(camX, y, camZ);
          cam.lookAt(it.x, cy, it.z);
          cam.updateMatrixWorld();
          return window.__harness.stats();   // presents WITHOUT running update()
        }, s.free);
        await new Promise((r) => setTimeout(r, 24));
      }
    } else {
      stats = await page.evaluate(() => window.__harness.stats());
    }
    // projected screen rect of every placed object, in CSS pixels
    const rects = NOBRAND ? [] : await page.evaluate(() => {
      const h = window.__harness, THREEcam = h.debug.camera;
      const items = h.debug.branding.debug.items;
      const w = h.debug.renderer.domElement.clientWidth || 1600;
      const ht = h.debug.renderer.domElement.clientHeight || 900;
      const out = [];
      for (const it of items) {
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, front = false;
        for (const dx of [-it.w / 2, it.w / 2]) {
          for (const dy of [-it.h, 0]) {
            for (const dz of [-0.2, 0.2]) {
              const p = { x: it.x + dx, y: it.y + dy, z: it.z + dz };
              // manual projection: view then projection matrix
              const e = THREEcam.matrixWorldInverse.elements;
              const vx = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
              const vy = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
              const vz = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
              const q = THREEcam.projectionMatrix.elements;
              const cx = q[0] * vx + q[4] * vy + q[8] * vz + q[12];
              const cy = q[1] * vx + q[5] * vy + q[9] * vz + q[13];
              const cw = q[3] * vx + q[7] * vy + q[11] * vz + q[15];
              if (cw <= 0) continue;
              front = true;
              const sx = (cx / cw * 0.5 + 0.5) * w, sy = (1 - (cy / cw * 0.5 + 0.5)) * ht;
              x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
              y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
            }
          }
        }
        if (!front) continue;
        const dist = Math.hypot(it.x - h.debug.camera.position.x, it.y - h.debug.camera.position.y,
          it.z - h.debug.camera.position.z);
        out.push({ kind: it.kind, z: Math.round(it.z), dist: +dist.toFixed(1),
          rect: [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)] });
      }
      return out;
    });

    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    const bad = stats.lost || stats.stddev < 2.0 || stats.mean < 3 || stats.mean > 252;
    if (bad) exitCode = 1;
    report.shots.push({ name, ...stats, blank: bad, calls, rects });
    const onScreen = rects.filter((r) => r.rect[0] < W && r.rect[0] + r.rect[2] > 0
      && r.rect[1] < H && r.rect[1] + r.rect[3] > 0);
    console.log(`${bad ? 'x' : 'ok'} ${name.padEnd(14)} mean=${stats.mean?.toFixed(1)} sd=${stats.stddev?.toFixed(1)} `
      + `calls=${calls.calls} | ` + (onScreen.map((r) => `${r.kind}@${r.dist}m ${r.rect[2]}x${r.rect[3]}px[${r.rect[0]},${r.rect[1]}]`).join('  ') || 'nothing on screen'));
  }
  if (!NOBRAND) {
    // After a shot has run, is the ambient the panels get the same one scatter's
    // buildings get? With the seam present they are literally the same uniform
    // objects; with --noseam this compares the local estimate against it.
    report.radianceCheck = await page.evaluate(() => {
      const b = window.__harness.debug.branding, s = window.__harness.debug.scatter;
      const f = (v) => v.toArray().map((x) => +x.toFixed(4));
      return {
        mine: { bounce: f(b.debug.uniforms.uBounce.value), sky: f(b.debug.uniforms.uSkyFill.value) },
        scatter: { bounce: f(s.uniforms.uBounce.value), sky: f(s.uniforms.uSkyFill.value) },
        shared: b.debug.uniforms.uBounce === s.uniforms.uBounce,
      };
    });
    const rc = report.radianceCheck;
    console.log(`   ambient: mine ${rc.mine.bounce.join('/')} | scatter ${rc.scatter.bounce.join('/')}`
      + ` | same uniform object: ${rc.shared}`);
  }
} catch (e) {
  errors.push('harness: ' + (e?.message ?? String(e)));
  exitCode = 1;
} finally {
  if (errors.length) {
    exitCode = 1;
    console.error('\n--- errors ---');
    for (const e of errors.slice(0, 40)) console.error('  ' + e);
  }
  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
  process.exit(exitCode);
}
