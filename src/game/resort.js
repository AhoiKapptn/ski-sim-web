import * as THREE from 'three';

/**
 * Alpine — the resort loop.
 *
 * Skiing down was the whole game. This is the rest of the day: ride the chair
 * back up, take the T-bar for a short lap, and stop at the mid-mountain
 * restaurant for a coffee or a beer.
 *
 * ### One mode machine, not three overrides
 *
 * "On the chair", "on the T-bar" and "inside the hut" are all the same statement
 * — *the player is not skiing right now* — and every subsystem needs to agree
 * about it in the same frame. So there is exactly one authority:
 *
 *      state.mode  'ski' | 'lift' | 'drag' | 'hut'
 *
 * written here and nowhere else. `main.js` reads it to decide whether physics
 * and the chase camera run at all; `hud.js` reads it to swap instruments for
 * prompts; `audio.js` reads it to stop pretending the rider is doing 90 km/h.
 * Adding a fourth mode is adding a case here, not another `if` in five files.
 *
 * The rule main.js enforces:
 *
 *   mode      physics   chaseCam   camera driven by   skier rig   tracks
 *   ski       yes       yes        chaseCam           visible     yes
 *   drag      NO        yes        chaseCam           visible     yes (a T-bar
 *                                                                 lane really
 *                                                                 is tracked up)
 *   lift      NO        no         resort.camera()    hidden      no
 *   hut       NO        no         resort.camera()    hidden      no
 *
 * Physics is *suspended*, never fought: while a ride is running this file owns
 * `pos`, `vel`, `speed`, `heading` and `groundNormal`, and `physics.update()` is
 * not called at all. Handing control back is a `physics.reset()`, which is the
 * same path `harness.setPlayer()` uses and therefore already correct about
 * facing down the fall line.
 *
 * ### The placement seam
 *
 * Everything the player is put on top of is read from `scatter`:
 * `scatter.lift.cables[]` (the catenary samples the chairs already ride, with
 * their arc-length table) and `scatter.buildings[]`. Nothing here re-derives the
 * corridor centreline or the cable sag — per CLAUDE.md, a second copy of either
 * is the seam that has broken every integration in this repo.
 *
 * ### What it publishes
 *
 *   state.mode      as above
 *   state.modeT     seconds since the mode was entered
 *   state.prompt    { key, text, sub } | null   — the "press E" contact prompt
 *   state.ride      { kind, name, s, total, progress, speed, hint } | null
 *   state.hut       { name, choices, drink, note, run } | null
 *   state.warmth    0..1, drains while skiing, refilled by a hot drink
 *   state.run       { top, bestAir } live maxima for the current run
 *   state.veil      0..1 screen dip, driven through a door or a skipped ride
 *   state.glow      0..1 warm flash, fired by the first sip
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

// --- timings -----------------------------------------------------------------
const T_BOARD = 1.45;      // chase view -> seated on the chair
const T_SHOW_SKIER = 0.62; // ...of which the rider is still standing on the snow
const T_BOARD_HOLD = 0.42; // ...and of which the camera has not moved yet (fraction)
const T_OFF = 1.05;        // seated -> chase view, after the unload
const T_DOOR = 0.42;       // veil in / out through a doorway
const T_SIP = 1.30;        // the drink comes up to the lens
const T_BAR_BEAT = 2.40;   // the look across at the counter when a drink is ordered

// --- the chair ---------------------------------------------------------------
/**
 * Line speed, m/s. This is `chairPhase += dt * 4.6` in scatter.js: the player's
 * chair has to travel at exactly the speed the *other* chairs do or it visibly
 * overtakes them. scatter.js does not export the figure, so this is the one
 * number in this file that is a copy, and it is deliberately not hidden behind
 * an abstraction — if the lift is ever re-geared, this line is the second half
 * of that change.
 *
 * The number being right is only half of staying in phase; the other half is
 * integrating it over the SAME dt scatter does. `scatter.update` does not clamp
 * dt and this file used to clamp to 0.1 before advancing `rideS`, so any caller
 * stepping in coarse slices desynchronised the two — measured, `harness.step(0.25)`
 * for 40 frames moved the player 18.35 m and scatter 46 m, 25.5 m of drift (70%
 * of chair spacing) in ten seconds of sim. main.js clamps to 0.05 before either
 * sees it, so this was never reachable live, but every capture tool in tools/
 * can reach it. The ride therefore integrates the RAW dt (see `update`), and the
 * clamp survives only for the eases and smoothing, which genuinely do want it.
 */
const CHAIR_SPEED = 4.6;

// --- ride time compression ---------------------------------------------------
/**
 * A chairlift is honest at 4.6 m/s and unwatchable at 4 km. The full line is
 * 3998.8 m — **867 seconds** — and only the first couple of hundred metres carry
 * it: the village, the towers, the down-side chairs going past. After that it is
 * six unbroken minutes of snow with a girder across the bottom third.
 *
 * The honest fix is not a faster lift, it is a timelapse: REAL time while there
 * is something to look at — leaving a station, arriving at the next one — and up
 * to LAPSE_MAX in between. The scale is applied to `rideS` here AND, through
 * `resort.timeScale` in main.js, to the dt `scatter.update` integrates, so the
 * chairs coming the other way stay exactly in step at every speed. That is the
 * whole reason CHAIR_SPEED is 4.6 in the first place; a compression that moved
 * only the player would throw it away.
 */
const LAPSE_HEAD = 92;     // metres of real-time travel after boarding (20 s)
const LAPSE_TAIL = 78;     // ...and before the unload (17 s)
const LAPSE_RAMP = 120;    // metres to wind up and down over
const LAPSE_MAX = 8;       // 36.8 m/s at full lapse
/** Seat pad below the cable, from scatter.js' chair geometry (grip at y = 0). */
const SEAT_DROP = 2.92;
const EYE_UP = 1.06;       // seated eye above the pad
/** How far short of the top terminal the chair puts you down. */
const UNLOAD_MARGIN = 22;
const BOARD_MARGIN = 9;    // ...and how far past the bottom one it picks you up

// --- interaction -------------------------------------------------------------
const REACH_LIFT = 26;     // metres, boarding zone radius
const REACH_DOOR = 15;
const BOARD_SPEED = 10;    // m/s — above this you are asked to scrub first
/**
 * Minimum seconds between two orders at the bar. `controls.js` publishes `pick`
 * as a LEVEL, and this file used to guard only "not already drinking that", so
 * alternating 1 and 2 for two seconds pushed 120 entries into `state.runs`, fired
 * 120 `sip()` one-shots and advanced the sun by 0.74 of a day — measured. The
 * edge test below is the real fix; this is the belt to that braces, and it also
 * stops a held key re-ordering the instant you switch drinks.
 */
const PICK_COOLDOWN = 1.0;
/**
 * The sun may not be driven past closing time. Every number in CLAUDE.md's
 * quality-baseline table is measured at tod 0.302, and `serve()` is the only
 * thing in the game that moves it: 26 beers took it to 0.822 and the scene mean
 * from 176.8 to 44.0 — a night scene reachable by holding a key. A stop still
 * costs time (that is the point), but the day ends when the last lift does.
 */
const TOD_LAST_LIFT = 0.66;

// --- warmth ------------------------------------------------------------------
// A full tank is ~11 minutes of skiing, which is 3-6 runs: long enough that it
// is never nagging, short enough that the hut is somewhere you actually go.
const WARM_DRAIN = 1 / 660;
const WARM_CHILL = 1 / 7200;   // per (m/s) per second — wind chill

// =============================================================================
// interior geometry
// =============================================================================

/**
 * Tiny mesh builder. Positions/normals/albedo into flat arrays; the lighting is
 * baked into the vertex colours afterwards by `bake()`, so the whole interior
 * draws with ONE unlit material and adds no light to the scene.
 *
 * That last point is not a micro-optimisation. Adding a PointLight would change
 * the lights uniform block and force every material in the scene to relink —
 * a multi-frame stall (see `warmShaders` in main.js) for a room the player is
 * in for fifteen seconds.
 */
class Bld {
  constructor() { this.p = []; this.n = []; this.c = []; }

  tri(a, b, c, col) {
    const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const l = Math.hypot(nx, ny, nz) || 1;
    for (const v of [a, b, c]) {
      this.p.push(v.x, v.y, v.z);
      this.n.push(nx / l, ny / l, nz / l);
      this.c.push(col[0], col[1], col[2]);
    }
  }

  quad(a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); }

  /** Box from world min/max corners. */
  box(x0, y0, z0, x1, y1, z1, col) {
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const a = V(x0, y0, z0), b = V(x1, y0, z0), c = V(x1, y0, z1), d = V(x0, y0, z1);
    const e = V(x0, y1, z0), f = V(x1, y1, z0), g = V(x1, y1, z1), h = V(x0, y1, z1);
    this.quad(e, f, g, h, col);
    this.quad(d, c, b, a, col);
    this.quad(a, b, f, e, col);
    this.quad(c, d, h, g, col);
    this.quad(b, c, g, f, col);
    this.quad(d, a, e, h, col);
    return this;
  }

  /** Vertical cylinder, y0..y1, no caps unless asked. */
  cyl(x, z, y0, y1, r, col, seg = 8, cap = true) {
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      const a = new THREE.Vector3(x + Math.cos(t0) * r, y0, z + Math.sin(t0) * r);
      const b = new THREE.Vector3(x + Math.cos(t1) * r, y0, z + Math.sin(t1) * r);
      const c = new THREE.Vector3(x + Math.cos(t1) * r, y1, z + Math.sin(t1) * r);
      const d = new THREE.Vector3(x + Math.cos(t0) * r, y1, z + Math.sin(t0) * r);
      this.quad(a, b, c, d, col);
      if (cap) {
        this.tri(new THREE.Vector3(x, y1, z), c, d, col);
        this.tri(new THREE.Vector3(x, y0, z), b, a, col);
      }
    }
    return this;
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }

  get triangles() { return this.p.length / 9; }
}

/**
 * Bake a warm interior into the vertex colours: one hanging lamp, the stove
 * mouth, a candle on the sill, and cool daylight coming in off the window wall.
 * Cheap Lambert with an inverse-square falloff — no shadowing, because a room
 * lit by one lamp and one window reads correctly from the falloff alone, and
 * because the alternative is a light in the scene (see Bld's note).
 */
function bakeInterior(geo, L) {
  const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal');
  const col = geo.getAttribute('color');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
    // ambient: a little warmer low down (floor bounce), cooler at the ceiling
    let r = 0.055 + 0.018 * (1 - ny), g = 0.048 + 0.018 * (1 - ny), b = 0.046 + 0.026 * (1 + ny);
    for (const lt of L.points) {
      const dx = lt.x - x, dy = lt.y - y, dz = lt.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const d = Math.sqrt(d2) || 1e-3;
      let ndl = (nx * dx + ny * dy + nz * dz) / d;
      if (ndl <= 0) ndl = lt.wrap ? -ndl * 0.12 : 0;    // a lamp bounces off the walls
      const att = lt.k / (1 + d2 / (lt.range * lt.range));
      r += lt.c[0] * ndl * att; g += lt.c[1] * ndl * att; b += lt.c[2] * ndl * att;
    }
    // daylight through the window wall: a broad cool source from -w
    const wd = Math.max(0, nx * L.win.x + ny * L.win.y + nz * L.win.z);
    const near = clamp(1 - L.winDist(x, y, z) / 9.0, 0.12, 1);
    r += L.winC[0] * wd * near; g += L.winC[1] * wd * near; b += L.winC[2] * wd * near;
    col.setXYZ(i, col.getX(i) * r, col.getY(i) * g, col.getZ(i) * b);
  }
  col.needsUpdate = true;
  return geo;
}

// timber and furnishing albedos (linear)
const C_FLOOR = [0.62, 0.44, 0.28];
const C_WALL = [0.66, 0.50, 0.34];
const C_WAIN = [0.34, 0.22, 0.14];
const C_BEAM = [0.26, 0.17, 0.10];
const C_STONE = [0.42, 0.41, 0.39];
const C_BAR = [0.50, 0.32, 0.18];
const C_STEEL = [0.55, 0.57, 0.60];
const C_BLACK = [0.10, 0.10, 0.11];
const C_CLOTH = [0.72, 0.16, 0.12];
const C_CERAM = [0.92, 0.90, 0.86];
const C_PAPER = [0.88, 0.84, 0.74];

