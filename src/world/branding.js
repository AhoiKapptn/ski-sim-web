/**
 * Slope-side branding — sponsor boards at the piste edge.
 *
 * Four objects on a 1.4 km run: two A-frame sandwich boards (AhoiKapptn!, the
 * black lockup printed on a light panel) and two low advertising banners on
 * posts standing in front of the B-net runs (BTM, white PVC). Nothing else. The
 * brief was "keep it very subtle", which is read here as a hard constraint: this
 * is what a sponsored piste looks like from the chair, not an ad hoarding.
 * Sizes, tints and counts are all set against that, and the numbers are in the
 * block comment above PLACEMENTS.
 *
 * A fifth object — a feather flag near the start — was built and then DELETED.
 * Two measured reasons, both fatal, neither rescuable by tuning:
 *   * its blade tapered to 0.30 of full chord at foot and tip while the print
 *     spanned the whole atlas region on every row, so the artwork was squeezed
 *     3.3x in the letter-height direction at both ends. "AhoiKapp" read and
 *     "tn!" was a sheared smear. Real feather-flag artwork is laid out TO the
 *     blade outline; it is never stretched into the taper. The old comment
 *     claiming otherwise was simply wrong about how flags are made.
 *   * at 40 m the roll of the piste hid all but 5 px of its 289 px silhouette,
 *     and its print was illegible past ~8 m.
 * Most cost of the five, least delivered. Do not re-add it without laying the
 * artwork out to the blade outline — and note that "nothing flutters" is NOT a
 * defect worth fixing either: at the 21x47 px the flag actually occupied, a
 * 2-3 px sway is indistinguishable from the TAA shimmer already in the frame.
 *
 * ---------------------------------------------------------------------------
 * BINARY ASSET EXCEPTION — `public/brand/btm.png`
 *                          `public/brand/ahoikapptn-black.png`
 *
 * This project has no binary art assets and that rule still stands for
 * everything else: no other downloaded texture, no new dependency, every other
 * texture in the repo is generated in code. These two files are a deliberate,
 * scoped exception granted by the owner of the marks, because they are HIS
 * BRAND and an approximation of a wordmark is not the same object as the
 * wordmark. They are the only two images in the repo — exactly two, both used;
 * the white-on-black AhoiKapptn! lockup the first build shipped with is gone,
 * because the colourway it forced could not survive this scene's light (below).
 * Do not read these as the start of an asset pipeline.
 *
 * Both are loaded, composited onto a printed panel on an offscreen canvas, and
 * uploaded as ONE atlas. Their alpha channels are NOT alike and that difference
 * is load-bearing:
 *
 *   btm.png              ink on transparency, coarse edges. Drawn source-over
 *                        onto a white PVC banner, so transparent -> white and
 *                        the panel is what fills the alpha. See paintBtmInk().
 *   ahoikapptn-black.png the official inverted lockup: black artwork on REAL
 *                        alpha. Also drawn source-over, onto a light slate
 *                        panel. It must NOT go through the `globalCompositeOp =
 *                        'lighter'` trick the first build used for the
 *                        white-on-black file — black added to anything adds
 *                        nothing, so that path renders a blank board.
 *
 * Either way nothing is keyed out at render time: each mark is PRINT on an
 * opaque panel, which is how both would really be produced for a slope. So
 * there is no alphaTest anywhere in this file: no coverage mip chain, no
 * stochastic dither, no cut-out fringe to alias.
 * ---------------------------------------------------------------------------
 *
 * Hazards this file is written against — each one is a diagnosis this project
 * already paid for once (see CLAUDE.md):
 *
 *  * F0 = 0.04 on a flat card is what made the distant conifers render as white
 *    ice shards: a quad's shading normal points at the sky and it collects the
 *    dielectric specular reflection of the whole dome. `envMapIntensity` cannot
 *    fight it (three overwrites it with `scene.environmentIntensity`), so
 *    `material.specularColor` is forced to 0 in the fragment shader, exactly as
 *    `matCl`/`matImp` in scatter.js do it. Verified to hold out to 77 deg off
 *    normal at every sun elevation.
 *  * NO PRINTED FACE IN THIS MODULE EVER RECEIVES DIRECT SUN, and that is not a
 *    bug to be lit away — it is the geometry of the feature. sky.js pins the
 *    time of day at tod = 0.302 (sun ~23 deg) and every panel here is
 *    deliberately turned UPHILL at the descending player, so N.L < 0 on all of
 *    them, always. The printed face is lit by snowfield bounce and sky fill and
 *    nothing else. The first build printed the mark white on a #39404a board
 *    and measured L* 9-14 — a luminance ratio of 0.027 against the snow beside
 *    it, where CLAUDE.md's protected treeline band is 0.25-0.45. That is a hole
 *    cut in the slope. A 5.6%-albedo panel cannot be rescued by an ambient
 *    tweak, so the fix was ALBEDO: light panel, dark mark. See AK_BASE for the
 *    numbers this actually lands on. The bounce + sky-fill ambient below is
 *    still needed (an unlit face integrates to almost nothing against an IBL
 *    with an empty lower hemisphere) and still runs off scatter's OWN uniform
 *    objects when they are exposed, so a board is lit by the identical radiance
 *    as the hut behind it.
 *  * Thin geometry below one pixel of width shimmers. The banner posts carry
 *    `aRad` and the same screen-space width floor as scatter's props.
 *  * Fine high-contrast print at a few px/period beats against the pixel grid
 *    (the corduroy cross-hatch). Mitigated by area: no logo is ever drawn at a
 *    scale where its letterforms are a few px, because the panels are small and
 *    the print sits inside a quiet margin, so the mip average of a distant
 *    banner is pale off-white rather than a comb. Trilinear + aniso 8, no
 *    alpha test, no repeat wrapping.
 *  * The centreline is NOT re-derived. `corridorX0` lives in terrain.js and
 *    scatter.js and a third copy is the exact ambiguous seam that has caused
 *    every integration failure here, so the corridor is reconstructed from
 *    scatter's public placement seam instead: the lift towers give the SHAPE
 *    (they are on `corridorX(z) + LIFT_OFFSET`) and any building gives the
 *    constant (`b.x - b.off` is `corridorX(b.z)` exactly). Agreement with the
 *    formula is a measurement, see `debug.centrelineCheck` — 9.18 mm worst case
 *    over the whole run.
 *  * A capture must never quietly contain the fallback letterforms. The mesh is
 *    therefore HIDDEN until `ready` resolves; see the note at `scene.add`.
 *
 * Everything is merged into one geometry with one material: 1 draw call, ~230
 * triangles, no per-frame work beyond copying three uniforms.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------- files --
// Served out of `public/`, so Vite hands them over untouched in dev and copies
// them to the site root in a build. Through BASE_URL so a non-root deployment
// still finds them.
const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';
const SRC_BTM = BASE + 'brand/btm.png';
const SRC_AK = BASE + 'brand/ahoikapptn-black.png';

// --------------------------------------------------------------------- panels --
// metres. Everything is deliberately small: a real piste banner is knee-high
// and 2.5 m long, and a sandwich board is a metre wide.
// Each aspect ratio MATCHES its atlas region to within 0.05% (see R_* below) so
// no print is stretched. Sized from a measured pass rather than by eye: at the
// ~30 m the player actually goes by a banner, 2.30 m of width is 75 px.
// The first build used 1.05 x 0.62 m panels and the mark mipped away to a grey
// smear at every distance the game is ever played at.
//
// BANNER_H went 0.70 -> 0.86 to make the mark bigger, which is the whole reason
// for the number. The mark is HEIGHT-limited inside the banner (its content box
// is 1.47:1 against a 2.7:1 panel), so the only two levers on how big it reads
// are the vertical margin and the panel height; widening the panel does nothing.
// Margin 0.11 -> 0.06 is worth +12.8% linear on its own, and the extra 16 cm of
// panel takes the total to +38.6% (readable mark height 0.546 -> 0.757 m). It
// also drops the bottom hem from 0.46 m clear of the snow to 0.30 m, which is
// the difference between an obviously floating banner and a plausible one.
const BANNER_W = 2.30, BANNER_H = 0.86, BANNER_TOP = 1.16;
// BOARD_LEAN 0.20 -> 0.34 rad. At 0.20 the A-frame read as a flat rectangle at
// every distance the player passes it: 0.15 m of base half-spread is under a
// pixel of parallax at 28 m, and both faces are in shade so the ridge produced
// no value break either. 0.34 rad is 0.25 m half-spread (a 0.51 m base under a
// 1.30 m board, which is what a real sandwich board does) and the two faces now
// carry slightly different tints so the ridge is visible as a step.
const BOARD_W = 1.30, BOARD_H = 0.76, BOARD_LEAN = 0.34;   // rad from vertical

/**
 * Where the branding stands, as (z along the fall line, metres off the corridor
 * centreline). The player starts at z = 700 and descends -z, so the list is in
 * the order it is met.
 *
 * The offsets are picked to sit in the gaps in scatter.js' own furniture, which
 * is why they are these numbers and not round ones. Re-read off scatter.js, not
 * off the previous version of this comment:
 *
 *   13..21 m  slalom gates            26 m       THESE BOARDS (piste edge)
 *   38..43 m  piste marker poles      41..47 m   snow guns
 *              (scatter.js:4583)                  (:4607, PISTE_HALF-5 + 0..6)
 *   49.5 m    THESE BANNERS           54 m       B-net line (:4735)
 *   54..55.5 m  B-net posts and their back stays, which lean OUTBOARD, away
 *               from the piste — so nothing of the net structure comes inboard
 *               of 54 m and a banner at 49.5 m has 4.5 m of clear snow in front
 *               of the fence. (The old table said the stays were at 52.5 m,
 *               i.e. inboard. They are not.)
 *
 * A banner therefore stands ~4.5 m in front of the safety net, which is exactly
 * where a race hoarding goes, and a sandwich board sits well inside the marker
 * line on groomed snow, 5 m outside the gate line the player actually skis —
 * close enough that the mark resolves for the second it is alongside, and far
 * enough that it is never in the ski line.
 *
 * Both banners are in front of a real B-net run: scatter's runs are
 * (sgn +1, z 560..300) and (sgn -1, z 120..-170), which is what fixes the SIGN
 * of the two banner offsets.
 */
