/**
 * Alpine — HUD.
 *
 * DOM/CSS overlay (crispest text at any devicePixelRatio, zero GPU cost in the
 * three.js frame). Layout is corner-anchored in viewport units so the centre of
 * frame is always clear for the capture harness.
 *
 *   bottom-left   speed (hero) + intensity rail + edge/carve indicator + air badge
 *   bottom-right  run timer, distance, top speed
 *
 * The whole overlay fades back when cruising slowly and comes alive with speed,
 * carve load and air. Nothing here reads layout during the frame loop; the only
 * per-frame writes are a handful of CSS custom properties and text nodes that
 * are diffed before writing.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (cur, tgt, dt, tau) => cur + (tgt - cur) * (1 - Math.exp(-dt / (tau > 1e-4 ? tau : 1e-4)));

const CSS = `
#alp-hud{position:fixed;inset:0;z-index:20;pointer-events:none;
  font-family:"Inter","SF Pro Display",-apple-system,BlinkMacSystemFont,system-ui,"Helvetica Neue",sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"ss01" 1;
  --ink:255,255,255;--accent:176,224,255;--hot:255,208,150;
  --live:0;--heat:0;--edge:0;--carve:0;--fade:.62;
  transition:none}
/* soft, gaussian-ish corner scrims so white type survives on white snow */
#alp-hud .scrim{position:absolute;inset:auto 0 0 0;height:46vh;opacity:var(--fade);
  background:
    radial-gradient(40% 76% at 3% 104%,
      rgba(1,5,13,.54) 0%,rgba(1,5,13,.47) 16%,rgba(1,5,13,.36) 31%,rgba(1,5,13,.25) 45%,
      rgba(1,5,13,.15) 59%,rgba(1,5,13,.08) 72%,rgba(1,5,13,.03) 86%,rgba(1,5,13,0) 100%),
    radial-gradient(32% 62% at 99% 106%,
      rgba(1,5,13,.46) 0%,rgba(1,5,13,.38) 18%,rgba(1,5,13,.27) 34%,rgba(1,5,13,.17) 50%,
      rgba(1,5,13,.09) 66%,rgba(1,5,13,.03) 84%,rgba(1,5,13,0) 100%),
    linear-gradient(to top,rgba(1,5,13,.08) 0%,rgba(1,5,13,.04) 24%,rgba(1,5,13,.01) 48%,rgba(1,5,13,0) 72%);
  }

/* ---------------------------------------------------------------- speed --- */
#alp-hud .speed{position:absolute;left:clamp(28px,3.6vw,76px);bottom:clamp(30px,5.4vh,68px);
  opacity:var(--fade);transform:translateY(calc(7px - 7px*var(--live)))}
#alp-hud .speed .glow{position:absolute;left:-18%;bottom:-34%;width:160%;height:200%;
  background:radial-gradient(50% 50% at 30% 55%, rgba(var(--accent),calc(.20*var(--heat))) 0%, rgba(var(--accent),0) 70%);
  filter:blur(8px)}
#alp-hud .readout{display:flex;align-items:baseline;gap:clamp(9px,.75vw,15px);position:relative}
/* the hero numeral is clamped on BOTH axes so tall/narrow viewports stay balanced */
#alp-hud .num{font-size:clamp(52px,min(10.4vh,7.4vw),124px);font-weight:300;line-height:.84;
  letter-spacing:-.048em;color:rgba(var(--ink),calc(.90 + .10*var(--live)));
  text-shadow:0 1px 2px rgba(0,8,20,.55),0 3px 14px rgba(0,8,20,.5),
              0 10px 48px rgba(0,8,20,calc(.44 + .2*var(--live)));
  transform:scale(var(--kick,1));transform-origin:0% 70%}
#alp-hud .unit{font-size:clamp(9px,1.16vh,13px);font-weight:500;letter-spacing:.34em;
  text-transform:uppercase;color:rgba(var(--ink),.6);padding-bottom:.95em;
  text-shadow:0 1px 3px rgba(0,8,20,.5),0 2px 14px rgba(0,8,20,.5)}

#alp-hud .rail{position:relative;margin-top:clamp(11px,1.6vh,19px);
  width:clamp(140px,min(15.5vw,27vh),264px);height:1px;background:rgba(var(--ink),.24);
  box-shadow:0 1px 6px rgba(0,8,20,.35)}
