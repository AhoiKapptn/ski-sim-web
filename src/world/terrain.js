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
 * A geometry clipmap: 8 concentric levels, cell size 0.4 m -> 51.2 m, reaching
 * 12.3 km at the `ultra` mesh tier — just past the camera's 12 km far plane, on
 * purpose. Levels are positioned by the model matrix and displaced entirely on
 * the GPU, so moving the camera costs zero CPU work — no re-tessellation, ever.
 * The *ring resolution* is not constant: it ramps from 96 up to 512 with the
 * level, because a uniform-resolution clipmap facets its far rings exactly as
 * badly as its near ones (see MESH_TIERS).
 *
 * That ramp is a **quality tier**, not a constant: `setMeshQuality('low' |
 * 'medium' | 'high' | 'ultra')` rebuilds the ring geometries, and the four tiers
 * span 1.19 M -> 0.55 M triangles. There used to be a ninth level and the outer
 * rings were assumed to be "close to free" because they take the cheap vertex
 * path; that was measured at DPR 1, and at the resolution the game is played at
 * the ninth level turned out to be entirely outside the far plane — 401 k
 * triangles a frame for zero pixels. See MESH_TIERS for that story, for what each
 * tier costs you in the skyline, and for the coupling to `camera.far`.
 *
 * Beyond the geometry, the fragment program re-runs the same bicubic
 * reconstruction per pixel past ~400 m, so shading normals and terrain data
 * channels in the far field come from the field itself rather than from an
 * interpolated 25-100 m triangle. Its detail bands are gated on the *world size
 * of a pixel*, not on distance: the vertex program has to retire a band when the
 * mesh can no longer carry it, the fragment program only has to keep it above
 * Nyquist, and conflating the two is what left a 4 km face with nothing on it.
 *
 * The snow park
 * -------------
 * Six hand-authored jump features — a roller, a step-down, two kickers, a
 * booter and a hip — are swept down the piste corridor, their lips between
 * z = 645 and z = -120 and their run-outs reaching z = 659 to -212. They are
 * NOT in the bake: at 8 m per texel a 12 m kicker smears into a ramp. They are
 * an analytic member of the micro-detail layer, generated once into GLSL from
 * the same resolved knot table the CPU sampler reads, so the physics surface
 * and the mesh are the same surface by construction. See the PARK_PROFILES
 * block for the shape language and the placement rules.
 *
 * `terrain.jumps` is the public description of that line, one entry per
 * feature, all in world units:
 *
 *   { name, kind, size,            roller|stepdown|hip|kicker|booter; small..xl
 *     x, z, y,                     THE LIP — the crest of the ramp, t = 0
 *     dir, ax, az,                 axis heading (physics convention) and unit vector
 *     m0,                          grade the feature was cut for
 *     lipH, deckH, deckLen,        lip height over grade, table height, table length
 *     lipT,                        crest offset from t = 0; 0 by construction
 *     landingX, landingZ,          where the landing crosses grade — the aim point
 *     landingT,                    ...as a distance along the axis
 *     lipZ, runOut, width,
 *     t0, t1, w0, w1, iwf,         extent along/across the axis
 *     kt, ks, kd }                 resolved profile knots (t, dD/dt, D)
 *
 * Nothing else in the repo reads it yet. It is there so signage, HUD cues, park
 * spray or an AI line can be hung off the same numbers rather than a second
 * guess at where the kickers are.
 *
 * Background
 * ----------
 * Outside the 8.2 km baked square the texture can only replicate its edge texel
 * — a -42 m plain running to the clipmap limit (19.7 km when this was written,
 * 12.3 km since the ring trim), which read as a hard
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
// So the resolution ramps with the level instead. The outer rings run the
// *cheap* vertex path (the metre-scale detail layers have already faded out
// there) so they are close to pure bandwidth, and the near rings — which carry
// the expensive noise — stay at 96. That the ramp itself is cheap does hold up
// under measurement (rings 7-8 together are not resolvable, see below); what did
// not hold up is the assumption that "cheap" made it free to point the ramp at
// ground the camera cannot reach.
//
// Level 6 runs at 512, not 384. That is the level that draws everything from
// 2.0 km out, i.e. the entire skyline, and at 384 its cells are 25-100 m: a 4 km
// peak was being silhouetted by ~6 px triangles and its crest came out as a run
// of smooth chords. 512 takes that to 19-77 m and visibly serrates the
// ridgelines. (The "measured cost at 1600x900 was nil, 60.3 fps against 60.0"
// that once justified applying 512 to levels 7 and 8 as well is deleted: 1.44
// Mpx at DPR 1, and an fps difference of 0.3 — CLAUDE.md traps 1 and 5 between
// them invalidate the method, the resolution and the metric. What replaced it is
// below.)
//
// Nesting constraint: hole(k) * cell(k) / 2 == extent(k-1), i.e. hole(k) must be
// res(k-1)/2 exactly, or the rings gap. Derived, never written by hand — see
// levelHoles() below, which also asserts it.
//
// -----------------------------------------------------------------------------
// What LEVEL_RES actually controls, stated precisely, because the paragraph
// above reads as if it set the cell size and it does not.
//
// A level's cell size is pinned by the level index alone: cell(k) = CELL0 * 2^k,
// i.e. 0.4 m at level 0 through 51.2 m at level 7, whatever the resolution is.
// What res(k) sets is the ring's half-extent, res(k) * cell(k) / 2 — that is,
// **the radius at which the cell size doubles.** Raising res(6) from 384 to 512
// did not refine level 6's cells; it pushed level 6's outer boundary from 4.9 km
// to 6.6 km, so the ground between those two radii is now drawn at 25.6 m per
// cell instead of 51.2 m. That is the mechanism behind the skyline note above,
// and it is also why res is the only knob here: you cannot buy triangles back
// from the far field without moving a doubling radius inward. It is also why
// trimming the LAST ring costs no facet quality at all — there is no ring behind
// it to hand the ground to, so all it can lose is reach.
//
// Half-extents at `ultra` (metres): 19, 38, 102, 256, 614, 2048, 6554, 12288.
//
// -----------------------------------------------------------------------------
// There were nine levels. There are eight, and CAM_FAR is why.
//
// Level 8 (cell 102.4 m, res 512) had its NEAREST geometry at a Chebyshev
// distance of hole/2 * cell = 128 * 102.4 = 13,107 m from the player, and the
// camera's far plane is 12,000 m (engine.js:859). The entire ring was outside the
// frustum by a kilometre and could not produce a pixel — a coverage probe over
// all five shoot.mjs framings measured 0 visible pixels in four of them and 2 px
// in the fifth. `frustumCulled = false` (deliberate: displacement happens in the
// vertex program, so three's bounds cannot decide anything) meant nothing stopped
// it being submitted: 401,408 triangles and 202,240 invocations of the expensive
// displacement vertex program every frame for guaranteed zero output.
//
// So the ring count is now COUPLED TO camera.far. cell(k) = 0.4 * 2^k and a
// ring's near edge is hole(k)/2 * cell(k), so a ring is dead when that exceeds
// CAM_FAR. Add a level back only together with a bigger far plane, and check
// meshReach() below against it.
//
// Level 7 nearly went the same way. Measured visible pixels across the five
// framings: 7194 / 0 / 315 / 49 / 189 out of 1.44 Mpx — at most 0.5% of the
// frame, usually under 0.02%, against 401,408 triangles. That is 0.018 pixels per
// triangle: every one of them sub-pixel, and a sub-pixel triangle still costs a
// full 2x2 fragment quad. At `ultra` it is trimmed 512 -> 480, which is the
// smallest multiple of 32 whose half-extent (12,288 m) still contains the
// far-plane disc of 12,000 m — a square of half-extent E contains the disc of
// radius E, so this is exact frustum coverage with 288 m of slack for the chase
// camera sitting behind the clipmap centre. Its cell size is unchanged at 51.2 m,
// so nothing that was visible changes its facet size; only ground that was
// already unrenderable goes. 401,408 -> 337,408 triangles for provably no
// visual difference.
//
// Not 320 (8.2 km), which was the other candidate: 8.2-12 km is INSIDE the far
// plane, and ring 7 does measurably paint up to 7,194 px, so cutting there is a
// visible-terrain decision rather than a dead-geometry one. That belongs in a
// tier, and it is `high` below.
//
// -----------------------------------------------------------------------------
// Why the rest of it is a tier and not a constant.
//
// Measured at the resolution the game is actually played at (2560x1440 DPR 2 =
// 14.75 Mpx, native frame p50 48.8 ms), and read carefully, because the first
// reading of it was wrong:
//
//     hiding rings 6,7,8    8.90 ms @ 5.31 Mpx   10.40 ms @ 9.44 Mpx
//     hiding rings 5..8     9.70 ms              12.90 ms
//     hiding rings 7,8 ONLY  not resolvable: median 0.6 ms, sign 6/10
//
// The first two barely scale with pixel count, which looks like vertex cost —
// but the third arm says otherwise: rings 7 and 8 together are not measurable.
// Nearly all of that 9-10 ms is ring 6, and ring 6 is the ring that actually
// paints pixels, so it is a FRAGMENT problem and it belongs to the shader, not
// to this table. Do not justify a tier here with "7 ms of vertex cost in the
// outer rings"; that number does not exist. Rings 7-8 were a waste-and-
// correctness problem — geometry submitted for pixels that cannot happen — and
// the fix for those is above, unconditional, at every tier.
//
// What is left for the tiers is the honest tradeoff: triangles against where the
// cell size doubles, and therefore how finely a ridgeline is silhouetted.
//
//   ultra   1.185 M tris, reach 12.3 km. Doubling radii 2.0/6.6 km. The only
//           change from the nine-level build is the removal of geometry that
//           could not be rendered, so this IS the old top of the ladder: nothing
//           can regress here.
//   high    0.927 M (78% of ultra). Level 6 stays at 512, so the whole
//           2.0-6.6 km band — where the reviewed skyline lives, and where the
//           bake's background wall and the first backdrop range silhouette —
//           keeps its 25.6 m cells and serrates exactly as ultra does. The only
//           loss is reach, 12.3 -> 8.2 km: ground that measured a few hundred
//           pixels a frame and that the aerial perspective term has already
//           taken to 1-3% of its own contrast.
//   medium  0.753 M (64%). Now the skyline band itself is trimmed: level 6 goes
//           512 -> 384, moving the 51.2 m doubling radius in from 6.6 km to
//           4.9 km. A 5-6 km crest is silhouetted by 51.2 m cells instead of
//           25.6 m, i.e. this is the tier where the smooth-chord failure the 512
//           bump was made to fix could start to come back — at 5-6 km rather
//           than at 4 km, so it is the far ranges rather than the massif. Shot
//           and magnified 3x on `hero`: the crest is still serrated at several
//           scales with no straight chords, and there is no horizon gap. It is
//           still the interesting arm; re-check it after any bake change.
//   low     0.553 M (33%). Trims level 5 as well (320 -> 256), the first cut that
//           touches ground inside 2 km, and reach falls to 6.6 km. For a machine
//           that has to choose between the skyline and a playable frame.
//
// One coupling to know about before adding a tier below `low`. The vertex
// program's detail fades (fadeA/fadeB/fadeM in GLSL_DISPLACE_BODY) were placed
// where "the ring cell size stops being able to carry the band", i.e. against
// the doubling radii of `ultra`. Moving a radius inward moves a band onto
// coarser cells while it is still partly faded in. It does not fold — the soft
// clip in GLSL_DISPLACE_BODY and its CPU twin limit |dg| relative to the surface
// gradient, not to the cell size — and `height()` is unaffected either way,
// since it never asks what tier is loaded. It can only alias. The one place that
// gets close is `low`, which moves the 12.8 -> 25.6 m radius in from 2048 m to
// 1638 m where fadeA is still ~0.4. That is the reason `low` stops there instead
// of trimming level 5 harder.
//
// Levels 0-4 are identical in every tier and always will be: they are the ground
// under the skier, they carry the metre-scale detail bands, and they are 175 k
// triangles — 15% of ultra. There is nothing to win there and a physics-visual
// mismatch to lose.
//
// Where triangles per pixel stops being worth anything: a ring's angular cell
// size is 2/res rad at its outer edge and 4/res(k-1) at its inner edge, so at
// 2560 px across a ~60 deg horizontal FOV (~2450 px/rad) a 512-ring spans
// 9.6 px at its outer edge and 30 px at its inner one. That sounds generous
// until you remember the far field is seen at grazing incidence: the cell is
// foreshortened to well under a pixel *vertically* while staying tens of pixels
// wide. Ring 7's measured 0.018 px per triangle is that end state, and it is why
// the ladder is a tier and not a smooth dial: past the point where a triangle
// covers a fragment quad the extra ones can only buy silhouette, never surface,
// so the only thing that changes visibly is which doubling radius the skyline
// happens to fall on.
const MESH_TIERS = {
  ultra:  [96, 96, 128, 160, 192, 320, 512, 480],
  high:   [96, 96, 128, 160, 192, 320, 512, 320],
  medium: [96, 96, 128, 160, 192, 320, 384, 320],
  low:    [96, 96, 128, 160, 192, 256, 320, 256],
};
const MESH_TIER_NAMES = ['low', 'medium', 'high', 'ultra'];
const DEFAULT_MESH_TIER = 'ultra';

