/**
 * Records the REAL distribution of the shared `state` over a scripted run, so
 * the HUD and audio can be tuned against numbers instead of guesses.
 *
 *   node tools/ux-trace.mjs [--seconds 30] [--json shots/ux/trace.json]
 *
 * No screenshots — this is a pure simulation trace, so it runs in a few seconds.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const SECONDS = +arg('seconds', 34);
const JSONOUT = arg('json', 'shots/ux/trace.json');

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 5266, strictPort: false, host: '127.0.0.1' },
});
await server.listen();

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 300000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('console: ' + m.text()); });

let out = null, code = 0;
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));

  out = await page.evaluate(async (SECONDS) => {
    const H = window.__harness;
    window.__setAuto?.(false);
    H.setPlayer(0, 700, Math.PI);

    // Same shape as tools/flyby.mjs, extended: settle, linked carves of rising
    // commitment, a long tuck for top speed, a pop + landing, then a hockey stop.
    const inputAt = (t) => {
      if (t < 8) return { steer: 0, crouch: 0, jump: false, brake: 0 };                                    // build speed
      if (t < 20) return { steer: Math.sin((t - 8) * 1.1) * 0.5, crouch: 0, jump: false, brake: 0 };       // linked carves
      if (t < 28) return { steer: Math.sin((t - 20) * 0.3) * 0.12, crouch: 1, jump: false, brake: 0 };     // tuck
      if (t < 31) return { steer: 0.05, crouch: t < 28.6 ? 1 : 0, jump: t > 28.9 && t < 29.05, brake: 0 }; // pop + land
      if (t < 36) return { steer: Math.sin((t - 31) * 1.1) * 0.55, crouch: 0, jump: false, brake: 0 };
      return { steer: 0.95, crouch: 0, jump: false, brake: 1 };                                            // hockey stop
    };

    const DT = 1 / 120;
    const n = Math.round(SECONDS / DT);
    const rows = [];
    let prevSpeed = 0, prevAir = false, airVy = 0, airDur = 0;
    const landings = [];
    for (let i = 0; i < n; i++) {
      const t = i * DT;
      H.__scripted = inputAt(t);
      H.step(DT, 1);
      const s = H.state;
      const decel = (prevSpeed - s.speed) / DT;
      if (s.airborne) { airDur += DT; airVy = Math.min(airVy, s.vel.y); }
      if (prevAir && !s.airborne) { landings.push({ t: +t.toFixed(2), dur: +airDur.toFixed(3), vy: +airVy.toFixed(2), speed: +s.speed.toFixed(2) }); airDur = 0; airVy = 0; }
      if (!prevAir && s.airborne) { airVy = 0; }
      prevAir = s.airborne;
      prevSpeed = s.speed;
      rows.push({
        t: +t.toFixed(3), speed: s.speed, edge: s.edge, carving: s.carving ? 1 : 0,
        airborne: s.airborne ? 1 : 0, g: s.gForce, crouch: s.crouch, vy: s.vel.y,
        decel, brake: s.input.brake, airTime: s.airTime,
      });
    }

    const col = (k) => rows.map((r) => r[k]);
    const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round(p * (b.length - 1))))]; };
    const stat = (k) => {
      const a = col(k);
      return {
        min: +Math.min(...a).toFixed(3), p05: +q(a, 0.05).toFixed(3), p50: +q(a, 0.5).toFixed(3),
        p90: +q(a, 0.9).toFixed(3), p99: +q(a, 0.99).toFixed(3), max: +Math.max(...a).toFixed(3),
        mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3),
      };
    };
    const phase = (a, b, label) => {
      const sub = rows.filter((r) => r.t >= a && r.t < b);
      const sp = sub.map((r) => r.speed);
      return {
        label, t: [a, b],
        kmhMean: +(sp.reduce((x, y) => x + y, 0) / sp.length * 3.6).toFixed(1),
        kmhMax: +(Math.max(...sp) * 3.6).toFixed(1),
        carveFrac: +(sub.reduce((x, r) => x + r.carving, 0) / sub.length).toFixed(2),
        airFrac: +(sub.reduce((x, r) => x + r.airborne, 0) / sub.length).toFixed(2),
        absEdgeMean: +(sub.reduce((x, r) => x + Math.abs(r.edge), 0) / sub.length).toFixed(2),
        gMax: +Math.max(...sub.map((r) => r.g)).toFixed(2),
      };
    };

    return {
      seconds: SECONDS,
      speed: stat('speed'), kmh: { p50: +(q(col('speed'), 0.5) * 3.6).toFixed(1), p90: +(q(col('speed'), 0.9) * 3.6).toFixed(1), max: +(Math.max(...col('speed')) * 3.6).toFixed(1) },
      edge: stat('edge'), g: stat('g'), crouch: stat('crouch'), vy: stat('vy'), decel: stat('decel'),
      carveFrac: +(col('carving').reduce((a, b) => a + b, 0) / rows.length).toFixed(3),
      airFrac: +(col('airborne').reduce((a, b) => a + b, 0) / rows.length).toFixed(3),
      landings,
      phases: [phase(0, 8, "build"), phase(8, 20, "linked carves"), phase(20, 28, "tuck"),
        phase(28, 31, "pop+land"), phase(31, 36, "carves"), phase(36, SECONDS, "hockey stop")],
    };
  }, SECONDS);
} catch (e) {
  errors.push('trace: ' + (e?.message ?? String(e)));
  code = 1;
} finally {
  await browser.close();
  await server.close();
}

if (out) {
  console.log(JSON.stringify(out, null, 2));
  const p = path.resolve(ROOT, JSONOUT);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(out, null, 2));
}
if (errors.length) { code = 1; console.error(errors.join('\n')); }
process.exit(code);
