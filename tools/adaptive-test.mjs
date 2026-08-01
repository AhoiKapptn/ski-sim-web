/**
 * Behavioural test for the adaptive resolution controller in src/core/engine.js.
 *
 *   node tools/adaptive-test.mjs
 *
 * Every case here is a bug that shipped in the first cut and was caught in
 * review, so each one is a regression test, not a smoke test. The controller is
 * only observable by DRIVING THE PAGE — it reads the presented frame interval, so
 * `harness.step()` cannot exercise it (trap 2) and neither can a unit test.
 *
 * Cases
 * -----
 *  1 inert-dpr1      ?adaptive=1 at DPR 1 must take ZERO steps. Enabling the
 *                    feature used to also set the MIN_MPX bypass, so this passed
 *                    for the wrong reason (the budget happened to be met).
 *  2 force-dpr1      ?adaptive=force at DPR 1 MUST step — proves case 1 is inert
 *                    because of the guard and not because nothing was happening.
 *  3 step-down       At DPR 2 it must leave native and reach its floor.
 *  4 step-up-at-30   From the floor, with the budget made easy to meet
 *                    (setTargetFps(30)), it must climb BACK.
 *  4b step-up-at-60  THE ONE THAT MATTERS. At the SHIPPED target of 60, settle at
 *                    the floor and then remove the LOAD (gut every material) —
 *                    the resolution must climb back. Case 4 passed for two
 *                    successive builds in which the shipped configuration was
 *                    still a one-way ratchet, because 30 fps puts the budget
 *                    ABOVE the refresh period and hides thresholds that are below
 *                    it. Both failed up-tests (`b*0.80` and then `b*0.95`) were
 *                    unsatisfiable at 60 and satisfiable at 30.
 *  5 freeze-record   It must not move while perf.recording, nor while frozen.
 *  6 rscale-pin      ?rscale=0.6 must pin (adaptive off). And with adaptive
 *                    forced on as well, a step DOWN from 0.6 must not go UP:
 *                    stepIndex used to be tracked separately from
 *                    resolutionScale, so ?rscale=0.6 stepped "down" to 0.90.
 *  7 pixelratio-pin  gfx.setPixelRatio(2) must survive a controller step. A step
 *                    used to null the pin, silently rescaling perf-ab's dpr arm.
 *
 * RUN THIS ALONE. It cost a debugging cycle to learn: with another headless
 * Chrome hammering the GPU in parallel, Chrome throttles rAF in the loser, the
 * controller never accumulates its 45-frame window, and `step-down`/`step-up`
 * fail with `lastDecision === null` — which looks exactly like a dead code path
 * and is not one. If a case fails, check `gfx.info()._nSamples` and `_graceMs`
 * before believing it: a stalled `_nSamples` means the page is not being
 * scheduled, not that the controller is broken.
 */
import {
  startServer, launch, boot, installPath, sleep, makeArgs,
} from './frametime.mjs';
import { KIT_SRC } from './ablation-kit.mjs';

const { num, flag, arg } = makeArgs();
// `--only step-up-at-60,step-down` runs a subset. Cases are independent sessions,
// so a subset is as valid as the whole suite — and on a loaded machine the whole
// suite is SLOWER than the sum of its parts, because leftover Chrome processes
// and thermal state carry across cases. Re-run a failure alone before believing it.
const ONLY = (arg('only', null) || '').split(',').map((x) => x.trim()).filter(Boolean);
const want = (n) => !ONLY.length || ONLY.includes(n);
const HOLD = num('hold', 11000);        // long enough for several HOLD_MS windows
const results = [];

