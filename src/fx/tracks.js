import * as THREE from 'three';
import { createSnowMaterial } from '../world/snow-material.js';

/**
 * Carve trenches.
 *
 * The single most important thing in this file is what it is NOT: a dark stripe.
 * A fresh carve on a groomed piste differs from the snow beside it by a couple of
 * percent of albedo. Everything you actually see — and you see it from thirty
 * metres — is *shape*: a shallow trench with steep walls, a compacted floor that
 * is denser, icier and more specular, two shoulders of loose displaced snow, and
 * the sky occlusion the trench casts on its own floor. Paint it dark and it reads
 * as gaffer tape laid on the slope; that is exactly what the previous version
 * did, and it measured 118 luma against 217 for the snow beside it — a 45% drop
 * where reality is nearer 3%.
 *
 * The fix is structural rather than cosmetic: the ribbon is shaded with
 * `createSnowMaterial()`, i.e. *the piste's own shader*, so the track starts life
 * as literally the same material as the snow under it — same albedo, same
 * subsurface scattering, same sparkle, same aerial perspective. This module then
 * perturbs only four things inside that shader:
 *
 *   snNormalW       rotated by the analytic cross-slope of the trench profile
 *   snIce/snPowder  compacted floor -> the shader's own wind-slab/ice treatment
 *   roughnessFactor polished floor, loose shoulders
 *   snMicroAO       the floor sees less sky than the open slope
 *
 * and the ribbon is alpha-blended, with opacity driven by the trench profile, so
 * the rim cross-fades into untouched snow instead of ending on a silhouette. The
 * rim itself is broken up with noise and, when skidding, scalloped, so it is
 * never a clean parallel line.
 *
 * Two things are maintained:
 *
 * 1. A SNOW DEFORMATION MAP — a render target covering a window of slope around
 *    the skier that scrolls with him, by *whole texels*, so nothing ever smears
 *    or wraps. Exported as `tracks.deform` for whoever owns the snow material.
 *
 * 2. The TRENCH RIBBON described above: a ring buffer of *independent* segments,
 *    so persistence is bounded by geometry rather than time and a new segment
 *    costs one vertex upload, never a rebuild.
 */

const MAX_SEG = 2600;      // ring buffer of track segments
const STEP = 0.28;         // metres of travel per segment
// A carved arc is a curve, and a curve sampled by arc length alone facets. At
// 54 degrees of edge the ski's contact point sweeps sideways nearly as fast as
// it goes forward, so the ribbon is *also* subdivided on heading change: commit
// a rib whenever the skier has turned this far since the last one. 0.055 rad is
// about 3 degrees, i.e. a 30-sided polygon around a full circle, which is below
// the faceting threshold at any width this trench ever has.
const STEP_YAW = 0.055;
const STEP_MIN = 0.055;    // ...but never closer together than this, in metres
const MAX_JUMP = 6.0;      // teleport / respawn guard
const SURFACE_EPS = 0.016; // lift off the terrain to stop z-fighting
const TAIL_TAPER = 0.10;   // compaction left at a deliberate ribbon end

