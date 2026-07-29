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

/** Tileable technical-fabric normal + roughness maps (weave + wrinkle noise). */
function makeFabricMaps(size = 256) {
  const h = new Float32Array(size * size);
  const P = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * P, v = (y / size) * P;
      // ripstop weave: fine grid + coarse thread bundles
      const weave =
        0.5 + 0.5 * Math.sin(x * Math.PI * 2 * 16 / size * (size / size)) * 0.0;
      const thread =
        Math.sin((x / size) * Math.PI * 2 * 64) * 0.5 +
        Math.sin((y / size) * Math.PI * 2 * 64) * 0.5;
      const rip =
        (Math.abs(((x / size) * 16) % 1 - 0.5) < 0.06 ? 1 : 0) +
        (Math.abs(((y / size) * 16) % 1 - 0.5) < 0.06 ? 1 : 0);
      const wrinkle = fbm(u * 1.4, v * 1.4, P * 1.4, 3, 4);
      h[y * size + x] = wrinkle * 0.7 + thread * 0.06 + rip * 0.09 + weave;
    }
  }
  const nData = new Uint8Array(size * size * 4);
  const rData = new Uint8Array(size * size * 4);
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.6;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 2.6;
      const n = new THREE.Vector3(-dx, -dy, 1).normalize();
      const i = (y * size + x) * 4;
      nData[i] = (n.x * 0.5 + 0.5) * 255;
      nData[i + 1] = (n.y * 0.5 + 0.5) * 255;
      nData[i + 2] = (n.z * 0.5 + 0.5) * 255;
      nData[i + 3] = 255;
      const r = clamp(0.62 + (at(x, y) - 0.5) * 0.55, 0.25, 1) * 255;
      rData[i] = rData[i + 1] = rData[i + 2] = r;
      rData[i + 3] = 255;
    }
  }
  const mk = (data) => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  return { normal: mk(nData), rough: mk(rData) };
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
  const RING = [
    [-1.00, 0.000, 2], // base  ->
    [1.00, 0.000, 1],  // edge (right)
    [1.00, 0.028, 3],  // sidewall
    [1.00, 0.46, 0],   // topsheet
    [0.62, 0.97, 0],
    [0.00, 1.06, 0],
    [-0.62, 0.97, 0],
    [-1.00, 0.46, 3],  // sidewall
    [-1.00, 0.028, 1], // edge (left) -> wraps to base
  ];
  const R = RING.length;

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
        uv.push(t, (s - 3 + (p === a ? 0 : 1)) / 4);
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
  const samples = [];
  let contactY = Infinity;
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const y = baseY(t, false), w = halfWidth(t), z = (t - 0.5) * L;
    samples.push([-w, y, z], [w, y, z]);
    if (t > 0.05 && t < 0.95) contactY = Math.min(contactY, y);
  }
  g.userData.baseSamples = samples;
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
  pant: 0x272c35,
  pantPanel: 0x171b21,
  helmet: 0x14171d,
  lens: 0xbfd6ee,
  skin: 0xc79a76,
  boot: 0x191d24,
  bootCuff: 0x333941,
  bootAccent: 0x555c66,
  metal: 0xb9c2cc,
  glove: 0x15181e,
};

