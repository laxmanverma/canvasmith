/* Blend-mode picker: a button showing the current mode with a live thumbnail, opening a grouped list where every
   mode previews what it does (the same sample layer blended over the same sample scene), with a tick on the
   current one. Replaces a bare <select> of words, which tells nobody what "Burn" or "Hue" will look like.

   One module for both shells. mountBlendPicker(host, { get, set }) returns { sync(value), setDisabled(bool) }.
   Fully keyboard-operable (Enter/Space/ArrowDown opens, arrows move, Home/End, Enter picks, Esc closes). */

/* [canvas operation, label, one-line meaning]. Groups follow Photoshop's: normal | darken | lighten | contrast |
   comparative | colour. Only operations a 2D canvas can really draw are listed. */
export const BLEND_GROUPS = [
  [['source-over', 'Normal', 'Covers what is below']],
  [['darken', 'Darken', 'Keeps the darker of the two'], ['multiply', 'Multiply', 'Darkens, like stacked film'], ['color-burn', 'Color burn', 'Deepens shadows and colour']],
  [['lighten', 'Lighten', 'Keeps the lighter of the two'], ['screen', 'Screen', 'Lightens, like projected light'], ['color-dodge', 'Color dodge', 'Brightens and washes out']],
  [['overlay', 'Overlay', 'Contrast: multiply dark, screen light'], ['soft-light', 'Soft light', 'A gentle contrast lift'], ['hard-light', 'Hard light', 'A harsh contrast push']],
  [['difference', 'Difference', 'Subtracts one from the other']],
  [['hue', 'Hue', 'This colour tone, below’s depth'], ['saturation', 'Saturation', 'This colourfulness only'], ['color', 'Color', 'This colour, below’s light'], ['luminosity', 'Luminosity', 'This light, below’s colour']],
];
export const BLEND_MODES = BLEND_GROUPS.flat().map(([v, l]) => [v, l]);
const LABEL = Object.fromEntries(BLEND_MODES);
const DESC = Object.fromEntries(BLEND_GROUPS.flat().map(([v, , d]) => [v, d]));

const SIZE = 44;   // CSS px of a thumbnail; drawn at 2x
const cache = new Map();

/* Preview from the user's OWN layers: `below` is what is under the selected layer (null = nothing, falls back to the
   sample scene), `top` is the layer itself. Both are canvases already cropped to the layer's bounds. */
export function blendThumbFrom(mode, { below, top }) {
  const n = SIZE * 2, c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d');
  if (below) g.drawImage(below, 0, 0, n, n); else g.drawImage(sampleScene(), 0, 0, n, n);
  g.globalCompositeOperation = mode; g.drawImage(top, 0, 0, n, n);
  return c.toDataURL('image/png');
}

/* The preview: a dusk landscape as the layer BELOW, a blue->orange ramp as the layer ON TOP blended with `mode`.
   Drawn once per mode and cached as a data URL. */
let _scene = null;
function sampleScene() {
  if (_scene) return _scene;
  const n = SIZE * 2, c = _scene = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, n); sky.addColorStop(0, '#2c4a8a'); sky.addColorStop(.55, '#e7a86a'); sky.addColorStop(1, '#f3d9a4');
  g.fillStyle = sky; g.fillRect(0, 0, n, n);
  g.fillStyle = '#fff4d0'; g.beginPath(); g.arc(n * .7, n * .42, n * .09, 0, 7); g.fill();
  g.fillStyle = '#4b5d6e'; g.beginPath(); g.moveTo(0, n * .72); g.lineTo(n * .3, n * .5); g.lineTo(n * .55, n * .68); g.lineTo(n * .8, n * .52); g.lineTo(n, n * .7); g.lineTo(n, n); g.lineTo(0, n); g.fill();
  g.fillStyle = '#1f3a2c'; g.beginPath(); g.moveTo(0, n * .86); g.lineTo(n * .35, n * .72); g.lineTo(n * .7, n * .88); g.lineTo(n, n * .78); g.lineTo(n, n); g.lineTo(0, n); g.fill();
  return c;
}
/* Generic preview (no layer to sample): a blue->orange ramp blended over a dusk landscape. Cached per mode. */
export function blendThumb(mode) {
  if (cache.has(mode)) return cache.get(mode);
  const n = SIZE * 2, c = document.createElement('canvas'); c.width = c.height = n;
  const g = c.getContext('2d'); g.drawImage(sampleScene(), 0, 0);
  g.globalCompositeOperation = mode;
  const top = g.createLinearGradient(0, 0, n, n); top.addColorStop(0, '#2f6fe0'); top.addColorStop(.55, '#5a8cf0'); top.addColorStop(1, '#e0604a');
  g.fillStyle = top; g.fillRect(0, 0, n, n);
  const url = c.toDataURL('image/png'); cache.set(mode, url); return url;
}

