import * as THREE from 'three';

/**
 * Snow spray.
 *
 * One pooled, GPU-simulated particle system (instanced billboards, a single draw
 * call) covering four physically distinct kinds of airborne snow:
 *
 *   ROOSTER   continuous curtain thrown off the edged ski through a carve
 *   PLUME     explosive powder burst on landings and hockey stops
 *   CRYSTAL   fine ice dust kicked up at speed, twinkling in the sun
 *   DRIFT     heavy low-lying powder that settles and lingers in the track
 *
 * Nothing is stepped on the CPU. Each particle's entire trajectory is a closed
 * form of its birth record - ballistic motion under exponential air drag, plus
 * terminal wind drift, plus growing curl-ish turbulence - evaluated in the
 * vertex shader. The CPU only writes birth records into a ring buffer and
 * uploads the dirty slice. No allocation per frame, no per-particle CPU work.
 *
 * Shading treats each sprite as a small sphere of snow: wrapped diffuse from the
 * scene's sun, Henyey-Greenstein forward scattering so backlit spray glows and
 * blooms, sky ambient on the shadow side, thickness-driven self-shadowing, and a
 * soft fade against the plane of the snow surface the particle was born on so
 * sprites never cut a hard line into the slope.
 */

const MAX_PARTICLES = 34000;
const MAX_SPAWN_PER_FRAME = 1400;

// Deterministic RNG so captures are reproducible frame for frame.
let _rng = 0x9e3779b9;
function rnd() {
  _rng = (_rng * 1664525 + 1013904223) >>> 0;
  return _rng / 4294967296;
}
const rndc = () => rnd() * 2 - 1;
const clamp = THREE.MathUtils.clamp;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
// Procedural sprite atlas: 2x2 soft snow puffs with eroded, noisy silhouettes.
// G = fine crystal glints, B = internal optical thickness, A = density.
// ---------------------------------------------------------------------------
function makeSprayAtlas(tile = 128) {
  const N = tile * 2;
  const data = new Uint8Array(N * N * 4);

  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const s = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
    perm[i] = ((s - Math.floor(s)) * 255) | 0;
  }
  const h2 = (x, y) => perm[(perm[x & 255] + (y & 255)) & 255] / 255;
  const vn = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  const fbm = (x, y, oct) => {
    let s = 0, a = 0.5, f = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += a * vn(x * f, y * f); n += a; f *= 2.03; a *= 0.55; }
    return s / n;
  };

  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      const ox = tx * 137.3 + 11.7, oy = ty * 91.1 + 5.3;
      const lumpiness = 0.20 + 0.09 * (tx + 2 * ty);
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const u = (x + 0.5) / tile * 2 - 1;
          const v = (y + 0.5) / tile * 2 - 1;
          let r = Math.sqrt(u * u + v * v);

          // Warp the radius with low-frequency noise -> irregular, clumpy puff.
          r += (fbm(ox + u * 2.2, oy + v * 2.2, 4) - 0.5) * lumpiness;

          // Soft core, feathered edge; gaussian so it never shows a hard rim.
          let d = Math.exp(-r * r * 4.0) * smoothstep(1.02, 0.34, r);

          // Internal structure: granular clumps.
          d *= 0.30 + 1.22 * fbm(ox * 2 + u * 6.5, oy * 2 + v * 6.5, 5);

          const fine = fbm(ox * 3 + u * 27.0, oy * 3 + v * 27.0, 3);
          const glint = Math.pow(clamp((fine - 0.60) / 0.40, 0, 1), 2.0);

          // Optically deep in the middle -> self-shadow there.
          const thick = clamp(1.0 - Math.exp(-r * r * 2.2) * 0.95, 0, 1);

          d = clamp(d, 0, 1);
          const i = ((ty * tile + y) * N + (tx * tile + x)) * 4;
          data[i] = 255;
          data[i + 1] = (glint * 255) | 0;
          data[i + 2] = (thick * 255) | 0;
          data[i + 3] = (d * 255) | 0;
        }
      }
    }
  }

  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------------------

