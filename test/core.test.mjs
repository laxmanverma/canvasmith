/* Unit tests for everything in core that is pure data-in/data-out — runs in bare node,
   no DOM, no fabric. The DOM-touching layers get their coverage from the demo smoke test. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeMatch, applyMatch, colorStats } from '../packages/core/src/colormatch.js';
import { applySharpen } from '../packages/core/src/sharpen.js';
import { ADJUST_CONTROLS } from '../packages/core/src/color.js';
import { hexRgb, rgba, toHex, relLum, rgbToHsl, hslToRgb, hexToHsl, recolorPixels, fxToFilterSpecs, FX_DEFAULTS, normalizeGradientStops, splitGradientStopColor } from '../packages/core/src/color.js';
import { History } from '../packages/core/src/history.js';
import { applyGeometry, isGeometryNeutral, straightenScale, keystoneQuad, squareToQuad, mapHomography, geometrySourcePoint } from '../packages/core/src/geometry.js';
import { applyTone, isToneNeutral, buildCurveLut, whiteBalanceGains, TONE_DEFAULTS, normalizeCurves, compactCurves, curveHitTest, curveInsertPoint, curveMovePoint, curveRemovePoint, curveSvgPath, lumaHistogram, MAX_CURVE_POINTS, setHslValue, getHslValue, hslBandTrack } from '../packages/core/src/tone.js';
import {
  startSelection, updateSelection, finalizeSelection, floodSelectPolygon, selectionFillRule,
  startPolyBuild, polyBuildAdd, polyBuildPreview, finishPolyBuild,
  buildEdgeMapFromImageData, snapToEdge,
  selectionPolys, polysToSelection, addPolyToSelection, selectionBounds, HoverCache,
} from '../packages/core/src/selection.js';
import { getCropHandle, dragCropRect } from '../packages/core/src/crop.js';
import { readSession, writeSession, clearSession, discardToTrash, readDiscarded, parseProject } from '../packages/core/src/session.js';
import { alignDelta, snapDelta } from '../packages/core/src/layout.js';
import { parseLaunch } from '../packages/core/src/bridge.js';
import { starPoints, describeLayer, layerLabel, clipLabel } from '../packages/core/src/shapes.js';
import { imageLayerName } from '../packages/core/src/io.js';
import { cvWorkerSource } from '../packages/core/src/cv/worker.js';
import { CvEngine } from '../packages/core/src/cv/client.js';
import { buildPromoLayout } from '../packages/core/src/templates.js';

/* ── colour ─────────────────────────────────────────────────────────── */
test('color: hex round-trips and short form expands', () => {
  assert.deepEqual(hexRgb('#d4ff45'), [212, 255, 69]);
  assert.deepEqual(hexRgb('#fff'), [255, 255, 255]);
  assert.equal(toHex(212, 255, 69), '#d4ff45');
  assert.equal(rgba('#000000', 0.5), 'rgba(0,0,0,0.5)');
  assert.equal(toHex(300, -5, 12), '#ff000c');           // clamps out-of-range
});

test('color: relative luminance orders black < mid < white', () => {
  const black = relLum([0, 0, 0]), mid = relLum([128, 128, 128]), white = relLum([255, 255, 255]);
  assert.ok(black < mid && mid < white);
  assert.ok(Math.abs(white - 1) < 1e-9);
});

/* ── history ────────────────────────────────────────────────────────── */
test('history: push/undo/redo with dedupe, cap and lock', () => {
  const h = new History(3);
  assert.equal(h.push('a'), true);
  assert.equal(h.push('a'), false);                      // identical state collapses
  h.push('b'); h.push('c');
  assert.equal(h.canUndo(), true);
  assert.equal(h.undo(), 'b');                           // returns the state to RESTORE
  assert.equal(h.redo(), 'c');
  h.push('d');                                           // cap=3: 'a' fell off
  assert.deepEqual(h.past, ['b', 'c', 'd']);
  assert.equal(h.push('x') && false || (h.lock = true, h.push('y')), false);  // locked = ignored
  h.lock = false;
  h.undo();
  assert.equal(h.future.length, 1);
  h.push('z');
  assert.equal(h.future.length, 0);                      // a new edit clears redo
});

/* ── selection geometry ─────────────────────────────────────────────── */
test('selection: marquee drag produces a normalized rect; tiny drags are rejected', () => {
  const s = startSelection('marquee', { x: 100, y: 100 });
  updateSelection(s, { x: 40, y: 60 });                  // drag up-left
  assert.deepEqual([s.x, s.y, s.w, s.h], [40, 60, 60, 40]);
  assert.ok(finalizeSelection(s));
  const tiny = startSelection('marquee', { x: 0, y: 0 });
  updateSelection(tiny, { x: 4, y: 4 });
  assert.equal(finalizeSelection(tiny), null);           // slipped click, not intent
});

test('selection: shift constrains marquee to a square', () => {
  const s = startSelection('marquee', { x: 10, y: 10 });
  updateSelection(s, { x: 50, y: 30 }, { square: true });
  assert.equal(s.w, s.h);
  assert.equal(s.w, 40);
});

test('selection: inverted selections clip with evenodd', () => {
  assert.equal(selectionFillRule({ kind: 'rect', invert: true }), 'evenodd');
  assert.equal(selectionFillRule({ kind: 'rect' }), 'nonzero');
});

test('magic wand: flood fill finds the square and traces its boundary', () => {
  // 20x20 white image with a 8x8 black square at (5,5)
  const w = 20, h = 20, data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 5; y < 13; y++) for (let x = 5; x < 13; x++) {
    const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
  }
  const r = floodSelectPolygon({ width: w, height: h, data }, 8, 8, 32);
  assert.ok(r, 'region found');
  assert.deepEqual(r.rect, { x: 5, y: 5, w: 8, h: 8 });
  assert.ok(r.pts && r.pts.length >= 4, 'boundary polygon traced');
  for (const p of r.pts) {
    assert.ok(p.x >= 5 && p.x <= 12 && p.y >= 5 && p.y <= 12, 'contour stays on the square');
  }
});

test('magic wand: clicking noise smaller than 8px selects nothing', () => {
  const w = 10, h = 10, data = new Uint8ClampedArray(w * h * 4).fill(255);
  const i = (5 * w + 5) * 4; data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;   // single dark pixel
  assert.equal(floodSelectPolygon({ width: w, height: h, data }, 5, 5, 10), null);
});

/* ── crop ───────────────────────────────────────────────────────────── */
test('crop: handle hit-testing respects zoom and priority', () => {
  const c = { x: 100, y: 100, w: 200, h: 100 };
  assert.equal(getCropHandle(c, { x: 100, y: 100 }, 1), 'tl');
  assert.equal(getCropHandle(c, { x: 300, y: 200 }, 1), 'br');
  assert.equal(getCropHandle(c, { x: 200, y: 100 }, 1), 't');
  assert.equal(getCropHandle(c, { x: 200, y: 150 }, 1), 'move');
  assert.equal(getCropHandle(c, { x: 0, y: 0 }, 1), null);
  // zoomed in 4x: tolerance shrinks — 8px from the corner no longer grabs 'tl',
  // it falls through to the interior ('move'), exactly like the parent editor
  assert.equal(getCropHandle(c, { x: 108, y: 100 }, 4), 'move');
  assert.equal(getCropHandle(c, { x: 102, y: 101 }, 4), 'tl');   // 2px away still does
});

test('crop: dragging edges resizes, ratio locks aspect, min size holds', () => {
  const c = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(dragCropRect(c, 'move', 10, 5), { x: 10, y: 5, w: 100, h: 100 });
  assert.deepEqual(dragCropRect(c, 'r', 50, 0), { x: 0, y: 0, w: 150, h: 100 });
  const locked = dragCropRect(c, 'br', 100, 0, 2);       // ratio 2:1
  assert.equal(locked.w / locked.h, 2);
  const clamped = dragCropRect(c, 'r', -200, 0);
  assert.equal(clamped.w, 24);                           // never collapses below min
});

/* ── layout: align + snap ──────────────────────────────────────────── */
test('layout: alignDelta moves a box to each artboard edge/axis', () => {
  const box = { left: 30, top: 40, width: 20, height: 10 };
  assert.deepEqual(alignDelta(box, 100, 100, 'left'), { dx: -30, dy: 0 });
  assert.deepEqual(alignDelta(box, 100, 100, 'right'), { dx: 50, dy: 0 });
  assert.deepEqual(alignDelta(box, 100, 100, 'center'), { dx: 10, dy: 0 });
  assert.deepEqual(alignDelta(box, 100, 100, 'top'), { dx: 0, dy: -40 });
  assert.deepEqual(alignDelta(box, 100, 100, 'bottom'), { dx: 0, dy: 50 });
  assert.deepEqual(alignDelta(box, 100, 100, 'middle'), { dx: 0, dy: 5 });
});

test('layout: snapDelta pulls a moving box to the artboard center within threshold', () => {
  const box = { left: 46, top: 46, width: 10, height: 10 };   // center at (51,51), artboard center (50,50)
  const r = snapDelta(box, 100, 100, [], 8);
  assert.equal(r.snappedX, true); assert.equal(r.snappedY, true);
  assert.equal(box.left + r.dx + box.width / 2, 50);
  assert.equal(box.top + r.dy + box.height / 2, 50);
});

test('layout: snapDelta snaps to a sibling layer edge, ignores out-of-threshold ones', () => {
  const box = { left: 108, top: 0, width: 20, height: 20 };   // left edge at 108
  const sibling = { left: 0, top: 0, width: 100, height: 20 }; // right edge at 100 — 8px away, within threshold
  const r = snapDelta(box, 500, 500, [sibling], 8);
  assert.equal(r.snappedX, true);
  assert.equal(box.left + r.dx, 100);
  const far = snapDelta({ ...box, left: 130 }, 500, 500, [sibling], 8);
  assert.equal(far.snappedX, false);
  assert.equal(far.dx, 0);
});

/* ── bridge launch parsing ──────────────────────────────────────────── */
test('bridge: parses ?image=, #img=, storage handoff, and rejects junk', () => {
  assert.deepEqual(parseLaunch('?image=https%3A%2F%2Fx.com%2Fa.png', '', null),
    { kind: 'url', src: 'https://x.com/a.png' });
  assert.equal(parseLaunch('?image=javascript:alert(1)', '', null), null);   // scheme rejected
  const d = 'data:image/png;base64,AAAA';
  assert.deepEqual(parseLaunch('', '#img=' + encodeURIComponent(d), null), { kind: 'data', src: d });
  assert.deepEqual(parseLaunch('', '', d), { kind: 'storage', src: d });
  assert.equal(parseLaunch('', '', 'not-an-image'), null);
  // URL param beats storage
  assert.equal(parseLaunch('?image=https://x.com/a.png', '', d).kind, 'url');
});

/* ── shapes ─────────────────────────────────────────────────────────── */
test('shapes: starPoints yields 2n vertices alternating radii', () => {
  const pts = starPoints(0, 0, 10, 5, 5);
  assert.equal(pts.length, 10);
  const r0 = Math.hypot(pts[0].x, pts[0].y), r1 = Math.hypot(pts[1].x, pts[1].y);
  assert.ok(Math.abs(r0 - 10) < 1e-9 && Math.abs(r1 - 5) < 1e-9);
});

/* ── HSL recolour ───────────────────────────────────────────────────── */
test('color: rgb<->hsl round-trips exactly for integer channels', () => {
  for (const [r, g, b] of [[200, 50, 50], [0, 0, 0], [255, 255, 255], [10, 200, 90]]) {
    const hsl = rgbToHsl(r, g, b);
    assert.deepEqual(hslToRgb(hsl.h, hsl.s, hsl.l), { r, g, b });
  }
});

test('color: hexToHsl matches rgbToHsl of the same colour', () => {
  assert.deepEqual(hexToHsl('#6496c8'), rgbToHsl(100, 150, 200));
});