const PLACEMENTS = [
  // The run's first object. It stands where the deleted feather flag stood
  // (z 662, off -31), because that slot was already verified clear from the hero
  // framing and it is the only object the player meets in the first 200 m; a
  // board at the flag's old z on the board's own -26 m offset keeps that.
  { kind: 'board', z: 664, off: -26.0, yaw: 0.36, tint: 0.96 },
  { kind: 'banner', z: 516, off: 49.5, yaw: -0.20, tint: 0.97 },
  { kind: 'board', z: 128, off: -26.0, yaw: 0.40, tint: 0.93 },
  { kind: 'banner', z: -104, off: -49.5, yaw: 0.26, tint: 0.95 },
];

// ------------------------------------------------------------------- utilities --
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The documented centreline. Used ONLY as the fallback — see the header. */
const corridorFormula = (z) => 78 * Math.sin(z * 0.00092) + 34 * Math.sin(z * 0.00231 + 1.3);

/**
 * Reconstruct the corridor centreline from scatter's public placement seam.
 *
 * `lift.towers[i]` sit on `corridorX(z) + LIFT_OFFSET` with LIFT_OFFSET a
 * private constant, so the towers give the curve up to an unknown constant;
 * `buildings[i]` carry both `x` and `off` with `x = corridorX(z) + off`, so
 * each building pins that constant exactly. Median over the buildings so one
 * odd entry cannot move it.
 *
 * Catmull-Rom through the tower table. The centreline's shortest wavelength is
 * 2.7 km and the towers are 104 m apart, so the interpolant is exact to well
 * under a centimetre — linear interpolation would already be within 33 cm, and
 * the cubic is measured in `centrelineCheck()`.
 */
function centrelineFromSeam(scatter) {
  const T = scatter?.lift?.towers;
  const B = scatter?.buildings;
  if (!T || T.length < 4 || !B || !B.length) return null;
  const zs = new Float64Array(T.length), xs = new Float64Array(T.length);
  for (let i = 0; i < T.length; i++) { zs[i] = T[i].z; xs[i] = T[i].x; }
  for (let i = 1; i < zs.length; i++) if (!(zs[i] > zs[i - 1])) return null;

  const spline = (z) => {
    // uniform table by construction; bisect anyway rather than assume the step
    let lo = 0, hi = zs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (zs[m] <= z) lo = m; else hi = m; }
    const i1 = lo, i2 = hi;
    const i0 = Math.max(0, i1 - 1), i3 = Math.min(zs.length - 1, i2 + 1);
    const t = (z - zs[i1]) / (zs[i2] - zs[i1]);
    const p0 = xs[i0], p1 = xs[i1], p2 = xs[i2], p3 = xs[i3];
    const m1 = 0.5 * (p2 - p0), m2 = 0.5 * (p3 - p1);
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1
         + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2;
  };

  const ds = B.map((b) => (b.x - b.off) - spline(b.z)).sort((a, b) => a - b);
  const off = ds[ds.length >> 1];
  const f = (z) => spline(clamp(z, zs[0], zs[zs.length - 1])) + off;
  f.liftOffset = -off;   // recovered LIFT_OFFSET, for the diagnostic
  return f;
}

