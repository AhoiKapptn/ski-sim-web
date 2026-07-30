/**
 * Alpine — mountain terrain.
 *
 * Shape
 * -----
 * The massif is authored, not stumbled upon. A network of ridge segments with
 * crest elevations defines the skeleton (summit crest, two aretes framing the
 * descent, a facing range across the valley, a far background wall). A ridged
 * multifractal with domain warp dresses it, then two erosion passes run over
 * the grid: thermal/talus relaxation (scree cones, sharpened aretes) and a
 * flow-accumulation carve (dendritic gullies and couloirs that actually
 * connect). Finally a fall-line corridor is blended in so there is always a
 * coherent, monotonically descending, bankable piste to ski.
 *
 * Representation
 * --------------
 * The macro shape is baked once into a 1024^2 RGBA32F texture
 * (R height, G curvature, B flow, A bedrock exposure) covering 8.2 km, and is
 * reconstructed with Catmull-Rom bicubic. Everything below ~30 m is analytic
 * lattice noise. Both the CPU (`height`, `normal`) and the vertex shader run
 * *the same* reconstruction against *the same* data, so the physics surface and
 * the rendered mesh cannot drift apart.
 *
 * LOD
 * ---
 * A geometry clipmap: 9 concentric levels, cell size 0.4 m -> 102 m, covering
 * 19.7 km. Levels are positioned by the model matrix and displaced entirely on
 * the GPU, so moving the camera costs zero CPU work — no re-tessellation, ever.
 * The *ring resolution* is not constant: it ramps from 96 up to 384 with the
 * level, because a uniform-resolution clipmap facets its far rings exactly as
 * badly as its near ones (see LEVEL_RES). The outer rings run the cheap vertex
 * path, so the extra triangles there are close to free.
 *
 * Beyond the geometry, the fragment program re-runs the same bicubic
 * reconstruction per pixel past ~400 m, so shading normals and terrain data
 * channels in the far field come from the field itself rather than from an
 * interpolated 25-100 m triangle.
 */
import * as THREE from 'three';
import { createSnowMaterial, getLattice, GLSL_LATTICE_NOISE } from './snow-material.js';

// --- macro heightmap ---------------------------------------------------------
const MAP_RES = 1024;          // texels per side
const MAP_EXT = 8192;          // metres covered
const MAP_STEP = MAP_EXT / MAP_RES;   // 8 m / texel
const MAP_ORIGIN = -MAP_EXT / 2;

// --- clipmap -----------------------------------------------------------------
// Per-level lattice resolution. A *uniform* ring resolution R gives every level
// the same angular cell size — 2/R rad at its outer edge and 4/R at its inner
// edge — which is the whole point of a clipmap, but it also means the coarse
// far rings facet exactly as badly as the fine near ones. At R=96 that worst
// case is 1/24 rad: seventy pixels of flat triangle, which is precisely the
// sawtooth you see along a 4 km skyline.
//
// So the resolution ramps with the level instead. It costs almost nothing where
// it matters: the outer rings run the *cheap* vertex path (the metre-scale
// detail layers have already faded out there), so they are pure bandwidth, and
// the near rings — which carry the expensive noise — stay at 96.
//
// Nesting constraint: hole(k) * cell(k) / 2 == extent(k-1), i.e. hole(k) must be
// res(k-1)/2 exactly, or the rings gap.
const LEVEL_RES = [96, 96, 128, 160, 192, 320, 384, 384, 384];
const CELL0 = 0.4;             // finest cell size, metres
const LEVELS = LEVEL_RES.length;
const LEVEL_HOLE = LEVEL_RES.map((_, k) => (k === 0 ? 0 : LEVEL_RES[k - 1] / 2));

// Prevailing wind, world XZ. Must match `uWindDir` in snow-material.js: the
// cornice displacement and the shader's wind-loading masks have to agree.
const WIND_X = 0.82, WIND_Z = 0.57;

// =============================================================================
// CPU noise — the exact twin of GLSL `latNoise` in snow-material.js
// =============================================================================
const LAT = getLattice().data;

function latFetch(ix, iy) {
  return LAT[((iy & 255) << 8) | (ix & 255)] * (1 / 255);
}

const _n3 = [0, 0, 0];
/** value in 0..1 plus d/dx, d/dy, written into `out`. */
function latNoise(x, y, out) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const a = latFetch(ix, iy);
  const b = latFetch(ix + 1, iy);
  const c = latFetch(ix, iy + 1);
  const d = latFetch(ix + 1, iy + 1);
  const k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  out[0] = a + k1 * ux + k2 * uy + k3 * ux * uy;
  out[1] = (k1 + k3 * uy) * dux;
  out[2] = (k2 + k3 * ux) * duy;
  return out;
}

