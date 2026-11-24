/* Vector layers: shapes and text. Fabric is injected; every creator returns the new object with
   the library's layer metadata (id/role/name) already set, so hosts can list and manage layers
   without knowing Fabric internals. */

let _uid = 0;
export const uid = () => 'o' + (Date.now().toString(36)) + (_uid++).toString(36);

/* Curated font list for the typography panel: web-safe system fonts (render offline, no network
   dependency) plus a small set of popular Google Fonts loaded via a <link> tag a host page adds
   itself (see FONT_STYLESHEET_URL) — picking one of the Google fonts before that stylesheet has
   loaded just falls back to the family's own generic (serif/sans-serif/monospace) until it does.
   Grouped so a host UI can render section headers; the value is the exact CSS font-family string
   to set on a text object. */
export const FONT_GROUPS = [
  { label: 'System', fonts: [
    ['System UI', 'system-ui, sans-serif'], ['Arial', 'Arial, Helvetica, sans-serif'],
    ['Georgia', 'Georgia, serif'], ['Times New Roman', '"Times New Roman", Times, serif'],
    ['Courier New', '"Courier New", Courier, monospace'], ['Verdana', 'Verdana, sans-serif'],
    ['Trebuchet MS', '"Trebuchet MS", sans-serif'],
  ] },
  { label: 'Google Fonts', fonts: [
    ['Inter', 'Inter, sans-serif'], ['Roboto', 'Roboto, sans-serif'], ['Poppins', 'Poppins, sans-serif'],
    ['Playfair Display', '"Playfair Display", serif'], ['Merriweather', 'Merriweather, serif'],
    ['Roboto Mono', '"Roboto Mono", monospace'], ['Bebas Neue', '"Bebas Neue", sans-serif'],
    ['Montserrat', 'Montserrat, sans-serif'], ['Oswald', 'Oswald, sans-serif'], ['Nunito', 'Nunito, sans-serif'],
  ] },
  { label: 'Display & Script', fonts: [
    ['Anton', 'Anton, sans-serif'], ['Archivo Black', '"Archivo Black", sans-serif'], ['Fredoka', 'Fredoka, sans-serif'],
    ['Baloo 2', '"Baloo 2", sans-serif'], ['Lilita One', '"Lilita One", sans-serif'], ['Luckiest Guy', '"Luckiest Guy", sans-serif'],
    ['Pacifico', 'Pacifico, cursive'], ['Lobster', 'Lobster, cursive'], ['Dancing Script', '"Dancing Script", cursive'],
  ] },
];
export const GOOGLE_FONT_FAMILIES = ['Inter', 'Roboto', 'Poppins', 'Playfair+Display', 'Merriweather', 'Roboto+Mono', 'Bebas+Neue',
  'Montserrat', 'Oswald', 'Nunito', 'Anton', 'Archivo+Black', 'Fredoka', 'Baloo+2', 'Lilita+One', 'Luckiest+Guy', 'Pacifico', 'Lobster', 'Dancing+Script'];
/* Fonts convert-to-layers may pick when matching detected lettering (see the AI detectRegions
   prompt and Editor#_buildRegionLayer): the Google set plus the always-available system fonts,
   each with a one-word look the model can match against. */
export const MATCH_FONTS = [
  ['Inter', 'clean sans'], ['Roboto', 'neutral sans'], ['Poppins', 'geometric sans'], ['Montserrat', 'wide geometric sans'],
  ['Nunito', 'rounded sans'], ['Oswald', 'condensed sans'], ['Bebas Neue', 'tall condensed caps'], ['Anton', 'heavy condensed'],
  ['Archivo Black', 'heavy wide sans'], ['Fredoka', 'rounded bold'], ['Baloo 2', 'rounded playful'], ['Lilita One', 'rounded heavy display'],
  ['Luckiest Guy', 'bubbly cartoon caps'], ['Playfair Display', 'elegant serif'], ['Merriweather', 'sturdy serif'],
  ['Georgia', 'classic serif'], ['Pacifico', 'brush script'], ['Lobster', 'bold script'], ['Dancing Script', 'handwriting script'],
  ['Roboto Mono', 'monospace'],
];
/* CSS font-family string for a MATCH_FONTS / FONT_GROUPS display name (case-insensitive), or null. */
export function fontCss(name) {
  const n = String(name || '').trim().toLowerCase();
  for (const g of FONT_GROUPS) for (const [label, css] of g.fonts) if (label.toLowerCase() === n) return css;
  return null;
}
export const FONT_STYLESHEET_URL = 'https://fonts.googleapis.com/css2?' +
  GOOGLE_FONT_FAMILIES.map(f => `family=${f}:wght@400;500;600;700`).join('&') + '&display=swap';

export function starPoints(cx, cy, outer, inner, n) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (Math.PI / n) * i - Math.PI / 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