/**
 * The room, built in WORLD space at a `scatter.buildings[]` entry.
 *
 * Why a real room and not a menu: a hut you cannot go into is a prop. Why it is
 * cheap anyway — one unlit draw call, one glow draw call, ~2.5k triangles, and
 * `visible = false` whenever the player is not inside, so the cost while skiing
 * is a boolean.
 *
 * The single load-bearing observation is that the hut's exterior walls are
 * single-sided and face OUT (scatter's `boardFace` emits the front face only),
 * so from inside they do not exist and the window aperture in this shell looks
 * straight out at the mountain. The glazing boxes are solid, though, so the
 * aperture is placed on the stretch of gable wall between them.
 */
function buildInterior(b) {
  const yaw = b.yaw;
  // local axes: `a` across the ridge (the deck is at +a), `c` along it
  const ax = Math.cos(yaw), az = -Math.sin(yaw);
  const cx = Math.sin(yaw), cz = Math.cos(yaw);
  const W = b.w - 0.42, D = b.d - 0.42;
  const y0 = b.floorY + 0.06;
  const y1 = y0 + 2.62;                       // ceiling
  // world point from local (a, c, y)
  const P = (a, c, y) => new THREE.Vector3(b.x + ax * a + cx * c, y, b.z + az * a + cz * c);
  const V = (a, c, y) => P(a, c, y);

  const lit = new Bld();
  const glow = new Bld();

  /**
   * A box in the ROOM's frame, given two opposite corners in local (a, c, y).
   *
   * Everything in here was first written as `dst.box(...P(a,c,y).toArray(), ...)`,
   * which builds a WORLD-axis-aligned box between two rotated points: at this
   * hut's 29-degree yaw a 1.56 x 1.24 m table came out 0.77 x 1.84 m and pointing
   * the wrong way, and a 1.7 m bench came out as a slab across the room. The
   * furniture has to be built in the frame the room is in.
   */
  const BX = (dst, a0, c0, yLo, a1, c1, yHi, col) => {
    const A0 = Math.min(a0, a1), A1 = Math.max(a0, a1);
    const C0 = Math.min(c0, c1), C1 = Math.max(c0, c1);
    const Y0 = Math.min(yLo, yHi), Y1 = Math.max(yLo, yHi);
    const q = [
      P(A0, C0, Y0), P(A1, C0, Y0), P(A1, C1, Y0), P(A0, C1, Y0),
      P(A0, C0, Y1), P(A1, C0, Y1), P(A1, C1, Y1), P(A0, C1, Y1),
    ];
    dst.quad(q[4], q[5], q[6], q[7], col);      // top
    dst.quad(q[3], q[2], q[1], q[0], col);      // bottom
    dst.quad(q[0], q[1], q[5], q[4], col);      // -c
    dst.quad(q[2], q[3], q[7], q[6], col);      // +c
    dst.quad(q[1], q[2], q[6], q[5], col);      // +a
    dst.quad(q[3], q[0], q[4], q[7], col);      // -a
  };

  /**
   * A swept 4-sided tube through a polyline given in the room's (a, c, y) frame.
   *
   * This exists because BX cannot describe anything that is not axis-aligned in
   * the room, and the ONE piece of furniture that is not — the mug handle — was
   * built out of world-axis AABBs around pairs of arc points, the exact bug BX's
   * own comment says was swept out of the tables and benches. At this hut's yaw
   * that turned a 6 cm arc of ceramic into a staircase of little slabs pointing
   * the wrong way.
   */
  const TUBE = (dst, pts, r, col) => {
    const W3 = pts.map(([a, c, y]) => P(a, c, y));
    const d = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
    const up = new THREE.Vector3();
    const ring = (o) => {
      const out = [];
      for (let k = 0; k < 4; k++) {
        const t = k * Math.PI * 0.5;
        const ct = Math.cos(t), st = Math.sin(t);
        out.push(new THREE.Vector3(o.x + u.x * ct + v.x * st, o.y + u.y * ct + v.y * st,
          o.z + u.z * ct + v.z * st));
      }
      return out;
    };
    for (let i = 0; i < W3.length - 1; i++) {
      const A = W3[i], B = W3[i + 1];
      d.subVectors(B, A);
      if (d.lengthSq() < 1e-10) continue;
      d.normalize();
      up.set(0, 1, 0);
      if (Math.abs(d.y) > 0.9) up.set(1, 0, 0);
      u.crossVectors(up, d).normalize().multiplyScalar(r);
      v.crossVectors(d, u).normalize().multiplyScalar(r);
      const r0 = ring(A), r1 = ring(B);
      for (let k = 0; k < 4; k++) dst.quad(r0[k], r0[(k + 1) % 4], r1[(k + 1) % 4], r1[k], col);
    }
  };

  /**
   * Emit a quad with its normal facing INTO the room, whichever order its
   * corners were given in.
   *
   * Every surface of the shell is a single-sided quad, and three of them were
   * wound the wrong way: the +c wall, the -a wall and — the one that matters —
   * the FLOOR, whose 22 boards and 22 seam lines all faced down. From inside
   * they did not exist, so the room's timber floor was actually the snow outside
   * showing through, and the -a end of the room was open onto the terrace.
   *
   * It survived because nothing could ever look at it: the camera is fixed, and
   * the "A/D look around" that would have swung onto the missing wall was
   * reading a channel the mode machine zeroes (see updateHut). The moment that
   * was fixed, the hole was the first thing in frame. `side: DoubleSide` is not
   * the fix — `bakeInterior` bakes the lighting into the vertex colours off
   * these same normals, so a back-facing floor comes back lit from underneath.
   */
  const CTR = P(0, 0, (y0 + y1) * 0.5);
  const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
  const _nn = new THREE.Vector3(), _to = new THREE.Vector3();
  const FACE = (dst, p0, p1, p2, p3, col) => {
    _e1.subVectors(p1, p0); _e2.subVectors(p2, p0);
    _nn.crossVectors(_e1, _e2);
    _to.subVectors(CTR, p0);
    if (_nn.dot(_to) >= 0) dst.quad(p0, p1, p2, p3, col);
    else dst.quad(p3, p2, p1, p0, col);
  };

  // ---- shell ---------------------------------------------------------------
  // The window is a band in the -c gable, 5.0 m wide and 1.15 m tall, with a
  // mullion; the wall is emitted as four pieces around it.
  //
  // WHERE it sits was measured, not chosen. The hut's own glazing boxes are
  // solid from both sides, so an aperture over one of them looks out at a black
  // rectangle with pink shutters floating in the middle of the view — which is
  // exactly what the first cut did. Probing the exterior mesh for vertices on
  // this wall puts its openings at a = -4.5..-3.0 and -1.0..+1.0, so the window
  // goes in the clear stretch to the right of them.
  const WCEN = 4.0, WHALF = 2.5;
  const WA0 = WCEN - WHALF, WA1 = WCEN + WHALF;
  const WY0 = y0 + 0.98, WY1 = y0 + 2.13;

  const wall = (a0, c0, a1, c1, yLo, yHi, col) => {
    FACE(lit, V(a0, c0, yLo), V(a1, c1, yLo), V(a1, c1, yHi), V(a0, c0, yHi), col);
  };
  // floor: boards across the room, tone varying course to course
  {
    const n = 22;
    for (let i = 0; i < n; i++) {
      const a0 = -W + (2 * W) * (i / n), a1 = -W + (2 * W) * ((i + 1) / n);
      const k = 0.80 + 0.34 * (((i * 2654435761) >>> 12 & 255) / 255);
      const col = [C_FLOOR[0] * k, C_FLOOR[1] * k, C_FLOOR[2] * k];
      FACE(lit, V(a0, -D, y0), V(a1, -D, y0), V(a1, D, y0), V(a0, D, y0), col);
      // a dark seam line so the boards read at grazing angles
      FACE(lit, V(a1 - 0.012, -D, y0 + 0.004), V(a1, -D, y0 + 0.004),
        V(a1, D, y0 + 0.004), V(a1 - 0.012, D, y0 + 0.004), [0.16, 0.11, 0.07]);
    }
  }
  // ceiling + beams
  FACE(lit, V(W, D, y1), V(-W, D, y1), V(-W, -D, y1), V(W, -D, y1), [0.40, 0.31, 0.22]);
  for (let i = 0; i < 5; i++) {
    const c = -D + (2 * D) * ((i + 0.5) / 5);
    BX(lit, -W, c - 0.11, y1 - 0.24, W, c + 0.11, y1 - 0.02, C_BEAM);
  }
  // walls: planked above a dark wainscot
  const WAINY = y0 + 0.92;
  for (const [a0, c0, a1, c1] of [[-W, D, W, D], [W, -D, W, D], [-W, -D, -W, D]]) {
    // planks
    const len = Math.hypot(a1 - a0, c1 - c0);
    const n = Math.max(3, Math.round(len / 0.34));
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const k = 0.82 + 0.30 * (((i * 40503 + 7) >>> 9 & 255) / 255);
      wall(lerp(a0, a1, t0), lerp(c0, c1, t0), lerp(a0, a1, t1), lerp(c0, c1, t1), WAINY, y1,
        [C_WALL[0] * k, C_WALL[1] * k, C_WALL[2] * k]);
    }
    wall(a0, c0, a1, c1, y0, WAINY, C_WAIN);
  }
  // window wall (-c), in four pieces around the aperture
  wall(-W, -D, WA0, -D, y0, y1, C_WALL);
  wall(WA1, -D, W, -D, y0, y1, C_WALL);
  wall(WA0, -D, WA1, -D, y0, WY0, C_WAIN);
  wall(WA0, -D, WA1, -D, WY1, y1, C_WALL);
  // reveal + frame + one mullion, standing proud of the wall so the opening
  // reads as a thick timber window and not as a hole cut in a card
  {
    const R = 0.16;
    BX(lit, WA0 - 0.12, -D - 0.02, WY0 - 0.12, WA1 + 0.12, -D + R, WY0, C_BEAM);
    BX(lit, WA0 - 0.12, -D - 0.02, WY1, WA1 + 0.12, -D + R, WY1 + 0.12, C_BEAM);
    for (const sa of [WA0, WA1]) {
      BX(lit, sa - 0.12, -D - 0.02, WY0, sa + 0.12, -D + R, WY1, C_BEAM);
    }
    BX(lit, WCEN - 0.045, -D - 0.02, WY0, WCEN + 0.045, -D + R * 0.7, WY1, C_BEAM);
    // sill, wide enough to put a candle on
    BX(lit, WA0 - 0.2, -D + 0.02, WY0 - 0.14, WA1 + 0.2, -D + 0.52, WY0, C_BAR);
  }

  // ---- the bar, along +a ---------------------------------------------------
  const BA = W - 1.15;                        // counter front edge
  BX(lit, BA, -1.2, y0, W, 5.6, y0 + 1.06, C_BAR);
  BX(lit, BA - 0.10, -1.3, y0 + 1.06, W, 5.7, y0 + 1.14, [0.42, 0.26, 0.13]);
  // brass foot rail along the front of the counter
  {
    const r0 = P(BA - 0.13, -1.1, y0 + 0.82), r1 = P(BA - 0.13, 5.5, y0 + 0.82);
    const seg = 6, rr = 0.035;
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      const off = (t, p) => new THREE.Vector3(p.x + Math.cos(t) * rr * ax, p.y + Math.sin(t) * rr, p.z + Math.cos(t) * rr * az);
      lit.quad(off(t0, r0), off(t1, r0), off(t1, r1), off(t0, r1), [0.86, 0.62, 0.24]);
    }
  }
  // back shelf with bottles and hanging glasses
  BX(lit, W - 0.30, 0.2, y0 + 1.30, W - 0.06, 5.2, y0 + 1.40, C_BEAM);
  BX(lit, W - 0.30, 0.2, y0 + 1.86, W - 0.06, 5.2, y0 + 1.96, C_BEAM);
  const BOTTLE = [[0.16, 0.30, 0.12], [0.36, 0.14, 0.08], [0.10, 0.16, 0.30],
    [0.52, 0.40, 0.12], [0.20, 0.10, 0.24], [0.44, 0.44, 0.42]];
  for (let i = 0; i < 14; i++) {
    const c = 0.45 + i * 0.34;
    if (c > 5.1) break;
    const sh = i % 2 ? 1.40 : 1.96;
    const hgt = 0.24 + 0.10 * ((i * 7919) % 3) / 2;
    const p = P(W - 0.18, c, 0);
    lit.cyl(p.x, p.z, y0 + sh, y0 + sh + hgt, 0.035, BOTTLE[i % BOTTLE.length], 6);
    lit.cyl(p.x, p.z, y0 + sh + hgt, y0 + sh + hgt + 0.09, 0.013, BOTTLE[i % BOTTLE.length], 5);
  }
  // beer taps: three chrome columns and a swan neck
  for (let i = 0; i < 3; i++) {
    const c = 2.0 + i * 0.34;
    const p = P(BA + 0.45, c, 0);
    lit.cyl(p.x, p.z, y0 + 1.14, y0 + 1.44, 0.032, C_STEEL, 8);
    const qa = BA + 0.30;
    BX(lit, qa - 0.05, c - 0.05, y0 + 1.40, qa + 0.05, c + 0.05, y0 + 1.47, C_STEEL);
    const q = P(qa, c, 0);
    lit.cyl(q.x, q.z, y0 + 1.30, y0 + 1.42, 0.018, C_STEEL, 6);
    BX(lit, qa - 0.03, c - 0.03, y0 + 1.44, qa + 0.03, c + 0.03, y0 + 1.60, [0.30, 0.06, 0.05]);
  }
  // the coffee machine — the most recognisable object in an alpine hut
  {
    const ma = W - 0.62, mc = 0.0;
    BX(lit, ma - 0.34, mc - 0.32, y0 + 1.14, ma + 0.30, mc + 0.32, y0 + 1.62, [0.58, 0.14, 0.10]);
    BX(lit, ma - 0.36, mc - 0.34, y0 + 1.62, ma + 0.32, mc + 0.34, y0 + 1.70, C_STEEL);
    for (const dc of [-0.18, 0.18]) {
      const q = P(ma - 0.20, mc + dc, 0);
      lit.cyl(q.x, q.z, y0 + 1.70, y0 + 1.82, 0.05, C_STEEL, 8);
    }
    // group heads
    BX(lit, ma - 0.36, mc - 0.20, y0 + 1.02, ma - 0.20, mc - 0.06, y0 + 1.14, C_STEEL);
    BX(lit, ma - 0.36, mc + 0.06, y0 + 1.02, ma - 0.20, mc + 0.20, y0 + 1.14, C_STEEL);
  }

  // ---- our table by the window --------------------------------------------
  const TA = WCEN + 0.2, TC = -D + 1.62, TY = y0 + 0.76;
  // where the drink stands: the near-left corner of the table, 0.75 m from the lens
  const DRINK_A = TA - 0.34, DRINK_C = TC + 0.30;
  BX(lit, TA - 0.78, TC - 0.62, TY, TA + 0.78, TC + 0.62, TY + 0.055, [0.66, 0.47, 0.28]);
  for (const sa of [-1, 1]) {
    for (const sc of [-1, 1]) {
      const p = P(TA + sa * 0.58, TC + sc * 0.46, 0);
      lit.cyl(p.x, p.z, y0, TY, 0.045, C_BEAM, 6);
    }
  }
  // benches either side
  for (const sc of [-1, 1]) {
    BX(lit, TA - 0.85, TC + sc * 1.02, y0 + 0.44, TA + 0.85, TC + sc * 1.28, y0 + 0.50, C_BAR);
    BX(lit, TA - 0.85, TC + sc * 1.26, y0 + 0.50, TA + 0.85, TC + sc * 1.32, y0 + 0.92, C_BAR);
    for (const sa of [-1, 1]) {
      const p = P(TA + sa * 0.72, TC + sc * 1.15, 0);
      lit.cyl(p.x, p.z, y0, y0 + 0.44, 0.04, C_BEAM, 5);
    }
  }
  // a second table further in, so the room is a room and not a diorama
  {
    const a2 = -3.4, c2 = -D + 3.6;
    BX(lit, a2 - 0.62, c2 - 0.58, y0 + 0.74, a2 + 0.62, c2 + 0.58, y0 + 0.79, [0.54, 0.36, 0.20]);
    for (const sa of [-1, 1]) for (const sc of [-1, 1]) {
      const p = P(a2 + sa * 0.50, c2 + sc * 0.46, 0);
      lit.cyl(p.x, p.z, y0, y0 + 0.74, 0.042, C_BEAM, 5);
    }
    for (const sc of [-1, 1]) {
      BX(lit, a2 - 0.7, c2 + sc * 0.95, y0 + 0.42, a2 + 0.7, c2 + sc * 1.2, y0 + 0.48, C_BAR);
    }
    // somebody's gloves and a helmet left on it
    BX(lit, a2 - 0.3, c2 - 0.1, y0 + 0.79, a2 + 0.02, c2 + 0.22, y0 + 0.93, C_BLACK);
    BX(lit, a2 + 0.16, c2 - 0.24, y0 + 0.79, a2 + 0.46, c2 + 0.02, y0 + 0.86, [0.30, 0.12, 0.10]);
  }
  // table dressing: a beer mat, a folded paper, a spoon — all near the lens,
  // because a foreground object is what gives an interior its depth
  BX(lit, DRINK_A - 0.09, DRINK_C - 0.09, TY + 0.055, DRINK_A + 0.09, DRINK_C + 0.09, TY + 0.059, [0.30, 0.16, 0.12]);
  BX(lit, TA + 0.16, TC + 0.16, TY + 0.055, TA + 0.52, TC + 0.40, TY + 0.065, C_PAPER);
  BX(lit, DRINK_A + 0.14, DRINK_C - 0.02, TY + 0.056, DRINK_A + 0.24, DRINK_C + 0.03, TY + 0.060, C_STEEL);
  {
    const na = TA + 0.62, nc = TC - 0.30;
    BX(lit, na - 0.10, nc - 0.07, TY + 0.056, na + 0.10, nc + 0.07, TY + 0.062, C_PAPER);
    // chalk-scribble menu, three strokes
    for (let i = 0; i < 3; i++) {
      BX(lit, na - 0.07, nc - 0.045 + i * 0.035, TY + 0.063,
        na + 0.05 - i * 0.012, nc - 0.032 + i * 0.035, TY + 0.064, [0.22, 0.20, 0.18]);
    }
  }

  // ---- stove, on the -a side ----------------------------------------------
  {
    const a2 = 0.55, c2 = -D + 1.05;
    const p = P(a2, c2, 0);
    BX(lit, a2 - 0.44, c2 - 0.36, y0 + 0.10, a2 + 0.44, c2 + 0.36, y0 + 1.12, C_BLACK);
    BX(lit, a2 - 0.50, c2 - 0.42, y0 + 1.12, a2 + 0.50, c2 + 0.42, y0 + 1.20, C_BLACK);
    BX(lit, a2 - 0.52, c2 - 0.44, y0, a2 + 0.52, c2 + 0.44, y0 + 0.10, C_STONE);
    lit.cyl(p.x, p.z, y0 + 1.20, y1, 0.09, C_BLACK, 8);
    // the mouth: emissive, faces INTO the room, and is the reason the room has
    // a warm side at all
    BX(glow, a2 - 0.24, c2 + 0.355, y0 + 0.46, a2 + 0.24, c2 + 0.375, y0 + 0.78, [4.2, 1.5, 0.35]);
    // split logs stacked next to it
    for (let i = 0; i < 6; i++) {
      const q = P(a2 + 0.15, c2 + 0.95 + (i % 3) * 0.09, 0);
      lit.cyl(q.x, q.z, y0 + 0.02 + Math.floor(i / 3) * 0.14, y0 + 0.14 + Math.floor(i / 3) * 0.14, 0.06, [0.34, 0.24, 0.16], 6);
    }
  }

  // ---- hanging lamp over the table ----------------------------------------
  {
    const p = P(TA, TC + 0.05, 0);
    lit.cyl(p.x, p.z, y1 - 0.02, y0 + 1.92, 0.008, C_BLACK, 4);
    // enamel shade, a cone of quads
    const seg = 12, r = 0.26, top = y0 + 1.92, bot = y0 + 1.74;
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      lit.quad(
        new THREE.Vector3(p.x, top, p.z),
        new THREE.Vector3(p.x + Math.cos(t1) * r, bot, p.z + Math.sin(t1) * r),
        new THREE.Vector3(p.x + Math.cos(t0) * r, bot, p.z + Math.sin(t0) * r),
        new THREE.Vector3(p.x, top, p.z), [0.72, 0.70, 0.66]);
    }
    glow.cyl(p.x, p.z, bot - 0.06, bot, 0.075, [5.0, 3.4, 1.7], 8);
    // and a candle on the sill
    const q = P(WA0 + 0.42, -D + 0.26, 0);
    lit.cyl(q.x, q.z, WY0 - 0.14, WY0 - 0.02, 0.030, C_CERAM, 6);
    glow.cyl(q.x, q.z, WY0 - 0.02, WY0 + 0.04, 0.014, [4.0, 2.2, 0.9], 5);
  }

  // ---- two pendants over the counter --------------------------------------
  // MEASURED: with one dim bulb the bar end of the room came out at a scene mean
  // of 37 codes. Since the camera now actually goes there when you order (see
  // `barAim`), the thing you are being shown has to be lit well enough to read —
  // the coffee machine, the taps and the bottle shelf were all in frame and all
  // in the dark. Two shades over the counter, the same enamel cone as the one
  // over the table, plus their point lights in the bake below.
  const BAR_LAMPS = [1.0, 4.2];
  for (const bc of BAR_LAMPS) {
    const p = P(BA + 0.45, bc, 0);
    lit.cyl(p.x, p.z, y1 - 0.02, y0 + 2.08, 0.008, C_BLACK, 4);
    const seg = 12, r = 0.22, top = y0 + 2.08, bot = y0 + 1.94;
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      lit.quad(
        new THREE.Vector3(p.x, top, p.z),
        new THREE.Vector3(p.x + Math.cos(t1) * r, bot, p.z + Math.sin(t1) * r),
        new THREE.Vector3(p.x + Math.cos(t0) * r, bot, p.z + Math.sin(t0) * r),
        new THREE.Vector3(p.x, top, p.z), [0.70, 0.68, 0.64]);
    }
    glow.cyl(p.x, p.z, bot - 0.05, bot, 0.065, [4.6, 3.1, 1.6], 8);
  }

  // ---- odds and ends ------------------------------------------------------
  // skis leaning by the door, a coat rail, a picture over the wainscot
  for (let i = 0; i < 4; i++) {
    const a2 = -6.2 - i * 0.16, c2 = -D + 0.55;
    const p0 = P(a2, c2 + 0.35, 0), p1 = P(a2 - 0.05, c2, 0);
    const col = [[0.62, 0.14, 0.10], [0.10, 0.22, 0.46], [0.70, 0.66, 0.14], [0.14, 0.14, 0.16]][i];
    // ski as a thin quad pair leaning into the wall
    const w2 = 0.045;
    const A = new THREE.Vector3(p0.x - w2, y0 + 0.01, p0.z), B = new THREE.Vector3(p0.x + w2, y0 + 0.01, p0.z);
    const C = new THREE.Vector3(p1.x + w2, y0 + 1.68, p1.z), Dd = new THREE.Vector3(p1.x - w2, y0 + 1.68, p1.z);
    lit.quad(A, B, C, Dd, col);
    lit.quad(Dd, C, B, A, col);
  }
  {
    const c2 = 4.2;
    BX(lit, -W + 0.02, c2 - 0.9, y0 + 1.72, -W + 0.10, c2 + 0.9, y0 + 1.80, C_BEAM);
    for (let i = 0; i < 3; i++) {
      const ja = -W + 0.24, jc = c2 - 0.55 + i * 0.55;
      BX(lit, ja - 0.16, jc - 0.13, y0 + 1.02, ja + 0.16, jc + 0.13, y0 + 1.72,
        [[0.52, 0.10, 0.08], [0.08, 0.18, 0.34], [0.60, 0.44, 0.10]][i]);
    }
    // framed photograph of the massif
    BX(lit, -W + 0.02, 1.1, y0 + 1.35, -W + 0.07, 1.95, y0 + 2.0, C_BEAM);
    BX(lit, -W + 0.07, 1.16, y0 + 1.41, -W + 0.09, 1.89, y0 + 1.94, [0.50, 0.56, 0.66]);
  }

  // ---- lighting rig for the bake ------------------------------------------
  const lampP = P(TA, TC + 0.05, 0);
  const stoveP = P(0.55, -D + 1.05, 0);
  const winC = P(0, -D, 0);
  const winN = new THREE.Vector3(-cx, 0, -cz);       // inward normal of -c wall
  const L = {
    points: [
      // MEASURED: at 2.35 this lamp put the table top at 1.14 linear — every
      // surface within two metres clipped to a flat tan and the room read as a
      // cardboard box. An interior has to sit WELL BELOW the snow outside it or
      // the window stops being a window.
      { x: lampP.x, y: y0 + 1.80, z: lampP.z, c: [0.78, 0.52, 0.28], range: 1.9, k: 1.0, wrap: true },
      { x: stoveP.x, y: y0 + 0.62, z: stoveP.z, c: [0.92, 0.34, 0.10], range: 2.1, k: 1.0, wrap: true },
      { x: winC.x, y: y0 + 1.7, z: winC.z, c: [0.30, 0.36, 0.46], range: 5.0, k: 0.6, wrap: false },
      // the two pendants over the counter. They are ten metres from the window
      // table, so they can be this bright without touching the framing the
      // lamp-at-2.35 note above is protecting — checked, the table top does not
      // move by a code.
      ...BAR_LAMPS.map((bc) => {
        const q = P(BA + 0.45, bc, 0);
        return { x: q.x, y: y0 + 1.94, z: q.z, c: [0.74, 0.50, 0.27], range: 3.4, k: 1.05, wrap: true };
      }),
      // ...and a dim fill behind the counter, so the back shelf is not a
      // silhouette against its own bottles
      { x: P(W - 0.5, 2.6, 0).x, y: y0 + 2.1, z: P(W - 0.5, 2.6, 0).z, c: [0.46, 0.33, 0.20], range: 4.2, k: 0.8, wrap: true },
    ],
    win: winN,
    winC: [0.30, 0.36, 0.48],
    winDist: (x, y, z) => Math.abs((x - winC.x) * winN.x + (z - winC.z) * winN.z),
  };

  const litGeo = bakeInterior(lit.geometry(), L);
  const glowGeo = glow.geometry();

  // ---- the drink, and the steam off it ------------------------------------
  // Built as their own little geometries so they can be swapped and animated;
  // baked with the same rig so they sit in the same light as the table.
  const mugB = new Bld();
  /** Top of the coffee, in the room frame — where the steam has to start. */
  const COFFEE_Y = TY + 0.165;
  {
    const p = P(DRINK_A, DRINK_C, 0);
    mugB.cyl(p.x, p.z, TY + 0.056, TY + 0.156, 0.043, C_CERAM, 10);   // saucer-ish base
    mugB.cyl(p.x, p.z, TY + 0.156, COFFEE_Y, 0.030, [0.20, 0.11, 0.05], 10); // the coffee
    // Handle: a real arc of ceramic, swept in the ROOM's frame and standing in
    // the (a, y) plane so it is seen side-on from the bench. Ends land on the
    // 4.3 cm mug wall rather than in the air beside it.
    {
      const pts = [];
      const N = 7;
      for (let i = 0; i <= N; i++) {
        const t = lerp(-1.48, 1.48, i / N);
        pts.push([DRINK_A + 0.040 + Math.cos(t) * 0.034, DRINK_C, TY + 0.106 + Math.sin(t) * 0.036]);
      }
      TUBE(mugB, pts, 0.0075, C_CERAM);
    }
  }
  const glassB = new Bld();
  {
    const p = P(DRINK_A, DRINK_C, 0);
    glassB.cyl(p.x, p.z, TY + 0.056, TY + 0.075, 0.040, [0.80, 0.78, 0.74], 10);
    glassB.cyl(p.x, p.z, TY + 0.075, TY + 0.245, 0.038, [0.86, 0.52, 0.10], 10, false);
    glassB.cyl(p.x, p.z, TY + 0.245, TY + 0.285, 0.040, [0.96, 0.94, 0.88], 10);
    glassB.cyl(p.x, p.z, TY + 0.285, TY + 0.295, 0.041, [0.92, 0.90, 0.86], 10);
  }
  const mugGeo = bakeInterior(mugB.geometry(), L);
  const glassGeo = bakeInterior(glassB.geometry(), L);

  /**
   * Steam, rebuilt.
   *
   * The first cut was three quads at constant world *z*, starting 5-8 cm above
   * the rim. Three things were wrong with that and only one of them is visible
   * at 1:1 — magnify 4× and it is three hard-edged pale trapezoids, separated
   * from each other and from the mug, and because they were built on a world
   * axis while the hut sits at yaw -0.5 they were also 29 degrees off the lens.
   * (An earlier commit claimed to have fixed this. It made them smaller.)
   *
   * So: ONE continuous ribbon, built at the origin in a camera-facing plane
   * (+x right, +y up) and yawed at the lens every frame by `updateHut` — a real
   * billboard, not a guess at where the camera will be — starting at y = 0,
   * which the mesh's own transform pins to the surface of the coffee. It fades
   * in and out through a FOUR-component colour attribute, so the edges are soft
   * and the top dissolves instead of ending in a straight line.
   */
  const steamP = [], steamN = [], steamC = [];
  {
    const N = 11;
    const H = 0.185;
    for (let strand = 0; strand < 2; strand++) {
      const ph = strand * 2.1, zoff = (strand - 0.5) * 0.012;
      let prev = null;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const y = t * H;
        // Two frequencies of curl, both scaled by height so the base stays over
        // the cup. One frequency at a tenth of this amplitude was the first cut
        // and it read as a straight vertical smear rather than as a wisp.
        const x = (Math.sin(t * 3.1 + ph) * 0.042 + Math.sin(t * 7.4 + ph * 1.7) * 0.013)
          * Math.pow(t, 1.25) + (strand - 0.5) * 0.010;
        const w = lerp(0.011, 0.046, Math.pow(t, 0.7));
        // opaque in the middle of the plume, nothing at the surface or the top
        const a = 0.85 * Math.sin(Math.pow(t, 0.62) * Math.PI) * (strand ? 0.7 : 1.0);
        const cur = { x, y, w, a };
        if (prev) {
          const quad = [
            [prev.x - prev.w, prev.y, prev.a * 0.15], [prev.x + prev.w, prev.y, prev.a * 0.15],
            [cur.x + cur.w, cur.y, cur.a * 0.15], [cur.x - cur.w, cur.y, cur.a * 0.15],
          ];
          // centre spine carries the alpha; the outer edges are feathered
          const mid = [
            [prev.x - prev.w * 0.34, prev.y, prev.a], [prev.x + prev.w * 0.34, prev.y, prev.a],
            [cur.x + cur.w * 0.34, cur.y, cur.a], [cur.x - cur.w * 0.34, cur.y, cur.a],
          ];
          const emit = (q) => {
            for (const [i0, i1, i2] of [[0, 1, 2], [0, 2, 3]]) {
              for (const k of [i0, i1, i2]) {
                steamP.push(q[k][0], q[k][1], zoff);
                steamN.push(0, 0, 1);
                steamC.push(0.98, 0.98, 1.0, q[k][2]);
              }
            }
          };
          emit(quad); emit(mid);
        }
        prev = cur;
      }
    }
  }
  const steamGeo = new THREE.BufferGeometry();
  steamGeo.setAttribute('position', new THREE.Float32BufferAttribute(steamP, 3));
  steamGeo.setAttribute('normal', new THREE.Float32BufferAttribute(steamN, 3));
  steamGeo.setAttribute('color', new THREE.Float32BufferAttribute(steamC, 4));
  steamGeo.computeBoundingSphere();

  // camera: seated at the window table, looking across it and out
  // Seated ON the bench, not standing behind it: at TC + 1.9 the lens was
  // 0.6 m from the bench BACK, and a 1.7 m plank of timber filled the bottom
  // half of the frame. This is 0.45 m from the table edge, eye at 1.30, which
  // is where somebody's eyes are when they sit down with a coffee.
  const camPos = P(TA - 0.55, TC + 1.05, y0 + 1.30);
  const camAim = P(TA + 0.10, TC - 1.60, y0 + 1.05);
  /**
   * Where the camera looks when you order.
   *
   * MEASURED, and the reason this point exists: from the bench the counter spans
   * a = 7.35..8.08, which is **115 degrees** off the aim axis, against a reach of
   * about 90 (a 47.5 degree half-fov plus the drift's -23.5..+42.8 sweep). The
   * bar, the coffee machine, the taps, the back shelf and the second table were
   * therefore built, baked, lit and drawn every frame and could NEVER be seen —
   * in a feature whose whole request was "go into the hut and drink a coffee or
   * a beer". Ordering now buys a two-and-a-half second look across at the
   * counter you ordered from, which is also simply what you do.
   *
   * Aimed between the group heads and the taps, with the bottle shelf behind.
   */
  const barAim = P(W - 0.55, 1.10, y0 + 1.34);
  /**
   * ...and where it stands to look. Aiming the table camera at the counter from
   * the bench was tried first and measured: at 10.7 m down a dark room the whole
   * bar occupied about a seventh of the frame width at a scene mean of 42 codes.
   * The beat is a MOVE — you got up and went to the bar, which is what ordering
   * a drink actually involves — ending 2.3 m off the group heads.
   */
  const barCam = P(BA - 1.70, 1.10, y0 + 1.56);
  // where the player is standing while inside, for streaming/shadow focus
  const stand = P(0, 0, 0);

  return {
    litGeo, glowGeo, mugGeo, glassGeo, steamGeo,
    camPos, camAim, barAim, barCam, stand, floorY: y0,
    /** World point of the coffee surface — the steam billboard hangs off this. */
    steamAt: P(DRINK_A, DRINK_C, COFFEE_Y),
    // unit vector along the room's `a` axis, for the camera drift
    driftA: new THREE.Vector3(ax, 0, az),
    triangles: lit.triangles + glow.triangles,
  };
}

