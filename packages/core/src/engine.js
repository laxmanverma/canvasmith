/* PaintEngine — the raster heart of the editor.
   A single offscreen canvas (artboard resolution) is wrapped as a Fabric image layer; every pixel
   tool draws onto it in scene coordinates, so zoom/pan come free from Fabric's viewport transform.

   Tools implemented here: brush, pencil, eraser, dodge, burn, sponge, red-eye, clone, heal,
   bucket-style fill, linear gradient, eyedropper sampling. Selections clip strokes via setClip().

   Headless: `fabric` is injected — nothing here reads globals. */

import { hexRgb, rgba, toHex, normalizeGradientStops } from './color.js';

export const PAINT_TOOLS = ['brush', 'pencil', 'eraser', 'clone', 'heal', 'dodge', 'burn', 'sponge', 'redeye'];

/* Renders exactly `objects` (an arbitrary subset/order of the canvas's own objects — NOT
   necessarily fc.getObjects()) to a fresh artboard-resolution offscreen canvas, at scene scale
   (viewport transform reset to identity, cropped to 0,0,W,H) — the same "flatten to a plain
   canvas" primitive captureFlat() already used for the whole scene, generalized so
   Editor#_recomputeAdjustmentLayers can flatten just "everything below this adjustment layer's
   z-index" instead. Uses fc.renderCanvas(ctx, objects) directly (Fabric's own object-list-scoped
   render, which fc.toCanvasElement() itself calls internally with the full list) rather than
   toggling every other object's `visible` off and back on around a toCanvasElement() call — no
   risk of a re-entrant render or a stray event firing off half-hidden state. Doesn't touch fc's
   own live width/height/viewportTransform at all, so no save/restore dance is needed around it. */
export function renderObjectsFlat(fc, W, H, objects) {
  const canvasEl = document.createElement('canvas');
  canvasEl.width = W; canvasEl.height = H;
  const ctx = canvasEl.getContext('2d');
  const savedVpt = fc.viewportTransform;
  // renderCanvas() cancels any on-screen render already requested (it assumes it IS that render).
  // This one is offscreen, so put the request back afterwards — otherwise a pending repaint (e.g.
  // the hover preview's) could be dropped and the screen left showing a stale frame.
  const pending = !!fc.isRendering;
  // Fabric culls objects outside the viewport it computes from the <canvas> ELEMENT's size — the
  // host's stage, not the artboard. On a tall page (a 1080×1920 story in an 850px-high stage) every
  // layer below the stage's height vanished from the flatten: clone/heal sampled the backdrop
  // instead of the layer under the source point, adjustment layers saw nothing under them there.
  const savedSkip = fc.skipOffscreen;
  fc.skipOffscreen = false;
  // Not interactive while flattening, as Fabric's own toCanvasElement does: an interactive render
  // draws the active layer's selection HANDLES into the pixels (controlsAboveOverlay), plus the
  // transparent-page checkerboard — an adjustment layer baked the handles into the export, and
  // clone/heal/the eyedropper could sample them.
  const savedInteractive = fc.interactive;
  fc.interactive = false;
  fc.viewportTransform = [1, 0, 0, 1, 0, 0];
  fc.calcViewportBoundaries();
  try { fc.renderCanvas(ctx, objects); }
  finally { fc.viewportTransform = savedVpt; fc.calcViewportBoundaries(); fc.skipOffscreen = savedSkip; fc.interactive = savedInteractive; }
  if (pending) fc.requestRenderAll();
  return canvasEl;
}

/* Builds a real CanvasGradient from the shared {offset,color} stop shape — 'radial' treats
   (x1,y1) as the center and the distance to (x2,y2) as the radius (Canvas2D's own radial
   gradient convention: an inner radius of 0 at the center, growing out to that distance). */
export function buildCanvasGradient(ctx, x1, y1, x2, y2, stops, type = 'linear') {
  const norm = normalizeGradientStops(stops);
  const g = type === 'radial'
    ? ctx.createRadialGradient(x1, y1, 0, x1, y1, Math.max(1, Math.hypot(x2 - x1, y2 - y1)))
    : ctx.createLinearGradient(x1, y1, x2, y2);
  norm.forEach(s => g.addColorStop(s.offset, s.color));
  return g;
}

