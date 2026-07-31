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
const DRAG_UP = 0.0042;     // 1/m, upright (terminal ~20 m/s on a 12 deg pitch, 28 on 20)
const DRAG_TUCK = 0.0020;   // 1/m, tucked  (terminal ~29 m/s on a 12 deg pitch, 40 on 20)
// ---- edge dynamics ---------------------------------------------------------
// The edge angle is not a slider the input writes; it is where the rider's mass
// is, and mass takes time to move. Two nested limits model that:
//
//   EDGE_W        a critically damped spring that TRACKS the commanded edge. Set
//                 high (18 rad/s) on purpose — it is not the thing that slows the
//                 turn down, it just must not lag or ring. Making the spring slow
//                 instead produced a t^2 onset: the first 100 ms were dead and
//                 then it slammed, which is the worst of both.
//   EDGE_RATE_*   the real limit — how fast the edge angle itself can change.
//                 Tipping the ski from flat is quick; laying it further over once
//                 you are already inclined at 2 g means moving the whole body
//                 across the skis against that load, and it gets progressively
//                 harder. So the ceiling FADES with edge angle:
//
//                     rate_max(phi) = EDGE_RATE_SET * (1 - FADE * (|phi|/PHI_MAX)^P)
//
//                 2.30 rad/s flat (132 deg/s) down to 0.87 rad/s at full lock.
//                 That single line is what turns "tap = instant 60 deg" into an
//                 arc that keeps tightening for the better part of a second:
//                 ~8 deg at 100 ms, 30 deg at 300 ms, 90% at 0.61 s, lock at 0.79 s.
//                 The ceiling is untouched — full lock is still full lock.
//
//                 Releasing is the reverse move and gravity helps, so it gets its
//                 own, higher limit. It stays well short of the old 7.5 /s snap so
//                 that letting go of a turn no longer trips the rebound pop.
//
// Note it is a function of |phi| ONLY, never of load: load differs between a left
// and a right turn on any traverse, and the input->edge chain has to be exactly
// mirror-symmetric.
const EDGE_W = 18.0;          // rad/s, edge-angle tracking spring
const EDGE_RATE_SET = 2.30;   // rad/s, edge-roll ceiling from flat
const EDGE_SET_FADE = 0.62;   // ...falling to (1-FADE) of that at full lock
const EDGE_SET_P = 1.3;       // ...with this shape
const EDGE_RATE_REL = 4.20;   // rad/s, releasing an edge (standing up is easy)
const POP_FLAT = 1.30;      // m/s, pop on the flat: an unweight, ~8 cm
const POP_LIP = 3.20;       // m/s, extra, and only what the terrain earns you
const AIR_YAW = 2.0;        // rad/s, in-air rotation authority
const LEG_TRAVEL = 0.45;    // m of leg extension before the skis really leave the snow
const AIR_REPORT = 0.07;    // s of real flight before `airborne` is published
const SKI_LEN = 1.7;        // m, contact footprint — a ski bridges sub-metre holes
const LAT_ARM = 1.2;        // m, cross-ski arm used for the contact-plane gradient
// ---- lips ------------------------------------------------------------------
// The leg-travel model below is what stopped the rider skipping like a stone
// (64% of a straight coast used to be "airborne"), and it works because it
// refuses to call anything a take-off until the body has floated the whole
// 0.45 m. On a kicker that refusal costs 5 m: the rider was measured riding the
// deck past the knuckle and only separating 2-5 m late, which is the "floaty"
// take-off. Both are the same number doing two jobs.
//
// So the travel is not a constant — it is how far the legs can extend BEFORE THE
// SKI RUNS OUT OF SNOW, and that depends on whether there is any snow ahead:
//
//   * over a ripple or a mogul crest the ground comes back up to meet the ski,
//     the ski is supported the whole way, and the rider gets all 0.45 m;
//   * over a knuckle the ground is simply gone for twenty metres, the ski is
//     bridging a hole, and the travel that matters is nearly none.
//
// `lipDrop` (see `_contact`) is that test, measured rather than guessed: how far
// the ground 6 m ahead has fallen below the plane the ski is riding on, in slope
// units. Measured distributions — this is the whole reason for the look-ahead:
//
//                        open piste (p95 / p99 / max)     kickers, at the knuckle
//   contact convexity        0.136 / 0.164 / 0.198              0.17 - 0.21
//   lipDrop                  0.151 / 0.202 / 0.222              0.24 - 0.34
//
// Convexity alone cannot tell a mogul from a take-off — the ranges overlap
// completely, and thresholding it would put the rider in the air off bumps.
// lipDrop separates them, because "does the ground come back" is exactly the
// question. With the band below, an open-piste coast trips the shortened travel
// on 0.25% of substeps (against 0.42% of the run already spent airborne, i.e.
// inside the existing noise) while the kickers separate 2.5-3 m earlier.
//
// Tried and rejected: probing at 3 m as well and taking the smaller drop, on the
// theory that boulder terrain fools a single 6 m extrapolation. It changed the
// off-piste behaviour not at all (the ridge line really is falling away at both
// distances — it is a cliff band) and cost 1.5 m of take-off sharpness on the
// kickers. One probe.
const LOOK_AHEAD = 6.0;     // m, lip probe: how far ahead the ground must stay gone
const LIP_DROP0 = 0.12;     // ...below this, the ground ahead is still there
const LIP_DROP1 = 0.30;     // ...above this, the ski is bridging a hole
const LIP_BITE = 0.85;      // fraction of the leg travel a full lip takes away
const SUBSTEP = 1 / 120;
const MAX_START_TRAVERSE = 0.60;  // rad (34 deg) — a reset points down a mellow run
const MAX_START_STEEP = 1.22;     // rad (70 deg) — ...but you traverse a steep face