/** Cheap scalar-only noise for the offline bake. */
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = latFetch(ix, iy), b = latFetch(ix + 1, iy);
  const c = latFetch(ix, iy + 1), d = latFetch(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

const RC = 0.8, RS = 0.6;      // per-octave rotation, kills axis alignment

function fbm(x, y, oct, gain = 0.5, lac = 2.03) {
  let s = 0, a = 1, nrm = 0;
  for (let i = 0; i < oct; i++) {
    s += a * (vnoise(x, y) * 2 - 1);
    nrm += a;
    const nx = (RC * x - RS * y) * lac, ny = (RS * x + RC * y) * lac;
    x = nx; y = ny; a *= gain;
  }
  return s / nrm;
}

/** Musgrave-flavoured ridged multifractal: sharp crests, smooth troughs. */
function ridgedMF(x, y, oct, gain = 0.52, lac = 2.07) {
  let s = 0, a = 1, w = 1, nrm = 0;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(vnoise(x, y) * 2 - 1);
    n *= n;
    n *= w;
    w = Math.min(1, n * 2.6);
    s += a * n;
    nrm += a;
    const nx = (RC * x - RS * y) * lac, ny = (RS * x + RC * y) * lac;
    x = nx; y = ny; a *= gain;
  }
  return s / nrm;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// =============================================================================
// The massif skeleton
// =============================================================================
const SUMMIT_X = 430, SUMMIT_Z = 2560;
const CONE_H = 1300, CONE_R = 4300, CONE_KX = 0.62;

/** Ridge polylines: [x, z, crestElevation] control points plus a flank width. */
const RIDGES = [
  // Summit crest, high above the start of the run.
  { w: 760, pts: [[-1400, 2150, 900], [-500, 2450, 1150], [430, 2600, 1300], [1350, 2400, 1120], [2100, 2000, 870]] },
  // West arete — the skier's right-hand wall, running down to the valley.
  { w: 620, pts: [[430, 2560, 1300], [-700, 2000, 1180], [-1150, 1300, 1000], [-1350, 500, 790], [-1520, -300, 480], [-1950, -1250, 300]] },
  // East arete — the skier's left-hand wall.
  { w: 640, pts: [[430, 2560, 1300], [1250, 2000, 1160], [1500, 1300, 990], [1620, 500, 780], [1800, -300, 470], [2250, -1250, 290]] },
  // Rock ribs flanking the piste, ~750 m out on each side. Narrow and steep so
  // the thermal-erosion pass leaves them standing at the repose angle, which is
  // exactly where the shader stops holding snow. These are what give the run
  // something to be *between*.
  { w: 130, pts: [[-780, 1450, 782], [-700, 1150, 712], [-660, 900, 652]] },
  { w: 130, pts: [[860, 1330, 762], [800, 1050, 692], [770, 830, 642]] },
  { w: 120, pts: [[-720, 330, 506], [-690, 90, 451], [-670, -140, 396]] },
  { w: 120, pts: [[820, 250, 481], [790, 10, 426], [770, -220, 373]] },
  { w: 105, pts: [[-560, 2000, 900], [-520, 1760, 840]] },
  { w: 105, pts: [[640, 1900, 872], [610, 1660, 815]] },
  // Inner ribs, right on the shoulder of the piste — close enough to the fall
  // line to sit inside the frame all the way down.
  { w: 95, pts: [[-520, 620, 549], [-495, 250, 447], [-480, -120, 363], [-500, -520, 270]] },
  { w: 95, pts: [[560, 560, 526], [540, 190, 432], [530, -180, 350], [550, -580, 258]] },
  { w: 88, pts: [[-430, 1500, 748], [-450, 1120, 660], [-470, 800, 588]] },
  { w: 88, pts: [[490, 1420, 726], [510, 1060, 646], [520, 760, 578]] },
  // Secondary spurs dropping into the bowl — these read as buttresses.
  { w: 300, pts: [[-1150, 1300, 990], [-780, 1080, 800], [-520, 900, 640]] },
  { w: 300, pts: [[1500, 1300, 980], [1080, 1000, 790], [800, 780, 640]] },
  { w: 280, pts: [[-1350, 500, 780], [-940, 340, 610], [-680, 210, 500]] },
  { w: 280, pts: [[1620, 500, 770], [1200, 330, 600], [930, 190, 490]] },
  // The range across the valley: what you look at all the way down. Kept low
  // and irregular — the summits themselves come from PEAKS, so the skyline is
  // a row of horns and cols rather than one flat-topped wall.
  { w: 760, pts: [[-3700, -2250, 560], [-2500, -2780, 720], [-1150, -3000, 610], [200, -3120, 760], [1500, -2900, 640], [2800, -2550, 700], [3700, -2250, 540]] },
  // Far background wall, right at the aerial-perspective limit.
  { w: 700, pts: [[-3400, -3380, 780], [-1300, -3560, 900], [900, -3500, 840], [3000, -3300, 760]] },
  // Low shoulders framing the run-out.
  { w: 700, pts: [[-2300, -700, 330], [-3000, -1700, 440], [-3500, -2350, 510]] },
  { w: 700, pts: [[2350, -800, 320], [3050, -1750, 420], [3550, -2300, 490]] },
  // Outliers so the mid distance is not empty.
  { w: 560, pts: [[-3200, 900, 680], [-3600, 1900, 820]] },
  { w: 560, pts: [[3100, 800, 640], [3550, 1750, 770]] },
];

/**
 * Individual summits. Ridges alone give flat-topped mesas; the horns that make
 * an alpine skyline read as alpine have to be placed as points.
 * [x, z, elevation, radius, sharpness]
 */
const PEAKS = [
  // Across the valley — the wall the player descends towards.
  [-2500, -2820, 1210, 900, 1.55], [-1050, -3020, 980, 720, 1.7],
  [250, -3150, 1345, 980, 1.5], [1600, -2900, 1075, 800, 1.65],
  [2900, -2560, 1190, 860, 1.55], [-3550, -2400, 900, 700, 1.7],
  // Far background horns.
  [-1300, -3560, 1490, 900, 1.45], [900, -3480, 1340, 820, 1.5],
  [2900, -3300, 1200, 780, 1.6], [-3100, -3400, 1250, 780, 1.6],
  // Shoulders on the flanks of the home mountain, for mid-distance interest.
  [-1180, 1290, 1060, 480, 1.8], [1520, 1310, 1040, 470, 1.8],
  [-1560, -320, 560, 430, 1.9], [1840, -330, 545, 430, 1.9],
  [-3300, 1500, 880, 620, 1.7], [3250, 1350, 840, 600, 1.7],
];

// Flatten to segments for a tight inner loop.
const SEGS = [];
for (const r of RIDGES) {
  for (let i = 0; i < r.pts.length - 1; i++) {
    const [x0, z0, h0] = r.pts[i];
    const [x1, z1, h1] = r.pts[i + 1];
    const dx = x1 - x0, dz = z1 - z0;
    SEGS.push({ x0, z0, h0, dx, dz, dh: h1 - h0, inv: 1 / (dx * dx + dz * dz), iw: 1 / r.w });
  }
}

/** Polynomial smooth-max: keeps ridge intersections from creasing. */
function smax(a, b, k) {
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/**
 * The massif. A single conical body centred on the summit gives the mountain
 * one unambiguous identity and one obvious fall line; the ridge network is
 * smooth-maxed on top of it to produce aretes, buttresses and the ranges
 * across the valley.
 */
function massif(x, z) {
  const dx = x - SUMMIT_X, dz = z - SUMMIT_Z;
  const r = Math.sqrt(CONE_KX * dx * dx + dz * dz);
  const u = clamp(1 - r / CONE_R, 0, 1);
  let env = CONE_H * u * u;

  for (let i = 0; i < SEGS.length; i++) {
    const s = SEGS[i];
    const px = x - s.x0, pz = z - s.z0;
    let t = (px * s.dx + pz * s.dz) * s.inv;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - s.dx * t, ez = pz - s.dz * t;
    const d = Math.sqrt(ex * ex + ez * ez) * s.iw;
    if (d >= 1) continue;
    const v = 1 - d;
    const c = (s.h0 + s.dh * t) * v * v * (v * 0.45 + 0.55);
    if (c > env - 150) env = smax(env, c, 150);
  }

  for (let i = 0; i < PEAKS.length; i++) {
    const p = PEAKS[i];
    const ex = x - p[0], ez = z - p[1];
    const d = Math.sqrt(ex * ex + ez * ez) / p[3];
    if (d >= 1) continue;
    const c = p[2] * Math.pow(1 - d, p[4]);
    if (c > env - 170) env = smax(env, c, 170);
  }
  return env;
}

// --- the fall line -----------------------------------------------------------
/** Corridor centreline: a lazy S so the run is never a straight ramp. */
function corridorX(z) {
  return 78 * Math.sin(z * 0.00092) + 34 * Math.sin(z * 0.00231 + 1.3);
}

// Elevation down the fall line, z descending. Reconstructed with monotone
// (Fritsch-Carlson) cubic Hermite: C1, and provably never flat or uphill, so
// the skier always has somewhere to go.
// Gradients are capped around 0.235 (13 deg). That is a real constraint, not a
// stylistic one: a groomed piste is the *mellowest* line down a face, and the
// drama has to come from the walls either side, not from the run itself.
const PROFILE = [
  [-4200, -60], [-2600, -35], [-1500, 20], [-900, 110], [-400, 218],
  [-100, 288], [200, 358], [800, 498], [1400, 640], [2000, 782], [2600, 924],
];
const PZ = PROFILE.map((p) => p[0]);
const PY = PROFILE.map((p) => p[1]);
const PM = (() => {
  const n = PZ.length;
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = (PY[i + 1] - PY[i]) / (PZ[i + 1] - PZ[i]);
  const m = new Array(n);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] + d[i]) * 0.5;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return m;
})();

function corridorElev(z) {
  const n = PZ.length;
  if (z <= PZ[0]) return PY[0];
  if (z >= PZ[n - 1]) return PY[n - 1] - (z - PZ[n - 1]) * 0.30;   // far side of the summit
  let i = 0;
  while (i < n - 2 && z > PZ[i + 1]) i++;
  const hh = PZ[i + 1] - PZ[i];
  const t = (z - PZ[i]) / hh;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * PY[i] + (t3 - 2 * t2 + t) * hh * PM[i]
    + (-2 * t3 + 3 * t2) * PY[i + 1] + (t3 - t2) * hh * PM[i + 1];
}