#alp-hud .rail .fill{position:absolute;inset:0;transform-origin:0 50%;
  transform:scaleX(var(--p,0));height:2px;top:-.5px;
  background:linear-gradient(90deg,rgba(var(--ink),.55),rgba(var(--accent),calc(.55 + .45*var(--heat))));
  box-shadow:0 0 calc(2px + 12px*var(--heat)) rgba(var(--accent),calc(.30*var(--heat)))}
#alp-hud .rail i{position:absolute;top:-3px;width:1px;height:7px;background:rgba(var(--ink),.3)}
/* ghost marker parked at the session's best speed */
#alp-hud .rail u{position:absolute;top:-4.5px;width:1px;height:10px;opacity:0;
  background:rgba(var(--accent),.9);box-shadow:0 0 7px rgba(var(--accent),.55)}

/* edge / carve load indicator: a hairline with a travelling dot */
#alp-hud .edgebar{position:relative;margin-top:clamp(10px,1.4vh,16px);
  width:clamp(140px,min(15.5vw,27vh),264px);height:1px;
  background:linear-gradient(90deg,rgba(var(--ink),0),rgba(var(--ink),.2) 18%,rgba(var(--ink),.2) 82%,rgba(var(--ink),0))}
#alp-hud .edgebar .dot{position:absolute;top:50%;left:50%;width:5px;height:5px;border-radius:50%;
  margin:-2.5px 0 0 -2.5px;background:rgba(var(--ink),calc(.5 + .45*var(--carve)));
  transform:translateX(calc(var(--edge) * clamp(70px,7.4vw,127px))) scale(calc(1 + .55*var(--carve)));
  box-shadow:0 0 calc(3px + 10px*var(--carve)) rgba(var(--accent),calc(.75*var(--carve))),
             0 1px 4px rgba(0,8,20,.5)}
#alp-hud .edgebar .tick{position:absolute;top:-2px;left:50%;width:1px;height:5px;
  margin-left:-.5px;background:rgba(var(--ink),.28)}

/* ------------------------------------------------------------------ air --- */
#alp-hud .air{position:absolute;left:0;bottom:100%;margin-bottom:clamp(14px,1.9vh,24px);
  display:flex;align-items:baseline;gap:.75em;white-space:nowrap;
  opacity:0;transform-origin:0 70%}
#alp-hud .air .lab{font-size:clamp(8px,1.02vh,11px);font-weight:600;letter-spacing:.42em;
  text-transform:uppercase;color:rgba(var(--accent),.9);
  text-shadow:0 1px 3px rgba(0,8,20,.6),0 2px 16px rgba(0,8,20,.6)}
#alp-hud .air .val{font-size:clamp(23px,3.6vh,42px);font-weight:300;letter-spacing:-.022em;
  color:rgba(var(--ink),.95);
  text-shadow:0 1px 3px rgba(0,8,20,.45),0 6px 30px rgba(0,8,20,.6)}
#alp-hud .air .val b{font-weight:300;font-size:.5em;opacity:.55;margin-left:.16em;letter-spacing:.04em}
#alp-hud .air.live{opacity:.92;animation:none}
#alp-hud .air.hit{animation:alp-air 2.5s cubic-bezier(.16,.9,.24,1) forwards}
#alp-hud .air.hit.big{animation-duration:3.4s}
#alp-hud .air.big .lab{color:rgba(var(--hot),.95)}
#alp-hud .air.big .val{text-shadow:0 0 34px rgba(var(--hot),.4),0 1px 3px rgba(0,8,20,.5),0 6px 30px rgba(0,8,20,.6)}
/* landing accent: a light sweep along the baseline of the badge */
#alp-hud .air .ring{position:absolute;left:0;bottom:-7px;height:1px;width:clamp(140px,min(15.5vw,27vh),264px);
  transform-origin:0 50%;transform:scaleX(0);opacity:0;
  background:linear-gradient(90deg,rgba(var(--hot),.95),rgba(var(--hot),.25) 45%,rgba(var(--hot),0))}
#alp-hud .air.hit .ring{animation:alp-sweep 1.5s cubic-bezier(.12,.85,.2,1) forwards}
#alp-hud .air.hit.big .ring{animation-duration:2.1s}
@keyframes alp-air{
  0%{opacity:0;transform:translateY(9px) scale(.94)}
  9%{opacity:1;transform:translateY(0) scale(1.09)}
  22%{transform:translateY(0) scale(1)}
  74%{opacity:1;transform:translateY(-2px) scale(1)}
  100%{opacity:0;transform:translateY(-20px) scale(.99)}}
@keyframes alp-sweep{
  0%{opacity:0;transform:scaleX(0)}
  12%{opacity:.95;transform:scaleX(.35)}
  55%{opacity:.5;transform:scaleX(1)}
  100%{opacity:0;transform:scaleX(1.06)}}

