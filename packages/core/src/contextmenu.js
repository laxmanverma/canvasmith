/* Right-click menu — Figma-style, listing only what Canvasmith can actually do.

   buildContextMenu(ed, { pt, hit }) decides WHAT is offered for what was right-clicked: a single
   layer (with type-specific extras for images, paths and maskable layers), a multi-selection, a
   group, empty canvas, a pixel selection, or a pen path in progress. mountContextMenu(ed, opts)
   renders it — one DOM renderer shared by the vanilla demo and @canvasmith/react, so the two
   shells can't drift apart. The Editor emits 'contextmenu' { x, y, pt, sections } (client px,
   scene px, and this model); the renderer listens for it.

   Model: sections = item[][] (a divider between sections). item = { id, label, shortcut?,
   disabled?, run?, items? (submenu), danger? }. */

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl+', SHIFT = IS_MAC ? '⇧' : 'Shift+';
const DEL = IS_MAC ? '⌫' : 'Del';
const SHIFT_MOD = IS_MAC ? '⇧⌘' : 'Ctrl+Shift+';   // macOS order: ⇧ before ⌘

const ALIGN = [['left', 'Align left'], ['center', 'Align horizontal centers'], ['right', 'Align right'],
  ['top', 'Align top'], ['middle', 'Align vertical centers'], ['bottom', 'Align bottom']];

function layerName(ed, o) {
  const l = ed.layers().find(x => x.id === o.id);
  return (l && l.name) || o.name || o.type;
}

const FEATHER_PRESETS = [5, 10, 20, 40, 80];
const featherItems = (idp, run, off) => [...FEATHER_PRESETS.map(px => ({ id: idp + px, label: px + ' px', run: () => run(px) })), { id: idp + 'off', label: 'Remove feather', run: () => off() }];

