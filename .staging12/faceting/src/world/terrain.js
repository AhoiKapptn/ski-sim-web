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
 * interpolated 25-100 m triangle. Its detail bands are gated on the *world size
 * of a pixel*, not on distance: the vertex program has to retire a band when the
 * mesh can no longer carry it, the fragment program only has to keep it above
 * Nyquist, and conflating the two is what left a 4 km face with nothing on it.
 *
 * Background
 * ----------
 * Outside the 8.2 km baked square the texture can only replicate its edge texel
 * — a -42 m plain running to the 19.7 km clipmap limit, which read as a hard
 * bright band across the horizon. Past 3.6 km the surface is an analytic ridged
 * field instead (`terrBackdrop` / the twin block in `_sample`), blended in over
 * 3.4 km, so the skyline recedes into further ranges.
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
// The outer three rings run at 512, not 384. Those are the levels that draw
// everything past two kilometres, i.e. the entire skyline, and at 384 their
// cells are 25-100 m: a 4 km peak was being silhouetted by ~6 px triangles and
// its crest came out as a run of smooth chords. 512 takes that to 19-77 m and
// visibly serrates the ridgelines; measured cost at 1600x900 was nil (60.3 fps
// against 60.0), because these rings take the cheap vertex path and are
// bandwidth, not shading.
//
// Nesting constraint: hole(k) * cell(k) / 2 == extent(k-1), i.e. hole(k) must be
// res(k-1)/2 exactly, or the rings gap.
const LEVEL_RES = [96, 96, 128, 160, 192, 320, 512, 512, 512];
const CELL0 = 0.4;             // finest cell size, metres
const LEVELS = LEVEL_RES.length;
const LEVEL_HOLE = LEVEL_RES.map((_, k) => (k === 0 ? 0 : LEVEL_RES[k - 1] / 2));

// Prevailing wind, world XZ. Must match `uWindDir` in snow-material.js: the
// cornice displacement and the shader's wind-loading masks have to agree.
const WIND_X = 0.82, WIND_Z = 0.57;

// --- background ranges -------------------------------------------------------
// The baked field covers 8.2 km and clamps to a -42 m plain outside it, but the
// clipmap reaches 19.7 km. Everything between the two was a dead-flat white
// table: the hard, perfectly horizontal bright band that showed through every
// gap in the skyline. Past BD_IN the surface is an analytic ridged field
// instead, blended in over 3.4 km, carrying the skyline out into successive
// snow ranges. Evaluated identically on CPU and GPU, so `height()` still agrees
// with the mesh out there.
// --- cliff structure ---------------------------------------------------------
// Why a separate detail family exists for steep ground at all.
//
// A heightfield hides detail on exactly the ground that needs it most. The
// surface normal is `normalize(-hx, 1, -hz)`, so the angle it makes with the
// vertical is `atan(|g|)` and the *sensitivity* of that angle to an added
// gradient is `1/(1+|g|^2)`. A wall at 55 degrees has |g| = 1.43, i.e. a third
// of the response of a 25-degree slope; at 65 degrees it is a fifth. Every
// detail band in this file is authored at an amplitude that reads correctly on
// moderate ground, and therefore reads as almost nothing on a cliff.
//
// Worse, what *does* survive is biased. A perturbation of the cross-slope
// derivative rotates the normal by `d/(|g|.sqrt(1+g^2))` while the same
// perturbation down the fall line rotates it by `d/(1+g^2)` — nearly twice as
// much for the cross-slope one, and cross-slope variation is what draws a
// *vertical* line on screen. On top of that, plan-view foreshortening stretches
// any plan-isotropic feature by tan(alpha) in screen height: a 20 m blob on a
// 70-degree face renders 20 m wide and 55 m tall. Every band in this file is
// plan-isotropic, so a steep face necessarily combs itself into vertical
// striae, unbroken from crest to valley floor. That is the drape. It is not the
// flow carve and it is not the relax weight — both were retuned with no
// measurable change to the fall-line autocorrelation (0.65/0.50/0.40/0.26
// before, 0.64/0.48/0.37/0.20 after) — it is geometric, and it needs a detail
// family that is anisotropic *in screen space*, not in plan.
//
// The trick that gets that for free: sample the noise in a domain whose second
// axis is the *elevation* rather than a second horizontal coordinate. On any
// steep face elevation is screen-vertical and the remaining horizontal axis is
// screen-horizontal, so the feature aspect ratio is controlled directly in the
// image, with no orientation field to swirl at the crests, and features wrap
// the mountain at constant elevation — which is what strata do. Its gradient is
// analytic: d/dp of h is just the macro gradient we already hold.
//
// Three members, all evaluated in that domain:
//   benches  — a bedding stack with a sharp riser and a back-sloping terrace.
//              Two derivative discontinuities per bed: the outcrop line at the
//              foot of the riser and the lip at the top. Ledges are what
//              terminate a gully, and a terminated gully cannot correlate at
//              lag 64.
//   ribs     — contour-parallel lineation, 86 m along strike by 24 m of relief.
//   joints   — a conjugate pair of fracture sets at roughly +-47 degrees to the
//              horizontal on the face. Not down the fall line and not across
//              it, which is the one thing the existing bands cannot produce.
// None of the three needs an explicit slope-compensation gain, and the first
// version of this had one — capped at 3.2x, which on the 77-82 degree walls
// flanking the couloir gives back a twentieth of what the heightfield takes.
// Sampling against elevation compensates *exactly*, for free, at every angle:
//
//   - the ridged members' gradient is `A . dr . dh/dp / lambda_h`, i.e. already
//     proportional to the macro gradient, so their perturbation is a constant
//     *fraction* of the base slope from 30 degrees to 85;
//   - the bench's back-slope is `-A . cos(dip) / pitch` along the bed normal,
//     so `A = pitch / cos(dip)` makes the terrace exactly horizontal — again at
//     any steepness, and it is a fixed number of metres, not a slope-scaled one.
//     Beyond that the bench tips backwards into an overhang, so it is capped
//     just under it and `hard.amp` only ever scales it *down*.
const CLF_PITCH = 31.0;        // bed thickness, metres, perpendicular to bedding
const CLF_BENCH = 0.95;        // fraction of a dead-flat terrace, 1.0 = flat
const CLF_RIB = 28.0;          // contour-parallel lineation
const CLF_JNT = 19.0;          // conjugate joint sets
// ...but the two ridged members go into *geometry* at a third of that. See the
// note in GLSL_DISPLACE_BODY: at full amplitude their gradient is about twice
// the macro gradient, which a fragment normal absorbs happily and a 0.4 m
// clipmap ring does not — it folds, and a folded heightfield is a field of
// spikes. The CPU twin uses the same fractions so the physics surface still
// matches the mesh.
const CLF_VTX_RIB = 0.32, CLF_VTX_JNT = 0.37;
// Soft cap on |dg| as a multiple of (0.4 + |g|), and it has to differ by path.
// The mesh cannot take a perturbation larger than the surface it perturbs — it
// folds — and neither can the rock/snow threshold at close range, where it goes
// binary and the face reads as shattered foil. A 2 km wall is under neither
// constraint: it is drawn by the fragment program's normal, its mesh is 25 m
// per cell and its snow mask is averaged over the pixel anyway. So the cap
// opens up with distance.
const CLF_LIM_V = 0.55, CLF_LIM_F = 1.75;

const BD_IN = 3600, BD_OUT = 7000;
const BD_F1 = 1 / 2400, BD_A1 = 1500;
const BD_F2 = 1 / 620, BD_A2 = 175;
const BD_F3 = 1 / 185, BD_A3 = 42;
const BD_BASE = 190;

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
// A range is not a row of peaks, it is a *hierarchy*, and that is what the old
// skeleton was missing. Every summit was an isolated cone standing on the
// valley floor, all of them roughly the same size, so there was no way to tell
// which mountain any given peak belonged to — the skyline read as a spike
// generator because that is exactly what it was.
//
// Four scales now, evaluated in this order:
//
//   BULKS   massif bodies. Broad elliptical pedestals carrying the mass and the
//           shoulders, and — via `shape` — the *profile family*: a shouldered
//           massif, a flat-topped table, a rounded dome. A summit is a detail
//           on top of a mountain, not the mountain.
//   RIDGES  crest polylines. Ridge systems, aretes, buttresses, and above all
//           cols: the saddle between two summits of a real massif is 150-350 m
//           below them, not 500.
//   PEAKS   summits sitting on those crests, authored as *relief over radius*
//           rather than as absolute height, because (top-base)/radius is the
//           one number that decides whether a peak reads as a mountain or as a
//           paper spike. Tier 1 massifs get 1 dominant + 1-2 subordinate tops
//           at 0.78-0.85 of the parent + minor tops and gendarmes at 0.55-0.7.
//   CIRQUES glacial bowls scooped back into the upper faces. The arete between
//           two adjacent cirques is not authored — it is what is left standing
//           when both are cut, which is how a real arete is made.
//
// Couloirs (traced by steepest descent through the cirque system, see
// `_carveCouloirs`) and bedding planes (`_beddingPlanes`) are bake passes, not
// skeleton data, because both have to follow the surface that actually results.
const SUMMIT_X = 430, SUMMIT_Z = 2560;
const CONE_H = 1300, CONE_R = 4300, CONE_KX = 0.62;

/**
 * Massif bodies: `[x, z, height, rx, rz, rotation, shape]`.
 *
 * shape 0 — shouldered. Smoothstep in radius: rounded crown, steepest at
 *           mid-flank (1.5·h/r), gentle toe. The default alpine massif.
 * shape 1 — plateau. Flat top out to 0.4·r with a cliff band around it. Table
 *           mountains; the top holds snow, the walls shed it.
 * shape 2 — dome. Raised cosine, no crown at all. Reads as a snow dome and is
 *           the one profile in the set with no rock on its skyline.
 */
const BULK_DATA = [
  // -- across the valley: the wall the player descends towards ---------------
  [-1150, -3150, 800, 2550, 1800, -0.18, 0],   // M1  Grande Aiguille — tier 1
  [1950, -3050, 1000, 1950, 1450, 0.12, 1],    // M2  the Table — tier 1
  [520, -2760, 620, 1550, 1150, 0.05, 2],      // M3  the Dome — tier 2, in front
  [-2950, -2790, 660, 1750, 1250, 0.25, 0],    // M4  long crest range — tier 2
  // -- background wall, one aerial-perspective layer further back -----------
  [-1500, -3600, 780, 2400, 1000, 0.06, 0],
  [1900, -3560, 720, 2300, 950, -0.05, 0],
  // -- home mountain: bulk under the two flanking shoulders so they stop
  //    reading as fins stuck on the side of the run.
  [-1500, 1250, 620, 1250, 1150, 0.0, 0],
  [1850, 1270, 600, 1200, 1100, 0.0, 0],
  // ...and under the two spurs that gate the run-out, deliberately unequal.
  [-1750, -600, 380, 1100, 1300, 0.20, 0],
  [2100, -650, 330, 1450, 1500, -0.15, 0],
];

const BULKS = BULK_DATA.map((b) => ({
  x: b[0], z: b[1], h: b[2], irx: 1 / b[3], irz: 1 / b[4],
  c: Math.cos(b[5]), s: Math.sin(b[5]), shape: b[6],
}));

