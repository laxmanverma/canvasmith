/* GeminiProvider — AI features on Google's FREE daily quota.

   Google gives every Google account a free Gemini API key (aistudio.google.com/apikey) with a
   daily free-tier allowance — no card required. That is the "no token? use Google's free daily
   credits" path: the user pastes their free key once and the editor's AI tools light up. The key
   lives in the browser (localStorage) and requests go straight from the user's browser to Google,
   so an open-source deployment never proxies or pays for anyone's usage.

   Free-tier keys rate-limit rather than bill, so 429s are expected mid-day — they surface as
   'rate_limited' with the reset hint, never as a broken tool.

   SECURITY NOTE for hosts: this provider is for personal/self-hosted use. A SaaS should register
   its own server-side provider instead (see adapters/ditto) so no key ever ships to the client. */

const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const IMAGE_MODEL = 'gemini-2.5-flash-image';   // free-tier eligible image generation + editing
const TEXT_MODEL = 'gemini-2.5-flash';          // free-tier eligible vision/text
const STORE_KEY = 'canvasmith.gemini.key';

const dataUrlParts = (d) => {
  const m = /^data:([^;]+);base64,(.*)$/.exec(d || '');
  return m ? { mime: m[1], b64: m[2] } : null;
};

async function call(key, model, body) {
  const r = await fetch(API + model + ':generateContent?key=' + encodeURIComponent(key), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const err = new Error(r.status === 429
      ? 'Free daily quota hit — it resets within 24h, or add billing to the key.'
      : 'Gemini error ' + r.status + ': ' + text.slice(0, 200));
    err.code = r.status;
    throw err;
  }
  return r.json();
}

const firstImage = (res) => {
  for (const part of (((res || {}).candidates || [{}])[0].content || {}).parts || []) {
    const d = part.inlineData || part.inline_data;
    if (d && String(d.mimeType || d.mime_type || '').startsWith('image')) {
      return 'data:' + (d.mimeType || d.mime_type) + ';base64,' + d.data;
    }
  }
  return null;
};

import { MATCH_FONTS } from '../shapes.js';

const REGION_TYPES = ['product', 'logo', 'text', 'sticker', 'decorative'];
const FONT_NAMES = MATCH_FONTS.map(f => f[0]);
const HEX = /^#[0-9a-f]{6}$/i;
/* One raw detection -> {type, content, bbox (percent), style?}. Accepts box_2d (preferred) or a
   legacy percent bbox; drops anything without a usable box. The AI's colour is only a hint — the
   editor samples the real ink colour from the pixels and falls back to this. */
function toRegion(r) {
  if (!r || typeof r !== 'object') return null;
  let bbox = null;
  const b2 = r.box_2d || r.box2d || r.box;
  if (Array.isArray(b2) && b2.length === 4 && b2.every(v => Number.isFinite(+v))) {
    const [y0, x0, y1, x1] = b2.map(Number);
    bbox = { x: Math.min(x0, x1) / 10, y: Math.min(y0, y1) / 10, width: Math.abs(x1 - x0) / 10, height: Math.abs(y1 - y0) / 10 };
  } else if (r.bbox && typeof r.bbox === 'object') {
    bbox = { x: +r.bbox.x || 0, y: +r.bbox.y || 0, width: +r.bbox.width || 0, height: +r.bbox.height || 0 };
  }
  if (!bbox || !(bbox.width > 0) || !(bbox.height > 0)) return null;
  const type = REGION_TYPES.includes(r.type) ? r.type : 'decorative';
  const out = { type, content: typeof r.content === 'string' ? r.content.replace(/\\n/g, '\n') : '', bbox };
  const st = r.style && typeof r.style === 'object' ? r.style : null;
  if (type === 'text' && st) {
    const style = {};
    if (HEX.test(st.color || '')) style.colorHint = st.color;
    if (st.fontWeight === 'bold' || st.fontWeight === 'normal') style.fontWeight = st.fontWeight;
    if (['left', 'center', 'right'].includes(st.textAlign)) style.textAlign = st.textAlign;
    const font = FONT_NAMES.find(n => n.toLowerCase() === String(st.font || '').trim().toLowerCase());
    if (font) style.font = font;
    if (st.italic === true) style.italic = true;
    if (Object.keys(style).length) out.style = style;
  }
  return out;
}

const firstText = (res) => {
  for (const part of (((res || {}).candidates || [{}])[0].content || {}).parts || []) {
    if (part.text) return part.text;
  }
  return '';
};

/* Some browser contexts (blocked third-party storage, certain privacy/incognito modes, sandboxed
   iframes) throw on ANY access to `localStorage`, not just typeof — `typeof localStorage` alone
   still throws in those cases, so every read/write here goes through a try/catch that treats a
   throw the same as "storage unavailable" instead of letting it crash the caller (module init, a
   key paste, ...). */
function safeStorageGet(k) { try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; } catch (e) { return null; } }
function safeStorageSet(k, v) { try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (e) { /* storage unavailable — key just won't persist */ } }
function safeStorageRemove(k) { try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } }

