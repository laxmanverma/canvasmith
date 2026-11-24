/* Combine shapes — Union / Subtract / Intersect / Exclude / Flatten (Figma's boolean ops).

   Works on the FILL GEOMETRY of vector shapes (rect, ellipse, triangle, polygon/star, pen paths):
   each one is converted to polygon rings in scene coordinates (curves sampled finely enough to
   look smooth), the operation runs on those rings, and the result becomes one new pen path.
   Strokes are not part of the geometry; the result takes the style of the bottom-most shape.

   Images, text, lines, groups, page/adjustment layers and locked layers are NOT combinable — a
   selection containing any of them disables the whole menu (see combinableReason), rather than
   silently dropping the layers that don't fit.

   Flatten needs no clipping engine (it just merges the shapes' outlines into one compound path).
   The four true boolean operations run on the vendored `polygon-clipping` bundle (see
   ../vendor/polygon-clipping/README.md — vendored because the demo loads core as native ES modules,
   so a bare npm import wouldn't resolve). It is the default engine; setClipEngine() swaps in
   another object with the same shape ({ union, difference, intersection, xor } over MultiPolygons),
   setClipEngine(null) switches the four operations off, resetClipEngine() restores the default. */

import polygonClipping from '../vendor/polygon-clipping/polygon-clipping.mjs';

export const BOOLEAN_OPS = ['union', 'subtract', 'intersect', 'exclude', 'flatten'];
export const BOOLEAN_LABEL = { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude', flatten: 'Flatten' };

const ELLIPSE_STEPS = 96;     // points around an ellipse
const CURVE_STEPS = 20;       // points per bezier segment
const CORNER_STEPS = 8;       // points per rounded-rect corner

let engine = polygonClipping;
export function setClipEngine(e) { engine = e && typeof e.union === 'function' ? e : null; }
export function resetClipEngine() { engine = polygonClipping; }
export function hasClipEngine() { return !!engine; }

/* Why a layer can't be combined (null when it can). Worded for the panel's hint line. */
export function combinableReason(o) {
  if (!o) return 'Nothing selected';
  if (o.locked) return 'Locked layers can’t be combined';
  if (o.role === 'adjustment' || o.role === 'bg') return 'Page and adjustment layers can’t be combined';
  switch (o.type) {
    case 'rect': case 'ellipse': case 'triangle': case 'polygon': case 'path': return null;
    case 'image': return 'Images can’t be combined — select vector shapes only';
    case 'i-text': case 'text': case 'textbox': return 'Text can’t be combined — select vector shapes only';
    case 'line': return 'Lines have no area to combine';
    default: return 'Groups and other layers can’t be combined';
  }
}

/* ── geometry ───────────────────────────────────────────────────────────────────────────── */

const area = (ring) => { let a = 0; for (let i = 0, n = ring.length; i < n; i++) { const p = ring[i], q = ring[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

/* Polygon rings (scene space) of one shape's fill. An object can yield several rings (a pen path
   with sub-paths). Returns [] for something with no usable outline. */
export function objectRings(fabric, o) {
  const m = o.calcTransformMatrix();
  const T = (x, y) => { const p = fabric.util.transformPoint({ x, y }, m); return [p.x, p.y]; };
  const rings = [];
  if (o.type === 'rect') {
    const w = o.width, h = o.height, hw = w / 2, hh = h / 2;
    const rx = Math.min(o.rx || 0, hw), ry = Math.min(o.ry || 0, hh);
    if (rx > 0 && ry > 0) {
      const ring = [];
      // corners in order, each swept a quarter turn
      [[hw - rx, -hh + ry, -90], [hw - rx, hh - ry, 0], [-hw + rx, hh - ry, 90], [-hw + rx, -hh + ry, 180]].forEach(([cx, cy, a0]) => {
        for (let i = 0; i <= CORNER_STEPS; i++) {
          const a = (a0 + (90 * i) / CORNER_STEPS) * Math.PI / 180;
          ring.push(T(cx + rx * Math.cos(a), cy + ry * Math.sin(a)));
        }
      });
      rings.push(ring);
    } else rings.push([T(-hw, -hh), T(hw, -hh), T(hw, hh), T(-hw, hh)]);
  } else if (o.type === 'ellipse') {
    const ring = [];
    for (let i = 0; i < ELLIPSE_STEPS; i++) { const a = (2 * Math.PI * i) / ELLIPSE_STEPS; ring.push(T(o.rx * Math.cos(a), o.ry * Math.sin(a))); }
    rings.push(ring);
  } else if (o.type === 'triangle') {
    const hw = o.width / 2, hh = o.height / 2;
    rings.push([T(0, -hh), T(hw, hh), T(-hw, hh)]);
  } else if (o.type === 'polygon') {
    const off = o.pathOffset || { x: 0, y: 0 };
    rings.push((o.points || []).map(p => T(p.x - off.x, p.y - off.y)));
  } else if (o.type === 'path') {
    const off = o.pathOffset || { x: 0, y: 0 };
    const cmds = fabric.util.makePathSimpler ? fabric.util.makePathSimpler(o.path) : o.path;
    let ring = null, cx = 0, cy = 0;
    const flush = () => { if (ring && ring.length >= 3) rings.push(ring); ring = null; };
    const P = (x, y) => T(x - off.x, y - off.y);
    for (const c of cmds) {
      const k = c[0];
      if (k === 'M') { flush(); ring = [P(c[1], c[2])]; cx = c[1]; cy = c[2]; }
      else if (k === 'L') { (ring || (ring = [P(cx, cy)])).push(P(c[1], c[2])); cx = c[1]; cy = c[2]; }
      else if (k === 'C') {
        if (!ring) ring = [P(cx, cy)];
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS, u = 1 - t;
          ring.push(P(u * u * u * cx + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5],
                      u * u * u * cy + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6]));
        }
        cx = c[5]; cy = c[6];
      } else if (k === 'Q') {
        if (!ring) ring = [P(cx, cy)];
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS, u = 1 - t;
          ring.push(P(u * u * cx + 2 * u * t * c[1] + t * t * c[3], u * u * cy + 2 * u * t * c[2] + t * t * c[4]));
        }
        cx = c[3]; cy = c[4];
      } else if (k === 'Z') flush();
    }
    flush();
  }
  return rings.filter(r => r.length >= 3 && Math.abs(area(r)) > 1e-6);
}