function bulkAt(b, x, z) {
  const dx = x - b.x, dz = z - b.z;
  const px = (dx * b.c + dz * b.s) * b.irx;
  const pz = (-dx * b.s + dz * b.c) * b.irz;
  const d2 = px * px + pz * pz;
  if (d2 >= 1) return 0;
  const u = 1 - Math.sqrt(d2);
  if (b.shape === 1) { const t = Math.min(1, u / 0.62); return b.h * t * t * (3 - 2 * t); }
  if (b.shape === 2) return b.h * 0.5 * (1 - Math.cos(Math.PI * u));
  return b.h * u * u * (3 - 2 * u);
}

/**
 * Ridge polylines: `[x, z, crestElevation]` control points, a flank width `w`,
 * and a crest sharpness `s` in 0..1.
 *
 * The cross-section used to be `v²(0.45v + 0.55)` for every ridge, whose slope
 * at the crest is 2.45·crest/w — for the main aretes (crest 1000 m, w 620 m)
 * that is 76 degrees for the top hundred metres, on *both* sides, which is the
 * fin the gate kept seeing. `s` now mixes that peaked profile against a
 * smoothstep whose crest is flat (slope 0 at the centreline, 1.5·crest/w at
 * mid-flank). Knife ribs keep s ≈ 1 — they are meant to be knives, and the
 * thermal pass relies on them standing at the angle of repose. Massif crests
 * and range skylines run at 0.2-0.45, which is a shoulder.
 */
const RIDGES = [
  // Summit crest, high above the start of the run.
  { w: 760, s: 0.40, pts: [[-1400, 2150, 900], [-500, 2450, 1150], [430, 2600, 1300], [1350, 2400, 1120], [2100, 2000, 870]] },
  // West arete — the skier's right-hand wall, running down to the valley.
  { w: 620, s: 0.45, pts: [[430, 2560, 1300], [-700, 2000, 1180], [-1150, 1300, 1000], [-1350, 500, 790], [-1520, -300, 480], [-1950, -1250, 300]] },
  // East arete — the skier's left-hand wall.
  { w: 640, s: 0.45, pts: [[430, 2560, 1300], [1250, 2000, 1160], [1500, 1300, 990], [1620, 500, 780], [1800, -300, 470], [2250, -1250, 290]] },
  // Rock ribs flanking the piste, ~750 m out on each side. Narrow and steep so
  // the thermal-erosion pass leaves them standing at the repose angle, which is
  // exactly where the shader stops holding snow. These are what give the run
  // something to be *between*.
  { w: 130, s: 1, pts: [[-780, 1450, 782], [-700, 1150, 712], [-660, 900, 652]] },
  { w: 130, s: 1, pts: [[860, 1330, 762], [800, 1050, 692], [770, 830, 642]] },
  { w: 120, s: 1, pts: [[-720, 330, 506], [-690, 90, 451], [-670, -140, 396]] },
  { w: 120, s: 1, pts: [[820, 250, 481], [790, 10, 426], [770, -220, 373]] },
  { w: 105, s: 1, pts: [[-560, 2000, 900], [-520, 1760, 840]] },
  { w: 105, s: 1, pts: [[640, 1900, 872], [610, 1660, 815]] },
  // Inner ribs, right on the shoulder of the piste — close enough to the fall
  // line to sit inside the frame all the way down.
  { w: 95, s: 1, pts: [[-520, 620, 549], [-495, 250, 447], [-480, -120, 363], [-500, -520, 270]] },
  { w: 95, s: 1, pts: [[560, 560, 526], [540, 190, 432], [530, -180, 350], [550, -580, 258]] },
  { w: 88, s: 1, pts: [[-430, 1500, 748], [-450, 1120, 660], [-470, 800, 588]] },
  { w: 88, s: 1, pts: [[490, 1420, 726], [510, 1060, 646], [520, 760, 578]] },
  // Secondary spurs dropping into the bowl — these read as buttresses.
  { w: 300, s: 0.7, pts: [[-1150, 1300, 990], [-780, 1080, 800], [-520, 900, 640]] },
  { w: 300, s: 0.7, pts: [[1500, 1300, 980], [1080, 1000, 790], [800, 780, 640]] },
  { w: 280, s: 0.7, pts: [[-1350, 500, 780], [-940, 340, 610], [-680, 210, 500]] },
  { w: 280, s: 0.7, pts: [[1620, 500, 770], [1200, 330, 600], [930, 190, 490]] },
  // Divides between the cirques bitten into the two home-mountain flanks. A
  // knife width on purpose: this is the rock the two bowls leave standing.
  { w: 70, s: 1, pts: [[-1150, 1290, 1010], [-1120, 1560, 960], [-1080, 1900, 880]] },
  { w: 70, s: 1, pts: [[1500, 1300, 1000], [1480, 1580, 950], [1450, 1920, 870]] },
  // -- crest systems of the massifs across the valley ------------------------
  // These are *shoulders*, not skylines: wide (1800-2600 m) so that where they
  // out-top their own pedestal they do it over 400-500 m of plan rather than
  // 150, which is the difference between a ridge and a blade. The summits come
  // from PEAKS; what these carry is the connective tissue — the cols, which on
  // a real massif sit 150-350 m under the tops they join, never 500.
  { w: 2200, s: 0.24, pts: [[-2500, -2950, 800], [-1780, -3060, 900], [-1150, -3170, 1000], [-620, -3040, 910], [-120, -2890, 780]] },  // M1
  { w: 2400, s: 0.20, pts: [[1150, -2990, 1020], [1950, -3130, 1060], [2700, -2980, 1010], [3400, -2760, 900]] },                      // M2
  { w: 2000, s: 0.26, pts: [[-3800, -2540, 800], [-3350, -2690, 900], [-2930, -2800, 940], [-2450, -2890, 860], [-2050, -2960, 790]] },// M4
  // Far background wall, right at the aerial-perspective limit.
  { w: 2400, s: 0.18, pts: [[-3400, -3480, 900], [-1900, -3620, 1020], [-350, -3600, 1060], [1450, -3560, 980], [3000, -3440, 900]] },
  // Buttresses down the front of each massif, running from the crest to the
  // valley between the cirques. A 1600 m face with a crest and a toe and
  // nothing in between has no scale: there is no feature on it the eye can use
  // to judge how big it is, so it reads as a smooth curtain however much fine
  // detail the shader puts on top. These are the spurs that divide one bowl
  // from the next, and they are what the couloirs run down between.
  { w: 260, s: 0.75, pts: [[-1150, -3140, 1450], [-1180, -2820, 1150], [-1230, -2520, 830], [-1300, -2250, 560]] },
  { w: 240, s: 0.80, pts: [[-1700, -3010, 1150], [-1800, -2740, 900], [-1880, -2480, 650], [-1950, -2260, 480]] },
  { w: 240, s: 0.80, pts: [[-560, -3000, 1250], [-500, -2740, 980], [-450, -2480, 700], [-420, -2260, 500]] },
  { w: 280, s: 0.70, pts: [[1900, -3080, 1150], [1880, -2800, 950], [1850, -2540, 720], [1830, -2300, 520]] },
  { w: 240, s: 0.75, pts: [[2600, -2950, 1080], [2650, -2700, 880], [2700, -2450, 660], [2750, -2250, 490]] },
  { w: 240, s: 0.75, pts: [[-3350, -2700, 1050], [-3400, -2480, 850], [-3450, -2280, 640]] },
  { w: 200, s: 0.80, pts: [[-1560, -360, 620], [-1450, -560, 500], [-1380, -780, 400]] },
  { w: 200, s: 0.80, pts: [[1900, -420, 520], [1830, -640, 430], [1790, -860, 350]] },
  // Foothills a kilometre in front of the range. Depth in a skyline is not
  // made by the far peaks, it is made by having *layers* for the aerial
  // perspective to separate: in every real photograph of a range there are
  // four or five planes stacked between the observer and the summits, and this
  // one had two. Kept off the fall line and low enough (4-6 degrees from the
  // hero framing, against the main massif's 17) that they layer in front of
  // the flanks without touching the view down the valley.
  { w: 1100, s: 0.40, pts: [[-3200, -1900, 480], [-2400, -2150, 620], [-1500, -2250, 560]] },
  { w: 1100, s: 0.40, pts: [[1400, -2200, 540], [2400, -2100, 660], [3300, -1900, 520]] },
  // Low shoulders framing the run-out.
  { w: 700, s: 0.5, pts: [[-2300, -700, 330], [-3000, -1700, 440], [-3500, -2350, 510]] },
  { w: 700, s: 0.5, pts: [[2350, -800, 320], [3050, -1750, 420], [3550, -2300, 490]] },
  // Outliers so the mid distance is not empty.
  { w: 900, s: 0.35, pts: [[-3200, 900, 680], [-3600, 1900, 820]] },
  { w: 900, s: 0.35, pts: [[3100, 800, 640], [3550, 1750, 770]] },
];

/**
 * Summits: `[x, z, top, base, radius, exponent]`.
 *
 * Authored as relief over radius. `(top - base) / radius` is the mean flank
 * gradient of the summit cone and nothing else in the pipeline can rescue it
 * from being wrong — the previous table gave absolute heights against implicit
 * radii and the resulting cones measured 58-70 degrees over their whole visible
 * area, which is why every one of them read as a paper spike. Everything here
 * is between 0.55 and 0.85, i.e. 29-40 degrees, with the steep ground
 * concentrated in the cirque headwalls where it belongs.
 *
 * `base` is a small pedestal that fades out over the last quarter of the radius
 * so a summit blends into its massif instead of standing on the valley floor;
 * `exponent` is the crown shape — 0.95-1.1 a horn, 1.2-1.4 a shouldered top,
 * 1.6+ a dome.
 *
 * The hierarchy is explicit and it is the point: one dominant summit per tier-1
 * massif, one or two subordinates at 0.78-0.85 of its relief hung off the same
 * crest, then minor tops and gendarmes at 0.55-0.7 cluttering the cols.
 */
