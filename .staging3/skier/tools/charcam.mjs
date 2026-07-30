/**
 * charcam — character-art review rig for the skier.
 *
 *   node tools/charcam.mjs --out shots/char
 *   node tools/charcam.mjs --out shots/char --only glide,carve
 *
 * Poses the rig via window.__skierPose, parks a tight portrait camera on the
 * skier from several angles, and dumps a measurement JSON alongside the PNGs.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const OUT = path.resolve(ROOT, arg('out', 'shots/char'));
const W = +arg('w', 900), H = +arg('h', 1100);
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);

// pose = __skierPose overrides; cam = [azimuth deg from behind, elev deg, dist m, aimY m]
const VIEWS = {
  glide:   { pose: { edge: 0.04, crouch: 0.05, airborne: false }, cam: [26, 6, 4.4, 1.05], fov: 26 },
  carve:   { pose: { edge: 0.85, crouch: 0.25, airborne: false, gForce: 2.0 }, cam: [58, 4, 4.6, 1.0], fov: 26 },
  tuck:    { pose: { edge: 0.05, crouch: 0.95, airborne: false }, cam: [40, 8, 4.2, 0.85], fov: 26 },
  air:     { pose: { edge: 0.2, crouch: 0.2, airborne: true }, cam: [34, -2, 4.6, 1.2], fov: 26 },
  front:   { pose: { edge: 0.3, crouch: 0.15, airborne: false, gForce: 1.2 }, cam: [155, 4, 4.4, 1.1], fov: 26 },
  bust:    { pose: { edge: 0.35, crouch: 0.1, airborne: false, gForce: 1.4 }, cam: [140, 8, 2.0, 1.42], fov: 22 },
  boots:   { pose: { edge: 0.55, crouch: 0.3, airborne: false, gForce: 1.6 }, cam: [70, 12, 2.0, 0.35], fov: 24 },
  face:    { pose: { edge: 0.15, crouch: 0.1, airborne: false, gForce: 0.8 }, cam: [12, 10, 1.6, 1.46], fov: 22 },
  torso:   { pose: { edge: 0.15, crouch: 0.1, airborne: false, gForce: 0.8 }, cam: [22, 4, 2.4, 1.15], fov: 26 },
};

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 5211, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 180000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('console: ' + m.text()); });

await fs.mkdir(OUT, { recursive: true });
let exitCode = 0;
const report = { views: [] };

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => { document.getElementById('hud')?.style.setProperty('display', 'none'); });

  const names = ONLY.length ? ONLY : Object.keys(VIEWS);
  for (const name of names) {
    const v = VIEWS[name];
    if (!v) { errors.push('unknown view ' + name); exitCode = 1; continue; }
    await page.evaluate(() => window.__setAuto?.(false));
    await page.evaluate((v) => {
      window.__skierPose = null;
      window.__harness.setPlayer(60, 480, Math.PI * 0.95);
      window.__harness.step(1 / 60, 90);
      window.__skierPose = v.pose;
      window.__harness.step(1 / 60, 40);
    }, v);

    const m = await page.evaluate((v) => {
      const H = window.__harness, d = H.debug, T = window.THREE_NS;
      const cam = d.camera;
      const g = d.skier.group;
      const p = g.position.clone();
      const hd = H.state.heading;
      const [az, el, dist, aimY] = v.cam;
      const a = hd + Math.PI + (az * Math.PI / 180);
      const er = el * Math.PI / 180;
      const off = {
        x: Math.sin(a) * Math.cos(er) * dist,
        y: Math.sin(er) * dist,
        z: Math.cos(a) * Math.cos(er) * dist,
      };
      // aim point: aimY above the contact point, along the rig's own up
      const up = g.up.clone();
      const aim = p.clone();
      const q = g.quaternion.clone();
      aim.add(new (p.constructor)(0, aimY, 0).applyQuaternion(q));
      cam.position.set(p.x + off.x, p.y + off.y + aimY * 0.6, p.z + off.z);
      cam.fov = v.fov; cam.updateProjectionMatrix();
      cam.lookAt(aim);
      cam.updateMatrixWorld(true);
      d.postfx.render(1 / 60);
      return window.__skier ? window.__skier.measure() : null;
    }, v);

    for (let i = 0; i < 6; i++) {
      await page.evaluate((v) => {
        const d = window.__harness.debug;
        d.postfx.render(1 / 60);
      }, v);
      await new Promise((r) => setTimeout(r, 30));
    }

    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    report.views.push({ name, measure: m });
    console.log(`✓ ${name.padEnd(8)} ${path.relative(ROOT, file)}`);
  }
  await page.evaluate(() => { window.__skierPose = null; });
} catch (e) {
  errors.push('charcam: ' + (e?.message ?? String(e)));
  exitCode = 1;
} finally {
  if (errors.length) { exitCode = 1; console.error('--- errors ---'); for (const e of errors.slice(0, 30)) console.error('  ' + e); }
  await fs.writeFile(path.join(OUT, 'measure.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
  process.exit(exitCode);
}