export function buildContextMenu(ed, { pt, hit } = {}) {
  const sections = [];
  const hasClip = !!ed._clipboard;
  const pasteHere = { id: 'paste-here', label: 'Paste here', shortcut: MOD + 'V', disabled: !hasClip, run: () => ed.pasteAt(pt) };

  // Pen path being drawn: the menu is about finishing it.
  if (ed._penBuild) {
    return [[
      { id: 'pen-finish', label: 'Finish path', shortcut: '↵', run: () => ed.finishPen() },
      { id: 'pen-undo', label: 'Remove last point', shortcut: DEL, run: () => ed.penRemoveLastPoint() },
      { id: 'pen-cancel', label: 'Discard path', run: () => ed.cancelPen() },
    ]];
  }
  // Vector edit mode: point operations.
  if (ed._pathEdit) {
    const sel = ed._pathEdit.sel.size;
    return [[
      { id: 'path-smooth', label: 'Make points smooth', run: () => ed.setPathNodeType('smooth') },
      { id: 'path-corner', label: 'Make points corners', run: () => ed.setPathNodeType('corner') },
      { id: 'path-delete', label: 'Delete selected points', shortcut: DEL, disabled: !sel, run: () => ed.deleteSelectedPathNodes() },
      { id: 'path-all', label: 'Select all points', shortcut: MOD + 'A', run: () => ed.selectAllPathNodes() },
    ], [
      { id: 'path-done', label: 'Done editing', shortcut: '↵', run: () => ed.exitPathEdit() },
    ]];
  }

  // A marquee/lasso/wand selection under the pointer: pixel operations.
  if (ed.selection && ed._ctxOnSelection) {
    return [[
      // Shrink the rough marquee/lasso to the object(s) inside it, like the Object select tool.
      { id: 'sel-object', label: 'Select object', disabled: !!ed._polyBuild, run: () => ed.selectObjectsInSelection(pt) },   // not on a half-drawn polygon lasso
    ], [
      { id: 'sel-copy', label: 'Copy', shortcut: MOD + 'C', run: () => ed.copySelectedPixels() },
      { id: 'sel-copy-layer', label: 'Copy to new layer', shortcut: MOD + 'J', run: () => ed.duplicateSelectionToLayer() },
      { id: 'sel-lift', label: 'Cut to new layer', run: () => ed.liftSelectionToLayer() },
      { id: 'sel-delete', label: 'Delete selected pixels', shortcut: DEL, run: () => ed.cutSelectionFromLayer() },
    ], [
      { id: 'sel-feather', label: 'Feather selection', items: featherItems('sel-feather:', px => ed.featherSelection(px), () => ed.featherSelection(0)) },
    ], [
      { id: 'sel-invert', label: 'Invert selection', shortcut: SHIFT_MOD + 'I', run: () => ed.invertSelection() },
      { id: 'sel-clear', label: 'Deselect', shortcut: 'Esc', run: () => ed.clearSelection() },
    ]];
  }

  const active = ed.fc.getActiveObject();
  const multi = !!(active && active.type === 'activeSelection');
  const target = active || hit || null;

  // Empty canvas.
  if (!target) {
    return [[
      pasteHere,
      { id: 'select-all', label: 'Select all layers', disabled: !ed.fc.getObjects().some(o => o.role !== 'bg' && !o.locked && o.visible !== false && !o.excludeFromExport), run: () => ed.selectAllLayers() },
    ], [
      { id: 'undo', label: 'Undo', shortcut: MOD + 'Z', disabled: ed.history.depth().past < 2, run: () => ed.undo() },
      { id: 'redo', label: 'Redo', shortcut: SHIFT_MOD + 'Z', disabled: !ed.history.depth().future, run: () => ed.redo() },
    ]];
  }

  // A locked layer can't be selected, so it only offers what makes sense without selecting it.
  if (!active && hit && hit.locked) {
    return [[
      { id: 'unlock', label: 'Unlock', shortcut: SHIFT_MOD + 'L', run: () => ed.setLayer(hit.id, { locked: false }) },
      { id: 'toggle-visible', label: hit.visible === false ? 'Show' : 'Hide', shortcut: SHIFT_MOD + 'H', run: () => ed.setLayer(hit.id, { visible: hit.visible === false }) },
    ], [pasteHere]];
  }

  const objs = multi ? active.getObjects() : [target];
  const single = !multi ? target : null;
  const isGroup = !!(single && single.type === 'group');
  const isImage = !!(single && single.type === 'image' && single.role !== 'paint');   // a paint layer is an image internally, not a photo

  // 1 — clipboard
  sections.push([
    { id: 'copy', label: 'Copy', shortcut: MOD + 'C', run: () => ed.copySelection() },
    { id: 'cut', label: 'Cut', shortcut: MOD + 'X', run: () => ed.cutSelection() },
    pasteHere,
    { id: 'paste-replace', label: 'Paste to replace', disabled: !hasClip, run: () => ed.pasteToReplace() },
    { id: 'duplicate', label: 'Duplicate', shortcut: MOD + 'D', run: () => ed.duplicateSelection() },
    { id: 'copy-png', label: 'Copy as PNG', shortcut: SHIFT_MOD + 'C', run: () => ed.copyAsPNG() },
    { id: 'delete', label: 'Delete', shortcut: DEL, danger: true, run: () => ed.deleteSelection() },
  ]);

  // 2 — selection + stacking
  const under = pt ? ed._layersAt(pt) : [];
  sections.push([
    { id: 'select-layer', label: 'Select layer', disabled: !under.length,
      items: under.map(o => ({ id: 'select-layer:' + o.id, label: layerName(ed, o) + (o.locked ? '  (locked)' : ''), disabled: !!o.locked, run: () => ed.activate(o.id) })) },
    { id: 'front', label: 'Bring to front', shortcut: ']', run: () => ed.arrangeSelection('top') },
    { id: 'forward', label: 'Bring forward', shortcut: MOD + ']', run: () => ed.arrangeSelection('up') },
    { id: 'backward', label: 'Send backward', shortcut: MOD + '[', run: () => ed.arrangeSelection('down') },
    { id: 'back', label: 'Send to back', shortcut: '[', run: () => ed.arrangeSelection('bottom') },
  ]);

  // 3 — structure + transform
  const struct = [];
  if (multi) struct.push({ id: 'group', label: 'Group selection', shortcut: MOD + 'G', run: () => ed.groupSelection() });
  if (isGroup) struct.push({ id: 'ungroup', label: 'Ungroup', shortcut: SHIFT_MOD + 'G', run: () => ed.ungroupSelection() });
  struct.push(
    { id: 'flip-h', label: 'Flip horizontal', shortcut: SHIFT + 'H', run: () => ed.flipLayer('x') },
    { id: 'flip-v', label: 'Flip vertical', shortcut: SHIFT + 'V', run: () => ed.flipLayer('y') },
    { id: 'align', label: multi ? 'Align selection' : 'Align to canvas',
      items: ALIGN.map(([edge, label]) => ({ id: 'align:' + edge, label, run: () => (multi ? ed.alignActiveSelection(edge) : ed.alignLayer(single.id, edge)) })) },
  );
  sections.push(struct);

  // 4 — type-specific
  const extra = [];
  if (single && ed.isEditablePath(single)) extra.push({ id: 'edit-path', label: 'Edit path', shortcut: '↵', run: () => ed.editPath(single.id) });
  if (isImage) {
    extra.push({ id: 'crop', label: 'Crop image', shortcut: 'C', run: () => { ed.activate(single.id); ed.setTool('crop'); } });
    extra.push({ id: 'remove-bg', label: 'Remove background', run: () => ed.removeBackground({ id: single.id }) });
  }
  if (single && (single.type === 'image') && ed._maskable && !ed._isVectorMasked(single)) {
    extra.push({ id: 'feather-mask', label: 'Feather edges (as mask)', items: featherItems('feather-mask:', px => ed.setEdgeFeather(single.id, px), () => ed.setEdgeFeather(single.id, 0)) });
    if (single.role !== 'paint') extra.push({ id: 'feather-bake', label: 'Feather edges (on the layer)', items: FEATHER_PRESETS.map(px => ({ id: 'feather-bake:' + px, label: px + ' px', run: () => ed.setEdgeFeather(single.id, px, { bake: true }) })) });
  }
  if (single && ed._maskable && ed._maskable(single)) {
    if (single.maskCanvas) {
      extra.push({ id: 'edit-mask', label: 'Edit mask', run: () => ed.enterMaskEdit(single.id) });
      extra.push({ id: 'remove-mask', label: 'Remove mask', run: () => ed.removeMask(single.id) });
    } else extra.push({ id: 'add-mask', label: 'Add mask', run: () => ed.addMask(single.id) });
  }
  if (extra.length) sections.push(extra);

  // 5 — visibility / lock
  const allHidden = objs.every(o => o.visible === false);
  sections.push([
    { id: 'toggle-visible', label: allHidden ? 'Show' : 'Hide', shortcut: SHIFT_MOD + 'H', run: () => ed.toggleSelectionVisible() },
    { id: 'toggle-lock', label: 'Lock', shortcut: SHIFT_MOD + 'L', run: () => ed.toggleSelectionLock() },
  ]);
  return sections;
}

