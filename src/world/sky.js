import * as THREE from 'three';

/** STUB — owner replaces entirely. Sky dome, sun, atmosphere, IBL, clouds. */
export function createSky(scene, renderer) {
  scene.background = new THREE.Color(0x9dc4ea);
  scene.fog = new THREE.FogExp2(0xbcd2ea, 0.00075);

  const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
  sun.position.set(-420, 620, 380);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera;
  c.near = 1; c.far = 2200; c.left = -600; c.right = 600; c.top = 600; c.bottom = -600;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xbcd8ff, 0xdfe8f5, 1.1));

  return { sun, setTimeOfDay() {}, update(dt, state) {} };
}
