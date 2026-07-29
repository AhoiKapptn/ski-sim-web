import * as THREE from 'three';

/** STUB — owner replaces entirely. Carving dynamics, edges, air, landings. */
export class SkiPhysics {
  constructor(terrain) {
    this.terrain = terrain;
  }

  reset(state, x, z, heading) {
    state.pos.set(x, this.terrain.height(x, z), z);
    state.vel.set(0, 0, 0);
    state.heading = heading;
    state.speed = 0;
    state.airTime = 0;
    state.distance = 0;
    state.time = 0;
  }

  update(dt, state) {
    state.heading += state.input.steer * 1.6 * dt;

    const n = this.terrain.normal(state.pos.x, state.pos.z);
    state.groundNormal.copy(n);

    const g = new THREE.Vector3(0, -22, 0);
    const along = g.clone().addScaledVector(n, -g.dot(n));
    state.vel.addScaledVector(along, dt);

    const fwd = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
    const speed = state.vel.length();
    if (speed > 0.1) {
      const dir = state.vel.clone().setY(0).normalize().lerp(fwd, Math.min(1, 3.2 * dt)).normalize();
      state.vel.x = dir.x * speed;
      state.vel.z = dir.z * speed;
    }
    state.vel.multiplyScalar(1 - 0.55 * dt);

    state.pos.addScaledVector(state.vel, dt);
    state.pos.y = this.terrain.height(state.pos.x, state.pos.z);

    state.speed = state.vel.length();
    state.edge = THREE.MathUtils.clamp(state.input.steer, -1, 1);
    state.roll = -state.edge * 0.35;
    state.carving = Math.abs(state.edge) > 0.2 && state.speed > 4;
    state.gForce = Math.abs(state.edge) * state.speed * 0.06;
    state.distance += state.speed * dt;
    state.time += dt;
  }
}
