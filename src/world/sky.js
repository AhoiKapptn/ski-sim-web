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
 * rather than hand-picked. That is why distant ridges dissolve into exactly the
 * value of the sky behind them.
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
const TURBIDITY = 1.85;
const RAYLEIGH = 2.45;
const MIE_COEF = 0.0038;
const MIE_G = 0.80;

// Calibration: Preetham's arbitrary units -> "1.0 == diffuse white in full sun".
// Everything else (sun intensity, IBL, fog) lives in this space.
const SKY_CALIBRATION = 0.132;

// Physically honest coefficients, used only for the *sun's own* colour so the
// key light reddens correctly at low elevation instead of being art-boosted.
const RAYLEIGH_SUN = 1.0;
const MIE_COEF_SUN = 0.005;

// Peak sun intensity. Chosen so sunlit 0.87-albedo snow lands ~0.8 linear at
// exposure 1.0 — bright, but with headroom so shading survives.
const SUN_PEAK = 3.45;

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
// (aerial perspective / blue shift) and a Henyey-Greenstein forward-scattering
// term so haze glows when you look toward the sun.
//
// The extra parameters ride in one `uniform vec4 fogAP[4]`. A Float32Array
// uniform value is neither a three object nor a plain Array, so cloneUniforms()
// copies it *by reference* — a single array shared by every material in the
// scene, updated once per frame with zero per-material bookkeeping.
// ---------------------------------------------------------------------------
const FOG_AP = new Float32Array(16);
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
  uniform vec4 fogAP[ 4 ];
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

    vec3 inscat = fogColor + sunHaze * clamp( hg * sunAmt, 0.0, 8.0 );

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
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );

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

uniform vec3  uSunTint;        // linear colour of the solar disc after extinction
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
uniform vec3  uCloudAmb;       // linear skylight on cloud flanks / bases

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

  float band = exp( -max( h, 0.0 ) * 10.0 );
  col = mix( col, vec3( dot( col, LUMW ) ) * hTint, band * 0.55 );

  float below = smoothstep( 0.0, -0.13, h );
  col = mix( col, uGroundColor * ( 1.0 + uEnvMode * 0.18 ), below );

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
float cloudDensity( vec2 p, float cov, int quality ) {
  vec2 q = vec2( fbm2( p * 0.42 ), fbm2( p * 0.42 + vec2( 4.7, 1.3 ) ) );
  float n = ( quality > 0 ) ? fbm5( p + 0.9 * q ) : fbm3( p + 0.9 * q );
  float d = clamp( ( n - cov ) / max( 1.0 - cov, 0.05 ), 0.0, 1.0 );
  if ( quality > 0 ) {
    float er = fbm3( p * 3.4 + 19.0 );
    d = clamp( ( d - ( 1.0 - d ) * er * 0.62 ) * 1.5, 0.0, 1.0 );
  } else {
    d = clamp( d * 1.35, 0.0, 1.0 );
  }
  return d * d * ( 3.0 - 2.0 * d );
}

float cheapDensity( vec2 p, float cov ) {
  float d = clamp( ( fbm3( p ) - cov ) / max( 1.0 - cov, 0.05 ), 0.0, 1.0 );
  return d * d * ( 3.0 - 2.0 * d );
}