const clamp = THREE.MathUtils.clamp;
const smoothstep = (x, a, b) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapPi = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  return (a < 0 ? a + Math.PI * 2 : a) - Math.PI;
};

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
    this.nPop = 0;         // diagnostics: how often each air source actually fires
    this.nRebound = 0;
    this.compression = 0;    // suspension compression 0..1 (landings + turn load)
    this.landImpact = 0;
    this.lastAirTime = 0;
    this.gSpike = 0;         // decaying impact term folded into gForce
    this.roughness = 0;
    this.incline = 0;
    this.airT = 0;           // real time off the snow (state.airTime is hysteresed)
    this.jumpBuf = 0;
    this.pending = 0;
    this.vSurf = 0;          // d(contact height)/dt — the rate the snow is dropping
    this.gap = 0;            // leg extension: body above the ski contact point, m
    this.yFree = 0;          // shadow ballistic path of the centre of mass
    this.vFree = 0;
    this.squash = 0;         // legs compressed by the snow pushing up, 0..1
    this.convex = 0;         // contact-line curvature, slope units (+ = crest)
    this.lipDrop = 0;        // how far the ground ahead falls below the ski plane
    this.lipS = 0;           // smoothed lip signal that shortens the leg travel

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

  /**
   * Heading of the fall line at (x,z) — the direction `f` would have to face to
   * point straight down the hill. Sampled over a 12 m footprint so a mogul does
   * not decide which way "down" is.
   */
  fallLineHeading(x, z) {
    const n = this._t.copy(this.terrain.normal(x, z, 12));
    if (!(Math.abs(n.x) + Math.abs(n.z) > 1e-5)) return null;   // dead flat
    // downhill in xz is +(n.x, n.z); f = (-sin h, -cos h)  ⇒  h = atan2(-n.x, -n.z)
    return Math.atan2(-n.x, -n.z);
  }

  // ---------------------------------------------------------------------------
  reset(state, x, z, heading) {
    // ---- face down the hill ------------------------------------------------
    // A reset must never drop the rider facing UP the fall line: the start push
    // then fights gravity, the run "stalls" in the first three seconds, and every
    // speed-driven system downstream reads a rider that is really climbing.
    // The requested heading is honoured as a *cross-slope intent*: if it points
    // uphill it is mirrored through the fall line, which keeps its sideways
    // component exactly and only flips the along-hill one. Then it is limited to
    // a sane traverse angle, because a start gate points down the run.
    // How far off the fall line the start may sit scales with the pitch, because
    // that is what a skier actually does: point it down a blue, traverse a 40 deg
    // face. Forcing the fall line everywhere aimed the rider straight off the
    // cliff band on the ridge framing.
    const hFall = this.fallLineHeading(x, z);
    if (hFall !== null) {
      const pitch = Math.acos(clamp(this.terrain.normal(x, z, 12).y, -1, 1));
      const lim = MAX_START_TRAVERSE + (MAX_START_STEEP - MAX_START_TRAVERSE) *
                  smoothstep(pitch, 0.28, 0.62);
      let d = wrapPi(heading - hFall);
      if (Math.abs(d) > Math.PI / 2) d = Math.sign(d) * (Math.PI - Math.abs(d));
      heading = hFall + clamp(d, -lim, lim);
    }

    this._f.set(-Math.sin(heading), 0, -Math.cos(heading));
    state.pos.set(x, this._contact(x, z, this._f), z);
    state.heading = heading;

    // ---- flying start ------------------------------------------------------
    // Drop the rider in at the speed this pitch actually sustains rather than at
    // a fixed 8 m/s: a reset is "you are already skiing", not "you are standing
    // on a shelf". Solve the same steady state the sim converges to
    //     g·sin(theta) = mu·g·cos(theta) + kD·v²
    // for the along-track slope, and take 80% of it so there is still visible
    // acceleration in the first seconds.
    const n = this._n;
    this._contact(x, z, this._f, n);
    this._f.addScaledVector(n, -this._f.dot(n)).normalize();
    const along = Math.max(0, -this._f.y);                       // sin(effective pitch)
    const net = G * along - MU_SNOW * G * n.y;
    const vT = Math.sqrt(Math.max(0, net) / DRAG_UP);
    state.vel.copy(this._f).multiplyScalar(clamp(vT * 0.80, 8, 24));

    this.phi = 0; this.phiRate = 0; this.grounded = true;
    this.aLat = 0; this.aLatS = 0; this.aLong = 0; this.omega = 0; this.slip = 0; this.slipAngle = 0;
    this.turnRadius = Infinity; this.skidding = false; this.gripPenalty = 0;
    this.preload = 0; this.jumpHeld = false; this.reboundCd = 0; this.nPop = 0; this.nRebound = 0;
    this.compression = 0; this.landImpact = 0; this.lastAirTime = 0; this.gSpike = 0;
    this.roughness = 0; this.incline = 0; this.airT = 0; this.jumpBuf = 0; this.pending = 0;
    this.vSurf = state.vel.y; this.gap = 0; this.squash = 0;
    this.convex = 0; this.lipDrop = 0; this.lipS = 0;
    this.yFree = state.pos.y; this.vFree = state.vel.y;
    this.nSmooth.copy(n);
    this.pitchS = Math.asin(clamp(this._f.y, -1, 1));
    this.rollS = 0; this.crouchS = 0;

    state.speed = state.vel.length(); state.airTime = 0; state.distance = 0; state.time = 0;
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
   * Contact height under the skis, and — critically — the normal OF THAT SAME
   * SURFACE.
   *
   * A 1.7 m ski bridges sub-metre holes instead of tracing every noise wiggle, so
   * the height the body rides at is a footprint average. The normal has to be the
   * gradient of that averaged surface, not an independent finite difference of the
   * raw heightfield: those are two different surfaces, and mixing them is what
   * used to wreck the sim. The plane says "descend at vy", the contact height says
   * "descend at vy + 8 cm/s", and the lip detector reads the 8 cm/s discrepancy
   * over a 1/120 s step as 10 m/s² of ground falling away — so the skier chattered
   * into the air several times a second. Each of those micro-flights killed the
   * lateral force, reset the carve, and threw away the normal component of the
   * velocity on touchdown. That was the speed leak, not friction.
   *
   * Seven height samples (was 5 for the height + 4 for the normal), one basis.
   */
  _contact(x, z, f, outN) {
    const T = this.terrain, a = SKI_LEN * 0.33, b = SKI_LEN * 0.66;
    let fx = f.x, fz = f.z;
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-6) { fx /= fl; fz /= fl; } else { fx = 0; fz = -1; }

    const h0 = T.height(x, z);
    const hFa = T.height(x + fx * a, z + fz * a), hBa = T.height(x - fx * a, z - fz * a);
    const hFb = T.height(x + fx * b, z + fz * b), hBb = T.height(x - fx * b, z - fz * b);
    const h = 0.34 * h0 + 0.22 * (hFa + hBa) + 0.11 * (hFb + hBb);

    // ---- lip geometry, for the separation test in `_step` -------------------
    // Convexity of the contact line, in slope units: how much the ground breaks
    // between the tail half of the ski and the tip half. Zero on any straight
    // face however steep, positive over a crest, negative in a compression. Free
    // — the four samples are already here.
    const sTail = (h0 - hBb) / b;
    this.convex = (sTail - (hFb - h0) / b);
    // ...but convexity alone cannot tell a kicker's knuckle from a mogul crest:
    // measured on the open piste, convexity reaches 0.20 and the kickers only
    // peak at 0.17-0.21. What separates them is what happens NEXT. A mogul crest
    // is followed by a trough that comes back up to meet the ski; a knuckle is
    // followed by twenty metres of nothing. So look ahead one ski-length-plus and
    // ask how far the ground has fallen BELOW the plane the ski is currently on:
    // that is the gap the ski would have to bridge, and it is the difference
    // between a bump and a take-off.
    const hAhead = T.height(x + fx * LOOK_AHEAD, z + fz * LOOK_AHEAD);
    this.lipDrop = (h0 + sTail * LOOK_AHEAD - hAhead) / LOOK_AHEAD;

    if (outN) {
      const rx = -fz, rz = fx;                       // r = f x up  (see header)
      const c = LAT_ARM;
      const hR = T.height(x + rx * c, z + rz * c), hL = T.height(x - rx * c, z - rz * c);
      // Longitudinal slope from both arms — same low-pass width as the height.
      const sf = 0.35 * (hFa - hBa) / (2 * a) + 0.65 * (hFb - hBb) / (2 * b);
      const sr = (hR - hL) / (2 * c);
      outN.set(-sf * fx - sr * rx, 1, -sf * fz - sr * rz).normalize();
      if (!(outN.y > 0.05)) outN.set(0, 1, 0);
    }
    return h;
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
    let phiRate = this.phiRate + acc * dt;
    // Rolling further ONTO the edge (rate and angle the same sign) is the move
    // that gets progressively harder; coming back off it, or crossing over to the
    // other edge, is not.
    const aNorm = Math.abs(this.phi) / PHI_MAX;
    const rateCap = phiRate * this.phi >= 0
      ? EDGE_RATE_SET * (1 - EDGE_SET_FADE * Math.pow(aNorm, EDGE_SET_P))
      : EDGE_RATE_REL;
    this.phiRate = clamp(phiRate, -rateCap, rateCap);
    this.phi = clamp(this.phi + this.phiRate * dt, -PHI_MAX, PHI_MAX);
    const absPhi = Math.abs(this.phi);
    const dPhi = (absPhi - phiPrev) / dt;

    // --- the pop: an UNWEIGHT that modulates a takeoff, never a jump ----------
    // You cannot jump your way into the air on skis. What a rider actually does
    // is extend at the lip, and what that buys is proportional to what the
    // terrain was already giving them. So the pop is scaled by how much the snow
    // is doing the launching at the moment it fires:
    //
    //   lipNow   the ground has already started falling away — the legs are
    //            extending into the suspension travel. This is the lip.
    //   rampNow  the contact surface is still moving UP (vSurf > 0), i.e. the
    //            rider is on the face of a kicker or the back of a roller. On the
    //            open piste vSurf is negative (the hill descends), so this is
    //            zero and cannot be farmed on flat ground.
    //   coyote   already off the lip by a frame or two — full credit.
    //
    // On flat ground the whole authority is POP_FLAT: 1.30 m/s, an 8 cm hop that
    // reads as an unweight. Off a lip it adds up to 4.5 m/s and roughly doubles a
    // kicker's hang time, which is the skill the button is there to reward.
    //
    // History: this used to be `pending = 3.2 + 4.3 * preload` — a 7.5 m/s launch
    // out of nothing — and it was bound to W as well as Space, so *letting go of
    // the forward key* threw the rider 3.7 m into the air. Never again.
    let popImpulse = 0;
    this.jumpBuf = Math.max(0, this.jumpBuf - dt);
    if (jump) {
      this.jumpHeld = true;
      this.preload = Math.min(1, this.preload + dt / 0.28);  // legs load, air or not
    } else if (this.jumpHeld) {
      this.jumpHeld = false;
      this.pending = 0.30 + 0.70 * this.preload;            // charge, 0.30..1
      this.jumpBuf = 0.45;   // fires on the next contact, so a float never eats it
      this.preload = 0;
    } else {
      this.preload = Math.max(0, this.preload - dt * 3);
    }
    if (this.pending > 0) {
      if (this.grounded || this.airT < 0.12) {              // coyote time
        // Evaluated when it FIRES, not when the key was released, so the buffer
        // lets a slightly early release still catch the lip.
        const lipNow = clamp(this.gap / (LEG_TRAVEL * 0.5), 0, 1);
        const rampNow = clamp(this.vSurf / 2.5, 0, 1);
        const lip = this.grounded ? clamp(Math.max(lipNow, 0.7 * rampNow), 0, 1) : 1;
        popImpulse = this.pending * (POP_FLAT + POP_LIP * lip);
        this.nPop++;
        this.pending = 0; this.jumpBuf = 0;
      } else if (this.jumpBuf === 0) {
        this.pending = 0;                                   // buffer expired
      }
    }

    // --- rebound: unloading a loaded turn extends the LEGS ---------------------
    // Cross-over rebound is real, and the old code modelled it as a launch: a
    // straight-to-the-sky impulse whenever a >1.45 g edge was released quickly.
    // Measured, that put the rider airborne for 12.6% of a 2 s-period linked-carve
    // run — i.e. "let go of the turn key and jump", the same defect as the old W
    // binding wearing a physics costume.
    //
    // It is fixed by putting the energy where it actually goes. A decambering ski
    // pushes the rider's mass UP THROUGH THE LEGS; whether that takes the skis off
    // the snow is not the rebound's decision, it is the suspension's — exactly the
    // question `gap > LEG_TRAVEL` already answers for terrain. So the rebound only
    // seeds the free-flight path of the centre of mass (see the suspension block
    // below) and the existing model decides the rest.
    //
    // That makes the guarantee arithmetic rather than a threshold to tune:
    // separation on even ground needs sqrt(2*G*LEG_TRAVEL) = 3.15 m/s and
    // REBOUND_MAX is 1.25, so a rebound there CANNOT put the rider in the air —
    // the most it can do is extend the legs by v^2/2G = 7 cm, which is what a
    // rebound looks like. Over a roll, where the snow is already dropping away
    // and the legs are part-extended, the same 1.25 m/s can carry the gap past
    // the travel limit and you fly. Which is when a rebound really does.
    //
    // Measured over 40 s of 2 s-period linked carving: it fires 16 times and the
    // run is 3.3% airborne, essentially all of it terrain the carve crosses at
    // speed (the same line spends 0.7% airborne with no input at all). The old
    // launch-impulse version fired every turn and spent 12.6% airborne.
    const REBOUND_MAX = 1.25;  // m/s; < sqrt(2*G*LEG_TRAVEL) = 3.15 by construction
    let reboundV = 0;
    this.reboundCd = Math.max(0, this.reboundCd - dt);
    if (this.grounded && !this.jumpHeld && this.reboundCd === 0 &&
        dPhi < -2.8 && loadPrev > 1.60 && brake < 0.5) {
      reboundV = Math.min(REBOUND_MAX, (loadPrev - 1.5) * 1.3);
      this.reboundCd = 0.50;
      this.nRebound++;
    }

    // --- ground sample --------------------------------------------------------
    // The plane the skier rides on and the height he rides at come from the SAME
    // footprint sample, so vy and d(contact)/dt agree and nothing chatters.
    const f0 = this._f.set(-Math.sin(state.heading), 0, -Math.cos(state.heading));
    const n = this._n;
    const ghPrev = this._contact(pos.x, pos.z, f0, n);

    const yPrev = pos.y;

    if (this.grounded) {
      // ---- ski frame on the slope -------------------------------------------
      const f = f0;
      f.addScaledVector(n, -f.dot(n));
      if (f.lengthSq() < 1e-8) f.set(-Math.sin(state.heading), 0, -Math.cos(state.heading));
      f.normalize();
      const r = this._r.crossVectors(f, n).normalize();

      // ---- re-seat the velocity on the slope, WITHOUT eating energy ---------
      // The ground constraint is workless: it may rotate the velocity into the
      // surface, never shorten it. Plain projection is a contraction, so doing it
      // 120x a second over rolling ground is a silent brake — every convexity and
      // every concavity alike scrubs |v| by cos(theta). That, not friction, is
      // what used to strangle a coast. Rotate instead: project, then restore the
      // length. The cap keeps a genuine impact (which the landing branch has
      // already absorbed) from being laundered into forward speed.
      const spd0 = vel.length();
      vel.addScaledVector(n, -vel.dot(n));
      const spd1 = vel.length();
      if (spd1 > 1e-5) vel.multiplyScalar(Math.min(spd0 / spd1, 1.05));

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

      // ---- suspension: the SKIS follow the snow, the BODY does not -----------
      // vSurf is how fast the contact height is dropping; -d(vSurf)/dt is the
      // downward acceleration the snow is demanding. Gravity supplies G and legs
      // cannot pull — but the answer to "the ground fell away faster than g" is
      // NOT that the skis leave the snow, it is that the legs extend. The skis
      // stay in contact and the centre of mass floats on a smoother path. You are
      // only truly airborne when that extension runs out of travel.
      //
      // Without this the rider skips like a stone: on a 12 deg piste at 70 km/h
      // an 8 m ripple needs ~2 g to follow, so an instantaneous >1 g test fires
      // several times a second. Measured: 64% of a straight coast was "airborne",
      // and every one of those touchdowns scrubbed the normal component of the
      // velocity. Modelling the 0.45 m of leg travel takes that to ~0%.
      const ghNew = this._contact(pos.x, pos.z, f);
      const vSurfPrev = this.vSurf;
      const vSurf = (ghNew - yPrev) / dt;
      const need = -(vSurf - vSurfPrev) / dt;
      this.vSurf = vSurf;

      if (this.gap <= 0 && need <= G) {
        this.yFree = ghNew; this.vFree = vSurf; this.gap = 0;
      } else {
        if (this.gap <= 0) { this.yFree = yPrev; this.vFree = vSurfPrev; }  // separation begins
        this.vFree -= G * dt;
        this.yFree += this.vFree * dt;
        this.gap = this.yFree - ghNew;
        if (this.gap <= 0) { this.yFree = ghNew; this.vFree = vSurf; this.gap = 0; }
      }
      // Rebound enters here and nowhere else: it is a push through the legs, so it
      // accelerates the centre of mass along the same free path the terrain uses.
      // On even ground the legs swallow it (see REBOUND_MAX); where the snow is
      // already dropping away it can carry the gap past LEG_TRAVEL and the rider
      // genuinely comes off the roll.
      if (reboundV > 0) {
        if (this.gap <= 0) { this.yFree = ghNew; this.vFree = vSurf; }
        this.vFree += reboundV;
        this.gap = Math.max(this.gap, 1e-4);
      }
      // How hard the snow is pushing UP into the rider — the other half of the
      // suspension, and what makes a compression feel heavy.
      this.squash += (clamp(-need / (G * 1.6), 0, 1) - this.squash) * Math.min(1, dt * 12);

      // How much travel the legs actually have here — full on ground that comes
      // back, almost none where the ski is bridging a hole. See LIP_* above.
      const travel = LEG_TRAVEL * (1 - LIP_BITE * smoothstep(this.lipDrop, LIP_DROP0, LIP_DROP1));
      this.lipS = 1 - travel / LEG_TRAVEL;

      if (popImpulse > 0 || this.gap > travel) {
        this.grounded = false;
        this.airT = 0;
        // Leave the lip on the path the body was already on.
        if (popImpulse === 0) { vel.y = this.vFree; pos.y = Math.max(this.yFree, ghNew); }
        else pos.y = ghNew;
        this.gap = 0;
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
      const nl = this._n;
      const ghNew = this._contact(pos.x, pos.z, f, nl);
      if (pos.y <= ghNew) {
        // ---- landing: a slope-matched touchdown keeps its speed ---------------
        // Only the velocity INTO the snow is destroyed, so matching the landing
        // angle to the slope costs almost nothing while a flat-deck landing at
        // the same speed compresses hard and scrubs.
        pos.y = ghNew;
        const spdIn = vel.length();
        const impact = Math.max(0, -vel.dot(nl));      // normal closing speed
        vel.addScaledVector(nl, -vel.dot(nl));         // absorbed, never bounce
        // A graze is not a landing. Below ~1.2 m/s of closing speed the skis are
        // just running over a roller, so re-seat the velocity without eating it —
        // otherwise every whisper of terrain taxes the run.
        if (impact < 1.2) {
          const l = vel.length();
          if (l > 1e-5) vel.multiplyScalar(Math.min(spdIn / l, 1.05));
        }
        const hard = clamp((impact - 1.2) / 16, 0, 1.6);   // ignore micro-touches
        vel.multiplyScalar(1 - 0.40 * Math.pow(hard, 1.5));
        this.compression = Math.min(1.4, this.compression + hard * 1.1);
        this.gripPenalty = Math.min(1, this.gripPenalty + hard * 0.9);
        this.gSpike = Math.min(6, this.gSpike + impact * 0.22);
        this.landImpact = Math.max(this.landImpact, impact);
        this.grounded = true;
        this.airT = 0;
        this.phiRate *= 0.3;
        this.vSurf = vel.y;
        this.gap = 0; this.yFree = pos.y; this.vFree = vel.y;
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

    // Body-scale surface normal — the SAME contact plane the sim integrates on,
    // so the rig, the camera and the spray are never oriented to a surface the
    // physics does not believe in.
    const f = this._f.set(-Math.sin(state.heading), 0, -Math.cos(state.heading));
    const nw = this._nw;
    this._contact(pos.x, pos.z, f, nw);

    // Roughness = how far the ground under the skis departs from the macro face.
    // That is what actually rattles a rider: bumps, ripples, a chopped-up piste.
    this._t.copy(T.normal(pos.x, pos.z, 5.0));
    const rough = 1 - clamp(nw.dot(this._t), -1, 1);
    this.roughness += (Math.min(1, rough * 40) - this.roughness) * Math.min(1, dt * 4);

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
      this.squash * 0.30 +                       // snow pushing up through the legs
      load * 0.16 +
      (state.airborne ? 0.18 : 0)
      - (this.gap / LEG_TRAVEL) * 0.22, 0, 1);   // ...and extending over a roller
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
    m.suspension = this.gap / LEG_TRAVEL;
    m.squash = this.squash;
    m.roughness = this.roughness;
    m.preload = this.preload;
    m.aLat = this.aLatS;
    m.inclination = this.incline;

    m.aLong = this.aLong;
    m.grip = this.gripPenalty;
    m.nPop = this.nPop;
    m.nRebound = this.nRebound;
    m.convex = this.convex;
    m.lipDrop = this.lipDrop;
    m.lipS = this.lipS;
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
