/**
 * Alpine — HUD.
 *
 * DOM/CSS overlay (crispest text at any devicePixelRatio, zero GPU cost in the
 * three.js frame). Layout is corner-anchored in viewport units so the centre of
 * frame is always clear for the capture harness.
 *
 *   bottom-left   speed (hero) + speed ladder + edge/carve needle + air badge
 *   bottom-right  run timer, distance, top speed, warmth
 *
 * ### The resort layer
 *
 * `state.mode` (see game/resort.js) decides which instruments exist. Riding a
 * lift or sitting in the hut, the speedometer is meaningless and the run timer
 * is not the subject, so both fade down and their place is taken by the thing
 * that IS the subject: a contact prompt, a ride progress line, or the bar card.
 * Nothing is created or destroyed per frame — every element is built once and
 * driven by CSS custom properties, exactly like the speed block.
 *
 *   `--ui`     1 while skiing, 0 while riding or indoors (fades the instruments)
 *   `--veil`   the dip through a doorway or a skipped ride
 *   `--glow`   the warm flash off the first sip
 *
 * Scaling is tuned against the measured envelope of the current physics
 * (tools/ux-trace.mjs): rest 0, cruise ~30, carving 45-65, straight schuss
 * 70-76, tuck 85-92 km/h; |edge| to ~1.0; gForce p90 0.6 / max ~3.2; and, very
 * importantly, 40+ micro-hops of 0.1-0.3 s per run that must NOT each trigger
 * an "air" moment. Full ladder scale is 110 km/h so the real top speed lands at
 * ~85% of travel instead of the old 150 scale's 60%.
 *
 * Legibility: sunlit snow is the worst possible background for white type, and
 * the tonemapped frame regularly runs at mean luminance 230+. Every glyph
 * therefore carries a tight dark contact halo (four 1 px offsets) *plus* soft
 * drop shadows — the halo is what actually survives on white; the soft shadows
 * only supply depth. Verified by compositing the HUD over real alpine
 * photographs (tools/ux-hud.mjs --refs).
 *
 * Per-frame cost: a handful of CSS custom properties and text nodes, all diffed
 * before writing, and only compositor-friendly properties (transform, opacity,
 * clip-path). Nothing here reads layout during the frame loop.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (cur, tgt, dt, tau) => cur + (tgt - cur) * (1 - Math.exp(-dt / (tau > 1e-4 ? tau : 1e-4)));

/** Ladder full scale, km/h. Measured top speed (tuck) is ~92. */
const V_FULL = 110;
/** Air shorter than this is terrain chatter, not a jump — no badge, no fanfare. */
const AIR_MIN = 0.42;
const AIR_BIG = 1.05;