const CSS = `
.cmbp{position:relative;width:100%}
.cmbp-btn{all:unset;box-sizing:border-box;width:100%;display:flex;align-items:center;gap:10px;min-height:34px;padding:3px 10px 3px 4px;border-radius:6px;cursor:pointer;
  background:var(--ctl,var(--cm-ctl,#232327));color:var(--ink,var(--cm-ink,#ececee));border:1px solid transparent;font-size:12px}
.cmbp-btn:hover{border-color:var(--line,var(--cm-line,#3a3a3a))}
.cmbp-btn:focus-visible{border-color:var(--accent,var(--cm-accent,#3b82f6));box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,var(--cm-accent,#3b82f6)) 45%,transparent)}
.cmbp-btn[aria-disabled=true]{opacity:.5;cursor:default}
.cmbp-btn img{width:26px;height:26px;border-radius:5px;flex:none}
.cmbp-btn .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmbp-btn svg{flex:none;opacity:.7}
.cmbp-pop{position:fixed;z-index:2147482000;box-sizing:border-box;padding:6px 0;border-radius:12px;overflow-y:auto;overscroll-behavior:contain;
  background:var(--panel-2,var(--cm-panel-2,#26262a));color:var(--ink,var(--cm-ink,#ececee));border:1px solid var(--line,var(--cm-line,#3a3a3a));box-shadow:0 14px 44px rgba(0,0,0,.5);font:13px/1.25 Inter,system-ui,sans-serif}
.cmbp-sep{height:1px;margin:6px 0;background:var(--line,var(--cm-line,#3a3a3a))}
.cmbp-opt{position:relative;display:flex;align-items:center;gap:12px;padding:6px 14px 6px 30px;cursor:pointer}
.cmbp-opt img{width:44px;height:44px;border-radius:8px;flex:none}
.cmbp-opt .t{display:flex;flex-direction:column;min-width:0}.cmbp-opt .t b{font-weight:500;font-size:14px}.cmbp-opt .t small{font-size:11px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cmbp-opt[aria-selected=true]{background:color-mix(in srgb,var(--ink,var(--cm-ink,#ececee)) 9%,transparent)}
.cmbp-opt[data-active=true]{background:color-mix(in srgb,var(--accent,var(--cm-accent,#3b82f6)) 28%,transparent)}
.cmbp-opt .ck{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--accent,var(--cm-accent,#3b82f6));display:none}
.cmbp-opt[aria-selected=true] .ck{display:block}
`;
let cssDone = false;
const CHECK = '<svg class="ck" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
const CHEV = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

