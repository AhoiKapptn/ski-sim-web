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
 *  4c recover-after-churn
 *                    Recovery must survive an ERRATIC interval history. The
 *                    censored test was once derived from a session-monotone
 *                    minimum interval, which one short rAF tick lowered forever —
 *                    after which the ratchet was back, silently. Churns the frame
 *                    time (gut/un-gut x3) before demanding full recovery.
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
  startServer, launch, boot, installPath, sleep, makeArgs, urlWith,
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
async function session(dpr, query, size = {}) {
  const { browser, page, errors } = await launch({ ...size, dpr });
  // NOT frozen: the controller is the thing under test here.
  await boot(page, urlWith(server.url, query), { freezeAdaptive: false });
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
    // Two DIFFERENT preconditions, and conflating them reports the wrong cause.
    // If the controller never sampled at all the page was rAF-throttled — with
    // `lastDecision === null` the p70 test sees Infinity and would blame the
    // machine for being slow when in fact it was never scheduled.
    if (!rose && up._nSamples === 0) {
      check('step-up-at-30', false,
        'PRECONDITION FAILED — the controller never accumulated a window '
        + '(_nSamples 0), so the page was rAF-throttled, not slow. Another headless '
        + 'Chrome was almost certainly competing. Re-run with --only.');
    } else if (!rose && lastP70 > 34.0) {
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

  // --- 4c: erratic frame-time history must not poison recovery --------------
  // REGRESSION for the fourth incarnation of the ratchet. The censored test used
  // to be "is p70 near the session-minimum interval", and that minimum was a
  // monotone accumulator: one short rAF interval lowered it forever, and once it
  // sat below the real tick the test could never fire again and the controller
  // was a one-way ratchet for the rest of the session. Nothing in the suite
  // exercised a session whose interval history was erratic BEFORE recovery was
  // needed.
  //
  // So: churn the frame time hard — gut and un-gut repeatedly, which swings the
  // interval between the 16.7 ms floor and 30-60 ms and drags a running minimum
  // down — and only then remove the load for good and demand full recovery.
  {
    const s = await session(2, '?adaptive=1');
    await sleep(HOLD);
    await s.page.evaluate((src) => { eval(src)(); }, KIT_SRC);
    for (let i = 0; i < 3; i++) {
      await s.page.evaluate(() => window.__abl.on('allscene'));
      await sleep(5000);
      await s.page.evaluate(() => window.__abl.allOff());
      await sleep(5000);
    }
    const churned = await s.info();
    await s.page.evaluate(() => window.__abl.on('allscene'));
    await sleep(8000);
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
      check('recover-after-churn', false,
        `PRECONDITION FAILED — gutted frame is ${gutted.toFixed(1)} ms p70; machine too loaded.`);
    } else {
      let back = await s.info();
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline && back.resolutionScale < 1) {
        await sleep(2000);
        back = await s.info();
      }
      check('recover-after-churn', back.resolutionScale === 1,
        `after 3 gut/un-gut cycles (scale was ${churned.resolutionScale}): -> ${back.resolutionScale} `
        + `(${back.megapixels} Mpx), gutted p70 ${gutted.toFixed(1)} ms`
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
    // This case used to assert "stayed at 0.6", which was true only while every
    // rung above 0.6 was over budget on the test machine — the header has
    // always documented that ?rscale + ?adaptive may legitimately climb once
    // the frame has headroom, and the snow-shader rock gate made 0.7 (2.8 Mpx)
    // genuinely meet 60 fps here, so the old assertion now fails on correct
    // behaviour. The bug this case exists for is the index/scale desync that
    // stepped UP to 0.90 — 2.25x the pixels — WHILE OVER BUDGET, in the very
    // window that demanded a step down. So assert the actual invariant: no
    // logged upward step may carry an over-budget p70. (b*1.02 = 17.0 ms is
    // the controller's own "meeting" bound at 60 fps; 17.1 allows float noise.)
    const badUp = (i.adaptiveLog || []).filter((e) => e.to > e.from && e.p70 > 17.1);
    check('rscale-nostepup', badUp.length === 0,
      `explicit rscale 0.6 + adaptive: scale ${i.resolutionScale}, events ${i.adaptiveEvents}, `
      + `up-steps while over budget: ${JSON.stringify(badUp)} (the desync bug stepped 0.6 -> 0.90 over budget)`);
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

  // --- 8: display-size awareness --------------------------------------------
  // Every measurement in this project's history used a 1600x900 CSS viewport.
  // A real fullscreen window is 7.7 Mpx (16" MacBook) to 14.7 Mpx (5K), where
  // the fractional 0.7 floor still rendered 7.2 Mpx — measured p50 53.3 ms
  // NATIVE, i.e. the controller's "no frame over 33 ms" guarantee silently
  // broke exactly on big displays — and the walk down from a scale-1 start was
  // a 15-20 s slideshow after every boot. Both fixes are config-visible, so
  // these assertions are deterministic and do not depend on this machine's
  // frame cost.
  {
    // A 5K fullscreen backbuffer: 2560x1440 CSS at DPR 2 = 14.75 Mpx native.
    const s = await session(2, '', { w: 2560, h: 1440 });
    const i = await s.info();
    // START must be capped at INIT_MPX (5.8): sqrt(5.8 / 14.75) = 0.63, so the
    // starting rung is 0.6 (5.3 Mpx) — not native, and no slideshow-walk.
    check('start-capped', i.resolutionScale <= 0.6 + 1e-6 && i.megapixels < 5.9,
      `5K start: scale ${i.resolutionScale}, ${i.megapixels} Mpx (was scale 1 = 14.75 Mpx)`);
    // The FLOOR must relax by display size: 0.4 renders 2.36 Mpx >= FLOOR_MPX
    // (2.3) here, so the deepest allowed rung must be 0.4, not 0.7.
    check('floor-mpx-relaxed', i.adaptiveSteps[i.adaptiveMaxStep] <= 0.4 + 1e-6,
      `5K floor: deepest rung ${i.adaptiveSteps[i.adaptiveMaxStep]} (fractional floor left 7.2 Mpx)`);
    await s.close();
  }
  {
    // ...and on the 5.76 Mpx backbuffer, the START is unchanged (5.76 <=
    // INIT_MPX, so captures still boot at native), and the deepest rung is 0.5
    // — 1.44 Mpx, exactly the 1600x900 every review of this project was judged
    // at, and never less (0.4 would render 0.92 Mpx and stays forbidden).
    // FLOOR_MPX was recalibrated from 2.3 to 1.4 after measuring pinned rungs
    // in a HEADED browser: the real environment is 3-5 ms/frame slower than
    // headless at equal Mpx, and the old cutoff pinned the controller at 0.7 =
    // p50 20.5 ms with downTest=true — wanting a rung it was not allowed.
    const s = await session(2, '');
    const i = await s.info();
    check('floor-mpx-576', Math.abs(i.adaptiveSteps[i.adaptiveMaxStep] - 0.5) < 1e-6
      && i.resolutionScale === 1,
      `5.76 Mpx: deepest rung ${i.adaptiveSteps[i.adaptiveMaxStep]} (want 0.5 = 1.44 Mpx, the review resolution), start scale ${i.resolutionScale} (must stay native)`);
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