/* ── renderer ────────────────────────────────────────────────────────────────────────────
   `vars` maps the menu's colours onto the host's theme tokens (each shell names them
   differently); `root` is where the menu element is appended — inside the element those tokens
   are defined on. Returns a teardown function. */
export function mountContextMenu(ed, { vars = {}, root = (typeof document !== 'undefined' ? document.body : null) } = {}) {
  if (!root) return () => {};
  const v = {
    panel: '#1e1e21', line: 'rgba(255,255,255,.1)', ink: '#f1efe9', dim: 'rgba(241,239,233,.55)',
    hover: '#2f6df0', hoverInk: '#ffffff', danger: '#ff6b5e', ...vars,
  };
  const style = document.createElement('style');
  style.textContent = `
.cmx{position:fixed;z-index:1000;min-width:236px;max-width:320px;padding:6px;border-radius:10px;background:${v.panel};border:1px solid ${v.line};
  box-shadow:0 18px 50px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.25);color:${v.ink};font:500 12.5px/1 Inter,system-ui,-apple-system,sans-serif;user-select:none;outline:none}
.cmx-sep{height:1px;margin:5px 4px;background:${v.line}}
.cmx-item{display:flex;align-items:center;gap:16px;height:30px;padding:0 10px 0 12px;border-radius:6px;cursor:default;white-space:nowrap}
.cmx-item .cmx-label{flex:1;overflow:hidden;text-overflow:ellipsis}
.cmx-item .cmx-key{color:${v.dim};font-size:12px;letter-spacing:.02em}
.cmx-item .cmx-chev{color:${v.dim};font-size:13px;line-height:1}
.cmx-item[data-danger="true"] .cmx-label{color:${v.danger}}
.cmx-item[data-active="true"]:not([aria-disabled="true"]){background:${v.hover};color:${v.hoverInk}}
.cmx-item[data-active="true"]:not([aria-disabled="true"]) .cmx-key,.cmx-item[data-active="true"]:not([aria-disabled="true"]) .cmx-chev,.cmx-item[data-active="true"][data-danger="true"] .cmx-label{color:${v.hoverInk}}
.cmx-item[aria-disabled="true"]{opacity:.38}
`;
  document.head.appendChild(style);

  let menus = [];   // [{ el, items, active }] — root menu then open submenus

  const close = () => {
    menus.forEach(m => m.el.remove()); menus = [];
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close); window.removeEventListener('resize', close);
    document.removeEventListener('wheel', close, true);
  };
  const run = (item) => {
    if (!item || item.disabled || item.items) return;
    close();
    try {
      const r = item.run && item.run();
      // A failed action reports { status:'error' } (or throws) — surface it as an 'error' event
      // tagged source:'menu' so the shell can toast it; otherwise the menu just closes, silently.
      const report = (res) => { if (res && res.status === 'error' && res.reason !== 'superseded' && res.reason !== 'destroyed') ed._emit('error', { ...res, source: 'menu', item: item.id }); };
      const fail = (err) => ed._emit('error', { status: 'error', reason: 'menu_action_failed', message: String(err && err.message || err), source: 'menu', item: item.id });
      if (r && typeof r.then === 'function') r.then(report, fail); else report(r);
    } catch (err) { ed._emit('error', { status: 'error', reason: 'menu_action_failed', message: String(err && err.message || err), source: 'menu', item: item.id }); }
  };
  const setActive = (level, idx) => {
    const m = menus[level]; if (!m) return;
    m.active = idx;
    m.rows.forEach((row, i) => { row.dataset.active = String(i === idx); });
  };
  const closeFrom = (level) => { menus.slice(level).forEach(m => m.el.remove()); menus = menus.slice(0, level); };
  const openSub = (level, idx) => {
    const m = menus[level], item = m.items[idx];
    closeFrom(level + 1);
    if (!item || !item.items || item.disabled || !item.items.length) return;
    const r = m.rows[idx].getBoundingClientRect();
    build([item.items], level + 1, r.right + 2, r.top - 6, r.left - 2);
  };
  const build = (sections, level, x, y, flipX) => {
    const el = document.createElement('div');
    el.className = 'cmx'; el.setAttribute('role', 'menu'); el.tabIndex = -1;
    const items = [], rows = [];
    sections.filter(s => s.length).forEach((sec, si) => {
      if (si) { const sep = document.createElement('div'); sep.className = 'cmx-sep'; sep.setAttribute('role', 'separator'); el.appendChild(sep); }
      sec.forEach(item => {
        const row = document.createElement('div');
        row.className = 'cmx-item'; row.setAttribute('role', 'menuitem');
        row.dataset.id = item.id;
        if (item.disabled) row.setAttribute('aria-disabled', 'true');
        if (item.danger) row.dataset.danger = 'true';
        if (item.items) row.setAttribute('aria-haspopup', 'menu');
        const label = document.createElement('span'); label.className = 'cmx-label'; label.textContent = item.label; row.appendChild(label);
        if (item.items) { const c = document.createElement('span'); c.className = 'cmx-chev'; c.textContent = '›'; row.appendChild(c); }
        else if (item.shortcut) { const k = document.createElement('span'); k.className = 'cmx-key'; k.textContent = item.shortcut; row.appendChild(k); }
        const idx = items.length;
        row.addEventListener('mouseenter', () => { setActive(level, idx); if (item.items) openSub(level, idx); else closeFrom(level + 1); });
        row.addEventListener('click', (e) => { e.stopPropagation(); if (item.items) openSub(level, idx); else run(item); });
        items.push(item); rows.push(row); el.appendChild(row);
      });
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    root.appendChild(el);   // inside the host's root so its theme variables apply
    // keep it on screen: flip left / up when it would overflow
    const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = x, top = y;
    if (left + w > vw - 8) left = flipX != null ? flipX - w : vw - 8 - w;
    if (top + h > vh - 8) top = Math.max(8, vh - 8 - h);
    el.style.left = Math.max(8, left) + 'px'; el.style.top = Math.max(8, top) + 'px';
    menus.push({ el, items, rows, active: -1 });
    return el;
  };
  const enabledIdx = (m, from, step) => {
    for (let k = 1; k <= m.items.length; k++) {
      const i = (from + step * k + m.items.length * 4) % m.items.length;
      if (!m.items[i].disabled) return i;
    }
    return -1;
  };
  function onDocDown(e) { if (!menus.some(m => m.el.contains(e.target))) close(); }
  function onKey(e) {
    if (!menus.length) return;
    const level = menus.length - 1, m = menus[level];
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') { stop(); if (level) closeFrom(level); else close(); return; }
    if (e.key === 'ArrowDown') { stop(); setActive(level, enabledIdx(m, m.active < 0 ? -1 : m.active, 1)); return; }
    if (e.key === 'ArrowUp') { stop(); setActive(level, enabledIdx(m, m.active < 0 ? 0 : m.active, -1)); return; }
    if (e.key === 'ArrowRight') { stop(); const it = m.items[m.active]; if (it && it.items) { openSub(level, m.active); setActive(level + 1, enabledIdx(menus[level + 1] || m, -1, 1)); } return; }
    if (e.key === 'ArrowLeft') { stop(); if (level) closeFrom(level); return; }
    if (e.key === 'Enter' || e.key === ' ') { stop(); const it = m.items[m.active]; if (it && it.items) { openSub(level, m.active); setActive(level + 1, enabledIdx(menus[level + 1] || m, -1, 1)); } else run(it); return; }
    // any other key: the menu stays out of the way of shortcuts
    close();
  }

  const off = ed.on('contextmenu', (ev) => {
    close();
    if (!ev || !ev.sections || !ev.sections.some(s => s.length)) return;
    const el = build(ev.sections, 0, ev.x, ev.y, null);
    el.focus({ preventScroll: true });
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close); window.addEventListener('resize', close);
    document.addEventListener('wheel', close, true);
  });
  return () => { off(); close(); style.remove(); };
}
