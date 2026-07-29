import * as THREE from 'three';
import { getActiveTerrain } from './physics.js';

/**
 * Alpine — third-person chase camera.
 *
 * Critically damped springs (Gems-style smooth-damp: no overshoot, no wobble, and
 * frame-rate independent) on three separate channels — boom yaw, camera position,
 * look target — so the camera *lags into* a turn and settles clean on the way out.
 * On top of that: speed FOV, a small bank into the carve, look-ahead that leads the
 * direction of travel, a lift on big air so the landing stays framed, and a
 * gForce/roughness shake that you feel rather than see.
 *
 * main.js only hands us the camera, so the terrain used for boom collision comes
 * from player/physics.js (same owner) via getActiveTerrain().
 */

const clamp = THREE.MathUtils.clamp;
const smoothstep = (x, a, b) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Critically damped spring towards `target`. `vel` is carried between frames. */
function smoothDampV(cur, target, vel, smoothTime, dt, tmp) {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  tmp.copy(cur).sub(target);                       // change
  const tx = (vel.x + omega * tmp.x) * dt;
  const ty = (vel.y + omega * tmp.y) * dt;
  const tz = (vel.z + omega * tmp.z) * dt;
  vel.set((vel.x - omega * tx) * exp, (vel.y - omega * ty) * exp, (vel.z - omega * tz) * exp);
  cur.set(target.x + (tmp.x + tx) * exp, target.y + (tmp.y + ty) * exp, target.z + (tmp.z + tz) * exp);
}

function smoothDampS(cur, target, velRef, key, smoothTime, dt) {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (velRef[key] + omega * change) * dt;
  velRef[key] = (velRef[key] - omega * temp) * exp;
  return target + (change + temp) * exp;
}

const wrapPi = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  return (a < 0 ? a + Math.PI * 2 : a) - Math.PI;
};