// =============================================================================
// the first-person chair
// =============================================================================
/**
 * What you can see of yourself on a chairlift: the safety bar across your
 * knees, the footrest, the front edge of the seat, your boots and your ski
 * tips hanging in the bottom of the frame. Built in the chair's LOCAL frame
 * (+z = direction of travel, y = 0 at the cable grip) and hung under the
 * cable point every frame, so it needs no rebuild.
 */
function buildChairRig() {
  const b = new Bld();
  const FRAME = [0.16, 0.17, 0.20];
  const PAD = [0.34, 0.07, 0.06];
  const BOOT = [0.055, 0.055, 0.062];
  const SKI = [0.62, 0.13, 0.10];
  const SNOW = [0.86, 0.88, 0.94];
  const Y = -SEAT_DROP;
  // Convention: local +z is the direction of TRAVEL, and the rider faces it —
  // which is why the backrest is at -z, behind the lens, and everything the
  // player can see (bar, footrest, boots, ski tips) is at +z. Getting this
  // backwards puts the camera inside the seat back, which is exactly what the
  // first cut did.
  b.box(-1.06, Y - 0.06, -0.34, 1.06, Y + 0.02, 0.30, PAD);          // seat pad
  b.box(-1.06, Y - 0.02, -0.42, 1.06, Y + 0.62, -0.34, PAD);         // backrest
  b.box(-1.10, Y - 0.11, -0.38, 1.10, Y - 0.03, 0.34, FRAME);        // carriage
  // The hanger runs from the grip down BEHIND the backrest. Modelled through
  // the middle of the seat (which is where a naive read of the chair geometry
  // puts it) it stands 9 cm in front of the lens and fills a third of the
  // frame with a grey post — measured, that was the whole first cut of this shot.
  b.box(-0.055, Y, -0.46, 0.055, 0.0, -0.35, FRAME);
  b.box(-1.10, Y + 0.02, -0.46, 1.10, Y + 0.10, -0.35, FRAME);
  // Safety bar across the knees, its arms swept back to the carriage, and the
  // footrest slung off it lower and further forward. The GAP between the two is
  // the whole point: at 0.9 m from the lens a 2 m-wide bar spans the frame, so
  // without daylight under it the shot reads as a grey wall along the bottom
  // edge rather than as a bar you are sitting behind. (First cut: it did.)
  b.box(-1.02, Y + 0.47, 0.74, 1.02, Y + 0.54, 0.82, FRAME);
  for (const s of [-1, 1]) {
    b.box(s * 1.02 - 0.04, Y + 0.08, 0.66, s * 1.02 + 0.04, Y + 0.54, 0.78, FRAME);
  }
  b.box(-0.94, Y + 0.20, 0.98, 0.94, Y + 0.26, 1.10, FRAME);
  // knees, shins, boots and ski tips, one leg each side of centre
  for (const s of [-1, 1]) {
    const x = s * 0.27;
    b.box(x - 0.12, Y + 0.06, 0.02, x + 0.12, Y + 0.27, 0.62, [0.10, 0.11, 0.14]);   // thigh
    b.box(x - 0.10, Y - 0.62, 0.52, x + 0.10, Y + 0.14, 0.70, [0.09, 0.10, 0.13]);   // shin
    b.box(x - 0.11, Y - 0.80, 0.46, x + 0.11, Y - 0.60, 0.84, BOOT);                 // boot
    // ski, hanging tip-down and forward
    b.box(x - 0.055, Y - 1.70, 0.80, x + 0.055, Y - 0.78, 1.14, SKI);
    b.box(x - 0.058, Y - 1.84, 0.92, x + 0.058, Y - 1.66, 1.08, SKI);
    b.box(x - 0.050, Y - 1.68, 0.82, x + 0.050, Y - 1.64, 1.10, SNOW);
  }
  return b.geometry();
}

