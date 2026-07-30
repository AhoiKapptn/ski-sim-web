import * as THREE from 'three';
import { createEngine } from './core/engine.js';
import { createState } from './core/state.js';
import { Terrain } from './world/terrain.js';
import { createSky } from './world/sky.js';
import { createScatter } from './world/scatter.js';
import { createSkier } from './player/skier.js';
import { SkiPhysics } from './player/physics.js';
import { createControls } from './player/controls.js';
import { createChaseCam } from './player/camera.js';
import { createSpray } from './fx/spray.js';
import { createTracks } from './fx/tracks.js';
import { createPostFX } from './fx/postfx.js';
import { createAudio } from './audio/audio.js';
import { createHUD } from './ui/hud.js';

const container = document.getElementById('app');
const { renderer, scene, camera } = createEngine(container);

const state = createState();
const terrain = new Terrain();
scene.add(terrain.mesh ?? terrain.group);

const sky = createSky(scene, renderer);
const scatter = createScatter(scene, terrain);
const skier = createSkier(scene);
const physics = new SkiPhysics(terrain);
const controls = createControls();
const chaseCam = createChaseCam(camera);
const spray = createSpray(scene);
const tracks = createTracks(scene, terrain);
const postfx = createPostFX(renderer, scene, camera);
const audio = createAudio();
const hud = createHUD();

physics.reset(state, state.pos.x, state.pos.z, state.heading);

addEventListener('resize', () => postfx.setSize(innerWidth, innerHeight));
addEventListener('pointerdown', () => audio.start(), { once: true });
addEventListener('keydown', () => audio.start(), { once: true });

// Subsystems that need per-frame updates, in dependency order.
const SYSTEMS = [terrain, sky, scatter, skier, spray, tracks, postfx, audio, hud];

function update(dt) {
  controls.update(dt, state);
  // Capture tools (tools/flyby.mjs) drive a scripted run by pinning the input
  // after the live sampler has written it.
  if (harness.__scripted) Object.assign(state.input, harness.__scripted);
  physics.update(dt, state);
  chaseCam.update(dt, state);
  for (const s of SYSTEMS) s.update?.(dt, state);
}

function renderFrame(dt) {
  postfx.render(dt);
}

// --- harness hooks (tools/shoot.mjs depends on these) ------------------------
const harness = {
  ready: false,
  frames: 0,
  state,
  // Live subsystem handles, so diagnostics can measure the scene instead of
  // guessing from pixels (e.g. compare the rig's ski base against terrain
  // height to prove a grounding bug).
  debug: { terrain, sky, scatter, skier, physics, spray, tracks, postfx, chaseCam, camera, scene, renderer },
  setPlayer(x, z, heading = Math.PI) {
    physics.reset(state, x, z, heading);
    controls.update(0, state);
    chaseCam.update(1, state); // snap, don't spring, on teleport
  },
  step(dt = 1 / 60, n = 1) {
    for (let i = 0; i < n; i++) update(dt);
    renderFrame(dt);
  },
  stats() {
    renderFrame(1 / 60);
    const gl = renderer.getContext();
    if (gl.isContextLost()) return { lost: true };
    const w = renderer.domElement.width, h = renderer.domElement.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, sum2 = 0, n = 0;
    for (let i = 0; i < buf.length; i += 4 * 17) {
      const l = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      sum += l; sum2 += l * l; n++;
    }
    const mean = sum / n;
    return { lost: false, mean, stddev: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
  },
};
window.__harness = harness;

let auto = true;
window.__setAuto = (v) => { auto = v; };

// --- loop --------------------------------------------------------------------
let prev = performance.now();
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min((now - prev) / 1000, 0.05);
  prev = now;
  // When paused we still present frames — the capture harness needs a live swap
  // chain to screenshot, it just must not advance the simulation.
  if (auto) update(dt);
  renderFrame(dt);
  harness.frames++;
}
loop();

harness.ready = true;
document.getElementById('boot').classList.add('gone');