export class PaintEngine {
  constructor(fabric, fc, W, H) {
    this.fabric = fabric; this.fc = fc; this.W = W; this.H = H;
    this.cv = document.createElement('canvas'); this.cv.width = W; this.cv.height = H;
    this.ctx = this.cv.getContext('2d');
    this.layer = null; this._clip = null; this._flat = null; this._src = null; this._off = null; this._last = null;
    this._lastStrokeEnd = null; this._curPt = null; this._newSourceSet = false;
  }

  /* Clone/heal source state, read by the shells to draw the source marker and the live "pixels
     come from here" ghost ring. `offset` is only meaningful once a stroke has started; before
     that the ghost tracks the raw source point. */
  cloneState() {
    return { src: this._src ? { ...this._src } : null, off: this._off ? { ...this._off } : null, pending: this._newSourceSet };
  }

  clearCloneSource() { this._src = null; this._off = null; this._newSourceSet = false; }

  /* Destructive mode: bind the engine's drawing surface to an EXISTING layer's own pixels, so
     strokes edit that image in place instead of accumulating on a separate paint layer (how the
     clone stamp works in Photoshop by default). `cv` is a scratch canvas the caller has already
     filled with the layer's current pixels AT THE LAYER'S OWN RESOLUTION, so retouching a 4000px
     photo dropped on a 1000px artboard keeps all four thousand pixels. `xf` ({scale, dx, dy}) maps
     scene coordinates onto that canvas — every tool here works in scene px, so rather than convert
     each dab by hand the transform is baked into the context and the inverse scale is handed back
     through sceneScale() for the few places that need a real pixel radius. Flushing the canvas back
     onto the layer is the caller's job (see Editor#_bindPaintTarget); null restores normal mode. */
  setDirectTarget(layer, cv, xf) {
    const was = this._direct;
    const x = xf || { scale: 1, dx: 0, dy: 0 };
    // `m` is the scene->target affine; older callers pass only {scale, dx, dy}.
    if (layer) x.m = x.m || [x.scale, 0, 0, x.scale, x.dx, x.dy];
    this._direct = layer ? { layer, cv, xf: x } : null;
    if (layer) {
      this.cv = cv; this.ctx = cv.getContext('2d'); this.layer = layer;
      return;
    }
    // Leaving destructive mode must also drop the borrowed layer/canvas, or ensure() would happily
    // keep painting onto the image we were retouching instead of making a fresh paint layer.
    if (was) { this.layer = null; this.cv = null; this.ctx = null; }
  }

  /* Scene px -> target px. 1 in normal mode; >1 when retouching an image denser than the artboard. */
  sceneScale() { return this._direct ? this._direct.xf.scale : 1; }

  /* Runs `fn` with the context mapped so scene coordinates land on the target's own pixel grid.
     Every drawing primitive below goes through this, so none of them needs to know about it. */
  _inTargetSpace(fn) {
    const ctx = this.ctx, d = this._direct;
    if (!d) return fn(ctx);
    ctx.save();
    ctx.transform(...d.xf.m);
    try { return fn(ctx); } finally { ctx.restore(); }
  }
  // Scene point -> target pixel (identity outside direct mode).
  _toTarget(x, y) {
    const d = this._direct; if (!d) return { x, y };
    const m = d.xf.m;
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
  }

  /* The engine's Fabric layer, created on first use and re-created if the host deleted it. */
  ensure() {
    // Destructive mode already owns cv/ctx/layer — never swap in a fresh blank canvas under it.
    if (this._direct) {
      if (this.fc.getObjects().includes(this._direct.layer)) return this._direct.layer;
      this._direct = null;   // target deleted mid-session — fall through and make a paint layer
    }
    // Normal mode draws in plain scene px straight onto this.cv, so the layer must sit exactly on
    // the artboard — a paint layer trimmed to its strokes (Editor#_trimPaintLayer) or moved by the
    // user no longer does, and gets a fresh artboard-sized layer instead of misplaced pixels.
    if (this.layer && this.fc.getObjects().includes(this.layer) && this._onArtboard(this.layer)) return this.layer;
    this.cv = document.createElement('canvas');
    this.cv.width = this.W;
    this.cv.height = this.H;
    this.ctx = this.cv.getContext('2d');
    // Created mid-stroke while a drawing tool is active, so it must start out non-selectable/
    // non-evented like every other object under a drawing tool (see Editor#setTool) — otherwise
    // Fabric's own mousedown-on-target logic latches a drag transform onto this brand-new layer
    // at the same point the stroke begins, and the whole layer visibly slides under the paint
    // (worst with clone/heal, whose source-offset math also depends on the layer staying put).
    // Editor#setTool('select') flips it back to selectable/evented like everything else later.
    const img = new this.fabric.Image(this.cv, { left: 0, top: 0, originX: 'left', originY: 'top', selectable: false, evented: false });
    img.set({
      id: 'o' + Math.random().toString(36).slice(2, 7),
      role: 'paint',
      name: 'Paint ' + (this.fc.getObjects().filter(o => o.role === 'paint').length + 1),
    });
    this.layer = img; this.fc.add(img); return img;
  }