vec4 cloudLayer( vec3 dir, vec3 camPos, vec3 skyCol, float altitude, float scale,
                 vec2 drift, float cov, float thickness, float ambBoost,
                 float apRate, int quality ) {
  if ( dir.y < 0.010 ) return vec4( 0.0 );
  float t = ( altitude - camPos.y ) / dir.y;
  if ( t <= 0.0 ) return vec4( 0.0 );

  vec2 p = ( camPos.xz + dir.xz * t ) * scale + drift * uTime;

  float d = cloudDensity( p, cov, quality );
  if ( d <= 0.003 ) return vec4( 0.0 );

  // march a few taps toward the sun through the slab for self-shadowing
  vec2 sdir = uSunDir.xz;
  float sl = length( sdir );
  sdir = ( sl > 1e-4 ) ? sdir / sl : vec2( 1.0, 0.0 );
  float stepLen = thickness * ( 0.6 / max( uSunDir.y, 0.20 ) );
  float shadow = cheapDensity( p + sdir * stepLen,       cov ) * 0.55
               + cheapDensity( p + sdir * stepLen * 2.4, cov ) * 0.30
               + cheapDensity( p + sdir * stepLen * 5.0, cov ) * 0.15;

  float ct = dot( dir, uSunDir );
  float phase = 0.92 + 2.4 * hgPhase( ct, 0.72 ) + 0.6 * hgPhase( ct, -0.30 );

  // multiple scattering keeps even shadowed cloud far from black
  float beer   = 0.16 + 0.84 * exp( -shadow * 2.2 );
  float powder = 1.0 - exp( -d * 6.0 );   // dark-edge / silver-lining term

  vec3 col = uCloudSun * beer * phase * ( 0.45 + 0.55 * powder )
           + uCloudAmb * ( 0.50 + 0.50 * ( 1.0 - d ) ) * ambBoost;

  // aerial perspective: dissolve into the sky that is actually behind them
  float ap = 1.0 - exp( -t * apRate );
  col = mix( col, skyCol, ap * 0.9 );

  float a = smoothstep( 0.03, 0.40, d ) * smoothstep( 0.018, 0.115, dir.y );
  return vec4( col, clamp( a, 0.0, 1.0 ) );
}

