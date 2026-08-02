# Alpine — a third-person ski simulator in Three.js

Everything you see is generated in code — no models, no textures, no audio
files — with exactly one exception: the two sponsor logos under `public/brand/`,
which are real brand marks and are the only binary assets in the repository.
`three` is the only runtime dependency. It runs in a browser at 1600×900.

```bash
pnpm install
pnpm dev            # http://127.0.0.1:5199
```

Controls: **A/D** or **←/→** steer · **W/↑**, **S/↓** or **Shift** tuck ·
**Ctrl/X** brake · **Space** pop · **E** use the thing in front of you.
Indoors the same keys become a menu — **W/S** choose, **↵** order, **1–8** jump
straight to a line — and nothing you press at a bar can reach the physics.
Gamepad supported.

There is no "forward" key — gravity is the throttle, so the key that should make
you faster tucks. **Space is a pop, not a jump**: on flat ground its whole
authority is a ~9 cm unweight. Air is earned from terrain. Ski the park —
`terrain.jumps` places a roller, a hip, a step-down and three kickers down the
corridor — and time the pop at the lip to extend it (kicker1: 2.1 s of air
becomes 2.83 s if you hit it right).

## The resort loop

Skiing down is not the whole day. Stop next to something and a prompt appears;
**E** uses it.

| | |
|---|---|
| **The chairlift** | 4 km of real cable with 39 lattice towers. Board at the valley station and it takes you to the mid-station, next to the restaurant; you are asked on the approach whether you want to stay on for the summit. It leaves the station and arrives at the next one in real time at the line's true 4.6 m/s, with the towers going over your head and the down-side chairs passing, and runs the middle as a timelapse — otherwise the full line is fourteen and a half minutes of grey girder. **A/D** look around, **S** looks down at your own ski tips over the footrest, **hold X** to skip the rest. |
| **The T-bar** | A 680 m drag lift up the lower pitch, 30 m off the piste centreline, its pylons standing 2.6 m to the side of the track the way real ones do. You stay on your skis and on the snow with a steel bar under you at 3.4 m/s, which is a different thing from sitting on a chair rather than a second copy of it. Same **hold X** to skip, and no timelapse — you are in third person with your own skis on the snow, and compressing that reads as a bug rather than as elapsed time. |
| **The Bergrestaurant** | Ski up to the mid-mountain restaurant and go in. It is a real Selbstbedienung hall — 16 by 23 metres of it: long communal tables and benches, a serving counter with a tray rail and a pastry case, boots and jackets by the door, bunting between the beams, a stove, and about a dozen other people eating and drinking and standing at the bar. You sit at the window table with the massif in front of you and an **eight-line card**: Kaffee, heisse Schokolade, Glühwein, Jagertee, Gulaschsuppe, Kaiserschmarrn, Weissbier, Radler. **W/S** move the cursor, **↵** orders, **1–8** goes straight to a line. Ordering takes you across to the counter — the machine, the taps, the bottle shelf, the man behind it — and back to your table with the thing on it, steaming if it should be. **A/D** look round the room. A hot line resets your warmth, every order logs the run you just finished, and each one costs you a bit of the afternoon: the sun really does move, and a Kaiserschmarrn costs three times what a coffee does, though it can never take you past the last lift. **E** puts you back on the snow. |

Warmth drains while you are out in it (about eleven minutes of skiing to empty)
and a hot drink refills it. It is a reason to go inside, not a fail state:
nothing breaks at zero.

While you are on a lift or indoors the mode machine in `src/game/resort.js`
suspends the physics and owns the rider — see `state.mode` in ARCHITECTURE.md.

To drop straight into any of it, `pnpm dev` and add a query:

```
?resort=hut                       sitting in the restaurant with the card up
?resort=hut&drink=beer            ...with a Weissbier on the table
?resort=hut&drink=kaiserschmarrn  ...or anything else off the card, by id
?resort=hut&drink=beer&beat=1     ...and play the trip to the counter
?resort=lift&at=mid&progress=0.4  on the chair, 40% of the way up from the mid-station
?resort=drag&progress=0.45        on the T-bar
?resort=tbar                      standing at the T-bar with the prompt up
?resort=chair-mid                 ...or at the mid-station
?resort=lift&to=summit            the full line rather than the mid-station leg
```

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
| Resort loop | Rideable chairlift and T-bar, an enterable mid-mountain restaurant — a furnished hall with thirteen patrons and an eight-line menu — one mode machine driving physics, camera, HUD and audio |
| Branding | Nine sponsor elements at the piste edge — five banners in front of the B-net runs, four A-frame boards — as one merged geometry on one atlas, so the whole set is a single draw call. The same two marks hang inside the hut, printed off the same atlas |
| Audio | Fully procedural WebAudio — carve, wind, impacts, convolution reverb from a generated impulse response |

## Tools

```bash
node tools/shoot.mjs --out shots/x [--only hero,ridge] [--dpr 2] [--perf]  # capture; non-zero on error/blank
node tools/contact-sheet.mjs shots/x shots/x/sheet.png            # tile a run
node tools/contact-sheet.mjs --ab a.png b.jpg out.png             # unlabelled A/B pair
node tools/flyby.mjs --out run.mp4 --seconds 10 --fps 30          # scripted run → video
node tools/frametime.mjs --seconds 15 [--dpr 2] [--prod]          # frame-time tail + spike attribution
node tools/perf-ab.mjs --preset dpr                               # interleaved A/B, one page session
node tools/resort-shots.mjs shots/x                               # the 31 framings of the resort loop
node tools/resort-flow.mjs                                        # drive the mode machine through input only
node tools/probe.mjs "return h.state.mode"                        # boot headless, evaluate against __harness
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
