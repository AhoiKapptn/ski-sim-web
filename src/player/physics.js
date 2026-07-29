import * as THREE from 'three';

/**
 * Alpine — ski physics.
 *
 * Conventions (must match player/skier.js `rotation.set(pitch, heading, roll,'YXZ')`):
 *   forward  F = (-sin h, 0, -cos h)     (object-local -Z, three.js standard)
 *   right    R = ( cos h, 0, -sin h)     (object-local +X)
 *   d/dh F = -R   →   increasing `heading` turns LEFT.
 *   input.steer > 0 = left = positive edge = positive roll (inclination into the turn).
 *
 * The carve model
 * ---------------
 * An edged ski is a curved rail, not a tyre. Its arc comes from geometry — the
 * sidecut curve tilted into the snow, floored by the fully-decambered limit:
 *
 *     R_turn = max(Rsc * cos(phi), Rsc / tan(phi))     (phi = edge angle)
 *
 * so the ski yaws at  omega = u / R_turn  once the edge is engaged. The snow then
 * has to supply the centripetal force that makes the *velocity* follow that yaw.
 * Writing sideslip s = v·R, the yaw alone drives  ds/dt = omega*u, so holding the
 * carve needs a lateral acceleration
 *
 *     a_r = -(omega * u + K * s)
 *
 * (the K*s term recovers any slip that already exists). That force is applied along
 * the ski's lateral axis, so its power is  a_r * s :
 *
 *   - clean carve   → s ≈ 0 → the force does NO work → speed is conserved.
 *   - grip exceeded → a_r saturates at mu*N, s grows, and the same force now does
 *                     strictly negative work → the skid scrubs speed. It recovers
 *                     as soon as the edge is released (s decays at rate K).
 *
 * No fudge factors, no "turn the velocity vector towards the nose". Everything the
 * player feels — arc tightening with edge angle, running out of grip at speed,
 * hockey stops, rebound out of a loaded turn — falls out of those few lines.
 */

// ---- tuning ----------------------------------------------------------------
const G = 11.0;             // m/s^2. Slightly above 9.81: punchier without feeling arcade.
const R_SIDECUT = 17.0;     // m, GS-ish ski
const PHI_MAX = 1.05;       // rad (60 deg) max edge angle
const K_ALIGN = 7.0;        // 1/s, sideslip recovery rate
const MU_LAT0 = 0.85;       // flat-ski lateral bite (base edge always cuts a little)
const MU_LAT_EDGE = 3.20;   // grip per sin(phi): ~2.3 g at 30 deg, ~3.5 g laid over
const MU_SNOW = 0.045;      // kinetic snow friction, running flat
const DRAG_UP = 0.0050;     // 1/m, upright (terminal ~25 m/s on a 20 deg pitch)
const DRAG_TUCK = 0.0024;   // 1/m, tucked  (terminal ~37 m/s on a 20 deg pitch)
const EDGE_W = 13.0;        // rad/s, edge-angle spring (weight transfer ~0.25 s)
const EDGE_RATE_MAX = 9.0;  // rad/s
const AIR_YAW = 2.0;        // rad/s, in-air rotation authority
const LIFT_ACC = 9.0;       // m/s^2 the snow must fall away faster than g to launch
                            // (legs actively extend over a roller before you fly)
const AIR_REPORT = 0.07;    // s of real flight before `airborne` is published
const SKI_LEN = 1.7;        // m, contact footprint — a ski bridges sub-metre holes
const SUBSTEP = 1 / 120;

const clamp = THREE.MathUtils.clamp;
const smoothstep = (x, a, b) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Terrain handle shared with player/camera.js (which is not handed one by main.js). */
let activeTerrain = null;
export function getActiveTerrain() { return activeTerrain; }

