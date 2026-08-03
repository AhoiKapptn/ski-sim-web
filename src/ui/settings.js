/**
 * Alpine — graphics settings PANEL.
 *
 * DOM, CSS and input. Nothing else.
 *
 * This file does not know what a single knob means. It renders whatever
 * `src/core/graphics-settings.js` puts in `registry` / `describe(id)` /
 * `readouts()`, and every value it shows is a string the model formatted. That
 * is not tidiness for its own sake: it is what lets a new knob be added as one
 * object literal in the model with no change here at all, and it is why this
 * file contains no reference to megapixels, shadow maps or vsync ticks even
 * though it displays all three.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT OUTRANKS EVERYTHING ELSE: NO FPS COUNTER
 * ---------------------------------------------------------------------------
 * CLAUDE.md trap 8. The presented frame interval is quantised to multiples of
 * the display's refresh period, so on a 144 Hz panel the only frame times that
 * exist are 6.9 / 13.9 / 20.8 / 27.8 ms and "42 fps" is not one of them — it is
 * the 20.8 and 27.8 rungs alternating. A number that cannot occur is worse than
 * no number: it invites the player (and the next agent) to chase a 2 ms delta
 * that nobody can see, because only crossing a RUNG is visible.
 *
 * So the live section shows the rung structure — the tick, the ladder, the rung
 * the controller is aiming at, and whether the last measured window LOCKED on a
 * rung or sat between two of them. Every one of those strings is composed by the
 * model from `gfx.info()`, which is the resolution controller's own measurement:
 * this panel starts no sampler of its own and therefore cannot perturb what it
 * is describing.
 *
 * ---------------------------------------------------------------------------
 * VOICE
 * ---------------------------------------------------------------------------
 * Matched to `ui/hud.js` deliberately, token for token: the same font stack,
 * `font-variant-numeric: tabular-nums`, the same `--ink` / `--accent` / `--hot`
 * colours, the same `--halo` four-offset text shadow (which is the thing that
 * actually keeps white type legible over a 231-mean snow field — the soft drop
 * shadows only supply depth), the same 3 px radius and 2 px `--hot` left border
 * the hut card uses, and `clamp()` type so it scales with the viewport.
 *
 * NO `backdrop-filter`. The HUD rejects it explicitly and the reason applies
 * here with more force, not less: on a page whose background is a WebGL canvas
 * it forces a readback of that canvas every frame. Layered gradients at low
 * alpha instead.
 *
 * The panel is COLD glass, where the hut menu card is warm paper. That is on
 * purpose: the card is a printed thing you are holding in a room, this is an
 * instrument panel over the top of the game, and they should not look like the
 * same object.
 *
 * ---------------------------------------------------------------------------
 * KEYS — and the ones deliberately left alone
 * ---------------------------------------------------------------------------
 * `Escape` toggles, `KeyO` is an alias. Escape is completely unbound in this
 * build (verified against `player/controls.js` and `core/debug-perf.js`).
 *
 * NOT bound, because they are already taken:
 *   W/S/A/D + arrows + Shift  steer, tuck and the hut menu cursor (controls.js)
 *   Ctrl / X                  brake            Space  jump / confirm
 *   E                         action           Enter  confirm
 *   digits 1-9                the hut's drinks menu, and debug-perf's toggles
 *   Backquote                 the dev ablation panel
 *
 * While the panel is OPEN it takes the arrows and Enter for navigation, and
 * neutralises `window.__inputOverride` for the duration — see `grabInput()`.
 *
 * Every handler is guarded on ctrl/meta/alt and on an `INPUT`/`TEXTAREA` target,
 * the same two guards `debug-perf.js` uses.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

const CSS = `
#alp-gfx{position:fixed;inset:0;z-index:40;pointer-events:none;
  font-family:"Inter","SF Pro Display",-apple-system,BlinkMacSystemFont,system-ui,"Helvetica Neue",sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"ss01" 1;
  --ink:255,255,255;--accent:168,222,255;--hot:255,201,132;
  --halo:0 1px 0 rgba(2,9,20,.62),0 -1px 0 rgba(2,9,20,.42),
         1px 0 0 rgba(2,9,20,.5),-1px 0 0 rgba(2,9,20,.5)}
#alp-gfx.hidden{display:none}

/* Scrim. Weak, like the HUD's: this sits over a bright snow field and a heavy
   dark wash reads as a dirty lens rather than as a modal. It is here to settle
   the panel into the frame and to give the click-outside-to-close a target. */
