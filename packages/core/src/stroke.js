/* Border (stroke) options beyond colour + width — the subset Figma and Photoshop agree on:
   style (solid / dashed / dotted, with configurable dash + gap), position (inside / center /
   outside), cap and join.

   Style lives in Fabric's own strokeDashArray, so it serializes for free: null = solid,
   [0, pitch] = dotted (zero-length dashes + round caps paint dots; pitch = dot + gap, so the gap
   stays the same when the width changes), anything else = dashed [dash, gap]. Position is a custom
   `strokePosition` prop (listed in io.js EXTRA); Fabric only strokes on the centre line, so
   installStrokePosition() patches _renderStroke to clip a double-width stroke to the inside or
   outside of the shape's own path. It also honours the fill / border eye toggles (`fillOff`,
   `strokeOff`, also in EXTRA). */

// Closed outlines only — "inside" means nothing for a line or open polyline, and text has its own
// stroke renderer.
const POSITIONABLE = ['rect', 'ellipse', 'circle', 'triangle', 'polygon', 'path'];
const HUGE = 1e6;

export function canPositionStroke(o) {
  return !!o && POSITIONABLE.includes(o.type);
}

export function installStrokePosition(fabric) {
  const P = fabric && fabric.Object && fabric.Object.prototype;
  if (!P || P.__cmStrokePosition) return;
  P.__cmStrokePosition = true;
  const baseStroke = P._renderStroke, baseCache = P.shouldCache;
  P._renderStroke = function (ctx) {
    if (this.strokeOff) return;
    const pos = this.strokePosition;
    if ((pos !== 'inside' && pos !== 'outside') || !this.stroke || !this.strokeWidth || !canPositionStroke(this)) return baseStroke.call(this, ctx);
    // Fabric calls this with the shape's path still current, so it can be the clip. Outside clips
    // to (huge rect − shape) by even-odd; the rect's own stroke then lands far off-canvas.
    ctx.save();
    if (pos === 'outside') { ctx.rect(-HUGE, -HUGE, HUGE * 2, HUGE * 2); ctx.clip('evenodd'); } else ctx.clip();
    const w = this.strokeWidth;
    this.strokeWidth = w * 2;
    try { baseStroke.call(this, ctx); } finally { this.strokeWidth = w; }
    ctx.restore();
  };
  // A rounded photo's border follows its rounded corners. Fabric strokes an image as a plain rectangle, which
  // pokes square corners out past the rounded clip; draw the rounded outline instead (the clip is widened by
  // the editor so the whole width shows). Centre-line stroke, like every image border.
  const I = fabric.Image && fabric.Image.prototype;
  if (I) {
    const imgStroke = I._renderStroke;
    I._renderStroke = function (ctx) {
      const c = this.clipPath;
      if (this.strokeOff || !this.stroke || !this.strokeWidth || !c || c.role !== 'corner') return imgStroke.call(this, ctx);
      const sw = this.strokeWidth, w = this.width, h = this.height, rx = Math.max(0, (c.rx || 0) - sw / 2), ry = Math.max(0, (c.ry || 0) - sw / 2), x = -w / 2, y = -h / 2;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x + rx, y); ctx.lineTo(x + w - rx, y); ctx.quadraticCurveTo(x + w, y, x + w, y + ry);
      ctx.lineTo(x + w, y + h - ry); ctx.quadraticCurveTo(x + w, y + h, x + w - rx, y + h);
      ctx.lineTo(x + rx, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - ry);
      ctx.lineTo(x, y + ry); ctx.quadraticCurveTo(x, y, x + rx, y); ctx.closePath();
      ctx.lineWidth = sw; ctx.strokeStyle = this.stroke; ctx.lineJoin = 'round';
      if (this.strokeDashArray) ctx.setLineDash(this.strokeDashArray);
      ctx.stroke(); ctx.restore();
    };
  }
  // An outside border paints past the object's box, which its cache canvas would crop.
  P.shouldCache = function () {
    if (this.strokePosition === 'outside' && this.stroke && this.strokeWidth && !this.strokeOff && canPositionStroke(this)) { this.ownCaching = false; return false; }
    return baseCache.call(this);
  };

  // Fill / border eye toggles: `fillOff` / `strokeOff` hide the paint without touching fill or
  // stroke themselves, so a gradient, dash pattern, width etc. all come back on toggling it on.
  const baseFill = P._renderFill;
  P._renderFill = function (ctx) { if (this.fillOff) return; return baseFill.call(this, ctx); };
  const T = fabric.Text && fabric.Text.prototype;   // text paints through its own fill/stroke methods
  if (T) {
    const tFill = T._renderTextFill, tStroke = T._renderTextStroke;
    T._renderTextFill = function (ctx) { if (this.fillOff) return; return tFill.call(this, ctx); };
    T._renderTextStroke = function (ctx) { if (this.strokeOff) return; return tStroke.call(this, ctx); };
  }
  // SVG export reads fill/stroke straight off the object — blank them for the duration.
  const baseSvg = P.getSvgStyles;
  P.getSvgStyles = function (skipShadow) {
    if (!this.fillOff && !this.strokeOff) return baseSvg.call(this, skipShadow);
    const keep = { fill: this.fill, stroke: this.stroke };
    if (this.fillOff) this.fill = null;
    if (this.strokeOff) this.stroke = null;
    try { return baseSvg.call(this, skipShadow); } finally { this.fill = keep.fill; this.stroke = keep.stroke; }
  };
}

