/** STUB — owner replaces entirely. Keyboard + gamepad. */
export function createControls() {
  const keys = Object.create(null);
  addEventListener("keydown", (e) => { keys[e.code] = true; });
  addEventListener("keyup", (e) => { keys[e.code] = false; });
  return {
    update(dt, state) {
      const i = state.input;
      i.steer = (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
      i.crouch = keys.ShiftLeft || keys.KeyS || keys.ArrowDown ? 1 : 0;
      i.brake = keys.Space ? 1 : 0;
      i.jump = !!keys.KeyW || !!keys.ArrowUp;
    },
  };
}