const CELL0 = 0.4;             // finest cell size, metres
const LEVEL_RES = MESH_TIERS[DEFAULT_MESH_TIER];
const LEVELS = LEVEL_RES.length;
// The camera's far plane, engine.js:859. Mirrored here rather than imported —
// terrain.js has no dependency on the engine and should not gain one — so it is
// asserted below instead of trusted. If the two ever disagree the top tier stops
// covering the frustum, which reads as a wedge of sky where the far ranges were.
const CAM_FAR = 12000;

// The nesting constraint, derived and enforced in one place. hole(k) must be
// exactly res(k-1)/2 or the rings gap and the terrain tears along a ring
// boundary; the lattice indices also have to come out integral, or
// buildLevelGeometry's `lo`/`hi` land between vertices and the hole is cut in
// the wrong place. Both are checked here rather than trusted, because a tier
// table is exactly the kind of thing a future edit adds a row to.
function levelHoles(res) {
  const hole = res.map((_, k) => (k === 0 ? 0 : res[k - 1] / 2));
  for (let k = 1; k < res.length; k++) {
    const r = res[k], h = hole[k];
    if (!Number.isInteger(h)) {
      throw new Error(`terrain: res[${k - 1}] = ${res[k - 1]} is odd, so hole[${k}] is not integral`);
    }
    if (h >= r) {
      throw new Error(`terrain: hole[${k}] = ${h} >= res[${k}] = ${r}; ring ${k} would be empty or inverted`);
    }
    if ((r - h) % 2 !== 0) {
      throw new Error(`terrain: res[${k}] - hole[${k}] = ${r - h} is odd; the hole would not be centred on the lattice`);
    }
  }
  return hole;
}

function normalizeMeshTier(tier) {
  if (typeof tier === 'string') {
    const t = tier.toLowerCase();
    if (MESH_TIERS[t]) return t;
  }
  return DEFAULT_MESH_TIER;
}

/** Half-extent of each ring, metres. Element k is the radius at which the cell
 *  size doubles; the last element is the clipmap's reach. */
function levelExtents(res) {
  return res.map((r, k) => r * (CELL0 * Math.pow(2, k)) / 2);
}

/** Chebyshev distance from the clipmap centre to a ring's nearest geometry: the
 *  inner edge of its hole. A ring whose near edge is past the far plane cannot
 *  produce a pixel — that is how level 8 was found. */
function levelNearEdges(res) {
  const hole = levelHoles(res);
  return res.map((_, k) => hole[k] * (CELL0 * Math.pow(2, k)) / 2);
}

// Fail at module load, not at the first settings change, if a tier row is bad.
// A tier table is exactly the kind of thing a future edit adds a row to, and
// three of the four checks below are for mistakes that render as a tear or a
// wedge of sky rather than as an error.
for (const name of MESH_TIER_NAMES) {
  if (MESH_TIERS[name].length !== LEVELS) {
    throw new Error(`terrain: mesh tier '${name}' has ${MESH_TIERS[name].length} levels, expected ${LEVELS}`);
  }
  const res = MESH_TIERS[name];
  levelHoles(res);
  // No dead rings, at any tier: a ring entirely outside the far plane is pure
  // submitted-and-discarded vertex work. This is the check that level 8 failed.
  const near = levelNearEdges(res);
  for (let k = 0; k < near.length; k++) {
    if (near[k] >= CAM_FAR) {
      throw new Error(`terrain: mesh tier '${name}' ring ${k} starts at ${near[k]} m, past camera.far = ${CAM_FAR} m; it cannot render a pixel`);
    }
  }
}
// ...and the TOP tier must cover the whole frustum. A square of half-extent E
// contains the disc of radius E, so reach >= CAM_FAR is exact coverage. Only
// asserted for the top tier: the lower ones trade reach away on purpose.
{
  const top = MESH_TIER_NAMES[MESH_TIER_NAMES.length - 1];
  const reach = levelExtents(MESH_TIERS[top]).pop();
  if (reach < CAM_FAR) {
    throw new Error(`terrain: top mesh tier '${top}' reaches ${reach} m, inside camera.far = ${CAM_FAR} m; the far ranges would end in mid-air`);
  }
}

// Prevailing wind, world XZ. Must match `uWindDir` in snow-material.js: the
// cornice displacement and the shader's wind-loading masks have to agree.
const WIND_X = 0.82, WIND_Z = 0.57;

// --- background ranges -------------------------------------------------------
// The baked field covers 8.2 km (i.e. +-4.1 km) and clamps to a -42 m plain
// outside it, while the clipmap reaches 12.3 km — 19.7 km when this was written,
// and the argument is unchanged by the ring trim: what matters is that the
// clipmap outruns the bake, not by how much. Everything between the two was a
// dead-flat white
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

/**
 * Half-width of the fully-blended piste. Step 5 of `_bake` drives the surface
 * all the way onto the corridor profile inside this radius and releases it to
 * the raw massif by 560 m; snow-material.js grooms out to 150 m and stops at
 * 330. The park lives well inside all three.
 */
const PISTE_HALF = 200;

