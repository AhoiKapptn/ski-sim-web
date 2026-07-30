/**
 * Skier — procedural character model + animation rig.
 *
 * Everything here is generated in code: lathed limbs, a lofted ski with real
 * sidecut / camber / rocker, boots, bindings, poles, helmet and a mirrored
 * goggle lens. The pose is driven entirely from `state` (edge, gForce, crouch,
 * airborne, speed) with analytic two-bone IK on the legs, so the boots are
 * rigidly locked to the bindings and the skis always ride the snow.
 *
 * Local frame convention. `group` carries a basis built from state.pos and
 * state.groundNormal, so inside it:
 *   +Z = direction of travel (ski tips)   +X = skier's LEFT   y = 0 = the snow.
 *   state.edge > 0  => turning left => inside is +X.
 * Nothing in the rig ever sees world pitch/roll: the skis are simply placed on
 * y = 0 and the body leans off it by the physics inclination. That is what keeps
 * the bases on the snow at any edge angle on any slope.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
const V2 = (x, y) => new THREE.Vector2(x, y);

// ---------------------------------------------------------------------------
// procedural textures
// ---------------------------------------------------------------------------

function hash2(x, y, p, s) {
  const xi = ((x % p) + p) % p, yi = ((y % p) + p) % p;
  const n = Math.sin(xi * 127.1 + yi * 311.7 + s * 91.3) * 43758.5453;
  return n - Math.floor(n);
}
function vnoise(x, y, p, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, p, s), b = hash2(xi + 1, yi, p, s);
  const c = hash2(xi, yi + 1, p, s), d = hash2(xi + 1, yi + 1, p, s);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function fbm(x, y, p, s, oct = 4) {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { sum += amp * vnoise(x * f, y * f, p * f, s + i); f *= 2; amp *= 0.5; }
  return sum;
}

// --- material-surface baker --------------------------------------------------
//
// One generic baker turns a per-texel field function into the three maps that
// actually kill the "untextured plastic" read: a normal map (micro relief), a
// roughness map (never uniform — that is the single biggest tell) and a colour
// map carrying baked cavity darkening plus the pale edge highlight that a real
// stitched seam throws. `sample(u, v, out)` writes [height, roughness, tint].

const _sOut = [0, 0, 1];

/**
 * @param {number} size            texture resolution
 * @param {(u:number,v:number,out:number[])=>void} sample
 * @param {object} o  { nScale, sRGB }  nScale scales the normal slope
 */
function bakeMaps(size, sample, o = {}) {
  const nScale = o.nScale ?? 2.4;
  const H = new Float32Array(size * size);
  const R = new Float32Array(size * size);
  const T = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      sample((x + 0.5) / size, (y + 0.5) / size, _sOut);
      const i = y * size + x;
      H[i] = _sOut[0]; R[i] = _sOut[1]; T[i] = _sOut[2];
    }
  }
  const nData = new Uint8Array(size * size * 4);
  const rData = new Uint8Array(size * size * 4);
  const cData = new Uint8Array(size * size * 4);
  const wrap = (v) => ((v % size) + size) % size;
  const at = (x, y) => H[wrap(y) * size + wrap(x)];
  // cavity term: height minus a blurred height => darkens grooves, lifts ridges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dx = (at(x + 1, y) - at(x - 1, y)) * nScale;
      const dy = (at(x, y + 1) - at(x, y - 1)) * nScale;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const j = i * 4;
      nData[j] = (-dx * inv * 0.5 + 0.5) * 255;
      nData[j + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      nData[j + 2] = (inv * 0.5 + 0.5) * 255;
      nData[j + 3] = 255;
      const r = clamp(R[i], 0.02, 1) * 255;
      rData[j] = rData[j + 1] = rData[j + 2] = r;
      rData[j + 3] = 255;
      // tint is authored in linear-ish terms; store it sRGB-encoded
      const t = clamp(T[i], 0, 2);
      const enc = Math.pow(t > 1 ? 1 : t, 1 / 2.2) * (t > 1 ? t : 1);
      const c = clamp(enc, 0, 1) * 255;
      cData[j] = cData[j + 1] = cData[j + 2] = c;
      cData[j + 3] = 255;
    }
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { normal: mk(nData, false), rough: mk(rData, false), tint: mk(cData, true) };
}

/** micro ripstop weave, tileable, shared by every fabric on the character. */
function weaveField(u, v, freq) {
  const f = freq;
  // two thread systems, one slightly finer => faint anisotropy in the sheen
  const warp = Math.sin(u * Math.PI * 2 * f) * 0.5 + 0.5;
  const weft = Math.sin(v * Math.PI * 2 * f * 0.92) * 0.5 + 0.5;
  const w = warp * 0.55 + weft * 0.45;
  // ripstop reinforcement grid every 1/14 of the tile
  const gu = Math.abs(((u * 14) % 1) - 0.5), gv = Math.abs(((v * 14) % 1) - 0.5);
  const rip = (gu > 0.455 ? 1 : 0) * 0.55 + (gv > 0.455 ? 1 : 0) * 0.55;
  return w * 0.11 + rip * 0.030;
}

/** technical shell: weave + soft wrinkle field + dye unevenness. */
function makeShellMaps(size = 256) {
  return bakeMaps(size, (u, v, out) => {
    const wr = fbm(u * 7, v * 7, 7, 11, 4);            // slack-fabric wrinkles
    const cr = Math.abs(fbm(u * 3.5, v * 3.5, 4, 3, 3) - 0.5); // crease ridges
    const w = weaveField(u, v, 58);
    const h = wr * 0.30 + (0.5 - cr) * 0.16 + w;
    out[0] = h;
    out[1] = 0.70 + (wr - 0.5) * 0.20 - w * 0.35;      // ridges catch light
    out[2] = 0.93 + (wr - 0.5) * 0.10 + w * 0.10;
  }, { nScale: 2.2 });
}

/**
 * Quilted / baffled insulation. v runs down the garment: horizontal channels,
 * a stitched seam trench between them with visible needle dimples, and a pale
 * lip just above each seam where the fabric turns into the light.
 */
function makeQuiltMaps(size = 512, nBaffle = 6, stitches = 52) {
  return bakeMaps(size, (u, v0, out) => {
    // seams are sewn by a human, not a plotter: let each channel wander a little
    const v = v0 + 0.010 * Math.sin(u * Math.PI * 2 * 2 + 0.7)
      + 0.006 * Math.sin(u * Math.PI * 2 * 5 + 2.1);
    const p = ((v * nBaffle) % 1 + 1) % 1;
    const d = Math.min(p, 1 - p);                       // 0 at a seam, .5 mid-baffle
    const q = Math.min(1, d * 2);
    // pillow: full at the channel centre, pinched to nothing at the stitch line
    let h = Math.pow(Math.sin(q * Math.PI * 0.5), 0.55) * 0.36;
    const trench = Math.exp(-Math.pow(d / 0.026, 2));
    h -= trench * 0.26;
    // needle dimples marching along the seam
    const st = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * stitches);
    h -= trench * Math.pow(st, 6) * 0.13;
    h += Math.exp(-Math.pow((d - 0.070) / 0.042, 2)) * 0.05;   // seam lip
    // the baffles are not machine-perfect: puff varies along the channel
    const puff = fbm(u * 5, v * 2.5, 5, 21, 3);
    h += (puff - 0.5) * 0.13 * q;
    const w = weaveField(u, v, 96);
    h += w * 0.30;
    out[0] = h;
    // seam trench is compressed and shinier; the puffed centre is matte
    out[1] = 0.74 - trench * 0.22 - q * 0.05 - w * 0.5 + (puff - 0.5) * 0.10;
    // baked cavity + edge highlight: this is what makes it read as sewn cloth
    out[2] = 0.97 - trench * 0.30
      + Math.exp(-Math.pow((d - 0.080) / 0.05, 2)) * 0.10
      + (puff - 0.5) * 0.07;
  }, { nScale: 2.1 });
}

/** matte rubberised palm / glove: fine pebble grain, no specular hotspots. */
function makeRubberMaps(size = 256) {
  return bakeMaps(size, (u, v, out) => {
    const cell = 26;
    const fx = u * cell, fy = v * cell;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    let best = 9;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = ix + ox + hash2(ix + ox, iy + oy, cell, 3) * 0.9 + 0.05;
        const cy = iy + oy + hash2(ix + ox, iy + oy, cell, 7) * 0.9 + 0.05;
        const dd = (fx - cx) * (fx - cx) + (fy - cy) * (fy - cy);
        if (dd < best) best = dd;
      }
    }
    const pebble = clamp(1 - Math.sqrt(best) * 2.1, 0, 1);
    const h = Math.pow(pebble, 0.6) * 0.5 + fbm(u * 9, v * 9, 9, 5, 3) * 0.1;
    out[0] = h;
    out[1] = 0.86 - pebble * 0.16;
    out[2] = 0.88 + pebble * 0.16;
  }, { nScale: 2.0 });
}

/** injection-moulded hard shell: orange peel + faint tool marks. */
function makeShellPlasticMaps(size = 256) {
  return bakeMaps(size, (u, v, out) => {
    const peel = fbm(u * 26, v * 26, 26, 31, 3);
    const flow = fbm(u * 4, v * 14, 4, 13, 3);
    out[0] = peel * 0.16 + flow * 0.06;
    out[1] = 0.30 + (peel - 0.5) * 0.20 + (flow - 0.5) * 0.08;
    out[2] = 0.97 + (peel - 0.5) * 0.05;
  }, { nScale: 1.5 });
}

/**
 * Mirrored goggle lens. The colour map is the whole trick: a vertical gradient
 * from a cold blue chrome across the top to a warm bronze at the bottom rim,
 * with a bright specular band where a real spherical lens catches the sky.
 */