export class GeminiProvider {
  /* key: pass explicitly, or omit to read/persist from localStorage (personal use). */
  constructor({ key, persist = true } = {}) {
    this._persist = persist;
    this._key = key || (persist ? safeStorageGet(STORE_KEY) : null) || null;
  }

  setKey(key) {
    this._key = key || null;
    if (this._persist) {
      if (key) safeStorageSet(STORE_KEY, key);
      else safeStorageRemove(STORE_KEY);
    }
  }

  hasKey() { return !!this._key; }

  /* Where a user gets their free key — surfaced by UIs when hasKey() is false. */
  static keyInstructions() {
    return 'Get a free Gemini API key (no card needed): open aistudio.google.com/apikey, sign in '
         + 'with any Google account, and click "Create API key". Google includes a free daily '
         + 'usage allowance with every key.';
  }

  _need() {
    if (!this._key) {
      const e = new Error('No Gemini key set. ' + GeminiProvider.keyInstructions());
      e.code = 401;
      throw e;
    }
    return this._key;
  }

  /* maskDataURL is optional — Gemini's image model has no literal pixel-mask input channel (no
     guaranteed "only touch white-masked pixels"), so a mask is passed as a SECOND image part with
     explanatory text asking the model to treat it as an editing guide, rather than silently
     dropping the 3rd argument a caller (Editor#aiBgSwap/#aiExtendBackground) may supply. This is
     best-effort guidance, not a hard pixel guarantee the way a real inpainting API's mask channel
     would be — a host that needs pixel-exact masked edits should register a provider backed by a
     model with true mask support instead. */
  async magicEdit(imageDataURL, instruction, maskDataURL, opts = {}) {
    const key = this._need();
    const img = dataUrlParts(imageDataURL);
    if (!img) throw new Error('magicEdit needs a dataURL image.');
    const mask = maskDataURL ? dataUrlParts(maskDataURL) : null;
    const ref = opts.reference ? dataUrlParts(opts.reference) : null;
    const parts = [
      { text: 'Edit this image. Apply exactly this instruction and change nothing else: ' + instruction },
      { inlineData: { mimeType: img.mime, data: img.b64 } },
    ];
    if (mask) {
      parts.push(
        { text: 'Use this next image as an editing mask: white areas may be changed, black areas must stay pixel-identical to the first image.' },
        { inlineData: { mimeType: mask.mime, data: mask.b64 } },
      );
    }
    if (ref) {
      parts.push(
        { text: 'Use this last image only as a reference for the requested change (style, colours, or the object to add). Do not copy its layout; edit the first image.' },
        { inlineData: { mimeType: ref.mime, data: ref.b64 } },
      );
    }
    const res = await call(key, IMAGE_MODEL, { contents: [{ parts }] });
    const out = firstImage(res);
    if (!out) throw new Error('The model returned no image (safety filter or refusal).');
    return out;
  }

  async generateImage(prompt, opts = {}) {
    const key = this._need();
    const ref = opts.reference ? dataUrlParts(opts.reference) : null;
    const parts = [{ text: prompt + (opts.transparent ? ' On a plain solid white background, single subject centered.' : '') }];
    if (ref) parts.push({ text: 'Reference image (match its style/subject):' }, { inlineData: { mimeType: ref.mime, data: ref.b64 } });
    const res = await call(key, IMAGE_MODEL, { contents: [{ parts }] });
    const out = firstImage(res);
    if (!out) throw new Error('The model returned no image (safety filter or refusal).');
    return out;
  }

  async removeBackground(imageDataURL) {
    /* Image models can't emit real alpha reliably; ask for a clean solid background instead and
       let the host chroma-key it, or swap in a dedicated cutout provider for production use. */
    return this.magicEdit(imageDataURL,
      'Cut out the main subject perfectly and place it on a pure solid #00FF00 green background. '
      + 'Keep the subject pixels IDENTICAL — no relighting, no restyling.');
  }

