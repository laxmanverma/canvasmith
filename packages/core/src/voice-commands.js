/* Voice command catalog — ONE table that drives everything voice does.

   Each entry is a feature the editor (or the host shell) can perform, described once:
     id     the action name a command carries ({ action: id, ...args })
     doc    one line for the AI model (what it does, what the args mean)
     args   argument spec -> validation/clamping for ANYTHING that comes from a model
     say    [regex, builder] pairs: the instant, offline phrase grammar (first match wins)
     ex     example phrases (the test-suite asserts each one parses to this id)
     run    (editor, args, ctx) -> message string | Promise<string>; throws Error to report a problem

   Because the grammar, the AI prompt (catalogPrompt) and the validator (normalizeCommand) are all
   generated from this table, adding a feature is one entry — they can't drift apart, which is what
   used to make "half the features don't work by voice". Things the HOST owns (zoom, export, new
   document, theme, panels...) go through ctx.actions[name]; a shell that lacks one reports it. */

import { searchIcons } from './icons.js';
import { makeText, makeShape } from './shapes.js';
import { STICKER_GROUPS } from './stickers.js';
import { ADJUST_CONTROLS, FX_DEFAULTS } from './color.js';
import { HSL_BANDS, HSL_PROPS, setHslValue, getHslValue } from './tone.js';

/* ── colours ─────────────────────────────────────────────────────────────────────────────── */
export const COLORS = {
  red: '#e53935', orange: '#fb8c00', yellow: '#fdd835', green: '#43a047', blue: '#1e88e5',
  purple: '#8e24aa', violet: '#8e24aa', pink: '#ec407a', brown: '#6d4c41', black: '#000000', white: '#ffffff',
  gray: '#9e9e9e', grey: '#9e9e9e', teal: '#00897b', cyan: '#00bcd4', gold: '#ffc107', magenta: '#d81b60',
  navy: '#1a237e', maroon: '#800000', olive: '#808000', lime: '#cddc39', beige: '#f5f0dc', silver: '#c0c0c0',
  turquoise: '#26c6da', indigo: '#3949ab', coral: '#ff7043', peach: '#ffccbc', mint: '#a5d6a7',
};
const colorName = (hex) => Object.keys(COLORS).find(k => COLORS[k] === hex) || '';
const mix = (hex, to, k) => {
  const n = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2].map(i => Math.round(n(hex, i) + (to - n(hex, i)) * k).toString(16).padStart(2, '0')).join('');
};
/* "red", "light blue", "dark green", "#ff8800" -> '#rrggbb' | null */
export function colorOf(s) {
  const t = String(s || '').toLowerCase().trim().replace(/^(?:a |the )/, '');
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (COLORS[t]) return COLORS[t];
  const m = /^(light|pale|dark|deep)\s+(\w+)$/.exec(t);
  if (m && COLORS[m[2]]) return /^(light|pale)$/.test(m[1]) ? mix(COLORS[m[2]], 255, 0.45) : mix(COLORS[m[2]], 0, 0.4);
  return null;
}
const COLOR_RE = '((?:(?:light|pale|dark|deep) )?(?:' + Object.keys(COLORS).join('|') + '))';

/* ── tools ───────────────────────────────────────────────────────────────────────────────── */
export const TOOL_PHRASES = [
  ['magic wand', 'magicwand'], ['wand', 'wand'], ['object select', 'objectselect'], ['object selection', 'objectselect'],
  ['hover select', 'hoverselect'], ['marquee', 'marquee'], ['rectangular marquee', 'marquee'], ['elliptical marquee', 'marquee-ellipse'],
  ['lasso', 'lasso'], ['polygon lasso', 'lasso-poly'], ['magnetic lasso', 'lasso-mag'],
  ['rectangle', 'rect'], ['square', 'rect'], ['box', 'rect'], ['circle', 'ellipse'], ['ellipse', 'ellipse'],
  ['triangle', 'triangle'], ['star', 'star'], ['line', 'line'], ['polygon', 'polygon'],
  ['brush', 'brush'], ['paintbrush', 'brush'], ['pencil', 'pencil'], ['eraser', 'eraser'],
  ['clone', 'clone'], ['clone stamp', 'clone'], ['heal', 'heal'], ['healing brush', 'heal'], ['pen', 'pen'], ['crop', 'crop'], ['hand', 'hand'],
  ['pan', 'hand'], ['bucket', 'bucket'], ['paint bucket', 'bucket'], ['fill tool', 'bucket'], ['gradient', 'gradient'],
  ['eyedropper', 'eyedropper'], ['color picker', 'eyedropper'], ['text', 'type'], ['type', 'type'], ['text tool', 'type'],
  ['move', 'select'], ['select', 'select'], ['pointer', 'select'], ['selection tool', 'select'],
];
const TOOL_IDS = [...new Set(TOOL_PHRASES.map(t => t[1]))];

/* ── adjustments ─────────────────────────────────────────────────────────────────────────── */
const ADJ = Object.fromEntries(ADJUST_CONTROLS.map(c => [c.key, c]));
const ADJ_WORDS = {
  brightness: 'brightness', brighter: 'brightness', exposure: 'exposure', contrast: 'contrast', highlights: 'highlights', shadows: 'shadows',
  temperature: 'temperature', warmth: 'temperature', warm: 'temperature', temp: 'temperature', tint: 'tint',
  saturation: 'saturate', saturate: 'saturate', vibrance: 'vibrance', vibrancy: 'vibrance', hue: 'hue', blur: 'blur', blurriness: 'blur', sharpen: 'sharpen', sharpness: 'sharpen', sharper: 'sharpen',
};
const ADJ_NAMES = Object.keys(ADJ_WORDS).sort((a, b) => b.length - a.length).join('|');
const UP = 'increase|raise|boost|add|more|up|brighten|higher|increase the|raise the|boost the|add more';
const DOWN = 'decrease|lower|reduce|less|down|darken|drop|decrease the|reduce the|lower the|take down|remove|dim';

/* ── helpers ─────────────────────────────────────────────────────────────────────────────── */
const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, half: 50 };
export function num(s) {
  const m = /-?\d+(\.\d+)?/.exec(String(s));
  if (m) return parseFloat(m[0]);
  for (const w of String(s).split(/\s+/)) if (w in NUMBER_WORDS) return NUMBER_WORDS[w];
  return null;
}
const SELF = /^(it|this|that|image|selection|selected area|area|the selection)$/;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const flatLayers = (ed) => { const out = []; const walk = (a) => a.forEach(x => { out.push(x); if (x.children) walk(x.children); }); walk(ed.layers()); return out; };
/* the one active layer, else the first member of a multi-selection ("select all" then "copy") */
const active = (ed) => { const all = flatLayers(ed); return all.find(l => l.active) || all.find(l => l.selected); };
const needLayer = (ed) => { const l = active(ed); if (!l) throw new Error('Select a layer first'); return l; };
const needObj = (ed) => { needLayer(ed); return ed.fc.getActiveObject(); };
/* A photo adjustment on "the image" shouldn't need a click first: with nothing selected, target the
   top-most picture layer. */
function imageTarget(ed) {
  let l = active(ed);
  if (!l) {
    const flat = flatLayers(ed);
    l = flat.find(x => x.role === 'image' || x.role === 'product') || flat.find(x => x.role !== 'background') || flat[0];
    if (!l) throw new Error('There is no image yet');
    ed.activate(l.id);
  }
  return ed.fc.getActiveObject();
}
/* Photo adjustments hit the active layer's filters — or, when the active layer IS an adjustment
   layer, its own params. */
const fxSet = (ed, patch) => { const o = ed.fc.getActiveObject(); if (o && o.role === 'adjustment') ed.setAdjustmentParams(o.id, patch); else ed.setImageFilters(patch); };
const fxGet = (ed) => { const o = ed.fc.getActiveObject(); return o && o.role === 'adjustment' ? { ...FX_DEFAULTS, ...ed.getAdjustmentParams(o.id) } : ed.getImageFilters(); };
const okOrThrow = (r, msg) => { if (r && r.status === 'error') throw new Error(r.message || msg); return r; };
const shell = (ctx, name) => { const f = ctx && ctx.actions && ctx.actions[name]; if (!f) throw new Error(`"${name}" isn't available here`); return f; };
const stickerKeys = [...new Set(STICKER_GROUPS.flatMap(g => g.keys))];
const STICKER_SAY = { heart: 'heart', arrow: 'arrow', sparkle: 'sparkle', star: 'star5', burst: 'burst12', banner: 'banner', ribbon: 'ribbon', bubble: 'bubble', 'speech bubble': 'bubble', tag: 'tag', shield: 'shield', pennant: 'pennant', chevron: 'chevron', blob: 'blob', ring: 'ring', plus: 'plus', diamond: 'diamond' };

/* arg-spec constructors */
const N = (min, max, opt) => ({ t: 'n', min, max, opt });
const E = (...v) => ({ t: 'e', v });
const C = (opt) => ({ t: 'c', opt });
const S = (max = 200, opt) => ({ t: 's', max, opt });
const B = () => ({ t: 'b' });
const P = () => ({ t: 'p' });
const L = (max = 12) => ({ t: 'l', max });

const CATALOG = [];
const cmd = (id, spec) => CATALOG.push({ id, args: {}, say: [], ex: [], ...spec });

/* ═══ edit ═══ */
cmd('undo', { doc: 'undo the last change', say: [[/^(undo|go back|step back|undo that|undo it)$/, () => ({})]], ex: ['undo'], run: (ed) => { ed.undo(); return 'Undo'; } });
cmd('redo', { doc: 'redo', say: [[/^(redo|redo that)$/, () => ({})]], ex: ['redo'], run: (ed) => { ed.redo(); return 'Redo'; } });
cmd('delete', {
  doc: 'delete the selected layer(s)',
  say: [[/^(delete|remove|erase|trash|get rid of)( it| this( layer)?| the layer| layer| selection| selected| that)?$/, () => ({})]], ex: ['delete', 'delete this layer'],
  run: (ed) => { needLayer(ed); ed.deleteSelection(); return 'Deleted'; },
});
cmd('duplicate', {
  doc: 'duplicate the selected layer', say: [[/^(duplicate|clone layer|make a copy|copy layer)( it| this( layer)?| the layer| layer| that)?$/, () => ({})]], ex: ['duplicate'],
  run: (ed) => { const l = needLayer(ed); ed.duplicateLayer(l.id); return 'Duplicated'; },
});
// With a marquee/lasso selection these act on its pixels, as ⌘C / ⌘X do.
cmd('copy', { doc: 'copy the selected layer (or the selected pixels) to the clipboard', say: [[/^copy( it| this| that| layer)?$/, () => ({})]], ex: ['copy'], run: (ed) => { if (ed.selection && ed.copySelectedPixels()) return 'Copied the selection'; needLayer(ed); ed.copySelection(); return 'Copied'; } });
cmd('cut', { doc: 'cut the selected layer (or the selected pixels) to the clipboard', say: [[/^cut( it| this| that| layer)?$/, () => ({})]], ex: ['cut'], run: (ed) => { if (ed.selection && ed.cutSelectedPixels()) return 'Cut the selection'; needLayer(ed); ed.cutSelection(); return 'Cut'; } });
cmd('paste', { doc: 'paste the clipboard', say: [[/^paste( it| here)?$/, () => ({})]], ex: ['paste'], run: (ed) => { ed.pasteClipboard(); return 'Pasted'; } });

/* ═══ selection ═══ */
cmd('selectAll', { doc: 'select every layer', say: [[/^select (all|everything)$/, () => ({})]], ex: ['select all'], run: (ed) => { ed.selectAll(); return 'Selected all'; } });
cmd('selectAllLayers', { doc: 'select every LAYER (selectAll selects every pixel)', say: [[/^select (?:all )?layers$|^select every layer$/, () => ({})]], ex: ['select all layers'], run: (ed) => { ed.selectAllLayers(); return 'Selected all layers'; } });
cmd('deselect', {
  doc: 'clear the selection', say: [[/^(deselect|select none|clear selection|unselect|deselect all|drop selection)$/, () => ({})]], ex: ['deselect'],
  run: (ed) => { ed.clearSelection(); ed.fc.discardActiveObject(); ed.fc.renderAll(); return 'Deselected'; },
});
cmd('invertSelection', { doc: 'invert the pixel selection', say: [[/^invert( the)? selection$/, () => ({})]], ex: ['invert selection'], run: (ed) => { if (!ed.selection) throw new Error('Make a selection first'); ed.invertSelection(); return 'Inverted selection'; } });
cmd('growSelection', {
  doc: 'grow (expand) or shrink (contract) the pixel selection by some pixels',
  args: { dir: E('expand', 'contract'), px: N(1, 200, true) },
  say: [[/^(expand|grow|contract|shrink)( the)? selection(?: by)?\s*(.*)$/, (m) => ({ dir: /expand|grow/.test(m[1]) ? 'expand' : 'contract', px: num(m[3]) ?? 5 })]], ex: ['expand selection by 10', 'shrink selection'],
  run: async (ed, a) => { if (!ed.selection) throw new Error('Make a selection first'); const px = a.px ?? 5; okOrThrow(await (a.dir === 'expand' ? ed.expandSelection(px) : ed.contractSelection(px))); return `${a.dir === 'expand' ? 'Expanded' : 'Contracted'} selection ${px}px`; },
});
cmd('selectSimilar', { doc: 'select similar colours to the current selection', say: [[/^select similar( colou?rs?)?$/, () => ({})]], ex: ['select similar colors'], run: async (ed) => { okOrThrow(await ed.selectSimilar()); return 'Selected similar colours'; } });
cmd('mergeSelection', { doc: 'merge the objects picked by object-select into one selection', say: [[/^merge( the)? selection$/, () => ({})]], ex: ['merge selection'], run: (ed) => { ed.mergeObjectSelection(); return 'Merged selection'; } });
cmd('selectObject', {
  doc: 'select a named thing in the picture, e.g. "the dog" (AI locates it, OpenCV cuts it out)', args: { target: S(80) },
  say: [[/^(?:select|pick out|cut out|grab|find)(?: the| a| an)? (.+?)(?: tool)?$/, (m) => (isChain(m[1]) || TOOL_PHRASES.some(([p]) => m[1] === p) || /^(all|none|everything|layers?|every layer|all layers|it|this|that|similar.*|object)$/.test(m[1]) ? null : { target: m[1] })]],
  ex: ['select the dog'],
  run: (ed, a, ctx) => {
    // "select the circle" / "select the text" name layers that already exist — no AI needed
    const hit = selectByRefs(ed, [a.target], 'replace');
    if (!hit.none && hit.n) return `Selected ${hit.n} layer${hit.n === 1 ? '' : 's'}: ${a.target}`;
    if (ctx && ctx.offline) throw new Error(`No layer named "${a.target}" — finding things in the picture needs AI (offline mode)`);
    return ed.selectObjectByName(a.target).then((r) => { okOrThrow(r, `Couldn't select ${a.target}`); return `Selected ${a.target}`; });
  },
});
cmd('liftToLayer', { doc: 'copy the selected pixels to a new layer', say: [[/^(?:copy selection to|lift selection to|selection to|new layer from selection|layer via copy)(?: a)?(?: new)?( layer)?$/, () => ({})]], ex: ['selection to layer'], run: (ed) => { if (!ed.selection) throw new Error('Make a selection first'); ed.duplicateSelectionToLayer(); return 'Selection copied to a new layer'; } });
cmd('liftToLayer', { doc: 'move the selected pixels onto a new layer, leaving a hole (like a real move)', say: [[/^(?:move|lift) (?:the )?selection to(?: a)?(?: new)? layer$|^lift selection$/, () => ({})]], ex: ['lift selection to layer'], run: (ed) => { if (!ed.selection) throw new Error('Make a selection first'); ed.liftSelectionToLayer(); return 'Selection lifted to a new layer'; } });
cmd('cutToLayer', { doc: 'cut the selected pixels out of the layer onto a new layer', say: [[/^cut selection to( a)?( new)?( layer)?$/, () => ({})]], ex: ['cut selection to layer'], run: (ed) => { if (!ed.selection) throw new Error('Make a selection first'); ed.cutSelectionFromLayer(); return 'Selection cut to a new layer'; } });
cmd('featherSelection', { doc: 'soften the selection edge by N pixels (0 = hard edge); applies to copy / move / recolour of the selection', args: { px: N(0, 250) }, say: [[/^feather(?: the)?(?: selection)?(?: by| to)? (\d+)(?: pixels?| px)?$/, (m) => ({ px: +m[1] })], [/^feather(?: the)?(?: selection)?$/, () => ({ px: 10 })], [/^(?:remove|clear|reset) (?:the )?feather(?:ing)?$/, () => ({ px: 0 })]], ex: ['feather selection 10 pixels'], run: (ed, a) => { if (!ed.selection) throw new Error('Make a selection first'); const r = ed.featherSelection(a.px); okOrThrow(r); return a.px ? `Feathered selection ${a.px}px` : 'Feather removed'; } });
cmd('edgeFeather', { doc: 'fade the active image layer\'s outline by N pixels (0 removes it); with a pixel selection use featherSelection instead', args: { px: N(0, 300) }, say: [[/^feather (?:the )?(?:image|photo|picture|layer|edges?)(?: edges?)?(?: by| to)? (\d+)(?: pixels?| px)?$/, (m) => ({ px: +m[1] })], [/^(?:soften|feather) (?:the )?(?:image |photo |layer )?edges?$/, () => ({ px: 30 })]], ex: ['feather the image 30 pixels'], run: (ed, a) => { const l = needLayer(ed); okOrThrow(ed.setEdgeFeather(l.id, a.px), 'Select an image layer first'); return a.px ? `Feathered edges ${a.px}px` : 'Feather removed'; } });
cmd('nudgeSelection', { doc: 'move the pixel selection (the outline, not the layer) by N pixels in a direction', args: { dir: E('left', 'right', 'up', 'down'), px: N(1, 2000, true) }, say: [[/^(?:move|nudge|shift) (?:the )?selection (left|right|up|down)(?: by)?(?: (\d+)(?: pixels?| px)?)?$/, (m) => ({ dir: m[1], px: m[2] ? +m[2] : 10 })]], ex: ['move selection left 20 pixels'], run: (ed, a) => { if (!ed.selection) throw new Error('Make a selection first'); const px = a.px || 10; ed.nudgeSelection(a.dir === 'left' ? -px : a.dir === 'right' ? px : 0, a.dir === 'up' ? -px : a.dir === 'down' ? px : 0); return `Selection moved ${a.dir} ${px}px`; } });
cmd('clipToSelection', { doc: 'clip the active layer to the pixel selection', say: [[/^clip( the)?( layer)?( to( the)? selection)?$/, () => ({})]], ex: ['clip layer to selection'], run: (ed) => { needLayer(ed); if (!ed.selection) throw new Error('Make a selection first'); ed.clipLayerToSelection(); return 'Clipped to selection'; } });
cmd('clearClip', { doc: 'remove the layer clip', say: [[/^(clear|remove|release)( the)? clip(ping)?( mask)?$/, () => ({})]], ex: ['clear clip'], run: (ed) => { needLayer(ed); ed.clearLayerClip(); return 'Clip cleared'; } });
cmd('recolorSelection', { doc: 'recolor the selected pixels toward a colour, keeping shading', args: { color: C() }, say: [[new RegExp('^recolou?r(?: the)?(?: selection| it)?(?: to| with)? ' + COLOR_RE + '$'), (m) => ({ color: colorOf(m[1]) })]], ex: ['recolor selection red'], run: async (ed, a) => { if (!ed.selection) throw new Error('Make a selection first'); await ed.recolorSelection(a.color); return 'Recolored selection'; } });