test('color: recolorPixels keeps lightness, skips transparent pixels', () => {
  // a mid-grey pixel recoloured toward pure green should land near pure green at the same lightness
  const data = new Uint8ClampedArray([128, 128, 128, 255, /* transparent: */ 9, 9, 9, 0]);
  recolorPixels(data, '#00ff00');
  const before = rgbToHsl(128, 128, 128), after = rgbToHsl(data[0], data[1], data[2]);
  assert.ok(Math.abs(before.l - after.l) < 1e-6, 'lightness preserved');
  assert.deepEqual([data[4], data[5], data[6], data[7]], [9, 9, 9, 0], 'transparent pixel untouched');
});

/* ── polygon lasso (click-to-place) ─────────────────────────────────── */
test('selection: polyBuildAdd closes the loop near the first point', () => {
  let b = startPolyBuild();
  b = polyBuildAdd(b, { x: 0, y: 0 });
  b = polyBuildAdd(b, { x: 10, y: 0 });
  b = polyBuildAdd(b, { x: 10, y: 10 });
  const closed = polyBuildAdd(b, { x: 1, y: 1 }, 12);
  assert.equal(closed.closed, true);
  assert.equal(closed.pts.length, 3);               // the closing click is not added as a 4th vertex
});

test('selection: polyBuildAdd keeps building when far from the start', () => {
  let b = startPolyBuild();
  b = polyBuildAdd(b, { x: 0, y: 0 });
  b = polyBuildAdd(b, { x: 50, y: 50 });
  assert.equal(b.closed, undefined);
  assert.equal(b.pts.length, 2);
});

test('selection: polyBuildPreview appends a trailing point without mutating the build', () => {
  const b = { pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] };
  const preview = polyBuildPreview(b, { x: 10, y: 10 });
  assert.equal(preview.kind, 'poly');
  assert.equal(preview.building, true);
  assert.equal(preview.pts.length, 3);
  assert.equal(b.pts.length, 2);                     // original build untouched
});

test('selection: finishPolyBuild rejects cancellation and too-short builds', () => {
  assert.equal(finishPolyBuild({ pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), null);   // < 3 points
  assert.equal(finishPolyBuild({ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, true), null); // cancelled
  const ok = finishPolyBuild({ pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }, false);
  assert.deepEqual(ok, { kind: 'poly', pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] });
});

/* ── magnetic lasso: edge map + snap ────────────────────────────────── */
test('selection: buildEdgeMapFromImageData + snapToEdge pulls a point onto a bright edge', () => {
  const w = 10, h = 10, data = new Uint8ClampedArray(w * h * 4).fill(0);
  for (let x = 0; x < w; x++) { const i = (5 * w + x) * 4; data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255; }
  const map = buildEdgeMapFromImageData({ width: w, height: h, data }, 100, 100);   // scene is a 10x scale of the 10px grid
  // the Sobel gradient peaks at the bright row's edges (grid rows 4 and 6), not the row itself
  const snapped = snapToEdge(map, { x: 50, y: 42 });
  assert.ok(snapped.y === 40 || snapped.y === 60, 'snapped onto one of the bright row\'s edges');
  const farFromAnyEdge = snapToEdge(map, { x: 50, y: 95 }, 2);   // small radius can't reach the edge from here
  assert.deepEqual(farFromAnyEdge, { x: 50, y: 95 });
});

test('selection: snapToEdge returns the point unchanged with no edge map', () => {
  assert.deepEqual(snapToEdge(null, { x: 5, y: 5 }), { x: 5, y: 5 });
});

/* ── selection composition: add / bounds ────────────────────────────── */
test('selection: selectionPolys normalizes rect/poly/multipoly into polygon rings', () => {
  assert.deepEqual(selectionPolys(null), null);
  assert.deepEqual(selectionPolys({ kind: 'rect', x: 0, y: 0, w: 10, h: 5 }),
    [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]]);
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  assert.deepEqual(selectionPolys({ kind: 'poly', pts }), [pts]);
  const polys = [pts, pts];
  assert.equal(selectionPolys({ kind: 'multipoly', polys }), polys);
});

test('selection: polysToSelection wraps one ring as poly, several as multipoly', () => {
  const ring = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  assert.deepEqual(polysToSelection([ring]), { kind: 'poly', pts: ring });
  assert.deepEqual(polysToSelection([ring, ring]), { kind: 'multipoly', polys: [ring, ring] });
  assert.equal(polysToSelection([]), null);
});

test('selection: addPolyToSelection accumulates into a multipoly without a prior selection', () => {
  const ring = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
  const sel = addPolyToSelection(null, ring);
  assert.deepEqual(sel, { kind: 'poly', pts: ring });
  const sel2 = addPolyToSelection(sel, ring);
  assert.equal(sel2.kind, 'multipoly');
  assert.equal(sel2.polys.length, 2);
});

test('selection: selectionBounds covers rect, poly and the no-selection (full canvas) case', () => {
  assert.deepEqual(selectionBounds(null, 200, 100), { x: 0, y: 0, w: 200, h: 100 });
  assert.deepEqual(selectionBounds({ kind: 'rect', x: 5, y: 5, w: 10, h: 20 }, 200, 100), { x: 5, y: 5, w: 10, h: 20 });
  const poly = { kind: 'poly', pts: [{ x: 3, y: 4 }, { x: 9, y: 1 }, { x: 6, y: 8 }] };
  assert.deepEqual(selectionBounds(poly, 200, 100), { x: 3, y: 1, w: 6, h: 7 });
});

test('selection: HoverCache is a capped LRU — least-recently-inserted evicts when never accessed', () => {
  const c = new HoverCache(2);
  c.put('a', 1); c.put('b', 2); c.put('c', 3);        // 'a' evicted — cap is 2
  assert.equal(c.get('a'), null);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);
});

test('selection: HoverCache.get refreshes recency, so a re-accessed entry survives eviction', () => {
  const c = new HoverCache(2);
  c.put('a', 1); c.put('b', 2);
  c.get('a');                                          // 'a' is now the most-recently-used
  c.put('c', 3);                                        // 'b' is least-recently-used — evicted, not 'a'
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), null);
  assert.equal(c.get('c'), 3);
});

/* ── OpenCV worker: stringified source is self-contained and boots lazily ──────────────── */
test('cv: cvWorkerSource embeds the OpenCV URL and is syntactically valid standalone JS', () => {
  const src = cvWorkerSource('https://example.test/opencv.js');
  assert.ok(src.includes('https://example.test/opencv.js'));
  assert.ok(src.includes('importScripts'));
  assert.doesNotThrow(() => new Function(src));       // parses; never executed outside a Worker
});

test('cv: CvEngine degrades to null (never throws) with no Worker support', async () => {
  const cv = new CvEngine();
  const img = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  const r = await cv.wand(img, { cx: 1, cy: 1 }, 32, 0.002);
  assert.equal(r, null);
  assert.equal(cv.unavailable, true);
  cv.destroy();
});