/* The border's settings as the panels show them. */
export function strokeInfo(o) {
  const w = o && o.stroke ? (o.strokeWidth || 0) : 0;
  const arr = o && Array.isArray(o.strokeDashArray) && o.strokeDashArray.length >= 2 ? o.strokeDashArray : null;
  const style = !arr ? 'solid' : arr[0] === 0 ? 'dotted' : 'dashed';
  return {
    width: w,
    visible: !(o && o.strokeOff),
    style,
    dash: style === 'dashed' ? arr[0] : defaultDash(w).dash,
    gap: style === 'dashed' ? arr[1] : style === 'dotted' ? Math.max(0, arr[1] - (o.strokeWidth || 0)) : defaultDash(w).gap,
    cap: (o && o.strokeLineCap) || 'butt',
    join: (o && o.strokeLineJoin) || 'miter',
    position: canPositionStroke(o) ? (o.strokePosition || 'center') : 'center',
    canPosition: canPositionStroke(o),
  };
}

function defaultDash(w) {
  const b = Math.max(1, w || 1);
  return { dash: Math.max(4, Math.round(b * 3)), gap: Math.max(2, Math.round(b * 2)) };
}

const CAPS = ['butt', 'round', 'square'], JOINS = ['miter', 'round', 'bevel'], POSITIONS = ['inside', 'center', 'outside'];
const num = (v, d) => (Number.isFinite(+v) ? Math.max(0, +v) : d);

/* Applies a setStroke() patch's style keys to one object — { style, dash, gap, cap, join,
   position } — after any width change has landed (a dotted pitch depends on the width). */
export function applyStrokeStyle(o, patch, prevWidth) {
  const cur = strokeInfo(o);
  if (cur.style === 'dotted' && prevWidth != null && !('style' in patch) && !('gap' in patch)) {
    // keep the gap between dots, not the pitch, when only the width changed
    const gap = Math.max(0, o.strokeDashArray[1] - prevWidth);
    o.set('strokeDashArray', [0, gap + (o.strokeWidth || 0)]);
  }
  const style = 'style' in patch ? patch.style : cur.style;
  if ('style' in patch || 'dash' in patch || 'gap' in patch) {
    const d = defaultDash(o.strokeWidth);
    // Leaving solid starts from defaults sized to the width; otherwise keep what's set.
    const dash = num(patch.dash, cur.style === 'dashed' ? cur.dash : d.dash);
    const gap = num(patch.gap, cur.style === style && style !== 'solid' ? cur.gap : (style === 'dotted' ? Math.max(1, Math.round((o.strokeWidth || 1))) : d.gap));
    if (style === 'solid') o.set('strokeDashArray', null);
    else if (style === 'dotted') o.set({ strokeDashArray: [0, gap + (o.strokeWidth || 0)], strokeLineCap: 'round' });
    else o.set('strokeDashArray', [Math.max(0.5, dash), gap]);
    // round caps are what turn zero-length dashes into dots — undo that when leaving dotted
    if (cur.style === 'dotted' && style !== 'dotted' && !('cap' in patch)) o.set('strokeLineCap', 'butt');
  }
  if ('cap' in patch && CAPS.includes(patch.cap) && style !== 'dotted') o.set('strokeLineCap', patch.cap);
  if ('join' in patch && JOINS.includes(patch.join)) o.set('strokeLineJoin', patch.join);
  if ('position' in patch && POSITIONS.includes(patch.position) && canPositionStroke(o)) {
    o.set('strokePosition', patch.position === 'center' ? undefined : patch.position);
    o.dirty = true;
  }
}