/* ═══ layers ═══ */
cmd('group', { doc: 'group the selected layers', say: [[/^group( (it|this|selection|layers))?$/, () => ({})]], ex: ['group'], run: (ed) => { ed.groupSelection(); return 'Grouped'; } });
// leave the sticker/group part being edited (after a double-click) and select the whole thing
cmd('exitGroupEdit', { doc: 'stop editing inside a sticker or group', say: [[/^(?:done|exit|leave|stop editing)(?: (?:the )?(?:group|sticker|inside))?$/, () => ({})]], ex: ['done'], run: (ed) => { if (!ed.isolationParent()) throw new Error('Not editing inside a group'); ed.exitIsolation(); return 'Back to the whole layer'; } });
cmd('ungroup', { doc: 'ungroup', say: [[/^ungroup( (it|this))?$/, () => ({})]], ex: ['ungroup'], run: (ed) => { ed.ungroupSelection(); return 'Ungrouped'; } });
cmd('flip', {
  doc: 'flip the layer horizontally (x) or vertically (y)', args: { axis: E('x', 'y') },
  say: [[/^(?:flip|mirror)(?: it| this| layer| the layer)?(?: (?:horizontal|horizontally|left right|sideways))$|^mirror( it)?$/, () => ({ axis: 'x' })], [/^flip(?: it| this| layer)? (?:vertical|vertically|upside down|up down)$|^flip upside down$/, () => ({ axis: 'y' })]], ex: ['flip horizontally', 'flip vertically'],
  run: (ed, a) => { needLayer(ed); ed.flipLayer(a.axis); return `Flipped ${a.axis === 'x' ? 'horizontally' : 'vertically'}`; },
});
cmd('order', {
  doc: 'change stacking order: top (front), bottom (back), up (forward), down (backward)', args: { dir: E('top', 'bottom', 'up', 'down') },
  say: [
    [/^(?:bring|move|send)(?: it| this| layer)? (?:to )?(?:the )?front$|^bring to front$/, () => ({ dir: 'top' })],
    [/^(?:send|move)(?: it| this| layer)? (?:to )?(?:the )?back$|^send to back$/, () => ({ dir: 'bottom' })],
    [/^(?:bring|move)(?: it| this| layer)? forwards?$/, () => ({ dir: 'up' })],
    [/^(?:send|move)(?: it| this| layer)? backwards?$/, () => ({ dir: 'down' })],
  ], ex: ['bring to front', 'send to back', 'bring forward', 'send backward'],
  run: (ed, a) => { needLayer(ed); ed.arrangeSelection(a.dir); return { top: 'Moved to front', bottom: 'Moved to back', up: 'Moved forward', down: 'Moved backward' }[a.dir]; },
});
cmd('visible', {
  doc: 'show or hide the layer', args: { value: B() },
  say: [[/^(?:hide|hide layer|hide it)$/, () => ({ value: false })], [/^(?:show|show layer|show it|unhide)$/, () => ({ value: true })]], ex: ['hide', 'show'],
  run: (ed, a) => { const l = needLayer(ed); ed.setLayer(l.id, { visible: a.value }); return a.value ? 'Shown' : 'Hidden'; },
});
cmd('lock', {
  doc: 'lock or unlock the layer', args: { value: B() },
  say: [[/^lock( it| this| layer| the layer)?$/, () => ({ value: true })], [/^unlock( it| this| layer| the layer)?$/, () => ({ value: false })]], ex: ['lock', 'unlock'],
  run: (ed, a) => { const l = needLayer(ed); ed.setLayer(l.id, { locked: a.value }); return a.value ? 'Locked' : 'Unlocked'; },
});
cmd('rename', { doc: 'rename the layer', args: { name: S(60) }, say: [[/^(?:rename|name|call)(?: it| this| layer| the layer)?(?: to| as)? (.+)$/, (m) => (new RegExp('^(?:the )?(?:layer )?(?:' + NUM_RE + '|' + ORD_RE + ') (?:layer )?to ').test(m[1]) ? null : { name: m[1] })]], ex: ['rename layer to hero'], run: (ed, a) => { const l = needLayer(ed); ed.setLayer(l.id, { name: a.name }); return `Renamed to ${a.name}`; } });
cmd('align', {
  doc: 'align the layer to the canvas (or several layers to each other): left, right, top, bottom, center (horizontal), middle (vertical)', args: { edge: E('left', 'center', 'right', 'top', 'middle', 'bottom') },
  say: [
    [/^(?:align|move|put|snap)(?: it| this)?(?: to)?(?: the)? (left|right|top|bottom)(?: edge)?$/, (m) => ({ edge: m[1] })],
    [/^center(?: it| this)?(?: horizontally)?$|^align(?: it)? center$|^put it in the (?:center|centre)$/, () => ({ edge: 'center' })],
    [/^(?:center(?: it| this)? vertically|align(?: it)? middle)$/, () => ({ edge: 'middle' })],
  ], ex: ['align left', 'center', 'center vertically'],
  run: (ed, a) => { needLayer(ed); ed.alignActiveSelection(a.edge); return `Aligned ${a.edge}`; },
});
cmd('nudge', {
  doc: 'move the layer by pixels in a direction', args: { dir: E('left', 'right', 'up', 'down'), px: N(1, 2000, true) },
  say: [[/^(?:move|nudge|shift|push)(?: it| this| layer)?(?: to(?: the)?)? (left|right|up|down)(?: a (bit|little))?(?: by)?\s*(\d+|\w+)?(?: pixels?| px)?$/, (m) => ({ dir: m[1], px: num(m[3] || '') ?? (m[2] ? 8 : 20) })]], ex: ['move it left 50'],
  run: (ed, a) => { const o = needObj(ed), px = a.px ?? 20; const d = { left: [-px, 0], right: [px, 0], up: [0, -px], down: [0, px] }[a.dir]; ed.setNumeric({ x: (o.left || 0) + d[0], y: (o.top || 0) + d[1] }); return `Moved ${a.dir} ${px}px`; },
});
cmd('scale', {
  doc: 'resize the layer by a percentage of its current size (200 = twice as big, 50 = half)', args: { percent: N(5, 1000) },
  say: [
    [/^(?:scale|resize|size)(?: it| this| layer)?(?: to| by)? (\d+|\w+)(?: percent|%)$/, (m) => ({ percent: num(m[1]) })],
    [/^(?:(?:make|scale) (?:it |this )?)?(?:(a bit|a little bit|a little|slightly|just a bit|a lot|much|way|far) )?(bigger|larger|smaller)$/, (m) => { const small = m[2] === 'smaller', lot = /lot|much|way|far/.test(m[1] || ''), bit = /bit|little|slightly/.test(m[1] || ''); return { percent: small ? (lot ? 60 : bit ? 90 : 80) : (lot ? 160 : bit ? 110 : 125) }; }],
    [/^(?:double|twice)(?: the)?(?: size)?$/, () => ({ percent: 200 })], [/^half( the)?( size)?$/, () => ({ percent: 50 })],
  ], ex: ['scale 150 percent', 'make it bigger', 'a bit smaller', 'much bigger'],
  run: (ed, a) => { const o = needObj(ed); const k = a.percent / 100; ed.setNumeric({ w: o.getScaledWidth() * k, h: o.getScaledHeight() * k }); return `Scaled ${a.percent}%`; },
});
cmd('opacity', {
  doc: 'layer opacity 0-100', args: { value: N(0, 100) },
  say: [[/^(?:set )?opacity(?: to)? (.+?)(?: percent|%)?$/, (m) => { const n = num(m[1]); return n == null ? null : { value: n }; }], [/^make it (?:more )?(transparent|see through)$/, () => ({ value: 50 })], [/^make it (?:fully )?opaque$/, () => ({ value: 100 })]], ex: ['opacity 50 percent'],
  run: (ed, a) => { const l = needLayer(ed); ed.setLayer(l.id, { opacity: a.value / 100 }); return `Opacity ${Math.round(a.value)}%`; },
});
cmd('rotate', {
  doc: 'rotate the layer by degrees (clockwise positive, negative = counter-clockwise)', args: { degrees: N(-360, 360) },
  say: [[/^(?:rotate|turn|spin)(?: it| this| layer)? (?:by )?(.+?)(?: degrees?)?$/, (m) => { const n = num(m[1]); if (n == null) return null; return { degrees: /left|counter|anti/.test(m[1]) ? -Math.abs(n) : n }; }]], ex: ['rotate 90 degrees'],
  run: (ed, a) => { const o = needObj(ed); ed.setNumeric({ angle: (o.angle || 0) + a.degrees }); return `Rotated ${a.degrees}°`; },
});
cmd('cornerRadius', { doc: 'corner radius of a rectangle, in px', args: { value: N(0, 500) }, say: [[/^(?:set )?(?:corner|round(?:ed)? corners?|corner radius)(?: radius)?(?: to)? (\d+|\w+)(?: px| pixels?)?$/, (m) => ({ value: num(m[1]) })], [/^round(?:ed)? (?:the )?corners$/, () => ({ value: 24 })]], ex: ['corner radius 20'], run: (ed, a) => { needObj(ed); ed.setNumeric({ rx: a.value }); return `Corner radius ${a.value}`; } });

/* ═══ colour & style ═══ */
cmd('fill', {
  doc: 'fill colour of the selected shape/text layer', args: { color: C() },
  say: [[new RegExp('^(?:make it|make this|fill(?: it)?(?: with)?|color(?: it)?|colour(?: it)?|paint it|(?:text|font) colou?r(?: to)?|set (?:the )?(?:color|colour|fill)(?: to)?|change (?:the )?(?:color|colour|fill)(?: to)?) (?:a |the )?' + COLOR_RE + '$'), (m) => ({ color: colorOf(m[1]), name: m[1] })]], ex: ['make it red', 'fill with blue', 'color it light blue'],
  run: (ed, a) => { needLayer(ed); ed.setFill(a.color); return `Filled ${a.name || a.color}`; },
});
cmd('stroke', {
  doc: 'border/outline colour (and optional width px)', args: { color: C(), width: N(0, 100, true) },
  say: [[new RegExp('^(?:border|outline|stroke)(?: it)?(?: with| in| to)? ' + COLOR_RE + '$'), (m) => ({ color: colorOf(m[1]), name: m[1] })]], ex: ['border it red'],
  run: (ed, a) => { const o = needObj(ed); ed.setStroke({ color: a.color, width: a.width ?? Math.max(2, o.strokeWidth || 0) }); return `${a.name || a.color} border`; },
});
cmd('strokeWidth', { doc: 'border thickness in px', args: { value: N(0, 100) }, say: [[/^(?:set )?(?:border|outline|stroke)(?: width| size| thickness)?(?: to)? (\d+|\w+)(?: px| pixels?)?$/, (m) => { const n = num(m[1]); return n == null ? null : { value: n }; }]], ex: ['border width 6'], run: (ed, a) => { needObj(ed); ed.setStroke({ width: a.value }); return `Border ${a.value}px`; } });
cmd('removeFill', { doc: 'hide or show the fill', args: { value: B() }, say: [[/^(?:remove|hide|no) (?:the )?fill$/, () => ({ value: false })], [/^show (?:the )?fill$/, () => ({ value: true })]], ex: ['remove fill'], run: (ed, a) => { needLayer(ed); ed.setFillVisible(a.value); return a.value ? 'Fill shown' : 'Fill hidden'; } });
cmd('removeStroke', { doc: 'hide or show the border', args: { value: B() }, say: [[/^(?:remove|hide|no) (?:the )?(?:border|outline|stroke)$/, () => ({ value: false })], [/^show (?:the )?(?:border|outline|stroke)$/, () => ({ value: true })]], ex: ['remove border'], run: (ed, a) => { needLayer(ed); ed.setStrokeVisible(a.value); return a.value ? 'Border shown' : 'Border hidden'; } });
cmd('gradientFill', {
  doc: 'fill the shape with a gradient between two colours (kind linear|radial, angle 0-360: 0 left→right, 90 top→bottom)', args: { from: C(), to: C(), kind: E('linear', 'radial'), angle: N(0, 360, true) },
  say: [[new RegExp('^(?:make it |fill it with |fill with |apply )?(?:a )?(horizontal |vertical |diagonal |linear |radial )?gradient (?:from )?' + COLOR_RE + ' (?:to|and) ' + COLOR_RE + '(?: at (\\d+)(?: degrees?)?)?$'), (m) => {
    const w = (m[1] || '').trim();
    return { kind: w === 'radial' ? 'radial' : 'linear', from: colorOf(m[2]), to: colorOf(m[3]), angle: m[4] != null ? +m[4] : w === 'vertical' ? 90 : w === 'diagonal' ? 45 : 0 };
  }]], ex: ['gradient from red to blue', 'vertical gradient from white to black', 'gradient from red to blue at 45 degrees'],
  run: (ed, a) => { needObj(ed); ed.setShapeGradient([{ offset: 0, color: a.from }, { offset: 1, color: a.to }], a.kind || 'linear', a.angle ?? 0); return 'Gradient applied'; },
});
cmd('borderStyle', { doc: 'border style: solid, dashed or dotted', args: { style: E('solid', 'dashed', 'dotted') }, say: [[/^(solid|dashed|dotted|dash|dot) (?:border|outline|stroke)$|^(?:make )?(?:the )?(?:border|outline|stroke) (solid|dashed|dotted)$/, (m) => ({ style: { dash: 'dashed', dot: 'dotted' }[m[1] || m[2]] || m[1] || m[2] })]], ex: ['dashed border', 'dotted outline'], run: (ed, a) => { const o = needObj(ed); ed.setStroke({ style: a.style, ...(o.strokeWidth ? {} : { width: 3 }) }); return `${a.style} border`; } });
cmd('borderPosition', { doc: 'where the border sits relative to the shape edge: inside, center or outside', args: { position: E('inside', 'center', 'outside') }, say: [[/^(?:put |place |set )?(?:the )?(?:border|outline|stroke)(?: position)?(?: to| on| at)? (inside|center|outside)$/, (m) => ({ position: m[1] })]], ex: ['border inside', 'outline outside'], run: (ed, a) => { needObj(ed); ed.setStroke({ position: a.position }); return `Border ${a.position}`; } });
cmd('borderEnds', { doc: 'border line end caps (butt|round|square) or corner joins (miter|round|bevel)', args: { cap: E('butt', 'round', 'square', true), join: E('miter', 'round', 'bevel', true) }, say: [[/^(?:make )?(?:the )?(?:border )?(?:line )?(?:caps|ends) (butt|round|square)$|^(butt|round|square) (?:caps|line ends)$/, (m) => ({ cap: m[1] || m[2] })], [/^(?:make )?(?:the )?(?:border )?(?:corners|joins?) (miter|round|bevel)$|^(miter|round|bevel) (?:corners|joins?)$/, (m) => ({ join: m[1] || m[2] })]], ex: ['round caps', 'bevel joins'], run: (ed, a) => { needObj(ed); ed.setStroke({ ...(a.cap ? { cap: a.cap } : {}), ...(a.join ? { join: a.join } : {}) }); return 'Border updated'; } });
cmd('shadow', {
  doc: 'drop shadow on the layer: on (soft default), off, or custom blur px / colour', args: { on: B(), blur: N(0, 100, true), color: C(true) },
  say: [[/^(?:add |apply |give it )?(?:a )?(?:drop )?shadow$|^add (?:a )?shadow$/, () => ({ on: true })], [/^(?:remove|clear|no|turn off)(?: the)? shadow$/, () => ({ on: false })], [/^(?:shadow|blur shadow)(?: blur)?(?: to)? (\d+)$/, (m) => ({ on: true, blur: num(m[1]) })]], ex: ['add shadow', 'remove shadow'],
  run: (ed, a) => { needObj(ed); if (a.on === false) ed.setShadow({ color: '#000000', blur: 0, offsetX: 0, offsetY: 0 }); else ed.setShadow({ color: a.color || 'rgba(0,0,0,0.45)', blur: a.blur ?? 18, offsetX: 0, offsetY: a.blur ? Math.round(a.blur / 3) : 6 }); return a.on === false ? 'Shadow removed' : 'Shadow added'; },
});
cmd('autoShadow', { doc: 'one-click soft shadow that sits the object on the page (toggles)', say: [[/^auto shadow$|^(?:add )?(?:a )?(?:soft|natural|auto) shadow$/, () => ({})]], ex: ['auto shadow'], run: async (ed) => { const l = needLayer(ed); const r = await ed.toggleAutoShadow(l.id); return r && r.on === false ? 'Shadow removed' : 'Auto shadow added'; } });