  /* Rewrites a terse request ("make it pop") into one specific, model-friendly instruction. */
  async enhancePrompt(text, opts = {}) {
    const key = this._need();
    const what = opts.kind === 'background' ? 'a background-replacement description' : 'an image-editing instruction';
    const res = await call(key, TEXT_MODEL, {
      contents: [{ parts: [{ text: 'Rewrite the following as ' + what + ' for an image model: one or two clear, '
        + 'specific sentences covering subject, lighting, colour and mood. Keep the user\'s intent; do not add '
        + 'unrelated objects. Reply with the rewritten text only, no quotes or preamble.\n\n' + text }] }],
    });
    const out = firstText(res).trim().replace(/^["']|["']$/g, '');
    if (!out) throw new Error('The model returned no text.');
    return out;
  }

  async describe(imageDataURL) {
    const key = this._need();
    const img = dataUrlParts(imageDataURL);
    if (!img) throw new Error('describe needs a dataURL image.');
    const res = await call(key, TEXT_MODEL, {
      contents: [{ parts: [
        { text: 'Describe this image in one short sentence suitable as a layer name.' },
        { inlineData: { mimeType: img.mime, data: img.b64 } },
      ] }],
    });
    return firstText(res).trim();
  }

  /* Boxes come back in Gemini's native detection format — box_2d [ymin, xmin, ymax, xmax] on a
     0–1000 grid — which it localizes far more accurately than free-form x/y/width percentages
     (those drifted enough to put a headline's text layer over the wrong part of the image). They
     are converted to the registry's percent bbox here, so callers see the same contract. JSON
     mode is forced; an unreadable reply throws instead of silently returning [] (which used to
     leave only the local detector's unlabeled boxes and look like a successful detect). */
  async detectRegions(imageDataURL) {
    const key = this._need();
    const img = dataUrlParts(imageDataURL);
    if (!img) throw new Error('detectRegions needs a dataURL image.');
    const res = await call(key, TEXT_MODEL, {
      contents: [{ parts: [
        { text: 'This image is a flattened graphic design or photo that will be split into editable layers. '
              + 'List every distinct element: "product" (product shots, people, animals, the main subject), '
              + '"logo", "text" (each separate block of text: headline, subtitle, price, button label), '
              + 'and "decorative" (shapes, icons, badges, stickers). Do NOT include the overall background. '
              + 'Give each element a tight box_2d as [ymin, xmin, ymax, xmax] normalized to 0-1000. '
              + 'For text: "content" is the exact visible text, with \\n wherever the line breaks in the image, and '
              + '"style" is {"color": main fill colour as #rrggbb, "fontWeight": "bold" or "normal", "textAlign": "left", "center" or "right", '
              + '"italic": true or false, "font": the closest match from this list — ' + MATCH_FONTS.map(([n, look]) => n + ' (' + look + ')').join(', ') + '}. '
              + 'Report each visually separate text block once: do not also list its individual lines or words, and do not list text printed on a product package. '
              + 'Reply with a JSON array only: [{"type":"text","content":"","box_2d":[0,0,0,0],"style":{}}]' },
        { inlineData: { mimeType: img.mime, data: img.b64 } },
      ] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const text = firstText(res).replace(/```json|```/g, '').trim();
    let arr;
    try { arr = JSON.parse(text); } catch (e) { throw new Error('Gemini returned an unreadable detection result — try again.'); }
    if (arr && !Array.isArray(arr)) arr = arr.regions || arr.elements || arr.items || [];
    return (Array.isArray(arr) ? arr : []).map(toRegion).filter(Boolean);
  }

  /* Where is `description` in the image? Same box_2d convention as detectRegions; null if absent. */
  async locateObject(imageDataURL, description) {
    const key = this._need();
    const img = dataUrlParts(imageDataURL);
    if (!img) throw new Error('locateObject needs a dataURL image.');
    const res = await call(key, TEXT_MODEL, {
      contents: [{ parts: [
        { text: 'Find ' + JSON.stringify(String(description || '').slice(0, 120)) + ' in this image. Give ONE tight bounding box around the whole thing '
              + '(if several match, the most prominent one). Reply with JSON only: {"box_2d":[ymin,xmin,ymax,xmax]} on a 0-1000 grid, '
              + 'or {"box_2d":null} if it is not in the image.' },
        { inlineData: { mimeType: img.mime, data: img.b64 } },
      ] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    let o;
    try { o = JSON.parse(firstText(res).replace(/```json|```/g, '').trim()); } catch (e) { throw new Error('The model returned an unreadable location.'); }
    if (Array.isArray(o)) o = o[0];
    const r = toRegion({ box_2d: o && o.box_2d });
    return r ? r.bbox : null;
  }

  /* Free-form request -> editor commands. The model only chooses from a closed action list and the
     caller (voice.js) re-validates every field, so a bad reply can't do anything off-list. */
  async interpretCommand(text, ctx = {}) {
    const key = this._need();
    const res = await call(key, TEXT_MODEL, {
      contents: [{ parts: [{ text: 'You turn a spoken request for an image editor into editor commands. '
        + 'Reply with a JSON array only (1-5 commands, executed in order); reply [] if the request is not an editor command. '
        + 'Each command is {"action":"<id>", ...args} using ONLY these actions and args ("?" = optional):\n' + (ctx.catalog || '') + '\n'
        + 'Prefer the most specific action. AI actions (aiGenerate, aiEdit, aiBackground, replaceObject, aiRemoveObject, aiExtend) cost a model call and change pixels: use them ONLY when the user explicitly asks to generate, replace, edit or extend something with AI/photographic content. '
        + 'Plain drawing requests ("draw/add/make a circle, square, star, line, heart, text, sticker") are NEVER AI: use addShape, addSticker, a pen shape, or the matching tool. A leftover selection or earlier AI command does not change that. Colours are #rrggbb. Current editor state: ' + JSON.stringify(ctx.state || {}) + '. '
        + 'Request: ' + JSON.stringify(String(text || '').slice(0, 400)) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const out = firstText(res).replace(/```json|```/g, '').trim();
    let arr;
    try { arr = JSON.parse(out); } catch (e) { throw new Error('The model returned an unreadable command.'); }
    if (arr && !Array.isArray(arr)) arr = arr.commands || [arr];
    return Array.isArray(arr) ? arr : [];
  }
}
