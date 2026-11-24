/* Colour picker popover — Adobe-style: hue ring with the saturation/brightness square inside it,
   eyedropper, previous/current chips, HEX + RGB fields and saved swatches.

   One module serves both shells. installColorPicker() takes over EVERY <input type="color"> in the
   document: a click (or a programmatic showPicker()) opens this popover instead of the browser's
   native dialog, and edits write back to the input with real 'input' events (so React's onChange
   and the demo's listeners fire exactly as they would for the native control). It's dependency-free
   because the demo loads core as plain ES modules, and no single-file ring+square widget exists as
   a vendorable library. */

const SW_KEY = 'canvasmith.swatches';
const MAX_SWATCHES = 24;

/* ── colour maths ───────────────────────────────────────────────────────────────────────── */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function hexToRgb(h) {
  let s = String(h || '').trim().replace(/^#/, '');
  if (s.length === 3) s = s.replace(/./g, c => c + c);
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx];
}
export function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

/* ── styles ─────────────────────────────────────────────────────────────────────────────── */
const CSS = `
.cmcp{position:fixed;z-index:2147483000;width:304px;box-sizing:border-box;padding:14px 16px 16px;border-radius:12px;
  background:var(--panel-2,var(--cm-panel-2,#232323));color:var(--ink,var(--cm-ink,#e8e8e8));
  border:1px solid var(--line,var(--cm-line,#3a3a3a));box-shadow:0 12px 40px rgba(0,0,0,.45);
  font:12px/1.3 Inter,system-ui,sans-serif;user-select:none;-webkit-user-select:none}
.cmcp *{box-sizing:border-box}
.cmcp-title{display:inline-block;font-size:14px;padding-bottom:5px;border-bottom:2px solid currentColor;margin-bottom:12px}
.cmcp-stage{position:relative;width:240px;height:240px;margin:0 auto}
.cmcp-ring{position:absolute;inset:0;border-radius:50%;cursor:crosshair;touch-action:none;
  background:conic-gradient(from 90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00);
  -webkit-mask:radial-gradient(circle,transparent 0 76px,#000 77px);mask:radial-gradient(circle,transparent 0 76px,#000 77px)}
.cmcp-sq{position:absolute;left:60px;top:60px;width:120px;height:120px;border-radius:7px;cursor:crosshair;touch-action:none;
  background:linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent),var(--cmcp-hue,#f00);
  box-shadow:0 0 0 1px rgba(255,255,255,.08)}
.cmcp-knob{position:absolute;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;border:2px solid #fff;
  box-shadow:0 0 0 1px rgba(0,0,0,.45),inset 0 0 0 1px rgba(0,0,0,.25);pointer-events:none}
.cmcp-eye{all:unset;position:absolute;right:-4px;top:-4px;width:30px;height:30px;display:grid;place-items:center;cursor:pointer;border-radius:6px;opacity:.85}
.cmcp-eye:hover{opacity:1;background:rgba(127,127,127,.18)}
.cmcp-ring:focus-visible,.cmcp-sq:focus-visible{outline:2px solid var(--accent,var(--cm-accent,#4f8ff0));outline-offset:3px}
.cmcp-eye:focus-visible,.cmcp-add:focus-visible,.cmcp-sw:focus-visible{outline:2px solid var(--accent,var(--cm-accent,#4f8ff0));outline-offset:1px}
.cmcp-row{display:flex;align-items:center;gap:12px;margin-top:14px}
.cmcp-chips{display:flex;width:92px;height:36px;border-radius:10px;overflow:hidden;border:2px solid rgba(127,127,127,.35);flex:none}
.cmcp-chips i{flex:1;cursor:pointer}
.cmcp-lab{margin-left:auto;opacity:.7}
.cmcp-in{height:34px;min-width:0;padding:0 10px;border-radius:8px;border:2px solid rgba(127,127,127,.35);
  background:var(--bg,var(--cm-bg,#111));color:inherit;font:inherit;font-size:13px;text-transform:uppercase;user-select:text;-webkit-user-select:text}
.cmcp-in:focus{outline:none;border-color:var(--accent,var(--cm-accent,#4f8ff0))}
.cmcp-hex{width:100px}
.cmcp-hr{height:1px;background:rgba(127,127,127,.28);margin:14px -16px 0}
.cmcp-mode{display:flex;align-items:center;gap:6px;margin-top:14px;font-size:14px}
.cmcp-rgb{display:flex;align-items:center;gap:6px;margin-top:10px}
.cmcp-rgb label{opacity:.7;width:10px;text-align:center}
.cmcp-rgb .cmcp-in{width:56px;text-align:left;margin-right:4px}
.cmcp-sh{display:flex;align-items:center;justify-content:space-between;margin-top:14px;font-size:14px;font-weight:600}
.cmcp-del{all:unset;cursor:pointer;opacity:.5;display:grid;place-items:center;width:26px;height:26px;border-radius:6px}
.cmcp-del:hover{opacity:1;background:rgba(127,127,127,.18)}
.cmcp-del[hidden]{display:none}
.cmcp-sws{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.cmcp-sw,.cmcp-add{all:unset;box-sizing:border-box;width:32px;height:32px;border-radius:8px;cursor:pointer;border:1px solid rgba(127,127,127,.4)}
.cmcp-sw[data-sel=true]{box-shadow:0 0 0 2px var(--panel-2,var(--cm-panel-2,#232323)),0 0 0 3.5px currentColor}
.cmcp-add{display:grid;place-items:center;background:rgba(127,127,127,.16);border-color:transparent;width:40px;height:40px}
.cmcp-add:hover{background:rgba(127,127,127,.28)}
`;
const ICON_EYE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5l4 4"/><path d="M16 4a2.1 2.1 0 013 3l-2 2-3-3z"/><path d="M14.5 8.5L5 18l-.6 2.6L7 20l9.5-9.5"/></svg>';
const ICON_TRASH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg>';
const ICON_CHEV = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