vec4 cirrusLayer( vec3 dir, vec3 camPos, vec3 skyCol ) {
  if ( dir.y < 0.02 || uCirrus <= 0.001 ) return vec4( 0.0 );
  float t = ( 9200.0 - camPos.y ) / dir.y;
  if ( t <= 0.0 ) return vec4( 0.0 );
  vec2 p = ( camPos.xz + dir.xz * t ) * 0.00011 + vec2( 0.0075, 0.0026 ) * uTime;

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
  vec4 cu2 = cloudLayer( dir, cameraPosition, skyCol, 5400.0, 0.00019,
                         vec2( 0.0010, 0.0004 ), uCoverage + 0.13, 0.20, 1.25, 3.2e-5, 0 );
  vec4 cu  = cloudLayer( dir, cameraPosition, skyCol, 2350.0, 0.00052,
                         vec2( 0.0030, 0.0011 ), uCoverage, 0.30, 1.00, 7.0e-5, 1 );

  col = mix( col, ci.rgb,  ci.a  * uCloudDensity );
  col = mix( col, cu2.rgb, cu2.a * uCloudDensity * 0.65 );
  col = mix( col, cu.rgb,  cu.a  * uCloudDensity );

  // ---- solar disc --------------------------------------------------------
  float ct = dot( dir, uSunDir );
  float horizonFade = smoothstep( -0.045, 0.012, uSunDir.y );
  float discOn = uSunDisc * horizonFade;

  // tight aureole on top of the broad Mie lobe from the scattering model
  col += uSunTint * pow( max( ct, 0.0 ), 6000.0 ) * 3.0 * discOn;
  col += uSunTint * pow( max( ct, 0.0 ), 700.0 ) * 0.35 * discOn;

  float ang = acos( clamp( ct, -1.0, 1.0 ) );
  float R = 0.0092;                       // ~0.53 deg radius
  float x = ang / R;
  if ( x < 1.15 && discOn > 0.0 ) {
    float xc = min( x, 1.0 );
    float mu = sqrt( max( 0.0, 1.0 - xc * xc ) );
    float limb = 0.24 + 0.76 * pow( mu, 0.42 );   // solar limb darkening
    limb *= 1.0 - smoothstep( 0.90, 1.06, x );
    col += uSunTint * limb * 90.0 * discOn;
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

  const SHADOW_MAP = 4096;
  const SHADOW_HALF = 95;             // metres of half-extent around the skier
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 2800;
  sun.shadow.camera.left = -SHADOW_HALF;
  sun.shadow.camera.right = SHADOW_HALF;
  sun.shadow.camera.top = SHADOW_HALF;
  sun.shadow.camera.bottom = -SHADOW_HALF;
  sun.shadow.bias = -0.00006;
  sun.shadow.normalBias = 0.11;
  sun.shadow.radius = 2.0;        // only used if the lead switches to VSM
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  // Tiny fill so anything that ignores scene.environment is never pure black.
  // The real ambient is the IBL.
  const fill = new THREE.HemisphereLight(0xbcd6ff, 0xe6eef7, 0.12);
  scene.add(fill);

  // ---- fog ---------------------------------------------------------------
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

  const LATITUDE = 46.5 * Math.PI / 180;    // Alps
  const DECLINATION = 14.0 * Math.PI / 180; // late spring
  // Which way the piste faces. Rotates the whole solar arc so the default
  // late-morning sun rakes across the fall line instead of sitting behind the
  // camera and flattening every roller.
  const ASPECT = -82 * Math.PI / 180;

  let tod = 0.375;                 // strong late-morning bluebird by default
  let elevation = 0;
  let clock = 0;
  let envDirty = true;
  let lastEnvElev = -999;
  let lastEnvAz = -999;

  const params = {
    cloudCoverage: 0.42,
    cloudDensity: 1.0,
    cirrus: 0.22,
    windSpeed: 1.0,
    fogDensity: 0.00062,
    fogHeight: 1150,
    fogRef: 0,
    fogStart: 40,
    exposureScale: 1.0,
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
    const band = Math.exp(-Math.max(h, 0) * 10) * 0.55;
    const l = luminance(c);
    c[0] = mix(c[0], l * htx, band);
    c[1] = mix(c[1], l * hty, band);
    c[2] = mix(c[2], l * htz, band);
    const below = smoothstep01(0, -0.13, h);
    c[0] = mix(c[0], gc.x, below);
    c[1] = mix(c[1], gc.y, below);
    c[2] = mix(c[2], gc.z, below);
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

    sun.color.setRGB(sunCol[0], sunCol[1], sunCol[2], THREE.LinearSRGBColorSpace);
    sun.intensity = SUN_PEAK * (lum / 0.8955) * above;
    uniforms.uSunTint.value.set(sunCol[0], sunCol[1], sunCol[2]);

    // ---- grade tints ------------------------------------------------------
    uniforms.uZenithTint.value.set(
      mix(1.0, 0.88, day), mix(1.0, 0.93, day), mix(1.02, 1.10, day));

    // luminance-preserving: warm and desaturated at midday, blazing at sunset
    uniforms.uHorizonTint.value.set(
      0.99 + golden * 1.42,
      1.00 + golden * 0.08,
      1.03 - golden * 0.52);
    // opposite the sun: neutral by day, Belt-of-Venus pink at dusk
    uniforms.uHorizonTintCool.value.set(
      0.99 + golden * 0.34,
      1.00 - golden * 0.06,
      1.04 + golden * 0.12);
    const azLen = Math.hypot(sunDir.x, sunDir.z) || 1;
    uniforms.uSunAz.value.set(sunDir.x / azLen, sunDir.z / azLen);

    uniforms.uNightAmount.value = night;
    uniforms.uCoverage.value = params.cloudCoverage;
    uniforms.uCloudDensity.value = params.cloudDensity;
    uniforms.uCirrus.value = params.cirrus;

    // ---- read the sky back out to drive everything else -------------------
    // All of these are above the horizon, so uGroundColor (written below) does
    // not participate and the ordering is safe.
    const horizonNeutral = skyAt(1.5, Math.PI * 0.5);
    const horizonSun = skyAt(1.5, 0);
    const low = skyAt(12, Math.PI * 0.5);
    const mid = skyAt(38, Math.PI * 0.75);
    const high = skyAt(75, Math.PI);

    // Valley haze / snow bounce below the horizon: horizon sky, slightly warmed
    // and lifted, because it is really snow-and-cloud-sea reflecting the sky.
    const gb = 0.52 / SKY_CALIBRATION;   // gradeJS re-applies the calibration
    uniforms.uGroundColor.value.set(
      horizonNeutral[0] * gb * (1 + golden * 0.35),
      horizonNeutral[1] * gb * (1 + golden * 0.12),
      horizonNeutral[2] * gb * 0.98);

    // Skylight seen by cloud flanks. NOTE: the shader multiplies everything by
    // SKY_CALIBRATION at the end, so cloud radiances are stored pre-calibration.
    const inv = 1 / SKY_CALIBRATION;
    const ambR = (horizonNeutral[0] + low[0] + mid[0] + high[0]) * 0.25 * inv;
    const ambG = (horizonNeutral[1] + low[1] + mid[1] + high[1]) * 0.25 * inv;
    const ambB = (horizonNeutral[2] + low[2] + mid[2] + high[2]) * 0.25 * inv;
    uniforms.uCloudAmb.value.set(ambR * 0.62, ambG * 0.66, ambB * 0.76);

    // Sun radiance on cloud tops: less extinction up at 3 km, albedo ~0.9.
    const hiFex = sunTransmittance(Math.max(elev, 0.015) + 0.07);
    const hiPeak = Math.max(hiFex[0], hiFex[1], hiFex[2], 1e-5);
    const cloudLit = SUN_PEAK * (luminance(hiFex) / 0.8955) * above * (1.18 / Math.PI) * inv;
    uniforms.uCloudSun.value.set(
      (hiFex[0] / hiPeak) * cloudLit,
      (hiFex[1] / hiPeak) * cloudLit,
      (hiFex[2] / hiPeak) * cloudLit);

    // ---- hemisphere fill --------------------------------------------------
    fill.color.setRGB(low[0] * 2.2, low[1] * 2.2, low[2] * 2.4, THREE.LinearSRGBColorSpace);
    fill.groundColor.setRGB(
      horizonNeutral[0] * 2.0, horizonNeutral[1] * 2.0, horizonNeutral[2] * 2.0,
      THREE.LinearSRGBColorSpace);
    fill.intensity = 0.05 + 0.03 * day;

    // Snow bounces a huge amount of skylight, but a fully unoccluded hemisphere
    // flattens the render. Pull the IBL back so sun:shadow reads ~5:1.
    scene.environmentIntensity = 0.72;

    // ---- fog --------------------------------------------------------------
    // Haze colour == the sky just above the horizon, 90 deg off the sun, pulled
    // a little way up the dome. A ridge that fogs out lands on the value of the
    // sky behind it, but the slight bias toward 12 deg keeps distant snow
    // reading cooler than near snow instead of merely paler.
    const haze = [
      mix(horizonNeutral[0], low[0], 0.42),
      mix(horizonNeutral[1], low[1], 0.42),
      mix(horizonNeutral[2], low[2], 0.42),
    ];
    fog.color.setRGB(haze[0], haze[1], haze[2], THREE.LinearSRGBColorSpace);
    fog.density = params.fogDensity;

    // The extra glow you get looking through haze toward the sun.
    const glowScale = 0.55 + 0.9 * golden;
    const sunHaze = [
      Math.max(0, horizonSun[0] - haze[0]) * glowScale,
      Math.max(0, horizonSun[1] - haze[1]) * glowScale,
      Math.max(0, horizonSun[2] - haze[2]) * glowScale,
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
    FOG_AP[15] = 0.975;                // never fully erase distant geometry

    // ---- exposure ---------------------------------------------------------
    // Meter off the direct sun so golden hour opens up like a real camera.
    const meter = 0.30 + 0.70 * (lum / 0.8955) * above;
    renderer.toneMappingExposure = clamp(1.0 / meter, 1.0, 3.2) * params.exposureScale;

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

    update(dt, state) {
      clock += dt;
      uniforms.uTime.value = clock * params.windSpeed;

      updateShadow(state);

      // Rebuild the IBL only when the sun has actually moved enough to matter.
      if (envDirty) {
        const dE = Math.abs(elevation - lastEnvElev);
        const dA = Math.abs(Math.atan2(sunDir.x, sunDir.z) - lastEnvAz);
        if (dE > 0.006 || dA > 0.006) updateEnvironment();
        else envDirty = false;
      }
    },

    dispose() {
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
