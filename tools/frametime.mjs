/**
 * Frame-time tail + spike attribution for ONE build.
 *
 *   node tools/frametime.mjs                                  # 12 s carving run, dev server
 *   node tools/frametime.mjs --seconds 20 --dpr 2             # the user's real Retina backbuffer
 *   node tools/frametime.mjs --prod                           # built bundle via vite preview
 *   node tools/frametime.mjs --straight                       # coast, for contrast
 *   node tools/frametime.mjs --json /tmp/ft.json --frames     # dump every frame
 *
 * WHAT THIS IS FOR, and what it deliberately is not
 * -------------------------------------------------
 * `tools/shoot.mjs --perf` counts vsync-presented frames over 4 s with the
 * player STATIONARY. It therefore reports which mode the compositor is holding
 * (60 or 30), never the margin, and it never loads the systems that only do work
 * when the skier is moving and carving. This tool instead:
 *
 *   - drives a fixed scripted LINKED-CARVE run (the reported symptom is "lags
 *     when curving"), so spray, tracks, camera shake and the g-force paths are
 *     all under load,
 *   - records a per-frame histogram from the real rAF loop via
 *     `window.__harness.perf` (never `harness.step()` in a loop — that once
 *     reported 8.4 ms for a build measuring 54 fps),
 *   - reports the TAIL (p95/p99/max, count over 20 ms and 33 ms) and per-frame
 *     attribution (per-subsystem CPU ms, draw calls, program-cache growth,
 *     geometry/texture uploads), because the vsync mode-lock corrupts means but
 *     not tails: a 40 ms frame is 40 ms in any mode.
 *
 * Absolute numbers from a single run still prove nothing about a code change.
 * For that use `tools/perf-ab.mjs`, which switches the two variants inside ONE
 * page session. This tool answers "what is spiking", not "is A faster than B".
 *
 * It is also exported as a module: `tools/perf-ab.mjs` imports the server,
 * browser and scripted-path helpers from here so both tools drive an identical
 * path. Running it as a script is guarded at the bottom.
 */
import { createServer, build, preview } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

// ---- args -------------------------------------------------------------------
export function makeArgs(argv = process.argv.slice(2)) {
  const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
  const num = (k, d) => { const v = arg(k, null); const n = v === null ? NaN : parseFloat(v); return Number.isFinite(n) ? n : d; };
  const flag = (k) => argv.includes('--' + k);
  return { argv, arg, num, flag };
}

// ---- the scripted path ------------------------------------------------------
/**
 * Canonical start positions, shared with tools/shoot.mjs so a perf run and a
 * screenshot are looking at the same terrain.
 */
export const STARTS = {
  hero: [0, 700, Math.PI],
  ridge: [-260, 300, Math.PI * 0.86],
  trees: [180, 120, Math.PI * 1.1],
  steep: [-40, -260, Math.PI],
};

/**
 * Linked carves, as a source string so it can be injected into the page.
 *
 * `lead` seconds of tuck to build speed, then alternating edges at `period`
 * seconds per full left-right cycle. The |sin|^0.55 shaping holds each edge near
 * full angle instead of sweeping smoothly through it, which is what a real
 * linked turn looks like and what actually loads the spray emitter and the
 * tracks trench writer. A straight coast does not, which is precisely the blind
 * spot that let this bug survive.
 */
export const SCRIPT_SRC = `(function (t, o) {
  if (t < o.lead) return { steer: 0, crouch: 1, jump: false, brake: 0 };
  if (o.straight) return { steer: 0, crouch: 0, jump: false, brake: 0 };
  var u = (t - o.lead) * 2 * Math.PI / o.period;
  var s = Math.sin(u);
  var steer = o.amp * (s < 0 ? -1 : 1) * Math.pow(Math.abs(s), 0.55);
  return { steer: steer, crouch: 0, jump: false, brake: 0 };
})`;

/**
 * Installs `window.__inputOverride` as a live accessor object. controls.js reads
 * `.steer/.crouch/.brake/.jump` every frame (controls.js:75), so getters give a
 * time-varying scripted run with no second rAF loop of our own competing with
 * the render loop for frame budget.
 *
 * `window.__path.restart()` rewinds t to 0; `window.__path.detach()` hands
 * control back.
 */