/* ── image adjustment: fx -> Fabric filter spec mapping (Editor#setImageFilters) ──────────── */
test('color: fxToFilterSpecs maps defaults to zero/neutral filter params', () => {
  const specs = fxToFilterSpecs(FX_DEFAULTS);
  assert.deepEqual(specs.map(s => s.type), ['Tone', 'Brightness', 'Contrast', 'Saturation', 'Blur', 'HueRotation', 'Vibrance', 'Invert']);
  assert.deepEqual(specs.find(s => s.type === 'Brightness').params, { brightness: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Contrast').params, { contrast: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Saturation').params, { saturation: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Blur').params, { blur: 0 });
  assert.deepEqual(specs.find(s => s.type === 'HueRotation').params, { rotation: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Vibrance').params, { vibrance: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Invert').params, { invert: false });
});

test('color: fxToFilterSpecs maps non-default human values exactly like the reference setFx', () => {
  const specs = fxToFilterSpecs({ brightness: 150, contrast: 50, saturate: 200, blur: 10, hue: 90, vibrance: 50, invert: true });
  assert.deepEqual(specs.find(s => s.type === 'Brightness').params, { brightness: 0.5 });
  assert.deepEqual(specs.find(s => s.type === 'Contrast').params, { contrast: -0.5 });
  assert.deepEqual(specs.find(s => s.type === 'Saturation').params, { saturation: 1 });
  assert.deepEqual(specs.find(s => s.type === 'Blur').params, { blur: 0.5 });
  assert.deepEqual(specs.find(s => s.type === 'HueRotation').params, { rotation: 0.5 });
  assert.deepEqual(specs.find(s => s.type === 'Vibrance').params, { vibrance: 0.5 });
  assert.deepEqual(specs.find(s => s.type === 'Invert').params, { invert: true });
});

test('color: fxToFilterSpecs fills in missing keys from FX_DEFAULTS', () => {
  const specs = fxToFilterSpecs({ blur: 4 });
  assert.deepEqual(specs.find(s => s.type === 'Brightness').params, { brightness: 0 });
  assert.deepEqual(specs.find(s => s.type === 'Blur').params, { blur: 0.2 });
});

/* ── tone.js: exposure / highlights+shadows / white balance / curves / HSL ─────────────────── */
const px = (...rgb) => new Uint8ClampedArray([...rgb, 255]);
const toneOf = (rgb, p) => [...applyTone(px(...rgb), p).slice(0, 3)];

test('tone: neutral params are a byte-exact no-op and report neutral', () => {
  assert.equal(isToneNeutral(TONE_DEFAULTS), true);
  assert.equal(isToneNeutral({ curves: { rgb: [[0, 0], [128, 128], [255, 255]] }, hsl: { red: { h: 0, s: 0, l: 0 } } }), true);
  assert.deepEqual(toneOf([12, 130, 250], {}), [12, 130, 250]);
});

test('tone: fxToFilterSpecs passes every tone key through to the Tone spec', () => {
  const curves = { rgb: [[0, 20], [255, 255]] };
  const tone = fxToFilterSpecs({ exposure: 1, highlights: -40, curves }).find(s => s.type === 'Tone').params;
  assert.equal(tone.exposure, 1); assert.equal(tone.highlights, -40); assert.equal(tone.curves, curves);
  assert.equal(tone.shadows, 0); assert.equal(tone.hsl, null);
});

test('tone: +1 EV doubles linear light (mid grey 118 -> ~161), -1 EV halves it', () => {
  const [up] = toneOf([118, 118, 118], { exposure: 1 });
  const [down] = toneOf([118, 118, 118], { exposure: -1 });
  assert.ok(Math.abs(up - 161) <= 2, 'got ' + up);
  assert.ok(Math.abs(down - 84) <= 2, 'got ' + down);
  assert.deepEqual(toneOf([0, 0, 0], { exposure: 3 }), [0, 0, 0]);
});

test('tone: shadows lift darks far more than brights; highlights recover brights, leave darks', () => {
  const [d] = toneOf([40, 40, 40], { shadows: 100 }), [b] = toneOf([230, 230, 230], { shadows: 100 });
  assert.ok(d - 40 > 20 && b - 230 < 3, `dark +${d - 40}, bright +${b - 230}`);
  const [d2] = toneOf([40, 40, 40], { highlights: -100 }), [b2] = toneOf([230, 230, 230], { highlights: -100 });
  assert.ok(230 - b2 > 30 && 40 - d2 < 2, `bright -${230 - b2}, dark -${40 - d2}`);
});

test('tone: highlights/shadows stay monotonic at every extreme', () => {
  for (const p of [{ highlights: -100 }, { highlights: 100 }, { shadows: -100 }, { shadows: 100 }, { highlights: -100, shadows: 100 }]) {
    let prev = -1;
    for (let v = 0; v < 256; v += 5) { const [o] = toneOf([v, v, v], p); assert.ok(o >= prev, JSON.stringify(p) + ' at ' + v); prev = o; }
  }
});

test('tone: highlights/shadows preserve hue (channel ratios) on a coloured pixel', () => {
  const [r, g, b] = toneOf([40, 20, 10], { shadows: 60 });
  assert.ok(Math.abs(r / g - 2) < 0.15 && Math.abs(g / b - 2) < 0.25, [r, g, b].join());
});

test('tone: temperature warms (R up, B down) / cools, tint trades green for magenta, grey stays ~grey-bright', () => {
  const [wr, , wb] = toneOf([128, 128, 128], { temperature: 60 });
  assert.ok(wr > 128 && wb < 128);
  const [cr, , cb] = toneOf([128, 128, 128], { temperature: -60 });
  assert.ok(cr < 128 && cb > 128);
  const [mr, mg] = toneOf([128, 128, 128], { tint: 60 });
  assert.ok(mg < 128 && mr > 128);
  const g = whiteBalanceGains(80, -30);
  assert.ok(Math.abs(0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2] - 1) < 1e-9, 'luminance-normalised');
});

test('tone: buildCurveLut hits its control points, is identity by default, never overshoots', () => {
  const id = buildCurveLut(null);
  for (let i = 0; i < 256; i += 17) assert.ok(Math.abs(id[i] - i) < 1e-4);
  const s = buildCurveLut([[0, 0], [64, 40], [192, 215], [255, 255]]);
  assert.ok(Math.abs(s[64] - 40) < 1e-4 && Math.abs(s[192] - 215) < 1e-4);
  for (let i = 1; i < 256; i++) assert.ok(s[i] >= s[i - 1] - 1e-4, 'monotone at ' + i);
  const flat = buildCurveLut([[50, 30], [200, 220]]);
  assert.equal(flat[0], 30); assert.equal(flat[255], 220);
});

test('tone: curves apply master then per-channel', () => {
  const inv = [[0, 255], [255, 0]];
  assert.deepEqual(toneOf([10, 100, 200], { curves: { rgb: inv } }), [245, 155, 55]);
  const [r, g, b] = toneOf([100, 100, 100], { curves: { r: [[0, 0], [100, 150], [255, 255]] } });
  assert.deepEqual([r, g, b], [150, 100, 100]);
});

test('tone: HSL band targets its own hue, leaves distant hues and greys alone', () => {
  const hsl = { blue: { h: 0, s: -100, l: 0 } };
  const [br, bg, bb] = toneOf([30, 60, 220], { hsl });
  // hue ~230deg sits 5/6 of the way from aqua to blue, so it gets ~95% of the blue band's effect
  assert.ok(Math.max(br, bg, bb) - Math.min(br, bg, bb) < 20, 'blue desaturated: ' + [br, bg, bb]);
  assert.deepEqual(toneOf([220, 40, 30], { hsl }), [220, 40, 30]);
  assert.deepEqual(toneOf([128, 128, 128], { hsl: { red: { h: 100, s: 100, l: 100 } } }), [128, 128, 128]);
  const [, , lb] = toneOf([30, 60, 220], { hsl: { blue: { l: -100 } } });
  assert.ok(lb < 200, 'blue luminance down: ' + lb);
  const [hr, hg] = toneOf([220, 30, 30], { hsl: { red: { h: 100 } } });
  assert.ok(hg > 60 && hr > 180, 'red hue shifted toward orange: ' + [hr, hg]);
});

test('curves UI: normalize fills identity, compact drops it back to null', () => {
  const n = normalizeCurves({ r: [[0, 10], [255, 255]] });
  assert.deepEqual(n.rgb, [[0, 0], [255, 255]]); assert.deepEqual(n.r, [[0, 10], [255, 255]]);
  assert.deepEqual(compactCurves(n), { r: [[0, 10], [255, 255]] });
  assert.equal(compactCurves(normalizeCurves(null)), null);
});

test('curves UI: insert keeps order, refuses duplicate x and the point cap', () => {
  const { points, index } = curveInsertPoint([[0, 0], [255, 255]], 100.4, 140);
  assert.deepEqual(points, [[0, 0], [100, 140], [255, 255]]); assert.equal(index, 1);
  assert.equal(curveInsertPoint(points, 100, 20).index, -1);
  let pts = [[0, 0], [255, 255]];
  for (let x = 10; pts.length < MAX_CURVE_POINTS; x += 10) pts = curveInsertPoint(pts, x, x).points;
  assert.equal(curveInsertPoint(pts, 251, 3).index, -1);
});

test('curves UI: move clamps between neighbours; endpoints are not removable', () => {
  const pts = [[0, 0], [100, 100], [200, 200], [255, 255]];
  assert.deepEqual(curveMovePoint(pts, 1, 250, 300)[1], [199, 255]);
  assert.deepEqual(curveMovePoint(pts, 0, 50, 30)[0], [50, 30]);
  assert.deepEqual(curveMovePoint(pts, 0, 150, 30)[0], [99, 30]);
  assert.equal(curveRemovePoint(pts, 0), pts);
  assert.deepEqual(curveRemovePoint(pts, 2), [[0, 0], [100, 100], [255, 255]]);
  assert.equal(curveHitTest(pts, 104, 97), 1); assert.equal(curveHitTest(pts, 150, 60), -1);
});

test('curves UI: svg path starts bottom-left and ends top-right for identity', () => {
  const d = curveSvgPath([[0, 0], [255, 255]], 100);
  assert.ok(d.startsWith('M0.0 100.0')); assert.ok(d.endsWith('L100 0.0'));
});

test('curves UI: lumaHistogram peaks at 1, skips transparent pixels', () => {
  const data = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 0]);
  const h = lumaHistogram(data);
  assert.equal(h[0], 1); assert.ok(Math.abs(h[255] - Math.SQRT1_2) < 1e-6);
});

test('hsl UI: setHslValue keeps the stored shape minimal and collapses to null', () => {
  let h = setHslValue(null, 'blue', 's', -40);
  assert.deepEqual(h, { blue: { s: -40 } });
  h = setHslValue(h, 'red', 'h', 10);
  assert.equal(getHslValue(h, 'red', 'h'), 10); assert.equal(getHslValue(h, 'red', 'l'), 0);
  h = setHslValue(h, 'blue', 's', 0);
  assert.deepEqual(h, { red: { h: 10 } });
  assert.equal(setHslValue(h, 'red', 'h', 0), null);
  assert.match(hslBandTrack('green', 'h'), /hsl\(90 .*hsl\(150 /);
});

/* ── geometry.js: straighten / keystone / 4-corner perspective ─────────────────────────────── */
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
test('geometry: neutral params are a byte-exact no-op', () => {
  assert.equal(isGeometryNeutral({ quad: [[0, 0], [1, 0], [1, 1], [0, 1]] }), true);
  const d = new Uint8ClampedArray(4 * 6).map((_, i) => i * 7);
  assert.deepEqual([...applyGeometry(new Uint8ClampedArray(d), 3, 2, {})], [...d]);
});

test('geometry: straightenScale is 1 at 0deg and grows so the rotated frame always covers it', () => {
  assert.equal(straightenScale(0, 400, 300), 1);
  for (const a of [3, -10, 25, 45]) {
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const [x, y] = geometrySourcePoint({ angle: a }, u, v, 400, 300);
      assert.ok(x >= -1e-9 && x <= 1 + 1e-9 && y >= -1e-9 && y <= 1 + 1e-9, `angle ${a} corner ${u},${v} -> ${x},${y}`);
    }
  }
  // tight: at least one corner lands exactly on the source edge
  const xs = [[0, 0], [1, 0], [1, 1], [0, 1]].flatMap(([u, v]) => geometrySourcePoint({ angle: 12 }, u, v, 400, 300));
  assert.ok(xs.some(c => near(c, 0, 1e-9) || near(c, 1, 1e-9)));
});

test('geometry: squareToQuad maps the unit square corners onto the quad', () => {
  const q = [[0.1, 0.05], [0.95, 0.1], [0.8, 0.9], [0.2, 1]];
  const H = squareToQuad(q);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const [x, y] = mapHomography(H, u, v);
    assert.ok(near(x, q[i][0]) && near(y, q[i][1]), `corner ${i}`);
  });
  assert.equal(squareToQuad([[0, 0], [1, 0], [2, 0], [3, 0]]), null);
});

test('geometry: keystone quads stay inside the source (never expose empty space)', () => {
  assert.deepEqual(keystoneQuad(0, 0), [[0, 0], [1, 0], [1, 1], [0, 1]]);
  const q = keystoneQuad(100, 0);
  assert.ok(near(q[0][0], 0.15) && near(q[1][0], 0.85) && q[2][0] === 1 && q[3][0] === 0);
  for (const [v, h] of [[100, 100], [-100, -100], [60, -40]]) {
    keystoneQuad(v, h).flat().forEach(c => assert.ok(c >= 0 && c <= 1));
  }
});

test('geometry: a 180-degree-style quad flip actually resamples pixels', () => {
  // 2x1 image: red | blue. Quad mirrored horizontally -> blue | red.
  const d = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]);
  applyGeometry(d, 2, 1, { quad: [[1, 0], [0, 0], [0, 1], [1, 1]] });
  assert.deepEqual([...d], [0, 0, 255, 255, 255, 0, 0, 255]);
});

test('geometry: the incremental resampler agrees with geometrySourcePoint (rotation + quad)', () => {
  // R channel encodes x, G encodes y — the output then reads back where each pixel sampled from
  const W = 200, H = 120, d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; d[i] = x * 255 / (W - 1); d[i + 1] = y * 255 / (H - 1); d[i + 3] = 255; }
  const p = { angle: 9, quad: [[0.1, 0.05], [0.9, 0], [0.95, 1], [0.02, 0.9]] };
  applyGeometry(d, W, H, p);
  for (const [px, py] of [[10, 10], [100, 60], [190, 110], [37, 83]]) {
    const [u, v] = geometrySourcePoint(p, (px + 0.5) / W, (py + 0.5) / H, W, H);
    const i = (py * W + px) * 4;
    assert.ok(Math.abs(d[i] - ((u * W - 0.5) * 255 / (W - 1))) <= 2.5, `x at ${px},${py}: ${d[i]}`);
    assert.ok(Math.abs(d[i + 1] - ((v * H - 0.5) * 255 / (H - 1))) <= 2.5, `y at ${px},${py}: ${d[i + 1]}`);
  }
});

test('geometry: a user quad reaching outside the image yields transparent samples', () => {
  const d = new Uint8ClampedArray(4 * 16).fill(200);
  applyGeometry(d, 4, 4, { quad: [[-1, -1], [1, 0], [1, 1], [0, 1]] });
  assert.equal(d[3], 0);            // top-left output pixel samples off-image
  assert.equal(d[4 * 15 + 3], 200); // bottom-right still on-image
});

/* ── shapes.js describeLayer: layer-row subtitles ─────────────────────────────────────────── */
test('describeLayer: text, groups, images, backgrounds and ad roles read like the design', () => {
  const sz = (w, h) => ({ getScaledWidth: () => w, getScaledHeight: () => h });
  assert.deepEqual(describeLayer({ type: 'i-text', fontFamily: '"Inter", sans-serif', fontWeight: 900, fontSize: 36, scaleY: 2 }), { kind: 'text', subtitle: 'Text: Inter Black 72pt' });
  assert.equal(describeLayer({ type: 'group', _objects: [{ type: 'rect' }, { type: 'rect' }] }).subtitle, 'Group (2 elements)');
  assert.equal(describeLayer({ type: 'group', _objects: [{ type: 'textbox' }, { type: 'rect' }] }).subtitle, 'Text & Vector Group');
  // a baked-text sticker is one element, not a folder of two layers
  assert.deepEqual(describeLayer({ type: 'group', role: 'shape', name: 'Sticker', _objects: [{ type: 'polygon' }, { type: 'i-text' }] }), { kind: 'badge', subtitle: 'Sticker' });
  assert.equal(layerLabel({ type: 'group', role: 'shape', name: 'Sticker', _objects: [{}, {}] }), 'Sticker');
  assert.deepEqual(describeLayer({ type: 'image', ...sz(1080, 1080) }), { kind: 'image', subtitle: '1080×1080 Image' });
  assert.equal(describeLayer({ type: 'image', maskCanvas: {}, ...sz(10, 20) }).subtitle, '10×20 Masked image');
  assert.equal(describeLayer({ type: 'rect', role: 'bg', locked: true }).subtitle, 'Locked Solid Fill');
  assert.equal(describeLayer({ type: 'group', role: 'badge' }).kind, 'badge');
  assert.equal(describeLayer({ type: 'rect' }).subtitle, 'Vector Shape');
  assert.equal(describeLayer({ type: 'image', role: 'adjustment' }).kind, 'adjustment');
});