// Cross-section of one ski trench, in normalised coordinates.
//
//   u   across the trench, -1..1, scaled by the half width
//   hG  GEOMETRIC height, in units of trench depth. Never negative: the terrain
//       mesh is not ours to displace, so nothing may sit below its surface or it
//       would simply be depth-culled. The real geometry here is the shoulders of
//       displaced snow piled either side of the cut.
//
// The *virtual* profile — the cut itself — is evaluated analytically in the
// fragment shader instead of being interpolated from these points, which is what
// lets the walls stay crisp at any width and lets the rim wander per-pixel.
const PROFILE = [
  [-1.00, 0.000],
  [-0.86, 0.010],
  [-0.72, 0.075],
  [-0.60, 0.145],
  [-0.46, 0.105],
  [-0.30, 0.030],
  [-0.15, 0.004],
  [ 0.00, 0.000],
  [ 0.15, 0.004],
  [ 0.30, 0.030],
  [ 0.46, 0.105],
  [ 0.60, 0.145],
  [ 0.72, 0.075],
  [ 0.86, 0.010],
  [ 1.00, 0.000],
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
// The trench, expressed as a perturbation of the piste's own snow shader.
//
// Injected after <metalnessmap_fragment>, i.e. after snow-material's own
// SNOW_SURFACE block has run (it owns <roughnessmap_fragment>) and before
// SNOW_NORMAL turns `snNormalW` into a view-space normal (it owns
// <normal_fragment_begin>). Everything it touches is a local the snow shader
// itself declared, so the track is not a second material sitting next to the
// piste — it is the piste, with a groove cut in it.
// ---------------------------------------------------------------------------
const TRACK_SURFACE = /* glsl */`
{
  float pu    = vTrk.x;                    // -1..1 across the trench
  float compR = vTrk.y;                    // how hard this rib was cut
  float age   = max( uTrkTime - vTrk.z, 0.0 );
  float along = vTrk.w;                    // metres travelled, continuous
  float halfW = max( vTrk2.x, 0.02 );      // half width, metres
  float depth = vTrk2.y;                   // trench depth, metres
  float skid  = vTrk2.z;
  float load  = vTrk2.w;

  // ---- the rim is never a straight line -----------------------------------
  // Snow crumbles as the edge lifts it, so the boundary between cut and
  // untouched wanders by a few centimetres and, on a skidded turn, scallops.
  // snFbm returns a signed value in .x and its gradient in .yz.
  vec3 nR  = snFbm( vec2( along * 1.15, pu * 0.85 ), 2, 0.5 );
  vec3 nR2 = snFbm( vec2( along * 5.30, pu * 2.10 ), 2, 0.5 );
  float wob = nR.x * 0.62 + nR2.x * 0.30;
  float scallop = sin( along * 3.1 + nR2.x * 3.0 ) * skid * 0.22;
  float au = clamp( abs( pu ) * ( 1.0 + 0.30 * wob + scallop ) + 0.05 * wob, 0.0, 1.6 );

  // ---- analytic cross-section ---------------------------------------------
  // floor: a gaussian trough. shoulder: the berm of snow the edge pushed out.
  float fl   = exp( -au * au * 9.5 );
  float sh   = exp( -pow( ( au - 0.62 ) / 0.21, 2.0 ) );
  float dFl  = -19.0 * au * fl;
  float dSh  = -2.0 * ( au - 0.62 ) / ( 0.21 * 0.21 ) * sh;
  // d(height)/d(u), then converted to a real gradient across the trench.
  float dh   = ( -depth * dFl + depth * 0.46 * dSh ) * sign( pu );
  float xslope = clamp( dh / halfW, -1.45, 1.45 );

  // Chatter: an edge under load vibrates and leaves transverse ridges, and the
  // base leaves fine longitudinal striations on the polished floor.
  float chat  = snFbm( vec2( along * 13.0, pu * 0.5 ), 2, 0.5 ).x;
  float stria = sin( pu * 41.0 ) * 0.5;
  xslope += chat * 0.85 * load * fl;
  xslope += stria * 0.11 * fl * ( 0.35 + 0.65 * compR );

  // ---- how much of this pixel is track at all ------------------------------
  float dist  = length( vSnowWPos - cameraPosition );
  float fadeD = 1.0 - smoothstep( 150.0, 420.0, dist );   // don't stripe the horizon
  float fadeA = 1.0 - 0.62 * smoothstep( 22.0, 130.0, age );
  float body  = clamp( fl * 1.55 + sh * 1.25, 0.0, 1.0 );
  float pack  = compR * fl * fadeD * fadeA;               // polished floor
  float loose = compR * sh * fadeD * fadeA;               // displaced shoulder
  float cover = clamp( body * compR * fadeD * fadeA, 0.0, 1.0 );

  // ---- shading -------------------------------------------------------------
  // All of the read comes from here: the walls turn away from the sun, the floor
  // sees less sky, and the packed snow goes denser and more specular. The albedo
  // moves by 3%, which is what it moves by in life.
  vec3 acr = normalize( vTrkAcross );
  snNormalW = normalize( snNormalW - acr * xslope * ( fadeD * fadeA ) );

  // The wall on the far side of the sun shadows the floor for most of the day.
  // three's shadow map is nowhere near fine enough to resolve a 3 cm trench, so
  // it is done analytically: how far across the groove the sun can reach.
  float sunA  = dot( normalize( uSunDirW ), acr );
  float sunUp = max( normalize( uSunDirW ).y, 0.05 );
  float reach = clamp( abs( sunA ) * depth / ( sunUp * halfW ), 0.0, 1.4 );
  float wallShade = clamp( ( sign( sunA ) * pu + 1.0 ) * 0.5, 0.0, 1.0 );
  wallShade = smoothstep( 0.0, 0.55, wallShade ) * reach * fl;

  // Compacted snow is the shader's own "wind slab / ice" end of the scale:
  // bluer by a percent or two, tighter specular lobe, less powder.
  snIce    = clamp( max( snIce, pack * 0.85 ), 0.0, 1.0 );
  snPowder = clamp( snPowder * ( 1.0 - 0.80 * pack ) + loose * 0.55, 0.0, 1.0 );
  roughnessFactor = mix( roughnessFactor, 0.28, pack * 0.90 );
  roughnessFactor = min( roughnessFactor + 0.07 * loose, 0.98 );

  // Sky occlusion inside the groove. snow-material turns a low snMicroAO into a
  // *blue* pit rather than a grey one, which is exactly what a real trench does.
  snMicroAO *= 1.0 - 0.34 * pack - 0.21 * wallShade;

  // Density, not paint: denser snow is a couple of percent darker, and the loose
  // berm a shade brighter because it is full of air.
  diffuseColor.rgb *= 1.0 - 0.030 * pack;
  diffuseColor.rgb *= 1.0 + 0.016 * loose;

  // Cross-fade to untouched snow at the rim. The ribbon is alpha-blended over
  // the piste it is cut into, so there is no silhouette anywhere.
  diffuseColor.a *= cover;
  if ( diffuseColor.a < 0.004 ) discard;
}
`;

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
  const trk2 = new Float32Array(vCount * 4);  // halfWidth, depth, skid, load

  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aNrm = new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage);
  const aAcr = new THREE.BufferAttribute(across, 3).setUsage(THREE.DynamicDrawUsage);
  const aTrk = new THREE.BufferAttribute(trk, 4).setUsage(THREE.DynamicDrawUsage);
  const aTrk2 = new THREE.BufferAttribute(trk2, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('normal', aNrm);
  geo.setAttribute('aAcross', aAcr);
  geo.setAttribute('aTrack', aTrk);
  geo.setAttribute('aTrack2', aTrk2);
  const ATTRS = [aPos, aNrm, aAcr, aTrk, aTrk2];

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
  // The piste's own shader. `rock: false` matters: the trench walls are steep,
  // and snow-material exposes rock on steep normals — a carve would otherwise
  // grow a granite floor.
  const uTrkTime = { value: 0 };
  const mat = createSnowMaterial({
    rock: false,
    side: THREE.DoubleSide,
    // DoubleSide + transparent makes three render this mesh TWICE per frame:
    // WebGLRenderer.renderObject does side=BackSide, needsUpdate=true, draw,
    // side=FrontSide, needsUpdate=true, draw. Two consequences, both bad and
    // neither visible in a draw-call count that nobody had broken down by pass:
    // the trench ribbon rasterises twice with the FULL snow shader, transparent
    // and therefore with no early-Z; and `needsUpdate = true` fires twice a
    // frame, bumping material.version and forcing three's whole
    // needsProgramChange path plus a complete uniform refresh — twice — on a
    // material carrying ~45 custom uniforms.
    //
    // A ground-hugging trench ribbon has no visible back face, so one pass is
    // all it ever needed. forceSinglePass keeps DoubleSide rasterisation and
    // drops the second draw.
    forceSinglePass: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -6,
    uniforms: { uTrkTime },
  });

  // A silently missed `.replace()` target is the classic way this kind of chunk
  // injection dies quietly, so assert afterwards that every marker landed.
  const patched = {};
  const innerCompile = mat.onBeforeCompile;

  mat.onBeforeCompile = (shader, renderer) => {
    innerCompile(shader, renderer);
    shader.uniforms.uTrkTime = uTrkTime;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aTrack;
        attribute vec4 aTrack2;
        attribute vec3 aAcross;
        varying vec4 vTrk;
        varying vec4 vTrk2;
        varying vec3 vTrkAcross;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTrk = aTrack;
        vTrk2 = aTrack2;
        vTrkAcross = normalize( mat3( modelMatrix ) * aAcross );`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTrkTime;
        varying vec4 vTrk;
        varying vec4 vTrk2;
        varying vec3 vTrkAcross;`)
      .replace('#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n' + TRACK_SURFACE);

    for (const [tag, marker] of [
      ['vAttrs', 'attribute vec4 aTrack2'], ['vVary', 'vTrkAcross = normalize('],
      ['vSnow', 'vSnowWPos = ( modelMatrix'],
    ]) patched[tag] = shader.vertexShader.indexOf(marker) >= 0;
    for (const [tag, marker] of [
      ['fCommon', 'uniform float uTrkTime'], ['fSurface', 'float xslope = clamp'],
      ['fSnowSurface', 'snRockMask = smoothstep'], ['fSnowNormal', 'nonPerturbedNormal'],
      ['fSnowScatter', 'Anisotropic wind-packed sheen'],
    ]) patched[tag] = shader.fragmentShader.indexOf(marker) >= 0;

    // Loud, not silent. Every one of these is a `.replace()` into a shader this
    // module does not own; if snow-material moves an injection point the track
    // would quietly go back to being an untextured stripe.
    for (const k in patched) {
      if (!patched[k]) console.warn(`[tracks] shader injection '${k}' did not land`);
    }
  };

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
  const lastPos = new THREE.Vector3();

  const makeRib = () => ({
    pos: new Float32Array(2 * P * 3),
    nrm: new Float32Array(2 * P * 3),
    acr: new Float32Array(2 * P * 3),
    along: 0, comp: 0, halfW: 0.1, depth: 0.05, skid: 0, load: 0,
    cx: 0, cz: 0, spacing: 0.14,
  });
  // Three ribs, rotated between: the last committed one, the one being built at
  // the ski right now, and a scratch used to close a ribbon off.
  let ribPrev = makeRib(), ribHead = makeRib(), ribTmp = makeRib();
  let havePrev = false;

  let segCursor = 0, segCount = 0;
  let liveHead = false;                 // is slot `segCursor` holding a live head?
  let time = 0, travelled = 0, haveLast = false;
  let renderer = null, needDeform = false;
  const lastCommit = new THREE.Vector3();
  let lastCommitHeading = 0;
  // Dirty bookkeeping. Deliberately NOT flushed from update(): see flush().
  let dirtyLo = Infinity, dirtyHi = -1, dirtyWrapped = false;

  /** Build both ski cross-sections of one rib. */
  function buildRib(rib, px, pz, spacing, width, depth) {
    rib.cx = px; rib.cz = pz; rib.spacing = spacing;
    for (let ski = 0; ski < 2; ski++) {
      const side = ski === 0 ? -1 : 1;
      const cx = px + right.x * side * spacing;
      const cz = pz + right.z * side * spacing;
      for (let i = 0; i < P; i++) {
        const u = PROFILE[i][0];
        const x = cx + right.x * u * width;
        const z = cz + right.z * u * width;
        const y = surfaceY(x, z) + PROFILE[i][1] * depth + SURFACE_EPS;

        // The geometry normal stays the *ground* normal: snow-material builds its
        // whole surface treatment off it, and it must agree with the piste beside
        // us. The trench is added to snNormalW per-pixel instead.
        const k = ski * P + i, o = k * 3;
        rib.pos[o] = x; rib.pos[o + 1] = y; rib.pos[o + 2] = z;
        rib.nrm[o] = gN.x; rib.nrm[o + 1] = gN.y; rib.nrm[o + 2] = gN.z;
        rib.acr[o] = right.x; rib.acr[o + 1] = right.y; rib.acr[o + 2] = right.z;
      }
    }
  }

  /** Write the quad strips of one segment into ring slot `s`. */
  function writeSegmentAt(s, a, b) {
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
          trk[v * 4 + 1] = rib.comp;
          trk[v * 4 + 2] = time;
          trk[v * 4 + 3] = rib.along;
          trk2[v * 4] = rib.halfW;
          trk2[v * 4 + 1] = rib.depth;
          trk2[v * 4 + 2] = rib.skid;
          trk2[v * 4 + 3] = rib.load;
        }
      }
    }
  }

  /** Commit one segment permanently and advance the ring. */
  function commitSegment(a, b) {
    writeSegmentAt(segCursor, a, b);
    segCursor += 1;
    if (segCursor >= MAX_SEG) { segCursor = 0; dirtyWrapped = true; }
    if (segCount < MAX_SEG) segCount++;
  }

  /**
   * Push the dirty slice to the GPU.
   *
   * This MUST run once per draw and nowhere else. `BufferAttribute.addUpdateRange`
   * is consumed by the renderer at upload time, and `clearUpdateRanges()` throws
   * away anything not yet uploaded — so calling it from update() silently deleted
   * every segment but the last whenever the sim stepped more than once between
   * frames. That is exactly what tools/flyby.mjs does (five 120 Hz substeps per
   * captured frame), and it is why the trench came out as detached rectangles
   * with square ends: one rib in every two or three reached the GPU and the rest
   * stayed as the zero-filled degenerate triangles the buffer was born with.
   *
   * onBeforeRender fires immediately before renderBufferDirect binds the
   * geometry, so this is the one place where "add range, mark dirty" is
   * guaranteed to be followed by the upload that consumes it.
   */
  function flush() {
    if (dirtyHi < 0) return;
    const lo = dirtyWrapped ? 0 : dirtyLo;
    const hi = dirtyWrapped ? MAX_SEG - 1 : dirtyHi;
    const start = lo * VERTS_PER_SEG, count = (hi - lo + 1) * VERTS_PER_SEG;
    for (let i = 0; i < ATTRS.length; i++) {
      const a = ATTRS[i];
      a.clearUpdateRanges();
      a.addUpdateRange(start * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
    dirtyLo = Infinity; dirtyHi = -1; dirtyWrapped = false;
  }

  /**
   * How much of the ring is on screen. `+1` while a live head is present, since
   * the head lives in the slot the next commit will take.
   */
  function setDrawRange() {
    const n = Math.min(segCount + (liveHead ? 1 : 0), MAX_SEG);
    geo.setDrawRange(0, n * TRIS_PER_SEG * 3);
  }

  /** Stamp both ski contacts into the deformation map. */
  function stampContacts(p, spacing, width, depth, compact) {
    const rot = Math.atan2(right.z, right.x);
    const dNorm = clamp(depth / 0.13, 0, 1);
    for (let ski = 0; ski < 2; ski++) {
      const side = ski === 0 ? -1 : 1;
      deform.stamp(p.x + right.x * side * spacing, p.z + right.z * side * spacing,
                   width * 1.2, rot, dNorm, compact, dNorm * 0.8);
    }
    needDeform = true;
  }

  /**
   * Terminate the ribbon with a short taper instead of a square cut. `ribPrev`
   * is duplicated a little further along the ski direction with its compaction
   * pulled almost to zero, and since compaction is what drives the ribbon's
   * alpha the trench dissolves into untouched snow over ~20 cm.
   */
  function closeRibbon() {
    const half = ribPrev.halfW;
    buildRib(ribTmp,
      ribPrev.cx + fwd.x * 0.22, ribPrev.cz + fwd.z * 0.22,
      ribPrev.spacing, half, ribPrev.depth * 0.55);
    ribTmp.along = ribPrev.along + 0.22;
    ribTmp.comp = ribPrev.comp * TAIL_TAPER;
    ribTmp.halfW = half;
    ribTmp.depth = ribPrev.depth * 0.55;
    ribTmp.skid = ribPrev.skid;
    ribTmp.load = ribPrev.load;
    commitSegment(ribPrev, ribTmp);
  }

  mesh.onBeforeRender = (r) => { renderer = r; flush(); };

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

    /**
     * Dev probe: the geometric continuity of the ribbon as it stands in the
     * vertex buffer. `gaps` counts places where the end rib of one segment does
     * not coincide with the start rib of the next, which is the signature the
     * dashed trench had; `degenerate` counts slots still holding the zero-filled
     * triangles a never-uploaded slot leaves behind.
     */
    ribbonStats(back = 64) {
      const n = Math.min(segCount, back);
      let gaps = 0, degenerate = 0, worst = 0, maxSpan = 0;
      const centre = P >> 1;
      for (let k = 1; k <= n; k++) {
        let s = segCursor - k;
        while (s < 0) s += MAX_SEG;
        let sPrev = s - 1;
        while (sPrev < 0) sPrev += MAX_SEG;
        // Row 0 = start rib, row 1 = end rib; ski 0, profile centre.
        const a1 = (s * VERTS_PER_SEG + 0 * P + centre) * 3;             // start of s
        const a0 = (sPrev * VERTS_PER_SEG + P + centre) * 3;             // end of s-1
        const e1 = (s * VERTS_PER_SEG + P + centre) * 3;                 // end of s
        if (pos[a1] === 0 && pos[a1 + 1] === 0 && pos[a1 + 2] === 0) { degenerate++; continue; }
        const dx = pos[a1] - pos[a0], dy = pos[a1 + 1] - pos[a0 + 1], dz = pos[a1 + 2] - pos[a0 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > 0.01) { gaps++; if (d > worst) worst = d; }
        const sx = pos[e1] - pos[a1], sy = pos[e1 + 1] - pos[a1 + 1], sz = pos[e1 + 2] - pos[a1 + 2];
        maxSpan = Math.max(maxSpan, Math.sqrt(sx * sx + sy * sy + sz * sz));
      }
      return { checked: n, gaps, degenerate, worstGap: +worst.toFixed(4),
               maxSegmentSpan: +maxSpan.toFixed(3), segments: segCount, liveHead };
    },

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
      uTrkTime.value = time;

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

      if (!haveLast) {
        lastPos.copy(p); lastCommit.copy(p); lastCommitHeading = state.heading;
        haveLast = true; needDeform = true;
      }

      const moved = tmp.copy(p).sub(lastPos).length();

      // Teleport / respawn: break the ribbon rather than stretching it. A
      // takeoff is a real end, but it is not a *square* one - the edge unweights
      // over the last few centimetres - so the ribbon is closed with a short
      // tapered segment instead of simply stopping mid-quad.
      if (moved > MAX_JUMP || state.airborne) {
        if (havePrev) closeRibbon();
        lastPos.copy(p); lastCommit.copy(p); lastCommitHeading = state.heading;
        havePrev = false; liveHead = false;
        needDeform = true;
        setDrawRange();
        return;
      }

      travelled += moved;
      lastPos.copy(p);

      // How is the trench being cut right now?
      const edgeAbs = Math.min(Math.abs(state.edge || 0), 1);
      const spd = state.speed || 0;
      let slip = 0;
      if (spd > 0.5) {
        tmp.copy(state.vel).normalize();
        slip = Math.abs(clamp(tmp.dot(right), -1, 1));
      }
      const brake = (state.input && state.input.brake) || 0;
      const skid = clamp(slip * 1.6 + brake * 0.85, 0, 1);
      const carve = clamp(edgeAbs * (1 - skid * 0.65), 0, 1);
      const gf = clamp((state.gForce || 0) / 2.2, 0, 1.2);

      // Carving cuts a clean narrow trench; skidding smears a wide shallow one.
      const width = 0.085 + skid * 0.105 + carve * 0.030;
      const depth = 0.030 + carve * 0.075 + skid * 0.016 + gf * 0.028;
      const spacing = 0.140 + skid * 0.050;
      // Even a straight run leaves a visible base track on a groomed piste; a
      // committed carve leaves a fully polished one.
      const compact = clamp(0.42 + carve * 0.50 + gf * 0.16 - skid * 0.08, 0.30, 1.0);

      // The rib at the ski *right now*, rebuilt every frame.
      buildRib(ribHead, p.x, p.z, spacing, width, depth);
      ribHead.along = travelled;
      ribHead.comp = compact;
      ribHead.halfW = width;
      ribHead.depth = depth;
      ribHead.skid = skid;
      ribHead.load = clamp(gf * 0.7 + carve * 0.5, 0, 1);

      if (!havePrev) {
        // Start of a ribbon: fade the very first rib in so it does not begin on
        // a hard transverse edge.
        const t = ribPrev; ribPrev = ribHead; ribHead = t;
        ribPrev.comp = compact * TAIL_TAPER;
        havePrev = true;
        liveHead = false;
        lastCommit.copy(p);
        lastCommitHeading = state.heading;
        stampContacts(p, spacing, width, depth, compact);
        setDrawRange();
        return;
      }

      // ---- commit test ------------------------------------------------------
      // Arc length OR heading change, whichever trips first. The second term is
      // what keeps the ribbon smooth at 50+ degrees of edge, where the contact
      // point is sweeping sideways: a fixed 0.28 m step samples that arc far too
      // coarsely and the quads visibly facet and pinch on the inside wall.
      const dCommit = tmp.copy(p).sub(lastCommit).length();
      let dYaw = state.heading - lastCommitHeading;
      while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
      while (dYaw < -Math.PI) dYaw += 2 * Math.PI;

      let committed = false;
      if (dCommit >= STEP || (dCommit >= STEP_MIN && Math.abs(dYaw) >= STEP_YAW)) {
        commitSegment(ribPrev, ribHead);
        const t = ribPrev; ribPrev = ribHead; ribHead = t;   // recycle, never alloc
        lastCommit.copy(p);
        lastCommitHeading = state.heading;
        stampContacts(p, spacing, width, depth, compact);
        committed = true;
      }

      // ---- live head --------------------------------------------------------
      // Between commits the ribbon would otherwise stop up to 28 cm behind the
      // ski, which from a chase camera is a visible gap between the ski tail and
      // the trench - the "skis read as floating" half of the defect. So the slot
      // the next commit will use is filled every frame with a provisional
      // segment running from the last committed rib to the ski. It costs one
      // segment upload per frame and is overwritten in place when the real
      // commit lands.
      //
      // On the frame the commit itself lands the head has just *become* the last
      // rib, so the provisional segment is written zero-length. That is not a
      // no-op: it scrubs whatever the ring buffer left in the newly vacated slot
      // from 600 m ago, which would otherwise flash for one frame.
      writeSegmentAt(segCursor, ribPrev, committed ? ribPrev : ribHead);
      liveHead = true;
      setDrawRange();
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