export async function installPath(page, opts) {
  await page.evaluate((src, o) => {
    const script = eval(src);
    const P = {
      t0: performance.now(), opts: o,
      now() { return (performance.now() - P.t0) / 1000; },
      restart(x, z, h) {
        if (x !== undefined) window.__harness.setPlayer(x, z, h);
        P.t0 = performance.now();
      },
      detach() { window.__inputOverride = null; },
      sample() { return script(P.now(), P.opts); },
    };
    window.__path = P;
    window.__inputOverride = {
      get steer() { return P.sample().steer; },
      get crouch() { return P.sample().crouch; },
      get brake() { return P.sample().brake; },
      get jump() { return P.sample().jump; },
    };
  }, SCRIPT_SRC, opts);
}

// ---- server -----------------------------------------------------------------
/**
 * Join a query string onto a server URL that may ALREADY carry one.
 *
 * `startServer({ prod: true })` returns a URL with `?harness=1` on it, because a
 * production bundle does not publish `window.__harness` without that opt-in. Any
 * caller doing `server.url + '?dpr=2'` would then produce `?harness=1?dpr=2`,
 * whose second parameter is named `?dpr` and is silently ignored — i.e. a
 * `--prod --dpr 2` run would quietly measure DPR 1. Use this instead of `+`.
 */
export function urlWith(base, extra = '') {
  const q = String(extra).replace(/^[?&]+/, '');
  if (!q) return base;
  return base + (base.includes('?') ? '&' : '?') + q;
}

/**
 * Dev server (default) or a built bundle served by `vite preview` (`--prod`).
 *
 * This matters: the user runs `pnpm dev`, and `import.meta.env.DEV` branches are
 * live there and stripped from a production build — e.g. spray.js scans all
 * 34k particle slots every 20th frame under DEV. Whether a cost exists in dev,
 * in prod, or in both is a first-class question, so both are measurable and the
 * report always states which one it measured (`harness.dev`).
 */
export async function startServer({ prod = false, port = 5301 } = {}) {
  if (!prod) {
    const server = await createServer({
      root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
      logLevel: 'error', server: { port, strictPort: false, host: '127.0.0.1' },
    });
    await server.listen();
    return {
      mode: 'dev',
      url: `http://127.0.0.1:${server.httpServer.address().port}/`,
      close: () => server.close(),
    };
  }
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error' });
  const server = await preview({
    root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
    logLevel: 'error', preview: { port, strictPort: false, host: '127.0.0.1' },
  });
  const addr = server.httpServer.address();
  // `?harness=1` is REQUIRED here. A production build does not publish
  // `window.__harness` (see main.js) because it is a debug surface, so without
  // the opt-in every tool built on this boot() would time out waiting for a
  // harness that is never going to appear. The dev arm above needs nothing.
  return {
    mode: 'prod',
    url: `http://127.0.0.1:${addr.port}/?harness=1`,
    close: () => server.close(),
  };
}

// ---- browser ----------------------------------------------------------------
/**
 * `protocolTimeout` needs raising for callers that toggle MANY materials in one
 * evaluate: `needsUpdate = true` on ~120 materials is a synchronous shader-link
 * storm inside a single CDP call, and tools/gpu-breakdown.mjs' whole-scene arms
 * hit the default.
 */
export async function launch({ w = 1600, h = 900, dpr = 1, protocolTimeout = 600000 } = {}) {
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout,
    args: [
      '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb',
      // NB: do NOT add --disable-frame-rate-limit (see tools/shoot.mjs).
    ],
  });
  const page = await browser.newPage();
  // shoot.mjs hardcodes deviceScaleFactor 1, so every measurement this project
  // has ever taken was of a 1600x900 = 1.44 Mpx backbuffer. The user's Retina
  // machine runs 3200x1800 = 5.76 Mpx, and postfx sizes every render target from
  // renderer.getDrawingBufferSize(). --dpr 2 is that configuration.
  await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('console: ' + m.text());
  });
  return { browser, page, errors };
}

