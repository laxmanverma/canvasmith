/* Sharpen — an unsharp mask, as a non-destructive image adjustment (fx.sharpen, 0..100).

   out = src + k * (src - blur(src)): each pixel is pushed away from its local average, which
   steepens edges. `blur` is a Gaussian of the chosen radius, weighted by ALPHA — the neighbours of a cut-out's edge
   are transparent (usually black) pixels, and averaging them in would darken a halo into the
   subject and then "sharpen" it. Weighting by alpha means a transparent neighbour counts for
   nothing, and alpha itself is never touched, so a masked layer keeps exactly its silhouette.

   `radius` (px, 0.5..6) is the blur's sigma, i.e. how wide an edge the effect looks at.

   Pure (no fabric, no DOM) so it is testable in bare node; makeSharpenFilterClass() wraps it as a
   Fabric filter in the same shape as tone.js's Tone filter (2D path only, registered under
   fabric.Image.filters so a saved scene's `type: 'Sharpen'` revives it). */

export const SHARPEN_MAX = 100;
export const SHARPEN_RADIUS = { min: 0.5, max: 6, def: 1 };   // px; sigma of the blur the detail is measured against
const GAIN = 2.2;           // amount 100 -> k = 2.2: strong, but short of the point where flat areas crawl
const NOISE_FLOOR = 3;      // |src - blur| below this is grain, not an edge: leaving it alone keeps skies and skin clean

/* ── blur ─────────────────────────────────────────────────────────────────────────────────
   Two engines, picked by sigma (= radius):
   - small sigma: an exact separable Gaussian (a handful of taps, so it is cheap and exact);
   - larger sigma: three successive box blurs, which approximate a Gaussian to within a couple of
     grey levels (the standard "boxes for Gauss" construction). A box blur is a running sum, so its
     cost per pixel does NOT grow with the radius — 6px costs the same as 2px, where the exact
     kernel needs ~4x the taps. */
const BOX_FROM = 2;

function gaussKernel(sigma) {
  const half = Math.max(1, Math.min(18, Math.ceil(sigma * 2.5))), k = new Float32Array(half * 2 + 1);
  for (let i = -half; i <= half; i++) k[i + half] = Math.exp(-(i * i) / (2 * sigma * sigma));
  return { k, half };
}

/* Exact separable Gaussian, in place on `A` (length w*h), `tmp` is scratch of the same size. */
function gaussBlur(A, tmp, w, h, sigma) {
  const { k, half } = gaussKernel(sigma);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) { let sum = 0; const lo = x - half < 0 ? 0 : x - half, hi = x + half > w - 1 ? w - 1 : x + half; for (let xx = lo; xx <= hi; xx++) sum += A[row + xx] * k[xx - x + half]; tmp[row + x] = sum; }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { let sum = 0; const lo = y - half < 0 ? 0 : y - half, hi = y + half > h - 1 ? h - 1 : y + half; for (let yy = lo; yy <= hi; yy++) sum += tmp[yy * w + x] * k[yy - y + half]; A[y * w + x] = sum; }
  }
}

/* One box pass of half-width `half` along rows (step 1, length w, h lines) or columns (step w,
   length h, w lines): out[i] = SUM of the window (not the mean — the caller divides by the count
   when it needs a mean; the alpha-weighted path never does, numerator and denominator share it). */
function boxPass(inp, out, w, h, half, horizontal) {
  const len = horizontal ? w : h, lines = horizontal ? h : w, step = horizontal ? 1 : w, lineStep = horizontal ? w : 1;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep; let sum = 0;
    for (let i = 0; i <= half && i < len; i++) sum += inp[base + i * step];   // window of pixel 0: [0, half]
    for (let i = 0; i < len; i++) {
      out[base + i * step] = sum;
      const add = i + half + 1, sub = i - half;
      if (add < len) sum += inp[base + add * step];
      if (sub >= 0) sum -= inp[base + sub * step];
    }
  }
}

/* Box widths whose three-fold repeat has variance sigma^2 (Kutskir's construction). */
function boxHalves(sigma) {
  const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => ((i < m ? wl : wu) - 1) / 2);
}

/* Window population (the border normaliser) of one line of length `len`: the same blur applied to a
   line of ones. It is separable, so the 2-D value is cx[x] * cy[y] and the opaque path never has to
   blur a whole extra image just to learn what happens at the borders. */
function lineWeights(len, sigma, useBox, halves) {
  const A = new Float32Array(len).fill(1), tmp = new Float32Array(len);
  if (!useBox) { gaussBlur(A, tmp, len, 1, sigma); return A; }
  for (const half of halves) { boxPass(A, tmp, len, 1, half, true); A.set(tmp); }
  return A;
}

/* Blurs every array in `chs` in place. When `normalise` (the opaque path) each result is divided by
   its window population so the image border averages only what is inside it. */