const CSS = `
#alp-hud{position:fixed;inset:0;z-index:20;pointer-events:none;
  font-family:"Inter","SF Pro Display",-apple-system,BlinkMacSystemFont,system-ui,"Helvetica Neue",sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"ss01" 1;
  --ink:255,255,255;--accent:168,222,255;--hot:255,201,132;
  --live:0;--heat:0;--edge:0;--carve:0;--land:0;
  --ui:1;--veil:0;--glow:0;--prompt:0;--ride:0;--card:0;--warm:1;--warmvis:0;
  --halo:0 1px 0 rgba(2,9,20,.62),0 -1px 0 rgba(2,9,20,.42),
         1px 0 0 rgba(2,9,20,.5),-1px 0 0 rgba(2,9,20,.5);
  transition:none}

/* Cinematic bottom scrim.
   Deliberately weak. Side-by-side against a real alpine photograph, the earlier
   pass read as a dark smudge in the lower-left corner — a dirty-lens artefact,
   not a grade, and the single loudest "this is a web demo" tell in the whole
   overlay. Legibility is carried by the per-glyph halos instead; this is only
   here to settle the type into the frame, and at these alphas it is invisible
   as a shape on both a 231-mean snow field and a real photo. */
#alp-hud .scrim{position:absolute;inset:auto 0 0 0;height:64vh;opacity:calc(.74 + .26*var(--live));
  background:
    radial-gradient(66% 104% at 0% 112%,
      rgba(2,7,16,.29) 0%,rgba(2,7,16,.25) 20%,rgba(2,7,16,.20) 37%,rgba(2,7,16,.145) 53%,
      rgba(2,7,16,.095) 67%,rgba(2,7,16,.05) 80%,rgba(2,7,16,.017) 91%,rgba(2,7,16,0) 100%),
    radial-gradient(52% 88% at 100% 114%,
      rgba(2,7,16,.26) 0%,rgba(2,7,16,.22) 20%,rgba(2,7,16,.17) 38%,rgba(2,7,16,.12) 55%,
      rgba(2,7,16,.07) 70%,rgba(2,7,16,.025) 86%,rgba(2,7,16,0) 100%),
    linear-gradient(to top,
      rgba(2,7,16,.13) 0%,rgba(2,7,16,.10) 14%,rgba(2,7,16,.068) 30%,rgba(2,7,16,.04) 48%,
      rgba(2,7,16,.016) 68%,rgba(2,7,16,0) 100%)}

/* ---------------------------------------------------------------- speed --- */
#alp-hud .speed{position:absolute;left:clamp(32px,4vw,84px);bottom:clamp(40px,7.6vh,88px);
  opacity:calc((.74 + .26*var(--live)) * var(--ui));
  transform:translateY(calc(6px - 6px*var(--live) + 14px*(1 - var(--ui))))}
#alp-hud .glow{position:absolute;left:-20%;bottom:-40%;width:170%;height:210%;
  background:radial-gradient(50% 50% at 28% 58%,
    rgba(var(--accent),calc(.20*var(--heat) + .30*var(--land))) 0%, rgba(var(--accent),0) 68%);
  filter:blur(10px)}
#alp-hud .readout{display:flex;align-items:baseline;gap:clamp(10px,.8vw,16px);position:relative}

/* Hero numeral. Weight 400 (not hairline): at 90 px a 300 stroke dissolves on
   sunlit snow. The halo gives it an edge; the wide shadows give it air. */
#alp-hud .num{font-size:clamp(54px,min(9.9vh,7.2vw),118px);font-weight:400;line-height:.82;
  letter-spacing:-.045em;color:rgba(var(--ink),calc(.94 + .06*var(--live)));
  text-shadow:var(--halo),0 2px 5px rgba(0,8,20,.45),0 6px 22px rgba(0,8,20,.5),
              0 14px 56px rgba(0,8,20,calc(.4 + .22*var(--live)));
  transform:scale(calc(var(--kick,1) + .05*var(--heat)));transform-origin:0% 74%}
/* The unit label used to dissolve into a grey smear at 1600x900. Bigger,
   heavier, tighter tracking, more opaque — it is a label, not a texture. */
#alp-hud .unit{font-size:clamp(10px,1.34vh,15px);font-weight:700;letter-spacing:.22em;
  text-transform:uppercase;color:rgba(var(--ink),calc(.80 + .14*var(--heat)));padding-bottom:.95em;
  text-shadow:var(--halo),0 2px 10px rgba(0,8,20,.5)}

/* Speed ladder. One instrument, not three stacked rules: a baseline keel whose
   lit length is the speed, ticks rising from it (minor 5 km/h, major 20 km/h,
   full scale 110), a warm zone above 85 km/h so the top of the range has
   somewhere to arrive, and a needle riding the leading edge. Everything is
   clipped or transformed — never resized — so no frame touches layout. */
#alp-hud .rail{position:relative;margin-top:clamp(10px,1.45vh,17px);
  width:var(--rw);height:11px;
  --rw:clamp(150px,min(16.5vw,28vh),282px);
  -webkit-mask-image:linear-gradient(90deg,#000 0 90%,rgba(0,0,0,.25) 100%);
          mask-image:linear-gradient(90deg,#000 0 90%,rgba(0,0,0,.25) 100%)}
/* keel: the instrument's baseline, unlit then lit */
#alp-hud .rail .k{position:absolute;left:0;right:0;bottom:0;height:1px;
  background:rgba(var(--ink),.26);filter:drop-shadow(0 1px 2px rgba(0,8,20,.55))}
#alp-hud .rail .kl{position:absolute;left:0;right:0;bottom:0;height:2px;
  clip-path:inset(0 calc(100% - 100%*var(--p,0)) 0 0);
  background:linear-gradient(90deg,
    rgba(var(--ink),.62) 0%,rgba(var(--accent),calc(.55 + .45*var(--heat))) 100%);
  box-shadow:0 0 calc(2px + 12px*var(--heat)) rgba(var(--accent),calc(.3*var(--heat)))}
#alp-hud .rail .kl::after{content:'';position:absolute;inset:-1px 0;opacity:var(--land);
  background:linear-gradient(90deg,rgba(var(--hot),0),rgba(var(--hot),.95))}
/* Unlit scale: minor tick every 5 km/h (3 px), major every 20 km/h (7 px). */
#alp-hud .rail .t{position:absolute;left:0;right:0;bottom:1px;height:3px;
  background:repeating-linear-gradient(90deg,
    rgba(var(--ink),.34) 0 1.4px,rgba(var(--ink),0) 1.4px 4.5454%);
  filter:drop-shadow(0 1px 1px rgba(0,8,20,.5))}
#alp-hud .rail .T{position:absolute;left:0;right:0;bottom:1px;height:7px;
  background:repeating-linear-gradient(90deg,
    rgba(var(--ink),.5) 0 1.4px,rgba(var(--ink),0) 1.4px 18.1818%);
  filter:drop-shadow(0 1px 1px rgba(0,8,20,.5))}
/* warm zone: 85 km/h and up */
#alp-hud .rail .r{position:absolute;left:0;right:0;bottom:1px;height:3px;
  clip-path:inset(0 0 0 77.3%);
  background:repeating-linear-gradient(90deg,
    rgba(var(--hot),.42) 0 1.4px,rgba(var(--hot),0) 1.4px 4.5454%)}
/* Lit scale — taller as well as brighter, so it reads on any background. */
#alp-hud .rail .f{position:absolute;left:0;right:0;bottom:1px;height:7px;
  clip-path:inset(0 calc(100% - 100%*var(--p,0)) 0 0);
  background:repeating-linear-gradient(90deg,
    rgba(var(--accent),calc(.8 + .2*var(--heat))) 0 1.4px,rgba(var(--accent),0) 1.4px 4.5454%);
  filter:drop-shadow(0 1px 1px rgba(0,8,20,.6))
         drop-shadow(0 0 calc(1px + 5px*var(--heat)) rgba(var(--accent),calc(.55*var(--heat))))}
#alp-hud .rail .fh{position:absolute;left:0;right:0;bottom:1px;height:9px;
  clip-path:inset(0 calc(100% - 100%*var(--p,0)) 0 77.3%);
  background:repeating-linear-gradient(90deg,
    rgba(var(--hot),.98) 0 1.4px,rgba(var(--hot),0) 1.4px 4.5454%);
  filter:drop-shadow(0 1px 1px rgba(0,8,20,.6)) drop-shadow(0 0 6px rgba(var(--hot),.65))}
/* needle riding the leading edge */
#alp-hud .rail .cap{position:absolute;bottom:-1px;left:0;width:1.6px;height:11px;
  transform:translateX(calc(var(--p,0) * var(--rw)));
  background:rgba(var(--ink),.97);
  box-shadow:0 0 calc(2px + 9px*var(--heat)) rgba(var(--accent),calc(.5 + .4*var(--heat))),
             0 1px 3px rgba(0,8,20,.6)}
/* ghost marker parked at the session's best speed, hung above the ladder */
#alp-hud .rail u{position:absolute;top:-4px;width:1px;height:5px;opacity:0;
  background:rgba(var(--hot),.8);box-shadow:0 0 5px rgba(var(--hot),.5),0 1px 2px rgba(0,8,20,.6)}

/* edge / carve load: a subordinate hairline that only wakes up on an edge */
#alp-hud .edgebar{position:relative;margin-top:clamp(9px,1.3vh,15px);
  width:calc(.62 * clamp(150px,min(16.5vw,28vh),282px));height:1px;
  opacity:calc(.34 + .66*var(--carve));
  background:linear-gradient(90deg,rgba(var(--ink),0),rgba(var(--ink),.34) 16%,
    rgba(var(--ink),.34) 84%,rgba(var(--ink),0));
  filter:drop-shadow(0 1px 2px rgba(0,8,20,.5))}
#alp-hud .edgebar .dot{position:absolute;top:-2.5px;left:50%;width:1.5px;height:6px;
  margin-left:-.75px;background:rgba(var(--ink),calc(.6 + .35*var(--carve)));
  transform:translateX(calc(var(--edge) * .31 * clamp(150px,min(16.5vw,28vh),282px)))
            scaleY(calc(1 + .7*var(--carve)));
  box-shadow:0 0 calc(2px + 11px*var(--carve)) rgba(var(--accent),calc(.8*var(--carve))),
             0 1px 3px rgba(0,8,20,.55)}
#alp-hud .edgebar .tick{position:absolute;top:-1.5px;left:50%;width:1px;height:4px;
  margin-left:-.5px;background:rgba(var(--ink),.3)}

/* ------------------------------------------------------------------ air --- */
#alp-hud .air{position:absolute;left:0;bottom:100%;margin-bottom:clamp(15px,2.1vh,26px);
  display:flex;align-items:baseline;gap:.7em;white-space:nowrap;
  opacity:0;transform-origin:0 70%}
#alp-hud .air .lab{font-size:clamp(8px,1.05vh,11px);font-weight:700;letter-spacing:.4em;
  text-transform:uppercase;color:rgba(var(--accent),.95);
  text-shadow:var(--halo),0 2px 12px rgba(0,8,20,.6)}
#alp-hud .air .val{font-size:clamp(24px,3.8vh,44px);font-weight:400;letter-spacing:-.02em;
  color:rgba(var(--ink),.97);
  text-shadow:var(--halo),0 2px 6px rgba(0,8,20,.45),0 8px 34px rgba(0,8,20,.6)}
#alp-hud .air .val b{font-weight:400;font-size:.46em;opacity:.6;margin-left:.18em;letter-spacing:.04em}
#alp-hud .air.live{opacity:.9;animation:none}
#alp-hud .air.hit{animation:alp-air 2.6s cubic-bezier(.16,.9,.24,1) forwards}
#alp-hud .air.hit.big{animation-duration:3.6s}
#alp-hud .air.big .lab{color:rgba(var(--hot),.98)}
#alp-hud .air.big .val{text-shadow:var(--halo),0 0 38px rgba(var(--hot),.45),
  0 2px 6px rgba(0,8,20,.5),0 8px 34px rgba(0,8,20,.6)}
#alp-hud .air .ring{position:absolute;left:0;bottom:-8px;height:1px;
  width:clamp(150px,min(16.5vw,28vh),282px);
  transform-origin:0 50%;transform:scaleX(0);opacity:0;
  background:linear-gradient(90deg,rgba(var(--hot),.95),rgba(var(--hot),.25) 45%,rgba(var(--hot),0))}
#alp-hud .air.hit .ring{animation:alp-sweep 1.6s cubic-bezier(.12,.85,.2,1) forwards}
#alp-hud .air.hit.big .ring{animation-duration:2.2s}
@keyframes alp-air{
  0%{opacity:0;transform:translateY(10px) scale(.93)}
  8%{opacity:1;transform:translateY(0) scale(1.11)}
  20%{transform:translateY(0) scale(1)}
  76%{opacity:1;transform:translateY(-2px) scale(1)}
  100%{opacity:0;transform:translateY(-22px) scale(.99)}}
@keyframes alp-sweep{
  0%{opacity:0;transform:scaleX(0)}
  10%{opacity:.95;transform:scaleX(.32)}
  55%{opacity:.5;transform:scaleX(1)}
  100%{opacity:0;transform:scaleX(1.06)}}

/* ---------------------------------------------------------------- stats --- */
#alp-hud .stats{position:absolute;right:clamp(32px,4vw,84px);bottom:clamp(42px,7.8vh,90px);
  display:grid;grid-template-columns:auto auto;align-items:baseline;justify-items:end;
  column-gap:clamp(11px,.95vw,19px);row-gap:clamp(10px,1.5vh,18px);
  opacity:calc((.78 + .22*var(--live)) * var(--ui));
  transform:translateY(calc(5px - 5px*var(--live) + 12px*(1 - var(--ui))))}
#alp-hud .stats .k{font-size:clamp(9px,1.1vh,12px);font-weight:700;letter-spacing:.24em;
  text-transform:uppercase;color:rgba(var(--ink),.84);
  text-shadow:var(--halo),0 2px 10px rgba(0,8,20,.55)}
#alp-hud .stats .v{font-size:clamp(17px,2.4vh,29px);font-weight:400;letter-spacing:-.01em;
  color:rgba(var(--ink),.97);min-width:4.9ch;text-align:right;
  text-shadow:var(--halo),0 2px 6px rgba(0,8,20,.45),0 6px 26px rgba(0,8,20,.5)}
#alp-hud .stats .v s{text-decoration:none;font-size:.48em;opacity:.66;margin-left:.32em;
  letter-spacing:.09em;font-weight:600}
#alp-hud .stats .hr{grid-column:1/-1;width:clamp(62px,6.4vw,110px);height:1px;
  background:rgba(var(--ink),.24);filter:drop-shadow(0 1px 2px rgba(0,8,20,.5))}

/* --------------------------------------------------------------- warmth --- */
/* A subordinate pip under the run stats, and deliberately almost always
   invisible: it fades in as the tank empties, which is the only moment it is
   information rather than clutter. */
#alp-hud .warmth{position:absolute;right:clamp(32px,4vw,84px);bottom:clamp(20px,3.4vh,42px);
  display:flex;align-items:center;gap:.7em;opacity:calc(var(--warmvis) * var(--ui))}
#alp-hud .warmth .k{font-size:clamp(8px,1.0vh,11px);font-weight:700;letter-spacing:.24em;
  text-transform:uppercase;color:rgba(var(--ink),.72);text-shadow:var(--halo)}
#alp-hud .warmth .b{position:relative;width:clamp(46px,4.6vw,78px);height:2px;
  background:rgba(var(--ink),.2);filter:drop-shadow(0 1px 2px rgba(0,8,20,.5))}
#alp-hud .warmth .b i{position:absolute;inset:0;transform-origin:0 50%;
  transform:scaleX(var(--warm));
  background:linear-gradient(90deg,rgba(255,150,90,.9),rgba(var(--hot),.95))}

/* --------------------------------------------------------------- prompt --- */
/* The contact prompt. Centre-bottom, above the scrim: this is the one moment
   the middle of the frame is allowed to carry type, because it is the frame's
   subject — you are standing at a lift station waiting to be told what to do. */
#alp-hud .prompt{position:absolute;left:50%;bottom:clamp(96px,15.5vh,190px);
  transform:translate(-50%,calc(8px - 8px*var(--prompt)));
  display:flex;align-items:center;gap:.85em;white-space:nowrap;opacity:var(--prompt)}
#alp-hud .prompt .kb{display:inline-flex;align-items:center;justify-content:center;
  min-width:1.9em;height:1.9em;padding:0 .45em;border:1px solid rgba(var(--ink),.62);
  border-radius:5px;background:rgba(4,10,20,.34);
  font-size:clamp(11px,1.5vh,16px);font-weight:700;letter-spacing:.06em;
  color:rgba(var(--ink),.97);text-shadow:var(--halo);
  box-shadow:0 1px 3px rgba(0,8,20,.5),inset 0 1px 0 rgba(255,255,255,.14)}
#alp-hud .prompt .tx{font-size:clamp(14px,1.95vh,21px);font-weight:400;letter-spacing:.01em;
  color:rgba(var(--ink),.97);text-shadow:var(--halo),0 2px 10px rgba(0,8,20,.55)}
#alp-hud .prompt .sb{font-size:clamp(9px,1.15vh,12px);font-weight:700;letter-spacing:.22em;
  text-transform:uppercase;color:rgba(var(--accent),.86);text-shadow:var(--halo)}
#alp-hud .prompt.cold .sb{color:rgba(var(--hot),.94)}

/* ----------------------------------------------------------------- ride --- */
/* Top-centre, tiny: on a lift the picture is the point, so this is a caption
   and a progress keel, nothing more. */
#alp-hud .ride{position:absolute;left:50%;top:clamp(26px,4.4vh,54px);
  transform:translate(-50%,calc(-6px + 6px*var(--ride)));
  display:flex;flex-direction:column;align-items:center;gap:.55em;opacity:var(--ride)}
#alp-hud .ride .n{font-size:clamp(9px,1.2vh,13px);font-weight:700;letter-spacing:.34em;
  text-transform:uppercase;color:rgba(var(--ink),.9);text-shadow:var(--halo),0 2px 10px rgba(0,8,20,.5)}
#alp-hud .ride .rail2{position:relative;width:clamp(160px,20vw,300px);height:3px}
#alp-hud .ride .rail2 b{position:absolute;left:0;right:0;top:1px;height:1px;
  background:rgba(var(--ink),.26)}
#alp-hud .ride .rail2 i{position:absolute;left:0;top:0;height:3px;right:0;
  clip-path:inset(0 calc(100% - 100%*var(--rp,0)) 0 0);
  background:linear-gradient(90deg,rgba(var(--ink),.5),rgba(var(--accent),.95))}
#alp-hud .ride .rail2 u{position:absolute;top:-2px;width:1.4px;height:7px;
  transform:translateX(calc(var(--rp,0) * clamp(160px,20vw,300px)));
  background:rgba(var(--ink),.95);box-shadow:0 0 6px rgba(var(--accent),.6)}
#alp-hud .ride .h{font-size:clamp(8px,1.05vh,11px);font-weight:600;letter-spacing:.2em;
  text-transform:uppercase;color:rgba(var(--ink),.62);text-shadow:var(--halo)}

/* ----------------------------------------------------------------- card --- */
/* The bar card. Anchored bottom-left over the empty part of the interior shot
   rather than centred, so the window and the mug stay the picture. */
#alp-hud .card{position:absolute;left:clamp(32px,4vw,84px);bottom:clamp(40px,7.6vh,92px);
  min-width:clamp(230px,22vw,330px);opacity:var(--card);
  transform:translateY(calc(10px - 10px*var(--card)))}
#alp-hud .card .hd{font-size:clamp(10px,1.3vh,14px);font-weight:700;letter-spacing:.3em;
  text-transform:uppercase;color:rgba(var(--hot),.95);text-shadow:var(--halo),0 2px 10px rgba(0,8,20,.6)}
#alp-hud .card .rule{margin:.7em 0 .8em;width:100%;height:1px;background:rgba(var(--ink),.22)}
#alp-hud .card .row{display:flex;justify-content:space-between;align-items:baseline;
  gap:1.4em;margin:.28em 0}
#alp-hud .card .row .k{font-size:clamp(8px,1.05vh,11px);font-weight:700;letter-spacing:.22em;
  text-transform:uppercase;color:rgba(var(--ink),.66);text-shadow:var(--halo)}
#alp-hud .card .row .v{font-size:clamp(13px,1.7vh,19px);font-weight:400;
  color:rgba(var(--ink),.96);text-shadow:var(--halo),0 2px 8px rgba(0,8,20,.5)}
#alp-hud .card .row .v s{text-decoration:none;font-size:.5em;opacity:.6;margin-left:.3em;
  letter-spacing:.09em;font-weight:600}
#alp-hud .card .opts{margin-top:.95em;display:flex;flex-direction:column;gap:.5em}
#alp-hud .card .opt{display:flex;align-items:center;gap:.7em}
#alp-hud .card .opt .kb{display:inline-flex;align-items:center;justify-content:center;
  width:1.6em;height:1.6em;border:1px solid rgba(var(--ink),.5);border-radius:4px;
  background:rgba(4,10,20,.3);font-size:clamp(9px,1.2vh,12px);font-weight:700;
  color:rgba(var(--ink),.95);text-shadow:var(--halo)}
#alp-hud .card .opt .l{font-size:clamp(12px,1.55vh,17px);color:rgba(var(--ink),.95);
  text-shadow:var(--halo),0 2px 8px rgba(0,8,20,.5)}
#alp-hud .card .opt .n{font-size:clamp(8px,1.0vh,11px);letter-spacing:.14em;
  text-transform:uppercase;color:rgba(var(--ink),.55);text-shadow:var(--halo)}
#alp-hud .card .opt.on .l{color:rgba(var(--hot),.98)}
#alp-hud .card .note{margin-top:.85em;font-size:clamp(10px,1.3vh,14px);font-style:italic;
  color:rgba(var(--hot),.92);text-shadow:var(--halo),0 2px 10px rgba(0,8,20,.5);
  min-height:1.3em}

/* ------------------------------------------------------- veil and flash --- */
/* A door is a cut, and a cut with nothing over it reads as a bug. Pale rather
   than black: this is a snow game in full sun and a black dip looks like a
   crash. */
#alp-hud .veil{position:absolute;inset:0;background:rgb(238,244,252);
  opacity:calc(var(--veil) * .92)}
#alp-hud .flash{position:absolute;inset:0;opacity:var(--glow);
  background:radial-gradient(120% 90% at 50% 100%,
    rgba(255,176,96,.30) 0%,rgba(255,168,88,.12) 45%,rgba(255,160,80,0) 78%)}
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
      <div class="rail"><span class="k"></span><span class="t"></span><span class="T"></span
        ><span class="r"></span><span class="f"></span><span class="fh"></span
        ><span class="kl"></span><u></u><span class="cap"></span></div>
      <div class="edgebar"><span class="tick"></span><span class="dot"></span></div>
    </div>
    <div class="stats">
      <span class="k">Time</span><span class="v" id="alp-t">0:00.0</span>
      <span class="hr"></span>
      <span class="k">Dist</span><span class="v" id="alp-d">0<s>m</s></span>
      <span class="k">Top</span><span class="v" id="alp-x">0<s>km/h</s></span>
    </div>
    <div class="warmth"><span class="k">Warmth</span><span class="b"><i></i></span></div>
    <div class="ride">
      <span class="n" id="alp-rn">Chairlift</span>
      <span class="rail2"><b></b><i></i><u></u></span>
      <span class="h" id="alp-rh"></span>
    </div>
    <div class="prompt">
      <span class="kb" id="alp-pk">E</span>
      <span class="tx" id="alp-pt">Ride the chairlift</span>
      <span class="sb" id="alp-ps"></span>
    </div>
    <div class="card">
      <div class="hd" id="alp-cn">Bergrestaurant</div>
      <div class="rule"></div>
      <div class="row"><span class="k">Run</span><span class="v" id="alp-cr">0:00.0</span></div>
      <div class="row"><span class="k">Dist</span><span class="v" id="alp-cd">0<s>m</s></span></div>
      <div class="row"><span class="k">Top</span><span class="v" id="alp-cx">0<s>km/h</s></span></div>
      <div class="row"><span class="k">Best air</span><span class="v" id="alp-ca">0.00<s>s</s></span></div>
      <div class="opts" id="alp-co"></div>
      <div class="note" id="alp-cm"></div>
    </div>
    <div class="flash"></div>
    <div class="veil"></div>`;
  (opts.parent ?? doc.body).appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const elNum = $('.num');
  const elAir = $('.air');
  const elAirVal = $('.air .val');
  const elT = $('#alp-t');
  const elD = $('#alp-d');
  const elX = $('#alp-x');
  const elBest = $('.rail u');
  // resort layer
  const elPrompt = $('.prompt');
  const elPK = $('#alp-pk'), elPT = $('#alp-pt'), elPS = $('#alp-ps');
  const elRide = $('.ride'), elRN = $('#alp-rn'), elRH = $('#alp-rh');
  const elRail2 = $('.ride .rail2');
  const elCard = $('.card'), elCN = $('#alp-cn'), elCO = $('#alp-co'), elCM = $('#alp-cm');
  const elCR = $('#alp-cr'), elCD = $('#alp-cd'), elCX = $('#alp-cx'), elCA = $('#alp-ca');

  // ---- animated internals ---------------------------------------------------
  let dSpeed = 0, dLive = 0, dHeat = 0, dEdge = 0, dCarve = 0, dKick = 1, dLand = 0;
  let topKmh = 0, airT = 0, airHold = 0, wasAir = false, boost = 0, landFlash = 0;
  let lastNum = -1, lastT = '', lastD = '', lastX = '', lastRun = -1, airShown = false;
  let dUI = 1, dPrompt = 0, dRide = 0, dCard = 0, dWarmVis = 0;
  let lastPromptTx = '', lastPromptK = '', lastPromptSb = '', lastRideN = '', lastRideH = '';
  let lastOpts = '', lastNote = '', lastCard = '';
  const w = {
    live: -1, heat: -1, edge: -9, carve: -1, p: -1, kick: -1, land: -1,
    ui: -1, veil: -1, glow: -1, prompt: -1, ride: -1, card: -1, warm: -1, warmvis: -1, rp: -1,
  };

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
      landFlash = 0; airShown = false;
      elAir.classList.remove('hit', 'big', 'live');
    }
    lastRun = runT;
    if (kmh > topKmh) topKmh = kmh;

    // hero readout: critically-damped chase so the number never twitches
    const prevS = dSpeed;
    dSpeed = smooth(dSpeed, kmh, d, 0.11);
    const accel = (dSpeed - prevS) / Math.max(d, 1e-3);

    // ---- air ---------------------------------------------------------------
    // The terrain throws 40+ hops of 0.1-0.3 s at a fast run. Only sustained
    // flight is allowed to put anything on screen, otherwise the badge strobes.
    if (airborne) {
      airT += d;
      const declared = state.airTime ?? 0;
      if (declared > airT) airT = declared;
    }
    if (wasAir && !airborne) {
      if (airShown) {
        const big = airT > AIR_BIG;
        elAirVal.innerHTML = airT.toFixed(2) + '<b>s</b>';
        elAir.classList.remove('live', 'hit', 'big');
        void elAir.offsetWidth;                     // restart the keyframe
        elAir.classList.add('hit');
        if (big) elAir.classList.add('big');
        boost = clamp(0.5 + airT * 0.5, 0, 1);
        landFlash = 1;                              // accent-rule flash on touchdown
        airHold = big ? 3.6 : 2.6;
      }
      airT = 0; airShown = false;
    }
    if (!wasAir && airborne) elAir.classList.remove('hit', 'big');
    if (airborne && airT > AIR_MIN) {
      if (!airShown) { airShown = true; elAir.classList.add('live'); }
      const v = airT.toFixed(2) + '<b>s</b>';
      if (elAirVal.innerHTML !== v) elAirVal.innerHTML = v;
    }
    wasAir = airborne;
    if (airHold > 0) { airHold -= d; if (airHold <= 0) elAir.classList.remove('hit', 'big'); }

    // ---- derived intensities ----------------------------------------------
    // Tuned to the measured envelope: `live` saturates at ~70 km/h (a fast
    // schuss), `heat` at ~92 (a full tuck), so the HUD still has somewhere to go
    // when the run is genuinely quick instead of pinning at 52 km/h.
    boost = Math.max(0, boost - d * 0.55);
    landFlash = Math.max(0, landFlash - d * 1.5);
    const gForce = state.gForce ?? 0;
    const liveT = clamp(
      clamp((kmh - 8) / 62, 0, 1) * 0.7 + clamp(gForce / 2.6, 0, 1) * 0.22 +
      (airShown ? 0.3 : 0) + boost * 0.36, 0, 1);
    dLive = smooth(dLive, liveT, d, liveT > dLive ? 0.16 : 0.55);
    dHeat = smooth(dHeat, clamp((kmh - 40) / 52, 0, 1) + (airborne ? 0.12 : 0), d, 0.28);
    dEdge = smooth(dEdge, clamp(state.edge ?? 0, -1, 1), d, 0.07);
    dCarve = smooth(dCarve, state.carving ? clamp(0.45 + Math.abs(state.edge ?? 0), 0, 1) : 0, d, 0.12);
    dKick = smooth(dKick, 1 + clamp(accel, -18, 34) * 0.0016, d, 0.09);
    dLand = smooth(dLand, landFlash, d, 0.06);

    setVar('live', dLive);
    setVar('heat', clamp(dHeat, 0, 1));
    setVar('edge', clamp(dEdge, -1, 1), 0.002);
    setVar('carve', dCarve);
    setVar('land', dLand, 0.01);
    setVar('p', clamp(dSpeed / V_FULL, 0, 1), 0.0012);
    if (Math.abs(dKick - w.kick) > 0.002) { w.kick = dKick; elNum.style.setProperty('--kick', dKick.toFixed(3)); }

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
      const bp = clamp(topKmh / V_FULL, 0, 1);
      elBest.style.left = (bp * 100).toFixed(2) + '%';
      // only show the ghost once it is meaningfully behind the live needle
      elBest.style.opacity = topKmh > 25 ? '0.6' : '0';
    }

    updateResort(d, state);
  }

  /**
   * The resort layer. Four elements, each driven by one opacity variable, and
   * every text node diffed before it is written — the same discipline as the
   * speed block, for the same reason: this runs every frame.
   */
  function updateResort(d, state) {
    const mode = state.mode || 'ski';
    const indoors = mode === 'lift' || mode === 'hut';

    // instruments fade out when they stop meaning anything
    dUI = smooth(dUI, indoors ? 0 : 1, d, indoors ? 0.20 : 0.34);
    setVar('ui', dUI);
    setVar('veil', clamp(state.veil ?? 0, 0, 1), 0.004);
    setVar('glow', clamp(state.glow ?? 0, 0, 1) * 0.85, 0.004);

    // ---- contact prompt ----------------------------------------------------
    const pr = state.prompt || null;
    dPrompt = smooth(dPrompt, pr ? 1 : 0, d, pr ? 0.14 : 0.20);
    setVar('prompt', dPrompt);
    if (pr) {
      if (pr.key !== lastPromptK) { lastPromptK = pr.key; elPK.textContent = pr.key; }
      if (pr.text !== lastPromptTx) { lastPromptTx = pr.text; elPT.textContent = pr.text; }
      const sb = pr.sub || '';
      if (sb !== lastPromptSb) { lastPromptSb = sb; elPS.textContent = sb; }
      const cold = pr.ready === false;
      if (elPrompt.classList.contains('cold') !== cold) elPrompt.classList.toggle('cold', cold);
    }

    // ---- ride progress -----------------------------------------------------
    const rd = state.ride || null;
    dRide = smooth(dRide, rd ? 1 : 0, d, 0.22);
    setVar('ride', dRide);
    if (rd) {
      const nm = (rd.name || '').toUpperCase();
      if (nm !== lastRideN) { lastRideN = nm; elRN.textContent = nm; }
      const hint = rd.hint || '';
      if (hint !== lastRideH) { lastRideH = hint; elRH.textContent = hint; }
      const p = clamp(rd.progress || 0, 0, 1);
      if (Math.abs(p - w.rp) > 0.002) { w.rp = p; elRail2.style.setProperty('--rp', p.toFixed(4)); }
    }

    // ---- bar card ----------------------------------------------------------
    const ht = state.hut || null;
    dCard = smooth(dCard, ht ? 1 : 0, d, ht ? 0.24 : 0.18);
    setVar('card', dCard);
    if (ht) {
      if (ht.name !== lastCard) { lastCard = ht.name; elCN.textContent = ht.name; }
      const r = ht.run || { time: 0, distance: 0, top: 0, air: 0 };
      elCR.textContent = fmtTime(r.time || 0);
      const dm = r.distance || 0;
      elCD.innerHTML = (dm < 1000 ? Math.round(dm) + '<s>m</s>' : (dm / 1000).toFixed(2) + '<s>km</s>');
      elCX.innerHTML = Math.round((r.top || 0) * 3.6) + '<s>km/h</s>';
      elCA.innerHTML = (r.air || 0).toFixed(2) + '<s>s</s>';
      const opts = (ht.choices || []).map((c) => `<div class="opt${ht.drink && c.label.toLowerCase() === ht.drink ? ' on' : ''}">`
        + `<span class="kb">${c.key}</span><span class="l">${c.label}</span><span class="n">${c.note || ''}</span></div>`).join('')
        + `<div class="opt"><span class="kb">E</span><span class="l">Back outside</span></div>`;
      if (opts !== lastOpts) { lastOpts = opts; elCO.innerHTML = opts; }
      const note = ht.drink
        ? (ht.drink === 'beer' ? 'Prost. The afternoon can wait.' : 'Hot, black, and worth the stop.')
        : (ht.hint || '');
      if (note !== lastNote) { lastNote = note; elCM.textContent = note; }
    }

    // ---- warmth ------------------------------------------------------------
    const wm = clamp(state.warmth ?? 1, 0, 1);
    setVar('warm', wm, 0.004);
    dWarmVis = smooth(dWarmVis, wm < 0.62 ? clamp((0.62 - wm) * 3.2, 0, 1) : 0, d, 0.4);
    setVar('warmvis', dWarmVis);
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
