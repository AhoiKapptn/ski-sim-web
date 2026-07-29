/**
 * Alpine — the snow shader.
 *
 * `createSnowMaterial(opts)` returns a MeshStandardMaterial that has been
 * surgically extended through `onBeforeCompile`, so it keeps three's full PBR
 * pipeline: IBL, shadow maps, tone mapping, the lot. On top of that it adds the
 * things that actually make snow look like snow rather than white paint:
 *
 *   - volumetric-ish subsurface: forward scatter (hot rim when the sun is low
 *     and behind), retro/back scatter (the "opposition surge" that makes fresh
 *     snow glow when the sun is over your shoulder), and a blue-violet
 *     multiple-scattering ambient so shadowed snow is never grey.
 *   - anisotropic GGX sheen aligned to the wind, for the satin streak you see
 *     on wind-packed piste.
 *   - triplanar multi-scale micro relief: metre drifts -> decimetre sastrugi ->
 *     millimetre grain, each faded by distance so nothing tiles or moires.
 *   - resolvable ice-crystal glitter: a world-space cell grid whose density
 *     tracks distance in power-of-two steps so glints stay ~3 px wide at any
 *     range and cross-fade instead of aliasing.
 *   - slope / curvature driven variation: scoured ice on convex wind lips,
 *     deep bright powder in hollows, wind-loaded pillows on lee aspects.
 *   - a slope+erosion driven rock blend with bedding strata and its own
 *     displacement, height-blended so snow tucks into ledges and cracks.
 *
 * Geometry is not this module's business. A caller (terrain.js) may inject a
 * vertex displacement program through `opts.displacement`; see the contract
 * near `buildVertexShader` below.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared value-noise lattice.
//
// A 256x256 R8 texture. The point of using a *table* rather than an arithmetic
// hash is that the CPU (physics) and the GPU (vertex displacement) can read
// exactly the same numbers, so `Terrain.height()` and the rendered mesh can
// never drift apart. It also sidesteps float32 precision loss in `fract(sin())`
// style hashes at kilometre-scale world coordinates.
// ---------------------------------------------------------------------------
const LATTICE_SIZE = 256;
let _lattice = null;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getLattice() {
  if (_lattice) return _lattice;
  const n = LATTICE_SIZE;
  const data = new Uint8Array(n * n);
  const rnd = mulberry32(0x5eed1);
  for (let i = 0; i < n * n; i++) data[i] = (rnd() * 256) | 0;
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _lattice = { data, tex, size: n };
  return _lattice;
}

/** CPU twin of the GLSL `latFetch()` — must stay bit-comparable. */
export function latticeValue(ix, iy) {
  const d = getLattice().data;
  return d[((iy & 255) << 8) | (ix & 255)] * (1 / 255);
}

// ---------------------------------------------------------------------------
// GLSL: value noise with analytic derivative, read from the lattice texture.
// Shared by the vertex (terrain displacement) and fragment (surface detail)
// stages, so it lives in one string.
// ---------------------------------------------------------------------------
export const GLSL_LATTICE_NOISE = /* glsl */`
uniform sampler2D uLattice;

float latFetch( ivec2 c ) {
  return texelFetch( uLattice, c & ivec2( 255 ), 0 ).r;
}

// returns ( value in 0..1, d/dx, d/dy )
vec3 latNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = p - i;
  vec2 u  = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  vec2 du = 30.0 * f * f * ( f * ( f - 2.0 ) + 1.0 );
  ivec2 ii = ivec2( i );
  float a = latFetch( ii );
  float b = latFetch( ii + ivec2( 1, 0 ) );
  float c = latFetch( ii + ivec2( 0, 1 ) );
  float d = latFetch( ii + ivec2( 1, 1 ) );
  float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  return vec3(
    a + k1 * u.x + k2 * u.y + k3 * u.x * u.y,
    ( k1 + k3 * u.y ) * du.x,
    ( k2 + k3 * u.x ) * du.y
  );
}
`;

