# Alpine — architecture & module contracts

Third-person ski simulator in Three.js. Target: AAA-grade visuals at 60 fps, 1600×900.

## Hard rules for every contributor

1. **Own only your files.** Never edit `src/main.js`, `tools/shoot.mjs`, or another
   module's file. Integration is done by the lead.
2. **Never break the harness.** `window.__harness` must keep working:
   `ready`, `frames`, `setPlayer(x,z,heading)`, `step(dt,n)`, `stats()`.
   `node tools/shoot.mjs --out shots/<yourname>` must exit 0.
3. **No new runtime dependencies** without asking. `three` only. Everything —
   textures, normal maps, meshes, audio — is generated procedurally in code.
   There are no binary art assets in this project and none may be downloaded.
4. **60 fps budget at 1600×900** on Apple M5 Pro. Check with `--perf`.
5. Prefer `three/addons/...` (ships with the `three` package) over hand-rolling
   post-processing passes, noise, or loaders.

## Shared state object

A single mutable `state` (see `src/core/state.js`) is threaded through every
subsystem each frame. Read what you need; only the owner writes each field.

| field | type | written by | meaning |
|---|---|---|---|
| `pos` | Vector3 | physics | skier world position (on snow surface) |
| `vel` | Vector3 | physics | world velocity, m/s |
| `speed` | number | physics | `vel.length()` |
| `heading` | number | physics | yaw, radians |
| `pitch`,`roll` | number | physics | body orientation to slope |
| `edge` | number | physics | −1..1 signed edge/carve angle |
| `carving` | bool | physics | edges biting (spray + audio trigger) |
| `airborne` | bool | physics | off the ground |
| `groundNormal` | Vector3 | physics | surface normal under skier |
| `crouch` | 0..1 | physics | tuck amount |
| `gForce` | number | physics | lateral load, drives spray volume + cam shake |
| `airTime`,`distance`,`time` | number | physics | run stats for HUD |
| `input` | object | controls | `{steer,crouch,jump,brake}` |

## Modules

| file | export | responsibility |
|---|---|---|
| `world/sky.js` | `createSky(scene, renderer)` | sky dome, sun, atmosphere, IBL env, time of day, clouds |
| `world/terrain.js` | `class Terrain` | heightfield + LOD mesh. `height(x,z)`/`normal(x,z)` are authoritative for physics |

### `Terrain.normal(x, z, third)` — two call conventions

Both are in use and both must keep working; an integration broke once because
only one was implemented.

- `normal(x, z, outVec3)` — analytic gradient written into the caller's vector.
- `normal(x, z, epsilon)` — normal finite-differenced over a footprint of that
  radius. The physics passes `1.6`–`2.2` so metre-scale surface noise doesn't
  jitter the skier's orientation.

Dispatch on `typeof third === 'number'`.

| `world/snow-material.js` | `createSnowMaterial(opts)` | the snow shader: sparkle, sheen, subsurface, wind ripples |
| `world/scatter.js` | `createScatter(scene, terrain)` | instanced trees, rocks, lift towers, gates, fences |
| `player/skier.js` | `createSkier(scene)` | skier mesh/rig + procedural animation from `state` |
| `player/physics.js` | `class SkiPhysics` | carving dynamics, edges, air, landings |
| `player/controls.js` | `createControls()` | keyboard/gamepad → `state.input` |
| `player/camera.js` | `createChaseCam(camera)` | third-person camera, spring damping, speed FOV, shake |
| `fx/spray.js` | `createSpray(scene)` | GPU snow spray off the edges, powder plumes |
| `fx/tracks.js` | `createTracks(scene, terrain)` | persistent carve trenches written to a render target |
| `fx/postfx.js` | `createPostFX(renderer, scene, camera)` | bloom, DOF, motion blur, grade, grain, vignette |
| `audio/audio.js` | `createAudio()` | procedural WebAudio: carve, wind, impacts. No audio files |
| `ui/hud.js` | `createHUD()` | speed, air time, run stats. Diegetic, restrained |

Every module returns an object with `update(dt, state)`. `postfx` also exposes
`render(dt)` and `setSize(w,h)`; if post-processing is active, `main.js` calls
`postfx.render()` instead of `renderer.render()`.

## Visual verification

```bash
node tools/shoot.mjs --out shots/mine            # 5 canonical framings
node tools/shoot.mjs --out shots/mine --only hero --w 1920 --h 1080
node tools/shoot.mjs --out shots/mine --perf     # fps
```

Exit code 0 means it actually rendered (no console errors, no blank frames).
Then **look at the PNGs with the Read tool** — never claim a visual result you
have not looked at.

## Measuring frame rate: only interleaved A/B is trustworthy

`--perf` reports the free-running rAF rate, and headless Chrome mode-locks to
whole divisions of the refresh rate depending on machine load at launch. The
*same unmodified build* has measured 60, 54 and exactly 30.0 fps within an hour.
Absolute readings therefore prove nothing, and four consecutive matching numbers
prove nothing either — that is the compositor holding one mode, not evidence of
frame cost. A reading of exactly 30.0 is a vsync half-rate lock, never a
regression.

To compare two versions, **alternate them within one session** and compare pairs:
run A, B, A, B… and look at the per-pair difference, or switch the two variants
inside a single page every second or so. Take min-of-N, not mean.

Two ablation traps that have produced confident wrong answers here:

- `harness.step()` in a loop does not measure the real frame. It once reported
  8.4 ms/frame (≈119 fps) for a build measuring 54 fps, and claimed disabling
  post-processing made the frame *slower*.
- `visible = false` ablations lie whenever hiding an object exposes what is
  behind it. Hiding the near trees made a frame **22 ms slower**, because sky and
  distant terrain then had to be shaded.

## Never use `git stash` in an agent worktree

`git stash` is a single ref shared by every worktree of the repo. Two agents
stashing concurrently cross the LIFO stack and each pops the other's work. This
has already nearly destroyed a module. Commit on the worktree branch instead.
