/**
 * Alpine — post-processing & colour grade.
 *
 * Owns the final image. `main.js` calls `postfx.render(dt)` instead of
 * `renderer.render()`, so everything the viewer ever sees passes through here.
 *
 * Pipeline (HDR linear until the grade pass, display-referred after it):
 *
 *   scene  ──► sceneRT (half-float + depth)     camera jittered (Halton 2,3)
 *          ──► TAA resolve   reprojected history, YCoCg variance clipping;
 *                            also applies exposure, so everything downstream
 *                            is sensor-referred rather than scene-referred
 *          ──► UnrealBloom   threshold 2.3 exposed-linear, wide soft falloff
 *          ──► DOF           depth CoC, golden-angle gather bokeh
 *          ──► motion blur   depth reprojection against a *virtual* previous
 *                            camera derived from state.vel (so it works in
 *                            stills too), subject-masked, + speed lines
 *          ──► grade         lateral CA, white balance, ASC-CDL + split-tone
 *                            + saturation in LOG space, then the Uchimura GT
 *                            display transform, then sRGB
 *          ──► SMAA
 *          ──► film          contrast-adaptive sharpen, animated grain that
 *                            scales with shadow depth, vignette + speed
 *                            vignette → screen
 *
 * Design rule: every effect is tuned so a viewer could not name it. If you can
 * point at the bloom, the bloom is wrong.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// -----------------------------------------------------------------------------
// Tuning. Everything lives here so the lead can dial the look without reading
// GLSL. All values are deliberately conservative.
// -----------------------------------------------------------------------------
export const PARAMS = {
  taa: { enabled: true, feedback: 0.89, clipScale: 1.0, sharpen: 0.20 },

  bloom: {
    enabled: true,
    // Threshold is in *exposed* linear units. Sunlit snow lands around 1.0–1.6
    // after exposure, so 2.3 means only genuine speculars, the sun disc and
    // ice glints bloom — never the snow field itself.
    threshold: 2.3,
    strength: 0.20,
    radius: 0.85,
  },

  dof: {
    enabled: true,
    focus: 9.0,        // metres, driven by update()
    focusSpeed: 3.0,   // focus-pull rate (1/s)
    nearStrength: 0.55,
    farStrength: 0.40,
    farRange: 40,      // far blur reaches full strength at focus*(1+farRange)
    maxCoC: 5.0,       // px at 900p; scaled with resolution
  },

  motion: {
    enabled: true,
    shutter: 0.009,     // seconds of open shutter (≈ 1/110 s)
    maxVelocity: 0.010, // uv units — hard cap so nothing ever smears
    strength: 1.0,      // driven by update() from state.speed
    speedLines: 0.0022, // extra radial streak at frame edges at full speed
    nearFade: 1.4,      // metres — anything closer than this never blurs
    subjectRadius: 0.075,  // uv radius of the "rides with the camera" mask
    subjectProtect: 0.92,
  },

  grade: {
    // Applied before bloom (sensor-referred). Mid grey after this should sit
    // near 0.18 linear; sunlit snow around 1.0–1.6.
    exposure: 0.78,
    trim: 1.0,          // small post-bloom exposure trim
    // Uchimura "GT" tonemap. m/l give a linear section through mid grey (0.18
    // maps to 0.18) and then a long exponential shoulder — linear 1.0 lands at
    // 231/255 and 2.0 at 251/255, so sunlit snow still has two stops of
    // separation instead of a single flat white.
    P: 1.0, a: 1.0, m: 0.16, l: 0.30, c: 1.25, b: 0.0,
    temperature: 0.010,   // + warms
    tint: -0.004,
    // ASC-CDL, applied in log space (see the shader).
    lift: [-0.002, 0.0, 0.006],
    gamma: [1.0, 1.0, 1.006],
    gain: [1.004, 1.0, 0.996],
    shadowTint: [0.972, 0.992, 1.030],   // cool shadows
    highTint: [1.016, 1.003, 0.980],     // warm highlights
    contrast: 1.07,
    pivot: 0.553,           // log position of 0.18 mid grey
    saturation: 1.06,
    highlightDesat: 0.35,   // pull extreme highlights toward neutral
    chromatic: 0.55,        // px of lateral CA at the corners
  },

  film: {
    sharpen: 0.26,
    grain: 0.017,
    grainShadowBias: 1.8,   // grain multiplier in the deepest shadows
    vignette: 0.20,
    speedVignette: 0.0,     // driven by update()
    speedVignetteMax: 0.24,
  },
};

// -----------------------------------------------------------------------------
// Shared GLSL
// -----------------------------------------------------------------------------
const COMMON = /* glsl */ `
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

const DEPTH_GLSL = /* glsl */ `
// Linear eye-space depth from a packed depth texture sample.
float linearDepth(float d, float n, float f) {
  float z = d * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - z * (f - n));
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// -----------------------------------------------------------------------------
// TAA resolve — jittered accumulation with reprojection + variance clipping.
// -----------------------------------------------------------------------------
const TAA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tDepth;
uniform mat4  uReproject;      // prevViewProj * inverse(currViewProj)
uniform vec2  uTexel;
uniform float uFeedback;
uniform float uClipScale;
uniform float uSharpen;
uniform float uValid;          // 0 on the first frame / after a resize
uniform float uExposure;       // applied here so bloom sees sensor-referred light
${COMMON}