// ---------------------------------------------------------------------------
// Fragment-side surface detail + snow BRDF.
// ---------------------------------------------------------------------------
const SNOW_FRAG_PRELUDE = /* glsl */`
uniform float uTime;
uniform vec2  uWindDir;        // unit vector in world XZ
uniform float uDetailStrength;
uniform float uSparkle;
uniform float uGrainFade;
uniform vec3  uSnowTint;       // sunlit albedo
uniform vec3  uShadeTint;      // multiple-scattering colour in shadow
uniform vec3  uSSSTint;        // forward-scatter colour
uniform vec3  uRockLo;
uniform vec3  uRockHi;
uniform vec3  uBedding;        // bedding-plane normal, world space
uniform float uRockAmount;
uniform vec3  uAerialColor;
uniform vec3  uAerialSun;
uniform vec3  uSunDirW;
uniform float uAerialDensity;
uniform float uAerialHeight;

varying vec3 vSnowWPos;
varying vec3 vSnowWNrm;
varying vec4 vSnowData;        // x slope01  y curvature  z flow  w rock-exposure

// --- small helpers ---------------------------------------------------------
float snLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

// Descending ramp: 1 near, 0 far. smoothstep() with edge0 > edge1 is formally
// undefined in GLSL, and this is used on every detail layer.
float snFade( float far, float near, float x ) {
  float t = clamp( ( far - x ) / ( far - near ), 0.0, 1.0 );
  return t * t * ( 3.0 - 2.0 * t );
}

// Integer hash — exact for the large cell indices the sparkle grid produces.
// A fract(sin()) hash collapses to a handful of distinct values out at a few
// kilometres from the origin and the glitter turns into visible stripes.
uvec3 snUHash( uvec3 x ) {
  x = x * 1664525u + 1013904223u;
  x.x += x.y * x.z; x.y += x.z * x.x; x.z += x.x * x.y;
  x ^= x >> 16u;
  x.x += x.y * x.z; x.y += x.z * x.x; x.z += x.x * x.y;
  return x;
}
vec3 hash33( vec3 p ) {
  return vec3( snUHash( uvec3( ivec3( p ) + 4194304 ) ) ) * ( 1.0 / 4294967296.0 );
}

// Multi-octave lattice fbm with derivative, in noise space.
vec3 snFbm( vec2 p, int oct, float gain ) {
  float s = 0.0, a = 1.0, nrm = 0.0;
  float jxx = 1.0, jxy = 0.0, jyx = 0.0, jyy = 1.0;
  vec2 g = vec2( 0.0 );
  vec2 q = p;
  const float C = 0.8, S = 0.6, LAC = 2.07;
  for ( int i = 0; i < 6; i ++ ) {
    if ( i >= oct ) break;
    vec3 n = latNoise( q );
    s += a * ( n.x * 2.0 - 1.0 );
    g.x += a * 2.0 * ( n.y * jxx + n.z * jyx );
    g.y += a * 2.0 * ( n.y * jxy + n.z * jyy );
    nrm += a;
    float nxx = LAC * ( C * jxx - S * jyx ), nxy = LAC * ( C * jxy - S * jyy );
    float nyx = LAC * ( S * jxx + C * jyx ), nyy = LAC * ( S * jxy + C * jyy );
    jxx = nxx; jxy = nxy; jyx = nyx; jyy = nyy;
    q = vec2( C * q.x - S * q.y, S * q.x + C * q.y ) * LAC;
    a *= gain;
  }
  return vec3( s / nrm, g / nrm );
}

// Ridged variant: 1 - |2n-1|, squared. Creases instead of lumps, which is what
// makes fractured rock read as rock and not as brown dough.
vec3 snRidged( vec2 p, int oct, float gain ) {
  float s = 0.0, a = 1.0, nrm = 0.0;
  float jxx = 1.0, jxy = 0.0, jyx = 0.0, jyy = 1.0;
  vec2 g = vec2( 0.0 );
  vec2 q = p;
  const float C = 0.8, S = 0.6, LAC = 2.11;
  for ( int i = 0; i < 4; i ++ ) {
    if ( i >= oct ) break;
    vec3 n = latNoise( q );
    float v = n.x * 2.0 - 1.0;
    float sg = v < 0.0 ? -1.0 : 1.0;
    float r = 1.0 - abs( v );
    float dr = -4.0 * r * sg;
    s += a * ( r * r - 0.33 );
    g.x += a * dr * ( n.y * jxx + n.z * jyx );
    g.y += a * dr * ( n.y * jxy + n.z * jyy );
    nrm += a;
    float nxx = LAC * ( C * jxx - S * jyx ), nxy = LAC * ( C * jxy - S * jyy );
    float nyx = LAC * ( S * jxx + C * jyx ), nyy = LAC * ( S * jxy + C * jyy );
    jxx = nxx; jxy = nxy; jyx = nyx; jyy = nyy;
    q = vec2( C * q.x - S * q.y, S * q.x + C * q.y ) * LAC;
    a *= gain;
  }
  return vec3( s / nrm, g / nrm );
}

/** Triplanar version of snRidged, for rock fracture relief. */
void fractureLayer( vec3 P, vec3 W, float freq, float amp, int oct, inout vec3 grad, inout float hgt ) {
  if ( amp < 1e-5 ) return;
  float k = amp * freq;
  if ( W.y > 0.004 ) {
    vec3 n = snRidged( P.xz * freq, oct, 0.5 );
    grad.x += W.y * k * n.y; grad.z += W.y * k * n.z; hgt += W.y * amp * n.x;
  }
  if ( W.z > 0.004 ) {
    vec3 n = snRidged( P.xy * freq, oct, 0.5 );
    grad.x += W.z * k * n.y; grad.y += W.z * k * n.z; hgt += W.z * amp * n.x;
  }
  if ( W.x > 0.004 ) {
    vec3 n = snRidged( P.zy * freq, oct, 0.5 );
    grad.z += W.x * k * n.y; grad.y += W.x * k * n.z; hgt += W.x * amp * n.x;
  }
}

/**
 * Triplanar detail layer. Accumulates the world-space gradient of a scalar
 * height field of amplitude 'amp' at spatial frequency 'freq'. 'aniso' squashes
 * the noise across the wind so features streak downwind (sastrugi).
 */
vec2 snWind;   // local wind direction; set per fragment before the layers run

void detailLayer( vec3 P, vec3 W, float freq, float amp, float aniso, int oct, inout vec3 grad, inout float hgt ) {
  if ( amp < 1e-5 ) return;
  float k = amp * freq;
  vec2 w = snWind;
  if ( W.y > 0.004 ) {
    vec2 p = P.xz * freq;
    if ( aniso > 0.98 ) {
      // Isotropic: do NOT route through the wind frame. It is only a rotation,
      // but the wind direction varies across the surface, so it would warp the
      // noise into fingerprint whorls.
      vec3 n = snFbm( p, oct, 0.55 );
      grad.x += W.y * k * n.y;  grad.z += W.y * k * n.z;
      hgt += W.y * amp * n.x;
    } else {
      // Compress *along* the wind so features stretch out downwind. Sastrugi
      // are long in the direction the wind blew, not across it.
      vec2 q = vec2( dot( p, w ) * aniso, dot( p, vec2( -w.y, w.x ) ) );
      vec3 n = snFbm( q, oct, 0.55 );
      vec2 gg = vec2( n.y * aniso, n.z );
      grad.x += W.y * k * ( gg.x * w.x - gg.y * w.y );
      grad.z += W.y * k * ( gg.x * w.y + gg.y * w.x );
      hgt += W.y * amp * n.x;
    }
  }
  if ( W.z > 0.004 ) {
    vec3 n = snFbm( P.xy * freq, oct, 0.55 );
    grad.x += W.z * k * n.y;  grad.y += W.z * k * n.z;
    hgt += W.z * amp * n.x;
  }
  if ( W.x > 0.004 ) {
    vec3 n = snFbm( P.zy * freq, oct, 0.55 );
    grad.z += W.x * k * n.y;  grad.y += W.x * k * n.z;
    hgt += W.x * amp * n.x;
  }
}

/**
 * Ice-crystal glitter. The cell grid is quantised to powers of two of the view
 * distance so each cell stays roughly a constant number of pixels across; two
 * adjacent octaves cross-fade, which is what stops the sparkle turning into
 * white noise in the distance.
 */
float snGlint( vec3 P, vec3 N, vec3 H, float dist, float seed ) {
  vec3 c = floor( P * ( 1.0 / max( dist * 0.0055, 0.0035 ) ) + seed * 37.0 );
  vec3 r = hash33( c );
  if ( r.z < 0.972 ) return 0.0;              // only a few facets are aimed at us
  vec3 fn = normalize( N * 0.85 + ( r * 2.0 - 1.0 ) * 0.62 );
  float s = max( dot( fn, H ), 0.0 );
  float tw = 0.45 + 0.55 * sin( uTime * 3.1 + r.x * 41.0 );
  return pow( s, 380.0 ) * tw;
}

float snSparkle( vec3 P, vec3 N, vec3 H, float dist ) {
  float l = log2( max( dist, 1.0 ) );
  float lf = floor( l );
  float t = l - lf;
  float d0 = exp2( lf ), d1 = d0 * 2.0;
  return snGlint( P, N, H, d0, lf ) * ( 1.0 - t ) + snGlint( P, N, H, d1, lf + 1.0 ) * t;
}

// GGX with a wind-aligned anisotropic lobe.
float snAnisoGGX( vec3 N, vec3 T, vec3 B, vec3 H, float ax, float ay ) {
  if ( dot( T, T ) < 0.5 ) return 0.0;   // degenerate tangent frame
  float ht = dot( H, T ) / ax;
  float hb = dot( H, B ) / ay;
  float hn = dot( H, N );
  float d = ht * ht + hb * hb + hn * hn;
  return 1.0 / ( PI * ax * ay * d * d + 1e-4 );
}
`;