/* ── gradient stops: alpha folding + round-trip (Editor#getShapeGradient's UI-facing consumers) ── */
test('color: normalizeGradientStops passes a fully-opaque stop color through unchanged', () => {
  const norm = normalizeGradientStops([{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#00ff00', alpha: 1 }]);
  assert.equal(norm[0].color, '#ff0000');
  assert.equal(norm[1].color, '#00ff00');
});

test('color: normalizeGradientStops folds alpha < 1 into an rgba() string', () => {
  const norm = normalizeGradientStops([{ offset: 0, color: '#ff0000', alpha: 0.5 }]);
  assert.equal(norm[0].color, 'rgba(255,0,0,0.5)');
});

test('color: normalizeGradientStops clamps a negative alpha to 0 rather than going negative', () => {
  const norm = normalizeGradientStops([{ offset: 0, color: '#0000ff', alpha: -5 }]);
  assert.equal(norm[0].color, 'rgba(0,0,255,0)');
});

test('color: normalizeGradientStops treats alpha >= 1 as fully opaque (plain hex, no rgba wrap)', () => {
  const norm = normalizeGradientStops([{ offset: 0, color: '#0000ff', alpha: 5 }]);
  assert.equal(norm[0].color, '#0000ff');
});

test('color: splitGradientStopColor decodes an rgba() string back to color + alpha', () => {
  assert.deepEqual(splitGradientStopColor('rgba(255,0,0,0.5)'), { color: '#ff0000', alpha: 0.5 });
  assert.deepEqual(splitGradientStopColor('rgb(0,255,0)'), { color: '#00ff00', alpha: 1 });
});

test('color: splitGradientStopColor treats a plain hex as fully opaque', () => {
  assert.deepEqual(splitGradientStopColor('#7c3aed'), { color: '#7c3aed', alpha: 1 });
});

/* ── promo layout: buildPromoLayout's pure percentage-of-artboard positioning (no fabric touched;
   see templates.js's own header for why the fabric-object-building half lives in the browser
   suite instead) ─────────────────────────────────────────────────────────────────────────────── */
test('templates: buildPromoLayout always leads with a locked full-canvas background layer', () => {
  const { layers } = buildPromoLayout({}, 1080, 1080);
  assert.equal(layers[0].id, 'bg');
  assert.equal(layers[0].role, 'bg');
  assert.equal(layers[0].width, 1080); assert.equal(layers[0].height, 1080);
  assert.equal(layers[0].locked, true);
});

test('templates: unknown/omitted layout falls back to the centered group', () => {
  const centered = buildPromoLayout({ layout: 'centered' }, 1000, 1000);
  const omitted = buildPromoLayout({}, 1000, 1000);
  const bogus = buildPromoLayout({ layout: 'not-a-real-layout' }, 1000, 1000);
  const kinds = (r) => r.layers.map(l => l.id).sort();
  assert.deepEqual(kinds(centered), kinds(omitted));
  assert.deepEqual(kinds(centered), kinds(bogus));
  // centered group: brand centered, headline centered, product ellipse (no explicit image), no scrim/burst
  assert.ok(centered.layers.some(l => l.id === 'brand' && l.originX === 'center'));
  assert.ok(centered.layers.some(l => l.id === 'headline' && l.align === 'center'));
  assert.ok(centered.layers.some(l => l.id === 'product' && l.kind === 'ellipse'));
  assert.ok(!centered.layers.some(l => l.id === 'scrim' || l.id === 'burst'));
});

test('templates: hero/editorial/lookbook/split all fold into the same hero group layout', () => {
  const ids = ['hero', 'editorial', 'lookbook', 'split'].map(layout => buildPromoLayout({ layout }, 1080, 1350).layers.map(l => l.id));
  ids.forEach(list => assert.deepEqual(list, ids[0]));
  const hero = buildPromoLayout({ layout: 'hero' }, 1080, 1350);
  assert.ok(hero.layers.some(l => l.id === 'scrim' && l.fill === 'scrim'));
  assert.ok(hero.layers.some(l => l.id === 'product' && l.left === 0 && l.top === 0));
});

test('templates: sale layout adds an accent burst and rotates the product corner shot', () => {
  const sale = buildPromoLayout({ layout: 'sale' }, 1080, 1080);
  const burst = sale.layers.find(l => l.id === 'burst');
  assert.ok(burst);
  assert.equal(burst.kind, 'ellipse');
  assert.equal(burst.fill, sale.accent);
  const product = sale.layers.find(l => l.id === 'product');
  assert.equal(product.angle, -8);
});

test('templates: badge layer is omitted entirely when no badge text is given, present when it is', () => {
  const noBadge = buildPromoLayout({ layout: 'centered' }, 1000, 1000);
  const withBadge = buildPromoLayout({ layout: 'centered', badge: 'New' }, 1000, 1000);
  assert.ok(!noBadge.layers.some(l => l.id === 'badge'));
  const b = withBadge.layers.find(l => l.id === 'badge');
  assert.ok(b);
  assert.equal(b.text, 'New');
});

test('templates: subhead layer is omitted when sub is empty, present with the given text otherwise', () => {
  const noSub = buildPromoLayout({ layout: 'hero', sub: '' }, 1080, 1350);
  const withSub = buildPromoLayout({ layout: 'hero', sub: 'Limited time only' }, 1080, 1350);
  assert.ok(!noSub.layers.some(l => l.id === 'sub'));
  const s = withSub.layers.find(l => l.id === 'sub');
  assert.equal(s.text, 'Limited time only');
});

test('templates: a dark accent picks light (white) ink, a light accent picks dark ink, for legibility', () => {
  const dark = buildPromoLayout({ palette: { accent: '#111114' } }, 1000, 1000);
  const light = buildPromoLayout({ palette: { accent: '#f5f3ee' } }, 1000, 1000);
  const darkCta = dark.layers.find(l => l.id === 'cta'), lightCta = light.layers.find(l => l.id === 'cta');
  assert.equal(darkCta.ink, '#ffffff');
  assert.equal(lightCta.ink, '#0c0c0e');
});

test('templates: product without a productImg falls back to a placeholder kind (rect/ellipse, not image)', () => {
  const noImg = buildPromoLayout({ layout: 'hero' }, 1080, 1350);
  const withImg = buildPromoLayout({ layout: 'hero', productImg: 'data:image/png;base64,x' }, 1080, 1350);
  assert.equal(noImg.layers.find(l => l.id === 'product').kind, 'rect');
  assert.equal(withImg.layers.find(l => l.id === 'product').kind, 'image');
});

test('templates: layer geometry scales with W/H (percentage-of-artboard, not fixed pixels)', () => {
  const small = buildPromoLayout({ layout: 'centered' }, 500, 500);
  const big = buildPromoLayout({ layout: 'centered' }, 1000, 1000);
  const headSmall = small.layers.find(l => l.id === 'headline'), headBig = big.layers.find(l => l.id === 'headline');
  assert.equal(headBig.size, headSmall.size * 2);
  assert.equal(headBig.top, headSmall.top * 2);
});

test('history: rebase makes a state the floor of the stack, whatever was recorded before it', () => {
  const h = new History();
  h.push('empty'); h.push('a'); h.push('b');
  h.undo();                                              // something on the redo stack too
  assert.ok(h.future.length > 0);

  assert.equal(h.rebase('restored'), true);
  assert.deepEqual(h.past, ['restored']);
  assert.equal(h.future.length, 0);
  assert.equal(h.canUndo(), false);                      // nothing behind the floor to undo into
  assert.equal(h.canRedo(), false);

  // Ordinary edits still stack on top of the floor and undo back down to it — a rebase is a
  // new starting point, not a frozen history.
  h.push('edit');
  assert.equal(h.canUndo(), true);
  assert.equal(h.undo(), 'restored');
  assert.equal(h.canUndo(), false);

  assert.equal(h.rebase(null), false);                   // nothing to rebase onto
});

/* ── session autosave ───────────────────────────────────────────────────────────────
   The real backend is IndexedDB (localStorage cannot hold a photo document — see session.js),
   but the backend is injected, so the envelope/versioning/quota-shedding logic is testable here
   in bare node. The fabric round-trip through a live canvas is covered in editor.browser.test.mjs.

   An injected backend is the async {get,set,del} shape session.js expects. `cap` counts only
   OTHER keys plus the incoming value, matching how a store frees the key being overwritten
   before deciding whether the new value fits. */
function memStore(cap = Infinity) {
  const m = new Map();
  return {
    kind: 'mem',
    _raw: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) {
      const other = [...m].filter(([kk]) => kk !== k).reduce((sum, [, vv]) => sum + vv.length, 0);
      if (other + v.length > cap) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, v);
    },
    async del(k) { m.delete(k); },
  };
}

test('session: round-trips the scene string and the host extras', async () => {
  const storage = memStore();
  assert.equal(await writeSession('{"w":10,"h":10}', { assets: [{ src: 'a' }] }, { storage }), 'ok');
  const r = await readSession({ storage });
  assert.equal(r.scene, '{"w":10,"h":10}');
  assert.deepEqual(r.extras.assets, [{ src: 'a' }]);
});

test('session: over quota, extras are shed but the scene still saves', async () => {
  const scene = 'S'.repeat(300);
  const storage = memStore(400);
  assert.equal(await writeSession(scene, { thumbs: 'X'.repeat(500) }, { storage }), 'ok-trimmed');
  assert.equal((await readSession({ storage })).scene, scene);
  assert.deepEqual((await readSession({ storage })).extras, {});
});

test('session: a scene too big even alone reports failure and leaves no stale save behind', async () => {
  const storage = memStore(100);
  assert.equal(await writeSession('S'.repeat(500), {}, { storage }), 'failed');
  assert.equal(await readSession({ storage }), null);
});

test('session: a newer save replaces an equally large older one', async () => {
  const storage = memStore(400);
  assert.equal(await writeSession('A'.repeat(300), {}, { storage }), 'ok');
  assert.equal(await writeSession('B'.repeat(300), {}, { storage }), 'ok');
  assert.ok((await readSession({ storage })).scene.startsWith('B'));
});

test('session: a corrupt/truncated payload is dropped rather than thrown', async () => {
  const storage = memStore();
  await storage.set('canvasmith.session', '{not json');
  assert.equal(await readSession({ storage }), null);
  assert.equal(await storage.get('canvasmith.session'), null);   // cleared, so the next boot starts clean
});

test('session: a payload from a different schema version is ignored, not half-restored', async () => {
  const storage = memStore();
  await storage.set('canvasmith.session', JSON.stringify({ v: 99, scene: '{}' }));
  assert.equal(await readSession({ storage }), null);
});

test('session: a backend that throws on every write reports failure, never throws at the caller', async () => {
  const hostile = {
    kind: 'hostile',
    async get() { return null; },
    async set() { throw new Error('blocked'); },
    async del() { },
  };
  assert.equal(await writeSession('x', { a: 1 }, { storage: hostile }), 'failed');
  assert.equal(await readSession({ storage: hostile }), null);
});

test('session: New parks the old document in a trash slot so the action is recoverable', async () => {
  const storage = memStore();
  await writeSession('{"scene":"work"}', { assets: ['a'] }, { storage });
  assert.equal(await discardToTrash({ storage }), true);
  // New then clears the LIVE slot — the trashed copy must survive that.
  await clearSession({ storage });
  assert.equal(await readSession({ storage }), null);
  const trashed = await readDiscarded({ storage });
  assert.equal(trashed.scene, '{"scene":"work"}');
  assert.deepEqual(trashed.extras.assets, ['a']);
});

test('session: discarding with nothing saved is a no-op, not an error', async () => {
  const storage = memStore();
  assert.equal(await discardToTrash({ storage }), false);
  assert.equal(await readDiscarded({ storage }), null);
});

test('project: a non-project file is rejected with a message meant for the user', () => {
  assert.throws(() => parseProject('not json at all'), /isn.t valid JSON|isn.t a Canvasmith project/);
  assert.throws(() => parseProject(JSON.stringify({ hello: 1 })), /isn.t a Canvasmith project/);
  assert.throws(() => parseProject(JSON.stringify({ kind: 'something/else', scene: '{}' })), /isn.t a Canvasmith project/);
  assert.throws(() => parseProject(JSON.stringify({ kind: 'canvasmith/project', v: 99, scene: '{}' })), /newer version/);
});

test('project: a valid project round-trips its scene and extras', () => {
  const file = JSON.stringify({ kind: 'canvasmith/project', v: 1, scene: '{"w":10,"h":10}', extras: { assets: [1, 2] } });
  const p = parseProject(file);
  assert.equal(p.scene, '{"w":10,"h":10}');
  assert.deepEqual(p.extras.assets, [1, 2]);
});

/* ── voice: transcript -> command grammar ── */
import { parseVoiceCommand, normalizeLLMCommand, installVoice } from '../packages/core/src/voice.js';
test('voice grammar', () => {
  const p = parseVoiceCommand;
  assert.deepEqual(p('Undo.'), { action: 'undo' });
  assert.equal(p('use the brush tool').tool, 'brush');
  assert.equal(p('magic wand').tool, 'magicwand');
  assert.equal(p('rectangle').tool, 'rect');
  assert.equal(p('delete').action, 'delete');
  assert.equal(p('delete this layer').action, 'delete');
  assert.equal(p('make it red').color, '#e53935');
  assert.equal(p('fill with blue').name, 'blue');
  assert.equal(p('opacity 50 percent').value, 50);
  assert.equal(p('rotate 90 degrees').degrees, 90);
  assert.equal(p('rotate 30 degrees left').degrees, -30);
  assert.equal(p('brush size 40').value, 40);
  assert.equal(p('bring to front').dir, 'top');
  assert.equal(p('send backward').dir, 'down');
  assert.equal(p('flip horizontally').axis, 'x');
  assert.equal(p('add text saying hello world').text, 'hello world');
  assert.equal(p('zoom in').action, 'zoomIn');
  assert.equal(p('select all').action, 'selectAll');
  assert.equal(p('make it banana'), null);
  assert.equal(p('what is the weather'), null);
  assert.equal(p(''), null);
});

test('voice: LLM replies are validated before they can run', () => {
  const n = normalizeLLMCommand;
  assert.deepEqual(n({ action: 'undo' }), { action: 'undo' });
  assert.equal(n({ action: 'rm -rf' }), null);
  assert.equal(n({ action: 'tool', tool: 'nope' }), null);
  assert.equal(n({ action: 'tool', tool: 'brush' }).tool, 'brush');
  assert.equal(n({ action: 'opacity', value: 900 }).value, 100);
  assert.equal(n({ action: 'opacity', value: 'abc' }), null);
  assert.equal(n({ action: 'fill', color: 'red' }).color, '#e53935');   // names are fine, they map to hex
  assert.equal(n({ action: 'fill', color: 'javascript:alert(1)' }), null);
  assert.equal(n({ action: 'fill', color: '#FF0000' }).color, '#ff0000');
  assert.equal(n({ action: 'rotate', degrees: -1000 }).degrees, -360);
  assert.equal(n(null), null);
});

test('voice: unknown phrase falls back to the AI provider; known phrase never calls it', async () => {
  let transcript, calls = 0;
  const rec = { start() { transcript = (t) => this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] }); } };
  const ran = [];
  const ed = {
    tool: 'select', W: 100, H: 100, layers: () => [], undo: () => ran.push('undo'), setTool: (t) => ran.push('tool:' + t),
    setToolOptions: (o) => ran.push('size:' + o.size),
    ai: { provider: () => ({ hasKey: () => true }), can: (c) => c === 'interpretCommand',
      run: async (_c, text) => { calls++; return { status: 'ok', result: [{ action: 'tool', tool: 'brush' }, { action: 'size', value: 30 }, { action: 'evil' }] }; } },
  };
  const events = [];
  installVoice(ed, { offline: false, win: { SpeechRecognition: function () { return rec; } }, onStatus: (s) => events.push(s) }).start();
  transcript('undo');
  assert.equal(calls, 0);
  transcript('please start painting with a fat brush');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(calls, 1);
  assert.deepEqual(ran, ['undo', 'tool:brush', 'size:30']);
  assert.ok(events.some(e => e.state === 'thinking'));
  assert.match(events.at(-1).message, /brush tool, Size 30/);
});

