# CLAUDE.md — Alpine ski simulator

Read this before touching anything. Every item below cost at least one wasted
round of work to learn. `ARCHITECTURE.md` has the module contracts; `README.md`
is the human-facing overview.

## The project in one paragraph

Third-person ski simulator in Three.js r185. **`three` is the only dependency and
there are no binary art assets** — every mesh, texture, shader and sound is
generated in code. That constraint is deliberate; do not add a dependency or
download an asset to solve a problem. Anything under `three/addons/` is fair game.
Runs at 1600×900, ~60 fps.

## Verify visually or you are guessing

```bash
node tools/shoot.mjs --out shots/x [--only hero,ridge] [--perf]
node tools/contact-sheet.mjs shots/x shots/x/sheet.png
node tools/contact-sheet.mjs --ab ours.png ref.jpg /tmp/ab.png   # unlabelled pair
node tools/flyby.mjs --out run.mp4 --seconds 10 --fps 30         # scripted run
```

`shoot.mjs` spawns its own Vite server and headless Chrome. Exit 0 means it
genuinely rendered — no console errors, no blank frames. **Then open the PNGs with
the Read tool and actually look.** Exit 0 is not "it looks right".

`window.__harness.debug` exposes `{ terrain, sky, scatter, skier, physics, spray,
tracks, postfx, chaseCam, camera, scene, renderer }`. Write a probe against it and
measure the scene rather than squinting at pixels.

Magnify before judging detail — most defects here are invisible at 1:1:

```bash
ffmpeg -y -i shots/x/hero.png -vf "crop=340:360:1180:110,scale=1020:1080:flags=neighbor" /tmp/c.png
ffmpeg -hide_banner -i img.png -vf "crop=W:H:X:Y,signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null -
```

## Measurement traps — all seven produced confident, wrong answers

1. **`--perf` absolute numbers are meaningless.** Headless Chrome mode-locks to
   divisions of the refresh rate by machine load. The *same unmodified build* has
   measured 60, 54 and exactly 30.0 fps within an hour. Four consecutive matching
   readings prove nothing — that is the compositor holding one mode. A reading of
   exactly 30.0 is a vsync half-rate lock, never a regression. To compare two
   versions, **alternate them inside one session** and compare pairs; take
   min-of-N.
2. **`harness.step()` in a loop does not measure the real frame.** It once
   reported 8.4 ms (≈119 fps) for a build measuring 54, and claimed disabling
   post-processing made the frame *slower*.
3. **`visible = false` ablations lie** whenever hiding an object exposes what is
   behind it. Hiding near trees made a frame **22 ms slower**, because sky and
   distant terrain then had to be shaded.
4. **Check your crop before trusting a metric.** A crop that was 35% sky measured
   the wall's *silhouette*, not its surface, and made a real terrain fix look like
   it had done nothing. Verify a rock crop contains rock. Also beware difference
   masks: white cards differed from the snow behind them by ~6 levels and dropped
   out of their own measurement.
5. **You have never measured the resolution the game is played at.** `engine.js`
   uses `min(devicePixelRatio, 2)`; headless Chrome reports DPR **1** and
   `shoot.mjs` pinned `deviceScaleFactor: 1`, so every measurement in this
   project's history rendered 1600×900 = **1.44 Mpx**. A Retina machine renders
   3200×1800 = **5.76 Mpx — 4× the fragment work** — and every postfx target is
   sized from `getDrawingBufferSize()`, so the whole post chain scales with it.
   Measured: **~5.1 ms per megapixel** plus a ~18.5 ms resolution-independent
   floor. Use `shoot.mjs --dpr 2` / `perf-ab.mjs --dpr 2`; `report.json` now
   records `dpr` and the real `drawingBuffer`. Never compare shots across
   densities.
6. **`renderer.info.render.calls` reads `1` unless you force `autoReset = false`.**
   three resets `info` at the top of *every* `renderer.render()`, and the post
   chain makes a dozen per frame, so the naive read reports the last fullscreen
   quad. True figure is **527 draw calls/frame**. Anyone who profiles draw calls
   without knowing this concludes the scene is trivially cheap.
