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
const B_G1 = [34, 46, 92, 112];       // reduced geometry
const B_IMP = [92, 112, 172, 210];    // single-tree cards
const B_CL = [172, 210, 580, 660];    // cluster cards, ~8 stems each
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
const corridorX = (z) => 78 * Math.sin(z * 0.00092) + 34 * Math.sin(z * 0.00231 + 1.3);

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
  const nL = 4 + Math.floor(rnd() * 3);
  for (let i = 0; i < nL; i++) {
    const t = (i + 0.2 + rnd() * 0.6) / nL;
    const x = ox + S * (0.20 + 0.62 * t);
    const e = env(x);
    if (e < 0.14) continue;
    // keep every mound clear of the tile border, or the clip rectangle puts a
    // straight cut through the load and the card reads as a white shard
    const hw = Math.min(cfg.reach * e * (0.34 + 0.32 * rnd()),
      Math.min(x - ox, ox + S - x) - 12);
    if (hw < 12) continue;
    const hh = hw * (0.42 + 0.26 * rnd());
    snowLobe(g, rnd, x, cy + (rnd() - 0.5) * 12, hw, hh, 1.0);
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

  g.lineCap = 'round';
  // trunk: only really seen through the bare lower third
  g.globalAlpha = 1;
  g.strokeStyle = `hsl(26, ${12 - haze * 7}%, ${26 + haze * 40}%)`;
  g.lineWidth = Math.max(1.2, hwpx * 0.075);
  g.beginPath();
  g.moveTo(cx, baseY);
  g.lineTo(cx, top + hpx * 0.10);
  g.stroke();

  const perTier = Math.max(12, Math.round(52 * dens * Math.min(1.7, hwpx / 40)));

  // Tier geometry is resolved first, then drawn in two passes: all the needle
  // mass, then all the rime. Interleaving them per tier let the next tier's
  // needles bury the rime of the one below, which is why the load only ever
  // survived on the outer edge of the silhouette and the core stayed black.
  const tiers = [];
  for (let i = T - 1; i >= 0; i--) {
    const u = (i + 0.55) / T;                        // 0 top .. 1 bottom
    if (rnd() < gap * u) continue;                   // a tier simply missing
    // whorls must not sit on a regular ladder, or the card renders as
    // corrugated iron once it is a hundred pixels tall on screen
    tiers.push({
      y: top + u * hpx + (rnd() - 0.5) * (hpx / T) * 0.9,
      hw: hwpx * Math.pow(u, opt.taper || 0.8)
        * (0.80 + 0.34 * vnoise2(i * 3.1, opt.seed)) * (0.92 + 0.16 * rnd()),
      drop: (hpx / T) * (opt.droop || 1.6) * (0.6 + 0.8 * u),
    });
  }

  // ---- crown body ---------------------------------------------------------
  // An opaque core under the strokes. Strokes alone leave a lace: measured, the
  // painted crown was only ~60% covered at mip 0, and once the mip chain and
  // the alpha test had been through it the far treeline was mostly the snow
  // BEHIND it. A conifer at 200 m is an opaque dark mass with a ragged edge —
  // the raggedness is the strokes' job, the mass is this pass's. It is also the
  // crown's ambient occlusion: darkest at the trunk, opening out toward the
  // tips, which is what gives a card any sense of volume at all.
  for (const tr of tiers) {
    const core = tr.hw * 0.78;
    const li = (10 + rnd() * 5) * (1 - haze) + haze * 50;   // interior is shadowed
    g.globalAlpha = 1;
    g.fillStyle = `hsl(${hueJ + rnd() * 12}, ${(3 + rnd() * 4) * (1 - haze * 0.8)}%, ${li}%)`;
    g.beginPath();
    g.moveTo(cx, tr.y - tr.drop * 0.45);
    for (let k = -4; k <= 4; k++) {
      const t = k / 4;
      const wob = 0.82 + 0.30 * vnoise2(k * 2.3 + tr.y * 0.03, opt.seed || 0);
      g.lineTo(cx + t * core * wob,
        tr.y + tr.drop * (1.02 - t * t * 0.42) * (0.72 + 0.34 * rnd()));
    }
    g.closePath();
    g.fill();
  }

  // ---- needle mass --------------------------------------------------------
  for (const tr of tiers) {
    for (let j = 0; j < perTier; j++) {
      const sd = rnd();
      const sideS = rnd() < 0.5 ? -1 : 1;
      const w = tr.hw * Math.pow(sd, 0.5);
      // Strokes must not share a slope or a baseline, or a whorl renders as a
      // herringbone and a stack of whorls as corrugated iron.
      const yy = tr.y + tr.drop * sd * (0.30 + 1.05 * rnd());
      // Radial AO: `sd` is how far out the stroke sits, so the tips catch the
      // light and the mass toward the trunk stays in its own shadow. It used to
      // be the other way round (+5 * (1 - sd)), which lit the interior and made
      // the whole card read as one flat value.
      const li = (13 + rnd() * 8 + sd * 7) * (1 - haze) + haze * 58;
      g.strokeStyle = `hsl(${hueJ + rnd() * 20}, ${(2 + rnd() * 5) * (1 - haze * 0.8)}%, ${li}%)`;
      // Opaque and wide on purpose. These cards are alpha-tested against a
      // mipmapped atlas, so as a tree shrinks the mip chain averages thin,
      // semi-transparent strokes toward zero alpha and the cutoff deletes them.
      // Bright rime strokes are wider and survive, so distance was selectively
      // stripping the dark needle mass and leaving white spikes.
      g.lineWidth = 1.9 + rnd() * 2.4;
      g.globalAlpha = 1.0;
      g.beginPath();
      g.moveTo(cx + sideS * w * (0.06 + 0.34 * rnd()), yy - tr.drop * (0.1 + 0.5 * rnd()));
      g.lineTo(cx + sideS * w, yy);
      g.stroke();
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
  for (const tr of tiers) {
    const nRime = Math.round(perTier * (0.04 + 0.20 * snowAmt));
    for (let j = 0; j < nRime; j++) {
      const sd = rnd();
      const sideS = rnd() < 0.5 ? -1 : 1;
      const w = tr.hw * Math.pow(sd, 0.5) * (0.78 + 0.28 * rnd());
      const yy = tr.y + tr.drop * sd * (0.20 + 1.0 * rnd()) - tr.drop * 0.16;
      const li = (54 + rnd() * 15) * (1 - haze * 0.22) + haze * 16;
      g.strokeStyle = `hsl(${210 + rnd() * 14}, ${10 + rnd() * 12}%, ${li}%)`;
      g.lineWidth = 1.2 + rnd() * 1.9;
      g.globalAlpha = 0.20 + 0.26 * rnd();
      g.beginPath();
      g.moveTo(cx + sideS * w * (0.08 + 0.30 * rnd()), yy - tr.drop * (0.08 + 0.42 * rnd()));
      g.lineTo(cx + sideS * w, yy);
      g.stroke();
    }
  }

  // snow-capped leader, only on trees actually carrying load
  if (snowAmt > 0.5) {
    g.globalAlpha = 0.9;
    g.strokeStyle = '#eef3fc';
    g.lineWidth = Math.max(1.6, hwpx * 0.07);
    g.beginPath();
    g.moveTo(cx, top + hpx * 0.02);
    g.lineTo(cx, top + hpx * 0.07);
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
const IMP_CELLS = 6;
function makeSingleImpostorAtlas() {
  const CW = 512, H = 512, W = CW * IMP_CELLS;
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  const rnd = mulberry32(0x5eed1);
  // Reference stands run from lightly frosted dark spruce to fully rimed white
  // *within one hillside*; one silhouette and one load value across the whole
  // band is what made the treeline read as a row of identical spikes.
  //          two spruce         fir          pine        old      snag-ish
  const CFG = [
    { tiers: 21, hue: 168, taper: 0.94, droop: 1.75, snow: 1.05, wide: 0.235, gap: 0.05 },
    { tiers: 18, hue: 160, taper: 0.86, droop: 1.55, snow: 0.34, wide: 0.265, gap: 0.09 },
    { tiers: 15, hue: 152, taper: 0.76, droop: 1.35, snow: 0.70, wide: 0.310, gap: 0.05 },
    { tiers: 11, hue: 118, taper: 0.62, droop: 1.10, snow: 0.18, wide: 0.355, gap: 0.22 },
    { tiers: 13, hue: 164, taper: 0.84, droop: 1.95, snow: 0.55, wide: 0.270, gap: 0.26 },
    { tiers: 16, hue: 176, taper: 0.90, droop: 1.60, snow: 1.25, wide: 0.250, gap: 0.12 },
  ];
  for (let k = 0; k < IMP_CELLS; k++) {
    const c = CFG[k];
    // The single-tree band sits at 92-210 m, between geometry that still shows
    // dark needle and the cluster cards that carry the pale rimed distance. Its
    // load is scaled back so the LOD crossover at ~100 m is not also a tonal
    // step from dark green to white.
    paintConifer(g, rnd, k * CW + CW * 0.5, H - 8, H - 22, CW * c.wide, {
      tiers: c.tiers, hue: c.hue, seed: k * 5.7, taper: c.taper, droop: c.droop,
      snow: c.snow * 0.45, dens: 1.25, gap: c.gap,
    });
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
function makeClusterAtlas(cells, cardW, cardH, baseFrac, seed, haze, big) {
  const CW = 512, H = 512, W = CW * cells.length;
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  const rnd = mulberry32(seed);
  const pxx = CW / cardW, pxy = H / cardH;
  const baseY = H * (1 - baseFrac);

  for (let c = 0; c < cells.length; c++) {
    const n = cells[c];
    const ox = c * CW;
    const trees = [];
    for (let i = 0; i < n; i++) {
      trees.push({
        x: ox + CW * (0.10 + 0.80 * ((i + 0.5) / n + (rnd() - 0.5) * 0.9 / n)),
        z: rnd(),                                   // depth within the clump
        h: (0.42 + 0.58 * Math.pow(rnd(), 0.8)),
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
      const hw = hm * (t.sp < 0.4 ? 0.14 : t.sp < 0.8 ? 0.175 : 0.22);
      const by = baseY + (rnd() - 0.5) * cardH * baseFrac * pxy * 0.9;
      const opt = {
        tiers: t.sp < 0.4 ? 16 : 11, hue: 146 + t.sp * 34, seed: t.x * 0.01,
        taper: 0.8, droop: 1.6, snow: t.snow, dens: big ? 0.8 : 1.1,
        gap: 0.10 + 0.2 * t.sp,
        haze: haze + back * 0.14,
      };
      if (big) paintConiferMass(g, rnd, t.x, by, hm * pxy, hw * pxx, opt);
      else paintConifer(g, rnd, t.x, by, hm * pxy, hw * pxx, opt);
    }
    // a drift banked along the foot of the clump, so the card is bedded into
    // snow instead of standing on a cut line. It must stay *broken*: at 0.85
    // alpha and 60 overlapping lobes it fused into one continuous white bar and
    // drew a bright rule under the whole treeline.
    g.globalAlpha = 0.5;
    for (let i = 0; i < 42; i++) {
      const x = ox + CW * (0.04 + 0.92 * rnd());
      const r = CW * (0.025 + 0.075 * rnd());
      g.fillStyle = rnd() < 0.5 ? '#eef3fb' : '#ccd8ea';
      g.beginPath();
      g.ellipse(x, baseY + H * 0.012, r, r * (0.22 + 0.2 * rnd()), 0, 0, 7);
      g.fill();
    }
    g.globalAlpha = 1;
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
  { // 0 Norway spruce — narrow, tall, regular whorls, deep droop
    name: 'spruce', h: 24, trunkR: 0.20, tiers: 21, bare: 0.07, spread: 0.150,
    crown: 0.95, droop: 0.72, rise: 0.30, tip: 0.34, frondW: 0.30, snow: 1.0,
    sprig: 0, bark: 0, sub: 2,
    col: [0.94, 1.02, 0.94], barkCol: [0.92, 0.84, 0.76],
  },
  { // 1 silver fir — broader, blunter, dense, flat-topped with age
    name: 'fir', h: 20, trunkR: 0.23, tiers: 18, bare: 0.10, spread: 0.205,
    crown: 0.68, droop: 0.44, rise: 0.36, tip: 0.22, frondW: 0.34, snow: 1.0,
    sprig: 1, bark: 1, sub: 2,
    col: [0.90, 1.00, 0.96], barkCol: [1.00, 0.98, 0.94],
  },
  { // 2 arolla pine — open, ragged, long bare limbs, sheds its load
    name: 'pine', h: 16, trunkR: 0.26, tiers: 11, bare: 0.32, spread: 0.270,
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
    name: 'snag', h: 13, trunkR: 0.19, tiers: 7, bare: 0.34, spread: 0.150,
    crown: 0.55, droop: 0.20, rise: 0.30, tip: 0.0, frondW: 0.20, snow: 0.4,
    sprig: 3, bark: 3, sub: 1, dead: true,
    col: [0.74, 0.70, 0.64], barkCol: [1.05, 1.02, 0.98],
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
  const brokeAt = dead ? 0.60 + rnd() * 0.28 : 1;
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
  const nTiers = Math.max(4, Math.round(S.tiers * (lod === 0 ? 1 : 0.55)));
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

      const snowy = !dead && rnd() < LOAD * 0.85 * (o.snowK === undefined ? 1 : o.snowK);
      // A loaded card lies flat (roll near a quarter turn puts its face up); a
      // bare one fans through a full turn but clusters near horizontal, which
      // is how a conifer frond actually presents.
      // Roll spreads the cards through the volume, but not so far that half of
      // them present edge-on: a card seen at a grazing angle renders as a dark
      // sliver and a crown full of them reads as paint strokes.
      const roll = snowy
        ? (rnd() < 0.5 ? 1 : -1) * (1.35 + rnd() * 0.42)
        : (rnd() - 0.5) * 1.45 + (i % 2 ? 0.42 : -0.42);
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
      // 1/SPRIG_SCALE: the tile art now stops short of the tile border, so the
      // quad has to be that much bigger for the *foliage* to keep its size.
      const size = Math.max(w * (o.size || 1) * (0.42 + 0.42 * rnd()), 0.05 * (o.size || 1))
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
      const px = V0.x - ax * len * 0.10, py = V0.y - ay * len * 0.10, pz = V0.z - az * len * 0.10;
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
    const t = S.bare + (1 - S.bare) * (1 - uj) * brokeAt;
    const anchor = trunkAt(t).clone();

    // The profile floor matters: without it the top three or four whorls came
    // out shorter than the cull threshold and were dropped, which left the
    // leader standing as a bare stick out of the crown.
    const prof = (0.085 + 0.915 * Math.pow(u, S.crown))
      * (0.46 + 0.54 * smoothstep(0, 0.16, u))
      * (1 - (0.26 + 0.26 * AGE) * smoothstep(0.74, 1.0, u));
    const L = S.spread * SPREADK * H * (2.0 * prof) * (0.80 + 0.40 * rnd());
    if (L < 0.05) continue;

    const nb = lod === 0
      ? Math.max(4, Math.round(3.2 + 2.6 * u))
      : Math.max(3, Math.round(2.2 + 1.4 * u));
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
      if (lod === 0 && BL > 1.3) {
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
        : Math.round(3 + 2.4 * Math.min(1, BL / 2.2));
      sprigs(at, wid, 0.12, 1.0, nCards, { sprig: S.sprig, size: 1.0, shade: false });
      // a shaded card tucked underneath, so the crown has an inside
      if (lod === 0 && !dead) {
        sprigs((s) => R2.copy(at(s)).setY(R2.y - wid(s) * 0.50), wid, 0.28, 0.88,
          2, { sprig: S.sprig, size: 0.9, shade: true, snowK: 0.05 });
      }

      // ---- sub-branches ----------------------------------------------------
      const nSub = lod === 0 ? S.sub : 0;
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
        sprigs(sAt, sWid, 0.05, 1.0, Math.round(4 + 3 * Math.min(1, SBL / 1.4)),
          { sprig: S.sprig, size: 0.9, shade: false });
      }

      // ---- snow load along the crest ---------------------------------------
      // A shallow tented strip mapped to the blanket tile: both lips fray to
      // nothing in the texture, so this never shows a polygon edge. Rows may
      // collapse entirely — real load sits in clumps with bare needles between.
      if (!dead && rnd() < branchLoad * (0.55 + 0.45 * (1 - u)) * 2.1) {
        const rowsN = lod === 0 ? 4 : 2;
        const start = 0.06 + 0.12 * rnd();
        const rows = [];
        for (let k = 0; k <= rowsN; k++) {
          const s = start + (1 - start) * (k / rowsN);
          const p = at(s).clone();
          const cap = smoothstep(0.94, 0.62, s) * smoothstep(start - 0.02, start + 0.22, s);
          const jit = 1.45 * vnoise2(k * 3.17 + ti * 4.1 + bi * 2.9, si * 7.3 + bi * 1.3) - 0.20;
          if (jit < 0.14) { rows.push(null); continue; }
          const w = Math.min(wid(s) * 1.15, wid(s) * 1.05 * jit * cap * (0.6 + 0.7 * branchLoad));
          if (w < 0.006) { rows.push(null); continue; }
          const mean = (vnoise2(k * 2.7 + bi * 5.1, ti * 3.3) - 0.5) * wid(s) * 0.24;
          // the rind sits proud of the foliage: a real load is 10-20 cm of snow
          // riding ON the needles, not a decal painted into them
          const lift = wid(s) * 0.34;
          const cyc = p.y + lift;
          const tv = 0.92 + 0.16 * vnoise2(k * 7.7 + bi * 3.3, ti * 5.1 + 19.3);
          const crest = [1.06 * tv, 1.08 * tv, 1.14 * tv];
          const lipc = [0.60 * tv, 0.68 * tv, 0.88 * tv];
          const fl = clamp((p.y + 0.35) / H, 0, 1) * (0.30 + 0.7 * s);
          const mx = p.x + side.x * mean, mz = p.z + side.z * mean;
          // monotonic: a wrapped u would make one quad interpolate backwards
          // through the whole tile and smear it
          const us = clamp((s - start) / (1 - start), 0, 1);
          // Four columns give the rind a rounded section: two lips that drop
          // below the needle plane and a broad crest between them. Three read
          // as a folded paper tent.
          const shoul = [0.90 * tv, 0.94 * tv, 1.02 * tv];
          const cols = [
            [-w, -0.52, lipc, 0.01, 0.94],
            [-w * 0.42, 0.30, shoul, 0.30, 0.36],
            [w * 0.42, 0.30, shoul, 0.70, -0.36],
            [w, -0.52, lipc, 0.99, -0.94],
          ];
          const row = [];
          gb.tw = 0.06;
          for (const cdef of cols) {
            const off = cdef[0];
            const uv = uvBlanket(us, cdef[3]);
            const sx2 = cdef[4], ny2 = Math.sqrt(Math.max(0.04, 1 - sx2 * sx2));
            row.push(gb.v(
              mx + side.x * off, cyc + cdef[1] * Math.abs(off || w), mz + side.z * off,
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
    const nL = lod === 0 ? 5 : 2;
    for (let k = 0; k < nL; k++) {
      const th = (k / nL) * Math.PI * 2 + rnd();
      const dx = Math.cos(th), dz = Math.sin(th);
      const at = (s) => P.set(top.x + dx * rTip * 2.0 * s, top.y - hTip * 0.5 + hTip * 1.5 * s,
        top.z + dz * rTip * 2.0 * s);
      const wid = () => rTip * 1.5;
      sprigs(at, wid, 0.1, 0.95, lod === 0 ? 3 : 1, { sprig: S.sprig, size: 0.9, snowK: 1.5 });
    }
    if (LOAD > 0.4) {
      const n = lod === 0 ? 6 : 4;
      const ringsT = [
        { y: top.y - hTip * 0.15, r: rTip * 1.0, c: [0.90, 0.94, 1.02] },
        { y: top.y + hTip * 0.62, r: rTip * 0.44, c: [1.06, 1.09, 1.16] },
        { y: top.y + hTip * 1.10, r: rTip * 0.10, c: [1.10, 1.12, 1.18] },
      ];
      const rows = ringsT.map((rg, ri) => {
        const out = [];
        for (let k = 0; k < n; k++) {
          const th = (k / n) * Math.PI * 2;
          const nx = Math.cos(th), nz = Math.sin(th);
          const uv = uvSnow(k / n, 0.2 + ri * 0.3);
          out.push(gb.v(top.x + nx * rg.r, rg.y, top.z + nz * rg.r,
            nx * 0.62, 0.78, nz * 0.62, uv[0], uv[1], rg.c[0], rg.c[1], rg.c[2], 0.95));
        }
        return out;
      });
      for (let ri = 0; ri < rows.length - 1; ri++) {
        for (let k = 0; k < n; k++) {
          const k2 = (k + 1) % n;
          gb.quad(rows[ri][k], rows[ri][k2], rows[ri + 1][k2], rows[ri + 1][k]);
        }
      }
    }
  }

  // ---- tree well: snow collar banked against the trunk, then a ring of
  // dropped needle litter. The litter ring is what actually reads as a tree
  // well; without it the stem meets a clean white sheet on a hard line.
  {
    const n = lod === 0 ? 10 : 6;
    const R = Math.max(0.6, S.trunkR * 3.1 + H * 0.026);
    const hM = R * 0.34;
    const ctr = gb.v(0, hM - 0.30, 0, 0, 1, 0, ...uvSnow(0.5, 0.5), 1.05, 1.07, 1.12, 0);
    const ring = [];
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2;
      const bank = 0.72 + 0.5 * vnoise2(k * 1.7, si * 3.3) + 0.34 * clamp(Math.cos(th - wind), 0, 1);
      const rr = R * bank;
      const uv = uvSnow(0.5 + 0.4 * Math.cos(th), 0.5 + 0.4 * Math.sin(th));
      ring.push(gb.v(Math.cos(th) * rr, -0.30 - 0.10 * clamp(-Math.cos(th - wind), 0, 1),
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
function buildCard(cell, cells, width, above, below, nq) {
  const gb = new GB();
  // A card is a whole tree, half of it snow. Taking the per-instance foliage
  // hue at full weight turned the rime on a warm-tinted instance yellow-green.
  gb.tw = 0.40;
  const inset = 8 / 512 / cells;
  const u0 = cell / cells + inset, u1 = (cell + 1) / cells - inset;
  const v0 = 0.004, v1 = 0.996;
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
  function patchFoliage(mat, key, spec = 0.04) {
    const uLod = mat.__uLod;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.uniforms.uCam = uniforms.uCam;
      shader.uniforms.uSway = uniforms.uSway;
      shader.uniforms.uLod = uLod;
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
        // dithered against an interleaved-gradient hash that rotates every
        // frame; the TAA resolve integrates it into a soft, correctly
        // anti-aliased edge at no extra fill cost.
        .replace('#include <alphatest_fragment>', /* glsl */`
          #ifdef USE_ALPHATEST
            float aCov = ( diffuseColor.a - alphaTest ) /
                         max( fwidth( diffuseColor.a ), 1e-4 ) + 0.5;
            if ( aCov < 1.0 ) {
              vec2 ipx = gl_FragCoord.xy + fract( uTime * 3.7 ) * 137.0;
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
    mat.customProgramCacheKey = () => key;
    return mat;
  }

  /**
   * Prop patch: screen-space minimum width. `aRad` is the world radius of the
   * cross-section a vertex sits on; below the floor the section is expanded
   * along its own normal so a 6 cm lattice diagonal or a 6 cm haul rope keeps
   * a stable, non-shimmering silhouette all the way out. Without it the cable
   * simply vanishes past ~180 m and leaves chairs hanging in mid-air.
   */
  function patchProp(mat, key) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uMinR = uniforms.uMinR;
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
          float kExp = max( 1.0, ( uMinR * vDist ) / max( aRad, 1e-4 ) );
          transformed += normalize( normal ) * aRad * ( kExp - 1.0 );
        `);
    };
    mat.customProgramCacheKey = () => key;
    return mat;
  }

  /** A foliage material bound to one LOD band. Same program, own uniforms. */
  function bandMat(proto, band, key, spec) {
    const m = proto.clone();
    m.__uLod = { value: new THREE.Vector4(band[0], band[1], band[2], band[3]) };
    return patchFoliage(m, key, spec);
  }

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
  const matTree0 = bandMat(protoTree, B_G0, 'sc-fol');
  const matTree1 = bandMat(protoTree, B_G1, 'sc-fol');
  const matLog0 = bandMat(protoTree, B_LOG0, 'sc-fol');
  const matLog1 = bandMat(protoTree, B_LOG1, 'sc-fol');

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
  const matImp = bandMat(protoImp, B_IMP, 'sc-card', 0);
  const matCl = bandMat(protoImp, B_CL, 'sc-card', 0);
  matCl.map = clTex;
  const matMass = bandMat(protoImp, B_MASS, 'sc-card', 0);
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
  // Impostor cell per (species, variant). Saplings and krummholz never get one.
  // Six cells over four card species means neighbouring stems in the 92-210 m
  // band rarely share a silhouette.
  const impCell = (si, k) => (si === 0 ? k % 2 : si === 1 ? 2 : si === 2 ? 3 : 4 + (k % 2));

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
      p2 = new Pool(buildCard(impCell(V.si, V.k), IMP_CELLS, V.impW, V.impH, 0.35, 3),
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
    const p = new Pool(buildCard(c, 4, CL_W, CL_H - CL_SINK, CL_SINK, 3), matCl, 2800,
      { name: 'clust', receiveShadow: false });
    pools.cluster.push(p);
    group.add(p.mesh);
    const q = new Pool(buildCard(c, 4, MASS_W, MASS_H - MASS_SINK, MASS_SINK, 2), matMass, 1900,
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
  const CL_SPACING = 10.5;
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
    if (si !== 4 && rn() < 0.05 + 0.05 * high) si = 5;      // snags
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
    for (const cfg of [
      { sp: CL_SPACING, k: 4, jit: 0.55 },
      { sp: MASS_SPACING, k: 5, jit: 0.45 },
    ]) {
      const n = Math.max(1, Math.round(CHUNK / cfg.sp));
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          const px = x0 + (a + 0.5 + (rn() - 0.5) * cfg.jit) * (CHUNK / n);
          const pz = z0 + (b + 0.5 + (rn() - 0.5) * cfg.jit) * (CHUNK / n);
          field.probe(px, pz, probe);
          const d = forestAt(px, pz, probe);
          if (d < 0.05 || rn() > 0.52 + 0.90 * d) continue;
          items.push({
            k: cfg.k, v: cardCell(d), x: px, y: terrain.height(px, pz), z: pz,
            r: rn() * Math.PI * 2,
            s: 0.86 + 0.30 * rn(), sy: 0.86 + 0.30 * rn(),
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

  function boxAt(gb, pos, size, rotY, col) {
    _qq.setFromAxisAngle(UP, rotY);
    _mm.compose(pos, _qq, size);
    gb.add(BOX, _mm, col);
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

  buildLift();
  buildProps();

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
    chairPool.mesh.instanceMatrix.needsUpdate = true;
  }

  // =========================================================================
  let time = 0;

  return {
    group,

    update(dt, state) {
      time += dt || 0;
      uniforms.uTime.value = time;
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

      for (const pool of allPools) pool.flush();
      updateChairs(px, pz, dt || 0);
    },

    dispose() {
      for (const t of [treeTex, treeAtlas.nrm, impTex, clTex, massTex, netTex]) t.dispose();
      for (const m of [protoTree, protoImp, protoRock, protoSnow, matTree0, matTree1,
        matLog0, matLog1, matImp, matCl, matMass, matRock0, matRock1,
        matDrift0, matDrift1, matPaint, matNet]) m.dispose();
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      scene.remove(group);
    },
  };
}