test('voice: "select the dog" selects a named object; tool names still pick tools', async () => {
  const p = parseVoiceCommand;
  assert.deepEqual(p('select the dog'), { action: 'selectObject', target: 'dog' });
  assert.equal(p('cut out the red bag').target, 'red bag');
  assert.equal(p('select brush').tool, 'brush');
  assert.equal(p('select the lasso tool').tool, 'lasso');
  assert.equal(p('select all').action, 'selectAll');
  assert.equal(normalizeLLMCommand({ action: 'selectObject', target: '  the dog ' }).target, 'the dog');
  assert.equal(normalizeLLMCommand({ action: 'selectObject', target: '' }), null);

  let rec;
  const asked = [];
  const ed = { layers: () => [], selectObjectByName: async (t) => { asked.push(t); return { status: 'ok' }; } };
  const events = [];
  installVoice(ed, { offline: false, win: { SpeechRecognition: function () { rec = this; this.start = () => {}; } }, onStatus: (s) => events.push(s) }).start();
  rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'Select the dog' }], { isFinal: true })] });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(asked, ['dog']);
  assert.equal(events.at(-1).message, 'Selected dog');
});

test('voice: "replace the dog with a dolphin" = select by name, then AI-fill', async () => {
  const p = parseVoiceCommand;
  assert.deepEqual(p('replace the dog with a dolphin'), { action: 'replaceObject', target: 'dog', prompt: 'dolphin' });
  assert.deepEqual(p('change image with dolphin image'), { action: 'replaceObject', target: '', prompt: 'dolphin image' });
  assert.deepEqual(p('fill the selection with flowers'), { action: 'replaceObject', target: '', prompt: 'flowers' });
  assert.equal(p('turn it 90 degrees').action, 'rotate');
  assert.equal(normalizeLLMCommand({ action: 'replaceObject', target: 'dog', prompt: '' }), null);
  const calls = [];
  const ed = { layers: () => [], selection: null,
    selectObjectByName: async (t) => (calls.push('select:' + t), { status: 'ok' }),
    aiInsertAt: async (pr) => (calls.push('fill:' + pr), { status: 'ok' }) };
  const { runVoiceCommand, } = await import('../packages/core/src/voice.js');
  ed.replaceObjectByName = (await import('../packages/core/src/editor.js')).Editor.prototype.replaceObjectByName;
  assert.equal(await runVoiceCommand(ed, p('replace the dog with a dolphin')), 'Replaced dog');
  assert.deepEqual(calls, ['select:dog', 'fill:dolphin']);
  await assert.rejects(runVoiceCommand(ed, p('fill with flowers')), /Select something first/);
});

import { VOICE_COMMANDS, catalogPrompt, parseVoiceCommands, runVoiceCommand } from '../packages/core/src/index.js';
test('voice catalog: every example phrase parses to its own command', () => {
  const bad = [];
  for (const c of VOICE_COMMANDS) {
    if (c.say.length && !c.ex.length) bad.push(c.id + ' has phrases but no example');
    for (const ex of c.ex) { const p = parseVoiceCommand(ex); if (!p || p.action !== c.id) bad.push(`"${ex}" -> ${p ? p.action : null}, wanted ${c.id}`); }
  }
  assert.deepEqual(bad, []);
  assert.ok(VOICE_COMMANDS.length >= 90, 'catalog covers the editor: ' + VOICE_COMMANDS.length);
  assert.ok(catalogPrompt().includes('adjustBy{'));
});

test('voice catalog: chained phrases only split when every part is a command', () => {
  assert.deepEqual(parseVoiceCommands('undo and zoom in').map(c => c.action), ['undo', 'zoomIn']);
  assert.deepEqual(parseVoiceCommands('make it red then add a shadow').map(c => c.action), ['fill', 'shadow']);
  assert.equal(parseVoiceCommands('replace the dog with a cat and a bird').length, 1);
  assert.equal(parseVoiceCommands('undo and banana'), null);
});