export class SkiPhysics {
  constructor(terrain) {
    this.terrain = terrain;
    activeTerrain = terrain;

    // --- persistent sim state -------------------------------------------------
    this.phi = 0;            // edge angle, rad (signed, + = left edge set)
    this.phiRate = 0;
    this.grounded = true;
    this.aLat = 0;           // lateral accel along +R (m/s^2)
    this.aLatS = 0;          // low-passed: drives lean, gForce, spray/shake
    this.aLong = 0;
    this.omega = 0;          // yaw rate, rad/s
    this.slip = 0;           // sideslip velocity, m/s
    this.slipAngle = 0;
    this.turnRadius = Infinity;
    this.skidding = false;
    this.gripPenalty = 0;    // post-landing loss of edge hold, decays
    this.preload = 0;        // jump pre-load charge 0..1
    this.jumpHeld = false;
    this.reboundCd = 0;
    this.compression = 0;    // suspension compression 0..1 (landings + turn load)
    this.landImpact = 0;
    this.lastAirTime = 0;
    this.gSpike = 0;         // decaying impact term folded into gForce
    this.roughness = 0;
    this.incline = 0;
    this.airT = 0;           // real time off the snow (state.airTime is hysteresed)
    this.jumpBuf = 0;
    this.pending = 0;

    // --- smoothed / display ---------------------------------------------------
    this.nSmooth = new THREE.Vector3(0, 1, 0);
    this.pitchS = 0;
    this.rollS = 0;
    this.crouchS = 0;

    // --- scratch (no per-frame allocation) ------------------------------------
    this._f = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._n = new THREE.Vector3(0, 1, 0);
    this._nw = new THREE.Vector3(0, 1, 0);
    this._a = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._gt = new THREE.Vector3();
  }

  // ---------------------------------------------------------------------------
  reset(state, x, z, heading) {
    this._f.set(-Math.sin(heading), 0, -Math.cos(heading));
    state.pos.set(x, this._contact(x, z, this._f), z);
    state.heading = heading;

    // Push off with a little speed so a fresh run is immediately alive.
    const n = this.terrain.normal(x, z);
    this._f.addScaledVector(n, -this._f.dot(n)).normalize();
    state.vel.copy(this._f).multiplyScalar(8);

    this.phi = 0; this.phiRate = 0; this.grounded = true;
    this.aLat = 0; this.aLatS = 0; this.aLong = 0; this.omega = 0; this.slip = 0; this.slipAngle = 0;
    this.turnRadius = Infinity; this.skidding = false; this.gripPenalty = 0;
    this.preload = 0; this.jumpHeld = false; this.reboundCd = 0;
    this.compression = 0; this.landImpact = 0; this.lastAirTime = 0; this.gSpike = 0;
    this.roughness = 0; this.incline = 0; this.airT = 0; this.jumpBuf = 0; this.pending = 0;
    this.nSmooth.copy(n);
    this.pitchS = Math.asin(clamp(this._f.y, -1, 1));
    this.rollS = 0; this.crouchS = 0;

    state.speed = 8; state.airTime = 0; state.distance = 0; state.time = 0;
    state.edge = 0; state.carving = false; state.airborne = false;
    state.groundNormal.copy(n); state.crouch = 0; state.gForce = 0;
    state.pitch = this.pitchS; state.roll = 0;
    this._publish(state, 0);
  }