let uid = 0;
export function mountBlendPicker(host, { get, set, preview, label = 'Blend mode' } = {}) {
  if (!cssDone) { const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); cssDone = true; }
  const id = 'cmbp' + (++uid);
  host.innerHTML = '';
  const root = document.createElement('div'); root.className = 'cmbp';
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'cmbp-btn';
  btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-label', label);
  root.appendChild(btn); host.appendChild(root);

  let value = 'source-over', disabled = false, pop = null, activeIdx = 0, flat = [], src = null;
  // the user's own layer + what is under it when the shell can supply them; the generic sample otherwise
  const thumb = (v) => { try { if (src) return blendThumbFrom(v, src); } catch (e) { /* tainted canvas etc: fall back */ } return blendThumb(v); };
  const refreshSrc = () => { try { src = preview ? preview() : null; } catch (e) { src = null; } };
  const paintBtn = () => { btn.innerHTML = `<img alt="" src="${thumb(value)}"><span class="n">${LABEL[value] || value}</span>${CHEV}`; btn.title = DESC[value] || ''; btn.setAttribute('aria-disabled', String(disabled)); };

  function close(refocus) {
    if (!pop) return;
    document.removeEventListener('pointerdown', onDown, true); removeEventListener('resize', onResize);
    pop.remove(); pop = null; btn.setAttribute('aria-expanded', 'false'); btn.removeAttribute('aria-activedescendant');
    if (refocus) btn.focus({ preventScroll: true });
  }
  const onDown = (e) => { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(false); };
  const onResize = () => close(false);
  function setActive(i, scroll = true) {
    flat.forEach((o, k) => { o.el.dataset.active = String(k === i); });
    activeIdx = i; const el = flat[i].el; btn.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }
  function choose(v) { close(true); if (v !== value) { value = v; paintBtn(); set(v); } }
  function open() {
    if (disabled || pop) return;
    refreshSrc(); paintBtn();
    pop = document.createElement('div'); pop.className = 'cmbp-pop'; pop.setAttribute('role', 'listbox'); pop.setAttribute('aria-label', label); pop.id = id;
    flat = [];
    BLEND_GROUPS.forEach((grp, gi) => {
      if (gi) { const s = document.createElement('div'); s.className = 'cmbp-sep'; s.setAttribute('role', 'separator'); pop.appendChild(s); }
      grp.forEach(([v, l, d]) => {
        const o = document.createElement('div'); o.className = 'cmbp-opt'; o.setAttribute('role', 'option'); o.id = `${id}-${v}`; o.setAttribute('aria-selected', String(v === value));
        o.innerHTML = `${CHECK}<img alt="" src="${thumb(v)}"><span class="t"><b>${l}</b><small>${d}</small></span>`;
        o.addEventListener('click', () => choose(v));
        o.addEventListener('pointermove', () => { const k = flat.findIndex(x => x.v === v); if (k !== activeIdx) setActive(k, false); });
        pop.appendChild(o); flat.push({ v, el: o });
      });
    });
    (btn.closest('.cm-root') || document.body).appendChild(pop);
    // place under the button, or above when there's no room; never taller than the viewport
    const r = btn.getBoundingClientRect(), m = 8, below = innerHeight - r.bottom - m, above = r.top - m;
    const w = Math.max(r.width, 280); pop.style.width = w + 'px';
    const useBelow = below >= 320 || below >= above, room = useBelow ? below : above;
    pop.style.maxHeight = Math.max(200, room - 4) + 'px';
    pop.style.left = Math.max(m, Math.min(r.left, innerWidth - w - m)) + 'px';
    if (useBelow) pop.style.top = (r.bottom + 4) + 'px'; else pop.style.top = Math.max(m, r.top - 4 - pop.offsetHeight) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDown, true); addEventListener('resize', onResize);
    setActive(Math.max(0, flat.findIndex(x => x.v === value)));
  }
  btn.addEventListener('click', () => (pop ? close(false) : open()));
  btn.addEventListener('keydown', (e) => {
    if (!pop) { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); } return; }
    const k = e.key;
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (k === 'ArrowDown') { e.preventDefault(); setActive(Math.min(flat.length - 1, activeIdx + 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, activeIdx - 1)); }
    else if (k === 'Home') { e.preventDefault(); setActive(0); }
    else if (k === 'End') { e.preventDefault(); setActive(flat.length - 1); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(flat[activeIdx].v); }
    else if (k === 'Tab') close(false);
  });
  paintBtn();
  return {
    sync(v) { v = v || 'source-over'; if (v !== value) { value = v; paintBtn(); if (pop) pop.querySelectorAll('[role=option]').forEach(o => o.setAttribute('aria-selected', String(o.id === `${id}-${v}`))); } },
    setDisabled(d) { d = !!d; if (d !== disabled) { disabled = d; if (d) close(false); paintBtn(); } },
  };
}