// The big per-pixel surface evaluation. Injected in place of
// <roughnessmap_fragment> so it can rewrite diffuseColor and roughnessFactor,
// and stash the shading normal for <normal_fragment_begin>.
const SNOW_SURFACE = /* glsl */`
float roughnessFactor = roughness;
vec3  snNormalW;
float snRockMask;
float snIce;
float snPowder;
float snViewDist;
float snMicroAO = 1.0;

{
  vec3 P  = vSnowWPos;
  vec3 Ng = normalize( vSnowWNrm );
  snViewDist = length( P - cameraPosition );

  float slope  = clamp( 1.0 - Ng.y, 0.0, 1.0 );            // 0 flat .. 1 vertical
  // Coarse (LOD-stable) inclination from the vertex program, nudged by the
  // real one so metre-scale steps can still expose rock up close.
  float steep  = mix( vSnowData.x, acos( clamp( Ng.y, -1.0, 1.0 ) ), 0.32 );
  float dFar   = snFade( 2600.0, 700.0, snViewDist );        // 1 near, 0 far
  float curv   = vSnowData.y * dFar;
  float flow   = vSnowData.z;
  float expo   = vSnowData.w;

  // Wind is not a constant: it wraps round spurs and pours through cols. A
  // slow rotation field keeps the sastrugi from looking combed with a rake.
  vec3 wv = snFbm( P.xz * 0.0011, 2, 0.5 );
  float wa = wv.x * 0.55;
  float wc = cos( wa ), ws = sin( wa );
  snWind = normalize( vec2( uWindDir.x * wc - uWindDir.y * ws,
                            uWindDir.x * ws + uWindDir.y * wc ) );

  // Aspect relative to the prevailing wind: windward gets scoured, lee loaded.
  float aspect = dot( normalize( Ng.xz + vec2( 1e-5 ) ), snWind );
  float lee    = clamp( -aspect * sqrt( slope ) * 2.4, 0.0, 1.0 );
  float wind   = clamp(  aspect * sqrt( slope ) * 2.4, 0.0, 1.0 );

  // --------------------------------------------------------------- rock ----
  // Bedrock shows where the slope beats the angle snow can hold, and where the
  // erosion sim already stripped the mantle. Perturbed so the snowline is ragged.
  float rockNear = snFade( 1600.0, 320.0, snViewDist );
  vec3 rn  = snFbm( P.xz * 0.021, 3, 0.5 );
  vec3 rn2 = snFbm( P.xz * 0.0047, 3, 0.5 );
  float talus = 0.71 + rn.x * 0.14 + rn2.x * 0.12 - expo * 0.30;   // ~41 deg nominal
  float rockRaw = ( steep - talus ) * 4.2;

  // Rock micro-relief. Fractures (ridged, so they read as edges rather than
  // lumps) carry the structure; bedding strata ride on top of them. The strata
  // deliberately do *not* feed the snow/rock mask — banded bedrock is right,
  // a banded snowline is a contour map.
  vec3 rGrad = vec3( 0.0 );
  float rH = 0.0, rFrac = 0.0;
  vec3 rw = pow( abs( Ng ), vec3( 3.0 ) );
  rw /= ( rw.x + rw.y + rw.z );
  // Ledge scale — the only band allowed to steer the snowline.
  fractureLayer( P, rw, 0.048, 0.62 * rockNear, 3, rGrad, rH );
  // Structure scale — buttresses, slabs, cracks. Pure appearance.
  fractureLayer( P, rw, 0.23,  0.105 * rockNear, 3, rGrad, rFrac );
  fractureLayer( P, rw, 1.10,  0.024 * rockNear, 3, rGrad, rFrac );
  fractureLayer( P, rw, 4.60,  0.0055 * snFade( 220.0, 40.0, snViewDist ), 2, rGrad, rFrac );

  // Height-blend: snow settles into the low spots of the rock, so the boundary
  // follows real ledges instead of a soft lerp.
  snRockMask = smoothstep( -0.62, 0.62, rockRaw + rH * 1.5 ) * uRockAmount;
  rH += rFrac;

  vec3 bw = snFbm( P.xz * 0.0016, 2, 0.5 );
  float bed = dot( P, uBedding ) * ( 0.030 + 0.014 * bw.x );
  vec3 bn = snFbm( vec2( bed * 2.4, dot( P.xz, vec2( 0.021, -0.014 ) ) ), 3, 0.5 );
  float strata = sin( bed * 6.2831 + bn.x * 3.4 );
  strata = sign( strata ) * pow( abs( strata ), 0.62 ) * rockNear;
  rH += strata * 0.22;

  // --------------------------------------------------------------- snow ----
  // Multi-scale relief. Everything is faded by view distance so the far field
  // never carries sub-pixel noise (that is where moire comes from).
  vec3 sw = pow( abs( Ng ), vec3( 4.0 ) );
  sw /= ( sw.x + sw.y + sw.z );

  float fDrift  = snFade( 1800.0, 420.0, snViewDist );
  float fDune   = snFade(  380.0,  90.0, snViewDist );
  float fRipple = snFade(  110.0,  18.0, snViewDist );
  float fGrain  = snFade(   18.0,   2.5, snViewDist ) * uGrainFade;

  // Wind loading: pillows on the lee, hard scoured ripple on the windward side.
  float loadA = 0.55 + 0.85 * lee;
  float scour = 0.35 + 1.15 * wind;

  vec3 grad = vec3( 0.0 );
  float relief = 0.0, fine = 0.0;
  // Hectometre band: only switched on in the far field, where the clipmap
  // geometry is 100 m per cell and the faces would otherwise be flat card.
  float fFar = smoothstep( 500.0, 1500.0, snViewDist );
  detailLayer( P, sw, 0.010, 4.5 * fFar, 1.0, 3, grad, relief );
  detailLayer( P, sw, 0.085, 1.25 * fDrift * loadA, 1.0, 4, grad, relief );
  detailLayer( P, sw, 0.42,  0.27 * fDrift * loadA, 0.86, 3, grad, relief );
  // The sub-metre bands are tracked separately: their pits are what carry the
  // micro-occlusion that stops snow reading as a painted surface.
  detailLayer( P, sw, 1.55,  0.072 * fDune * scour, 0.56, 3, grad, fine );
  detailLayer( P, sw, 6.20,  0.0190 * fRipple * scour, 0.22, 3, grad, fine );
  detailLayer( P, sw, 30.0,  0.0026 * fGrain, 0.8, 2, grad, fine );
  float fineNorm = fine / max( 0.072 * fDune + 0.0190 * fRipple + 0.0026 * fGrain, 1e-4 );
  snMicroAO = clamp( 1.0 - 0.30 * clamp( 0.45 - fineNorm * 0.75, 0.0, 1.0 )
                       - 0.16 * clamp( -relief * 1.6, 0.0, 1.0 ), 0.55, 1.0 );
  relief += fine;

  // Convex wind lips get scoured to ice; hollows collect powder.
  snIce = clamp( ( curv * 1.5 + wind * 0.55 - 0.22 ) * 1.6 + relief * 0.5, 0.0, 1.0 );
  snIce = smoothstep( 0.18, 0.85, snIce ) * smoothstep( 0.06, 0.30, slope ) * dFar;
  snPowder = clamp( -curv * 1.9 + lee * 0.5 + flow * 0.45, 0.0, 1.0 );

  // Surface-gradient normal perturbation (correct on steeps, no UV stretch).
  vec3 g = mix( grad, rGrad * 1.5, snRockMask );
  g -= Ng * dot( g, Ng );
  float ds = uDetailStrength * mix( 1.0, 0.72, snIce );
  snNormalW = normalize( Ng - g * ds );

  // ------------------------------------------------------------- albedo ----
  // Snow albedo is high and slightly blue; grain size (powder vs. wind slab)
  // moves it a couple of percent, which is all the variation real snow has.
  // The visible variation has to come from normals and scattering, not paint.
  vec3 snowAlb = uSnowTint;
  snowAlb = mix( snowAlb, uSnowTint * vec3( 0.93, 0.96, 1.03 ), snIce );
  snowAlb = mix( snowAlb, uSnowTint * vec3( 1.02, 1.02, 1.03 ), snPowder * 0.6 );

  // Everything that bands with altitude must vanish with distance or it turns
  // the far peaks into a topographic map.
  float bandMix = clamp( 0.5 + ( strata * 0.42 + bn.x * 0.30 ) * rockNear, 0.0, 1.0 );
  vec3 rockAlb = mix( uRockLo, uRockHi, bandMix );
  // Cracks go near-black; the faces catch the light. This contrast is most of
  // what separates rock from clay.
  rockAlb *= 0.20 + 1.15 * clamp( rFrac * 5.5 + 0.62, 0.0, 1.0 );
  rockAlb = mix( rockAlb, rockAlb * vec3( 1.14, 1.0, 0.82 ), clamp( rn2.x * 0.5 + 0.5, 0.0, 1.0 ) * rockNear );

  diffuseColor.rgb = mix( snowAlb, rockAlb, snRockMask );

  // Wind slab vs. soft snow patchiness at ~200 m, so a whole face is never one
  // uniform material.
  float slab = wv.x * 0.5 + 0.5;
  float snowRough = mix( 0.84, 0.32, snIce ) - slab * 0.13;
  snowRough = mix( snowRough, 0.92, snPowder * 0.55 );
  snowRough -= 0.10 * fGrain;
  roughnessFactor = mix( clamp( snowRough, 0.16, 0.97 ), 0.88, snRockMask );
  // Distance-based specular anti-aliasing. Once a square metre of surface is
  // smaller than a pixel, a tight lobe can only shimmer; widen it instead.
  roughnessFactor = max( roughnessFactor, 0.72 * smoothstep( 400.0, 1600.0, snViewDist ) );
}
`;