function makeLensMaps(size = 128) {
  return bakeMaps(size, (u, v, out) => {
    out[0] = 0;
    out[1] = 0.035 + v * 0.02;
    out[2] = 1;
  }, { nScale: 0.2 });
}
function makeLensColor(size = 128) {
  const d = new Uint8Array(size * size * 4);
  const top = new THREE.Color(0x8fc6ff), mid = new THREE.Color(0x6f8fe0), bot = new THREE.Color(0xd8a06a);
  const c = new THREE.Color();
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      if (v < 0.55) c.copy(top).lerp(mid, THREE.MathUtils.smoothstep(v, 0.0, 0.55));
      else c.copy(mid).lerp(bot, THREE.MathUtils.smoothstep(v, 0.55, 1.0));
      // horizon band a real spherical mirror lens always shows
      const band = Math.exp(-Math.pow((v - 0.42) / 0.07, 2)) * 0.35;
      const k = 1 + band + Math.exp(-Math.pow((u - 0.5) / 0.34, 2)) * 0.06;
      const i = (y * size + x) * 4;
      d[i] = clamp(Math.pow(c.r * k, 1 / 2.2), 0, 1) * 255;
      d[i + 1] = clamp(Math.pow(c.g * k, 1 / 2.2), 0, 1) * 255;
      d[i + 2] = clamp(Math.pow(c.b * k, 1 / 2.2), 0, 1) * 255;
      d[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Ski topsheet graphic. u runs tail->tip, v across the ski. */
function makeTopsheetTexture(colors) {
  // u = tail..tip along the ski, v = across the visible top face
  const w = 640, h = 96;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = colors.base; g.fillRect(0, 0, w, h);
  // tip block with a diagonal break
  g.fillStyle = colors.accent;
  g.beginPath();
  g.moveTo(w * 0.70, 0); g.lineTo(w, 0); g.lineTo(w, h); g.lineTo(w * 0.62, h);
  g.closePath(); g.fill();
  g.fillStyle = colors.base;
  g.beginPath();
  g.moveTo(w * 0.755, 0); g.lineTo(w * 0.785, 0); g.lineTo(w * 0.705, h); g.lineTo(w * 0.675, h);
  g.closePath(); g.fill();
  // tail block
  g.fillStyle = colors.accent;
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(w * 0.075, 0); g.lineTo(w * 0.10, h); g.lineTo(0, h);
  g.closePath(); g.fill();
  // pin stripes running the length
  g.fillStyle = colors.line;
  g.globalAlpha = 0.9;
  g.fillRect(w * 0.12, h * 0.26, w * 0.5, 2);
  g.fillRect(w * 0.12, h * 0.71, w * 0.5, 2);
  g.globalAlpha = 1;
  // wordmark, pre-squashed: the ski is ~25x longer than it is wide
  g.save();
  g.fillStyle = colors.line;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.setTransform(0.34, 0, 0, 1, w * 0.34, h * 0.5);
  g.font = '700 46px "Helvetica Neue", Helvetica, Arial, sans-serif';
  g.fillText('ALPINE', 0, 2);
  g.setTransform(0.34, 0, 0, 1, w * 0.90, h * 0.5);
  g.fillStyle = '#12161c';
  g.font = '700 40px "Helvetica Neue", Helvetica, Arial, sans-serif';
  g.fillText('88', 0, 2);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Tiny HDR-ish equirect sky used so the goggle lens mirrors *something*
 *  even before the world's sky module publishes scene.environment. */
function makeFallbackEnv() {
  const w = 96, h = 48;
  const data = new Uint16Array(w * h * 4);
  const sunDir = new THREE.Vector3(-0.45, 0.62, 0.4).normalize();
  const d = new THREE.Vector3();
  const col = new THREE.Color();
  for (let y = 0; y < h; y++) {
    const theta = (y + 0.5) / h * Math.PI;
    for (let x = 0; x < w; x++) {
      const phi = (x + 0.5) / w * Math.PI * 2 - Math.PI;
      d.set(Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi));
      if (d.y >= 0) {
        const t = Math.pow(1 - d.y, 2.2);
        col.setRGB(lerp(0.13, 0.72, t), lerp(0.29, 0.83, t), lerp(0.72, 0.95, t));
        const s = Math.max(0, d.dot(sunDir));
        const sun = Math.pow(s, 900) * 60 + Math.pow(s, 24) * 0.8;
        col.r += sun; col.g += sun * 0.96; col.b += sun * 0.86;
      } else {
        // snow bounce
        const t = clamp(-d.y * 2.2, 0, 1);
        col.setRGB(lerp(0.66, 0.86, t), lerp(0.72, 0.9, t), lerp(0.8, 0.96, t));
      }
      const i = (y * w + x) * 4;
      data[i] = THREE.DataUtils.toHalfFloat(col.r);
      data[i + 1] = THREE.DataUtils.toHalfFloat(col.g);
      data[i + 2] = THREE.DataUtils.toHalfFloat(col.b);
      data[i + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// geometry helpers
// ---------------------------------------------------------------------------

/**
 * Revolve a profile [[r,y],...]; sx/sz make the cross-section elliptical.
 * Open ends are automatically closed with a shallow cap so no lathe ever shows
 * its hollow interior when the pose swings it into view.
 */
function lathe(pts, seg = 18, sx = 1, sz = 1, cap = true, phiStart = -Math.PI / 2, phiLength = Math.PI * 2) {
  let p = pts;
  const n = pts.length;
  const capA = cap === true || cap === 'a';
  const capB = cap === true || cap === 'b';
  const dA = Math.sign(pts[1][1] - pts[0][1]) || 1;
  const dB = Math.sign(pts[n - 1][1] - pts[n - 2][1]) || -1;
  if ((capA && pts[0][0] > 0.006) || (capB && pts[n - 1][0] > 0.006)) {
    p = pts.slice();
    if (capB && pts[n - 1][0] > 0.006) p.push([0.0008, pts[n - 1][1] + dB * Math.min(0.02, pts[n - 1][0] * 0.7)]);
    if (capA && pts[0][0] > 0.006) p.unshift([0.0008, pts[0][1] - dA * Math.min(0.02, pts[0][0] * 0.7)]);
  }
  const g = new THREE.LatheGeometry(p.map((q) => V2(Math.max(q[0], 0.0006), q[1])), seg, phiStart, phiLength);
  if (sx !== 1 || sz !== 1) {
    g.scale(sx, 1, sz);
    // transform the lathe's own normals instead of recomputing them: recomputed
    // normals break at the phi seam and leave a visible crease down the limb
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++) {
      let x = n.getX(i) / sx, y = n.getY(i), z = n.getZ(i) / sz;
      const l = Math.hypot(x, y, z) || 1;
      n.setXYZ(i, x / l, y / l, z / l);
    }
    n.needsUpdate = true;
  }
  return g;
}

/**
 * Smooth limb profile between two radii with a slight bulge. `t0..t1` slices a
 * sub-section of the same curve, so a limb can be split into differently
 * coloured panels that share exact vertices at the seam — no z-fighting, no
 * hovering decal geometry.
 */
function limbProfile(len, rTop, rMid, rBot, t0 = 0, t1 = 1, n = 8) {
  const rAt = (t) => (t < 0.5
    ? lerp(rTop, rMid, THREE.MathUtils.smoothstep(t, 0, 0.5))
    : lerp(rMid, rBot, THREE.MathUtils.smoothstep(t, 0.5, 1)));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = lerp(t0, t1, i / n);
    pts.push([rAt(t), -len * t]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// lofted surfaces
//
// A stack of separate lathes is exactly what made the old body read as blocks:
// every joint between two lathes is a hard step, and every lathe is a solid of
// revolution so nothing can be deeper than it is wide. Everything soft on the
// character is now ONE parametric surface instead — continuous from hem to
// collar, elliptical, offset-able, and free to carry fabric folds. Normals come
// from central differences on the surface itself, so the phi seam never creases.
// ---------------------------------------------------------------------------

const _psP = new THREE.Vector3(), _psA = new THREE.Vector3(), _psB = new THREE.Vector3();
const _psC = new THREE.Vector3(), _psD = new THREE.Vector3();
const _psU = new THREE.Vector3(), _psV = new THREE.Vector3(), _psN = new THREE.Vector3();

/**
 * @param {(u:number,v:number,out:THREE.Vector3)=>void} fn  u wraps around, v runs along
 * @param {object} o { nu, nv, capA, capB, matFn, vScale }
 */
function paramSurface(fn, o = {}) {
  const nu = o.nu ?? 28, nv = o.nv ?? 24;
  const eu = 0.35 / nu, ev = 0.35 / nv;
  const pos = [], nrm = [], uvs = [];
  const rows = nv + 1, cols = nu + 1;
  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    for (let i = 0; i <= nu; i++) {
      const u = i / nu;
      fn(u, v, _psP);
      fn(u + eu, v, _psA); fn(u - eu, v, _psB);
      fn(u, Math.min(1, v + ev), _psC); fn(u, Math.max(0, v - ev), _psD);
      _psU.subVectors(_psA, _psB);
      _psV.subVectors(_psC, _psD);
      _psN.crossVectors(_psV, _psU);
      if (_psN.lengthSq() < 1e-12) _psN.set(0, 1, 0); else _psN.normalize();
      pos.push(_psP.x, _psP.y, _psP.z);
      nrm.push(_psN.x, _psN.y, _psN.z);
      uvs.push(u, v * (o.vScale ?? 1));
    }
  }
  // Which way is out? Depends on whether the caller authored v running up or
  // down the part, so decide it from the geometry instead of from a convention
  // nobody will remember: compare a mid-belt normal against the ray from the
  // solid's centroid. Everything — normals AND winding — follows that one bit.
  const cen = new THREE.Vector3();
  const nVerts = pos.length / 3;
  for (let k = 0; k < pos.length; k += 3) { cen.x += pos[k]; cen.y += pos[k + 1]; cen.z += pos[k + 2]; }
  cen.multiplyScalar(1 / nVerts);
  let dotSum = 0;
  for (let i = 0; i < nu; i += 2) {
    const k = ((nv >> 1) * cols + i) * 3;
    dotSum += (pos[k] - cen.x) * nrm[k] + (pos[k + 1] - cen.y) * nrm[k + 1] + (pos[k + 2] - cen.z) * nrm[k + 2];
  }
  // open strips have no meaningful centroid test, so the caller can override
  const flip = o.flip !== undefined ? o.flip : dotSum < 0;
  if (flip) for (let k = 0; k < nrm.length; k++) nrm[k] = -nrm[k];

  // triangles, bucketed by material group so panels can share exact vertices
  const buckets = new Map();
  const push = (m, a, b, c) => {
    let arr = buckets.get(m); if (!arr) buckets.set(m, arr = []);
    if (flip) arr.push(a, c, b); else arr.push(a, b, c);
  };
  for (let j = 0; j < nv; j++) {
    const v = (j + 0.5) / nv;
    const m = o.matFn ? o.matFn(v) : 0;
    for (let i = 0; i < nu; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      push(m, a, c, d); push(m, a, d, b);
    }
  }
  // caps: a fan to the ring centroid, normal taken along the ring's own axis
  const _cn = new THREE.Vector3(), _cx = new THREE.Vector3(), _cq = new THREE.Vector3();
  const addCap = (end) => {
    const row = end ? nv : 0;
    const near = end ? nv - 1 : 1;
    _cx.set(0, 0, 0); _cq.set(0, 0, 0);
    for (let i = 0; i < nu; i++) {
      let k = (row * cols + i) * 3;
      _cx.x += pos[k]; _cx.y += pos[k + 1]; _cx.z += pos[k + 2];
      k = (near * cols + i) * 3;
      _cq.x += pos[k]; _cq.y += pos[k + 1]; _cq.z += pos[k + 2];
    }
    _cx.multiplyScalar(1 / nu); _cq.multiplyScalar(1 / nu);
    _cn.subVectors(_cx, _cq);
    if (_cn.lengthSq() < 1e-10) _cn.set(0, end ? 1 : -1, 0); else _cn.normalize();
    const ci = pos.length / 3;
    pos.push(_cx.x, _cx.y, _cx.z);
    nrm.push(_cn.x, _cn.y, _cn.z);
    uvs.push(0.5, end ? 1 : 0);
    const m = o.matFn ? o.matFn(end ? 1 : 0) : 0;
    // wind the fan so it actually faces _cn — measured from a real triangle,
    // not inferred from an authoring convention
    const va = new THREE.Vector3(pos[(row * cols) * 3], pos[(row * cols) * 3 + 1], pos[(row * cols) * 3 + 2]);
    const vb = new THREE.Vector3(pos[(row * cols + 1) * 3], pos[(row * cols + 1) * 3 + 1], pos[(row * cols + 1) * 3 + 2]);
    const tn = new THREE.Vector3().subVectors(va, _cx).cross(new THREE.Vector3().subVectors(vb, _cx));
    const fwd = tn.dot(_cn) > 0;   // (ci, a, b) already faces outward
    let arr = buckets.get(m); if (!arr) buckets.set(m, arr = []);
    for (let i = 0; i < nu; i++) {
      const a = row * cols + i, b = a + 1;
      if (fwd) arr.push(ci, a, b); else arr.push(ci, b, a);
    }
  };
  if (o.capA) addCap(false);
  if (o.capB) addCap(true);

  const idx = [];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const ranges = [];
  for (const k of keys) {
    const arr = buckets.get(k);
    ranges.push([idx.length, arr.length, k]);
    for (const t of arr) idx.push(t);
  }
  g.setIndex(idx);
  g.clearGroups();
  if (keys.length > 1) for (const [s, c, m] of ranges) g.addGroup(s, c, m);
  return g;
}

/**
 * Sample a ring stack: rings are [v, halfWidth, halfDepth, xOffset, zOffset].
 * Interpolation is Catmull-Rom in the profile so ten authored rings become a
 * genuinely smooth garment instead of ten visible steps.
 */
function ringSampler(rings) {
  const n = rings.length;
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  return (v, out) => {
    const vv = clamp(v, 0, 1);
    // locate the segment by the rings' own v coordinate
    let i = 0;
    while (i < n - 2 && rings[i + 1][0] < vv) i++;
    const a = rings[i], b = rings[i + 1];
    const t = clamp((vv - a[0]) / Math.max(1e-6, b[0] - a[0]), 0, 1);
    const p0 = rings[Math.max(0, i - 1)], p3 = rings[Math.min(n - 1, i + 2)];
    out[0] = cr(p0[1], a[1], b[1], p3[1], t);
    out[1] = cr(p0[2], a[2], b[2], p3[2], t);
    out[2] = cr(p0[3] ?? 0, a[3] ?? 0, b[3] ?? 0, p3[3] ?? 0, t);
    out[3] = cr(p0[4] ?? 0, a[4] ?? 0, b[4] ?? 0, p3[4] ?? 0, t);
    // y is linear between the authored ring heights, not splined, so the ends
    // land exactly where they were authored
    out[4] = lerp(a[5], b[5], t);
    return out;
  };
}

const _rs = [0, 0, 0, 0, 0];

/**
 * Garment tube. `rings` = [v, halfWidth, halfDepth, xOff, zOff, y].
 * `fold(u, v)` adds a radial offset in metres — this is where the bulk, the
 * gathered creases and the slack of real clothing come from.
 */
function garment(rings, o = {}) {
  const sample = ringSampler(rings);
  const fold = o.fold;
  const flat = o.flatBack ?? 0;   // squashes the back into a flatter panel
  return paramSurface((u, v, out) => {
    sample(v, _rs);
    const a = u * Math.PI * 2;
    let ca = Math.cos(a), sa = Math.sin(a);
    let rx = _rs[0], rz = _rs[1];
    if (flat) {
      // back of the garment (sa < 0) is flattened toward a panel
      const k = 1 - flat * clamp(-sa, 0, 1);
      rz *= k;
    }
    const f = fold ? fold(u, v) : 0;    // metres of slack, added radially
    const dy = o.drop ? o.drop(u, v) : 0;
    out.set(_rs[2] + ca * (rx + f), _rs[4] + dy, _rs[3] + sa * (rz + f));
  }, o);
}

/**
 * Lofted alpine ski: sidecut, camber, tip rocker, shaped tail, sidewall
 * construction and a metal edge wrap. Returns a geometry with 4 material
 * groups (topsheet, edge, base, sidewall) and one morph target: the reverse
 * camber the ski bends into when it is loaded on edge.
 */
function makeSkiGeometry(o = {}) {
  const L = o.length ?? 1.74;
  const waist = (o.waist ?? 0.069) * 0.5;
  const tipW = (o.tip ?? 0.116) * 0.5;
  const tailW = (o.tail ?? 0.101) * 0.5;
  const TH = o.thick ?? 0.0175;
  const N = 60;

  // cross-section ring: [x-scale-of-halfwidth, y-scale-of-thickness, matIndex-of-strip-to-next]
  // The base is not one strip: a real ski carries a ~2 mm band of polished steel
  // flush with the base along each side, and that bright rim around a black base
  // is the single thing that tells the eye a ski is tilted rather than flat. It
  // has to be geometry — a mirror-metal band cannot be faked with shading on a
  // surface that is coplanar with the base.
  const EB = 0.955;                      // steel band inboard limit, x-scale
  const RING = [
    [-1.00, 0.000, 1], // base-edge steel (left)  ->
    [-EB, 0.000, 2],   // base ->
    [EB, 0.000, 1],    // base-edge steel (right) ->
    [1.00, 0.000, 1],  // edge wall (right)
    [1.00, 0.028, 3],  // sidewall
    [1.00, 0.46, 0],   // topsheet
    [0.62, 0.97, 0],
    [0.00, 1.06, 0],
    [-0.62, 0.97, 0],
    [-1.00, 0.46, 3],  // sidewall
    [-1.00, 0.028, 1], // edge wall (left) -> wraps to base
  ];
  const R = RING.length;
  const TOP0 = 5;      // ring index of the first topsheet strip (uv v = 0)

  const halfWidth = (t) => {
    let w;
    if (t < 0.5) {
      const u = (t - 0.5) / 0.45;
      w = waist + (tailW - waist) * u * u;
    } else {
      const u = (t - 0.5) / 0.44;
      w = waist + (tipW - waist) * u * u;
    }
    // rounded shovel
    if (t > 0.945) w *= Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.945) / 0.056, 2)));
    // squared, slightly rounded tail
    if (t < 0.045) w *= Math.pow(Math.max(0, 1 - Math.pow((0.045 - t) / 0.047, 2)), 0.34);
    return w;
  };
  const thickness = (t) => {
    const u = Math.abs(t - 0.46) / 0.5;
    let th = TH * (1 - 0.72 * u * u * u) + 0.0016;
    // collapse to a thin blade at the very tip and tail
    th *= THREE.MathUtils.smoothstep(t, 0.0, 0.055) * 0.85 + 0.15;
    th *= THREE.MathUtils.smoothstep(1 - t, 0.0, 0.05) * 0.85 + 0.15;
    return th;
  };
  const baseY = (t, flexed) => {
    const u = (t - 0.5) / 0.42;
    let y = flexed ? -0.013 * Math.max(0, 1 - u * u) : 0.0135 * Math.max(0, 1 - u * u);
    // tip rocker
    const tr = THREE.MathUtils.smoothstep(t, 0.78, 1);
    y += tr * tr * (flexed ? 0.085 : 0.062);
    // tail rocker (twin-ish kick)
    const tl = THREE.MathUtils.smoothstep(1 - t, 0.86, 1);
    y += tl * tl * (flexed ? 0.036 : 0.026);
    return y;
  };

  const pos = [], mpos = [], nrm = [], uv = [], idx = [];
  const groups = [[], [], [], []];
  let vbase = 0;
  for (let s = 0; s < R; s++) {
    const a = RING[s], b = RING[(s + 1) % R];
    const mat = a[2];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const z = (t - 0.5) * L;
      const w = halfWidth(t), th = thickness(t);
      const y0 = baseY(t, false), y1 = baseY(t, true);
      for (const p of [a, b]) {
        pos.push(p[0] * w, y0 + p[1] * th, z);
        mpos.push(p[0] * w, y1 + p[1] * th, z);
        nrm.push(0, 1, 0);
        // v is normalised across the four topsheet strips so the graphic fills
        // the visible top face exactly (strips 3..6 -> v 0..1)
        uv.push(t, (s - TOP0 + (p === a ? 0 : 1)) / 4);
      }
    }
    for (let i = 0; i < N; i++) {
      const v0 = vbase + i * 2;
      idx.push(v0, v0 + 1, v0 + 3, v0, v0 + 3, v0 + 2);
      groups[mat].push(v0);
    }
    vbase += (N + 1) * 2;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  // material groups: rebuild the index in material order so groups are contiguous
  const order = [];
  const ranges = [];
  let start = 0;
  for (let m = 0; m < 4; m++) {
    for (const v0 of groups[m]) order.push(v0, v0 + 1, v0 + 3, v0, v0 + 3, v0 + 2);
    ranges.push([start, order.length - start, m]);
    start = order.length;
  }
  g.setIndex(order);
  g.clearGroups();
  for (const [s0, c0, m] of ranges) if (c0 > 0) g.addGroup(s0, c0, m);
  g.computeVertexNormals();

  const morph = new THREE.Float32BufferAttribute(mpos, 3);
  g.morphAttributes.position = [morph];
  g.morphTargetsRelative = false;

  // The running surface, sampled along the ski, in the ski mesh's own space.
  // `contactY` is the height of the lowest running point: the plane the ski
  // stands on. Everything that grounds the rig is derived from this, so the
  // geometry stays the single source of truth.
  const samples = [], flex = [];
  let contactY = Infinity;
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const y = baseY(t, false), w = halfWidth(t), z = (t - 0.5) * L;
    samples.push([-w, y, z], [w, y, z]);
    // the same line once the ski is bent into reverse camber: the waist drops
    // ~1.5 cm past the unloaded running line, which is the trench it cuts
    const yf = baseY(t, true);
    flex.push([-w, yf, z], [w, yf, z]);
    if (t > 0.05 && t < 0.95) contactY = Math.min(contactY, y);
  }
  g.userData.baseSamples = samples;
  g.userData.baseSamplesFlex = flex;
  g.userData.contactY = contactY;
  g.userData.length = L;
  return g;
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------

const C = {
  shell: 0xf0501c,      // jacket main — vermilion, reads hot against snow
  shellDark: 0x1d2129,  // graphite panels
  accent: 0x2fd0e8,     // cyan piping / ski accent
  pant: 0x353d4a,       // graphite salopette — light enough to read shape
  pantPanel: 0x1e232c,  // scuff / knee / seat reinforcement, near-black
  helmet: 0x14171d,
  lens: 0xbfd6ee,
  skin: 0xc79a76,
  boot: 0x191d24,
  bootCuff: 0x424a55,
  bootAccent: 0x6f7885,
  metal: 0xb9c2cc,
  glove: 0x15181e,
};

function makeMaterials(env) {
  const shellM = makeShellMaps(256);
  const quiltM = makeQuiltMaps(512, 6, 52);
  const rubberM = makeRubberMaps(256);
  const plasticM = makeShellPlasticMaps(256);
  const lensM = makeLensMaps(64);
  const rep = (t, rx, ry) => { const c = t.clone(); c.repeat.set(rx, ry ?? rx); c.needsUpdate = true; return c; };

  /**
   * The fabric recipe. Three things separate cloth from vinyl and all three are
   * here: a *low* dielectric specular lobe (specularIntensity 0.28 — plastic's
   * broad white highlight is the main tell), a strong sheen layer with a tight
   * sheenRoughness so the grazing rim goes velvety, and roughness that is never
   * constant across the surface.
   */
  const fabric = (color, o = {}) => {
    const src = o.quilt ? quiltM : o.rubber ? rubberM : shellM;
    const rx = o.repeat ?? 3, ry = o.repeatV ?? rx;
    // Sheen colour is derived from the base, not set to white. A near-white
    // sheen over a bright snow environment is an additive lobe strong enough to
    // wash a dark garment out to grey — which is exactly what "vinyl" looks
    // like. Real cloth scatters its own colour back at grazing angles.
    const base = new THREE.Color(color);
    const sc = o.sheenColor !== undefined
      ? new THREE.Color(o.sheenColor)
      : base.clone().lerp(new THREE.Color(0xffffff), 0.42).multiplyScalar(0.55 + 0.9 * Math.sqrt(base.r * 0.3 + base.g * 0.5 + base.b * 0.2));
    return new THREE.MeshPhysicalMaterial({
      color, roughness: o.rough ?? 0.70, metalness: 0,
      map: o.tint === false ? null : rep(src.tint, rx, ry),
      roughnessMap: rep(src.rough, rx, ry),
      normalMap: rep(src.normal, rx, ry),
      normalScale: new THREE.Vector2(o.nrm ?? 0.85, o.nrm ?? 0.85),
      specularIntensity: o.spec ?? 0.26,
      specularColor: new THREE.Color(0xffffff),
      sheen: o.sheen ?? 0.9,
      // broad, not tight: a tight sheen lobe is a specular ring, and a specular
      // ring is the plastic look we are trying to delete
      sheenRoughness: o.sheenRough ?? 0.72,
      sheenColor: sc,
      envMapIntensity: o.env ?? 0.42,
    });
  };

  const hardShell = (color, o = {}) =>
    new THREE.MeshPhysicalMaterial({
      color, roughness: o.rough ?? 0.30, metalness: 0,
      roughnessMap: rep(plasticM.rough, o.repeat ?? 2),
      normalMap: rep(plasticM.normal, o.repeat ?? 2),
      normalScale: new THREE.Vector2(o.nrm ?? 0.45, o.nrm ?? 0.45),
      clearcoat: o.cc ?? 0.85, clearcoatRoughness: o.ccr ?? 0.14,
      envMapIntensity: o.env ?? 0.9,
    });

  const m = {
    // main jacket body: quilted baffles. repeatV 1 because the torso loft's v
    // already runs hem->collar exactly once, so the baffle count is authored.
    jacket: fabric(C.shell, { quilt: true, rough: 0.66, repeat: 1, repeatV: 1, nrm: 1.15, sheen: 1.0 }),
    // same cloth, unquilted, for sleeves / yoke / hem band
    jacketPlain: fabric(C.shell, { rough: 0.64, repeat: 2.2, nrm: 0.9, sheen: 1.0 }),
    jacketDark: fabric(C.shellDark, { rough: 0.68, repeat: 2.4, nrm: 0.9, sheen: 0.9 }),
    jacketDarkQuilt: fabric(C.shellDark, { quilt: true, rough: 0.70, repeat: 1, repeatV: 1, nrm: 1.1, sheen: 0.9 }),
    accent: fabric(C.accent, { rough: 0.48, repeat: 4, nrm: 0.6, sheen: 0.7, spec: 0.4 }),
    // a muted version for anything larger than piping — full cyan at biceps
    // scale reads as a toy, and every reference photo keeps accents tiny
    accentDim: fabric(0x1d6f80, { rough: 0.62, repeat: 5, nrm: 0.8, sheen: 0.8 }),
    // knitted fleece gaiter: coarse loops, very high sheen, no specular at all
    gaiter: fabric(0x232833, { rubber: true, rough: 0.92, repeat: 5, nrm: 1.4, sheen: 1.0, sheenRough: 0.85, sheenColor: 0x5a6474, spec: 0.10 }),
    helmetAccent: hardShell(C.shell, { rough: 0.30, cc: 0.85, ccr: 0.12, env: 0.50, repeat: 2, nrm: 0.4 }),
    pant: fabric(C.pant, { rough: 0.76, repeat: 2.6, nrm: 1.0, sheen: 0.75, sheenRough: 0.80, spec: 0.22 }),
    pantQuilt: fabric(C.pant, { quilt: true, rough: 0.74, repeat: 1, repeatV: 1, nrm: 1.0, sheen: 0.9 }),
    pantPanel: fabric(C.pantPanel, { rough: 0.60, repeat: 3.6, nrm: 1.0, sheen: 0.7, sheenRough: 0.78, spec: 0.30 }),
    glove: fabric(C.glove, { rubber: true, rough: 0.88, repeat: 3.4, nrm: 1.0, sheen: 0.35, spec: 0.20 }),
    gloveBack: fabric(0x424a56, { rough: 0.70, repeat: 4.5, nrm: 1.0, sheen: 0.9 }),
    skin: new THREE.MeshPhysicalMaterial({
      color: C.skin, roughness: 0.55, metalness: 0,
      normalMap: rep(shellM.normal, 6), normalScale: new THREE.Vector2(0.25, 0.25),
      specularIntensity: 0.55, sheen: 0.3, sheenRoughness: 0.6,
      clearcoat: 0.18, clearcoatRoughness: 0.6,
    }),
    helmet: hardShell(C.helmet, { rough: 0.27, cc: 0.9, ccr: 0.11, env: 0.50, repeat: 1.6, nrm: 0.35 }),
    helmetMatte: fabric(0x0d1014, { rubber: true, rough: 0.86, repeat: 3, nrm: 0.7, sheen: 0.4 }),
    lens: new THREE.MeshPhysicalMaterial({
      color: 0xffffff, map: makeLensColor(128),
      roughness: 0.03, metalness: 1.0,
      roughnessMap: rep(lensM.rough, 1),
      clearcoat: 1, clearcoatRoughness: 0.015,
      iridescence: 0.55, iridescenceIOR: 1.45, iridescenceThicknessRange: [240, 620],
      envMapIntensity: 2.1,
    }),
    boot: hardShell(0x22262e, { rough: 0.30, cc: 0.8, ccr: 0.13, env: 0.6, repeat: 2.4, nrm: 0.5 }),
    bootCuff: hardShell(C.bootCuff, { rough: 0.36, cc: 0.7, ccr: 0.18, env: 0.7, repeat: 2.4, nrm: 0.5 }),
    bootSole: new THREE.MeshStandardMaterial({ color: C.bootAccent, roughness: 0.55, metalness: 0.05, envMapIntensity: 0.5 }),
    bootAccent: hardShell(0x8b939e, { rough: 0.32, cc: 0.6, ccr: 0.2, env: 0.7, repeat: 3, nrm: 0.5 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x7d858f, roughness: 0.34, metalness: 1.0, envMapIntensity: 0.75, flatShading: true }),
    binding: new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.35, metalness: 0.25, flatShading: true }),
    poleShaft: new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.28, metalness: 0.85, envMapIntensity: 1.1 }),
    poleGrip: new THREE.MeshStandardMaterial({ color: 0x101318, roughness: 0.85, metalness: 0 }),
    basket: new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.6, metalness: 0, flatShading: true }),
    strap: fabric(0x3a4048, { rough: 0.85, repeat: 5, nrm: 0.8, sheen: 0.8 }),
    strapDark: fabric(0x121620, { rough: 0.80, repeat: 5, nrm: 0.8, sheen: 0.85 }),
    webbing: fabric(0x1a1f28, { rough: 0.82, repeat: 8, nrm: 1.1, sheen: 0.7 }),
    // moulded TPU goggle frame — rubbery, not glossy
    goggleFrame: fabric(0x0e1116, { rubber: true, rough: 0.62, repeat: 4, nrm: 0.7, sheen: 0.5, spec: 0.35 }),
    foam: fabric(0x2a2f38, { rubber: true, rough: 0.92, repeat: 6, nrm: 0.8, sheen: 0.5 }),
    pass: new THREE.MeshPhysicalMaterial({ color: 0xf2f4f7, roughness: 0.25, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.08, side: THREE.DoubleSide }),
    zip: new THREE.MeshStandardMaterial({ color: 0x9aa4b0, roughness: 0.30, metalness: 0.9, envMapIntensity: 1.0 }),
    skiTop: new THREE.MeshPhysicalMaterial({
      map: makeTopsheetTexture({ base: '#171b22', accent: '#f0501c', line: '#e8eef6' }),
      roughness: 0.38, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.22,
      envMapIntensity: 0.55,
    }),
    // freshly tuned steel: near-mirror, so the engaged edge draws a hard bright
    // line along the snow the instant the ski comes off flat
    skiEdge: new THREE.MeshStandardMaterial({ color: 0xdfe5ec, roughness: 0.085, metalness: 1.0, envMapIntensity: 1.6, flatShading: true }),
    // sintered graphite base: black in body colour but glossy, so tilted off the
    // snow it goes bright with reflected sky instead of staying a dead plank
    skiBase: new THREE.MeshPhysicalMaterial({
      color: 0x090b0f, roughness: 0.155, metalness: 0.12,
      clearcoat: 0.55, clearcoatRoughness: 0.12,
      envMapIntensity: 1.05, flatShading: true,
    }),
    skiWall: new THREE.MeshStandardMaterial({ color: 0x2b313a, roughness: 0.45, metalness: 0.05, flatShading: true }),
  };

  // materials that must reflect something to read correctly
  m._reflective = [m.lens, m.helmet, m.metal, m.skiEdge, m.skiBase, m.poleShaft, m.skiTop,
    m.boot, m.bootCuff, m.zip, m.pass];
  for (const mm of m._reflective) mm.envMap = env;
  return m;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function mesh(geo, mat, parent, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(geo, mat);
  o.position.set(x, y, z);
  o.castShadow = true;
  o.receiveShadow = false;
  if (parent) parent.add(o);
  return o;
}
function node(parent, x = 0, y = 0, z = 0) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  if (parent) parent.add(o);
  return o;
}

