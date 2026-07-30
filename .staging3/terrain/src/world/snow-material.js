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
uniform vec3  uRockLo;         // joint / crack shadow
uniform vec3  uRockHi;         // lit granite face
uniform vec3  uRockWarm;       // lit limestone face
uniform vec3  uRockIron;       // oxide staining
uniform vec3  uRockLichen;     // crustose lichen
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

/**
 * Triplanar weights from |N|.
 *
 * The exponent is the whole ball game. A *high* exponent (4, 8) collapses the
 * blend to a single plane, and on a 60-degree face that plane is XZ — which
 * foreshortens the world-space sample by cos(theta) along the fall line and
 * therefore stretches every feature 2:1 down the slope. Stack five such layers
 * and the face comes out combed, which is exactly the "brushed metal" smear.
 * Weighting by |N| itself (exponent ~1) is the geometrically honest blend: at 45
 * degrees the two planes contribute equally, and the plane that contains Y
 * carries un-stretched detail.
 *
 * The cutoff is what keeps this affordable: on the near-flat piste the side
 * planes weigh < 3% and are skipped entirely, so the expensive near field still
 * costs one fbm per layer.
 */
vec3 snTriW( vec3 N, float e ) {
  vec3 w = pow( abs( N ), vec3( e ) );
  return w / ( w.x + w.y + w.z );
}
#define SN_TRI_CUT 0.028

/** Triplanar version of snRidged, for rock fracture relief. */
void fractureLayer( vec3 P, vec3 W, float freq, float amp, int oct, inout vec3 grad, inout float hgt ) {
  if ( amp < 1e-5 ) return;
  float k = amp * freq;
  if ( W.y > SN_TRI_CUT ) {
    vec3 n = snRidged( P.xz * freq, oct, 0.5 );
    grad.x += W.y * k * n.y; grad.z += W.y * k * n.z; hgt += W.y * amp * n.x;
  }
  if ( W.z > SN_TRI_CUT ) {
    vec3 n = snRidged( P.xy * freq, oct, 0.5 );
    grad.x += W.z * k * n.y; grad.y += W.z * k * n.z; hgt += W.z * amp * n.x;
  }
  if ( W.x > SN_TRI_CUT ) {
    vec3 n = snRidged( P.zy * freq, oct, 0.5 );
    grad.z += W.x * k * n.y; grad.y += W.x * k * n.z; hgt += W.x * amp * n.x;
  }
}

/**
 * Triplanar detail layer. Accumulates the world-space gradient of a scalar
 * height field of amplitude 'amp' at spatial frequency 'freq'.
 *
 * 'aniso' squashes the noise across the local wind so features streak downwind
 * (sastrugi); 'rot' turns that frame by a fixed angle. Every band gets a
 * *different* rot, so the bands cannot conspire into one global grain — which is
 * what turned the whole snowfield into brushed metal. Real sastrugi, barchans
 * and wind ripples are not co-aligned either: the ripples answer to the surface
 * wind of the last hour, the drifts to the storm that built them.
 *
 * aniso is also clamped well away from the old 0.22 (a 4.5:1 stretch). Past
 * about 1.8:1 a lattice fbm stops reading as a wind feature and starts reading
 * as a brush stroke.
 */
vec2 snWind;   // local wind direction; set per fragment before the layers run

