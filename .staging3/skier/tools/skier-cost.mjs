/**
 * Report what the skier rig actually costs: mesh count, triangles, draw calls.
 * A character that has to survive a 1:1 crop earns geometry, but only if the
 * bill is a number somebody looked at.
 *
 *   node tools/skier-cost.mjs
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 5233, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const b = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage();
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));
const out = await p.evaluate(() => {
  const g = window.__harness.debug.skier.group;
  let tris = 0, meshes = 0, verts = 0;
  const heavy = [];
  g.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const idx = o.geometry.index;
    const t = idx ? idx.count / 3 : o.geometry.attributes.position.count / 3;
    tris += t;
    verts += o.geometry.attributes.position.count;
    heavy.push([t, o.material?.name || (Array.isArray(o.material) ? 'multi' : o.material?.type)]);
  });
  heavy.sort((a, b2) => b2[0] - a[0]);
  const info = window.__harness.debug.renderer.info;
  return {
    meshes, tris, verts, top: heavy.slice(0, 8),
    sceneTris: info.render.triangles, calls: info.render.calls,
    programs: info.programs ? info.programs.length : -1,
    textures: info.memory.textures, geometries: info.memory.geometries,
  };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
await server.close();
process.exit(0);
