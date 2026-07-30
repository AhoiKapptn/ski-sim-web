import * as THREE from 'three';

/**
 * Sky, atmosphere, lighting and aerial perspective.
 *
 *   createSky(scene, renderer) -> { sun, setTimeOfDay(t), update(dt, state) }
 *
 * Everything is derived from one number: the solar position for time-of-day `t`.
 * From that we drive
 *   - an analytic Preetham-based sky dome, art-graded for high-altitude alpine air
 *   - a real sun disc with limb darkening
 *   - the directional light colour/intensity (physical atmospheric extinction)
 *   - image-based lighting: a PMREM of the sky, including snow bounce below the horizon
 *   - height + aerial-perspective fog with Henyey-Greenstein forward scattering
 *   - exposure
 *
 * The whole model is implemented twice: once in GLSL for the dome, once in JS so
 * fog colour, ambient and cloud lighting are read straight out of the same sky
 * rather than hand-picked. Aerial perspective samples that sky in three
 * directions and interpolates along the view ray, so a distant ridge fogs
 * toward the colour of the sky it is actually standing in front of.
 *
 * The numbers in here are not taste. They are measured with
 * tools/skylight-probe.mjs, which renders the *whole real scene* into a Float32
 * target, then renders it a second time with the key light switched off and
 * reads the same pixels again. Key-to-fill is therefore a measurement of one
 * surface under two conditions rather than a comparison of two guesses, and it
 * cannot be fooled by picking a flattering pixel. The contract, at the default
 * sun (23 deg), median over the hero / closeup / steep framings:
 *
 *     sunlit horizontal snow          1.00 linear, B/R 1.00   (neutral, not blue)
 *     the same pixels, key off        0.155 linear, B/R 2.58  (skylight, blue)
 *                                     -> 6.4 : 1, 2.7 stops, 129 display codes
 *     snow in a real cast shadow      0.14 linear, B/R 2.48 -> disp 83,89,108
 *                                        (blue, and it does NOT crush to black)
 *     cloud base / cloud top          0.08-0.24 of top radiance
 *     sky zenith / horizon            0.20 / 0.40 linear, B/R 4.9 / 1.9
 *     solar disc                      2.5-3.4 linear, reddening at dusk
 *
 * The number that actually decided how the mountain reads was none of those: it
 * was the *shadow frustum*, which used to be +/-95 m. Nothing past 95 metres
 * cast a shadow at all, so 85% of the snow in the hero framing sat inside a
 * 0.2-stop band of received sunlight and 0% was in shade. Sun/shade separation
 * measured 11 code values because there was no shade in the frame to measure.
 *
 * AERIAL PERSPECTIVE has its own contract, measured with tools/sky-ap-probe.mjs,
 * which raymarches terrain.height() through every 8th pixel to get a real
 * per-pixel distance, then buckets the framebuffer by that distance and splits
 * the far bucket by n.l into sunlit and shaded faces. The thing it exists to
 * stop is a distant ridge collapsing to one flat value:
 *
 *     2.5-4 km ridge, lit vs shaded   21-28% internal luminance variation
 *     2.5-6 km ridge                  B/R 1.45  (near sunlit snow: 1.03)
 *     far ridge vs the sky above it   48-77 display codes DARKER (never inverts)
 *     terrain haze fraction f         0.38 at 3 km, 0.55 at 5 km
 *
 * For scale: at the previous aerialDensity the same measurement read 3.1%, i.e.
 * the massif was a single flat tone, which is what "cardboard cutout" means
 * numerically. Reference for the target is a real 2000 m winter panorama
 * (Bürstegg), where a 5 km ridge measures 24% between its lit and shaded faces.
 *
 * No textures, no assets, no dependencies beyond `three`.
 */

// ---------------------------------------------------------------------------
// Atmosphere constants (identical in JS and GLSL)
// ---------------------------------------------------------------------------
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;
const EE = 1000.0;
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const LUM = [0.2126, 0.7152, 0.0722];

// Dome look. Very low turbidity + boosted Rayleigh = thin, clean 2000 m air.
// The Mie terms are deliberately small: an aerosol lobe big enough to be worth
// looking at also drives the sky within 15 deg of the sun several times over
// white, and then the solar disc — which is the thing that is supposed to be
// the brightest object in the frame — has nothing to stand out against.
const TURBIDITY = 1.85;
const RAYLEIGH = 2.45;
const MIE_COEF = 0.0025;
const MIE_G = 0.77;

// Calibration: Preetham's arbitrary units -> "1.0 == diffuse white in full sun".
// Everything else (sun intensity, IBL, fog) lives in this space.
const SKY_CALIBRATION = 0.132;

// Physically honest coefficients, used only for the *sun's own* colour so the
// key light reddens correctly at low elevation instead of being art-boosted.
const RAYLEIGH_SUN = 1.0;
const MIE_COEF_SUN = 0.005;

// ---------------------------------------------------------------------------
// Key / fill balance. This is the single most important number in the file.
//
// On a clear day at 2000 m the direct beam puts ~450 W/m2 on horizontal snow
// and the whole sky dome puts ~90. That is the 5:1 the render has to show.
// Measured with tools/skylight-probe.mjs, which renders the *actual* scene into
// a Float32 target and reads the same snow pixels twice — once as rendered and
// once with the key light switched off — so key:fill is a measurement of one
// surface, not a comparison of two guesses:
//
//     horizontal sunlit snow            ~1.00 linear
//     the same pixels, key light off    ~0.16 linear   -> 6.2:1, 2.6 stops
//
// SUN_PEAK is set so the first number lands on 1.00: at the default sun,
// albedo 0.85 / PI * sin(elev) * SUN_PEAK * expo == 0.83, plus 0.16 of fill.
const SUN_PEAK = 6.80;         // peak key light; ~0.85 linear direct on flat snow
// The fill is deliberately weighted toward the *IBL* rather than toward
// snow-material's hard-coded snow-only ambient: the IBL lights the conifers, the
// rock and the skier too, so raising it and taking the same amount back out of
// SHADE_FLOOR_SCALE keeps snow shadows on their number while stopping the
// forest from reading as a black cut-out.
const ENV_INTENSITY = 0.46;    // PMREM sky dome as ambient — the fill

// The hemisphere light is gone from the lighting solution. With a working PMREM
// it is double counting, and it was measured contributing 0.003 linear (1% of
// the fill) for the privilege. It stays in the scene graph, `visible = false`,
// because fx/spray.js looks a HemisphereLight up to colour its powder ambient:
// three's projectObject skips invisible lights, Object3D.traverse does not, so
// spray keeps a physically-derived sky colour and the PBR path never sees it.
const SPRAY_HEMI_INTENSITY = 0.75;

// snow-material.js adds a hard-coded ambient to every snow pixel:
//     indirectDiffuse += albedo * uShadeTint * ( 0.08 + 0.40 * (1 - lit) )
// which is 0.234 linear in shadow — on its own already above the 0.14-0.20 a
// real cast shadow sits at, and completely deaf to the sky. It is published as
// `material.userData.snowUniforms.uShadeTint`, so rather than let one hard-coded
// constant set the floor of the whole image, sky.js scales it: the *hue* stays
// exactly as snow-material authored it (this is a scalar multiply, so B/R is
// untouched), only the level is brought into line with the sky the dome is
// actually drawing. Set to 1 to hand the floor back.
//
// It multiplies the IBL term on shadowed snow as well (`tint` in SNOW_SCATTER),
// so the effective fill scales slightly faster than this number.
const SHADE_FLOOR_SCALE = 0.50;

// Solar disc radiance before exposure. The dome multiplies by SKY_CALIBRATION,
// so 13.0 lands the centre of the disc at ~1.7 linear: over white, so it still
// blooms and reads as the brightest thing in frame, but not the 12x it used to
// be, which clipped the limb darkening and the sunset reddening flat.
const SUN_DISC_GAIN = 13.0;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep01 = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Global fog upgrade
//
// three's built-in fog is a flat distance lerp. We swap the fog ShaderChunks for
// a single-scattering model: exponential *height* fog, per-channel extinction
// (aerial perspective / blue shift), a Henyey-Greenstein forward-scattering
// term so haze glows when you look toward the sun, and — the part that makes it
// read as depth rather than as a wash — a *direction-dependent* inscatter term
// reconstructed from three samples of the same graded sky the dome draws
// (horizon toward the sun / horizon away from it / upper sky). A distant object
// therefore fogs toward the colour of the sky it is actually standing in front
// of, not toward one global constant.
//
// The extra parameters ride in one `uniform vec4 fogAP[7]`. A Float32Array
// uniform value is neither a three object nor a plain Array, so cloneUniforms()
// copies it *by reference* — a single array shared by every material in the
// scene, updated once per frame with zero per-material bookkeeping.
// ---------------------------------------------------------------------------
const FOG_AP = new Float32Array(28);
const FOG_AP_UNIFORM = { value: FOG_AP };