#alp-gfx .scrim{position:absolute;inset:0;pointer-events:auto;
  background:
    radial-gradient(120% 90% at 50% 50%,rgba(2,7,16,.30) 0%,rgba(2,7,16,.42) 100%)}

/* ---------------------------------------------------------------- panel --- */
#alp-gfx .panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  pointer-events:auto;display:flex;flex-direction:column;
  width:clamp(340px,40vw,600px);max-height:min(86vh,860px);
  padding:clamp(15px,1.9vh,23px) clamp(16px,1.4vw,26px) clamp(13px,1.6vh,20px);
  border-radius:3px;border-left:2px solid rgba(var(--hot),.55);
  background:
    linear-gradient(146deg,rgba(13,20,31,.90) 0%,rgba(8,13,22,.93) 46%,rgba(4,8,14,.95) 100%),
    radial-gradient(120% 78% at 0% 0%,rgba(150,205,255,.09) 0%,rgba(150,205,255,0) 62%);
  box-shadow:0 20px 62px rgba(0,4,10,.5),inset 0 1px 0 rgba(206,232,255,.09)}

#alp-gfx .hd{flex:none;display:flex;align-items:baseline;justify-content:space-between;gap:1em}
#alp-gfx .hd b{font-size:clamp(12px,1.55vh,17px);font-weight:700;letter-spacing:.24em;
  text-transform:uppercase;color:rgba(var(--hot),.97);
  text-shadow:var(--halo),0 2px 10px rgba(0,8,20,.6)}
#alp-gfx .hd i{font-style:normal;font-size:clamp(8px,1.05vh,11px);font-weight:700;
  letter-spacing:.2em;text-transform:uppercase;color:rgba(var(--ink),.5);text-shadow:var(--halo)}
#alp-gfx .rule{flex:none;margin:.62em 0 .2em;width:100%;height:1px;
  background:linear-gradient(90deg,rgba(var(--hot),.42),rgba(var(--ink),.16) 62%,rgba(var(--ink),0))}

/* The scroller. overflow-y is the one place this file touches layout, and it is
   only ever laid out while the panel is open and the simulation is paused. */
#alp-gfx .body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  scrollbar-width:thin;scrollbar-color:rgba(var(--ink),.22) transparent;
  padding-right:.35em;margin-right:-.35em}
#alp-gfx .body::-webkit-scrollbar{width:5px}
#alp-gfx .body::-webkit-scrollbar-thumb{background:rgba(var(--ink),.2);border-radius:3px}
#alp-gfx .body::-webkit-scrollbar-track{background:transparent}

#alp-gfx .sec{margin:1.05em 0 .38em;font-size:clamp(8px,1.0vh,11px);font-weight:700;
  letter-spacing:.26em;text-transform:uppercase;color:rgba(var(--ink),.46);
  text-shadow:var(--halo)}
#alp-gfx .sec:first-child{margin-top:.4em}
#alp-gfx .sec em{display:block;margin-top:.34em;font-style:normal;font-weight:400;
  letter-spacing:.02em;text-transform:none;font-size:1.06em;color:rgba(var(--ink),.34)}

/* ------------------------------------------------------------------ row --- */
/* The whole row is the hit area and the highlight is a background wash plus a
   warm bar in the left gutter — the same two cues the hut card uses, for the
   same reason: they survive on both a dark panel and a bright frame. */
#alp-gfx .row{position:relative;display:grid;grid-template-columns:1fr auto;
  align-items:center;gap:.7em;
  padding:.34em .5em .34em .52em;margin:0 -.5em;border-radius:2px;cursor:default}
#alp-gfx .row::before{content:'';position:absolute;left:-.5em;top:8%;bottom:8%;
  width:2px;background:rgba(var(--hot),.9);opacity:0;box-shadow:0 0 8px rgba(var(--hot),.5)}