// =============================================================================
export class Terrain {
  constructor(opts = {}) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);

    this.size = MAP_EXT;
    this.field = new Float32Array(MAP_RES * MAP_RES * 4);
    this._bake();

    this.heightTex = new THREE.DataTexture(
      this.field, MAP_RES, MAP_RES, THREE.RGBAFormat, THREE.FloatType,
    );
    this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.minFilter = THREE.NearestFilter;
    this.heightTex.wrapS = THREE.ClampToEdgeWrapping;
    this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTex.generateMipmaps = false;
    this.heightTex.needsUpdate = true;

    this.uniforms = {
      uHeightTex: { value: this.heightTex },
      uMapInfo: { value: new THREE.Vector4(MAP_ORIGIN, 1 / MAP_STEP, MAP_RES, MAP_STEP) },
      uFocus: { value: new THREE.Vector3(0, 0, 0) },
    };

    this.material = createSnowMaterial({
      displacement: {
        uniforms: this.uniforms,
        prelude: GLSL_DISPLACE_PRELUDE,
        body: GLSL_DISPLACE_BODY,
        fragPrelude: GLSL_MACRO_RECON,
        fragRefine: GLSL_FRAG_REFINE,
      },
    });
    this.snowUniforms = this.material.userData.snowUniforms;
    this.depthMaterial = this.material.userData.createDepthMaterial();

    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this._buildClipmap();

    this._scratch = new THREE.Vector3();
    this._grad = { x: 0, y: 0 };
    this._center = new THREE.Vector2(NaN, NaN);
    this._time = 0;
    this._sun = null;

    this.buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    this.update(0, { pos: new THREE.Vector3(0, 0, 700) });
  }

  // ---------------------------------------------------------------- bake ----
  _bake() {
    const R = MAP_RES, F = this.field;
    const H = new Float32Array(R * R);

    // -- 1. skeleton + fractal ------------------------------------------------
    for (let j = 0; j < R; j++) {
      const z = MAP_ORIGIN + j * MAP_STEP;
      for (let i = 0; i < R; i++) {
        const x = MAP_ORIGIN + i * MAP_STEP;

        // Domain warp — stops the ridged noise from looking like a grid of tents.
        const wx = fbm(x * 0.00031, z * 0.00031, 3);
        const wz = fbm(x * 0.00031 + 41.7, z * 0.00031 - 17.3, 3);
        const qx = x + wx * 480, qz = z + wz * 480;

        const env = massif(x, z);
        const alt = env / 1300;

        const r = ridgedMF(qx * 0.00046, qz * 0.00046, 9);
        const b = fbm(qx * 0.00072, qz * 0.00072, 5);

        let h = 26 + env;
        h += (r - 0.30) * (115 + env * 0.58);      // secondary ridges + spurs
        h += b * (38 + env * 0.14);                // broad undulation
        // Mid band: this is what stops big faces reading as smooth ramps.
        h += (ridgedMF(qx * 0.0016, qz * 0.0016, 5) - 0.31) * (26 + 78 * alt);
        h += (ridgedMF(qx * 0.0058, qz * 0.0058, 3) - 0.31) * (11 + 34 * alt);
        h += (ridgedMF(qx * 0.0115, qz * 0.0115, 3) - 0.31) * (6 + 22 * alt);

        H[j * R + i] = h;
      }
    }

    // -- 2. thermal / talus relaxation ---------------------------------------
    // Material above the repose angle slides. This carves scree fans below the
    // cliffs and sharpens the aretes; the amount removed vs. deposited is the
    // most physically honest bedrock mask we can get for free.
    const strip = new Float32Array(R * R);
    const delta = new Float32Array(R * R);
    // A *uniform* repose angle is what makes naive thermal erosion produce
    // those tell-tale contour terraces: every face relaxes to exactly the same
    // gradient. Jittering it with a smooth noise field (harder bands of rock
    // hold steeper) keeps the scree fans but kills the staircase.
    const talus = new Float32Array(R * R);
    for (let j = 0; j < R; j++) {
      const z = MAP_ORIGIN + j * MAP_STEP;
      for (let i = 0; i < R; i++) {
        const x = MAP_ORIGIN + i * MAP_STEP;
        const t = fbm(x * 0.0021, z * 0.0021, 3) * 0.5 + fbm(x * 0.011, z * 0.011, 2) * 0.34;
        talus[j * R + i] = (0.82 + t * 0.62) * MAP_STEP;
      }
    }
    for (let it = 0; it < 7; it++) {
      delta.fill(0);
      for (let j = 1; j < R - 1; j++) {
        for (let i = 1; i < R - 1; i++) {
          const k = j * R + i, h0 = H[k], T = talus[k];
          let tot = 0, d0 = 0, d1 = 0, d2 = 0, d3 = 0;
          let d = h0 - H[k - 1]; if (d > T) { d0 = d - T; tot += d0; }
          d = h0 - H[k + 1]; if (d > T) { d1 = d - T; tot += d1; }
          d = h0 - H[k - R]; if (d > T) { d2 = d - T; tot += d2; }
          d = h0 - H[k + R]; if (d > T) { d3 = d - T; tot += d3; }
          if (tot <= 0) continue;
          const move = Math.min(tot * 0.30, (h0 - Math.min(H[k - 1], H[k + 1], H[k - R], H[k + R])) * 0.4);
          const s = move / tot;
          delta[k] -= move;
          delta[k - 1] += d0 * s; delta[k + 1] += d1 * s;
          delta[k - R] += d2 * s; delta[k + R] += d3 * s;
        }
      }
      for (let k = 0; k < R * R; k++) { H[k] += delta[k]; strip[k] -= delta[k]; }
    }

    // -- 3. flow accumulation + channel carve --------------------------------
    const flow = new Float32Array(R * R).fill(1);
    const order = this._sortDescending(H);
    const NB = [-1, 1, -R, R, -R - 1, -R + 1, R - 1, R + 1];
    const NBL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
    for (let o = 0; o < order.length; o++) {
      const k = order[o];
      const i = k % R, j = (k / R) | 0;
      if (i === 0 || j === 0 || i === R - 1 || j === R - 1) continue;
      let best = -1, bestS = 0;
      for (let n = 0; n < 8; n++) {
        const s = (H[k] - H[k + NB[n]]) / NBL[n];
        if (s > bestS) { bestS = s; best = k + NB[n]; }
      }
      if (best >= 0) flow[best] += flow[k];
    }
    let maxFlow = 1;
    for (let k = 0; k < R * R; k++) if (flow[k] > maxFlow) maxFlow = flow[k];
    const invLogMax = 1 / Math.log(maxFlow + 1);
    delta.fill(0);
    for (let j = 1; j < R - 1; j++) {
      for (let i = 1; i < R - 1; i++) {
        const k = j * R + i;
        const slope = Math.max(
          Math.abs(H[k + 1] - H[k - 1]),
          Math.abs(H[k + R] - H[k - R]),
        ) / (2 * MAP_STEP);
        delta[k] = -Math.min(38, 0.26 * Math.pow(flow[k], 0.45)) * clamp(slope * 2.4 - 0.10, 0.0, 1);
      }
    }
    // The channel carve leaves a stepped trench that has to be relaxed. A
    // *blanket* Laplacian relax is what turns every face into a smooth dome
    // though: four passes at 0.3 removes essentially all the 30-60 m structure,
    // which from three kilometres is exactly the band that reads as buttresses,
    // ribs and gullies. So the relaxation is weighted by how much each cell was
    // actually carved — the trenches get smoothed, the faces keep their bones.
    const relaxW = new Float32Array(R * R);
    for (let k = 0; k < R * R; k++) {
      H[k] += delta[k];
      relaxW[k] = clamp(-delta[k] * 0.28, 0.10, 1.0);
    }

    // -- 4. relax the carve, then a light smooth -----------------------------
    const relax2 = new Float32Array(R * R);
    for (let it = 0; it < 4; it++) {
      delta.fill(0);
      for (let j = 1; j < R - 1; j++) {
        for (let i = 1; i < R - 1; i++) {
          const k = j * R + i;
          delta[k] = (H[k - 1] + H[k + 1] + H[k - R] + H[k + R]) * 0.25 - H[k];
        }
      }
      // Blur the weight alongside, or the boundary between relaxed and
      // unrelaxed ground becomes a visible seam down the side of every gully.
      for (let j = 1; j < R - 1; j++) {
        for (let i = 1; i < R - 1; i++) {
          const k = j * R + i;
          relax2[k] = (relaxW[k] * 2 + relaxW[k - 1] + relaxW[k + 1]
            + relaxW[k - R] + relaxW[k + R]) * (1 / 6);
        }
      }
      relaxW.set(relax2);
      for (let k = 0; k < R * R; k++) H[k] += delta[k] * 0.30 * relaxW[k];
    }

    // -- 5. the piste --------------------------------------------------------
    for (let j = 0; j < R; j++) {
      const z = MAP_ORIGIN + j * MAP_STEP;
      const cx = corridorX(z);
      const base = corridorElev(z);
      for (let i = 0; i < R; i++) {
        const x = MAP_ORIGIN + i * MAP_STEP;
        const d = Math.abs(x - cx);
        const w = smoothstep(560, 200, d);
        if (w <= 0) continue;
        const bank = Math.min(62, (d / 260) * (d / 260) * 30);
        const roll = 2.4 * Math.sin(z * 0.0135 + x * 0.004) + 2.0 * Math.sin(x * 0.0125 - z * 0.007);
        // Fall-line ribs and gullies. Sampled with x compressed ~3x relative to
        // z so the features run *down* the slope: it is what a real face looks
        // like, and it keeps the descent gradient (which is what the chase
        // camera has to clear) almost untouched.
        const rib = (ridgedMF(x * 0.0058, z * 0.0017, 3) - 0.32) * 11
          + fbm(x * 0.0033, z * 0.0011, 3) * 6
          + (ridgedMF(x * 0.019, z * 0.0056, 2) - 0.32) * 3.2;
        const prof = base + bank + roll + rib;
        const k = j * R + i;
        H[k] = H[k] + (prof - H[k]) * w;
        strip[k] *= 1 - w * 0.85;
      }
    }

    // -- 6. taper to a plain at the map edge ---------------------------------
    for (let j = 0; j < R; j++) {
      const z = MAP_ORIGIN + j * MAP_STEP;
      for (let i = 0; i < R; i++) {
        const x = MAP_ORIGIN + i * MAP_STEP;
        const m = Math.max(Math.abs(x), Math.abs(z)) / (MAP_EXT * 0.5);
        const t = smoothstep(0.92, 1.0, m);
        if (t > 0) {
          const k = j * R + i;
          H[k] += (-42 - H[k]) * t;
        }
      }
    }

    // -- 7. pack channels ----------------------------------------------------
    // Curvature is measured over a 3-cell radius and smoothed; a raw Laplacian
    // at 8 m would just be noise, and the shader drives visible features off it.
    const curv = new Float32Array(R * R);
    const S = 3;
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const k = j * R + i;
        const im = Math.max(0, i - S), ip = Math.min(R - 1, i + S);
        const jm = Math.max(0, j - S), jp = Math.min(R - 1, j + S);
        const lap = H[j * R + im] + H[j * R + ip] + H[jm * R + i] + H[jp * R + i] - 4 * H[k];
        curv[k] = lap / (S * MAP_STEP);
      }
    }
    for (let it = 0; it < 2; it++) {
      for (let j = 1; j < R - 1; j++) {
        for (let i = 1; i < R - 1; i++) {
          const k = j * R + i;
          delta[k] = (curv[k - 1] + curv[k + 1] + curv[k - R] + curv[k + R]) * 0.25 - curv[k];
        }
      }
      for (let k = 0; k < R * R; k++) curv[k] += delta[k] * 0.6;
    }

    for (let k = 0; k < R * R; k++) {
      F[k * 4 + 0] = H[k];
      F[k * 4 + 1] = clamp(curv[k] * 0.55, -1.4, 1.4);
      F[k * 4 + 2] = Math.log(flow[k] + 1) * invLogMax;
      F[k * 4 + 3] = clamp(strip[k] * 0.09, -0.8, 1.0);
    }
  }

  /** Counting sort of cell indices by descending height. O(n). */
  _sortDescending(H) {
    const n = H.length;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < n; k++) { if (H[k] < lo) lo = H[k]; if (H[k] > hi) hi = H[k]; }
    const B = 4096;
    const scale = (B - 1) / Math.max(1e-6, hi - lo);
    const count = new Int32Array(B + 1);
    const bin = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const b = B - 1 - ((H[k] - lo) * scale) | 0;
      bin[k] = b < 0 ? 0 : b > B - 1 ? B - 1 : b;
      count[bin[k]]++;
    }
    let acc = 0;
    for (let b = 0; b < B; b++) { const c = count[b]; count[b] = acc; acc += c; }
    const out = new Int32Array(n);
    for (let k = 0; k < n; k++) out[count[bin[k]]++] = k;
    return out;
  }

  // ------------------------------------------------------------- sampling ---
  /**
   * Authoritative surface height. Catmull-Rom over the baked macro field plus
   * the same analytic micro detail the vertex shader adds. No allocation.
   */
  height(x, z) {
    return this._sample(x, z, false);
  }

  /**
   * Surface normal. Reuses an internal vector unless `out` is supplied — call
   * sites that keep the result past the current frame must pass their own.
   */
  normal(x, z, out) {
    // Two call conventions are in use and both are legitimate:
    //   normal(x, z, outVec3)  -> analytic gradient, written into the caller's vector
    //   normal(x, z, epsilon)  -> normal averaged over a footprint of that radius,
    //                             which is what the physics wants so metre-scale
    //                             noise does not jitter the skier's orientation.
    if (typeof out === 'number') {
      const e = out;
      const v = this._scratch;
      const hL = this.height(x - e, z), hR = this.height(x + e, z);
      const hD = this.height(x, z - e), hU = this.height(x, z + e);
      return v.set(hL - hR, 2 * e, hD - hU).normalize();
    }
    this._sample(x, z, true);
    const v = out || this._scratch;
    return v.set(-this._grad.x, 1, -this._grad.y).normalize();
  }

  /** Height and normal in one pass. Returns the height; writes `outNormal`. */
  sample(x, z, outNormal) {
    const h = this._sample(x, z, true);
    if (outNormal) outNormal.set(-this._grad.x, 1, -this._grad.y).normalize();
    return h;
  }

  _sample(x, z, wantGrad) {
    const F = this.field, R = MAP_RES;
    const qx = (x - MAP_ORIGIN) / MAP_STEP;
    const qz = (z - MAP_ORIGIN) / MAP_STEP;
    const ix = Math.floor(qx), iz = Math.floor(qz);
    const fx = qx - ix, fz = qz - iz;

    const fx2 = fx * fx, fx3 = fx2 * fx;
    const wx0 = -0.5 * fx3 + fx2 - 0.5 * fx;
    const wx1 = 1.5 * fx3 - 2.5 * fx2 + 1;
    const wx2 = -1.5 * fx3 + 2 * fx2 + 0.5 * fx;
    const wx3 = 0.5 * fx3 - 0.5 * fx2;
    const gx0 = -1.5 * fx2 + 2 * fx - 0.5;
    const gx1 = 4.5 * fx2 - 5 * fx;
    const gx2 = -4.5 * fx2 + 4 * fx + 0.5;
    const gx3 = 1.5 * fx2 - fx;

    const fz2 = fz * fz, fz3 = fz2 * fz;
    const wz = [
      -0.5 * fz3 + fz2 - 0.5 * fz,
      1.5 * fz3 - 2.5 * fz2 + 1,
      -1.5 * fz3 + 2 * fz2 + 0.5 * fz,
      0.5 * fz3 - 0.5 * fz2,
    ];
    const gz = [
      -1.5 * fz2 + 2 * fz - 0.5,
      4.5 * fz2 - 5 * fz,
      -4.5 * fz2 + 4 * fz + 0.5,
      1.5 * fz2 - fz,
    ];

    let h = 0, dx = 0, dz = 0;
    let cv = 0, cvx = 0, cvz = 0;
    for (let n = 0; n < 4; n++) {
      const jj = clamp(iz + n - 1, 0, R - 1);
      const row = jj * R;
      const c0 = clamp(ix - 1, 0, R - 1), c1 = clamp(ix, 0, R - 1);
      const c2 = clamp(ix + 1, 0, R - 1), c3 = clamp(ix + 2, 0, R - 1);
      const r0 = F[(row + c0) * 4], r1 = F[(row + c1) * 4];
      const r2 = F[(row + c2) * 4], r3 = F[(row + c3) * 4];
      const q0 = F[(row + c0) * 4 + 1], q1 = F[(row + c1) * 4 + 1];
      const q2 = F[(row + c2) * 4 + 1], q3 = F[(row + c3) * 4 + 1];
      const v = wx0 * r0 + wx1 * r1 + wx2 * r2 + wx3 * r3;
      const g = gx0 * r0 + gx1 * r1 + gx2 * r2 + gx3 * r3;
      const cq = wx0 * q0 + wx1 * q1 + wx2 * q2 + wx3 * q3;
      h += wz[n] * v;
      dx += wz[n] * g;
      dz += gz[n] * v;
      cv += wz[n] * cq;
      cvx += wz[n] * (gx0 * q0 + gx1 * q1 + gx2 * q2 + gx3 * q3);
      cvz += gz[n] * cq;
    }
    dx /= MAP_STEP; dz /= MAP_STEP;
    cvx /= MAP_STEP; cvz /= MAP_STEP;

    // ---- analytic micro detail (mirrors GLSL `terrMicro`) ----
    const slope = Math.sqrt(dx * dx + dz * dz);
    const rocky = smoothstep(0.62, 1.15, slope);
    const soft = 1 - rocky;

    let mh = 0, mgx = 0, mgy = 0;

    // Cornices and wind lips — the CPU twin of the block in GLSL_DISPLACE_BODY.
    // Gated to slopes past 24 degrees, which the piste corridor never reaches,
    // so the ski surface is untouched; but it has to be evaluated here anyway or
    // the physics surface and the rendered mesh would part company on the aretes.
    {
      const ct = clamp((-cv - 0.16) / 0.46, 0, 1);
      const ca = ct * ct * (3 - 2 * ct);
      const dca = 6 * ct * (1 - ct) / 0.46;
      const cb = smoothstep(0.45, 0.85, slope);
      if (ca * cb > 0.002) {
        const sc = latNoise(x * (1 / 70), z * (1 / 70), _n3);
        const scal = 0.55 + 0.9 * sc[0];
        const inv = 1 / Math.max(slope, 1e-4);
        const lee = clamp(-(dx * inv) * WIND_X - (dz * inv) * WIND_Z, 0, 1);
        const camp = -2.6 + 18 * lee * lee;
        mh += ca * cb * scal * camp;
        mgx += ((-dca * cvx * cb) * scal + (ca * cb) * 0.9 * sc[1] * (1 / 70)) * camp;
        mgy += ((-dca * cvz * cb) * scal + (ca * cb) * 0.9 * sc[2] * (1 / 70)) * camp;
      }
    }

    // rolling drift band
    {
      const amp = 2.2 * soft + 1.6 * rocky, f = 1 / 64;
      const r = this._fbmD(x * f, z * f, 4, 0.5);
      mh += r[0] * amp;
      mgx += r[1] * amp * f; mgy += r[2] * amp * f;
    }
    // hectometre ridged bands — the ones that survive to the horizon
    if (rocky > 0.002) {
      const amp = 24 * rocky, f = 1 / 200;
      const r = this._ridgedD(x * f, z * f, 2, 0.5);
      mh += (r[0] - 0.36) * amp;
      mgx += r[1] * amp * f; mgy += r[2] * amp * f;
      const amp2 = 7 * rocky, f2 = 1 / 85;
      const r2 = this._ridgedD(x * f2, z * f2, 1, 0.5);
      mh += (r2[0] - 0.33) * amp2;
      mgx += r2[1] * amp2 * f2; mgy += r2[2] * amp2 * f2;
    }
    // ridged rock ribs
    {
      const amp = 10.2 * rocky, f = 1 / 74;
      const r = this._ridgedD(x * f, z * f, 4, 0.52);
      mh += (r[0] - 0.33) * amp;
      mgx += r[1] * amp * f; mgy += r[2] * amp * f;
    }
    // moguls / rollers
    {
      const gate = smoothstep(0.16, 0.34, slope) * smoothstep(1.05, 0.62, slope) * soft;
      const amp = 0.28 * gate;
      if (amp > 1e-4) {
        const f = 0.055;
        const n1 = latNoise(x * f, z * f, _n3);
        const a1 = n1[0] * 2 - 1, a1x = n1[1] * 2 * f, a1y = n1[2] * 2 * f;
        const n2 = latNoise(x * f + 37.2, z * f + 11.7, this._n2 || (this._n2 = [0, 0, 0]));
        const a2 = n2[0] * 2 - 1, a2x = n2[1] * 2 * f, a2y = n2[2] * 2 * f;
        const kx = 0.92, kz = 0.72, cw = 0.94, sw = 0.34;
        const A = (x * cw + z * sw) * kx + 1.4 * a1;
        const B = (-x * sw + z * cw) * kz + 1.4 * a2;
        const Ax = cw * kx + 1.4 * a1x, Ay = sw * kx + 1.4 * a1y;
        const Bx = -sw * kz + 1.4 * a2x, By = cw * kz + 1.4 * a2y;
        const sA = Math.sin(A), cA = Math.cos(A), sB = Math.sin(B), cB = Math.cos(B);
        mh += sA * sB * amp;
        mgx += (cA * sB * Ax + sA * cB * Bx) * amp;
        mgy += (cA * sB * Ay + sA * cB * By) * amp;
      }
    }

    if (wantGrad) { this._grad.x = dx + mgx; this._grad.y = dz + mgy; }
    return h + mh;
  }

  _fbmD(x, y, oct, gain) {
    const out = this._fbmOut || (this._fbmOut = [0, 0, 0]);
    let s = 0, a = 1, nrm = 0, gx = 0, gy = 0;
    let jxx = 1, jxy = 0, jyx = 0, jyy = 1;
    const LACR = 2.07;
    const tmp = this._tmpN || (this._tmpN = [0, 0, 0]);
    for (let i = 0; i < oct; i++) {
      latNoise(x, y, tmp);
      s += a * (tmp[0] * 2 - 1);
      gx += a * 2 * (tmp[1] * jxx + tmp[2] * jyx);
      gy += a * 2 * (tmp[1] * jxy + tmp[2] * jyy);
      nrm += a;
      const nxx = LACR * (RC * jxx - RS * jyx), nxy = LACR * (RC * jxy - RS * jyy);
      const nyx = LACR * (RS * jxx + RC * jyx), nyy = LACR * (RS * jxy + RC * jyy);
      jxx = nxx; jxy = nxy; jyx = nyx; jyy = nyy;
      const nx = (RC * x - RS * y) * LACR, ny = (RS * x + RC * y) * LACR;
      x = nx; y = ny; a *= gain;
    }
    out[0] = s / nrm; out[1] = gx / nrm; out[2] = gy / nrm;
    return out;
  }

  _ridgedD(x, y, oct, gain) {
    const out = this._ridOut || (this._ridOut = [0, 0, 0]);
    let s = 0, a = 1, nrm = 0, gx = 0, gy = 0;
    let jxx = 1, jxy = 0, jyx = 0, jyy = 1;
    const LACR = 2.07;
    const tmp = this._tmpR || (this._tmpR = [0, 0, 0]);
    for (let i = 0; i < oct; i++) {
      latNoise(x, y, tmp);
      const v = tmp[0] * 2 - 1;
      const sgn = v < 0 ? -1 : 1;
      const r = 1 - Math.abs(v);
      const dr = -2 * r * sgn * 2;              // d(r^2)/d(noise)
      s += a * r * r;
      gx += a * dr * (tmp[1] * jxx + tmp[2] * jyx);
      gy += a * dr * (tmp[1] * jxy + tmp[2] * jyy);
      nrm += a;
      const nxx = LACR * (RC * jxx - RS * jyx), nxy = LACR * (RC * jxy - RS * jyy);
      const nyx = LACR * (RS * jxx + RC * jyx), nyy = LACR * (RS * jxy + RC * jyy);
      jxx = nxx; jxy = nxy; jyx = nyx; jyy = nyy;
      const nx = (RC * x - RS * y) * LACR, ny = (RS * x + RC * y) * LACR;
      x = nx; y = ny; a *= gain;
    }
    out[0] = s / nrm; out[1] = gx / nrm; out[2] = gy / nrm;
    return out;
  }

  // --------------------------------------------------------------- clipmap --
  _buildClipmap() {
    this.levels = [];
    const cache = new Map();
    for (let k = 0; k < LEVELS; k++) {
      const cell = CELL0 * Math.pow(2, k);
      const res = LEVEL_RES[k], hole = LEVEL_HOLE[k];
      const key = res + ':' + hole;
      let geo = cache.get(key);
      if (!geo) { geo = buildLevelGeometry(res, hole); cache.set(key, geo); }
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.customDepthMaterial = this.depthMaterial;
      mesh.scale.set(cell, 1, cell);
      mesh.frustumCulled = false;
      // Only the rings that actually fall inside the sun-shadow frustum take
      // part in shadowing. That box is ±95 m around the skier (see sky.js), so
      // level 4 — whose outer edge is 614 m out — is already generous margin.
      // Every ring past it would just be a few hundred thousand triangles
      // rasterised into a depth map they cannot possibly intersect.
      const inShadowRange = k <= 4;
      mesh.receiveShadow = k <= 6;
      mesh.castShadow = inShadowRange;
      mesh.renderOrder = -10 + k;
      mesh.name = 'terrain-lod' + k;
      this.group.add(mesh);
      this.levels.push({ mesh, cell });
    }
  }

  /** Recentre the clipmap. Cheap: only model matrices change. */
  update(dt, state) {
    this._time += dt || 0;
    const p = state?.pos;
    const fx = p ? p.x : 0, fz = p ? p.z : 0;
    const snap = CELL0 * 2;
    const cx = Math.round(fx / snap) * snap;
    const cz = Math.round(fz / snap) * snap;
    if (cx !== this._center.x || cz !== this._center.y) {
      this._center.set(cx, cz);
      for (const l of this.levels) l.mesh.position.set(cx, 0, cz);
    }
    this.uniforms.uFocus.value.set(fx, p ? p.y : 0, fz);

    const u = this.snowUniforms;
    u.uTime.value = this._time;

    // Track whatever the sky module is doing, without touching it.
    const scene = this.group.parent;
    if (scene) {
      if (!this._sun || !this._sun.parent) {
        this._sun = null;
        scene.traverse((o) => { if (!this._sun && o.isDirectionalLight) this._sun = o; });
      }
      if (this._sun) u.uSunDirW.value.copy(this._sun.position).normalize();
      if (scene.fog) {
        u.uAerialColor.value.copy(scene.fog.color).convertSRGBToLinear();
        u.uAerialSun.value.copy(u.uAerialColor.value).lerp(
          _WARM.set(1.0, 0.92, 0.78), 0.55,
        );
        if (scene.fog.isFogExp2) {
          // Soften: uniform exp2 fog erases the far peaks entirely. Ours falls
          // off with altitude so summits stay readable.
          u.uAerialDensity.value = scene.fog.density * 0.52;
        }
      }
    }
  }

  dispose() {
    this.heightTex.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    const seen = new Set();
    for (const l of this.levels) {
      if (seen.has(l.mesh.geometry)) continue;
      seen.add(l.mesh.geometry);
      l.mesh.geometry.dispose();
    }
  }
}