// =============================================================================
// The snow park
// =============================================================================
// Why these are here and not in `_bake`
// -------------------------------------
// The macro field is one texel per 8 m. A kicker is 10-15 m from transition to
// knuckle and its whole character is a lip you could cut yourself on, so baking
// one would smear it into a ramp and alias it as the clipmap slides. So the
// park is an *analytic* member of the micro-detail layer, evaluated identically
// by `_jumpsAt` (CPU, authoritative for physics) and by the generated
// `terrJumps` (GPU, vertex displacement and far-field fragment normal). Both
// read the same resolved numbers because `_jumpGLSL` emits them as literals
// straight out of the table `_placeJumps` built — there is no second authoring
// of the shape and therefore nothing to drift.
//
// The shape language
// ------------------
// A feature is a one-dimensional profile swept along its own downhill axis and
// windowed across it. The profile is authored as *absolute surface angles* —
// "the ramp climbs at 6.6 degrees, the landing falls at 26" — not as heights,
// because that is how a shaper thinks and because the piste under the park runs
// anywhere between 12 and 17 degrees. `_placeJumps` measures the real grade m0
// at each anchor and converts: the stored quantity is the offset slope
// `s = m0 - mAbs`, i.e. how fast the feature climbs away from the hill it is
// built on. Height is the integral of that, so:
//
//   - the feature is a pure additive perturbation that starts and ends at
//     exactly zero, whatever the ground does underneath it;
//   - `s` is piecewise linear between knots, so height is piecewise quadratic:
//     C1 everywhere, exact analytic gradient, no springs at the seams;
//   - the run-out length is not authored, it is *solved* — the last segment is
//     however long it has to be to bring the accumulated offset back to zero
//     with zero slope. That is what makes the closure exact instead of
//     hand-fitted.
//
// The vocabulary is real: a compacted flat run-in, a transition that curls up
// into a straight ramp, a lip (a hard break in curvature — 0.12 rad of slope
// inside 1.2 m, which is 50 m/s^2 at 20 m/s and therefore *throws* the rider
// rather than letting him drift along the deck), a near-level table, a knuckle,
// a landing pitched to match the trajectory, and a compression at the bottom
// that eases back into the piste.
//
// The landings are pitched, deliberately, at the angle the ballistic path
// actually arrives at. `physics.js` destroys only the velocity *into* the snow
// (`_step`, the landing branch), so a slope-matched touchdown at 25 m/s costs
// well under 1% of the speed while the same landing on flat ground scrubs 8%
// and buries the rider in a compression. Getting that angle right is the whole
// difference between a jump and a trap.
//
// Sizing note: this run pitches at 13-17 degrees, where the sim's terminal
// speed upright is ~21 m/s. Everything below is sized for 18-22 m/s of approach
// — which is why the "medium" kicker throws a 25 m gap. A park built for 13 m/s
// would be a set of speed bumps here.
//
// `[t, v, rel]` knots. `t` is metres along the axis, 0 AT THE LIP, positive
// downhill. By default `v` is the *absolute* descent rate of the surface there
// (positive = losing height, negative = the ramp climbing), and `null` means
// "the grade itself", i.e. offset slope zero — used for the run-in and for the
// closure knot.
//
// With `rel` set, `v` is the offset slope directly, i.e. the surface angle is
// `grade + |v|`. Which of the two a knot uses is not a convenience, it decides
// whether the feature survives being moved:
//
//   - the run-in, the ramp and the table are ABSOLUTE. A lip points where it
//     points regardless of the hill, a table is level because a table is level,
//     and that is what fixes the launch angle above the horizon.
//   - the landing and the run-out are RELATIVE. The trajectory always arrives
//     at (slope angle + ~17 degrees), so on a 17-degree pitch the landing has
//     to be 3 degrees steeper than on a 14-degree one or it stops matching.
//     Making them absolute also breaks the closure outright: on the steepest
//     anchor the profile never got back under the grade line at all and the
//     run-out solved negative.
// What decides whether the rider leaves at the lip or drifts off the knuckle
// -------------------------------------------------------------------------
// `physics.js` does not separate the skis from the snow on a curvature test.
// It runs a shadow ballistic path for the centre of mass and only calls the
// rider airborne once the legs have run out of their 0.45 m of travel
// (LEG_TRAVEL), and the contact height is a 1.7 m footprint average, which
// smooths the lip further. Together those mean a break of `k` per metre at
// speed `u` takes `sqrt( 0.9 / (u^2 k - g) )` seconds to become a takeoff:
//
//   break 0.05 /m at 18 m/s  ->  never (16 m/s^2, barely over gravity)
//   break 0.09 /m            ->  0.18 s = 3.3 m past the lip
//   break 0.18 /m            ->  0.11 s = 2.0 m
//   break 0.30 /m            ->  0.08 s = 1.5 m
//
// The first version of this table had a 5-degree break at the lip and a 6 m
// table, and the rider measurably rode the deck and dropped off the KNUCKLE —
// separation at t = 8.9 m on a feature whose lip is at t = 0. The second put a
// 0.15 break at the lip and still lost: the ramp under it only reached
// +7.7 degrees, so the rider left 5.2-5.4 m past the lip on all three kickers,
// pointing DOWNHILL (-4 to -7 degrees at separation). A jump you leave going
// down is a roll, whatever the table says.
//
// The kickers now break 0.52 of slope inside 0.9 m off a 25-degree ramp — 190
// m/s^2 of ground falling away at 19 m/s. Measured against physics.js driven
// headless down each feature's own axis:
//
//   feature   separation past the lip   angle at separation
//   kicker1        0.90 m                   +19.4 deg
//   booter         1.26 m                   +13.6 deg
//   kicker2        1.10 m                   +19.3 deg
//
// The residual metre is the 1.7 m contact footprint, not the profile: the skis
// bridge the lip and the body is still being carried by an averaged surface for
// half a ski length after the snow has gone. It also costs about 6 degrees of
// launch angle against the ramp, which is why the numbers above are 19 and not
// 25. Sharpening the break further only fights the footprint.
//
// Why the kickers are as big as they are
// --------------------------------------
// The takeoff angle is the design input — 25 degrees above horizontal on the
// kickers, 27 on the booter, held straight over the last 5 m — and everything
// else in the feature falls out of it. Two consequences are worth stating
// because both look like mistakes until you do the arithmetic:
//
// 1. A 25-degree ramp on a 17-degree pitch is a TALL structure. The ramp climbs
//    away from the grade at tan(25) + m0 = 0.76 m per metre, and the transition
//    under it contributes half its own length at the same rate, so
//        lipH ~= (tan(theta) + m0) * (L_straight + L_transition/2)
//    With the 5 m straight the user's brief asks for and a transition long
//    enough to stay under ~3.5 g at 21 m/s (7 m), that is 7.9 m of lip on
//    kicker1. There is no way to have all three of a 25-degree ramp, a 5 m
//    straight section and a 4 m lip on this pitch — the first cut of this table
//    tried, and needed a 3 m transition, which is 10 g. Real parks solve it the
//    other way: a big-air takeoff IS a 6-9 m structure, and the ones that are
//    4 m tall have 2 m straights behind a long transition.
//
// 2. THE LANDING ANGLE IS NOT A FREE VARIABLE and steepening it buys nothing.
//    The arrival angle for a launch theta onto a surface falling at beta is
//    atan(tan(theta) + 2 tan(beta)), so the *mismatch* the rider eats is
//        f(beta) = atan(tan(theta) + 2 tan(beta)) - beta
//    and df/dbeta is about -0.04 near beta = 15 deg: essentially flat. Measured
//    over the whole design sweep (landing pitched grade+11 to grade+18, landing
//    length 46 to 54 m) the touchdown mismatch never left 28-31 degrees, while
//    the excavation went from 1.4 m to 9.6 m and the feature grew 60 m. So the
//    landing here is pitched at the SHALLOW end of that band — it is the one
//    that closes without digging a trench across the piste, and it costs
//    nothing in landing violence that the steep one would have saved.
//
// What a steeper lip costs, honestly and in full. Measured, old -> new:
//
//   kicker1  gap 28 -> 52 m, air 1.4 -> 2.8 s, touchdown 7.4 -> 12.4 m/s into
//            the snow, speed kept against sqrt(v^2 + 2gh) 80% -> 60%
//   kicker2  gap 28 -> 45 m, 5.6 -> 12.3 m/s,  85% -> 61%
//   booter   gap 22 -> 22 m, 6.9 -> 7.1 m/s,   81% -> 80%
//
// The booter is the control that proves where the cost comes from. It has the
// steepest ramp of the three and it costs nothing, because it sits on the
// mellowest anchor and follows kicker1, so it arrives at 20 m/s instead of 23.5
// and leaves its (taller) lip at 14 m/s instead of 20. On a slope the ONLY way
// to arrive at a lip slower is to arrive higher, so lip height is the speed
// control and the whole design space is one-dimensional: taller lip -> slower
// takeoff -> shorter gap -> softer landing. Priced over the sweep, kicker1 at
// 8.8 m of lip costs 40% and at 12.5 m of lip costs 33% while going to 25 m
// tall in footprint — 7 points is not worth a jump you can see from the lift,
// so this table stops at 8.8.
//
// The brief's fallback — "if the speed cost rises, shorten the feature" — works
// BACKWARDS here for that same reason, and it is worth writing down so nobody
// re-derives it: shortening the ramp lowers the lip, which speeds the takeoff
// up, which lengthens the flight and hardens the landing.
const PARK_PROFILES = {
  // Roller. No lip worth the name — a smooth convex crest, 1.6 m proud of the
  // piste, that unweights you and gives about a metre of float. This is the
  // feature you are allowed to take by accident.
  roller: [
    [-14, null], [-8, null],
    [-4.5, 0.08], [-1.2, 0.02],        // transition up to a level crest
    [0, 0.02], [1.0, 0.13],
    [2.8, 0.13],                       // short crest
    [4.6, -0.19, 1],                   // landing, grade + 11 deg
    [18, -0.16, 1],
    [26, 0.14, 1],
    [null, null],
  ],
  // Step-down. A flat compacted approach, then the ground is simply gone: the
  // lip breaks 0.34 of slope inside 1.2 m straight into the landing, with no
  // table at all. Half a second and half a metre — the smallest feature here
  // and the one with the crispest edge, which is exactly how a step-down reads.
  stepdown: [
    [-16, null], [-10, null],
    [-5, 0.14], [-1.2, 0.09],          // approach flattens off
    [0, 0.09],
    [1.2, -0.17, 1],                   // the drop: 0.38 of slope in 1.2 m
    [18, -0.15, 1],
    [26, 0.15, 1],
    [null, null],
  ],
  // The mellow kicker, kept for the hip. This is the pre-2026-07 kicker shape:
  // a 6-degree ramp that never really breaks, so the rider drifts off the
  // knuckle 5 m past the lip rather than being thrown at the lip. As a KICKER
  // that is the defect this pass exists to fix; as a HIP it is right, because a
  // hip is taken across the fall line at half the approach speed and its whole
  // point is that you can carry a line over it rather than boost off it.
  hip: [
    [-16, null], [-11, null],
    [-6.5, 0.06], [-2.0, -0.05],       // transition, then the ramp
    [0, -0.05], [1.2, 0.10],           // lip: 0.15 of slope in 1.2 m
    [3.6, 0.10],                       // table — short on purpose
    [5.8, -0.22, 1],                   // knuckle
    [34, -0.20, 1],                    // landing, grade + 12 deg
    [46, 0.22, 1],
    [null, null],
  ],
  // The kicker. A real park takeoff, in the order a shaper builds it:
  //
  //   -22..-15   flat compacted run-in, at grade, moguls tilled off it
  //   -15..-13   the run-in flattens off to 7 deg — the last bit of speed you
  //              can still scrub, and the foot of the transition
  //   -13..-6    the transition, 7 m of it, sweeping 32 degrees. That is
  //              ~0.084 /m of curvature: 3.4 g at 21 m/s, which is what a big
  //              kicker's transition actually pulls. Shorter is not "punchier",
  //              it is a kink the suspension eats and the eye reads as a fold.
  //    -6..-0.9  THE RAMP: 5.1 m dead straight at 25 degrees above horizontal.
  //              This is the whole point of the feature. It is what the rider
  //              leaves on and what the silhouette is made of.
  //   -0.9..0    the lip. The surface angle runs from +25 deg to exactly 0 in
  //              0.9 m — 0.52 of slope, four times the old table's break — so
  //              the crest sits precisely at t = 0 and `terrain.jumps[].x/z/y`
  //              is honest. At 19 m/s that break is 190 m/s^2 of ground falling
  //              away and the legs are out of travel 1.5 m later.
  //    0..2.4    the table. Dead level, because a table is level.
  //   2.4..4.8   the knuckle, rolling over into the landing.
  //   4.8..58    the landing at grade + 11.3 deg. Long, because the measured
  //              flight is 45 m on kicker2 and 52 m on kicker1 and the rider has
  //              to touch down ON it; shallow, because steeper does not reduce
  //              the mismatch (see above) and does dig a trench. As built it
  //              bottoms out 1.8 m under grade on kicker1, 3.2 m on kicker2.
  //     58..70   the compression, then the solved run-out.
  kicker: [
    [-22, null], [-17, null],
    [-15, 0.12],
    [-6, -0.4663],                     // tan 25 deg
    [-0.9, -0.4663],                   // 5.1 m of straight ramp
    [0, 0.0],                          // the lip: crest exactly at t = 0
    [2.4, 0.0],                        // level table
    [4.8, -0.20, 1],                   // knuckle
    [58, -0.20, 1],                    // landing, grade + 11.3 deg
    [70, 0.22, 1],
    [null, null],
  ],
  // The booter. The same grammar two degrees steeper and half a metre longer in
  // every section. It sits on the mellowest anchor in the park (13.2 deg) and
  // follows kicker1, so it is the SLOWEST feature on the line despite being the
  // biggest — which is why its gap is 22 m against the kickers' 45-52 and why it
  // is the one that keeps 80% of its speed where they keep 60.
  booter: [
    [-24, null], [-18, null],
    [-15, 0.10],
    [-6.6, -0.5095],                   // tan 27 deg
    [-1.0, -0.5095],                   // 5.6 m of straight ramp
    [0, 0.0],
    [3.0, 0.0],                        // table
    [5.8, -0.22, 1],                   // knuckle
    [54, -0.22, 1],                    // landing, grade + 12.4 deg
    [66, 0.24, 1],
    [null, null],
  ],
};