#alp-gfx .row.sel{background:rgba(190,225,255,.075)}
#alp-gfx .row.sel::before{opacity:1}
#alp-gfx .row.off{opacity:.38}
#alp-gfx .row .l{font-size:clamp(11px,1.42vh,15px);font-weight:400;
  color:rgba(var(--ink),.88);text-shadow:var(--halo),0 2px 8px rgba(0,8,20,.5)}
#alp-gfx .row.sel .l{color:rgba(var(--ink),.99)}
#alp-gfx .row .l s{text-decoration:none;display:inline-block;margin-left:.5em;
  padding:0 .34em;border-radius:2px;font-size:.62em;font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;vertical-align:.12em;
  border:1px solid rgba(var(--ink),.24);color:rgba(var(--ink),.52)}
#alp-gfx .row .l s.hot{border-color:rgba(var(--hot),.5);color:rgba(var(--hot),.9)}
#alp-gfx .row .l s.cool{border-color:rgba(var(--accent),.34);color:rgba(var(--accent),.72)}

/* value side */
#alp-gfx .row .ctl{display:flex;align-items:center;justify-content:flex-end;gap:.5em;
  min-width:0;text-align:right}
#alp-gfx .row .v{font-size:clamp(10px,1.3vh,14px);font-weight:400;letter-spacing:.01em;
  color:rgba(var(--ink),.66);text-shadow:var(--halo);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:clamp(120px,15vw,240px)}
#alp-gfx .row.sel .v{color:rgba(var(--accent),.98)}
#alp-gfx .row .v u{text-decoration:none;color:rgba(var(--hot),.86);margin-left:.5em}
#alp-gfx .row .ch{font-weight:400;font-size:clamp(10px,1.3vh,14px);cursor:pointer;
  color:rgba(var(--ink),.26);padding:0 .12em;text-shadow:var(--halo)}
#alp-gfx .row.sel .ch{color:rgba(var(--ink),.62)}
#alp-gfx .row .ch.dead{opacity:.22;cursor:default}

/* range keel. Same instrument grammar as the HUD speed ladder: an unlit keel,
   a lit portion, a needle on the leading edge, and a ghost tick parked at the
   shipped default so "what did this used to be" is answerable at a glance. */
#alp-gfx .row .bar{position:relative;flex:none;width:clamp(78px,8.6vw,124px);height:9px;
  cursor:pointer}
#alp-gfx .row .bar b{position:absolute;left:0;right:0;bottom:0;height:1px;
  background:rgba(var(--ink),.24);filter:drop-shadow(0 1px 2px rgba(0,8,20,.55))}
#alp-gfx .row .bar i{position:absolute;left:0;right:0;bottom:0;height:2px;
  clip-path:inset(0 calc(100% - 100%*var(--p,0)) 0 0);
  background:linear-gradient(90deg,rgba(var(--ink),.5),rgba(var(--accent),.9))}
#alp-gfx .row .bar u{position:absolute;bottom:-1px;width:1.6px;height:9px;margin-left:-.8px;
  left:calc(100% * var(--p,0));background:rgba(var(--ink),.9);
  box-shadow:0 0 5px rgba(var(--accent),.5),0 1px 3px rgba(0,8,20,.6)}
#alp-gfx .row .bar s{position:absolute;top:-3px;width:1px;height:4px;margin-left:-.5px;
  left:calc(100% * var(--d,0));background:rgba(var(--hot),.6);text-decoration:none}

/* segmented preset control */
#alp-gfx .seg{display:flex;gap:.32em;flex-wrap:wrap;justify-content:flex-end}
#alp-gfx .seg span{padding:.2em .55em;border-radius:2px;cursor:pointer;
  border:1px solid rgba(var(--ink),.2);background:rgba(6,12,22,.3);
  font-size:clamp(8px,1.05vh,11px);font-weight:700;letter-spacing:.16em;
  text-transform:uppercase;color:rgba(var(--ink),.56);text-shadow:var(--halo)}
#alp-gfx .seg span.on{border-color:rgba(var(--hot),.72);color:rgba(var(--hot),.98);
  background:rgba(255,180,110,.12)}