vec3 rgb2ycocg(vec3 c) {
  return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
              0.5  * c.r - 0.5 * c.b,
             -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 ycocg2rgb(vec3 c) {
  return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

void main() {
  vec3 cur = texture2D(tCurrent, vUv).rgb * uExposure;

  // --- 3x3 neighbourhood statistics (YCoCg) --------------------------------
  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  vec3 nmin = vec3(1e9), nmax = vec3(-1e9);
  vec3 blurAcc = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec3 s = texture2D(tCurrent, vUv + vec2(float(x), float(y)) * uTexel).rgb * uExposure;
      blurAcc += s;
      vec3 y3 = rgb2ycocg(s);
      m1 += y3; m2 += y3 * y3;
      nmin = min(nmin, y3); nmax = max(nmax, y3);
    }
  }
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt(max(vec3(0.0), m2 / 9.0 - mu * mu));
  vec3 lo = max(nmin, mu - sigma * uClipScale);
  vec3 hi = min(nmax, mu + sigma * uClipScale);

  // --- reprojection ---------------------------------------------------------
  float d = texture2D(tDepth, vUv).x;
  vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 prev = uReproject * clip;
  vec2 prevUv = (prev.xy / prev.w) * 0.5 + 0.5;

  float inside = step(0.0, prevUv.x) * step(prevUv.x, 1.0)
               * step(0.0, prevUv.y) * step(prevUv.y, 1.0);
  vec3 hist = texture2D(tHistory, clamp(prevUv, vec2(0.0), vec2(1.0))).rgb;

  // Clip history towards the current colour along the AABB (not clamp — clip
  // keeps far more detail and produces much less flicker).
  vec3 hy = rgb2ycocg(hist);
  vec3 cy = clamp(hy, lo, hi);
  hist = ycocg2rgb(cy);

  // Slight spatial sharpen on the current sample counteracts the softening the
  // jitter introduces (this is what keeps thin branches crisp).
  vec3 blur = blurAcc / 9.0;
  vec3 sharp = cur + (cur - blur) * uSharpen;
  sharp = max(sharp, vec3(0.0));

  float fb = uFeedback * inside * uValid;
  // Luma-weighted blend: bright fireflies get less weight, so snow speculars
  // stop crawling instead of strobing.
  float wc = 1.0 / (1.0 + luma(sharp));
  float wh = 1.0 / (1.0 + luma(hist));
  float a = (1.0 - fb) * wc;
  float b = fb * wh;
  vec3 outc = (sharp * a + hist * b) / max(1e-5, a + b);

  gl_FragColor = vec4(outc, 1.0);
}
`;

class TAAPass extends Pass {
  constructor(source, depthTexture) {
    super();
    this.needsSwap = true;
    this.source = source;
    this.uniforms = {
      tCurrent: { value: source },
      tHistory: { value: null },
      tDepth: { value: depthTexture },
      uReproject: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
      uFeedback: { value: PARAMS.taa.feedback },
      uClipScale: { value: PARAMS.taa.clipScale },
      uSharpen: { value: PARAMS.taa.sharpen },
      uValid: { value: 0 },
      uExposure: { value: PARAMS.grade.exposure },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: TAA_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv; uniform sampler2D tDiffuse;
        void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }`,
      depthTest: false, depthWrite: false,
    });
    this.fsq = new FullScreenQuad(this.material);

    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.history = [
      new THREE.WebGLRenderTarget(1, 1, opts),
      new THREE.WebGLRenderTarget(1, 1, opts),
    ];
    this.cur = 0;
    this.reset();
  }

  reset() { this.uniforms.uValid.value = 0; }

  setSize(w, h) {
    this.history[0].setSize(w, h);
    this.history[1].setSize(w, h);
    this.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.reset();
  }

  render(renderer, writeBuffer /*, readBuffer */) {
    const dst = this.history[this.cur];
    const src = this.history[1 - this.cur];

    this.uniforms.tCurrent.value = this.source;
    this.uniforms.tHistory.value = src.texture;
    this.uniforms.uFeedback.value = PARAMS.taa.feedback;
    this.uniforms.uClipScale.value = PARAMS.taa.clipScale;
    this.uniforms.uSharpen.value = PARAMS.taa.sharpen;
    this.uniforms.uExposure.value = PARAMS.grade.exposure;

    this.fsq.material = this.material;
    renderer.setRenderTarget(dst);
    this.fsq.render(renderer);

    this.copyMaterial.uniforms.tDiffuse.value = dst.texture;
    this.fsq.material = this.copyMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsq.render(renderer);

    this.cur = 1 - this.cur;
    this.uniforms.uValid.value = 1;
  }

  dispose() {
    this.history[0].dispose(); this.history[1].dispose();
    this.material.dispose(); this.copyMaterial.dispose(); this.fsq.dispose();
  }
}