function makeMaterials(env) {
  const fab = makeFabricMaps(256);
  const rep = (t, r) => { const c = t.clone(); c.repeat.set(r, r); c.needsUpdate = true; return c; };

  const fabric = (color, { rough = 0.72, repeat = 3, sheen = 0.35, sheenColor = 0xffffff, metal = 0 } = {}) =>
    new THREE.MeshPhysicalMaterial({
      color, roughness: rough, metalness: metal,
      roughnessMap: rep(fab.rough, repeat),
      normalMap: rep(fab.normal, repeat),
      normalScale: new THREE.Vector2(0.5, 0.5),
      sheen, sheenRoughness: 0.55, sheenColor: new THREE.Color(sheenColor),
      envMapIntensity: 1.0,
    });

  const m = {
    jacket: fabric(C.shell, { rough: 0.56, repeat: 3.2, sheen: 0.5, sheenColor: 0xffd9c4 }),
    jacketDark: fabric(C.shellDark, { rough: 0.62, repeat: 3.2, sheen: 0.4, sheenColor: 0x9fb6d8 }),
    accent: new THREE.MeshPhysicalMaterial({ color: C.accent, roughness: 0.4, metalness: 0.0, sheen: 0.6 }),
    pant: fabric(C.pant, { rough: 0.78, repeat: 4.0, sheen: 0.3, sheenColor: 0xa8bcd8 }),
    pantPanel: fabric(C.pantPanel, { rough: 0.68, repeat: 5.0, sheen: 0.25 }),
    glove: fabric(C.glove, { rough: 0.6, repeat: 6, sheen: 0.2 }),
    skin: new THREE.MeshPhysicalMaterial({ color: C.skin, roughness: 0.62, metalness: 0, sheen: 0.2 }),
    helmet: new THREE.MeshPhysicalMaterial({
      color: C.helmet, roughness: 0.22, metalness: 0.05,
      clearcoat: 1.0, clearcoatRoughness: 0.06, envMapIntensity: 1.1,
    }),
    helmetMatte: new THREE.MeshPhysicalMaterial({ color: 0x0d1014, roughness: 0.85, metalness: 0 }),
    lens: new THREE.MeshPhysicalMaterial({
      color: C.lens, roughness: 0.045, metalness: 1.0,
      clearcoat: 1, clearcoatRoughness: 0.02,
      iridescence: 0.85, iridescenceIOR: 1.6, iridescenceThicknessRange: [180, 520],
      envMapIntensity: 1.6,
    }),
    boot: new THREE.MeshPhysicalMaterial({ color: C.boot, roughness: 0.42, metalness: 0.0, clearcoat: 0.55, clearcoatRoughness: 0.22, envMapIntensity: 0.6 }),
    bootCuff: new THREE.MeshPhysicalMaterial({ color: C.bootCuff, roughness: 0.5, metalness: 0.0, clearcoat: 0.4, clearcoatRoughness: 0.3, envMapIntensity: 0.6 }),
    bootSole: new THREE.MeshStandardMaterial({ color: C.bootAccent, roughness: 0.55, metalness: 0.05, envMapIntensity: 0.5 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x7d858f, roughness: 0.34, metalness: 1.0, envMapIntensity: 0.75, flatShading: true }),
    binding: new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.35, metalness: 0.25, flatShading: true }),
    poleShaft: new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.28, metalness: 0.85, envMapIntensity: 1.1 }),
    poleGrip: new THREE.MeshStandardMaterial({ color: 0x101318, roughness: 0.85, metalness: 0 }),
    basket: new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.6, metalness: 0, flatShading: true }),
    strap: new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.9, metalness: 0 }),
    strapDark: new THREE.MeshStandardMaterial({ color: 0x101318, roughness: 0.8, metalness: 0 }),
    goggleFrame: new THREE.MeshPhysicalMaterial({ color: 0x0e1116, roughness: 0.55, metalness: 0, sheen: 0.3 }),
    skiTop: new THREE.MeshPhysicalMaterial({
      map: makeTopsheetTexture({ base: '#171b22', accent: '#f0501c', line: '#e8eef6' }),
      roughness: 0.38, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.22,
      envMapIntensity: 0.55,
    }),
    skiEdge: new THREE.MeshStandardMaterial({ color: 0xd8dee6, roughness: 0.12, metalness: 1.0, envMapIntensity: 1.3, flatShading: true }),
    skiBase: new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.2, metalness: 0.1, flatShading: true }),
    skiWall: new THREE.MeshStandardMaterial({ color: 0x2b313a, roughness: 0.45, metalness: 0.05, flatShading: true }),
  };

  // materials that must reflect something to read correctly
  m._reflective = [m.lens, m.helmet, m.metal, m.skiEdge, m.poleShaft, m.skiTop, m.boot];
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
  shoulderHalf: 0.185,
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
  // buckles: bail + ladder + lever, both on the outside of the boot
  for (let i = 0; i < 2; i++) {
    const yy = 0.018 + i * 0.062;
    const b = mesh(new THREE.BoxGeometry(0.104, 0.013, 0.022), mats.metal, cuff, 0, yy, 0.030);
    b.rotation.x = -0.08;
    const lever = mesh(new THREE.BoxGeometry(0.016, 0.052, 0.020), mats.bootCuff, cuff, side * 0.052, yy + 0.008, 0.020);
    lever.rotation.z = side * 0.12;
  }
  // power strap
  const strap = mesh(lathe([[0.058, 0.110], [0.0625, 0.121], [0.058, 0.132]], 20, 0.98, 1.22, false), mats.jacket, cuff);
  // lower-shell buckles
  for (let i = 0; i < 2; i++) {
    const yy = y0 + 0.042 + i * 0.038;
    mesh(new THREE.BoxGeometry(0.098, 0.011, 0.020), mats.metal, root, 0, yy, 0.030 - i * 0.014);
    mesh(new THREE.BoxGeometry(0.014, 0.040, 0.016), mats.bootCuff, root, side * 0.048, yy + 0.006, 0.022 - i * 0.014);
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

  // face: cheeks + nose bridge, mostly hidden by goggles + gaiter
  const face = mesh(lathe([
    [0.004, 0.03], [0.045, 0.02], [0.058, -0.01], [0.055, -0.045], [0.038, -0.07], [0.004, -0.08],
  ], 16, 1.05, 0.95), mats.skin, head, 0, 0.0, 0.042);
  const nose = mesh(lathe([[0.006, 0.020], [0.016, -0.004], [0.014, -0.022]], 10, 1.0, 1.5), mats.skin, head, 0, -0.008, 0.074);
  nose.rotation.x = -0.35;

  // neck gaiter pulled up over the chin and mouth
  mesh(lathe([
    [0.052, 0.012], [0.066, -0.020], [0.072, -0.055], [0.074, -0.098],
    [0.068, -0.142], [0.056, -0.170],
  ], 18, 1.0, 1.04), mats.jacketDark, head, 0, 0, 0.006);

  // helmet shell
  const helmetPts = [
    [0.004, 0.132], [0.050, 0.126], [0.086, 0.100], [0.104, 0.056],
    [0.109, 0.010], [0.108, -0.030], [0.101, -0.062],
  ];
  const helm = mesh(lathe(helmetPts, 26, 1.0, 1.08), mats.helmet, head, 0, 0.004, -0.004);
  // ear pads
  for (const s of [1, -1]) {
    const ear = mesh(lathe([[0.004, 0.03], [0.028, 0.024], [0.036, -0.005], [0.030, -0.038], [0.004, -0.05]], 12, 1, 1.35),
      mats.helmetMatte, head, s * 0.095, -0.045, -0.012);
    ear.rotation.z = s * -0.25;
  }
  // brow ridge above the goggles (sits high enough to never cross the lens)
  const brim = mesh(new THREE.TorusGeometry(0.096, 0.010, 6, 20, Math.PI * 0.62), mats.helmet, head, 0, 0.062, 0.014);
  brim.rotation.set(Math.PI * 0.5 - 0.55, 0, -Math.PI * 0.5 + 0.31);
  brim.scale.set(1.06, 1.0, 0.62);
  // accent stripe over the crown, front to back
  const stripe = mesh(new THREE.TorusGeometry(0.108, 0.0075, 5, 26, 1.9), mats.jacket, head, 0, 0.006, -0.006);
  stripe.rotation.set(0, -Math.PI * 0.5, 0.80);
  stripe.scale.set(1, 1, 1);
  // vents
  for (let i = -1; i <= 1; i++) {
    const v = mesh(new THREE.BoxGeometry(0.013, 0.010, 0.042), mats.helmetMatte, head, i * 0.034, 0.119, 0.030 - Math.abs(i) * 0.012);
    v.rotation.x = -0.35;
  }

  // goggle strap — an arc around the back of the helmet only, so it never
  // crosses the lens
  const strap = mesh(new THREE.TorusGeometry(0.109, 0.014, 6, 22, Math.PI * 1.30), mats.strapDark, head, 0, 0.020, -0.006);
  strap.rotation.set(Math.PI * 0.5 - 0.20, 0, Math.PI * 0.5 + Math.PI * 0.35);
  strap.scale.set(1.0, 1.0, 0.46);

  // goggle frame + mirrored lens
  const lensGeo = new THREE.SphereGeometry(0.098, 32, 16, Math.PI * 0.5 - 1.00, 2.00, Math.PI * 0.5 - 0.50, 0.88);
  lensGeo.scale(1.15, 0.94, 0.84);
  const frameGeo = new THREE.SphereGeometry(0.100, 32, 16, Math.PI * 0.5 - 1.08, 2.16, Math.PI * 0.5 - 0.62, 1.14);
  frameGeo.scale(1.16, 0.96, 0.85);
  const frame = mesh(frameGeo, mats.goggleFrame, head, 0, 0.016, 0.012);
  frame.material.side = THREE.DoubleSide;
  const lens = mesh(lensGeo, mats.lens, head, 0, 0.016, 0.016);
  lens.castShadow = false;
  if (env) lens.material.envMap = env;
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
  mesh(lathe([
    [0.075, 0.118], [0.114, 0.085], [0.128, 0.030], [0.130, -0.020],
    [0.121, -0.062], [0.101, -0.092], [0.076, -0.108],
  ], 20, 1.0, 0.90), mats.pant, pelvis);

  const spine = node(pelvis, 0, D.spine, 0);
  mesh(lathe([
    [0.098, 0.00], [0.122, 0.05], [0.136, 0.12], [0.144, 0.175],
  ], 20, 1.0, 0.74), mats.jacket, spine, 0, -0.02, 0);

  const chest = node(spine, 0, D.chest, 0);
  const torso = mesh(lathe([
    [0.124, -0.03], [0.148, 0.03], [0.166, 0.105], [0.175, 0.175],
    [0.171, 0.225], [0.149, 0.262], [0.112, 0.282], [0.070, 0.29],
  ], 22, 1.0, 0.72), mats.jacket, chest);
  // dark shoulder yoke — narrow, so the jacket still reads orange in silhouette
  mesh(lathe([
    [0.174, 0.212], [0.170, 0.238], [0.150, 0.266], [0.113, 0.285], [0.072, 0.293],
  ], 22, 1.008, 0.728, false), mats.jacketDark, chest);
  // cyan piping under the yoke
  mesh(lathe([[0.176, 0.196], [0.179, 0.206], [0.176, 0.216]], 22, 1.01, 0.73, false), mats.accent, chest);
  // front placket (partial lathe hugging the chest) + hem band
  mesh(lathe([[0.128, -0.02], [0.150, 0.04], [0.168, 0.12], [0.176, 0.20], [0.168, 0.252]],
    8, 1.012, 0.735, false, -0.11, 0.22), mats.jacketDark, chest);
  mesh(lathe([[0.126, -0.048], [0.138, -0.032], [0.130, -0.016]], 20, 1.0, 0.75, false), mats.jacketDark, chest);

  const neck = node(chest, 0, D.neck, 0.008);
  const { head, lens } = buildHead(mats, neck, env);

  // ---- arms ----------------------------------------------------------------
  const arms = [];
  for (const side of [1, -1]) {
    const shoulder = node(chest, side * D.shoulderHalf, D.shoulderY, 0.005);
    // deltoid cap in the dark panel colour, tying into the yoke
    mesh(lathe([[0.055, 0.048], [0.073, 0.012], [0.074, -0.030], [0.066, -0.056], [0.058, -0.070]], 16, 1.0, 0.95, 'a'),
      mats.jacketDark, shoulder);
    mesh(lathe(limbProfile(D.upperArm, 0.069, 0.061, 0.053), 16, 1.0, 0.95), mats.jacket, shoulder, 0, -0.02, 0);
    // thin accent ring above the elbow
    mesh(lathe([[0.0545, -0.176], [0.0600, -0.187], [0.0545, -0.198]], 16, 1.0, 0.96, false), mats.accent, shoulder);

    const elbow = node(shoulder, 0, -D.upperArm, 0);
    mesh(lathe(limbProfile(D.foreArm, 0.057, 0.051, 0.050), 16, 1.0, 0.95), mats.jacketDark, elbow);
    // gauntlet cuff flare
    mesh(lathe([[0.053, -0.218], [0.063, -0.242], [0.061, -0.262], [0.050, -0.272]], 16, 1.0, 0.98, 'b'),
      mats.jacket, elbow);

    const wrist = node(elbow, 0, -D.foreArm, 0);
    // glove: a closed fist wrapped around the grip
    const glove = mesh(lathe([
      [0.030, 0.010], [0.050, -0.014], [0.058, -0.052], [0.056, -0.092], [0.042, -0.122], [0.018, -0.134],
    ], 16, 1.0, 1.28), mats.glove, wrist);
    const thumb = mesh(lathe([[0.014, 0.004], [0.020, -0.026], [0.011, -0.052]], 10, 1, 1.2), mats.glove, wrist,
      side * 0.040, -0.048, 0.030);
    thumb.rotation.set(-0.45, 0, side * 0.55);
    // knuckle ridge so the fist reads as a hand, not a blob
    for (let k = -1; k <= 1; k++) {
      mesh(new THREE.SphereGeometry(0.016, 8, 6), mats.glove, wrist, side * k * 0.022, -0.058, 0.049)
        .scale.set(1, 1.5, 0.7);
    }

    const poleGrip = node(wrist, 0, -0.055, 0.012);
    const pole = buildPole(mats, side);
    poleGrip.add(pole);
    arms.push({ side, shoulder, elbow, wrist, poleGrip, glove, pole });
  }

  // ---- leg meshes (driven by IK) -------------------------------------------
  for (const L of legs) {
    const s = L.side;
    L.hip = node(pelvis, s * D.hipHalf, -0.045, 0);
    // salopette leg split into two panels that share their seam vertices
    const TH = [D.thigh, 0.107, 0.097, 0.078];
    mesh(lathe(limbProfile(...TH, 0, 0.62), 16, 1.0, 0.95, 'a'), mats.pant, L.hip, 0, 0.02, 0);
    mesh(lathe(limbProfile(...TH, 0.62, 1), 16, 1.0, 0.95, 'b'), mats.pantPanel, L.hip, 0, 0.02, 0);
    L.knee = node(L.hip, 0, -D.thigh, 0);
    // the pant leg stops above the boot cuff; the gaiter drops over it
    const SH = [D.shin - 0.13, 0.085, 0.079, 0.071];
    mesh(lathe(limbProfile(...SH, 0, 0.34), 16, 1.0, 0.95, 'a'), mats.pantPanel, L.knee);
    mesh(lathe(limbProfile(...SH, 0.34, 1), 16, 1.0, 0.95, 'b'), mats.pant, L.knee);
    L.gaiter = mesh(lathe([
      [0.074, -0.235], [0.080, -0.265], [0.082, -0.296], [0.076, -0.312],
    ], 18, 1.0, 1.02, 'b'), mats.pantPanel, L.knee);
  }

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
    envAssigned: env,
    dbg: { tilt: 0, angul: 0, hipTilt: 0, extT: 0, R: 0, load: 0, stance: 0, edgeMag: 0 },
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
      let lo = 1e9, hi = -1e9;
      for (const p of g.baseSamples) lo = Math.min(lo, hgt(L.ski, p[0], p[1], p[2]));
      for (const p of g.baseSamples) hi = Math.max(hi, hgt(L.ski, p[0], p[1], p[2]));
      const tip = wp(L.ski, 0, 0, g.length * 0.5), tail = wp(L.ski, 0, 0, -g.length * 0.5);
      out.skis.push({
        side: L.side, inside: L.side * sgn > 0,
        baseMin: +lo.toFixed(4), baseMax: +hi.toFixed(4),
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
      const breath = Math.sin(A.t * 1.75) * 0.5 + 0.5;
      const sway = Math.sin(A.t * 0.63) + 0.4 * Math.sin(A.t * 1.31 + 1.1);
      const jitter = (Math.sin(A.t * 7.3) + Math.sin(A.t * 11.7 + 2.1)) * 0.5;
      const chatter = clamp(A.spd / 24, 0, 1) * (1 - A.air) * 0.006;

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
      const edgeMag = clamp(Math.max(ae * 1.02, atilt + 0.10 * load), 0, 1.12) * (1 - 0.55 * A.air);
      const edgeAngle = edgeMag * es;
      // the stance opens as the body lays over — otherwise the inside leg has to
      // fold into itself to reach a ski that is directly under the hip
      const halfStance = 0.140 + 0.050 * load + 0.028 * A.crouch + 0.135 * atilt;
      const contactX = 0.033;   // half the ski waist width
      // The bases ride a hair proud of the snow. 24 mm of it is the gap between
      // the analytic contact height physics publishes and the height the terrain
      // actually triangulates to under the skier — measured, not guessed — and the
      // rest is the ski's own shape: the shovel is 2.5 cm wider than the waist the
      // roll pivots on, so at a big edge angle its outboard corner would dip under.
      const CLEAR = 0.070 + 0.014 * Math.sin(edgeMag);
      const skiLift = 0.30 * A.retract - 0.02 * A.pop;
      for (const L of legs) {
        const side = L.side;
        const inside = side * es;                     // +1 if this is the inside ski
        const lead = inside * (0.055 + 0.05 * load + 0.10 * atilt);  // inside ski leads
        L.pivot.position.set(side * halfStance + es * contactX,
          CLEAR + skiLift - chatter * jitter, lead);
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
      const dbg = A.dbg;   // preallocated: this runs every frame
      dbg.tilt = tilt; dbg.angul = angul; dbg.hipTilt = hipTilt; dbg.extT = extT;
      dbg.R = R; dbg.load = load; dbg.stance = halfStance; dbg.edgeMag = edgeMag;

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
      const chestYaw = -sgn * (0.22 * load + 0.06 * gN);
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
      const headYaw = sgn * (0.34 * load + 0.16 * ae) + Math.sin(A.t * 0.41) * 0.03;
      head.rotation.set(
        -torsoPitch * 0.80 + 0.14 + Math.sin(A.t * 0.9) * 0.012,
        headYaw,
        -chestRoll * 0.75 + Math.sin(A.t * 0.7) * 0.012);

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
        const out = 0.30 - 0.22 * A.crouch + 0.80 * A.retract + 0.34 * A.reach
          + 0.26 * A.pop + 0.10 * inside * load;
        const bend = 1.02 + 0.16 * A.crouch + 0.12 * inside * load
          - 0.55 * A.reach + 0.50 * A.retract - 0.45 * A.pop;

        arm.shoulder.rotation.set(
          -(fwd + 0.42 * plantSharp * isPlant) + Math.sin(A.t * 1.1 + side) * 0.02,
          side * (-0.14 - 0.16 * A.crouch + 0.12 * plantSharp * isPlant),
          side * (out + 0.12 * plantSharp * isPlant) - chestRoll * 0.10);
        arm.elbow.rotation.set(
          -(bend - 0.30 * plantSharp * isPlant) + Math.sin(A.t * 1.3 + side * 2) * 0.02,
          0,
          side * (0.14 + 0.14 * A.crouch));
        arm.wrist.rotation.set(-0.30 + 0.25 * plantSharp * isPlant, side * 0.22, side * -0.18);
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
