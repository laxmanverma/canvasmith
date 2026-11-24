/* Serialization and import/export.

   EXTRA lists the library's own layer metadata that must survive fabric.toJSON round-trips —
   drop one of these and undo/redo silently strips it from every layer. */

export const EXTRA = ['id', 'role', 'name', 'locked', 'spec', 'fx', 'regionType', 'rcontent', 'rstyle', 'renamed', 'isFreehand', 'maskEnabled', 'edgeFeather', 'adj', 'geom', 'cornerRadius', 'shapeKind', 'strokePosition', 'fillOff', 'strokeOff', 'adOpts', 'adField'];

/* fc.toJSON() doesn't carry the artboard's own width/height (only its objects/background), so a
   canvas-size change (Editor#resizeCanvas) would otherwise be invisible to undo/redo — every
   snapshot embeds the artboard dimensions alongside the fabric JSON to round-trip that too.
   W/H are the ARTBOARD's logical size, passed in by the caller — NOT fc.getWidth()/getHeight(),
   which is the fabric <canvas> element's own DOM size (always the host's stage/container size,
   independent of the artboard — see Editor's constructor comment). */
export function serialize(fc, W, H, meta) {
  // `meta` ({frames, active, org}) is the page's frame layout — see Editor#_frameMeta. Absent for
  // callers that don't know about frames; restore() then hands back undefined and the Editor
  // synthesises the single default frame, which is also how pre-frame saves load.
  const o = { w: W, h: H, scene: fc.toJSON(EXTRA) };
  if (meta) { o.frames = meta.frames; o.active = meta.active; o.org = meta.org; }
  return JSON.stringify(o);
}

/* Restores a scene WITHOUT touching fc's own DOM dimensions — those belong to the host's stage,
   not the artboard being restored. onDone(w, h) hands the artboard size back to the caller
   (Editor#_afterRestore) so it can update this.W/H and let the host re-fit its viewport. */
export function restore(fc, json, { engine, history, onDone } = {}) {
  if (history) history.lock = true;
  const { w, h, scene, frames, active, org } = JSON.parse(json);
  const meta = frames ? { frames, active, org } : undefined;
  if (engine) { engine.W = w; engine.H = h; }
  fc.loadFromJSON(scene, () => {
    if (engine) engine.adopt();
    fc.renderAll();
    if (history) history.lock = false;
    if (onDone) onDone(w, h, meta);
  });
}

/* Export the artboard as an image, independent of the current zoom/pan AND of fc's own DOM size
   (which is the host's stage size, generally larger than the artboard). Resetting the viewport
   transform to identity makes scene coordinates equal canvas pixel coordinates, so toDataURL's
   left:0,top:0,width:W,height:H crop grabs exactly the artboard region regardless of how big the
   underlying canvas element is. */
export function exportImage(fc, W, H, { format = 'png', quality = 0.92, multiplier = 1 } = {}) {
  const vpt = fc.viewportTransform.slice();
  fc.setViewportTransform([1, 0, 0, 1, 0, 0]);
  const url = fc.toDataURL({ format, quality, multiplier, left: 0, top: 0, width: W, height: H });
  fc.setViewportTransform(vpt);
  fc.renderAll();
  return url;
}

/* Load a URL/dataURL as an image layer, scaled to fit the artboard. 'contain' fits the whole
   image inside the artboard (scaling UP a smaller image as well as down a larger one — matches
   the reference editor's own makeObj exactly, which has no "never upscale" clamp); 'cover' fills
   the artboard and lets the overflow run past its edges. */
/* A layer name from an image's file name, the way a design app labels a placed file:
   "bag_ad.png" -> "bag ad". Falls back to "Image" for blank or generic names. */
export function imageLayerName(fileName) {
  const base = String(fileName || '').split(/[\\/]/).pop().replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base && !/^(image|blob|untitled|dropped image|opened image)$/i.test(base) ? base.slice(0, 40) : 'Image';
}

export function addImageLayer(fabric, fc, src, { W, H, name = 'Image', role = 'image', fit = 'contain' } = {}) {
  return new Promise((resolve, reject) => {
    fabric.Image.fromURL(src, img => {
      if (!img || !img.width) return reject(new Error('Could not load that image.'));
      const scale = fit === 'cover'
        ? Math.max(W / img.width, H / img.height)
        : Math.min(W / img.width, H / img.height);
      img.set({
        left: (W - img.width * scale) / 2, top: (H - img.height * scale) / 2,
        scaleX: scale, scaleY: scale,
        id: 'o' + Math.random().toString(36).slice(2, 8), role, name,
      });
      fc.add(img);
      fc.setActiveObject(img);
      fc.renderAll();
      resolve(img);
    }, { crossOrigin: 'anonymous' });
  });
}

/* Artboard dimensions matched to an image's own pixels (capped so huge photos stay workable) —
   opening a 9:16 photo must NOT crop it into a square. */
export function artboardForImage(src, cap = 1600) {
  return new Promise(resolve => {
    const im = new Image();
    im.onload = () => {
      const w = im.naturalWidth || 1080, h = im.naturalHeight || 1080;
      const sc = Math.min(1, cap / Math.max(w, h));
      resolve({ width: Math.max(1, Math.round(w * sc)), height: Math.max(1, Math.round(h * sc)) });
    };
    im.onerror = () => resolve({ width: 1080, height: 1080 });
    im.src = src;
  });
}

/* Plain <img> load (no fabric wrapping) — for callers that need raw pixel access, e.g. cropping
   per-region canvases out of a flattened source in detectRegionsToLayers(). */
export function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('Could not load that image.'));
    im.crossOrigin = 'anonymous';
    im.src = src;
  });
}