void detailLayer( vec3 P, vec3 W, float freq, float amp, float aniso, float rot, int oct, inout vec3 grad, inout float hgt ) {
  if ( amp < 1e-5 ) return;
  float k = amp * freq;
  if ( W.y > SN_TRI_CUT ) {
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
      float cr = cos( rot ), sr = sin( rot );
      vec2 w = vec2( snWind.x * cr - snWind.y * sr, snWind.x * sr + snWind.y * cr );
      vec2 q = vec2( dot( p, w ) * aniso, dot( p, vec2( -w.y, w.x ) ) );
      vec3 n = snFbm( q, oct, 0.55 );
      vec2 gg = vec2( n.y * aniso, n.z );
      grad.x += W.y * k * ( gg.x * w.x - gg.y * w.y );
      grad.z += W.y * k * ( gg.x * w.y + gg.y * w.x );
      hgt += W.y * amp * n.x;
    }
  }
  if ( W.z > SN_TRI_CUT ) {
    vec3 n = snFbm( P.xy * freq, oct, 0.55 );
    grad.x += W.z * k * n.y;  grad.y += W.z * k * n.z;
    hgt += W.z * amp * n.x;
  }
  if ( W.x > SN_TRI_CUT ) {
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
float snRockAO = 1.0;
float snSpecTint = 1.0;

{
  vec3 P  = vSnowWPos;
  vec3 Ng = normalize( vSnowWNrm );
  vec4 snData = vSnowData;
  snViewDist = length( P - cameraPosition );

  // Hook for the terrain module: re-reconstructs the macro field per pixel so
  // that out where the mesh is 25-100 m per cell, neither the shading normal nor
  // the terrain data channels are hostage to the tessellation.
  /*__TERRAIN_REFINE__*/

  float slope  = clamp( 1.0 - Ng.y, 0.0, 1.0 );            // 0 flat .. 1 vertical
  // Coarse (LOD-stable) inclination from the vertex program, nudged by the
  // real one so metre-scale steps can still expose rock up close.
  float steep  = mix( snData.x, acos( clamp( Ng.y, -1.0, 1.0 ) ), 0.32 );
  float dFar   = snFade( 5200.0, 900.0, snViewDist );        // 1 near, 0 far
  float curv   = snData.y * dFar;
  // The rock masks want curvature alive all the way to the horizon — it is what
  // wedges snow into the ledges — so they get their own, much longer, ramp.
  float curvR  = snData.y * snFade( 11000.0, 1800.0, snViewDist );
  float flow   = snData.z;
  float expo   = snData.w;

  // Wind is not a constant: it wraps round spurs and pours through cols. A
  // slow rotation field keeps the sastrugi from looking combed with a rake.
  //
  // The old field turned by +-0.55 rad over a ~900 m period, which is far too
  // lazy: inside one screenful of near-field snow it is effectively constant, so
  // every wind-aligned band came out parallel and the piste read as brushed
  // metal. Two octaves — a synoptic one and a 130 m terrain-scale one — and a
  // full +-1.2 rad swing mean the grain has visibly turned by the time you have
  // crossed a drift, which is what it does on real wind-packed snow.
  vec3 wv  = snFbm( P.xz * 0.0011, 2, 0.5 );
  vec3 wv2 = snFbm( P.xz * 0.0077 + vec2( 19.3, -7.1 ), 2, 0.5 );
  float wa = wv.x * 0.80 + wv2.x * 0.44;
  float wc = cos( wa ), ws = sin( wa );
  snWind = normalize( vec2( uWindDir.x * wc - uWindDir.y * ws,
                            uWindDir.x * ws + uWindDir.y * wc ) );

  // Aspect relative to the prevailing wind: windward gets scoured, lee loaded.
  float aspect = dot( normalize( Ng.xz + vec2( 1e-5 ) ), snWind );
  float lee    = clamp( -aspect * sqrt( slope ) * 2.4, 0.0, 1.0 );
  float wind   = clamp(  aspect * sqrt( slope ) * 2.4, 0.0, 1.0 );

  // --------------------------------------------------------------- rock ----
  // Rock relief runs as a band cascade rather than one blob with a single fade.
  // Each band is switched off only once its own features drop below a couple of
  // pixels, so a face at 4 km still has 20 m ledges and 80 m buttresses on it
  // instead of collapsing to the flat clay grey that a single 'fade to nothing'
  // always produces.
  float fRk0 = 1.0;                                        // ~80 m, to the horizon
  float fRk1 = snFade( 9000.0, 2600.0, snViewDist );       // ~20 m
  float fRk2 = snFade( 3400.0,  800.0, snViewDist );       // ~4 m
  float fRk3 = snFade(  950.0,  200.0, snViewDist );       // ~1 m
  float fRk4 = snFade(  200.0,   32.0, snViewDist );       // ~0.2 m

  vec3 rn  = snFbm( P.xz * 0.021, 3, 0.5 );
  vec3 rn2 = snFbm( P.xz * 0.0047, 3, 0.5 );

  vec3 rGrad = vec3( 0.0 );
  float rLedge = 0.0, rFrac = 0.0, rB0 = 0.0, rB1 = 0.0;
  // Rock lives on 50-80 degree faces, where a planar XZ projection stretches
  // every crack 2-5:1 down the fall line. This is the layer that was combing the
  // valley walls, so it gets the most honest weighting of all.
  vec3 rw = snTriW( Ng, 1.15 );
  // Buttress and ledge scales — the two bands allowed to steer the snowline.
  // Their amplitudes are metres, sized so that amp*freq matches the finer bands
  // and the face keeps the same apparent roughness at every range. That is far
  // too much *height* for the snowline blend, though, so only a scaled fraction
  // is handed on to it.
  // These two are the only *un-stretched* structure a steep face gets. A
  // heightfield displaced in XZ smears its own detail by 1/cos(theta) down the
  // fall line — 2.4:1 on a 65 degree wall — and no amount of triplanar weighting
  // in the shader can un-do geometry. What it can do is out-vote it: the
  // triplanar bands at 80 m and 20 m sit exactly on the scales that were combed,
  // and carrying more of the relief here and less in the vertex program is what
  // turns the wall from corduroy back into rock.
  fractureLayer( P, rw, 0.0125, 10.5 * fRk0, 2, rGrad, rB0 );
  fractureLayer( P, rw, 0.048,  2.7 * fRk1, 3, rGrad, rB1 );
  rLedge = rB0 * 0.020 + rB1 * 0.145;
  // Structure scale — slabs, joints, cracks. Pure appearance.
  fractureLayer( P, rw, 0.23,   0.105 * fRk2, 3, rGrad, rFrac );
  fractureLayer( P, rw, 1.10,   0.024 * fRk3, 3, rGrad, rFrac );
  fractureLayer( P, rw, 4.60,   0.0055 * fRk4, 2, rGrad, rFrac );

  // Fractured facets. Rock parts along its joint sets into flat plates with hard
  // edges; smooth noise alone can only make dough. Two world-scale cell grids,
  // each retired once its plates fall under a few pixels, tilt the normal by a
  // per-cell constant — flat inside, discontinuous at the joint.
  // The grid is sheared and non-cubic so the plates read as joint blocks rather
  // than as voxels, and the tilt is kept modest — enough to break the light
  // across a face, not enough to look quarried by Minecraft.
  vec3 facet = vec3( 0.0 );
  vec3 fp = vec3( P.x * 0.97 + P.z * 0.24, P.y * 1.35, P.z * 0.97 - P.x * 0.24 );
  float fFacetA = snFade( 2600.0, 500.0, snViewDist );
  if ( fFacetA > 0.01 ) {
    facet += ( hash33( floor( fp * 0.105 + 0.5 ) ) * 2.0 - 1.0 ) * 0.20 * fFacetA;
  }
  float fFacetB = snFade( 460.0, 70.0, snViewDist );
  if ( fFacetB > 0.01 ) {
    facet += ( hash33( floor( fp * 0.52 + 17.0 ) ) * 2.0 - 1.0 ) * 0.13 * fFacetB;
  }

  // --- bedding ---------------------------------------------------------------
  // A tilted plane family whose dip and thickness both wander, so the massif
  // reads as folded sedimentary rock rather than as a contour map. Granite units
  // get almost none of it — they are massive, and their structure is the joints.
  vec3 gu  = snFbm( P.xz * 0.00082, 3, 0.5 );
  float unit = clamp( gu.x * 1.9 + 0.58, 0.0, 1.0 );       // 0 granite .. 1 limestone
  vec3 bw  = snFbm( P.xz * 0.0016, 2, 0.5 );
  vec3 dipN = normalize( uBedding + vec3( gu.y * 0.26, gu.z * 0.14, -gu.y * 0.22 ) );
  // Folded: the beds undulate over hundreds of metres, so they cross a face as
  // sweeping curves rather than as a ruled grating.
  float fold = snFbm( P.xz * 0.00055, 2, 0.5 ).x * 2.6;
  float bed = dot( P, dipN ) * ( 0.026 + 0.015 * bw.x ) + fold;
  vec3 bn = snFbm( vec2( bed * 2.4, dot( P.xz, vec2( 0.021, -0.014 ) ) ), 3, 0.5 );
  float strata = sin( bed * 6.2831 + bn.x * 3.4 );
  strata = sign( strata ) * pow( abs( strata ), 0.75 );
  // Thin laminations inside each bed — visible only close in.
  float lamin = sin( bed * 27.0 + bn.y * 2.0 ) * snFade( 700.0, 140.0, snViewDist );

  // Where the bedding plane runs nearly *parallel* to the ground, its trace on
  // the surface degenerates into contour lines — arbitrarily close together and
  // wrapping the peak like a topographic map. That is a geometric singularity,
  // not a look; fade the bands out by how steeply the plane cuts the surface.
  vec3 dipT = dipN - Ng * dot( dipN, Ng );
  float cut = smoothstep( 0.20, 0.58, length( dipT ) );
  float bedAmt = ( 0.25 + 0.75 * unit ) * cut * snFade( 4200.0, 900.0, snViewDist );
  strata *= bedAmt;
  lamin  *= bedAmt;

  // Bedding planes are weaknesses: they step the face. Feed them into the relief
  // gradient (along the dip direction) but *not* into the snowline — banded
  // bedrock is right, a banded snowline is a topographic map.
  rGrad += dipT * ( strata * 0.30 + lamin * 0.10 );

  // --- where the snow stops --------------------------------------------------
  // Ragged, and driven by everything that actually drives it: repose angle,
  // erosion history, wind aspect, drainage and curvature. Plus long fall-line
  // streaks, because on a steep face snow does not sit in patches — it sits in
  // stripes running down the gullies between the ribs.
  vec2 dHill = normalize( Ng.xz + vec2( 1e-5, 1e-5 ) );
  vec2 dCross = vec2( -dHill.y, dHill.x );
  // 3:1, not the 7:1 it used to be — past about 4:1 the snow stripes stop
  // reading as gullies full of snow and start reading as rake marks.
  vec3 strk = snFbm( vec2( dot( P.xz, dCross ) * 0.055,
                           dot( P.xz, dHill ) * 0.018 ), 3, 0.5 );

  // Budget matters here: every one of these terms lowers the angle at which the
  // mountain stops being white, and if their swings add up the snowline walks
  // down onto the piste. Nominal 41 deg, and no combination can pull it under 30.
  float talus = 0.735 + rn.x * 0.105 + rn2.x * 0.095 - expo * 0.28;
  talus += strk.x * 0.058 * smoothstep( 0.55, 1.05, steep );       // fall-line streaking
  talus += clamp( curvR, -1.0, 1.0 ) * 0.045;                      // snow wedges into hollows/ledges
  talus += clamp( flow * 1.4 - 0.15, 0.0, 1.0 ) * 0.055;           // gullies fill in
  talus += ( lee - wind ) * 0.045;                                 // windward blows clear, lee loads up
  // The fracture field itself has to move the snowline, or snow sits on a face
  // in smooth lobes instead of wedging into every ledge and ramp the way it does
  // on a real wall. Small, high-frequency, and signed: ledges hold, slabs shed.
  talus += clamp( rFrac * 3.2 + rB1 * 0.10, -0.09, 0.13 );
  float rockRaw = ( steep - talus ) * 4.2;

  // Height-blend: snow settles into the low spots of the rock, so the boundary
  // follows real ledges instead of a soft lerp.
  // Snow lying on rock has a *hard* edge — it is a wedge of drift ending against
  // a slab, not an airbrushed gradient — so the blend is tight up close and only
  // widens far out, where a tight one would alias along the snowline.
  float rEdge = mix( 0.34, 0.72, smoothstep( 300.0, 2000.0, snViewDist ) );
  snRockMask = smoothstep( -rEdge, rEdge, rockRaw + rLedge * 1.5 ) * uRockAmount;

  // --------------------------------------------------------------- snow ----
  // Multi-scale relief.
  vec3 sw = snTriW( Ng, 2.0 );

  // --- the LOD metric --------------------------------------------------------
  // World metres spanned by one pixel, worst screen axis. This, and not view
  // distance, is the honest cut-off for a detail band, and getting it wrong is
  // what produced the "brushed metal" smear:
  //
  //   ground 25 m ahead of a chase camera 6 m up is seen 13 degrees off grazing,
  //   so it is foreshortened about 4:1 vertically. The 16 cm wind-ripple band
  //   there is 6 px wide and 1.3 px tall — comfortably sub-Nyquist on one axis —
  //   and every frame it resolves to a different set of samples. TAA then drags
  //   that into long horizontal wipes. Distance-based fades cannot see this at
  //   all: the same band at the same distance is perfectly well resolved if you
  //   are looking straight down at it.
  //
  // So every band is now gated on how many pixels its wavelength actually spans.
  // The footprint is an *ellipse*, not a disc, and taking its long axis would
  // throw away everything a 16x anisotropic sampler would happily have kept: a
  // band that is ten pixels wide and one pixel tall still carries real
  // information along the wide axis. So the ratio is capped at 3:1 the way a
  // hardware aniso filter caps it, and the band is gated on what survives that.
  float snPxA = length( dFdx( P ) ), snPxB = length( dFdy( P ) );
  float snPxHi = max( snPxA, snPxB ), snPxLo = max( min( snPxA, snPxB ), 1e-5 );
  float snPx = snPxHi / min( snPxHi / snPxLo, 3.0 );
  #define SN_BAND( lambda ) smoothstep( 1.9, 4.4, ( lambda ) / snPx )

  // The 35 m band is a *mid-field* band: close up the piste already has the 12 m
  // drifts and the sastrugi, and stacking a third metre-scale wave on top of
  // them just combs the near snow into stripes.
  float fDeca   = snFade( 4600.0, 1000.0, snViewDist )
                * smoothstep( 70.0, 280.0, snViewDist );     // ~35 m
  float fDrift  = snFade( 2600.0,  500.0, snViewDist ) * SN_BAND( 11.8 );
  float fRoll   = snFade( 1500.0,  260.0, snViewDist ) * SN_BAND( 5.3 );
  float fSastr  = snFade(  800.0,  160.0, snViewDist ) * SN_BAND( 2.4 );
  float fDune   = snFade(  380.0,   90.0, snViewDist ) * SN_BAND( 0.65 );
  float fRipple = snFade(  110.0,   18.0, snViewDist ) * SN_BAND( 0.16 );
  float fGrain  = snFade(   18.0,    2.5, snViewDist ) * uGrainFade * SN_BAND( 0.033 );

  // Wind loading: pillows on the lee, hard scoured ripple on the windward side.
  float loadA = 0.55 + 0.85 * lee;
  float scour = 0.35 + 1.15 * wind;

  vec3 grad = vec3( 0.0 );
  float relief = 0.0, fine = 0.0;
  // The far field is a *cascade*, not a fade-out. Every octave hands over to the
  // next coarser one as it drops under a few pixels, so a snowfield at 1-3 km
  // still has hectometre wind rolls and decametre drifts on it instead of the
  // flat white wash you get when the last band simply expires.
  //
  // Note the rot column: 0, 0, 0, +1.05, -0.72, +2.25, 0. The three bands that
  // are allowed to be anisotropic point in three different directions, so the
  // eye reads "wind-worked snow" rather than "one brush dragged across the
  // whole mountain".
  float fFar = smoothstep( 280.0, 900.0, snViewDist );
  detailLayer( P, sw, 0.0085, 6.0 * fFar, 1.0, 0.0, 3, grad, relief );
  detailLayer( P, sw, 0.030,  2.1 * fDeca, 1.0, 0.0, 3, grad, relief );
  detailLayer( P, sw, 0.085,  1.18 * fDrift * loadA, 1.0, 0.0, 4, grad, relief );
  // 5 m rollers. This is the band the mid field was missing: between 50 and 400 m
  // the 12 m drifts are too big to read as texture and the 2.4 m sastrugi are
  // already sub-pixel, so the surface went to a blank wash. Deliberately
  // isotropic — it is the layer carrying the "this is a surface" signal.
  detailLayer( P, sw, 0.19,   0.115 * fRoll, 1.0, 0.0, 3, grad, relief );
  detailLayer( P, sw, 0.42,   0.24 * fSastr * loadA, 0.72, 1.05, 3, grad, relief );
  // The sub-metre bands are tracked separately: their pits are what carry the
  // micro-occlusion that stops snow reading as a painted surface.
  detailLayer( P, sw, 1.55,  0.072 * fDune * scour, 0.66, -0.72, 3, grad, fine );
  detailLayer( P, sw, 6.20,  0.0190 * fRipple * scour, 0.60, 2.25, 3, grad, fine );
  detailLayer( P, sw, 30.0,  0.0026 * fGrain, 1.0, 0.0, 2, grad, fine );
  float fineNorm = fine / max( 0.072 * fDune + 0.0190 * fRipple + 0.0026 * fGrain, 1e-4 );

  // --- LOD-locked micro grain ------------------------------------------------
  // Every band above is defined in *world* units, and a world-scale band on
  // ground seen at grazing incidence foreshortens into a horizontal smear: that,
  // not the detail normals, is why the 50-400 m field read as wet paint and why
  // its structure-tensor coherence sat at 0.65 with the streak dead horizontal.
  // The cure is a band whose *screen* size is fixed. Frequency tracks 1/distance
  // in power-of-two steps, two neighbouring steps cross-fade, and the result is
  // a 4-8 px snow tooth at any range from 40 m to the horizon, with no aliasing
  // because the feature size never crosses the sampling limit.
  //
  // It also has to arrive as *occlusion*, not only as a normal. Sunlit snow sits
  // on the shoulder of the tone curve: tilting the normal a few degrees there
  // moves the encoded pixel by well under one code value, which is precisely why
  // adding yet more relief never fixed the wash. Shadowing the pits — and
  // tinting them towards the sky — is multiplicative and survives the shoulder.
  float gGrain = 0.0;
  {
    // Wavelength locked to 7 px of the worst screen axis, quantised to powers of
    // two with a cross-fade between neighbours so it never pops and never
    // aliases. Two decades of it — a 7 px tooth and a 28 px roll — which is the
    // sugar-on-ripple double scale real snow reads at.
    float gL  = log2( max( snPx, 1e-4 ) );
    float gLf = floor( gL ), gLt = gL - gLf;
    float gF0 = 1.0 / ( 7.0 * exp2( gLf ) );
    float gS  = smoothstep( 2.5, 8.0, snViewDist );
    float gK  = 0.255 * gS;
    float gH  = 0.0;
    float a0 = gK * ( 1.0 - gLt ) / gF0, a1 = gK * gLt * 2.0 / gF0;
    detailLayer( P, sw, gF0,       a0, 1.0, 0.0, 1, grad, gH );
    detailLayer( P, sw, gF0 * 0.5, a1, 1.0, 0.0, 1, grad, gH );
    gGrain = gH / max( a0 + a1, 1e-6 );
    float gK2 = 0.205 * gS;
    float gH2 = 0.0;
    float b0 = gK2 * ( 1.0 - gLt ) * 4.0 / gF0, b1 = gK2 * gLt * 8.0 / gF0;
    detailLayer( P, sw, gF0 * 0.25,  b0, 1.0, 0.0, 1, grad, gH2 );
    detailLayer( P, sw, gF0 * 0.125, b1, 1.0, 0.0, 1, grad, gH2 );
    gGrain = clamp( gGrain + gH2 / max( b0 + b1, 1e-6 ), -1.6, 1.6 ) * gS;
  }

  // --- traffic ---------------------------------------------------------------
  // A worked piste is not a smooth white field, it is covered in the tracks of
  // everyone who came down it today: long thin grooves running broadly with the
  // fall line, arcing where people turned. Side by side with a photograph of a
  // real ski area this is the most conspicuous single thing we did not have, and
  // its absence is most of why our snow read as an untouched render.
  //
  // Yes, it is anisotropic — deliberately so. What made the old surface look
  // brushed was *low-frequency* directional smear with no edges. Tracks are the
  // opposite: narrow, high-contrast, and they arc. The eye reads them as traffic.
  // The frame must not *rotate* with position. Steering a 50:1 anisotropic noise
  // through a direction field that turns — the surface normal, a flow field,
  // anything — displaces the domain by (track length) x (rotation) across the
  // grain, and since the grain is 30 cm wide the tracks close on themselves into
  // concentric wood-grain whorls. So the lines run along a *fixed* world axis
  // (the corridor's fall line) and are curved by a pure shear instead: the cross
  // coordinate is offset by a smooth function of the along coordinate. A shear
  // is invertible and orientation-preserving, so the lines arc like skier turns
  // and can never close a loop.
  float trackA = 0.0;
  {
    // Traffic is patchy: the fall line and the inside of the turns get hammered,
    // the edges of the piste stay smooth for days. Without this the tracks read
    // as a machine finish laid over the whole mountain.
    float tp = clamp( snFbm( P.xz * 0.0068 + vec2( -3.4, 8.8 ), 3, 0.55 ).x * 1.5 + 0.62, 0.0, 1.0 );
    float g = smoothstep( 0.46, 0.20, steep ) * ( 1.0 - snRockMask ) * tp;
    float w0 = SN_BAND( 0.34 ) * snFade( 300.0, 14.0, snViewDist );
    float w1 = SN_BAND( 1.30 ) * snFade( 1800.0, 45.0, snViewDist );
    float a0 = 0.060 * g * w0, a1 = 0.100 * g * w1;
    if ( a0 + a1 > 1e-4 ) {
      // Two traffic lines crossing at a shallow angle: nobody skis a piste in
      // single file, and one direction alone reads as a machine finish.
      const vec2 eA = vec2(  0.242, -0.970 ), eB = vec2( -0.276, -0.961 );
      const vec2 xA = vec2(  0.970,  0.242 ), xB = vec2(  0.961, -0.276 );
      float uA = dot( P.xz, eA ), uB = dot( P.xz, eB );
      // Bend: one smooth 1-D wave per set. dBend is its exact derivative, so the
      // shear stays analytic and the normal never lies about the geometry.
      float bA = 7.0 * sin( uA * 0.031 ) + 3.1 * sin( uA * 0.084 + 2.1 );
      float dA = 7.0 * 0.031 * cos( uA * 0.031 ) + 3.1 * 0.084 * cos( uA * 0.084 + 2.1 );
      float bB = 5.4 * sin( uB * 0.024 + 1.7 ) + 2.6 * sin( uB * 0.067 - 0.6 );
      float dB = 5.4 * 0.024 * cos( uB * 0.024 + 1.7 ) + 2.6 * 0.067 * cos( uB * 0.067 - 0.6 );
      float vA = dot( P.xz, xA ) + bA, vB = dot( P.xz, xB ) + bB;

      float fx0 = 2.9, fy0 = 0.070, fx1 = 0.77, fy1 = 0.030;
      vec3 t0 = snFbm( vec2( vA * fx0, uA * fy0 ), 3, 0.62 );
      vec3 t1 = snFbm( vec2( vB * fx1, uB * fy1 ), 2, 0.60 );
      // Ridged: a track is a groove with a lip each side, not a lump.
      float s0 = t0.x < 0.0 ? -1.0 : 1.0, s1 = t1.x < 0.0 ? -1.0 : 1.0;
      float k0 = s0 * a0, k1 = s1 * a1;
      // world gradient of ( vA * fx0 ) is fx0 * ( xA + dA * eA ); of ( uA * fy0 ) is fy0 * eA
      vec2 gw = k0 * ( t0.y * fx0 * ( xA + dA * eA ) + t0.z * fy0 * eA )
              + k1 * ( t1.y * fx1 * ( xB + dB * eB ) + t1.z * fy1 * eB );
      grad += vec3( gw.x, 0.0, gw.y ) * sw.y;
      trackA = clamp( ( 0.5 - abs( t0.x ) ) * a0 * 26.0
                    + ( 0.5 - abs( t1.x ) ) * a1 * 11.0, 0.0, 1.0 ) * sw.y;
    }
  }

  snMicroAO = clamp( 1.0 - 0.30 * clamp( 0.45 - fineNorm * 0.75, 0.0, 1.0 )
                       - 0.16 * clamp( -relief * 1.6, 0.0, 1.0 )
                       - 0.15 * clamp( -gGrain, 0.0, 1.0 )
                       - 0.26 * trackA, 0.42, 1.0 );
  relief += fine;

  // Convex wind lips get scoured to ice; hollows collect powder.
  // The relief accumulator is in *metres*, and the coarse bands carry several of them, so it
  // has to enter bounded — otherwise every drift bigger than a wheelbarrow
  // saturates the ice term and the snow comes out as blue satin combing.
  snIce = clamp( ( curv * 1.5 + wind * 0.55 - 0.22 ) * 1.6
                 + clamp( relief * 0.4, -0.45, 0.45 ), 0.0, 1.0 );
  snIce = smoothstep( 0.18, 0.85, snIce ) * smoothstep( 0.06, 0.30, slope ) * dFar;
  snPowder = clamp( -curv * 1.9 + lee * 0.5 + flow * 0.45, 0.0, 1.0 );

  // Surface-gradient normal perturbation (correct on steeps, no UV stretch).
  vec3 g = mix( grad, rGrad * 2.7, snRockMask );
  g -= Ng * dot( g, Ng );
  float ds = uDetailStrength * mix( 1.0, 0.72, snIce );
  snNormalW = normalize( Ng - g * ds );
  // Joint facets rotate the whole plate rather than dimpling it, so they are
  // applied to the normal directly instead of through the gradient.
  if ( snRockMask > 0.004 ) {
    vec3 fN = facet - Ng * dot( facet, Ng );
    snNormalW = normalize( snNormalW + fN * snRockMask );
  }

  // ------------------------------------------------------------- albedo ----
  // Snow albedo is high and slightly blue; grain size (powder vs. wind slab)
  // moves it a couple of percent, which is all the variation real snow has.
  // The visible variation has to come from normals and scattering, not paint.
  vec3 snowAlb = uSnowTint;
  snowAlb = mix( snowAlb, uSnowTint * vec3( 0.93, 0.96, 1.03 ), snIce );
  snowAlb = mix( snowAlb, uSnowTint * vec3( 1.02, 1.02, 1.03 ), snPowder * 0.6 );

  // Two rock types, interleaved in broad geological units: a cool grey granite
  // and a warmer buff limestone. Which one you are standing on is the single
  // biggest cue that the mountain is made of something.
  vec3 rockFace = mix( uRockHi, uRockWarm, unit );
  float bandMix = clamp( 0.5 + strata * 0.32 + bn.x * 0.26 + lamin * 0.14
                             + rn2.x * 0.20 * ( 1.0 - unit ), 0.0, 1.0 );
  vec3 rockAlb = mix( uRockLo, rockFace, bandMix );
  // Cracks go near-black; the faces catch the light. This contrast is most of
  // what separates rock from clay. The *coarse* bands are in this sum as well,
  // so a face four kilometres away still has dark chimneys and pale buttresses
  // on it long after the metre-scale crack field has been retired.
  //
  // The floor used to be 0.34 of the face value. Photographs of a real limestone
  // wall run from near black in the chimneys to bright buff on the sunlit
  // buttresses — a good four stops — and compressing that into a single stop is
  // most of what made ours read as grey modelling clay.
  rockAlb *= 0.14 + 1.20 * clamp( rFrac * 6.5 + rLedge * 1.30 + 0.58, 0.0, 1.0 );
  // The facet tilt doubles as a per-plate lightness jitter — freshly split faces
  // are pale, weathered ones are not.
  rockAlb *= 1.0 + facet.y * 0.55;
  // Whole-buttress value variation. A real massif is not one rock: bands of
  // darker, wetter, more shattered ground alternate with pale slabs on a
  // hectometre scale, and that big-scale mottling is what reads as "made of
  // something" from three kilometres away, where every crack is sub-pixel.
  rockAlb *= 0.55 + 0.85 * clamp( rn2.x * 0.9 + gu.x * 0.7 + 0.55, 0.0, 1.0 );

  // Iron oxide bleeds out of the bedding and runs down the wet lines.
  float iron = clamp( rn2.x * 1.6 + 0.18, 0.0, 1.0 )
             * clamp( 0.30 + flow * 1.3 + strata * 0.35, 0.0, 1.0 );
  rockAlb = mix( rockAlb, uRockIron, iron * 0.48 );
  // Crustose lichen: it wants gentler, lower, less scoured rock.
  float lichen = clamp( rn.x * 1.7 + 0.24, 0.0, 1.0 )
               * snFade( 1.22, 0.78, steep )
               * snFade( 1500.0, 900.0, P.y )
               * snFade( 2600.0, 700.0, snViewDist );
  rockAlb = mix( rockAlb, uRockLichen, lichen * 0.42 );
  // Meltwater seeps darken and gloss the gullies.
  float wetRock = clamp( flow * 1.7 - 0.28, 0.0, 1.0 ) * clamp( 0.4 + curvR, 0.0, 1.0 );
  rockAlb *= mix( 1.0, 0.42, wetRock );

  // Cavity occlusion from the crack field — the cheapest thing that stops a
  // rock face reading as a decal on a smooth surface. A broken face sees a small
  // fraction of the sky; sitting in a snow bowl it was picking up as much bounce
  // as the snow around it, which flattened it to a uniform pale grey.
  snRockAO = mix( 1.0, clamp( 0.30 + rFrac * 3.4 + rLedge * 0.45, 0.16, 0.92 ), snRockMask );

  diffuseColor.rgb = mix( snowAlb, rockAlb, snRockMask );

  // Wind slab vs. soft snow patchiness at ~200 m, so a whole face is never one
  // uniform material.
  float slab = wv.x * 0.5 + 0.5;
  float snowRough = mix( 0.84, 0.32, snIce ) - slab * 0.13;
  snowRough = mix( snowRough, 0.92, snPowder * 0.55 );
  snowRough -= 0.10 * fGrain;
  // Rock is not a uniform matte either: a fresh split face has a hard sheen,
  // weathered limestone is chalky, and anything wet goes properly glossy. That
  // spread is what gives the rock a specular identity instead of a flat value.
  float rockRough = mix( 0.90, 0.74, unit )
                  - 0.16 * clamp( rFrac * 4.0 + 0.4, 0.0, 1.0 )
                  - 0.34 * wetRock
                  + 0.06 * lichen;
  roughnessFactor = mix( clamp( snowRough, 0.16, 0.97 ), clamp( rockRough, 0.24, 0.96 ), snRockMask );
  snSpecTint = mix( 1.0, 1.9, snRockMask * ( 0.25 + 0.75 * wetRock ) );
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
  //
  // Two things about this term used to be wrong and between them they produced
  // most of the "brushed metal" read. It was aligned to uWindDir, a *global
  // constant*, so the satin streak ran in one identical screen direction over
  // the entire mountain; and its lobe was 5.7:1, which is a hairline brush, not
  // wind-packed snow. It now follows the same per-fragment wind field the relief
  // does, at a 1.9:1 lobe — enough to see the grain, not enough to lacquer it.
  vec3 Wt = normalize( vec3( snWind.x, 0.0, snWind.y ) );
  vec3 Tw = normalize( ( viewMatrix * vec4( Wt, 0.0 ) ).xyz );
  vec3 Tr = Tw - N * dot( Tw, N );
  vec3 T = dot( Tr, Tr ) > 1e-6 ? normalize( Tr ) : vec3( 0.0 );
  vec3 B = cross( N, T );
  vec3 H = normalize( L + V );
  float ar = mix( 0.34, 0.13, snIce );
  float d = min( snAnisoGGX( N, T, B, H, ar * 1.38, ar * 0.72 ), 60.0 );
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

  // Rock. Cavity occlusion from the crack field, and an actual specular
  // response: bedrock was the only thing in the frame that never caught a
  // highlight, which is most of why it read as untextured clay. Wet gullies get
  // the strongest lobe, freshly split faces the next.
  reflectedLight.indirectDiffuse *= snRockAO;
  reflectedLight.directDiffuse *= mix( 1.0, 0.45 + 0.55 * snRockAO, snRockMask );
  reflectedLight.directSpecular *= snSpecTint;
  // Grazing sheen on the big faces — real rock has a slightly polished, dusty
  // Fresnel that lifts the far silhouettes off the haze.
  if ( snRockMask > 0.004 ) {
    float rf = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 4.0 );
    reflectedLight.directSpecular += C * shd * max( ndl, 0.0 ) * rf * 0.10 * snRockMask;
  }
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
    // Measured alpine rock is dark: dry limestone sits around 20% reflectance,
    // wet or shattered granite nearer 8%. Against 85%-albedo snow that is a
    // three-stop drop, and holding it is what makes the massif read as stone
    // instead of as grey putty.
    uRockLo: { value: new THREE.Color(0.014, 0.013, 0.016) },
    uRockHi: { value: new THREE.Color(0.082, 0.080, 0.086) },     // cool grey granite
    uRockWarm: { value: new THREE.Color(0.212, 0.158, 0.093) },   // buff limestone
    uRockIron: { value: new THREE.Color(0.104, 0.052, 0.022) },   // oxide staining
    uRockLichen: { value: new THREE.Color(0.066, 0.074, 0.048) },
    // A near-horizontal bedding plane makes contour terraces out of every face.
    // Real strata dip, and the dip is what tells you the massif was folded.
    uBedding: { value: new THREE.Vector3(0.74, 0.30, -0.60).normalize() },
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
    // The displacement provider may also inject a fragment-side refinement (the
    // terrain re-reconstructs its macro field per pixel so far-field shading is
    // not hostage to 100 m triangles); it needs its own prelude, without the
    // vertex attributes.
    const surface = SNOW_SURFACE.replace(
      '/*__TERRAIN_REFINE__*/', () => (displacement && displacement.fragRefine) || '',
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_LATTICE_NOISE + SNOW_FRAG_PRELUDE
        + ((displacement && displacement.fragPrelude) || ''))
      .replace('#include <roughnessmap_fragment>', surface + '\n')
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