// ===========================================================================
// Atlas
// ===========================================================================
// One 1024^2 canvas, one texture, one draw call. Regions in canvas pixels,
// y = 0 at the TOP of the canvas; `uvR` flips because CanvasTexture uploads
// with flipY.
const AT = 1024;
// The feather flag's 256x700 region went with the flag, and all of it went into
// the two regions that carry print — which is the only place resolution does
// anything. R_AK is 3.5x the pixels it had (960x561 against 512x300, i.e. 1.87x
// linear) and R_BTM is 1.23x. The four unprinted regions are flat procedural
// noise with no structure in them at all, so they lost half their area and cost
// nothing for it; R_PAINT is sampled along a single row and R_SNOW along two.
const R_BTM    = [0, 0, 1024, 383];     // 2.674:1, the banner face
const R_AK     = [0, 391, 960, 561];    // 1.711:1, the sandwich-board face
const R_BACK   = [0, 958, 248, 66];     // banner reverse, unprinted PVC
const R_BOARDB = [256, 958, 248, 66];   // board reverse, unprinted panel
const R_SNOW   = [512, 958, 248, 66];   // crust along a top edge, drift at a foot
const R_PAINT  = [768, 958, 248, 66];   // galvanised post / frame

/** s,t in 0..1 across a region; t = 0 is its BOTTOM edge in world terms. */
function uvR(r, s, t) {
  const e = 2.0;                                    // texel inset, keeps mip
  const x = r[0] + e + s * (r[2] - 2 * e);          // levels from bleeding
  const y = r[1] + e + (1 - t) * (r[3] - 2 * e);    // between regions
  return [x / AT, 1 - y / AT];
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Content bounding box, so a mark with a big empty margin still fills a panel. */
function contentBox(img, mode) {
  const s = 320 / Math.max(img.width, img.height);
  const w = Math.max(2, Math.round(img.width * s)), h = Math.max(2, Math.round(img.height * s));
  const cv = makeCanvas(w, h);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const ink = mode === 'alpha'
        ? d[i + 3] > 24
        : (d[i + 3] > 24 && 0.30 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2] > 40);
      if (!ink) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: img.width, h: img.height };
  const k = 1 / s;
  return {
    x: Math.max(0, (x0 - 0.5) * k), y: Math.max(0, (y0 - 0.5) * k),
    w: Math.min(img.width, (x1 - x0 + 2) * k), h: Math.min(img.height, (y1 - y0 + 2) * k),
  };
}

/** Fit a box of aspect `a` into a rect with margins, centred. */
function fitBox(rx, ry, rw, rh, a, mx, my) {
  const iw = rw * (1 - 2 * mx), ih = rh * (1 - 2 * my);
  let w = iw, h = w / a;
  if (h > ih) { h = ih; w = h * a; }
  return [rx + (rw - w) * 0.5, ry + (rh - h) * 0.5, w, h];
}

// ------------------------------------------------------------------ weathering --
/**
 * What keeps a printed panel from reading as UI: it is dirty, it has been
 * rained on, snow has collected in its bottom edge, and it is lit by the same
 * sun as everything else. The last part is the shader's job; the first three
 * are painted here, into the texture, where they cost nothing.
 *
 * `crust` is opt-OUT and every caller must think about it, because it paints
 * settled snow along the panel's bottom edge and that is only true if the panel
 * HAS a bottom edge on the ground. The BTM banner's hem hangs 0.30 m clear of
 * the snow, so its crust was snow settled on thin air — plainly visible in the
 * atlas dump. It gets `crust: false` and a geometric drift at its post feet
 * instead (see snowDrift), which is where the real ground contact is.
 */
function weather(g, x, y, w, h, rnd, opts = {}) {
  const dark = opts.dark ? 1 : 0;
  // vertical wash: a panel is dirtier at the bottom and sun-bleached at the top
  const grad = g.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, dark ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.06)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.0)');
  grad.addColorStop(1, dark ? 'rgba(0,0,0,0.18)' : 'rgba(96,88,74,0.16)');
  g.fillStyle = grad;
  g.fillRect(x, y, w, h);

  // grit thrown up off the piste: fine spatter that dies out with height
  for (let i = 0; i < Math.round(w * h * 0.0016); i++) {
    const px = x + rnd() * w;
    const t = rnd() * rnd();                       // biased to the bottom
    const py = y + h - t * h * 0.62;
    const r = 0.6 + rnd() * 2.2;
    g.fillStyle = dark
      ? `rgba(210,214,220,${0.03 + rnd() * 0.05})`
      : `rgba(${92 + rnd() * 40 | 0},${86 + rnd() * 36 | 0},${74 + rnd() * 30 | 0},${0.04 + rnd() * 0.10})`;
    g.beginPath(); g.arc(px, py, r, 0, 6.2832); g.fill();
  }

  // two slack folds, because a banner is fabric on a frame
  for (let i = 0; i < 2; i++) {
    const px = x + w * (0.22 + rnd() * 0.56);
    g.strokeStyle = dark ? 'rgba(0,0,0,0.10)' : 'rgba(0,0,0,0.055)';
    g.lineWidth = 1.5 + rnd() * 2;
    g.beginPath(); g.moveTo(px, y); g.lineTo(px + (rnd() - 0.5) * 8, y + h); g.stroke();
  }

  // snow crust caught in the bottom edge, irregular top line
  if (opts.crust !== false) {
    const cH = h * (0.06 + 0.05 * rnd());
    g.beginPath();
    g.moveTo(x, y + h);
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const px = x + (i / n) * w;
      const py = y + h - cH * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(i * 1.7 + rnd() * 0.9)));
      g.lineTo(px, py);
    }
    g.lineTo(x + w, y + h);
    g.closePath();
    g.fillStyle = 'rgba(238,242,247,0.88)';
    g.fill();
  }
}

