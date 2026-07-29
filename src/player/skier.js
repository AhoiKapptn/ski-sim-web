import * as THREE from "three";

/** STUB — owner replaces entirely. Skier rig + procedural animation. */
export function createSkier(scene) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 1.0, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0xd8402f, roughness: 0.5 })
  );
  body.position.y = 0.95;
  body.castShadow = true;
  group.add(body);
  scene.add(group);
  return {
    group,
    update(dt, state) {
      group.position.copy(state.pos);
      group.rotation.set(state.pitch, state.heading, state.roll, "YXZ");
    },
  };
}
