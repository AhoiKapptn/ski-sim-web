/**
 * In-session correctness probe for the snow-material rock gate.
 *
 *   node tools/rockgate-probe.mjs
 *
 * PASS looks like: floor max 0-2 with over2=0, gate-vs-full max 0-5 with over2
 * a handful of subpixels (float rounding on pixels sitting exactly at the
 * gate's provable-zero boundary). Anything beyond that means the bound in
 * snow-material.js' rock gate no longer covers a talus term — re-derive it.
 *
 * Whole-image diffs across shoot.mjs sessions cannot validate the gate: a
 * same-build repeat of `ridge` measures 17.8 dB PSNR against itself (riders,
 * spray and wind state are not reproducible across sessions). So this probe
 * compares the two arms inside ONE session with the sim frozen (step(0, n)):
 * same world state, same TAA jitter phase (n is a multiple of every jitter
 * cycle length), only uRockGateOff differing. The A1/A2 pair (same arm twice)
 * is the noise floor; A2/B is the gate's effect.
 */
import { startServer, launch, boot, STARTS } from './frametime.mjs';

const srv = await startServer();
const { browser, page } = await launch();
await boot(page, srv.url);

const results = {};
for (const [name, [x, z, heading]] of Object.entries(STARTS)) {
  const r = await page.evaluate(async (x, z, heading) => {
    const h = window.__harness;
    const d = h.debug;
    window.__setAuto(false);
    // TAA's per-frame jitter leaks ~22% of the current frame into every output
    // even with the sim frozen, and it swamped the probe: same-arm repeats
    // differed at max=173/231. SMAA is deterministic; use it for the probe.
    d.postfx.params.taa.enabled = false;
    d.terrain.snowUniforms.uRockGateOff.value = 0;
    h.setPlayer(x, z, heading);
    h.step(1 / 60, 90);                    // settle content, converge TAA

    const gl = d.renderer.getContext();
    const grab = () => {
      h.step(0, 64);                       // 64 = multiple of any jitter cycle
      const w = d.renderer.domElement.width, hh = d.renderer.domElement.height;
      const buf = new Uint8Array(w * hh * 4);
      gl.readPixels(0, 0, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
    const diff = (a, b) => {
      let max = 0, over2 = 0;
      for (let i = 0; i < a.length; i++) {
        const e = Math.abs(a[i] - b[i]);
        if (e > max) max = e;
        if (e > 2) over2++;
      }
      return { max, over2, n: a.length };
    };

    const a1 = grab();
    const a2 = grab();
    d.terrain.snowUniforms.uRockGateOff.value = 1;   // full pipeline everywhere
    const b = grab();
    d.terrain.snowUniforms.uRockGateOff.value = 0;
    return { floor: diff(a1, a2), gate: diff(a2, b) };
  }, x, z, heading);
  results[name] = r;
  console.log(name.padEnd(8),
    `floor max=${r.floor.max} over2=${r.floor.over2}`,
    ` gate-vs-full max=${r.gate.max} over2=${r.gate.over2} (${r.gate.n} samples)`);
}

await browser.close();
await srv.close();
