/**
 * Capture an actual run as a video. Stills cannot show whether the skiing feels
 * right — camera lag, carve rhythm, spray, speed — so this drives the sim with a
 * scripted input sequence and encodes the frames with ffmpeg.
 *
 *   node tools/flyby.mjs --out shots/run.mp4
 *   node tools/flyby.mjs --out shots/run.mp4 --seconds 12 --fps 30 --w 1280 --h 720
 *   node tools/flyby.mjs --out shots/run.gif --seconds 6
 *
 * Deterministic: the sim is stepped at a fixed dt, so two runs of the same build
 * produce identical video and A/B comparisons are meaningful.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };

const OUT = path.resolve(ROOT, arg('out', 'shots/run.mp4'));
const SECONDS = +arg('seconds', 10);
const FPS = +arg('fps', 30);
const W = +arg('w', 1280), H = +arg('h', 720);
const START = arg('start', 'hero');

const STARTS = {
  hero: [0, 700, Math.PI],
  trees: [180, 120, Math.PI * 1.1],
  steep: [-40, -260, Math.PI],
};

/**
 * Scripted input over time, so the run shows off carving rather than a straight
 * schuss: settle, then linked turns of increasing commitment, a tuck, a pop.
 */
function inputAt(t) {
  const steer = t < 1.0 ? 0
    : Math.sin((t - 1.0) * 0.9) * Math.min(1, (t - 1.0) / 2.5);
  return {
    steer,
    crouch: t > 6.5 && t < 8.0 ? 1 : 0,
    jump: t > 8.4 && t < 8.55,
    brake: 0,
  };
}

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5251, strictPort: false, host: '127.0.0.1' },
});
await server.listen();

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 300000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text()); });

const tmp = path.join(ROOT, 'shots', '.frames');
await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(tmp, { recursive: true });

let code = 0;
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));

  const [sx, sz, sh] = STARTS[START] ?? STARTS.hero;
  await page.evaluate(() => window.__setAuto?.(false));
  await page.evaluate((x, z, h) => window.__harness.setPlayer(x, z, h), sx, sz, sh);

  const total = Math.round(SECONDS * FPS);
  const sub = Math.max(1, Math.round((1 / FPS) / (1 / 120))); // sim at ~120 Hz
  const dt = 1 / (FPS * sub);
  const speeds = [];

  for (let f = 0; f < total; f++) {
    const t = f / FPS;
    const inp = inputAt(t);
    const s = await page.evaluate((inp, dt, sub) => {
      const H = window.__harness;
      // Override controls for this frame: main.js runs controls.update() first,
      // so we re-apply after stepping is not an option — instead pin the input
      // by monkeypatching the controls sampler once.
      H.__scripted = inp;
      H.step(dt, sub);
      const st = H.state;
      return { speed: st.speed, air: st.airborne, edge: st.edge, g: st.gForce };
    }, inp, dt, sub);
    speeds.push(s.speed);
    await page.screenshot({ path: path.join(tmp, `f${String(f).padStart(5, '0')}.png`) });
  }

  const mx = Math.max(...speeds), av = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  console.log(`sim: avg ${(av * 3.6).toFixed(1)} km/h, peak ${(mx * 3.6).toFixed(1)} km/h over ${SECONDS}s`);

  const isGif = OUT.endsWith('.gif');
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  if (isGif) {
    await run('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(tmp, 'f%05d.png'),
      '-vf', `fps=${FPS},scale=${W}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, OUT]);
  } else {
    await run('ffmpeg', ['-y', '-framerate', String(FPS), '-i', path.join(tmp, 'f%05d.png'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'slow', OUT]);
  }
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
} catch (e) {
  errors.push(e?.message ?? String(e));
  code = 1;
} finally {
  if (errors.length) { code = 1; console.error('--- errors ---'); errors.slice(0, 20).forEach((e) => console.error('  ' + e)); }
  await fs.rm(tmp, { recursive: true, force: true });
  await browser.close();
  await server.close();
  process.exit(code);
}