function check(name, pass, detail) {
  if (!want(name)) return;
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} ${detail}`);
}

const server = await startServer({ port: 5331 });

/** Boot a fresh page, drive the carve path, return a probe handle. */
async function session(dpr, query) {
  const { browser, page, errors } = await launch({ dpr });
  // NOT frozen: the controller is the thing under test here.
  await boot(page, server.url + (query || ''), { freezeAdaptive: false });
  await installPath(page, { lead: 1.2, amp: 0.85, period: 2.6 });
  await page.evaluate(() => { window.__setAuto?.(true); window.__path.restart(0, 700, Math.PI); });
  return {
    page, browser, errors,
    info: () => page.evaluate(() => window.__harness.gfx.info()),
    close: () => browser.close(),
  };
}

try {
  // --- 1 + 2: the MIN_MPX guard, and that it is the guard doing the work -----
  {
    const s = await session(1, '?adaptive=1');
    await sleep(HOLD);
    const i = await s.info();
    check('inert-dpr1', i.adaptiveEvents === 0 && i.resolutionScale === 1,
      `${i.megapixels} Mpx, adaptive=${i.adaptive}, forced=${i.adaptiveForced}, events=${i.adaptiveEvents}, scale=${i.resolutionScale}`);
    await s.close();
  }
  {
    const s = await session(1, '?adaptive=force&fpstarget=120');
    await sleep(HOLD);
    const i = await s.info();
    check('force-dpr1', i.adaptiveEvents > 0,
      `bypass guard at ${i.megapixels} Mpx: events=${i.adaptiveEvents}, scale=${i.resolutionScale} (proves case 1 is the guard, not luck)`);
    await s.close();
  }

  // --- 3 + 4: down, then back up --------------------------------------------
  {
    const s = await session(2, '?adaptive=1');
    await sleep(HOLD);
    const down = await s.info();
    check('step-down', down.resolutionScale < 1 && down.adaptiveEvents > 0,
      `${down.megapixels} Mpx, scale ${down.resolutionScale}, events ${down.adaptiveEvents}`);

    // Make the budget easy: at 30 fps the floor comfortably meets it, so the
    // controller must climb. This is the branch that was dead.
    await s.page.evaluate(() => window.__harness.gfx.setTargetFps(30));
    const beforeUp = (await s.info()).resolutionScale;
    await sleep(HOLD + 12000);
    const up = await s.info();
    // PRECONDITION. This case relaxes the BUDGET instead of removing the load, so
    // it only means anything if the machine can actually meet 30 fps at the floor.
    // Under accumulated suite load it sometimes cannot (observed p70 50-66 ms
    // where the unloaded baseline is 34), and then the controller is correctly
    // refusing to climb into a budget it cannot hold. That is the machine, not a
    // ratchet — and it is exactly why `step-up-at-60`, which removes the load
    // instead, is the case that gates this behaviour.
    // The criterion is "did an UP step ever happen", not "is the net scale
    // higher". This branch was DEAD — unsatisfiable at any target above ~48 fps —
    // so its existence is the thing under test. Net scale is not a fair test on a
    // loaded machine: an observed run went 0.8 -> 0.9 -> 0.8 -> 0.7 because
    // background load moved p70 from 33 to 75 ms mid-window, which is the
    // controller behaving correctly.
    const rose = up.adaptiveLog.some((e) => e.to > e.from);
    const lastP70 = up.lastDecision ? up.lastDecision.p70 : Infinity;
    if (!rose && lastP70 > 34.0) {
      check('step-up-at-30', false,
        `PRECONDITION FAILED — frame is ${lastP70} ms p70, so this machine cannot hold even `
        + '30 fps at the floor. Refusing to climb is correct. Re-run alone; step-up-at-60 is '
        + 'the case that actually gates the up-path.');
    } else {
      check('step-up-at-30', rose,
        `target 30fps from scale ${beforeUp}: up-step seen=${rose}, now ${up.resolutionScale}, log ${JSON.stringify(up.adaptiveLog.slice(-4))}`);
    }
    await s.close();
  }

  // --- 4b: THE ONE THAT MATTERS — up-step at the SHIPPED target -------------
  // Relaxing the budget to 30 fps is not the shipped configuration, and a suite
  // that only tests that passes while the product ships a one-way ratchet. Leave
  // the budget at 60 and take the LOAD away instead: settle at the floor, then
  // gut every material so the frame is trivially cheap, and require the
  // resolution to climb all the way back to native.
  {
    const s = await session(2, '?adaptive=1');
    await sleep(HOLD);
    const settled = await s.info();
    await s.page.evaluate((src) => { eval(src)(); window.__abl.on('allscene'); }, KIT_SRC);
    await sleep(8000);   // let ~120 program relinks finish

    // PRECONDITION, asserted rather than assumed. The whole point of this case is
    // "the load is gone, so the resolution must come back" — if the machine is so
    // loaded that even a fully gutted scene cannot hold vsync, the premise is
    // false and a failure here would be about the machine, not the controller.
    // Measured independently of the controller, straight off rAF.
    const gutted = await s.page.evaluate(() => new Promise((res) => {
      const d = []; let last = 0, n = 0;
      const f = (t) => {
        if (last) d.push(t - last);
        last = t;
        if (++n < 150) requestAnimationFrame(f);
        else { d.sort((a, b) => a - b); res(d[Math.floor(d.length * 0.7)]); }
      };
      requestAnimationFrame(f);
    }));
    if (gutted > 19) {
      check('step-up-at-60', false,
        `PRECONDITION FAILED — gutted frame is still ${gutted.toFixed(1)} ms p70, so this machine `
        + 'cannot hold vsync with no shading work at all. That is machine load, not the controller. '
        + 'Re-run alone on a quiet machine.');
    } else {
      // Climbing the whole ladder is slow by design: every index carries an 8 s
      // backoff from the down-step that left it, and each rung needs two agreeing
      // windows. 0.7 -> 1.0 is three rungs. Poll rather than sleep a fixed time so
      // a pass does not depend on timing luck, and so the failure message can show
      // WHY it stopped.
      let back = await s.info();
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline && back.resolutionScale < 1) {
        await sleep(2000);
        back = await s.info();
      }
      check('step-up-at-60', back.resolutionScale === 1,
        `gutted frame ${gutted.toFixed(1)} ms p70; scale ${settled.resolutionScale} -> ${back.resolutionScale} `
        + `(${back.megapixels} Mpx), log ${JSON.stringify(back.adaptiveLog.slice(-4))}`
        + (back.resolutionScale < 1 ? `, stuck at ${JSON.stringify(back.lastDecision)}` : ''));
    }
    await s.close();
  }

  // --- 5: frozen during a measurement --------------------------------------
  {
    const s = await session(2, '?adaptive=1');
    // Long enough that the controller has ALREADY stepped before we freeze it.
    // Freezing from a state where nothing had happened yet proves much less.
    await sleep(9000);
    // (a) perf.recording
    await s.page.evaluate(() => window.__harness.perf.start({ gpuTimer: false }));
    const a0 = await s.info();
    await sleep(6000);
    const a1 = await s.info();
    await s.page.evaluate(() => window.__harness.perf.stop());
    const recOk = a0.adaptiveEvents === a1.adaptiveEvents && a0.resolutionScale === a1.resolutionScale;
    // (b) explicit freeze()
    await s.page.evaluate(() => window.__harness.gfx.freeze());
    const b0 = await s.info();
    await sleep(6000);
    const b1 = await s.info();
    await s.page.evaluate(() => window.__harness.gfx.unfreeze());
    const frzOk = b0.adaptiveEvents === b1.adaptiveEvents && b0.resolutionScale === b1.resolutionScale;
    check('freeze-record', recOk && frzOk,
      `recording ${a0.adaptiveEvents}->${a1.adaptiveEvents} @${a0.resolutionScale}->${a1.resolutionScale}; `
      + `freeze() ${b0.adaptiveEvents}->${b1.adaptiveEvents} @${b0.resolutionScale}->${b1.resolutionScale}`);
    await s.close();
  }

  // --- 6: ?rscale= pins, and never steps upward when told to step down ------
  {
    const s = await session(2, '?rscale=0.6');
    await sleep(HOLD);
    const i = await s.info();
    check('rscale-pin', i.adaptive === false && i.adaptiveEvents === 0 && Math.abs(i.resolutionScale - 0.6) < 1e-6,
      `adaptive=${i.adaptive} (pinned=${i.rscalePinned}), scale ${i.resolutionScale}, events ${i.adaptiveEvents}`);
    await s.close();
  }
  {
    const s = await session(2, '?rscale=0.6&adaptive=1&rfloor=0.6');
    await sleep(HOLD);
    const i = await s.info();
    // 0.6 is the floor here, so the only legal outcome is "stayed at 0.6".
    // The bug produced 0.90 — 2.25x the pixels — while trying to reduce cost.
    check('rscale-nostepup', i.resolutionScale <= 0.6 + 1e-6,
      `explicit rscale 0.6 + adaptive: scale ${i.resolutionScale} (bug gave 0.90), events ${i.adaptiveEvents}`);
    await s.close();
  }

  // --- 6b: setResolutionScale() then let it act ------------------------------
  {
    const s = await session(2, '?adaptive=1');
    await sleep(2500);
    await s.page.evaluate(() => window.__harness.gfx.setResolutionScale(0.8));
    const b = await s.info();
    await sleep(HOLD);
    const a = await s.info();
    check('setscale-step', a.resolutionScale <= b.resolutionScale + 1e-6,
      `set 0.8 then stepped: ${b.resolutionScale} -> ${a.resolutionScale} (must not rise while over budget)`);
    await s.close();
  }

  // --- 7: setPixelRatio() pin survives -------------------------------------
  {
    const s = await session(2, '?adaptive=1');
    await sleep(2500);
    // The event count at PIN TIME, not zero: the controller is legitimately
    // allowed to have stepped before the pin was applied. What must hold is that
    // nothing moves after it.
    const b = await s.page.evaluate(() => window.__harness.gfx.setPixelRatio(2));
    const eventsAtPin = (await s.info()).adaptiveEvents;
    await sleep(HOLD);
    const a = await s.info();
    check('pixelratio-pin', Math.abs(a.megapixels - b.megapixels) < 0.01 && a.adaptiveEvents === eventsAtPin,
      `pinned ${b.megapixels} Mpx -> ${a.megapixels} Mpx, events ${eventsAtPin} -> ${a.adaptiveEvents} (bug gave 0.706 Mpx)`);
    await s.close();
  }
} catch (e) {
  console.error('harness error:', e?.message ?? e);
  results.push({ name: 'harness', pass: false, detail: String(e?.message ?? e) });
} finally {
  await server.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) console.log(`FAILED: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(failed.length ? 1 : 0);
}