/** Flat noise fill for the unprinted regions. */
function noiseFill(g, r, base, amp, rnd) {
  g.fillStyle = base;
  g.fillRect(r[0], r[1], r[2], r[3]);
  for (let i = 0; i < r[2] * r[3] * 0.03; i++) {
    const px = r[0] + rnd() * r[2], py = r[1] + rnd() * r[3];
    g.fillStyle = `rgba(${amp[0]},${amp[1]},${amp[2]},${0.03 + rnd() * 0.07})`;
    g.fillRect(px, py, 1 + rnd() * 2, 1 + rnd() * 2);
  }
}

// -------------------------------------------------------- fallback letterforms --
/**
 * Drawn only if a PNG fails to load, so a missing file degrades to a plausible
 * board instead of a blank one — and so the first frames are never empty while
 * the real images are still in flight. Deliberately approximate; the shipped
 * look is the real artwork, and `--fallback` on tools/brand-shot.mjs is the only
 * way to see this.
 *
 * The proportions were measured off the original at 960 px: cap height 0.40 of
 * the mark box, stems 0.23 of the cap, and — the thing that is not obvious by
 * eye — the "italic" is a **vertical shear** of about -10 deg, so every
 * horizontal slopes up to the right while the stems stay dead upright. The mark
 * to the right of the letters is an open speech bubble (it is a podcast logo):
 * right edge, bottom edge, a tail hanging off the bottom, and the rest of the
 * bottom edge continuing to the left of the tail.
 *
 * The whole-composition shear is NOT reproduced here. A first version applied it
 * as a canvas transform and the letters, being scaled by the same matrix, walked
 * out of the panel and collided with the bubble. An oblique face plus square
 * bars is worse artwork and better behaviour, which is the right trade for a
 * path that only runs when the real file is missing.
 */
function drawBtmFallback(g, x, y, w, h) {
  g.save();
  g.fillStyle = '#f2ec1a';
  const cap = h * 0.44;
  g.font = `italic 700 ${(cap * 1.35).toFixed(1)}px system-ui, sans-serif`;
  const tw = g.measureText('BTM').width;
  if (tw > 1) g.font = `italic 700 ${(cap * 1.35 * (w * 0.60) / tw).toFixed(1)}px system-ui, sans-serif`;
  g.textBaseline = 'alphabetic';
  g.fillText('BTM', x + w * 0.06, y + h * 0.72);
  const bw = h * 0.085;
  g.fillRect(x + w * 0.94, y + h * 0.10, bw, h * 0.52);             // right edge
  g.fillRect(x + w * 0.70, y + h * 0.62 - bw, w * 0.24 + bw, bw);   // bottom edge
  g.fillRect(x + w * 0.70, y + h * 0.62, bw, h * 0.22);             // tail
  g.fillRect(x + w * 0.02, y + h * 0.84, w * 0.55, bw * 0.72);      // bottom, left of it
  g.restore();
}

/**
 * `ink` is a parameter and not a constant because the board colourway inverted:
 * the mark is now black artwork on a light panel, so a hard-coded off-white
 * fallback would have been invisible on exactly the path that exists to be
 * visible. It is passed AK_INK from the one place that knows the panel colour.
 */
function drawAkFallback(g, x, y, w, h, ink) {
  const WH = ink;
  const mh = h * 0.98, mx = x + h * 0.02;          // hexagon block is square-ish
  g.save();
  g.strokeStyle = WH; g.fillStyle = WH;
  g.lineWidth = mh * 0.085; g.lineJoin = 'miter'; g.lineCap = 'butt';
  const cx = mx + mh * 0.5, cy = y + h * 0.5, rr = mh * 0.46;
  const hx = (k) => cx + rr * Math.sin(k * Math.PI / 3);
  const hy = (k) => cy - rr * Math.cos(k * Math.PI / 3);
  // two open 3-edge polylines, offset so the hexagon never closes — that break
  // is the mark's whole character
  for (const s of [0, 3]) {
    const d = s === 0 ? -1 : 1;
    g.beginPath();
    g.moveTo(hx(s) + d * rr * 0.10, hy(s));
    for (let k = s + 1; k <= s + 3; k++) g.lineTo(hx(k) + d * rr * 0.10, hy(k));
    g.stroke();
  }
  // anchor: ring, stock, shank, barbed flukes
  const aw = mh * 0.34;
  g.lineWidth = mh * 0.075;
  g.beginPath(); g.arc(cx, cy - rr * 0.44, aw * 0.30, 0, 6.2832); g.stroke();
  g.fillRect(cx - aw * 0.60, cy - rr * 0.13, aw * 1.20, mh * 0.075);
  g.fillRect(cx - mh * 0.037, cy - rr * 0.16, mh * 0.075, rr * 0.72);
  g.lineWidth = mh * 0.070;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx, cy + rr * 0.52);
    g.lineTo(cx + s * aw * 0.86, cy + rr * 0.16);
    g.lineTo(cx + s * aw * 0.74, cy - rr * 0.10);
    g.stroke();
  }
  g.restore();
  // wordmark: light "Ahoi", bold "Kapptn!"
  const fs = h * 0.42, tx = mx + mh * 1.12;
  g.save();
  g.fillStyle = WH;
  g.textBaseline = 'middle';
  g.font = `300 ${fs}px system-ui, sans-serif`;
  g.fillText('Ahoi', tx, y + h * 0.52);
  const wA = g.measureText('Ahoi').width;
  g.font = `700 ${fs}px system-ui, sans-serif`;
  g.fillText('Kapptn!', tx + wA, y + h * 0.52);
  g.restore();
}

// -------------------------------------------------------------- the two inks --
/**
 * The AhoiKapptn! board's colourway. Both numbers exist for one measured
 * reason, recorded here because it is the fix for the module's worst defect:
 * no printed face in this file ever sees the sun (see the header), so a panel
 * has snowfield bounce and sky fill and nothing else. The first build's
 * #39404a board with a white mark rendered at L* 9-14 and a luminance ratio of
 * 0.027 against the snow beside it, against CLAUDE.md's protected 0.25-0.45
 * band — a hole cut in the slope, 13x below the floor. No ambient term rescues
 * a 5.6%-albedo panel; only albedo does. Hence a light panel and the owner's
 * official INVERTED (black-on-transparent) lockup.
 *
 * WHAT IT NOW MEASURES, at 1600x900 DPR 1. Denominator throughout is the ONE
 * validated near-piste snow crop in this project, (400,600) 300x120 on the hero
 * frame — linear relative luminance Y = 0.480, L* 73.6 / sd 10.8, which is the
 * documented 73.1/12.6 reproduced. Numerators are crops verified to contain only
 * board (CLAUDE.md trap 4):
 *
 *   board z 664, 27.7 m   24x8 at (853,474)   L* 42.6   Y 0.130   ratio 0.271
 *   board z 664 in hero   24x8 at (736,494)   L* 41.8   Y 0.127   ratio 0.265
 *   board z 128, 28.2 m   28x8 at (600,479)   L* 49.6   Y 0.183   ratio 0.381
 *
 * 0.27-0.38, inside the 0.25-0.45 band, against 0.027 before — 10x. For scale,
 * the scene's own shaded anchors are the hut wall at L* 31 and the near conifers
 * at L* 25, so the board is now a light object in shade and no longer darker
 * than the darkest thing on the hillside.
 *
 * If either number is touched, re-measure — do not reason about it. The two
 * crops are printed by tools/brand-shot.mjs (`rects`) and the denominator is the
 * hero crop above; note that a crop box tuned at 1600x900 lands on completely
 * different content in a DPR-2 PNG.
 */
