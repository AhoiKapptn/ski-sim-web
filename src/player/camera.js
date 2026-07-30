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
const DEG = Math.PI / 180;

// ---- framing ----------------------------------------------------------------
// The rider is the subject, not a landmark in a landscape. These are the two
// numbers that decide that, and everything else in the boom is derived from
// them: `FRAME_*` is the share of FRAME HEIGHT his silhouette (helmet to ski
// tails, poles included) is allowed to occupy, and the boom length is SOLVED
// for it every frame against the live FOV. Measured off a Shredders chase-cam
// still, the rider there is 0.43 of frame height and sits on the right third;
// this rig used to sit at 0.21-0.29 dead centre, which is why none of the work
// in that character survived to the screen. Below ~0.25 he stops reading as the
// subject and the frame turns into scenery with a sprite in it.
const FRAME_LOW = 0.348;         // standing / slow
const FRAME_HIGH = 0.320;        // flat out — a touch smaller, reads as "pulling away"
// Half the world-space vertical extent of that silhouette, calibrated against a
// measured frame (probe: 0.2865 of frame height at 5.58 m on a 68.4 deg lens).
const SUBJ_HALF = 0.99;
const FOV_GAIN = 16;             // degrees of speed widening
const FOV_SQUEEZE_MAX = 15;      // extra degrees the lens may buy back a crowded boom
const BOOM_MIN = 2.40;           // hard floor when the world crowds the boom
const CAM_RADIUS = 0.30;         // keep the near plane out of bark
// A conifer prototype here is 27 m tall with an 8.5 m bounding radius. Measured
// off the geometry (tools/motion-bb.mjs, area-weighted radius percentiles), half
// its triangle area at camera height lies inside 3.8 m and 80% inside 5.1 m —
// so 0.45 of the box is the opaque core, and the branch tips outside it are
// things you can see straight through. TRUNK_R is the floor: bark is never in
// frame even where the taper has run out.
const CANOPY_SHRINK = 0.45;
const TRUNK_R = 0.70;
const LAT_BIAS = 0.32;           // standing off-centre bias for the rider
// Azimuths the boom may swing to when a tree is in the way, and the lift it may
// add if none of them works. Straight back first; the search prefers the
// smallest move that restores the sight line.
const SWINGS = [0, 0.30, -0.30, 0.62, -0.62, 0.98, -0.98, 1.40, -1.40];
const SWING_MAX = 1.40;
const SWING_CLIMB = 2.4;
const ANCHOR = 1.15;             // chest height the boom pivots and frames around

// ---- occluder proximity buffers (allocation-free) ---------------------------
const OCC_CAP = 96;
const oX = new Float64Array(OCC_CAP), oY = new Float64Array(OCC_CAP);
const oZ = new Float64Array(OCC_CAP), oR = new Float64Array(OCC_CAP);
const oH = new Float64Array(OCC_CAP), oT = new Uint8Array(OCC_CAP);
const oI = new Int32Array(OCC_CAP);
const SEG = 12;                  // boom samples for the occlusion walk

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

/**
 * Instanced scatter pools that can actually stand between the lens and the
 * rider. The impostor/cluster/canopy cards are excluded by name: they only ever
 * exist past ~90 m, so they can never touch a 5 m boom, and testing them would
 * cost thousands of instances per frame for nothing.
 */
const CARD_POOLS = /^(tree2|clust|mass)$/;

