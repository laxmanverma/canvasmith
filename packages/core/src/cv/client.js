/* CvEngine — thin promise RPC over the OpenCV worker.

   Mirrors how AIRegistry degrades with no provider: nothing here throws past its call site, and
   nothing eagerly loads OpenCV. The worker (and its multi-MB WASM payload) only boots the first
   time a caller actually invokes one of these methods — a host that never touches a cv-backed
   tool never pays for it. If the Worker API is unavailable, or the worker fails to boot (offline,
   CDN blocked, no WASM support), every method resolves to `null` instead of rejecting, so the
   editor's own wand/selection fallbacks take over transparently.

   Usage: const cv = new CvEngine(); const pts = await cv.wand(imgData, {cx,cy}, 32); */
import { cvWorkerSource, DEFAULT_OPENCV_URL } from './worker.js';

const TIMEOUT_MS = 20000;

export class CvEngine {
  constructor({ openCvUrl = DEFAULT_OPENCV_URL } = {}) {
    // Resolved to an absolute URL here, in the main-thread page context (where `location` is
    // available) — a root-relative path like DEFAULT_OPENCV_URL's '/packages/...' reaches the
    // worker's importScripts() as a bare string with no base to resolve against (its blob: URL
    // doesn't count, per Chromium), which throws a SyntaxError there instead of loading.
    this._openCvUrl = (typeof location !== 'undefined') ? new URL(openCvUrl, location.href).href : openCvUrl;
    this._worker = null;
    this._bootState = 'idle';      // idle | booting | ready | failed
    this._bootWait = null;
    this._reqId = 0;
    this._reqs = {};
  }

  /* True once the worker has confirmed OpenCV initialized — lets a host show "upgrading…" UI. */
  get ready() { return this._bootState === 'ready'; }
  get unavailable() { return this._bootState === 'failed'; }

  _boot() {
    if (this._bootWait) return this._bootWait;
    this._bootWait = new Promise((resolve) => {
      if (typeof Worker === 'undefined') { this._bootState = 'failed'; resolve(false); return; }
      this._bootState = 'booting';
      let worker;
      try {
        const url = URL.createObjectURL(new Blob([cvWorkerSource(this._openCvUrl)], { type: 'application/javascript' }));
        worker = new Worker(url);
      } catch (e) { this._bootState = 'failed'; resolve(false); return; }
      const bootTimer = setTimeout(() => { this._bootState = 'failed'; resolve(false); }, TIMEOUT_MS);
      worker.onmessage = (e) => {
        const m = e.data;
        if (m && m.boot) {
          clearTimeout(bootTimer);
          if (m.boot === 'ready') { this._worker = worker; this._bootState = 'ready'; resolve(true); }
          else { this._bootState = 'failed'; try { worker.terminate(); } catch (e2) { } resolve(false); }
          return;
        }
        const r = this._reqs[m.id]; if (!r) return; delete this._reqs[m.id];
        m.error ? r.reject(new Error(m.error)) : r.resolve(m);
      };
      worker.onerror = () => { clearTimeout(bootTimer); this._bootState = 'failed'; resolve(false); };
    });
    return this._bootWait;
  }

  async _call(type, payload, transfer) {
    const up = await this._boot();
    if (!up || !this._worker) return null;
    return new Promise((resolve) => {
      const id = ++this._reqId;
      this._reqs[id] = { resolve: (m) => resolve(m), reject: () => resolve(null) };
      try { this._worker.postMessage(Object.assign({ id, type }, payload), transfer || []); }
      catch (e) { delete this._reqs[id]; resolve(null); return; }
      setTimeout(() => { if (this._reqs[id]) { delete this._reqs[id]; resolve(null); } }, TIMEOUT_MS);
    });
  }

  /* Object-box + (optionally) text-region detection over a downscaled ImageData. */
  async detect(img, { text = false } = {}) {
    const r = await this._call('detect', { img, text }, [img.data.buffer]);
    return r ? { boxes: r.boxes || [], textBoxes: r.textBoxes || null } : null;
  }