// skeleton dimensions (metres) — 1.80 m skier
const D = {
  thigh: 0.435,
  shin: 0.425,
  ankleY: 0.132,     // ankle joint above the ski base
  hipHalf: 0.095,
  spine: 0.135,      // pelvis -> lumbar
  chest: 0.185,      // lumbar -> chest
  neck: 0.255,       // chest -> neck base
  head: 0.115,       // neck -> head centre
  shoulderHalf: 0.152,   // deltoid centre: the joint, not the outside of the arm
  shoulderY: 0.175,
  upperArm: 0.295,
  foreArm: 0.265,
};

function buildSki(mats) {
  const g = new THREE.Group();
  const geo = makeSkiGeometry();
  const ski = new THREE.Mesh(geo, [mats.skiTop, mats.skiEdge, mats.skiBase, mats.skiWall]);
  ski.castShadow = true;
  ski.receiveShadow = false;
  ski.position.z = 0.055; // mount point sits 5.5 cm behind the ski's centre
  ski.morphTargetInfluences = [0];
  g.add(ski);

  const y0 = 0.0175; // topsheet height at the waist

  // --- binding: toe piece, heel piece, brakes -------------------------------
  const toe = mesh(new THREE.BoxGeometry(0.084, 0.032, 0.10), mats.binding, g, 0, y0 + 0.016, 0.13);
  toe.geometry.translate(0, 0, 0);
  const toeWingL = mesh(new THREE.BoxGeometry(0.024, 0.026, 0.05), mats.binding, g, 0.042, y0 + 0.03, 0.155);
  const toeWingR = mesh(new THREE.BoxGeometry(0.024, 0.026, 0.05), mats.binding, g, -0.042, y0 + 0.03, 0.155);
  mesh(new THREE.BoxGeometry(0.05, 0.012, 0.03), mats.metal, g, 0, y0 + 0.034, 0.175);
  const heel = mesh(new THREE.BoxGeometry(0.078, 0.056, 0.115), mats.binding, g, 0, y0 + 0.028, -0.145);
  mesh(new THREE.BoxGeometry(0.062, 0.02, 0.03), mats.metal, g, 0, y0 + 0.05, -0.20);
  mesh(new THREE.BoxGeometry(0.10, 0.008, 0.05), mats.binding, g, 0, y0 + 0.008, -0.085);
  // brake arms folded up alongside the boot
  for (const s of [1, -1]) {
    const arm = mesh(new THREE.BoxGeometry(0.008, 0.008, 0.10), mats.metal, g, s * 0.052, y0 + 0.03, -0.115);
    arm.rotation.x = 0.25;
  }
  return { group: g, ski };
}

function buildBoot(mats, side) {
  // rigidly attached to the ski; only the cuff hinges with the shin
  const root = new THREE.Group();
  const y0 = 0.0175 + 0.004;

  // sole: DIN-standard block with a raised toe and heel lug
  mesh(new THREE.BoxGeometry(0.098, 0.020, 0.30), mats.bootSole, root, 0, y0 + 0.010, -0.005);
  mesh(new THREE.BoxGeometry(0.092, 0.030, 0.062), mats.bootSole, root, 0, y0 + 0.024, 0.128);
  mesh(new THREE.BoxGeometry(0.088, 0.034, 0.056), mats.bootSole, root, 0, y0 + 0.026, -0.130);

  // lower shell — clamshell around the foot, wider at the ball, tapered at the heel
  const shell = mesh(lathe([
    [0.020, -0.006], [0.046, 0.010], [0.056, 0.040], [0.058, 0.072],
    [0.054, 0.098], [0.046, 0.116], [0.032, 0.126],
  ], 22, 0.95, 1.62), mats.boot, root, 0, y0 + 0.020, -0.016);
  shell.scale.set(1, 1, 1);
  // toe box, clearly stepped off the shell
  const toeM = mesh(lathe([
    [0.018, -0.02], [0.040, 0.000], [0.047, 0.026], [0.045, 0.050], [0.032, 0.064],
  ], 18, 1.0, 1.5), mats.boot, root, 0, y0 + 0.030, 0.088);
  toeM.rotation.x = -0.18;
  // instep bulge + heel counter
  mesh(lathe([[0.022, 0], [0.044, 0.026], [0.046, 0.062], [0.034, 0.09]], 16, 1.02, 1.0),
    mats.boot, root, 0, y0 + 0.026, -0.086);

  // cuff hinges around the ankle
  const cuff = node(root, 0, y0 + D.ankleY - 0.028, -0.014);
  const cuffM = mesh(lathe([
    [0.030, -0.030], [0.052, -0.010], [0.058, 0.020], [0.059, 0.065],
    [0.057, 0.100], [0.055, 0.132], [0.049, 0.150],
  ], 22, 0.96, 1.20), mats.boot, cuff);
  // rear spoiler
  const sp = mesh(lathe([[0.026, 0.02], [0.038, 0.06], [0.040, 0.105], [0.028, 0.142]], 14, 1.15, 0.75),
    mats.bootCuff, cuff, 0, 0, -0.040);
  sp.rotation.x = -0.10;
  // --- buckle hardware -------------------------------------------------------
  // A real alpine buckle is four readable parts: a toothed ladder screwed to the
  // inboard shell, an aluminium bail that hooks it, a throw lever, and a
  // micro-adjust barrel. Modelling all four is what makes a boot look like a
  // boot at 2 m instead of a black wellington.
  const buckle = (parent, y, z, w, tilt) => {
    const lad = mesh(new THREE.BoxGeometry(0.013, 0.058, 0.010), mats.bootCuff, parent, -side * (w * 0.5 - 0.004), y, z);
    lad.rotation.x = tilt;
    for (let k = 0; k < 4; k++) {
      mesh(new THREE.BoxGeometry(0.017, 0.0035, 0.0075), mats.bootCuff, lad, 0, -0.020 + k * 0.0135, 0.006);
    }
    // bail wire: two straight legs plus a crossbar, hooked over a ladder tooth
    const bail = node(parent, 0, y, z);
    bail.rotation.x = tilt;
    mesh(new THREE.BoxGeometry(w, 0.0055, 0.0055), mats.metal, bail, 0, 0.006, 0.004);
    mesh(new THREE.BoxGeometry(0.0055, 0.0055, 0.020), mats.metal, bail, -side * w * 0.5, 0.006, -0.006);
    mesh(new THREE.BoxGeometry(0.0055, 0.0055, 0.020), mats.metal, bail, side * w * 0.5, 0.006, -0.006);
    // throw lever + micro-adjust barrel, on the outboard side
    const lev = mesh(new THREE.BoxGeometry(0.015, 0.056, 0.021), mats.bootCuff, parent, side * (w * 0.5 + 0.004), y + 0.006, z - 0.006);
    lev.rotation.set(tilt, 0, side * 0.10);
    mesh(new THREE.BoxGeometry(0.017, 0.016, 0.024), mats.bootAccent, lev, 0, 0.028, 0.001);
    mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.019, 8), mats.metal, lev, 0, -0.020, 0.003)
      .rotation.z = Math.PI * 0.5;
  };
  buckle(cuff, 0.022, 0.036, 0.100, -0.10);
  buckle(cuff, 0.086, 0.030, 0.096, -0.04);

  // power strap: woven webbing with a cam buckle, in the jacket colour
  mesh(lathe([[0.0585, 0.112], [0.0635, 0.1225], [0.0585, 0.133]], 20, 0.98, 1.22, false), mats.jacketPlain, cuff);
  const cam = mesh(new THREE.BoxGeometry(0.030, 0.026, 0.016), mats.bootAccent, cuff, side * 0.050, 0.123, 0.028);
  cam.rotation.z = side * 0.15;
  mesh(new THREE.BoxGeometry(0.020, 0.008, 0.014), mats.metal, cam, 0, 0.012, 0.004);

  // lower-shell buckles over the instep
  buckle(root, y0 + 0.048, 0.036, 0.094, -0.22);
  buckle(root, y0 + 0.090, 0.026, 0.098, -0.14);

  // walk/ride lever on the heel + a brand block on the outboard cuff
  const wl = mesh(new THREE.BoxGeometry(0.020, 0.048, 0.014), mats.bootAccent, cuff, 0, 0.030, -0.052);
  wl.rotation.x = 0.12;
  mesh(new THREE.BoxGeometry(0.004, 0.020, 0.052), mats.jacketPlain, cuff, side * 0.058, 0.062, 0.006);
  // rivet at the cuff hinge — the detail every ski boot has and no toy does
  for (const s of [1, -1]) {
    mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.008, 10), mats.metal, cuff, s * 0.058, -0.006, -0.010)
      .rotation.z = Math.PI * 0.5;
  }
  return { root, cuff };
}