function collectOccluders(out) {
  out.length = 0;
  const sc = (typeof window !== 'undefined') && window.__harness?.debug?.scatter;
  const root = sc && sc.group;
  if (!root) return false;
  root.traverse((o) => {
    if (!o.isInstancedMesh || CARD_POOLS.test(o.name || '')) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox;
    const r = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x),
                       Math.abs(bb.min.z), Math.abs(bb.max.z));
    if (!(r > 0) || !Number.isFinite(r)) return;
    // Conifers are cones, not cans: a 21 m spruce whose bounding box is 8 m wide
    // is only that wide across the skirt. Treating it as a cylinder would make
    // the camera flinch from trees it is nowhere near.
    const h = bb.max.y - Math.min(0, bb.min.y);
    // Anything the terrain clearance already handles (snow drifts, low mounds)
    // is not an occluder — testing it only made the boom flinch on open slopes.
    if (h < 1.6) return;
    const isTree = /^tree/.test(o.name || '');
    // Piste poles, gates and signs are thin things in a wide bounding box; the
    // markers pool measures 1.3 m across for what is mostly a 5 cm pole. Dodging
    // that box collapsed the boom every time the rider passed a marker on an
    // open slope, which is far more disruptive than a pole crossing the lens
    // for two frames. Rocks are solid and keep most of their box.
    const k = isTree ? CANOPY_SHRINK : (/^rock/.test(o.name || '') ? 0.85 : 0.30);
    // A piste marker is an 8 cm fibreglass wand in a 65 cm bounding box (the
    // box is its snow collar). Ducking things that thin is strictly worse than
    // letting them flick past the lens for three frames, so anything under
    // 35 cm of real cross-section is not an occluder at all.
    if (r * k < 0.35) return;
    out.push({ mesh: o, r, h, k, taper: isTree ? 1 : 0 });
  });
  return true;
}

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
  const cross = new THREE.Vector3();

  const v = { yaw: 0, fov: 0, roll: 0, lift: 0, shake: 0, lat: 0, susp: 0, boom: 0, swingA: 0, swingUp: 0 };
  let yaw = null, fov = FOV_BASE, roll = 0, lift = 0, shakeAmp = 0;
  let airLift = 0, kick = 0, kickV = 0, t = 0;
  let lat = 0, susp = 0, boom = 0, pump = 0;
  let swingA = 0, swingUp = 0, hard = 1, sight = 1;
  let init = false;

  const occluders = [];
  let occHave = false, occRescan = 1e9, occ = 1, occRaw = 1, nOcc = 0;

  /**
   * Walk the boom from the rider outwards and return the fraction of it that is
   * clear of scatter geometry. Sampled rather than solved: a cone/segment
   * intersection is a quartic, and 12 taps over a 5 m boom resolve to 40 cm,
   * which is finer than the margin we back off by anyway.
   */
  /**
   * Boom offset measured FROM THE CHEST ANCHOR: the nominal direction swung by
   * `a` about the slope up-vector, optionally climbed, then normalised to the
   * solved framing length so a swing never changes how big the rider is.
   */
  function aimBoom(out, a, climb, len, h) {
    const ca = Math.cos(a), sa = Math.sin(a);
    out.set(0, 0, 0)
      .addScaledVector(boomDir, -len * ca)
      .addScaledVector(cross, -len * sa)
      .addScaledVector(up, h - ANCHOR + climb);
    const L = out.length();
    if (L > 1e-3) out.multiplyScalar(len / L);
    return out;
  }

  let hitIdx = -1;
  function clearFrac(ax, ay, az, bx, by, bz) {
    let best = 1;
    hitIdx = -1;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    for (let i = 0; i < nOcc; i++) {
      const px = oX[i], py = oY[i], pz = oZ[i], rad = oR[i], hh = oH[i], tp = oT[i];
      for (let s = 1; s <= SEG; s++) {
        const f = s / SEG;
        if (f >= best) break;
        const yy = ay + dy * f - py;
        if (yy < -0.8 || yy > hh) continue;
        let rr = rad;
        if (tp) {
          // Cone taper. Measured off the prototype geometry: the canopy holds
          // ~90% of its skirt radius to half height and then falls off as
          // sqrt(1 - y/h) to the leader, so that is exactly what we model.
          const k = 1 - yy / hh;
          rr = Math.max(TRUNK_R, rad * (k > 0 ? Math.sqrt(k) : 0));
        }
        rr += CAM_RADIUS;
        const hx = ax + dx * f - px, hz = az + dz * f - pz;
        if (hx * hx + hz * hz < rr * rr) { best = f - 1.6 / SEG; hitIdx = oI[i]; break; }
      }
      if (best <= 0) return 0;
    }
    return clamp(best, 0, 1);
  }

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

      // ---- lens ---------------------------------------------------------------
      // Solved BEFORE the boom, because the boom is solved from it. Speed sets
      // the base; ACCELERATION pumps it. Standing on the gas widens the lens a
      // couple of degrees and scrubbing speed pulls it back in, which is what
      // actually sells "gaining speed" — a constant 30 m/s cruise and a 30 m/s
      // deceleration should not look identical.
      airLift += ((state.airborne ? smoothstep(state.airTime, 0.15, 0.9) : 0) - airLift)
                 * Math.min(1, dt * 3.5);
      pump += (clamp((m.aLong || 0) / 7, -1, 1) - pump) * Math.min(1, dt * 3.5);
      const fovT = FOV_BASE + FOV_GAIN * sT + 3.0 * pump + 3.0 * airLift
                   + clamp(Math.abs(kick) * 3, 0, 3);
      fov = smoothDampS(fov, fovT, v, 'fov', 0.30, dt);
      const halfV = Math.tan(fov * DEG * 0.5);

      // ---- boom geometry ------------------------------------------------------
      // The boom length is not a tuned constant, it is SOLVED so the rider keeps
      // a fixed share of frame height. Widening the lens with speed is right in
      // principle and wrong on its own: at 79 deg it was pushing him down to
      // 20% of frame height and none of the work in that character — the lofted
      // shell, the quilting, the boot hardware, the mirrored goggle — survived
      // the trip to the screen. Every degree of widening now buys an equal pull
      // on the boom, so the lens stretches the WORLD past him and never him.
      const frac = FRAME_LOW - (FRAME_LOW - FRAME_HIGH) * sT;
      // Big air backs off and climbs so the landing stays framed; the leg
      // suspension rides the boom in and out over rollers.
      // The terrain clearance below pushes the lens UP and therefore further
      // away, and on a steep pitch that alone was costing 12% of his screen
      // height. Pay it back out of the boom so the framing does not depend on
      // how lumpy the ground behind him happens to be.
      const framed = SUBJ_HALF / (frac * halfV) - clamp(lift, 0, 2.5) * 0.45
                     + 2.2 * airLift - 0.50 * susp + brZ * (0.05 + 0.16 * sT);
      const dist = Math.max(BOOM_MIN, framed);
      // Low. A chase cam looking DOWN at a skier foreshortens him into a dot on
      // a white field; near eye level he reads as a person with a mountain
      // behind him. 1.25 m over the contact point is roughly his shoulder.
      const height = 1.25 - 0.18 * sT + 2.3 * airLift + 0.42 * susp
                     + brY * (0.05 + 0.14 * sT);

      // Tilt the boom with the slope so a steep pitch still shows the run ahead.
      // Only half-way to the surface normal, though: fully slope-locked, a 25 deg
      // pitch lifts a 5 m boom 2 m into the air and you are looking at the top of
      // his helmet again.
      const gn = state.groundNormal;
      up.set(0, 1, 0).lerp(gn, 0.50).normalize();
      boomDir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      boomDir.addScaledVector(up, -boomDir.dot(up));
      if (boomDir.lengthSq() < 1e-6) boomDir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      boomDir.normalize();

      // side vector of the boom plane, used both by the swing search below and
      // by the composition further down
      cross.crossVectors(up, boomDir);

      // ---- the subject is never behind a tree ---------------------------------
      // Terrain collision was never enough: the boom also has to survive a stand
      // of 27 m conifers, and "camera inside a trunk with foliage on the lens" is
      // the single most broken thing a third-person snow game can do.
      //
      // Pulling the boom in is only half the answer — in a tight glade the tree
      // is often between the rider and a point two metres behind him, and no
      // amount of shortening gets past it. So the boom SWINGS: nine azimuths,
      // and a raised variant if none of them is clear, scored on how much of the
      // sight line survives minus a penalty for how far it had to move. That is
      // the standard third-person answer and it is what turns "lost in a spruce"
      // into "the operator stepped round the tree".
      occRescan -= dt;
      if (!occHave || occRescan <= 0) { occHave = collectOccluders(occluders); occRescan = 1.0; }
      // Everything below is measured from his chest, not his boots: that is the
      // point the shot is about, and testing from the snow line would have the
      // boom dodging the ground. (A predictive lead on this anchor was tried and
      // measured worse — it makes the "he is inside this tree" test below fire
      // for a tree he has not reached, and the search then ignores it.)
      const anchorY = state.pos.y + up.y * ANCHOR;
      const ax = state.pos.x + up.x * ANCHOR;
      const az = state.pos.z + up.z * ANCHOR;
      nOcc = 0;
      if (occHave) {
        const reach = dist + 1.5;
        for (let k = 0; k < occluders.length; k++) {
          const o = occluders[k], mesh = o.mesh, arr = mesh.instanceMatrix.array;
          const n = mesh.count;
          if (!n) continue;
          // generous broad-phase, so the per-instance scale is only ever
          // decomposed for the handful that could actually matter
          const gross = reach + o.r * 1.6;
          const gross2 = gross * gross;
          for (let i = 0, j = 0; i < n; i++, j += 16) {
            const ix = arr[j + 12], iy = arr[j + 13], iz = arr[j + 14];
            const dxa = ix - ax, dza = iz - az;
            if (dxa * dxa + dza * dza > gross2) continue;
            if (iy - anchorY > 4 || anchorY - iy > 40) continue;
            const sc = Math.hypot(arr[j], arr[j + 1], arr[j + 2]);
            const rw = o.r * sc * o.k;
            const d2 = dxa * dxa + dza * dza;
            if (d2 > (reach + rw) * (reach + rw)) continue;
            // If the RIDER is inside this canopy there is no camera position
            // that can dodge it, and counting it would score every candidate
            // direction at zero and freeze the search. Skiing under a spruce
            // means branches in frame; that is the tree's business, not the
            // boom's.
            const hgt = o.h * sc;
            if (d2 < rw * rw && anchorY - iy > -0.8 && anchorY - iy < hgt) continue;
            if (nOcc >= OCC_CAP) break;
            oX[nOcc] = ix; oY[nOcc] = iy; oZ[nOcc] = iz;
            oR[nOcc] = rw; oH[nOcc] = hgt; oT[nOcc] = o.taper; oI[nOcc] = k;
            nOcc++;
          }
          if (nOcc >= OCC_CAP) break;
        }
      }

      let bestA = 0, bestUp = 0;
      occRaw = 1;
      if (nOcc) {
        let bestScore = -1e9;
        for (let pi = 0; pi < 2; pi++) {
          const climb = pi ? SWING_CLIMB : 0;
          for (let ai = 0; ai < SWINGS.length; ai++) {
            const a = SWINGS[ai];
            aimBoom(tmp2, a, climb, dist, height);
            const c = clearFrac(ax, anchorY, az, ax + tmp2.x, anchorY + tmp2.y, az + tmp2.z);
            // prefer straight back, prefer level, and prefer where we already
            // are — the last term is the hysteresis that stops a 50/50 pair of
            // trees flipping the camera from one shoulder to the other
            const score = c
                        - 0.22 * Math.abs(a) / SWING_MAX
                        - (pi ? 0.12 : 0)
                        + 0.10 * (1 - Math.min(1, Math.abs(a - swingA) / 0.7));
            if (score > bestScore) { bestScore = score; bestA = a; bestUp = climb; occRaw = c; }
          }
          if (occRaw > 0.92) break;
        }
      }
      // never let it collapse onto his back — at BOOM_MIN he still reads whole
      occRaw = Math.max(occRaw, Math.min(1, BOOM_MIN / Math.max(0.5, dist)));
      occ += (occRaw - occ) * Math.min(1, dt * (occRaw < occ ? 26 : 3.2));
      // The swing is springed, not snapped: a 55 deg step in one frame is a cut,
      // and a cut in a chase cam reads as a bug. Asymmetric, though — it ducks
      // out of the way three times faster than it drifts back, which is both how
      // a real operator moves and the only way to beat a tree at 60 km/h.
      const away = Math.abs(bestA) > Math.abs(swingA);
      swingA = smoothDampS(swingA, bestA, v, 'swingA', away ? 0.16 : 0.34, dt);
      swingUp = smoothDampS(swingUp, bestUp, v, 'swingUp', bestUp > swingUp ? 0.12 : 0.40, dt);

      // Springs run on the OFFSET from the skier, not on world position: a spring
      // chasing a moving target keeps a steady-state error of ~smoothTime*speed,
      // which at 30 m/s would stretch the boom by 6 m. Relative springing lags
      // only what should lag — turns, height, speed changes — at any speed.
      aimBoom(want, swingA, swingUp, dist * occ, height);
      want.addScaledVector(up, ANCHOR + (1 - occ) * 0.18);

      // ---- look target: lead the direction of travel --------------------------
      travel.copy(state.vel);
      if (travel.lengthSq() < 1e-4) travel.set(-Math.sin(headYaw), 0, -Math.cos(headYaw));
      travel.normalize();
      // Look-ahead shortens with the boom. From two metres back, aiming 15 m
      // down the hill puts the rider on the bottom edge of the frame with his
      // skis cut off; reeling the aim in keeps him whole when the trees squeeze.
      const lead = clamp(4.0 + spd * 0.50, 4.0, 26) * (0.42 + 0.58 * occ);
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

      // (a) look into the arc, over a small standing bias so that even a dead
      // straight schuss on a fall-line-flat pitch never puts him on the crosshair
      let latT = LAT_BIAS + clamp((m.yawRate || 0) / 1.15, -1, 1) * (state.airborne ? 0.25 : 1);
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

      // When a stand of trees has crushed the boom to two metres, an aim point
      // 15 m down the fall line pushes the rider off the bottom of the frame.
      // Blend the aim back onto him as the boom comes in, so a tight glade
      // reframes into an over-the-shoulder shot instead of cropping his skis.
      if (occ < 0.999) {
        tmp2.set(0, 0, 0).addScaledVector(up, ANCHOR + 0.25).addScaledVector(travel, 2.2);
        wantLook.lerp(tmp2, (1 - occ) * 0.55);
      }

      // ---- horizon guard ------------------------------------------------------
      // Aiming at the snow ahead is right on a mellow pitch and disastrous on a
      // steep one: the camera ends up staring at its own shadow with the sky gone.
      // Clamp the aim pitch so the ridgeline is always in frame and the rider
      // always sits low-centre, never dead-centre.
      tmp.copy(wantLook).sub(want);
      const horizD = Math.hypot(tmp.x, tmp.z);
      if (horizD > 0.5) {
        const aim = Math.atan2(tmp.y, horizD);
        const aimC = clamp(aim, -0.19, 0.06);
        if (aimC !== aim) wantLook.y = want.y + Math.tan(aimC) * horizD;
      }

      // ---- snap on teleport, otherwise spring ---------------------------------
      const teleport = !init || dt >= 0.5 || pos.distanceToSquared(want) > 3600;
      if (teleport) {
        init = true;
        pos.copy(want); posVel.set(0, 0, 0);
        look.copy(wantLook); lookVel.set(0, 0, 0);
        yaw = yawTarget; v.yaw = 0;
        airLift = 0; lift = 0; kick = 0; kickV = 0; occ = occRaw;
      } else {
        // and the position spring stiffens while it is dodging, so the boom
        // actually arrives at the clear azimuth instead of lagging through the tree
        smoothDampV(pos, want, posVel, (0.24 - 0.08 * sT), dt, tmp);
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

      // ---- hard guarantee: the rider is visible -------------------------------
      // Everything above is a soft constraint — a spring chasing a target — and
      // a spring is a tenth of a second late, which at 60 km/h is three metres
      // of tree. This is the constraint that actually holds: measure the final
      // sight line, and if anything is across it, slide the lens down that line
      // until it is clear. Applied to the OUTPUT only, so it never winds up in
      // the spring state. It snaps in and eases out, because being briefly too
      // close is invisible next to being briefly blind.
      {
        const aX = state.pos.x + up.x * ANCHOR;
        const aY = state.pos.y + up.y * ANCHOR;
        const aZ = state.pos.z + up.z * ANCHOR;
        const ex = camera.position.x - aX, ey = camera.position.y - aY, ez = camera.position.z - aZ;
        const len = Math.hypot(ex, ey, ez);
        let target = 1;
        if (nOcc && len > 0.5) {
          sight = clearFrac(aX, aY, aZ, camera.position.x, camera.position.y, camera.position.z);
          target = Math.max(sight, Math.min(1, BOOM_MIN / len));
        } else sight = 1;
        // fast, but still a move rather than a cut: 0.07 s in, 0.4 s out
        hard += (target - hard) * Math.min(1, dt * (target < hard ? 14 : 2.6));
        if (hard < 0.999) camera.position.set(aX + ex * hard, aY + ey * hard, aZ + ez * hard);
      }

      // Ducking in behind a tree would otherwise blow the rider up to fill the
      // frame — the whole point of solving the boom for a constant subject size
      // is lost the moment something crowds it. So pay the shortening back in
      // lens: widen by exactly the factor the boom lost, capped, and the rider
      // keeps his size while the world stretches around him. This is the only
      // place the FOV is allowed to drive framing rather than the other way
      // round, and it is why a glade reads as tight rather than as a zoom.
      const squeeze = clamp(occ * hard, 0.35, 1);
      let fovOut = fov;
      if (squeeze < 0.995) {
        fovOut = Math.min(fov + FOV_SQUEEZE_MAX,
                          2 * Math.atan(halfV / squeeze) / DEG);
      }
      if (Math.abs(camera.fov - fovOut) > 0.02) {
        camera.fov = fovOut;
        camera.updateProjectionMatrix();
      }

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
        d.sight = sight;
        d.occ = occ; d.occRaw = occRaw; d.nOcc = nOcc;
        d.swingDeg = swingA * 180 / Math.PI; d.swingUp = swingUp; d.hard = hard;
        d.occHit = hitIdx >= 0 ? occluders[hitIdx].mesh.name : '';
        d.framed = framed; d.frac = frac;
        const q = camera.quaternion;
        const fy = -2 * (q.y * q.z - q.w * q.x);
        const fx = -2 * (q.x * q.z + q.w * q.y);
        const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
        d.aimDeg = Math.atan2(fy, Math.hypot(fx, fz)) * 180 / Math.PI;
      }
    },
  };
}
