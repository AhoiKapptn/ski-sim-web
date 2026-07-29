import * as THREE from 'three';

/**
 * Persistent carve trenches.
 *
 * Two things are maintained:
 *
 * 1. A SNOW DEFORMATION MAP - a render target covering a window of slope around
 *    the skier that scrolls with him. It is scrolled by *whole texels* (blit into
 *    a ping-pong target with an integer texel offset, virgin snow scrolled in at
 *    the trailing edge) so nothing ever smears, tiles or wraps. Every ski contact
 *    is stamped into it. It is exported as `tracks.deform` so the snow material
 *    can drive displacement / normal perturbation from it when that module wants
 *    it.
 *
 * 2. A TRENCH RIBBON - real geometry generated along the recorded ski path and
 *    conformed to the terrain, because a deformation map on its own cannot be
 *    fed into a material this module does not own. Each ski leaves an
 *    independent trench with a compacted floor, two walls and shoulders of
 *    displaced snow piled either side. The floor is packed, icier and much
 *    shinier than untouched powder; the shoulders are loose and catch the sun.
 *    The trench cuts narrow and deep when carving, wide and shallow when
 *    skidding.
 *
 * The ribbon is a ring buffer of *independent* segments, so persistence is
 * bounded by geometry rather than time (~2200 segments at 0.3 m is ~650 m of
 * track) and a new segment costs one 44-vertex upload, never a rebuild.
 */

const MAX_SEG = 2200;      // ring buffer of track segments
const STEP = 0.30;         // metres of travel per segment
const MAX_JUMP = 6.0;      // teleport / respawn guard
const SURFACE_EPS = 0.010; // lift off the terrain to stop z-fighting

// Cross-section of one ski trench, in normalised coordinates.
//
//   u   across the trench, -1..1, scaled by the half width
//   hG  GEOMETRIC height, in units of trench depth. Never negative: the terrain
//       mesh is not ours to displace, so nothing may sit below its surface or it
//       would simply be depth-culled. All the real geometry is the shoulders of
//       displaced snow piled either side of the cut.
//   hV  VIRTUAL height - the profile the snow would have if we *could* cut into
//       it. Only the shading normals are built from this, which is what makes
//       the groove read as a trench with walls and a floor instead of a pair of
//       ridges. Standard decal trick: geometry above, relief in the normals.
//   c   compaction: 0 = untouched powder, 1 = polished trench floor
const PROFILE = [
  [-1.00, 0.00,  0.00, 0.00],
  [-0.72, 0.04,  0.04, 0.10],
  [-0.52, 0.30,  0.48, 0.16],
  [-0.38, 0.13, -0.30, 0.54],
  [-0.22, 0.02, -0.82, 0.90],
  [ 0.00, 0.00, -1.00, 1.00],
  [ 0.22, 0.02, -0.82, 0.90],
  [ 0.38, 0.13, -0.30, 0.54],
  [ 0.52, 0.30,  0.48, 0.16],
  [ 0.72, 0.04,  0.04, 0.10],
  [ 1.00, 0.00,  0.00, 0.00],
];
const P = PROFILE.length;
const VERTS_PER_SEG = P * 2 * 2;          // two rows (ribs) x two skis
const TRIS_PER_SEG = (P - 1) * 2 * 2;

const clamp = THREE.MathUtils.clamp;

// ---------------------------------------------------------------------------
// Surface sampler.
//
// terrain.height() is the authoritative analytic surface, but the *rendered*
// terrain is a finite triangulation of it and can differ by a good fraction of a
// metre between grid points, which would leave the trenches floating or buried.
// When the terrain is the documented plane grid we reproduce its exact triangle
// interpolation; otherwise we fall back to the analytic height.
// ---------------------------------------------------------------------------
function makeSurfaceSampler(terrain) {
  const H = (x, z) => terrain.height(x, z);
  const size = terrain && terrain.size;
  const seg = terrain && terrain.segments;
  const mesh = terrain && terrain.mesh;
  if (!(size > 0) || !(seg > 0) || !mesh || !mesh.isMesh) return H;

  const step = size / seg, half = size / 2;
  return function surfaceY(x, z) {
    const gx = (x + half) / step, gz = (z + half) / step;
    const i = Math.floor(gx), j = Math.floor(gz);
    if (i < 0 || j < 0 || i >= seg || j >= seg) return H(x, z);
    const fx = gx - i, fz = gz - j;
    const X0 = i * step - half, Z0 = j * step - half;
    const h00 = H(X0, Z0), h10 = H(X0 + step, Z0);
    const h01 = H(X0, Z0 + step), h11 = H(X0 + step, Z0 + step);
    // PlaneGeometry splits every cell along the anti-diagonal fx + fz = 1.
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  };
}

