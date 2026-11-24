import { TONE_DEFAULTS, TONE_KEYS } from './tone.js';
/* Colour utilities — pure functions, no DOM. */

export function hexRgb(hex) {
  let c = (hex || '#000').replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  return [parseInt(c.slice(0, 2), 16) || 0, parseInt(c.slice(2, 4), 16) || 0, parseInt(c.slice(4, 6), 16) || 0];
}

export function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export function toHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

/* WCAG relative luminance — lets a host pick readable ink on any accent colour. */
export function relLum([r, g, b]) {
  const a = [r, g, b].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

/* HSL round-trip — the basis of lightness-preserving recolour: swap hue/saturation toward a
   target colour but KEEP each pixel's own lightness, so shading, folds and texture survive. */
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

export function hexToHsl(hex) {
  return rgbToHsl(...hexRgb(hex));
}

/* Recolour RGBA pixels toward `hex`, keeping each pixel's lightness and scaling the target
   saturation by the pixel's own (so fabric/material variation survives the swap). Mutates and
   returns `data` in place — pass a copy if the caller still needs the original. Skips fully
   transparent pixels so a cutout's edge doesn't pick up a fringe of the new colour. */
export function recolorPixels(data, hex) {
  const tgt = hexToHsl(hex);
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const hsl = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const rgb = hslToRgb(tgt.h, tgt.s * (0.35 + 0.65 * hsl.s), hsl.l);
    data[i] = rgb.r; data[i + 1] = rgb.g; data[i + 2] = rgb.b;
  }
  return data;
}

/* Normalizes a gradient stop list: sorts by offset, clamps each to [0,1], and guarantees at least
   2 stops exist (falls back to a default 2-color ramp) — the one piece of gradient-stop validation
   shared by both the raster paint-tool gradient (engine.js) and vector shape-fill gradients
   (shapes take a Fabric gradient object built from the same stop shape). Each stop's `color` is
   resolved to the final CSS color string a real CanvasGradient/fabric.Gradient consumes: a plain
   hex passes through unchanged, and an `alpha` field (0..1, defaulting to 1 when absent) folds
   into an `rgba(...)` string via `rgba()` so a stop can fade toward transparent — Canvas2D's
   addColorStop and Fabric's colorStops both accept any valid CSS color string, so this needed no
   change on the consuming side (engine.js's buildCanvasGradient, editor.js's setShapeGradient). */
export function normalizeGradientStops(stops) {
  const s = (Array.isArray(stops) && stops.length ? stops : [{ offset: 0, color: '#ef6a2d' }, { offset: 1, color: '#7c3aed' }])
    .map(st => ({
      offset: Math.max(0, Math.min(1, st.offset)),
      color: (st.alpha == null || st.alpha >= 1) ? st.color : rgba(st.color, Math.max(0, st.alpha)),
    }))
    .sort((a, b) => a.offset - b.offset);
  return s;
}

/* Splits a resolved gradient-stop color string back into the {color, alpha} pair the stop-editor
   UI edits separately (a hex swatch input can't represent alpha on its own) — `color` keeps the
   same key/shape getShapeGradient always returned (a plain hex, safe to feed straight back into
   an <input type="color">), `alpha` is the new 0..1 field alongside it. Round-trips whatever
   normalizeGradientStops/rgba() produced: an `rgba(r,g,b,a)` string decodes to its hex + alpha,
   anything else (a plain hex, or a named CSS color already resolved upstream) is treated as fully
   opaque. Used by Editor#getShapeGradient's UI-facing consumers to redisplay a stop that may have
   been read back from a live Fabric gradient (whose colorStops always hold the resolved string,
   never the original {color, alpha} the UI last set). */
export function splitGradientStopColor(color) {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color || '');
  if (!m) return { color: color || '#000000', alpha: 1 };
  return { color: toHex(+m[1], +m[2], +m[3]), alpha: m[4] != null ? Math.max(0, Math.min(1, +m[4])) : 1 };
}

/* Defaults for non-destructive image adjustment (Editor#setImageFilters/getImageFilters). Human
   units: brightness/contrast/saturate are 100 = unchanged (50..150-ish range), blur is px (0 =
   none), sharpen is 0..100 (0 = off) and sharpenRadius 0.5..6 px (see sharpen.js), hue is degrees (-180..180, 0 = unchanged), vibrance is -100..100 (0 = unchanged, same
   shape as saturate but weighted toward already-muted colors), invert is a plain on/off toggle.
   The photographic keys (exposure/highlights/shadows/temperature/tint/curves/hsl) come from
   tone.js's TONE_DEFAULTS — see its header for their units. */
export const FX_DEFAULTS = { brightness: 100, contrast: 100, saturate: 100, blur: 0, sharpen: 0, sharpenRadius: 1, match: null, hue: 0, vibrance: 0, invert: false, ...TONE_DEFAULTS };

/* The adjustment panel's slider list, shared by both shells (demo + @canvasmith/react) so they
   can't drift apart: each entry is one FX_DEFAULTS key with its slider range in human units.
   `short` (optional) is the on-screen label when the full `label` — which stays the accessible name and
   tooltip, and must be unique — is too long for the label column. `track` (optional) is a CSS gradient painted as the slider track instead of the usual accent
   fill — white balance reads far better as "blue ← → amber" than as a progress bar. Invert, the
   curves editor and the HSL mixer aren't sliders and are rendered separately by each shell. */