7. **The GPU timer's absolute value is ~2.5× reality.**
   `EXT_disjoint_timer_query_webgl2` works on this ANGLE/Metal path, but ANGLE
   derives it from command-buffer timestamps that include queue and scheduling
   gaps — it reads above the presented frame interval, which is impossible for
   real GPU busy time. Narrowing the query to bracket only the render span does
   not fix it. It is a sensitive *relative* metric: read ratios between the two
   arms of one A/B, never levels.

`--perf` is a **stationary player at DPR 1**. It is structurally blind to
motion-dependent cost and to fragment cost. Use `tools/frametime.mjs` (what is
spiking — p50/p95/p99/max with per-frame attribution) and `tools/perf-ab.mjs`
(is A faster than B — interleaved ABBA inside one session, per-pair deltas,
min-of-N, sign test). Both drive a **carving** path by default, because a
straight coast does not load the spray, trench or g-force systems.

Frame spikes are a **tail** statistic. The vsync mode-lock in trap 1 corrupts
means, not tails: a 40 ms frame is 40 ms whichever mode the compositor holds.
Quote p99 and count-over-20 ms, never fps.

## Never use `git stash`

It is a single ref shared by **every worktree** of the repo. Two agents stashing
concurrently crossed the LIFO stack and each popped the other's work; one module
was nearly lost. Commit on your branch instead. If work must run in parallel, use
separate worktrees with **disjoint file ownership** and stage results to a shared
directory — that pattern worked well here.

## Diagnoses that were wrong, and what they actually were

Do not re-propose these. Each was asserted confidently and disproved by measurement.

| Symptom | Wrong cause | Actual cause |
|---|---|---|
| Full-frame "brushed metal" smear | Motion blur / post | Terrain slope-stretched detail normals — proved by rendering with every post pass off |
| Distant trees render as white ice shards | Atlas painted too bright; mip/alpha-test eating dark needles; instance tint | **F0 = 0.04 dielectric specular** on flat cards reflecting the sky dome. With albedo forced to *black* they still rendered at 0.71× the snow. `envMapIntensity` can't fight it — three overwrites it with `scene.environmentIntensity` |
| Smooth untextured strip along cliff silhouettes | Triplanar `SN_TRI_CUT` at ~68° | A 4th-power Fresnel grazing-sheen term worth ~4× the diffuse of 5%-albedo rock |
| Snow spray invisible | Not emitting | Emitting fine (+20% in the raw buffer) — **TAA at feedback 0.78 was averaging it away** |
| Corduroy reads as cross-hatch | Two crossing frequencies | Aliasing of a *single* 7.2 cm comb at 3.6 px/period beating against the pixel grid |
| Ski tracks as black stripes | Wrong colour | Stock `MeshStandardMaterial` next to a piste using the full snow shader |
| Conifers as bare poles with floating cards | Foliage generation | LOD1 band starts at 34 m but carried only ~9% of LOD0's foliage |
| Trees flicker | LOD churn, ring rebuild, mip/alpha-test coverage, billboard flipping — all four eliminated by measurement | **The TAA resolve.** Freeze the sim completely (no wind, no dither, no camera) and accumulate per-pixel temporal SD over the crowns: **6.95 codes shipped, 0.013 with TAA off.** The render was exactly static; the resolve was not. Raising feedback alone fixes a third of it, because the variance box that clips the history is itself built from the jittered current frame |
| Park kickers read as bumps and launch you late | Two separate defects | **One defect.** The takeoff ramp peaked at **+7.7°** where a park kicker is 25–35°. Too shallow to read as built *and* too shallow to unload the skis — the rider separated 5.3 m past the lip. Raising the ramp fixed both |

## Interface hazards

- `Terrain.normal(x, z, third)` has **two call conventions** — a `Vector3` out-param
  and a numeric epsilon (physics passes 1.6–2.2 for footprint smoothing). Dispatch
  on `typeof`. Breaking one silently breaks the other. This caused the first
  integration failure.
- `terrain.height(x, z)` is sampled by physics every frame: keep it cheap and
  allocation-free, and keep it in exact agreement with the GPU displacement or the
  skier floats.