/** Straight blit of the scene target (used when TAA is off). */
class BlitPass extends Pass {
  constructor(source) {
    super();
    this.needsSwap = true;
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: source }, uExposure: { value: 1 } },
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uExposure;
        void main(){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb * uExposure, 1.0); }`,
      depthTest: false, depthWrite: false,
    });
    this.fsq = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer) {
    this.material.uniforms.uExposure.value = PARAMS.grade.exposure;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsq.render(renderer);
  }
  dispose() { this.material.dispose(); this.fsq.dispose(); }
}

// -----------------------------------------------------------------------------
// Depth of field — golden-angle gather with a CoC-weighted kernel.
// -----------------------------------------------------------------------------
const DOF_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2  uTexel;
uniform vec2  uNearFar;
uniform float uFocus;
uniform float uNearStrength;
uniform float uFarStrength;
uniform float uFarRange;
uniform float uMaxCoC;      // pixels
${COMMON}
${DEPTH_GLSL}

const int TAPS = 22;
const float GOLDEN = 2.39996323;

float cocAt(vec2 uv) {
  float z = linearDepth(texture2D(tDepth, uv).x, uNearFar.x, uNearFar.y);
  if (z >= uFocus) {
    // A true thin-lens far CoC saturates within ~3x the focus distance, which
    // turns the whole landscape to mush. Stretch the ramp instead so trees and
    // mid-ground stay crisp and only genuinely distant peaks soften.
    float t = smoothstep(0.0, 1.0, (z - uFocus) / max(uFocus * uFarRange, 1e-3));
    return t * uFarStrength;
  }
  float t = clamp((uFocus - z) / max(uFocus, 1e-3), 0.0, 1.0);
  return -t * uNearStrength;
}

void main() {
  float cocC = cocAt(vUv);
  float rPix = abs(cocC) * uMaxCoC;

  if (rPix < 0.6) {
    gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0);
    return;
  }

  // Rotate the kernel per pixel so the 22 taps never read as a ring pattern.
  float ang0 = hash12(gl_FragCoord.xy) * 6.2831853;
  vec3 acc = texture2D(tDiffuse, vUv).rgb;
  float wsum = 1.0;

  for (int i = 0; i < TAPS; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / float(TAPS));
    float a = fi * GOLDEN + ang0;
    vec2 off = vec2(cos(a), sin(a)) * r;
    vec2 uv2 = vUv + off * rPix * uTexel;

    vec3 c = texture2D(tDiffuse, uv2).rgb;
    float coc2 = abs(cocAt(uv2)) * uMaxCoC;
    // A sample only spills onto this pixel if its own circle of confusion
    // reaches it — this is what stops sharp foreground haloing the far peaks.
    float w = clamp(coc2 - r * rPix + 1.0, 0.0, 1.0);
    acc += c * w;
    wsum += w;
  }

  gl_FragColor = vec4(acc / wsum, 1.0);
}
`;

// -----------------------------------------------------------------------------
// Motion blur — depth reprojection against a virtual previous camera, plus a
// speed-line term for the sky/far field where reprojection velocity is ~0.
// -----------------------------------------------------------------------------
const MB_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4  uReproject;
uniform vec2  uNearFar;
uniform vec2  uFocalCentre;
uniform float uStrength;
uniform float uMaxVel;
uniform float uSpeedLines;
uniform float uNearFade;
uniform vec3  uSubject;        // xy = screen uv of the skier, z = its distance
uniform vec2  uSubjectShape;   // x = screen radius, y = protection amount
${COMMON}
${DEPTH_GLSL}

