/**
 * HUD capture rig.
 *
 *   node tools/ux-hud.mjs --out shots/hud
 *
 * The canonical shoot.mjs framings settle for ~1.5 s, which is before the skier
 * has any speed — so they can never show the HUD at the speeds the game now
 * actually reaches. This drives the real sim until each target state is hit and
 * screenshots there, and additionally composites the HUD over real alpine
 * photographs (the harshest possible legibility test: white type on sunlit snow
 * with no engine tonemap to soften it).
 *
 *   --refs /tmp/refs4_ux   composite pass over every jpg in that directory
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const OUT = path.resolve(ROOT, arg('out', 'shots/hud'));
const REFS = arg('refs', '');
const W = +arg('w', 1600), H = +arg('h', 900);

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 5288, strictPort: false, host: '127.0.0.1' },
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
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('console: ' + m.text()); });

await fs.mkdir(OUT, { recursive: true });
let code = 0;
const log = [];

try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => window.__setAuto?.(false));

  // ---- pass 1: live sim, captured at real target states ---------------------
  // Run the scripted line from tools/ux-trace.mjs and grab a frame the first
  // time each condition is met.
  const WANT = [
    ['rest', 'st.speed*3.6 < 2 && t > 0.2'],
    ['cruise', 'st.speed*3.6 > 30 && st.speed*3.6 < 36'],
    ['fast', 'st.speed*3.6 > 60 && !st.airborne'],
    ['carve', 'st.speed*3.6 > 48 && st.carving && Math.abs(st.edge) > 0.4'],
    ['tuck', 'st.speed*3.6 > 74 && st.crouch > 0.6'],
    ['air', 'st.airborne && st.airTime > 0.45'],
    ['landed', 'lastLandDur > 0.55 && sinceLand > 0.12 && sinceLand < 0.35'],
  ];

  await page.evaluate((WANT) => {
    const H = window.__harness;
    window.__uxq = WANT.map(([k, expr]) => ({ k, f: new Function('st', 't', 'lastLandDur', 'sinceLand', 'return ' + expr) }));
    window.__uxHits = {};
    window.__uxT = 0;
    window.__uxAir = 0; window.__uxLastLand = 0; window.__uxSinceLand = 99; window.__uxWasAir = false;
    H.setPlayer(0, 700, Math.PI);
    window.__uxInput = (t) => {
      if (t < 7) return { steer: 0, crouch: 0, jump: false, brake: 0 };
      if (t < 17) return { steer: Math.sin((t - 7) * 1.0) * 0.5, crouch: 0, jump: false, brake: 0 };
      if (t < 27) return { steer: 0, crouch: 1, jump: false, brake: 0 };
      if (t < 32) return { steer: 0.05, crouch: t < 28.6 ? 1 : 0, jump: t > 28.9 && t < 29.05, brake: 0 };
      if (t < 38) return { steer: Math.sin((t - 32) * 1.0) * 0.55, crouch: 0, jump: false, brake: 0 };
      return { steer: 0.95, crouch: 0, jump: false, brake: 1 };
    };
    // step until the next unhit condition matches, or budget runs out
    window.__uxStep = (budget) => {
      const DT = 1 / 120;
      for (let i = 0; i < budget; i++) {
        H.__scripted = window.__uxInput(window.__uxT);
        H.step(DT, 1);
        window.__uxT += DT;
        const st = H.state;
        if (st.airborne) window.__uxAir += DT;
        if (window.__uxWasAir && !st.airborne) { window.__uxLastLand = window.__uxAir; window.__uxAir = 0; window.__uxSinceLand = 0; }
        else window.__uxSinceLand += DT;
        window.__uxWasAir = st.airborne;
        for (const q of window.__uxq) {
          if (window.__uxHits[q.k]) continue;
          let ok = false;
          try { ok = q.f(st, window.__uxT, window.__uxLastLand, window.__uxSinceLand); } catch { /* ignore */ }
          if (ok) {
            window.__uxHits[q.k] = { t: +window.__uxT.toFixed(2), kmh: +(st.speed * 3.6).toFixed(1), edge: +st.edge.toFixed(2), carving: st.carving, airborne: st.airborne, airTime: +(st.airTime ?? 0).toFixed(2), g: +st.gForce.toFixed(2) };
            return q.k;
          }
        }
      }
      return null;
    };
  }, WANT);

  const captured = new Set();
  for (let guard = 0; guard < 40 && captured.size < WANT.length; guard++) {
    const hit = await page.evaluate(() => window.__uxStep(60 * 120));
    if (!hit) break;
    // a couple of presented frames so CSS transitions/animations land
    for (let i = 0; i < 4; i++) { await page.evaluate(() => window.__harness.step(1 / 120, 1)); await new Promise((r) => setTimeout(r, 30)); }
    const info = await page.evaluate((k) => window.__uxHits[k], hit);
    await page.screenshot({ path: path.join(OUT, `${hit}.png`) });
    await page.screenshot({ path: path.join(OUT, `${hit}-crop.png`), clip: { x: 0, y: H - 380, width: W, height: 380 } });
    log.push({ shot: hit, ...info });
    console.log(`✓ ${hit.padEnd(8)} ${JSON.stringify(info)}`);
    captured.add(hit);
  }
  for (const [k] of WANT) if (!captured.has(k)) { console.log(`✗ ${k} never reached`); code = 1; }

  // ---- pass 1b: strobe check ------------------------------------------------
  // Stills cannot show the failure mode that matters most here: the terrain
  // produces 40+ hops of 0.1-0.3 s per run, and a naive `airborne` binding makes
  // the AIR badge flash on and off dozens of times. Count the transitions.
  const strobe = await page.evaluate(() => {
    const H = window.__harness;
    const el = document.querySelector('#alp-hud .air');
    H.setPlayer(0, 700, Math.PI);
    window.__uxT = 0;
    let hops = 0, wasAir = false, shows = 0, hits = 0;
    let wasShown = false, wasHit = false;
    const DT = 1 / 120;
    for (let i = 0; i < 45 * 120; i++) {
      H.__scripted = window.__uxInput(window.__uxT);
      H.step(DT, 1);
      window.__uxT += DT;
      const air = H.state.airborne;
      if (air && !wasAir) hops++;
      wasAir = air;
      const shown = el.classList.contains('live');
      if (shown && !wasShown) shows++;
      wasShown = shown;
      const hit = el.classList.contains('hit');
      if (hit && !wasHit) hits++;
      wasHit = hit;
    }
    return { hops, badgeShows: shows, landingFanfares: hits };
  });
  console.log(`strobe: ${strobe.hops} airborne transitions -> ${strobe.badgeShows} badge appearances, ` +
    `${strobe.landingFanfares} landing fanfares`);
  log.push({ shot: 'strobe', ...strobe });
  if (strobe.badgeShows > strobe.hops * 0.25) {
    console.log('✗ AIR badge strobes on terrain chatter');
    code = 1;
  }

  // ---- pass 2: HUD over real alpine photographs -----------------------------
  if (REFS) {
    const files = (await fs.readdir(REFS)).filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
    for (const f of files) {
      const b64 = (await fs.readFile(path.join(REFS, f))).toString('base64');
      const mime = /png$/i.test(f) ? 'image/png' : 'image/jpeg';
      await page.evaluate((b64, mime) => {
        let el = document.getElementById('ux-ref');
        if (!el) {
          el = document.createElement('img');
          el.id = 'ux-ref';
          el.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:10';
          document.body.appendChild(el);
        }
        el.src = `data:${mime};base64,${b64}`;
        // freeze the HUD in a "hero" state: fast, carving, loaded
        const hud = window.__alpineHUD;
        const st = {
          speed: 68 / 3.6, edge: 0.62, carving: true, airborne: false,
          gForce: 2.1, airTime: 0, distance: 1840, time: 74.3,
          input: { steer: 0.6, crouch: 0, jump: false, brake: 0 },
        };
        for (let i = 0; i < 240; i++) hud.update(1 / 60, st);
      }, b64, mime);
      await new Promise((r) => setTimeout(r, 250));
      const name = 'ref-' + f.replace(/\.[^.]+$/, '') + '.png';
      await page.screenshot({ path: path.join(OUT, name) });
      console.log(`✓ ${name}`);
    }
    await page.evaluate(() => document.getElementById('ux-ref')?.remove());
  }
} catch (e) {
  errors.push('hud: ' + (e?.message ?? String(e)));
  code = 1;
} finally {
  await fs.writeFile(path.join(OUT, 'report.json'), JSON.stringify({ log, errors }, null, 2));
  await browser.close();
  await server.close();
}
if (errors.length) { code = 1; console.error('--- errors ---\n' + errors.slice(0, 20).join('\n')); }
process.exit(code);
