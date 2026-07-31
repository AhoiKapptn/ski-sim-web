import * as THREE from 'three';

/**
 * Renderer + scene + camera bootstrap.
 * Owns nothing game-specific; subsystems attach to `scene`.
 *
 * ---------------------------------------------------------------------------
 * WHY `antialias: false`
 * ---------------------------------------------------------------------------
 * The scene is never drawn to the default framebuffer. `postfx.render()` draws
 * it into `sceneRT` (a HalfFloat render target) and the only thing that ever
 * touches the drawing buffer is the final fullscreen film-pass quad — two
 * triangles with no interior edges, which MSAA cannot improve. With
 * `antialias: true` the browser still allocates a multisampled default
 * framebuffer and resolves it on every present: at DPR 2 (3200x1800) that is a
 * 4x-sampled RGBA8 resolve of 5.76 Mpx per frame, bought for nothing. Spatial
 * AA is done inside the post chain (TAA, and SMAA when TAA is off — see
 * `postfx.js`, `smaaPass.enabled = PARAMS.smaa.enabled || !PARAMS.taa.enabled`).
 *
 * The one path that *would* lose from this is `postfx.js:1280`, which falls back
 * to `renderer.render(scene, camera)` straight to the default framebuffer when
 * `postfx.enabled === false`. Nothing in `src/` or `tools/` sets that flag; it
 * exists as a debug ablation ("render with every post pass off"). `main.js`
 * detects that fallback and warns once, so the loss can never be silent, and
 * `?aa=1` brings the multisampled backbuffer back for anyone who needs it.
 *
 * ---------------------------------------------------------------------------
 * RESOLUTION SCALE
 * ---------------------------------------------------------------------------
 * `setPixelRatio(min(devicePixelRatio, maxPixelRatio) * resolutionScale)`.
 * Every post-processing render target is sized from
 * `renderer.getDrawingBufferSize()` (postfx.js:1039) or from
 * `renderer.getPixelRatio()` (`postfx.setSize`), so this one number scales the
 * whole fragment cost of the frame — on a Retina display the default is DPR 2,
 * i.e. 5.76 Mpx, 4x the 1.44 Mpx that headless Chrome measures at DPR 1.
 * `resolutionScale = 0.75` renders 2400x1350 and lets the film pass' sharpen
 * (postfx.js:1183) carry the perceived resolution.
 *
 * Defaults are unchanged (aa off is the only behavioural change; scale is 1).
 * Override per-session with query params — no rebuild needed:
 *
 *     ?aa=1          multisampled default framebuffer (debug ablations)
 *     ?rscale=0.75   render at 75% linear resolution
 *     ?maxdpr=1      clamp device pixel ratio (what headless Chrome sees)
 *
 * or at runtime via `window.__harness.gfx`.
 */
export function createEngine(container, opts = {}) {
  const qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const num = (key, fallback) => {
    const v = qs.get(key);
    const n = v === null ? NaN : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };

  // MSAA on the default framebuffer: off by default, see the note above.
  const antialias = qs.get('aa') === '1' ? true : qs.get('aa') === '0' ? false : (opts.antialias ?? false);

  const renderer = new THREE.WebGLRenderer({
    antialias,
    powerPreference: 'high-performance',
    stencil: false,
    logarithmicDepthBuffer: false,
  });

  let maxPixelRatio = num('maxdpr', opts.maxPixelRatio ?? 2);
  let resolutionScale = num('rscale', opts.resolutionScale ?? 1);
  let explicitPixelRatio = null;   // set by gfx.setPixelRatio(), overrides both

  const resizeHooks = [];
  const pixelRatio = () => (explicitPixelRatio !== null
    ? explicitPixelRatio
    : Math.max(0.25, Math.min(devicePixelRatio, maxPixelRatio) * resolutionScale));

  /**
   * Re-applies pixel ratio + backbuffer size and notifies anything that sized
   * itself from the drawing buffer (postfx). Call after changing either knob.
   */
  function applyResolution() {
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(innerWidth, innerHeight);
    const w = innerWidth, h = innerHeight;
    for (const fn of resizeHooks) fn(w, h);
  }

  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.15, 12000);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    applyResolution();
  });

  /**
   * Resolution / backbuffer control. Exposed as `window.__harness.gfx` so
   * `tools/perf-ab.mjs` can A/B it inside one page session.
   */
  const gfx = {
    /** True if the default framebuffer is multisampled. */
    antialias,
    /** Register a callback run after any resolution change: (w, h) in CSS px. */
    onResize(fn) { resizeHooks.push(fn); return () => resizeHooks.splice(resizeHooks.indexOf(fn), 1); },
    get resolutionScale() { return resolutionScale; },
    /** 1 = native (capped by maxPixelRatio). 0.75 renders 56% of the pixels. */
    setResolutionScale(s) {
      const n = Math.max(0.25, Math.min(2, +s || 1));
      if (n === resolutionScale && explicitPixelRatio === null) return gfx.info();
      resolutionScale = n;
      explicitPixelRatio = null;
      applyResolution();
      return gfx.info();
    },
    get maxPixelRatio() { return maxPixelRatio; },
    setMaxPixelRatio(n) {
      const v = Math.max(0.25, Math.min(4, +n || 1));
      if (v === maxPixelRatio && explicitPixelRatio === null) return gfx.info();
      maxPixelRatio = v;
      explicitPixelRatio = null;
      applyResolution();
      return gfx.info();
    },
    /**
     * Absolute backbuffer scale, ignoring devicePixelRatio and both knobs above.
     * This is what `tools/perf-ab.mjs --preset dpr` swaps, so a DPR-1 headless
     * session can measure the DPR-2 fragment cost the user actually pays.
     */
    setPixelRatio(p) {
      const v = Math.max(0.25, Math.min(4, +p || 1));
      if (explicitPixelRatio === v) return gfx.info();
      explicitPixelRatio = v;
      applyResolution();
      return gfx.info();
    },
    info() {
      const s = renderer.getDrawingBufferSize(new THREE.Vector2());
      return {
        antialias,
        devicePixelRatio,
        maxPixelRatio,
        resolutionScale,
        pixelRatio: renderer.getPixelRatio(),
        drawingBuffer: [s.x, s.y],
        megapixels: +((s.x * s.y) / 1e6).toFixed(3),
      };
    },
  };

  return { renderer, scene, camera, gfx };
}
