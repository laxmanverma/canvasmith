/* installKeybindings(editor, target?) — the one shortcut set both the vanilla demo and the React
   shell wire up, so they can't drift the way the Properties panel once did. Attaches to `target`
   (default: document) and returns a teardown function.

   Covers: undo/redo, copy/paste, duplicate (⌘D), group/ungroup (⌘G / ⌘⇧G), delete-active-layer, select all (⌘A) / invert
   selection (⌘⇧I), tolerance scrub ([ / ]) for the wand/object/hover-select tools, Enter/Escape
   for the in-progress polygon/magnetic lasso or pen build, the pen's own point-level keys and
   vector edit mode (see below), single-letter tool-switch shortcuts
   (Photoshop-standard where one exists), and arrow-key nudge (Shift = 10px) of the active
   layer/selection.

   Every handler skips while typing in a form field or editing text on the canvas (IText owns
   Backspace/arrows/Cmd+C/V there) — same guard the demo already used for undo/redo/copy/paste,
   now shared instead of copy-pasted. */

/* Letters match the reference (Ditto) editor's table exactly, confirmed key-by-key: N=AI insert
   (was pencil here), U=rect (was burn), W=the trivial bbox-select stub (was this file's color
   wand), A=the CV click-to-grab magic wand (new), G=bucket (was gradient). Tools that lose their
   bare letter in that remap (pencil, burn, gradient) fall back to tool-rail/cycling access only,
   same as they are letter-less siblings in the reference editor's own tool groups. Canvasmith's
   pre-existing plain-JS color-flood wand has no reference-editor equivalent (the reference has no
   non-CV wand) — kept reachable rather than dropped, on K (freed by bucket's move to G). */
const TOOL_KEYS = {
  v: 'select', h: 'hand', c: 'crop',
  b: 'brush', e: 'eraser', s: 'clone', j: 'heal', o: 'dodge', r: 'redeye',
  m: 'marquee', l: 'lasso', q: 'objectselect', x: 'hoverselect',
  t: 'type', i: 'eyedropper', p: 'pen',
  n: 'aiinsert', u: 'rect', w: 'objectselect-bbox', a: 'magicwand', g: 'bucket', k: 'wand',
};

const NON_TEXT_INPUTS = ['range', 'checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file', 'image'];
export function isTypingTarget(editor) {
  const el = document.activeElement, tag = el && el.tagName;
  // A slider/checkbox/colour swatch keeps focus after use but takes no typing — shortcuts (⌘Z…)
  // must still reach the editor.
  if (tag === 'INPUT' && NON_TEXT_INPUTS.includes((el.type || '').toLowerCase())) return false;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const active = editor.fc.getActiveObject();
  return !!(active && active.isEditing);
}

/* opts.toolGroups: arrays of sibling tool ids (the shell's rail groups), or a function returning
   them. Pressing a letter again while already on a tool in its group advances to the next sibling
   (Photoshop-style cycling) — shared here so both shells cycle identically. */