/* ═══ text ═══ */
const needText = (ed) => { const o = needObj(ed); if (!/text/i.test(o.type)) throw new Error('Select a text layer first'); return o; };
cmd('addText', {
  doc: 'add a text layer with the given words', args: { text: S(200, true) },
  say: [[/^(?:add|insert|create|write)(?: a| the)? (?:text|title|heading|headline)(?: layer)?(?: (?:saying|that says|with|reading|says))? ?(.*)$/, (m) => ({ text: m[1] })], [/^(?:write|type)(?: out)? (?!tool$)(.+)$/, (m) => ({ text: m[1] })]], ex: ['add text saying hello world', 'add the text hello', 'write hello', 'type hello world'],
  run: (ed, a) => {
    const t = makeText(ed.fabric, { x: ed.W / 2 - 100, y: ed.H / 2 - 24 }, a.text ? { text: a.text } : {});
    ed.fc.add(t); ed.fc.setActiveObject(t); ed.fc.renderAll(); ed.commit('text'); return 'Added text';
  },
});
cmd('setText', { doc: 'change the words of the selected text layer', args: { text: S(300) }, say: [[/^(?:change|set|edit|update) (?:the )?text (?:to|says?) (.+)$|^(?:make it|make the text) say (.+)$/, (m) => ({ text: m[1] || m[2] })]], ex: ['change the text to sale today'], run: (ed, a) => { const o = needText(ed); o.set('text', a.text); o.dirty = true; ed.fc.renderAll(); ed.commit('text'); return 'Text changed'; } });
cmd('font', { doc: 'font family of the text layer (e.g. Roboto, Playfair Display, Arial)', args: { family: S(60) }, say: [[/^(?:use |set |change )?(?:the )?font(?: to| family)? (?!size)(.+)$|^use (.+) font$/, (m) => ({ family: (m[1] || m[2]).replace(/\b\w/g, c => c.toUpperCase()) })]], ex: ['font roboto'], run: (ed, a) => { needText(ed); ed.setTextProps({ fontFamily: a.family }); return `Font ${a.family}`; } });
cmd('fontSize', { doc: 'text size in px', args: { value: N(4, 800) }, say: [[/^(?:(?:set|make) (?:the )?)?(?:font |text )size(?: to)? (\d+|\w+)$|^(?:make )?(?:the )?(?:text|font) (\d+) (?:px|pixels?)$/, (m) => ({ value: num(m[1] || m[2]) })]], ex: ['font size 64', 'text size 24'], run: (ed, a) => { needText(ed); ed.setTextProps({ fontSize: a.value }); return `Font size ${a.value}`; } });
cmd('textStyle', {
  doc: 'text style toggles', args: { style: E('bold', 'italic', 'underline', 'strike', 'normal'), value: B() },
  say: [[/^(?:make it |make the text |text )?(bold|italic|underline|underlined)$/, (m) => ({ style: m[1].replace('underlined', 'underline'), value: true })], [/^(?:remove|no|unbold|un-?italic|not) ?(bold|italic|underline)?$/, (m) => ({ style: m[1] || 'normal', value: false })], [/^strike ?through$|^cross (?:it )?out$/, () => ({ style: 'strike', value: true })], [/^(?:normal|regular) (?:text|weight)$/, () => ({ style: 'normal', value: false })]], ex: ['bold', 'italic', 'underline'],
  run: (ed, a) => {
    needText(ed);
    const p = { bold: { fontWeight: a.value ? 'bold' : 'normal' }, italic: { fontStyle: a.value ? 'italic' : 'normal' }, underline: { underline: !!a.value }, strike: { linethrough: !!a.value }, normal: { fontWeight: 'normal', fontStyle: 'normal', underline: false, linethrough: false } }[a.style];
    ed.setTextProps(p); return `${a.style}${a.value ? '' : ' off'}`;
  },
});
cmd('textAlign', { doc: 'text alignment', args: { align: E('left', 'center', 'right', 'justify') }, say: [[/^(?:text |align text |align the text )(left|center|right|justify)$|^(left|center|right|justify) align(?: text)?$/, (m) => ({ align: m[1] || m[2] })]], ex: ['text center', 'justify align'], run: (ed, a) => { needText(ed); ed.setTextProps({ textAlign: a.align }); return `Text ${a.align}`; } });
cmd('lineHeight', { doc: 'line spacing multiplier (0.5-3, 1.2 normal)', args: { value: N(0.5, 3) }, say: [[/^(?:set )?line (?:height|spacing)(?: to)? ([\d.]+)$/, (m) => ({ value: parseFloat(m[1]) })]], ex: ['line height 1.5'], run: (ed, a) => { needText(ed); ed.setTextProps({ lineHeight: a.value }); return `Line height ${a.value}`; } });
cmd('letterSpacing', { doc: 'letter spacing (-100..1000, 0 normal)', args: { value: N(-100, 1000) }, say: [[/^(?:set )?(?:letter|character) spacing(?: to)? (-?\d+)$/, (m) => ({ value: num(m[1]) })]], ex: ['letter spacing 50'], run: (ed, a) => { needText(ed); ed.setTextProps({ charSpacing: a.value }); return `Letter spacing ${a.value}`; } });

/* ═══ tools & brush ═══ */
cmd('tool', {
  doc: 'switch tool: ' + TOOL_IDS.join(', '), args: { tool: E(...TOOL_IDS) },
  say: [[/^(?:use|switch to|select|pick|choose|open|activate|go to|enable)?\s*(?:the )?(.+?)(?: tool)?$/, (m) => { const hit = TOOL_PHRASES.find(([p]) => m[1] === p); return hit ? { tool: hit[1], name: hit[0] } : null; }]], ex: ['brush', 'use the lasso tool', 'magic wand'],
  run: (ed, a) => { ed.setTool(a.tool); return `${a.name || a.tool} tool`; },
});
cmd('size', { doc: 'brush/eraser/tool size in px', args: { value: N(1, 500) }, say: [[/^(?:set )?(?:brush |pen |eraser |tool )?size(?: to)? (.+)$/, (m) => { const n = num(m[1]); return n == null ? null : { value: n }; }], [/^(?:make )?(?:the )?brush (bigger|larger|smaller)$/, (m) => ({ value: m[1] === 'smaller' ? -1 : -2 })]], ex: ['brush size 40'], run: (ed, a) => { const v = a.value === -1 ? Math.max(1, Math.round(ed.toolOpts.size * 0.7)) : a.value === -2 ? Math.round(ed.toolOpts.size * 1.4) : Math.max(1, a.value); ed.setToolOptions({ size: v }); return `Size ${v}`; } });
cmd('brushColor', { doc: 'colour the brush / shape tools draw with', args: { color: C() }, say: [[new RegExp('^(?:brush|pen|paint|draw|stroke)(?: color| colour)?(?: with| in| to)? ' + COLOR_RE + '$|^(?:set )?(?:brush|tool|foreground) colou?r(?: to)? ' + COLOR_RE + '$'), (m) => ({ color: colorOf(m[1] || m[2]) })]], ex: ['brush color red'], run: (ed, a) => { ed.setToolOptions({ color: a.color, fill: a.color }); return `Brush colour ${a.color}`; } });
cmd('brushOpacity', { doc: 'tool opacity 0-100', args: { value: N(1, 100) }, say: [[/^(?:set )?(?:brush|tool) opacity(?: to)? (\d+|\w+)(?: percent|%)?$/, (m) => ({ value: num(m[1]) })]], ex: ['brush opacity 50'], run: (ed, a) => { ed.setToolOptions({ opacity: a.value / 100 }); return `Brush opacity ${a.value}%`; } });
cmd('hardness', { doc: 'brush hardness 0-100', args: { value: N(0, 100) }, say: [[/^(?:set )?(?:brush )?hardness(?: to)? (\d+|\w+)(?: percent|%)?$/, (m) => ({ value: num(m[1]) })], [/^(?:make )?(?:the )?brush (soft|softer)$/, () => ({ value: 20 })], [/^(?:make )?(?:the )?brush (hard|harder)$/, () => ({ value: 100 })]], ex: ['brush hardness 30'], run: (ed, a) => { ed.setToolOptions({ hardness: a.value / 100 }); return `Hardness ${a.value}%`; } });
cmd('tolerance', { doc: 'wand / object-select tolerance 0-255', args: { value: N(0, 255) }, say: [[/^(?:set )?(?:wand )?tolerance(?: to)? (\d+|\w+)$/, (m) => ({ value: num(m[1]) })]], ex: ['tolerance 80'], run: (ed, a) => { ed.setToolOptions({ tolerance: a.value }); return `Tolerance ${a.value}`; } });
cmd('toleranceBy', { doc: 'nudge wand / object-select tolerance up or down', args: { dir: E('up', 'down') }, say: [[new RegExp('^(?:' + UP + ') (?:the )?(?:wand )?tolerance$'), () => ({ dir: 'up' })], [new RegExp('^(?:' + DOWN + ') (?:the )?(?:wand )?tolerance$'), () => ({ dir: 'down' })]], ex: ['increase tolerance', 'lower the tolerance'], run: (ed, a) => { const v = clamp((ed.toolOpts.tolerance ?? 64) + (a.dir === 'up' ? 16 : -16), 0, 255); ed.setToolOptions({ tolerance: v }); return `Tolerance ${v}`; } });
cmd('snap', { doc: 'smart-guide snapping on/off', args: { on: B() }, say: [[/^(?:turn )?(?:on |enable )?snapping(?: on)?$|^snap on$/, () => ({ on: true })], [/^(?:turn )?(?:off |disable )snapping(?: off)?$|^snap off$|^snapping off$/, () => ({ on: false })]], ex: ['snapping off'], run: (ed, a) => { ed.setSnapEnabled(a.on); return a.on ? 'Snapping on' : 'Snapping off'; } });
cmd('finish', { doc: 'finish the pen path / polygon lasso being drawn', say: [[/^(?:finish|done|complete|apply)(?: the)?(?: path| shape| lasso| polygon)?$/, () => ({})]], ex: ['finish'], run: (ed) => { if (ed._polyBuild) { ed.finishPolyLasso(); return 'Finished lasso'; } if (ed._penBuild) { ed.finishPen(); return 'Finished path'; } if (ed.crop) { ed.applyCrop(); return 'Applied crop'; } if (ed._pathEdit) { ed.exitPathEdit(); return 'Done editing path'; } throw new Error('Nothing to finish'); } });
cmd('cancel', { doc: 'cancel the pen path / lasso / crop in progress', say: [[/^(?:cancel|abort|never ?mind|escape|stop)$/, () => ({})]], ex: ['cancel'], run: (ed) => { if (ed._polyBuild) ed.cancelPolyLasso(); else if (ed._penBuild) ed.cancelPen(); else if (ed.crop) ed.setTool('select'); else throw new Error('Nothing to cancel'); return 'Cancelled'; } });

/* ═══ photo adjustments ═══ */
const adjLabel = (k) => (ADJ[k] ? ADJ[k].label : k);
cmd('adjust', {
  doc: 'set a photo adjustment on the image to an absolute value (slider units): ' + ADJUST_CONTROLS.map(c => `${c.key} ${c.min}..${c.max}`).join(', '),
  args: { key: E(...ADJUST_CONTROLS.map(c => c.key)), value: N(-3000, 3000) },
  say: [[new RegExp('^(?:set )?(?:the )?(' + ADJ_NAMES + ')(?: to| at)? (-?\\d+(?:\\.\\d+)?)(?: percent|%)?$'), (m) => ({ key: ADJ_WORDS[m[1]], value: parseFloat(m[2]) })]], ex: ['brightness 120', 'saturation 50'],
  run: (ed, a) => { const c = ADJ[a.key]; imageTarget(ed); const v = clamp(a.value, c.min, c.max); ed.setImageFilters({ [a.key]: v }); return `${c.label} ${v}`; },
});
cmd('adjustBy', {
  doc: 'nudge a photo adjustment up or down by a fraction of its range (amount 1-100, default 15)', args: { key: E(...ADJUST_CONTROLS.map(c => c.key)), dir: E('up', 'down'), amount: N(1, 100, true) },
  say: [
    [new RegExp('^(?:' + UP + ') (?:the )?(' + ADJ_NAMES + ')(?: a (?:bit|little|lot))?$'), (m) => ({ key: ADJ_WORDS[m[1]], dir: 'up' })],
    [new RegExp('^(?:' + DOWN + ') (?:the )?(' + ADJ_NAMES + ')(?: a (?:bit|little|lot))?$'), (m) => ({ key: ADJ_WORDS[m[1]], dir: 'down' })],
    [/^(?:make it|make the (?:image|photo|picture)) (brighter|lighter)$/, () => ({ key: 'brightness', dir: 'up' })],
    [/^(?:make it|make the (?:image|photo|picture)) (darker)$/, () => ({ key: 'brightness', dir: 'down' })],
    [/^(?:make it|make the (?:image|photo|picture)) (warmer)$/, () => ({ key: 'temperature', dir: 'up' })],
    [/^(?:make it|make the (?:image|photo|picture)) (cooler|colder)$/, () => ({ key: 'temperature', dir: 'down' })],
    [/^(?:make it|make the (?:image|photo|picture)) (more colou?rful|more vivid|more saturated)$/, () => ({ key: 'saturate', dir: 'up' })],
    [/^(?:make it|make the (?:image|photo|picture)) (less colou?rful|more muted|less saturated|duller)$/, () => ({ key: 'saturate', dir: 'down' })],
    [/^(?:make it|make the (?:image|photo|picture)) (sharper|more contrast|punchier|more contrasty)$/, () => ({ key: 'contrast', dir: 'up' })],
    [/^(?:make it|make the (?:image|photo|picture)) (softer|less contrast|flatter)$/, () => ({ key: 'contrast', dir: 'down' })],
    [/^(?:make it|make the (?:image|photo|picture)) (blurry|blurrier)$/, () => ({ key: 'blur', dir: 'up' })],
    [/^(?:make it|make the (?:image|photo|picture)) (sharper|less blurry|clearer)$/, () => ({ key: 'blur', dir: 'down' })],
  ], ex: ['increase brightness', 'reduce contrast', 'make it warmer', 'make it brighter'],
  run: (ed, a) => {
    const c = ADJ[a.key]; imageTarget(ed);
    const cur = fxGet(ed)[a.key] ?? 0, step = (c.max - c.min) * (a.amount ?? 15) / 100;
    const v = clamp(Math.round((cur + (a.dir === 'up' ? step : -step)) * 100) / 100, c.min, c.max);
    fxSet(ed, { [a.key]: v }); return `${c.label} ${v}`;
  },
});
cmd('blackAndWhite', { doc: 'turn the image black & white (saturation 0)', say: [[/^(?:make it |turn it |convert (?:it )?to )?(?:black and white|black & white|grayscale|greyscale|monochrome|b and w)$/, () => ({})]], ex: ['black and white'], run: (ed) => { imageTarget(ed); fxSet(ed, { saturate: 0 }); return 'Black & white'; } });
cmd('invertColors', { doc: 'invert the image colours (toggle)', say: [[/^invert(?: the)?(?: image| photo| picture)?(?: colou?rs)?$/, () => ({})]], ex: ['invert colors'], run: (ed) => { imageTarget(ed); fxSet(ed, { invert: !fxGet(ed).invert }); return 'Inverted colours'; } });
cmd('resetAdjustments', { doc: 'reset all photo adjustments on the image', say: [[/^(?:reset|clear|remove) (?:all )?(?:the )?(?:adjustments?|filters?|effects?|edits)$/, () => ({})]], ex: ['reset adjustments'], run: (ed) => { imageTarget(ed); fxSet(ed, { ...FX_DEFAULTS }); return 'Adjustments reset'; } });
cmd('straighten', { doc: 'straighten / keystone the photo: angle -45..45 degrees, vertical/horizontal -100..100', args: { key: E('angle', 'vertical', 'horizontal'), value: N(-100, 100) }, say: [[/^straighten(?: by| to)? (-?\d+(?:\.\d+)?)(?: degrees?)?$/, (m) => ({ key: 'angle', value: parseFloat(m[1]) })], [/^(?:set )?(vertical|horizontal) (?:keystone|perspective)(?: to)? (-?\d+)$/, (m) => ({ key: m[1], value: parseFloat(m[2]) })]], ex: ['straighten 3 degrees'], run: (ed, a) => { imageTarget(ed); ed.setImageGeometry({ [a.key]: a.key === 'angle' ? clamp(a.value, -45, 45) : a.value }); return `${a.key} ${a.value}`; } });
cmd('adjustmentLayer', { doc: 'add a non-destructive adjustment layer', say: [[/^add (?:an? )?adjustment layer$/, () => ({})]], ex: ['add adjustment layer'], run: (ed) => { ed.addAdjustmentLayer({}); return 'Adjustment layer added'; } });

