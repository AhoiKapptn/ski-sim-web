import * as THREE from 'three';

// --- deterministic value-noise FBM -------------------------------------------
function hash2(x, y) {
  let h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y, oct = 6, lac = 2.02, gain = 0.5) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f); f *= lac; a *= gain; }
  return s;
}

/**
 * Mountain heightfield. `height(x,z)` is the authoritative surface used by both
 * the mesh and the physics, so they can never disagree.
 */
export class Terrain {
  constructor({ size = 2400, segments = 400 } = {}) {
    this.size = size;
    this.segments = segments;
    this.mesh = this._build();
  }

  /** World-space surface height at (x,z). */
  height(x, z) {
    const s = 0.0016;
    // Broad downhill slope along -Z, plus a bowl shape across X.
    let h = -z * 0.34 + Math.pow(Math.abs(x) / 900, 2.1) * 260;
    h += fbm(x * s, z * s, 6) * 190;          // mountain body
    h += fbm(x * s * 6.1, z * s * 6.1, 4) * 16; // rollers / moguls
    return h;
  }

  normal(x, z, e = 1.2) {
    const hL = this.height(x - e, z), hR = this.height(x + e, z);
    const hD = this.height(x, z - e), hU = this.height(x, z + e);
    return new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
  }

  _build() {
    const { size, segments } = this;
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.height(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xeef4ff, roughness: 0.82, metalness: 0.0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
  }
}