const SNOW_NORMAL = /* glsl */`
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = normalize( ( viewMatrix * vec4( snNormalW, 0.0 ) ).xyz );
vec3 nonPerturbedNormal = normalize( ( viewMatrix * vec4( normalize( vSnowWNrm ), 0.0 ) ).xyz );
`;

// Extra scattering terms, folded in after three has finished its own lighting.
const SNOW_SCATTER = /* glsl */`
#if NUM_DIR_LIGHTS > 0
{
  vec3 L = normalize( directionalLights[ 0 ].direction );
  vec3 C = directionalLights[ 0 ].color;
  vec3 V = normalize( vViewPosition );
  vec3 N = normal;
  float ndl = dot( N, L );

  // Recover the shadow term from what three already accumulated. Cheap, and it
  // does not depend on the internals of <lights_fragment_begin>.
  float expct = max( ndl, 0.0 ) * snLum( C ) * snLum( diffuseColor.rgb ) * RECIPROCAL_PI;
  float shd = expct > 1e-6 ? clamp( snLum( reflectedLight.directDiffuse ) / expct, 0.0, 1.0 ) : 0.0;

  float snowness = 1.0 - snRockMask;

  // Forward scatter: light that entered the pack and came out towards the eye.
  // Peaks when the sun is roughly behind the surface from the viewer.
  float fw = max( dot( V, -L ), 0.0 );
  float thin = mix( 0.35, 1.0, snPowder ) * ( 0.35 + 0.65 * ( 1.0 - abs( ndl ) ) );
  vec3 sss = uSSSTint * C * ( pow( fw, 4.0 ) * 0.55 + pow( fw, 12.0 ) * 1.2 ) * thin * shd * snowness;

  // Retro / opposition surge: snow is strongly backscattering.
  float bs = pow( max( dot( V, L ), 0.0 ), 2.2 );
  vec3 retro = C * bs * max( ndl, 0.0 ) * 0.30 * snowness * shd;

  // Wrap term so the terminator is soft rather than a hard lambert edge.
  float wrap = max( ( ndl + 0.32 ) / 1.32, 0.0 ) - max( ndl, 0.0 );
  vec3 wrapL = C * wrap * uSSSTint * 0.42 * snowness * shd;

  reflectedLight.directDiffuse += ( sss + retro + wrapL ) * diffuseColor.rgb;

  // Anisotropic wind-packed sheen.
  vec3 Wt = normalize( vec3( uWindDir.x, 0.0, uWindDir.y ) );
  vec3 Tw = normalize( ( viewMatrix * vec4( Wt, 0.0 ) ).xyz );
  vec3 Tr = Tw - N * dot( Tw, N );
  vec3 T = dot( Tr, Tr ) > 1e-6 ? normalize( Tr ) : vec3( 0.0 );
  vec3 B = cross( N, T );
  vec3 H = normalize( L + V );
  float ar = mix( 0.30, 0.09, snIce );
  float d = min( snAnisoGGX( N, T, B, H, ar * 2.4, ar * 0.42 ), 60.0 );
  float fres = 0.028 + 0.972 * pow( 1.0 - max( dot( V, H ), 0.0 ), 5.0 );
  reflectedLight.directSpecular += C * shd * max( ndl, 0.0 ) * d * fres * 0.55 * snowness;

  // Ice crystals. Deliberately over-bright — these want to clip to white points
  // — but clamped and pushed towards neutral, because ACES turns an unbounded
  // strongly-tinted highlight into a coloured speck rather than a white one.
  float sp = clamp( snSparkle( vSnowWPos, N, H, snViewDist ), 0.0, 1.0 );
  float spFade = snFade( 260.0, 45.0, snViewDist );
  vec3 spColor = mix( C, vec3( snLum( C ) ), 0.6 );
  reflectedLight.directSpecular += spColor * min( sp * uSparkle, 45.0 ) * spFade * shd
    * snowness * ( 0.35 + 0.65 * max( ndl, 0.0 ) ) * mix( 1.0, 1.7, snIce );

  // Sky-lit snow is blue-violet, not grey. Tint the indirect term by how
  // shadowed we are, and add the multiple-scattering bounce snow is famous for.
  float lit = clamp( shd * max( ndl, 0.0 ) * 1.6, 0.0, 1.0 );
  vec3 tint = mix( uShadeTint, vec3( 1.0 ), lit );
  // Pits between sastrugi occlude the (warm, collimated) sun far more than the
  // (blue, hemispherical) sky. Attenuating the two by the *same* factor just
  // makes grey dents; attenuating them differently is what turns every
  // centimetre-scale hollow blue, which is the look we are after.
  float pit = clamp( 1.0 - snMicroAO, 0.0, 1.0 );
  vec3 pitTint = mix( vec3( 1.0 ), uShadeTint, clamp( pit * 1.5, 0.0, 1.0 ) * snowness );
  reflectedLight.indirectDiffuse *= mix( vec3( 1.0 ), tint, snowness )
    * pitTint * ( 1.0 - 0.30 * pit );
  // Snow in shadow is *bright* — it sees the whole sky dome and eats bounce
  // from every lit slope around it. Without this term, shadowed snow crushes
  // to a dark saturated violet, which is the single most common tell of a
  // shader that treated snow as an opaque diffuse surface.
  reflectedLight.indirectDiffuse += diffuseColor.rgb * uShadeTint * snowness
    * ( 0.08 + 0.40 * ( 1.0 - lit ) );
  reflectedLight.directDiffuse *= snMicroAO * mix( 1.0, snMicroAO, 0.6 );
}
#endif
`;