const AK_BASE = '#b8bfc7';   // panel base; measured ratio 0.27-0.38, see above
const AK_INK = '#1c1f24';    // fallback letterforms only; the PNG carries its own

// ------------------------------------------------------------------ BTM ink --
/**
 * THE ONE PLACE the BTM ink is treated. Every decision about how that yellow
 * lands on the panel is in this function and nowhere else, deliberately.
 *
 * PENDING DECISION, do not pre-empt it: the artwork's #F0EC00 arrives on screen
 * at about L* 61, rgb(145,151,70) — olive-grey, not yellow. That is physically
 * correct for a shaded panel under a blue sky fill and it is being put to the
 * owner as a question, because "the brand yellow does not read as yellow" may
 * matter more than the realism does. If the answer comes back yes, this is the
 * lever: raise BTM_INK_LIFT. It overprints the ink with itself in 'lighter', so
 * only pixels the artwork actually covers move and the white PVC field is
 * untouched — no mask to maintain, no second region.
 *
 * Its ceiling is the 8-bit map: #F0EC00 is already at 240/236 in R/G, so a lift
 * much past ~0.06 only saturates and starts eating the ink's shape. If the
 * decision needs more than that, the real instrument is an emissiveMap keyed off
 * this image's alpha — and this is still the function to build it in, because it
 * is the only code in the module that knows where the ink is.
 */
const BTM_INK_LIFT = 0.0;
function paintBtmInk(g, img, bb, dx, dy, dw, dh) {
  if (!img) { drawBtmFallback(g, dx, dy, dw, dh); return; }
  g.drawImage(img, bb.x, bb.y, bb.w, bb.h, dx, dy, dw, dh);
  if (BTM_INK_LIFT > 0) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = BTM_INK_LIFT;
    g.drawImage(img, bb.x, bb.y, bb.w, bb.h, dx, dy, dw, dh);
    g.restore();
  }
}

// ===========================================================================
// Geometry builder — position / normal / uv / colour / aRad, merged into one
// indexed BufferGeometry.
// ===========================================================================
class GB {
  constructor() { this.p = []; this.n = []; this.u = []; this.c = []; this.r = []; this.i = []; }
  v(px, py, pz, nx, ny, nz, uu, vv, col, rad) {
    this.p.push(px, py, pz); this.n.push(nx, ny, nz); this.u.push(uu, vv);
    this.c.push(col[0], col[1], col[2]); this.r.push(rad || 0);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aRad', new THREE.Float32BufferAttribute(this.r, 1));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
  get tris() { return this.i.length / 3; }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _d = new THREE.Vector3(), _s = new THREE.Vector3(), _t = new THREE.Vector3();

/** Round tube a -> b. `rad` goes into aRad so the width floor can hold it. */
function tube(gb, a, b, rad, col, seg = 6) {
  _d.subVectors(b, a);
  const L = _d.length();
  if (L < 1e-5) return;
  _d.multiplyScalar(1 / L);
  _s.set(0, 1, 0);
  if (Math.abs(_d.y) > 0.94) _s.set(1, 0, 0);
  _s.crossVectors(_s, _d).normalize();
  _t.crossVectors(_d, _s);
  const ring = (p) => {
    const out = [];
    for (let k = 0; k < seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const nx = _s.x * Math.cos(th) + _t.x * Math.sin(th);
      const ny = _s.y * Math.cos(th) + _t.y * Math.sin(th);
      const nz = _s.z * Math.cos(th) + _t.z * Math.sin(th);
      out.push(gb.v(p.x + nx * rad, p.y + ny * rad, p.z + nz * rad, nx, ny, nz,
        ...uvR(R_PAINT, 0.5 + 0.4 * Math.cos(th), 0.5), col, rad));
    }
    return out;
  };
  const r0 = ring(a), r1 = ring(b);
  for (let k = 0; k < seg; k++) {
    const k2 = (k + 1) % seg;
    gb.quad(r0[k], r0[k2], r1[k2], r1[k]);
  }
}

/**
 * A printed panel: a quad grid with a catenary droop, front face UV'd into
 * `reg`, back face into `regBack`. `nu` segments across so the droop is smooth
 * and so a 2.6 m banner is not one enormous triangle pair for the shadow map.
 */
function panel(gb, o, u, v, w, h, reg, regBack, col, sag, nu = 4) {
  const nx = u.y * v.z - u.z * v.y, ny = u.z * v.x - u.x * v.z, nz = u.x * v.y - u.y * v.x;
  const nl = Math.hypot(nx, ny, nz) || 1;
  const N = [nx / nl, ny / nl, nz / nl];
  const front = [], back = [];
  for (let j = 0; j <= 1; j++) {
    const rowF = [], rowB = [];
    for (let i = 0; i <= nu; i++) {
      const s = i / nu, t = j;
      // fabric sags most at mid-span and most along its free lower edge
      const drp = sag ? sag * 4 * s * (1 - s) * (1 - t) : 0;
      const px = o.x + u.x * (s * w) + v.x * (t * h);
      const py = o.y + u.y * (s * w) + v.y * (t * h) - drp;
      const pz = o.z + u.z * (s * w) + v.z * (t * h);
      rowF.push(gb.v(px, py, pz, N[0], N[1], N[2], ...uvR(reg, s, t), col, 0));
      rowB.push(gb.v(px, py, pz, -N[0], -N[1], -N[2], ...uvR(regBack, 1 - s, t), col, 0));
    }
    front.push(rowF); back.push(rowB);
  }
  for (let i = 0; i < nu; i++) {
    gb.quad(front[0][i], front[0][i + 1], front[1][i + 1], front[1][i]);
    gb.quad(back[1][i], back[1][i + 1], back[0][i + 1], back[0][i]);
  }
  return N;
}

/** A 3 cm lip of settled snow along a panel's top edge. */
function snowLip(gb, o, u, v, w, h, depth, col) {
  const y = o.y + v.y * h, ox = o.x + v.x * h, oz = o.z + v.z * h;
  const nx = u.y * v.z - u.z * v.y, nz = u.x * v.y - u.y * v.x;
  const nl = Math.hypot(nx, nz) || 1;
  const a = [], b = [];
  const n = 5;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const wob = 0.55 + 0.45 * Math.sin(s * 9.1 + o.x * 0.7);
    a.push(gb.v(ox + u.x * s * w - (nx / nl) * depth * wob, y + depth * 0.35 * wob,
      oz + u.z * s * w - (nz / nl) * depth * wob, 0, 1, 0, ...uvR(R_SNOW, s, 0.2), col, 0));
    b.push(gb.v(ox + u.x * s * w + (nx / nl) * depth * wob, y + depth * 0.30 * wob,
      oz + u.z * s * w + (nz / nl) * depth * wob, 0, 1, 0, ...uvR(R_SNOW, s, 0.8), col, 0));
  }
  for (let i = 0; i < n; i++) gb.quad(a[i], a[i + 1], b[i + 1], b[i]);
}

/**
 * A low mound of settled snow round a post foot. This is the banner's GROUND
 * CONTACT cue, and it exists because the banner's hem hangs 0.30 m clear of the
 * snow: the previous build painted a snow crust along that hem instead, which is
 * snow settled on thin air. Snow does not collect on a free edge in mid-air; it
 * collects where something enters the snowpack, and that is the two posts.
 *
 * A fan, not a shell: 7 triangles a foot, one draw call's worth of nothing. Wound
 * CLOCKWISE in the (x,z) plane, which is the winding that faces UP — a
 * PlaneGeometry rotated -PI/2 about x maps +y in its own plane to -z in the
 * world, so the familiar CCW-is-front rule inverts when you lay a fan out with
 * atan2(z,x).
 */
function snowDrift(gb, x, y, z, r, h, col) {
  const n = 7;
  const c = gb.v(x, y + h, z, 0, 1, 0, ...uvR(R_SNOW, 0.5, 0.5), col, 0);
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = ((i % n) / n) * Math.PI * 2;
    const rr = r * (0.70 + 0.30 * Math.sin(a * 2.0 + x * 0.6));
    ring.push(gb.v(x + Math.cos(a) * rr, y, z + Math.sin(a) * rr, 0, 1, 0,
      ...uvR(R_SNOW, 0.5 + 0.45 * Math.cos(a), 0.5 + 0.45 * Math.sin(a)), col, 0));
  }
  for (let i = 0; i < n; i++) gb.tri(c, ring[i + 1], ring[i]);
}