test('voice catalog: arguments land where the editor expects them', async () => {
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  const obj = { type: 'i-text', angle: 10, left: 5, top: 6, strokeWidth: 0, getScaledWidth: () => 100, getScaledHeight: () => 50, id: 'L1' };
  const ed = new Proxy({
    W: 1000, H: 800, toolOpts: { size: 30 }, selection: null, crop: null,
    layers: () => [{ id: 'L1', active: true, role: 'text', name: 't' }],
    fc: { getActiveObject: () => obj, renderAll() {} },
    getImageFilters: () => ({ brightness: 100, contrast: 100 }),
  }, { get: (t, k) => (k in t ? t[k] : rec(k)) });
  const run = (phrase, actions) => runVoiceCommand(ed, parseVoiceCommand(phrase), actions);
  assert.equal(await run('increase brightness'), 'Brightness 115');
  assert.deepEqual(calls.pop(), ['setImageFilters', { brightness: 115 }]);
  await run('contrast 130'); assert.deepEqual(calls.pop(), ['setImageFilters', { contrast: 130 }]);
  await run('black and white'); assert.deepEqual(calls.pop(), ['setImageFilters', { saturate: 0 }]);
  await run('font size 64'); assert.deepEqual(calls.pop(), ['setTextProps', { fontSize: 64 }]);
  await run('bold'); assert.deepEqual(calls.pop(), ['setTextProps', { fontWeight: 'bold' }]);
  await run('text center'); assert.deepEqual(calls.pop(), ['setTextProps', { textAlign: 'center' }]);
  await run('move it left 50'); assert.deepEqual(calls.pop(), ['setNumeric', { x: -45, y: 6 }]);
  await run('scale 200 percent'); assert.deepEqual(calls.pop(), ['setNumeric', { w: 200, h: 100 }]);
  await run('canvas 16 to 9'); assert.deepEqual(calls.pop(), ['resizeCanvas', 1000, 563]);
  await run('lock'); assert.deepEqual(calls.pop(), ['setLayer', 'L1', { locked: true }]);
  await run('align left'); assert.deepEqual(calls.pop(), ['alignActiveSelection', 'left']);
  await run('add a heart'); assert.deepEqual(calls.pop(), ['addSticker', 'heart']);
  await assert.rejects(run('zoom in'), /isn't available here/);
  let exp; await run('export as jpg', { export: (f) => { exp = f; } }); assert.equal(exp, 'jpg');
});

/* Coverage audit: every public Editor method is either reachable by voice (named in the catalog) or
   listed here with the reason it is not. A new editor feature fails this test until someone maps it
   (one cmd() in voice-commands.js) or exempts it — that is what keeps "everything by voice" true. */
import { readFileSync } from 'node:fs';
test('voice coverage: every public Editor method is mapped or consciously exempt', () => {
  const editor = readFileSync(new URL('../packages/core/src/editor.js', import.meta.url), 'utf8');
  const voice = readFileSync(new URL('../packages/core/src/voice-commands.js', import.meta.url), 'utf8');
  const methods = [...new Set([...editor.matchAll(/^  (?:async )?([a-z][A-Za-z0-9]*)\(/gm)].map(m => m[1]))];
  const EXEMPT = {
    // plumbing / lifecycle
    constructor: 'ctor', destroy: 'lifecycle', refreshFonts: 'font-load plumbing', on: 'events', off: 'events', toJSON: 'serialisation', loadJSON: 'serialisation', loadDocument: 'tab-switch plumbing (DocumentSet)', nextSpot: 'placement helper', matchColor: 'needs a reference layer (panel action)', matchColorSources: 'getter', blendPreview: 'thumbnail source (panel)', fillMaskGradient: 'pointer-tool equivalent (mask gradient)', frameList: 'getter', combineInfo: 'getter', frameBounds: 'getter', renameFrame: 'panel text edit (no spoken equivalent)', exportAllFrames: 'file export (export command is single-image)', commitLive: 'slider-drag plumbing', setVoidColor: 'theme plumbing (theme command)', setAccent: 'theme plumbing (host theme)', openImageResult: 'internal AI result sink',
    // read-only getters
    featherTarget: 'getter', getImageGeometry: 'getter', getImageHistogram: 'getter', getShapeGradient: 'getter', getStroke: 'getter', getTextProps: 'getter', textSelectionFill: 'getter', isFillVisible: 'getter', isEditablePath: 'getter', cornerRadiusOf: 'getter', canRefineCutout: 'getter', backgroundGapFraction: 'getter',
    // pointer-position-driven (a click/drag on the canvas has no spoken equivalent; the named-object route is selectObject)
    wandPick: 'click', selectObjectAt: 'click (selectObject by name instead)', addToSelection: 'tool internals', subtractFromSelection: 'tool internals', selectActiveOrCenter: 'tool internals', selectDetectedBox: 'review-panel click', detectObjectBoxes: 'tool internals', openContextMenu: 'right-click', pasteAt: 'click-to-place', nudgePathNodes: 'drag/arrow keys', buildMagneticEdgeMap: 'tool internals', objectPickInImage: 'review-panel click', selectObjectsInSelection: 'used by selectObjectByName', toggleLayerSelection: 'panel shift-click (selectLayer / select all layers)', selectLayerRange: 'panel shift-click range (selectLayer / select all layers)', isolationParent: 'query (panel state)', panelPosition: 'query (panel state)',
    // aliases of mapped commands
    removeLayer: 'delete', moveLayer: 'order', alignLayer: 'align', duplicateSelection: 'duplicate', toggleSelectionVisible: 'visible', toggleSelectionLock: 'lock', reorderLayerTo: 'drag-reorder (order command)', aiInsert: 'aiInsertAt (aiGenerate)', exportJPEG: 'export via shell', exportSVG: 'export via shell', aiEnhancePrompt: 'popover helper',
    // review-panel internals (reviewCommit / reviewCancel / detectToLayers drive them)
    detectObjects: 'detect flow', detectRegions: 'detect flow', detectedBoxesToLayers: 'detect flow', commitRegions: 'review flow', cutoutRegion: 'review flow', extractRegion: 'review flow',
    // needs a file / template spec the voice user can't dictate
    fillWithImage: 'needs an image file', applyPromoLayout: 'template spec API', animateLayersIn: 'internal animation', setGradientStopColor: 'gradientTool sets stops',
  };
  const missing = methods.filter(m => !(m in EXEMPT) && !new RegExp('\\b' + m + '\\b').test(voice));
  assert.deepEqual(missing, [], 'Editor methods with no voice command and no exemption');
  const stale = Object.keys(EXEMPT).filter(m => !methods.includes(m));
  assert.deepEqual(stale, [], 'exemptions for methods that no longer exist');
});

/* Regression: "draw the circle" after an AI command used to miss the grammar ("the" wasn't
   accepted), fall through to the LLM, and come back as an AI image instead of a plain shape. */
import { parseVoiceCommands as _pvc } from '../packages/core/src/voice.js';
test('voice: "draw the <shape>" is a plain shape, never an AI action', () => {
  for (const [phrase, shape] of [['draw the circle', 'ellipse'], ['draw the ellipse', 'ellipse'], ['draw the star', 'star'], ['create the rectangle', 'rect'], ['draw the red circle', 'ellipse'], ['add the circle', 'ellipse']]) {
    const c = _pvc(phrase);
    assert.ok(c && c.length === 1, phrase);
    assert.equal(c[0].action, 'addShape', phrase);
    assert.equal(c[0].shape, shape, phrase);
  }
  assert.equal(_pvc('replace the dog with a dolphin')[0].action, 'replaceObject');   // AI path unchanged
});


/* ── offline-first voice: no AI, on-device recogniser when available, helpful misses ── */
import { suggestCommand, parseVoiceCommands as _pvcs } from '../packages/core/src/voice.js';
const fakeSR = (extra = {}) => { const o = { started: 0 }; o.SR = function () { o.rec = this; this.start = () => { o.started++; }; }; Object.assign(o.SR, extra); return o; };
const say = (o, t) => o.rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] });
const wait = (ms = 10) => new Promise(r => setTimeout(r, ms));