const BASE = { originX: 'left', originY: 'top' };

export function makeShape(fabric, tool, pt, o = {}) {
  const size = o.size || 160;
  const fill = o.fill || '#000000';
  const stroke = o.stroke || null;
  const strokeWidth = o.strokeWidth || 0;
  const common = { ...BASE, left: pt.x - size / 2, top: pt.y - size / 2, fill, stroke, strokeWidth };
  let obj = null;
  if (tool === 'rect') obj = new fabric.Rect({ ...common, width: size, height: size, rx: o.rx || 0, ry: o.rx || 0 });
  else if (tool === 'ellipse') obj = new fabric.Ellipse({ ...common, rx: size / 2, ry: size / 2 });
  else if (tool === 'triangle') obj = new fabric.Triangle({ ...common, width: size, height: size });
  else if (tool === 'line') obj = new fabric.Line([pt.x - size / 2, pt.y, pt.x + size / 2, pt.y], { stroke: stroke || fill, strokeWidth: strokeWidth || 4 });
  else if (tool === 'polygon') obj = new fabric.Polygon(starPoints(pt.x, pt.y, size / 2, size / 2, 6).filter((_, i) => i % 2 === 0), { fill, stroke, strokeWidth });
  else if (tool === 'star') obj = new fabric.Polygon(starPoints(pt.x, pt.y, size / 2, size / 4, 5), { fill, stroke, strokeWidth });
  if (!obj) return null;
  obj.set({ id: uid(), role: 'shape', name: tool[0].toUpperCase() + tool.slice(1), shapeKind: tool });
  return obj;
}

/* Resize a shape made by makeShape() to span two drag points, keeping it live during mouse:move.
   Mirrors makeShape's own per-type geometry so a click-drag ends up exactly where a click-release
   would place a shape of that size. With `square` (held Shift), the drag point is clamped so
   width and height grow together from `from`, matching the marquee-select square constraint. */
export function resizeShapeTo(obj, tool, from, to, o = {}) {
  if (o.square && tool !== 'line') {
    const dx = to.x - from.x, dy = to.y - from.y;
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    to = { x: from.x + (dx < 0 ? -s : s), y: from.y + (dy < 0 ? -s : s) };
  }
  const x = Math.min(from.x, to.x), y = Math.min(from.y, to.y);
  const w = Math.max(1, Math.abs(to.x - from.x)), h = Math.max(1, Math.abs(to.y - from.y));
  if (tool === 'rect' || tool === 'triangle') {
    obj.set({ left: x, top: y, width: w, height: h });
  } else if (tool === 'ellipse') {
    obj.set({ left: x, top: y, rx: w / 2, ry: h / 2 });
  } else if (tool === 'line') {
    obj.set({ x1: from.x, y1: from.y, x2: to.x, y2: to.y });
  } else if (tool === 'polygon' || tool === 'star') {
    const cx = x + w / 2, cy = y + h / 2;
    const pts = tool === 'polygon'
      ? starPoints(cx, cy, w / 2, h / 2, 6).filter((_, i) => i % 2 === 0)
      : starPoints(cx, cy, w / 2, h / 4, 5);
    obj.set({ points: pts, left: x, top: y, width: w, height: h });
    obj.setCoords();
  }
  obj.setCoords();
}

/* Drag-created text: a fixed-width Textbox that wraps inside the dragged width (click-created text
   is an auto-width IText instead). Same look/defaults as makeText. */
export function makeTextBox(fabric, pt, width, o = {}) {
  const t = new fabric.Textbox(o.text || 'Double-click to edit', {
    ...BASE, left: pt.x, top: pt.y, width: Math.max(40, width),
    fontFamily: o.fontFamily || 'system-ui, sans-serif',
    fontSize: o.fontSize || 48,
    fontWeight: o.fontWeight || 700,
    fill: o.fill || '#111111',
  });
  t.set({ id: uid(), role: 'text', name: 'Text' });
  return t;
}

export function makeText(fabric, pt, o = {}) {
  const t = new fabric.IText(o.text || 'Double-click to edit', {
    ...BASE, left: pt.x, top: pt.y,
    fontFamily: o.fontFamily || 'system-ui, sans-serif',
    fontSize: o.fontSize || 48,
    fontWeight: o.fontWeight || 700,
    fill: o.fill || '#111111',
  });
  t.set({ id: uid(), role: 'text', name: 'Text' });
  return t;
}

/* A Group the layers panel should show as a folder of its members: the user's own groups
   (groupSelection's role 'group') and role-less imported ones. Stickers (role 'shape') and ad-copy
   (cta/badge/price/brand) are Groups internally but edit as one layer, so they stay flat. */
export function isContainerGroup(o) {
  return !!o && o.type === 'group' && (o.role === 'group' || !o.role);
}