// Height-attenuated aerial perspective, applied in linear HDR before tone
// mapping. Density falls off with altitude so distant summits float above the
// haze instead of dissolving into it the way uniform exp2 fog makes them.
const SNOW_AERIAL = /* glsl */`
{
  vec3 d = vSnowWPos - cameraPosition;
  float dist = length( d );
  float Hs = uAerialHeight;
  float e0 = exp( -max( cameraPosition.y, -200.0 ) / Hs );
  float e1 = exp( -max( vSnowWPos.y, -200.0 ) / Hs );
  float dy = d.y;
  float t = abs( dy ) < 1.0 ? dist * e0 : dist * Hs / dy * ( e0 - e1 );
  float f = 1.0 - exp( -uAerialDensity * max( t, 0.0 ) );
  vec3 rd = d / max( dist, 1e-4 );
  float sunAmt = pow( max( dot( rd, uSunDirW ), 0.0 ), 8.0 );
  vec3 air = mix( uAerialColor, uAerialSun, sunAmt * 0.75 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, air, clamp( f, 0.0, 1.0 ) );
}
`;

// ---------------------------------------------------------------------------
function buildVertexShader( displacement ) {
  // Contract for `displacement`:
  //   .prelude  extra uniforms / functions
  //   .body     given `vec3 wpos` (world position of the undisplaced vertex,
  //             y == 0) it must assign:
  //                 float dspH;   world height
  //                 vec3  dspN;   world normal
  //                 vec4  dspD;   ( slope01, curvature, flow, rockExposure )
  //                 float dspSkirt; downward offset for LOD skirts
  // Note on ordering: three emits <beginnormal_vertex>/<defaultnormal_vertex>
  // *before* <begin_vertex>, and the depth material emits neither of the
  // former. The displacement therefore lives in a function guarded by a
  // run-once flag, and every hook simply calls it.
  return {
    prelude: /* glsl */`
varying vec3 vSnowWPos;
varying vec3 vSnowWNrm;
varying vec4 vSnowData;
${displacement ? displacement.prelude : ''}
${displacement ? /* glsl */`
float dspH; vec3 dspN; vec4 dspD; float dspSkirt;
bool dspDone = false;
void dspEval() {
  if ( dspDone ) return;
  dspDone = true;
  vec3 wpos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
${displacement.body}
  vSnowWPos = vec3( wpos.x, dspH, wpos.z );
  vSnowWNrm = dspN;
  vSnowData = dspD;
}
` : ''}
`,
    beginNormal: displacement ? 'dspEval();\nvec3 objectNormal = dspN;\n' : null,
    normal: displacement
      ? 'vec3 transformedNormal = normalize( ( viewMatrix * vec4( dspN, 0.0 ) ).xyz );\n'
      : null,
    begin: displacement
      ? 'dspEval();\nvec3 transformed = vec3( position.x, dspH - dspSkirt, position.z );\n'
      : /* glsl */`
#include <begin_vertex>
vSnowWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vSnowWNrm = normalize( mat3( modelMatrix ) * normal );
vSnowData = vec4( clamp( 1.0 - vSnowWNrm.y, 0.0, 1.0 ), 0.0, 0.0, 0.0 );
`,
  };
}