test('voice offline: never calls the AI provider, even with a key, and says what to try instead', async () => {
  let aiCalls = 0;
  const ed = { tool: 'select', layers: () => [], W: 100, H: 100, ai: { provider: () => ({ hasKey: () => true }), can: () => true, run: async () => { aiCalls++; return { status: 'ok', result: [] }; } } };
  const f = fakeSR(), events = [];
  installVoice(ed, { win: { SpeechRecognition: f.SR }, onStatus: (s) => events.push(s) }).start();
  say(f, 'draw a squre'); await wait();
  assert.equal(aiCalls, 0);
  assert.match(events.at(-1).message, /did you mean "draw a square"/);
  say(f, 'blorp'); await wait();
  assert.equal(aiCalls, 0);
  assert.match(events.at(-1).message, /Didn't understand "blorp"/);
});

test('voice offline: AI-only commands refuse clearly; layer-name selection and local bg removal still work', async () => {
  const ran = [], ed = { layers: () => [], fc: { discardActiveObject() {}, getObjects: () => [], getActiveObject: () => null }, removeBackground: async (o) => { ran.push('bg:' + o.method); return { status: 'ok', method: 'local' }; } };
  const f = fakeSR(), events = [];
  installVoice(ed, { win: { SpeechRecognition: f.SR }, onStatus: (s) => events.push(s) }).start();
  for (const t of ['replace the dog with a dolphin', 'generate an image of a red car', 'ai edit make it look like sunset', 'change the background to a sunny beach']) {
    say(f, t); await wait();
    assert.match(events.at(-1).message, /needs AI — not available in offline mode/, t);
  }
  say(f, 'select the dog'); await wait();
  assert.match(events.at(-1).message, /needs AI \(offline mode\)/);
});

test('voice offline: common mishearings are fixed only after the plain phrase misses', () => {
  assert.equal(_pvcs('make it read')[0].color, '#e53935');
  assert.equal(_pvcs('draw a sickle')[0].shape, 'ellipse');
  assert.equal(_pvcs('write read me')[0].text, 'read me');   // a real phrase is never rewritten
  assert.equal(suggestCommand('zoom inn').phrase, 'zoom in');
  assert.equal(suggestCommand('blorp'), null);
});

test('voice offline: asks the browser for the on-device recogniser, downloads the pack once, and says when it cannot', async () => {
  // pack must be downloaded first
  let installed = 0, st = 'downloadable';
  let f = fakeSR({ available: async () => st, install: async () => { installed++; st = 'available'; return true; } }), events = [];
  installVoice({ layers: () => [] }, { win: { SpeechRecognition: f.SR }, onStatus: (s) => events.push(s) }).start();
  await wait(20);
  assert.equal(installed, 1);
  assert.equal(f.rec.processLocally, true);
  assert.equal(events.at(-1).state, 'listening');
  assert.match(events.at(-1).message, /on-device/);
  // no on-device support: still listens, but is honest about it
  f = fakeSR({ available: async () => 'unavailable' }); events.length = 0;
  installVoice({ layers: () => [] }, { win: { SpeechRecognition: f.SR }, onStatus: (s) => events.push(s) }).start();
  await wait(20);
  assert.notEqual(f.rec.processLocally, true);
  assert.match(events.at(-1).message, /may use the network/);
  // browser without the API at all behaves as before (starts synchronously)
  f = fakeSR(); installVoice({ layers: () => [] }, { win: { SpeechRecognition: f.SR } }).start();
  assert.equal(f.started, 1);
  // stopped while the pack was still downloading: never starts
  let release; f = fakeSR({ available: () => new Promise(r => { release = r; }) });
  const v = installVoice({ layers: () => [] }, { win: { SpeechRecognition: f.SR } }); v.start(); v.stop(); release('available'); await wait(20);
  assert.equal(f.started, 0);
});

/* ── voice: fillers, spoken numbers, repeats, relative sizes, help ── */
test('voice: filler words and stacked lead-ins are ignored', () => {
  for (const t of ['um make it red', 'uh undo', 'okay now make it red', 'and then undo', "let's draw a circle", 'hey can you undo please']) assert.ok(_pvcs(t), t);
  assert.equal(_pvcs('um now make it red')[0].action, 'fill');
});
test('voice: spoken numbers are read whole ("forty five" is 45, not 40)', () => {
  assert.equal(_pvcs('rotate forty five degrees')[0].degrees, 45);
  assert.equal(_pvcs('make it two hundred wide')[0].w, 200);
  assert.equal(_pvcs('scale one fifty percent')[0].percent, 150);
  assert.equal(_pvcs('zoom to two hundred percent')[0].percent, 200);
  assert.equal(_pvcs('opacity seventy five')[0].value, 75);
  assert.equal(_pvcs('draw two circles')[0].count, 2);                      // small counts stay words
  assert.deepEqual(_pvcs('select layers one and two')[0].targets, ['1', '2']);
  assert.equal(_pvcs('add text saying twenty twenty four')[0].text, 'twenty twenty four');   // typed text untouched
  assert.equal(_pvcs('write forty five')[0].text, 'forty five');
});
test('voice: "twice" / "3 times" repeat a command; relative sizing; help', () => {
  assert.deepEqual(_pvcs('undo twice').map(c => c.action), ['undo', 'undo']);
  assert.equal(_pvcs('add a circle 3 times').length, 3);
  assert.equal(_pvcs('export at 2 times').length, 1);   // "export at 2 times" is a scale, not a repeat
  assert.equal(_pvcs('export at 2 times')[0].scale, 2);
  assert.equal(_pvcs('a bit smaller')[0].percent, 90);
  assert.equal(_pvcs('much bigger')[0].percent, 160);
  assert.equal(_pvcs('make it bigger')[0].percent, 125);
  assert.equal(_pvcs('what can I say')[0].action, 'help');
  assert.equal(_pvcs('stop listening')[0].action, 'stopListening');
});
test('voice: "again" repeats the last command; "stop listening" turns voice off; nothing-to-repeat is reported', async () => {
  const ran = []; const ed = { layers: () => [], undo: () => ran.push('undo'), W: 1, H: 1 };
  const f = fakeSR(), events = [];
  const v = installVoice(ed, { win: { SpeechRecognition: f.SR }, onStatus: (s) => events.push(s) }); v.start();
  say(f, 'again'); await wait();
  assert.match(events.at(-1).message, /Nothing to repeat/);
  say(f, 'undo'); await wait(); say(f, 'do it again'); await wait();
  assert.deepEqual(ran, ['undo', 'undo']);
  say(f, 'stop listening'); await wait();
  assert.equal(v.listening, false);
});

test('voice: run-on statement becomes an ordered queue of commands, offline', async () => {
  const { parseVoiceCommands } = await import('../packages/core/src/voice.js');
  const q = parseVoiceCommands('draw the circle height should be 200px in the left top and fill green on it');
  assert.deepEqual(q.map(c => c.action), ['addShape', 'resize', 'place', 'fill']);
  assert.equal(q[1].h, 200);
  assert.equal(q[2].position, 'top left');
  assert.equal(q[3].name, 'green');
  assert.equal(parseVoiceCommands('a cat and a dog'), null);   // a stray "and" in a free-form request never splits
});

test('voice: layer by number, ordinal or position all mean the same thing', async () => {
  const { parseVoiceCommands: p } = await import('../packages/core/src/voice.js');
  const idx = (s) => p(s)[0];
  for (const s of ['select layer 1', 'select layer one', 'select first layer', 'select the first layer', 'select the 1st layer', 'go to layer number one'])
    assert.deepEqual(idx(s), { action: 'selectLayer', index: 1 }, s);
  assert.deepEqual(idx('select the third layer from the bottom'), { action: 'selectLayer', index: 3, fromBottom: true });
  assert.deepEqual(idx('select the last layer'), { action: 'selectLayer', which: 'bottom' });
  assert.deepEqual(p('hide layer 2').map(c => c.action), ['selectLayer', 'visible']);
  assert.deepEqual(p('delete the first layer').map(c => c.action), ['selectLayer', 'delete']);
  assert.deepEqual(p('select layer two and make it red').map(c => c.action), ['selectLayer', 'fill']);
  assert.deepEqual(p('rename layer 2 to hero').map(c => c.action), ['selectLayer', 'rename']);
  assert.deepEqual(p('select layer 1 then move it to the top left').map(c => c.action), ['selectLayer', 'place']);
  assert.deepEqual(p('select layers 1 and 3')[0].action, 'selectLayers');
});

test('layer names: a long text label ends in an ellipsis instead of silently losing characters', () => {
  // Regression: labels were cut at 24 chars, so "on all orders above ₹1000" showed as "...above ₹100".
  assert.equal(layerLabel({ type: 'i-text', text: 'on all orders above ₹1000' }), 'on all orders above ₹1000');
  const long = layerLabel({ type: 'i-text', text: 'x'.repeat(80) });
  assert.equal(long.length, 60); assert.ok(long.endsWith('…'));
  assert.equal(clipLabel('two\nlines'), 'two lines');
});

test('imageLayerName: a placed file is named after the file, generic names fall back to "Image"', () => {
  assert.equal(imageLayerName('bag_ad.png'), 'bag ad');
  assert.equal(imageLayerName('/Users/me/Shampoo-Bottle.final.JPEG'), 'Shampoo Bottle.final');
  assert.equal(imageLayerName('image.png'), 'Image');
  assert.equal(imageLayerName(''), 'Image');
  assert.equal(imageLayerName(undefined), 'Image');
});

test('rankCommands: whole words and word starts beat a match inside a word; every word must match', async () => {
  const { rankCommands } = await import('../packages/core/src/cmdk.js');
  const items = [{ label: 'Rectangular marquee', group: 'Tool' }, { label: 'Rectangle', group: 'Tool' }, { label: 'Add CTA button', group: 'Insert' }, { label: 'Flip horizontal', group: 'Arrange' }, { label: 'Flip vertical', group: 'Arrange' }];
  // Regression: "cta" ranked "Rectangular marquee" (re-cta-ngular) first, so Enter picked a tool.
  assert.equal(rankCommands(items, 'cta')[0].label, 'Add CTA button');
  assert.deepEqual(rankCommands(items, 'flip h').map(i => i.label), ['Flip horizontal']);
  assert.equal(rankCommands(items, 'rect')[0].label, 'Rectangle');
  assert.equal(rankCommands(items, 'zzz').length, 0);
  assert.equal(rankCommands(items, '').length, items.length);
});

test('stickerLabel: readable names for the picker, with a fallback for unknown keys', async () => {
  const { stickerLabel } = await import('../packages/core/src/stickers.js');
  assert.equal(stickerLabel('arrowCurve'), 'Curved arrow');
  assert.equal(stickerLabel('burst12'), 'Burst, 12 points');
  assert.equal(stickerLabel('someNewShape'), 'Some New Shape');
});

/* ── multi-document tabs ─────────────────────────────────────────────────────────────
   DocumentSet only needs a small Editor surface, so a fake one (a scene string + a History)
   exercises the real park/load/persist logic in bare node. */
function fakeEditor() {
  const ed = {
    scene: 'blank', history: new History(60),
    toJSON() { return this.scene; },
    async loadDocument(scene, hist) {
      this.scene = scene;
      this.history.past = hist && hist.past.length ? hist.past.slice() : [scene];
      this.history.future = hist ? hist.future.slice() : [];
    },
    reset({ width, height }) { this.scene = `blank ${width}x${height}`; this.history.past = [this.scene]; this.history.future = []; },
    edit(s) { this.scene = s; this.history.push(s); },
  };
  ed.history.push('blank');
  return ed;
}
async function docsImport() { return (await import('../packages/core/src/docs.js')).DocumentSet; }

test('docs: each tab keeps its own scene and undo history across switches', async () => {
  const DocumentSet = await docsImport();
  const ed = fakeEditor(), set = new DocumentSet(ed, { persist: false });
  const a = set.active.id;
  ed.edit('A1'); ed.edit('A2');
  const b = await set.add({ width: 100, height: 50 });
  assert.equal(ed.scene, 'blank 100x50');
  assert.equal(set.count, 2);
  ed.edit('B1');
  await set.switchTo(a);
  assert.equal(ed.scene, 'A2');
  assert.deepEqual(ed.history.past, ['blank', 'A1', 'A2']);
  await set.switchTo(b);
  assert.equal(ed.scene, 'B1');
  assert.equal(ed.history.canUndo(), true);
  assert.equal(await set.switchTo(b), false);       // already active — no-op
});

test('docs: closing the live tab activates a neighbour; the last tab cannot be closed', async () => {
  const DocumentSet = await docsImport();
  const ed = fakeEditor(), set = new DocumentSet(ed, { persist: false });
  const a = set.active.id;
  ed.edit('A1');
  const b = await set.add();
  ed.edit('B1');
  assert.equal(await set.close(b), true);
  assert.equal(set.activeId, a);
  assert.equal(ed.scene, 'A1');
  assert.equal(await set.close(a), false);
  assert.equal(set.count, 1);
});

test('docs: overlapping operations run one at a time and stay consistent', async () => {
  const DocumentSet = await docsImport();
  const ed = fakeEditor(), set = new DocumentSet(ed, { persist: false });
  const a = set.active.id;
  ed.edit('A1');
  const p1 = set.add(), p2 = set.add();
  const [b, c] = await Promise.all([p1, p2]);
  assert.equal(set.count, 3);
  await set.switchTo(a);
  assert.equal(ed.scene, 'A1');
  assert.ok(b && c && b !== c);
});

test('docs: names count up and never reuse a closed tab’s; rename trims and ignores blanks', async () => {
  const DocumentSet = await docsImport();
  const ed = fakeEditor(), set = new DocumentSet(ed, { persist: false });
  const b = await set.add();
  await set.close(b);
  await set.add();
  assert.deepEqual(set.list().map(d => d.name), ['Untitled 1', 'Untitled 3']);
  assert.equal(set.rename(set.activeId, '  Hero  '), true);
  assert.equal(set.active.name, 'Hero');
  assert.equal(set.rename(set.activeId, '   '), false);
});

test('docs: the tab set persists, and a restore brings back parked scenes', async () => {
  const DocumentSet = await docsImport();
  const mem = new Map();
  const storage = { async get(k) { return mem.has(k) ? mem.get(k) : null; }, async set(k, v) { mem.set(k, v); }, async del(k) { mem.delete(k); } };
  const ed = fakeEditor(), set = new DocumentSet(ed, { storage });
  ed.edit('A1');
  const b = await set.add({ name: 'Second' });
  ed.edit('B1');
  await set.switchTo(set.docs[0].id);            // A live, B parked

  const ed2 = fakeEditor(); ed2.scene = 'A1';    // what restoreSession would have put on the canvas
  const set2 = new DocumentSet(ed2, { storage });
  assert.equal(await set2.restore(), 'tabs');
  assert.deepEqual(set2.list().map(d => [d.name, d.active]), [['Untitled 1', true], ['Second', false]]);
  assert.equal(ed2.scene, 'A1');                 // live doc left alone
  await set2.switchTo(b);
  assert.equal(ed2.scene, 'B1');
});

test('docs: a reload mid-switch restores the live tab from the record, not the stale session', async () => {
  const DocumentSet = await docsImport();
  const mem = new Map();
  const storage = { async get(k) { return mem.has(k) ? mem.get(k) : null; }, async set(k, v) { mem.set(k, v); }, async del(k) { mem.delete(k); } };
  const ed = fakeEditor();
  // flush hangs, i.e. the page dies after the full record was written but before the lean one.
  const set = new DocumentSet(ed, { storage, flush: () => new Promise(() => { }) });
  ed.edit('A1');
  set.add({ name: 'Second' });
  await new Promise(r => setTimeout(r, 30));
  const ed2 = fakeEditor(); ed2.scene = 'stale session scene';
  const set2 = new DocumentSet(ed2, { storage });
  assert.equal(await set2.restore(), 'loaded');
  assert.equal(set2.active.name, 'Second');
  assert.equal(ed2.scene, 'blank 960x640');      // the record's scene for the live tab wins
});

test('docs: restore with nothing saved or a corrupt record leaves the single default tab', async () => {
  const DocumentSet = await docsImport();
  const mem = new Map([['canvasmith.docs', '{nope']]);
  const storage = { async get(k) { return mem.has(k) ? mem.get(k) : null; }, async set(k, v) { mem.set(k, v); }, async del(k) { mem.delete(k); } };
  const set = new DocumentSet(fakeEditor(), { storage });
  assert.equal(await set.restore(), false);
  assert.equal(set.count, 1);
});

test('docs: at most 3 pages — add() refuses past the limit and a restore trims an over-long record', async () => {
  const DocumentSet = await docsImport();
  const ed = fakeEditor(), set = new DocumentSet(ed, { persist: false });
  assert.ok(await set.add()); assert.ok(await set.add());
  assert.equal(await set.add(), null);
  assert.equal(await set.duplicate(), null);
  assert.equal(set.count, 3);
  const id = set.docs[0].id;
  await set.close(id);
  assert.ok(await set.add());                      // room again after closing one
  const mem = new Map([['canvasmith.docs', JSON.stringify({ v: 1, savedAt: 1, scene: JSON.stringify({ activeId: 'a', docs: ['a', 'b', 'c', 'd', 'e'].map(i => ({ id: i, name: i, scene: i === 'a' ? null : '{}' })) }) })]]);
  const storage = { async get(k) { return mem.has(k) ? mem.get(k) : null; }, async set(k, v) { mem.set(k, v); }, async del(k) { mem.delete(k); } };
  const set2 = new DocumentSet(fakeEditor(), { storage });
  await set2.restore();
  assert.equal(set2.count, 3);
});


/* ── sharpen.js: unsharp mask ───────────────────────────────────────────────────────────── */
const edgeImage = () => { const w = 8, h = 3, d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, v = x < 4 ? 100 : 160; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; } return { d, w, h }; };

test('sharpen: amount 0 is a byte-exact no-op', () => {
  const { d, w, h } = edgeImage(), before = Array.from(d);
  applySharpen(d, w, h, 0);
  assert.deepEqual(Array.from(d), before);
});

test('sharpen: steepens an edge (dark side darker, light side lighter) and leaves flat areas alone', () => {
  const { d, w, h } = edgeImage(); applySharpen(d, w, h, 60);
  const at = (x) => d[(1 * w + x) * 4];
  assert.ok(at(3) < 100, 'dark pixel beside the edge got darker: ' + at(3));
  assert.ok(at(4) > 160, 'light pixel beside the edge got lighter: ' + at(4));
  assert.equal(at(1), 100, 'flat dark area untouched'); assert.equal(at(6), 160, 'flat light area untouched');
});

