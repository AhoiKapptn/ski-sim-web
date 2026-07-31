import * as THREE from 'three';

/**
 * Alpine — the T-bar.
 *
 * The second lift on the mountain, and deliberately NOT a second chairlift: a
 * drag lift is a different verb. You stay on your skis, you stay on the snow,
 * and the mountain goes past you at walking pace with a steel bar under your
 * backside. It also costs a tenth of the geometry of the chair, which is the
 * other reason to build this one rather than clone that one.
 *
 * ### Where it is, and why it is placed off the CHAIR and not off the corridor
 *
 * The lower pitch below the snow park (z -1080 .. -400) is a 12 degree roll that
 * the big chair overflies without serving: to lap it you had to ride 4 km of
 * cable to the summit. The T-bar turns that pitch into a 680 m lap.
 *
 * The line is placed by INTERPOLATING `scatter.lift.towers[]` and stepping
 * sideways from it. `corridorX0()` — the sine pair that defines the piste
 * centreline — lives in `terrain.js` and `scatter.js` and a third copy of it is
 * exactly the ambiguous seam CLAUDE.md warns about, so this module never writes
 * that expression down. It reads the chair line, which is a published seam, and
 * offsets by `OFFSET_FROM_CHAIR`. If the corridor ever moves, both lifts move
 * together by construction.
 *
 * ### Contract
 *
 *   createDragLift(scene, terrain, { towers })      towers = scatter.lift.towers
 *     -> { group, line, update(dt, state), rideStart, sample(s, out), pathY(s),
 *          setRider(...), setRiderVisible(v), dispose() }
 *
 *   line.total        arc length of the ride, metres (plan distance)
 *   sample(s, out)    point on the SNOW at arc length s (0 = bottom station)
 *   line.dirAt(s)     unit uphill direction in plan at s
 *
 * `resort.js` owns the ride state machine; this file owns the geometry and the
 * bars going round. Nothing here reads `state` except to cull.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Construction-time scratch (nothing here allocates per frame). */
const _tmpA = new THREE.Vector3();

// --- placement ---------------------------------------------------------------
// Metres from the CHAIR line to the T-bar line. The chair runs 68 m to the
// skier's right of the corridor centreline, so +98 puts this 30 m to the LEFT
// of it: inside the 46 m cleared corridor (no tree grows through a pylon) and
// clear of the 38-43 m marker line and the snow-gun row at 41-47 m.
const OFFSET_FROM_CHAIR = 98;
const Z_BOTTOM = -1080;
const Z_TOP = -400;
const N_PYLON = 9;
const ROPE_H = 4.9;          // rope height over the snow at a pylon sheave
const BAR_SPACING = 24;      // metres between T-bars on the rope
const BAR_VIS = 26;          // instanced bars kept alive around the player
const RIDE_SPEED = 3.4;      // m/s — a real T-bar runs 2.5-4 m/s

const STEEL = [0.115, 0.125, 0.145];
const STEEL_L = [0.26, 0.27, 0.30];
const PAINT = [0.30, 0.075, 0.05];
const CONCRETE = [0.31, 0.31, 0.30];
const TIMBER = [0.19, 0.155, 0.125];
const SNOW = [1.05, 1.07, 1.12];
const RUBBER = [0.045, 0.045, 0.050];
const SIGN = [0.72, 0.62, 0.10];