  _onArtboard(o) {
    return o.left === 0 && o.top === 0 && (o.scaleX || 1) === 1 && (o.scaleY || 1) === 1 && !(o.angle % 360)
      && !o.cropX && !o.cropY && Math.round(o.width) === this.W && Math.round(o.height) === this.H
      && o._element === this.cv;
  }

  commit() {
    // Destructive mode: the scratch canvas IS the layer's new source, so hand it back through
    // setElement (which also refreshes _originalElement — a raw _element assignment would let a
    // later filter pass revert the layer to its pre-stroke pixels). Skipped when the layer already
    // holds this exact canvas, i.e. a paint layer drawing onto its own backing store.
    // setElement re-reads width/height from the new element; pass the layer's own so a cropped
    // image (retouched in its whole source) keeps its crop window.
    if (this._direct && this._direct.layer._element !== this.cv) { const L = this._direct.layer; L.setElement(this.cv, { width: L.width, height: L.height }); }
    if (this.layer) this.layer.dirty = true;
    this.fc.renderAll();
  }

  /* Selection clipping: strokes land only inside `path2d` (evenodd supports inverted selections). */
  setClip(path2d, rule) { this._clip = path2d || null; this._clipRule = rule || 'nonzero'; }

  /* Flatten the whole scene at artboard resolution — clone/heal sample from this, and the
     eyedropper reads it, so both see COMPOSITED pixels, not just the paint layer. */
  captureFlat() {
    this._flat = renderObjectsFlat(this.fc, this.W, this.H, this.fc.getObjects());
  }

  _softStamp(x, y, o, color, comp, alphaMul) {
    const r = Math.max(1, o.size / 2);
    // Clamped shy of 1: Canvas2D's radial gradient degenerates to fully transparent everywhere
    // when the inner/outer radii are exactly equal, so a hardness-1 (fully hard) brush would
    // otherwise paint nothing instead of a crisp hard edge. See mask.js's maskStamp for the same fix.
    const hard = Math.min(o.hardness != null ? o.hardness : 0.7, 0.995);
    this._inTargetSpace(ctx => {
      ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
      ctx.globalCompositeOperation = comp || 'source-over';
      ctx.globalAlpha = (o.opacity != null ? o.opacity : 1) * (alphaMul || 1);
      const g = ctx.createRadialGradient(x, y, r * hard, x, y, r);
      g.addColorStop(0, rgba(color, 1)); g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      ctx.restore();
    });
  }

  _hardStamp(x, y, o, color) {
    const r = Math.max(0.5, o.size / 2);
    this._inTargetSpace(ctx => {
      ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
      ctx.globalAlpha = o.opacity != null ? o.opacity : 1; ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.restore();
    });
  }

