/**
 * Slope-side branding — sponsor boards at the piste edge.
 *
 * Five objects on a 1.4 km run: two A-frame sandwich boards (AhoiKapptn!, dark
 * face), two low advertising banners on posts standing in front of the B-net
 * runs (BTM, white PVC), and one feather flag near the start (AhoiKapptn!).
 * Nothing else. The brief was "keep it very subtle", which is read here as a
 * hard constraint: this is what a sponsored piste looks like from the chair, not
 * an ad hoarding. Sizes, tints and counts are all set against that, and the
 * numbers are in the block comment above PLACEMENTS.
 *
 * ---------------------------------------------------------------------------
 * BINARY ASSET EXCEPTION — `public/brand/btm.png`, `public/brand/ahoikapptn.png`
 *
 * This project has no binary art assets and that rule still stands for
 * everything else: no other downloaded texture, no new dependency, every other
 * texture in the repo is generated in code. These two files are a deliberate,
 * scoped exception granted by the owner of the marks, because they are HIS
 * BRAND and an approximation of a wordmark is not the same object as the
 * wordmark. They are the only two images in the repo. Do not read them as the
 * start of an asset pipeline.
 *
 * Both are loaded, composited onto a printed panel on an offscreen canvas, and
 * uploaded as ONE atlas. Neither file has a usable alpha channel for
 * compositing (BTM is ink on transparency, AhoiKapptn! is white on opaque
 * black), so nothing is keyed out: each is treated as PRINT on a panel, which
 * is how both would really be produced for a slope —
 *
 *   BTM           source-over onto a white PVC banner  (transparent -> white)
 *   AhoiKapptn!   composite 'lighter' onto a dark board, so the black
 *                 background adds nothing and only the white mark lands
 *
 * That also means no alphaTest anywhere in this file: no coverage mip chain, no
 * stochastic dither, no cut-out fringe to alias. A printed panel is opaque.
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
 *    `matCl`/`matImp` in scatter.js do it.
 *  * The sky IBL has an empty lower hemisphere, so an unlit face integrates to
 *    almost nothing and a dark board becomes a hole in the snow. Same bounce +
 *    sky-fill ambient as scatter's `matBuild`, driven off the SAME uniform
 *    objects when scatter exposes them, so a board is lit by the identical
 *    radiance as the hut behind it.
 *  * Thin geometry below one pixel of width shimmers. The banner posts and the
 *    flag pole carry `aRad` and the same screen-space width floor as scatter's
 *    props.
 *  * Fine high-contrast print at a few px/period beats against the pixel grid
 *    (the corduroy cross-hatch). Mitigated by area: no logo is ever drawn at a
 *    scale where its letterforms are a few px, because the panels are small and
 *    the print sits inside a wide quiet margin, so the mip average of a distant
 *    banner is pale off-white rather than a comb. Trilinear + aniso 8, no
 *    alpha test, no repeat wrapping.
 *  * The centreline is NOT re-derived. `corridorX0` lives in terrain.js and
 *    scatter.js and a third copy is the exact ambiguous seam that has caused
 *    every integration failure here, so the corridor is reconstructed from
 *    scatter's public placement seam instead: the lift towers give the SHAPE
 *    (they are on `corridorX(z) + LIFT_OFFSET`) and any building gives the
 *    constant (`b.x - b.off` is `corridorX(b.z)` exactly). Agreement with the
 *    formula is a measurement, see `debug.centrelineCheck`.
 *
 * Everything is merged into one geometry with one material: 1 draw call, ~330
 * triangles, no per-frame work beyond copying three uniforms.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------- files --
// Served out of `public/`, so Vite hands them over untouched in dev and copies
// them to the site root in a build. Through BASE_URL so a non-root deployment
// still finds them.
const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';
const SRC_BTM = BASE + 'brand/btm.png';
const SRC_AK = BASE + 'brand/ahoikapptn.png';

// --------------------------------------------------------------------- panels --
// metres. Everything is deliberately small: a real piste banner is knee-high
// and 2.5 m long, and a sandwich board is a metre wide.
// Each aspect ratio MATCHES its atlas region exactly (see R_* below) so no print
// is stretched. Sized from a measured pass rather than by eye: at the ~20 m the
// player actually goes by a board, 1.30 m of width is 53 px and the logo band
// inside it is 40 px — recognisable for the second it is there, and 0.11% of the
// frame. The first build used 1.05 x 0.62 m and the mark mipped away to a grey
// smear at every distance the game is ever played at.
const BANNER_W = 2.30, BANNER_H = 0.70, BANNER_TOP = 1.16;
const BOARD_W = 1.30, BOARD_H = 0.76, BOARD_LEAN = 0.20;   // rad from vertical
const FLAG_W = 0.62, FLAG_H = 1.695, FLAG_BASE = 0.34;     // blade bottom, m

/**
 * Where the branding stands, as (z along the fall line, metres off the corridor
 * centreline). The player starts at z = 700 and descends -z, so the list is in
 * the order it is met.
 *
 * The offsets are picked to sit in the gaps in scatter.js' own furniture, which
 * is why they are these numbers and not round ones:
 *
 *   13..21 m  slalom gates            26 m      THESE BOARDS (piste edge)
 *   38..43 m  piste marker poles      41..47 m  snow guns
 *   49..50 m  THESE BANNERS           52.5 m    B-net back stays
 *   54 m      B-net line
 *
 * so a banner stands ~4.5 m in front of the safety net, which is exactly where
 * a race hoarding goes, and a sandwich board sits well inside the marker line on
 * groomed snow, 5 m outside the gate line the player actually skis — close
 * enough that the mark resolves for the second it is alongside, and far enough
 * that it is never in the ski line.
 */