function buildPole(mats, side) {
  const g = new THREE.Group();
  const len = 1.22;
  // shaft: tapered, hangs down -Y from the grip
  const shaft = mesh(new THREE.CylinderGeometry(0.0062, 0.0042, len, 8, 1, true), mats.poleShaft, g, 0, -len * 0.5 + 0.055, 0);
  const grip = mesh(lathe([[0.011, 0], [0.0165, -0.012], [0.017, -0.05], [0.013, -0.096], [0.012, -0.115]], 12), mats.poleGrip, g, 0, 0.06, 0);
  // strap loop
  const st = mesh(new THREE.TorusGeometry(0.036, 0.0035, 4, 12, Math.PI * 1.35), mats.strap, g, 0, 0.026, 0.012);
  st.rotation.set(Math.PI * 0.5, 0, side * 0.5);
  st.scale.set(1, 0.75, 1);
  // basket + tip
  const by = -len + 0.10;
  const basket = mesh(new THREE.CylinderGeometry(0.031, 0.020, 0.011, 10), mats.basket, g, 0, by, 0);
  mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 0.03, 8), mats.basket, g, 0, by + 0.02, 0);
  mesh(new THREE.ConeGeometry(0.0042, 0.055, 8), mats.metal, g, 0, -len + 0.028, 0).rotation.x = Math.PI;
  g.userData.tipY = -len + 0.0005;   // the steel tip, in the pole's own space
  return g;
}

function buildHead(mats, parent, env) {
  const head = node(parent, 0, D.head, 0);

  // skull / balaclava
  const skull = mesh(lathe([
    [0.005, 0.105], [0.048, 0.098], [0.078, 0.072], [0.090, 0.030],
    [0.089, -0.020], [0.078, -0.060], [0.055, -0.086], [0.005, -0.095],
  ], 20, 1.0, 1.06), mats.helmetMatte, head);

  // face: cheeks + nose bridge. The strip of skin between the goggle foam and
  // the gaiter is small but it is the only warm value on the whole head — with
  // it missing the face is a black hole and the character reads as a helmet on
  // a stick.
  const face = mesh(lathe([
    [0.004, 0.03], [0.046, 0.02], [0.060, -0.01], [0.057, -0.045], [0.039, -0.07], [0.004, -0.08],
  ], 16, 1.05, 0.95), mats.skin, head, 0, 0.0, 0.044);
  const nose = mesh(lathe([[0.006, 0.020], [0.017, -0.004], [0.015, -0.024]], 10, 1.0, 1.5), mats.skin, head, 0, -0.010, 0.077);
  nose.rotation.x = -0.35;
  // cheekbones catching light just under the goggle frame
  for (const s of [1, -1]) {
    mesh(lathe([[0.006, 0.014], [0.020, 0.002], [0.022, -0.018], [0.006, -0.032]], 10, 1.1, 1.0),
      mats.skin, head, s * 0.036, -0.028, 0.058);
  }

  // Neck gaiter — a lofted tube, not a lathe, so it can be flat at the back and
  // bulge over the chin at the front, with a rolled-over top edge.
  const gaiter = mesh(garment([
    //  v     rx     rz     ox     oz     y
    [0.00, 0.056, 0.058, 0, 0.004, 0.030],
    [0.18, 0.070, 0.072, 0, 0.006, -0.006],
    [0.42, 0.076, 0.078, 0, 0.006, -0.056],
    [0.70, 0.079, 0.079, 0, 0.004, -0.116],
    [1.00, 0.070, 0.070, 0, 0.000, -0.174],
  ], {
    nu: 22, nv: 18, capB: false,
    fold: (u, v) => 0.0026 * Math.sin(u * Math.PI * 2 * 9 + v * 3)
      + 0.004 * (fbm(u * 5, v * 4, 5, 41, 3) - 0.5)
      + 0.004 * Math.exp(-Math.pow((v - 0.14) / 0.09, 2)),   // rolled top edge
  }), mats.jacketDark, head, 0, 0, 0.006);
  gaiter.material = mats.gaiter || mats.jacketDark;

  // --- helmet ---------------------------------------------------------------
  // A moulded in-mould shell: one continuous surface, slightly egg-shaped
  // (deeper than wide), with a proper occipital bulge at the back. The old
  // version wore a torus over the crown that read as a roll bar.
  const helm = mesh(garment([
    [0.00, 0.106, 0.113, 0, -0.004, -0.064],
    [0.14, 0.112, 0.120, 0, -0.006, -0.030],
    [0.34, 0.113, 0.121, 0, -0.006, 0.014],
    [0.56, 0.104, 0.111, 0, -0.004, 0.060],
    [0.78, 0.076, 0.081, 0, -0.002, 0.104],
    [0.92, 0.044, 0.047, 0, 0.000, 0.128],
    [1.00, 0.010, 0.011, 0, 0.000, 0.136],
  ], {
    nu: 30, nv: 22, capB: true,
    // occipital bulge at the back, slight flat over the brow
    fold: (u, v) => {
      const back = clamp(-Math.sin(u * Math.PI * 2), 0, 1);
      const front = clamp(Math.sin(u * Math.PI * 2), 0, 1);
      return 0.006 * back * THREE.MathUtils.smoothstep(v, 0.0, 0.45)
        - 0.004 * front * THREE.MathUtils.smoothstep(v, 0.25, 0.6) * (1 - v);
    },
  }), mats.helmet, head, 0, 0.004, 0);

  // Moulded accent: a circumferential band low on the shell plus a side flash.
  // Both are rings of the helmet's own profile, so they sit exactly on it.
  mesh(garment([
    [0.00, 0.1130, 0.1205, 0, -0.006, -0.020],
    [0.45, 0.1148, 0.1223, 0, -0.006, 0.002],
    [1.00, 0.1128, 0.1203, 0, -0.006, 0.024],
  ], { nu: 30, nv: 6 }), mats.helmetAccent, head, 0, 0.004, 0);

  // ear pads: soft, tucked under the shell edge
  for (const s of [1, -1]) {
    const ear = mesh(lathe([[0.004, 0.03], [0.030, 0.024], [0.038, -0.008], [0.031, -0.042], [0.004, -0.054]], 12, 1, 1.35),
      mats.foam, head, s * 0.098, -0.048, -0.010);
    ear.rotation.z = s * -0.25;
  }
  // chin strap: webbing from each ear pad down under the jaw, with a buckle
  for (const s of [1, -1]) {
    const st = mesh(new THREE.BoxGeometry(0.008, 0.085, 0.020), mats.webbing, head, s * 0.086, -0.090, 0.006);
    st.rotation.set(0.06, 0, s * 0.30);
  }
  const chinB = mesh(new THREE.BoxGeometry(0.030, 0.016, 0.022), mats.helmetMatte, head, 0, -0.126, 0.014);
  chinB.rotation.x = 0.18;

  // brow ridge / visor lip above the goggles
  const brim = mesh(new THREE.TorusGeometry(0.099, 0.0095, 6, 22, Math.PI * 0.64), mats.helmet, head, 0, 0.060, 0.012);
  brim.rotation.set(Math.PI * 0.5 - 0.55, 0, -Math.PI * 0.5 + 0.30);
  brim.scale.set(1.06, 1.0, 0.62);
  // vents — recessed slots, front and crown
  for (let i = -1; i <= 1; i++) {
    const v = mesh(new THREE.BoxGeometry(0.014, 0.011, 0.046), mats.helmetMatte, head, i * 0.036, 0.117, 0.028 - Math.abs(i) * 0.014);
    v.rotation.x = -0.35;
  }
  for (const s of [1, -1]) {
    mesh(new THREE.BoxGeometry(0.010, 0.030, 0.013), mats.helmetMatte, head, s * 0.070, 0.084, -0.086).rotation.x = 0.5;
  }

  // goggle strap — arc around the back of the helmet, with the silicone grip
  // stripe and the adjuster clip that every real strap has
  const strap = mesh(new THREE.TorusGeometry(0.111, 0.015, 8, 24, Math.PI * 1.30), mats.strapDark, head, 0, 0.020, -0.006);
  strap.rotation.set(Math.PI * 0.5 - 0.20, 0, Math.PI * 0.5 + Math.PI * 0.35);
  strap.scale.set(1.0, 1.0, 0.46);
  const gripStripe = mesh(new THREE.TorusGeometry(0.1128, 0.0045, 6, 24, Math.PI * 1.24), mats.jacketPlain, head, 0, 0.020, -0.006);
  gripStripe.rotation.copy(strap.rotation);
  gripStripe.scale.set(1.0, 1.0, 0.465);
  const clip = mesh(new THREE.BoxGeometry(0.016, 0.030, 0.026), mats.helmetMatte, head, 0.102, 0.030, -0.052);
  clip.rotation.y = -0.5;

  // --- goggles --------------------------------------------------------------
  // frame, closed-cell face foam, cylindrical mirrored lens
  const lensGeo = new THREE.SphereGeometry(0.098, 40, 20, Math.PI * 0.5 - 1.00, 2.00, Math.PI * 0.5 - 0.50, 0.88);
  lensGeo.scale(1.15, 0.94, 0.84);
  const frameGeo = new THREE.SphereGeometry(0.100, 36, 18, Math.PI * 0.5 - 1.08, 2.16, Math.PI * 0.5 - 0.62, 1.14);
  frameGeo.scale(1.16, 0.96, 0.85);
  const foamGeo = new THREE.SphereGeometry(0.0965, 30, 16, Math.PI * 0.5 - 1.06, 2.12, Math.PI * 0.5 - 0.60, 1.10);
  foamGeo.scale(1.14, 0.95, 0.80);
  const frame = mesh(frameGeo, mats.goggleFrame, head, 0, 0.016, 0.012);
  frame.material.side = THREE.DoubleSide;
  const foamR = mesh(foamGeo, mats.foam, head, 0, 0.016, 0.004);
  foamR.material.side = THREE.DoubleSide;
  const lens = mesh(lensGeo, mats.lens, head, 0, 0.016, 0.016);
  lens.castShadow = false;
  if (env) lens.material.envMap = env;
  // frame outriggers where the strap anchors
  for (const s of [1, -1]) {
    const og = mesh(new THREE.BoxGeometry(0.014, 0.038, 0.020), mats.goggleFrame, head, s * 0.107, 0.020, -0.020);
    og.rotation.y = s * 0.5;
  }
  return { head, lens };
}

