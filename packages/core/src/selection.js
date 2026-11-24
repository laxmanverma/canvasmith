/* Selection model — marquee (rect/ellipse), freehand lasso, click-to-place polygon lasso (with an
   optional magnetic edge-snap), a plain-JS magic wand, and selection composition (add/subtract/
   expand/contract as polygon lists).

   A selection is plain data: {kind:'rect'|'ellipse'|'poly'|'multipoly', ...geometry, invert?}.
   toPath2D() turns it into a clip path the PaintEngine (and any canvas) can use directly; an
   inverted selection is expressed with an evenodd outer rect. Everything except toPath2D() is
   pure data-in/data-out, so the geometry is unit-testable without a DOM.

   The boolean-accurate polygon ops (true union/expand/contract/subtract) live behind the OpenCV
   worker (see cv/client.js) because pure-JS polygon clipping is its own rabbit hole; this module's
   composition helpers (addPolyToSelection et al.) are the always-available, no-cv fallback. */

export function startSelection(tool, pt) {
  if (tool === 'lasso') return { kind: 'poly', pts: [pt] };
  return { kind: tool === 'marquee-ellipse' ? 'ellipse' : 'rect', x: pt.x, y: pt.y, w: 0, h: 0, _a: pt };
}

export function updateSelection(sel, pt, opts = {}) {
  if (!sel) return sel;
  if (sel.kind === 'poly') { sel.pts.push(pt); return sel; }
  const a = sel._a;
  let x = Math.min(a.x, pt.x), y = Math.min(a.y, pt.y);
  let w = Math.abs(pt.x - a.x), h = Math.abs(pt.y - a.y);
  if (opts.square) { w = h = Math.max(w, h); x = pt.x < a.x ? a.x - w : a.x; y = pt.y < a.y ? a.y - h : a.y; }
  sel.x = x; sel.y = y; sel.w = w; sel.h = h;
  return sel;
}

/* A selection smaller than a few pixels is a slipped click, not intent. */
export function finalizeSelection(sel) {
  if (!sel) return null;
  if (sel.kind === 'multipoly') return sel;
  const ok = sel.kind === 'poly' ? sel.pts.length > 2 : (sel.w > 6 && sel.h > 6);
  return ok ? sel : null;
}

export function selectionToPath2D(sel, W, H, Path2DImpl) {
  if (!sel) return null;
  const P = Path2DImpl || (typeof Path2D !== 'undefined' ? Path2D : null);
  if (!P) throw new Error('Path2D is unavailable — pass an implementation.');
  const p = new P();
  if (sel.invert) p.rect(0, 0, W, H);
  if (sel.kind === 'ellipse') {
    p.ellipse(sel.x + sel.w / 2, sel.y + sel.h / 2, Math.abs(sel.w / 2), Math.abs(sel.h / 2), 0, 0, 7);
  } else if (sel.kind === 'poly') {
    (sel.pts || []).forEach((pt, i) => i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y));
    p.closePath();
  } else if (sel.kind === 'multipoly') {
    (sel.polys || []).forEach(pl => {
      pl.forEach((pt, i) => i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y));
      p.closePath();
    });
  } else {
    p.rect(sel.x, sel.y, sel.w, sel.h);
  }
  return p;
}

export function selectionFillRule(sel) {
  return sel && sel.invert ? 'evenodd' : 'nonzero';
}

/* Magic-wand flood fill over raw RGBA pixels ({width, height, data}) — pure, node-testable.
   Selects the connected region within `tol` per channel of the seed colour, walks its boundary
   with a Moore contour trace, and returns simplified polygon points plus the bounding box. */
