/**
 * One framing, every quality tier, in ONE page session.
 *
 *   node tools/tier-shots.mjs --out shots/tiers --only ridge,hero
 *   node tools/tier-shots.mjs --out shots/tiers --knob mesh     # mesh tiers only
 *
 * WHY THIS EXISTS RATHER THAN `shoot.mjs` FOUR TIMES: a tier is applied at
 * runtime, and cross-session captures of this project are not comparable —
 * rider positions, spray and wind state are not reproducible across sessions
 * and TAA leaks ~22% of the current frame even with the sim frozen, so two
 * separate `shoot.mjs` runs of the SAME build differ by as much as 17.8 dB
 * PSNR. Everything here is captured inside one session with the sim frozen, so
 * the only difference between two images is the tier.
 *
 * The thing this is really for: a mesh tier changes the clipmap's OUTER EXTENT,
 * and the clipmap has to cover `camera.far` = 12000 m or the far ranges are
 * replaced by a wedge of sky. At the shipped `ultra` ring 7 reaches 12,288 m;
 * the lower tiers reach 8,192 and 6,554. Whether that reads as "less distant
 * detail" or as "the mountains are missing" is not something a triangle count
 * can answer, so look at `ridge`.
 */
import { startServer, launch, boot, makeArgs, sleep, STARTS } from './frametime.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const { arg, num, flag } = makeArgs();
const opts = {
  out: arg('out', 'shots/tiers'),
  only: (arg('only', 'ridge,hero') || '').split(',').filter(Boolean),
  knob: arg('knob', 'all'),          // 'mesh' | 'shader' | 'postfx' | 'all'
  w: num('w', 1600), h: num('h', 900), dpr: num('dpr', 1),
  settle: num('settle', 90),         // harness.step() count per arm
  prod: flag('prod'),
};
const TIERS = ['low', 'medium', 'high', 'ultra'];

const server = await startServer({ prod: opts.prod, port: 5309 });
const { browser, page, errors } = await launch(opts);
let code = 0;
try {
  const env = await boot(page, server.url);
  console.log(`gpu: ${env.gpu}`);
  console.log(`backbuffer ${env.gfx.drawingBuffer.join('x')} (${env.gfx.megapixels} Mpx)`);
  await fs.mkdir(path.resolve(opts.out), { recursive: true });

  // Freeze everything that could differ between arms: the sim, the resolution
  // controller (boot() already holds gfx.freeze()), and the TAA history.
  await page.evaluate(() => {
    window.__setAuto(false);
    window.__harness.debug.postfx.params.taa.enabled = false;
  });

  const avail = await page.evaluate(() => {
    const d = window.__harness.debug;
    return {
      mesh: typeof d.terrain.setMeshQuality === 'function',
      shader: typeof d.terrain.setShaderQuality === 'function'
        || typeof d.terrain.material?.userData?.setShaderQuality === 'function',
      postfx: typeof d.postfx.setQuality === 'function',
      meshInfo: typeof d.terrain.meshInfo === 'function',
    };
  });
  console.log(`available knobs: ${JSON.stringify(avail)}`);

  for (const shot of opts.only) {
    const [x, z, hd] = STARTS[shot] ?? STARTS.hero;
    for (const tier of TIERS) {
      const info = await page.evaluate((tier, knob, x, z, hd, settle) => {
        const h = window.__harness, d = h.debug;
        if (knob === 'mesh' || knob === 'all') d.terrain.setMeshQuality?.(tier);
        if (knob === 'shader' || knob === 'all') {
          (d.terrain.setShaderQuality
            || d.terrain.material?.userData?.setShaderQuality)?.call(d.terrain, tier);
        }
        if (knob === 'postfx' || knob === 'all') d.postfx.setQuality?.(tier);
        // Re-teleport AFTER the tier change: a clipmap rebuild resets ring
        // positions, and the point is that every arm is the same viewpoint.
        h.setPlayer(x, z, hd);
        for (let i = 0; i < settle; i++) h.step(1 / 60, 1);
        return d.terrain.meshInfo ? d.terrain.meshInfo() : null;
      }, tier, opts.knob, x, z, hd, opts.settle);

      const file = path.resolve(opts.out, `${shot}-${tier}.png`);
      await page.screenshot({ path: file });
      const st = await page.evaluate(() => window.__harness.stats());
      console.log(`  ${shot.padEnd(8)} ${tier.padEnd(7)} mean=${st.mean.toFixed(1)} sd=${st.stddev.toFixed(1)}`
        + (info ? `  tris=${(info.triangles / 1e6).toFixed(3)}M levels=${info.levels} res=[${info.levelRes}]` : '')
        + `  -> ${path.relative(process.cwd(), file)}`);
    }
  }
} catch (e) {
  errors.push('harness: ' + (e?.message ?? String(e)));
  code = 1;
} finally {
  if (errors.length) { code = 1; console.error('\n--- errors ---'); errors.slice(0, 20).forEach((e) => console.error('  ' + e)); }
  await browser.close();
  await server.close();
  process.exit(code);
}