/* ------------------------------------------------------------- readouts --- */
#alp-gfx .ro{display:grid;grid-template-columns:auto 1fr;column-gap:clamp(10px,.9vw,18px);
  row-gap:.34em;align-items:baseline;margin-top:.2em}
#alp-gfx .ro dt{font-size:clamp(8px,1.02vh,11px);font-weight:700;letter-spacing:.2em;
  text-transform:uppercase;color:rgba(var(--ink),.48);text-shadow:var(--halo);white-space:nowrap}
#alp-gfx .ro dd{margin:0;font-size:clamp(10px,1.28vh,13px);font-weight:400;
  color:rgba(var(--ink),.9);text-shadow:var(--halo)}
#alp-gfx .ro dd i{font-style:normal;display:block;font-size:.84em;letter-spacing:.02em;
  color:rgba(var(--ink),.42);margin-top:.1em}
#alp-gfx .ro dd i.warn{color:rgba(var(--hot),.86)}

/* ------------------------------------------------------- hint and keys --- */
/* One hint line for the focused row, at a fixed height. Per-row hints turn a
   settings list into a wall of prose; a single line that follows the cursor is
   the same information without the wall, and it cannot make the panel jump. */
#alp-gfx .hint{flex:none;margin-top:.75em;padding-top:.7em;min-height:4.1em;
  border-top:1px solid rgba(var(--ink),.13);
  font-size:clamp(9px,1.16vh,12px);line-height:1.45;letter-spacing:.02em;
  color:rgba(var(--ink),.52);text-shadow:var(--halo)}
#alp-gfx .hint b{font-weight:700;color:rgba(var(--hot),.9)}
#alp-gfx .keys{flex:none;display:flex;flex-wrap:wrap;gap:.3em .95em;margin-top:.7em;
  font-size:clamp(8px,1.0vh,11px);font-weight:700;letter-spacing:.17em;
  text-transform:uppercase;color:rgba(var(--ink),.4);text-shadow:var(--halo)}
#alp-gfx .keys em{font-style:normal;color:rgba(var(--ink),.76)}

/* an action row (reset, apply reload) reads as a button, not as a setting */
#alp-gfx .row.act .l{font-weight:700;letter-spacing:.16em;text-transform:uppercase;
  font-size:clamp(9px,1.14vh,12px);color:rgba(var(--accent),.86)}