// ---------------------------------------------------------------------------
// Scrolling snow deformation map
// ---------------------------------------------------------------------------
const DEFORM_RES = 1024;
const DEFORM_WORLD = 180;   // metres covered by the window

const BLIT_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uShift;
varying vec2 vUv;
void main() {
  vec2 uv = vUv + uShift;
  // Anything scrolled in from beyond the old window is virgin snow.
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  gl_FragColor = texture2D(uSrc, clamp(uv, vec2(0.0), vec2(1.0))) * inside;
}
`;

const STAMP_VERT = /* glsl */`
precision highp float;
attribute vec4 aStamp;      // centre uv, radius (uv), rotation
attribute vec4 aVal;        // depth, compaction, shoulder, coverage
varying vec2 vLocal;
varying vec4 vVal;
void main() {
  float c = cos(aStamp.w), s = sin(aStamp.w);
  vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  vec2 uv = aStamp.xy + q * aStamp.z * 2.0;
  vLocal = position.xy * 2.0;
  vVal = aVal;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

const STAMP_FRAG = /* glsl */`
precision highp float;
varying vec2 vLocal;
varying vec4 vVal;
void main() {
  float d = length(vLocal * vec2(1.0, 0.55));   // narrow across, long along
  float m = 1.0 - smoothstep(0.5, 1.0, d);
  if (m <= 0.002) discard;
  float shoulder = smoothstep(0.3, 0.85, d) * m;
  gl_FragColor = vec4(vVal.x * m, vVal.y * m, vVal.z * shoulder, m);
}
`;

function createDeformMap() {
  const opts = {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  };
  let rtA = new THREE.WebGLRenderTarget(DEFORM_RES, DEFORM_RES, opts);
  let rtB = new THREE.WebGLRenderTarget(DEFORM_RES, DEFORM_RES, opts);

  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const blitMat = new THREE.ShaderMaterial({
    uniforms: { uSrc: { value: null }, uShift: { value: new THREE.Vector2() } },
    vertexShader:
      'varying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }',
    fragmentShader: BLIT_FRAG,
    depthTest: false, depthWrite: false,
  });
  const blitScene = new THREE.Scene();
  blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), blitMat));

  const MAX_STAMPS = 192;
  const stampGeo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  stampGeo.setAttribute('position', quad.attributes.position);
  stampGeo.setIndex(quad.index);
  quad.dispose();
  const stampA = new Float32Array(MAX_STAMPS * 4);
  const stampV = new Float32Array(MAX_STAMPS * 4);
  const attrA = new THREE.InstancedBufferAttribute(stampA, 4).setUsage(THREE.DynamicDrawUsage);
  const attrV = new THREE.InstancedBufferAttribute(stampV, 4).setUsage(THREE.DynamicDrawUsage);
  stampGeo.setAttribute('aStamp', attrA);
  stampGeo.setAttribute('aVal', attrV);
  stampGeo.instanceCount = 0;

  const stampMat = new THREE.ShaderMaterial({
    vertexShader: STAMP_VERT, fragmentShader: STAMP_FRAG,
    depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,          // accumulate, never wash out
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const stampScene = new THREE.Scene();
  const stampMesh = new THREE.Mesh(stampGeo, stampMat);
  stampMesh.frustumCulled = false;
  stampScene.add(stampMesh);

  const center = new THREE.Vector2(0, 0);
  const texel = DEFORM_WORLD / DEFORM_RES;
  let pending = 0;
  let primed = false;

  return {
    get texture() { return rtA.texture; },
    get target() { return rtA; },
    center,

    /** Queue one ski-contact stamp, in world space. */
    stamp(x, z, radius, rot, depth, comp, shoulder) {
      if (pending >= MAX_STAMPS) return;
      const u = (x - center.x) / DEFORM_WORLD + 0.5;
      const v = (z - center.y) / DEFORM_WORLD + 0.5;
      if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) return;
      const i = pending++;
      stampA[i * 4] = u; stampA[i * 4 + 1] = v;
      stampA[i * 4 + 2] = radius / DEFORM_WORLD; stampA[i * 4 + 3] = rot;
      stampV[i * 4] = depth; stampV[i * 4 + 1] = comp;
      stampV[i * 4 + 2] = shoulder; stampV[i * 4 + 3] = 1;
    },

    /** Recentre on the skier (whole texels only), then flush queued stamps. */
    update(renderer, cx, cz) {
      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;

      if (!primed) {
        primed = true;
        center.set(cx, cz);
        for (const rt of [rtA, rtB]) {
          renderer.setRenderTarget(rt);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, false, false);
        }
      }

      const dx = Math.round((cx - center.x) / texel);
      const dz = Math.round((cz - center.y) / texel);
      if (dx !== 0 || dz !== 0) {
        center.x += dx * texel;
        center.y += dz * texel;
        blitMat.uniforms.uSrc.value = rtA.texture;
        blitMat.uniforms.uShift.value.set(dx / DEFORM_RES, dz / DEFORM_RES);
        renderer.setRenderTarget(rtB);
        renderer.render(blitScene, cam);
        const t = rtA; rtA = rtB; rtB = t;
      }

      if (pending > 0) {
        stampGeo.instanceCount = pending;
        attrA.needsUpdate = true;
        attrV.needsUpdate = true;
        renderer.setRenderTarget(rtA);
        renderer.render(stampScene, cam);
        pending = 0;
      }

      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
    },

    dispose() {
      rtA.dispose(); rtB.dispose();
      stampGeo.dispose(); stampMat.dispose(); blitMat.dispose();
    },
  };
}