/**
 * The park line, top to bottom. `z` is the lip; `off` is metres from the
 * corridor centreline (+x = skier's left looking down); `yaw` swings the
 * feature's axis off the local fall line, which is all a hip is.
 *
 * Placement rules that are not negotiable:
 *  - Nothing may overlap where a canonical `shoot.mjs` framing settles, or the
 *    shot catches the rider mid-flight and every metric in it is measuring the
 *    sky. Measured settle end points: hero (18,684), ridge (-301,329, which is
 *    354 m off the corridor and nowhere near the park), trees (157,90, 117 m
 *    off), steep (-24,-338), closeup (58,457) — the last two are the tight
 *    ones, hence the gaps at z ~ 460-500 and below z ~ -110.
 *  - clean piste between the end of one run-out and the start of the next
 *    transition, so there is room to set the speed and the line. The 25-degree
 *    takeoffs cost most of the slack that used to be here: the features are now
 *    100-113 m long instead of 55-105, and the gaps run 38, 47, 41, 62 m down
 *    the line (they were 40-90). 38 m at 21 m/s is under two seconds, which is
 *    the tightest link on the hill and the first thing to give if anything else
 *    in the park grows.
 *  - Every big feature is offset from the centreline and none is wider than
 *    36 m, so a rider holding a line 25 m to either side goes past it. The
 *    roller and the step-down sit close to the middle on purpose: they are the
 *    ones you are allowed to take by accident.
 */
// Flank angle is the constraint on the widths, and it is a hard one. The bank
// down the side of a feature is 1.5 * height / feather at its steepest, and the
// rock mask's macro term switches on at 0.55 rad — 31.5 degrees. Take the
// booter's deck to a 7.5 m feather, as a real 12 m-wide kicker would, and the
// flank stands at 40 degrees, `macroGate` opens, and the sides of the jump
// render as bedrock.
//
// The 25-degree ramps made this binding rather than academic: a 7.9 m lip needs
// a 24 m feather to hold 31.5 degrees, which is a 58 m wide jump, and that is
// absurd. So the trade was taken the other way — the feathers here hold the
// flanks at 39-42 degrees, which is what a shaped kicker's side actually stands
// at, and `terrJumps` now emits a SECOND coverage channel that saturates across
// the whole flank and biases the rock-exposure channel by 3x more than the old
// one did. Measured with the mask arithmetic in snow-material.js: worst-case
// talus threshold over the flank 0.89 rad against a 0.73 rad surface, i.e. 9
// degrees of headroom where the old bias left -6.
const JUMP_DATA = [
  { name: 'roller',   kind: 'roller',   z: 645, off: 0, w0: 4.5, w1: 11, yaw: 0 },
  // 150 m of clean piste here: the `closeup` framing spawns at z 480 and
  // settles to 457, and it has to settle onto flat groomed snow.
  { name: 'kicker1',  kind: 'kicker',   z: 400, off: 12, w0: 5.0, w1: 17.5, yaw: 0 },
  { name: 'booter',   kind: 'booter',   z: 260, off: -16, w0: 5.5, w1: 18.0, yaw: 0 },
  { name: 'hip',      kind: 'hip',      z: 125, off: 20, w0: 5.0, w1: 13, yaw: -0.30 },
  { name: 'stepdown', kind: 'stepdown', z: 5, off: -6, w0: 4.5, w1: 11, yaw: 0.10 },
  // ...and stops at z -215, well clear of the `steep` framing at -260/-338.
  { name: 'kicker2',  kind: 'kicker',   z: -120, off: 8, w0: 5.0, w1: 15.5, yaw: 0 },
];

/** Metres over which the mogul suppression fades in at each end of a feature. */
const PARK_FADE = 6.0;
const PARK_IFADE = 1 / PARK_FADE;