- `tracks.js` imports `createSnowMaterial` from `world/snow-material.js` — a
  cross-module dependency not obvious from the file layout.
- `sky.js` patches global `THREE.ShaderChunk`s (fog, `lights_fragment_begin`,
  `shadowmap_pars_fragment`, `aomap_fragment`). If a three upgrade changes those
  chunks, the patches log a warning and fall back rather than failing loudly.
- **`terrain.depthMaterial` renders nothing in an override pass** — the shadow map
  leaves it `BackSide`. A depth readback that forgets this returns an empty buffer,
  not an error.
- **three's `packDepthToRGBA` is R-major, not A-major.** Unpacking it backwards
  yields a plausible-looking answer that is ~35 m wrong.
- **`snData.w` (`expo`) is a shared channel.** `snow-material.js` uses it for
  `talus -= expo*0.28`, and `terrain.js` now drives it to 5.0 over the snow park to
  hold the rock mask off 45–50° kicker flanks. A second consumer added without
  checking will find the park saturating it.
- **`renderer.info` is reset at the top of every `renderer.render()`.** The post
  chain calls that a dozen times a frame, so per-frame counters need
  `autoReset = false` — see trap 6.
- Instrumentation hook: `window.__harness?.perf?.mark(label, n)` is a no-op unless
  recording. Tag ring wraps, chunk re-emits and trench commits with it; then
  `report().marks` contrasts the frame-time tail on marked frames against unmarked
  ones. That is how a periodic hitch gets attributed without quoting an fps number.

## Quality baseline — do not regress these

Four blind reviews against real Steep screenshots and alpine photography scored
74 → 80 → 84 → 85/100. It is **not** AAA and was identified in every pair. These
are the measured wins; check them after any change to the snow or lighting:

| Metric | Value | Reference |
|---|---|---|
| Near-piste sunlit snow L\*/sd | 73.1 / 12.6 | photo 74.8/10.5, Steep 58.3/29.6 |
| Treeline luminance ÷ adjacent snow | 0.36 | target band 0.25–0.45 |
| Distant conifer band RGB | (43,58,68) | real Megève (40,55,72) |
| Cast-shadow snow B−R | +21 to +26 | real photos +24 to +26 |
| Shadowed rock B/R | ≥ 1.58 | trades against a blue cast — see below |
| Sky bluest-decile B/R | 2.63–3.50 | photos 2.07–3.68, Steep 2.17 |
| Carve edge ÷ inclination | 1.23, angulation 25–33° | reviewed as better than either game reference |

Also protected: no ring/annulus artifacts and no chromatic fireflies on snow
(verify at 8× nearest-neighbour); grooming corduroy stays fine parallel ridging at
~12.5 cm pitch, derivative-gated, **on-piste only**.

## Known remaining defects, ranked

1. **The massif has one scale of form** — no 200 m tower, gully, buttress with a
   shadow side, or talus cone with a boundary. References have four or five nested
   scales. Needs explicit gully/tower/bench primitives in `terrain.js`, not more
   summed noise: summed noise has no *events*.
2. **No self-shadowing or ambient occlusion on the massif.** Real rock is dark in
   its own gullies. This is the single largest reason the rock reads flat next to a
   photograph, and it is expensive at 4 km through a clipmap.
3. `ridge` is the weakest framing — rock still bluer and busier than reference.
   The knob is `bounceHue`'s mix factor in `snow-material.js`; it trades directly
   against the shadowed-rock B/R floor.
4. Snow-on-rock mask still dithers at pixel scale in the far field.
5. Spray has no lit rim or crystalline core; on some carve frames it reads as dark
   exhaust rather than snow.
6. No displaced snow at the ski edge — corduroy runs undisturbed right up to it.

## Working style that paid off here

- One agent per file, strict ownership, staged output to a shared directory. The
  integration bugs all came from ambiguous seams, not from bad code.
- Have the builder self-critique against downloaded reference photos in unlabelled
  A/B pairs. It repeatedly caught things a spec could not describe.
- Numbers beat opinions, but **validate the metric before trusting the number** —
  see the traps above. More time was lost to bad metrics than to bad code.