function blurAll(chs, w, h, sigma, normalise, exact) {
  const n = w * h, tmp = new Float32Array(n), useBox = !exact && sigma >= BOX_FROM, halves = useBox ? boxHalves(sigma) : null;
  if (!useBox) chs.forEach(A => gaussBlur(A, tmp, w, h, sigma));
  else chs.forEach(A => { for (const half of halves) { boxPass(A, tmp, w, h, half, true); boxPass(tmp, A, w, h, half, false); } });
  if (normalise) {
    const cx = lineWeights(w, sigma, useBox, halves), cy = lineWeights(h, sigma, useBox, halves);
    chs.forEach(A => { for (let y = 0, p = 0; y < h; y++) { const wy = cy[y]; for (let x = 0; x < w; x++, p++) A[p] /= cx[x] * wy; } });
  }
}

/* Blurred R, G, B (Float32Array each, w*h). `opaque` = every alpha is 255: a plain blur, no alpha
   to weight by (3 channels instead of 4, and no premultiply). Otherwise alpha-weighted: premultiplied
   channels + alpha are blurred alike and divided, so a transparent neighbour counts for nothing. */
function alphaBlur(src, w, h, sigma, opaque, exact) {
  const n = w * h, r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  if (opaque) {
    for (let p = 0, i = 0; p < n; p++, i += 4) { r[p] = src[i]; g[p] = src[i + 1]; b[p] = src[i + 2]; }
    blurAll([r, g, b], w, h, sigma, true, exact);
    return [r, g, b];
  }
  const a = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) { const al = src[i + 3]; r[p] = src[i] * al; g[p] = src[i + 1] * al; b[p] = src[i + 2] * al; a[p] = al; }
  blurAll([r, g, b, a], w, h, sigma, false, exact);
  for (let p = 0; p < n; p++) { const wa = a[p]; if (wa > 0) { r[p] /= wa; g[p] /= wa; b[p] /= wa; } }
  return [r, g, b];
}

/* `data` is RGBA (Uint8ClampedArray, straight alpha) and is changed in place; returns it.
   `radius` (px) is how wide an edge the effect looks at: small sharpens fine texture, large lifts
   broad local contrast. `opts.exact` forces the exact-Gaussian engine (used by the tests as the
   reference the box approximation is held to). */
export function applySharpen(data, w, h, amount, radius = SHARPEN_RADIUS.def, opts = {}) {
  const k = Math.max(0, Math.min(SHARPEN_MAX, +amount || 0)) / SHARPEN_MAX * GAIN;
  if (!k || w < 3 || h < 3) return data;
  const r = Math.max(SHARPEN_RADIUS.min, Math.min(SHARPEN_RADIUS.max, +radius || SHARPEN_RADIUS.def));
  let opaque = true; for (let i = 3, L = w * h * 4; i < L; i += 4) if (data[i] !== 255) { opaque = false; break; }
  const src = new Uint8ClampedArray(data);            // measure against the original, not already-sharpened pixels
  const blur = alphaBlur(src, w, h, r, opaque, !!opts.exact);
  const [br, bg, bb] = blur;
  for (let p = 0, i = 0, n = w * h; p < n; p++, i += 4) {
    if (!opaque && !src[i + 3]) continue;
    let d = src[i] - br[p]; if (d > NOISE_FLOOR || d < -NOISE_FLOOR) data[i] = src[i] + k * d;
    d = src[i + 1] - bg[p]; if (d > NOISE_FLOOR || d < -NOISE_FLOOR) data[i + 1] = src[i + 1] + k * d;
    d = src[i + 2] - bb[p]; if (d > NOISE_FLOOR || d < -NOISE_FLOOR) data[i + 2] = src[i + 2] + k * d;
  }
  return data;
}

let _SharpenClass = null, _builtForFabric = null;
export function makeSharpenFilterClass(fabric) {
  if (_SharpenClass && _builtForFabric === fabric) return _SharpenClass;
  _SharpenClass = fabric.util.createClass(fabric.Image.filters.BaseFilter, {
    type: 'Sharpen',
    mainParameter: 'amount',
    amount: 0,
    radius: SHARPEN_RADIUS.def,        // a scene saved before the radius existed has none: it was 3x3, i.e. about this
    applyTo2d(options) { applySharpen(options.imageData.data, options.imageData.width, options.imageData.height, this.amount, this.radius); },
    isNeutralState() { return !this.amount; },
    toObject() { return { type: this.type, amount: this.amount, radius: this.radius }; },
  });
  _SharpenClass.fromObject = fabric.Image.filters.BaseFilter.fromObject;
  fabric.Image.filters.Sharpen = _SharpenClass;
  _builtForFabric = fabric;
  return _SharpenClass;
}