/**
 * Lateral window weight at which the rock-exposure bias is already at full
 * strength. The bank down a kicker's flank is steepest where W ~ 0.5, so the
 * bias has to saturate well outside that or it is at half strength exactly
 * where the mask is closest to opening. See `_jumpGLSL`.
 */
const PARK_ROCK_W = 0.30;

/**
 * The cross-section of a feature — and the reason the first cut of this park
 * photographed as a snow dome rather than as a kicker.
 *
 * The lateral window used to be a plain cubic smoothstep, whose gradient is
 * zero at the deck edge, peaks half way down and returns to zero at the toe.
 * That is a *hill*: there is no line anywhere on it, so from the side, from the
 * landing, from anywhere except straight up the ramp, the feature reads as a
 * natural mound with a flat bit on top. Every reference photograph of a park
 * kicker has exactly one strong line in it — the deck edge, where the machine
 * stopped and the shovel started — and a long flat-ish bank under it.
 *
 * So the window is now built from its DERIVATIVE, as a trapezoid: the bank
 * angle ramps in over the first `R` of the feather, holds dead constant (a
 * planar bank — the thing that catches the light as one facet), then eases out
 * over the last `S` into the snow. Height is the integral, so it is piecewise
 * quadratic and C1 exactly as before; only the curvature is redistributed, out
 * of the middle of the bank and into a 1.6 m shoulder at the deck edge.
 *
 * K normalises it so the window still falls from 1 to 0 across the feather:
 *   K = 1 / (1 - R/2 - S/2).
 * The peak lateral gradient is K*D/feather rather than 1.5*D/feather, so a
 * crisper edge is also a slightly *shallower* flank for the same width.
 */
const PARK_WIN_R = 0.12;                                   // shoulder, fraction of the feather
const PARK_WIN_S = 0.42;                                   // toe
const PARK_WIN_K = 1 / (1 - PARK_WIN_R * 0.5 - PARK_WIN_S * 0.5);
/**
 * How far the park pushes the rock-exposure channel down, in units of the
 * rock-exposure channel. snow-material.js spends it at `talus -= expo * 0.28`.
 *
 * Sized from the mask arithmetic rather than by eye. The steepest surface
 * measured anywhere on the new features is 0.85 rad (49 deg — the bank half way
 * down a flank, where the lateral fall of the feather adds to the landing's own
 * pitch). At that inclination `macroGate` is 0.96, i.e. fully open, and the
 * worst-case stack of the fine terms in snow-material.js is
 *
 *   0.735 (base) - 0.78 (macro, macroBin 0) - 0.09 (rFrac) - 0.045 (curv)
 *        - 0.045 (lee/wind) - 0.06 (streak)  =  -0.285 rad of threshold,
 *
 * and `alti` contributes nothing at 400 m, 240 m under the snow line. To clear
 * a 0.85 rad surface with 0.15 rad of margin the bias has to be worth 1.13 rad,
 * i.e. 5.0 * 0.28 = 1.40 → threshold 1.115 rad, margin 0.265 (15 degrees).
 *
 * The old value was 1.0, which was sized for 28-degree flanks and a *shut*
 * gate; it is worth 0.28 rad and would leave the new flanks 0.5 rad short.
 * `expo` has exactly one consumer, that one line, so there is nothing else for
 * a large value here to disturb.
 */
const PARK_ROCK_BIAS = 5.0;

