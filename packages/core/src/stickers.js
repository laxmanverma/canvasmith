/* Decorative sticker library — self-contained, recolorable vector shapes, generated from a small
   set of base outlines × a colour palette. Each sticker is added to the canvas as a plain
   fabric.Path/Polygon/Circle/Rect (or fabric.Group, for a shape + baked promo-text pairing) via
   addSticker() in editor.js, so it's a fully editable, recolorable, resizable layer like any other
   shape — not a baked raster image.

   Ported from the ad-generator reference's sticker set (sale bursts, badges/tags, ribbons/banners,
   price tags, arrows, accents — including its baked-text badge/tag/banner/burst variants) onto
   Canvasmith's existing generic spec format, rather than that reference's per-swatch pre-generated
   ~100-variant-per-category list: one shape spec + the shared STICKER_PALETTE covers every colour,
   same as every other sticker here already worked before this addition. */

const starPts = (cx, cy, spikes, rOut, rIn) => {
  const p = []; let a = -Math.PI / 2; const s = Math.PI / spikes;
  for (let i = 0; i < spikes * 2; i++) { const r = i % 2 ? rIn : rOut; p.push((cx + Math.cos(a) * r).toFixed(1) + ',' + (cy + Math.sin(a) * r).toFixed(1)); a += s; }
  return p.join(' ');
};

/* Rotate an SVG path/points-space coordinate list isn't practical to do generically here, so
   rotated variants (arrowUp/Down/Left) are pre-baked as their own `d`/`points` string instead of a
   runtime transform — keeps every sticker a single flat spec addSticker() can build directly, no
   per-key rotate/transform step for callers (Fabric objects rotate via the normal `angle` prop like
   any other placed shape, same as the base arrow). */

/* Default promo label baked into each `kind: 'group'` sticker's text — the properties panel has no
   per-sticker text field, so this picks a sensible default; renaming/editing the text afterward
   works the same as any other IText layer once placed. */
export const STICKER_DEFAULT_LABEL = 'SALE';

/* Each factory returns an SVG path/points/primitive spec (no fill attr — colour is applied by the
   caller via Fabric object props, so a placed sticker recolors like any other shape). `kind` picks
   which Fabric primitive to build: 'circle' | 'rect' | 'polygon' | 'path' (a plain shape), or
   'group' (the named `shape` key rendered underneath a centered, auto-contrast text label — see
   addSticker()'s 'group' branch and STICKER_DEFAULT_LABEL). */
const SHAPES = {
  circle: { kind: 'circle', cx: 50, cy: 50, r: 46 },
  pill: { kind: 'rect', x: 8, y: 32, w: 84, h: 36, rx: 18 },
  rrect: { kind: 'rect', x: 12, y: 22, w: 76, h: 56, rx: 10 },
  square: { kind: 'rect', x: 16, y: 16, w: 68, h: 68, rx: 6 },
  diamond: { kind: 'polygon', points: '50,6 94,50 50,94 6,50' },
  shield: { kind: 'path', d: 'M50,8 L86,20 V50 C86,74 68,88 50,94 C32,88 14,74 14,50 V20 Z' },
  star5: { kind: 'polygon', points: starPts(50, 52, 5, 46, 19) },
  star6: { kind: 'polygon', points: starPts(50, 50, 6, 46, 24) },
  burst8: { kind: 'polygon', points: starPts(50, 50, 8, 48, 34) },
  burst12: { kind: 'polygon', points: starPts(50, 50, 12, 48, 40) },
  burst16: { kind: 'polygon', points: starPts(50, 50, 16, 48, 40) },
  sparkle: { kind: 'path', d: 'M50,6 C54,42 58,46 94,50 C58,54 54,58 50,94 C46,58 42,54 6,50 C42,46 46,42 50,6 Z' },
  heart: { kind: 'path', d: 'M50,84 C10,54 16,20 50,40 C84,20 90,54 50,84 Z' },
  bubble: { kind: 'path', d: 'M12,16 H88 a8,8 0 0 1 8,8 V60 a8,8 0 0 1 -8,8 H44 L28,84 V68 H12 a8,8 0 0 1 -8,-8 V24 a8,8 0 0 1 8,-8 Z' },
  plus: { kind: 'path', d: 'M42,10 H58 V42 H90 V58 H58 V90 H42 V58 H10 V42 H42 Z' },
  blob: { kind: 'path', d: 'M50,10 C74,10 92,26 90,50 C88,74 72,92 48,90 C26,88 10,70 12,46 C14,24 30,10 50,10 Z' },
  banner: { kind: 'path', d: 'M10,36 H90 L80,50 L90,64 H10 L20,50 Z' },
  pennant: { kind: 'path', d: 'M16,18 H84 V58 L50,44 L16,58 Z' },
  ribbon: { kind: 'path', d: 'M30,8 H70 V70 L50,56 L30,70 Z' },
  corner: { kind: 'path', d: 'M14,6 L94,6 L94,26 L34,26 L34,94 L14,94 Z' },
  tag: { kind: 'path', d: 'M8,44 L44,8 L88,8 A4,4 0 0 1 92,12 L92,56 L56,92 A6,6 0 0 1 48,92 L8,52 A6,6 0 0 1 8,44 Z M70,20 A8,8 0 1 0 70,36 A8,8 0 1 0 70,20 Z', fillRule: 'evenodd' },
  swing: { kind: 'path', d: 'M36,22 L64,22 A6,6 0 0 1 70,28 L70,70 A6,6 0 0 1 64,76 L36,76 A6,6 0 0 1 30,70 L30,28 A6,6 0 0 1 36,22 Z M50,22 L50,8 M44,14 A6,6 0 1 0 56,14 A6,6 0 1 0 44,14 Z', fillRule: 'evenodd' },
  arrow: { kind: 'path', d: 'M14,42 H58 V30 L86,50 L58,70 V58 H14 Z' },
  arrowBlock: { kind: 'path', d: 'M10,38 H62 V26 L90,50 L62,74 V62 H10 Z' },
  chevron: { kind: 'path', d: 'M30,20 L60,50 L30,80 M52,20 L82,50 L52,80', stroke: true },
  arrowDouble: { kind: 'path', d: 'M18,50 L36,34 V44 H64 V34 L82,50 L64,66 V56 H36 V66 Z' },
  // a curved shaft (outer edge out, inner edge back) with a real arrowhead — it used to close straight back into a leaf
  arrowCurve: { kind: 'path', d: 'M12,80 C20,48 44,32 68,30 V18 L92,38 L68,58 V46 C48,48 32,60 28,84 Z' },
  arrowUp: { kind: 'path', d: 'M42,86 V42 H30 L50,14 L70,42 H58 V86 Z' },
  arrowDown: { kind: 'path', d: 'M42,14 V58 H30 L50,86 L70,58 H58 V14 Z' },
  arrowLeft: { kind: 'path', d: 'M86,42 H42 V30 L14,50 L42,70 V58 H86 Z' },   // the mirror of `arrow` (was a flag-shaped outline)
  ring: { kind: 'path', d: 'M50,6 a44,44 0 1 1 -0.1,0 Z M50,26 a24,24 0 1 0 0.1,0 Z', fillRule: 'evenodd' },
  // Baked-text variants — same base shape, rendered under a centered promo label (kind: 'group').
  badgeText: { kind: 'group', shape: 'circle' },
  tagBannerText: { kind: 'group', shape: 'banner' },
  burstText: { kind: 'group', shape: 'burst12' },
  priceTagText: { kind: 'group', shape: 'tag' },
};