/**
 * Minimal geometry builder: positions/normals/colours into flat arrays, then
 * one non-indexed BufferGeometry. Same shape of tool as scatter's private `GB`,
 * kept local rather than imported because that one is not exported and a
 * cross-module reach into it would be a worse seam than 90 lines of arithmetic.
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

  /** Axis-aligned-then-yawed box. `half` is half extents (x across, y up, z along). */
  box(cx, cy, cz, hx, hy, hz, yaw, col) {
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const V = (a, b, c) => new THREE.Vector3(cx + a * ca + c * sa, cy + b, cz - a * sa + c * ca);
    const p = [
      V(-hx, -hy, -hz), V(hx, -hy, -hz), V(hx, -hy, hz), V(-hx, -hy, hz),
      V(-hx, hy, -hz), V(hx, hy, -hz), V(hx, hy, hz), V(-hx, hy, hz),
    ];
    this.quad(p[4], p[5], p[6], p[7], col);           // top
    this.quad(p[3], p[2], p[1], p[0], col);           // bottom
    this.quad(p[0], p[1], p[5], p[4], col);
    this.quad(p[2], p[3], p[7], p[6], col);
    this.quad(p[1], p[2], p[6], p[5], col);
    this.quad(p[3], p[0], p[4], p[7], col);
    return this;
  }

  /** Capped cylinder from a to b. `seg` sides — 6 is plenty for a 12 cm tube. */
  tube(a, b, r, col, seg = 6, capped = true) {
    const ax = new THREE.Vector3().subVectors(b, a);
    const len = ax.length();
    if (len < 1e-4) return this;
    ax.multiplyScalar(1 / len);
    const up = Math.abs(ax.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(up, ax).normalize();
    const v = new THREE.Vector3().crossVectors(ax, u);
    const ring = (o) => {
      const out = [];
      for (let i = 0; i < seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        out.push(new THREE.Vector3(
          o.x + (u.x * Math.cos(th) + v.x * Math.sin(th)) * r,
          o.y + (u.y * Math.cos(th) + v.y * Math.sin(th)) * r,
          o.z + (u.z * Math.cos(th) + v.z * Math.sin(th)) * r));
      }
      return out;
    };
    const r0 = ring(a), r1 = ring(b);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      this.quad(r0[i], r0[j], r1[j], r1[i], col);
    }
    if (capped) {
      for (let i = 1; i < seg - 1; i++) {
        this.tri(r1[0], r1[i], r1[i + 1], col);
        this.tri(r0[0], r0[i + 1], r0[i], col);
      }
    }
    return this;
  }

  /** Flat disc facing +axis, for bull wheels seen edge-on. */
  wheel(c, axis, r, col, seg = 14) {
    const ax = axis.clone().normalize();
    const up = Math.abs(ax.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(up, ax).normalize();
    const v = new THREE.Vector3().crossVectors(ax, u);
    const pt = (th, rr) => new THREE.Vector3(
      c.x + (u.x * Math.cos(th) + v.x * Math.sin(th)) * rr,
      c.y + (u.y * Math.cos(th) + v.y * Math.sin(th)) * rr,
      c.z + (u.z * Math.cos(th) + v.z * Math.sin(th)) * rr);
    // rim as a shallow ring, so it reads as a wheel from both sides
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      const o0 = pt(t0, r), o1 = pt(t1, r), i0 = pt(t0, r * 0.72), i1 = pt(t1, r * 0.72);
      this.quad(i0, o0, o1, i1, col);
      this.quad(i1, o1, o0, i0, col);
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

/** One hanging T-bar: hanger rod, spring housing, rubber-sleeved crossbar. */
function buildBar() {
  const b = new Bld();
  const O = (x, y, z) => new THREE.Vector3(x, y, z);
  b.box(0, -0.10, 0, 0.09, 0.10, 0.07, 0, STEEL_L);          // rope clamp
  b.box(0, -0.42, 0, 0.07, 0.24, 0.07, 0, STEEL);            // spring housing
  b.tube(O(0, -0.62, 0), O(0, -2.42, 0), 0.022, STEEL, 5);   // hanger
  b.tube(O(-0.36, -2.44, 0), O(0.36, -2.44, 0), 0.038, RUBBER, 6);  // the T
  b.tube(O(0, -2.30, 0), O(0, -2.46, 0), 0.030, STEEL, 5);
  return b.geometry();
}

export function createDragLift(scene, terrain, opts = {}) {
  const towers = opts.towers || null;
  const group = new THREE.Group();
  group.name = 'draglift';

  // ---- the line ------------------------------------------------------------
  /**
   * Chair-line x at a given z, by linear interpolation of the published tower
   * list. Towers are 104 m apart and the corridor's plan curvature is under
   * 4 degrees, so linear is well inside the 0.1 m that matters here.
   */
  function chairX(z) {
    if (!towers || towers.length < 2) return 0;
    const a = towers[0], b = towers[towers.length - 1];
    if (z <= a.z) return a.x;
    if (z >= b.z) return b.x;
    // towers are z-ordered valley -> top
    let lo = 0, hi = towers.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (towers[mid].z <= z) lo = mid; else hi = mid;
    }
    const t = (z - towers[lo].z) / Math.max(1e-6, towers[hi].z - towers[lo].z);
    return lerp(towers[lo].x, towers[hi].x, t);
  }

  const lineX = (z) => chairX(z) + OFFSET_FROM_CHAIR;

  // Arc-length table in PLAN (the drag is along the snow, so the ride distance
  // the player covers is the surface distance; plan length is what the rope and
  // the bar spacing are measured in and the two differ by 2% at 12 degrees).
  const NS = 96;
  const px = new Float64Array(NS + 1), pz = new Float64Array(NS + 1);
  const py = new Float64Array(NS + 1), cum = new Float64Array(NS + 1);
  for (let i = 0; i <= NS; i++) {
    const z = lerp(Z_BOTTOM, Z_TOP, i / NS);
    px[i] = lineX(z); pz[i] = z; py[i] = terrain.height(px[i], z);
    if (i) cum[i] = cum[i - 1] + Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]);
  }
  const total = cum[NS];

  /** Snow point at arc length s. */
  function sample(s, out) {
    const q = clamp(s, 0, total);
    let lo = 0, hi = NS;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= q) lo = mid; else hi = mid; }
    const t = (q - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
    const x = lerp(px[lo], px[hi], t), z = lerp(pz[lo], pz[hi], t);
    return (out || new THREE.Vector3()).set(x, terrain.height(x, z), z);
  }

  /**
   * Plan position only (no terrain sample). The circulating bars hang from the
   * rope, so their y comes from `ropeAt` and the snow height under them is
   * discarded — this exists so 28 bars a frame do not cost 28 `terrain.height`
   * calls for a number nothing reads. `terrain.height` is on the physics hot
   * path; adding avoidable calls to it is how a cheap prop gets expensive.
   */
  function planAt(s, out) {
    const q = clamp(s, 0, total);
    let lo = 0, hi = NS;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= q) lo = mid; else hi = mid; }
    const t = (q - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
    return (out || new THREE.Vector3()).set(lerp(px[lo], px[hi], t), 0, lerp(pz[lo], pz[hi], t));
  }

  /** Unit uphill direction in plan at arc length s. */
  function dirAt(s, out) {
    const q = clamp(s, 0, total);
    let lo = 0, hi = NS;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= q) lo = mid; else hi = mid; }
    const dx = px[hi] - px[lo], dz = pz[hi] - pz[lo];
    const l = Math.hypot(dx, dz) || 1;
    return (out || new THREE.Vector3()).set(dx / l, 0, dz / l);
  }

  // Rope height above the snow, sampled at the pylons and interpolated. Held
  // clear of the ground the same way the chair's cable is: at least ROPE_H over
  // the worst snow in the span, so it never dives into a roll.
  const pyS = [], pyPos = [], ropeY = [];
  for (let i = 0; i < N_PYLON; i++) {
    const s = (i / (N_PYLON - 1)) * total;
    pyS.push(s);
    const p = sample(s, new THREE.Vector3());
    pyPos.push(p);
    ropeY.push(p.y + ROPE_H);
  }

  /**
   * Clearance pass. A drag rope hangs a fixed ~5 m over the snow and is
   * therefore very nearly PARALLEL to the hill — which is the opposite of the
   * chairlift, whose cable flies 104 m gaps over gullies and is held to a
   * worst-in-window height. Taking the chair's approach here put the rope 11.8 m
   * up (measured), because on a 12 degree pitch the "worst ground within half a
   * span" is simply the top of the span. So: local height plus ROPE_H, then only
   * raise a pylon pair if the ground actually BULGES above the straight line
   * between their tops.
   */
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N_PYLON - 1; i++) {
      let need = 0;
      for (let k = 1; k < 8; k++) {
        const t = k / 8;
        const s = lerp(pyS[i], pyS[i + 1], t);
        const gy = sample(s, _tmpA).y;
        const line = lerp(ropeY[i], ropeY[i + 1], t);
        need = Math.max(need, gy + ROPE_H * 0.78 - line);
      }
      if (need > 0) { ropeY[i] += need; ropeY[i + 1] += need; }
    }
  }

  /** Rope height at arc length s, with a little sag between pylons. */
  function ropeAt(s) {
    const q = clamp(s, 0, total);
    let i = 0;
    while (i < N_PYLON - 2 && pyS[i + 1] < q) i++;
    const t = (q - pyS[i]) / Math.max(1e-6, pyS[i + 1] - pyS[i]);
    const span = pyS[i + 1] - pyS[i];
    const sag = Math.min(0.9, span * span * 0.000035);
    return lerp(ropeY[i], ropeY[i + 1], t) - sag * 4 * t * (1 - t);
  }

  // ---- static geometry -----------------------------------------------------
  const b = new Bld();
  const _a = new THREE.Vector3(), _b2 = new THREE.Vector3();
  const dTmp = new THREE.Vector3();

  // Lateral offset of the two rope strands from the line: the uphill strand is
  // directly over the skiers, the return strand is 1.5 m to its side.
  const STRAND = 1.5;

  for (let i = 0; i < N_PYLON; i++) {
    const p = pyPos[i], ry = ropeY[i];
    dirAt(pyS[i], dTmp);
    const nx = -dTmp.z, nz = dTmp.x;          // plan normal, +x-ish side
    const yaw = Math.atan2(dTmp.x, dTmp.z);

    // footing: a plinth standing proud of the snow, like the chair's
    b.box(p.x, p.y - 0.15, p.z, 0.62, 0.55, 0.62, yaw, CONCRETE);
    // mast, leaning very slightly uphill the way a drag pylon does
    _a.set(p.x, p.y + 0.25, p.z);
    _b2.set(p.x + dTmp.x * 0.28, ry + 0.32, p.z + dTmp.z * 0.28);
    b.tube(_a, _b2, 0.115, STEEL, 8);
    // top arm out over the two strands, plus a diagonal stay back to the mast
    const armEnd = new THREE.Vector3(_b2.x + nx * (STRAND + 0.35), ry + 0.28, _b2.z + nz * (STRAND + 0.35));
    b.tube(_b2, armEnd, 0.075, STEEL, 6);
    b.tube(new THREE.Vector3(p.x + dTmp.x * 0.1, ry - 1.5, p.z + dTmp.z * 0.1),
      new THREE.Vector3(lerp(_b2.x, armEnd.x, 0.75), ry + 0.28, lerp(_b2.z, armEnd.z, 0.75)),
      0.042, STEEL, 5);
    // the two sheaves, axes across the line
    for (const k of [0, 1]) {
      const cx = _b2.x + nx * (STRAND * k), cz = _b2.z + nz * (STRAND * k);
      b.wheel(new THREE.Vector3(cx, ry, cz), new THREE.Vector3(nx, 0, nz), 0.30, STEEL_L, 12);
      b.box(cx, ry + 0.18, cz, 0.10, 0.14, 0.24, yaw, STEEL);
    }
    // a numbered pylon plate, because every real pylon has one
    b.box(p.x + nx * 0.22, p.y + 2.1, p.z + nz * 0.22, 0.02, 0.22, 0.16, yaw, SIGN);
  }

  // rope: two strands as swept tubes over the pylon tops
  for (const k of [0, 1]) {
    const pts = [];
    const N = 60;
    for (let i = 0; i <= N; i++) {
      const s = (i / N) * total;
      sample(s, _a); dirAt(s, dTmp);
      const nx = -dTmp.z, nz = dTmp.x;
      pts.push(new THREE.Vector3(_a.x + nx * (STRAND * k), ropeAt(s), _a.z + nz * (STRAND * k)));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    // 5 cm rope with a width floor for the same reason the chair's cable has
    // one: under a pixel at distance it simply vanishes and leaves the bars
    // hanging off nothing.
    const tube = new THREE.TubeGeometry(curve, N, 0.048, 4, false);
    const pos = tube.getAttribute('position'), nrm = tube.getAttribute('normal');
    const idx = tube.getIndex();
    for (let i = 0; i < idx.count; i += 3) {
      const t = [];
      for (let j = 0; j < 3; j++) {
        const q = idx.getX(i + j);
        t.push({ x: pos.getX(q), y: pos.getY(q), z: pos.getZ(q) });
      }
      // keep the tube's own smooth normals rather than the flat facet normal
      const n0 = idx.getX(i);
      const nn = [nrm.getX(n0), nrm.getY(n0), nrm.getZ(n0)];
      for (const v of t) { b.p.push(v.x, v.y, v.z); b.n.push(nn[0], nn[1], nn[2]); b.c.push(STEEL[0], STEEL[1], STEEL[2]); }
    }
    tube.dispose();
  }

  // ---- stations -----------------------------------------------------------
  // Bottom: drive shed, bull wheel, a queue rail and a boarding gate. Top: a
  // return wheel and the sign that tells you to let go.
  {
    const p0 = pyPos[0], p1 = pyPos[N_PYLON - 1];
    dirAt(0, dTmp);
    const yaw0 = Math.atan2(dTmp.x, dTmp.z);
    const n0x = -dTmp.z, n0z = dTmp.x;

    // drive shed, set back 9 m below the first pylon and off to the side
    const sx = p0.x - dTmp.x * 9 + n0x * 2.2, sz = p0.z - dTmp.z * 9 + n0z * 2.2;
    const sy = terrain.height(sx, sz);
    b.box(sx, sy + 1.25, sz, 2.0, 1.45, 2.8, yaw0, TIMBER);
    b.box(sx, sy + 2.85, sz, 2.25, 0.16, 3.05, yaw0, SNOW);          // snow-loaded roof
    b.box(sx, sy - 0.25, sz, 2.2, 0.5, 3.0, yaw0, CONCRETE);
    b.box(sx + n0x * 1.9, sy + 1.5, sz + n0z * 1.9, 0.14, 0.55, 0.9, yaw0, [0.06, 0.09, 0.12]);

    // bull wheel on a short mast, axis vertical: this is the drive
    const wx = p0.x - dTmp.x * 4.5, wz = p0.z - dTmp.z * 4.5;
    const wy = terrain.height(wx, wz);
    b.tube(new THREE.Vector3(wx, wy, wz), new THREE.Vector3(wx, wy + 3.1, wz), 0.16, STEEL, 8);
    const bwx = wx + n0x * STRAND * 0.5, bwz = wz + n0z * STRAND * 0.5;
    b.wheel(new THREE.Vector3(bwx, wy + 3.15, bwz), new THREE.Vector3(0, 1, 0),
      STRAND * 0.5 + 0.35, STEEL_L, 16);
    // hub + gearbox housing: a bare ring on a pole reads as a floating ellipse
    b.tube(new THREE.Vector3(bwx, wy + 2.75, bwz), new THREE.Vector3(bwx, wy + 3.30, bwz), 0.26, STEEL_L, 8);
    b.box(bwx, wy + 2.55, bwz, 0.42, 0.30, 0.42, yaw0, STEEL);
    b.tube(new THREE.Vector3(wx, wy + 2.6, wz), new THREE.Vector3(bwx, wy + 2.6, bwz), 0.12, STEEL, 6);
    b.box(wx, wy + 0.55, wz, 0.5, 0.55, 0.5, yaw0, PAINT);

    // boarding lane: two rails you slide between, and a rubber mat where the
    // bar comes round
    for (const side of [-1, 1]) {
      const ax = p0.x - dTmp.x * 7 + n0x * side * 1.8, az = p0.z - dTmp.z * 7 + n0z * side * 1.8;
      const bx = p0.x + dTmp.x * 2 + n0x * side * 1.8, bz = p0.z + dTmp.z * 2 + n0z * side * 1.8;
      const ay = terrain.height(ax, az), by = terrain.height(bx, bz);
      b.tube(new THREE.Vector3(ax, ay + 0.95, az), new THREE.Vector3(bx, by + 0.95, bz), 0.030, PAINT, 5);
      for (let k = 0; k <= 3; k++) {
        const t = k / 3;
        const fx = lerp(ax, bx, t), fz = lerp(az, bz, t);
        const fy = terrain.height(fx, fz);
        b.tube(new THREE.Vector3(fx, fy - 0.2, fz), new THREE.Vector3(fx, fy + 1.0, fz), 0.026, STEEL, 5);
      }
    }
    // "T-BAR" board over the boarding point
    {
      const gx = p0.x - dTmp.x * 6.5 + n0x * 2.6, gz = p0.z - dTmp.z * 6.5 + n0z * 2.6;
      const gy = terrain.height(gx, gz);
      b.tube(new THREE.Vector3(gx, gy - 0.2, gz), new THREE.Vector3(gx, gy + 2.6, gz), 0.055, STEEL, 6);
      b.box(gx, gy + 2.5, gz, 0.9, 0.42, 0.05, yaw0 + Math.PI * 0.5, SIGN);
      b.box(gx, gy + 2.5, gz, 0.62, 0.16, 0.07, yaw0 + Math.PI * 0.5, [0.05, 0.05, 0.06]);
    }

    // top: return wheel and the unload sign, a few metres past the last pylon
    dirAt(total, dTmp);
    const yaw1 = Math.atan2(dTmp.x, dTmp.z);
    const n1x = -dTmp.z, n1z = dTmp.x;
    const tx = p1.x + dTmp.x * 6, tz = p1.z + dTmp.z * 6;
    const ty = terrain.height(tx, tz);
    b.box(tx, ty - 0.2, tz, 0.7, 0.6, 0.7, yaw1, CONCRETE);
    b.tube(new THREE.Vector3(tx, ty + 0.2, tz), new THREE.Vector3(tx, ropeAt(total) + 0.3, tz), 0.13, STEEL, 8);
    b.wheel(new THREE.Vector3(tx + n1x * STRAND * 0.5, ropeAt(total) + 0.34, tz + n1z * STRAND * 0.5),
      new THREE.Vector3(0, 1, 0), STRAND * 0.5 + 0.3, STEEL_L, 16);
    {
      const gx = p1.x + n1x * 3.0, gz = p1.z + n1z * 3.0;
      const gy = terrain.height(gx, gz);
      b.tube(new THREE.Vector3(gx, gy - 0.2, gz), new THREE.Vector3(gx, gy + 2.3, gz), 0.05, STEEL, 6);
      b.box(gx, gy + 2.2, gz, 0.75, 0.5, 0.05, yaw1 + Math.PI * 0.5, [0.68, 0.10, 0.06]);
      b.box(gx, gy + 2.2, gz, 0.5, 0.13, 0.07, yaw1 + Math.PI * 0.5, [0.92, 0.92, 0.94]);
    }
  }

  const staticTris = b.triangles;
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.62, metalness: 0.28,
  });
  mat.name = 'draglift';
  const mesh = new THREE.Mesh(b.geometry(), mat);
  mesh.name = 'draglift-static';
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  group.add(mesh);

  // ---- circulating bars ---------------------------------------------------
  const barGeo = buildBar();
  const bars = new THREE.InstancedMesh(barGeo, mat, BAR_VIS);
  bars.name = 'draglift-bars';
  bars.castShadow = true;
  bars.frustumCulled = false;
  bars.count = 0;
  bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(bars);

  const barList = [];
  {
    const n = Math.max(2, Math.floor(total / BAR_SPACING));
    for (let i = 0; i < n; i++) {
      // strand 0 = uphill (loaded), strand 1 = returning
      barList.push({ s: (i / n) * total, k: i % 2 });
    }
  }

  // ---- the bar the player is riding ---------------------------------------
  // Two meshes with per-frame transforms rather than rebuilt geometry: the
  // crossbar under the rider and the hanger rope up to the strand above him.
  const riderBar = new THREE.Mesh(new Bld()
    .tube(new THREE.Vector3(-0.36, 0, 0), new THREE.Vector3(0.36, 0, 0), 0.038, RUBBER, 6)
    .tube(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.16, 0), 0.030, STEEL, 5)
    .geometry(), mat);
  riderBar.name = 'tbar-rider';
  riderBar.visible = false;
  riderBar.castShadow = true;
  group.add(riderBar);

  // unit-length +Y rod, scaled to reach the rope each frame
  const riderRope = new THREE.Mesh(new Bld()
    .tube(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 0.022, STEEL, 5)
    .geometry(), mat);
  riderRope.name = 'tbar-rider-rope';
  riderRope.visible = false;
  group.add(riderRope);

  scene.add(group);

  // ---- runtime ------------------------------------------------------------
  let phase = 0;
  let warm = 5;
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3(1, 1, 1);   // reused; the warm-up block shrinks it
  const _p = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _e = new THREE.Euler();

  const api = {
    group,
    mesh,
    bars,
    triangles: staticTris + barGeo.getAttribute('position').count / 3,

    /** Ride geometry, for resort.js. */
    line: { total, dirAt, sample, planAt, ropeAt, speed: RIDE_SPEED, strand: STRAND },
    total,
    sample,
    dirAt,
    ropeAt,
    speed: RIDE_SPEED,

    /** Where a skier queues: a few metres below the bottom station. */
    board: (() => {
      const d = dirAt(0, new THREE.Vector3());
      const p = sample(0, new THREE.Vector3());
      const x = p.x - d.x * 6.0, z = p.z - d.z * 6.0;
      return { x, z, y: terrain.height(x, z), heading: Math.atan2(-d.x, -d.z) + Math.PI };
    })(),

    /** Where it drops you off: past the top station, pointed back down the hill. */
    unload: (() => {
      const d = dirAt(total, new THREE.Vector3());
      const p = sample(total, new THREE.Vector3());
      const x = p.x + d.x * 8.0 - d.z * 5.0, z = p.z + d.z * 8.0 + d.x * 5.0;
      return { x, z, y: terrain.height(x, z) };
    })(),

    /**
     * Place the player's own bar. `pos` is the rider's contact point, `heading`
     * his yaw; the bar sits under his backside and the hanger runs up to the
     * strand above him.
     */
    setRider(pos, heading, s) {
      riderBar.visible = true;
      riderRope.visible = true;
      const bx = pos.x + Math.sin(heading) * 0.30;      // just behind him
      const bz = pos.z + Math.cos(heading) * 0.30;
      const by = pos.y + 0.66;
      riderBar.position.set(bx, by, bz);
      riderBar.rotation.set(0, -heading, 0);
      const top = ropeAt(s);
      riderRope.position.set(bx, by + 0.14, bz);
      riderRope.scale.set(1, Math.max(0.2, top - by - 0.14), 1);
      // lean the hanger back a touch, the way a loaded T-bar hangs
      riderRope.rotation.set(0.12 * Math.cos(heading), 0, -0.12 * Math.sin(heading));
    },

    setRiderVisible(v) { riderBar.visible = !!v; riderRope.visible = !!v; },

    update(dt, state) {
      phase += (dt || 0) * RIDE_SPEED;
      if (phase > total) phase -= total;
      const p = state?.pos;
      const cx = p ? p.x : 0, cz = p ? p.z : 0;
      let used = 0;
      // --- shader warm-up ---------------------------------------------------
      // The bars only enter the instance buffer when the player is within 620 m
      // of this line, and a program is linked the first time a material is
      // actually DRAWN — including its shadow-depth variant, which
      // renderer.compile() does not cover. Left alone, that link lands mid-run,
      // on the frame the player first skis into range: measured, entering the
      // ride grew the program cache by 2. So one instance is emitted at the
      // player, scaled to a thousandth, for the first few frames: it goes
      // through the main pass and both shadow cascades and is a sub-pixel
      // nothing on screen.
      if (warm > 0) {
        warm--;
        _m.compose(_p.set(cx, (p ? p.y : 0) + 1, cz), _q.identity(), _s.set(1e-3, 1e-3, 1e-3));
        _m.toArray(bars.instanceMatrix.array, 0);
        _s.set(1, 1, 1);
        used = 1;
      }
      for (let i = 0; i < barList.length && used < BAR_VIS; i++) {
        const bar = barList[i];
        // strand 0 climbs, strand 1 comes back down
        let s = bar.k ? bar.s - phase : bar.s + phase;
        s = ((s % total) + total) % total;
        planAt(s, _p);
        const dx = _p.x - cx, dz = _p.z - cz;
        if (dx * dx + dz * dz > 620 * 620) continue;
        dirAt(s, _d);
        const nx = -_d.z, nz = _d.x;
        const sway = Math.sin(phase * 0.21 + i * 2.3) * 0.05;
        _e.set(sway * 0.7, Math.atan2(_d.x, _d.z), sway);
        _q.setFromEuler(_e);
        _m.compose(_p.set(_p.x + nx * STRAND * bar.k, ropeAt(s), _p.z + nz * STRAND * bar.k), _q, _s);
        _m.toArray(bars.instanceMatrix.array, used * 16);
        used++;
      }
      bars.count = used;
      bars.visible = used > 0;
      bars.instanceMatrix.needsUpdate = true;
    },

    dispose() {
      scene.remove(group);
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      mat.dispose();
    },
  };
  return api;
}