const int SAMPLES = 11;

void main() {
  float d = texture2D(tDepth, vUv).x;
  vec3 base = texture2D(tDiffuse, vUv).rgb;

  if (uStrength <= 0.001) { gl_FragColor = vec4(base, 1.0); return; }

  vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 prev = uReproject * clip;
  vec2 prevUv = (prev.xy / prev.w) * 0.5 + 0.5;
  vec2 vel = vUv - prevUv;

  float z = linearDepth(d, uNearFar.x, uNearFar.y);
  vel *= smoothstep(uNearFade, uNearFade * 2.5, z);   // anything hugging the lens

  // The skier travels *with* the camera, so depth reprojection — which assumes
  // a static world — would smear the one thing that must stay readable. Protect
  // pixels that are both near the subject on screen and at its depth.
  float dd = distance(vUv, uSubject.xy) / max(uSubjectShape.x, 1e-3);
  float zrel = abs(z - uSubject.z) / max(uSubject.z, 1.0);
  float prot = exp(-dd * dd) * (1.0 - smoothstep(0.18, 0.55, zrel));
  vel *= 1.0 - uSubjectShape.y * prot;

  // Stylised radial streak, strongest at the corners. Sells speed on the sky
  // and distant ridges, which have almost no parallax velocity.
  vec2 rd = vUv - uFocalCentre;
  vel += rd * dot(rd, rd) * uSpeedLines * 4.0;

  vel *= uStrength;
  float len = length(vel);
  if (len > uMaxVel) vel *= uMaxVel / len;
  if (len < 0.00035) { gl_FragColor = vec4(base, 1.0); return; }

  float jitter = hash12(gl_FragCoord.xy) - 0.5;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float t = (float(i) + 0.5 + jitter) / float(SAMPLES) - 0.5;
    vec2 uv2 = clamp(vUv - vel * t, vec2(0.001), vec2(0.999));
    float w = 1.0 - abs(t) * 0.7;          // slight centre bias
    acc += texture2D(tDiffuse, uv2).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}