export function installKeybindings(editor, target = (typeof document !== 'undefined' ? document : null), opts = {}) {
  if (!target) return () => {};

  const onKeyDown = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    // Polygon/magnetic lasso build: Enter commits, Escape cancels. Checked first and unconditionally
    // (no isTypingTarget guard) since a lasso build only exists mid-gesture on the canvas itself.
    if (['lasso-poly', 'lasso-mag'].includes(editor.tool) && editor._polyBuild) {
      if (e.key === 'Enter') { e.preventDefault(); editor.finishPolyLasso(); return; }
      if (e.key === 'Escape') { e.preventDefault(); editor.cancelPolyLasso(); return; }
    }

    // Pen tool build (Figma): Enter or Escape ends the path keeping what's drawn, Backspace/Delete
    // removes the last point, ⌘Z/⌘⇧Z step points back/forward instead of undoing the document.
    // Same unconditional/first-checked treatment as the lasso build above.
    if (editor.tool === 'pen' && editor._penBuild && !isTypingTarget(editor)) {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); editor.finishPen(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); editor.penRemoveLastPoint(); return; }
      if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) editor.penRedoPoint(); else editor.penUndoPoint(); return; }
    }

    // Vector edit mode: Enter/Escape leave it, Delete removes the selected points, arrows nudge
    // them (Shift = 10px), ⌘A selects every point. Undo/redo fall through to the document's.
    if (editor._pathEdit && !isTypingTarget(editor)) {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); editor.exitPathEdit(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); editor.deleteSelectedPathNodes(); return; }
      if (mod && key === 'a') { e.preventDefault(); editor.selectAllPathNodes(); return; }
      if (e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (dx || dy) { e.preventDefault(); editor.nudgePathNodes(dx, dy); }
        return;
      }
    }

    // Enter on a selected path (Select tool) opens it for point editing, like Figma.
    if (e.key === 'Enter' && editor.tool === 'select' && !mod && !isTypingTarget(editor)) {
      const active = editor.fc.getActiveObject();
      if (active && editor.isEditablePath(active)) { e.preventDefault(); editor.editPath(active.id); return; }
    }

    // 4-corner perspective edit: Enter applies, Escape cancels — same first-checked treatment.
    if (editor._persp && !isTypingTarget(editor)) {
      if (e.key === 'Enter') { e.preventDefault(); editor.applyPerspectiveEdit(); return; }
      if (e.key === 'Escape') { e.preventDefault(); editor.cancelPerspectiveEdit(); return; }
    }

    // Crop: Enter applies the box (Escape cancels, in the cascade below).
    if (editor.tool === 'crop' && editor.crop && e.key === 'Enter' && !isTypingTarget(editor)) {
      e.preventDefault(); editor.applyCrop(); return;
    }

    // Escape cascade: back out of whatever's "live" one step at a time, most-specific first —
    // cancel an in-progress crop, else clear a pixel selection (marquee/lasso/wand), else deselect
    // the active object. Each branch returns after acting so a single Escape press only ever
    // backs out one level, matching how the reference editor's own Escape handling layers.
    if (e.key === 'Escape') {
      if (editor.tool === 'crop' && editor.crop) { e.preventDefault(); editor.setTool('select'); return; }
      if (editor.selection) { e.preventDefault(); editor.clearSelection(); return; }
      if (editor.fc.getActiveObject()) { e.preventDefault(); editor.fc.discardActiveObject(); editor._lastActiveId = null; editor.fc.renderAll(); return; }
    }

    if (isTypingTarget(editor)) return;

    // Undo/redo — Cmd+Z / Cmd+Shift+Z on Mac, Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) elsewhere.
    if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); editor.undo(); return; }
    if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) { e.preventDefault(); editor.redo(); return; }

    // Cut (⌘X) and Copy as PNG (⇧⌘C) — the right-click menu lists both.
    if (mod && key === 'x' && !e.shiftKey) {
      if (editor.selection && editor._pixelSourceLayer()) { e.preventDefault(); editor.cutSelectedPixels(); }
      else if (editor.fc.getActiveObject()) { e.preventDefault(); editor.cutSelection(); }
      return;
    }
    if (mod && e.shiftKey && key === 'c') {
      if (editor.fc.getActiveObject()) { e.preventDefault(); editor.copyAsPNG(); }
      return;
    }

    // Copy/paste — clipboard lives on the Editor (see copySelection/pasteClipboard).
    if (mod && key === 'c') {
      // A pixel selection wins over the object: ⌘C on a lasso copies what's inside it.
      if (editor.selection && editor._pixelSourceLayer()) { e.preventDefault(); editor.copySelectedPixels(); }
      else if (editor.fc.getActiveObject()) { e.preventDefault(); editor.copySelection(); }
      return;
    }
    if (mod && key === 'v') {
      if (editor._clipboard) { e.preventDefault(); editor.pasteClipboard(); }
      // else: fall through to the browser's native paste (an OS-clipboard image via
      // installDropImport's paste listener), same contract as before this was shared.
      return;
    }

    // Duplicate active layer — ⌘D/Ctrl+D.
    if (mod && key === 'd') {
      e.preventDefault();   // even with nothing selected — otherwise Chrome opens "Bookmark this page"
      const layer = editor.layers().find(l => l.active);
      if (layer) editor.duplicateLayer(layer.id);
      return;
    }

    // Copy selected pixels into a new layer (Photoshop's "Layer via Copy") — ⌘J/Ctrl+J. Requires
    // both a pixel selection (marquee/lasso/wand) and a source layer to copy from;
    // duplicateSelectionToLayer() itself no-ops (returns null) without either, so this is a
    // straight passthrough rather than needing its own guard beyond the key match.
    if (mod && key === 'j') { e.preventDefault(); editor.duplicateSelectionToLayer(); return; }

    // Group (⌘G) / ungroup (⌘⇧G) the active multi-selection / group. Always swallowed so the
    // browser's Find Next never fires; groupSelection()/ungroupSelection() no-op with a status.
    if (mod && key === 'g') {
      e.preventDefault();
      if (e.shiftKey) editor.ungroupSelection(); else editor.groupSelection();
      return;
    }

    // Pixel-selection commands: select all (⌘A), invert (⌘⇧I) — mirror the reference editor's
    // shortcuts for the marquee/lasso/wand selection system (distinct from object selection).
    if (mod && key === 'a') { e.preventDefault(); editor.selectAll(); return; }
    if (mod && e.shiftKey && key === 'i') { e.preventDefault(); editor.invertSelection(); return; }

    // Tolerance scrub: [ / ] nudge the wand/object/hover-select tolerance by 4, live, while one of
    // those tools is active — lets you fine-tune a pick without reaching for the slider.
    if ((e.key === '[' || e.key === ']') && ['wand', 'magicwand', 'objectselect', 'hoverselect'].includes(editor.tool)) {
      e.preventDefault();
      const cur = editor.toolOpts.tolerance || 0;
      const next = Math.max(0, Math.min(128, cur + (e.key === ']' ? 4 : -4)));
      editor.setToolOptions({ tolerance: next });
      return;
    }

    // Figma's arrange keys: ] bring to front, [ send to back, ⌘] forward, ⌘[ backward. (Checked
    // after the wand tools' [ ] tolerance scrub above, which keeps those keys while it applies.)
    if ((e.key === ']' || e.key === '[') && editor.fc.getActiveObject()) {
      e.preventDefault();
      editor.arrangeSelection(e.key === ']' ? (mod ? 'up' : 'top') : (mod ? 'down' : 'bottom'));
      return;
    }
    // ⇧H / ⇧V flip, ⇧⌘H hide/show, ⇧⌘L lock/unlock the selection (Figma's keys).
    if (e.shiftKey && !e.altKey && editor.fc.getActiveObject()) {
      if (!mod && key === 'h') { e.preventDefault(); editor.flipLayer('x'); return; }
      if (!mod && key === 'v') { e.preventDefault(); editor.flipLayer('y'); return; }
      if (mod && key === 'h') { e.preventDefault(); editor.toggleSelectionVisible(); return; }
      if (mod && key === 'l') { e.preventDefault(); editor.toggleSelectionLock(); return; }
    }

    // Delete/Backspace: with an active pixel selection (marquee/lasso/wand) AND a real, unlocked
    // active layer to cut it from, clip those pixels out non-destructively instead of removing
    // the whole layer — matches the reference editor's own "selection present -> cut, else ->
    // delete the layer" branching. cutSelectionFromLayer() itself falls back to deleting the whole
    // active object when there's an active object but no selection, so a plain Backspace with a
    // real layer selected and no pixel selection is still handled correctly by that one call.
    // A drawing tool (marquee/lasso/wand — exactly when a pixel selection exists) has already had
    // its Fabric active object discarded by setTool() by the time this fires, so this resolves the
    // same _lastActiveId fallback editor.js's own pixel-selection methods use, rather than reading
    // fc.getActiveObject() directly and finding nothing.
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const active = editor.fc.getActiveObject() || (editor._lastActiveId && editor._byId(editor._lastActiveId));
      if (active && active.type !== 'activeSelection' && !active.locked && editor.selection) {
        e.preventDefault();
        editor.cutSelectionFromLayer();
        return;
      }
      if (!active || active.locked) return;   // a locked layer isn't deleted from the keyboard
      e.preventDefault();
      if (active.type === 'activeSelection') {
        active.getObjects().slice().filter(o => !o.locked).forEach(o => o.id && editor.removeLayer(o.id));
        editor.fc.discardActiveObject(); editor.fc.renderAll();
      } else {
        editor.removeLayer(active.id);
      }
      return;
    }

    // Arrow-key nudge: 1px, or 10px with Shift — moves the active object/activeSelection.
    if (e.key.startsWith('Arrow')) {
      // with a pixel selection and a selection tool active, the arrows move the selection (not a layer)
      if (editor.selection && !editor.fc.getActiveObject() && editor.nudgeSelection) {
        const st = e.shiftKey ? 10 : 1;
        const sx = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, sy = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
        if (sx || sy) { e.preventDefault(); editor.nudgeSelection(sx, sy); return; }
      }
      const active = editor.fc.getActiveObject();
      // locked, or pinned in place (an adjustment layer — see _recomputeAdjustmentLayers)
      if (!active || active.locked || (active.lockMovementX && active.lockMovementY)) return;
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      active.set({ left: (active.left || 0) + dx, top: (active.top || 0) + dy });
      active.setCoords();
      editor.fc.renderAll();
      editor.commit('nudge');
      return;
    }

    // Single-letter tool switch (no modifier — Cmd/Ctrl+<letter> stays a browser/OS shortcut).
    // Shift+letter is never a tool switch (⇧H/⇧V flip, and nothing else should jump tools).
    if (!mod && !e.altKey && !e.shiftKey && TOOL_KEYS[key]) {
      e.preventDefault();
      const primary = TOOL_KEYS[key];
      const groups = typeof opts.toolGroups === 'function' ? opts.toolGroups() : (opts.toolGroups || []);
      // A letter always selects its own tool. Pressing it AGAIN cycles through the group members
      // that have no letter of their own (V on Select stays Select — Hand has H; L on Marquee goes
      // to Lasso, not the next marquee) — so a letter never lands on a different lettered tool.
      const group = groups.find(g => g.includes(primary));
      const lettered = new Set(Object.values(TOOL_KEYS));
      const ring = group ? [primary, ...group.filter(t => t !== primary && !lettered.has(t))] : [primary];
      const idx = ring.indexOf(editor.tool);
      editor.setTool(idx >= 0 ? ring[(idx + 1) % ring.length] : primary);
      return;
    }
  };

  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}

export { TOOL_KEYS };