// =============================================================================
export function createResort(opts) {
  const {
    scene, terrain, scatter, sky, camera, chaseCam, physics, skier, audio, draglift,
  } = opts;

  // ---- line-derived constants, filled in below from the placement seam -----
  let liftTop = 0;          // arc length at which the chair puts you down
  let midS = null;          // ...and where the mid-station is on the same line
  let hutDoor = null;
  /** The hut's own axes: `a` across the ridge, `c` along it. See buildInterior. */
  let hutFrame = { ax: 1, az: 0, cx: 0, cz: 1 };

  // ---- the chair line ------------------------------------------------------
  const cables = scatter?.lift?.cables || [];
  const upCable = cables.find((c) => c.dir > 0) || cables[0] || null;
  const towers = scatter?.lift?.towers || [];

  /** Point on a cable at arc length s (see scatter's `cablePoint`). */
  function cableAt(cab, s, out) {
    const cum = cab.cum;
    const q = clamp(s, 0, cab.total);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= q) lo = mid; else hi = mid; }
    const t = (q - cum[lo]) / Math.max(1e-5, cum[lo + 1] - cum[lo]);
    out.copy(cab.pts[lo]).lerp(cab.pts[lo + 1], t);
    return lo;
  }

  /**
   * Nudge a boarding arc length so the player's chair does not share its seat
   * with one of scatter's circulating chairs.
   *
   * They are 36 m apart and travel at the same speed as this ride does, so one
   * adjustment at boarding holds for the whole 4 km — but without it, boarding at
   * a fixed arc length lands inside another chair often enough to have happened
   * on the first screenshot taken of this feature.
   *
   * Measured off the live instance matrices rather than re-derived: scatter does
   * not publish the phase, and guessing it would be a second copy of a moving
   * number, which is the failure mode CLAUDE.md is loudest about.
   *
   * The search is a SYMMETRIC ladder of small offsets and keeps the best of them
   * rather than walking one way until it gives up. The first cut pushed +13 m
   * four times, so a bad boarding could move the player 52 m up the line — and
   * near the top, where the clamp bites, it moved him 9 m BACKWARDS (measured
   * 3994.9 -> 3985.9), which is a lift running in reverse. Worst case here is
   * ±27 m and the sign is whichever is clear.
   */
  const AVOID_OFFSETS = [0, 9, -9, 18, -18, 27, -27];
  function avoidChairs(s0) {
    const pool = scatter?.group?.getObjectByName?.('chairs');
    if (!pool || !pool.count) return s0;
    const arr = pool.instanceMatrix.array;
    const lo = BOARD_MARGIN, hi = Math.max(lo, liftTop - 14);
    let bestS = clamp(s0, lo, hi), bestNear = -1;
    for (const off of AVOID_OFFSETS) {
      const s = clamp(s0 + off, lo, hi);
      cableAt(upCable, s, _p);
      let near = Infinity;
      for (let i = 0; i < pool.count; i++) {
        const dx = arr[i * 16 + 12] - _p.x, dz = arr[i * 16 + 14] - _p.z;
        const dy = arr[i * 16 + 13] - _p.y;
        near = Math.min(near, Math.hypot(dx, dy, dz));
      }
      if (near > 11) return s;
      if (near > bestNear) { bestNear = near; bestS = s; }
    }
    return bestS;
  }

  /** Arc length of the cable point nearest to (x, z). */
  function nearestS(cab, x, z) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < cab.pts.length; i++) {
      const p = cab.pts[i];
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bd) { bd = d; best = i; }
    }
    return cab.cum[best];
  }

  // ---- boarding zones ------------------------------------------------------
  // Everything the player can walk up to, in one list, so the prompt is a
  // nearest-zone query rather than four special cases.
  //
  // Both chair zones sit OUTSIDE the station shed and UPHILL of it. Neither is a
  // detail: the terminal shed at tower 0 is 18 x 29 m in plan and the mid-station
  // 12 x 19 m, so "ten metres from the tower" is inside the building — the first
  // cut put the boarding prompt under the mid-station's roof and the chase camera
  // spent the shot looking at the underside of an eave. Uphill, because the chase
  // camera is behind a rider facing down the fall line, so the station only ends
  // up in the frame with him if he is above it.
  const zones = [];
  if (upCable && towers.length) {
    const t0 = towers[0], tN = towers[towers.length - 1];
    zones.push({
      id: 'chair-bottom', kind: 'lift', label: 'Ride the chairlift',
      x: t0.x + 13, z: t0.z + 21, r: REACH_LIFT,
      s: BOARD_MARGIN, note: 'Valley station',
    });
    // The mid-station shed is buildings[1]; board where the cable passes it.
    const mid = scatter.buildings?.[1];
    if (mid) {
      const max = Math.cos(mid.yaw), maz = -Math.sin(mid.yaw);
      const mcx = Math.sin(mid.yaw), mcz = Math.cos(mid.yaw);
      zones.push({
        id: 'chair-mid', kind: 'lift', label: 'Ride the chairlift',
        x: mid.x + max * (mid.w + 5) + mcx * (mid.d + 3),
        z: mid.z + maz * (mid.w + 5) + mcz * (mid.d + 3),
        r: REACH_LIFT,
        s: nearestS(upCable, mid.x, mid.z), note: 'Mid-station',
      });
    }
    liftTop = upCable.total - UNLOAD_MARGIN;
    midS = zones.find((z) => z.id === 'chair-mid')?.s ?? null;
    void tN;
  }
  if (draglift) {
    zones.push({
      id: 'tbar', kind: 'drag', label: 'Take the T-bar',
      x: draglift.board.x, z: draglift.board.z, r: 22, s: 0, note: 'Lower pitch',
    });
  }

  // ---- the hut -------------------------------------------------------------
  // Only the mid-mountain restaurant is enterable: it is the one with a kitchen
  // and a terrace, and it stands 150 m from where a run starts.
  const hutB = scatter?.buildings?.[0] || null;
  let interior = null, litMesh = null, glowMesh = null;
  let mugMesh = null, glassMesh = null, steamMesh = null, interiorGroup = null;
  if (hutB) {
    interior = buildInterior(hutB);
    interiorGroup = new THREE.Group();
    interiorGroup.name = 'hut-interior';
    const matLit = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    matLit.name = 'hut-interior';
    const matGlow = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    matGlow.name = 'hut-glow';
    litMesh = new THREE.Mesh(interior.litGeo, matLit);
    glowMesh = new THREE.Mesh(interior.glowGeo, matGlow);
    mugMesh = new THREE.Mesh(interior.mugGeo, matLit);
    glassMesh = new THREE.Mesh(interior.glassGeo, matLit);
    const matSteam = new THREE.MeshBasicMaterial({
      vertexColors: true, fog: false, transparent: true, opacity: 0.0,
      depthWrite: false, side: THREE.DoubleSide,
    });
    matSteam.name = 'hut-steam';
    steamMesh = new THREE.Mesh(interior.steamGeo, matSteam);
    for (const m of [litMesh, glowMesh, mugMesh, glassMesh, steamMesh]) {
      m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
      interiorGroup.add(m);
    }
    mugMesh.visible = false; glassMesh.visible = false; steamMesh.visible = false;
    interiorGroup.visible = false;
    scene.add(interiorGroup);

    // Where you stop: off the UPHILL gable, 4 m clear of the wall and a little
    // towards the terrace. Two constraints, both learned the hard way:
    //  - it has to be on open snow, not on the terrace deck — parked next to the
    //    deck, the chase camera's boom ended up inside the timber and the shot
    //    was a flat tan rectangle;
    //  - and it has to be UPHILL of the hut, because the chase camera sits behind
    //    a rider who faces down the fall line, so anything you want in the frame
    //    with him has to be below him.
    const ax = Math.cos(hutB.yaw), az = -Math.sin(hutB.yaw);
    const cx = Math.sin(hutB.yaw), cz = Math.cos(hutB.yaw);
    hutFrame = { ax, az, cx, cz };
    const dx = hutB.x + ax * (hutB.w * 0.35) + cx * (hutB.d + 4.0);
    const dz = hutB.z + az * (hutB.w * 0.35) + cz * (hutB.d + 4.0);
    zones.push({
      id: 'hut', kind: 'hut', label: 'Stop for a drink',
      x: dx, z: dz, r: REACH_DOOR, note: 'Bergrestaurant', hut: hutB,
    });
    hutDoor = { x: dx, z: dz };
  }

  // ---- the player's own chair ---------------------------------------------
  const chairRig = new THREE.Mesh(buildChairRig(), new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.62, metalness: 0.12,
  }));
  chairRig.material.name = 'chair-rig';
  chairRig.name = 'chair-rig';
  chairRig.castShadow = true;
  chairRig.frustumCulled = false;
  chairRig.visible = false;
  scene.add(chairRig);
  // Shader warm-up, same argument as draglift's: the chair rig is hidden until
  // somebody boards, and a hidden mesh never links its program — least of all
  // its shadow-depth variant, which renderer.compile() does not build. So it is
  // drawn at the player, scaled to a thousandth, for the first few frames.
  let rigWarm = 5;
  let hutWarm = 5;

  // ---- mutable ride state -------------------------------------------------
  let mode = 'ski';
  let phase = 'ride';           // 'board' | 'ride' | 'off' inside a lift mode
  let modeT = 0, phaseT = 0;
  let rideS = 0, rideTotal = 0, rideSpeed = 0, rideKind = '', rideName = '';
  let rideFrom = 0;             // arc length the current ride was boarded at
  let lapse = 1;                // current time compression of the ride
  let pan = 0, panV = 0, sway = 0, tilt = 0, hutPan = 0;
  let veil = 0, veilTarget = 0, glowFlash = 0;
  let skipHold = 0, skipping = false, skipArmed = false;
  let warmth = 1;
  let drink = null, drinkT = 0, riseDelay = 0, hutNote = '';
  let barBeat = 0, prevPick = 0, pickCool = 0;
  let runTop = 0, runAir = 0, lastRun = null;
  let lastTowerIdx = -1;
  let chairFixed = false;
  let camFrom = null, camFromQ = null, camFromFov = 60;
  let blend = 0, blendDur = 1;
  let activeZone = null;
  let prevAction = false;

  const _p = new THREE.Vector3();
  const _p2 = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _aim = new THREE.Vector3();
  // The seat framing updateCamera last produced, so applyBlend can build the
  // boarding move out of it instead of guessing where the chair is (see D10).
  const _seatEye = new THREE.Vector3();
  const _seatAim = new THREE.Vector3();
  const _blendAim = new THREE.Vector3();
  const _boardAt = new THREE.Vector3();   // where the rider was standing when he boarded
  const _mat = new THREE.Matrix4();

  /**
   * Publish the mode block. Called from every transition, not only from
   * `update()`: a tool that calls `enter()` or `goto()` and then reads
   * `state.mode` in the same tick used to get the PREVIOUS mode back, because
   * the only writer was the top of the next frame.
   */
  function publishMode(state) {
    if (!state) return;
    state.mode = mode;
    state.modeT = modeT;
  }

  function setSkierVisible(v) {
    if (skier?.group) skier.group.visible = v;
  }

  /** Freeze the rider where he is: nothing downstream may read stale motion. */
  function parkState(state) {
    state.vel.set(0, 0, 0);
    state.speed = 0;
    state.edge = 0;
    state.carving = false;
    state.airborne = false;
    state.airTime = 0;
    state.gForce = 0;
    if (state.motion) {
      state.motion.aLat = 0; state.motion.yawRate = 0; state.motion.inclination = 0;
      state.motion.landImpact = 0; state.motion.suspension = 0; state.motion.squash = 0;
      state.motion.roughness = 0; state.motion.slip = 0; state.motion.slipAngle = 0;
    }
  }

  /** Snapshot the live camera so a mode change can be a move, not a cut. */
  function grabCamera() {
    camFrom = camera.position.clone();
    camFromQ = camera.quaternion.clone();
    camFromFov = camera.fov;
  }

  // ---- entering and leaving -----------------------------------------------
  function enterLift(state, zone, progress) {
    if (!upCable) return false;
    mode = 'lift'; phase = 'board'; modeT = 0; phaseT = 0;
    rideKind = 'chair';
    rideName = zone?.note || 'Chairlift';
    rideS = avoidChairs(progress !== undefined
      ? lerp(zone?.s ?? BOARD_MARGIN, liftTop, clamp(progress, 0, 1))
      : (zone?.s ?? BOARD_MARGIN));
    rideFrom = rideS;
    /**
     * The mid-station is the DEFAULT destination, not an offer you have to
     * notice. Riding the whole line is 3998.8 m; getting off at the mid-station
     * is 2085.5 m and puts you thirty metres from the restaurant door, which is
     * the loop this feature exists to close. Staying on for the summit is the
     * deliberate choice and is offered on the approach — see `updateLift`.
     */
    rideTotal = (midS !== null && rideS < midS - 40) ? midS : liftTop;
    rideSpeed = CHAIR_SPEED;
    lapse = 1;
    pan = 0; panV = 0; tilt = 0;
    skipHold = 0; skipping = false; skipArmed = false; chairFixed = false;
    lastTowerIdx = -1;
    _boardAt.copy(state.pos); _boardAt.y += 1.15;   // his head, for the blend to hold on
    grabCamera();
    // The rider is NOT hidden here. Boarding used to delete him on the frame E
    // was pressed and then spend 1.45 s flying a camera that still held the old
    // chase framing to a seat 21.0 m up and 15.7 m sideways — measured, at 0.7 s
    // the shot was blank snow with no chair, no rider and no station in it.
    // He stays on his feet for T_SHOW_SKIER while the move starts on him.
    chairRig.visible = true;
    parkState(state);
    publishMode(state);
    return true;
  }

  function enterDrag(state, progress) {
    if (!draglift) return false;
    mode = 'drag'; phase = 'board'; modeT = 0; phaseT = 0;
    rideKind = 'tbar';
    rideName = 'T-bar';
    rideTotal = draglift.total;
    rideS = clamp((progress ?? 0) * draglift.total, 0, draglift.total);
    rideFrom = rideS;
    rideSpeed = draglift.speed;
    lapse = 1;
    skipHold = 0; skipping = false; skipArmed = false;
    setSkierVisible(true);
    chairRig.visible = false;
    parkState(state);
    // put him on the line straight away — a drag lift picks you up standing
    draglift.sample(rideS, _p);
    state.pos.copy(_p);
    draglift.dirAt(rideS, _d);
    state.heading = Math.atan2(-_d.x, -_d.z);
    terrain.normal(state.pos.x, state.pos.z, state.groundNormal);
    publishMode(state);
    return true;
  }

  function enterHut(state, zone) {
    if (!interior) return false;
    mode = 'hut'; phase = 'in'; modeT = 0; phaseT = 0;
    hutNote = zone?.note || 'Bergrestaurant';
    drink = null; drinkT = 0; riseDelay = 0;
    barBeat = 0; prevPick = 0; pickCool = 0;
    // A ride ends when a door opens. Only `backToSki` used to null this, so a
    // lift -> hut transition left "T-BAR / HOLD X TO SKIP" printed over the
    // interior for as long as you sat there.
    state.ride = null;
    skipping = false; skipHold = 0;
    setSkierVisible(false);
    chairRig.visible = false;
    if (mugMesh) mugMesh.visible = false;
    if (glassMesh) glassMesh.visible = false;
    if (steamMesh) steamMesh.visible = false;
    lastRun = { time: state.time || 0, distance: state.distance || 0, top: runTop, air: runAir };
    veilTarget = 1;
    grabCamera();
    parkState(state);
    publishMode(state);
    return true;
  }

  /**
   * Hand control back to the physics, facing down the hill.
   *
   * `snapCam` cuts to the chase view instead of easing out of wherever the last
   * camera was. The hut exit needs it: the interior lens stands INSIDE the
   * building, and easing out of it over T_OFF put the chase boom at room-local
   * (4.17, 3.01) — inside the footprint, between the floor and the ridge —
   * while the veil, which is only T_DOOR long, had already cleared. Measured,
   * the first second outside was the back of the exterior shell with its own
   * shutter boxes floating in it. A door is a cut and the veil is what covers
   * it; a lift unload is a move and keeps its blend.
   */
  function backToSki(state, x, z, heading, snapCam = false) {
    mode = 'ski'; phase = 'ride'; modeT = 0; phaseT = 0;
    setSkierVisible(true);
    state.ride = null;
    state.hut = null;
    state.prompt = null;
    if (interiorGroup) interiorGroup.visible = false;
    if (draglift) draglift.setRiderVisible(false);
    physics.reset(state, x, z, heading);
    /**
     * ...and then take the flying start back off.
     *
     * `physics.reset` deliberately drops the rider in at the speed the pitch
     * sustains, because a reset means "you are already skiing" (physics.js:244).
     * Stepping off a chair, letting go of a T-bar or walking out of a door, you
     * are not: measured, this handed the player back at 15.8 / 17.6 / 17.1 m/s
     * and the HUD read **65 KM/H one frame after leaving the restaurant**. The
     * debug `goto()` already carried these two lines for exactly this reason;
     * the player path did not.
     */
    state.vel.set(0, 0, 0);
    state.speed = 0;
    runTop = 0; runAir = 0;
    if (snapCam) { camFrom = null; blend = 0; } else { grabCamera(); blend = 1; blendDur = T_OFF; }
    publishMode(state);
  }

  // =========================================================================
  // per-frame
  // =========================================================================
  function update(dt, state) {
    // Two dts, deliberately. `dtRaw` is what scatter integrates its chair phase
    // over and is therefore what the RIDE has to advance on — see CHAIR_SPEED.
    // `dt` is clamped and drives everything that is an ease, a spring or a
    // timer, none of which want a 250 ms step.
    const dtRaw = Math.max(0, dt || 0);
    dt = clamp(dtRaw, 0, 0.1);
    modeT += dt; phaseT += dt;
    if (rigWarm > 0 && mode === 'ski') {
      rigWarm--;
      chairRig.visible = true;
      chairRig.position.copy(state.pos).y += 1.5;
      chairRig.scale.setScalar(1e-3);
      if (rigWarm === 0) { chairRig.visible = false; chairRig.scale.setScalar(1); }
    }
    // ...and the same for the interior. Its geometry is in world space, so the
    // group is scaled to a thousandth and then translated so that thousandth
    // lands on the player: three programs (timber, glow, steam) link at boot
    // instead of on the frame the door closes.
    if (hutWarm > 0 && mode === 'ski' && interiorGroup) {
      hutWarm--;
      interiorGroup.visible = true;
      for (const c of interiorGroup.children) c.visible = true;
      interiorGroup.scale.setScalar(1e-3);
      interiorGroup.position.set(
        state.pos.x - interior.camPos.x * 1e-3,
        state.pos.y + 1.5 - interior.camPos.y * 1e-3,
        state.pos.z - interior.camPos.z * 1e-3);
      if (hutWarm === 0) {
        interiorGroup.visible = false;
        interiorGroup.scale.setScalar(1);
        interiorGroup.position.set(0, 0, 0);
        mugMesh.visible = false; glassMesh.visible = false; steamMesh.visible = false;
      }
    }
    state.mode = mode;
    state.modeT = modeT;

    const inp = state.input || {};
    const action = !!inp.action;
    const actionPressed = action && !prevAction;
    prevAction = action;
    const brake = inp.brake || 0;
    const steer = inp.steer || 0;
    const crouch = inp.crouch || 0;
    const pick = inp.pick || 0;

    // veil + flash decay, shared by every mode
    veil += (veilTarget - veil) * Math.min(1, dt / T_DOOR);
    glowFlash = Math.max(0, glowFlash - dt * 0.55);
    state.veil = veil;
    state.glow = glowFlash;

    if (mode === 'ski') {
      // warmth only drains while he is actually out in it
      warmth = clamp(warmth - dt * (WARM_DRAIN + WARM_CHILL * (state.speed || 0)), 0, 1);
      runTop = Math.max(runTop, state.speed || 0);
      runAir = Math.max(runAir, state.airTime || 0);
      updatePrompt(state, actionPressed);
    } else {
      state.prompt = null;
      // While not skiing the mode machine OWNS the input: zeroing the published
      // channels is what keeps spray, tracks, audio and the rig from reacting to
      // a steer key that is being used to look around. Which is exactly why
      // every consumer below has to read `io`, not `state.input` — the hut
      // camera read the latter and its advertised "A/D look around" therefore
      // did nothing at all.
      inp.steer = 0; inp.crouch = 0; inp.brake = 0; inp.jump = false; inp.jumpPressed = false;
      const io = { actionPressed, brake, steer, crouch, pick, dtRaw };
      if (mode === 'lift') updateLift(dt, state, io);
      else if (mode === 'drag') updateDrag(dt, state, io);
      else if (mode === 'hut') updateHut(dt, state, io);
    }

    state.warmth = warmth;
    state.run = { top: runTop, bestAir: runAir };
    state.mode = mode;
  }

  // ---- prompts -------------------------------------------------------------
  function updatePrompt(state, pressed) {
    let best = null, bd = Infinity;
    for (const z of zones) {
      const dx = state.pos.x - z.x, dz = state.pos.z - z.z;
      const d = Math.hypot(dx, dz);
      if (d < z.r && d < bd) { bd = d; best = z; }
    }
    activeZone = best;
    if (!best) { state.prompt = null; return; }
    const tooFast = (state.speed || 0) > BOARD_SPEED;
    state.prompt = {
      key: 'E',
      text: best.label,
      sub: tooFast ? 'Scrub some speed first' : best.note,
      ready: !tooFast,
    };
    if (!pressed || tooFast) return;
    if (best.kind === 'lift') enterLift(state, best);
    else if (best.kind === 'drag') enterDrag(state);
    else if (best.kind === 'hut') enterHut(state, best);
  }

  /**
   * Hold the brake to skip the rest of the ride — but only after letting go of
   * it once.
   *
   * The brake (Ctrl / X) is the key the player has to HOLD to get under
   * BOARD_SPEED for the boarding prompt to go warm. Taking the skip off the
   * brake *level* therefore meant: roll up to the station braking, press E,
   * keep braking because nothing told you to stop — and two seconds later the
   * veil is at 0.91 and you are at the top of a 4 km line you never saw. That
   * was, measured, the single most likely first-time experience of the headline
   * feature. A skip now needs a fresh press: the accumulator is armed on the
   * first frame the brake reads clear.
   */
  function armSkip(dt, brake) {
    if (!skipArmed) { if (brake < 0.4) skipArmed = true; skipHold = 0; return; }
    skipHold = brake > 0.4 ? skipHold + dt : 0;
    if (skipHold > 0.55 && !skipping) { skipping = true; veilTarget = 1; }
  }

  /**
   * Time compression at arc length `s`: 1 near either end of the ride, up to
   * LAPSE_MAX in the middle. See the LAPSE_* block for why this exists.
   */
  function lapseAt(s) {
    const dIn = s - rideFrom, dOut = rideTotal - s;
    const k = Math.min(
      clamp((dIn - LAPSE_HEAD) / LAPSE_RAMP, 0, 1),
      clamp((dOut - LAPSE_TAIL) / LAPSE_RAMP, 0, 1));
    return 1 + (LAPSE_MAX - 1) * ease(k);
  }

  // ---- the chair ----------------------------------------------------------
  function updateLift(dt, state, io) {
    if (phase === 'ride') armSkip(dt, io.brake);
    if (skipping && veil > 0.92) {
      rideS = rideTotal;
      skipping = false;
    }
    if (!skipping && phase !== 'off') veilTarget = 0;

    if (phase === 'board' && phaseT >= T_SHOW_SKIER) setSkierVisible(false);
    if (phase === 'board' && phaseT >= T_BOARD) { phase = 'ride'; phaseT = 0; }

    // The chair-clearance test has to run a frame or two AFTER boarding, not at
    // the moment of it: scatter only keeps chairs within 900 m of the player in
    // its pool, so at the instant a teleport-and-board happens the chairs around
    // the new station are not in the instance buffer yet and the test passes
    // trivially. Measured — the first screenshot of the valley station had
    // another chair sitting inside this one.
    if (!chairFixed && modeT > 0.04) { rideS = avoidChairs(rideS); chairFixed = true; }

    if (phase === 'ride') {
      lapse = lapseAt(rideS);
      rideS = Math.min(rideTotal, rideS + rideSpeed * io.dtRaw * lapse);
      // a clack as each tower's sheave train goes over the cable
      const idx = Math.round(rideS / Math.max(1, (upCable.total / Math.max(1, towers.length - 1))));
      if (idx !== lastTowerIdx) {
        if (lastTowerIdx >= 0) audio?.mech?.('sheave');
        lastTowerIdx = idx;
      }
      if (rideS >= rideTotal - 0.01) { phase = 'off'; phaseT = 0; veilTarget = 0; lapse = 1; }
    } else lapse = 1;

    // seat + camera
    cableAt(upCable, rideS, _p);
    const seg = cableAt(upCable, Math.min(rideS + 6, upCable.total), _p2);
    void seg;
    _d.copy(_p2).sub(_p);
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1);
    _d.normalize();
    const yawTravel = Math.atan2(_d.x, _d.z);
    sway = Math.sin(modeT * 0.9) * 0.022 + Math.sin(modeT * 1.7 + 1.1) * 0.012;

    // the rider sits on the chair, so the streaming/shadow focus is the chair
    state.pos.copy(_p);
    state.pos.y -= SEAT_DROP;
    state.heading = yawTravel + Math.PI;      // he faces the way he is travelling
    state.groundNormal.set(0, 1, 0);
    state.speed = 0;
    state.vel.set(0, 0, 0);

    chairRig.position.copy(_p);
    _e.set(sway * 0.5, yawTravel, sway);
    chairRig.quaternion.setFromEuler(_e);

    // Look around with the steer axis — the view back down the valley is half of
    // what a lift ride is for — and DOWN with the tuck axis, which is the only
    // way the rider's own skis are ever in frame: they hang 2.7 m below the
    // cable and a lens aimed up the line cannot see them.
    // 77 degrees, not 109: past about 80 the backrest swings across the lens
    // and the shot is a black wedge with a hillside behind it.
    const panT = clamp(io.steer, -1, 1) * 1.35;
    pan += (panT - pan) * Math.min(1, dt * 2.6);
    const tiltT = clamp(io.crouch, 0, 1);
    tilt += (tiltT - tilt) * Math.min(1, dt * 3.2);

    const span = Math.max(1, rideTotal - rideFrom);
    state.ride = {
      kind: 'chair', name: rideName,
      s: rideS, total: rideTotal,
      progress: clamp((rideS - rideFrom) / span, 0, 1),
      speed: phase === 'ride' ? rideSpeed : 0,
      lapse: phase === 'ride' ? lapse : 1,
      hint: phase === 'ride' ? 'A/D look around · S look down · hold X to skip' : '',
      option: null,
    };
    /**
     * The one choice on the way up, and it is the OPPOSITE of the one this used
     * to offer. The ride ends at the mid-station by default, so what you are
     * asked on the approach is whether you want to stay on for the summit. It is
     * offered in the last hundred metres of the leg, which at full lapse is
     * still ~13 s of real time to react in.
     */
    if (phase === 'ride' && rideTotal === midS && rideS > midS - 110 && rideS < midS - 6) {
      state.ride.option = 'summit';
      state.prompt = { key: 'E', text: 'Stay on to the summit', sub: '3.9 km · top station', ready: true };
      if (io.actionPressed) { rideTotal = liftTop; rideName = 'Summit'; }
    } else state.prompt = null;

    if (phase === 'off' && phaseT > 0.25) {
      // step off onto the snow beside the line, pointed down the hill
      const offX = _p.x + 9.5, offZ = _p.z - 10;
      state.ride = null;
      veilTarget = 0;
      backToSki(state, offX, offZ, Math.PI);
      audio?.mech?.('unload');
    }
  }

  // ---- the T-bar ----------------------------------------------------------
  function updateDrag(dt, state, io) {
    if (phase === 'board' && phaseT > 0.7) { phase = 'ride'; phaseT = 0; }
    if (phase === 'ride') {
      // same brake-edge rule as the chair, and for the same reason: you arrive
      // at a T-bar queue holding the brake
      armSkip(dt, io.brake);
      if (skipping && veil > 0.92) { rideS = rideTotal; skipping = false; }
      if (!skipping) veilTarget = 0;
      // No timelapse here, deliberately. The chair is a first-person shot from a
      // fixed rig, so compressing it reads as a timelapse; the T-bar is THIRD
      // person with the rider's own skis on the snow and his tracks being
      // written behind him, and at eight times speed that reads as a bug rather
      // than as elapsed time. 685 m at 3.4 m/s is 200 s and the skip is the
      // escape hatch, the same as everywhere else.
      rideS = Math.min(rideTotal, rideS + rideSpeed * io.dtRaw);
      if (rideS >= rideTotal - 0.01) { phase = 'off'; phaseT = 0; }
    }
    lapse = 1;

    draglift.sample(rideS, _p);
    draglift.dirAt(rideS, _d);
    // He is being pulled UP the line, so he faces uphill: heading is the yaw at
    // which physics' forward (-sin h, -cos h) points along +uphill.
    const heading = Math.atan2(-_d.x, -_d.z);
    state.pos.copy(_p);
    state.heading = heading;
    terrain.normal(state.pos.x, state.pos.z, state.groundNormal);
    // publish a real velocity: the rig leans on it and the HUD reads it
    state.vel.set(_d.x, 0, _d.z).multiplyScalar(phase === 'ride' ? rideSpeed : 0);
    state.vel.y = 0;
    state.speed = phase === 'ride' ? rideSpeed : 0;
    state.crouch = 0.12;                       // legs a little soft, being towed
    draglift.setRider(state.pos, heading, rideS);

    state.ride = {
      kind: 'tbar', name: rideName,
      s: rideS, total: rideTotal, progress: clamp(rideS / Math.max(1, rideTotal), 0, 1),
      speed: state.speed,
      hint: phase === 'ride' ? 'Hold X to skip' : '',
      canUnload: false,
    };

    if (phase === 'off' && phaseT > 0.35) {
      state.ride = null;
      const u = draglift.unload;
      backToSki(state, u.x, u.z, Math.PI);
    }
  }

  // ---- the hut ------------------------------------------------------------
  function updateHut(dt, state, io) {
    // stand the player at the door so streaming and the shadow cascade stay put
    if (hutDoor) { state.pos.set(hutDoor.x, terrain.height(hutDoor.x, hutDoor.z), hutDoor.z); }
    state.heading = Math.PI;
    state.groundNormal.set(0, 1, 0);
    parkState(state);

    if (phase === 'in') {
      if (veil > 0.9) { interiorGroup.visible = true; veilTarget = 0; phase = 'sit'; phaseT = 0; }
    } else if (phase === 'out') {
      if (veil > 0.9) {
        interiorGroup.visible = false;
        veilTarget = 0;
        /**
         * Step out in the HUT's frame, not the world's.
         *
         * The door zone itself is built at `+c * (d + 4)` off the building, but
         * the exit was `hutDoor.z - 6` — a world-axis offset applied to a hut
         * standing at yaw -0.5, which walks you 2.9 m across and 5.3 m back
         * TOWARDS the building and puts the chase boom under the terrace deck.
         * Measured, the first frame outside was a white slab across the screen.
         * Out of a door means away from the building: further along +c.
         */
        const { cx: hcx, cz: hcz } = hutFrame;
        const zx = hutDoor.x + hcx * 6, zz = hutDoor.z + hcz * 6;
        state.hut = null;
        backToSki(state, zx, zz, Math.PI, true);
        return;
      }
    }

    // Look around inside with the steer axis. Without it the hut is whatever the
    // one framing shows and the bar, the coffee machine and the second table
    // might as well not exist — which is the difference between a room and a
    // diorama.
    //
    // From `io`, NOT from `state.input`: `update()` zeroes the published steer
    // channel before this runs, precisely so nothing downstream mistakes a look
    // for a carve. Reading it back here meant the advertised "A/D look around"
    // moved the camera by exactly nothing, for both signs — measured.
    const panT = clamp(io.steer ?? 0, -1, 1);
    hutPan += (panT - hutPan) * Math.min(1, dt * 2.4);

    // ---- ordering ----------------------------------------------------------
    // `pick` is a LEVEL (see controls.js), so this has to find the edge itself.
    // Left as a level test it re-ordered every frame: 120 frames of alternating
    // 1/2 pushed 120 runs, fired 120 one-shots and moved the sun three quarters
    // of a day. PICK_COOLDOWN then stops a fast alternation being a drink mill.
    pickCool = Math.max(0, pickCool - dt);
    const pickEdge = io.pick !== 0 && io.pick !== prevPick && pickCool <= 0;
    prevPick = io.pick;
    if (phase === 'sit') {
      if (pickEdge && io.pick === 1 && drink !== 'coffee') serve(state, 'coffee');
      else if (pickEdge && io.pick === 2 && drink !== 'beer') serve(state, 'beer');
      else if (io.actionPressed) { phase = 'out'; phaseT = 0; veilTarget = 1; }
    }

    drinkT += dt;
    barBeat = Math.max(0, barBeat - dt);
    // The drink rises towards the lens once it is in front of you — which, with
    // the bar beat running, is after the camera has come back from the counter.
    const rise = drink ? clamp((drinkT - riseDelay) / T_SIP, 0, 1) : 0;
    const lift = Math.sin(rise * Math.PI) * 0.13;
    if (mugMesh) { mugMesh.position.set(0, lift, 0); glassMesh.position.set(0, lift, 0); }
    if (steamMesh) {
      const on = drink === 'coffee';
      steamMesh.visible = on;
      if (on) {
        // Billboard: the plume is built in its own +x/+y plane at the origin, so
        // it is pinned to the coffee surface and yawed at the lens here rather
        // than baked at whatever angle the room happens to sit at.
        const sp = interior.steamAt;
        steamMesh.position.set(sp.x, sp.y + lift, sp.z);
        steamMesh.rotation.set(0, Math.atan2(camera.position.x - sp.x, camera.position.z - sp.z), 0);
        const t = (drinkT % 2.6) / 2.6;
        steamMesh.scale.set(0.85 + 0.30 * t, 0.80 + 0.42 * t, 1);
        steamMesh.material.opacity =
          0.34 * clamp(Math.sin(Math.pow(t, 0.8) * Math.PI) * 1.25, 0, 1)
          * (0.72 + 0.28 * Math.sin(drinkT * 2.3));
      }
    }

    state.hut = {
      name: hutNote,
      choices: [
        { key: '1', label: 'Coffee', note: 'warms you through' },
        { key: '2', label: 'Beer', note: 'a long sit' },
      ],
      drink,
      served: rise,
      run: lastRun,
      hint: 'A/D look around · E step back onto the snow',
    };
  }

  function serve(state, kind, beat = true) {
    drink = kind; drinkT = 0;
    pickCool = PICK_COOLDOWN;
    // Order at the bar, look at the bar. See `interior.barAim`.
    barBeat = beat ? T_BAR_BEAT : 0;
    riseDelay = beat ? T_BAR_BEAT * 0.62 : 0;
    if (mugMesh) mugMesh.visible = kind === 'coffee';
    if (glassMesh) glassMesh.visible = kind === 'beer';
    warmth = kind === 'coffee' ? 1 : Math.max(warmth, 0.85);
    glowFlash = 1;
    audio?.sip?.(kind);
    // A stop costs time, and the light is the only honest way to show that.
    // sky.setTimeOfDay re-derives the whole lighting rig, so it happens exactly
    // once per drink, inside a room, with the HUD holding a card over the frame.
    //
    // Clamped at TOD_LAST_LIFT, and NOT wrapped: `setTimeOfDay` takes the value
    // mod 1, so the unbounded version rolled 0.302 past 1.0 and came out at 0.042
    // — the middle of the night, reachable by holding two keys. The stop still
    // costs you the afternoon; it cannot cost you the day.
    if (sky?.setTimeOfDay && sky.getTimeOfDay) {
      const t = sky.getTimeOfDay();
      const want = t + (kind === 'beer' ? 0.020 : 0.009);
      const next = t <= TOD_LAST_LIFT ? Math.min(want, TOD_LAST_LIFT) : t;
      if (next !== t) sky.setTimeOfDay(next);
    }
    if (lastRun) {
      (state.runs || (state.runs = [])).push({ ...lastRun, drink: kind });
    }
  }

  // =========================================================================
  // camera
  // =========================================================================
  /** Called by main.js instead of chaseCam when the mode is 'lift' or 'hut'. */
  function updateCamera(dt, state) {
    dt = clamp(dt || 0, 0, 0.1);
    camera.up.set(0, 1, 0);

    if (mode === 'lift') {
      cableAt(upCable, rideS, _p);
      cableAt(upCable, Math.min(rideS + 6, upCable.total), _p2);
      _d.copy(_p2).sub(_p);
      if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1);
      _d.normalize();
      // eye: sitting back on the pad, so the bar is 0.8 m in front of the lens
      _p.y -= SEAT_DROP - EYE_UP;
      _p.x -= _d.x * 0.14; _p.z -= _d.z * 0.14;
      _p.y += Math.sin(modeT * 0.9) * 0.035;
      const ca = Math.cos(pan), sa = Math.sin(pan);
      _aim.set(_d.x * ca - _d.z * sa, 0, _d.z * ca + _d.x * sa);
      // Aim 18 m up the line and 4.2 m down — 13 degrees, which is what puts
      // the safety bar along the bottom edge and still leaves the towers and the
      // ridgeline in the upper half. Holding tuck rolls that to 55 degrees and
      // you are looking at your own ski tips over the footrest.
      const lookD = lerp(4.2, 21.0, tilt);
      _aim.multiplyScalar(18).add(_p);
      _aim.y = _p.y - lookD + Math.sin(modeT * 0.63) * 0.18;
      _seatEye.copy(_p); _seatAim.copy(_aim);
      camera.position.copy(_p);
      camera.lookAt(_aim);
      camera.rotateZ(sway * 0.8);
      setFov(camera, 60);
    } else if (mode === 'hut') {
      const p = interior.camPos, a = interior.camAim;
      // A slow breath so a fixed interior camera is not a photograph, plus a
      // very slow drift across the room over ~40 s: the still framing is the
      // window table, but anyone who sits there long enough sees the bar, the
      // stove and the rest of the room go by. A room you can only see one wall
      // of is a diorama.
      const bx = Math.sin(modeT * 0.41) * 0.012, by = Math.sin(modeT * 0.53 + 1.3) * 0.010;
      const drift = Math.sin(modeT * 0.157) * 0.62;      // metres, along the wall
      const dx = interior.driftA.x * drift, dz = interior.driftA.z * drift;
      camera.position.set(p.x + bx + dx, p.y + by, p.z + bx * 0.6 + dz);
      _aim.copy(a);
      _aim.x -= dx * 1.9; _aim.z -= dz * 1.9;            // sweep, not a slide
      // steer pans the head: rotate the aim about the eye
      if (Math.abs(hutPan) > 1e-3) {
        const ang = hutPan * 1.15;
        const ex = _aim.x - camera.position.x, ez = _aim.z - camera.position.z;
        const ca2 = Math.cos(ang), sa2 = Math.sin(ang);
        _aim.x = camera.position.x + ex * ca2 - ez * sa2;
        _aim.z = camera.position.z + ez * ca2 + ex * sa2;
      }
      // the drink comes up towards the lens: follow it a touch
      const rise = drink ? clamp((drinkT - riseDelay) / T_SIP, 0, 1) : 0;
      _aim.y += Math.sin(rise * Math.PI) * 0.05;
      // ...and the trip to the counter when an order goes in. A clipped sine, so
      // it leaves, HOLDS on the bar for the middle second, and comes back.
      if (barBeat > 0) {
        const u = 1 - barBeat / T_BAR_BEAT;                       // 0 -> 1
        const k = ease(clamp(Math.sin(clamp(u, 0, 1) * Math.PI) * 1.55, 0, 1));
        camera.position.lerp(interior.barCam, k);
        _aim.lerp(interior.barAim, k);
      }
      camera.lookAt(_aim);
      setFov(camera, 62);
    }

    applyBlend(dt);
  }

  /** Called by main.js AFTER chaseCam, to ease out of a mode into the run. */
  function postCamera(dt) {
    applyBlend(clamp(dt || 0, 0, 0.1));
    // the chair stays hanging there until the shot has left it
    if (mode === 'ski' && blend <= 0 && chairRig.visible) chairRig.visible = false;
  }

  function applyBlend(dt) {
    /**
     * Boarding: from the stored chase view INTO the seat, over T_BOARD.
     *
     * The first cut lerped position and orientation straight from one to the
     * other, and the result was 1.45 s of nothing: the rider was deleted on the
     * frame E was pressed, the seat is 21.0 m above and 15.7 m sideways from
     * where he stood, and the orientation still held the chase framing, so at
     * 0.7 s the shot was blank snow — no chair, no rider, no station.
     *
     * So the move HOLDS first and is AIMED throughout. For T_BOARD_HOLD of it
     * the camera does not move at all: it sits where the chase camera was, on
     * the rider, who is still on his feet at the station (T_SHOW_SKIER). That is
     * the beat that says "you got on". Then it rises to the seat, its aim easing
     * off him into the seat's own framing, which looks 18 m up the line and 13
     * degrees down, so there is hill in shot the whole way up.
     *
     * Both of the obvious framings were tried and measured, and both are worse:
     *
     *  - aim at the CHAIR through the middle. The grip is 21 m up, so from a
     *    camera still near the snow that is a 55-degree look: 95% sky.
     *  - start rising immediately and aim at the rider. Then at 0.7 s the lens
     *    is 6.7 m up looking 34 degrees DOWN at a rider who has just been
     *    hidden: a frame of nothing but snow, sd 23.9.
     */
    if (mode === 'lift' && phase === 'board' && camFrom) {
      const u = clamp(phaseT / T_BOARD, 0, 1);
      const rest = 1 - T_BOARD_HOLD;
      const uMove = ease(clamp((u - T_BOARD_HOLD) / rest, 0, 1));
      camera.position.lerpVectors(camFrom, _seatEye, uMove);
      _blendAim.lerpVectors(_boardAt, _seatAim, ease(clamp((u - T_BOARD_HOLD * 0.86) / (1 - T_BOARD_HOLD * 0.86), 0, 1)));
      _mat.lookAt(camera.position, _blendAim, camera.up);
      _q2.setFromRotationMatrix(_mat);
      _q.copy(camFromQ);
      camera.quaternion.slerpQuaternions(_q, _q2, ease(clamp(u / 0.18, 0, 1)));
      setFov(camera, lerp(camFromFov, 60, uMove));
      return;
    }
    if (blend <= 0 || !camFrom) return;
    blend = Math.max(0, blend - dt / Math.max(0.05, blendDur));
    const u = ease(1 - blend);
    _p2.copy(camera.position);
    camera.position.lerpVectors(camFrom, _p2, u);
    _q.copy(camFromQ); _q2.copy(camera.quaternion);
    camera.quaternion.slerpQuaternions(_q, _q2, u);
    setFov(camera, lerp(camFromFov, camera.fov, u));
  }

  function setFov(cam, f) {
    if (Math.abs(cam.fov - f) > 0.02) { cam.fov = f; cam.updateProjectionMatrix(); }
  }

  // =========================================================================
  const api = {
    get mode() { return mode; },
    get phase() { return phase; },
    /**
     * Time compression of the ride in progress, 1 while skiing. `main.js`
     * multiplies scatter's dt by this so the chairs coming the other way stay in
     * phase with the player's — see the LAPSE_* block. Nothing else is scaled:
     * the clouds and the wind at 1x during a compressed ride are invisible, and
     * the audio and the HUD smoothing genuinely want real seconds.
     */
    get timeScale() { return lapse; },
    zones,
    update,
    updateCamera,
    postCamera,
    interiorGroup,
    chairRig,

    /**
     * Force a mode. This is the hook the capture harness uses — without it a
     * reviewer cannot screenshot any of this.
     *
     *   harness.debug.resort.enter('lift')                  board at the valley
     *   harness.debug.resort.enter('lift', { at: 'mid' })   board at mid-station
     *   harness.debug.resort.enter('lift', { progress: .5 }) half way up
     *   harness.debug.resort.enter('drag', { progress: .3 })
     *   harness.debug.resort.enter('hut',  { drink: 'beer' })
     *   harness.debug.resort.enter('ski')
     */
    enter(which, o = {}) {
      const state = opts.state;
      if (which === 'ski') {
        const z = o.x !== undefined ? o : { x: state.pos.x, z: state.pos.z };
        backToSki(state, z.x, z.z, o.heading ?? Math.PI);
        blend = 0;
      } else if (which === 'lift') {
        const zone = zones.find((q) => q.id === (o.at === 'mid' ? 'chair-mid' : 'chair-bottom'));
        enterLift(state, zone, o.progress);
        // `to: 'summit'` forces the full line; the default is the mid-station
        // leg, which is what a player gets.
        if (o.to === 'summit') rideTotal = liftTop;
        if (o.instant !== false) { phase = 'ride'; phaseT = 0; camFrom = null; setSkierVisible(false); }
      } else if (which === 'drag') {
        enterDrag(state, o.progress ?? 0.35);
        if (o.instant !== false) { phase = 'ride'; phaseT = 0; }
      } else if (which === 'hut') {
        enterHut(state, zones.find((q) => q.id === 'hut'));
        if (o.instant !== false) {
          veil = 0; veilTarget = 0; phase = 'sit'; phaseT = 0; camFrom = null;
          if (interiorGroup) interiorGroup.visible = true;
        }
        // `enter('hut', { drink })` is "already sitting there with one", so it
        // does NOT play the bar beat — a forced state is a still, not a moment.
        // Pass `beat: true` to see the camera go across to the counter.
        if (o.drink) serve(state, o.drink, o.beat === true);
      }
      publishMode(state);
      return mode;
    },

    /**
     * Teleport the player next to an interaction, so the contact prompt can be
     * shot. He arrives stationary — `backToSki` now takes the flying start off
     * every hand-back, this one included; at 20 m/s a 2.5 s settle carried the
     * rider 50 m past the zone and out of prompt range, which is what the first
     * version of this did.
     */
    goto(id, state = opts.state) {
      const z = zones.find((q) => q.id === id);
      if (!z) return null;
      const x = z.x, zz = z.z + 7;
      backToSki(state, x, zz, Math.PI);
      blend = 0;
      publishMode(state);
      return { x, z: zz };
    },

    /** Probe hook: the warmth tank takes eleven minutes to drain honestly. */
    setWarmth(v) { warmth = clamp(v, 0, 1); return warmth; },

    info() {
      return {
        mode, phase, modeT, rideS, rideTotal, rideFrom, lapse: +lapse.toFixed(2),
        skipArmed, warmth, drink, barBeat: +barBeat.toFixed(2),
        zones: zones.map((z) => ({ id: z.id, x: +z.x.toFixed(1), z: +z.z.toFixed(1), r: z.r, s: z.s })),
        cable: upCable ? { total: +upCable.total.toFixed(1), unloadAt: +liftTop.toFixed(1), midS: midS && +midS.toFixed(1) } : null,
        interiorTris: interior ? interior.triangles : 0,
        drag: draglift ? { total: +draglift.total.toFixed(1), board: draglift.board, unload: draglift.unload } : null,
      };
    },

    dispose() {
      if (interiorGroup) {
        scene.remove(interiorGroup);
        interiorGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      }
      scene.remove(chairRig);
      chairRig.geometry.dispose(); chairRig.material.dispose();
    },
  };
  return api;
}
