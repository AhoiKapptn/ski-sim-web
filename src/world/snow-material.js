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
uniform float uForestAmount;   // distant canopy albedo, 0 disables
uniform float uTreeLine;       // metres; must track scatter.js TREELINE
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

/**
 * One bedding scale, as a function of the bed coordinate b alone.
 *
 * floor(b) is the bed index; each bed draws its own tone, so the sequence of
 * units is irregular the way a real stratigraphic column is. 'soft' widens the
 * recessive parting at the joint, and is driven from the screen footprint so a
 * bed that is only a couple of pixels tall filters to a smooth ramp instead of
 * aliasing into moire.
 *
 * Monotone in b by construction — no waveform, no phase, nothing that can fork.
 */
float snBedProfile( float b, float soft ) {
  float i = floor( b );
  float f = b - i;
  float tone = hash33( vec3( i, 3.0, 11.0 ) ).x * 2.0 - 1.0;
  float p = smoothstep( 0.0, soft, min( f, 1.0 - f ) * 2.0 );
  return tone * ( 0.40 + 0.60 * p ) - ( 1.0 - p ) * 0.50;
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
 * The exponent is the whole ball game, and the reasoning behind the old value of
 * 1.15 had the geometry backwards. It argued that a high exponent collapses a
 * 60-degree face onto the XZ plane; it does the opposite. At 60 degrees from
 * horizontal |N.y| = 0.50 and |N.xz| = 0.87, so the *dominant* plane is already a
 * vertical one and raising the exponent is what finishes the job of evicting XZ.
 *
 * That matters because XZ is the projection that lies. A heightfield sampled in
 * XZ and viewed on a face inclined by theta is foreshortened by cos(theta): 2:1
 * at 60 degrees, 6:1 at 80, unbounded on a true wall. Weighting by |N| itself
 * leaves that projection 29% of the blend on a 65-degree face and 7% on a
 * near-vertical one — and 7% of a perfectly coherent infinite smear is still a
 * visible vertical streak, which is exactly what the steep faces were doing.
 *
 * At exponent 4 a 65-degree face gives XZ 4% and a 70-degree face 1.7%, which
 * falls under SN_TRI_CUT and is skipped outright. Flat ground is unaffected —
 * there XZ is the *correct* projection and wins by even more than before.
 *
 * The cutoff is what keeps this affordable, and a sharper exponent makes it
 * cheaper still: away from the 45-degree diagonals only one plane clears the cut,
 * so the expensive near field costs one fbm per layer.
 */
vec3 snTriW( vec3 N, float e ) {
  vec3 w = pow( abs( N ), vec3( e ) );
  return w / ( w.x + w.y + w.z );
}
#define SN_TRI_CUT 0.028

/**
 * Triplanar version of snRidged, for rock fracture relief.
 *
 * 'rc' = (cos a, sin a) turns the *sampling frame* of every projection by a.
 * snRidged's octave cascade turns by a fixed 37 degrees per octave and starts
 * from the world axes, so without this its coarsest — and therefore most
 * legible — octave lays its creases in one identical direction over the entire
 * planet. Every fracture band then agrees with every other one, and a field of
 * same-sized, same-angled ridge cells is exactly the overlapping-shingle quilt
 * the far cliffs were wearing. Feeding each band a slowly varying, differently
 * seeded angle costs one sincos and decorrelates them.
 *
 * The rotation is treated as locally constant when the gradient is rotated back,
 * which is exact to first order for a field this slow (a ~170 m period against a
 * band amplitude of centimetres to metres).
 */
void fractureLayerR( vec3 P, vec3 W, float freq, float amp, int oct, vec2 rc, inout vec3 grad, inout float hgt ) {
  if ( amp < 1e-5 ) return;
  float k = amp * freq;
  mat2 R = mat2( rc.x, rc.y, -rc.y, rc.x );      // columns: rotate p -> q
  if ( W.y > SN_TRI_CUT ) {
    vec3 n = snRidged( R * ( P.xz * freq ), oct, 0.5 );
    vec2 g = vec2( rc.x * n.y + rc.y * n.z, -rc.y * n.y + rc.x * n.z );
    grad.x += W.y * k * g.x; grad.z += W.y * k * g.y; hgt += W.y * amp * n.x;
  }
  if ( W.z > SN_TRI_CUT ) {
    vec3 n = snRidged( R * ( P.xy * freq ), oct, 0.5 );
    vec2 g = vec2( rc.x * n.y + rc.y * n.z, -rc.y * n.y + rc.x * n.z );
    grad.x += W.z * k * g.x; grad.y += W.z * k * g.y; hgt += W.z * amp * n.x;
  }
  if ( W.x > SN_TRI_CUT ) {
    vec3 n = snRidged( R * ( P.zy * freq ), oct, 0.5 );
    vec2 g = vec2( rc.x * n.y + rc.y * n.z, -rc.y * n.y + rc.x * n.z );
    grad.z += W.x * k * g.x; grad.y += W.x * k * g.y; hgt += W.x * amp * n.x;
  }
}

void fractureLayer( vec3 P, vec3 W, float freq, float amp, int oct, inout vec3 grad, inout float hgt ) {
  fractureLayerR( P, W, freq, amp, oct, vec2( 1.0, 0.0 ), grad, hgt );
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
float snRockPit = 0.0;
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
  //
  // Hoisted above the rock section because the rock bands need it too: derivative
  // instructions have to sit in uniform control flow, and the rock grain below is
  // the one band whose whole job is to stay a constant size in *screen* space.
  vec3 snDx = dFdx( P ), snDy = dFdy( P );
  float snPxA = length( snDx ), snPxB = length( snDy );
  float snPxHi = max( snPxA, snPxB ), snPxLo = max( min( snPxA, snPxB ), 1e-5 );
  float snPx = snPxHi / min( snPxHi / snPxLo, 3.0 );
  #define SN_BAND( lambda ) smoothstep( 1.9, 4.4, ( lambda ) / snPx )
  // Footprint measured *across* one chosen world direction, which is the honest
  // sampling rate for a band that only varies along it. A 7 cm groove running
  // away from the camera is a 7 cm feature on the screen's well-resolved axis
  // however badly the ground is foreshortened along the other one, and the 3:1
  // aniso cap baked into snPx throws exactly that away — which is why the
  // near-field piste ended up with no resolvable band on it at all.
  #define SN_PX_DIR( d ) max( max( abs( dot( snDx.xz, d ) ), abs( dot( snDy.xz, d ) ) ), 1e-5 )
  // Same, with the crossover spelled out. A *periodic* band needs a far stricter
  // gate than a noise band: 1.9 px per period is Nyquist itself, and the corduroy
  // comb duly interfered with the pixel grid into a visible plaid across the mid
  // piste. A noise band can live near the limit because its energy is spread over
  // an octave; a comb cannot.
  #define SN_BAND_DIR( lambda, d, e0, e1 ) smoothstep( e0, e1, ( lambda ) / SN_PX_DIR( d ) )

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
  // Geological unit: 0 granite .. 1 limestone, on a ~1.2 km scale. Hoisted above
  // the rock relief because the joint sets need it — a massif does not have one
  // global joint orientation, and a lattice that never turns is a lattice you
  // can see.
  vec3 gu  = snFbm( P.xz * 0.00082, 3, 0.5 );
  float unit = clamp( gu.x * 1.9 + 0.58, 0.0, 1.0 );

  vec3 rGrad = vec3( 0.0 );
  float rLedge = 0.0, rFrac = 0.0, rB0 = 0.0, rB1 = 0.0;
  // Rock lives on 50-80 degree faces, where a planar XZ projection stretches
  // every crack 2-5:1 down the fall line — unbounded on a true wall. This is the
  // layer that was smearing the valley walls into vertical corduroy, so it gets
  // the sharpest blend in the shader: past about 68 degrees the XZ plane drops
  // under SN_TRI_CUT and stops contributing at all.
  vec3 rw = snTriW( Ng, 4.0 );
  // --- grain orientation ------------------------------------------------------
  // snRidged's octave cascade always starts from the world axes and always turns
  // by the same 37 degrees per octave, so the coarsest — and most legible —
  // octave of every band laid its creases in one identical direction, and every
  // band agreed with every other one. A field of same-angled, same-sized ridge
  // cells is precisely the overlapping-shingle quilt.
  //
  // Each band therefore gets its own *constant* sampling rotation. Constant, and
  // that is not a detail: a position-dependent rotation is a domain warp of
  // magnitude |P| * dtheta about the world origin, and |P| here is kilometres.
  // Tried, measured, and it turned the entire massif into marbled wood grain —
  // the same class of mistake as the bed-spacing multiply above. Everything that
  // has to vary *across* a face varies in the amplitude domain instead, where a
  // varying weight cannot displace anything.
  #define SN_ROT( a ) vec2( cos( a ), sin( a ) )
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
  // Amplitudes pulled back from 10.5/2.7. At amp*freq = 0.13 apiece and a 2.7x
  // multiplier downstream these two bands were tilting the shading normal by
  // nearly 20 degrees on their own, and since they are the *only* thing on a
  // face at 1-2 km the result was a field of smooth 20-40 px lobes: a padded
  // quilt. They are the large-scale skeleton, not the texture; the texture is
  // rGrain below, and it now carries reflectance as well as shading.
  fractureLayerR( P, rw, 0.0125, 7.6 * fRk0, 2, SN_ROT( 0.41 ), rGrad, rB0 );
  fractureLayerR( P, rw, 0.048,  1.95 * fRk1, 3, SN_ROT( 1.93 ), rGrad, rB1 );
  // Coefficients raised in step with the amplitude cut above, so the snowline
  // this feeds is bit-for-bit as ragged as it was.
  rLedge = rB0 * 0.0276 + rB1 * 0.201;
  // Structure scale — slabs, joints, cracks. Pure appearance.
  fractureLayerR( P, rw, 0.23,   0.105 * fRk2, 3, SN_ROT( 3.37 ), rGrad, rFrac );
  fractureLayerR( P, rw, 1.10,   0.024 * fRk3, 3, SN_ROT( -2.24 ), rGrad, rFrac );
  fractureLayerR( P, rw, 4.60,   0.0055 * fRk4, 2, SN_ROT( 0.79 ), rGrad, rFrac );

  // --- screen-locked fracture grain ------------------------------------------
  // Every band above is defined in world units and therefore has a distance past
  // which it is no longer worth evaluating: the 4 m slab band expires at 3.4 km,
  // the metre band at 950 m. Past a kilometre a cliff was consequently carrying
  // nothing but the 80 m and 20 m ridged lobes — smooth, rounded, and with no
  // texture inside them. That is the quilted / puzzle-piece read: a field of
  // 20-40 px blobs and nothing under it.
  //
  // This band's wavelength is pinned to a fixed number of *pixels* instead, so
  // the same crack density lands on a face at 200 m and on one at 4 km, and it
  // can never alias because the feature size never crosses the sampling limit.
  // Frequency tracks 1/snPx in power-of-two steps with a cross-fade between
  // neighbours, exactly as the snow micro-grain does. Two decades of it — a 5 px
  // crack and a 20 px slab — which is the double scale a broken face reads at.
  //
  // It is also fed into the albedo below, not only the normal: on a shadowed
  // face at a grazing angle a normal perturbation moves the pixel by almost
  // nothing, and unlit rock texture is carried by reflectance, not by shading.
  // Gated on inclination alone, which is the one input to the rock mask that is
  // already known here: nothing under about 20 degrees can ever come back rock,
  // and that is the entire near-field piste — the pixels where the frame budget
  // actually lives. The gate is a ramp, not a branch on the result, so there is
  // no seam where it opens.
  float rGrain = 0.0;
  // How broken this patch of the massif is. Blind against a photograph of the
  // Tre Cime the single loudest tell left on our rock was that every square metre
  // of every face carried the *same* even, isotropic pebbling. A real wall is not
  // like that: it is a few big flat slabs with almost no texture on them at all,
  // separated by shattered ground and by vertical flutes. Half of the fix is this
  // mask, which lets the grain run at full strength on the broken ground and
  // nearly switches it off on the slabs; the other half is the fall-line flutes
  // added to the albedo below.
  float rSlab = clamp( 0.52 + rn2.x * 1.7 + gu.x * 0.9, 0.0, 1.0 );
  float rkPre = uRockAmount * smoothstep( 0.30, 0.60, steep );
  if ( rkPre > 0.02 ) {
    vec3 gG = vec3( 0.0 );
    float rL  = log2( max( snPx, 1e-4 ) );
    float rLf = floor( rL ), rLt = rL - rLf;
    float rF0 = 1.0 / ( 5.0 * exp2( rLf ) );
    // Apparent cell size, varied in the *amplitude* domain. The two octaves this
    // band already evaluates are the LOD cross-fade pair, both guaranteed to be
    // above five pixels; sliding the split between them with a slow world field
    // makes one patch of a face read at 5 px and the next at 10 px without
    // touching a single sample coordinate. Doing the same thing by scaling the
    // frequency is a domain warp — see the note on rotation above — and produces
    // marbling, not rock.
    vec3 rvar = snFbm( P.xz * 0.0138 + vec2( -8.1, 3.7 ), 2, 0.5 );
    float rMix = clamp( rLt + rvar.x * 0.85, 0.0, 1.0 );
    // Constant amp*freq keeps the apparent roughness identical at every range.
    float a0 = 0.060 * ( 1.0 - rMix ) / rF0, a1 = 0.060 * rMix * 2.0 / rF0;
    fractureLayerR( P, rw, rF0,       a0, 2, SN_ROT( 2.58 ), gG, rGrain );
    fractureLayerR( P, rw, rF0 * 0.5, a1, 2, SN_ROT( -0.72 ), gG, rGrain );
    // Deliberately only the *fine* end. A screen-locked octave at 20-40 px was
    // tried and is what the quilt actually was: at that scale the world-space
    // bands (80 m, 20 m, 4 m, 1 m) are already doing the job, and a second field
    // laid over them just adds a layer of rounded lobes with nothing inside. The
    // gap this band exists to fill is the 5-10 px end, where every world band has
    // either expired on distance or fallen under Nyquist.
    float rkg = rkPre * ( 0.22 + 0.92 * rSlab );
    rGrain = rGrain / max( a0 + a1, 1e-6 ) * rkg;
    rGrad += gG * rkg;
  }

  // Fractured facets. Rock parts along its joint sets into flat plates with hard
  // edges; smooth noise alone can only make dough.
  //
  // This used to be a hash of floor( P * f ) — a *cubic* lattice. A cube lattice
  // cut by an arbitrary surface tiles it with axis-aligned squares and L-shaped
  // notches at exactly one wavelength, and that is the jigsaw: on the far cliffs
  // it read as a quilt of interlocking puzzle pieces rather than as broken rock.
  //
  // Real joint blocks are bounded by three *oblique* plane families with
  // different spacings, and the planes themselves are not perfectly flat. So the
  // block index is a triple of slab numbers taken along three non-orthogonal
  // normals, with the slab walls displaced by the triplanar relief already
  // computed above — which makes the walls curve, so no two blocks share an edge
  // direction and nothing tiles. Cost is three dots and a hash: cheaper than the
  // thing it replaces, which needed a shear matrix.
  // Two further things have to be true or the block model is just a different
  // regular lattice: the joint *orientation* has to change from one structural
  // unit to the next (it is one global set of three directions otherwise, and a
  // lattice that never turns is a lattice you can see), and the slab walls have
  // to wander by a decent fraction of their own spacing. A wobble of 1 m against
  // an 8 m spacing leaves the walls essentially straight and parallel and the
  // face comes out woven; at 40% of the spacing the blocks are irregular
  // polyhedra and no two edges are collinear.
  vec3 facet = vec3( 0.0 );
  {
    float jr = gu.x * 2.6 + rn2.x * 0.5;
    float jc = cos( jr ), js = sin( jr );
    vec3 J1 = vec3(  0.8213 * jc + 0.4989 * js,  0.2771, -0.4989 * jc + 0.8213 * js );
    vec3 J2 = vec3( -0.3542 * jc - 0.7085 * js,  0.6100,  0.7085 * jc - 0.3542 * js );
    vec3 J3 = vec3(  0.5077 * jc - 0.4933 * js, -0.7062,  0.4933 * jc + 0.5077 * js );
    // Wall waviness, in metres, from the un-stretched triplanar bands. Different
    // combinations per family so the three sets do not wave in sympathy.
    float wa = rB0 * 0.42 + rB1 * 1.15;
    float wb = rB1 * 1.90 - rB0 * 0.26;
    float wc = rB0 * 0.31 - rB1 * 1.40;
    float fFacetA = snFade( 2600.0, 400.0, snViewDist );
    if ( fFacetA > 0.01 ) {
      vec3 s = floor( vec3( ( dot( P, J1 ) + wa ) * 0.116,
                            ( dot( P, J2 ) + wb ) * 0.079,
                            ( dot( P, J3 ) + wc ) * 0.147 ) );
      facet += ( hash33( s ) * 2.0 - 1.0 ) * 0.15 * fFacetA;
    }
    float fFacetB = snFade( 460.0, 70.0, snViewDist );
    if ( fFacetB > 0.01 ) {
      float wd = rFrac * 2.4;
      vec3 s = floor( vec3( ( dot( P, J2 ) + wa * 0.3 + wd ) * 0.61 + 11.0,
                            ( dot( P, J3 ) + wb * 0.3 - wd ) * 0.44 + 23.0,
                            ( dot( P, J1 ) + wc * 0.3 + wd ) * 0.83 + 37.0 ) );
      facet += ( hash33( s ) * 2.0 - 1.0 ) * 0.12 * fFacetB;
    }
  }

  // --- bedding ---------------------------------------------------------------
  // A tilted plane family whose dip and thickness both wander, so the massif
  // reads as folded sedimentary rock rather than as a contour map. Granite units
  // get almost none of it — they are massive, and their structure is the joints.
  vec3 dipN = normalize( uBedding + vec3( gu.y * 0.26, gu.z * 0.14, -gu.y * 0.22 ) );

  // THIS is where the concentric contour rings came from, and they came from two
  // separate phase singularities, both of them arithmetic rather than geological.
  //
  //   bed = dot( P, dipN ) * ( 0.026 + 0.015 * bw.x ) + fold
  //
  // A position-dependent scale multiplying an *unbounded* world coordinate. The
  // gradient of that product carries a P * d(scale)/dP term, and at |P| = 2 km,
  // with bw running at 0.0016 m^-1, it is worth ~0.10 cycles/m against a nominal
  // carrier of 0.032 — three times the carrier, pointing wherever bw's gradient
  // happened to point. Then
  //
  //   strata = sin( bed * 6.2831 + bn.x * 3.4 ),  bn = fbm( vec2( bed * 2.4, .. ) )
  //
  // phase-modulates that with a noise sampled at 2.4 cycles *per bed*, at an
  // index of 3.4 rad. Either one on its own drives the instantaneous frequency
  // negative over large patches. A sinusoid whose phase gradient reverses has
  // dislocations, and a field of dislocations in a 1-D grating is, precisely and
  // unavoidably, a fingerprint: nested arcs that close on themselves. Which is
  // what the far rock had drawn all over it.
  //
  // The replacement keeps every geological input and gives up the singularity.
  // Bed spacing is a *constant* along the dip normal; thickness, folding and
  // undulation all enter as warps *added to* the bed coordinate, each with a
  // gradient budgeted well under the carrier's, so:
  //
  //   band              amp (beds)   freq (1/m)   worst |grad| (cycles/m)
  //   fold, 1.8 km         2.60       0.00055            0.0073
  //   swell, 240 m         0.42       0.0042             0.0090
  //   ripple, 75 m         0.10       0.0134             0.0068
  //                                          sum  0.0231  vs carrier 0.0335
  //
  // and the phase gradient can never reverse. The beds bend, thicken and thin;
  // they cannot fork, and they cannot close a loop.
  const float kBed = 0.0335;                                  // ~30 m nominal
  float fold = snFbm( P.xz * 0.00055, 2, 0.5 ).x * 2.60;
  vec3  swl  = snFbm( P.xz * 0.0042 + vec2( 5.7, -2.3 ), 2, 0.5 );
  vec3  rip  = snFbm( P.xz * 0.0134 + vec2( -11.9, 4.4 ), 2, 0.5 );
  float bed  = dot( P, dipN ) * kBed + fold + swl.x * 0.42 + rip.x * 0.10;
  // Irregular bed *thickness*, as a 1-D warp of the bed coordinate by a noise of
  // itself. d(bedW)/d(bed) = 1 + 0.55 * 0.34 * n', and one lattice octave bounds
  // |n'| at 3.75, so the derivative stays in [0.30, 1.70]: strictly positive,
  // therefore monotone, therefore incapable of producing a dislocation however
  // hard it is multiplied downstream.
  float bedW = bed + snFbm( vec2( bed * 0.34, 7.7 ), 1, 0.5 ).x * 0.55;

  // A sine is a contour map with a period. Real strata are an irregular sequence
  // of units — a pale massive limestone, a dark marly parting, another pale one
  // twice as thick — and it is the *irregularity* of that sequence, not any
  // waveform, that the eye reads as bedding. So each bed gets its own tone from
  // a hash of its index, with a recessive parting at the joint. The profile is a
  // function of 'bed' alone, so its iso-lines are exactly the bedding planes.
  //
  // Two scales, from the same coordinate: ~30 m units close in, ~107 m units in
  // the far field, where a 30 m unit is a couple of pixels and could only alias.
  float sSoft = clamp( snPx * kBed * 7.0, 0.18, 1.0 );
  float cSoft = clamp( snPx * kBed * 1.96, 0.18, 1.0 );
  float strata = snBedProfile( bedW, sSoft );
  float strataC = snBedProfile( bedW * 0.28 + 3.3, cSoft );
  strata = mix( strata, strataC, smoothstep( 700.0, 2100.0, snViewDist ) );
  // Thin laminations inside each bed — visible only close in. Safe at 27x
  // because bedW is monotone in the dip coordinate; multiplying a monotone
  // function cannot introduce a turning point.
  float lamin = sin( bedW * 27.0 ) * snFade( 700.0, 140.0, snViewDist );

  // Where the bedding plane runs nearly *parallel* to the ground, its trace on
  // the surface degenerates into contour lines — arbitrarily close together and
  // wrapping the peak like a topographic map. That is a geometric singularity,
  // not a look; fade the bands out by how steeply the plane cuts the surface.
  vec3 dipT = dipN - Ng * dot( dipN, Ng );
  float cut = smoothstep( 0.20, 0.58, length( dipT ) );
  // Strata are the single most legible thing about a distant limestone face —
  // the horizontal banding is visible from ten kilometres — so the band runs to
  // the horizon rather than expiring at 4 km, where it left the far peaks with
  // no internal structure at all.
  float bedAmt = ( 0.25 + 0.75 * unit ) * cut * snFade( 13000.0, 1600.0, snViewDist );
  strata *= bedAmt;
  lamin  *= bedAmt;

  // Bedding planes are weaknesses: they step the face. Feed them into the relief
  // gradient (along the dip direction) but *not* into the snowline — banded
  // bedrock is right, a banded snowline is a topographic map.
  // Raised from 0.30/0.10. Measured against reference photography of a snowed-up
  // alpine wall, the single largest structural difference was not the amount of
  // relief but its *lineation*: a real face is organised into ribs, ramps and
  // bedding traces that all run one way, while a stack of isotropic fbm bands is
  // organised into nothing and reads as dough. Bedding is the only term in here
  // with a direction, so it carries that load.
  rGrad += dipT * ( strata * 0.50 + lamin * 0.16 );

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
  // Accumulation rises with altitude. Above the mean freezing level snow is dry
  // and wind-packed, it rimes onto rock, and it never melts out, so it plasters
  // faces that would be bare bedrock 700 m lower. Leaving this out is what made
  // every summit in the far field come back as one uniform dark mass: the
  // thermal-erosion pass in terrain.js relaxes the whole massif to within a few
  // degrees of the repose angle, so a single altitude-blind threshold tips an
  // entire range the same way — all rock, or all snow, with no structure left
  // once aerial perspective has flattened the value range.
  // The freezing level itself wanders by a couple of hundred metres with aspect
  // and shelter, or the snowline comes out as a contour line drawn round the
  // mountain.
  float snowLine = 640.0 + rn2.x * 210.0 + gu.x * 240.0;
  float alti = smoothstep( snowLine, snowLine + 780.0, P.y );
  float talus = 0.735 + rn.x * 0.105 + rn2.x * 0.095 - expo * 0.28 + alti * 0.108;
  // Fall-line streaking. Held back close in (up there you are looking at a
  // couple of gullies and it would read as stripes) and opened right up in the
  // far field, because that is the whole structure of a distant face: snow
  // hangs in flutes and ribbons *down* the fall line, separated by rock ribs.
  // A distance-blind weight leaves the far snowline isotropic, and isotropic
  // snow-on-rock at four kilometres is salt-and-pepper mottle - which is
  // precisely what separated ours from the reference photography.
  talus += strk.x * ( 0.058 + 0.085 * smoothstep( 900.0, 2800.0, snViewDist ) )
         * smoothstep( 0.55, 1.05, steep );
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
  // The far end of this ramp used to be 0.72 — a very wide blend, chosen when
  // the far-field mask input came off an interpolated 25-100 m triangle and a
  // tight threshold would have crawled along the tessellation. It does not any
  // more: terrain.js reconstructs the field per pixel and the finest band
  // feeding steep is gated to stay above four pixels. A wide blend on a
  // well-resolved input just dissolves the snowline into grey mush.
  float rEdge = mix( 0.34, 0.50, smoothstep( 300.0, 2000.0, snViewDist ) );
  snRockMask = smoothstep( -rEdge, rEdge, rockRaw + rLedge * 1.5 ) * uRockAmount;

  // --------------------------------------------------------------- snow ----
  // Multi-scale relief.
  vec3 sw = snTriW( Ng, 2.0 );

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
    // The near-field falloff, in one line. This band ramped *in* between 2.5 and
    // 8 metres, so on the ground under a chase camera — 3 to 6 m away, the pixels
    // that fill the bottom third of every frame — it was running at a tenth to a
    // quarter strength, and it is the only high-frequency band that survives the
    // grazing incidence down there at all. Measured hp-RMS on that ground was
    // 2.9-5.0 against 15-27 in reference photography while the mid field, where
    // gS is 1, measured 19-38. Nothing about the band needs the ramp: it is
    // screen-locked, so its features are 7 px across at 3 m exactly as they are
    // at 3 km. It only has to be gone by the time the ground is inside the near
    // clip plane.
    float gS  = smoothstep( 0.45, 1.30, snViewDist );
    float gK  = 0.335 * gS;
    float gH  = 0.0;
    // Two octaves, not one. One octave of value noise *is* its lattice: a quintic
    // interpolation between four corners of a square grid, and the grid is there
    // in the output whether you can see it or not. At the contrast this band used
    // to carry you could not; at the contrast it carries now the near piste came
    // out woven into a visible plaid at exactly the seven-pixel cell size, which
    // is the single ugliest thing a screen-locked band can do. snFbm's cascade
    // rotates 37 degrees and scales 2.07 between octaves, so the second one lands
    // off-axis and off-period and the grid stops being legible. The finer pairs
    // below stay at one octave — their lattice is at or under four pixels, where
    // it is indistinguishable from grain.
    float a0 = gK * ( 1.0 - gLt ) / gF0, a1 = gK * gLt * 2.0 / gF0;
    detailLayer( P, sw, gF0,       a0, 1.0, 0.0, 2, grad, gH );
    detailLayer( P, sw, gF0 * 0.5, a1, 1.0, 0.0, 2, grad, gH );
    gGrain = gH / max( a0 + a1, 1e-6 );
    // The 28 px pair that used to sit here is gone, and the second octave above
    // is what replaces it. Two screen-locked pairs is four noise fetches per
    // fragment on the surface that fills two thirds of the frame, and measured
    // against the second octave it was the worse buy: 28 px is a scale the
    // world-space bands (the 5 m roller, the 2.4 m sastrugi) already cover
    // wherever they are resolvable, whereas 3.4 px is a scale nothing else in the
    // shader reaches at all.
    gGrain = clamp( gGrain, -1.6, 1.6 ) * gS;
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
  // Two traffic lines crossing at a shallow angle: nobody skis a piste in
  // single file, and one direction alone reads as a machine finish. Hoisted out
  // of the traffic block because the grooming below runs on the same corridor
  // axis and has to arc with the same shear.
  //
  // Everything from here to the end of the grooming block is gated on one cheap
  // predicate. It is all piste work — traffic, corduroy, pass lanes — and none of
  // it can reach a slope over about 30 degrees, bare rock, or anything past a
  // kilometre; but the shear costs eight transcendentals and it was being paid on
  // every pixel of every mountain in the frame. Hoisting the gate is worth 4 fps
  // on its own and is the reason the rest of this section can afford to exist.
  float pisteAmt = smoothstep( 0.52, 0.16, steep ) * ( 1.0 - snRockMask )
                 * snFade( 1900.0, 1200.0, snViewDist );
  float trackA = 0.0, corduA = 0.0, corduT = 0.0, corduG = 0.0;
  if ( pisteAmt > 2e-3 ) {
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
  // Unit world directions *across* each set of lines, which is the axis their
  // footprint has to be measured along.
  vec2 cA = normalize( xA + dA * eA ), cB = normalize( xB + dB * eB );
  // Traffic is patchy: the fall line and the inside of the turns get hammered,
  // the edges of the piste stay smooth for days. Without this the tracks read
  // as a machine finish laid over the whole mountain.
  float tp = clamp( snFbm( P.xz * 0.0068 + vec2( -3.4, 8.8 ), 3, 0.55 ).x * 1.5 + 0.62, 0.0, 1.0 );

  {
    float g = smoothstep( 0.46, 0.20, steep ) * ( 1.0 - snRockMask ) * tp;
    // Gated on the footprint across the lines, not on snPx. A 34 cm groove
    // running away from a chase camera is 34 cm on the screen's *horizontal*
    // axis whatever the ground foreshortening does vertically; snPx's 3:1 aniso
    // cap was retiring the near tracks at about 20 m, which is a large part of
    // why the near piste measured a third of the high-frequency energy of a
    // photograph while the mid field measured all of it.
    float w0 = SN_BAND_DIR( 0.34, cA, 2.6, 6.0 ) * snFade( 300.0, 14.0, snViewDist );
    float w1 = SN_BAND_DIR( 1.30, cB, 2.6, 6.0 ) * snFade( 1800.0, 45.0, snViewDist );
    float a0 = 0.060 * g * w0, a1 = 0.100 * g * w1;
    if ( a0 + a1 > 1e-4 ) {
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

  // --- grooming corduroy ------------------------------------------------------
  // The tiller on the back of a piste basher leaves a comb of parallel ridges
  // running with the machine's line of travel, in passes about 4 m wide. Side by
  // side with any photograph of a groomed piste it is the single most identifying
  // mark on the surface. The previous version of this block had it, and had it
  // wrong: across the whole mid field the piste read as a regular cross-hatched
  // lattice rather than fine parallel ridging.
  //
  // There was never a second crossing frequency in the code — the comb has always
  // been one cosine along one fixed axis. The plaid was *aliasing*. Three separate
  // mistakes stacked:
  //
  //  1. The pitch was 7.2 cm and the band gate let it run down to 3.6 px per
  //     period. A comb is not a noise band: all of its energy sits at exactly one
  //     frequency, so at 3.6 px/period it beats against the pixel grid and the
  //     beat fringes run at a completely different angle to the ridges. That
  //     cross-running fringe *is* the herringbone.
  //  2. smoothstep( 0.10, 0.72, cc ) squares the cosine up into very nearly a
  //     square wave. That is right in the near field, but it puts real energy at
  //     3x and 5x the comb frequency, so even where the fundamental was resolved
  //     the harmonics were not, and they folded.
  //  3. The occlusion weight was 0.62 / 0.40 — near full-scale modulation of
  //     snMicroAO — so every bit of that folded energy arrived at full contrast.
  //
  // So: pitch out to 12.5 cm (a real tiller comb is 10-15 cm, and it buys 1.7x
  // the pixels per period for free), amplitude gated at 5.5-12 px/period, and —
  // the parts that actually matter — the trough *sharpening* and both nonlinear
  // channels gated separately and later, at 9-19 px/period, so the profile has
  // degenerated to a pure sinusoid long before the fundamental itself is in any
  // danger. Contrast is then spent where it survives the tone curve, but at a
  // third of the old weight.
  //
  // The gate numbers are measured, not guessed. ppp was rendered to screen as a
  // false-colour map and each candidate was checked at 4x magnification in the
  // exact screen band where the comb fades: at 3.6 px/period the plaid is plainly
  // still there, at 4.7 it is faint but legible, at 5.5 it is gone. That is much
  // more headroom over Nyquist than a noise band needs, and it is the price of
  // the energy being concentrated at a single frequency.
  //
  // It runs along the *same fixed corridor axis* as the primary traffic set and
  // is bent by the same shear, so like the tracks it arcs but can never close
  // into a whorl. It is gated on the footprint measured across the ridges: a
  // groove pointed away from the camera is well resolved on the screen axis that
  // matters, and gating it on snPx would retire it three metres in front of the
  // skier.
  {
    // Machines groom the *piste*, not the mountain. The old mask was only
    // "shallow enough to drive", which is true of every bowl, bench and shoulder
    // in the map, so corduroy was being laid on ground no basher has ever seen.
    // This is the corridor centreline from terrain.js — two sines, duplicated
    // rather than plumbed through because it is cheaper than a varying and the
    // constants are part of the map, not of the terrain module's interface.
    // Full grooming within ~150 m of the fall line, gone by 330 m; off-piste snow
    // gets none of this at all.
    float ccx  = 78.0 * sin( P.z * 0.00092 ) + 34.0 * sin( P.z * 0.00231 + 1.3 );
    float corr = smoothstep( 330.0, 150.0, abs( P.x - ccx ) );
    // Coverage: grooming is laid in a session and is scuffed off unevenly. The
    // low-frequency term is which parts of the corridor got a pass at all, the
    // ~14 m term is where the day's traffic has scrubbed it out. Without a
    // coverage field this reads as a printed texture however good the profile is.
    float gm = smoothstep( 0.42, 0.14, steep ) * ( 1.0 - snRockMask ) * corr
             * clamp( 1.30 - tp * 0.75, 0.0, 1.0 );
    // Metres per pixel measured across the ridges, and from it the one number
    // this whole block is governed by.
    float pxC = SN_PX_DIR( cA );
    float LAM = 0.125;                       // ridge pitch, 12.5 cm
    float ppp = LAM / pxC;                   // pixels per ridge period
    // Amplitude gate: nothing at all below 5.5 px per ridge, full weight from 12.
    // By then the profile is guaranteed to be a plain sinusoid (see shrp below),
    // so what is being retired is a single clean frequency and it fades out
    // smoothly over a wide screen band rather than ending at a line. snFade is
    // only a backstop for grazing views where the footprint stays small much
    // further out than it has any business doing.
    float cw = smoothstep( 5.5, 12.0, ppp ) * snFade( 260.0, 60.0, snViewDist );
    float g  = gm * cw * sw.y;
    if ( g > 2e-3 ) {
      // The machine's line wanders. Offsetting the *cross* coordinate by a smooth
      // function of the along coordinate is a pure shear — invertible and
      // orientation-preserving — so the ridges bend with the operator's line but
      // can never close into a whorl or pinch the pitch to zero. One octave; this
      // only has to break the ruler-straightness.
      float wob = snFbm( vec2( uA * 0.019, 4.7 ), 2, 0.5 ).x * 1.15;
      float vG  = vA + wob;
      // Pass lanes, ~4.1 m wide, each laid on a different line with its own
      // phase. The step in phase at a lane edge is the overlap seam a groomer
      // leaves, and it is one of the things that stops corduroy reading as tiled.
      vec3  lh  = hash33( vec3( floor( vG * ( 1.0 / 4.1 ) ), 71.0, 13.0 ) );
      float ph  = ( vG * ( 1.0 / LAM ) + lh.x ) * 6.2831;
      float c   = cos( ph ), s = sin( ph );
      // Skied-out corduroy is gone corduroy; and a couple of tenths of the
      // corridor is scuffed to nothing on any afternoon.
      float scuff = clamp( snFbm( P.xz * 0.072 + vec2( 5.5, -2.2 ), 2, 0.55 ).x * 2.6 + 1.00, 0.0, 1.0 );
      float wear  = scuff * ( 1.0 - clamp( trackA * 0.9, 0.0, 0.55 ) ) * ( 0.78 + 0.34 * lh.z );
      float gA    = g * wear;
      // shrp is the harmonic budget, and it has to be computed before anything
      // *nonlinear* uses the comb. Occlusion is a linear read of the profile, so
      // it is safe anywhere the fundamental is resolved. Specular is not: a
      // GGX lobe is an exponential in the normal, so a 13 degree sinusoidal
      // tilt comes back with strong energy at 2x, 3x and 4x the comb frequency
      // however clean the tilt itself was. That was the entire residual plaid
      // after the profile was band-limited — a *specular* moire, not an albedo
      // one, and it lived exactly in the band where the comb was fading out.
      // Both of the nonlinear channels (the geometric normal, and the tiller
      // polish that goes through snIce into roughness and sparkle) are therefore
      // retired first, well above the fundamental's own limit; the occlusion
      // carries the last stretch on its own.
      float shrp = smoothstep( 9.0, 19.0, ppp );
      // Ridge height ~4.6 mm on a 12.5 cm pitch. Its world gradient is exact to
      // within the shear derivative of wob, which is 2% of the cross-ridge term
      // and is dropped: d(ph)/dP is 2pi/LAM * ( xA + dA * eA ).
      float amp = 0.0046 * gA * shrp * ( 0.75 + 0.5 * lh.y );
      vec2  gw  = ( -amp * s ) * ( ( xA + dA * eA ) * ( 6.2831 / LAM ) );
      grad += vec3( gw.x, 0.0, gw.y ) * sw.y;
      // Sunlit snow sits on the shoulder of the tone curve, where a few degrees
      // of normal tilt is worth well under one code value, so the groove floors
      // also have to arrive as occlusion, which is multiplicative and survives
      // the shoulder. Crests get the reciprocal: the tiller polishes them.
      //
      // A tiller leaves a broad rounded crest and a narrow shaded trough — a
      // near-square wave — and that is what you see from two metres away. From
      // twenty it has to be a plain cosine, because the odd harmonics of a square
      // wave sit at 3x and 5x the comb frequency and there is nowhere near the
      // resolution for them, so shrp buys the shaping back only where it is paid
      // for. Below it the profile is a single sinusoid, which cannot fold.
      float cc   = 0.5 - 0.5 * c;                                  // 0 crest .. 1 trough
      corduA = mix( cc,       smoothstep( 0.14, 0.76, cc ),       shrp ) * gA;
      corduT = mix( 1.0 - cc, smoothstep( 0.16, 0.68, 1.0 - cc ), shrp ) * gA;
      corduG = corduT * shrp;                       // gloss: nonlinear, near field only
    }
    // The 4.1 m *pass* is thirty times coarser than the comb inside it and stays
    // resolvable well past the range where the comb has had to be gated away. On
    // a real piste that is what you actually read at distance: not the individual
    // ridges but the alternating bands where one pass of the machine met the
    // next, and the seam between them. It is what carries the mid field now that
    // the comb correctly stops there.
    float lw = SN_BAND_DIR( 4.1, cA, 3.0, 7.0 ) * snFade( 700.0, 100.0, snViewDist );
    float lg = gm * lw * sw.y;
    if ( lg > 2e-3 ) {
      float lu = vA * ( 1.0 / 4.1 );
      float li = floor( lu ), lf = lu - li;
      float seam = 1.0 - smoothstep( 0.0, 0.16, min( lf, 1.0 - lf ) * 2.0 );
      float wear = 1.0 - clamp( trackA * 1.2, 0.0, 0.8 );
      corduA += seam * 0.46 * lg * wear;
      corduT += ( hash33( vec3( li, 5.0, 29.0 ) ).x - 0.5 ) * 0.42 * lg * wear * ( 1.0 - seam );
    }
  }
  }

  // Micro-occlusion. gGrain is the one band guaranteed to be four to eight pixels
  // across at *any* range, so in the near field — where the world-scale sub-metre
  // bands have all been gated off by their own footprint — it is very nearly the
  // only carrier of high-frequency energy left. Measured hp-RMS on the near piste
  // was 5.0 against 15-27 in reference photography, and a weight of 0.15 on the
  // negative half of that one term is a large part of why. Occlusion is the
  // channel that survives the tone-curve shoulder, so that is where the contrast
  // is spent: the weight is up to 0.34 and the floor down to 0.34 with it.
  // Two-sided, and that is not a licence to cheat. Roughly two thirds of the
  // contrast this term now carries is new, and hanging all of it on the dark side
  // of 1.0 took the mean down with it — the near piste lost 29 code values of
  // luminance, which is a bigger change than the texture it bought. A convex
  // crest between two troughs genuinely sees more than a flat surface does: the
  // whole sky dome plus bounce off the trough walls either side of it. So the
  // crests are allowed a modest lift and the mean stays where the last gate
  // measured and signed it off.
  float aoDark = 0.30 * clamp( 0.45 - fineNorm * 0.75, 0.0, 1.0 )
               + 0.16 * clamp( -relief * 1.6, 0.0, 1.0 )
               + 0.52 * clamp( -gGrain * 1.30, 0.0, 1.0 )
               + 0.26 * trackA
               + 0.42 * corduA;
  // Was 0.62 / 0.40, which is very nearly full-scale modulation of snMicroAO
  // from a single periodic term, and is why the corduroy drew the eye across the
  // whole frame instead of sitting under everything else on the surface. A real
  // corduroy trough in a photograph is a couple of stops on a surface that is
  // already sitting on the shoulder of the curve, and the near field still gets
  // that because the profile is sharpest exactly there.
  float aoLift = 0.40 * clamp( gGrain * 1.30, 0.0, 1.0 )
               + 0.26 * corduT;
  snMicroAO = clamp( 1.0 + aoLift - aoDark, 0.26, 1.32 );
  relief += fine;

  // Convex wind lips get scoured to ice; hollows collect powder.
  // The relief accumulator is in *metres*, and the coarse bands carry several of them, so it
  // has to enter bounded — otherwise every drift bigger than a wheelbarrow
  // saturates the ice term and the snow comes out as blue satin combing.
  snIce = clamp( ( curv * 1.5 + wind * 0.55 - 0.22 ) * 1.6
                 + clamp( relief * 0.4, -0.45, 0.45 ), 0.0, 1.0 );
  snIce = smoothstep( 0.18, 0.85, snIce ) * smoothstep( 0.06, 0.30, slope ) * dFar;
  // The tiller polishes the crest of every corduroy ridge and leaves the trough
  // as loose tilled snow. That is a real, and quite strong, gloss difference —
  // it is why fresh corduroy flashes at you as you traverse it — and running it
  // through snIce gets the roughness, the sparkle boost and the faintly bluer
  // albedo all at once.
  // snIce drives roughness, the sparkle boost and a faintly bluer albedo all at
  // once, and the sparkle is a stochastic per-pixel glint. Modulating a
  // stochastic term with a near-Nyquist comb is how you manufacture shimmer, so
  // this contribution is a third of what it was; the gloss flash is still there
  // in the near field, where the comb is resolved several times over.
  snIce = clamp( snIce + corduG * 0.20 - corduA * 0.07, 0.0, 1.0 );
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
  // Reflectance is the one channel that works in shadow. Everything above this
  // line that carries near-field texture — micro-occlusion, the sheen, the
  // sparkle — is modulating the *sun*, so on the shadowed foreground of ridge.png
  // it buys nothing at all, and that slab measured hp-RMS 2.9 against 15-27 in
  // reference photography. Real snow does have this variation: freshly tilled or
  // wind-broken snow scatters a few percent more than a polished or refrozen
  // surface, and at 85% albedo a few percent is several code values. Deliberately
  // small — snow albedo genuinely does not vary much, and the moment this gets
  // big enough to see as *paint* it stops looking like snow.
  float snMicroTex = clamp( gGrain * 0.62 + corduT - corduA, -1.0, 1.0 );
  snowAlb *= 1.0 + snMicroTex * 0.095;

  // Two rock types, interleaved in broad geological units: a cool grey granite
  // and a warmer buff limestone. Which one you are standing on is the single
  // biggest cue that the mountain is made of something.
  vec3 rockFace = mix( uRockHi, uRockWarm, unit );
  float bandMix = clamp( 0.5 + strata * 0.32 + rip.x * 0.26 + lamin * 0.14
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
  // rGrain is applied as its own factor rather than folded into the clamp above,
  // which saturates for most of a face and would swallow it. It is the only term
  // with any high-frequency content left at a kilometre, and reflectance is the
  // only channel that can carry texture on a face seen edge-on: a normal
  // perturbation there moves the pixel by well under one code value.
  rockAlb *= clamp( 1.0 + rGrain * 0.62, 0.28, 1.75 );
  // Flutes. A big face is organised into vertical chimneys, water streaks and
  // rubble ramps running down the fall line, and that lineation is most of what
  // the eye reads a distant wall by. The streak field is already computed for the
  // snowline; feeding it into reflectance as well costs nothing and is the other
  // half of breaking the even pebbled quilt.
  rockAlb *= clamp( 1.0 + strk.x * 0.62 * smoothstep( 0.50, 1.00, steep ), 0.42, 1.60 );
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
  snRockAO = mix( 1.0, clamp( 0.30 + rFrac * 3.4 + rLedge * 0.45 + rGrain * 0.20, 0.16, 0.92 ), snRockMask );
  // How deep in a crack this pixel is, as a *signed, zero-mean* quantity rather
  // than as snRockAO — which averages 0.30 and is therefore a blanket darkening
  // with texture on it, not a recess mask. Using snRockAO to decide where the
  // sun is occluded painted three quarters of every face as a pit. This is the
  // negative half of the fracture field only: cracks, joints and the shaded side
  // of a slab, which is where the sun genuinely cannot reach.
  snRockPit = clamp( -rFrac * 5.5 - rGrain * 0.42 - rLedge * 0.55, 0.0, 1.0 ) * snRockMask;

  diffuseColor.rgb = mix( snowAlb, rockAlb, snRockMask );

  // --- distant forest ---------------------------------------------------------
  // Instanced trees stop at 1.24 km (scatter.js R_FAR), so beyond that every
  // forested flank in the world was rendering as bare snow. That is most of why
  // the ranges across the valley came back as one pale mass: on a real range the
  // band below the treeline is near-black conifer, and the dark skirt under a
  // white summit is what makes the summit read as a summit. Measured against
  // alpine reference photography, a massif at 5-10 km spans nearly the full
  // value range — ours spanned about a fifth of it.
  //
  // This is canopy *albedo* only: no geometry, no normals, no shadowing. It
  // starts where the instanced stands end, so the two never overlap.
  float fFor = smoothstep( 1250.0, 1850.0, snViewDist ) * uForestAmount;
  if ( fFor > 0.004 ) {
    // Same treeline the scatter uses, with the same order of aspect wobble: it
    // rises on the sunny side and drops on the shaded, and it is ragged.
    float tLine = uTreeLine + gu.x * 165.0 + rn2.x * 85.0 - Ng.z * 85.0;
    float below = smoothstep( tLine + 50.0, tLine - 200.0, P.y );
    // Conifers do not grow on bedrock, and avalanche paths keep the gullies
    // swept: the stands break into fingers and clearings, which is exactly the
    // texture a distant forest reads by.
    float canGrow = smoothstep( 1.08, 0.62, steep ) * ( 1.0 - snRockMask * 0.85 );
    vec3  fnA = snFbm( P.xz * 0.0085, 3, 0.5 );
    vec3  fnB = snFbm( P.xz * 0.034, 2, 0.5 );
    float cover = clamp( 0.62 + fnA.x * 1.8 + fnB.x * 0.85, 0.0, 1.0 );
    float forest = fFor * below * canGrow * cover;
    if ( forest > 0.003 ) {
      // Snow-laden crowns in the open, near-black closed canopy in the stands.
      // These values look implausibly dark written down and are not: a closed
      // spruce canopy reflects 4-8% and reads almost black against snow, which
      // is the whole point — it is the only thing in the frame that can hold the
      // bottom of the histogram out at four kilometres.
      vec3 canopy = mix( vec3( 0.018, 0.026, 0.022 ),
                         vec3( 0.105, 0.128, 0.120 ),
                         clamp( 0.30 + fnB.x * 1.1, 0.0, 1.0 ) );
      diffuseColor.rgb = mix( diffuseColor.rgb, canopy, forest * 0.94 );
      snRockAO = min( snRockAO, mix( 1.0, 0.62, forest ) );
      snIce *= 1.0 - forest * 0.9;
      snPowder *= 1.0 - forest * 0.9;
    }
  }

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
  // — but the *chroma* is hard-clamped, not merely lerped towards neutral.
  //
  // A single-pixel highlight at 45x white is exactly the input that turns a
  // downstream chromatic-aberration or bloom pass into coloured confetti: the
  // pass fetches R and B from opposite sides of the speck and lays down a
  // saturated red pixel on one side and a saturated blue one on the other. Any
  // tint the sparkle carries of its own is added on top of that. Lerping 60% of
  // the way to luminance still left 40% of the sun's chroma on a value that
  // reaches 45, so the residual was worth several tens of code values.
  //
  // Normalising to unit luminance and then clamping each channel to 0.85-1.15
  // bounds the sparkle's own chroma at 15% of neutral by construction, whatever
  // colour the sky module gives the sun. The magnitude cap comes down with it:
  // 17 still clips to a white point through ACES with three stops to spare, and
  // more than halves the headroom a chromatic-aberration pass has to fringe.
  float sp = clamp( snSparkle( vSnowWPos, N, H, snViewDist ), 0.0, 1.0 );
  float spFade = snFade( 260.0, 45.0, snViewDist );
  float spLum = snLum( C );
  vec3 spColor = spLum * clamp( C / max( spLum, 1e-4 ), vec3( 0.85 ), vec3( 1.15 ) );
  reflectedLight.directSpecular += spColor * min( sp * uSparkle, 17.0 ) * spFade * shd
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
  // 0.55, up from 0.30. This is the *only* channel that puts high-frequency
  // structure into snow that the sun cannot reach, and shadowed snow is a third
  // of every frame: the shadowed slab in the ridge framing measured hp-RMS 2.9
  // against 15-27 in reference photography, because every other texture term in
  // this shader multiplies the sun. A pit between sastrugi genuinely does see a
  // small fraction of the sky dome, so this is also the physically honest number
  // — the old one was chosen when the micro-relief had far less contrast in it.
  reflectedLight.indirectDiffuse *= mix( vec3( 1.0 ), tint, snowness )
    * pitTint * ( 1.0 - 0.55 * pit );
  // Snow in shadow is *bright* — it sees the whole sky dome and eats bounce
  // from every lit slope around it. Without this term, shadowed snow crushes
  // to a dark saturated violet, which is the single most common tell of a
  // shader that treated snow as an opaque diffuse surface.
  // ...and it has to be occluded too, or it flattens everything above it. This
  // is the *dominant* term on shadowed snow — additive, and until now completely
  // unmodulated — so on ground the sun cannot reach it swamped every textured
  // term in the shader. The shadowed foreground slab measured hp-RMS 2.9 while
  // the same shader was putting plenty of structure into snMicroAO on exactly
  // those pixels; raising the micro-occlusion moved that number by 0.02, which is
  // what pointed here. A hollow between sastrugi sees less of the surrounding
  // snowfield as well as less sky, so this is the honest thing to do. Re-centred
  // on the mean pit depth so the overall level of the shadows does not move —
  // that level was measured and signed off by the last gate and must not shift.
  float bnc = clamp( 1.0 + 0.72 * ( 0.24 - pit ), 0.30, 1.40 );
  reflectedLight.indirectDiffuse += diffuseColor.rgb * uShadeTint * snowness
    * ( 0.08 + 0.40 * ( 1.0 - lit ) ) * bnc;
  reflectedLight.directDiffuse *= snMicroAO * mix( 1.0, snMicroAO, 0.6 );

  // --- snow bounce onto rock -------------------------------------------------
  // Both terms above are multiplied by snowness, so bedrock was getting the
  // raw, essentially neutral environment irradiance and nothing else. Shadowed
  // rock measured (50,56,61) sRGB — B-R = +11, i.e. grey. A cliff standing in a
  // snowfield does not see a grey world: above it is a deep blue winter sky and
  // below and around it are hundreds of square metres of 85%-albedo snow under
  // full sun, throwing a very strong blue-white bounce up onto every face that
  // is turned away from the sun. That single missing term is most of the
  // difference between "photograph of a mountain" and "grey CG rock".
  //
  // Additive, not a tint: the rock albedo is 2-8%, so modulating what is already
  // there can only move the hue by a percent or two. It scales with (1 - lit),
  // so lit faces keep the sun's warmth, and with the same cavity occlusion the
  // rest of the rock lighting uses, so chimneys stay dark.
  //
  // Measured on reference photography of shadowed rock standing in snow —
  // Annapurna South at 1920 px, darkest half of the shadowed ridge: (36,52,72),
  // B-R = +37, G-R = +16; a Valloire ridge: (41,64,78), B-R = +37. The gate's
  // target of (48,62,86) sits in the middle of that. The bounce colour is
  // therefore weighted *away* from red — the snow-and-sky hemisphere a shadowed
  // face sees has almost no long-wavelength content left in it after two
  // bounces off snow under a blue sky.

  // Rock. Cavity occlusion from the crack field, and an actual specular
  // response: bedrock was the only thing in the frame that never caught a
  // highlight, which is most of why it read as untextured clay. Wet gullies get
  // the strongest lobe, freshly split faces the next.
  //
  // The occlusion is *directional*, and that is the whole ball game for the
  // colour of a rock face. A crack, a chimney or the underside of a slab hides
  // the sun — a half-degree collimated source that has to be in line of sight —
  // long before it hides the sky, which is a hemisphere and leaks round every
  // corner. Attenuating both by the same snRockAO made every recess a neutral
  // grey dent, and that is the direct reason the darkest half of a rock face
  // measured B-R = +11 where reference photography measures +37: in a photograph
  // those recesses are lit by sky and snow bounce and by nothing else, and both
  // of those are blue. Squaring the term on the sun while holding the sky back
  // to a gentle ramp is the entire difference, and it costs nothing.
  reflectedLight.indirectDiffuse *= mix( snRockAO, 0.30 + 0.70 * snRockAO, snRockMask );
  if ( snRockMask > 0.004 ) {
    // A *tint*, not an additive wash. The first attempt at this added saturated
    // blue irradiance on top of the rock and the cliff came back navy: the rock
    // stopped being a material and became a blue shape, because an additive term
    // that does not pass through a 2-8% albedo is not light, it is paint.
    //
    // The reference measurements say the correct operation is a hue rotation at
    // roughly constant luminance. Annapurna's shadowed ridge and ours have the
    // same darkest-half luminance; what differs is that the reference has 1.8x
    // the blue and 0.7x the red. Shadowed rock is lit by the sky and by snow
    // bounce and by nothing else, and both of those are blue — so the *amount*
    // of light is right and only its colour was wrong.
    //
    // Coefficients are measured against that ratio, applied to uShadeTint so the
    // term still tracks whatever the sky module does with the shadow colour.
    // Normalised to unit luminance first. uShadeTint is a *colour*, and its
    // magnitude is the sky module's business — it ships at (0.60,0.71,1.14) and
    // arrives here at (0.30,0.355,0.57). Using it raw as a multiplier therefore
    // halved the rock instead of rotating its hue, which is how the first
    // attempt at this turned the cliff into a dark navy silhouette. Only the
    // ratio is wanted; the level must not move.
    vec3 skyHue = uShadeTint / max( snLum( uShadeTint ), 1e-4 );
    vec3 rockSky = skyHue * vec3( 0.84, 1.23, 1.52 );
    // Driven by the cavity term as well as by the terminator: on a face that is
    // nominally in the sun, the parts that read dark are the parts the sun
    // cannot reach, and those are exactly the parts that should be blue.
    float pitR = snRockPit;
    float shade = snRockMask * max( 1.0 - lit, pitR );
    reflectedLight.indirectDiffuse *= mix( vec3( 1.0 ), rockSky, shade );
    // Sky above, snowfield below — a near-vertical face sees both, an overhang
    // sees mostly the snow. Never zero: there is snow on every side of a rib.
    // snNormalW, not N: N is in view space here, and this term is about which
    // way the face is turned in the *world*.
    float openness = 0.62 + 0.38 * clamp( snNormalW.y * 0.5 + 0.5, 0.0, 1.0 );
    // The genuinely additive part: multiple scattering out of a snow bowl, which
    // does pass through the albedo. Only half-occluded by the cavity term — a
    // chimney is shielded from the sky but is still surrounded by snow.
    reflectedLight.indirectDiffuse += diffuseColor.rgb * skyHue * skyHue
      * snRockMask * openness * mix( 0.55, 1.0, snRockAO )
      * ( 0.08 + 0.62 * max( 1.0 - lit, pitR ) );
  }
  // Mildly, not squared: snRockAO already averages 0.30, so a square on top of
  // that took the whole face to a twelfth of the sun and the cliff went black.
  reflectedLight.directDiffuse *= mix( 1.0, 0.45 + 0.55 * snRockAO, snRockMask );
  reflectedLight.directSpecular *= mix( 1.0, snRockAO, snRockMask );
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
 * @param {boolean} [opts.forest=true]  painted canopy past the tree instancer
 * @param {number}  [opts.treeLine=662] metres; must match scatter.js TREELINE
 * @param {object} [opts.uniforms]      extra uniforms merged into the program
 */
export function createSnowMaterial(opts = {}) {
  const {
    displacement = null,
    rock = true,
    forest = true,
    treeLine = 662,
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
    // Painted canopy for the ground the tree instancer cannot reach. TREELINE is
    // scatter.js's constant; the two have to agree or a stand ends in mid-air.
    uForestAmount: { value: forest ? 1.0 : 0.0 },
    uTreeLine: { value: treeLine },
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