// ---------------------------------------------------------------------------

export function createTracks(scene, terrain) {
  const surfaceY = makeSurfaceSampler(terrain);
  const deform = createDeformMap();

  // --- geometry ------------------------------------------------------------
  const vCount = MAX_SEG * VERTS_PER_SEG;
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const across = new Float32Array(vCount * 3);
  const trk = new Float32Array(vCount * 4);   // profileU, compaction, birth, along

  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aNrm = new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage);
  const aAcr = new THREE.BufferAttribute(across, 3).setUsage(THREE.DynamicDrawUsage);
  const aTrk = new THREE.BufferAttribute(trk, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('normal', aNrm);
  geo.setAttribute('aAcross', aAcr);
  geo.setAttribute('aTrack', aTrk);
  const ATTRS = [aPos, aNrm, aAcr, aTrk];

  // Static index buffer. Every segment is an independent pair of quad strips, so
  // recycling a slot in the ring never disturbs its neighbours.
  const idx = new Uint32Array(MAX_SEG * TRIS_PER_SEG * 3);
  {
    let o = 0;
    for (let s = 0; s < MAX_SEG; s++) {
      const segBase = s * VERTS_PER_SEG;
      for (let ski = 0; ski < 2; ski++) {
        const b = segBase + ski * P * 2;
        for (let i = 0; i < P - 1; i++) {
          const a0 = b + i, a1 = b + i + 1, b0 = b + P + i, b1 = b + P + i + 1;
          idx[o++] = a0; idx[o++] = b0; idx[o++] = a1;
          idx[o++] = a1; idx[o++] = b0; idx[o++] = b1;
        }
      }
    }
  }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  geo.setDrawRange(0, 0);

  // --- material ------------------------------------------------------------
  const uTime = { value: 0 };
  const uDeform = { value: deform.texture };
  const uDeformCenter = { value: deform.center };
  const uDeformSize = { value: DEFORM_WORLD };

  const mat = new THREE.MeshStandardMaterial({
    color: 0xeef4ff,
    roughness: 0.82,
    metalness: 0.0,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });

  // A silently missed `.replace()` target is the classic way this kind of chunk
  // injection dies quietly, so assert afterwards that every marker landed.
  const patched = {};

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uDeform = uDeform;
    shader.uniforms.uDeformCenter = uDeformCenter;
    shader.uniforms.uDeformSize = uDeformSize;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aTrack;
        attribute vec3 aAcross;
        varying vec4 vTrack;
        varying vec3 vAcross;
        varying vec3 vWPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTrack  = aTrack;
        vAcross = aAcross;
        vWPos   = (modelMatrix * vec4(transformed, 1.0)).xyz;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform sampler2D uDeform;
        uniform vec2 uDeformCenter;
        uniform float uDeformSize;
        varying vec4 vTrack;
        varying vec3 vAcross;
        varying vec3 vWPos;

        float tHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }
        float tNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x),
                     mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
        }`)

      .replace('#include <color_fragment>', `
        float pu    = vTrack.x;
        float comp  = vTrack.y;
        float age   = max(uTime - vTrack.z, 0.0);
        float along = vTrack.w;
        float au    = abs(pu);

        // Fade the shading treatment out at the rim so the opaque ribbon melts
        // into the untouched snow instead of showing its own silhouette.
        float edge = 1.0 - smoothstep(0.74, 1.0, au);

        // Crest of displaced snow: loose, granular, the brightest thing here.
        float crest = smoothstep(0.34, 0.52, au) * (1.0 - smoothstep(0.52, 0.86, au));

        // Snow chatter: coarse break-up plus the fine transverse ridges an edge
        // leaves, so the trench never reads as a clean extruded stripe.
        float grain = tNoise(vec2(along * 2.4, pu * 3.0)) * 0.65
                    + tNoise(vec2(along * 9.0, pu * 7.0)) * 0.35;
        float chat  = tNoise(vec2(along * 21.0, pu * 1.5));
        float broken = 0.62 + 0.62 * grain;

        // A previous pass through the same snow packs it further.
        vec2 dUv = (vWPos.xz - uDeformCenter) / uDeformSize + 0.5;
        float inWin = step(0.0, dUv.x) * step(dUv.x, 1.0) * step(0.0, dUv.y) * step(dUv.y, 1.0);
        float crossPack = texture2D(uDeform, dUv).g * inWin;
        comp = clamp(comp + crossPack * 0.18 * (1.0 - comp), 0.0, 1.0);

        // Compacted snow: denser, distinctly darker and bluer than powder.
        vec3 packed = vec3(0.80, 0.825, 0.875);
        comp *= edge;
        diffuseColor.rgb *= mix(vec3(1.0), packed, comp * broken);
        diffuseColor.rgb += vec3(0.055, 0.056, 0.060) * crest * edge * (0.55 + 0.9 * grain);
        diffuseColor.rgb *= 1.0 - 0.20 * comp * chat;
        diffuseColor.rgb *= mix(1.0, 0.955, edge);   // disturbed apron

        // Older track slowly fills in with wind-blown snow.
        float fill = smoothstep(30.0, 150.0, age);
        comp *= 1.0 - 0.45 * fill;

        // The trench floor sees far less sky than the open slope: this
        // ambient occlusion is most of what makes a groove read as deep.
        float trenchAO = clamp(mix(1.0, 0.46, comp) + 0.30 * crest, 0.0, 1.3);`)

      // Runs after the lighting loop, so it can shade the direct term too: a
      // trench floor is shadowed by its own wall for most of the day, and that
      // tonal drop is what keeps the track readable from thirty metres away.
      .replace('#include <aomap_fragment>', `
        reflectedLight.indirectDiffuse  *= trenchAO;
        reflectedLight.indirectSpecular *= mix(1.0, trenchAO, 0.6);
        reflectedLight.directDiffuse    *= mix(1.0, 0.86, comp);`)

      // Polished icy trench floor, loose powder on the shoulders.
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = mix(roughness, 0.30, comp * comp);
        roughnessFactor = mix(roughnessFactor, roughness * 1.06, crest);
        roughnessFactor = clamp(roughnessFactor + 0.10 * (chat - 0.5) * comp, 0.05, 1.0);`)

      // Micro relief from the chatter marks.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          float ridge = (tNoise(vec2(along * 17.0, pu * 3.0)) - 0.5)
                      + 0.65 * (tNoise(vec2(along * 5.0, pu * 9.0)) - 0.5);
          normal = normalize(normal + normalize(vAcross) * ridge * 0.55 * comp);
        }`);

    for (const [tag, marker] of [
      ['vAttrs', 'attribute vec4 aTrack'], ['vVary', 'vWPos   = (modelMatrix'],
    ]) patched[tag] = shader.vertexShader.indexOf(marker) >= 0;
    for (const [tag, marker] of [
      ['fCommon', 'float tNoise('], ['fColor', 'float trenchAO'],
      ['fAO', 'reflectedLight.indirectDiffuse  *= trenchAO'],
      ['fRough', 'mix(roughness, 0.21, comp * comp)'],
      ['fNormal', 'normalize(vAcross) * ridge'],
    ]) patched[tag] = shader.fragmentShader.indexOf(marker) >= 0;
  };
  mat.customProgramCacheKey = () => 'alpine-carve-tracks';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = 2;
  mesh.name = 'carve-tracks';
  scene.add(mesh);

  // --- path recording ------------------------------------------------------
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const gN = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();
  const nrmTmp = new THREE.Vector3();
  const lastPos = new THREE.Vector3();

  const makeRib = () => ({
    pos: new Float32Array(2 * P * 3),
    nrm: new Float32Array(2 * P * 3),
    acr: new Float32Array(2 * P * 3),
    comp: new Float32Array(2 * P),
    along: 0,
  });
  let ribPrev = makeRib(), ribCur = makeRib();
  let havePrev = false;

  let segCursor = 0, segCount = 0;
  let time = 0, travelled = 0, haveLast = false;
  let renderer = null, needDeform = false;
  let dirtyLo = Infinity, dirtyHi = -1, dirtyWrapped = false;

  /** Build both ski cross-sections of one rib. */
  function buildRib(rib, px, pz, spacing, width, depth, compact) {
    for (let ski = 0; ski < 2; ski++) {
      const side = ski === 0 ? -1 : 1;
      const cx = px + right.x * side * spacing;
      const cz = pz + right.z * side * spacing;
      for (let i = 0; i < P; i++) {
        const u = PROFILE[i][0];
        const x = cx + right.x * u * width;
        const z = cz + right.z * u * width;
        const y = surfaceY(x, z) + PROFILE[i][1] * depth + SURFACE_EPS;

        // Shading normal comes from the virtual (cut) profile, not the geometry.
        const i0 = Math.max(i - 1, 0), i1 = Math.min(i + 1, P - 1);
        const dh = (PROFILE[i1][2] - PROFILE[i0][2]) * depth * 1.05;
        const du = (PROFILE[i1][0] - PROFILE[i0][0]) * width;
        nrmTmp.copy(gN).addScaledVector(right, du > 1e-5 ? -dh / du : 0).normalize();

        const k = ski * P + i, o = k * 3;
        rib.pos[o] = x; rib.pos[o + 1] = y; rib.pos[o + 2] = z;
        rib.nrm[o] = nrmTmp.x; rib.nrm[o + 1] = nrmTmp.y; rib.nrm[o + 2] = nrmTmp.z;
        rib.acr[o] = right.x; rib.acr[o + 1] = right.y; rib.acr[o + 2] = right.z;
        rib.comp[k] = PROFILE[i][3] * compact;
      }
    }
  }

  function writeSegment(a, b) {
    const s = segCursor;
    segCursor += 1;
    if (segCursor >= MAX_SEG) { segCursor = 0; dirtyWrapped = true; }
    if (segCount < MAX_SEG) segCount++;
    if (s < dirtyLo) dirtyLo = s;
    if (s > dirtyHi) dirtyHi = s;

    const base = s * VERTS_PER_SEG;
    for (let ski = 0; ski < 2; ski++) {
      for (let row = 0; row < 2; row++) {
        const rib = row === 0 ? a : b;
        for (let i = 0; i < P; i++) {
          const v = base + ski * P * 2 + row * P + i;
          const k = ski * P + i, si = k * 3;
          pos[v * 3] = rib.pos[si]; pos[v * 3 + 1] = rib.pos[si + 1]; pos[v * 3 + 2] = rib.pos[si + 2];
          nrm[v * 3] = rib.nrm[si]; nrm[v * 3 + 1] = rib.nrm[si + 1]; nrm[v * 3 + 2] = rib.nrm[si + 2];
          across[v * 3] = rib.acr[si]; across[v * 3 + 1] = rib.acr[si + 1]; across[v * 3 + 2] = rib.acr[si + 2];
          trk[v * 4] = PROFILE[i][0];
          trk[v * 4 + 1] = rib.comp[k];
          trk[v * 4 + 2] = time;
          trk[v * 4 + 3] = rib.along;
        }
      }
    }
  }

  mesh.onBeforeRender = (r) => {
    renderer = r;
    uDeform.value = deform.texture;
  };

  const api = {
    mesh,

    /**
     * Snow deformation map, for whoever owns the snow material:
     *   R = trench depth, G = compaction, B = displaced shoulder, A = coverage.
     * Sample with  uv = (worldXZ - deform.center) / deform.size + 0.5.
     */
    deform: {
      get texture() { return deform.texture; },
      center: deform.center,
      size: DEFORM_WORLD,
      resolution: DEFORM_RES,
    },

    get ribCount() { return segCount; },

    /** Dev probe: mean coverage written into the deformation map so far. */
    deformStats() {
      if (!renderer) return null;
      const N = 128;
      const buf = new Uint8Array(N * N * 4);
      const o = (DEFORM_RES - N) >> 1;   // sample the middle of the window
      renderer.readRenderTargetPixels(deform.target, o, o, N, N, buf);
      let cov = 0, dep = 0;
      for (let i = 0; i < buf.length; i += 4) { cov += buf[i + 3]; dep += buf[i]; }
      const n = buf.length / 4;
      return { center: [Math.round(deform.center.x), Math.round(deform.center.y)],
               meanCoverage: +(cov / n).toFixed(2), meanDepth: +(dep / n).toFixed(2) };
    },
    get patched() { return patched; },

    update(dt, state) {
      if (!(dt > 0)) dt = 1 / 60;
      time += dt;
      uTime.value = time;

      const p = state.pos;

      // Scroll + stamp the deformation map with last frame's renderer handle, so
      // we never nest a render-target switch inside the main render pass.
      if (renderer && needDeform) {
        deform.update(renderer, p.x, p.z);
        needDeform = false;
      }

      gN.copy(state.groundNormal || tmp.set(0, 1, 0));
      if (gN.lengthSq() < 0.5) gN.set(0, 1, 0);
      gN.normalize();

      fwd.set(Math.sin(state.heading), 0, Math.cos(state.heading));
      fwd.addScaledVector(gN, -fwd.dot(gN));
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
      fwd.normalize();
      right.crossVectors(fwd, gN).normalize().negate();

      if (!haveLast) { lastPos.copy(p); haveLast = true; needDeform = true; }

      const moved = tmp.copy(p).sub(lastPos).length();

      // Teleport / respawn: break the ribbon rather than stretching it.
      if (moved > MAX_JUMP || state.airborne) {
        lastPos.copy(p);
        havePrev = false;
        needDeform = true;
        return;
      }
      if (moved < STEP) return;

      // How is the trench being cut right now?
      const edgeAbs = Math.min(Math.abs(state.edge || 0), 1);
      const spd = state.speed || 0;
      let slip = 0;
      if (spd > 0.5) {
        tmp.copy(state.vel).normalize();
        slip = Math.abs(clamp(tmp.dot(right), -1, 1));
      }
      const brake = (state.input && state.input.brake) || 0;
      const skid = clamp(slip * 1.5 + brake * 0.8, 0, 1);
      const carve = clamp(edgeAbs * (1 - skid * 0.65), 0, 1);

      // Carving cuts a clean narrow trench; skidding smears a wide shallow one.
      const width = 0.095 + skid * 0.075 + carve * 0.035;
      const depth = 0.030 + carve * 0.060 + skid * 0.020 +
                    clamp((state.gForce || 0) * 0.009, 0, 0.022);
      const spacing = 0.135 + skid * 0.045;
      const compact = clamp(0.55 + carve * 0.45 - skid * 0.12, 0.35, 1.0);

      travelled += moved;
      const t = ribPrev; ribPrev = ribCur; ribCur = t;     // recycle, never alloc
      buildRib(ribCur, p.x, p.z, spacing, width, depth, compact);
      ribCur.along = travelled;

      if (havePrev) writeSegment(ribPrev, ribCur);
      havePrev = true;
      lastPos.copy(p);

      // Stamp both ski contacts into the deformation map.
      const rot = Math.atan2(right.z, right.x);
      const dNorm = clamp(depth / 0.17, 0, 1);
      for (let ski = 0; ski < 2; ski++) {
        const side = ski === 0 ? -1 : 1;
        deform.stamp(p.x + right.x * side * spacing, p.z + right.z * side * spacing,
                     width * 1.2, rot, dNorm, compact, dNorm * 0.8);
      }
      needDeform = true;

      // Upload only the slots we touched.
      if (dirtyHi >= 0) {
        const lo = dirtyWrapped ? 0 : dirtyLo;
        const hi = dirtyWrapped ? MAX_SEG - 1 : dirtyHi;
        const start = lo * VERTS_PER_SEG, count = (hi - lo + 1) * VERTS_PER_SEG;
        for (let i = 0; i < ATTRS.length; i++) {
          const a = ATTRS[i];
          a.clearUpdateRanges();
          a.addUpdateRange(start * a.itemSize, count * a.itemSize);
          a.needsUpdate = true;
        }
        geo.setDrawRange(0, segCount * TRIS_PER_SEG * 3);
        dirtyLo = Infinity; dirtyHi = -1; dirtyWrapped = false;
      }
    },

    dispose() {
      scene.remove(mesh);
      geo.dispose(); mat.dispose(); deform.dispose();
    },
  };

  if (import.meta.env && import.meta.env.DEV && typeof window !== 'undefined') {
    const hook = (window.__fx = window.__fx || {});
    hook.tracks = api;
  }

  return api;
}