const _WARM = new THREE.Color();

// =============================================================================
// Clipmap level geometry: unit lattice in XZ, optional square hole, plus a
// downward skirt around the outer edge that hides the hairline T-junctions
// between neighbouring LOD levels.
// =============================================================================
function buildLevelGeometry(res, hole) {
  const lo = (res - hole) / 2, hi = (res + hole) / 2;
  const idxOf = new Int32Array((res + 1) * (res + 1)).fill(-1);
  const pos = [], skirt = [], index = [];

  const vert = (i, j, s) => {
    if (s === 0) {
      const key = j * (res + 1) + i;
      if (idxOf[key] >= 0) return idxOf[key];
      idxOf[key] = pos.length / 3;
    }
    pos.push(i - res / 2, 0, j - res / 2);
    skirt.push(s);
    return pos.length / 3 - 1;
  };

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      if (hole > 0 && i >= lo && i < hi && j >= lo && j < hi) continue;
      const a = vert(i, j, 0), b = vert(i + 1, j, 0);
      const c = vert(i + 1, j + 1, 0), d = vert(i, j + 1, 0);
      index.push(a, d, c, a, c, b);
    }
  }

  // Outer skirt. Emitted double-sided (it is viewed from inside the ring on the
  // near side and outside on the far side) — a few hundred triangles, no cost.
  const loop = [];
  for (let i = 0; i < res; i++) loop.push([i, 0]);
  for (let j = 0; j < res; j++) loop.push([res, j]);
  for (let i = res; i > 0; i--) loop.push([i, res]);
  for (let j = res; j > 0; j--) loop.push([0, j]);
  for (let n = 0; n < loop.length; n++) {
    const [i0, j0] = loop[n];
    const [i1, j1] = loop[(n + 1) % loop.length];
    const t0 = vert(i0, j0, 0), t1 = vert(i1, j1, 0);
    const b0 = vert(i0, j0, 1), b1 = vert(i1, j1, 1);
    index.push(t0, b0, b1, t0, b1, t1);
    index.push(t0, b1, b0, t0, t1, b1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  geo.setAttribute('aSkirt', new THREE.Float32BufferAttribute(skirt, 1));
  geo.setIndex(index);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), res * 4);
  return geo;
}

