/**
 * Drive the resort loop the way a PLAYER does — through state.input only — and
 * assert the mode machine actually transitions. Forced modes prove the cameras;
 * this proves the game.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const ROOT = process.cwd();
const server = await createServer({
  root: ROOT, configFile: ROOT + '/vite.config.js', logLevel: 'error',
  server: { port: 5344, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 300000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1000));

const out = await page.evaluate(() => {
  const h = window.__harness;
  const st = h.state;
  const log = [];
  window.__setAuto(false);
  const set = (o) => { window.__inputOverride = o; };
  const run = (n, o, label) => {
    set(o);
    for (let i = 0; i < n; i++) h.step(1 / 60, 1);
    if (label === null) return;          // a keystroke worth pressing, not printing
    log.push([label, st.mode, h.debug.resort.phase,
      +(st.ride?.progress ?? -1).toFixed(3),
      st.prompt ? st.prompt.text : null,
      +st.pos.x.toFixed(1), +st.pos.y.toFixed(1), +st.pos.z.toFixed(1),
      +(st.speed || 0).toFixed(1)]);
  };

  // --- A: board the chair from the mid-station, ride, then skip to the top ----
  h.debug.resort.goto('chair-mid');
  run(6, { brake: 1 }, 'at mid-station');
  run(4, { brake: 1, action: true }, 'press E');
  run(90, { }, 'boarding + 1.5 s');
  run(240, { }, 'riding 4 s');
  run(60, { brake: 1 }, 'hold brake (skip)');
  run(120, { }, 'after skip');
  run(180, { }, 'unloaded, skiing');

  // --- B: the T-bar ----------------------------------------------------------
  h.debug.resort.goto('tbar');
  run(6, { brake: 1 }, 'at T-bar');
  run(4, { brake: 1, action: true }, 'press E');
  run(120, { }, 'dragged 2 s');
  run(60, { brake: 1 }, 'hold brake (skip)');
  run(150, { }, 'after skip');

  // --- C: the hut ------------------------------------------------------------
  h.debug.resort.goto('hut');
  run(6, { brake: 1 }, 'at the hut');
  run(4, { brake: 1, action: true }, 'press E');
  run(60, { }, 'inside');
  const todBefore = h.debug.sky.getTimeOfDay();
  // The cursor path, which is the ONLY thing that exercises navY/confirm through
  // real input. Three presses down and Enter has to land on line 4 (Jagertee) —
  // if `navY` were taken off the ramped `crouch` channel instead of the raw key
  // state this is where it would skip a row or none.
  for (let i = 0; i < 3; i++) { run(3, { navY: -1 }, null); run(3, { navY: 0 }, null); }
  const cursorAfterNav = h.debug.resort.info().cursor;
  run(4, { confirm: true }, 'order off the cursor');
  run(60, { }, 'served');
  const orderedByCursor = h.debug.resort.info().drink;
  // ...and then the number-key path, which must move the cursor with it
  run(6, { pick: 1 }, 'order coffee');
  run(90, { }, 'drinking');
  const todAfter = h.debug.sky.getTimeOfDay();
  run(4, { action: true }, 'press E to leave');
  run(90, { }, 'back outside');
  set(null);

  return {
    log,
    warmth: +st.warmth.toFixed(3),
    runs: st.runs.length,
    tod: [+todBefore.toFixed(4), +todAfter.toFixed(4)],
    cursorAfterNav,
    orderedByCursor,
    mode: st.mode,
    skierVisible: h.debug.skier.group.visible,
    interiorVisible: h.debug.resort.interiorGroup.visible,
    chairVisible: h.debug.resort.chairRig.visible,
  };
});

console.log('label'.padEnd(22), 'mode/phase'.padEnd(16), 'prog', ' prompt');
for (const r of out.log) {
  console.log(String(r[0]).padEnd(22), (r[1] + '/' + r[2]).padEnd(16), String(r[3]).padStart(6),
    ' ', String(r[4] ?? '-').padEnd(28), `pos ${r[5]},${r[6]},${r[7]} v=${r[8]}`);
}
console.log('\nwarmth', out.warmth, '| runs logged', out.runs, '| tod', out.tod,
  '| mode', out.mode, '| skier', out.skierVisible, '| interior', out.interiorVisible, '| chair', out.chairVisible);
console.log('menu: cursor after 3 x down =', out.cursorAfterNav, '(expect 3)',
  '| ordered off the cursor =', out.orderedByCursor, "(expect 'jagertee')");
if (errs.length) console.error('\n--- page errors ---\n' + errs.slice(0, 20).join('\n'));
await browser.close(); await server.close();
process.exit(errs.length ? 1 : 0);
