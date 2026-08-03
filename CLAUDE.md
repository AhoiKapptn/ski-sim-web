# CLAUDE.md — Alpine ski simulator

Read this before touching anything. Every item below cost at least one wasted
round of work to learn. `ARCHITECTURE.md` has the module contracts; `README.md`
is the human-facing overview.

## The project in one paragraph

Third-person ski simulator in Three.js r185. **`three` is the only dependency and
almost nothing is a binary asset** — every mesh, texture, shader and sound is
generated in code. That constraint is deliberate; do not add a dependency or
download an asset to solve a problem. Anything under `three/addons/` is fair game.
Runs at whatever the window is; `1600×900` is only the capture tools' default and
**is not the resolution the game is played at** — see trap 5 and trap 8. On the
owner's 5K panel a maximised window is a 14.75 Mpx backbuffer. There is an
adaptive resolution controller (`engine.js`) and a graphics settings panel
(Escape) between that and a playable frame.

The **one** exception, granted by the owner for those files alone, is
`public/brand/*.png`: two real sponsor logos loaded by `world/branding.js`. A
brand mark is the one thing here that cannot be reproduced procedurally without
being wrong. It is not a precedent — a second request goes back to the owner.

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

For anything performance-shaped, start in `pnpm dev`: press `` ` `` for the
ablation panel (`src/core/debug-perf.js`, dev-only), then **`D`**. It measures
the shipped frame against a floor with the scene emptied and says which of four
things you are looking at — software rendering, the display pacing, something
outside the renderer, or the scene. `F` walks the resolution ladder and reports
which rungs LOCK. Do this before ablating subsystems: trap 8 is what happens if
you don't.

Magnify before judging detail — most defects here are invisible at 1:1:

```bash
ffmpeg -y -i shots/x/hero.png -vf "crop=340:360:1180:110,scale=1020:1080:flags=neighbor" /tmp/c.png
ffmpeg -hide_banner -i img.png -vf "crop=W:H:X:Y,signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null -
```

## Measurement traps — all eleven produced confident, wrong answers

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

   **And check your crop box against the image's actual dimensions.** A crop
   rectangle tuned on a 1600×900 shot, applied unchanged to a 3200×1800 DPR-2
   PNG, lands on completely different ground. This produced a "−15% snow
   micro-contrast" regression that was really −0.3% to −5.4%, and in the same
   session a "23 L\* difference" between two resolutions that was camera framing
   drift, not a rendering difference. Two guards: assert the PNG's width before
   measuring, and capture every arm with `shoot.mjs`' deterministic settle
   (`setAuto(false)` then a fixed count of `harness.step()`) — letting the sim
   run free between arms moves the camera.
5. **You have never measured the resolution the game is played at.** `engine.js`
   uses `min(devicePixelRatio, 2)`; headless Chrome reports DPR **1** and
   `shoot.mjs` pinned `deviceScaleFactor: 1`, so every measurement in this
   project's history rendered 1600×900 = **1.44 Mpx**. A Retina machine renders
   3200×1800 = **5.76 Mpx — 4× the fragment work** — and every postfx target is
   sized from `getDrawingBufferSize()`, so the whole post chain scales with it.
   Measured on the canonical carve path: DPR 1 is p50 16.70 / p99 17.90 with 3 of
   839 frames over 20 ms; DPR 2 is p50 34.00 / p99 42.80 with **404 of 405** over
   20 ms and 65% over 33 ms.

   Cost model: **~3–5 ms per megapixel on a ~8–12 ms fixed floor, valid only over
   1.4–5.8 Mpx.** The slope originally recorded here (5.1 ms/Mpx) reproduces — an
   independent ascending sweep gives 5.21. **The 18.5 ms floor does not**: an
   18.5 ms floor puts DPR 1 at 25.8 ms, under 40 fps, and DPR 1 measures a clean
   16.70 ms vsync lock. **Do not extrapolate the fit**: at 9.0 Mpx the real cost
   is 77.5 ms where every linear fit predicts 40–54.

   Use `shoot.mjs --dpr 2` / `perf-ab.mjs --dpr 2`; `report.json` records `dpr`
   and the real `drawingBuffer`. Never compare shots across densities.

   Two consequences for measurement:
   - At DPR 2 the presented interval is **not** vsync-censored: the distribution
     is smooth across 28–44 ms. At DPR 1 it pins to 16.70 and can only ever
     report a floor.

     **But do not make that argument from the 16.7 residual.** The begin-frame
     tick in headless Chrome is **8.33 ms, not 16.7** — every clean interval
     observed (16.7 / 25.0 / 33.3 / 41.7 / 50.0 / 58.3 / 66.7) is an integer
     multiple of it, and 13 of the 15 distinct values in one controller log were
     exact multiples. So "this value is not a multiple of 16.7" is **not** by
     itself evidence of a free-running frame; check against 8.33. The DPR-2
     conclusion stands on the SHAPE of the distribution, not on the residual.

     This is not pedantry: reasoning from a 16.7 ms tick produced a silent
     one-way ratchet in `engine.js`' resolution controller, twice. **Any
     threshold that a vsync-locked frame must satisfy, derived from a quantity
     that can slide underneath it, is the same bug** — and the presented interval
     is ALWAYS quantised, so it is an upper bound on an unknown cost and nothing
     can be inferred by scaling it.
   - `engine.js`' resolution controller is ON by default above 2.5 Mpx. Any tool
     that measures frame time must hold `gfx.freeze()` for the session or it will
     measure the controller. `tools/frametime.mjs` boot() does this.
6. **`renderer.info.render.calls` reads `1` unless you force `autoReset = false`.**
   three resets `info` at the top of *every* `renderer.render()`, and the post
   chain makes a dozen per frame, so the naive read reports the last fullscreen
   quad. True figure is **532 draw calls/frame** on the snow and **222 inside the hut**.
   Anyone who profiles draw calls without knowing this concludes the scene is
   trivially cheap.

   **And the 531/532 figure is the WHOLE FRAME, not the main pass: 321 of the 532
   (60%) are shadow-pass calls, and 351 of them (66%) are the SKIER**, whose rig
   is 117 draw units for 61,700 triangles — 1.4% of the frame's geometry — set to
   `castShadow` on all 105 meshes, so it pays 117 x 2 again in the two cascades. A
   merged low-poly shadow proxy would delete ~230 calls at 16 cm and 1.4 cm texels
   where nothing can resolve the difference. Not done; measured and available.
7. **The GPU timer's absolute value is ~2.5× reality.**
   `EXT_disjoint_timer_query_webgl2` works on this ANGLE/Metal path, but ANGLE
   derives it from command-buffer timestamps that include queue and scheduling
   gaps — it reads above the presented frame interval, which is impossible for
   real GPU busy time. Narrowing the query to bracket only the render span does
   not fix it. It is a sensitive *relative* metric: read ratios between the two
   arms of one A/B, never levels.

   Its inflation tracks **submission count**, not load: measured as a ratio
   against the presented interval it reads 2.75× with the post chain on and 1.94×
   with it off, so it systematically over-charges any change that alters the
   number of passes. Never quote a timer delta across such a change.

   **And `gl.finish()` is not an escape hatch: it does not drain the GPU on
   Chrome's command-buffer path.** Known-answer test: quadrupling the pixel count
   moved the presented interval +18.35 ms in 6/6 pairs and moved the
   `gl.finish()`-bracketed render span by **0.00 ms**. Worse, enabling
   `--sync-gpu` roughly **doubles** the presented interval, so it perturbs what it
   measures. The `--sync-gpu` fallback advertised in `perf-ab.mjs`' header is not
   usable on this machine; the presented interval at DPR 2 is.

8. **The display is not 60 Hz, and every threshold in this repo assumed it was.**
   The owner's panel measures a **6.94 ms tick — 144 Hz**. The presented interval
   is quantised to multiples of the refresh period, so the only frame times that
   exist there are 6.9 / 13.9 / 20.8 / 27.8 ms. **16.67 ms is not one of them.**

   **THE MACHINE, since every threshold here depends on it (recorded 2026-08-03):**
   Apple **M5 Pro**, 20-core GPU. Two panels — the built-in Liquid Retina XDR
   (3456x2234, 120 Hz ProMotion) and a **DELL U3223QE 5K running 2560x1440
   logical at 60 Hz**. On the Dell, maximised at DPR 2, the backbuffer is
   **14.75 Mpx** and the ONLY presentable frame times are 16.67 and 33.33 ms.
   That is the target to measure against, not 1600x900 and not 5.76 Mpx.
   Headless Chrome reports a 120 Hz tick (8.33 ms), so its rungs are not the
   Dell's — a frame that headless shows as a clean 24.96 ms lock is a 33.33 ms
   frame on the display the game is played on.

   Two consequences, both of which produced wrong answers in one session:

   - A frame at 23.5 ms is not "42 fps". It is the 20.8 and 27.8 rungs
     alternating, and that is what "the performance is bad" actually described:
     163 of 171 frames over 20 ms but only 4 over 33. Shaving 2 ms off such a
     frame changes nothing anybody can see, because it does not cross a rung.
     **A win is only felt when it moves the frame onto a different rung**, so
     quote the rung, not the millisecond delta.
   - `engine.js`' controller aimed at `budget()` = 16.67 ms. On 60 and 120 Hz
     panels that IS a rung, so aiming at the budget and aiming at a rung were
     indistinguishable and nothing in the controller's history could tell them
     apart. On 144 Hz they differ, and the controller settled between rungs and
     then hunted. It now measures the tick and aims at the fastest rung that
     still meets the target (`gfx.info().displayTick / vsyncLadder / lockMs`).

   The tick cannot be read from the fastest frame observed — a struggling scene
   at 144 Hz never once presents 6.9 ms. It is inferred from the SPACING of the
   observed levels. And on a high-refresh panel the fps target is a real choice:
   60 forces the 13.9 ms rung and a low resolution, `?fpstarget=48` takes the
   20.8 ms rung and buys the pixels back for a lock that is just as smooth.

9. **Two vite-based tools running at once corrupt each other, and the symptom
   names an innocent file.** They share `node_modules/.vite`, and when they
   clobber each other's dep cache the page throws
   `SyntaxError: Unexpected identifier '<some export name>'` pointing at a module
   nobody edited. It wrecked three measurement runs in one session and sent two
   of us chasing a phantom bug in our own work. **Serialise every tool that
   spawns vite** — `shoot.mjs`, `frametime.mjs`, `perf-ab.mjs`, all of them.

   The corollary bit harder: **a vite dev server watches the source tree, so
   anything editing a file mid-run triggers a full page reload** and the harness
   dies with `Cannot read properties of undefined` on whatever the tool had
   installed on `window`. Adding a NEW module to the import graph also costs a
   one-time dep re-optimisation reload. If a measurement dies that way, wait for
   the tree to go quiet and re-run; do not average the corpse in.

   And do not let this trap absorb real errors. A genuine syntax error looks
   almost identical from the page's point of view — check with
   `npx esbuild <file> --outfile=/dev/null` before blaming the cache.

11. **A stale graphics preset in `localStorage` silently changes every
    screenshot.** The settings panel persists to `alpine.gfx.v1`, and every
    capture tool boots the real page. A profile left on `low` would quietly
    change the mesh tier, the post chain and the shader tier under a quality
    measurement, with no indication in the output. Two defences, both already in
    place: `auto` is the empty patch and writes nothing, and **`?gfx=default`
    ignores the stored document entirely.** Use `?gfx=default` in any tool whose
    result must be independent of the profile. `settings.storageBypassed` reports
    whether it is in force.

10. **A backtick inside a GLSL string silently terminates the JS template
    literal.** Every shader in this project lives in a `` /* glsl */ `...` ``
    template literal, so writing `` `sky.js` `` in a GLSL *comment* ends the
    string and produces a syntax error pointing at the next identifier — far from
    the real site, and utterly baffling. This cost four separate cycles in one
    session across two people. **Write GLSL comments with no backticks**, and run
    `npx esbuild <file> --outfile=/dev/null` after every shader edit: it is
    instant and it names the line.

## The tools, and which question each answers

```bash
node tools/perf-baseline.mjs --w 2560 --h 1440 --dpr 2   # the cost CURVE on a real display
node tools/floor-probe.mjs   --w 2560 --h 1440 --dpr 2   # is this cost fragment, or fixed?
node tools/tier-shots.mjs --out shots/t --only ridge     # every quality tier, ONE session
```

- **`perf-baseline.mjs`** answers the question nobody had asked at the right pixel
  count: what does the frame cost across the ladder on THIS display, and where
  does the shipped controller actually land? Phase A watches the controller LIVE
  (sampling rAF directly, because `perf.start()` freezes it and freezing it
  measures something no player sees); phase B pins each rung.
- **`floor-probe.mjs`** classifies a cost. It runs the same ablation at two
  resolutions: a fragment cost scales with the pixel count, a vertex/submit/CPU
  cost does not, so the RATIO of the two deltas tells you which you have without
  either absolute reading having to be trusted. **Pick two UNCENSORED
  resolutions** — the first run of this used 2.36 Mpx, which is pinned to a vsync
  rung, and every ablation read exactly 0.00 ms because the frame could not go
  faster. A censored arm cannot measure anything.
- **`tier-shots.mjs`** captures every tier inside one session with the sim frozen
  and TAA off, because cross-session captures here are not comparable (up to
  17.8 dB PSNR between two runs of the same build).

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
| "The performance is lagging a bit" | CPU cost, the post chain, draw calls, shadow maps, or the 527-call scene being too complex | **Fragment cost at DPR 2, and almost all of it one shader.** CPU is 0.4 ms update + 1.1 ms submit out of a 34 ms frame. Ablating every scene material returns the interval to the 16.70 ms vsync lock; the terrain snow shader alone is **well over half** of scene shading cost — **≥14.4 ms (censored by the vsync floor) against 3.6–8.3 ms for the entire rest of the scene**, measured with complement arms, 2/2 pairs. No post pass, no shadow pass and no CPU subsystem is measurable against it. The lever is pixels, not passes — **but see the row below: that is the lever for the SLOPE, and it cannot reach the intercept** |
| "The performance is not good" — at a REAL fullscreen backbuffer, with the resolution ladder already at its floor | The subsystems; or resolution, again | **Pixels had already been spent, and there was nothing left to spend.** At 2560x1440 DPR 2 = 14.75 Mpx the ladder bottomed out at scale 0.4 (2.36 Mpx, 16% of native) and still missed: settled p50 24.9 ms, 268/519 frames over 20 ms, 36 over 33. The frame is `~2.5 ms/Mpx on a ~8.7 ms floor`, and the floor is what a resolution controller structurally cannot touch. What fixed it was making the per-pixel cost cheaper (one lattice fetch instead of four; terms that were multiplied by zero; DOF gathering 42 fetches over the whole sky) and deleting a clipmap ring that could never draw a pixel. Result: settled p50 **16.70 ms locked, 0/459 frames over 33** |
| "The hut UI experience is weak" | The card's typography, the seated framing, or the lighting | **The room.** `buildings[0]`'s `w`/`d` are HALF-extents, so the enterable hall is **16.2 x 23.2 m — 374 m of floor — and it had two tables in it.** The seated shot was always fine; the moment the player used the look-around the file's own docstring advertises, it was a hangar with a stove in it. Nothing about the card was the problem until the room behind it was a room |
| "Performance is an issue" and **no subsystem ablation changes anything** | Some subsystem is heavy; or the renderer is not the pacer at all | **The panel is 144 Hz and the frame sat BETWEEN vsync rungs.** The scene really was the cost (15.3 ms of a 23.5 ms frame, floor 8.2), so the ablations were aimed correctly — but no single one of them moved the frame across a rung, and only crossing a rung is visible. Underneath it, the controller was aiming at 16.67 ms, which is not a frame time a 144 Hz display can present. Found by measuring the FLOOR (empty scene, no sim, 25% resolution) against the shipped frame; `pnpm dev` → `` ` `` → `D` |
| A solid object in the hut appears to hang in mid-air | Its Y coordinate; then the camera's depression angle | **Inside-out winding.** See the interface hazard below — you were seeing the box's interior floor. Two of the three diagnoses in this row were made and acted on before anyone magnified the crop |

