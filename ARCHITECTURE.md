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
| `input` | object | controls | `{steer,crouch,jump,brake,action,actionPressed,pick}` |
| `mode` | string | resort | `'ski' \| 'lift' \| 'drag' \| 'hut'` — see below |
| `modeT` | number | resort | seconds since the mode was entered |
| `prompt` | object\|null | resort | contact prompt `{key,text,sub,ready}` |
| `ride` | object\|null | resort | `{kind,name,s,total,progress,speed,lapse,hint,option}` |
| `hut` | object\|null | resort | `{name,choices,drink,served,run,hint}` |
| `warmth` | 0..1 | resort | drains while skiing, refilled by a hot drink |
| `run` | object | resort | live maxima `{top,bestAir}` for the current run |
| `runs` | array | resort | one entry per drink taken, with the run it closed |
| `veil` | 0..1 | resort | screen dip through a door or a skipped ride |
| `glow` | 0..1 | resort | warm flash on the first sip |

### `state.mode` — the one authority on "is the player skiing?"

Riding the chair, riding the T-bar and sitting in the hut are the same statement,
and every subsystem has to agree about it in the same frame. `game/resort.js`
writes `mode`; nothing else may. `main.js` reads it and branches ONCE:

| mode | physics | chaseCam | camera driven by | skier rig | tracks/spray |
|---|---|---|---|---|---|
| `ski` | yes | yes | `chaseCam` | visible | yes |
| `drag` | **no** | yes | `chaseCam` | visible | yes — a T-bar lane really is tracked up |
| `lift` | **no** | no | `resort.updateCamera()` | hidden | no |
| `hut` | **no** | no | `resort.updateCamera()` | hidden | no |

Physics is *suspended*, never fought: while a ride runs, `resort` owns `pos`,
`vel`, `speed`, `heading` and `groundNormal`, and `physics.update()` is not
called at all (`SkiPhysics.update` also returns early on a non-`ski` mode, as a
guard against a second caller). Handing control back is a `physics.reset()`,
which is the same path `harness.setPlayer()` uses.

`tracks` is skipped in `lift`/`hut` because it draws a ribbon between last
frame's contact point and this one's, and a chair twenty metres up would paint a
carve trench along the whole piste.

### The ride clock

Two rules, both of which have bitten:

- **The ride integrates the RAW dt, not the clamped one.** `resort.update` clamps
  dt to 0.1 for its eases and springs, but `scatter.update` clamps nothing and
  advances the other chairs at `dt * 4.6`. Clamping before advancing `rideS`
  desynchronised the two for any caller stepping in coarse slices: measured,
  `harness.step(0.25)` × 40 moved the player 18.35 m while scatter moved 46 m.
  Not reachable live — `main.js` clamps to 0.05 first — but reachable from every
  tool in `tools/`. It is now 46.00 m against 46 m.
- **The chairlift runs the middle of a ride as a timelapse**, up to 8×, real time
  for the first 92 m and the last 78 m of the leg. `resort.timeScale` publishes
  the factor and `main.js` multiplies **scatter's** dt by it — and nothing
  else's. That is not decoration: the entire reason `CHAIR_SPEED` copies
  scatter's 4.6 is to stay in phase with the chairs coming the other way, and
  compressing one clock and not the other would throw it away. Measured drift at
  full lapse: 0.07 m over 800 m.

The chairlift's default destination is the **mid-station**, which is where the
restaurant is; staying on for the summit is offered as a prompt on the approach.
A full-line ride is 152 s against the 867 s it would be at literal line speed.

Forcing a mode from the harness (this is how the feature gets screenshot):

