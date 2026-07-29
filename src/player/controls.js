/**
 * Alpine — input.
 *
 * Keyboard and gamepad fold into the same analogue channels. Steering sets the
 * *edge angle* the physics should aim for, never a yaw rate: the arc is the
 * physics' business.
 *
 *   A / D, ←/→ or left stick X   steer   (-1 right .. +1 left)
 *   S / ↓ / Shift or RT          tuck    (0..1 analogue)
 *   Space / W / ↑ or A-button    jump    (hold to pre-load, release to pop)
 *   Ctrl / X or LT               brake   (0..1, hockey stop)
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
        steer = ramp(steer, kSteer, 4.2, 7.5, step);        // keyboard: shaped ramp
      }

      // --- tuck / brake -----------------------------------------------------
      const kTuck = k('KeyS', 'ArrowDown', 'ShiftLeft', 'ShiftRight') ? 1 : 0;
      const kBrake = k('ControlLeft', 'ControlRight', 'KeyX') ? 1 : 0;
      tuck = ramp(tuck, g ? Math.max(g.tuck, kTuck) : kTuck, 3.0, 4.5, step);
      brake = ramp(brake, g ? Math.max(g.brake, kBrake) : kBrake, 5.0, 7.0, step);

      const jump = k('Space', 'KeyW', 'ArrowUp') || !!(g && g.jump);

      i.steer = clamp(steer, -1, 1);
      i.crouch = clamp(tuck, 0, 1);
      i.brake = clamp(brake, 0, 1);
      i.jump = jump;
      i.jumpPressed = jump && !jumpPrev;
      jumpPrev = jump;
    },
  };
}
