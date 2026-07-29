/** Runs tools/probe.html headless and prints the linear-light measurements. */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  logLevel: 'error', server: { port: 5211, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/tools/probe.html`;

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 900000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon/i.test(m.text() + (m.location()?.url ?? ''))) errs.push('console: ' + m.text());
});

let code = 0;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__probeReady === true', { timeout: 60000 });
  const data = await page.evaluate(() => window.__probe);
  for (const d of data) {
    console.log(`\n--- tod ${d.tod}  sunElev ${d.sunElevDeg}deg  I=${d.sunIntensity} env=${d.envIntensity} fill=${d.fillIntensity} expo=${d.exposure}`);
    console.log(`  sunlit snow  ${JSON.stringify(d.sunlit)}  L=${d.sunlitL}`);
    console.log(`  shadow snow  ${JSON.stringify(d.shadow)}  L=${d.shadowL}  B/R=${d.shadowBR}`);
    console.log(`  key:fill     ${d.ratio}:1   (${d.stops} stops)`);
    console.log(`  env +Y irr   ${JSON.stringify(d.envUp)}  B/R=${d.envUpBR}`);
    console.log(`  zenith       ${JSON.stringify(d.zenith)}  B/R=${d.zenithBR}`);
    console.log(`  horizon sun  ${JSON.stringify(d.horizonSun)}   opp ${JSON.stringify(d.horizonOpp)}  upperOpp ${JSON.stringify(d.upperOpp)}`);
    console.log(`  30m face     ${JSON.stringify(d.near)}  L=${d.nearL}  B/R=${d.nearBR}`);
    console.log(`  3km face     ${JSON.stringify(d.ridge)}  L=${d.ridgeL}  B/R=${d.ridgeBR}   sky behind L=${d.ridgeSkyL}`);
    console.log(`  sun disc     ${JSON.stringify(d.discPeak)}  L=${d.discL}   (sky aureole alone L=${d.aureoleL})`);
    console.log(`  terrain air  ${JSON.stringify(d.terrainAir)} L=${d.terrainAirL} B/R=${d.terrainAirBR}  dens=${d.fogDensity}`);
  }

  // ---- assertions ---------------------------------------------------------
  const at = (t) => data.find((d) => d.tod === t);
  const day = at(0.375), low = at(0.265);
  const checks = [
    ['sunlit snow 0.90-1.10 linear', day.sunlitL >= 0.90 && day.sunlitL <= 1.10, day.sunlitL],
    ['key:fill >= 3.0:1', day.ratio >= 3.0, day.ratio + ':1'],
    ['shadowed snow reads blue (B/R > 1.3)', day.shadowBR > 1.3, day.shadowBR],
    ['+Y PMREM irradiance B/R > 1.35 at low sun', low.envUpBR > 1.35, low.envUpBR],
    ['3 km ridge 0.40-0.55 linear', day.ridgeL >= 0.40 && day.ridgeL <= 0.55, day.ridgeL],
    ['3 km ridge bluer than near snow', day.ridgeBR > day.nearBR * 1.15, `${day.ridgeBR} vs ${day.nearBR}`],
    ['3 km ridge darker than near snow', day.ridgeL < day.nearL * 0.70, `${day.ridgeL} vs ${day.nearL}`],
    ['sun disc 1.5-6x white, not 12x', day.discL >= 1.5 && day.discL <= 6.0, day.discL],
    ['sun disc reddens at low sun (R/B > 1.3)', low.discPeak[0] / low.discPeak[2] > 1.3,
      +(low.discPeak[0] / low.discPeak[2]).toFixed(2)],
  ];
  console.log('');
  let failed = 0;
  for (const [name, ok, val] of checks) {
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(44)} ${val}`);
  }
  if (failed) { console.log(`\n  ${failed} assertion(s) failed`); code = 2; }

  // eyeball views: sun disc + clouds, tone-mapped, straight out of the dome
  const views = [
    ['sun-noon', 0.5, null, 0, 14], ['sun-day', 0.335, null, 0, 14],
    ['sun-golden', 0.265, null, 0, 14], ['sun-golden-wide', 0.265, null, 0, 45],
    ['clouds-day', 0.335, 26, 90, 60], ['clouds-golden', 0.265, 22, 120, 60],
  ];
  await fs.mkdir(path.join(ROOT, 'shots/probe'), { recursive: true });
  for (const [name, tod, el, az, fov] of views) {
    await page.evaluate((a) => window.__view(...a), [tod, el, az, fov]);
    const el2 = await page.$('canvas');
    await el2.screenshot({ path: path.join(ROOT, `shots/probe/${name}.png`) });
  }
} catch (e) {
  console.error('probe failed: ' + (e?.message ?? e));
  code = 1;
} finally {
  if (errs.length) { console.error('--- errors ---'); errs.slice(0, 20).forEach((e) => console.error('  ' + e)); code = 1; }
  await browser.close();
  await server.close();
  process.exit(code);
}