const PEAK_DATA = [
  // -- M1 "Grande Aiguille": the dominant massif of the near skyline ---------
  [-1150, -3160, 1620, 760, 1650, 0.95],   // dominant horn
  [-560, -3020, 1330, 700, 1250, 1.15],    // subordinate, east ridge
  [-1790, -3050, 1230, 680, 1150, 1.30],   // subordinate, west shoulder
  [-2200, -2930, 1030, 620, 850, 1.45],    // minor top
  [-190, -2870, 990, 600, 800, 1.40],      // minor top
  [-1010, -2830, 1050, 800, 380, 1.05],    // gendarme on the north arete
  // -- M2 "the Table": flat-topped, deliberately the opposite silhouette -----
  [1950, -3120, 1210, 940, 1700, 1.60],    // barely a summit: a cap on a plateau
  [2820, -2870, 1170, 820, 900, 1.05],     // tower at the east end of the rim
  [1230, -2930, 1070, 800, 700, 1.30],
  [3350, -2680, 990, 700, 750, 1.35],
  // -- M3 "the Dome": rounded, snow-covered, sits in front and overlaps ------
  [520, -2790, 900, 520, 1400, 1.70],
  // -- M4: a subordinate range read as three tops on one continuous crest ----
  [-3380, -2690, 1160, 700, 1000, 1.20],
  [-2930, -2800, 1080, 680, 900, 1.35],
  [-2470, -2890, 960, 640, 750, 1.40],
  [-3800, -2520, 1000, 620, 800, 1.35],
  // -- the background wall. Its dominant top is the highest thing in the
  //    world and it is *behind* everything, seen through the col between M1
  //    and the Dome: a summit glimpsed through a gap in a nearer range is the
  //    strongest depth cue a skyline has, and it costs one peak.
  [-350, -3600, 1690, 900, 1750, 1.05],
  [-1900, -3620, 1560, 880, 1600, 1.15],
  [1450, -3560, 1430, 850, 1350, 1.20],
  [2900, -3480, 1310, 800, 1200, 1.25],
  [-3200, -3520, 1250, 780, 1100, 1.30],
  [-2700, -3560, 1130, 800, 800, 1.45],
  [700, -3630, 1200, 820, 850, 1.40],
  [2200, -3540, 1160, 800, 820, 1.45],
  [3450, -3400, 1080, 750, 760, 1.45],
  // -- home mountain: the two flanking shoulders. Given different crowns on
  //    purpose — a horn on the west wall, a broad shouldered top on the east —
  //    because they sit in the same frame in every screenshot.
  [-1180, 1290, 1120, 700, 1000, 1.10],
  [-1620, 900, 940, 580, 800, 1.30],
  [1520, 1310, 1090, 690, 980, 1.45],
  [1980, 950, 920, 570, 780, 1.25],
  // The two spurs that gate the run-out. These sit dead centre of the `steep`
  // framing and used to be a matched pair of blades — the same fin twice, left
  // and right, which is the most obvious kind of symmetry a landscape can have
  // and the eye finds it instantly. So: a rock tower on the west side, a broad
  // forested shoulder on the east, at different heights.
  [-1560, -320, 680, 340, 820, 1.05],
  [-1880, -780, 520, 270, 620, 1.30],
  [1900, -380, 560, 300, 1000, 1.60],
  [2400, -900, 470, 250, 850, 1.50],
  [-2400, -2150, 780, 430, 720, 1.30],     // foothill tops, in front of M4
  [2450, -2120, 810, 450, 740, 1.35],
  [-3300, 1500, 940, 560, 950, 1.25],
  [3250, 1350, 900, 540, 920, 1.30],
];

const PEAKS = PEAK_DATA.map((p) => ({
  x: p[0], z: p[1], rel: p[2] - p[3], base: p[3], ir: 1 / p[4], e: p[5],
}));

/**
 * Glacial cirques: bowls quarried back into the upper faces by ice that is no
 * longer there. Each is an ellipse whose *back* radius is roughly 0.6 of its
 * front one, so the headwall stands up steeply while the floor drains out
 * through the mouth, plus a rock threshold across that mouth — which is what
 * leaves a cirque floor hanging above the valley instead of merging into it.
 *
 * Aretes are not in this table because aretes are not authored. Place two
 * bowls 1.5-1.8 rim-radii apart and the rock they fail to remove between them
 * *is* the arete; the thermal pass then sharpens it. Same for the couloirs,
 * which the descent tracer finds by following the water out of the mouths.
 *
 * `a` is the bearing the cirque opens towards (0 = +z, towards the player).
 */
const CIRQUE_DATA = [
  // M1 — two bowls flanking the north arete of the dominant horn, and a small
  // hanging one right under the summit.
  { x: -1480, z: -2880, ru: 520, rf: 560, rb: 330, d: 175, lip: 21, a: 0.0, f: 500 },
  { x: -820, z: -2840, ru: 470, rf: 500, rb: 300, d: 150, lip: 19, a: 0.25, f: 500 },
  { x: -1150, z: -2985, ru: 330, rf: 340, rb: 210, d: 95, lip: 16, a: 0.0, f: 780 },
  // M2 — bitten into the front rim of the plateau, which is how a table
  // mountain gets a silhouette.
  { x: 1500, z: -2790, ru: 470, rf: 500, rb: 300, d: 165, lip: 20, a: -0.2, f: 560 },
  { x: 2290, z: -2780, ru: 430, rf: 460, rb: 280, d: 145, lip: 17, a: 0.15, f: 560 },
  // M4 and the background wall.
  { x: -3050, z: -2620, ru: 420, rf: 450, rb: 270, d: 130, lip: 15, a: 0.1, f: 420 },
  { x: -1950, z: -3400, ru: 480, rf: 500, rb: 300, d: 140, lip: 16, a: 0.0, f: 520 },
  { x: -330, z: -3390, ru: 500, rf: 530, rb: 320, d: 150, lip: 17, a: 0.0, f: 560 },
  { x: 1500, z: -3360, ru: 440, rf: 470, rb: 280, d: 130, lip: 15, a: 0.0, f: 520 },
  // Home mountain: bowls in the two walls the run is between, opening towards
  // the piste so they are read from inside rather than in profile.
  { x: -1150, z: 1720, ru: 380, rf: 400, rb: 250, d: 115, lip: 14, a: 1.35, f: 620 },
  { x: -1250, z: 900, ru: 350, rf: 370, rb: 230, d: 100, lip: 12, a: 1.50, f: 500 },
  { x: 1500, z: 1740, ru: 370, rf: 390, rb: 240, d: 110, lip: 14, a: -1.35, f: 620 },
  { x: 1580, z: 920, ru: 340, rf: 360, rb: 220, d: 98, lip: 12, a: -1.50, f: 500 },
  // Bowls in the inner faces of the two run-out spurs, opening across the
  // valley so they are read from the piste rather than in profile.
  { x: -1450, z: -650, ru: 330, rf: 350, rb: 210, d: 95, lip: 11, a: 1.20, f: 240 },
  { x: 2050, z: -720, ru: 300, rf: 320, rb: 200, d: 80, lip: 10, a: -1.10, f: 220 },
];

const CIRQUES = CIRQUE_DATA.map((c, i) => ({
  x: c.x, z: c.z, d: c.d, lip: c.lip, f: c.f,
  iru: 1 / c.ru, irf: 1 / c.rf, irb: 1 / c.rb,
  ox: Math.sin(c.a), oz: Math.cos(c.a),
  nf: 2.6 / c.ru, nx: i * 37.13, nz: i * -19.71,   // rim wobble
}));

/**
 * @param env the envelope so far. A bowl is only cut into ground that is
 * actually high enough to hold one — without this a cirque near the toe of a
 * massif quarries a crater out of the valley floor.
 */
function cirqueAt(c, x, z, env) {
  const dx = x - c.x, dz = z - c.z;
  const v = dx * c.ox + dz * c.oz;               // + towards the mouth
  const u = dx * c.oz - dz * c.ox;               // across the bowl
  const a = u * c.iru;
  const b = v > 0 ? v * c.irf : v * c.irb;       // shorter behind: the headwall
  let d2 = a * a + b * b;
  if (d2 >= 2.6) return 0;
  // The rim is not a circle. Wobbling the radius with a noise at ~0.4 of the
  // bowl width is the difference between a cirque and a stamp.
  d2 *= 0.78 + 0.44 * vnoise(x * c.nf + c.nx, z * c.nf + c.nz);
  if (d2 >= 2.1) return 0;
  const g = smoothstep(c.f - 30, c.f + 210, env);
  if (g <= 0) return 0;
  let h = 0;
  if (d2 < 1) { const w = 1 - d2; h -= c.d * w * (1.25 - 0.25 * w); }
  if (v > 0) {
    const t = (Math.sqrt(d2) - 1.0) * (1 / 0.36);
    h += c.lip * Math.exp(-t * t);
  }
  return h * g;
}

/**
 * Couloir seeds. A couloir is not a shape you draw, it is where the mountain
 * lets snow and rock leave, so these are only *starting points* — the notch at
 * the back of a cirque, and a fan of points around the shoulder of every summit
 * with enough relief to shed. `_carveCouloirs` traces each one down the actual
 * envelope by steepest descent, which is what makes them connect: they run into
 * the bowls, out through the mouths, and merge into the same fans the flow pass
 * later deepens, instead of being a set of unrelated grooves.
 *
 * `[x, z, halfWidth, depth, steps]`
 */
const COULOIR_SEEDS = [];
{
  const hash = (i) => {
    const s = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
    return s - Math.floor(s);
  };
  let n = 0;
  for (const c of CIRQUE_DATA) {
    const ox = Math.sin(c.a), oz = Math.cos(c.a);
    for (let k = -1; k <= 1; k++) {
      const t = k * 0.52;
      const r = hash(n++);
      COULOIR_SEEDS.push([
        c.x - ox * c.rb * 0.86 + oz * c.ru * t,
        c.z - oz * c.rb * 0.86 - ox * c.ru * t,
        24 + 16 * r, 26 + 18 * r, 90,
      ]);
    }
  }
  for (const p of PEAK_DATA) {
    const rel = p[2] - p[3];
    if (rel < 180) continue;
    const m = rel > 500 ? 6 : 4;
    for (let k = 0; k < m; k++) {
      const r = hash(n++);
      const a = (k + 0.35 * r) * (Math.PI * 2 / m) + p[0] * 0.0013;
      COULOIR_SEEDS.push([
        p[0] + Math.cos(a) * p[4] * 0.30,
        p[1] + Math.sin(a) * p[4] * 0.30,
        20 + 20 * r, 22 + 26 * r, 110,
      ]);
    }
  }
  // Gully fans down the flanks of every major crest, dropped alternately on
  // either side of the line. Without these the big faces between the summits
  // have nothing on them at all: the summit cones get their couloirs and the
  // 2 km of wall between them stays a clean ramp, which is exactly how a face
  // ends up reading as a sail.
  for (const rg of RIDGES) {
    if (rg.w < 400) continue;
    for (let i = 0; i < rg.pts.length - 1; i++) {
      const [x0, z0, h0] = rg.pts[i];
      const [x1, z1] = rg.pts[i + 1];
      const dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      const nx = -dz / len, nz = dx / len;
      // Sparse on purpose. Seeded every 230 m the traces come off a conical
      // face as forty parallel grooves — a comb, which is the exact artefact
      // the flow pass had to have a channel-initiation threshold to avoid.
      // Real couloirs are 600-900 m apart at the crest and they *converge*.
      const steps = Math.max(1, Math.round(len / 700));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        if (h0 < 380) continue;
        const r = hash(n++);
        const side = (k & 1) ? 1 : -1;
        const off = (55 + 90 * r) * side;
        COULOIR_SEEDS.push([
          x0 + dx * t + nx * off, z0 + dz * t + nz * off,
          22 + 26 * r, 24 + 30 * r, 80,
        ]);
      }
    }
  }
}

// Flatten to segments for a tight inner loop.
const SEGS = [];
for (const r of RIDGES) {
  for (let i = 0; i < r.pts.length - 1; i++) {
    const [x0, z0, h0] = r.pts[i];
    const [x1, z1, h1] = r.pts[i + 1];
    const dx = x1 - x0, dz = z1 - z0;
    SEGS.push({
      x0, z0, h0, dx, dz, dh: h1 - h0,
      inv: 1 / (dx * dx + dz * dz), iw: 1 / r.w, sh: r.s ?? 0.45,
    });
  }
}