// =============================================================================
// GPU side of the surface function. Line-for-line the twin of `_sample` above.
// =============================================================================
// Shared by the vertex program (displacement) and the fragment program (far
// field shading normals) — both have to read exactly the same surface.
const GLSL_MACRO_RECON = /* glsl */`
uniform sampler2D uHeightTex;
uniform vec4 uMapInfo;     // origin, 1/step, resolution, step
uniform vec3 uFocus;

const float TRC = 0.8, TRS = 0.6, TLAC = 2.07;

vec4 terrTexel( ivec2 c ) {
  return texelFetch( uHeightTex, clamp( c, ivec2( 0 ), ivec2( int( uMapInfo.z ) - 1 ) ), 0 );
}

// Catmull-Rom bicubic with analytic first derivatives. 'grad' is the gradient of
// the height channel; 'cgrad' that of the curvature channel, which the cornice
// term needs and which costs four extra MACs, not another texel fetch.
void terrMacro( vec2 p, out vec4 data, out vec2 grad, out vec2 cgrad ) {
  vec2 q = ( p - vec2( uMapInfo.x ) ) * uMapInfo.y;
  vec2 i = floor( q );
  vec2 f = q - i;

  vec2 f2 = f * f, f3 = f2 * f;
  vec4 wx = vec4( -0.5 * f3.x + f2.x - 0.5 * f.x,
                   1.5 * f3.x - 2.5 * f2.x + 1.0,
                  -1.5 * f3.x + 2.0 * f2.x + 0.5 * f.x,
                   0.5 * f3.x - 0.5 * f2.x );
  vec4 gx = vec4( -1.5 * f2.x + 2.0 * f.x - 0.5,
                   4.5 * f2.x - 5.0 * f.x,
                  -4.5 * f2.x + 4.0 * f.x + 0.5,
                   1.5 * f2.x - f.x );
  vec4 wy = vec4( -0.5 * f3.y + f2.y - 0.5 * f.y,
                   1.5 * f3.y - 2.5 * f2.y + 1.0,
                  -1.5 * f3.y + 2.0 * f2.y + 0.5 * f.y,
                   0.5 * f3.y - 0.5 * f2.y );
  vec4 gy = vec4( -1.5 * f2.y + 2.0 * f.y - 0.5,
                   4.5 * f2.y - 5.0 * f.y,
                  -4.5 * f2.y + 4.0 * f.y + 0.5,
                   1.5 * f2.y - f.y );

  ivec2 b = ivec2( i ) - 1;
  data = vec4( 0.0 );
  float dhx = 0.0, dhy = 0.0, dcx = 0.0, dcy = 0.0;
  for ( int n = 0; n < 4; n ++ ) {
    vec4 t0 = terrTexel( b + ivec2( 0, n ) );
    vec4 t1 = terrTexel( b + ivec2( 1, n ) );
    vec4 t2 = terrTexel( b + ivec2( 2, n ) );
    vec4 t3 = terrTexel( b + ivec2( 3, n ) );
    vec4 rowV = wx.x * t0 + wx.y * t1 + wx.z * t2 + wx.w * t3;
    float rowD = gx.x * t0.x + gx.y * t1.x + gx.z * t2.x + gx.w * t3.x;
    float rowC = gx.x * t0.y + gx.y * t1.y + gx.z * t2.y + gx.w * t3.y;
    data += wy[ n ] * rowV;
    dhx  += wy[ n ] * rowD;
    dhy  += gy[ n ] * rowV.x;
    dcx  += wy[ n ] * rowC;
    dcy  += gy[ n ] * rowV.y;
  }
  grad  = vec2( dhx, dhy ) * uMapInfo.y;
  cgrad = vec2( dcx, dcy ) * uMapInfo.y;
}

vec3 terrFbmD( vec2 p, int oct, float gain ) {
  float s = 0.0, a = 1.0, nrm = 0.0;
  float jxx = 1.0, jxy = 0.0, jyx = 0.0, jyy = 1.0;
  vec2 g = vec2( 0.0 );
  for ( int i = 0; i < 4; i ++ ) {
    if ( i >= oct ) break;
    vec3 n = latNoise( p );
    s += a * ( n.x * 2.0 - 1.0 );
    g.x += a * 2.0 * ( n.y * jxx + n.z * jyx );
    g.y += a * 2.0 * ( n.y * jxy + n.z * jyy );
    nrm += a;
    float nxx = TLAC * ( TRC * jxx - TRS * jyx ), nxy = TLAC * ( TRC * jxy - TRS * jyy );
    float nyx = TLAC * ( TRS * jxx + TRC * jyx ), nyy = TLAC * ( TRS * jxy + TRC * jyy );
    jxx = nxx; jxy = nxy; jyx = nyx; jyy = nyy;
    p = vec2( TRC * p.x - TRS * p.y, TRS * p.x + TRC * p.y ) * TLAC;
    a *= gain;
  }
  return vec3( s / nrm, g / nrm );
}

vec3 terrRidgedD( vec2 p, int oct, float gain ) {
  float s = 0.0, a = 1.0, nrm = 0.0;
  float jxx = 1.0, jxy = 0.0, jyx = 0.0, jyy = 1.0;
  vec2 g = vec2( 0.0 );
  for ( int i = 0; i < 4; i ++ ) {
    if ( i >= oct ) break;
    vec3 n = latNoise( p );
    float v = n.x * 2.0 - 1.0;
    float sgn = v < 0.0 ? -1.0 : 1.0;
    float r = 1.0 - abs( v );
    float dr = -4.0 * r * sgn;
    s += a * r * r;
    g.x += a * dr * ( n.y * jxx + n.z * jyx );
    g.y += a * dr * ( n.y * jxy + n.z * jyy );
    nrm += a;
    float nxx = TLAC * ( TRC * jxx - TRS * jyx ), nxy = TLAC * ( TRC * jxy - TRS * jyy );
    float nyx = TLAC * ( TRS * jxx + TRC * jyx ), nyy = TLAC * ( TRS * jxy + TRC * jyy );
    jxx = nxx; jxy = nxy; jyx = nyx; jyy = nyy;
    p = vec2( TRC * p.x - TRS * p.y, TRS * p.x + TRC * p.y ) * TLAC;
    a *= gain;
  }
  return vec3( s / nrm, g / nrm );
}
`;