`;

// -----------------------------------------------------------------------------
// Grade — HDR in, display-referred sRGB out.
// -----------------------------------------------------------------------------
const GRADE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uExposure;
uniform vec4  uGT1;        // P, a, m, l
uniform vec2  uGT2;        // c, b
uniform vec2  uWhiteBalance;
uniform vec3  uLift, uGamma, uGain;
uniform vec3  uShadowTint, uHighTint;
uniform float uContrast, uPivot, uSaturation, uHighDesat;
uniform float uChromatic;
uniform vec2  uTexel;
${COMMON}

// Log encoding used for the creative grade: 2^-8 … 2^+2 mapped to 0…1.
#define LOG_LO 8.0
#define LOG_RANGE 10.0

// Uchimura 2017 "GT" tonemap: explicit toe / linear / shoulder. The long linear
// section plus an exponential shoulder is what keeps texture in bright snow.
float gt(float x, float P, float a, float m, float l, float c, float b) {
  float l0 = ((P - m) * l) / a;
  float S0 = m + l0;
  float S1 = m + a * l0;
  float C2 = (a * P) / (P - S1);
  float CP = -C2 / P;
  float w0 = 1.0 - smoothstep(0.0, m, x);
  float w2 = step(m + l0, x);
  float w1 = 1.0 - w0 - w2;
  float T = m * pow(max(x, 1e-5) / m, c) + b;
  float S = P - (P - S1) * exp(CP * (x - S0));
  float L = m + a * (x - m);
  return T * w0 + L * w1 + S * w2;
}
vec3 gt3(vec3 x) {
  return vec3(gt(x.r, uGT1.x, uGT1.y, uGT1.z, uGT1.w, uGT2.x, uGT2.y),
              gt(x.g, uGT1.x, uGT1.y, uGT1.z, uGT1.w, uGT2.x, uGT2.y),
              gt(x.b, uGT1.x, uGT1.y, uGT1.z, uGT1.w, uGT2.x, uGT2.y));
}

vec3 sRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d) * 4.0;

  // Lateral chromatic aberration: zero in the centre, r^2 to the corners, and
  // never more than a fraction of a pixel of separation.
  vec2 ca = d * r2 * uChromatic * uTexel.x * 2.0;
  vec3 col;
  col.r = texture2D(tDiffuse, vUv + ca).r;
  col.g = texture2D(tDiffuse, vUv).g;
  col.b = texture2D(tDiffuse, vUv - ca).b;

  // Exposure was already applied ahead of the bloom (see TAAPass) so that the
  // bloom threshold is sensor-referred rather than scene-referred. uExposure
  // here is a small post-bloom trim only.
  col = max(col, vec3(0.0)) * uExposure;

  // white balance (cheap temperature / tint in the working space)
  col *= vec3(1.0 + uWhiteBalance.x, 1.0 + uWhiteBalance.y * 0.5, 1.0 - uWhiteBalance.x);

  // --- creative grade, in log space, BEFORE the display transform -----------
  // Doing contrast / CDL / split-tone after the tonemap is what makes cheap
  // renderers clip: the shoulder rolls a value to 0.98 and the grade multiplies
  // it straight back through 1.0. In log space the tonemap always gets the last
  // word, so sunlit snow can never lose its texture to a gain.
  vec3 lg = clamp((log2(col + 1e-4) + LOG_LO) / LOG_RANGE, 0.0, 1.2);

  lg = (lg - uPivot) * uContrast + uPivot;            // S-curve about mid grey
  lg = pow(max(lg * uGain + uLift, vec3(0.0)), uGamma); // ASC-CDL
  float w = smoothstep(0.30, 0.86, dot(lg, vec3(0.3333)));
  lg *= mix(uShadowTint, uHighTint, w);              // split tone
  float Yl = luma(lg);
  lg = mix(vec3(Yl), lg, uSaturation);

  col = max(exp2(clamp(lg, 0.0, 1.35) * LOG_RANGE - LOG_LO) - 1e-4, vec3(0.0));

  // --- display transform ----------------------------------------------------
  // Per-channel filmic, blended toward a luminance-only curve so bright snow
  // keeps its faint blue/warm modelling instead of going flat white.
  vec3 perCh = gt3(col);
  float Y = max(luma(col), 1e-5);
  vec3 byLuma = col * (gt(Y, uGT1.x, uGT1.y, uGT1.z, uGT1.w, uGT2.x, uGT2.y) / Y);
  col = clamp(mix(perCh, byLuma, 0.4), 0.0, 1.0);

  // ease saturation off in the extreme highlights so speculars read as light
  float Y2 = luma(col);
  col = mix(col, vec3(Y2), uHighDesat * smoothstep(0.86, 1.0, Y2));

  gl_FragColor = vec4(sRGB(col), 1.0);
}
`;

// -----------------------------------------------------------------------------
// Film — sharpen, grain, vignette. Display space, after SMAA.
// -----------------------------------------------------------------------------
const FILM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2  uTexel;
uniform float uSharpen;
uniform float uGrain;
uniform float uGrainShadow;
uniform float uVignette;
uniform float uSpeedVignette;
uniform float uTime;
${COMMON}

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;

  // Contrast-adaptive sharpen (AMD CAS, reduced): scale the sharpening by local
  // contrast so flat snow gains no crunch but branch edges do.
  vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, -uTexel.y)).rgb;
  vec3 s = texture2D(tDiffuse, vUv + vec2(0.0,  uTexel.y)).rgb;
  vec3 w = texture2D(tDiffuse, vUv + vec2(-uTexel.x, 0.0)).rgb;
  vec3 e = texture2D(tDiffuse, vUv + vec2( uTexel.x, 0.0)).rgb;
  vec3 mn = min(min(min(n, s), min(w, e)), c);
  vec3 mx = max(max(max(n, s), max(w, e)), c);
  vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0);
  amp = sqrt(amp);
  vec3 blur = (n + s + w + e) * 0.25;
  c = clamp(c + (c - blur) * amp * uSharpen, 0.0, 1.0);

  // Animated fine grain, heavier in the shadows where a real sensor is noisier.
  float g = hash12(gl_FragCoord.xy + vec2(uTime * 131.7, uTime * 97.3));
  float g2 = hash12(gl_FragCoord.xy * 0.5 - vec2(uTime * 71.1, uTime * 53.9));
  float noise = (g + g2 - 1.0);
  float Y = luma(c);
  float amount = uGrain * mix(uGrainShadow, 0.35, smoothstep(0.0, 0.75, Y));
  c += noise * amount;

  // Vignette: a soft optical falloff, plus a speed-driven one that closes the
  // corners as the run gets fast.
  vec2 d = vUv - 0.5;
  float r = length(d) * 1.4142;
  float vig = 1.0 - uVignette * pow(smoothstep(0.25, 1.0, r), 1.6);
  float sv = 1.0 - uSpeedVignette * pow(smoothstep(0.10, 0.95, r), 2.0);
  c *= vig * sv;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