/**
 * Bedding. Returns where a point sits *within its bed*, 0..1.
 *
 * Sedimentary rock is a stack, not a solid: beds tens of metres thick, each
 * with a weaker layer under it, tilted at some dip and striking in some
 * direction that is constant over a massif and different over the next one. Two
 * separate passes need exactly this number and they have to agree, or the
 * strata the geometry shows and the benches the erosion cuts belong to two
 * different mountains:
 *
 *   - the talus field, because a weak bed relaxes to a much lower angle than
 *     the competent rock above it, which is what puts a ledge across a face;
 *   - the bedding displacement itself, which raises the resistant part of each
 *     bed proud of the recessive one.
 *
 * Dip 17-38 degrees from slow noise, so each massif gets its own structural
 * domain instead of one pattern stamped across the range. The old range was
 * 12-23 degrees, i.e. cos(dip) = 0.92-0.98 against sin(dip) = 0.21-0.39: the
 * elevation term dominated by four to one and the bands were, to within a few
 * degrees, *contours*. That is what nested them into concentric loops around
 * every convexity. Past about 25 degrees they cut across the topography and
 * read as strata instead.
 *
 * Bed thickness is fixed and the *phase* is warped, not the period. Dividing a
 * plane by a noisy period looks like the same thing and is not: d(s)/dx picks
 * up a term `-s . dP/P.dx` which, with s running to ~45 beds across the map,
 * measured four times the plane's own gradient. The "bedding" was therefore
 * mostly a beat pattern between two noise fields, which is exactly how it came
 * out — one pitch, everywhere, at one amplitude. A phase warp thickens and
 * thins beds laterally without ever swamping the plane.
 */
const BED_P0 = 52;
function bedPhase(x, z, h) {
  const dom = fbm(x * 0.00042, z * 0.00042, 2);
  const dip = 0.30 + 0.36 * dom;
  const strike = dom * 3.1 + 1.2;
  return (h * Math.cos(dip)
    + (x * Math.cos(strike) + z * Math.sin(strike)) * Math.sin(dip)) / BED_P0
    + fbm(x * 0.00085 + 3.3, z * 0.00085 - 6.1, 2) * 1.6;
}

/**
 * Per-bed character, hashed off the bed index. Beds of *equal* thickness and
 * equal hardness are the giveaway: a face banded at one pitch and one amplitude
 * all the way across is corrugated iron, not rock. Real sections are bundles —
 * a massive unit that stands as a cliff, then five thin ones that weather into
 * a staircase, then a recessive marl that cuts a terrace right across the
 * mountain. `_beddingPlanes` scales its displacement by this and the talus
 * field scales its weak layer by it, so a bed that stands proud is also a bed
 * that holds its angle.
 */
function bedHardness(s) {
  const bi = Math.floor(s);
  const r = Math.sin(bi * 12.9898 + 78.233) * 43758.5453;
  const u = r - Math.floor(r);
  const r2 = Math.sin(bi * 39.3468 - 11.7) * 24634.6345;
  // Bundles. Per-bed hashing alone gives every face the same *pitch* — 52 m —
  // and only varies how loudly each bed shouts, so a detrended row profile puts
  // nearly all its energy in one narrow band (measured 80% against 37% for the
  // Eiger Nordwand). Grouping four beds under a shared multiplier that can go
  // as low as 0.35 and as high as 1.7 means a face carries a 52 m pitch, a
  // 210 m pitch, and long stretches with essentially nothing — which is what a
  // real section looks like.
  const bu = Math.floor(s * 0.25);
  const r3 = Math.sin(bu * 7.113 + 2.31) * 19341.7;
  const v3 = r3 - Math.floor(r3);
  return {
    amp: (0.14 + 1.90 * u * u) * (0.35 + 1.35 * v3),
    brk: 0.20 + 0.38 * (r2 - Math.floor(r2)),
  };
}

