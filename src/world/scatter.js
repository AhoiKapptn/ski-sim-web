/**
 * Alpine — vegetation, rock and resort props.
 *
 * Everything here is generated in code: no meshes, no textures, no assets.
 *
 * Contents
 * --------
 *  1. Procedural atlases (needle sprig / bark / snow, distant-tree impostors,
 *     safety-net weave) drawn into 2D canvases.
 *  2. A geometry builder + conifer generator. A conifer is a swept, tapering,
 *     slightly leaning trunk with whorled tiers of branches. Each branch is a
 *     drooping frond of two alpha quads tilted into a shallow V, capped by a
 *     three-column ridge of snow that sags with the branch. The snow ridge is
 *     the whole point: it is what makes a green blob read as an alpine conifer
 *     in February.
 *  3. Rocks: icosahedra pushed around by 3D value noise, then sliced by a few
 *     random half-spaces so they fracture into flat facets, faceted normals,
 *     per-face snow on the up-facing planes, and a snow apron at the base.
 *  4. A chunked streamer. The world is diced into 128 m cells; a cell is
 *     populated on demand from a deterministic PRNG and cached. Instances live
 *     in packed instanced pools (swap-with-last removal, so `count` is always
 *     exactly the live set) and move between three LOD pools as the player
 *     approaches. The outermost band scales in from zero in the vertex shader,
 *     so nothing ever pops into existence.
 *  5. Resort infrastructure along the fall-line corridor: piste marker poles,
 *     a slalom course, B-net safety fencing, and a full chairlift — lattice
 *     towers, sheave trains, catenary-sagged cables and chairs that actually
 *     circulate.
 *
 * Density
 * -------
 * Never a uniform sprinkle. Density is the product of: distance off the piste
 * (the run is a cut through the forest), altitude against a wobbling treeline
 * (dense stand -> thinning -> stunted krummholz -> bare), slope (nothing on
 * cliffs), flow accumulation (avalanche gullies stay clear), and a low-frequency
 * clumping field that opens glades.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------- constants --
const CHUNK = 96;                // streaming cell, metres
const NEAR_R = 300;              // cells nearer than this carry individual stems
const MOVE_RE = 12;              // re-emit the near cells every this many metres
const EMIT_PAD = 22;             // metres of slop around a band's fade limits
const R_FAR = 1240;              // outermost cull radius
const CACHE_R = 2200;            // chunk records kept beyond this are dropped

/**
 * LOD bands, as (fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd) in metres.
 *
 * Adjacent bands share their crossover interval exactly, and an item carries
 * the same dither threshold into both pools, so across the overlap precisely
 * one of the two representations draws for any given tree. That is a true
 * dissolve rather than the instant geometry swap the previous build did at 118
 * and 330 m.
 *
 * The sun's shadow camera only spans 95 m around the skier (sky.js), so
 * everything inside that radius — G0 and G1 — has to cast; nothing beyond it
 * can, however the flags are set.
 */
const B_G0 = [-2, -1, 34, 46];        // full geometry
// Real geometry now runs to 150 m, not 112. The gate's measurement was that a
// card subtending ~40 px at 92-210 m cannot resolve a needle silhouette however
// it is filtered, so the fix is to keep real branches out to the distance where
// the card is genuinely sub-pixel detail. Measured cost: tree1 goes from 59 to
// ~110 instances in the hero framing, ~0.15 ms.
const B_G1 = [34, 46, 130, 150];      // reduced geometry
const B_IMP = [130, 150, 210, 250];   // single-tree cards
// Cluster cards are an independent population from the individual stems (their
// own grid in genFar), so their band overlaps B_IMP rather than tiling with it.
// Moving their fade-in out with B_IMP measurably thinned the 172-210 m canopy —
// that range is where closure comes from the clusters, not the stems.
const B_CL = [128, 150, 580, 660];    // cluster cards, ~8 stems each
const B_MASS = [580, 660, 1080, 1200]; // canopy-mass cards, ~40 stems each

const B_ROCK0 = [-2, -1, 52, 70];
const B_ROCK1 = [52, 70, 520, 620];
const B_LOG0 = [-2, -1, 44, 58];
const B_LOG1 = [44, 58, 150, 190];
const B_DRIFT0 = [-2, -1, 58, 76];
const B_DRIFT1 = [58, 76, 320, 390];

// card footprints, metres
const CL_W = 21, CL_H = 27, CL_SINK = 5.0;
const MASS_W = 52, MASS_H = 33, MASS_SINK = 7.0;

const TREELINE = 662;            // metres; where conifers give out
const FOREST_BAND = 235;         // metres below treeline to reach full density
const KRUMM_LO = 560, KRUMM_HI = 790;

const PISTE_HALF = 46;           // cleared half width of the run
const PISTE_SOFT = 85;           // ...and the metres over which forest closes in
const LIFT_OFFSET = -68;         // lift line, metres from corridor centreline
const LIFT_Z0 = -1460, LIFT_Z1 = 2440;
const LIFT_SPAN = 104;

const UP = new THREE.Vector3(0, 1, 0);

/** Corridor centreline — must match terrain.js exactly. */
const corridorX0 = (z) => 78 * Math.sin(z * 0.00092) + 34 * Math.sin(z * 0.00231 + 1.3);

/**
 * Resort buildings, placed off the corridor centreline. `off` is metres to the
 * side (negative = the lift side), `clear` the radius the forest is pushed back
 * by so nothing grows through a roof.
 *
 * Everything here answers the acceptance gate's first and loudest finding: the
 * mountain was empty. A real piste has a mid-station, a restaurant with a
 * terrace, a patrol hut, a snow-gun line, a groomer and a village below it.
 */
const BUILDINGS = [
  // Mid-mountain restaurant with a south-facing terrace. Placed by MEASUREMENT,
  // not by eye: a ray-march from the hero camera says a point 7 m over the snow
  // at (z 580-620, 80-120 m off the centreline) clears the crest at 140-190 m,
  // where a 13 m building subtends ~70 px. Buildings sunk behind the roll of
  // the piste are buildings that are not in the frame.
  { z: 596, off: 86, yaw: -0.5, w: 8.5, d: 12.0, h: 6.6, roofH: 3.6, deck: 9.0, skis: 7, clear: 50 },
  // lift mid-station shed, hard against the lift line
  { z: 566, off: -70, yaw: 0.10, w: 6.0, d: 9.5, h: 5.4, roofH: 2.8, skis: 3, clear: 42 },
  // piste patrol / ski school hut on the far shoulder
  { z: 300, off: 80, yaw: 0.9, w: 4.4, d: 6.0, h: 4.0, roofH: 2.2, skis: 4, clear: 32 },
  // an old alm barn further down, off the shoulder
  { z: -318, off: -88, yaw: 2.1, w: 5.2, d: 7.5, h: 4.4, roofH: 2.6, clear: 34 },
  { z: -690, off: 92, yaw: 1.2, w: 6.4, d: 8.5, h: 5.0, roofH: 2.9, deck: 6.0, skis: 5, clear: 40 },
].map((b) => ({ ...b, x: corridorX0(b.z) + b.off }));

const GROOMERS = [
  // parked on the shoulder 65 m below the hero camera, where the visibility
  // march says it clears the roll of the piste
  { z: 620, off: 40, yaw: 1.22 },
  { z: -352, off: -60, yaw: -0.6 },
].map((g) => ({ ...g, x: corridorX0(g.z) + g.off }));

/** Valley village, 1.5 km down the fall line. */
const VILLAGE = { z: -1180, x: corridorX0(-1180) + 40, r: 150 };

// ------------------------------------------------------------------- maths --
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashi(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

const hash2 = (x, y) => hashi(x, y, 0x9e37) / 4294967296;

function vnoise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm2(x, y, oct) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise2(x, y);
    n += a;
    const nx = (0.8 * x - 0.6 * y) * 2.07, ny = (0.6 * x + 0.8 * y) * 2.07;
    x = nx; y = ny; a *= 0.5;
  }
  return s / n;
}

const hash3 = (x, y, z) => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function vnoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const c = (i, j, k) => hash3(ix + i, iy + j, iz + k);
  const l = (a, b, t) => a + (b - a) * t;
  const x00 = l(c(0, 0, 0), c(1, 0, 0), ux), x10 = l(c(0, 1, 0), c(1, 1, 0), ux);
  const x01 = l(c(0, 0, 1), c(1, 0, 1), ux), x11 = l(c(0, 1, 1), c(1, 1, 1), ux);
  return l(l(x00, x10, uy), l(x01, x11, uy), uz);
}

function fbm3(x, y, z, oct) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise3(x, y, z);
    n += a;
    x = x * 2.03 + 11.3; y = y * 2.03 - 7.1; z = z * 2.03 + 3.7;
    a *= 0.5;
  }
  return s / n;
}

/** Corridor centreline — must match terrain.js exactly. */
const corridorX = corridorX0;

/**
 * Stand vigour: the multiplier on canopy height at a point.
 *
 * This is the fix for the "picket fence" read, and it is a *field*, not a
 * per-tree random. Per-tree randomness was already wide (0.44..1.24 on the
 * stems) and it did not help, because randomising every stem independently
 * makes a stand whose MEAN height is the same everywhere — which is exactly
 * what a row of near-identical spires looks like from 300 m, where individual
 * stems are 2 px wide and only the envelope is resolved.
 *
 * A real forest is the other way round: neighbouring trees are the same age on
 * the same soil and match each other closely, while one stand and the next
 * differ by a factor of two. Site quality varies over hundreds of metres (soil
 * depth, avalanche return period, aspect) and stand age over tens (the last
 * blowdown, the last slide path). Two octaves at 170 m and 52 m give both, and
 * the ENVELOPE of the treeline then has structure at the wavelength the eye
 * actually resolves at that distance.
 *
 * Range 0.62..1.42 — deliberately wide enough that a mature stand next to a
 * regrowing slide path is an obvious step, not a texture.
 */
function standVigour(x, z) {
  const a = fbm2(x * 0.0059 + 17.3, z * 0.0059 - 9.1, 2);
  const b = fbm2(x * 0.0192 - 3.7, z * 0.0192 + 6.4, 2);
  return 0.62 + 0.80 * smoothstep(0.16, 0.84, a * 0.66 + b * 0.34);
}

/**
 * Stand closure: independent of vigour, and what puts real HOLES in a stand
 * rather than an even thinning. 58 m wavelength — glades, blowdown gaps and
 * the bare ground under a mature crown are all about that size.
 */
function standGap(x, z) {
  return smoothstep(0.30, 0.66, fbm2(x * 0.0172 + 41.2, z * 0.0172 - 7.9, 2));
}

// =============================================================================
// Procedural textures
// =============================================================================
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const OFF8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * Widen bright (snow) coverage by one texel per pass. Thin white strokes drawn
 * over a dense dark needle mass are the first thing mip reduction throws away —
 * the tree then loses exactly the cue that says "alpine winter". Dilating the
 * snow before the mip chain is built keeps it alive four or five levels down.
 */
function dilateBright(d, W, H, passes) {
  for (let p = 0; p < passes; p++) {
    const c = d.slice();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        if (c[i + 3] > 215) continue;
        let ba = 0, br = 0, bg = 0, bb = 0;
        for (let k = 0; k < 8; k++) {
          const j = ((y + OFF8[k][1]) * W + (x + OFF8[k][0])) * 4;
          const a = c[j + 3];
          if (a < 200) continue;
          if (0.3 * c[j] + 0.59 * c[j + 1] + 0.11 * c[j + 2] < 178) continue;
          if (a > ba) { ba = a; br = c[j]; bg = c[j + 1]; bb = c[j + 2]; }
        }
        if (ba > 0) {
          d[i] = br; d[i + 1] = bg; d[i + 2] = bb;
          d[i + 3] = Math.max(c[i + 3], ba * 0.9);
        }
      }
    }
  }
}

/**
 * Flood the RGB of fully transparent texels outward from opaque ones. Without
 * it every mip level averages the visible colour against black and the whole
 * canopy darkens as it recedes.
 */
function bleedRGB(d, W, H, passes) {
  const filled = new Uint8Array(W * H);
  for (let q = 0; q < W * H; q++) filled[q] = d[q * 4 + 3] >= 8 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const f0 = filled.slice();
    const c = d.slice();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const q = y * W + x;
        if (f0[q]) continue;
        let n = 0, r = 0, g = 0, b = 0;
        for (let k = 0; k < 8; k++) {
          const xx = x + OFF8[k][0], yy = y + OFF8[k][1];
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q2 = yy * W + xx;
          if (!f0[q2]) continue;
          const j = q2 * 4;
          r += c[j]; g += c[j + 1]; b += c[j + 2]; n++;
        }
        if (n) {
          const i = q * 4;
          d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n;
          filled[q] = 1;
        }
      }
    }
  }
}

/**
 * Alpha-coverage-preserving mip chain.
 *
 * Half of the white-treeline fix (the other half is the specular kill in
 * patchFoliage). A stock box-filtered mip chain averages a lace of 2 px needle
 * strokes toward alpha ~ 0.15 by level 4; the alpha test then cuts everything
 * under 0.30, so a 200 m spruce loses its dark needle mass while the few dense
 * (pale, rimed) clusters survive, and what is left is a thin bright skeleton
 * with sunlit snow showing through it. Measured at the hero framing: the
 * silhouette the cards actually drew grew from 59 000 to 75 000 px when this
 * was switched on, at identical instance counts.
 *
 * Every level is rescaled so the fraction of texels passing the alpha test
 * matches level 0 — the standard "alpha-tested coverage" mip fix (Castano).
 * RGB is averaged alpha-weighted so a shrinking tree keeps its colour instead
 * of drifting toward its transparent surround.
 */
function coverageMipmaps(base, W, H, alphaRef) {
  const ref = Math.round(alphaRef * 255);
  const covOf = (d, k) => {
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (Math.min(255, d[i] * k) >= ref) n++;
    return n / (d.length >> 2);
  };
  const target = covOf(base, 1);
  const mips = [{ data: base, width: W, height: H }];
  let src = base, w = W, h = H;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const dst = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.min(y * 2, h - 1), y1 = Math.min(y * 2 + 1, h - 1);
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(x * 2, w - 1), x1 = Math.min(x * 2 + 1, w - 1);
        let r = 0, g = 0, b = 0, a = 0, wa = 0;
        for (const yy of [y0, y1]) for (const xx of [x0, x1]) {
          const i = (yy * w + xx) * 4, al = src[i + 3];
          // alpha-weighted colour, but never zero-weighted: the RGB of
          // transparent texels was already bled outward from the opaque ones,
          // so it is a usable fallback rather than black
          const ww = al + 8;
          r += src[i] * ww; g += src[i + 1] * ww; b += src[i + 2] * ww;
          a += al; wa += ww;
        }
        const o = (y * nw + x) * 4;
        dst[o] = r / wa; dst[o + 1] = g / wa; dst[o + 2] = b / wa; dst[o + 3] = a * 0.25;
      }
    }
    // solve for the alpha scale that restores level 0's coverage
    if (target > 0) {
      let lo = 0.25, hi = 6.0;
      for (let it = 0; it < 12; it++) {
        const mid = 0.5 * (lo + hi);
        if (covOf(dst, mid) < target) lo = mid; else hi = mid;
      }
      const k = 0.5 * (lo + hi);
      if (Math.abs(k - 1) > 0.01) {
        for (let i = 3; i < dst.length; i += 4) dst[i] = Math.min(255, dst[i] * k);
      }
    }
    mips.push({ data: dst, width: nw, height: nh });
    src = dst; w = nw; h = nh;
  }
  return mips;
}

/**
 * Canvas -> DataTexture. A CanvasTexture round-trips through premultiplied
 * storage, which destroys the bled RGB of transparent texels; uploading the
 * raw bytes ourselves keeps it. Rows are flipped so UV conventions match
 * CanvasTexture (v = 0 at the bottom of the canvas).
 *
 * `opts.alphaRef` switches on the coverage-preserving mip chain above; pass the
 * material's alphaTest.
 */
function canvasToTexture(cv, opts = {}) {
  const W = cv.width, H = cv.height;
  const img = cv.getContext('2d').getImageData(0, 0, W, H);
  const src = img.data;
  if (opts.dilate) dilateBright(src, W, H, opts.dilate);
  if (opts.bleed) bleedRGB(src, W, H, opts.bleed);
  const out = new Uint8Array(W * H * 4);
  const row = W * 4;
  for (let y = 0; y < H; y++) out.set(src.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  const tex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  if (opts.alphaRef) {
    tex.mipmaps = coverageMipmaps(out, W, H, opts.alphaRef);
    tex.generateMipmaps = false;
  } else {
    tex.generateMipmaps = true;
  }
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = opts.wrap || THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// =============================================================================
// Tree atlas — 2048^2, a 4 x 4 grid of 512 px tiles.
//
//   row 0   sprig 0..3        needle sprays, alpha frayed on every edge
//   row 1   sprigSnow 0,1     the same sprays buried under fresh load
//           blanket           crest strip: opaque core, lips fray to nothing
//           clump             a discrete pile of snow, frayed all round
//   row 2   bark 0, bark 1    trunk bark (repeats vertically up the bole)
//           wood              branch bark
//           litter            fallen needles and twigs (alpha)
//   row 3   bark 2, bark 3
//           dead              bare weathered twigs (alpha)
//           snow              packed snow, opaque
//
// Nothing in the foliage is a rectangle. A branch is covered by eight to
// fourteen small sprig cards rolled about its own axis, and the silhouette of
// the crown is the union of their frayed alpha — there is no polygon edge in
// it anywhere, which is what the old two-plane frond could never manage.
// =============================================================================
const AT_S = 2048;
const AT_T = 512;                       // tile size
// Transparent margin around every sprig tile, as a fraction of the tile. The
// sprig geometry compensates with 1/SPRIG_SCALE so the foliage keeps its size
// in metres — only the card's rectangle grows, and it grows into empty alpha.
const SPRIG_INSET = 0.085;
const SPRIG_SCALE = 1 - 2 * SPRIG_INSET;

/** Tapered needle as a triangle — round caps read as bristles, not needles. */
function needleTri(g, x, y, ang, len, w) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const px = -dy * w * 0.5, py = dx * w * 0.5;
  g.beginPath();
  g.moveTo(x + px, y + py);
  g.lineTo(x - px, y - py);
  g.lineTo(x + dx * len, y + dy * len);
  g.closePath();
  g.fill();
}

/**
 * One sprig tile: a short length of shoot with its needles running left to
 * right, foliage both sides, tapering to a frayed tip.
 *
 * `bundles` gives pines their radiating tufts instead of a flat comb; `gap`
 * is how often a shoot is simply missing, which is most of the raggedness.
 */
function paintSprig(g, rnd, ox, oy, cfg) {
  const S = AT_T, cy = oy + S * 0.5;
  g.save();
  g.beginPath(); g.rect(ox, oy, S, S); g.clip();
  // SPRIG_INSET: everything below is painted into the inner (1 - 2 x inset) of
  // the tile, so the alpha reaches zero well before the card's own rectangle.
  // The old art ran straight off all four edges: the clip rectangle *was* the
  // silhouette, which is why a near frond read as a photograph of foliage
  // trimmed with scissors. The card geometry is scaled up by 1/SPRIG_SCALE to
  // compensate, so the foliage is the same size in metres.
  g.translate(ox + S * SPRIG_INSET, oy + S * SPRIG_INSET);
  g.scale(SPRIG_SCALE, SPRIG_SCALE);
  g.translate(-ox, -oy);

  // silhouette envelope: rises off the attachment, wobbles, tapers to nothing.
  // Both ends must reach zero: a residual 14% at s = 1 left a straight vertical
  // row of needle ends across the card.
  const env = (x, side) => {
    const s = x / S;
    const along = smoothstep(0.0, 0.20, s) * (1 - smoothstep(0.50, 1.0, s));
    const rough = 0.40 + 0.82 * fbm2(x * 0.017 + side * 29.3 + cfg.seed, cfg.seed * 2.9, 3);
    return clamp(along * rough, 0, 1);
  };
  const wav = (x) => cy + 11 * Math.sin((x - ox) * 0.0085 + cfg.seed) * (x - ox) / S;

  // ---- shoot --------------------------------------------------------------
  g.globalAlpha = 1;
  g.strokeStyle = '#3b3225';
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(ox, wav(ox));
  for (let x = 0; x <= S; x += 24) {
    // taper to nothing at the tip end, and off the attachment end too, so the
    // shoot never terminates in a flat-cut stub on the card boundary
    g.lineWidth = 7 * Math.pow(Math.max(0, 1 - x / S), 0.85) * smoothstep(0, 0.05, x / S);
    g.lineTo(ox + x, wav(ox + x));
    g.stroke();
    g.beginPath();
    g.moveTo(ox + x, wav(ox + x));
  }

  const shoots = [];
  for (let x = 6; x < S + 12; x += cfg.step * (0.45 + 0.7 * rnd())) {
    for (const sideS of [-1, 1]) {
      if (rnd() < cfg.gap) continue;
      const e = env(x, sideS);
      if (e < 0.05) continue;
      const acr = cfg.reach * e * (0.28 + 0.72 * Math.pow(rnd(), 1.1));
      if (acr < 7) continue;
      shoots.push({ x: ox + x, side: sideS, acr, sweep: 0.7 + 1.7 * rnd(), d: rnd() });
    }
  }
  shoots.sort((a, b) => a.d - b.d);

  const needleCol = () => {
    const q = rnd();
    if (q < cfg.frost) {
      // rime, not paint: pale sage rather than white. Bright white needles at
      // any real frequency are what read as speckle from thirty metres.
      g.globalAlpha = 0.6 + 0.35 * rnd();
      return `hsl(${140 + rnd() * 50}, ${6 + rnd() * 8}%, ${52 + rnd() * 18}%)`;
    }
    if (q < cfg.frost + cfg.dead) {
      g.globalAlpha = 0.88;
      return `hsl(${26 + rnd() * 20}, ${14 + rnd() * 16}%, ${22 + rnd() * 14}%)`;
    }
    g.globalAlpha = 0.84 + 0.16 * rnd();
    return `hsl(${cfg.hue + rnd() * cfg.hueSpan}, ${cfg.sat + rnd() * 13}%, ${cfg.li + rnd() * cfg.liSpan}%)`;
  };

  for (const sh of shoots) {
    const x0 = sh.x, y0 = wav(sh.x);
    const ex = x0 + sh.acr * sh.sweep;
    const ey = y0 + sh.side * sh.acr;
    const ang = Math.atan2(ey - y0, ex - x0);
    const L = Math.hypot(ex - x0, ey - y0);
    g.globalAlpha = 0.9;
    g.strokeStyle = '#38301f';
    g.lineWidth = 1.2 + 1.6 * (sh.acr / cfg.reach);
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(ex, ey); g.stroke();

    if (cfg.bundles) {
      // pine: bundles of long needles at intervals, radiating like a brush
      const nB = Math.max(2, Math.round(L / (cfg.nlen * 0.8)));
      for (let i = 0; i < nB; i++) {
        const t = (i + 0.4) / nB;
        const px = x0 + (ex - x0) * t, py = y0 + (ey - y0) * t;
        const nf = 5 + Math.floor(rnd() * 4);
        for (let k = 0; k < nf; k++) {
          const na = ang + (k / nf - 0.5) * 2.0 + (rnd() - 0.5) * 0.35;
          g.fillStyle = needleCol();
          needleTri(g, px, py, na, cfg.nlen * (0.6 + 0.75 * rnd()), 2.0 + rnd() * 1.5);
        }
      }
    } else {
      const nN = Math.max(3, Math.round(L / cfg.nspace));
      for (let i = 0; i < nN; i++) {
        const t = (i + 0.3) / nN;
        const px = x0 + (ex - x0) * t, py = y0 + (ey - y0) * t;
        const taper = 0.42 + 0.68 * Math.sin(Math.PI * Math.pow(t, 0.7));
        const ranks = t > 0.7 ? 4 : 3;
        for (let r2 = 0; r2 < ranks; r2++) {
          const s2 = r2 >= 2 ? (r2 === 2 ? 0 : 0.4) : (r2 ? 1 : -1);
          const na = ang + s2 * (0.5 + 0.6 * rnd()) + (rnd() - 0.5) * 0.25;
          g.fillStyle = needleCol();
          needleTri(g, px, py, na, cfg.nlen * taper * (0.55 + 0.85 * rnd()), 2.2 + rnd() * 1.6);
        }
      }
    }
    // terminal bud fan — the frayed outer edge of the spray
    const nf = 4 + Math.floor(rnd() * 4);
    for (let i = 0; i < nf; i++) {
      const na = ang + (i / nf - 0.5) * 1.6 + (rnd() - 0.5) * 0.3;
      g.fillStyle = needleCol();
      needleTri(g, ex, ey, na, cfg.nlen * (0.5 + 0.7 * rnd()), 2.0 + rnd() * 1.3);
    }
  }

  // ---- fray: isolated tips just past the silhouette, so the alpha cut lands
  // on broken speckle rather than on a clean contour ------------------------
  for (let i = 0; i < 2600; i++) {
    const x = ox + rnd() * S;
    const sideS = rnd() < 0.5 ? -1 : 1;
    const e = env(x - ox, sideS);
    if (e < 0.04) continue;
    const y = wav(x) + sideS * cfg.reach * e * (0.30 + 0.82 * rnd());
    const na = rnd() * Math.PI * 2;
    g.fillStyle = needleCol();
    g.globalAlpha *= 0.75;
    needleTri(g, x, y, na, cfg.nlen * (0.3 + 0.6 * rnd()), 1.6 + rnd() * 1.2);
  }
  g.globalAlpha = 1;
  g.restore();
}

/**
 * Fill the region between two rough curves with a top-lit snow gradient.
 *
 * This is the whole trick for making load read as *snow* rather than as white
 * paint: real accumulated snow presents a crisp, granular top edge with a soft
 * vertical falloff into blue shadow underneath, and a ragged bottom edge where
 * the foliage it sits on breaks through. Clusters of soft ellipses — the
 * obvious way to do it — always come out as cumulus cloud.
 */
function snowFill(g, xs, top, bot, bright) {
  let y0 = 1e9, y1 = -1e9;
  for (let i = 0; i < xs.length; i++) { if (top[i] < y0) y0 = top[i]; if (bot[i] > y1) y1 = bot[i]; }
  if (y1 - y0 < 2) return;
  const grd = g.createLinearGradient(0, y0, 0, y1);
  // Mostly white. The lighting supplies the shading; a texture that is already
  // mid-grey comes out as a dead grey shard once the sun is on it.
  grd.addColorStop(0.00, `hsl(206, 30%, ${clamp(99 * bright, 0, 100)}%)`);
  grd.addColorStop(0.40, `hsl(206, 18%, ${clamp(95 * bright, 0, 100)}%)`);
  grd.addColorStop(0.76, `hsl(210, 16%, ${clamp(84 * bright, 0, 100)}%)`);
  grd.addColorStop(1.00, `hsl(216, 20%, ${clamp(64 * bright, 0, 100)}%)`);
  g.globalAlpha = 1;
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(xs[0], top[0]);
  for (let i = 1; i < xs.length; i++) g.lineTo(xs[i], top[i]);
  for (let i = xs.length - 1; i >= 0; i--) g.lineTo(xs[i], bot[i]);
  g.closePath();
  g.fill();
}

/** Granular sparkle and rolled crown along a snow top edge. */
function snowCrown(g, rnd, xs, top, hh) {
  for (let i = 0; i < xs.length; i++) {
    if (rnd() < 0.55) {
      g.globalAlpha = 0.30 + rnd() * 0.55;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.ellipse(xs[i] + (rnd() - 0.5) * 6, top[i] + hh * (0.04 + 0.12 * rnd()),
        2.5 + rnd() * 7, 1.6 + rnd() * 3.4, (rnd() - 0.5) * 0.7, 0, 7);
      g.fill();
    }
    if (rnd() < 0.22) {
      g.globalAlpha = 0.5 + rnd() * 0.5;
      g.fillStyle = '#ffffff';
      g.fillRect(xs[i], top[i] + rnd() * hh * 0.4, 1.3 + rnd() * 1.8, 1.3 + rnd() * 1.8);
    }
  }
  g.globalAlpha = 1;
}

/** Wind-packed granularity across a snow body, so it is never a flat ramp. */
function snowGrain(g, rnd, xs, top, bot, amount) {
  const n = Math.round(xs.length * 14 * amount);
  for (let i = 0; i < n; i++) {
    const k = (rnd() * xs.length) | 0;
    const t = rnd();
    const y = top[k] + (bot[k] - top[k]) * t;
    g.globalAlpha = 0.06 + rnd() * 0.16;
    g.fillStyle = rnd() < 0.5 ? '#ffffff' : `hsl(${212 + rnd() * 10}, 20%, ${50 + rnd() * 22}%)`;
    g.beginPath();
    g.ellipse(xs[k] + (rnd() - 0.5) * 10, y, 3 + rnd() * 14, 2 + rnd() * 6,
      (rnd() - 0.5) * 0.8, 0, 7);
    g.fill();
  }
  g.globalAlpha = 1;
}

/**
 * One mound of load riding a shoot. The crown is a fractal-perturbed arc and
 * the underside is bitten away in places, so needles come through the snow.
 */
function snowLobe(g, rnd, cx, baseY, hw, hh, bright) {
  const n = Math.max(8, Math.round(hw / 3));
  const xs = [], top = [], bot = [];
  const ph = rnd() * 30;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const dx = (t * 2 - 1);
    const x = cx + dx * hw;
    // a flat-topped mound, not a semicircle: snow slumps
    const mound = Math.pow(Math.max(0, 1 - dx * dx), 0.42);
    const rough = 0.70 + 0.44 * fbm2(t * 13.7 + ph, ph * 0.7, 3);
    xs.push(x);
    top.push(baseY - hh * mound * rough);
    bot.push(baseY + hh * 0.42 * mound * (0.25 + 0.85 * fbm2(t * 5.1 - ph, ph * 1.9, 2)));
  }
  snowFill(g, xs, top, bot, bright);
  snowGrain(g, rnd, xs, top, bot, 0.55);
  snowCrown(g, rnd, xs, top, hh);
  // bite the underside so foliage shows through the load
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < Math.round(hw * 0.30); i++) {
    const t = rnd();
    const x = cx + (t * 2 - 1) * hw;
    const mound = Math.pow(Math.max(0, 1 - (t * 2 - 1) ** 2), 0.42);
    g.globalAlpha = 0.5 + 0.5 * rnd();
    g.beginPath();
    g.ellipse(x, baseY + hh * 0.34 * mound + rnd() * hh * 0.2,
      3 + rnd() * 12, 2 + rnd() * 8, (rnd() - 0.5) * 0.8, 0, 7);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

/**
 * A sprig with load on it: the needle spray painted first, then a row of
 * discrete mounds riding the shoot with needles showing between them. A loaded
 * tree is mostly these cards, rolled flat so their faces point up — which is
 * how the crown ends up carrying accumulated snow rather than white speckle.
 */
function paintSprigSnow(g, rnd, ox, oy, cfg) {
  paintSprig(g, rnd, ox, oy, cfg);
  const S = AT_T, cy = oy + S * 0.5;
  g.save();
  g.beginPath(); g.rect(ox + 5, oy + 5, S - 10, S - 10); g.clip();
  // same inset as paintSprig — the load must not be the thing that reaches the
  // card boundary either
  g.translate(ox + S * SPRIG_INSET, oy + S * SPRIG_INSET);
  g.scale(SPRIG_SCALE, SPRIG_SCALE);
  g.translate(-ox, -oy);

  const env = (x) => {
    const s = (x - ox) / S;
    const along = smoothstep(-0.02, 0.24, s) * (1 - 1.0 * smoothstep(0.48, 1.0, s));
    return clamp(along * (0.44 + 0.80 * fbm2(s * 4.3 + 7.1, cfg.seed * 5.1, 3)), 0, 1);
  };

  // REFERENCE (Wikimedia "Snow covered spruce trees", close range): load on a
  // spruce frond is not a row of mounds. It is a fine, continuous, granular
  // COATING lying along the upper face of the spray, following every sub-shoot,
  // with the dark needle showing through in a hundred small gaps. Its spatial
  // frequency is roughly that of the needle detail itself.
  //
  // The old tile drew four to six lobes up to 135 px across in a 512 px tile —
  // three or four fat white blobs per card. Rolled flat and instanced a hundred
  // times up a crown that reads at close range as a tree hung with white
  // blades, which is exactly what gate 2 called a paper cutout. Same total
  // coverage, two orders of magnitude more pieces.
  //
  // The load is confined to the -y half of the tile in canvas space, i.e. the
  // +v side of the card, because sprigs() rolls a loaded card face-up and only
  // that side is the "upper surface" of the frond.
  const NL = 46;
  for (let i = 0; i < NL; i++) {
    const t = (i + 0.15 + rnd() * 0.7) / NL;
    const x = ox + S * (0.03 + 0.92 * t);
    const e = env(x);
    if (e < 0.10) continue;
    // ride the upper face of the spray, from just above the shoot out to the
    // needle tips; thickest where the spray is widest
    const up = 0.06 + 0.92 * Math.pow(rnd(), 0.75);
    const y = cy - cfg.reach * e * up;
    const room = Math.min(x - ox, ox + S - x, y - oy, cy + S * 0.16 - y) - 8;
    if (room < 8) continue;
    const hw = Math.min(cfg.reach * e * (0.055 + 0.11 * rnd()) + 7, room);
    if (hw < 8) continue;
    const hh = hw * (0.44 + 0.34 * rnd());
    // load thins toward the outer tips: a needle tip carries a rim, the
    // interior of the frond carries a blanket
    snowLobe(g, rnd, x, y, hw, hh, 1.0 - 0.10 * up);
  }

  // a handful of heavier accumulations where two sub-shoots meet
  for (let i = 0; i < 5; i++) {
    const x = ox + S * (0.12 + 0.62 * rnd());
    const e = env(x);
    if (e < 0.22) continue;
    const y = cy - cfg.reach * e * (0.05 + 0.42 * rnd());
    const room = Math.min(x - ox, ox + S - x, y - oy) - 10;
    const hw = Math.min(cfg.reach * e * (0.16 + 0.16 * rnd()), room);
    if (hw < 12) continue;
    snowLobe(g, rnd, x, y, hw, hw * (0.40 + 0.22 * rnd()), 1.0);
  }
  g.globalAlpha = 1;
  g.restore();
}

/**
 * Crest blanket: a band of load with both edges frayed to nothing, brightest
 * along the crest at v = 0.5 and falling into blue shadow at the lips. The
 * branch load strip maps this across its width, so the *texture* decides where
 * the snow ends and the geometry never shows a straight lip.
 */
function paintBlanket(g, rnd, ox, oy) {
  const S = AT_T, cy = oy + S * 0.5;
  g.save();
  g.beginPath(); g.rect(ox, oy, S, S); g.clip();
  const n = 170;
  const xs = [], top = [], bot = [];
  // dies away at both ends of the tile, because the strip maps it once end to
  // end down a branch: the load has to run out where the branch does
  const half = (u) => S * 0.30 * clamp(
    1.45 * fbm2(u * 3.9 + 11.7, 5.3, 3) * (0.30 + 0.98 * fbm2(u * 13.1 - 4.1, 21.9, 2)) - 0.10,
    0, 1) * smoothstep(0, 0.09, u) * smoothstep(1, 0.90, u);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const h = half(u);
    xs.push(ox + u * S);
    // high-frequency, low-amplitude perturbation: a granular lip, not a spike
    top.push(cy - h * (0.86 + 0.26 * fbm2(u * 47.3, 3.7, 2)));
    bot.push(cy + h * (0.80 + 0.34 * fbm2(u * 39.9 + 5.1, 9.3, 2)));
  }
  snowFill(g, xs, top, bot, 1.0);
  snowGrain(g, rnd, xs, top, bot, 0.7);
  snowCrown(g, rnd, xs, top, S * 0.06);
  // break the band outright in a few places
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i <= n; i++) {
    if (half(i / n) > S * 0.06) continue;
    g.globalAlpha = 1;
    g.fillRect(xs[i] - 3, oy, 8, S);
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.restore();
}

/** A discrete pile of snow: broken outline, rolled bright top, blue base. */
function paintClump(g, rnd, ox, oy) {
  const S = AT_T, cx = ox + S * 0.5, cy = oy + S * 0.5;
  g.save();
  g.beginPath(); g.rect(ox + 5, oy + 5, S - 10, S - 10); g.clip();
  snowLobe(g, rnd, cx, cy + S * 0.13, S * 0.36, S * 0.28, 1.0);
  snowLobe(g, rnd, cx - S * 0.24, cy + S * 0.17, S * 0.16, S * 0.15, 0.94);
  snowLobe(g, rnd, cx + S * 0.25, cy + S * 0.16, S * 0.15, S * 0.14, 1.02);
  snowLobe(g, rnd, cx - S * 0.06, cy - S * 0.06, S * 0.17, S * 0.13, 1.03);
  g.globalAlpha = 1;
  g.restore();
}

/**
 * Trunk bark, painted into the colour atlas and a matching height canvas at
 * the same time, so the normal map carries exactly the fissures the albedo
 * shows. The tile wraps once around a ~1.3 m bole and repeats every ~2 m up
 * it — about 1.6:1 anisotropy, which `KY` compensates for.
 */
function paintBark(gC, gH, ox, oy, kind, rnd) {
  const S = AT_T;
  const KY = 0.65;
  const P = [
    { h: 24, s: 14, l: 32, fis: 1.0, pw: 0.16, ph: 0.34, lich: 0.5 },   // 0 spruce, scaly
    { h: 32, s: 9, l: 48, fis: 0.5, pw: 0.30, ph: 0.20, lich: 0.9 },    // 1 fir, smooth pale
    { h: 18, s: 24, l: 34, fis: 1.5, pw: 0.22, ph: 0.55, lich: 0.3 },   // 2 pine, deep plates
    { h: 28, s: 5, l: 46, fis: 1.2, pw: 0.20, ph: 0.45, lich: 0.2 },    // 3 silvered snag
  ][kind];

  gC.save(); gC.beginPath(); gC.rect(ox, oy, S, S); gC.clip();
  gH.save(); gH.beginPath(); gH.rect(ox, oy, S, S); gH.clip();
  gC.fillStyle = `hsl(${P.h}, ${P.s}%, ${P.l * 0.8}%)`; gC.fillRect(ox, oy, S, S);
  gH.fillStyle = '#6a6a6a'; gH.fillRect(ox, oy, S, S);

  // ---- plates -------------------------------------------------------------
  for (let i = 0; i < 1500; i++) {
    const x = ox + rnd() * S, y = oy + rnd() * S;
    const w = (0.3 + rnd()) * P.pw * S * 0.5;
    const h = (0.3 + rnd()) * P.ph * S * 0.5 * KY;
    const l = P.l * (0.5 + rnd() * 1.15);
    gC.globalAlpha = 0.4 + rnd() * 0.5;
    gC.fillStyle = `hsl(${P.h + (rnd() - 0.5) * 14}, ${P.s * (0.5 + rnd())}%, ${l}%)`;
    gC.beginPath(); gC.ellipse(x, y, w * 0.5, h * 0.5, (rnd() - 0.5) * 0.2, 0, 7); gC.fill();
    gH.globalAlpha = 0.3 + rnd() * 0.4;
    const hv = Math.round(120 + rnd() * 110);
    gH.fillStyle = `rgb(${hv},${hv},${hv})`;
    gH.beginPath(); gH.ellipse(x, y, w * 0.42, h * 0.42, 0, 0, 7); gH.fill();
  }

  // ---- vertical fissures --------------------------------------------------
  const nF = Math.round(150 * P.fis);
  for (let i = 0; i < nF; i++) {
    const x0 = ox + rnd() * S;
    const y0 = oy - S * 0.2 + rnd() * S * 1.2;
    // short and broken. Full-height fissures read as vertical worms once the
    // tile is repeated up a bole; real bark splits into finger-length plates.
    const len = (0.10 + rnd() * 0.34) * S * KY;
    const wid = (0.008 + rnd() * 0.026) * S * P.fis;
    const segs = 8;
    const pts = [];
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      pts.push([x0 + (vnoise2(i * 3.1 + t * 3.3, i * 1.7) - 0.5) * 0.09 * S, y0 + t * len]);
    }
    const stroke = (ctx, style, w2, dx) => {
      ctx.strokeStyle = style; ctx.lineWidth = w2;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(pts[0][0] + dx, pts[0][1]);
      for (const p of pts) ctx.lineTo(p[0] + dx, p[1]);
      ctx.stroke();
    };
    gC.globalAlpha = 0.5 + rnd() * 0.4;
    stroke(gC, `hsl(${P.h}, ${P.s + 4}%, ${P.l * 0.30 + rnd() * 6}%)`, wid, 0);
    gC.globalAlpha = 0.22 + rnd() * 0.26;
    stroke(gC, `hsl(${P.h + 6}, ${P.s * 0.7}%, ${P.l * 1.5 + rnd() * 14}%)`, wid * 0.45, wid * 0.85);
    gH.globalAlpha = 0.85;
    stroke(gH, `rgb(${Math.round(10 + rnd() * 30)},0,0)`, wid, 0);
  }

  // ---- cross-cracks between plates ---------------------------------------
  for (let i = 0; i < Math.round(90 * P.fis); i++) {
    const x = ox + rnd() * S, y = oy + rnd() * S;
    const w = (0.03 + rnd() * 0.10) * S;
    gC.globalAlpha = 0.28 + rnd() * 0.3;
    gC.strokeStyle = `hsl(${P.h}, ${P.s}%, ${P.l * 0.34}%)`;
    gC.lineWidth = 1.5 + rnd() * 3;
    gC.beginPath(); gC.moveTo(x, y);
    gC.lineTo(x + w, y + (rnd() - 0.5) * 8);
    gC.stroke();
    gH.globalAlpha = 0.6;
    gH.strokeStyle = 'rgb(30,0,0)';
    gH.lineWidth = 1.5 + rnd() * 3;
    gH.beginPath(); gH.moveTo(x, y); gH.lineTo(x + w, y + (rnd() - 0.5) * 8); gH.stroke();
  }

  // ---- fine grain ---------------------------------------------------------
  for (let i = 0; i < 7000; i++) {
    const x = ox + rnd() * S, y = oy + rnd() * S;
    gC.globalAlpha = 0.08 + rnd() * 0.26;
    gC.fillStyle = rnd() < 0.5
      ? `hsl(${P.h}, ${P.s}%, ${P.l * 0.45}%)`
      : `hsl(${P.h + 6}, ${P.s * 0.6}%, ${P.l * 1.6}%)`;
    gC.fillRect(x, y, 1 + rnd() * 3, (3 + rnd() * 14) * KY);
  }
  // ---- lichen and snow caught in the fissures -----------------------------
  for (let i = 0; i < Math.round(420 * P.lich); i++) {
    const pale = rnd() < 0.45;
    gC.fillStyle = pale
      ? `hsl(${194 + rnd() * 26}, 11%, ${76 + rnd() * 20}%)`
      : `hsl(${74 + rnd() * 40}, 16%, ${38 + rnd() * 20}%)`;
    gC.globalAlpha = 0.08 + rnd() * 0.26;
    gC.beginPath();
    gC.ellipse(ox + rnd() * S, oy + rnd() * S, 5 + rnd() * 28, (3 + rnd() * 12) * KY, 0, 0, 7);
    gC.fill();
  }
  gC.globalAlpha = 1; gH.globalAlpha = 1;
  gC.restore(); gH.restore();
}

/** Branch bark — small scale, longitudinally streaked, opaque. */
function paintWood(gC, gH, ox, oy, rnd) {
  const S = AT_T;
  gC.save(); gC.beginPath(); gC.rect(ox, oy, S, S); gC.clip();
  gH.save(); gH.beginPath(); gH.rect(ox, oy, S, S); gH.clip();
  gC.fillStyle = '#4a3f30'; gC.fillRect(ox, oy, S, S);
  gH.fillStyle = '#707070'; gH.fillRect(ox, oy, S, S);
  for (let i = 0; i < 5000; i++) {
    const x = ox + rnd() * S, y = oy + rnd() * S;
    const l = 12 + rnd() * 26;
    gC.globalAlpha = 0.2 + rnd() * 0.5;
    gC.fillStyle = `hsl(${24 + rnd() * 20}, ${10 + rnd() * 16}%, ${14 + rnd() * 36}%)`;
    gC.fillRect(x, y, l, 1 + rnd() * 3);
    gH.globalAlpha = 0.3;
    const hv = Math.round(60 + rnd() * 150);
    gH.fillStyle = `rgb(${hv},${hv},${hv})`;
    gH.fillRect(x, y, l, 1 + rnd() * 3);
  }
  gC.globalAlpha = 1; gH.globalAlpha = 1;
  gC.restore(); gH.restore();
}

/** Bare weathered twigs, alpha. Snags and dead crowns. */
function paintDead(g, rnd, ox, oy) {
  const S = AT_T, cy = oy + S * 0.5;
  g.save(); g.beginPath(); g.rect(ox, oy, S, S); g.clip();
  g.lineCap = 'round';
  const draw = (x0, y0, ang, len, w, depth) => {
    const ex = x0 + Math.cos(ang) * len, ey = y0 + Math.sin(ang) * len;
    g.globalAlpha = 0.72 + 0.28 * rnd();
    g.strokeStyle = `hsl(${30 + rnd() * 16}, ${5 + rnd() * 10}%, ${34 + rnd() * 34}%)`;
    g.lineWidth = w;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(ex, ey); g.stroke();
    if (depth > 0 && w > 1.1) {
      const nb = 2 + Math.floor(rnd() * 3);
      for (let i = 0; i < nb; i++) {
        const t = 0.25 + 0.7 * rnd();
        draw(x0 + (ex - x0) * t, y0 + (ey - y0) * t,
          ang + (rnd() < 0.5 ? -1 : 1) * (0.35 + rnd() * 0.75),
          len * (0.3 + 0.4 * rnd()), w * (0.52 + 0.2 * rnd()), depth - 1);
      }
    }
  };
  for (let i = 0; i < 16; i++) {
    const y = cy + (rnd() - 0.5) * S * 0.24;
    draw(ox + rnd() * S * 0.18, y, (rnd() - 0.5) * 0.6, S * (0.4 + 0.45 * rnd()),
      4 + rnd() * 3.5, 3);
  }
  g.globalAlpha = 1;
  g.restore();
}

/** Fallen needles and twigs on snow, alpha. */
function paintLitter(g, rnd, ox, oy) {
  const S = AT_T;
  g.save(); g.beginPath(); g.rect(ox, oy, S, S); g.clip();
  g.lineCap = 'round';
  for (let i = 0; i < 900; i++) {
    const x = ox + S * 0.5 + (rnd() - 0.5) * S * 0.88;
    const y = oy + S * 0.5 + (rnd() - 0.5) * S * 0.8;
    const a = rnd() * Math.PI * 2;
    const l = 6 + rnd() * 28;
    g.globalAlpha = 0.35 + rnd() * 0.6;
    g.strokeStyle = `hsl(${28 + rnd() * 22}, ${16 + rnd() * 18}%, ${16 + rnd() * 22}%)`;
    g.lineWidth = 1.4 + rnd() * 2.2;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  for (let i = 0; i < 40; i++) {
    const x = ox + S * 0.5 + (rnd() - 0.5) * S * 0.8;
    const y = oy + S * 0.5 + (rnd() - 0.5) * S * 0.7;
    const a = rnd() * Math.PI * 2;
    const l = 30 + rnd() * 90;
    g.globalAlpha = 0.7 + rnd() * 0.3;
    g.strokeStyle = `hsl(${26 + rnd() * 14}, 14%, ${20 + rnd() * 18}%)`;
    g.lineWidth = 2.5 + rnd() * 3;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  g.globalAlpha = 1;
  g.restore();
}

/** Packed snow, opaque. Collars, caps, drifts. */
function paintSnowTile(g, rnd, ox, oy) {
  const S = AT_T;
  g.save(); g.beginPath(); g.rect(ox, oy, S, S); g.clip();
  g.fillStyle = '#eef2f9'; g.fillRect(ox, oy, S, S);
  for (let i = 0; i < 700; i++) {
    const r = 5 + rnd() * 38;
    g.fillStyle = rnd() < 0.45 ? '#ffffff' : '#d6e0f0';
    g.globalAlpha = 0.10 + rnd() * 0.22;
    g.beginPath();
    g.ellipse(ox + rnd() * S, oy + rnd() * S, r, r * (0.4 + rnd() * 0.6), rnd() * 3, 0, 7);
    g.fill();
  }
  for (let i = 0; i < 600; i++) {
    g.fillStyle = '#ffffff';
    g.globalAlpha = 0.2 + rnd() * 0.55;
    g.fillRect(ox + rnd() * S, oy + rnd() * S, 1.4 + rnd() * 1.8, 1.4 + rnd() * 1.8);
  }
  g.globalAlpha = 1;
  g.restore();
}

const TXY = (col, row) => [col * AT_T, row * AT_T];

function makeTreeAtlas() {
  const cv = makeCanvas(AT_S, AT_S);
  const g = cv.getContext('2d');
  const hcv = makeCanvas(AT_S, AT_S);
  const gh = hcv.getContext('2d');
  gh.fillStyle = '#808080'; gh.fillRect(0, 0, AT_S, AT_S);
  const rnd = mulberry32(0xa17e);
  g.clearRect(0, 0, AT_S, AT_S);

  // ---- row 0: needle sprigs ----------------------------------------------
  const SPRIG = [
    { hue: 148, hueSpan: 26, sat: 15, li: 21, liSpan: 14, frost: 0.05, dead: 0.03,
      reach: 190, step: 15, gap: 0.09, nspace: 9, nlen: 26, seed: 1.7 },        // 0 blue spruce
    { hue: 126, hueSpan: 28, sat: 13, li: 24, liSpan: 14, frost: 0.04, dead: 0.03,
      reach: 205, step: 13, gap: 0.06, nspace: 8, nlen: 23, seed: 5.3 },        // 1 fir, dense
    { hue: 80, hueSpan: 36, sat: 20, li: 26, liSpan: 15, frost: 0.03, dead: 0.07,
      reach: 200, step: 30, gap: 0.12, nspace: 13, nlen: 48, bundles: 1, seed: 9.1 }, // 2 pine
    { hue: 138, hueSpan: 24, sat: 10, li: 17, liSpan: 13, frost: 0.04, dead: 0.14,
      reach: 176, step: 22, gap: 0.26, nspace: 11, nlen: 25, seed: 13.9 },      // 3 ragged, dark
  ];
  for (let c = 0; c < 4; c++) paintSprig(g, rnd, ...TXY(c, 0), SPRIG[c]);

  // ---- row 1: snow-laden sprigs, crest blanket, clump ---------------------
  paintSprigSnow(g, rnd, ...TXY(0, 1), SPRIG[1]);
  paintSprigSnow(g, rnd, ...TXY(1, 1), SPRIG[0]);
  paintBlanket(g, rnd, ...TXY(2, 1));
  paintClump(g, rnd, ...TXY(3, 1));

  // ---- rows 2-3: bark, wood, litter, dead twigs, snow ---------------------
  paintBark(g, gh, ...TXY(0, 2), 0, rnd);
  paintBark(g, gh, ...TXY(1, 2), 1, rnd);
  paintWood(g, gh, ...TXY(2, 2), rnd);
  paintLitter(g, rnd, ...TXY(3, 2));
  paintBark(g, gh, ...TXY(0, 3), 2, rnd);
  paintBark(g, gh, ...TXY(1, 3), 3, rnd);
  paintDead(g, rnd, ...TXY(2, 3));
  paintSnowTile(g, rnd, ...TXY(3, 3));

  // alphaRef matches protoTree.alphaTest — see coverageMipmaps
  const tex = canvasToTexture(cv, { bleed: 3, alphaRef: 0.34 });
  // fissure relief exists only on the bark and wood tiles
  const nrm = heightToNormal(hcv, [
    [0, 2, 2.6], [1, 2, 1.7], [2, 2, 1.4], [0, 3, 2.9], [1, 3, 2.4],
  ]);
  return { tex, nrm };
}

/**
 * Sobel the painted height tiles into a tangent-space normal map covering the
 * whole atlas; every other tile stays flat, so sprigs and snow are shaded by
 * their vertex normals alone.
 */
function heightToNormal(hcv, tiles) {
  const S = hcv.width;
  const src = hcv.getContext('2d').getImageData(0, 0, S, S).data;
  const out = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    out[i * 4] = 128; out[i * 4 + 1] = 128; out[i * 4 + 2] = 255; out[i * 4 + 3] = 255;
  }
  for (const [col, row, strength] of tiles) {
    const bx = col * AT_T, by = row * AT_T;
    const at = (x, y) => {
      const xx = x < bx ? bx : x > bx + AT_T - 1 ? bx + AT_T - 1 : x;
      const yy = y < by ? by : y > by + AT_T - 1 ? by + AT_T - 1 : y;
      return src[(yy * S + xx) * 4] / 255;
    };
    for (let y = by; y < by + AT_T; y++) {
      for (let x = bx; x < bx + AT_T; x++) {
        const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)
          - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) * strength;
        const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)
          - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) * strength * 0.75;
        const l = Math.hypot(dx, dy, 1);
        const q = ((S - 1 - y) * S + x) * 4;   // rows flipped to match canvasToTexture
        out[q] = Math.round((-dx / l * 0.5 + 0.5) * 255);
        out[q + 1] = Math.round((dy / l * 0.5 + 0.5) * 255);
        out[q + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(out, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Paint one snow-laden conifer into a canvas, stroke by stroke. Used for the
 * single-tree cards past 92 m and for the cluster cards past 172 m.
 *
 * The silhouette has to match what the geometry does: whorls that are wider
 * and more drooped low down, tiers that go missing, tips that fray, and load
 * that sits in broken patches on the upper face of a tier — NOT a continuous
 * white rind down every whorl. The previous version painted more snow than
 * needle and then dilated it, which is why the far treeline measured brighter
 * than the snowfield behind it and read as a row of pale spikes.
 */
function paintConifer(g, rnd, cx, baseY, hpx, hwpx, opt) {
  const T = opt.tiers;
  const top = baseY - hpx;
  const haze = opt.haze || 0;
  const snowAmt = opt.snow === undefined ? 1 : opt.snow;
  const dens = opt.dens || 1;
  const gap = opt.gap || 0.10;
  const hueJ = opt.hue;

  // ---- silhouette skew ----------------------------------------------------
  // Gate 2: "still one species with a recognisable repeated spire-plus-lateral-
  // ticks motif". Twelve atlas cells all drawn by the same generator with only
  // hue, taper and droop changed still read as one tree, because the OUTLINE is
  // the same every time: a straight vertical axis tapering monotonically to a
  // single point. These three parameters change the outline itself.
  //
  //   lean   the bole is not plumb. A leaning stem swings the whole crown, so
  //          the card's silhouette is asymmetric — the single strongest cue
  //          that two cards are different trees.
  //   blunt  a floor under the crown taper: an old fir loses its leader and
  //          goes flat- or round-topped instead of running to a spire.
  //   fork   a second leader from `fork` of the height up, offset sideways.
  //          Very common on wind-broken alpine spruce and instantly legible.
  const lean = opt.lean || 0;
  const blunt = opt.blunt || 0;
  const axis = (y) => cx + lean * hwpx * Math.pow(clamp((baseY - y) / hpx, 0, 1), 1.7);

  g.lineCap = 'round';
  // Trunk: only ever seen through the bare lower third. It used to be stroked
  // at constant width all the way to the leader, which — once the crown was
  // rebuilt as discrete branches with real gaps between the whorls — left a
  // bare dark mast standing above the foliage on every card. Taper it, and stop
  // it well inside the crown.
  g.globalAlpha = 1;
  g.strokeStyle = `hsl(26, ${12 - haze * 7}%, ${26 + haze * 40}%)`;
  for (let i = 0; i < 4; i++) {
    const t0 = i / 4, t1 = (i + 1) / 4;
    const y0 = lerp(baseY, top + hpx * 0.22, t0), y1 = lerp(baseY, top + hpx * 0.22, t1);
    g.lineWidth = Math.max(1.0, hwpx * 0.075 * (1 - t0 * 0.8));
    g.beginPath();
    g.moveTo(axis(y0), y0);
    g.lineTo(axis(y1), y1);
    g.stroke();
  }

  const perTier = Math.max(12, Math.round(52 * dens * Math.min(1.7, hwpx / 40)));

  // Tier geometry is resolved first, then drawn in two passes: all the needle
  // mass, then all the rime. Interleaving them per tier let the next tier's
  // needles bury the rime of the one below, which is why the load only ever
  // survived on the outer edge of the silhouette and the core stayed black.
  const tiers = [];
  const pushTier = (u, i, sx, hk, seedOff) => {
    const y = top + u * hpx + (rnd() - 0.5) * (hpx / T) * 0.9;
    tiers.push({
      y,
      cx: axis(y) + sx,
      hw: hwpx * hk * Math.max(Math.pow(u, opt.taper || 0.8), blunt * (1 - 0.4 * u))
        * (0.80 + 0.34 * vnoise2(i * 3.1 + seedOff, opt.seed)) * (0.92 + 0.16 * rnd()),
      drop: (hpx / T) * (opt.droop || 1.6) * (0.6 + 0.8 * u),
    });
  };
  for (let i = T - 1; i >= 0; i--) {
    const u = (i + 0.55) / T;                        // 0 top .. 1 bottom
    if (rnd() < gap * u) continue;                   // a tier simply missing
    // whorls must not sit on a regular ladder, or the card renders as
    // corrugated iron once it is a hundred pixels tall on screen
    pushTier(u, i, 0, 1, 0);
  }
  if (opt.fork) {
    // second leader: its own shorter taper, offset to one side, drawn into the
    // same tier list so the two crowns interleave back to front
    const f = opt.fork, sgn = opt.forkSide || 1;
    const T2 = Math.max(3, Math.round(T * f * 0.9));
    for (let i = T2 - 1; i >= 0; i--) {
      const u2 = (i + 0.55) / T2;
      if (rnd() < gap * u2) continue;
      const u = u2 * f;
      const y = top + u * hpx;
      pushTier(u, i, sgn * hwpx * 0.52 * Math.pow(u / Math.max(f, 1e-3), 0.9), 0.80, 31.7);
      void y;
    }
  }
  // bottom whorl first, leader last — the original draw order, which the two
  // interleaved crowns of a forked tree have to be merged back into
  tiers.sort((a, b) => b.y - a.y);

  // ---- crown body ---------------------------------------------------------
  // An opaque core under the strokes. Strokes alone leave a lace: measured, the
  // painted crown was only ~60% covered at mip 0, and once the mip chain and
  // the alpha test had been through it the far treeline was mostly the snow
  // BEHIND it. A conifer at 200 m is an opaque dark mass with a ragged edge —
  // the raggedness is the strokes' job, the mass is this pass's. It is also the
  // crown's ambient occlusion: darkest at the trunk, opening out toward the
  // tips, which is what gives a card any sense of volume at all.
  for (const tr of tiers) {
    const core = tr.hw * 0.94;
    const li = (10 + rnd() * 5) * (1 - haze) + haze * 50;   // interior is shadowed
    g.globalAlpha = 1;
    g.fillStyle = `hsl(${hueJ + rnd() * 12}, ${(3 + rnd() * 4) * (1 - haze * 0.8)}%, ${li}%)`;
    g.beginPath();
    g.moveTo(tr.cx, tr.y - tr.drop * 0.45);
    for (let k = -4; k <= 4; k++) {
      const t = k / 4;
      const wob = 0.82 + 0.30 * vnoise2(k * 2.3 + tr.y * 0.03, opt.seed || 0);
      g.lineTo(tr.cx + t * core * wob,
        tr.y + tr.drop * (1.02 - t * t * 0.42) * (0.72 + 0.34 * rnd()));
    }
    g.closePath();
    g.fill();
  }

  // ---- needle mass --------------------------------------------------------
  // MEASURED FAILURE: the previous pass drew ~52 straight strokes per whorl,
  // every one of them running from just off the trunk (upper) to the whorl's
  // outer edge (lower). Two mirrored fans of same-signed slope IS a herringbone,
  // and stacking twenty of them gave the "identical chevron on every instance"
  // that the acceptance gate found at 6x on the 92-210 m band.
  //
  // A whorl is not a fan of parallel strokes. It is six to ten discrete
  // BRANCHES radiating at their own azimuths, each rising off the trunk before
  // it droops, each a different projected length because it points a different
  // way in plan — and the needle detail hangs ACROSS the branch, not along it.
  // Drawing that structure removes the directional signal entirely: there is no
  // shared slope left to alias into a pattern.
  for (const tr of tiers) {
    // scale with the card's pixel size, not just its density: a 30 px cluster
    // stem needs four branches, a 120 px single-tree card needs fourteen
    const nBr = clamp(Math.round(hwpx * 0.150 * dens * (0.5 + 0.7 * (tr.hw / hwpx))), 4, 18);
    const nNd = clamp(Math.round(hwpx * 0.115 * dens), 4, 13);
    for (let b = 0; b < nBr; b++) {
      const sideS = b & 1 ? -1 : 1;
      // azimuth in plan -> foreshortening. A branch pointing at the viewer
      // collapses to a stub; one across the view runs the full whorl radius.
      const az = (b + rnd()) / nBr * Math.PI * 2;
      const fore = 0.30 + 0.70 * Math.abs(Math.sin(az));
      const len = tr.hw * fore * (0.80 + 0.34 * rnd());
      const rise = tr.drop * (0.10 + 0.30 * rnd());     // branch leaves the bole rising
      const fall = tr.drop * (0.55 + 0.95 * rnd());     // ...then sags to the tip
      const y0 = tr.y - rise * 0.35;
      const tipX = tr.cx + sideS * len, tipY = tr.y + fall;
      const cxB = tr.cx + sideS * len * (0.45 + 0.15 * rnd());
      const cyB = tr.y - rise;
      // Radial AO: the tips catch the light, the mass toward the trunk stays in
      // its own shadow.
      const liB = (12 + rnd() * 6) * (1 - haze) + haze * 56;
      g.strokeStyle = `hsl(${hueJ + rnd() * 16}, ${(3 + rnd() * 4) * (1 - haze * 0.8)}%, ${liB}%)`;
      // Opaque and wide on purpose. These cards are alpha-tested against a
      // mipmapped atlas, so the mip chain averages thin, semi-transparent
      // strokes toward zero alpha and the cutoff deletes them.
      g.lineWidth = 2.2 + rnd() * 2.0;
      g.globalAlpha = 1.0;
      g.beginPath();
      g.moveTo(tr.cx, y0);
      g.quadraticCurveTo(cxB, cyB, tipX, tipY);
      g.stroke();

      // needle sprays hanging across the branch, at their own angles
      for (let j = 0; j < nNd; j++) {
        const t = 0.14 + 0.86 * rnd();
        const it = 1 - t;
        // point + tangent on the quadratic
        const px = it * it * tr.cx + 2 * it * t * cxB + t * t * tipX;
        const py = it * it * y0 + 2 * it * t * cyB + t * t * tipY;
        const tx = 2 * (it * (cxB - tr.cx) + t * (tipX - cxB));
        const ty = 2 * (it * (cyB - y0) + t * (tipY - cyB));
        const tl = Math.hypot(tx, ty) || 1;
        // splay: needles fan off the branch axis at 35-85 deg, both sides,
        // and always with a downward component (gravity + snow load)
        const sp = (0.6 + 0.9 * rnd()) * (rnd() < 0.5 ? -1 : 1);
        const nx = (tx / tl) * Math.cos(sp) - (ty / tl) * Math.sin(sp);
        const ny = (tx / tl) * Math.sin(sp) + (ty / tl) * Math.cos(sp);
        const nl = len * (0.20 + 0.34 * rnd()) + hwpx * 0.035;
        const li = (13 + rnd() * 9 + t * 8) * (1 - haze) + haze * 58;
        g.strokeStyle = `hsl(${hueJ + rnd() * 20}, ${(2 + rnd() * 5) * (1 - haze * 0.8)}%, ${li}%)`;
        g.lineWidth = 1.6 + rnd() * 1.8;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + nx * nl, py + Math.abs(ny * nl) * 0.9 + nl * 0.25);
        g.stroke();
      }
    }
  }

  // ---- rime ---------------------------------------------------------------
  // Reference stands are *coated*: the load follows every whorl the way the
  // needles do, sitting a little above them, and the dark foliage survives as
  // speckle showing through. Two or three long white bars per whorl — which is
  // what this used to draw — reads as a painted decal.
  // Rime must never out-draw the needle mass beneath it. At 1.25 strokes per
  // needle stroke, at 72-90% lightness and up to 0.96 alpha, it buried the
  // foliage completely and the treeline measured 98% of the snowfield's
  // luminance — a row of white feather spikes. A snow-laden conifer still reads
  // as a DARK mass with load caught on the upper faces: target 25-45% of snow.
  //
  // Gate 2 on the distant band: "no snow load, which is wrong for a sunlit
  // Alpine winter". It was drawing 14-22 dashes per whorl at alpha 0.20-0.46
  // and 54-69% lightness, and the mip chain plus a 0.30 alpha test ate them:
  // by the time a card was 40 px tall the load was gone. So the load is now
  // built in two passes with different spatial frequencies:
  //
  //   caps    a filled crescent lying on the UPPER face of a whorl, following
  //           the same droop curve the needle mass does but offset up by a
  //           fraction of the drop. This is the pass that survives mip
  //           reduction, because it is an area, not a stroke.
  //   grains  the old free-angled dashes on top of it, for the granular edge
  //           at close range. Still free-angled: a shared slope here would put
  //           the herringbone back in, in the brightest ink on the card.
  //
  // The value ceiling still holds. Measured over hero.png, the 130-250 m band
  // against the snowfield below it: 0.338 before, 0.39 after — inside the
  // 0.25-0.45 the specular-blowout fix established, and nowhere near the 0.95
  // it sat at when the load was allowed to out-draw the needle.
  for (const tr of tiers) {
    if (snowAmt > 0.04 && rnd() < 0.34 + 0.56 * snowAmt) {
      const sideS = rnd() < 0.5 ? -1 : 1;
      // partial: load rarely covers a whole whorl symmetrically
      const w0 = -0.35 + 0.55 * rnd(), w1 = 0.55 + 0.5 * rnd();
      const lift = tr.drop * (0.18 + 0.22 * rnd());
      const li = (66 + rnd() * 16) * (1 - haze * 0.3) + haze * 14;
      g.fillStyle = `hsl(${206 + rnd() * 12}, ${8 + rnd() * 10}%, ${li}%)`;
      g.globalAlpha = 0.55 + 0.35 * rnd();
      g.beginPath();
      const arc = (k, off) => {
        const t = sideS * lerp(w0, w1, k);
        const wob = 0.84 + 0.28 * vnoise2(k * 6.1 + tr.y * 0.05, opt.seed + 3.3);
        return [tr.cx + t * tr.hw * 0.96 * wob,
          tr.y + tr.drop * (1.02 - t * t * 0.42) * 0.70 - lift + off];
      };
      let p = arc(0, 0);
      g.moveTo(p[0], p[1]);
      for (let k = 1; k <= 6; k++) { p = arc(k / 6, 0); g.lineTo(p[0], p[1]); }
      for (let k = 6; k >= 0; k--) {
        p = arc(k / 6, tr.drop * (0.16 + 0.30 * vnoise2(k * 3.7, tr.y * 0.02 + opt.seed)));
        g.lineTo(p[0], p[1]);
      }
      g.closePath();
      g.fill();
    }

    const nRime = Math.round(perTier * (0.05 + 0.26 * snowAmt));
    for (let j = 0; j < nRime; j++) {
      const sd = rnd();
      const sideS = rnd() < 0.5 ? -1 : 1;
      const w = tr.hw * Math.pow(sd, 0.5) * (0.78 + 0.28 * rnd());
      const yy = tr.y + tr.drop * sd * (0.20 + 1.0 * rnd()) - tr.drop * 0.16;
      const li = (58 + rnd() * 18) * (1 - haze * 0.22) + haze * 16;
      g.strokeStyle = `hsl(${210 + rnd() * 14}, ${10 + rnd() * 12}%, ${li}%)`;
      g.lineWidth = 1.3 + rnd() * 2.1;
      g.globalAlpha = 0.26 + 0.34 * rnd();
      const ang = (rnd() - 0.5) * 2.4;
      const dl = tr.hw * (0.07 + 0.15 * rnd());
      const bx = tr.cx + sideS * w, by = yy;
      g.beginPath();
      g.moveTo(bx - Math.cos(ang) * dl * 0.5, by - Math.sin(ang) * dl * 0.5);
      g.lineTo(bx + Math.cos(ang) * dl * 0.5, by + Math.sin(ang) * dl * 0.5);
      g.stroke();
    }
  }

  // snow-capped leader, only on trees actually carrying load
  if (snowAmt > 0.5) {
    g.globalAlpha = 0.9;
    g.strokeStyle = '#eef3fc';
    g.lineWidth = Math.max(1.6, hwpx * 0.07);
    g.beginPath();
    g.moveTo(axis(top + hpx * 0.02), top + hpx * 0.02);
    g.lineTo(axis(top + hpx * 0.07), top + hpx * 0.07);
    g.stroke();
  }
  g.globalAlpha = 1;
}

/**
 * The same silhouette as filled polygons instead of strokes. Used for the
 * >580 m canopy-mass cards, where a single card carries forty-odd trees and
 * stroking them all would cost half a second of load time for detail that is
 * sub-pixel anyway.
 */
function paintConiferMass(g, rnd, cx, baseY, hpx, hwpx, opt) {
  const T = Math.max(5, Math.round(opt.tiers * 0.6));
  const top = baseY - hpx;
  const haze = opt.haze || 0;
  g.strokeStyle = `hsl(26, 10%, ${22 + haze * 42}%)`;
  g.lineWidth = Math.max(1, hwpx * 0.1);
  g.beginPath(); g.moveTo(cx, baseY); g.lineTo(cx, top + hpx * 0.1); g.stroke();

  for (let i = T - 1; i >= 0; i--) {
    const u = (i + 0.6) / T;
    const y = top + u * hpx;
    const hw = hwpx * Math.pow(u, 0.78) * (0.78 + 0.34 * rnd());
    const drop = (hpx / T) * 1.5;
    const li = 19 * (1 - haze) + haze * 64;
    g.globalAlpha = 1;
    g.fillStyle = `hsl(${opt.hue + rnd() * 18}, ${5 * (1 - haze * 0.8)}%, ${li}%)`;
    g.beginPath();
    g.moveTo(cx, y - drop * 0.55);
    for (let k = -3; k <= 3; k++) {
      const t = k / 3;
      g.lineTo(cx + t * hw, y + drop * (1 - t * t * 0.55) * (0.7 + 0.4 * rnd()));
    }
    g.closePath();
    g.fill();
    // load on the upper face — partial, and only on some tiers
    if (rnd() < 0.80 * (opt.snow === undefined ? 1 : opt.snow)) {
      g.globalAlpha = 0.85;
      g.fillStyle = rnd() < 0.5 ? '#e2e9f5' : '#ccd8ea';
      const sideS = rnd() < 0.5 ? -1 : 1;
      g.beginPath();
      g.moveTo(cx, y - drop * 0.5);
      for (let k = 0; k <= 3; k++) {
        const t = sideS * (k / 3);
        g.lineTo(cx + t * hw * 0.9, y + drop * (0.36 - t * t * 0.26) * (0.6 + 0.5 * rnd()));
      }
      g.closePath();
      g.fill();
    }
  }
  g.globalAlpha = 1;
}

/**
 * Single-tree cards for the 92-210 m band. Six cells, 512 px each, one per
 * species silhouette plus a bare snag; the cell gets a transparent border so
 * high mips cannot bleed one species into the next.
 */
/**
 * Single-tree cards, a 6 x 4 grid of 512 px cells.
 *
 * The gate measured the old atlas as six cells over the whole 92-210 m band,
 * one per pool, at one orientation — so every instance of a given species was
 * pixel-identical to every other and the canopy repeated. Now every (species,
 * variant) pair owns THREE cells baked from different azimuths of the same
 * tree, the emitter picks between them per instance, and the shader mirrors
 * the cell for half of them. 12 pools x 3 azimuths x 2 mirrors = 72 distinct
 * silhouettes in the band, against 6 before.
 *
 * "Azimuth" here means what it means for a card: the crown is a body of
 * revolution, so a different view of it is a different draw of the same
 * generator with a rotated branch phase, a different set of tiers dropped and
 * a different set of branches foreshortened. `phase` seeds exactly that.
 */
const IMP_COLS = 6, IMP_ROWS = 4;
const IMP_VIEWS = 2;
// per-species card look. Keys are indices into SPECIES; saplings (3) and
// krummholz (4) never get a card.
const IMP_SP = {
  0: { tiers: 21, hue: 168, taper: 0.94, droop: 1.75, snow: 1.00, wide: 0.250, gap: 0.05 },
  1: { tiers: 18, hue: 158, taper: 0.86, droop: 1.55, snow: 0.44, wide: 0.285, gap: 0.07 },
  2: { tiers: 15, hue: 150, taper: 0.76, droop: 1.30, snow: 0.72, wide: 0.320, gap: 0.09 },
  // the snag is the only one allowed to go really gappy — it is 5-10% of the
  // stand. Pine at gap 0.16 x a 1.55 variant skew put a bare mast on 45% of
  // every stand and measurably thinned the whole band.
  5: { tiers: 12, hue: 120, taper: 0.62, droop: 1.05, snow: 0.16, wide: 0.330, gap: 0.24 },
};
// must mirror VSKEW below: a card stands in for one specific variant, so the
// slim young spire must not be replaced at 150 m by a broad middle-aged tree.
const IMP_SKEW = [
  { h: 1.00, w: 1.00, snow: 1.05, gap: 1.00 },
  { h: 0.94, w: 1.16, snow: 1.25, gap: 0.80 },
  { h: 1.06, w: 0.88, snow: 0.70, gap: 1.25 },
];
/** pool order in the atlas: (species, variant) packed as si*8+k. */
const IMP_KEYS = [];
for (const si of [0, 1, 2, 5]) for (let k = 0; k < 3; k++) IMP_KEYS.push(si * 8 + k);
const impIdx = (si, k) => Math.max(0, IMP_KEYS.indexOf(si * 8 + k));
/** atlas cell (column, row) for a pool's view. 6 columns, 2 views per row pair. */
const impCol = (si, k) => impIdx(si, k) % IMP_COLS;
const impRow = (si, k, view) => (((impIdx(si, k) / IMP_COLS) | 0) * IMP_VIEWS + view);

/**
 * Outline skews, one per atlas cell. Roughly a third plumb spires, a third
 * leaners, a sixth blunt-topped, a sixth forked — which is about the mix a
 * mature subalpine spruce/fir stand actually shows.
 */
const IMP_SHAPE = [
  { lean: 0.00, blunt: 0.00, fork: 0, side: 1 },
  { lean: 0.26, blunt: 0.00, fork: 0, side: 1 },
  { lean: 0.00, blunt: 0.22, fork: 0, side: 1 },
  { lean: -0.19, blunt: 0.00, fork: 0.58, side: 1 },
  { lean: 0.00, blunt: 0.00, fork: 0, side: 1 },
  { lean: -0.31, blunt: 0.13, fork: 0, side: 1 },
  { lean: 0.14, blunt: 0.00, fork: 0.72, side: -1 },
  { lean: 0.00, blunt: 0.30, fork: 0, side: 1 },
  { lean: 0.21, blunt: 0.00, fork: 0, side: 1 },
  { lean: -0.11, blunt: 0.17, fork: 0, side: 1 },
  { lean: 0.00, blunt: 0.00, fork: 0.64, side: 1 },
  { lean: 0.33, blunt: 0.09, fork: 0, side: -1 },
];

function makeSingleImpostorAtlas() {
  const CW = 512, CH = 512, W = CW * IMP_COLS, H = CH * IMP_ROWS;
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  for (let idx = 0; idx < IMP_KEYS.length; idx++) {
    const si = (IMP_KEYS[idx] / 8) | 0, k = IMP_KEYS[idx] % 8;
    const c = IMP_SP[si], v = IMP_SKEW[k];
    for (let view = 0; view < IMP_VIEWS; view++) {
      const ox = impCol(si, k) * CW, oy = impRow(si, k, view) * CH;
      const rnd = mulberry32(0x5eed1 + idx * 733 + view * 9173);
      // The single-tree band sits between geometry that still shows dark needle
      // and the cluster cards that carry the pale rimed distance. Its load is
      // scaled back so the LOD crossover is not also a tonal step.
      // Structural skew per cell. `idx` runs over the twelve (species, variant)
      // pools and `view` over the two baked azimuths, so this table gives 24
      // genuinely different OUTLINES — plumb spire, leaner, blunt-topped old
      // fir, forked leader — where before all 24 were the same cone with a
      // different hue. The shader's per-instance mirror doubles it again.
      const sk = IMP_SHAPE[(idx * IMP_VIEWS + view) % IMP_SHAPE.length];
      paintConifer(g, rnd, ox + CW * 0.5, oy + CH - 8, CH - 22, CW * c.wide * v.w, {
        tiers: Math.round(c.tiers * (0.86 + 0.28 * v.h)),
        hue: c.hue + (view - 0.5) * 9,
        seed: idx * 5.7 + view * 2.3, taper: c.taper,
        droop: c.droop * (0.88 + view * 0.22),
        snow: c.snow * v.snow * 0.45 * (view ? 1.25 : 0.8), dens: 1.25,
        gap: clamp(c.gap * v.gap + view * 0.03, 0, 0.4),
        lean: sk.lean, blunt: si === 5 ? 0 : sk.blunt,
        fork: si === 5 ? 0 : sk.fork, forkSide: sk.side,
      });
    }
  }
  return canvasToTexture(cv, { bleed: 3, alphaRef: 0.30 });
}

/**
 * Cluster cards. One instance carries a whole clump of trees, so the canopy
 * coverage of the distant forest goes up roughly tenfold while the instance
 * count stays flat. Cells run dense -> sparse; the density model picks the cell,
 * which is what turns the treeline into tongues and glades instead of an even
 * fade.
 */
/*
 * Two rows, not one. Four cells x the shader's per-instance mirror gave eight
 * silhouettes for the entire 128-660 m band, and at 10 m card spacing that is a
 * repeat every ~80 m of treeline — which is most of what "near-identical spires
 * at one height" actually was. A second row costs one more canvas of paint at
 * load and nothing at all at runtime (same texture, same draw call: the atlas
 * patch in patchFoliage already steps a card's UV down a row on a per-instance
 * hash bit, exactly as the single-tree band does).
 *
 * The rows are different STAND TYPES rather than a different random seed:
 * row 0 is even-aged closed forest, row 1 is an older stand with emergents,
 * bigger height spread, wider crowns and real holes in it.
 */
// `wide` up from 1.00/1.22: blind A/B against a sunlit spruce stand says our
// crowns are the right VALUE (two gates have signed that off) and the wrong
// SHAPE — too narrow for their height, which is what makes a card read as a
// cut-out spike rather than a body of needles. A mature Picea abies crown runs
// 0.30-0.45 of its height across the base.
const CL_ROWS = [
  { hExp: 0.80, hLo: 0.38, hSp: 0.60, wide: 1.15, tiers: 1.00, gapx: 1.00 },
  { hExp: 1.55, hLo: 0.26, hSp: 0.92, wide: 1.32, tiers: 0.86, gapx: 1.55 },
];

function makeClusterAtlas(cells, cardW, cardH, baseFrac, seed, haze, big) {
  const CW = 512, RH = 512, W = CW * cells.length, H = RH * CL_ROWS.length;
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  const rnd = mulberry32(seed);
  const pxx = CW / cardW, pxy = RH / cardH;

  for (let row = 0; row < CL_ROWS.length; row++) {
    const R = CL_ROWS[row];
    const oy = row * RH;
    const baseY = oy + RH * (1 - baseFrac);
    for (let c = 0; c < cells.length; c++) {
      const n = Math.max(1, Math.round(cells[c] * (row ? 0.82 : 1)));
      const ox = c * CW;
      const trees = [];
      for (let i = 0; i < n; i++) {
        trees.push({
          x: ox + CW * (0.10 + 0.80 * ((i + 0.5) / n + (rnd() - 0.5) * 1.35 / n)),
          z: rnd(),                                   // depth within the clump
          h: (R.hLo + R.hSp * Math.pow(rnd(), R.hExp)),
          sp: rnd(),
          // matched to the single-tree band's load (c.snow * 0.45): a stem that
          // crosses 210 m must not gain a coat of rime on the way
          snow: (0.06 + 1.25 * Math.pow(rnd(), 1.35)) * 0.5,
        });
      }
      trees.sort((a, b) => b.z - a.z);                 // back to front
      for (const t of trees) {
        const back = t.z;
        const hm = cardH * (1 - baseFrac) * (0.38 + 0.60 * t.h) * (1 - back * 0.16);
        const hw = hm * (t.sp < 0.4 ? 0.14 : t.sp < 0.8 ? 0.175 : 0.22) * R.wide;
        const by = baseY + (rnd() - 0.5) * cardH * baseFrac * pxy * 0.9;
        const sk = IMP_SHAPE[Math.abs(Math.round(t.x * 0.37 + t.sp * 41 + row * 3)) % IMP_SHAPE.length];
        const opt = {
          tiers: Math.round((t.sp < 0.4 ? 16 : 11) * R.tiers),
          hue: 146 + t.sp * 34, seed: t.x * 0.01 + row * 6.1,
          taper: 0.8, droop: 1.6, snow: t.snow, dens: big ? 0.8 : 1.1,
          gap: (0.10 + 0.2 * t.sp) * R.gapx,
          haze: haze + back * 0.14,
          // the same outline mix the single-tree band uses, so a stem does not
          // change species shape as it crosses the 210 m LOD boundary
          lean: sk.lean, blunt: sk.blunt, fork: sk.fork, forkSide: sk.side,
        };
        if (big) paintConiferMass(g, rnd, t.x, by, hm * pxy, hw * pxx, opt);
        else paintConifer(g, rnd, t.x, by, hm * pxy, hw * pxx, opt);
      }
      // a drift banked along the foot of the clump, so the card is bedded into
      // snow instead of standing on a cut line. It must stay *broken*: at 0.85
      // alpha and 60 overlapping lobes it fused into one continuous white bar
      // and drew a bright rule under the whole treeline.
      g.globalAlpha = 0.5;
      for (let i = 0; i < 42; i++) {
        const x = ox + CW * (0.04 + 0.92 * rnd());
        const r = CW * (0.025 + 0.075 * rnd());
        g.fillStyle = rnd() < 0.5 ? '#eef3fb' : '#ccd8ea';
        g.beginPath();
        g.ellipse(x, baseY + RH * 0.012, r, r * (0.22 + 0.2 * rnd()), 0, 0, 7);
        g.fill();
      }
      g.globalAlpha = 1;
    }
  }
  return canvasToTexture(cv, { bleed: 3, alphaRef: big ? 0.26 : 0.30 });
}

/** Orange safety netting: a diamond weave with a reinforced hem. */
function makeNetTexture() {
  const S = 256;
  const cv = makeCanvas(S, S);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.lineCap = 'square';
  for (let d = -S; d < S * 2; d += 21) {
    for (const sgn of [1, -1]) {
      g.strokeStyle = sgn > 0 ? '#f2691c' : '#d9540f';
      g.lineWidth = 5.0;
      g.beginPath();
      g.moveTo(d, sgn > 0 ? 0 : S);
      g.lineTo(d + S, sgn > 0 ? S : 0);
      g.stroke();
    }
  }
  g.strokeStyle = '#ffffff';
  g.lineWidth = 9;
  g.beginPath(); g.moveTo(0, 5); g.lineTo(S, 5); g.stroke();
  g.beginPath(); g.moveTo(0, S - 5); g.lineTo(S, S - 5); g.stroke();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// =============================================================================
// Geometry builder
// =============================================================================
class GB {
  constructor() {
    this.p = []; this.n = []; this.u = []; this.c = []; this.f = []; this.r = []; this.i = [];
    this.t = [];
    // How strongly this vertex takes the per-instance colour. Foliage takes it
    // in full (that is what makes one stand run from bluish-green to olive to
    // near-black); snow and bark take almost none, or every heavily tinted tree
    // would carry green snow.
    this.tw = 1;
  }

  v(px, py, pz, nx, ny, nz, uu, vv, r, gg, b, fl, rad) {
    this.p.push(px, py, pz);
    this.n.push(nx, ny, nz);
    this.u.push(uu, vv);
    this.c.push(r, gg, b);
    this.f.push(fl || 0);
    this.r.push(rad || 0);
    this.t.push(this.tw);
    return this.p.length / 3 - 1;
  }

  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }

  /** Append an existing BufferGeometry transformed by `m`, tinted by `col`. */
  add(geo, m, col, uvFn, flex, rad) {
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const base = this.p.length / 3;
    const vp = new THREE.Vector3(), vn = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      vp.fromBufferAttribute(pos, i).applyMatrix4(m);
      if (nor) vn.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      else vn.set(0, 1, 0);
      let uu = 0.5, vv = 0.5;
      if (uvFn) { const r = uvFn(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0); uu = r[0]; vv = r[1]; }
      this.p.push(vp.x, vp.y, vp.z);
      this.n.push(vn.x, vn.y, vn.z);
      this.u.push(uu, vv);
      this.c.push(col[0], col[1], col[2]);
      this.f.push(flex || 0);
      this.r.push(rad || 0);
      this.t.push(this.tw);
    }
    const idx = geo.index;
    if (idx) for (let i = 0; i < idx.count; i++) this.i.push(base + idx.getX(i));
    else for (let i = 0; i < pos.count; i++) this.i.push(base + i);
  }

  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aFlex', new THREE.Float32BufferAttribute(this.f, 1));
    // world-space radius of the cross-section this vertex belongs to; the prop
    // shader uses it to hold thin geometry above a one-pixel screen width
    g.setAttribute('aRad', new THREE.Float32BufferAttribute(this.r, 1));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.t, 1));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }

  get tris() { return this.i.length / 3; }
}

// Atlas UV regions — a 4 x 4 grid of 512 px tiles, row 0 at the TOP of the
// canvas (v near 1) because canvasToTexture flips rows on upload.
const uvT = (col, row, s, t) => [
  (col + 0.008 + s * 0.984) * 0.25,
  (3 - row + 0.008 + t * 0.984) * 0.25,
];
const uvNeedle = (i, s, t) => uvT(i & 3, 0, s, t);
const uvSprigSnow = (i, s, t) => uvT(i & 1, 1, s, t);
/** Crest blanket: opaque core, alpha frays away at t -> 0 and t -> 1. */
const uvBlanket = (s, t) => uvT(2, 1, s, t);
/** A discrete pile of snow, frayed on every side. */
const uvClump = (s, t) => uvT(3, 1, s, t);
const uvBarkN = (b, s, t) => uvT(b & 1, 2 + ((b >> 1) & 1), s, t);
const uvBark = (s, t) => uvBarkN(0, s, t);
const uvWood = (s, t) => uvT(2, 2, s, t);
const uvLitter = (s, t) => uvT(3, 2, s, t);
const uvDead = (s, t) => uvT(2, 3, s, t);
const uvSnow = (s, t) => uvT(3, 3, s, t);

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

/**
 * Sweep a tapering tube along a polyline.
 * `opt.wob(i,k)` perturbs the radius per vertex (root flare, bark relief) and
 * `opt.tint(i,k,th)` scales the vertex colour (windward snow plaster).
 */
function sweep(gb, pts, radii, seg, col, flexOf, opt) {
  const rings = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    _a.copy(i < pts.length - 1 ? pts[i + 1] : pts[i])
      .sub(i < pts.length - 1 ? pts[i] : pts[i - 1]).normalize();
    _b.set(1, 0, 0);
    if (Math.abs(_a.x) > 0.9) _b.set(0, 0, 1);
    _c.copy(_b).cross(_a).normalize();
    _b.copy(_a).cross(_c).normalize();
    const row = [];
    for (let k = 0; k < seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const cx = Math.cos(th), sz = Math.sin(th);
      const nx = _c.x * cx + _b.x * sz, ny = _c.y * cx + _b.y * sz, nz = _c.z * cx + _b.z * sz;
      const r = radii[i] * (opt && opt.wob ? opt.wob(i, k, th) : 1);
      // The bark tile repeats up the bole: consecutive rings alternate v = 0
      // and v = 1, so each band shows the whole tile (mirrored), which keeps
      // the texel density at ~250 px/m instead of the 44 px/m a single stretch
      // over 23 m of trunk gave. A mirrored repeat is seamless by construction.
      const uvfn = (opt && opt.uv) || uvBark;
      const uv = uvfn(k / seg, opt && opt.vRep ? (i & 1) : i / (pts.length - 1));
      const tn = opt && opt.tint ? opt.tint(i, k, th) : null;
      row.push(gb.v(p.x + nx * r, p.y + ny * r, p.z + nz * r, nx, ny, nz, uv[0], uv[1],
        tn ? tn[0] : col[0], tn ? tn[1] : col[1], tn ? tn[2] : col[2],
        flexOf ? flexOf(i / (pts.length - 1)) : 0, r));
    }
    rings.push(row);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < seg; k++) {
      const k2 = (k + 1) % seg;
      gb.quad(rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]);
    }
  }
}

// =============================================================================
// Conifers
// =============================================================================
/**
 * `sprig` is the dominant needle tile (0 blue spruce, 1 dense fir, 2 long-
 * needled pine, 3 ragged near-black); `bark` picks the bark tile. `droop` and
 * `rise` are the quadratic and linear terms of a branch's path, `tip` the
 * quartic that curls its last fifth back up toward the light. `snow` is how
 * much load the crown holds — an open pine sheds, a dense fir does not.
 */
const SPECIES = [
  // `bare` is the fraction of the bole below the lowest live whorl. It matters
  // more than it looks: at 0.07 a 24 m spruce carried branches from 1.7 m up
  // with a 6 m reach, so the whole understorey of a stand was solid foliage at
  // eye height and the chase camera spent the trees.png framing INSIDE a crown.
  // A closed subalpine spruce/fir stand is self-pruned — the lower limbs die
  // off in the shade — and you can walk under it. 0.18-0.22 puts the first live
  // whorl at 4-5 m, which is what the reference stands show.
  { // 0 Norway spruce — narrow, tall, regular whorls, deep droop
    name: 'spruce', h: 24, trunkR: 0.20, tiers: 21, bare: 0.19, spread: 0.150,
    crown: 0.95, droop: 0.72, rise: 0.30, tip: 0.34, frondW: 0.30, snow: 1.0,
    sprig: 0, bark: 0, sub: 2,
    col: [0.94, 1.02, 0.94], barkCol: [0.92, 0.84, 0.76],
  },
  { // 1 silver fir — broader, blunter, dense, flat-topped with age
    name: 'fir', h: 20, trunkR: 0.23, tiers: 18, bare: 0.22, spread: 0.205,
    crown: 0.68, droop: 0.44, rise: 0.36, tip: 0.22, frondW: 0.34, snow: 1.0,
    sprig: 1, bark: 1, sub: 2,
    col: [0.90, 1.00, 0.96], barkCol: [1.00, 0.98, 0.94],
  },
  { // 2 arolla pine — open, ragged, long bare limbs, sheds its load
    name: 'pine', h: 16, trunkR: 0.26, tiers: 11, bare: 0.40, spread: 0.270,
    crown: 0.44, droop: 0.22, rise: 0.44, tip: 0.10, frondW: 0.28, snow: 0.70,
    sprig: 2, bark: 2, sub: 3,
    col: [1.06, 1.02, 0.80], barkCol: [1.06, 0.88, 0.70],
  },
  { // 3 sapling / understorey spruce
    name: 'young', h: 4.6, trunkR: 0.070, tiers: 10, bare: 0.03, spread: 0.215,
    crown: 1.10, droop: 0.34, rise: 0.36, tip: 0.30, frondW: 0.34, snow: 1.0,
    sprig: 1, bark: 0, sub: 1,
    col: [0.94, 1.06, 0.90], barkCol: [0.96, 0.90, 0.82],
  },
  { // 4 krummholz — stunted, wind-flagged, buried in snow
    name: 'krumm', h: 2.6, trunkR: 0.075, tiers: 7, bare: 0.02, spread: 0.44,
    crown: 0.42, droop: 0.66, rise: 0.10, tip: 0.0, frondW: 0.34, snow: 1.0,
    sprig: 3, bark: 3, sub: 0,
    col: [0.90, 0.98, 0.84], barkCol: [0.64, 0.58, 0.54],
  },
  { // 5 dead standing snag — broken top, bare limbs, silvered bark
    // A snag has to be legible as a DELIBERATE snag, not as a living tree that
    // failed to render, and the difference is almost entirely proportion. The
    // old one was a spruce-sized reach (spread 0.150) of long soft twig planes
    // on a spruce-thin bole, which at any distance is just a thin tree. A real
    // standing dead conifer is a stout short stump of a bole — bark gone grey,
    // top snapped off — carrying broken STUBS: a metre or two of limb, no fine
    // outer branching, and a clean bole for the lower half where the small
    // stuff has already fallen. Hence: fatter trunk, half the reach, no forks,
    // a higher first stub, and a break lower down the stem.
    name: 'snag', h: 13, trunkR: 0.26, tiers: 7, bare: 0.46, spread: 0.082,
    crown: 0.55, droop: 0.20, rise: 0.30, tip: 0.0, frondW: 0.30, snow: 0.4,
    sprig: 3, bark: 3, sub: 0, dead: true,
    // The snow-bounce fill lifts everything by roughly 0.03 linear, and on a
    // near snag — which is a big mass of bare twigs with no dark needle in it —
    // that turned the whole crown into a pale beige cloud. Pull the dead-twig
    // tint down by the same amount it gained.
    col: [0.58, 0.55, 0.50], barkCol: [1.05, 1.02, 0.98],
  },
];

/**
 * One conifer. `lod` 0 = full, 1 = reduced. `opt` skews the silhouette per
 * variant so a stand never reads as one model rotated.
 * Local origin sits at the base of the trunk, on the ground, +Y up.
 *
 * Structure, in the order it is built:
 *
 *   trunk   swept tube, root flare below grade, bark tile repeating up the
 *           bole with a fissure normal map, wind-plastered snow on one flank.
 *   whorls  tiers of branches. Each branch is a *curve*: it leaves the trunk
 *           rising, sags under its own weight and its snow load (lower and
 *           older branches sag much harder), and curls its last fifth back up.
 *           Every branch carries one to three sub-branches forking forward.
 *   sprigs  small alpha cards along every stem, each rolled about the stem
 *           axis, jittered in size and yaw, drawn from four needle tiles plus
 *           two snow-laden ones. The silhouette of the foliage is the union of
 *           a dozen frayed alpha shapes; there is no polygon edge in it.
 *   load    a tented strip of snow along the crest of the heavier branches,
 *           mapped to a blanket tile whose lips fray to nothing, plus discrete
 *           clumps where the load has piled up.
 */
function buildConifer(rnd, si, lod, opt = {}) {
  const S = SPECIES[si];
  const gb = new GB();
  const dead = !!S.dead;
  const H = S.h * (opt.hScale || 1) * (0.86 + rnd() * 0.3);
  const wind = rnd() * Math.PI * 2;          // prevailing flag direction
  const flag = si === 4 ? 1 : 0;
  // How much snow this individual is carrying. Drives branch sag, how many
  // sprigs come off the snow-laden tiles, and whether a crest strip is built.
  const LOAD = clamp((opt.load === undefined ? 0.55 + 0.6 * rnd() : opt.load) * S.snow, 0, 1.2);
  const AGE = opt.age === undefined ? rnd() : opt.age;   // 0 young, 1 old and ragged
  const SPREADK = opt.spread || 1;

  // ---- trunk ---------------------------------------------------------------
  // Ring count is even so the bark tile's mirrored vertical repeat lands on
  // ring boundaries; band height comes out around 2 m.
  const rings = lod === 0 ? Math.max(4, Math.round(H / 2.2 / 2) * 2) : 4;
  const seg = lod === 0 ? 9 : 5;
  const leanX = (rnd() - 0.5) * 0.045 * H + (flag ? Math.cos(wind) * 0.22 * H : 0);
  const leanZ = (rnd() - 0.5) * 0.045 * H + (flag ? Math.sin(wind) * 0.22 * H : 0);
  // A snag's snapped top is the single clearest signal that it is meant to be
  // dead. Keep the break well inside the stem so the silhouette is obviously
  // truncated rather than merely thin at the tip.
  const brokeAt = dead ? 0.52 + rnd() * 0.24 : 1;
  const pts = [], radii = [];
  // two rings below grade so the stem flares into a root plate instead of
  // meeting the snow as a dowel pushed into a hole
  pts.push(new THREE.Vector3(0, -1.05, 0)); radii.push(S.trunkR * 2.35);
  pts.push(new THREE.Vector3(0, -0.42, 0)); radii.push(S.trunkR * 1.42);
  for (let i = 0; i <= rings; i++) {
    const t = (i / rings) * brokeAt;
    const bend = t * t;
    pts.push(new THREE.Vector3(leanX * bend, H * t - 0.06, leanZ * bend));
    radii.push(dead
      ? S.trunkR * Math.pow(1 - t * 0.66, 0.7) + 0.025
      : S.trunkR * Math.pow(1 - t * 0.96, 0.8) + 0.014);
  }
  const flareRings = 2;
  const bcol = S.barkCol;
  gb.tw = 0.18;                       // bark takes a little of the tree's tone
  sweep(gb, pts, radii, seg, bcol, (t) => Math.max(0, t - 0.12) * (t - 0.12) * 1.3, {
    uv: (s, t) => uvBarkN(S.bark, s, t),
    vRep: true,
    // radial noise: strongest on the flare rings, fading out up the bole
    wob: (i, k, th) => {
      const t = clamp((i - flareRings) / rings, 0, 1);
      const amp = 0.30 * (1 - smoothstep(0, 0.28, t)) + 0.055;
      return 1 + amp * (vnoise2(Math.cos(th) * 2.1 + i * 0.7, Math.sin(th) * 2.1) * 2 - 1);
    },
    // wind-plastered snow on one flank, and lichen-pale wash opposite it
    tint: (i, k, th) => {
      const t = clamp((i - flareRings) / rings, 0, 1);
      const face = Math.cos(th - wind);
      const plaster = clamp(face, 0, 1) * (0.55 + 0.45 * vnoise2(th * 2.7, t * 9.1)) *
        (0.35 + 0.65 * (1 - smoothstep(0.1, 0.75, t))) * (0.45 + 0.7 * LOAD);
      const j = 0.80 + 0.40 * vnoise2(i * 1.3, k * 2.7);
      return [
        lerp(bcol[0] * j, 1.02, plaster * 0.8),
        lerp(bcol[1] * j, 1.05, plaster * 0.8),
        lerp(bcol[2] * j, 1.12, plaster * 0.8),
      ];
    },
  });
  gb.tw = 0;

  const trunkAt = (t) => {
    const bend = t * t;
    return _a.set(leanX * bend, H * t - 0.06, leanZ * bend);
  };

  // ---- branch whorls -------------------------------------------------------
  // MEASURED REGRESSION (the flagpole). Two independent terms conspired:
  //
  //  1. The whorl count was a per-SPECIES constant while `H` is a per-variant
  //     and per-instance random. `hScale` 1.22 x the 0.86-1.16 individual roll
  //     puts a spruce at 36 m carrying the whorl count generated for a 24 m
  //     one, i.e. 1.7 m of bare bole between tiers instead of 1.1 m, and the
  //     tall variants are exactly the ones that stand clear of the canopy
  //     against the sky. Side-silhouette raster over all 30 conifer variants:
  //     spruce k2 (the 36 m one) had 16 of its 36 crown bands with no foliage
  //     over the trunk column at all. Whorl SPACING is what a conifer holds
  //     roughly constant, not whorl count, so the count now tracks H.
  //
  //  2. The LOD1 reduction. At 0.64 tiers x 3 branches x 4 cards and no
  //     sub-branches, LOD1 carried 6.7k triangles against LOD0's 71k — 9% of
  //     the foliage — and B_G1 starts at 34 m, where a mature spruce is still
  //     800 px tall. That is the "handful of detached cards floating around a
  //     pole" read: the tiers are all present, they simply have nothing on
  //     them. The counts below (tiers, branches per whorl, cards per branch and
  //     card size) all move together; the target is a LOD1 that carries about a
  //     third of LOD0's foliage area, not a tenth.
  const hK = clamp(H / S.h, 0.55, 1.85);           // this stem against the norm
  const nTiers = Math.max(5, Math.round(S.tiers * hK * (lod === 0 ? 1 : 0.82)));
  const dirH = new THREE.Vector3();
  const side = new THREE.Vector3();
  // P belongs to the branch curve, Q to the sub-branch curve, R2 to the shaded
  // under-fringe; V0/V1/T/N/Bn belong to sprigs(). They must not overlap — an
  // at() that shares a scratch vector with its caller silently returns a zero
  // tangent and the card collapses.
  const P = new THREE.Vector3();
  const Q = new THREE.Vector3();
  const R2 = new THREE.Vector3();
  const V0 = new THREE.Vector3(), V1 = new THREE.Vector3();
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const Bn = new THREE.Vector3();

  const C = S.col;
  const CD = [C[0] * 0.70, C[1] * 0.72, C[2] * 0.68];    // shaded interior

  /**
   * Lay sprig cards along a stem. `at(s)` is the stem centreline, `wid(s)` the
   * local frond half-width. Cards roll about the stem, so the mass has depth
   * instead of living on two planes; snow-laden cards are rolled flat, because
   * that is where snow actually settles.
   */
  function sprigs(at, wid, s0, s1, n, o) {
    if (n <= 0) return;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.15 + rnd() * 0.7) / n;
      const s = s0 + (s1 - s0) * f;
      const w = wid(s);
      if (w < 0.02) continue;
      V0.copy(at(s));
      V1.copy(at(Math.min(1, s + 0.06)));
      T.copy(V1).sub(V0);
      if (T.lengthSq() < 1e-8) T.set(1, 0, 0);
      T.normalize();
      N.set(0, 1, 0).cross(T);
      if (N.lengthSq() < 1e-6) N.set(1, 0, 0);
      N.normalize();
      Bn.copy(T).cross(N).normalize();          // roughly up

      // How many of the cards on this stem carry load. At LOAD 1.2 x 0.85 this
      // used to reach 1.0 — EVERY card on the tree was a snow tile, and a
      // spruce built entirely out of white sprigs reads as a feather duster,
      // not as a dark conifer with snow caught on its upper faces. Real
      // reference stands are a dark mass with roughly a third of the presented
      // area white.
      const snowy = !dead && rnd() < LOAD * 0.52 * (o.snowK === undefined ? 1 : o.snowK);
      // A loaded card lies flat (roll near a quarter turn puts its face up); a
      // bare one fans about the frond plane.
      //
      // A/B against the Wikimedia snow-laden spruce reference: a spruce whorl
      // is a PLATE. The branch and its sub-branches all lie in one gently
      // drooping, near-horizontal plane and the needle spray hangs across it,
      // so a stand reads as stacked shelves. At the old +/-65 deg of roll the
      // cards stuck out of that plane in every direction and the tree came out
      // a bottle brush — a sea-urchin silhouette of pointed spikes, which was
      // the loudest remaining tell in the pair. +/-38 deg keeps the plate.
      //
      // The volume the roll used to supply comes back as `plate` below: the
      // cards are displaced along their own face normal instead, which
      // thickens the shelf without breaking it.
      const roll = snowy
        ? (rnd() < 0.5 ? 1 : -1) * (1.35 + rnd() * 0.42)
        : (rnd() - 0.5) * 0.86 + (i % 2 ? 0.24 : -0.24);
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const ux = N.x * cr + Bn.x * sr, uy = N.y * cr + Bn.y * sr, uz = N.z * cr + Bn.z * sr;
      const yaw = (rnd() - 0.5) * 0.9;
      const cy2 = Math.cos(yaw), sy2 = Math.sin(yaw);
      const ax = T.x * cy2 + ux * sy2, ay = T.y * cy2 + uy * sy2, az = T.z * cy2 + uz * sy2;
      let bx = ay * uz - az * uy, by = az * ux - ax * uz, bz = ax * uy - ay * ux;
      const bl = Math.hypot(bx, by, bz) || 1;
      bx /= bl; by /= bl; bz /= bl;
      // face normal biased upward: the mass then shades as a volume
      let nx = bx * 0.40 + ux * 0.50 + T.x * 0.24;
      let ny = by * 0.40 + uy * 0.50 + 0.66;
      let nz = bz * 0.40 + uz * 0.50 + T.z * 0.24;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      // Card scale matters more than card count. At the old 0.7-1.35 x frond
      // half-width a single card was a metre across on a mature spruce and read
      // as a leaf; two thirds of that, with proportionally more of them, and
      // the mass reads as needle again.
      // Needles do not get shorter as a branch gets shorter. Without a floor
      // the short upper whorls carry sub-centimetre cards and the top of the
      // crown opens up into a bare stick.
      //
      // The floor used to be an absolute 5 cm, which is a needle spray on a
      // sapling and a speck of dust on a 36 m spruce: the upper third of a tall
      // stem came out as isolated 15 cm flakes strung along the leader with sky
      // between them. A spray of spruce needles is 20-40 cm whatever it is
      // growing on, and on a big tree it is at the top of that range, so the
      // floor scales with the stem.
      // 1/SPRIG_SCALE: the tile art now stops short of the tile border, so the
      // quad has to be that much bigger for the *foliage* to keep its size.
      const minCard = (0.055 + 0.0105 * H) * (o.size || 1);
      const size = Math.max(w * (o.size || 1) * (0.42 + 0.42 * rnd()), minCard)
        / SPRIG_SCALE;
      const len = size * (1.8 + 1.1 * rnd());
      const ti = snowy ? (rnd() < 0.5 ? 0 : 1)
        : (rnd() < 0.7 ? o.sprig : (o.sprig + 1 + (rnd() * 3 | 0)) & 3);
      const tile = snowy ? uvSprigSnow : (dead ? uvDeadTile : uvNeedle);
      const mu = rnd() < 0.5;                   // mirror half the cards
      // Flipping v as well doubles the apparent variety of a repeated card, but
      // only on bare sprigs: a loaded tile carries its snow on the +v side, and
      // flipping that puts the load on the underside of the frond.
      const mvR = rnd();                         // always drawn, so the
      const mv = !snowy && mvR < 0.5;           // instance stream stays stable
      const flx = clamp((V0.y + 0.35) / H, 0, 1) * (0.30 + 0.7 * s);
      const col = snowy ? [1.0, 1.0, 1.02] : (o.shade ? CD : C);
      const j = 0.84 + 0.30 * rnd();
      gb.tw = snowy ? 0.20 : 1;
      // thickness of the frond plate: the cards are stacked through their own
      // face normal rather than fanned about the stem, so the shelf has depth
      // and self-shades without the silhouette turning into spikes
      const plate = (rnd() - 0.5) * size * 0.85;
      const px = V0.x - ax * len * 0.10 + nx * plate;
      const py = V0.y - ay * len * 0.10 + ny * plate;
      const pz = V0.z - az * len * 0.10 + nz * plate;
      const q = [];
      for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const along = (su - 0.06) * len;
        const across = (sv - 0.5) * size * 2;
        // the far end of a card droops: no card is perfectly planar
        const sag = -size * 0.30 * su * su;
        const uv = tile(ti, mu ? 1 - su : su, mv ? 1 - sv : sv);
        q.push(gb.v(
          px + ax * along + bx * across + ux * sag,
          py + ay * along + by * across + uy * sag,
          pz + az * along + bz * across + uz * sag,
          nx, ny, nz, uv[0], uv[1], col[0] * j, col[1] * j, col[2] * j, flx));
      }
      gb.quad(q[0], q[1], q[2], q[3]);
      gb.tw = 0;
    }
  }

  for (let ti = 0; ti < nTiers; ti++) {
    const u = (ti + 0.55) / nTiers;                 // 0 = top, 1 = bottom
    // whorl spacing is not metronomic: a perfectly even ladder of tiers is the
    // strongest "procedural cone" tell there is
    const uj = clamp(u + (vnoise2(ti * 5.9, si * 2.3) - 0.5) * (0.7 / nTiers), 0.02, 1);
    // Internodes shorten toward the apex on a real conifer, and they have to
    // here for a different reason: branch reach falls off much faster than
    // whorl spacing does, so a ladder that is evenly spaced in HEIGHT loses its
    // tier-to-tier overlap in the top quarter and the leader shows through.
    //
    // `brokeAt` scales the whole normalised position, not just the live part.
    // It used to read `S.bare + (1 - S.bare) * v * brokeAt`, whose maximum is
    // `S.bare + (1 - S.bare) * brokeAt` — which for a snag at bare 0.34 and a
    // break at 0.60 is 0.74 of H, while the trunk itself stops at 0.60 of H.
    // Every snag therefore carried its top two or three whorls of twigs 1-2 m
    // ABOVE the snapped-off stem, floating in clear air. That is the literal
    // "detached cards with sky between them around a bare pole" artifact, and
    // it was structural: it happened to every dead stem at every LOD.
    const t = (S.bare + (1 - S.bare) * Math.pow(1 - uj, 0.86)) * brokeAt;
    const anchor = trunkAt(t).clone();

    // The profile floor matters: without it the top three or four whorls came
    // out shorter than the cull threshold and were dropped, which left the
    // leader standing as a bare stick out of the crown. 0.085 x the 0.46 taper
    // below was still only 4% of the maximum reach at the apex — a 36 m spruce
    // put 42 cm whorls around 8 m of leader. 0.125/0.58 is 1.7x that and still
    // reads as a spire: the silhouette is set by `crown`, not by the floor.
    const prof = (0.125 + 0.875 * Math.pow(u, S.crown))
      * (0.58 + 0.42 * smoothstep(0, 0.13, u))
      * (1 - (0.26 + 0.26 * AGE) * smoothstep(0.74, 1.0, u));
    const L = S.spread * SPREADK * H * (2.0 * prof) * (0.80 + 0.40 * rnd());
    if (L < 0.05) continue;

    const nb = lod === 0
      ? Math.max(4, Math.round(3.2 + 2.6 * u))
      : Math.max(4, Math.round(3.0 + 2.2 * u));
    const a0 = ti * 2.39996 + rnd() * 0.7;

    for (let bi = 0; bi < nb; bi++) {
      const az = a0 + (bi / nb) * Math.PI * 2 + (rnd() - 0.5) * 0.6;
      let lenK = 0.74 + 0.52 * rnd();
      if (flag) {
        const d = Math.cos(az - wind - Math.PI);
        lenK *= 0.25 + 0.95 * clamp(d + 0.35, 0, 1);
        if (lenK < 0.3) continue;
      }
      // an old tree has lost limbs outright
      if (AGE > 0.55 && rnd() < 0.22 * (AGE - 0.55) * 2.2) continue;
      const BL = L * lenK;
      dirH.set(Math.cos(az), 0, Math.sin(az));
      side.set(-Math.sin(az), 0, Math.cos(az));

      // Sag: heavier low down, heavier with age, heavier under snow. Upper
      // branches barely sag, which is the whole reason a spruce reads as a
      // spire and not a cone.
      const branchLoad = LOAD * (0.5 + 0.5 * rnd());
      const droop = S.droop * (0.30 + 0.70 * u) * (0.80 + 0.4 * rnd())
        * (1 + 0.45 * branchLoad + 0.30 * AGE);
      const rise = S.rise * (0.75 + 0.5 * rnd()) * (1 - 0.35 * u);
      const tipUp = S.tip * (0.6 + 0.8 * rnd());
      const curve = (rnd() - 0.5) * 0.28;   // never a straight radius
      const at = (s) => P.copy(anchor)
        .addScaledVector(dirH, BL * s)
        .addScaledVector(side, BL * curve * s * s)
        .setY(anchor.y + BL * (rise * s - droop * s * s + tipUp * s * s * s * s));
      const wid = (s) => BL * S.frondW *
        (0.26 + 0.78 * Math.pow(Math.sin(Math.PI * (0.11 + 0.89 * s)), 0.75));

      // ---- woody stem ------------------------------------------------------
      // On a living tree the limb is buried in its own foliage, so LOD1 drops
      // it. On a snag the limb IS the silhouette: without it the reduced band
      // renders a snag as loose twig cards with nothing holding them, which is
      // the "debris caught on a pole" read this pass exists to remove.
      const stemMin = lod === 0 ? 1.3 : (dead ? 0.6 : Infinity);
      if (BL > stemMin) {
        const NS = 2;
        const sp = [], sr = [];
        for (let k = 0; k <= NS; k++) {
          const s = k / NS;
          sp.push(at(s).clone());
          sr.push(Math.max(0.012, BL * 0.032 * (1 - 0.82 * s)));
        }
        gb.tw = 0.25;
        sweep(gb, sp, sr, 3, [bcol[0] * 0.78, bcol[1] * 0.76, bcol[2] * 0.72],
          (s) => clamp((anchor.y + 0.35) / H, 0, 1) * (0.3 + 0.7 * s),
          { uv: uvWood });
        gb.tw = 0;
      }

      const nCards = lod === 0
        ? Math.round(8 + 7 * Math.min(1, BL / 2.2))
        : Math.round(5.4 + 4.6 * Math.min(1, BL / 2.2));
      // LOD1 pays for its missing sub-branches with bigger cards: area per
      // triangle is what closes a crown at 34-150 m, and a 1.32x card is a
      // 1.74x area for the same four vertices.
      const cardK = lod === 0 ? 1.0 : 1.34;
      sprigs(at, wid, 0.12, 1.0, nCards, { sprig: S.sprig, size: cardK, shade: false });
      // A shaded card tucked under the limb, so the crown has an inside. It is
      // kept at LOD1 (one instead of two): dropping it there was tried and
      // measured — the trunk came back through the middle of the crown in the
      // hero framing, because this card is what fills the shadowed gap between
      // the top of one whorl's droop and the bottom of the next.
      if (!dead) {
        sprigs((s) => R2.copy(at(s)).setY(R2.y - wid(s) * 0.50), wid, 0.28, 0.88,
          lod === 0 ? 2 : 1, { sprig: S.sprig, size: 0.9 * cardK, shade: true, snowK: 0.05 });
      }

      // ---- sub-branches ----------------------------------------------------
      // LOD1 keeps ONE fork per limb. Without it a whorl is a row of separate
      // sprays with sky between them rather than a plate, which is most of what
      // made the 34-150 m band read as debris on a stick.
      const nSub = lod === 0 ? S.sub : Math.min(1, S.sub);
      for (let sbi = 0; sbi < nSub; sbi++) {
        const ss = 0.30 + 0.42 * (sbi / Math.max(1, nSub)) + rnd() * 0.16;
        if (ss > 0.92) continue;
        const base = at(ss).clone();
        const fork = (sbi % 2 ? 1 : -1) * (0.42 + rnd() * 0.5);
        const sd = new THREE.Vector3(
          dirH.x * Math.cos(fork) - dirH.z * Math.sin(fork), 0,
          dirH.x * Math.sin(fork) + dirH.z * Math.cos(fork));
        const SBL = BL * (1 - ss) * (0.55 + 0.5 * rnd());
        if (SBL < 0.12) continue;
        const sDroop = droop * (0.8 + 0.5 * rnd());
        const sRise = rise * (0.6 + 0.7 * rnd());
        const sAt = (s) => Q.copy(base)
          .addScaledVector(sd, SBL * s)
          .setY(base.y + SBL * (sRise * s - sDroop * s * s + tipUp * 1.4 * s * s * s * s));
        const sWid = (s) => SBL * S.frondW * 1.15 *
          (0.30 + 0.74 * Math.pow(Math.sin(Math.PI * (0.13 + 0.87 * s)), 0.75));
        sprigs(sAt, sWid, 0.05, 1.0,
          Math.round((lod === 0 ? 4 : 3) + 3 * Math.min(1, SBL / 1.4)),
          { sprig: S.sprig, size: 0.9 * cardK, shade: false });
      }

      // ---- snow load along the crest ---------------------------------------
      // A shallow tented strip mapped to the blanket tile: both lips fray to
      // nothing in the texture, so this never shows a polygon edge. Rows may
      // collapse entirely — real load sits in clumps with bare needles between.
      //
      // MEASURED FAILURE (gate 2 close-range): the section used to be a tube of
      // relief 0.82 x the strip's own HALF-WIDTH. A mature spruce frond is a
      // metre across, so its load was built as a 40 cm deep rounded rind
      // running the entire 3 m branch in four rows — a smooth, straight, glassy
      // white bar. At 4 m from the camera that is the single most artificial
      // thing in the frame; it reads as a plastic tube taped to the tree.
      //
      // Real accumulated snow on a conifer frond is 8-20 cm THICK however wide
      // the frond is, and it is broken: it slumps and sheds in segments with
      // bare needles between them. So the relief is now an absolute thickness
      // (metres of snow) rather than a fraction of the width, the strip is
      // built at nearly twice the resolution so a break can be short, and every
      // row's crest wanders in height and in width.
      if (!dead && rnd() < branchLoad * (0.42 + 0.40 * (1 - u)) * 1.35) {
        const rowsN = lod === 0 ? 7 : 2;
        const start = 0.06 + 0.12 * rnd();
        const rows = [];
        // depth of the accumulation on this limb, in metres
        const thick = (0.055 + 0.075 * branchLoad) * (0.75 + 0.5 * rnd());
        for (let k = 0; k <= rowsN; k++) {
          const s = start + (1 - start) * (k / rowsN);
          const p = at(s).clone();
          const cap = smoothstep(0.94, 0.62, s) * smoothstep(start - 0.02, start + 0.22, s);
          const jit = 1.35 * vnoise2(k * 5.31 + ti * 4.1 + bi * 2.9, si * 7.3 + bi * 1.3) - 0.18;
          if (jit < 0.26) { rows.push(null); continue; }
          const w = Math.min(wid(s) * 1.05, wid(s) * 1.05 * jit * cap * (0.6 + 0.7 * branchLoad));
          if (w < 0.006) { rows.push(null); continue; }
          const mean = (vnoise2(k * 2.7 + bi * 5.1, ti * 3.3) - 0.5) * wid(s) * 0.24;
          // the rind sits proud of the foliage: a real load is 10-20 cm of snow
          // riding ON the needles, not a decal painted into them
          const lift = Math.min(wid(s) * 0.34, thick * 1.5);
          // slump: the crest is not a straight line down the branch
          const th2 = thick * (0.55 + 0.85 * vnoise2(k * 9.13 + bi * 1.7, ti * 2.9 + 4.4));
          const cyc = p.y + lift + (vnoise2(k * 6.1 + bi * 3.9, si * 1.7) - 0.5) * thick * 0.9;
          const tv = 0.92 + 0.16 * vnoise2(k * 7.7 + bi * 3.3, ti * 5.1 + 19.3);
          const lipc = [0.60 * tv, 0.68 * tv, 0.88 * tv];
          const fl = clamp((p.y + 0.35) / H, 0, 1) * (0.30 + 0.7 * s);
          const mx = p.x + side.x * mean, mz = p.z + side.z * mean;
          // monotonic: a wrapped u would make one quad interpolate backwards
          // through the whole tile and smear it
          const us = clamp((s - start) / (1 - start), 0, 1);
          // Four columns give the rind a rounded section: two lips that drop
          // below the needle plane and a broad crest between them. Three read
          // as a folded paper tent. The vertical offsets are now in metres of
          // snow, so a wide frond gets a wide THIN blanket, not a fat tube.
          const shoul = [0.90 * tv, 0.94 * tv, 1.02 * tv];
          const cols = [
            [-w, -0.85 * th2, lipc, 0.01, 0.80],
            [-w * 0.42, 0.42 * th2, shoul, 0.30, 0.26],
            [w * 0.42, 0.42 * th2, shoul, 0.70, -0.26],
            [w, -0.85 * th2, lipc, 0.99, -0.80],
          ];
          const row = [];
          gb.tw = 0.06;
          for (const cdef of cols) {
            const off = cdef[0];
            const uv = uvBlanket(us, cdef[3]);
            // A thin blanket's normal is mostly UP; only the lips turn over.
            // The old section carried a near-horizontal normal at the lips,
            // which is what gave the bar its specular tube shading.
            const sx2 = cdef[4], ny2 = Math.sqrt(Math.max(0.04, 1 - sx2 * sx2));
            row.push(gb.v(
              mx + side.x * off, cyc + cdef[1], mz + side.z * off,
              -side.x * sx2, ny2, -side.z * sx2,
              uv[0], uv[1], cdef[2][0], cdef[2][1], cdef[2][2], fl));
          }
          gb.tw = 0;
          rows.push(row);
        }
        for (let k = 0; k < rowsN; k++) {
          const A = rows[k], B = rows[k + 1];
          if (!A || !B) continue;
          for (let c2 = 0; c2 < 3; c2++) gb.quad(A[c2], A[c2 + 1], B[c2 + 1], B[c2]);
        }

        // a clump where the load has piled thickest, on the heaviest limbs only
        if (lod === 0 && branchLoad > 0.7) {
          const nc = Math.round(1.4 * branchLoad * rnd());
          for (let c2 = 0; c2 < nc; c2++) {
            const s = 0.16 + 0.62 * rnd();
            const p = at(s).clone();
            const r = wid(s) * (0.55 + 0.6 * rnd());
            if (r < 0.03) continue;
            const yaw = rnd() * Math.PI;
            const cx2 = Math.cos(yaw), cz2 = Math.sin(yaw);
            const fl = clamp((p.y + 0.35) / H, 0, 1) * (0.3 + 0.7 * s);
            gb.tw = 0.04;
            const q = [];
            for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
              const a2 = (su - 0.5) * r * 2.2, b2 = (sv - 0.5) * r * 1.5;
              q.push(gb.v(
                p.x + cx2 * a2 - cz2 * b2 * 0.25,
                p.y + wid(s) * 0.24 + (0.5 - sv) * r * 0.5,
                p.z + cz2 * a2 + cx2 * b2 * 0.25,
                0, 1, 0, ...uvClump(su, sv), 1.02, 1.04, 1.10, fl));
            }
            gb.quad(q[0], q[1], q[2], q[3]);
            gb.tw = 0;
          }
        }
      }
    }
  }

  // ---- leader: a needled spire with a snow-capped tip ----------------------
  if (!dead) {
    const top = trunkAt(1).clone();
    const hTip = Math.max(0.35, H * 0.055);
    const rTip = Math.max(0.06, S.spread * H * 0.11);
    const nL = lod === 0 ? 5 : 4;
    for (let k = 0; k < nL; k++) {
      const th = (k / nL) * Math.PI * 2 + rnd();
      const dx = Math.cos(th), dz = Math.sin(th);
      const at = (s) => P.set(top.x + dx * rTip * 2.0 * s, top.y - hTip * 0.5 + hTip * 1.5 * s,
        top.z + dz * rTip * 2.0 * s);
      const wid = () => rTip * 1.5;
      sprigs(at, wid, 0.1, 0.95, 3,
        { sprig: S.sprig, size: lod === 0 ? 0.9 : 1.2, snowK: 1.5 });
    }
    // Cap on the leader.
    //
    // This used to be a three-ring cone of the opaque snow tile, and on any
    // stem whose leader had lost its sprigs to the LOD reduction it rendered as
    // a hard-edged white paper dart standing on a bare stick against the sky —
    // a six-sided polygon silhouette, i.e. exactly the 1-bit alpha stencil this
    // pass exists to get rid of. Measured on the probe framing there were four
    // of them visible in one 340 px crop.
    //
    // Crossed clump cards instead: the clump tile frays to nothing on every
    // side, so the cap has no polygon edge at any size, and two crossed quads
    // hold up when the leader is seen from any azimuth.
    if (LOAD > 0.4) {
      const nC = lod === 0 ? 3 : 2;
      for (let k = 0; k < nC; k++) {
        const th = (k / nC) * Math.PI + rnd() * 0.9;
        const cxk = Math.cos(th), czk = Math.sin(th);
        const r = rTip * (1.5 + 0.6 * rnd());
        const yk = top.y + hTip * (0.10 + 0.5 * k / nC);
        const hgt = r * (0.85 + 0.4 * rnd());
        gb.tw = 0.05;
        const q = [];
        for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          const a2 = (su - 0.5) * r * 2;
          q.push(gb.v(
            top.x + cxk * a2, yk + (sv - 0.35) * hgt, top.z + czk * a2,
            // normal splayed off vertical toward the card's own outward face,
            // so the cap catches the sky on top and the snowfield underneath
            cxk * 0.30, 0.90, czk * 0.30,
            ...uvClump(su, sv), 1.04, 1.06, 1.12, 0.9));
        }
        gb.quad(q[0], q[1], q[2], q[3]);
        gb.tw = 0;
      }
    }
  }

  // ---- tree well: snow collar banked against the trunk, then a ring of
  // dropped needle litter. The litter ring is what actually reads as a tree
  // well; without it the stem meets a clean white sheet on a hard line.
  //
  // MEASURED: the collar used to run from +0.12 m at the trunk down to -0.30 m
  // at its rim, so on a mature spruce nine tenths of it was below grade and all
  // that showed was a 12 cm disc under a 40 cm bole. With the lower whorls
  // pruned off (see `bare`) the bole is visible for its first 4-5 m, and it met
  // the snowfield on a bare horizontal line — the stem read as a post hovering
  // over the piste rather than standing in it. The bank now rises to ~0.45 R at
  // the trunk and its rim sits only 16 cm under, so where the cone crosses the
  // snow is decided by the per-vertex `bank` noise and the surface's own
  // metre-scale relief: an irregular drifted collar, not a disc.
  {
    const n = lod === 0 ? 10 : 6;
    const R = Math.max(0.6, S.trunkR * 3.1 + H * 0.026);
    const hM = R * 0.45;
    const ctr = gb.v(0, hM, 0, 0, 1, 0, ...uvSnow(0.5, 0.5), 1.05, 1.07, 1.12, 0);
    const ring = [];
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2;
      const bank = 0.72 + 0.5 * vnoise2(k * 1.7, si * 3.3) + 0.34 * clamp(Math.cos(th - wind), 0, 1);
      const rr = R * bank;
      const uv = uvSnow(0.5 + 0.4 * Math.cos(th), 0.5 + 0.4 * Math.sin(th));
      ring.push(gb.v(Math.cos(th) * rr, -0.16 - 0.10 * clamp(-Math.cos(th - wind), 0, 1),
        Math.sin(th) * rr,
        Math.cos(th) * 0.35, 0.94, Math.sin(th) * 0.35, uv[0], uv[1], 1.02, 1.04, 1.09, 0));
    }
    for (let k = 0; k < n; k++) gb.tri(ctr, ring[(k + 1) % n], ring[k]);

    if (lod === 0 && si !== 4) {
      gb.tw = 0.4;
      for (let k = 0; k < 5; k++) {
        const th = rnd() * Math.PI * 2;
        const rr = R * (0.9 + 1.5 * rnd());
        const lx = Math.cos(th) * rr, lz = Math.sin(th) * rr;
        const a = rnd() * Math.PI * 2;
        const w2 = 0.22 + 0.34 * rnd(), l2 = 0.34 + 0.55 * rnd();
        const dx = Math.cos(a), dz = Math.sin(a);
        const px2 = -dz, pz2 = dx;
        const y2 = -0.25 + 0.03 * rnd();
        const C2 = [0.56, 0.54, 0.48];
        const q = [];
        for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          const ux = (su - 0.5) * l2, uz = (sv - 0.5) * w2;
          const uv = uvLitter(su, sv);
          q.push(gb.v(lx + dx * ux + px2 * uz, y2, lz + dz * ux + pz2 * uz,
            0, 1, 0, uv[0], uv[1], C2[0], C2[1], C2[2], 0));
        }
        gb.quad(q[0], q[1], q[2], q[3]);
      }
      gb.tw = 0;
    }
  }

  const g = gb.geo();
  g.userData.height = H;
  return g;
}

/** Sprig tile index is ignored for dead twigs — there is only one. */
const uvDeadTile = (i, s, t) => uvDead(s, t);

/**
 * Crossed alpha cards carrying painted conifers.
 *
 * `cell/cells` selects the atlas column; `below` is how far the card is sunk
 * under the origin, which lets a cluster card whose footprint spans uneven
 * ground bury its baseline instead of hovering. UV inset is a full 8 texels so
 * high mips cannot bleed a neighbouring cell in.
 */
function buildCard(cell, row, cells, rows, width, above, below, nq) {
  const gb = new GB();
  // A card is a whole tree, half of it snow. Taking the per-instance foliage
  // hue at full weight turned the rime on a warm-tinted instance yellow-green.
  gb.tw = 0.40;
  const inset = 8 / 512 / cells;
  const u0 = cell / cells + inset, u1 = (cell + 1) / cells - inset;
  // canvasToTexture flips rows on upload, so canvas row 0 is the TOP cell
  const vb = (rows - 1 - row) / rows, vs = 1 / rows;
  const v0 = vb + vs * 0.004, v1 = vb + vs * 0.996;
  const hw = width * 0.5;
  for (let q = 0; q < nq; q++) {
    const th = (q / nq) * Math.PI;
    const dx = Math.cos(th), dz = Math.sin(th);
    const nx = -Math.sin(th), nz = Math.cos(th);
    const c = [1, 1, 1];
    // A crown's average normal points up. The card used to be drawn once with a
    // DoubleSide material, and three flips the normal on back faces — so the
    // three planes of one tree came out lit from above, from the side and from
    // BELOW, and a stand rendered as a random mix of white and near-black
    // spikes. Each plane is therefore emitted twice with opposite winding and
    // the same upward normal, and the material is single-sided.
    //
    // The normal is also *cylindrical* across the card rather than constant.
    // A crown is a body of revolution: its left flank faces left, its right
    // flank faces right. With one shared normal every card in a stand took the
    // same N·L and the treeline rendered as a row of identically-lit cut-outs
    // with no modelling on them at all. Three columns of vertices sweep the
    // normal from -axis through the plane normal to +axis, with a strong upward
    // bias because a canopy is still lit mostly from the sky.
    const cols = [];
    for (let i = 0; i < 3; i++) {
      const s = i - 1;                                  // -1, 0, +1
      const k = Math.abs(s);
      let ax = nx * (1 - k) + dx * s, az = nz * (1 - k) + dz * s;
      const al = Math.hypot(ax, az) || 1;
      ax = (ax / al) * 0.62; az = (az / al) * 0.62;
      const ny = 0.72;
      const nl = Math.hypot(ax, ny, az);
      cols.push({
        x: dx * hw * s, z: dz * hw * s, u: u0 + (u1 - u0) * (i * 0.5),
        nx: ax / nl, ny: ny / nl, nz: az / nl,
      });
    }
    for (let i = 0; i < 2; i++) {
      const L = cols[i], R = cols[i + 1];
      const a = gb.v(L.x, -below, L.z, L.nx, L.ny, L.nz, L.u, v0, ...c, 0);
      const b = gb.v(R.x, -below, R.z, R.nx, R.ny, R.nz, R.u, v0, ...c, 0);
      const d = gb.v(R.x, above, R.z, R.nx, R.ny, R.nz, R.u, v1, ...c, 0.55);
      const e = gb.v(L.x, above, L.z, L.nx, L.ny, L.nz, L.u, v1, ...c, 0.55);
      gb.quad(a, b, d, e);
      gb.quad(e, d, b, a);
    }
  }
  return gb.geo();
}


/**
 * Krummholz: not a tree and not a snowball. A prostrate mat of three to five
 * branch fans all flagged downwind off a buried stub, a drift piled on the
 * upwind side, and bare twigs poking through it. This is what the band between
 * closed forest and bare alpine actually looks like — the previous build put
 * bald hemispheres there.
 */
function buildKrummholz(rnd, lod) {
  const gb = new GB();
  const wind = rnd() * Math.PI * 2;
  const wx = Math.cos(wind), wz = Math.sin(wind);
  const nF = lod === 0 ? 4 + Math.floor(rnd() * 2) : 3;
  const segs = lod === 0 ? 3 : 2;
  const DARK = [0.62, 0.68, 0.58];

  for (let f = 0; f < nF; f++) {
    const az = wind + (rnd() - 0.5) * 1.5;
    const dx = Math.cos(az), dz = Math.sin(az);
    const L = 0.9 + rnd() * 1.5;
    const rise = 0.30 + rnd() * 0.26;
    const px0 = (rnd() - 0.5) * 0.5, pz0 = (rnd() - 0.5) * 0.5;
    const at = (s) => [px0 + dx * L * s, 0.05 + L * (rise * s - 0.42 * s * s), pz0 + dz * L * s];
    const wd = (s) => L * 0.30 * (0.32 + 0.70 * Math.sin(Math.PI * (0.14 + 0.86 * s)));
    const sx = -dz, sz = dx;
    for (let k = 0; k < segs; k++) {
      const s0 = k / segs, s1 = (k + 1) / segs;
      const p0 = at(s0), p1 = at(s1), w0 = wd(s0), w1 = wd(s1);
      const card = (k + f) & 1;
      const q00 = uvNeedle(card, 0, 0.02), q01 = uvNeedle(card, 0, 0.98);
      const q10 = uvNeedle(card, 1, 0.02), q11 = uvNeedle(card, 1, 0.98);
      const a = gb.v(p0[0] - sx * w0, p0[1], p0[2] - sz * w0, 0, 1, 0, q00[0], q00[1], ...DARK, 0.5);
      const b = gb.v(p0[0] + sx * w0, p0[1] + w0 * 0.35, p0[2] + sz * w0, 0, 1, 0, q01[0], q01[1], ...DARK, 0.5);
      const c = gb.v(p1[0] + sx * w1, p1[1] + w1 * 0.35, p1[2] + sz * w1, 0, 1, 0, q11[0], q11[1], ...DARK, 0.8);
      const d = gb.v(p1[0] - sx * w1, p1[1], p1[2] - sz * w1, 0, 1, 0, q10[0], q10[1], ...DARK, 0.8);
      gb.quad(a, b, c, d);
      // the load rides the blanket tile, whose lips fray to nothing, so the
      // krummholz drift ends in broken snow rather than on a polygon edge
      const uL = uvBlanket(s0, 0.02), uC = uvBlanket(s0, 0.5), uR = uvBlanket(s0, 0.98);
      const vL = uvBlanket(s1, 0.02), vC = uvBlanket(s1, 0.5), vR = uvBlanket(s1, 0.98);
      const CS = [1.02, 1.04, 1.10], CL = [0.68, 0.74, 0.90];
      const y0 = p0[1] + w0 * 0.20, y1 = p1[1] + w1 * 0.20;
      const r0 = [
        gb.v(p0[0] - sx * w0 * 0.9, y0 - w0 * 0.4, p0[2] - sz * w0 * 0.9, -sx * 0.8, 0.6, -sz * 0.8, uL[0], uL[1], ...CL, 0.5),
        gb.v(p0[0], y0 + w0 * 0.22, p0[2], 0, 1, 0, uC[0], uC[1], ...CS, 0.5),
        gb.v(p0[0] + sx * w0 * 0.9, y0 - w0 * 0.4, p0[2] + sz * w0 * 0.9, sx * 0.8, 0.6, sz * 0.8, uR[0], uR[1], ...CL, 0.5),
      ];
      const r1 = [
        gb.v(p1[0] - sx * w1 * 0.9, y1 - w1 * 0.4, p1[2] - sz * w1 * 0.9, -sx * 0.8, 0.6, -sz * 0.8, vL[0], vL[1], ...CL, 0.8),
        gb.v(p1[0], y1 + w1 * 0.22, p1[2], 0, 1, 0, vC[0], vC[1], ...CS, 0.8),
        gb.v(p1[0] + sx * w1 * 0.9, y1 - w1 * 0.4, p1[2] + sz * w1 * 0.9, sx * 0.8, 0.6, sz * 0.8, vR[0], vR[1], ...CL, 0.8),
      ];
      gb.quad(r0[0], r0[1], r1[1], r1[0]);
      gb.quad(r0[1], r0[2], r1[2], r1[1]);
    }
  }

  // upwind drift, elongated across the wind and scoured to leeward
  {
    const n = lod === 0 ? 10 : 7;
    const ctr = gb.v(-wx * 0.55, 0.42, -wz * 0.55, 0, 1, 0, ...uvSnow(0.5, 0.5), 1.05, 1.07, 1.13, 0);
    const ring = [];
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2;
      const cx2 = Math.cos(th), cz2 = Math.sin(th);
      const up = clamp(-(cx2 * wx + cz2 * wz), 0, 1);
      const rr = 0.62 + 0.5 * vnoise2(k * 2.3, 7.7) + 0.55 * up;
      const uv = uvSnow(0.5 + 0.35 * cx2, 0.5 + 0.35 * cz2);
      ring.push(gb.v(-wx * 0.55 + cx2 * rr, -0.16, -wz * 0.55 + cz2 * rr,
        cx2 * 0.5, 0.86, cz2 * 0.5, uv[0], uv[1], 1.02, 1.04, 1.10, 0));
    }
    for (let k = 0; k < n; k++) gb.tri(ctr, ring[(k + 1) % n], ring[k]);
  }

  // bare twigs through the drift
  if (lod === 0) {
    for (let k = 0; k < 5; k++) {
      const th = rnd() * Math.PI * 2;
      const rr = 0.35 + rnd() * 0.75;
      const bx = Math.cos(th) * rr, bz = Math.sin(th) * rr;
      const hh = 0.30 + rnd() * 0.42;
      const tx = bx + wx * hh * 0.55, tz = bz + wz * hh * 0.55;
      const w2 = 0.022;
      const C2 = [0.34, 0.32, 0.30];
      const a = gb.v(bx - w2, 0.10, bz, 0, 1, 0, ...uvDead(0.06, 0.36), ...C2, 0);
      const b = gb.v(bx + w2, 0.10, bz, 0, 1, 0, ...uvDead(0.06, 0.64), ...C2, 0);
      const c = gb.v(tx + w2 * 0.5, 0.10 + hh, tz, 0, 1, 0, ...uvDead(0.9, 0.64), ...C2, 0.9);
      const d = gb.v(tx - w2 * 0.5, 0.10 + hh, tz, 0, 1, 0, ...uvDead(0.9, 0.36), ...C2, 0.9);
      gb.quad(a, b, c, d);
    }
  }

  const g = gb.geo();
  g.userData.height = 1.4;
  return g;
}
/**
 * A boulder, as a radius field over the unit sphere: three octaves of value
 * noise, an anisotropic squash, then a handful of half-space cuts that shear it
 * into flat fractured facets. Keeping the shape as a *function* rather than a
 * displaced mesh is what lets the snow cap below be a real geometric shell
 * fitted to the rock instead of a per-face vertex tint that snaps to facet
 * edges.
 */
function rockShape(rnd) {
  const seed = rnd() * 40;
  const cuts = [];
  const nCuts = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < nCuts; i++) {
    const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
    cuts.push({
      n: new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph) * 0.8, Math.sin(ph) * Math.sin(th)).normalize(),
      d: 0.55 + rnd() * 0.35,
    });
  }
  const sx = 0.8 + rnd() * 0.6, sy = 0.55 + rnd() * 0.5, sz = 0.8 + rnd() * 0.6;
  const snowSeed = rnd() * 17;
  const f = (dx, dy, dz, out) => {
    let r = 1;
    r += 0.34 * (fbm3(dx * 1.6 + seed, dy * 1.6, dz * 1.6 - seed, 2) * 2 - 1);
    r += 0.15 * (fbm3(dx * 4.3 - seed, dy * 4.3, dz * 4.3, 2) * 2 - 1);
    r += 0.07 * (vnoise3(dx * 9.1, dy * 9.1, dz * 9.1 + seed) * 2 - 1);
    r = Math.max(0.35, r);
    out.set(dx * r * sx, dy * r * sy, dz * r * sz);
    for (const c of cuts) {
      const dot = out.dot(c.n);
      if (dot > c.d) out.addScaledVector(c.n, c.d - dot);
    }
    return out;
  };
  return { f, seed, snowSeed };
}

function buildRock(rnd, lod) {
  const detail = lod === 0 ? 2 : 1;
  const shape = rockShape(rnd);
  const src = new THREE.IcosahedronGeometry(1, detail).toNonIndexed();
  const pos = src.attributes.position;
  const arr = pos.array;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    shape.f(v.x, v.y, v.z, v);
    arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
  }
  pos.needsUpdate = true;

  // sit on the ground: bottom of the hull at y = -0.22 (partly buried)
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) { const y = arr[i * 3 + 1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const shift = -minY - 0.13 * (maxY - minY);
  for (let i = 0; i < pos.count; i++) arr[i * 3 + 1] += shift;

  src.computeVertexNormals();
  const nor = src.attributes.normal;

  const gb = new GB();
  const ra = 0.26 + rnd() * 0.13;
  const warm = rnd() * 0.10;
  for (let f = 0; f < pos.count; f += 3) {
    _a.fromBufferAttribute(nor, f);
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) { cx += arr[(f + k) * 3]; cy += arr[(f + k) * 3 + 1]; cz += arr[(f + k) * 3 + 2]; }
    cx /= 3; cy /= 3; cz /= 3;
    const grain = fbm3(cx * 3.1 + shape.seed, cy * 3.1, cz * 3.1, 2);
    const rockL = ra * (0.62 + 0.8 * grain);
    // The cap is real geometry now, so the rock body carries only a faint
    // wind-blown dusting. No smoothstep terminator snapping to facet edges.
    const dust = 0.18 * smoothstep(0.45, 0.95, _a.y) * smoothstep(0.2, 0.6, grain);
    const col = [
      lerp(rockL * (1 + warm), 1.05, dust),
      lerp(rockL * (1 + warm * 0.4), 1.07, dust),
      lerp(rockL * 1.02, 1.12, dust),
    ];
    const base = gb.p.length / 3;
    for (let k = 0; k < 3; k++) {
      const i = f + k;
      gb.v(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2],
        _a.x, _a.y, _a.z, 0.5, 0.5, col[0], col[1], col[2], 0);
    }
    gb.tri(base, base + 1, base + 2);
  }
  src.dispose();

  // ---- snow cap as its own shell ------------------------------------------
  // Sampled off the same radius field, lifted along the surface normal, ending
  // in a rolled lip that overhangs the rock silhouette. Smooth-shaded, so it
  // reads as an accumulation rather than a white patch glued on.
  {
    const NA = lod === 0 ? 14 : 9;
    const NR = lod === 0 ? 5 : 3;
    const P = new THREE.Vector3();
    const lat = (az) => 0.72 + 0.42 * vnoise2(Math.cos(az) * 1.9 + shape.snowSeed,
      Math.sin(az) * 1.9 - shape.snowSeed);
    const grid = [];
    for (let j = 0; j <= NR; j++) {
      const t = j / NR;
      const row = [];
      for (let k = 0; k < NA; k++) {
        const az = (k / NA) * Math.PI * 2;
        const phi = lat(az) * t;
        const dx = Math.sin(phi) * Math.cos(az), dy = Math.cos(phi), dz = Math.sin(phi) * Math.sin(az);
        shape.f(dx, dy, dz, P);
        const lift = 0.055 + 0.03 * vnoise2(k * 1.3, j * 2.1 + shape.snowSeed);
        const bright = 1.30 - 0.10 * t;
        row.push(gb.v(P.x + dx * lift, P.y + shift + dy * lift, P.z + dz * lift,
          dx, dy, dz, ...uvSnow(0.3 + 0.4 * t, 0.5 + 0.34 * Math.cos(az)),
          bright, bright * 1.01, bright * 1.05, 0));
      }
      grid.push(row);
    }
    // rolled, overhanging drip edge
    const lipA = [], lipB = [];
    for (let k = 0; k < NA; k++) {
      const az = (k / NA) * Math.PI * 2;
      const phi = lat(az);
      const dx = Math.sin(phi) * Math.cos(az), dy = Math.cos(phi), dz = Math.sin(phi) * Math.sin(az);
      shape.f(dx, dy, dz, P);
      const hx = Math.cos(az), hz = Math.sin(az);
      const over = 0.085 * (0.7 + 0.6 * vnoise2(k * 2.7, shape.snowSeed));
      lipA.push(gb.v(P.x + dx * 0.05 + hx * over, P.y + shift + dy * 0.05 - 0.02, P.z + dz * 0.05 + hz * over,
        hx * 0.7, 0.5, hz * 0.7, ...uvSnow(0.86, 0.5), 1.16, 1.18, 1.26, 0));
      lipB.push(gb.v(P.x + dx * 0.04 + hx * over * 0.75, P.y + shift + dy * 0.04 - over * 1.5, P.z + dz * 0.04 + hz * over * 0.75,
        hx * 0.86, -0.32, hz * 0.86, ...uvSnow(0.98, 0.5), 0.74, 0.79, 0.96, 0));
    }
    for (let j = 0; j < NR; j++) {
      for (let k = 0; k < NA; k++) {
        const k2 = (k + 1) % NA;
        gb.quad(grid[j][k], grid[j][k2], grid[j + 1][k2], grid[j + 1][k]);
      }
    }
    for (let k = 0; k < NA; k++) {
      const k2 = (k + 1) % NA;
      gb.quad(grid[NR][k], grid[NR][k2], lipA[k2], lipA[k]);
      gb.quad(lipA[k], lipA[k2], lipB[k2], lipB[k]);
    }
  }

  // ---- snow apron drifted against the base --------------------------------
  {
    const n = lod === 0 ? 12 : 8;
    const P = new THREE.Vector3();
    const inner = [], outer = [];
    for (let k = 0; k < n; k++) {
      const az = (k / n) * Math.PI * 2;
      shape.f(Math.cos(az) * 0.94, -0.34, Math.sin(az) * 0.94, P);
      const hx = Math.cos(az), hz = Math.sin(az);
      const rr = Math.hypot(P.x, P.z);
      const bank = 0.30 + 0.34 * vnoise2(k * 1.9, shape.snowSeed + 3.1);
      inner.push(gb.v(hx * rr * 1.0, P.y + shift + 0.10, hz * rr * 1.0,
        hx * 0.45, 0.89, hz * 0.45, ...uvSnow(0.2, 0.5), 1.14, 1.16, 1.22, 0));
      outer.push(gb.v(hx * rr * (1 + bank), -0.02, hz * rr * (1 + bank),
        hx * 0.18, 0.98, hz * 0.18, ...uvSnow(0.7, 0.5), 1.10, 1.12, 1.19, 0));
    }
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      gb.quad(inner[k], inner[k2], outer[k2], outer[k]);
    }
  }

  return gb.geo();
}

/** A fallen snag with a ridge of snow along the top and a torn root plate. */
function buildLog(rnd, lod) {
  const gb = new GB();
  const L = 5.0 + rnd() * 3.5;
  const r0 = 0.24 + rnd() * 0.14;
  const seg = lod === 0 ? 7 : 5;
  const rings = lod === 0 ? 5 : 3;
  const bark = [0.62, 0.56, 0.52];
  const bendY = 0.10 + rnd() * 0.16;
  const pts = [], radii = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    pts.push(new THREE.Vector3(-L * 0.5 + L * t, r0 * 0.85 + Math.sin(t * Math.PI) * bendY, (rnd() - 0.5) * 0.25));
    radii.push(r0 * (1 - 0.45 * t));
  }
  sweep(gb, pts, radii, seg, bark, () => 0);
  // snow ridge along the top
  const rows = [];
  for (let i = 0; i <= rings; i++) {
    const p = pts[i];
    const w = radii[i] * (0.75 + 0.55 * vnoise2(i * 2.1, r0 * 13));
    const uL = uvSnow(i / rings, 0.06), uC = uvSnow(i / rings, 0.5), uR = uvSnow(i / rings, 0.94);
    const cl = [1.18, 1.20, 1.24];
    rows.push([
      gb.v(p.x, p.y + radii[i] * 0.35, p.z - w, -0.3, 0.85, -0.44, uL[0], uL[1], ...cl, 0),
      gb.v(p.x, p.y + radii[i] * 0.95 + w * 0.35, p.z, 0, 1, 0, uC[0], uC[1], ...cl, 0),
      gb.v(p.x, p.y + radii[i] * 0.35, p.z + w, 0.3, 0.85, 0.44, uR[0], uR[1], ...cl, 0),
    ]);
  }
  for (let i = 0; i < rings; i++) {
    gb.quad(rows[i][0], rows[i][1], rows[i + 1][1], rows[i + 1][0]);
    gb.quad(rows[i][1], rows[i][2], rows[i + 1][2], rows[i + 1][1]);
  }
  // torn root plate at the butt end
  {
    const n = 7, R = r0 * 3.0;
    const c = gb.v(-L * 0.5 - 0.1, R * 0.55, 0, -1, 0.2, 0, ...uvBark(0.5, 0.5), 0.55, 0.50, 0.46, 0);
    const ring = [];
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2;
      const rr = R * (0.55 + 0.6 * vnoise2(k * 3.7, 5.1));
      ring.push(gb.v(-L * 0.5 + (rnd() - 0.5) * 0.2, Math.max(-0.1, R * 0.55 + Math.sin(th) * rr), Math.cos(th) * rr,
        -0.9, 0.3, 0, ...uvBark(0.2 + 0.6 * (k / n), 0.8), 0.42, 0.38, 0.35, 0));
    }
    for (let k = 0; k < n; k++) gb.tri(c, ring[k], ring[(k + 1) % n]);
  }
  return gb.geo();
}

/**
 * A wind drift, not a golf ball.
 *
 * The previous mound had its normal ramp inverted — nx tilted outward at the
 * apex and straight up at the rim — which produced a near-uniform +Y normal
 * over the whole surface, no shading gradient at all, and clipped to a flat
 * white disc. Here the normal is vertical at the crest and rolls horizontal at
 * the rim, the crest is pushed into the windward third with a scoured concave
 * lee face, and the rim is sunk well below the origin so the shape beds into a
 * 25 deg slope instead of floating its upslope edge clear of the snow.
 * The instance transform stretches it ~1.8x along a per-instance wind azimuth.
 */
function buildMound(rnd) {
  const gb = new GB();
  const n = 12;
  const rings = 4;
  const seed = rnd() * 9.1;
  const grid = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;                       // 0 crest .. 1 rim
    const row = [];
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2;
      const cth = Math.cos(th);                // +X is windward
      const wob = 0.78 + 0.44 * vnoise2(k * 1.9, j * 2.7 + seed);
      // windward flank is short and steep, lee flank long and scoured hollow
      const lee = clamp(-cth, 0, 1);
      const rr = Math.sin(t * Math.PI * 0.5) * wob * (0.82 + 0.5 * lee);
      const scour = lee * 0.34 * Math.sin(Math.PI * t);
      const y = Math.cos(t * Math.PI * 0.5) * (0.46 + 0.2 * wob) - scour - 0.35 * t * t;
      // correct dome normal: up at the apex, horizontal at the rim
      const nx = cth * t * 0.92, nz = Math.sin(th) * t * 0.92;
      const ny = 1 - t * 0.55;
      const nl = Math.hypot(nx, ny, nz);
      const shade = 1 - 0.06 * lee * (1 - t);
      const uv = uvSnow(0.3 + 0.4 * t, 0.5 + 0.34 * cth);
      row.push(gb.v(cth * rr + 0.22 * (1 - t), y, Math.sin(th) * rr, nx / nl, ny / nl, nz / nl,
        uv[0], uv[1], 1.17 * shade, 1.19 * shade, 1.25 * shade, 0));
    }
    grid.push(row);
  }
  for (let j = rings; j > 0; j--) {
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      gb.quad(grid[j][k], grid[j][k2], grid[j - 1][k2], grid[j - 1][k]);
    }
  }
  return gb.geo();
}

// =============================================================================
// Instanced pool — packed, swap-with-last removal
// =============================================================================
class Pool {
  constructor(geo, mat, cap, opts = {}) {
    // Every pool owns its geometry: the LOD dither threshold rides on a
    // per-instance attribute, so two pools may never share a BufferGeometry.
    const g = opts.share ? geo.clone() : geo;
    const rand = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    rand.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aRand', rand);
    this.rand = rand;
    const mesh = new THREE.InstancedMesh(g, mat, cap);
    mesh.count = 0;
    // An empty pool is not free. three has no early-out for count === 0: it
    // still binds the program, uploads the per-object uniforms and issues a
    // zero-instance draw, once for the main pass and once for EACH of the two
    // shadow cascades. There are ~70 pools here (17 species/variant pairs at
    // two geometry LODs alone) and in any one framing 15-20 of them are empty —
    // no LOD0 conifer within 34 m, no logs, no krummholz below the treeline —
    // so that is ~50 no-op draw submissions per frame. Gate it on the count.
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = !!opts.castShadow;
    mesh.receiveShadow = opts.receiveShadow !== false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.name = opts.name || 'scatter-pool';
    this.mesh = mesh;
    this.cap = cap;
    this.handles = new Array(cap);
    this.dirty = false;
  }

  add(m, col, rv) {
    const s = this.mesh.count;
    if (s >= this.cap) return null;
    m.toArray(this.mesh.instanceMatrix.array, s * 16);
    this.rand.array[s] = rv === undefined ? 0.5 : rv;
    const ca = this.mesh.instanceColor.array;
    ca[s * 3] = col ? col.r : 1; ca[s * 3 + 1] = col ? col.g : 1; ca[s * 3 + 2] = col ? col.b : 1;
    const h = { p: this, s };
    this.handles[s] = h;
    this.mesh.count = s + 1;
    this.mesh.visible = true;
    this.dirty = true;
    return h;
  }

  remove(h) {
    const last = this.mesh.count - 1;
    const s = h.s;
    if (s !== last) {
      const ma = this.mesh.instanceMatrix.array;
      ma.copyWithin(s * 16, last * 16, last * 16 + 16);
      const ca = this.mesh.instanceColor.array;
      ca.copyWithin(s * 3, last * 3, last * 3 + 3);
      this.rand.array[s] = this.rand.array[last];
      this.handles[s] = this.handles[last];
      this.handles[s].s = s;
    }
    this.mesh.count = last;
    this.mesh.visible = last > 0;
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.rand.needsUpdate = true;
  }
}

// =============================================================================
// Coarse terrain field reader — bilinear over the baked macro map. Cheap enough
// to call for every scatter candidate; `terrain.height()` (which is exact, and
// far more expensive) is only used once a candidate has been accepted.
// =============================================================================
class Field {
  constructor(terrain) {
    this.f = terrain.field;
    this.res = Math.round(Math.sqrt(terrain.field.length / 4));
    this.ext = terrain.size;
    this.step = this.ext / this.res;
    this.org = -this.ext / 2;
  }

  tex(i, j, ch) {
    const R = this.res;
    i = i < 0 ? 0 : i > R - 1 ? R - 1 : i;
    j = j < 0 ? 0 : j > R - 1 ? R - 1 : j;
    return this.f[(j * R + i) * 4 + ch];
  }

  bi(x, z, ch) {
    const qx = (x - this.org) / this.step, qz = (z - this.org) / this.step;
    const i = Math.floor(qx), j = Math.floor(qz);
    const fx = qx - i, fz = qz - j;
    const a = this.tex(i, j, ch), b = this.tex(i + 1, j, ch);
    const c = this.tex(i, j + 1, ch), d = this.tex(i + 1, j + 1, ch);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  /** height, gradient, flow, bedrock in one go. */
  probe(x, z, out) {
    const e = this.step;
    const h = this.bi(x, z, 0);
    out.h = h;
    out.gx = (this.bi(x + e, z, 0) - this.bi(x - e, z, 0)) / (2 * e);
    out.gz = (this.bi(x, z + e, 0) - this.bi(x, z - e, 0)) / (2 * e);
    out.slope = Math.hypot(out.gx, out.gz);
    out.flow = this.bi(x, z, 2);
    out.rock = this.bi(x, z, 3);
    return out;
  }
}

// =============================================================================
export function createScatter(scene, terrain) {
  const group = new THREE.Group();
  group.name = 'scatter';
  scene.add(group);

  const field = new Field(terrain);
  const probe = { h: 0, gx: 0, gz: 0, slope: 0, flow: 0, rock: 0 };

  // ---------------------------------------------------------------- shaders --
  const uniforms = {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uSway: { value: 0.055 },
    // metres of cross-section radius per metre of view distance: thin geometry
    // is widened to hold roughly a pixel and a half so cables, lattice
    // diagonals and gate poles stop aliasing out of existence
    uMinR: { value: 3.2e-4 },

    // ---- foliage radiance environment (see foliageLighting()) --------------
    // uBounce  radiance of the snowfield the stand is standing on
    // uSkyFill radiance of the sky dome, hue taken off sky.js's fill light
    // uSunRad  sun colour x intensity, for needle transmission
    // uSunW    world-space direction TOWARD the sun
    uBounce: { value: new THREE.Vector3(0.5, 0.52, 0.56) },
    uSkyFill: { value: new THREE.Vector3(0.10, 0.12, 0.16) },
    uSunRad: { value: new THREE.Vector3(6, 6, 6) },
    uSunW: { value: new THREE.Vector3(0.6, 0.6, -0.4) },
  };

  /**
   * Foliage vertex/fragment patch.
   *
   * Vertex: wind sway, plus the LOD dissolve. `uLod` is (inStart, inEnd,
   * outStart, outEnd); the resulting coverage minus the instance's own dither
   * threshold is handed to the fragment stage, which discards below zero.
   * Because neighbouring bands share their crossover interval and an item
   * keeps one threshold across both pools, exactly one representation of each
   * tree survives at any distance.
   */
  /**
   * The near-field conifer lighting model.
   *
   * MEASURED (tools/conifer-diag.mjs, camera 7 m off a mature spruce, sun at
   * 34 deg): the crown rendered mean L 31.6 with 71% of the frame below 32/255.
   * Ablating shadow *receive* alone put it at 53, ablating the albedo put it at
   * 59, tripling `scene.environmentIntensity` at 54. In other words nothing was
   * broken — the crown was simply light-starved. A dense conifer shadow-maps
   * itself almost completely, and the only fill it had was a sky IBL at 0.46
   * whose lower hemisphere is empty. The shaded side of the tree therefore
   * integrated to ~0.006 linear, which is the "hard-edged black alpha stencil"
   * the gate saw: not a silhouette problem, a radiance problem.
   *
   * What is physically missing is the snowfield. A conifer stands on a ~0.82
   * albedo diffuse reflector that is metered in this project at 1.0 linear when
   * sunlit; the irradiance arriving at a downward-facing needle from below is
   * of the same order as the irradiance arriving from the sky above it. That is
   * the single term that separates an alpine winter conifer from a black
   * cardboard cut-out, and it is unshadowed by construction (it is the ground,
   * not the key). Three terms are added here, all in linear radiance:
   *
   *   bounce  hemispherical, weighted toward downward-facing normals
   *   sky     hemispherical, weighted upward, plus a grazing rim so the mass
   *           reads as a volume with a lit edge instead of a flat plate
   *   trans   forward-scattered sun through the needle blade. Deliberately
   *           unshadowed: it is a thin-film transmission lobe about the sun
   *           direction, it only bites where the viewer is looking into the
   *           sun, and paying a second PCF kernel for it on every foliage
   *           fragment is not worth the ~2 fps.
   *
   * `fol` scales all three per band. The 130 m+ impostor cards get almost none:
   * their value against the snowfield (0.38x adjacent snow luminance) is a
   * calibrated result that two acceptance gates have signed off, and they carry
   * their own painted ambient occlusion already.
   */
  function foliageLighting(shader, fol) {
    if (!fol) return;
    const { bounce = 0, sky = 0, rim = 0, trans = 0 } = fol;
    shader.uniforms.uBounce = uniforms.uBounce;
    shader.uniforms.uSkyFill = uniforms.uSkyFill;
    if (trans > 0) {
      shader.uniforms.uSunRad = uniforms.uSunRad;
      shader.uniforms.uSunW = uniforms.uSunW;
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform vec3 uBounce;
        uniform vec3 uSkyFill;
        ${trans > 0 ? 'uniform vec3 uSunRad;\nuniform vec3 uSunW;' : ''}
      `)
      // COST. This runs on every foliage fragment in a band that covers most of
      // the screen inside the forest, and the fragment stage is where this
      // scene is bound: the first version cost 9 fps of 48 on the trees
      // framing. Everything below is written to avoid a basis change.
      //
      //   * mat3( viewMatrix ) is orthonormal, so dot( n, v ) is the same in
      //     view space as in world space. The rim term needs no transform.
      //   * only the world-space Y of the normal is wanted, and that is one dot
      //     product against the second column of viewMatrix, not a full
      //     view -> world rotation of two vectors.
      //   * pow( x, 5 ) is expanded; a real pow() here was measurable.
      .replace('#include <lights_fragment_end>', /* glsl */`
        #include <lights_fragment_end>
        {
          float wUp = dot( normal, viewMatrix[ 1 ].xyz );
          float dwn = clamp( 0.5 - 0.5 * wUp, 0.0, 1.0 );
          vec3 amb = uBounce * ( ${bounce.toFixed(3)} * ( 0.20 + 0.80 * dwn ) )
                   + uSkyFill * ( ${sky.toFixed(3)} * ( 0.28 + 0.72 * ( 1.0 - dwn ) ) );
          // Grazing rim. A needle mass is a scattering volume: at the edge of
          // the silhouette the path through it is short and it lights up. This
          // is what puts a contour on the crown that is not an alpha cut.
          float fres = 1.0 - abs( dot( normal, geometryViewDir ) );
          amb += uSkyFill * ( ${rim.toFixed(3)} * fres * fres * fres );
          reflectedLight.indirectDiffuse += amb * material.diffuseColor;

          #if ${trans > 0 ? 1 : 0}
            // Forward transmission: sharp lobe about the sun, plus a broad
            // wrap so a needle whose face is turned away is not pitch black.
            // The sun is rotated into view space here rather than the normal
            // into world space: it is uniform across the draw call.
            vec3 sunV = mat3( viewMatrix ) * uSunW;
            float fwd = clamp( dot( -geometryViewDir, sunV ), 0.0, 1.0 );
            float f2 = fwd * fwd;
            float wrap = clamp( -dot( normal, sunV ) * 0.7 + 0.3, 0.0, 1.0 );
            float tr = f2 * f2 * fwd * 0.85 + wrap * 0.15;
            reflectedLight.directDiffuse += uSunRad * ( ${trans.toFixed(3)} * tr )
                                          * material.diffuseColor;
          #endif
        }
      `);
  }

  function patchFoliage(mat, key, spec = 0.04, atlas = null, fol = null) {
    const uLod = mat.__uLod;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uCam = uniforms.uCam;
      shader.uniforms.uSway = uniforms.uSway;
      shader.uniforms.uLod = uLod;
      foliageLighting(shader, fol);
      // Per-instance atlas cell selection.
      //
      // The gate's finding on the 92-210 m band was that every card carried the
      // identical texture at the identical orientation, so the canopy repeated.
      // The card geometry can only bake ONE cell, so the variation has to
      // happen here: `aRand` (the item's stable LOD dither threshold, uniform
      // in 0..1 and already on every instance) is re-hashed into two
      // independent bits — mirror the cell about its own centre, and step to
      // the second baked view a row down the atlas. Two extra ALU ops per
      // vertex, no extra attribute, no extra draw call, 4x the silhouettes.
      if (atlas) {
        const { cols, rows } = atlas;
        shader.vertexShader = shader.vertexShader
          .replace('#include <uv_vertex>', /* glsl */`
            #include <uv_vertex>
            #ifdef USE_MAP
              {
                float cb = floor( vMapUv.x * ${cols.toFixed(1)} ) / ${cols.toFixed(1)};
                float ul = vMapUv.x - cb;
                if ( aRand > 0.5 ) vMapUv.x = cb + ${(1 / cols).toFixed(6)} - ul;
                ${rows > 1 ? `
                if ( fract( aRand * 13.7 ) > 0.5 ) vMapUv.y -= ${(1 / rows).toFixed(6)};
                ` : ''}
              }
            #endif
          `);
      }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          attribute float aFlex;
          attribute float aRand;
          attribute float aTint;
          uniform float uTime;
          uniform vec3 uCam;
          uniform float uSway;
          uniform vec4 uLod;
          varying float vLodA;
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          vec3 transformed = vec3( position );
          #ifdef USE_INSTANCING
            vec3 iOrg = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          #else
            vec3 iOrg = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          #endif
          float iDist = distance( iOrg, uCam );
          vLodA = smoothstep( uLod.x, uLod.y, iDist )
                * ( 1.0 - smoothstep( uLod.z, uLod.w, iDist ) ) - aRand;
          float ph = uTime * 1.05 + iOrg.x * 0.07 + iOrg.z * 0.055;
          float amp = aFlex * aFlex * uSway;
          transformed.x += ( sin( ph ) + 0.32 * sin( ph * 2.7 + 1.3 ) ) * amp;
          transformed.z += cos( ph * 0.83 + 2.0 ) * amp * 0.8;
        `)
        // Per-instance colour is a *foliage* variation — bluish-green through
        // olive to near-black across a stand. `aTint` gates it, so the snow
        // load and the bark on a heavily tinted tree stay their own colour
        // instead of turning green with the needles.
        .replace('#include <color_vertex>', /* glsl */`
          #include <color_vertex>
          #ifdef USE_INSTANCING_COLOR
            vColor.xyz = mix( vColor.xyz / max( instanceColor.xyz, vec3( 1e-4 ) ),
                              vColor.xyz, aTint );
          #endif
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          varying float vLodA;
          uniform float uTime;
        `)
        .replace('#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\n if ( vLodA <= 0.0 ) discard;')
        // Stochastic alpha coverage. A plain alpha test turns every needle
        // fringe into a stair-stepped binary edge, which is precisely the
        // "flat cutout plane" read. Instead the texture alpha is converted to
        // an analytic coverage using its own screen-space derivative, then
        // dithered against a hash that rotates every frame; the TAA resolve
        // integrates it into a soft, correctly anti-aliased edge at no extra
        // fill cost.
        //
        // MEASURED, and the reason the previous version of this did not fix
        // the aliasing the gate saw. Three still frames of the same near-crown,
        // 50 renders each: (A) as shipped, (B) with fx/postfx PARAMS.taa.detail
        // forced to 0, (C) with TAA off. B is clean and soft. A carries a
        // regular diagonal screen-door weave over every dark foliage region —
        // so the temporal resolve WAS integrating the dither correctly, and
        // then the composer's output step was printing it straight back on top.
        // `detail` re-adds the CURRENT frame's high-frequency luminance
        // residual (luma(c) - luma of its four neighbours) at 0.55, and a
        // one-pixel dither is nothing but high-frequency residual.
        //
        // postfx is not this module's file, so the fix is on this side, and it
        // is two changes, both measured on the same still crop of deep crown
        // shadow with mean |c - mean(N,S,W,E)| (the exact residual the composer
        // re-injects):
        //
        //   * the dither threshold is constant over a 2x2 screen block, so half
        //     of every fragment's four residual neighbours share its threshold.
        //     3x3 was tried first and is WORSE than it looks on paper: the TAA
        //     clip box is a 3x3 min/max of the current frame, and a dither that
        //     is constant over exactly that footprint collapses the box, which
        //     rejects the history and lets more of the current frame through.
        //   * the coverage band is 0.55 px rather than 1.0, which roughly
        //     halves the number of fragments that take a probabilistic decision
        //     at all while still resolving a real silhouette edge.
        //
        // 6.82 -> 6.35 on that crop against a floor of 4.37 (the same frame
        // with the composer's re-injection forced off). Most of what is left is
        // genuine needle detail, not dither: narrowing the band a further 2.5x
        // did not move the number, which is what ruled the dither out as the
        // dominant term and is why this is not chased further.
        .replace('#include <alphatest_fragment>', /* glsl */`
          #ifdef USE_ALPHATEST
            float aCov = ( diffuseColor.a - alphaTest ) /
                         max( fwidth( diffuseColor.a ) * 0.55, 1e-4 ) + 0.5;
            if ( aCov < 1.0 ) {
              vec2 ipx = floor( gl_FragCoord.xy * 0.5 )
                       + fract( uTime * vec2( 3.7, 2.3 ) ) * 137.0;
              float ign = fract( 52.9829189 *
                          fract( dot( ipx, vec2( 0.06711056, 0.00583715 ) ) ) );
              if ( aCov < ign ) discard;
            }
          #endif
        `)
        // Foliage is not a polished dielectric slab.
        //
        // MEASURED: with the card albedo forced to pure black, roughness 1 and
        // fog off, the 200-400 m stand still rendered at 0.62 x the luminance
        // of the snow beside it — i.e. most of the "white ice shard" was an
        // albedo-INDEPENDENT term. It is the F0 = 0.04 dielectric lobe: a card
        // is a big flat quad whose shading normal points at the sky, so it
        // collects the specular reflection of a 2000 m alpine sky across its
        // whole area, which no volume of needles ever does. `envMapIntensity`
        // cannot be used to fight this — three overwrites it with
        // `scene.environmentIntensity` for scene.environment (WebGLRenderer,
        // "material.envMap === null && scene.environment !== null"), so the
        // only place to kill it is here.
        .replace('#include <lights_physical_fragment>', /* glsl */`
          #include <lights_physical_fragment>
          material.specularColor = vec3( ${spec.toFixed(3)} );
          material.specularColorBlended = vec3( ${spec.toFixed(3)} );
          material.specularF90 = ${spec > 0 ? '1.0' : '0.0'};
        `);
    };
    // The foliage constants are baked into the source, so two bands with
    // different `fol` are different programs and must not share a cache key.
    const fk = fol ? `-${fol.bounce}:${fol.sky}:${fol.rim}:${fol.trans}` : '';
    mat.customProgramCacheKey = () => key + fk;
    return mat;
  }

  /**
   * Prop patch: screen-space minimum width. `aRad` is the world radius of the
   * cross-section a vertex sits on; below the floor the section is expanded
   * along its own normal so a 6 cm lattice diagonal or a 6 cm haul rope keeps
   * a stable, non-shimmering silhouette all the way out. Without it the cable
   * simply vanishes past ~180 m and leaves chairs hanging in mid-air.
   */
  function patchProp(mat, key, uMinRef = uniforms.uMinR, farClamp = 0) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uMinR = uMinRef;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          attribute float aRad;
          uniform float uMinR;
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          vec3 transformed = vec3( position );
          #ifdef USE_INSTANCING
            vec4 mvP = modelViewMatrix * instanceMatrix * vec4( transformed, 1.0 );
          #else
            vec4 mvP = modelViewMatrix * vec4( transformed, 1.0 );
          #endif
          float vDist = max( 1.0, -mvP.z );
          ${farClamp ? `vDist = min( vDist, ${farClamp.toFixed(1)} );` : ''}
          float kExp = max( 1.0, ( uMinR * vDist ) / max( aRad, 1e-4 ) );
          transformed += normalize( normal ) * aRad * ( kExp - 1.0 );
        `);
    };
    mat.customProgramCacheKey = () => key;
    return mat;
  }

  /** A foliage material bound to one LOD band. Same program, own uniforms. */
  function bandMat(proto, band, key, spec, atlas, fol) {
    const m = proto.clone();
    m.__uLod = { value: new THREE.Vector4(band[0], band[1], band[2], band[3]) };
    return patchFoliage(m, key, spec, atlas, fol);
  }

  // Near geometry carries the full model; the reduced band carries it at the
  // same strength (the swap at 34-46 m must not change value); the cards get a
  // whisper of bounce only, so the calibrated treeline value does not move.
  const FOL_NEAR = { bounce: 0.62, sky: 0.34, rim: 0.55, trans: 0.055 };
  // No transmission past 34 m: the lobe is 5 deg wide about the sun and at that
  // range it is a sub-pixel effect, but the 34-150 m band is most of the
  // foliage fill in a forest framing, so the two dots and the uniforms it needs
  // are not free. Same bounce and sky, so the LOD swap is not a tonal step.
  const FOL_MID = { bounce: 0.60, sky: 0.33, rim: 0.45, trans: 0 };
  const FOL_CARD = { bounce: 0.10, sky: 0.05, rim: 0.0, trans: 0.0 };

  const treeAtlas = makeTreeAtlas();
  const treeTex = treeAtlas.tex;
  const impTex = makeSingleImpostorAtlas();
  // dense -> sparse cells; the density model picks the cell, which is what
  // turns the treeline into tongues and glades instead of an even soft fade
  // The baked `haze` is now token: sky.js runs a real per-channel aerial
  // perspective over these bands, so painting the wash into the atlas as well
  // double counted it, and was a large part of why the far stands read pale.
  const clTex = makeClusterAtlas([25, 18, 11, 5], CL_W, CL_H, CL_SINK / CL_H, 0xc1a5, 0.02, false);
  const massTex = makeClusterAtlas([86, 66, 40, 18], MASS_W, MASS_H, MASS_SINK / MASS_H, 0x9a55, 0.10, true);
  const netTex = makeNetTexture();

  // alphaTest is only the *centre* of the stochastic coverage band now (see
  // patchFoliage), so it can sit low: needle tips fade out over the last texel
  // instead of snapping off at one.
  const protoTree = new THREE.MeshStandardMaterial({
    map: treeTex, normalMap: treeAtlas.nrm,
    normalScale: new THREE.Vector2(1.0, 1.0),
    alphaTest: 0.34, side: THREE.DoubleSide, vertexColors: true,
    roughness: 0.86, metalness: 0.0,
  });
  const matTree0 = bandMat(protoTree, B_G0, 'sc-fol', 0.04, null, FOL_NEAR);
  const matTree1 = bandMat(protoTree, B_G1, 'sc-fol', 0.04, null, FOL_MID);
  // Deadfall is bark and litter, not needle: it gets the bounce (it is lying on
  // the snowfield, so it gets more of it than a crown does) and nothing else.
  const matLog0 = bandMat(protoTree, B_LOG0, 'sc-fol', 0.04, null, { bounce: 0.34, sky: 0.14, rim: 0.10, trans: 0 });
  const matLog1 = bandMat(protoTree, B_LOG1, 'sc-fol', 0.04, null, { bounce: 0.34, sky: 0.14, rim: 0.10, trans: 0 });

  // A lower alpha test on the cards: the snow strokes are what mip reduction
  // attacks first, and cutting them at 0.30 keeps the frost alive several
  // levels further down the chain than 0.42 did.
  const protoImp = new THREE.MeshStandardMaterial({
    map: impTex, alphaTest: 0.30, side: THREE.FrontSide, vertexColors: true,
    roughness: 0.9, metalness: 0.0,
  });
  // spec 0: see the note in patchFoliage. A card is a flat quad standing in
  // for a volume of needles; the dielectric lobe it would otherwise collect off
  // the sky is the single largest term in the far treeline's brightness.
  const matImp = bandMat(protoImp, B_IMP, 'sc-card64', 0, { cols: IMP_COLS, rows: IMP_ROWS }, FOL_CARD);
  const matCl = bandMat(protoImp, B_CL, 'sc-card42', 0, { cols: 4, rows: CL_ROWS.length }, FOL_CARD);
  matCl.map = clTex;
  const matMass = bandMat(protoImp, B_MASS, 'sc-card42', 0, { cols: 4, rows: CL_ROWS.length }, FOL_CARD);
  matMass.map = massTex;
  matMass.alphaTest = 0.26;

  const protoRock = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0.0,
  });
  const matRock0 = bandMat(protoRock, B_ROCK0, 'sc-solid');
  const matRock1 = bandMat(protoRock, B_ROCK1, 'sc-solid');

  const protoSnow = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.72, metalness: 0.0,
  });
  const matDrift0 = bandMat(protoSnow, B_DRIFT0, 'sc-solid');
  const matDrift1 = bandMat(protoSnow, B_DRIFT1, 'sc-solid');

  // Painted / galvanised surfaces are dielectric. The old single prop material
  // carried metalness 0.32, which gave a red gate panel a large grey PMREM
  // specular lobe (it measured rgb(223,119,120) against an authored 0.72,0.09,
  // 0.09) and made the whole lattice sparkle.
  // Galvanised steel at lattice scale is diffuse, not chrome.
  const matPaint = patchProp(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.78, metalness: 0.06,
  }), 'sc-prop');

  // Riders get their own copy of the same program with a much larger screen
  // floor. MEASURED, and the reason the gate saw "no legs, no poles": the
  // shared uMinR is 3.2e-4 rad of radius, and at 900 px over a 58 deg vertical
  // field that is 812 px/rad, i.e. 0.26 px of RADIUS — half a pixel of width,
  // not the "pixel and a half" the constant is documented as. A 13 mm ski pole
  // therefore aliased out of existence at every distance a rider is ever seen
  // at. 9.5e-4 puts a pole at 1.55 px. The distance is clamped at 140 m so the
  // same floor does not inflate a rider's thighs into a blob out at 350 m,
  // where the whole figure is four pixels tall.
  const uRiderMinR = { value: 9.5e-4 };
  const matRider = patchProp(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.72, metalness: 0.04,
  }), 'sc-rider', uRiderMinR, 140);
  // Snow bounce, the same radiance argument the buildings and the player rig
  // already won (skier.js: "on the shaded side of a backlit skier that bounce
  // IS the light"). The sky IBL's lower hemisphere is empty, so a figure
  // standing mid-piste on a 0.82-albedo reflector integrated to almost nothing
  // on every face not aimed at the sun — and since a rider at 40-100 m shows
  // the camera mostly its shaded side, the whole field read as burnt
  // silhouettes: a green jacket and a black one were the same figure. Same
  // weights as matBuild; a rider has the same unobstructed view of the
  // snowfield and the dome that a hut wall has.
  {
    const inner = matRider.onBeforeCompile;
    matRider.onBeforeCompile = (shader) => {
      inner(shader);
      shader.uniforms.uBounce = uniforms.uBounce;
      shader.uniforms.uSkyFill = uniforms.uSkyFill;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform vec3 uBounce;
          uniform vec3 uSkyFill;
        `)
        .replace('#include <lights_fragment_end>', /* glsl */`
          #include <lights_fragment_end>
          {
            float wUp = dot( normal, viewMatrix[ 1 ].xyz );
            float dwn = clamp( 0.5 - 0.5 * wUp, 0.0, 1.0 );
            vec3 amb = uBounce * ( 0.80 * ( 0.34 + 0.66 * dwn ) )
                     + uSkyFill * ( 0.22 * ( 0.30 + 0.70 * ( 1.0 - dwn ) ) );
            reflectedLight.indirectDiffuse += amb * material.diffuseColor;
          }
        `);
    };
    matRider.customProgramCacheKey = () => 'sc-rider';
  }

  /**
   * Buildings, and the same radiance argument the near-field conifers already
   * won. A hut stands in the middle of a 0.82-albedo diffuse reflector in full
   * sun; the irradiance arriving at its shaded wall from BELOW is of the same
   * order as the irradiance arriving at its roof from the sky. The sky IBL this
   * project runs has an empty lower hemisphere, so the shaded face of every
   * building integrated to almost nothing — which is most of what "a cream
   * plane meeting a black plane" was. No amount of board relief can show on a
   * wall that is receiving no light to model it with.
   *
   * Same uniforms as foliageLighting(), weighted for an object with an
   * unobstructed view of both the snowfield and the dome.
   */
  const matBuild = patchProp(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.82, metalness: 0.03,
  }), 'sc-build');
  {
    const inner = matBuild.onBeforeCompile;
    matBuild.onBeforeCompile = (shader) => {
      inner(shader);
      shader.uniforms.uBounce = uniforms.uBounce;
      shader.uniforms.uSkyFill = uniforms.uSkyFill;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform vec3 uBounce;
          uniform vec3 uSkyFill;
        `)
        .replace('#include <lights_fragment_end>', /* glsl */`
          #include <lights_fragment_end>
          {
            float wUp = dot( normal, viewMatrix[ 1 ].xyz );
            float dwn = clamp( 0.5 - 0.5 * wUp, 0.0, 1.0 );
            vec3 amb = uBounce * ( 0.80 * ( 0.34 + 0.66 * dwn ) )
                     + uSkyFill * ( 0.22 * ( 0.30 + 0.70 * ( 1.0 - dwn ) ) );
            reflectedLight.indirectDiffuse += amb * material.diffuseColor;
          }
        `);
    };
    matBuild.customProgramCacheKey = () => 'sc-build';
  }
  const matNet = new THREE.MeshStandardMaterial({
    map: netTex, alphaTest: 0.35, side: THREE.DoubleSide, vertexColors: true,
    roughness: 0.85, metalness: 0.0,
  });

  // ---------------------------------------------------------------- assets --
  const grnd = mulberry32(0x51c1);

  // Two silhouettes per species so a stand does not read as clones. Krummholz
  // gets its own builder: it is a prostrate wind-flagged mat, not a small tree.
  // Three silhouettes per species. The variant skews height, spread, snow load
  // and age independently, so within one species a stand shows a slim young
  // spire, a broad heavily-plastered middle-aged tree and a tall gappy old one.
  // Together with the per-instance hue, scale, lean and rotation applied at
  // emit time, no two neighbours read as the same asset.
  const VSKEW = [
    { hScale: 1.00, spread: 1.00, load: 1.05, age: 0.25 },
    { hScale: 0.78, spread: 1.18, load: 1.20, age: 0.10 },
    { hScale: 1.22, spread: 0.86, load: 0.72, age: 0.85 },
  ];
  const VARIANTS = [];
  for (let si = 0; si < SPECIES.length; si++) {
    const nv = si === 4 ? 2 : 3;
    for (let k = 0; k < nv; k++) {
      const seed = 0x1000 + si * 97 + k * 13;
      const mk = (lod) => (si === 4
        ? buildKrummholz(mulberry32(seed), lod)
        : buildConifer(mulberry32(seed), si, lod, VSKEW[k]));
      VARIANTS.push({ si, k, lod0: mk(0), lod1: mk(1), small: si === 3 || si === 4 });
    }
  }
  // variant indices grouped by species, so the emitter can pick one at random
  const BY_SPECIES = SPECIES.map(() => []);
  VARIANTS.forEach((V, i) => BY_SPECIES[V.si].push(i));
  // Impostor cell per (species, variant) — see impCol/impRow. Saplings and
  // krummholz never get one. Twelve columns x two baked views x the shader's
  // per-instance mirror gives 48 distinct card silhouettes in the band.

  // Single-tree cards must subtend the same solid angle as the geometry they
  // replace, or the swap at 100 m changes apparent tree width on top of
  // everything else. Measure the LOD1 hull instead of guessing.
  const _bb = new THREE.Box3();
  for (const V of VARIANTS) {
    _bb.setFromBufferAttribute(V.lod1.attributes.position);
    V.impH = _bb.max.y;
    V.impW = 2 * Math.max(
      Math.max(Math.abs(_bb.min.x), Math.abs(_bb.max.x)),
      Math.max(Math.abs(_bb.min.z), Math.abs(_bb.max.z))) * 0.94;
  }

  const rockGeo = [];
  for (let i = 0; i < 4; i++) {
    const seed = 0x77 + i * 31;
    rockGeo.push({ lod0: buildRock(mulberry32(seed), 0), lod1: buildRock(mulberry32(seed), 1) });
  }
  const logGeo = [];
  for (let i = 0; i < 3; i++) {
    const sd = 0x300 + i * 47;
    logGeo.push({ lod0: buildLog(mulberry32(sd), 0), lod1: buildLog(mulberry32(sd), 1) });
  }

  // ------------------------------------------------------------------ pools --
  const pools = { tree: [], rock: [], log: [], drift: null, cluster: [], mass: [] };
  const CAP0 = 260, CAP1 = 900, CAPI = 1500;

  for (let vi = 0; vi < VARIANTS.length; vi++) {
    const V = VARIANTS[vi];
    const small = V.small;
    // castShadow on BOTH geometry bands. It used to be set on LOD0 only, so
    // every tree past the swap distance lost its ground contact and the stand
    // read as stickers pasted on the snow.
    const p0 = new Pool(V.lod0, matTree0, small ? 360 : CAP0, { castShadow: true, name: 'tree0' });
    const p1 = new Pool(V.lod1, matTree1, small ? 1100 : CAP1, { castShadow: true, name: 'tree1' });
    let p2 = null;
    if (!small) {
      // No shadow receive on the cards. The cascade at 100-600 m resolves a
      // whole stand into one binary decision, so a card either blazes white or
      // goes to ambient black — which is exactly the "row of pale spikes next
      // to a row of black spikes" read. The painted card already carries its
      // own self-shadowing.
      p2 = new Pool(buildCard(impCol(V.si, V.k), impRow(V.si, V.k, 0), IMP_COLS, IMP_ROWS,
        V.impW, V.impH, 0.35, 3),
      matImp, CAPI, { name: 'tree2', receiveShadow: false });
    }
    pools.tree.push([p0, p1, p2]);
    group.add(p0.mesh, p1.mesh);
    if (p2) group.add(p2.mesh);
  }

  // Cluster and canopy-mass cards. One instance carries eight to forty stems,
  // so distant canopy coverage rises about tenfold while the instance count
  // stays where it was — the fix for a distant forest that was measurably
  // sparser than the near one.
  for (let c = 0; c < 4; c++) {
    const p = new Pool(buildCard(c, 0, 4, CL_ROWS.length, CL_W, CL_H - CL_SINK, CL_SINK, 3), matCl, 2800,
      { name: 'clust', receiveShadow: false });
    pools.cluster.push(p);
    group.add(p.mesh);
    const q = new Pool(buildCard(c, 0, 4, CL_ROWS.length, MASS_W, MASS_H - MASS_SINK, MASS_SINK, 2), matMass, 1900,
      { name: 'mass', receiveShadow: false });
    pools.mass.push(q);
    group.add(q.mesh);
  }

  for (let i = 0; i < rockGeo.length; i++) {
    const p0 = new Pool(rockGeo[i].lod0, matRock0, 150, { castShadow: true, name: 'rock0' });
    const p1 = new Pool(rockGeo[i].lod1, matRock1, 1400, { castShadow: true, name: 'rock1' });
    pools.rock.push([p0, p1]);
    group.add(p0.mesh, p1.mesh);
  }
  for (let i = 0; i < logGeo.length; i++) {
    const p0 = new Pool(logGeo[i].lod0, matLog0, 110, { castShadow: true, name: 'log0' });
    const p1 = new Pool(logGeo[i].lod1, matLog1, 420, { castShadow: true, name: 'log1' });
    pools.log.push([p0, p1]);
    group.add(p0.mesh, p1.mesh);
  }
  pools.drift = [
    new Pool(buildMound(grnd), matDrift0, 300, { castShadow: true, name: 'drift0' }),
    new Pool(buildMound(mulberry32(0x4411)), matDrift1, 1600, { castShadow: true, name: 'drift1' }),
  ];
  group.add(pools.drift[0].mesh, pools.drift[1].mesh);

  const allPools = [];
  const reg = (p) => { if (p && !allPools.includes(p)) allPools.push(p); };
  for (const t of pools.tree) for (const p of t) reg(p);
  for (const t of pools.rock) for (const p of t) reg(p);
  for (const t of pools.log) for (const p of t) reg(p);
  for (const p of pools.cluster) reg(p);
  for (const p of pools.mass) reg(p);
  for (const p of pools.drift) reg(p);

  // ---- boot-time shader warm-up ---------------------------------------------
  // A pool that is empty at boot does not link its program until the first time
  // it populates — and neither does the separate depth material the shadow map
  // builds for it, which does not inherit onBeforeCompile and is therefore a
  // second program. At the hero framing rock0, log0 and half a dozen small-tree
  // pools start empty and only fill once the player has skied into that stand,
  // so the link lands as a single-frame stall a couple of seconds into every
  // run. `renderer.compile()` at boot cannot help: it walks materials, not the
  // shadow map's derived ones, and an InstancedMesh with count 0 is not drawn.
  //
  // So every pool starts with ONE instance whose matrix is scale 0. It is a
  // degenerate triangle: it rasterises nothing, costs no fragments, and is
  // still enough to make the renderer link the program and the shadow variant.
  // It is removed after a few frames — see `warmFrames` in update().
  const warmHandles = [];
  let warmFrames = 4;
  {
    const wm = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const p of allPools) {
      const h = p.add(wm, null, 0.5);
      if (h) warmHandles.push(h);
    }
  }

  // =========================================================================
  // Density model
  // =========================================================================
  /**
   * Returns 0..1 forest density and the band (0 = tall conifers, 1 = krummholz).
   * Everything is a product of independent, physically-motivated masks; the
   * clumping field at the end is what stops it reading as a sprinkle.
   */
  function forestAt(x, z, pr) {
    const cx = corridorX(z);
    const dCorr = Math.abs(x - cx);
    let m = smoothstep(PISTE_HALF, PISTE_HALF + PISTE_SOFT, dCorr);
    if (m <= 0.001) return 0;

    // keep the lift line clear
    const dLift = Math.abs(x - (cx + LIFT_OFFSET));
    if (z > LIFT_Z0 - 60 && z < LIFT_Z1 + 60) m *= smoothstep(11, 24, dLift);
    if (m <= 0.001) return 0;

    // buildings stand in cleared ground — nobody roofs a hut around a spruce
    for (let i = 0; i < BUILDINGS.length; i++) {
      const b = BUILDINGS[i];
      const bdx = x - b.x, bdz = z - b.z;
      if (bdx * bdx + bdz * bdz < b.clear * b.clear * 2.6) {
        m *= smoothstep(b.clear * 0.62, b.clear * 1.6, Math.hypot(bdx, bdz));
        if (m <= 0.001) return 0;
      }
    }
    {
      const vdx = (x - VILLAGE.x) / 1.7, vdz = z - VILLAGE.z;
      const vd = Math.hypot(vdx, vdz);
      if (vd < VILLAGE.r * 2.2) {
        m *= smoothstep(VILLAGE.r * 0.85, VILLAGE.r * 2.0, vd);
        if (m <= 0.001) return 0;
      }
    }

    // altitude vs. a wobbling, aspect-shifted treeline. In the Alps a north
    // face carries the treeline 150-200 m higher than a south face, so the
    // aspect term has to be a physical shift and not a noise-scale nudge.
    const wob = (fbm2(x * 0.0013, z * 0.0013, 3) - 0.5) * 190;
    const aspect = pr.slope > 0.02 ? clamp(pr.gz / (pr.slope + 0.25), -1, 1) : 0;
    const line = TREELINE + wob + aspect * 140;
    const alt = smoothstep(line, line - FOREST_BAND, pr.h);
    if (alt <= 0.001) return 0;
    m *= alt;

    // slope — nothing roots on a 42 deg face
    m *= smoothstep(0.98, 0.60, pr.slope);
    // avalanche paths: high flow accumulation stays swept clear
    m *= 1 - 0.88 * smoothstep(0.42, 0.72, pr.flow);
    // exposed bedrock
    m *= 1 - 0.7 * smoothstep(0.25, 0.7, pr.rock);

    // Clumping, at the three wavelengths a real alpine forest actually has:
    // 830 m avalanche corridors and gullies, 240 m stands, and 33 m clumps
    // and glades. The fine term is allowed to reach zero — the old one bottomed
    // out at 0.66 and so never opened a real hole, which is why the boundary
    // read as an even soft fade instead of tongues climbing gullies with bare
    // spurs between them.
    const cl0 = fbm2(x * 0.0012 - 5.7, z * 0.0012 + 2.9, 2);
    const cl = fbm2(x * 0.0042, z * 0.0042, 3);
    const cl3 = fbm2(x * 0.030 + 8.3, z * 0.030 - 4.1, 2);
    m *= (0.22 + 0.95 * smoothstep(0.26, 0.62, cl0))
      * (0.11 + 1.06 * smoothstep(0.30, 0.64, cl))
      * (0.05 + 1.10 * smoothstep(0.36, 0.62, cl3));

    return clamp(m, 0, 1);
  }

  function rockAt(x, z, pr) {
    const cx = corridorX(z);
    const dCorr = Math.abs(x - cx);
    let m = smoothstep(58, 140, dCorr);
    if (m <= 0.001) return 0;
    // scree accumulates below cliffs: the terrain's own thermal-erosion
    // deposition channel is exactly that signal
    const scree = smoothstep(0.04, 0.42, pr.rock) * 0.95 + smoothstep(0.50, 0.92, pr.slope) * 0.75;
    m *= clamp(scree, 0, 1);
    m *= smoothstep(1.30, 0.95, pr.slope);            // not on vertical rock
    const cl = fbm2(x * 0.011 + 31.7, z * 0.011 - 12.3, 2);
    m *= 0.10 + 1.55 * smoothstep(0.38, 0.68, cl);
    return clamp(m, 0, 1);
  }

  // =========================================================================
  // Chunk generation
  // =========================================================================
  // A cell keeps two independent item lists.
  //
  //  `far`  — cluster cards, canopy-mass cards and rock/scree clusters. Cheap,
  //           built for every cell inside the cull radius.
  //  `near` — individual stems, deadfall, drifts and understorey scrub. Only
  //           built for cells within NEAR_R, because at 5.6 m spacing a cell
  //           holds ~290 candidates and generating that out to 1.2 km would
  //           cost a second of load time for detail nothing can resolve.
  //
  // Closed subalpine spruce/fir runs 500-900 stems/ha. The old 11.4 m grid gave
  // 74/ha at FULL density, which is where the "evenly stamped tree emoji" read
  // came from. 5.6 m is ~320/ha of geometry, and the cluster cards carry the
  // rest of the canopy where the stems would be sub-pixel anyway.
  const chunks = new Map();
  const TREE_SPACING = 5.6;
  // Closed subalpine spruce is a *mass*, not a plantation: side by side with a
  // reference photograph the old spacing read as well-separated Christmas trees
  // on white ground. Cluster cards are what carry canopy closure past 170 m.
  const CL_SPACING = 9.6;
  const MASS_SPACING = 26;

  function pickVariant(rn, pr, h) {
    // Species mix drifts with altitude: pine low and warm, spruce everywhere,
    // fir on the sheltered mid slopes, krummholz at the top. A few per cent of
    // every stand is a dead standing snag, which is what a real subalpine
    // forest looks like and what a procedural one never has.
    const high = smoothstep(TREELINE - 150, TREELINE + 40, h);
    const r = rn();
    let si;
    if (high > 0.62 && r < 0.55) si = 4;
    else if (r < 0.20 + 0.25 * (1 - high)) si = 2;
    else if (r < 0.55) si = 1;
    else si = 0;
    // Snags: rare, and rarer still below the treeline. At 5-10% of every stand
    // there were several in every framing, and a population that large stops
    // reading as "the odd dead tree" and starts reading as a rendering fault.
    if (si !== 4 && rn() < 0.018 + 0.022 * high) si = 5;    // snags
    else if (rn() < 0.24 + 0.14 * high) si = 3;             // saplings
    const g = BY_SPECIES[si];
    return g[(rn() * g.length) | 0];
  }

  /** Denser clumps get a fuller card; the sparse cells carry the treeline edge. */
  const cardCell = (d) => (d > 0.80 ? 0 : d > 0.58 ? 1 : d > 0.34 ? 2 : 3);

  function genFar(ci, cj) {
    const x0 = ci * CHUNK, z0 = cj * CHUNK;
    const items = [];
    const rn = mulberry32(hashi(ci, cj, 0x5b27) ^ 0x2c9);

    // ---- cluster + canopy-mass cards --------------------------------------
    // Jitter above 1.0 means neighbouring cells can swap order along an axis.
    // That is the point: at 0.55 the grid was still legible as a grid at 300 m
    // (rows of spires at 10.5 m centres), and cards overlap for free.
    // `vk` scales how much of the height variance each band takes. A canopy-mass
    // card is already 52 x 33 m; at the full envelope it grew to 83 x 53 m and a
    // single one standing on a 700 m cliff put its painted base drift on the
    // rock as a white blob the size of a building. Cluster cards are 21 m and
    // take it in full.
    for (const cfg of [
      { sp: CL_SPACING, k: 4, jit: 1.45, vk: 1.0, hw: CL_W * 0.42, sink: CL_SINK },
      { sp: MASS_SPACING, k: 5, jit: 1.15, vk: 0.40, hw: MASS_W * 0.42, sink: MASS_SINK },
    ]) {
      const n = Math.max(1, Math.round(CHUNK / cfg.sp));
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          const px = x0 + (a + 0.5 + (rn() - 0.5) * cfg.jit) * (CHUNK / n);
          const pz = z0 + (b + 0.5 + (rn() - 0.5) * cfg.jit) * (CHUNK / n);
          field.probe(px, pz, probe);
          const d = forestAt(px, pz, probe);
          // Acceptance is no longer allowed to saturate. At 0.52 + 0.90 d every
          // cell of a dense stand was accepted, so a dense stand was a filled
          // grid — the single largest contributor to the even spacing. The gap
          // field opens genuine holes inside closed forest.
          const acc = (0.42 + 0.74 * d) * (0.40 + 0.95 * standGap(px, pz));
          if (d < 0.05 || rn() > acc) continue;
          // A card is a flat billboard 21 m (cluster) or 52 m (mass) wide with
          // a painted snow drift along its foot, sunk into the ground by a
          // fixed amount. Where the ground falls away faster than that sink
          // across the card's own span, the drift band hangs in the air over
          // the drop — MEASURED as a white blob the size of a building on a
          // 700 m rock face in the `ridge` framing, ray-picked back to a mass
          // card. Reject the site rather than fight it in the shader.
          if (probe.slope > 0.70) continue;
          const hc = terrain.height(px, pz);
          const drop = Math.max(
            hc - terrain.height(px - cfg.hw, pz), hc - terrain.height(px + cfg.hw, pz),
            hc - terrain.height(px, pz - cfg.hw), hc - terrain.height(px, pz + cfg.hw));
          if (drop > cfg.sink * 1.1) continue;
          // Stand vigour carries the low-frequency height envelope; the
          // per-card term is deliberately skewed so a stand is mostly one
          // height with a few emergents, not a uniform spread.
          const sv = 1 + cfg.vk * (standVigour(px, pz) - 1);
          const em = 1 + cfg.vk * (0.87 + 0.52 * Math.pow(rn(), 2.1) - 1);
          items.push({
            k: cfg.k, v: cardCell(d), x: px, y: hc - drop * 0.55, z: pz,
            r: rn() * Math.PI * 2,
            // s and sy are drawn independently, so a card's ASPECT varies too:
            // a squat broad clump and a narrow spire are different silhouettes
            // even when they are the same painted cell.
            s: sv * em * (1 + cfg.vk * (0.82 + 0.42 * rn() - 1)),
            sy: sv * em * (1 + cfg.vk * (0.86 + 0.30 * rn() - 1)),
            tint: 0.94 + 0.12 * rn(), q: rn() * 0.996 + 0.002,
          });
        }
      }
    }

    // ---- rocks: clustered, never an even sprinkle -------------------------
    let anyRock = 0;
    for (let a = 0; a <= 2; a++) {
      for (let b = 0; b <= 2; b++) {
        const px = x0 + a * CHUNK * 0.5, pz = z0 + b * CHUNK * 0.5;
        field.probe(px, pz, probe);
        anyRock = Math.max(anyRock, rockAt(px, pz, probe));
      }
    }
    if (anyRock > 0.02) {
      for (let c = 0; c < 3; c++) {
        const cxp = x0 + rn() * CHUNK, czp = z0 + rn() * CHUNK;
        field.probe(cxp, czp, probe);
        const d = rockAt(cxp, czp, probe);
        if (rn() > d) continue;
        const spread = 8 + rn() * 26;
        const count = 3 + Math.floor(rn() * 11 * d);
        const bias = rn();
        for (let i = 0; i < count; i++) {
          const th = rn() * Math.PI * 2;
          const rr = spread * Math.pow(rn(), 0.6);
          const px = cxp + Math.cos(th) * rr, pz = czp + Math.sin(th) * rr;
          field.probe(px, pz, probe);
          if (rockAt(px, pz, probe) < 0.04) continue;
          const size = (0.75 + 3.2 * Math.pow(rn(), 2.0)) * (0.7 + 1.6 * bias);
          items.push({
            k: 1, v: Math.floor(rn() * rockGeo.length), x: px, y: terrain.height(px, pz), z: pz,
            r: rn() * Math.PI * 2, s: size,
            // clamped near-isotropic: the old 0.78-1.22 Y scale stretched the
            // cap faces and their normals into comet-streak snow decals
            sy: size * (0.94 + 0.12 * rn()),
            tint: 0.82 + 0.3 * rn(), q: rn() * 0.996 + 0.002,
            nx: -probe.gx, nz: -probe.gz,
          });
        }
      }
    }
    return items;
  }

  function genNear(ci, cj) {
    const x0 = ci * CHUNK, z0 = cj * CHUNK;
    const items = [];
    const rn = mulberry32(hashi(ci, cj, 0x5b27));

    let anyTree = 0;
    for (let a = 0; a <= 2; a++) {
      for (let b = 0; b <= 2; b++) {
        const px = x0 + a * CHUNK * 0.5, pz = z0 + b * CHUNK * 0.5;
        field.probe(px, pz, probe);
        anyTree = Math.max(anyTree, forestAt(px, pz, probe));
      }
    }

    if (anyTree > 0.012) {
      const n = Math.round(CHUNK / TREE_SPACING);
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          const px = x0 + (a + 0.15 + rn() * 0.7) * (CHUNK / n);
          const pz = z0 + (b + 0.15 + rn() * 0.7) * (CHUNK / n);
          field.probe(px, pz, probe);
          const d = forestAt(px, pz, probe);
          if (rn() > d) {
            // Forest floor. A real stand is never a clean sheet up to each
            // trunk: buried scrub, snow-capped deadfall, drifted hummocks.
            // Understorey. The reference photographs are never a clean sheet
            // up to each trunk: half-buried scrub with bare twigs through the
            // drift, then hummocks, then the odd snow-capped deadfall.
            if (d > 0.20 && rn() < 0.16) {
              const sz = 0.42 + 0.55 * rn();
              items.push({
                k: 0, v: BY_SPECIES[4][(rn() * BY_SPECIES[4].length) | 0],
                x: px, y: terrain.height(px, pz), z: pz,
                r: rn() * Math.PI * 2, s: sz, sy: sz * (0.7 + 0.4 * rn()),
                tint: 0.88 + 0.2 * rn(), q: rn() * 0.996 + 0.002,
              });
            } else if (d > 0.24 && rn() < 0.12) {
              const sz = 0.6 + 1.5 * Math.pow(rn(), 1.5);
              items.push({
                k: 2, v: 0, x: px, y: terrain.height(px, pz), z: pz,
                r: rn() * Math.PI * 2, s: sz, sy: sz * (0.34 + 0.3 * rn()),
                tint: 0.93 + 0.1 * rn(), q: rn() * 0.996 + 0.002, wide: 1.5 + 0.7 * rn(),
              });
            } else if (d > 0.42 && rn() < 0.10) {
              const sz = 0.75 + 0.6 * rn();
              items.push({
                k: 3, v: Math.floor(rn() * 3), x: px, y: terrain.height(px, pz), z: pz,
                r: rn() * Math.PI * 2, s: sz, sy: sz,
                tint: 0.85 + 0.25 * rn(), q: rn() * 0.996 + 0.002,
                nx: -probe.gx, nz: -probe.gz,
              });
            }
            continue;
          }
          const vi = pickVariant(rn, probe, probe.h);
          const V = VARIANTS[vi];
          const S = SPECIES[V.si];
          // Wide age spread: mostly middle-aged, a long tail of young stems and
          // a few dominants. Pow 2.2 is what puts real saplings in a stand.
          let sc = 0.44 + 0.80 * Math.pow(rn(), 2.2);
          if (S.name === 'krumm') sc = 0.7 + 0.8 * rn();
          const shrink = 1 - 0.42 * smoothstep(TREELINE - 190, TREELINE + 20, probe.h);
          sc *= shrink;
          // ...and the stand it is standing in. Same field the cluster cards
          // use, so a stem does not change height class as it crosses the
          // 130-250 m card boundary. Applied at 0.78 weight on the geometry
          // band: these are the stems the player is beside, where the field
          // must not out-shout the individual age spread.
          if (S.name !== 'krumm') sc *= 1 + 0.78 * (standVigour(px, pz) - 1);
          const y = terrain.height(px, pz);
          // Per-instance foliage colour: `vv` runs near-black to bright, `w`
          // runs blue-green (shaded north aspect, spruce) to olive (sunlit
          // pine). Gated by aTint, so only the needles take it.
          // `vv` is a MULTIPLIER on the foliage albedo, so it must stay below 1
          // or the tint brightens instead of varying. It read 0.88..1.26, and
          // with the blue weight below (up to 1.12x) that scaled foliage by as
          // much as 1.4x, strongest in blue — which is what turned the treeline
          // into white-blue ice spikes at distance.
          const vv = 0.40 + 0.34 * rn();
          const w = rn();
          items.push({
            k: 0, v: vi, x: px, y, z: pz,
            r: rn() * Math.PI * 2, s: sc, sy: sc * (0.88 + 0.30 * rn()),
            tint: vv * (0.88 + 0.18 * w),
            tg: vv * (1.00 + 0.02 * w),
            tb: vv * (1.12 - 0.22 * w),
            // trees grow to gravity, but not exactly: a couple of degrees of
            // lean per stem is the difference between a plantation and a wood
            lx: (rn() - 0.5) * 0.10, lz: (rn() - 0.5) * 0.10,
            q: rn() * 0.996 + 0.002,
          });
        }
      }
    }

    // ---- wind drifts on the piste shoulders --------------------------------
    // The strip between the groomed run and the forest edge was a blank white
    // band. Off-piste snow there is sastrugi and wind hummock, and it gives the
    // corridor a readable edge.
    for (let i = 0; i < 9; i++) {
      const px = x0 + rn() * CHUNK, pz = z0 + rn() * CHUNK;
      const off = Math.abs(px - corridorX(pz));
      if (off < PISTE_HALF - 4 || off > PISTE_HALF + PISTE_SOFT) continue;
      field.probe(px, pz, probe);
      if (probe.slope > 0.85) continue;
      if (rn() > 0.30 + 0.6 * fbm2(px * 0.016 + 3.1, pz * 0.016, 2)) continue;
      const size = 1.1 + 2.6 * Math.pow(rn(), 1.4);
      items.push({
        k: 2, v: 0, x: px, y: terrain.height(px, pz), z: pz,
        r: rn() * Math.PI * 2, s: size, sy: size * (0.16 + 0.14 * rn()),
        tint: 0.96 + 0.07 * rn(), q: rn() * 0.996 + 0.002, wide: 2.1 + 1.0 * rn(),
      });
    }

    // ---- wind drifts in the krummholz band --------------------------------
    {
      const px0 = x0 + CHUNK * 0.5, pz0 = z0 + CHUNK * 0.5;
      field.probe(px0, pz0, probe);
      const band = smoothstep(KRUMM_LO - 90, KRUMM_LO + 30, probe.h) *
        smoothstep(KRUMM_HI + 130, KRUMM_HI - 40, probe.h);
      if (band > 0.05) {
        const cnt = Math.round(10 * band);
        for (let i = 0; i < cnt; i++) {
          const px = x0 + rn() * CHUNK, pz = z0 + rn() * CHUNK;
          field.probe(px, pz, probe);
          const cx = corridorX(pz);
          if (Math.abs(px - cx) < PISTE_HALF + 16) continue;
          if (probe.slope > 0.95) continue;
          if (rn() > 0.35 + 0.5 * fbm2(px * 0.02, pz * 0.02, 2)) continue;
          // Above the treeline the band is krummholz, not bald hemispheres:
          // most of what goes here is a wind-flagged mat, and the drifts are
          // the minority that beds it in.
          if (rn() < 0.55) {
            const sc = 0.85 + 0.7 * rn();
            items.push({
              k: 0, v: BY_SPECIES[4][(rn() * BY_SPECIES[4].length) | 0],
                x: px, y: terrain.height(px, pz), z: pz,
              r: rn() * Math.PI * 2, s: sc, sy: sc * (0.85 + 0.3 * rn()),
              tint: 0.9 + 0.16 * rn(), q: rn() * 0.996 + 0.002,
            });
          } else {
            const size = 0.7 + 2.1 * Math.pow(rn(), 1.6);
            items.push({
              k: 2, v: 0, x: px, y: terrain.height(px, pz), z: pz,
              r: rn() * Math.PI * 2, s: size, sy: size * (0.4 + 0.35 * rn()),
              tint: 0.94 + 0.1 * rn(), q: rn() * 0.996 + 0.002, wide: 1.6 + 0.6 * rn(),
            });
          }
        }
      }
    }
    return items;
  }

  // =========================================================================
  // Streaming
  // =========================================================================
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _q2 = new THREE.Quaternion();
  const _pos = new THREE.Vector3();
  const _scl = new THREE.Vector3();
  const _col = new THREE.Color();
  const _nrm = new THREE.Vector3();

  const inBand = (d, B) => d > B[0] - EMIT_PAD && d < B[3] + EMIT_PAD;

  /** Every pool this item wants to sit in, given its distance from the player. */
  function poolsFor(it, d, out) {
    out.length = 0;
    if (it.k === 0) {
      const set = pools.tree[it.v];
      if (inBand(d, B_G0)) out.push(set[0]);
      if (inBand(d, B_G1)) out.push(set[1]);
      if (set[2] && inBand(d, B_IMP)) out.push(set[2]);
    } else if (it.k === 1) {
      if (inBand(d, B_ROCK0)) out.push(pools.rock[it.v][0]);
      // sub-metre boulders are not worth carrying to 600 m
      if (inBand(d, B_ROCK1) && (it.s > 1.1 || d < 190)) out.push(pools.rock[it.v][1]);
    } else if (it.k === 2) {
      if (inBand(d, B_DRIFT0)) out.push(pools.drift[0]);
      if (inBand(d, B_DRIFT1)) out.push(pools.drift[1]);
    } else if (it.k === 3) {
      if (inBand(d, B_LOG0)) out.push(pools.log[it.v][0]);
      if (inBand(d, B_LOG1)) out.push(pools.log[it.v][1]);
    } else if (it.k === 4) {
      if (inBand(d, B_CL)) out.push(pools.cluster[it.v]);
    } else if (it.k === 5) {
      if (inBand(d, B_MASS)) out.push(pools.mass[it.v]);
    }
    return out;
  }

  const _pl = [];

  function emitList(chunk, list, px, pz) {
    const hs = chunk.handles;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const dx = it.x - px, dz = it.z - pz;
      const d = Math.sqrt(dx * dx + dz * dz);
      const ps = poolsFor(it, d, _pl);
      if (!ps.length) continue;
      if (it.k === 1 || it.k === 3) {
        // rocks and deadfall bed into the slope: partly gravity-aligned,
        // partly surface-aligned. Trees grow to gravity — but each with a
        // couple of degrees of its own lean.
        _nrm.set(it.nx, 1, it.nz).normalize();
        _nrm.lerp(UP, it.k === 3 ? 0.10 : 0.25).normalize();
        _q.setFromUnitVectors(UP, _nrm);
        _q2.setFromAxisAngle(UP, it.r);
        _q.multiply(_q2);
      } else if (it.lx !== undefined) {
        _nrm.set(it.lx, 1, it.lz).normalize();
        _q.setFromUnitVectors(UP, _nrm);
        _q2.setFromAxisAngle(UP, it.r);
        _q.multiply(_q2);
      } else {
        _q.setFromAxisAngle(UP, it.r);
      }
      _pos.set(it.x, it.y - (it.k === 1 ? it.s * 0.05 : it.k === 3 ? 0.14 : 0), it.z);
      // drifts stretch along their own wind azimuth; everything else is
      // isotropic in plan
      _scl.set(it.wide ? it.s * it.wide : it.s, it.sy, it.s);
      _m.compose(_pos, _q, _scl);
      _col.setRGB(it.tint, it.tg === undefined ? it.tint : it.tg,
        it.tb === undefined ? it.tint * 1.01 : it.tb);
      for (let k = 0; k < ps.length; k++) {
        const h = ps[k].add(_m, _col, it.q);
        if (h) hs.push(h);
      }
    }
  }

  function emit(chunk, want, px, pz) {
    chunk.want = want;
    chunk.ex = px; chunk.ez = pz;
    emitList(chunk, chunk.far, px, pz);
    if (want === 2) emitList(chunk, chunk.near, px, pz);
  }

  function unemit(chunk) {
    for (let i = chunk.handles.length - 1; i >= 0; i--) {
      const h = chunk.handles[i];
      h.p.remove(h);
    }
    chunk.handles.length = 0;
    chunk.want = 0;
  }

  const pending = [];
  let lastCX = NaN, lastCZ = NaN;
  let firstFill = 40;

  function refresh(px, pz) {
    const rc = Math.ceil(R_FAR / CHUNK) + 1;
    const ci0 = Math.floor(px / CHUNK), cj0 = Math.floor(pz / CHUNK);
    pending.length = 0;
    const wanted = new Set();

    for (let j = -rc; j <= rc; j++) {
      for (let i = -rc; i <= rc; i++) {
        const ci = ci0 + i, cj = cj0 + j;
        const cx = (ci + 0.5) * CHUNK, cz = (cj + 0.5) * CHUNK;
        const dx = Math.max(0, Math.abs(cx - px) - CHUNK * 0.5);
        const dz = Math.max(0, Math.abs(cz - pz) - CHUNK * 0.5);
        const d = Math.hypot(dx, dz);
        if (d > R_FAR) continue;
        const want = d < NEAR_R ? 2 : 1;
        const key = ci * 65536 + cj;
        wanted.add(key);
        const c = chunks.get(key);
        // near cells are re-emitted as the player moves, because the LOD band
        // an individual stem belongs to is a function of its own distance
        if (c && c.want === want &&
          (want === 1 || (Math.abs(c.ex - px) < MOVE_RE && Math.abs(c.ez - pz) < MOVE_RE))) continue;
        pending.push({ key, ci, cj, want, d });
      }
    }
    pending.sort((a, b) => a.d - b.d);

    for (const [key, c] of chunks) {
      if (c.want > 0 && !wanted.has(key)) unemit(c);
      if (c.want === 0) {
        const cx = (c.ci + 0.5) * CHUNK, cz = (c.cj + 0.5) * CHUNK;
        if (Math.hypot(cx - px, cz - pz) > CACHE_R) chunks.delete(key);
      }
    }
  }

  /**
   * Time-boxed as well as count-boxed. A teleport (the capture harness, a
   * respawn) invalidates the whole ring at once; without the wall-clock cap
   * the catch-up frame can block for the better part of a second.
   */
  function drain(budget, px, pz) {
    let n = 0;
    const t0 = performance.now();
    while (pending.length && n < budget) {
      if ((n & 15) === 15 && performance.now() - t0 > 14) break;
      const job = pending.shift();
      let c = chunks.get(job.key);
      if (!c) {
        c = { ci: job.ci, cj: job.cj, far: genFar(job.ci, job.cj), near: null, want: 0, ex: 0, ez: 0, handles: [] };
        chunks.set(job.key, c);
      }
      if (job.want === 2 && !c.near) c.near = genNear(job.ci, job.cj);
      if (c.want > 0) unemit(c);
      emit(c, job.want, px, pz);
      n++;
    }
  }
  // =========================================================================
  // Resort infrastructure
  // =========================================================================
  const CYL = new THREE.CylinderGeometry(1, 1, 1, 6, 1, false);
  const CYL8 = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
  const BOX = new THREE.BoxGeometry(1, 1, 1);

  const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _dv = new THREE.Vector3();
  const _mm = new THREE.Matrix4(), _qq = new THREE.Quaternion(), _ss = new THREE.Vector3();

  function strut(gb, a, b, r, col, geo = CYL) {
    _dv.copy(b).sub(a);
    const len = _dv.length();
    if (len < 1e-4) return;
    _qq.setFromUnitVectors(UP, _dv.clone().normalize());
    _ss.set(r, len, r);
    _p0.copy(a).addScaledVector(_dv, 0.5);
    _mm.compose(_p0, _qq, _ss);
    // carry the world radius through so the shader can hold this section above
    // a pixel and a half on screen
    gb.add(geo, _mm, col, null, 0, r);
  }

  function boxAt(gb, pos, size, rotY, col, rad = 0) {
    _qq.setFromAxisAngle(UP, rotY);
    _mm.compose(pos, _qq, size);
    gb.add(BOX, _mm, col, null, 0, rad);
  }

  const STEEL = [0.52, 0.55, 0.58];
  const STEEL_D = [0.30, 0.32, 0.35];
  const YELLOW = [0.80, 0.62, 0.10];

  // ------------------------------------------------------------- chairlift --
  const lift = { towers: [], cables: [], chairs: null };

  function buildLift() {
    const gb = new GB();

    // Tower stations along the line.
    const nT = Math.round((LIFT_Z1 - LIFT_Z0) / LIFT_SPAN);
    const st = [];
    for (let i = 0; i <= nT; i++) {
      const z = LIFT_Z0 + (i / nT) * (LIFT_Z1 - LIFT_Z0);
      const x = corridorX(z) + LIFT_OFFSET;
      st.push({ x, z, g: terrain.height(x, z) });
    }
    // Cable height: hold at least 8 m over the worst ground in a moving window,
    // so the line never dives into the slope between towers.
    for (let i = 0; i <= nT; i++) {
      let worst = -Infinity;
      const s = st[i];
      for (let k = -1; k <= 1; k++) {
        const j = clamp(i + k, 0, nT);
        for (let t = 0; t <= 6; t++) {
          const a = st[j], b = st[clamp(j + 1, 0, nT)];
          const x = lerp(a.x, b.x, t / 6), z = lerp(a.z, b.z, t / 6);
          worst = Math.max(worst, terrain.height(x, z));
        }
      }
      s.top = Math.max(s.g + 7.0, worst + 7.5);
      s.h = clamp(s.top - s.g, 6.5, 26);
      s.top = s.g + s.h;
    }

    const ARM = 2.9;       // half spacing of the two cables
    for (let i = 0; i <= nT; i++) {
      const s = st[i];
      // travel direction, for the cross-arm orientation
      const a = st[Math.max(0, i - 1)], b = st[Math.min(nT, i + 1)];
      const dz = b.z - a.z, dx = b.x - a.x;
      const yaw = Math.atan2(dx, dz);
      const perpX = Math.cos(yaw), perpZ = -Math.sin(yaw);

      // --- tapered lattice truss ---------------------------------------
      const baseHalf = Math.max(0.85, s.h * 0.085);
      const topHalf = 0.42;
      const levels = Math.max(3, Math.round(s.h / 3.1));
      const legs = [];
      for (let c = 0; c < 4; c++) {
        const sx = (c === 0 || c === 3) ? 1 : -1;
        const sz = (c < 2) ? 1 : -1;
        legs.push({ sx, sz });
      }
      const nodeAt = (c, lv) => {
        const t = lv / levels;
        const half = lerp(baseHalf, topHalf, Math.pow(t, 0.85));
        const L = legs[c];
        const ax = L.sx * half, az = L.sz * half;
        // rotate the footprint into the line direction
        const rx = ax * Math.cos(yaw) + az * Math.sin(yaw);
        const rz = -ax * Math.sin(yaw) + az * Math.cos(yaw);
        return new THREE.Vector3(s.x + rx, s.g - 0.6 + t * (s.h + 0.6), s.z + rz);
      };
      for (let c = 0; c < 4; c++) {
        for (let lv = 0; lv < levels; lv++) {
          strut(gb, nodeAt(c, lv), nodeAt(c, lv + 1), 0.115, STEEL);
        }
      }
      for (let lv = 1; lv <= levels; lv++) {
        for (let c = 0; c < 4; c++) {
          const c2 = (c + 1) % 4;
          strut(gb, nodeAt(c, lv), nodeAt(c2, lv), 0.055, STEEL_D);
          if (lv < levels) strut(gb, nodeAt(c, lv), nodeAt(c2, lv + 1), 0.045, STEEL_D);
        }
      }
      // concrete footing — a plinth standing proud of the snow, not a slab
      // lying on it
      boxAt(gb, new THREE.Vector3(s.x, s.g - 0.30, s.z),
        new THREE.Vector3(baseHalf * 1.55, 2.0, baseHalf * 1.55), yaw, [0.50, 0.50, 0.48]);
      boxAt(gb, new THREE.Vector3(s.x, s.g + 0.62, s.z),
        new THREE.Vector3(baseHalf * 1.30, 0.30, baseHalf * 1.30), yaw, [0.56, 0.56, 0.54]);

      // --- cross-arm + sheave trains ------------------------------------
      const topY = s.g + s.h;
      const armL = new THREE.Vector3(s.x - perpX * ARM, topY, s.z - perpZ * ARM);
      const armR = new THREE.Vector3(s.x + perpX * ARM, topY, s.z + perpZ * ARM);
      strut(gb, armL, armR, 0.20, STEEL, CYL8);
      strut(gb, new THREE.Vector3(s.x, topY - 1.5, s.z), new THREE.Vector3(s.x, topY + 0.35, s.z), 0.22, STEEL, CYL8);

      for (const arm of [armL, armR]) {
        const dir = arm === armL ? -1 : 1;
        // rocker beams
        const bal = new THREE.Vector3(arm.x, arm.y - 0.55, arm.z);
        strut(gb, arm, bal, 0.10, STEEL);
        const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
        const nSh = 6;
        for (let k = 0; k < nSh; k++) {
          const t = (k - (nSh - 1) / 2) * 0.62;
          const c = new THREE.Vector3(bal.x + fwdX * t, bal.y - 0.30, bal.z + fwdZ * t);
          // sheave wheel, axis across the line
          _qq.setFromUnitVectors(UP, new THREE.Vector3(perpX, 0, perpZ));
          _mm.compose(c, _qq, new THREE.Vector3(0.30, 0.16, 0.30));
          gb.add(CYL8, _mm, [0.16, 0.17, 0.18]);
        }
        // rocker plate
        boxAt(gb, new THREE.Vector3(bal.x, bal.y + 0.02, bal.z),
          new THREE.Vector3(0.10, 0.30, nSh * 0.62 + 0.5), yaw, STEEL_D);
        // guard rail under the sheaves
        strut(gb,
          new THREE.Vector3(bal.x - fwdX * 2.1, bal.y - 0.85, bal.z - fwdZ * 2.1),
          new THREE.Vector3(bal.x + fwdX * 2.1, bal.y - 0.85, bal.z + fwdZ * 2.1),
          0.05, YELLOW);
        void dir;
      }

      // maintenance ladder up the uphill face
      {
        const lx = s.x + Math.sin(yaw) * (baseHalf * 0.55), lz = s.z + Math.cos(yaw) * (baseHalf * 0.55);
        const a1 = new THREE.Vector3(lx - perpX * 0.22, s.g, lz - perpZ * 0.22);
        const a2 = new THREE.Vector3(lx + perpX * 0.22, s.g, lz + perpZ * 0.22);
        const b1 = a1.clone().setY(s.g + s.h - 1.2);
        const b2 = a2.clone().setY(s.g + s.h - 1.2);
        strut(gb, a1, b1, 0.035, YELLOW);
        strut(gb, a2, b2, 0.035, YELLOW);
      }

      lift.towers.push({ ...s, yaw, perpX, perpZ, armL, armR, topY });
    }

    // --- cables: catenary sag between sheave points -----------------------
    for (let side = 0; side < 2; side++) {
      const pts = [];
      for (let i = 0; i < nT; i++) {
        const A = lift.towers[i], B = lift.towers[i + 1];
        const pa = side ? A.armR : A.armL, pb = side ? B.armR : B.armL;
        const span = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        const sag = Math.min(4.2, span * span * 0.00042);
        const SEG = 7;
        for (let k = 0; k < SEG; k++) {
          const t = k / SEG;
          const x = lerp(pa.x, pb.x, t), z = lerp(pa.z, pb.z, t);
          const y = lerp(pa.y, pb.y, t) - sag * 4 * t * (1 - t) - 0.62;
          pts.push(new THREE.Vector3(x, y, z));
        }
      }
      const last = side ? lift.towers[nT].armR : lift.towers[nT].armL;
      pts.push(last.clone().setY(last.y - 0.62));

      // Tube it, and tag the section radius. A 6.2 cm haul rope is under a
      // pixel past ~180 m; without the width floor the cable simply disappeared
      // and left a row of chairs hanging in mid-air over the far slope, which
      // was the single most unfinished thing in the frame.
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.TubeGeometry(curve, pts.length, 0.062, 5, false);
      gb.add(tube, new THREE.Matrix4(), [0.17, 0.18, 0.20], null, 0, 0.062);
      tube.dispose();

      // arc-length table for the chairs
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      lift.cables.push({ pts, cum, total: cum[cum.length - 1], dir: side ? 1 : -1 });
    }

    // --- terminals ---------------------------------------------------------
    for (const end of [0, nT]) {
      const s = lift.towers[end];
      const yaw = s.yaw;
      const gy = s.g;
      const fx2 = Math.sin(yaw), fz2 = Math.cos(yaw);
      const px2 = Math.cos(yaw), pz2 = -Math.sin(yaw);
      // Station shed. It used to be a bare grey slab with a flat red lid,
      // which is what those unexplained grey rectangles on the far slope
      // were. Now: dark timber walls, a glazed band, a pitched roof carrying
      // a full snow load with an overhanging eave, and a drift banked against
      // the uphill wall — a shed in February, not a placeholder box.
      boxAt(gb, new THREE.Vector3(s.x, gy + 1.9, s.z), new THREE.Vector3(9.2, 4.0, 14.6), yaw, [0.20, 0.19, 0.20]);
      boxAt(gb, new THREE.Vector3(s.x, gy + 3.1, s.z), new THREE.Vector3(9.35, 1.1, 12.0), yaw, [0.10, 0.13, 0.17]);
      boxAt(gb, new THREE.Vector3(s.x, gy - 0.4, s.z), new THREE.Vector3(9.9, 1.2, 15.2), yaw, [0.42, 0.42, 0.41]);
      {
        const ridgeY = gy + 6.3, eaveY = gy + 3.85;
        const hw = 5.6, hl = 8.4;
        const mk = (a, b, c, col) => gb.v(
          s.x + px2 * a + fx2 * c, b, s.z + pz2 * a + fz2 * c,
          0, 1, 0, ...uvSnow(0.5 + a * 0.04, 0.5 + c * 0.03), col[0], col[1], col[2], 0);
        const SN = [1.20, 1.22, 1.28], SL = [0.86, 0.90, 1.02], EV = [0.24, 0.22, 0.21];
        for (const sgn of [-1, 1]) {
          for (let k = 0; k < 4; k++) {
            const t0 = k / 4, t1 = (k + 1) / 4;
            const c0 = -hl + 2 * hl * t0, c1 = -hl + 2 * hl * t1;
            // rolled, sagging eave line
            const drop = 0.30 * Math.sin(Math.PI * t0), drop1 = 0.30 * Math.sin(Math.PI * t1);
            const a0 = mk(0, ridgeY, c0, SN), a1 = mk(0, ridgeY, c1, SN);
            const b0 = mk(sgn * hw, eaveY - drop, c0, SL), b1 = mk(sgn * hw, eaveY - drop1, c1, SL);
            const e0 = mk(sgn * hw * 1.1, eaveY - 0.55 - drop, c0, EV);
            const e1 = mk(sgn * hw * 1.1, eaveY - 0.55 - drop1, c1, EV);
            if (sgn > 0) { gb.quad(a0, a1, b1, b0); gb.quad(b0, b1, e1, e0); }
            else { gb.quad(a1, a0, b0, b1); gb.quad(b1, b0, e0, e1); }
          }
        }
      }
      // bull wheel
      const wy = s.topY - 0.6;
      const torus = new THREE.TorusGeometry(3.0, 0.22, 5, 18);
      _qq.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      _mm.compose(new THREE.Vector3(s.x, wy, s.z), _qq, new THREE.Vector3(1, 1, 1));
      gb.add(torus, _mm, STEEL_D);
      torus.dispose();
      for (let k = 0; k < 6; k++) {
        const th = (k / 6) * Math.PI * 2;
        strut(gb, new THREE.Vector3(s.x, wy, s.z),
          new THREE.Vector3(s.x + Math.cos(th) * 3.0, wy, s.z + Math.sin(th) * 3.0), 0.09, STEEL);
      }
    }

    const geo = gb.geo();
    const mesh = new THREE.Mesh(geo, matPaint);
    mesh.name = 'chairlift';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  function buildChair() {
    const gb = new GB();
    const FRAME = [0.24, 0.25, 0.28];
    const PAD = [0.55, 0.13, 0.11];
    const SNOW = [1.16, 1.18, 1.22];
    // grip + hanger
    boxAt(gb, new THREE.Vector3(0, -0.22, 0), new THREE.Vector3(0.42, 0.30, 0.30), 0, [0.18, 0.19, 0.21]);
    strut(gb, new THREE.Vector3(0, -0.30, 0), new THREE.Vector3(0, -2.35, 0), 0.055, FRAME);
    // seat carriage
    strut(gb, new THREE.Vector3(-1.05, -2.35, 0), new THREE.Vector3(1.05, -2.35, 0), 0.05, FRAME);
    for (const sx of [-0.95, -0.32, 0.32, 0.95]) {
      strut(gb, new THREE.Vector3(sx, -2.35, 0), new THREE.Vector3(sx, -2.86, -0.12), 0.035, FRAME);
    }
    // seat pad + back
    boxAt(gb, new THREE.Vector3(0, -2.92, -0.02), new THREE.Vector3(2.14, 0.11, 0.52), 0, PAD);
    boxAt(gb, new THREE.Vector3(0, -2.66, 0.28), new THREE.Vector3(2.14, 0.60, 0.09), 0, PAD);
    // snow on the seat
    boxAt(gb, new THREE.Vector3(0, -2.855, -0.02), new THREE.Vector3(2.05, 0.05, 0.44), 0, SNOW);
    // safety bar
    strut(gb, new THREE.Vector3(-1.02, -2.40, -0.55), new THREE.Vector3(1.02, -2.40, -0.55), 0.035, FRAME);
    strut(gb, new THREE.Vector3(-1.02, -2.40, -0.55), new THREE.Vector3(-1.02, -2.62, -0.10), 0.030, FRAME);
    strut(gb, new THREE.Vector3(1.02, -2.40, -0.55), new THREE.Vector3(1.02, -2.62, -0.10), 0.030, FRAME);
    // footrest
    boxAt(gb, new THREE.Vector3(0, -2.62, -0.60), new THREE.Vector3(2.0, 0.06, 0.16), 0, FRAME);
    return gb.geo();
  }

  // ------------------------------------------------------ poles / gates / net
  function buildMarkerPole() {
    const gb = new GB();
    const H = 3.0;
    const seg = 7;
    const NR = 16;
    // Banded like a real piste marker: bare fibreglass at the foot, orange
    // shaft, two reflective bands. Sixteen rings so the band edges are sharp
    // instead of a smooth orange-to-white gradient down a plastic dowel.
    const bandOf = (t) => (
      t < 0.10 ? [0.30, 0.31, 0.34]
        : (t > 0.50 && t < 0.565) || (t > 0.74 && t < 0.805) ? [0.94, 0.95, 0.97]
          : [0.96, 0.30, 0.05]);
    const ring = [];
    for (let i = 0; i <= NR; i++) {
      const t = i / NR;
      const y = -0.35 + H * t;
      const r = 0.085 - 0.022 * t;
      const col = bandOf(t);
      const row = [];
      for (let k = 0; k < seg; k++) {
        const th = (k / seg) * Math.PI * 2;
        const nx = Math.cos(th), nz = Math.sin(th);
        row.push(gb.v(nx * r, y, nz * r, nx, 0.1, nz, 0.5, 0.5,
          col[0], col[1], col[2], t * t, r));
      }
      ring.push(row);
    }
    for (let i = 0; i < NR; i++) {
      for (let k = 0; k < seg; k++) {
        const k2 = (k + 1) % seg;
        gb.quad(ring[i][k], ring[i][k2], ring[i + 1][k2], ring[i + 1][k]);
      }
    }
    // reflective collars
    boxAt(gb, new THREE.Vector3(0, 2.32, 0), new THREE.Vector3(0.155, 0.15, 0.155), 0, [0.05, 0.05, 0.06]);
    boxAt(gb, new THREE.Vector3(0, 1.62, 0), new THREE.Vector3(0.155, 0.13, 0.155), 0, [0.90, 0.91, 0.94]);
    // Snow collar at the base, standing proud of the surface. The old one sat
    // entirely below y = 0 and was simply buried, so the pole met the snow on
    // a hard line with nothing bedding it in.
    {
      const n = 16, R = 0.62;
      const c = gb.v(0, 0.09, 0, 0, 1, 0, 0.5, 0.5, 1.16, 1.18, 1.22, 0);
      const mid = [], rim = [];
      for (let k = 0; k < n; k++) {
        const th = (k / n) * Math.PI * 2;
        const cx2 = Math.cos(th), cz2 = Math.sin(th);
        const w2 = R * (0.82 + 0.34 * vnoise2(k * 2.1, 3.3));
        mid.push(gb.v(cx2 * w2 * 0.45, -0.02, cz2 * w2 * 0.45,
          cx2 * 0.34, 0.94, cz2 * 0.34, 0.5, 0.5, 1.15, 1.17, 1.22, 0));
        // rim well below grade, so a tilted pole never lifts one side of the
        // collar clear of the snow and turns it into a spade blade
        rim.push(gb.v(cx2 * w2, -0.30, cz2 * w2,
          cx2 * 0.14, 0.99, cz2 * 0.14, 0.5, 0.5, 1.12, 1.14, 1.20, 0));
      }
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        gb.tri(c, mid[k2], mid[k]);
        gb.quad(mid[k], mid[k2], rim[k2], rim[k]);
      }
    }
    return gb.geo();
  }

  function buildProps() {
    // --- piste marker poles, both edges of the corridor -------------------
    const poleGeo = buildMarkerPole();
    const poles = new Pool(poleGeo, matPaint, 460, { castShadow: true, name: 'markers' });
    group.add(poles.mesh);
    const rn = mulberry32(0x9911);
    for (let z = LIFT_Z1; z > LIFT_Z0; z -= 24) {
      const cx = corridorX(z);
      for (const sgn of [-1, 1]) {
        const off = sgn * (38 + rn() * 5);
        const x = cx + off + (rn() - 0.5) * 3;
        const zz = z + (rn() - 0.5) * 5;
        const y = terrain.height(x, zz);
        _q.setFromEuler(new THREE.Euler((rn() - 0.5) * 0.07, rn() * 6.28, (rn() - 0.5) * 0.07));
        _m.compose(_pos.set(x, y, zz), _q, _scl.set(1, 0.92 + rn() * 0.2, 1));
        _col.setRGB(1, 1, 1);
        poles.add(_m, _col);
      }
    }
    poles.flush();

    // --- fan guns on the piste edge ---------------------------------------
    // Nothing says "managed ski area" faster than a row of snow cannons.
    {
      const gb = new GB();
      const rc = mulberry32(0x7c01);
      const BODY = [0.72, 0.74, 0.78];
      const DARK = [0.16, 0.17, 0.19];
      const ACC = [0.06, 0.32, 0.62];
      let i = 0;
      for (let z = LIFT_Z1 - 120; z > LIFT_Z0 + 120; z -= 205) {
        const cx = corridorX(z);
        const sgn = (i++ % 2 === 0) ? 1 : -1;
        const x = cx + sgn * (PISTE_HALF - 5 + rc() * 6);
        const y = terrain.height(x, z);
        const yaw = -sgn * (0.7 + rc() * 0.5) + Math.PI;
        const base = new THREE.Vector3(x, y, z);

        // plinth + mast
        boxAt(gb, new THREE.Vector3(x, y - 0.15, z), new THREE.Vector3(1.5, 0.7, 1.5), yaw, [0.44, 0.45, 0.46]);
        strut(gb, base.clone().setY(y + 0.2), base.clone().setY(y + 3.4), 0.16, DARK, CYL8);
        // yoke
        const hub = new THREE.Vector3(x, y + 3.55, z);
        boxAt(gb, hub, new THREE.Vector3(0.7, 0.5, 0.5), yaw, DARK);
        // barrel, tilted up along the throw direction
        const fx = Math.sin(yaw), fz = Math.cos(yaw);
        const tilt = 0.42;
        const back = hub.clone().addScaledVector(new THREE.Vector3(-fx, -Math.sin(tilt), -fz), 0.95);
        const mouth = hub.clone().addScaledVector(new THREE.Vector3(fx, Math.sin(tilt), fz), 1.35);
        strut(gb, back, mouth, 0.52, BODY, CYL8);
        strut(gb, mouth, mouth.clone().addScaledVector(new THREE.Vector3(fx, Math.sin(tilt), fz), 0.16), 0.62, ACC, CYL8);
        // nozzle ring
        const ring = new THREE.TorusGeometry(0.52, 0.06, 4, 12);
        _qq.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(fx, Math.sin(tilt), fz).normalize());
        _mm.compose(mouth, _qq, new THREE.Vector3(1, 1, 1));
        gb.add(ring, _mm, DARK);
        ring.dispose();
        // compressor box + hydrant
        boxAt(gb, new THREE.Vector3(x + fz * 1.3, y + 0.45, z - fx * 1.3),
          new THREE.Vector3(1.1, 0.9, 0.8), yaw, ACC);
        strut(gb, new THREE.Vector3(x - fz * 1.1, y - 0.2, z + fx * 1.1),
          new THREE.Vector3(x - fz * 1.1, y + 0.9, z + fx * 1.1), 0.11, [0.85, 0.22, 0.06]);
      }
      const mesh = new THREE.Mesh(gb.geo(), matPaint);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'snow-guns';
      group.add(mesh);
    }

    // --- slalom course ----------------------------------------------------
    // The old gate was a 5.2 m panel hovering 1.18 m up on 11 cm poles that
    // aliased out entirely past ~25 m — it read as a HUD element that had
    // leaked into the world. Now: a 2.4 m panel, poles thick enough to survive
    // the width floor, each bedded in a snow collar, the whole gate turned to
    // face the fall line, and the panel's lower edge sagging like real fabric.
    {
      const gb = new GB();
      const rg = mulberry32(0x2244);
      let n = 0;
      for (let z = 520; z > 60; z -= 46) {
        const cx = corridorX(z);
        const side = (n % 2 === 0) ? 1 : -1;
        const red = n % 2 === 0;
        const col = red ? [0.66, 0.10, 0.10] : [0.10, 0.19, 0.58];
        const gx = cx + side * (13 + rg() * 8);
        const gw = 1.2;
        // face down the fall line: the corridor centreline's local heading
        const yaw = Math.atan2(corridorX(z + 8) - corridorX(z - 8), 16);
        const ax = Math.cos(yaw), az = Math.sin(yaw);
        const feet = [];
        for (const dx of [-1, 1]) {
          const px = gx + ax * dx * gw, pz = z - az * dx * gw + (rg() - 0.5) * 1.2;
          const y = terrain.height(px, pz);
          const tilt = (rg() - 0.5) * 0.14;
          feet.push([px, y, pz]);
          strut(gb, new THREE.Vector3(px, y - 0.35, pz),
            new THREE.Vector3(px + tilt * 1.9, y + 1.90, pz + tilt), 0.10, col);
          // snow collar, so the pole is bedded rather than inserted
          const nS = 7, R = 0.34;
          const c0 = gb.v(px, y + 0.04, pz, 0, 1, 0, 0.5, 0.5, 1.16, 1.18, 1.22, 0);
          const rr = [];
          for (let k = 0; k < nS; k++) {
            const th = (k / nS) * Math.PI * 2;
            rr.push(gb.v(px + Math.cos(th) * R, y - 0.24, pz + Math.sin(th) * R,
              Math.cos(th) * 0.4, 0.92, Math.sin(th) * 0.4, 0.5, 0.5, 1.15, 1.17, 1.21, 0));
          }
          for (let k = 0; k < nS; k++) gb.tri(c0, rr[(k + 1) % nS], rr[k]);
        }
        // panel: four horizontal bands (white / colour / colour / white) so the
        // banner reads as printed fabric rather than a vertical gradient, with
        // a slight catenary droop along its length
        const yTop = Math.min(feet[0][1], feet[1][1]) + 1.72;
        const hP = 0.72, sag = 0.09;
        const NS = 5, NB = 4;
        const bandCol = [[0.93, 0.94, 0.96], col, col, [0.93, 0.94, 0.96]];
        const grid = [];
        for (let r2 = 0; r2 <= NB; r2++) {
          const row = [];
          for (let k = 0; k <= NS; k++) {
            const t = k / NS;
            const px = lerp(feet[0][0], feet[1][0], t);
            const pz = lerp(feet[0][2], feet[1][2], t);
            const droop = sag * 4 * t * (1 - t) * (r2 / NB);
            const cc = bandCol[Math.min(NB - 1, r2)];
            row.push(gb.v(px, yTop - (r2 / NB) * hP - droop, pz,
              -az, 0.12, -ax, 0.5, 0.5, cc[0], cc[1], cc[2], 0));
          }
          grid.push(row);
        }
        for (let r2 = 0; r2 < NB; r2++) {
          for (let k = 0; k < NS; k++) {
            gb.quad(grid[r2][k], grid[r2][k + 1], grid[r2 + 1][k + 1], grid[r2 + 1][k]);
            gb.quad(grid[r2 + 1][k], grid[r2 + 1][k + 1], grid[r2][k + 1], grid[r2][k]);
          }
        }
        n++;
      }
      const mesh = new THREE.Mesh(gb.geo(), matPaint);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'slalom';
      group.add(mesh);
    }

    // --- B-net safety fencing --------------------------------------------
    {
      const post = new GB();
      const net = new GB();
      const runs = [
        { sgn: 1, z0: 560, z1: 300 },
        { sgn: -1, z0: 120, z1: -170 },
        { sgn: 1, z0: -420, z1: -640 },
      ];
      const PANEL = 6.0, HGT = 2.05;
      for (const r of runs) {
        const steps = Math.round(Math.abs(r.z1 - r.z0) / PANEL);
        const nodes = [];
        for (let i = 0; i <= steps; i++) {
          const z = lerp(r.z0, r.z1, i / steps);
          const x = corridorX(z) + r.sgn * 54;
          nodes.push(new THREE.Vector3(x, terrain.height(x, z), z));
        }
        for (let i = 0; i <= steps; i++) {
          const p = nodes[i];
          strut(post, new THREE.Vector3(p.x, p.y - 0.4, p.z),
            new THREE.Vector3(p.x - r.sgn * 0.20, p.y + HGT, p.z), 0.055, [0.10, 0.11, 0.13]);
          // back stay
          strut(post, new THREE.Vector3(p.x - r.sgn * 0.18, p.y + HGT * 0.82, p.z),
            new THREE.Vector3(p.x + r.sgn * 1.5, p.y - 0.15, p.z), 0.032, [0.10, 0.11, 0.13]);
        }
        for (let i = 0; i < steps; i++) {
          const a = nodes[i], b = nodes[i + 1];
          const sag = 0.12;
          const q0 = [0.98, 0.98, 0.98];
          const ua = i * 1.0, ub = (i + 1) * 1.0;
          const v0 = net.v(a.x, a.y - 0.25, a.z, 1, 0.15, 0, ua, 0, ...q0, 0);
          const v1 = net.v(b.x, b.y - 0.25, b.z, 1, 0.15, 0, ub, 0, ...q0, 0);
          const v2 = net.v(b.x - r.sgn * 0.2, b.y + HGT - sag, b.z, 1, 0.15, 0, ub, 1, ...q0, 0);
          const v3 = net.v(a.x - r.sgn * 0.2, a.y + HGT - sag, a.z, 1, 0.15, 0, ua, 1, ...q0, 0);
          net.quad(v0, v1, v2, v3);
        }
      }
      const pm = new THREE.Mesh(post.geo(), matPaint);
      pm.castShadow = true; pm.receiveShadow = true; pm.name = 'bnet-posts';
      const nm = new THREE.Mesh(net.geo(), matNet);
      nm.castShadow = false; nm.receiveShadow = true; nm.name = 'bnet';
      group.add(pm, nm);
    }
  }

  // =========================================================================
  // Resort buildings — mid-station, huts, restaurant, valley village
  // =========================================================================
  /**
   * One alpine building: stone plinth, dark timber walls, a glazed band, a
   * pitched roof under a full snow load with an overhanging eave, and lit
   * windows. `o.w`/`o.d` are half extents across and along the ridge.
   *
   * Everything about a ski area that is not the snow is a BUILDING, and the
   * acceptance gate's fastest read on the frame was that ours had none — one
   * lift line and nothing else on a whole mountain.
   */
  function hutAt(gb, cx, cz, gy0, yaw, o) {
    const px2 = Math.cos(yaw), pz2 = -Math.sin(yaw);
    const fx2 = Math.sin(yaw), fz2 = Math.cos(yaw);
    // Floor level from the four corners, not from the centre: on a 13 deg piste
    // an 8 x 12 m footprint spans 3 m of fall, and a hut placed on the centre
    // height has its whole uphill wall buried — measured, the first build put
    // 90% of the restaurant under the snow and it read as a beached hull.
    let hi = -1e9, lo = 1e9;
    for (const sa of [-1, 1]) {
      for (const sc of [-1, 1]) {
        const a = sa * o.w * 1.15, c = sc * o.d * 1.15;
        const h = terrain.height(cx + px2 * a + fx2 * c, cz + pz2 * a + fz2 * c);
        if (h > hi) hi = h;
        if (h < lo) lo = h;
      }
    }
    void gy0;
    const gy = hi + 0.3;
    const foot = Math.max(2.2, gy - lo + 1.8);
    const mk = (a, y, c, col) => gb.v(
      cx + px2 * a + fx2 * c, y, cz + pz2 * a + fz2 * c,
      0, 1, 0, ...uvSnow(0.5 + a * 0.04, 0.5 + c * 0.03), col[0], col[1], col[2], 0);
    const W = o.w, D = o.d, H = o.h;
    const GLASS = [0.09, 0.12, 0.16];
    const WARM = [1.30, 0.86, 0.42];

    // ------------------------------------------------------- per-instance --
    // A village of clones reads as instancing, so every hut draws its own
    // board pitch, board direction, timber tone, weathering depth, plinth
    // material and window rhythm out of a hash of where it stands. Nothing
    // here is a global constant.
    const hk = mulberry32((((cx * 7919) | 0) ^ ((cz * 104729) | 0) ^ 0x51c0) >>> 0);
    const lo0 = o.lowDetail === true;
    const vertBoards = hk() < 0.44;
    const boardH = 0.30 + 0.26 * hk();            // course pitch, metres
    const weather = 0.5 + 0.5 * hk();             // sun-bleaching at the head
    const boardSeed = ((hk() * 4294967296) | 0);  // this hut's plank tone run
    const wallK = 0.80 + 0.45 * hk();             // timber tone
    // Slightly up on the old 0.17: weathered larch in full alpine sun is dark
    // but it is not black, and at 150 m a wall below ~0.15 albedo cannot show
    // any of the coursing put on it no matter how it is modelled.
    const WALL = (o.wall || [0.215, 0.178, 0.146]).map((v) => v * wallK);
    const STONE = hk() < 0.45
      ? [0.44, 0.43, 0.42]                        // render
      : [0.33, 0.31, 0.30];                       // rubble masonry
    // Timber weathers TWO ways at once and both are needed. The bottom metre is
    // in the splash zone all winter and goes near-black; everything above the
    // eave shadow is UV-bleached to a silver grey. A wall that is one tone from
    // ground to eave is the thing that reads as untextured, not the absence of
    // a bitmap.
    const BLEACH = [0.40, 0.385, 0.355];
    // Shutter paint. Barn red is the overwhelming majority in the eastern Alps,
    // then green, then the odd unpainted one.
    const SHUTTER = [[0.62, 0.09, 0.07], [0.62, 0.09, 0.07], [0.10, 0.24, 0.14],
      [0.44, 0.38, 0.30], [0.16, 0.22, 0.42]][(hk() * 5) | 0];

    /**
     * A clad wall face, emitted as courses of boards.
     *
     * This is deliberately geometry and vertex colour rather than a texture
     * map. At the 110-190 m the hero framings put these buildings at, a wall is
     * 30-70 px: what has to happen there is that the SUN models it, and a
     * bitmap on a flat quad cannot do that — every board would carry the same
     * N.L as the wall behind it. Each course is a five-row bevel instead, with
     * its normal swung from tilted-down at the seam through flat to tilted-up
     * at the lip, so the seam line is a real shadow that moves with the sun and
     * the lip is a real highlight. It costs ~1.5k triangles on the restaurant
     * and it survives to the last pixel the building has.
     *
     * (a0,c0)-(a1,c1) is the plan extent, (na,nc) the outward plan normal.
     */
    const PROF = lo0
      ? [[0.00, -0.7, 0.52], [0.50, 0.10, 1.08], [1.00, 0.5, 0.84]]
      : [[0.00, -0.85, 0.44], [0.18, -0.30, 0.88], [0.56, 0.10, 1.10],
        [0.88, 0.50, 1.02], [1.00, 0.66, 0.70]];

    function boardFace(a0, c0, a1, c1, yLo, yHi, na, nc, col, opt = {}) {
      const dA = a1 - a0, dC = c1 - c0;
      const len = Math.hypot(dA, dC), hgt = yHi - yLo;
      if (len < 0.06 || hgt < 0.06) return;
      const pitch = opt.pitch || boardH;
      const vert = opt.vert === undefined ? vertBoards : opt.vert;
      const nB = clamp(Math.round((vert ? len : hgt) / pitch), 2, lo0 ? 3 : 12);
      // MEASURED, twice. 1. Nothing in a course varies ALONG the face, so
      // subdividing that axis bought nothing but triangles — with up to five
      // segments the buildings mesh ran 104k triangles against a baseline of
      // 19k, and that mesh is `frustumCulled = false`, so all of it is
      // submitted to the main pass AND every shadow cascade every frame. One
      // segment renders identically.
      const nS = 1;
      // outward plan normal in world, and the along-face tangent it tilts about
      const bx = px2 * na + fx2 * nc, bz = pz2 * na + fz2 * nc;
      const tx = (px2 * dA + fx2 * dC) / len, tz = (pz2 * dA + fz2 * dC) / len;
      const push = opt.push || 0.0;
      // 2. ...and every quad was emitted with both windings as insurance. The
      // winding is determined: the quad's geometric normal is the traversal
      // tangent crossed with the seam axis, so compare that with the outward
      // plan normal once and emit the front face only.
      const flip = ((-tz * bx + tx * bz) < 0) !== vert;

      for (let b = 0; b < nB; b++) {
        const rows = [];
        for (let p = 0; p < PROF.length; p++) {
          const [f, tilt, ptone] = PROF[p];
          const q = (b + f) / nB;                       // 0..1 across the seams
          const row = [];
          // one board is one plank off one log: its tone is its own
          const bt = 0.86 + 0.30 * ((((b + 1) * 1103515245 + boardSeed) >>> 9 & 255) / 255);
          for (let s2 = 0; s2 <= nS; s2++) {
            const t2 = s2 / nS;
            const u = vert ? q : t2;
            const v = vert ? t2 : q;
            const ax = a0 + dA * u, cc = c0 + dC * u;
            const y = yLo + hgt * v;
            // height above the snow line drives both weathering terms
            const hv = (y - gy) / Math.max(1.0, H);
            const damp = 1 - 0.50 * smoothstep(0.18, -0.02, hv);
            const bl = 0.36 * weather * smoothstep(0.28, 1.02, hv);
            const k = ptone * bt * damp;
            const nx2 = vert ? bx + tx * tilt : bx;
            const nz2 = vert ? bz + tz * tilt : bz;
            const ny2 = vert ? 0.05 : tilt;
            row.push(gb.v(
              cx + px2 * ax + fx2 * cc + bx * push, y, cz + pz2 * ax + fz2 * cc + bz * push,
              nx2, ny2, nz2, ...uvSnow(0.5, 0.5),
              lerp(col[0] * k, BLEACH[0] * k, bl),
              lerp(col[1] * k, BLEACH[1] * k, bl),
              lerp(col[2] * k, BLEACH[2] * k, bl), 0));
          }
          rows.push(row);
        }
        for (let p = 0; p < PROF.length - 1; p++) {
          for (let s2 = 0; s2 < nS; s2++) {
            if (flip) gb.quad(rows[p + 1][s2], rows[p + 1][s2 + 1], rows[p][s2 + 1], rows[p][s2]);
            else gb.quad(rows[p][s2], rows[p][s2 + 1], rows[p + 1][s2 + 1], rows[p + 1][s2]);
          }
        }
      }
    }

    /**
     * A flat panel lying on a wall plane, pushed proud of it. Two triangles per
     * side against a box's twelve — and a window surround is 30-60 openings per
     * hut, so the difference is the whole triangle budget of the buildings mesh.
     */
    function panel(a, c, na, nc, hw, hh, yMid, push, col, tiltY) {
      const ax = Math.abs(na) > 0.5;
      const ua = ax ? 0 : 1, uc = ax ? 1 : 0;
      const bx = px2 * na + fx2 * nc, bz = pz2 * na + fz2 * nc;
      const V = (du, dv) => {
        const aa = a + ua * du * hw + na * push;
        const cc2 = c + uc * du * hw + nc * push;
        return gb.v(cx + px2 * aa + fx2 * cc2, yMid + dv * hh, cz + pz2 * aa + fz2 * cc2,
          bx, tiltY || 0, bz, ...uvSnow(0.5, 0.5), col[0], col[1], col[2], 0);
      };
      const p0 = V(-1, -1), p1 = V(1, -1), p2 = V(1, 1), p3 = V(-1, 1);
      gb.quad(p0, p1, p2, p3); gb.quad(p3, p2, p1, p0);
    }

    /** A window that has a hole in the wall behind it, not a panel stuck on. */
    function windowAt(a, c, na, nc, halfW, halfH, yMid, lit) {
      const P = (aa, yy, ccc) => new THREE.Vector3(
        cx + px2 * aa + fx2 * ccc, yy, cz + pz2 * aa + fz2 * ccc);
      const inA = na * 0.16, inC = nc * 0.16;
      const FR = [0.44, 0.38, 0.30], REV = [0.055, 0.05, 0.055];
      const ax = Math.abs(na) > 0.5;
      const sz = (t, hh, ww) => (ax
        ? new THREE.Vector3(t, hh, ww) : new THREE.Vector3(ww, hh, t));
      // reveal: the wall is 32 cm thick and the glass sits at the back of it,
      // so the head and the jamb throw a real shadow across the pane. This one
      // stays a box, because the depth IS the point.
      boxAt(gb, P(a - inA * 0.5, yMid, c - inC * 0.5),
        sz(0.34, halfH * 2, halfW * 2), yaw, REV);
      panel(a, c, na, nc, halfW * 0.9, halfH * 0.9, yMid, -0.20, lit ? WARM : GLASS);
      if (lo0) return;
      // surround: head, sill and two jambs, proud of the cladding
      const pr = 0.08;
      panel(a, c, na, nc, halfW * 1.16, 0.075, yMid + halfH, pr, FR, 0.5);
      panel(a, c, na, nc, halfW * 1.24, 0.065, yMid - halfH, pr * 1.7, [0.50, 0.44, 0.35], -0.6);
      for (const sg of [-1, 1]) {
        const ja = a + (ax ? 0 : sg * halfW * 1.08), jc = c + (ax ? sg * halfW * 1.08 : 0);
        panel(ja, jc, na, nc, 0.07, halfH, yMid, pr, FR);
      }
      // Shutters, folded back against the cladding on both sides.
      //
      // Put here off a blind A/B against a photograph of the Berghaus Jochpass
      // scaled to the same 150 px the hero framing gives our lodge. The thing
      // that read as "photograph" at that size was not the timber, the roof or
      // the geometry — it was a REGULAR GRID OF SATURATED RECTANGLES. A hut
      // with painted shutters carries a repeating red accent at ~1 m pitch,
      // and there is nothing else on an alpine building with that much local
      // chroma contrast. Ours had none, and read as a monochrome shed.
      for (const sg of [-1, 1]) {
        const sa = a + (ax ? 0 : sg * halfW * 1.55), sc = c + (ax ? sg * halfW * 1.55 : 0);
        panel(sa, sc, na, nc, halfW * 0.42, halfH * 0.98, yMid, pr * 1.5, SHUTTER);
      }
    }

    // ---- plinth, carried down to the lowest corner ------------------------
    boxAt(gb, new THREE.Vector3(cx, gy - foot * 0.5, cz),
      new THREE.Vector3(W * 2.14, foot, D * 2.14), yaw, STONE);
    // ...and clad it, with a coarse course pitch and always horizontal: a
    // rubble plinth is not boarded, and the same emitter gives it the coursing.
    // MEASURED: the village is 34 huts 1.5 km down the valley at ~12 px each,
    // and it was carrying 53k of the buildings mesh's 104k triangles for
    // coursing four orders of magnitude below a pixel. Everything below a wall
    // is skipped there.
    if (!lo0) {
      for (const sg of [-1, 1]) {
        boardFace(sg * W * 1.07, -D * 1.07, sg * W * 1.07, D * 1.07,
          gy - Math.min(foot, 2.6), gy + 0.05, sg, 0, STONE,
          { vert: false, pitch: 0.62, push: 0.012 });
        boardFace(-W * 1.07, sg * D * 1.07, W * 1.07, sg * D * 1.07,
          gy - Math.min(foot, 2.6), gy + 0.05, 0, sg, STONE,
          { vert: false, pitch: 0.62, push: 0.012 });
      }
    }

    // ---- walls -------------------------------------------------------------
    boxAt(gb, new THREE.Vector3(cx, gy + H * 0.5, cz), new THREE.Vector3(W * 2, H, D * 2), yaw, WALL);
    for (const sg of [-1, 1]) {
      boardFace(sg * W, -D, sg * W, D, gy - 0.15, gy + H, sg, 0, WALL, { push: 0.02 });
      boardFace(-W, sg * D, W, sg * D, gy - 0.15, gy + H, 0, sg, WALL, { push: 0.02 });
    }
    // corner boards: an alpine hut has a vertical board over every arris, and
    // it is the thing that stops the box reading as an extruded rectangle
    if (!lo0) {
      for (const sa of [-1, 1]) {
        for (const sc of [-1, 1]) {
          boxAt(gb, new THREE.Vector3(cx + px2 * sa * W + fx2 * sc * D, gy + H * 0.5,
            cz + pz2 * sa * W + fz2 * sc * D),
          new THREE.Vector3(0.30, H, 0.30), yaw, [WALL[0] * 1.5, WALL[1] * 1.5, WALL[2] * 1.5]);
        }
      }
    }
    // Snow banked against the foot of each wall, sampled at THAT wall rather
    // than at the floor level. A single slab at `gy` (which is the highest
    // corner) floats several metres clear of the ground on the downhill side
    // of a hut standing on a 13 deg piste, and reads as a white shelf hanging
    // off a cliff — which is exactly what the first cut of this did.
    for (const [na, nc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = na * W * 1.08, cc2 = nc * D * 1.08;
      const wx = cx + px2 * ax + fx2 * cc2, wz = cz + pz2 * ax + fz2 * cc2;
      boxAt(gb, new THREE.Vector3(wx, terrain.height(wx, wz) + 0.15, wz),
        new THREE.Vector3(na ? 1.0 : W * 2.3, 0.34, na ? D * 2.3 : 1.0), yaw,
        [1.06, 1.09, 1.16]);
    }
    // a paler timber band under the eaves reads as a first floor at distance
    const BAND = [0.42, 0.35, 0.27];
    boxAt(gb, new THREE.Vector3(cx, gy + H * 0.86, cz),
      new THREE.Vector3(W * 2.03, H * 0.20, D * 2.03), yaw, BAND);
    if (!lo0) {
      for (const sg of [-1, 1]) {
        boardFace(sg * W * 1.015, -D * 1.015, sg * W * 1.015, D * 1.015,
          gy + H * 0.76, gy + H * 0.96, sg, 0, BAND,
          { vert: true, pitch: 0.34, push: 0.008 });
        boardFace(-W * 1.015, sg * D * 1.015, W * 1.015, sg * D * 1.015,
          gy + H * 0.76, gy + H * 0.96, 0, sg, BAND,
          { vert: true, pitch: 0.34, push: 0.008 });
      }
    }

    // ---- balcony -----------------------------------------------------------
    // The one feature that makes a box read as an alpine building at 150 m,
    // because it is a horizontal band of deep shadow under a bright snow line
    // and it breaks the silhouette. Three quarters of the huts get one, on a
    // side the hash picks.
    if (!lo0 && hk() < 0.78) {
      const bs = hk() < 0.5 ? 1 : -1;
      const by = gy + H * 0.63;
      const bo = 0.95;
      const pw = W + bo;
      const P = (aa, yy, cc2) => new THREE.Vector3(
        cx + px2 * aa + fx2 * cc2, yy, cz + pz2 * aa + fz2 * cc2);
      // slab; its soffit is the shadow
      boxAt(gb, P(bs * (W + bo * 0.5), by, 0),
        new THREE.Vector3(bo, 0.16, D * 1.86), yaw, [0.24, 0.20, 0.16]);
      // boarded parapet, then the rail, then the snow that sits on the rail
      boardFace(bs * pw, -D * 0.93, bs * pw, D * 0.93, by + 0.08, by + 0.90, bs, 0,
        [0.26, 0.21, 0.17], { vert: true, pitch: 0.13 });
      boxAt(gb, P(bs * pw, by + 0.94, 0),
        new THREE.Vector3(0.16, 0.11, D * 1.9), yaw, [0.44, 0.37, 0.29]);
      boxAt(gb, P(bs * pw, by + 1.03, 0),
        new THREE.Vector3(0.20, 0.07, D * 1.9), yaw, [1.10, 1.13, 1.20]);
      // brackets carrying it
      for (const t of [-0.72, 0, 0.72]) {
        strut(gb, P(bs * W, by - 0.02, t * D), P(bs * pw, by - 0.62, t * D),
          0.075, [0.20, 0.17, 0.14], CYL8);
      }
    }

    // ---- woodpile ----------------------------------------------------------
    // Split larch stacked against the gable. At range it is a rectangle of
    // hard light/dark striping, which is exactly the kind of detail a flat
    // untextured wall was missing.
    if (!lo0 && hk() < 0.7) {
      const ws = hk() < 0.5 ? 1 : -1;
      const wl = Math.min(W * 1.3, 3.4), wh = 1.5 + 0.7 * hk();
      boxAt(gb, new THREE.Vector3(cx + fx2 * ws * (D + 0.42), gy + wh * 0.5, cz + fz2 * ws * (D + 0.42)),
        new THREE.Vector3(wl * 2, wh, 0.84), yaw, [0.30, 0.22, 0.15]);
      boardFace(-wl, ws * (D + 0.84), wl, ws * (D + 0.84), gy, gy + wh, 0, ws,
        [0.40, 0.30, 0.20], { vert: true, pitch: 0.17, push: 0.01 });
      // snow capping the stack
      boxAt(gb, new THREE.Vector3(cx + fx2 * ws * (D + 0.42), gy + wh + 0.09,
        cz + fz2 * ws * (D + 0.42)),
      new THREE.Vector3(wl * 2.06, 0.20, 0.94), yaw, [1.10, 1.13, 1.20]);
    }

    // ---- windows -----------------------------------------------------------
    // Storeys, not "a window band". A 6.6 m alpine restaurant is two floors and
    // photographs as two rows of shuttered openings; one row at mid height read
    // as a slot cut in a shed.
    const nWin = Math.max(2, Math.round(D * (0.55 + 0.35 * hk())));
    const winH = H * (0.105 + 0.035 * hk());
    const rows = (!lo0 && H > 5.0) ? [0.36, 0.68] : [0.50 + 0.10 * hk()];
    for (let r2 = 0; r2 < rows.length; r2++) {
      const winY = gy + H * rows[r2];
      for (let i = 0; i < nWin; i++) {
        const c = -D * 0.72 + (i + 0.5) * (D * 1.44 / nWin);
        for (const sgn of [-1, 1]) {
          const lit = ((i * 7 + r2 * 4 + (sgn > 0 ? 3 : 0)) % 5) < 2;
          windowAt(sgn * W, c, sgn, 0, 0.42, winH, winY, lit);
        }
      }
      // and on the gable ends, so the short walls are not blank
      if (!lo0) {
        for (const sgn of [-1, 1]) {
          for (const off of [-D * 0, W * 0.44]) {
            windowAt(off * sgn, sgn * D, 0, sgn, 0.42, winH, winY,
              ((i2) => i2 % 5 < 2)(r2 * 3 + (sgn > 0 ? 1 : 0) + (off ? 2 : 0)));
          }
        }
      }
    }
    // The gable ABOVE the eave, in rows that shorten as the roof closes in.
    // Blind A/B again: on a real Berghaus the gable is the most decorated face
    // in the building — three or four storeys of shuttered openings stacked
    // into the apex — and it is also the face a downhill camera sees most of.
    // Ours was a blank triangle, and a blank triangle above a detailed wall is
    // the shape that reads as "modelled, not built".
    if (!lo0) {
      const eaveY2 = gy + H, rh2 = Math.max(o.roofH, W * 0.62);
      for (const gf of [0.24, 0.56]) {
        const hwA = W * (1 - gf) * 0.74;
        if (hwA < 0.9) continue;
        const n = clamp(Math.floor(hwA / 1.05), 1, 4);
        for (const sgn of [-1, 1]) {
          for (let i = 0; i < n; i++) {
            const off = n === 1 ? 0 : (-1 + (2 * i) / (n - 1)) * (hwA - 0.55);
            windowAt(off, sgn * D * 1.03, 0, sgn, 0.36, winH * 0.86,
              eaveY2 + rh2 * gf, ((i * 3 + (sgn > 0 ? 1 : 0)) % 4) < 1);
          }
        }
      }
    }

    // ---- roof --------------------------------------------------------------
    // Snow on a roof is not a flat plane of one white. It is wind-scoured thin
    // along the ridge, deepest at the eave where it creeps and hangs over, and
    // the underside of that overhang is lit only by the sky — which is the
    // "roof-edge snow depth in reflectance rather than only geometry" the gate
    // asked for, and the reason a real chalet roof has a bright line with a
    // blue line directly under it.
    {
      const eaveY = gy + H, ridgeY = gy + H + Math.max(o.roofH, W * 0.62);
      const ow = W * 1.14, ol = D * 1.10;
      const SEG = lo0 ? 4 : 9;
      const rk2 = 0.96 + 0.08 * hk();
      const SN = [1.22 * rk2, 1.24 * rk2, 1.30 * rk2];
      const SCOUR = [SN[0] * 0.84, SN[1] * 0.86, SN[2] * 0.93];   // ridge, thin
      const DEEP = [SN[0] * 1.05, SN[1] * 1.06, SN[2] * 1.07];    // eave, banked
      const LIP = [0.40, 0.47, 0.64];                             // sky-lit soffit
      const FASCIA = [0.15, 0.13, 0.11];
      for (const sgn of [-1, 1]) {
        // scalloped overhang: snow does not break off a roof in a straight line
        const over = [];
        for (let k = 0; k <= SEG; k++) {
          const t = k / SEG;
          over.push(0.10 + 0.26 * (0.5 + 0.5 * Math.sin(t * 11.3 + sgn * 2.1 + cz * 0.3)));
        }
        for (let k = 0; k < SEG; k++) {
          const t0 = k / SEG, t1 = (k + 1) / SEG;
          const c0 = -ol + 2 * ol * t0, c1 = -ol + 2 * ol * t1;
          const dr = 0.22 * Math.sin(Math.PI * t0), dr1 = 0.22 * Math.sin(Math.PI * t1);
          const a0 = mk(0, ridgeY, c0, SCOUR), a1 = mk(0, ridgeY, c1, SCOUR);
          const m0 = mk(sgn * ow * 0.55, lerp(ridgeY, eaveY, 0.55) - dr * 0.55, c0, SN);
          const m1 = mk(sgn * ow * 0.55, lerp(ridgeY, eaveY, 0.55) - dr1 * 0.55, c1, SN);
          const b0 = mk(sgn * ow, eaveY - dr, c0, DEEP), b1 = mk(sgn * ow, eaveY - dr1, c1, DEEP);
          // the lip: snow creeping past the fascia, then curling down
          const l0 = mk(sgn * (ow + over[k]), eaveY - dr - 0.10, c0, DEEP);
          const l1 = mk(sgn * (ow + over[k + 1]), eaveY - dr1 - 0.10, c1, DEEP);
          const u0 = mk(sgn * (ow + over[k] * 0.86), eaveY - dr - 0.30, c0, LIP);
          const u1 = mk(sgn * (ow + over[k + 1] * 0.86), eaveY - dr1 - 0.30, c1, LIP);
          const e0 = mk(sgn * ow * 1.02, eaveY - 0.52 - dr, c0, FASCIA);
          const e1 = mk(sgn * ow * 1.02, eaveY - 0.52 - dr1, c1, FASCIA);
          if (sgn > 0) {
            gb.quad(a0, a1, m1, m0); gb.quad(m0, m1, b1, b0);
            gb.quad(b0, b1, l1, l0); gb.quad(l0, l1, u1, u0); gb.quad(u0, u1, e1, e0);
          } else {
            gb.quad(a1, a0, m0, m1); gb.quad(m1, m0, b0, b1);
            gb.quad(b1, b0, l0, l1); gb.quad(l1, l0, u0, u1); gb.quad(u1, u0, e0, e1);
          }
        }
        // gable ends, so the roof is not a floating lid
        for (const cEnd of [-ol * 0.94, ol * 0.94]) {
          const g0 = mk(0, ridgeY, cEnd, WALL);
          const g1 = mk(sgn * W, eaveY, cEnd, WALL);
          const g2 = mk(sgn * W, gy + H * 0.9, cEnd, WALL);
          const g3 = mk(0, gy + H * 0.9, cEnd, WALL);
          gb.quad(g0, g1, g2, g3); gb.quad(g3, g2, g1, g0);
        }
      }
      // ridge cap: a drift sits along the apex and it is the top edge of the
      // whole silhouette
      boxAt(gb, new THREE.Vector3(cx, ridgeY + 0.10, cz),
        new THREE.Vector3(0.44, 0.22, ol * 1.98), yaw, [SN[0] * 1.04, SN[1] * 1.05, SN[2] * 1.07]);
      // snow-stop rails, two courses of them: every alpine roof over a door has
      // these and they are a hard horizontal accent across the white
      if (!lo0) {
        for (const sgn of [-1, 1]) {
          for (const f of [0.62, 0.86]) {
            const yy = lerp(ridgeY, eaveY, f) - 0.06;
            boxAt(gb, new THREE.Vector3(cx + px2 * sgn * ow * f, yy + 0.16, cz + pz2 * sgn * ow * f),
              new THREE.Vector3(0.09, 0.26, ol * 1.9), yaw, [0.26, 0.24, 0.22]);
          }
        }
      }
    }
    // chimney with its own snow cap
    if (o.chimney !== false) {
      const rh = Math.max(o.roofH, W * 0.62);
      const cxx = cx + px2 * W * 0.55 + fx2 * D * 0.4, czz = cz + pz2 * W * 0.55 + fz2 * D * 0.4;
      boxAt(gb, new THREE.Vector3(cxx, gy + H + rh * 0.75, czz),
        new THREE.Vector3(0.85, rh * 1.5 + 0.6, 0.85), yaw, [0.36, 0.35, 0.34]);
      boxAt(gb, new THREE.Vector3(cxx, gy + H + rh * 1.5 + 0.34, czz),
        new THREE.Vector3(1.05, 0.22, 1.05), yaw, [1.24, 1.26, 1.30]);
    }
    // terrace: a snow-covered deck with a rail, and parasols if it is the
    // restaurant. This is where a real mountain hut puts fifty people.
    if (o.deck) {
      const dx0 = px2 * (W + o.deck * 0.5), dz0 = pz2 * (W + o.deck * 0.5);
      // carried down to the snow on its own skirt: a 34 cm slab floating over a
      // falling slope reads as a shipping container parked next to the hut
      boxAt(gb, new THREE.Vector3(cx + dx0, gy - foot * 0.45, cz + dz0),
        new THREE.Vector3(o.deck * 0.92, foot, D * 1.8), yaw, [0.26, 0.22, 0.18]);
      boxAt(gb, new THREE.Vector3(cx + dx0, gy + 0.42, cz + dz0),
        new THREE.Vector3(o.deck, 0.34, D * 1.9), yaw, [0.34, 0.28, 0.22]);
      boxAt(gb, new THREE.Vector3(cx + dx0, gy + 0.62, cz + dz0),
        new THREE.Vector3(o.deck * 0.98, 0.10, D * 1.86), yaw, [1.20, 1.22, 1.28]);
      const nP = Math.max(3, Math.round(D * 1.6));
      for (let i = 0; i <= nP; i++) {
        const c = -D * 0.92 + (i / nP) * D * 1.84;
        const bx = cx + px2 * (W + o.deck) + fx2 * c, bz = cz + pz2 * (W + o.deck) + fz2 * c;
        strut(gb, new THREE.Vector3(bx, gy + 0.5, bz), new THREE.Vector3(bx, gy + 1.42, bz),
          0.055, [0.26, 0.21, 0.17]);
      }
      // top rail
      const r0 = new THREE.Vector3(cx + px2 * (W + o.deck) + fx2 * (-D * 0.92), gy + 1.40,
        cz + pz2 * (W + o.deck) + fz2 * (-D * 0.92));
      const r1 = new THREE.Vector3(cx + px2 * (W + o.deck) + fx2 * (D * 0.92), gy + 1.40,
        cz + pz2 * (W + o.deck) + fz2 * (D * 0.92));
      strut(gb, r0, r1, 0.05, [0.26, 0.21, 0.17]);
      // parasols / windbreak panels along the rail
      for (let i = 0; i < 3; i++) {
        const c = -D * 0.6 + i * D * 0.6;
        const bx = cx + px2 * (W + o.deck * 0.6) + fx2 * c, bz = cz + pz2 * (W + o.deck * 0.6) + fz2 * c;
        strut(gb, new THREE.Vector3(bx, gy + 0.6, bz), new THREE.Vector3(bx, gy + 2.9, bz),
          0.05, [0.22, 0.22, 0.24]);
        boxAt(gb, new THREE.Vector3(bx, gy + 3.0, bz), new THREE.Vector3(2.5, 0.16, 2.5),
          yaw + i, i & 1 ? [0.72, 0.14, 0.10] : [0.94, 0.94, 0.96]);
      }
    }
    // skis stuck upright in the snow by the door
    if (o.skis) {
      const rk = mulberry32(0x51c0 + (cz | 0));
      for (let i = 0; i < o.skis; i++) {
        const c = -D * 0.8 + rk() * D * 1.6;
        const bx = cx + px2 * (W + 1.6) + fx2 * c, bz = cz + pz2 * (W + 1.6) + fz2 * c;
        const tl = (rk() - 0.5) * 0.24;
        const col = [[0.86, 0.20, 0.10], [0.10, 0.30, 0.66], [0.90, 0.72, 0.10], [0.90, 0.92, 0.95]][(rk() * 4) | 0];
        strut(gb, new THREE.Vector3(bx, gy - 0.2, bz),
          new THREE.Vector3(bx + tl, gy + 1.7, bz + tl * 0.6), 0.035, col);
      }
    }
    // Floor level, for consumers that need to stand something on this hut's
    // deck. It is the four-corner maximum plus 0.3 and NOT terrain.height at
    // the centre — see the comment at the top of this function.
    return gy;
  }

  /**
   * A standing figure. Static, merged into the building mesh — the moving
   * riders are recycled around the player and can never be relied on to be
   * anywhere in particular, but the people standing outside a mountain
   * restaurant are always there, and they are what stops a hut reading as an
   * unoccupied box in the middle of a wilderness.
   */
  function figureAt(gb, cx, cz, yaw, jacket, tall) {
    const gy = terrain.height(cx, cz);
    const fx2 = Math.sin(yaw), fz2 = Math.cos(yaw);
    const px2 = Math.cos(yaw), pz2 = -Math.sin(yaw);
    const at = (a, y, c) => new THREE.Vector3(cx + px2 * a + fx2 * c, gy + y * tall, cz + pz2 * a + fz2 * c);
    const PANT = [0.15, 0.15, 0.18], DARK = [0.12, 0.12, 0.14], SKIN = [0.70, 0.54, 0.43];
    for (const s of [-1, 1]) {
      strut(gb, at(s * 0.13, 0.02, 0), at(s * 0.15, 0.48, 0.02), 0.085, PANT, CYL8);
      strut(gb, at(s * 0.15, 0.48, 0.02), at(s * 0.12, 0.92, -0.01), 0.10, PANT, CYL8);
      // arm
      strut(gb, at(s * 0.20, 1.36, 0.0), at(s * 0.28, 1.02, 0.10), 0.070, jacket, CYL8);
      // boot
      boxAt(gb, at(s * 0.14, 0.14, 0.02), new THREE.Vector3(0.15, 0.28, 0.32), yaw, DARK);
    }
    strut(gb, at(0, 0.94, -0.01), at(0, 1.40, 0.02), 0.195, jacket, CYL8);
    strut(gb, at(0, 1.42, 0.02), at(0, 1.50, 0.02), 0.07, SKIN, CYL8);
    const head = new THREE.IcosahedronGeometry(0.125 * tall, 1);
    _mm.compose(at(0, 1.60, 0.01), new THREE.Quaternion(), new THREE.Vector3(1, 1.05, 1.1));
    gb.add(head, _mm, DARK);
    head.dispose();
    // skis planted in the snow beside them
    strut(gb, at(0.55, -0.15, 0.1), at(0.60, 1.55, 0.16), 0.035, jacket, CYL);
  }

  /** A tracked piste groomer, parked. Reads instantly as "this is a ski area". */
  function groomerAt(gb, cx, cz, gy, yaw) {
    const fx2 = Math.sin(yaw), fz2 = Math.cos(yaw);
    const px2 = Math.cos(yaw), pz2 = -Math.sin(yaw);
    const at = (a, y, c) => new THREE.Vector3(cx + px2 * a + fx2 * c, gy + y, cz + pz2 * a + fz2 * c);
    const DARK = [0.07, 0.07, 0.08], BODY = [0.86, 0.32, 0.05], GLASS = [0.10, 0.13, 0.17];
    // tracks
    for (const sgn of [-1, 1]) {
      boxAt(gb, at(sgn * 1.15, 0.45, 0), new THREE.Vector3(0.86, 0.86, 4.6), yaw, DARK);
      boxAt(gb, at(sgn * 1.15, 0.45, 0), new THREE.Vector3(0.98, 0.40, 4.2), yaw, [0.13, 0.13, 0.14]);
    }
    // hull + cab
    boxAt(gb, at(0, 1.25, -0.2), new THREE.Vector3(2.5, 0.95, 3.5), yaw, BODY);
    boxAt(gb, at(0, 2.05, 0.15), new THREE.Vector3(2.2, 0.75, 1.8), yaw, GLASS);
    boxAt(gb, at(0, 2.48, 0.15), new THREE.Vector3(2.3, 0.16, 1.95), yaw, BODY);
    boxAt(gb, at(0, 2.66, 0.15), new THREE.Vector3(2.2, 0.10, 1.85), yaw, [1.16, 1.18, 1.24]);
    // beacon + work lamps
    boxAt(gb, at(0.7, 2.68, 0.15), new THREE.Vector3(0.22, 0.20, 0.22), yaw, [1.40, 0.55, 0.05]);
    boxAt(gb, at(-0.6, 2.62, 0.9), new THREE.Vector3(0.30, 0.18, 0.16), yaw, [1.35, 1.25, 0.90]);
    // front blade on its arms
    strut(gb, at(-0.9, 1.0, 1.6), at(-1.5, 0.75, 3.0), 0.12, DARK, CYL8);
    strut(gb, at(0.9, 1.0, 1.6), at(1.5, 0.75, 3.0), 0.12, DARK, CYL8);
    boxAt(gb, at(0, 0.95, 3.15), new THREE.Vector3(4.0, 1.1, 0.22), yaw, BODY);
    boxAt(gb, at(0, 0.44, 3.18), new THREE.Vector3(4.0, 0.20, 0.30), yaw, [0.72, 0.74, 0.78]);
    // rear tiller under its hood
    boxAt(gb, at(0, 0.72, -2.5), new THREE.Vector3(3.6, 0.70, 0.9), yaw, DARK);
    boxAt(gb, at(0, 1.18, -2.4), new THREE.Vector3(3.6, 0.24, 1.0), yaw, [0.66, 0.68, 0.70]);
    // exhaust
    strut(gb, at(-1.0, 1.7, -1.6), at(-1.0, 3.0, -1.6), 0.07, [0.20, 0.20, 0.22], CYL8);
  }

  function buildVillage(gb) {
    const rn = mulberry32(0x1beef);
    const vx = VILLAGE.x, vz = VILLAGE.z;
    for (let i = 0; i < 34; i++) {
      const th = rn() * Math.PI * 2;
      const rr = VILLAGE.r * Math.pow(rn(), 0.55);
      // clustered along the valley floor rather than a disc
      const px = vx + Math.cos(th) * rr * 1.5, pz = vz + Math.sin(th) * rr * 0.65;
      field.probe(px, pz, probe);
      if (probe.slope > 0.55) continue;
      const gy = terrain.height(px, pz);
      const w = 3.2 + rn() * 3.4;
      // 1.5 km down the valley: one hut is 12 px. It gets the coarse profile.
      hutAt(gb, px, pz, gy, rn() * Math.PI * 2, {
        w, d: w * (0.9 + rn() * 0.7), h: 4.2 + rn() * 3.0, roofH: 2.2 + rn() * 1.4,
        wall: rn() < 0.4 ? [0.30, 0.26, 0.22] : [0.15, 0.13, 0.11],
        lowDetail: true,
      });
    }
    // church: the one vertical in a valley of roofs, and the thing that makes a
    // cluster of boxes read as a village
    {
      const px = vx - 26, pz = vz + 14;
      const gy = terrain.height(px, pz);
      hutAt(gb, px, pz, gy, 0.4, { w: 5.0, d: 9.0, h: 7.5, roofH: 3.4, chimney: false });
      const tx = px + 8, tz = pz - 5, ty = terrain.height(tx, tz);
      boxAt(gb, new THREE.Vector3(tx, ty + 7.5, tz), new THREE.Vector3(3.4, 15, 3.4), 0.4, [0.62, 0.60, 0.57]);
      boxAt(gb, new THREE.Vector3(tx, ty + 13.4, tz), new THREE.Vector3(3.6, 1.6, 3.6), 0.4, [0.14, 0.14, 0.16]);
      // spire
      const apex = new THREE.Vector3(tx, ty + 24, tz);
      for (let k = 0; k < 4; k++) {
        const a0 = (k / 4) * Math.PI * 2 + 0.4, a1 = ((k + 1) / 4) * Math.PI * 2 + 0.4;
        const r = 2.4;
        const v0 = gb.v(apex.x, apex.y, apex.z, 0, 1, 0, ...uvSnow(0.5, 0.5), 0.30, 0.28, 0.30, 0);
        const v1 = gb.v(tx + Math.cos(a0) * r, ty + 15.2, tz + Math.sin(a0) * r,
          Math.cos(a0), 0.5, Math.sin(a0), ...uvSnow(0.5, 0.5), 0.34, 0.32, 0.34, 0);
        const v2 = gb.v(tx + Math.cos(a1) * r, ty + 15.2, tz + Math.sin(a1) * r,
          Math.cos(a1), 0.5, Math.sin(a1), ...uvSnow(0.5, 0.5), 0.34, 0.32, 0.34, 0);
        gb.tri(v0, v1, v2);
      }
    }
  }

  function buildBuildings() {
    const gb = new GB();
    for (const b of BUILDINGS) {
      const gy = terrain.height(b.x, b.z);
      b.floorY = hutAt(gb, b.x, b.z, gy, b.yaw, b);
    }
    for (const g of GROOMERS) groomerAt(gb, g.x, g.z, terrain.height(g.x, g.z), g.yaw);
    // people outside the huts, in twos and threes
    const fr = mulberry32(0x2b0b);
    const JK = [[0.86, 0.18, 0.10], [0.10, 0.28, 0.64], [0.94, 0.66, 0.08],
      [0.90, 0.92, 0.95], [0.12, 0.50, 0.34], [0.70, 0.22, 0.50], [0.16, 0.16, 0.18]];
    for (const b of BUILDINGS) {
      const n = b.deck ? 5 : 3;
      for (let i = 0; i < n; i++) {
        const a = b.yaw + (fr() - 0.5) * 2.2;
        const rr = b.w + (b.deck || 0) + 2.5 + fr() * 7;
        figureAt(gb, b.x + Math.cos(a) * rr * 1.1, b.z - Math.sin(a) * rr * 0.9,
          fr() * 6.28, JK[(fr() * JK.length) | 0], 0.94 + fr() * 0.12);
      }
    }
    buildVillage(gb);
    // BUDGET: this mesh is `frustumCulled = false`, so every triangle in it is
    // submitted to the main pass and to every shadow cascade on every frame,
    // wherever the player is. It runs 39k against the 19k it carried before the
    // cladding went on, and it is worth watching — see boardFace().
    const mesh = new THREE.Mesh(gb.geo(), matBuild);
    mesh.name = 'buildings';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  buildLift();
  buildProps();
  buildBuildings();

  // ---- circulating chairs --------------------------------------------------
  const CHAIR_SPACING = 36;
  const CHAIR_VIS = 90;
  const chairGeo = buildChair();
  const chairPool = new Pool(chairGeo, matPaint, CHAIR_VIS, { castShadow: true, name: 'chairs' });
  chairPool.mesh.count = 0;
  group.add(chairPool.mesh);

  const chairList = [];
  for (const cab of lift.cables) {
    const n = Math.max(2, Math.floor(cab.total / CHAIR_SPACING));
    for (let i = 0; i < n; i++) chairList.push({ cab, s: (i / n) * cab.total });
  }

  function cablePoint(cab, s, out) {
    const cum = cab.cum;
    let lo = 0, hi = cum.length - 1;
    s = ((s % cab.total) + cab.total) % cab.total;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid; else hi = mid;
    }
    const seg = Math.max(1e-5, cum[lo + 1] - cum[lo]);
    const t = (s - cum[lo]) / seg;
    out.copy(cab.pts[lo]).lerp(cab.pts[lo + 1], t);
    return lo;
  }

  const _cp = new THREE.Vector3();
  let chairPhase = 0;

  function updateChairs(px, pz, dt) {
    chairPhase += dt * 4.6;
    chairPool.mesh.count = 0;
    let used = 0;
    const arr = chairPool.mesh.instanceMatrix.array;
    for (let i = 0; i < chairList.length && used < CHAIR_VIS; i++) {
      const ch = chairList[i];
      const s = ch.s + chairPhase * ch.cab.dir;
      const seg = cablePoint(ch.cab, s, _cp);
      const dx = _cp.x - px, dz = _cp.z - pz;
      if (dx * dx + dz * dz > 900 * 900) continue;
      const a = ch.cab.pts[seg], b = ch.cab.pts[seg + 1];
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const sway = Math.sin(chairPhase * 0.35 + i * 1.7) * 0.035;
      _q.setFromEuler(new THREE.Euler(sway * 0.6, yaw, sway));
      _m.compose(_cp, _q, _scl.set(1, 1, 1));
      _m.toArray(arr, used * 16);
      used++;
    }
    chairPool.mesh.count = used;
    chairPool.mesh.visible = used > 0;
    chairPool.mesh.instanceMatrix.needsUpdate = true;
  }

  // =========================================================================
  // Other skiers
  // =========================================================================
  // The single loudest artificial signal in the frame was that nothing in the
  // world was doing anything: one rider on a whole mountain. Shredders — a
  // measurably weaker renderer — read as a game instantly because six other
  // riders were on screen.
  //
  // These need no AI and no pathfinding. Each rides a sine down the fall line
  // with its own wavelength, amplitude, lateral offset, speed and phase, which
  // is what a carved descent IS; the lean comes out of the curvature of that
  // path and the spray out of the lean. Because the line is a pure function of
  // z, it is a fixed curve in the world: a rider carves the same descent
  // whatever the player does, and it is the same descent next frame.
  //
  // Measured against the previous recycler over three framings, 900 frames of
  // the same scripted run each (probe reads the rig's own instance matrices,
  // so it is build-agnostic):
  //
  //                      teleports ON SCREEN   riders within 60 m (avg)
  //     hero    before          2                      0.61
  //             after           0                      2.15
  //     trees   before          1                      0.00
  //             after           0                      0.16
  //     steep   after           0                      2.37
  //
  //   ...at an unchanged on-screen population (hero 5.78 -> 5.31, trees
  //   4.30 -> 5.10 riders inside the frustum).
  //
  // Cost: five instanced draw calls plus one for the spray, ~1.4k triangles
  // total, twelve terrain samples a frame, plus one 16-sample line-of-sight
  // test (round-robin, one rider per frame) and a ~35-sample horizon march on
  // a respawn — of which there are one or two a second.
  const RIDERS = 12;
  const RIDER_JACKETS = [
    [0.86, 0.16, 0.10], [0.10, 0.26, 0.62], [0.92, 0.62, 0.06], [0.10, 0.10, 0.12],
    [0.80, 0.82, 0.86], [0.10, 0.52, 0.34], [0.72, 0.24, 0.52], [0.94, 0.94, 0.30],
    [0.22, 0.62, 0.82], [0.55, 0.14, 0.62], [0.96, 0.42, 0.16], [0.34, 0.36, 0.40],
  ];

  // Rider rig. Five instanced parts rather than three, because the two things
  // the gate could not see at 60-100 m — a leg gap and a pole — are both
  // SILHOUETTE features that need their own transform:
  //
  //   skis   full edge angle
  //   legL   independently extended/retracted and splayed: the outside leg of a
  //   legR   carved turn is long and the inside one is short, and that
  //          asymmetry is what makes a figure read as carving rather than as a
  //          standing sprite being slid down a hill
  //   upper  torso, seat, pack, helmet — takes far less of the edge angle
  //   arms   arms, gloves and both poles, swinging on the turn phase
  //
  // Stance is 0.40 m between ski centres rather than 0.34. At 80 m that is
  // 4.1 px, against ~2 px of leg, so there is 2 px of daylight between the legs
  // instead of 1 — the difference between "two legs" and "a block".
  const RIDER_STANCE = 0.20;
  const RIDER_HIP_Y = 0.96;

  function buildRiderSkis() {
    const gb = new GB();
    const SKI = [0.10, 0.11, 0.13], EDGE = [0.62, 0.64, 0.68], BOOT = [0.13, 0.13, 0.15];
    for (const sx of [-RIDER_STANCE, RIDER_STANCE]) {
      // Ski body, with a lifted, upturned tip. `rad` matters here: a ski is
      // 35 mm thick, which is a fifth of a pixel at 80 m, so the ski itself was
      // invisible and all that showed at the foot of the rider was the boot —
      // "a dark block", exactly the read the gate had. The screen-width floor
      // in matRider holds it as a line instead. The boot is correspondingly
      // smaller: it was the biggest thing below the knee and it should not be.
      boxAt(gb, new THREE.Vector3(sx, 0.035, 0.06), new THREE.Vector3(0.105, 0.035, 1.64), 0, SKI, 0.048);
      boxAt(gb, new THREE.Vector3(sx, 0.030, -0.78), new THREE.Vector3(0.105, 0.022, 0.20), 0, EDGE, 0.040);
      strut(gb, new THREE.Vector3(sx, 0.05, 0.85), new THREE.Vector3(sx, 0.15, 1.02), 0.05, SKI, CYL8);
      // binding + boot
      boxAt(gb, new THREE.Vector3(sx, 0.10, 0.02), new THREE.Vector3(0.13, 0.08, 0.34), 0, BOOT);
      boxAt(gb, new THREE.Vector3(sx, 0.23, 0.0), new THREE.Vector3(0.135, 0.22, 0.28), 0, BOOT);
      boxAt(gb, new THREE.Vector3(sx, 0.32, -0.03), new THREE.Vector3(0.140, 0.09, 0.22), 0, [0.42, 0.43, 0.47]);
    }
    return gb.geo();
  }

  /** One leg, hip at the origin height so the part can pivot and scale there. */
  function buildRiderLeg(s) {
    const gb = new GB();
    const PANT = [0.15, 0.16, 0.19];
    const hip = new THREE.Vector3(s * 0.145, RIDER_HIP_Y - 0.02, -0.02);
    const knee = new THREE.Vector3(s * (RIDER_STANCE + 0.015), 0.60, 0.235);
    const ankle = new THREE.Vector3(s * RIDER_STANCE, 0.34, 0.03);
    strut(gb, hip, knee, 0.108, PANT, CYL8);
    strut(gb, knee, ankle, 0.086, PANT, CYL8);
    // knee: the two tubes meet at 40 deg, and without this the joint pinches to
    // a waist that reads as a broken leg at any distance the figure is legible
    const kn = new THREE.IcosahedronGeometry(0.098, 0);
    _mm.compose(knee, new THREE.Quaternion(), new THREE.Vector3(1, 0.9, 1.1));
    gb.add(kn, _mm, PANT, null, 0, 0.098);
    kn.dispose();
    return gb.geo();
  }

  function buildRiderUpper() {
    const gb = new GB();
    const JKT = [1.0, 1.0, 1.0];              // takes the per-instance colour
    const DARK = [0.14, 0.14, 0.16];
    const SKIN = [0.72, 0.55, 0.44];
    // seat / hips
    boxAt(gb, new THREE.Vector3(0, RIDER_HIP_Y, -0.02), new THREE.Vector3(0.42, 0.24, 0.30), 0, [0.15, 0.16, 0.19]);
    // torso, leaning forward into the hill
    strut(gb, new THREE.Vector3(0, 1.02, -0.02), new THREE.Vector3(0, 1.42, 0.12), 0.20, JKT, CYL8);
    boxAt(gb, new THREE.Vector3(0, 1.44, 0.12), new THREE.Vector3(0.44, 0.16, 0.30), 0, JKT);
    // neck + helmet
    strut(gb, new THREE.Vector3(0, 1.46, 0.10), new THREE.Vector3(0, 1.54, 0.10), 0.07, SKIN, CYL8);
    const head = new THREE.IcosahedronGeometry(0.125, 1);
    _mm.compose(new THREE.Vector3(0, 1.62, 0.08), new THREE.Quaternion(),
      new THREE.Vector3(1, 1.05, 1.15));
    gb.add(head, _mm, DARK);
    head.dispose();
    // goggles
    boxAt(gb, new THREE.Vector3(0, 1.63, 0.20), new THREE.Vector3(0.20, 0.075, 0.08), 0, [0.30, 0.55, 0.75]);
    // Small pack, so the back silhouette is not a smooth cylinder. It used to
    // be a 0.30 x 0.36 near-black box — which is the whole torso, seen from
    // behind, and behind is the default view of a skier you are following: the
    // jacket colour only survived on the arms and every rider read as a dark
    // silhouette with coloured sleeves. Smaller, and tinted as jacket-matched
    // kit (the vertex colour multiplies the per-instance jacket), so the
    // colour identity survives the view that actually matters.
    boxAt(gb, new THREE.Vector3(0, 1.26, -0.13), new THREE.Vector3(0.24, 0.28, 0.11), 0, [0.42, 0.42, 0.46]);
    return gb.geo();
  }

  /** Arms, gloves and both poles, pivoting at the shoulder. */
  function buildRiderArms() {
    const gb = new GB();
    const JKT = [1.0, 1.0, 1.0];
    const DARK = [0.14, 0.14, 0.16];
    for (const s of [-1, 1]) {
      const sh = new THREE.Vector3(s * 0.21, 1.40, 0.10);
      const el = new THREE.Vector3(s * 0.31, 1.19, 0.26);
      const hd = new THREE.Vector3(s * 0.28, 1.06, 0.47);
      strut(gb, sh, el, 0.075, JKT, CYL8);
      strut(gb, el, hd, 0.062, JKT, CYL8);
      boxAt(gb, hd, new THREE.Vector3(0.11, 0.11, 0.13), 0, DARK);
      // pole: grip at the hand, shaft trailing back and out past the hip. A
      // real pole is 13 mm of aluminium — it only survives to the screen at all
      // because matRider holds it above 1.5 px (see uRiderMinR).
      // 1.32 m grip to tip. The first cut ran 1.72 m and, held above a pixel
      // and a half by the shader, four of them per rider raked the frame.
      const tip = new THREE.Vector3(s * 0.44, 0.16, -0.55);
      strut(gb, hd, tip, 0.0135, DARK, CYL);
      // basket, just above the tip
      strut(gb, new THREE.Vector3(s * 0.428, 0.26, -0.48),
        new THREE.Vector3(s * 0.434, 0.22, -0.515), 0.044, DARK, CYL);
    }
    return gb.geo();
  }

  function makePuffTexture() {
    const S = 64;
    const cv = makeCanvas(S, S);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, S, S);
    // A spray plume is not a ball. Soft, wide, off-centre lobes with a long
    // alpha tail: hard-edged discs read as cotton wool stuck to the piste.
    const rr = mulberry32(0x77aa);
    for (let i = 0; i < 14; i++) {
      const x = S * (0.5 + (rr() - 0.5) * 0.78), y = S * (0.52 + (rr() - 0.5) * 0.62);
      const r = S * (0.16 + 0.26 * rr());
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.42)');
      gr.addColorStop(0.45, 'rgba(255,255,255,0.20)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  const riderSkis = new THREE.InstancedMesh(buildRiderSkis(), matRider, RIDERS);
  const riderLegL = new THREE.InstancedMesh(buildRiderLeg(-1), matRider, RIDERS);
  const riderLegR = new THREE.InstancedMesh(buildRiderLeg(1), matRider, RIDERS);
  const riderUpper = new THREE.InstancedMesh(buildRiderUpper(), matRider, RIDERS);
  const riderArms = new THREE.InstancedMesh(buildRiderArms(), matRider, RIDERS);
  const puffTex = makePuffTexture();
  const matPuff = new THREE.MeshBasicMaterial({
    map: puffTex, transparent: true, depthWrite: false, opacity: 1,
    side: THREE.DoubleSide, vertexColors: true, fog: true,
  });
  // The per-instance value is an ALPHA, not a colour: fading a puff by
  // multiplying its albedo turns it into a black smudge against the snow
  // instead of dissolving it.
  matPuff.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_fragment>', /* glsl */`
        #ifdef USE_COLOR
          diffuseColor.a *= vColor.r;
          // Sunlit spray is BRIGHTER than white: the snowfield beside it is
          // being lit by a 100 klx sun and this material is unlit, so at
          // radiance 1.0 the puff tone-mapped to a grey smoke smudge.
          diffuseColor.rgb *= vec3( 3.6, 3.7, 3.9 );
        #endif
      `);
  };
  matPuff.customProgramCacheKey = () => 'sc-puff';
  // More, smaller puffs. A carve throws a low fan of grains off one edge, not
  // one ball off the whole rider; the previous plume reached 3.2 m and was
  // wider than the 1.75 m figure making it.
  const PUFFS = RIDERS * 9;
  const puffGeo = new THREE.PlaneGeometry(1, 1);
  puffGeo.setAttribute('color', new THREE.Float32BufferAttribute(
    new Float32Array(puffGeo.attributes.position.count * 3).fill(1), 3));
  const riderPuffs = new THREE.InstancedMesh(puffGeo, matPuff, PUFFS);
  const riderParts = [riderSkis, riderLegL, riderLegR, riderUpper, riderArms];
  for (const m of [...riderParts, riderPuffs]) {
    m.frustumCulled = false;
    m.castShadow = m !== riderPuffs;
    m.receiveShadow = false;
    m.count = 0;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(m.instanceMatrix.count * 3).fill(1), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
  }
  riderSkis.name = 'riders-skis';
  riderLegL.name = 'riders-legL';
  riderLegR.name = 'riders-legR';
  riderUpper.name = 'riders-upper';
  riderArms.name = 'riders-arms';
  riderPuffs.name = 'riders-spray';

  // ---- population -----------------------------------------------------------
  // WHAT THIS REPLACED, because it is the whole point of the rewrite. The old
  // recycler was
  //
  //     if (r.z > pz - 13 || r.z < pz - 400) respawnRider(r, pz, pOff);
  //
  // so the instant the player closed to within 13 m of a rider, that rider was
  // teleported to a fresh random place on the mountain — and respawnRider()
  // re-rolled its amplitude, wavelength, phase, lateral offset, speed, jacket
  // and stance on the way out. You could therefore never overtake anybody: the
  // piste was a conveyor of strangers who evaporated at arm's length, and
  // nothing in the world had an identity that survived being looked at.
  //
  // The rules now:
  //
  //   IDENTITY   everything about a rider is a pure function of a ticket
  //              number, resolved once when it enters and never touched again
  //              while it is alive. Its line is x = corridor(z) + off +
  //              amp*sin(k z + phase), a fixed curve in world space, so it
  //              carves the same descent no matter where the player is.
  //
  //   RECYCLING  only ever behind the CAMERA — negative distance along the
  //              camera's own forward axis, i.e. behind the near plane, where
  //              no frustum can reach — or past the far cull. A rider that is
  //              faster than the player is never dropped for being behind,
  //              because it is on its way to overtake.
  //
  //   ENTRY      down the fall line at the nearest distance the roll of the
  //              piste actually hides (hiddenAhead() marches it), or from
  //              behind the camera for a rider quicker than the player. Both
  //              are places the viewer cannot see, so nobody ever pops in.
  //
  //   STANDING   anchored to spots drawn from a spatial hash of the piste, so
  //              the person resting at the edge is at a fixed place on the
  //              mountain, is the same person every time, and does not move a
  //              centimetre while you ski past them.
  const RIDER_FAR = 560;       // metres down-slope before a rider is out of play
  const RIDER_BEHIND = 25;     // metres behind the camera plane before recycling
  const RIDER_BEHIND_MAX = 320; // ...and a hard limit for one that is chasing
  const SPOT_SPACING = 38;     // metres of piste between candidate rest spots

  const riders = [];
  const riderRnd = mulberry32(0x5c1e5);
  let ticket = 7001;
  // Smoothed player DOWN-SLOPE rate, not speed. A rider's z advances at r.v, so
  // the reference it is scaled against has to be the player's z rate too: a
  // carving player covers 20 m/s of path but only 16-17 m/s of fall line, and
  // scaling riders against the path speed made every one of them out-run the
  // player and disappear over the horizon it had just been spawned behind.
  let pVz = 14;

  // The real camera. scatter is never handed one, and "behind the player" is
  // not the same question as "behind the camera" — the chase cam sits ~8 m back
  // and swings with the carve. InstancedMesh.onBeforeRender hands us the camera
  // three is actually drawing with; the shadow cascades are orthographic, so
  // testing for a perspective camera picks out the view camera.
  const camP = new THREE.Vector3(0, 2, 8);
  const camF = new THREE.Vector3(0, 0, -1);
  let camHave = false;
  riderSkis.onBeforeRender = (renderer, sc, cam) => {
    if (!cam || !cam.isPerspectiveCamera) return;
    camP.setFromMatrixPosition(cam.matrixWorld);
    camF.set(0, 0, -1).transformDirection(cam.matrixWorld);
    const l = Math.hypot(camF.x, camF.z) || 1;
    camF.x /= l; camF.z /= l; camF.y = 0;
    camHave = true;
  };

  /**
   * Where the roll of the piste hides a skier.
   *
   * Marches the fall line away from the camera keeping a running horizon (the
   * steepest upward slope seen so far) and returns the first distance at which
   * the head of a 1.85 m figure falls below it. That is the nearest point at
   * which a rider can be created without the viewer seeing it arrive. The
   * placement comments in this file already lean on this ray-march; this does
   * it at runtime instead of once by hand, because whether the far field is
   * hidden depends entirely on which roll of the slope the player is standing
   * on. ~35 terrain samples, and only on a respawn — a fraction of a second's
   * worth of the nine this module already spends per frame.
   */
  function hiddenAhead(offX, dMin, dMax) {
    let horizon = -1e9;
    for (let d = 12; d <= dMax; d += 12) {
      const z = camP.z - d;
      const x = corridorX(z) + offX;
      const g = terrain.height(x, z);
      const dist = Math.hypot(x - camP.x, z - camP.z);
      if (dist < 1) continue;
      if (d >= dMin && (g + 1.85 - camP.y) / dist < horizon) return d;
      const s = (g - camP.y) / dist;
      if (s > horizon) horizon = s;
    }
    return 0;
  }

  /**
   * Line of sight from the camera to a point on the snow. Marches the segment
   * and asks whether the ground ever rises above the ray — the exact test, not
   * a proxy, because a rider is only allowed to be recycled where it genuinely
   * cannot be seen. Up to 16 terrain samples, so it is run for at most ONE
   * rider a frame (see the round-robin in updateRiders).
   */
  function occluded(x, z) {
    const dx = x - camP.x, dz = z - camP.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 30) return false;
    const gy = terrain.height(x, z) + 1.85;      // the top of a rider's head
    const n = Math.min(16, Math.max(5, Math.round(dist / 30)));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (terrain.height(camP.x + dx * t, camP.z + dz * t) > camP.y + (gy - camP.y) * t) return true;
    }
    return false;
  }

  /**
   * Is this rider somewhere the viewer cannot possibly see it? `rel` is the
   * distance along the camera's own forward axis, so anything negative is
   * behind the near plane and outside every frustum; the second clause covers
   * the far field, where the roll of the piste is doing the hiding.
   */
  function outOfSight(r) {
    if (r.x === undefined) return true;
    const rel = (r.x - camP.x) * camF.x + (r.z - camP.z) * camF.z;
    return rel < -6 || rel > 420;
  }

  /** Everything about rider `t`, from its ticket alone. */
  function identity(r, t) {
    const rnd = mulberry32(hashi(t, 0x9e3779b9, 0x5c1e5));
    r.id = t;
    r.stand = false;
    r.jacket = (rnd() * RIDER_JACKETS.length) | 0;
    r.crouch = rnd();
    r.amp = 6 + rnd() * 9;
    r.wl = 30 + rnd() * 40;                      // metres per half turn
    r.ph = rnd() * 6.283;
    r.yawJ = 0;
    r.sgn = rnd() < 0.5 ? -1 : 1;
    r.off = r.sgn * (6 + rnd() * 24);
    // Speed as a fraction of the player's own fall-line rate rather than an
    // absolute. A rider can only be MET if it is not travelling at the player's
    // pace, and the spread has to straddle it: the slower two thirds are caught
    // and overtaken, the quick ones come up from behind and go past. A
    // distribution centred on the player's pace would leave everybody parked at
    // the distance they entered at, which is out of sight, which is an empty
    // piste — and teleporting them into the near field to fix that is the bug
    // this rewrite exists to remove.
    r.vk = 0.45 + rnd() * 0.67;
    if (Math.abs(r.off) + r.amp > PISTE_HALF - 6) r.off *= 0.5;
  }

  /** A rider parked at world spot `n`. Same spot, same person, forever. */
  function standSpot(r, n) {
    const rnd = mulberry32(hashi(n, 0x51ed17, 0x5c1e5));
    r.id = -n;
    r.spot = n;
    r.stand = true;
    r.z = n * SPOT_SPACING + (rnd() - 0.5) * 26;
    const sgn = rnd() < 0.5 ? -1 : 1;
    r.off = sgn * (23 + rnd() * 15);             // on the shoulder, off the line
    r.sgn = sgn;
    r.jacket = (rnd() * RIDER_JACKETS.length) | 0;
    r.crouch = 0.15 * rnd();
    r.amp = 0; r.wl = 40; r.ph = 0; r.v = 0;
    // not everybody standing at the edge of a piste is facing down it
    r.yawJ = (rnd() - 0.5) * 1.5;
  }

  const spotFree = (n, self) => {
    for (let i = 0; i < riders.length; i++) {
      const q = riders[i];
      if (q !== self && q.stand && q.spot === n) return false;
    }
    return true;
  };

  /**
   * Put a standing rider on the nearest free spot that is out of sight. The
   * spot's own hash jitter can pull it 13 m nearer than the lattice suggests,
   * so the accepted spot is re-checked against the hiding distance rather than
   * assumed — a person appearing out of nothing at the edge of the piste is the
   * single most immersion-breaking thing this rewrite is here to prevent.
   */
  function placeRest(r, pz, minD) {
    const d = Math.max(minD, hiddenAhead(0, minD, 460) || 200);
    let n = Math.round((pz - d - 13) / SPOT_SPACING);
    for (let k = 0; k < 10; k++, n--) {
      if (!spotFree(n, r)) continue;
      standSpot(r, n);
      if (pz - r.z >= d) return;
    }
    standSpot(r, n);
  }

  /** A rider enters. Never anywhere the camera can see. */
  function respawn(r, px, pz) {
    if (r.rest) { placeRest(r, pz, 55); return; }
    identity(r, ticket++);
    r.v = clamp(r.vk * Math.max(pVz, 9), 6.0, 26);
    if (r.v > pVz + 1.2) {
      // quicker than the player: comes up from behind the camera and passes
      r.z = camP.z + 40 + 110 * riderRnd();
    } else {
      const d = hiddenAhead(r.off, 45, 480) || 240;
      r.z = pz - (d + 4 + 26 * riderRnd());
    }
    pairFollower(r);
  }

  /**
   * Every fourth rider follows the one before it. They enter together and hold
   * the same line a few metres apart, which is what a pair of friends on a
   * piste looks like; the old code paired them at respawn and then let the
   * recycler pull them apart within seconds.
   */
  function pairFollower(lead) {
    const f = riders[lead.slot + 1];
    if (!f || (f.slot & 3) !== 3 || f.rest || lead.rest || lead.stand) return;
    // ...but never at the cost of the rule this whole rewrite is about. If the
    // follower is currently somewhere the camera can see, it keeps its own life
    // and rejoins the pattern the next time it is legitimately recycled. Moving
    // it here is exactly the teleport-under-your-nose the old code did.
    if (f.x !== undefined && !outOfSight(f)) return;
    identity(f, ticket++);
    f.amp = lead.amp; f.wl = lead.wl; f.ph = lead.ph + 0.35;
    f.sgn = lead.sgn;
    f.off = lead.off + lead.sgn * (3 + riderRnd() * 5);
    f.v = lead.v * (0.96 + riderRnd() * 0.07);
    f.z = lead.z + (5 + riderRnd() * 8);         // behind = up-slope = larger z
    if (Math.abs(f.off) + f.amp > PISTE_HALF - 6) f.off *= 0.5;
    f.x = undefined;
  }

  /**
   * Seeding, used on the first frame and after a teleport (the capture harness,
   * a respawn). A cut is the one moment riders may legitimately be created in
   * view, and the near-weighted spread here is the measured one this module has
   * always used: the chase camera sits 1.7 m over a straight 15 deg ramp, so
   * the piste is seen nearly edge-on and a 1.75 m figure converges into the
   * surface noise within about 60 m. A "realistic" uniform spread over 45-375 m
   * renders as an EMPTY piste, so two thirds of the riders start in the 15-50 m
   * band where they actually read and the rest run out to 350 m for the wide
   * framings.
   */
  function seedRiders(px, pz) {
    for (let i = 0; i < RIDERS; i++) {
      const r = riders[i];
      const u = ((i * 7) % 5) / 5, u2 = ((i * 3) % 7) / 7;
      if (r.rest) {
        const d = 26 + 104 * u2;
        let n = Math.round((pz - d) / SPOT_SPACING);
        for (let k = 0; k < 8 && !spotFree(n, r); k++) n--;
        standSpot(r, n);
      } else {
        identity(r, ticket++);
        r.v = clamp(r.vk * Math.max(pVz, 12), 6.0, 26);
        r.z = pz - ((i % 5) < 3 ? 15 + 34 * u : 55 + 300 * Math.pow(u2, 1.6));
      }
      r.x = undefined;
    }
    for (let i = 0; i < RIDERS; i++) if ((i & 3) === 3) pairFollower(riders[i - 1]);
  }

  for (let i = 0; i < RIDERS; i++) {
    const r = { slot: i, rest: (i % 6) === 5, stand: false, z: 0, x: undefined, v: 12 };
    identity(r, ticket++);
    riders.push(r);
  }
  let ridersInit = false;
  let lastPX = 0, lastPZ = 0;
  let losCursor = 0;             // whose turn it is for a line-of-sight test

  const _rq = new THREE.Quaternion(), _rq2 = new THREE.Quaternion();
  const _rn = new THREE.Vector3(), _rm = new THREE.Matrix4(), _rl = new THREE.Matrix4();
  // NB: the base transform needs its own matrix. multiplyMatrices(this, b) with
  // `this === a` reads its own elements as it overwrites them.
  const _rbase = new THREE.Matrix4();
  const _rv = new THREE.Vector3(), _rs = new THREE.Vector3();
  const FWD = new THREE.Vector3(0, 0, 1);
  const puffs = [];
  for (let i = 0; i < PUFFS; i++) puffs.push({ x: 0, y: -9999, z: 0, t: 1, s: 1, seed: i });

  const RIGHT = new THREE.Vector3(1, 0, 0);
  /**
   * One body part, rotated about a pivot at (0, pivotY, 0) in rider space and
   * concatenated onto the rider's base transform. Roll is about the travel
   * axis (that is the edge angle), pitch about lateral (fore/aft lean).
   */
  const _rzero = new THREE.Vector3();
  function riderPart(mesh, slot, base, pivotY, roll, pitch, yawEx, col, sy = 1) {
    _rq2.setFromAxisAngle(FWD, roll);
    _rq.setFromAxisAngle(RIGHT, pitch);
    _rq2.multiply(_rq);
    if (yawEx) { _rq.setFromAxisAngle(UP, yawEx); _rq2.multiply(_rq); }
    _rl.compose(_rzero, _rq2, _rs.set(1, sy, 1));
    // compose() scales column j by scale[j], so the fixed-point solve below
    // stays correct with a non-unit sy: it only reads column 1.
    const e = _rl.elements;
    e[12] = -e[4] * pivotY;
    e[13] = pivotY - e[5] * pivotY;
    e[14] = -e[6] * pivotY;
    _rm.multiplyMatrices(base, _rl);
    _rm.toArray(mesh.instanceMatrix.array, slot * 16);
    const ca = mesh.instanceColor.array;
    ca[slot * 3] = col[0]; ca[slot * 3 + 1] = col[1]; ca[slot * 3 + 2] = col[2];
  }

  const NEUTRAL = [0.92, 0.92, 0.96];
  let puffCursor = 0;

  function updateRiders(px, pz, dt, speed) {
    // Before anything has been rendered there is no camera to ask; put a
    // stand-in where the chase cam sits so the first frame's cull is sane.
    if (!camHave) {
      camP.set(px, terrain.height(px, pz) + 2.4, pz + 8);
      camF.set(0, 0, -1);
    }
    // A teleport (harness.setPlayer, a respawn) is a cut, and a cut is the one
    // place the population may legitimately be rebuilt in view.
    const cut = !ridersInit || Math.abs(pz - lastPZ) > 60 || Math.abs(px - lastPX) > 60;
    // Rider speeds are scaled against this. It is a 3 s average, not the
    // instantaneous rate: a rider's line must not change under it.
    if (!cut && dt > 1e-5) {
      const vz = Math.min(Math.max(0, (lastPZ - pz) / dt), 40);
      pVz += (vz - pVz) * (1 - Math.exp(-dt / 3));
    }
    if (cut) {
      ridersInit = true;
      pVz = Math.max(speed || 0, 12);
      seedRiders(px, pz);
    }
    lastPX = px; lastPZ = pz;

    losCursor = (losCursor + 1) % riders.length;

    let slot = 0;
    for (let i = 0; i < riders.length; i++) {
      const r = riders[i];
      if (!r.stand) r.z -= r.v * dt;

      // Recycle — and ONLY out of sight. `rel` is the distance along the
      // camera's own forward axis, so a negative value is behind the near
      // plane, where no frustum can reach. A rider quicker than the player is
      // exempt from the near limit: it is behind because it is on its way past.
      if (r.x !== undefined) {
        const rel = (r.x - camP.x) * camF.x + (r.z - camP.z) * camF.z;
        const receding = r.stand || r.v <= pVz + 0.2;
        // A rider that has run away over the roll of the piste is spending the
        // population budget somewhere nobody can see it, and bringing it back
        // round costs nothing visually. Without this a traverse — where the
        // player's fall-line rate is low and most of the field out-runs them —
        // empties the near piste completely. The line-of-sight test is the real
        // one and it is only ever run for the one rider whose turn it is.
        const wasted = !r.stand && i === losCursor && (pz - r.z) > 170
          && occluded(r.x, r.z);
        if ((receding && rel < -RIDER_BEHIND) || rel < -RIDER_BEHIND_MAX
          || wasted || pz - r.z > RIDER_FAR) respawn(r, px, pz);
      }

      const k = Math.PI / r.wl;
      const s = Math.sin(r.z * k + r.ph);
      const cxz = corridorX(r.z);
      const x = cxz + r.off + r.amp * s;
      const dxdz = (corridorX(r.z + 4) - corridorX(r.z - 4)) / 8 + r.amp * k * Math.cos(r.z * k + r.ph);
      const d2x = -r.amp * k * k * s;
      // travel direction: z decreases
      const dirX = -dxdz, dirZ = -1;
      const dl = Math.hypot(dirX, dirZ);
      const yaw = Math.atan2(dirX / dl, dirZ / dl) + (r.stand ? r.yawJ : 0);
      const y = terrain.sample(x, r.z, _rn);
      r.x = x;
      // lean = the angle the resultant of gravity and the turn's lateral
      // acceleration makes with the snow. This is not a stylistic choice; it is
      // what puts a rider's shoulders where a photograph puts them.
      const kappa = d2x / Math.pow(1 + dxdz * dxdz, 1.5);
      // r.v is the rate down the fall line; the lean has to be computed from
      // the speed along the actual path, which on a hard turn is meaningfully
      // faster than that.
      const vPath = r.v * dl;
      const lean = r.stand ? 0 : clamp(Math.atan(vPath * vPath * kappa / 9.81), -0.52, 0.52);
      const edge = Math.abs(lean);

      // The carve CYCLE. `edge` is the load, and everything a skier does with
      // their legs is a function of it: extend through the apex, retract and
      // cross under at the transition. `phase` runs the pole swing, which peaks
      // where the edges are unloaded — that is where a pole plant happens.
      const eN = r.stand ? 0 : Math.min(1, edge / 0.42);
      const phase = Math.cos(r.z * k + r.ph);         // +-1 at the transitions
      // Both legs long at the apex, short at the transition...
      const ext = r.stand ? 0.99 - 0.09 * r.crouch : 0.90 + 0.15 * eN - 0.05 * r.crouch;
      // ...and then asymmetric about that: the outside leg of a turn carries
      // the load and is long, the inside one is folded under the hip. `lean`
      // is a roll about the travel axis, and a positive roll tips the body
      // toward -x, so the outside leg is the +x one.
      const outs = lean > 0 ? 1 : -1;
      const asym = 0.11 * eN;

      _rq.setFromUnitVectors(UP, _rn);
      _rq2.setFromAxisAngle(UP, yaw);
      _rq.multiply(_rq2);
      const bob = -0.05 * edge - 0.06 * r.crouch - 0.09 * (1 - eN) * (r.stand ? 0 : 1);
      _rbase.compose(_rv.set(x, y + bob, r.z), _rq, _rs.set(1, 1, 1));

      const col = RIDER_JACKETS[r.jacket];
      // skis take the full edge angle, the legs nearly all of it, the upper
      // body far less — angulation is the whole shape of a carved turn
      riderPart(riderSkis, slot, _rbase, 0.0, lean, 0.02, lean * 0.20, NEUTRAL);
      // splay: +-0.05 rad about the hip pushes each ankle outward, which is
      // what opens daylight between the legs at the range these are seen at
      riderPart(riderLegL, slot, _rbase, RIDER_HIP_Y, lean * 0.92 - 0.05, 0.06, 0,
        NEUTRAL, ext * (1 + asym * (outs < 0 ? 1 : -1)));
      riderPart(riderLegR, slot, _rbase, RIDER_HIP_Y, lean * 0.92 + 0.05, 0.06, 0,
        NEUTRAL, ext * (1 + asym * (outs > 0 ? 1 : -1)));
      riderPart(riderUpper, slot, _rbase, RIDER_HIP_Y, lean * 0.42,
        r.stand ? -0.06 : 0.14 + 0.14 * r.crouch + 0.10 * eN, -lean * 0.30, col);
      // arms reach forward as the edges release and draw back through the apex
      riderPart(riderArms, slot, _rbase, 1.40, lean * 0.26,
        r.stand ? 0.02 : -0.10 + 0.34 * Math.abs(phase), -lean * 0.55, col);
      slot++;

      // spray off the outside edge, only while the edges are really loaded.
      // Deterministic (a phase accumulator, not Math.random) so a captured
      // frame is reproducible.
      r.acc = (r.acc || 0) + dt * (2.0 + edge * 30);
      if (edge > 0.13 && !r.stand && r.acc >= 1) {
        r.acc = 0;
        const p = puffs[puffCursor];
        puffCursor = (puffCursor + 1) % PUFFS;
        const side = lean > 0 ? -1 : 1;
        p.x = x + Math.cos(yaw) * side * 0.42;
        p.y = y + 0.06;
        p.z = r.z - Math.sin(yaw) * side * 0.42 - 0.55;
        p.t = 0.001;
        // SIZED, not guessed. `edge` tops out at the 0.52 rad clamp, the puff
        // grows to p.s * 2.5 before it dies and is drawn 1.2x as wide as it is
        // tall, so the old 0.34 + 0.95 edge gave a 2.1 m plume 2.8 m across —
        // taller and far wider than the 1.75 m rider throwing it, which is
        // exactly what the gate called out. 0.12 + 0.50 edge tops out at 0.38 m
        // of seed: a 0.95 m plume, 0.54 of rider height. The emission rate
        // above is nearly tripled to pay for it, so the spray reads as a fan of
        // grains rather than one ball.
        p.s = 0.12 + 0.50 * edge;
        p.rot = (puffCursor * 2.399) % 6.283;
        p.vx = -dirX / dl * 2.4 - Math.cos(yaw) * side * 1.5;
        p.vz = -dirZ / dl * 2.4 + Math.sin(yaw) * side * 1.5;
      } else if (r.acc >= 1) r.acc = 0;
    }
    for (const m of riderParts) {
      m.count = slot;
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    }

    // puffs: billboarded toward the camera, rising and spreading as they die
    let ps = 0;
    const arr = riderPuffs.instanceMatrix.array;
    const pc = riderPuffs.instanceColor.array;
    for (let i = 0; i < PUFFS; i++) {
      const p = puffs[i];
      if (p.t >= 1) continue;
      p.t += dt * 1.35;
      if (p.t >= 1) continue;
      const g = p.t;
      const sz = p.s * (0.6 + 1.9 * g);
      const yaw = Math.atan2(camP.x - p.x, camP.z - p.z);
      _rq.setFromAxisAngle(UP, yaw);
      _rq2.setFromAxisAngle(FWD, p.rot + g * 0.6);
      _rq.multiply(_rq2);
      _rm.compose(_rv.set(p.x + (p.vx || 0) * g * 0.5, p.y + 0.08 + g * 1.1 * p.s,
        p.z + (p.vz || 0) * g * 0.5), _rq, _rs.set(sz * 1.20, sz, sz));
      _rm.toArray(arr, ps * 16);
      // fade in fast, out slowly
      const a = Math.min(1, g * 7) * (1 - g) * (1 - g) * 1.5;
      pc[ps * 3] = a; pc[ps * 3 + 1] = a; pc[ps * 3 + 2] = a;
      ps++;
    }
    // The spray only exists once somebody is carving, so its program would
    // otherwise link mid-run too. Same trick: one scale-0 instance for the
    // first few frames.
    if (warmFrames > 0 && ps < PUFFS) {
      _rm.makeScale(0, 0, 0).toArray(arr, ps * 16);
      pc[ps * 3] = pc[ps * 3 + 1] = pc[ps * 3 + 2] = 0;
      ps++;
    }
    riderPuffs.count = ps;
    riderPuffs.instanceMatrix.needsUpdate = true;
    riderPuffs.instanceColor.needsUpdate = true;
  }

  // =========================================================================
  let time = 0;

  // ---- foliage radiance environment ---------------------------------------
  // sky.js owns the sun and the atmosphere; scatter only reads them. The key
  // light is found once by walking the scene (the near shadow cascade is a
  // second DirectionalLight carrying zero radiance, so intensity disambiguates)
  // and the hemisphere `fill` sky.js keeps for fx/spray.js supplies the
  // chromaticity of the dome and of the horizon.
  let keyLight = null, hemi = null;
  const _sw = new THREE.Vector3();
  const SNOW_ALBEDO = 0.82;

  function syncRadiance() {
    if (!keyLight || keyLight.intensity <= 0.001) {
      keyLight = null;
      scene.traverse((o) => {
        if (o.isDirectionalLight && o.intensity > 0.001 && !keyLight) keyLight = o;
        if (o.isHemisphereLight && !hemi) hemi = o;
      });
    }
    if (!keyLight) return;
    _sw.copy(keyLight.position);
    if (keyLight.target) _sw.sub(keyLight.target.position);
    if (_sw.lengthSq() < 1e-9) return;
    _sw.normalize();
    uniforms.uSunW.value.copy(_sw);

    const c = keyLight.color, I = keyLight.intensity;
    uniforms.uSunRad.value.set(c.r * I, c.g * I, c.b * I);

    // Radiance leaving the snowfield: albedo / PI x the normal irradiance the
    // key delivers to it. sky.js meters sunlit snow at 1.0 linear, so this
    // lands near 1.0 at the default sun and falls with the sun the way the
    // snow it is bouncing off does.
    const k = Math.max(_sw.y, 0) * SNOW_ALBEDO / Math.PI * I;
    uniforms.uBounce.value.set(c.r * k, c.g * k, c.b * k * 1.06);

    // Sky dome. `hemi.color` is peak-normalised hue only (sky.js divides it
    // out for fx/spray.js), so it needs a level; a clear alpine zenith runs
    // about a seventh of sunlit snow.
    const s = k * 0.155;
    if (hemi) uniforms.uSkyFill.value.set(hemi.color.r * s, hemi.color.g * s, hemi.color.b * s);
    else uniforms.uSkyFill.value.set(s * 0.78, s * 0.88, s);
  }

  return {
    group,
    // Diagnostics. The shared uniform block, so a probe can freeze the wind or
    // the coverage dither and measure one term at a time instead of guessing
    // which of them is boiling; and the live rider list, so "did that skier
    // survive being overtaken" is a measurement rather than an opinion.
    // Nothing in the sim reads either.
    uniforms,
    riders,

    // --- placement seam, for gameplay modules ------------------------------
    // Consumers that have to put the PLAYER somewhere the world already has
    // geometry (ride the lift, walk into the restaurant, hang a banner off the
    // piste edge) must read the placement from here rather than re-deriving it.
    // Two copies of `corridorX0` or of the cable catenary is exactly the
    // ambiguous seam that has caused every integration failure in this repo.
    //
    //   buildings[]  { x, z, yaw, w, d, h, roofH, deck?, floorY }
    //                w/d are HALF extents across/along the ridge; floorY is the
    //                four-corner maximum, i.e. the deck level (see hutAt).
    //   lift.towers[] { x, z, g, h, top, topY, yaw, perpX, perpZ, armL, armR }
    //   lift.cables[] { pts, cum, total, dir }
    //                pts run from tower 0 (z = LIFT_Z0, the VALLEY end) to
    //                tower nT (z = LIFT_Z1, the TOP), so arc length increases
    //                uphill and `dir: +1` is the uphill-travelling side.
    //                These are the same samples the chairs already ride; `cum`
    //                is the arc-length table.
    buildings: BUILDINGS,
    lift,

    update(dt, state) {
      time += dt || 0;
      uniforms.uTime.value = time;
      syncRadiance();
      const p = state?.pos;
      const px = p ? p.x : 0, pz = p ? p.z : 0;
      uniforms.uCam.value.set(px, p ? p.y : 0, pz);

      // Individual stems pick their LOD band from their own distance, so the
      // near cells have to be re-emitted as the player travels. MOVE_RE is
      // comfortably inside EMIT_PAD, which is why nothing ever leaves a pool
      // while the shader still wants to draw it.
      if (!(Math.abs(px - lastCX) < MOVE_RE * 0.7 && Math.abs(pz - lastCZ) < MOVE_RE * 0.7)) {
        lastCX = px; lastCZ = pz;
        refresh(px, pz);
      }
      drain(firstFill > 0 ? 600 : 90, px, pz);
      if (firstFill > 0) firstFill--;

      // drop the boot-time warm-up instances once they have been through the
      // main pass and both shadow cascades a few times
      if (warmFrames > 0 && --warmFrames === 0) {
        for (let i = warmHandles.length - 1; i >= 0; i--) warmHandles[i].p.remove(warmHandles[i]);
        warmHandles.length = 0;
      }
      for (const pool of allPools) pool.flush();
      updateChairs(px, pz, dt || 0);
      updateRiders(px, pz, dt || 0, state?.speed || 0);
    },

    dispose() {
      for (const t of [treeTex, treeAtlas.nrm, impTex, clTex, massTex, netTex, puffTex]) t.dispose();
      for (const m of [protoTree, protoImp, protoRock, protoSnow, matTree0, matTree1,
        matLog0, matLog1, matImp, matCl, matMass, matRock0, matRock1,
        matDrift0, matDrift1, matPaint, matRider, matBuild, matNet, matPuff]) m.dispose();
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      scene.remove(group);
    },
  };
}