```js
harness.debug.resort.enter('lift', { at: 'mid', progress: 0.35 })
harness.debug.resort.enter('lift', { to: 'summit' })       // the full line, not the mid leg
harness.debug.resort.enter('lift', { instant: false })     // keep the boarding move
harness.debug.resort.enter('drag', { progress: 0.45 })
harness.debug.resort.enter('hut',  { drink: 'beer' })
harness.debug.resort.enter('hut',  { drink: 'beer', beat: true })  // play the trip to the bar
harness.debug.resort.enter('ski')
harness.debug.resort.goto('chair-mid' | 'chair-bottom' | 'tbar' | 'hut')  // park next to it
harness.debug.resort.info()                                              // ride + placement state

`enter()` and `goto()` publish `state.mode` themselves, so a tool may read it in
the same tick. Both hand the player back STATIONARY: `physics.reset` is a
deliberate flying start and stepping off a lift is not one.
```

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
| `world/draglift.js` | `createDragLift(scene, terrain, {towers})` | the T-bar: pylons, rope, circulating bars, stations. Places itself off `scatter.lift.towers[]` so it never re-derives the corridor |
| `game/resort.js` | `createResort({...})` | the mode machine: boarding zones, the chair and T-bar rides, the hut interior, and every camera that is not `chaseCam` |
| `world/branding.js` | `createBranding(scene, terrain, scatter)` | slope-side sponsor banners and boards at the piste edge — two BTM, two AhoiKapptn!, one merged geometry and one atlas, so the whole set is one draw call. Reads placement off scatter's public seam rather than re-deriving the corridor. Ships **the only binary assets in the repo** (`public/brand/*.png`), a scoped exception documented in the file header. Returns `ready`, which resolves once those PNGs are composited into the atlas; the group stays `visible = false` until then, so a capture taken too early contains *nothing* rather than silently containing the procedural fallback |
| `player/skier.js` | `createSkier(scene)` | skier mesh/rig + procedural animation from `state` |
| `player/physics.js` | `class SkiPhysics` | carving dynamics, edges, air, landings |
| `player/controls.js` | `createControls()` | keyboard/gamepad → `state.input` |
| `player/camera.js` | `createChaseCam(camera)` | third-person camera, spring damping, speed FOV, shake |
| `fx/spray.js` | `createSpray(scene)` | GPU snow spray off the edges, powder plumes |
| `fx/tracks.js` | `createTracks(scene, terrain)` | persistent carve trenches written to a render target |
| `fx/postfx.js` | `createPostFX(renderer, scene, camera)` | bloom, DOF, motion blur, grade, grain, vignette |
| `audio/audio.js` | `createAudio()` | procedural WebAudio: carve, wind, impacts. No audio files |
| `ui/hud.js` | `createHUD()` | speed, air time, run stats. Diegetic, restrained |

### The placement seam

Anything that has to put the PLAYER where the world already has geometry reads
the placement from `scatter`, never from a second copy of the maths:

- `scatter.lift.towers[]` — `{x,z,g,h,top,topY,yaw,perpX,perpZ,armL,armR}`
- `scatter.lift.cables[]` — `{pts,cum,total,dir}`, arc length increasing uphill,
  `dir:+1` the uphill side. These are the samples the chairs ride.
- `scatter.buildings[]` — `{x,z,yaw,w,d,h,roofH,deck?,floorY}`, `w`/`d` HALF
  extents across/along the ridge, `floorY` the deck level.

`resort.js` rides `cables[1]` and builds its interior inside `buildings[0]`;
`draglift.js` interpolates `towers[]` for its own line. A second copy of
`corridorX0()` or of the cable catenary is the ambiguous seam that has broken
every integration in this repo — see CLAUDE.md.

Every module returns an object with `update(dt, state)`. `postfx` also exposes
`render(dt)` and `setSize(w,h)`; if post-processing is active, `main.js` calls
`postfx.render()` instead of `renderer.render()`.

## Visual verification

```bash
node tools/shoot.mjs --out shots/mine            # 5 canonical framings
node tools/resort-shots.mjs shots/mine-resort    # 24 framings of the resort loop
node tools/resort-flow.mjs                       # the mode machine, driven through state.input only
node tools/probe.mjs "return h.debug.resort.info()"   # any measurement, headless
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
