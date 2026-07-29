/** STUB — owner replaces entirely. Bloom, DOF, motion blur, grade, grain. */
export function createPostFX(renderer, scene, camera) {
  return {
    enabled: false,
    setSize(w, h) {},
    render(dt) { renderer.render(scene, camera); },
    update(dt, state) {},
  };
}
