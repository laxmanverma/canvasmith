/* <CanvasmithEditor/> — the batteries-included UI over @canvasmith/core.
   Everything it does goes through the public Editor API, so anything you see here you can also
   build yourself against the core. Theme via the `theme` prop (CSS custom properties) layers on
   top of the built-in light/dark palettes, which the toolbar toggle switches between. */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Editor, makeText, makeShape, layerTypeLabel, REGION_FILL_ALPHA, outlineRegion, ALL_TOOLS, PAINT_TOOLS, SEL_TOOLS, SHAPE_TOOLS, GeminiProvider, installBridge, installDropImport, imageLayerName, rankCommands, layerLabel, installKeybindings, installVoice, installColorPicker, trapDialog, mountBlendPicker, TOOL_KEYS,
  selectionPolys, selectionToPath2D, FONT_GROUPS, FONT_STYLESHEET_URL, addGoogleFont, addCustomFont, restoreUserFonts, STICKER_GROUPS, STICKER_PALETTE, stickerSpec, stickerLabel, STICKER_DEFAULT_LABEL, REGION_COLOR, REGION_NAME, relLum, hexRgb, rgba, splitGradientStopColor,
  startSelection, updateSelection, finalizeSelection, startPolyBuild, polyBuildAdd, polyBuildPreview, finishPolyBuild, snapToEdge, selectionBounds,
  installAutosave, restoreSession, readSession, DocumentSet, MAX_DOCS, discardToTrash, restoreDiscarded, exportProject, loadProject,
  FX_DEFAULTS, ADJUST_CONTROLS, formatAdjustValue, GEOMETRY_DEFAULTS, GEOMETRY_CONTROLS, formatGeometryValue,
  HSL_BANDS, HSL_PROPS, hslBandLabel, getHslValue, setHslValue, hslBandTrack,
  CURVE_CHANNELS, normalizeCurves, compactCurves, curveHitTest, curveInsertPoint, curveMovePoint, curveRemovePoint, curveSvgPath,
  drawPenOverlay, drawPickSpinner, mountContextMenu, strokeInfo,
} from '@canvasmith/core';

const CROP_RATIOS = [['Free', 0], ['Original', 'orig'], ['1:1', 1], ['4:5', 4 / 5], ['3:2', 3 / 2], ['16:9', 16 / 9], ['9:16', 9 / 16]];
// Tools whose toolOpts.color/fill actually paints something on screen: PAINT_TOOLS read all four
// brush knobs (size/hardness/opacity/color), while bucket/shapes/type only ever read color/fill
// (their initial fill) — same split as the vanilla demo's COLOR_TOOLS/isPaint.
const COLOR_TOOLS = [...PAINT_TOOLS, 'bucket', ...SHAPE_TOOLS, 'type', 'pen'];
const BRUSH_SWATCHES = ['#ffffff', '#000000', '#4f8ff0', '#d76b8f', '#d4ff45', '#ef6a2d'];
/* Standard canvas-size presets, grouped by use-case — width/height in px at a nominal
   72-96dpi-ish "design pixel" scale (matches how every web design tool treats these, not
   print-accurate 300dpi). Ported verbatim from the vanilla demo's CANVAS_PRESETS. */
const CANVAS_PRESETS = [
  ['Social', [
    ['Instagram post (1:1)', 1080, 1080],
    ['Instagram portrait (4:5)', 1080, 1350],
    ['Instagram story (9:16)', 1080, 1920],
    ['Facebook cover', 820, 312],
    ['Twitter/X post', 1200, 675],
    ['YouTube thumbnail', 1280, 720],
    ['LinkedIn banner', 1584, 396],
  ]],
  ['Print', [
    ['A4 portrait', 2480, 3508],
    ['A4 landscape', 3508, 2480],
    ['US Letter portrait', 2550, 3300],
    ['US Letter landscape', 3300, 2550],
  ]],
  ['Screen', [
    ['HD (720p)', 1280, 720],
    ['Full HD (1080p)', 1920, 1080],
    ['4K UHD', 3840, 2160],
  ]],
];

// Compact SVG glyphs for the tool rail — avoids pulling in an icon-font/library dependency.
const ICON_PATHS = {
  strokeSettings: 'M6 3v6M6 13v8M4 9h4v4H4zM12 3v11M12 18v3M10 14h4v4h-4zM18 3v3M18 10v11M16 6h4v4h-4z',   // vertical sliders — Border's advanced-settings toggle
  select: 'M5 3l15 9-7 1.5L9.5 20z',                                          // cursor
  hand: 'M8 12V6.5a1.5 1.5 0 0 1 3 0V11M11 11V5.5a1.5 1.5 0 0 1 3 0V11M14 11.5V7a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-3.5a1.5 1.5 0 0 1 2.5-1.6L8 14',
  crop: 'M6 2v16h16M2 6h16v16',
  brush: 'M4 20c3 1 6-1 6-4 4-2 9-8 10-12l-2-2C14 3 8 8 6 12c-3 0-5 3-2 8z',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4z',
  eraser: 'M4 14.5L11 7.5l6 6-5 5H9zM4 20.5h16M14 4.5l5.5 5.5',
  clone: 'M8 3h8l-1.4 6h2.4l-2 6H7l-2-6h2.4zM5 18h14v3H5z',
  heal: 'M9 3h6a2 2 0 0 1 2 2v2h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2V5a2 2 0 0 1 2-2zM12 9v6M9 12h6',
  dodge: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19',
  burn: 'M12 3s5.5 5 5.5 9.5a5.5 5.5 0 0 1-11 0C6.5 10 9 8 9 8c0 2 1.5 3 1.5 3S12 8 12 3z',
  sponge: 'M5 13h14v4a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3zM5 13c0-5 3-8 7-8s7 3 7 8M9 17v.01M13 17v.01M16 16v.01',
  redeye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  marquee: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3',
  'marquee-ellipse': 'ellipse:12,12,9,7',
  lasso: 'M4 12c0-4.4 3.6-7 8-7s8 2.6 8 7-3.6 7-8 7c-1.2 0-1.8 1-1.8 2a1.8 1.8 0 0 0 2.8 1.5M5.5 17.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  'lasso-poly': 'M12 3l8 6-3 9H7L4 9z',                                       // ditto's "polygon" icon, reused for the polygonal lasso tool
  /* ditto's own toolbar reuses "wand2" for both lasso-mag and wand (they're never shown side by
     side there — one lives in a collapsed rail flyout, seen only on hover/expand). This demo's
     flat always-expanded Select list shows both at once, so they need visually distinct glyphs:
     lasso-mag keeps ditto's lasso loop with small perpendicular ticks along the path (edge-snap
     cue) instead of reusing wand2 verbatim. */
  'lasso-mag': 'M4 12c0-4.4 3.6-7 8-7s8 2.6 8 7-3.6 7-8 7c-1.2 0-1.8 1-1.8 2a1.8 1.8 0 0 0 2.8 1.5M5.5 17.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M4.5 9.5l1.6.6M18 8.5l1.7-.7M9.5 4.6l.4 1.7M15 19.8l-.6-1.7',
  wand: 'M6 18L16 8M14 4l1.5 1.5M19 7l1.5-1.5M18 12l2 .5M9 3l.5 2M20 17l-1.5 1.5',          // ditto's wand2 (magic wand)
  /* ditto's own toolbar reuses "wand2" for BOTH its 'wand' (object-select bbox stub, key W) and
     its 'magicwand' (real CV click-to-grab, key A) tools too — same never-shown-side-by-side
     reasoning as lasso/lasso-mag above. This demo's flat list needs them visually distinct:
     objectselect-bbox keeps ditto's wand2 glyph verbatim (it's the tool ditto's own W key names
     "Object / magic select"), magicwand gets a small sparkle added to the wand tip as the CV cue. */
  'objectselect-bbox': 'M6 18L16 8M14 4l1.5 1.5M19 7l1.5-1.5M18 12l2 .5M9 3l.5 2M20 17l-1.5 1.5',
  magicwand: 'M6 18L16 8M14 4l1.5 1.5M19 7l1.5-1.5M18 12l2 .5M9 3l.5 2M20 17l-1.5 1.5 M4.5 19.5l1.4 1.4M5.2 20.2h.01',
  objectselect: 'M4 9V4h5M15 4h5v5M4 15v5h5M13 13l7 2.8-3 1.2-1.2 3z',                     // selection-box corners + pointer (the spark read as the AI icon)
  hoverselect: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',   // ditto's eye
  expand: 'M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5',
  contract: 'M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5',
  similar: 'circle:7,7,3|circle:17,7,3|circle:7,17,3|circle:17,17,3',
  shadow: 'rect:5,4,14,14,2 M9 22h10a2 2 0 0 0 2-2V10',
  svg: 'm8 3 4 4 4-4M12 7v10M5 21h14',
  rect: 'rect:3,6,18,12,2',                                                  // a plain rectangle: the Rectangle tool, shape layers (ditto drew a 3D box, which read as a 3D tool)
  ellipse: 'ellipse:12,12,9,7',
  image: 'rect:3,4,18,16,2|circle:9,10,2|M21 17l-5-5-8 8',                        // + menu's Image… (same glyph as @canvasmith/react's image icon)
  line: 'M4 8h10M18 8h2M4 16h2M10 16h10M14 6v4M6 14v4',                       // ditto's sliders
  triangle: 'M12 4l9 16H3z',
  polygon: 'M12 3l8 6-3 9H7L4 9z',
  star: 'M12 3l2.6 5.6L20 9.3l-4 4 1 6-5-2.8L7 19.3l1-6-4-4 5.4-.7L12 3z',
  type: 'M4 7V5h12v2M10 5v14M7 19h6',
  bucket: 'M5 11l6-6 7 7-6 6a2 2 0 0 1-3 0l-4-4a2 2 0 0 1 0-3zM19 16c1 1.5 1.5 2.5 1.5 3a1.5 1.5 0 0 1-3 0c0-.5.5-1.5 1.5-3z',
  gradient: 'M4 4h16v16H4zM4 4l16 16',
  eyedropper: 'M16 3a2.8 2.8 0 0 1 4 4l-8.5 8.5-4 1 1-4L16 3zM5 19l2 2',
  up: 'M18 15 12 9l-6 6',                                                    // no chevron-up in ditto's set (only R/L/D) — kept as-is, used to move a layer up
  close: 'M6 6l12 12M18 6L6 18',
  undo: 'M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-1',
  redo: 'M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h1',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19',
  moon: 'M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z',
  exposure: 'rect:3,3,18,18,3|M7 8h4M9 6v4M13 16h4M5 19 19 5',               // same glyphs as @canvasmith/react's adjustment icons
  highlights: 'circle:12,12,9|M12 7v10',
  thermo: 'M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0zM12 10v7',
  tint: 'M12 3s6 5.7 6 10a6 6 0 0 1-12 0c0-4.3 6-10 6-10z|M12 3v16',
  hue: 'circle:12,12,9|M12 3a9 9 0 0 1 0 18',
  vibrance: 'circle:12,12,4|M12 2v3M12 19v3M22 12h-3M5 12H2M17.5 6.5l-2.1 2.1M8.6 15.4l-2.1 2.1M17.5 17.5l-2.1-2.1M8.6 8.6 6.5 6.5',
  invert: 'circle:12,12,9|M12 3v18',
  reset: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  straighten: 'M3 17 21 7|M3 12h2M8 12h2M13 12h2M18 12h3',
  keystoneV: 'M8 4h8l4 16H4z',
  keystoneH: 'M4 8v8l16 4V4z',
  perspective: 'M5 6 19 4l1 16-16-2z|fillcircle:5,6,1.6|fillcircle:19,4,1.6|fillcircle:20,20,1.6|fillcircle:4,18,1.6',
  duplicate: 'M9 9h11v11H9zM5 15H4V4h11v1',                                  // ditto's copy
  chevron: 'M15 6l-6 6 6 6',                                                 // ditto's chevronL
  tool: 'M4 8h10M18 8h2M4 16h2M10 16h10M14 6v4M6 14v4',                      // ditto's sliders, reused as the Tool-tab glyph
  layerstab: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5',              // ditto's layers
  spark: 'M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8Z',        // AI-tab glyph, matches @canvasmith/react's spark icon
  palette: 'M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.2c2.4 0 4.3-1.9 4.3-4.3C21.5 6.1 17.2 3 12 3Z|fillcircle:7.5,10.5,1.3|fillcircle:11,7,1.3|fillcircle:15.5,8,1.3',  // Design-tab glyph
  chevronD: 'M6 9l6 6 6-6',
  stackfront: 'M5 4h14M12 20V9M7 13l5-5 5 5',                                // bring to front: arrow up to a bar
  stackup: 'M12 19V6M7 11l5-5 5 5',                                           // bring forward
  stackdown: 'M12 5v13M7 13l5 5 5-5',                                         // send backward
  stackback: 'M5 20h14M12 4v11M7 11l5 5 5-5',                                 // send to back: arrow down to a bar                                                  // ditto's chevronD — stacking icons pair two of these, rotated
  box: 'M3 8l9-5 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8',                     // ditto's box, for Group
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7zM4 13h7v7H4z',                // ditto's grid, for Ungroup
  flip: 'M12 3v18M7 8l-4 4 4 4M17 8l4 4-4 4',                                // ditto's flip
  move: 'M12 4v16M4 12h16M9 7l3-3 3 3M9 17l3 3 3-3M7 9l-3 3 3 3M17 9l3 3-3 3', // ditto's move, reused for Center H/V
  contrast: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v18',                  // ditto's contrast
  droplet: 'M12 3s6 5.7 6 10a6 6 0 0 1-12 0c0-4.3 6-10 6-10z',               // ditto's droplet, for Saturation
  blurfilter: 'M4 5h16l-6 8v5l-4 2v-7L4 5z',                                 // ditto's filter, for Blur
  sharpen: 'M12 4l9 15H3L12 4zM12 10v4',                                     // Sharpen: a crisp-edged triangle
  radius: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0',   // Radius: a dot inside a ring
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v9H5z',
  unlock: 'M6 11V8a6 6 0 0 1 11.2-3M5 11h14v9H5z',
  magnet: 'M6 4v7a6 6 0 0 0 12 0V4M6 4h4v7a2 2 0 0 0 4 0V4h4M6 8h4M14 8h4',
  folderplus: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6',
  addcircle: 'circle:12,12,9|M12 8v8M8 12h8',
  scissors: 'circle:6,6,3|circle:6,18,3|M8.1 8.1 20 20M8.1 15.9 20 4',
  aa: 'M4 18 8 6l4 12M5.5 14h5M14 18v-5a2.5 2.5 0 0 1 5 0v5M14 15.5h5',                            // ditto's lock, for the per-layer lock toggle
  width: 'M4 6v12M20 6v12M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4',      // frame/canvas width: bars + double arrow
  height: 'M6 4h12M6 20h12M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4',     // frame/canvas height
  union: 'fillrect:3,3,12,12,2|fillrect:9,9,12,12,2',
  subtract: 'fillrect:3,3,12,12,2|rect:9,9,12,12,2',
  intersect: 'rect:3,3,12,12,2|rect:9,9,12,12,2|fillrect:9,9,6,6,1',
  exclude: 'rect:3,3,12,12,2|rect:9,9,12,12,2|M9.5 9.5l5 5M14.5 9.5l-5 5',
  flatten: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  frame: 'M7 3v18M17 3v18M3 7h18M3 17h18',   // Figma-style frame glyph (Layers panel frame folders)
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',  // Open image (header)
  mask: 'circle:12,12,9|M12 3v18',                                          // half-tone circle: layer mask affordance (canvasmith-only, no reference counterpart)
  maskoff: 'circle:12,12,9|M12 3v18|M4 20 20 4',                              // the mask glyph struck through: delete a layer's mask (never the × that deletes the layer)
  'align-left': 'M3 2v20|fillrect:6,6,7,4,1|fillrect:6,14,12,4,1',
  'align-h-center': 'M12 2v20|fillrect:8.5,6,7,4,1|fillrect:6,14,12,4,1',
  'text-left': 'M4 6h16M4 10h10M4 14h16M4 18h10', 'text-center': 'M4 6h16M7 10h10M4 14h16M7 18h10', 'text-right': 'M4 6h16M10 10h10M4 14h16M10 18h10',
  'align-right': 'M21 2v20|fillrect:11,6,7,4,1|fillrect:6,14,12,4,1',
  'align-top': 'M2 3h20|fillrect:6,6,4,7,1|fillrect:14,6,4,12,1',
  'align-v-center': 'M2 12h20|fillrect:6,8.5,4,7,1|fillrect:14,6,4,12,1',
  'align-bottom': 'M2 21h20|fillrect:6,11,4,7,1|fillrect:14,6,4,12,1',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  maximize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  pen: 'M12 3l7 7-9 9-5 1 1-5 6-6 2 2M11 6l4 4',
  search: 'circle:11,11,7|M21 21l-4.35-4.35',
  tag: 'M20.6 12.2 12.8 20a2 2 0 0 1-2.8 0l-6-6a2 2 0 0 1 0-2.8L11.8 3.4a2 2 0 0 1 1.4-.6H19a2 2 0 0 1 2 2v5.8a2 2 0 0 1-.4 1.6z M16.5 7a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1z',
  square: 'M4 4h16v16H4z',                                                   // "Box" select-by-hand button (ditto's box icon already reused for Group/layerstab elsewhere)
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',                              // region delete
  check: 'M4 12l5 5L20 6',                                                  // "Finish shape"
};
const EYE_OPEN = 'circle:12,12,3|M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z';
const EYE_OFF = 'M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M6.5 6.7C4 8.3 2 12 2 12s4 7 10 7c2 0 3.7-.6 5-1.4M9.9 5.1A10.6 10.6 0 0 1 12 5c6 0 10 7 10 7a15.3 15.3 0 0 1-2.2 3';
ICON_PATHS.eyeOpen = EYE_OPEN; ICON_PATHS.eyeOff = EYE_OFF;
// React-side names for the same glyphs (layer-row eye toggle, left-panel Layers tab)
ICON_PATHS.eye = EYE_OPEN; ICON_PATHS.layers = ICON_PATHS.layerstab;

/* Icon specs → SVG markup, ported verbatim from the vanilla demo's iconSVG() so both shells draw
   every glyph identically (one table, one parser — no hand-redrawn JSX copies to drift). */
function iconMarkup(spec) {
  return spec.split('|').map(part => {
    if (part.startsWith('fillrect:')) { const [x, y, w, h, rx] = part.slice(9).split(',').map(Number); return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="currentColor" stroke="none"/>`; }
    if (part.startsWith('fillcircle:')) { const [cx, cy, r] = part.slice(11).split(',').map(Number); return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor" stroke="none"/>`; }
    if (part.startsWith('rect:')) { const [x, y, w, h, rx] = part.slice(5).split(',').map(Number); return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`; }
    if (part.startsWith('circle:')) { const [cx, cy, r] = part.slice(7).split(',').map(Number); return `<circle cx="${cx}" cy="${cy}" r="${r}"/>`; }
    if (part.startsWith('ellipse:')) { const [cx, cy, rx, ry] = part.slice(8).split(',').map(Number); return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>`; }
    return `<path d="${part}"/>`;
  }).join('');
}
const ICON_MARKUP = {};

/* "More below" cue (the demo's #left-scroll-cue / #right-scroll-cue): a fading, bobbing chevron at
   the bottom edge of whichever .cm-scroll area inside `within` is visible and has content below the
   fold; click scrolls it by 80%. Self-contained — scroll (capture), resize and DOM mutations drive
   it, so no editor-event wiring is needed and it follows tab/tool switches automatically. */
function ScrollCue({ within }) {
  const [cue, setCue] = useState({ show: false, bottom: 0 });
  const target = useRef(null);
  useEffect(() => {
    const root = within.current;
    if (!root) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const els = [...root.querySelectorAll('.cm-scroll')].filter(el => el.clientHeight > 0);
      const el = els.find(e => e.scrollHeight - e.scrollTop - e.clientHeight > 4) || null;
      target.current = el;
      const bottom = el ? Math.max(0, root.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom) : 0;
      setCue(c => (c.show === !!el && c.bottom === bottom) ? c : { show: !!el, bottom });
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    root.addEventListener('scroll', schedule, true);
    const ro = new ResizeObserver(schedule); ro.observe(root);
    const mo = new MutationObserver(schedule); mo.observe(root, { childList: true, subtree: true });
    schedule();
    return () => { root.removeEventListener('scroll', schedule, true); ro.disconnect(); mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [within]);
  return (
    <div className="cm-scroll-cue" data-show={cue.show} style={{ bottom: cue.bottom }} aria-hidden="true"
      onClick={() => { const el = target.current; if (el) el.scrollBy({ top: el.clientHeight * 0.8, behavior: 'smooth' }); }}>
      <Icon name="chevronD" size={15} />
    </div>
  );
}

/* Sticky "jump to section" chips at the top of the properties body: a photo's Adjust / Geometry sections sit
   about two screens down the panel, so each selected layer gets chips for the sections it actually shows. */
function PropJump({ show, layerKey }) {
  const [chips, setChips] = useState([]);
  useEffect(() => {
    if (!show) { setChips([]); return undefined; }
    const raf = requestAnimationFrame(() => {
      const found = [['Transform', 'cm-sec-transform'], ['Shadow', 'cm-sec-shadow'], ['Adjust', 'cm-sec-adjust'], ['Geometry', 'cm-sec-geometry']].filter(([, id]) => { const e = document.getElementById(id); return e && e.offsetParent !== null; });
      setChips(found.length >= 3 ? found : []);
    });
    return () => cancelAnimationFrame(raf);
  });
  if (!chips.length) return null;
  const go = (id) => document.getElementById(id).scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  return (
    <nav className="cm-prop-jump" aria-label="Jump to section">
      {chips.map(([label, id]) => <button key={id} type="button" onClick={() => go(id)}>{label}</button>)}
    </nav>
  );
}

/* Blend & opacity ▸ mode: the shared thumbnail picker (core/blendpicker.js) mounted into a React host. */
function BlendPicker({ value, onPick, preview }) {
  const host = useRef(null), api = useRef(null), pick = useRef(onPick), prev = useRef(preview);
  pick.current = onPick; prev.current = preview;
  useEffect(() => { api.current = mountBlendPicker(host.current, { get: () => null, preview: () => prev.current && prev.current(), set: (v) => pick.current(v) }); return () => { api.current = null; }; }, []);
  useEffect(() => { if (api.current) api.current.sync(value); }, [value]);
  return <div ref={host} />;
}

/* Adjust ▸ Match color: pull the selected photo's colour balance toward another layer's (Editor#matchColor).
   Picking a layer applies it at the current amount, "None" clears it, the Amount slider applies on release. */
function MatchColorRow({ editor, layerId, layers, match }) {
  const ed = editor();
  const srcs = ed && layerId ? ed.matchColorSources(layerId) : [];
  const cur = match && srcs.some(x => x.id === match.ref) ? match.ref : '';
  const [amt, setAmt] = useState(match ? Math.round((match.amount != null ? match.amount : 1) * 100) : 100);
  useEffect(() => { setAmt(match ? Math.round((match.amount != null ? match.amount : 1) * 100) : 100); }, [layerId, match && match.amount]);
  const [err, setErr] = useState('');
  const apply = (ref, a) => {
    const r = ref ? ed.matchColor(layerId, ref, { amount: a / 100 }) : ed.matchColor(layerId, null);
    setErr(r.status === 'error' ? ({ no_pixels: 'Nothing visible to measure', bad_reference: 'Pick a different layer' }[r.reason] || r.reason) : '');
  };
  return (
    <div className="cm-match-row">
      <div className="cm-adj-row">
        <Icon name="droplet" size={13} /><span className="lbl">Match color</span>
        <select className="cm-match-select" aria-label="Match color to layer" value={cur} disabled={!srcs.length} title={srcs.length ? '' : 'Add another photo to match against'}
          onChange={e => apply(e.target.value, amt)}>
          <option value="">None</option>
          {srcs.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      </div>
      {!!cur && (
        <div className="cm-adj-row">
          <span style={{ width: 13 }} /><span className="lbl">Amount</span>
          <input type="range" aria-label="Match color amount" min="0" max="100" step="1" value={amt}
            onChange={e => setAmt(+e.target.value)} onPointerUp={() => apply(cur, amt)} onKeyUp={() => apply(cur, amt)} />
          <span className="val">{amt}</span>
        </div>
      )}
      {err && <div className="cm-note" role="status">{err}</div>}
    </div>
  );
}

/* Typography font picker (demo #tx-font-btn / renderFontPop): a button showing the current face in
   itself, opening a grouped list where every row previews its font with an "Ag" specimen. */
function FontPicker({ value, onPick, onAdded, onError }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gname, setGname] = useState('');
  const [, bump] = useState(0);   // FONT_GROUPS is a mutable registry — re-render after adding to it
  const fileRef = useRef(null);
  const add = async (load) => {
    setBusy(true);
    try { const css = await load(); bump(n => n + 1); onAdded(css); setGname(''); }
    catch (err) { onError(err.message || 'Could not add that font'); }
    setBusy(false);
  };
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  let label = value || 'Choose a font…';
  for (const g of FONT_GROUPS) { const f = g.fonts.find(([, v]) => v === value); if (f) { label = f[0]; break; } }
  return (
    <div className="cm-font-anchor" ref={ref}>
      <button className="cm-btn" style={{ width: '100%', justifyContent: 'space-between' }} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span style={{ fontFamily: value, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span><Icon name="chevronD" size={12} />
      </button>
      {open && (
        <div className="cm-font-pop" role="listbox">
          {FONT_GROUPS.map(g => (
            <React.Fragment key={g.label}>
              <div className="cm-font-grp-label">{g.label}</div>
              {g.fonts.map(([l, v]) => (
                <div key={v} className="cm-font-item" role="option" aria-selected={v === value} data-on={v === value}
                  onClick={() => { onPick(v); setOpen(false); }}>
                  <span className="nm" style={{ fontFamily: v }}>{l}</span><span className="ag" style={{ fontFamily: v }}>Ag</span>
                </div>
              ))}
            </React.Fragment>
          ))}
          <div className="cm-font-add">
            <input type="text" value={gname} placeholder="Google font name, e.g. Space Grotesk" spellCheck={false} autoComplete="off"
              onChange={e => setGname(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && gname.trim()) add(() => addGoogleFont(gname)); }} />
            <button className="cm-btn" type="button" disabled={busy || !gname.trim()} onClick={() => add(() => addGoogleFont(gname))}>Add</button>
            <button className="cm-btn" type="button" disabled={busy} title="Upload .ttf, .otf, .woff or .woff2" onClick={() => fileRef.current && fileRef.current.click()}>Upload font…</button>
            <input ref={fileRef} type="file" accept=".ttf,.otf,.woff,.woff2" hidden
              onChange={e => { const f = e.target.files[0]; e.target.value = ''; if (f) add(() => addCustomFont(f)); }} />
          </div>
        </div>
      )}
    </div>
  );
}

function Icon({ name, size = 15, style }) {
  const spec = ICON_PATHS[name];
  if (!spec) return null;
  const html = ICON_MARKUP[name] || (ICON_MARKUP[name] = iconMarkup(spec));
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}
      dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/* Renders a stickers.js shape spec (same 0-100 coordinate space addSticker() builds from) as a
   small preview SVG for the Stickers grid — one rendering path shared with the real Fabric object
   addSticker() places, so the preview always matches what clicking it actually adds. */
function StickerShapeSVG({ spec, fill, strokeW = 10 }) {
  if (spec.kind === 'circle') return <circle cx={spec.cx} cy={spec.cy} r={spec.r} fill={fill} />;
  if (spec.kind === 'rect') return <rect x={spec.x} y={spec.y} width={spec.w} height={spec.h} rx={spec.rx} fill={fill} />;
  if (spec.kind === 'polygon') return <polygon points={spec.points} fill={fill} />;
  if (spec.kind === 'path') return <path d={spec.d} fill={spec.stroke ? 'none' : fill} stroke={spec.stroke ? fill : 'none'} strokeWidth={spec.stroke ? strokeW : 0} strokeLinecap="round" strokeLinejoin="round" fillRule={spec.fillRule || 'nonzero'} />;
  return null;
}
/* `neutral`: the Stickers panel's look (demo .sticker-thumb) — one dim tone via CSS `color`, label cut
   out in the panel background, SVG filling its cell. Without it: the real first palette colour. */
function StickerPreview({ shapeKey, size = 28, neutral = false }) {
  const spec = stickerSpec(shapeKey);
  if (!spec) return null;
  const fill = neutral ? 'currentColor' : STICKER_PALETTE[0];
  const dim = neutral ? '100%' : size, sw = neutral ? 8 : 10;
  if (spec.kind === 'group') {
    const baseSpec = stickerSpec(spec.shape);
    if (!baseSpec) return null;
    const ink = neutral ? 'var(--cm-bg)' : (relLum(hexRgb(fill)) > 0.6 ? '#0c0c0e' : '#ffffff');
    return (
      <svg width={dim} height={dim} viewBox="0 0 100 100" aria-hidden="true">
        <StickerShapeSVG spec={baseSpec} fill={fill} strokeW={sw} />
        <text x={50} y={50} fontFamily="system-ui, sans-serif" fontWeight={800} fontSize={STICKER_DEFAULT_LABEL.length > 4 ? 14 : 19} fill={ink} textAnchor="middle" dominantBaseline="central">{STICKER_DEFAULT_LABEL}</text>
      </svg>
    );
  }
  return <svg width={dim} height={dim} viewBox="0 0 100 100" aria-hidden="true"><StickerShapeSVG spec={spec} fill={fill} strokeW={sw} /></svg>;
}

const GROUPS = [
  { label: 'Move', tools: [['select', 'Select'], ['hand', 'Pan'], ['crop', 'Crop']] },
  { label: 'Paint', tools: [['brush', 'Brush'], ['pencil', 'Pencil'], ['eraser', 'Eraser'], ['clone', 'Clone'], ['heal', 'Heal'], ['dodge', 'Dodge'], ['burn', 'Burn'], ['sponge', 'Sponge'], ['redeye', 'Red-eye']] },
  { label: 'Select', tools: [['marquee', 'Marquee'], ['marquee-ellipse', 'Ellipse'], ['lasso', 'Lasso'], ['lasso-poly', 'Polygon lasso'], ['lasso-mag', 'Magnetic lasso'], ['wand', 'Wand'], ['objectselect-bbox', 'Object / magic select'], ['magicwand', 'Magic wand'], ['objectselect', 'Object select'], ['hoverselect', 'Hover select']] },
  { label: 'AI', tools: [['aiinsert', 'AI insert']] },
  { label: 'Draw', tools: [['rect', 'Rect'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['triangle', 'Triangle'], ['polygon', 'Polygon'], ['star', 'Star'], ['pen', 'Pen'], ['type', 'Text'], ['bucket', 'Fill'], ['gradient', 'Gradient'], ['eyedropper', 'Pick']] },
];


/* Per-tool display names for the rail's tooltips/flyouts and the ⌘K palette — ported verbatim
   from the vanilla demo's TOOL_LABELS so both shells describe each tool identically. */
const TOOL_LABELS = {
  select: 'Move / select', hand: 'Hand · pan', crop: 'Crop',
  marquee: 'Rectangular marquee', 'marquee-ellipse': 'Elliptical marquee', lasso: 'Lasso (freehand)',
  'lasso-poly': 'Polygonal lasso · click to add points', 'lasso-mag': 'Magnetic lasso · snaps to edges',
  wand: 'Magic wand · click a colour region', objectselect: 'Object select', hoverselect: 'Hover select · preview on hover',
  'objectselect-bbox': 'Object / magic select', magicwand: 'Magic wand · click an object to grab it',
  heal: 'Spot heal', clone: 'Clone stamp', redeye: 'Red-eye',
  brush: 'Brush', pencil: 'Pencil', eraser: 'Eraser',
  bucket: 'Paint bucket', gradient: 'Gradient',
  dodge: 'Dodge · lighten', burn: 'Burn · darken', sponge: 'Sponge · saturation',
  rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', triangle: 'Triangle', polygon: 'Polygon', star: 'Star',
  type: 'Type', eyedropper: 'Eyedropper', pen: 'Pen · vector path',
  aiinsert: 'AI insert',
};
// Per-tool dock hint — verbatim from the vanilla demo's TOOL_HINTS.
const TOOL_HINTS = {
  select: 'Click any layer directly on the artboard or drag a bounding marquee to transform.',
  crop: 'Drag the handles, then press Enter or Apply crop. Esc cancels.',
  'lasso-poly': 'Click to place points; click near the start (or press Enter) to close, Escape to cancel.',
  'lasso-mag': 'Click to place points that snap to nearby edges; Enter closes, Escape cancels.',
  wand: 'Click a colour region to select it. Shift-click adds, Alt-click subtracts.',
  objectselect: 'Click an object to select it (OpenCV-assisted). Shift-click adds, Alt-click subtracts.',
  hoverselect: 'Hover to preview what a click would select, then click to commit it.',
  'objectselect-bbox': 'Click selects the active layer’s own bounding box; with nothing active, selects a center region.',
  magicwand: 'Click an object to grab it (OpenCV-assisted). Shift-click adds, Alt-click subtracts, re-click cycles overlapping objects.',
  gradient: 'Drag across a selected shape to fill it — the handles stay so you can re-aim it: drag an end or slide the line, click a colour square to change that colour (drag a middle one to move it); click outside the shape when done. With nothing selected, drag to paint a gradient.',
  bucket: 'Click an area to fill it with the colour (similar neighbouring colours are filled too). With a selection, fills the selection.',
  pen: 'Click for a corner, click-drag for a curve (⌥ breaks the handles, ⇧ snaps to 45°, Space moves the point). Click the first point to close into a filled shape; Enter/Esc keeps an open stroke. ⌫ removes the last point. With a path selected: click its outline to add a point, a point to delete it, an open end to continue.',
  aiinsert: 'AI insert · click a spot to draw there — or make a selection first and click inside it: the AI fills exactly that shape',
  clone: 'Alt-click (⌥) or Shift-click (⇧) to set the source point, then paint elsewhere to stamp those pixels. Click again with either to re-source.',
  // a plain stroke heals from the surroundings now (spot heal) — the source point is optional
  heal: 'Paint over a blemish and it is filled in from its surroundings. To copy from a chosen spot instead, ⌥-click (or ⇧-click) that spot first, then paint.',
  type: 'Click on the canvas to add text. Double-click any text to edit it.',
};
// Inverse of TOOL_KEYS (letter -> tool), so the rail's tooltip/flyout shortcut hint always
// matches what installKeybindings actually honors — same one-source-of-truth contract as the
// vanilla demo's own TOOL_SHORTCUT derivation.
const TOOL_SHORTCUT = {};
Object.entries(TOOL_KEYS).forEach(([key, id]) => { TOOL_SHORTCUT[id] = key.toUpperCase(); });

/* Rail grouping: each entry is a set of sibling tools that share one rail slot — a single tool
   renders as a plain button, 2+ render as a button (showing whichever sibling is active, or the
   first) plus a caret that opens a hover flyout listing the rest. Ported verbatim from the vanilla
   demo's TOOLGROUPS so both shells group/cycle tools identically. */
const UI_FONT_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Bricolage+Grotesque:wght@400;500;600;700;800&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap';

// Rail glyph per tool where it differs from the tool id (demo TOOLGROUPS' `icon` field).
const TOOL_ICON = { aiinsert: 'spark' };
// Paint tools that never read the colour option — no swatches for them.
const NO_COLOR_TOOLS = ['eraser', 'clone', 'heal', 'dodge', 'burn', 'sponge', 'redeye'];
const TOOLGROUPS = [
  ['select', 'hand'],
  ['marquee', 'marquee-ellipse', 'lasso', 'lasso-poly', 'lasso-mag', 'wand', 'objectselect-bbox'],
  ['magicwand', 'objectselect', 'hoverselect'],
  ['aiinsert'],
  ['crop'],
  ['eyedropper'],
  ['heal', 'clone', 'redeye'],
  ['brush', 'pencil'],
  ['eraser'],   // its own rail button — tucked in the brush flyout it was effectively undiscoverable
  ['bucket', 'gradient'],
  ['dodge', 'burn', 'sponge'],
  ['pen'],
  ['rect', 'ellipse', 'line', 'triangle', 'polygon', 'star'],
  ['type'],
];

const SEL_REASON_MSG = {
  cv_unavailable: 'Needs the OpenCV worker (no internet / blocked CDN).',
  no_selection: 'Make a selection first.',
  no_seed: 'Use the wand or object-select tool first, then Select similar.',
  no_match: 'No matching region found.',
  need_multi_selection: 'Shift-click 2+ layers on the canvas to group them.',
  need_group: 'Select a group to ungroup.',
};

const AI_REASON_MSG = {
  no_provider: 'No AI provider is registered.',
  rate_limited: 'Free daily quota hit — try again later, or add billing to your key.',
  no_regions: 'Nothing detected — try "Select one object manually" instead.',
  destroyed: '',
};

const EMPTY_PROPS = {
  active: false, title: 'Properties', isImage: false, isAdjustment: false, fx: FX_DEFAULTS, geom: GEOMETRY_DEFAULTS,
  text: null,
  hasFill: false, fill: '#ef6a2d', fillAlpha: 1, shapeGradient: null, blend: 'source-over', opacity: 1,
  hasBorder: false, strokeWidth: 0, stroke: '#000000', strokeAlpha: 1, strokeOpts: null, shapeType: '', fillOff: false, strokeOff: false,
  angle: 0, x: '', y: '', w: '', h: '', skewX: 0, skewY: 0, isRect: false, rx: 0,
  shadow: { color: '#000000', blur: 0, offsetX: 0, offsetY: 0 },
  canGroup: false, canUngroup: false, combine: null, hasSelectionPixels: false, selFeather: 0, canFeather: false, edgeFeather: 0,
};

/* A solid fill/stroke value as { color: 6-digit hex, alpha: 0..1 } — plain hex, or the rgba() string
   withAlpha writes once a fill/border opacity drops below 100%. null for gradients, patterns, etc. */
function solidColor(c) {
  if (typeof c !== 'string') return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) return { color: m[1].length === 3 ? '#' + [...m[1]].map(x => x + x).join('') : c, alpha: 1 };
  return /^rgba?\(/i.test(c) ? splitGradientStopColor(c) : null;
}

/* Inverse of solidColor — same encoding as Editor#setCanvasBackground (opaque stays a plain hex). */
const withAlpha = (hex, alpha) => (alpha >= 1 ? hex : rgba(hex, +Math.max(0, alpha).toFixed(3)));

/* A hex field beside a colour swatch — the React mirror of the demo's bindHexField: applies on
   Enter/blur when it parses (3- or 6-digit, '#' optional), otherwise snaps back to `value`. */
function HexField({ value, label, onCommit, className = 'cm-hex' }) {
  const [draft, setDraft] = useState(null);
  const shown = draft != null ? draft : (value || '').toUpperCase();
  const commit = () => {
    if (draft == null) return;
    const m = draft.trim().replace(/^#/, '').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
    setDraft(null);
    if (!m) return;
    const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
    if ('#' + h.toLowerCase() !== (value || '').toLowerCase()) onCommit('#' + h.toLowerCase());
  };
  return (
    <input className={className} aria-label={label} spellCheck={false} maxLength={7} value={shown}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        else if (e.key === 'Escape') { setDraft(null); setTimeout(() => e.target.blur()); }
      }} />
  );
}

/* A number input that only applies on Enter/blur (artboard resizes are full history commits, so
   not one per keystroke); Escape or an out-of-range value snaps back to `value`. */
/* Fill / border eye toggle at the end of a colour row — hides the paint without losing it. */
function PaintEye({ hidden, what, disabled, onToggle }) {
  const title = (hidden ? 'Show ' : 'Hide ') + what;
  return (
    <button type="button" className="cm-paint-eye" title={title} aria-label={title} aria-pressed={hidden}
      aria-disabled={disabled} onClick={() => { if (!disabled) onToggle(hidden); }}>
      <Icon name={hidden ? 'eyeOff' : 'eye'} size={16} />
    </button>
  );
}

function CommitNumber({ value, min, max, onCommit, ...rest }) {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft == null) return;
    setDraft(null);
    if (String(draft).trim() === '') return;   // cleared box = revert, not 0
    const n = Math.round(+draft);
    if (!Number.isFinite(n)) return;
    const v = Math.max(min, Math.min(max, n));   // out of range snaps to the limit (same as the demo)
    if (v !== value) onCommit(v);
  };
  return (
    <input type="number" min={min} max={max} {...rest} value={draft != null ? draft : value}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') { setDraft(null); setTimeout(() => e.target.blur()); }
      }} />
  );
}

// AI tab style presets — same list as the demo's AI_STYLE_PRESETS; appended to the prompt on run.
const AI_STYLE_PRESETS = [
  ['Studio', 'clean professional studio lighting, seamless backdrop, soft natural shadows'],
  ['Cinematic', 'cinematic lighting, dramatic contrast, rich film-like colour grade'],
  ['Minimal', 'minimal, uncluttered composition with a soft neutral palette'],
  ['Warm', 'warm golden-hour tones and soft sunlight'],
];
// Shrinks an attached AI reference image so it doesn't blow the request size.
function downscaleDataURL(src, max = 1024) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }).then(img => {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
  });
}

// [label, w, h, description] — same presets as the demo's Canvas section.
/* Border style / position / caps / join options (stroke.js) — same lists as the vanilla demo. */
const STROKE_STYLES = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']];
const STROKE_POSITIONS = [['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']];
const STROKE_CAPS = [['butt', 'None'], ['round', 'Round'], ['square', 'Square']];
const STROKE_JOINS = [['miter', 'Miter'], ['round', 'Round'], ['bevel', 'Bevel']];

const CANVAS_RATIOS = [['16:9', 1920, 1080, 'Standard'], ['1:1', 1080, 1080, 'Square'], ['9:16', 1080, 1920, 'Story'], ['4:5', 1080, 1350, 'Portrait']];

/* Canvas section (top of Properties when nothing is selected): artboard W×H + aspect presets, and the
   page's background fill. Mirrors the demo's #canvas-section. */
function CanvasSection({ editor, info, frames }) {
  const { W, H, bg } = info;
  const activeFrame = frames.find(f => f.active) || null;
  const match = CANVAS_RATIOS.find(([, w, h]) => Math.abs(W / H - w / h) < 0.005);
  return (
    <div className="cm-canvas-sec">
      <div className="cm-grp" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
        <span>Frame</span><span className="aside">{frames.length > 1 ? `${frames.findIndex(f => f.active) + 1} of ${frames.length}` : ''}</span>
      </div>
      <div className="cm-fr-bar">
        <label className="cm-fr-field" title="Frame name — rename it here">
          <span className="cm-fr-field-ico"><Icon name="frame" size={14} /></span>
          <input key={(activeFrame ? activeFrame.id + ':' + activeFrame.name : 'none')} defaultValue={activeFrame ? activeFrame.name : ''} maxLength={40} spellCheck={false} aria-label="Frame name"
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); else if (e.key === 'Escape') { e.target.value = activeFrame ? activeFrame.name : ''; e.target.blur(); } }}
            onBlur={(e) => { if (activeFrame) editor().renameFrame(activeFrame.id, e.target.value); }} />
        </label>
        <button className="cm-fr-btn cm-frame-add" disabled={frames.length >= 12} aria-label="Add frame" title={frames.length >= 12 ? 'A page holds up to 12 frames' : 'Add a frame to this page'} onClick={() => editor().addFrame()}><Icon name="plus" size={15} /></button>
        <button className="cm-fr-btn cm-frame-del" disabled={frames.length < 2} aria-label="Delete frame" title="Delete this frame and its layers"
          onClick={() => {
            if (!activeFrame) return;
            const n = editor().layers().filter(l => l.frameId === activeFrame.id).length;
            if (n && !window.confirm('Delete \u201c' + activeFrame.name + '\u201d and its ' + n + ' layer' + (n === 1 ? '' : 's') + '?')) return;
            editor().removeFrame(activeFrame.id);
          }}><Icon name="trash" size={14} /></button>
      </div>
      <div className="cm-grp">
        <span>Frame size</span><span className="aside">{match ? match[0] + ' ' + match[3] : 'Custom'}</span>
      </div>
      <div className="cm-cv-dims">
        <label className="cm-cv-dim" title="Width"><span className="cm-cv-dim-ico"><Icon name="width" size={17} /></span><CommitNumber value={W} min={1} max={8000} aria-label="Canvas width" onCommit={w => editor().resizeCanvas(w, H)} /><span>px</span></label>
        <label className="cm-cv-dim" title="Height"><span className="cm-cv-dim-ico"><Icon name="height" size={17} /></span><CommitNumber value={H} min={1} max={8000} aria-label="Canvas height" onCommit={h => editor().resizeCanvas(W, h)} /><span>px</span></label>
      </div>
      <div className="cm-cv-ratios">
        {CANVAS_RATIOS.map(([label, w, h, desc]) => (
          <button key={label} title={desc + ' — ' + w + '×' + h} data-on={!!match && match[0] === label} onClick={() => editor().resizeCanvas(w, h)}>{label}</button>
        ))}
      </div>
      <div className="cm-grp">
        <span>Background fill</span>
        <button className="cm-cv-link" title={bg.transparent ? 'Fill the page with a solid colour again' : 'Clear the page fill (exports keep transparency as PNG)'}
          onClick={() => editor().setCanvasBackground(bg.transparent ? { color: bg.color, alpha: 1 } : null)}>
          {bg.transparent ? 'Make solid' : 'Transparent'}
        </button>
      </div>
      <div className="cm-swatch-row">
        <span className="cm-cv-swatch" title="Background colour">
          <i style={{ background: bg.color, opacity: bg.alpha }} />
          <input type="color" value={bg.color} aria-label="Background colour" onChange={e => editor().setCanvasBackground({ color: e.target.value })} />
        </span>
        <div className="cm-cv-fill">
          <HexField value={bg.color} label="Background colour hex" onCommit={v => editor().setCanvasBackground({ color: v })} />
          <span className="pct"><CommitNumber value={Math.round(bg.alpha * 100)} min={0} max={100} aria-label="Background opacity" onCommit={a => editor().setCanvasBackground({ color: bg.color, alpha: a / 100 })} />%</span>
        </div>
      </div>
    </div>
  );
}

/* Reads every field the Properties panel shows off the current fabric active object — the React
   mirror of the vanilla demo's refreshPropsPanel(), so both UIs present the exact same state.
   hasSelectionPixels tracks ed.selection (a marquee/lasso/wand pixel selection), which is an
   entirely separate concept from the fabric active OBJECT the rest of this function reads — a
   pixel selection has no active object at all, so it must be read before the early return below,
   not folded into the object-only branch (an object-selection UI can be "nothing selected" while
   a pixel selection is very much active, and vice versa). */
function readProps(ed) {
  const o = ed.fc.getActiveObject();
  if (!o) return { ...EMPTY_PROPS, hasSelectionPixels: !!ed.selection, selFeather: (ed.selection && ed.selection.feather) || 0 };
  const isImage = o.type === 'image';
  const isAdjustment = o.role === 'adjustment';
  const fillTarget = o.type === 'activeSelection' ? o.getObjects()[0] : o;
  const solidFill = fillTarget ? solidColor(ed.textSelectionFill() || fillTarget.fill) : null;
  const shapeGradient = ed.getShapeGradient();
  const hasFill = !!fillTarget && !isImage && fillTarget.type !== 'line' && fillTarget.role !== 'paint' && (solidFill || !!shapeGradient);
  const fill = solidFill ? solidFill.color : '#ef6a2d';
  const fillAlpha = solidFill ? solidFill.alpha : 1;
  // Border (stroke) applies to any fillable/strokeable vector shape or line — not images or paint
  // strokes — same hasBorder condition as the vanilla demo's refreshPropsPanel.
  const hasBorder = !!fillTarget && !isImage && fillTarget.role !== 'paint';
  const solidStroke = fillTarget ? solidColor(fillTarget.stroke) : null;
  const strokeColor = solidStroke ? solidStroke.color : '#000000';
  const strokeAlpha = solidStroke ? solidStroke.alpha : 1;
  return {
    active: true,
    title: o.type === 'activeSelection' ? (o._objects ? o._objects.length + ' layers' : 'Selection') : (ed.layers().find(l => l.active)?.name || layerLabel(o)),
    iso: ed.isolationParent ? ed.isolationParent() : null,   // inside a sticker/group: the fields act on one part
    isImage, isAdjustment,
    typeLabel: layerTypeLabel(o), locked: !!o.locked,
    fx: isAdjustment ? ed.getAdjustmentParams(o.id) : isImage ? ed.getImageFilters() : EMPTY_PROPS.fx,
    geom: isImage && !isAdjustment ? ed.getImageGeometry() : EMPTY_PROPS.geom,
    text: ed.getTextProps(),
    hasFill, fill, fillAlpha, shapeGradient,
    // No stroke colour = no visible border, whatever Fabric's default strokeWidth of 1 says.
    hasBorder, strokeWidth: fillTarget && fillTarget.stroke ? Math.round(fillTarget.strokeWidth || 0) : 0, stroke: strokeColor, strokeAlpha,
    strokeOpts: hasBorder ? strokeInfo(fillTarget) : null, shapeType: fillTarget ? fillTarget.type : '',
    fillOff: !!(fillTarget && fillTarget.fillOff), strokeOff: !!(fillTarget && fillTarget.strokeOff),
    blend: o.globalCompositeOperation || 'source-over',
    opacity: o.opacity != null ? o.opacity : 1,
    angle: Math.round(o.angle || 0),
    // top-left of the box whatever the origin (a centre-origin sticker showed its centre)
    ...(() => { const p = ed.panelPosition ? ed.panelPosition(o) : { x: o.left || 0, y: o.top || 0 }; return { x: Math.round(p.x), y: Math.round(p.y) }; })(),
    w: Math.round(o.getScaledWidth ? o.getScaledWidth() : (o.width || 0)),
    h: Math.round(o.getScaledHeight ? o.getScaledHeight() : (o.height || 0)),
    skewX: Math.round(o.skewX || 0), skewY: Math.round(o.skewY || 0),
    // rectangles, and images (rounded photo cards) not already clipped some other way
    canFeather: o.type === 'image' || o.role === 'paint', edgeFeather: o.edgeFeather || 0,
    isRect: o.type === 'rect' || (o.type === 'image' && !(o.clipPath && o.clipPath.role !== 'corner')), rx: Math.round(ed.cornerRadiusOf(o)),   // true on-screen radius, not the scale-divided local rx
    shadow: {
      color: (o.shadow && o.shadow.color) || '#000000',
      blur: (o.shadow && o.shadow.blur) || 0,
      offsetX: (o.shadow && o.shadow.offsetX) || 0,
      offsetY: (o.shadow && o.shadow.offsetY) || 0,
    },
    canGroup: o.type === 'activeSelection',
    canUngroup: o.type === 'group',
    combine: ed.combineInfo(),
    hasSelectionPixels: !!ed.selection, selFeather: (ed.selection && ed.selection.feather) || 0,
  };
}

const THEMES = {
  // Same palette as the vanilla demo's :root tokens — neutral graphite surfaces, blue accent.
  // (the visual refresh: neutral zinc greys, standard blue — keep in step with the CSS token block)
  dark: { bg: '#141416', panel: '#1b1b1e', line: 'rgba(255,255,255,.08)', ink: '#ececee', dim: '#a1a1aa', accent: '#3b82f6', accentInk: '#fff', stage: '#111113' },
  light: { bg: '#f4f4f5', panel: '#ffffff', line: 'rgba(9,9,11,.09)', ink: '#18181b', dim: '#52525b', accent: '#2563eb', accentInk: '#fff', stage: '#e8e8eb' },
};

const CSS = `
/* Theme tokens: dark is the default/fallback (also applied explicitly via [data-cm-mode=dark] so
   the toggle can switch back to it), light is a soft warm off-white — NOT stark white against the
   page, matching the fix applied to the vanilla demo's own light theme (a pure #ffffff panel read
   as glare against its warm beige background; same reasoning applies here even though this shell's
   "page" is just --cm-bg behind the panels). Extra tokens (--cm-panel-2/--cm-dim-2/--cm-line-soft)
   support controls added in this pass (checkbox rows, status pill, AI button, swatches) that need
   a secondary surface/text tone beyond the original bg/panel/ink/dim set. */
.cm-root, .cm-root[data-cm-mode=dark]{
  --cm-bg:#1e1e1e; --cm-panel:#262626; --cm-panel-2:#2f2f2f; --cm-line:rgba(255,255,255,.10); --cm-line-soft:rgba(255,255,255,.07);
  --cm-ink:#e8e8e6; --cm-dim:#c3c3c0; --cm-dim-2:#918f8c; --cm-accent:#4f8ff0; --cm-accent-ink:#fff; --cm-stage:#1a1a1a; --cm-danger:#f87171; --cm-ai-green:#3ecf8e; --cm-ai-violet-ink:#c4b5fd; --cm-ai-blue:#7aa7ff; --cm-ai-violet:#b794f6; --cm-ai-teal:#5eead4;
  --cm-shadow-sm:0 1px 0 rgba(255,255,255,.03) inset, 0 4px 12px rgba(0,0,0,.35); --cm-shadow-md:0 8px 24px rgba(0,0,0,.4);
}
.cm-root[data-cm-mode=light]{
  --cm-bg:#ece6d9; --cm-panel:#faf7f0; --cm-panel-2:#f1ebdd; --cm-line:rgba(30,26,18,.11); --cm-line-soft:rgba(30,26,18,.07);
  --cm-ink:#26221c; --cm-dim:#5e594f; --cm-dim-2:#8c867a; --cm-accent:#2f6fdb; --cm-accent-ink:#fff; --cm-stage:#e4ddcc; --cm-danger:#c73434; --cm-ai-green:#15803d; --cm-ai-violet-ink:#6d28d9; --cm-ai-blue:#2563eb; --cm-ai-violet:#7c3aed; --cm-ai-teal:#0f766e;
  --cm-shadow-sm:0 1px 2px rgba(40,34,22,.06); --cm-shadow-md:0 8px 22px rgba(40,34,22,.08);
}
.cm-root{
  display:grid;grid-template-columns:56px 290px 1fr 322px;grid-template-rows:48px 1fr;height:100%;min-height:480px;
  background:var(--cm-bg);color:var(--cm-ink);font:13px/1.45 "Hanken Grotesk",system-ui,sans-serif;position:relative}
.cm-root[data-left-collapsed=true]{grid-template-columns:56px 0px 1fr 322px}
.cm-root[data-side-collapsed=true]{grid-template-columns:56px 290px 1fr 0px}
.cm-root[data-left-collapsed=true][data-side-collapsed=true]{grid-template-columns:56px 0px 1fr 0px}
.cm-top{grid-column:1/5;display:flex;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid var(--cm-line);background:var(--cm-panel)}
.cm-rail{display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 8px;border-right:1px solid var(--cm-line);background:var(--cm-panel);overflow-y:auto;overflow-x:visible;position:relative;z-index:10}
.cm-rail-group{position:relative}
.cm-rail-btn{all:unset;box-sizing:border-box;cursor:pointer;width:40px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;position:relative;color:var(--cm-dim);transition:background .12s}
.cm-rail-btn:hover{background:var(--cm-bg);color:var(--cm-ink)}
.cm-rail-btn[data-on=true]{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink)}
/* "This slot holds more tools" marker — was so low-contrast that 8 of 15 rail slots read as
   single-tool buttons and their alternates were undiscoverable. Brighter, and stronger on
   hover so the cue lands while the pointer is on it. */
.cm-rail-caret{position:absolute;right:2.5px;bottom:2.5px;width:0;height:0;border-left:5px solid transparent;border-bottom:5px solid var(--cm-dim);transition:border-bottom-color .12s}
.cm-rail-btn:hover .cm-rail-caret{border-bottom-color:var(--cm-ink)}
.cm-rail-btn[data-on=true] .cm-rail-caret{border-bottom-color:var(--cm-accent-ink)}
/* Export menu: size picker + project-file rows. */
.cm-export-scale-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 10px 5px;font-size:11px;color:var(--cm-dim)}
.cm-export-scale{display:flex;gap:3px}
.cm-export-scale-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600;color:var(--cm-dim);border:1px solid var(--cm-line)}
.cm-export-scale-btn:hover{color:var(--cm-ink);border-color:var(--cm-dim-2)}
.cm-export-scale-btn[data-on=true]{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink);border-color:var(--cm-accent)}
.cm-export-dims{padding:0 10px 7px;font-size:10.5px;color:var(--cm-dim-2);font-variant-numeric:tabular-nums}
.cm-export-sep{height:1px;background:var(--cm-line);margin:5px 0}
.cm-export-hint{margin-left:auto;padding-left:10px;font-size:9.5px;color:var(--cm-dim-2);font-weight:500;white-space:nowrap}
.cm-export-menu-item{white-space:nowrap}
/* Drop cue — dragging a file over the canvas previously produced no response at all. */
.cm-stage[data-dropping=true]::after{content:"Drop image to add it";position:absolute;inset:10px;z-index:30;pointer-events:none;display:flex;align-items:center;justify-content:center;border:2px dashed var(--cm-accent);border-radius:14px;background:color-mix(in srgb, var(--cm-accent) 10%, transparent);color:var(--cm-ink);font-size:14px;font-weight:700}
/* Toast */
.cm-toast-wrap{position:absolute;grid-area:1/1/-1/-1;justify-self:center;align-self:end;left:auto;bottom:26px;transform:translateX(-50%);z-index:400;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
.cm-toast{display:flex;align-items:center;gap:12px;background:var(--cm-panel);border:1px solid var(--cm-line);border-radius:10px;padding:10px 14px;font-size:12.5px;color:var(--cm-ink);box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:auto}
.cm-toast button{all:unset;cursor:pointer;font-weight:700;color:var(--cm-accent);padding:2px 4px;border-radius:5px}
.cm-toast button:hover{text-decoration:underline}
.cm-rail-flyout{position:absolute;left:48px;top:0;z-index:60;min-width:194px;background:var(--cm-panel);border:1px solid var(--cm-line);border-radius:11px;padding:6px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.cm-rail-flyout-item{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:7px;cursor:pointer;font-size:12.5px;color:var(--cm-ink)}
.cm-rail-flyout-item:hover,.cm-rail-flyout-item[data-on=true]{background:var(--cm-bg)}
.cm-rail-flyout-item svg{flex-shrink:0;color:var(--cm-dim)}
.cm-rail-flyout-item[data-on=true] svg{color:var(--cm-accent)}
.cm-rail-flyout-item .sc{margin-left:auto;font-size:10.5px;color:var(--cm-dim);font-family:"JetBrains Mono",ui-monospace,monospace}
.cm-rail-tip{position:fixed;z-index:70;background:var(--cm-ink);color:var(--cm-panel);font-size:11.5px;font-weight:600;padding:5px 9px;border-radius:6px;pointer-events:none;white-space:nowrap;transform:translateY(-50%);box-shadow:0 8px 24px rgba(0,0,0,.4)}
.cm-rail-bottom{display:flex;flex-direction:column;align-items:center;gap:3px;margin-top:8px;padding-top:8px;border-top:1px solid var(--cm-line)}
.cm-stage{position:relative;overflow:hidden;display:grid;place-items:center;background:var(--cm-stage)}
.cm-center{display:flex;flex-direction:column;min-width:0;min-height:0}
.cm-center>.cm-stage{flex:1;min-height:0}
.cm-tabbar{flex:none;display:flex;align-items:flex-end;gap:2px;height:42px;padding:0 10px;background:var(--cm-panel);border-bottom:1px solid var(--cm-line);overflow-x:auto;scrollbar-width:none;position:relative;z-index:10}
.cm-tabbar::-webkit-scrollbar{display:none}
.cm-doctab{flex:none;display:flex;align-items:center;gap:6px;max-width:200px;height:34px;margin-bottom:-1px;padding:0 6px 0 12px;border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;background:transparent;color:var(--cm-dim-2);font-size:12px;font-weight:500;cursor:pointer;user-select:none}
.cm-doctab:hover{color:var(--cm-ink);background:var(--cm-ctl)}
.cm-doctab[data-on=true]{background:var(--cm-stage);color:var(--cm-ink);border-color:var(--cm-line);box-shadow:inset 0 2px 0 var(--cm-accent)}
.cm-dt-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-dt-x{all:unset;display:grid;place-items:center;width:18px;height:18px;border-radius:5px;color:var(--cm-dim-2);cursor:pointer}
.cm-dt-x:hover{background:var(--cm-line);color:var(--cm-ink)}
.cm-doctab input{all:unset;width:110px;font-size:12px;color:var(--cm-ink);border-bottom:1px solid var(--cm-accent)}
.cm-doctab-add{all:unset;box-sizing:border-box;flex:none;display:grid;place-items:center;width:28px;height:28px;margin:0 0 5px 4px;border-radius:7px;color:var(--cm-dim-2);cursor:pointer}
.cm-doctab-add:disabled{opacity:.35;cursor:not-allowed}
.cm-doctab-add:disabled:hover{background:none;color:var(--cm-dim-2)}
.cm-doctab-add:hover{color:var(--cm-ink);background:var(--cm-ctl)}
.cm-left{border-right:1px solid var(--cm-line);background:var(--cm-panel);overflow:hidden;padding:0;transition:padding .15s;display:flex;flex-direction:column;min-height:0}
/* left panel: Layers / AI Vision tabs, toolbar, list, contextual tool dock, pinned AI card —
   same structure and behaviour as the vanilla demo's #left-panel */
.cm-lp{display:flex;flex-direction:column;flex:1;min-height:0}
.cm-lp-tabs{display:flex;border-bottom:1px solid var(--cm-line);padding:0 10px;flex:none}
.cm-lp-tab{all:unset;box-sizing:border-box;flex:1;display:flex;align-items:center;justify-content:center;gap:7px;padding:13px 6px 11px;font-size:12.5px;font-weight:600;color:var(--cm-dim);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.cm-lp-tab:hover{color:var(--cm-ink)}
.cm-lp-tab[aria-selected=true]{color:var(--cm-ink);border-bottom-color:var(--cm-accent)}
.cm-lp-tab:focus-visible{box-shadow:0 0 0 2px var(--cm-accent);border-radius:6px}
.cm-lp-count{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--cm-bg);color:var(--cm-dim);font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}
.cm-lp-view{flex:1;min-height:0;display:flex;flex-direction:column}
.cm-lp-ai{overflow-y:auto;padding:14px}
.cm-lp-toolbar{display:flex;align-items:center;gap:2px;padding:10px 12px 8px;flex:none;border-bottom:1px solid var(--cm-line);position:relative}
.cm-lp-tbtn{all:unset;box-sizing:border-box;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:8px;color:var(--cm-dim);cursor:pointer}
.cm-lp-tbtn:hover:not(:disabled){background:var(--cm-bg);color:var(--cm-ink)}
.cm-lp-tbtn:disabled{opacity:.35;cursor:default}
.cm-lp-tbtn:focus-visible{box-shadow:0 0 0 2px var(--cm-accent)}
.cm-lp-tbtn[data-on=true]{color:var(--cm-accent)}
.cm-lp-menu{position:absolute;top:42px;left:10px;width:180px;padding:5px;z-index:30;background:var(--cm-panel);border:1px solid var(--cm-line);border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.35)}
.cm-lp-menu button{all:unset;box-sizing:border-box;width:100%;display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:7px;font-size:12px;color:var(--cm-ink);cursor:pointer}
.cm-lp-menu button:hover,.cm-lp-menu button:focus-visible{background:var(--cm-bg)}
.cm-lp-menu button svg{color:var(--cm-dim)}
.cm-lp-list{flex:1;min-height:90px;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.cm-dock{padding-bottom:18px;margin-bottom:16px;position:relative}
.cm-dock::after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;border-radius:2px;background:var(--cm-line-soft)}
.cm-lp-view>.cm-dock{flex:1;min-height:0;overflow-y:auto;margin:0;padding:12px 14px 14px}
.cm-lp-view>.cm-dock::after{display:none}
.cm-dock>div>.cm-grp:first-child{margin-top:18px;padding-top:14px;border-top:1px solid var(--cm-line-soft)}
.cm-dock-head{display:flex;align-items:center;gap:7px;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--cm-dim)}
.cm-dock-head .cm-status-pill{margin-left:auto}
.cm-lp-card{flex:none;position:relative;border-top:1px solid color-mix(in srgb,var(--cm-accent) 30%,var(--cm-line));padding:12px 14px 14px;
  background:linear-gradient(180deg,color-mix(in srgb,var(--cm-accent) 10%,var(--cm-panel)),var(--cm-panel) 75%)}
/* a bright hairline across the card's top edge so the AI area reads as its own zone */
.cm-lp-card::before{content:"";position:absolute;left:0;right:0;top:-1px;height:1px;background:linear-gradient(90deg,transparent,var(--cm-accent),transparent)}
.cm-lp-tab-ai svg{color:var(--cm-accent)}
.cm-lp-card-head{display:flex;align-items:center;gap:7px;font-size:11.5px;font-weight:700;color:var(--cm-ink)}
.cm-lp-status{margin-left:auto;display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;background:var(--cm-bg);font-size:10.5px;font-weight:600;color:var(--cm-dim);font-family:"JetBrains Mono",ui-monospace,monospace}
.cm-lp-status::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.7}
.cm-lp-status[data-on=true]{color:var(--cm-accent);background:color-mix(in srgb,var(--cm-accent) 14%,transparent)}
.cm-lp-status[data-on=true]::before{opacity:1;box-shadow:0 0 0 3px color-mix(in srgb,var(--cm-accent) 25%,transparent)}
.cm-lp-card .cm-ai-detect-btn{margin-top:10px;background:var(--cm-accent-fill,var(--cm-accent));border-color:var(--cm-accent);color:var(--cm-accent-ink)}
.cm-lp-card .cm-ai-detect-btn svg{color:var(--cm-accent-ink)}
.cm-lp-card .cm-ai-detect-btn:hover{background:var(--cm-accent);filter:brightness(1.08)}
.cm-lp-card .cm-ai-detect-btn[data-busy=true],.cm-lp-card-row .cm-btn[data-busy=true]{opacity:.8;pointer-events:none}
.cm-lp-card-row{display:flex;gap:6px;margin-top:6px}
.cm-lp-card-row .cm-btn{flex:1;justify-content:center;font-size:11.5px}
.cm-lp-card-row .cm-btn[data-on=true]{border-color:var(--cm-accent);color:var(--cm-accent);background:color-mix(in srgb,var(--cm-accent) 10%,var(--cm-panel))}
.cm-lp-engine{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--cm-ink);margin-top:6px}
.cm-btn-spin{width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:cm-spin .7s linear infinite;flex:none}
@keyframes cm-spin{to{transform:rotate(360deg)}}
.cm-root[data-left-collapsed=true] .cm-left{padding:0;width:0;border:0}
.cm-side{border-left:1px solid var(--cm-line);background:var(--cm-panel);overflow:hidden;padding:14px;transition:padding .15s;display:flex;flex-direction:column;min-height:0;position:relative}
.cm-side-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;margin:0 -14px;padding:0 14px}
.cm-left{position:relative}
.cm-scroll-cue{position:absolute;left:0;right:8px;bottom:0;height:36px;cursor:pointer;z-index:3;
  background:linear-gradient(to bottom,transparent,var(--cm-panel) 75%);display:flex;align-items:flex-end;justify-content:center;padding-bottom:4px;
  opacity:0;pointer-events:none;transition:opacity .15s}
.cm-scroll-cue[data-show=true]{opacity:1;pointer-events:auto}
.cm-scroll-cue svg{color:var(--cm-dim-2);animation:cm-cue-bob 1.4s ease-in-out infinite}
@keyframes cm-cue-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(3px)}}
.cm-root[data-side-collapsed=true] .cm-side{padding:0;width:0;border:0}
.cm-left h4, .cm-side h4{margin:8px 0 6px;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--cm-dim)}
.cm-tabs{display:flex;align-items:stretch;gap:4px;margin:-14px -14px 14px;padding:0 10px;border-bottom:1px solid var(--cm-line-soft);flex:none}
/* Text tabs on one row: accent underline on the active one, a small accent dot on AI. No "color"
   in the transition: Chrome won't rerun it when the theme swaps custom properties. */
.cm-tabs button{all:unset;box-sizing:border-box;flex:1 1 auto;min-width:0;display:flex;align-items:center;justify-content:center;gap:6px;padding:15px 4px 12px;font-size:13px;font-weight:500;color:var(--cm-dim);white-space:nowrap;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:border-color .12s}
.cm-tabs button:hover{color:var(--cm-ink)}
.cm-tabs button[data-on=true]{color:var(--cm-accent);font-weight:600;border-bottom-color:var(--cm-accent)}
.cm-tabs button:focus-visible{outline:2px solid var(--cm-accent);outline-offset:-2px;border-radius:6px}
.cm-tabs .cm-tab-dot{width:6px;height:6px;border-radius:50%;background:var(--cm-accent);flex:none}
.cm-collapse-left,.cm-collapse{position:absolute;top:calc(50% + 24px);transform:translateY(-50%);width:20px;height:60px;padding:0;
  border:1px solid var(--cm-line);background:var(--cm-panel-2);color:var(--cm-dim-2);cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2;
  transition:left .18s cubic-bezier(.4,0,.2,1),right .18s cubic-bezier(.4,0,.2,1),border-color .12s,background .12s,width .12s}
.cm-collapse-left:hover,.cm-collapse:hover{color:var(--cm-accent-ink);border-color:var(--cm-accent);background:var(--cm-accent-fill,var(--cm-accent));width:22px}
.cm-collapse-left{left:346px;border-radius:0 8px 8px 0;border-left:none}
.cm-root[data-left-collapsed=true] .cm-collapse-left{left:56px}
.cm-collapse{right:322px;border-radius:8px 0 0 8px;border-right:none}
.cm-root[data-side-collapsed=true] .cm-collapse{right:0}
.cm-collapse-left[data-flip=true] svg,.cm-collapse[data-flip=true] svg{transform:rotate(180deg)}
.cm-align{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin:10px 0}
.cm-align button{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;height:28px;border-radius:7px;border:1px solid var(--cm-line);font-size:11px;color:var(--cm-ink)}
.cm-align button:hover{border-color:var(--cm-accent)}
.cm-toggle{all:unset;cursor:pointer;padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--cm-line);color:var(--cm-dim)}
.cm-toggle[data-on=true]{background:var(--cm-ink);color:var(--cm-panel);border-color:var(--cm-ink)}
/* status pill next to a section label (e.g. "Active") — small, quiet, accent-tinted */
.cm-status-pill{display:inline-flex;align-items:center;margin-left:auto;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--cm-accent) 16%,transparent);color:var(--cm-accent);font-size:9.5px;font-weight:700;letter-spacing:.04em;text-transform:none}
/* two-up checkbox row: "Snap to grid" / "Auto-detect" */
.cm-check-row{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:10px}
.cm-check-item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:7px;cursor:pointer;font-size:12px;font-weight:500;color:var(--cm-ink)}
.cm-check-item .box{flex-shrink:0;width:14px;height:14px;border-radius:4px;border:1px solid var(--cm-dim-2);display:flex;align-items:center;justify-content:center;color:transparent;transition:background .12s,border-color .12s}
.cm-check-item[data-on=true] .box{background:var(--cm-accent-fill,var(--cm-accent));border-color:var(--cm-accent);color:var(--cm-accent-ink)}
.cm-check-item:hover .box{border-color:var(--cm-accent)}
/* AI Vision Engine action: an accent-bordered, subtly glowing button so it reads as the "hero"
   action of its card rather than a plain .cm-btn */
.cm-ai-detect-btn{all:unset;box-sizing:border-box;cursor:pointer;width:100%;display:flex;align-items:center;justify-content:center;gap:8px;margin-top:10px;padding:10px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--cm-accent) 55%,transparent);background:color-mix(in srgb,var(--cm-accent) 14%,var(--cm-panel));color:var(--cm-ink);font-size:12.5px;font-weight:700;transition:background .12s,border-color .12s,transform .1s}
.cm-ai-detect-btn:hover{background:color-mix(in srgb,var(--cm-accent) 22%,var(--cm-panel));border-color:var(--cm-accent)}
.cm-ai-detect-btn:active{transform:translateY(.5px)}
.cm-ai-detect-btn svg{color:var(--cm-accent);flex-shrink:0}
/* quick colour-preset row next to the brush colour picker */
.cm-swatch-btn{all:unset;box-sizing:border-box;width:22px;height:22px;border-radius:50%;cursor:pointer;border:2px solid var(--cm-line);transition:transform .1s,border-color .1s}
.cm-swatch-btn:hover{transform:scale(1.1)}
.cm-swatch-btn[data-on=true]{border-color:var(--cm-ink)}
/* export dropdown menu (single "Export image" button in the header) */
.cm-export-anchor{position:relative}
.cm-export-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:60;min-width:208px;background:var(--cm-panel-2);border:1px solid var(--cm-line);border-radius:11px;padding:6px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.cm-export-menu-item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:8px 9px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--cm-ink);transition:background .1s}
.cm-export-menu-item:hover{background:var(--cm-bg)}
.cm-export-caret svg{transition:transform .12s}
.cm-export-btn[data-open=true] .cm-export-caret svg{transform:rotate(180deg)}
.cm-layer{position:relative;display:flex;align-items:center;gap:9px;padding:8px 9px 8px 6px;border-radius:10px;cursor:grab;font-size:12px;border:1px solid transparent;transition:background .1s;user-select:none}
.cm-layer:hover{background:var(--cm-bg)}
.cm-layer[data-on=true]{background:color-mix(in srgb,var(--cm-accent) 12%,var(--cm-bg));border-color:color-mix(in srgb,var(--cm-accent) 55%,transparent)}
.cm-layer[data-visible=false] .cm-layer-thumb,.cm-layer[data-visible=false] .cm-layer-meta{opacity:.4}
.cm-layer[data-dragover=true]{background:color-mix(in srgb,var(--cm-accent) 10%,var(--cm-panel))}
.cm-layer[data-dragover=true][data-drop=above]{box-shadow:inset 0 2px 0 var(--cm-accent)}
.cm-layer[data-dragover=true][data-drop=below]{box-shadow:inset 0 -2px 0 var(--cm-accent)}
.cm-layer[data-dragging=true]{opacity:.4}
.cm-lr-toggles{display:flex;flex:none}
.cm-lr-fold{all:unset;box-sizing:border-box;cursor:pointer;flex:none;width:16px;height:22px;margin:0 -5px 0 -3px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:var(--cm-dim)}
.cm-lr-fold:hover{color:var(--cm-ink);background:var(--cm-panel)}
.cm-lr-fold svg{transition:transform .12s}
.cm-layer[aria-expanded=false] .cm-lr-fold svg{transform:rotate(-90deg)}
.cm-layer-children{margin-left:16px;padding-left:4px;border-left:1px solid var(--cm-line)}
.cm-frame-head{display:flex;align-items:center;gap:6px;height:30px;margin:6px 0 2px;padding:0 8px 0 4px;border-radius:7px;cursor:pointer;color:var(--cm-dim-2);font-size:12px;font-weight:600}
.cm-frame-head:first-child{margin-top:0}
.cm-frame-head:hover{background:var(--cm-ctl);color:var(--cm-ink)}
.cm-frame-head[data-on=true]{color:var(--cm-ink);background:color-mix(in srgb,var(--cm-accent) 16%,transparent)}
.cm-frame-head[data-on=true] .cm-fh-ico,.cm-frame-head[data-on=true] .cm-fh-count{color:var(--cm-accent)}
.cm-frame-head[data-on=true]:hover{background:color-mix(in srgb,var(--cm-accent) 20%,transparent)}
.cm-fh-fold{all:unset;display:grid;place-items:center;width:18px;height:18px;border-radius:5px;cursor:pointer;color:var(--cm-dim-2)}
.cm-fh-fold[data-open=false] svg{transform:rotate(-90deg)}
.cm-fh-ico{display:grid;place-items:center;color:var(--cm-dim-2)}
.cm-fh-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-fh-count{font-size:10.5px;font-weight:500;color:var(--cm-dim-2);font-variant-numeric:tabular-nums}
.cm-frame-layers{margin-left:11px;padding-left:4px;border-left:1px solid var(--cm-line)}
.cm-frame-empty{padding:6px 10px 8px;font-size:11.5px;color:var(--cm-dim-2)}
.cm-layer[data-child=true]{padding-top:5px;padding-bottom:5px}
.cm-layer[data-child=true] .cm-layer-thumb{width:28px;height:28px;border-radius:7px}
.cm-layer .cm-eye{all:unset;box-sizing:border-box;cursor:pointer;width:20px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:5px;color:var(--cm-dim-2)}
.cm-layer .cm-eye:hover{color:var(--cm-ink);background:var(--cm-panel)}
.cm-layer .cm-eye[data-active=true]{color:var(--cm-accent)}
.cm-layer[data-on=true] .cm-eye{color:var(--cm-dim)}
.cm-layer-thumb{flex:none;width:34px;height:34px;border-radius:8px;overflow:hidden;display:grid;place-items:center;background:var(--cm-stage);border:1px solid var(--cm-line);color:var(--cm-dim)}
.cm-layer-thumb img{max-width:100%;max-height:100%;object-fit:contain;display:block;pointer-events:none}
.cm-layer-thumb[data-kind=text]{background:color-mix(in srgb,var(--cm-accent) 14%,var(--cm-bg));color:var(--cm-accent);font-weight:800;font-size:12px;letter-spacing:-.02em}
.cm-layer-thumb[data-tint]{background:color-mix(in srgb,var(--tile) 18%,var(--cm-bg));border-color:color-mix(in srgb,var(--tile) 55%,var(--cm-line));color:var(--tile)}
.cm-layer-meta{flex:1;min-width:0;line-height:1.3;display:flex;flex-direction:column}
.cm-layer-meta .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:12.5px;color:var(--cm-ink)}
.cm-layer-meta .sub{font-size:10.5px;color:var(--cm-dim-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.cm-layer-actions{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:flex;gap:1px;padding:2px;border-radius:8px;background:var(--cm-bg);box-shadow:-10px 0 10px -4px var(--cm-bg);opacity:0;pointer-events:none;transition:opacity .1s}
.cm-layer[data-on=true] .cm-layer-actions{background:color-mix(in srgb,var(--cm-accent) 12%,var(--cm-bg));box-shadow:-10px 0 10px -4px color-mix(in srgb,var(--cm-accent) 12%,var(--cm-bg))}
.cm-layer:hover .cm-layer-actions,.cm-layer:focus-within .cm-layer-actions{opacity:1;pointer-events:auto}
.cm-layer-actions button{all:unset;box-sizing:border-box;cursor:pointer;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:6px;color:var(--cm-dim)}
.cm-layer-actions button:hover{background:var(--cm-panel);color:var(--cm-ink)}
.cm-layer-actions button[data-active=true]{color:var(--cm-accent)}
.cm-layer-rename{all:unset;box-sizing:border-box;width:100%;font-size:12px;font-weight:600;padding:2px 5px;border-radius:5px;background:var(--cm-bg);border:1px solid var(--cm-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--cm-accent) 22%,transparent);color:var(--cm-ink)}
.cm-asset-thumb{flex:none;width:56px;cursor:pointer;text-align:center}
.cm-asset-thumb img{width:56px;height:56px;object-fit:cover;border-radius:9px;border:1px solid var(--cm-line);display:block;transition:border-color .1s;pointer-events:none}
.cm-asset-thumb span{display:block;font-size:10px;color:var(--cm-dim);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-asset-thumb:hover img{border-color:var(--cm-dim)}
.cm-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:8px 12px;border-radius:9px;border:1px solid var(--cm-line);font-size:13px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:7px;color:var(--cm-ink)}
.cm-btn[data-on=true]{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink);border-color:var(--cm-accent)}
/* colour inputs everywhere: the demo's 27x26 rounded swatch, not the browser's wide default */
.cm-root input[type=color]{width:27px;height:26px;border:none;background:none;border-radius:7px;overflow:hidden;cursor:pointer;padding:0}
.cm-root input[type=color]::-webkit-color-swatch-wrapper{padding:0}
.cm-root input[type=color]::-webkit-color-swatch{border:1px solid var(--cm-line);border-radius:7px}
.cm-btn:hover{border-color:var(--cm-dim-2);background:var(--cm-panel-2)}.cm-btn[data-on=true]:hover{background:var(--cm-accent)}.cm-btn:disabled{opacity:.4;cursor:default}
.cm-icon-btn{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:7px;border:1px solid var(--cm-line);color:var(--cm-ink)}
.cm-icon-btn:hover{border-color:var(--cm-accent)}
.cm-icon-btn[data-active=true]{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink);border-color:var(--cm-accent)}
.cm-top input[type=range]{width:90px}.cm-top input[type=color]{width:26px;height:26px;border:none;background:none;cursor:pointer}
.cm-voice-on{background:var(--cm-accent,#d4ff45)!important;color:#111!important}.cm-voice-cap{position:absolute;bottom:56px;right:16px;z-index:15;max-width:280px;padding:6px 12px;border-radius:10px;font-size:12px;background:var(--cm-bg);border:1px solid var(--cm-line);box-shadow:0 8px 24px rgba(0,0,0,.35);color:var(--cm-ink,inherit)}.cm-voice-cap.err{color:#ff6b6b}
/* Lives in the header now, so it is an inline control rather than a floating overlay: no
   absolute position and no drop shadow. Moving it also frees the canvas's bottom-right corner,
   which it used to sit on top of. */
.cm-zoom-pill{display:flex;align-items:center;gap:2px;flex:none;padding:3px;border-radius:999px;background:var(--cm-bg);border:1px solid var(--cm-line)}
.cm-zoom-pill .cm-icon-btn{width:24px;height:24px;border:none;background:none}
.cm-zoom-pct{min-width:46px;height:24px;justify-content:center;padding:0 6px;border:none;background:none;font-variant-numeric:tabular-nums}
.cm-zoom-div{width:1px;height:16px;background:var(--cm-line)}
/* header controls share one tighter corner radius (was 7-9px buttons and a fully round zoom pill) */
.cm-top .cm-btn,.cm-top .cm-icon-btn,.cm-top .cm-zoom-pill{border-radius:6px}
.cm-top .cm-zoom-pill .cm-btn,.cm-top .cm-zoom-pill .cm-icon-btn{border-radius:4px}
.cm-export-caret{display:flex;align-items:center}
/* Narrow headers keep only the percentage — clicking it still fits to screen, and the +/-/0
   shortcuts still work, so zoom stays reachable without crowding out Export. */
@media (max-width:980px){
  .cm-zoom-pill .cm-icon-btn,.cm-zoom-div{display:none}
  .cm-zoom-pill{border:none;background:none;padding:0}
}
.cm-cmdk-backdrop{position:fixed;inset:0;z-index:200;background:rgba(8,8,12,.5);display:flex;align-items:flex-start;justify-content:center;padding-top:14vh}
.cm-cmdk-box{width:min(560px,92vw);max-height:min(60vh,420px);background:var(--cm-panel);border:1px solid var(--cm-line);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.45);overflow:hidden;display:flex;flex-direction:column}
.cm-cmdk-search-row{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--cm-line);flex:none;color:var(--cm-dim)}
.cm-cmdk-input{all:unset;box-sizing:border-box;flex:1;font-size:14px;color:var(--cm-ink)}
.cm-tag{display:inline-flex;align-items:center;padding:2px 7px;border-radius:6px;background:var(--cm-bg);color:var(--cm-dim);font-size:10px;font-weight:600}
.cm-tag.mono{font-family:"JetBrains Mono",ui-monospace,monospace}
.cm-cmdk-list{overflow-y:auto;padding:6px;flex:1}
.cm-cmdk-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:12.5px;color:var(--cm-dim)}
.cm-cmdk-item[data-on=true]{background:var(--cm-bg);color:var(--cm-accent)}
.cm-cmdk-item .lbl{flex:1;color:var(--cm-ink)}
.cm-cmdk-item[data-on=true] .lbl{color:var(--cm-ink)}
.cm-cmdk-item .grp{font-size:10.5px;color:var(--cm-dim)}
.cm-cmdk-empty{padding:16px;text-align:center;font-size:12.5px;color:var(--cm-dim)}
.cm-compare-backdrop{position:fixed;inset:0;z-index:200;background:rgba(12,12,14,.95);backdrop-filter:blur(10px);display:flex;flex-direction:column}
.cm-compare-header{display:flex;align-items:flex-start;justify-content:space-between;padding:20px 28px;flex:none}
.cm-compare-header strong{font-size:16px;color:var(--cm-ink)}
.cm-compare-header p{font-size:13px;color:var(--cm-dim);margin:4px 0 0}
.cm-compare-panes{flex:1;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:minmax(0,1fr);gap:20px;padding:0 28px 28px;min-height:0}
.cm-compare-pane{position:relative;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--cm-stage);border:1px solid var(--cm-line);border-radius:12px;overflow:hidden;min-height:0}
.cm-compare-pane img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}
.cm-compare-label{position:absolute;top:14px;left:14px;background:var(--cm-panel);border:1px solid var(--cm-line);border-radius:999px;padding:4px 11px;font-size:11px;font-weight:600;color:var(--cm-dim)}
@media (max-width:640px){.cm-compare-panes{grid-template-columns:1fr;grid-template-rows:repeat(2,minmax(0,1fr))}}
.cm-extend-banner{all:unset;position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:16;display:flex;align-items:center;gap:7px;background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink);border-radius:999px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.cm-extend-banner:hover{filter:brightness(1.06)}
.cm-persp-bar{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:17;display:flex;align-items:center;gap:8px;background:var(--cm-panel);border:1px solid var(--cm-line);border-radius:12px;padding:8px 10px 8px 14px;font-size:12px;color:var(--cm-dim);box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:calc(100% - 32px)}
.cm-persp-bar .cm-btn{flex:0 0 auto}
.cm-persp-bar .cm-persp-apply{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink);border-color:var(--cm-accent)}
@media (max-width:900px){.cm-path-bar .cm-path-bar-hint{display:none}}
.cm-ai{display:flex;gap:6px;margin-top:6px}.cm-ai input{flex:1;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:7px;color:var(--cm-ink);padding:5px 8px;font-size:12px}
.cm-note{font-size:11px;color:var(--cm-dim);margin-top:6px;line-height:1.5}
/* Autosave readout — quiet when things are fine, amber when the document is too big to save (or
   storage is blocked), since that's the only case the user has to act on. */
.cm-iso-bar{display:flex;align-items:center;gap:8px;margin:-4px 0 10px;padding:7px 10px;border:1px solid var(--cm-line);border-radius:8px;font-size:11.5px;color:var(--cm-dim)}
.cm-iso-bar span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-iso-bar b{color:var(--cm-ink)}
.cm-props-title{font-family:"Bricolage Grotesque",inherit,sans-serif;font-size:15px;font-weight:600}
.cm-side-body .cm-field input,.cm-side-body .cm-select{border-radius:6px;height:34px;padding:0 10px}
.cm-side-body .cm-select{padding-right:34px}
.cm-side-body .cm-row .cm-icon-btn,.cm-side-body .cm-align button{height:32px;border-radius:6px;background:var(--cm-panel-2);border-color:var(--cm-line-soft);color:var(--cm-ink)}
.cm-side-body .cm-row .cm-icon-btn:hover,.cm-side-body .cm-align button:hover{border-color:var(--cm-dim-2)}
.cm-side-body .cm-btn{border-radius:6px}
.cm-side-body .cm-swatch-row{gap:10px}
.cm-side-body .cm-swatch-row input[type=color]{width:36px;height:34px;flex:none}
.cm-side-body .cm-swatch-row input[type=color]::-webkit-color-swatch{border-radius:6px}
.cm-side-body .cm-swatch-row input[type=color]::-moz-color-swatch{border-radius:6px}
.cm-side-body .cm-swatch-row>.cm-cv-fill{height:34px}
.cm-side-body .cm-swatch-row>.cm-hex{height:34px;box-sizing:border-box;padding:0 12px;border-radius:6px;font-size:12px}
.cm-seg{display:flex;gap:4px;padding:4px;border-radius:6px;border:1px solid var(--cm-line-soft);background:var(--cm-bg)}
.cm-seg .cm-btn{flex:1;padding:6px 8px;border:none;border-radius:4px;background:none;color:var(--cm-dim);font-weight:500}
.cm-seg .cm-btn:hover{background:none;color:var(--cm-ink)}
.cm-seg .cm-btn[data-on=true],.cm-seg .cm-btn[data-on=true]:hover{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink);font-weight:600}
.cm-props-footer{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 -14px -14px;padding:11px 14px;border-top:1px solid var(--cm-line);background:var(--cm-panel);font-size:11.5px;color:var(--cm-dim)}
.cm-props-footer b{font-weight:600;color:var(--cm-ink)}
.cm-props-footer b[data-locked=false]{color:var(--cm-ai-green)}
.cm-props-footer b[data-locked=true]{color:#f5a524}
.cm-font-anchor{position:relative}
.cm-font-pop{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:60;max-height:280px;overflow-y:auto;padding:6px;background:var(--cm-panel-2);border:1px solid var(--cm-line);border-radius:12px;box-shadow:var(--cm-shadow-md)}
.cm-font-grp-label{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--cm-dim-2);padding:8px 8px 4px}
.cm-font-grp-label:first-child{padding-top:2px}
.cm-font-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 9px;border-radius:7px;cursor:pointer;font-size:14px;color:var(--cm-ink)}
.cm-font-item:hover,.cm-font-item[data-on=true]{background:var(--cm-bg)}
.cm-font-add{position:sticky;bottom:-6px;display:flex;flex-wrap:wrap;gap:6px;margin:6px -6px -6px;padding:8px 6px 6px;border-top:1px solid var(--cm-line);background:var(--cm-panel-2)}
.cm-font-add input[type=text]{flex:1 1 120px;min-width:0;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:7px;padding:6px 8px;font-size:12px;color:var(--cm-ink)}
.cm-font-add .cm-btn{flex:none;padding:6px 10px;font-size:12px}
.cm-font-add .cm-btn[disabled]{opacity:.5;pointer-events:none}
.cm-font-item .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cm-font-item .ag{flex:none;font-size:13px;color:var(--cm-dim-2)}
.cm-hdiv{width:1px;height:20px;background:var(--cm-line);flex:none}
.cm-top > strong{font-family:"Bricolage Grotesque",inherit,sans-serif;font-size:14px!important;font-weight:700;letter-spacing:-.02em;flex:none}
@media (max-width:1180px){.cm-top{gap:10px;padding:0 12px}}
.cm-save-note{font-size:11px;color:var(--cm-dim-2);white-space:nowrap;flex:none;display:flex;align-items:center;gap:5px}
.cm-save-note::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--cm-dim-2)}
.cm-save-note[data-warn=true]{color:#e0a02a}
.cm-save-note[data-warn=true]::before{background:#e0a02a}
.cm-aix-status{display:flex;align-items:center;gap:8px;padding:11px 12px;border-radius:12px;border:1px solid var(--cm-line);background:var(--cm-panel-2)}
.cm-aix-dot{width:8px;height:8px;border-radius:50%;background:var(--cm-dim-2);flex:none}
.cm-aix-status[data-on=true] .cm-aix-dot{background:#3ecf8e;box-shadow:0 0 0 3px color-mix(in srgb,#3ecf8e 22%,transparent)}
.cm-aix-status b{font-size:13px;font-weight:700;color:var(--cm-ink)}
.cm-aix-badge{padding:2px 7px;border-radius:6px;font-size:10px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--cm-ai-green);background:color-mix(in srgb,#3ecf8e 12%,transparent);border:1px solid color-mix(in srgb,#3ecf8e 35%,transparent);white-space:nowrap}
.cm-aix-link{all:unset;margin-left:auto;display:flex;align-items:center;gap:4px;font-size:12px;color:var(--cm-dim);cursor:pointer;white-space:nowrap}
.cm-aix-link:hover{color:var(--cm-ink)}
.cm-aix-link svg{transform:rotate(180deg)}
.cm-aix-keyform{margin-top:10px;font-size:11.5px;line-height:1.55;color:var(--cm-dim)}
.cm-aix-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:20px 0 8px;font-size:13px;font-weight:700;color:var(--cm-ink)}
.cm-aix-h .aside{font-size:11.5px;font-weight:500;color:var(--cm-dim)}
.cm-aix-box{border-radius:12px;border:1px solid var(--cm-line);background:var(--cm-bg);padding:10px;transition:border-color .1s,box-shadow .1s}
.cm-aix-box:focus-within{border-color:var(--cm-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--cm-accent) 18%,transparent)}
.cm-aix-box textarea{all:unset;box-sizing:border-box;display:block;width:100%;min-height:72px;padding:2px 4px;font-size:12.5px;line-height:1.5;color:var(--cm-ink);white-space:pre-wrap;resize:none}
.cm-aix-box textarea::placeholder{color:var(--cm-dim-2)}
.cm-aix-foot{display:flex;align-items:center;gap:8px;margin-top:8px;padding-top:10px;border-top:1px solid var(--cm-line-soft)}
.cm-aix-pill{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;border:1px solid var(--cm-line);background:var(--cm-panel-2);color:var(--cm-ink);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}
.cm-aix-pill:hover{border-color:var(--cm-dim-2)}
.cm-aix-pill.enhance{margin-left:auto;color:var(--cm-ai-violet-ink);border-color:color-mix(in srgb,#8b5cf6 45%,transparent);background:color-mix(in srgb,#8b5cf6 14%,transparent)}
.cm-aix-pill.enhance:hover{background:color-mix(in srgb,#8b5cf6 22%,transparent);border-color:color-mix(in srgb,#8b5cf6 60%,transparent)}
.cm-aix-pill:disabled,.cm-aix-apply:disabled,.cm-aix-qa button:disabled,.cm-aix-chips button:disabled{opacity:.45;cursor:default;pointer-events:none}
.cm-aix-ref{display:flex;align-items:center;gap:6px;min-width:0;padding:3px 4px 3px 3px;border-radius:8px;border:1px solid var(--cm-line);background:var(--cm-panel-2);font-size:11.5px;color:var(--cm-ink)}
.cm-aix-ref img{width:22px;height:22px;border-radius:5px;object-fit:cover;flex:none}
.cm-aix-ref button{all:unset;display:flex;padding:2px;border-radius:4px;color:var(--cm-dim);cursor:pointer}
.cm-aix-ref button:hover{color:var(--cm-ink)}
.cm-aix-apply{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:12px;padding:11px 12px;border-radius:12px;font-size:13px;font-weight:700;color:#fff;cursor:pointer;background:linear-gradient(90deg,var(--cm-accent),color-mix(in srgb,var(--cm-accent) 45%,#6d28d9));box-shadow:0 6px 20px color-mix(in srgb,var(--cm-accent) 30%,transparent)}
.cm-aix-apply:hover{filter:brightness(1.07)}
.cm-aix-qa{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.cm-aix-qa button{all:unset;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px 6px 12px;border-radius:12px;border:1px solid var(--cm-line);background:var(--cm-panel-2);font-size:12px;font-weight:500;color:var(--cm-ink);cursor:pointer;text-align:center}
.cm-aix-qa button:hover{border-color:var(--cm-dim-2)}
.cm-aix-qa .ico{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center}
.cm-aix-qa [data-tint=blue] .ico{color:var(--cm-ai-blue);background:color-mix(in srgb,#3b82f6 18%,transparent)}
.cm-aix-qa [data-tint=purple] .ico{color:var(--cm-ai-violet);background:color-mix(in srgb,#8b5cf6 18%,transparent)}
.cm-aix-qa [data-tint=teal] .ico{color:var(--cm-ai-teal);background:color-mix(in srgb,#14b8a6 18%,transparent)}
.cm-aix-chips{display:flex;flex-wrap:wrap;gap:6px}
.cm-aix-chips button{all:unset;box-sizing:border-box;padding:6px 12px;border-radius:999px;border:1px solid var(--cm-line);background:var(--cm-panel-2);font-size:12px;color:var(--cm-ink);cursor:pointer}
.cm-aix-chips button:hover{border-color:var(--cm-dim-2)}
.cm-aix-chips button[data-on=true]{border-color:var(--cm-accent);color:var(--cm-accent);background:color-mix(in srgb,var(--cm-accent) 12%,var(--cm-panel-2))}
.cm-aix-msg{margin-top:10px;font-size:11.5px;line-height:1.5;color:var(--cm-accent)}
.cm-aix-msg[data-err=true]{color:var(--cm-danger,#f87171)}
.cm-aix-convert{margin-top:22px;padding:16px;border-radius:14px;border:1px solid var(--cm-line);background:var(--cm-panel-2)}
.cm-aix-convert-head{display:flex;align-items:flex-start;gap:12px}
.cm-aix-convert-head .ico{width:34px;height:34px;flex:none;border-radius:9px;display:flex;align-items:center;justify-content:center;color:var(--cm-ai-violet);background:color-mix(in srgb,#8b5cf6 18%,transparent);border:1px solid color-mix(in srgb,#8b5cf6 35%,transparent);margin-top:14px}
.cm-aix-convert-head .txt{flex:1;min-width:0}
.cm-aix-convert-head strong{display:block;font-size:13.5px;color:var(--cm-ink)}
.cm-aix-convert-head p{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--cm-dim)}
.cm-aix-guided{flex:none;padding:3px 7px;border-radius:6px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:10.5px;color:var(--cm-ai-teal);border:1px solid color-mix(in srgb,#14b8a6 40%,transparent);background:color-mix(in srgb,#14b8a6 10%,transparent)}
.cm-aix-primary,.cm-aix-secondary{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:10px 12px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer}
.cm-aix-primary{margin-top:16px;background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink)}
.cm-aix-primary:hover{filter:brightness(1.07)}
.cm-aix-secondary{margin-top:8px;border:1px solid var(--cm-line);background:var(--cm-bg);color:var(--cm-ink);font-weight:500}
.cm-aix-secondary:hover{border-color:var(--cm-dim-2)}
.cm-aix-primary:disabled,.cm-aix-secondary:disabled{opacity:.5;cursor:default;pointer-events:none}
.cm-aix-note{margin-top:14px;text-align:center;font-size:11px;line-height:1.5;color:var(--cm-dim-2)}
.cm-ai-card{margin-top:8px;padding:14px;border-radius:16px;border:1px solid var(--cm-line);background:var(--cm-panel-2)}
/* AI tab text inputs + key field: demo #aibox input */
.cm-ai-input,.cm-ai-key{box-sizing:border-box;width:100%;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:12px;color:var(--cm-ink);padding:9px 12px;font:inherit;font-size:13px}
.cm-ai-input:focus-visible,.cm-ai-key:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--cm-accent) 45%,transparent)}
/* sticker cells: demo .sticker-thumb — neutral glyphs in square cells */
.cm-sticker-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.cm-sticker-thumb{all:unset;box-sizing:border-box;cursor:pointer;aspect-ratio:1;border-radius:9px;border:1px solid var(--cm-line);background:var(--cm-bg);display:flex;align-items:center;justify-content:center;padding:10px;color:var(--cm-dim);transition:border-color .1s,background .1s}
.cm-sticker-thumb:hover{border-color:var(--cm-dim-2);background:var(--cm-panel-2)}
.cm-sticker-thumb svg{width:100%;height:100%}
.cm-ai-card-title{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;color:var(--cm-ink)}
.cm-ai-card p{margin:8px 0 0;font-size:12px;color:var(--cm-dim);line-height:1.55}
.cm-ai-textarea{width:100%;box-sizing:border-box;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:12px;color:var(--cm-ink);padding:10px 12px;font-size:13px;font-family:inherit;resize:vertical}
.cm-btn-accent{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink);border-color:var(--cm-accent)}
.cm-btn-accent:hover{opacity:.92;border-color:var(--cm-accent)}
.cm-key-hint{margin-left:6px;padding:1px 6px;border-radius:5px;font-size:10.5px;font-weight:600;background:color-mix(in srgb,var(--cm-accent-ink) 18%,transparent);opacity:.85}
.cm-btn-spin{display:inline-block;width:11px;height:11px;border-radius:50%;border:1.6px solid color-mix(in srgb,var(--cm-accent-ink) 35%,transparent);border-top-color:var(--cm-accent-ink);animation:cm-btn-spin .6s linear infinite;flex:none}
@keyframes cm-btn-spin{to{transform:rotate(360deg)}}
.cm-ai-suggestions{display:flex;flex-direction:column;gap:6px}
.cm-chip{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:7px 12px;border-radius:4px;border:1px solid var(--cm-line);font-size:11.5px;font-weight:600;color:var(--cm-ink);transition:border-color .1s,background .1s}
.cm-chip:hover{border-color:var(--cm-dim-2);background:var(--cm-panel-2)}
.cm-chip[data-on=true]{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink);border-color:var(--cm-accent)}
.cm-chip:focus-visible{outline:2px solid var(--cm-accent);outline-offset:1px}
.cm-chip[data-on=true]{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink);border-color:var(--cm-accent);font-weight:600}
/* Region boxes themselves are real Fabric objects rendered by <canvas> (role:'region', styled via
   REGION_COLOR inline — same as the vanilla demo) — this whole review panel is a side-panel
   overlay, not a canvas-space div overlay, so it doesn't need any absolutely-positioned box/handle
   CSS of its own. */
.cm-review-head{display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--cm-line)}
.cm-review-panel-body{display:flex;flex-direction:column;gap:8px}
.cm-eyebrow{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--cm-dim)}
.cm-col{display:flex;flex-direction:column}
.cm-dim{color:var(--cm-dim)}
.cm-text-input{width:100%;box-sizing:border-box;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:8px;color:var(--cm-ink);padding:7px 9px;font-size:12px;font-family:inherit}
.cm-grp{font-family:"Bricolage Grotesque",inherit,sans-serif;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cm-dim-2);margin:18px 3px 8px;padding-top:14px;border-top:1px solid var(--cm-line-soft)}
.cm-grp:first-child{margin-top:0;padding-top:0;border-top:none}
.cm-field-grid{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.cm-field{flex:1;min-width:60px;display:flex;flex-direction:column;gap:5px;font-size:10.5px;color:var(--cm-dim)}
.cm-field input{width:100%;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:7px;color:var(--cm-ink);padding:6px 8px;font-size:12px;font-family:inherit;box-sizing:border-box}
.cm-slider-row{display:flex;align-items:center;gap:10px;font-size:11.5px;color:var(--cm-dim);margin-top:6px}
.cm-slider-row input[type=range]{flex:1;width:auto}
.cm-slider-row .cm-val{min-width:34px;text-align:right;font-variant-numeric:tabular-nums;font-size:10.5px;color:var(--cm-ink)}
.cm-swatch-row{display:flex;align-items:center;gap:8px}
.cm-canvas-sec{padding-bottom:18px;margin-bottom:16px;position:relative}
.cm-canvas-sec::after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;border-radius:2px;background:var(--cm-line-soft)}
.cm-canvas-sec .cm-grp{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cm-canvas-sec .cm-grp .aside{font-family:inherit;font-size:11px;font-weight:500;letter-spacing:0;text-transform:none;color:var(--cm-dim)}
.cm-cv-link{all:unset;cursor:pointer;font-size:11px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--cm-accent)}
.cm-cv-link:hover{text-decoration:underline}
.cm-cv-link:disabled{opacity:.4;cursor:not-allowed;text-decoration:none}
.cm-cb-list{display:flex;flex-direction:column;gap:2px;margin-top:6px}
.cm-cb-item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;height:32px;padding:0 10px;border-radius:6px;color:var(--cm-ink);font-size:12.5px;font-weight:500;cursor:pointer;transition:background .1s}
.cm-cb-item svg{color:var(--cm-dim);flex:none}
.cm-cb-item:hover:not(:disabled){background:var(--cm-ctl)}
.cm-cb-item:hover:not(:disabled) svg{color:var(--cm-ink)}
.cm-cb-item:disabled{opacity:.38;cursor:not-allowed}
.cm-cb-hint{margin-top:6px;font-size:11.5px;line-height:1.4;color:var(--cm-dim-2)}
.cm-cb-hint:empty{display:none}
.cm-fr-bar{display:flex;gap:6px;margin:8px 0 4px}
.cm-fr-field{flex:1;min-width:0;display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border-radius:6px;background:var(--cm-ctl);border:1px solid transparent;color:var(--cm-dim-2);transition:border-color .1s,box-shadow .1s}
.cm-fr-field:hover{border-color:var(--cm-dim-2)}
.cm-fr-field:focus-within{border-color:var(--cm-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--cm-accent) 22%,transparent)}
.cm-fr-field input{all:unset;flex:1;min-width:0;font-size:12.5px;font-weight:600;color:var(--cm-ink)}
.cm-fr-btn{all:unset;box-sizing:border-box;flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:6px;background:var(--cm-ctl);color:var(--cm-dim);cursor:pointer;transition:background .1s,color .1s}
.cm-fr-btn:hover{background:var(--cm-ctl-hover);color:var(--cm-ink)}
.cm-fr-btn:disabled{opacity:.35;cursor:not-allowed;background:var(--cm-ctl);color:var(--cm-dim)}
.cm-frame-del:not(:disabled):hover{color:var(--cm-danger)}
.cm-cv-dims{display:flex;gap:8px}
.cm-cv-dim{flex:1;min-width:0;display:flex;align-items:center;gap:6px;padding:0 12px;height:40px;border-radius:6px;background:var(--cm-bg);border:1px solid var(--cm-line);font-size:12px;color:var(--cm-dim);transition:border-color .1s,box-shadow .1s}
.cm-cv-dim:hover{border-color:var(--cm-dim-2)}
.cm-cv-dim .cm-cv-dim-ico{display:grid;place-items:center;flex:none;color:var(--cm-dim-2)}
.cm-cv-dim:focus-within{border-color:var(--cm-accent);box-shadow:0 0 0 3px color-mix(in srgb, var(--cm-accent) 22%, transparent)}
.cm-cv-dim input{all:unset;flex:1;min-width:0;text-align:center;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:13px;font-weight:700;color:var(--cm-ink);-moz-appearance:textfield}
.cm-cv-dim input::-webkit-inner-spin-button,.cm-cv-dim input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.cm-field-row{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:11.5px;color:var(--cm-dim)}
.cm-field-row .cm-field-label{flex:0 0 36px;white-space:nowrap}
.cm-field-row .cm-field-box{flex:1;height:34px}
.cm-field-row .cm-field-box input{text-align:left;font-size:12px;font-weight:400}
.cm-paint-eye,.cm-field-icon-btn{all:unset;box-sizing:border-box;flex:none;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:7px;color:var(--cm-dim);cursor:pointer;transition:color .1s,background .1s}
.cm-paint-eye:hover,.cm-field-icon-btn:hover{color:var(--cm-ink);background:var(--cm-bg)}
.cm-paint-eye:focus-visible,.cm-field-icon-btn:focus-visible{box-shadow:0 0 0 2px var(--cm-accent)}
.cm-field-icon-btn[aria-expanded=true]{color:var(--cm-accent);background:color-mix(in srgb,var(--cm-accent) 12%,transparent)}
.cm-paint-eye[aria-disabled=true]{opacity:.35;pointer-events:none}
[data-paint-off=true]>:not(.cm-paint-eye){opacity:.45}
.cm-stroke-seg{flex:1;padding:3px}
.cm-stroke-seg .cm-btn{padding:5px 4px;font-size:11.5px}
.cm-field-row .cm-stroke-gap-label{flex:0 0 auto}
.cm-field-row+.cm-grp,.cm-field-row+div>.cm-grp:first-child{margin-top:14px}
.cm-cv-ratios{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px}
.cm-cv-ratios button{all:unset;box-sizing:border-box;text-align:center;padding:8px 0;border-radius:6px;border:1px solid var(--cm-line);background:var(--cm-bg);color:var(--cm-dim);font-size:11.5px;font-weight:600;cursor:pointer;transition:border-color .1s,color .1s,background .1s}
.cm-cv-ratios button:hover{color:var(--cm-ink);border-color:var(--cm-dim-2)}
.cm-cv-ratios button[data-on=true]{color:var(--cm-accent);border-color:color-mix(in srgb, var(--cm-accent) 60%, transparent);background:color-mix(in srgb, var(--cm-accent) 12%, var(--cm-bg))}
.cm-cv-swatch{position:relative;flex:none;width:40px;height:40px;border-radius:6px;overflow:hidden;border:1px solid var(--cm-line);background:repeating-conic-gradient(#d9d9de 0 25%, #ffffff 0 50%) 0 0/10px 10px}
.cm-cv-swatch>i{position:absolute;inset:0}
.cm-cv-swatch>input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
.cm-cv-fill{flex:1;min-width:0;display:flex;align-items:center;height:40px;padding:0 12px;border-radius:6px;background:var(--cm-bg);border:1px solid var(--cm-line);transition:border-color .1s}
.cm-cv-fill:focus-within{border-color:var(--cm-accent)}
.cm-swatch-row .cm-cv-fill .cm-hex{all:unset;flex:1;min-width:0;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;text-transform:uppercase;color:var(--cm-ink)}
.cm-cv-fill .pct{display:flex;align-items:center;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;color:var(--cm-dim)}
.cm-cv-fill .pct input{all:unset;width:28px;text-align:right;font-size:11px;color:var(--cm-dim);-moz-appearance:textfield}
.cm-cv-fill .pct input:focus{color:var(--cm-ink)}
.cm-cv-fill .pct input::-webkit-inner-spin-button,.cm-cv-fill .pct input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.cm-swatch-row .cm-hex{flex:1;min-width:0;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11.5px;text-transform:uppercase;padding:6px 8px;border-radius:8px;background:var(--cm-bg);border:1px solid var(--cm-line);color:var(--cm-ink)}
.cm-swatch-row .cm-hex:focus{outline:none;border-color:var(--cm-accent)}
.cm-adj-row{display:grid;grid-template-columns:14px 66px 1fr 36px;align-items:center;gap:8px;font-size:11.5px;color:var(--cm-dim);margin-top:6px}
.cm-adj-row>span.lbl{cursor:default;user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-adj-row input[type=range]{width:auto}
.cm-adj-row .val{text-align:right;font-variant-numeric:tabular-nums;font-size:10.5px;color:var(--cm-ink)}
.cm-adj-row .val.dim{color:var(--cm-dim)}
.cm-curves{margin-top:8px}
.cm-curves-tabs{display:flex;gap:4px;margin-bottom:6px}
.cm-curves-tabs button{flex:1;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:6px;color:var(--cm-dim);font:inherit;font-size:10.5px;font-weight:700;padding:4px 0;cursor:pointer}
.cm-curves-tabs button[data-on]{border-color:var(--cm-accent);color:var(--cm-ink)}
.cm-curves-tabs .cm-curves-reset{flex:0 0 28px;display:flex;align-items:center;justify-content:center}
.cm-curves-box{display:block;width:100%;aspect-ratio:1;background:var(--cm-bg);border:1px solid var(--cm-line);border-radius:8px;touch-action:none;cursor:crosshair;overflow:visible}
.cm-curves-box .grid{stroke:var(--cm-line);stroke-width:1;fill:none}
.cm-curves-presets{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}
.cm-curves-presets button{flex:1;background:none;border:1px solid var(--cm-line);border-radius:6px;color:var(--cm-dim);font:inherit;font-size:10.5px;padding:4px 6px;cursor:pointer}
.cm-curves-presets button:hover{color:var(--cm-ink);border-color:var(--cm-dim)}
.cm-disclose{display:flex;align-items:center;gap:8px;width:100%;background:none;border:none;padding:0;margin-top:12px;color:var(--cm-dim);font:inherit;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;opacity:.9}
.cm-disclose .dot{width:6px;height:6px;border-radius:50%;background:var(--cm-accent)}
.cm-subgrp{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--cm-dim);margin-top:12px;opacity:.8}
.cm-select{width:100%;background:var(--cm-bg);color:var(--cm-ink);border:1px solid var(--cm-line);border-radius:7px;padding:6px 8px;font-size:12px;font-family:inherit}
/* Own chevron instead of the native arrow (which Chrome pins ~4px from the edge whatever the
   padding): inset 12px from the right, with room reserved so long option text never runs under it.
   Mid-grey reads on both themes. */
.cm-select{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238b8b93' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:12px 12px;padding-right:34px;cursor:pointer}
.cm-row{display:flex;gap:6px}
.cm-row .cm-btn{flex:1;justify-content:center}
.cm-btn:disabled, .cm-icon-btn:disabled{opacity:.4;cursor:default;pointer-events:none}
.cm-props-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:48px 16px;color:var(--cm-dim)}
.cm-props-empty svg{color:var(--cm-line);margin-bottom:4px}
.cm-props-empty .h{font-size:12.5px;font-weight:700;color:var(--cm-ink)}
.cm-props-empty .d{font-size:11.5px;line-height:1.6;max-width:190px;color:var(--cm-dim)}
/* slider: thin neutral track (no progress fill), accent thumb with a white ring + soft glow; a slider
   can swap its track for a colour ramp via --cm-track (white balance, HSL bands) — same as the demo */
input[type=range]{width:110px;min-width:0;height:22px;-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer}
input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:var(--cm-track, var(--cm-line))}
input[type=range]::-moz-range-track{height:6px;border-radius:999px;background:var(--cm-track, var(--cm-line))}
input[type=range]::-moz-range-progress{background:transparent}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:18px;height:18px;margin-top:-6px;border-radius:50%;background:var(--cm-accent);border:3px solid #fff;box-sizing:border-box;box-shadow:0 0 0 4px color-mix(in srgb,var(--cm-accent) 22%,transparent),0 2px 6px rgba(0,0,0,.35);transition:transform .1s,box-shadow .1s}
input[type=range]::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:var(--cm-accent);border:3px solid #fff;box-sizing:border-box;box-shadow:0 0 0 4px color-mix(in srgb,var(--cm-accent) 22%,transparent),0 2px 6px rgba(0,0,0,.35);transition:transform .1s,box-shadow .1s}
input[type=range]:hover::-webkit-slider-thumb, input[type=range]:active::-webkit-slider-thumb{transform:scale(1.1)}
input[type=range]:hover::-moz-range-thumb, input[type=range]:active::-moz-range-thumb{transform:scale(1.1)}
input[type=range]:focus-visible{outline:none}
input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 5px color-mix(in srgb,var(--cm-accent) 40%,transparent),0 2px 6px rgba(0,0,0,.35)}
input[type=range]:focus-visible::-moz-range-thumb{box-shadow:0 0 0 5px color-mix(in srgb,var(--cm-accent) 40%,transparent),0 2px 6px rgba(0,0,0,.35)}
input[type=range]:disabled{cursor:default;opacity:.55}
input[type=range]:disabled::-webkit-slider-thumb{background:var(--cm-dim);box-shadow:none;transform:none}
input[type=range]:disabled::-moz-range-thumb{background:var(--cm-dim);box-shadow:none;transform:none}
/* Sliders + Adjust section, matched to the design mockup: a small solid thumb (no white ring/halo)
   on a thin track, tighter rows, mono readouts, quiet group labels, a custom Invert checkbox and a
   filled Reset button. Overrides the base slider rules above (same specificity, later wins). */
input[type=range]{height:18px}
input[type=range]::-webkit-slider-runnable-track{height:4px}
input[type=range]::-moz-range-track{height:4px}
input[type=range]::-webkit-slider-thumb{width:14px;height:14px;margin-top:-5px;border:none;box-shadow:0 1px 3px rgba(0,0,0,.45)}
input[type=range]::-moz-range-thumb{width:14px;height:14px;border:none;box-shadow:0 1px 3px rgba(0,0,0,.45)}
input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 4px color-mix(in srgb,var(--cm-accent) 35%,transparent)}
input[type=range]:focus-visible::-moz-range-thumb{box-shadow:0 0 0 4px color-mix(in srgb,var(--cm-accent) 35%,transparent)}
.cm-adj-row{grid-template-columns:16px 76px 1fr 40px;gap:10px;min-height:27px;margin-top:0;font-size:12.5px;color:var(--cm-ink)}
.cm-adj-row svg{color:var(--cm-dim)}
.cm-adj-row .val{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:11px;color:var(--cm-ink)}
.cm-adj-row .val.dim{color:var(--cm-ink);opacity:.85}
.cm-subgrp{font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--cm-dim-2);opacity:1;margin:14px 0 4px}
.cm-disclose{margin-top:14px;color:var(--cm-ink);font-size:11px;letter-spacing:.06em;gap:10px}
.cm-disclose svg{color:var(--cm-dim)}
.cm-adj-check-row{display:flex;align-items:center;gap:10px;margin-top:14px;font-size:12.5px;color:var(--cm-ink);cursor:pointer}
.cm-adj-check-row svg{color:var(--cm-dim)}
.cm-adj-check{-webkit-appearance:none;appearance:none;margin:0 0 0 auto;width:16px;height:16px;border-radius:4px;border:1px solid var(--cm-line);background:var(--cm-bg);cursor:pointer;display:grid;place-content:center;flex:none}
.cm-adj-check:checked{background:var(--cm-accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 8.5l2.5 2.5L12 5.5'/%3E%3C/svg%3E") center/12px no-repeat;border-color:var(--cm-accent)}
.cm-adj-check:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--cm-accent) 35%,transparent)}
.cm-btn.cm-adj-reset{margin-top:12px;width:100%;justify-content:center;padding:10px 12px;border-radius:6px;border-color:transparent;background:var(--cm-panel-2);font-weight:500}
.cm-btn.cm-adj-reset:hover{border-color:var(--cm-line);background:var(--cm-panel-2)}
/* === Visual refresh (mirrors the demo's): neutral greys, one UI typeface, sentence-case section
   labels, flat filled controls at one height (30px) and radius (6px), thin sliders, compact layer
   rows. Only looks change; every class and behaviour above stays. === */
.cm-root, .cm-root[data-cm-mode=dark]{
  --cm-bg:#141416; --cm-panel:#1b1b1e; --cm-panel-2:#26262a; --cm-line:rgba(255,255,255,.08); --cm-line-soft:rgba(255,255,255,.05);
  --cm-ink:#ececee; --cm-dim:#a1a1aa; --cm-dim-2:#8d8d97; --cm-accent:#3b82f6; --cm-accent-fill:#2c6fe6; --cm-accent-ink:#fff; --cm-stage:#111113;
  --cm-ctl:#232327; --cm-ctl-hover:#2b2b30; --cm-track-bg:#38383e; --cm-seg-on:#3a3a40;
  --cm-shadow-sm:0 1px 2px rgba(0,0,0,.3); --cm-shadow-md:0 6px 20px rgba(0,0,0,.35); --cm-shadow-lg:0 16px 48px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.06);
}
.cm-root[data-cm-mode=light]{
  --cm-bg:#f4f4f5; --cm-panel:#ffffff; --cm-panel-2:#f1f1f3; --cm-line:rgba(9,9,11,.09); --cm-line-soft:rgba(9,9,11,.06);
  --cm-ink:#18181b; --cm-dim:#52525b; --cm-dim-2:#6b6b75; --cm-accent:#2563eb; --cm-accent-fill:#2563eb; --cm-accent-ink:#fff; --cm-stage:#e8e8eb;
  --cm-ctl:#f1f1f3; --cm-ctl-hover:#e9e9ec; --cm-track-bg:#d9d9de; --cm-seg-on:#ffffff;
  --cm-shadow-sm:0 1px 2px rgba(9,9,11,.06); --cm-shadow-md:0 6px 20px rgba(9,9,11,.08); --cm-shadow-lg:0 16px 48px rgba(9,9,11,.14),0 0 0 1px rgba(9,9,11,.06);
}
.cm-root{font:12.5px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;letter-spacing:-.003em;grid-template-rows:46px 1fr}
.cm-grp,.cm-props-title,.cm-layer-meta .nm{font-family:inherit}
/* header */
.cm-top{gap:10px;padding:0 12px}
.cm-top .cm-btn{height:28px;padding:0 10px;border:none;border-radius:6px;background:transparent;color:var(--cm-dim);font-weight:500;font-size:12px;gap:6px}
.cm-top .cm-btn:hover{background:var(--cm-ctl);color:var(--cm-ink)}
.cm-top .cm-btn-accent,.cm-top .cm-btn-accent:hover{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink)}
.cm-top .cm-btn-accent:hover{filter:brightness(1.08)}
.cm-top .cm-icon-btn{border:none;border-radius:6px;color:var(--cm-dim)}
.cm-top .cm-icon-btn:hover{background:var(--cm-ctl);color:var(--cm-ink)}
.cm-zoom-pill{background:var(--cm-ctl);border:none;border-radius:6px;padding:2px;height:28px;box-sizing:border-box}
.cm-zoom-pill .cm-icon-btn:hover{background:var(--cm-ctl-hover)}
/* rail */
.cm-rail-btn{width:36px;height:34px;border-radius:7px}
.cm-rail-btn:hover{background:var(--cm-ctl)}
.cm-rail-btn[data-on=true]{background:color-mix(in srgb,var(--cm-accent) 18%,transparent);color:var(--cm-accent)}
.cm-rail-btn[data-on=true] .cm-rail-caret{border-bottom-color:var(--cm-accent)}
.cm-rail-caret{border-bottom-color:var(--cm-dim-2)}
/* tabs */
.cm-lp-tab,.cm-tabs button{font-size:12px;font-weight:500;color:var(--cm-dim-2);padding:12px 4px 10px}
.cm-lp-tab[aria-selected=true],.cm-tabs button[data-on=true]{color:var(--cm-ink);font-weight:600;border-bottom-color:var(--cm-accent)}
.cm-tabs{gap:2px;border-bottom-color:var(--cm-line)}
.cm-lp-count{background:var(--cm-ctl)}
/* section labels */
.cm-grp{font-size:11.5px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--cm-ink);margin:14px 0 8px;padding-top:14px;border-top:1px solid var(--cm-line-soft)}
.cm-grp:first-child{margin-top:0;padding-top:0;border-top:none}
.cm-dock-head{font-size:11.5px;letter-spacing:0;text-transform:none;color:var(--cm-ink);font-weight:600}
.cm-dock::after{height:1px;background:var(--cm-line-soft)}
.cm-canvas-sec{padding-bottom:6px;margin-bottom:16px;border-bottom:1px solid var(--cm-line-soft)}
.cm-canvas-sec::after{display:none}
.cm-canvas-sec .aside{color:var(--cm-dim-2)}
.cm-props-title{font-size:13px;font-weight:600}
.cm-eyebrow{font-size:11px;letter-spacing:0;text-transform:none;color:var(--cm-dim-2)}
.cm-field,.cm-field-row{font-size:11px;font-weight:500;color:var(--cm-dim)}
.cm-slider-row{font-size:11.5px}
.cm-slider-row .cm-val,.cm-slider-row .cm-tag{font-family:inherit;font-size:11px;color:var(--cm-dim);background:none;padding:0;min-width:34px;justify-content:flex-end}
.cm-note{font-size:11px;color:var(--cm-dim-2)}
.cm-subgrp{font-size:11px;font-weight:500;letter-spacing:0;text-transform:none;color:var(--cm-dim-2);margin:12px 0 4px;opacity:1}
.cm-disclose{font-size:11.5px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--cm-ink)}
.cm-adj-row .val{font-family:inherit;font-size:11px;color:var(--cm-dim)}
/* buttons */
.cm-btn{height:30px;padding:0 10px;border:none;border-radius:6px;background:var(--cm-ctl);font-weight:500;font-size:12px;gap:6px}
.cm-btn:hover{border:none;background:var(--cm-ctl-hover)}
.cm-btn-accent,.cm-btn[data-on=true]{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink)}
.cm-btn-accent:hover,.cm-btn[data-on=true]:hover{background:var(--cm-accent);filter:brightness(1.08)}
.cm-chip{padding:5px 10px;border:none;border-radius:6px;background:var(--cm-ctl);font-size:11.5px;font-weight:500}
.cm-chip:hover{border:none;background:var(--cm-ctl-hover)}
.cm-chip[data-on=true]{background:var(--cm-accent-fill,var(--cm-accent));color:var(--cm-accent-ink)}
.cm-icon-btn{border:none;border-radius:6px;background:var(--cm-ctl)}
.cm-icon-btn:hover{border:none;background:var(--cm-ctl-hover)}
.cm-icon-btn[data-active=true]{background:color-mix(in srgb,var(--cm-accent) 18%,var(--cm-ctl));color:var(--cm-accent)}
.cm-zoom-pill .cm-icon-btn{background:none}
.cm-align{gap:4px}
.cm-align button{height:28px;border:none;border-radius:6px;background:var(--cm-ctl);color:var(--cm-dim)}
.cm-align button:hover{border:none;background:var(--cm-ctl-hover);color:var(--cm-ink)}
.cm-seg{gap:2px;padding:2px;border:none;border-radius:7px;background:var(--cm-ctl)}
.cm-seg .cm-btn{height:26px;background:none;border-radius:5px;font-size:11.5px}
.cm-seg .cm-btn[data-on=true],.cm-seg .cm-btn[data-on=true]:hover{background:var(--cm-seg-on);color:var(--cm-ink);box-shadow:var(--cm-shadow-sm);filter:none;font-weight:600}
.cm-cv-ratios{gap:4px}
.cm-cv-ratios button{padding:6px 0;border:none;border-radius:6px;background:var(--cm-ctl);font-weight:500;font-size:11.5px}
.cm-cv-ratios button:hover{border:none;background:var(--cm-ctl-hover)}
.cm-cv-ratios button[data-on=true]{background:color-mix(in srgb,var(--cm-accent) 18%,var(--cm-ctl));color:var(--cm-accent)}
.cm-status-pill{font-size:10px;font-weight:600;padding:1px 7px;letter-spacing:0;text-transform:none}
.cm-tag{border-radius:5px;background:var(--cm-ctl)}
.cm-curves-tabs button,.cm-curves-presets button{border:none;background:var(--cm-ctl)}
.cm-curves-tabs button[data-on]{background:color-mix(in srgb,var(--cm-accent) 18%,var(--cm-ctl))}
/* inputs */
.cm-field input,.cm-side-body .cm-field input,.cm-side-body .cm-select,.cm-select,.cm-text-input,.cm-swatch-row .cm-hex{height:30px;padding:0 9px;border:1px solid transparent;border-radius:6px;background-color:var(--cm-ctl);font-size:12px}
.cm-field input:hover,.cm-select:hover,.cm-text-input:hover,.cm-swatch-row .cm-hex:hover{border-color:var(--cm-line)}
.cm-field input:focus,.cm-select:focus,.cm-text-input:focus,.cm-swatch-row .cm-hex:focus{outline:none;border-color:var(--cm-accent);box-shadow:none}
.cm-cv-dim,.cm-cv-fill{height:32px;padding:0 10px;border:1px solid transparent;border-radius:6px;background:var(--cm-ctl)}
.cm-cv-dim:hover,.cm-cv-fill:hover{border-color:var(--cm-line)}
.cm-cv-dim:focus-within,.cm-cv-fill:focus-within{border-color:var(--cm-accent);box-shadow:none}
.cm-cv-dim input{font-family:inherit;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.cm-cv-fill .hex,.cm-cv-fill .pct,.cm-cv-fill .pct input,.cm-swatch-row .cm-hex{font-family:inherit;font-variant-numeric:tabular-nums}
.cm-cv-swatch{width:32px;height:32px}
.cm-field-row .cm-field-box{height:30px}
.cm-root input[type=color]{width:24px;height:24px;border-radius:5px}
.cm-swatch-btn{width:18px;height:18px;border-width:1px;border-color:var(--cm-line)}
.cm-swatch-btn[data-on=true]{box-shadow:0 0 0 2px var(--cm-panel),0 0 0 3.5px var(--cm-accent);border-color:transparent}
/* sliders */
.cm-root input[type=range]{height:18px}
.cm-root input[type=range]::-webkit-slider-runnable-track{height:3px !important;background:var(--cm-track,var(--cm-track-bg))}
.cm-root input[type=range]::-moz-range-track{height:3px !important;background:var(--cm-track,var(--cm-track-bg))}
.cm-root input[type=range]::-webkit-slider-thumb{width:12px;height:12px;margin-top:-4.5px;border:none;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.25),0 1px 3px rgba(0,0,0,.3)}
.cm-root input[type=range]::-moz-range-thumb{width:12px;height:12px;border:none;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.25),0 1px 3px rgba(0,0,0,.3)}
/* layers */
.cm-layer{gap:8px;padding:5px 8px 5px 4px;border-radius:6px;border:none}
.cm-layer:hover{background:var(--cm-ctl)}
.cm-layer[data-on=true]{background:color-mix(in srgb,var(--cm-accent) 16%,transparent);border:none}
.cm-layer-thumb{width:28px;height:28px;border-radius:5px;border:1px solid var(--cm-line-soft)}
.cm-layer-thumb[data-kind=text]{font-size:11px;font-weight:700}
.cm-layer-meta .nm{font-weight:500;font-size:12px}
.cm-layer-meta .sub{margin-top:0}
.cm-layer-actions{background:var(--cm-panel);box-shadow:-10px 0 10px -4px var(--cm-panel);border-radius:6px}
.cm-layer:hover .cm-layer-actions{background:var(--cm-ctl);box-shadow:-10px 0 10px -4px var(--cm-ctl)}
.cm-layer[data-on=true] .cm-layer-actions{background:color-mix(in srgb,var(--cm-accent) 16%,var(--cm-panel));box-shadow:-10px 0 10px -4px color-mix(in srgb,var(--cm-accent) 16%,var(--cm-panel))}
.cm-layer-actions button:hover,.cm-layer .cm-eye:hover{background:var(--cm-ctl-hover)}
.cm-lp-toolbar{padding:8px 10px}
.cm-lp-tbtn{width:28px;height:28px;border-radius:6px}
.cm-lp-tbtn:hover:not(:disabled){background:var(--cm-ctl)}
/* menus */
.cm-export-menu,.cm-rail-flyout,.cm-font-pop,.cm-lp-menu{background:var(--cm-panel);border:none;border-radius:10px;box-shadow:var(--cm-shadow-lg)}
.cm-rail-flyout-item:hover,.cm-rail-flyout-item[data-on=true],.cm-lp-menu button:hover{background:var(--cm-ctl)}
.cm-cmdk-box{border:none;border-radius:12px;box-shadow:var(--cm-shadow-lg)}
.cm-cmdk-item{border-radius:6px}
.cm-cmdk-item[data-on=true]{background:var(--cm-ctl)}
.cm-cmdk-item .grp{margin:0;padding:0;border:none;font-size:11px;font-weight:500;color:var(--cm-dim-2)}

/* Slider rows: the label is a bare text node, so tracks began at different x. A shared label column aligns them. */
.cm-side-body .cm-slider-row:has(>input[type=range]+.cm-val),.cm-side-body .cm-slider-row:has(>input[type=range]+.cm-tag){display:grid;grid-template-columns:6.6em minmax(0,1fr) auto;column-gap:8px;align-items:center}
.cm-match-row{margin:6px 0 2px}
.cm-match-select{flex:1;min-width:0;height:28px;padding:0 8px;border-radius:6px;background:var(--cm-ctl);color:var(--cm-ink);border:1px solid transparent;font:inherit;font-size:12px}
.cm-match-select:hover{border-color:var(--cm-line)}.cm-match-select:focus-visible{outline:none;border-color:var(--cm-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--cm-accent) 45%,transparent)}
.cm-prop-jump{position:sticky;top:-1px;z-index:6;display:flex;gap:4px;flex-wrap:wrap;margin:0 0 10px;padding:8px 0;background:var(--cm-panel);border-bottom:1px solid var(--cm-line-soft,var(--cm-line))}
.cm-prop-jump button{all:unset;box-sizing:border-box;cursor:pointer;padding:4px 9px;border-radius:999px;font-size:11.5px;font-weight:500;color:var(--cm-dim);background:var(--cm-ctl);border:1px solid transparent}
.cm-prop-jump button:hover{color:var(--cm-ink);border-color:var(--cm-line)}.cm-prop-jump button:focus-visible{outline:none;color:var(--cm-ink);box-shadow:0 0 0 2px color-mix(in srgb,var(--cm-accent) 45%,transparent)}
.cm-side-body .cm-grp[id]{scroll-margin-top:52px}
`;

/* Tone-curve editor: channel tabs, histogram backdrop, click to add a point, drag to move, double-
   click (or drag it out of the box) to delete. All point rules live in core (tone.js's curve*
   helpers) — this only maps pointer coords into curve space and draws. Same behaviour as the
   vanilla demo's curves editor. onChange(curves, live) fires per move with live=true; onCommit()
   fires once on release so one drag is one undo step. */
const CURVE_COLORS = { rgb: 'var(--cm-ink)', r: '#e5484d', g: '#30a46c', b: '#3e63dd' };
const CURVE_LABELS = { rgb: 'RGB', r: 'R', g: 'G', b: 'B' };
const CURVE_PRESETS = [
  ['Linear', null],
  ['Contrast', { rgb: [[0, 0], [64, 48], [192, 208], [255, 255]] }],
  ['Fade', { rgb: [[0, 36], [128, 132], [255, 236]] }],
  ['Brighten', { rgb: [[0, 0], [110, 150], [255, 255]] }],
];
function CurvesEditor({ curves, histogram, onChange, onCommit }) {
  const [ch, setCh] = useState('rgb');
  const svgRef = useRef(null), drag = useRef(null);
  const all = normalizeCurves(curves), pts = all[ch];
  const toCurve = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * 255, y: 255 - (e.clientY - r.top) / r.height * 255, tol: 10 * 255 / r.width };
  };
  const emit = (next, live) => onChange(compactCurves({ ...all, [ch]: next }), live);
  const down = (e) => {
    const { x, y, tol } = toCurve(e);
    let index = curveHitTest(pts, x, y, tol), base = pts;
    if (index < 0) {
      const ins = curveInsertPoint(pts, x, y);
      if (ins.index < 0) return;
      index = ins.index; base = ins.points; emit(base, true);
    }
    drag.current = { index, base };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current; if (!d) return;
    const { x, y } = toCurve(e);
    const interior = d.index > 0 && d.index < d.base.length - 1;
    emit(interior && (y < -24 || y > 279) ? curveRemovePoint(d.base, d.index) : curveMovePoint(d.base, d.index, x, y), true);
  };
  const up = () => { if (drag.current) { drag.current = null; onCommit(); } };
  const dbl = (e) => {
    const { x, y, tol } = toCurve(e);
    const i = curveHitTest(pts, x, y, tol);
    if (i > 0 && i < pts.length - 1) { emit(curveRemovePoint(pts, i), true); onCommit(); }
  };
  const histPath = histogram ? 'M0 256' + Array.from(histogram, (v, i) => `L${i} ${256 - v * 240}`).join('') + 'L255 256Z' : null;
  return (
    <div className="cm-curves">
      <div className="cm-curves-tabs" role="tablist">
        {CURVE_CHANNELS.map(c => (
          <button key={c} role="tab" aria-selected={ch === c} data-on={ch === c ? '1' : undefined} onClick={() => setCh(c)}
            style={{ color: c === 'rgb' ? undefined : CURVE_COLORS[c] }}>{CURVE_LABELS[c]}</button>
        ))}
        <button className="cm-curves-reset" title={'Reset ' + CURVE_LABELS[ch] + ' curve'} onClick={() => { emit([[0, 0], [255, 255]], true); onCommit(); }}><Icon name="reset" size={12} /></button>
      </div>
      <svg ref={svgRef} viewBox="0 0 256 256" className="cm-curves-box" aria-label={CURVE_LABELS[ch] + ' tone curve'}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={dbl}>
        {histPath && <path d={histPath} fill="var(--cm-dim)" opacity=".22" />}
        {[64, 128, 192].map(v => <React.Fragment key={v}><path d={`M${v} 0V256`} className="grid" /><path d={`M0 ${v}H256`} className="grid" /></React.Fragment>)}
        <path d="M0 256L256 0" className="grid" strokeDasharray="3 4" />
        {CURVE_CHANNELS.filter(c => c !== ch && curves && curves[c]).map(c => <path key={c} d={curveSvgPath(all[c], 256)} fill="none" stroke={CURVE_COLORS[c]} strokeWidth="1" opacity=".45" />)}
        <path d={curveSvgPath(pts, 256)} fill="none" stroke={CURVE_COLORS[ch]} strokeWidth="2" />
        {pts.map(([x, y], i) => <circle key={i} cx={x * 256 / 255} cy={256 - y * 256 / 255} r="5" fill="var(--cm-panel)" stroke={CURVE_COLORS[ch]} strokeWidth="2" />)}
      </svg>
      <div className="cm-curves-presets">
        {CURVE_PRESETS.map(([label, preset]) => <button key={label} onClick={() => { onChange(preset, true); onCommit(); }}>{label}</button>)}
      </div>
    </div>
  );
}

/* Per-band HSL mixer (Lightroom's layout): pick Hue / Saturation / Luminance, then one slider per
   colour band, each track previewing its own effect. Values and the stored shape are core's
   (tone.js setHslValue/hslBandTrack) — same as the vanilla demo's mixer. */
function HslMixer({ hsl, onChange, onCommit }) {
  const [prop, setProp] = useState('s');
  return (
    <div className="cm-curves">
      <div className="cm-curves-tabs" role="tablist">
        {HSL_PROPS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={prop === k} data-on={prop === k ? '1' : undefined} onClick={() => setProp(k)}>{label}</button>
        ))}
        <button className="cm-curves-reset" title="Reset colour mixer" onClick={() => { onChange(null, true); onCommit(); }}><Icon name="reset" size={12} /></button>
      </div>
      {HSL_BANDS.map(([band, deg]) => {
        const v = getHslValue(hsl, band, prop), label = hslBandLabel(band);
        return (
          <div key={band} className="cm-adj-row" title={label + ' — double-click to reset'} onDoubleClick={() => { onChange(setHslValue(hsl, band, prop, 0), true); onCommit(); }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: `hsl(${deg} 75% 52%)`, justifySelf: 'center' }} />
            <span className="lbl">{label}</span>
            <input type="range" aria-label={label + ' ' + prop} min="-100" max="100" step="1" value={v}
              style={{ '--cm-track': hslBandTrack(band, prop) }}
              onChange={e => onChange(setHslValue(hsl, band, prop, +e.target.value), true)} onPointerUp={onCommit} onKeyUp={onCommit} />
            <span className={'val' + (v ? '' : ' dim')}>{(v > 0 ? '+' : '') + v}</span>
          </div>
        );
      })}
    </div>
  );
}

export function CanvasmithEditor({ fabric, width = 1080, height = 1080, image = null, ai = 'gemini', theme = {}, mode, bridge = true, autosave = true, openCvUrl, onReady, onExport }) {
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const rootRef = useRef(null);
  const leftRef = useRef(null);
  const sideRef = useRef(null);
  const edRef = useRef(null);
  const [tool, setTool] = useState('select');
  const [cropChip, setCropChip] = useState('Free');
  const [keepRatio, setKeepRatio] = useState(true);   // Transform's "Keep proportions" for W/H edits
  const [opts, setOpts] = useState({ size: 30, opacity: 1, hardness: 0.7, color: '#000000', tolerance: 32, bucketTolerance: 32, addMode: false, gradientType: 'linear', gradientStops: [{ offset: 0, color: '#ef6a2d' }, { offset: 1, color: '#7c3aed' }], cropRatio: 0, paintNewLayer: false });
  const [layers, setLayers] = useState([]);
  const [frames, setFrames] = useState([]);
  const [canvasInfo, setCanvasInfo] = useState({ W: 1080, H: 1080, bg: { color: '#ffffff', alpha: 1, transparent: false } });
  // Group rows folded shut in the layers panel — panel state only, not document state (default: open).
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [collapsedFrames, setCollapsedFrames] = useState(() => new Set());   // frame folders folded shut in the Layers panel
  // Layer-panel thumbnails: generated on demand from the fabric object itself (toDataURL at a
  // small multiplier), cached per layer id and invalidated on every scene change — same
  // version-keyed cache contract as the vanilla demo's layerThumb/_thumbVer, since the headless
  // Editor's layers() API is deliberately thumbnail-free (DOM/canvas rendering is a host concern).
  const thumbCacheRef = useRef(new Map());
  const thumbVerRef = useRef(0);
  const [renamingId, setRenamingId] = useState(null);
  const [dragLayerId, setDragLayerId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [dropBelow, setDropBelow] = useState(false);
  const lastLayerClickRef = useRef(null);
  // Compare: snapshot the canvas the first time it's ever committed to (i.e. right after the
  // first image/element lands), then let the user flip back to that snapshot vs. the live render
  // at any point — canvasmith has no fixed "original ad template" the way the reference does, so
  // "first meaningful state" is the closest general equivalent. Ports the vanilla demo's Compare
  // view exactly. The snapshot lives in a ref (not state) so capturing it inside the 'change'
  // handler below doesn't itself trigger a re-render loop.
  const compareSnapshotRef = useRef(null);
  const [compareReady, setCompareReady] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareAfter, setCompareAfter] = useState(null);
  // Asset tray: every image source successfully added to the document this session (opened,
  // dropped/pasted, picked via the file input, or handed in via the bridge/postMessage import) —
  // click or drag one back onto the canvas to insert it again. A generic library has no
  // "generated ad" / "product photo" asset taxonomy of its own the way a specific ad-generation
  // product would, so this tracks exactly what the user has actually brought into THIS document
  // rather than inventing categories. Persisted with the scene by the autosave below, in the
  // same stored record, so it comes back with the document it belongs to.
  // Deduped by src so re-adding the same image doesn't grow the tray forever.
  const [assets, setAssets] = useState([]);
  const trackAsset = useCallback((src, name) => {
    setAssets(prev => prev.some(a => a.src === src) ? prev : [...prev, { id: 'asset' + Date.now() + Math.random().toString(36).slice(2, 6), src, name: name || 'Image' }]);
  }, []);
  // Mirror of `assets` for the autosave's getExtras: that callback is created once inside the
  // mount effect, so reading the state variable there would capture the empty array from mount.
  const assetsRef = useRef(assets);
  useEffect(() => { assetsRef.current = assets; }, [assets]);
  // Autosave handle + its last status ('ok' | 'ok-trimmed' | 'failed' | 'unavailable'), so the
  // header can warn when a document cannot be stored rather than quietly not saving it.
  const sessionRef = useRef(null);
  /* Multi-document tabs: core/docs.js owns the documents; this is just the strip's state. */
  const docsRef = useRef(null);
  const [docTabs, setDocTabs] = useState([{ id: 'd0', name: 'Untitled 1', active: true }]);
  const [renamingTab, setRenamingTab] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null);
  /* Export scale. The core always supported a multiplier (Editor#exportPNG(mult)) but the UI
     hardcoded 1x, so every export came out at artboard size — soft on retina, unusable for
     print, with nothing explaining why. SVG ignores it (vector has no pixel scale). */
  const [exportScale, setExportScale] = useState(1);
  /* Transient confirmations with an optional action. Exists mainly so New can offer an Undo
     after the fact — a confirm() can only ask beforehand, which people click through. */
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  // Border's advanced rows (style / align / caps / join) — shut until the settings button opens them.
  const [strokeAdvOpen, setStrokeAdvOpen] = useState(false);
  const [maskRefine, setMaskRefine] = useState(null);   // Keep/Remove touch-up brush ('keep'|'remove'|null)
  const toast = useCallback((message, action) => {
    const id = ++toastIdRef.current;
    setToasts(t => [...t, { id, message, action }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), action ? 12000 : 4000);
    return id;
  }, []);
  const dismissToast = useCallback((id) => setToasts(t => t.filter(x => x.id !== id)), []);
  // Only intercept our own asset drag payload — an unrelated drag (a real OS file, which
  // installDropImport already handles) must fall through untouched, same guard the vanilla
  // demo's onStageDragOver uses.
  const onStageDragOver = (e) => {
    const t = e.dataTransfer.types;
    if (t.includes('text/x-canvasmith-asset') || t.includes('Files')) e.preventDefault();
  };
  /* Visible drop affordance. dragenter/dragleave fire for every child the cursor crosses, so a
     plain enter/leave pair flickers — a depth counter is the standard fix: only the outermost
     leave clears it. Filtered to real FILE drags so dragging a layer or an asset thumbnail
     doesn't light up the whole stage. */
  const [dropDepth, setDropDepth] = useState(0);
  const [dropping, setDropping] = useState(false);
  const onStageDragEnter = (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    setDropDepth(d => { setDropping(true); return d + 1; });
  };
  const onStageDragLeave = () => {
    setDropDepth(d => { const n = Math.max(0, d - 1); if (n === 0) setDropping(false); return n; });
  };
  const onStageDrop = (e) => {
    const src = e.dataTransfer.getData('text/x-canvasmith-asset');
    if (!src) return;
    e.preventDefault();
    // fc.getPointer reads clientX/clientY straight off the event and maps them through fabric's
    // own upper-canvas offset + viewport transform — same conversion _pt(opt) uses in editor.js,
    // so this lands exactly where a real click at this screen position would.
    const scenePt = ed().fc.getPointer(e);
    const asset = assetsRef.current.find(x => x.src === src);
    ed().addImage(src, { name: imageLayerName(asset && asset.name) }).then(img => {
      if (!img) return;
      img.set({ left: scenePt.x, top: scenePt.y, originX: 'center', originY: 'center' });
      img.setCoords();
      ed().fc.renderAll();
      ed().commit('image');
    });
  };
  const [maskEdit, setMaskEdit] = useState(null);
  const [hist, setHist] = useState({ past: 1, future: 0 });
  const [aiMsg, setAiMsg] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiPreset, setAiPreset] = useState(null);       // AI tab style preset name, or null
  const [aiRef, setAiRef] = useState(null);             // attached reference image (dataURL), or null
  const [aiMsgErr, setAiMsgErr] = useState(false);
  const aiPromptRef = useRef(null), aiRefFileRef = useRef(null);
  const [aiBusyKind, setAiBusyKind] = useState(null);   // which AI-tab button is spinning
  const [needKey, setNeedKey] = useState(false);
  const [mode_, setMode] = useState(mode || 'dark');
  const [sideTab, setSideTab] = useState('layer');
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  // Left panel tab: 'layers' | 'ai' (remembered per browser — a convenience, never required)
  const [leftTab, setLeftTabState] = useState(() => { try { return localStorage.getItem('cm-left-tab') === 'ai' ? 'ai' : 'layers'; } catch (e) { return 'layers'; } });
  const setLeftTab = (t) => { setLeftTabState(t); try { localStorage.setItem('cm-left-tab', t); } catch (e) {} };
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // AI card: which action is running (one at a time, like the AI tab's busy lock) + its message
  const [cardBusy, setCardBusy] = useState(null);
  const [cardMsg, setCardMsg] = useState('');
  // The layer a "Background removed" note is about — the note goes once that mask does (undone,
  // deleted, layer removed) instead of describing a cut-out that no longer exists.
  const cutoutNoteLayerRef = useRef(null);
  const detectHoverRef = useRef(null);
  const compareFromEmptyRef = useRef(false);   // the AI Vision row being hovered — outlined on the canvas
  const [snapOn, setSnapOn] = useState(true);
  // Rail flyout: index into TOOLGROUPS of the group whose sub-tool list is currently open (-1 =
  // none), plus the hover tooltip's text/anchor rect — ports the vanilla demo's flyoutGroup/showTip
  // state onto React so the rail behaves identically (click a multi-tool group to open its flyout,
  // hover any rail button to show its name + shortcut).
  const [railFlyout, setRailFlyout] = useState(-1);
  const [railTip, setRailTip] = useState(null);
  const [props, setProps] = useState(EMPTY_PROPS);
  const [selMsg, setSelMsg] = useState('');
  // AI insert-at-point: {pt (scene px), region, prompt, busy, msg} | null — opened by the
  // aiinsert tool's click (see Editor#_down's 'aiinsert' emit), closed on submit/cancel/tool-switch.
  const [aiInsert, setAiInsert] = useState(null);
  // Object/hover-select live status: how many polygons are in ed.selection right now (0/1/2+,
  // matching ditto's multiCount), plus a rough busy flag for the async wand/grabCut round-trip —
  // wandPick/_hoverMove don't emit their own busy/idle event, so this approximates it the same way
  // the vanilla demo does: busy from mouse:down until the next selection/hover/error settles it.
  const [selCount, setSelCount] = useState(0);
  const [objselectBusy, setObjselectBusy] = useState(false);
  const [cloneSrc, setCloneSrc] = useState(null);
  const [objCount, setObjCount] = useState(0);   // # of boxes ed.detectObjectBoxes() found, for the "N objects" readout

  useEffect(() => {
    // Google Fonts stylesheet for the typography panel's non-system fonts — added once even if
    // several <CanvasmithEditor/> instances mount on the same page (a data attribute marks it,
    // since two <link>s pointed at the same href would just be redundant, not harmful, but there's
    // no reason to fetch it twice). Never removed on unmount — a loaded @font-face should stay
    // available for any other editor instance still on the page.
    if (typeof document !== 'undefined' && !document.querySelector('link[data-cm-fonts]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = FONT_STYLESHEET_URL; link.dataset.cmFonts = 'true';
      document.head.appendChild(link);
    }
    restoreUserFonts().then(() => { if (edRef.current) edRef.current.refreshFonts(); });
    // The shell's own interface faces — same families/weights the vanilla demo's <head> loads.
    if (typeof document !== 'undefined' && !document.querySelector('link[data-cm-ui-fonts]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = UI_FONT_URL; link.dataset.cmUiFonts = 'true';
      document.head.appendChild(link);
    }
  }, []);

  useEffect(() => {
    const f = fabric || (typeof window !== 'undefined' && window.fabric);
    const ed = new Editor({ fabric: f, canvasEl: canvasRef.current, width, height, openCvUrl, voidColor: (THEMES[mode_] || THEMES.dark).stage });
    edRef.current = ed;
    // Overlay chrome: marching-ants selection outline, crop scrim/thirds/handles/dimension
    // readout, hover-select preview, pen in-progress path, and Figma-style smart guides while
    // dragging — all drawn on fabric's shared top context, so this must redraw fabric's own top
    // layer (marquee box / control handles) first, since clearContext wipes contextTop wholesale.
    // Ports the vanilla demo's drawOverlays exactly (its own header comment calls it "the
    // reference implementation other UIs can copy") — kept pixel-for-pixel identical rather than
    // reinvented, so the two shells read as the same editor.
    let dragGuides = null, hoverPreview = null, penBuild = null, brushCursor = null, gradAxis = null, pickBusy = null;
    /* Gradient axis while dragging — the Figma-style handle: a thin white line, a round nub on the
       line at every stop, and a colour swatch floating just off it, first stop accented. Radial
       adds the circle its falloff sweeps. Same drawing as the vanilla demo's. */
    const drawGradientAxis = (ctx, g, z) => {
      const px = 1 / z;
      const dx = g.to.x - g.from.x, dy = g.to.y - g.from.y;
      const len = Math.hypot(dx, dy);
      if (g.type === 'radial' && len > 0.5) {
        ctx.setLineDash([5 * px, 4 * px]);
        ctx.lineWidth = 2.4 * px; ctx.strokeStyle = 'rgba(0,0,0,.45)';
        ctx.beginPath(); ctx.arc(g.from.x, g.from.y, len, 0, 7); ctx.stroke();
        ctx.lineWidth = 1 * px; ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.beginPath(); ctx.arc(g.from.x, g.from.y, len, 0, 7); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.setLineDash([]);
      ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(0,0,0,.35)';
      ctx.beginPath(); ctx.moveTo(g.from.x, g.from.y); ctx.lineTo(g.to.x, g.to.y); ctx.stroke();
      ctx.lineWidth = 1.5 * px; ctx.strokeStyle = '#ffffff';
      ctx.beginPath(); ctx.moveTo(g.from.x, g.from.y); ctx.lineTo(g.to.x, g.to.y); ctx.stroke();
      if (len < 1) return;
      const nx = -dy / len, ny = dx / len;   // unit perpendicular: the swatch offset direction
      const nub = 3.4 * px, half = 9 * px, off = 22 * px;
      const stops = (g.stops && g.stops.length) ? g.stops : [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }];
      stops.forEach((s, i) => {
        const t = Math.max(0, Math.min(1, s.offset));
        const px0 = g.from.x + dx * t, py0 = g.from.y + dy * t;
        const sx = px0 + nx * off, sy = py0 + ny * off;
        ctx.lineWidth = 1.2 * px; ctx.strokeStyle = 'rgba(0,0,0,.35)';
        ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(sx, sy); ctx.stroke();
        // White card under the colour chip: the swatch sits on the very colour it describes, so a
        // bare coloured square would vanish into the ramp.
        const bw = 2.2 * px, ob = half + bw / 2, ob2 = half + bw + 0.5 * px;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(sx - half, sy - half, half * 2, half * 2);
        ctx.fillStyle = s.color;
        const inset = 2.6 * px;
        ctx.fillRect(sx - half + inset, sy - half + inset, (half - inset) * 2, (half - inset) * 2);
        ctx.lineWidth = bw; ctx.strokeStyle = i === 0 ? '#2f8bff' : '#ffffff';
        ctx.strokeRect(sx - ob, sy - ob, ob * 2, ob * 2);
        ctx.lineWidth = 1 * px; ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.strokeRect(sx - ob2, sy - ob2, ob2 * 2, ob2 * 2);
        ctx.beginPath(); ctx.arc(px0, py0, nub, 0, 7);
        ctx.fillStyle = '#ffffff'; ctx.fill();
        ctx.lineWidth = 1.2 * px; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.stroke();
      });
    };
    let antsOffset = 0, antsRunning = false;
    /* Brush-footprint ring at the pointer (paint tools hide the OS cursor — see Editor's
       _cursorForTool), plus clone/heal's source pin and live sample ring. Same drawing as the
       vanilla demo's drawBrushCursor. */
    const drawBrushCursor = (ctx, c, z) => {
      const r = Math.max(0.5, c.size / 2), px = 1 / z;
      const ring = (x, y, rad, color) => {
        ctx.beginPath(); ctx.arc(x, y, rad, 0, 7);
        ctx.setLineDash([]);
        ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
        ctx.lineWidth = 1.3 * px; ctx.strokeStyle = color; ctx.stroke();
        ctx.setLineDash([]);
      };
      const cross = (x, y, rad, color) => {
        ctx.setLineDash([]);
        for (const [w, s] of [[3 * px, 'rgba(0,0,0,.55)'], [1.3 * px, color]]) {
          ctx.lineWidth = w; ctx.strokeStyle = s;
          ctx.beginPath();
          ctx.moveTo(x - rad, y); ctx.lineTo(x + rad, y);
          ctx.moveTo(x, y - rad); ctx.lineTo(x, y + rad);
          ctx.stroke();
        }
      };
      if (c.tool === 'clone' || c.tool === 'heal') {
        if (c.picking) { ring(c.x, c.y, r, '#d4ff45'); cross(c.x, c.y, r + 7 * px, '#d4ff45'); }
        else ring(c.x, c.y, r, '#ffffff');
        if (c.src) {
          const pin = 9 * px;
          ring(c.src.x, c.src.y, pin, '#d4ff45');
          cross(c.src.x, c.src.y, pin * 1.7, '#d4ff45');
        }
        return;
      }
      ring(c.x, c.y, r, '#ffffff');
    };
    const startAntsLoopIfNeeded = () => {
      if (antsRunning || !ed.selection) return;
      antsRunning = true;
      const step = () => {
        if (!ed.selection) { antsRunning = false; return; }
        antsOffset = (antsOffset + 0.4) % 12;
        ed.fc.requestRenderAll();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    const drawOverlays = () => {
      const ctx = ed.fc.contextTop; if (!ctx) return;
      ed.fc.clearContext(ctx);
      ed.fc.renderTopLayer(ctx);
      // Fabric draws an editing IText's caret and selection highlight on this same context, so
      // clearing it blind hides both. Redraw them (renderCursorOrSelection clears + repaints itself).
      const editing = ed.fc.getActiveObject();
      if (editing && editing.isEditing && editing.renderCursorOrSelection) editing.renderCursorOrSelection();
      const v = ed.fc.viewportTransform;
      ctx.save(); ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
      // A detected subject hovered in the AI Vision list: outline its box so the rows can be told apart.
      if (detectHoverRef.current) {
        const b = detectHoverRef.current;
        ctx.save(); ctx.lineWidth = 2 / v[0]; ctx.setLineDash([6 / v[0], 4 / v[0]]); ctx.strokeStyle = '#0b6bd3';
        ctx.fillStyle = 'rgba(11,107,211,0.10)'; ctx.fillRect(b.x, b.y, b.w, b.h); ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.restore();
      }
      if (ed.selection) {
        const p = selectionToPath2D(ed.selection, ed.W, ed.H);
        ctx.lineWidth = 1.6 / v[0];
        ctx.setLineDash([7 / v[0], 5 / v[0]]);
        // Lime (matches REGION_COLOR.product) rather than the accent — a pixel selection needs to
        // read as a distinct marching-ants marquee against any layer content, not an accent-colored
        // UI control (same convention the vanilla demo uses).
        ctx.lineDashOffset = -antsOffset / v[0];
        ctx.strokeStyle = '#d4ff45'; ctx.stroke(p);
        ctx.lineDashOffset = (6 - antsOffset) / v[0]; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.stroke(p);
        ctx.setLineDash([]);
        const s = ed.selection;
        if (SEL_TOOLS.includes(ed.tool) && !s.building && !ed._polyBuild) {
        const sb = selectionBounds(s, ed.W, ed.H), hs = 4.5 / v[0]; ctx.fillStyle = '#d4ff45'; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.lineWidth = 1 / v[0];
                if ((s.kind === 'poly' || s.kind === 'multipoly')) {   // the outline's own points: drag one to reshape the selection from the inside
          const rings = s.kind === 'multipoly' ? s.polys : [s.pts]; let n = 0; rings.forEach(r => { n += r.length; });
          if (n <= 600) { ctx.fillStyle = '#ffffff'; ctx.strokeStyle = 'rgba(0,0,0,.85)'; for (const r of rings) for (const q of r) { ctx.beginPath(); ctx.arc(q.x, q.y, 3.2 / v[0], 0, 7); ctx.fill(); ctx.stroke(); } }
          ctx.fillStyle = '#d4ff45';
        }
        if (s.kind === 'rect' || s.kind === 'ellipse') for (const [hx, hy] of [[sb.x, sb.y], [sb.x + sb.w, sb.y], [sb.x, sb.y + sb.h], [sb.x + sb.w, sb.y + sb.h],
                                [sb.x + sb.w / 2, sb.y], [sb.x + sb.w / 2, sb.y + sb.h], [sb.x, sb.y + sb.h / 2], [sb.x + sb.w, sb.y + sb.h / 2]]) {
            ctx.beginPath(); ctx.arc(hx, hy, hs, 0, 7); ctx.fill(); ctx.stroke();
          }
        }
        // Live "W × H" readout above the selection, constant SCREEN size regardless of zoom (same
        // /v[0] inverse-scale trick the crop tool's own dimension label below uses) — every
        // selection kind gets this now, not just crop.
        const b = selectionBounds(ed.selection, ed.W, ed.H);
        const dimLabel = Math.round(b.w) + ' × ' + Math.round(b.h);
        const dfs = 12 / v[0], dpad = 6 / v[0];
        ctx.font = dfs + 'px "JetBrains Mono", ui-monospace, monospace';
        const dtw = ctx.measureText(dimLabel).width;
        const dlx = b.x + b.w / 2, dly = b.y - dpad * 2 - dfs / 2;
        ctx.fillStyle = 'rgba(20,20,23,.92)';
        ctx.beginPath(); ctx.roundRect(dlx - dtw / 2 - dpad, dly - dfs / 2 - dpad * 0.6, dtw + dpad * 2, dfs + dpad * 1.2, dpad);
        ctx.fill();
        ctx.fillStyle = '#f1efe9'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(dimLabel, dlx, dly);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      }
      if (hoverPreview && (ed.tool === 'objectselect' || ed.tool === 'hoverselect')) {
        const p = selectionToPath2D({ kind: 'poly', pts: hoverPreview.pts }, ed.W, ed.H);
        ctx.lineWidth = 1.2 / v[0];
        ctx.setLineDash([4 / v[0], 3 / v[0]]);
        ctx.strokeStyle = 'rgba(239,106,45,.65)'; ctx.stroke(p);
        ctx.setLineDash([]);
      }
      // Geometry: straighten guide grid (while dragging) and 4-corner perspective handles — both
      // computed in core (scene coords); this only strokes them. Same drawing as the vanilla demo.
      if (ed.geometryGuide) {
        ctx.lineWidth = 1 / v[0]; ctx.strokeStyle = 'rgba(255,255,255,.55)';
        ctx.beginPath(); ed.geometryGuide.forEach(([a, b]) => { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }); ctx.stroke();
      }
      const persp = ed.perspective;
      if (persp) {
        const [p0, p1, p2, p3] = persp.corners;
        ctx.lineWidth = 1 / v[0]; ctx.strokeStyle = 'rgba(255,255,255,.5)';
        ctx.beginPath(); persp.lines.forEach(([a, b]) => { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }); ctx.stroke();
        ctx.lineWidth = 2 / v[0]; ctx.strokeStyle = persp.valid ? '#d4ff45' : '#e5484d';
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath(); ctx.stroke();
        persp.corners.forEach((c, i) => {
          ctx.beginPath(); ctx.arc(c.x, c.y, (i === persp.active ? 8 : 6) / v[0], 0, 7);
          ctx.fillStyle = i === persp.active ? '#d4ff45' : 'rgba(20,20,23,.9)'; ctx.fill();
          ctx.lineWidth = 2 / v[0]; ctx.strokeStyle = '#d4ff45'; ctx.stroke();
        });
      }
      if (ed.crop) {
        const c = ed.crop;
        ctx.fillStyle = 'rgba(0,0,0,0.48)';
        ctx.beginPath(); ctx.rect(0, 0, ed.W, ed.H); ctx.rect(c.x, c.y, c.w, c.h); ctx.fill('evenodd');
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4 / v[0]; ctx.strokeRect(c.x, c.y, c.w, c.h);
        ctx.lineWidth = 0.7 / v[0]; ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        for (let i = 1; i < 3; i++) {
          ctx.beginPath(); ctx.moveTo(c.x + c.w * i / 3, c.y); ctx.lineTo(c.x + c.w * i / 3, c.y + c.h); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(c.x, c.y + c.h * i / 3); ctx.lineTo(c.x + c.w, c.y + c.h * i / 3); ctx.stroke();
        }
        const hs = 5.5 / v[0]; ctx.fillStyle = '#4f8ff0';   // same accent as the demo's overlays
        for (const [hx, hy] of [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h],
                                [c.x + c.w / 2, c.y], [c.x + c.w / 2, c.y + c.h], [c.x, c.y + c.h / 2], [c.x + c.w, c.y + c.h / 2]])
          ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
        const label = Math.round(c.w) + ' × ' + Math.round(c.h);
        const fs = 12 / v[0], pad = 6 / v[0];
        ctx.font = fs + 'px "JetBrains Mono", ui-monospace, monospace';
        const tw = ctx.measureText(label).width;
        const lx = c.x + c.w / 2, ly = c.y - pad * 2 - fs / 2;
        ctx.fillStyle = 'rgba(20,20,23,.92)';
        ctx.beginPath(); ctx.roundRect(lx - tw / 2 - pad, ly - fs / 2 - pad * 0.6, tw + pad * 2, fs + pad * 1.2, pad);
        ctx.fill();
        ctx.fillStyle = '#f1efe9'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, lx, ly);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      }
      if (dragGuides) {
        ctx.strokeStyle = '#ff2fc0'; ctx.lineWidth = 1 / v[0]; ctx.setLineDash([]);
        if (dragGuides.x) { ctx.beginPath(); ctx.moveTo(dragGuides.x.x, dragGuides.x.y0); ctx.lineTo(dragGuides.x.x, dragGuides.x.y1); ctx.stroke(); }
        if (dragGuides.y) { ctx.beginPath(); ctx.moveTo(dragGuides.y.x0, dragGuides.y.y); ctx.lineTo(dragGuides.y.x1, dragGuides.y.y); ctx.stroke(); }
      }
      if (gradAxis) drawGradientAxis(ctx, gradAxis, v[0]);
      if (brushCursor) drawBrushCursor(ctx, brushCursor, v[0]);
      // Pen path being drawn / vector edit mode — core's drawPenOverlay, shared with the demo.
      if (penBuild) drawPenOverlay(ctx, penBuild, v[0], { accent: '#4f8ff0' });
      // magic wand / object select still computing: spinning ring at the pointer
      if (pickBusy) drawPickSpinner(ctx, pickBusy, v[0], { accent: '#4f8ff0' });
      ctx.restore();
    };
    // Only for real on-screen redraws. Fabric also fires after:render for OFFSCREEN renders (each
    // magic wand / object select pick captures the scene with the zoom reset to 100%, and so do
    // exports and the Compare snapshot) — drawing the overlays then used the temporary 100% transform,
    // flashing the selection and hover outlines oversized and shifted off the artboard.
    ed.fc.on('after:render', (opt) => { if (opt && opt.ctx && opt.ctx !== ed.fc.getContext()) return; drawOverlays(); });
    // Fabric's own click-to-select (no edit made) doesn't go through commit()/activate(), so
    // 'change' alone misses it — without these, layers() (and activeLayer/Fill below) stay stale
    // after a plain click on the canvas.
    const refreshLayers = () => setLayers(ed.layers());
    // Same refresh contract as the vanilla demo's refreshPropsPanel: 'selection'/'change' cover
    // activation and edits committed to history; the raw fabric object:moving/scaling/rotating
    // events keep X/Y/W/H/angle live while a drag is still in progress (before object:modified).
    const refreshProps = () => setProps(readProps(ed));
    const refreshCanvasInfo = () => setCanvasInfo({ W: ed.W, H: ed.H, bg: ed.canvasBackground() });
    refreshCanvasInfo();
    ed.fc.on('selection:created', refreshLayers);
    ed.fc.on('selection:updated', refreshLayers);
    ed.fc.on('selection:cleared', refreshLayers);
    ed.fc.on('selection:created', refreshProps);
    ed.fc.on('selection:updated', refreshProps);
    const dropCutoutNote = () => {
      const noteId = cutoutNoteLayerRef.current;
      if (noteId && ed.fc.getActiveObject()?.id !== noteId) { cutoutNoteLayerRef.current = null; setCardMsg(''); }
    };
    ed.fc.on('selection:created', dropCutoutNote);
    ed.fc.on('selection:updated', dropCutoutNote);
    ed.fc.on('selection:cleared', refreshProps);
    ed.fc.on('text:selection:changed', refreshProps);
    ed.fc.on('object:moving', refreshProps);
    ed.fc.on('object:scaling', refreshProps);
    ed.fc.on('object:rotating', refreshProps);
    // Extend-background nudge banner — see showExtendBanner's declaration for the full rationale.
    let extendCheckTimer = null;
    const refreshExtendBanner = () => {
      clearTimeout(extendCheckTimer);
      extendCheckTimer = setTimeout(async () => {
        const provider = ed.ai.provider();
        if (ed.tool === 'crop' || !provider || !provider.hasKey || !provider.hasKey()) { setShowExtendBanner(false); return; }
        const frac = await ed.backgroundGapFraction();
        setShowExtendBanner(frac >= 0.12);
      }, 400);
    };
    let lastTool = ed.tool;
    // Gradient stop swatch clicked on the canvas: open the native colour picker right at the swatch
    // (a hidden <input type=color> parked there) and recolour that stop live as the user picks.
    const gradPick = document.createElement('input');
    gradPick.type = 'color'; gradPick.tabIndex = -1; gradPick.setAttribute('aria-label', 'Gradient stop colour');
    gradPick.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:0;padding:0;margin:0';
    document.body.appendChild(gradPick);
    let gradPickIdx = -1;
    gradPick.addEventListener('input', () => { if (gradPickIdx >= 0) ed.setGradientStopColor(gradPickIdx, gradPick.value); });
    const openGradPick = (p) => {
      gradPickIdx = p.index; gradPick.value = p.color;
      gradPick.style.left = p.clientX + 'px'; gradPick.style.top = (p.clientY + 12) + 'px';
      try { gradPick.showPicker(); } catch (_) { gradPick.click(); }
    };
    const offs = [
      ed.on('tool', t => {
        // picking a tool brings its options (Properties tab) into view — except selection tools and
        // the AI insert, which are routinely used to build a mask for the AI Assist tab
        if (t !== lastTool && t !== 'select' && !SEL_TOOLS.includes(t) && t !== 'aiinsert') setSideTab('layer');
        lastTool = t;
        setTool(t); if (t !== 'aiinsert') setAiInsert(null); if (t !== 'crop') ed.setToolOptions({ cropRatio: 0 }); setCropChip('Free'); refreshExtendBanner();
        // Leaving objectselect/hoverselect must drop the last hover-preview outline — otherwise it
        // stays drawn (see the hoverPreview render gate above) until another 'hover' event happens
        // to land, which may never come once a different tool is active.
        if (t !== 'objectselect' && t !== 'hoverselect') { hoverPreview = null; ed.fc.requestRenderAll(); }
      }),
      ed.on('history', h => setHist(h)),
      ed.on('change', (e) => {
        // a live (mid-drag) adjustment edit only needs the panel values — skip the layer-thumbnail
        // rebuild until the release commit
        if (e && e.live) { refreshProps(); return; }
        thumbVerRef.current++; setLayers(ed.layers()); refreshProps(); refreshCanvasInfo();
        // Opening an image starts a new document: IT is the "original" Compare shows, not whatever
        // the first edit before it happened to be (a blank canvas resized to 4:5, say).
        // A scratch document re-takes its baseline while the page is still empty (it compared against a
        // blank page at the old size); Compare stays off until there's content.
        if (!compareSnapshotRef.current || compareFromEmptyRef.current || (e && e.label === 'open')) {
          const empty = !ed.fc.getObjects().length;
          compareSnapshotRef.current = ed.exportPNG(); compareFromEmptyRef.current = empty; setCompareReady(!empty);
        }
        const noteId = cutoutNoteLayerRef.current;
        if (noteId && !ed.layers().find(l => l.id === noteId)?.hasMask) { cutoutNoteLayerRef.current = null; setCardMsg(''); }
        refreshExtendBanner();
      }),
      ed.on('tooloptions', o => setOpts({ size: o.size, opacity: o.opacity, hardness: o.hardness != null ? o.hardness : 0.7, color: o.color, tolerance: o.tolerance, bucketTolerance: o.bucketTolerance != null ? o.bucketTolerance : 32, addMode: o.addMode, gradientType: o.gradientType, gradientStops: o.gradientStops, cropRatio: o.cropRatio || 0, paintNewLayer: !!o.paintNewLayer })),
      ed.on('guides', g => { dragGuides = g; ed.fc.requestRenderAll(); }),
      ed.on('selection', s => { refreshProps(); setSelMsg(''); setObjselectBusy(false); setSelCount(s ? (selectionPolys(s) || []).length : 0); ed.fc.requestRenderAll(); startAntsLoopIfNeeded(); }),
      ed.on('crop', () => ed.fc.requestRenderAll()),
      ed.on('perspective', p => { setPerspActive(!!p); ed.fc.requestRenderAll(); }),
      ed.on('geometryguide', () => ed.fc.requestRenderAll()),
      ed.on('pen', build => { penBuild = build; ed.fc.requestRenderAll(); }),
      ed.on('pathedit', p => setPathEditing(!!p)),
      ed.on('gradientstoppick', openGradPick),
      ed.on('pickbusy', b => { pickBusy = b; }),   // the editor re-renders every frame while busy
      () => gradPick.remove(),
      ed.on('brushcursor', c => { brushCursor = c; ed.fc.requestRenderAll(); }),
      ed.on('gradientaxis', g => { gradAxis = g; ed.fc.requestRenderAll(); }),
      ed.on('clonesource', s => setCloneSrc(s)),
      ed.on('maskedit', m => { setMaskEdit(m); setLayers(ed.layers()); }),
      ed.on('maskrefine', m => setMaskRefine(m)),
      ed.on('aiinsert', ({ pt, region }) => setAiInsert({ pt, region, prompt: '', busy: false, msg: '' })),
      ed.on('hover', h => { hoverPreview = h; ed.fc.requestRenderAll(); setObjselectBusy(false); }),
      ed.on('error', (ev) => {
        setObjselectBusy(false);
        // Right-click menu actions have no panel of their own to report into.
        if (ev && ev.source === 'menu') toast(ev.message || SEL_REASON_MSG[ev.reason] || 'That didn’t work.');
      }),
      ed.on('objcount', n => setObjCount(n)),
      ed.on('zoom', z => setZoomPct(Math.round((z || ed.fc.getZoom() || 1) * 100))),
      ed.on('resize', (e) => { if (e && e.all && fitAllRef.current) fitAllRef.current(); else fitToScreen(); refreshCanvasInfo(); }),
      ed.on('frames', (list) => { setFrames(list); setLayers(ed.layers()); }),
    ];
    const onObjselectDown = () => {
      if (ed.tool !== 'objectselect' && ed.tool !== 'hoverselect' && ed.tool !== 'magicwand') return;
      setObjselectBusy(true);
      setTimeout(() => setObjselectBusy(b => (ed.tool === 'objectselect' || ed.tool === 'hoverselect' || ed.tool === 'magicwand') ? false : b), 4000);
    };
    ed.fc.on('mouse:down', onObjselectDown);
    if (ai === 'gemini') {
      const p = new GeminiProvider();
      ed.ai.register(p);
      setNeedKey(!p.hasKey());
    } else if (ai && typeof ai === 'object') {
      ed.ai.register(ai);
    }
    const stops = [installKeybindings(ed, document, { toolGroups: TOOLGROUPS }), installColorPicker(),
      // Right-click menu — core builds the items, mountContextMenu draws them (shared with the demo).
      // Mounted inside .cm-root so the --cm-* theme tokens reach it.
      mountContextMenu(ed, { root: rootRef.current || document.body, vars: { panel: 'var(--cm-panel-2)', line: 'var(--cm-line)', ink: 'var(--cm-ink)', dim: 'var(--cm-dim-2)', hover: 'var(--cm-accent)', hoverInk: 'var(--cm-accent-ink)', danger: 'var(--cm-danger)' } })];
    if (bridge) {
      stops.push(installBridge(src => { ed.openImage(src); trackAsset(src, 'Opened image'); }));
      stops.push(installDropImport(stageRef.current, (src, meta) => { ed.addImage(src, { name: imageLayerName(meta && meta.name) }); trackAsset(src, (meta && meta.name) || 'Dropped image'); }));
    }
    /* Session autosave — survive a refresh / tab close. installAutosave debounces ed.toJSON()
       into IndexedDB on 'change' and flushes on pagehide (IndexedDB, not localStorage — one photo
       exceeds the ~5MB localStorage budget); getExtras folds the asset tray and
       the Compare baseline into the SAME write so they can't drift out of sync with the scene.
       Both are read through refs, not state: this effect runs once with [] deps, so a closure
       over the state values would autosave the empty arrays they held at mount forever. */
    if (autosave) {
      const session = installAutosave(ed, {
        getExtras: () => ({ assets: assetsRef.current, compare: compareSnapshotRef.current }),
        onStatus: st => setSaveStatus(st),
      });
      sessionRef.current = session;
      stops.push(() => session.stop());
    }
    const docs = new DocumentSet(ed, { blank: { width, height }, persist: !!autosave, flush: () => (sessionRef.current ? sessionRef.current.saveNow() : Promise.resolve()) });
    docsRef.current = docs;
    setDocTabs(docs.list());
    stops.push(docs.on(list => setDocTabs(list)));
    /* An explicit `image` prop wins over a restored session — the host asked for that specific
       document, so silently replacing it with whatever was last edited in this browser would be
       wrong. Restoring an empty scene is skipped too (indistinguishable from a fresh boot). */
    if (image) { ed.openImage(image); trackAsset(image, 'Opened image'); }
    else if (autosave) {
      docs.restore().then(r => r === 'loaded' ? readSession().then(rec => rec && rec.extras) : restoreSession(ed)).then(extras => {
        if (!extras || edRef.current !== ed) return;
        if (Array.isArray(extras.assets) && extras.assets.length) setAssets(extras.assets);
        if (extras.compare) { compareSnapshotRef.current = extras.compare; setCompareReady(true); }
        if (fitRef.current) fitRef.current();
      });
    }
    setLayers(ed.layers());
    setFrames(ed.frameList());
    onReady && onReady(ed);
    // The stage may not have its final layout box on the very first paint (fonts/panels still
    // settling) — retry a couple of times, same as the reference editor's own tryFit pattern,
    // until one of them finds a real clientWidth and fitToScreen can actually measure it.
    fittedRef.current = false;
    const tryFit = () => { if (!fittedRef.current && fitRef.current && fitRef.current()) fittedRef.current = true; };
    tryFit(); setTimeout(tryFit, 60); setTimeout(tryFit, 220);
    const onWindowResize = () => setZoomPct(Math.round((ed.fc.getZoom() || 1) * 100));
    window.addEventListener('resize', onWindowResize);
    // +/-/0 zoom shortcuts — no modifier, same guard (not typing, no Cmd/Ctrl/Alt) as the vanilla
    // demo's own zoom keydown listener, kept separate from installKeybindings (core) since zoom is
    // shell-owned UI state (the pill's displayed percentage), not editor state.
    const onZoomKey = (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.altKey) return;
      // bare +/-/0 and Cmd|Ctrl +/-/0/1 all zoom (the modified ones must also stop the browser zooming the whole page)
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoomAtCenter(ed.fc.getZoom() * 1.2); }
      else if (e.key === '-') { e.preventDefault(); setZoomAtCenter(ed.fc.getZoom() * 0.83); }
      else if (e.key === '0') { e.preventDefault(); if (fitAllRef.current) fitAllRef.current(); else fitToScreen(); }
      else if (mod && e.key === '1') { e.preventDefault(); setZoomAtCenter(1); }
    };
    document.addEventListener('keydown', onZoomKey);
    return () => {
      offs.forEach(f2 => f2()); stops.forEach(f2 => f2()); ed.destroy();
      window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('keydown', onZoomKey);
      clearTimeout(extendCheckTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps fc's DOM size in lockstep with the stage's box WITHOUT re-fitting the artboard on every
  // pixel of a window/panel resize — only the very first successful measurement fits/centers;
  // after that, a resize just grows/shrinks the canvas element and re-anchors the offset, same as
  // the reference editor's own resize observer (a live re-fit on every resize would fight a user's
  // manual zoom/pan).
  useEffect(() => {
    const stage = stageRef.current; if (!stage) return;
    const ro = new ResizeObserver(() => {
      const e = edRef.current; if (!e || !stage.clientWidth) return;
      if (!fittedRef.current) { if (fitRef.current && fitRef.current()) fittedRef.current = true; return; }
      e.fc.setDimensions({ width: stage.clientWidth, height: stage.clientHeight });
      e.fc.calcOffset();
      e.fc.requestRenderAll();
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  /* Accessible names for icon-only controls. Most buttons here are a bare icon plus a `title`,
     which is a MOUSE affordance: screen readers treat it as a last-resort fallback and several
     ignore it entirely when the element has no other name, so undo/redo, the zoom pill,
     stacking, alignment and the sticker tray all announce as an unlabelled "button". The icons
     are already aria-hidden (see Icon), which is right — but it leaves nothing to announce.

     Derived from the title that is already there and already maintained, rather than 40-odd
     duplicated aria-label props that would drift from their tooltips. Runs with no dep array
     (after every render) because these buttons mount and unmount constantly as tools, panels
     and selections change; it is a cheap attribute pass over one subtree. Anything with visible
     text, or an aria-label authored at the call site (the tool rail, whose name differs from
     its tooltip), is skipped. */
  useEffect(() => {
    const root = rootRef.current; if (!root) return;
    root.querySelectorAll('button[title]:not([aria-label])').forEach(el => {
      if ((el.textContent || '').trim()) return;
      const t = el.getAttribute('title');
      if (t) el.setAttribute('aria-label', t);
    });
    // Sliders / bare inputs: a text node ("Opacity ") beside an <input type=range>, no <label for>.
    // Name them from the nearest short non-numeric text before them (the readout isn't a name).
    const VALUE_LIKE = /^[-+\d.,\s]*(%|°|px|em|pt|x)?$/;
    root.querySelectorAll('input[type=range]:not([aria-label]):not([aria-labelledby]), input[type=text]:not([aria-label]):not([aria-labelledby]), input[type=number]:not([aria-label]):not([aria-labelledby])').forEach(el => {
      if (el.closest('label') && (el.closest('label').textContent || '').trim()) return;
      let name = '';
      for (let n = el.previousSibling; n && !name; n = n.previousSibling) { const t = (n.textContent || '').trim(); if (t && t.length <= 32 && !VALUE_LIKE.test(t)) name = t; }
      if (!name && el.parentElement) { const lab = el.parentElement.querySelector(':scope > label, :scope > span'); const t = lab && (lab.textContent || '').trim(); if (t && t.length <= 32 && !VALUE_LIKE.test(t)) name = t; }
      if (!name) name = el.getAttribute('placeholder') || el.getAttribute('title') || '';
      if (name) el.setAttribute('aria-label', name.replace(/\s+/g, ' '));
    });
  });

  // Keeps the off-canvas mask (see Editor's constructor) matching the stage colour when the
  // light/dark toggle flips — otherwise the mask would show a mismatched patch around the
  // artboard after a theme switch instead of blending into the new stage background.
  useEffect(() => {
    if (edRef.current) edRef.current.setVoidColor((THEMES[mode_] || THEMES.dark).stage);
  }, [mode_]);


  const ed = () => edRef.current;
  const pick = useCallback((t) => ed().setTool(t), []);
  const activeLayer = layers.find(l => l.active);
  const align = (edge) => activeLayer && ed().alignLayer(activeLayer.id, edge);
  const duplicate = () => activeLayer && ed().duplicateLayer(activeLayer.id);
  const toggleSnap = () => { const on = !snapOn; setSnapOn(on); ed().setSnapEnabled(on); };
  // Brush/Color section visibility — only show for tools that actually read toolOpts.color/fill,
  // and only show the Size/Soft/Opacity sliders for the subset that's an actual paint brush.
  const isColorTool = COLOR_TOOLS.includes(tool);
  const isPaintTool = PAINT_TOOLS.includes(tool);

  // ── zoom pill + fit-to-screen — ports the vanilla demo's setZoomAtCenter/fitToScreen exactly.
  // Matches the reference editor's model: fc's own DOM size always fills the STAGE (grown/shrunk
  // by the ResizeObserver below, independent of the artboard), and "zoom" is purely the viewport
  // transform's scale/pan on top — the artboard is just a W×H region drawn somewhere inside that
  // stage-sized canvas. fitToScreen resizes fc to the stage, THEN fits the artboard inside it.
  const [zoomPct, setZoomPct] = useState(100);
  const fittedRef = useRef(false);
  const setZoomAtCenter = (z) => {
    z = Math.min(5, Math.max(0.1, z));
    const stage = stageRef.current; if (!stage) return;
    ed().fc.zoomToPoint({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 }, z);
    ed().fc.requestRenderAll();
    setZoomPct(Math.round(z * 100));
  };
  const fitToScreen = useCallback(() => {
    const e = edRef.current, stage = stageRef.current; if (!e || !stage || !stage.clientWidth) return false;
    e.fc.setDimensions({ width: stage.clientWidth, height: stage.clientHeight });
    const pad = 48, top = 0;
    const availW = Math.max(50, stage.clientWidth - pad), availH = Math.max(50, stage.clientHeight - pad - top);
    const z = Math.min(2, Math.max(0.05, Math.min(availW / e.W, availH / e.H)));
    e.fc.setZoom(z);
    const vpt = e.fc.viewportTransform.slice();
    vpt[4] = (stage.clientWidth - e.W * z) / 2;
    vpt[5] = top + (stage.clientHeight - top - e.H * z) / 2;
    e.fc.setViewportTransform(vpt);
    e.fc.calcOffset();
    e.fc.requestRenderAll();
    setZoomPct(Math.round(z * 100));
    return true;
  }, []);
  // Always points at the latest fitToScreen so the resize observer below reframes to current dims
  // even though it's installed once on mount (same fitRef indirection as the reference editor).
  const fitRef = useRef(null); fitRef.current = fitToScreen;
  /* "Fit all": with several frames on the page, show them side by side (Figma's Shift+1); with one
     it is just fit-to-screen. */
  const fitAll = useCallback(() => {
    const e = edRef.current, stage = stageRef.current; if (!e || !stage) return false;
    if (e.frameList().length < 2) return fitToScreen();
    if (!fitToScreen()) return false;
    const b = e.frameBounds(), cw = stage.clientWidth, ch = stage.clientHeight, pad = 72;
    const z = Math.min(2, Math.max(0.05, Math.min((cw - pad) / b.w, (ch - pad) / b.h)));
    e.fc.setZoom(z);
    const vpt = e.fc.viewportTransform.slice();
    vpt[4] = (cw - b.w * z) / 2 - b.x * z;
    vpt[5] = (ch - b.h * z) / 2 - b.y * z + 8;
    e.fc.setViewportTransform(vpt);
    e.fc.calcOffset(); e.fc.requestRenderAll();
    setZoomPct(Math.round(z * 100));
    return true;
  }, [fitToScreen]);
  const fitAllRef = useRef(null); fitAllRef.current = fitAll;

  // ── voice control: core/voice.js owns the grammar; the shell only supplies zoom/export + a caption.
  // Handlers live in a ref so the one-time install (mount effect) always calls the latest closures.
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceCap, setVoiceCap] = useState(null);   // { msg, err }
  const voiceRef = useRef(null);
  const voiceActionsRef = useRef({});
  voiceActionsRef.current = {
    zoomIn: () => setZoomAtCenter(ed().fc.getZoom() * 1.2), zoomOut: () => setZoomAtCenter(ed().fc.getZoom() * 0.83),
    fit: fitToScreen, zoomTo: (pct) => setZoomAtCenter(pct / 100),
    exportPNG: () => { const u = ed().exportPNG(); onExport ? onExport(u) : downloadURL(u, 'canvasmith.png'); },
    saveProject: () => saveProject(), openProject: () => openProject(),
    reviewCommit: () => commitReview(), reviewCancel: () => closeReview(true),
    export: (fmt, scale) => {
      if (fmt === 'svg') return exportSvg();
      const m = scale || exportScale;
      const u = fmt === 'jpg' ? ed().exportJPEG(0.92, m) : ed().exportPNG(m);
      onExport ? onExport(u) : downloadURL(u, 'canvasmith.' + fmt);
    },
    newDoc: () => newDocument(), openImage: () => openImagePick(), addImage: () => addImagePick(),
    theme: (m) => setMode(cur => (m === 'light' || m === 'dark' ? m : cur === 'dark' ? 'light' : 'dark')),
    compare: () => openCompare(), search: () => openCmdk(),
    panel: (side, show) => (side === 'left' ? setLeftCollapsed(!show) : setSideCollapsed(!show)),
  };
  useEffect(() => {
    let timer;
    const v = installVoice(ed(), {
      actions: new Proxy({}, { get: (_, k) => voiceActionsRef.current[k] }),
      onStatus: ({ state, text, message }) => {
        setVoiceOn(!!voiceRef.current && voiceRef.current.listening);
        clearTimeout(timer);
        if (state === 'listening') setVoiceCap({ msg: message || 'Listening…' });
        else if (state === 'thinking' && message) setVoiceCap({ msg: message });
        else if (state === 'idle') setVoiceCap(null);
        else if (state === 'thinking') setVoiceCap({ msg: `“${text}” → thinking…` });
        else if (state === 'done' || state === 'error') {
          setVoiceCap({ msg: state === 'done' ? `“${text}” → ${message}` : message, err: state === 'error' });
          timer = setTimeout(() => setVoiceCap(c => (c && /^Listening|^Downloading/.test(c.msg) ? c : null)), Math.max(2500, (message || '').length * 55));
        }
      },
    });
    voiceRef.current = v;
    return () => { clearTimeout(timer); v.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggleVoice = () => {
    const v = voiceRef.current;
    if (v && v.supported) v.toggle(); else setVoiceCap({ msg: 'Voice control needs Chrome, Edge or Safari', err: true });
  };

  // ── Properties panel actions — mirrors the vanilla demo's wiring 1:1 so both UIs behave the
  // same; refreshProps() (via the 'change'/'selection' events already wired above) keeps `props`
  // in sync after each call, so handlers here don't need to update state themselves.
  const showSelResult = (r) => setSelMsg(r.status === 'ok' ? '' : (r.message || SEL_REASON_MSG[r.reason] || r.reason));
  const stack = (dir) => activeLayer && ed().moveLayer(activeLayer.id, dir);
  const groupSel = () => showSelResult(ed().groupSelection());
  const ungroupSel = () => showSelResult(ed().ungroupSelection());
  // live: render without an undo step (slider drags / curve edits); commitAdjust() pushes the one
  // undo step on release — see Editor#setImageFilters
  const setAdjust = (patch, live = false) => {
    if (props.isAdjustment) ed().setAdjustmentParams(activeLayer?.id, patch, { live });
    else ed().setImageFilters(patch, { live });
  };
  const commitAdjust = () => ed().commitLive(props.isAdjustment ? 'adjustment' : 'filters');
  const [showCurves, setShowCurves] = useState(false);
  const [perspActive, setPerspActive] = useState(false);
  const [pathEditing, setPathEditing] = useState(false);   // vector edit mode on a path layer
  const [showHsl, setShowHsl] = useState(false);
  const setGeom = (patch, live = false) => ed().setImageGeometry(patch, { live });
  const commitGeom = () => ed().setImageGeometry({});   // non-live no-op patch: drops the guide grid + pushes the undo step
  // histogram behind the curves editor — recomputed per selected layer (not per edit: it shows
  // the layer's input, which adjustments don't change), and only while the editor is open
  const [histogram, setHistogram] = useState(null);
  useEffect(() => {
    if (!showCurves || !(props.isImage || props.isAdjustment) || !edRef.current) { setHistogram(null); return; }
    setHistogram(edRef.current.getImageHistogram());
  }, [showCurves, activeLayer?.id, props.isImage, props.isAdjustment]);
  const setText = (patch) => ed().setTextProps(patch);
  // Fill-gradient editor: angle isn't retrievable from a Fabric gradient object (it's baked into
  // absolute coords), so it's tracked locally the same way the demo tracks it — kept across
  // stop/type edits on the same shape, reset only implicitly (a freshly-selected shape's own
  // angle is unknown, so this just starts back at 0 for it).
  const [fgAngle, setFgAngle] = useState(0);
  const DEFAULT_GRADIENT_STOPS = [{ offset: 0, color: '#ef6a2d' }, { offset: 1, color: '#7c3aed' }];
  const setSolidFillMode = () => setFillColor(props.fill, props.fillAlpha);
  const setGradientFillMode = () => ed().setShapeGradient((props.shapeGradient && props.shapeGradient.stops) || DEFAULT_GRADIENT_STOPS, 'linear', fgAngle);
  const setShapeGradientPatch = (patch) => {
    const cur = props.shapeGradient || { type: 'linear', stops: DEFAULT_GRADIENT_STOPS };
    const next = { ...cur, ...patch };
    if ('angle' in patch) setFgAngle(patch.angle);
    ed().setShapeGradient(next.stops, next.type, 'angle' in patch ? patch.angle : fgAngle);
  };
  // ── Compare: side-by-side view of the first meaningful state vs. the live render — see the
  // compareSnapshotRef declaration above (near the other refs) for the snapshot-capture rationale.
  const openCompare = () => {
    if (!compareSnapshotRef.current) return;
    setCompareAfter(ed().exportPNG());
    setCompareOpen(true);
  };
  const closeCompare = () => setCompareOpen(false);
  const compareRef = useRef(null);
  // dialog behaviour: focus moves in, Tab stays inside, focus returns to the Compare button on close
  useEffect(() => { if (!compareOpen) return undefined; return trapDialog(compareRef.current, { initial: '.cm-compare-close' }); }, [compareOpen]);
  useEffect(() => {
    if (compareOpen) {
      const onKey = (e) => { if (e.key === 'Escape') closeCompare(); };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareOpen]);

  // ── ⌘K command palette — ports the vanilla demo's cmdk implementation onto React state. Tool
  // items come from GROUPS (already the single source of truth for the tool rail); action items
  // are React-shell equivalents of the demo's Edit/Select/View/Insert/Export groups, using only
  // capabilities that actually exist in this shell (no video/catalogue-specific actions).
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkQuery, setCmdkQuery] = useState('');
  const [cmdkIdx, setCmdkIdx] = useState(0);
  const cmdkInputRef = useRef(null);
  const ALL_TOOL_ITEMS = GROUPS.flatMap(g => g.tools).map(([id, label]) => ({ group: 'Tool', icon: id, label, run: () => ed().setTool(id) }));
  const buildActionItems = () => [
    { group: 'Edit', icon: 'plus', label: 'New document', run: newDocument },
    { group: 'Edit', icon: 'plus', label: 'Add frame', run: () => { const e = ed(); if (e) e.addFrame(); } },
    { group: 'Edit', icon: 'plus', label: 'New canvas tab', run: () => { const d = docsRef.current; if (d && d.count < MAX_DOCS) d.add(); } },
    { group: 'Edit', icon: 'duplicate', label: 'Duplicate canvas tab', run: () => docsRef.current && docsRef.current.duplicate() },
    { group: 'Edit', icon: 'close', label: 'Close canvas tab', run: () => docsRef.current && closeDocTab(docsRef.current.activeId) },
    { group: 'Edit', icon: 'undo', label: 'Undo', run: () => ed().undo() },
    { group: 'Edit', icon: 'redo', label: 'Redo', run: () => ed().redo() },
    { group: 'Edit', icon: 'duplicate', label: 'Duplicate layer', run: duplicate },
    { group: 'Edit', icon: 'close', label: 'Delete layer', run: () => activeLayer && ed().removeLayer(activeLayer.id) },
    { group: 'Select', icon: 'box', label: 'Group selection', run: groupSel },
    { group: 'Select', icon: 'duplicate', label: 'Ungroup', run: ungroupSel },
    { group: 'Select', icon: 'close', label: 'Deselect', run: () => ed().clearSelection() },
    { group: 'View', icon: 'plus', label: 'Zoom in', run: () => setZoomAtCenter(ed().fc.getZoom() * 1.2) },
    { group: 'View', icon: 'minus', label: 'Zoom out', run: () => setZoomAtCenter(ed().fc.getZoom() * 0.83) },
    { group: 'View', icon: 'maximize', label: 'Fit to screen', run: () => fitAll() },
    { group: 'View', icon: 'search', label: 'Compare with original', run: openCompare },
    { group: 'View', icon: mode_ === 'dark' ? 'sun' : 'moon', label: 'Toggle light/dark theme', run: () => setMode(m => m === 'dark' ? 'light' : 'dark') },
    { group: 'View', icon: 'chevron', label: leftCollapsed ? 'Show side panel' : 'Hide side panel', run: () => setLeftCollapsed(s => !s) },
    { group: 'View', icon: 'chevron', label: sideCollapsed ? 'Show Properties panel' : 'Hide Properties panel', run: () => setSideCollapsed(s => !s) },
    { group: 'Insert', icon: 'type', label: 'Add text', run: () => ed().setTool('type') },
    { group: 'Insert', icon: 'box', label: 'Add rectangle', run: () => ed().setTool('rect') },
    { group: 'Insert', icon: 'ellipse', label: 'Add ellipse', run: () => ed().setTool('ellipse') },
    { group: 'Insert', icon: 'duplicate', label: 'Add image…', run: addImagePick },
    { group: 'Insert', icon: 'spark', label: 'Add CTA button', run: () => { ed().addCTA(null, { text: 'Shop now' }); ed().setTool('select'); } },
    { group: 'Insert', icon: 'star', label: 'Add badge', run: () => { ed().addBadge(null, { text: 'Sale' }); ed().setTool('select'); } },
    { group: 'Insert', icon: 'box', label: 'Add price', run: () => { ed().addPrice(null, { current: '$29', original: '$40', save: 'Save 27%' }); ed().setTool('select'); } },
    { group: 'Insert', icon: 'box', label: 'Add brand lockup', run: () => { ed().addBrandLockup(null, { text: 'Brand' }); ed().setTool('select'); } },
    { group: 'Export', icon: 'duplicate', label: 'Export PNG', run: () => { const u = ed().exportPNG(); onExport ? onExport(u) : downloadURL(u, 'canvasmith.png'); } },
    { group: 'Export', icon: 'duplicate', label: 'Export JPG', run: () => { const u = ed().exportJPEG(); onExport ? onExport(u) : downloadURL(u, 'canvasmith.jpg'); } },
    { group: 'Export', icon: 'duplicate', label: 'Export SVG', run: exportSvg },
    // Everyday layer actions the palette was missing — "flip", "lock", "front"... found nothing.
    { group: 'Arrange', icon: 'flip', label: 'Flip horizontal', run: () => ed().flipLayer('x') },
    { group: 'Arrange', icon: 'flip', label: 'Flip vertical', run: () => ed().flipLayer('y') },
    { group: 'Arrange', icon: 'reset', label: 'Rotate 90°', run: () => { const o = ed().fc.getActiveObject(); if (o) ed().setNumeric({ angle: ((o.angle || 0) + 90) % 360 }); } },
    { group: 'Arrange', icon: 'stackfront', label: 'Bring to front', run: () => ed().arrangeSelection('top') },
    { group: 'Arrange', icon: 'stackup', label: 'Bring forward', run: () => ed().arrangeSelection('up') },
    { group: 'Arrange', icon: 'stackdown', label: 'Send backward', run: () => ed().arrangeSelection('down') },
    { group: 'Arrange', icon: 'stackback', label: 'Send to back', run: () => ed().arrangeSelection('bottom') },
    { group: 'Arrange', icon: 'align-h-center', label: 'Center horizontally on canvas', run: () => ed().fc.getActiveObject() && ed().alignActiveSelection('center') },
    { group: 'Arrange', icon: 'align-v-center', label: 'Center vertically on canvas', run: () => ed().fc.getActiveObject() && ed().alignActiveSelection('middle') },
    { group: 'Layer', icon: 'lock', label: 'Lock / unlock layer', run: () => ed().toggleSelectionLock() },
    { group: 'Layer', icon: 'hoverselect', label: 'Hide / show layer', run: () => ed().toggleSelectionVisible() },
    { group: 'Layer', icon: 'contrast', label: 'Add adjustment layer', run: () => ed().addAdjustmentLayer() },
    { group: 'Layer', icon: 'scissors', label: 'Remove background', run: () => removeBg() },
    { group: 'Select', icon: 'grid', label: 'Select all layers', run: () => ed().selectAllLayers() },
    { group: 'Edit', icon: 'duplicate', label: 'Copy as PNG', run: () => ed().copyAsPNG() },
    { group: 'Export', icon: 'folder', label: 'Save project file', run: saveProject },
  ];
  const cmdkAllItems = () => ALL_TOOL_ITEMS.concat(buildActionItems());
  const cmdkFilteredItems = () => {
    const q = cmdkQuery.trim().toLowerCase();
    const all = cmdkAllItems();
    return rankCommands(all, q);
  };
  const openCmdk = () => { setCmdkQuery(''); setCmdkIdx(0); setCmdkOpen(true); requestAnimationFrame(() => cmdkInputRef.current && cmdkInputRef.current.focus()); };
  const closeCmdk = () => setCmdkOpen(false);
  const runCmdkItem = (it) => { closeCmdk(); if (it) it.run(); };
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmdk(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setBlend = (blend) => activeLayer && ed().setLayer(activeLayer.id, { blend });
  // live: a slider drag is one undo step, not one per input event
  const setOpacity = (opacity) => activeLayer && ed().setLayer(activeLayer.id, { opacity }, { live: true });
  // Colour pickers/hex fields hand over a bare hex — re-apply the current opacity so recolouring
  // a 40% fill doesn't silently snap it back to 100%.
  const setFillColor = (color, alpha = props.fillAlpha) => ed().setFill(withAlpha(color, alpha));
  const setStroke = ({ alpha = props.strokeAlpha, ...patch }) => ed().setStroke('color' in patch ? { ...patch, color: withAlpha(patch.color, alpha) } : patch);
  const setNumeric = (patch, opts) => ed().setNumeric(patch, opts);
  const flip = (axis) => ed().flipLayer(axis);
  const centerH = () => ed().fc.getActiveObject() && ed().alignActiveSelection('center');
  const centerV = () => ed().fc.getActiveObject() && ed().alignActiveSelection('middle');
  const setShadow = (patch) => ed().setShadow({ ...props.shadow, ...patch });
  const clearShadow = () => ed().setShadow({ blur: 0, offsetX: 0, offsetY: 0 });
  const [morphPx, setMorphPx] = useState(6);
  const expandSel = async () => showSelResult(await ed().expandSelection(morphPx));
  const contractSel = async () => showSelResult(await ed().contractSelection(morphPx));
  const selectSimilar = async () => showSelResult(await ed().selectSimilar());
  // Objectselect's Shift-click/Add mode deliberately keeps every picked object as a separate
  // polygon (see Editor#_commitObjectPoly) instead of auto-unioning — Merge is the explicit second
  // step that combines them into clean outline(s), matching the reference editor's own two-step
  // "pick several, then Merge" flow rather than silently merging on every click.
  const mergeSel = async () => showSelResult(await ed().mergeObjectSelection());
  const redetectObjects = async () => { setSelMsg('Detecting…'); await ed().detectObjectBoxes(); setSelMsg(''); };
  const recolorSel = (hex) => { const id = ed().recolorSelection(hex); setSelMsg(id ? '' : 'Make a selection first.'); };
  // Clip/unclip the active layer to the current selection — non-destructive: hides pixels
  // outside the selection via a clipPath, doesn't touch layer size/position/data. Needs BOTH an
  // active layer and a selection, unlike Expand/Contract/Select similar/Recolor which only need
  // a selection — ported from the vanilla demo's sel-clip/sel-unclip, previously absent here.
  // clipLayerToSelection/clearLayerClip (editor.js) already resolve a fallback active layer via
  // _lastActiveId when a drawing tool has discarded Fabric's own active object — checking
  // fc.getActiveObject() directly here would re-introduce that exact bug in the UI guard even
  // though the underlying call would have succeeded, so this checks the SAME resolved layer the
  // editor methods themselves use.
  const hasResolvableLayer = () => !!(ed().fc.getActiveObject() || (ed()._lastActiveId && ed()._byId(ed()._lastActiveId)));
  const clipToSel = () => { if (!hasResolvableLayer()) { setSelMsg('Select a layer to clip first.'); return; } ed().clipLayerToSelection(); setSelMsg(''); };
  const clearClip = () => { if (!hasResolvableLayer()) { setSelMsg('Select a layer first.'); return; } ed().clearLayerClip(); setSelMsg(''); };
  const [detectResults, setDetectResults] = useState([]);
  const [detectRan, setDetectRan] = useState(false);
  const runCard = async (key, fn) => {
    setCardBusy(key); setCardMsg(''); cutoutNoteLayerRef.current = null;
    try { return await fn(); } finally { setCardBusy(null); }
  };
  // Results land in the AI Vision tab (switched to automatically); failures go on the card, since
  // the tab's list may not be what's on screen.
  const detectObjects = async () => {
    const r = await runCard('detect', () => ed().detectObjects());
    setDetectResults([]);
    if (r.status !== 'ok') { setCardMsg(r.message || SEL_REASON_MSG[r.reason] || r.reason); return; }
    setDetectResults(r.result.boxes); setDetectRan(true);
    setLeftTab('ai');
  };
  // method: undefined = AI when keyed, else offline; 'local' = always offline (same messages as the demo)
  const removeBg = async (method) => {
    const id = ed().fc.getActiveObject()?.id;
    const r = await runCard(method === 'local' ? 'removebg-local' : 'removebg', () => ed().removeBackground(method ? { method } : undefined));
    cutoutNoteLayerRef.current = r.status === 'ok' ? id : null;
    setCardMsg(r.status !== 'ok' ? (r.message || r.reason)
      : r.method === 'ai'
        ? 'Background removed (AI cutout) — it\'s a layer mask: refine it with the brush, or undo.'
        : 'Background removed offline — it\'s a layer mask. Edit the mask to touch it up with Keep / Remove, or undo.'
          + (r.aiFallback ? (r.aiFallback === 'weak_cutout' ? ' The AI result didn\'t separate a subject, so the offline cutout was used.' : ' AI was unavailable, so the offline cutout was used.') : ''));
  };
  const autoShadow = () => { const r = ed().toggleAutoShadow(); if (!r) setCardMsg('Select a layer first.'); };
  const selectDetected = (box) => ed().selectDetectedBox(box);
  // Detected subjects → real layers (one box, or all of them). Clears the list afterwards: the
  // boxes were measured against the pre-convert composition and no longer describe the new layers.
  const detectedToLayers = async (boxes) => {
    detectHoverRef.current = null;   // the rows unmount without a mouseleave
    const r = await runCard('tolayers', () => ed().detectedBoxesToLayers(boxes, bgMode));
    if (r.status !== 'ok') { setCardMsg(r.message || SEL_REASON_MSG[r.reason] || r.reason); return; }
    setDetectResults([]); setDetectRan(false);
    setCardMsg(`Created ${r.result} layer${r.result === 1 ? '' : 's'} — undo to revert.`);
    setLeftTab('layers');
  };
  const [exportOpen, setExportOpen] = useState(false);
  const [csOpen, setCsOpen] = useState(false);
  const [featherOpen, setFeatherOpen] = useState(false);
  const [featherMode, setFeatherMode] = useState('mask');   // image layers: live mask, or bake into the pixels
  const [featherDraft, setFeatherDraft] = useState(0);
  const [csW, setCsW] = useState(width);
  const [csH, setCsH] = useState(height);
  const [csLock, setCsLock] = useState(true);
  const openCanvasSize = () => { setCsW(ed().W); setCsH(ed().H); setCsOpen(o => !o); };
  const applyCanvasSize = () => { if (csW > 0 && csH > 0) ed().resizeCanvas(csW, csH); setCsOpen(false); };
  // Export dropdown: click outside the anchor closes it (picking a format also closes it, handled
  // inline at each menu item) — same interaction as the vanilla demo's export-menu.
  // Escape with the Feather popover or the export menu open closes just that, before the editor's
  // own Escape (deselect) sees it — capture phase on window.
  useEffect(() => {
    if (!exportOpen && !featherOpen) return;
    const onKey = (e) => { if (e.key !== 'Escape') return; e.preventDefault(); e.stopPropagation(); setExportOpen(false); setFeatherOpen(false); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [exportOpen, featherOpen]);
  useEffect(() => {
    if (!exportOpen) return;
    const onDocClick = (e) => { if (!e.target.closest('.cm-export-anchor')) setExportOpen(false); };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [exportOpen]);
  const saveKey = (k) => { ed().ai.provider().setKey(k); setNeedKey(!k); };

  // ── Design tab: canvas-level background/fill tools and add-element shortcuts ────────────
  const [designBusy, setDesignBusy] = useState(false);
  const [stickerCat, setStickerCat] = useState(0);
  // Design ▸ Add element: Text / Box / Circle land centred and selected right away (demo #add-text etc.)
  const addCentred = (kind) => {
    const e = ed(), at = e.nextSpot();
    const o = kind === 'text' ? makeText(e.fabric, at, { fontSize: 48 }) : makeShape(e.fabric, kind, at, e.toolOpts);
    if (!o) return;
    e.fc.add(o); e.fc.setActiveObject(o); e.commit(kind === 'text' ? 'text' : 'shape'); e.setTool('select');
  };
  // Extend-background nudge: a floating banner over the canvas that appears once enough of the
  // artboard is still empty, offering the same AI-extend action as the Design tab's own button —
  // debounced (400ms) since it re-samples the flattened canvas and 'change' events can fire in
  // bursts. Ported from the vanilla demo's extend-banner/refreshExtendBanner, previously absent
  // from the React shell entirely.
  const [showExtendBanner, setShowExtendBanner] = useState(false);
  const [designMsg, setDesignMsg] = useState('');
  const extendBackground = () => setDesignMsg(ed().extendBackgroundToCanvas() ? '' : 'No background image to extend.');
  const aiExtendBackground = async () => {
    setDesignBusy(true); setDesignMsg('');
    const r = await ed().aiExtendBackground();
    setDesignBusy(false);
    setDesignMsg(r.status === 'ok' ? 'Applied ✓ (undo to revert)' : r.message || r.reason);
  };
  const onExtendBannerClick = async () => {
    setShowExtendBanner(false);
    const r = await ed().aiExtendBackground();
    if (r.status !== 'ok') setDesignMsg(r.message || r.reason);
  };
  const fillWithColor = (color) => ed().fillWithColor(color);
  // resolves once onPicked has finished, so a voice chain ("add an image then make it red") can wait for the picture
  const pickImage = (onPicked) => new Promise((res, rej) => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.oncancel = () => rej(new Error('No image chosen'));
    inp.onchange = (e) => {
      const f = e.target.files[0]; if (!f) return rej(new Error('No image chosen'));
      const rd = new FileReader();
      rd.onload = (ev) => Promise.resolve(onPicked(ev.target.result, f.name)).then(() => res('Image added'), rej);
      rd.readAsDataURL(f);
    };
    inp.click();
  });
  const fillWithImagePick = () => pickImage(src => ed().fillWithImage(src));
  const addImagePick = () => pickImage((src, fileName) => { trackAsset(src, fileName || 'Image'); return ed().addImage(src, { name: imageLayerName(fileName) }); }).catch(() => {});
  /* "Open image…" starts a fresh document from the photo: the artboard resizes to match the
     image (Editor#openImage's fit-artboard behavior), same as the vanilla demo's header button.
     addImagePick above stays the "insert into the current artboard" tool. */
  const openImagePick = () => pickImage(src => { ed().openImage(src); trackAsset(src, 'Opened image'); });
  /* "New" — discard the current document. Confirmed first: Editor#reset() empties the undo stack
     by design (you must not be able to Ctrl+Z back into a document you explicitly discarded),
     which makes this the one irreversible action in the editor — and with autosave on it wipes
     the saved copy too. An already-empty document has nothing to lose, so it skips the prompt.
     Ports the vanilla demo's own newdoc handler. */
  const closeDocTab = (id) => {
    const docs = docsRef.current, e = ed(); if (!docs || !e) return;
    const d = docs.docs.find(x => x.id === id); if (!d) return;
    const empty = id === docs.activeId ? !e.fc.getObjects().length : !d.parked || !JSON.parse(d.parked.scene).scene.objects.length;
    if (!empty && !window.confirm('Close \u201c' + d.name + '\u201d? Its layers will be discarded.')) return;
    docs.close(id);
  };
  const newDocument = async () => {
    const e = ed(); if (!e) return;
    const blank = () => {
      e.reset({ width, height });
      setAssets([]);
      compareSnapshotRef.current = null; setCompareReady(false); setCompareOpen(false);
      setSaveStatus(null);
      e.setTool('select');
      if (fitRef.current) fitRef.current();
    };
    // An empty document has nothing to lose: no prompt, nothing to undo.
    if (!e.fc.getObjects().length) { blank(); return; }
    /* Park the current document BEFORE clearing so the Undo below has something to restore.
       This is what makes New recoverable: reset() empties the undo stack by design, so without
       it the only copy of the work is gone the moment the button is clicked. */
    if (sessionRef.current) await sessionRef.current.saveNow();
    const parked = await discardToTrash();
    blank();
    if (sessionRef.current) await sessionRef.current.clear();
    if (!parked) return;
    toast('Started a new document', async () => {
      const extras = await restoreDiscarded(e);
      if (!extras) return;
      if (Array.isArray(extras.assets) && extras.assets.length) setAssets(extras.assets);
      if (extras.compare) { compareSnapshotRef.current = extras.compare; setCompareReady(true); }
      if (fitRef.current) fitRef.current();
    });
  };

  /* Project file: PNG/JPG/SVG are all flattened or lossy, so before this there was no way to get
     layers, masks and adjustments out of the browser — no backup, no moving machines, no
     handing the document to someone else. */
  const saveProject = () => {
    const blob = new Blob([exportProject(ed(), { assets }, docsRef.current)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    downloadURL(url, 'canvasmith-project.canvasmith');
    URL.revokeObjectURL(url);
  };
  const openProject = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.canvasmith,application/json';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return;
      const e = ed();
      if (e.fc.getObjects().length && !window.confirm('Open this project?\n\nIt replaces the current document.')) return;
      const r = new FileReader();
      r.onload = async () => {
        try {
          const extras = await loadProject(e, r.target.result, docsRef.current);
          if (Array.isArray(extras.assets)) setAssets(extras.assets);
          if (extras.compare) { compareSnapshotRef.current = extras.compare; setCompareReady(true); }
          if (fitRef.current) fitRef.current();
          toast('Project opened');
        } catch (err) {
          // parseProject's messages are written to be shown, not logged.
          window.alert(err.message || 'Could not open that project.');
        }
      };
      r.readAsText(f);
    };
    inp.click();
  };
  // Vector export — exportSVG() returns a plain SVG string (not a dataURL, unlike PNG/JPEG), so
  // it needs wrapping in a Blob URL before it can be downloaded — same as the vanilla demo's own
  // svg.onclick. Previously absent from the React shell entirely (only PNG/JPG existed here).
  const exportAllFrames = () => {
    ed().exportAllFrames('png', exportScale).forEach((f, i) => setTimeout(() => {
      if (onExport) onExport(f.url); else downloadURL(f.url, `${f.name.replace(/[^\w\- ]+/g, '').trim() || 'frame'}${exportScale === 1 ? '' : '@' + exportScale + 'x'}.png`);
    }, i * 250));
  };
  const exportSvg = () => {
    const blob = new Blob([ed().exportSVG()], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    // A host's onExport usually reads the URL asynchronously (fetch → upload/save), so revoking
    // synchronously would hand it a dead link; give it a minute before releasing the blob.
    if (onExport) { onExport(url); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    else { downloadURL(url, 'canvasmith.svg'); URL.revokeObjectURL(url); }
  };
  // Scene (artboard) px -> screen px, via the live viewportTransform — shared by the region-review
  // hover-preview SVG and the AI-insert popover positioning.
  const sceneToScreen = (pt) => {
    const v = ed().fc.viewportTransform;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const stageRect = stageRef.current.getBoundingClientRect();
    return { x: canvasRect.left - stageRect.left + pt.x * v[0] + v[4], y: canvasRect.top - stageRect.top + pt.y * v[3] + v[5] };
  };

  // ── Convert to layers: guided review — REAL Fabric objects (role:'region') on the live canvas,
  // same architecture as the vanilla demo (see apps/demo/index.html's openReview/renderReviewPanel
  // block) instead of a parallel React-state box model. Fabric's own selection/move/resize/multi-
  // select drives box editing and the "Selected region" panel reads the live active object — this
  // is what buys back lasso/polygon/magnetic-lasso/object-click detection, rename, merge, and the
  // live hover-cutout-preview for free from the shared selection.js primitives instead of
  // reimplementing that geometry a second time in React state (which is what the old box-only
  // model above did, and why it never grew past plain rectangles).
  //
  // reviewState: {flat, srcImg} | null — regions themselves are queried live off the canvas
  // (regionObjects()) so there's exactly one source of truth, never a parallel array to drift.
  const reviewStateRef = useRef(null);
  const [reviewOn, setReviewOn] = useState(false);   // mirrors !!reviewStateRef.current for render gating
  const [, bumpReview] = useState(0);
  const forceReview = useCallback(() => bumpReview(n => n + 1), []);
  const [convertBusy, setConvertBusy] = useState(false);
  const [convertMsg, setConvertMsg] = useState('');
  const [commitBusy, setCommitBusy] = useState(false);
  const [regionDraw, setRegionDrawState] = useState(null);   // null | 'object' | 'box' | 'lasso' | 'polylasso' | 'maglasso'
  const [objMulti, setObjMulti] = useState(false);
  const [bgMode, setBgMode] = useState('auto');
  const dragBuildRef = useRef(null);     // in-progress box/lasso drag: {mode, sel, shape}
  const polyBuildStateRef = useRef(null);  // in-progress polygon/magnetic click-build: {pts:[]}
  const polyDraftShapeRef = useRef(null);
  const reviewHoverRef = useRef({ timer: null, key: null, cache: {} });

  const regionObjects = () => ed().fc.getObjects().filter(o => o.role === 'region');
  const activeRegion = () => { const o = ed().fc.getActiveObject(); return (reviewStateRef.current && o && o.role === 'region') ? o : null; };
  const selectedRegions = () => {
    const a = ed().fc.getActiveObject(); if (!a) return [];
    return (a.type === 'activeSelection' ? a.getObjects() : [a]).filter(o => o.role === 'region');
  };
  const makeRegionRectObj = (rg) => {
    const bbox = rg.bbox || {};
    const x = (bbox.x || 0) / 100 * ed().W, y = (bbox.y || 0) / 100 * ed().H;
    const w = Math.max(12, (bbox.width || 0) / 100 * ed().W), h = Math.max(12, (bbox.height || 0) / 100 * ed().H);
    const rt = REGION_COLOR[rg.type] ? rg.type : 'decorative';
    const fabric = ed().fabric;
    const r = outlineRegion(new fabric.Rect({
      left: x, top: y, width: w, height: h,
      fill: REGION_COLOR[rt] + REGION_FILL_ALPHA, stroke: REGION_COLOR[rt], strokeWidth: 2.5, strokeDashArray: [8, 4],
      strokeUniform: true, rx: 3, ry: 3, cornerColor: REGION_COLOR[rt], cornerStyle: 'circle', transparentCorners: false, objectCaching: false,
    }));
    r.set({ id: 'r' + Math.random().toString(36).slice(2, 9), role: 'region', regionType: rt, rcontent: rg.content || '', rstyle: rg.style || null, name: rg.name || REGION_NAME[rt], renamed: !!rg.name });
    return r;
  };
  const makeFreehandRegionObj = (pts, rg = {}) => {
    const fabric = ed().fabric;
    const poly = outlineRegion(new fabric.Polygon(pts.map(p => ({ x: p.x, y: p.y })), {
      fill: REGION_COLOR.product + REGION_FILL_ALPHA, stroke: REGION_COLOR.product, strokeWidth: 2.5, strokeDashArray: [8, 4],
      strokeUniform: true, cornerColor: REGION_COLOR.product, cornerStyle: 'circle', transparentCorners: false, objectCaching: false,
    }));
    poly.set({ id: 'r' + Math.random().toString(36).slice(2, 9), role: 'region', regionType: 'product', rcontent: rg.content || '', rstyle: rg.style || null, name: rg.name || REGION_NAME.product, renamed: !!rg.name, isFreehand: true });
    return poly;
  };
  const regionBBox = (o) => {
    o.setCoords();
    const a = o.aCoords, xs = [a.tl.x, a.tr.x, a.bl.x, a.br.x], ys = [a.tl.y, a.tr.y, a.bl.y, a.br.y];
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  };
  const regionAbsPolygon = (o) => {
    if (!o.isFreehand || o.type !== 'polygon' || !o.points) return null;
    const m = o.calcTransformMatrix(), off = o.pathOffset || { x: 0, y: 0 };
    return o.points.map(p => ed().fabric.util.transformPoint({ x: p.x - off.x, y: p.y - off.y }, m));
  };
  const regionToPayload = (o) => {
    const b = regionBBox(o);
    return {
      type: o.regionType, content: o.rcontent || '', style: o.rstyle || undefined, name: o.renamed ? o.name : undefined,
      polygon: regionAbsPolygon(o) || undefined,
      bbox: { x: b.x / ed().W * 100, y: b.y / ed().H * 100, width: b.w / ed().W * 100, height: b.h / ed().H * 100 },
    };
  };

  const openReview = (flat, regions) => {
    loadImgEl(flat).then(img => { if (reviewStateRef.current) reviewStateRef.current.srcImg = img; });
    reviewStateRef.current = { flat, srcImg: null };
    setRegionDrawState(null); setObjMulti(false);
    ed().setTool('select');
    regions.forEach(rg => ed().fc.add(makeRegionRectObj(rg)));
    ed().fc.discardActiveObject();
    ed().fc.renderAll();
    setReviewOn(true);
  };
  const closeReview = (removeBoxes = true) => {
    if (removeBoxes) regionObjects().forEach(o => ed().fc.remove(o));
    if (polyDraftShapeRef.current) { ed().fc.remove(polyDraftShapeRef.current); polyDraftShapeRef.current = null; }
    if (dragBuildRef.current && dragBuildRef.current.shape) ed().fc.remove(dragBuildRef.current.shape);
    // Closing mid-draw must hand the canvas back in its normal interactive state.
    ed().fc.selection = true; ed().fc.skipTargetFind = false; ed().fc.defaultCursor = 'default';
    ed().fc.discardActiveObject();
    ed().fc.renderAll();
    reviewStateRef.current = null;
    setRegionDrawState(null); polyBuildStateRef.current = null; dragBuildRef.current = null;
    setReviewOn(false);
    setConvertMsg('');
  };
  const setRegionDrawMode = (mode) => {
    if (polyBuildStateRef.current) finishPolyDrawLocal(true);
    if (dragBuildRef.current) { if (dragBuildRef.current.shape) ed().fc.remove(dragBuildRef.current.shape); dragBuildRef.current = null; }
    setRegionDrawState(mode);
    if (mode) ed().fc.discardActiveObject();
    if (mode === 'maglasso' && !ed()._edgeMap) ed().buildMagneticEdgeMap();
    ed().fc.selection = !mode;
    // While drawing, NO object may take the press — otherwise mousedown on the photo (or any layer)
    // makes Fabric grab and drag that layer instead of starting the box/lasso/polygon/object pick.
    ed().fc.skipTargetFind = !!mode;
    ed().fc.defaultCursor = mode ? 'crosshair' : 'default';
    ed().fc.getObjects().forEach(o => { if (o.role === 'region') { o.selectable = !mode; o.evented = !mode; } });
    ed().fc.renderAll();
    forceReview();
  };
  const finishPolyDrawLocal = (cancel) => {
    if (polyDraftShapeRef.current) { ed().fc.remove(polyDraftShapeRef.current); polyDraftShapeRef.current = null; }
    const build = polyBuildStateRef.current; polyBuildStateRef.current = null;
    const wasDrawing = regionDraw === 'polylasso' || regionDraw === 'maglasso';
    if (!cancel && build) {
      const sel = finishPolyBuild(build);
      if (sel) { const region = makeFreehandRegionObj(sel.pts); ed().fc.add(region); ed().fc.setActiveObject(region); }
    }
    if (wasDrawing) { setRegionDrawMode(null); return; }
    ed().fc.renderAll();
    forceReview();
  };
  const snapToEdgePt = (pt) => (ed()._edgeMap ? snapToEdge(ed()._edgeMap, pt) : pt);
  const reviewCanvasDown = (pt) => {
    if (!reviewStateRef.current || !regionDraw) return;
    if (regionDraw === 'object') {
      if (!reviewStateRef.current.srcImg) { setConvertMsg('Still preparing the image — click again in a moment.'); return; }
      setConvertMsg('');
      Promise.resolve(ed().objectPickInImage(reviewStateRef.current.srcImg, pt, ed().toolOpts.tolerance)).then(poly => {
        if (!poly) {
          // Wand + the box-seeded GrabCut fallback (editor.js#objectPickInImage) both failed to find
          // anything at this point — tell the user instead of leaving the click looking like a no-op,
          // which previously left no signal at all that anything had (or hadn't) happened.
          setConvertMsg('No object found here — try again or draw a box.');
          return;
        }
        const region = makeFreehandRegionObj(poly);
        ed().fc.add(region); ed().fc.setActiveObject(region); ed().fc.renderAll();
        if (!objMulti) { setRegionDrawMode(null); }
        else {
          const n = regionObjects().filter(o => o.type === 'polygon').length;
          setConvertMsg('Object added (' + n + ') · click more, or Merge');
          forceReview();
        }
      });
      return;
    }
    if (regionDraw === 'box' || regionDraw === 'lasso') {
      dragBuildRef.current = { mode: regionDraw, sel: startSelection(regionDraw === 'box' ? 'marquee' : 'lasso', pt), shape: null };
      return;
    }
    if (regionDraw === 'polylasso' || regionDraw === 'maglasso') {
      const p = regionDraw === 'maglasso' ? snapToEdgePt(pt) : pt;
      if (!polyBuildStateRef.current) polyBuildStateRef.current = startPolyBuild();
      const next = polyBuildAdd(polyBuildStateRef.current, p);
      if (next.closed) { polyBuildStateRef.current = next; finishPolyDrawLocal(false); }
      else { polyBuildStateRef.current = next; forceReview(); }
    }
  };
  const reviewCanvasMove = (pt) => {
    if (!reviewStateRef.current) return;
    const fc = ed().fc, fabric = ed().fabric;
    if (regionDraw === 'box' || regionDraw === 'lasso') {
      const d = dragBuildRef.current; if (!d) return;
      updateSelection(d.sel, pt);
      if (d.shape) fc.remove(d.shape);
      const s = d.sel;
      d.shape = s.kind === 'poly'
        ? new fabric.Polyline(s.pts, { role: 'draft', excludeFromExport: true, fill: REGION_COLOR.product + '19', stroke: REGION_COLOR.product, strokeWidth: 2, strokeDashArray: [6, 4], strokeUniform: true, selectable: false, evented: false })
        : new fabric.Rect({ role: 'draft', excludeFromExport: true, left: s.x, top: s.y, width: s.w, height: s.h, fill: REGION_COLOR.product + '19', stroke: REGION_COLOR.product, strokeWidth: 2, strokeDashArray: [6, 4], strokeUniform: true, selectable: false, evented: false });
      fc.add(d.shape);
      fc.requestRenderAll();
      return;
    }
    if ((regionDraw === 'polylasso' || regionDraw === 'maglasso') && polyBuildStateRef.current) {
      const p = regionDraw === 'maglasso' ? snapToEdgePt(pt) : pt;
      const preview = polyBuildPreview(polyBuildStateRef.current, p);
      if (polyDraftShapeRef.current) fc.remove(polyDraftShapeRef.current);
      polyDraftShapeRef.current = new fabric.Polyline(preview.pts, { role: 'draft', excludeFromExport: true, fill: 'transparent', stroke: REGION_COLOR.product, strokeWidth: 2, strokeDashArray: [6, 4], strokeUniform: true, selectable: false, evented: false });
      fc.add(polyDraftShapeRef.current);
      fc.requestRenderAll();
      return;
    }
    if (!regionDraw) reviewHoverMove(pt);
  };
  const reviewCanvasUp = () => {
    if (!reviewStateRef.current || !(regionDraw === 'box' || regionDraw === 'lasso') || !dragBuildRef.current) return;
    const fc = ed().fc, d = dragBuildRef.current;
    if (d.shape) fc.remove(d.shape);
    const sel = finalizeSelection(d.sel);
    dragBuildRef.current = null;
    if (sel) {
      const region = sel.kind === 'poly' ? makeFreehandRegionObj(sel.pts) : makeRegionRectObj({ type: 'product', bbox: { x: sel.x / ed().W * 100, y: sel.y / ed().H * 100, width: sel.w / ed().W * 100, height: sel.h / ed().H * 100 } });
      fc.add(region); fc.setActiveObject(region);
    }
    setRegionDrawMode(null);
  };
  // Live cutout preview: rest the cursor on a region box to see the exact silhouette Create/
  // Extract will cut (ed().cutoutRegion — same call both use). Debounced + cached by box id +
  // rounded bbox; skips polygon regions (already showing their exact traced shape) and single-
  // flights so overlapping mouse moves never stack concurrent cv calls — mirrors ditto's own
  // reviewRegionAt/computeReviewMask (reviewHoverBusyRef).
  const [reviewHoverPoly, setReviewHoverPoly] = useState(null);
  const reviewRegionAt = (pt) => {
    let best = null;
    regionObjects().forEach(o => {
      if (o.type === 'polygon') return;
      const b = regionBBox(o);
      if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h && (!best || b.w * b.h < best.b.w * best.b.h)) best = { o, b };
    });
    return best;
  };
  const reviewHoverMove = (pt) => {
    const hit = reviewRegionAt(pt);
    const H = reviewHoverRef.current;
    if (!hit) { clearTimeout(H.timer); if (H.key) { H.key = null; setReviewHoverPoly(null); } return; }
    const key = hit.o.id + '_' + Math.round(hit.b.x) + '_' + Math.round(hit.b.y) + '_' + Math.round(hit.b.w) + '_' + Math.round(hit.b.h) + '_' + bgMode;
    clearTimeout(H.timer);
    const cached = H.cache[key];
    if (cached) { H.key = key; setReviewHoverPoly(cached); return; }
    H.timer = setTimeout(async () => {
      if (H.busy || !reviewStateRef.current || !reviewStateRef.current.srcImg) return;
      H.busy = true;
      try {
        const poly = await ed().cutoutRegion(reviewStateRef.current.srcImg, hit.b, bgMode);
        if (poly && poly.length >= 3) { H.cache[key] = poly; H.key = key; setReviewHoverPoly(poly); }
      } finally { H.busy = false; }
    }, 160);
  };
  const hideReviewHover = () => { const H = reviewHoverRef.current; clearTimeout(H.timer); H.key = null; setReviewHoverPoly(null); };
  const loadImgEl = (src) => new Promise(res => { const img = new Image(); img.onload = () => res(img); img.src = src; });

  const mergeSelectedRegions = async () => {
    const fc = ed().fc, fabric = ed().fabric;
    const items = selectedRegions(); if (items.length < 2) return;
    const first = items[0];
    const hasPoly = items.some(o => o.type === 'polygon');
    let mergedPolys = null;
    if (hasPoly && ed().cv) {
      try {
        const polys = items.map(o => {
          if (o.type === 'polygon') { const m = o.calcTransformMatrix(), off = o.pathOffset || { x: 0, y: 0 }; return o.points.map(p => fabric.util.transformPoint(new fabric.Point(p.x - off.x, p.y - off.y), m)); }
          const b = regionBBox(o); return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];
        });
        mergedPolys = await ed().cv.union(ed().W, ed().H, polys);
      } catch (e) { mergedPolys = null; }
    }
    fc.discardActiveObject();
    items.forEach(o => fc.remove(o));
    if (mergedPolys && mergedPolys.length) {
      mergedPolys.forEach((pl, i) => {
        const r = makeFreehandRegionObj(pl);
        r.set({ regionType: first.regionType, rstyle: first.rstyle || null, fill: REGION_COLOR[first.regionType] + REGION_FILL_ALPHA, stroke: REGION_COLOR[first.regionType], name: first.renamed ? first.name : REGION_NAME[first.regionType], renamed: first.renamed });
        fc.add(r); if (i === 0) fc.setActiveObject(r);
      });
    } else {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      items.forEach(o => { const b = regionBBox(o); x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); });
      const merged = makeRegionRectObj({ type: first.regionType, name: first.renamed ? first.name : undefined, style: first.rstyle || undefined, bbox: { x: x1 / ed().W * 100, y: y1 / ed().H * 100, width: (x2 - x1) / ed().W * 100, height: (y2 - y1) / ed().H * 100 } });
      fc.add(merged); fc.setActiveObject(merged);
    }
    fc.renderAll();
    forceReview();
  };
  const mergeObjectRegions = async () => {
    const items = regionObjects().filter(o => o.type === 'polygon');
    if (items.length < 2) return;
    const fc = ed().fc, fabric = ed().fabric;
    fc.discardActiveObject();
    fc.setActiveObject(new fabric.ActiveSelection(items, { canvas: fc }));
    await mergeSelectedRegions();
  };
  const renameActiveRegion = (name) => {
    const o = activeRegion(); if (!o) return;
    o.set({ name, renamed: !!(name && name.trim()) });
    forceReview();
  };
  const setActiveRegionType = (t) => {
    const o = activeRegion(); if (!o) return;
    o.set({ regionType: t, stroke: REGION_COLOR[t], fill: REGION_COLOR[t] + REGION_FILL_ALPHA, cornerColor: REGION_COLOR[t] });
    if (!o.renamed) o.set('name', REGION_NAME[t]);
    ed().fc.renderAll();
    forceReview();
  };
  const removeActiveRegion = () => {
    const o = activeRegion(); if (!o) return;
    ed().fc.remove(o); ed().fc.discardActiveObject(); ed().fc.renderAll();
    forceReview();
  };
  const [extractBusy, setExtractBusy] = useState(false);
  const extractActiveRegion = async () => {
    const regs = selectedRegions();
    if (regs.length !== 1 || !reviewStateRef.current || extractBusy) return;
    const o = regs[0];
    setExtractBusy(true);
    try {
      const r = await ed().extractRegion(reviewStateRef.current.flat, regionToPayload(o), bgMode);
      if (r.status === 'ok') { ed().fc.remove(o); ed().fc.renderAll(); if (!regionObjects().length) closeReview(false); }
    } finally {
      setExtractBusy(false);
      forceReview();
    }
  };
  const [autodetectBusy, setAutodetectBusy] = useState(false);
  const autoDetectRegions = async () => {
    if (!reviewStateRef.current) return;
    setAutodetectBusy(true);
    try {
      const r = await ed().detectObjects({ text: true });
      if (r.status === 'ok') {
        const { boxes, textBoxes } = r.result;
        const covered = (t, o) => { const ix = Math.max(0, Math.min(t.x + t.w, o.x + o.w) - Math.max(t.x, o.x)), iy = Math.max(0, Math.min(t.y + t.h, o.y + o.h) - Math.max(t.y, o.y)); return (ix * iy) >= 0.7 * (t.w * t.h); };
        // Also skip anything an existing region (AI or hand-drawn) already covers — re-running
        // auto-detect used to stack a second box on every object that was already boxed.
        const existing = regionObjects().map(regionBBox);
        const inter = (a, o) => Math.max(0, Math.min(a.x + a.w, o.x + o.w) - Math.max(a.x, o.x)) * Math.max(0, Math.min(a.y + a.h, o.y + o.h) - Math.max(a.y, o.y));
        const fresh = (b) => !existing.some(o => covered(b, o) || inter(b, o) / Math.max(1, b.w * b.h + o.w * o.h - inter(b, o)) > 0.3);
        const txt = (textBoxes || []).filter(t => !boxes.some(o => covered(t, o)) && fresh(t));
        const add = (b, type) => ed().fc.add(makeRegionRectObj({ type, bbox: { x: b.x / ed().W * 100, y: b.y / ed().H * 100, width: b.w / ed().W * 100, height: b.h / ed().H * 100 } }));
        boxes.filter(fresh).forEach(b => add(b, 'product'));
        txt.forEach(b => add(b, 'text'));
        ed().fc.renderAll();
      }
    } finally {
      setAutodetectBusy(false);
      forceReview();
    }
  };
  const detectAndConvert = async () => {
    if (needKey) { setSideTab('ai'); return; }
    setConvertBusy(true);
    setConvertMsg('');
    try {
      const r = await ed().detectRegions();
      if (r.status === 'ok') {
        openReview(r.result.flat, r.result.regions);
        if (r.result.aiError) setConvertMsg(`AI detection failed (${r.result.aiError}) — showing the free local detection only.`);
        return;
      }
      // Every failure reason (no_provider / rate_limited / provider_failed / no_regions) now
      // surfaces to the user instead of the button silently resetting with no explanation —
      // previously detectAndConvert() just swallowed a non-'ok' status entirely.
      setConvertMsg(r.message || AI_REASON_MSG[r.reason] || r.reason || 'Detect failed — try again.');
    } catch (e) {
      setConvertMsg((e && e.message) ? e.message.slice(0, 120) : 'Detect failed — try again.');
    } finally {
      setConvertBusy(false);
    }
  };
  const selectOneManually = () => {
    openReview(ed().exportPNG(), []);
    const r = makeRegionRectObj({ type: 'product', bbox: { x: 38, y: 42, width: 24, height: 16 } });
    ed().fc.add(r); ed().fc.setActiveObject(r); ed().fc.renderAll();
  };
  const commitReview = async () => {
    if (!reviewStateRef.current || commitBusy) return;
    const regs = regionObjects();
    if (!regs.length) { closeReview(); return; }
    const regions = regs.map(regionToPayload);
    const flat = reviewStateRef.current.flat;
    // commitRegions runs real per-region CV work (grabCut cutouts) and can take a few seconds —
    // keep the review overlay up with a busy/spinner state INSTEAD of closing it immediately, so
    // the user gets feedback instead of a canvas that looks frozen while layers build underneath.
    setCommitBusy(true);
    try {
      await ed().commitRegions(flat, regions, bgMode);
    } finally {
      setCommitBusy(false);
      closeReview(true);
    }
  };
  // Wire Fabric canvas events for the whole review session — mirrors the demo's ed.fc.on(...)
  // wiring, scoped to the review lifetime via reviewOn.
  useEffect(() => {
    if (!reviewOn) return;
    const fc = ed().fc;
    const onDown = (opt) => reviewCanvasDown(fc.getPointer(opt.e));
    const onMoveEvt = (opt) => reviewCanvasMove(fc.getPointer(opt.e));
    const onUp = () => reviewCanvasUp();
    const onSel = () => forceReview();
    fc.on('mouse:down', onDown);
    fc.on('mouse:move', onMoveEvt);
    fc.on('mouse:up', onUp);
    fc.on('selection:created', onSel);
    fc.on('selection:updated', onSel);
    fc.on('selection:cleared', onSel);
    fc.on('object:modified', onSel);
    const onKey = (e) => {
      if (e.key === 'Enter' && (regionDraw === 'polylasso' || regionDraw === 'maglasso') && polyBuildStateRef.current) { e.preventDefault(); finishPolyDrawLocal(false); }
      else if (e.key === 'Escape') { e.preventDefault(); if (commitBusy) return; if (regionDraw) setRegionDrawMode(null); else closeReview(); }
    };
    document.addEventListener('keydown', onKey);
    const offZoom = ed().on('zoom', () => { hideReviewHover(); forceReview(); });
    const onResize = () => forceReview();
    window.addEventListener('resize', onResize);
    return () => {
      fc.off('mouse:down', onDown); fc.off('mouse:move', onMoveEvt); fc.off('mouse:up', onUp);
      fc.off('selection:created', onSel); fc.off('selection:updated', onSel); fc.off('selection:cleared', onSel); fc.off('object:modified', onSel);
      document.removeEventListener('keydown', onKey);
      offZoom(); window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewOn, regionDraw, objMulti, commitBusy]);
  // Re-render the AI-insert popover's screen position on pan/zoom/resize — same contract as review.
  const [, bumpAiInsert] = useState(0);
  useEffect(() => {
    if (!aiInsert) return;
    const off = ed().on('zoom', () => bumpAiInsert(n => n + 1));
    const onResize = () => bumpAiInsert(n => n + 1);
    window.addEventListener('resize', onResize);
    return () => { off(); window.removeEventListener('resize', onResize); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiInsert]);
  const submitAiInsert = async () => {
    const ai = aiInsert; if (!ai || !ai.prompt.trim() || ai.busy) return;
    if (needKey) { setAiInsert(null); ed().setTool('select'); setSideTab('ai'); return; }
    setAiInsert(a => a && ({ ...a, busy: true, msg: '' }));
    const r = await ed().aiInsertAt(ai.prompt.trim(), ai.pt);
    if (r.status === 'ok') { setAiInsert(null); ed().setTool('select'); }
    else setAiInsert(a => a && ({ ...a, busy: false, msg: r.message || r.reason || 'Could not generate that.' }));
  };

  // ── layer panel: thumbnails, rename, drag-to-reorder — ports the vanilla demo's layerThumb/
  // layerSubtitle/renderLayers click+drag handling onto React state instead of direct DOM writes.
  const layerThumb = (id) => {
    const o = ed()._findLayer(id);
    if (!o || !o.toDataURL) return null;
    const cached = thumbCacheRef.current.get(id);
    if (cached && cached.ver === thumbVerRef.current) return cached.url;
    try {
      const br = o.getBoundingRect ? o.getBoundingRect(true) : null;
      const dim = br ? Math.max(br.width || 1, br.height || 1) : 1;
      const mult = Math.max(0.03, Math.min(1, 56 / dim));
      const url = o.toDataURL({ format: 'png', multiplier: mult, enableRetinaScaling: false });
      thumbCacheRef.current.set(id, { ver: thumbVerRef.current, url });
      return url;
    } catch (e) { return null; }
  };
  const layerSubtitle = (l) => {
    const o = ed()._findLayer(l.id);
    if (!o) return l.role;
    const w = Math.round(o.getScaledWidth ? o.getScaledWidth() : (o.width || 0));
    const h = Math.round(o.getScaledHeight ? o.getScaledHeight() : (o.height || 0));
    return w && h ? `${w}×${h} ${l.role}` : l.role;
  };
  const commitRename = (id, value) => {
    setRenamingId(null);
    const v = value.trim();
    if (v) ed().setLayer(id, { name: v });
  };
  const onLayerRowClick = (l, e) => {
    // Shift/Cmd/Ctrl-click: add to / remove from a multi-selection (then ⌘G groups it).
    if (e && (e.shiftKey || e.metaKey || e.ctrlKey)) {
      lastLayerClickRef.current = null;
      // Shift = range from the selected layer, Cmd/Ctrl = add/remove one (Figma/Photoshop).
      if (e.shiftKey && !e.metaKey && !e.ctrlKey) ed().selectLayerRange(l.id); else ed().toggleLayerSelection(l.id);
      return;
    }
    // Manual double-click detection keyed on the layer id (not the DOM node), same reasoning as
    // the vanilla demo: activate() re-renders the row via React state on selection change, so a
    // native 'dblclick' (which needs both clicks on the SAME node) would miss the common
    // "click an unselected layer, then again to rename" gesture.
    const now = Date.now();
    const last = lastLayerClickRef.current;
    if (last && last.id === l.id && now - last.t < 400) {
      setRenamingId(l.id); lastLayerClickRef.current = null; return;
    }
    lastLayerClickRef.current = { id: l.id, t: now };
    if (!l.active) ed().activate(l.id);
  };
  const onLayerDragStart = (e, l) => {
    if (l.role === 'bg') { e.preventDefault(); return; }
    setDragLayerId(l.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', l.id);
  };
  // Top half of a row drops above it, bottom half below (it only went above: the bottom slot was unreachable).
  const lowerHalf = (e) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  const onLayerDragOver = (e, l) => {
    if (!dragLayerId || l.id === dragLayerId) return;
    e.preventDefault();
    const below = lowerHalf(e);
    if (dragOverId !== l.id) setDragOverId(l.id);
    if (dropBelow !== below) setDropBelow(below);
  };
  const onLayerDrop = (e, l) => {
    e.preventDefault();
    if (dragLayerId && l.id !== dragLayerId) ed().reorderLayerTo(dragLayerId, l.id, { after: lowerHalf(e) });
    setDragLayerId(null); setDragOverId(null);
  };
  const onLayerDragEnd = () => { setDragLayerId(null); setDragOverId(null); };

  const palette = THEMES[mode_] || THEMES.dark;
  const style = Object.fromEntries(Object.entries({ ...palette, 'accent-ink': palette.accentInk, ...theme })
    .filter(([k]) => k !== 'accentInk').map(([k, v]) => ['--cm-' + k, v]));
  /* Left panel (matches the vanilla demo's #left-panel): Layers / AI Vision tabs; the Layers view
     is a toolbar + the layer list + a contextual tool dock that only opens when the active tool has
     options or a pixel selection / clipped layer / mask edit is live — so with plain Select the
     panel is just the list; the AI card is pinned under both tabs. */
  // Per-shape tile glyphs (l.shape, from describeLayer) — same table as the vanilla demo's.
  const SHAPE_ICON = { rect: 'square', ellipse: 'ellipse', triangle: 'triangle', line: 'line', polygon: 'polygon', star: 'star', pen: 'pen', freehand: 'brush' };
  const KIND_ICON = { group: 'folder', shape: 'rect', badge: 'tag', adjustment: 'contrast', bg: 'image', paint: 'brush', image: 'image' };
  const layerTile = (l) => {
    const raster = l.kind === 'image' || l.kind === 'paint' || (l.kind === 'bg' && !l.fill);
    const thumb = raster ? layerThumb(l.id) : null;
    if (thumb) return <span className="cm-layer-thumb"><img src={thumb} alt="" /></span>;
    if (l.kind === 'text') return <span className="cm-layer-thumb" data-kind="text">Aa</span>;
    if (l.kind === 'bg' && l.fill) return <span className="cm-layer-thumb"><span style={{ width: 18, height: 18, borderRadius: 5, background: l.fill, border: '1px solid var(--cm-line)' }} /></span>;
    const tint = (l.kind === 'shape' || l.kind === 'badge') && l.fill && /^#|^rgb/.test(l.fill) ? l.fill : null;
    return <span className="cm-layer-thumb" data-tint={tint ? '' : undefined} style={tint ? { '--tile': tint } : undefined}><Icon name={(l.kind === 'shape' && SHAPE_ICON[l.shape]) || KIND_ICON[l.kind] || 'box'} size={15} /></span>;
  };
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  const toggleFold = (id) => setCollapsedGroups(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // A group row whose member is focused hands the highlight to that member's row, unless the group
  // is folded and that row isn't shown (same as the demo).
  const layerRow = (l) => (
    <div key={l.id} className="cm-layer" role="listitem" data-on={(l.selected || l.active || l.childActive) && !(l.childActive && !collapsedGroups.has(l.id))} data-visible={l.visible} data-dragover={dragOverId === l.id} data-drop={dragOverId === l.id ? (dropBelow ? 'below' : 'above') : undefined} data-dragging={dragLayerId === l.id}
      data-child={l.parentId ? true : undefined} aria-expanded={l.isGroup ? !collapsedGroups.has(l.id) : undefined}
      draggable={l.role !== 'bg'}
      onDragStart={e => onLayerDragStart(e, l)} onDragOver={e => onLayerDragOver(e, l)}
      onDragLeave={() => setDragOverId(id => id === l.id ? null : id)} onDrop={e => onLayerDrop(e, l)} onDragEnd={onLayerDragEnd}
      onClick={e => { if (renamingId !== l.id) onLayerRowClick(l, e); }}>
      <span className="cm-lr-toggles">
        <button className="cm-eye" title={l.visible ? 'Hide' : 'Show'} aria-pressed={!l.visible} data-active={!l.visible} onClick={stop(() => ed().setLayer(l.id, { visible: !l.visible }))}><Icon name={l.visible ? 'eye' : 'eyeOff'} size={14} /></button>
        <button className="cm-eye" title={l.locked ? 'Unlock' : 'Lock'} aria-pressed={l.locked} data-active={l.locked} onClick={stop(() => ed().setLayer(l.id, { locked: !l.locked }))}><Icon name={l.locked ? 'lock' : 'unlock'} size={13} /></button>
      </span>
      {l.isGroup && (
        <button className="cm-lr-fold" title={collapsedGroups.has(l.id) ? 'Expand group' : 'Collapse group'} aria-label={collapsedGroups.has(l.id) ? 'Expand group' : 'Collapse group'}
          onClick={stop(() => toggleFold(l.id))}><Icon name="chevronD" size={13} /></button>
      )}
      {layerTile(l)}
      {renamingId === l.id ? (
        <input className="cm-layer-rename" defaultValue={l.name} autoFocus
          onClick={e => e.stopPropagation()}
          onFocus={e => e.target.select()}
          onKeyDown={e => { if (e.key === 'Enter') commitRename(l.id, e.target.value); else if (e.key === 'Escape') setRenamingId(null); }}
          onBlur={e => commitRename(l.id, e.target.value)} />
      ) : (
        <span className="cm-layer-meta">
          <span className="nm" title={l.name}>{l.name}</span>
          <span className="sub">{l.subtitle || layerSubtitle(l)}</span>
        </span>
      )}
      <span className="cm-layer-actions">
        {/* no row "Move up": on hover it covered the name, so a click meant to select reordered the layer */}
        {l.maskable && (l.hasMask ? (
          <React.Fragment>
            <button title={l.editingMask ? 'Stop editing mask' : 'Edit mask'} data-active={l.editingMask || !l.maskEnabled}
              onClick={stop(() => { if (l.editingMask) ed().exitMaskEdit(); else { ed().activate(l.id); ed().enterMaskEdit(l.id); } })}><Icon name="mask" size={12} /></button>
            <button title="Delete mask" onClick={stop(() => ed().removeMask(l.id))}><Icon name="maskoff" size={12} /></button>
          </React.Fragment>
        ) : (
          <button title="Add layer mask" onClick={stop(() => { ed().addMask(l.id); ed().enterMaskEdit(l.id); })}><Icon name="mask" size={12} /></button>
        ))}
        {l.role !== 'bg' && <button title="Delete layer" onClick={stop(() => ed().removeLayer(l.id))}><Icon name="trash" size={12} /></button>}
      </span>
    </div>
  );
  // Recursive: a group nested inside a group renders its own indented block of members.
  const layerTree = (l) => !l.isGroup ? layerRow(l) : (
    <React.Fragment key={l.id}>
      {layerRow(l)}
      {!collapsedGroups.has(l.id) && <div className="cm-layer-children" role="group">{l.children.map(layerTree)}</div>}
    </React.Fragment>
  );
  /* Several frames: grouped Figma-style — each frame is a folder row with its layers nested inside.
     One frame: the flat list as before. */
  const layerRows = frames.length < 2 ? layers.map(layerTree) : frames.map(f => {
    const ls = layers.filter(l => (l.frameId === f.id) || (!frames.some(x => x.id === l.frameId) && f.id === frames[0].id));
    const open = !collapsedFrames.has(f.id);
    return (
      <React.Fragment key={'frame-' + f.id}>
        <div className="cm-frame-head" role="listitem" data-on={f.active} aria-expanded={open} title={f.name + ' \u2014 click to work in this frame'}
          onClick={() => ed().activateFrame(f.id)}>
          <button className="cm-fh-fold" data-open={open} aria-label={open ? 'Collapse frame' : 'Expand frame'}
            onClick={(e) => { e.stopPropagation(); setCollapsedFrames(prev => { const n = new Set(prev); n.has(f.id) ? n.delete(f.id) : n.add(f.id); return n; }); }}><Icon name="chevronD" size={13} /></button>
          <span className="cm-fh-ico"><Icon name="frame" size={13} /></span><span className="cm-fh-name">{f.name}</span><span className="cm-fh-count">{ls.length}</span>
        </div>
        {open && <div className="cm-frame-layers" role="group">{ls.length ? ls.map(layerTree) : <div className="cm-frame-empty">No layers</div>}</div>}
      </React.Fragment>
    );
  });
  const ADD_ITEMS = [['type', 'Text', () => ed().setTool('type')], ['rect', 'Rectangle', () => ed().setTool('rect')], ['ellipse', 'Ellipse', () => ed().setTool('ellipse')], ['image', 'Image…', addImagePick], ['brush', 'Paint layer', () => ed().setTool('brush')]];
  const layersToolbar = (
    <div className="cm-lp-toolbar">
      <button className="cm-lp-tbtn" title="Add layer" aria-haspopup="menu" aria-expanded={addMenuOpen} onClick={e => { e.stopPropagation(); setAddMenuOpen(v => !v); }}><Icon name="addcircle" size={16} /></button>
      {addMenuOpen && (
        <div className="cm-lp-menu" role="menu" onKeyDown={e => { if (e.key === 'Escape') setAddMenuOpen(false); }}>
          {ADD_ITEMS.map(([ic, label, fn], i) => (
            <button key={label} role="menuitem" autoFocus={i === 0} onClick={() => { setAddMenuOpen(false); fn(); }}><Icon name={ic} size={14} /><span>{label}</span></button>
          ))}
        </div>
      )}
      <button className="cm-lp-tbtn" title="Group selected layers" disabled={!props.canGroup} onClick={groupSel}><Icon name="folderplus" size={16} /></button>
      <button className="cm-lp-tbtn" title="Add adjustment layer" onClick={() => ed().addAdjustmentLayer()}><Icon name="contrast" size={16} /></button>
      <span style={{ flex: 1 }} />
      <button className="cm-lp-tbtn" title={snapOn ? 'Snap to grid: on' : 'Snap to grid: off'} aria-pressed={snapOn} data-on={snapOn} onClick={toggleSnap}><Icon name="magnet" size={16} /></button>
      <button className="cm-lp-tbtn" title="Duplicate layer" disabled={!activeLayer} onClick={duplicate}><Icon name="duplicate" size={16} /></button>
      <button className="cm-lp-tbtn" title="Delete layer" disabled={!activeLayer} onClick={() => activeLayer && ed().removeLayer(activeLayer.id)}><Icon name="trash" size={16} /></button>
    </div>
  );
  const activeObj = edRef.current && edRef.current.fc && edRef.current.fc.getActiveObject();
  const activeHasClip = !!(activeObj && activeObj.clipPath);
  const selRelevant = !!props.hasSelectionPixels || SEL_TOOLS.includes(tool) || activeHasClip;
  const dockOpen = reviewOn || tool !== 'select' || selRelevant || !!maskEdit;
  const aiProvider = edRef.current && edRef.current.ai && edRef.current.ai._provider;
  const aiKeyed = !!(aiProvider && (typeof aiProvider.hasKey !== 'function' || aiProvider.hasKey()));
  useEffect(() => {
    if (!addMenuOpen) return;
    const close = (e) => { if (!e.target.closest || !e.target.closest('.cm-lp-menu')) setAddMenuOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [addMenuOpen]);
  // The active tool's options + hint. Rendered at the top of the right Properties tab; during a
  // convert-to-layers review (which takes over the right panel) it stays on the left instead.
  const toolDock = dockOpen ? (
      <div className="cm-dock cm-scroll">
        {tool === 'crop' && (
          <React.Fragment>
            <button className="cm-btn cm-btn-accent" title="Apply crop (Enter)" style={{ marginBottom: 8, width: '100%', justifyContent: 'center' }} onClick={() => ed().applyCrop()}>✓ Apply crop <span className="cm-key-hint">↵ Enter</span></button>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--cm-line-soft)' }}>
            {CROP_RATIOS.map(([label, r]) => (
              // The picked chip is the lit one (a 9:16 photo's Original is also 9:16), and "Original"
              // is the shape of what's being cropped — the image layer, not the page.
              <button key={label} className="cm-chip" data-on={cropChip === label} onClick={() => { setCropChip(label); ed().setToolOptions({ cropRatio: r === 'orig' ? ed().cropOriginalRatio() : r }); }}>{label}</button>
            ))}
          </div>
          </React.Fragment>
        )}
        {tool === 'pen' && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => ed().finishPen()}>✓ Finish path</button>
              <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => ed().cancelPen()}>Cancel</button>
            </div>
            <div className="cm-slider-row" title="Stroke width for open paths">Stroke <input type="range" min="1" max="40" value={opts.penStrokeWidth != null ? opts.penStrokeWidth : 3} onChange={e => ed().setToolOptions({ penStrokeWidth: +e.target.value })} /><span className="cm-tag mono">{opts.penStrokeWidth != null ? opts.penStrokeWidth : 3}</span></div>
          </div>
        )}
        {maskEdit && (
          <div style={{ background: 'var(--cm-accent)', color: 'var(--cm-accent-ink)', borderRadius: 8, padding: '8px 10px', marginBottom: 10, fontSize: 12, fontWeight: 600 }}>
            Editing layer mask — paint white to reveal, black to hide.
            {/* offline cut-outs only: strokes become hints and the cut is re-run around them */}
            {ed().canRefineCutout(maskEdit.layerId) && (
              <div style={{ marginTop: 8, fontWeight: 500 }}>
                Touch up the cut-out — paint over what to keep or remove:
                <div className="cm-seg" role="group" aria-label="Touch-up brush" style={{ marginTop: 6 }}>
                  {[['keep', 'Keep'], ['remove', 'Remove']].map(([m, l]) => (
                    <button key={m} className="cm-btn" data-on={maskRefine === m} aria-pressed={maskRefine === m}
                      onClick={() => ed().setMaskRefine(maskRefine === m ? null : m)}>{l}</button>
                  ))}
                </div>
              </div>
            )}
            <div className="cm-row" style={{ marginTop: 8 }}>
              <button className="cm-btn" style={{ flex: 1, justifyContent: 'center', background: 'var(--cm-panel)', color: 'var(--cm-ink)' }} onClick={() => ed().invertMask(maskEdit.layerId)} title="Swap hidden/visible across the whole mask">
                Invert mask
              </button>
              <button className="cm-btn" style={{ flex: 1, justifyContent: 'center', background: 'var(--cm-panel)', color: 'var(--cm-ink)' }} onClick={() => ed().exitMaskEdit()}>
                Done editing mask
              </button>
            </div>
          </div>
        )}
        {/* SELECT & TRANSFORM header + "Active" status pill — names the section rather than
            just echoing the raw tool id, matching the demo's tool-name/tool-status-pill. */}
        <div className="cm-dock-head">
          <Icon name={tool} size={14} />
          <span>{tool === 'select' ? 'Select & Transform' : (TOOL_LABELS[tool] || tool)}</span>
          <span className="cm-status-pill">Active</span>
        </div>
        <div className="cm-note" style={{ marginTop: 4 }}>
          {(tool === 'clone' || tool === 'heal') && cloneSrc
            ? `Source set at ${Math.round(cloneSrc.x)}, ${Math.round(cloneSrc.y)} — now paint to ${tool === 'heal' ? 'heal with' : 'stamp'} those pixels. ⌥/⇧-click to re-source.`
            : (TOOL_HINTS[tool] || 'Drag on the canvas to use this tool.')}
        </div>
        {/* colour-match tolerance for the magic wand and the paint bucket (only reachable via [ ] before) */}
        {(tool === 'wand' || tool === 'bucket') && (() => {
          const key = tool === 'bucket' ? 'bucketTolerance' : 'tolerance';
          return (
            <div className="cm-slider-row" style={{ marginTop: 10 }} title="How different a colour can be and still be included">Tolerance
              <input type="range" min="0" max="128" value={opts[key]} onChange={e => ed().setToolOptions({ [key]: +e.target.value })} />
              <span className="cm-val">{opts[key]}</span>
            </div>
          );
        })()}


        {/* Brush/Color section — only the sliders+swatches a given tool can actually read
            (see COLOR_TOOLS/isPaintTool below), moved out of the always-visible header. */}
        {isColorTool && (
          <React.Fragment>
            {isPaintTool && (
              <React.Fragment>
                <div className="cm-slider-row">Size <input type="range" min="2" max="220" value={opts.size} onChange={e => ed().setToolOptions({ size: +e.target.value })} /><span className="cm-tag mono">{opts.size}</span></div>
                {/* "Soft" is the inverse of the engine's hardness (0 hardness = fully soft
                    edge) — same knob, flipped so the UI reads as "how soft" not "how hard". */}
                <div className="cm-slider-row" style={{ marginTop: 6 }}>Soft <input type="range" min="0" max="100" value={Math.round((1 - opts.hardness) * 100)} onChange={e => ed().setToolOptions({ hardness: 1 - (+e.target.value / 100) })} /><span className="cm-tag mono">{Math.round((1 - opts.hardness) * 100)}%</span></div>
                <div className="cm-slider-row" style={{ marginTop: 6 }}>Opacity <input type="range" min="5" max="100" value={Math.round(opts.opacity * 100)} onChange={e => ed().setToolOptions({ opacity: +e.target.value / 100 })} /><span className="cm-tag mono">{Math.round(opts.opacity * 100)}%</span></div>
              </React.Fragment>
            )}
            {/* Colour only for tools that paint WITH it — the eraser/clone/heal/tone tools ignore it. */}
            {!NO_COLOR_TOOLS.includes(tool) && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
              {/* A mask is only black (hide) or white (reveal): no colour picker or colour swatches while editing one. */}
              {!maskEdit && <input type="color" value={opts.color} onChange={e => ed().setToolOptions({ color: e.target.value, fill: e.target.value })} title="Colour" />}
              <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                {BRUSH_SWATCHES.filter(c => !maskEdit || c === '#ffffff' || c === '#000000').map(c => (
                  <button key={c} className="cm-swatch-btn" data-on={c.toLowerCase() === (opts.color || '').toLowerCase()}
                    style={{ background: c }} title={c}
                    onClick={() => ed().setToolOptions({ color: c, fill: c })} />
                ))}
              </div>
            </div>}
          </React.Fragment>
        )}
        {/* Clone/Heal need a source point before they do anything at all, and nothing on
            the canvas says so — this states the step you're on and offers a reset. */}
        {(tool === 'clone' || tool === 'heal') && (
          <div>
            <div className="cm-grp">{tool === 'heal' ? 'Heal from a chosen spot (optional)' : 'Clone stamp'}</div>
            <div className="cm-note" style={{ marginTop: 6 }}>
              {cloneSrc
                ? `Source set at ${Math.round(cloneSrc.x)}, ${Math.round(cloneSrc.y)} — now paint to ${tool === 'heal' ? 'heal with' : 'stamp'} those pixels.`
                : tool === 'heal' ? 'No source: strokes heal from the surroundings. ⌥/⇧-click a spot to heal from it instead.'
                : 'Step 1 — hold ⌥ (Alt) or ⇧ (Shift) and click the area you want to copy FROM.'}
            </div>
            <button className="cm-btn" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }}
              disabled={!cloneSrc} onClick={() => ed().clearCloneSource()}>
              Reset source
            </button>
            <div className="cm-note" style={{ marginTop: 8 }}>⌥-click or ⇧-click re-sources at any time</div>
          </div>
        )}
        {/* Destructive-vs-new-layer, for every pixel tool: by default strokes edit the
            image itself (at its own resolution), which is what a photo editor does. */}
        {isPaintTool && tool !== 'eraser' && (
          <div>
            <div className="cm-grp">Destination</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!opts.paintNewLayer} onChange={e => ed().setToolOptions({ paintNewLayer: e.target.checked })} />
              <span>Paint on a new layer</span>
            </label>
            <div className="cm-note" style={{ marginTop: 6 }}>
              {opts.paintNewLayer
                ? 'Strokes go to a separate paint layer — the original image is left untouched.'
                : 'Editing the image itself (the selected layer, or the top image), at its own resolution.'}
            </div>
          </div>
        )}

        {tool === 'magicwand' && (
          <React.Fragment>
            <div className="cm-note" style={{ marginTop: 8 }}>
              {objselectBusy ? 'Finding object…'
                : selCount > 1 ? selCount + ' selected · ⇧-click (or Add) to keep combining'
                : selCount === 1 ? 'Selected · ⇧-click to add more, ⌥-click to subtract'
                : 'Click an object to select it'}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="cm-chip" data-on={opts.addMode}
              onClick={() => ed().setToolOptions({ addMode: !opts.addMode })}>
              <Icon name="spark" size={12} /><span>Add{opts.addMode ? ' ✓' : ''}</span>
            </button>
            </div>
            <label style={{ display: 'block', marginTop: 8, fontSize: 11, color: 'var(--cm-dim)' }}>Tolerance
              <input type="range" min="4" max="128" value={opts.tolerance} style={{ width: '100%' }}
                onChange={e => ed().setToolOptions({ tolerance: +e.target.value })} />
            </label>
            <div className="cm-note" style={{ marginTop: 8 }}>⇧ add · ⌥ subtract · [ ] tolerance</div>
          </React.Fragment>
        )}
        {(tool === 'objectselect' || tool === 'hoverselect') && (
          <React.Fragment>
            <div className="cm-row" style={{ alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <span style={{ fontWeight: 600 }}>{tool === 'hoverselect' ? 'Hover select' : 'Object select'}</span>
              <button className="cm-toggle" data-on={opts.addMode}
                title="Keep adding each clicked object to the selection (same as holding Shift)"
                onClick={() => ed().setToolOptions({ addMode: !opts.addMode })}>
                Add{opts.addMode ? ' ✓' : ''}
              </button>
            </div>
            <div className="cm-note" style={{ marginTop: 6 }}>
              {objselectBusy ? 'Finding object…'
                : selCount > 1 ? selCount + ' selected · Merge to combine'
                : objCount ? objCount + (tool === 'hoverselect' ? ' objects · hover to preview, click to select' : ' objects · click to select')
                : 'No objects found — re-detect'}
            </div>
            <label style={{ display: 'block', marginTop: 8, fontSize: 11, color: 'var(--cm-dim)' }}
              title="How close in colour a pixel must be to the clicked spot to seed the object. Higher = grabs more of the colour before the object is completed.">
              Colour match
              <input type="range" min="4" max="96" value={opts.tolerance} style={{ width: '100%' }}
                onChange={e => ed().setToolOptions({ tolerance: +e.target.value })} />
            </label>
            <div className="cm-row" style={{ marginTop: 8 }}>
              <button className="cm-btn" style={{ width: '100%', justifyContent: 'center' }} disabled={objselectBusy || selCount < 2}
                title="Select 2+ objects (⇧-click or the Add toggle), then merge them into one shape via polygon clipping"
                onClick={mergeSel}>Merge{selCount > 1 ? ' (' + selCount + ')' : ''}</button>
            </div>
            <div className="cm-row" style={{ marginTop: 6 }}>
              <button className="cm-btn" disabled={objselectBusy || !selCount} onClick={expandSel}>Expand</button>
              <button className="cm-btn" disabled={objselectBusy || !selCount} onClick={contractSel}>Contract</button>
            </div>
            <button className="cm-btn" style={{ marginTop: 6, width: '100%', justifyContent: 'center' }}
              disabled={objselectBusy} title="Select every region on the canvas matching the colour you last clicked, within Colour match"
              onClick={selectSimilar}>Similar</button>
            {!!selCount && (
              <button className="cm-btn" style={{ marginTop: 6, width: '100%', justifyContent: 'center' }}
                onClick={() => ed().clearSelection()}>Deselect</button>
            )}
            <button className="cm-btn" style={{ marginTop: 6, width: '100%', justifyContent: 'center' }}
              disabled={objselectBusy} onClick={redetectObjects}>Re-detect</button>
            <div className="cm-note" style={{ marginTop: 8 }}>⇧ add · ⌥ subtract · [ ] tolerance · re-click cycles nested</div>
          </React.Fragment>
        )}

        {tool === 'gradient' && (
          <div>
            <div className="cm-grp">Gradient</div>
            <div className="cm-row">
              <button className="cm-btn" data-on={opts.gradientType === 'linear'} onClick={() => ed().setToolOptions({ gradientType: 'linear' })}>Linear</button>
              <button className="cm-btn" data-on={opts.gradientType === 'radial'} onClick={() => ed().setToolOptions({ gradientType: 'radial' })}>Radial</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {opts.gradientStops.map((stop, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="color" value={stop.color} onChange={e => {
                    const stops = opts.gradientStops.map((s, si) => si === i ? { ...s, color: e.target.value } : s);
                    ed().setToolOptions({ gradientStops: stops });
                  }} />
                  <input type="range" min="0" max="1" step="0.01" value={stop.offset} style={{ flex: 1 }} title="Position" onChange={e => {
                    const stops = opts.gradientStops.map((s, si) => si === i ? { ...s, offset: +e.target.value } : s);
                    ed().setToolOptions({ gradientStops: stops });
                  }} />
                  <input type="range" min="0" max="1" step="0.01" value={stop.alpha ?? 1} style={{ flex: 1 }} title="Opacity" onChange={e => {
                    const stops = opts.gradientStops.map((s, si) => si === i ? { ...s, alpha: +e.target.value } : s);
                    ed().setToolOptions({ gradientStops: stops });
                  }} />
                  <button className="cm-icon-btn" disabled={opts.gradientStops.length <= 2} title="Remove stop"
                    onClick={() => ed().setToolOptions({ gradientStops: opts.gradientStops.filter((_, si) => si !== i) })}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
            </div>
            <div className="cm-row" style={{ marginTop: 6 }}>
              <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => {
                const last = opts.gradientStops[opts.gradientStops.length - 1];
                ed().setToolOptions({ gradientStops: [...opts.gradientStops, { offset: Math.min(1, last?.offset ?? 1), color: last?.color || '#ffffff', alpha: last?.alpha ?? 1 }] });
              }}>+ Add stop</button>
              <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} title="Reverse stop order"
                onClick={() => ed().setToolOptions({ gradientStops: opts.gradientStops.map(s => ({ ...s, offset: 1 - s.offset })).sort((a, b) => a.offset - b.offset) })}>
                <Icon name="flip" size={13} /> Reverse
              </button>
            </div>
            <div className="cm-note">Drag on the canvas to paint the gradient.</div>
          </div>
        )}


        {selRelevant && (
          <div>
            <div className="cm-grp">Selection</div>
            <div className="cm-row">
              <button className="cm-btn" disabled={!props.hasSelectionPixels} onClick={expandSel}><Icon name="expand" size={13} /> Expand</button>
              <button className="cm-btn" disabled={!props.hasSelectionPixels} onClick={contractSel}><Icon name="contract" size={13} /> Contract</button>
            </div>
            <div className="cm-slider-row" style={{ marginTop: 6 }} title="How far Expand / Contract move the edge">Amount <input type="range" min="1" max="100" value={morphPx} onChange={e => setMorphPx(+e.target.value)} /><span className="cm-tag mono">{morphPx}px</span></div>
            <div className="cm-note" style={{ marginTop: 4 }}>Drag a white point on the outline to reshape it (⌘/Ctrl-drag moves just that point; drag an edge to add a point). Dragging inside moves it, arrows nudge.</div>
            <div className="cm-slider-row" style={{ marginTop: 6 }} title="Soften the selection edge (Photoshop's Feather). Applies when you copy, move or recolour the selection.">
              Feather <input type="range" min="0" max="100" disabled={!props.hasSelectionPixels} value={props.hasSelectionPixels ? (props.selFeather || 0) : 0}
                onChange={e => { ed().featherSelection(+e.target.value); }} />
              <span className="cm-tag mono">{props.hasSelectionPixels ? (props.selFeather || 0) : 0}px</span>
            </div>
            <button className="cm-btn" style={{ marginTop: 6, width: '100%', justifyContent: 'center' }} disabled={!props.hasSelectionPixels} onClick={selectSimilar}>
              <Icon name="similar" size={13} /> Select Similar Colors
            </button>
            <label className="cm-btn" style={{ marginTop: 6, width: '100%', justifyContent: 'center', opacity: props.hasSelectionPixels ? 1 : 0.4, pointerEvents: props.hasSelectionPixels ? 'auto' : 'none' }}>
              <Icon name="eyedropper" size={13} /> Recolor selection…
              <input type="color" style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
                onChange={e => recolorSel(e.target.value)} />
            </label>
            <div className="cm-row" style={{ marginTop: 6 }}>
              <button className="cm-btn" disabled={!props.hasSelectionPixels} onClick={clipToSel}><Icon name="crop" size={13} /> Clip layer to selection</button>
              <button className="cm-btn" disabled={!hasResolvableLayer()} onClick={clearClip}><Icon name="close" size={13} /> Clear clip</button>
            </div>
            <div className="cm-note">{selMsg || (!props.hasSelectionPixels ? 'Draw a marquee/lasso selection first — for a text or shape layer’s colour, use Fill in Properties instead.' : '')}</div>
          </div>
        )}
        {!selRelevant && selMsg && <div className="cm-note">{selMsg}</div>}
      </div>
  ) : null;
  return (
    <div className="cm-root" ref={rootRef} style={style} data-cm-mode={mode_} data-left-collapsed={leftCollapsed} data-side-collapsed={sideCollapsed}>
      <style>{CSS}</style>
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs><linearGradient id="cm-grad-icon" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--cm-accent)" /><stop offset="1" stopColor="var(--cm-ink)" />
        </linearGradient></defs>
      </svg>
      <div className="cm-top">
        <strong style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2.5, background: 'var(--cm-accent)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--cm-accent) 18%, transparent)' }} />
          Canvasmith
        </strong>
        <span className="cm-hdiv" />
        <button className="cm-btn" title="Start a new document (clears the current one)" onClick={newDocument}><Icon name="plus" size={13} /> New</button>
        <button className="cm-btn" title="Open image…" onClick={openImagePick}><Icon name="folder" size={15} /> Open image…</button>
        <span style={{ flex: 1 }} />
        <button className="cm-icon-btn" title="Undo" disabled={hist.past < 2} onClick={() => ed().undo()}><Icon name="undo" size={14} /></button>
        <button className="cm-icon-btn" title="Redo" disabled={!hist.future} onClick={() => ed().redo()}><Icon name="redo" size={14} /></button>
        <span className="cm-hdiv" />
        <button className="cm-btn" title="Search tools & actions (⌘K)" onClick={openCmdk}>
          <Icon name="search" size={13} /><span style={{ color: 'var(--cm-dim)', fontSize: 11.5 }}>Search</span><span className="cm-tag mono" style={{ fontSize: 9.5 }}>⌘K</span>
        </button>
        <span className="cm-hdiv" />
        <span style={{ position: 'relative' }}>
          <button className="cm-btn" title="Feather — soften the edge of the selection, or of the selected image" onClick={() => setFeatherOpen(o => !o)}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="8" strokeDasharray="1 3.2" /><circle cx="12" cy="12" r="10.8" strokeDasharray=".1 4.6" opacity=".6" /></svg>
            <span>Feather</span>
          </button>
          {featherOpen && (() => {
            const ft = ed().featherTarget(), kind = ft ? ft.kind : null, val = ft ? ft.value : 0;
            return (
              <div style={{ position: 'absolute', left: 0, top: 'calc(100% + 6px)', zIndex: 60, width: 230, background: 'var(--cm-panel)', border: '1px solid var(--cm-line)', borderRadius: 10, padding: 14, boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: 12 }}>Feather</h4>
                <div style={{ fontSize: 11.5, marginBottom: 6 }}>{kind === 'selection' ? 'Applies to: selection' : kind === 'layer' ? 'Applies to: selected image' : 'Nothing to feather yet'}</div>
                {kind === 'layer' && (
                  <div className="cm-seg" role="group" aria-label="Apply feather as" style={{ marginBottom: 8 }}>
                    <button type="button" className="cm-btn" data-on={String(featherMode === 'mask')} title="Non-destructive: a layer mask you can edit or remove" onClick={() => setFeatherMode('mask')}>As mask</button>
                    <button type="button" className="cm-btn" data-on={String(featherMode === 'layer')} title="Permanent: fades the image's own pixels (undo to revert)" onClick={() => setFeatherMode('layer')}>On the layer</button>
                  </div>
                )}
                {(() => { const bake = kind === 'layer' && featherMode === 'layer', shown = bake ? featherDraft : val; return (
                  <div className="cm-slider-row"><input type="range" min="0" max="150" disabled={!kind} value={shown}
                    onChange={e => { const v = +e.target.value; if (kind === 'selection') ed().featherSelection(v); else if (bake) setFeatherDraft(v); else ed().setEdgeFeather(null, v); }} /><span className="cm-val">{shown}px</span></div>
                ); })()}
                {kind === 'layer' && featherMode === 'layer' && (
                  <button className="cm-btn" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }} disabled={!featherDraft}
                    onClick={() => { ed().setEdgeFeather(null, featherDraft, { bake: true }); setFeatherDraft(0); }}>Apply to layer</button>
                )}
                <div className="cm-note" style={{ marginTop: 8 }}>{!kind ? 'Select an image layer, or draw a marquee/lasso selection, then drag the slider.' : kind === 'selection' ? 'Shows when you copy (⌘J), move or recolor the selection.' : 'Fades the image edges into what is behind it.'}</div>
                <button className="cm-btn" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }} onClick={() => setFeatherOpen(false)}>Done</button>
              </div>
            );
          })()}
        </span>
        <span style={{ position: 'relative' }}>
          <button className="cm-btn" onClick={openCanvasSize}>Canvas size</button>
          {csOpen && (
            <div style={{
              position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 60, width: 220,
              background: 'var(--cm-panel)', border: '1px solid var(--cm-line)', borderRadius: 10,
              padding: 14, boxShadow: '0 8px 24px rgba(0,0,0,.35)',
            }}>
              <h4 style={{ margin: '0 0 10px', fontSize: 12 }}>Canvas size</h4>
              <select className="cm-select" style={{ width: '100%', marginBottom: 8 }} defaultValue=""
                onChange={e => {
                  if (!e.target.value) return;
                  const [w, h] = e.target.value.split('x').map(Number);
                  setCsW(w); setCsH(h);
                  e.target.value = '';
                }}>
                <option value="">Preset…</option>
                {CANVAS_PRESETS.map(([group, sizes]) => (
                  <optgroup key={group} label={group}>
                    {sizes.map(([name, w, h]) => (
                      <option key={name} value={`${w}x${h}`}>{name} — {w}×{h}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <div style={{ display: 'flex', gap: 8 }}>
                <label style={{ flex: 1, fontSize: 11 }}>W
                  <input type="number" min="1" max="8000" value={csW} style={{ width: '100%' }}
                    onChange={e => { const w = +e.target.value; setCsW(w); if (csLock) setCsH(Math.round(w * (ed().H / ed().W)) || ''); }} />
                </label>
                <label style={{ flex: 1, fontSize: 11 }}>H
                  <input type="number" min="1" max="8000" value={csH} style={{ width: '100%' }}
                    onChange={e => { const h = +e.target.value; setCsH(h); if (csLock) setCsW(Math.round(h * (ed().W / ed().H)) || ''); }} />
                </label>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11.5 }}>
                <input type="checkbox" checked={csLock} onChange={e => setCsLock(e.target.checked)} /> Lock aspect ratio
              </label>
              <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setCsOpen(false)}>Cancel</button>
                <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={applyCanvasSize}>Apply</button>
              </div>
            </div>
          )}
        </span>
        <div className="cm-zoom-pill">
          <button className="cm-icon-btn" title="Zoom out (−)" onClick={() => setZoomAtCenter(ed().fc.getZoom() * 0.83)}><Icon name="minus" size={14} /></button>
          <button className="cm-btn cm-zoom-pct" title="Reset to fit" onClick={() => fitAll()}>{zoomPct}%</button>
          <button className="cm-icon-btn" title="Zoom in (+)" onClick={() => setZoomAtCenter(ed().fc.getZoom() * 1.2)}><Icon name="plus" size={14} /></button>
          <span className="cm-zoom-div" />
          <button className="cm-icon-btn cm-zoom-extra" title="Fit to screen (0)" onClick={() => fitAll()}><Icon name="maximize" size={14} /></button>
          <span className="cm-zoom-div cm-zoom-extra" />
          <button className={'cm-icon-btn' + (voiceOn ? ' cm-voice-on' : '')} title='Voice control — say "brush", "undo", "make it red"…' aria-pressed={voiceOn} onClick={toggleVoice}><Icon name="mic" size={14} /></button>
        </div>
        <button className="cm-icon-btn" title={mode_ === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setMode(mode_ === 'dark' ? 'light' : 'dark')}>
          <Icon name={mode_ === 'dark' ? 'sun' : 'moon'} />
        </button>
        <span className="cm-hdiv" />
        {saveStatus && (
          <span className="cm-save-note" data-warn={saveStatus === 'failed' || saveStatus === 'unavailable'}
            title={saveStatus === 'unavailable'
              ? 'This browser is blocking local storage, so this document will not be restored if you close the tab.'
              : saveStatus === 'failed'
                ? 'This document is past the browser\u2019s local-storage budget, so it will not be restored if you close the tab. Export it to keep it.'
                : 'This document is autosaved in this browser and will be restored if you close the tab.'}>
            {saveStatus === 'unavailable' ? 'Not autosaved (storage blocked)' : saveStatus === 'failed' ? 'Too large to autosave' : 'Saved'}
          </span>
        )}
        <button className="cm-btn cm-compare-btn" disabled={!compareReady} title="Compare with the first-loaded version" onClick={openCompare}>
          <span>Compare</span>
        </button>
        <span className="cm-hdiv" />
        <span className="cm-export-anchor">
          <button className="cm-btn cm-btn-accent cm-export-btn" data-open={exportOpen} onClick={() => setExportOpen(o => !o)}>
            ⬇ Export image <span className="cm-export-caret"><Icon name="chevron" size={10} style={{ transform: 'rotate(-90deg)' }} /></span>
          </button>
          {exportOpen && (
            <div className="cm-export-menu">
              <div className="cm-export-scale-row">
                <span>Size</span>
                <div className="cm-export-scale" role="group" aria-label="Export size">
                  {[1, 2, 3].map(sc => (
                    <button key={sc} className="cm-export-scale-btn" data-on={exportScale === sc}
                      onClick={() => setExportScale(sc)}>{sc}&times;</button>
                  ))}
                </div>
              </div>
              {/* The exact pixel size the chosen scale produces — "2x" alone doesn't say whether
                  the result clears a retina or print requirement. */}
              <div className="cm-export-dims">{Math.round(ed().W * exportScale)} × {Math.round(ed().H * exportScale)} px</div>
              <button className="cm-export-menu-item" onClick={() => { const u = ed().exportPNG(exportScale); onExport ? onExport(u) : downloadURL(u, `canvasmith${exportScale === 1 ? '' : '@' + exportScale + 'x'}.png`); setExportOpen(false); }}>⬇ PNG</button>
              <button className="cm-export-menu-item" onClick={() => { const u = ed().exportJPEG(0.92, exportScale); onExport ? onExport(u) : downloadURL(u, `canvasmith${exportScale === 1 ? '' : '@' + exportScale + 'x'}.jpg`); setExportOpen(false); }}>⬇ JPG</button>
              {frames.length > 1 && <button className="cm-export-menu-item" onClick={() => { exportAllFrames(); setExportOpen(false); }}>⬇ All frames <span className="cm-export-hint">one PNG each</span></button>}
              <button className="cm-export-menu-item" onClick={() => { exportSvg(); setExportOpen(false); }}>⬇ SVG <span className="cm-export-hint">vector</span></button>
              <div className="cm-export-sep" />
              <button className="cm-export-menu-item" onClick={() => { saveProject(); setExportOpen(false); }}>⬇ Project file <span className="cm-export-hint">keeps layers</span></button>
              <button className="cm-export-menu-item" onClick={() => { openProject(); setExportOpen(false); }}>⬆ Open project…</button>
            </div>
          )}
        </span>
      </div>
      <div className="cm-rail" onMouseLeave={() => setRailTip(null)}>
        {TOOLGROUPS.map((ids, gi) => {
          const activeId = ids.find(id => id === tool);
          const shownId = activeId || ids[0];
          const shownLabel = (TOOL_LABELS[shownId] || shownId) + (TOOL_SHORTCUT[shownId] ? '  (' + TOOL_SHORTCUT[shownId] + ')' : '');
          return (
            <div className="cm-rail-group" key={ids[0]}>
              <button
                className="cm-rail-btn"
                data-on={!!activeId}
                data-tool={shownId}
                /* Icon-only, so the tooltip text is also the accessible name — without it a
                   screen reader announces "button" once per tool group and the rail is
                   unusable. aria-pressed carries the data-on active highlight; a multi-tool
                   group also reports that clicking opens its flyout. */
                aria-label={shownLabel}
                aria-pressed={!!activeId}
                aria-expanded={ids.length > 1 ? railFlyout === gi : undefined}
                onMouseEnter={(e) => setRailTip({ text: shownLabel, rect: e.currentTarget.getBoundingClientRect() })}
                onMouseLeave={() => setRailTip(null)}
                onClick={() => { setRailTip(null); pick(shownId); setRailFlyout(f => (ids.length > 1 ? (f === gi ? -1 : gi) : -1)); }}
              >
                <Icon name={TOOL_ICON[shownId] || shownId} size={18} />
                {ids.length > 1 && <span className="cm-rail-caret" />}
              </button>
              {railFlyout === gi && (
                <div className="cm-rail-flyout" role="menu" onMouseLeave={() => setRailFlyout(-1)}>
                  {ids.map(id => (
                    /* These <div>s do a menu's job: without a role, tabindex and a key handler
                       the non-primary tools are unreachable without a mouse — they exist only
                       behind this flyout. The visible label is the accessible name. */
                    <div key={id} className="cm-rail-flyout-item" data-on={id === tool} data-tool={id}
                      role="menuitemradio" aria-checked={id === tool} tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(id); setRailFlyout(-1); } }}
                      onClick={() => { pick(id); setRailFlyout(-1); }}>
                      <Icon name={TOOL_ICON[id] || id} size={15} />
                      <span style={{ flex: 1 }}>{TOOL_LABELS[id] || id}</span>
                      {TOOL_SHORTCUT[id] && <span className="sc">{TOOL_SHORTCUT[id]}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="cm-rail-bottom">
          <button className="cm-rail-btn" title="Duplicate (⌘D)"
            onMouseEnter={(e) => setRailTip({ text: 'Duplicate  (⌘D)', rect: e.currentTarget.getBoundingClientRect() })}
            onMouseLeave={() => setRailTip(null)}
            onClick={() => { setRailTip(null); duplicate(); }}>
            <Icon name="duplicate" size={17} />
          </button>
          <button className="cm-rail-btn" title="Delete (⌫)"
            onMouseEnter={(e) => setRailTip({ text: 'Delete  (⌫)', rect: e.currentTarget.getBoundingClientRect() })}
            onMouseLeave={() => setRailTip(null)}
            onClick={() => { setRailTip(null); activeLayer && ed().removeLayer(activeLayer.id); }}>
            <Icon name="close" size={17} />
          </button>
        </div>
      </div>
      {railTip && (
        <div className="cm-rail-tip" style={{ left: railTip.rect.right + 8, top: railTip.rect.top + railTip.rect.height / 2 }}>
          {railTip.text}
        </div>
      )}
      <button className="cm-collapse-left" data-flip={leftCollapsed} title={leftCollapsed ? 'Show panel' : 'Hide panel'} onClick={() => setLeftCollapsed(s => !s)}>
        <Icon name="chevron" size={13} />
      </button>
      <div className="cm-left" ref={leftRef}>
        {!leftCollapsed && (
          <div className="cm-lp">
            <div className="cm-lp-tabs" role="tablist">
              <button className="cm-lp-tab" role="tab" aria-selected={leftTab === 'layers'} onClick={() => setLeftTab('layers')}><Icon name="layers" size={14} />Layers<span className="cm-lp-count">{layers.length}</span></button>
              <button className="cm-lp-tab cm-lp-tab-ai" role="tab" aria-selected={leftTab === 'ai'} onClick={() => setLeftTab('ai')}><Icon name="wand" size={14} />AI Vision</button>
            </div>
            {leftTab === 'layers' ? (
              <div className="cm-lp-view">
                {!reviewOn && layersToolbar}
                {!reviewOn && <div className="cm-lp-list cm-scroll" role="list">{layerRows}</div>}
                {reviewOn && toolDock}
              </div>
            ) : (
              <div className="cm-lp-view cm-lp-ai cm-scroll">
                <div className="cm-grp" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>Detected subjects</div>
                <div className="cm-note" style={{ marginTop: 0 }}>
                  {!detectRan ? <>Run <b>Auto-Detect Subjects</b> below to find the objects in the scene — click one to select it.</>
                    : detectResults.length ? `${detectResults.length} subject${detectResults.length === 1 ? '' : 's'} found — click one to select it, or turn them into layers.`
                    : 'No subjects detected. Try the Object select tool on the rail instead.'}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                  {detectResults.map((b, i) => (
                    <div key={i} style={{ display: 'flex', gap: 4 }}
                      onMouseEnter={() => { detectHoverRef.current = b; ed().fc.requestRenderAll(); }}
                      onMouseLeave={() => { detectHoverRef.current = null; ed().fc.requestRenderAll(); }}>
                      <button className="cm-btn" style={{ flex: 1, minWidth: 0 }} onClick={() => selectDetected(b)}>
                        <Icon name="objectselect" size={13} /> Subject {i + 1}<span className="cm-tag mono" style={{ marginLeft: 'auto' }}>{Math.round(b.w)}×{Math.round(b.h)}</span>
                      </button>
                      <button className="cm-btn" title={`Make Subject ${i + 1} its own layer`} disabled={!!cardBusy} onClick={() => detectedToLayers([b])}><Icon name="layerstab" size={13} /></button>
                    </div>
                  ))}
                </div>
                {detectResults.length > 0 && (
                  <button className="cm-btn cm-btn-accent" style={{ width: '100%', marginTop: 8 }} data-busy={cardBusy === 'tolayers'} disabled={!!cardBusy} onClick={() => detectedToLayers(detectResults)}>
                    {cardBusy === 'tolayers' ? <><span className="cm-btn-spin" />Creating layers…</> : <><Icon name="layerstab" size={13} /> Create layers from {detectResults.length === 1 ? 'subject' : `all ${detectResults.length} subjects`}</>}
                  </button>
                )}
                <div className="cm-grp">Engine</div>
                <div className="cm-lp-engine"><span>Selection &amp; cutout</span><span className="cm-tag mono">Local CV</span></div>
                <div className="cm-lp-engine"><span>Generative AI</span><span className="cm-tag mono">{aiKeyed ? 'Gemini' : 'No key'}</span></div>
                <div className="cm-note">Remove BG runs locally unless an AI key is set in the AI tab — either way it writes a layer mask you can refine with the brush.</div>
              </div>
            )}
            <div className="cm-lp-card">
              <div className="cm-lp-card-head"><Icon name="spark" size={13} style={{ color: 'var(--cm-accent)' }} />AI Vision Engine v3.4<span className="cm-lp-status" data-on={aiKeyed}>{aiKeyed ? 'Neural On' : 'Local'}</span></div>
              <button className="cm-ai-detect-btn" data-busy={cardBusy === 'detect'} disabled={!!cardBusy} onClick={detectObjects}>
                {cardBusy === 'detect' ? <><span className="cm-btn-spin" />Detecting…</> : <><Icon name="wand" size={13} /> Auto-Detect Subjects</>}
              </button>
              <div className="cm-lp-card-row">
                <button className="cm-btn" data-busy={cardBusy === 'removebg'} title="Cut the subject out of the selected image (as a layer mask)"
                  disabled={!!cardBusy || !(activeLayer && (activeLayer.kind === 'image' || activeLayer.kind === 'paint') && !activeLayer.isAdjustment)} onClick={() => removeBg()}>
                  {cardBusy === 'removebg' ? <><span className="cm-btn-spin" />Cutting out…</> : <><Icon name="scissors" size={13} /> Remove BG</>}
                </button>
                <button className="cm-btn" data-on={!!(activeLayer && activeLayer.hasShadow)} title="Toggle a soft drop shadow on the selected layer"
                  disabled={!!cardBusy || !(activeLayer && activeLayer.role !== 'bg' && !activeLayer.isAdjustment)} onClick={autoShadow}>
                  <Icon name="sun" size={13} /> Auto Shadow
                </button>
              </div>
              {/* with an AI key Remove BG uses the AI; this keeps the free offline cut-out one click away */}
              {aiKeyed && (
                <div className="cm-lp-card-row">
                  <button className="cm-btn" data-busy={cardBusy === 'removebg-local'} title="Cut the subject out offline, without the AI (as a layer mask you can touch up)"
                    disabled={!!cardBusy || !(activeLayer && (activeLayer.kind === 'image' || activeLayer.kind === 'paint') && !activeLayer.isAdjustment)} onClick={() => removeBg('local')}>
                    {cardBusy === 'removebg-local' ? <><span className="cm-btn-spin" />Cutting out…</> : <><Icon name="scissors" size={13} /> Remove BG offline</>}
                  </button>
                </div>
              )}
              {cardMsg && <div className="cm-note" style={{ marginTop: 6 }}>{cardMsg}</div>}
            </div>
          </div>
        )}
        <ScrollCue within={leftRef} />
      </div>
      {toasts.length > 0 && (
        <div className="cm-toast-wrap" aria-live="polite">
          {toasts.map(t => (
            <div className="cm-toast" key={t.id}>
              <span>{t.message}</span>
              {t.action && <button onClick={() => { dismissToast(t.id); t.action(); }}>Undo</button>}
            </div>
          ))}
        </div>
      )}
      <div className="cm-center">
        <div className="cm-tabbar" role="tablist" aria-label="Open documents">
          {docTabs.map(d => (
            <div key={d.id} className="cm-doctab" role="tab" data-on={d.active} aria-selected={d.active} title={d.name + ' \u2014 double-click to rename'}
              onClick={() => { if (!d.active && docsRef.current) docsRef.current.switchTo(d.id); }}
              onDoubleClick={() => setRenamingTab(d.id)}
              onAuxClick={(e) => { if (e.button === 1 && docTabs.length > 1) { e.preventDefault(); closeDocTab(d.id); } }}>
              {renamingTab === d.id
                ? <input autoFocus defaultValue={d.name} maxLength={40} onFocus={(e) => e.target.select()} onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); else if (e.key === 'Escape') { e.target.value = d.name; e.target.blur(); } }}
                    onBlur={(e) => { setRenamingTab(null); if (docsRef.current) docsRef.current.rename(d.id, e.target.value); }} />
                : <span className="cm-dt-name">{d.name}</span>}
              {docTabs.length > 1 && (
                <button className="cm-dt-x" title="Close tab" aria-label={'Close ' + d.name} onClick={(e) => { e.stopPropagation(); closeDocTab(d.id); }}><Icon name="close" size={11} /></button>
              )}
            </div>
          ))}
          <button className="cm-doctab-add" disabled={docTabs.length >= MAX_DOCS} title={docTabs.length >= MAX_DOCS ? 'Up to ' + MAX_DOCS + ' pages \u2014 close one to add another' : 'New canvas tab'} aria-label="New canvas tab" onClick={() => docsRef.current && docsRef.current.add()}><Icon name="plus" size={14} /></button>
        </div>
        <div className="cm-stage" ref={stageRef}
          data-dropping={dropping || undefined}
          onDragEnter={onStageDragEnter} onDragLeave={onStageDragLeave}
          onDragOver={onStageDragOver} onDrop={(e) => { setDropDepth(0); setDropping(false); onStageDrop(e); }}>
          <canvas ref={canvasRef} />
          {voiceCap && <div className={'cm-voice-cap' + (voiceCap.err ? ' err' : '')} role="status">{voiceCap.msg}</div>}
          {perspActive && (
            <div className="cm-persp-bar" role="toolbar" aria-label="Perspective correction">
              <Icon name="perspective" size={14} />
              <span style={{ whiteSpace: 'nowrap' }}>Drag the corners onto edges that should be square</span>
              <button className="cm-btn cm-persp-apply" onClick={() => ed().applyPerspectiveEdit()}>Apply</button>
              <button className="cm-btn" onClick={() => ed().resetPerspectiveCorners()}>Reset</button>
              <button className="cm-btn" onClick={() => ed().cancelPerspectiveEdit()}>Cancel</button>
            </div>
          )}
          {pathEditing && !perspActive && (
            <div className="cm-persp-bar cm-path-bar" role="toolbar" aria-label="Edit path">
              <span style={{ display: 'flex', flexShrink: 0 }}><Icon name="pen" size={14} /></span>
              <span className="cm-path-bar-hint" style={{ whiteSpace: 'nowrap' }}>Drag points &amp; handles · double-click to add / convert · ⌘-drag bends</span>
              <button className="cm-btn" title="Make the selected points smooth" onClick={() => ed().setPathNodeType('smooth')}>Smooth</button>
              <button className="cm-btn" title="Make the selected points sharp corners" onClick={() => ed().setPathNodeType('corner')}>Corner</button>
              <button className="cm-btn" title="Delete the selected points (⌫)" onClick={() => ed().deleteSelectedPathNodes()}>Delete point</button>
              <button className="cm-btn cm-persp-apply" title="Leave edit mode (Enter)" onClick={() => ed().exitPathEdit()}>Done</button>
            </div>
          )}
          {showExtendBanner && !perspActive && !pathEditing && (
            <button className="cm-extend-banner" onClick={onExtendBannerClick}>
              <Icon name="search" size={13} />Background doesn't fill the canvas — AI-extend it
            </button>
          )}
          {reviewOn && reviewHoverPoly && (() => {
            // Live cutout-preview overlay: dashed lime silhouette over the hovered region box,
            // showing the exact shape Create/Extract will cut — see reviewHoverMove above. Region
            // boxes THEMSELVES are real Fabric objects (Fabric renders them natively on <canvas>);
            // this SVG only draws the one thing Fabric doesn't already show: the precomputed cutout
            // preview polygon, matching the vanilla demo's #review-hover-preview.
            const screenPts = reviewHoverPoly.map(sceneToScreen);
            const xs = screenPts.map(p => p.x), ys = screenPts.map(p => p.y);
            const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
            return (
              <svg style={{ position: 'absolute', left: minX, top: minY, zIndex: 5, pointerEvents: 'none' }}
                width={Math.max(1, maxX - minX)} height={Math.max(1, maxY - minY)}>
                <polygon fill="rgba(212,255,69,.28)" stroke="#d4ff45" strokeWidth="2"
                  points={screenPts.map(p => (p.x - minX) + ',' + (p.y - minY)).join(' ')} />
              </svg>
            );
          })()}
          {aiInsert && (() => {
            const p = sceneToScreen(aiInsert.pt);
            const stageW = stageRef.current ? stageRef.current.clientWidth : 0;
            const stageH = stageRef.current ? stageRef.current.clientHeight : 0;
            const left = Math.max(8, Math.min(p.x - 10, stageW - 276));
            const top = Math.max(8, Math.min(p.y + 12, stageH - 150));
            return (
              <React.Fragment>
                <div style={{ position: 'absolute', left: p.x - 5, top: p.y - 5, width: 10, height: 10, borderRadius: '50%', background: 'var(--cm-accent)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--cm-accent) 35%, transparent)', zIndex: 21, pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', left, top, zIndex: 22, width: 260, background: 'var(--cm-panel)', border: '1px solid var(--cm-line)', borderRadius: 14, padding: 12, boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>
                  <div className="cm-row" style={{ gap: 6, fontSize: 12.5, fontWeight: 700 }}>
                    <Icon name="spark" size={13} style={{ color: 'var(--cm-accent)' }} />
                    <span style={{ flex: 1 }}>{aiInsert.region ? 'Fill the selection with AI' : 'Draw here with AI'}</span>
                    <button className="cm-icon-btn" title="Close" aria-label="Close" onClick={() => setAiInsert(null)}><Icon name="close" size={12} /></button>
                  </div>
                  {aiInsert.region && <div className="cm-note" style={{ fontSize: 10.5, marginBottom: 6 }}>The result is clipped to your selection — the AI draws only inside that shape.</div>}
                  {aiInsert.msg && <div className="cm-note" style={{ fontSize: 10.5, marginBottom: 6, color: '#e0607a' }}>{aiInsert.msg}</div>}
                  <input autoFocus style={{ width: '100%', marginTop: 8, boxSizing: 'border-box', background: 'var(--cm-bg)', border: '1px solid var(--cm-line)', borderRadius: 8, color: 'var(--cm-ink)', padding: '7px 9px', fontSize: 12, fontFamily: 'inherit' }}
                    placeholder={aiInsert.region ? 'Describe what fills this shape…' : 'Describe what to draw here…'}
                    value={aiInsert.prompt} disabled={aiInsert.busy}
                    onChange={e => setAiInsert(a => a && ({ ...a, prompt: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitAiInsert(); } else if (e.key === 'Escape') { e.preventDefault(); setAiInsert(null); } }} />
                  <button className="cm-btn cm-btn-accent" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }}
                    disabled={aiInsert.busy || !aiInsert.prompt.trim()} onClick={submitAiInsert}>
                    {aiInsert.busy ? 'Generating…' : <React.Fragment><Icon name="spark" size={13} />{aiInsert.region ? 'Generate in selection' : 'Generate here'}</React.Fragment>}
                  </button>
                </div>
              </React.Fragment>
            );
          })()}
        </div>
      </div>
      <button className="cm-collapse" data-flip={sideCollapsed} title={sideCollapsed ? 'Show panel' : 'Hide panel'} onClick={() => setSideCollapsed(s => !s)}>
        <Icon name="chevron" size={13} />
      </button>
      <div className="cm-side" ref={sideRef}>
        {!sideCollapsed && reviewOn && (() => {
          const ar = activeRegion();
          const polyRegionCount = regionObjects().filter(o => o.type === 'polygon').length;
          const mergeCount = selectedRegions().length;
          const n = regionObjects().length;
          const isPolyClick = regionDraw === 'polylasso' || regionDraw === 'maglasso';
          const HAND_TOOLS = [
            ['object', 'spark', 'Object'], ['box', 'square', 'Box'], ['lasso', 'lasso', 'Lasso'],
            ['polylasso', 'polygon', 'Polygon'], ['maglasso', 'wand', 'Magnetic'],
          ];
          const BG_MODE_NOTE = {
            auto: 'Local cutout + background fill; with an AI key, the AI also repaints the filled areas.',
            cheap: 'Local only — lower-resolution cutout and fill, fast and free (no AI call).',
            best: 'Higher-resolution cutout for cleaner edges, plus AI background repaint when a key is set (slowest).',
          };
          return (
            <div className="cm-side-body cm-scroll">
              <div className="cm-review-head">
                <span className="cm-row" style={{ gap: 6, fontWeight: 700, fontSize: 13 }}><Icon name="layers" size={15} style={{ color: 'var(--cm-accent)' }} />Review regions</span>
                <span className="cm-tag" style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 10.5 }}>{n} {n === 1 ? 'box' : 'boxes'}</span>
              </div>
              <div className="cm-review-panel-body">
                {convertMsg && regionDraw !== 'object' && <div className="cm-note" style={{ margin: 0, color: 'var(--cm-accent)' }}>{convertMsg}</div>}
                <button className="cm-btn" style={{ width: '100%', justifyContent: 'flex-start' }} disabled={autodetectBusy} onClick={autoDetectRegions}>
                  {autodetectBusy ? <React.Fragment><span className="cm-btn-spin" />Detecting…</React.Fragment> : <React.Fragment><Icon name="spark" size={13} />Auto-detect all objects</React.Fragment>}
                </button>
                <div className="cm-eyebrow" style={{ marginTop: 6 }}>Select by hand</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {HAND_TOOLS.map(([mode, icon, label]) => (
                    <button key={mode} className="cm-btn" data-on={regionDraw === mode} style={{ justifyContent: 'flex-start' }}
                      onClick={() => setRegionDrawMode(regionDraw === mode ? null : mode)}>
                      <Icon name={icon} size={13} />{label}
                    </button>
                  ))}
                  <button className="cm-btn" style={{ justifyContent: 'flex-start' }} onClick={() => {
                    const r = makeRegionRectObj({ type: 'product', bbox: { x: 38, y: 42, width: 24, height: 16 } });
                    ed().fc.add(r); ed().fc.setActiveObject(r); ed().fc.renderAll(); forceReview();
                  }}><Icon name="plus" size={13} />Add box</button>
                </div>
                {regionDraw === 'object' && (
                  <div className="cm-col" style={{ gap: 8, padding: 10, background: 'var(--cm-bg)', borderRadius: 10 }}>
                    <span className="cm-note" style={{ margin: 0 }}>Click an object on the canvas to capture it.{objMulti ? ' Keep clicking to add more.' : ''}</span>
                    {convertMsg && <span className="cm-note" style={{ margin: 0, color: 'var(--cm-accent)' }}>{convertMsg}</span>}
                    <div className="cm-row" style={{ gap: 6, fontSize: 11 }}>
                      <span className="cm-dim">Colour match</span>
                      <input type="range" min={4} max={96} value={ed().toolOpts.tolerance} onChange={e => ed().setToolOptions({ tolerance: +e.target.value })} style={{ flex: 1 }} />
                    </div>
                    <div className="cm-row" style={{ gap: 6 }}>
                      <button className="cm-chip" data-on={objMulti} title="Keep adding each clicked object to the selection" onClick={() => setObjMulti(m => !m)}>Add{objMulti ? ' ✓' : ''}</button>
                      <button className="cm-btn cm-btn-accent" style={{ flex: 1, justifyContent: 'center' }} disabled={polyRegionCount < 2} onClick={mergeObjectRegions}>
                        <Icon name="layers" size={13} />Merge objects{polyRegionCount >= 2 ? ' (' + polyRegionCount + ')' : ''}
                      </button>
                    </div>
                  </div>
                )}
                {isPolyClick && polyBuildStateRef.current && (
                  <button className="cm-btn cm-btn-accent" style={{ width: '100%', justifyContent: 'center' }} onClick={() => finishPolyDrawLocal(false)}>
                    <Icon name="check" size={13} />Finish shape
                  </button>
                )}
                {mergeCount >= 2 && (
                  <button className="cm-btn" style={{ width: '100%', justifyContent: 'center' }} onClick={mergeSelectedRegions}>
                    <Icon name="layers" size={13} />Merge {mergeCount} selected
                  </button>
                )}
                {ar && (
                  <div className="cm-col" style={{ gap: 8, marginTop: 6, paddingTop: 12, borderTop: '1px solid var(--cm-line)' }}>
                    <div className="cm-eyebrow" style={{ marginTop: 0 }}>Selected region</div>
                    <input key={ar.id} className="cm-text-input" defaultValue={ar.renamed ? (ar.name || '') : ''} placeholder={ar.renamed ? 'Region name' : (ar.name || 'Region name')}
                      onChange={e => renameActiveRegion(e.target.value)} />
                    <span className="cm-note" style={{ margin: 0, fontSize: 11 }}>Type</span>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                      {Object.keys(REGION_COLOR).map(t => (
                        <button key={t} className="cm-btn" style={ar.regionType === t ? { background: REGION_COLOR[t] + '38', borderColor: REGION_COLOR[t] } : undefined} onClick={() => setActiveRegionType(t)}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: REGION_COLOR[t], display: 'inline-block', marginRight: 5 }} />{REGION_NAME[t]}
                        </button>
                      ))}
                    </div>
                    <div className="cm-row" style={{ gap: 6 }}>
                      <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} disabled={extractBusy} onClick={extractActiveRegion}>
                        {extractBusy ? <React.Fragment><span className="cm-btn-spin" />Extracting…</React.Fragment> : <React.Fragment><Icon name="duplicate" size={13} />Extract</React.Fragment>}
                      </button>
                      <button className="cm-icon-btn" title="Delete region" style={{ color: '#e0607a' }} onClick={removeActiveRegion}><Icon name="trash" size={13} /></button>
                    </div>
                  </div>
                )}
              </div>
              <div className="cm-col" style={{ gap: 6, padding: '10px 12px', borderTop: '1px solid var(--cm-line)' }}>
                <div className="cm-row" style={{ justifyContent: 'space-between' }}>
                  <span className="cm-dim" style={{ fontSize: 11, fontWeight: 600 }}>Clean background</span>
                  <span className="cm-row" style={{ gap: 3, background: 'var(--cm-bg)', borderRadius: 999, padding: 3 }}>
                    {['auto', 'cheap', 'best'].map(m => (
                      <button key={m} className="cm-btn" style={{ padding: '3px 9px', fontSize: 11, ...(bgMode === m ? { background: 'var(--cm-accent)', color: 'var(--cm-accent-ink)' } : {}) }} onClick={() => setBgMode(m)}>
                        {m[0].toUpperCase() + m.slice(1)}
                      </button>
                    ))}
                  </span>
                </div>
                <span className="cm-dim" style={{ fontSize: 10.5 }}>{BG_MODE_NOTE[bgMode]}</span>
              </div>
              <div className="cm-row" style={{ gap: 8, padding: 12, borderTop: '1px solid var(--cm-line)' }}>
                <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} disabled={commitBusy} onClick={() => closeReview(true)}>Cancel</button>
                <button className="cm-btn cm-btn-accent" style={{ flex: 1.4, justifyContent: 'center' }} disabled={commitBusy || n === 0} onClick={commitReview}>
                  {commitBusy
                    ? <React.Fragment><span className="cm-btn-spin" />Creating layers…</React.Fragment>
                    : <React.Fragment><Icon name="wand" size={13} />Create {n} layer{n === 1 ? '' : 's'}</React.Fragment>}
                </button>
              </div>
            </div>
          );
        })()}
        {!sideCollapsed && !reviewOn && (
          <React.Fragment>
            <div className="cm-tabs">
              <button data-on={sideTab === 'layer'} onClick={() => setSideTab('layer')}>Properties</button>
              <button data-on={sideTab === 'design'} onClick={() => setSideTab('design')}>Design</button>
              <button data-on={sideTab === 'stickers'} onClick={() => setSideTab('stickers')}>Stickers</button>
              <button className="cm-tab-ai" data-on={sideTab === 'ai'} onClick={() => setSideTab('ai')}>AI Assist<span className="cm-tab-dot" aria-hidden="true" /></button>
            </div>
            <div className="cm-side-body cm-scroll">

            {sideTab === 'layer' && (
              <div>
                {toolDock}
                {/* Page settings only with nothing selected (Figma): with a layer picked, its own
                    properties start at the top instead of under the page size and fill. */}
                {!props.active && <CanvasSection editor={ed} info={canvasInfo} frames={frames} />}

                {!props.active ? (dockOpen ? null : (
                  <React.Fragment>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <strong className="cm-props-title">Properties</strong>
                    </div>
                    <div className="cm-props-empty">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 15l4-4 4 4 4-6 4 4" /></svg>
                      <span className="h">Nothing selected</span>
                      <span className="d">Select a layer above, or on the canvas, to see and edit its properties.</span>
                    </div>
                  </React.Fragment>
                )) : (
                  <React.Fragment>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <strong className="cm-props-title">{props.title}</strong>
                    </div>
                    {props.iso && (
                      <div className="cm-iso-bar">
                        <span>Editing inside <b>{props.iso.name}</b></span>
                        <button className="cm-chip" title="Back to the whole layer (Esc)" onClick={() => ed().exitIsolation()}>Done</button>
                      </div>
                    )}

                    <PropJump show={props.isImage || props.isAdjustment} layerKey={activeLayer && activeLayer.id} />
                    <div className="cm-grp" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>Stacking</div>
                    <div className="cm-row">
                      <button className="cm-icon-btn" title="Bring to front" style={{ width: 'auto', flex: 1 }} onClick={() => stack('top')}><Icon name="stackfront" size={15} /></button>
                      <button className="cm-icon-btn" title="Bring forward" style={{ width: 'auto', flex: 1 }} onClick={() => stack('up')}><Icon name="stackup" size={15} /></button>
                      <button className="cm-icon-btn" title="Send backward" style={{ width: 'auto', flex: 1 }} onClick={() => stack('down')}><Icon name="stackdown" size={15} /></button>
                      <button className="cm-icon-btn" title="Send to back" style={{ width: 'auto', flex: 1 }} onClick={() => stack('bottom')}><Icon name="stackback" size={15} /></button>
                    </div>
                    {/* Only the action that applies is shown (none on a plain single layer), like the demo. */}
                    {(props.canGroup || props.canUngroup) && (
                      <div className="cm-row" style={{ marginTop: 6 }}>
                        {props.canGroup && <button className="cm-btn" onClick={groupSel}><Icon name="box" size={13} /> Group</button>}
                        {props.canUngroup && <button className="cm-btn" onClick={ungroupSel}><Icon name="grid" size={13} /> Ungroup</button>}
                      </div>
                    )}

                    {/* Combine shapes: only with two or more layers selected. An image (or text, a line, a
                        group) in the selection disables every operation; the four true boolean ops also stay
                        off until core has a polygon engine (setClipEngine). */}
                    {props.combine && props.combine.count >= 2 && (
                      <>
                        <div className="cm-grp">Combine shapes</div>
                        <div className="cm-cb-list" role="menu" aria-label="Combine shapes">
                          {[['union', 'Union'], ['subtract', 'Subtract'], ['intersect', 'Intersect'], ['exclude', 'Exclude'], ['flatten', 'Flatten']].map(([op, label]) => {
                            const on = props.combine.ops[op];
                            const why = on ? '' : !props.combine.ok ? props.combine.reason : 'The polygon engine isn\u2019t available';
                            return (
                              <button key={op} className="cm-cb-item" role="menuitem" disabled={!on} title={on ? label + ' the selected shapes' : why}
                                onClick={() => { try { ed().combineShapes(op); } catch (err) { toast(err.message); } }}>
                                <Icon name={op} size={16} /><span>{label}</span>
                              </button>
                            );
                          })}
                        </div>
                        <div className="cm-cb-hint">{props.combine.ok ? (props.combine.engine ? '' : 'The polygon engine isn\u2019t available, so only Flatten works.') : props.combine.reason}</div>
                      </>
                    )}

                    <div className="cm-grp">Canvas alignment</div>
                    <div className="cm-align">
                      {[
                        ['left', 'align-left'], ['center', 'align-h-center'], ['right', 'align-right'],
                        ['top', 'align-top'], ['middle', 'align-v-center'], ['bottom', 'align-bottom'],
                      ].map(([edge, icon]) => (
                        <button key={edge} title={'Align ' + edge} onClick={() => align(edge)}>
                          <Icon name={icon} size={16} />
                        </button>
                      ))}
                    </div>

                    {/* Position/size and blend right after alignment (Figma's order) — on a photo they sat under every adjustment. */}
                    <div className="cm-grp" id="cm-sec-transform">Transform</div>
                    <div className="cm-slider-row">Rotation <input type="range" min="0" max="360" value={props.angle} onChange={e => setNumeric({ angle: +e.target.value })} /><span className="cm-val">{Math.round(props.angle)}°</span></div>
                    <div className="cm-field-grid">
                      <label className="cm-field">X <input type="number" value={props.x} onChange={e => setNumeric({ x: +e.target.value })} /></label>
                      <label className="cm-field">Y <input type="number" value={props.y} onChange={e => setNumeric({ y: +e.target.value })} /></label>
                    </div>
                    <div className="cm-field-grid">
                      <label className="cm-field">W <input type="number" value={props.w} onChange={e => setNumeric({ w: +e.target.value }, { keepRatio })} /></label>
                      <label className="cm-field">H <input type="number" value={props.h} onChange={e => setNumeric({ h: +e.target.value }, { keepRatio })} /></label>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '2px 0 8px', fontSize: 12, cursor: 'pointer' }}>
                      <input type="checkbox" checked={keepRatio} onChange={e => setKeepRatio(e.target.checked)} />
                      <span>Keep proportions</span>
                    </label>
                    <div className="cm-field-grid">
                      <label className="cm-field">Skew X <input type="number" value={props.skewX} onChange={e => setNumeric({ skewX: +e.target.value })} /></label>
                      <label className="cm-field">Skew Y <input type="number" value={props.skewY} onChange={e => setNumeric({ skewY: +e.target.value })} /></label>
                    </div>
                    <div className="cm-row" style={{ marginTop: 8 }}>
                      <button className="cm-btn" onClick={() => flip('x')}><Icon name="flip" size={13} /> Flip H</button>
                      <button className="cm-btn" onClick={() => flip('y')}><Icon name="flip" size={13} style={{ transform: 'rotate(90deg)' }} /> Flip V</button>
                    </div>
                    <div className="cm-row" style={{ marginTop: 6 }}>
                      <button className="cm-btn" onClick={centerH}><Icon name="move" size={13} /> Center H</button>
                      <button className="cm-btn" onClick={centerV}><Icon name="move" size={13} /> Center V</button>
                    </div>

                    {props.isRect && (
                      <div>
                        <div className="cm-grp">Corner radius</div>
                        <div className="cm-slider-row">Radius <input type="range" min="0" max={Math.max(1, Math.round(Math.min(props.w, props.h) / 2))} value={props.rx} onChange={e => setNumeric({ rx: +e.target.value }, { live: true })} /><span className="cm-val">{props.rx}px</span></div>
                      </div>
                    )}

                    <div className="cm-grp">Blend &amp; opacity</div>
                    <BlendPicker value={props.blend} onPick={setBlend} preview={() => activeLayer ? ed().blendPreview(activeLayer.id) : null} />
                    <div className="cm-slider-row">Opacity <input type="range" min="0" max="1" step="0.05" value={props.opacity} onChange={e => setOpacity(+e.target.value)} /><span className="cm-val">{Math.round(props.opacity * 100)}%</span></div>

                    {props.canFeather && (
                      <div>
                        <div className="cm-grp">Edge feather</div>
                        <div className="cm-slider-row" title="Fade the layer's outline into what's behind it (Photoshop's Feather)">Feather <input type="range" min="0" max="150" value={props.edgeFeather} onChange={e => ed().setEdgeFeather(null, +e.target.value)} /><span className="cm-val">{props.edgeFeather}px</span></div>
                      </div>
                    )}

                    <div className="cm-grp" id="cm-sec-shadow">Shadow</div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <input type="color" value={props.shadow.color} title="Shadow colour" onChange={e => setShadow({ color: e.target.value })} />
                      <div className="cm-slider-row" style={{ flex: 1, marginTop: 0 }}>Blur <input type="range" min="0" max="60" value={props.shadow.blur} onChange={e => setShadow({ blur: +e.target.value })} /><span className="cm-val">{Math.round(props.shadow.blur || 0)}px</span></div>
                    </div>
                    <div className="cm-field-grid">
                      <label className="cm-field">Offset X <input type="number" value={props.shadow.offsetX} onChange={e => setShadow({ offsetX: +e.target.value })} /></label>
                      <label className="cm-field">Offset Y <input type="number" value={props.shadow.offsetY} onChange={e => setShadow({ offsetY: +e.target.value })} /></label>
                    </div>
                    <button className="cm-btn" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={clearShadow}>Clear shadow</button>


                    {(props.isImage || props.isAdjustment) && (
                      <React.Fragment>
                        <div className="cm-grp" id="cm-sec-adjust">{props.isAdjustment ? 'Adjustment layer' : 'Adjust'}</div>
                        {props.isAdjustment && <div className="cm-note" style={{ marginTop: 0 }}>Affects every layer below this one in the stack.</div>}
                        {ADJUST_CONTROLS.map((c, i) => (
                          <React.Fragment key={c.key}>
                            {c.group !== (ADJUST_CONTROLS[i - 1] || {}).group && <div className="cm-subgrp">{c.group}</div>}
                            <div className="cm-adj-row" title={c.label + ' — double-click to reset'} onDoubleClick={() => setAdjust({ [c.key]: FX_DEFAULTS[c.key] })}>
                              <Icon name={c.icon} size={13} />
                              <span className="lbl">{c.short || c.label}</span>
                              <input type="range" aria-label={c.label} min={c.min} max={c.max} step={c.step} value={props.fx[c.key]}
                                style={c.track ? { '--cm-track': c.track } : undefined}
                                onChange={e => setAdjust({ [c.key]: +e.target.value }, true)} onPointerUp={commitAdjust} onKeyUp={commitAdjust} />
                              <span className={'val' + (props.fx[c.key] === FX_DEFAULTS[c.key] ? ' dim' : '')}>{formatAdjustValue(c.key, props.fx[c.key])}</span>
                            </div>
                          </React.Fragment>
                        ))}
                        <button className="cm-disclose" aria-expanded={showCurves} onClick={() => setShowCurves(v => !v)}>
                          <Icon name="chevronD" size={12} style={{ transform: showCurves ? 'none' : 'rotate(-90deg)' }} /> Curves
                          {props.fx.curves && <span className="dot" title="Curves active" />}
                        </button>
                        {showCurves && <CurvesEditor curves={props.fx.curves} histogram={histogram}
                          onChange={(curves, live) => setAdjust({ curves }, live)} onCommit={commitAdjust} />}
                        <button className="cm-disclose" aria-expanded={showHsl} onClick={() => setShowHsl(v => !v)}>
                          <Icon name="chevronD" size={12} style={{ transform: showHsl ? 'none' : 'rotate(-90deg)' }} /> Color mixer (HSL)
                          {props.fx.hsl && <span className="dot" title="Color mixer active" />}
                        </button>
                        {showHsl && <HslMixer hsl={props.fx.hsl} onChange={(hsl, live) => setAdjust({ hsl }, live)} onCommit={commitAdjust} />}
                        {props.isImage && !props.isAdjustment && <MatchColorRow editor={ed} layerId={activeLayer && activeLayer.id} layers={layers} match={props.fx.match} />}
                        <label className="cm-adj-check-row">
                          <Icon name="invert" size={13} /> Invert
                          <input type="checkbox" className="cm-adj-check" checked={!!props.fx.invert} onChange={e => setAdjust({ invert: e.target.checked })} />
                        </label>
                        <button className="cm-btn cm-adj-reset" onClick={() => setAdjust({ ...FX_DEFAULTS })}>
                          <Icon name="reset" size={13} /> Reset adjustments
                        </button>
                        {props.isImage && !props.isAdjustment && (
                          <React.Fragment>
                            <div className="cm-grp" id="cm-sec-geometry">Geometry</div>
                            {GEOMETRY_CONTROLS.map(c => (
                              <div key={c.key} className="cm-adj-row" title={c.label + ' — double-click to reset'} onDoubleClick={() => setGeom({ [c.key]: 0 })}>
                                <Icon name={c.icon} size={13} />
                                <span className="lbl">{c.label}</span>
                                <input type="range" aria-label={c.label} min={c.min} max={c.max} step={c.step} value={props.geom[c.key]} disabled={perspActive}
                                  onChange={e => setGeom({ [c.key]: +e.target.value }, true)} onPointerUp={commitGeom} onKeyUp={commitGeom} />
                                <span className={'val' + (props.geom[c.key] ? '' : ' dim')}>{formatGeometryValue(c.key, props.geom[c.key])}</span>
                              </div>
                            ))}
                            <div className="cm-row" style={{ marginTop: 10 }}>
                              <button className="cm-btn" onClick={() => ed().enterPerspectiveEdit()}><Icon name="perspective" size={13} /> 4-corner perspective{props.geom.quad ? ' ●' : ''}</button>
                              <button className="cm-btn" style={{ flex: '0 0 auto' }} title="Reset geometry" onClick={() => setGeom({ ...GEOMETRY_DEFAULTS })}><Icon name="reset" size={13} /></button>
                            </div>
                          </React.Fragment>
                        )}
                      </React.Fragment>
                    )}

                    {props.text && (
                      <React.Fragment>
                        <div className="cm-grp">Typography</div>
                        <FontPicker value={props.text.fontFamily} onPick={v => setText({ fontFamily: v })}
                          onAdded={css => { edRef.current && edRef.current.refreshFonts(); setText({ fontFamily: css }); toast('Font added'); }} onError={toast} />
                        <div className="cm-field-grid">
                          <label className="cm-field">Size <input type="number" min="1" max="800" value={props.text.fontSize} onChange={e => setText({ fontSize: Math.max(1, +e.target.value) })} /></label>
                          <label className="cm-field">Weight
                            <select className="cm-select" value={props.text.fontWeight} onChange={e => setText({ fontWeight: +e.target.value })}>
                              <option value={300}>Light</option><option value={400}>Regular</option><option value={500}>Medium</option>
                              <option value={600}>Semibold</option><option value={700}>Bold</option><option value={800}>Extrabold</option>
                            </select>
                          </label>
                        </div>
                        <div className="cm-row" style={{ marginTop: 8 }}>
                          <button className="cm-icon-btn" data-active={props.text.fontStyle === 'italic'} title="Italic" onClick={() => setText({ fontStyle: props.text.fontStyle === 'italic' ? 'normal' : 'italic' })}><i>I</i></button>
                          <button className="cm-icon-btn" data-active={props.text.underline} title="Underline" onClick={() => setText({ underline: !props.text.underline })}><u>U</u></button>
                          <button className="cm-icon-btn" data-active={props.text.linethrough} title="Strikethrough" onClick={() => setText({ linethrough: !props.text.linethrough })}><s>S</s></button>
                          <button className="cm-icon-btn" data-active={props.text.textAlign === 'left'} title="Align text left" onClick={() => setText({ textAlign: 'left' })}><Icon name="text-left" size={14} /></button>
                          <button className="cm-icon-btn" data-active={props.text.textAlign === 'center'} title="Align text center" onClick={() => setText({ textAlign: 'center' })}><Icon name="text-center" size={14} /></button>
                          <button className="cm-icon-btn" data-active={props.text.textAlign === 'right'} title="Align text right" onClick={() => setText({ textAlign: 'right' })}><Icon name="text-right" size={14} /></button>
                        </div>
                        <div className="cm-slider-row">Line height <input type="range" min="0.8" max="2.5" step="0.05" value={props.text.lineHeight} onChange={e => setText({ lineHeight: +e.target.value })} /><span className="cm-val">{(+props.text.lineHeight || 0).toFixed(2)}</span></div>
                        <div className="cm-slider-row">Letter spacing <input type="range" min="-100" max="800" step="10" value={props.text.charSpacing} onChange={e => setText({ charSpacing: +e.target.value })} /><span className="cm-val">{((+props.text.charSpacing || 0) / 1000).toFixed(2)}em</span></div>
                      </React.Fragment>
                    )}

                    {props.hasFill && (
                      <React.Fragment>
                        <div className="cm-grp">Fill</div>
                        <div className="cm-seg">
                          <button className="cm-btn" data-on={!props.shapeGradient} onClick={setSolidFillMode}>Solid</button>
                          <button className="cm-btn" data-on={!!props.shapeGradient} onClick={setGradientFillMode}>Gradient</button>
                        </div>
                        {!props.shapeGradient ? (
                          <div className="cm-swatch-row" style={{ marginTop: 8 }} data-paint-off={props.fillOff}>
                            <input type="color" value={props.fill} title="Fill colour" onChange={e => setFillColor(e.target.value)} />
                            <div className="cm-cv-fill">
                              <HexField value={props.fill} label="Fill colour hex" onCommit={v => setFillColor(v)} />
                              <span className="pct"><CommitNumber value={Math.round(props.fillAlpha * 100)} min={0} max={100} aria-label="Fill opacity" onCommit={a => setFillColor(props.fill, a / 100)} />%</span>
                            </div>
                            <PaintEye hidden={props.fillOff} what="fill" onToggle={show => ed().setFillVisible(show)} />
                          </div>
                        ) : (
                          <React.Fragment>
                            <div className="cm-row" style={{ marginTop: 8 }} data-paint-off={props.fillOff}>
                              <button className="cm-btn" data-on={props.shapeGradient.type === 'linear'} onClick={() => setShapeGradientPatch({ type: 'linear' })}>Linear</button>
                              <button className="cm-btn" data-on={props.shapeGradient.type === 'radial'} onClick={() => setShapeGradientPatch({ type: 'radial' })}>Radial</button>
                              <PaintEye hidden={props.fillOff} what="fill" onToggle={show => ed().setFillVisible(show)} />
                            </div>
                            {props.shapeGradient.type === 'linear' && (
                              <div className="cm-slider-row">Angle <input type="range" min="0" max="360" value={fgAngle} onChange={e => setShapeGradientPatch({ angle: +e.target.value })} /><span className="cm-tag mono">{Math.round(fgAngle)}°</span></div>
                            )}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                              {props.shapeGradient.stops.map((stop, i) => (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <input type="color" value={stop.color} onChange={e => {
                                    const stops = props.shapeGradient.stops.map((s, si) => si === i ? { ...s, color: e.target.value } : s);
                                    setShapeGradientPatch({ stops });
                                  }} />
                                  <input type="range" min="0" max="1" step="0.01" value={stop.offset} style={{ flex: 1 }} title="Position" onChange={e => {
                                    const stops = props.shapeGradient.stops.map((s, si) => si === i ? { ...s, offset: +e.target.value } : s);
                                    setShapeGradientPatch({ stops });
                                  }} />
                                  <input type="range" min="0" max="1" step="0.01" value={stop.alpha ?? 1} style={{ flex: 1 }} title="Opacity" onChange={e => {
                                    const stops = props.shapeGradient.stops.map((s, si) => si === i ? { ...s, alpha: +e.target.value } : s);
                                    setShapeGradientPatch({ stops });
                                  }} />
                                  <button className="cm-icon-btn" disabled={props.shapeGradient.stops.length <= 2} title="Remove stop"
                                    onClick={() => setShapeGradientPatch({ stops: props.shapeGradient.stops.filter((_, si) => si !== i) })}>
                                    <Icon name="close" size={12} />
                                  </button>
                                </div>
                              ))}
                            </div>
                            <div className="cm-row" style={{ marginTop: 6 }}>
                              <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} onClick={() => {
                                const last = props.shapeGradient.stops[props.shapeGradient.stops.length - 1];
                                setShapeGradientPatch({ stops: [...props.shapeGradient.stops, { offset: Math.min(1, last?.offset ?? 1), color: last?.color || '#ffffff', alpha: last?.alpha ?? 1 }] });
                              }}>+ Add stop</button>
                              <button className="cm-btn" style={{ flex: 1, justifyContent: 'center' }} title="Reverse stop order"
                                onClick={() => setShapeGradientPatch({ stops: props.shapeGradient.stops.map(s => ({ ...s, offset: 1 - s.offset })).sort((a, b) => a.offset - b.offset) })}>
                                <Icon name="flip" size={13} /> Reverse
                              </button>
                            </div>
                          </React.Fragment>
                        )}
                      </React.Fragment>
                    )}

                    {props.hasBorder && (
                      <React.Fragment>
                        <div className="cm-grp">Border</div>
                        {/* Colour always offered; picking one on a borderless shape also gives it a
                            visible 2px border so the choice isn't a silent no-op (same as the demo). */}
                        <div className="cm-swatch-row" style={{ marginBottom: 2 }} data-paint-off={props.strokeOff}>
                          <input type="color" value={props.stroke} title="Border colour" onChange={e => setStroke(props.strokeWidth > 0 ? { color: e.target.value } : { color: e.target.value, width: 2 })} />
                          <div className="cm-cv-fill">
                            <HexField value={props.stroke} label="Border colour hex" onCommit={v => setStroke(props.strokeWidth > 0 ? { color: v } : { color: v, width: 2 })} />
                            <span className="pct"><CommitNumber value={Math.round(props.strokeAlpha * 100)} min={0} max={100} aria-label="Border opacity" onCommit={a => setStroke(props.strokeWidth > 0 ? { color: props.stroke, alpha: a / 100 } : { color: props.stroke, alpha: a / 100, width: 2 })} />%</span>
                          </div>
                          {/* nothing to hide on a borderless shape */}
                          <PaintEye hidden={props.strokeOff} what="border" disabled={!props.strokeOff && !(props.strokeWidth > 0)} onToggle={show => ed().setStrokeVisible(show)} />
                        </div>
                        <div className="cm-field-row"><span className="cm-field-label">Width</span>
                          <label className="cm-cv-dim cm-field-box"><CommitNumber value={Math.round(props.strokeWidth)} min={0} max={200} aria-label="Border width" onCommit={w => setStroke({ width: w })} /><span>px</span></label>
                          {/* opens the style / align / caps / join rows below */}
                          <button type="button" className="cm-field-icon-btn" title="Border settings" aria-label="Border settings" aria-expanded={strokeAdvOpen}
                            onClick={() => setStrokeAdvOpen(v => !v)}><Icon name="strokeSettings" size={16} /></button>
                        </div>
                        {strokeAdvOpen && props.strokeOpts && (() => {
                          const st = props.strokeOpts, on = props.strokeWidth > 0;
                          // a borderless shape gets a visible 2px border with the option, like picking a colour does
                          const seg = (key, opts, label) => (
                            <div className="cm-seg cm-stroke-seg" role="group" aria-label={label}>
                              {opts.map(([v, l]) => (
                                <button key={v} type="button" className="cm-btn" data-on={String(st[key] === v)} aria-pressed={st[key] === v}
                                  onClick={() => setStroke(on ? { [key]: v } : { [key]: v, width: 2 })}>{l}</button>
                              ))}
                            </div>
                          );
                          return (
                            <React.Fragment>
                              <div className="cm-field-row"><span className="cm-field-label">Style</span>{seg('style', STROKE_STYLES, 'Border style')}</div>
                              {on && st.style !== 'solid' && (
                                <div className="cm-field-row">
                                  {/* dotted: just the gap between dots (the dot size is the width) */}
                                  {st.style === 'dashed' && <React.Fragment>
                                    <span className="cm-field-label">Dash</span>
                                    <label className="cm-cv-dim cm-field-box"><CommitNumber value={Math.round(st.dash)} min={0} max={400} aria-label="Dash length" onCommit={v => setStroke({ dash: v })} /><span>px</span></label>
                                  </React.Fragment>}
                                  <span className="cm-field-label cm-stroke-gap-label">Gap</span>
                                  <label className="cm-cv-dim cm-field-box"><CommitNumber value={Math.round(st.gap)} min={0} max={400} aria-label="Gap length" onCommit={v => setStroke({ gap: v })} /><span>px</span></label>
                                </div>
                              )}
                              {on && st.canPosition && <div className="cm-field-row"><span className="cm-field-label">Align</span>{seg('position', STROKE_POSITIONS, 'Border position')}</div>}
                              {/* dots are round caps by definition */}
                              {on && st.style !== 'dotted' && <div className="cm-field-row"><span className="cm-field-label">Caps</span>{seg('cap', STROKE_CAPS, 'Border caps')}</div>}
                              {/* no corners to join on an ellipse */}
                              {on && !['ellipse', 'circle'].includes(props.shapeType) && <div className="cm-field-row"><span className="cm-field-label">Join</span>{seg('join', STROKE_JOINS, 'Border corners')}</div>}
                            </React.Fragment>
                          );
                        })()}
                      </React.Fragment>
                    )}

                  </React.Fragment>
                )}
              </div>
            )}

            {sideTab === 'design' && (
              <div className="col" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <div className="cm-grp" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>Background &amp; fill</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button className="cm-btn" style={{ width: '100%' }} onClick={extendBackground}><Icon name="expand" size={13} /><span>Extend background to canvas</span></button>
                  <button className="cm-btn" style={{ width: '100%' }} disabled={designBusy} onClick={aiExtendBackground}>
                    {designBusy ? <><span className="cm-btn-spin" /><span>Extending…</span></> : <><Icon name="spark" size={13} /><span>AI extend background</span></>}
                  </button>
                  <label className="cm-btn" style={{ width: '100%', position: 'relative' }}>
                    <Icon name="bucket" size={13} /><span>Fill {props.hasSelectionPixels ? 'selection' : 'canvas'} with colour</span>
                    <input type="color" style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} onChange={e => fillWithColor(e.target.value)} />
                  </label>
                  <button className="cm-btn" style={{ width: '100%' }} onClick={fillWithImagePick}><Icon name="folder" size={13} /><span>Fill {props.hasSelectionPixels ? 'selection' : 'canvas'} with image</span></button>
                </div>
                <div className="cm-note">{designMsg}</div>

                <div className="cm-grp">Add element</div>
                {/* Text/Box/Circle drop a centred object straight away (demo #add-text/#add-box/#add-circle);
                    Paint Layer switches to the brush. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <button className="cm-chip" onClick={() => addCentred('text')}><Icon name="type" size={12} /><span>Text</span></button>
                  <button className="cm-chip" onClick={() => addCentred('rect')}><Icon name="rect" size={12} /><span>Box</span></button>
                  <button className="cm-chip" onClick={() => addCentred('ellipse')}><Icon name="ellipse" size={12} /><span>Circle</span></button>
                  <button className="cm-chip" onClick={addImagePick}><Icon name="image" size={12} /><span>Image</span></button>
                  <button className="cm-chip" onClick={() => ed().setTool('brush')}><Icon name="layerstab" size={12} /><span>Paint Layer</span></button>
                </div>
                <div className="cm-note">Drag &amp; drop / paste an image anywhere on the canvas, or open this page with <code>?image=&lt;url&gt;</code>.</div>

                <div className="cm-grp">Ad copy</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <button className="cm-chip" onClick={() => { ed().addCTA(null, { text: 'Shop now' }); ed().setTool('select'); }}><Icon name="spark" size={12} /><span>CTA</span></button>
                  <button className="cm-chip" onClick={() => { ed().addBadge(null, { text: 'Sale' }); ed().setTool('select'); }}><Icon name="star" size={12} /><span>Badge</span></button>
                  <button className="cm-chip" onClick={() => { ed().addPrice(null, { current: '$29', original: '$40', save: 'Save 27%' }); ed().setTool('select'); }}><Icon name="tag" size={12} /><span>Price</span></button>
                  <button className="cm-chip" onClick={() => { ed().addBrandLockup(null, { text: 'Brand' }); ed().setTool('select'); }}><Icon name="box" size={12} /><span>Brand</span></button>
                </div>

                {assets.length > 0 && (
                  <div>
                    <div className="cm-grp">Assets · click or drag in</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {assets.map(a => (
                        <div key={a.id} className="cm-asset-thumb" title={'Drag onto the canvas, or click to add · ' + a.name}
                          draggable
                          onDragStart={e => { e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/x-canvasmith-asset', a.src); e.dataTransfer.setData('text/plain', a.src); }}
                          onClick={() => ed().addImage(a.src, { name: imageLayerName(a.name) })}>
                          <img src={a.src} alt="" />
                          <span>{a.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {sideTab === 'stickers' && (
              <div>
                <div className="cm-grp" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>Stickers</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  {STICKER_GROUPS.map((g, i) => (
                    <button key={g.label} className="cm-chip" data-on={i === stickerCat} onClick={() => setStickerCat(i)}>{g.label}</button>
                  ))}
                </div>
                <div className="cm-sticker-grid">
                  {(STICKER_GROUPS[stickerCat] || STICKER_GROUPS[0]).keys.map(key => (
                    <button key={key} title={stickerLabel(key)} aria-label={stickerLabel(key)} className="cm-sticker-thumb" onClick={() => ed().addSticker(key)}>
                      <StickerPreview shapeKey={key} neutral />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {sideTab === 'ai' && (
              <React.Fragment>
                <div className="cm-aix-status" data-on={!needKey}>
                  <span className="cm-aix-dot" /><b>AI</b><span className="cm-aix-badge">Free Gemini key</span>
                  {!needKey && <button className="cm-aix-link" disabled={!!aiBusyKind} onClick={() => { ed().ai.provider().setKey(null); setNeedKey(true); }}><span>Change key</span><Icon name="chevron" size={12} /></button>}
                </div>
                {needKey ? (
                  <div className="cm-aix-keyform">
                    AI tools run on <b style={{ color: 'var(--cm-ink)' }}>your own free Gemini key</b> — Google gives every account free daily usage, no card.
                    Create one at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" style={{ color: 'var(--cm-accent)' }}>aistudio.google.com/apikey</a> and paste it:
                    <input className="cm-ai-key" style={{ marginTop: 8 }} placeholder="AIza…" onKeyDown={e => { if (e.key === 'Enter') saveKey(e.target.value.trim()); }} />
                  </div>
                ) : (() => {
                  const busy = !!aiBusyKind;
                  const say = (t, err) => { setAiMsg(t || ''); setAiMsgErr(!!err); };
                  const spin = (kind, label, idle) => aiBusyKind === kind ? <><span className="cm-btn-spin" /><span>{label}</span></> : idle;
                  const run = async (kind, fn, okMsg = 'Applied ✓ (undo to revert)') => {
                    setAiBusyKind(kind); say('');
                    try { const r = await fn(); say(r.status === 'ok' ? okMsg : (r.message || r.reason), r.status !== 'ok'); return r; }
                    finally { setAiBusyKind(null); }
                  };
                  const preset = AI_STYLE_PRESETS.find(([n]) => n === aiPreset);
                  const composed = [aiPrompt.trim(), preset && 'Style: ' + preset[1] + '.'].filter(Boolean).join(' ');
                  const needText = (t) => { say(t, true); if (aiPromptRef.current) aiPromptRef.current.focus(); };
                  const edit = () => composed ? run('edit', () => ed().aiEdit(composed, { reference: aiRef })) : needText('Describe the change first, or pick a style preset.');
                  const enhance = async () => {
                    if (!aiPrompt.trim()) return needText('Type a short description first — Enhance rewrites it.');
                    const r = await run('enhance', () => ed().aiEnhancePrompt(aiPrompt.trim()), 'Description enhanced — review it, then apply.');
                    if (r && r.status === 'ok') setAiPrompt(r.result);
                  };
                  const bg = () => composed ? run('bg', () => ed().aiBgSwap(composed, { reference: aiRef })) : needText('Describe the new background in the box above, then tap Replace BG.');
                  const remove = () => props.hasSelectionPixels ? run('remove', () => ed().aiRemoveSelection()) : say('Select what to remove first — marquee, lasso, wand or object select — then tap Remove.', true);
                  const pickRef = (e) => {
                    const f = e.target.files && e.target.files[0]; e.target.value = '';
                    if (!f) return;
                    const rd = new FileReader();
                    rd.onload = () => downscaleDataURL(rd.result).then(setAiRef, () => say('Could not read that image.', true));
                    rd.readAsDataURL(f);
                  };
                  const qa = (kind, tint, icon, label, title, onClick, busyLabel) => (
                    <button data-tint={tint} title={title} disabled={busy} onClick={onClick}>
                      <span className="ico">{aiBusyKind === kind ? <span className="cm-btn-spin" /> : <Icon name={icon} size={16} />}</span>
                      <span>{aiBusyKind === kind ? busyLabel : label}</span>
                    </button>
                  );
                  return (
                    <React.Fragment>
                      <div className="cm-aix-h"><span>Describe change</span><span className="aside">{props.hasSelectionPixels ? 'Inside selection' : 'Whole canvas'}</span></div>
                      <div className="cm-aix-box">
                        <textarea ref={aiPromptRef} rows={3} placeholder="Describe what you want to change or create…" aria-label="Describe the change" disabled={busy}
                          value={aiPrompt} onChange={e => setAiPrompt(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); edit(); } }} />
                        <div className="cm-aix-foot">
                          {aiRef ? (
                            <span className="cm-aix-ref"><img src={aiRef} alt="" /><span>Reference</span><button title="Remove reference" aria-label="Remove reference" disabled={busy} onClick={() => setAiRef(null)}><Icon name="close" size={11} /></button></span>
                          ) : (
                            <button className="cm-aix-pill" title="Attach an image the AI should take cues from" disabled={busy} onClick={() => aiRefFileRef.current && aiRefFileRef.current.click()}><Icon name="plus" size={13} /><span>Attach reference</span></button>
                          )}
                          <button className="cm-aix-pill enhance" title="Rewrite the description into a clearer, more specific instruction" disabled={busy || !ed().ai.can('enhancePrompt')} onClick={enhance}>
                            {spin('enhance', 'Enhancing…', <><Icon name="spark" size={13} /><span>Enhance</span></>)}
                          </button>
                        </div>
                      </div>
                      <input ref={aiRefFileRef} type="file" accept="image/*" hidden onChange={pickRef} />
                      <button className="cm-aix-apply" disabled={busy} onClick={edit}>{spin('edit', 'Working…', 'Apply AI Edit')}</button>
                      <div className="cm-aix-h"><span>Quick actions</span></div>
                      <div className="cm-aix-qa">
                        {qa('bg', 'blue', 'image', 'Replace BG', 'Replace the background with what the box above describes', bg, 'Replacing…')}
                        {qa('extend', 'purple', 'expand', 'Expand', 'AI-fill any empty canvas around the image', () => run('extend', () => ed().aiExtendBackground()), 'Expanding…')}
                        {qa('remove', 'teal', 'trash', 'Remove', "Erase what's inside the selection and fill it in", remove, 'Removing…')}
                      </div>
                      <div className="cm-aix-h"><span>Style presets</span></div>
                      <div className="cm-aix-chips">
                        {AI_STYLE_PRESETS.map(([name]) => (
                          <button key={name} data-on={aiPreset === name} disabled={busy} onClick={() => setAiPreset(p => p === name ? null : name)}>{name}</button>
                        ))}
                      </div>
                      {aiMsg && <div className="cm-aix-msg" data-err={aiMsgErr}>{aiMsg}</div>}
                    </React.Fragment>
                  );
                })()}

                <div className="cm-aix-convert">
                  <div className="cm-aix-convert-head">
                    <span className="ico"><Icon name="layerstab" size={16} /></span>
                    <div className="txt"><strong>Convert to layers</strong><p>Detects objects and shows them as boxes — adjust, add or remove any, then create editable layers.</p></div>
                    <span className="cm-aix-guided">guided</span>
                  </div>
                  <button className="cm-aix-primary" disabled={convertBusy || reviewOn} onClick={detectAndConvert}>
                    {convertBusy ? <><span className="cm-btn-spin" /><span>Detecting…</span></> : <React.Fragment><Icon name="layerstab" size={13} />Detect &amp; convert to layers</React.Fragment>}
                  </button>
                  <button className="cm-aix-secondary" disabled={convertBusy || reviewOn} onClick={selectOneManually}>
                    <Icon name="lasso" size={13} />Select one object manually
                  </button>
                  {convertMsg && <div className="cm-note" style={{ color: 'var(--cm-accent)' }}>{convertMsg}</div>}
                  <div className="cm-aix-note">Auto-detect everything, or draw one box yourself — adjust, add or remove boxes, then create layers.</div>
                </div>
              </React.Fragment>
            )}
            </div>
            {sideTab === 'layer' && props.active && (
              <div className="cm-props-footer">
                <span>Type: <b>{props.typeLabel}</b></span>
                <span>Status: <b data-locked={props.locked}>{props.locked ? 'Locked' : 'Unlocked'}</b></span>
              </div>
            )}
          </React.Fragment>
        )}
        <ScrollCue within={sideRef} />
      </div>
      {compareOpen && (
        <div className="cm-compare-backdrop" ref={compareRef} role="dialog" aria-modal="true" aria-labelledby="cm-compare-title">
          <div className="cm-compare-header">
            <div>
              <strong id="cm-compare-title">Compare</strong>
              <p>Compare your edited canvas with the first version you opened</p>
            </div>
            <button className="cm-btn cm-compare-close" onClick={closeCompare}><Icon name="close" size={14} />Close</button>
          </div>
          <div className="cm-compare-panes">
            <div className="cm-compare-pane"><span className="cm-compare-label">Original</span><img src={compareSnapshotRef.current} alt="Original" /></div>
            <div className="cm-compare-pane"><span className="cm-compare-label">Current</span><img src={compareAfter} alt="Current" /></div>
          </div>
        </div>
      )}
      {cmdkOpen && (
        <div className="cm-cmdk-backdrop" onClick={e => { if (e.target === e.currentTarget) closeCmdk(); }}>
          <div className="cm-cmdk-box">
            <div className="cm-cmdk-search-row">
              <Icon name="search" size={16} />
              <input ref={cmdkInputRef} className="cm-cmdk-input" placeholder="Search tools & actions…" autoComplete="off"
                value={cmdkQuery}
                onChange={e => { setCmdkQuery(e.target.value); setCmdkIdx(0); }}
                onKeyDown={e => {
                  const items = cmdkFilteredItems();
                  if (e.key === 'ArrowDown') { e.preventDefault(); setCmdkIdx(i => Math.min(items.length - 1, i + 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setCmdkIdx(i => Math.max(0, i - 1)); }
                  else if (e.key === 'Enter') { e.preventDefault(); runCmdkItem(items[cmdkIdx]); }
                  else if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
                }} />
              <span className="cm-tag mono">Esc</span>
            </div>
            <div className="cm-cmdk-list">
              {cmdkFilteredItems().length === 0 ? (
                <div className="cm-cmdk-empty">No matching commands</div>
              ) : cmdkFilteredItems().map((it, i) => (
                <div key={it.group + it.label} className="cm-cmdk-item" data-on={i === cmdkIdx}
                  onMouseMove={() => { if (i !== cmdkIdx) setCmdkIdx(i); }}
                  onClick={() => runCmdkItem(it)}>
                  <Icon name={it.icon} size={15} />
                  <span className="lbl">{it.label}</span>
                  <span className="grp">{it.group}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function downloadURL(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

export default CanvasmithEditor;