/** GLSL float literal with enough digits that the GPU reads the CPU's number. */
function glf(v) {
  const s = Number(v).toPrecision(9);
  return /[.eE]/.test(s) ? s : s + '.0';
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

    // The park. Must come after the bake (it measures the surface it is built
    // on) and before the material (its resolved numbers are compiled into the
    // shader). `this.jumps` is empty while `_placeJumps` runs, so the `_sample`
    // calls it makes see the bare mountain and the placement cannot depend on
    // itself.
    this.jumps = [];
    this._placeJumps();

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

    const jumpGLSL = this._jumpGLSL();
    this.material = createSnowMaterial({
      displacement: {
        uniforms: this.uniforms,
        prelude: GLSL_DISPLACE_PRELUDE + jumpGLSL,
        body: GLSL_DISPLACE_BODY,
        fragPrelude: GLSL_MACRO_RECON + jumpGLSL,
        fragRefine: GLSL_FRAG_REFINE,
      },
    });
    this.snowUniforms = this.material.userData.snowUniforms;
    this.depthMaterial = this.material.userData.createDepthMaterial();

    this.group = new THREE.Group();
    this.group.name = 'terrain';

    // Ring resolution tier and shadow-ring counts. Set before _buildClipmap:
    // it reads all three. `_center` is NaN until update() first snaps it, which
    // _buildClipmap tests for, so the order here is the only ordering
    // constraint — build the clipmap after the material and before update().
    this._meshTier = normalizeMeshTier(opts.meshQuality ?? DEFAULT_MESH_TIER);
    this._shadowRings = 5;      // levels 0..4, i.e. out to 614 m
    this._receiveRings = 7;     // levels 0..6
    this._center = new THREE.Vector2(NaN, NaN);
    this.levels = [];
    this._buildClipmap();

    this._scratch = new THREE.Vector3();
    this._grad = { x: 0, y: 0 };
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

  // ----------------------------------------------------------------- park ---
  /**
   * Resolve `JUMP_DATA` against the mountain that actually got baked.
   *
   * Per feature this fixes four things that cannot be authored blind:
   *
   *  - the *axis*, taken from the steepest-descent direction over a 24 m
   *    footprint. The corridor's fall line wanders +-23 degrees off -z because
   *    of the fall-line ribs blended in by step 5 of the bake, and a kicker
   *    built square to the world would sit skew to the line the rider is
   *    actually on. `yaw` then swings it off that on purpose, which is the only
   *    thing that distinguishes a hip from a kicker.
   *  - `m0`, the grade *along that axis*. Every angle in PARK_PROFILES is
   *    absolute, so this is what turns "the landing falls at 26 degrees" into a
   *    height offset. For a yawed feature the axis grade is `|g|.cos(yaw)`,
   *    which is exactly why a hip's landing is the shallower one.
   *  - the knot heights, by integrating the offset slope. Trapezoid, which is
   *    the exact integral of a piecewise-linear slope.
   *  - the closure: the last segment's length, chosen so the profile comes back
   *    to zero height at zero slope. Authoring that length by hand and hoping
   *    is how you get a 30 cm step across the piste.
   */
  _placeJumps() {
    const out = [];
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;

    for (const d of JUMP_DATA) {
      // Hard-clamped inside the fully-blended piste with the feature's own
      // width and 10 m of margin taken off. Outside PISTE_HALF the corridor
      // blend releases the surface back to the raw massif, and a kicker built
      // half on a groomed corridor and half on an eroded 40-degree shoulder is
      // not a jump, it is a trap.
      const lim = PISTE_HALF - d.w1 - 10;
      const x0 = corridorX(d.z) + clamp(d.off, -lim, lim), z0 = d.z;

      // Steepest descent over a footprint wide enough to ignore the moguls and
      // narrow enough to still be the local fall line.
      const e = 24;
      const gx = (this._sample(x0 + e, z0, false) - this._sample(x0 - e, z0, false)) / (2 * e);
      const gz = (this._sample(x0, z0 + e, false) - this._sample(x0, z0 - e, false)) / (2 * e);
      const gm = Math.hypot(gx, gz);
      let ax = -gx / gm, az = -gz / gm;                     // unit, downhill
      if (!(gm > 1e-4)) { ax = 0; az = -1; }
      if (d.yaw) {
        const c = Math.cos(d.yaw), s = Math.sin(d.yaw);
        const nx = ax * c - az * s, nz = ax * s + az * c;
        ax = nx; az = nz;
      }
      // Grade along the axis, never along the raw gradient: a yawed feature is
      // built across a shallower fall than the hill's own.
      const m0 = Math.max(0.06, -(gx * ax + gz * az));

      const prof = PARK_PROFILES[d.kind];
      const n = prof.length;
      const kt = new Float64Array(n), ks = new Float64Array(n), kd = new Float64Array(n);
      for (let i = 0; i < n - 1; i++) {
        kt[i] = prof[i][0];
        ks[i] = prof[i][1] === null ? 0 : prof[i][2] ? prof[i][1] : m0 - prof[i][1];
      }
      kd[0] = 0;
      for (let i = 0; i < n - 2; i++) {
        kd[i + 1] = kd[i] + (kt[i + 1] - kt[i]) * (ks[i] + ks[i + 1]) * 0.5;
      }
      // Closure. The tail knot has slope 0 and height 0, so the last segment
      // integrates to h * s_prev / 2 and its length falls out. It is only
      // solvable if the profile finishes below grade and still climbing back —
      // which is the definition of a landing with a compression in it.
      const sL = ks[n - 2], dL = kd[n - 2];
      const exact = -2 * dL / (sL > 1e-4 ? sL : 1e-4);
      const runOut = clamp(exact, 2, 160);
      if (Math.abs(runOut - exact) > 0.01) {
        // Clamping here would leave a step in the piste where the feature ends,
        // so it is a design error in PARK_PROFILES, not something to absorb.
        console.warn(`[terrain] park "${d.name}": run-out solved at ${exact.toFixed(1)} m ` +
          `(clamped to ${runOut.toFixed(1)}); the profile does not close.`);
      }
      kt[n - 1] = kt[n - 2] + runOut;
      ks[n - 1] = 0;
      kd[n - 1] = 0;

      const j = {
        name: d.name, kind: d.kind,
        x: x0, z: z0, y: this._sample(x0, z0, false),
        ax, az, dir: Math.atan2(-ax, -az), m0,
        t0: kt[0], t1: kt[n - 1],
        w0: d.w0, w1: d.w1, iwf: 1 / (d.w1 - d.w0),
        kt, ks, kd,
        // Read-only description for anything that wants to sign, decorate or
        // announce the park. Nothing in this repo consumes it yet.
        size: d.kind === 'roller' || d.kind === 'stepdown' ? 'small'
          : d.kind === 'hip' ? 'medium' : d.kind === 'kicker' ? 'large' : 'xl',
        lipH: 0, deckH: 0, deckLen: 0, runOut, lipT: 0,
        lipZ: z0, landingZ: 0, width: d.w1 * 2,
      };
      // Descriptive numbers, read straight off the resolved profile.
      for (let i = 0; i < n; i++) {
        if (kt[i] === 0) j.lipH = kd[i];
        if (kd[i] > j.deckH) { j.deckH = kd[i]; j.deckLen = kt[i]; }
      }
      // Where the LIP actually is, as opposed to where the table says it is.
      //
      // This is not bookkeeping. `x, z, y` is documented as "the lip" and it is
      // the anchor every future consumer — signage, an AI line, a HUD cue —
      // will trust. A C1 profile rounds its crest over the segment in which the
      // slope changes sign, so the crest is at the zero of the *offset* slope
      // minus the grade, `s = m0`, and there is no reason for that to land on a
      // knot unless the table is written to put it there. The shape this file
      // shipped with had the ramp still climbing at t = 0 and the crest 0.93 m
      // downhill of it — measured on the built surface, height still rising
      // from t = 0 to t = +1. Every kicker table here now ends its ramp with a
      // knot at exactly (0, absolute slope 0), so the crest is the knot, and
      // this check fails loudly if an edit breaks that again.
      for (let i = 0; i < n - 1; i++) {
        const s0 = ks[i] - m0, s1 = ks[i + 1] - m0;
        if (s0 > 0 && s1 <= 0 && kt[i] > -12 && kt[i] < 12) {
          j.lipT = kt[i] + (kt[i + 1] - kt[i]) * (s0 / (s0 - s1));
          break;
        }
      }
      if (Math.abs(j.lipT) > 0.05 && (d.kind === 'kicker' || d.kind === 'booter')) {
        console.warn(`[terrain] park "${d.name}": the crest is ${j.lipT.toFixed(2)} m from t = 0, `
          + 'so jumps[].x/z/y is not the lip. Fix the ramp knots, not this check.');
      }
      // Where the landing surface crosses the natural grade again — the point a
      // well-judged jump is aimed at. Solved inside the segment rather than
      // interpolated between its ends: the landing is one 53 m segment and D is
      // quadratic across it, so the chord is out by metres.
      for (let i = 1; i < n; i++) {
        if (kd[i - 1] > 0 && kd[i] <= 0) {
          const h = kt[i] - kt[i - 1], ds = ks[i] - ks[i - 1];
          // kd[i-1] + h*(ks[i-1]*u + ds*u^2/2) = 0, u in [0,1]
          const A = 0.5 * h * ds, B = h * ks[i - 1], C = kd[i - 1];
          let u;
          if (Math.abs(A) < 1e-9) u = -C / B;
          else {
            const disc = Math.sqrt(Math.max(0, B * B - 4 * A * C));
            const u1 = (-B + disc) / (2 * A), u2 = (-B - disc) / (2 * A);
            u = (u1 >= 0 && u1 <= 1) ? u1 : u2;
          }
          const tl = kt[i - 1] + clamp(u, 0, 1) * h;
          j.landingZ = z0 + az * tl;
          j.landingX = x0 + ax * tl;
          j.landingT = tl;
          break;
        }
      }
      out.push(j);

      // Bounds, generous by the window width in every direction.
      const r = j.w1;
      for (const t of [j.t0, j.t1]) {
        bx0 = Math.min(bx0, x0 + ax * t - r); bx1 = Math.max(bx1, x0 + ax * t + r);
        bz0 = Math.min(bz0, z0 + az * t - r); bz1 = Math.max(bz1, z0 + az * t + r);
      }
    }

    this.jumps = out;
    this._parkBox = out.length ? [bx0, bx1, bz0, bz1] : [1, -1, 1, -1];
    this._jumpOut = [0, 0, 0, 0];
  }

  /**
   * The park, as a perturbation of whatever the mountain is doing. Writes
   * `[dh, d/dx, d/dz, coverage]` into `out`; `coverage` is the largest lateral
   * window weight hit, which is what tells the mogul band to stay off a
   * groomed feature.
   *
   * `height()` runs seven times per contact per 1/120 s substep, so the cost of
   * *not* being in the park has to be four comparisons. It is: one axis-aligned
   * box around the whole line, resolved at build time, before anything else.
   */
  _jumpsAt(x, z, out) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
    const J = this.jumps;
    if (!J || J.length === 0) return out;
    const b = this._parkBox;
    if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) return out;

    for (let i = 0; i < J.length; i++) {
      const j = J[i];
      const dx = x - j.x, dz = z - j.z;
      const t = dx * j.ax + dz * j.az;
      if (t <= j.t0 || t >= j.t1) continue;
      const q = dz * j.ax - dx * j.az;
      const aq = q < 0 ? -q : q;
      if (aq >= j.w1) continue;

      // Lateral window: flat deck, a short shoulder, a planar bank, a long toe.
      // Zero value AND zero slope at both ends so nothing creases. See
      // PARK_WIN_R — this is the shape that makes it read as built.
      let W = 1, dW = 0;
      if (aq > j.w0) {
        const a = (aq - j.w0) * j.iwf;
        const sg = (q < 0 ? -j.iwf : j.iwf);
        if (a < PARK_WIN_R) {
          W = 1 - PARK_WIN_K * a * a / (2 * PARK_WIN_R);
          dW = -PARK_WIN_K * (a / PARK_WIN_R) * sg;
        } else if (a < 1 - PARK_WIN_S) {
          W = 1 - PARK_WIN_K * (a - PARK_WIN_R * 0.5);
          dW = -PARK_WIN_K * sg;
        } else {
          const b = (1 - a) / PARK_WIN_S;
          W = PARK_WIN_K * PARK_WIN_S * b * b * 0.5;
          dW = -PARK_WIN_K * b * sg;
        }
      }

      const kt = j.kt, ks = j.ks, kd = j.kd;
      let n = 0;
      while (n < kt.length - 2 && t >= kt[n + 1]) n++;
      const h = kt[n + 1] - kt[n];
      const u = (t - kt[n]) / h;
      const ds = ks[n + 1] - ks[n];
      const S = ks[n] + ds * u;
      const D = kd[n] + h * (ks[n] * u + 0.5 * ds * u * u);

      out[0] += D * W;
      out[1] += j.ax * S * W - j.az * D * dW;
      out[2] += j.az * S * W + j.ax * D * dW;

      // Coverage, for the mogul suppression only — and it needs its own taper
      // along the axis, which the height does not. D is already zero at both
      // ends of the profile, but W is 1 right up to them, so keying the mogul
      // amplitude on W alone put a hard step in the surface at t0 and t1:
      // 0.28 m of mogul appearing over nothing. Measured, before this taper:
      // 12.3 cm of height change in a 5 cm sample step at the roller's run-out
      // and 10.4 cm at kicker1's run-in — a lip on the piste made of nothing but
      // a missing fade, which is exactly the "launch off nothing" failure.
      const f = t - j.t0 < j.t1 - t ? (t - j.t0) * PARK_IFADE : (j.t1 - t) * PARK_IFADE;
      const a = f < 1 ? f * f * (3 - 2 * f) : 1;
      const cov = W * a;
      if (cov > out[3]) out[3] = cov;
    }
    return out;
  }

  /**
   * The same function, emitted as GLSL with every resolved number inlined.
   *
   * Generated rather than written because the two copies of a detail band
   * drifting apart is the standing failure mode of this file, and a kicker is
   * the one band where a 10 cm disagreement is not cosmetic: the physics would
   * hold the rider 10 cm off the mesh through the whole flight. Here there is
   * only one authoring — `_placeJumps` — and both sides read its output.
   *
   * No distance fade, unlike every other band in the displacement program.
   * That is deliberate on both counts: the CPU twin has no fade either (so the
   * surfaces agree *identically*, not just near the player), and a park you
   * cannot see from 400 m up the run is a park nobody aims at.
   *
   * How to check the two are still the same surface — and two traps in doing it
   * ----------------------------------------------------------------------------
   * Point an OrthographicCamera straight down at the park, render the terrain
   * group with a depth material as `scene.overrideMaterial`, read the target
   * back and compare against `height()`. For an ortho camera the packed depth is
   * linear: y = camY - (near + d * (far - near)). Both traps cost an hour:
   *
   *  - `terrain.depthMaterial` will render NOTHING in that pass. It has been
   *    through the shadow map, which leaves `side` on BackSide, and a top-down
   *    pass then culls every triangle. Build a fresh one from
   *    `material.userData.createDepthMaterial()` and set it DoubleSide. A blank
   *    (clear-coloured) readback is this, not a broken displacement.
   *  - three's `packDepthToRGBA` puts the MOST significant byte in R, not in A:
   *    d = (255/256) * (r + g/256 + b/65536 + a/16777216) with each channel in
   *    0..1. Getting that backwards reads as a plausible-looking 35 m error with
   *    no correlation to height at all.
   *
   * Last measured over 60 x 60 m windows at 512^2, against no-park control
   * windows of plain piste on the same run: mean |error| 0.25-0.45 cm over the
   * features against 0.34-0.44 cm on the controls, max 3.4-4.2 cm against
   * 2.9-3.8 cm. The residual is clipmap triangle chord error, not a difference
   * between the two evaluations.
   */
  _jumpGLSL() {
    const J = this.jumps;
    if (!J || J.length === 0) {
      return '\nvoid terrJumps( vec2 P, inout float h, inout vec2 g, out float amt, out float rock )'
        + ' { amt = 0.0; rock = 0.0; }\n';
    }
    const b = this._parkBox;
    let s = `
// ---- snow park (generated by Terrain._placeJumps) ----------------------------
// Twin of Terrain._jumpsAt. Do not hand-edit: it is emitted from the same
// resolved knot table the CPU sampler reads.
//
// Two coverage channels come out of here and they are NOT the same number:
//
//   amt  — the lateral window itself, tapered along the axis. Drives the mogul
//          suppression, so it has to go to zero exactly where the feature's
//          height does, or a mogul field appears out of nothing at the seam.
//          Its CPU twin is _jumpsAt's out[3].
//   rock — the same coverage SATURATED across the flank. The rock mask needs a
//          different shape: the steepest surface on a kicker is the bank half
//          way down its flank, which is exactly where the window weight is 0.5,
//          so a bias keyed on amt is at half strength precisely where it is
//          needed most. Saturating at W = 0.30 puts the full bias over
//          everything from the deck to well down the feather and still lets it
//          reach zero at the outer edge, where the feature has no height and no
//          gradient and there is nothing to protect.
void terrJumps( vec2 P, inout float h, inout vec2 g, out float amt, out float rock ) {
  amt = 0.0;
  rock = 0.0;
  if ( P.x < ${glf(b[0])} || P.x > ${glf(b[1])} ||
       P.y < ${glf(b[2])} || P.y > ${glf(b[3])} ) return;
  vec2 d;
  float t, q, aq, W, dW, S, D, u, a, b, f;
`;
    for (const j of J) {
      const kt = j.kt, ks = j.ks, kd = j.kd, n = kt.length;
      s += `
  // ${j.name} (${j.kind}) — lip ${j.lipH.toFixed(2)} m, deck ${j.deckH.toFixed(2)} m, run-out ${j.runOut.toFixed(1)} m
  d = P - vec2( ${glf(j.x)}, ${glf(j.z)} );
  t = d.x * ${glf(j.ax)} + d.y * ${glf(j.az)};
  if ( t > ${glf(j.t0)} && t < ${glf(j.t1)} ) {
    q = d.y * ${glf(j.ax)} - d.x * ${glf(j.az)};
    aq = abs( q );
    if ( aq < ${glf(j.w1)} ) {
      W = 1.0; dW = 0.0;
      if ( aq > ${glf(j.w0)} ) {
        a = ( aq - ${glf(j.w0)} ) * ${glf(j.iwf)};
        f = ${glf(j.iwf)} * sign( q );
        if ( a < ${glf(PARK_WIN_R)} ) {
          W = 1.0 - ${glf(PARK_WIN_K / (2 * PARK_WIN_R))} * a * a;
          dW = -${glf(PARK_WIN_K / PARK_WIN_R)} * a * f;
        } else if ( a < ${glf(1 - PARK_WIN_S)} ) {
          W = 1.0 - ${glf(PARK_WIN_K)} * ( a - ${glf(PARK_WIN_R * 0.5)} );
          dW = -${glf(PARK_WIN_K)} * f;
        } else {
          b = ( 1.0 - a ) * ${glf(1 / PARK_WIN_S)};
          W = ${glf(PARK_WIN_K * PARK_WIN_S * 0.5)} * b * b;
          dW = -${glf(PARK_WIN_K)} * b * f;
        }
      }
`;
      for (let i = 0; i < n - 1; i++) {
        const h = kt[i + 1] - kt[i], ds = ks[i + 1] - ks[i];
        const head = i === 0 ? 'if' : i === n - 2 ? '} else {' : '} else if';
        const cond = i === n - 2 ? '' : ` ( t < ${glf(kt[i + 1])} ) {`;
        s += `      ${head}${cond}
        u = ( t - ${glf(kt[i])} ) * ${glf(1 / h)};
        S = ${glf(ks[i])} + ${glf(ds)} * u;
        D = ${glf(kd[i])} + ${glf(h)} * ( ${glf(ks[i])} * u + ${glf(0.5 * ds)} * u * u );
`;
      }
      s += `      }
      h += D * W;
      g += vec2( ${glf(j.ax)}, ${glf(j.az)} ) * ( S * W )
         + vec2( ${glf(-j.az)}, ${glf(j.ax)} ) * ( D * dW );
      a = min( min( t - ${glf(j.t0)}, ${glf(j.t1)} - t ) * ${glf(PARK_IFADE)}, 1.0 );
      a = a * a * ( 3.0 - 2.0 * a );
      amt = max( amt, W * a );
      f = min( W * ${glf(1 / PARK_ROCK_W)}, 1.0 );
      rock = max( rock, f * f * ( 3.0 - 2.0 * f ) * a );
    }
  }
`;
    }
    s += '}\n';
    return s;
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
    // --- the snow park -------------------------------------------------------
    // Evaluated before the moguls because it suppresses them: a park lane is
    // tilled flat and salted, and a 28 cm mogul field running over a kicker lip
    // would be both wrong and — since the lip is where the rider separates —
    // the difference between a clean takeoff and a random one.
    const jp = this._jumpsAt(x, z, this._jumpOut || (this._jumpOut = [0, 0, 0, 0]));
    const jSmooth = 1 - 0.92 * jp[3];

    // moguls / rollers
    {
      const gate = smoothstep(0.16, 0.34, slope) * smoothstep(1.05, 0.62, slope) * soft;
      const amp = 0.28 * gate * jSmooth;
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

    mh += jp[0]; mgx += jp[1]; mgy += jp[2];

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
    const res = MESH_TIERS[this._meshTier];
    const hole = levelHoles(res);
    this.levels = [];
    const cache = new Map();
    for (let k = 0; k < LEVELS; k++) {
      const cell = CELL0 * Math.pow(2, k);
      const key = res[k] + ':' + hole[k];
      let geo = cache.get(key);
      if (!geo) { geo = buildLevelGeometry(res[k], hole[k]); cache.set(key, geo); }
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.customDepthMaterial = this.depthMaterial;
      mesh.scale.set(cell, 1, cell);
      // Displacement happens in the vertex program, so three's bounds describe
      // the flat lattice and cannot decide visibility. Culling stays off; see
      // buildLevelGeometry for what the bounding sphere is and is not good for.
      mesh.frustumCulled = false;
      // LOAD-BEARING, and it does not look it. This draws the rings NEAR TO FAR,
      // which is what lets early-Z reject the occluded far rings before the snow
      // fragment program runs on them. That program is over half of the scene's
      // shading cost (CLAUDE.md), and rings 6-7 cover the whole screen from the
      // inside — reverse this line, or drop it, and the far field gets shaded
      // first and then overdrawn by everything nearer, for a multi-millisecond
      // regression with no obvious cause anywhere near the change.
      mesh.renderOrder = -10 + k;
      mesh.name = 'terrain-lod' + k;
      this.group.add(mesh);
      this.levels.push({ mesh, cell, res: res[k], hole: hole[k], extent: res[k] * cell / 2 });
    }
    this._applyShadowRings();
    // update() only writes positions when the snapped centre CHANGES, so a
    // rebuild at runtime has to place the new meshes itself or the whole clipmap
    // sits at the origin until the skier crosses the next 0.8 m snap boundary.
    const c = this._center;
    if (c && Number.isFinite(c.x)) {
      for (const l of this.levels) l.mesh.position.set(c.x, 0, c.y);
    }
  }

  /**
   * Push `_shadowRings` / `_receiveRings` onto the meshes. Split out of
   * _buildClipmap so setShadowRings() and a tier rebuild share one definition.
   *
   * Only the rings that actually fall inside the sun-shadow frustum take part in
   * shadow *casting*. That box is ±95 m around the skier (see sky.js), so the
   * default of 5 rings — level 4's outer edge is 614 m out — is already generous
   * margin. Every ring past it would just be a few hundred thousand triangles
   * rasterised into a depth map they cannot possibly intersect.
   *
   * `receiveShadow` is a different animal: in three r185 it is a per-object
   * *uniform* (`lights_pars_begin` declares `uniform bool receiveShadow`, and
   * WebGLRenderer.js:2687 pushes `object.receiveShadow` into it), NOT a program
   * define. So it is safe to vary it across the nine meshes that share this
   * file's single snow material instance, and safe to change at runtime — no
   * second program, no recompile. What it does NOT do is remove any shader cost:
   * USE_SHADOWMAP is decided per material and per renderer, so the shadow code
   * is compiled in either way and switching a ring off only skips its shadow-map
   * fetches under a dynamic branch. Do not expect it to behave like castShadow.
   */
  _applyShadowRings() {
    for (let k = 0; k < this.levels.length; k++) {
      const mesh = this.levels[k].mesh;
      mesh.castShadow = k < this._shadowRings;
      mesh.receiveShadow = k < this._receiveRings;
    }
  }

  _disposeClipmap() {
    const seen = new Set();
    for (const l of this.levels || []) {
      this.group.remove(l.mesh);
      if (seen.has(l.mesh.geometry)) continue;   // rings can share a geometry
      seen.add(l.mesh.geometry);
      l.mesh.geometry.dispose();
    }
    this.levels = [];
  }

  // ------------------------------------------------------------ mesh tiers --
  /**
   * Rebuild the clipmap rings at a different resolution tier. Safe at runtime
   * and repeatable — the old ring geometries are disposed, so a settings menu
   * can hammer this without leaking. Returns the tier actually in force
   * (unknown names fall back to the default rather than throwing, so a stale
   * saved setting cannot brick the boot).
   *
   * Cheap: no bake, no texture, no material, no shader recompile. The rings are
   * a unit lattice in XZ; all the shape lives in the vertex program. Rebuild
   * cost is the lattice generation, a handful of ms.
   *
   * ---------------------------------------------------------------------------
   * Note the pair of PASSTHROUGHS immediately below this comment
   * (`setShaderQuality` / `getShaderQuality`). The snow SHADER tier has to be
   * implemented in `snow-material.js` — it is a set of #defines folded into
   * `customProgramCacheKey`, and only the factory owning that key can move it —
   * but `terrain.material.userData.setShaderQuality` is not an API anybody
   * guesses. A settings layer that feature-detects `terrain.setShaderQuality`
   * and does not find it degrades to a knob that looks live and does nothing,
   * which is precisely what happened before these existed. Unlike the mesh
   * tier, the shader tier costs a shader link per material and per depth
   * material: a menu action, never a per-frame call.
   * ---------------------------------------------------------------------------
   */
  setShaderQuality(tier) {
    const f = this.material?.userData?.setShaderQuality;
    if (typeof f === 'function') f(tier);
    return this.getShaderQuality();
  }

  /** Current snow-shader tier, or null if the material does not report one. */
  getShaderQuality() {
    const f = this.material?.userData?.getShaderQuality;
    return typeof f === 'function' ? f() : null;
  }

  setMeshQuality(tier) {
    const t = normalizeMeshTier(tier);
    if (t === this._meshTier && this.levels && this.levels.length) return t;
    this._meshTier = t;
    this._disposeClipmap();
    this._buildClipmap();
    return t;
  }

  getMeshQuality() { return this._meshTier; }

  /**
   * How many of the inner rings cast into the sun-shadow map. 0 disables
   * terrain self-shadowing entirely; LEVELS enables every ring (pointless — see
   * _applyShadowRings). Second argument optionally sets the receive count; it
   * genuinely works per-ring at runtime, but read the note there before
   * expecting it to save anything.
   */
  setShadowRings(n, receiveRings) {
    // Number.isFinite first: clamp() passes NaN straight through, and a NaN here
    // reads as "no ring casts" — a settings slider that silently deletes the
    // terrain's shadows is a bad way to find out about a parse bug.
    const cast = Math.round(Number(n)), recv = Math.round(Number(receiveRings));
    if (Number.isFinite(cast)) this._shadowRings = clamp(cast, 0, LEVELS);
    if (Number.isFinite(recv)) this._receiveRings = clamp(recv, 0, LEVELS);
    this._applyShadowRings();
    return this._shadowRings;
  }

  /** Live triangle/ring census. `triangles` counts what is submitted per frame,
   *  so rings sharing one geometry are counted once each — which is what they
   *  cost. Extents are half-extents in metres, i.e. the doubling radii. */
  meshInfo() {
    const levelRes = [], levelTris = [], levelHole = [], extent = [];
    let triangles = 0;
    for (const l of this.levels) {
      const idx = l.mesh.geometry.getIndex();
      const tris = idx ? idx.count / 3 : 0;
      triangles += tris;
      levelTris.push(tris);
      levelRes.push(l.res);
      levelHole.push(l.hole);
      extent.push(l.extent);
    }
    return {
      triangles,
      levelRes,
      levels: this.levels.length,
      tier: this._meshTier,
      tiers: MESH_TIER_NAMES.slice(),
      levelTris,
      levelHole,
      extent,
      reach: extent.length ? extent[extent.length - 1] : 0,
      shadowRings: this._shadowRings,
      receiveRings: this._receiveRings,
    };
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
    // Ring geometries — including any allocated by a later setMeshQuality(); it
    // disposes what it replaces, so this only ever has one generation to free.
    this._disposeClipmap();
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
  // Exact bound on the UNDISPLACED lattice. Positions span [-res/2, +res/2] in
  // both x and z, so the corner is at res/2 * sqrt(2) = res / sqrt(2); the skirt
  // adds at most 3.2 cells of drop (see dspSkirt in GLSL_DISPLACE_BODY), and
  // three scales a bounding sphere by the largest axis scale, which for a ring is
  // exactly `cell`, so 3.2 cells is 3.2 in these units.
  //
  // This used to read `res * 4` — 5.66x too large, e.g. a 4915 m world radius on
  // level 4 for an 868 m true half-diagonal. Harmless while frustumCulled is
  // false, which is why it survived, but a bogus bound silently defeats any
  // future culling work, so it is now correct.
  //
  // What it still cannot describe is the displacement: the vertex program moves y
  // by up to ~1.5 km in WORLD units, and none of that is in this sphere. Anyone
  // turning frustum culling on has to inflate the bound by the displacement range
  // (or cull against a conservative height interval) — not trust this number.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), res * Math.SQRT1_2 + 3.2);
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

    // Snow park. The vertex program displaces it, but past ~240 m this block
    // takes the shading normal over, and a kicker whose geometry is there while
    // its normal is not reads as a smear rather than as a lip. Sampled at the
    // true P, never at the warped Pd: that warp exists to ragged a *snowline*,
    // and wobbling a built feature with it would undo the one thing it has to
    // be, which is straight.
    float jAmt, jRock;
    {
      float jh = md.x;
      terrJumps( P.xz, jh, mg, jAmt, jRock );
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
    snData = mix( snData, vec4( mSteep, md.y, md.z,
                                md.w - cornAmt * 1.6 - jRock * ${glf(PARK_ROCK_BIAS)} ), mMix );
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
  // --- the snow park ---------------------------------------------------------
  // The CPU twin is Terrain._jumpsAt and this function is generated from the
  // same resolved table, so the two cannot drift.
  //
  // Folded in *before* coarseSteep on purpose, which is the opposite of the
  // cornice's treatment and for the opposite reason. coarseSteep is what
  // snow-material.js gates all of its piste work on: at 0.52 rad the traffic
  // lines and the corduroy are both fully retired, so a kicker's ramp and its
  // landing come out smooth and salted while the flat run-in either side of
  // them keeps its comb — which is exactly what a shaped feature looks like.
  // The rock mask is a live problem here rather than a theoretical one — see
  // the rock channel in the generated terrJumps, and PARK_ROCK_BIAS. A ramp is
  // 0.44 rad on its own and its flank stands at 0.73, well past the 0.55 rad
  // where macroGate opens, so the bias is what keeps the sides of the kickers
  // white; without it they render as bedrock ribs down both flanks.
  float jAmt, jRock;
  terrJumps( P, h, g, jAmt, jRock );

  // Slope used for the rock blend. Deliberately excludes the metre-scale
  // detail: a mask keyed on the full normal snaps to LOD triangle edges,
  // because per-vertex normals are only linearly interpolated across a face.
  float coarseSteep = atan( length( g ) );
  h += cornH;
  g += cornG;
  if ( fadeM > 0.002 ) {
    float gate = smoothstep( 0.16, 0.34, slope ) * smoothstep( 1.05, 0.62, slope ) * soft;
    float amp = 0.28 * gate * fadeM * ( 1.0 - 0.92 * jAmt );
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
  // ...and the rock-exposure channel is pushed down over the park for the same
  // reason a cornice pushes it down: this is snow a machine put here, and a
  // 42-degree flank is not a talus slope however the mask reads the angle.
  dspD = vec4( coarseSteep, mdata.y, mdata.z,
               mdata.w - cornAmt * 1.6 - jRock * ${glf(PARK_ROCK_BIAS)} );
  // LOD skirt. Only has to swallow the sub-cell reconstruction difference
  // between neighbouring levels, so it is kept to about one cell: a deep skirt
  // on a 100 m coarse level hangs hundreds of metres and pokes out of the
  // mountainside as a bright sliver.
  dspSkirt = aSkirt * modelMatrix[ 0 ].x * ( 0.8 + 1.6 * min( length( g ), 1.5 ) );
}
`;