test('sharpen: more amount, more effect; clamps at 0..255', () => {
  const lo = edgeImage(), hi = edgeImage(); applySharpen(lo.d, lo.w, lo.h, 30); applySharpen(hi.d, hi.w, hi.h, 100);
  assert.ok(hi.d[(1 * 8 + 4) * 4] >= lo.d[(1 * 8 + 4) * 4]);
  const blk = new Uint8ClampedArray(8 * 3 * 4); for (let i = 0; i < blk.length; i += 4) { blk[i] = blk[i + 1] = blk[i + 2] = i / 4 % 8 < 4 ? 0 : 255; blk[i + 3] = 255; }
  applySharpen(blk, 8, 3, 100); assert.ok(blk.every(v => v >= 0 && v <= 255));
});

test('sharpen: never touches alpha, and transparent neighbours do not dark-halo a cut-out edge', () => {
  const w = 6, h = 3, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (x >= 3) { d[i] = 200; d[i + 1] = 120; d[i + 2] = 60; d[i + 3] = 255; } }   // opaque right half over transparent black
  const alpha = Array.from({ length: w * h }, (_, n) => d[n * 4 + 3]);
  applySharpen(d, w, h, 100);
  assert.deepEqual(Array.from({ length: w * h }, (_, n) => d[n * 4 + 3]), alpha, 'alpha identical');
  const edge = (1 * w + 3) * 4;
  assert.deepEqual([d[edge], d[edge + 1], d[edge + 2]], [200, 120, 60], 'a uniform subject keeps its colour right up to a transparent edge');
});

test('sharpen: ships as a slider, defaults to 0, and only enters the filter chain when used', () => {
  const c = ADJUST_CONTROLS.find(x => x.key === 'sharpen');
  assert.ok(c && c.group === 'Effects' && c.min === 0 && c.max === 100);
  assert.equal(FX_DEFAULTS.sharpen, 0);
  assert.ok(!fxToFilterSpecs(FX_DEFAULTS).some(s => s.type === 'Sharpen'), 'absent at 0');
  const specs = fxToFilterSpecs({ sharpen: 40 }), types = specs.map(s => s.type);
  assert.deepEqual(specs.find(s => s.type === 'Sharpen').params, { amount: 40, radius: 1 });
  assert.deepEqual(fxToFilterSpecs({ sharpen: 40, sharpenRadius: 3.5 }).find(s => s.type === 'Sharpen').params, { amount: 40, radius: 3.5 });
  assert.ok(types.indexOf('Sharpen') > types.indexOf('Saturation') && types.indexOf('Sharpen') < types.indexOf('Blur'), 'after colour work, before blur');
});

test('sharpen: radius widens the band the effect reaches either side of an edge', () => {
  const band = (radius) => { const w = 40, h = 3, d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, v = x < 20 ? 100 : 160; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    applySharpen(d, w, h, 80, radius); let reach = 0; for (let x = 0; x < 20; x++) if (d[(1 * w + x) * 4] !== 100) reach++; return reach; };   // dark-side pixels that moved
  const small = band(0.5), mid = band(1), large = band(4);
  assert.ok(small >= 1 && small <= mid && mid < large, `reach grows with radius: ${small} <= ${mid} < ${large}`);
});

test('sharpen: radius is clamped to its range and falls back to the default when missing', () => {
  const mk = () => { const w = 12, h = 5, d = new Uint8ClampedArray(w * h * 4); for (let p = 0; p < w * h; p++) { d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = (p % w) < 6 ? 90 : 170; d[p * 4 + 3] = 255; } return { d, w, h }; };
  const a = mk(), b = mk(), c = mk(), e = mk(), f = mk();
  applySharpen(a.d, a.w, a.h, 70); applySharpen(b.d, b.w, b.h, 70, 1);
  assert.deepEqual(Array.from(a.d), Array.from(b.d), 'no radius === default 1');
  applySharpen(c.d, c.w, c.h, 70, 0.01); applySharpen(e.d, e.w, e.h, 70, 0.5);
  assert.deepEqual(Array.from(c.d), Array.from(e.d), 'below the minimum clamps up');
  applySharpen(f.d, f.w, f.h, 70, 999); assert.ok(f.d.every(v => v >= 0 && v <= 255), 'huge radius is clamped and stays valid');
  assert.ok(ADJUST_CONTROLS.some(x => x.key === 'sharpenRadius' && x.min === 0.5 && x.max === 6), 'radius slider present');
  assert.equal(FX_DEFAULTS.sharpenRadius, 1);
});

test('adjust controls: every slider has a unique accessible name (label), and `short` is only a display alias', () => {
  const labels = ADJUST_CONTROLS.map(c => c.label);
  assert.equal(new Set(labels).size, labels.length, 'duplicate labels: ' + labels.filter((l, i) => labels.indexOf(l) !== i));
  ADJUST_CONTROLS.filter(c => c.short).forEach(c => assert.ok(c.short.length < c.label.length, c.key + ': short should be shorter than label'));
  assert.ok(!labels.includes('Radius'), '"Radius" alone collides with the Corner radius slider');
});

test('sharpen: the fast (box) blur matches the exact Gaussian, and the opaque fast path matches the alpha path', () => {
  const w = 96, h = 64; let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const base = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, v = ((x > 40 && x < 70 && y > 16 && y < 50) ? 170 : 90) + Math.floor(rnd() * 14) + ((x + y) % 9 < 4 ? 18 : 0); base[i] = v; base[i + 1] = v * 0.9; base[i + 2] = v * 0.8; base[i + 3] = 255; }
  for (const r of [2, 3, 4, 6]) {
    const fast = new Uint8ClampedArray(base), exact = new Uint8ClampedArray(base);
    applySharpen(fast, w, h, 80, r); applySharpen(exact, w, h, 80, r, { exact: true });
    let sum = 0, mx = 0, n = 0; for (let i = 0; i < fast.length; i++) { if (i % 4 === 3) continue; const d = Math.abs(fast[i] - exact[i]); sum += d; mx = Math.max(mx, d); n++; }
    assert.ok(sum / n < 1.2, `radius ${r}: mean error ${(sum / n).toFixed(2)} grey levels`); assert.ok(mx <= 14, `radius ${r}: worst pixel off by ${mx}`);
  }
  const opaque = new Uint8ClampedArray(base), viaAlpha = new Uint8ClampedArray(base); viaAlpha[3] = 254;   // one pixel at 254 forces the general alpha-weighted path
  applySharpen(opaque, w, h, 80, 3); applySharpen(viaAlpha, w, h, 80, 3);
  for (let i = 4; i < opaque.length; i++) if (i % 4 !== 3) assert.ok(Math.abs(opaque[i] - viaAlpha[i]) <= 1, 'the two paths agree at byte ' + i);
});


/* ── colormatch.js ───────────────────────────────────────────────────────────────────────── */
const noisy = (n, mean, spread, seed = 3) => { const d = new Uint8ClampedArray(n * 4); let q = seed; const r = () => (q = (q * 16807) % 2147483647) / 2147483647; for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) d[i * 4 + c] = mean[c] + (r() - .5) * 2 * spread[c]; d[i * 4 + 3] = 255; } return d; };

test('colormatch: matching moves the source mean and spread onto the reference', () => {
  const src = noisy(4000, [60, 90, 120], [20, 20, 20]), ref = noisy(4000, [180, 150, 100], [40, 30, 20], 9);
  const m = computeMatch(src, ref), out = new Uint8ClampedArray(src); applyMatch(out, m, 1);
  const a = colorStats(out), b = colorStats(ref);
  for (let c = 0; c < 3; c++) { assert.ok(Math.abs(a.mean[c] - b.mean[c]) < 3, 'mean ' + c + ': ' + a.mean[c] + ' vs ' + b.mean[c]); assert.ok(Math.abs(a.std[c] - b.std[c]) < 4, 'std ' + c); }
});

test('colormatch: amount 0 is a no-op, 0.5 lands halfway, gain is clamped for a flat source', () => {
  const src = noisy(500, [60, 60, 60], [10, 10, 10]), ref = noisy(500, [200, 200, 200], [10, 10, 10], 5), m = computeMatch(src, ref);
  const none = new Uint8ClampedArray(src); applyMatch(none, m, 0); assert.deepEqual(Array.from(none), Array.from(src));
  const half = new Uint8ClampedArray(src); applyMatch(half, m, 0.5); const full = new Uint8ClampedArray(src); applyMatch(full, m, 1);
  const mean = (d) => colorStats(d).mean[0]; assert.ok(mean(half) > mean(src) + 30 && mean(half) < mean(full) - 30, `${mean(src)} < ${mean(half)} < ${mean(full)}`);
  const flat = new Uint8ClampedArray(40); for (let i = 0; i < 40; i += 4) { flat[i] = flat[i + 1] = flat[i + 2] = 100; flat[i + 3] = 255; }
  assert.ok(computeMatch(flat, ref).g.every(v => v <= 2 && v >= 0.5), 'a flat source is not stretched into noise');
});

test('colormatch: transparent pixels are ignored (a cut-out is judged on its subject) and never altered', () => {
  const d = new Uint8ClampedArray(16); d.set([200, 100, 50, 255, 0, 0, 0, 0, 200, 100, 50, 255, 0, 0, 0, 0]);
  assert.deepEqual(colorStats(d).mean.map(Math.round), [200, 100, 50], 'transparent black does not drag the mean down');
  const ref = noisy(100, [100, 100, 100], [30, 30, 30]), m = computeMatch(d, ref), out = new Uint8ClampedArray(d); applyMatch(out, m, 1);
  assert.deepEqual(Array.from(out.slice(4, 8)), [0, 0, 0, 0]); assert.equal(computeMatch(new Uint8ClampedArray(8), ref), null);
});

test('Google Fonts catalog: search ranks prefix matches first, filters by category, has no duplicates', async () => {
  const { searchGoogleFonts, GOOGLE_FONT_CATALOG } = await import('../packages/core/src/fontcatalog.js');
  assert.equal(new Set(GOOGLE_FONT_CATALOG.map(f => f.name)).size, GOOGLE_FONT_CATALOG.length);
  const r = searchGoogleFonts('mont');
  assert.equal(r[0].name, 'Montserrat');
  assert.ok(searchGoogleFonts('SPACE').some(f => f.name === 'Space Grotesk'));          // case-insensitive
  assert.ok(searchGoogleFonts('', 'monospace', 100).every(f => f.category === 'monospace'));
  assert.equal(searchGoogleFonts('', 'all', 5).length, 5);
  assert.deepEqual(searchGoogleFonts('zzzzqq'), []);
});

test('icons: search batches one request per set and builds SVG locally', async () => {
  const { isIconId, iconUrl, searchIcons, fetchIconSVG } = await import('../packages/core/src/icons.js');
  assert.ok(isIconId('mdi:heart') && isIconId('material-symbols:home-outline'));
  assert.ok(!isIconId('heart') && !isIconId('mdi:../x') && !isIconId('a:b/c') && !isIconId(null));
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = /\/search\?/.test(url)
      ? { icons: ['mdi:heart', 'mdi:star', 'ri:heart-fill'] }
      : { width: 24, height: 24, icons: Object.fromEntries(new URL(url).searchParams.get('icons').split(',').map(n => [n, { body: '<path fill="currentColor" d="M0 0h1v1z"/>' }])) };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const ids = await searchIcons('heart');
    assert.deepEqual(ids, ['mdi:heart', 'mdi:star', 'ri:heart-fill']);
    assert.equal(calls.length, 3, 'one search + one JSON request per set (mdi, ri)');
    assert.ok(iconUrl('mdi:heart').startsWith('data:image/svg+xml,'));
    const svg = await fetchIconSVG('mdi:star', '#ef6a2d');
    assert.equal(calls.length, 3, 'already cached: no extra request');
    assert.ok(svg.includes('fill="#ef6a2d"') && !svg.includes('currentColor') && svg.includes('viewBox="0 0 24 24"'));
  } finally { globalThis.fetch = real; }
});