/* ═══ masks ═══ */
cmd('mask', { doc: 'layer mask: add, remove or invert', args: { op: E('add', 'remove', 'invert') }, say: [[/^(add|create) (?:a )?(?:layer )?mask$/, () => ({ op: 'add' })], [/^(remove|delete) (?:the )?(?:layer )?mask$/, () => ({ op: 'remove' })], [/^invert (?:the )?(?:layer )?mask$/, () => ({ op: 'invert' })]], ex: ['add mask', 'invert mask'], run: (ed, a) => { const l = needLayer(ed); if (a.op === 'add') ed.addMask(l.id); else if (a.op === 'remove') ed.removeMask(l.id); else ed.invertMask(l.id); return `Mask ${a.op}`; } });

/* ═══ canvas ═══ */
cmd('canvasSize', {
  doc: 'resize the canvas (artboard) in px', args: { w: N(16, 8000), h: N(16, 8000) },
  say: [[/^(?:set |change |resize )?(?:the )?canvas(?: size)?(?: to)? (\d+)(?: by | x |x )(\d+)$/, (m) => ({ w: +m[1], h: +m[2] })]], ex: ['canvas size 1080 by 1080'],
  run: (ed, a) => { ed.resizeCanvas(a.w, a.h); return `Canvas ${a.w}×${a.h}`; },
});
cmd('canvasRatio', {
  doc: 'set the canvas to an aspect ratio (keeps the larger side)', args: { w: N(1, 100), h: N(1, 100) },
  say: [[/^(?:set |change |make )?(?:the )?canvas(?: to| size)? (\d+)(?: to |:| by )(\d+)(?: ratio)?$|^(?:make (?:it )?)?(\d+)(?: to |:)(\d+)(?: canvas| ratio)$/, (m) => ({ w: +(m[1] || m[3]), h: +(m[2] || m[4]) })], [/^(?:make )?(?:the )?canvas (square)$/, () => ({ w: 1, h: 1 })], [/^(?:make )?(?:the )?canvas (widescreen|landscape)$/, () => ({ w: 16, h: 9 })], [/^(?:make )?(?:the )?canvas (portrait|story|vertical)$/, () => ({ w: 9, h: 16 })]], ex: ['canvas 16 to 9', 'canvas square'],
  run: (ed, a) => { const r = a.w / a.h, big = Math.max(ed.W, ed.H); const w = r >= 1 ? big : Math.round(big * r), h = r >= 1 ? Math.round(big / r) : big; ed.resizeCanvas(w, h); return `Canvas ${a.w}:${a.h}`; },
});
cmd('canvasBackground', { doc: 'set the page/background colour of the canvas', args: { color: C() }, say: [[new RegExp('^(?:set |change |make )?(?:the )?(?:canvas |page |artboard )?background(?: colou?r)?(?: to| as| is)? ' + COLOR_RE + '$'), (m) => ({ color: colorOf(m[1]) })]], ex: ['background white'], run: (ed, a) => { ed.setCanvasBackground({ color: a.color, alpha: 1 }); return `Background ${a.color}`; } });
cmd('transparentBackground', { doc: 'make the canvas background transparent', say: [[/^(?:make )?(?:the )?(?:canvas )?background transparent$|^transparent background$/, () => ({})]], ex: ['transparent background'], run: (ed) => { ed.setCanvasBackground(null); return 'Transparent background'; } });
cmd('applyCrop', { doc: 'apply the crop in progress', say: [[/^(?:apply|confirm|commit) (?:the )?crop$/, () => ({})]], ex: ['apply crop'], run: (ed) => { if (!ed.crop) throw new Error('Pick the crop tool and frame the crop first'); ed.applyCrop(); return 'Cropped'; } });

/* ═══ insert ═══ */
const SHAPE_ID = { rectangle: 'rect', square: 'rect', box: 'rect', circle: 'ellipse', oval: 'ellipse', hexagon: 'polygon' };
const SIZE_WORDS = { tiny: 0.08, small: 0.14, medium: 0.25, big: 0.4, large: 0.4, huge: 0.6 };
const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const POSITIONS = ['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'];
const POS_FRAC = { center: [0.5, 0.5], top: [0.5, 0.25], bottom: [0.5, 0.75], left: [0.25, 0.5], right: [0.75, 0.5], 'top left': [0.25, 0.25], 'top right': [0.75, 0.25], 'bottom left': [0.25, 0.75], 'bottom right': [0.75, 0.75] };
const SHAPE_WORDS_RE = 'rectangle|square|box|circle|oval|ellipse|triangle|star|line|polygon|hexagon';
/* "draw the big red circle in the center", "add two squares", "make a rounded rectangle at the top":
   a loose shape of words around the shape noun, then each piece is read by its own small rule.
   Any word we can't account for returns null so the phrase goes on (to the LLM) instead of being
   half-understood. */
function parseShapePhrase(m) {
  const out = { shape: SHAPE_ID[m[3]] || m[3] };
  let n = m[1] && /^\d+$|^(one|two|three|four|five)$/.test(m[1]) ? (COUNT_WORDS[m[1]] || +m[1]) : 1;
  if (m[4] && n === 1 && !(m[1] && /^(a|an|the)$/.test(m[1]))) n = 2;   // bare plural: "draw circles"
  if (n > 1) out.count = Math.min(n, 10);
  let mods = ' ' + m[2].trim() + ' ';
  const px = /\s(\d+)(?: ?px| pixels?)?\s/.exec(mods);
  if (px) { out.size = +px[1]; mods = mods.replace(px[0], ' '); }
  mods = mods.replace(/\s(tiny|small|medium|big|large|huge)\s/, (_, w) => { out.sizeWord = w; return ' '; });
  if (/\srounded\s/.test(mods) && out.shape === 'rect') out.rounded = true;
  mods = mods.replace(/\s(?:rounded|straight|diagonal|plain|simple|solid|filled|new|little|nice|basic)\s/g, ' ').trim();
  if (mods) { const c = colorOf(mods); if (!c) return null; out.color = c; out.name = mods; }
  let tail = (m[5] || '').trim();
  const tc = new RegExp('(?:^|\\s)(?:in|with|filled with|colou?red|coloured) ' + COLOR_RE + '$').exec(tail);
  if (tc) { out.color = colorOf(tc[1]); tail = tail.slice(0, tc.index).trim(); }
  const tp = /(?:^|\s)(?:in|at|on|to)(?: the)? (?:(?:center|centre|middle) ?|((?:top|bottom) (?:left|right)|top|bottom|left|right)(?: side| corner| part)?)$/.exec(tail);
  if (tp) { out.position = tp[1] || 'center'; tail = tail.slice(0, tp.index).trim(); }
  if (tail) return null;
  return out;
}
cmd('addShape', {
  doc: 'add one or more plain vector shapes (rect/ellipse/triangle/star/line/polygon — NOT AI) with optional fill colour, size in px, count and position. Use this for any "draw/add/make a circle|square|star|two circles|a red square at the top|…"',
  args: { shape: E('rect', 'ellipse', 'triangle', 'star', 'line', 'polygon'), color: C(true), size: N(8, 4000, true), count: N(1, 10, true), position: E(...POSITIONS, true), rounded: { t: 'b', opt: true } },
  say: [[new RegExp('^(?:add|insert|draw|create|make)(?: (a|an|the|\\d+|one|two|three|four|five))?((?: [\\w#]+){0,4}?) (' + SHAPE_WORDS_RE + ')(s|es)?(?: shape)?((?: (?:in|with|filled with|colou?red|coloured|at|on|to)(?: the)? [\\w ]+?)?)$'), parseShapePhrase]],
  ex: ['add a circle', 'add rectangle', 'add a red circle', 'draw a big blue square', 'add a 200 pixel star', 'draw the circle', 'draw the star', 'draw two circles', 'add 3 red squares', 'draw a circle in the center', 'draw a circle at the top', 'make a rounded rectangle', 'draw a straight line'],
  run: (ed, a) => {
    const size = a.size ?? Math.round(Math.min(ed.W, ed.H) * (SIZE_WORDS[a.sizeWord] ?? (a.count > 1 ? 0.18 : 0.25)));
    const n = a.count || 1, [fx, fy] = POS_FRAC[a.position || 'center'];
    let o;
    for (let i = 0; i < n; i++) {
      // several shapes spread side by side around the chosen spot instead of piling up
      const x = n === 1 ? ed.W * fx : ed.W * (0.5 + (i - (n - 1) / 2) * Math.min(0.22, 0.8 / n)) + (fx - 0.5) * ed.W * 0.5;
      o = makeShape(ed.fabric, a.shape, { x, y: ed.H * fy }, { fill: a.color || ed.toolOpts.fill || '#000000', size });
      if (!o) throw new Error('Could not add that shape');
      if (a.rounded && a.shape === 'rect') o.set({ rx: Math.round(size * 0.2), ry: Math.round(size * 0.2) });
      ed.fc.add(o);
    }
    ed.fc.setActiveObject(o); ed.fc.renderAll(); ed.commit('shape');
    return `Added ${n > 1 ? n + ' ' : ''}${a.color ? colorName(a.color) + ' ' : ''}${a.shape}${n > 1 ? 's' : ''}`;
  },
});
cmd('resize', {
  doc: 'set the selected layer\'s width and/or height in px', args: { w: N(1, 8000, true), h: N(1, 8000, true) },
  say: [
    [/^(?:make it|set it to|resize(?: it)? to|size it)\s*(\d+)(?: ?px| pixels?)? (?:by|x) (\d+)(?: ?px| pixels?)?$|^(?:resize|size)(?: it)? (\d+) (?:by|x) (\d+)$/, (m) => ({ w: +(m[1] || m[3]), h: +(m[2] || m[4]) })],
    [/^(?:make it|set it to|resize(?: it)? to) (\d+)(?: ?px| pixels?)? (wide|tall|high)$/, (m) => (m[2] === 'wide' ? { w: +m[1] } : { h: +m[1] })],
    [/^(?:set )?(?:the )?(width|height)(?: to)? (\d+)(?: ?px| pixels?)?$/, (m) => (m[1] === 'width' ? { w: +m[2] } : { h: +m[2] })],
  ], ex: ['make it 300 wide', 'height 200', 'resize to 300 by 200'],
  run: (ed, a) => { needObj(ed); if (a.w == null && a.h == null) throw new Error('Say a width or height'); ed.setNumeric({ ...(a.w != null ? { w: a.w } : {}), ...(a.h != null ? { h: a.h } : {}) }); return 'Resized'; },
});
cmd('moveTo', { doc: 'put the layer\'s top-left at x,y px on the canvas', args: { x: N(-8000, 8000), y: N(-8000, 8000) }, say: [[/^(?:move|put|place|position)(?: it| this)? (?:to |at )(?:x )?(-?\d+)(?:,| and| by|\s)\s*(?:y )?(-?\d+)$/, (m) => ({ x: +m[1], y: +m[2] })]], ex: ['move to 100 200'], run: (ed, a) => { needObj(ed); ed.setNumeric({ x: a.x, y: a.y }); return `Moved to ${a.x}, ${a.y}`; } });
cmd('place', {
  doc: 'put the selected layer in a region of the canvas: top, bottom, left, right, centre or a corner (keeps its size)', args: { position: E(...POSITIONS) },
  say: [
    [/^(?:(?:move|put|place|position|send)(?: it| this)? )?(?:in|at|to|into|on) (?:the )?(?:(center|centre|middle)|((?:top|bottom) (?:left|right)|top|bottom|left|right))(?: side| corner| part| edge)?$|^(?:move|put|place|position|send)(?: it| this)? (?:the )?((?:top|bottom) (?:left|right))(?: corner)?$/, (m) => ({ position: m[1] ? 'center' : (m[2] || m[3]) })],
    // "change position to top left", "set its position to the bottom right corner", "position top left"
    [/^(?:(?:change|set|update|switch|adjust|make)(?: its| the| it)* )?(?:position|placement|alignment|location)(?: of it)?(?: to| at| in)?(?: the)? (?:(center|centre|middle)|((?:top|bottom) (?:left|right)|(?:left|right) (?:top|bottom)|top|bottom|left|right))(?: side| corner| part| edge)?$/, (m) => ({ position: m[1] ? 'center' : m[2].replace(/^(left|right) (top|bottom)$/, '$2 $1') })],
  ],
  ex: ['put it in the top left', 'move it to the bottom right corner', 'in the center'],
  run: (ed, a) => {
    const o = needObj(ed); o.setCoords();
    const b = o.getBoundingRect(true), mg = Math.round(Math.min(ed.W, ed.H) * 0.04), p = a.position;
    const x = /left/.test(p) ? mg : /right/.test(p) ? ed.W - b.width - mg : (ed.W - b.width) / 2;
    const y = /top/.test(p) ? mg : /bottom/.test(p) ? ed.H - b.height - mg : (ed.H - b.height) / 2;
    o.set({ left: (o.left || 0) + x - b.left, top: (o.top || 0) + y - b.top }); o.setCoords();
    ed.fc.renderAll(); ed.commit('transform'); return `Placed ${p}`;
  },
});
cmd('distribute', {
  doc: 'space 3+ selected layers evenly, horizontally or vertically', args: { axis: E('horizontal', 'vertical') },
  say: [[/^(?:distribute|space|spread)(?: them| these| the layers| layers| objects)?(?: evenly)?(?: (horizontally|vertically|across|down))?(?: evenly)?$/, (m) => ({ axis: m[1] === 'vertically' || m[1] === 'down' ? 'vertical' : 'horizontal' })]], ex: ['distribute horizontally', 'space them evenly vertically'],
  run: (ed, a) => {
    const sel = ed.fc.getActiveObject();
    if (!sel || sel.type !== 'activeSelection' || sel.getObjects().length < 3) throw new Error('Select three or more layers to distribute');
    const h = a.axis === 'horizontal', objs = sel.getObjects().map(o => { o.setCoords(); return { o, b: o.getBoundingRect(true) }; }).sort((p, q) => h ? p.b.left - q.b.left : p.b.top - q.b.top);
    const size = (x) => h ? x.b.width : x.b.height, pos = (x) => h ? x.b.left : x.b.top;
    const last = objs[objs.length - 1], span = pos(last) + size(last) - pos(objs[0]);
    const gap = (span - objs.reduce((t, x) => t + size(x), 0)) / (objs.length - 1);
    let cur = pos(objs[0]);
    objs.forEach((x) => { const d = cur - pos(x); if (h) x.o.left = (x.o.left || 0) + d; else x.o.top = (x.o.top || 0) + d; x.o.setCoords(); cur += size(x) + gap; });
    sel.addWithUpdate && sel.addWithUpdate(); ed.fc.renderAll(); ed.commit('distribute'); return `Distributed ${a.axis}ly`;
  },
});
cmd('addSticker', {
  doc: 'add a sticker/badge/arrow/burst: ' + stickerKeys.join(', '), args: { key: E(...stickerKeys) },
  say: [[/^(?:add|insert)(?: a| an| the)? (?:sticker )?(.+?)(?: sticker)?$/, (m) => { const k = STICKER_SAY[m[1]] || stickerKeys.find(x => x.toLowerCase() === m[1].replace(/\s+/g, '')); return k ? { key: k, name: m[1] } : null; }]], ex: ['add a heart', 'add sparkle sticker'],
  run: (ed, a) => { ed.addSticker(a.key); return `Added ${a.name || a.key}`; },
});
cmd('addIcon', {
  doc: 'add an icon from the free icon library by keyword, e.g. "heart", "shopping cart", "camera"', args: { name: S(60) },
  say: [[/^(?:add|insert)(?: a| an| the)? (.+?) icon$/, (m) => ({ name: m[1] })]], ex: ['add a heart icon'],
  run: async (ed, a) => {
    const ids = await searchIcons(a.name, 1);
    if (!ids.length) throw new Error(`No icon found for "${a.name}"`);
    await ed.addIcon(ids[0]);
    return `Added ${a.name} icon`;
  },
});
const adText = (id, doc, re, fn, label, ex, opts) => cmd(id, { doc, say: [[re, () => ({})]], ex: [ex], run: (ed) => { ed[fn](null, opts); return `Added ${label}`; } });
adText('addCTA', 'add a call-to-action button', /^add (?:a |an )?(?:cta|call to action|button)(?: button)?$/, 'addCTA', 'CTA button', 'add a CTA button', { text: 'Shop now' });
adText('addBadge', 'add a badge chip', /^add (?:a |an )?badge$/, 'addBadge', 'badge', 'add a badge', { text: 'Sale' });
adText('addPrice', 'add a price tag group', /^add (?:a |an )?price(?: tag)?$/, 'addPrice', 'price', 'add a price', { current: '$29', original: '$40', save: 'Save 27%' });
adText('addBrand', 'add a brand lockup', /^add (?:a |an )?brand(?: lockup| logo)?$/, 'addBrandLockup', 'brand lockup', 'add a brand lockup', { text: 'Brand' });
cmd('openImage', { doc: 'open an image file as a new document (host file picker)', say: [[/^(?:open|load|import)(?: an?| the)?(?: image| photo| picture| file)?(?: file)?$/, () => ({})]], ex: ['open image'], run: (ed, a, ctx) => { shell(ctx, 'openImage')(); return 'Choose an image'; } });
cmd('addImage', { doc: 'add an image file as a new layer (host file picker)', say: [[/^(?:add|insert|place|upload|import|draw|put|bring in|drop in)(?: me)?(?: an?| the| my)? (?:new )?(?:image|photo|picture|logo)(?: layer| file)?$/, () => ({})]], ex: ['add an image'], run: async (ed, a, ctx) => { await shell(ctx, 'addImage')(); return 'Image added'; } });