## Graphics settings — and what they mean for measurement

`src/core/graphics-settings.js` (model: knob registry, presets, localStorage) and
`src/ui/settings.js` (panel: DOM + CSS + input, **Escape** to open). Wired in
`main.js`, exposed as `__harness.settings` / `__harness.settingsUI`.

Four things about it that matter to anyone measuring or capturing:

1. **`auto` is the EMPTY patch.** Not "pick a tier for this machine" — literally
   `{}`. Every knob sits at its shipped default and `applyAll()` writes nothing to
   any subsystem. That is deliberate and load-bearing: it is what keeps a fresh
   profile, and every capture tool in `tools/`, **bit-identical to a build without
   this feature**, so the quality-baseline table stays reproducible. If `auto` ever
   grows real behaviour, every row of that table becomes machine-dependent.
2. **`?gfx=default` bypasses persisted settings entirely.** Use it in any tool that
   must be immune to whatever is in the profile. A stale `low` preset in
   localStorage would silently change screenshots, and the failure is invisible.
3. **The panel never shows an fps counter, on purpose** (trap 8). It reports the
   vsync rung, the ladder, and whether the frame is locked or sitting between
   rungs. Do not add one.
4. **`ultra` is the only preset that turns the adaptive controller OFF**, and it
   selects the top tier of every subsystem — i.e. `ultra` is the look exactly as
   it shipped before any of this was tiered. Measure against `ultra` when you want
   "did I change the image", and against `auto` when you want "what does a player
   get".