export const ADJUST_CONTROLS = [
  { group: 'Light', key: 'exposure', label: 'Exposure', icon: 'exposure', min: -3, max: 3, step: 0.05 },
  { group: 'Light', key: 'brightness', label: 'Brightness', icon: 'sun', min: 50, max: 150, step: 1 },
  { group: 'Light', key: 'contrast', label: 'Contrast', icon: 'contrast', min: 50, max: 150, step: 1 },
  { group: 'Light', key: 'highlights', label: 'Highlights', icon: 'highlights', min: -100, max: 100, step: 1 },
  { group: 'Light', key: 'shadows', label: 'Shadows', icon: 'moon', min: -100, max: 100, step: 1 },
  { group: 'Color', key: 'temperature', label: 'Temp', icon: 'thermo', min: -100, max: 100, step: 1, track: 'linear-gradient(to right, #3f78d8, #d9d9d9, #e8a232)' },
  { group: 'Color', key: 'tint', label: 'Tint', icon: 'tint', min: -100, max: 100, step: 1, track: 'linear-gradient(to right, #3fae4a, #d9d9d9, #c64fc0)' },
  { group: 'Color', key: 'saturate', label: 'Saturation', icon: 'droplet', min: 0, max: 200, step: 1 },
  { group: 'Color', key: 'vibrance', label: 'Vibrance', icon: 'vibrance', min: -100, max: 100, step: 1 },
  { group: 'Color', key: 'hue', label: 'Hue', icon: 'hue', min: -180, max: 180, step: 1 },
  { group: 'Effects', key: 'sharpen', label: 'Sharpen', icon: 'sharpen', min: 0, max: 100, step: 1 },
  { group: 'Effects', key: 'sharpenRadius', label: 'Sharpen radius', short: 'Radius', icon: 'radius', min: 0.5, max: 6, step: 0.5 },
  { group: 'Effects', key: 'blur', label: 'Blur', icon: 'blurfilter', min: 0, max: 12, step: 0.5 },
];

/* Human-readable slider readout: signed for bipolar controls, EV with two decimals. */
export function formatAdjustValue(key, v) {
  if (key === 'exposure') return (v > 0 ? '+' : '') + (+v).toFixed(2);
  const c = ADJUST_CONTROLS.find(x => x.key === key);
  if (c && c.min < 0) return (v > 0 ? '+' : '') + Math.round(v);
  return String(Math.round(v * 10) / 10);
}

/* Pure mapping from human fx values to the Fabric Image.filters constructor args, so the mapping
   itself is testable without touching fabric. Mirrors the reference editor's setFx exactly:
   brightness/contrast/saturate are (v-100)/100, blur is v/20. hue/vibrance/invert follow the same
   "human units in, Fabric's own filter units out" contract: hue's degrees map to Fabric's
   HueRotation range of -1..1 (representing -180..180deg), vibrance's -100..100 maps to Fabric's
   Vibrance range of -1..1, invert passes straight through to Fabric's boolean Invert filter.
   Editor#setImageFilters turns this spec into real `new fabric.Image.filters.X(params)`
   instances, and _recomputeAdjustmentLayers filters out any whose isNeutralState() is true before
   applying — a filter instantiated at its neutral default (rotation:0, vibrance:0, invert:false)
   is a correct no-op either way, this is just about skipping needless per-pixel passes. */
export function fxToFilterSpecs(fx) {
  const f = { ...FX_DEFAULTS, ...fx };
  const tone = {};
  TONE_KEYS.forEach(k => { tone[k] = f[k]; });
  return [
    // first, so exposure/white balance see the untouched pixels (the raw-developer order) and
    // brightness/contrast/etc. then act on the developed image
    { type: 'Tone', params: tone },
    // Match Color (colormatch.js): {g:[3], o:[3], amount}, set by Editor#matchColor; absent when unused
    ...(f.match && f.match.g ? [{ type: 'ColorMatch', params: { g: f.match.g, o: f.match.o, amount: f.match.amount != null ? f.match.amount : 1 } }] : []),
    { type: 'Brightness', params: { brightness: (f.brightness - 100) / 100 } },
    { type: 'Contrast', params: { contrast: (f.contrast - 100) / 100 } },
    { type: 'Saturation', params: { saturation: (f.saturate - 100) / 100 } },
    // last of the tonal/colour work, so it sharpens the finished look; only present when in use
    // (a 3x3 pass over every pixel is not free, and 0 is the overwhelmingly common state)
    ...(f.sharpen > 0 ? [{ type: 'Sharpen', params: { amount: f.sharpen, radius: f.sharpenRadius } }] : []),
    { type: 'Blur', params: { blur: f.blur / 20 } },
    { type: 'HueRotation', params: { rotation: f.hue / 180 } },
    { type: 'Vibrance', params: { vibrance: f.vibrance / 100 } },
    { type: 'Invert', params: { invert: !!f.invert } },
  ];
}