const VERT = /* glsl */`
precision highp float;

attribute vec3 aP0;   // birth position (world)
attribute vec3 aV0;   // birth velocity (world)
attribute vec4 aA;    // birthTime, life, size, sizeGrow
attribute vec4 aB;    // seed, drag, turbulence, alpha
attribute vec4 aC;    // birth-surface plane: normal.xyz, d
attribute vec4 aD;    // stretch, sparkle, brightness, gravityScale

uniform float uTime;
uniform vec3  uWind;
uniform vec3  uSunDirWorld;
uniform float uFadeNear;
uniform float uPixelScale;   // drawing-buffer height / 2, in pixels

varying vec2  vLocal;
varying vec2  vUv;
varying vec3  vViewPos;
varying float vAlpha;
varying float vSeed;
varying float vSparkle;
varying float vBright;
varying float vRise;
varying float vShade;

// Smooth 3D lobe field. Sampled at *birth* position so it advects with the
// puff instead of being a static lattice the plume slides through.
float lobeField(vec3 q) {
  vec3 lp = q * 1.15;
  float v = sin(lp.x) * sin(lp.y * 1.13 + 1.7) * sin(lp.z * 0.92 + 3.1)
          + 0.55 * sin(lp.x * 2.7 + 2.2) * sin(lp.y * 2.3) * sin(lp.z * 2.9 + 1.1)
          // A third octave at ~1.5 m. Real spray is filamentary at that scale —
          // wisps and streaks, not one smooth mass — and two octaves at 5 m and
          // 2.5 m only ever produce a soft blob.
          + 0.34 * sin(lp.x * 6.1 + 0.7) * sin(lp.y * 5.3 + 4.2) * sin(lp.z * 6.9)
          // A fourth octave at ~0.6 m. The carve curtain is only two metres
          // long, so the three octaves above (5 m, 2.5 m, 1.5 m) barely vary
          // across it and every sprite in it drew the same lobe value - which is
          // exactly how a plume this compact ends up as one smooth grey mass
          // instead of the streaky, clumped thing a photograph shows.
          + 0.22 * sin(lp.x * 14.3 + 2.4) * sin(lp.y * 12.7 + 0.9) * sin(lp.z * 15.1 + 5.5);
  return clamp(v * 0.475 * 0.5 + 0.5, 0.0, 1.0);
}

void main() {
  float age  = uTime - aA.x;
  float life = aA.y;

  if (age < 0.0 || age >= life) {           // dead slot: clip the whole quad
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vLocal = vec2(0.0); vUv = vec2(0.0); vViewPos = vec3(0.0, 0.0, -1.0);
    vAlpha = 0.0; vSeed = 0.0; vSparkle = 0.0; vBright = 0.0; vRise = 0.0;
    vShade = 1.0;
    return;
  }

  float t    = age;
  float u    = t / life;
  float k    = aB.y;                        // drag coefficient
  float seed = aB.x;

  // v(t) = (v0 - vinf) e^-kt + vinf,  vinf = g/k + wind
  vec3  vinf = vec3(0.0, -9.81 * aD.w, 0.0) / k + uWind;
  float e    = exp(-k * t);
  vec3  p    = aP0 + (aV0 - vinf) * (1.0 - e) / k + vinf * t;
  vec3  vel  = (aV0 - vinf) * e + vinf;

  // Curl-ish turbulence, growing with age.
  float s = seed * 61.7;
  vec3  q = p * 0.22;
  vec3  turb = vec3(
    sin(t * 1.13 + s + q.z) + 0.55 * sin(t * 2.7 + s * 1.7 - q.y),
    sin(t * 0.81 + s * 1.7 + q.x) * 0.55 + 0.30,
    cos(t * 1.31 + s * 0.6 + q.y) + 0.55 * cos(t * 2.3 + s * 2.1 + q.x)
  );
  p   += turb * aB.z * t;
  vel += turb * aB.z * 0.6;

  // Soft floor: the surface the particle was born on. Powder settles on it
  // instead of sinking through, which is what sells "settled".
  float above = dot(aC.xyz, p) - aC.w;
  p -= aC.xyz * min(above - 0.02, 0.0) * 0.94;
  above = max(dot(aC.xyz, p) - aC.w, 0.0);

  float size  = aA.z * (1.0 + aA.w * t);
  // Fade-in on absolute age, not on a fraction of life. As a fraction it scaled
  // with lifetime, so the short-lived snow at the edge - which is exactly the
  // dense root of the curtain - spent its first 100 ms at a third of its alpha
  // and the plume appeared to start a metre behind the ski. Snow does not fade
  // up as it leaves an edge; 25 ms is only there to stop a spawn popping.
  float fin   = smoothstep(0.0, 0.025, t);
  // The tail of the plume is the *old* snow, forty metres behind the skier. A
  // hard fade-out (this used to be fout squared from 46% of life) deletes it and
  // leaves a compact puff stuck to the boot; real spray hangs and thins.
  float fout  = 1.0 - smoothstep(0.55, 1.0, u);
  float alpha = aB.w * fin * fout * mix(1.0, fout, 0.55);

  // Neighbouring particles share a lobe value, so overlapping sprites reinforce
  // instead of averaging out - this is what gives the plume internal form
  // rather than a uniform cotton-wool mass.
  float lobe = lobeField(aP0);
  alpha *= 0.45 + 1.55 * lobe * lobe;

  // Approximate volumetric self-shadow: if the field is dense one step towards
  // the sun, this particle is buried in the plume's own shade.
  float occ = lobeField(aP0 + uSunDirWorld * 1.35);
  vShade = mix(1.0, 0.44, occ);

  // Sub-pixel guard. A 1 cm ice crystal at 8 m is a fifth of a pixel wide, but a
  // quad cannot be smaller than a pixel: the rasteriser rounds it up to a full
  // one at full opacity, and the result is a field of hard white dots scattered
  // over the snow that reads as dirt on the lens. Grow anything under the floor
  // to the floor and take the coverage it should have had out of its alpha.
  //
  // The floor is 2.0 px, not 1.75: a quad narrower than about two pixels cannot
  // resolve its own soft edge, so its premultiplied fringe lands on a single
  // pixel and — for the dark ground-shadow blobs especially — reads as a hollow
  // dark ring rather than as a puff. And below ~55% of the floor the sprite is
  // covering a fifth of a pixel; dimming it is not enough, because the eye finds
  // an isolated 2-code speck on flat snow perfectly well. Those are deleted
  // instead (alpha -> 0, and the fragment shader's dens cutoff then discards
  // them), which costs nothing visually: at that size the particle contributed
  // less light than the dither.
  {
    float viewZ = max(-(modelViewMatrix * vec4(p, 1.0)).z, 0.02);
    float px = size * projectionMatrix[1][1] * uPixelScale / viewZ;
    const float MIN_PX = 2.0;
    if (px < MIN_PX) {
      float k = max(px / MIN_PX, 0.02);
      size  /= k;
      alpha *= k * k * smoothstep(0.30, 0.58, k);
    }
  }

  // aD.y < 0 flags a ground-aligned decal: -1 low drifting snow, -2 cast shadow.
  // Lying them flat on the snow is what stops a vertical billboard from diving
  // through the surface and being sliced off with a hard line.
  float isGroundQuad = step(aD.y, -0.5);
  vec4 mv;

  if (isGroundQuad > 0.5) {
    vec3 T = normalize(cross(aC.xyz, vec3(0.0, 0.0, 1.0)));
    vec3 B = cross(aC.xyz, T);
    float lift = aD.y < -1.5 ? 0.12 : 0.05;
    mv = modelViewMatrix *
         vec4(p + aC.xyz * lift + (T * position.x + B * position.y) * size * 1.9, 1.0);
  } else {
    // --- billboard, stretched along screen-space velocity -------------------
    mv = modelViewMatrix * vec4(p, 1.0);
    vec3 vv = (viewMatrix * vec4(vel, 0.0)).xyz;

    vec2  dir = vv.xy;
    float dl  = length(dir);
    vec2  vax = dl > 1e-3 ? dir / dl : vec2(1.0, 0.0);
    float rot = seed * 6.283 + t * (seed - 0.5) * 1.6;
    vec2  rax = vec2(cos(rot), sin(rot));
    vec2  ax  = normalize(mix(rax, vax, clamp(aD.x * 14.0, 0.0, 1.0)));
    vec2  ay  = vec2(-ax.y, ax.x);

    float stretch = 1.0 + min(dl * aD.x, 2.2);
    vec2 off = (ax * position.x * stretch + ay * position.y) * size;
    mv.xy += off;

    // Soft-particle fade against the snow. A billboard is a vertical card, so
    // its lower half dives under the surface and the depth test slices it off
    // with a hard line. Rotate this corner's offset back into world space and
    // measure its own height above the birth plane, so the fade is per-fragment
    // and exact for a plane instead of per-sprite.
    above = dot(aC.xyz, p + vec3(off, 0.0) * mat3(viewMatrix)) - aC.w;
  }

  // Near-camera fade: never let one sprite swallow the frame.
  alpha *= smoothstep(uFadeNear * 0.3, uFadeNear, -mv.z);

  if (isGroundQuad > 0.5) above = 9.0;   // ground decals must not fade themselves
  // Soft-particle fade against the birth plane, sized to the sprite instead of
  // fixed.
  //
  // The band used to be a constant smoothstep(-0.06, 0.17): a corner had to be
  // 17 cm clear of the snow to reach full alpha. Snow leaving an edge is *at*
  // the snow - the root of a rooster tail sits in the top 5 cm - so every
  // particle in the root came out at 20-50% alpha and the plume detached from
  // the ski. That gap is the classic particle-system tell and the gate named it.
  //
  // What the band is actually for is hiding the hard line where a vertical
  // billboard crosses the surface, and that only needs to happen over a distance
  // comparable to the sprite's own radius. So it scales with size and is
  // anchored *below* the surface: a small sprite sitting on the snow is fully
  // opaque, and only the part that has gone under fades out.
  float sBand = clamp(size * 0.62, 0.045, 0.34);
  alpha *= smoothstep(-sBand * 1.7, sBand * 0.34, above);

  vLocal   = position.xy * 2.0;
  vUv      = uv * 0.5 + vec2(step(0.5, fract(seed * 4.0)) * 0.5,
                             step(0.5, fract(seed * 8.0)) * 0.5);
  vViewPos = mv.xyz;
  vAlpha   = alpha;
  vSeed    = seed;
  vSparkle = aD.y;
  vBright  = aD.z * (0.78 + 0.34 * lobe);
  vRise    = max(above, 0.0);

  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D uTex;
uniform vec3  uSunDirView;    // view-space direction *towards* the sun
uniform vec3  uSunColor;
uniform vec3  uAmbient;
uniform vec3  uGroundBounce;
uniform vec3  uShadowColor;
uniform float uScatter;
uniform float uTime;

varying vec2  vLocal;
varying vec2  vUv;
varying vec3  vViewPos;
varying float vAlpha;
varying float vSeed;
varying float vSparkle;
varying float vBright;
varying float vRise;
varying float vShade;

void main() {
  vec4  tex  = texture2D(uTex, vUv);
  float dens = tex.a * vAlpha;
  if (dens < 0.0035) discard;

  // Ground-projected shadow blobs: just darken what is behind them.
  if (vSparkle < -1.5) {
    gl_FragColor = vec4(uShadowColor * dens, dens);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }

  // Treat the billboard as a little sphere of snow.
  float r2 = dot(vLocal, vLocal);
  vec3  n  = vec3(vLocal, sqrt(max(0.0, 1.0 - min(r2, 1.0))));

  vec3 L = uSunDirView;
  vec3 V = normalize(-vViewPos);

  // Wrapped diffuse: snow is translucent, light bleeds past the terminator,
  // but keep real contrast between the lit and the shadowed side.
  float wrap = clamp(dot(n, L) * 0.42 + 0.58, 0.0, 1.0);
  wrap *= wrap;

  // Henyey-Greenstein forward scattering, normalised to peak at 1.
  float ct = dot(V, -L);
  const float g  = 0.76;
  const float hgN = ((1.0 - g) * (1.0 - g) * (1.0 - g)) / (1.0 - g * g);
  float hg = hgN * (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * ct, 1e-4), 1.5);

  float thin = 1.0 - dens;                  // thin fringes scatter far more

  // Self-shadowing. Only a gentle cooling of the optically deep core (a strong
  // one turns every sprite into a soap bubble), plus a real vertical gradient:
  // snow low in the plume sits in the shadow of the snow above it.
  float ao = mix(0.88, 1.0, tex.b);

  // ---- what value does spray actually sit at, on a white slope? -------------
  //
  // Measured on front-lit reference photography of a hard GS carve (Hinterstoder
  // / Trysil, bluebird, sun over the shoulder):
  //
  //     clean sunlit piste beside the skier   mean 230   sd 17
  //     body of the curtain                   mean 200   sd 27   (-13%)
  //     dense root at the edge                mean 194   sd 43   max 255
  //
  // So the body of a curtain is NOT brighter than the snow. It is about an
  // eighth *darker*, with half again the local variance and occasional grains
  // that clip. That is the physics: the pack is a 0.9-albedo multiple-scattering
  // half-space, and a thin cloud of ice crystals hung in front of it can only
  // scatter a fraction of what it hides. What makes spray read is texture and
  // the fact that it takes bright snow *down*, not a glow.
  //
  // The previous tuning aimed the other way - "20-35% above the piste" - which
  // is a backlit rule applied to a front-lit shot, and it landed the curtain
  // within 2% of the snow behind it. 2% is invisible: measured, spray on vs
  // spray off over the ski changed the region mean by 3.2 codes out of 178.
  //
  // The one thing that IS brighter than the pack is the dense root: an optically
  // thick sheet in direct sun with the piste bouncing into it, plus specular
  // glints off crystal facets. So brightness now tracks *density* rather than
  // height, which also puts the light where the eye needs it to weld the plume
  // to the ski.
  float vs = mix(0.70, 1.06, clamp(vRise * 0.62, 0.0, 1.0));
  // Optical density of this fragment, 0 at the wispy fringe, 1 in the core.
  float thick = clamp(dens * 1.6, 0.0, 1.0);

  // Self-shadowing only applies where the plume is optically thick. A thin
  // fringe has nothing above it to shade it, so it stays white; shading it like
  // the core is what turns the tail of the plume grey and makes it read as
  // smoke instead of as suspended snow.
  float shd = mix(1.0, vShade, clamp(dens * 1.8, 0.0, 1.0));

  vec3 col = uAmbient * ao * (0.62 + 0.38 * n.z);
  col += uSunColor * wrap * ao * vs * shd;
  // Multiple scattering inside a dense cloud of ice: even the shadow side of
  // snow spray is nowhere near black. Weighted by optical depth - a single
  // crystal has nothing to multiply-scatter with.
  col += uSunColor * (0.16 + 0.30 * thick) * ao * mix(0.55, 1.0, vs) * mix(0.70, 1.0, shd);
  col += uGroundBounce * (0.5 - 0.5 * n.y);
  col *= vBright;

  // Additive forward scatter. Keyed on density, not on thinness: the old
  // thin*thin weighting put the glow on exactly the wispy tail that a photograph
  // shows as translucent grey, and starved the dense root that a photograph
  // shows blowing out to 255.
  col += uSunColor * hg * uScatter * (0.20 + 0.80 * thick) * vs;

  // Opposition surge. Ice crystals retro-reflect hard, and where the snow is
  // piled thickest that surge is what takes the root above the piste it came
  // off. Density-weighted for the same reason as the term above.
  float bs = max(dot(V, L), 0.0);
  col += uSunColor * (0.30 * bs * bs + 0.26 * pow(bs, 6.0)) * ao * vs * shd
         * (0.25 + 0.95 * thick);

  // Individual ice crystals catching the light.
  float tw = sin(uTime * 26.0 + vSeed * 137.0) * 0.5 + 0.5;
  col += uSunColor * max(vSparkle, 0.0) * pow(tw, 6.0) * tex.g * (0.30 + 1.1 * max(ct, 0.0));

  gl_FragColor = vec4(col * dens, dens);    // premultiplied alpha

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------

export function createSpray(scene) {
  const N = MAX_PARTICLES;

  const geo = new THREE.InstancedBufferGeometry();
  geo.instanceCount = N;
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  geo.setIndex(quad.index);
  quad.dispose();

  const bufP0 = new Float32Array(N * 3);
  const bufV0 = new Float32Array(N * 3);
  const bufA = new Float32Array(N * 4);
  const bufB = new Float32Array(N * 4);
  const bufC = new Float32Array(N * 4);
  const bufD = new Float32Array(N * 4);

  // Every slot starts dead (birth far in the past, zero life).
  for (let i = 0; i < N; i++) {
    bufA[i * 4] = -1e6; bufA[i * 4 + 1] = 0.0001;
    bufB[i * 4 + 1] = 1; bufC[i * 4 + 1] = 1;
  }

  const attrs = {
    aP0: new THREE.InstancedBufferAttribute(bufP0, 3),
    aV0: new THREE.InstancedBufferAttribute(bufV0, 3),
    aA: new THREE.InstancedBufferAttribute(bufA, 4),
    aB: new THREE.InstancedBufferAttribute(bufB, 4),
    aC: new THREE.InstancedBufferAttribute(bufC, 4),
    aD: new THREE.InstancedBufferAttribute(bufD, 4),
  };
  const attrList = [];
  for (const k in attrs) {
    attrs[k].setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(k, attrs[k]);
    attrList.push(attrs[k]);
  }

  const tex = makeSprayAtlas(128);

  const uniforms = {
    uTime: { value: 0 },
    uTex: { value: tex },
    uWind: { value: new THREE.Vector3(1.2, 0, 0.6) },
    uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
    uSunDirWorld: { value: new THREE.Vector3(-0.5, 0.72, 0.45).normalize() },
    uShadowColor: { value: new THREE.Color(0.31, 0.34, 0.41) },
    uSunColor: { value: new THREE.Color(1.34, 1.28, 1.19) },
    uAmbient: { value: new THREE.Color(0.16, 0.22, 0.32) },
    uGroundBounce: { value: new THREE.Color(0.13, 0.15, 0.19) },
    uScatter: { value: 0.85 },
    uPixelScale: { value: 450 },
    uFadeNear: { value: 1.7 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = 'snow-spray';
  scene.add(mesh);

  // --- ring buffer bookkeeping ---------------------------------------------
  let cursor = 0;
  let dirtyLo = Infinity, dirtyHi = -1, wrapped = false;
  let time = 0;
  let spawnedThisFrame = 0;

  /** Write one particle birth record. */
  function emit(px, py, pz, vx, vy, vz, life, size, sizeGrow, drag, turb, alpha,
                gx, gy, gz, gd, stretch, sparkle, bright, gravity) {
    const i = cursor;
    cursor = cursor + 1;
    if (cursor >= N) { cursor = 0; wrapped = true; }
    if (i < dirtyLo) dirtyLo = i;
    if (i > dirtyHi) dirtyHi = i;

    const i3 = i * 3, i4 = i * 4;
    bufP0[i3] = px; bufP0[i3 + 1] = py; bufP0[i3 + 2] = pz;
    bufV0[i3] = vx; bufV0[i3 + 1] = vy; bufV0[i3 + 2] = vz;
    bufA[i4] = time; bufA[i4 + 1] = life; bufA[i4 + 2] = size; bufA[i4 + 3] = sizeGrow;
    bufB[i4] = rnd(); bufB[i4 + 1] = drag; bufB[i4 + 2] = turb; bufB[i4 + 3] = alpha;
    bufC[i4] = gx; bufC[i4 + 1] = gy; bufC[i4 + 2] = gz; bufC[i4 + 3] = gd;
    bufD[i4] = stretch; bufD[i4 + 1] = sparkle; bufD[i4 + 2] = bright; bufD[i4 + 3] = gravity;
    spawnedThisFrame++;
  }

  // --- scratch (never allocate per frame) ----------------------------------
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const velDir = new THREE.Vector3();
  const gN = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();
  const sunWorld = new THREE.Vector3(-0.5, 0.72, 0.45).normalize();
  const drawSize = new THREE.Vector2(1600, 900);

  const WHITE = new THREE.Color(1, 1, 1);
  let sun = null, sunSearch = 0;
  const acc = { root: 0, rooster: 0, sheet: 0, veil: 0, crystal: 0, air: 0 };
  let prevAirborne = false, prevSpeed = 0, prevVy = 0;
  let landCooldown = 0, stopCooldown = 0;

  mesh.onBeforeRender = (renderer, sc, camera) => {
    if (sun) {
      tmp.copy(sun.position);
      if (sun.target) tmp.sub(sun.target.position);
      if (tmp.lengthSq() > 1e-6) sunWorld.copy(tmp).normalize();
      // Pulled halfway to neutral. Snow spray is a cloud of clear ice: it
      // scatters almost achromatically, so it does not take the warm cast the
      // sun puts on a diffuse surface, and letting it do so is what made the
      // plume read as cream-coloured dust rather than as snow.
      uniforms.uSunColor.value
        .setRGB(sun.color.r, sun.color.g, sun.color.b)
        .lerp(WHITE, 0.5)
        .multiplyScalar(0.355 * Math.max(sun.intensity, 0.05));
    }
    renderer.getDrawingBufferSize(drawSize);
    uniforms.uPixelScale.value = drawSize.y * 0.5;
    uniforms.uSunDirWorld.value.copy(sunWorld);
    uniforms.uSunDirView.value.copy(sunWorld)
      .transformDirection(camera.matrixWorldInverse).normalize();
  };

  function findLights() {
    let best = null, hemi = null;
    scene.traverse((o) => {
      if (o.isDirectionalLight && (!best || o.intensity > best.intensity)) best = o;
      else if (o.isHemisphereLight && !hemi) hemi = o;
    });
    if (best) sun = best;
    if (hemi) {
      // Desaturate a touch - fully saturated sky blue makes the spray read as
      // smoke rather than snow.
      uniforms.uAmbient.value.copy(hemi.color).lerp(WHITE, 0.55)
        .multiplyScalar(0.32 * hemi.intensity);
      uniforms.uGroundBounce.value.copy(hemi.groundColor).multiplyScalar(0.12 * hemi.intensity);
    }
  }

  // --- the plume's own shadow, cast on the snow ----------------------------
  // A flat, ground-aligned dark blob at the sun-projection of a spray particle.
  // Projection along a direction onto a plane is affine, so the projected
  // particle follows the same closed-form trajectory with a projected velocity.
  let curGroundD = 0, sunDotN = 1;
  function emitShadowBlob(px, py, pz, vx, vy, vz, life, size, alpha) {
    if (sunDotN < 0.15) return;
    const tq = (gN.x * px + gN.y * py + gN.z * pz - curGroundD) / sunDotN;
    const tv = (gN.x * vx + gN.y * vy + gN.z * vz) / sunDotN;
    emit(
      px - sunWorld.x * tq, py - sunWorld.y * tq, pz - sunWorld.z * tq,
      vx - sunWorld.x * tv, vy - sunWorld.y * tv, vz - sunWorld.z * tv,
      life, size, 0.85, 2.4, 0.0, alpha,
      gN.x, gN.y, gN.z, curGroundD,
      0.0, -2.0, 1.0, 0.0                     // -2 flags "cast shadow decal"
    );
  }

  /** Explosive powder burst (landings, hockey stops, external triggers). */
  function burst(count, cx, cy, cz, spread, power, upBias, sizeScale, dirX, dirZ, gd) {
    const n = Math.min(count, 2600);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.pow(rnd(), 0.55);
      const ox = Math.cos(a) * rr, oz = Math.sin(a) * rr;
      const sp = power * (0.30 + 0.95 * rnd());
      const px = cx + ox * spread + dirX * rr * spread * 0.7;
      const py = cy + rnd() * 0.30 + 0.05;
      const pz = cz + oz * spread + dirZ * rr * spread * 0.7;
      const vx = ox * sp * 0.85 + dirX * power * 0.8 * rnd() + rndc() * 0.7;
      const vy = (0.55 + rnd() * 1.35) * power * upBias;
      const vz = oz * sp * 0.85 + dirZ * power * 0.8 * rnd() + rndc() * 0.7;
      const life = 1.5 + rnd() * 2.1;
      const size = (0.19 + rnd() * rnd() * 0.68) * sizeScale;
      emit(
        px, py, pz, vx, vy, vz,
        life, size,
        0.85,                                     // grow
        1.25 + rnd() * 0.6,                       // drag
        0.45 + rnd() * 0.60,                      // turbulence
        0.16 + rnd() * rnd() * 0.42,              // alpha
        gN.x, gN.y, gN.z, gd,
        0.016, 0.10, 0.94 + rnd() * 0.40, 0.30
      );
      if ((i & 7) === 0) {
        curGroundD = gd;
        emitShadowBlob(px, py, pz, vx * 0.6, vy * 0.6, vz * 0.6,
                       life * 0.9, size * 1.5, 0.10 + rnd() * 0.10);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-emitter rate multipliers. Ship at 1; a probe can zero one out to see
  // exactly which band is putting light where, which is the only way to tell a
  // curtain at the ski from a cloud forty metres behind it.
  const gain = { root: 1, rooster: 1, sheet: 1, veil: 1, crystal: 1, air: 1 };

  const api = {
    mesh,
    material: mat,
    gain,
    liveCount: 0,

    /**
     * Dev probe. Replays the vertex shader's closed-form trajectory on the CPU
     * for every live slot and reports where the snow actually *is*, in metres
     * behind the skier, weighted by the alpha each sprite will be drawn with.
     * "A curtain at the ski" and "a cloud thirty metres back" look identical in
     * a particle count and completely different here.
     */
    nearStats(camera, state) {
      const buckets = [0, 0, 0, 0, 0];   // <2m, 2-5, 5-12, 12-30, >30
      let live = 0, nearCamFaded = 0, totalW = 0, wSum = 0;
      const sx = state.pos.x, sy = state.pos.y, sz = state.pos.z;
      const cx = camera ? camera.position.x : sx;
      const cy = camera ? camera.position.y : sy;
      const cz = camera ? camera.position.z : sz;
      const fadeNear = uniforms.uFadeNear.value;
      for (let i = 0; i < N; i++) {
        const i4 = i * 4, i3 = i * 3;
        const t = time - bufA[i4], life = bufA[i4 + 1];
        if (!(t >= 0 && t < life)) continue;
        live++;
        const k = bufB[i4 + 1], grav = bufD[i4 + 3];
        const e = Math.exp(-k * t);
        const wx = uniforms.uWind.value;
        const vinfY = (-9.81 * grav) / k + wx.y;
        const px = bufP0[i3] + (bufV0[i3] - wx.x) * (1 - e) / k + wx.x * t;
        const py = bufP0[i3 + 1] + (bufV0[i3 + 1] - vinfY) * (1 - e) / k + vinfY * t;
        const pz = bufP0[i3 + 2] + (bufV0[i3 + 2] - wx.z) * (1 - e) / k + wx.z * t;
        const u = t / life;
        const fout = 1 - smoothstep(0.55, 1.0, u);
        const w = bufB[i4 + 3] * smoothstep(0, 0.025, t) * fout * (1 - 0.55 + 0.55 * fout);
        const d = Math.hypot(px - sx, py - sy, pz - sz);
        buckets[d < 2 ? 0 : d < 5 ? 1 : d < 12 ? 2 : d < 30 ? 3 : 4] += w;
        totalW += w;
        wSum += w * d;
        const dc = Math.hypot(px - cx, py - cy, pz - cz);
        if (dc < fadeNear) nearCamFaded += w;
      }
      const pct = (v) => +(100 * v / Math.max(totalW, 1e-6)).toFixed(1);
      return {
        live,
        alphaMassPct: { d0_2: pct(buckets[0]), d2_5: pct(buckets[1]), d5_12: pct(buckets[2]),
                        d12_30: pct(buckets[3]), d30plus: pct(buckets[4]) },
        meanDistM: +(wSum / Math.max(totalW, 1e-6)).toFixed(2),
        camFadedPct: pct(nearCamFaded),
        camDistM: +Math.hypot(cx - sx, cy - sy, cz - sz).toFixed(2),
      };
    },

    /** Hook for other systems (impacts, collisions) to throw a powder burst. */
    puff(x, y, z, strength = 1) {
      gN.set(0, 1, 0);
      burst(Math.round(260 * strength), x, y, z,
            0.5 + strength * 0.6, 2.2 + strength * 3.2, 1.0, 1.0, 0, 0, y);
    },

    update(dt, state) {
      if (!(dt > 0)) dt = 1 / 60;
      time += dt;
      uniforms.uTime.value = time;
      spawnedThisFrame = 0;

      if (--sunSearch <= 0) { sunSearch = 45; findLights(); }

      const p = state.pos;
      const spd = state.speed || 0;
      const edge = state.edge || 0;
      const gf = state.gForce || 0;

      gN.copy(state.groundNormal || tmp.set(0, 1, 0));
      if (gN.lengthSq() < 0.5) gN.set(0, 1, 0);
      gN.normalize();
      const groundD = gN.dot(p);
      curGroundD = groundD;
      sunDotN = gN.dot(sunWorld);

      fwd.set(Math.sin(state.heading), 0, Math.cos(state.heading));
      fwd.addScaledVector(gN, -fwd.dot(gN));            // lay the basis in the slope
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
      fwd.normalize();
      right.crossVectors(fwd, gN).normalize().negate();  // skier's right
      up.copy(gN);

      if (spd > 0.2) velDir.copy(state.vel).normalize(); else velDir.copy(fwd);

      // --- how hard is the edge working? ------------------------------------
      const edgeAbs = Math.min(Math.abs(edge), 1);
      const slip = clamp(velDir.dot(right), -1, 1);      // sideways drift
      const slipAbs = Math.abs(slip);
      const brake = (state.input && state.input.brake) || 0;
      const speedF = smoothstep(2.0, 15.0, spd);

      const carveLoad = edgeAbs * (0.30 + 0.70 * edgeAbs);
      const skidLoad = clamp(slipAbs * 2.2 + brake * 0.9, 0, 1.3);
      const load = clamp((carveLoad * 0.75 + skidLoad * 0.55) * speedF *
                         (0.70 + 0.20 * Math.min(gf, 2.5)), 0, 1.3);

      // How far over is the ski? state.edge is phi / 60 degrees, so 0.83 is 50
      // degrees. Everything about a carve changes character over the last third
      // of that range: below ~25 degrees the base is doing the work and the ski
      // barely displaces snow, and above ~50 the edge is ploughing a trench and
      // throwing its heaviest curtain. The old spray had no term for this at
      // all - it was driven by `load`, which is nearly saturated by 35 degrees -
      // so the money shot looked exactly like a lazy traverse.
      const edgeBoost = smoothstep(0.42, 0.92, edgeAbs);

      // Which way does the snow fly? Outside of the arc, plus the skid vector.
      let lat = edge * 0.8 + slip * 1.8;
      if (Math.abs(lat) < 0.04) lat = edge >= 0 ? 0.04 : -0.04;
      const sgn = Math.sign(lat);

      const airborne = !!state.airborne;
      landCooldown -= dt; stopCooldown -= dt;

      // ---------------------------------------------------------------------
      // 1. ROOSTER TAIL - the continuous curtain off the edged ski
      // ---------------------------------------------------------------------
      if (!airborne && load > 0.012) {
        // -------------------------------------------------------------------
        // 1a. THE ROOT. A separate, very short-lived band emitted along the
        // running edge itself.
        //
        // This is the piece the whole effect was missing. Everything else here
        // is snow that has already left the ski and is being abandoned at 15 m/s;
        // by the time it is 30 cm clear of the edge the skier is a metre past it
        // and there is nothing left connecting the two. What a photograph of a
        // carve actually shows is a bright dense wedge *welded* to the edge, a
        // hand's width tall, shearing back and dissolving over about half a
        // metre. So: emitted at the contact point, carrying nearly the ski's own
        // velocity so it stays with it, dense, and dead inside a third of a
        // second so it never smears down the slope.
        // -------------------------------------------------------------------
        acc.root += (4200 + 9000 * edgeBoost) * load * gain.root * dt;
        let nr = Math.min(acc.root | 0, MAX_SPAWN_PER_FRAME - spawnedThisFrame);
        acc.root -= nr;
        const rootOut = 0.85 + 2.1 * load + 1.5 * edgeBoost;
        for (; nr > 0; nr--) {
          // The whole running length of the edge, tip to tail.
          const alongT = -0.95 + 1.75 * rnd();
          const lateral = sgn * (0.15 + rnd() * 0.13);
          const rise = rnd();
          const px = p.x + fwd.x * alongT + right.x * lateral;
          const py = p.y + fwd.y * alongT + right.y * lateral + 0.012 + rise * rise * 0.12;
          const pz = p.z + fwd.z * alongT + right.z * lateral;
          // ~85% of the ski's speed: the wedge travels with the ski for the
          // fraction of a second it exists, which is what welds it to the edge.
          const keep = spd * (0.72 + 0.22 * rnd());
          const outK = rootOut * (0.45 + 0.9 * rnd());
          const upK = (0.35 + 1.5 * rise) * (0.6 + 1.5 * load);
          emit(
            px, py, pz,
            right.x * sgn * outK + up.x * upK + velDir.x * keep + rndc() * 0.5,
            right.y * sgn * outK + up.y * upK + velDir.y * keep + rndc() * 0.3,
            right.z * sgn * outK + up.z * upK + velDir.z * keep + rndc() * 0.5,
            0.15 + rnd() * 0.26,                               // life
            0.062 + rnd() * rnd() * 0.24 + 0.09 * load,        // size
            1.35,                                              // grow: it shears
            2.1 + rnd() * 1.4,                                 // drag
            0.10 + rnd() * 0.14,                               // turbulence
            0.95 + rnd() * 0.50,                               // dense
            gN.x, gN.y, gN.z, groundD,
            0.30 + 0.18 * rnd(),                               // streaks back
            0.30,
            1.14 + rnd() * 0.30,                               // bright
            0.45
          );
        }

        // Rate roughly doubled against the halved lifetime below: same live
        // population, but concentrated into the first few metres behind the ski
        // instead of trailed over fifteen.
        acc.rooster += (8600 + 9500 * edgeBoost) * load * gain.rooster * dt;
        let n = Math.min(acc.rooster | 0, MAX_SPAWN_PER_FRAME - spawnedThisFrame);
        acc.rooster -= n;

        // A World Cup GS turn throws the curtain 2-4 m out and head high. The
        // numbers below are sized against that, not against a puff of dust.
        // Sized against the reference: on hard piste a GS curtain is a wedge
        // roughly two and a half metres long and half a metre tall that hugs the
        // snow. The old numbers were written for a powder mushroom - 5 m/s of
        // outward and 5 m/s of upward throw, which with this drag builds a plume
        // nearly two metres tall and three wide, and since the chase camera sits
        // less than five metres away that filled a third of the frame with fog.
        const vOut = 0.70 + 1.55 * load + 0.024 * spd + 1.05 * edgeBoost;
        const vUp = 0.85 + 1.55 * load + 0.022 * spd + 0.85 * edgeBoost;
        // Snow leaves a moving ski with most of the ski's forward momentum and
        // then decelerates hard. That retained momentum plus high drag is what
        // lays the plume down as a long wall behind the skier instead of
        // blooming it into a mushroom beside him.
        const carry = spd * 0.62;

        for (; n > 0; n--) {
          // Along the running edge. Pulled forward from the old -2.3..0.4 m: the
          // curtain is generated *at* the edge and then left behind by the
          // skier, so seeding it two metres back as well only doubles up on snow
          // that is already there and starves the part that is still attached.
          const alongT = -1.55 + 2.05 * Math.pow(rnd(), 0.7);
          // The sheet peels off the edge and widens as it leaves the ski.
          const peel = rnd();
          const lateral = sgn * (0.14 + peel * peel * (0.28 + 0.62 * load + 0.34 * edgeBoost))
                        + rndc() * 0.05;
          const px = p.x + fwd.x * alongT + right.x * lateral;
          const py = p.y + fwd.y * alongT + right.y * lateral
                   + 0.03 + peel * (0.16 + 0.7 * load);
          const pz = p.z + fwd.z * alongT + right.z * lateral;

          // Fan the curtain: mostly outward, some straight up, some low sheet.
          const fan = rnd();
          const outK = vOut * (0.45 + 1.15 * fan) * (0.75 + 0.5 * rnd());
          const upK = vUp * (1.20 - 0.80 * fan) * (0.6 + 0.8 * rnd());
          // Snow nearest the edge has barely been separated from the ski yet, so
          // it keeps more of its speed; snow at the outside of the fan has been
          // thrown and is already being left behind. Making `carry` fall off with
          // `peel` is what shears the curtain back into a wall instead of
          // translating the whole plume at one speed.
          const backK = carry * (0.55 + 0.7 * rnd()) + spd * 0.30 * (1.0 - peel);
          const big = rnd();
          const vx = right.x * sgn * outK + up.x * upK + velDir.x * backK + rndc() * 0.85;
          const vy = right.y * sgn * outK + up.y * upK + velDir.y * backK + rndc() * 0.50;
          const vz = right.z * sgn * outK + up.z * upK + velDir.z * backK + rndc() * 0.85;
          // Short-lived and heavily damped. A rooster tail is a *compact* body
          // of snow travelling with the skier; long lives and low drag smear the
          // same particle budget over forty metres of slope, which measured as
          // 66% of the frame touched and none of it reading as anything.
          //
          // At 15 m/s a one-second life is a fifteen-metre trail, and the probe
          // measured half of the plume's alpha mass sitting 5-12 m back: a wall
          // of fog off to the side of the frame with nothing at the ski. Real
          // spray at this speed is a two-metre plume, because it disperses below
          // the visible threshold in a fraction of a second. So the life is
          // halved and the rate doubled - same cost, and the snow is where a
          // photograph puts it.
          const life = 0.17 + rnd() * 0.27 + load * 0.16;
          // Snow leaves the edge as chunks and clods, not as dust: the size
          // distribution has to have a long tail or the curtain is a grey haze.
          const size = 0.070 + big * big * 0.34 + load * 0.10;

          if ((n & 3) === 0) {
            emitShadowBlob(px + vx * 0.22, py + vy * 0.22, pz + vz * 0.22,
                           vx * 0.55, vy * 0.55, vz * 0.55,
                           life * 1.05, size * 1.9 + 0.16, 0.115 + rnd() * 0.15);
          }

          emit(
            px, py, pz, vx, vy, vz,
            life, size,
            0.40 + rnd() * 0.35,                               // grow
            3.4 + rnd() * 1.9,                                 // drag
            0.22 + rnd() * 0.30,                               // turbulence
            0.90 + rnd() * rnd() * 0.80,                       // alpha
            gN.x, gN.y, gN.z, groundD,
            0.26 + 0.16 * rnd(),                               // motion stretch
            0.10,
            1.06 + rnd() * 0.42,                               // brightness
            0.55
          );

          // Clods. A carving edge does not only make dust: it peels lumps of
          // packed snow that fly nearly ballistically, out ahead of the soft
          // body of the curtain. They are what give a rooster tail its grain and
          // its leading edge - without them the plume is cotton wool.
          if ((n & 7) === 0 || (edgeBoost > 0.45 && (n & 3) === 0)) {
            const cs = 1.45 + rnd() * 0.7;
            emit(
              px, py, pz, vx * cs, vy * cs * 0.85, vz * cs,
              0.34 + rnd() * 0.45,
              0.030 + rnd() * rnd() * 0.090,
              0.25,                                            // barely grows
              0.55 + rnd() * 0.55,                             // low drag
              0.06,
              0.50 + rnd() * 0.28,                             // dense but not a disc
              gN.x, gN.y, gN.z, groundD,
              0.20 + 0.14 * rnd(),                             // streaks
              0.55,
              1.10 + rnd() * 0.30,
              0.95                                             // full gravity
            );
          }
        }

        // ------ low sheet that stays glued to the surface -------------------
        acc.sheet += 190 * load * gain.sheet * dt;
        let ns = Math.min(acc.sheet | 0, MAX_SPAWN_PER_FRAME - spawnedThisFrame);
        acc.sheet -= ns;
        for (; ns > 0; ns--) {
          const alongT = -1.2 - rnd() * 2.6;
          const lateral = sgn * (0.10 + rnd() * 1.3) + rndc() * 0.25;
          emit(
            p.x + fwd.x * alongT + right.x * lateral,
            p.y + fwd.y * alongT + right.y * lateral + 0.06,
            p.z + fwd.z * alongT + right.z * lateral,
            right.x * sgn * (0.5 + rnd()) + velDir.x * spd * 0.10 + rndc() * 0.4,
            0.35 + rnd() * 0.75,
            right.z * sgn * (0.5 + rnd()) + velDir.z * spd * 0.10 + rndc() * 0.4,
            // Lifetime halved, and growth with it. At 2.2-4.6 s and 0.55/s of
            // growth these ground decals reached seven metres across and were
            // still at full alpha sixty metres back, where a hundred of them
            // stacked along the view ray into an opaque wall that hid a fence
            // and a treeline. Measured: that region was +32 luma codes with
            // spray on versus off, while the snow at the ski was +3. Every bit
            // of the effect's light was landing in the one place a photograph
            // has nothing - which is precisely the "detached fog puff" read.
            0.62 + rnd() * 0.75,
            0.50 + rnd() * 1.1, 0.34,
            3.0 + rnd(), 0.24 + rnd() * 0.26,
            0.016 + rnd() * 0.024,                             // sheer
            gN.x, gN.y, gN.z, groundD,
            0.0, -1.0, 1.02, 0.16
          );
        }
      }

      // ---------------------------------------------------------------------
      // 2. RUNNING VEIL - the loose snow a ski lifts simply by going fast.
      //
      // This is the term that was missing, and it is the one that makes a
      // straight schuss read as 56 km/h instead of as a slow pan: even with the
      // skis flat, a groomed piste sheds a continuous, sheer curtain of snow
      // dust off the tails that hangs and drifts for a couple of seconds. It is
      // deliberately very low alpha and large - many overlapping sheer sprites,
      // not a few opaque ones, is what keeps it looking like suspended snow
      // rather than like smoke.
      // ---------------------------------------------------------------------
      // Through a committed carve the veil is throttled back and pushed to the
      // outside of the arc. It is a straight-running effect: on a big edge angle
      // it was adding a low-alpha grey wash across the whole chase view - over
      // the skier's own legs, over the trench, over the curtain - which is
      // precisely the "detached fog puff" read. The curtain terms above own that
      // snow now, and they place it where a photograph puts it.
      if (!airborne && spd > 4.5) {
        acc.veil += (220 + 820 * speedF) * (0.45 + 0.55 * Math.min(load, 1)) *
                    (1.0 - 0.78 * edgeBoost) * gain.veil * dt;
        let n = Math.min(acc.veil | 0, MAX_SPAWN_PER_FRAME - spawnedThisFrame);
        acc.veil -= n;
        for (; n > 0; n--) {
          // Behind the tails, in a low cone. Kept spatially tight: the temporal
          // AA in the post chain averages away anything thin and dispersed, so a
          // veil that is spread thinly over the whole slope measures as nothing.
          // Well behind the tails and low: in a chase view anything emitted at
          // the boot sits between the camera and the skier and fogs his legs.
          const alongT = -1.25 - rnd() * 2.4;
          const lateral = rndc() * (0.28 + 0.45 * load)
                        + sgn * (load * 0.28 + edgeBoost * 0.55) * rnd();
          const rise = rnd();
          emit(
            p.x + fwd.x * alongT + right.x * lateral,
            p.y + fwd.y * alongT + right.y * lateral + 0.02 + rise * rise * 0.42,
            p.z + fwd.z * alongT + right.z * lateral,
            velDir.x * spd * 0.10 + rndc() * 0.8 + right.x * sgn * load * 1.4,
            0.45 + rnd() * 1.2 + load * 1.1,
            velDir.z * spd * 0.10 + rndc() * 0.8 + right.z * sgn * load * 1.4,
            0.32 + rnd() * 0.42,
            0.13 + rnd() * rnd() * 0.34,                       // large and soft
            0.44,                                              // keeps expanding
            2.4 + rnd() * 1.1,
            0.24 + rnd() * 0.28,
            0.042 + rnd() * rnd() * 0.095,                     // sheer
            gN.x, gN.y, gN.z, groundD,
            0.10, 0.25, 1.02, 0.20
          );
        }
      }

      // ---------------------------------------------------------------------
      // 3. ICE CRYSTALS - individual grains flicked off the edge, catching the
      //    sun. Small and bright: these are the sparkle, not the volume.
      // ---------------------------------------------------------------------
      if (!airborne && spd > 5) {
        acc.crystal += (90 + 420 * speedF * (0.25 + 0.75 * load)) * gain.crystal * dt;
        let n = Math.min(acc.crystal | 0, MAX_SPAWN_PER_FRAME - spawnedThisFrame);
        acc.crystal -= n;
        for (; n > 0; n--) {
          const alongT = -0.4 - rnd() * 1.8;
          const lateral = rndc() * (0.30 + 0.9 * load);
          emit(
            p.x + fwd.x * alongT + right.x * lateral,
            p.y + fwd.y * alongT + right.y * lateral + 0.05 + rnd() * 0.65,
            p.z + fwd.z * alongT + right.z * lateral,
            velDir.x * spd * 0.16 + rndc() * 1.5 + right.x * sgn * load * 1.8,
            0.5 + rnd() * 2.0,
            velDir.z * spd * 0.16 + rndc() * 1.5 + right.z * sgn * load * 1.8,
            0.55 + rnd() * 0.85,
            0.009 + rnd() * 0.018, 0.22,
            1.1 + rnd() * 0.7, 0.34 + rnd() * 0.4,
            0.10 + rnd() * 0.17,
            gN.x, gN.y, gN.z, groundD,
            0.12, 1.0, 1.12, 0.13
          );
        }
      }

      // ---------------------------------------------------------------------
      // 4. AIRBORNE trail - snow still shedding off the skis in flight
      // ---------------------------------------------------------------------
      if (airborne && spd > 4) {
        acc.air += 70 * speedF * gain.air * dt;
        let n = Math.min(acc.air | 0, MAX_SPAWN_PER_FRAME - spawnedThisFrame);
        acc.air -= n;
        for (; n > 0; n--) {
          emit(
            p.x + rndc() * 0.5, p.y + 0.10 + rnd() * 0.35, p.z + rndc() * 0.5,
            velDir.x * spd * 0.10 + rndc() * 0.8, rnd() * 0.6,
            velDir.z * spd * 0.10 + rndc() * 0.8,
            1.1 + rnd() * 1.1, 0.05 + rnd() * 0.13, 0.9,
            1.2 + rnd(), 0.40, 0.14 + rnd() * 0.12,
            gN.x, gN.y, gN.z, groundD - 400,        // no floor while in the air
            0.04, 0.5, 1.1, 0.20
          );
        }
      }

      // ---------------------------------------------------------------------
      // 5. LANDING PLUME
      // ---------------------------------------------------------------------
      if (prevAirborne && !airborne && landCooldown <= 0) {
        const impact = clamp(Math.abs(prevVy) / 12 + spd / 45, 0.18, 1.7);
        landCooldown = 0.22;
        burst(Math.round(420 + 1250 * impact), p.x, p.y, p.z,
              0.55 + 1.6 * impact, 2.2 + 6.5 * impact, 1.0,
              0.9 + 0.5 * impact, velDir.x * 0.55, velDir.z * 0.55, groundD);
      }

      // ---------------------------------------------------------------------
      // 6. HOCKEY STOP - hard deceleration on a big edge angle
      // ---------------------------------------------------------------------
      const decel = (prevSpeed - spd) / dt;
      const stopping = !airborne && spd > 3.5 &&
        (decel > 9 || (brake > 0.5 && spd > 6)) &&
        (edgeAbs > 0.3 || slipAbs > 0.35 || brake > 0.5);
      if (stopping && stopCooldown <= 0) {
        stopCooldown = 0.12;
        const power = clamp(spd / 12, 0.3, 1.6);
        burst(Math.round(280 + 700 * power),
              p.x - fwd.x * 0.4 + right.x * sgn * 0.35, p.y,
              p.z - fwd.z * 0.4 + right.z * sgn * 0.35,
              0.5 + 1.0 * power, 3.0 + 5.2 * power, 0.85, 0.85,
              right.x * sgn + velDir.x * 0.4, right.z * sgn + velDir.z * 0.4, groundD);
      }

      prevAirborne = airborne;
      prevSpeed = spd;
      prevVy = state.vel ? state.vel.y : 0;

      // --- upload only the slice we touched ---------------------------------
      if (dirtyHi >= 0) {
        for (let i = 0; i < attrList.length; i++) {
          const a = attrList[i];
          a.clearUpdateRanges();
          if (wrapped) {
            a.addUpdateRange(0, a.count * a.itemSize);
          } else {
            a.addUpdateRange(dirtyLo * a.itemSize, (dirtyHi - dirtyLo + 1) * a.itemSize);
          }
          a.needsUpdate = true;
        }
        dirtyLo = Infinity; dirtyHi = -1; wrapped = false;
      }
    },

    dispose() {
      scene.remove(mesh);
      geo.dispose(); mat.dispose(); tex.dispose();
    },
  };

  // Dev-only introspection hook used by tools/fx-shoot.mjs. Never shipped.
  if (import.meta.env && import.meta.env.DEV && typeof window !== 'undefined') {
    const hook = (window.__fx = window.__fx || {});
    hook.spray = api;
    hook.scene = scene;
    const prevOBR = mesh.onBeforeRender;
    mesh.onBeforeRender = (renderer, sc, camera, ...rest) => {
      hook.camera = camera;
      hook.renderer = renderer;
      prevOBR(renderer, sc, camera, ...rest);
      if ((hook._n = ((hook._n | 0) + 1) % 20) === 0) {
        let live = 0;
        for (let i = 0; i < N; i++) {
          const a = time - bufA[i * 4];
          if (a >= 0 && a < bufA[i * 4 + 1]) live++;
        }
        api.liveCount = live;
      }
    };
  }

  return api;
}
