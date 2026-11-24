/* Match Color — transfer one image's colour balance onto another (Photoshop's Image > Adjustments > Match Color).

   Reinhard-style statistics transfer, per channel, in RGB: for every channel the source's mean/spread are
   moved onto the reference's, i.e. out = (c - meanS) * (stdR / stdS) + meanR. Pixels are weighted by alpha, so a
   cut-out is measured on its subject only and transparent black never skews the numbers. The result is two
   3-vectors (gain, offset) — a per-channel linear map — which is what gets stored on the layer (fx.match) and
   applied by a Fabric filter, so it stays non-destructive and costs one multiply-add per pixel.

   Pure (no DOM/fabric) for the maths; makeColorMatchFilterClass() wraps it as a Fabric filter. */

const GAIN_MIN = 0.5, GAIN_MAX = 2;      // keep a near-flat source from being stretched into noise

/* Mean + std of R,G,B over an RGBA array, weighted by alpha. Returns null when nothing is opaque. */
export function colorStats(data) {
  let w = 0, m0 = 0, m1 = 0, m2 = 0;
  for (let i = 0; i < data.length; i += 4) { const a = data[i + 3]; if (!a) continue; w += a; m0 += data[i] * a; m1 += data[i + 1] * a; m2 += data[i + 2] * a; }
  if (!w) return null;
  const mean = [m0 / w, m1 / w, m2 / w]; let v0 = 0, v1 = 0, v2 = 0;
  for (let i = 0; i < data.length; i += 4) { const a = data[i + 3]; if (!a) continue; const d0 = data[i] - mean[0], d1 = data[i + 1] - mean[1], d2 = data[i + 2] - mean[2]; v0 += d0 * d0 * a; v1 += d1 * d1 * a; v2 += d2 * d2 * a; }
  return { mean, std: [Math.sqrt(v0 / w), Math.sqrt(v1 / w), Math.sqrt(v2 / w)] };
}

/* Per-channel { g, o } mapping the source stats onto the reference stats; null if either has no pixels. */
export function computeMatch(src, ref) {
  const a = colorStats(src), b = colorStats(ref);
  if (!a || !b) return null;
  const g = [0, 1, 2].map(c => Math.min(GAIN_MAX, Math.max(GAIN_MIN, a.std[c] > 1e-3 ? b.std[c] / a.std[c] : 1)));
  const o = [0, 1, 2].map(c => b.mean[c] - a.mean[c] * g[c]);
  return { g, o };
}

/* `data` RGBA, changed in place. amount 0..1 blends between the original and the fully matched colour. */
export function applyMatch(data, m, amount = 1) {
  if (!m || !m.g || !m.o) return data;
  const t = Math.max(0, Math.min(1, amount)); if (!t) return data;
  const [g0, g1, g2] = m.g, [o0, o1, o2] = m.o;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    data[i] = r + t * (r * g0 + o0 - r); data[i + 1] = g + t * (g * g1 + o1 - g); data[i + 2] = b + t * (b * g2 + o2 - b);
  }
  return data;
}

let _Cls = null, _for = null;
export function makeColorMatchFilterClass(fabric) {
  if (_Cls && _for === fabric) return _Cls;
  _Cls = fabric.util.createClass(fabric.Image.filters.BaseFilter, {
    type: 'ColorMatch', mainParameter: 'amount',
    g: null, o: null, amount: 1,
    applyTo2d(options) { applyMatch(options.imageData.data, this.g && { g: this.g, o: this.o }, this.amount); },
    isNeutralState() { return !this.g || !this.amount; },
    toObject() { return { type: this.type, g: this.g, o: this.o, amount: this.amount }; },
  });
  _Cls.fromObject = fabric.Image.filters.BaseFilter.fromObject;
  fabric.Image.filters.ColorMatch = _Cls; _for = fabric;
  return _Cls;
}
