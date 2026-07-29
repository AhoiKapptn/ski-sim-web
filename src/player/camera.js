import * as THREE from "three";

/** STUB — owner replaces entirely. Third-person chase camera. */
export function createChaseCam(camera) {
  const want = new THREE.Vector3();
  return {
    update(dt, state) {
      const fwd = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
      want.copy(state.pos).addScaledVector(fwd, -8.5).add(new THREE.Vector3(0, 3.4, 0));
      camera.position.lerp(want, Math.min(1, 4 * dt));
      camera.lookAt(state.pos.x, state.pos.y + 1.5, state.pos.z);
    },
  };
}