export function floodSelectPolygon(img, sx, sy, tol) {
  const w = img.width, h = img.height, data = img.data;
  if (!w || !h || sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const seed = ((sy * w + sx) << 2);
  const sr = data[seed], sg = data[seed + 1], sb = data[seed + 2], sa = data[seed + 3];
  const mask = new Uint8Array(w * h);
  const stack = [sx, sy];
  let cnt = 0, minx = sx, miny = sy, maxx = sx, maxy = sy;
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const p = y * w + x;
    if (mask[p]) continue;
    const i = p << 2;
    if (Math.abs(data[i] - sr) > tol || Math.abs(data[i + 1] - sg) > tol ||
        Math.abs(data[i + 2] - sb) > tol || Math.abs(data[i + 3] - sa) > tol) continue;
    mask[p] = 1; cnt++;
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  if (cnt < 8) return null;
  const rect = { x: minx, y: miny, w: (maxx - minx + 1), h: (maxy - miny + 1) };
  let start = -1;
  for (let i = 0; i < w * h; i++) { if (mask[i]) { start = i; break; } }
  const ins = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const sxp = start % w, syp = (start / w) | 0;
  const contour = [[sxp, syp]];
  let cx = sxp, cy = syp, dir = 6, iter = 0, max = (w * h) << 2;
  while (iter++ < max) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + k) % 8;
      const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
      if (ins(nx, ny)) { cx = nx; cy = ny; contour.push([cx, cy]); dir = (d + 5) % 8; found = true; break; }
    }
    if (!found) break;
    if (cx === sxp && cy === syp) break;
  }
  let pts = null;
  if (contour.length >= 8) {
    const stepN = Math.max(1, Math.floor(contour.length / 240));
    pts = [];
    for (let i = 0; i < contour.length; i += stepN) pts.push({ x: contour[i][0], y: contour[i][1] });
  }
  return { pts, rect };
}

/* Convenience: run the wand against a canvas (the flattened scene) at a clicked point. */
export function wandSelect(flatCanvas, pt, tol = 32) {
  const w = flatCanvas.width, h = flatCanvas.height;
  let data;
  try { data = flatCanvas.getContext('2d').getImageData(0, 0, w, h).data; } catch (e) { return null; }
  const r = floodSelectPolygon({ width: w, height: h, data }, Math.round(pt.x), Math.round(pt.y), tol);
  if (!r) return null;
  if (r.pts) return { kind: 'poly', pts: r.pts };
  return { kind: 'rect', ...r.rect };
}

/* ── polygon lasso (click-to-place) ──────────────────────────────────────────────────────
   A running build state ({pts:[]}) distinct from `selection` — the Editor shows it live via
   previewPolyBuild() while the user is still clicking, and only writes `selection` once closed. */
export function startPolyBuild() {
  return { pts: [] };
}

/* Add a vertex; closes the loop (returns {pts, closed:true}) if the click lands near the first
   point — mirrors a double-click-to-close polygon tool. `closeDist` is in scene px. */
export function polyBuildAdd(build, pt, closeDist = 12) {
  if (!build) return build;
  if (build.pts.length > 2) {
    const f = build.pts[0];
    if (Math.hypot(pt.x - f.x, pt.y - f.y) < closeDist) return { pts: build.pts.slice(), closed: true };
  }
  return { pts: build.pts.concat([pt]) };
}

/* Live preview while the pointer moves but hasn't clicked yet — the polygon plus a trailing point. */
export function polyBuildPreview(build, pt) {
  if (!build) return null;
  return { kind: 'poly', pts: build.pts.concat([pt]), building: true };
}

/* Finish an in-progress polygon build into a real selection, or null if cancelled/too short. */
export function finishPolyBuild(build, cancel) {
  if (cancel || !build || build.pts.length < 3) return null;
  return { kind: 'poly', pts: build.pts.slice() };
}

/* ── magnetic lasso: edge map + snap ─────────────────────────────────────────────────────
   buildEdgeMap() runs a cheap Sobel gradient once over a downscaled copy of the source image;
   snapToEdge() then pulls a drag point onto the strongest nearby edge pixel. Both are pure
   data-in/data-out: the map is {grad, ew, eh, sx, sy} and carries its own scene<->grid scale. */
export function buildEdgeMapFromImageData(imgData, W, H) {
  const ew = imgData.width, eh = imgData.height, d = imgData.data;
  const gray = new Float32Array(ew * eh);
  for (let i = 0; i < ew * eh; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const grad = new Uint8ClampedArray(ew * eh);
  for (let y = 1; y < eh - 1; y++) for (let x = 1; x < ew - 1; x++) {
    const gx = gray[y * ew + x + 1] - gray[y * ew + x - 1], gy = gray[(y + 1) * ew + x] - gray[(y - 1) * ew + x];
    grad[y * ew + x] = Math.min(255, Math.hypot(gx, gy));
  }
  return { grad, ew, eh, sx: W / ew, sy: H / eh };
}

/* Snap a scene point to the strongest nearby edge; returns pt unchanged if nothing strong is close. */
export function snapToEdge(edgeMap, pt, radius = 9, minStrength = 20) {
  if (!edgeMap) return pt;
  const e = edgeMap;
  const gx = pt.x / e.sx, gy = pt.y / e.sy;
  let best = -1, bx = gx, by = gy;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const x = Math.round(gx + dx), y = Math.round(gy + dy);
    if (x < 1 || y < 1 || x >= e.ew - 1 || y >= e.eh - 1) continue;
    const w = e.grad[y * e.ew + x] - Math.hypot(dx, dy) * 2;   // strong + close edges win
    if (w > best) { best = w; bx = x; by = y; }
  }
  return best < minStrength ? pt : { x: bx * e.sx, y: by * e.sy };
}

