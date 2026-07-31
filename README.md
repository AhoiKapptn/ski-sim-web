# Alpine — a third-person ski simulator in Three.js

Everything you see is generated in code. There are no binary art assets in this
repository: no models, no textures, no audio files. `three` is the only runtime
dependency. It runs in a browser at 1600×900.

```bash
pnpm install
pnpm dev            # http://127.0.0.1:5199
```

Controls: **A/D** or **←/→** steer · **S/↓** or **Shift** tuck · **W/↑** pop ·
**Space** brake. Gamepad supported.

## What's in it

| Area | |
|---|---|
| Terrain | Geometry-clipmap heightfield, 10 levels, 0.4 m → 205 m cells, ~19 km. Ridge-network massif with cirques, aretes, bedding planes, thermal + flow erosion. CPU and GPU share one reconstruction, so physics and render can't drift apart |
| Snow | Custom shader: subsurface scatter, anisotropic sheen, sastrugi, ice sparkle, grooming corduroy, wind slab, triplanar rock blend |
| Sky | Preetham atmosphere, PMREM IBL, three cloud populations with vertical development, height + aerial-perspective fog with Henyey-Greenstein scattering |
| Shadows | Two cascades — 330 m far, 14 m near at 1.37 cm/texel — merged in a patched `lights_fragment_begin`, plus analytic contact occlusion |
| Physics | Real carving: turn radius from sidecut and edge angle, so a clean carve conserves speed and a skid scrubs it. Substepped at 120 Hz |
| Character | Lofted parametric garments with procedural fabric, rucksack, boot hardware, mirrored goggles. Procedural animation — angulation, absorption, pole plants, airborne phases |
| FX | GPU spray with soft-particle depth fade, persistent carve trenches driven by normals/AO rather than dark decals |
| World | Instanced conifer forests with treeline gradient, chairlift, other skiers, lodges, snow guns, piste furniture |
| Audio | Fully procedural WebAudio — carve, wind, impacts, convolution reverb from a generated impulse response |

## Tools

```bash
node tools/shoot.mjs --out shots/x [--only hero,ridge] [--dpr 2] [--perf]  # capture; non-zero on error/blank
node tools/contact-sheet.mjs shots/x shots/x/sheet.png            # tile a run
node tools/contact-sheet.mjs --ab a.png b.jpg out.png             # unlabelled A/B pair
node tools/flyby.mjs --out run.mp4 --seconds 10 --fps 30          # scripted run → video
node tools/frametime.mjs --seconds 15 [--dpr 2] [--prod]          # frame-time tail + spike attribution
node tools/perf-ab.mjs --preset dpr                               # interleaved A/B, one page session
```

`tools/shoot.mjs` spawns its own Vite server and headless Chrome, so nothing
needs to be running first. Exit 0 means it genuinely rendered.

## Measuring frame cost

Two tools, because "what is spiking?" and "is A faster than B?" are different
questions and the same number cannot answer both.

**`tools/frametime.mjs`** — one build, a fixed scripted *carving* run, and a
per-frame histogram recorded from the real `requestAnimationFrame` loop via
`window.__harness.perf`. Reports p50/p95/p99/max of the presented interval, the
count of frames over 20/33/50 ms, per-subsystem CPU ms, named shader-link
events, and every spike with its attribution (draw calls, geometry/texture
uploads, program-cache growth, subsystem breakdown). Stalls are a *tail*
statistic: the vsync mode lock corrupts means but not tails, because a 40 ms
frame is 40 ms whatever mode the compositor is holding.

```bash
node tools/frametime.mjs --seconds 15                  # dev server, DPR 1
node tools/frametime.mjs --seconds 20 --dpr 2          # the Retina backbuffer
node tools/frametime.mjs --prod                        # built bundle, dev-only branches stripped
node tools/frametime.mjs --straight                    # coast, for contrast
```

**`tools/perf-ab.mjs`** — the only trustworthy way to compare two variants. It
alternates them **inside one page session** in balanced ABBA order and reports
per-pair deltas, min-of-N and a sign test. Absolute levels across two process
launches are worthless (see the traps below); paired deltas within one session
are not.

```bash
node tools/perf-ab.mjs --preset dpr --cycles 3         # 1.44 vs 5.76 Mpx
node tools/perf-ab.mjs --preset rscale --dpr 2         # 0.75x vs full resolution
node tools/perf-ab.mjs --a "d.postfx.params.bloom.enabled=false" \
                       --b "d.postfx.params.bloom.enabled=true" \
                       --label-a "bloom off" --label-b "bloom on"
```

Variants are plain JavaScript evaluated in the page against `h` =
`window.__harness` and `d` = `harness.debug`, so you can A/B your own knob
without editing the tool. Presets: `dpr, rscale, aa, postfx, taa, bloom, dof`.

Runtime knobs the tools drive, also usable by hand as query params:
`?rscale=0.75` (render at 75% linear resolution and let the film-pass sharpen
carry it), `?maxdpr=1`, `?aa=1` (restore the multisampled default framebuffer,
which is off because the post chain owns anti-aliasing).

## Read this before measuring anything

`ARCHITECTURE.md` documents the module contracts and `CLAUDE.md` the measurement
traps that produced confident, wrong answers during development: `--perf`
absolute numbers, `visible=false` ablations, stepped-harness profiling, and crops
contaminated by sky. Each of them cost a round of work. Three more, learned
while building the tools above:

1. **`shoot.mjs --perf` measures a nearly stationary player at DPR 1.** It counts
   vsync-presented frames over 4 s, so it can only report ~60 or ~30 — it tells
   you which mode the compositor is holding, never the margin. And it renders
   1600×900 = 1.44 Mpx while a Retina machine renders 3200×1800 = 5.76 Mpx, with
   every post-processing render target sized from the drawing buffer. It can
   therefore see neither motion-dependent cost (spray, tracks, camera shake, the
   g-force paths) nor fragment-bound cost. Use `--dpr 2`, and use the two tools
   above for anything quantitative.
2. **The GPU timer query's absolute value is ~2.5× reality.**
   `EXT_disjoint_timer_query_webgl2` *is* available on this ANGLE/Metal path and
   it tracks load faithfully — across a 1×/2× backbuffer A/B it scaled 2.00×
   where the presented interval scaled 1.85× — but ANGLE derives it from
   command-buffer timestamps that include queue and scheduling gaps, so it reads
   higher than the presented frame interval, which is impossible for real GPU
   busy time. It is valid only as a **ratio between the two arms of one A/B**.
   Never quote it as "the frame took N ms on the GPU".
3. **`renderer.info.autoReset` must be forced off or `info.render.calls` reads 1
   instead of 527.** three resets `info.render` at the top of *every*
   `renderer.render()` call, and the post chain makes about a dozen per frame, so
   reading the counter after the frame reports the final fullscreen quad and
   nothing else. `harness.perf` takes manual control while recording and calls
   `info.reset()` once per frame; anything else that reads those counters must do
   the same or it is measuring one pass.

## Quality

Judged by four independent blind reviews against real Steep screenshots and
alpine photography, scoring 74 → 80 → 84 → 85 / 100. It is not mistakable for a
shipped AAA title; the reviews identified it every time. It measurably beats
Steep on near-piste snow micro-contrast and sits inside the photographic envelope
there, and the reviews rated the player model and foreground conifers at or above
Steep's equivalents.

The largest remaining gap is that the massif has no self-shadowing or ambient
occlusion — real rock is dark in its own gullies — and that its form has one
scale rather than the four or five a real range has.