  /* Clone/heal: copy pixels from the flattened scene at a source offset; heal adds a blur pass so
     the patch melts into its surroundings. Soft edges come from a destination-in radial mask. */
  _cloneStamp(x, y, o, blur) {
    if (!this._flat || !this._off) return;
    const r = Math.max(1, o.size / 2);
    const hard = Math.min(o.hardness != null ? o.hardness : 0.7, 0.995);   // see _softStamp's comment
    // The patch is built at the TARGET's pixel density, not the artboard's: when retouching a photo
    // denser than the artboard, a temp canvas sized in scene px would throw away that extra detail
    // on the way in and then upscale the blur, leaving a visibly soft stamp on a sharp photo.
    const sc = this.sceneScale();
    const size = Math.max(1, Math.ceil(r * 2 * sc));
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = size;
    tempCanvas.height = size;
    const tempCtx = tempCanvas.getContext('2d');
    const sx = x - this._off.x - r;
    const sy = y - this._off.y - r;
    // _flat is always artboard-resolution (captureFlat renders the scene at W×H), so the source
    // rect stays in scene px while the destination fills the denser temp canvas.
    try { tempCtx.drawImage(this._flat, sx, sy, r * 2, r * 2, 0, 0, size, size); } catch (e) { /* out of bounds */ }
    const tr = size / 2;
    tempCtx.globalCompositeOperation = 'destination-in';
    const g = tempCtx.createRadialGradient(tr, tr, tr * hard, tr, tr, tr);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    tempCtx.fillStyle = g;
    tempCtx.beginPath();
    tempCtx.arc(tr, tr, tr, 0, 2 * Math.PI);
    tempCtx.fill();
    this._inTargetSpace(ctx => {
      ctx.save();
      if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
      ctx.globalAlpha = o.opacity != null ? o.opacity : 1;
      // `filter` is applied in the context's CURRENT (scaled) space, so a scene-px radius scales
      // with the image automatically — the heal blur stays proportional at any target density.
      if (blur) ctx.filter = 'blur(' + Math.max(2, r * 0.35) + 'px)';
      ctx.drawImage(tempCanvas, x - r, y - r, r * 2, r * 2);
      ctx.restore();
    });
  }