The tiers themselves: `postfx.setQuality()`, `terrain.setMeshQuality()`,
`terrain.setShaderQuality()`, `terrain.setShadowRings()`, `sky.setShadowQuality()`.

**The trap that makes a shader tier silently do nothing:**
`customProgramCacheKey` pins ONE key per material instance and three does not
consult `material.defines` when deciding to reuse a compiled program. A tier
change under a fixed key recompiles into the same cache slot and the OLD program
is served, with no symptom. The tier must be part of the key — it is, for the
depth materials too. (For plain `ShaderPass` materials with no cache key override,
`defines` + `needsUpdate` works normally; the asymmetry is the thing to remember.)

Two corrections to earlier beliefs, both verified in r185 source:
- **`receiveShadow` is NOT in the program cache key.** `lights_pars_begin` declares
  it as a `uniform bool` and the renderer pushes `object.receiveShadow` per
  object, so one shared material across all clipmap rings is fine and runtime
  changes work with no recompile. It also saves almost nothing, because
  `USE_SHADOWMAP` is compiled in regardless — unlike `castShadow`, which removes
  real draw calls from the depth pass.
- **`PCFSoftShadowMap` is deprecated and has no shader path.** `WebGLShadowMap`
  rewrites it to `PCFShadowMap` and warns; `shadowMapTypeDefines` has no entry for
  it. `engine.js` claimed it for the whole life of the project while reading back
  type 1. The shipped filter is r185 PCF: 5 Vogel-disk taps of a `sampler2DShadow`,
  IGN-rotated per pixel.

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
- **`resort.js`' hut is built in a LEFT-handed frame, and its primitives were all
  wound inside-out.** The room's axes are `a = (cos yaw, 0, -sin yaw)` and
  `c = (sin yaw, 0, cos yaw)`, so `a x c = (0, -1, 0)` at every yaw — a mirror of
  the world, not a rotation of it. `Bld.box`, `Bld.cyl`'s side and bottom cap, the
  room-frame `BX` helper and the three lamp-shade cones were all wound for a
  right-handed frame, so every box in the hut and in the chair rig was drawn from
  the INSIDE: front faces culled, back faces visible, and `bakeInterior` lighting
  each surface by a normal pointing into the object.
    It shipped for the whole life of the feature because it is nearly invisible on
  a flat-shaded convex box — the silhouette is identical and the far interior face
  is the colour the near exterior one would have been. What exposed it was raising
  `barCam` by 34 cm, which put the coffee machine at 2.5 m and 15 degrees: at that
  angle you can see the box's interior back wall and its inside floor, and the
  machine reads as hanging in the air above the counter. The bug was reported as a
  modelling problem and diagnosed twice as a camera problem before anybody
  magnified it. **If a solid object in that room looks like it is floating, crop
  and magnify it before touching its position.**
    The shell was already working around this: `FACE()` picks whichever winding
  puts the normal on the room's side, and its comment records three walls and the
  floor coming out backwards. That fix never reached the primitives. Two lessons —
  a per-call-site workaround is evidence of a bug one level down, and a shade cone
  needs BOTH windings whatever the handedness is, because you sit under it and the
  surface you see is its inside.