/* ── selection composition: shift-click add / alt-click subtract / expand/contract ────────
   These operate on plain polygon LISTS (arrays of {x,y}[] rings), the shared currency between a
   `poly`/`multipoly`/`rect` selection and the cv-worker's union/morph/subtract ops. Pure geometry;
   no OpenCV needed to normalize/compose — only the boolean-accurate union/morph/subtract do. */

/* Normalize any selection into its constituent polygon rings (rect becomes a 4-point ring). */
export function selectionPolys(sel) {
  if (!sel) return null;
  if (sel.kind === 'multipoly') return sel.polys;
  if (sel.kind === 'poly') return [sel.pts];
  if (sel.kind === 'rect' || sel.kind === 'ellipse') {
    const steps = sel.kind === 'ellipse' ? 32 : 4;
    if (sel.kind === 'rect') return [[{ x: sel.x, y: sel.y }, { x: sel.x + sel.w, y: sel.y }, { x: sel.x + sel.w, y: sel.y + sel.h }, { x: sel.x, y: sel.y + sel.h }]];
    const cx = sel.x + sel.w / 2, cy = sel.y + sel.h / 2, rx = Math.abs(sel.w / 2), ry = Math.abs(sel.h / 2);
    const pts = []; for (let i = 0; i < steps; i++) { const a = (i / steps) * Math.PI * 2; pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }); }
    return [pts];
  }
  return null;
}

/* Wrap 1+ polygon rings back into a selection (poly if one ring, multipoly if several). */
export function polysToSelection(polys) {
  if (!polys || !polys.length) return null;
  return polys.length === 1 ? { kind: 'poly', pts: polys[0] } : { kind: 'multipoly', polys };
}

/* Shift-click add, WITHOUT a boolean union — just accumulates rings into a multipoly. A true
   union (merging overlapping outlines into one clean contour) needs the cv worker; see
   CvEngine#union for that upgrade path. This is the always-available fallback. */
export function addPolyToSelection(sel, poly) {
  const cur = selectionPolys(sel) || [];
  return polysToSelection(cur.concat([poly]));
}