  /* Red-eye: detect red-dominant pixels under the brush and pull them to the G/B average. */
  _redEyeCorrection(x, y, o) {
    const ctx = this.ctx;
    // getImageData/putImageData ignore the context transform, so this one works in raw target
    // pixels: the brush centre and radius are converted up front, and the bounds come from the
    // bound canvas rather than the artboard (they differ whenever a denser image is the target).
    const d = this._direct, sc = this.sceneScale();
    const c0 = this._toTarget(x, y), cx = c0.x, cy = c0.y;
    const r = Math.max(1, (o.size / 2) * sc);
    const cw = this.cv ? this.cv.width : this.W, ch = this.cv ? this.cv.height : this.H;
    const left = Math.max(0, Math.floor(cx - r));
    const top = Math.max(0, Math.floor(cy - r));
    const width = Math.min(cw - left, Math.ceil(r * 2));
    const height = Math.min(ch - top, Math.ceil(r * 2));
    if (width <= 0 || height <= 0) return;
    let imgData;
    try { imgData = ctx.getImageData(left, top, width, height); } catch (e) { return; }
    const data = imgData.data;
    const brushOpacity = o.opacity != null ? o.opacity : 1;
    let changed = false;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const idx = (py * width + px) << 2;
        const rVal = data[idx], gVal = data[idx + 1], bVal = data[idx + 2], aVal = data[idx + 3];
        if (aVal > 0) {
          const dx = (left + px) - cx, dy = (top + py) - cy;
          const dist = Math.hypot(dx, dy);
          if (dist <= r && rVal > 80 && rVal > gVal * 1.3 && rVal > bVal * 1.3) {
            const falloff = 1 - (dist / r);
            const factor = Math.max(0, Math.min(1, falloff)) * brushOpacity;
            const targetRed = (gVal + bVal) / 2;
            data[idx] = Math.round(rVal * (1 - factor) + targetRed * factor);
            data[idx + 1] = Math.round(gVal * (1 - 0.25 * factor));
            data[idx + 2] = Math.round(bVal * (1 - 0.25 * factor));
            changed = true;
          }
        }
      }
    }
    if (changed) {
      if (this._clip) {
        // The clip path is in SCENE space, so this draw has to go through the same transform as
        // every other primitive — which means the destination rect is expressed in scene px too.
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        tempCanvas.getContext('2d').putImageData(imgData, 0, 0);
        this._inTargetSpace(c => {
          c.save();
          c.clip(this._clip, this._clipRule || 'nonzero');
          // back to raw target pixels (the clip above stays in scene space)
          if (d) { const m = d.xf.m, k = m[0] * m[3] - m[1] * m[2]; c.transform(m[3] / k, -m[1] / k, -m[2] / k, m[0] / k, (m[2] * m[5] - m[3] * m[4]) / k, (m[1] * m[4] - m[0] * m[5]) / k); }
          c.drawImage(tempCanvas, left, top);
          c.restore();
        });
      } else {
        ctx.putImageData(imgData, left, top);
      }
    }
  }

  /* Interpolate dabs between points so fast strokes stay continuous. */
  _line(tool, from, to, o) {
    const dx = to.x - from.x, dy = to.y - from.y, dist = Math.hypot(dx, dy);
    const step = Math.max(1, (o.size || 20) * 0.18);
    const n = Math.max(1, Math.floor(dist / step));
    for (let i = 1; i <= n; i++) { const x = from.x + dx * (i / n), y = from.y + dy * (i / n); this._dab(tool, x, y, o); }
  }

  _dab(tool, x, y, o) {
    switch (tool) {
      case 'brush': this._softStamp(x, y, o, o.color, 'source-over'); break;
      case 'pencil': this._hardStamp(x, y, o, o.color); break;
      case 'eraser': this._softStamp(x, y, o, '#000000', 'destination-out'); break;
      // ~5-6 dabs overlap every point of a stroke (_line spaces them 18% of the size apart), so the
      // per-dab strength compounds: at 0.25 one pass took a dark bag almost to white. 0.06 lands
      // near a quarter of the way per stroke, about Photoshop's default exposure; repeat to build up.
      case 'dodge': this._softStamp(x, y, o, '#ffffff', 'color-dodge', 0.06); break;
      case 'burn': this._softStamp(x, y, o, '#000000', 'color-burn', 0.06); break;
      case 'sponge': {
        const spongeColor = (o.spongeMode === 'saturate') ? '#ff0000' : '#808080';
        this._softStamp(x, y, o, spongeColor, 'saturation', 0.7);
        break;
      }
      case 'redeye': this._redEyeCorrection(x, y, o); break;
      case 'clone': this._cloneStamp(x, y, o, false); break;
      case 'heal': if (this._spot) this._spot.pts.push({ x, y }); else this._cloneStamp(x, y, o, true); break;
      default: this._softStamp(x, y, o, o.color, 'source-over');
    }
  }

  /* Pointer protocol: down/move/up in scene coordinates.
     clone/heal: alt-click OR shift-click sets the source ('src-set' is returned so the UI can show
     it) — shift is a second, trackpad-friendly way to move the reference point, and it is free for
     clone/heal because the shift-to-join-strokes behavior below deliberately excludes them;
     other tools: shift-click joins strokes with a straight line, Photoshop-style. */
  down(tool, pt, o) {
    this.ensure();
    this._curPt = pt;
    /* Spot heal: a plain press with no source set fixes the spot from its own surroundings — the
       stroke's footprint is filled on release (_spotHeal). Alt/Shift-click still picks a source,
       and once one is set the tool paints as a healing brush from it. */
    this._spot = null;
    if (tool === 'heal' && !o.alt && !o.shift && !this._src) {
      this.captureFlat();
      this._spot = { pts: [{ x: pt.x, y: pt.y }], r: Math.max(1, (o.size || 20) / 2), o };
      this._last = pt;
      this._lastStrokeEnd = pt;
      return true;
    }
    if (tool === 'clone' || tool === 'heal') {
      if (o.alt || o.shift || !this._src) {
        this._src = { x: pt.x, y: pt.y };
        this._newSourceSet = true;
        return 'src-set';
      }
      if (o.aligned === false) {
        this._off = { x: pt.x - this._src.x, y: pt.y - this._src.y };
      } else if (!this._off || this._newSourceSet) {
        this._off = { x: pt.x - this._src.x, y: pt.y - this._src.y };
        this._newSourceSet = false;
      }
      this.captureFlat();
    }
    if (o.shift && this._lastStrokeEnd && !['clone', 'heal'].includes(tool)) {
      this._line(tool, this._lastStrokeEnd, pt, o);
      this._last = pt;
      this._lastStrokeEnd = pt;
      this.commit();
      return true;
    }
    this._last = pt;
    this._lastStrokeEnd = pt;
    this._dab(tool, pt.x, pt.y, o);
    this.commit();
    return true;
  }

  move(tool, pt, o) {
    if (!this._last) return;
    this._curPt = pt;
    this._line(tool, this._last, pt, o);
    this._last = pt;
    this._lastStrokeEnd = pt;
    this.commit();
  }

  up() {
    if (this._spot) { this._spotHeal(this._spot); this._spot = null; this.commit(); }
    this._last = null;
    this._curPt = null;
  }

  /* Fills a spot-heal stroke's footprint from the pixels around it: onion-peel inward from the
     edge (each pixel takes the mean of its already-known neighbours), a light smoothing pass inside
     the hole to hide the peel's seams, then a soft-edged paste. The fill comes from the flattened
     scene, so it matches what you see; it lands in the target like a clone-stamp patch. */
  _spotHeal(spot) {
    if (!this._flat) return;
    const { pts, o } = spot, r = spot.r * 1.15;   // a little past the brush, so the stroke's rim is covered too
    const pad = Math.ceil(r * 1.5) + 2;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(p => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
    x0 = Math.max(0, Math.floor(x0 - r - pad)); y0 = Math.max(0, Math.floor(y0 - r - pad));
    x1 = Math.min(this.W, Math.ceil(x1 + r + pad)); y1 = Math.min(this.H, Math.ceil(y1 + r + pad));
    const w = x1 - x0, h = y1 - y0;
    if (w < 3 || h < 3) return;
    // the hole: the stroke's swept circle
    const mk = document.createElement('canvas'); mk.width = w; mk.height = h;
    const mc = mk.getContext('2d');
    mc.translate(-x0, -y0); mc.lineCap = 'round'; mc.lineJoin = 'round'; mc.lineWidth = r * 2; mc.strokeStyle = mc.fillStyle = '#000';
    mc.beginPath(); mc.moveTo(pts[0].x, pts[0].y); pts.forEach(p => mc.lineTo(p.x, p.y)); mc.stroke();
    mc.beginPath(); mc.arc(pts[0].x, pts[0].y, r, 0, 7); mc.fill();
    const hole = mc.getImageData(0, 0, w, h).data;
    let src;
    try { src = this._flat.getContext('2d').getImageData(x0, y0, w, h); } catch (e) { return; }
    const d = src.data, n = w * h, known = new Uint8Array(n);
    for (let i = 0; i < n; i++) known[i] = hole[i * 4 + 3] < 128 ? 1 : 0;
    // onion peel
    let frontier = [];
    const nb = (i) => { const x = i % w, out = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const xx = x + dx, j = i + dy * w + dx; if (xx >= 0 && xx < w && j >= 0 && j < n) out.push(j); } return out; };
    for (let i = 0; i < n; i++) if (!known[i] && nb(i).some(j => known[j])) frontier.push(i);
    while (frontier.length) {
      const vals = frontier.map(i => { let r0 = 0, g0 = 0, b0 = 0, a0 = 0, c = 0; nb(i).forEach(j => { if (known[j]) { r0 += d[j * 4]; g0 += d[j * 4 + 1]; b0 += d[j * 4 + 2]; a0 += d[j * 4 + 3]; c++; } }); return [r0 / c, g0 / c, b0 / c, a0 / c]; });
      frontier.forEach((i, k) => { const v = vals[k]; d[i * 4] = v[0]; d[i * 4 + 1] = v[1]; d[i * 4 + 2] = v[2]; d[i * 4 + 3] = v[3]; });
      frontier.forEach(i => { known[i] = 2; });
      const next = new Set();
      frontier.forEach(i => nb(i).forEach(j => { if (!known[j]) next.add(j); }));
      frontier = [...next];
    }
    // smooth inside the hole only (3 box passes) — the peel leaves faint radial streaks
    for (let pass = 0; pass < 3; pass++) {
      const c = new Uint8ClampedArray(d);
      for (let i = 0; i < n; i++) {
        if (known[i] !== 2) continue;
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, k = 1;
        s0 = c[i * 4]; s1 = c[i * 4 + 1]; s2 = c[i * 4 + 2]; s3 = c[i * 4 + 3];
        nb(i).forEach(j => { s0 += c[j * 4]; s1 += c[j * 4 + 1]; s2 += c[j * 4 + 2]; s3 += c[j * 4 + 3]; k++; });
        d[i * 4] = s0 / k; d[i * 4 + 1] = s1 / k; d[i * 4 + 2] = s2 / k; d[i * 4 + 3] = s3 / k;
      }
    }
    // patch = filled pixels where the hole was, with a feathered edge
    const patch = document.createElement('canvas'); patch.width = w; patch.height = h;
    const pc = patch.getContext('2d'); pc.putImageData(src, 0, 0);
    const feather = document.createElement('canvas'); feather.width = w; feather.height = h;
    const fc = feather.getContext('2d'); fc.filter = 'blur(' + Math.max(1, r * 0.15) + 'px)'; fc.drawImage(mk, 0, 0);
    pc.globalCompositeOperation = 'destination-in'; pc.drawImage(feather, 0, 0);
    this._inTargetSpace(ctx => {
      ctx.save();
      if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
      ctx.globalAlpha = o.opacity != null ? o.opacity : 1;
      ctx.drawImage(patch, x0, y0);
      ctx.restore();
    });
  }

  /* Fill the (clipped) artboard with a colour — the bucket tool over a selection.
     ensure() MUST run before drawing: it swaps in a fresh canvas when no paint layer exists, so
     drawing first meant the pixels landed on a canvas that was about to be thrown away. down()
     always had the right order; fill/gradient did not — caught by the demo screenshot session. */
  fill(color) {
    this.ensure();
    this._inTargetSpace(ctx => {
      ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.fillStyle = color;
      ctx.fillRect(0, 0, this.W, this.H); ctx.restore();
    });
    this.commit();
  }

  /* Fills the (clipped) paint layer with a gradient from (x1,y1) to (x2,y2) — Photoshop's
     Gradient tool. `stops` is [{offset: 0..1, color}, ...] (2+ stops; unsorted input is sorted by
     offset). `type` is 'linear' (the two points are the axis) or 'radial' (x1,y1 is the center,
     the distance to x2,y2 is the radius — Fabric/Canvas2D's radial gradient convention).
     Called on every mousemove while dragging for a live preview, and once more on mouseup to
     commit — repeated calls simply overwrite the same rect, so no extra bookkeeping is needed for
     "redo this preview frame" the way stroke-based tools require. */
  paintGradient(x1, y1, x2, y2, stops, type = 'linear') {
    this.ensure();
    this._inTargetSpace(ctx => {
      ctx.save(); if (this._clip) ctx.clip(this._clip, this._clipRule || 'nonzero');
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.fillStyle = buildCanvasGradient(ctx, x1, y1, x2, y2, stops, type);
      ctx.fillRect(0, 0, this.W, this.H); ctx.restore();
    });
    this.commit();
  }

  /* Eyedropper: composited colour at a point, as hex. */
  sample(pt) {
    this.captureFlat();
    try {
      const d = this._flat.getContext('2d').getImageData(Math.round(pt.x), Math.round(pt.y), 1, 1).data;
      return toHex(d[0], d[1], d[2]);
    } catch (e) { return null; }
  }

  /* After undo/redo reloads the scene from JSON, paint layers come back as <img> elements —
     re-wrap them as canvases so the engine can keep drawing on them. */
  adopt() {
    const paintLayers = this.fc.getObjects().filter(x => x.role === 'paint');
    paintLayers.forEach(o => {
      if (o && o._element && !(o._element instanceof HTMLCanvasElement)) {
        // At the image's OWN size: a paint layer trimmed to its strokes isn't artboard-sized, and
        // stretching it to W×H would smear it over the whole artboard after every undo.
        const cv = document.createElement('canvas');
        cv.width = o._element.naturalWidth || o._element.width || this.W;
        cv.height = o._element.naturalHeight || o._element.height || this.H;
        const ctx = cv.getContext('2d');
        try { ctx.drawImage(o._element, 0, 0, cv.width, cv.height); } catch (e) { console.error(e); }
        o._element = cv;
        o.dirty = true;
      }
    });
    // Layer masks: only the MaskFilter instance itself gets its maskCanvas rehydrated by Fabric's
    // own filter fromObject (see mask.js) — o.maskCanvas is this engine/editor's own bookkeeping
    // pointer to that same canvas (so addMask/removeMask/_refreshMaskFilter don't have to search
    // o.filters every time), and needs re-linking here after every restore.
    this.fc.getObjects().forEach(o => {
      if (o.type !== 'image') return;   // vector layers keep their own mask (see mask.js attachVectorMask)
      const f = (o.filters || []).find(x => x.type === 'MaskFilter');
      o.maskCanvas = f ? f.maskCanvas : null;
    });
    let activePaint = this.fc.getActiveObject();
    if (!activePaint || activePaint.role !== 'paint') activePaint = paintLayers[0];
    if (activePaint) {
      this.layer = activePaint;
      this.cv = activePaint._element;
      this.ctx = activePaint._element.getContext('2d');
    } else {
      // undo removed every paint layer: drop the orphaned canvas too, or the next fill/gradient
      // would draw into pixels that no fabric layer displays
      this.layer = null;
      this.cv = document.createElement('canvas');
      this.cv.width = this.W; this.cv.height = this.H;
      this.ctx = this.cv.getContext('2d');
    }
  }
}