// Fragment side. The far rings are 25-100 m per cell, so both the interpolated
// normal and the interpolated data channels are smeared across triangles the
// size of a city block: ridges shade as flat facets and the snowline snaps to
// triangle edges. Re-running the *same* reconstruction per pixel decouples
// shading from tessellation entirely — the silhouette is still polygonal, but
// nothing inside it is.
const GLSL_FRAG_REFINE = /* glsl */`
{
  float mMix = smoothstep( 240.0, 620.0, snViewDist );
  if ( mMix > 0.003 ) {
    vec4 md; vec2 mg, mc;
    terrMacro( P.xz, md, mg, mc );
    vec2 mMacroG = mg;                       // macro-only: the masks are keyed on it
    float mslope = length( mg );
    float mrocky = smoothstep( 0.62, 1.15, mslope );

    // The same two geometric detail bands the vertex program displaces by. They
    // have to be here too, or the per-pixel normal would be *smoother* than the
    // mesh it is shading — the opposite error, and every bit as visible on a
    // rock face as the facets were.
    float mfd = distance( P.xz, uFocus.xz );
    if ( mrocky > 0.002 ) {
      mg += terrRidgedD( P.xz * ( 1.0 / 200.0 ), 2, 0.5 ).yz * ( 24.0 * mrocky / 200.0 );
      float fC = smoothstep( 5000.0, 3000.0, mfd );
      if ( fC > 0.004 ) {
        mg += terrRidgedD( P.xz * ( 1.0 / 85.0 ), 1, 0.5 ).yz * ( 7.0 * mrocky * fC / 85.0 );
      }
    }
    float fA = smoothstep( 2400.0, 1200.0, mfd );
    float fB = smoothstep( 1900.0,  900.0, mfd );
    if ( fA > 0.004 ) {
      float amp = ( 2.2 * ( 1.0 - mrocky ) + 1.6 * mrocky ) * fA * ( 1.0 / 64.0 );
      mg += terrFbmD( P.xz * ( 1.0 / 64.0 ), 4, 0.5 ).yz * amp;
    }
    if ( fB > 0.004 && mrocky > 0.004 ) {
      float amp = 11.5 * mrocky * fB * ( 1.0 / 58.0 );
      mg += terrRidgedD( P.xz * ( 1.0 / 58.0 ), 4, 0.52 ).yz * amp;
    }

    float mSteep = atan( length( mg ) );
    // Cornice lip — the vertex program's twin, evaluated per pixel so the lit
    // edge of the lip stays sharp however coarse the mesh under it is.
    float ct = clamp( ( -md.y - 0.16 ) / 0.46, 0.0, 1.0 );
    float ca = ct * ct * ( 3.0 - 2.0 * ct );
    float dca = 6.0 * ct * ( 1.0 - ct ) / 0.46;
    float cb = smoothstep( 0.45, 0.85, mslope );
    float cornAmt = 0.0;
    if ( ca * cb > 0.002 ) {
      vec3 sc = latNoise( P.xz * ( 1.0 / 70.0 ) );
      float scal = 0.55 + 0.9 * sc.x;
      float lee = clamp( dot( -mMacroG / max( mslope, 1e-4 ), vec2( ${WIND_X}, ${WIND_Z} ) ), 0.0, 1.0 );
      float camp = -2.6 + 18.0 * lee * lee;
      mg += ( ( -dca * mc * cb ) * scal + ( ca * cb ) * 0.9 * sc.yz * ( 1.0 / 70.0 ) ) * camp;
      cornAmt = ca * cb * scal * lee;
    }
    vec3 mn = normalize( vec3( -mg.x, 1.0, -mg.y ) );
    Ng = normalize( mix( Ng, mn, mMix ) );
    snData = mix( snData, vec4( mSteep, md.y, md.z, md.w - cornAmt * 1.6 ), mMix );
  }
}
`;