  // ---------------------------------------------------------------------------
  update(dt, state) {
    if (!(dt > 0)) { this._publish(state, 0); return; }
    dt = Math.min(dt, 0.1);
    const steps = Math.min(6, Math.max(1, Math.ceil(dt / SUBSTEP)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this._step(h, state);
    this._publish(state, dt);
    this._sanitise(state);
  }

  /**
   * Contact height under the skis. Averaged over the ski footprint because a
   * 1.7 m ski bridges sub-metre holes instead of tracing every noise wiggle —
   * this is the "suspension" that stops metre-scale terrain jittering the body,
   * while metre-plus rollers still throw the skier into the air.
   */
  _contact(x, z, f) {
    const T = this.terrain, a = SKI_LEN * 0.33, b = SKI_LEN * 0.66;
    return 0.34 * T.height(x, z) +
           0.22 * (T.height(x + f.x * a, z + f.z * a) + T.height(x - f.x * a, z - f.z * a)) +
           0.11 * (T.height(x + f.x * b, z + f.z * b) + T.height(x - f.x * b, z - f.z * b));
  }

  // ---- one fixed sub-step ---------------------------------------------------
  _step(dt, state) {
    const T = this.terrain, pos = state.pos, vel = state.vel;
    const inp = state.input || {};
    const steer = clamp(inp.steer || 0, -1, 1);
    const brake = clamp(inp.brake || 0, 0, 1);
    const jump = !!inp.jump;

    // --- edge angle: critically damped 2nd order = real weight transfer -------
    const phiPrev = Math.abs(this.phi);
    const loadPrev = Math.abs(this.aLat) / G;
    const phiTarget = steer * PHI_MAX * (1 - 0.45 * brake);
    const acc = EDGE_W * EDGE_W * (phiTarget - this.phi) - 2 * EDGE_W * this.phiRate;
    this.phiRate = clamp(this.phiRate + acc * dt, -EDGE_RATE_MAX, EDGE_RATE_MAX);
    this.phi = clamp(this.phi + this.phiRate * dt, -PHI_MAX, PHI_MAX);
    const absPhi = Math.abs(this.phi);
    const dPhi = (absPhi - phiPrev) / dt;

    // --- jump pre-load: squat while held, release the spring on let-go --------
    // Coyote time + a short release buffer: skimming a roller for 40 ms must
    // never eat the player's pop.
    let popImpulse = 0;
    this.jumpBuf = Math.max(0, this.jumpBuf - dt);
    if (jump) {
      this.jumpHeld = true;
      this.preload = Math.min(1, this.preload + dt / 0.28);  // legs load, air or not
    } else if (this.jumpHeld) {
      this.jumpHeld = false;
      this.pending = 3.2 + 4.3 * this.preload;              // charged pop
      this.jumpBuf = 0.80;   // fires on the next contact, so a float never eats it
      this.preload = 0;
    } else {
      this.preload = Math.max(0, this.preload - dt * 3);
    }
    if (this.pending > 0) {
      if (this.grounded || this.airT < 0.12) {              // coyote time
        popImpulse = this.pending; this.pending = 0; this.jumpBuf = 0;
      } else if (this.jumpBuf === 0) {
        this.pending = 0;                                   // buffer expired
      }
    }

    // --- rebound: unloading a loaded turn throws you up ------------------------
    this.reboundCd = Math.max(0, this.reboundCd - dt);
    if (this.grounded && !this.jumpHeld && this.reboundCd === 0 &&
        dPhi < -2.2 && loadPrev > 1.05 && brake < 0.5) {
      popImpulse += Math.min(1.8, (loadPrev - 1.0) * 1.5);
      this.reboundCd = 0.35;
    }

    // --- ground sample --------------------------------------------------------
    const n = this._n.copy(T.normal(pos.x, pos.z, 1.6));
    if (!(n.y > 0.05)) n.set(0, 1, 0);

    const yPrev = pos.y;
    const vyPrev = vel.y;

    if (this.grounded) {
      // ---- ski frame on the slope -------------------------------------------
      const f = this._f.set(-Math.sin(state.heading), 0, -Math.cos(state.heading));
      f.addScaledVector(n, -f.dot(n));
      if (f.lengthSq() < 1e-8) f.set(-Math.sin(state.heading), 0, -Math.cos(state.heading));
      f.normalize();
      const r = this._r.crossVectors(f, n).normalize();

      // velocity in the slope plane
      vel.addScaledVector(n, -vel.dot(n));
      const u = vel.dot(f);
      const s = vel.dot(r);
      const spd = vel.length();

      // ---- load on the ski ---------------------------------------------------
      // Grip is limited by how hard the edge can shear the snow, NOT by the turn
      // reaction (feeding the turn force back into the grip limit is a runaway:
      // it lets you pull 8 g). Gravity load + a little pre-load pressure only.
      const gN = G * n.y;
      const gripLoad = gN * (1 + 0.30 * this.preload);
      // Friction, on the other hand, really does rise with total ski pressure.
      const loadN = Math.min(3.2 * G, gN + 0.30 * Math.abs(this.aLat));

      // ---- yaw: the edge geometry writes the arc -----------------------------
      // Breakaway: once the ski slides across its own direction the edge smears
      // instead of cutting, so it stops self-steering. Without this a skid never
      // finds an equilibrium — the arc keeps demanding force it cannot get and
      // the sideslip grows without bound.
      const slipAng = Math.atan2(s, Math.max(1.0, Math.abs(u)));
      const bx = slipAng / 0.22;
      const breakaway = 0.15 + 0.85 / (1 + bx * bx);   // never fully stops steering
      const eng = smoothstep(absPhi, 0.04, 0.30) * (1 - 0.65 * brake) *
                  (1 - 0.5 * this.gripPenalty) * breakaway;
      // A tilted sidecut arc projected into the snow gives R = Rsc/tan(phi):
      // flat ski → straight, and the arc tightens hard as you lay it over. The
      // fully-decambered Howe limit R = Rsc*cos(phi) floors it at extreme edge.
      const rTurn = Math.max(R_SIDECUT * Math.cos(absPhi),
                             R_SIDECUT / Math.max(1e-3, Math.tan(absPhi)));
      let omega = Math.sign(this.phi) * eng * (u / rTurn);
      // hockey stop: pivot the ski across the flow, hard
      const brakeSide = Math.abs(steer) > 0.05 ? Math.sign(steer) : (Math.abs(s) > 0.2 ? -Math.sign(s) : 1);
      omega += brakeSide * brake * 2.8;
      // low-speed pivot so you are never stuck
      omega += steer * 1.3 * (1 - smoothstep(Math.abs(u), 2, 9));
      this.omega = omega;
      state.heading += omega * dt;

      // ---- lateral: rail constraint, capped by grip --------------------------
      let muLat = MU_LAT0 + MU_LAT_EDGE * Math.sin(absPhi) + 0.55 * brake;
      muLat *= 1 - 0.10 * smoothstep(spd, 26, 55);            // grip fades a little at speed
      muLat *= 1 - 0.20 * smoothstep(Math.acos(clamp(n.y, -1, 1)), 0.35, 0.8); // ...and on steeps
      muLat *= 1 - 0.55 * this.gripPenalty;                    // ...and after a bad landing
      const aLatMax = muLat * gripLoad;

      // The edge must also hold the across-slope component of gravity, otherwise
      // a flat ski creeps sideways on a traverse and bleeds energy for nothing.
      const gLat = this._gt.set(0, -G, 0).addScaledVector(n, G * n.y).dot(r);
      const aReq = -(omega * u + K_ALIGN * s + gLat);
      const aLat = clamp(aReq, -aLatMax, aLatMax);
      // Carving vs skidding is a property of the TRACK, not of an instantaneous
      // force comparison: a ski that follows its own line (slip angle ~0) is
      // carving even if it is momentarily at the limit of grip.
      this.skidding = Math.abs(slipAng) > 0.13 || (Math.abs(aReq) > aLatMax * 1.35);
      this.aLat = aLat;
      this.slip = s;
      this.slipAngle = Math.atan2(s, Math.max(1e-3, Math.abs(u)));
      this.turnRadius = Math.abs(omega) > 1e-3 ? Math.abs(u / omega) : Infinity;

      // ---- assemble acceleration --------------------------------------------
      const a = this._a.set(0, -G, 0);
      a.addScaledVector(n, -a.dot(n));                 // gravity along the slope
      const gAlong = a.dot(f);
      a.addScaledVector(r, aLat);                      // edge / skid lateral force

      // snow friction, opposing travel in the plane
      const muSnow = MU_SNOW + 0.035 * (absPhi / PHI_MAX) + 0.30 * brake;
      if (spd > 1e-3) a.addScaledVector(vel, -(muSnow * loadN) / spd);

      // aerodynamic drag (v^2, collapses in a tuck)
      const kD = DRAG_UP + (DRAG_TUCK - DRAG_UP) * this.crouchS;
      a.addScaledVector(vel, -kD * spd);

      this.aLong = gAlong - muSnow * loadN * Math.sign(u || 1) - kD * spd * u;

      vel.addScaledVector(a, dt);
      vel.addScaledVector(n, -vel.dot(n));             // stay in the slope plane
      if (popImpulse > 0) vel.addScaledVector(n, popImpulse);

      pos.addScaledVector(vel, dt);

      // ---- lip detection: did the ground fall away faster than ballistic? ----
      // yFree is where a free body would be; if the snow is below that, following
      // it would need more than 1 g of downforce, so the skis leave the lip.
      // Expressed as an acceleration deficit it is dt-independent, and the small
      // threshold stops micro-bumps chattering the airborne flag.
      const ghNew = this._contact(pos.x, pos.z, f);
      const yFree = yPrev + vyPrev * dt - 0.5 * G * dt * dt;
      const liftAcc = 2 * (yFree - ghNew) / (dt * dt);
      if (popImpulse > 0 || liftAcc > LIFT_ACC) {
        this.grounded = false;
        this.airT = 0;
        pos.y = Math.max(yFree, ghNew);
        if (popImpulse === 0) vel.y = vyPrev - G * dt;
      } else {
        pos.y = ghNew;
      }
    } else {
      // ---- ballistic flight ---------------------------------------------------
      // A pop inside coyote time still counts: the skis were 2 cm off the snow.
      if (popImpulse > 0) vel.addScaledVector(n, popImpulse);
      const spd = vel.length();
      const kD = (DRAG_UP + (DRAG_TUCK - DRAG_UP) * this.crouchS) * 0.85;
      vel.y -= G * dt;
      vel.addScaledVector(vel, -kD * spd * dt);
      state.heading += steer * AIR_YAW * dt;
      this.omega = steer * AIR_YAW;
      this.aLat = 0; this.slip = 0; this.slipAngle = 0; this.turnRadius = Infinity;
      this.skidding = false;
      pos.addScaledVector(vel, dt);
      this.airT += dt;
      this.lastAirTime = this.airT;

      const f = this._f.set(-Math.sin(state.heading), 0, -Math.cos(state.heading));
      const ghNew = this._contact(pos.x, pos.z, f);
      if (pos.y <= ghNew) {
        // ---- landing: a slope-matched touchdown keeps its speed ---------------
        // Only the velocity INTO the snow is destroyed, so matching the landing
        // angle to the slope costs almost nothing while a flat-deck landing at
        // the same speed compresses hard and scrubs.
        pos.y = ghNew;
        const nl = this._n.copy(T.normal(pos.x, pos.z, 1.6));
        const impact = Math.max(0, -vel.dot(nl));      // normal closing speed
        vel.addScaledVector(nl, -vel.dot(nl));         // absorbed, never bounce
        const hard = clamp((impact - 1.2) / 16, 0, 1.6);   // ignore micro-touches
        vel.multiplyScalar(1 - 0.40 * Math.pow(hard, 1.5));
        this.compression = Math.min(1.4, this.compression + hard * 1.1);
        this.gripPenalty = Math.min(1, this.gripPenalty + hard * 0.9);
        this.gSpike = Math.min(6, this.gSpike + impact * 0.22);
        this.landImpact = Math.max(this.landImpact, impact);
        this.grounded = true;
        this.airT = 0;
        this.phiRate *= 0.3;
      }
    }

    // decays
    this.gripPenalty = Math.max(0, this.gripPenalty - dt * 1.8);
    this.gSpike = Math.max(0, this.gSpike - dt * 6.0);
    this.landImpact = Math.max(0, this.landImpact - dt * 20);
    this.compression = Math.max(0, this.compression - dt * 3.2);
  }

  // ---- derived / smoothed values every subsystem reads -----------------------
  _publish(state, dt) {
    const T = this.terrain, pos = state.pos;
    state.speed = state.vel.length();

    // body-scale surface normal: average over the ski footprint so metre-scale
    // bumps do not shake the skier, then a suspension spring on top.
    const f = this._f.set(-Math.sin(state.heading), 0, -Math.cos(state.heading));
    const nw = this._nw.copy(T.normal(pos.x, pos.z, 2.2));
    this._t.copy(T.normal(pos.x + f.x * 0.9, pos.z + f.z * 0.9, 1.8));
    nw.add(this._t);
    this._t.copy(T.normal(pos.x - f.x * 0.9, pos.z - f.z * 0.9, 1.8));
    nw.add(this._t).normalize();

    const rough = 1 - clamp(nw.dot(this._n), -1, 1);
    this.roughness += (Math.min(1, rough * 26) - this.roughness) * Math.min(1, dt * 4);

    const target = state.airborne
      ? this._t2.set(0, 1, 0).lerp(nw, 0.35).normalize()
      : nw;
    this.nSmooth.lerp(target, Math.min(1, (state.airborne ? 3.0 : 9.0) * dt)).normalize();
    state.groundNormal.copy(this.nSmooth);

    const n = this.nSmooth;
    f.addScaledVector(n, -f.dot(n));
    if (f.lengthSq() > 1e-8) f.normalize();
    const r = this._r.crossVectors(f, n).normalize();

    // The raw lateral force flickers at the grip limit; everything cosmetic
    // (lean, gForce, spray, camera shake) reads the low-passed value.
    this.aLatS += (this.aLat - this.aLatS) * Math.min(1, 9 * dt);

    // pitch: nose follows the slope, plus a little fore/aft under accel/braking
    const pitchT = Math.asin(clamp(f.y, -1, 1)) - clamp(this.aLong / G, -1, 1) * 0.07;
    // roll: inclination into the turn (atan of the force triangle) + cross-slope
    // Lean. skier.js applies `rotation.set(pitch, heading, roll, 'YXZ')`, a WORLD
    // Euler, so roll is the tilt from world vertical — which is exactly the angle
    // a skier balances at: along the resultant of gravity and the turn force.
    // (A slope-normal term would be pointless anyway: r = f x n is perpendicular
    // to n by construction, so n.r is identically zero.)
    const rhx = Math.cos(state.heading), rhz = -Math.sin(state.heading);
    const aH = this.aLatS * (r.x * rhx + r.z * rhz);
    const incline = Math.atan2(-aH, G);
    this.incline = incline;
    // Full inclination is real (2.5 g = 68 deg off the snow) but racers angulate:
    // the torso stays far closer to upright than the legs. A rigid rig gets the
    // torso share; motion.inclination carries the true angle for a legged rig.
    const rollT = clamp(incline * 0.6, -0.75, 0.75);

    const kp = Math.min(1, 14 * dt), kr = Math.min(1, 10 * dt);
    this.pitchS += (pitchT - this.pitchS) * kp;
    this.rollS += (rollT - this.rollS) * kr;
    state.pitch = this.pitchS;
    state.roll = this.rollS;

    state.edge = clamp(this.phi / PHI_MAX, -1, 1);
    // Hysteresis: skimming a roller for 40 ms is not "air". Spray, audio and the
    // camera all key off this flag, so it must not chatter.
    state.airborne = !this.grounded && this.airT > AIR_REPORT;
    state.airTime = state.airborne ? this.airT : 0;

    const eng = smoothstep(Math.abs(this.phi), 0.05, 0.35);
    state.carving = this.grounded && eng > 0.25 && Math.abs(this.slipAngle) < 0.10 &&
                    Math.abs(this.omega) > 0.05 && state.speed > 3.5;

    // tuck + dynamic compression (turn load, pre-load squat, landing)
    const load = Math.abs(this.aLatS) / G;
    const crouchT = clamp(
      (state.input?.crouch || 0) * 0.85 +
      this.preload * 0.55 +
      this.compression * 0.7 +
      load * 0.16 +
      (state.airborne ? 0.18 : 0), 0, 1);
    this.crouchS += (crouchT - this.crouchS) * Math.min(1, 10 * dt);
    state.crouch = this.crouchS;

    // lateral load in g, plus decaying impact spikes
    state.gForce = Math.abs(this.aLatS) / 9.81 + this.gSpike;

    state.distance += state.speed * dt;
    state.time += dt;

    const m = state.motion || (state.motion = {});
    m.edgeAngle = this.phi;
    m.yawRate = this.omega;
    m.turnRadius = this.turnRadius;
    m.slip = this.slip;
    m.slipAngle = this.slipAngle;
    m.skidding = this.skidding;
    m.lastAirTime = this.lastAirTime;
    m.landImpact = this.landImpact;
    m.compression = this.compression;
    m.roughness = this.roughness;
    m.preload = this.preload;
    m.aLat = this.aLatS;
    m.inclination = this.incline;

    m.aLong = this.aLong;
    m.grip = this.gripPenalty;
  }

  /** Never let a NaN escape into the rest of the engine. */
  _sanitise(state) {
    const bad = (v) => !Number.isFinite(v);
    if (bad(state.pos.x) || bad(state.pos.y) || bad(state.pos.z) ||
        bad(state.vel.x) || bad(state.vel.y) || bad(state.vel.z) ||
        bad(state.heading) || bad(state.speed)) {
      console.warn('[physics] non-finite state, recovering');
      this.reset(state, Number.isFinite(state.pos.x) ? state.pos.x : 0,
                 Number.isFinite(state.pos.z) ? state.pos.z : 0,
                 Number.isFinite(state.heading) ? state.heading : Math.PI);
    }
  }
}