/* ---------------------------------------------------------------- stats --- */
#alp-hud .stats{position:absolute;right:clamp(28px,3.6vw,76px);bottom:clamp(32px,5.6vh,70px);
  display:grid;grid-template-columns:auto auto;align-items:baseline;justify-items:end;
  column-gap:clamp(10px,.85vw,17px);row-gap:clamp(10px,1.45vh,17px);
  opacity:var(--fade);transform:translateY(calc(6px - 6px*var(--live)))}
#alp-hud .stats .k{font-size:clamp(8px,.98vh,11px);font-weight:600;letter-spacing:.34em;
  text-transform:uppercase;color:rgba(var(--ink),.6);
  text-shadow:0 1px 3px rgba(0,8,20,.6),0 2px 14px rgba(0,8,20,.55)}
#alp-hud .stats .v{font-size:clamp(16px,2.25vh,27px);font-weight:300;letter-spacing:-.012em;
  color:rgba(var(--ink),.94);min-width:4.9ch;text-align:right;
  text-shadow:0 1px 3px rgba(0,8,20,.5),0 4px 24px rgba(0,8,20,.55)}
#alp-hud .stats .v s{text-decoration:none;font-size:.5em;opacity:.6;margin-left:.3em;
  letter-spacing:.1em}
#alp-hud .stats .hr{grid-column:1/-1;width:clamp(58px,6vw,102px);height:1px;
  background:rgba(var(--ink),.2);box-shadow:0 1px 5px rgba(0,8,20,.35)}
