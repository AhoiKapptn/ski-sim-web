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
  const side = new THREE.Vector3();

  const v = { yaw: 0, fov: 0, roll: 0, lift: 0, shake: 0, lat: 0, susp: 0, boom: 0 };
  let yaw = null, fov = FOV_BASE, roll = 0, lift = 0, shakeAmp = 0;
  let airLift = 0, kick = 0, kickV = 0, t = 0;
  let lat = 0, susp = 0, boom = 0, pump = 0;
  let init = false;

  return {
    update(dt, state) {
      dt = clamp(dt, 0, 0.1);
      t += dt;

      const terrain = getActiveTerrain();
      const spd = state.speed || 0;
      // Linear speed ramp: smoothstep is too flat at the low end and normal
      // play speeds (12-30 m/s) would barely widen the FOV.
      const sT = clamp((spd - 4) / 24, 0, 1);
      const m = state.motion || {};

      // ---- breathing ----------------------------------------------------------
      // Two slow incommensurate sines per channel: never repeats, never reads as a
      // wobble, and it is the difference between a camera and a tripod. Amplitude
      // is sub-degree and scales with speed, so a stationary rider is rock steady.
      const brY = Math.sin(t * 0.53) * 0.6 + Math.sin(t * 0.83 + 2.1) * 0.4;
      const brX = Math.sin(t * 0.41 + 1.3) * 0.6 + Math.sin(t * 0.67 + 0.5) * 0.4;
      const brZ = Math.sin(t * 0.37 + 4.0) * 0.6 + Math.sin(t * 0.61 + 1.9) * 0.4;

      // ---- suspension: the boom shares the rider's legs ------------------------
      // physics publishes how far the legs are extended over a roller (suspension)
      // and how hard the snow is pushing back up through them (squash). Feeding
      // that straight into the boom length + height is what makes a compression
      // read as weight rather than as a bump in the heightfield.
      const suspT = clamp((m.suspension || 0) - (m.squash || 0) * 1.2
                          - clamp(m.compression || 0, 0, 1.4) * 0.55, -1, 1);
      susp = smoothDampS(susp, suspT, v, 'susp', 0.16, dt);

      // ---- boom yaw: behind the skis, biased towards where he is actually going
      const headYaw = state.heading;
      let travelYaw = headYaw;
      if (spd > 2.5) travelYaw = Math.atan2(-state.vel.x, -state.vel.z);
      const yawTarget = headYaw + wrapPi(travelYaw - headYaw) * 0.35
                        + brX * 0.014 * (0.25 + 0.75 * sT);

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
      // Pull back AND drop with speed: a low boom rakes the snow past the lens and
      // reads far faster than a high one, while the extra distance keeps the rider
      // whole in frame. Big air backs off and climbs so the landing stays framed.
      // Wide AND close. Widening the lens alone just shrinks the rider and makes
      // the frame feel empty; the look every shipped snow game uses is a short
      // boom on a wide lens, which keeps him the same size on screen while the
      // world stretches out around him and the snow rakes past the edges.
      const dist = 4.45 + 1.55 * sT + 2.6 * airLift - 0.55 * susp
                   + brZ * (0.05 + 0.16 * sT);
      const height = 1.62 - 0.28 * sT + 2.6 * airLift + 0.45 * susp
                     + brY * (0.05 + 0.14 * sT);

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

      // ---- composition: get the rider off the crosshair -----------------------
      // A chase cam that keeps the subject nailed to the centre of frame is what
      // makes a game read as a tech demo. Look *into* the turn: the aim point
      // swings towards the inside of the arc, which slides the rider out to the
      // outside third and shows the snow he is about to cut. Yaw rate drives it,
      // so it is zero on a straight run and unwinds by itself on the exit.
      side.set(Math.cos(yaw), 0, -Math.sin(yaw));      // camera right, world xz
      side.addScaledVector(up, -side.dot(up)).normalize();

      // (a) look into the arc
      let latT = clamp((m.yawRate || 0) / 1.15, -1, 1) * (state.airborne ? 0.25 : 1);
      // (b) and follow the run: where the fall line goes a lead-distance ahead.
      // On a straight schuss (a) is zero and this is the only thing keeping the
      // rider off the exact centre line — which is why the framing reads as a
      // camera operator following a run rather than a rig bolted to his back.
      if (terrain) {
        const n2 = terrain.normal(state.pos.x + travel.x * lead,
                                  state.pos.z + travel.z * lead, 14);
        const dl = Math.hypot(n2.x, n2.z);
        if (dl > 1e-4) latT -= clamp((n2.x * side.x + n2.z * side.z) / dl, -1, 1) * 0.95;
      }
      lat = smoothDampS(lat, clamp(latT, -1.05, 1.05), v, 'lat', 0.34, dt);
      wantLook.addScaledVector(side, -lat * 6.5 * (0.35 + 0.65 * sT));

      // ---- horizon guard ------------------------------------------------------
      // Aiming at the snow ahead is right on a mellow pitch and disastrous on a
      // steep one: the camera ends up staring at its own shadow with the sky gone.
      // Clamp the aim pitch so the ridgeline is always in frame and the rider
      // always sits low-centre, never dead-centre.
      tmp.copy(wantLook).sub(want);
      const horizD = Math.hypot(tmp.x, tmp.z);
      if (horizD > 0.5) {
        const aim = Math.atan2(tmp.y, horizD);
        const aimC = clamp(aim, -0.24, 0.06);
        if (aimC !== aim) wantLook.y = want.y + Math.tan(aimC) * horizD;
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
          const clear = terrain.height(px, pz) + 0.85 + 0.5 * f;
          if (clear > py) need = Math.max(need, clear - py);
        }
        const liftT = Math.min(need, 12);
        // rise fast, sink slow — no popping as bumps pass under the boom
        lift += (liftT - lift) * Math.min(1, dt * (liftT > lift ? 16 : 4));
      } else lift = 0;

      // ---- shake: felt, not noticed ------------------------------------------
      const g = Math.abs(state.gForce || 0);
      const rough = clamp(m.roughness || 0, 0, 1);
      const ampT = clamp(0.050 * g + 0.13 * rough * sT + 0.06 * sT, 0, 0.34) * (state.airborne ? 0.22 : 1);
      shakeAmp += (ampT - shakeAmp) * Math.min(1, dt * 6);

      // landing kick (impulse into a damped spring, so it settles, never rings)
      if (m.landImpact > 0.5 && !state.airborne) kickV -= Math.min(9, m.landImpact * 0.70);
      kickV += (-kick * 260 - kickV * 22) * dt;
      kick += kickV * dt;
      kick = clamp(kick, -0.9, 0.9);

      const sx = Math.sin(t * 21.3) * 0.6 + Math.sin(t * 37.7) * 0.4;
      const sy = Math.sin(t * 26.1 + 1.7) * 0.6 + Math.sin(t * 44.3 + 0.4) * 0.4;

      camera.position.copy(pos);
      camera.position.y += lift + kick * 0.35;

      // ---- orient -------------------------------------------------------------
      // Rake with the hill. A chase cam pinned to world-up on a cross-slope is the
      // single most "engine demo" thing a snow game can do — every shipped one
      // rolls into the face. 0.32 keeps ~1/3 of the slope tilt, which on a 30 deg
      // traverse is a 10 deg dutch angle: unmistakably alive, well short of the
      // horizon-tumbling that makes people put the pad down.
      camUp.set(0, 1, 0).lerp(gn, 0.32).normalize();
      camera.up.copy(camUp);
      camera.lookAt(look.x, look.y + kick * 0.15, look.z);

      // shake as a rotation in camera space (translation-free = no nausea)
      // Rotation-only shake: no translation, so it reads as a hand on the rig
      // rather than as the world sloshing — which is the thing that makes people
      // ill. Peak amplitude here is ~1.4 deg.
      camera.rotateX(sy * shakeAmp * 0.072);
      camera.rotateY(sx * shakeAmp * 0.072);

      // ---- bank into the carve ------------------------------------------------
      // Track the rider's true inclination (physics publishes the angle he is
      // actually balancing at) rather than the edge input, so the camera leans
      // with the LOAD: heavy at the belly of the turn, unwound at the transition.
      // A third of his lean, capped at 8 deg — enough to feel the g, far short of
      // the horizon-rolling that makes people queasy.
      const rollT = clamp(-(m.inclination || 0) * 0.30 * (0.30 + 0.70 * sT)
                          - (state.edge || 0) * 0.030 * sT
                          + lat * 0.055 * (0.3 + 0.7 * sT), -0.16, 0.16);
      roll = smoothDampS(roll, rollT, v, 'roll', 0.26, dt);
      camera.rotateZ(roll + sx * shakeAmp * 0.03);

      // ---- speed FOV ----------------------------------------------------------
      // Speed sets the base; ACCELERATION pumps it. Standing on the gas widens the
      // lens a couple of degrees and scrubbing speed pulls it back in, which is
      // what actually sells "gaining speed" — a constant 30 m/s cruise and a
      // 30 m/s deceleration should not look identical.
      pump += (clamp((m.aLong || 0) / 7, -1, 1) - pump) * Math.min(1, dt * 3.5);
      const fovT = FOV_BASE + 21 * sT + 3.0 * pump + 3.5 * airLift
                   + clamp(Math.abs(kick) * 3, 0, 3);
      fov = smoothDampS(fov, fovT, v, 'fov', 0.30, dt);
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
        d.lat = lat; d.susp = susp; d.pump = pump;
        const q = camera.quaternion;
        const fy = -2 * (q.y * q.z - q.w * q.x);
        const fx = -2 * (q.x * q.z + q.w * q.y);
        const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
        d.aimDeg = Math.atan2(fy, Math.hypot(fx, fz)) * 180 / Math.PI;
      }
    },
  };
}