/* ═══ AI ═══ */
const BG = '(?:background|bg)';
cmd('removeBackground', {
  doc: 'cut the subject out / remove the image background. method: local = offline OpenCV (free, no key), ai = Gemini, auto = AI when a key is set else offline. Afterwards "touch up keep|remove" fixes edges',
  args: { method: E('auto', 'ai', 'local') },
  say: [
    [new RegExp('^(?:remove|delete|erase|cut out|cutout|clear|get rid of)(?: the)?(?: image| photo| picture)? ' + BG + ' (?:offline|locally|local|without ai|with no ai|no ai|for free|using opencv|with opencv|on device|on my device|without internet|without a key)$|^(?:offline|local|free|opencv) (?:remove |removal of |cut out )?(?:the )?' + BG + '(?: remover| removal| remove)?$|^(?:remove|cut out) ' + BG + ' (?:the )?offline way$'), () => ({ method: 'local' })],
    [new RegExp('^(?:remove|delete|erase|cut out|cutout)(?: the)? ' + BG + ' (?:with|using|via|by) (?:ai|gemini|the ai)$|^ai (?:remove |removal of |cut out )?(?:the )?' + BG + '(?: remover| removal| remove)?$'), () => ({ method: 'ai' })],
    [new RegExp('^(?:remove|delete|erase|cut out|cutout|clear|get rid of)(?: the)?(?: image| photo| picture)? ' + BG + '$|^' + BG + ' remover$|^(?:cut out|isolate|extract) (?:the )?(?:subject|product|object|person|main subject)$'), () => ({ method: 'auto' })],
  ], ex: ['remove background', 'remove background offline', 'remove bg locally', 'offline background remover', 'remove background with ai', 'cut out the subject'],
  run: async (ed, a, ctx) => {
    if (ctx && ctx.offline && a.method === 'ai') throw new Error('AI background removal is not available in offline mode — say "remove background offline"');
    const t = imageTarget(ed), r = okOrThrow(await ed.removeBackground({ method: ctx && ctx.offline ? 'local' : (a.method || 'auto'), id: t.id }), 'Background removal failed');
    return `Background removed${r && r.method ? ' (' + (r.method === 'local' ? 'offline' : r.method) + ')' : ''} — say "touch up keep" or "touch up remove" to fix edges`;
  },
});
cmd('aiEdit', { ai: true, doc: 'free-form AI edit of the whole image, e.g. "make it look like sunset" (only the selection if one exists)', args: { instruction: S(300) }, say: [[/^(?:ai |a i )?(?:edit|magic edit)(?: the image| it)?(?: to| so)? (.+)$/, (m) => ({ instruction: m[1] })]], ex: ['ai edit make it look like sunset'], run: async (ed, a) => { okOrThrow(await ed.aiEdit(a.instruction), 'AI edit failed'); return 'AI edit done'; } });
cmd('aiBackground', { ai: true, doc: 'replace the image background with an AI-generated one, e.g. "a sunny beach"', args: { instruction: S(300) }, say: [[/^(?:change|replace|swap|new) (?:the )?background (?:to|with|into|for)(?: a| an| the)? (.+)$/, (m) => ({ instruction: m[1] })]], ex: ['change the background to a sunny beach'], run: async (ed, a) => { okOrThrow(await ed.aiBgSwap(a.instruction), 'Background swap failed'); return 'Background replaced'; } });
cmd('aiRemoveObject', { ai: true, doc: 'AI-erase what is inside the current pixel selection and fill it in naturally', say: [[/^(?:remove|erase|delete) (?:the )?(?:selected )?(?:object|selection|selected area) (?:with ai|using ai)$|^(?:ai )?(?:object )?(?:remove|erase) (?:selection|object)$|^magic erase$/, () => ({})]], ex: ['magic erase'], run: async (ed) => { okOrThrow(await ed.aiRemoveSelection(), 'Remove failed'); return 'Object removed'; } });
cmd('aiExtend', { ai: true, doc: 'AI-extend the background to fill the canvas', say: [[/^(?:ai )?(?:extend|expand|fill out)(?: the)? background$|^extend (?:the )?(?:image|canvas)$/, () => ({})]], ex: ['extend background'], run: async (ed) => { okOrThrow(await ed.aiExtendBackground(), 'Extend failed'); return 'Background extended'; } });
cmd('aiGenerate', { ai: true, doc: 'AI-generate a new PICTURE/photo from a description and insert it (into the selection if there is one). ONLY when the user asks for an image/picture/photo/illustration of something — never for plain shapes, text or colours', args: { prompt: S(300) }, say: [[/^(?:generate|create|draw|make)(?: me)?(?: an?| the)? (?:image|picture|photo|illustration) (?:of|with|showing) (.+)$/, (m) => ({ prompt: m[1] })]], ex: ['generate an image of a red car'], run: async (ed, a) => { okOrThrow(await ed.aiInsertAt(a.prompt), 'Generation failed'); return 'Generated'; } });
cmd('detectToLayers', { doc: 'auto-detect subjects/text/logos and convert them into separate layers', say: [[/^(?:auto )?(?:detect|convert)(?: all)?(?: the)?(?: subjects| objects| elements| everything| to layers| into layers)?(?: to layers| into layers)?$|^split (?:it )?into layers$/, () => ({})]], ex: ['auto detect subjects'], run: async (ed) => { okOrThrow(await ed.detectRegionsToLayers(), 'Detect failed'); return 'Converted to layers'; } });
cmd('replaceObject', { ai: true,
  doc: 'replace a named thing (or the current selection when target is "") with AI-generated content described by prompt', args: { target: S(80, true), prompt: S(300) },
  say: [
    [/^(?:replace|change|swap|turn)(?: out)?(?: the| this| that)? (.+?) (?:with|into|to|for) (?:a |an |the |some )?(.+)$/, (m) => ({ target: SELF.test(m[1]) ? '' : m[1], prompt: m[2] })],
    [/^(?:fill|generate|draw|paint)(?: the| this| that)?(?: selection| selected area| area)? (?:with|in(?:side)?(?: the selection)?|of) (?:a |an |the |some )?(.+)$/, (m) => ({ target: '', prompt: m[1] })],
  ], ex: ['replace the dog with a dolphin', 'fill the selection with flowers'],
  run: async (ed, a) => {
    if (!a.prompt) throw new Error('Say what to put there.');
    okOrThrow(await ed.replaceObjectByName(a.target || '', a.prompt), 'AI could not do that');
    return a.target ? `Replaced ${a.target}` : 'Filled selection';
  },
});

/* ═══ voice itself ═══ */
cmd('help', { doc: 'tell the user what they can say', say: [[/^(?:help|help me|what can i say|what can i do|what can you do|list commands|show commands|commands|voice help)$/, () => ({})]], ex: ['what can I say'],
  run: () => 'Try: “undo”, “draw a circle”, “make it red”, “rotate 90 degrees”, “bigger”, “zoom in”, “export”. Add “twice” to repeat, “again” to redo the last one, “stop listening” to turn off.' });
cmd('stopListening', { doc: 'turn voice control off', say: [[/^(?:stop listening|stop voice|voice off|turn off (?:the )?(?:voice|microphone|mic)|mute|go to sleep)$/, () => ({})]], ex: ['stop listening'], run: (ed, a, ctx) => { shell(ctx, 'stopListening')(); return 'Voice off'; } });

/* ═══ view / shell-owned ═══ */
cmd('zoomIn', { doc: 'zoom in', say: [[/^zoom in$/, () => ({})]], ex: ['zoom in'], run: (ed, a, ctx) => { shell(ctx, 'zoomIn')(); return 'Zoom in'; } });
cmd('zoomOut', { doc: 'zoom out', say: [[/^zoom out$/, () => ({})]], ex: ['zoom out'], run: (ed, a, ctx) => { shell(ctx, 'zoomOut')(); return 'Zoom out'; } });
cmd('fit', { doc: 'fit the canvas to the screen', say: [[/^(fit|fit to screen|zoom to fit|reset zoom|zoom fit|show all)$/, () => ({})]], ex: ['fit to screen'], run: (ed, a, ctx) => { shell(ctx, 'fit')(); return 'Fit to screen'; } });
cmd('zoomTo', { doc: 'zoom to a percentage', args: { percent: N(5, 800) }, say: [[/^zoom(?: to)? (\d+)(?: percent|%)$/, (m) => ({ percent: +m[1] })], [/^(?:zoom )?(?:to )?actual size$/, () => ({ percent: 100 })]], ex: ['zoom to 200 percent'], run: (ed, a, ctx) => { shell(ctx, 'zoomTo')(a.percent); return `Zoom ${a.percent}%`; } });
cmd('export', {
  doc: 'export/download the image as png, jpg or svg', args: { format: E('png', 'jpg', 'svg'), scale: N(1, 4, true) },
  say: [[/^(?:export|download|save)(?: it)?(?: as)?(?: an? )?(?: (png|jpg|jpeg|svg))?(?: image)?$/, (m) => ({ format: (m[1] || 'png').replace('jpeg', 'jpg') })],
    [/^(?:export|download|save)(?: it)?(?: as)?(?: (png|jpg|jpeg))?(?: image)? (?:at|in) (\d|one|two|three|four)(?: ?x| times)(?: size| resolution)?$/, (m) => ({ format: (m[1] || 'png').replace('jpeg', 'jpg'), scale: num(m[2]) })], [/^(?:export|download|save)(?: it)?(?: as)? (png|jpg|jpeg|svg)(?: image| file)?$/, (m) => ({ format: m[1].replace('jpeg', 'jpg') })]], ex: ['export', 'export as jpg', 'download', 'export at 2x'],
  run: (ed, a, ctx) => { const f = ctx && ctx.actions; const fmt = a.format || 'png'; if (f && f.export) f.export(fmt, a.scale); else if (fmt === 'png' && f && f.exportPNG) f.exportPNG(); else throw new Error(`"export" isn't available here`); return `Exporting ${fmt.toUpperCase()}`; },
});
cmd('combine', { doc: 'combine the selected shapes into one: union, subtract, intersect, exclude or flatten (needs two or more vector shapes selected; not images)', args: { op: E('union', 'subtract', 'intersect', 'exclude', 'flatten') }, say: [[/^(union|subtract|intersect|exclude|flatten)(?: (?:the )?(?:selected )?(?:shapes|layers))?$/, (m) => ({ op: m[1] })]], ex: ['union shapes'], run: (ed, a) => { ed.combineShapes(a.op); return a.op[0].toUpperCase() + a.op.slice(1); } });
cmd('addFrame', { doc: 'add a new frame (artboard) next to the current one on this page', say: [[/^(?:add|new|create|make)(?: a)?(?: new)? frame$/, () => ({})]], ex: ['add frame'], run: (ed) => { if (!ed.addFrame()) throw new Error('A page holds at most 12 frames'); return 'Added a frame'; } });
cmd('gotoFrame', { doc: 'switch to another frame of this page by its number (1 = first)', args: { n: N(1, 12, true) }, say: [[/^(?:go to |open |switch to |select )?frame (\d+)$/, (m) => ({ n: +m[1] })]], ex: ['go to frame 2'], run: (ed, a) => { const f = ed.frameList()[a.n - 1]; if (!f) throw new Error(`There is no frame ${a.n}`); ed.activateFrame(f.id, { fit: true }); return `Frame ${a.n}`; } });
cmd('removeFrame', { doc: 'delete the current frame and the layers in it', say: [[/^(?:delete|remove) (?:the |this )?(?:current )?frame$/, () => ({})]], ex: ['delete frame'], run: (ed) => { if (!ed.removeFrame(ed.activeFrameId)) throw new Error('A page needs at least one frame'); return 'Deleted the frame'; } });
cmd('newDoc', { doc: 'start a new document', say: [[/^(?:new|start)(?: a)?(?: new)?(?: document| file| project| canvas)?$|^new (?:document|file|project)$/, () => ({})]], ex: ['new document'], run: (ed, a, ctx) => { shell(ctx, 'newDoc')(); return 'New document'; } });
cmd('theme', { doc: 'toggle or set light/dark theme', args: { mode: E('light', 'dark', 'toggle', true) }, say: [[/^(?:switch to |turn on |use |go )?(light|dark)(?: mode| theme)$/, (m) => ({ mode: m[1] })], [/^(?:toggle|switch|change)(?: the)?(?: theme| dark mode| light mode| mode)$/, () => ({ mode: 'toggle' })]], ex: ['dark mode', 'toggle theme'], run: (ed, a, ctx) => { shell(ctx, 'theme')(a.mode); return a.mode && a.mode !== 'toggle' ? `${a.mode} theme` : 'Theme toggled'; } });
cmd('compare', { doc: 'compare with the original image', say: [[/^compare(?: with)?(?: the)?(?: original| before)?$|^show (?:the )?(?:original|before)$/, () => ({})]], ex: ['compare'], run: (ed, a, ctx) => { shell(ctx, 'compare')(); return 'Compare'; } });
cmd('panel', { doc: 'show or hide a side panel', args: { side: E('left', 'right'), show: B() }, say: [[/^(show|hide|open|close|collapse|expand) (?:the )?(left|right|layers?|properties|side) ?(?:panel|sidebar)?$/, (m) => ({ side: /left|layer|side/.test(m[2]) ? 'left' : 'right', show: /show|open|expand/.test(m[1]) })]], ex: ['hide the right panel', 'show layers'], run: (ed, a, ctx) => { shell(ctx, 'panel')(a.side, a.show); return `${a.show ? 'Showed' : 'Hid'} ${a.side} panel`; } });
cmd('search', { doc: 'open the command search palette', say: [[/^(?:open )?(?:search|command palette|commands)$/, () => ({})]], ex: ['search'], run: (ed, a, ctx) => { shell(ctx, 'search')(); return 'Search'; } });


/* ═══ layers: pick by name, blend mode ═══ */
const ROLE_WORDS = { text: ['text', 'headline', 'title'], image: ['image', 'product'], shape: ['shape', 'rect', 'ellipse', 'sticker'], background: ['bg', 'background'], logo: ['logo'], sticker: ['sticker'], group: ['group'], cta: ['cta'], badge: ['badge'], price: ['price'] };
/* A spoken layer reference -> the layers it names: "2" (number from the top), "hero" (name),
   "text" (every text layer), or next/previous/top/bottom. */