#alp-gfx .row.act.warn .l{color:rgba(var(--hot),.94)}
`;

/** Badge markup for one knob. Kept here, not in the model: it is presentation. */
function badges(k) {
  let out = '';
  if (k.overriddenBy) out += `<s class="hot">${esc(k.overriddenBy)}</s>`;
  else if (!k.available) out += '<s>n/a</s>';
  if (k.reload) out += `<s class="${k.pendingReload ? 'hot' : ''}">reload</s>`;
  if (k.cost === 'look') out += '<s class="cool">look</s>';
  return out;
}

export function createSettingsUI(settings, { onOpen, onClose } = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  // Headless-safe no-op. `tools/probe.mjs` and friends import main.js in
  // environments that have had `document` stubbed out before.
  if (!doc || !settings) {
    return { open() {}, close() {}, toggle() {}, get isOpen() { return false; }, dispose() {}, root: null };
  }

  if (!doc.getElementById('alp-gfx-style')) {
    const st = doc.createElement('style');
    st.id = 'alp-gfx-style';
    st.textContent = CSS;
    doc.head.appendChild(st);
  }
  const prev = doc.getElementById('alp-gfx');
  if (prev) prev.remove();

  const root = doc.createElement('div');
  root.id = 'alp-gfx';
  root.className = 'hidden';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="scrim"></div>
    <div class="panel" role="dialog" aria-modal="true" aria-label="Graphics settings" tabindex="-1">
      <div class="hd"><b>Graphics</b><i class="pre">auto</i></div>
      <div class="rule"></div>
      <div class="body"></div>
      <div class="hint"></div>
      <div class="keys"><span><em>↑↓</em> move</span><span><em>←→</em> adjust</span
        ><span><em>↵</em> toggle</span><span><em>Esc</em> / <em>O</em> close</span
        ><span><em>?gfx=default</em> ignore saved</span></div>
    </div>`;
  doc.body.appendChild(root);

  const panel = root.querySelector('.panel');
  const body = root.querySelector('.body');
  const elPre = root.querySelector('.pre');
  const elHint = root.querySelector('.hint');
  const elScrim = root.querySelector('.scrim');

  let open = false;
  let cursor = 0;
  /**
   * The focusable list, rebuilt on every open. Rebuilding rather than diffing is
   * the right trade here: it costs one layout while the simulation is paused,
   * and it is what picks up option lists that only become known with time — the
   * frame-rate target's options come from the display's measured vsync ladder,
   * which is null for the first couple of seconds of a session.
   */
  let items = [];
  let timer = 0;
  let savedInput;             // whatever owned __inputOverride before we opened
  let lastRo = '';            // readout block, diffed before writing
  let elRo = null;            // the <dl> the readouts live in, re-found on build

  // ---------------------------------------------------------------- build ---
  function build() {
    items = [];
    let html = '';

    // preset selector
    html += '<div class="sec">Preset</div>';
    items.push({ kind: 'preset' });
    html += `<div class="row" data-i="0"><span class="l">Quality preset</span>`
      + `<span class="ctl"><span class="seg">`
      + settings.presets.map((p) => `<span data-preset="${esc(p)}">${esc(p)}</span>`).join('')
      + `</span></span></div>`;

    // knob groups
    for (const g of settings.groups) {
      const knobs = settings.registry.filter((d) => d.group === g.id);
      if (!knobs.length) continue;
      html += `<div class="sec">${esc(g.title)}${g.note ? `<em>${esc(g.note)}</em>` : ''}</div>`;
      for (const d of knobs) {
        const k = settings.describe(d.id);
        if (!k) continue;
        const i = items.length;
        items.push({ kind: 'knob', id: d.id, type: k.type });
        html += `<div class="row" data-i="${i}"><span class="l"></span><span class="ctl">`;
        if (k.type === 'range') {
          html += '<span class="bar"><b></b><i></i><s></s><u></u></span><span class="v"></span>';
        } else {
          html += '<b class="ch" data-dir="-1">&lsaquo;</b><span class="v"></span>'
            + '<b class="ch" data-dir="1">&rsaquo;</b>';
        }
        html += '</span></div>';
      }
    }

    // actions
    html += '<div class="sec">Session</div>';
    const iReset = items.length;
    items.push({ kind: 'action', act: 'reset' });
    html += `<div class="row act" data-i="${iReset}"><span class="l">Reset to shipped defaults</span>`
      + '<span class="ctl"><span class="v">clears saved settings</span></span></div>';
    const iReload = items.length;
    items.push({ kind: 'action', act: 'reload' });
    html += `<div class="row act warn" data-i="${iReload}" data-reload="1">`
      + '<span class="l">Apply and reload</span>'
      + '<span class="ctl"><span class="v"></span></span></div>';

    // live readouts
    html += '<div class="sec">Live<em>Frame pacing is quantised to the display refresh, so this reports '
      + 'the vsync rung rather than a frame rate — a rate between rungs cannot be presented.</em></div>';
    html += '<dl class="ro"></dl>';

    body.innerHTML = html;
    lastRo = '';

    // cache the element handles once
    const rows = body.querySelectorAll('.row');
    for (const r of rows) {
      const i = +r.dataset.i;
      if (!items[i]) continue;
      items[i].el = r;
      items[i].l = r.querySelector('.l');
      items[i].v = r.querySelector('.v');
      items[i].bar = r.querySelector('.bar');
    }
    items[0].seg = body.querySelectorAll('.seg span');
    items[iReload].el.style.display = 'none';
    elRo = body.querySelector('.ro');
  }

  // ----------------------------------------------------------------- sync ---
  /** Every visible string, diffed before it is written. */
  function sync() {
    if (!open) return;

    const preset = settings.getPreset();
    const preTxt = preset + (settings.storageBypassed ? ' · storage bypassed' : '');
    if (elPre.textContent !== preTxt) elPre.textContent = preTxt;
    for (const s of items[0].seg) {
      const on = s.dataset.preset === preset;
      if (s.classList.contains('on') !== on) s.classList.toggle('on', on);
    }
    setSel(items[0].el, cursor === 0);

    for (let i = 1; i < items.length; i++) {
      const it = items[i];
      setSel(it.el, cursor === i);
      if (it.kind === 'knob') syncKnob(it);
      else if (it.act === 'reload') syncReload(it);
    }
    syncHint();
    syncReadouts();
  }

  const setSel = (el, on) => { if (el && el.classList.contains('sel') !== on) el.classList.toggle('sel', on); };
  const setTx = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };

  function syncKnob(it) {
    const k = settings.describe(it.id);
    if (!k) return;
    it.k = k;
    const label = esc(k.label) + badges(k);
    if (it.l.innerHTML !== label) it.l.innerHTML = label;
    const dead = !k.available || !!k.overriddenBy;
    if (it.el.classList.contains('off') !== dead) it.el.classList.toggle('off', dead);

    // The live value is shown next to the setting whenever the two can differ.
    // That is the adaptive resolution case and it is the whole reason the model
    // reports `liveText`: with the controller on, the knob is a FLOOR and the
    // number actually being rendered is somewhere above it.
    const extra = (k.liveText && k.liveText !== k.text) ? `<u>now ${esc(k.liveText)}</u>` : '';
    const vHtml = esc(k.text) + extra;
    if (it.v.innerHTML !== vHtml) it.v.innerHTML = vHtml;

    if (it.type === 'range' && it.bar) {
      const span = (k.max - k.min) || 1;
      const p = clamp((k.value - k.min) / span, 0, 1);
      const dp = clamp(((k.def ?? k.min) - k.min) / span, 0, 1);
      const ps = p.toFixed(4), ds = dp.toFixed(4);
      if (it.bar.style.getPropertyValue('--p') !== ps) it.bar.style.setProperty('--p', ps);
      if (it.bar.style.getPropertyValue('--d') !== ds) it.bar.style.setProperty('--d', ds);
    } else {
      // grey out a chevron that cannot move
      const chs = it.el.querySelectorAll('.ch');
      if (chs.length === 2 && k.options) {
        const at = k.options.findIndex((o) => o.v === k.value);
        setDead(chs[0], at <= 0);
        setDead(chs[1], at >= k.options.length - 1);
      }
    }
  }
  const setDead = (el, on) => { if (el.classList.contains('dead') !== on) el.classList.toggle('dead', on); };

  function syncReload(it) {
    const on = settings.pendingReload;
    const want = on ? '' : 'none';
    if (it.el.style.display !== want) it.el.style.display = want;
    setTx(it.v, on ? 'a page reload is required' : '');
  }

  function syncHint() {
    const it = items[cursor];
    let h = '';
    if (!it) h = '';
    else if (it.kind === 'preset') {
      h = 'Presets only move knobs that have a measured effect on the frame. Anything marked '
        + '<b>look</b> is a multiplier on work the shader does either way — it changes the image and '
        + 'buys no frames, so a preset leaves it exactly where you put it. <b>Auto</b> is the shipped '
        + 'configuration and writes nothing at all.';
    } else if (it.kind === 'action') {
      h = it.act === 'reset'
        ? 'Drops the saved document and puts every knob back to what this build ships. Worth doing '
          + 'before reporting anything visual: a stale preset in storage would silently change every '
          + 'screenshot this project takes.'
        : 'Rewrites the query string and reloads the page. Some settings are WebGL context attributes '
          + 'and cannot be changed on a live context.';
    } else {
      const k = it.k || settings.describe(it.id);
      h = esc(k.hint || '');
      if (k.overriddenBy) {
        h = '<b>Set by ' + esc(k.overriddenBy) + ' in the URL</b> — an explicit instruction outranks this '
          + 'panel, so the knob is read-only for this session. ' + h;
      } else if (!k.available) {
        h = '<b>' + esc(k.why) + '</b> — the setting is remembered and takes effect as soon as it is. ' + h;
      } else if (k.hitch) {
        h += ' <b>Changing this stalls a frame or more.</b>';
      }
    }
    if (elHint.innerHTML !== h) elHint.innerHTML = h;
  }

  function syncReadouts() {
    const rows = settings.readouts();
    let html = '';
    for (const r of rows) {
      // "BETWEEN RUNGS" is the one readout that is a finding rather than a fact,
      // so it is the one that gets the warm colour.
      const warn = /BETWEEN RUNGS|NOT a rung|not sampled|not yet measured/.test(r.note + ' ' + r.value);
      html += `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}`
        + (r.note ? `<i class="${warn ? 'warn' : ''}">${esc(r.note)}</i>` : '') + '</dd>';
    }
    if (html !== lastRo) { lastRo = html; if (elRo) elRo.innerHTML = html; }
  }

  // ------------------------------------------------------------ interaction --
  function move(d) {
    if (!items.length) return;
    const n = items.length;
    let i = cursor;
    for (let step = 0; step < n; step++) {
      i = (i + d + n) % n;
      const it = items[i];
      // skip rows that cannot be interacted with, in the direction of travel
      if (it.kind === 'action' && it.act === 'reload' && !settings.pendingReload) continue;
      break;
    }
    cursor = i;
    ensureVisible(items[cursor].el);
    sync();
  }

  /**
   * Keep the cursor in view. This scrolls the panel's own scroller, never the
   * page — and it only ever runs while the panel is open, i.e. while the sim is
   * paused, so the layout read it forces is not on any frame's critical path.
   */
  function ensureVisible(el) {
    if (!el || !el.scrollIntoView) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function adjust(dir) {
    const it = items[cursor];
    if (!it) return;
    if (it.kind === 'preset') {
      const list = settings.presets;
      let at = list.indexOf(settings.getPreset());
      if (at < 0) at = 0;                              // 'custom' — start from Auto
      settings.setPreset(list[clamp(at + dir, 0, list.length - 1)]);
    } else if (it.kind === 'knob') {
      settings.nudge(it.id, dir);
    }
    sync();
  }

  function activate() {
    const it = items[cursor];
    if (!it) return;
    if (it.kind === 'knob') settings.nudge(it.id, 0);   // 0 = toggle / step forward
    else if (it.kind === 'action' && it.act === 'reset') settings.reset();
    else if (it.kind === 'action' && it.act === 'reload') settings.applyReload();
    else if (it.kind === 'preset') adjust(1);
    sync();
  }

  // mouse — one delegated listener
  panel.addEventListener('mousedown', (e) => {
    const pre = e.target.closest('[data-preset]');
    if (pre) { cursor = 0; settings.setPreset(pre.dataset.preset); sync(); return; }
    const row = e.target.closest('.row');
    if (!row) return;
    const i = +row.dataset.i;
    if (!Number.isFinite(i) || !items[i]) return;
    cursor = i;
    const it = items[i];

    const ch = e.target.closest('.ch');
    if (ch) { adjust(+ch.dataset.dir); return; }

    const bar = e.target.closest('.bar');
    if (bar && it.kind === 'knob') {
      // Reading a rect here is fine: the panel is only interactive while it is
      // open, and opening it pauses the simulation.
      const r = bar.getBoundingClientRect();
      const k = settings.describe(it.id);
      const f = clamp((e.clientX - r.left) / Math.max(r.width, 1), 0, 1);
      settings.set(it.id, k.min + f * (k.max - k.min));
      sync();
      return;
    }
    if (it.kind === 'knob' && it.type !== 'range') { activate(); return; }
    if (it.kind === 'action') { activate(); return; }
    sync();
  });
  // Dragging a keel: same handler, so a click and a drag are the same gesture.
  panel.addEventListener('mousemove', (e) => {
    if (!open || e.buttons !== 1) return;
    const it = items[cursor];
    if (!it || it.kind !== 'knob' || it.type !== 'range' || !it.bar) return;
    const r = it.bar.getBoundingClientRect();
    // Only while the pointer is still on this row's keel band.
    const rr = it.el.getBoundingClientRect();
    if (e.clientY < rr.top - 6 || e.clientY > rr.bottom + 6) return;
    const k = settings.describe(it.id);
    const f = clamp((e.clientX - r.left) / Math.max(r.width, 1), 0, 1);
    settings.set(it.id, k.min + f * (k.max - k.min));
    sync();
  });
  elScrim.addEventListener('mousedown', () => close());

  // ------------------------------------------------------------------ keys --
  /**
   * While the panel is open the arrows and Enter belong to it. `controls.js`
   * records every keydown in a global map and only a keyup or a window blur
   * clears it, so a navigation keypress can also be a steer input for as long
   * as the panel is up. `__inputOverride` is the documented hook that shuts that
   * off (controls.js reads it every update, and tools/ already drive it), and
   * whatever owned it before is put back on close so a scripted run that opens
   * the panel does not lose its inputs.
   */
  function grabInput() {
    if (typeof window === 'undefined') return;
    savedInput = window.__inputOverride;
    window.__inputOverride = { steer: 0, crouch: 0, brake: 0, jump: false, action: false, pick: 0, navY: 0, confirm: false };
  }
  function releaseInput() {
    if (typeof window === 'undefined') return;
    window.__inputOverride = savedInput ?? null;
    savedInput = undefined;
  }

  const NAV = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'NumpadEnter',
    'Home', 'End', 'PageUp', 'PageDown', 'Tab',
  ]);

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return;
    if (e.target?.isContentEditable) return;

    if (e.code === 'Escape' || e.code === 'KeyO') {
      // Escape while a browser is fullscreen also exits fullscreen and that
      // cannot be prevented — accepted, because Escape is the key a player will
      // reach for and it is completely unbound in this build otherwise.
      e.preventDefault();
      toggle();
      return;
    }
    if (!open) return;
    if (!NAV.has(e.code)) return;
    e.preventDefault();
    switch (e.code) {
      case 'ArrowUp': move(-1); break;
      case 'ArrowDown': move(1); break;
      case 'Tab': move(e.shiftKey ? -1 : 1); break;
      case 'ArrowLeft': adjust(-1); break;
      case 'ArrowRight': adjust(1); break;
      case 'Enter': case 'NumpadEnter': activate(); break;
      // `move` from one past each end, so the skip rules apply at the extremes
      // too and neither key can land on a hidden row.
      case 'Home': cursor = items.length - 1; move(1); break;
      case 'End': cursor = 0; move(-1); break;
      case 'PageUp': for (let i = 0; i < 5; i++) move(-1); break;
      case 'PageDown': for (let i = 0; i < 5; i++) move(1); break;
      default: break;
    }
  }
  // Capture phase, so navigation is handled before anything downstream can act
  // on the same key. It does not stop `controls.js` recording it — nothing can,
  // short of stopImmediatePropagation on a listener registered first — which is
  // why `grabInput()` exists as well.
  addEventListener('keydown', onKey, { capture: true });

  // ------------------------------------------------------------------ open ---
  function doOpen() {
    if (open) return;
    open = true;
    cursor = 0;
    build();
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    grabInput();
    sync();
    // 5 Hz. The live section is the only thing that changes on its own, and it
    // changes at the pace of the resolution controller's decision windows
    // (45 frames), so nothing faster would show anything new.
    if (!timer) timer = setInterval(sync, 200);
    try { onOpen?.(); } catch (err) { console.warn('[gfx-ui] onOpen threw:', err); }
  }

  function close() {
    if (!open) return;
    open = false;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    if (timer) { clearInterval(timer); timer = 0; }
    releaseInput();
    try { onClose?.(); } catch (err) { console.warn('[gfx-ui] onClose threw:', err); }
  }

  function toggle() { if (open) close(); else doOpen(); }

  const api = {
    open: doOpen,
    close,
    toggle,
    get isOpen() { return open; },
    dispose() {
      if (open) close();
      removeEventListener('keydown', onKey, { capture: true });
      root.remove();
      doc.getElementById('alp-gfx-style')?.remove();
    },
    root,
  };
  if (typeof window !== 'undefined') window.__alpineSettings = api;
  return api;
}
