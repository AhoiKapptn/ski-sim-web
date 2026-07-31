/**
 * Alpine — input.
 *
 * Keyboard and gamepad fold into the same analogue channels. Steering sets the
 * *edge angle* the physics should aim for, never a yaw rate: the arc is the
 * physics' business.
 *
 *   A / D, ←/→ or left stick X   steer   (-1 right .. +1 left)
 *   W / ↑ / S / ↓ / Shift or RT  tuck    (0..1 analogue — get low, go faster)
 *   Ctrl / X or LT               brake   (0..1, hockey stop)
 *   Space or A-button            pop     (hold to pre-load, release to unweight)
 *
 * There is no "forward" in skiing — gravity is the throttle — so both the
 * "forward" key (W/↑) and the "get low" key (S/↓/Shift) drive the same tuck
 * channel. Whichever mental model the player brings, the key that should make
 * them faster does.
 *
 * ### Space is a pop, not a jump, and NOTHING else touches it
 *
 * W/↑ used to be bound to `jump` alongside Space, and physics.js fires its pop on
 * key *release*. So the most natural key in the scheme — hold to go, let go to
 * coast — launched the rider 3.7 m into the air. That binding is gone and must
 * not come back: air is earned from terrain (see the leg-travel/`gap` model in
 * physics.js), not from a keystroke. Space itself now only *modulates* a takeoff;
 * on flat ground its whole authority is a ~8 cm unweight.
 *
 * If you add a key here, ask what happens when the player *releases* it.
 *
 * `window.__inputOverride = {steer,crouch,jump,brake}` lets tools/motion-trace.mjs
 * drive a scripted run; set it to null to hand control back.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Deadzone + response curve: fine near centre, full authority at the stops. */
function curve(v, dead = 0.14, expo = 0.55) {
  const a = Math.abs(v);
  if (a < dead) return 0;
  const t = (a - dead) / (1 - dead);
  return Math.sign(v) * (t * (1 - expo) + t * t * t * expo);
}

/** Asymmetric ramp — quick to load an edge, quicker to release it. */
function ramp(cur, target, attack, release, dt) {
  const rate = Math.abs(target) > Math.abs(cur) && target * cur >= 0 ? attack : release;
  const d = target - cur;
  const m = rate * dt;
  return Math.abs(d) <= m ? target : cur + Math.sign(d) * m;
}

// --- steering feel -----------------------------------------------------------
// A digital key has to stand in for a stick, and the shape of that stand-in is
// most of what "how a turn feels" means.
//
//   STEER_ATTACK   how fast holding the key builds *commitment*. Was 4.2 /s, so
//                  a tap reached full lock in ~0.24 s and the turn read as a
//                  switch: on, 60 deg of edge, 10 m radius. 2.2 /s spreads the
//                  build over ~0.45 s and the physics' edge-rate limit stretches
//                  it further, so the arc keeps tightening the longer you hold.
//   STEER_RELEASE  weight transfer really is asymmetric — standing up out of a
//                  turn is far quicker than moving your mass inside one. Kept
//                  ~2.7x the attack rate, but no longer so violent that it trips
//                  the physics' rebound pop.
//   STEER_KICK     the *anti*-lag term, and the reason slowing the ramp does not
//                  make the controls mushy: the instant a steer key goes down the
//                  skis tip onto a small edge. Real too — tipping the ski is
//                  instant, it is moving the body inside the arc that takes time.
//                  Applied BEFORE the speed shaping below, so the initial bite is
//                  ~0.2 g at any speed rather than a fixed edge angle.
const STEER_ATTACK = 2.2;
const STEER_RELEASE = 6.0;
const STEER_KICK = 0.16;