let fogPatched = false;
function patchFog() {
  if (fogPatched) return;
  fogPatched = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
#endif`;

  // world = inverse(viewMatrix) * mvPosition. The view rotation is orthonormal,
  // so transpose == inverse, and `v * mat3(m)` is exactly transpose(mat3(m)) * v.
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldPos = cameraPosition + mvPosition.xyz * mat3( viewMatrix );
#endif`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  uniform vec4 fogAP[ 7 ];
#endif`;

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
{
  float apSigma = fogAP[ 0 ].x;
  if ( apSigma > 0.0 ) {

    vec3  camToFrag = vFogWorldPos - cameraPosition;
    float dist      = max( length( camToFrag ), 1e-4 );
    vec3  vdir      = camToFrag / dist;

    float invH   = fogAP[ 0 ].y;
    float yRef   = fogAP[ 0 ].z;
    float dStart = fogAP[ 0 ].w;
    vec3  ext    = fogAP[ 1 ].xyz;
    float g      = fogAP[ 1 ].w;
    vec3  sunDir = fogAP[ 2 ].xyz;
    float sunAmt = fogAP[ 2 ].w;
    vec3  sunHaze= fogAP[ 3 ].xyz;
    float maxFog = fogAP[ 3 ].w;

    // analytic integral of sigma0 * exp( -(y - yRef) / H ) along the view ray
    float d  = max( dist - dStart, 0.0 );
    float dy = ( vFogWorldPos.y - cameraPosition.y ) * ( d / dist );
    float k  = dy * invH;
    float seg = ( abs( k ) < 1e-3 ) ? 1.0 : ( 1.0 - exp( -k ) ) / k;
    float tau = apSigma * d * exp( -( cameraPosition.y - yRef ) * invH ) * seg;
    tau = clamp( tau, 0.0, 40.0 );

    vec3 T = max( exp( -tau * ext ), vec3( 1.0 - maxFog ) );

    float ct = dot( vdir, sunDir );
    float g2 = g * g;
    float hg = ( 1.0 - g2 ) / ( 12.5663706 * pow( max( 1.0 + g2 - 2.0 * g * ct, 1e-4 ), 1.5 ) );

    // Direction-dependent inscatter: the graded sky radiance along the view
    // ray, reconstructed from three probes of the dome. Warm toward the sun,
    // cool away from it, and falling off toward the (much darker) upper sky, so
    // a ridge seen against the zenith fogs to something darker than one seen
    // against the horizon.
    vec3  hazeCool = fogAP[ 4 ].xyz;
    vec3  hazeWarm = fogAP[ 5 ].xyz;
    vec3  hazeUp   = fogAP[ 6 ].xyz;
    vec2  sunAz    = vec2( fogAP[ 4 ].w, fogAP[ 5 ].w );

    float hl  = length( vdir.xz );
    float caz = ( hl > 1e-4 ) ? dot( vdir.xz / hl, sunAz ) : 0.0;
    vec3  band = mix( hazeCool, hazeWarm, smoothstep( -0.55, 0.90, caz ) );
    vec3  inscat = mix( band, hazeUp, smoothstep( 0.0, 0.42, vdir.y ) );
    inscat += sunHaze * clamp( hg * sunAmt, 0.0, 8.0 );

    gl_FragColor.rgb = gl_FragColor.rgb * T + inscat * ( 1.0 - T );

    // A sub-LSB dither; without it huge smooth snow gradients band visibly.
    float dth = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    gl_FragColor.rgb += ( dth - 0.5 ) * 0.0022;

  } else {

    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    // NB: scene.fog.color is deliberately stored display-encoded (see the note
    // in apply()), so it has to be decoded before it can be mixed with light.
    vec3 fogLin = pow( max( fogColor, 0.0 ), vec3( 2.2 ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogLin, fogFactor );

  }
}
#endif`;

  // Make the shared uniform reachable from every built-in material. Built-in
  // materials clone ShaderLib[...].uniforms when their program is first built,
  // which happens long after this module is evaluated.
  if (THREE.UniformsLib.fog) THREE.UniformsLib.fog.fogAP = FOG_AP_UNIFORM;
  for (const key of Object.keys(THREE.ShaderLib)) {
    const u = THREE.ShaderLib[key].uniforms;
    if (u && u.fogColor && !u.fogAP) u.fogAP = FOG_AP_UNIFORM;
  }
}
patchFog();

// ---------------------------------------------------------------------------
// Sky dome shader
// ---------------------------------------------------------------------------
const SKY_VERT = /* glsl */ `
varying vec3 vWorldPosition;
void main() {
  vWorldPosition = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position.z = gl_Position.w;   // pin to the far plane
}`;

const SKY_FRAG = /* glsl */ `
precision highp float;

uniform vec3  uSunDir;
uniform vec3  uBetaR;
uniform vec3  uBetaM;
uniform float uSunE;
uniform float uMieG;
uniform float uExposure;

uniform vec3  uSunTint;        // peak-normalised sun colour (aureole, glow)
uniform vec3  uSunDiscTint;    // *un*-normalised transmittance: the disc reddens
uniform float uDiscGain;       // solar disc radiance, pre-exposure
uniform vec3  uHorizonTint;    // luminance-preserving horizon tint, toward the sun
uniform vec3  uHorizonTintCool; // ... and away from it (Belt of Venus at dusk)
uniform vec2  uSunAz;          // normalised sun azimuth
uniform vec3  uZenithTint;     // multiplier that deepens the zenith
uniform vec3  uGroundColor;    // below-horizon valley haze / snow bounce
uniform float uNightAmount;
uniform vec3  uNightZenith;
uniform vec3  uNightHorizon;

uniform float uSunDisc;        // 1 = draw the disc, 0 = environment capture
uniform float uEnvMode;        // 1 = cheaper clouds, brighter ground bounce
uniform float uTime;
uniform float uCoverage;
uniform float uCloudDensity;
uniform float uCirrus;
uniform vec3  uCloudSun;       // linear sun radiance reaching cloud tops
uniform vec3  uCloudAmb;       // anti-solar upper sky: the light on flanks/bases
uniform vec3  uCloudBase;      // multiplier for a fully self-shadowed base

varying vec3 vWorldPosition;

const float PI = 3.141592653589793;
const vec3  UP = vec3( 0.0, 1.0, 0.0 );
const vec3  LUMW = vec3( 0.2126, 0.7152, 0.0722 );

float hgPhase( float ct, float g ) {
  float g2 = g * g;
  return ( 1.0 / ( 4.0 * PI ) ) * ( 1.0 - g2 ) / pow( max( 1.0 + g2 - 2.0 * g * ct, 1e-4 ), 1.5 );
}

// ---- procedural noise ------------------------------------------------------
float hash21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float vnoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  float a = hash21( i );
  float b = hash21( i + vec2( 1.0, 0.0 ) );
  float c = hash21( i + vec2( 0.0, 1.0 ) );
  float d = hash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

const mat2 M2 = mat2( 0.80, 0.60, -0.60, 0.80 );

float fbm2( vec2 p ) {
  float s = 0.0, a = 0.5;
  for ( int i = 0; i < 2; i ++ ) { s += a * vnoise( p ); p = M2 * p * 2.07; a *= 0.5; }
  return s * 1.3333;
}
float fbm3( vec2 p ) {
  float s = 0.0, a = 0.5;
  for ( int i = 0; i < 3; i ++ ) { s += a * vnoise( p ); p = M2 * p * 2.07; a *= 0.5; }
  return s * 1.1428;
}
float fbm5( vec2 p ) {
  float s = 0.0, a = 0.5;
  for ( int i = 0; i < 5; i ++ ) { s += a * vnoise( p ); p = M2 * p * 2.07; a *= 0.5; }
  return s * 1.0322;
}

// ---- Preetham in-scattering ------------------------------------------------
vec3 atmosphere( vec3 dir ) {
  float zenithAngle = acos( max( 0.0, dot( UP, dir ) ) );
  float inv = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( zenithAngle * 180.0 / PI ), -1.253 ) );
  vec3 Fex = exp( -( uBetaR * ( 8400.0 * inv ) + uBetaM * ( 1250.0 * inv ) ) );

  float ct = dot( dir, uSunDir );
  vec3 betaRTheta = uBetaR * ( 0.05968310365946075 * ( 1.0 + pow( ct * 0.5 + 0.5, 2.0 ) ) );
  vec3 betaMTheta = uBetaM * hgPhase( ct, uMieG );

  vec3 ratio = ( betaRTheta + betaMTheta ) / ( uBetaR + uBetaM );
  vec3 Lin = pow( uSunE * ratio * ( 1.0 - Fex ), vec3( 1.5 ) );
  Lin *= mix( vec3( 1.0 ),
              pow( max( uSunE * ratio * Fex, vec3( 0.0 ) ), vec3( 0.5 ) ),
              clamp( pow( 1.0 - dot( UP, uSunDir ), 5.0 ), 0.0, 1.0 ) );
  return Lin * 0.04;
}

// Art grade: deeper high-altitude zenith, pale slightly-warm horizon band that
// preserves luminance (so it can never blow out), valley haze below.
vec3 gradeSky( vec3 col, vec3 dir ) {
  float h = dir.y;
  col *= mix( vec3( 1.0 ), uZenithTint, smoothstep( 0.03, 0.85, h ) );

  // The warm band belongs around the sun; opposite it the horizon stays cool.
  float dl = length( dir.xz );
  float caz = ( dl > 1e-4 ) ? dot( dir.xz / dl, uSunAz ) : 0.0;
  vec3 hTint = mix( uHorizonTintCool, uHorizonTint, smoothstep( -0.55, 0.90, caz ) );

  // The warm horizon band is an art grade, and it is luminance-preserving, so
  // on screen it costs nothing. In the IBL it is not free: three's PMREM
  // "irradiance" mip is a very wide GGX blur, not a cosine-weighted integral,
  // so a band that covers 10 deg of dome ends up tinting *up*-facing surfaces.
  // Halve it for the env capture — that is what keeps shadowed snow blue at
  // golden hour instead of the dead neutral it used to render.
  // Was 0.55 over an exp(-11h) falloff, which desaturated 55% of the sky at the
  // horizon line and drew a hard pale band right where the far ridges sit. Real
  // high-altitude air whitens toward the horizon, but gently and over a much
  // wider arc — and the ridges have to stay readable against it.
  float band = exp( -max( h, 0.0 ) * 7.0 );
  col = mix( col, vec3( dot( col, LUMW ) ) * hTint, band * mix( 0.36, 0.11, uEnvMode ) );

  // Below the horizon. What you SEE down there is a sunlit sea of valley haze
  // and snow, which is bright; what an up-facing surface actually receives from
  // it is far less, because every one of those directions is occluded by the
  // mountain you are standing on and three's IBL has no occlusion term. So the
  // dome draws it 2.4x brighter than the env capture stores it. This split is
  // the difference between a believable valley and grey shadows.
  float below = smoothstep( 0.0, -0.13, h );
  col = mix( col, uGroundColor * mix( 2.4, 1.0, uEnvMode ), below );

  // Cosine weighting for the env capture. Irradiance on a surface weights a
  // direction by cos(zenith), but three's PMREM irradiance mip is a wide GGX
  // blur that weights everything nearly equally — so at low sun the blazing
  // band of sky 10 deg above the horizon lands on up-facing snow with roughly
  // the same weight as the zenith, and the shadows come out neutral instead of
  // blue. Fold part of that missing cosine in here.
  col *= mix( 1.0, 0.50 + 0.50 * smoothstep( -0.05, 0.42, h ), uEnvMode );

  // Twilight / night floor: Preetham collapses to black below the horizon, so
  // add back the residual skylight that keeps a real night sky deep blue.
  if ( uNightAmount > 0.002 ) {
    vec3 nsky = mix( uNightHorizon, uNightZenith, smoothstep( -0.10, 0.55, h ) );
    col += nsky * uNightAmount;
  }

  return col;
}

// ---- clouds ----------------------------------------------------------------
// Coverage-thresholded, domain-warped fbm on a plane at cloud altitude, eroded
// by a higher octave so silhouettes read cauliflower rather than as blobs.
//
// The warp q is passed in rather than recomputed inside cloudShape, so the
// silhouette and every shadow tap go through one code path and it is impossible
// for them to drift apart again. The shadow march re-derives q at each tap: the
// far tap is 5.2 step lengths out, which at the cumulus deck's scale is a full
// wavelength of the warp field, so reusing the pixel's own q there would put the
// shadow in the wrong place by a whole cloud.
vec2 cloudWarp( vec2 p ) {
  return vec2( fbm2( p * 0.42 ), fbm2( p * 0.42 + vec2( 4.7, 1.3 ) ) );
}

float cloudShape( vec2 p, vec2 q, float cov, int quality ) {
  float n = ( quality > 0 ) ? fbm5( p + 0.9 * q ) : fbm3( p + 0.9 * q );
  float d = clamp( ( n - cov ) / max( 1.0 - cov, 0.05 ), 0.0, 1.0 );
  if ( quality > 0 ) {
    // Erode the edges, not the body: (1-d) weights the outside of the cloud, so
    // the interior keeps its density while the silhouette gets bitten into the
    // lumpy cauliflower outline a cumulus actually has. Squaring the erosion
    // noise biases it toward a few hard bites rather than a uniform nibble,
    // which is the difference between a lumpy edge and a blurred one.
    float er = fbm3( p * 3.1 + 19.0 );
    er *= er;
    d = clamp( ( d - ( 1.0 - d ) * er * 1.05 ) * 1.62, 0.0, 1.0 );
  } else {
    d = clamp( d * 1.35, 0.0, 1.0 );
  }
  return d * d * ( 3.0 - 2.0 * d );
}

vec4 cloudLayer( vec3 dir, vec3 camPos, vec3 skyCol, float altitude, float scale,
                 vec2 drift, float cov, float thickness, float ambBoost,
                 float apRate, int quality, float odSelf, float lit ) {
  if ( dir.y < 0.010 ) return vec4( 0.0 );
  float t = ( altitude - camPos.y ) / dir.y;
  if ( t <= 0.0 ) return vec4( 0.0 );

  vec2 p = ( camPos.xz + dir.xz * t ) * scale + drift * uTime;

  // Weather, not wallpaper. A single global coverage threshold produces a field
  // of identically sized puffs evenly spaced across the whole dome, which is
  // the second thing (after their sheer size) that gives a procedural sky away.
  // Modulating the threshold with one very low-frequency octave gives dense
  // clumps of large cells with clear lanes between them — the size *range* is
  // what a real deck has and a single fbm does not.
  float covL = clamp( cov + ( fbm2( p * 0.11 + 3.3 ) - 0.5 ) * 0.46, 0.03, 0.95 );

  vec2 q = cloudWarp( p );
  float d = cloudShape( p, q, covL, quality );
  if ( d <= 0.003 ) return vec4( 0.0 );

  // March toward the sun through the slab for self-shadowing. The taps run at
  // the SAME quality as the silhouette — i.e. the same five octaves and the
  // same erosion — because a shadow marched through a cheaper field is not a
  // shadow of the cloud you can see: it is an uncorrelated grey wash laid over
  // it, which is exactly what made these decks read as pasted decals. Three
  // taps at full quality is the single most expensive thing in this shader, and
  // it is worth it.
  vec2 sdir = uSunDir.xz;
  float sl = length( sdir );
  sdir = ( sl > 1e-4 ) ? sdir / sl : vec2( 1.0, 0.0 );
  float stepLen = thickness * ( 0.6 / max( uSunDir.y, 0.20 ) );
  vec2 p1 = p + sdir * stepLen, p2 = p + sdir * stepLen * 2.4, p3 = p + sdir * stepLen * 5.2;
  // covL is reused rather than re-derived: its octave has a wavelength of ~9
  // units and the longest step is 2.4, so it barely moves — unlike the warp,
  // which does.
  float s1 = cloudShape( p1, cloudWarp( p1 ), covL, quality );
  float s2 = cloudShape( p2, cloudWarp( p2 ), covL, quality );
  float s3 = cloudShape( p3, cloudWarp( p3 ), covL, quality );
  // Everything below the top of the deck is shaded by the deck above it, so
  // the optical depth toward the sun never really goes to zero inside a body.
  float shadow = s1 * 0.50 + s2 * 0.32 + s3 * 0.18 + d * odSelf;

  // Cauliflower relief. The density field falling away toward the sun means
  // this flank turns into the light; rising means it turns away. It is a
  // forward difference of the same field, so the shading follows the
  // silhouette exactly — which is the whole difference between a cloud and a
  // sticker of a cloud.
  float facing = clamp( ( d - s1 ) * 3.4 + 0.5, 0.0, 1.0 );

  float ct = dot( dir, uSunDir );
  // Two lobes: strong forward scatter (the silver lining) plus a weak back
  // lobe. Capped, because an HG lobe is unbounded at ct = 1 and a cloud
  // crossing the sun would otherwise read as a nuclear flash.
  float phase = min( 0.92 + 2.4 * hgPhase( ct, 0.72 ) + 0.6 * hgPhase( ct, -0.30 ), 3.4 );

  // Beer-Powder. Multiple scattering comes back in through the ambient term,
  // which is where it physically belongs — it is skylight, and it is blue.
  // The floor here is the whole ball game for cloud form: it is the fraction of
  // the sun's radiance that a fully self-shadowed base still transmits, and at
  // 0.11 no base could ever get below ~0.27 of its own top. Measured with
  // tools/skylight-probe.mjs (which renders the dome twice, once with the decks
  // switched off, and isolates the pixels that are actually cloud), 0.045 with
  // a steeper Beer slope lands base/top at 0.17.
  float beer   = 0.022 + 0.978 * exp( -shadow * 4.3 );
  float powder = 1.0 - exp( -d * 7.0 );   // dark-edge / silver-lining term
  float sh     = clamp( shadow * 1.25, 0.0, 1.0 );

  // Lit rim: thin, sun-facing edges are where forward scattering escapes.
  float rim = min( pow( 1.0 - d, 3.0 ) * hgPhase( ct, 0.86 ) * 9.0, 0.85 );

  vec3 col = uCloudSun * lit
             * ( beer * phase * ( 0.30 + 0.70 * powder ) * ( 0.55 + 0.90 * facing ) + rim )
           + uCloudAmb * mix( vec3( 1.0 ), uCloudBase, sh ) * ambBoost;

  // aerial perspective: dissolve into the sky that is actually behind them
  float ap = 1.0 - exp( -t * apRate );
  col = mix( col, skyCol, ap * 0.9 );

  // The env capture runs the cheap density, which is not eroded and therefore
  // covers noticeably more sky than the silhouette you actually see. Trim the
  // coverage back so the IBL is not over-clouded (at low sun that showed up
  // directly as warm cloud light neutralising the blue in the shadows).
  float a = smoothstep( 0.02, 0.30, d ) * smoothstep( 0.018, 0.115, dir.y )
          * mix( 1.0, 0.72, uEnvMode );
  return vec4( col, clamp( a, 0.0, 1.0 ) );
}

vec4 cirrusLayer( vec3 dir, vec3 camPos, vec3 skyCol ) {
  if ( dir.y < 0.02 || uCirrus <= 0.001 ) return vec4( 0.0 );
  float t = ( 9200.0 - camPos.y ) / dir.y;
  if ( t <= 0.0 ) return vec4( 0.0 );
  vec2 p = ( camPos.xz + dir.xz * t ) * 0.00020 + vec2( 0.0075, 0.0026 ) * uTime;

  vec2 w = vec2( fbm2( p * 0.9 ), fbm2( p * 0.9 + 9.1 ) );
  float n = fbm5( vec2( p.x * 0.55, p.y * 2.4 ) + 1.1 * w );
  float d = smoothstep( 0.58, 0.94, n );
  if ( d <= 0.003 ) return vec4( 0.0 );

  float ct = dot( dir, uSunDir );
  float phase = 0.85 + 1.6 * hgPhase( ct, 0.62 );
  vec3 col = uCloudSun * phase * 0.90 + uCloudAmb * 0.35;

  float ap = 1.0 - exp( -t * 1.0e-5 );
  col = mix( col, skyCol, ap * 0.85 );

  return vec4( col, d * uCirrus * smoothstep( 0.02, 0.12, dir.y ) );
}

void main() {
  vec3 dir = normalize( vWorldPosition - cameraPosition );

  vec3 col = gradeSky( atmosphere( dir ), dir );
  vec3 skyCol = col;

  // ---- cloud decks -------------------------------------------------------
  vec4 ci  = cirrusLayer( dir, cameraPosition, skyCol );
  // NOTE ON SCALE. These were 0.00019 / 0.00052, which put a single cumulus at
  // ~2 km across seen from 350 m below it — one cloud filled a quarter of the
  // frame. Side by side with a real alpine photograph that is the first thing
  // that gives the render away: real cumulus at this altitude subtend 3-8 deg,
  // not 25, and what sells a sky is *many* of them at a range of sizes, not
  // three enormous lozenges. Both decks are now 2.2x finer.
  // high altocumulus: thin, so barely any self-shadowing and it stays pale
  vec4 cu2 = cloudLayer( dir, cameraPosition, skyCol, 5400.0, 0.00043,
                         vec2( 0.0010, 0.0004 ), uCoverage + 0.17, 0.20, 1.15,
                         3.2e-5, 0, 0.12, 1.15 );
  // the main cumulus deck: thick, seen from underneath, so it self-shadows hard
  vec4 cu  = cloudLayer( dir, cameraPosition, skyCol, 2350.0, 0.00115,
                         vec2( 0.0030, 0.0011 ), uCoverage, 0.30, 1.00,
                         7.0e-5, 1, 0.88, 1.0 );

  col = mix( col, ci.rgb,  ci.a  * uCloudDensity );
  col = mix( col, cu2.rgb, cu2.a * uCloudDensity * 0.65 );
  col = mix( col, cu.rgb,  cu.a  * uCloudDensity );

  // ---- solar disc --------------------------------------------------------
  float ct = dot( dir, uSunDir );
  float horizonFade = smoothstep( -0.045, 0.012, uSunDir.y );
  float discOn = uSunDisc * horizonFade;

  // tight aureole on top of the broad Mie lobe from the scattering model
  col += uSunDiscTint * pow( max( ct, 0.0 ), 6000.0 ) * 2.2 * discOn;
  col += uSunDiscTint * pow( max( ct, 0.0 ), 700.0 ) * 0.30 * discOn;

  float ang = acos( clamp( ct, -1.0, 1.0 ) );
  const float R = 0.00465;                // true solar radius, 0.266 deg
  float x = ang / R;
  if ( x < 1.30 && discOn > 0.0 ) {
    float xc = min( x, 1.0 );
    float mu = sqrt( max( 0.0, 1.0 - xc * xc ) );
    float limb = 0.30 + 0.70 * pow( mu, 0.5 );    // solar limb darkening
    limb *= 1.0 - smoothstep( 0.92, 1.12, x );    // ~1 px of atmospheric blur
    // uDiscGain lands the disc a little over white so the limb gradient and
    // the low-sun reddening both survive the display transform instead of
    // being flattened into a clipped white circle.
    col += uSunDiscTint * limb * uDiscGain * discOn;
  }

  col *= uExposure;

  gl_FragColor = vec4( max( col, 0.0 ), 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------------------
// JS mirror of the dome — used to derive fog, ambient and cloud lighting so
// they can never disagree with what is on screen.
// ---------------------------------------------------------------------------
function hgJS(ct, g) {
  const g2 = g * g;
  return (1 / (4 * Math.PI)) * (1 - g2) / Math.pow(Math.max(1 + g2 - 2 * g * ct, 1e-4), 1.5);
}

function opticalPath(zenithAngle) {
  const za = Math.min(zenithAngle, 1.6057); // clamp to 92 deg so pow() stays real
  const deg = (za * 180) / Math.PI;
  return 1 / (Math.cos(za) + 0.15 * Math.pow(Math.max(93.885 - deg, 0.02), -1.253));
}

/** Sun transmittance through the atmosphere at `elev` radians. */
function sunTransmittance(elev) {
  const inv = opticalPath(Math.PI / 2 - elev);
  const sR = RAYLEIGH_ZENITH * inv;
  const sM = MIE_ZENITH * inv;
  const c = 0.2 * TURBIDITY * 10e-18;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = Math.exp(-(TOTAL_RAYLEIGH[i] * RAYLEIGH_SUN * sR + 0.434 * c * MIE_CONST[i] * MIE_COEF_SUN * sM));
  }
  return out;
}

const luminance = (c) => LUM[0] * c[0] + LUM[1] * c[1] + LUM[2] * c[2];

// ---------------------------------------------------------------------------
export function createSky(scene, renderer) {
  patchFog();

  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uBetaR: { value: new THREE.Vector3() },
    uBetaM: { value: new THREE.Vector3() },
    uSunE: { value: 1000 },
    uMieG: { value: MIE_G },
    uExposure: { value: SKY_CALIBRATION },
    uSunTint: { value: new THREE.Vector3(1, 0.95, 0.88) },
    uSunDiscTint: { value: new THREE.Vector3(1, 0.95, 0.88) },
    uDiscGain: { value: SUN_DISC_GAIN },
    uHorizonTint: { value: new THREE.Vector3(1.05, 1.0, 0.97) },
    uHorizonTintCool: { value: new THREE.Vector3(1.0, 1.0, 1.02) },
    uSunAz: { value: new THREE.Vector2(0, 1) },
    uZenithTint: { value: new THREE.Vector3(0.9, 0.94, 1.06) },
    uGroundColor: { value: new THREE.Vector3(0.42, 0.47, 0.55) },
    uNightAmount: { value: 0.0 },
    uNightZenith: { value: new THREE.Vector3(0.030, 0.061, 0.152) },
    uNightHorizon: { value: new THREE.Vector3(0.080, 0.106, 0.190) },
    uSunDisc: { value: 1 },
    uEnvMode: { value: 0 },
    uTime: { value: 0 },
    uCoverage: { value: 0.5 },
    uCloudDensity: { value: 1.0 },
    uCirrus: { value: 0.22 },
    uCloudSun: { value: new THREE.Vector3(1, 1, 1) },
    uCloudAmb: { value: new THREE.Vector3(0.2, 0.25, 0.34) },
    uCloudBase: { value: new THREE.Vector3(0.34, 0.29, 0.46) },
  };

  const skyMat = new THREE.ShaderMaterial({
    name: 'AlpineSky',
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });

  const skyGeo = new THREE.BoxGeometry(1, 1, 1);
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.scale.setScalar(40000);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = 1000;   // drawn last, so early-Z discards occluded sky pixels
  skyMesh.name = 'sky';
  scene.add(skyMesh);

  // Second mesh sharing the same material, so PMREMGenerator.fromScene() can
  // capture the sky on its own without the rest of the world.
  const envScene = new THREE.Scene();
  const envMesh = new THREE.Mesh(skyGeo, skyMat);
  envMesh.scale.setScalar(40000);
  envMesh.frustumCulled = false;
  envScene.add(envMesh);

  // ---- lights ------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xffffff, SUN_PEAK);
  sun.castShadow = true;

  // Shadow coverage was the real reason the mountain read flat. The frustum
  // used to be +/-95 m around the skier, so *nothing past 95 metres cast a
  // shadow at all*: measured over the hero framing, 85% of snow pixels sat in a
  // 0.7-0.9 band of "fraction of the key light received" and 0.0% were below
  // 0.4. There was simply no shade in the frame to separate from the sun.
  // terrain.js casts out to LOD 4 (614 m), so 330 m of half-extent is inside
  // what the terrain already supports. At 4096 that is 16 cm per texel — the
  // skier's own 4 m contact shadow is still ~25 texels across.
  const SHADOW_MAP = 4096;
  const SHADOW_HALF = 330;            // metres of half-extent around the skier
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 3400;
  sun.shadow.camera.left = -SHADOW_HALF;
  sun.shadow.camera.right = SHADOW_HALF;
  sun.shadow.camera.top = SHADOW_HALF;
  sun.shadow.camera.bottom = -SHADOW_HALF;
  sun.shadow.bias = -0.00012;
  // normalBias is in world units and has to track the texel footprint, or a
  // 3.5x wider frustum acnes every metre-scale sastruga on the piste.
  sun.shadow.normalBias = 0.42;
  sun.shadow.radius = 2.0;        // only used if the lead switches to VSM
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  // NOT part of the lighting solution — see SPRAY_HEMI_INTENSITY above. It is
  // invisible, so WebGLRenderer never collects it; it exists so fx/spray.js can
  // read a real sky/ground colour off scene.traverse().
  const fill = new THREE.HemisphereLight(0xbcd6ff, 0xe6eef7, SPRAY_HEMI_INTENSITY);
  fill.visible = false;
  scene.add(fill);

  // ---- fog ---------------------------------------------------------------
  // NOTE ON COLOUR SPACE: terrain.js runs its own aerial-perspective term and
  // seeds it with `scene.fog.color.convertSRGBToLinear()`, i.e. it expects the
  // fog colour to be display-encoded. three stores Color in linear working
  // space, so we deliberately store the *encoded* haze here and let terrain
  // decode it back — otherwise the terrain, which is where aerial perspective
  // matters most, fogs toward a colour ~2.5x too dark. Our own fog ShaderChunk
  // does not use `fogColor`; it takes the true linear inscatter from fogAP.
  const fog = new THREE.FogExp2(0xbcd2ea, 0.00055);
  scene.fog = fog;

  // ---- IBL ---------------------------------------------------------------
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;

  // ---- working state -----------------------------------------------------
  const sunDir = new THREE.Vector3(0, 1, 0);
  const _focus = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _fogCol = new THREE.Color();

  // Read-only diagnostic: the aerial-perspective colour actually shipped to
  // terrain.js this frame, what it was before the physical ceiling, and the sky
  // radiance that ceiling is derived from. tools/sky-ap-probe.mjs reads it so a
  // claim about the haze can be a number instead of an opinion.
  const hazeInfo = {
    cool: [0, 0, 0], coolRaw: [0, 0, 0], skyRidge: [0, 0, 0],
    coolLum: 0, skyRidgeLum: 0, clamped: 0,
  };

  const LATITUDE = 46.5 * Math.PI / 180;    // Alps
  const DECLINATION = 14.0 * Math.PI / 180; // late spring
  // Which way the piste faces. This rotates the whole solar arc, and it is a
  // lighting decision, not a geography one: the canonical framings all look
  // down the fall line (roughly -Z), and at ASPECT -82 the sun sat 21 deg off
  // that view axis. Near-axial light is the one direction that shows no surface
  // form at all — every roller on the piste was lit identically to the flat
  // between them. -22 puts the sun ~72 deg to camera right, so the same rollers
  // get a lit face, a terminator and a shadow drawn across the frame.
  const ASPECT = -38 * Math.PI / 180;

  // 0.302 == sun 23 deg. The old 31 deg cleared every terrain roll and most of
  // the trees: shadow length is h/tan(elev), so dropping 8 degrees more than
  // doubles every cast shadow in the frame (1.66 h -> 2.36 h) and roughly
  // doubles the rate at which cos(incidence) changes with slope, which is what
  // separates one facet of a mogul field from the next.
  let tod = 0.302;                 // mid-morning bluebird, sun ~23 deg
  let elevation = 0;
  let clock = 0;
  let envDirty = true;
  let lastEnvElev = -999;
  let lastEnvAz = -999;
  let frameNo = 0;

  const params = {
    cloudCoverage: 0.42,
    cloudDensity: 1.0,
    cirrus: 0.22,
    windSpeed: 1.0,
    fogDensity: 0.00033,     // our own chunk (trees, skier, props)
    // AERIAL PERSPECTIVE DENSITY. This is the number that decides whether a
    // distant ridge is a mountain or a cardboard cutout, so it gets the long
    // note.
    //
    // terrain.js multiplies it by 0.52 and integrates it against a 1500 m scale
    // height, then does a *straight* mix( surface, hazeColour, f ) with
    // f = 1 - exp( -sigma * t ). There is no ceiling on f in that file and I
    // cannot add one, so the only lever on how much surface survives at 3-5 km
    // is sigma itself.
    //
    // At the old 0.00170 the fogged fraction was f(3 km) = 0.85, f(4 km) = 0.92.
    // Only 8-15% of the ridge's own radiance was left, so its sunlit and shaded
    // faces landed within 5 display codes of each other: measured with
    // tools/sky-ap-probe.mjs, the internal luminance variation of the 2.5-6 km
    // ridges was 3.1% (hero) / 3.4% (closeup). That is a flat shape.
    //
    // Physically the old number was never defensible either. Clear winter air at
    // 2000 m runs 40-100 km meteorological visibility, i.e. sigma ~ 3/60000 =
    // 5e-5 /m, which puts f(4 km) at 0.18. Even the value below is ~5x thicker
    // than the real atmosphere — it is an art choice, just no longer one that
    // erases the geometry. Measured from the hero camera: f(3 km) = 0.38,
    // f(5 km) = 0.55. Nearly two thirds of the ridge's own light survives at
    // 3 km, and that is what carries the couloirs and the rock bands.
    //
    // The blue shift does NOT come from density. It comes from the haze *colour*
    // below, which is the sky's own radiance and is already B/R 2.2, so it
    // survives the reduction intact: the 2.5-6 km ridges measure B/R 1.45
    // against near snow at 1.03.
    aerialDensity: 0.00048,
    // Haze radiance (what a fogged surface converges *to*), its blue tilt, and
    // the physical ceiling as a fraction of the sky radiance in that direction.
    // Exposed rather than hard-coded so tools/sky-ap-probe.mjs can sweep them
    // against the measured skyline without a rebuild.
    hazeGain: 1.25,
    hazeTilt: [0.80, 0.88, 1.36],
    hazeCeiling: 1.00,
    fogHeight: 1150,
    fogRef: 0,
    fogStart: 40,
    exposureScale: 1.0,
    shadeFloor: SHADE_FLOOR_SCALE,
  };

  // ---- JS mirror of the dome --------------------------------------------
  const betaR = [0, 0, 0];
  const betaM = [0, 0, 0];
  let sunE = 0;

  function atmosphereJS(dx, dy, dz) {
    const za = Math.acos(clamp(Math.max(0, dy), 0, 1));
    const inv = opticalPath(za);
    const sR = RAYLEIGH_ZENITH * inv, sM = MIE_ZENITH * inv;
    const ct = dx * sunDir.x + dy * sunDir.y + dz * sunDir.z;
    const rP = 0.05968310365946075 * (1 + Math.pow(ct * 0.5 + 0.5, 2));
    const mP = hgJS(ct, MIE_G);
    const f = clamp(Math.pow(1 - sunDir.y, 5), 0, 1);
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const Fex = Math.exp(-(betaR[i] * sR + betaM[i] * sM));
      const ratio = (betaR[i] * rP + betaM[i] * mP) / (betaR[i] + betaM[i]);
      let L = Math.pow(Math.max(0, sunE * ratio * (1 - Fex)), 1.5);
      L *= mix(1, Math.sqrt(Math.max(0, sunE * ratio * Fex)), f);
      out[i] = L * 0.04;
    }
    return out;
  }

  function gradeJS(col, h, caz) {
    const zt = uniforms.uZenithTint.value;
    const htw = uniforms.uHorizonTint.value;
    const htc = uniforms.uHorizonTintCool.value;
    const gc = uniforms.uGroundColor.value;
    const zk = smoothstep01(0.03, 0.85, h);
    const c = [
      col[0] * mix(1, zt.x, zk),
      col[1] * mix(1, zt.y, zk),
      col[2] * mix(1, zt.z, zk),
    ];
    const w = smoothstep01(-0.55, 0.90, caz);
    const htx = mix(htc.x, htw.x, w), hty = mix(htc.y, htw.y, w), htz = mix(htc.z, htw.z, w);
    const band = Math.exp(-Math.max(h, 0) * 7) * 0.36;
    const l = luminance(c);
    c[0] = mix(c[0], l * htx, band);
    c[1] = mix(c[1], l * hty, band);
    c[2] = mix(c[2], l * htz, band);
    // mirrors the dome's visible-sky branch (uEnvMode == 0); every caller of
    // skyAt() is above the horizon, so in practice below == 0 here
    const below = smoothstep01(0, -0.13, h);
    c[0] = mix(c[0], gc.x * 2.4, below);
    c[1] = mix(c[1], gc.y * 2.4, below);
    c[2] = mix(c[2], gc.z * 2.4, below);
    const na = uniforms.uNightAmount.value;
    if (na > 0.002) {
      const nz = uniforms.uNightZenith.value, nh = uniforms.uNightHorizon.value;
      const k = smoothstep01(-0.10, 0.55, h);
      c[0] += mix(nh.x, nz.x, k) * na;
      c[1] += mix(nh.y, nz.y, k) * na;
      c[2] += mix(nh.z, nz.z, k) * na;
    }
    return [c[0] * SKY_CALIBRATION, c[1] * SKY_CALIBRATION, c[2] * SKY_CALIBRATION];
  }

  /** Graded, calibrated sky radiance for a direction (used for fog/ambient). */
  function skyAt(elevDeg, azOffset) {
    const e = elevDeg * Math.PI / 180;
    const ce = Math.cos(e), sy = Math.sin(e);
    // rotate the sun azimuth by azOffset around Y
    const sx = sunDir.x, sz = sunDir.z;
    const hl = Math.hypot(sx, sz) || 1;
    const ux = sx / hl, uz = sz / hl;
    const ca = Math.cos(azOffset), sa = Math.sin(azOffset);
    const rx = ux * ca - uz * sa;
    const rz = ux * sa + uz * ca;
    return gradeJS(atmosphereJS(rx * ce, sy, rz * ce), sy, ca);
  }

  function solarPosition(t) {
    const H = (t - 0.5) * 2 * Math.PI;
    const sinE = Math.sin(DECLINATION) * Math.sin(LATITUDE)
               + Math.cos(DECLINATION) * Math.cos(LATITUDE) * Math.cos(H);
    const elev = Math.asin(clamp(sinE, -1, 1));
    const cosA = (Math.sin(DECLINATION) - Math.sin(elev) * Math.sin(LATITUDE))
               / Math.max(Math.cos(elev) * Math.cos(LATITUDE), 1e-4);
    let az = Math.acos(clamp(cosA, -1, 1));
    if (H > 0) az = 2 * Math.PI - az;
    return { elev, az };
  }

  // ---- shade floor -------------------------------------------------------
  // snow-material.js sets the absolute level of every shadow in the image with
  // one hard-coded constant (see SHADE_FLOOR_SCALE). Bring it into the sky's
  // budget, remembering whatever it was authored as so this is idempotent and
  // so a value of 1.0 hands it straight back.
  // The authored value is cached on the material itself, not in a WeakMap local
  // to this closure: createSky() can be called again (hot reload, time-of-day
  // rebuild) and a fresh map would take the already-scaled tint for the
  // original and scale it a second time, darkening every shadow in the game a
  // little more on each reload.
  const _shade = new THREE.Color();
  function eachSnowMaterial(fn) {
    scene.traverse((o) => {
      const m = o.material;
      const list = Array.isArray(m) ? m : m ? [m] : [];
      for (const mat of list) {
        const u = mat.userData && mat.userData.snowUniforms;
        if (!u || !u.uShadeTint || !u.uShadeTint.value || !u.uShadeTint.value.isColor) continue;
        if (!mat.userData.skyShadeAuthored) mat.userData.skyShadeAuthored = u.uShadeTint.value.clone();
        fn(u.uShadeTint.value, mat.userData.skyShadeAuthored);
      }
    });
  }
  function reconcileShadeFloor() {
    eachSnowMaterial((tint, base) => {
      tint.copy(_shade.copy(base).multiplyScalar(params.shadeFloor));
    });
  }

  function apply() {
    const { elev, az } = solarPosition(tod);
    elevation = elev;

    const ce = Math.cos(elev);
    const wa = az + ASPECT;
    sunDir.set(ce * Math.sin(wa), Math.sin(elev), -ce * Math.cos(wa)).normalize();
    uniforms.uSunDir.value.copy(sunDir);

    const cM = 0.2 * TURBIDITY * 10e-18;
    for (let i = 0; i < 3; i++) {
      betaR[i] = TOTAL_RAYLEIGH[i] * RAYLEIGH;
      betaM[i] = 0.434 * cM * MIE_CONST[i] * MIE_COEF;
    }
    uniforms.uBetaR.value.fromArray(betaR);
    uniforms.uBetaM.value.fromArray(betaM);

    const cosZ = clamp(Math.sin(elev), -1, 1);
    sunE = EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(cosZ)) / STEEPNESS)));
    uniforms.uSunE.value = sunE;

    // ---- derived sun colour ---------------------------------------------
    const Fex = sunTransmittance(Math.max(elev, -0.02));
    const peak = Math.max(Fex[0], Fex[1], Fex[2], 1e-5);
    const sunCol = [Fex[0] / peak, Fex[1] / peak, Fex[2] / peak];
    const lum = luminance(Fex);

    const above = smoothstep01(-0.055, 0.06, Math.sin(elev));
    const day = smoothstep01(-0.02, 0.30, Math.sin(elev));
    const golden = smoothstep01(0.42, 0.05, Math.sin(elev)) * above;
    const night = 1 - above;

    // ---- exposure ---------------------------------------------------------
    // Derived first, because a camera stop is a property of the *scene*, not of
    // the display transform: postfx renders through a render target, where
    // renderer.toneMappingExposure is a no-op. So the meter is folded into the
    // key, the IBL and the dome instead, which is equivalent and works no
    // matter who does the final tonemap.
    // Meter on the irradiance that actually lands on flat snow — the sun's own
    // transmittance times cos(zenith) — and compensate for only *half* of it
    // (the sqrt), the way a photographer opens up a couple of stops at dusk
    // without pretending it is noon. INC_REF is that quantity at the default
    // late-morning sun, so exposure there is exactly 1.0 and sunlit snow lands
    // on 1.0 linear.
    const key = (lum / 0.8955) * above;
    const inc = key * Math.max(Math.sin(elev), 0);
    const INC_REF = 0.634;
    // The upper clamp matters: open up more than ~1.6 stops-worth at dusk and
    // the sky around the sun goes over white, taking the disc with it.
    const expo = clamp(Math.sqrt(INC_REF / Math.max(inc, 1e-4)), 0.8, 1.55) * params.exposureScale;

    // White balance. At 23 deg the beam has crossed 2.5 air masses and comes out
    // at roughly 4400 K — the raw transmittance is (1.00, 0.85, 0.59), and
    // rendered straight it makes the snow cream. A real camera is balanced off
    // the key, not off D65, so pull the *light* part-way to neutral while the
    // dome, the IBL and therefore every shadow keep their own chromaticity.
    // That is what leaves sunlit snow neutral-to-warm and shade blue instead of
    // washing the whole frame one colour. Measured: sunlit snow B/R 0.84 -> 0.92,
    // shadow B/R unchanged at 2.5.
    // Luminance-preserving, so the white balance is a hue move only and the
    // 1.00-linear calibration of sunlit snow is not quietly re-tuned by it.
    const WB = 0.34;
    const wbBefore = luminance(sunCol);
    for (let i = 0; i < 3; i++) sunCol[i] = mix(sunCol[i], 1.0, WB);
    const wbK = wbBefore / Math.max(luminance(sunCol), 1e-5);
    for (let i = 0; i < 3; i++) sunCol[i] *= wbK;
    sun.color.setRGB(sunCol[0], sunCol[1], sunCol[2], THREE.LinearSRGBColorSpace);
    sun.intensity = SUN_PEAK * key * expo;
    uniforms.uSunTint.value.set(sunCol[0], sunCol[1], sunCol[2]);
    // The disc gets the raw transmittance, NOT the peak-normalised tint —
    // normalising is what stopped it ever rendering orange at golden hour.
    uniforms.uSunDiscTint.value.set(Fex[0], Fex[1], Fex[2]);
    uniforms.uExposure.value = SKY_CALIBRATION * expo;

    // ---- grade tints ------------------------------------------------------
    uniforms.uZenithTint.value.set(
      mix(1.0, 0.88, day), mix(1.0, 0.93, day), mix(1.02, 1.10, day));

    // Horizon band. Near-luminance-preserving: warm and blazing at sunset, and
    // by day a PALE BLUE — not a white-out.
    //
    // The daytime base used to be (0.99, 1.00, 1.03), i.e. neutral, and Preetham
    // itself only reaches B/R 1.02-1.13 in the first few degrees, so the low sky
    // rendered at B/R 1.06: achromatic white. Everything standing in front of it
    // — the far massif, the treeline, the map-edge plain — was therefore a grey
    // shape on white paper, which is the cut-out read the AP fix is trying to
    // get rid of. It is no good giving a ridge its structure back if the thing
    // behind it is a blank sheet.
    //
    // Reference (Bürstegg winter panorama, 2000 m, sampled with ffmpeg):
    //     sky just above the far ridge   L 173, B/R 1.66
    //     sky ~3 deg higher              L 152, B/R 1.98
    //     near sunlit snow               L 216, B/R 1.06
    // A real alpine horizon is pale, but it is pale BLUE, and it is ~40 display
    // codes below the snow. The golden-hour deltas are unchanged: at golden == 1
    // both tints land within 0.01 of the values they had before.
    uniforms.uHorizonTint.value.set(
      0.70 + golden * 1.71,
      0.94 + golden * 0.14,
      1.50 - golden * 0.99);
    // opposite the sun: cool blue by day, Belt-of-Venus pink at dusk
    uniforms.uHorizonTintCool.value.set(
      0.70 + golden * 0.63,
      0.94 + golden * 0.00,
      1.50 - golden * 0.34);
    const azLen = Math.hypot(sunDir.x, sunDir.z) || 1;
    uniforms.uSunAz.value.set(sunDir.x / azLen, sunDir.z / azLen);

    uniforms.uNightAmount.value = night;
    uniforms.uCoverage.value = params.cloudCoverage;
    uniforms.uCloudDensity.value = params.cloudDensity;
    uniforms.uCirrus.value = params.cirrus;

    // ---- read the sky back out to drive everything else -------------------
    // All of these are above the horizon, so uGroundColor (written below) does
    // not participate and the ordering is safe. skyAt() is calibrated but NOT
    // exposed, so anything that ends up as scene radiance is scaled by `expo`
    // here, while anything handed to the dome shader (which applies uExposure
    // itself) is not.
    const horizonNeutral = skyAt(3.5, Math.PI * 0.5);
    const horizonSun = skyAt(3.5, 0);
    const low = skyAt(12, Math.PI * 0.5);
    const mid = skyAt(38, Math.PI * 0.75);
    const antisolar = skyAt(42, Math.PI);

    // Valley haze / snow bounce below the horizon. It used to be lifted to 4x
    // the sky and warmed at golden hour; PMREM's irradiance mip then smeared
    // that warm lower hemisphere straight into every up-facing surface, which
    // is what made shadows achromatic. It is now a third of that and untinted,
    // and the cast shadows go blue.
    // The lower hemisphere is also pulled toward the upper sky as the sun drops:
    // at golden hour the valley below you is already in shadow, so what it
    // bounces back is blue skylight, not the orange band on the horizon.
    const gb = 0.175 / SKY_CALIBRATION;   // gradeJS re-applies the calibration
    const gk = 0.30 + 0.52 * golden;
    uniforms.uGroundColor.value.set(
      mix(horizonNeutral[0], mid[0], gk) * gb * 0.94,
      mix(horizonNeutral[1], mid[1], gk) * gb * 0.98,
      mix(horizonNeutral[2], mid[2], gk) * gb * 1.06);

    // Skylight seen by cloud flanks. NOTE: the shader multiplies everything by
    // SKY_CALIBRATION * expo at the end, so cloud radiances are stored
    // pre-calibration and pre-exposure.
    const inv = 1 / SKY_CALIBRATION;
    // Take the cloud ambient from the ANTI-SOLAR upper sky. A flat average over
    // the dome includes the horizon glow and the bright solar half, which is
    // the light a cloud base sees least of.
    uniforms.uCloudAmb.value.set(
      mix(antisolar[0], mid[0], 0.35) * 0.95 * inv,
      mix(antisolar[1], mid[1], 0.35) * 1.00 * inv,
      mix(antisolar[2], mid[2], 0.35) * 1.22 * inv);
    // What a fully self-shadowed base does to the *skylight* it receives: the
    // deck above it occludes most of the dome, so the base sees a fraction of
    // the ambient, and what it does see arrives after several scatterings and
    // is bluer than the sky average.
    uniforms.uCloudBase.value.set(
      mix(0.27, 0.24, golden), mix(0.27, 0.22, golden), mix(0.36, 0.34, golden));

    // Sun radiance on cloud tops: less extinction up at 3 km, albedo ~0.9.
    const hiFex = sunTransmittance(Math.max(elev, 0.015) + 0.07);
    const hiPeak = Math.max(hiFex[0], hiFex[1], hiFex[2], 1e-5);
    const cloudLit = SUN_PEAK * key * (0.86 / Math.PI) * inv;
    uniforms.uCloudSun.value.set(
      (hiFex[0] / hiPeak) * cloudLit,
      (hiFex[1] / hiPeak) * cloudLit,
      (hiFex[2] / hiPeak) * cloudLit);

    // ---- sky colour handed to fx/spray.js (see SPRAY_HEMI_INTENSITY) -------
    // Peak-normalised, because spray wants a hue and applies its own level.
    const lowPk = Math.max(low[0], low[1], low[2], 1e-5);
    const horPk = Math.max(horizonNeutral[0], horizonNeutral[1], horizonNeutral[2], 1e-5);
    fill.color.setRGB(low[0] / lowPk, low[1] / lowPk, low[2] / lowPk, THREE.LinearSRGBColorSpace);
    fill.groundColor.setRGB(horizonNeutral[0] / horPk, horizonNeutral[1] / horPk,
      horizonNeutral[2] / horPk, THREE.LinearSRGBColorSpace);
    fill.intensity = SPRAY_HEMI_INTENSITY;
    fill.visible = false;

    // Snow bounces a lot of skylight, but a fully unoccluded hemisphere flattens
    // the render into a milk bath. See the note at the top of the file: this is
    // the number that buys back the tonal separation.
    scene.environmentIntensity = ENV_INTENSITY;
    reconcileShadeFloor();

    // ---- fog / aerial perspective -----------------------------------------
    // Three probes of the same graded dome the sky draws: horizon away from the
    // sun, horizon toward it, and the sky 25 deg up. The fog chunk interpolates
    // between them along the view ray, so a fogged object lands on the colour
    // of the sky it is standing in front of. HAZE_GAIN < 1 because the light
    // that survives to the eye from a few km of clean 2000 m air is a fraction
    // of the full optical-depth horizon radiance; without it the haze is as
    // bright as sunlit snow and fogging snow is a no-op.
    // Haze radiance. What a ridge fogs *toward* sets both how far away it reads
    // and how blue it goes; measured at 1.7 km the ridge was landing on B/R 0.97
    // (i.e. slightly warmer than the near snow, which is aerial perspective
    // running backwards) because there was not enough haze in front of it and
    // what there was, was too dark to survive the mix.
    // How BRIGHT the haze is decides something separate from how much of it
    // there is, and getting the two confused is what made the far peaks read as
    // slate cut-outs. terrain.js does mix( surface, haze, f ): f controls how
    // much structure survives, the haze radiance controls what value the
    // survivors converge on. Reference (Bürstegg winter panorama, sampled with
    // ffmpeg): a 5 km ridge reads lit L 132 / shaded L 100 against near sunlit
    // snow at L 216 — the shaded face has *lifted* out of black far more than
    // the lit face has fallen. Aerial perspective compresses the range from both
    // ends toward a value nearer sunlit snow than mid grey.
    // At 0.80 gain the haze measured 0.30 linear against sunlit snow at 1.00, so
    // every distant sunlit face was dragged *down* ~60 display codes and the
    // massif went slate blue. Raising it past the ceiling below means the haze
    // simply sits on the physically correct value — the sky radiance in that
    // direction — at every time of day, which is what a single-scattering
    // integral converges to as tau grows.
    const HAZE_GAIN = params.hazeGain * expo;
    // Aerial perspective is blue, and it has to be blue *enough*: what the eye
    // reads as distance is the B/R of the far ridge, not its luminance. Rayleigh
    // in-scatter over a few km is roughly 1/lambda^4, so the blue channel wins
    // by a lot more than a 1.16 tilt admits. Measured at 1.2 km the far ridge
    // was coming back at B/R 0.91 — warmer than the near snow, i.e. aerial
    // perspective pointing the wrong way.
    // Blue, not teal: the green channel is what decides whether distant rock
    // reads as "far away" or as "underwater". Pulling G down relative to R
    // while keeping B up gives Rayleigh's slope without the cyan cast that
    // showed up on every distant massif.
    // NB at the default hazeGain the ceiling below binds in all three channels
    // from roughly 10 deg of sun elevation upward, so by day the tilt is inert
    // and the haze *is* the sky colour (B/R 2.2). It bites at low sun, where the
    // ungained horizon radiance falls below the ceiling — check hazeInfo.clamped
    // before attributing anything to it.
    const tilt = params.hazeTilt;            // aerial perspective is blue
    const hazeCool = [
      mix(horizonNeutral[0], low[0], 0.30) * HAZE_GAIN * tilt[0],
      mix(horizonNeutral[1], low[1], 0.30) * HAZE_GAIN * tilt[1],
      mix(horizonNeutral[2], low[2], 0.30) * HAZE_GAIN * tilt[2],
    ];
    const hazeWarm = [
      mix(horizonSun[0], mid[0], 0.20) * HAZE_GAIN * 1.0,
      mix(horizonSun[1], mid[1], 0.20) * HAZE_GAIN * 1.0,
      mix(horizonSun[2], mid[2], 0.20) * HAZE_GAIN * 1.06,
    ];
    const hazeUp = [
      mix(mid[0], antisolar[0], 0.5) * HAZE_GAIN * 1.05,
      mix(mid[1], antisolar[1], 0.5) * HAZE_GAIN * 1.05,
      mix(mid[2], antisolar[2], 0.5) * HAZE_GAIN * 1.15,
    ];

    // Physical ceiling on the haze. In-scattered radiance along a view ray is
    // bounded by the sky radiance in that direction: haze cannot be brighter
    // than the sky it is made of. Without this the far ridges came out brighter
    // than the sky directly above them (measured terrain/sky 1.36 across the
    // skyline) — the single most reliable tell of fake aerial perspective, and
    // the reason a distant massif read as a pale sticker instead of as distance.
    // Clamping instead of art-directing means the gain above can be pushed to
    // whatever the near field wants and the far field stays honest by itself.
    const skyRidge = skyAt(9, Math.PI * 0.5);      // sky just above a far ridge
    const skyRidgeSun = skyAt(9, 0);
    const CEIL = params.hazeCeiling;
    hazeInfo.clamped = 0;
    for (let i = 0; i < 3; i++) {
      hazeInfo.coolRaw[i] = hazeCool[i];
      const lim = skyRidge[i] * expo * CEIL;
      if (hazeCool[i] > lim) hazeInfo.clamped |= 1 << i;
      hazeCool[i] = Math.min(hazeCool[i], lim);
      hazeWarm[i] = Math.min(hazeWarm[i], skyRidgeSun[i] * expo * CEIL);
      hazeUp[i] = Math.min(hazeUp[i], mid[i] * expo * CEIL);
      hazeInfo.cool[i] = hazeCool[i];
      hazeInfo.skyRidge[i] = skyRidge[i] * expo;
    }
    hazeInfo.coolLum = luminance(hazeCool);
    hazeInfo.skyRidgeLum = luminance(hazeInfo.skyRidge);

    // terrain.js reads this one (display-encoded — see the fog note above) and
    // runs its own direction-independent aerial term off it, so it gets the
    // neutral/cool haze, which is what a ridge is usually seen against.
    _fogCol.setRGB(hazeCool[0], hazeCool[1], hazeCool[2], THREE.LinearSRGBColorSpace);
    _fogCol.convertLinearToSRGB();
    fog.color.copy(_fogCol);
    fog.density = params.aerialDensity;

    // The extra glow you get looking through haze toward the sun.
    const glowScale = 0.55 + 0.9 * golden;
    const sunHaze = [
      Math.max(0, hazeWarm[0] - hazeCool[0]) * glowScale,
      Math.max(0, hazeWarm[1] - hazeCool[1]) * glowScale,
      Math.max(0, hazeWarm[2] - hazeCool[2]) * glowScale,
    ];

    FOG_AP[0] = params.fogDensity;
    FOG_AP[1] = 1 / params.fogHeight;
    FOG_AP[2] = params.fogRef;
    FOG_AP[3] = params.fogStart;
    FOG_AP[4] = 0.88;                  // per-channel extinction: blue survives
    FOG_AP[5] = 0.97;
    FOG_AP[6] = 1.15;
    FOG_AP[7] = 0.76;                  // HG asymmetry
    FOG_AP[8] = sunDir.x;
    FOG_AP[9] = sunDir.y;
    FOG_AP[10] = sunDir.z;
    FOG_AP[11] = 1.0;                  // forward-scatter strength
    FOG_AP[12] = sunHaze[0];
    FOG_AP[13] = sunHaze[1];
    FOG_AP[14] = sunHaze[2];
    // Maximum inscatter fraction. This is the cheap, direction-free version of
    // "never let a distant surface reach 100% haze": at 0.975 a far conifer band
    // kept 2.5% of its own radiance, which is nothing, and the treelines behind
    // the piste read as one flat blue stripe. 0.88 leaves 12% — enough that the
    // silhouette still has internal value structure — and because it is a floor
    // on transmittance rather than a change to sigma it costs nothing in the
    // near field, where tau is small and the clamp never binds.
    FOG_AP[15] = 0.88;                 // never fully erase distant geometry
    FOG_AP[16] = hazeCool[0];
    FOG_AP[17] = hazeCool[1];
    FOG_AP[18] = hazeCool[2];
    FOG_AP[19] = sunDir.x / azLen;     // sun azimuth, for the warm/cool blend
    FOG_AP[20] = hazeWarm[0];
    FOG_AP[21] = hazeWarm[1];
    FOG_AP[22] = hazeWarm[2];
    FOG_AP[23] = sunDir.z / azLen;
    FOG_AP[24] = hazeUp[0];
    FOG_AP[25] = hazeUp[1];
    FOG_AP[26] = hazeUp[2];
    FOG_AP[27] = 0;

    // The exposure is already baked into the lights and the dome, so the
    // renderer's own tonemap must not apply it a second time. (It only runs at
    // all if the lead bypasses postfx.)
    renderer.toneMappingExposure = 1.0;

    envDirty = true;
  }

  function updateEnvironment() {
    const prevDisc = uniforms.uSunDisc.value;
    const prevEnv = uniforms.uEnvMode.value;
    uniforms.uSunDisc.value = 0;   // a 0.5 deg point source turns into PMREM blotches
    uniforms.uEnvMode.value = 1;

    const old = envRT;
    envRT = pmrem.fromScene(envScene, 0, 10, 60000);
    scene.environment = envRT.texture;
    if (old) old.dispose();

    uniforms.uSunDisc.value = prevDisc;
    uniforms.uEnvMode.value = prevEnv;

    lastEnvElev = elevation;
    lastEnvAz = Math.atan2(sunDir.x, sunDir.z);
    envDirty = false;
  }

  // ---- shadow frustum follows the skier, snapped to shadow texels ---------
  function updateShadow(state) {
    if (state && state.pos) {
      _focus.copy(state.pos);
      if (state.vel) _focus.addScaledVector(state.vel, 0.6);
    } else {
      _focus.set(0, 0, 0);
    }

    _up.set(0, 1, 0);
    if (Math.abs(sunDir.y) > 0.995) _up.set(1, 0, 0);
    _right.crossVectors(_up, sunDir).normalize();
    _up.crossVectors(sunDir, _right).normalize();

    const texel = (2 * SHADOW_HALF) / SHADOW_MAP;
    const px = Math.round(_focus.dot(_right) / texel) * texel;
    const py = Math.round(_focus.dot(_up) / texel) * texel;
    const pz = _focus.dot(sunDir);
    _tmp.set(0, 0, 0)
      .addScaledVector(_right, px)
      .addScaledVector(_up, py)
      .addScaledVector(sunDir, pz);

    sun.target.position.copy(_tmp);
    sun.position.copy(_tmp).addScaledVector(sunDir, 1500);
    sun.target.updateMatrixWorld();
  }

  apply();
  updateShadow(null);
  updateEnvironment();

  return {
    sun,
    fill,
    fog,
    material: skyMat,
    uniforms,
    params,
    hazeInfo,

    /** Re-derive everything from the current params (probe / debug UI hook). */
    refresh() { apply(); },

    /** Give a custom ShaderMaterial the shared aerial-perspective uniforms. */
    registerFogMaterial(material) {
      if (material && material.uniforms && !material.uniforms.fogAP) {
        material.uniforms.fogAP = FOG_AP_UNIFORM;
      }
      return material;
    },

    /** t in 0..1 across the day; 0.5 == solar noon. */
    setTimeOfDay(t) {
      tod = ((t % 1) + 1) % 1;
      apply();
    },

    getTimeOfDay() { return tod; },
    getSunElevation() { return elevation; },
    /** Graded sky radiance in a direction, for other subsystems that want it. */
    sampleSky(elevDeg, azOffset) { return skyAt(elevDeg, azOffset); },
    /** Re-apply the sky's ambient budget to any snow material in the scene. */
    reconcileShadeFloor,

    update(dt, state) {
      clock += dt;
      uniforms.uTime.value = clock * params.windSpeed;

      updateShadow(state);

      // Terrain/scatter build their snow materials after createSky() runs, and
      // stream more in as the skier moves, so the shade floor has to be swept
      // periodically rather than once. Every 20th frame over a few hundred
      // objects is free.
      if ((++frameNo % 20) === 0) reconcileShadeFloor();

      // Rebuild the IBL only when the sun has actually moved enough to matter.
      if (envDirty) {
        const dE = Math.abs(elevation - lastEnvElev);
        const dA = Math.abs(Math.atan2(sunDir.x, sunDir.z) - lastEnvAz);
        if (dE > 0.006 || dA > 0.006) updateEnvironment();
        else envDirty = false;
      }
    },

    dispose() {
      eachSnowMaterial((tint, base) => tint.copy(base));
      scene.remove(skyMesh);
      scene.remove(sun);
      scene.remove(sun.target);
      scene.remove(fill);
      skyGeo.dispose();
      skyMat.dispose();
      pmrem.dispose();
      if (envRT) envRT.dispose();
    },
  };
}