const SHAPE_WORDS = { circle: 'ellipse', oval: 'ellipse', ellipse: 'ellipse', square: 'rect', box: 'rect', rectangle: 'rect', rect: 'rect', triangle: 'triangle', star: 'star', line: 'line', polygon: 'polygon', hexagon: 'polygon', heart: 'path', path: 'path', arrow: 'path' };
/* "second layer and delete it": a layer name that is really a chained command — leave it to the chain splitter */
const cmdLike = (x) => (/\s/.test(x.trim()) || /^(?:delete|duplicate|undo|redo|hide|show|lock|unlock|group|ungroup)$/.test(x.trim())) && !!parseCommand(x);
const isChain = (n) => { const p = String(n).split(/\s+(?:and then|then|and|after that)\s+/); return p.length > 1 && p.slice(1).some(cmdLike); };
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const ORD_RE = '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\\d+(?:st|nd|rd|th))';
const NUM_RE = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
function resolveLayers(ed, ref) {
  const all = flatLayers(ed), cur = all.findIndex(l => l.active || l.selected);
  let r = String(ref).toLowerCase().trim().replace(/^(?:the |a |an |both |all |every |each )+/, '').replace(/ layers?$/, '').replace(/^layers? /, '');
  if (r in NUMBER_WORDS && r !== 'half' && r !== 'hundred') r = String(NUMBER_WORDS[r]);
  const ord = ORDINALS[r] || (/^\d+(?:st|nd|rd|th)$/.test(r) ? parseInt(r, 10) : 0);
  if (ord) r = String(ord);
  else if (r === 'last') r = 'bottom';
  if (/^\d+$/.test(r)) return all[+r - 1] ? [all[+r - 1]] : [];
  const tb = /^(top|first|bottom|last):(\d+)$/.exec(r);
  if (tb) return /top|first/.test(tb[1]) ? all.slice(0, +tb[2]) : all.slice(-(+tb[2]));
  if (r === 'top') return all.slice(0, 1); if (r === 'bottom') return all.slice(-1);
  if (r === 'next') return all[cur + 1] ? [all[cur + 1]] : all.slice(-1); if (r === 'previous') return [all[Math.max(0, cur - 1)]];
  const exact = all.filter(l => (l.name || '').toLowerCase() === r); if (exact.length) return exact;
  const sing = r.replace(/(?:es|s)$/, ''), word = (w) => (SHAPE_WORDS[w] ? w : null);
  const sw = word(r) || word(sing) || word(r.replace(/s$/, ''));
  if (sw) { const hit = all.filter(l => l.shape === SHAPE_WORDS[sw] || (l.name || '').toLowerCase().includes(sw)); if (hit.length) return hit; }
  const roleKey = ROLE_WORDS[r] ? r : Object.keys(ROLE_WORDS).find(k => r === k + 's' || sing === k);
  if (roleKey) { const hit = all.filter(l => ROLE_WORDS[roleKey].includes(l.role)); if (hit.length) return hit; if (roleKey === 'background') return all.slice(-1); }
  return all.filter(l => (l.name || '').toLowerCase().includes(r) || (sing && (l.name || '').toLowerCase().includes(sing)));
}
const SEP = /\s*(?:,|\band\b|&|\bplus\b|\bwith\b)\s*/;
/* "1 and 3", "layers 1 to 3", "the text and image" -> ['1','3'] / ['1','2','3'] / ['text','image'] */
function layerRefs(str) {
  const out = [];
  const w2n = (x) => (x in NUMBER_WORDS && x !== 'half' && x !== 'hundred' ? String(NUMBER_WORDS[x]) : x);
  for (let part of String(str).replace(/\blayers?\b/g, ' ').split(SEP).map(x => x.trim()).filter(Boolean)) {
    part = part.split(/\s+/).map(w2n).join(' ');
    if (/^\d+(?:\s+\d+)+$/.test(part)) { out.push(...part.split(/\s+/)); continue; }   // "1 2" (speech drops the commas)
    const r = /^(\d+)\s*(?:to|through|thru|-)\s*(\d+)$/.exec(part);
    if (r) { const lo = Math.min(+r[1], +r[2]), hi = Math.max(+r[1], +r[2]); for (let i = lo; i <= Math.min(hi, lo + 40); i++) out.push(String(i)); }
    else out.push(part);
  }
  return out;
}
/* The shared "select these layers" routine: mode replace | add | remove. */
function selectByRefs(ed, refs, mode = 'replace') {
  const ids = [], missing = [];
  for (const ref of refs) { const hit = resolveLayers(ed, ref); if (!hit.length) missing.push(ref); hit.forEach(l => { if (!ids.includes(l.id)) ids.push(l.id); }); }
  if (!ids.length) return { none: true, missing };
  const inSel = () => { const o = ed.fc.getActiveObject(); return !o ? [] : (o.type === 'activeSelection' ? o.getObjects() : [o]).map(x => x.id); };
  if (mode === 'replace') ed.fc.discardActiveObject();
  let changed = 0;
  for (const id of ids) {
    const has = inSel().includes(id);
    if (mode === 'remove' ? has : !has) { const before = inSel().join(); ed.toggleLayerSelection(id); if (inSel().join() !== before) changed++; }
  }
  return { n: inSel().length, changed, missing };
}
cmd('selectLayers', {
  doc: 'select SEVERAL layers at once (so group/align/delete/move act on all of them). targets: each a layer number from the top ("2"), a name, or a role ("text" = every text layer). mode: replace (default) | add (keep the current selection and add these) | remove (take these out of the selection)', args: { targets: L(), mode: E('replace', 'add', 'remove', true) },
  say: [
    [/^(?:select|pick|choose|highlight) (?:both|these two|those two|the two|two|the pair)(?: of)?(?: the)?(?: layers?)?$|^(?:select|pick|choose|highlight) (?:the )?(?:top|first) (\w+) layers?$/, (m) => { const n = m[1] ? (num(m[1]) ?? 2) : 2; return { targets: ['top:' + n], mode: 'replace' }; }],
    [/^(?:select|pick|choose|highlight) (?:the )?(?:bottom|last) (\w+) layers?$/, (m) => ({ targets: ['bottom:' + (num(m[1]) ?? 2)], mode: 'replace' })],
    [/^(?:select|pick|choose|highlight) (?:both|these two|those two|the two|two|(?:the )?\d+|three|four|five)(?: of)?(?: the)? ([\w ]+?)(?: layers?)?$/, (m) => (/^(layers?|pixels?|points?|nodes?)$/.test(m[1]) ? null : { targets: [m[1]], mode: 'replace' })],
    [/^(?:select|pick|choose|highlight)(?: layers?)? (\d+(?:\s+\d+)+)$/, (m) => ({ targets: m[1].split(/\s+/), mode: 'replace' })],
    [/^(?:select|pick|choose|highlight)(?: the)?(?: layers?)? ((?:[\w ]+?)(?:(?:\s*,\s*|\s+and\s+|\s+&\s+|\s+to\s+|\s+through\s+)[\w ]+?)+?)(?: layers)?$/, (m) => { if (m[1].split(SEP).slice(1).some(cmdLike)) return null; const t = layerRefs(m[1]); return t.length > 1 ? { targets: t, mode: 'replace' } : null; }],
    [/^(?:select|pick|choose)(?: all| every| each)(?: of the)?(?: the)? ([\w ]+?)(?: layers?)?$/, (m) => (/^(layers?|everything|all|pixels?|points?|nodes?|path points?|similar.*)$/.test(m[1]) ? null : { targets: [m[1].replace(/s$/, '')], mode: 'replace' })],
    [/^(?:also |additionally )?(?:add|include)(?: the)?(?: layers?)? ([\w ,&]+?)(?: layers?)? (?:to|into) (?:the |my )?(?:selection|selected)$|^(?:also )?(?:shift |add )select(?: the)?(?: layers?)? ([\w ,&]+)$|^also select(?: the)?(?: layers?)? ([\w ,&]+)$/, (m) => ({ targets: layerRefs(m[1] || m[2] || m[3]), mode: 'add' })],
    [/^(?:remove|take|drop|deselect|unselect)(?: the)?(?: layers?)? ([\w ,&]+?)(?: layers?)?(?: from (?:the |my )?selection)?$/, (m) => { const t = layerRefs(m[1]); return /^(selection|all|everything|pixels?)$/.test(m[1]) || !t.length || !t.every(x => /^\d+$/.test(x) || /^(text|image|shape|logo|sticker|group|cta|badge|price)s?$/.test(x)) ? null : { targets: t, mode: 'remove' }; }],
  ], ex: ['select layers 1 and 3', 'select layers 1 to 3', 'select the text and image layers', 'select all text layers', 'add layer 4 to the selection', 'deselect layer 2', 'select both circles', 'select layer one and two', 'select both', 'select the top two layers'],
  run: (ed, a) => {
    const mode = a.mode || 'replace', r = selectByRefs(ed, a.targets, mode);
    if (r.none) {
      // not layers at all ("select the dog and the cat"): treat it as things in the picture
      if (mode !== 'replace') throw new Error(`No layers match ${a.targets.join(', ')}`);
      const what = a.targets.join(' and ');
      return ed.selectObjectByName(what).then((x) => { okOrThrow(x, `No layers or objects match ${what}`); return `Selected ${what}`; });
    }
    if (mode !== 'remove' && !r.changed && !r.n) throw new Error("Those layers can't be selected (the background and locked layers never join a selection)");
    return mode === 'remove' ? `${r.n} layer${r.n === 1 ? '' : 's'} selected` : `${r.n} layer${r.n === 1 ? '' : 's'} selected${r.missing.length ? ' (no match for ' + r.missing.join(', ') + ')' : ''}`;
  },
});
cmd('selectLayer', {
  doc: 'make ONE layer the active one by (part of) its name, its role (text|image|shape|background), its number from the top, or next/previous/top/bottom', args: { name: S(60, true), index: N(1, 500, true), fromBottom: { t: 'b', opt: true }, which: E('next', 'previous', 'top', 'bottom', true) },
  say: [
    [new RegExp('^(?:select|pick|choose|go to|activate|open)(?: the)? layer (?:called |named |number |no |num )?(' + NUM_RE + ')$'), (m) => ({ index: +(/^\d+$/.test(m[1]) ? m[1] : NUMBER_WORDS[m[1]]) })],
    // "select first layer", "select the 2nd layer", "select the third layer from the bottom"
    [new RegExp('^(?:select|pick|choose|go to|activate|open)(?: the)? (' + ORD_RE + ') layer(?: from(?: the)? (top|bottom|front|back))?$'), (m) => ({ index: ORDINALS[m[1]] || parseInt(m[1], 10), ...(/bottom|back/.test(m[2] || '') ? { fromBottom: true } : {}) })],
    [/^(?:select|pick|choose|go to|activate)(?: the)? last layer$/, () => ({ which: 'bottom' })],
    [/^(?:select|pick|choose|go to|activate)(?: the)? layer (above|over|below|under|beneath)(?: it| this| the current one)?$|^(?:select|pick|choose|go to|activate)(?: the)? (?:next|previous) layer (up|down)$/, (m) => ({ which: /above|over|up/.test(m[1] || m[2]) ? 'previous' : 'next' })],
    [/^(?:select|pick|choose|go to|activate)(?: the)? (next|previous|top|bottom) layer$/, (m) => ({ which: m[1] })],
    [/^(?:select|pick|choose|go to|activate)(?: the)? (text|image|photo|shape|background|logo|sticker|group)(?: layer)?$/, (m) => ({ name: { photo: 'image' }[m[1]] || m[1] })],
    [/^(?:select|pick|choose|go to|activate)(?: the)? layer (?:called |named )?(.+)$|^(?:select|pick|choose|go to|activate)(?: the)? (.+?) layer$/, (m) => { const n = m[1] || m[2]; return TOOL_PHRASES.some(([p]) => p === n) || /^(all|every|new|similar)$/.test(n) || isChain(n) ? null : { name: n }; }],
  ], ex: ['select layer 2', 'select the next layer', 'select the text layer', 'select layer hero'],
  run: (ed, a) => {
    const idx = a.index != null && a.fromBottom ? flatLayers(ed).length - a.index + 1 : a.index;
    const hit = resolveLayers(ed, idx != null ? String(idx) : a.which || a.name)[0];
    if (!hit) throw new Error(`No layer matches ${a.name || a.which || a.index}`);
    ed.activate(hit.id); return `Selected layer ${hit.name || hit.id}`;
  },
});
const BLENDS = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', dodge: 'color-dodge', 'color dodge': 'color-dodge', burn: 'color-burn', 'color burn': 'color-burn', 'hard light': 'hard-light', 'soft light': 'soft-light', difference: 'difference', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity' };
cmd('blend', { doc: 'layer blend mode: ' + [...new Set(Object.values(BLENDS))].join(', '), args: { mode: E(...new Set(Object.values(BLENDS))) }, say: [[new RegExp('^(?:set |change )?(?:the )?(?:layer )?blend(?: mode)?(?: to)? (' + Object.keys(BLENDS).join('|') + ')$|^(?:blend )?(?:with )?(multiply|screen|overlay|soft light|hard light|luminosity)(?: blend)?$'), (m) => ({ mode: BLENDS[m[1] || m[2]] })]], ex: ['blend mode multiply', 'soft light'], run: (ed, a) => { const l = needLayer(ed); ed.setLayer(l.id, { blend: a.mode }); return `Blend ${a.mode}`; } });

/* ═══ photo: curves, HSL mixer, perspective ═══ */
const CURVE_PRESET = { linear: null, contrast: { rgb: [[0, 0], [64, 48], [192, 208], [255, 255]] }, fade: { rgb: [[0, 36], [128, 132], [255, 236]] }, brighten: { rgb: [[0, 0], [110, 150], [255, 255]] } };
cmd('curves', { doc: 'apply a tone-curve preset to the image', args: { preset: E('linear', 'contrast', 'fade', 'brighten') }, say: [[/^(?:apply |use |set )?(?:the )?(linear|contrast|fade|brighten) curves?$|^curves? (linear|contrast|fade|brighten)$/, (m) => ({ preset: m[1] || m[2] })]], ex: ['contrast curve', 'curves fade'], run: (ed, a) => { imageTarget(ed); fxSet(ed, { curves: CURVE_PRESET[a.preset] }); return `Curve ${a.preset}`; } });
cmd('resetCurves', { doc: 'reset the tone curve', say: [[/^(?:reset|clear|flatten) (?:the )?curves?$/, () => ({})]], ex: ['reset curves'], run: (ed) => { imageTarget(ed); fxSet(ed, { curves: null }); return 'Curves reset'; } });
const BANDS = HSL_BANDS.map(b => b[0]);
const BAND_ALIAS = { reds: 'red', oranges: 'orange', yellows: 'yellow', greens: 'green', aquas: 'aqua', cyans: 'aqua', cyan: 'aqua', blues: 'blue', purples: 'purple', magentas: 'magenta', pinks: 'magenta', pink: 'magenta' };
const BAND_RE = '(' + [...BANDS, ...Object.keys(BAND_ALIAS)].join('|') + ')';
const PROP_WORD = { hue: 'h', saturation: 's', luminance: 'l', lightness: 'l', brightness: 'l' };
cmd('hsl', {
  doc: 'HSL colour mixer: shift one colour band (' + BANDS.join('/') + ') hue (h), saturation (s) or luminance (l), -100..100', args: { band: E(...BANDS), prop: E('h', 's', 'l'), value: N(-100, 100) },
  say: [
    [new RegExp('^(?:set )?(?:the )?' + BAND_RE + ' (hue|saturation|luminance|lightness)(?: to)? (-?\\d+)$'), (m) => ({ band: BAND_ALIAS[m[1]] || m[1], prop: PROP_WORD[m[2]], value: +m[3] })],
    [new RegExp('^(?:' + UP + ') (?:the )?' + BAND_RE + ' (hue|saturation|luminance|lightness)$'), (m) => ({ band: BAND_ALIAS[m[1]] || m[1], prop: PROP_WORD[m[2]], value: 30 })],
    [new RegExp('^(?:' + DOWN + ') (?:the )?' + BAND_RE + ' (hue|saturation|luminance|lightness)$'), (m) => ({ band: BAND_ALIAS[m[1]] || m[1], prop: PROP_WORD[m[2]], value: -30 })],
    [new RegExp('^(?:make the )?' + BAND_RE + ' (more vivid|more saturated|punchier|pop)$'), (m) => ({ band: BAND_ALIAS[m[1]] || m[1], prop: 's', value: 30 })],
    [new RegExp('^(?:make the )?' + BAND_RE + ' (darker|lighter|brighter)$'), (m) => ({ band: BAND_ALIAS[m[1]] || m[1], prop: 'l', value: m[2] === 'darker' ? -30 : 30 })],
  ], ex: ['reds saturation 30', 'increase the blue luminance', 'make the greens darker'],
  run: (ed, a) => { imageTarget(ed); fxSet(ed, { hsl: setHslValue(fxGet(ed).hsl, a.band, a.prop, a.value) }); return `${a.band} ${a.prop === 'h' ? 'hue' : a.prop === 's' ? 'saturation' : 'luminance'} ${a.value}`; },
});
cmd('perspective', {
  doc: 'perspective correction on the image: start (drag corners), apply, reset corners, cancel', args: { op: E('start', 'apply', 'reset', 'cancel') },
  say: [[/^(?:start |enter |open )?(?:perspective|perspective correction|keystone correction)(?: mode)?$/, () => ({ op: 'start' })], [/^(?:apply|confirm|commit|done with) (?:the )?perspective(?: correction)?$/, () => ({ op: 'apply' })], [/^(?:reset|straighten) (?:the )?(?:perspective )?corners$/, () => ({ op: 'reset' })], [/^(?:cancel|exit|leave) (?:the )?perspective(?: correction)?$/, () => ({ op: 'cancel' })]], ex: ['perspective correction', 'apply perspective', 'reset corners', 'cancel perspective'],
  run: (ed, a) => {
    if (a.op === 'start') { imageTarget(ed); if (!ed.enterPerspectiveEdit()) throw new Error('Select a photo to correct its perspective'); return 'Drag the corners, then say apply perspective'; }
    if (!ed._persp) throw new Error('Start perspective correction first');
    if (a.op === 'apply') ed.applyPerspectiveEdit(); else if (a.op === 'reset') ed.resetPerspectiveCorners(); else ed.cancelPerspectiveEdit();
    return `Perspective ${a.op}`;
  },
});