let _cacheKey = 0;

/**
 * @param {object} opts
 * @param {object} [opts.displacement]  GLSL geometry hook (see buildVertexShader)
 * @param {boolean} [opts.rock=true]
 * @param {object} [opts.uniforms]      extra uniforms merged into the program
 */
export function createSnowMaterial(opts = {}) {
  const {
    displacement = null,
    rock = true,
    uniforms: extraUniforms = {},
    ...matOpts
  } = opts;

  const lattice = getLattice();

  const uniforms = {
    uLattice: { value: lattice.tex },
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.82, 0.57) },
    uDetailStrength: { value: 1.7 },
    uSparkle: { value: 110.0 },
    uGrainFade: { value: 1.0 },
    uSnowTint: { value: new THREE.Color(0.64, 0.675, 0.745) },
    uShadeTint: { value: new THREE.Color(0.60, 0.71, 1.14) },
    uSSSTint: { value: new THREE.Color(0.86, 0.92, 1.0) },
    uRockLo: { value: new THREE.Color(0.018, 0.018, 0.021) },
    uRockHi: { value: new THREE.Color(0.112, 0.109, 0.107) },
    uBedding: { value: new THREE.Vector3(0.22, 0.94, -0.26).normalize() },
    uRockAmount: { value: rock ? 1.0 : 0.0 },
    uAerialColor: { value: new THREE.Color(0.34, 0.47, 0.70) },
    uAerialSun: { value: new THREE.Color(0.86, 0.84, 0.78) },
    uSunDirW: { value: new THREE.Vector3(-0.5, 0.7, 0.45).normalize() },
    uAerialDensity: { value: 0.00042 },
    uAerialHeight: { value: 1500 },
    ...extraUniforms,
    ...(displacement ? displacement.uniforms : {}),
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.75,
    metalness: 0.0,
    dithering: true,
    ...matOpts,
  });
  material.fog = false; // we run our own height-attenuated aerial perspective

  const vs = buildVertexShader(displacement);
  const key = 'snow' + (_cacheKey++);

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    // ---- vertex ----
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + GLSL_LATTICE_NOISE + vs.prelude)
      .replace('#include <begin_vertex>', vs.begin);
    if (vs.normal) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <beginnormal_vertex>', vs.beginNormal)
        .replace('#include <defaultnormal_vertex>', vs.normal);
    }

    // ---- fragment ----
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_LATTICE_NOISE + SNOW_FRAG_PRELUDE)
      .replace('#include <roughnessmap_fragment>', SNOW_SURFACE + '\n')
      .replace('#include <normal_fragment_begin>', SNOW_NORMAL)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + SNOW_SCATTER)
      .replace('#include <tonemapping_fragment>', SNOW_AERIAL + '\n#include <tonemapping_fragment>');
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => key;

  material.userData.snowUniforms = uniforms;

  /**
   * Matching depth material — without it the shadow pass would sample the
   * undisplaced flat plane and the terrain would shadow itself into garbage.
   */
  material.userData.createDepthMaterial = () => {
    const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    dm.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + GLSL_LATTICE_NOISE + vs.prelude)
        .replace('#include <begin_vertex>', vs.begin);
    };
    dm.customProgramCacheKey = () => key + '_depth';
    return dm;
  };

  return material;
}