- **The hut's light is baked PER VERTEX, so geometry size is sampling rate.** A
  16 x 23 m room lit by fifteen point lights at its corners is lit at its corners:
  the floor, the walls and the ceiling shipped as one quad each in the long
  direction and the nine new hall pendants lit literally nothing. `SEG = 1.15 m`
  in `buildInterior` is the cut, chosen at a little under half the 3.0 m lamp
  range. Anything large added to that room needs the same treatment, and "the
  lamp isn't working" there is a tessellation question before it is a lighting one.
- **`branding.js`' atlas is SHARED with the hut.** `api.atlas` hands the texture
  and two plate UV rects to `game/resort.js`, which hangs the same marks indoors.
  Two consequences: `resort.dispose()` must not dispose that texture (it would
  take the slope banners with it, and it doesn't), and **anything new painted into
  that atlas must be painted LAST** — `paint()` consumes one `mulberry32` stream in
  a fixed order and the measured tables in `AK_BASE` and `BTM_INK_LIFT` depend on
  it. The canvas is 2048 x 1024 with the left 1024 byte-for-byte the original.
- **three's `packDepthToRGBA` is R-major, not A-major.** Unpacking it backwards
  yields a plausible-looking answer that is ~35 m wrong.
- **`snData.w` (`expo`) is a shared channel.** `snow-material.js` uses it for
  `talus -= expo*0.28`, and `terrain.js` now drives it to 5.0 over the snow park to
  hold the rock mask off 45–50° kicker flanks. A second consumer added without
  checking will find the park saturating it.
- **`renderer.info` is reset at the top of every `renderer.render()`.** The post
  chain calls that a dozen times a frame, so per-frame counters need
  `autoReset = false` — see trap 6.
- **Shared material instances defeat subset ablation.** `terrain.js` creates one
  snow material (`terrain.js:1302`) and assigns that same instance to all nine
  clipmap LOD meshes (`terrain.js:2651`); `scatter.js` shares one instance across
  the chairlift, the chairs, the piste markers and the snow guns. An ablation
  naming any subset silently ablates every other holder, and the two arms then
  agree beautifully and mean nothing. A frame-changed self-check cannot catch it —
  the frame really does change, just not as labelled. `tools/gpu-breakdown.mjs`
  enumerates shared instances at startup and refuses subset entries.
- **A trivial fragment program lets the linker dead-strip the vertex program.**
  "Swap the material for a cheap one" measures fragment *and* an unknown amount of
  vertex cost, because the varyings the vertex shader wrote are now unreferenced.
  It therefore cannot **in principle** answer a tessellation question. So
  `LEVEL_RES` on the outer clipmap rings was **unanswerable by material ablation**
  and needed a geometry A/B:
  two builds with different `LEVEL_RES`. Separate fragment from vertex cost by
  sweeping resolution with the subsystem gutted — fragment cost scales with
  pixels, vertex cost does not.

  **ANSWERED, 2026-08-03, and the answer was "no".** An interleaved A/B of rings
  7+8 at DPR 2 — 802,816 triangles, 404,480 vertices — came out **not resolvable**
  (median 0.6 ms, sign consistency 6/10). The outer rings were a *waste* problem,
  not the fixed-cost lever they were suspected to be. What they actually were:
  **ring 8 could never draw a pixel at all** (near edge 13,107 m against
  `camera.far` 12,000, `frustumCulled = false`), which is 401,408 triangles of
  guaranteed nothing, now deleted with a module-load assertion tying the ring
  count to the far plane. `LEVEL_RES` is a quality tier (`MESH_TIERS`,
  `terrain.setMeshQuality()`); the clipmap is **1.19 M triangles at ultra**, down
  from 1.65 M.

  Two numbers in the old text were wrong and are worth flagging because they were
  quoted repeatedly: **2.63 M was the whole MAIN PASS, not the clipmap** (the
  clipmap was 1.65 M), and hiding rings *6*,7,8 is not the same experiment as
  hiding 7,8 — ring 6 paints 180–330 k pixels and its saving is fragment cost. I
  conflated those two and briefly believed there were 7 ms of outer-ring vertex
  cost. There were not.
- **`engine.js`' adaptive resolution controller must be frozen during any
  measurement.** `gfx.freeze()`/`unfreeze()` bracket a window; `perf.recording`
  freezes it too, but a tool's *settle* window runs before `perf.start()`, and a
  pinned `gfx.setPixelRatio()` was once silently discarded by a step.
- Instrumentation hook: `window.__harness?.perf?.mark(label, n)` is a no-op unless
  recording. Tag ring wraps, chunk re-emits and trench commits with it; then
  `report().marks` contrasts the frame-time tail on marked frames against unmarked
  ones. That is how a periodic hitch gets attributed without quoting an fps number.

## Quality baseline — do not regress these

Four blind reviews against real Steep screenshots and alpine photography scored
74 → 80 → 84 → 85/100. It is **not** AAA and was identified in every pair. These
are the measured wins; check them after any change to the snow or lighting:

**Measure these on `shoot.mjs`' canonical framings at DPR 1 (1600×900) with its
deterministic settle.** The crop rectangles were unrecorded for most of this
project's life, which made the table unfalsifiable — nobody could reproduce a row
to check it, and two separate agents wasted a session measuring arbitrary crops
that read 77–87 L\* against a documented 73.1. Scale a crop by the PNG width
before applying it to a `--dpr 2` capture (trap 4).

| Metric | Value | Shot / crop (`crop=W:H:X:Y`) | Reference |
|---|---|---|---|
| Near-piste sunlit snow L\*/sd | 73.1 / **10.6** | `hero`, `crop=300:120:400:600` | photo 74.8/10.5, Steep 58.3/29.6 |
| Treeline luminance ÷ adjacent snow | 0.36 | `trees` — **unrecorded** | target band 0.25–0.45 |
| Distant conifer band RGB | (43,58,68) | `trees` — **unrecorded** | real Megève (40,55,72) |
| Cast-shadow snow B−R | +21 to +26 | `hero` — **unrecorded** | real photos +24 to +26 |
| Shadowed rock B/R | ≥ 1.58 | `ridge` — **unrecorded** | trades against a blue cast — see below |
| Sky bluest-decile B/R | 2.63–3.50 **— DISPUTED, see below** | `hero`, bluest decile by B/R — **unrecorded** | photos 2.07–3.68, Steep 2.17 |
| Carve edge ÷ inclination | 1.23, angulation 25–33° | `closeup` — **unrecorded** | reviewed as better than either game reference |

The near-piste sd is restated from the original **12.6 to 10.6** (DPR 1; it reads
11.7 at DPR 2). The rectangle is right — two agents independently measured 73.6
and 74.1 L\* on it against the documented 73.1 — but the build has gained
buildings, a T-bar and nine sponsor boards since the baseline, and an sd recorded
against different content is a phantom regression waiting for the next agent.
Re-measured after the hut and branding work of this pass: **74.1 L\* / sd 10.6**
on that rectangle, i.e. the sd is unmoved and the mean is the higher of the two
independent readings already recorded.
**If you fill in one of the unrecorded rows, restate its value from the same
measurement rather than assuming the old number still describes this build.**

**The near-piste row now has a reproducible method, and it holds.** CIE L\* (not
ffmpeg's `signalstats` luma, which is a different quantity and will not match this
table), over `hero crop=300:120:400:600` at DPR 1, asserting the PNG is 1600 wide
first. Measured 2026-08-03 across the performance pass: **74.04 L\* / sd 10.54**,
against **74.11 / 10.50** on a worktree at the commit before it. Unmoved.

**The sky bluest-decile row is DISPUTED and the number is probably the method.**
Read as "bluest decile of B/R over the whole frame, pixels with R > 8", `hero` at
DPR 1 measures **2.19** — outside the documented 2.63–3.50 band but inside the
photo range. Crucially it measures **2.191 before a change set and 2.195 after**,
i.e. the shortfall is pre-existing and no change caused it. Either the row was
recorded from a different selection (a sky-only crop rather than the whole frame
would exclude blue-ish shadowed snow and read higher) or it has drifted
unnoticed. **Do not "fix" the sky to chase 2.63 until the method is pinned down**
— and this is the second time an unrecorded row has nearly been reported as a
regression by someone measuring it a reasonable way. That is what the unrecorded
rows cost.

The general lesson, stated once: **to claim a metric did not regress, measure the
SAME metric the SAME way on a worktree at the previous commit.** `git worktree add
<dir> <ref>` plus a symlinked `node_modules` takes about a minute, and it is the
only thing that distinguishes "my change broke this" from "this metric never read
what the table says".

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
4. Snow-on-rock mask still dithers at pixel scale in the far field. The far-field
   DOF blur was partly masking this and is now capped at 2 device px, so it may
   read slightly stronger than it used to at DPR 2.
7. **Known-and-measured performance work left on the table**, in value order.
   None of it is speculative — each was measured or derived during the
   2026-08-03 pass and then not taken:
   - **`latNoiseV` exists and is unused.** A value-only noise variant (no
     Jacobian, ~45% cheaper per octave) is defined in `snow-material.js` but no
     call site uses it yet. Roughly a third of the ~42 octaves a near-piste
     fragment runs discard the gradient entirely — wind fields, gate predicates,
     colour variation. Worth an estimated −1.0 to −1.8 ms. **Do not convert
     `mw1`/`mw2`: they look value-only but the next line uses `.y` as a warp
     vector.**
   - **Per-ring shader program variants.** Rings 0–2 can never satisfy
     `mMix = smoothstep(240, 620, dist)`, so the whole fragment refine block —
     16 RGBA32F fetches, ~27 noise octaves, `terrCliff`, an `atan` — is dead code
     the register allocator still budgets for. Rings 6+ can never satisfy
     `pisteAmt`, so the entire corduroy and traffic block is dead there.
     Compiling those out per ring band is **bit-exact**. Blocked on the shared
     material instance (one instance across all rings) — needs a variant per band,
     which collides with the shared-instance ablation hazard above.
   - **The skier's shadow proxy**: 351 of 532 draw calls, see trap 6.
   - **`terrMacro` past the baked square is provably constant.** Outside
     ±4096 m every one of its 16 `texelFetch`es clamps to the same edge texels of
     the −42 m taper plain, so the bicubic returns a constant with zero gradient
     and `terrBackdrop` supplies the real surface. A radius test that skips the
     whole reconstruction out there is **exact**, and it covers most of the outer
     rings' vertices.
   - **Spray submits 34,000 instances with ~433 alive** (136,000 wasted vertex
     invocations/frame). Note the trap: instancing renders 0..n-1, so a ring
     buffer can only ever trim the top, which averages ~50% and not 99%. Doing
     this properly means a free list that keeps live particles compacted near 0.
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