export function createControls() {
  const keys = Object.create(null);
  const down = (e) => {
    keys[e.code] = true;
    // Stop the page scrolling out from under the game.
    if (/^(Arrow|Space)/.test(e.code)) e.preventDefault();
  };
  const up = (e) => { keys[e.code] = false; };
  if (typeof addEventListener === 'function') {
    addEventListener('keydown', down, { passive: false });
    addEventListener('keyup', up);
    addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  }

  let steer = 0, tuck = 0, brake = 0;
  let jumpPrev = false;

  const k = (...codes) => codes.some((c) => keys[c]);

  function pad() {
    const gp = typeof navigator !== 'undefined' && navigator.getGamepads
      ? Array.from(navigator.getGamepads()).find((g) => g && g.connected) : null;
    if (!gp) return null;
    const ax = gp.axes || [], bt = gp.buttons || [];
    const btn = (i) => (bt[i] ? (bt[i].value ?? (bt[i].pressed ? 1 : 0)) : 0);
    // Left stick X is +right in the browser API; +steer is left, so negate.
    let s = -curve(ax[0] || 0);
    if (btn(14) > 0.5) s = 1;            // dpad left
    if (btn(15) > 0.5) s = -1;           // dpad right
    return {
      steer: clamp(s, -1, 1),
      tuck: clamp(Math.max(btn(7), btn(1) /* B */), 0, 1),          // RT
      brake: clamp(Math.max(btn(6), btn(2) /* X */), 0, 1),         // LT
      jump: btn(0) > 0.5,                                           // A
    };
  }

  return {
    update(dt, state) {
      const i = state.input;
      const ov = typeof window !== 'undefined' ? window.__inputOverride : null;
      if (ov) {
        i.steer = clamp(ov.steer || 0, -1, 1);
        i.crouch = clamp(ov.crouch || 0, 0, 1);
        i.brake = clamp(ov.brake || 0, 0, 1);
        i.jump = !!ov.jump;
        i.jumpPressed = i.jump && !jumpPrev;
        jumpPrev = i.jump;
        steer = i.steer; tuck = i.crouch; brake = i.brake;
        return;
      }

      const step = Math.min(Math.max(dt, 0), 0.05);
      const g = pad();

      // --- steer ------------------------------------------------------------
      const kSteer = (k('KeyA', 'ArrowLeft') ? 1 : 0) - (k('KeyD', 'ArrowRight') ? 1 : 0);
      if (g && Math.abs(g.steer) > 0.02) {
        steer = g.steer;                                    // analogue: direct
      } else {
        steer = ramp(steer, kSteer, STEER_ATTACK, STEER_RELEASE, step);
        // Tip the skis at once, then build. Only from (near) flat — coming off
        // the opposite edge the ramp has to walk through zero on its own or the
        // cross-over would snap.
        if (kSteer !== 0 && Math.abs(steer) < STEER_KICK) steer = kSteer * STEER_KICK;
      }

      // --- tuck / brake -----------------------------------------------------
      // W/↑ are tuck, NOT jump. See the header: their release used to launch the
      // rider, which is the one thing a ski sim must never do.
      const kTuck = k('KeyW', 'ArrowUp', 'KeyS', 'ArrowDown', 'ShiftLeft', 'ShiftRight') ? 1 : 0;
      const kBrake = k('ControlLeft', 'ControlRight', 'KeyX') ? 1 : 0;
      tuck = ramp(tuck, g ? Math.max(g.tuck, kTuck) : kTuck, 3.0, 4.5, step);
      brake = ramp(brake, g ? Math.max(g.brake, kBrake) : kBrake, 5.0, 7.0, step);

      const jump = k('Space') || !!(g && g.jump);

      // --- speed-shaped steering --------------------------------------------
      // The same stick travel means very different things at 5 m/s and at 30 m/s:
      // at walking pace you want the whole range to pivot the skis, at 110 km/h
      // half a stick is a 3 g edge set and the rider darts. So bend the curve, do
      // not cap it — the ceiling stays at full lock, only the middle gets finer.
      const fine = clamp(((state.speed || 0) - 10) / 22, 0, 1);
      const sh = (x) => Math.sign(x) * Math.pow(Math.abs(x), 1 + 0.85 * fine);

      i.steer = clamp(sh(steer), -1, 1);
      i.crouch = clamp(tuck, 0, 1);
      i.brake = clamp(brake, 0, 1);
      i.jump = jump;
      i.jumpPressed = jump && !jumpPrev;
      jumpPrev = jump;
    },
  };
}
