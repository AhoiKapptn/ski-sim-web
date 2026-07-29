/**
 * Skier rig lab — close framings + numeric grading of the character rig.
 *
 *   node tools/skier-rig.mjs --out shots/rig
 *   node tools/skier-rig.mjs --out shots/rig --only carveL,air
 *
 * Drives real input through window.__inputOverride (so the poses come out of the
 * actual physics, not a fake state), then screenshots a tight crop centred on the
 * skier and dumps window.__skier.measure() for each pose.
 */
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** Minimal PNG encoder — Page.captureScreenshot is unreliable in this headless
 *  setup, so the crop is pulled straight out of the GL framebuffer instead. */
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy ? rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
      : Buffer.from(rgba.slice(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (w * 4 + 1) + 1);
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };

const OUT = path.resolve(ROOT, arg('out', 'shots/rig'));
const W = +arg('w', 1600), H = +arg('h', 900);
const ZOOM = +arg('zoom', 2.6);
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);

/** start = spawn point, then a list of [frames, input] segments. */
const S = [-260, 300, Math.PI * 0.86];     // a spawn with a sustained fall line
const warm = [240, {}];
const POSES = {
  neutral: { start: S, seq: [warm] },
  spotHero: { start: [0, 700, Math.PI], seq: [[90, {}]] },
  spotTrees: { start: [180, 120, Math.PI * 1.1], seq: [[140, {}]] },
  spotSteep: { start: [-40, -260, Math.PI], seq: [[200, {}]] },
  spotClose: { start: [60, 480, Math.PI * 0.95], seq: [[60, {}]] },
  carveL: { start: S, seq: [warm, [55, { steer: 1 }]] },
  carveHold: { start: S, seq: [warm, [90, { steer: 1 }]] },
  carveR: { start: S, seq: [warm, [55, { steer: -1 }]] },
  transit: { start: S, seq: [warm, [55, { steer: 1 }], [11, { steer: -1 }]] },
  tuck: { start: S, seq: [[240, { crouch: 1 }]] },
  pop: { start: S, seq: [warm, [22, { jump: true }], [4, {}]] },
  air: { start: S, seq: [warm, [22, { jump: true }], [22, {}]] },
  apex: { start: S, seq: [warm, [22, { jump: true }], [{ until: 'apex' }]] },
  reach: { start: S, seq: [warm, [22, { jump: true }], [{ until: 'descend' }]] },
  land: { start: S, seq: [warm, [22, { jump: true }], [{ until: 'ground' }], [5, {}]] },
  landDeep: { start: S, seq: [warm, [22, { jump: true }], [{ until: 'ground' }], [11, {}]] },
  landOut: { start: S, seq: [warm, [22, { jump: true }], [{ until: 'ground' }], [26, {}]] },
};

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { port: 5211, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 180000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader', '--no-sandbox', '--force-color-profile=srgb'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push('console: ' + m.text()); });

await fs.mkdir(OUT, { recursive: true });
let exitCode = 0;
const report = {};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__harness && window.__harness.ready === true', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));

  const names = ONLY.length ? ONLY : Object.keys(POSES);
  for (const name of names) {
    const P = POSES[name];
    if (!P) { errors.push('unknown pose ' + name); exitCode = 1; continue; }

    await page.evaluate((P) => {
      window.__setAuto(false);
      window.__inputOverride = { steer: 0, crouch: 0, brake: 0, jump: false };
      window.__harness.setPlayer(P.start[0], P.start[1], P.start[2]);
      window.__wasAir = false;
    }, P);
    // stepped in chunks: a long uninterrupted evaluate starves the headless
    // compositor and the later screenshot never resolves
    for (const step of P.seq) {
      const spec = typeof step[0] === 'object' ? step[0] : null;
      const inp = { steer: 0, crouch: 0, brake: 0, jump: false, ...(spec ? spec.input : step[1]) };
      let left = spec ? 400 : step[0];
      while (left > 0) {
        const n = Math.min(spec ? 1 : 30, left);
        const stop = await page.evaluate((inp, n, until) => {
          window.__inputOverride = inp;
          window.__harness.step(1 / 60, n);
          const st = window.__harness.state;
          if (!until) return false;
          if (st.airborne) window.__wasAir = true;
          return until === 'apex' ? st.vel.y <= 0
            : until === 'descend' ? st.vel.y <= -6.5
              : (window.__wasAir && !st.airborne);
        }, inp, n, spec?.until ?? null);
        left -= n;
        if (stop) break;
      }
    }
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.__harness.step(0, 0));
      await new Promise((r) => setTimeout(r, 24));
    }

    // Render, then pull the framebuffer back and crop around the skier — located
    // by his jacket colour, the one vermilion thing on a white mountain.
    const shot = await page.evaluate((zoom) => {
      window.__harness.step(0, 0);
      const cv = document.querySelector('canvas');
      const gl = cv.getContext('webgl2');
      const w = cv.width, h = cv.height;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      // the jacket and the ski topsheet share the same vermilion, which is handy:
      // the topmost orange is the shoulders, the lowest is the skis at the snow.
      const hit = [];
      let sx = 0, sy = 0, n = 0, y1 = -1e9, y0 = 1e9;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const i = (y * w + x) * 4;
          const r = buf[i], g = buf[i + 1], b = buf[i + 2];
          if (r > 110 && r > g * 1.6 && r > b * 2.0) {
            sx += x; sy += y; n++; hit.push(x, y);
            if (y > y1) y1 = y; if (y < y0) y0 = y;
          }
        }
      }
      let fx = 0, fn = 0;
      for (let i = 0; i < hit.length; i += 2) {
        if (hit[i + 1] < y0 + (y1 - y0) * 0.30) { fx += hit[i]; fn++; }
      }
      const crop = (zoom, cx, cyTop) => {
        const cw = Math.round(w / zoom), ch = Math.round(h / zoom);
        const x0c = Math.max(0, Math.min(w - cw, Math.round(cx - cw / 2)));
        const yTop = Math.max(ch - 1, Math.min(h - 1, Math.round(cyTop)));
        const out = new Uint8Array(cw * ch * 4);
        for (let y = 0; y < ch; y++) {
          const src = ((yTop - y) * w + x0c) * 4;
          out.set(buf.subarray(src, src + cw * 4), y * cw * 4);
        }
        let bin = '';
        for (let i = 0; i < out.length; i += 8192) {
          bin += String.fromCharCode.apply(null, out.subarray(i, Math.min(i + 8192, out.length)));
        }
        return { w: cw, h: ch, b64: btoa(bin) };
      };
      // gl rows are bottom-up: y1 is the TOP of the jacket in screen terms
      const cx = n ? sx / n : w * 0.5;
      const top = n ? y1 : h * 0.5;
      const body = crop(zoom, cx, top + Math.round(h / zoom * 0.13));
      const fz = zoom * 2.4;
      const feet = crop(fz, fn ? fx / fn : cx, (n ? y0 : h * 0.4) + Math.round(h / fz * 0.62));
      return { body, feet };
    }, ZOOM);
    const file = path.join(OUT, `${name}.png`);
    await fs.writeFile(file, encodePNG(shot.body.w, shot.body.h, Buffer.from(shot.body.b64, 'base64')));
    await fs.writeFile(path.join(OUT, `${name}-feet.png`),
      encodePNG(shot.feet.w, shot.feet.h, Buffer.from(shot.feet.b64, 'base64')));
    const m = await page.evaluate(() => window.__skier?.measure?.() ?? null);
    report[name] = m;

    const p = m?.pose;
    const skis = (m?.skis || []).map((k) => `${k.inside ? 'in' : 'out'} base ${k.baseMin.toFixed(3)}..${k.baseMax.toFixed(3)} tip ${k.tipY} fwd ${k.tipsForward}`).join(' | ');
    const legs = (m?.legs || []).map((k) => `${k.inside ? 'in' : 'out'} ${k.ext}`).join(' ');
    const poles = (m?.poles || []).map((k) => `${k.inside ? 'in' : 'out'} tip ${k.tipY} grip ${k.gripY}`).join(' | ');
    console.log(`\n== ${name}  spd ${p?.speed} edge ${p?.edge} crouch ${p?.crouch} g ${p?.gForce} air ${p?.airborne} vy ${p?.vy} ${p?.airPhase}`);
    console.log(`   skis   ${skis}`);
    console.log(`   legext ${legs}   hipY ${p?.hipY} headTop ${p?.headTopY} absorb ${p?.absorb}`);
    console.log(`   poles  ${poles}`);
    console.log(`   pose   incl ${p?.inclDeg} body ${p?.bodyDeg} angul ${p?.angulationDeg} shoulderTilt ${p?.shoulderTiltDeg} lead ${p?.shoulderLead} hipOverBoot ${p?.hipOverBoot}`);
    console.log(`   dbg    ${JSON.stringify(m?.dbg)}`);
  }
  await page.evaluate(() => { window.__inputOverride = null; window.__setAuto(true); });
} catch (e) {
  errors.push('lab: ' + (e?.message ?? String(e)));
  exitCode = 1;
} finally {
  if (errors.length) { exitCode = 1; console.error('\n--- errors ---'); for (const e of errors.slice(0, 30)) console.error('  ' + e); }
  await fs.writeFile(path.join(OUT, 'measure.json'), JSON.stringify(report, null, 2));
  await browser.close();
  await server.close();
  process.exit(exitCode);
}