/** Polynomial smooth-max: keeps ridge intersections from creasing. */
function smax(a, b, k) {
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

/**
 * The massif. A single conical body centred on the summit gives the home
 * mountain one unambiguous identity and one obvious fall line; the massif
 * pedestals, the ridge network and the summits are smooth-maxed on top of it in
 * that order — mass, then structure, then tops — and the cirques are cut last,
 * because a bowl that a summit cone can fill back in is not a bowl.
 */
function massif(x, z) {
  const dx = x - SUMMIT_X, dz = z - SUMMIT_Z;
  const r = Math.sqrt(CONE_KX * dx * dx + dz * dz);
  const u = clamp(1 - r / CONE_R, 0, 1);
  let env = CONE_H * u * u;

  for (let i = 0; i < BULKS.length; i++) {
    const c = bulkAt(BULKS[i], x, z);
    if (c > env - 260) env = smax(env, c, 260);
  }

  for (let i = 0; i < SEGS.length; i++) {
    const s = SEGS[i];
    const px = x - s.x0, pz = z - s.z0;
    let t = (px * s.dx + pz * s.dz) * s.inv;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - s.dx * t, ez = pz - s.dz * t;
    const d = Math.sqrt(ex * ex + ez * ez) * s.iw;
    if (d >= 1) continue;
    const v = 1 - d;
    // Crest cross-section: flat-crested smoothstep blended towards the old
    // peaked profile by the ridge's sharpness. See the RIDGES doc comment.
    const prof = v * v * ((3 - 2 * v) + s.sh * (2.45 * v - 2.45));
    const c = (s.h0 + s.dh * t) * prof;
    if (c > env - 150) env = smax(env, c, 150);
  }

  for (let i = 0; i < PEAKS.length; i++) {
    const p = PEAKS[i];
    const ex = x - p.x, ez = z - p.z;
    const d = Math.sqrt(ex * ex + ez * ez) * p.ir;
    if (d >= 1) continue;
    const v = 1 - d;
    // Summit cone over a pedestal. The pedestal is a smoothstep across the
    // *whole* radius, and that is not a detail: fading it over the last quarter
    // instead (which is what this did first) leaves an 880 m plateau ending in
    // a 290 m drop, i.e. a 73-degree step right round the foot of every summit.
    // Thermal erosion then planes that step into a single flat surface, and a
    // 1500 m flat surface at 40 degrees with a smooth parabolic silhouette is
    // not a mountain face, it is a sail. Measured at x = -1125: the north front
    // of the main massif climbed 599 m -> 1260 m across 200 m of plan.
    const c = p.rel * Math.pow(v, p.e) + p.base * v * v * (3 - 2 * v);
    if (c > env - 170) env = smax(env, c, 170);
  }

  for (let i = 0; i < CIRQUES.length; i++) env += cirqueAt(CIRQUES[i], x, z, env);
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
        // Secondary ridges and spurs.
        //
        // This coefficient used to be `115 + env*0.58`, which on a 1000 m
        // massif is 695 m of ridged multifractal — measured, the term was
        // adding +660 m to some cells and -210 m to their neighbours. At that
        // amplitude the *noise* is the mountain: whatever hierarchy the
        // skeleton lays down, a 9-octave ridged fractal stamps its own row of
        // equal-sized tents over the top, which is precisely the "repeated
        // spike generator" reading. It has to dress the skeleton, not compete
        // with it, so the altitude-proportional part is a third of what it was
        // and the mass it used to supply now comes from BULKS and PEAKS, where
        // it can be composed. The mid bands below are untouched: they are the
        // surface texture that keeps big faces from reading as ramps, and they
        // are too fine to move a silhouette.
        h += (r - 0.30) * (100 + env * 0.19);
        h += b * (32 + env * 0.075);               // broad undulation
        // Mid band: this is what stops big faces reading as smooth ramps, and
        // it is where the amplitude taken off the term above has gone. A 625 m
        // wavelength puts 100-200 m buttresses and gullies on a face without
        // ever inventing a summit, so it buys back all of the structure and
        // none of the spikes.
        // ...but only out on the faces. The corridor is blended in over its
        // outer 360 m and the extra amplitude survives that blend as a lip on
        // the shoulder of the piste, which is enough to launch the skier.
        const away = smoothstep(420, 950, Math.abs(x - corridorX(z)));
        h += (ridgedMF(qx * 0.0016, qz * 0.0016, 5) - 0.31) * (26 + (78 + 52 * away) * alt);
        // Serration, modulated along the crest. A ridge line that is toothed at
        // one amplitude for its whole length is the last thing that gives a
        // procedural skyline away even once the *sizes* are right: a real crest
        // runs smooth for four hundred metres, throws up three gendarmes, and
        // goes smooth again. A slow field (1.8 km) scaling the two serration
        // bands between 0.3x and 1.75x buys exactly that, and it is squared so
        // the smooth stretches dominate. Held at 1x near the fall line, where
        // extra metre-scale relief is a hazard rather than a silhouette.
        const sr = clamp(fbm(x * 0.00055 + 5.7, z * 0.00055 - 2.3, 2) * 0.5 + 0.5, 0, 1);
        const ser = 1 + (0.30 + 1.45 * sr * sr - 1) * away;
        h += (ridgedMF(qx * 0.0058, qz * 0.0058, 3) - 0.31) * (13 + 52 * alt) * ser;
        h += (ridgedMF(qx * 0.0115, qz * 0.0115, 3) - 0.31) * (6 + 22 * alt) * ser;

        H[j * R + i] = h;
      }
    }

    // -- 1b. couloirs ---------------------------------------------------------
    this._carveCouloirs(H);

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
    //
    // The jitter used to be free noise, and its floor was far too low: a third
    // of the map relaxed at 17-35 degrees. Applied to *bedrock* that is simply
    // wrong — 30 degrees is the repose angle of scree, competent rock stands at
    // 55-75 — and it is why every big face came out as a single planed surface
    // with nothing on it. Anything the fractal put on a 45-degree wall exceeded
    // repose by construction and was immediately taken off again, which left
    // the old skeleton no way to hold structure except by making the peaks so
    // over-steep that they read as fangs.
    //
    // So the threshold is keyed on the bedding instead: competent rock relaxes
    // at 50-57 degrees, the weak layer at the top of each bed at 29-35, and
    // what the pass now does on a face is undercut the soft bands and leave the
    // hard ones standing. That is a ledge system, it is where the snow sits,
    // and it is the same geometry `_beddingPlanes` displaces.
    const talus = new Float32Array(R * R);
    for (let j = 0; j < R; j++) {
      const z = MAP_ORIGIN + j * MAP_STEP;
      for (let i = 0; i < R; i++) {
        const k = j * R + i;
        const x = MAP_ORIGIN + i * MAP_STEP;
        const bs = bedPhase(x, z, H[k]);
        const w = bs - Math.floor(bs);
        const hard = bedHardness(bs);
        const weak = smoothstep(0.66, 0.82, w) * (1 - smoothstep(0.93, 1.0, w))
          * clamp(1.35 - hard.amp * 0.7, 0.15, 1);
        const t = fbm(x * 0.0021, z * 0.0021, 3) * 0.16 + fbm(x * 0.011, z * 0.011, 2) * 0.11;
        talus[k] = (1.30 - 0.72 * weak + t) * MAP_STEP;
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
    const slopeArr = new Float32Array(R * R);
    for (let j = 1; j < R - 1; j++) {
      for (let i = 1; i < R - 1; i++) {
        const k = j * R + i;
        const slope = Math.max(
          Math.abs(H[k + 1] - H[k - 1]),
          Math.abs(H[k + R] - H[k - R]),
        ) / (2 * MAP_STEP);
        // Channel-initiation threshold. Without one, *every* cell on the map has
        // upstream flow of at least a few and therefore gets its own groove, so
        // the carve does not produce a drainage network — it produces a comb.
        // On a steep face 1.5 km out those grooves are 8-16 m wide and a metre
        // deep, they all run exactly down the fall line, and they were the
        // vertical smearing on the cliff faces: fine, parallel, perfectly
        // coherent striping that no amount of shading detail can out-vote,
        // because it is in the surface itself.
        //
        // Real hillslopes are smooth. Channels begin only where enough area has
        // collected to move material — the critical drainage area — and above
        // that threshold they deepen fast. Subtracting the threshold inside the
        // power law is exactly that: nothing at all below ~50 cells of upstream
        // area, and the big dendritic couloirs are untouched (they had flow in
        // the thousands and lose 8% of their depth).
        //
        // The threshold alone is not enough on a *cliff*. Fluvial incision
        // needs ground that water can move; above about 48 degrees there is no
        // regolith to take away, the face is bedrock, and what actually
        // channels it is rockfall — which is the couloir pass, placed
        // explicitly. Left ungated the carve puts its comb straight back onto
        // every big wall (measured: the whole 2.5 km north face of the main
        // massif striped at 8-16 m pitch), and raising the repose angle so
        // bedrock could hold structure made it worse, because the carve weight
        // saturates at 1.0 on exactly the faces that got steeper.
        // The gate above was set at 1.05..1.85, i.e. it only faded the carve out
        // between 46 and 62 degrees — but the big buttress faces sit at 46-58,
        // squarely inside it, so the comb was still running at 60-100% strength
        // on exactly the walls this gate exists to protect. A blind review
        // measured the result: fall-line autocorrelation on those faces roughly
        // doubled (coherence length ~20 px -> ~50 px) and they read as draped
        // fabric rather than rock. Fully off by ~48 degrees now.
        slopeArr[k] = slope;
        const fq = Math.pow(flow[k], 0.45) - 6.4;
        delta[k] = fq <= 0 ? 0
          : -Math.min(38, 0.335 * fq) * clamp(slope * 2.4 - 0.10, 0.0, 1)
            * (1 - smoothstep(0.62, 1.10, slope));
      }
    }
    // The channel carve leaves a stepped trench that has to be relaxed. A
    // *blanket* Laplacian relax is what turns every face into a smooth dome
    // though: four passes at 0.3 removes essentially all the 30-60 m structure,
    // which from three kilometres is exactly the band that reads as buttresses,
    // ribs and gullies. So the relaxation is weighted by how much each cell was
    // actually carved — the trenches get smoothed, the faces keep their bones.
    // ...but the weight saturated. `-delta * 0.28` hits 1.0 for anything carved
    // more than 3.6 m, and the carve reaches 38 m, so every carved wall took the
    // full four passes at 0.30 — the blanket relax this weighting was written to
    // avoid. Gentler, capped well below 1, and additionally scaled away on steep
    // ground so bedrock faces keep their bones.
    const relaxW = new Float32Array(R * R);
    for (let k = 0; k < R * R; k++) {
      H[k] += delta[k];
      relaxW[k] = clamp(-delta[k] * 0.06, 0.05, 0.45)
        * (1 - smoothstep(0.8, 1.3, slopeArr[k]));
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
        let w = smoothstep(560, 200, d);
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
        // Do not drag a wall down into the piste. At 420 m from the centreline
        // the blend is still 0.34, and the two buttresses flanking the couloir
        // sit at exactly 420-470 m and 66-74 degrees: a third of every one of
        // those pixels was a smooth corridor ramp, and the same weight was
        // taking 29% off their bedrock-exposure channel, which is why they came
        // out both the smoothest and the whitest faces on the map.
        //
        // Gating on *slope* here does not work and is not a matter of tuning:
        // the corridor is cut into steep ground by design, so the pre-blend
        // gradient under the piste is large everywhere and a slope gate deletes
        // the piste (measured — the skier fell onto the raw massif at 838 km/h).
        // Gating on how far the ground stands *above the corridor profile* is
        // safe, because that is small by construction anywhere the piste can
        // actually run, and it is only allowed to act on the outer shoulder.
        //
        // The boundary itself wanders, in a field of z and *elevation*, by up
        // to 150 m. Without that the outer edge of the blend is the graph of a
        // smoothstep in |x - cx| — a smooth, monotone, laterally-constant curve
        // running unbroken from crest to valley floor, which is the theatre
        // curtain in one line of code. A silhouette cannot be argued with by
        // surface detail. Sampling the wander against elevation makes the
        // boundary climb, step back into a re-entrant, jut out into a buttress
        // and climb again, so the wall is a row of buttresses rather than a
        // funnel. Jittering `d` directly instead does the same job to the
        // *skiable* shoulder and strands the skier in the trees at 312 m out on
        // the `ridge` framing — hence the `above` factor, which is small by
        // construction anywhere the piste can actually run.
        const above = H[k] - prof;
        if (above > 70) {
          const nz = fbm(z * 0.0016 + 5.1, H[k] * 0.0042 - 2.7, 3);
          w *= 1 - smoothstep(300, 480, d + nz * 150) * smoothstep(70, 240, above);
        }
        H[k] = H[k] + (prof - H[k]) * w;
        strip[k] *= 1 - w * 0.85;
      }
    }

    // -- 5b. let the walls of the slot fall over -----------------------------
    // The thermal pass ran in step 2; the corridor cuts its slot in step 5.
    // Everything the slot leaves standing is therefore ground that no erosion
    // has ever seen, and it is not marginal: probed on the two buttresses
    // flanking the couloir, the sides of the slot stand at 77-82 degrees over
    // 800 m of relief. Nothing else on the map exceeds about 60, because that
    // is what the repose angles in step 2 allow, and those two faces are the
    // ones that own the skyline of every wide shot. Five iterations at a
    // 62-degree threshold bring them back into the range the rest of the massif
    // lives in and drop the material at the foot as a fan.
    //
    // Gated to the couloir vicinity so the authored cliffs elsewhere keep the
    // steepness the hierarchy was tuned around, and faded out inside 320 m so
    // it can never reach the piste. `strip` takes the balance, exactly as in
    // step 2, so a scoured wall reads as bedrock and its fan reads as talus.
    {
      const T = 1.58 * MAP_STEP;                       // 61.6 degrees
      for (let it = 0; it < 12; it++) {
        delta.fill(0);
        for (let j = 1; j < R - 1; j++) {
          const z = MAP_ORIGIN + j * MAP_STEP;
          const cx = corridorX(z);
          for (let i = 1; i < R - 1; i++) {
            const x = MAP_ORIGIN + i * MAP_STEP;
            const dd = Math.abs(x - cx);
            if (dd > 1250) continue;
            const g = smoothstep(210, 370, dd) * smoothstep(1250, 1050, dd);
            if (g <= 0.01) continue;
            const k = j * R + i, h0 = H[k];
            let tot = 0, d0 = 0, d1 = 0, d2 = 0, d3 = 0;
            let dd0 = h0 - H[k - 1]; if (dd0 > T) { d0 = dd0 - T; tot += d0; }
            dd0 = h0 - H[k + 1]; if (dd0 > T) { d1 = dd0 - T; tot += d1; }
            dd0 = h0 - H[k - R]; if (dd0 > T) { d2 = dd0 - T; tot += d2; }
            dd0 = h0 - H[k + R]; if (dd0 > T) { d3 = dd0 - T; tot += d3; }
            if (tot <= 0) continue;
            const move = Math.min(tot * 0.30, (h0 - Math.min(H[k - 1], H[k + 1], H[k - R], H[k + R])) * 0.4) * g;
            const s = move / tot;
            delta[k] -= move;
            delta[k - 1] += d0 * s; delta[k + 1] += d1 * s;
            delta[k - R] += d2 * s; delta[k + R] += d3 * s;
          }
        }
        for (let k = 0; k < R * R; k++) { H[k] += delta[k]; strip[k] -= delta[k] * 0.6; }
      }
    }

    // -- 5c. bedding planes ---------------------------------------------------
    // After the slot and after its walls have relaxed, so the beds are cut into
    // the surface that is actually rendered rather than into one the corridor
    // pass then blends 34% of a smooth ramp over.
    this._beddingPlanes(H);

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
      // Bedrock exposure. The scale is calibrated, not chosen: raising the
      // repose angle so competent rock could hold structure means the thermal
      // pass strips less material, and this channel is the *amount stripped*.
      // Measured, the 90th percentile of the packed channel fell from 0.104 to
      // 0.062 and the fraction above 0.3 from 3.8% to 2.7% — i.e. the mountains
      // quietly turned white, which is the one thing the snow/rock logic was
      // praised for getting right. 0.145 puts the distribution back where it
      // was (p90 0.101, 4.1% over 0.3) without touching the shader.
      F[k * 4 + 3] = clamp(strip[k] * 0.145, -0.8, 1.0);
    }
  }

  /**
   * Couloirs and gullies.
   *
   * Every seed is walked down the *envelope* — the skeleton without its
   * fractal, so the line follows the mountain rather than the noise — with a
   * little momentum so it cuts across minor bumps the way a rockfall chute
   * does. The trench is max-blended, not accumulated, so overlapping steps
   * cannot dig a hole, and each run tapers out at its foot, where the thermal
   * pass then builds the fan.
   *
   * The ordering matters: this runs *before* thermal relaxation and flow
   * accumulation, so the couloirs are widened at the repose angle and then
   * deepened again by the drainage they now collect. That is why they read as
   * part of the same drainage network as the dendritic gullies instead of as
   * decals on top of one.
   *
   * The piste is untouchable: a trace that comes within 640 m of the corridor
   * centreline stops there.
   */
  _carveCouloirs(H) {
    const R = MAP_RES;
    const carve = new Float32Array(R * R);
    for (let si = 0; si < COULOIR_SEEDS.length; si++) {
      const s = COULOIR_SEEDS[si];
      let x = s[0], z = s[1], vx = 0, vz = 0;
      const N = s[4];
      for (let n = 0; n < N; n++) {
        const e = 10;
        const gx = (massif(x + e, z) - massif(x - e, z)) * (1 / (2 * e));
        const gz = (massif(x, z + e) - massif(x, z - e)) * (1 / (2 * e));
        const m = Math.sqrt(gx * gx + gz * gz);
        if (m < 0.20) break;                       // out on the flat: done
        // A cross-slope push from a slow noise field. Pure steepest descent on
        // a conical face gives radial lines that never meet; a real chute is
        // deflected by whatever it runs into and ends up joining its neighbour.
        const wob = (vnoise(x * 0.0035 + 9.7, z * 0.0035 - 3.1) - 0.5) * 0.62;
        const dirx = -gx / m - (-gz / m) * wob;
        const dirz = -gz / m - (gx / m) * wob;
        const dm = Math.sqrt(dirx * dirx + dirz * dirz) || 1;
        vx = vx * 0.62 + (dirx / dm) * 0.38;
        vz = vz * 0.62 + (dirz / dm) * 0.38;
        const vm = Math.sqrt(vx * vx + vz * vz) || 1;
        x += (vx / vm) * 13; z += (vz / vm) * 13;
        if (Math.abs(x - corridorX(z)) < 640) break;
        if (Math.abs(x) > 3900 || Math.abs(z) > 3900) break;
        const f = n / N;
        const amp = s[3] * Math.min(1, f * 9) * (1 - smoothstep(0.55, 1, f));
        if (amp < 0.5) continue;
        const wr = s[2] * (1 + 0.55 * f);
        const i0 = Math.max(1, Math.ceil((x - wr - MAP_ORIGIN) / MAP_STEP));
        const i1 = Math.min(R - 2, ((x + wr - MAP_ORIGIN) / MAP_STEP) | 0);
        const j0 = Math.max(1, Math.ceil((z - wr - MAP_ORIGIN) / MAP_STEP));
        const j1 = Math.min(R - 2, ((z + wr - MAP_ORIGIN) / MAP_STEP) | 0);
        for (let j = j0; j <= j1; j++) {
          const pz = MAP_ORIGIN + j * MAP_STEP - z;
          for (let i = i0; i <= i1; i++) {
            const px = MAP_ORIGIN + i * MAP_STEP - x;
            const d = Math.sqrt(px * px + pz * pz) / wr;
            if (d >= 1) continue;
            const t = 1 - d;
            const v = amp * t * t * (3 - 2 * t);
            const k = j * R + i;
            if (v > carve[k]) carve[k] = v;
          }
        }
      }
    }
    for (let k = 0; k < R * R; k++) H[k] -= carve[k];
  }

  /**
   * Bedding planes.
   *
   * A limestone face is not a surface, it is a stack: beds tens of metres thick
   * with a soft layer between each pair, and the differential erosion between
   * them puts a ledge system right across every wall. It is the strongest cue
   * there is that a mountain is made of rock rather than of noise, it is where
   * snow sits on ground too steep to hold a slab, and it costs one pass over
   * the grid.
   *
   * Bands are cut along a plane, not along a contour: see `bedPhase`.
   *
   * A second, much coarser member runs in the same pass and is the one that
   * moves a silhouette. Every shape-generating term in `_bake` is a function of
   * the plan coordinates only, and a plan-isotropic field on a 60-degree face
   * renders stretched by tan(60) = 1.7 in screen height on top of the
   * heightfield's own bias towards cross-slope derivatives — which is why the
   * 625 m and 2.2 km ridged bands, isotropic in plan, came out as a fan of
   * vertical folds converging on the valley floor. The same folds, sampled with
   * *elevation* as one of the two axes instead, run round the mountain at
   * constant height and step the buttress rather than draping it. Nothing else
   * in the bake has any way to make a horizontal feature on a wall.
   *
   * Two gates, both load-bearing. Slope, because a ledge system is a feature of
   * a *wall*; and distance from the fall line, because the piste corridor is
   * only blended in over its outer 360 m and a 16 m bed cut into that shoulder
   * is a ski jump. (It was: at a 27-degree slope gate the run-out shoulder
   * picked up enough of a lip to launch the skier on the `ridge` framing and
   * bury the whole shot in spray.)
   */
  _beddingPlanes(H) {
    const R = MAP_RES;
    const bed = new Float32Array(R * R);
    for (let j = 1; j < R - 1; j++) {
      const z = MAP_ORIGIN + j * MAP_STEP;
      const cx = corridorX(z);
      for (let i = 1; i < R - 1; i++) {
        const k = j * R + i;
        const gx = (H[k + 1] - H[k - 1]) * (1 / (2 * MAP_STEP));
        const gz = (H[k + R] - H[k - R]) * (1 / (2 * MAP_STEP));
        const sl2 = gx * gx + gz * gz;
        let m = smoothstep(0.46, 0.95, Math.sqrt(sl2));
        if (m <= 0.02) continue;
        const x = MAP_ORIGIN + i * MAP_STEP;
        // The distance gate is about *skiable* ground: a 16 m bed cut into the
        // piste shoulder is a ski jump. It was a plain smoothstep(520, 900) in
        // |x - centreline|, and that is what hollowed out the two walls flanking
        // the couloir — the ones that own the skyline of every wide shot and
        // that a blind review called the whole remaining gap. Probed: they stand
        // at x = -512 and x = +421 against a centreline at x = -41, i.e. 462 and
        // 471 m out, where the gate is 0.00, and they are 68-77 degrees. Nothing
        // at 70 degrees is reachable and nothing at 70 degrees is a hazard, so
        // steep ground opens the gate on its own and the two smoothest, largest,
        // most-photographed faces in the world stop being the two faces with no
        // rock structure baked into them at all.
        const near = smoothstep(520, 900, Math.abs(x - cx));
        const wall = smoothstep(1.15, 1.70, Math.sqrt(sl2));     // 49..60 deg
        m *= Math.max(near, wall);
        if (m <= 0.02) continue;
        const bs = bedPhase(x, z, H[k]);
        const w = bs - Math.floor(bs);
        const hard = bedHardness(bs);
        // A riser and then a terrace, not a ramp and a drop. The old profile
        // was a symmetric-ish tent, which on a wall is corrugation; this is
        // flat over the back four fifths of every bed and near-vertical across
        // the front fifth, so the face *steps*. `t - w` rather than `t - 0.5`
        // keeps it zero at both ends of the bed, so the steps stack without
        // the stack drifting off the surface it is cut into.
        const b = hard.brk;
        const t = w < b ? w / b : 1;
        // A vertical displacement rotates the normal by 1/(1+|g|^2), so the
        // same bench that reads clearly at 25 degrees is invisible at 60. Give
        // it back, capped — this is the whole reason the bedding could be
        // measured at 80% of the row-profile energy and still not read as rock.
        const comp = 1 + Math.min(sl2, 2.4);
        let v = (t - w) * (2.4 + 4.6 * m) * m * hard.amp * comp * 0.55;

        // --- coarse cliff banding, the member that owns the silhouette ------
        const dm = fbm(x * 0.00042, z * 0.00042, 2);
        const th = 1.10 + 2.60 * dm;
        const c1 = Math.cos(th), s1 = Math.sin(th);
        const uu = x * c1 + z * s1;
        const h = H[k];
        // Buttress steps: 260 m along strike against 105 m of relief, so on a
        // wall they read as terraces four to six hundred metres wide and one
        // to two hundred high — the scale a face is *organised* at.
        const ps = 0.68 + 0.72 * dm;                 // per-domain terrace scale
        const bandA = ridgedMF(uu / (260 * ps), h / (105 * ps), 3) - 0.32;
        // ...and an oblique ramp system across them, so the terraces are cut
        // by something and a gully has a reason to stop.
        const bandB = ridgedMF((uu * 0.80 + h * 0.90) * (1 / 155),
          (h * 0.50 - uu * 0.50) * (1 / 215), 2) - 0.32;
        // Amplitude rises steeply with slope, and not out of taste: a 50 m
        // terrace cut into an 800 m face at 65 degrees is 6% of its relief and
        // the 200-600 m folds the ridged bands put there survive straight
        // through it. The steepest faces are exactly the ones with the least to
        // hold structure and the most screen area, so they get up to 2.6x.
        const slN = Math.sqrt(sl2);
        v += (bandA * 30 + bandB * 19) * m
          * (0.45 + 0.55 * smoothstep(0.8, 1.5, slN))
          * (1 + 1.6 * smoothstep(1.5, 3.1, slN));
        bed[k] = v;
      }
    }
    for (let k = 0; k < R * R; k++) H[k] += bed[k];
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

    // ---- background ranges (twin of GLSL `terrBackdrop`) ----
    {
      const ax = Math.abs(x), az = Math.abs(z);
      const m = ax > az ? ax : az;
      if (m > BD_IN) {
        const t = clamp((m - BD_IN) / (BD_OUT - BD_IN), 0, 1);
        const w = t * t * (3 - 2 * t);
        const dwdm = 6 * t * (1 - t) / (BD_OUT - BD_IN);
        const mx = ax > az ? (x < 0 ? -1 : 1) : 0;
        const mz = ax > az ? 0 : (z < 0 ? -1 : 1);
        const r1 = this._ridgedD(x * BD_F1, z * BD_F1, 3, 0.52);
        const b1 = (r1[0] - 0.30) * BD_A1, g1x = r1[1] * BD_A1 * BD_F1, g1z = r1[2] * BD_A1 * BD_F1;
        const r2 = this._ridgedD(x * BD_F2, z * BD_F2, 2, 0.5);
        const b2 = (r2[0] - 0.33) * BD_A2, g2x = r2[1] * BD_A2 * BD_F2, g2z = r2[2] * BD_A2 * BD_F2;
        const r3 = this._ridgedD(x * BD_F3, z * BD_F3, 2, 0.5);
        const b3 = (r3[0] - 0.33) * BD_A3, g3x = r3[1] * BD_A3 * BD_F3, g3z = r3[2] * BD_A3 * BD_F3;
        const hb = BD_BASE + b1 + b2 + b3;
        h += w * hb;
        dx += w * (g1x + g2x + g3x) + dwdm * hb * mx;
        dz += w * (g1z + g2z + g3z) + dwdm * hb * mz;
      }
    }

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
      const amp2 = 12 * rocky, f2 = 1 / 85;
      const r2 = this._ridgedD(x * f2, z * f2, 1, 0.5);
      mh += (r2[0] - 0.33) * amp2;
      mgx += r2[1] * amp2 * f2; mgy += r2[2] * amp2 * f2;
    }
    // cliff structure — benches, contour lineation, conjugate joint sets
    if (rocky > 0.004) {
      const c = this._cliff(x, z, h, dx, dz, rocky, 1, CLF_VTX_RIB, CLF_VTX_JNT,
        CLF_LIM_V, this._clfOut || (this._clfOut = [0, 0, 0]));
      mh += c[0]; mgx += c[1]; mgy += c[2];
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

  /**
   * Cliff structure — the CPU twin of GLSL `terrCliff`. See the CLF_* block at
   * the top of the file for why steep ground needs its own detail family.
   *
   * `out` receives [dh, d/dx, d/dz]. `gx,gz` is the *macro* gradient, before
   * any detail: the elevation axis of the sampling domain is differentiated
   * through it, and feeding it the already-perturbed gradient would compound.
   */
  _cliff(x, z, h, gx, gz, rocky, gBench, gRib, gJoint, lim0, out) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    if (rocky <= 0.004) return out;

    const dm = latNoise(x * 0.00042, z * 0.00042, _n3)[0];
    const dip = 0.34 + 0.42 * dm;
    const th = 1.10 + 2.60 * dm;
    const c1 = Math.cos(th), s1 = Math.sin(th);
    const u = x * c1 + z * s1;
    const v = -x * s1 + z * c1;
    const cd = Math.cos(dip), sd = Math.sin(dip);
    let dh = 0, dgx = 0, dgz = 0;

    if (gBench > 0.004) {
      // One pitch everywhere is corduroy — the same failure the fall-line comb
      // was, rotated ninety degrees. The pitch is a property of the structural
      // domain, so it rides the same 2.4 km field as the dip and the strike:
      // 19 m beds on one massif, 46 m on the next. (This is a *slow* field on
      // purpose. Dividing the bed plane by a fast noisy period puts a term
      // `-s . dP/P.dx` into the phase gradient that swamps the plane's own —
      // see `bedPhase`, where it was worth four times the carrier. At 2.4 km it
      // is 23% of the carrier: the beds thicken and thin, they do not beat.)
      const pitch = CLF_PITCH * (0.62 + 0.85 * dm);
      const iP = 1 / pitch;
      const s = (h * cd + v * sd) * iP;
      const sx = (gx * cd - s1 * sd) * iP;
      const sz = (gz * cd + c1 * sd) * iP;
      const bi = Math.floor(s), w = s - bi;
      const bu = Math.floor(s * 0.2);
      const b1 = latNoise(bi * 1.618 + 0.5, bi * 2.717 + 3.5, _n3)[0];
      const b2 = latNoise(bu * 1.618 + 11.5, bu * 2.717 + 2.5, _n3)[0];
      const amp = (0.20 + 1.90 * b1 * b1) * (0.34 + 1.40 * b2);
      const riser = 0.18 + 0.40 * b1;
      const t = w < riser ? w / riser : 1;
      const A = (pitch / cd) * Math.min(amp * 0.95, CLF_BENCH) * rocky * gBench;
      const dD = (w < riser ? 1 / riser : 0) - 1;
      dh += A * (t - w); dgx += A * dD * sx; dgz += A * dD * sz;
    }

    if (gRib > 0.004) {
      const fu = 1 / 86, fh = 1 / 24, fs = 1 / 900;
      const r = this._ridgedD(u * fu + h * fs, h * fh + v * 0.0013, 2, 0.5);
      const rv = r[0], ry = r[1], rz = r[2];
      const A = CLF_RIB * rocky * gRib;
      dh += (rv - 0.33) * A;
      dgx += A * (ry * (c1 * fu + gx * fs) + rz * (gx * fh - s1 * 0.0013));
      dgz += A * (ry * (s1 * fu + gz * fs) + rz * (gz * fh + c1 * 0.0013));
    }

    if (gJoint > 0.004) {
      const A = CLF_JNT * rocky * gJoint;
      const fa = 1 / 38, fb = 1 / 64;
      const ra = this._ridgedD((u * 0.82 + h * 0.75) * fa, (h * 0.55 - u * 0.60) * fb, 2, 0.5);
      const av = ra[0], ay = ra[1], az = ra[2];
      dh += (av - 0.33) * A;
      dgx += A * (ay * (c1 * 0.82 + gx * 0.75) * fa + az * (gx * 0.55 - c1 * 0.60) * fb);
      dgz += A * (ay * (s1 * 0.82 + gz * 0.75) * fa + az * (gz * 0.55 - s1 * 0.60) * fb);
      const B = A * 0.8, fc = 1 / 44, fd = 1 / 70;
      const rb = this._ridgedD((u * 0.82 - h * 0.75) * fc, (h * 0.55 + u * 0.60) * fd, 1, 0.5);
      const bv = rb[0], by = rb[1], bz = rb[2];
      dh += (bv - 0.33) * B;
      dgx += B * (by * (c1 * 0.82 - gx * 0.75) * fc + bz * (gx * 0.55 + c1 * 0.60) * fd);
      dgz += B * (by * (s1 * 0.82 - gz * 0.75) * fc + bz * (gz * 0.55 + s1 * 0.60) * fd);
    }

    // Soft clip, relative to the surface being perturbed. A ridged derivative
    // is heavy-tailed — it spikes to five times its typical value — and the
    // members here are deliberately sized to be a large fraction of the macro
    // gradient, so those spikes land at two or three times it. On the mesh that
    // folds; in the fragment program the shading normal tips past horizontal
    // and the rock/snow threshold goes binary, which is the shattered
    // black-and-white foil the mid-field cliffs came back as. A hard clamp puts
    // a visible crease along its own contour, so this is the smooth one.
    const m2 = Math.sqrt(dgx * dgx + dgz * dgz);
    if (m2 > 1e-6) {
      const lim = lim0 * (0.40 + Math.sqrt(gx * gx + gz * gz));
      const k = lim / Math.sqrt(lim * lim + m2 * m2);
      dh *= k; dgx *= k; dgz *= k;
    }

    out[0] = dh; out[1] = dgx; out[2] = dgz;
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
          //
          // The scale height is the whole point of this term and it was set far
          // too high. At Hs = 1500 m the haze column above a 1400 m summit is
          // still 40% of the one at valley level, so a peak 4.5 km out came back
          // 88% air — a flat, pale, blue-white cutout with none of its own
          // radiance left. Measured on the far wall: extinction f = 0.885, and
          // the RMS contrast inside the silhouette fell from 1.29 (no AP) to
          // 0.22. On a real bluebird day the haze is an *aerosol layer* pooled
          // in the valley: scale height 500-800 m, not 1500. Dropping it to
          // 620 m keeps the valley floor deep (f = 0.90 at 3.9 km, unchanged)
          // while the summits climb out of it (f = 0.63), which is the layered
          // depth cue that actually reads as distance.
          //
          // Measured against alpine reference photography (a massif at 6-10 km
          // in clear winter air): RMS contrast 0.63, 5th-95th percentile
          // luminance ratio 10.5:1, B/R 1.30. This build at the old settings
          // gave 0.38 / 3.1:1 / 2.04 — the highlights were fine, the *blacks*
          // were lifted three and a half times, which is exactly what an
          // additive air-light term does when its optical depth is too large.
          // At 0.34 x the sky's density we measure 0.51 / 4.7:1 / 1.80.
          //
          // The clamp is deliberate. The sky module owns the haze and is free
          // to retune its own density, but this term is the one thing standing
          // between the far field and either a flat blue wash or a razor-sharp
          // cut-out, so it is held inside the band that keeps a 4.5 km ridge at
          // 55-70% of its own contrast whatever the sky decides to do.
          u.uAerialDensity.value = clamp(scene.fog.density * 0.34, 0.00026, 0.00062);
          u.uAerialHeight.value = 620;
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

// Cliff structure. The CPU twin is Terrain._cliff; the reasoning is in the
// CLF_* block at the top of this file. 'gm' must be the *macro* gradient, i.e.
// before any detail band, because the sampling domain differentiates through it.
void terrCliff( vec2 p, float h, vec2 gm, float rocky,
                float gBench, float gRib, float gJoint, float lim0,
                out float dh, out vec2 dg ) {
  dh = 0.0;
  dg = vec2( 0.0 );
  if ( rocky <= 0.004 ) return;

  float dm = latNoise( p * 0.00042 ).x;
  float dip = 0.34 + 0.42 * dm;
  float th  = 1.10 + 2.60 * dm;
  float c1 = cos( th ), s1 = sin( th );
  float u =  p.x * c1 + p.y * s1;
  float v = -p.x * s1 + p.y * c1;
  vec2 eu = vec2( c1, s1 ), ev = vec2( -s1, c1 );
  float cd = cos( dip ), sd = sin( dip );

  if ( gBench > 0.004 ) {
    float pitch = ${CLF_PITCH.toFixed(1)} * ( 0.62 + 0.85 * dm );
    float iP = 1.0 / pitch;
    float s = ( h * cd + v * sd ) * iP;
    vec2 dsdp = ( gm * cd + ev * sd ) * iP;
    float bi = floor( s ), w = s - bi;
    float bu = floor( s * 0.2 );
    float b1 = latNoise( vec2( bi * 1.618 + 0.5, bi * 2.717 + 3.5 ) ).x;
    float b2 = latNoise( vec2( bu * 1.618 + 11.5, bu * 2.717 + 2.5 ) ).x;
    float amp = ( 0.20 + 1.90 * b1 * b1 ) * ( 0.34 + 1.40 * b2 );
    float riser = 0.18 + 0.40 * b1;
    float t = w < riser ? w / riser : 1.0;
    float A = ( pitch / cd ) * min( amp * 0.95, ${CLF_BENCH.toFixed(3)} ) * rocky * gBench;
    dh += A * ( t - w );
    dg += A * ( ( w < riser ? 1.0 / riser : 0.0 ) - 1.0 ) * dsdp;
  }

  if ( gRib > 0.004 ) {
    const float fu = ${(1 / 86).toFixed(9)}, fh = ${(1 / 24).toFixed(9)}, fs = ${(1 / 900).toFixed(9)};
    vec3 r = terrRidgedD( vec2( u * fu + h * fs, h * fh + v * 0.0013 ), 2, 0.5 );
    float A = ${CLF_RIB.toFixed(3)} * rocky * gRib;
    dh += ( r.x - 0.33 ) * A;
    dg += A * ( r.y * ( eu * fu + gm * fs ) + r.z * ( gm * fh + ev * 0.0013 ) );
  }

  if ( gJoint > 0.004 ) {
    float A = ${CLF_JNT.toFixed(3)} * rocky * gJoint;
    const float fa = ${(1 / 38).toFixed(9)}, fb = ${(1 / 64).toFixed(9)};
    vec3 ra = terrRidgedD( vec2( ( u * 0.82 + h * 0.75 ) * fa,
                                 ( h * 0.55 - u * 0.60 ) * fb ), 2, 0.5 );
    dh += ( ra.x - 0.33 ) * A;
    dg += A * ( ra.y * ( eu * 0.82 + gm * 0.75 ) * fa
              + ra.z * ( gm * 0.55 - eu * 0.60 ) * fb );
    float B = A * 0.8;
    const float fc = ${(1 / 44).toFixed(9)}, fd = ${(1 / 70).toFixed(9)};
    vec3 rb = terrRidgedD( vec2( ( u * 0.82 - h * 0.75 ) * fc,
                                 ( h * 0.55 + u * 0.60 ) * fd ), 1, 0.5 );
    dh += ( rb.x - 0.33 ) * B;
    dg += B * ( rb.y * ( eu * 0.82 - gm * 0.75 ) * fc
              + rb.z * ( gm * 0.55 + eu * 0.60 ) * fd );
  }

  // Soft clip relative to the surface being perturbed — see the JS twin.
  float m2 = length( dg );
  if ( m2 > 1e-6 ) {
    float lim = lim0 * ( 0.40 + length( gm ) );
    float k = lim * inversesqrt( lim * lim + m2 * m2 );
    dh *= k; dg *= k;
  }
}

// Background ranges beyond the baked map. The CPU twin lives in _sample().
// Outside a 8.2 km square the baked texture can only replicate its edge texel,
// which is the -42 m taper plain — a dead-flat table stretching to the 19.7 km
// clipmap limit. This replaces it with an analytic ridged field so the skyline
// keeps receding into snow ranges instead of ending at a horizontal edge.
void terrBackdrop( vec2 p, inout float h, inout vec2 g ) {
  vec2 a = abs( p );
  float m = max( a.x, a.y );
  if ( m <= ${BD_IN}.0 ) return;
  float t = clamp( ( m - ${BD_IN}.0 ) * ${(1 / (BD_OUT - BD_IN)).toFixed(9)}, 0.0, 1.0 );
  float w = t * t * ( 3.0 - 2.0 * t );
  float dwdm = 6.0 * t * ( 1.0 - t ) * ${(1 / (BD_OUT - BD_IN)).toFixed(9)};
  vec2 dm = a.x > a.y ? vec2( p.x < 0.0 ? -1.0 : 1.0, 0.0 )
                      : vec2( 0.0, p.y < 0.0 ? -1.0 : 1.0 );

  vec3 r1 = terrRidgedD( p * ${BD_F1.toFixed(9)}, 3, 0.52 );
  vec3 r2 = terrRidgedD( p * ${BD_F2.toFixed(9)}, 2, 0.5 );
  vec3 r3 = terrRidgedD( p * ${BD_F3.toFixed(9)}, 2, 0.5 );
  float hb = ${BD_BASE}.0
    + ( r1.x - 0.30 ) * ${BD_A1}.0
    + ( r2.x - 0.33 ) * ${BD_A2}.0
    + ( r3.x - 0.33 ) * ${BD_A3}.0;
  vec2 gb = r1.yz * ${(BD_A1 * BD_F1).toFixed(6)}
          + r2.yz * ${(BD_A2 * BD_F2).toFixed(6)}
          + r3.yz * ${(BD_A3 * BD_F3).toFixed(6)};
  h += w * hb;
  g += w * gb + dwdm * hb * dm;
}

/** terrMacro + the analytic backdrop. Every call site wants both. */
void terrField( vec2 p, out vec4 data, out vec2 grad, out vec2 cgrad ) {
  terrMacro( p, data, grad, cgrad );
  float hh = data.x;
  terrBackdrop( p, hh, grad );
  data.x = hh;
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
    terrField( P.xz, md, mg, mc );
    vec2 mMacroG = mg;                       // macro-only: the masks are keyed on it
    float mslope = length( mg );
    float mrocky = smoothstep( 0.62, 1.15, mslope );

    // --- band gating -----------------------------------------------------
    // The vertex program has to retire a detail band once the *mesh* can no
    // longer carry it — a 58 m feature on a 100 m ring is nonsense. The
    // fragment program is under no such constraint: it only writes a normal,
    // and a normal stays well defined for as long as the feature is bigger
    // than a pixel. Inheriting the vertex program's distance fades is what
    // emptied the far field: past 2.4 km every band had expired, so a 4 km
    // face carried nothing but the 200 m ridges and shaded as a smooth cone —
    // the cardboard-cutout skyline. The honest gate here is the world size of
    // a pixel, anisotropy-capped at 3:1 exactly as the snow bands are.
    //
    // The footprint itself must not be read off dFdx( P.xz ). An interpolated
    // world position is affine within a triangle and its screen derivative is
    // therefore *constant* per triangle and steps at every edge — on a 25-100 m
    // ring the step between the two triangles of one quad is tens of percent.
    // Anything keyed on it inherits a mesh-shaped discontinuity, which is how a
    // gate meant to retire a band ends up drawing the tessellation.
    //
    // The view ray, by contrast, is a function of the pixel alone: P lies on it
    // by construction, so ( P - eye ) / |P - eye| is the same field whichever
    // triangle the fragment came from, and its screen derivative is continuous
    // across the whole frame. Sliding that ray spread onto the locally
    // reconstructed surface plane gives the same footprint with no seam.
    vec3 mrd = ( P - cameraPosition ) / max( snViewDist, 1e-4 );
    vec3 mnm = normalize( vec3( -mMacroG.x, 1.0, -mMacroG.y ) );
    float mrn = min( dot( mrd, mnm ), -0.125 );         // ray vs. surface, stretch capped at 8:1
    vec3 mfx = dFdx( mrd ) * snViewDist;
    vec3 mfy = dFdy( mrd ) * snViewDist;
    float mpA = length( ( mfx - mrd * ( dot( mfx, mnm ) / mrn ) ).xz );
    float mpB = length( ( mfy - mrd * ( dot( mfy, mnm ) / mrn ) ).xz );
    float mpHi = max( mpA, mpB ), mpLo = max( min( mpA, mpB ), 1e-5 );
    float mPx = mpHi / min( mpHi / mpLo, 3.0 );
    #define TERR_BAND( lambda ) smoothstep( 2.0, 4.6, ( lambda ) / mPx )

    // --- snowline raggedness ------------------------------------------------
    // Every band below is retired once its wavelength drops under ~4.6 pixels.
    // That is the right call for a shading normal and the wrong one for a
    // *threshold*: under the cut-off the field the rock mask cuts is perfectly
    // smooth, and a smooth field cut by a hard threshold gives a smooth curve.
    // On a couloir wall, where foreshortening puts the finest surviving band at
    // 60-100 m, "smooth curve" means a ruled line ten or twenty pixels long —
    // 27.8% of the snowline on the ridge crop sat on a straight run of ten
    // pixels or more, against 13.6% for the Eiger reference.
    //
    // Adding wobble to the slope *value* does almost nothing about that: near
    // the snowline the field's own gradient is dominated by the ridged bands, so
    // a tenth of a radian moves the boundary a pixel or two. Warping the sample
    // *point* does, because the iso-line of a warped field moves by exactly the
    // warp however steep the field is — the same argument snow-material.js makes
    // for its own macro warp, one scale further down.
    //
    // Locked to the pixel and not to the world, because the whole problem is
    // precisely that no world-locked band survives out here. Twenty-six pixels
    // of the *coarser* screen axis, so it is resolved several times over on both
    // however grazing the face, with a second octave at a third of that; and it
    // is faded out again wherever a pixel covers less than about a third of a
    // metre, i.e. wherever the world-locked bands still do the job themselves.
    //
    // It is the sample point of the detail cascade that moves, not the macro
    // field, so the massif keeps its shape, its ridgelines and its aerial
    // planes: all that changes is which metre of rock relief lands under a given
    // pixel, and with it where the mask's threshold falls.
    vec2 Pd = P.xz;
    {
      float wAmt = smoothstep( 0.10, 0.30, mpHi );
      if ( wAmt > 0.004 ) {
        float lamW = min( 26.0 * mpHi, 700.0 );
        float iw = 1.0 / lamW;
        float wa = latNoise( P.xz * iw + vec2( 17.3, -4.1 ) ).x - 0.5;
        float wb = latNoise( P.xz * iw + vec2( -8.7, 23.4 ) ).x - 0.5;
        float wc = latNoise( P.xz * ( iw * 2.7 ) + vec2( 5.1, 41.7 ) ).x - 0.5;
        float wd = latNoise( P.xz * ( iw * 2.7 ) + vec2( -31.2, 7.9 ) ).x - 0.5;
        Pd += ( vec2( wa, wb ) * 0.90 + vec2( wc, wd ) * 0.14 ) * ( lamW * wAmt );
      }
    }

    if ( mrocky > 0.002 ) {
      mg += terrRidgedD( Pd * ( 1.0 / 200.0 ), 2, 0.5 ).yz * ( 24.0 * mrocky / 200.0 );
      float fC = TERR_BAND( 85.0 );
      if ( fC > 0.004 ) {
        mg += terrRidgedD( Pd * ( 1.0 / 85.0 ), 1, 0.5 ).yz * ( 12.0 * mrocky * fC / 85.0 );
      }
    }
    float fA = TERR_BAND( 64.0 );
    float fB = TERR_BAND( 58.0 );
    float fD = TERR_BAND( 22.0 );
    if ( fA > 0.004 ) {
      float amp = ( 2.2 * ( 1.0 - mrocky ) + 1.6 * mrocky ) * fA * ( 1.0 / 64.0 );
      mg += terrFbmD( Pd * ( 1.0 / 64.0 ), 4, 0.5 ).yz * amp;
    }
    if ( fB > 0.004 && mrocky > 0.004 ) {
      float amp = 11.5 * mrocky * fB * ( 1.0 / 58.0 );
      mg += terrRidgedD( Pd * ( 1.0 / 58.0 ), 4, 0.52 ).yz * amp;
    }
    // Buttress / couloir band. 22 m is five pixels at 4 km and fifty at 400 m,
    // so it lives all the way to the horizon and is what puts ribs, gullies and
    // snow-holding ledges on a distant face. Fragment-only by necessity: the
    // outer clipmap rings are 25-100 m per cell and could never displace it.
    // ...but plan-isotropic, so on a wall it renders as a vertical comb (see
    // the CLF_* block). Half of its energy on bedrock is handed to terrCliff,
    // which puts the same relief in at angles that are not the fall line.
    if ( fD > 0.004 && mrocky > 0.004 ) {
      float amp = 6.2 * mrocky * fD * ( 1.0 - 0.5 * mrocky ) * ( 1.0 / 22.0 );
      mg += terrRidgedD( Pd * ( 1.0 / 22.0 ), 3, 0.5 ).yz * amp;
    }

    // Cliff structure: benches, contour lineation, conjugate joints. Fragment
    // side is the important one — the walls that read as drape are 1.5-3 km
    // out, where every clipmap ring is 12-100 m per cell and no displacement
    // band survives, so the whole surface reading comes from here.
    if ( mrocky > 0.004 ) {
      float cdh; vec2 cdg;
      terrCliff( Pd, md.x, mMacroG, mrocky,
                 TERR_BAND( 26.0 ), TERR_BAND( 34.0 ), TERR_BAND( 30.0 ),
                 mix( ${CLF_LIM_V}, ${CLF_LIM_F}, smoothstep( 700.0, 1500.0, snViewDist ) ),
                 cdh, cdg );
      mg += cdg;
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
  terrField( P, mdata, mgrad, mcgrad );

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
    // 85 m band. It used to be faded out past 3 km, which is precisely the
    // range where it is the *only* thing left serrating a skyline: an 85 m
    // wavelength is still 3.3 cells on the 25.6 m ring that draws a 4 km peak,
    // and 12 m of relief at that range is about three pixels of tooth on the
    // silhouette. Without it the outer peaks are drawn by the 200 m band alone
    // and come out as smooth cones. Kept unfaded so the CPU twin agrees.
    {
      float amp2 = 12.0 * rocky, f2 = 1.0 / 85.0;
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
  // Cliff structure — the near-field half of the fragment block. Real
  // displacement, so it moves the silhouette of a buttress within ~2 km; past
  // that the rings cannot carry a 30 m feature and only the shading normal
  // survives. Differentiated through the *macro* gradient, hence mgrad.
  //
  // The two ridged members run at ~a third of their fragment-side amplitude
  // here, and that split is load-bearing rather than cosmetic. Their gradient
  // is a fixed multiple of the macro gradient (that is the whole point of
  // sampling against elevation), and at the amplitude a 2 km wall needs — where
  // the ring is 25 m per cell and the fragment program is doing the shading
  // anyway — the same term is roughly twice the base slope. On a 0.4 m ring
  // 200 m from the camera that folds the mesh, and a folded heightfield is a
  // field of spikes: the 'ridge' framing came back as shattered foil. A normal
  // cannot fold, so the fragment side keeps the full amount; the geometry gets
  // what it can carry. The bench is exempt — it is monotone along the bed
  // normal by construction and can only flatten a terrace and steepen a riser.
  if ( rocky > 0.002 ) {
    float cdh; vec2 cdg;
    float cFar = smoothstep( 2000.0, 1000.0, fd );
    terrCliff( P, mdata.x, mgrad, rocky,
               cFar, cFar * ${CLF_VTX_RIB}, smoothstep( 1500.0, 800.0, fd ) * ${CLF_VTX_JNT},
               ${CLF_LIM_V}, cdh, cdg );
    h += cdh;
    g += cdg;
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
