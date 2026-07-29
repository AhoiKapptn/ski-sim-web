import * as THREE from "three";

/** STUB — owner replaces entirely. The snow shader. */
export function createSnowMaterial(opts = {}) {
  return new THREE.MeshStandardMaterial({ color: 0xeef4ff, roughness: 0.82, metalness: 0.0, ...opts });
}