/* ═══ masks & cutout touch-ups ═══ */
cmd('maskEdit', { doc: 'paint on the layer mask (start) or stop (done)', args: { op: E('start', 'done') }, say: [[/^(?:edit|paint)(?: the)?(?: layer)? mask$/, () => ({ op: 'start' })], [/^(?:done|finish|exit|stop)(?: editing| painting)?(?: the)? mask$/, () => ({ op: 'done' })]], ex: ['edit mask', 'done editing mask'], run: (ed, a) => { if (a.op === 'done') { ed.exitMaskEdit(); return 'Mask edit done'; } const l = needLayer(ed); ed.enterMaskEdit(l.id); return 'Painting the mask: black hides, white reveals'; } });
cmd('maskEnabled', { doc: 'turn the layer mask on or off without deleting it', args: { on: B() }, say: [[/^(?:enable|turn on|show) (?:the )?(?:layer )?mask$/, () => ({ on: true })], [/^(?:disable|turn off|hide) (?:the )?(?:layer )?mask$/, () => ({ on: false })]], ex: ['disable mask', 'enable mask'], run: (ed, a) => { const l = needLayer(ed); ed.setMaskEnabled(l.id, a.on); return a.on ? 'Mask on' : 'Mask off'; } });
cmd('touchUp', { doc: 'after Remove BG: paint-to-fix mode — keep (restore parts), remove (erase parts) or off', args: { mode: E('keep', 'remove', 'off') }, say: [[/^(?:touch ?up|refine(?: the)?(?: cutout)?|fix(?: the)? cutout)(?: mode)?(?: to)? (keep|remove|off)$/, (m) => ({ mode: m[1] })]], ex: ['touch up keep', 'refine cutout remove'], run: (ed, a) => { if (a.mode === 'off') { ed.setMaskRefine(null); return 'Touch-up off'; } if (!ed.setMaskRefine(a.mode)) throw new Error('Remove the background first, then touch up the cutout'); return `Touch-up: paint to ${a.mode}`; } });

/* ═══ clipboard extras ═══ */
cmd('pasteReplace', { doc: 'replace the selected layer with the clipboard', say: [[/^paste (?:to |and )?(?:replace|over)(?: it)?$|^replace (?:it )?with (?:the )?clipboard$/, () => ({})]], ex: ['paste to replace'], run: (ed) => { needLayer(ed); ed.pasteToReplace(); return 'Replaced with clipboard'; } });
cmd('copyPNG', { doc: 'copy the selection as a PNG image to the system clipboard', say: [[/^copy (?:it )?(?:as|to) (?:a )?(?:png|image|clipboard)(?: image)?$/, () => ({})]], ex: ['copy as png'], run: async (ed) => { needLayer(ed); await ed.copyAsPNG(); return 'Copied as PNG'; } });
cmd('fillColor', { doc: 'bucket-fill the pixel selection (or the whole canvas) with a flat colour', args: { color: C() }, say: [[new RegExp('^(?:flood |bucket )?fill (?:the )?(?:selection|selected area|canvas|everything|background)(?: with| in)? ' + COLOR_RE + '$|^paint (?:the )?(?:selection|canvas) ' + COLOR_RE + '$'), (m) => ({ color: colorOf(m[1] || m[2]) })]], ex: ['fill the selection with red'], run: (ed, a) => { ed.fillWithColor(a.color); return `Filled with ${colorName(a.color) || a.color}`; } });
cmd('coverCanvas', { doc: 'scale the background image up to cover the whole canvas (no AI)', say: [[/^(?:fill|cover|stretch)(?: the)? (?:canvas|artboard) with (?:the )?(?:background|image|photo)$|^cover (?:the )?canvas$|^extend (?:the )?background to (?:the )?canvas$/, () => ({})]], ex: ['cover the canvas'], run: (ed) => { if (!ed.extendBackgroundToCanvas()) throw new Error('There is no image to extend'); return 'Background covers the canvas'; } });

/* ═══ pen / path editing ═══ */
cmd('path', { doc: 'pen & vector path editing: edit (selected path), done, smooth/corner points, delete points, select all points, undo/redo/remove last point while drawing', args: { op: E('edit', 'done', 'smooth', 'corner', 'deletePoints', 'selectAllPoints', 'undoPoint', 'redoPoint', 'removeLastPoint') },
  say: [[/^edit (?:the )?(?:path|vector|shape points|points)$/, () => ({ op: 'edit' })], [/^(?:done|exit|finish) (?:editing )?(?:the )?(?:path|points)$/, () => ({ op: 'done' })], [/^(?:make )?(?:the )?(?:selected )?points? (smooth|corner|sharp)$|^(smooth|sharpen) (?:the )?points?$/, (m) => ({ op: (m[1] || m[2]) === 'smooth' ? 'smooth' : 'corner' })], [/^delete (?:the )?(?:selected )?points?$|^remove (?:the )?(?:selected )?points?$/, () => ({ op: 'deletePoints' })], [/^select all points$/, () => ({ op: 'selectAllPoints' })], [/^undo (?:the )?last point$|^step back (?:a )?point$/, () => ({ op: 'undoPoint' })], [/^(?:remove|delete) (?:the )?last point$/, () => ({ op: 'removeLastPoint' })], [/^redo (?:the )?(?:last )?point$/, () => ({ op: 'redoPoint' })]],
  ex: ['edit path', 'done editing path', 'smooth points', 'delete points', 'undo last point', 'select all points', 'redo point', 'remove last point'],
  run: (ed, a) => {
    if (a.op === 'edit') { const l = needLayer(ed); if (!ed.editPath(l.id)) throw new Error('Select a pen path or shape that can be edited as a path'); return 'Editing path points'; }
    if (a.op === 'undoPoint' || a.op === 'redoPoint' || a.op === 'removeLastPoint') { if (!ed._penBuild) throw new Error('Draw a path with the pen first'); if (a.op === 'undoPoint') ed.penUndoPoint(); else if (a.op === 'redoPoint') ed.penRedoPoint(); else ed.penRemoveLastPoint(); return a.op === 'redoPoint' ? 'Restored point' : 'Removed last point'; }
    if (!ed._pathEdit) throw new Error('Edit a path first (say "edit path")');
    if (a.op === 'done') ed.exitPathEdit(); else if (a.op === 'smooth' || a.op === 'corner') ed.setPathNodeType(a.op); else if (a.op === 'deletePoints') ed.deleteSelectedPathNodes(); else ed.selectAllPathNodes();
    return `Path: ${a.op}`;
  },
});


/* ═══ pen tool by voice ═══ the pen is normally pointer-driven; these feed the same pen state
   (Editor#penAddPoint / penClosePath / penDrawPath), so the path draws live on the canvas and
   "edit path", "smooth points", etc. keep working on it afterwards. */
const PLACES = { 'top left': [0.1, 0.1], top: [0.5, 0.1], 'top right': [0.9, 0.1], left: [0.1, 0.5], center: [0.5, 0.5], middle: [0.5, 0.5], right: [0.9, 0.5], 'bottom left': [0.1, 0.9], bottom: [0.5, 0.9], 'bottom right': [0.9, 0.9] };
const PLACE_RE = '(' + Object.keys(PLACES).sort((a, b) => b.length - a.length).join('|') + ')';
cmd('penPoint', {
  doc: 'pen tool: add one path point at canvas px x,y OR at a place (top left|top|top right|left|center|right|bottom left|bottom|bottom right) OR dx/dy px away from the previous point; smooth=true makes it a curve point',
  args: { x: N(-20000, 20000, true), y: N(-20000, 20000, true), place: E(...Object.keys(PLACES), true), dx: N(-20000, 20000, true), dy: N(-20000, 20000, true), smooth: B() },
  say: [
    [/^(?:pen |path )?(?:point|node)(?: at)? (-?\d+)(?:,| and| by|\s)\s*(-?\d+)$|^(?:add|place|put|start)(?: a| the)?(?: first| next| new)? (?:pen |path )?(?:point|node)(?: at)? (-?\d+)(?:,| and| by|\s)\s*(-?\d+)$/, (m) => ({ x: +(m[1] ?? m[3]), y: +(m[2] ?? m[4]), smooth: false })],
    [/^(?:add|place|put)(?: a)? (?:curved|smooth|curve) (?:pen |path )?(?:point|node)(?: at)? (-?\d+)(?:,| and| by|\s)\s*(-?\d+)$|^(?:curved|smooth|curve) (?:pen |path )?(?:point|node)(?: at)? (-?\d+)(?:,| and| by|\s)\s*(-?\d+)$/, (m) => ({ x: +(m[1] ?? m[3]), y: +(m[2] ?? m[4]), smooth: true })],
    [new RegExp('^(?:add|place|put|start)(?: a| the)?(?: (first|next|new|curved|smooth))? ?(?:pen |path )?(?:point|node)(?: at| in| on)?(?: the)? ' + PLACE_RE + '$|^(?:pen |path )?(?:point|node)(?: at| in)?(?: the)? ' + PLACE_RE + '$'), (m) => ({ place: m[2] || m[3], smooth: /curved|smooth/.test(m[1] || '') })],
    [/^(?:next |another )?(?:pen |path )?(?:point|node)? ?(\d+)(?: px| pixels?)? (left|right|up|down)(?: and (\d+)(?: px| pixels?)? (left|right|up|down))?$/, (m) => { const d = { dx: 0, dy: 0 }; [[m[1], m[2]], [m[3], m[4]]].forEach(([n, w]) => { if (n) { if (w === 'left') d.dx -= +n; else if (w === 'right') d.dx += +n; else if (w === 'up') d.dy -= +n; else d.dy += +n; } }); return { ...d, smooth: false }; }],
  ],
  ex: ['pen point at 100 200', 'add a curved point at 300 150', 'add a point at the top left', 'next point 50 right and 30 down'],
  run: (ed, a) => {
    const prev = ed._penBuild && ed._penBuild.nodes[ed._penBuild.nodes.length - 1];
    let x, y;
    if (a.place) { const pl = PLACES[a.place]; x = pl[0] * ed.W; y = pl[1] * ed.H; }
    else if (a.x != null && a.y != null) { x = a.x; y = a.y; }
    else if (a.dx != null || a.dy != null) { const base = prev || { x: ed.W / 2, y: ed.H / 2 }; x = base.x + (a.dx || 0); y = base.y + (a.dy || 0); }
    else throw new Error('Say where: "pen point at 100 200" or "pen point at the top left"');
    const n = ed.penAddPoint({ x, y }, { smooth: !!a.smooth });
    return n === 1 ? `Pen path started at ${Math.round(x)}, ${Math.round(y)}` : `Point ${n} at ${Math.round(x)}, ${Math.round(y)}`;
  },
});
cmd('penClose', { doc: 'pen tool: close the path being drawn into a filled shape', say: [[/^close(?: the)?(?: pen)?(?: path| shape)?$|^close it$/, () => ({})]], ex: ['close the path'], run: (ed) => { if (!ed._penBuild) throw new Error('Draw a path with the pen first'); if (ed._penBuild.nodes.length < 3) throw new Error('A closed path needs at least three points'); ed.penClosePath(); return 'Path closed'; } });
cmd('penPath', {
  doc: 'pen tool: draw a whole path through points in canvas px (use this to draw any custom outline; closed=true fills it, smooth=true rounds the corners into curves)', args: { points: P(), closed: B(), smooth: B() },
  say: [[/^(?:draw |make |create )?(?:a )?(?:pen )?path (?:through|via|with points?|along|from) ((?:-?\d+(?:\.\d+)?(?:,| and| to|\s)\s*-?\d+(?:\.\d+)?(?:\s*(?:,|;|then|to)\s*)?){2,})(?: and (close(?: it| the path)?))?$/, (m) => {
    const nums = (m[1].match(/-?\d+(?:\.\d+)?/g) || []).map(Number); if (nums.length < 4 || nums.length % 2) return null;
    const pts = []; for (let i = 0; i < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    return { points: pts, closed: !!m[2], smooth: false };
  }]], ex: ['draw a path through 100 100, 300 100, 200 300 and close it'],
  run: (ed, a) => { const id = ed.penDrawPath(a.points.map(([x, y]) => ({ x, y })), { closed: !!a.closed, smooth: !!a.smooth }); if (!id) throw new Error('Could not draw that path'); return a.closed ? 'Closed path drawn' : 'Path drawn'; },
});
const PEN_SHAPES = {
  triangle: { closed: true, pts: [[0.5, 0.05], [0.95, 0.9], [0.05, 0.9]] },
  diamond: { closed: true, pts: [[0.5, 0.02], [0.95, 0.5], [0.5, 0.98], [0.05, 0.5]] },
  pentagon: { closed: true, pts: [[0.5, 0.03], [0.97, 0.38], [0.79, 0.95], [0.21, 0.95], [0.03, 0.38]] },
  hexagon: { closed: true, pts: [[0.25, 0.07], [0.75, 0.07], [1, 0.5], [0.75, 0.93], [0.25, 0.93], [0, 0.5]] },
  star: { closed: true, pts: Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 0.2 : 0.5, t = -Math.PI / 2 + i * Math.PI / 5; return [0.5 + Math.cos(t) * r, 0.5 + Math.sin(t) * r]; }) },
  arrow: { closed: true, pts: [[0.02, 0.35], [0.55, 0.35], [0.55, 0.1], [0.98, 0.5], [0.55, 0.9], [0.55, 0.65], [0.02, 0.65]] },
  house: { closed: true, pts: [[0.5, 0.05], [0.97, 0.45], [0.8, 0.45], [0.8, 0.95], [0.2, 0.95], [0.2, 0.45], [0.03, 0.45]] },
  heart: { closed: true, smooth: true, pts: [[0.5, 0.3], [0.7, 0.05], [0.95, 0.2], [0.9, 0.5], [0.5, 0.95], [0.1, 0.5], [0.05, 0.2], [0.3, 0.05]] },
  wave: { closed: false, smooth: true, pts: [[0, 0.5], [0.17, 0.2], [0.34, 0.8], [0.5, 0.2], [0.67, 0.8], [0.84, 0.2], [1, 0.5]] },
  zigzag: { closed: false, pts: [[0, 0.8], [0.2, 0.2], [0.4, 0.8], [0.6, 0.2], [0.8, 0.8], [1, 0.2]] },
  lightning: { closed: true, pts: [[0.6, 0.02], [0.2, 0.55], [0.48, 0.55], [0.35, 0.98], [0.8, 0.4], [0.52, 0.4]] },
  cross: { closed: true, pts: [[0.35, 0.02], [0.65, 0.02], [0.65, 0.35], [0.98, 0.35], [0.98, 0.65], [0.65, 0.65], [0.65, 0.98], [0.35, 0.98], [0.35, 0.65], [0.02, 0.65], [0.02, 0.35], [0.35, 0.35]] },
};
cmd('penShape', {
  doc: 'pen tool: draw a ready-made vector path (editable point by point afterwards): ' + Object.keys(PEN_SHAPES).join(', '), args: { shape: E(...Object.keys(PEN_SHAPES)), color: C(true), size: N(20, 8000, true) },
  say: [[new RegExp('^(?:draw|make|create|add|trace)(?: a| an)?(?: (tiny|small|medium|big|large|huge))?(?: ' + COLOR_RE + ')? (?:pen |vector |path )?(' + Object.keys(PEN_SHAPES).join('|') + ')(?: (?:path|outline|with the pen|using the pen|pen path|vector))$|^(?:draw|make|create|trace)(?: a| an)?(?: (tiny|small|medium|big|large|huge))?(?: ' + COLOR_RE + ')? (?:pen|vector|path) (' + Object.keys(PEN_SHAPES).join('|') + ')$|^(?:draw|trace)(?: a| an)? (' + Object.keys(PEN_SHAPES).join('|') + ') with the pen$'), (m) => {
    const shape = m[3] || m[6] || m[7], word = m[1] || m[4], col = m[2] || m[5];
    return { shape, ...(col ? { color: colorOf(col) } : {}), ...(word ? { sizeWord: word } : {}) };
  }], [new RegExp('^(?:draw|make|create|trace)(?: a| an| the)?(?: (tiny|small|medium|big|large|huge))?(?: ' + COLOR_RE + ')? (heart|arrow|house|diamond|pentagon|lightning|cross|wave|zigzag)$'), (m) => ({ shape: m[3], ...(m[2] ? { color: colorOf(m[2]) } : {}), ...(m[1] ? { sizeWord: m[1] } : {}) })]], ex: ['draw a heart path', 'draw a pen star', 'draw a big red pen arrow', 'draw a heart with the pen', 'draw a zigzag path', 'draw a heart', 'draw the arrow', 'make a house', 'draw a big red heart'],
  run: (ed, a) => {
    const def = PEN_SHAPES[a.shape], base = Math.min(ed.W, ed.H), side = Math.min(a.size ?? Math.round(base * ({ tiny: 0.1, small: 0.2, medium: 0.35, big: 0.7, large: 0.7, huge: 0.95 }[a.sizeWord] ?? 0.4)), ed.W, ed.H), ox = (ed.W - side) / 2, oy = (ed.H - side) / 2;
    if (a.color) ed.setToolOptions({ fill: a.color, color: a.color });
    const id = ed.penDrawPath(def.pts.map(([x, y]) => ({ x: ox + x * side, y: oy + y * side })), { closed: def.closed, smooth: !!def.smooth });
    if (!id) throw new Error('Could not draw that path');
    return `Drew a ${a.shape} path — say "edit path" to adjust its points`;
  },
});
cmd('penWidth', { doc: 'pen tool: stroke width of open paths in px', args: { value: N(1, 200) }, say: [[/^(?:set )?pen (?:stroke )?(?:width|thickness|size)(?: to)? (\d+)(?: px| pixels?)?$/, (m) => ({ value: +m[1] })]], ex: ['pen width 6'], run: (ed, a) => { ed.setToolOptions({ penStrokeWidth: a.value }); return `Pen width ${a.value}`; } });