/**
 * `freezeAdaptive` (default true) holds `gfx.freeze()` for the whole session.
 *
 * engine.js' resolution controller is ON by default above 2.5 Mpx, and it is
 * driven by the presented frame interval — which is the same quantity every tool
 * here measures. Left running it would move the backbuffer between the two arms
 * of an A/B, so both arms would be measuring the controller instead of the
 * change. `perf.recording` freezes it too, but a window's SETTLE period runs
 * before `perf.start()`, so the freeze has to cover the session, not the window.
 * `tools/adaptive-test.mjs` is the one caller that passes `false`, because the
 * controller is what it is testing.
 */
export async function boot(page, url, { freezeAdaptive = true } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 120000 });
  if (freezeAdaptive) await page.evaluate(() => window.__harness.gfx.freeze?.());
  await new Promise((r) => setTimeout(r, 1500));
  return page.evaluate(() => {
    const h = window.__harness;
    const gl = h.debug.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      dev: h.dev,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      gpuTimerAvailable: h.perf.gpuTimerAvailable,
      gfx: h.gfx.info(),
      warmShaders: (h.warmShaders && h.warmShaders.log) || null,
      programs: h.debug.renderer.info.programs.length,
    };
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Record one measurement window: teleport to the start, replay the scripted path
 * from t=0, throw away `settleMs` of it, keep `dwellMs`.
 *
 * Restarting the path for every window is what makes two windows comparable —
 * otherwise the second arm of an A/B is always measured further down the
 * mountain, over different terrain, with a different scatter population.
 */
export async function measureWindow(page, { start = 'hero', settleMs = 1500, dwellMs = 2000, gpuTimer = true, syncGPU = false, spikeMs = 20 } = {}) {
  const [x, z, hd] = STARTS[start] ?? STARTS.hero;
  await page.evaluate((x, z, hd) => { window.__setAuto?.(true); window.__path.restart(x, z, hd); }, x, z, hd);
  await sleep(settleMs);
  await page.evaluate((o) => window.__harness.perf.start(o), { gpuTimer, syncGPU });
  await sleep(dwellMs);
  return page.evaluate((o) => window.__harness.perf.stop(o), { spikeMs });
}

// ---- formatting -------------------------------------------------------------
const f = (v, n = 2) => (v === null || v === undefined ? '  -  ' : (+v).toFixed(n));

export function printReport(r, label = '') {
  const fi = r.frameInterval;
  console.log(`\n── frame interval (presented) ${label}`);
  console.log(`   p50 ${f(fi.p50)}  p95 ${f(fi.p95)}  p99 ${f(fi.p99)}  max ${f(fi.max)} ms   `
    + `over20 ${r.over20}  over33 ${r.over33}  over50 ${r.over50}   (n=${r.n})`);
  console.log(`── cpu update ${f(r.update.p50)} / p99 ${f(r.update.p99)} / max ${f(r.update.max)} ms`
    + `   render ${f(r.render.p50)} / p99 ${f(r.render.p99)} / max ${f(r.render.max)} ms`);
  if (r.gpu) console.log(`── gpu (timer query)  p50 ${f(r.gpu.p50)}  p99 ${f(r.gpu.p99)}  max ${f(r.gpu.max)} ms  (n=${r.gpu.n})`);
  else console.log(`── gpu timer: ${r.gpuTimer}${r.syncGPU ? ', gl.finish() folded into render ms' : ''}`);

  const sys = Object.entries(r.sys).sort((a, b) => b[1].p50 - a[1].p50);
  if (sys.length) {
    console.log('── per-subsystem cpu ms   (p50 / p99 / max)');
    for (const [name, s] of sys) console.log(`     ${name.padEnd(10)} ${f(s.p50)} / ${f(s.p99)} / ${f(s.max)}`);
  }
  if (r.shaderLinks.length) {
    console.log(`── shader links after start: ${r.shaderLinks.length}`);
    for (const l of r.shaderLinks.slice(0, 8)) {
      console.log(`     frame ${l.frame} +${l.added} prog  render ${f(l.renderMs)} ms  interval ${f(l.dtMs)} ms`
        + (l.names ? `  [${l.names.join(', ')}]` : ''));
    }
  }
  if (Object.keys(r.marks).length) {
    console.log('── perf.mark() tags');
    for (const [k, v] of Object.entries(r.marks)) {
      console.log(`     ${k.padEnd(16)} on ${v.frames} frames  interval p99 ${f(v.with?.p99)} vs ${f(v.without?.p99)} without`);
    }
  }
  if (r.spikes.length) {
    console.log(`── spikes > threshold: ${r.spikes.length}`);
    for (const s of r.spikes.slice(0, 12)) {
      const top = Object.entries(s.sys).map(([k, v]) => `${k} ${f(v)}`).join(' ');
      console.log(`     f${String(s.frame).padStart(4)}  ${f(s.dtMs)} ms  upd ${f(s.updateMs)} rnd ${f(s.renderMs)}`
        + `  dProg ${s.dPrograms} dGeo ${s.dGeometries} dTex ${s.dTextures} calls ${s.calls}`
        + (top ? `  [${top}]` : '') + (s.marks ? `  marks ${JSON.stringify(s.marks)}` : ''));
    }
  }
  console.log(`── drift (window quarters, p50 interval): ${r.drift.map((d) => f(d.p50dt)).join('  ')}`
    + `   render: ${r.drift.map((d) => f(d.p50render)).join('  ')}`);
}

// ---- main -------------------------------------------------------------------
async function main() {
  const { arg, num, flag } = makeArgs();
  const opts = {
    seconds: num('seconds', 12),
    w: num('w', 1600), h: num('h', 900), dpr: num('dpr', 1),
    start: arg('start', 'hero'),
    lead: num('lead', 1.2),
    amp: num('carve-amp', 0.85),
    period: num('carve-period', 2.6),
    straight: flag('straight'),
    prod: flag('prod'),
    gpuTimer: !flag('no-gpu-timer'),
    syncGPU: flag('sync-gpu'),
    spikeMs: num('spike-ms', 20),
    json: arg('json', null),
    dumpFrames: flag('frames'),
  };

  const server = await startServer({ prod: opts.prod, port: 5301 });
  const { browser, page, errors } = await launch(opts);
  let code = 0;
  try {
    const env = await boot(page, server.url);
    console.log(`build: ${server.mode}   import.meta.env.DEV=${env.dev}   gpu: ${env.gpu}`);
    console.log(`backbuffer: ${env.gfx.drawingBuffer.join('x')} (${env.gfx.megapixels} Mpx)  `
      + `dpr=${env.gfx.devicePixelRatio} pixelRatio=${env.gfx.pixelRatio} antialias=${env.gfx.antialias}`);
    console.log(`programs after boot warm-up: ${env.programs}  ${JSON.stringify(env.warmShaders)}`);
    console.log(`path: ${opts.straight ? 'straight coast' : `linked carves amp ${opts.amp} period ${opts.period}s`} from "${opts.start}"`);
    if (!env.gpuTimerAvailable) console.log('NOTE: EXT_disjoint_timer_query_webgl2 unavailable — GPU numbers are CPU wall clock.');

    await installPath(page, { lead: opts.lead, amp: opts.amp, period: opts.period, straight: opts.straight });

    const report = await measureWindow(page, {
      start: opts.start, settleMs: Math.max(1500, opts.lead * 1000 + 400),
      dwellMs: opts.seconds * 1000, gpuTimer: opts.gpuTimer, syncGPU: opts.syncGPU, spikeMs: opts.spikeMs,
    });
    printReport(report, `— ${server.mode}, ${env.gfx.megapixels} Mpx`);
    const warm = await page.evaluate(() => window.__harness.warmShaders?.log ?? null);
    if (warm) console.log(`── renderer.compile() passes: ${JSON.stringify(warm)}`);

    if (opts.json) {
      const frames = opts.dumpFrames ? await page.evaluate(() => window.__harness.perf.frames()) : null;
      await fs.mkdir(path.dirname(path.resolve(ROOT, opts.json)), { recursive: true });
      await fs.writeFile(path.resolve(ROOT, opts.json), JSON.stringify({ env, opts, report, frames }, null, 2));
      console.log(`\nwrote ${opts.json}`);
    }
  } catch (e) {
    errors.push('harness: ' + (e?.message ?? String(e)));
    code = 1;
  } finally {
    if (errors.length) { code = 1; console.error('\n--- errors ---'); errors.slice(0, 20).forEach((e) => console.error('  ' + e)); }
    await browser.close();
    await server.close();
    process.exit(code);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