const GLSL_DISPLACE_PRELUDE = /* glsl */`
attribute float aSkirt;
${GLSL_MACRO_RECON}
`;

const GLSL_DISPLACE_BODY = /* glsl */`
{
  vec2 P = wpos.xz;
  vec4 mdata; vec2 mgrad, mcgrad;
  terrMacro( P, mdata, mgrad, mcgrad );

  float slope = length( mgrad );
  float rocky = smoothstep( 0.62, 1.15, slope );
  float soft  = 1.0 - rocky;

  // Detail fades with distance from the player, never from the camera — the
  // shadow pass renders from the sun and must agree with the beauty pass.
  // The cut-offs sit where the ring cell size stops being able to carry the
  // band; the resolution ramp in LEVEL_RES halved the cell size at every
  // distance, so they moved out with it.
  float fd = distance( P, uFocus.xz );
  float fadeA = smoothstep( 2400.0, 1200.0, fd );
  float fadeB = smoothstep( 1900.0, 900.0, fd );
  float fadeM = smoothstep(  300.0,  110.0, fd );

  float h = mdata.x;
  vec2 g = mgrad;

  // Two ridged bands that outlive everything else. Deliberately low frequency —
  // 200 m is still four cells across on the outermost ring — so they survive all
  // the way to the horizon without aliasing, and they are the only geometry
  // keeping a 3 km face from being a smooth dome once the thermal erosion in the
  // bake has relaxed it and the metre-scale bands have gone.
  if ( rocky > 0.002 ) {
    float amp = 24.0 * rocky, f = 1.0 / 200.0;
    vec3 r = terrRidgedD( P * f, 2, 0.5 );
    h += ( r.x - 0.36 ) * amp;
    g += r.yz * amp * f;
    float fC = smoothstep( 5000.0, 3000.0, fd );
    if ( fC > 0.004 ) {
      float amp2 = 7.0 * rocky * fC, f2 = 1.0 / 85.0;
      vec3 r2 = terrRidgedD( P * f2, 1, 0.5 );
      h += ( r2.x - 0.33 ) * amp2;
      g += r2.yz * amp2 * f2;
    }
  }

  // --- cornices and wind lips ------------------------------------------------
  // Curvature is negative where the ground is convex, so -mdata.y peaks exactly
  // along the crest of an arete. Spindrift blown over that lip settles on the
  // lee side and stands there as a cornice; the windward side gets scoured back.
  // Scalloped with a 70 m noise so the lip waves along the crest the way a real
  // one does instead of reading as a chamfer.
  // Held back until after coarseSteep is taken: a cornice is snow standing on
  // a steep face, and folding it into the slope that drives the rock mask would
  // paint the one feature that is always white as bedrock.
  float cornH = 0.0, cornAmt = 0.0;
  vec2 cornG = vec2( 0.0 );
  {
    float ct = clamp( ( -mdata.y - 0.16 ) / 0.46, 0.0, 1.0 );
    float ca = ct * ct * ( 3.0 - 2.0 * ct );
    float dca = 6.0 * ct * ( 1.0 - ct ) / 0.46;
    float cb = smoothstep( 0.45, 0.85, slope );   // steep ground only; the piste is concave and mellow
    if ( ca * cb > 0.002 ) {
      vec3 sc = latNoise( P * ( 1.0 / 70.0 ) );
      float scal = 0.55 + 0.9 * sc.x;
      float lee = clamp( dot( -mgrad / max( slope, 1e-4 ), vec2( ${WIND_X}, ${WIND_Z} ) ), 0.0, 1.0 );
      float camp = -2.6 + 18.0 * lee * lee;
      cornH = ca * cb * scal * camp;
      cornG = ( ( -dca * mcgrad * cb ) * scal + ( ca * cb ) * 0.9 * sc.yz * ( 1.0 / 70.0 ) ) * camp;
      cornAmt = ca * cb * scal * lee;
    }
  }

  if ( fadeA > 0.002 ) {
    float amp = ( 2.2 * soft + 1.6 * rocky ) * fadeA;
    float f = 1.0 / 64.0;
    vec3 r = terrFbmD( P * f, 4, 0.5 );
    h += r.x * amp;
    g += r.yz * amp * f;
  }
  if ( fadeB > 0.002 && rocky > 0.002 ) {
    float amp = 11.5 * rocky * fadeB;
    float f = 1.0 / 58.0;
    vec3 r = terrRidgedD( P * f, 4, 0.52 );
    h += ( r.x - 0.33 ) * amp;
    g += r.yz * amp * f;
  }
  // Slope used for the rock blend. Deliberately excludes the metre-scale
  // detail: a mask keyed on the full normal snaps to LOD triangle edges,
  // because per-vertex normals are only linearly interpolated across a face.
  float coarseSteep = atan( length( g ) );
  h += cornH;
  g += cornG;
  if ( fadeM > 0.002 ) {
    float gate = smoothstep( 0.16, 0.34, slope ) * smoothstep( 1.05, 0.62, slope ) * soft;
    float amp = 0.28 * gate * fadeM;
    if ( amp > 1e-4 ) {
      float f = 0.055;
      vec3 n1 = latNoise( P * f );
      vec3 n2 = latNoise( P * f + vec2( 37.2, 11.7 ) );
      float a1 = n1.x * 2.0 - 1.0, a1x = n1.y * 2.0 * f, a1y = n1.z * 2.0 * f;
      float a2 = n2.x * 2.0 - 1.0, a2x = n2.y * 2.0 * f, a2y = n2.z * 2.0 * f;
      const float kx = 0.92, kz = 0.72, cw = 0.94, sw = 0.34;
      float A = ( P.x * cw + P.y * sw ) * kx + 1.4 * a1;
      float B = ( -P.x * sw + P.y * cw ) * kz + 1.4 * a2;
      float Ax = cw * kx + 1.4 * a1x, Ay = sw * kx + 1.4 * a1y;
      float Bx = -sw * kz + 1.4 * a2x, By = cw * kz + 1.4 * a2y;
      float sA = sin( A ), cA = cos( A ), sB = sin( B ), cB = cos( B );
      h += sA * sB * amp;
      g += vec2( cA * sB * Ax + sA * cB * Bx, cA * sB * Ay + sA * cB * By ) * amp;
    }
  }

  dspH = h;
  dspN = normalize( vec3( -g.x, 1.0, -g.y ) );
  // Rock-exposure channel is pulled negative under a cornice so the shader's
  // talus threshold rises there and the lip stays white.
  dspD = vec4( coarseSteep, mdata.y, mdata.z, mdata.w - cornAmt * 1.6 );
  // LOD skirt. Only has to swallow the sub-cell reconstruction difference
  // between neighbouring levels, so it is kept to about one cell: a deep skirt
  // on a 100 m coarse level hangs hundreds of metres and pokes out of the
  // mountainside as a bright sliver.
  dspSkirt = aSkirt * modelMatrix[ 0 ].x * ( 0.8 + 1.6 * min( length( g ), 1.5 ) );
}
`;