export function createChaseCam(camera) {
  const FOV_BASE = camera.fov || 58;

  const pos = new THREE.Vector3();
  const posVel = new THREE.Vector3();
  const look = new THREE.Vector3();
  const lookVel = new THREE.Vector3();
  const want = new THREE.Vector3();
  const wantLook = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const boomDir = new THREE.Vector3();
  const travel = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const probe = new THREE.Vector3();
  const camUp = new THREE.Vector3(0, 1, 0);

  const v = { yaw: 0, fov: 0, roll: 0, lift: 0, shake: 0 };
  let yaw = null, fov = FOV_BASE, roll = 0, lift = 0, shakeAmp = 0;
  let airLift = 0, kick = 0, kickV = 0, t = 0;
  let init = false;

  return {
    update(dt, state) {
      dt = clamp(dt, 0, 0.1);
      t += dt;

      const terrain = getActiveTerrain();
      const spd = state.speed || 0;
      // Linear speed ramp: smoothstep is too flat at the low end and normal
      // play speeds (12-30 m/s) would barely widen the FOV.
      const sT = clamp((spd - 7) / 27, 0, 1);
      const m = state.motion || {};

      // ---- boom yaw: behind the skis, biased towards where he is actually going
      const headYaw = state.heading;
      let travelYaw = headYaw;
      if (spd > 2.5) travelYaw = Math.atan2(-state.vel.x, -state.vel.z);
      const yawTarget = headYaw + wrapPi(travelYaw - headYaw) * 0.35;

      if (yaw === null) { yaw = yawTarget; v.yaw = 0; }
      // unwrap so the spring never takes the long way round
      yaw = yawTarget + wrapPi(yaw - yawTarget);
      yaw = smoothDampS(yaw, yawTarget, v, 'yaw', 0.30 + 0.12 * (1 - sT), dt);
      // Hard cap on the lag. A hockey stop pivots at ~3 rad/s, and an uncapped
      // spring would sit 80 deg off the skis and shove the rider out of frame.
      const lagMax = 0.45;
      const lag = wrapPi(yaw - yawTarget);
      if (lag > lagMax || lag < -lagMax) {
        yaw = yawTarget + clamp(lag, -lagMax, lagMax);
        v.yaw *= 0.5;
      }

      // ---- boom geometry ------------------------------------------------------
      airLift += ((state.airborne ? smoothstep(state.airTime, 0.15, 0.9) : 0) - airLift)
                 * Math.min(1, dt * 3.5);
      const dist = 5.6 + 2.6 * sT + 2.2 * airLift;
      const height = 2.05 + 0.85 * sT + 2.4 * airLift;

      // Tilt the boom with the slope so a steep pitch still shows the run ahead.
      const gn = state.groundNormal;
      up.set(0, 1, 0).lerp(gn, 0.62).normalize();
      boomDir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      boomDir.addScaledVector(up, -boomDir.dot(up));
      if (boomDir.lengthSq() < 1e-6) boomDir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      boomDir.normalize();

      // Springs run on the OFFSET from the skier, not on world position: a spring
      // chasing a moving target keeps a steady-state error of ~smoothTime*speed,
      // which at 30 m/s would stretch the boom by 6 m. Relative springing lags
      // only what should lag — turns, height, speed changes — at any speed.
      want.set(0, 0, 0).addScaledVector(boomDir, -dist).addScaledVector(up, height);

      // ---- look target: lead the direction of travel --------------------------
      travel.copy(state.vel);
      if (travel.lengthSq() < 1e-4) travel.set(-Math.sin(headYaw), 0, -Math.cos(headYaw));
      travel.normalize();
      const lead = clamp(4.0 + spd * 0.50, 4.0, 26);
      wantLook.set(0, 0, 0).addScaledVector(travel, lead).addScaledVector(up, 1.7);
      // Aim at the snow that far ahead rather than at a point in space: on a steep
      // pitch that drops the horizon out of the middle of the frame and shows the
      // run instead of the sky, and it costs one height sample.
      if (terrain) {
        const gy = terrain.height(state.pos.x + wantLook.x, state.pos.z + wantLook.z)
                   + 1.7 - state.pos.y;
        wantLook.y = wantLook.y * 0.55 + gy * 0.45;
      }

      // Big air: pull the look target down onto the predicted landing.
      if (state.airborne && terrain && state.airTime > 0.25) {
        probe.copy(state.pos); tmp2.copy(state.vel);
        let found = false;
        for (let i = 0; i < 14; i++) {
          tmp2.y -= 11.0 * 0.11;
          probe.addScaledVector(tmp2, 0.11);
          if (probe.y <= terrain.height(probe.x, probe.z)) { found = true; break; }
        }
        if (found) {
          probe.y = terrain.height(probe.x, probe.z) + 1.2;
          probe.sub(state.pos);
          wantLook.lerp(probe, 0.55 * smoothstep(state.airTime, 0.25, 1.0));
        }
      }

      // ---- snap on teleport, otherwise spring ---------------------------------
      const teleport = !init || dt >= 0.5 || pos.distanceToSquared(want) > 3600;
      if (teleport) {
        init = true;
        pos.copy(want); posVel.set(0, 0, 0);
        look.copy(wantLook); lookVel.set(0, 0, 0);
        yaw = yawTarget; v.yaw = 0;
        airLift = 0; lift = 0; kick = 0; kickV = 0;
      } else {
        smoothDampV(pos, want, posVel, 0.24 - 0.08 * sT, dt, tmp);
        smoothDampV(look, wantLook, lookVel, 0.12, dt, tmp);
      }
      pos.add(state.pos);
      look.add(state.pos);

      // ---- never clip the snow ------------------------------------------------
      // NB: the lift is applied to the OUTPUT, never written back into the spring
      // state, otherwise it accumulates against the spring and inflates the boom.
      if (terrain) {
        let need = 0;
        for (let i = 1; i <= 6; i++) {
          const f = i / 6;
          const px = state.pos.x + (pos.x - state.pos.x) * f;
          const pz = state.pos.z + (pos.z - state.pos.z) * f;
          const py = state.pos.y + 1.2 + (pos.y - (state.pos.y + 1.2)) * f;
          const clear = terrain.height(px, pz) + 1.1 + 0.6 * f;
          if (clear > py) need = Math.max(need, clear - py);
        }
        const liftT = Math.min(need, 12);
        // rise fast, sink slow — no popping as bumps pass under the boom
        lift += (liftT - lift) * Math.min(1, dt * (liftT > lift ? 16 : 4));
      } else lift = 0;

      // ---- shake: felt, not noticed ------------------------------------------
      const g = Math.abs(state.gForce || 0);
      const rough = clamp(m.roughness || 0, 0, 1);
      const ampT = clamp(0.055 * g + 0.10 * rough * sT + 0.05 * sT, 0, 0.30) * (state.airborne ? 0.25 : 1);
      shakeAmp += (ampT - shakeAmp) * Math.min(1, dt * 6);

      // landing kick (impulse into a damped spring, so it settles, never rings)
      if (m.landImpact > 0.5 && !state.airborne) kickV -= Math.min(9, m.landImpact * 0.55);
      kickV += (-kick * 260 - kickV * 22) * dt;
      kick += kickV * dt;
      kick = clamp(kick, -0.9, 0.9);

      const sx = Math.sin(t * 21.3) * 0.6 + Math.sin(t * 37.7) * 0.4;
      const sy = Math.sin(t * 26.1 + 1.7) * 0.6 + Math.sin(t * 44.3 + 0.4) * 0.4;

      camera.position.copy(pos);
      camera.position.y += lift + kick * 0.35;

      // ---- orient -------------------------------------------------------------
      camUp.set(0, 1, 0).lerp(gn, 0.14).normalize();
      camera.up.copy(camUp);
      camera.lookAt(look.x, look.y + kick * 0.15, look.z);

      // shake as a rotation in camera space (translation-free = no nausea)
      camera.rotateX(sy * shakeAmp * 0.055);
      camera.rotateY(sx * shakeAmp * 0.055);

      // bank into the carve
      const rollT = clamp(-(state.edge || 0) * 0.14 * (0.35 + 0.65 * sT)
                          - clamp((m.aLat || 0) / 30, -1, 1) * 0.045, -0.10, 0.10);
      roll = smoothDampS(roll, rollT, v, 'roll', 0.28, dt);
      camera.rotateZ(roll + sx * shakeAmp * 0.03);

      // ---- speed FOV ----------------------------------------------------------
      const fovT = FOV_BASE + 16 * sT + 3.5 * airLift + clamp(Math.abs(kick) * 3, 0, 3);
      fov = smoothDampS(fov, fovT, v, 'fov', 0.35, dt);
      if (Math.abs(camera.fov - fov) > 0.02) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }

      // back to offset space for the next frame
      pos.sub(state.pos);
      look.sub(state.pos);

      // debug hook for tools/motion-trace.mjs (no cost, no allocation)
      if (typeof window !== 'undefined') {
        const d = window.__camDebug || (window.__camDebug = {});
        d.dist = camera.position.distanceTo(state.pos);
        d.boom = dist; d.height = height; d.fov = fov; d.lift = lift;
        d.roll = roll; d.yawLag = wrapPi(yaw - headYaw); d.shake = shakeAmp; d.kick = kick;
      }
    },
  };
}