/* One shape as a MultiPolygon for the engine. Several rings (a path with a hole) are resolved with
   even-odd semantics via xor, which is what a compound path means. */
function toMulti(rings) {
  if (rings.length === 1) return [[rings[0]]];
  return engine.xor(...rings.map(r => [[r]]));
}

function multiToRings(mp) {
  const out = [];
  (mp || []).forEach(poly => poly.forEach(ring => {
    const r = ring.slice();
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
    if (r.length >= 3) out.push(r);
  }));
  return out;
}

/* Flatten without an engine: keep every outline, but give each SHAPE a consistent winding (its
   largest ring counter-clockwise) so overlapping shapes don't cancel each other under the
   non-zero fill rule — a flipped shape has the opposite winding and would punch a hole. Rings
   within one shape keep their relative winding, so a donut stays a donut. */
function flattenRings(perShape) {
  const out = [];
  perShape.forEach(rings => {
    const big = rings.reduce((b, r) => (Math.abs(area(r)) > Math.abs(area(b)) ? r : b), rings[0]);
    const flip = area(big) < 0;
    rings.forEach(r => out.push(flip ? r.slice().reverse() : r));
  });
  return out;
}

/* `perShape`: array (bottom -> top) of ring lists. Returns the result's rings. */
export function combineRings(op, perShape) {
  if (op === 'flatten') return flattenRings(perShape);
  if (!engine) throw new Error('Union, Subtract, Intersect and Exclude need the polygon engine, which isn’t installed.');
  const g = perShape.map(toMulti);
  let res;
  if (op === 'union') res = engine.union(...g);
  else if (op === 'subtract') res = engine.difference(g[0], ...g.slice(1));
  else if (op === 'intersect') res = engine.intersection(...g);
  else if (op === 'exclude') res = engine.xor(...g);
  else throw new Error('Unknown operation: ' + op);
  return multiToRings(res);
}

export function ringsToPathD(rings) {
  const f = (n) => +n.toFixed(3);
  return rings.map(r => 'M ' + r.map(p => f(p[0]) + ' ' + f(p[1])).join(' L ') + ' Z').join(' ');
}