export function createSkier(scene) {
  const env = makeFallbackEnv();
  const mats = makeMaterials(env);

  const group = new THREE.Group();
  group.name = 'skier';
  // `group` carries a snow-aligned basis (see update): local y = 0 IS the contact
  // plane and local +Z is the direction of travel. skiRoot holds everything that
  // must stay welded to the snow; bodyRoot everything that leans off it.
  const skiRoot = new THREE.Group();
  const bodyRoot = new THREE.Group();
  group.add(skiRoot, bodyRoot);

  // ---- skis, bindings, boots ----------------------------------------------
  const legs = [];
  for (const side of [1, -1]) {
    const pivot = node(skiRoot);       // sits ON the contact edge, rolls with the carve
    const body = node(pivot);          // ski centreline
    const skiParts = buildSki(mats);
    body.add(skiParts.group);
    const boot = buildBoot(mats, side);
    body.add(boot.root);
    const ankle = node(body, 0, 0.0175 + 0.006 + D.ankleY, -0.012);
    // the running surface of this ski, in the ski's own space: the rig grounds
    // itself on this number instead of a hand-tuned fudge
    const contactY = skiParts.ski.geometry.userData.contactY;
    legs.push({ side, pivot, body, ski: skiParts.ski, boot, ankle, contactY, ankleLocal: new THREE.Vector3() });
  }

  // ---- pelvis / spine / chest ---------------------------------------------
  const pelvis = node(bodyRoot, 0, 0.98, 0);
  // Salopette seat. Kept deliberately narrow: it lives *inside* the jacket hem
  // and only the bit below the hem is ever seen, so it can never punch out of
  // the jacket when the pelvis and chest counter-rotate against each other.
  mesh(garment([
    [0.00, 0.084, 0.078, 0, 0.000, 0.118],
    [0.22, 0.116, 0.104, 0, -0.004, 0.056],
    [0.48, 0.128, 0.115, 0, -0.012, -0.020],
    [0.76, 0.121, 0.108, 0, -0.010, -0.086],
    [1.00, 0.101, 0.092, 0, -0.004, -0.126],
  ], {
    nu: 24, nv: 20, capA: true, capB: true,
    fold: (u, v) => {
      const back = clamp(-Math.sin(u * Math.PI * 2), 0, 1);
      // seat panel: a soft rise over each buttock with a shallow centre seam
      const cleft = Math.exp(-Math.pow(((u % 0.5) - 0.25) / 0.06, 2));
      return 0.010 * back * back * THREE.MathUtils.smoothstep(v, 0.2, 0.62) * (1 - THREE.MathUtils.smoothstep(v, 0.7, 1))
        - 0.007 * back * cleft * THREE.MathUtils.smoothstep(v, 0.3, 0.6)
        + 0.003 * (fbm(u * 5, v * 4, 5, 61, 3) - 0.5);
    },
  }), mats.pant, pelvis);
  // salopette bib + waist webbing, visible in the gap under the jacket hem
  mesh(garment([
    [0.00, 0.1230, 0.1105, 0, -0.004, 0.070],
    [0.50, 0.1255, 0.1130, 0, -0.004, 0.056],
    [1.00, 0.1230, 0.1105, 0, -0.004, 0.042],
  ], { nu: 24, nv: 5 }), mats.webbing, pelvis);

  const spine = node(pelvis, 0, D.spine, 0);

  // =========================================================================
  // JACKET — one continuous lofted garment from hem to collar.
  //
  // The old torso was four stacked lathes and every junction between them was
  // a hard step: that is what read as "detached geometric blocks". This is a
  // single surface with an authored waist nip, a chest bulge, a flatter back
  // panel, a flared hem and radial slack that gathers into vertical drape
  // folds low down — plus quilted baffles from the texture, so the mass has
  // internal structure instead of being one unbroken field of orange.
  // =========================================================================
  const chest = node(spine, 0, D.chest, 0);
  const JACKET = [
    //  v     rx     rz     ox      oz      y
    [0.000, 0.148, 0.113, 0, 0.004, -0.300],   // hem underside, turned in
    [0.060, 0.172, 0.132, 0, 0.006, -0.276],   // hem band, widest
    [0.145, 0.165, 0.126, 0, 0.008, -0.236],
    [0.275, 0.152, 0.116, 0, 0.012, -0.170],   // waist
    [0.410, 0.160, 0.122, 0, 0.014, -0.096],
    [0.550, 0.176, 0.133, 0, 0.014, -0.012],
    [0.680, 0.194, 0.140, 0, 0.010, 0.070],    // chest
    [0.800, 0.196, 0.136, 0, 0.004, 0.146],
    [0.868, 0.196, 0.130, 0, 0.000, 0.196],    // shoulder stays square
    [0.908, 0.186, 0.122, 0, -0.004, 0.226],   // acromion
    [0.948, 0.150, 0.106, 0, -0.006, 0.258],
    [0.978, 0.112, 0.090, 0, -0.002, 0.290],
    [1.000, 0.100, 0.086, 0, 0.002, 0.322],    // collar top
  ];
  const jacketFold = (u, v) => {
    const a = u * Math.PI * 2;
    const front = clamp(Math.sin(a), 0, 1), back = clamp(-Math.sin(a), 0, 1);
    let f = 0.0045 * (fbm(u * 4, v * 3.2, 4, 17, 3) - 0.5) * 2;
    // vertical drape folds, gathering toward the hem
    f += 0.0040 * Math.sin(a * 7 + v * 2.4) * (1 - THREE.MathUtils.smoothstep(v, 0.15, 0.62));
    // slack across the back between the shoulder blades
    f += 0.0060 * back * Math.exp(-Math.pow((v - 0.62) / 0.22, 2));
    // chest fills forward
    f += 0.0070 * front * Math.exp(-Math.pow((v - 0.70) / 0.17, 2));
    // the belt of the jacket cinches
    f -= 0.0055 * Math.exp(-Math.pow((v - 0.275) / 0.055, 2));
    return f;
  };
  // the hem is not a machined ring: it hangs 2 cm lower at the back and lifts
  // where it breaks over the hip bones
  const jacketDrop = (u, v) => {
    const back = clamp(-Math.sin(u * Math.PI * 2), 0, 1);
    const hip = Math.exp(-Math.pow((Math.abs(Math.cos(u * Math.PI * 2)) - 1) / 0.45, 2));
    return (1 - THREE.MathUtils.smoothstep(v, 0.0, 0.30))
      * (-0.020 * back * back + 0.010 * hip + 0.004 * Math.sin(u * Math.PI * 2 * 3));
  };
  const torso = mesh(garment(JACKET, {
    nu: 34, nv: 44, capA: true, flatBack: 0.10, fold: jacketFold, drop: jacketDrop,
    // 0 = quilted body, 1 = plain shell hem band + collar
    matFn: (v) => (v < 0.128 || v > 0.952 ? 1 : 0),
  }), [mats.jacket, mats.jacketDark], chest);

  // Raglan yoke: a real overlapping panel with its own edge, not a colour band.
  // Riding 6 mm proud of the body means it throws its own shadow line.
  mesh(garment(JACKET.filter((r) => r[0] >= 0.78).map((r) => {
    const t = (r[0] - 0.78) / 0.22;
    const off = 0.0026 * THREE.MathUtils.smoothstep(t, 0.0, 0.55);
    return [t, r[1] + off, r[2] + off, r[3], r[4], r[5]];
  }), {
    nu: 44, nv: 18, flatBack: 0.10,
    fold: (u, v) => jacketFold(u, 0.78 + v * 0.22),
    drop: (u, v) => jacketDrop(u, 0.78 + v * 0.22),
  }), mats.jacketPlain, chest);
  // cyan piping welt sewn along the yoke seam
  mesh(garment([
    [0.00, 0.1968, 0.1374, 0, 0.005, 0.1405],
    [0.50, 0.1986, 0.1390, 0, 0.005, 0.1440],
    [1.00, 0.1968, 0.1374, 0, 0.004, 0.1475],
  ], {
    nu: 36, nv: 5, flatBack: 0.10,
    drop: (u) => jacketDrop(u, 0.83),
    // ride the low-frequency part of the fold field only: following every
    // wrinkle made the piping wobble like a neon squiggle
    fold: (u) => 0.0060 * clamp(-Math.sin(u * Math.PI * 2), 0, 1)
      * Math.exp(-Math.pow((0.83 - 0.62) / 0.22, 2)) + 0.0012,
  }), mats.accentDim, chest);
  // hem band welt + drawcord channel
  mesh(garment([
    [0.00, 0.1665, 0.1265, 0, 0.008, -0.232],
    [0.50, 0.1700, 0.1300, 0, 0.008, -0.226],
    [1.00, 0.1665, 0.1265, 0, 0.008, -0.220],
  ], {
    nu: 34, nv: 5, flatBack: 0.10,
    drop: (u) => jacketDrop(u, 0.145),
    fold: (u) => jacketFold(u, 0.145) + 0.0015,
  }), mats.jacketDark, chest);

  // --- front zip, garage, chest pocket, pit vent ----------------------------
  // The zip follows the jacket's own front profile so it never floats off it.
  const jSample = ringSampler(JACKET);
  const jRow = [0, 0, 0, 0, 0];
  const zipAt = (v, out, dz = 0.005) => {
    jSample(v, jRow);
    out.set(jRow[2], jRow[4], jRow[3] + jRow[1] + jacketFold(0.25, v) + dz);
  };
  const zipStrip = (v0, v1, halfW, dz) => paramSurface((u, v, out) => {
    zipAt(lerp(v0, v1, v), out, dz);
    const a = (u - 0.5) * Math.PI;          // wrap the strip around the body
    const r = out.z;
    out.set(Math.sin(a) * halfW, out.y, r - (1 - Math.cos(a)) * halfW * 0.55);
  }, { nu: 8, nv: 22, flip: true });
  mesh(zipStrip(0.10, 0.965, 0.0135, 0.0026), mats.jacketPlain, chest);
  // the coil itself is dark webbing with a fine tooth relief — a bright metal
  // stripe down the chest reads as a seam bug, not a zip
  mesh(zipStrip(0.12, 0.955, 0.0032, 0.0058), mats.webbing, chest);
  // zip pull: a metal slider with a fabric tab, hanging under gravity-ish
  const zipPull = node(chest);
  const _zp = new THREE.Vector3();
  zipAt(0.60, _zp, 0.013);
  zipPull.position.copy(_zp);
  mesh(new THREE.BoxGeometry(0.013, 0.020, 0.008), mats.zip, zipPull, 0, 0, 0);
  mesh(new THREE.BoxGeometry(0.007, 0.030, 0.004), mats.webbing, zipPull, 0, -0.024, 0.001);
  mesh(new THREE.BoxGeometry(0.011, 0.012, 0.005), mats.accent, zipPull, 0, -0.042, 0.001);
  // chest pocket zip, off-centre — asymmetry the eye reads as "designed".
  // A 6 mm tape, not a panel: at this scale a zip is a line, and the slider is
  // the only thing on the whole jacket allowed to be shiny metal.
  const tape = (u0, u1, v0, dv, halfH, out3, mat) => {
    const g = paramSurface((u, v, o2) => {
      const uu = lerp(u0, u1, u);
      const vv = v0 + uu * dv;
      jSample(vv, jRow);
      const a = uu * Math.PI * 2;
      const f = jacketFold(uu, vv) + out3;
      const r = (v - 0.5) * 2;
      o2.set(jRow[2] + Math.cos(a) * (jRow[0] + f * (1 - r * r * 0.5)),
        jRow[4] + r * halfH,
        jRow[3] + Math.sin(a) * (jRow[1] + f * (1 - r * r * 0.5)));
    }, { nu: 16, nv: 3, flip: false });
    return mesh(g, mat, chest);
  };
  tape(0.155, 0.300, 0.760, -0.020, 0.0055, 0.005, mats.webbing);
  const slider = mesh(new THREE.BoxGeometry(0.010, 0.015, 0.007), mats.zip, chest);
  {
    jSample(0.752, jRow);
    const a = 0.285 * Math.PI * 2;
    const f = jacketFold(0.285, 0.752) + 0.010;
    slider.position.set(jRow[2] + Math.cos(a) * (jRow[0] + f), jRow[4], jRow[3] + Math.sin(a) * (jRow[1] + f));
    slider.rotation.y = -a + Math.PI * 0.5;
    mesh(new THREE.BoxGeometry(0.005, 0.020, 0.003), mats.webbing, slider, 0, -0.016, 0.002);
  }
  // a second, hip-level hand-warmer pocket on the other side
  tape(0.640, 0.760, 0.330, 0.045, 0.0050, 0.004, mats.webbing);

  // Panel seams. A garment is cut from flat pieces and sewn: without seams the
  // back is one uninterrupted 40 cm field of colour, which is exactly what the
  // eye files under "plastic". These are welts on the jacket's own surface.
  const seam = (uc, v0, v1, halfW, out3, mat, bow = 0) => mesh(paramSurface((u, v, o2) => {
    const vv = lerp(v0, v1, v);
    const uu = uc + bow * Math.sin(v * Math.PI);
    jSample(vv, jRow);
    const a = (uu + (u - 0.5) * 2 * halfW) * Math.PI * 2;
    const bump = out3 * Math.cos((u - 0.5) * Math.PI)
      * Math.pow(Math.sin(clamp(v, 0, 1) * Math.PI), 0.35);
    o2.set(jRow[2] + Math.cos(a) * (jRow[0] + jacketFold(uu, vv) + bump),
      jRow[4] + jacketDrop(uu, vv),
      jRow[3] + Math.sin(a) * (jRow[1] * (1 - 0.10 * clamp(-Math.sin(a), 0, 1)) + jacketFold(uu, vv) + bump));
  }, { nu: 8, nv: 22, flip: false }), mat, chest);
  seam(0.750, 0.150, 0.905, 0.0060, 0.0014, mats.jacketPlain);          // centre back
  seam(0.632, 0.470, 0.880, 0.0055, 0.0012, mats.jacketPlain, 0.030);   // shoulder blade
  seam(0.868, 0.470, 0.880, 0.0055, 0.0012, mats.jacketPlain, -0.030);
  seam(0.068, 0.180, 0.700, 0.0055, 0.0011, mats.jacketPlain);          // side panels
  seam(0.432, 0.180, 0.700, 0.0055, 0.0011, mats.jacketPlain);

  const neck = node(chest, 0, D.neck, 0.008);
  const { head, lens } = buildHead(mats, neck, env);

  // stowed hood, rolled behind the collar — a big silhouette win from behind
  // Stowed hood. Every reference photo of a shell jacket shows the same thing:
  // a soft collar volume that wraps the sides of the neck and piles up behind
  // it, tapering to nothing at the zip. That mass is the single biggest reason
  // a real jacket has a shoulder line and a mannequin does not.
  mesh(garment([
    [0.00, 0.106, 0.092, 0, -0.006, 0.186],
    [0.20, 0.116, 0.100, 0, -0.010, 0.216],
    [0.46, 0.118, 0.102, 0, -0.014, 0.254],
    [0.72, 0.108, 0.094, 0, -0.014, 0.290],
    [0.90, 0.090, 0.080, 0, -0.010, 0.316],
    [1.00, 0.074, 0.068, 0, -0.006, 0.330],
  ], {
    nu: 30, nv: 22, capB: true,
    fold: (u, v) => {
      const a = u * Math.PI * 2;
      const back = clamp(-Math.sin(a), 0, 1);
      const side = Math.abs(Math.cos(a));
      // bulk piles up behind the neck and thins out to the zip at the front
      const bulk = 0.008 + 0.056 * Math.pow(back, 0.7) + 0.013 * Math.pow(side, 3);
      return bulk * (0.35 + 0.65 * Math.sin(clamp(v, 0, 1) * Math.PI * 0.92))
        + 0.004 * Math.sin(a * 5 + v * 4) * back
        + 0.003 * (fbm(u * 4, v * 4, 4, 91, 3) - 0.5);
    },
  }), mats.jacketDark, chest);
  // drawcord + toggle running round the hood's face opening
  mesh(garment([
    [0.00, 0.0785, 0.0715, 0, -0.006, 0.3235],
    [0.50, 0.0810, 0.0740, 0, -0.006, 0.3300],
    [1.00, 0.0785, 0.0715, 0, -0.006, 0.3365],
  ], {
    nu: 26, nv: 5,
    fold: (u) => (0.008 + 0.056 * Math.pow(clamp(-Math.sin(u * Math.PI * 2), 0, 1), 0.7)
      + 0.013 * Math.pow(Math.abs(Math.cos(u * Math.PI * 2)), 3)) * 0.35,
  }), mats.webbing, chest);

  // lift pass on a lanyard, clipped to the hem D-ring
  {
    const lan = node(chest, -0.128, -0.212, 0.086);
    lan.rotation.set(0.18, -0.35, 0.22);
    mesh(new THREE.BoxGeometry(0.006, 0.052, 0.002), mats.webbing, lan, 0, -0.024, 0);
    const card = mesh(new THREE.PlaneGeometry(0.056, 0.084), mats.pass, lan, 0, -0.086, 0.001);
    card.castShadow = false;
    mesh(new THREE.PlaneGeometry(0.050, 0.020), mats.accent, lan, 0, -0.112, 0.0025).castShadow = false;
    mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.003, 8), mats.zip, lan, 0, -0.049, 0);
  }

  // ---- arms ----------------------------------------------------------------
  const arms = [];
  for (const side of [1, -1]) {
    const shoulder = node(chest, side * D.shoulderHalf, D.shoulderY, 0.004);
    // Sleeve: one loft from a deltoid cap that is buried inside the jacket
    // right down past the elbow, so there is no floating cone and no seam at
    // the armhole. Creases gather on the inside of the elbow.
    const sleeveFold = (u, v) => {
      const a = u * Math.PI * 2;
      let f = 0.0030 * (fbm(u * 5, v * 5, 5, 29 + side, 3) - 0.5) * 2;
      // wrinkle rings that bunch toward the elbow
      f += 0.0022 * Math.sin(v * 34 + Math.sin(a * 3) * 0.6) * THREE.MathUtils.smoothstep(v, 0.45, 0.95);
      f += 0.0026 * Math.sin(a * 6 + v * 3);
      return f;
    };
    mesh(garment([
      [0.00, 0.020, 0.020, 0, 0, 0.054],
      [0.07, 0.052, 0.051, 0, 0.001, 0.042],
      [0.18, 0.076, 0.074, 0, 0.002, 0.012],
      [0.30, 0.084, 0.082, 0, 0.002, -0.024],
      [0.46, 0.0815, 0.0795, 0, 0.001, -0.092],
      [0.66, 0.0730, 0.0718, 0, 0, -0.174],
      [0.84, 0.0662, 0.0652, 0, 0, -0.244],
      [1.00, 0.062, 0.062, 0, 0, -0.302],
    ], { nu: 22, nv: 30, capA: true, fold: sleeveFold }), mats.jacketPlain, shoulder);
    // shoulder-cap panel in the yoke colour, tying the arm into the torso
    mesh(garment([
      [0.00, 0.0180, 0.0180, 0, 0, 0.056],
      [0.18, 0.0560, 0.0550, 0, 0.001, 0.040],
      [0.50, 0.0830, 0.0810, 0, 0.002, 0.006],
      [0.80, 0.0862, 0.0838, 0, 0.002, -0.032],
      [1.00, 0.0796, 0.0776, 0, 0.001, -0.070],
    ], { nu: 22, nv: 12, capA: true, fold: (u, v) => sleeveFold(u, v * 0.22) }),
      mats.jacketPlain, shoulder);
    // reflective accent welt above the elbow — a full ring, not two dots
    mesh(garment([
      [0.00, 0.0710, 0.0700, 0, 0, -0.1965],
      [0.50, 0.0722, 0.0712, 0, 0, -0.1910],
      [1.00, 0.0710, 0.0700, 0, 0, -0.1855],
    ], { nu: 26, nv: 5, fold: (u, v) => sleeveFold(u, 0.63) }), mats.accentDim, shoulder);

    const elbow = node(shoulder, 0, -D.upperArm, 0);
    // A joint that bends needs geometry ON the joint: this barrel is driven at
    // half the elbow angle, so the sleeve creases instead of hinging like a
    // doll's arm.
    const elbowMid = node(shoulder, 0, -D.upperArm, 0);
    mesh(garment([
      [0.00, 0.0605, 0.0605, 0, 0, 0.052],
      [0.30, 0.0655, 0.0645, 0, 0.002, 0.014],
      [0.62, 0.0665, 0.0655, 0, 0.003, -0.030],
      [1.00, 0.0600, 0.0600, 0, 0.001, -0.070],
    ], {
      nu: 20, nv: 16,
      // hard gather ridges on the outside of the joint
      // fabric bunches hard on the outside of a bent elbow and pulls tight
      // across the inside — that asymmetry is what sells an articulated joint
      fold: (u, v) => 0.0055 * Math.sin(v * 17 + 1.2) * clamp(Math.sin(u * Math.PI * 2), 0, 1)
        + 0.0022 * Math.sin(u * Math.PI * 2 * 7)
        - 0.0030 * clamp(-Math.sin(u * Math.PI * 2), 0, 1) * Math.exp(-Math.pow((v - 0.5) / 0.3, 2)),
    }), mats.jacketPlain, elbowMid);

    mesh(garment([
      [0.00, 0.0605, 0.0600, 0, 0, 0.030],
      [0.18, 0.0605, 0.0595, 0, 0, -0.022],
      [0.48, 0.0570, 0.0560, 0, 0, -0.112],
      [0.78, 0.0505, 0.0500, 0, 0, -0.198],
      [0.92, 0.0545, 0.0535, 0, 0.001, -0.242],   // gauntlet flare
      [1.00, 0.0520, 0.0510, 0, 0.001, -0.274],
    ], {
      nu: 22, nv: 26, capB: true,
      fold: (u, v) => 0.0038 * (fbm(u * 4, v * 4, 4, 37 + side, 3) - 0.5) * 2
        + 0.0030 * Math.sin(u * Math.PI * 2 * 5 + v * 1.6)
        + 0.0034 * Math.sin(v * 12.5) * (1 - THREE.MathUtils.smoothstep(v, 0.55, 0.95)),
    }), mats.jacketDark, elbow);
    // gauntlet: cinch strap with a webbing tab and a slider
    mesh(garment([
      [0.00, 0.0558, 0.0548, 0, 0.001, -0.228],
      [0.50, 0.0578, 0.0568, 0, 0.001, -0.219],
      [1.00, 0.0558, 0.0548, 0, 0.001, -0.210],
    ], { nu: 20, nv: 5 }), mats.webbing, elbow);
    const tab = mesh(new THREE.BoxGeometry(0.026, 0.014, 0.005), mats.accent, elbow,
      side * 0.053, -0.219, 0.017);
    tab.rotation.y = side * 0.5;
    // sleeve creases where the cuff is pushed back up the forearm
    mesh(garment([
      [0.00, 0.0545, 0.0538, 0, 0, -0.150],
      [0.35, 0.0562, 0.0555, 0, 0, -0.166],
      [0.70, 0.0552, 0.0545, 0, 0, -0.182],
      [1.00, 0.0538, 0.0531, 0, 0, -0.196],
    ], {
      nu: 20, nv: 10,
      fold: (u, v) => 0.0030 * Math.sin(v * 13 + Math.sin(u * Math.PI * 2 * 3) * 0.7),
    }), mats.jacketDark, elbow);

    const wrist = node(elbow, 0, -D.foreArm, 0);
    // --- glove: back-of-hand shell, rubberised palm, four fingers, a thumb ---
    const glove = mesh(garment([
      [0.00, 0.0435, 0.0360, 0, 0.004, 0.012],
      [0.22, 0.0495, 0.0420, 0, 0.009, -0.024],
      [0.52, 0.0510, 0.0455, 0, 0.016, -0.062],
      [0.80, 0.0440, 0.0405, 0, 0.018, -0.097],
      [1.00, 0.0265, 0.0265, 0, 0.014, -0.119],
    ], {
      nu: 20, nv: 18, capA: true, capB: true,
      fold: (u, v) => 0.0016 * Math.sin(u * Math.PI * 2 * 5)
        + 0.002 * (fbm(u * 6, v * 6, 6, 53, 3) - 0.5),
    }), mats.gloveBack, wrist);
    // hi-vis knuckle patch — in every reference photo the glove is the second
    // most readable object on the skier after the boot, never a black lump
    mesh(garment([
      [0.00, 0.0310, 0.0220, 0, 0, -0.012],
      [0.40, 0.0415, 0.0292, 0, 0, -0.034],
      [0.75, 0.0398, 0.0282, 0, 0, -0.058],
      [1.00, 0.0288, 0.0206, 0, 0, -0.074],
    ], { nu: 16, nv: 10, capA: true, capB: true }), mats.accent, wrist, 0, 0, 0.032);
    // fingers curled round the grip — four rolls, the readable "this is a fist"
    for (let k = 0; k < 4; k++) {
      const t = k / 3;
      const f = mesh(lathe([
        [0.007, 0.032], [0.0128, 0.023], [0.0138, 0], [0.0128, -0.023], [0.007, -0.032],
      ], 10, 1, 1.0), mats.glove, wrist,
        0, -0.027 - t * 0.062, 0.043 - t * 0.009 + Math.sin(t * Math.PI) * 0.004);
      f.rotation.z = Math.PI * 0.5;
      f.scale.set(1, 2.1 - t * 0.35, 1);
    }
    // knuckle ridge across the back of the hand
    const thumb = mesh(lathe([[0.009, 0.012], [0.017, -0.017], [0.018, -0.040], [0.009, -0.056]], 10, 1, 1.15),
      mats.glove, wrist, side * 0.037, -0.033, 0.027);
    thumb.rotation.set(-0.55, 0, side * 0.62);
    // wrist cinch + pull loop
    mesh(garment([
      [0.00, 0.0442, 0.0368, 0, 0.005, 0.004],
      [0.50, 0.0464, 0.0390, 0, 0.005, -0.006],
      [1.00, 0.0442, 0.0368, 0, 0.005, -0.016],
    ], { nu: 18, nv: 5 }), mats.webbing, wrist);
    mesh(new THREE.TorusGeometry(0.013, 0.0032, 5, 10), mats.webbing, wrist, -side * 0.045, -0.006, -0.014)
      .rotation.y = Math.PI * 0.5;

    const poleGrip = node(wrist, 0, -0.055, 0.012);
    const pole = buildPole(mats, side);
    poleGrip.add(pole);
    arms.push({ side, shoulder, elbow, elbowMid, wrist, poleGrip, glove, pole });
  }

  // ---- leg meshes (driven by IK) -------------------------------------------
  for (const L of legs) {
    const s = L.side;
    L.hip = node(pelvis, s * D.hipHalf, -0.045, 0);
    // Trouser slack. Photographic reference is unambiguous: a ski pant is loose
    // enough to throw 10-15 mm folds, gathers into hard horizontal creases just
    // above the boot, and pinches behind the knee. At 3 mm it reads as a rubber
    // tube, which is exactly what the old legs looked like.
    const legFold = (u, v) => {
      const a = u * Math.PI * 2;
      const front = clamp(Math.sin(a), 0, 1), back = clamp(-Math.sin(a), 0, 1);
      return 0.0065 * (fbm(u * 3.4, v * 3.4, 4, 71 + s, 3) - 0.5) * 2
        + 0.0050 * Math.sin(a * 5 + v * 2.0)
        + 0.0028 * Math.sin(a * 11 - v * 3.1)
        // gather rings stacking up toward the boot
        + 0.0075 * Math.sin(v * 15.5 + Math.sin(a * 2) * 0.8)
        * THREE.MathUtils.smoothstep(v, 0.50, 0.95) * (0.45 + 0.55 * front)
        // the fabric is drawn tight behind the knee and bags in front of it
        - 0.0070 * back * Math.exp(-Math.pow((v - 0.90) / 0.13, 2))
        + 0.0060 * front * Math.exp(-Math.pow((v - 0.80) / 0.16, 2));
    };
    // thigh — one loft from inside the seat down past the knee
    mesh(garment([
      [0.00, 0.104, 0.108, 0, 0, 0.072],
      [0.15, 0.118, 0.122, 0, 0.002, 0.008],
      [0.36, 0.110, 0.114, 0, 0.002, -0.092],
      [0.60, 0.099, 0.103, 0, 0.001, -0.206],
      [0.82, 0.090, 0.094, 0, 0, -0.322],
      [1.00, 0.086, 0.090, 0, 0, -0.442],
    ], { nu: 22, nv: 30, capA: true, fold: legFold }), mats.pant, L.hip);
    // Outseam welt: a real sewn ridge down the outside of the leg. A trouser
    // with no seam is a rubber tube, and that is what the legs read as before.
    const thighRing = ringSampler([
      [0.00, 0.104, 0.108, 0, 0, 0.072],
      [0.15, 0.118, 0.122, 0, 0.002, 0.008],
      [0.36, 0.110, 0.114, 0, 0.002, -0.092],
      [0.60, 0.099, 0.103, 0, 0.001, -0.206],
      [0.82, 0.090, 0.094, 0, 0, -0.322],
      [1.00, 0.086, 0.090, 0, 0, -0.442],
    ]);
    const tRow = [0, 0, 0, 0, 0];
    const legSeam = (uc, halfU, v0, v1, out3, mat, parent, ring) => mesh(paramSurface((u, v, o2) => {
      const uu = uc + (u - 0.5) * 2 * halfU;
      const vv = lerp(v0, v1, v);
      ring(vv, tRow);
      const a = uu * Math.PI * 2;
      const bump = out3 * Math.cos((u - 0.5) * Math.PI);
      o2.set(tRow[2] + Math.cos(a) * (tRow[0] + bump), tRow[4], tRow[3] + Math.sin(a) * (tRow[1] + bump));
    }, { nu: 8, nv: 16, flip: false }), mat, parent);
    // outside seam (skier's outboard side) and the inseam
    legSeam(s > 0 ? 0.0 : 0.5, 0.022, 0.06, 0.99, 0.0028, mats.pantPanel, L.hip, thighRing);
    legSeam(s > 0 ? 0.5 : 0.0, 0.016, 0.14, 0.99, 0.0022, mats.pantPanel, L.hip, thighRing);
    // thigh cargo pocket with a zip, on the outboard thigh
    legSeam(s > 0 ? 0.02 : 0.48, 0.075, 0.30, 0.34, 0.0040, mats.pantPanel, L.hip, thighRing);
    legSeam(s > 0 ? 0.02 : 0.48, 0.070, 0.315, 0.325, 0.0070, mats.webbing, L.hip, thighRing);
    // hip yoke seam, running round the top of the thigh
    mesh(garment([
      [0.00, 0.1145, 0.1185, 0, 0.002, -0.030],
      [0.50, 0.1175, 0.1215, 0, 0.002, -0.020],
      [1.00, 0.1145, 0.1185, 0, 0.002, -0.010],
    ], { nu: 22, nv: 5 }), mats.pantPanel, L.hip);

    L.knee = node(L.hip, 0, -D.thigh, 0);
    // knee joint carrier, driven at half the knee angle: articulation, not a hinge
    L.kneeMid = node(L.hip, 0, -D.thigh, 0);
    mesh(garment([
      [0.00, 0.0870, 0.0905, 0, 0, 0.062],
      [0.34, 0.0905, 0.0945, 0, 0.004, 0.014],
      [0.68, 0.0895, 0.0935, 0, 0.005, -0.038],
      [1.00, 0.0830, 0.0865, 0, 0.002, -0.082],
    ], {
      nu: 22, nv: 16,
      // articulated knee: a proud kneecap patch in front, gathers behind
      fold: (u, v) => {
        const a = u * Math.PI * 2;
        const front = clamp(Math.sin(a), 0, 1), back = clamp(-Math.sin(a), 0, 1);
        return 0.0060 * Math.pow(front, 1.6) * Math.exp(-Math.pow((v - 0.5) / 0.30, 2))
          + 0.0040 * back * Math.sin(v * 22)
          + 0.0018 * Math.sin(a * 7);
      },
    }), mats.pantPanel, L.kneeMid);

    // shin + gaiter — the pant drops over the boot cuff and cinches under it
    mesh(garment([
      [0.00, 0.0855, 0.0890, 0, 0, 0.034],
      [0.20, 0.0870, 0.0905, 0, -0.003, -0.042],
      [0.46, 0.0820, 0.0855, 0, -0.002, -0.134],
      [0.74, 0.0745, 0.0780, 0, 0, -0.226],
      [0.90, 0.0800, 0.0830, 0, 0.001, -0.268],
      [1.00, 0.0775, 0.0805, 0, 0.001, -0.298],
    ], { nu: 22, nv: 26, fold: legFold }), mats.pant, L.knee);
    L.gaiter = mesh(garment([
      [0.00, 0.0800, 0.0835, 0, 0.001, -0.240],
      [0.40, 0.0835, 0.0870, 0, 0.001, -0.266],
      [0.75, 0.0825, 0.0860, 0, 0.001, -0.292],
      [1.00, 0.0760, 0.0790, 0, 0.001, -0.308],
    ], {
      nu: 22, nv: 12,
      fold: (u, v) => 0.0035 * Math.sin(u * Math.PI * 2 * 7)
        + 0.0055 * Math.sin(v * 11.5) * (1 - v * 0.4)
        + 0.0030 * (fbm(u * 5, v * 4, 5, 83 + s, 3) - 0.5) * 2,
    }), mats.pantPanel, L.knee);
    // instep cable + hem hook under the boot
    mesh(garment([
      [0.00, 0.0790, 0.0825, 0, 0.001, -0.284],
      [0.50, 0.0815, 0.0850, 0, 0.001, -0.277],
      [1.00, 0.0790, 0.0825, 0, 0.001, -0.270],
    ], { nu: 20, nv: 5 }), mats.webbing, L.knee);
  }

  // -------------------------------------------------------------------------
  // Bake. All the buckles, rivets, vents, welts and zip hardware are separate
  // meshes because that is the only sane way to author them — but 250 draw
  // calls for one character, doubled by the shadow pass, is not free. Every
  // group of leaf meshes that shares a parent bone AND a material collapses
  // into one geometry here. Nothing that animates independently is touched.
  // -------------------------------------------------------------------------
  for (const o of [torso, lens, ...legs.map((L) => L.ski), ...legs.map((L) => L.gaiter),
    ...arms.map((a) => a.glove)]) {
    if (o) o.userData.noMerge = true;
  }
  // The bones: every node whose transform the animation writes. Everything
  // between two bones is rigid, so it can be flattened into the bone above it
  // no matter how deep it was authored.
  const BONES = new Set([group, skiRoot, bodyRoot, pelvis, spine, chest, neck, head]);
  for (const L of legs) for (const b of [L.pivot, L.body, L.ankle, L.boot.root, L.boot.cuff, L.hip, L.knee, L.kneeMid]) BONES.add(b);
  for (const a of arms) for (const b of [a.shoulder, a.elbow, a.elbowMid, a.wrist, a.poleGrip]) BONES.add(b);

  const _bm = new THREE.Matrix4();
  const bakeBone = (bone) => {
    bone.updateMatrixWorld(true);
    _bm.copy(bone.matrixWorld).invert();
    // everything under this bone that a deeper bone does not own
    const region = [], stack = bone.children.slice();
    while (stack.length) {
      const o = stack.pop();
      if (BONES.has(o)) continue;
      region.push(o);
      for (const c of o.children) stack.push(c);
    }
    const byMat = new Map(), keep = [];
    for (const o of region) {
      const g = o.geometry;
      const ok = o.isMesh && !o.userData.noMerge && !Array.isArray(o.material)
        && !g.morphAttributes.position
        && g.attributes.position && g.attributes.normal && g.attributes.uv;
      if (ok) { let a = byMat.get(o.material); if (!a) byMat.set(o.material, a = []); a.push(o); }
      else keep.push(o);
    }
    const merged = [];
    for (const [mat, list] of byMat) {
      const parts = [];
      for (const c of list) {
        const g = c.geometry.index ? c.geometry.toNonIndexed() : c.geometry.clone();
        for (const k of Object.keys(g.attributes)) {
          if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
        }
        g.applyMatrix4(_bm.clone().multiply(c.matrixWorld));
        parts.push(g);
      }
      const geo = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
      if (parts.length > 1) for (const g of parts) g.dispose();
      if (geo) merged.push([geo, mat, list]);
    }
    if (!merged.length) return;
    // anything that survives (animated scale, morph targets, the lens) keeps
    // its world transform and simply moves up to the bone
    for (const o of keep) if (o.parent !== bone) bone.attach(o);
    for (const [, , list] of merged) for (const c of list) { c.removeFromParent(); c.geometry.dispose(); }
    for (const [geo, mat] of merged) {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true; m.receiveShadow = false;
      bone.add(m);
    }
  };
  for (const b of BONES) bakeBone(b);

  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = true; } });
  scene.add(group);

  // -------------------------------------------------------------------------
  // animation state
  // -------------------------------------------------------------------------
  const A = {
    t: 0, edge: 0, gF: 0, crouch: 0, air: 0, spd: 0, incl: 0,
    absorb: 0, absorbV: 0, prevVn: 0, prevAir: false, airT: 0,
    plantSide: 0, plantT: 99, prevEdgeSign: 0, phi: 0, airSpin: 0,
    pop: 0, retract: 0, reach: 0, airPhase: 'ground',
    // legLine: the frontal-plane angle of the solved ankle->hip line. It is what
    // the eye reads as "how far over is he", and it is what the edge angle is
    // built from, so the two can never drift apart.
    legLine: 0, edgeAng: 0,
    envAssigned: env,
    dbg: { tilt: 0, angul: 0, hipTilt: 0, extT: 0, R: 0, load: 0, stance: 0, edgeMag: 0, legLine: 0 },
  };

  // scratch
  const _hip = new THREE.Vector3(), _tgt = new THREE.Vector3(), _d = new THREE.Vector3();
  const _u = new THREE.Vector3(), _n = new THREE.Vector3(), _p = new THREE.Vector3();
  const _knee = new THREE.Vector3(), _sd = new THREE.Vector3();
  const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qp = new THREE.Quaternion();
  const _thighQ = new THREE.Quaternion(), _shinQ = new THREE.Quaternion();
  const _gX = new THREE.Vector3(1, 0, 0), _gY = new THREE.Vector3(0, 1, 0), _gZ = new THREE.Vector3(0, 0, 1);
  const _hipL = new THREE.Vector3(), _ankL = new THREE.Vector3(), _pel = new THREE.Vector3();
  const _eul = new THREE.Euler();
  const ZAX = new THREE.Vector3(0, 0, 1);

  /** world-space basis from a bone direction (bone points down its local -Y). */
  function boneQuat(dir, front, out) {
    _y.copy(dir).multiplyScalar(-1).normalize();
    _z.copy(front).addScaledVector(_y, -front.dot(_y));
    if (_z.lengthSq() < 1e-8) _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
    _z.normalize();
    _x.crossVectors(_y, _z).normalize();
    _m.makeBasis(_x, _y, _z);
    return out.setFromRotationMatrix(_m);
  }

  function solveLeg(L, poleDir) {
    L.hip.getWorldPosition(_hip);
    L.ankle.getWorldPosition(_tgt);
    _d.subVectors(_tgt, _hip);
    const L1 = D.thigh, L2 = D.shin;
    let dist = _d.length();
    if (dist < 1e-4) return;
    const maxR = (L1 + L2) * 0.995;
    dist = clamp(dist, Math.abs(L1 - L2) + 0.02, maxR);
    _u.copy(_d).normalize();
    const ca = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
    const a = Math.acos(ca);
    _n.copy(poleDir).addScaledVector(_u, -poleDir.dot(_u));
    if (_n.lengthSq() < 1e-8) _n.set(0, 0, 1).addScaledVector(_u, -_u.z);
    _n.normalize();
    _p.copy(_u).multiplyScalar(Math.cos(a)).addScaledVector(_n, Math.sin(a));
    _knee.copy(_hip).addScaledVector(_p, L1);
    _sd.subVectors(_tgt, _knee).normalize();
    boneQuat(_p, _n, _thighQ);
    boneQuat(_sd, _n, _shinQ);
    // world -> local
    L.hip.parent.getWorldQuaternion(_qp);
    L.hip.quaternion.copy(_qp.invert()).multiply(_thighQ);
    L.knee.quaternion.copy(_thighQ).invert().multiply(_shinQ);
    L.hip.updateMatrix();
    L.knee.updateMatrix();
    return _shinQ;
  }

  const _shinWorld = [new THREE.Quaternion(), new THREE.Quaternion()];
  const _poleDirW = new THREE.Vector3();
  const _poleQ = new THREE.Quaternion();

  // -------------------------------------------------------------------------
  // measurement probe — the rig grades itself so "the boots are not in the
  // snow" is a number, not an opinion. Used by tools/skier-rig.mjs.
  // -------------------------------------------------------------------------
  function measure() {
    const s = A.lastState;
    if (!s || !s.pos) return null;
    group.updateMatrixWorld(true);
    const P = s.pos, N = s.groundNormal || new THREE.Vector3(0, 1, 0);
    const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
    const v = new THREE.Vector3();
    const hgt = (o, lx = 0, ly = 0, lz = 0) => {
      v.set(lx, ly, lz); o.localToWorld(v);
      return v.clone().sub(P).dot(N);
    };
    const wp = (o, lx = 0, ly = 0, lz = 0) => { const q = new THREE.Vector3(lx, ly, lz); o.localToWorld(q); return q; };

    const F = new THREE.Vector3(-Math.sin(s.heading || 0), 0, -Math.cos(s.heading || 0));
    F.addScaledVector(N, -F.dot(N)).normalize();
    const R = new THREE.Vector3().crossVectors(F, N).normalize();   // skier's RIGHT
    const sgn = A.sgn || 0;

    const out = { skis: [], legs: [], poles: [] };
    for (const L of legs) {
      const g = L.ski.geometry.userData;
      let lo = 1e9, hi = -1e9, loNow = 1e9;
      for (const p of g.baseSamples) lo = Math.min(lo, hgt(L.ski, p[0], p[1], p[2]));
      for (const p of g.baseSamples) hi = Math.max(hi, hgt(L.ski, p[0], p[1], p[2]));
      // the same, but on the shape the ski is ACTUALLY bent into this frame —
      // the reverse camber is what puts the waist down in the trench, and a
      // grounding number that ignores it is measuring a ski nobody is skiing
      const inf = clamp((L.ski.morphTargetInfluences || [0])[0] || 0, 0, 1);
      const flexS = g.baseSamplesFlex || g.baseSamples;
      for (let i = 0; i < g.baseSamples.length; i++) {
        const a = g.baseSamples[i], b = flexS[i];
        loNow = Math.min(loNow, hgt(L.ski, a[0] + (b[0] - a[0]) * inf,
          a[1] + (b[1] - a[1]) * inf, a[2] + (b[2] - a[2]) * inf));
      }
      const tip = wp(L.ski, 0, 0, g.length * 0.5), tail = wp(L.ski, 0, 0, -g.length * 0.5);
      out.skis.push({
        side: L.side, inside: L.side * sgn > 0,
        baseMin: +lo.toFixed(4), baseMax: +hi.toFixed(4),
        baseMinFlexed: +loNow.toFixed(4), camber: +inf.toFixed(2),
        tipY: +(tip.clone().sub(P).dot(N)).toFixed(3),
        tailY: +(tail.clone().sub(P).dot(N)).toFixed(3),
        tipsForward: +tip.clone().sub(tail).normalize().dot(F).toFixed(3),
      });
      const hip = wp(L.hip), ank = wp(L.ankle);
      out.legs.push({
        side: L.side, inside: L.side * sgn > 0,
        ext: +(hip.distanceTo(ank) / (D.thigh + D.shin)).toFixed(3),
        hipY: +(hip.clone().sub(P).dot(N)).toFixed(3),
      });
    }
    for (const a of arms) {
      const tipY = hgt(a.pole, 0, a.pole.userData.tipY, 0);
      out.poles.push({
        side: a.side, inside: a.side * sgn > 0,
        tipY: +tipY.toFixed(3), gripY: +hgt(a.poleGrip).toFixed(3),
      });
    }

    // frontal-plane angles, measured about the forward axis
    const ang = (a, b) => {
      const d = b.clone().sub(a);
      return Math.atan2(d.dot(R), d.dot(N));   // + = leaning to the skier's RIGHT
    };
    const hipMid = wp(legs[0].hip).add(wp(legs[1].hip)).multiplyScalar(0.5);
    const ankMid = wp(legs[0].ankle).add(wp(legs[1].ankle)).multiplyScalar(0.5);
    const shO = arms.find((a) => a.side * sgn <= 0) || arms[0];
    const shI = arms.find((a) => a.side * sgn > 0) || arms[1];
    const shOut = wp(shO.shoulder), shIn = wp(shI.shoulder);
    const shMid = shOut.clone().add(shIn).multiplyScalar(0.5);
    // sgn > 0 = turning left = leaning to the skier's LEFT = negative R
    const dir = sgn >= 0 ? -1 : 1;
    const incl = ang(ankMid, hipMid) * dir;
    const body = ang(hipMid, shMid) * dir;
    const shAxis = shIn.clone().sub(shOut).normalize();
    out.pose = {
      inclDeg: deg(incl), bodyDeg: deg(body), angulationDeg: deg(incl - body),
      // the two numbers the carve lives or dies on: they must track ~1:1
      edgeDeg: deg(A.edgeAng), legLineDeg: deg(A.legLine),
      edgeOverIncl: +(A.edgeAng / Math.max(Math.abs(incl), 1e-3)).toFixed(2),
      // + = outside shoulder LOW (what we want), - = banked into the turn
      shoulderTiltDeg: deg(Math.asin(clamp(shAxis.dot(N), -1, 1))),
      headTopY: +hgt(head, 0, 0.135, 0).toFixed(3),
      hipY: +hipMid.clone().sub(P).dot(N).toFixed(3),
      shoulderY: +shMid.clone().sub(P).dot(N).toFixed(3),
      // + = shoulders ahead of the hips (forward), - = backseat
      shoulderLead: +shMid.clone().sub(hipMid).dot(F).toFixed(3),
      hipOverBoot: +hipMid.clone().sub(ankMid).dot(F).toFixed(3),
      edge: +(s.edge || 0).toFixed(3), crouch: +(s.crouch || 0).toFixed(3),
      gForce: +(s.gForce || 0).toFixed(2), speed: +(s.speed || 0).toFixed(1),
      airborne: !!s.airborne, vy: +(s.vel ? s.vel.y : 0).toFixed(2),
      airPhase: A.airPhase || 'ground', absorb: +A.absorb.toFixed(3),
    };
    out.dbg = {};
    for (const k in (A.dbg || {})) out.dbg[k] = +A.dbg[k].toFixed(3);
    out.dbg.pop = +A.pop.toFixed(2); out.dbg.retract = +A.retract.toFixed(2); out.dbg.reach = +A.reach.toFixed(2);
    return out;
  }
  if (typeof window !== 'undefined') window.__skier = { group, measure, A, legs, arms };

  return {
    group,
    materials: mats,

    update(dt, state) {
      dt = clamp(dt || 0, 0, 0.05);
      A.t += dt;
      const s = state || {};
      A.lastState = s;

      // optional pose override used by tools/skier-lab — never set in game
      const ov = (typeof window !== 'undefined' && window.__skierPose) || null;
      // never let a bad number from another subsystem NaN the whole rig away
      const get = (k, d) => {
        const v = ov && ov[k] !== undefined ? ov[k] : s[k];
        if (typeof v === 'boolean') return v;
        return Number.isFinite(v) ? v : d;
      };

      // ---- ground-aligned transform -----------------------------------------
      // The whole rig hangs off a basis built from the published contact point
      // and surface normal: +Y = snow normal, +Z = direction of travel, y = 0 is
      // the snow surface. Grounding then costs nothing — the ski bases are simply
      // placed at y = 0 and can never punch through a slope they are parallel to.
      if (s.pos && Number.isFinite(s.pos.x + s.pos.y + s.pos.z)) group.position.copy(s.pos);
      const gn = _gY;
      const sn = s.groundNormal;
      if (sn && Number.isFinite(sn.x + sn.y + sn.z) && sn.y > 0.1) gn.copy(sn).normalize();
      else gn.set(0, 1, 0);
      const hd = get('heading', 0);
      _gZ.set(-Math.sin(hd), 0, -Math.cos(hd));           // physics forward
      _gZ.addScaledVector(gn, -_gZ.dot(gn));
      if (_gZ.lengthSq() < 1e-8) _gZ.set(-Math.sin(hd), 0, -Math.cos(hd));
      _gZ.normalize();
      _gX.crossVectors(gn, _gZ).normalize();               // skier's LEFT
      _m.makeBasis(_gX, gn, _gZ);
      group.quaternion.setFromRotationMatrix(_m);

      // ---- smoothed drivers -------------------------------------------------
      const rawEdge = clamp(get('edge', 0), -1, 1);
      A.edge = damp(A.edge, rawEdge, 13, dt);
      A.gF = damp(A.gF, clamp(get('gForce', 0), 0, 3), 9, dt);
      A.crouch = damp(A.crouch, clamp(get('crouch', 0), 0, 1), 8, dt);
      const airborne = !!get('airborne', false);
      A.air = damp(A.air, airborne ? 1 : 0, airborne ? 9 : 13, dt);
      A.spd = damp(A.spd, Math.max(0, get('speed', 0)), 3, dt);

      const e = A.edge;
      const sgn = e >= 0 ? 1 : -1;   // which way the player is steering
      const ae = Math.abs(e);
      const gN = Math.min(A.gF, 2.0) / 2.0;
      const load = clamp(ae * (0.42 + 0.58 * gN), 0, 1);          // carve intensity
      const spdN = clamp(A.spd / 26, 0, 1);

      // ---- inclination -------------------------------------------------------
      // The balance angle is a physics quantity — the lean along the resultant of
      // gravity and the turn force — so take it from physics rather than inventing
      // a second one on top of it, which is what used to double the lean and bank
      // the whole skier. It already carries the cross-slope term too: on a traverse
      // the edge has to hold gravity, and that is exactly what stands the body up
      // off the slope normal.
      const mo = s.motion || {};
      const inclRaw = Number.isFinite(mo.inclination) ? mo.inclination : get('roll', 0) / 0.6;
      A.incl = damp(A.incl, clamp(inclRaw, -1.0, 1.0), 11, dt);
      // you cannot lay a ski over at walking pace: no speed, no lean
      const tilt = clamp(A.incl * 0.92 * (1 - 0.80 * A.air)
        * THREE.MathUtils.smoothstep(A.spd, 1.5, 7.0), -0.72, 0.72);
      const es = tilt >= 0 ? 1 : -1;          // which edge is the downhill one
      const atilt = Math.abs(tilt);
      A.phi = tilt;
      A.sgn = es;
      // Angulation: the hips go further inside and the body flexes the other way at
      // the hip joint and the spine, so the chest ends up back outside the CoM line
      // and the shoulder line comes level. Grows with the lean, and again with load
      // — the harder the turn, the sharper the break at the hip.
      const angul = clamp(1.35 * (atilt - 0.08), 0, 0.95) * (0.55 + 0.45 * load) * (1 - A.air);

      // ---- air phases + landing spring ---------------------------------------
      // vn = closing speed with the snow, the only honest driver for takeoff /
      // apex / descent — a jump is not a state, it is a sequence.
      const vn = s.vel && Number.isFinite(s.vel.y) ? s.vel.dot(gn) : 0;
      if (dt > 0 && !airborne) {
        const acc = (vn - A.prevVn) / dt;
        A.absorbV += clamp(acc, -70, 70) * 0.0016;
      }
      if (A.prevAir && !airborne) {
        // hard landing absorb: ~0.32 m of hip travel for a 10 m/s touchdown
        const impact = clamp(-A.prevVn, 0, 16);
        A.absorbV -= clamp(0.6 + impact * 0.55, 0.6, 6.4);
      }
      A.prevVn = vn;
      A.airT = airborne ? A.airT + dt : 0;
      A.prevAir = airborne;
      // omega 10.5 rad/s => bottoms out in ~0.15 s; zeta 0.36 => a real rebound
      A.absorbV += (-110 * A.absorb - 7.6 * A.absorbV) * dt;
      A.absorb = clamp(A.absorb + A.absorbV * dt, -0.40, 0.10);

      // takeoff pop -> apex retraction -> descent reach
      const popT = airborne ? clamp(1 - A.airT / 0.24, 0, 1) * clamp(vn / 2.0, 0, 1) : 0;
      const descend = clamp(-vn / 4.5, 0, 1);
      const retT = A.air * clamp((A.airT - 0.10) / 0.18, 0, 1) * (1 - descend);
      const reachT = A.air * descend * clamp(A.airT / 0.25, 0, 1);
      A.pop = damp(A.pop, popT, 16, dt);
      A.retract = damp(A.retract, retT, 11, dt);
      A.reach = damp(A.reach, reachT, 13, dt);
      A.airPhase = !airborne ? (A.absorb < -0.05 ? 'absorb' : 'ground')
        : A.pop > 0.4 ? 'pop' : A.reach > A.retract ? 'reach' : 'retract';

      // ---- pole plant timing -------------------------------------------------
      const eSign = ae > 0.14 ? sgn : 0;
      if (eSign !== 0 && eSign !== A.prevEdgeSign && A.spd > 3.5 && !airborne) {
        A.plantSide = eSign; A.plantT = 0;
      }
      if (eSign !== 0) A.prevEdgeSign = eSign;
      A.plantT += dt;
      const plant = A.plantT < 0.55 ? Math.sin(clamp(A.plantT / 0.55, 0, 1) * Math.PI) : 0;
      const plantSharp = A.plantT < 0.55
        ? Math.pow(Math.sin(clamp(A.plantT / 0.55, 0, 1) * Math.PI), 0.6) : 0;

      // ---- micro motion -------------------------------------------------------
      // Nothing alive is ever still. Three uncorrelated periods (breath, a slow
      // balance wander, a fast terrain chatter) beat against each other so no
      // two frames of a still capture ever look like the same frozen pose.
      const breath = Math.sin(A.t * 1.75) * 0.5 + 0.5;
      const sway = Math.sin(A.t * 0.63) + 0.4 * Math.sin(A.t * 1.31 + 1.1);
      const sway2 = Math.sin(A.t * 0.47 + 2.2) + 0.5 * Math.sin(A.t * 0.91 + 0.3);
      const jitter = (Math.sin(A.t * 7.3) + Math.sin(A.t * 11.7 + 2.1)) * 0.5;
      const chatter = clamp(A.spd / 24, 0, 1) * (1 - A.air) * 0.006;
      // Handedness. A real skier is never bilaterally symmetric: one hand rides
      // further forward, the same shoulder stays a little open, and the lead
      // never swaps unless the turn asks it to.
      const HAND = 1;                       // this skier is right-hand-lead
      const lean = clamp(A.spd / 14, 0, 1);

      // in the air the whole body drifts a little off-axis and the tips come up
      A.airSpin = damp(A.airSpin, airborne ? e * 0.20 : 0, 3.2, dt);
      // tips up off the lip, level at the apex, nosed down into the landing
      const airPitch = A.air * (-0.13 + 0.34 * A.reach - 0.05 * A.retract);
      skiRoot.rotation.set(airPitch, A.airSpin, 0);
      bodyRoot.rotation.set(
        airPitch * 0.5 + clamp(get('pitch', 0) - Math.asin(clamp(_gZ.y, -1, 1)), -0.14, 0.14) * -0.7,
        A.airSpin, 0);

      // =======================================================================
      // SKIS — the running surface IS the snow plane; edge angle rolls the ski
      // about its downhill edge so the contact line never leaves y = 0.
      // =======================================================================
      // A ski's edge angle is not a free parameter and it is not the steering
      // input: the boot is a rigid lever, so the base tilts with the LEG LINE the
      // rig actually solved, plus whatever the ankle and knee add inside the cuff.
      // Both terms fall out of the same inclination/angulation solution that leans
      // the body, so the edge can never disagree with the lean — 45 deg of body
      // over the snow is 45-plus degrees of ski on the snow, which is the whole
      // reason a carve holds. A.legLine is last frame's solved ankle->hip angle in
      // the frontal plane; one frame of lag, and the loop reads as a low-pass.
      // The old code took max(|state.edge|, tilt), an independent quantity that
      // ran 4x the lean through a transition and under it at the apex.
      const ankleAngul = (0.11 + 0.15 * load) * angul;   // the break inside the boot
      const edgeT = (Math.abs(A.legLine) + ankleAngul)
        * (1 - 0.55 * A.air)
        * THREE.MathUtils.smoothstep(A.spd, 1.5, 7.0);
      A.edgeAng = damp(A.edgeAng, clamp(edgeT, 0, 1.20), 18, dt);
      const edgeMag = A.edgeAng;
      const edgeAngle = edgeMag * es;
      // the stance opens as the body lays over — otherwise the inside leg has to
      // fold into itself to reach a ski that is directly under the hip
      const halfStance = 0.140 + 0.050 * load + 0.028 * A.crouch + 0.135 * atilt;
      const contactX = 0.033;   // half the ski waist width
      // The bases ride a hair proud of the snow: 24 mm of it is the gap between
      // the analytic contact height physics publishes and the height the terrain
      // actually triangulates to under the skier — measured, not guessed — and the
      // rest is margin for surface noise between LOD steps. It used to carry a
      // second, much larger allowance for the ski's own shape (the shovel is 2.5 cm
      // wider than the waist the roll pivots on, so at a big edge angle its
      // outboard corner dips below the pivot). That allowance is now solved
      // exactly, per frame, from the base geometry — see `lowest` below — so the
      // ski can sit close to the snow at *any* edge angle instead of levitating.
      // ...and a loaded ski does not glide over the snow, it cuts into it, so the
      // clearance shrinks with the carve. Together with the reverse camber below
      // (which bends the waist ~1.5 cm past the running line) the outside ski's
      // midsection ends up on the surface at full load while its tip and tail ride
      // clear: a ski sitting in its own trench.
      const CLEAR = 0.056 - 0.010 * load;
      const skiLift = 0.30 * A.retract - 0.02 * A.pop;
      const eS = Math.sin(edgeAngle), eC = Math.cos(edgeAngle);
      for (const L of legs) {
        const side = L.side;
        const inside = side * es;                     // +1 if this is the inside ski
        const lead = inside * (0.055 + 0.05 * load + 0.10 * atilt);  // inside ski leads
        // Lowest running point of THIS ski once rolled onto edge, in pivot space.
        // Solving it from the published base samples is what lets the cutting edge
        // sit at a fixed height above the snow whatever the roll angle is.
        let lowest = Infinity;
        for (const p of L.ski.geometry.userData.baseSamples) {
          const px = p[0] - es * contactX, py = p[1] - L.contactY;
          const h = py * eC - px * eS;
          if (h < lowest) lowest = h;
        }
        L.pivot.position.set(side * halfStance + es * contactX,
          CLEAR - lowest + skiLift - chatter * jitter, lead);
        L.pivot.rotation.set(0, side * 0.008, -edgeAngle);
        // the pivot sits exactly on the edge that is cutting, so rolling onto edge
        // pivots about the snow contact instead of swinging the base through it
        L.body.position.set(-es * contactX, -L.contactY, 0);
        // reverse camber when loaded
        if (L.ski.morphTargetInfluences) {
          L.ski.morphTargetInfluences[0] = damp(L.ski.morphTargetInfluences[0] || 0,
            clamp(load * (inside > 0 ? 0.55 : 1.0) * (1 - A.air), 0, 1), 8, dt);
        }
        // ankle position in skiRoot space — the pelvis solve needs it analytically
        L.ankleLocal.set(0, 0.0175 + 0.006 + D.ankleY - L.contactY, -0.012)
          .add(L.body.position).applyAxisAngle(ZAX, -edgeAngle).add(L.pivot.position);
      }

      // =======================================================================
      // PELVIS — stand up. A ski stance is 25-35 deg of knee flex, not a wall-sit:
      // the hip rides ~0.94 m off the snow and only drops when something asks it to.
      // =======================================================================
      // The pose is authored as an EXTENSION, not a height: "the outside leg is
      // 92% straight" is the thing a skier actually controls, and it stays true
      // whatever the lean or the ski lift does to the geometry underneath.
      const crouchEff = A.crouch * (1 - 0.85 * A.pop);
      const extT = clamp(
        0.925
        - 0.340 * crouchEff
        + 1.050 * A.absorb
        - 0.260 * A.retract
        + 0.070 * A.pop
        + 0.060 * A.reach
        - 0.030 * spdN
        + 0.035 * load          // a loaded outside leg pushes long against the arc
        + breath * 0.005,
        0.34, 0.955);
      const hipDrop = clamp((0.925 - extT) / 0.40, -0.25, 1.2);

      const outSide = -es;
      const pivotX = (outSide * halfStance + es * contactX) * clamp(atilt / 0.40, 0, 1);
      const hipTilt = clamp(tilt + es * angul * 0.25, -0.95, 0.95);
      const pelZ = -0.02 - 0.10 * crouchEff - 0.05 * hipDrop + 0.03 * A.retract;
      // the hips stay on the flight path while the SKIS come up: that is what
      // retraction is. Adding skiLift here would just levitate the whole skier.
      const baseY = CLEAR;
      // The femur abducts at the hip joint, so the pelvis does NOT roll all the way
      // over with the leg line; the rest of the counter comes from the spine. That
      // split is the whole difference between angulating and banking.
      const pelvisRoll = hipTilt - es * angul * 0.55;

      // Solve the leg-line length so the OUTSIDE leg lands exactly on `extT`.
      // Newton on a monotone distance — 4 iterations is convergence to under a mm,
      // and it is what keeps a laid-over carve standing on a long outside leg
      // instead of collapsing into a squat.
      const sx = Math.sin(hipTilt), sy = Math.cos(hipTilt);
      const outLeg = legs[0].side === outSide ? legs[0] : legs[1];
      _hipL.set(outSide * D.hipHalf, -0.045, 0).applyAxisAngle(ZAX, -pelvisRoll);
      const ax = outLeg.ankleLocal.x, ay = outLeg.ankleLocal.y - skiLift, az = outLeg.ankleLocal.z;
      const target = extT * (D.thigh + D.shin);
      let R = 0.90;
      for (let it = 0; it < 4; it++) {
        const dx = pivotX + sx * R + _hipL.x - ax;
        const dy = baseY + sy * R + _hipL.y - ay;
        const dz = pelZ + _hipL.z - az;
        const d = Math.hypot(dx, dy, dz);
        const grad = (dx * sx + dy * sy) / Math.max(d, 1e-4);
        if (Math.abs(d - target) < 0.001) break;
        R = clamp(R + (target - d) / (Math.abs(grad) < 0.15 ? 0.15 : grad), 0.20, 1.10);
      }
      _pel.set(pivotX + sx * R + sway * 0.006, baseY + sy * R, pelZ);
      pelvis.position.copy(_pel);

      // The leg line this solve just produced, measured in the frontal plane from
      // the mean ankle to the mean hip joint — the angle a viewer reads as "how
      // far is he over". The ski roll above is built from it, so edge angle and
      // body inclination are two readings of one number instead of two guesses.
      const hipMx = _pel.x - 0.045 * Math.sin(pelvisRoll);
      const hipMy = _pel.y - 0.045 * Math.cos(pelvisRoll);
      const ankMx = (legs[0].ankleLocal.x + legs[1].ankleLocal.x) * 0.5;
      const ankMy = (legs[0].ankleLocal.y + legs[1].ankleLocal.y) * 0.5 - skiLift;
      A.legLine = Math.atan2(hipMx - ankMx, Math.max(hipMy - ankMy, 0.05));

      const dbg = A.dbg;   // preallocated: this runs every frame
      dbg.tilt = tilt; dbg.angul = angul; dbg.hipTilt = hipTilt; dbg.extT = extT;
      dbg.R = R; dbg.load = load; dbg.stance = halfStance; dbg.edgeMag = edgeMag;
      dbg.legLine = A.legLine;

      // Backseat killer: the shoulders come forward as the hips drop, so the mass
      // stays over the balls of the feet instead of trailing behind the boots.
      const torsoPitch = 0.15 + 0.62 * crouchEff + 0.95 * hipDrop + 0.10 * spdN
        + 0.10 * load - 0.30 * A.retract + 0.10 * A.reach;
      pelvis.rotation.set(
        torsoPitch * 0.26,
        sgn * 0.16 * load,
        -pelvisRoll + sway * 0.006);

      const spineRoll = es * angul * 0.35;
      const spineYaw = -sgn * 0.11 * load;
      spine.rotation.set(torsoPitch * 0.36, spineYaw, spineRoll);
      // a permanent few degrees of open shoulder toward the lead hand, plus a
      // slow wander: shoulders square to the fall line but never geometrically so
      const chestYaw = -sgn * (0.22 * load + 0.06 * gN)
        - HAND * 0.055 * lean * (1 - A.crouch * 0.5) + sway2 * 0.012;
      // A pitched-forward torso that is also counter-rotated tips its own shoulder
      // line — sin(pitch)*sin(yaw) of unwanted roll, straight back into the bank we
      // just removed. Cancel it explicitly.
      const chestFlex = es * angul * 0.30
        - Math.sin(torsoPitch) * Math.sin(sgn * 0.16 * load + spineYaw + chestYaw);
      chest.rotation.set(
        torsoPitch * 0.38 + breath * 0.012,
        chestYaw,
        chestFlex);
      torso.scale.set(1 + breath * 0.012, 1, 1 + breath * 0.02);

      // head leads into the turn and keeps its eyes on the horizon
      const chestRoll = -pelvisRoll + spineRoll + chestFlex;
      const headYaw = sgn * (0.34 * load + 0.16 * ae)
        + Math.sin(A.t * 0.41) * 0.045 + Math.sin(A.t * 0.83 + 1.7) * 0.020
        - chestYaw * 0.45;                 // eyes stay down the fall line
      head.rotation.set(
        -torsoPitch * 0.80 + 0.16 + Math.sin(A.t * 0.9) * 0.020 + Math.sin(A.t * 2.3) * 0.006,
        headYaw,
        -chestRoll * 0.75 + Math.sin(A.t * 0.7) * 0.022 + HAND * 0.035);

      // =======================================================================
      // ARMS
      // =======================================================================
      for (const arm of arms) {
        const side = arm.side;
        const inside = side * es;
        const isPlant = A.plantSide === side ? 1 : 0;
        // in a tuck the humerus swings forward until it is roughly square to the
        // (now almost horizontal) spine — that is what makes an egg read as an egg
        const fwd = 0.34 + 1.08 * A.crouch + 0.14 * load * (inside > 0 ? 1 : 0.3)
          + 0.42 * A.reach - 0.10 * A.retract + 0.30 * torsoPitch * (1 - A.crouch);
        // Elbows OUT. Photographic reference: the hands are carried wide of the
        // hips with the humerus abducted ~25 deg even in a straight glide — a
        // skier with their arms tucked to their ribs reads as a shop dummy.
        const out = 0.43 - 0.26 * A.crouch + 0.80 * A.retract + 0.34 * A.reach
          + 0.26 * A.pop + 0.26 * inside * load;
        const bend = 1.02 + 0.16 * A.crouch + 0.12 * inside * load
          - 0.55 * A.reach + 0.50 * A.retract - 0.45 * A.pop;
        // handedness: the lead hand carries higher, further forward and a touch
        // more open; the trailing hand sits lower and closer to the hip
        const hnd = side === HAND ? 1 : -1;
        const asym = (1 - A.crouch * 0.6) * (1 - A.air * 0.5);
        // each arm also breathes on its own slow period, never in lockstep
        const drift = Math.sin(A.t * (0.83 + 0.19 * side) + side * 2.1) * 0.026
          + Math.sin(A.t * 1.9 + side) * 0.010;

        arm.shoulder.rotation.set(
          -(fwd + 0.42 * plantSharp * isPlant + hnd * 0.115 * asym) + drift,
          side * (-0.14 - 0.16 * A.crouch + 0.12 * plantSharp * isPlant) + hnd * 0.06 * asym,
          side * (out + 0.12 * plantSharp * isPlant + hnd * 0.075 * asym) - chestRoll * 0.10);
        arm.elbow.rotation.set(
          -(bend - 0.30 * plantSharp * isPlant - hnd * 0.10 * asym)
          + Math.sin(A.t * (1.21 + 0.17 * side) + side * 2) * 0.028,
          0,
          side * (0.14 + 0.14 * A.crouch));
        arm.wrist.rotation.set(-0.30 + 0.25 * plantSharp * isPlant, side * 0.22, side * -0.18);
        // the sleeve's elbow barrel turns half as far as the joint: the fabric
        // creases across the bend instead of the arm hinging like a doll
        _q.identity().slerp(arm.elbow.quaternion, 0.5);
        arm.elbowMid.quaternion.copy(_q);
      }

      // -----------------------------------------------------------------------
      group.updateMatrixWorld(true);

      // ---- legs: two-bone IK to the boot ------------------------------------
      for (let i = 0; i < legs.length; i++) {
        const L = legs[i];
        const side = L.side;
        // knees drive forward and roll into the hill with the edge angle
        _p.copy(_gZ)
          .addScaledVector(_gX, side * 0.10 + Math.sin(hipTilt) * 0.70)
          .addScaledVector(gn, 0.26 + 0.22 * A.crouch + 0.30 * A.retract)
          .normalize();
        const q = solveLeg(L, _p);
        if (q) _shinWorld[i].copy(q);
        // knee panel splits the joint angle — visible articulation, not a hinge
        _q.identity().slerp(L.knee.quaternion, 0.5);
        L.kneeMid.quaternion.copy(_q);
        L.kneeMid.updateMatrix();
      }

      // ---- boot cuffs follow the shins --------------------------------------
      for (let i = 0; i < legs.length; i++) {
        const L = legs[i];
        L.body.updateMatrixWorld(true);
        L.boot.cuff.parent.getWorldQuaternion(_qp).invert();
        _q.copy(_qp).multiply(_shinWorld[i]);
        // limit to a plausible cuff range
        _eul.setFromQuaternion(_q, 'ZXY');
        _eul.x = clamp(_eul.x, -0.34, 0.30);
        _eul.y = clamp(_eul.y, -0.22, 0.22);
        _eul.z = clamp(_eul.z, -0.30, 0.30);
        L.boot.cuff.quaternion.setFromEuler(_eul);
      }

      // =======================================================================
      // POLES — 1.22 m of pole against a ~0.95 m grip only fits one way: solve
      // the shaft angle from the measured grip height so the tip keeps its
      // clearance, and let it touch the snow only during an actual plant.
      // =======================================================================
      const POLE_L = 1.22;
      for (const arm of arms) {
        const side = arm.side;
        const isPlant = A.plantSide === side ? plant : 0;
        arm.poleGrip.getWorldPosition(_p);
        const gripY = _p.sub(group.position).dot(gn);
        // horizontal aim: trailing back and out, swinging forward for the plant
        _poleDirW.set(0, 0, 0)
          .addScaledVector(_gZ, lerp(-0.96, 0.55, isPlant) - 0.25 * A.crouch)
          .addScaledVector(_gX, side * (0.34 - 0.22 * A.crouch) + Math.sin(tilt) * 0.28
            - side * 0.25 * isPlant)
          .addScaledVector(gn, -0.0);
        _poleDirW.addScaledVector(gn, -_poleDirW.dot(gn));
        if (_poleDirW.lengthSq() < 1e-8) _poleDirW.copy(_gZ).multiplyScalar(-1);
        _poleDirW.normalize();
        // vertical component that puts the tip exactly `clear` above the snow
        const clear = lerp(0.065 + 0.10 * A.air, -0.02, clamp(isPlant * 1.6, 0, 1));
        const kSolve = clamp((clear - gripY) / POLE_L, -1, -0.05);
        // in a tuck the poles are carried flat under the arms — but never below
        // whatever the clearance solve allows
        const k = Math.max(lerp(kSolve, -0.06, A.crouch * 0.95), kSolve);
        _poleDirW.multiplyScalar(Math.sqrt(Math.max(0, 1 - k * k))).addScaledVector(gn, k);
        arm.poleGrip.parent.getWorldQuaternion(_qp).invert();
        boneQuat(_poleDirW, _gZ, _poleQ);
        arm.poleGrip.quaternion.copy(_qp).multiply(_poleQ);
      }

      // ---- environment handover ---------------------------------------------
      const sceneEnv = scene.environment || null;
      if (sceneEnv !== A.envAssigned) {
        A.envAssigned = sceneEnv;
        for (const m of mats._reflective) { m.envMap = sceneEnv || env; m.needsUpdate = true; }
        lens.material.envMap = sceneEnv || env;
      }
    },
  };
}
