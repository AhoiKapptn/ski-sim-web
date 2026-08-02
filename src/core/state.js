import * as THREE from 'three';

/**
 * The single mutable frame state threaded through every subsystem.
 *
 * The `mode` block is written by `game/resort.js` and by nothing else. It is the
 * one authority on whether the player is skiing, and main.js reads it to decide
 * whether physics and the chase camera run at all — see ARCHITECTURE.md.
 */
export function createState() {
  return {
    pos: new THREE.Vector3(0, 0, 700),
    vel: new THREE.Vector3(),
    speed: 0,
    heading: Math.PI,
    pitch: 0,
    roll: 0,
    edge: 0,
    carving: false,
    airborne: false,
    groundNormal: new THREE.Vector3(0, 1, 0),
    crouch: 0,
    gForce: 0,
    airTime: 0,
    distance: 0,
    time: 0,
    input: {
      steer: 0, crouch: 0, jump: false, brake: 0,
      action: false, actionPressed: false,
      // hut menu channels — see player/controls.js
      pick: 0, navY: 0, confirm: false, confirmPressed: false,
    },

    // ---- resort mode machine (game/resort.js owns every field below) --------
    /** 'ski' | 'lift' | 'drag' | 'hut'. Physics runs only in 'ski'. */
    mode: 'ski',
    /** seconds since the current mode was entered */
    modeT: 0,
    /** contact prompt: { key, text, sub, ready } or null */
    prompt: null,
    /** while on a lift: { kind, name, s, total, progress, speed, hint, canUnload } */
    ride: null,
    /** while inside: { name, choices, drink, served, run, hint } */
    hut: null,
    /** 0..1 — drains while skiing, refilled by a hot drink */
    warmth: 1,
    /** live maxima for the current run: { top, bestAir } */
    run: { top: 0, bestAir: 0 },
    /** completed runs, one entry per drink taken */
    runs: [],
    /** 0..1 screen dip through a doorway or a skipped ride */
    veil: 0,
    /** 0..1 warm flash on the first sip */
    glow: 0,
  };
}