const PLACEMENTS = [
  { kind: 'flag', z: 662, off: -31.0, yaw: 0.16, tint: 0.94 },
  // z 648 and not 634: GROOMERS[0] is parked at (z 620, off 40) and a board at
  // 634 sat squarely behind its blade from every uphill camera. Verified in the
  // shot, not reasoned about.
  { kind: 'board', z: 648, off: 26.0, yaw: -0.34, tint: 0.92 },
  { kind: 'banner', z: 516, off: 49.5, yaw: -0.20, tint: 0.97 },
  { kind: 'board', z: 128, off: -26.0, yaw: 0.40, tint: 0.90 },
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
const R_BTM   = [0, 0, 1024, 312];      // 3.29:1, the banner face
const R_AK    = [0, 320, 512, 300];     // 1.71:1, the sandwich-board face
const R_FLAG  = [512, 320, 256, 700];   // 1:2.73, the feather blade
const R_BACK  = [0, 628, 256, 128];     // banner reverse, unprinted PVC
const R_DARK  = [0, 764, 256, 128];     // board reverse
const R_SNOW  = [0, 900, 240, 120];     // crust along a top edge
const R_PAINT = [264, 628, 240, 128];   // galvanised post / frame

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

function drawAkFallback(g, x, y, w, h) {
  const WH = '#eef2f6';
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
      // Pushed left with the quiet field to its right: that is how a hoarding is
      // laid out, and it holds the ink (and therefore the chroma) to about a
      // quarter of the banner instead of filling it.
      const bb = imgs?.btm ? contentBox(imgs.btm, 'alpha') : { w: 1.43, h: 1 };
      const [, dy, dw, dh] = fitBox(...R_BTM, bb.w / bb.h, 0.055, 0.11);
      const dx = R_BTM[0] + R_BTM[2] * 0.055;
      if (imgs?.btm) g2.drawImage(imgs.btm, bb.x, bb.y, bb.w, bb.h, dx, dy, dw, dh);
      else drawBtmFallback(g2, dx, dy, dw, dh);
    }
    // grommets along the top and bottom hems
    for (let i = 0; i <= 6; i++) {
      const px = R_BTM[0] + 10 + (R_BTM[2] - 20) * (i / 6);
      for (const py of [R_BTM[1] + 9, R_BTM[1] + R_BTM[3] - 9]) {
        g2.strokeStyle = 'rgba(96,100,104,0.55)'; g2.lineWidth = 2.2;
        g2.beginPath(); g2.arc(px, py, 3.4, 0, 6.2832); g2.stroke();
      }
    }
    weather(g2, ...R_BTM, rnd, { dark: false });

    // --- AhoiKapptn!: white on opaque black -> 'lighter' onto a dark board -
    for (const [reg, rot, base] of [[R_AK, false, '#39404a'], [R_FLAG, true, '#434b56']]) {
      // Dark slate rather than the artwork's own black. MEASURED: at #2b2f35 a
      // board 29 m away rendered at L* 10.0 against snow at L* 89.9 — 1.5% of
      // the snow's luminance, where even the treeline sits at 36% — and it read
      // as a hole cut in the slope rather than as an object standing on it. A
      // vertical panel gets about a third of the irradiance the horizontal snow
      // does (measured on the white banner: albedo 0.71 -> rendered Y 0.246), so
      // the albedo has to carry it. The flag is a shade lighter again: it is a
      // single ply of cloth, so a good part of what lands on the far side comes
      // through it, and a flag is never as dark as an opaque board.
      g2.fillStyle = base;
      g2.fillRect(...reg);
      const bb = imgs?.ak ? contentBox(imgs.ak, 'luma') : { w: 4.35, h: 1 };
      g2.save();
      if (rot) {          // the blade is printed to read bottom-to-top, mark low
        g2.translate(reg[0] + reg[2] * 0.5, reg[1] + reg[3] * 0.5);
        g2.rotate(-Math.PI / 2);
      }
      const box = rot ? [-reg[3] / 2, -reg[2] / 2, reg[3], reg[2]] : reg;
      const [dx, dy, dw, dh] = fitBox(...box, bb.w / bb.h, rot ? 0.06 : 0.07, 0.10);
      if (imgs?.ak) {
        g2.globalCompositeOperation = 'lighter';   // the black background adds 0
        g2.drawImage(imgs.ak, bb.x, bb.y, bb.w, bb.h, dx, dy, dw, dh);
      } else {
        drawAkFallback(g2, dx, dy, dw, dh);
      }
      g2.restore();
      weather(g2, ...reg, rnd, { dark: true, crust: reg === R_AK });
    }

    // --- unprinted regions -------------------------------------------------
    noiseFill(g2, R_BACK, '#dfe1de', [110, 108, 100], rnd);
    weather(g2, ...R_BACK, rnd, { dark: false });
    noiseFill(g2, R_DARK, '#343b44', [190, 196, 204], rnd);
    weather(g2, ...R_DARK, rnd, { dark: true });
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
      }
      const o = new THREE.Vector3(p0.x, top - BANNER_H, p0.z);
      panel(gb, o, u, v, BANNER_W, BANNER_H, R_BTM, R_BACK, col, 0.035, 5);
      snowLip(gb, o, u, v, BANNER_W, BANNER_H, 0.030, scol);
      items.push({ kind: P.kind, x: bx, z: P.z, off: P.off, cx: bx - P.off, nx: -u.z, nz: u.x, y: top, w: BANNER_W, h: BANNER_H });
    } else if (P.kind === 'board') {
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
        panel(gb, o, us, vv, BOARD_W, BOARD_H, R_AK, R_DARK, col, 0, 2);
      }
      const oR = new THREE.Vector3(bx - u.x * BOARD_W * 0.5, gy + 0.02 + ridge - 0.001, P.z - u.z * BOARD_W * 0.5);
      snowLip(gb, oR, u, v, BOARD_W, 0, foot * 1.15, scol);
      items.push({ kind: P.kind, x: bx, z: P.z, off: P.off, cx: bx - P.off, nx: -u.z, nz: u.x, y: gy + ridge, w: BOARD_W, h: BOARD_H });
    } else {
      // Feather flag. The silhouette is carried by the GEOMETRY, not by an alpha
      // cut-out: the blade is sleeved on the pole at its leading edge, widens to
      // full chord a third of the way up and tapers into the pole again at the
      // top, which is the shape that stops it reading as a black monolith
      // standing in the snow. Measured on the first build: a straight rectangle
      // at 27 m was a 22 x 52 px dark slab and nothing about it said "flag".
      const gy = ground(bx, P.z);
      _a.set(bx, gy - 0.35, P.z);
      _b.set(bx, gy + FLAG_BASE + FLAG_H + 0.06, P.z);
      tube(gb, _a, _b, 0.045, gcol, 6);
      const nrm = new THREE.Vector3(-u.z, 0, u.x);
      const nj = 7;
      const rowsF = [], rowsB = [];
      for (let j = 0; j <= nj; j++) {
        const t = j / nj;
        // chord: 0.30 at the foot, full by t = 0.34, tapering to 0.30 at the tip
        const chord = FLAG_W * clamp(Math.min(0.30 + t / 0.34 * 0.70,
          1.0 - Math.pow(Math.max(0, t - 0.72) / 0.28, 1.6) * 0.70), 0.28, 1.0);
        const bow = Math.sin(t * Math.PI) * 0.07 + t * t * 0.05;   // catches the wind
        const rF = [], rB = [];
        for (let i = 0; i <= 1; i++) {
          const s = i;
          const px = bx + u.x * s * chord + nrm.x * bow;
          const pz = P.z + u.z * s * chord + nrm.z * bow;
          const py = gy + FLAG_BASE + t * FLAG_H;
          // UV spans the WHOLE region on every row, so the print squeezes with
          // the taper the way cloth cut to a blade outline does. Mapping it to
          // `s * chord / FLAG_W` instead — which looks more correct on paper —
          // crops the artwork to the left of the region and threw away two
          // thirds of the wordmark; caught in the 13 m shot.
          rF.push(gb.v(px, py, pz, nrm.x, 0, nrm.z, ...uvR(R_FLAG, s, t), col, 0));
          rB.push(gb.v(px, py, pz, -nrm.x, 0, -nrm.z, ...uvR(R_FLAG, 1 - s, t), col, 0));
        }
        rowsF.push(rF); rowsB.push(rB);
      }
      for (let j = 0; j < nj; j++) {
        gb.quad(rowsF[j][0], rowsF[j][1], rowsF[j + 1][1], rowsF[j + 1][0]);
        gb.quad(rowsB[j + 1][0], rowsB[j + 1][1], rowsB[j][1], rowsB[j][0]);
      }
      items.push({ kind: P.kind, x: bx, z: P.z, off: P.off, cx: bx - P.off, nx: -u.z, nz: u.x, y: gy + FLAG_BASE + FLAG_H, w: FLAG_W, h: FLAG_H });
    }
  }

  const geo = gb.geo();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'branding';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  scene.add(group);

  // --------------------------------------------------------- the real images --
  // Async, and the panels are already painted with the fallback, so no frame is
  // ever blank and a capture tool can never screenshot an empty banner. The
  // promise is exposed twice — on the returned object and as
  // `window.__brandingReady` — because main.js flips `harness.ready` itself and
  // a reviewer's screenshot has to be deterministic.
  const loader = new THREE.ImageLoader();
  loader.setCrossOrigin('anonymous');
  const load = (url) => new Promise((res) => loader.load(url, res, undefined, () => res(null)));
  const ready = Promise.all([load(SRC_BTM), load(SRC_AK)]).then(([btm, ak]) => {
    if (!btm && !ak) { api.loaded = 'failed'; return api; }
    paint({ btm, ak });
    painted = btm && ak ? 'assets' : 'partial';
    tex.needsUpdate = true;
    api.loaded = painted;
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
   */
  function centrelineCheck() {
    let worst = 0, at = 0;
    for (let z = -900; z <= 900; z += 5) {
      const e = Math.abs(centre(z) - corridorFormula(z));
      if (e > worst) { worst = e; at = z; }
    }
    return { source: cx ? 'scatter seam' : 'formula fallback', worstErrM: worst, atZ: at,
      liftOffset: cx ? cx.liftOffset : null };
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
  if (typeof window !== 'undefined') window.__brandingReady = ready;
  return api;
}
