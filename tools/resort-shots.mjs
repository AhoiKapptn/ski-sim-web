/**
 * Screenshot the resort loop: the two lifts, the hut, and the contact prompts.
 *
 *   node tools/resort-shots.mjs shots/resort
 *
 * Each shot forces a mode through `window.__harness.debug.resort` and then steps
 * the sim, exactly the way tools/shoot.mjs settles a framing.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.resolve(ROOT, process.argv[2] || 'shots/resort');
const W = +(process.argv[3] || 1600), H = +(process.argv[4] || 900);

const SHOTS = [
  // A0 — the boarding move, frame by frame. `instant: false` keeps the 'board'
  // phase, which is the whole point: this is the transition, not the seat.
  // Note the 12 render steps every shot takes after `settle`: the step counts
  // here are the labelled time MINUS 0.20 s.
  ['board-020s', "h.debug.resort.goto('chair-mid'); h.step(1/60, 30); h.debug.resort.enter('lift', { at: 'mid', instant: false });", 0],
  ['board-045s', "h.debug.resort.goto('chair-mid'); h.step(1/60, 30); h.debug.resort.enter('lift', { at: 'mid', instant: false }); h.step(1/60, 15);", 0],
  ['board-070s', "h.debug.resort.goto('chair-mid'); h.step(1/60, 30); h.debug.resort.enter('lift', { at: 'mid', instant: false }); h.step(1/60, 30);", 0],
  ['board-100s', "h.debug.resort.goto('chair-mid'); h.step(1/60, 30); h.debug.resort.enter('lift', { at: 'mid', instant: false }); h.step(1/60, 48);", 0],
  ['board-130s', "h.debug.resort.goto('chair-mid'); h.step(1/60, 30); h.debug.resort.enter('lift', { at: 'mid', instant: false }); h.step(1/60, 66);", 0],
  // A — the chair
  ['chair-board', "h.debug.resort.goto('chair-mid'); h.step(1/60, 30); h.debug.resort.enter('lift', { at: 'mid' });", 150],
  // the one choice on the way up: the ride ends at the mid-station unless you
  // say otherwise, so this is the approach to it from the valley station
  ['chair-choice', "h.debug.resort.enter('lift', { progress: 0.505 });", 150],
  ['chair-ride', "h.debug.resort.enter('lift', { at: 'mid', progress: 0.35 });", 150],
  ['chair-valley', "h.debug.resort.enter('lift', { progress: 0.06 });", 150],
  ['chair-look-back', "h.debug.resort.enter('lift', { at: 'mid', progress: 0.5 }); window.__inputOverride = { steer: 1 };", 220],
  ['chair-top', "window.__inputOverride = null; h.debug.resort.enter('lift', { at: 'mid', progress: 0.999 }); h.step(1/60, 420);", 40],
  // B — the T-bar
  ['tbar-ride', "window.__inputOverride = null; h.debug.resort.enter('drag', { progress: 0.45 });", 170],
  ['tbar-bottom', "h.debug.resort.enter('drag', { progress: 0.015 });", 170],
  ['tbar-top', "h.debug.resort.enter('drag', { progress: 0.999 }); h.step(1/60, 170);", 40],
  // Prompt shots hold the brake so the rider stays in the zone: a reset is a
  // flying start and the settle would otherwise carry him past it.
  ['tbar-prompt', "h.debug.resort.enter('ski'); window.__inputOverride = { brake: 1 }; h.debug.resort.goto('tbar');", 26],
  // C — the hut
  ['hut-inside', "window.__inputOverride = null; h.debug.resort.enter('hut');", 90],
  ['hut-coffee', "h.debug.resort.enter('hut', { drink: 'coffee' });", 90],
  ['hut-beer', "h.debug.resort.enter('hut', { drink: 'beer' });", 130],
  ['hut-look-l', "h.debug.resort.enter('hut', { drink: 'coffee' }); window.__inputOverride = { steer: -1 }; h.step(1/60, 120);", 60],
  ['hut-look-r', "h.debug.resort.enter('hut', { drink: 'coffee' }); window.__inputOverride = { steer: 1 }; h.step(1/60, 120);", 60],
  // the counter you ordered from: `beat: true` plays the look across, and 1.1 s
  // in is the hold on the bar
  ['hut-bar', "window.__inputOverride = null; h.debug.resort.enter('hut'); h.step(1/60, 20); h.debug.resort.enter('hut', { drink: 'coffee', beat: true }); h.step(1/60, 60);", 0],
  ['hut-exit', "window.__inputOverride = null; h.debug.resort.enter('hut'); h.step(1/60, 20); window.__inputOverride = { action: true }; h.step(1/60, 2); window.__inputOverride = null; h.step(1/60, 60);", 0],
  ['hut-prompt', "h.debug.resort.enter('ski'); window.__inputOverride = { brake: 1 }; h.debug.resort.goto('hut');", 26],
  ['chair-prompt', "h.debug.resort.enter('ski'); window.__inputOverride = { brake: 1 }; h.debug.resort.goto('chair-mid');", 26],
];

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 5333, strictPort: false, host: '127.0.0.1' },
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
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

let code = 0;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));
  await fs.mkdir(OUT, { recursive: true });
  for (const [name, js, settle] of SHOTS) {
    await page.evaluate((js, settle) => {
      window.__setAuto?.(false);
      const h = window.__harness;
      // eslint-disable-next-line no-new-func
      new Function('h', js)(h);
      h.step(1 / 60, settle);
    }, js, settle);
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => window.__harness.step(1 / 60, 1));
      await new Promise((r) => setTimeout(r, 32));
    }
    const st = await page.evaluate(() => window.__harness.stats());
    const info = await page.evaluate(() => window.__harness.debug.resort.info());
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    const bad = st.lost || st.stddev < 2 || st.mean < 3 || st.mean > 252;
    if (bad) code = 1;
    console.log(`${bad ? '✗' : '✓'} ${name.padEnd(14)} mean=${st.mean?.toFixed(1)} sd=${st.stddev?.toFixed(1)} mode=${info.mode}/${info.phase} s=${info.rideS?.toFixed(0)}`);
  }
} catch (e) {
  console.error('ERR', e.message);
  code = 1;
} finally {
  if (errs.length) { code = 1; console.error('--- page errors ---\n' + errs.slice(0, 20).join('\n')); }
  await browser.close();
  await server.close();
  process.exit(code);
}
