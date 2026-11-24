/* OpenCV.js Web Worker body — the engine behind the cv-backed wand, object detection, and polygon
   boolean ops. Ported mechanism-for-mechanism from a reference editor's worker.

   This function is never called directly: cvWorkerSource() stringifies it and runs it inside a
   Worker built from a Blob URL, so OpenCV's multi-MB WASM only loads the first time a host touches
   a cv-backed tool, and loading it never blocks the main thread. Keep this function self-contained
   (no closures over outer scope) — anything it needs must come from `self.OPENCV_URL` or the
   postMessage payload, because its source is captured via .toString() and run verbatim in the
   worker's global scope. */
export function cvWorkerBody() {
  var U = self.OPENCV_URL, B = U.slice(0, U.lastIndexOf('/') + 1);
  self.Module = { locateFile: function (f) { return /\.wasm$/.test(f) ? B + f : f; } };
  try { importScripts(U); } catch (e) { self.postMessage({ boot: 'error' }); return; }
  var cv, ready = false, q = [];
  function ok() { cv = self.cv; ready = true; self.postMessage({ boot: 'ready' }); var a = q; q = []; a.forEach(handle); }
  (function w() { if (self.cv && self.cv.Mat) ok(); else if (self.cv) self.cv.onRuntimeInitialized = ok; else setTimeout(w, 50); })();

  // Canny edge + contour object-box detection: finds rectangular regions that look like discrete
  // objects, merges overlapping boxes, and caps the result to the 20 largest.
  function boxes(img) {
    var W = img.width, H = img.height, src = cv.matFromImageData(img), g = new cv.Mat();
    cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(g, g, new cv.Size(3, 3), 0);
    var e = new cv.Mat(); cv.Canny(g, e, 40, 130); var k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)); cv.dilate(e, e, k);
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(e, cs, h, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    var raw = [], minA = W * H * 0.0025, maxA = W * H * 0.55;
    for (var i = 0; i < cs.size(); i++) { var ci = cs.get(i); var r = cv.boundingRect(ci); ci.delete(); var a = r.width * r.height; if (a >= minA && a <= maxA && r.width > 10 && r.height > 10) raw.push({ x: r.x, y: r.y, w: r.width, h: r.height }); }
    raw.sort(function (a, b) { return b.w * b.h - a.w * a.h; }); if (raw.length > 20) raw = raw.slice(0, 20);
    var gap = Math.round(Math.max(W, H) * 0.012), ch = true, guard = 0;
    while (ch && guard++ < 2000) { ch = false; for (var i2 = 0; i2 < raw.length && !ch; i2++) for (var j = i2 + 1; j < raw.length; j++) { var A = raw[i2], C = raw[j]; if (A.x < C.x + C.w + gap && C.x < A.x + A.w + gap && A.y < C.y + C.h + gap && C.y < A.y + A.h + gap) { var nx = Math.min(A.x, C.x), ny = Math.min(A.y, C.y); raw.splice(j, 1); raw.splice(i2, 1, { x: nx, y: ny, w: Math.max(A.x + A.w, C.x + C.w) - nx, h: Math.max(A.y + A.h, C.y + C.h) - ny }); ch = true; break; } } }
    var kept = raw.filter(function (b) { return b.w * b.h <= W * H * 0.85 && b.w > 14 && b.h > 14; }).sort(function (a, b) { return b.w * b.h - a.w * a.h; }).slice(0, 20);
    [src, g, e, k, h].forEach(function (m) { m.delete(); }); cs.delete();
    return kept;
  }

  // Text-region detector that catches LOW-CONTRAST / WHITE text (which edge detection misses):
  // boost local contrast -> morphological gradient (responds to strokes of any polarity) -> Otsu ->
  // connect characters into text lines with a wide horizontal kernel -> boxes with a text-like shape.
  function textBoxes(img) {
    var W = img.width, H = img.height, src = cv.matFromImageData(img), g = new cv.Mat();
    cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
    try { if (cv.CLAHE) { var cl = new cv.CLAHE(2.0, new cv.Size(8, 8)); cl.apply(g, g); cl.delete(); } else cv.equalizeHist(g, g); }
    catch (e0) { try { cv.equalizeHist(g, g); } catch (e1) { } }
    var k1 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    var grad = new cv.Mat(); cv.morphologyEx(g, grad, cv.MORPH_GRADIENT, k1);
    var bw = new cv.Mat(); cv.threshold(grad, bw, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    var kx = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(9, Math.round(W * 0.03)), 3));
    var con = new cv.Mat(); cv.morphologyEx(bw, con, cv.MORPH_CLOSE, kx);
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(con, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = [], minA = W * H * 0.0008;
    for (var i = 0; i < cs.size(); i++) {
      var ci = cs.get(i), r = cv.boundingRect(ci); ci.delete();
      var a = r.width * r.height, ar = r.width / Math.max(1, r.height);
      if (a >= minA && r.width > W * 0.04 && r.height > H * 0.012 && r.height < H * 0.4 && ar > 1.2 && a < W * H * 0.6)
        out.push({ x: r.x, y: r.y, w: r.width, h: r.height });
    }
    out.sort(function (a, b) { return b.w * b.h - a.w * a.h; }); if (out.length > 24) out = out.slice(0, 24);
    [src, g, grad, bw, con, k1, kx, h].forEach(function (m) { m.delete(); }); cs.delete();
    return out;
  }

  // Seeded GrabCut: a work rect plus a seed point carve the object inside that rect.
  function grab(img, seed, work) {
    var W = img.width, H = img.height, src = cv.matFromImageData(img), rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    var mask = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(cv.GC_BGD));
    cv.rectangle(mask, new cv.Point(work.x, work.y), new cv.Point(work.x + work.w, work.y + work.h), new cv.Scalar(cv.GC_PR_BGD), -1);
    var md = Math.min(work.w, work.h), rB = Math.max(8, Math.round(md * 0.32)), rS = Math.max(3, Math.round(md * 0.1));
    cv.circle(mask, new cv.Point(seed.cx, seed.cy), rB, new cv.Scalar(cv.GC_PR_FGD), -1);
    cv.circle(mask, new cv.Point(seed.cx, seed.cy), rS, new cv.Scalar(cv.GC_FGD), -1);
    var bg = new cv.Mat(), fg = new cv.Mat(); cv.grabCut(rgb, mask, new cv.Rect(0, 0, 1, 1), bg, fg, 3, cv.GC_INIT_WITH_MASK);
    var fm = cv.Mat.zeros(H, W, cv.CV_8UC1), dat = mask.data, fd = fm.data; for (var i = 0; i < dat.length; i++) { var v = dat[i]; if (v === cv.GC_FGD || v === cv.GC_PR_FGD) fd[i] = 255; }
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(fm, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var pick = -1, pa = 0; for (var i3 = 0; i3 < cs.size(); i3++) { var c = cs.get(i3), a = cv.contourArea(c), r = cv.boundingRect(c), ins = seed.cx >= r.x && seed.cx <= r.x + r.width && seed.cy >= r.y && seed.cy <= r.y + r.height; if ((ins && a > pa) || (pick < 0 && a > pa)) { pa = a; pick = i3; } c.delete(); }
    var pts = null;
    if (pick >= 0) { var cc = cs.get(pick), ap = new cv.Mat(); cv.approxPolyDP(cc, ap, 0.0025 * cv.arcLength(cc, true), true); pts = []; for (var i4 = 0; i4 < ap.rows; i4++) pts.push({ x: ap.intPtr(i4, 0)[0], y: ap.intPtr(i4, 0)[1] }); ap.delete(); cc.delete(); }
    [src, rgb, mask, bg, fg, fm, h].forEach(function (m) { m.delete(); }); cs.delete();
    return (pts && pts.length >= 3) ? pts : null;
  }

  // "Select object" inside a rough selection (Photoshop's Object Selection, rectangle/lasso mode):
  // the selection rings are GrabCut's probable foreground, everything outside them is definite
  // background, so the area around the box teaches it what "not object" looks like (here: the
  // backdrop the products sit on). Unlike grab(), every sizeable foreground blob is kept — a box
  // drawn over several products should come back with all of them.
  function objectsIn(img, polys, invert) {
    var W = img.width, H = img.height, src = cv.matFromImageData(img), rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    // The selected area as a 0/255 mask, same fill rules as selectionToPath2D: rings are a
    // nonzero union (Shift-added rings may overlap — each is filled on its own, since one fillPoly
    // call over all of them is even-odd), and an inverted selection is the whole image minus them.
    var sm = invert ? new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(255)) : cv.Mat.zeros(H, W, cv.CV_8UC1), all = new cv.MatVector();
    polys.forEach(function (pl) {
      var flat = []; pl.forEach(function (p) { flat.push(Math.round(p.x), Math.round(p.y)); });
      var m = cv.matFromArray(pl.length, 1, cv.CV_32SC2, flat);
      if (invert) all.push_back(m); else { var one = new cv.MatVector(); one.push_back(m); cv.fillPoly(sm, one, new cv.Scalar(255)); one.delete(); }
      m.delete();
    });
    if (invert) cv.fillPoly(sm, all, new cv.Scalar(0));
    all.delete();
    var selA = cv.countNonZero(sm);
    var mask = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(cv.GC_BGD));
    mask.setTo(new cv.Scalar(cv.GC_PR_FGD), sm);
    // GrabCut needs some background samples — a selection covering the whole analysed image has
    // none, so the outermost pixels always count as background.
    cv.rectangle(mask, new cv.Point(0, 0), new cv.Point(W - 1, H - 1), new cv.Scalar(cv.GC_BGD), 2);
    var bg = new cv.Mat(), fg = new cv.Mat(); cv.grabCut(rgb, mask, new cv.Rect(0, 0, 1, 1), bg, fg, 5, cv.GC_INIT_WITH_MASK);
    var fm = cv.Mat.zeros(H, W, cv.CV_8UC1), dat = mask.data, fd = fm.data; for (var i = 0; i < dat.length; i++) { var v = dat[i]; if (v === cv.GC_FGD || v === cv.GC_PR_FGD) fd[i] = 255; }
    var k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(fm, fm, cv.MORPH_OPEN, k); cv.morphologyEx(fm, fm, cv.MORPH_CLOSE, k);
    cv.bitwise_and(fm, sm, fm);   // the close can bridge past the selection's edge — never select outside it
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(fm, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = [], minA = Math.max(24, selA * 0.006);
    for (var c = 0; c < cs.size(); c++) {
      var cc = cs.get(c), a = cv.contourArea(cc);
      if (a >= minA) { var ap = new cv.Mat(); cv.approxPolyDP(cc, ap, 0.0018 * cv.arcLength(cc, true), true); var pts = []; for (var q = 0; q < ap.rows; q++) pts.push({ x: ap.intPtr(q, 0)[0], y: ap.intPtr(q, 0)[1] }); if (pts.length >= 3) out.push({ a: a, pts: pts }); ap.delete(); }
      cc.delete();
    }
    [src, rgb, sm, mask, bg, fg, fm, k, h].forEach(function (x) { x.delete(); }); cs.delete();
    out.sort(function (A, C) { return C.a - A.a; });
    return out.slice(0, 30).map(function (o) { return o.pts; });
  }

  /* ── Offline background removal ──────────────────────────────────────────────────────────
     cutout(img) → { alpha (0-255 per px), decon (RGBA edge colours or null), method, W, H }.
       1. Plain backdrop fast path: k-means the border ring in Lab; if one colour dominates, key
          it out by distance, flood-filled from the edges (only backdrop CONNECTED to the border
          goes, so a white label on a product on white stays). Soft alpha comes free from the
          distance ramp.
       2. Otherwise GrabCut on a ≤512px copy, seeded automatically: border colours (definite
          background where the ring matches them), a "stands out from the border colours" map
          with a centre prior (Otsu-thresholded → probable subject, its deep core → definite),
          and the largest detected object box over that map.
       3. That coarse mask is scaled up and GrabCut runs again at full size, but only in a thin
          band along the edge (inside = definite subject, outside = definite background) and
          cropped to the subject — sharp edges without full-resolution cost.
       4. Clean-up (specks, small holes), then a guided filter (an edge-aware blur that follows
          the photo) turns the hard edge into real partial alpha, and edge colours are
          decontaminated: C = aF + (1-a)B solved for F with B = the local backdrop colour.
     The full-size image and GrabCut labels stay here (CUT) so cutRefine(strokes) — Keep/Remove
     touch-up strokes — re-cuts just the area around a stroke instead of starting over. */
  var CUT = null;
  function cutFree() { if (CUT) { CUT.rgb.delete(); CUT.gc.delete(); CUT = null; } }
  function d2(a, b) { var x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; }
  // Lab pixels within `t` px of the border (subsampled to ~4000), each tagged with its side
  // (0 top, 1 bottom, 2 left, 3 right) as `.side`.
  function ringSamples(lab, W, H, t) {
    var d = lab.data, out = [], step = Math.max(1, Math.round((2 * (W + H) * t) / 4000));
    var k = 0;
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      if (x >= t && x < W - t && y >= t && y < H - t) continue;
      if ((k++ % step) !== 0) continue;
      var i = (y * W + x) * 3, smp = [d[i], d[i + 1], d[i + 2]];
      smp.side = y < t ? 0 : y >= H - t ? 1 : x < t ? 2 : 3;
      out.push(smp);
    }
    return out;
  }
  /* Border colour clusters that are really backdrop. A backdrop surrounds the picture; a subject
     cut off by the frame (a person's shoulders at the bottom edge) shows up on one or two sides
     only — so clusters present on ≥3 sides win whenever there are any. */
  function backdropClusters(samples, k) {
    var cls = kmeans(samples, k), tot = [0, 0, 0, 0];
    cls.forEach(function (c) { c.sides = [0, 0, 0, 0]; });
    samples.forEach(function (smp) {
      var best = 0, bd = Infinity;
      for (var c = 0; c < cls.length; c++) { var dd = d2(smp, cls[c].c); if (dd < bd) { bd = dd; best = c; } }
      cls[best].sides[smp.side]++; tot[smp.side]++;
    });
    cls.forEach(function (c) { c.nSides = c.sides.filter(function (v, s2) { return tot[s2] && v >= tot[s2] * 0.1; }).length; });
    var bgs = cls.filter(function (o) { return o.share >= 0.08; });
    var wide = bgs.filter(function (o) { return o.nSides >= 3; });
    return wide.length ? wide : bgs;
  }
  function kmeans(samples, k) {
    var n = samples.length; k = Math.max(1, Math.min(k, n));
    var C = [], i, j, c;
    for (i = 0; i < k; i++) C.push(samples[Math.floor((i + 0.5) * n / k)].slice());
    var asg = new Int32Array(n);
    for (var it = 0; it < 12; it++) {
      var S = C.map(function () { return [0, 0, 0, 0]; });
      for (j = 0; j < n; j++) {
        var s = samples[j], best = 0, bd = Infinity;
        for (c = 0; c < k; c++) { var dd = d2(s, C[c]); if (dd < bd) { bd = dd; best = c; } }
        asg[j] = best; var t = S[best]; t[0] += s[0]; t[1] += s[1]; t[2] += s[2]; t[3]++;
      }
      for (c = 0; c < k; c++) if (S[c][3]) C[c] = [S[c][0] / S[c][3], S[c][1] / S[c][3], S[c][2] / S[c][3]];
    }
    var out = C.map(function (cc) { return { c: cc, n: 0, spread: 0 }; });
    for (j = 0; j < n; j++) { var o = out[asg[j]]; o.n++; o.spread += Math.sqrt(d2(samples[j], o.c)); }
    out.forEach(function (o2) { o2.share = n ? o2.n / n : 0; o2.spread = o2.n ? o2.spread / o2.n : 0; });
    return out.sort(function (a, b) { return b.n - a.n; });
  }
  // Mean box filter of a float array (cv.boxFilter, edges replicated).
  function boxF(arr, W, H, r) {
    var m = new cv.Mat(H, W, cv.CV_32F), o = new cv.Mat();
    m.data32F.set(arr);
    cv.boxFilter(m, o, -1, new cv.Size(2 * r + 1, 2 * r + 1), new cv.Point(-1, -1), true, cv.BORDER_REPLICATE);
    var res = new Float32Array(o.data32F); m.delete(); o.delete();
    return res;
  }
  /* He et al.'s guided filter with a COLOUR guide: smooths p (the hard mask) while following the
     photo's edges. A grey guide can't see an edge between two colours of the same brightness (red
     pack on a green panel) and blurs it into a halo; the 3×3 colour covariance does see it. */
  function guided(rgbData, p, W, H, r, eps) {
    var n = W * H, i, c, k;
    var I = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (i = 0; i < n; i++) for (c = 0; c < 3; c++) I[c][i] = rgbData[i * 3 + c] / 255;
    var mI = I.map(function (x) { return boxF(x, W, H, r); }), mP = boxF(p, W, H, r);
    var mIp = I.map(function (x) { var t = new Float32Array(n); for (var j = 0; j < n; j++) t[j] = x[j] * p[j]; return boxF(t, W, H, r); });
    var pairs = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
    var mII = pairs.map(function (pr) { var A = I[pr[0]], B = I[pr[1]], t = new Float32Array(n); for (var j = 0; j < n; j++) t[j] = A[j] * B[j]; return boxF(t, W, H, r); });
    var a = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], b = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var m0 = mI[0][i], m1 = mI[1][i], m2 = mI[2][i], mp = mP[i];
      var c0 = mIp[0][i] - m0 * mp, c1 = mIp[1][i] - m1 * mp, c2 = mIp[2][i] - m2 * mp;
      var s00 = mII[0][i] - m0 * m0 + eps, s01 = mII[1][i] - m0 * m1, s02 = mII[2][i] - m0 * m2;
      var s11 = mII[3][i] - m1 * m1 + eps, s12 = mII[4][i] - m1 * m2, s22 = mII[5][i] - m2 * m2 + eps;
      // inverse of the symmetric 3×3 covariance (cofactors / determinant)
      var i00 = s11 * s22 - s12 * s12, i01 = s02 * s12 - s01 * s22, i02 = s01 * s12 - s02 * s11;
      var i11 = s00 * s22 - s02 * s02, i12 = s01 * s02 - s00 * s12, i22 = s00 * s11 - s01 * s01;
      var det = s00 * i00 + s01 * i01 + s02 * i02 || 1e-12;
      var a0 = (i00 * c0 + i01 * c1 + i02 * c2) / det, a1 = (i01 * c0 + i11 * c1 + i12 * c2) / det, a2 = (i02 * c0 + i12 * c1 + i22 * c2) / det;
      a[0][i] = a0; a[1][i] = a1; a[2][i] = a2; b[i] = mp - a0 * m0 - a1 * m1 - a2 * m2;
    }
    var ma = a.map(function (x) { return boxF(x, W, H, r); }), mb = boxF(b, W, H, r), q = new Float32Array(n);
    for (i = 0; i < n; i++) { var v = mb[i]; for (k = 0; k < 3; k++) v += ma[k][i] * I[k][i]; q[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
    return q;
  }
  // Fill each connected piece of a 0/1 mask out to its convex hull (an object's body lies between its salient bits).
  function hullFill(bin, W, H) {
    var m = new cv.Mat(H, W, cv.CV_8UC1), cs = new cv.MatVector(), hr = new cv.Mat();
    m.data.set(bin);
    cv.findContours(m, cs, hr, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(0));
    for (var i = 0; i < cs.size(); i++) {
      var c = cs.get(i), h = new cv.Mat(); cv.convexHull(c, h, false, true);
      var hv = new cv.MatVector(); hv.push_back(h); cv.fillPoly(out, hv, new cv.Scalar(1));
      hv.delete(); h.delete(); c.delete();
    }
    var res = new Uint8Array(out.data); m.delete(); cs.delete(); hr.delete(); out.delete();
    return res;
  }
  /* Studio shots sit on a smooth backdrop — often a gradient, so no single border colour matches it
     all. Flood it from the frame edge one small step at a time (neighbour-to-neighbour Lab distance),
     never crossing a sharp edge: what the flood can't reach is enclosed by an outline. That catches a
     subject whose colour is close to the backdrop (a white bottle on pale green) through its edges,
     where colour distance alone ranks it below the props around it. `lab` is OpenCV's 8-bit Lab.
     Returns null when the backdrop isn't smooth (the flood stalls early: texture, a busy scene). */
  function edgeEnclosed(lab, W, H) {
    var n = W * H, i, x, y, bar = new Uint8Array(n);
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      i = y * W + x;
      var g = 0;
      for (var k = 0; k < 3; k++) { var gx = lab[(i + 1) * 3 + k] - lab[(i - 1) * 3 + k], gy = lab[(i + W) * 3 + k] - lab[(i - W) * 3 + k]; g += gx * gx + gy * gy; }
      if (g > 100) bar[i] = 1;   // a sharp step (> 10 in 8-bit Lab over two pixels)
    }
    bar = morph(bar, W, H, 1, true);
    var reach = new Uint8Array(n), st = new Int32Array(n), sp = 0, got = 0;
    var near = function (a, b) { var p = a * 3, q = b * 3, d0 = lab[p] - lab[q], d1 = lab[p + 1] - lab[q + 1], d2 = lab[p + 2] - lab[q + 2]; return d0 * d0 + d1 * d1 + d2 * d2 < 25; };
    var seed = function (q) { if (!reach[q] && !bar[q]) { reach[q] = 1; st[sp++] = q; got++; } };
    for (x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
    for (y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
    while (sp) {
      var q = st[--sp], qx = q % W;
      if (qx > 0 && !reach[q - 1] && !bar[q - 1] && near(q, q - 1)) { reach[q - 1] = 1; st[sp++] = q - 1; got++; }
      if (qx < W - 1 && !reach[q + 1] && !bar[q + 1] && near(q, q + 1)) { reach[q + 1] = 1; st[sp++] = q + 1; got++; }
      if (q >= W && !reach[q - W] && !bar[q - W] && near(q, q - W)) { reach[q - W] = 1; st[sp++] = q - W; got++; }
      if (q < n - W && !reach[q + W] && !bar[q + W] && near(q, q + W)) { reach[q + W] = 1; st[sp++] = q + W; got++; }
    }
    if (got < n * 0.4) return null;
    var enc = new Uint8Array(n);
    for (i = 0; i < n; i++) enc[i] = reach[i] ? 0 : 1;
    return enc;
  }
  // 0/1 mask with every region the frame can't reach through 0s filled in.
  function fillHoles(bin, W, H) {
    var n = W * H, out = new Uint8Array(n), st = new Int32Array(n), sp = 0, x, y;
    var seed = function (q) { if (!bin[q] && !out[q]) { out[q] = 1; st[sp++] = q; } };
    for (x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
    for (y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
    while (sp) {
      var q = st[--sp], qx = q % W;
      if (qx > 0) seed(q - 1); if (qx < W - 1) seed(q + 1); if (q >= W) seed(q - W); if (q < n - W) seed(q + W);
    }
    for (var i = 0; i < n; i++) out[i] = out[i] ? 0 : 1;
    return out;
  }
  function morph(bin, W, H, r, dilate) {
    var m = new cv.Mat(H, W, cv.CV_8UC1), o = new cv.Mat();
    m.data.set(bin);
    var k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * r + 1, 2 * r + 1));
    if (dilate) cv.dilate(m, o, k); else cv.erode(m, o, k);
    var res = new Uint8Array(o.data); m.delete(); o.delete(); k.delete();
    return res;
  }
  /* Clean-up on a 0/1 subject mask, in place: drop specks and fill small holes (enclosed
     background < 0.3% of the subject). A component survives when it is big next to the largest
     one (≥ 4%) — or, however much smaller, when it is a real element: at least `o.minAbs` of the
     frame and, given a backdrop-distance map `o.dist`, clearly NOT backdrop-coloured on average
     (≥ `o.distMin`). Size alone can't tell a logo or a paw print on a poster (tiny next to the
     main panel) from a clump of backdrop noise; contrast can.
     `o.hints` (GrabCut labels) protects touch-up strokes: a component holding a Keep (GC_FGD)
     pixel is never dropped, and a hole holding a Remove (GC_BGD) pixel is never filled. */
  function cleanMask(fg, W, H, o) {
    o = o || {};
    var hints = o.hints, minAbs = o.minAbs != null ? o.minAbs : 0.0005, dist = o.dist, distMin = o.distMin || 0;
    var n = W * H, i;
    var m = new cv.Mat(H, W, cv.CV_8UC1), lab = new cv.Mat(), st = new cv.Mat(), ce = new cv.Mat();
    m.data.set(fg);
    var cnt = cv.connectedComponentsWithStats(m, lab, st, ce, 8, cv.CV_32S), big = 0, c;
    for (c = 1; c < cnt; c++) big = Math.max(big, st.intAt(c, cv.CC_STAT_AREA));
    var meanD = null;
    if (dist) {
      meanD = new Float64Array(cnt); var L0 = lab.data32S;
      for (i = 0; i < n; i++) if (L0[i]) meanD[L0[i]] += dist[i];
      for (c = 1; c < cnt; c++) meanD[c] /= st.intAt(c, cv.CC_STAT_AREA);
    }
    var keep = new Uint8Array(cnt), area = 0;
    for (c = 1; c < cnt; c++) {
      var a = st.intAt(c, cv.CC_STAT_AREA);
      keep[c] = (a >= big * 0.04 || (a >= n * minAbs && (!meanD || meanD[c] >= distMin))) ? 1 : 0;
    }
    var L = lab.data32S;
    /* Pieces too small on their own still belong to the element right next to them — a logo's
       tagline letters, the dots of an "i", a product's thin label text. A small piece within a
       short reach of what's kept joins it (chaining along a row of letters), provided it passes
       the same not-backdrop test; faint noise doesn't, so it still goes. */
    var reach = Math.max(3, Math.round(Math.min(W, H) * 0.02));
    var inv = new cv.Mat(H, W, cv.CV_8UC1), dtm = new cv.Mat();
    for (var pass = 0; pass < 12; pass++) {
      // distance from every pixel to the nearest kept one (one linear pass, unlike a big dilation)
      for (i = 0; i < n; i++) inv.data[i] = (L[i] && keep[L[i]]) ? 0 : 255;
      cv.distanceTransform(inv, dtm, cv.DIST_L2, 3);
      var dd = dtm.data32F, touch = new Uint8Array(cnt), grew = false;
      for (i = 0; i < n; i++) if (L[i] && !keep[L[i]] && dd[i] <= reach) touch[L[i]] = 1;
      for (c = 1; c < cnt; c++) if (touch[c] && st.intAt(c, cv.CC_STAT_AREA) >= 4 && (!meanD || meanD[c] >= distMin)) { keep[c] = 1; grew = true; }
      if (!grew) break;
    }
    inv.delete(); dtm.delete();
    for (c = 1; c < cnt; c++) if (keep[c]) area += st.intAt(c, cv.CC_STAT_AREA);
    if (hints) for (i = 0; i < n; i++) if (hints[i] === cv.GC_FGD && L[i]) keep[L[i]] = 1;
    for (i = 0; i < n; i++) fg[i] = keep[L[i]] ? 1 : 0;
    for (i = 0; i < n; i++) m.data[i] = fg[i] ? 0 : 1;   // background components → holes are the ones off the border
    cnt = cv.connectedComponentsWithStats(m, lab, st, ce, 4, cv.CV_32S);
    var fill = new Uint8Array(cnt);
    for (c = 1; c < cnt; c++) {
      var x = st.intAt(c, cv.CC_STAT_LEFT), y = st.intAt(c, cv.CC_STAT_TOP), w = st.intAt(c, cv.CC_STAT_WIDTH), h = st.intAt(c, cv.CC_STAT_HEIGHT);
      var onEdge = x === 0 || y === 0 || x + w === W || y + h === H;
      fill[c] = (!onEdge && st.intAt(c, cv.CC_STAT_AREA) < area * 0.003) ? 1 : 0;
    }
    L = lab.data32S;
    /* A hole that IS backdrop-coloured is a real opening (the counter of an R or an O) — only holes
       of some other colour (a dog's eye, a speck GrabCut missed) are filled. */
    if (o.holeDist) {
      var hs = new Float64Array(cnt), hn = new Float64Array(cnt);
      for (i = 0; i < n; i++) if (fill[L[i]]) { hs[L[i]] += o.holeDist[i]; hn[L[i]]++; }
      for (c = 1; c < cnt; c++) if (fill[c] && hs[c] / hn[c] < distMin) fill[c] = 0;
    }
    if (hints) for (i = 0; i < n; i++) if (hints[i] === cv.GC_BGD && fg[i] === 0) fill[L[i]] = 0;
    for (i = 0; i < n; i++) if (fill[L[i]]) fg[i] = 1;
    [m, lab, st, ce].forEach(function (x2) { x2.delete(); });
  }
  /* Hard 0/1 mask → soft alpha (guided filter, confined to a band along the edge so it can't
     haze the interior or the backdrop) + decontaminated edge colours. */
  function guideRadius(W, H) { return Math.max(2, Math.round(Math.max(W, H) / 220)); }
  function finishCut(fg, rgb, W, H, bgConst) {
    var n = W * H, i, p = new Float32Array(n);
    for (i = 0; i < n; i++) p[i] = fg[i];
    var r = guideRadius(W, H);
    var q = guided(rgb.data, p, W, H, r, 2e-3);
    var outer = morph(fg, W, H, r * 2, true), inner = morph(fg, W, H, r * 2, false);
    var alpha = new Float32Array(n);
    for (i = 0; i < n; i++) alpha[i] = (outer[i] && !inner[i]) ? q[i] : fg[i];
    return { alpha: alpha, decon: decontaminate(alpha, rgb, W, H, bgConst, r) };
  }
  function decontaminate(alpha, rgb, W, H, bgConst, r) {
    var n = W * H, d = rgb.data, i, k, any = false;
    var B = null;
    if (!bgConst) {
      // local backdrop colour: the mean of nearby fully-transparent pixels
      var w = new Float32Array(n), ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
      for (i = 0; i < n; i++) if (alpha[i] < 0.04) { w[i] = 1; for (k = 0; k < 3; k++) ch[k][i] = d[i * 3 + k]; }
      var R = r * 4, mw = boxF(w, W, H, R);
      B = ch.map(function (c) { return boxF(c, W, H, R); });
      B.w = mw;
    }
    var out = new Uint8ClampedArray(n * 4);
    for (i = 0; i < n; i++) {
      var a = alpha[i];
      if (a <= 0.12 || a >= 0.97) continue;   // below ~0.12, (C − (1−a)B)/a mostly amplifies noise
      var b0, b1, b2;
      if (bgConst) { b0 = bgConst[0]; b1 = bgConst[1]; b2 = bgConst[2]; }
      else { var ww = B.w[i]; if (ww < 0.02) continue; b0 = B[0][i] / ww; b1 = B[1][i] / ww; b2 = B[2][i] / ww; }
      out[i * 4] = (d[i * 3] - (1 - a) * b0) / a;
      out[i * 4 + 1] = (d[i * 3 + 1] - (1 - a) * b1) / a;
      out[i * 4 + 2] = (d[i * 3 + 2] - (1 - a) * b2) / a;
      out[i * 4 + 3] = 255; any = true;
    }
    return any ? out : null;
  }
  // A transferable copy for the main thread — the worker keeps res.alpha / res.decon (CUT) so a
  // touch-up can leave everything outside its own area exactly as it was.
  function packCut(res, W, H, method) {
    var n = W * H, al = new Uint8Array(n), sum = 0;
    for (var i = 0; i < n; i++) { al[i] = Math.round(res.alpha[i] * 255); sum += res.alpha[i]; }
    return { alpha: al, decon: res.decon ? res.decon.slice() : null, method: method, W: W, H: H, kept: sum / n };
  }
  // GrabCut on a label mask that must hold both a background and a subject label; false otherwise.
  function runGrab(img, mask, iters) {
    var d = mask.data, hasB = false, hasF = false;
    for (var i = 0; i < d.length && !(hasB && hasF); i++) { var v = d[i]; if (v === cv.GC_BGD || v === cv.GC_PR_BGD) hasB = true; else hasF = true; }
    if (!hasB || !hasF) return false;
    var bg = new cv.Mat(), fg = new cv.Mat(), lit = null;
    /* On a dark picture the differences that separate the subject from the backdrop (black glass vs
       near-black foliage) are a few levels apart, and GrabCut's colour models and edge term barely
       see them. Lifting the shadows first spreads them out; only the copy handed to GrabCut changes. */
    var id = img.data, sum = 0, cnt = 0;
    for (i = 0; i < id.length; i += 37) { sum += id[i]; cnt++; }
    if (sum / cnt < 90) {
      var lut = new Uint8Array(256); for (i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, 0.35));
      lit = img.clone(); var ld = lit.data; for (i = 0; i < ld.length; i++) ld[i] = lut[ld[i]];
    }
    try { cv.grabCut(lit || img, mask, new cv.Rect(0, 0, 1, 1), bg, fg, iters, cv.GC_INIT_WITH_MASK); }
    finally { bg.delete(); fg.delete(); if (lit) lit.delete(); }
    return true;
  }
  /* Make the kept GrabCut labels agree with a cleaned mask, so a later touch-up resumes from
     what's on screen (filled holes stay filled, dropped specks stay dropped). Hard labels
     (strokes, definite core/backdrop) are left alone. */
  function syncLabels(gc, fg, n) {
    var d = gc.data;
    for (var i = 0; i < n; i++) {
      var v = d[i];
      if (v === cv.GC_FGD || v === cv.GC_BGD) continue;
      d[i] = fg[i] ? cv.GC_PR_FGD : cv.GC_PR_BGD;
    }
  }
  function labelsToFg(gc, n) {
    var fg = new Uint8Array(n), d = gc.data;
    for (var i = 0; i < n; i++) fg[i] = (d[i] === cv.GC_FGD || d[i] === cv.GC_PR_FGD) ? 1 : 0;
    return fg;
  }

  // OpenCV can throw mid-way (e.g. out of memory on a huge image); free what was allocated so
  // repeated failures don't pile up WASM heap, and report it as "nothing found".
  function cutout(img) {
    cutFree();
    var mats = [];
    try { return cutoutRun(img, mats); }
    catch (e) { mats.forEach(function (m) { try { if (!m.isDeleted()) m.delete(); } catch (e2) { } }); CUT = null; return { empty: true, error: String((e && e.message) || e) }; }
  }
  function cutoutRun(img, mats) {
    var W = img.width, H = img.height, n = W * H, i;
    var src = cv.matFromImageData(img), rgb = new cv.Mat(); mats.push(src, rgb); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    var lab = new cv.Mat(); mats.push(lab); cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    var t = Math.max(2, Math.round(Math.min(W, H) * 0.02));
    var ring = ringSamples(lab, W, H, t), cl = kmeans(ring, 3);
    var gc = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(cv.GC_PR_BGD)); mats.push(gc);
    var res = null, method = null, bgConst = null, clean = null;   // clean: the clean-up options a touch-up reuses

    /* 0 — already cut out: a frame that is (nearly) all transparent means the background is gone
       already (a PNG icon, a sticker). Transparent pixels still carry RGB — usually black — so
       keying them as a colour would take every black outline with them; the image's own alpha IS
       the cut. */
    var A = img.data, edgeN = 0, edgeClear = 0;
    var edgePx = function (q) { edgeN++; if (A[q * 4 + 3] < 16) edgeClear++; };
    for (i = 0; i < W; i++) { edgePx(i); edgePx((H - 1) * W + i); }
    for (i = 1; i < H - 1; i++) { edgePx(i * W); edgePx(i * W + W - 1); }
    if (edgeClear >= edgeN * 0.9) {
      var alphaA = new Float32Array(n), gA = gc.data, keptA = 0;
      for (i = 0; i < n; i++) {
        var a = A[i * 4 + 3] / 255; alphaA[i] = a; keptA += a;
        gA[i] = a >= 0.5 ? cv.GC_PR_FGD : a === 0 ? cv.GC_BGD : cv.GC_PR_BGD;   // labels for touch-ups
      }
      if (keptA > 0) { res = { alpha: alphaA, decon: null }; method = 'alpha'; }
    }

    // 1 — plain backdrop
    if (!res && cl[0].share >= 0.85 && cl[0].spread <= 9) {
      var c0 = cl[0].c, L = lab.data, D = new Float32Array(n);
      for (i = 0; i < n; i++) { var j = i * 3, x0 = L[j] - c0[0], x1 = L[j + 1] - c0[1], x2 = L[j + 2] - c0[2]; D[i] = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2); }
      var HI = Math.max(16, cl[0].spread * 3.5), LO = HI * 0.45;
      var reg = new Uint8Array(n), stack = new Int32Array(n), sp = 0;
      var seed = function (q) { if (!reg[q] && D[q] < HI) { reg[q] = 1; stack[sp++] = q; } };
      for (var x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
      for (var y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
      while (sp) { var q = stack[--sp], qx = q % W; if (qx > 0) seed(q - 1); if (qx < W - 1) seed(q + 1); if (q >= W) seed(q - W); if (q < n - W) seed(q + W); }
      var fg = new Uint8Array(n);
      for (i = 0; i < n; i++) fg[i] = (!reg[i] || D[i] >= (LO + HI) / 2) ? 1 : 0;
      // small but strongly non-backdrop pieces (logo, paw prints, a badge) stay; faint noise goes
      cleanMask(fg, W, H, { minAbs: 0.0002, dist: D, distMin: HI * 1.6 });
      // The distance ramp is the anti-aliased edge — but only next to the subject that survived
      // clean-up. Applied everywhere it would give every dropped speck of backdrop noise (and the
      // halo around it) partial alpha back.
      var nearSubj = morph(fg, W, H, 2, true);
      var alpha = new Float32Array(n), kept = 0;
      for (i = 0; i < n; i++) {
        alpha[i] = !nearSubj[i] ? 0 : reg[i] ? Math.max(0, Math.min(1, (D[i] - LO) / (HI - LO))) : fg[i] ? 1 : 0;
        kept += alpha[i];
      }
      if (kept > n * 0.005 && kept < n * 0.98) {
        // backdrop colour in RGB: the mean of the border pixels close to the dominant cluster
        var rd = rgb.data, sum = [0, 0, 0], cntB = 0;
        for (i = 0; i < n; i++) if (reg[i] && D[i] < LO) { sum[0] += rd[i * 3]; sum[1] += rd[i * 3 + 1]; sum[2] += rd[i * 3 + 2]; cntB++; }
        bgConst = cntB ? [sum[0] / cntB, sum[1] / cntB, sum[2] / cntB] : null;
        res = { alpha: alpha, decon: decontaminate(alpha, rgb, W, H, bgConst, 2) };
        method = 'flat'; clean = { minAbs: 0.0002, dist: D, distMin: HI * 1.6 };
        var g = gc.data;   // labels for later touch-up strokes
        for (i = 0; i < n; i++) g[i] = alpha[i] >= 0.5 ? cv.GC_PR_FGD : (reg[i] && D[i] < LO ? cv.GC_BGD : cv.GC_PR_BGD);
      }
    }

    // 2/3 — seeded GrabCut, coarse then edge band
    if (!res) {
      var s = Math.min(1, 512 / Math.max(W, H)), cw = Math.max(8, Math.round(W * s)), ch = Math.max(8, Math.round(H * s)), cn = cw * ch;
      var rgbC = new cv.Mat(), labC = new cv.Mat(), rgbaC = new cv.Mat(); mats.push(rgbC, labC, rgbaC);
      cv.resize(rgb, rgbC, new cv.Size(cw, ch), 0, 0, cv.INTER_AREA);
      cv.resize(src, rgbaC, new cv.Size(cw, ch), 0, 0, cv.INTER_AREA);
      cv.cvtColor(rgbC, labC, cv.COLOR_RGB2Lab);
      var bgs = backdropClusters(ringSamples(labC, cw, ch, Math.max(2, Math.round(Math.min(cw, ch) * 0.03))), 4);
      var LC = labC.data, sal = new Float32Array(cn), mx = 0, nearBg = new Float32Array(cn);
      for (i = 0; i < cn; i++) {
        var px = [LC[i * 3], LC[i * 3 + 1], LC[i * 3 + 2]], md = Infinity;
        for (var b = 0; b < bgs.length; b++) md = Math.min(md, Math.sqrt(d2(px, bgs[b].c)));
        nearBg[i] = md;
        sal[i] = md;
        if (md > mx) mx = md;
      }
      var s8 = new cv.Mat(ch, cw, cv.CV_8UC1), sb = new cv.Mat(); mats.push(s8, sb);
      for (i = 0; i < cn; i++) s8.data[i] = mx ? Math.round(sal[i] / mx * 255) : 0;
      cv.threshold(s8, sb, 0, 1, cv.THRESH_BINARY | cv.THRESH_OTSU);
      var salBin = new Uint8Array(sb.data);
      cleanMask(salBin, cw, ch, { minAbs: 0.0002, dist: nearBg, distMin: 30 });   // small but clearly-not-backdrop pieces (logo, tagline) stay
      /* A dark product on a dark backdrop barely differs in colour, so only its bright bits (cap,
         logo, label text) stand out and the body between them would be seeded as backdrop. Close the
         gaps between nearby salient pieces and take each group's convex hull: what they enclose is
         probably the same object. Only a PROBABLE-subject seed — the definite core still comes from
         salBin, since forcing the hull drags the backdrop between the groups in. */
      var cr = Math.max(2, Math.round(Math.min(cw, ch) * 0.06));
      var salSeed = hullFill(morph(morph(salBin, cw, ch, cr, true), cw, ch, cr, false), cw, ch);
      /* A pale body between a gold collar and a stand has too little colour contrast to be salient —
         but its outline closes it off from the backdrop. Add the outlines the edge-aware flood found,
         close small gaps (a splash crossing the edge) and fill what they enclose. Filled, not hulled:
         a horizon line running frame to frame encloses nothing, where a hull would span the frame. */
      var enc = edgeEnclosed(LC, cw, ch);
      if (enc) {
        for (i = 0; i < cn; i++) enc[i] |= salBin[i];
        var encFill = fillHoles(morph(morph(enc, cw, ch, cr, true), cw, ch, cr, false), cw, ch);
        // ...except backdrop showing through inside an enclosure (the ring of a splash): exactly the
        // border colour, where even a pale subject differs a little.
        for (i = 0; i < cn; i++) if (encFill[i] && nearBg[i] >= 11) salSeed[i] = 1;
      }
      // the detector's largest box around the salient mass also counts as probable subject
      var sx = 0, sy = 0, sn = 0;
      for (i = 0; i < cn; i++) if (salBin[i]) { sx += i % cw; sy += Math.floor(i / cw); sn++; }
      var box = null;
      if (sn) {
        var mcx = sx / sn, mcy = sy / sn;
        boxes({ data: rgbaC.data, width: cw, height: ch }).forEach(function (bx) {
          if (mcx >= bx.x && mcx <= bx.x + bx.w && mcy >= bx.y && mcy <= bx.y + bx.h && (!box || bx.w * bx.h > box.w * box.h) && bx.w * bx.h < cn * 0.9) box = bx;
        });
      }
      var gcC = new cv.Mat(ch, cw, cv.CV_8UC1, new cv.Scalar(cv.GC_PR_BGD)), G = gcC.data;
      var dt = new cv.Mat(), sbm = new cv.Mat(ch, cw, cv.CV_8UC1); mats.push(gcC, dt, sbm); sbm.data.set(salBin);
      cv.distanceTransform(sbm, dt, cv.DIST_L2, 3);
      var dmax = 0; for (i = 0; i < cn; i++) dmax = Math.max(dmax, dt.data32F[i]);
      var anyF = false;
      for (i = 0; i < cn; i++) {
        var X = i % cw, Y = Math.floor(i / cw);
        var inBox = box && X >= box.x && X <= box.x + box.w && Y >= box.y && Y <= box.y + box.h;
        if (salSeed[i] || salBin[i] || inBox) { G[i] = cv.GC_PR_FGD; anyF = true; }
        if (dmax >= 3 && dt.data32F[i] >= dmax * 0.45) G[i] = cv.GC_FGD;
        var edge = X < 2 || Y < 2 || X >= cw - 2 || Y >= ch - 2;
        if (edge && nearBg[i] < 14) G[i] = cv.GC_BGD;   // only where the ring IS backdrop — a subject cut by the frame survives
      }
      if (!anyF) {   // nothing stood out: assume a centred subject
        for (i = 0; i < cn; i++) { var X2 = i % cw, Y2 = Math.floor(i / cw); if (X2 > cw * 0.15 && X2 < cw * 0.85 && Y2 > ch * 0.1 && Y2 < ch * 0.9) G[i] = cv.GC_PR_FGD; }
      }
      var okC = runGrab(rgbC, gcC, 4);
      var fgC = okC ? labelsToFg(gcC, cn) : null;
      [rgbC, labC, rgbaC, s8, sb, dt, sbm, gcC].forEach(function (m) { m.delete(); });
      if (fgC) {
        // scale up, then re-cut only a band along the edge at full size
        var fm = new cv.Mat(ch, cw, cv.CV_8UC1), up = new cv.Mat();
        for (i = 0; i < cn; i++) fm.data[i] = fgC[i] * 255;
        cv.resize(fm, up, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
        var fgU = new Uint8Array(n); for (i = 0; i < n; i++) fgU[i] = up.data[i] > 127 ? 1 : 0;
        fm.delete(); up.delete();
        var bw = Math.max(3, Math.round(Math.max(W, H) / 120));
        var dil = morph(fgU, W, H, bw, true), ero = morph(fgU, W, H, bw, false);
        var g2 = gc.data, x0b = W, y0b = H, x1b = -1, y1b = -1;
        for (i = 0; i < n; i++) {
          g2[i] = ero[i] ? cv.GC_FGD : !dil[i] ? cv.GC_BGD : fgU[i] ? cv.GC_PR_FGD : cv.GC_PR_BGD;
          if (dil[i]) { var xx = i % W, yy = (i / W) | 0; if (xx < x0b) x0b = xx; if (xx > x1b) x1b = xx; if (yy < y0b) y0b = yy; if (yy > y1b) y1b = yy; }
        }
        if (x1b >= 0) {
          var rx = Math.max(0, x0b - bw), ry = Math.max(0, y0b - bw), rect = new cv.Rect(rx, ry, Math.min(W, x1b + bw + 1) - rx, Math.min(H, y1b + bw + 1) - ry);
          var ri = rgb.roi(rect), rm = gc.roi(rect), ic = ri.clone(), mc = rm.clone();
          if (runGrab(ic, mc, 2)) mc.copyTo(rm);
          [ri, rm, ic, mc].forEach(function (m) { m.delete(); });
          var fgF = labelsToFg(gc, n);
          /* As on the plain path, a small piece (logo, tagline) stays when it clearly isn't backdrop
             colour, however small next to the biggest object. */
          var LF = lab.data, DF = new Float32Array(n);
          for (i = 0; i < n; i++) {
            var pd = [LF[i * 3], LF[i * 3 + 1], LF[i * 3 + 2]], mdF = Infinity;
            for (var bb = 0; bb < bgs.length; bb++) mdF = Math.min(mdF, d2(pd, bgs[bb].c));
            DF[i] = Math.sqrt(mdF);
          }
          cleanMask(fgF, W, H, { minAbs: 0.0002, dist: DF, distMin: 30, holeDist: DF });
          syncLabels(gc, fgF, n);
          var tot = 0; for (i = 0; i < n; i++) tot += fgF[i];
          if (tot > n * 0.005 && tot < n * 0.98) { res = finishCut(fgF, rgb, W, H, null); method = 'grabcut'; clean = { minAbs: 0.0002, dist: DF, distMin: 30 }; }
        }
      }
    }
    src.delete(); lab.delete();
    if (!res) { rgb.delete(); gc.delete(); return { empty: true }; }
    CUT = { rgb: rgb, gc: gc, W: W, H: H, bgConst: bgConst, method: method, alpha: res.alpha, decon: res.decon, clean: clean };
    return packCut(res, W, H, method);
  }

  /* After an undo/redo the layer's mask is whatever that history state held — the labels must
     follow it, or a touch-up stroke that was undone would keep steering every later re-cut.
     `alpha` (0-255, cutout px) becomes probable subject / backdrop; hard hints are dropped. */
  function cutSync(alpha) {
    if (!CUT || !alpha || alpha.length !== CUT.W * CUT.H) return false;
    var d = CUT.gc.data, n = CUT.W * CUT.H, a = new Float32Array(n);
    for (var i = 0; i < n; i++) { a[i] = alpha[i] / 255; d[i] = alpha[i] >= 128 ? cv.GC_PR_FGD : cv.GC_PR_BGD; }
    CUT.alpha = a; CUT.decon = null;   // no edge colours kept for the restored state; a re-cut makes its own
    return true;
  }

  /* Keep/Remove touch-up: strokes [{ keep, r, pts:[{x,y}] }] in cutout px become definite
     subject / background labels, and GrabCut re-runs on just the area around them. */
  function cutRefine(strokes) {
    if (!CUT || !strokes || !strokes.length) return null;
    try { return cutRefineRun(strokes); } catch (e) { return null; }   // labels may be half-updated; the next stroke re-runs anyway
  }
  function cutRefineRun(strokes) {
    var W = CUT.W, H = CUT.H, n = W * H, gc = CUT.gc, i;
    var x0 = W, y0 = H, x1 = -1, y1 = -1, rmax = 1;
    strokes.forEach(function (s) {
      var val = new cv.Scalar(s.keep ? cv.GC_FGD : cv.GC_BGD), r = Math.max(1, Math.round(s.r)), pts = s.pts || [];
      rmax = Math.max(rmax, r);
      pts.forEach(function (p, k) {
        var P = new cv.Point(Math.round(p.x), Math.round(p.y));
        if (k) cv.line(gc, new cv.Point(Math.round(pts[k - 1].x), Math.round(pts[k - 1].y)), P, val, 2 * r, cv.LINE_8);
        else cv.circle(gc, P, r, val, -1);
        x0 = Math.min(x0, p.x - r); y0 = Math.min(y0, p.y - r); x1 = Math.max(x1, p.x + r); y1 = Math.max(y1, p.y + r);
      });
    });
    if (x1 < 0) return null;
    var pad = Math.max(24, Math.round(Math.max(W, H) * 0.12), rmax * 3);
    var rx = Math.max(0, Math.floor(x0 - pad)), ry = Math.max(0, Math.floor(y0 - pad));
    var rect = new cv.Rect(rx, ry, Math.min(W, Math.ceil(x1 + pad)) - rx, Math.min(H, Math.ceil(y1 + pad)) - ry);
    if (rect.width > 2 && rect.height > 2) {
      var ri = CUT.rgb.roi(rect), rm = gc.roi(rect), ic = ri.clone(), mc = rm.clone();
      if (runGrab(ic, mc, 2)) mc.copyTo(rm);
      [ri, rm, ic, mc].forEach(function (m) { m.delete(); });
    }
    var fg = labelsToFg(gc, n);
    /* Same clean-up as the first cut, minus anything a stroke asked for. Its small-but-distinct
       rule matters here: a Keep that grows the main subject would otherwise shrink every separate
       piece (a flying almond) below the size cut-off and drop it. */
    var co = { hints: gc.data }; if (CUT.clean) for (var ck in CUT.clean) co[ck] = CUT.clean[ck];
    cleanMask(fg, W, H, co);
    syncLabels(gc, fg, n);
    var res = finishCut(fg, CUT.rgb, W, H, CUT.bgConst);
    /* Only the stroke's own area changes: outside the re-cut rect (plus the edge filter's reach)
       the previous alpha and edge colours are put back, so a touch-up never re-styles edges
       elsewhere (e.g. a plain-backdrop cut's precise keyed edges). Clean-up that dropped or filled
       a whole component far away still shows, via the labels — those pixels are taken as-is. */
    var m2 = guideRadius(W, H) * 3 + 2, X0 = rect.x - m2, Y0 = rect.y - m2, X1 = rect.x + rect.width + m2, Y1 = rect.y + rect.height + m2;
    var prevA = CUT.alpha, prevD = CUT.decon, nd = res.decon || (prevD ? new Uint8ClampedArray(n * 4) : null);
    for (i = 0; i < n; i++) {
      var x = i % W, y = (i / W) | 0;
      if (x >= X0 && x < X1 && y >= Y0 && y < Y1) continue;
      if ((prevA[i] >= 0.5) !== (fg[i] === 1)) continue;   // clean-up changed this pixel's side
      res.alpha[i] = prevA[i];
      if (nd) for (var k2 = 0; k2 < 4; k2++) nd[i * 4 + k2] = prevD ? prevD[i * 4 + k2] : 0;
    }
    res.decon = nd;
    CUT.alpha = res.alpha; CUT.decon = res.decon;
    return packCut(res, W, H, CUT.method);
  }

  /* Reduces a binary mask in-place to the single 4/8-connected blob containing `seed`. Used to
     stop a wand pick from spanning several same-coloured elements (see the call site). */
  function keepSeedComponent(mask, seed) {
    var labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    var n = cv.connectedComponentsWithStats(mask, labels, stats, cents, 8, cv.CV_32S);
    if (n > 2) {                                    // 0 is background; >1 real blob means a choice
      var sx = Math.max(0, Math.min(mask.cols - 1, seed.cx | 0));
      var sy = Math.max(0, Math.min(mask.rows - 1, seed.cy | 0));
      var lbl = labels.intPtr(sy, sx)[0];
      // The seed can land on a hole left by MORPH_CLOSE; only filter when it is on a real blob.
      if (lbl > 0) {
        var md = mask.data, ld = labels.data32S;
        for (var i = 0; i < ld.length; i++) if (ld[i] !== lbl) md[i] = 0;
      }
    }
    labels.delete(); stats.delete(); cents.delete();
  }

  /* Small in-focus parts that belong to the object `region` (mask, 255 = yes) but were cut off it — a spray
     cap, a lid, a handle — as a mask to OR in, or null. See the call site in wand().
     Product photos are mostly a sharp subject on a soft backdrop, so "in focus" (local gradient energy,
     outlines filled) finds such parts even when their colour (black) is the backdrop's. A candidate must be
     SMALL next to the object, sit within a short reach of it, and stand right above (or below) a stretch of
     the object at least as wide as itself — that is what separates a cap on a bottle from a letter or a leaf
     that merely happens to be nearby. The smooth neck between them is bridged. */
  function focusExtension(rgb, region, W, H) {
    var regionArea = cv.countNonZero(region), M = Math.max(W, H);
    var gray = new cv.Mat(), gx = new cv.Mat(), gy = new cv.Mat(), mag = new cv.Mat(), m8 = new cv.Mat(), fm = new cv.Mat();
    var k = null, labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat(), out = null, zone = null;
    try {
      cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
      cv.Sobel(gray, gx, cv.CV_32F, 1, 0, 3); cv.Sobel(gray, gy, cv.CV_32F, 0, 1, 3);
      cv.magnitude(gx, gy, mag);
      var bs = Math.max(5, (Math.round(M / 90) | 1));
      cv.blur(mag, mag, new cv.Size(bs, bs));                       // local sharpness energy
      cv.convertScaleAbs(mag, m8, 255 / 400);
      var ot = cv.threshold(m8, fm, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      cv.threshold(m8, fm, Math.max(6, ot * 0.5), 255, cv.THRESH_BINARY);
      var cov = cv.countNonZero(fm) / (W * H);
      if (cov > 0.4 || cov < 0.01) return null;                      // everything sharp (or nothing): no usable focus cue
      k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(bs * 2 + 1, bs * 2 + 1));
      cv.morphologyEx(fm, fm, cv.MORPH_CLOSE, k);
      var cvs = new cv.MatVector(), hh = new cv.Mat();
      cv.findContours(fm, cvs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (var ci = 0; ci < cvs.size(); ci++) cv.drawContours(fm, cvs, ci, new cv.Scalar(255), -1);   // fill enclosed outlines
      cvs.delete(); hh.delete();
      var n = cv.connectedComponentsWithStats(fm, labels, stats, cents, 8, cv.CV_32S);
      var ld = labels.data32S, rd = region.data, reach = Math.round(M * 0.08);
      out = cv.Mat.zeros(H, W, cv.CV_8UC1); var od = out.data, added = 0;
      zone = cv.Mat.zeros(H, W, cv.CV_8UC1); var zd = zone.data;
      // does the object occupy columns [x0,x1) anywhere in rows [y0,y1)? -> share of those columns
      var share = function (x0, x1, y0, y1) {
        y0 = Math.max(0, y0); y1 = Math.min(H, y1); x0 = Math.max(0, x0); x1 = Math.min(W, x1);
        if (y1 <= y0 || x1 <= x0) return { f: 0, y: -1 };
        var hit = 0, first = -1;
        for (var x = x0; x < x1; x++) for (var y = y0; y < y1; y++) if (rd[y * W + x]) { hit++; if (first < 0 || y < first) first = y; break; }
        return { f: hit / (x1 - x0), y: first };
      };
      for (var li = 1; li < n; li++) {
        var bx = stats.intPtr(li, cv.CC_STAT_LEFT)[0], by = stats.intPtr(li, cv.CC_STAT_TOP)[0], bw = stats.intPtr(li, cv.CC_STAT_WIDTH)[0], bh = stats.intPtr(li, cv.CC_STAT_HEIGHT)[0], ba = stats.intPtr(li, cv.CC_STAT_AREA)[0];
        if (ba > regionArea * 0.12 || ba < 12) continue;
        var below = share(bx, bx + bw, by + bh, by + bh + reach), above = share(bx, bx + bw, by - reach, by);
        var side = below.f >= 0.6 ? below : above.f >= 0.6 ? above : null;
        if (!side) continue;
        for (var yy2 = by; yy2 < by + bh; yy2++) for (var xx2 = bx; xx2 < bx + bw; xx2++) if (ld[yy2 * W + xx2] === li) { od[yy2 * W + xx2] = 255; added++; }
        /* The collar / neck between the part and the object has no edges of its own, and is a little wider than
           the cap above it. Mark a generous zone around it as UNDECIDED (128 = its centre, 255 = the rest); the
           caller lets a local grabCut sort the black collar from the green backdrop inside that zone. */
        var nx0 = Math.max(0, bx - Math.round(bw * 0.4)), nx1 = Math.min(W, bx + Math.round(bw * 1.4));
        var ya = side === below ? by + bh : side.y, yb = side === below ? side.y : by;
        for (var yy3 = Math.max(0, ya - 2); yy3 < Math.min(H, yb + 2); yy3++) for (var xx3 = nx0; xx3 < nx1; xx3++) {
          var core3 = xx3 >= bx + Math.round(bw * 0.3) && xx3 < bx + Math.round(bw * 0.7);
          zd[yy3 * W + xx3] = core3 ? 128 : (zd[yy3 * W + xx3] === 128 ? 128 : 255); added++;
        }
      }
      if (!added) { out.delete(); out = null; zone.delete(); zone = null; }
    } catch (e) { if (out) { out.delete(); } if (zone) { zone.delete(); } out = null; zone = null; }
    [gray, gx, gy, mag, m8, fm, labels, stats, cents].forEach(function (m) { m.delete(); });
    if (k) k.delete();
    return out ? { parts: out, zone: zone } : null;
  }

  // Hybrid color->object magic wand: flood-fill the same-colour pixels at the click (within `tol`),
  // then let grabCut grow that seed into the complete object (shadows/edges included). Returns its
  // contour as a polygon, traced at `eps` fidelity (smaller = hugs the edge more tightly).
  function wand(img, seed, tol, eps) {
    var EPS = (typeof eps === 'number' && eps > 0) ? eps : 0.0022;
    var W = img.width, H = img.height, src = cv.matFromImageData(img), rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    var ff = cv.Mat.zeros(H + 2, W + 2, cv.CV_8UC1);
    var d = new cv.Scalar(tol, tol, tol, tol);
    var flags = 8 | (255 << 8) | cv.FLOODFILL_MASK_ONLY | cv.FLOODFILL_FIXED_RANGE;
    cv.floodFill(rgb, ff, new cv.Point(seed.cx, seed.cy), new cv.Scalar(0, 0, 0), new cv.Rect(), d, d, flags);
    var roi = ff.roi(new cv.Rect(1, 1, W, H)), region = new cv.Mat(); roi.copyTo(region); roi.delete();
    var k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(region, region, cv.MORPH_CLOSE, k);
    /* Keep ONLY the blob the user actually clicked. floodFill itself is connected, but the
       MORPH_CLOSE above dilates then erodes, which can bridge a clicked element to a nearby
       same-coloured one; and in a design/ad layout the same brand colour is deliberately reused
       (a small "now at" pill and a large product card, say). Everything downstream — grabCut's
       foreground seeding and the contour pick — then sees several disconnected blobs and can
       return one the user never clicked. Restricting to the seed's own component here means the
       wand can only ever grow the thing under the cursor. */
    keepSeedComponent(region, seed);
    var area = cv.countNonZero(region);
    var pts = null;
    if (area > 0) {
      var fm;
      /* A flood that swallowed nearly the whole frame is ambiguous: it is either a deliberate
         click on a flat background, or — far more often — a LEAK, where a low-contrast subject
         and its surroundings fall inside `tol` and the fill escapes into the background. Trusting
         the mask in the leak case returns the entire canvas as "the selection", which is never
         what a user clicking on an object wanted (measured: a 600px subject on a 1200px canvas
         selected all 1200px once tolerance passed 24).
         Distinguishing the two from the mask alone is not possible, so re-run the fill with a
         progressively TIGHTER tolerance and keep the first result that stops short of the frame.
         If every attempt still floods, the click really was on a flat background and the mask is
         taken as-is. */
      if (area > W * H * 0.9) {
        var tight = null;
        for (var ti = 0; ti < 3 && !tight; ti++) {
          var t2 = Math.max(4, Math.round(tol / (2 << ti)));
          var ff2 = cv.Mat.zeros(H + 2, W + 2, cv.CV_8UC1);
          var d2 = new cv.Scalar(t2, t2, t2, t2);
          cv.floodFill(rgb, ff2, new cv.Point(seed.cx, seed.cy), new cv.Scalar(0, 0, 0), new cv.Rect(), d2, d2, flags);
          var roi2 = ff2.roi(new cv.Rect(1, 1, W, H)), r2 = new cv.Mat(); roi2.copyTo(r2); roi2.delete();
          cv.morphologyEx(r2, r2, cv.MORPH_CLOSE, k);
          var a2 = cv.countNonZero(r2);
          if (a2 > W * H * 0.0008 && a2 <= W * H * 0.9) { tight = r2; } else { r2.delete(); }
          ff2.delete();
        }
        if (tight) { region.delete(); region = tight; area = cv.countNonZero(region); }
      }
      if (area > W * H * 0.9 || area < W * H * 0.0008) {
        fm = region.clone();   // genuinely flat fill (background) or speck -> skip grabCut
      } else {
        var gm = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(cv.GC_PR_BGD));
        gm.setTo(new cv.Scalar(cv.GC_PR_FGD), region);
        var core = new cv.Mat(); cv.erode(region, core, k);
        if (cv.countNonZero(core) > 0) gm.setTo(new cv.Scalar(cv.GC_FGD), core);
        var bg = new cv.Mat(), fg = new cv.Mat();
        try { cv.grabCut(rgb, gm, new cv.Rect(0, 0, 1, 1), bg, fg, 3, cv.GC_INIT_WITH_MASK); } catch (e) { }
        fm = cv.Mat.zeros(H, W, cv.CV_8UC1); var gd = gm.data, fd = fm.data;
        for (var i = 0; i < gd.length; i++) { var v = gd[i]; if (v === cv.GC_FGD || v === cv.GC_PR_FGD) fd[i] = 255; }
        [gm, core, bg, fg].forEach(function (m) { m.delete(); });
      }
      /* Focus cue. A colour flood only learns ONE colour of the object (a red label), so grabCut reads the
         object's other parts — a black spray cap, a dark glass neck — as part of the dark backdrop and
         leaves them out. Product photos are mostly a sharp subject on a soft backdrop, so look for the
         small IN-FOCUS pieces that sit against the cut and add them. Skipped when most of the frame is
         sharp (no depth of field to learn from). */
      if (area <= W * H * 0.9) {
        var fx = focusExtension(rgb, fm, W, H);
        if (fx) {
          var uni = new cv.Mat(); cv.bitwise_or(fm, fx.parts, uni);
          var gz = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(cv.GC_BGD));          // outside the zone everything is already decided
          gz.setTo(new cv.Scalar(cv.GC_FGD), uni);
          var zd2 = fx.zone.data, gzd = gz.data, ux0 = W, uy0 = H, ux1 = 0, uy1 = 0;
          for (var zi = 0; zi < zd2.length; zi++) if (zd2[zi]) {
            var zx = zi % W, zy = (zi / W) | 0;
            if (zx < ux0) ux0 = zx; if (zx > ux1) ux1 = zx; if (zy < uy0) uy0 = zy; if (zy > uy1) uy1 = zy;
            if (gzd[zi] !== cv.GC_FGD) gzd[zi] = zd2[zi] === 128 ? cv.GC_PR_FGD : cv.GC_PR_BGD;
          }
          var gpad = Math.round(Math.max(W, H) * 0.05);
          var grx = Math.max(0, ux0 - gpad), gry = Math.max(0, uy0 - gpad), gr = new cv.Rect(grx, gry, Math.min(W, ux1 + gpad) - grx, Math.min(H, uy1 + gpad) - gry);
          var got = false;
          if (gr.width > 8 && gr.height > 8) {
            var gri = rgb.roi(gr).clone(), grm = gz.roi(gr).clone(), gbg = new cv.Mat(), gfg = new cv.Mat();
            try {
              cv.grabCut(gri, grm, new cv.Rect(0, 0, 1, 1), gbg, gfg, 2, cv.GC_INIT_WITH_MASK);
              var rd3 = grm.data, fd3 = fm.data;
              for (var ry3 = 0; ry3 < gr.height; ry3++) for (var rx3 = 0; rx3 < gr.width; rx3++) {
                var v3 = rd3[ry3 * gr.width + rx3], gi3 = (gry + ry3) * W + grx + rx3;
                if (zd2[gi3] && (v3 === cv.GC_FGD || v3 === cv.GC_PR_FGD)) fd3[gi3] = 255;
              }
              got = true;
            } catch (e) { got = false; }
            [gri, grm, gbg, gfg].forEach(function (m) { m.delete(); });
          }
          cv.bitwise_or(fm, fx.parts, fm);
          if (!got) { var nk = new cv.Mat(); cv.bitwise_and(fx.zone, fx.zone, nk); cv.bitwise_or(fm, nk, fm); nk.delete(); }
          [uni, gz, fx.parts, fx.zone].forEach(function (m) { m.delete(); });
        }
      }
      cv.GaussianBlur(fm, fm, new cv.Size(3, 3), 0); cv.threshold(fm, fm, 127, 255, cv.THRESH_BINARY);
      var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(fm, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      /* Prefer the contour that actually CONTAINS the click, and only fall back to "largest" when
         nothing does. The previous test used the bounding BOX plus a `pick < 0 || a > pa` mix that
         let a bigger contour win even when a smaller one held the seed — clicking a small element
         could hand back a larger same-coloured one elsewhere on the canvas. pointPolygonTest is
         true containment, so an L-shaped or concave neighbour whose bbox merely overlaps the click
         no longer qualifies. */
      var pick = -1, pa = 0, hit = -1, ha = 0;
      for (var j = 0; j < cs.size(); j++) {
        var c = cs.get(j), a = cv.contourArea(c);
        if (cv.pointPolygonTest(c, new cv.Point(seed.cx, seed.cy), false) >= 0) {
          if (hit < 0 || a < ha) { ha = a; hit = j; }     // smallest containing contour = the clicked element
        }
        if (a > pa) { pa = a; pick = j; }
        c.delete();
      }
      if (hit >= 0) pick = hit;
      if (pick >= 0) { var cc = cs.get(pick), ap = new cv.Mat(); cv.approxPolyDP(cc, ap, EPS * cv.arcLength(cc, true), true); pts = []; for (var p = 0; p < ap.rows; p++) pts.push({ x: ap.intPtr(p, 0)[0], y: ap.intPtr(p, 0)[1] }); ap.delete(); cc.delete(); }
      fm.delete(); cs.delete(); h.delete();
    }
    [src, rgb, ff, region, k].forEach(function (m) { m.delete(); });
    return (pts && pts.length >= 3) ? pts : null;
  }

  // Polygon clipping (union): rasterise every selected polygon into one mask, then re-trace it.
  // Overlapping/touching polygons merge into a single outline; disjoint ones stay separate.
  function unionPolys(W, H, polys) {
    var m = cv.Mat.zeros(H, W, cv.CV_8UC1), mv = new cv.MatVector(), tmp = [];
    for (var i = 0; i < polys.length; i++) {
      var pl = polys[i]; if (!pl || pl.length < 3) continue;
      var flat = []; for (var j = 0; j < pl.length; j++) flat.push(pl[j].x | 0, pl[j].y | 0);
      var pm = cv.matFromArray(pl.length, 1, cv.CV_32SC2, flat); mv.push_back(pm); tmp.push(pm);
    }
    cv.fillPoly(m, mv, new cv.Scalar(255));
    var k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.morphologyEx(m, m, cv.MORPH_CLOSE, k);   // bridge hairline gaps so touching objects fuse
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(m, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = [];
    for (var c = 0; c < cs.size(); c++) {
      var cc = cs.get(c); if (cv.contourArea(cc) < 12) { cc.delete(); continue; }
      var ap = new cv.Mat(); cv.approxPolyDP(cc, ap, 0.006 * cv.arcLength(cc, true), true);
      var pts = []; for (var p = 0; p < ap.rows; p++) pts.push({ x: ap.intPtr(p, 0)[0], y: ap.intPtr(p, 0)[1] });
      if (pts.length >= 3) out.push(pts); ap.delete(); cc.delete();
    }
    tmp.forEach(function (x) { x.delete(); }); [m, k, h].forEach(function (x) { x.delete(); }); mv.delete(); cs.delete();
    return out;
  }

  // Rasterise polys, grow (r>0) / shrink (r<0) by |r| px, re-trace. Selection Expand/Contract.
  function morphPolys(W, H, polys, r) {
    var m = cv.Mat.zeros(H, W, cv.CV_8UC1), mv = new cv.MatVector(), tmp = [];
    for (var i = 0; i < polys.length; i++) { var pl = polys[i]; if (!pl || pl.length < 3) continue; var flat = []; for (var j = 0; j < pl.length; j++) flat.push(pl[j].x | 0, pl[j].y | 0); var pm = cv.matFromArray(pl.length, 1, cv.CV_32SC2, flat); mv.push_back(pm); tmp.push(pm); }
    cv.fillPoly(m, mv, new cv.Scalar(255));
    var rr = Math.max(1, Math.round(Math.abs(r))), k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * rr + 1, 2 * rr + 1));
    if (r >= 0) cv.dilate(m, m, k); else cv.erode(m, m, k);
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(m, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = [];
    for (var c = 0; c < cs.size(); c++) { var cc = cs.get(c); if (cv.contourArea(cc) < 12) { cc.delete(); continue; } var ap = new cv.Mat(); cv.approxPolyDP(cc, ap, 0.004 * cv.arcLength(cc, true), true); var pts = []; for (var q = 0; q < ap.rows; q++) pts.push({ x: ap.intPtr(q, 0)[0], y: ap.intPtr(q, 0)[1] }); if (pts.length >= 3) out.push(pts); ap.delete(); cc.delete(); }
    tmp.forEach(function (x) { x.delete(); }); [m, k, h].forEach(function (x) { x.delete(); }); mv.delete(); cs.delete();
    return out;
  }

  // base minus cut (alt-click subtract): fill base at 255, punch the cut back to 0, re-trace.
  function subtractPolys(W, H, base, cut) {
    var m = cv.Mat.zeros(H, W, cv.CV_8UC1);
    function fill(polys, val) { var mv = new cv.MatVector(), tmp = []; for (var i = 0; i < polys.length; i++) { var pl = polys[i]; if (!pl || pl.length < 3) continue; var flat = []; for (var j = 0; j < pl.length; j++) flat.push(pl[j].x | 0, pl[j].y | 0); var pm = cv.matFromArray(pl.length, 1, cv.CV_32SC2, flat); mv.push_back(pm); tmp.push(pm); } cv.fillPoly(m, mv, new cv.Scalar(val)); tmp.forEach(function (x) { x.delete(); }); mv.delete(); }
    fill(base, 255); fill(cut, 0);
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(m, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = [];
    for (var c = 0; c < cs.size(); c++) { var cc = cs.get(c); if (cv.contourArea(cc) < 12) { cc.delete(); continue; } var ap = new cv.Mat(); cv.approxPolyDP(cc, ap, 0.004 * cv.arcLength(cc, true), true); var pts = []; for (var q = 0; q < ap.rows; q++) pts.push({ x: ap.intPtr(q, 0)[0], y: ap.intPtr(q, 0)[1] }); if (pts.length >= 3) out.push(pts); ap.delete(); cc.delete(); }
    [m, h].forEach(function (x) { x.delete(); }); cs.delete();
    return out;
  }

  // Every region whose colour matches the seed pixel within tol ("select similar", whole-image).
  function similarRegions(img, seed, tol) {
    var W = img.width, H = img.height, src = cv.matFromImageData(img), rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    var px = rgb.ucharPtr(seed.cy, seed.cx);
    var lo = new cv.Mat(rgb.rows, rgb.cols, rgb.type(), [Math.max(0, px[0] - tol), Math.max(0, px[1] - tol), Math.max(0, px[2] - tol), 0]);
    var hi = new cv.Mat(rgb.rows, rgb.cols, rgb.type(), [Math.min(255, px[0] + tol), Math.min(255, px[1] + tol), Math.min(255, px[2] + tol), 255]);
    var mask = new cv.Mat(); cv.inRange(rgb, lo, hi, mask);
    var k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k); cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
    var cs = new cv.MatVector(), h = new cv.Mat(); cv.findContours(mask, cs, h, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    var out = [], minA = W * H * 0.0006;
    for (var c = 0; c < cs.size(); c++) { var cc = cs.get(c); if (cv.contourArea(cc) < minA) { cc.delete(); continue; } var ap = new cv.Mat(); cv.approxPolyDP(cc, ap, 0.003 * cv.arcLength(cc, true), true); var pts = []; for (var q = 0; q < ap.rows; q++) pts.push({ x: ap.intPtr(q, 0)[0], y: ap.intPtr(q, 0)[1] }); if (pts.length >= 3) out.push(pts); ap.delete(); cc.delete(); }
    [src, rgb, lo, hi, mask, k, h].forEach(function (x) { x.delete(); }); cs.delete();
    return out.slice(0, 40);
  }

  function handle(m) {
    try {
      if (m.type === 'detect') { var dr = { id: m.id, boxes: boxes(m.img) }; if (m.text) dr.textBoxes = textBoxes(m.img); self.postMessage(dr); }
      else if (m.type === 'grabcut') self.postMessage({ id: m.id, pts: grab(m.img, m.seed, m.work) });
      else if (m.type === 'wand') self.postMessage({ id: m.id, pts: wand(m.img, m.seed, m.tol, m.eps) });
      else if (m.type === 'union') self.postMessage({ id: m.id, polys: unionPolys(m.W, m.H, m.polys) });
      else if (m.type === 'morph') self.postMessage({ id: m.id, polys: morphPolys(m.W, m.H, m.polys, m.r) });
      else if (m.type === 'subtract') self.postMessage({ id: m.id, polys: subtractPolys(m.W, m.H, m.base, m.cut) });
      else if (m.type === 'similar') self.postMessage({ id: m.id, polys: similarRegions(m.img, m.seed, m.tol) });
      else if (m.type === 'objects') self.postMessage({ id: m.id, polys: objectsIn(m.img, m.polys, !!m.invert) });
      else if (m.type === 'cutout' || m.type === 'cutrefine') {
        var cr = m.type === 'cutout' ? cutout(m.img) : cutRefine(m.strokes);
        var tr = cr && cr.alpha ? [cr.alpha.buffer].concat(cr.decon ? [cr.decon.buffer] : []) : [];
        self.postMessage({ id: m.id, cut: cr }, tr);
      }
      else if (m.type === 'cutfree') { cutFree(); self.postMessage({ id: m.id, ok: true }); }
      else if (m.type === 'cutsync') { self.postMessage({ id: m.id, ok: cutSync(m.alpha) }); }
    }
    catch (err) { self.postMessage({ id: m.id, error: String((err && err.message) || err) }); }
  }
  self.onmessage = function (e) { var m = e.data; if (!m || !m.type) return; if (ready) handle(m); else q.push(m); };
}

/* Loaded via importScripts INSIDE the worker at runtime — never bundled as a JS module import.
   Defaults to the copy vendored at packages/core/vendor/opencv/opencv.js (see VERSION alongside
   it) so a cv-backed tool works offline and doesn't depend on unpkg.com being reachable.

   This is a root-relative path, NOT `new URL('...', import.meta.url)`: this module ships both as
   raw source (the demo imports packages/core/src/cv/worker.js directly, unbundled — import.meta.url
   would work there) AND bundled into @canvasmith/react's dist/index.js and dist/standalone.js,
   where import.meta.url would resolve against the bundled file's own location (wrong path
   entirely), and the IIFE standalone build doesn't support import.meta at all (esbuild strips it
   to an empty object). A root-relative path has none of those failure modes, but it does assume
   packages/core/vendor/opencv/opencv.js is served at that same path from the consuming site's
   root — true for this repo's own Netlify deploy, NOT guaranteed for a downstream host.
   Any host bundling @canvasmith/react (or serving the demo from a subpath) MUST either copy
   vendor/opencv/opencv.js to that path themselves, or override it explicitly:
     new CvEngine({ openCvUrl: '/my-assets/opencv.js' })
   — see packages/react/README (mount()'s `openCvUrl` option) for the React-package equivalent. */
export const DEFAULT_OPENCV_URL = '/packages/core/vendor/opencv/opencv.js';

export function cvWorkerSource(openCvUrl = DEFAULT_OPENCV_URL) {
  return 'self.OPENCV_URL=' + JSON.stringify(openCvUrl) + ';(' + cvWorkerBody.toString() + ')();';
}
