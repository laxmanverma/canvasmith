/* Ad-copy layer factories: CTA pill, badge chip, price group, brand lockup, and auto-fit text —
   the semantic building blocks a promotional layout needs beyond shapes.js's generic
   rect/ellipse/text primitives. Deliberately generic (no "Ditto" naming, no ad-generator-specific
   defaults baked in beyond the formulas themselves) so any host — not just an ad tool — can place
   a CTA button or a price tag the same way it places any other shape: click to position, `size` in
   toolOpts drives scale, `fabric` is injected like every other factory in this package.

   Formulas (padding ratios, font weights, the auto-fit shrink curve) match the reference ad editor
   this module's spec was ported from exactly — these are product decisions about how a CTA/badge/
   price should look, not implementation details worth reinventing differently here. */

import { uid } from './shapes.js';
import { relLum, hexRgb } from './color.js';

const BASE = { originX: 'left', originY: 'top' };

/* Pill-shaped call-to-action: label + trailing arrow glyph, sized to its own text. `o`: size
   (glyph/label font size, drives every other dimension), fill (pill color), ink (text color,
   defaults to readable-on-fill via relLum), font (family), text. */
export function makeCTA(fabric, pt, o = {}) {
  const s = o.size || 24, padX = s * 0.95, padY = s * 0.6;
  const font = o.font || o.fontFamily || 'system-ui, sans-serif';
  const fill = o.fill || o.color || '#ef6a2d';
  const ink = o.ink || (relLum(hexRgb(fill)) > 0.6 ? '#0c0c0e' : '#ffffff');
  // The pill draws its own arrow, so one typed at the end of the label ("Shop now →") doubled it.
  const label = String(o.text || 'Shop now').replace(/\s*(?:→|->|➔|➜|›|»|>)+\s*$/u, '') || 'Shop now';
  const txt = new fabric.Text(label, { fontFamily: font, fontWeight: 700, fontSize: s, fill: ink, originX: 'left', originY: 'center' });
  const arrowW = s * 0.9;
  const w = padX * 2 + txt.width + s * 0.5 + arrowW, h = s + padY * 2;
  const rect = new fabric.Rect({ width: w, height: h, rx: h / 2, ry: h / 2, fill, originX: 'left', originY: 'top', left: 0, top: 0 });
  txt.set({ left: padX, top: h / 2 });
  const arrow = new fabric.Text('→', { fontFamily: font, fontWeight: 700, fontSize: s, fill: ink, originX: 'left', originY: 'center', left: padX + txt.width + s * 0.4, top: h / 2 });
  txt.adField = 'text';
  const g = new fabric.Group([rect, txt, arrow], { left: pt.x - w / 2, top: pt.y - h / 2, ...BASE });
  g.set({ id: uid(), role: 'cta', name: 'CTA' });
  return g;
}

/* Small uppercase pill (sale/badge/tag chip). `o`: size, fill, ink, font, text. */
export function makeBadge(fabric, pt, o = {}) {
  const s = o.size || 18, padX = s * 0.75, padY = s * 0.45;
  const font = o.font || o.fontFamily || 'system-ui, sans-serif';
  const fill = o.fill || o.color || '#d4ff45';
  const ink = o.ink || (relLum(hexRgb(fill)) > 0.6 ? '#0c0c0e' : '#ffffff');
  const txt = new fabric.Text((o.text || 'Sale').toUpperCase(), { fontFamily: font, fontWeight: 700, fontSize: s, charSpacing: 60, fill: ink, originX: 'left', originY: 'center' });
  const w = padX * 2 + txt.width, h = s + padY * 2;
  const rect = new fabric.Rect({ width: w, height: h, rx: h / 2, ry: h / 2, fill, originX: 'left', originY: 'top' });
  txt.set({ left: padX, top: h / 2 });
  txt.adField = 'text';
  const g = new fabric.Group([rect, txt], { left: pt.x - w / 2, top: pt.y - h / 2, ...BASE });
  g.set({ id: uid(), role: 'badge', name: 'Badge' });
  return g;
}

/* Current / original (struck-through) / savings price group, left-to-right by measured width.
   `o`: size, font, fill (current-price color), accent (savings color), current, original, save. */
export function makePrice(fabric, pt, o = {}) {
  const s = o.size || 28, gap = s * 0.38, font = o.font || o.fontFamily || 'system-ui, sans-serif';
  const fill = o.fill || o.color || '#111114';
  const items = []; let x = 0;
  const cur = new fabric.Text(o.current || '$0', { fontFamily: font, fontWeight: 800, fontSize: s, fill, originX: 'left', originY: 'center', left: x, top: 0 });
  cur.adField = 'current';
  items.push(cur); x += cur.width + gap;
  if (o.original) {
    const orig = new fabric.Text(o.original, { fontFamily: font, fontWeight: 400, fontSize: s * 0.7, fill: o.originalInk || '#9a988f', linethrough: true, originX: 'left', originY: 'center', left: x, top: 0 });
    orig.adField = 'original';
    items.push(orig); x += orig.width + gap;
  }
  if (o.save) {
    const sv = new fabric.Text(o.save, { fontFamily: font, fontWeight: 700, fontSize: s * 0.6, fill: o.accent || '#d4ff45', originX: 'left', originY: 'center', left: x, top: 0 });
    sv.adField = 'save';
    items.push(sv); x += sv.width;
  }
  const h = s;
  const g = new fabric.Group(items, { left: pt.x - x / 2, top: pt.y - h / 2, ...BASE });
  g.set({ id: uid(), role: 'price', name: 'Price' });
  return g;
}

