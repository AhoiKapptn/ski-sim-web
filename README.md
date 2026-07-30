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
node tools/shoot.mjs --out shots/x [--only hero,ridge] [--perf]   # capture; exits non-zero on error/blank
node tools/contact-sheet.mjs shots/x shots/x/sheet.png            # tile a run
node tools/contact-sheet.mjs --ab a.png b.jpg out.png             # unlabelled A/B pair
node tools/flyby.mjs --out run.mp4 --seconds 10 --fps 30          # scripted run → video
```

`tools/shoot.mjs` spawns its own Vite server and headless Chrome, so nothing
needs to be running first. Exit 0 means it genuinely rendered.

## Read this before measuring anything

`ARCHITECTURE.md` documents the module contracts and — importantly — several
measurement traps that produced confident, wrong answers during development:
`--perf` absolute numbers, `visible=false` ablations, stepped-harness profiling,
and crops contaminated by sky. Each of them cost a round of work.

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
