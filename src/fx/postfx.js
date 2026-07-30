/**
 * Alpine — post-processing & colour grade.
 *
 * Owns the final image. `main.js` calls `postfx.render(dt)` instead of
 * `renderer.render()`, so everything the viewer ever sees passes through here.
 *
 * Pipeline (HDR linear until the grade pass, display-referred after it):
 *
 *   scene  ──► sceneRT (half-float + depth)     camera jittered (Halton 2,3)
 *          ──► TAA resolve   reprojected history (through the JITTERED inverse
 *                            view-projection, so the half-pixel offset the
 *                            jitter just applied is undone), YCoCg variance
 *                            clipping, then a second output step that adds the
 *                            current frame's high-frequency residual back on
 *                            top — that is what keeps snow sparkle alive
 *                            through a temporal filter. Also applies exposure,
 *                            so everything downstream is sensor-referred.
 *          ──► UnrealBloom   threshold 2.6 exposed-linear, with a firefly clamp
 *                            and a soft knee on the high pass and an explicitly
 *                            authored (narrow) pyramid: only specular glints and
 *                            the sun disc, never the snow, and never an orb
 *          ──► DOF           depth CoC, golden-angle gather bokeh. Deep focus:
 *                            the far field is essentially sharp (no CoC at all
 *                            inside 1 km, ~1 px at the horizon), the near field
 *                            gets what defocus there is, like a 35 mm at f/8.
 *          ──► motion blur   true per-pixel velocity: the frame is reprojected
 *                            against a virtual camera placed one *shutter* back
 *                            along the real camera path (translation from
 *                            state.vel, rotation slerped from last frame), so
 *                            displacement is depth-correct — near ground streaks,
 *                            distant peaks do not move. Hard-capped in PIXELS,
 *                            and gated off entirely below ~55 km/h.
 *          ──► grade         lateral CA, white balance, ASC-CDL + split-tone
 *                            + saturation in LOG space, then the Uchimura GT
 *                            display transform, then sRGB
 *          ──► SMAA          off by default — TAA already resolves the edges
 *                            and a second pass only rounds off the ridgelines
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
  // TAA. `feedback` is the weight of the reprojected history. It used to be
  // 0.89 — a nine-frame box average — which measured out at a 21–26% loss of
  // snow micro-detail against the un-antialiased render, i.e. TAA was quietly
  // deleting a fifth of the one thing the snow shader exists to produce.
  //
  // `detail` is the fix that matters. A snow sparkle only exists in the *current*
  // frame: the history at that texel is dim, so any feedback above ~0.5 blends it
  // away no matter how the neighbourhood clamp is tuned. So the resolve writes a
  // clean, stable temporal average into the history buffer, and the *output* step
  // adds the current frame's high-frequency residual back on top at full
  // amplitude. Because the injection happens after the history write it cannot
  // accumulate, which is what makes it safe to run at a high amount.
  taa: {
    enabled: true,
    feedback: 0.78,
    clipScale: 1.0,
    sharpen: 0.10,      // pre-blend sharpen; mostly superseded by `detail`
    detail: 0.55,       // current-frame high-frequency re-injected on output
    detailLimit: 0.22,  // soft ceiling on that residual, as a fraction of level
    clipRelax: 0.45,    // extra history rejection when the clamp had to work hard
  },

  // SMAA on top of TAA is belt-and-braces that costs real sharpness: the jitter
  // already resolves every edge in the frame, and running a second morphological
  // pass over the result rounds off exactly the ridgelines and ski edges the
  // terrain team spent their budget on. Measured A/B at the `trees` framing: the
  // peaks read visibly crisper with it off and no aliasing appears. Kept in the
  // chain, switched off, in case TAA is ever disabled — then this must come back.
  smaa: { enabled: false },

  bloom: {
    enabled: true,
    // Threshold is in *exposed* linear units. Sunlit snow lands around 1.0–1.6
    // after exposure, so 2.6 means only genuine speculars, the sun disc and ice
    // glints bloom — never the snow field itself.
    //
    // Threshold alone is not enough, and this is the mistake this pass used to
    // make. A snow sparkle is a *single pixel* at 6–15x white; the stock
    // UnrealBloom high-pass passes that pixel through at FULL value once it is
    // over threshold, and the stock pyramid then weights the 1/32-res mip at
    // 0.44. One pixel of ice therefore came back as a 25 px soft orb — the
    // dirty-lens look, and the one effect a viewer can name on sight. Three
    // things fix it and all three are needed:
    //   * `clamp`  — fireflies are clipped to this many units of exposed white
    //                BEFORE the high pass, so no single pixel can dominate;
    //   * soft knee — the high pass subtracts the threshold instead of passing
    //                the whole texel, so a value just over the line contributes
    //                almost nothing (see BLOOM_HIGHPASS_FRAG);
    //   * `mipWeights` — the pyramid is authored explicitly rather than via the
    //                `radius` mirror trick, so the two widest mips (which are
    //                what actually make an orb) are almost switched off. The
    //                sun disc is thousands of units and still blooms through
    //                them; a 3 px sparkle does not.
    threshold: 2.6,
    strength: 0.10,
    radius: 0.0,        // pyramid shape comes from mipWeights, not this
    clamp: 8.0,         // × exposed white — firefly ceiling on the bloom input
    knee: 1.1,          // width of the soft knee, in exposed-linear units
    // half, 1/4, 1/8, 1/16, 1/32 resolution mips
    mipWeights: [1.0, 0.42, 0.16, 0.06, 0.03],
  },

  // Deep focus. A chase camera on a 35 mm-equivalent lens stopped down to f/8
  // is sharp from a couple of metres to infinity; the *only* legitimate defocus
  // in this frame is a whisper on the very near foreground and a barely-there
  // softening on peaks kilometres away. The distant ridgeline is the most
  // detailed thing on screen and must survive intact.
  dof: {
    enabled: true,
    focus: 9.0,        // metres, driven by update()
    focusSpeed: 3.0,   // focus-pull rate (1/s)
    nearStrength: 1.0, // full CoC only for things basically touching the lens
    nearRange: 0.62,   // fraction of the focus distance the near ramp spans
    farStrength: 0.34, // ceiling on the far CoC (× maxCoC px)
    farStart: 260,     // metres — nothing before this softens at all
    farEnd: 2600,      // metres — far CoC ceiling reached here
    maxCoC: 3.0,       // px at 900p; scaled with resolution
  },

  motion: {
    enabled: true,
    shutter: 0.008,     // seconds of open shutter (≈ 1/125 s, a sports shutter)
    maxPixels: 4.0,     // px at 900p — hard cap; nothing ever smears past this
    strength: 1.0,      // driven by update() from state.speed
    // Gate. Below `speedLo` there is no blur at all; it reaches full weight at
    // `speedHi`. 15 m/s ≈ 54 km/h, 30 m/s ≈ 108 km/h.
    speedLo: 15.0,
    speedHi: 30.0,
    nearFade: 1.2,      // metres — anything closer than this never blurs
    subjectRadius: 0.085,  // uv radius of the "rides with the camera" mask
    subjectProtect: 0.94,
  },

  grade: {
    // Applied before bloom (sensor-referred). Mid grey after this should sit
    // near 0.18 linear; sunlit snow around 1.0–1.6.
    exposure: 0.88,
    // Post-bloom trim. Held at 1.0 the mid-field piste sat at 244 with its top
    // decile at 254 — snow pinned against paper white with nowhere left to show
    // relief, which is most of why the frame read "washed". Steep's screenshots
    // put lit snow at 182–229 and an alpine photograph at 211–215. This is a
    // deliberately small −0.07 stop: enough to unpin the highlights without
    // fighting whatever the lighting pass does to the sun.
    trim: 0.952,        // small post-bloom exposure trim
    // Uchimura "GT" tonemap. m/l give a linear section through mid grey (0.18
    // maps to 0.18) and then a long exponential shoulder — linear 1.0 lands at
    // 231/255 and 2.0 at 251/255, so sunlit snow still has two stops of
    // separation instead of a single flat white.
    P: 1.0, a: 1.0, m: 0.16, l: 0.30, c: 1.45, b: 0.0,
    // White balance. Was +0.010 warm on top of a warm split tone, which double
    // counted: snow measured 17 codes warm. The remaining bias is a hair of
    // warmth, which is what direct sun on snow actually is once the blue sky
    // fill is accounted for.
    temperature: 0.002,   // + warms
    tint: -0.004,
    // ASC-CDL, applied in log space (see the shader).
    lift: [-0.002, 0.0, 0.006],
    gamma: [1.0, 1.0, 1.006],
    gain: [1.000, 1.0, 1.000],
    // Split tone. Snow shadows are already lit by a blue sky, so the cool push
    // here is tiny — any more and the shade goes lavender.
    // Cool shadows. The old value put G *below* the R→B line, which is a magenta
    // bias: measured on the `trees` framing our shaded snow came out 113,128,180
    // — R→B midpoint 146, G 18 codes under it, i.e. violet. Steep's shaded snow
    // measures 84,107,129, with G sitting exactly on the line: clean blue, no
    // magenta. G is now a shade ABOVE the line, so shade reads blue-cyan the way
    // sky-lit snow actually does.
    shadowTint: [0.973, 1.000, 1.027],   // cool shadows
    highTint: [1.018, 1.004, 0.982],     // warm *mid*-highlights (rock, trees)
    // Log-luma window over which the split tone fades back to neutral. Sunlit
    // snow sits at ~0.83 in this log space, mid-tone rock and conifer around
    // 0.55–0.68, so this leaves the warm push exactly where it belongs and
    // takes it off the snow. See the comment in GRADE_FRAG.
    highNeutral: [0.715, 0.815],
    // Where the split tone crosses from shadowTint to highTint, in log luma.
    // This used to start at 0.30, which put the *mid-tones* — rock faces, lit
    // conifers, the whole middle of the frame — on the warm side of the split.
    // Measured full-frame, our image averaged B−R +5 where Steep's screenshots
    // average +27 to +31 and an alpine photograph +37: AAA alpine frames are
    // overwhelmingly cool everywhere except the sunlit highlights, which are
    // neutral. Starting the crossover at 0.52 puts the mids back in the cool
    // half, and highNeutral above still keeps sunlit snow neutral.
    splitWindow: [0.52, 0.90],
    // Magenta guard for the cool end — see GRADE_FRAG. 0 disables it.
    shadeHue: 0.40,
    contrast: 1.115,
    sCurve: 0.16,           // extra mid-tone slope; decays to 0 at both ends
    pivot: 0.553,           // log position of 0.18 mid grey
    saturation: 1.01,
    highlightDesat: 0.30,   // pull extreme highlights toward neutral
    // Lateral CA. Was 0.40 px, which is fine on any continuous edge and wrong on
    // a snow field: every one-pixel sparkle picked up a red side and a blue side
    // and the mid-field filled with what reads as magenta compression confetti.
    // Measured against the same frame with CA off, that was the single most
    // visible remaining artefact. A sixth of a pixel still separates the corners
    // of a long edge without ever fringing a point highlight.
    chromatic: 0.16,        // px of lateral CA at the corners
  },

  film: {
    sharpen: 0.32,
    grain: 0.012,
    grainShadowBias: 1.6,   // grain multiplier in the deepest shadows
    vignette: 0.13,
    speedVignette: 0.0,     // driven by update()
    speedVignetteMax: 0.10,
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
uniform float uClipRelax;
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

  // The old blend was Karis luma weighting — 1/(1+luma) on each side. That is a
  // firefly filter, and on a snow field the "fireflies" ARE the subject: every
  // specular got systematically down-weighted relative to the dull snow around
  // it, so the sparkle was attenuated by construction. It is gone. What replaces
  // it is a *clip-distance* rejection: if the neighbourhood clamp had to drag the
  // history a long way, the history was describing different geometry (an
  // occlusion edge, a moved specular) and deserves less weight. That kills
  // ghosting without ever penalising a pixel for being bright.
  float clipDist = length(hy - cy) / (length(sigma) * uClipScale + 0.06);
  fb *= 1.0 - uClipRelax * clamp(clipDist, 0.0, 1.0);

  vec3 outc = mix(sharp, hist, fb);

  gl_FragColor = vec4(outc, 1.0);
}
`;

// Output step of the TAA resolve. Blits the freshly written history and adds the
// CURRENT frame's high-frequency residual back on top. See PARAMS.taa.detail.
const TAA_OUT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;     // resolved history
uniform sampler2D tCurrent;     // this frame's jittered render (pre-exposure)
uniform vec2  uTexel;
uniform float uDetail;
uniform float uDetailLimit;
uniform float uExposure;
${COMMON}
void main() {
  vec3 res = texture2D(tDiffuse, vUv).rgb;
  if (uDetail <= 0.001) { gl_FragColor = vec4(res, 1.0); return; }
  vec3 c  = texture2D(tCurrent, vUv).rgb;
  vec3 n  = texture2D(tCurrent, vUv + vec2(0.0, -uTexel.y)).rgb;
  vec3 s  = texture2D(tCurrent, vUv + vec2(0.0,  uTexel.y)).rgb;
  vec3 w  = texture2D(tCurrent, vUv + vec2(-uTexel.x, 0.0)).rgb;
  vec3 e  = texture2D(tCurrent, vUv + vec2( uTexel.x, 0.0)).rgb;
  vec3 mean4 = (n + s + w + e) * 0.25;

  // LUMINANCE ONLY. A per-channel residual turns the snow shader's slightly
  // iridescent sparkle into magenta confetti, because the negative lobe of the
  // unsharp kernel lands on a different channel than the positive one. A neutral
  // luminance delta on near-white snow is indistinguishable and cannot fringe.
  float ym = luma(mean4) * uExposure;
  float yc = luma(c) * uExposure;
  float hf = yc - ym;

  // HALO GUARD. Snow sparkle is a single pixel at many times white. Its four
  // neighbours therefore see a large NEGATIVE residual, and since the sparkle
  // itself is already clipped at display white, all the viewer gets back is a
  // dark ring — a bright speck in the raw render arrives on screen as a dirt
  // speck. Where a neighbour is far brighter than this pixel, we are standing in
  // that ring, so the injection is switched off.
  float ymax4 = max(max(luma(n), luma(s)), max(luma(w), luma(e))) * uExposure;
  hf *= 1.0 - 0.9 * smoothstep(1.8, 5.0, ymax4 / max(yc, 1e-3));

  // Soft limiter, scaled by the local level, and deliberately asymmetric: adding
  // light to micro-relief is free, but digging a hole next to a highlight is
  // exactly the artefact above, so the negative side gets a third of the room.
  float knee = uDetailLimit * (ym + 0.08) * (hf < 0.0 ? 0.35 : 1.0);
  hf = hf / (1.0 + abs(hf) / max(knee, 1e-4));

  // Flat regions (sky) have no residual, so they gain nothing and cannot band;
  // snow micro-relief and branch edges get theirs back at full amplitude.
  gl_FragColor = vec4(max(res + hf * uDetail, vec3(0.0)), 1.0);
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
      uClipRelax: { value: PARAMS.taa.clipRelax },
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
      uniforms: {
        tDiffuse: { value: null },
        tCurrent: { value: source },
        uTexel: this.uniforms.uTexel,
        uDetail: { value: PARAMS.taa.detail },
        uDetailLimit: { value: PARAMS.taa.detailLimit },
        uExposure: { value: PARAMS.grade.exposure },
      },
      vertexShader: VERT,
      fragmentShader: TAA_OUT_FRAG,
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
    this.uniforms.uClipRelax.value = PARAMS.taa.clipRelax;
    this.uniforms.uSharpen.value = PARAMS.taa.sharpen;
    this.uniforms.uExposure.value = PARAMS.grade.exposure;

    this.fsq.material = this.material;
    renderer.setRenderTarget(dst);
    this.fsq.render(renderer);

    this.copyMaterial.uniforms.tDiffuse.value = dst.texture;
    this.copyMaterial.uniforms.tCurrent.value = this.source;
    this.copyMaterial.uniforms.uDetail.value = PARAMS.taa.detail;
    this.copyMaterial.uniforms.uDetailLimit.value = PARAMS.taa.detailLimit;
    this.copyMaterial.uniforms.uExposure.value = PARAMS.grade.exposure;
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
// Bloom high pass, replacing three's LuminosityHighPassShader.
//
// The stock one is `mix(black, texel, smoothstep(thr, thr + 0.01, luma))`: a
// hard gate that passes the ENTIRE texel value the instant it crosses the line.
// A single snow sparkle at 12x white therefore injects 12 units into the bloom
// pyramid, and after the widest mips smear it around you get a soft orb bigger
// than the skier's head. Two changes:
//
//   1. clamp the input to `uClamp` units first, so no lone pixel can dominate;
//   2. a soft knee that passes the energy ABOVE the threshold rather than the
//      whole value, so contribution ramps from zero instead of stepping.
//
// The sun disc sits thousands of units over the line and is unaffected by both.
// -----------------------------------------------------------------------------
const BLOOM_HIGHPASS_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float luminosityThreshold;
uniform float smoothWidth;
uniform float uClamp;
${COMMON}
void main() {
  vec3 c = max(texture2D(tDiffuse, vUv).rgb, vec3(0.0));

  // Firefly ceiling, applied on the channel max so it never shifts hue.
  float m = max(max(c.r, c.g), c.b);
  c *= m > uClamp ? uClamp / m : 1.0;

  float v = luma(c);
  float thr = luminosityThreshold;
  float knee = max(smoothWidth, 1e-3);

  // Soft-knee high pass: quadratic through the knee, then a straight
  // (v - thr) above it. Returns the *excess* over the threshold.
  float soft = clamp(v - thr + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, v - thr) / max(v, 1e-4);

  gl_FragColor = vec4(c * clamp(contrib, 0.0, 1.0), 1.0);
}
`;

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
uniform float uNearRange;
uniform float uFarStrength;
uniform vec2  uFarBand;     // x = start metres, y = end metres
uniform float uMaxCoC;      // pixels
${COMMON}
${DEPTH_GLSL}

const int TAPS = 20;
const float GOLDEN = 2.39996323;

float cocAt(vec2 uv) {
  float z = linearDepth(texture2D(tDepth, uv).x, uNearFar.x, uNearFar.y);
  if (z >= uFocus) {
    // DEEP FOCUS. A thin-lens far CoC saturates within ~3x the focus distance,
    // which turns an entire mountain range into brushed metal — the single most
    // expensive detail in the frame destroyed by the cheapest effect in it.
    // Instead the far ramp does not even begin until uFarBand.x metres and
    // tops out at a fraction of a pixel, so peaks read as *aerial haze soft*,
    // never as out of focus. The ramp is log-spaced so it matches how
    // atmospheric extinction actually falls off with distance.
    float a = log2(max(z, uFarBand.x) / uFarBand.x);
    float b = log2(uFarBand.y / uFarBand.x);
    float t = smoothstep(0.0, 1.0, a / max(b, 1e-3));
    return t * uFarStrength;
  }
  // Near field carries what little defocus there is: only geometry inside
  // uNearRange of the focus plane — spray, a ski tip, a passing gate.
  float t = clamp((uFocus - z) / max(uFocus * uNearRange, 1e-3), 0.0, 1.0);
  return -t * t * uNearStrength;
}

void main() {
  float cocC = cocAt(vUv);
  float rPix = abs(cocC) * uMaxCoC;

  if (rPix < 0.75) {
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
// Motion blur — TRUE per-pixel velocity.
//
// Every pixel is unprojected with its own depth and reprojected through a
// virtual camera sitting one shutter-open back along the real camera path. The
// resulting screen-space displacement is therefore parallax-correct: the snow a
// metre under the lens sweeps, a tree at 40 m barely moves, and a peak at 3 km
// is mathematically pinned. That is the whole difference between camera blur
// and the radial zoom smear that ruins so many racing games — a radial streak
// keyed off a global speed scalar blurs the *distant* image hardest, which is
// exactly backwards, and is why there is no such term here.
//
// The displacement is then clamped in PIXELS, not uv, so it cannot exceed a few
// pixels at any resolution, and the whole pass is gated off below ~55 km/h.
// -----------------------------------------------------------------------------
const MB_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4  uReproject;
uniform vec2  uNearFar;
uniform vec2  uTexel;
uniform float uStrength;
uniform float uMaxPixels;
uniform float uNearFade;
uniform vec3  uSubject;        // xy = screen uv of the skier, z = its distance
uniform vec2  uSubjectShape;   // x = screen radius, y = protection amount
${COMMON}
${DEPTH_GLSL}

const int SAMPLES = 9;

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

  vel *= uStrength;

  // Clamp in pixels. uMaxPixels is the *total* streak length, so the half
  // sweep either side of the pixel is half that.
  vec2 velPix = vel / uTexel;
  float lenPix = length(velPix);
  if (lenPix > uMaxPixels) vel *= uMaxPixels / lenPix;

  // Under a pixel of travel there is nothing to integrate — bail before paying
  // for nine taps. At walking pace this is every pixel in the frame.
  if (lenPix < 1.0) { gl_FragColor = vec4(base, 1.0); return; }

  float jitter = hash12(gl_FragCoord.xy) - 0.5;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    float t = (float(i) + 0.5 + jitter) / float(SAMPLES) - 0.5;
    vec2 uv2 = clamp(vUv - vel * t, vec2(0.001), vec2(0.999));
    float w = 1.0 - abs(t) * 0.6;          // slight centre bias
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
uniform float uContrast, uPivot, uSaturation, uHighDesat, uSCurve;
uniform vec2  uHighNeutral;   // log-luma window over which the split tone → 1.0
uniform vec2  uShadeHue;      // x = magenta-guard amount, y = luma the guard fades out at
uniform vec2  uSplitWindow;   // log-luma crossover from shadowTint to highTint
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

  lg = (lg - uPivot) * uContrast + uPivot;            // straight log gain
  lg = pow(max(lg * uGain + uLift, vec3(0.0)), uGamma); // ASC-CDL

  // Gentle S. uContrast above is a straight slope change and it drags the
  // shoulder and the toe around with it; this adds the actual *S* — a little
  // extra slope through the mid-tones whose effect decays to nothing at both
  // ends. Snow highlights and rock shadows therefore keep every code they had
  // while the mid-tones (the modelling on the slope, the folds in the jacket)
  // gain bite. Driven off luminance so it never shifts hue.
  float sd = dot(lg, vec3(0.3333)) - uPivot;
  lg = max(lg + uSCurve * sd * exp(-sd * sd * 11.0), vec3(0.0));
  // --- split tone, with a HIGHLIGHT NEUTRAL rolloff --------------------------
  // A two-point warm-highlight / cool-shadow split is the standard look and on
  // most scenes it works. On snow it does not, and this grade fell into the
  // trap: on an alpine frame the *subject* lives in the highlights, so "warm the
  // highlights" means "make all the snow beige". Measured, direct-sun snow was
  // landing at 254,247,237 — B−R of −17, a cream no reference has. The same
  // measurement on an alpine photograph gives B−R +10, and on Steep's own
  // screenshots −5 to +1: neutral, within a few codes either way.
  //
  // So the tint now ramps UP through the mid-tones — rock faces, lit conifers,
  // the jacket, where warmth reads as sunlight — and then ramps back OUT to
  // unity above uHighNeutral.x, which is exactly where snow sits. That is also
  // what film does at the shoulder: the dye layers saturate together and the
  // curve converges on neutral. The split-tone amplitudes are untouched; it is
  // the *window* that was wrong.
  float lv = dot(lg, vec3(0.3333));
  float w = smoothstep(uSplitWindow.x, uSplitWindow.y, lv);
  float neu = smoothstep(uHighNeutral.x, uHighNeutral.y, lv);
  lg *= mix(mix(uShadowTint, uHighTint, w), vec3(1.0), neu);
  // --- cool-end magenta guard ----------------------------------------------
  // Sky-lit snow shade must read blue-CYAN. Measured by hue angle, ours sat at
  // 226 deg — violet — against 209 deg for Steep's shaded snow and 210-215 for
  // alpine photographs. The green channel was sitting well under the R→B line,
  // which is the definition of a magenta cast. This lifts G back toward that
  // line, and only ever lifts it: it cannot invent a green cast, it does nothing
  // to anything that is not blue-dominant (so sunlit snow, rock and the jacket
  // are untouched), and it fades out in the highlights. Most of the violet comes
  // from the ambient term upstream, so this is deliberately a partial pull —
  // enough to move the hue a third of the way to reference without flattening
  // whatever the lighting pass does next.
  float bDom = clamp((lg.b - lg.r) / 0.05, 0.0, 1.0);
  float lowEnd = 1.0 - smoothstep(uHighNeutral.x, uHighNeutral.y, lv);
  lg.g += max((lg.r + lg.b) * 0.5 - lg.g, 0.0) * uShadeHue.x * bDom * lowEnd;

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

  // Output dither. This is the last stop before an 8-bit framebuffer and the
  // sky is a 3000 m smooth gradient — without ±half a code of triangular noise
  // it lays down visible contour rings, and the grain above is deliberately too
  // fine and too shadow-weighted to hide them up in the highlights.
  float t1 = hash12(gl_FragCoord.xy + vec2(uTime * 17.3, uTime * 11.9));
  float t2 = hash12(gl_FragCoord.yx - vec2(uTime * 13.1, uTime * 19.7));
  c += (t1 + t2 - 1.0) / 255.0;

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

  // Swap in the clamped soft-knee high pass (see BLOOM_HIGHPASS_FRAG).
  bloomPass.highPassUniforms.uClamp = { value: PARAMS.bloom.clamp };
  bloomPass.materialHighPassFilter.uniforms = bloomPass.highPassUniforms;
  bloomPass.materialHighPassFilter.fragmentShader = BLOOM_HIGHPASS_FRAG;
  bloomPass.materialHighPassFilter.needsUpdate = true;

  // Author the pyramid explicitly. UnrealBloomPass's `radius` is a mirror-lerp
  // over a fixed [1, .8, .6, .4, .2] ramp, and even at radius 0.30 it leaves the
  // 1/32-res mip weighted 0.44 — that mip IS the orb. `radius` is pinned to 0 so
  // lerpBloomFactor() is the identity and these weights are what actually ships.
  // The array is only assigned in UnrealBloomPass's constructor, never in
  // render(), so overwriting it here sticks.
  const bloomFactors = bloomPass.compositeMaterial.uniforms.bloomFactors.value;
  const applyMipWeights = () => {
    for (let i = 0; i < bloomFactors.length; i++) {
      bloomFactors[i] = PARAMS.bloom.mipWeights[i] ?? 0;
    }
  };
  applyMipWeights();

  const dofPass = new ShaderPass(new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: depthTexture },
      uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
      uNearFar: { value: new THREE.Vector2(camera.near, camera.far) },
      uFocus: { value: PARAMS.dof.focus },
      uNearStrength: { value: PARAMS.dof.nearStrength },
      uNearRange: { value: PARAMS.dof.nearRange },
      uFarStrength: { value: PARAMS.dof.farStrength },
      uFarBand: { value: new THREE.Vector2(PARAMS.dof.farStart, PARAMS.dof.farEnd) },
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
      uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
      uStrength: { value: 0 },
      uMaxPixels: { value: PARAMS.motion.maxPixels },
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
      uSCurve: { value: g.sCurve },
      uPivot: { value: g.pivot },
      uSaturation: { value: g.saturation },
      uHighDesat: { value: g.highlightDesat },
      uHighNeutral: { value: new THREE.Vector2(...g.highNeutral) },
      uShadeHue: { value: new THREE.Vector2(g.shadeHue, 0) },
      uSplitWindow: { value: new THREE.Vector2(...g.splitWindow) },
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
  smaaPass.enabled = PARAMS.smaa.enabled || !PARAMS.taa.enabled;
  composer.addPass(smaaPass);
  composer.addPass(filmPass);

  // --- per-frame scratch -----------------------------------------------------
  const projU = new THREE.Matrix4();
  const projJ = new THREE.Matrix4();
  const viewU = new THREE.Matrix4();
  const currVP = new THREE.Matrix4();
  const currVPInv = new THREE.Matrix4();
  const prevVP = new THREE.Matrix4();
  const virtWorld = new THREE.Matrix4();
  const virtView = new THREE.Matrix4();
  const camVel = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  const camScale = new THREE.Vector3(1, 1, 1);
  const prevQuat = new THREE.Quaternion();
  const shutterQuat = new THREE.Quaternion();
  const virtPos = new THREE.Vector3();
  const subjWorld = new THREE.Vector3(0, 0, 0);
  const subj = new THREE.Vector3();
  let subjDist = 9;
  let jitterIndex = 0;
  let havePrev = false;
  let haveQuat = false;
  let time = 0;
  let lastDt = 1 / 60;

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
      mbPass.uniforms.uTexel.value.set(1 / W, 1 / H);
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
      // The motion-blur gate. A skier pushing off at 14 km/h has, to a camera,
      // no motion blur whatsoever, so `mb` is flatly zero until 55 km/h and only
      // reaches full weight at 108 km/h. `sp` (the gentler ramp) drives the
      // speed vignette, which is a peripheral-vision cue rather than an optical
      // one and may start much earlier.
      const m = PARAMS.motion;
      const mb = THREE.MathUtils.clamp(
        (state.speed - m.speedLo) / Math.max(m.speedHi - m.speedLo, 1e-3), 0, 1);
      const sp = THREE.MathUtils.clamp((state.speed - 6) / 30, 0, 1);
      const gf = THREE.MathUtils.clamp(state.gForce / 2.5, 0, 1);
      const wantMB = mb * mb * m.strength;              // quadratic — soft entry
      const wantVig = (sp * sp * 0.8 + gf * 0.2) * PARAMS.film.speedVignetteMax;
      const kk = 1 - Math.exp(-6 * d);
      mbAmount += (wantMB - mbAmount) * kk;
      speedVig += (wantVig - speedVig) * kk;

      camVel.copy(state.vel);
      subjWorld.set(state.pos.x, state.pos.y + 1.0, state.pos.z);
      subjDist = target;
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

      // --- render the scene with a sub-pixel jitter -------------------------
      const useTAA = PARAMS.taa.enabled;
      taaPass.enabled = useTAA;
      blitPass.enabled = !useTAA;

      projJ.copy(projU);
      if (useTAA) {
        const j = JITTER[jitterIndex % JITTER.length];
        jitterIndex++;
        camera.projectionMatrix.elements[8] += (j[0] * 2) / W;
        camera.projectionMatrix.elements[9] += (j[1] * 2) / H;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        projJ.copy(camera.projectionMatrix);
      }

      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);

      if (useTAA) {
        camera.projectionMatrix.copy(projU);
        camera.projectionMatrixInverse.copy(projU).invert();
      }

      // --- reprojection ------------------------------------------------------
      // JITTER COMPENSATION. The depth buffer we are about to unproject was
      // rendered through the JITTERED projection, so the inverse used to recover
      // a world position must be the jittered one too. It used to be the clean
      // one, which meant every reprojection carried a half-pixel error — and on a
      // slope seen at a grazing angle a half pixel of screen error is metres of
      // error along the view ray. The history then landed on the wrong surface
      // point, the neighbourhood clamp threw it away, and the resolve fell back
      // on a blurred current frame. That was a third of the missing detail.
      //
      // The *target* space stays unjittered: the history buffer is anchored at
      // texel centres, not at this frame's sample position.
      currVPInv.multiplyMatrices(projJ, viewU).invert();

      if (!havePrev) prevVP.copy(currVP);
      taaPass.uniforms.uReproject.value.multiplyMatrices(prevVP, currVPInv);

      // --- motion blur: a virtual camera one shutter back along the path -----
      // Translation comes from the sim velocity (so this is correct even in a
      // paused still, where there is no frame-to-frame camera delta at all) and
      // rotation from the real orientation delta scaled to the shutter, which is
      // what makes a hard carve sweep the frame. Everything else — how far each
      // individual pixel actually travels — falls out of the depth buffer.
      camera.matrixWorld.decompose(camPos, camQuat, camScale);
      if (!haveQuat) { prevQuat.copy(camQuat); haveQuat = true; }

      const shutter = PARAMS.motion.shutter;
      const f = THREE.MathUtils.clamp(shutter / Math.max(lastDt, 1e-4), 0, 1);
      shutterQuat.copy(camQuat).slerp(prevQuat, f);
      virtPos.copy(camPos).addScaledVector(camVel, -shutter);
      virtWorld.compose(virtPos, shutterQuat, camScale);
      virtView.copy(virtWorld).invert();

      // Both ends use the *jittered* projection so the jitter cancels exactly and
      // a stationary camera produces a velocity of precisely zero.
      mbPass.uniforms.uReproject.value
        .multiplyMatrices(projJ, virtView)     // virtual previous viewProj
        .multiply(currVPInv);
      mbPass.uniforms.uStrength.value = mbAmount;
      mbPass.uniforms.uMaxPixels.value = PARAMS.motion.maxPixels * cocScale;
      mbPass.uniforms.uNearFade.value = PARAMS.motion.nearFade;
      mbPass.enabled = PARAMS.motion.enabled && mbAmount > 0.004;

      prevQuat.copy(camQuat);
      lastDt = dt > 1e-4 ? Math.min(dt, 0.1) : lastDt;

      subj.copy(subjWorld).project(camera);
      mbPass.uniforms.uSubject.value.set(subj.x * 0.5 + 0.5, subj.y * 0.5 + 0.5, subjDist);
      mbPass.uniforms.uSubjectShape.value.set(PARAMS.motion.subjectRadius, PARAMS.motion.subjectProtect);

      // --- per-frame uniforms ------------------------------------------------
      dofPass.enabled = PARAMS.dof.enabled;
      dofPass.uniforms.uFocus.value = focus;
      dofPass.uniforms.uNearStrength.value = PARAMS.dof.nearStrength;
      dofPass.uniforms.uNearRange.value = PARAMS.dof.nearRange;
      dofPass.uniforms.uFarStrength.value = PARAMS.dof.farStrength;
      dofPass.uniforms.uFarBand.value.set(PARAMS.dof.farStart, PARAMS.dof.farEnd);
      dofPass.uniforms.uNearFar.value.set(camera.near, camera.far);
      mbPass.uniforms.uNearFar.value.set(camera.near, camera.far);

      // TAA is the anti-aliaser; SMAA only comes back if TAA is switched off.
      smaaPass.enabled = PARAMS.smaa.enabled || !PARAMS.taa.enabled;
      bloomPass.enabled = PARAMS.bloom.enabled;
      bloomPass.strength = PARAMS.bloom.strength;
      bloomPass.radius = PARAMS.bloom.radius;
      bloomPass.threshold = PARAMS.bloom.threshold;
      bloomPass.highPassUniforms.smoothWidth.value = PARAMS.bloom.knee;
      bloomPass.highPassUniforms.uClamp.value = PARAMS.bloom.clamp;
      applyMipWeights();

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
      gu.uSCurve.value = gp.sCurve;
      gu.uPivot.value = gp.pivot;
      gu.uSaturation.value = gp.saturation;
      gu.uHighDesat.value = gp.highlightDesat;
      gu.uHighNeutral.value.fromArray(gp.highNeutral);
      gu.uShadeHue.value.set(gp.shadeHue, 0);
      gu.uSplitWindow.value.fromArray(gp.splitWindow);
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
