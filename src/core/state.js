import * as THREE from 'three';

/** The single mutable frame state threaded through every subsystem. */
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
    input: { steer: 0, crouch: 0, jump: false, brake: 0 },
  };
}
