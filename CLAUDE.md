# CLAUDE.md — Alpine ski simulator

Read this before touching anything. Every item below cost at least one wasted
round of work to learn. `ARCHITECTURE.md` has the module contracts; `README.md`
is the human-facing overview.

## The project in one paragraph

Third-person ski simulator in Three.js r185. **`three` is the only dependency and
almost nothing is a binary asset** — every mesh, texture, shader and sound is
generated in code. That constraint is deliberate; do not add a dependency or
download an asset to solve a problem. Anything under `three/addons/` is fair game.
Runs at 1600×900, ~60 fps.

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

## Measurement traps — all eight produced confident, wrong answers

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
   quad. True figure is **531 draw calls/frame** on the snow (527 before the slope branding went from four objects to nine) and **222 inside the hut**. Anyone who profiles draw calls
   without knowing this concludes the scene is trivially cheap.
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
| "The performance is lagging a bit" | CPU cost, the post chain, draw calls, shadow maps, or the 527-call scene being too complex | **Fragment cost at DPR 2, and almost all of it one shader.** CPU is 0.4 ms update + 1.1 ms submit out of a 34 ms frame. Ablating every scene material returns the interval to the 16.70 ms vsync lock; the terrain snow shader alone is **well over half** of scene shading cost — **≥14.4 ms (censored by the vsync floor) against 3.6–8.3 ms for the entire rest of the scene**, measured with complement arms, 2/2 pairs. No post pass, no shadow pass and no CPU subsystem is measurable against it. The lever is pixels, not passes |
| "The hut UI experience is weak" | The card's typography, the seated framing, or the lighting | **The room.** `buildings[0]`'s `w`/`d` are HALF-extents, so the enterable hall is **16.2 x 23.2 m — 374 m of floor — and it had two tables in it.** The seated shot was always fine; the moment the player used the look-around the file's own docstring advertises, it was a hangar with a stove in it. Nothing about the card was the problem until the room behind it was a room |
| "Performance is an issue" and **no subsystem ablation changes anything** | Some subsystem is heavy; or the renderer is not the pacer at all | **The panel is 144 Hz and the frame sat BETWEEN vsync rungs.** The scene really was the cost (15.3 ms of a 23.5 ms frame, floor 8.2), so the ablations were aimed correctly — but no single one of them moved the frame across a rung, and only crossing a rung is visible. Underneath it, the controller was aiming at 16.67 ms, which is not a frame time a 144 Hz display can present. Found by measuring the FLOOR (empty scene, no sim, 25% resolution) against the shipped frame; `pnpm dev` → `` ` `` → `D` |
| A solid object in the hut appears to hang in mid-air | Its Y coordinate; then the camera's depression angle | **Inside-out winding.** See the interface hazard below — you were seeing the box's interior floor. Two of the three diagnoses in this row were made and acted on before anyone magnified the crop |

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
  `LEVEL_RES = 512` on the outer three clipmap rings (1.28 M of 2.63 M triangles,
  originally justified with a DPR-1 fps number, which traps 1 and 5 both
  invalidate) is **unanswerable by material ablation** and needs a geometry A/B:
  two builds with different `LEVEL_RES`. Separate fragment from vertex cost by
  sweeping resolution with the subsystem gutted — fragment cost scales with
  pixels, vertex cost does not.
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
| Sky bluest-decile B/R | 2.63–3.50 | `hero`, bluest decile by B/R — **unrecorded** | photos 2.07–3.68, Steep 2.17 |
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