/* Human name for a layer, mirroring what a layers panel wants to show. */
/* A label cut to `n` characters gets an ellipsis — a silent cut read "above ₹1000" as "above ₹100".
   Newlines/runs of spaces collapse first, so a multi-line text layer reads as one line. */
export function clipLabel(str, n = 60) {
  const t = String(str || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

export function layerLabel(o) {
  if (o.renamed && o.name) return o.name;
  if (o.role === 'paint') return o.name || 'Paint';
  if (o.role === 'adjustment') return o.name || 'Adjustments';
  if (o.role === 'bg') return 'Background';
  // cta/badge/price/brand (adtext.js) are Fabric Groups too, so this must be checked before the
  // generic `type === 'group'` branch below — otherwise every ad-copy layer would show its child
  // count ("3 layers") instead of its own name.
  if (o.role === 'cta' || o.role === 'badge' || o.role === 'price' || o.role === 'brand') return o.name || 'Layer';
  if (o.type === 'i-text' || o.type === 'text' || o.type === 'textbox') return clipLabel(o.text) || 'Text';
  if (o.type === 'image') return o.name || 'Image';
  if (o.role === 'group') return o.name || 'Group';
  // a baked-text sticker is a group too, but it's one element ("Sticker"), not "2 layers"
  if (o.type === 'group' && o.role === 'shape') return o.name || 'Sticker';
  if (o.type === 'group') return (o._objects ? o._objects.length : '?') + ' layers';
  return o.name || o.type || 'Layer';
}

/* One-line description for a layer row's subtitle plus a `kind` a UI can pick an icon/tile from —
   "Text: Inter Black 72pt", "Group (2 elements)", "1080×1080 Image", "Locked Solid Fill". Shared by
   both shells' layer panels so their rows read the same. Sizes are the on-artboard (scaled) size. */
const WEIGHT_NAMES = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black', normal: 'Regular', bold: 'Bold' };
const AD_ROLE_NAMES = { cta: 'CTA button', badge: 'Badge', price: 'Price tag', brand: 'Brand lockup' };
const isTextObj = (o) => o && (o.type === 'i-text' || o.type === 'text' || o.type === 'textbox');
/* Which shape a vector layer is, for a layers panel's icon: 'rect' | 'ellipse' | 'triangle' |
   'line' | 'polygon' | 'star' | 'pen' | 'freehand', or null for anything else. `shapeKind` is
   stamped at creation (makeShape / the pen tool); documents from before that are recognised by
   their Fabric type, and star vs hexagon by makeShape's own point counts (10 vs 6). */
function shapeKindOf(o) {
  if (o.shapeKind) return o.shapeKind;
  if (o.isFreehand || (o.type === 'path' && !o.fill)) return 'freehand';
  if (o.type === 'rect') return 'rect';
  if (o.type === 'ellipse' || o.type === 'circle') return 'ellipse';
  if (o.type === 'triangle') return 'triangle';
  if (o.type === 'line') return 'line';
  if (o.type === 'polygon') { const n = (o.points || []).length; return n === 10 ? 'star' : n === 6 ? 'polygon' : 'pen'; }
  if (o.type === 'path') return 'pen';
  return null;
}
/* Short "what is this" label for a Properties footer ("Type: Vector Ellipse"). Multi-selections
   read as "N layers". */
const SHAPE_NAMES = { rect: 'Rectangle', ellipse: 'Ellipse', triangle: 'Triangle', polygon: 'Polygon', star: 'Star', pen: 'Path', line: 'Line', freehand: 'Freehand path' };
export function layerTypeLabel(o) {
  if (!o) return '';
  if (o.type === 'activeSelection') return (o._objects || []).length + ' layers';
  if (o.role === 'adjustment') return 'Adjustment layer';
  if (o.role === 'bg') return o.type === 'image' ? 'Background image' : 'Background';
  if (o.role === 'paint') return 'Paint layer';
  if (AD_ROLE_NAMES[o.role]) return AD_ROLE_NAMES[o.role];
  if (o.type === 'image') return 'Image';
  if (isTextObj(o)) return 'Text';
  if (o.type === 'group' && o.role === 'shape') return 'Sticker';
  if (o.type === 'group') return 'Group';
  const shape = shapeKindOf(o);
  if (shape === 'line' || shape === 'freehand') return SHAPE_NAMES[shape];
  return 'Vector ' + (SHAPE_NAMES[shape] || 'Shape');
}
export function describeLayer(o) {
  if (!o) return { kind: 'shape', subtitle: '' };
  const w = Math.round(o.getScaledWidth ? o.getScaledWidth() : (o.width || 0));
  const h = Math.round(o.getScaledHeight ? o.getScaledHeight() : (o.height || 0));
  const dims = w && h ? `${w}×${h} ` : '';
  const locked = o.locked ? 'Locked ' : '';
  if (o.role === 'adjustment') return { kind: 'adjustment', subtitle: 'Adjustment layer' };
  if (o.role === 'bg') return { kind: 'bg', subtitle: locked + (o.type === 'image' ? 'Background image' : 'Solid Fill') };
  if (o.role === 'paint') return { kind: 'paint', subtitle: (o.maskCanvas ? 'Masked ' : '') + 'Paint layer' };
  if (AD_ROLE_NAMES[o.role]) return { kind: 'badge', subtitle: AD_ROLE_NAMES[o.role] };
  if (o.type === 'image') return { kind: 'image', subtitle: dims + (o.maskCanvas ? 'Masked image' : 'Image') };
  if (isTextObj(o)) {
    const font = String(o.fontFamily || 'Text').split(',')[0].replace(/["']/g, '').trim();
    return { kind: 'text', subtitle: `Text: ${font} ${WEIGHT_NAMES[o.fontWeight] || o.fontWeight || 'Regular'} ${Math.round((o.fontSize || 0) * (o.scaleY || 1))}pt` };
  }
  if (o.type === 'group' && o.role === 'shape') return { kind: 'badge', subtitle: locked + 'Sticker' };
  if (o.type === 'group') {
    const kids = o._objects || [], texts = kids.filter(isTextObj).length;
    if (texts && texts < kids.length) return { kind: 'group', subtitle: 'Text & Vector Group' };
    if (texts && texts === kids.length) return { kind: 'group', subtitle: `Text group (${kids.length})` };
    return { kind: 'group', subtitle: `Group (${kids.length} element${kids.length === 1 ? '' : 's'})` };
  }
  const shape = shapeKindOf(o);
  if (o.type === 'line') return { kind: 'shape', shape, subtitle: locked + 'Line' };
  // An open pen path is stroke-only too, but it's a vector path, not a brush stroke.
  if (o.shapeKind === 'pen') return { kind: 'shape', shape, subtitle: locked + (o.maskCanvas ? 'Masked ' : '') + 'Vector path' };
  if (o.isFreehand || (o.type === 'path' && !o.fill)) return { kind: 'shape', shape, subtitle: locked + 'Freehand path' };
  return { kind: 'shape', shape, subtitle: locked + (o.maskCanvas ? 'Masked ' : '') + 'Vector Shape' };
}

/* Text caret keys while a word is highlighted (a double-click leaves one highlighted): Fabric's
   End / Home / Cmd+→ / Cmd+← only collapse the highlight onto its own edge, so "double-click the
   text, press End, type" inserted in the MIDDLE of the line. Collapse first, then let Fabric run
   its usual jump to the line boundary — what every native text field does. Idempotent. */
export function installTextCaretKeys(fabric) {
  const P = fabric && fabric.IText && fabric.IText.prototype;
  if (!P || P.__cmCaretKeys) return;
  P.__cmCaretKeys = true;
  const toLineEdge = (e) => !!e && (e.metaKey || e.keyCode === 35 || e.keyCode === 36);
  const right = P.moveCursorRightWithoutShift, left = P.moveCursorLeftWithoutShift;
  P.moveCursorRightWithoutShift = function (e) {
    if (this.selectionStart !== this.selectionEnd && toLineEdge(e)) this.selectionStart = this.selectionEnd;
    return right.call(this, e);
  };
  P.moveCursorLeftWithoutShift = function (e) {
    if (this.selectionStart !== this.selectionEnd && toLineEdge(e)) this.selectionEnd = this.selectionStart;
    return left.call(this, e);
  };
}

/* Fabric rebuilds a layer's transform from a matrix whenever it leaves a group or a multi-selection
   (applyTransformToObject -> qrDecompose), and a matrix can't tell "mirrored" from "turned 180° and
   flipped vertically". So moving a flipped photo together with another layer brought it back as
   Rotation 180° + Flip V with X/Y on the opposite corner. Flip X + flip Y is exactly a 180° turn,
   so when both flips came back inverted, swap them back and give the 180° to the angle — the
   pixels are identical and the layer keeps the flips the user set. Idempotent. */
export function installFlipPreservingRestore(fabric) {
  const U = fabric && fabric.util;
  if (!U || !U.applyTransformToObject || U.__cmFlipKeep) return;
  U.__cmFlipKeep = true;
  const apply = U.applyTransformToObject;
  U.applyTransformToObject = function (object, transform) {
    const fx = !!object.flipX, fy = !!object.flipY;
    const r = apply.call(this, object, transform);
    if (!!object.flipX !== fx && !!object.flipY !== fy) {
      const c = object.getCenterPoint();
      object.flipX = fx; object.flipY = fy;
      object.angle = (((object.angle || 0) + 180) % 360 + 360) % 360;
      object.setPositionByOrigin(c, 'center', 'center');
    }
    return r;
  };
}