`;

export function createHUD(opts = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return { update() {} };

  if (!doc.getElementById('alp-hud-style')) {
    const st = doc.createElement('style');
    st.id = 'alp-hud-style';
    st.textContent = CSS;
    doc.head.appendChild(st);
  }
  const prev = doc.getElementById('alp-hud');
  if (prev) prev.remove();

  const root = doc.createElement('div');
  root.id = 'alp-hud';
  root.innerHTML = `
    <div class="scrim"></div>
    <div class="speed">
      <div class="air"><span class="ring"></span><span class="lab">Air</span><span class="val">0.00<b>s</b></span></div>
      <div class="glow"></div>
      <div class="readout"><span class="num">0</span><span class="unit">km/h</span></div>
      <div class="rail"><span class="fill"></span></div>
      <div class="edgebar"><span class="tick"></span><span class="dot"></span></div>
    </div>
    <div class="stats">
      <span class="k">Time</span><span class="v" id="alp-t">0:00.0</span>
      <span class="hr"></span>
      <span class="k">Dist</span><span class="v" id="alp-d">0<s>m</s></span>
      <span class="k">Top</span><span class="v" id="alp-x">0<s>km/h</s></span>
    </div>`;
  (opts.parent ?? doc.body).appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const elNum = $('.num');
  const elFill = $('.rail .fill');
  const elAir = $('.air');
  const elAirVal = $('.air .val');
  const elT = $('#alp-t');
  const elD = $('#alp-d');
  const elX = $('#alp-x');
  const rail = $('.rail');

  // rail ticks at 40 / 80 / 120 km/h
  for (const p of [40 / 150, 80 / 150, 120 / 150]) {
    const i = doc.createElement('i');
    i.style.left = (p * 100).toFixed(2) + '%';
    rail.appendChild(i);
  }
  const elBest = doc.createElement('u');
  rail.appendChild(elBest);

  // ---- animated internals ---------------------------------------------------
  let dSpeed = 0, dLive = 0, dHeat = 0, dEdge = 0, dCarve = 0, dKick = 1;
  let topKmh = 0, airT = 0, airHold = 0, wasAir = false, boost = 0;
  let lastNum = -1, lastT = '', lastD = '', lastX = '', lastRun = -1;
  const w = { live: -1, fade: -1, heat: -1, edge: -9, carve: -1, p: -1, kick: -1 };

  const setVar = (k, v, eps = 0.004) => {
    if (Math.abs(v - w[k]) < eps) return;
    w[k] = v;
    root.style.setProperty('--' + k, v.toFixed(4));
  };

  const fmtTime = (t) => {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  };

  function update(dt, state) {
    if (!state) return;
    const d = clamp(dt || 0, 0, 0.1);

    const kmh = (state.speed ?? 0) * 3.6;
    const airborne = !!state.airborne;
    const runT = state.time ?? 0;

    // a fresh run resets the derived stats
    if (runT < lastRun - 0.05) {
      topKmh = 0; airT = 0; airHold = 0; boost = 0; dSpeed = 0; wasAir = false;
      elAir.classList.remove('hit', 'big', 'live');
    }
    lastRun = runT;
    if (kmh > topKmh) topKmh = kmh;

    // hero readout: critically-damped chase so the number never twitches
    const prevS = dSpeed;
    dSpeed = smooth(dSpeed, kmh, d, 0.11);
    const accel = (dSpeed - prevS) / Math.max(d, 1e-3);

    // air timing (own accumulator; also honours physics' state.airTime)
    if (airborne) {
      airT += d;
      const declared = state.airTime ?? 0;
      if (declared > airT) airT = declared;
    }
    if (wasAir && !airborne) {
      if (airT > 0.3) {
        const big = airT > 1.15;
        elAirVal.innerHTML = airT.toFixed(2) + '<b>s</b>';
        elAir.classList.remove('live', 'hit', 'big');
        void elAir.offsetWidth;                     // restart the keyframe
        elAir.classList.add('hit');
        if (big) elAir.classList.add('big');
        boost = Math.min(1, 0.55 + airT * 0.45);
        airHold = big ? 3.4 : 2.5;
      } else {
        elAir.classList.remove('live');
      }
      airT = 0;
    }
    if (!wasAir && airborne) { elAir.classList.remove('hit', 'big'); }
    if (airborne) {
      elAir.classList.add('live');
      const v = airT.toFixed(2) + '<b>s</b>';
      if (elAirVal.innerHTML !== v) elAirVal.innerHTML = v;
    }
    wasAir = airborne;
    if (airHold > 0) { airHold -= d; if (airHold <= 0) elAir.classList.remove('hit', 'big'); }

    // "aliveness": speed + carve load + air + recent landing boost
    boost = Math.max(0, boost - d * 0.55);
    const gForce = state.gForce ?? 0;
    const liveT = clamp(
      clamp((kmh - 6) / 46, 0, 1) * 0.72 + clamp(gForce / 2.2, 0, 1) * 0.2 +
      (airborne ? 0.34 : 0) + boost * 0.4, 0, 1);
    dLive = smooth(dLive, liveT, d, liveT > dLive ? 0.16 : 0.55);
    dHeat = smooth(dHeat, clamp((kmh - 52) / 68, 0, 1) + (airborne ? 0.18 : 0), d, 0.3);
    dEdge = smooth(dEdge, clamp(state.edge ?? 0, -1, 1), d, 0.07);
    dCarve = smooth(dCarve, state.carving ? clamp(0.45 + Math.abs(state.edge ?? 0), 0, 1) : 0, d, 0.12);
    dKick = smooth(dKick, 1 + clamp(accel, -18, 34) * 0.0016, d, 0.09);

    setVar('live', dLive);
    setVar('fade', 0.6 + 0.4 * dLive);
    setVar('heat', clamp(dHeat, 0, 1));
    setVar('edge', clamp(dEdge, -1, 1), 0.002);
    setVar('carve', dCarve);
    setVar('p', clamp(dSpeed / 150, 0, 1), 0.0015);
    if (Math.abs(dKick - w.kick) > 0.002) { w.kick = dKick; elNum.style.setProperty('--kick', dKick.toFixed(3)); }
    elFill.style.setProperty('--p', clamp(dSpeed / 150, 0, 1).toFixed(4));

    // text: only touch the DOM when the rendered string actually changes
    const n = Math.round(dSpeed);
    if (n !== lastNum) { lastNum = n; elNum.textContent = String(n); }

    const ts = fmtTime(runT);
    if (ts !== lastT) { lastT = ts; elT.textContent = ts; }

    const dist = state.distance ?? 0;
    const ds = dist < 1000
      ? Math.round(dist) + '<s>m</s>'
      : (dist / 1000).toFixed(2) + '<s>km</s>';
    if (ds !== lastD) { lastD = ds; elD.innerHTML = ds; }

    const xs = Math.round(topKmh) + '<s>km/h</s>';
    if (xs !== lastX) {
      lastX = xs;
      elX.innerHTML = xs;
      const bp = clamp(topKmh / 150, 0, 1);
      elBest.style.left = (bp * 100).toFixed(2) + '%';
      // only show the ghost once it is meaningfully behind the live needle
      elBest.style.opacity = topKmh > 25 ? '0.55' : '0';
    }
  }

  const api = {
    update,
    root,
    dispose() { root.remove(); },
    setVisible(v) { root.style.display = v ? '' : 'none'; },
  };
  if (typeof window !== 'undefined') window.__alpineHUD = api;
  return api;
}