/* Bounding box (scene px) of a selection, or the full WxH canvas if there is none. */
export function selectionBounds(sel, W, H) {
  if (!sel) return { x: 0, y: 0, w: W, h: H };
  if (sel.kind === 'poly' || sel.kind === 'multipoly') {
    const all = sel.kind === 'multipoly' ? [].concat(...sel.polys) : sel.pts;
    if (!all.length) return { x: 0, y: 0, w: 0, h: 0 };
    const xs = all.map(p => p.x), ys = all.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
}

/* Hit-test a rect/ellipse selection's 8 resize handles (corners + edge midpoints) plus its
   interior, same geometry as crop.js's getCropHandle — a marquee selection is grabbable exactly
   like a crop rect once it exists, so dragging it can resize or move it instead of only ever
   starting a fresh drag-to-select. `tol` shrinks with zoom so handles stay a constant screen size. */
export function getSelectionHandle(sel, pt, z) {
  if (!sel || sel.building) return null;
  const poly = sel.kind === 'poly' || sel.kind === 'multipoly';
  const tol = 12 / z;
  // wand / lasso / object-select results are polygons: they get the same 8 handles on their bounding box
  const bb = poly ? selectionBounds(sel) : sel;
  const cx = bb.x, cy = bb.y, cw = bb.w, ch = bb.h;
  // a polygon selection is reshaped by its own outline points; it has no bounding-box handles, only drag-inside-to-move
  if (poly) return pointInSelection(sel, pt) ? 'move' : null;
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
  if (poly ? pointInSelection(sel, pt) : (pt.x >= cx && pt.x <= rx && pt.y >= cy && pt.y <= ry)) return 'move';
  return null;
}

/* Even-odd point-in-polygon over every ring (holes count), for irregular selections. */
export function pointInSelection(sel, pt) {
  const rings = selectionPolys(sel) || [];
  let inside = false;
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/* Re-fit a polygon selection from its original bounding box into a new one (handle drag = scale, move = translate). */
export function fitSelectionToBox(sel, from, to) {
  const sx = from.w ? to.w / from.w : 1, sy = from.h ? to.h / from.h : 1;
  const m = p => ({ x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy });
  const out = { ...sel };
  if (sel.kind === 'multipoly') out.polys = sel.polys.map(r => r.map(m)); else out.pts = sel.pts.map(m);
  return out;
}

/* Drag a selection handle: same math as crop.js's dragCropRect, but with no aspect-ratio lock
   (crop's is a UI toggle; selections don't have one), and a 1px floor instead of crop's 24px so a
   selection can still shrink down almost to nothing mid-drag — finalizeSelection is what throws
   away a too-small result once the drag ends.

   Handles that anchor the OPPOSITE edge (tl/tr/bl/l/t move x/y alongside w/h) must flip that
   anchor once a dimension crosses zero, or the box would freeze pinned to its pre-crossing edge
   instead of continuing to track the pointer — e.g. dragging 'r' at x=100,w=50 past x=100 (dx=
   -100) should end with the box's LEFT edge at the pointer, not stuck 1px wide at the old x=100. */
export function dragSelectionRect(sel, handle, dx, dy) {
  let { x, y, w, h } = sel;
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
  if (!apply) return sel;
  apply();
  // Normalize a flipped box (w/h gone negative past the opposite edge) back to a positive-size
  // rect with x/y at the true top-left, rather than just clamping the magnitude — a clamp alone
  // would leave x/y pinned to the pre-flip edge and freeze the box instead of letting it continue
  // to track the pointer past the crossover.
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  if (w < 1) w = 1;
  if (h < 1) h = 1;
  return { ...sel, x, y, w, h };
}

/* ── hover-preview cache ──────────────────────────────────────────────────────────────────
   A true LRU keyed by grid cell, backed by a Map's insertion order: get() re-inserts its key so
   it becomes the most-recently-used entry, and put()'s eviction (the map's first/oldest key) then
   always removes the least-recently-USED entry, not just the least-recently-inserted one — a hot
   cell that's re-hovered repeatedly near the cap survives instead of being evicted anyway.
   Pure and dependency-free so it's unit-testable without touching the Editor's async plumbing. */
export class HoverCache {
  constructor(cap = 400) {
    this.cap = cap;
    this._map = new Map();
  }
  get(key) {
    if (!this._map.has(key)) return null;
    const value = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, value);   // move to the most-recently-used end
    return value;
  }
  put(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    else if (this._map.size >= this.cap) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
    this._map.set(key, value);
  }
  clear() { this._map.clear(); }
  get size() { return this._map.size; }
}

/* Shoelace area of one ring (always positive). */
export function polyArea(pts) {
  let t = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) t += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(t / 2);
}

/* ── editing a polygon selection's own outline (wand / lasso / object-select results) ─────────
   hitSelectionVertex finds a vertex under the pointer, else a point on an edge (so a drag there
   inserts a new vertex). softMoveRing drags a vertex and, unless `soft` is off, its neighbours with
   a smooth cosine falloff — so a wand outline can be reshaped like clay instead of one jagged point. */
export function selectionRings(sel) {
  if (!sel || sel.building) return null;
  if (sel.kind === 'multipoly') return sel.polys;
  if (sel.kind === 'poly') return [sel.pts];
  return null;
}
export function hitSelectionVertex(sel, pt, z) {
  const rings = selectionRings(sel); if (!rings) return null;
  const vt = 9 / z, et = 6 / z;
  let best = null, bd = vt;
  rings.forEach((r, ri) => r.forEach((q, i) => { const d = Math.hypot(q.x - pt.x, q.y - pt.y); if (d < bd) { bd = d; best = { ring: ri, idx: i }; } }));
  if (best) return best;
  let ed = et;
  rings.forEach((r, ri) => { for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2)), px = a.x + t * dx, py = a.y + t * dy, d = Math.hypot(pt.x - px, pt.y - py);
    if (d < ed) { ed = d; best = { ring: ri, edge: i, pt: { x: px, y: py } }; }
  } });
  return best;
}
export function softMoveRing(orig, gi, dx, dy, R, soft) {
  const g = orig[gi];
  return orig.map((q, i) => {
    const w = i === gi ? 1 : soft ? 0.5 * (1 + Math.cos(Math.PI * Math.min(1, Math.hypot(q.x - g.x, q.y - g.y) / R))) : 0;
    return w ? { x: q.x + dx * w, y: q.y + dy * w } : { x: q.x, y: q.y };
  });
}
