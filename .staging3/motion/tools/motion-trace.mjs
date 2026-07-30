/**
 * Alpine — motion / physics numeric probe.
 *
 *   node tools/motion-trace.mjs              # full report
 *   node tools/motion-trace.mjs --only slope
 *
 * Boots the same vite + headless-chrome harness tools/shoot.mjs uses, then drives
 * window.__harness with scripted input and prints numbers. No screenshots.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const want = (n) => !ONLY.length || ONLY.includes(n);

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
await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

let code = 0;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await page.evaluate(() => window.__setAuto?.(false));

  const SPOTS = {
    hero:    [0, 700, Math.PI],
    ridge:   [-260, 300, Math.PI * 0.86],
    trees:   [180, 120, Math.PI * 1.1],
    steep:   [-40, -260, Math.PI],
    closeup: [60, 480, Math.PI * 0.95],
  };

  // ---------------------------------------------------------------- slopes --
  if (want('slope')) {
    const rows = await page.evaluate((SPOTS) => {
      const T = window.__harness.debug.terrain;
      const THREE_up = { x: 0, y: 1, z: 0 };
      const out = [];
      for (const [name, [x, z]] of Object.entries(SPOTS)) {
        const line = { name, x, z, h: +T.height(x, z).toFixed(1) };
        for (const e of [null, 1.6, 2.2, 6, 20]) {
          const n = e === null ? T.normal(x, z) : T.normal(x, z, e);
          const deg = Math.acos(Math.min(1, Math.max(-1, n.y))) * 180 / Math.PI;
          line['deg@' + (e === null ? 'analytic' : e)] = +deg.toFixed(2);
        }
        // fall-line drop measured over 60 m of ground distance (true macro pitch)
        const n = T.normal(x, z, 20);
        const len = Math.hypot(n.x, n.z) || 1e-6;
        const dx = n.x / len, dz = n.z / len;
        const drop = T.height(x, z) - T.height(x + dx * 60, z + dz * 60);
        line.macro60 = +(Math.atan2(drop, 60) * 180 / Math.PI).toFixed(2);
        // micro roughness: rms deviation of normal over 1 m samples
        let acc = 0, k = 0;
        for (let i = 0; i < 24; i++) {
          const a = i / 24 * Math.PI * 2;
          const m = T.normal(x + Math.cos(a) * 1.0, z + Math.sin(a) * 1.0, 1.6);
          acc += Math.acos(Math.min(1, Math.max(-1, m.x * n.x + m.y * n.y + m.z * n.z))) ** 2; k++;
        }
        line.nJitterDeg = +(Math.sqrt(acc / k) * 180 / Math.PI).toFixed(2);
        out.push(line);
      }
      return out;
    }, SPOTS);
    console.log('\n=== terrain slope at each framing ===');
    console.table(rows);
  }


  // ------------------------------------------------------- heading vs fall --
  if (want('fall')) {
    const rows = await page.evaluate((SPOTS) => {
      const T = window.__harness.debug.terrain;
      const out = [];
      for (const [name, [x, z, hd]] of Object.entries(SPOTS)) {
        const fx = -Math.sin(hd), fz = -Math.cos(hd);
        const n = T.normal(x, z, 6);
        const len = Math.hypot(n.x, n.z) || 1e-6;
        const dx = n.x / len, dz = n.z / len;          // downhill unit (xz)
        const dot = fx * dx + fz * dz;
        out.push({
          name, headingDeg: +(hd * 180 / Math.PI).toFixed(1),
          fwd: `${fx.toFixed(2)},${fz.toFixed(2)}`,
          downhill: `${dx.toFixed(2)},${dz.toFixed(2)}`,
          'fwd.downhill': +dot.toFixed(3),
          angleOffFallLine: +(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI).toFixed(1),
          dropAhead40m: +(T.height(x + fx * 40, z + fz * 40) - T.height(x, z)).toFixed(1),
        });
      }
      return out;
    }, SPOTS);
    console.log('\n=== canonical heading vs. fall line (dropAhead40m < 0 means downhill) ===');
    console.table(rows);
  }


  // ------------------------------------------------------ camera framing -----
  if (want('frame')) {
    const rows = await page.evaluate(async (SPOTS) => {
      const H = window.__harness, S = H.state;
      const out = [];
      window.__inputOverride = { steer: 0, crouch: 0, brake: 0, jump: false };
      for (const [name, [x, z, hd]] of Object.entries(SPOTS)) {
        H.setPlayer(x, z, hd);
        for (let i = 0; i < 100; i++) H.step(1 / 60, 1);
        const c = H.debug.camera, d = window.__camDebug;
        // where is the rider in the frame? project his position
        const v = S.pos.clone(); v.y += 0.9;
        v.project(c);
        out.push({ name, spd: +S.speed.toFixed(1), fov: +d.fov.toFixed(1),
          dist: +d.dist.toFixed(2), camY: +(c.position.y - S.pos.y).toFixed(2),
          aimDeg: +d.aimDeg.toFixed(1), rollDeg: +(d.roll * 180 / Math.PI).toFixed(1),
          lat: +d.lat.toFixed(2), susp: +d.susp.toFixed(2),
          screenX: +v.x.toFixed(2), screenY: +v.y.toFixed(2) });
      }
      window.__inputOverride = null;
      return out;
    }, SPOTS);
    console.log('\n=== camera framing at each canonical shot (screenX/Y: 0 = dead centre) ===');
    console.table(rows);
  }

  // ------------------------------------------------------- coast (no input) --
  if (want('coast')) {
    console.log('\n=== coast, ZERO input, 12 s ===');
    for (const [name, [x, z, hd]] of Object.entries(SPOTS)) {
      const tr = await page.evaluate(async ({ x, z, hd }) => {
        window.__inputOverride = { steer: 0, crouch: 0, brake: 0, jump: false };
        const H = window.__harness, S = H.state;
        H.setPlayer(x, z, hd);
        const out = [];
        const G = 11.0;
        let e0 = 0.5 * S.vel.lengthSq() + G * S.pos.y;
        for (let i = 0; i < 12 * 60; i++) {
          H.step(1 / 60, 1);
          if (i % 60 === 59) {
            const e = 0.5 * S.vel.lengthSq() + G * S.pos.y;
            out.push({
              t: +((i + 1) / 60).toFixed(1),
              spd: +S.speed.toFixed(2),
              deg: +(Math.acos(Math.min(1, S.groundNormal.y)) * 180 / Math.PI).toFixed(1),
              air: S.airborne ? 1 : 0,
              edge: +S.edge.toFixed(3),
              slip: +(S.motion?.slip ?? 0).toFixed(2),
              aLat: +(S.motion?.aLat ?? 0).toFixed(2),
              dEdt: +((e - e0)).toFixed(1),
            });
            e0 = e;
          }
        }
        window.__inputOverride = null;
        return out;
      }, { x, z, hd });
      const last = tr[tr.length - 1];
      console.log(`-- ${name}: after 12 s  speed=${last.spd} m/s (${(last.spd * 3.6).toFixed(0)} km/h)  slope=${last.deg} deg`);
      console.log('   ' + tr.map((r) => r.spd).join(' '));
      console.log('   slip ' + tr.map((r) => r.slip).join(' '));
    }
  }

  // ------------------------------------------------- carve / skid / stop -----
  if (want('drills')) {
    console.log('\n=== drills (2.5 s run-up from the reset, then 4 s of input), closeup pitch ===');
    const drills = {
      'straight     ': { steer: 0, brake: 0 },
      'tuck         ': { steer: 0, brake: 0, crouch: 1 },
      'carve 0.5    ': { steer: 0.5, brake: 0 },
      'carve 0.8    ': { steer: 0.8, brake: 0 },
      'linked S 0.6 ': { steer: 0.6, brake: 0, link: 1.6 },
      'linked S 0.4 ': { steer: 0.4, brake: 0, link: 2.2 },
      'skid (brake) ': { steer: 0.5, brake: 0.55 },
      'hockey stop  ': { steer: 1, brake: 1 },
    };
    for (const [name, inp] of Object.entries(drills)) {
      const r = await page.evaluate(async ({ inp }) => {
        const H = window.__harness, S = H.state;
        window.__inputOverride = { steer: 0, crouch: inp.crouch || 0, brake: 0, jump: false };
        H.setPlayer(60, 480, Math.PI * 0.95);
        for (let i = 0; i < 150; i++) H.step(1 / 60, 1);
        const v0 = S.speed;
        const samples = [];
        let minR = Infinity, slipAcc = 0, slipN = 0, maxG = 0, airFrames = 0, carveFrames = 0;
        for (let i = 0; i < 60 * 4; i++) {
          const dir = inp.link ? (Math.floor(i / 60 / inp.link) % 2 ? -1 : 1) : 1;
          window.__inputOverride = { steer: inp.steer * dir, crouch: inp.crouch || 0, brake: inp.brake, jump: false };
          H.step(1 / 60, 1);
          if (i > 30) {
            minR = Math.min(minR, S.motion.turnRadius);
            slipAcc += Math.abs(S.motion.slipAngle); slipN++;
            maxG = Math.max(maxG, S.gForce);
            if (!H.debug.physics.grounded) airFrames++;
            if (S.carving) carveFrames++;
          }
          if (i % 60 === 59) samples.push(+S.speed.toFixed(1));
        }
        window.__inputOverride = null;
        return { v0: +v0.toFixed(2), v: samples, minR: +Math.min(999, minR).toFixed(1),
                 slip: +(slipAcc / slipN * 180 / Math.PI).toFixed(1), maxG: +maxG.toFixed(2),
                 air: +(airFrames / 210 * 100).toFixed(0), carve: +(carveFrames / 210 * 100).toFixed(0) };
      }, { inp });
      console.log(`${name} v0=${String(r.v0).padStart(6)} -> ${r.v.join(' ').padEnd(22)} Rmin=${String(r.minR).padStart(5)}m  slip=${String(r.slip).padStart(5)}deg  gMax=${r.maxG}  air=${r.air}%  carving=${r.carve}%`);
    }
  }

  // --------------------------------------------------- carve step response --
  if (want('carve')) {
    console.log('\n=== carve step response (steer 0 -> 0.55 at t=0), hero ===');
    const rows = await page.evaluate(async () => {
      const H = window.__harness, S = H.state;
      window.__inputOverride = { steer: 0, crouch: 0, brake: 0, jump: false };
      H.setPlayer(0, 700, Math.PI);
      for (let i = 0; i < 60 * 8; i++) H.step(1 / 60, 1);
      window.__inputOverride = { steer: 0.55, crouch: 0, brake: 0, jump: false };
      const out = [];
      for (let i = 0; i < 120; i++) {
        H.step(1 / 60, 1);
        if (i % 6 === 0) out.push({
          t: +(i / 60).toFixed(2), spd: +S.speed.toFixed(2),
          edge: +S.edge.toFixed(2), omega: +S.motion.yawRate.toFixed(3),
          R: +Math.min(999, S.motion.turnRadius).toFixed(1),
          slip: +S.motion.slip.toFixed(2),
          slipDeg: +(S.motion.slipAngle * 180 / Math.PI).toFixed(1),
          aLat: +S.motion.aLat.toFixed(2), g: +S.gForce.toFixed(2),
          carving: S.carving ? 1 : 0,
        });
      }
      window.__inputOverride = null;
      return out;
    });
    console.table(rows);
  }

  // ------------------------------------------------------------- camera ------
  if (want('cam')) {
    console.log('\n=== camera response through a scripted run (closeup pitch) ===');
    const r = await page.evaluate(async () => {
      const H = window.__harness, S = H.state;
      const log = [];
      const snap = (phase) => {
        const d = window.__camDebug, c = H.debug.camera;
        const v = S.pos.clone(); v.y += 0.9; v.project(c);
        log.push({ phase, spd: +S.speed.toFixed(1), fov: +d.fov.toFixed(1),
          boom: +d.dist.toFixed(2), rollDeg: +(d.roll * 180 / Math.PI).toFixed(1),
          yawLagDeg: +(d.yawLag * 180 / Math.PI).toFixed(1),
          aimDeg: +d.aimDeg.toFixed(1), shake: +d.shake.toFixed(3),
          kick: +d.kick.toFixed(2), screenX: +v.x.toFixed(2), screenY: +v.y.toFixed(2) });
      };
      const drive = (inp, n) => { window.__inputOverride = inp; for (let i = 0; i < n; i++) H.step(1 / 60, 1); };
      H.setPlayer(60, 480, Math.PI * 0.95);
      drive({ steer: 0, crouch: 0, brake: 0, jump: false }, 180); snap('cruise');
      drive({ steer: 0, crouch: 1, brake: 0, jump: false }, 150); snap('tuck');
      drive({ steer: 0.9, crouch: 0, brake: 0, jump: false }, 45); snap('turn-in');
      drive({ steer: 0.9, crouch: 0, brake: 0, jump: false }, 60); snap('mid-carve');
      drive({ steer: 0, crouch: 0, brake: 0, jump: false }, 45); snap('exit');
      drive({ steer: 0, crouch: 0, brake: 0, jump: true }, 24);
      drive({ steer: 0, crouch: 0, brake: 0, jump: false }, 22); snap('airborne');
      drive({ steer: 0, crouch: 0, brake: 0, jump: false }, 12); snap('landing');
      drive({ steer: 0, crouch: 0, brake: 1, jump: false }, 60); snap('braking');
      window.__inputOverride = null;
      return log;
    });
    console.table(r);
  }

  // ------------------------------------------------------------- rig ---------
  if (want('rig')) {
    const r = await page.evaluate(() => {
      const out = [];
      const g = window.__harness.debug.skier;
      const root = g.group || g.root || g.mesh || g.object3D;
      if (!root) return [{ note: 'no root on skier handle', keys: Object.keys(g).join(',') }];
      root.updateWorldMatrix(true, true);
      root.traverse((o) => {
        if (!o.geometry) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox;
        const sc = o.getWorldScale(new (o.position.constructor)());
        out.push({ name: o.name || o.type, x: +((b.max.x - b.min.x) * sc.x).toFixed(2),
          y: +((b.max.y - b.min.y) * sc.y).toFixed(2), z: +((b.max.z - b.min.z) * sc.z).toFixed(2) });
      });
      return out.filter((o) => Math.max(o.x, o.y, o.z) > 1.2).slice(0, 20);
    });
    console.log('\n=== skier rig parts larger than 1.2 m (world scale) ===');
    console.table(r);
  }

} catch (e) {
  errors.push('probe: ' + (e?.message ?? String(e)));
  code = 1;
} finally {
  if (errors.length) { code = 1; console.error('\n--- errors ---'); for (const e of errors.slice(0, 20)) console.error('  ' + e); }
  await browser.close();
  await server.close();
  process.exit(code);
}