// -----------------------------------------------------------------------------
// Halton for the TAA jitter.
// -----------------------------------------------------------------------------
function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}
const JITTER = [];
for (let i = 1; i <= 16; i++) JITTER.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);

// -----------------------------------------------------------------------------
export function createPostFX(renderer, scene, camera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  let W = Math.max(2, size.x | 0), H = Math.max(2, size.y | 0);

  // --- scene target ----------------------------------------------------------
  const depthTexture = new THREE.DepthTexture(W, H);
  depthTexture.format = THREE.DepthFormat;
  depthTexture.type = THREE.UnsignedIntType;
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;

  const sceneRT = new THREE.WebGLRenderTarget(W, H, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture,
  });
  sceneRT.texture.name = 'postfx.scene';

  // --- composer --------------------------------------------------------------
  const composerRT = new THREE.WebGLRenderTarget(W, H, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  const composer = new EffectComposer(renderer, composerRT);
  composer.setPixelRatio(1);            // we already work in device pixels
  composer.setSize(W, H);

  const taaPass = new TAAPass(sceneRT.texture, depthTexture);
  const blitPass = new BlitPass(sceneRT.texture);
  blitPass.enabled = !PARAMS.taa.enabled;
  taaPass.enabled = PARAMS.taa.enabled;

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(W, H), PARAMS.bloom.strength, PARAMS.bloom.radius, PARAMS.bloom.threshold);
  bloomPass.enabled = PARAMS.bloom.enabled;

  const dofPass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: depthTexture },
      uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
      uNearFar: { value: new THREE.Vector2(camera.near, camera.far) },
      uFocus: { value: PARAMS.dof.focus },
      uNearStrength: { value: PARAMS.dof.nearStrength },
      uFarStrength: { value: PARAMS.dof.farStrength },
      uFarRange: { value: PARAMS.dof.farRange },
      uMaxCoC: { value: PARAMS.dof.maxCoC },
    },
    vertexShader: VERT,
    fragmentShader: DOF_FRAG,
  }), 'tDiffuse');
  dofPass.enabled = PARAMS.dof.enabled;

  const mbPass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: depthTexture },
      uReproject: { value: new THREE.Matrix4() },
      uNearFar: { value: new THREE.Vector2(camera.near, camera.far) },
      uFocalCentre: { value: new THREE.Vector2(0.5, 0.5) },
      uStrength: { value: 0 },
      uMaxVel: { value: PARAMS.motion.maxVelocity },
      uSpeedLines: { value: 0 },
      uNearFade: { value: PARAMS.motion.nearFade },
      uSubject: { value: new THREE.Vector3(0.5, 0.5, 9) },
      uSubjectShape: { value: new THREE.Vector2(PARAMS.motion.subjectRadius, PARAMS.motion.subjectProtect) },
    },
    vertexShader: VERT,
    fragmentShader: MB_FRAG,
  }), 'tDiffuse');
  mbPass.enabled = PARAMS.motion.enabled;

  const g = PARAMS.grade;
  const gradePass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uExposure: { value: g.trim },
      uGT1: { value: new THREE.Vector4(g.P, g.a, g.m, g.l) },
      uGT2: { value: new THREE.Vector2(g.c, g.b) },
      uWhiteBalance: { value: new THREE.Vector2(g.temperature, g.tint) },
      uLift: { value: new THREE.Vector3(...g.lift) },
      uGamma: { value: new THREE.Vector3(...g.gamma) },
      uGain: { value: new THREE.Vector3(...g.gain) },
      uShadowTint: { value: new THREE.Vector3(...g.shadowTint) },
      uHighTint: { value: new THREE.Vector3(...g.highTint) },
      uContrast: { value: g.contrast },
      uPivot: { value: g.pivot },
      uSaturation: { value: g.saturation },
      uHighDesat: { value: g.highlightDesat },
      uChromatic: { value: g.chromatic },
      uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
    },
    vertexShader: VERT,
    fragmentShader: GRADE_FRAG,
  }), 'tDiffuse');

  const smaaPass = new SMAAPass();

  const filmPass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
      uSharpen: { value: PARAMS.film.sharpen },
      uGrain: { value: PARAMS.film.grain },
      uGrainShadow: { value: PARAMS.film.grainShadowBias },
      uVignette: { value: PARAMS.film.vignette },
      uSpeedVignette: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FILM_FRAG,
  }), 'tDiffuse');
  filmPass.renderToScreen = true;

  composer.addPass(taaPass);
  composer.addPass(blitPass);
  composer.addPass(bloomPass);
  composer.addPass(dofPass);
  composer.addPass(mbPass);
  composer.addPass(gradePass);
  composer.addPass(smaaPass);
  composer.addPass(filmPass);

  // --- per-frame scratch -----------------------------------------------------
  const projU = new THREE.Matrix4();
  const viewU = new THREE.Matrix4();
  const currVP = new THREE.Matrix4();
  const currVPInv = new THREE.Matrix4();
  const prevVP = new THREE.Matrix4();
  const tmpM = new THREE.Matrix4();
  const trans = new THREE.Matrix4();
  const camVel = new THREE.Vector3();
  const foeWorld = new THREE.Vector3();
  const foe = new THREE.Vector3();
  const subjWorld = new THREE.Vector3(0, 0, 0);
  const subj = new THREE.Vector3();
  let subjDist = 9;
  let jitterIndex = 0;
  let havePrev = false;
  let time = 0;

  let cocScale = 1;
  let focus = PARAMS.dof.focus;
  let mbAmount = 0;
  let speedVig = 0;

  const api = {
    enabled: true,
    params: PARAMS,
    composer,

    setSize(w, h) {
      const pr = renderer.getPixelRatio();
      W = Math.max(2, Math.round(w * pr));
      H = Math.max(2, Math.round(h * pr));
      sceneRT.setSize(W, H);
      composer.setSize(W, H);
      dofPass.uniforms.uTexel.value.set(1 / W, 1 / H);
      gradePass.uniforms.uTexel.value.set(1 / W, 1 / H);
      filmPass.uniforms.uTexel.value.set(1 / W, 1 / H);
      cocScale = H / 900;
      dofPass.uniforms.uMaxCoC.value = PARAMS.dof.maxCoC * cocScale;
      bloomPass.setSize(W, H);
      taaPass.setSize(W, H);
      havePrev = false;
    },

    /** Drives focus pull, motion blur and the speed vignette from the sim. */
    update(dt, state) {
      const d = Math.min(dt, 0.1);

      // --- autofocus on the skier ------------------------------------------
      const target = THREE.MathUtils.clamp(camera.position.distanceTo(state.pos) + 0.6, 1.5, 200);
      const k = 1 - Math.exp(-PARAMS.dof.focusSpeed * d);
      focus += (target - focus) * k;

      // --- speed-driven terms ----------------------------------------------
      const sp = THREE.MathUtils.clamp((state.speed - 5) / 32, 0, 1);
      const gf = THREE.MathUtils.clamp(state.gForce / 2.5, 0, 1);
      const wantMB = Math.pow(sp, 1.15) * PARAMS.motion.strength;
      const wantVig = (sp * 0.78 + gf * 0.22) * PARAMS.film.speedVignetteMax;
      const kk = 1 - Math.exp(-6 * d);
      mbAmount += (wantMB - mbAmount) * kk;
      speedVig += (wantVig - speedVig) * kk;

      camVel.copy(state.vel);
      subjWorld.set(state.pos.x, state.pos.y + 1.0, state.pos.z);
      subjDist = target;

      // Focus of expansion: where the camera is heading, in screen space. The
      // speed lines radiate from there, not from the frame centre.
      if (state.speed > 1) {
        foeWorld.copy(camera.position).addScaledVector(state.vel, 200 / Math.max(state.speed, 1));
      } else {
        foeWorld.copy(state.pos);
      }
    },

    render(dt) {
      if (!api.enabled) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      time += dt || 0;

      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

      projU.copy(camera.projectionMatrix);
      viewU.copy(camera.matrixWorldInverse);
      currVP.multiplyMatrices(projU, viewU);
      currVPInv.copy(currVP).invert();

      // --- render the scene with a sub-pixel jitter -------------------------
      const useTAA = PARAMS.taa.enabled;
      taaPass.enabled = useTAA;
      blitPass.enabled = !useTAA;

      if (useTAA) {
        const j = JITTER[jitterIndex % JITTER.length];
        jitterIndex++;
        camera.projectionMatrix.elements[8] += (j[0] * 2) / W;
        camera.projectionMatrix.elements[9] += (j[1] * 2) / H;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }

      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);

      if (useTAA) {
        camera.projectionMatrix.copy(projU);
        camera.projectionMatrixInverse.copy(projU).invert();
      }

      // --- TAA reprojection matrix ------------------------------------------
      if (!havePrev) prevVP.copy(currVP);
      taaPass.uniforms.uReproject.value.multiplyMatrices(prevVP, currVPInv);

      // --- motion blur: virtual previous camera at pos - vel*shutter ---------
      const shutter = PARAMS.motion.shutter;
      trans.makeTranslation(camVel.x * shutter, camVel.y * shutter, camVel.z * shutter);
      tmpM.multiplyMatrices(viewU, trans);   // prev view
      tmpM.premultiply(projU);               // prev viewProj
      mbPass.uniforms.uReproject.value.multiplyMatrices(tmpM, currVPInv);
      mbPass.uniforms.uStrength.value = mbAmount;
      mbPass.uniforms.uMaxVel.value = PARAMS.motion.maxVelocity;
      mbPass.uniforms.uSpeedLines.value = PARAMS.motion.speedLines * mbAmount;
      mbPass.uniforms.uNearFade.value = PARAMS.motion.nearFade;
      mbPass.enabled = PARAMS.motion.enabled && mbAmount > 0.002;

      foe.copy(foeWorld).project(camera);
      mbPass.uniforms.uFocalCentre.value.set(
        THREE.MathUtils.clamp(foe.x * 0.5 + 0.5, -0.6, 1.6),
        THREE.MathUtils.clamp(foe.y * 0.5 + 0.5, -0.6, 1.6));

      subj.copy(subjWorld).project(camera);
      mbPass.uniforms.uSubject.value.set(subj.x * 0.5 + 0.5, subj.y * 0.5 + 0.5, subjDist);
      mbPass.uniforms.uSubjectShape.value.set(PARAMS.motion.subjectRadius, PARAMS.motion.subjectProtect);

      // --- per-frame uniforms ------------------------------------------------
      dofPass.enabled = PARAMS.dof.enabled;
      dofPass.uniforms.uFocus.value = focus;
      dofPass.uniforms.uNearStrength.value = PARAMS.dof.nearStrength;
      dofPass.uniforms.uFarStrength.value = PARAMS.dof.farStrength;
      dofPass.uniforms.uFarRange.value = PARAMS.dof.farRange;
      dofPass.uniforms.uNearFar.value.set(camera.near, camera.far);
      mbPass.uniforms.uNearFar.value.set(camera.near, camera.far);

      bloomPass.enabled = PARAMS.bloom.enabled;
      bloomPass.strength = PARAMS.bloom.strength;
      bloomPass.radius = PARAMS.bloom.radius;
      bloomPass.threshold = PARAMS.bloom.threshold;

      // Push the whole grade every frame so PARAMS stays live-tuneable.
      const gp = PARAMS.grade, gu = gradePass.uniforms;
      gu.uExposure.value = gp.trim;
      gu.uChromatic.value = gp.chromatic;
      gu.uGT1.value.set(gp.P, gp.a, gp.m, gp.l);
      gu.uGT2.value.set(gp.c, gp.b);
      gu.uWhiteBalance.value.set(gp.temperature, gp.tint);
      gu.uLift.value.fromArray(gp.lift);
      gu.uGamma.value.fromArray(gp.gamma);
      gu.uGain.value.fromArray(gp.gain);
      gu.uShadowTint.value.fromArray(gp.shadowTint);
      gu.uHighTint.value.fromArray(gp.highTint);
      gu.uContrast.value = gp.contrast;
      gu.uPivot.value = gp.pivot;
      gu.uSaturation.value = gp.saturation;
      gu.uHighDesat.value = gp.highlightDesat;
      dofPass.uniforms.uMaxCoC.value = PARAMS.dof.maxCoC * cocScale;
      filmPass.uniforms.uGrainShadow.value = PARAMS.film.grainShadowBias;

      filmPass.uniforms.uTime.value = time;
      filmPass.uniforms.uGrain.value = PARAMS.film.grain;
      filmPass.uniforms.uSharpen.value = PARAMS.film.sharpen;
      filmPass.uniforms.uVignette.value = PARAMS.film.vignette;
      filmPass.uniforms.uSpeedVignette.value = speedVig + PARAMS.film.speedVignette;

      composer.render(dt);

      prevVP.copy(currVP);
      havePrev = true;
      renderer.setRenderTarget(null);
    },

    dispose() {
      sceneRT.dispose();
      composer.dispose();
      taaPass.dispose();
      blitPass.dispose();
    },
  };

  api.setSize(W / renderer.getPixelRatio(), H / renderer.getPixelRatio());
  return api;
}