/* ── swatch storage (best-effort: private windows / blocked storage just skip persistence) ── */
function loadSwatches() { try { const a = JSON.parse(localStorage.getItem(SW_KEY)); return Array.isArray(a) ? a.filter(c => hexToRgb(c)) : []; } catch (e) { return []; } }
function saveSwatches(a) { try { localStorage.setItem(SW_KEY, JSON.stringify(a)); } catch (e) { /* ignore */ } }

/* Writes a value to a colour input and fires the events a native pick would. React tracks the
   input's value, so the native setter is used or its onChange would see "no change". */
function commit(input, hex, final) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(input, hex);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (final) input.dispatchEvent(new Event('change', { bubbles: true }));
}

/* ── the popover ────────────────────────────────────────────────────────────────────────── */
let pop = null;        // { el, input, close }
let cssDone = false;

export function closeColorPicker() { if (pop) pop.close(); }

export function openColorPicker(input, e0) {
  if (!input || input.disabled) return;
  if (pop && pop.input === input) { pop.close(); return; }
  closeColorPicker();
  if (!cssDone) { const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); cssDone = true; }

  const start = hexToRgb(input.value) || [0, 0, 0];
  let [h, s, v] = rgbToHsv(...start);
  const original = rgbToHex(...start);
  let swatches = loadSwatches();

  const el = document.createElement('div');
  el.className = 'cmcp'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Select a color');
  el.innerHTML = `
    <div class="cmcp-title">Select a color</div>
    <div class="cmcp-stage">
      <div class="cmcp-ring" tabindex="0" role="slider" aria-label="Hue" aria-valuemin="0" aria-valuemax="360"></div><div class="cmcp-sq" tabindex="0" role="slider" aria-label="Saturation and brightness"></div>
      <div class="cmcp-knob" data-k="h"></div><div class="cmcp-knob" data-k="sv"></div>
      <button class="cmcp-eye" type="button" title="Pick from screen" aria-label="Pick colour from screen">${ICON_EYE}</button>
    </div>
    <div class="cmcp-row">
      <div class="cmcp-chips"><i data-c="cur" title="Current"></i><i data-c="old" title="Original — click to revert"></i></div>
      <span class="cmcp-lab">HEX</span>
      <input class="cmcp-in cmcp-hex" spellcheck="false" maxlength="7" aria-label="Hex colour">
    </div>
    <div class="cmcp-hr"></div>
    <div class="cmcp-mode">RGB ${ICON_CHEV}</div>
    <div class="cmcp-rgb">
      <label>R</label><input class="cmcp-in" data-ch="0" inputmode="numeric" aria-label="Red">
      <label>G</label><input class="cmcp-in" data-ch="1" inputmode="numeric" aria-label="Green">
      <label>B</label><input class="cmcp-in" data-ch="2" inputmode="numeric" aria-label="Blue">
    </div>
    <div class="cmcp-hr"></div>
    <div class="cmcp-sh"><span>Swatches</span><button class="cmcp-del" type="button" title="Delete selected swatch" aria-label="Delete swatch" hidden>${ICON_TRASH}</button></div>
    <div class="cmcp-sws"></div>`;
  (input.closest('.cm-root') || document.body).appendChild(el);   // inside the React shell's root so its --cm-* theme tokens apply

  const $ = (q) => el.querySelector(q);
  const ring = $('.cmcp-ring'), sq = $('.cmcp-sq'), kH = $('[data-k=h]'), kSV = $('[data-k=sv]');
  const hexIn = $('.cmcp-hex'), rgbIns = [...el.querySelectorAll('[data-ch]')];
  const chipCur = $('[data-c=cur]'), chipOld = $('[data-c=old]');
  const swEl = $('.cmcp-sws'), delBtn = $('.cmcp-del');
  chipOld.style.background = original;

  const cur = () => rgbToHex(...hsvToRgb(h, s, v));

  function paint(skip) {
    const hex = cur(), rgb = hsvToRgb(h, s, v).map(Math.round);
    sq.style.setProperty('--cmcp-hue', `hsl(${h} 100% 50%)`);
    // hue knob rides the ring's centre line (radius 98 of the 120 outer / 77 inner)
    const ang = h * Math.PI / 180;
    kH.style.left = 120 + 98 * Math.cos(ang) + 'px'; kH.style.top = 120 + 98 * Math.sin(ang) + 'px';
    kH.style.background = `hsl(${h} 100% 50%)`;
    kSV.style.left = s * 120 + 60 + 'px'; kSV.style.top = (1 - v) * 120 + 60 + 'px';
    kSV.style.background = hex;
    chipCur.style.background = hex;
    ring.setAttribute('aria-valuenow', Math.round(h)); ring.setAttribute('aria-valuetext', Math.round(h) + ' degrees');
    sq.setAttribute('aria-valuetext', 'Saturation ' + Math.round(s * 100) + '%, brightness ' + Math.round(v * 100) + '%');
    if (skip !== 'hex') hexIn.value = hex;
    if (skip !== 'rgb') rgbIns.forEach((n, i) => { n.value = rgb[i]; });
    delBtn.hidden = !swatches.includes(hex);
    swEl.querySelectorAll('.cmcp-sw').forEach(b => { b.dataset.sel = String(b.dataset.c === hex); });
  }
  const apply = (skip, final) => { paint(skip); commit(input, cur(), final); };

  // Hue ring: the conic gradient starts at 3 o'clock (red) and runs clockwise, so hue == the
  // on-screen angle from 3 o'clock.
  function hueFromPoint(e) {
    const r = ring.getBoundingClientRect();
    const ang = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
    return (ang + 360) % 360;
  }
  function drag(target, move) {
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // The ring's bounding box is square; only the annulus should start a drag.
      if (target === ring) {
        const r = ring.getBoundingClientRect(), d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (d < 77 || d > 121) return;
      }
      e.preventDefault(); target.setPointerCapture(e.pointerId); move(e);
      const mv = (ev) => move(ev);
      const up = () => { target.removeEventListener('pointermove', mv); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); commit(input, cur(), true); };
      target.addEventListener('pointermove', mv); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
    });
  }
  drag(ring, (e) => { h = hueFromPoint(e); apply(); });
  drag(sq, (e) => {
    const r = sq.getBoundingClientRect();
    s = clamp((e.clientX - r.left) / r.width, 0, 1); v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
    apply();
  });

  // Keyboard: arrows nudge (Shift = x10). Ring = hue, square = saturation (left/right) + brightness (up/down).
  ring.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]; if (!d) return;
    e.preventDefault(); h = (h + d * (e.shiftKey ? 10 : 1) + 360) % 360; apply(null, true);
  });
  sq.addEventListener('keydown', (e) => {
    const k = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key]; if (!k) return;
    e.preventDefault(); const st = e.shiftKey ? 0.1 : 0.01;
    s = clamp(s + k[0] * st, 0, 1); v = clamp(v + k[1] * st, 0, 1); apply(null, true);
  });

  function setFromHex(hex, final) {
    const rgb = hexToRgb(hex); if (!rgb) return false;
    const [nh, ns, nv] = rgbToHsv(...rgb);
    h = ns === 0 || nv === 0 ? h : nh; s = ns; v = nv;     // grey/black keep the hue so the ring doesn't jump
    apply(null, final); return true;
  }

  hexIn.addEventListener('input', () => { const t = hexIn.value; if (/^#?[0-9a-f]{6}$/i.test(t.trim())) setFromHex(t, false); });
  hexIn.addEventListener('change', () => { if (!setFromHex(hexIn.value, true)) hexIn.value = cur(); });
  rgbIns.forEach((n) => {
    n.addEventListener('input', () => {
      const vals = rgbIns.map(x => clamp(parseInt(x.value, 10), 0, 255));
      if (vals.some(Number.isNaN)) return;
      const [nh, ns, nv] = rgbToHsv(...vals); h = ns === 0 || nv === 0 ? h : nh; s = ns; v = nv;
      apply('rgb', false);
    });
    n.addEventListener('change', () => { commit(input, cur(), true); paint(); });
    n.addEventListener('keydown', (e) => {   // arrow keys nudge, shift = ×10, like a number field
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      n.value = clamp((parseInt(n.value, 10) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1), 0, 255);
      n.dispatchEvent(new Event('input'));
    });
  });
  chipOld.addEventListener('click', () => setFromHex(original, true));

  const eye = $('.cmcp-eye');
  if (typeof window.EyeDropper !== 'function') eye.style.display = 'none';
  else eye.addEventListener('click', async () => {
    try { const r = await new window.EyeDropper().open(); if (r && r.sRGBHex) setFromHex(r.sRGBHex, true); } catch (e) { /* cancelled */ }
  });

  function renderSwatches() {
    swEl.innerHTML = '';
    swatches.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cmcp-sw'; b.dataset.c = c; b.title = c; b.style.background = c;
      b.addEventListener('click', () => setFromHex(c, true));
      swEl.appendChild(b);
    });
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'cmcp-add'; add.title = 'Save current colour as a swatch'; add.setAttribute('aria-label', 'Add swatch');
    add.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    add.addEventListener('click', () => {
      const c = cur(); if (swatches.includes(c)) return;
      swatches = [c, ...swatches].slice(0, MAX_SWATCHES); saveSwatches(swatches); renderSwatches(); paint();
    });
    swEl.appendChild(add);
  }
  delBtn.addEventListener('click', () => { const c = cur(); swatches = swatches.filter(x => x !== c); saveSwatches(swatches); renderSwatches(); paint(); });
  renderSwatches();

  // Position: under the input, flipped above / clamped when there's no room.
  const place = () => {
    const r = input.getBoundingClientRect(), w = el.offsetWidth, hgt = el.offsetHeight, m = 8;
    let x = r.left, y = r.bottom + 6;
    if (r.width < 4 && r.height < 4 && !r.left && !r.top) { x = (innerWidth - w) / 2; y = (innerHeight - hgt) / 2; }
    if (y + hgt > innerHeight - m) y = Math.max(m, r.top - hgt - 6);
    if (y + hgt > innerHeight - m) y = Math.max(m, innerHeight - hgt - m);
    x = clamp(x, m, Math.max(m, innerWidth - w - m));
    el.style.left = x + 'px'; el.style.top = y + 'px';
  };

  const onDown = (e) => { if (!el.contains(e.target) && e.target !== input) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('resize', close);
    const had = el.contains(document.activeElement);
    el.remove(); if (pop && pop.el === el) pop = null;
    if (had && input.isConnected) { try { input.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  addEventListener('resize', close);
  pop = { el, input, close };
  paint(); place();
  if (e0 && e0.detail === 0) hexIn.focus();   // opened by keyboard (Enter/Space): move focus in; mouse opens leave it alone
}

/* Takes over every colour input in `doc`. Idempotent; returns an uninstall function. */
let installed = null;
export function installColorPicker(doc = document) {
  if (installed) return installed;
  const onClick = (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== 'color') return;
    e.preventDefault();               // suppress the native dialog
    openColorPicker(t, e);
  };
  doc.addEventListener('click', onClick, true);
  // Keyboard: Space/Enter on a focused colour input fires a click in browsers, so it's covered.
  // Programmatic input.showPicker() (the gradient stop swatch uses it) must open ours too.
  const proto = HTMLInputElement.prototype, orig = proto.showPicker;
  proto.showPicker = function () { if (this.type === 'color') openColorPicker(this); else if (orig) return orig.call(this); };
  installed = () => { doc.removeEventListener('click', onClick, true); proto.showPicker = orig; closeColorPicker(); installed = null; };
  return installed;
}