// ===========================================================================
export function createBranding(scene, terrain, scatter) {
  const group = new THREE.Group();
  group.name = 'branding';

  const cx = centrelineFromSeam(scatter);
  const centre = cx || corridorFormula;

  // ------------------------------------------------------------- the atlas --
  const cv = makeCanvas(AT, AT);
  const g2 = cv.getContext('2d', { willReadFrequently: true });
  let painted = 'fallback';

  function paint(imgs) {
    const rnd = mulberry32(0xb1a5);
    g2.clearRect(0, 0, AT, AT);
    g2.imageSmoothingEnabled = true;
    g2.imageSmoothingQuality = 'high';

    // --- BTM: ink on transparency -> print on a white PVC banner ----------
    g2.fillStyle = '#eeefeb';
    g2.fillRect(...R_BTM);
    {
      // Centred, with the margins as tight as the panel can carry. The previous
      // build pushed the mark hard left inside a 0.055/0.11 margin and left 70%
      // of a 2.3 m banner as empty white: 348 of 1024 atlas px, a readable mark
      // ~0.55 m tall, which is the single biggest reason it never resolved at
      // the 20-30 m and 60-70 km/h the player actually passes it. The mark is
      // HEIGHT-limited here (content box 1.47:1 in a 2.67:1 panel), so `my` is
      // the lever that matters and `mx` does nothing at all; 0.11 -> 0.06 is
      // +12.8% linear, and the taller BANNER_H takes it to +38.6%.
      const bb = imgs?.btm ? contentBox(imgs.btm, 'alpha') : { w: 1.43, h: 1 };
      const [dx, dy, dw, dh] = fitBox(...R_BTM, bb.w / bb.h, 0.03, 0.06);
      paintBtmInk(g2, imgs?.btm, bb, dx, dy, dw, dh);
    }
    // grommets along the top and bottom hems
    for (let i = 0; i <= 6; i++) {
      const px = R_BTM[0] + 10 + (R_BTM[2] - 20) * (i / 6);
      for (const py of [R_BTM[1] + 9, R_BTM[1] + R_BTM[3] - 9]) {
        g2.strokeStyle = 'rgba(96,100,104,0.55)'; g2.lineWidth = 2.2;
        g2.beginPath(); g2.arc(px, py, 3.4, 0, 6.2832); g2.stroke();
      }
    }
    // crust: false — the hem hangs 0.30 m clear of the snow, see weather()
    weather(g2, ...R_BTM, rnd, { dark: false, crust: false });

    // --- AhoiKapptn!: the black lockup source-over onto a light board -------
    {
      // See AK_BASE for why this is light and not the slate the first build
      // used. The compositing is a plain source-over because this asset has
      // REAL alpha: the 'lighter' trick that the white-on-black file needed
      // would render a blank board here, since black adds nothing.
      g2.fillStyle = AK_BASE;
      g2.fillRect(...R_AK);
      const bb = imgs?.ak ? contentBox(imgs.ak, 'alpha') : { w: 4.61, h: 1 };
      const [dx, dy, dw, dh] = fitBox(...R_AK, bb.w / bb.h, 0.06, 0.10);
      if (imgs?.ak) g2.drawImage(imgs.ak, bb.x, bb.y, bb.w, bb.h, dx, dy, dw, dh);
      else drawAkFallback(g2, dx, dy, dw, dh, AK_INK);
      // dark:false now that the panel is light — the grit has to be darker than
      // what it lands on. Crust stays ON: unlike the banner, a board's bottom
      // edge really is 2 cm off the snow.
      weather(g2, ...R_AK, rnd, { dark: false });
    }

    // --- unprinted regions -------------------------------------------------
    noiseFill(g2, R_BACK, '#dfe1de', [110, 108, 100], rnd);
    weather(g2, ...R_BACK, rnd, { dark: false, crust: false });
    noiseFill(g2, R_BOARDB, '#a9b0b8', [92, 96, 102], rnd);
    weather(g2, ...R_BOARDB, rnd, { dark: false });
    noiseFill(g2, R_SNOW, '#eef3f8', [214, 222, 232], rnd);
    noiseFill(g2, R_PAINT, '#8d9298', [58, 60, 64], rnd);
  }

  paint(null);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;

  // ----------------------------------------------------------- the material --
  // Shared radiance. If scatter is in the scene we use ITS uniform objects, so
  // a board is lit by exactly the radiance the hut and the lift tower next to it
  // are; otherwise we run the same estimate locally off the key light.
  const own = !scatter?.uniforms?.uBounce;
  const uniforms = own ? {
    uBounce: { value: new THREE.Vector3(0.26, 0.26, 0.27) },
    uSkyFill: { value: new THREE.Vector3(0.03, 0.035, 0.04) },
    uMinR: { value: 6.0e-4 },
  } : {
    uBounce: scatter.uniforms.uBounce,
    uSkyFill: scatter.uniforms.uSkyFill,
    uMinR: { value: 6.0e-4 },
  };

  const mat = new THREE.MeshStandardMaterial({
    map: tex, vertexColors: true, roughness: 0.86, metalness: 0.0,
    side: THREE.FrontSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBounce = uniforms.uBounce;
    shader.uniforms.uSkyFill = uniforms.uSkyFill;
    shader.uniforms.uMinR = uniforms.uMinR;
    // screen-space width floor for the posts and the flag pole; aRad is 0 on
    // every panel vertex, and it MULTIPLIES the expansion, so panels are untouched
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aRad;
        uniform float uMinR;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        vec3 transformed = vec3( position );
        vec4 mvP = modelViewMatrix * vec4( transformed, 1.0 );
        float vDist = max( 1.0, -mvP.z );
        float kExp = max( 1.0, ( uMinR * vDist ) / max( aRad, 1e-4 ) );
        transformed += normalize( normal ) * aRad * ( kExp - 1.0 );
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform vec3 uBounce;
        uniform vec3 uSkyFill;
      `)
      // Snowfield bounce + dome fill. Without it the shaded face of a dark
      // board integrates to nothing and reads as a hole cut in the snow.
      .replace('#include <lights_fragment_end>', /* glsl */`
        #include <lights_fragment_end>
        {
          float wUp = dot( normal, viewMatrix[ 1 ].xyz );
          float dwn = clamp( 0.5 - 0.5 * wUp, 0.0, 1.0 );
          vec3 amb = uBounce * ( 0.78 * ( 0.30 + 0.70 * dwn ) )
                   + uSkyFill * ( 0.24 * ( 0.28 + 0.72 * ( 1.0 - dwn ) ) );
          reflectedLight.indirectDiffuse += amb * material.diffuseColor;
        }
      `)
      // F0 = 0.04 on a flat card reflecting the sky dome is the "white ice
      // shard" bug. A printed banner is not a polished slab at this distance.
      .replace('#include <lights_physical_fragment>', /* glsl */`
        #include <lights_physical_fragment>
        material.specularColor = vec3( 0.0 );
        material.specularColorBlended = vec3( 0.0 );
        material.specularF90 = 0.0;
      `);
  };
  mat.customProgramCacheKey = () => 'brand';

  // ------------------------------------------------------------- placement --
  const gb = new GB();
  const items = [];
  const ground = (x, z) => terrain.height(x, z);

  for (const P of PLACEMENTS) {
    const bx = centre(P.z) + P.off;
    // `yaw` is the compass angle of the printed face's normal: 0 looks straight
    // back up the fall line at the descending player, positive swings it toward
    // +x. Every P.yaw therefore has the sign that turns the panel IN toward the
    // corridor centreline, and none of them is 0 — a panel exactly square to
    // the camera is the thing that reads as UI.
    const fall = Math.atan2(centre(P.z + 8) - centre(P.z - 8), 16);
    const yaw = fall + P.yaw;
    const u = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));   // along the panel
    const v = new THREE.Vector3(0, 1, 0);
    const col = [P.tint, P.tint, P.tint * 1.005];
    const gcol = [P.tint * 0.96, P.tint * 0.96, P.tint * 0.98];
    const scol = [Math.min(1, P.tint * 1.04), Math.min(1, P.tint * 1.04), Math.min(1, P.tint * 1.06)];

    if (P.kind === 'banner') {
      // two posts, ground each one, hang the panel off the lower of the pair
      const hw = BANNER_W * 0.5;
      const p0 = new THREE.Vector3(bx - u.x * hw, 0, P.z - u.z * hw);
      const p1 = new THREE.Vector3(bx + u.x * hw, 0, P.z + u.z * hw);
      p0.y = ground(p0.x, p0.z); p1.y = ground(p1.x, p1.z);
      const top = Math.min(p0.y, p1.y) + BANNER_TOP;
      for (const p of [p0, p1]) {
        _a.set(p.x, p.y - 0.45, p.z);
        _b.set(p.x, top + 0.05, p.z);
        tube(gb, _a, _b, 0.055, gcol, 6);
        // the ground-contact cue, in geometry where the contact actually is
        // 0.22 m / 0.075 m. The first attempt at 0.185 / 0.042 rendered but was
        // invisible: 4 cm is inside the snow surface's own noise, so the mound
        // never broke the silhouette. Bigger than this and it reads as a white
        // plastic blob rather than drifted snow.
        snowDrift(gb, p.x, p.y - 0.02, p.z, 0.22, 0.075, scol);
      }
      const o = new THREE.Vector3(p0.x, top - BANNER_H, p0.z);
      panel(gb, o, u, v, BANNER_W, BANNER_H, R_BTM, R_BACK, col, 0.035, 5);
      snowLip(gb, o, u, v, BANNER_W, BANNER_H, 0.030, scol);
      items.push({ kind: P.kind, x: bx, z: P.z, off: P.off, cx: bx - P.off, nx: -u.z, nz: u.x, y: top, w: BANNER_W, h: BANNER_H });
    } else {
      // A-frame: two leaning printed faces meeting at a ridge, snow on the ridge
      const gy = Math.min(
        ground(bx - u.x * BOARD_W * 0.5, P.z - u.z * BOARD_W * 0.5),
        ground(bx + u.x * BOARD_W * 0.5, P.z + u.z * BOARD_W * 0.5));
      const nrm = new THREE.Vector3(-u.z, 0, u.x);
      const ridge = BOARD_H * Math.cos(BOARD_LEAN);
      const foot = BOARD_H * Math.sin(BOARD_LEAN);
      for (const s of [1, -1]) {
        // The two faces mirror about the ridge, so the SECOND one has to run its
        // width the other way round or its outward normal — and its print —
        // ends up facing into the inside of the A, where nobody can read it.
        const us = new THREE.Vector3(u.x * s, 0, u.z * s);
        const o = new THREE.Vector3(
          bx - us.x * BOARD_W * 0.5 + nrm.x * s * foot, gy + 0.02,
          P.z - us.z * BOARD_W * 0.5 + nrm.z * s * foot);
        const vv = new THREE.Vector3(-nrm.x * s * Math.sin(BOARD_LEAN), Math.cos(BOARD_LEAN),
          -nrm.z * s * Math.sin(BOARD_LEAN));
        // The far face is tinted down 12%. Lean alone does not make an A-frame
        // read as an A-frame: both faces are in shade (nothing here is ever
        // sunlit) so they integrate to the same radiance and the ridge produced
        // no value break at all — at 28 m the object was a flat rectangle. The
        // step is what makes the fold visible.
        const fcol = s > 0 ? col : [col[0] * 0.88, col[1] * 0.88, col[2] * 0.90];
        panel(gb, o, us, vv, BOARD_W, BOARD_H, R_AK, R_BOARDB, fcol, 0, 2);
      }
      const oR = new THREE.Vector3(bx - u.x * BOARD_W * 0.5, gy + 0.02 + ridge - 0.001, P.z - u.z * BOARD_W * 0.5);
      // foot * 0.8, not foot * 1.15: the cap has to sit INSIDE the A's own base
      // half-spread or it overhangs the printed faces and the board grows a
      // white brim. At lean 0.20 the old factor gave +-0.174 m against a
      // half-spread of 0.151 m, i.e. it always overhung.
      snowLip(gb, oR, u, v, BOARD_W, 0, foot * 0.8, scol);
      items.push({ kind: P.kind, x: bx, z: P.z, off: P.off, cx: bx - P.off, nx: -u.z, nz: u.x, y: gy + ridge, w: BOARD_W, h: BOARD_H });
    }
  }

  const geo = gb.geo();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'branding';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  // HIDDEN UNTIL THE ARTWORK IS IN THE ATLAS. This is a correctness gate, not a
  // load-order nicety, and it replaces `window.__brandingReady`:
  //
  // the panels are already painted with the fallback letterforms, so nothing is
  // racing a blank texture — but the mesh used to join the scene ~200 ms before
  // the real PNGs landed, and any capture taken inside that window silently
  // contained the STAND-IN artwork with nothing to say so. Today the review is
  // reliable only because tools/brand-shot.mjs awaits `ready` and hard-fails
  // unless `loaded === 'assets'`; the moment main.js wires this module up
  // without awaiting anything, every shoot.mjs capture would quietly be of the
  // fallback. So: a premature capture shows NOTHING, which is loud, instead of
  // the wrong artwork, which is silent.
  //
  // `ready` resolves whichever way the load goes, so the fallback path still
  // renders after a genuine failure (tools/brand-shot.mjs --fallback).
  group.visible = false;
  scene.add(group);

  // --------------------------------------------------------- the real images --
  // One `Promise.all`, so there is no torn one-image state, and `paint()` is
  // synchronous, so no screenshot can interleave with a half-composited atlas.
  const loader = new THREE.ImageLoader();
  loader.setCrossOrigin('anonymous');
  const load = (url) => new Promise((res) => loader.load(url, res, undefined, () => res(null)));
  const ready = Promise.all([load(SRC_BTM), load(SRC_AK)]).then(([btm, ak]) => {
    if (btm || ak) {
      paint({ btm, ak });
      painted = btm && ak ? 'assets' : 'partial';
      tex.needsUpdate = true;
      api.loaded = painted;
    } else {
      api.loaded = 'failed';       // `painted` stays 'fallback' — that is what
    }                              // is actually on the canvas
    group.visible = true;          // the gate above
    return api;
  });

  // --------------------------------------------------------------- radiance --
  // Only reached when scatter is absent: the same estimate scatter.syncRadiance
  // makes (snow albedo 0.82, a clear zenith at about a seventh of sunlit snow),
  // so a standalone probe is not lit differently from the game.
  let keyLight = null, hemi = null;
  const _sw = new THREE.Vector3();
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
    const c = keyLight.color, I = keyLight.intensity;
    const k = Math.max(_sw.y, 0) * 0.82 / Math.PI * I;
    uniforms.uBounce.value.set(c.r * k, c.g * k, c.b * k * 1.06);
    const s = k * 0.155;
    if (hemi) uniforms.uSkyFill.value.set(hemi.color.r * s, hemi.color.g * s, hemi.color.b * s);
    else uniforms.uSkyFill.value.set(s * 0.78, s * 0.88, s);
  }

  /**
   * Did the reconstructed centreline actually land on the corridor? Compares it
   * against the documented formula over the run. This is the check that says the
   * placement seam was read correctly rather than plausibly.
   *
   * `validates` is false when the seam was withheld, because then `centre` IS
   * `corridorFormula` and the comparison is the formula against itself: it
   * returns 0.000 m and proves nothing whatsoever. Callers must print that case
   * differently or they are reporting a validation that did not happen.
   */
  function centrelineCheck() {
    if (!cx) {
      return { source: 'formula fallback', validates: false,
        worstErrM: null, atZ: null, liftOffset: null };
    }
    let worst = 0, at = 0;
    for (let z = -900; z <= 900; z += 5) {
      const e = Math.abs(centre(z) - corridorFormula(z));
      if (e > worst) { worst = e; at = z; }
    }
    return { source: 'scatter seam', validates: true, worstErrM: worst, atZ: at,
      liftOffset: cx.liftOffset };
  }

  const api = {
    group,
    ready,
    loaded: 'fallback',
    get textured() { return painted; },
    debug: { items, centrelineCheck, tris: gb.tris, canvas: cv, tex, mat, uniforms },

    update() { if (own) syncRadiance(); },

    dispose() {
      tex.dispose();
      mat.dispose();
      geo.dispose();
      scene.remove(group);
    },
  };
  return api;
}