/* [fill, contrast-ink] pairs — a sticker is created with the first palette entry's fill; the
   properties panel's Fill colour swatch (same one shapes use) recolors it afterward. */
export const STICKER_PALETTE = [
  '#ef6a2d', '#111114', '#2f6df0', '#f4c95d', '#1f9d6b', '#e0607a',
  '#7c3aed', '#ffffff', '#0c0c0e', '#2dd4bf',
];

export const STICKER_GROUPS = [
  { label: 'Sale bursts', keys: ['burst8', 'burst12', 'burst16', 'star5', 'star6', 'burstText'] },
  { label: 'Badges & tags', keys: ['circle', 'pill', 'rrect', 'shield', 'diamond', 'square', 'badgeText'] },
  { label: 'Ribbons & banners', keys: ['banner', 'pennant', 'ribbon', 'corner', 'tagBannerText'] },
  { label: 'Price tags', keys: ['tag', 'swing', 'square', 'priceTagText'] },
  { label: 'Arrows', keys: ['arrow', 'arrowBlock', 'chevron', 'arrowDouble', 'arrowCurve', 'arrowUp', 'arrowDown', 'arrowLeft'] },
  { label: 'Accents', keys: ['star5', 'star6', 'sparkle', 'heart', 'bubble', 'plus', 'blob', 'ring'] },
];

export function stickerSpec(key) { return SHAPES[key]; }

/* What a person calls each sticker — the picker's tooltip and accessible name (it showed raw keys
   like "burst12" and "arrowLeft"). Unknown keys fall back to a spaced-out key. */
const STICKER_NAMES = {
  burst8: 'Burst, 8 points', burst12: 'Burst, 12 points', burst16: 'Burst, 16 points', star5: 'Star', star6: 'Six-point star',
  burstText: 'Sale burst with text', circle: 'Circle', pill: 'Pill', rrect: 'Rounded square', shield: 'Shield', diamond: 'Diamond',
  square: 'Square', badgeText: 'Badge with text', banner: 'Banner', pennant: 'Pennant', ribbon: 'Bookmark ribbon', corner: 'Corner frame',
  tagBannerText: 'Banner with text', tag: 'Price tag', swing: 'Swing tag', priceTagText: 'Price tag with text', arrow: 'Arrow',
  arrowBlock: 'Block arrow', chevron: 'Chevrons', arrowDouble: 'Double arrow', arrowCurve: 'Curved arrow', arrowUp: 'Up arrow',
  arrowDown: 'Down arrow', arrowLeft: 'Left arrow', sparkle: 'Sparkle', heart: 'Heart', bubble: 'Speech bubble', plus: 'Plus',
  blob: 'Blob', ring: 'Ring',
};
export function stickerLabel(key) {
  return STICKER_NAMES[key] || String(key).replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}