/* ═══ tool options & toggles ═══ */
cmd('gradientTool', { doc: 'set the Gradient tool colours/kind and switch to it (to paint, drag on the canvas)', args: { from: C(), to: C(), kind: E('linear', 'radial', true) }, say: [[new RegExp('^(?:use |set )?(?:the )?(?:gradient tool|gradient colou?rs?)(?: to| from)? ' + COLOR_RE + ' (?:to|and) ' + COLOR_RE + '$'), (m) => ({ from: colorOf(m[1]), to: colorOf(m[2]) })]], ex: ['gradient tool from red to blue'], run: (ed, a) => { ed.setToolOptions({ gradientStops: [{ offset: 0, color: a.from }, { offset: 1, color: a.to }], ...(a.kind ? { gradientType: a.kind } : {}) }); ed.setTool('gradient'); return 'Gradient tool ready — drag on the canvas'; } });
cmd('gradientKind', { doc: 'gradient tool type: linear or radial', args: { kind: E('linear', 'radial') }, say: [[/^(?:make (?:the )?gradient|gradient (?:type|kind)|set gradient to) (linear|radial)$|^(linear|radial) gradient (?:tool|type)$/, (m) => ({ kind: m[1] || m[2] })]], ex: ['gradient type radial'], run: (ed, a) => { ed.setToolOptions({ gradientType: a.kind }); return `Gradient ${a.kind}`; } });
cmd('toolToggle', {
  doc: 'tool option switches: addMode (selection tools keep adding every click), aligned (clone/heal source follows the cursor), paintNewLayer (brush paints on a new layer), plus clearSource to forget the clone source', args: { opt: E('addMode', 'aligned', 'paintNewLayer', 'clearSource'), on: B() },
  say: [[/^(?:turn )?(on|off)? ?add mode(?: (on|off))?$|^(?:keep|stop) adding(?: to (?:the )?selection)?$/, (m) => ({ opt: 'addMode', on: /^(?:on)$/.test(m[1] || m[2] || 'on') && !/stop/.test(m[0]) })], [/^(?:turn )?aligned(?: clone| sampling)?(?: (on|off))?$|^aligned (?:clone )?(on|off)$/, (m) => ({ opt: 'aligned', on: (m[1] || m[2] || 'on') === 'on' })], [/^paint (?:on )?(?:a )?new layer$|^(?:brush|draw) (?:on )?(?:a )?(?:new|separate) layer$/, () => ({ opt: 'paintNewLayer', on: true })], [/^paint (?:directly )?on (?:the )?(?:image|photo|layer)$/, () => ({ opt: 'paintNewLayer', on: false })], [/^(?:clear|forget|reset) (?:the )?(?:clone )?source$/, () => ({ opt: 'clearSource', on: true })]],
  ex: ['add mode on', 'aligned off', 'paint on a new layer', 'clear clone source'],
  run: (ed, a) => { if (a.opt === 'clearSource') { ed.clearCloneSource(); return 'Clone source cleared'; } ed.setToolOptions({ [a.opt]: a.on }); return `${a.opt} ${a.on ? 'on' : 'off'}`; },
});
cmd('cropRatio', { doc: 'crop aspect ratio: free, original, or w:h numbers (switches to the crop tool)', args: { w: N(0, 100, true), h: N(0, 100, true), original: B() }, say: [[/^crop (?:to |at )?(\d+)(?: to |:| by )(\d+)$/, (m) => ({ w: +m[1], h: +m[2], original: false })], [/^crop (?:to |at )?(square)$/, () => ({ w: 1, h: 1, original: false })], [/^crop (?:to |at )?(free|freeform|no ratio)$/, () => ({ w: 0, h: 0, original: false })], [/^crop (?:to |at )?(?:the )?original(?: ratio| aspect)?$/, () => ({ original: true })]], ex: ['crop 16 to 9', 'crop square', 'crop original'], run: (ed, a) => { if (ed.tool !== 'crop') ed.setTool('crop'); ed.setToolOptions({ cropRatio: a.original ? (ed.cropOriginalRatio ? ed.cropOriginalRatio() : ed.W / ed.H) : (a.h ? a.w / a.h : 0) }); return 'Crop ratio set'; } });
/* ═══ host / shell extras ═══ */
cmd('saveProject', { doc: 'save the editable project file (.canvasmith, keeps layers)', say: [[/^save(?: the)? (?:project|document|file|work)$|^download (?:the )?project$/, () => ({})]], ex: ['save project'], run: (ed, a, ctx) => { shell(ctx, 'saveProject')(); return 'Saving project'; } });
cmd('openProject', { doc: 'open a saved .canvasmith project file (host file picker)', say: [[/^open (?:a |the )?(?:saved )?(?:project|document)(?: file)?$|^load (?:a )?project$/, () => ({})]], ex: ['open project'], run: (ed, a, ctx) => { shell(ctx, 'openProject')(); return 'Choose a project file'; } });
cmd('reviewCommit', { doc: 'in the auto-detect review panel: create the layers from the detected regions', say: [[/^(?:create|make|confirm|accept|commit) (?:the )?(?:layers|review|detections?|regions)$|^create layers$/, () => ({})]], ex: ['create layers'], run: (ed, a, ctx) => { shell(ctx, 'reviewCommit')(); return 'Creating layers'; } });
cmd('reviewCancel', { doc: 'in the auto-detect review panel: cancel and discard', say: [[/^(?:cancel|discard|close|dismiss) (?:the )?(?:review|detections?|regions)$/, () => ({})]], ex: ['cancel review'], run: (ed, a, ctx) => { shell(ctx, 'reviewCancel')(); return 'Review cancelled'; } });

/* ─────────────────────────── public API ─────────────────────────── */
export const COMMANDS = CATALOG;
const BY_ID = new Map(CATALOG.map(c => [c.id, c]));
export const commandById = (id) => BY_ID.get(id);

/* Last-resort rule order matters: 'tool' is greedy so it must be tried last. */
/* Open-ended commands (they swallow free text: "select <anything>", "edit <anything>") are tried
   AFTER every specific phrase, so "edit mask" is the mask and not an AI edit; 'tool' goes last. */
const OPEN_ENDED = ['setText', 'aiBackground', 'aiGenerate', 'aiEdit', 'rename', 'font', 'addSticker', 'selectObject', 'replaceObject', 'tool'];
const RULES = [...CATALOG.filter(c => !OPEN_ENDED.includes(c.id)), ...OPEN_ENDED.map(id => BY_ID.get(id))].flatMap(c => c.say.map(([re, build]) => ({ id: c.id, re, build })));

const FILLER = /^(?:(?:please|hey|okay|ok|um+|uh+|er|so|now|and|then|can you|could you|can we|i want to|i want you to|i would like to|i need to|let us|let's|lets|go ahead and|just)\s+)+/;
const U = 'one|two|three|four|five|six|seven|eight|nine', TEEN = 'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen', TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const W = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/* "two hundred", "forty five", "one fifty" -> 200 / 45 / 150. Lone one..nine stay words ("two circles",
   "layer one"). Without this "forty five" was read as 40 — a silently wrong answer. */
const NUM_PHRASE = new RegExp(`\\b(?:(${U}) hundred(?: (?:and )?(?:(${TENS})(?: (${U}))?|(${TEEN})|(${U})))?|(${U}) (${TENS})(?: (${U}))?|(${TENS})(?: (${U}))?|(${TEEN}))\\b`, 'g');
const FREE_TEXT = /\b(?:saying|says|reading)\b|^(?:write|type|rename|name)\b|^(?:change|set) (?:the )?text\b/;
function numberWords(t) {
  if (FREE_TEXT.test(t)) return t;   // never rewrite words the user wants typed onto the canvas
  const v = (w) => (w ? W[w] : 0);
  return t.replace(NUM_PHRASE, (_, a, at, au, ateen, au2, b, bt, bu, c, cu, d) =>
    String(a ? v(a) * 100 + v(at) + v(au) + v(ateen) + v(au2) : b ? v(b) * 100 + v(bt) + v(bu) : c ? v(c) + v(cu) : v(d)));
}

export function normalizeText(text) {
  const t = String(text || '').toLowerCase().replace(/[^\w\s%.:#&'-]/g, ' ').replace(/(?<![\d])\.|\.(?![\d])/g, ' ').replace(/\s+/g, ' ').trim().replace(FILLER, '').replace(/\s+please$/, '').trim();
  return numberWords(t);
}

/* transcript -> { action, ...args } | null — the instant offline path. */
/* A spoken run-on ("draw the circle height should be 200px in the left top and fill green on it")
   -> an ordered queue of single commands. Split before each clause-opening word, drop the filler
   ("should be", "on it"), tidy "left top" -> "top left", then every clause must parse by itself —
   all or nothing, same as the plain "and" chain. addShape leaves the new shape selected, so the
   clauses after it that say "it"/nothing act on that shape — running them in order IS the context. */
const POS_RE = '(?:center|centre|middle|(?:top|bottom)(?: (?:left|right))?|left|right)';
export function splitClauses(text) {
  let t = normalizeText(text)
    .replace(/\b(left|right) (top|bottom)\b/g, '$2 $1')
    .replace(/\s(?:should be|should|must be|will be|needs to be|is|are|to be)\s/g, ' ')
    .replace(/\b(?:on|to|for|of) (?:it|that|this|them)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  t = t.replace(new RegExp('\\s+(?=(?:and then|and|then|after that|next|also|plus|draw|add|create|insert|make|set|fill|paint|colou?r|height|width|resize|move|put|place)\\b|(?:in|at|into) (?:the )?' + POS_RE + '\\b)', 'g'), ' | ');
  t = t.replace(new RegExp('\\b(move|put|place|send|position)( it| this)? \\| ((?:in|at|to|into) )', 'g'), '$1$2 $3');
  return t.split('|').map(c => c.trim().replace(/^(?:and then|and|then|after that|next|also|plus|with)\s+/, '').trim()).filter(c => c && !/^(?:and then|and|then|after that|next|also|plus|with)$/.test(c));
}
export function parseCompound(text) {
  const parts = splitClauses(text);
  if (parts.length < 2 || parts.length > 8) return null;
  const cmds = parts.map(parseCommand);
  return cmds.every(Boolean) ? cmds : null;
}

export function parseCommand(text) {
  const t = normalizeText(text);
  if (!t) return null;
  for (const { id, re, build } of RULES) {
    const m = re.exec(t);
    if (!m) continue;
    const args = build(m);
    if (!args) continue;
    const out = { action: id, ...args };
    if (BY_ID.get(id).args && Object.keys(BY_ID.get(id).args).length && !validArgs(id, out)) continue;
    return out;
  }
  return null;
}

/* Generic validator: closed action list, typed + clamped args. Used for model output AND to make
   sure a grammar match actually carries what the action needs. Returns a clean command or null. */
function coerce(spec, v) {
  switch (spec.t) {
    case 'n': { const n = Number(v); return Number.isFinite(n) ? clamp(n, spec.min, spec.max) : undefined; }
    case 'e': return spec.v.includes(v) ? v : undefined;
    case 'c': return typeof v === 'string' ? colorOf(v) || undefined : undefined;
    case 's': return typeof v === 'string' ? v.trim().slice(0, spec.max) : undefined;
    case 'b': return typeof v === 'boolean' ? v : undefined;
    case 'l': return Array.isArray(v) && v.length >= 1 && v.length <= spec.max && v.every(q => typeof q === 'string' && q.trim()) ? v.map(q => q.trim().slice(0, 60)) : undefined;
    case 'p': return Array.isArray(v) && v.length >= 2 && v.length <= 64 && v.every(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite)) ? v.map(q => [clamp(q[0], -20000, 20000), clamp(q[1], -20000, 20000)]) : undefined;
    default: return undefined;
  }
}
function validArgs(id, c) { return !!normalizeCommand(c); }
export function normalizeCommand(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const def = BY_ID.get(raw.action);
  if (!def) return null;
  const out = { action: def.id };
  for (const [k, spec] of Object.entries(def.args)) {
    const v = raw[k];
    if (v === undefined || v === null || v === '') {
      if (spec.opt || (spec.t === 'e' && spec.v.includes(true))) continue;
      return null;
    }
    const c = coerce(spec, v);
    if (c === undefined) return null;
    out[k] = c;
  }
  // display-only extras the grammar attaches (e.g. the spoken tool or colour name)
  if (typeof raw.name === 'string') out.name = raw.name.slice(0, 40);
  return out;
}

export async function runCommand(editor, cmdObj, ctx = {}) {
  const def = BY_ID.get(cmdObj.action);
  if (!def) throw new Error('Unknown command');
  if (def.ai && ctx.offline) throw new Error('That needs AI — not available in offline mode');
  return def.run(editor, cmdObj, ctx);
}

const specText = (spec) => ({ n: () => `number ${spec.min}..${spec.max}`, e: () => spec.v.filter(x => x !== true).join('|'), c: () => '#rrggbb', s: () => 'text', b: () => 'true|false', p: () => '[[x,y],...] 2-64 points in canvas px', l: () => '["layer 1","text",...] strings' }[spec.t]());
/* The catalog as compact text for an LLM prompt: one line per command. */
export function catalogPrompt() {
  return CATALOG.map(c => {
    const a = Object.entries(c.args).map(([k, s]) => `${k}${s.opt ? '?' : ''}:${specText(s)}`).join(', ');
    return `- ${c.id}${a ? '{' + a + '}' : ''}: ${c.doc}`;
  }).join('\n');
}


/* ═══ offline recognition helpers ═══
   An on-device recogniser mishears small words ("read" for "red"). Applied ONLY as a retry after
   the plain grammar missed, so a real phrase like "write read me" is never rewritten. */
const HEARD = { drawer: 'draw a', drawing: 'draw a', read: 'red', rid: 'red', blew: 'blue', blu: 'blue', grin: 'green', greene: 'green', pink: 'pink', sickle: 'circle', circuit: 'circle', circles: 'circle', stir: 'star', stare: 'star', rectangular: 'rectangle', triangles: 'triangle', undue: 'undo', redo: 'redo', zoom: 'zoom' };
const HEARD_NUM = { to: 'two', too: 'two', for: 'four', tree: 'three', won: 'one', ate: 'eight' };
export function heardVariants(text) {
  const t = normalizeText(text), swap = (map) => t.split(' ').map(w => map[w] || w).join(' ');
  return [...new Set([swap(HEARD), swap({ ...HEARD, ...HEARD_NUM })])].filter(v => v !== t);
}

const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
/* "did you mean …?" for a phrase nothing parsed. First try fixing single misheard/misspelled words
   against the words the grammar knows (so "draw a squre" -> "draw a square", which really parses);
   else fall back to the closest example phrase. Only ever a hint — it never runs by itself. */
let VOCAB;
export function suggestCommand(text) {
  const t = normalizeText(text);
  if (!t) return null;
  VOCAB = VOCAB || [...new Set([...CATALOG.flatMap(c => c.ex.flatMap(e => normalizeText(e).split(' '))), ...Object.keys(COLORS)])].filter(w => /^[a-z]{3,}$/.test(w));
  const words = t.split(' '), fixed = words.map(w => {
    if (w.length < 4 || VOCAB.includes(w) || /\d/.test(w)) return w;
    let best = w, bd = w.length >= 6 ? 3 : 2;
    for (const v of VOCAB) { const d = lev(w, v); if (d < bd) { bd = d; best = v; } }
    return best;
  }).join(' ');
  if (fixed !== t && parseCommand(fixed)) return { phrase: fixed, score: 0.9 };
  let best = null;
  for (const c of CATALOG) for (const ex of c.ex) {
    const e = normalizeText(ex), score = 1 - lev(t, e) / Math.max(t.length, e.length);
    if (!best || score > best.score) best = { phrase: ex, score };
  }
  return best && best.score >= 0.6 ? best : null;
}