/* Rounded-square mark (first letter of the name, in italic serif) + brand name, side by side.
   `o`: size (name font size — the mark scales off it), color (mark + name color), font, text. */
export function makeBrandLockup(fabric, pt, o = {}) {
  const s = o.size || 20, mk = s * 1.5;
  const color = o.color || o.fill || '#ef6a2d';
  const letterFill = relLum(hexRgb(color)) > 0.6 ? '#0c0c0e' : '#ffffff';
  const font = o.font || o.fontFamily || 'system-ui, sans-serif';
  const name = o.text || 'Brand';
  const mark = new fabric.Rect({ width: mk, height: mk, rx: mk * 0.3, ry: mk * 0.3, fill: color, originX: 'left', originY: 'top', left: 0, top: 0 });
  const letter = new fabric.Text((name[0] || 'B').toLowerCase(), { fontFamily: "'Instrument Serif', serif", fontStyle: 'italic', fontSize: mk * 0.72, fill: letterFill, originX: 'center', originY: 'center', left: mk / 2, top: mk / 2 });
  const nameTxt = new fabric.Text(name, { fontFamily: font, fontWeight: 700, fontSize: s, fill: color, originX: 'left', originY: 'center', left: mk + s * 0.45, top: mk / 2 });
  nameTxt.adField = 'text';
  const w = mk + s * 0.45 + nameTxt.width, h = mk;
  const g = new fabric.Group([mark, letter, nameTxt], { left: pt.x - w / 2, top: pt.y - h / 2, ...BASE });
  g.set({ id: uid(), role: 'brand', name: 'Brand' });
  return g;
}

/* Shrinks a Textbox's fontSize (down to a 9px floor, capped at 24 iterations) until its rendered
   height fits maxH — each step multiplies fontSize by at most 0.94 so it converges rather than
   overshooting on a single big text block. Mutates `textbox` in place; callers ensure
   `initDimensions` exists (any real fabric.Textbox does) before relying on the shrink taking effect
   immediately rather than on next render. */
export function autoFitText(textbox, maxH) {
  if (!maxH) return textbox;
  let guard = 0;
  while (textbox.height > maxH && textbox.fontSize > 9 && guard < 24) {
    textbox.set('fontSize', Math.max(9, Math.floor(textbox.fontSize * Math.min(0.94, maxH / textbox.height))));
    if (textbox.initDimensions) textbox.initDimensions();
    guard++;
  }
  return textbox;
}

/* Legibility halo for text over photographic/busy backgrounds — a soft shadow, dark for light
   text or light for dark text. `variant`: 'dark' (default, for light-colored text) or 'light'
   (for dark-colored text over a bright area). Sized off the text's own current fontSize so it
   scales correctly even after autoFitText has shrunk it. */
export function applyLegibilityShadow(fabric, textbox, variant = 'dark') {
  const s = textbox.fontSize || 24;
  const color = variant === 'light' ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.55)';
  textbox.set('shadow', new fabric.Shadow({ color, blur: Math.max(3, s * 0.28), offsetX: 0, offsetY: Math.max(1, s * 0.03) }));
  return textbox;
}

/* The factory per ad-copy role, and the options each one reads — what an edited CTA/badge/price/
   brand is rebuilt from (Editor#_finishAdEdit), so the pill resizes and the price re-flows. */
export const AD_FACTORIES = { cta: makeCTA, badge: makeBadge, price: makePrice, brand: makeBrandLockup };
export const AD_OPT_KEYS = ['size', 'font', 'fontFamily', 'fill', 'color', 'ink', 'accent', 'originalInk', 'text', 'current', 'original', 'save'];

/* Options for a group made before adOpts was stored (or by a template): read back off its parts. */
export function deriveAdOpts(g) {
  const kids = g._objects || [], texts = kids.filter(k => typeof k.text === 'string');
  const shape = kids.find(k => k.type === 'rect');
  const o = {};
  if (g.role === 'price') {
    const cur = texts.find(t => t.adField === 'current') || texts[0];
    const orig = texts.find(t => t.adField === 'original') || texts.find(t => t !== cur && t.linethrough);
    const save = texts.find(t => t.adField === 'save') || texts.find(t => t !== cur && t !== orig);
    if (cur) Object.assign(o, { current: cur.text, size: cur.fontSize, font: cur.fontFamily, fill: cur.fill });
    if (orig) o.original = orig.text;
    if (save) Object.assign(o, { save: save.text, accent: save.fill });
    return o;
  }
  const label = texts.find(t => t.adField === 'text') || (g.role === 'brand' ? texts[texts.length - 1] : texts.find(t => t.text !== '→'));
  if (label) Object.assign(o, { text: label.text, size: label.fontSize, font: label.fontFamily });
  if (g.role === 'brand') { if (shape) o.color = shape.fill; }
  else { if (shape) o.fill = shape.fill; if (label) o.ink = label.fill; }
  return o;
}