  /* Seeded GrabCut inside a work rect — returns a polygon ({x,y}[]) or null. */
  async grabcut(img, seed, work) {
    const r = await this._call('grabcut', { img, seed, work }, [img.data.buffer]);
    return r ? r.pts : null;
  }

  /* Hybrid colour-flood + grabCut magic wand — returns a polygon ({x,y}[]) or null. */
  async wand(img, seed, tol, eps) {
    const r = await this._call('wand', { img, seed, tol, eps }, [img.data.buffer]);
    return r ? r.pts : null;
  }

  /* Union one or more polygons (scene px) into merged outline(s). */
  async union(W, H, polys) {
    const r = await this._call('union', { W, H, polys });
    return r ? r.polys : null;
  }

  /* Grow (r>0) or shrink (r<0) the given polygons by |r| px — selection expand/contract. */
  async morph(W, H, polys, r) {
    const res = await this._call('morph', { W, H, polys, r });
    return res ? res.polys : null;
  }

  /* Boolean-subtract `cut` polygons out of `base` polygons. */
  async subtract(W, H, base, cut) {
    const r = await this._call('subtract', { W, H, base, cut });
    return r ? r.polys : null;
  }

  /* Every region in the whole image matching the seed pixel's colour within `tol`. */
  async similar(img, seed, tol) {
    const r = await this._call('similar', { img, seed, tol }, [img.data.buffer]);
    return r ? r.polys : null;
  }

  /* The foreground objects inside rough selection rings (image px) — a polygon per object.
     `invert`: the selected area is everything EXCEPT the rings. */
  async objects(img, polys, invert = false) {
    const r = await this._call('objects', { img, polys, invert }, [img.data.buffer]);
    return r ? r.polys : null;
  }

  /* Offline background removal (see the worker's cutout()): resolves { alpha: Uint8Array (W*H,
     0-255), decon: RGBA Uint8ClampedArray | null, method: 'flat'|'grabcut', W, H, kept } or
     { empty: true }; null if the worker isn't available. The worker keeps this image for
     cutoutRefine() until the next cutout() / cutoutFree(). */
  async cutout(img) {
    const r = await this._call('cutout', { img }, [img.data.buffer]);
    return r ? r.cut : null;
  }

  /* Keep/Remove touch-up strokes on the last cutout: [{ keep, r, pts: [{x,y}] }] in cutout px.
     Same result shape as cutout(); null when there is no cutout to refine. */
  async cutoutRefine(strokes) {
    const r = await this._call('cutrefine', { strokes });
    return r ? r.cut : null;
  }

  async cutoutFree() { await this._call('cutfree', {}); }

  /* Re-bases the last cutout's touch-up state on `alpha` (Uint8Array W*H, 0-255, cutout px) — the
     mask an undo/redo just restored. Resolves true when there was a cutout of that size to sync. */
  async cutoutSync(alpha) {
    const r = await this._call('cutsync', { alpha }, [alpha.buffer]);
    return !!(r && r.ok);
  }

  destroy() {
    if (this._worker) { try { this._worker.terminate(); } catch (e) { } }
    this._worker = null; this._bootState = 'idle'; this._bootWait = null;
    Object.keys(this._reqs).forEach(id => { this._reqs[id].reject(new Error('cv engine destroyed')); delete this._reqs[id]; });
  }
}

/* Downscale an <img>/<canvas>/ImageBitmap-like source to ImageData for the worker — capping
   resolution keeps grabCut/floodFill fast; callers scale returned points back up by kx/ky. */
export function prepImageData(source, maxDim = 768) {
  const iw = source.naturalWidth || source.width, ih = source.naturalHeight || source.height;
  const scale = Math.min(1, maxDim / Math.max(iw, ih));
  const ew = Math.max(1, Math.round(iw * scale)), eh = Math.max(1, Math.round(ih * scale));
  const c = document.createElement('canvas'); c.width = ew; c.height = eh;
  const ctx = c.getContext('2d'); ctx.drawImage(source, 0, 0, ew, eh);
  return ctx.getImageData(0, 0, ew, eh);
}
