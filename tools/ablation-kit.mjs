/**
 * Shared page-side ablation kit.
 *
 * Extracted so `tools/adaptive-test.mjs` can REMOVE THE LOAD from the frame
 * without duplicating it. That matters: the adaptive controller's up-path can
 * only be tested honestly by leaving the frame budget at the shipped 60 fps and
 * taking the work away, not by relaxing the budget to something the product does
 * not ship. A suite that only exercises `setTargetFps(30)` passes while the
 * shipped configuration is a one-way ratchet — which is exactly what happened.
 */
/**
 * Installed once per session as `window.__abl`. Every entry is
 * `{ on(), off() }`; `off()` must restore the shipped state exactly, because the
 * baseline arm of every pair is just "everything off".
 */
const KIT_SRC = `(function () {
  const h = window.__harness, d = h.debug;
  // Collect the meshes we ablate ONCE, so the pairing cannot drift as LOD rings
  // and pools come and go mid-session.
  const groups = {
    snow: [], trees: [], skier: [], sky: [], rocks: [],
    tracks: [], spray: [], lift: [], markers: [], other: [],
  };
  function classify(o) {
    if (!(o.isMesh || o.isInstancedMesh || o.isPoints)) return;
    const n = (o.name || '') + '|' + (o.parent && o.parent.name || '');
    if (/terrain/.test(n)) groups.snow.push(o);
    else if (/track|trench/i.test(n)) groups.tracks.push(o);
    else if (/spray|plume|powder/i.test(n)) groups.spray.push(o);
    else if (/tree|clust|foliage|shrub/i.test(n)) groups.trees.push(o);
    else if (/^sky/.test(o.name || '')) groups.sky.push(o);
    else if (/rock|talus|boulder/i.test(n)) groups.rocks.push(o);
    else if (/lift|chair|pylon|cable|tower/i.test(n)) groups.lift.push(o);
    else if (/marker|gate|fence|sign|flag|pole/i.test(n)) groups.markers.push(o);
    else if (/skier|rider|ski\\b|board/i.test(n)) groups.skier.push(o);
    else groups.other.push(o);
  }
  d.scene.traverse(classify);

  // ---------------------------------------------------------------------------
  // Gutting a material, WITHOUT constructing a new one.
  //
  // There is no THREE handle on the page, and more importantly a substitute
  // material would be the wrong instrument anyway: the snow shader does its
  // terrain DISPLACEMENT in the vertex program (snow-material.js installs it
  // through onBeforeCompile), so anything that drops the vertex shader moves the
  // geometry and the ablation stops being about shading at all.
  //
  // So the original onBeforeCompile is left to run in full — vertex program,
  // uniforms and defines exactly as shipped — and only the FRAGMENT body is
  // replaced afterwards. The replacement is built out of three's own map /
  // alphaMap / alphaTest chunks (three resolves #include in a supplied
  // fragmentShader), so the alpha-tested cutout of a conifer card comes out
  // bit-identical and nothing behind it is ever exposed. That is what keeps this
  // clear of trap 3.
  // ---------------------------------------------------------------------------
  const CHEAP_FRAG = [
    'precision highp float;',
    '#include <common>',
    '#include <uv_pars_fragment>',
    '#include <map_pars_fragment>',
    '#include <alphamap_pars_fragment>',
    '#include <alphatest_pars_fragment>',
    'void main() {',
    '  vec4 diffuseColor = vec4( 0.62, 0.69, 0.76, 1.0 );',
    '  #include <map_fragment>',
    '  #include <alphamap_fragment>',
    '  #include <alphatest_fragment>',
    '  gl_FragColor = vec4( diffuseColor.rgb, 1.0 );',
    '}',
  ].join('\\n');

  const gutted = [];
  function gut(m) {
    if (!m || m.__ablOn) return;
    if (!('__ablOBC' in m)) {
      m.__ablOBC = m.onBeforeCompile;
      m.__ablKey = m.customProgramCacheKey;
    }
    const origOBC = m.__ablOBC, origKey = m.__ablKey;
    m.onBeforeCompile = function (shader, renderer) {
      if (origOBC) origOBC.call(this, shader, renderer);
      shader.fragmentShader = CHEAP_FRAG;
    };
    m.customProgramCacheKey = function () {
      return (origKey ? origKey.call(this) : '') + '|ablated';
    };
    m.needsUpdate = true;
    m.__ablOn = true;
    gutted.push(m);
  }
  function ungut(m) {
    if (!m || !m.__ablOn) return;
    m.onBeforeCompile = m.__ablOBC;
    m.customProgramCacheKey = m.__ablKey;
    m.needsUpdate = true;
    m.__ablOn = false;
  }
  function swapGroup(list) {
    for (const o of list) {
      const m = o.material;
      if (Array.isArray(m)) m.forEach(gut); else gut(m);
    }
  }
  function unswapAll() {
    for (const m of gutted) ungut(m);
    gutted.length = 0;
  }

  const P = d.postfx.params;
  const A = {
    // --- scene shading cost (coverage-preserving material swaps) -------------
    // Every group entry declares meshes() so the shared-material guard can check
    // it. Without that the guard only covered the entries that happened to define
    // one, and e.g. "rocks -1.2 ms" could silently have been about rocks AND
    // markers if they shared a material.
    snow:   { desc: 'terrain snow/rock shader -> MeshBasicMaterial (same coverage)',
      meshes: () => groups.snow, on: () => swapGroup(groups.snow), off: unswapAll },
    trees:  { desc: 'conifer cards + clusters -> basic (same map + alphaTest)',
      meshes: () => groups.trees, on: () => swapGroup(groups.trees), off: unswapAll },
    rocks:  { desc: 'scatter rocks/talus -> basic',
      meshes: () => groups.rocks, on: () => swapGroup(groups.rocks), off: unswapAll },
    skier:  { desc: 'skier + riders -> basic',
      meshes: () => groups.skier, on: () => swapGroup(groups.skier), off: unswapAll },
    sky:    { desc: 'sky dome shader -> basic',
      meshes: () => groups.sky, on: () => swapGroup(groups.sky), off: unswapAll },
    tracks: { desc: 'carve trench ribbon -> basic (it runs the FULL snow shader)',
      meshes: () => groups.tracks, on: () => swapGroup(groups.tracks), off: unswapAll },
    spray:  { desc: 'snow spray particles -> basic',
      meshes: () => groups.spray, on: () => swapGroup(groups.spray), off: unswapAll },
    lift:   { desc: 'chairlift, cable and towers -> basic',
      meshes: () => groups.lift, on: () => swapGroup(groups.lift), off: unswapAll },
    markers:{ desc: 'piste markers, gates, fences -> basic',
      meshes: () => groups.markers, on: () => swapGroup(groups.markers), off: unswapAll },
    other:  { desc: 'everything else in the scene -> basic',
      meshes: () => groups.other, on: () => swapGroup(groups.other), off: unswapAll },
    // COMPLEMENT ARMS. "terrain is X" and "everything except terrain is Y" are
    // different questions and both are needed: an arm that bottoms out on the
    // vsync floor only gives a lower bound, and the complement is what turns two
    // lower bounds into a ratio. Reviewing this tool, the complement is what
    // established that terrain is >=76% of scene shading cost rather than
    // "over half".
    noterrain: { desc: 'EVERYTHING EXCEPT terrain -> basic (complement of snow)',
      meshes: () => Object.entries(groups).filter(([k]) => k !== 'snow').flatMap(([, v]) => v),
      on: () => swapGroup(A.noterrain.meshes()), off: unswapAll },
    allscene: { desc: 'EVERY scene material -> basic (scene shading floor)',
      meshes: () => Object.values(groups).flat(),
      on: () => { for (const k of Object.keys(groups)) swapGroup(groups[k]); },
      off: unswapAll },

    // --- the two shadow map DRAW passes, with sampling left intact -----------
    shadowdraw: {
      desc: 'shadow maps not re-rendered (still bound + sampled)',
      on: () => { d.renderer.shadowMap.autoUpdate = false; },
      off: () => { d.renderer.shadowMap.autoUpdate = true; },
    },

    // --- post chain ---------------------------------------------------------
    post:   { desc: 'whole post chain off', on: () => { d.postfx.enabled = false; }, off: () => { d.postfx.enabled = true; } },
    taa:    { desc: 'TAA resolve off (SMAA takes over)', on: () => { P.taa.enabled = false; }, off: () => { P.taa.enabled = true; } },
    bloom:  { desc: 'bloom off',  on: () => { P.bloom.enabled = false; }, off: () => { P.bloom.enabled = true; } },
    dof:    { desc: 'DOF off',    on: () => { P.dof.enabled = false; },   off: () => { P.dof.enabled = true; } },
    motion: { desc: 'motion blur off', on: () => { P.motion.enabled = false; }, off: () => { P.motion.enabled = true; } },
    grain:  { desc: 'film grain amplitude 0 (pass still runs)', on: () => { P.film.grain = 0; }, off: () => { P.film.grain = 0.012; } },
  };

  // SHARED-MATERIAL GUARD. This cost a wasted measurement round: terrain.js
  // creates ONE snow material (terrain.js:1302) and assigns the same instance to
  // all nine clipmap LOD meshes (terrain.js:2651), so an attempt to ablate
  // "LOD 6-8" gutted the material that LOD 0-5 are also drawn with. Both arms
  // measured the whole terrain, agreed with each other beautifully, and meant
  // nothing. The self-check cannot catch it — the frame really does change, just
  // not in the way the entry claims. So any ablation naming a strict subset of
  // the meshes that share a material is refused outright.
  function sharedWarnings() {
    const owners = new Map();               // material -> [mesh names]
    for (const [g, list] of Object.entries(groups)) {
      for (const o of list) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          if (!owners.has(m)) owners.set(m, []);
          owners.get(m).push(g + ':' + (o.name || o.type));
        }
      }
    }
    const out = [];
    for (const [, names] of owners) {
      const gs = new Set(names.map((n) => n.split(':')[0]));
      if (names.length > 1) out.push({ groups: [...gs], meshes: names });
    }
    return out;
  }
  /** Meshes outside the given list that would be hit via a shared material. */
  function collateral(list) {
    const mats = new Set();
    for (const o of list) {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m) mats.add(m);
    }
    const hit = [];
    for (const [, all] of Object.entries(groups)) {
      for (const o of all) {
        if (list.indexOf(o) >= 0) continue;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) if (m && mats.has(m)) { hit.push(o.name || o.type); break; }
      }
    }
    return hit;
  }

  window.__abl = {
    names: Object.keys(A),
    desc: (k) => A[k] && A[k].desc,
    counts: () => Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
    /** Meshes an entry would ablate as collateral through a shared material. */
    collateralFor(k) {
      if (!A[k] || !A[k].meshes) return [];
      return collateral(A[k].meshes());
    },
    sharedWarnings,
    on(k) { A[k] && A[k].on(); },
    off(k) { A[k] && A[k].off(); },
    allOff() { for (const k of Object.keys(A)) { try { A[k].off(); } catch (e) {} } },
  };
  return window.__abl.counts();
})`;

export { KIT_SRC };
