/* Crop — pure geometry helpers plus the apply step.

   getCropHandle() hit-tests a crop rectangle's handles at the current zoom (tolerance shrinks as
   you zoom in, so handles stay grabbable but precise). applyCrop() re-bases every object so the
   crop rect becomes the new artboard origin, then resizes the artboard. */

export function getCropHandle(c, pt, z) {
  if (!c) return null;
  const tol = 12 / z;
  const cx = c.x, cy = c.y, cw = c.w, ch = c.h;
  const mx = cx + cw / 2, my = cy + ch / 2;
  const rx = cx + cw, ry = cy + ch;
  if (Math.hypot(pt.x - cx, pt.y - cy) < tol) return 'tl';
  if (Math.hypot(pt.x - rx, pt.y - cy) < tol) return 'tr';
  if (Math.hypot(pt.x - cx, pt.y - ry) < tol) return 'bl';
  if (Math.hypot(pt.x - rx, pt.y - ry) < tol) return 'br';
  if (Math.hypot(pt.x - mx, pt.y - cy) < tol) return 't';
  if (Math.hypot(pt.x - mx, pt.y - ry) < tol) return 'b';
  if (Math.hypot(pt.x - cx, pt.y - my) < tol) return 'l';
  if (Math.hypot(pt.x - rx, pt.y - my) < tol) return 'r';
  if (pt.x >= cx && pt.x <= rx && pt.y >= cy && pt.y <= ry) return 'move';
  return null;
}

/* Drag a handle: returns the next crop rect. `ratio` (w/h) locks the aspect when set. */
export function dragCropRect(c, handle, dx, dy, ratio = 0, min = 24) {
  let { x, y, w, h } = c;
  const apply = {
    move: () => { x += dx; y += dy; },
    tl: () => { x += dx; y += dy; w -= dx; h -= dy; },
    tr: () => { y += dy; w += dx; h -= dy; },
    bl: () => { x += dx; w -= dx; h += dy; },
    br: () => { w += dx; h += dy; },
    t: () => { y += dy; h -= dy; },
    b: () => { h += dy; },
    l: () => { x += dx; w -= dx; },
    r: () => { w += dx; },
  }[handle];
  if (!apply) return c;
  apply();
  if (w < min) w = min;
  if (h < min) h = min;
  if (ratio > 0 && handle !== 'move') {
    if (['l', 'r'].includes(handle)) h = w / ratio;
    else if (['t', 'b'].includes(handle)) w = h * ratio;
    else h = w / ratio;
  }
  return { x, y, w, h };
}

/* The largest box of aspect `ratio` (w/h) inside `bounds` {x,y,w,h}, centred as near the current
   box's centre as the bounds allow — what picking a ratio chip should do to the box straight away. */
export function fitCropRect(c, ratio, bounds) {
  if (!(ratio > 0) || !bounds) return c;
  let w = bounds.w, h = w / ratio;
  if (h > bounds.h) { h = bounds.h; w = h * ratio; }
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  const x = Math.min(Math.max(cx - w / 2, bounds.x), bounds.x + bounds.w - w);
  const y = Math.min(Math.max(cy - h / 2, bounds.y), bounds.y + bounds.h - h);
  return { x, y, w, h };
}

/* Keep a dragged box inside `bounds`: a moved box slides back in whole; a resized one is cut at the
   edge it crossed. With a locked `ratio` the cut side's partner shrinks too, so the aspect holds. */
export function clampCropRect(c, bounds, handle, ratio = 0) {
  if (!bounds) return c;
  let { x, y, w, h } = c;
  if (handle === 'move') {
    w = Math.min(w, bounds.w); h = Math.min(h, bounds.h);
    x = Math.min(Math.max(x, bounds.x), bounds.x + bounds.w - w);
    y = Math.min(Math.max(y, bounds.y), bounds.y + bounds.h - h);
    return { x, y, w, h };
  }
  const x1 = Math.min(x + w, bounds.x + bounds.w), y1 = Math.min(y + h, bounds.y + bounds.h);
  const x0 = Math.max(x, bounds.x), y0 = Math.max(y, bounds.y);
  let nw = x1 - x0, nh = y1 - y0;
  if (ratio > 0 && (nw !== w || nh !== h)) {
    if (nw / ratio > nh) nw = nh * ratio; else nh = nw / ratio;
    // keep the side opposite the dragged handle anchored
    const left = handle && handle.includes('l'), top = handle && handle.includes('t');
    return { x: left ? x1 - nw : x0, y: top ? y1 - nh : y0, w: nw, h: nh };
  }
  return { x: x0, y: y0, w: nw, h: nh };
}

/* Commit the crop: every object shifts by (-x, -y) and the artboard becomes (w, h). The caller
   passes the fabric canvas; the paint engine (if any) is handed back new dimensions so its
   offscreen canvas is re-based too. */
export function applyCrop(fc, crop, engine) {
  const { x, y, w, h } = crop;
  fc.getObjects().forEach(o => {
    o.set({ left: (o.left || 0) - x, top: (o.top || 0) - y });
    o.setCoords();
  });
  if (engine && engine.cv) {
    const next = document.createElement('canvas');
    next.width = w; next.height = h;
    next.getContext('2d').drawImage(engine.cv, -x, -y);
    engine.cv = next;
    engine.ctx = next.getContext('2d');
    engine.W = w; engine.H = h;
    if (engine.layer) {
      engine.layer._element = next;
      engine.layer.set({ left: 0, top: 0, width: w, height: h });
      engine.layer.dirty = true;
    }
  }
  return { width: w, height: h };
}
