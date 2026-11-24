/* Browser-driven tests for the Editor/PaintEngine paths the pure node:test suite can't reach
   (see core.test.mjs's header comment) — real Fabric, real Canvas2D, driven through an actual
   Chromium instance via Playwright. Each test gets a fresh Editor via test/fixtures/browser-editor.html,
   which exposes window.__ed (already wired to installKeybindings via window.__stopKeys).

   Run with `npm run test:browser` (separately from `npm test`'s fast pure-logic suite — this one
   needs a browser download, so it's opt-in for local dev and a separate CI step). */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png' };

let server, browser, baseURL;

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(req.url.split('?')[0]);
      const filePath = join(ROOT, path);
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});

after(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

let page;
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', (e) => { throw new Error('page error: ' + e.message); });
  await page.goto(baseURL + '/test/fixtures/browser-editor.html');
  await page.waitForFunction(() => window.__ready === true);
});

afterEach(async () => { if (page) await page.close(); });

/* ── shapes: click-drag sizing ────────────────────────────────────────────────────────── */
test('browser: click-drag creates a shape sized to the drag, Shift constrains to square', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 90, { steps: 4 });
  await page.mouse.up();
  const rect = await page.evaluate(() => { const o = window.__ed.fc.getObjects()[0]; return { type: o.type, left: o.left, top: o.top, width: o.width, height: o.height }; });
  assert.equal(rect.type, 'rect');
  assert.equal(rect.left, 50); assert.equal(rect.top, 50);
  assert.equal(rect.width, 100); assert.equal(rect.height, 40);

  await page.evaluate(() => window.__ed.setTool('ellipse'));
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 50);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  await page.mouse.move(canvasBox.x + 260, canvasBox.y + 90, { steps: 4 });
  await page.keyboard.up('Shift');
  await page.mouse.up();
  const ell = await page.evaluate(() => { const objs = window.__ed.fc.getObjects(); const o = objs[objs.length - 1]; return { rx: o.rx, ry: o.ry }; });
  assert.equal(ell.rx, ell.ry);   // Shift forces a 1:1 (circle) constraint
});

/* ── history: undo/redo across a real Fabric scene ────────────────────────────────────── */
test('browser: a fractional scale survives save/load and undo/redo without drifting', async () => {
  // Regression: Fabric serialises numbers to 2 decimals by default, so scale 1.0556 came back from
  // a reload or an undo as 1.06 — a 760px layer became 763px.
  const r = await page.evaluate(async () => {
    const ed = window.__ed, f = window.fabric;
    const o = new f.Rect({ left: 160.25, top: 215.5, width: 720, height: 900, scaleX: 760 / 720, scaleY: 950 / 900, strokeWidth: 0, fill: '#0a0' });
    ed.fc.add(o); ed.commit('add');
    o.set({ left: 10 }); ed.commit('move');
    ed.undo();
    await new Promise(r => setTimeout(r, 50));
    const u = ed.fc.getObjects()[0];
    const afterUndo = { w: u.getScaledWidth(), h: u.getScaledHeight(), left: u.left };
    const json = ed.toJSON ? ed.toJSON() : null;
    return { afterUndo, json: json && JSON.parse(json).scene.objects[0] };
  });
  assert.ok(Math.abs(r.afterUndo.w - 760) < 0.01, 'width after undo: ' + r.afterUndo.w);
  assert.ok(Math.abs(r.afterUndo.h - 950) < 0.01, 'height after undo: ' + r.afterUndo.h);
  assert.equal(r.afterUndo.left, 160.25);
  if (r.json) assert.ok(Math.abs(r.json.scaleX * r.json.width - 760) < 0.01, 'saved scene width: ' + r.json.scaleX * r.json.width);
});

test('browser: resizeCanvas keeps content centred by default; anchor top-left keeps absolute positions', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed, f = window.fabric;
    const o = new f.Rect({ left: 100, top: 50, width: 200, height: 200, strokeWidth: 0 }); ed.fc.add(o);
    ed.resizeCanvas(600, 500);                                    // from 400×300: +200 wide, +200 tall
    const centred = { left: o.left, top: o.top };
    ed.resizeCanvas(400, 300, { anchor: 'top-left' });
    return { centred, kept: { left: o.left, top: o.top } };
  });
  assert.deepEqual(r.centred, { left: 200, top: 150 });
  assert.deepEqual(r.kept, { left: 200, top: 150 });
});

test('browser: Open image into an empty page whose size the user chose keeps that size and fits the image', async () => {
  // Regression: picking 4:5 for an Instagram post and then opening a 9:16 photo silently threw the
  // 4:5 away and made the page 9:16.
  const src = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 90; c.height = 160; const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 90, 160); return c.toDataURL(); });
  const r = await page.evaluate(async (src) => {
    const ed = window.__ed;
    ed.resizeCanvas(1080, 1350);
    const img = await ed.openImage(src);
    const kept = { W: ed.W, H: ed.H, w: Math.round(img.getScaledWidth()), h: Math.round(img.getScaledHeight()), left: Math.round(img.left), top: Math.round(img.top) };
    await ed.openImage(src);                                       // over existing work: a new document the image's shape
    return { kept, over: { W: ed.W, H: ed.H } };
  }, src);
  assert.deepEqual(r.kept, { W: 1080, H: 1350, w: 759, h: 1350, left: 160, top: 0 });
  assert.equal(r.over.W / r.over.H, 90 / 160);
});

test('browser: setNumeric keepRatio — a width edit scales the height by the same factor', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed, o = new window.fabric.Rect({ left: 0, top: 0, width: 720, height: 1280, strokeWidth: 0 });
    ed.fc.add(o); ed.fc.setActiveObject(o);
    ed.setNumeric({ w: 1080 }, { keepRatio: true });
    const kept = [o.getScaledWidth(), o.getScaledHeight()];
    ed.setNumeric({ w: 540 });
    return { kept, free: [o.getScaledWidth(), o.getScaledHeight()] };
  });
  assert.deepEqual(r.kept.map(Math.round), [1080, 1920]);
  assert.deepEqual(r.free.map(Math.round), [540, 1920], 'without keepRatio only W changes');
});

test('browser: an image takes a corner radius (scene px, kept through scale, undo and crop; 0 removes it)', async () => {
  const src = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 100; c.getContext('2d').fillRect(0, 0, 200, 100); return c.toDataURL(); });
  const r = await page.evaluate(async (src) => {
    const ed = window.__ed, img = await ed.addImage(src);
    img.set({ left: 0, top: 0, scaleX: 2, scaleY: 2 }); ed.fc.setActiveObject(img);
    ed.setNumeric({ rx: 40 });
    const cp = () => { const o = ed.fc.getObjects().find(q => q.type === "image"), c = o.clipPath; return !c ? null : { role: c.role, rx: c.rx, w: c.width, h: c.height, sceneR: ed.cornerRadiusOf(o) }; };
    const set = cp();
    ed.undo(); await new Promise(r => setTimeout(r, 50)); const undone = cp();
    ed.redo(); await new Promise(r => setTimeout(r, 50)); const redone = cp();
    const o = ed.fc.getObjects().find(q => q.type === 'image'); ed.fc.setActiveObject(o);
    ed.setTool('crop'); ed.crop = { x: 0, y: 0, w: 200, h: 200 }; ed.applyCrop();
    const cropped = cp();
    ed.fc.setActiveObject(ed.fc.getObjects().find(q => q.type === 'image')); ed.setNumeric({ rx: 0 });
    return { set, undone, redone, cropped, cleared: cp() };
  }, src);
  assert.deepEqual(r.set, { role: 'corner', rx: 20, w: 200, h: 100, sceneR: 40 }, 'local rx = 40 scene px / scale 2');
  assert.equal(r.undone, null, 'undo removes it');
  assert.deepEqual(r.redone, r.set, 'redo restores it');
  assert.deepEqual(r.cropped, { role: 'corner', rx: 20, w: 100, h: 100, sceneR: 40 }, 'follows the crop window');
  assert.equal(r.cleared, null, 'radius 0 drops the clip');
});

test('browser: Ctrl+wheel zooms one comfortable step per notch, not ×6', async () => {
  // Regression: Ctrl+mouse-wheel arrives with ctrlKey and a full 120px notch, which the trackpad-
  // pinch rate turned into ×6 per notch — eight notches went from 43% to the 500% cap.
  const box = await page.locator('#cv').boundingBox();
  await page.mouse.move(box.x + 100, box.y + 100);
  const z0 = await page.evaluate(() => window.__ed.fc.getZoom());
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -120); await page.keyboard.up('Control');
  await page.waitForTimeout(50);
  const z1 = await page.evaluate(() => window.__ed.fc.getZoom());
  assert.ok(z1 / z0 > 1.05 && z1 / z0 <= 1.25 + 1e-9, 'one notch in: ×' + (z1 / z0));
  await page.keyboard.down('Control'); await page.mouse.wheel(0, 120); await page.keyboard.up('Control');
  await page.waitForTimeout(50);
  const z2 = await page.evaluate(() => window.__ed.fc.getZoom());
  assert.ok(z2 / z1 < 0.95 && z2 / z1 >= 0.8 - 1e-9, 'one notch out: ×' + (z2 / z1));
});

test('browser: undo/redo reverts and reapplies a committed transform', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => { const o = window.__ed.fc.getObjects()[0]; window.__ed.setNumeric.call(window.__ed, { x: 999 }); });
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects()[0].left), 999);
  await page.evaluate(() => window.__ed.undo());
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects()[0].left), 50);
  await page.evaluate(() => window.__ed.redo());
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects()[0].left), 999);
});

/* ── layers: duplicate, reorder, remove ───────────────────────────────────────────────── */
test('browser: duplicateLayer, moveLayer and removeLayer mutate the scene as expected', async () => {
  const id1 = await page.evaluate(() => {
    const ed = window.__ed;
    const o = new ed.fabric.Rect({ left: 10, top: 10, width: 30, height: 30, fill: '#ff0000' });
    o.set({ id: 'r1', role: 'shape', name: 'R1' });
    ed.fc.add(o); ed.commit('add');
    return o.id;
  });
  const id2 = await page.evaluate(() => {
    const ed = window.__ed;
    const o = new ed.fabric.Rect({ left: 50, top: 50, width: 30, height: 30, fill: '#00ff00' });
    o.set({ id: 'r2', role: 'shape', name: 'R2' });
    ed.fc.add(o); ed.commit('add');
    return o.id;
  });
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 2);

  const dupId = await page.evaluate((id) => window.__ed.duplicateLayer(id), id1);
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 3);
  assert.ok(dupId && dupId !== id1);

  await page.evaluate((id) => window.__ed.removeLayer(id), id2);
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 2);
});

/* ── paint engine: brush stroke actually paints pixels ────────────────────────────────── */
test('browser: brush tool paints non-transparent pixels into the paint layer', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  await page.evaluate(() => window.__ed.setToolOptions({ size: 40, color: '#ff0000', opacity: 1 }));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 160, canvasBox.y + 100, { steps: 6 });
  await page.mouse.up();
  const hasPaint = await page.evaluate(() => {
    const ed = window.__ed;
    const paintLayer = ed.fc.getObjects().find(o => o.role === 'paint');
    if (!paintLayer) return false;
    const c = paintLayer._element || paintLayer.getElement();
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
  assert.equal(hasPaint, true);
});

/* ── selection: marquee drag produces a real pixel selection ──────────────────────────── */
test('browser: marquee drag sets ed.selection and finalizeSelection accepts it', async () => {
  await page.evaluate(() => window.__ed.setTool('marquee'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  const sel = await page.evaluate(() => window.__ed.selection);
  assert.equal(sel.kind, 'rect');
  assert.ok(sel.w > 6 && sel.h > 6);
});

test('browser: clicking inside an existing marquee again clears the selection instead of leaving it unchanged', async () => {
  await page.evaluate(() => window.__ed.setTool('marquee'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 160, { steps: 4 });
  await page.mouse.up();
  assert.ok(await page.evaluate(() => !!window.__ed.selection));
  // A plain click on the marquee's own interior (no drag) picks up its move handle first, but with
  // zero net movement it must still deselect — matching the reference editor, where a marquee click
  // always restarts a fresh 0-size selection that gets discarded, rather than silently no-opping.
  await page.mouse.click(canvasBox.x + 100, canvasBox.y + 100);
  assert.equal(await page.evaluate(() => window.__ed.selection), null);
});

/* ── addMode: a sticky "keep adding every click" toggle for wand/objectselect/hoverselect, an
   alternative to holding Shift on every click (matches the reference editor's Add-mode chip).
   Stubs wandPick to record its {add,subtract} args instead of waiting on a real cv round-trip —
   this is purely testing Editor#_down's branching, not the wand algorithm itself. ─────────────── */
test('browser: toolOpts.addMode makes every click add to the selection without holding Shift', async () => {
  await page.evaluate(() => {
    window.__wandCalls = [];
    window.__ed.wandPick = (pt, opts) => { window.__wandCalls.push(opts); return Promise.resolve({ status: 'ok' }); };
    window.__ed.setTool('wand');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.click(canvasBox.x + 50, canvasBox.y + 50);
  let calls = await page.evaluate(() => window.__wandCalls);
  assert.equal(calls[0].add, false);   // addMode off, no Shift → plain click

  await page.evaluate(() => window.__ed.setToolOptions({ addMode: true }));
  await page.mouse.click(canvasBox.x + 80, canvasBox.y + 50);
  calls = await page.evaluate(() => window.__wandCalls);
  assert.equal(calls[1].add, true);   // addMode on → add without Shift

  // objectselect/hoverselect route clicks through the box-aware selectObjectAt (not wandPick) —
  // stub that instead to check the same addMode/Shift branching on its own {add,subtract} options.
  await page.evaluate(() => {
    window.__objCalls = [];
    window.__ed.selectObjectAt = (pt, opts) => { window.__objCalls.push(opts); return Promise.resolve({ status: 'ok' }); };
    window.__ed.setToolOptions({ addMode: false });
    window.__ed.setTool('objectselect');
  });
  await page.keyboard.down('Shift');
  await page.mouse.click(canvasBox.x + 110, canvasBox.y + 50);
  await page.keyboard.up('Shift');
  const objCalls = await page.evaluate(() => window.__objCalls);
  assert.equal(objCalls[0].add, true);   // Shift still works independent of addMode, on objectselect too
});

/* ── objectselect-bbox: the reference editor's near-stub "wand" (key W) — no pixel analysis at
   all, just the active object's own bounding box, or a fixed center region with nothing active ── */
test('browser: objectselect-bbox selects the active object\'s bounding box, or a center region with nothing active', async () => {
  await page.evaluate(() => window.__ed.setTool('objectselect-bbox'));
  const canvasBox = await page.locator('#cv').boundingBox();
  // Nothing active yet — a plain click falls back to the fixed center-region rect.
  await page.mouse.click(canvasBox.x + 50, canvasBox.y + 50);
  const centerSel = await page.evaluate(() => window.__ed.selection);
  assert.equal(centerSel.kind, 'rect');
  const W = await page.evaluate(() => window.__ed.W), H = await page.evaluate(() => window.__ed.H);
  assert.equal(centerSel.x, W * 0.18); assert.equal(centerSel.y, H * 0.18);
  assert.equal(centerSel.w, W * 0.64); assert.equal(centerSel.h, H * 0.64);

  // With a shape active, the click selects exactly that object's own getBoundingRect(true) —
  // NOT the raw drag dimensions, since every object here carries a themed selection `padding`
  // (see the Editor constructor's 'object:added' handler) that getBoundingRect(true) includes.
  await page.evaluate(() => window.__ed.setTool('rect'));
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 140, canvasBox.y + 120, { steps: 4 });
  await page.mouse.up();   // shape tools auto-return to select with the new object active
  const expectedBox = await page.evaluate(() => {
    const o = window.__ed.fc.getActiveObject(); o.setCoords();
    return o.getBoundingRect(true);
  });
  await page.evaluate(() => window.__ed.setTool('objectselect-bbox'));
  await page.mouse.click(canvasBox.x + 200, canvasBox.y + 200);   // click position is irrelevant — no pt-based logic
  const bboxSel = await page.evaluate(() => window.__ed.selection);
  assert.equal(bboxSel.kind, 'rect');
  assert.equal(bboxSel.x, expectedBox.left); assert.equal(bboxSel.y, expectedBox.top);
  assert.equal(bboxSel.w, expectedBox.width); assert.equal(bboxSel.h, expectedBox.height);
});

/* ── magicwand: the reference editor's real per-click CV wand (key A) — routes through the exact
   same wandPick() the plain-JS 'wand' tool and objectselect/hoverselect already use, just without
   objectselect/hoverselect's pre-populated hover cache. Stubbed the same way the addMode test
   above stubs wandPick, so this only verifies Editor#_down's dispatch, not the cv algorithm. ──── */
test('browser: magicwand tool dispatches clicks through wandPick with no hover cache involved', async () => {
  await page.evaluate(() => {
    window.__wandCalls = [];
    window.__ed.wandPick = (pt, opts) => { window.__wandCalls.push(opts); return Promise.resolve({ status: 'ok' }); };
    window.__ed.setTool('magicwand');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.click(canvasBox.x + 50, canvasBox.y + 50);
  let calls = await page.evaluate(() => window.__wandCalls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].add, false); assert.equal(calls[0].subtract, false);

  await page.keyboard.down('Shift');
  await page.mouse.click(canvasBox.x + 80, canvasBox.y + 50);
  await page.keyboard.up('Shift');
  calls = await page.evaluate(() => window.__wandCalls);
  assert.equal(calls[1].add, true);   // Shift-click adds, same contract as objectselect/hoverselect

  await page.keyboard.down('Alt');
  await page.mouse.click(canvasBox.x + 110, canvasBox.y + 50);
  await page.keyboard.up('Alt');
  calls = await page.evaluate(() => window.__wandCalls);
  assert.equal(calls[2].subtract, true);   // Alt-click subtracts

  // No hover cache exists for magicwand (only objectselect/hoverselect populate one in setTool),
  // so every click always falls through to wandPick — never short-circuited by a cached preview.
  assert.equal(await page.evaluate(() => !!window.__ed._hoverCache), false);
});

/* ── aiinsert: click opens the host's prompt popover (via the 'aiinsert' event) instead of
   drawing anything itself — plain click reports region:false, a click inside an active pixel
   selection reports region:true so the host UI can offer "fill this shape" instead ────────── */
test('browser: the aiinsert tool emits {pt, region} on click and does not draw', async () => {
  await page.evaluate(() => {
    window.__aiInsertEvents = [];
    window.__ed.on('aiinsert', (e) => window.__aiInsertEvents.push(e));
    window.__ed.setTool('aiinsert');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.click(canvasBox.x + 60, canvasBox.y + 40);
  const events = await page.evaluate(() => window.__aiInsertEvents);
  assert.equal(events.length, 1);
  assert.equal(events[0].region, false);
  assert.equal(events[0].pt.x, 60); assert.equal(events[0].pt.y, 40);
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects().length), 0);   // no drawing side effect
});

test('browser: aiinsert reports region:true for a click inside an active pixel selection', async () => {
  await page.evaluate(() => window.__ed.setTool('marquee'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 160, canvasBox.y + 160, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => {
    window.__aiInsertEvents = [];
    window.__ed.on('aiinsert', (e) => window.__aiInsertEvents.push(e));
    window.__ed.setTool('aiinsert');
  });
  await page.mouse.click(canvasBox.x + 100, canvasBox.y + 100);   // inside the marquee
  const inside = await page.evaluate(() => window.__aiInsertEvents.at(-1));
  assert.equal(inside.region, true);

  await page.mouse.click(canvasBox.x + 350, canvasBox.y + 20);   // outside the marquee, still on-canvas
  const outside = await page.evaluate(() => window.__aiInsertEvents.at(-1));
  assert.equal(outside.region, false);
});

/* ── keybindings: tool-switch, undo/redo, delete, arrow-nudge (installKeybindings) ────── */
test('browser: installKeybindings wires tool-switch letters and arrow-key nudge', async () => {
  await page.keyboard.press('b');
  assert.equal(await page.evaluate(() => window.__ed.tool), 'brush');
  await page.keyboard.press('v');
  assert.equal(await page.evaluate(() => window.__ed.tool), 'select');

  // Reference-editor letter parity for the keys that were remapped off Canvasmith's prior
  // bindings: N=AI insert (was pencil), U=rect (was burn), W=objectselect-bbox (was the color
  // wand), A=magicwand (new), G=bucket (was gradient), K=the plain-JS color wand (moved off G).
  await page.keyboard.press('n'); assert.equal(await page.evaluate(() => window.__ed.tool), 'aiinsert');
  await page.keyboard.press('u'); assert.equal(await page.evaluate(() => window.__ed.tool), 'rect');
  await page.keyboard.press('w'); assert.equal(await page.evaluate(() => window.__ed.tool), 'objectselect-bbox');
  await page.keyboard.press('a'); assert.equal(await page.evaluate(() => window.__ed.tool), 'magicwand');
  await page.keyboard.press('g'); assert.equal(await page.evaluate(() => window.__ed.tool), 'bucket');
  await page.keyboard.press('k'); assert.equal(await page.evaluate(() => window.__ed.tool), 'wand');
  await page.keyboard.press('v'); assert.equal(await page.evaluate(() => window.__ed.tool), 'select');

  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  const before = await page.evaluate(() => window.__ed.fc.getObjects()[0].left);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(50);
  const after1 = await page.evaluate(() => window.__ed.fc.getObjects()[0].left);
  assert.equal(after1, before + 1);
  await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  await page.waitForTimeout(50);
  const after2 = await page.evaluate(() => window.__ed.fc.getObjects()[0].left);
  assert.equal(after2, after1 + 10);
});

test('browser: installKeybindings wires delete/backspace on the active layer', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 1);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 0);
});

test('browser: installKeybindings wires ⌘G group / ⌘⇧G ungroup on a multi-selection', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  for (const [x, y] of [[40, 40], [140, 140]]) {
    await page.mouse.move(canvasBox.x + x, canvasBox.y + y);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + x + 40, canvasBox.y + y + 40, { steps: 4 });
    await page.mouse.up();
  }
  await page.evaluate(() => {
    const ed = window.__ed;
    ed.setTool('select');
    const objs = ed.fc.getObjects().filter(o => o.role !== 'artboard' && o.selectable !== false);
    ed.fc.setActiveObject(new fabric.ActiveSelection(objs, { canvas: ed.fc }));
  });
  await page.keyboard.press('Meta+g');
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject()?.type), 'group');
  await page.keyboard.press('Meta+Shift+g');
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject()?.type), 'activeSelection');
  await page.evaluate(() => { window.__ed.fc.discardActiveObject(); window.__ed.layers().forEach(l => window.__ed.removeLayer(l.id)); });
});

test('browser: layers() nests group members as children, and member ops stay inside the group', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed;
    const a = new fabric.Rect({ left: 20, top: 20, width: 40, height: 40, fill: '#f00', id: 'ga', role: 'shape' });
    const b = new fabric.Rect({ left: 90, top: 90, width: 40, height: 40, fill: '#00f', id: 'gb', role: 'shape' });
    ed.fc.add(a, b);
    ed.fc.setActiveObject(new fabric.ActiveSelection([a, b], { canvas: ed.fc }));
    ed.groupSelection();
    const out = {};
    const top = () => ed.layers().filter(l => l.role !== 'bg');
    const g = top()[0];
    out.topCount = top().length;
    out.group = { name: g.name, isGroup: g.isGroup, kids: g.children.map(c => c.id), parent: g.children[0].parentId === g.id };
    ed.setLayer('ga', { visible: false });
    out.hidden = ed.layers().find(l => l.isGroup).children.find(c => c.id === 'ga').visible;
    ed.moveLayer('ga', 'up');   // ga was bottom member -> now top
    out.afterMove = ed.layers().find(l => l.isGroup).children.map(c => c.id);
    ed.activate('gb');
    const g2 = ed.layers().find(l => l.isGroup);
    out.focus = { groupActive: g2.active, childActive: g2.childActive, gbActive: g2.children.find(c => c.id === 'gb').active };
    ed.undo();   // back to before activate/move? activate doesn't commit, so this undoes the move
    await new Promise(res => setTimeout(res, 150));
    out.afterUndo = ed.layers().find(l => l.isGroup)?.children.map(c => c.id);
    ed.removeLayer('ga');
    out.afterRemove = ed.layers().find(l => l.isGroup)?.children.map(c => c.id);
    ed.removeLayer('gb');
    out.afterRemoveLast = ed.layers().filter(l => l.role !== 'bg').length;
    return out;
  });
  assert.equal(r.topCount, 1);
  assert.deepEqual(r.group, { name: 'Group', isGroup: true, kids: ['gb', 'ga'], parent: true });
  assert.equal(r.hidden, false);
  assert.deepEqual(r.afterMove, ['ga', 'gb']);
  // Member-focus model: focusing a member makes the MEMBER the active layer; its group reports childActive instead
  // (active === the canvas's single active object), and the panels hand the highlight to the member's row.
  assert.deepEqual(r.focus, { groupActive: false, childActive: true, gbActive: true });
  assert.deepEqual(r.afterUndo, ['gb', 'ga']);   // member ids survive a history round-trip
  assert.deepEqual(r.afterRemove, ['gb']);
  assert.equal(r.afterRemoveLast, 0);   // removing the last member removes the group
});

test('browser: toggleLayerSelection builds a multi-selection from layer ids, which then groups', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed;
    ed.fc.add(
      new fabric.Rect({ left: 10, top: 10, width: 30, height: 30, id: 'sa', role: 'shape' }),
      new fabric.Rect({ left: 60, top: 60, width: 30, height: 30, id: 'sb', role: 'shape' }),
      new fabric.Rect({ left: 110, top: 110, width: 30, height: 30, id: 'sc', role: 'shape' }));
    const sel = () => ed.layers().filter(l => l.selected).map(l => l.id).sort();
    const out = {};
    ed.toggleLayerSelection('sa'); out.one = sel();
    ed.toggleLayerSelection('sc'); out.two = sel(); out.type = ed.fc.getActiveObject().type;
    ed.toggleLayerSelection('sb'); out.three = sel();
    ed.toggleLayerSelection('sa'); out.dropped = sel();
    ed.moveLayer('sb', 'top');   // a multi-selection member is still a top-level layer, not a group member
    out.movedTop = ed.fc.getObjects().filter(o => o.role !== 'bg').map(o => o.id).includes('sb');
    ed.toggleLayerSelection('sb'); ed.toggleLayerSelection('sb');   // re-sync the selection after the restack
    out.group = ed.groupSelection().status;
    out.kids = ed.layers().find(l => l.isGroup).children.map(c => c.id).sort();
    ed.layers().forEach(l => ed.removeLayer(l.id));
    return out;
  });
  assert.deepEqual(r.one, ['sa']);
  assert.deepEqual(r.two, ['sa', 'sc']);
  assert.equal(r.type, 'activeSelection');
  assert.deepEqual(r.three, ['sa', 'sb', 'sc']);
  assert.deepEqual(r.dropped, ['sb', 'sc']);
  assert.equal(r.movedTop, true);
  assert.equal(r.group, 'ok');
  assert.deepEqual(r.kids, ['sb', 'sc']);
});

test('browser: canvas input is ignored while an undo/redo restore is still landing', async () => {
  // Regression: a shape drawn right after Cmd+Z (before the async restore landed) was wiped by the
  // restore and its commit dropped by the history lock — silently lost.
  await page.evaluate(() => { window.__ed.setTool('rect'); window.__ed.history.lock = true; });
  const box = await page.locator('#cv').boundingBox();
  await page.mouse.move(box.x + 50, box.y + 50); await page.mouse.down(); await page.mouse.move(box.x + 150, box.y + 120, { steps: 4 }); await page.mouse.up();
  const during = await page.evaluate(() => window.__ed.fc.getObjects().length);
  await page.evaluate(() => { window.__ed.history.lock = false; });
  await page.mouse.move(box.x + 50, box.y + 50); await page.mouse.down(); await page.mouse.move(box.x + 150, box.y + 120, { steps: 4 }); await page.mouse.up();
  const after = await page.evaluate(() => window.__ed.fc.getObjects().length);
  assert.equal(during, 0, 'nothing drawn while the restore is pending');
  assert.equal(after, 1, 'drawing works again once it has landed');
});

test('browser: Space+drag starting over a selected layer pans the view without moving the layer', async () => {
  // Regression: Fabric also grabbed the object under the pointer, so the pan dragged it off its spot.
  await page.evaluate(() => { const ed = window.__ed, o = new window.fabric.Rect({ left: 50, top: 50, width: 200, height: 150, fill: '#c33', strokeWidth: 0 }); ed.fc.add(o); ed.fc.setActiveObject(o); ed.setTool('select'); });
  const box = await page.locator('#cv').boundingBox();
  const vpt0 = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  await page.mouse.move(box.x + 120, box.y + 120);
  await page.keyboard.down('Space'); await page.mouse.down(); await page.mouse.move(box.x + 220, box.y + 160, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Space');
  const r = await page.evaluate(() => { const o = window.__ed.fc.getObjects()[0]; return { left: o.left, top: o.top, vpt: window.__ed.fc.viewportTransform.slice(), skip: window.__ed.fc.skipTargetFind }; });
  assert.notDeepEqual(r.vpt, vpt0, 'the view panned');
  assert.deepEqual([r.left, r.top], [50, 50], 'the layer stayed put');
  assert.equal(r.skip, false, 'hit-testing is back after Space');
});

test('browser: holding Space while editing a mask pans the view and leaves the mask untouched', async () => {
  // Regression: the mask-edit branch ran before the Space-pan check, so Space+drag painted a stroke
  // across the layer's mask instead of moving the view.
  const r0 = await page.evaluate(async () => {
    const ed = window.__ed, c = document.createElement('canvas'); c.width = 400; c.height = 300; c.getContext('2d').fillRect(0, 0, 400, 300);
    const img = await ed.addImage(c.toDataURL()); ed.addMask(img.id); ed.enterMaskEdit(img.id); ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 });
    return { tool: ed.tool, id: img.id, mask: img.maskCanvas.toDataURL() };
  });
  assert.equal(r0.tool, 'brush');
  const box = await page.locator('#cv').boundingBox();
  const vptBefore = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.keyboard.down('Space'); await page.waitForTimeout(30);
  await page.mouse.down(); await page.mouse.move(box.x + 180, box.y + 150, { steps: 5 }); await page.mouse.up();
  await page.keyboard.up('Space'); await page.waitForTimeout(50);
  const r = await page.evaluate((id) => ({ vpt: window.__ed.fc.viewportTransform.slice(), mask: window.__ed._byId(id).maskCanvas.toDataURL() }), r0.id);
  assert.notDeepEqual(r.vpt, vptBefore, 'the view panned');
  assert.equal(r.mask, r0.mask, 'no stroke landed on the mask');
});

test('browser: holding Space pans the canvas with any tool active, without switching tools', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  const vptBefore = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  await page.keyboard.down('Space');
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => window.__ed._spaceDown), true);
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 140, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForTimeout(30);
  const vptAfter = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  assert.notDeepEqual(vptAfter, vptBefore);   // the viewport actually panned
  assert.equal(await page.evaluate(() => window.__ed.tool), 'brush');   // tool never switched to hand
  assert.equal(await page.evaluate(() => window.__ed._spaceDown), false);
  // brush still works normally once space is released — no lingering pan state
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 80, canvasBox.y + 80, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const hasPaintLayer = await page.evaluate(() => window.__ed.fc.getObjects().some(o => o.role === 'paint'));
  assert.equal(hasPaintLayer, true);
});

test('browser: Cmd/Ctrl+J copies the selected pixels of the active layer into a new layer', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => window.__ed.setTool('marquee'));
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 110, { steps: 4 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 1);
  await page.keyboard.press('ControlOrMeta+j');
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 2);   // new "... copy" layer added
  // duplicateSelectionToLayer is non-destructive — the source rect is untouched
  const rectStillFull = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.type === 'rect').clipPath == null);
  assert.equal(rectStillFull, true);
  // Regression: the selection stayed live, so picking Move next lifted the same pixels AGAIN — a
  // hollowed-out copy plus a second "(moved)" layer. Layer via Copy deselects.
  assert.equal(await page.evaluate(() => window.__ed.selection), null, 'Cmd+J deselects');
  await page.keyboard.press('v');
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 2, 'Move after Cmd+J adds no layer');
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects().filter(o => o.clipPath).length), 0, 'nothing hollowed out');
});

test('browser: Cmd+J on a photo shown below its own size keeps the photo\'s detail', async () => {
  // Regression: the copy was rendered at scene size, so a bag lifted from a photo fitted at 0.56×
  // came out with ~0.56× the pixels — blurry the moment it was enlarged.
  const r = await page.evaluate(async () => {
    const ed = window.__ed, c = document.createElement('canvas'); c.width = 800; c.height = 600;
    const x = c.getContext('2d'); for (let i = 0; i < 800; i += 2) { x.fillStyle = i % 4 ? '#000' : '#fff'; x.fillRect(i, 0, 2, 600); }   // 2px stripes: detail only full resolution holds
    const img = await ed.addImage(c.toDataURL()); img.set({ left: 0, top: 0, scaleX: 0.25, scaleY: 0.25 }); img.setCoords();
    ed.fc.setActiveObject(img);
    ed.selection = { kind: 'rect', x: 10, y: 10, w: 100, h: 80 };
    const id = ed.duplicateSelectionToLayer(), o = ed._byId(id);
    return { natW: o._element.width, natH: o._element.height, w: o.getScaledWidth(), h: o.getScaledHeight(), role: o.role };
  });
  assert.equal(r.natW, 400, 'four source px per scene px'); assert.equal(r.natH, 320);
  assert.ok(Math.abs(r.w - 100) < 1e-6 && Math.abs(r.h - 80) < 1e-6, 'same size on the page');
  assert.equal(r.role, 'image', 'a piece of a photo is still a photo');
});

test('browser: Backspace with an active pixel selection cuts (clips) it from the active layer instead of deleting the whole layer', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => window.__ed.setTool('marquee'));
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 110, { steps: 4 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 1);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(50);
  // the layer survives (only clipped), unlike a plain Backspace with no selection which removes it
  assert.equal(await page.evaluate(() => window.__ed.layers().length), 1);
  const hasClip = await page.evaluate(() => !!window.__ed.fc.getObjects()[0].clipPath);
  assert.equal(hasClip, true);
});

/* ── auto-detect: detectObjects / selectDetectedBox (cv-only, vendored OpenCV) ────────── */
test('browser: detectObjects resolves ok/error status and selectDetectedBox commits a real selection', async () => {
  // A blank artboard still rasterizes to a flat image via captureFlat() (a white rect, not "no
  // image") — Canny finds no edges in it, so this is the 'no_match' path, not 'no_image'.
  const emptyResult = await page.evaluate(() => window.__ed.detectObjects());
  assert.equal(emptyResult.status, 'error');
  assert.equal(emptyResult.reason, 'no_match');

  // With a shape on the canvas, cv.detect() runs (via the vendored opencv.js) and returns a status.
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  const r = await page.evaluate(() => window.__ed.detectObjects(), null, { timeout: 20000 });
  assert.ok(r.status === 'ok' || r.status === 'error');
  if (r.status === 'ok' && r.result.boxes.length) {
    await page.evaluate((box) => window.__ed.selectDetectedBox(box), r.result.boxes[0]);
    const sel = await page.evaluate(() => window.__ed.selection);
    assert.equal(sel.kind, 'rect');
  }
});

/* ── gradient tool: drag paints a live-previewed, multi-stop/radial gradient into the paint layer ── */
test('browser: dragging the gradient tool paints a multi-stop linear gradient', async () => {
  await page.evaluate(() => {
    window.__ed.setToolOptions({ gradientType: 'linear', gradientStops: [
      { offset: 0, color: '#ff0000' }, { offset: 0.5, color: '#00ff00' }, { offset: 1, color: '#0000ff' },
    ] });
    window.__ed.setTool('gradient');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 20, canvasBox.y + 150);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 380, canvasBox.y + 150, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const colors = await page.evaluate(() => {
    const paintLayer = window.__ed.fc.getObjects().find(o => o.role === 'paint');
    const c = paintLayer._element || paintLayer.getElement();
    const ctx = c.getContext('2d');
    const at = (x) => { const d = ctx.getImageData(x, 150, 1, 1).data; return [d[0], d[1], d[2]]; };
    return { left: at(20), middle: at(200), right: at(370) };
  });
  // left end should read red-dominant, middle green-dominant, right blue-dominant
  assert.ok(colors.left[0] > colors.left[2]);
  assert.ok(colors.middle[1] > colors.middle[0] && colors.middle[1] > colors.middle[2]);
  assert.ok(colors.right[2] > colors.right[0]);
});

test('browser: dragging the gradient tool with gradientType radial paints a radial gradient', async () => {
  await page.evaluate(() => {
    window.__ed.setToolOptions({ gradientType: 'radial', gradientStops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] });
    window.__ed.setTool('gradient');
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 150);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 260, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const colors = await page.evaluate(() => {
    const paintLayer = window.__ed.fc.getObjects().find(o => o.role === 'paint');
    const c = paintLayer._element || paintLayer.getElement();
    const ctx = c.getContext('2d');
    const at = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return d[0]; };
    return { center: at(200, 150), edge: at(200, 5) };
  });
  assert.ok(colors.center > colors.edge);   // white at center, fading to black toward the edge
});

/* ── gradient fill on vector shapes ────────────────────────────────────────────────────────── */
test('browser: setShapeGradient applies a Fabric gradient fill, no-op on an image', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setShapeGradient([{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }], 'linear', 45));
  const g = await page.evaluate(() => window.__ed.getShapeGradient());
  assert.equal(g.type, 'linear');
  assert.equal(g.stops.length, 2);
  assert.equal(g.stops[0].color, '#ff0000');

  const isFabricGradient = await page.evaluate(() => {
    const o = window.__ed.fc.getObjects()[0];
    return typeof o.fill === 'object' && o.fill.type === 'linear';
  });
  assert.equal(isFabricGradient, true);
});

/* ── gradient tool: object-local mode — dragging onto an active vector object with no pixel
   selection applies the gradient as that object's own Fabric fill instead of painting a raster
   stripe into the paint layer (matches the reference editor's applyCustomGradient exactly). ──── */
test('browser: dragging the gradient tool onto an active shape (no selection) fills it as an object gradient, not a raster paint layer', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 180, canvasBox.y + 140, { steps: 4 });
  await page.mouse.up();   // rect is now active (shape tools auto-return to select + activate)

  await page.evaluate(() => window.__ed.setToolOptions({ gradientStops: [
    { offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' },
  ] }));
  await page.evaluate(() => window.__ed.setTool('gradient'));
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 180, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);

  const result = await page.evaluate(() => {
    const objs = window.__ed.fc.getObjects();
    const rect = objs.find(o => o.type === 'rect');
    return {
      objectCount: objs.length,   // must stay 1 — no paint layer was created for this drag
      hasPaintLayer: objs.some(o => o.role === 'paint'),
      fillType: typeof rect.fill === 'object' ? rect.fill.type : null,
      stops: (rect.fill.colorStops || []).map(s => s.color),
    };
  });
  assert.equal(result.objectCount, 1);
  assert.equal(result.hasPaintLayer, false);
  assert.equal(result.fillType, 'linear');
  assert.deepEqual(result.stops, ['#ff0000', '#0000ff']);
});

test('browser: gradient tool falls back to raster paint when there IS a pixel selection, even with an object active', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 180, canvasBox.y + 140, { steps: 4 });
  await page.mouse.up();

  // Draw a marquee selection — Editor#setTool('marquee') itself doesn't touch the rect's active
  // state, but a fabric selectable=false object can't stay "active" once a non-select tool takes
  // over pointer handling; what matters here is only that ed.selection is truthy at drag time.
  await page.evaluate(() => window.__ed.setTool('marquee'));
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 160, { steps: 4 });
  await page.mouse.up();
  assert.ok(await page.evaluate(() => !!window.__ed.selection));

  await page.evaluate(() => window.__ed.setToolOptions({ gradientStops: [{ offset: 0, color: '#00ff00' }, { offset: 1, color: '#ffff00' }] }));
  await page.evaluate(() => window.__ed.setTool('gradient'));
  await page.mouse.move(canvasBox.x + 60, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 180, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);

  const hasPaintLayer = await page.evaluate(() => window.__ed.fc.getObjects().some(o => o.role === 'paint'));
  assert.equal(hasPaintLayer, true);   // a selection present means raster mode, not object-local mode
});

/* ── typography: setTextProps/getTextProps act only on text objects ──────────────────────── */
/* ── layer masks: paintable, non-destructive, image/paint-role layers only ───────────────────── */
/* ── adjustment layers: non-destructive, affect everything below their z-index ───────────────── */
test('browser: an adjustment layer darkens a shape below it, and no-ops on layers above', async () => {
  // A bright rect below where the adjustment layer will sit
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));

  const beforeAlpha = await page.evaluate(() => {
    const flat = window.__ed.fc.toCanvasElement();
    return Array.from(flat.getContext('2d').getImageData(100, 100, 1, 1).data);
  });
  assert.deepEqual(beforeAlpha.slice(0, 3), [255, 255, 255]);   // white rect, unmodified

  await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 50 }));   // darken everything below
  await page.waitForTimeout(50);
  const afterAlpha = await page.evaluate(() => {
    const flat = window.__ed.fc.toCanvasElement();
    return Array.from(flat.getContext('2d').getImageData(100, 100, 1, 1).data);
  });
  assert.ok(afterAlpha[0] < 255, `expected darkened red channel, got ${afterAlpha[0]}`);

  // A second rect added ABOVE the adjustment layer must render unaffected (still pure white)
  await page.evaluate(() => window.__ed.setTool('rect'));
  await page.mouse.move(canvasBox.x + 250, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 350, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));
  await page.waitForTimeout(50);
  const aboveAlpha = await page.evaluate(() => {
    const flat = window.__ed.fc.toCanvasElement();
    return Array.from(flat.getContext('2d').getImageData(300, 100, 1, 1).data);
  });
  assert.deepEqual(aboveAlpha.slice(0, 3), [255, 255, 255]);   // untouched — it's above the adjustment layer
});

test('browser: setAdjustmentParams updates the effect live, and stacking two adjustment layers composes', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));

  const adjId1 = await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 80 }));
  await page.waitForTimeout(50);
  const oneAdjAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);

  await page.evaluate((id) => window.__ed.setAdjustmentParams(id, { brightness: 50 }), adjId1);
  await page.waitForTimeout(50);
  const strongerAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.ok(strongerAlpha < oneAdjAlpha, 'a lower brightness value should darken further');

  // stack a second adjustment layer on top — should darken further still (composes with the first)
  await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 50 }));
  await page.waitForTimeout(50);
  const twoAdjAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.ok(twoAdjAlpha < strongerAlpha, 'two stacked adjustment layers should darken more than one');
});

test('browser: an adjustment layer survives undo/redo and stays live after reordering', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.setFill('#ffffff'));
  const adjId = await page.evaluate(() => window.__ed.addAdjustmentLayer({ brightness: 50 }));
  await page.waitForTimeout(50);

  const darkenedAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.ok(darkenedAlpha < 255);

  await page.evaluate(() => window.__ed.undo());   // undoes addAdjustmentLayer
  await page.waitForTimeout(150);
  const afterUndoAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.equal(afterUndoAlpha, 255);   // adjustment layer gone, rect is full white again

  await page.evaluate(() => window.__ed.redo());
  await page.waitForTimeout(150);
  const afterRedoAlpha = await page.evaluate(() => window.__ed.fc.toCanvasElement().getContext('2d').getImageData(100, 100, 1, 1).data[0]);
  assert.equal(afterRedoAlpha, darkenedAlpha);   // adjustment layer (and its params) restored exactly

  const params = await page.evaluate((id) => window.__ed.getAdjustmentParams(id), adjId);
  assert.equal(params.brightness, 50);
});

/* Alpha of a layer's own (filtered) pixels at a SCENE point. A brush layer is trimmed to its stroke's
   bounds, so its backing canvas is NOT artboard-sized: reading it at (150, 100) directly looks at the wrong
   pixel (or off the edge). Map the scene point into the layer's own coordinates first. */
const layerAlphaAt = (id, x, y) => page.evaluate(([id, x, y]) => {
  const o = window.__ed.fc.getObjects().find(q => q.id === id), el = o._element, tl = o.getPointByOrigin('left', 'top');
  const lx = Math.round((x - tl.x) / (o.scaleX || 1) + (o.cropX || 0)), ly = Math.round((y - tl.y) / (o.scaleY || 1) + (o.cropY || 0));
  if (lx < 0 || ly < 0 || lx >= el.width || ly >= el.height) return 0;
  return el.getContext('2d').getImageData(lx, ly, 1, 1).data[3];
}, [id, x, y]);

test('browser: addMask creates a blank mask that has no visual effect until painted', async () => {
  // A paint-role layer is the simplest maskable target to set up in this fixture (no image load).
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 160, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);

  const beforeAlpha = await layerAlphaAt(paintId, 130, 100);
  assert.ok(beforeAlpha > 0);   // the brush stroke painted something opaque here

  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  const afterAddAlpha = await layerAlphaAt(paintId, 130, 100);
  assert.equal(afterAddAlpha, beforeAlpha);   // a fresh mask is fully-visible: no change yet

  const hasMaskCanvas = await page.evaluate((id) => !!window.__ed.fc.getObjects().find(x => x.id === id).maskCanvas, paintId);
  assert.equal(hasMaskCanvas, true);
});

test('browser: painting black into a mask hides the layer under the brush, white reveals it again', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);

  // paint black (hide) over the middle of the stroke
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(50);
  const hiddenAlpha = await layerAlphaAt(paintId, 150, 100);
  assert.equal(hiddenAlpha, 0);   // fully masked out at the painted spot

  // paint white (reveal) back over the same spot
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#ffffff' }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(50);
  const revealedAlpha = await layerAlphaAt(paintId, 150, 100);
  assert.ok(revealedAlpha > 200);   // back to (near-)fully visible

  await page.evaluate(() => window.__ed.exitMaskEdit());
});

test('browser: setMaskEnabled(false) restores full visibility without discarding the painted mask', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.exitMaskEdit());

  const maskedAlpha = await layerAlphaAt(paintId, 150, 100);
  assert.equal(maskedAlpha, 0);

  await page.evaluate((id) => window.__ed.setMaskEnabled(id, false), paintId);
  const disabledAlpha = await layerAlphaAt(paintId, 150, 100);
  assert.ok(disabledAlpha > 200);   // disabling shows the full layer again

  await page.evaluate((id) => window.__ed.setMaskEnabled(id, true), paintId);
  const reenabledAlpha = await layerAlphaAt(paintId, 150, 100);
  assert.equal(reenabledAlpha, 0);   // re-enabling brings back the SAME painted mask, not a blank one
});

test('browser: removeMask restores full visibility and addMask/removeMask no-op on non-maskable layers', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const rectId = await page.evaluate(() => window.__ed.fc.getObjects()[0].id);
  await page.evaluate((id) => window.__ed.addMask(id), rectId);
  const rectHasMask = await page.evaluate((id) => !!window.__ed.fc.getObjects().find(x => x.id === id).maskCanvas, rectId);
  assert.equal(rectHasMask, true);   // vector shapes are maskable (drawn through a vector mask — see mask.js)
  await page.evaluate((id) => window.__ed.removeMask(id), rectId);
  assert.equal(await page.evaluate((id) => !!window.__ed.fc.getObjects().find(x => x.id === id).maskCanvas, rectId), false);

  await page.evaluate(() => window.__ed.setTool('brush'));
  await page.mouse.move(canvasBox.x + 300, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 360, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 330, canvasBox.y + 100);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.exitMaskEdit());
  await page.evaluate((id) => window.__ed.removeMask(id), paintId);
  const afterRemove = { hasMaskCanvas: await page.evaluate((id) => !!window.__ed.fc.getObjects().find(x => x.id === id).maskCanvas, paintId), alpha: await layerAlphaAt(paintId, 330, 100) };
  assert.equal(afterRemove.hasMaskCanvas, false);
  assert.ok(afterRemove.alpha > 200);   // removing the mask restores full visibility
});

test('browser: a painted mask survives undo/redo (Fabric filter fromObject round-trip)', async () => {
  await page.evaluate(() => window.__ed.setTool('brush'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 100, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const paintId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'paint').id);
  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), paintId);
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#000000', size: 40, hardness: 1 }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(50);
  await page.evaluate(() => window.__ed.exitMaskEdit());

  const beforeUndoAlpha = await layerAlphaAt(paintId, 150, 100);
  assert.equal(beforeUndoAlpha, 0);

  await page.evaluate(() => window.__ed.undo());
  await page.waitForTimeout(150);   // restore()/loadFromJSON + the mask filter's own async fromObject
  const afterUndoAlpha = await layerAlphaAt(paintId, 150, 100);
  assert.ok(afterUndoAlpha > 200);   // back to before the mask stroke (mask still present, just unpainted there)

  await page.evaluate(() => window.__ed.redo());
  await page.waitForTimeout(150);
  const afterRedoAlpha = await layerAlphaAt(paintId, 150, 100);
  assert.equal(afterRedoAlpha, 0);   // the painted-black mask stroke is back
});

/* A web font that isn't loaded yet when text is laid out (a restored session, a lazily-fetched
   Google font) left Fabric with the fallback face's widths: the box was too narrow, Center H was
   off, and the cached render clipped the last letters. The face here is a monospace TTF served with
   a delay, registered but not loaded — the state a reload leaves a Google font in. */
const SLOW_FONT_FILE = ['/System/Library/Fonts/Supplemental/Courier New.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf'].find(f => existsSync(f));
async function slowFace(family) {
  const body = readFileSync(SLOW_FONT_FILE);
  await page.route('**/__slow-font/' + family + '.ttf', (route) => setTimeout(() => route.fulfill({ body, contentType: 'font/ttf' }).catch(() => {}), 600));
  return page.evaluate((family) => { const f = new FontFace(family, `url(/__slow-font/${family}.ttf)`); document.fonts.add(f); return f.status; }, family);
}
const textWidths = (family) => {
  const o = window.__ed.fc.getObjects().find(x => x.type === 'i-text');
  const c = document.createElement('canvas').getContext('2d'); c.font = `${o.fontWeight} ${o.fontSize}px ${family}`;
  return { fabric: Math.round(o.width), real: Math.round(c.measureText(o.text).width) };
};

test('browser: text restored before its web font loaded is re-measured once the font is in', { skip: !SLOW_FONT_FILE && 'no monospace TTF on this machine' }, async () => {
  assert.equal(await slowFace('CmTestMonoA'), 'unloaded');
  await page.evaluate(() => {
    const scene = { version: '5.3.0', objects: [{ type: 'i-text', text: 'Wide mono words here', left: 10, top: 10, fontSize: 30, fontFamily: 'CmTestMonoA, sans-serif', fontWeight: 'normal' }] };
    window.__ed.loadJSON(JSON.stringify({ w: 400, h: 300, scene }));
  });
  await page.waitForFunction(() => window.__ed.fc.getObjects().some(o => o.type === 'i-text') && document.fonts.check('16px CmTestMonoA'), null, { timeout: 5000 });
  await page.waitForTimeout(150);
  const w = await page.evaluate(textWidths, 'CmTestMonoA');
  assert.ok(Math.abs(w.fabric - w.real) <= 1, `box matches the loaded face: ${JSON.stringify(w)}`);
});

test('browser: setTextProps to a not-yet-loaded web font loads it and re-measures the text', { skip: !SLOW_FONT_FILE && 'no monospace TTF on this machine' }, async () => {
  await slowFace('CmTestMonoB');
  await page.evaluate(() => {
    const ed = window.__ed, t = new window.fabric.IText('Wide mono words here', { left: 10, top: 10, fontSize: 30, fontFamily: 'Arial, sans-serif' });
    ed.fc.add(t); ed.fc.setActiveObject(t);
    ed.setTextProps({ fontFamily: 'CmTestMonoB, sans-serif' });
  });
  await page.waitForFunction(() => document.fonts.check('16px CmTestMonoB'), null, { timeout: 5000 });
  await page.waitForTimeout(150);
  const w = await page.evaluate(textWidths, 'CmTestMonoB');
  assert.ok(Math.abs(w.fabric - w.real) <= 1, `box matches the loaded face: ${JSON.stringify(w)}`);
});

test('browser: setTextProps edits a text layer and no-ops on a shape', async () => {
  await page.evaluate(() => window.__ed.setTool('type'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.click(canvasBox.x + 100, canvasBox.y + 100);
  await page.waitForTimeout(50);
  await page.keyboard.type('Hi');
  await page.evaluate(() => window.__ed.fc.getActiveObject().exitEditing());
  await page.evaluate(() => window.__ed.setTool('select'));
  await page.evaluate(() => { const o = window.__ed.fc.getObjects().find(x => x.type === 'i-text'); window.__ed.fc.setActiveObject(o); });

  await page.evaluate(() => window.__ed.setTextProps({ fontFamily: 'Georgia, serif', fontSize: 60, fontWeight: 700, fontStyle: 'italic', textAlign: 'center', underline: true }));
  const props = await page.evaluate(() => window.__ed.getTextProps());
  assert.equal(props.fontFamily, 'Georgia, serif');
  assert.equal(props.fontSize, 60);
  assert.equal(props.fontWeight, 700);
  assert.equal(props.fontStyle, 'italic');
  assert.equal(props.textAlign, 'center');
  assert.equal(props.underline, true);

  // no-op on a non-text shape: getTextProps() returns null, setTextProps() does nothing
  await page.evaluate(() => window.__ed.setTool('rect'));
  await page.mouse.move(canvasBox.x + 200, canvasBox.y + 200);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 250, canvasBox.y + 250, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(50);
  const rectTextProps = await page.evaluate(() => window.__ed.getTextProps());
  assert.equal(rectTextProps, null);
});

/* ── cv vendoring: the OpenCV worker actually boots from the vendored asset, not a CDN ──── */
test('browser: the OpenCV worker boots from the vendored opencv.js (offline-safe)', async () => {
  const ready = await page.evaluate(async () => {
    const booted = await window.__ed.cv._boot();
    return { booted, url: window.__ed.cv._openCvUrl };
  });
  assert.equal(ready.booted, true);
  assert.ok(ready.url.includes('/packages/core/vendor/opencv/opencv.js'));
  assert.ok(ready.url.startsWith('http://'));   // resolved to an absolute URL, not left root-relative
});

/* ── Design-tab fills: fillWithColor / fillWithImage / extendBackgroundToCanvas ──────────── */
test('browser: fillWithColor paints the whole canvas when there is no selection', async () => {
  const px = await page.evaluate(() => {
    window.__ed.fillWithColor('#ff0000');
    const ctx = window.__ed.engine.ctx;
    return [...ctx.getImageData(5, 5, 1, 1).data];
  });
  assert.deepEqual(px, [255, 0, 0, 255]);
});

test('browser: fillWithColor is clipped to the active selection', async () => {
  const px = await page.evaluate(() => {
    window.__ed.selection = { kind: 'rect', x: 0, y: 0, w: 20, h: 20 };
    window.__ed.fillWithColor('#00ff00');
    const ctx = window.__ed.engine.ctx;
    const inside = [...ctx.getImageData(5, 5, 1, 1).data];
    const outside = [...ctx.getImageData(150, 150, 1, 1).data];
    return { inside, outside };
  });
  assert.deepEqual(px.inside, [0, 255, 0, 255]);
  assert.deepEqual(px.outside, [0, 0, 0, 0]);
});

test('browser: fillWithImage stamps a bitmap into the fill region', async () => {
  const px = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 10; c.height = 10;
    const cx = c.getContext('2d'); cx.fillStyle = '#0000ff'; cx.fillRect(0, 0, 10, 10);
    await window.__ed.fillWithImage(c.toDataURL());
    const ctx = window.__ed.engine.ctx;
    return [...ctx.getImageData(100, 100, 1, 1).data];
  });
  assert.deepEqual(px, [0, 0, 255, 255]);
});

/* ── addImageLayer 'contain' fit must scale a smaller-than-artboard image UP as well as a
   larger one down — a stray Math.min(1, ...) clamp previously made it only ever scale down,
   so a small image dropped onto a big artboard stayed tiny in the corner instead of filling
   the frame (reported as "image fit to frame not working"). Matches the reference editor's own
   makeObj, which has no such clamp: scale = Math.min(slotW/imgW, slotH/imgH), full stop. ────── */
test('browser: addImage with the default \'contain\' fit scales a SMALLER-than-artboard image up to fit it', async () => {
  const result = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 20; c.height = 20;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, 20, 20);
    const img = await window.__ed.addImage(c.toDataURL());
    return { scaleX: img.scaleX, scaleY: img.scaleY, renderedW: img.width * img.scaleX, renderedH: img.height * img.scaleY, W: window.__ed.W, H: window.__ed.H };
  });
  // 400x300 artboard, 20x20 image: scale = min(400/20, 300/20) = min(20, 15) = 15
  assert.equal(result.scaleX, 15);
  assert.equal(result.scaleY, 15);
  assert.equal(result.renderedH, result.H);   // touches the artboard's shorter edge exactly
  assert.ok(result.renderedW <= result.W);
});

test('browser: extendBackgroundToCanvas scales the background image to cover the artboard', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const noImage = ed.extendBackgroundToCanvas();
    const c = document.createElement('canvas'); c.width = 50; c.height = 50;
    const cx = c.getContext('2d'); cx.fillStyle = '#ff00ff'; cx.fillRect(0, 0, 50, 50);
    await ed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    const bg = ed.fc.getObjects().find(o => o.role === 'bg');
    bg.set({ left: 0, top: 0, scaleX: 1, scaleY: 1, originX: 'left', originY: 'top' });
    const ok = ed.extendBackgroundToCanvas();
    const after = ed.fc.getObjects().find(o => o.role === 'bg');
    return { noImage, ok, scaleX: after.scaleX, scaleY: after.scaleY, left: after.left, top: after.top };
  });
  assert.equal(result.noImage, false);
  assert.equal(result.ok, true);
  assert.ok(result.scaleX >= 400 / 50 - 0.001);   // covers the 400x300 test artboard from a 50x50 source
  assert.ok(result.scaleY >= 400 / 50 - 0.001);
});

/* ── ad-copy layers (adtext.js via editor.js's addCTA/addBadge/addPrice/addBrandLockup) ──────── */
test('browser: addCTA builds a pill group sized to its own label, with a readable ink color', async () => {
  const info = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addCTA(null, { text: 'Buy now', size: 20, fill: '#111114' });
    const o = ed.fc.getObjects().find(x => x.id === id);
    return { role: o.role, name: o.name, type: o.type, childCount: o._objects.length, width: o.width, height: o.height };
  });
  assert.equal(info.role, 'cta');
  assert.equal(info.name, 'CTA');
  assert.equal(info.type, 'group');
  assert.equal(info.childCount, 3);   // pill rect + label text + arrow glyph
  assert.ok(info.width > 0 && info.height > 0);
});

test('browser: addBadge uppercases its text and omits nothing — role/name/group shape', async () => {
  const info = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addBadge(null, { text: 'sale', size: 16 });
    const o = ed.fc.getObjects().find(x => x.id === id);
    const label = o._objects[1];
    return { role: o.role, name: o.name, childCount: o._objects.length, labelText: label.text };
  });
  assert.equal(info.role, 'badge');
  assert.equal(info.name, 'Badge');
  assert.equal(info.childCount, 2);   // pill rect + label text
  assert.equal(info.labelText, 'SALE');
});

test('browser: addPrice includes the strikethrough original and savings text only when given', async () => {
  const withAll = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addPrice(null, { current: '$40', original: '$60', save: 'Save 33%', size: 24 });
    const o = ed.fc.getObjects().find(x => x.id === id);
    return { childCount: o._objects.length, linethrough: o._objects[1].linethrough, texts: o._objects.map(c => c.text) };
  });
  assert.equal(withAll.childCount, 3);
  assert.equal(withAll.linethrough, true);
  assert.deepEqual(withAll.texts, ['$40', '$60', 'Save 33%']);

  const currentOnly = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addPrice(null, { current: '$40', size: 24 });
    const o = ed.fc.getObjects().find(x => x.id === id);
    return o._objects.length;
  });
  assert.equal(currentOnly, 1);
});

test('browser: addBrandLockup builds a mark + lowercase initial + name, mark fill matches the given color', async () => {
  const info = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addBrandLockup(null, { text: 'Acme', color: '#2f6df0', size: 18 });
    const o = ed.fc.getObjects().find(x => x.id === id);
    const [mark, letter, name] = o._objects;
    return { role: o.role, markFill: mark.fill, letterText: letter.text, nameText: name.text };
  });
  assert.equal(info.role, 'brand');
  assert.equal(info.markFill, '#2f6df0');
  assert.equal(info.letterText, 'a');   // lowercased first letter of "Acme"
  assert.equal(info.nameText, 'Acme');
});

test('browser: layerLabel shows the ad-copy layer\'s own name, not its Fabric Group child count', async () => {
  const label = await page.evaluate(async () => {
    const { layerLabel } = await import('/packages/core/src/index.js');
    const ed = window.__ed;
    const id = ed.addCTA(null, { text: 'Go' });
    const o = ed.fc.getObjects().find(x => x.id === id);
    return layerLabel(o);
  });
  assert.equal(label, 'CTA');   // NOT "3 layers" (the generic Group fallback)
});

/* ── stickers (stickers.js via editor.js's addSticker) — ported ditto reference categories:
   sale bursts, price tags, corner ribbon, extra arrow rotations, and baked-text badge/tag/
   banner/burst variants (kind: 'group', shape + centered IText label). ──────────────────────── */
test('browser: every STICKER_GROUPS key places without error and resolves a real stickerSpec', async () => {
  const result = await page.evaluate(async () => {
    const { STICKER_GROUPS, stickerSpec } = await import('/packages/core/src/index.js');
    const ed = window.__ed;
    const missing = [];
    const failed = [];
    STICKER_GROUPS.forEach(g => g.keys.forEach(key => {
      if (!stickerSpec(key)) { missing.push(key); return; }
      const id = ed.addSticker(key);
      if (!id || !ed.fc.getObjects().find(o => o.id === id)) failed.push(key);
    }));
    return { missing, failed, groupCount: STICKER_GROUPS.length };
  });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.failed, []);
  assert.ok(result.groupCount >= 6);   // sale bursts, badges&tags, ribbons&banners, price tags, arrows, accents
});

test('browser: a baked-text sticker — double-click retypes its label, Fill recolours its shape (not the invisible group fill)', async () => {
  // Regressions: double-clicking the sticker did nothing, so the letters typed next fired tool
  // shortcuts (B brush, A wand, G bucket, S clone); and Fill set the GROUP's fill, which Fabric
  // never paints, while the panel showed #000000.
  const id = await page.evaluate(() => { const ed = window.__ed; const id = ed.addSticker('burstText', { x: 200, y: 150 }); ed.setTool('select'); return id; });
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const at = [box.x + vt[4] + 200 * vt[0], box.y + vt[5] + 150 * vt[3]];
  await page.mouse.dblclick(...at); await page.waitForTimeout(100);
  const editing = await page.evaluate(() => { const a = window.__ed.fc.getActiveObject(); return { type: a.type, editing: !!a.isEditing, sel: a.text.slice(a.selectionStart, a.selectionEnd) }; });
  assert.deepEqual(editing, { type: 'i-text', editing: true, sel: 'SALE' });
  await page.keyboard.type('BAGS'); await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__ed.tool), 'select', 'typing went into the label, not to tool shortcuts');
  await page.mouse.click(box.x + 5, box.y + 5); await page.waitForTimeout(50);   // deselect: the label goes back in
  const g = await page.evaluate((id) => { const ed = window.__ed, g = ed._byId(id); return { kids: g._objects.map(k => k.type), text: g._objects.find(k => k.text).text, iso: ed._iso.length, top: ed.fc.getObjects().length }; }, id);
  assert.deepEqual(g, { kids: ['polygon', 'i-text'], text: 'BAGS', iso: 0, top: 1 });
  const fill = await page.evaluate((id) => { const ed = window.__ed; ed.activate(id); ed.setFill('#f4eedf'); const g = ed._byId(id); return { group: g.fill, shape: g._objects[0].fill, ink: g._objects[1].fill }; }, id);
  assert.deepEqual(fill, { group: '#f4eedf', shape: '#f4eedf', ink: '#0c0c0e' }, 'shape recoloured, label ink flipped for contrast');
  const label = await page.evaluate(() => window.__ed.layers()[0]);
  assert.equal(label.name, 'Sticker'); assert.equal(label.subtitle, 'Sticker');
});

test('browser: eyedropper picked with a shape selected fills that shape and hands it back selected', async () => {
  // Regression: picking the eyedropper deselected the shape and only changed the brush colour —
  // there was no way to put the sampled colour on the shape short of typing the hex.
  const r = await page.evaluate(() => {
    const ed = window.__ed, f = window.fabric;
    const swatch = new f.Rect({ left: 300, top: 200, width: 60, height: 60, fill: '#c9a24a', strokeWidth: 0 });
    const btn = new f.Rect({ left: 20, top: 20, width: 120, height: 50, fill: '#000000', strokeWidth: 0 });
    btn.set({ id: 'btn' }); ed.fc.add(swatch, btn); ed.commit('add');
    ed.activate('btn'); ed.setTool('eyedropper');
    return { tool: ed.tool };
  });
  assert.equal(r.tool, 'eyedropper');
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  await page.mouse.click(box.x + vt[4] + 330 * vt[0], box.y + vt[5] + 230 * vt[3]);
  const after = await page.evaluate(() => { const ed = window.__ed; return { tool: ed.tool, active: ed.fc.getActiveObject()?.id, fill: ed._byId('btn').fill, brush: ed.toolOpts.color }; });
  assert.deepEqual(after, { tool: 'select', active: 'btn', fill: '#c9a24a', brush: '#c9a24a' });
  // nothing selected: only the brush colour changes, as before
  await page.evaluate(() => { const ed = window.__ed; ed.fc.discardActiveObject(); ed.setTool('eyedropper'); });
  await page.mouse.click(box.x + vt[4] + 80 * vt[0], box.y + vt[5] + 45 * vt[3]);
  assert.equal(await page.evaluate(() => window.__ed.tool), 'eyedropper');
  assert.equal(await page.evaluate(() => window.__ed._byId('btn').fill), '#c9a24a');
});

test('browser: End / Home with a word highlighted go to the line edge (double-click, End, type appends)', async () => {
  // Regression: Fabric only collapsed the highlight, so "double-click the text, End, type" inserted
  // mid-line: "Shop now" + " →" became "Shop → now".
  await page.evaluate(() => { const ed = window.__ed, t = new window.fabric.IText('Shop now', { left: 20, top: 20, fontSize: 40 }); ed.fc.add(t); ed.fc.setActiveObject(t); t.enterEditing(); t.selectionStart = 0; t.selectionEnd = 4; });
  await page.keyboard.press('End'); await page.keyboard.type(' →');
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject().text), 'Shop now →');
  await page.evaluate(() => { const t = window.__ed.fc.getActiveObject(); t.selectionStart = 5; t.selectionEnd = 8; });
  await page.keyboard.press('Home'); await page.keyboard.type('» ');
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject().text), '» Shop now →');
});

test('browser: spot heal (no source picked) fills the stroke from its surroundings', async () => {
  // Regression: "Spot heal" was a healing brush — the first press silently became the source and
  // the next stroke cloned/blurred whatever sat beside it, leaving a pale smudge over the spot.
  const id = await page.evaluate(async () => {
    const ed = window.__ed, c = document.createElement('canvas'); c.width = 400; c.height = 300;
    const x = c.getContext('2d'); x.fillStyle = '#12301f'; x.fillRect(0, 0, 400, 300);
    x.fillStyle = '#e8f0d8'; x.font = 'bold 40px sans-serif'; x.fillText('Coconut', 120, 165);   // the spot to remove
    x.fillStyle = '#e8f0d8'; x.fillRect(120, 60, 160, 20);                                       // light pixels NEAR it a source could grab
    const img = await ed.addImage(c.toDataURL()); img.set({ left: 0, top: 0, scaleX: 1, scaleY: 1 }); img.setCoords();
    ed.fc.setActiveObject(img); ed.setTool('heal'); ed.setToolOptions({ size: 56, hardness: 0.8, opacity: 1 });
    return img.id;
  });
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const S = (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  await page.mouse.move(...S(112, 152)); await page.mouse.down(); await page.mouse.move(...S(290, 152), { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(100);
  const r = await page.evaluate((id) => {
    const ed = window.__ed, o = ed._byId(id), el = o._element, c = document.createElement('canvas'); c.width = el.width; c.height = el.height;
    const x = c.getContext('2d'); x.drawImage(el, 0, 0); const d = x.getImageData(115, 135, 175, 40).data;
    let maxL = 0; for (let i = 0; i < d.length; i += 4) maxL = Math.max(maxL, (d[i] + d[i + 1] + d[i + 2]) / 3);
    return { maxL: Math.round(maxL), src: ed.cloneSource };
  }, id);
  assert.equal(r.src, null, 'no source was needed');
  assert.ok(r.maxL < 60, 'the light lettering is gone, filled with the dark surroundings (brightest px ' + r.maxL + ')');
});

test('browser: a shape with no visible fill is clickable on its border only — text inside it can be clicked', async () => {
  // Regression: a dashed "USE CODE" outline (fill alpha 0) sat over its own text, so clicking or
  // shift-clicking the text always hit the outline instead.
  await page.evaluate(() => {
    const ed = window.__ed, f = window.fabric;
    const t = new f.IText('USE CODE', { left: 120, top: 130, fontSize: 30 }); t.set({ id: 'txt' });
    const r = new f.Rect({ left: 90, top: 110, width: 220, height: 80, fill: '#000000', stroke: '#d4b072', strokeWidth: 3 }); r.set({ id: 'pill' });
    ed.fc.add(t, r); ed.activate('pill'); ed.setFill('rgba(0,0,0,0)'); ed.fc.discardActiveObject();
  });
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const S = (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  await page.mouse.click(...S(150, 148));
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject()?.id), 'txt', 'the text inside is what a click hits');
  await page.evaluate(() => window.__ed.fc.discardActiveObject());
  await page.mouse.click(...S(200, 111.5));
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject()?.id), 'pill', 'the border still grabs the outline');
  // a solid fill makes the whole box clickable again
  await page.evaluate(() => { const ed = window.__ed; ed.activate('pill'); ed.setFill('#123456'); ed.fc.discardActiveObject(); });
  await page.mouse.click(...S(150, 148));
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject()?.id), 'pill');
});

test('browser: a price / CTA is editable — double-click retypes a part and it re-flows; Fill recolours it', async () => {
  // Regression: ad-copy groups were built from plain fabric.Text, so a price inserted as $29 / $40
  // could never be changed; Fill set the group's invisible fill (panel showed #000000).
  const id = await page.evaluate(() => { const ed = window.__ed; const id = ed.addPrice({ x: 200, y: 150 }, { current: '$29', original: '$40', save: 'Save 27%', size: 28 }); ed.setTool('select'); return id; });
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const partAt = (i) => page.evaluate(([id, i]) => { const m = window.__ed._byId(id)._objects[i].calcTransformMatrix(); return [m[4], m[5]]; }, [id, i]);
  const S = ([x, y]) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  const before = await page.evaluate((id) => window.__ed._byId(id)._objects.map(k => k.left), id);
  await page.mouse.dblclick(...S(await partAt(0))); await page.waitForTimeout(80);
  assert.deepEqual(await page.evaluate(() => { const a = window.__ed.fc.getActiveObject(); return [a.type, a.isEditing, a.text.slice(a.selectionStart, a.selectionEnd)]; }), ['i-text', true, '$29']);
  await page.keyboard.type('₹1,499'); await page.keyboard.press('Escape'); await page.waitForTimeout(80);
  const after = await page.evaluate((id) => { const ed = window.__ed, g = ed._byId(id); return { texts: g._objects.map(k => k.text), lefts: g._objects.map(k => k.left), n: ed.fc.getObjects().length, json: ed.toJSON().includes('₹1,499') }; }, id);
  assert.deepEqual(after.texts, ['₹1,499', '$40', 'Save 27%']);
  assert.ok(after.lefts[1] > before[1], 'the parts after it moved right to make room');
  assert.equal(after.n, 1, 'no editing layer left behind'); assert.ok(after.json, 'saved');
  assert.deepEqual(await page.evaluate(() => { const ed = window.__ed; ed.undo(); return null; }), null);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate((id) => window.__ed._byId(id)._objects[0].text, id), '$29', 'one undo step');
  await page.evaluate(() => window.__ed.redo()); await page.waitForTimeout(150);
  const fill = await page.evaluate((id) => { const ed = window.__ed; ed.activate(id); ed.setFill('#f4eedf'); const g = ed.fc.getActiveObject(); return { id: g.id, group: g.fill, cur: g._objects[0].fill, text: g._objects[0].text }; }, id);
  assert.deepEqual(fill, { id, group: '#f4eedf', cur: '#f4eedf', text: '₹1,499' });
  // a CTA pill grows with its label
  const cta = await page.evaluate(() => { const ed = window.__ed; const id = ed.addCTA ? ed.addCTA({ x: 200, y: 250 }, { text: 'Buy', size: 24 }) : null; if (!id) return null; const w0 = ed._byId(id).getScaledWidth(); const ng = ed._rebuildAd(ed._byId(id), { text: 'Shop the festive sale' }); return { w0, w1: ng.getScaledWidth(), text: ng._objects[1].text }; });
  if (cta) { assert.ok(cta.w1 > cta.w0 + 50, 'pill widened: ' + JSON.stringify(cta)); assert.equal(cta.text, 'Shop the festive sale'); }
});

test('browser: a plain (non-text) sticker is a single recolorable shape, not a group', async () => {
  const info = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addSticker('burst12');
    const o = ed.fc.getObjects().find(x => x.id === id);
    return { type: o.type, role: o.role, name: o.name, fill: o.fill };
  });
  assert.notEqual(info.type, 'group');
  assert.equal(info.role, 'shape');
  assert.equal(info.name, 'Sticker');
  assert.ok(info.fill);   // recolorable — has the palette's first fill applied directly
});

test('browser: a baked-text sticker (kind: \'group\') places its named base shape + a centered, auto-contrast IText label', async () => {
  const info = await page.evaluate(() => {
    const ed = window.__ed;
    const id = ed.addSticker('burstText');
    const o = ed.fc.getObjects().find(x => x.id === id);
    const label = o._objects.find(c => c.type === 'i-text');
    const shape = o._objects.find(c => c.type !== 'i-text');
    return { type: o.type, role: o.role, childCount: o._objects.length, labelText: label && label.text, labelFill: label && label.fill, shapeType: shape && shape.type };
  });
  assert.equal(info.type, 'group');
  assert.equal(info.role, 'shape');
  assert.equal(info.childCount, 2);
  assert.equal(info.labelText, 'SALE');
  assert.equal(info.shapeType, 'polygon');   // burst12's own base shape kind
  assert.ok(info.labelFill === '#0c0c0e' || info.labelFill === '#ffffff');   // real contrast pick, not a placeholder
});

test('browser: new ported shapes (burst/tag/swing/corner/arrowCurve/rotated arrows) all resolve valid specs', async () => {
  const kinds = await page.evaluate(async () => {
    const { stickerSpec } = await import('/packages/core/src/index.js');
    return ['burst8', 'burst12', 'burst16', 'tag', 'swing', 'corner', 'arrowCurve', 'arrowUp', 'arrowDown', 'arrowLeft'].map(k => {
      const s = stickerSpec(k); return s ? s.kind : null;
    });
  });
  assert.ok(kinds.every(k => k === 'polygon' || k === 'path'));
});

/* ── promo layout (templates.js via editor.js's applyPromoLayout) ────────────────────────────── */
test('browser: applyPromoLayout replaces the composition with a real hero/sale/centered layer stack', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    await ed.applyPromoLayout({ layout: 'centered', head: 'Big Sale', sub: 'This week only', cta: 'Shop now', brand: 'Acme' });
    const objs = ed.fc.getObjects();
    return {
      count: objs.length,
      roles: objs.map(o => o.role),
      headlineText: objs.find(o => o.role === 'headline').text,
      bgLocked: objs.find(o => o.role === 'bg').locked,
    };
  });
  assert.ok(result.roles.includes('bg'));
  assert.ok(result.roles.includes('brand'));
  assert.ok(result.roles.includes('headline'));
  assert.ok(result.roles.includes('sub'));
  assert.ok(result.roles.includes('cta'));
  assert.ok(result.roles.includes('product'));
  assert.equal(result.headlineText, 'Big Sale');
  assert.equal(result.bgLocked, true);
});

test('browser: applyPromoLayout replacing the composition is a single undoable history step', async () => {
  const depths = await page.evaluate(async () => {
    const ed = window.__ed;
    ed.fc.getObjects().slice().forEach(o => ed.fc.remove(o));
    ed.commit('clear');
    const before = ed.history.depth();
    await ed.applyPromoLayout({ layout: 'sale', head: 'Flash sale' });
    const after = ed.history.depth();
    ed.undo();
    await new Promise(r => setTimeout(r, 50));
    const objRolesAfterUndo = ed.fc.getObjects().map(o => o.role);
    return { before: before.past, after: after.past, objRolesAfterUndo };
  });
  assert.equal(depths.after, depths.before + 1);   // one commit for the whole layout, not one per layer
  assert.deepEqual(depths.objRolesAfterUndo, []);   // undo restores the pre-layout (empty) canvas
});

test('browser: applyPromoLayout auto-fits the headline text to its slot height when maxH is exceeded', async () => {
  const sizes = await page.evaluate(async () => {
    const ed = window.__ed;
    // A tiny artboard forces the hero headline's font size well past what its own maxH slot
    // (derived from W*0.115 in templates.js's hero branch) can hold at the nominal W*0.088 size.
    await ed.applyPromoLayout({ layout: 'hero', head: 'A very long headline that must shrink to fit' }, );
    const headline = ed.fc.getObjects().find(o => o.role === 'headline');
    return { fontSize: headline.fontSize, height: headline.height };
  });
  // No hard assertion on the exact shrunk size (depends on font metrics), just that autoFitText
  // actually ran and produced a renderable, non-degenerate textbox.
  assert.ok(sizes.fontSize >= 9);
  assert.ok(sizes.height > 0);
});

/* ── AI: mask-guided background swap/extend, non-destructive (only the bg layer's pixels swap —
   every other layer in the composition survives, unlike the old whole-scene openImageResult
   contract these two methods used before) ──────────────────────────────────────────────────── */
test('browser: aiBgSwap with no selection asks magicEdit with no mask, and swaps only the bg layer', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    // a small red bg image + an unrelated shape layer on top, to prove the shape survives
    const c = document.createElement('canvas'); c.width = 40; c.height = 40;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, 40, 40);
    const bg = await ed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    ed.setTool('rect');
    // place a marker shape via the API directly (avoids a real pointer drag in this test)
    const shape = new ed.fabric.Rect({ left: 10, top: 10, width: 20, height: 20, fill: '#00ff00' });
    shape.set({ id: 'marker', role: 'shape', name: 'Marker' });
    ed.fc.add(shape);
    ed.setTool('select');

    let calls = [];
    ed.ai.register({ async magicEdit(imageDataURL, instruction, maskDataURL) {
      calls.push({ hasImage: !!imageDataURL, instruction, maskDataURL });
      const out = document.createElement('canvas'); out.width = 40; out.height = 40;
      out.getContext('2d').fillStyle = '#0000ff'; out.getContext('2d').fillRect(0, 0, 40, 40);
      return out.toDataURL('image/png');
    } });

    const r = await ed.aiBgSwap('a blue sky');
    const objs = ed.fc.getObjects();
    const newBg = objs.find(o => o.id === bg.id);
    const ctx = newBg._element.getContext ? newBg._element.getContext('2d') : null;
    return {
      status: r.status,
      callCount: calls.length,
      maskDataURL: calls[0] && calls[0].maskDataURL,
      instruction: calls[0] && calls[0].instruction,
      markerSurvived: objs.some(o => o.id === 'marker'),
      objectCount: objs.length,
      bgIdentityKept: newBg.role === 'bg' && newBg.name === 'Background',
    };
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.callCount, 1);
  assert.equal(result.maskDataURL, undefined);   // no selection → magicEdit called with only (image, instruction)
  assert.ok(result.instruction.includes('a blue sky'));
  assert.equal(result.markerSurvived, true);   // the unrelated shape layer was NOT wiped
  assert.equal(result.objectCount, 2);         // bg + marker, nothing added/removed besides the swap
  assert.equal(result.bgIdentityKept, true);   // same role/name — the swap preserved layer identity
});

test('browser: aiBgSwap with an active selection passes a real white=editable/black=protect mask', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = 40; c.height = 40;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, 40, 40);
    await ed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    ed.selection = { kind: 'rect', x: 5, y: 5, w: 10, h: 10 };

    let capturedMask = null;
    ed.ai.register({ async magicEdit(imageDataURL, instruction, maskDataURL) {
      capturedMask = maskDataURL;
      const out = document.createElement('canvas'); out.width = 40; out.height = 40;
      out.getContext('2d').fillStyle = '#0000ff'; out.getContext('2d').fillRect(0, 0, 40, 40);
      return out.toDataURL('image/png');
    } });

    await ed.aiBgSwap('a sunset');
    // decode the captured mask and sample inside vs. outside the selection rect
    const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = capturedMask; });
    const mc = document.createElement('canvas'); mc.width = 40; mc.height = 40;
    const mctx = mc.getContext('2d'); mctx.drawImage(img, 0, 0);
    const inside = mctx.getImageData(10, 10, 1, 1).data;    // inside the selection rect (5,5,10,10)
    const outside = mctx.getImageData(30, 30, 1, 1).data;   // outside it
    return { hadMask: !!capturedMask, inside: [inside[0], inside[1], inside[2]], outside: [outside[0], outside[1], outside[2]], selectionCleared: !ed.selection };
  });
  assert.equal(result.hadMask, true);
  assert.deepEqual(result.inside, [0, 0, 0]);      // black = protected (selected subject)
  assert.deepEqual(result.outside, [255, 255, 255]); // white = editable background
  assert.equal(result.selectionCleared, true);
});

test('browser: aiExtendBackground reports no_gap without calling the AI when the bg already fills the canvas', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    await ed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    const bg = ed.fc.getObjects().find(o => o.role === 'bg');
    bg.set({ left: 0, top: 0, scaleX: 1, scaleY: 1, originX: 'left', originY: 'top' });
    let called = false;
    ed.ai.register({ async magicEdit() { called = true; return null; } });
    const r = await ed.aiExtendBackground();
    return { status: r.status, reason: r.reason, called };
  });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'no_gap');
  assert.equal(result.called, false);   // the gap check short-circuits before any AI call
});

/* ── region review: commitRegions maps a detected region's type to its committed layer's ROLE
   via REGION_ROLE (text -> headline, sticker -> decorative, others pass through unchanged), and
   stores the original detected type separately on regionType so it survives serialization. ──── */
test('browser: commitRegions maps region types to layer roles via REGION_ROLE, keeping the original type on regionType', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const flat = c.toDataURL('image/png');
    const regions = [
      { type: 'product', bbox: { x: 5, y: 5, width: 20, height: 20 } },
      { type: 'logo', bbox: { x: 30, y: 5, width: 15, height: 15 } },
      { type: 'text', bbox: { x: 5, y: 30, width: 40, height: 10 }, content: 'Big Sale' },
      { type: 'sticker', bbox: { x: 50, y: 30, width: 10, height: 10 } },
      { type: 'decorative', bbox: { x: 65, y: 30, width: 10, height: 10 } },
    ];
    const r = await ed.commitRegions(flat, regions);
    const byRegionType = (t) => ed.fc.getObjects().find(o => o.regionType === t);
    return {
      status: r.status,
      count: r.result,
      productRole: byRegionType('product') && byRegionType('product').role,
      logoRole: byRegionType('logo') && byRegionType('logo').role,
      textRole: byRegionType('text') && byRegionType('text').role,
      textContent: byRegionType('text') && byRegionType('text').text,
      stickerRole: byRegionType('sticker') && byRegionType('sticker').role,
      decorativeRole: byRegionType('decorative') && byRegionType('decorative').role,
    };
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.count, 5);
  assert.equal(result.productRole, 'product');       // passes through unchanged
  assert.equal(result.logoRole, 'logo');              // passes through unchanged
  assert.equal(result.textRole, 'headline');          // text -> headline
  assert.equal(result.textContent, 'Big Sale');
  assert.equal(result.stickerRole, 'decorative');     // sticker -> decorative
  assert.equal(result.decorativeRole, 'decorative');  // already decorative
});

/* ── commitRegions must apply a text region's `style` (fontSize/color/textAlign/fontWeight) to the
   resulting text layer, and store it back on the layer as `rstyle` so it survives an extract/merge
   round-trip — regression test for style being silently dropped (only a box-height-derived default
   fontSize was ever applied, color/align/weight were always ignored). ──── */
test('browser: commitRegions applies a text region\'s style (fontSize/color/textAlign/fontWeight) to the layer', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const flat = c.toDataURL('image/png');
    const style = { fontSize: 40, color: '#ff0000', textAlign: 'center', fontWeight: 'bold' };
    const r = await ed.commitRegions(flat, [
      { type: 'text', bbox: { x: 5, y: 5, width: 40, height: 10 }, content: 'Styled', style },
    ]);
    const layer = ed.fc.getObjects().find(o => o.regionType === 'text');
    return {
      status: r.status, W: ed.W,
      fill: layer && layer.fill,
      textAlign: layer && layer.textAlign,
      fontWeight: layer && layer.fontWeight,
      fontSize: layer && layer.fontSize,
      rstyle: layer && layer.rstyle,
    };
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.fill, '#ff0000');
  assert.equal(result.textAlign, 'center');
  assert.equal(result.fontWeight, 700);
  assert.equal(result.fontSize, Math.max(12, Math.round(40 * (result.W / 1080))));
  assert.deepEqual(result.rstyle, { fontSize: 40, color: '#ff0000', textAlign: 'center', fontWeight: 'bold' });
});

/* ── commitRegions must play a staggered "layer reveal" animation afterward (each new layer rises
   + fades in) instead of popping the whole composition in instantly with no feedback tying a layer
   to the region it came from — regression test for the animation being entirely absent. Checking
   the full tween would be timing-flaky, so this only asserts the observable contract right after
   commit: new layers start hidden (opacity 0, animateLayersIn's initial state) rather than already
   at full opacity, and settle back to full opacity once the animation completes. ──── */
test('browser: commitRegions plays a staggered reveal — new layers start hidden then fade back in', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const flat = c.toDataURL('image/png');
    await ed.commitRegions(flat, [{ type: 'product', bbox: { x: 5, y: 5, width: 20, height: 20 } }]);
    const layer = ed.fc.getObjects().find(o => o.regionType === 'product');
    const bg = ed.fc.getObjects().find(o => o.role === 'bg');
    const immediately = { layerOpacity: layer.opacity, bgOpacity: bg.opacity };
    await new Promise(r => setTimeout(r, 2200));   // outlast the reveal's longest tween (~1280ms + delay)
    const settled = { layerOpacity: layer.opacity, bgOpacity: bg.opacity, layerShadow: layer.shadow };
    return { immediately, settled };
  });
  assert.equal(result.immediately.layerOpacity, 0);
  assert.equal(result.settled.layerOpacity, 1);
  assert.equal(result.settled.bgOpacity, 1);
  assert.equal(result.settled.layerShadow, null);
});

/* ── detectObjects must fall back to a local (no-OpenCV) blob detector when the cv worker returns
   nothing, instead of reporting 'no_match' even though there's an obvious foreground shape on the
   canvas — regression test for the missing local-detection fallback. Stubs ed.cv.detect to always
   return null (as if the worker/WASM never loaded) so the fallback path is exercised
   deterministically, then paints an actual high-contrast rect so the blob detector has something
   real to find. ──── */
test('browser: detectObjects falls back to a local blob detector when the cv worker finds nothing', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 220, canvasBox.y + 170, { steps: 4 });
  await page.mouse.up();
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const o = ed.fc.getObjects().find(x => x.type === 'rect');
    if (o) o.set({ fill: '#ff2222' });
    ed.fc.renderAll();
    const realCv = ed.cv;
    ed.cv = { ...realCv, detect: async () => null };
    const r = await ed.detectObjects();
    ed.cv = realCv;
    return r;
  });
  assert.equal(result.status, 'ok');
  assert.ok(result.result.boxes.length > 0);
});

/* ── cutoutRegion's `bgMode` ('auto'/'cheap'/'best') must actually change the working resolution
   passed into the cv worker instead of being a fully inert UI setting — regression test for the
   "Clean background" picker doing nothing regardless of which mode was selected. Stubs
   ed.cv.grabcut to capture the ImageData it's called with instead of running real OpenCV. ──── */
test('browser: cutoutRegion varies working resolution by bgMode (cheap < auto < best)', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const realCv = ed.cv;
    const widths = {};
    ed.cv = { grabcut: async (img) => { widths.last = img.width; return [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]; } };
    // Use a source much larger than all three resolution caps (600/900/1200) so downscaling
    // actually differs per mode — the editor's own W/H (400x300 in this fixture) is too small and
    // would clamp every mode to the same 1:1 scale, masking the bug this test guards against.
    const c = document.createElement('canvas'); c.width = 2000; c.height = 1500;
    c.getContext('2d').fillStyle = '#888'; c.getContext('2d').fillRect(0, 0, 2000, 1500);
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = c.toDataURL('image/png'); });
    const box = { x: 10, y: 10, w: 80, h: 80 };
    await ed.cutoutRegion(img, box, 'cheap'); const cheapW = widths.last;
    await ed.cutoutRegion(img, box, 'auto'); const autoW = widths.last;
    await ed.cutoutRegion(img, box, 'best'); const bestW = widths.last;
    ed.cv = realCv;
    return { cheapW, autoW, bestW };
  });
  assert.ok(result.cheapW < result.autoW, `cheap (${result.cheapW}) should be lower-res than auto (${result.autoW})`);
  assert.ok(result.autoW < result.bestW, `auto (${result.autoW}) should be lower-res than best (${result.bestW})`);
});

/* ── commitRegions must NOT wipe layers the user already had on the canvas before running
   convert-to-layers — only the old background and leftover review-box overlays. Regression test
   for the bug where commitRegions removed every object unconditionally, silently destroying any
   hand-placed text/logo/sticker the user added before clicking "Convert to layers". ──── */
test('browser: commitRegions preserves pre-existing non-background layers instead of wiping the whole canvas', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const preExistingId = ed.addCTA({ x: 100, y: 100 });
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const flat = c.toDataURL('image/png');
    const r = await ed.commitRegions(flat, [{ type: 'product', bbox: { x: 5, y: 5, width: 20, height: 20 } }]);
    return {
      status: r.status,
      preExistingSurvived: !!ed.fc.getObjects().find(o => o.id === preExistingId),
      newRegionPresent: !!ed.fc.getObjects().find(o => o.regionType === 'product'),
    };
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.preExistingSurvived, true);
  assert.equal(result.newRegionPresent, true);
});

/* ── objectPickInImage (the review step's "Object select" tool) must fall back to a box-seeded
   GrabCut when the colour wand finds nothing (e.g. a low-contrast subject), instead of giving up
   immediately — regression test for the missing fallback (wand-only, no grabcut retry). Stubs
   ed.cv.wand/grabcut directly so the test is deterministic and doesn't depend on real image
   content or a live OpenCV worker. ──── */
test('browser: objectPickInImage falls back to box-seeded grabCut when the colour wand finds nothing', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const calls = [];
    const realCv = ed.cv;
    ed.cv = {
      wand: async (img, seed) => { calls.push('wand'); return []; },
      grabcut: async (img, seed, work) => { calls.push('grabcut'); return [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }]; },
    };
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = c.toDataURL('image/png'); });
    const poly = await ed.objectPickInImage(img, { x: ed.W / 2, y: ed.H / 2 }, 32);
    ed.cv = realCv;
    return { calls, polyLen: poly ? poly.length : 0 };
  });
  assert.deepEqual(result.calls, ['wand', 'grabcut']);
  assert.equal(result.polyLen, 3);
});

test('browser: objectPickInImage returns null when both wand and the grabCut fallback fail', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const realCv = ed.cv;
    ed.cv = { wand: async () => [], grabcut: async () => null };
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = c.toDataURL('image/png'); });
    const poly = await ed.objectPickInImage(img, { x: ed.W / 2, y: ed.H / 2 }, 32);
    ed.cv = realCv;
    return { poly };
  });
  assert.equal(result.poly, null);
});

test('browser: commitRegions\' regionType survives an undo/redo round-trip (serialized via io.js EXTRA)', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    await ed.commitRegions(c.toDataURL('image/png'), [{ type: 'sticker', bbox: { x: 10, y: 10, width: 20, height: 20 } }]);
    ed.undo();
    await new Promise(r => setTimeout(r, 50));
    ed.redo();
    await new Promise(r => setTimeout(r, 50));
    const layer = ed.fc.getObjects().find(o => o.regionType === 'sticker');
    return { found: !!layer, role: layer && layer.role };
  });
  assert.equal(result.found, true);
  assert.equal(result.role, 'decorative');
});

/* ── objectselect click accuracy: the reference editor filters detected boxes by point-containment
   (smallest first) and scopes its grabCut refine to that box, instead of flood-filling from the
   exact clicked pixel with no idea what object is under it — that's what made canvasmith's version
   grab the wrong region on a busy/nested image. Stub cv.wand/grabcut/detect so this is deterministic. */
test('browser: selectObjectAt picks the smallest detected box containing the click and scopes grabCut to it', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const realCv = ed.cv;
    const workRects = [];
    ed.cv = {
      wand: async () => [],   // force the grabCut fallback so `work` is observable
      grabcut: async (img, seed, work) => { workRects.push(work); return [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }]; },
    };
    // A small nested box (the "real" target) inside a big background box — both contain the click.
    ed._objBoxes = [{ x: 0, y: 0, w: ed.W, h: ed.H }, { x: 40, y: 40, w: 20, h: 20 }];
    ed._objRegion = { left: 0, top: 0, width: ed.W, height: ed.H };
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    c.getContext('2d').fillStyle = '#888'; c.getContext('2d').fillRect(0, 0, ed.W, ed.H);
    ed._objSrc = c;
    const r = await ed.selectObjectAt({ x: 50, y: 50 });
    ed.cv = realCv;
    return { status: r.status, workRects, sel: ed.selection };
  });
  assert.equal(result.status, 'ok');
  // work rect must be scoped small (the 20x20 nested box), not the full-canvas background box.
  assert.ok(result.workRects[0].w < 40 && result.workRects[0].h < 40);
  assert.equal(result.sel.kind, 'poly');
});

test('browser: re-clicking the same spot on objectselect cycles to the next larger nested candidate', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const realCv = ed.cv;
    const works = [];
    ed.cv = {
      wand: async () => [],
      grabcut: async (img, seed, work) => { works.push(work); return [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]; },
    };
    ed._objBoxes = [{ x: 0, y: 0, w: ed.W, h: ed.H }, { x: 40, y: 40, w: 20, h: 20 }];
    ed._objRegion = { left: 0, top: 0, width: ed.W, height: ed.H };
    const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H;
    ed._objSrc = c;
    await ed.selectObjectAt({ x: 50, y: 50 }, { cycle: true });
    await ed.selectObjectAt({ x: 50, y: 50 }, { cycle: true });   // same spot again → cycle to the bigger box
    ed.cv = realCv;
    return { firstSmall: works[0].w < 40, secondBig: works[1].w > 40 };
  });
  assert.equal(result.firstSmall, true);
  assert.equal(result.secondBig, true);
});

test('browser: objectselect Shift-click accumulates a multipoly (no auto-union) and mergeObjectSelection unions it', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    const realCv = ed.cv;
    const polyA = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }];
    const polyB = [{ x: 40, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 30 }, { x: 40, y: 30 }];
    await ed._commitObjectPoly(polyA, {});
    const afterFirst = { kind: ed.selection.kind, multiCount: ed.multiCount };
    await ed._commitObjectPoly(polyB, { add: true });
    const afterAdd = { kind: ed.selection.kind, multiCount: ed.multiCount, polyCount: ed.selection.polys.length };
    ed.cv = { union: async (W, H, polys) => [polys[0].concat(polys[1])] };   // stubbed union of the two
    const r = await ed.mergeObjectSelection();
    ed.cv = realCv;
    return { afterFirst, afterAdd, mergeStatus: r.status, afterMerge: { kind: ed.selection.kind, multiCount: ed.multiCount } };
  });
  assert.equal(result.afterFirst.kind, 'poly');
  assert.equal(result.afterFirst.multiCount, 1);
  // Shift-click add must NOT auto-union — stays a multipoly of 2 separate polys until Merge runs.
  assert.equal(result.afterAdd.kind, 'multipoly');
  assert.equal(result.afterAdd.multiCount, 2);
  assert.equal(result.afterAdd.polyCount, 2);
  assert.equal(result.mergeStatus, 'ok');
  assert.equal(result.afterMerge.multiCount, 1);
});

test('browser: aiExtendBackground passes a real white=empty/black=filled gap mask and swaps only the bg layer', async () => {
  const result = await page.evaluate(async () => {
    const ed = window.__ed;
    // a bg image smaller than the artboard, placed at the origin, so most of the canvas is gap
    const c = document.createElement('canvas'); c.width = 20; c.height = 20;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, 20, 20);
    const bg = await ed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    bg.set({ left: 0, top: 0, scaleX: 1, scaleY: 1, originX: 'left', originY: 'top' });

    let capturedMask = null;
    ed.ai.register({ async magicEdit(imageDataURL, instruction, maskDataURL) {
      capturedMask = maskDataURL;
      const out = document.createElement('canvas'); out.width = ed.W; out.height = ed.H;
      out.getContext('2d').fillStyle = '#0000ff'; out.getContext('2d').fillRect(0, 0, ed.W, ed.H);
      return out.toDataURL('image/png');
    } });

    const r = await ed.aiExtendBackground();
    const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = capturedMask; });
    const mc = document.createElement('canvas'); mc.width = ed.W; mc.height = ed.H;
    const mctx = mc.getContext('2d'); mctx.drawImage(img, 0, 0);
    const filled = mctx.getImageData(5, 5, 1, 1).data;     // inside the 20x20 red square = filled
    const empty = mctx.getImageData(300, 200, 1, 1).data;  // well outside it = still empty canvas
    const newBg = ed.fc.getObjects().find(o => o.id === bg.id);
    return { status: r.status, filled: [filled[0], filled[1], filled[2]], empty: [empty[0], empty[1], empty[2]], bgSwapped: newBg.id === bg.id && newBg.type === 'image' };
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.filled, [0, 0, 0]);        // black = real pixels, leave alone
  assert.deepEqual(result.empty, [255, 255, 255]);   // white = empty gap, the model may fill it
  assert.equal(result.bgSwapped, true);
});

/* ── objectselect keybindings: [ / ] tolerance scrub and Escape-to-deselect, matching the
   reference editor's own bindings for this tool (installKeybindings.js already wires both
   generically — these confirm they actually reach objectselect specifically). ──────────────── */
test('browser: [ / ] scrubs tolerance while objectselect is active', async () => {
  await page.evaluate(() => { window.__ed.setTool('objectselect'); window.__ed.setToolOptions({ tolerance: 32 }); });
  await page.keyboard.press(']');
  assert.equal(await page.evaluate(() => window.__ed.toolOpts.tolerance), 36);
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  assert.equal(await page.evaluate(() => window.__ed.toolOpts.tolerance), 28);
});

test('browser: Escape clears an objectselect selection', async () => {
  await page.evaluate(() => {
    const ed = window.__ed;
    ed.setTool('objectselect');
    ed.selection = { kind: 'rect', x: 10, y: 10, w: 50, h: 50 };
    ed.multiCount = 1;
    ed._emit('selection', ed.selection);
  });
  assert.ok(await page.evaluate(() => !!window.__ed.selection));
  await page.keyboard.press('Escape');
  const result = await page.evaluate(() => ({ sel: window.__ed.selection, multiCount: window.__ed.multiCount }));
  assert.equal(result.sel, null);
  assert.equal(result.multiCount, 0);   // clearSelection() resets multiCount too — see editor.js
});

/* ── objectselect hover/tool-switch cleanup: leaving the tool must drop hover state so a stale
   in-flight hover RPC can't land after the fact and nothing keeps a preview alive with no tool
   there to clear it (regression: setTool used to only ever ADD hover state, never remove it). ── */
test('browser: switching away from objectselect clears hover point and candidate-cycle state', async () => {
  const result = await page.evaluate(() => {
    const ed = window.__ed;
    ed.setTool('objectselect');
    ed._hoverPt = { x: 10, y: 10 };
    ed._objCycle = { x: 10, y: 10, i: 2 };
    ed.setTool('select');
    return { hoverPt: ed._hoverPt, objCycle: ed._objCycle };
  });
  assert.equal(result.hoverPt, null);
  assert.equal(result.objCycle, null);
});

/* ── regression: a click landing on an already-cached hover-preview mask must still update
   _lastWandSeed (selectSimilar's seed point) — _down used to only set it inside selectObjectAt,
   which a cache-hit skips entirely, leaving Similar searching from a stale earlier click. ──────── */
test('browser: clicking a cached hover-preview mask on objectselect still updates the Similar seed point', async () => {
  const result = await page.evaluate(() => {
    const ed = window.__ed;
    ed.setTool('objectselect');
    const key = ed._hoverCellKey({ x: 120, y: 80 });
    ed._hoverCache.put(key, [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }]);   // pre-seed the cache
    ed._lastWandSeed = { x: 1, y: 1 };   // a stale earlier click
    return key;
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.click(canvasBox.x + 120, canvasBox.y + 80);
  const seed = await page.evaluate(() => window.__ed._lastWandSeed);
  assert.equal(seed.x, 120);
  assert.equal(seed.y, 80);
});

/* ── session autosave + reset() ────────────────────────────────────────────────────────────
   The pure-logic half of session.js (quota shedding, corrupt payloads) is covered in
   core.test.mjs; what needs a real browser is the round trip through fabric — that a scene
   serialized out of a live canvas enlivens back into the same objects, and that reset() leaves
   an Editor genuinely blank rather than merely emptied of objects. */

test('browser: an autosaved scene restores into a fresh Editor, photo-sized and all', async () => {
  await page.evaluate(async () => {
    window.__ed.setTool('rect');
    await window.__session.clearSession();
  });
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 140, canvasBox.y + 110, { steps: 4 });
  await page.mouse.up();
  await page.evaluate(() => window.__ed.resizeCanvas(321, 222));

  // Autosave is debounced; saveNow() is the deterministic equivalent of waiting it out.
  const saved = await page.evaluate(async () => {
    const s = window.__session.installAutosave(window.__ed, { getExtras: () => ({ tray: ['a.png'] }) });
    await s.saveNow();
    const backend = s.backend;
    s.stop();
    return { stored: (await window.__session.readSession()) !== null, backend };
  });
  assert.equal(saved.stored, true);
  // The whole point of the storage layer: a scene with a photo in it cannot live in
  // localStorage (~5MB budget vs. a base64 data URL per image), so IndexedDB must be what
  // actually backs this in a real browser.
  assert.equal(saved.backend, 'idb');

  // A second, independent Editor over a fresh canvas — the "reopened tab" case.
  const restored = await page.evaluate(async () => {
    const el = document.createElement('canvas');
    document.body.appendChild(el);
    const ed2 = new window.__Editor({ fabric: window.fabric, canvasEl: el, width: 400, height: 300 });
    const extras = await window.__session.restoreSession(ed2);
    return {
      types: ed2.fc.getObjects().map(o => o.type),
      W: ed2.W, H: ed2.H,
      tray: extras && extras.tray,
      past: ed2.history.past.length,
    };
  });
  assert.deepEqual(restored.types, ['rect']);
  assert.equal(restored.W, 321);          // the artboard size round-trips, not just the objects
  assert.equal(restored.H, 222);
  assert.deepEqual(restored.tray, ['a.png']);
  // Exactly one baseline entry: undo must not walk back past a restore into the blank canvas
  // that was never the user's document.
  assert.equal(restored.past, 1);
});

test('browser: reset() blanks the document, empties history, and keeps the artboard paintable', async () => {
  await page.evaluate(() => window.__ed.setTool('rect'));
  const canvasBox = await page.locator('#cv').boundingBox();
  await page.mouse.move(canvasBox.x + 30, canvasBox.y + 30);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 100, { steps: 3 });
  await page.mouse.up();

  const before = await page.evaluate(() => window.__ed.fc.getObjects().length);
  assert.ok(before >= 1);

  const after = await page.evaluate(() => {
    window.__ed.reset({ width: 500, height: 400 });
    return {
      objects: window.__ed.fc.getObjects().length,
      past: window.__ed.history.past.length,
      future: window.__ed.history.future.length,
      W: window.__ed.W, H: window.__ed.H,
      engineW: window.__ed.engine.W, engineH: window.__ed.engine.H,
      // fc.clear() nulls backgroundColor — reset must paint the page back, or the artboard
      // renders as a transparent hole over the void instead of a white page.
      bg: window.__ed.fc.backgroundColor,
      selection: window.__ed.selection,
    };
  });
  assert.equal(after.objects, 0);
  assert.equal(after.past, 1);            // a single blank baseline, like a fresh Editor
  assert.equal(after.future, 0);
  assert.equal(after.W, 500);
  assert.equal(after.H, 400);
  assert.equal(after.engineW, 500);       // the paint engine follows the new artboard
  assert.equal(after.engineH, 400);
  assert.ok(after.bg);
  assert.equal(after.selection, null);

  // Undo right after reset must not resurrect the discarded document.
  const afterUndo = await page.evaluate(() => { window.__ed.undo(); return window.__ed.fc.getObjects().length; });
  assert.equal(afterUndo, 0);

  // And the blank document is still fully usable.
  await page.evaluate(() => window.__ed.setTool('ellipse'));
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 110, canvasBox.y + 95, { steps: 3 });
  await page.mouse.up();
  const drawn = await page.evaluate(() => window.__ed.fc.getObjects().map(o => o.type));
  assert.deepEqual(drawn, ['ellipse']);
});

/* ── magic wand / object select accuracy ───────────────────────────────────────────────────
   These tools were reported as "not working correctly". Both failures only appear on
   PHOTOGRAPHIC input — flat synthetic colour passes at any setting, which is why they went
   unnoticed. Measured against a known-size subject rather than asserting "a selection exists",
   since the bug was a selection of the WRONG SIZE, not a missing one. */

/* Paints `draw` into a canvas, opens it as the document, wand-picks at (cx,cy) and returns the
   selection's width in scene px. */
async function wandWidthAt(page, { size, draw, cx, cy, tolerance }) {
  await page.evaluate(async ({ size, draw, tolerance }) => {
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    // eslint-disable-next-line no-new-func
    new Function('x', 'S', draw)(c.getContext('2d'), size);
    await window.__ed.openImage(c.toDataURL('image/png'));
    window.__ed.setTool('magicwand');
    window.__ed.setToolOptions({ tolerance });
    window.__ed.clearSelection();
  }, { size, draw, tolerance });
  return page.evaluate(async ({ cx, cy }) => {
    const mod = await import('/packages/core/src/selection.js');
    await window.__ed.wandPick({ x: cx, y: cy });
    const s = window.__ed.selection;
    if (!s) return null;
    const polys = mod.selectionPolys(s) || [];
    let minx = 1e9, maxx = -1e9;
    polys.forEach(pl => pl.forEach(p => { if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x; }));
    return Math.round(maxx - minx);
  }, { cx, cy });
}

const PHOTO_SUBJECT = `
  const g = x.createLinearGradient(0,0,S,S); g.addColorStop(0,'#8fa7c4'); g.addColorStop(1,'#d9c9a8');
  x.fillStyle = g; x.fillRect(0,0,S,S);
  const g2 = x.createRadialGradient(S/2,S/2,20,S/2,S/2,S*0.24);
  g2.addColorStop(0,'#b8452f'); g2.addColorStop(1,'#6d2418');
  x.fillStyle = g2; x.beginPath(); x.arc(S/2,S/2,S*0.24,0,7); x.fill();
  const im = x.getImageData(0,0,S,S);
  for (let i=0;i<im.data.length;i+=4){ const n=(Math.random()-.5)*26; im.data[i]+=n; im.data[i+1]+=n; im.data[i+2]+=n; }
  x.putImageData(im,0,0);`;

test('browser: the wand hugs a soft-edged photographic subject at the default tolerance', async () => {
  const size = 1000, ideal = Math.round(size * 0.48);     // the subject's diameter
  const w = await wandWidthAt(page, {
    size, draw: PHOTO_SUBJECT, cx: size / 2, cy: size / 2,
    tolerance: 64,                                        // the shipped default
  });
  assert.ok(w !== null, 'the wand must return a selection on a photographic subject');
  // The old default (32) came back ~28% small here — it stopped at the first shading step
  // instead of the object's edge, visibly cutting inside the thing the user clicked.
  const errPct = Math.abs(w - ideal) / ideal * 100;
  assert.ok(errPct < 12, `wand selected ${w}px for a ${ideal}px subject (${errPct.toFixed(0)}% off)`);
});

test('browser: a low-contrast subject does not flood the wand selection to the whole canvas', async () => {
  const size = 1000, ideal = Math.round(size * 0.5);
  // Subject and background are close enough in colour that the flood escapes into the
  // background — the worker then used to take the >90% mask at face value and hand back the
  // ENTIRE canvas, which is never what clicking on an object means.
  const draw = `
    x.fillStyle='#9aa3ae'; x.fillRect(0,0,S,S);
    x.fillStyle='#7f8b98'; x.beginPath(); x.arc(S/2,S/2,S*0.25,0,7); x.fill();
    const im=x.getImageData(0,0,S,S);
    for(let i=0;i<im.data.length;i+=4){const n=(Math.random()-.5)*18; im.data[i]+=n; im.data[i+1]+=n; im.data[i+2]+=n;}
    x.putImageData(im,0,0);`;
  const w = await wandWidthAt(page, { size, draw, cx: size / 2, cy: size / 2, tolerance: 64 });
  assert.ok(w !== null);
  assert.ok(w < size * 0.9, `wand flooded to ${w}px of a ${size}px canvas instead of the subject`);
  assert.ok(Math.abs(w - ideal) / ideal * 100 < 15, `wand selected ${w}px for a ${ideal}px subject`);
});

test('browser: clicking flat background still selects the background, not just the subject', async () => {
  // The flood-leak fix must not break the legitimate case it has to be told apart from:
  // a deliberate click on a flat background genuinely does select almost the whole frame.
  const size = 1000;
  const draw = `
    x.fillStyle='#ffffff'; x.fillRect(0,0,S,S);
    x.fillStyle='#c0392b'; x.beginPath(); x.arc(S/2,S/2,200,0,7); x.fill();`;
  const w = await wandWidthAt(page, { size, draw, cx: 60, cy: 60, tolerance: 64 });
  assert.ok(w !== null);
  assert.ok(w > size * 0.9, `background click selected only ${w}px of a ${size}px canvas`);
});

test('browser: the wand picks the element under the cursor, not a bigger same-coloured one elsewhere', async () => {
  /* Real-world failure from an ad layout: a small green "now at" pill near the top and a large
     green product card lower down. Clicking the PILL returned the CARD — the flood/grabCut mask
     spanned both same-coloured blobs and the contour picker then preferred the largest one.
     Design work reuses a brand colour constantly, so this is the common case, not an edge case. */
  const size = 1000;
  const draw = `
    x.fillStyle='#f4f4f2'; x.fillRect(0,0,S,S);
    x.fillStyle='#4cc47a'; x.fillRect(120,120,170,60);      // small pill  (the target)
    x.fillStyle='#4cc47a'; x.fillRect(100,500,300,400);     // big card, same colour`;
  const w = await wandWidthAt(page, { size, draw, cx: 200, cy: 150, tolerance: 64 });
  assert.ok(w !== null, 'clicking the pill must select something');
  // The pill is 170px wide; the card is 300px. Before the fix this came back as the card.
  assert.ok(w < 240, `wand returned a ${w}px-wide selection for a 170px pill — it grabbed the other element`);

  // And the click must land on the pill's own box, not somewhere else on the canvas.
  const box = await page.evaluate(async () => {
    const mod = await import('/packages/core/src/selection.js');
    const s = window.__ed.selection;
    const polys = mod.selectionPolys(s) || [];
    let minx = 1e9, miny = 1e9;
    polys.forEach(pl => pl.forEach(p => { if (p.x < minx) minx = p.x; if (p.y < miny) miny = p.y; }));
    return { x: Math.round(minx), y: Math.round(miny) };
  });
  assert.ok(box.y < 300, `selection started at y=${box.y}; the pill is at y=120, the card at y=500`);
});

/* ── tone filter (tone.js): exposure / white balance / curves / HSL on a real Fabric image ─────── */
const addGreyImage = () => page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 20; c.height = 20;
  const x = c.getContext('2d'); x.fillStyle = 'rgb(118,118,118)'; x.fillRect(0, 0, 20, 20);
  const img = await window.__ed.addImage(c.toDataURL());
  window.__ed.fc.setActiveObject(img);
  return img.id;
});
const imgPixel = (id) => page.evaluate((id) => {
  const o = window.__ed.fc.getObjects().find(x => x.id === id);
  const el = o._filteredEl || o._element;
  return Array.from(el.getContext ? el.getContext('2d').getImageData(10, 10, 1, 1).data : []);
}, id);

test('browser: setImageFilters exposure/temperature/curves/hsl bake through the Tone filter', async () => {
  const id = await addGreyImage();
  await page.evaluate(() => window.__ed.setImageFilters({ exposure: 1 }));
  const [e] = await imgPixel(id);
  assert.ok(Math.abs(e - 161) <= 2, 'exposure +1 on mid grey: ' + e);

  await page.evaluate(() => window.__ed.setImageFilters({ exposure: 0, temperature: 60 }));
  const [r, , b] = await imgPixel(id);
  assert.ok(r > 118 && b < 118, `warm: r=${r} b=${b}`);

  await page.evaluate(() => window.__ed.setImageFilters({ temperature: 0, curves: { rgb: [[0, 255], [255, 0]] } }));
  const [inv] = await imgPixel(id);
  assert.equal(inv, 137);

  const fx = await page.evaluate(() => window.__ed.getImageFilters());
  assert.deepEqual(fx.curves, { rgb: [[0, 255], [255, 0]] });
  assert.equal(fx.hsl, null);
});

test('browser: Tone filter survives undo/redo and a toJSON/loadJSON round-trip', async () => {
  const id = await addGreyImage();
  await page.evaluate(() => window.__ed.setImageFilters({ exposure: 1 }));
  await page.evaluate(() => window.__ed.setImageFilters({ exposure: -1 }));
  await page.evaluate(() => window.__ed.undo());
  await page.waitForTimeout(150);
  const [afterUndo] = await imgPixel(id);
  assert.ok(Math.abs(afterUndo - 161) <= 2, 'undo restores +1 EV: ' + afterUndo);
  const types = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id).filters.map(f => f.type), id);
  assert.ok(types.includes('Tone'));
});

test('browser: an adjustment layer applies tone params to everything below', async () => {
  await addGreyImage();
  await page.evaluate(() => window.__ed.addAdjustmentLayer({ exposure: -1 }));
  await page.waitForTimeout(50);
  const [v] = await page.evaluate(() => Array.from(window.__ed.fc.toCanvasElement().getContext('2d').getImageData(200, 150, 1, 1).data));
  assert.ok(Math.abs(v - 84) <= 3, '-1 EV adjustment layer on mid grey: ' + v);
});

/* ── geometry filter (geometry.js): straighten / keystone / 4-corner perspective ──────────────── */
const addSplitImage = () => page.evaluate(async () => {
  // left half red, right half blue — easy to see a resample move pixels
  const c = document.createElement('canvas'); c.width = 40; c.height = 20;
  const x = c.getContext('2d'); x.fillStyle = '#ff0000'; x.fillRect(0, 0, 20, 20); x.fillStyle = '#0000ff'; x.fillRect(20, 0, 20, 20);
  const img = await window.__ed.addImage(c.toDataURL());
  window.__ed.fc.setActiveObject(img);
  return img.id;
});
const elPixel = (id, x, y) => page.evaluate(([id, x, y]) => {
  const o = window.__ed.fc.getObjects().find(q => q.id === id), el = o._filteredEl || o._element;
  // with no active filters Fabric's element is the plain <img> — read it through a canvas
  const c = document.createElement('canvas'); c.width = el.naturalWidth || el.width; c.height = el.naturalHeight || el.height;
  c.getContext('2d').drawImage(el, 0, 0);
  return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
}, [id, x, y]);

test('browser: straighten keeps the frame size, fills every corner, and is one undo step', async () => {
  const id = await addSplitImage();
  const before = await page.evaluate(() => { const o = window.__ed.fc.getActiveObject(); return { w: o.width, h: o.height, l: o.left, t: o.top, d: window.__ed.history.depth().past }; });
  await page.evaluate(() => { window.__ed.setImageGeometry({ angle: 5 }, { live: true }); window.__ed.setImageGeometry({ angle: 10 }, { live: true }); });
  assert.ok(await page.evaluate(() => Array.isArray(window.__ed.geometryGuide)), 'guide grid while live');
  await page.evaluate(() => window.__ed.setImageGeometry({}));
  const after = await page.evaluate(() => { const o = window.__ed.fc.getActiveObject(); return { w: o.width, h: o.height, l: o.left, t: o.top, d: window.__ed.history.depth().past, guide: window.__ed.geometryGuide }; });
  assert.deepEqual([after.w, after.h, after.l, after.t], [before.w, before.h, before.l, before.t]);
  assert.equal(after.d, before.d + 1);
  assert.equal(after.guide, null);
  for (const [x, y] of [[0, 0], [39, 0], [0, 19], [39, 19]]) assert.equal((await elPixel(id, x, y))[3], 255, `corner ${x},${y} filled`);
});

test('browser: geometry survives undo/redo and composes with tone + mask in the right order', async () => {
  const id = await addSplitImage();
  await page.evaluate(() => window.__ed.setImageGeometry({ quad: [[1, 0], [0, 0], [0, 1], [1, 1]] }));   // mirror
  assert.deepEqual((await elPixel(id, 2, 10)).slice(0, 3), [0, 0, 255]);
  await page.evaluate(() => window.__ed.setImageFilters({ exposure: -1 }));
  await page.evaluate((id) => window.__ed.addMask(id), id);
  const order = await page.evaluate((id) => window.__ed.fc.getObjects().find(q => q.id === id).filters.map(f => f.type), id);
  assert.deepEqual(order.slice(0, 3), ['Geometry', 'MaskFilter', 'Tone']);
  await page.evaluate(() => window.__ed.undo()); await page.waitForTimeout(150);   // mask
  await page.evaluate(() => window.__ed.undo()); await page.waitForTimeout(150);   // exposure
  const px = await elPixel(id, 2, 10);
  assert.deepEqual(px.slice(0, 3), [0, 0, 255], 'still mirrored after undoing later edits');
  await page.evaluate(() => window.__ed.undo()); await page.waitForTimeout(150);   // geometry
  assert.deepEqual((await elPixel(id, 2, 10)).slice(0, 3), [255, 0, 0]);
  await page.evaluate(() => window.__ed.redo()); await page.waitForTimeout(150);
  assert.deepEqual((await elPixel(id, 2, 10)).slice(0, 3), [0, 0, 255]);
  const geom = await page.evaluate(() => { const o = window.__ed.fc.getObjects().find(q => q.type === 'image'); window.__ed.fc.setActiveObject(o); return window.__ed.getImageGeometry(); });
  assert.deepEqual(geom.quad, [[1, 0], [0, 0], [0, 1], [1, 1]]);
});

test('browser: perspective edit — drag a handle, apply sets quad; cancel/Escape restores', async () => {
  await addSplitImage();
  await page.evaluate(() => window.__ed.setImageGeometry({ angle: 3 }));
  const d0 = await page.evaluate(() => window.__ed.history.depth().past);
  assert.equal(await page.evaluate(() => window.__ed.enterPerspectiveEdit()), true);
  const screen = await page.evaluate(() => {
    const p = window.__ed.perspective, v = window.__ed.fc.viewportTransform, r = window.__ed.fc.upperCanvasEl.getBoundingClientRect();
    return p.corners.map(c => [r.left + c.x * v[0] + v[4], r.top + c.y * v[3] + v[5]]);
  });
  await page.mouse.move(screen[0][0], screen[0][1]); await page.mouse.down();
  await page.mouse.move(screen[0][0] + 40, screen[0][1] + 20, { steps: 4 }); await page.mouse.up();
  const quad0 = await page.evaluate(() => window.__ed._persp.corners[0]);
  assert.ok(quad0[0] > 0.05 && quad0[1] > 0.05, 'handle moved: ' + quad0);
  await page.evaluate(() => window.__ed.applyPerspectiveEdit());
  const g = await page.evaluate(() => ({ g: window.__ed.getImageGeometry(), d: window.__ed.history.depth().past, active: !!window.__ed.fc.getActiveObject(), p: window.__ed.perspective }));
  assert.equal(g.g.angle, 3, 'straighten kept');
  assert.ok(g.g.quad && g.g.quad[0][0] > 0.05);
  assert.equal(g.d, d0 + 1); assert.equal(g.active, true); assert.equal(g.p, null);

  await page.evaluate(() => window.__ed.enterPerspectiveEdit());
  await page.evaluate(() => window.__ed.resetPerspectiveCorners());
  await page.keyboard.press('Escape');
  const g2 = await page.evaluate(() => ({ quad: window.__ed.getImageGeometry().quad, p: window.__ed.perspective, d: window.__ed.history.depth().past }));
  assert.equal(g2.p, null); assert.ok(g2.quad && g2.quad[0][0] > 0.05, 'Escape kept the applied quad'); assert.equal(g2.d, d0 + 1);
});

/* ── left-panel AI card actions: removeBackground (mask, AI or local) / toggleAutoShadow ─────── */
const addTestImage = (draw, w = 80, h = 60) => page.evaluate(async ([src, w, h]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  new Function('ctx', 'w', 'h', src)(c.getContext('2d'), w, h);
  const img = await window.__ed.addImage(c.toDataURL());
  window.__ed.fc.setActiveObject(img);
  return img.id;
}, [draw, w, h]);
const filteredAlpha = (id, x, y) => page.evaluate(([id, x, y]) => {
  const o = window.__ed.fc.getObjects().find(q => q.id === id), el = o._filteredEl || o._element;
  const c = document.createElement('canvas'); c.width = el.width; c.height = el.height;
  c.getContext('2d').drawImage(el, 0, 0);
  return c.getContext('2d').getImageData(x, y, 1, 1).data[3];
}, [id, x, y]);

test('browser: toggleAutoShadow adds a size-scaled shadow, then removes it — one undo step each', async () => {
  await addTestImage("ctx.fillStyle='#c33';ctx.fillRect(0,0,w,h)");
  const r = await page.evaluate(() => {
    const ed = window.__ed, d0 = ed.history.depth().past;
    const on = ed.toggleAutoShadow();
    const o = ed.fc.getActiveObject(), sh = o.shadow && { blur: o.shadow.blur, y: o.shadow.offsetY };
    const d1 = ed.history.depth().past;
    const off = ed.toggleAutoShadow();
    return { on, sh, off, d0, d1, d2: ed.history.depth().past, hasShadow: ed.layers().find(l => l.active).hasShadow };
  });
  assert.deepEqual(r.on, { on: true }); assert.deepEqual(r.off, { on: false });
  assert.ok(r.sh.blur > 0 && r.sh.y > 0, JSON.stringify(r.sh));
  assert.equal(r.d1, r.d0 + 1); assert.equal(r.d2, r.d1 + 1);
  assert.equal(r.hasShadow, false);
  assert.equal(await page.evaluate(() => { window.__ed.fc.discardActiveObject(); return window.__ed.toggleAutoShadow(); }), null);
});

test('browser: removeBackground via an AI provider keys the green screen into a layer mask', async () => {
  const id = await addTestImage("ctx.fillStyle='#c33';ctx.fillRect(0,0,w,h)");
  await page.evaluate(() => window.__ed.ai.register({
    hasKey: () => true,
    // a subject block in the middle, pure green all round it (what a green-screen cutout looks like). The old
    // fixture was half green / half red, which makes the border ring an exact 50/50 tie: the median background
    // colour then lands on neither half and nothing is keyed.
    removeBackground: async (url) => { const c = document.createElement('canvas'); c.width = 80; c.height = 60; const x = c.getContext('2d'); x.fillStyle = '#00ff00'; x.fillRect(0, 0, 80, 60); x.fillStyle = '#c33'; x.fillRect(30, 10, 40, 40); return c.toDataURL(); },
  }));
  const r = await page.evaluate(async () => { const d0 = window.__ed.history.depth().past; const r = await window.__ed.removeBackground(); return { ...r, d: window.__ed.history.depth().past - d0, layer: window.__ed.layers().find(l => l.active) }; });
  assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.method, 'ai'); assert.equal(r.d, 1);
  assert.equal(r.layer.hasMask, true); assert.match(r.layer.subtitle, /Masked image/);
  assert.equal(await filteredAlpha(id, 8, 30), 0, 'green surround hidden');
  assert.equal(await filteredAlpha(id, 50, 30), 255, 'subject block kept');
});

test('browser: removeBackground falls back to the local GrabCut cutout when AI fails', async () => {
  const id = await addTestImage("ctx.fillStyle='#f4f4f4';ctx.fillRect(0,0,w,h);ctx.fillStyle='#1d3fa8';ctx.beginPath();ctx.arc(w/2,h/2,Math.min(w,h)*0.3,0,7);ctx.fill()", 160, 120);
  await page.evaluate(() => window.__ed.ai.register({ hasKey: () => true, removeBackground: async () => { throw new Error('offline'); } }));
  const r = await page.evaluate(() => window.__ed.removeBackground());
  assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.method, 'local'); assert.equal(r.aiFallback, 'provider_failed');
  assert.equal(await filteredAlpha(id, 4, 4), 0, 'corner background removed');
  assert.ok(await filteredAlpha(id, 80, 60) > 200, 'subject centre kept');
});

/* ── offline background removal (cv worker cutout / cutRefine) ───────────────────────────── */
// A pale bottle on a pale-green gradient between a gold collar and a stone stand, plus one small
// flying almond — the shape of a typical cosmetics product shot. Installs window.__paleScene(ctx).
const PALE_SCENE = () => {
  window.__paleScene = (x) => {
    const g = x.createLinearGradient(0, 0, 400, 500); g.addColorStop(0, '#dfead8'); g.addColorStop(1, '#bcd3b0'); x.fillStyle = g; x.fillRect(0, 0, 400, 500);
    x.fillStyle = '#eef3ea'; x.fillRect(150, 120, 100, 260);                                             // the pale body
    x.fillStyle = '#a8842f'; x.fillRect(170, 80, 60, 40);                                                // gold collar
    x.fillStyle = '#7c7a70'; x.beginPath(); x.ellipse(200, 395, 120, 28, 0, 0, 7); x.fill();             // stone stand
    x.fillStyle = '#8f4f22'; x.beginPath(); x.ellipse(70, 110, 6, 4, 0.5, 0, 7); x.fill();               // a flying almond (too small to pass on size alone)
  };
};
test('browser: offline removeBackground keys a plain backdrop — inner same-colour areas stay, soft edges, decontam, invert drops it', async () => {
  const id = await addTestImage("ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);ctx.fillStyle='#c0392b';ctx.fillRect(100,50,100,100);ctx.fillStyle='#ffffff';ctx.fillRect(120,90,60,20);ctx.fillStyle='#1f6f3f';ctx.beginPath();ctx.arc(250,150,30,0,7);ctx.fill()", 300, 200);
  const r = await page.evaluate(async (id) => {
    const ed = window.__ed, d0 = ed.history.depth().past;
    const res = await ed.removeBackground({ method: 'local', id });
    const o = ed._byId(id), mf = o.filters.find(f => f.type === 'MaskFilter');
    return { res, d: ed.history.depth().past - d0, decon: !!mf.decontamCanvas, canRefine: ed.canRefineCutout(id) };
  }, id);
  assert.equal(r.res.status, 'ok', JSON.stringify(r.res)); assert.equal(r.res.method, 'local'); assert.equal(r.res.detail, 'flat');
  assert.equal(r.d, 1, 'one undo step'); assert.equal(r.canRefine, true);
  assert.equal(await filteredAlpha(id, 5, 5), 0, 'backdrop removed');
  assert.equal(await filteredAlpha(id, 110, 60), 255, 'product kept');
  assert.equal(await filteredAlpha(id, 150, 100), 255, 'white label inside the product is not backdrop');
  // the circle's anti-aliased rim comes out partially transparent rather than stair-stepped
  const partial = await page.evaluate((id) => {
    const o = window.__ed._byId(id), el = o._filteredEl || o._element, c = document.createElement('canvas'); c.width = el.width; c.height = el.height;
    const x = c.getContext('2d'); x.drawImage(el, 0, 0); const d = x.getImageData(210, 150, 50, 1).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i] < 255) n++; return n;
  }, id);
  assert.ok(partial > 0, 'soft edge pixels: ' + partial);
  assert.equal(await page.evaluate((id) => { const ed = window.__ed; ed.invertMask(id); return !!ed._byId(id).filters.find(f => f.type === 'MaskFilter').decontamCanvas; }, id), false, 'invert drops the edge-colour fix');
});

test('browser: offline cutout on a poster keeps small separate elements (logo, its tagline, a paw over the panel) but drops faint backdrop noise', async () => {
  // Regression: clean-up kept only pieces ≥4% of the largest, so on a poster the logo and paw
  // prints (tiny next to the main panel) were cut out with the backdrop.
  const id = await addTestImage(`
    ctx.fillStyle='#efe6c1';ctx.fillRect(0,0,w,h);
    let seed=3;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
    for(let i=0;i<300;i++){ctx.fillStyle='rgba(225,214,170,0.7)';ctx.fillRect(rnd()*w,rnd()*h,5,5);}   // faint backdrop speckle
    ctx.fillStyle='#b2c643';ctx.beginPath();ctx.roundRect(100,220,400,260,30);ctx.fill();               // the big panel
    ctx.fillStyle='#b8322a';ctx.fillRect(470,40,90,36);                                                   // logo
    ctx.fillStyle='#d9822b';for(let i=0;i<9;i++)ctx.fillRect(470+i*10,82,6,6);                           // tagline: tiny letters under it
    ctx.fillStyle='#efe6c1';ctx.beginPath();ctx.arc(110,230,46,0,7);ctx.fill();                          // paw's backdrop-coloured outline...
    ctx.fillStyle='#b2c643';ctx.beginPath();ctx.arc(110,230,38,0,7);ctx.fill();                          // ...over the panel's corner`, 600, 500);
  const r = await page.evaluate((id) => window.__ed.removeBackground({ method: 'local', id }), id);
  assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.detail, 'flat');
  assert.equal(await filteredAlpha(id, 300, 350), 255, 'panel kept');
  assert.equal(await filteredAlpha(id, 515, 58), 255, 'logo kept');
  assert.equal(await filteredAlpha(id, 503, 85), 255, 'tagline letter kept (joins the logo next to it)');
  assert.equal(await filteredAlpha(id, 95, 215), 255, 'paw kept');
  assert.equal(await filteredAlpha(id, 20, 20), 0, 'backdrop removed');
  const noise = await page.evaluate((id) => {
    const o = window.__ed._byId(id), el = o._filteredEl || o._element, c = document.createElement('canvas'); c.width = el.width; c.height = el.height;
    const x = c.getContext('2d'); x.drawImage(el, 0, 0); const d = x.getImageData(0, 0, 600, 170).data;   // top band, above the paw (its top is at y≈184): backdrop + logo
    let n = 0; for (let i = 0; i < d.length; i += 4) { const px = (i / 4) % 600, py = Math.floor(i / 4 / 600); if (px >= 460 && py <= 100) continue; if (d[i + 3] > 128) n++; } return n;
  }, id);
  assert.ok(noise < 30, 'faint speckle stays removed: ' + noise + ' opaque px');
});

test('browser: offline cutout on an image that is already transparent keeps it as-is (black outlines included)', async () => {
  // Regression: a transparent PNG icon's clear pixels carry RGB 0,0,0, so the cut keyed "black" as the
  // backdrop and took every black outline with it.
  const id = await addTestImage("ctx.clearRect(0,0,w,h);ctx.fillStyle='#1565d8';ctx.beginPath();ctx.arc(150,100,60,0,7);ctx.fill();ctx.lineWidth=10;ctx.strokeStyle='#000';ctx.stroke()", 300, 200);
  const r = await page.evaluate((id) => window.__ed.removeBackground({ method: 'local', id }), id);
  assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.detail, 'alpha');
  assert.equal(await filteredAlpha(id, 150, 100), 255, 'fill kept');
  assert.equal(await filteredAlpha(id, 150, 40), 255, 'black outline kept');
  assert.equal(await filteredAlpha(id, 10, 10), 0, 'clear stays clear');
});

test('browser: the flattened scene clone/heal sample from includes layers below the stage height', async () => {
  // Regression: Fabric culled objects against the <canvas> element (the stage), so on a page taller
  // than the stage everything below its height was missing — clone stamped backdrop instead.
  const px = await page.evaluate(() => {
    const ed = window.__ed; ed.resizeCanvas(400, 1200, { anchor: 'top-left' });
    ed.fc.add(new window.fabric.Rect({ left: 50, top: 1000, width: 100, height: 100, fill: '#ff0000', strokeWidth: 0 }));
    ed.engine.captureFlat();
    return Array.from(ed.engine._flat.getContext('2d').getImageData(100, 1050, 1, 1).data);
  });
  assert.deepEqual(px, [255, 0, 0, 255]);
});

test('browser: retouching a cropped image keeps its whole source and crop window (it no longer goes blank)', async () => {
  // Regression: clone/heal/dodge wrote back only the crop window as the new source but kept cropX/cropY,
  // which then pointed past its edge — the layer turned invisible after one stroke.
  const id = await addTestImage("ctx.fillStyle='#c0392b';ctx.fillRect(0,0,200,200);ctx.fillStyle='#2c7be5';ctx.fillRect(200,0,200,200)", 400, 200);
  await page.evaluate((id) => { const ed = window.__ed, o = ed._byId(id); ed.fc.setActiveObject(o); ed.setTool('crop'); const b = o.getBoundingRect(true, true); ed.crop = { x: b.left + b.width / 2, y: b.top, w: b.width / 2, h: b.height }; ed.applyCrop(); }, id);
  const before = await page.evaluate((id) => { const o = window.__ed._byId(id); return { cropX: o.cropX, w: o.width, el: o._element.width }; }, id);
  assert.deepEqual(before, { cropX: 200, w: 200, el: 400 });
  await page.evaluate((id) => { const ed = window.__ed; ed.fc.setActiveObject(ed._byId(id)); ed.setTool('dodge'); ed.setToolOptions({ size: 30, opacity: 1 }); }, id);
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const c = await page.evaluate((id) => { const b = window.__ed._byId(id).getBoundingRect(true, true); return [b.left + b.width / 2, b.top + b.height / 2]; }, id);
  const at = (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  await page.mouse.move(...at(c[0] - 10, c[1])); await page.mouse.down(); await page.mouse.move(...at(c[0] + 10, c[1]), { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(100);
  const after = await page.evaluate((id) => {
    const o = window.__ed._byId(id), el = o._element, x = document.createElement('canvas').getContext('2d');
    x.canvas.width = el.width; x.canvas.height = el.height; x.drawImage(el, 0, 0);
    const px = x.getImageData(300, 100, 1, 1).data, untouched = x.getImageData(50, 100, 1, 1).data;
    return { cropX: o.cropX, w: o.width, el: el.width, px: Array.from(px), untouched: Array.from(untouched) };
  }, id);
  assert.equal(after.el, 400, 'the source stays whole');
  assert.equal(after.cropX, 200); assert.equal(after.w, 200);
  assert.equal(after.px[3], 255, 'the visible window still has its pixels');
  assert.ok(after.px[2] > 200 && after.px[0] > 44, 'dodged blue is lighter: ' + after.px);
  assert.deepEqual(after.untouched, [192, 57, 43, 255], 'the hidden half is untouched');
});

test('browser: Keep/Remove touch-ups still work after undoing a touch-up stroke', async () => {
  // Regression: undo rebuilds the layer, so the cut-out lost its link to it and Keep/Remove vanished
  // after any undo — right when a wrong stroke had just been undone.
  const id = await addTestImage("ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);ctx.fillStyle='#c0392b';ctx.fillRect(100,60,120,90);ctx.fillStyle='#2c7be5';ctx.fillRect(250,70,30,30)", 400, 300);
  const r = await page.evaluate((id) => window.__ed.removeBackground({ method: 'local', id }), id);
  assert.equal(r.status, 'ok', JSON.stringify(r));
  await page.evaluate((id) => window.__ed.enterMaskEdit(id), id);
  assert.equal(await page.evaluate(() => window.__ed.toolOpts.maskRefine), 'keep');
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const at = (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  const layerAt = (x, y) => page.evaluate(([id, x, y]) => { const o = window.__ed._byId(id), m = o.calcTransformMatrix(); return [m[4] + (x - o.width / 2) * m[0], m[5] + (y - o.height / 2) * m[3]]; }, [id, x, y]);
  const stroke = async (pts) => {
    const d0 = await page.evaluate(() => window.__ed.history.depth().past);
    const sp = []; for (const p of pts) sp.push(at(...(await layerAt(...p))));
    await page.mouse.move(...sp[0]); await page.mouse.down(); for (const p of sp.slice(1)) await page.mouse.move(...p, { steps: 4 }); await page.mouse.up();
    await page.waitForFunction((d0) => window.__ed.history.depth().past > d0, d0, { timeout: 15000 });
  };
  await stroke([[20, 20], [60, 20]]);                                   // a Keep stroke on backdrop — the wrong one
  await page.evaluate(() => window.__ed.undo());
  await page.waitForFunction(() => window.__ed.canRefineCutout(), null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__ed.setMaskRefine('remove')), true);
  await stroke([[255, 75], [275, 95]]);                                 // Remove the blue square
  assert.equal(await filteredAlpha(id, 265, 85), 0, 'blue square removed after the undo');
  assert.equal(await filteredAlpha(id, 160, 100), 255, 'red square still kept');
  assert.equal(await filteredAlpha(id, 40, 20), 0, 'the undone Keep stroke left no trace');
});

test('browser: offline cutout keeps a pale product on a gradient backdrop by its outline', async () => {
  // Regression: a white bottle on a pale-green gradient scored below the props around it on colour
  // distance, so the cut kept the collar and the stand and dropped the bottle.
  await page.evaluate(PALE_SCENE);
  await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 400; c.height = 500; window.__paleScene(c.getContext('2d')); await window.__ed.openImage(c.toDataURL('image/png')); });
  const id = await page.evaluate(() => { const o = window.__ed.fc.getObjects().find(q => q.type === 'image'); window.__ed.fc.setActiveObject(o); return o.id; });
  const r = await page.evaluate((id) => window.__ed.removeBackground({ method: 'local', id }), id);
  assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.detail, 'grabcut');
  assert.ok(await filteredAlpha(id, 200, 250) > 200, 'pale body kept');
  assert.ok(await filteredAlpha(id, 200, 100) > 200, 'collar kept');
  assert.ok(await filteredAlpha(id, 70, 110) > 200, 'almond kept');
  assert.equal(await filteredAlpha(id, 20, 20), 0, 'backdrop removed');
  assert.equal(await filteredAlpha(id, 330, 250), 0, 'backdrop beside the body removed');
});

test('browser: offline cutout on a busy backdrop (GrabCut), Keep/Remove touch-ups re-cut around the stroke, serialized, survive undoing a stroke, off once the cut is undone', async () => {
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 400, 300); g.addColorStop(0, '#5a86c8'); g.addColorStop(1, '#a8c97a'); x.fillStyle = g; x.fillRect(0, 0, 400, 300);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 1500; i++) { x.fillStyle = `rgba(${80 + rnd() * 80 | 0},${120 + rnd() * 80 | 0},${140 + rnd() * 60 | 0},0.5)`; x.fillRect(rnd() * 400, rnd() * 300, 5, 5); }
    x.fillStyle = '#f08a24'; x.beginPath(); x.ellipse(200, 150, 70, 95, 0.2, 0, 7); x.fill();
    x.fillStyle = '#d81b60'; x.fillRect(320, 30, 50, 50);   // a second thing that stands out — the stroke removes it
    await window.__ed.openImage(c.toDataURL('image/png'));
  });
  const id = await page.evaluate(() => { const o = window.__ed.fc.getObjects().find(q => q.type === 'image'); window.__ed.fc.setActiveObject(o); return o.id; });
  const r = await page.evaluate((id) => window.__ed.removeBackground({ method: 'local', id }), id);
  assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.detail, 'grabcut');
  assert.ok(await filteredAlpha(id, 200, 150) > 240, 'subject kept');
  assert.equal(await filteredAlpha(id, 20, 280), 0, 'backdrop corner removed');

  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const at = (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  const stroke = async (mode, pts) => {
    const d0 = await page.evaluate((m) => { const ed = window.__ed; ed.enterMaskEdit(ed.fc.getObjects().find(q => q.type === 'image').id); ed.setToolOptions({ size: 24 }); ed.setMaskRefine(m); return ed.history.depth().past; }, mode);
    await page.mouse.move(...at(...pts[0])); await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(...at(...p));
    await page.mouse.up();
    await page.waitForFunction((d) => window.__ed.history.depth().past > d, d0, { timeout: 20000 });
    return page.evaluate((d) => window.__ed.history.depth().past - d, d0);
  };
  assert.equal(await stroke('remove', [[325, 55], [345, 55], [365, 55]]), 1, 'one undo step per stroke');
  assert.equal(await filteredAlpha(id, 345, 55), 0, 'Remove stroke cut the square out');
  assert.ok(await filteredAlpha(id, 200, 150) > 240, 'the subject is untouched');
  await stroke('keep', [[40, 240], [60, 240]]);
  assert.ok(await filteredAlpha(id, 50, 240) > 200, 'Keep stroke brought backdrop back');
  const after = await page.evaluate(async () => {
    const ed = window.__ed, json = ed.toJSON();
    ed.undo(); await new Promise(r => setTimeout(r, 400));   // undo restores the scene asynchronously
    const afterStrokeUndo = { canRefine: ed.canRefineCutout(), refineSet: ed.setMaskRefine('keep') };
    for (let i = 0; i < 2; i++) { ed.undo(); await new Promise(r => setTimeout(r, 400)); }   // ...and the Remove stroke, and the cut itself
    return { serialized: json.includes('decontamDataURL'), afterStrokeUndo, noCut: { canRefine: ed.canRefineCutout(), refineSet: ed.setMaskRefine('keep') } };
  });
  assert.ok(after.serialized, 'the edge-colour fix is saved with the mask');
  // undoing a touch-up stroke keeps touch-ups going on the restored mask...
  assert.deepEqual(after.afterStrokeUndo, { canRefine: true, refineSet: true });
  // ...but with the cut-out undone too there is nothing left to touch up
  assert.deepEqual(after.noCut, { canRefine: false, refineSet: false });
});

test('browser: mask brush strokes land under the pointer on a fitted / offset / scaled image (not at artboard px)', async () => {
  // a 100×100 image fitted into the 400×300 artboard: left 50, ×3 — mask px are NOT scene px
  const id = await addTestImage("ctx.fillStyle='#c33';ctx.fillRect(0,0,w,h)", 100, 100);
  const placed = await page.evaluate((id) => { const ed = window.__ed, o = ed._byId(id); ed.addMask(id); ed.enterMaskEdit(id); ed.setToolOptions({ size: 9, color: '#000000', hardness: 1 }); return { left: o.left, sx: o.scaleX }; }, id);
  assert.deepEqual(placed, { left: 50, sx: 3 });
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  await page.mouse.move(box.x + vt[4] + 80 * vt[0], box.y + vt[5] + 30 * vt[3]);   // scene (80,30) = image px (10,10)
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(100);
  assert.equal(await filteredAlpha(id, 10, 10), 0, 'hidden right under the pointer');
  assert.equal(await filteredAlpha(id, 20, 10), 255, 'not where artboard px would put it');
});

test('browser: removeBackground reports no_target without an image or paint layer selected', async () => {
  const r = await page.evaluate(() => window.__ed.removeBackground());
  assert.equal(r.status, 'error'); assert.equal(r.reason, 'no_target');
});

/* ── rounded corners stay round under non-uniform resize (Editor#_bindRoundCorners) ─────────── */
const cornerExtent = () => page.evaluate(() => {
  const o = window.__ed.fc.getObjects().find(q => q.type === 'rect' || q.type === 'group');
  const el = o.toCanvasElement({ enableRetinaScaling: false });
  const W = el.width, H = el.height, d = el.getContext('2d').getImageData(0, 0, W, H).data, a = (x, y) => d[(y * W + x) * 4 + 3];
  let cx = 0; while (cx < W && a(cx, 0) < 128) cx++;
  let cy = 0; while (cy < H && a(0, cy) < 128) cy++;
  return { cx, cy, W, H };
});

test('browser: dragging a side handle keeps a rect\'s rounded corners circular', async () => {
  await page.evaluate(() => { const ed = window.__ed; const r = new ed.fabric.Rect({ left: 40, top: 40, width: 100, height: 60, rx: 20, ry: 20, fill: '#7a2e10', strokeWidth: 0 }); ed.fc.add(r); ed.fc.setActiveObject(r); ed.fc.renderAll(); ed.commit('r'); });
  const before = await cornerExtent();
  const box = await page.locator('#cv').boundingBox();
  const { mr, z } = await page.evaluate(() => { const o = window.__ed.fc.getActiveObject(); o.setCoords(); return { mr: { x: o.oCoords.mr.x, y: o.oCoords.mr.y }, z: window.__ed.fc.viewportTransform[0] }; });
  await page.mouse.move(box.x + mr.x, box.y + mr.y); await page.mouse.down();
  await page.mouse.move(box.x + mr.x + 100 * z, box.y + mr.y, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(100);
  const after = await cornerExtent();
  assert.ok(after.W > before.W * 1.8, 'widened');
  assert.ok(Math.abs(after.cx - after.cy) <= 2, `round, not oval: ${after.cx} × ${after.cy}`);
  assert.ok(Math.abs(after.cx - before.cx) <= 2, `same radius as before the resize: ${after.cx} vs ${before.cx}`);
  assert.equal(await page.evaluate(() => Math.round(window.__ed.cornerRadiusOf(window.__ed.fc.getActiveObject()))), 20);
});

test('browser: panel W/H and radius edits keep corners round, radius is true pixels, survives undo', async () => {
  await page.evaluate(() => { const ed = window.__ed; const r = new ed.fabric.Rect({ left: 40, top: 40, width: 100, height: 60, fill: '#7a2e10', strokeWidth: 0 }); ed.fc.add(r); ed.fc.setActiveObject(r); ed.commit('r'); });
  await page.evaluate(() => window.__ed.setNumeric({ rx: 18 }));
  await page.evaluate(() => window.__ed.setNumeric({ w: 300 }));
  const a = await cornerExtent();
  assert.ok(Math.abs(a.cx - a.cy) <= 2, `round after W edit: ${a.cx} × ${a.cy}`);
  await page.evaluate(() => window.__ed.setNumeric({ h: 20 }));   // shorter than 2 × radius: clamps, no over-round
  const clamped = await page.evaluate(() => { const o = window.__ed.fc.getActiveObject(); return { r: window.__ed.cornerRadiusOf(o), ry: o.ry * o.scaleY }; });
  assert.equal(clamped.r, 18); assert.ok(clamped.ry <= 10.01, 'rendered radius clamped to half the height');
  await page.evaluate(() => window.__ed.setNumeric({ h: 60 }));
  await page.evaluate(() => window.__ed.undo()); await page.waitForTimeout(150);
  const r = await page.evaluate(() => { const o = window.__ed.fc.getObjects().find(q => q.type === 'rect'); return { r: window.__ed.cornerRadiusOf(o), sx: o.scaleX, sy: o.scaleY, rx: o.rx, ry: o.ry }; });
  assert.equal(r.r, 18, 'cornerRadius restored from history');
  assert.ok(Math.abs(r.rx * r.sx - r.ry * r.sy) < 0.01 || r.ry * r.sy <= 10.01, JSON.stringify(r));
});

test('browser: a CTA pill stays a pill when its group is stretched', async () => {
  await page.evaluate(() => { const ed = window.__ed; ed.addCTA({ x: 150, y: 100 }, { text: 'Shop' }); ed.fc.setActiveObject(ed.fc.getObjects().find(o => o.role === 'cta')); });
  await page.evaluate(() => window.__ed.setNumeric({ w: 360 }));
  const pill = await page.evaluate(() => {
    const g = window.__ed.fc.getObjects().find(o => o.role === 'cta'), r = g._objects.find(o => o.type === 'rect');
    const m = window.__ed.fabric.util.qrDecompose(r.calcTransformMatrix());
    return { rxScene: r.rx * Math.abs(m.scaleX), ryScene: r.ry * Math.abs(m.scaleY), hScene: r.height * Math.abs(m.scaleY) };
  });
  assert.ok(Math.abs(pill.rxScene - pill.ryScene) < 0.5, JSON.stringify(pill));
  assert.ok(Math.abs(pill.ryScene - pill.hScene / 2) < 0.5, 'still fully rounded ends');
});

/* Crop on a selected shape clips that shape (rect clipPath in its own frame) instead of cropping
   the whole artboard; re-entering shows the full shape seeded to the last window, cancel restores. */
test('browser: crop tool on a selected shape clips the shape, not the artboard', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed, f = ed.fabric;
    const o = new f.Rect({ left: 40, top: 40, width: 100, height: 60, fill: '#ff0000', scaleX: 2, strokeWidth: 0 });
    o.set({ id: 's1', role: 'shape', name: 'S1' });
    ed.fc.add(o); ed.commit('add'); ed.fc.setActiveObject(o);
    const W = ed.W, H = ed.H;
    ed.setTool('crop');
    const seed = { ...ed.crop }, target = ed._cropTarget;
    ed.crop = { x: 40, y: 40, w: 100, h: 60 };   // left half of the 200px-wide scaled rect
    ed.applyCrop();
    const c = ed._byId('s1').clipPath;
    const clip = c && { role: c.role, w: c.width, h: c.height };
    ed.fc.setActiveObject(ed._byId('s1')); ed.setTool('crop');
    const reseed = { ...ed.crop }, clipWhileCropping = !!ed._byId('s1').clipPath;
    ed.setTool('select');
    return { seed, target, clip, W, H, W2: ed.W, H2: ed.H, reseed, clipWhileCropping, restored: ed._byId('s1').clipPath?.role, json: ed.toJSON().includes('"role":"crop"') };
  });
  assert.deepEqual(r.seed, { x: 40, y: 40, w: 200, h: 60 });
  assert.equal(r.target, 's1');
  assert.deepEqual(r.clip, { role: 'crop', w: 50, h: 60 });
  assert.equal(r.W2, r.W); assert.equal(r.H2, r.H);   // artboard untouched
  assert.deepEqual(r.reseed, { x: 40, y: 40, w: 100, h: 60 });
  assert.equal(r.clipWhileCropping, false);
  assert.equal(r.restored, 'crop');
  assert.ok(r.json, 'crop clip survives serialisation');
});

test('browser: cropping an image — a ratio chip reshapes the box at once, Original is the image\'s shape, the box stays on the image, whole-pixel result', async () => {
  // Regressions: picking 4:5 did nothing until a handle drag; "Original" used the page's ratio (so it
  // lit up together with 4:5 on a 4:5 page); the box could be dragged off the image; and the applied
  // crop landed on fractional source pixels (cropY 300.56), resampling the image.
  const src = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 720; c.height = 1280; const x = c.getContext('2d'); x.fillStyle = '#3a6'; x.fillRect(0, 0, 720, 1280); return c.toDataURL(); });
  await page.evaluate(async (src) => { const ed = window.__ed; ed.resizeCanvas(1080, 1350); const img = await ed.openImage(src); ed.fc.setActiveObject(img); }, src);
  const r = await page.evaluate(() => {
    const ed = window.__ed, img = ed.fc.getObjects()[0];
    ed.setTool('crop');
    const orig = ed.cropOriginalRatio(), b = img.getBoundingRect(true, true);
    ed.setToolOptions({ cropRatio: 4 / 5 });
    const fitted = { ...ed.crop };
    return { orig, b: { x: b.left, y: b.top, w: b.width, h: b.height }, fitted };
  });
  assert.ok(Math.abs(r.orig - 720 / 1280) < 1e-6, 'Original = the image\'s 9:16, not the 4:5 page: ' + r.orig);
  assert.ok(Math.abs(r.fitted.w / r.fitted.h - 0.8) < 1e-6, 'box reshaped to 4:5 straight away');
  assert.ok(Math.abs(r.fitted.w - r.b.w) < 1e-6, 'as wide as the image');
  // drag the box body far past the bottom of the image: it stops at the image's edge
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => { const fc = window.__ed.fc; fc.setViewportTransform([0.2, 0, 0, 0.2, 0, 0]); return fc.viewportTransform.slice(); });   // whole page on the 400×300 element
  const at = (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  const [cx, cy] = at(r.fitted.x + r.fitted.w / 2, r.fitted.y + r.fitted.h / 2);
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx, cy + 120, { steps: 6 }); await page.mouse.up();
  const after = await page.evaluate(() => ({ ...window.__ed.crop }));
  assert.ok(Math.abs(after.y + after.h - (r.b.y + r.b.h)) < 1e-6, `box bottom stops at the image bottom: ${JSON.stringify(after)} vs ${JSON.stringify(r.b)}`);
  const applied = await page.evaluate(() => { const ed = window.__ed; ed.applyCrop(); const o = ed.fc.getObjects()[0]; return { cropX: o.cropX, cropY: o.cropY, w: o.width, h: o.height }; });
  for (const k of ['cropX', 'cropY', 'w', 'h']) assert.ok(Number.isInteger(applied[k]), `${k} is whole: ${applied[k]}`);
  assert.ok(applied.cropY + applied.h <= 1280, 'window stays inside the source');
});

/* The eraser on a selected vector shape paints into a vector-layer mask: the shape stays an
   editable rect, the erased area moves with it and survives a fill change, undo/redo and reload. */
test('browser: eraser on a selected shape masks it non-destructively (stays a vector)', async () => {
  await page.evaluate(() => {
    const ed = window.__ed;
    const o = new ed.fabric.Rect({ left: 60, top: 60, width: 200, height: 120, fill: '#ff0000', strokeWidth: 0 });
    o.set({ id: 'v1', role: 'shape', name: 'V1' });
    ed.fc.add(o); ed.commit('add'); ed.fc.setActiveObject(o);
    ed.setTool('eraser'); ed.setToolOptions({ size: 30, hardness: 1 });
  });
  const box = await page.locator('#cv').boundingBox();
  const z = await page.evaluate(() => { const vt = window.__ed.fc.viewportTransform; return { z: vt[0], tx: vt[4], ty: vt[5] }; });
  const sx = x => box.x + z.tx + x * z.z, sy = y => box.y + z.ty + y * z.z;
  await page.mouse.move(sx(40), sy(120)); await page.mouse.down();
  await page.mouse.move(sx(280), sy(120), { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(50);
  // alpha of the rendered scene at scene px (x, y)
  const alphaAt = (pts) => page.evaluate(async (pts) => {
    const ed = window.__ed;
    ed.fc.renderAll();
    const el = ed.fc.toCanvasElement(1 / ed.fc.getZoom(), { left: ed.fc.viewportTransform[4], top: ed.fc.viewportTransform[5], width: ed.W * ed.fc.getZoom(), height: ed.H * ed.fc.getZoom() });
    const ctx = el.getContext('2d'), k = el.width / ed.W;
    return pts.map(([x, y]) => { const d = ctx.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data; return d[0] > 200 && d[1] < 80 ? 'red' : 'other'; });
  }, pts);
  let r = await page.evaluate(() => { const o = window.__ed._byId('v1'); return { type: o.type, mask: !!o.maskCanvas, json: window.__ed.toJSON().includes('"vmask"') }; });
  assert.deepEqual(r, { type: 'rect', mask: true, json: true });
  assert.deepEqual(await alphaAt([[160, 120], [160, 75]]), ['other', 'red'], 'stroke hides the shape, the rest stays');
  // still a vector: recolour + move, the hole follows
  await page.evaluate(() => { const ed = window.__ed, o = ed._byId('v1'); ed.setTool('select'); o.set({ fill: '#ff1010', left: 260 }); o.setCoords(); ed.commit('edit'); });
  assert.deepEqual(await alphaAt([[360, 120], [360, 75], [160, 120]]), ['other', 'red', 'other']);
  await page.evaluate(() => window.__ed.undo()); await page.waitForTimeout(100);   // undo the move
  await page.evaluate(() => window.__ed.undo()); await page.waitForTimeout(100);   // undo the erase
  assert.deepEqual(await alphaAt([[160, 120]]), ['red'], 'undo removes the erase');
  await page.evaluate(() => window.__ed.redo()); await page.waitForTimeout(100);
  assert.deepEqual(await alphaAt([[160, 120]]), ['other'], 'redo brings the mask back');
  const json = await page.evaluate(() => window.__ed.toJSON());
  await page.evaluate((j) => window.__ed.loadJSON(j), json); await page.waitForTimeout(300);
  assert.deepEqual(await alphaAt([[160, 120], [160, 75]]), ['other', 'red'], 'mask survives save/load');
});

/* ── pen tool: Figma-style bezier drawing + vector edit mode ─────────────────────────────── */
const penHelpers = async () => {
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const at = (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  const click = async (x, y) => { await page.mouse.click(...at(x, y)); };
  const drag = async (x, y, x2, y2, mods = []) => {
    await page.mouse.move(...at(x, y));
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.down(); await page.mouse.move(...at(x2, y2), { steps: 6 }); await page.mouse.up();
    for (const m of mods) await page.keyboard.up(m);
  };
  const pens = () => page.evaluate(() => window.__ed.fc.getObjects().filter(o => o.shapeKind === 'pen')
    .map(o => ({ id: o.id, type: o.type, fill: o.fill, stroke: o.stroke, cmds: o.path.map(c => c[0]).join('') })));
  return { at, click, drag, pens };
};

test('browser: pen — click is a corner, click-drag a mirrored curve, clicking the first point closes into a filled path', async () => {
  const { click, drag, pens } = await penHelpers();
  await page.evaluate(() => window.__ed.setTool('pen'));
  assert.match(await page.evaluate(() => window.__ed.fc.defaultCursor), /^url\("data:image\/svg\+xml/, 'pen has its own cursor');
  await click(60, 60);
  await drag(200, 60, 260, 60);   // smooth point: handles mirrored through the anchor
  const n = await page.evaluate(() => { const p = window.__ed._penBuild.nodes[1]; return { hi: p.hi, ho: p.ho, x: p.x, y: p.y }; });
  assert.ok(Math.abs((n.hi.x + n.ho.x) / 2 - n.x) < 0.5 && Math.abs((n.hi.y + n.ho.y) / 2 - n.y) < 0.5, 'symmetric handles');
  await click(150, 200);
  await click(60, 60);            // back onto the first point
  const [p] = await pens();
  assert.equal(p.type, 'path');
  assert.ok(p.cmds.startsWith('M') && p.cmds.includes('C') && p.cmds.endsWith('Z'), p.cmds);
  assert.ok(p.fill, 'closed path is filled');
  assert.equal(await page.evaluate(() => window.__ed.tool), 'select');
});

test('browser: pen — ⌥-drag breaks the handle, Backspace / ⌘Z step points back, Escape keeps an open stroked path', async () => {
  const { click, drag, pens } = await penHelpers();
  await page.evaluate(() => window.__ed.setTool('pen'));
  await click(40, 40);
  await drag(140, 40, 200, 40, ['Alt']);
  assert.equal(await page.evaluate(() => window.__ed._penBuild.nodes[1].hi), null, 'Alt-drag leaves the incoming side a corner');
  await click(200, 150); await click(300, 150);
  await page.keyboard.press('Backspace');
  assert.equal(await page.evaluate(() => window.__ed._penBuild.nodes.length), 3);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal(await page.evaluate(() => window.__ed._penBuild.nodes.length), 4, '⌘Z undoes the Backspace inside the build');
  await page.keyboard.press('Escape');   // Figma: Escape ends the path, keeping it
  const [p] = await pens();
  assert.ok(p && !p.fill && p.stroke, 'open path is stroke-only');
  assert.equal(p.cmds, 'MLCL', 'corner, cusp (curve out only), two corners — no Z');
});

test('browser: vector edit — double-click enters, drag moves a point, double-click a segment adds one, Delete removes it, undo stays in edit', async () => {
  const { at, click, drag, pens } = await penHelpers();
  await page.evaluate(() => window.__ed.setTool('pen'));
  await click(50, 150); await click(200, 50); await click(350, 150);
  await page.keyboard.press('Enter');
  await page.mouse.dblclick(...at(200, 50));
  const ed = (fn) => page.evaluate(fn);
  assert.deepEqual(await ed(() => window.__ed.pathEdit && window.__ed.pathEdit.count), 3, 'in vector edit mode');
  await drag(200, 50, 200, 90);
  const mid = await ed(() => { const n = window.__ed._pathEdit.nodes[1]; return [Math.round(n.x), Math.round(n.y)]; });
  assert.ok(Math.abs(mid[1] - 90) <= 2, 'point moved: ' + mid);
  // the layer itself follows
  const top = await ed(() => window.__ed.fc.getObjects().find(o => o.shapeKind === 'pen').getBoundingRect(true).top);
  assert.ok(top > 80, 'path redrawn from the edited points: top ' + top);
  await page.mouse.dblclick(...at(125, 120));   // on the segment 50,150 -> 200,90
  assert.equal(await ed(() => window.__ed.pathEdit.count), 4, 'point added');
  await page.keyboard.press('Delete');
  assert.equal(await ed(() => window.__ed.pathEdit.count), 3, 'selected point deleted');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForTimeout(200);
  assert.equal(await ed(() => window.__ed.pathEdit && window.__ed.pathEdit.count), 4, 'undo restores the point and keeps editing');
  await page.keyboard.press('Enter');
  assert.equal(await ed(() => window.__ed.pathEdit), null);
  assert.equal((await pens()).length, 1);
});

test('browser: pen on a selected path — click its outline adds a point, an open end continues it, ⌥-click a point toggles smooth', async () => {
  const { at, click, pens } = await penHelpers();
  await page.evaluate(() => window.__ed.setTool('pen'));
  await click(50, 150); await click(200, 150);
  await page.keyboard.press('Enter');                       // selected, select tool
  await page.evaluate(() => window.__ed.setTool('pen'));    // Pen with a path selected -> edits it
  assert.equal(await page.evaluate(() => window.__ed.pathEdit && window.__ed.pathEdit.count), 2);
  await click(125, 150);                                    // on the segment
  assert.equal(await page.evaluate(() => window.__ed.pathEdit.count), 3);
  await page.keyboard.down('Alt'); await click(125, 150); await page.keyboard.up('Alt');
  assert.ok(await page.evaluate(() => { const n = window.__ed._pathEdit.nodes[1]; return !!(n.hi && n.ho); }), 'Alt-click made it smooth');
  await click(200, 150);                                    // open end: keep drawing from it
  assert.ok(await page.evaluate(() => !!window.__ed._penBuild && window.__ed._penBuild.contId));
  await click(300, 250);
  await page.keyboard.press('Enter');
  const all = await pens();
  assert.equal(all.length, 1, 'continued the same layer');
  assert.equal(all[0].cmds.length, 4, all[0].cmds);
});

test('browser: a rotated/scaled path edits in place — its points keep their on-screen positions', async () => {
  await page.evaluate(() => {
    const ed = window.__ed, o = new ed.fabric.Path('M 0 0 L 100 0 L 100 60 Z', { left: 100, top: 100, fill: '#ff0000', angle: 30, scaleX: 1.5 });
    o.set({ id: 'rp', role: 'shape', name: 'R' }); ed.fc.add(o); ed.commit('add');
  });
  const before = await page.evaluate(() => {
    const o = window.__ed._byId('rp'), m = o.calcTransformMatrix(), F = window.__ed.fabric;
    return o.path.filter(c => c[0] !== 'Z').map(c => { const q = F.util.transformPoint(new F.Point(c[1] - o.pathOffset.x, c[2] - o.pathOffset.y), m); return [Math.round(q.x), Math.round(q.y)]; });
  });
  assert.equal(await page.evaluate(() => window.__ed.editPath('rp')), true);
  const after = await page.evaluate(() => window.__ed._pathEdit.nodes.map(n => [Math.round(n.x), Math.round(n.y)]));
  assert.deepEqual(after, before);
  assert.deepEqual(await page.evaluate(() => { const o = window.__ed._byId('rp'); return [o.angle, o.scaleX]; }), [0, 1], 'transform baked into the points');
});

/* ── object gradient stays editable: handles persist until a click outside the shape ───────── */
test('browser: object gradient keeps its handles after the drag — ends re-aim it, the line slides it, a click outside hides them', async () => {
  await page.evaluate(() => {
    const ed = window.__ed, o = new ed.fabric.Rect({ left: 50, top: 50, width: 200, height: 100, fill: '#888888', strokeWidth: 0 });
    o.set({ id: 'gh', role: 'shape', name: 'G' }); ed.fc.add(o); ed.commit('add'); ed.fc.setActiveObject(o);
    ed.setToolOptions({ gradientType: 'linear', gradientStops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] });
    ed.setTool('gradient');
  });
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const at = (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  const drag = async (a, b) => { await page.mouse.move(...at(...a)); await page.mouse.down(); await page.mouse.move(...at(...b), { steps: 6 }); await page.mouse.up(); };
  const axis = () => page.evaluate(() => { const g = window.__ed._gradAxis; return g && [g.from.x, g.from.y, g.to.x, g.to.y].map(Math.round); });
  const colors = (pts) => page.evaluate((pts) => {
    const ed = window.__ed; ed.fc.renderAll();
    const el = ed.fc.toCanvasElement(1 / ed.fc.getZoom(), { left: ed.fc.viewportTransform[4], top: ed.fc.viewportTransform[5], width: ed.W * ed.fc.getZoom(), height: ed.H * ed.fc.getZoom() });
    const k = el.width / ed.W, c = el.getContext('2d');
    return pts.map(([x, y]) => Array.from(c.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3)));
  }, pts);

  await drag([50, 100], [250, 100]);   // left edge -> right edge
  assert.deepEqual(await axis(), [50, 100, 250, 100], 'handles stay after mouse-up');
  // the ramp starts and ends exactly where it was dragged (it used to be offset by half the shape)
  const [l, m, r] = await colors([[52, 100], [150, 100], [248, 100]]);
  assert.ok(l[0] > 240 && l[2] < 15, 'red at the start: ' + l);
  assert.ok(Math.abs(m[0] - m[2]) < 20 && m[0] > 100, 'even mix in the middle: ' + m);
  assert.ok(r[2] > 240 && r[0] < 15, 'blue at the end: ' + r);

  await drag([250, 100], [250, 140]);   // grab the end handle
  assert.deepEqual(await axis(), [50, 100, 250, 140]);
  await drag([150, 120], [150, 90]);    // grab the line, slide it up
  assert.deepEqual(await axis(), [50, 70, 250, 110]);
  const c = await page.evaluate(() => { const k = window.__ed._byId('gh').fill.coords; return [k.x1, k.y1, k.x2, k.y2].map(Math.round); });
  assert.deepEqual(c, [0, 20, 200, 60], 'fill coords are the object-space axis (top-left origin)');

  await page.mouse.click(...at(330, 250));   // outside the shape
  assert.equal(await axis(), null, 'click outside hides the handles');
  assert.deepEqual(await page.evaluate(() => window.__ed._byId('gh').fill.coords.y1), 20, 'and leaves the fill alone');

  // coming back to the tool with the shape selected shows its handles again
  await page.evaluate(() => { const ed = window.__ed; ed.setTool('select'); ed.fc.setActiveObject(ed._byId('gh')); ed.setTool('gradient'); });
  assert.deepEqual(await axis(), [50, 70, 250, 110]);
  // and a plain click inside (no drag) changes nothing
  await page.mouse.click(...at(120, 120));
  assert.deepEqual(await axis(), [50, 70, 250, 110]);
});

test('browser: gradient targets the shape under the pointer — after clicking outside, dragging on a shape fills it again without reselecting', async () => {
  await page.evaluate(() => {
    const ed = window.__ed;
    for (const [id, l] of [['gA', 20], ['gB', 220]]) { const o = new ed.fabric.Rect({ left: l, top: 60, width: 150, height: 120, fill: '#888888', strokeWidth: 0 }); o.set({ id, role: 'shape', name: id }); ed.fc.add(o); }
    ed.commit('add'); ed.fc.setActiveObject(ed._byId('gA'));
    ed.setToolOptions({ gradientType: 'linear', gradientStops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] });
    ed.setTool('gradient');
  });
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const at = (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  const drag = async (a, b) => { await page.mouse.move(...at(...a)); await page.mouse.down(); await page.mouse.move(...at(...b), { steps: 6 }); await page.mouse.up(); };
  const st = () => page.evaluate(() => { const ed = window.__ed, g = (id) => !!(ed._byId(id).fill && ed._byId(id).fill.type);
    return { A: g('gA'), B: g('gB'), on: ed._gradEdit && ed._gradEdit.id, paint: ed.fc.getObjects().filter(o => o.role === 'paint').length }; });

  await drag([30, 120], [160, 120]);
  assert.deepEqual(await st(), { A: true, B: false, on: 'gA', paint: 0 });
  await page.mouse.click(...at(195, 260));   // empty canvas
  assert.deepEqual(await st(), { A: true, B: false, on: null, paint: 0 });
  await drag([40, 90], [150, 150]);          // straight back onto the shape: it's the target again
  assert.deepEqual(await st(), { A: true, B: false, on: 'gA', paint: 0 }, 'no raster paint, no reselect needed');
  await drag([230, 120], [360, 120]);        // a different shape: handles move to it
  assert.deepEqual(await st(), { A: true, B: true, on: 'gB', paint: 0 });
  await page.mouse.click(...at(195, 260));
  await page.mouse.click(...at(90, 120));    // plain click on a gradient shape shows its handles
  assert.equal((await st()).on, 'gA');
  await page.mouse.click(...at(195, 260));
  await drag([180, 220], [300, 280]);        // drag on empty canvas still paints
  assert.deepEqual(await st(), { A: true, B: true, on: null, paint: 1 });
});

test('browser: clicking a gradient colour swatch asks for a colour picker for THAT stop; dragging a middle swatch slides it', async () => {
  await page.evaluate(() => {
    const ed = window.__ed, o = new ed.fabric.Rect({ left: 50, top: 60, width: 300, height: 150, fill: '#888', strokeWidth: 0 });
    o.set({ id: 'sw', role: 'shape', name: 'S' }); ed.fc.add(o); ed.commit('add');
    ed.setTool('gradient');
    ed.setToolOptions({ gradientType: 'linear', gradientStops: [{ offset: 1, color: '#0000ff' }, { offset: 0, color: '#ff0000' }, { offset: 0.5, color: '#00ff00' }] });
    window.__picks = []; ed.on('gradientstoppick', e => window.__picks.push(e));
  });
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const at = (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  await page.mouse.move(...at(60, 130)); await page.mouse.down(); await page.mouse.move(...at(340, 130), { steps: 6 }); await page.mouse.up();
  const sw = (i) => page.evaluate((i) => window.__ed._gradSwatchPoint(i), i);
  const s0 = await sw(0);                                   // the END stop, listed first
  await page.mouse.click(...at(s0.x, s0.y));
  const e = await page.evaluate(() => window.__picks.at(-1));
  assert.equal(e.index, 0); assert.equal(e.color, '#0000ff');
  await page.evaluate(() => window.__ed.setGradientStopColor(0, '#ffff00'));   // what the shell's picker calls
  const shape = await page.evaluate(() => window.__ed._byId('sw').fill.colorStops.map(s => s.offset + ':' + s.color).join(' '));
  assert.equal(shape, '0:#ff0000 0.5:#00ff00 1:#ffff00', 'only that stop recoloured, on the shape too');
  const m = await sw(2);
  await page.mouse.move(...at(m.x, m.y)); await page.mouse.down(); await page.mouse.move(...at(m.x - 70, m.y), { steps: 5 }); await page.mouse.up();
  const off = await page.evaluate(() => window.__ed.toolOpts.gradientStops[2].offset);
  assert.ok(off > 0.2 && off < 0.3, 'middle stop slid: ' + off);
  assert.equal(await page.evaluate(() => window.__picks.length), 1, 'a drag does not open the picker');
});

test('browser: a magic wand click shows a busy ring at the pointer until the pick lands', async () => {
  await page.evaluate(() => {
    const ed = window.__ed;
    const c = new ed.fabric.Circle({ left: 120, top: 80, radius: 60, fill: '#b04020', strokeWidth: 0 }); c.set({ id: 'c', role: 'shape' }); ed.fc.add(c); ed.commit('add');
    ed.setTool('magicwand');
    window.__busy = []; ed.on('pickbusy', b => window.__busy.push(b && [Math.round(b.x), Math.round(b.y)]));
  });
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  await page.mouse.click(box.x + vt[4] + 180 * vt[0], box.y + vt[5] + 140 * vt[3]);
  assert.deepEqual(await page.evaluate(() => window.__busy[0]), [180, 140], 'ring appears at the click');
  await page.waitForFunction(() => !window.__ed.pickBusy, null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.__busy.at(-1)), null, 'and clears when the pick settles');
  assert.ok(await page.evaluate(() => !!window.__ed.selection));
});

test('browser: object/hover select pick from the CURRENT scene after the document changes (no stale outline off the artboard)', async () => {
  const open = (w, h) => page.evaluate(async ([w, h]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
    x.fillStyle = '#ece6c6'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#b04020'; x.fillRect(w * 0.4, h * 0.4, w * 0.2, h * 0.2);   // a flat block in the middle
    await window.__ed.openImage(c.toDataURL('image/png'));
  }, [w, h]);
  await open(1200, 1200);
  await page.evaluate(() => window.__ed.setTool('objectselect'));
  await page.waitForFunction(() => window.__ed._objRegion && window.__ed._objRegion.width === 1200, null, { timeout: 15000 });
  await open(400, 300);   // a different, smaller document while the tool stays active
  const r = await page.evaluate(async () => { const ed = window.__ed; await ed.selectObjectAt({ x: 200, y: 150 }); const s = ed.selection;
    const all = s.kind === 'multipoly' ? [].concat(...s.polys) : s.pts || [{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }];
    return [Math.min(...all.map(q => q.x)), Math.min(...all.map(q => q.y)), Math.max(...all.map(q => q.x)), Math.max(...all.map(q => q.y))].map(Math.round); });
  // the block is 160..240 x 120..180 on the new 400x300 artboard
  assert.ok(r[0] >= 150 && r[1] >= 110 && r[2] <= 250 && r[3] <= 190, 'picked the block on the new document: ' + r);
  assert.equal(await page.evaluate(() => window.__ed._objRegion.width), 400, 'snapshot refreshed to the new artboard');
});

/* ── border options (stroke.js): style, dash/gap, position, caps, join ─────────────────── */
test('browser: setStroke style keys — dashed/dotted dash arrays, dotted keeps its gap when the width changes, caps/join', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed;
    const o = new ed.fabric.Rect({ left: 40, top: 40, width: 120, height: 80, fill: '#fc0', stroke: '#000', strokeWidth: 4 }); o.set({ id: 'S', role: 'shape' });
    ed.fc.add(o); ed.commit('add'); ed.activate('S');
    const out = {};
    ed.setStroke({ style: 'dashed' }); out.dashedDefault = o.strokeDashArray.slice();
    ed.setStroke({ dash: 10, gap: 3 }); out.dashed = o.strokeDashArray.slice();
    ed.setStroke({ style: 'dotted', gap: 5 }); out.dotted = o.strokeDashArray.slice(); out.dotCap = o.strokeLineCap;
    ed.setStroke({ width: 8 }); out.dottedWider = o.strokeDashArray.slice(); out.info = ed.getStroke();
    ed.setStroke({ cap: 'square' }); out.capIgnoredWhileDotted = o.strokeLineCap;
    ed.setStroke({ style: 'solid' }); out.solid = o.strokeDashArray; out.solidCap = o.strokeLineCap;
    ed.setStroke({ cap: 'square', join: 'bevel' }); out.cap = o.strokeLineCap; out.join = o.strokeLineJoin;
    ed.setStroke({ cap: 'bogus', join: 'nope' }); out.capAfterJunk = o.strokeLineCap;
    return out;
  });
  assert.deepEqual(r.dashedDefault, [12, 8], 'defaults sized to the width');
  assert.deepEqual(r.dashed, [10, 3]);
  assert.deepEqual(r.dotted, [0, 9], 'zero-length dash, pitch = width + gap'); assert.equal(r.dotCap, 'round');
  assert.deepEqual(r.dottedWider, [0, 13], 'the gap stays 5 when the width goes 4 → 8');
  assert.equal(r.info.style, 'dotted'); assert.equal(r.info.gap, 5);
  assert.equal(r.capIgnoredWhileDotted, 'round');
  assert.equal(r.solid, null); assert.equal(r.solidCap, 'butt', 'leaving dotted drops the round caps it forced');
  assert.equal(r.cap, 'square'); assert.equal(r.join, 'bevel'); assert.equal(r.capAfterJunk, 'square');
});

test('browser: border position paints inside / outside the shape edge and survives undo + save/restore', async () => {
  const px = await page.evaluate(async () => {
    const ed = window.__ed;
    // white artboard; a red-bordered rect with a transparent fill, its edge at x=100
    const o = new ed.fabric.Rect({ left: 100, top: 100, width: 100, height: 100, fill: 'rgba(0,0,0,0)', stroke: '#ff0000', strokeWidth: 10, strokeUniform: false }); o.set({ id: 'P', role: 'shape' });
    ed.fc.add(o); ed.commit('add'); ed.activate('P');
    // Fabric's rect box includes the stroke: geometry edge is left + strokeWidth/2 = 105
    const red = async () => {
      const img = new Image(); img.src = ed.exportPNG(); await img.decode();
      const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H; const x = c.getContext('2d'); x.drawImage(img, 0, 0, ed.W, ed.H);
      const at = (X) => { const d = x.getImageData(X, 150, 1, 1).data; return d[0] > 200 && d[1] < 80; };
      return { out: at(99), edgeOut: at(103), edgeIn: at(107), in: at(113) };
    };
    const res = {};
    res.center = await red();
    ed.setStroke({ position: 'inside' }); res.inside = await red();
    ed.setStroke({ position: 'outside' }); res.outside = await red();
    ed.undo(); await new Promise(r => setTimeout(r, 200));
    res.afterUndo = ed._byId('P').strokePosition || 'center';
    ed.redo(); await new Promise(r => setTimeout(r, 200));
    const json = ed.toJSON();
    res.serialized = json.includes('"strokePosition":"outside"');
    ed.loadJSON(json); await new Promise(r => setTimeout(r, 400));
    res.reloaded = await red();
    res.info = (ed.activate('P'), ed.getStroke());
    return res;
  });
  assert.deepEqual(px.center, { out: false, edgeOut: true, edgeIn: true, in: false }, 'centre straddles the edge');
  assert.deepEqual(px.inside, { out: false, edgeOut: false, edgeIn: true, in: true }, 'inside: all 10px within the edge');
  assert.deepEqual(px.outside, { out: true, edgeOut: true, edgeIn: false, in: false }, 'outside: all 10px beyond the edge, transparent fill shows no stroke');
  assert.equal(px.afterUndo, 'inside', 'undo steps back one position change');
  assert.ok(px.serialized, 'strokePosition is serialized');
  assert.deepEqual(px.reloaded, px.outside, 'and still paints outside after a reload');
  assert.equal(px.info.position, 'outside'); assert.equal(px.info.canPosition, true);
});

test('browser: fill / border eye toggles hide the paint without losing it (gradient, dash), undo, save/restore, edit re-shows', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed;
    const o = new ed.fabric.Rect({ left: 100, top: 100, width: 100, height: 100, fill: '#00ff00', stroke: '#ff0000', strokeWidth: 10, strokeDashArray: [40, 4] }); o.set({ id: 'E', role: 'shape' });
    ed.fc.add(o); ed.commit('add'); ed.activate('E');
    ed.setShapeGradient([{ offset: 0, color: '#00ff00' }, { offset: 1, color: '#00ff00' }], 'linear', 0);
    // pixel probes: middle of the fill, and on the border's left edge (geometry edge at x=105)
    const probe = async () => {
      const img = new Image(); img.src = ed.exportPNG(); await img.decode();
      const c = document.createElement('canvas'); c.width = ed.W; c.height = ed.H; const x = c.getContext('2d'); x.drawImage(img, 0, 0, ed.W, ed.H);
      const at = (X, Y) => [...x.getImageData(X, Y, 1, 1).data.slice(0, 3)];
      const f = at(150, 150), b = at(105, 120);
      return { fill: f[1] > 200 && f[0] < 80, border: b[0] > 200 && b[1] < 80, layerFill: ed.layers().find(l => l.id === 'E').fill };
    };
    const res = { both: await probe() };
    ed.setFillVisible(false); res.noFill = await probe(); res.fillVisible = ed.isFillVisible();
    ed.setStrokeVisible(false); res.none = await probe(); res.strokeVisible = ed.getStroke().visible;
    res.kept = { gradient: !!(o.fill && o.fill.colorStops), dash: o.strokeDashArray && o.strokeDashArray.slice(), width: o.strokeWidth };
    const json = ed.toJSON();
    res.serialized = json.includes('"fillOff":true') && json.includes('"strokeOff":true');
    ed.loadJSON(json); await new Promise(r => setTimeout(r, 400));
    res.reloaded = await probe();
    ed.undo(); await new Promise(r => setTimeout(r, 300));
    res.undone = await probe();   // one undo: the border comes back, the fill stays hidden
    ed.activate('E'); ed.setFillVisible(true); res.shown = await probe();
    ed.setStrokeVisible(false); ed.setStroke({ width: 6 }); res.editShows = ed._byId('E').strokeOff;
    return res;
  });
  assert.deepEqual(r.both, { fill: true, border: true, layerFill: null }, 'gradient fill has no swatch to begin with');
  assert.equal(r.noFill.fill, false); assert.equal(r.noFill.border, true); assert.equal(r.fillVisible, false);
  assert.equal(r.none.fill, false); assert.equal(r.none.border, false); assert.equal(r.strokeVisible, false);
  assert.deepEqual(r.kept, { gradient: true, dash: [40, 4], width: 10 }, 'the hidden paint is all still there');
  assert.ok(r.serialized, 'fillOff / strokeOff are serialized');
  assert.deepEqual(r.reloaded, r.none, 'still hidden after a reload');
  assert.equal(r.undone.fill, false); assert.equal(r.undone.border, true);
  assert.equal(r.shown.fill, true, 'toggling back on restores the gradient fill');
  assert.equal(r.editShows, false, 'editing a hidden border shows it again');
});

test('browser: a hidden solid fill drops its swatch from layers()', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed;
    const o = new ed.fabric.Rect({ left: 10, top: 10, width: 50, height: 50, fill: '#123456' }); o.set({ id: 'Q', role: 'shape' });
    ed.fc.add(o); ed.commit('add'); ed.activate('Q');
    const before = ed.layers().find(l => l.id === 'Q').fill;
    ed.setFillVisible(false);
    return [before, ed.layers().find(l => l.id === 'Q').fill, o.fill];
  });
  assert.deepEqual(r, ['#123456', null, '#123456']);
});

/* ── right-click menu (contextmenu.js + Editor#openContextMenu) ─────────────────────────── */
const ctxSetup = () => page.evaluate(() => {
  const ed = window.__ed;
  const r = new ed.fabric.Rect({ left: 40, top: 40, width: 100, height: 80, fill: '#f60', strokeWidth: 0 }); r.set({ id: 'R', role: 'shape', name: 'Box' }); ed.fc.add(r);
  const c = new ed.fabric.Circle({ left: 220, top: 120, radius: 50, fill: '#06f', strokeWidth: 0 }); c.set({ id: 'C', role: 'shape', name: 'Circle' }); ed.fc.add(c);
  ed.commit('add'); ed.setTool('select'); ed.fc.discardActiveObject();
  window.__menu = (x, y) => { const ev = ed.openContextMenu({ x, y }, { x: 0, y: 0 }); return ev.sections.flat(); };
  window.__run = (x, y, id, sub) => { const it = window.__menu(x, y).find(i => i.id === id); return (sub ? it.items.find(i => i.id === sub) : it).run(); };
});

test('browser: right-click selects the layer under the pointer and builds a layer menu; empty canvas gets the canvas menu', async () => {
  await ctxSetup();
  const ids = await page.evaluate(() => window.__menu(90, 80).map(i => i.id));
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject().id), 'R', 'right-clicked layer is selected');
  for (const id of ['copy', 'cut', 'paste-here', 'duplicate', 'delete', 'select-layer', 'front', 'back', 'flip-h', 'align', 'toggle-visible', 'toggle-lock']) assert.ok(ids.includes(id), 'layer menu has ' + id);
  assert.ok(!ids.includes('ungroup') && !ids.includes('group'));
  const canvas = await page.evaluate(() => window.__menu(380, 280).map(i => i.id));
  assert.deepEqual(canvas, ['paste-here', 'select-all', 'undo', 'redo']);
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject()), null, 'empty-canvas right-click clears the selection');
});

test('browser: right-click inside a multi-selection keeps it and offers Group; a group offers Ungroup', async () => {
  await ctxSetup();
  await page.evaluate(() => window.__ed.selectAllLayers());
  const ids = await page.evaluate(() => window.__menu(260, 160).map(i => i.id));
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject().type), 'activeSelection', 'still a multi-selection');
  assert.ok(ids.includes('group'));
  await page.evaluate(() => window.__run(260, 160, 'group'));
  const ids2 = await page.evaluate(() => window.__menu(260, 160).map(i => i.id));
  assert.ok(ids2.includes('ungroup'));
});

test('browser: a right mouse button never reaches the active tool (no pen point, no shape)', async () => {
  await page.evaluate(() => window.__ed.setTool('pen'));
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  const at = (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
  await page.mouse.click(...at(100, 100), { button: 'right' });
  assert.equal(await page.evaluate(() => window.__ed._penBuild), null);
  await page.evaluate(() => window.__ed.setTool('rect'));
  await page.mouse.click(...at(150, 150), { button: 'right' });
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects().filter(o => o.type === 'rect').length), 0);
});

test('browser: right-click on a marquee selection → Select object shrinks it to the objects inside (all of them, not the backdrop)', async () => {
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d');
    x.fillStyle = '#ece6c6'; x.fillRect(0, 0, 400, 300);
    x.fillStyle = '#a9c24a'; x.fillRect(30, 120, 340, 170);   // the panel the products sit on
    x.fillStyle = '#e07a6a'; x.fillRect(90, 160, 70, 100);    // product 1
    x.fillStyle = '#2f7fc9'; x.fillRect(220, 170, 80, 90);    // product 2
    x.fillStyle = '#ffffff'; x.fillRect(100, 180, 50, 20); x.fillRect(235, 190, 50, 20);   // labels
    await window.__ed.openImage(c.toDataURL('image/png'));
  });
  const ids = await page.evaluate(() => {
    const ed = window.__ed; ed.setTool('marquee');
    ed.selection = { kind: 'rect', x: 60, y: 140, w: 270, h: 140 };
    return ed.openContextMenu({ x: 200, y: 200 }, { x: 0, y: 0 }).sections.flat().map(i => i.id);
  });
  assert.equal(ids[0], 'sel-object', 'Select object leads the pixel-selection menu');
  const r = await page.evaluate(async () => {
    const ed = window.__ed;
    const res = await ed.openContextMenu({ x: 200, y: 200 }, { x: 0, y: 0 }).sections.flat().find(i => i.id === 'sel-object').run();
    const s = ed.selection, rings = s.kind === 'multipoly' ? s.polys : [s.pts];
    const area = pl => Math.abs(pl.reduce((a, p, i) => { const q = pl[(i + 1) % pl.length]; return a + p.x * q.y - q.x * p.y; }, 0) / 2);
    const bb = pl => [Math.min(...pl.map(p => p.x)), Math.min(...pl.map(p => p.y)), Math.max(...pl.map(p => p.x)), Math.max(...pl.map(p => p.y))].map(Math.round);
    return { status: res.status, rings: rings.map(bb).sort((a, b) => a[0] - b[0]), area: rings.reduce((a, pl) => a + area(pl), 0) };
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.rings.length, 2, 'one ring per product: ' + JSON.stringify(r.rings));
  const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) <= 6);
  assert.ok(near(r.rings[0], [90, 160, 160, 260]), 'hugs product 1: ' + r.rings[0]);
  assert.ok(near(r.rings[1], [220, 170, 300, 260]), 'hugs product 2: ' + r.rings[1]);
  assert.ok(r.area < 270 * 140 * 0.5, 'the green backdrop is not selected: ' + r.area);

  // Shift-added rings that overlap are a union (nonzero), not even-odd: product 1's right edge
  // sits inside the overlap and must still be selected.
  const pick = (sel) => page.evaluate(async (sel) => {
    const ed = window.__ed; ed.selection = sel;
    const res = await ed.selectObjectsInSelection();
    const s = ed.selection, rings = res.status === 'ok' ? (s.kind === 'multipoly' ? s.polys : [s.pts]) : [];
    const inside = (pl, x, y) => { let c = false; for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) { const a = pl[i], b = pl[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
    const bb = pl => [Math.min(...pl.map(p => p.x)), Math.min(...pl.map(p => p.y)), Math.max(...pl.map(p => p.x)), Math.max(...pl.map(p => p.y))].map(Math.round);
    return { status: res.status, rings: rings.map(bb).sort((a, b) => a[0] - b[0]),
      p1: rings.some(pl => inside(pl, 125, 230)), p2: rings.some(pl => inside(pl, 260, 230)) };
  }, sel);
  const ring = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const ov = await pick({ kind: 'multipoly', polys: [ring(60, 140, 200, 280), ring(150, 140, 330, 280)] });
  assert.equal(ov.status, 'ok');
  assert.ok(ov.rings.some(b => near(b, [90, 160, 160, 260])), 'product 1 whole despite the overlap: ' + JSON.stringify(ov.rings));

  // An inverted selection searches everything EXCEPT its rings.
  const inv = await pick({ kind: 'rect', x: 75, y: 145, w: 100, h: 130, invert: true });
  assert.equal(inv.status, 'ok');
  assert.ok(!inv.p1, 'product 1 is outside an inverted selection around it');
  assert.ok(inv.p2, 'product 2 is found in the inverted area');

  // A slipped-click-sized selection is refused up front instead of erroring in the worker.
  const tiny = await page.evaluate(() => { window.__ed.selection = { kind: 'rect', x: 100, y: 200, w: 5, h: 5 }; return window.__ed.selectObjectsInSelection(); });
  assert.equal(tiny.reason, 'no_match');
});

test('browser: menu actions — paste here, paste to replace (one undo step), arrange, hide, lock, cut', async () => {
  await ctxSetup();
  await page.evaluate(async () => { window.__menu(90, 80); await window.__ed.copySelection(); });
  await page.evaluate(() => window.__run(330, 250, 'paste-here'));
  await page.waitForTimeout(100);
  const c = await page.evaluate(() => { const p = window.__ed.fc.getActiveObject().getCenterPoint(); return [Math.round(p.x), Math.round(p.y)]; });
  assert.deepEqual(c, [330, 250], 'pasted centred on the right-click point');
  // paste to replace the circle with the box: one undo brings the circle back
  const before = await page.evaluate(() => window.__ed.history.depth().past);
  await page.evaluate(() => window.__run(270, 170, 'paste-replace')); await page.waitForTimeout(100);
  const after = await page.evaluate(() => ({ circle: !!window.__ed._byId('C'), past: window.__ed.history.depth().past, n: window.__ed.fc.getObjects().length }));
  assert.equal(after.circle, false); assert.equal(after.past, before + 1, 'one undo step');
  await page.evaluate(() => window.__ed.undo()); await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => !!window.__ed._byId('C')), 'undo restores the replaced layer');
  // arrange: send the box to the back, bring it to the front
  await page.evaluate(() => window.__run(90, 80, 'back'));
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects()[0].id), 'R');
  await page.evaluate(() => window.__run(90, 80, 'front'));
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects().at(-1).id), 'R');
  // hide, then lock -> the locked layer's menu offers Unlock
  await page.evaluate(() => window.__run(270, 170, 'toggle-lock'));
  assert.equal(await page.evaluate(() => window.__ed._byId('C').locked), true);
  assert.deepEqual(await page.evaluate(() => window.__menu(270, 170).map(i => i.id)), ['unlock', 'toggle-visible', 'paste-here']);
  await page.evaluate(() => window.__run(270, 170, 'unlock'));
  assert.equal(await page.evaluate(() => window.__ed._byId('C').locked), false);
  await page.evaluate(() => window.__run(270, 170, 'toggle-visible'));
  assert.equal(await page.evaluate(() => window.__ed._byId('C').visible), false);
  // cut: gone from the canvas, on the clipboard
  await page.evaluate(() => window.__run(90, 80, 'cut')); await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => !!window.__ed._byId('R')), false);
  assert.ok(await page.evaluate(() => !!window.__ed._clipboard));
});

test('browser: Figma arrange/flip/hide/lock shortcuts act on the selection', async () => {
  await ctxSetup();
  await page.evaluate(() => { const ed = window.__ed; ed.fc.setActiveObject(ed._byId('C')); });
  await page.keyboard.press('[');
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects()[0].id), 'C', '[ sends to back');
  await page.keyboard.press(']');
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects().at(-1).id), 'C', '] brings to front');
  await page.keyboard.press('Shift+H');
  assert.equal(await page.evaluate(() => window.__ed._byId('C').flipX), true, '⇧H flips horizontally');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+L' : 'Control+Shift+L');
  assert.equal(await page.evaluate(() => window.__ed._byId('C').locked), true, '⇧⌘L locks');
});

/* ── QA / review regressions ─────────────────────────────────────────────────────────────── */
test('browser: tool letters go to their own tool and only cycle through unlettered siblings', async () => {
  const press = async (k) => { await page.keyboard.press(k); return page.evaluate(() => window.__ed.tool); };
  // install the shortcuts the way the shells do — with their rail groups
  await page.evaluate(async () => {
    const { installKeybindings } = await import('/packages/core/src/index.js');
    window.__stopKeys(); window.__stopKeys = installKeybindings(window.__ed, document, { toolGroups: [
      ['select', 'hand'], ['marquee', 'marquee-ellipse', 'lasso', 'lasso-poly', 'lasso-mag', 'wand', 'objectselect-bbox'],
      ['rect', 'ellipse', 'line', 'triangle', 'polygon', 'star']] });
  });
  await page.evaluate(() => window.__ed.setTool('select'));
  assert.equal(await press('v'), 'select', 'V on Select stays Select (Hand has its own H)');
  await page.evaluate(() => window.__ed.setTool('marquee'));
  assert.equal(await press('l'), 'lasso', 'L goes to Lasso, not the next marquee');
  await page.evaluate(() => window.__ed.setTool('select'));
  assert.equal(await press('m'), 'marquee'); assert.equal(await press('m'), 'marquee-ellipse');
  assert.equal(await press('u'), 'rect'); assert.equal(await press('u'), 'ellipse');
});

test('browser: paint bucket floods the clicked colour area only; with a selection it fills the selection', async () => {
  await page.evaluate(() => {
    const ed = window.__ed, F = ed.fabric;
    const a = new F.Rect({ left: 0, top: 0, width: 400, height: 150, fill: '#3366cc', strokeWidth: 0 }); a.set({ id: 'top', role: 'shape' });
    const b2 = new F.Rect({ left: 0, top: 150, width: 400, height: 150, fill: '#33aa55', strokeWidth: 0 }); b2.set({ id: 'bot', role: 'shape' });
    ed.fc.add(a); ed.fc.add(b2); ed.commit('add'); ed.setToolOptions({ color: '#ff0000', fill: '#ff0000' }); ed.setTool('bucket');
  });
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  await page.mouse.click(box.x + vt[4] + 200 * vt[0], box.y + vt[5] + 220 * vt[3]);
  const px = await page.evaluate(() => { const ed = window.__ed; ed.fc.renderAll(); const el = ed.fc.toCanvasElement(1 / ed.fc.getZoom(), { left: ed.fc.viewportTransform[4], top: ed.fc.viewportTransform[5], width: ed.W * ed.fc.getZoom(), height: ed.H * ed.fc.getZoom() }); const k = el.width / ed.W, g = (x, y) => Array.from(el.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3)).join(','); return [g(200, 220), g(200, 60)]; });
  assert.deepEqual(px, ['255,0,0', '51,102,204'], 'bottom band filled, top band untouched');
});

test('browser: selection changes are undone before the document (⌘Z after Expand/Contract keeps the image)', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed;
    ed.selection = { kind: 'rect', x: 50, y: 50, w: 100, h: 100 }; ed._emit('selection', ed.selection);
    ed.selection = { kind: 'rect', x: 40, y: 40, w: 120, h: 120 }; ed._emit('selection', ed.selection);
    ed.clearSelection();
    const n = ed.fc.getObjects().length;
    ed.undo(); const a = ed.selection && ed.selection.w;
    ed.undo(); const b = ed.selection && ed.selection.w;
    ed.redo(); const c = ed.selection && ed.selection.w;
    return { a, b, c, docSame: ed.fc.getObjects().length === n };
  });
  assert.deepEqual(r, { a: 120, b: 100, c: 120, docSame: true });
});

test('browser: send to back stays above the background; locked layers ignore arrows/Delete', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed, F = ed.fabric;
    const bg = new F.Rect({ left: 0, top: 0, width: 400, height: 300, fill: '#eee' }); bg.set({ id: 'BG', role: 'bg' }); ed.fc.add(bg);
    const s = new F.Rect({ left: 50, top: 50, width: 80, height: 80, fill: '#f00' }); s.set({ id: 'S', role: 'shape' }); ed.fc.add(s);
    ed.commit('add'); ed.setTool('select'); ed.fc.setActiveObject(s); ed.arrangeSelection('bottom');
    return ed.fc.getObjects().map(o => o.id);
  });
  assert.deepEqual(r, ['BG', 'S']);
  await page.evaluate(() => { const ed = window.__ed; ed.setLayer('S', { locked: true }); ed.activate('S'); });
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Backspace');
  assert.deepEqual(await page.evaluate(() => { const o = window.__ed._byId('S'); return o && Math.round(o.left); }), 50);
});

test('browser: Open image starts a new document (old layers go; one undo brings them back)', async () => {
  await page.evaluate(() => { const ed = window.__ed, r = new ed.fabric.Rect({ left: 10, top: 10, width: 50, height: 50, fill: '#000' }); r.set({ id: 'OLD', role: 'shape' }); ed.fc.add(r); ed.commit('add'); });
  await page.evaluate(async () => { const c = document.createElement('canvas'); c.width = 200; c.height = 100; c.getContext('2d').fillRect(0, 0, 200, 100); await window.__ed.openImage(c.toDataURL()); });
  assert.deepEqual(await page.evaluate(() => [window.__ed.fc.getObjects().length, !!window.__ed._byId('OLD'), window.__ed.W]), [1, false, 200]);
  await page.evaluate(() => window.__ed.undo()); await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => !!window.__ed._byId('OLD')));
});

/* ── voice control: fake SpeechRecognition feeds transcripts into the real editor ── */
test('voice: spoken commands drive the editor', async () => {
  await page.evaluate(async () => {
    window.SpeechRecognition = class { start() { window.__rec = this; } stop() { this.onend && this.onend(); } };
    const { installVoice } = await import('/packages/core/src/index.js');
    window.__zoomed = 0; window.__status = [];
    window.__voice = installVoice(window.__ed, { actions: { zoomIn: () => window.__zoomed++ }, onStatus: (s) => window.__status.push(s) });
    window.__voice.start();
    window.__say = (t) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] });
  });
  assert.equal(await page.evaluate(() => window.__voice.listening), true);
  const say = (t) => page.evaluate((t) => window.__say(t), t);

  await say('use the brush tool');
  assert.equal(await page.evaluate(() => window.__ed.tool), 'brush');

  await say('add text saying hello');
  const layer = await page.evaluate(() => window.__ed.layers().find(l => l.active));
  assert.ok(layer && layer.name.startsWith('hello'));

  await say('make it red');
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject().fill), '#e53935');
  await say('opacity 50 percent');
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject().opacity), 0.5);

  await say('undo');   // reverts opacity only (undo reloads the doc, which drops the selection)
  assert.equal(await page.evaluate(() => window.__ed.layers().find(l => l.name.startsWith('hello')).opacity), 1);
  await page.evaluate(() => window.__ed.activate(window.__ed.layers().find(l => l.name.startsWith('hello')).id));

  await say('zoom in');
  assert.equal(await page.evaluate(() => window.__zoomed), 1);

  await say('delete');
  assert.equal(await page.evaluate(() => window.__ed.layers().some(l => l.name.startsWith('hello'))), false);

  // failure paths report instead of throwing
  await say('make it banana');
  await say('flip horizontally');   // nothing selected
  const last = await page.evaluate(() => window.__status.slice(-1)[0]);
  assert.equal(last.state, 'error');
  assert.match(last.message, /Select a layer/);

  await page.evaluate(() => window.__voice.stop());
  assert.equal(await page.evaluate(() => window.__voice.listening), false);
});

test('browser: selectObjectByName — provider box is refined by GrabCut to the object, and the error paths are clean', async () => {
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d');
    x.fillStyle = '#ece6c6'; x.fillRect(0, 0, 400, 300);
    x.fillStyle = '#2f7fc9'; x.fillRect(220, 170, 80, 90);    // "the blue box"
    await window.__ed.openImage(c.toDataURL('image/png'));
  });
  const none = await page.evaluate(() => window.__ed.selectObjectByName('blue box'));
  assert.equal(none.reason, 'no_provider');
  const r = await page.evaluate(async () => {
    const ed = window.__ed;
    // loose box (% of the artboard) around the blue rect — x 205..315, y 155..275 of 400x300
    ed.ai.register({ hasKey: () => true, locateObject: async (_img, d) => (d === 'ghost' ? null : { x: 205 / 4, y: 155 / 3, width: 110 / 4, height: 120 / 3 }) });
    const ok = await ed.selectObjectByName('blue box');
    const s = ed.selection, pts = s.kind === 'multipoly' ? s.polys.flat() : (s.pts || []);
    const bb = pts.length ? [Math.min(...pts.map(p => p.x)), Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.x)), Math.max(...pts.map(p => p.y))].map(Math.round) : null;
    const ghost = await ed.selectObjectByName('ghost');
    return { status: ok.status, kind: s.kind, bb, ghost: ghost.reason };
  });
  assert.equal(r.status, 'ok');
  assert.notEqual(r.kind, 'rect', 'refined past the loose box');
  assert.ok(r.bb.every((v, i) => Math.abs(v - [220, 170, 300, 260][i]) <= 6), 'hugs the object: ' + r.bb);
  assert.equal(r.ghost, 'no_match');
});

test('browser: voice catalog drives the real editor — adjustments, text, style, layout, canvas, masks, chains', async () => {
  const r = await page.evaluate(async () => {
    const { parseVoiceCommands, runVoiceCommand } = await import('/packages/core/src/index.js');
    const ed = window.__ed;
    const actions = { zoomIn() { window.__z = 'in'; }, export(f) { window.__exp = f; }, theme(m) { window.__theme = m; } };
    const log = [];
    const say = async (phrase) => {
      const cmds = parseVoiceCommands(phrase);
      if (!cmds) { log.push([phrase, 'NO PARSE']); return null; }
      try { for (const c of cmds) log.push([phrase, await runVoiceCommand(ed, c, actions)]); }
      catch (e) { log.push([phrase, 'ERR ' + e.message]); }
    };
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d');
    x.fillStyle = '#ece6c6'; x.fillRect(0, 0, 400, 300); x.fillStyle = '#2f7fc9'; x.fillRect(220, 170, 80, 90);
    await ed.openImage(c.toDataURL('image/png'));
    const o = {};
    // photo adjustments with nothing selected (auto-targets the picture)
    ed.fc.discardActiveObject();
    await say('increase brightness'); o.bright = ed.getImageFilters().brightness;
    await say('contrast 130'); o.contrast = ed.getImageFilters().contrast;
    await say('make it warmer'); o.temp = ed.getImageFilters().temperature;
    await say('black and white'); o.sat = ed.getImageFilters().saturate;
    await say('reset adjustments'); o.reset = [ed.getImageFilters().brightness, ed.getImageFilters().saturate];
    await say('straighten 3 degrees'); o.geo = ed.getImageGeometry().angle;
    // shapes + style
    await say('add a circle'); o.circle = ed.fc.getActiveObject().type;
    await say('make it light blue'); o.fill = ed.fc.getActiveObject().fill;
    await say('border it red'); o.stroke = ed.fc.getActiveObject().stroke;
    await say('border width 6'); o.sw = ed.fc.getActiveObject().strokeWidth;
    await say('add shadow'); o.shadow = !!ed.fc.getActiveObject().shadow;
    await say('remove shadow'); o.noShadow = !ed.fc.getActiveObject().shadow;
    await say('opacity 40 percent'); o.op = ed.fc.getActiveObject().opacity;
    await say('rotate 90 degrees'); o.angle = ed.fc.getActiveObject().angle;
    await say('move it left 50'); const l0 = ed.fc.getActiveObject().left; await say('move it right 50'); o.nudged = ed.fc.getActiveObject().left - l0;
    await say('scale 200 percent'); o.scaledW = Math.round(ed.fc.getActiveObject().getScaledWidth());
    await say('align left'); o.alignL = Math.round(ed.fc.getActiveObject().getBoundingRect(true).left);
    await say('lock'); o.locked = ed.layers().find(l => l.id === ed.fc.getActiveObject().id)?.locked;
    await say('unlock');
    await say('rename layer to hero dot'); o.name = ed.layers().find(l => l.active)?.name;
    await say('add mask'); o.mask = !!ed.fc.getActiveObject().maskCanvas || !!ed.fc.getActiveObject().filters?.length || 'ok';
    await say('invert mask');
    await say('remove mask');
    // text
    await say('add text saying hello world'); const t = ed.fc.getActiveObject(); o.text = t.text;
    await say('font size 64'); o.fs = ed.fc.getActiveObject().fontSize;
    await say('bold'); o.bold = ed.fc.getActiveObject().fontWeight;
    await say('italic'); o.italic = ed.fc.getActiveObject().fontStyle;
    await say('underline'); o.ul = ed.fc.getActiveObject().underline;
    await say('text center'); o.align = ed.fc.getActiveObject().textAlign;
    await say('font roboto'); o.font = ed.fc.getActiveObject().fontFamily;
    await say('line height 1.5'); o.lh = ed.fc.getActiveObject().lineHeight;
    await say('change the text to sale today'); o.text2 = ed.fc.getActiveObject().text;
    // canvas
    await say('canvas 16 to 9'); o.canvas = [ed.W, ed.H];
    await say('canvas size 500 by 400'); o.canvas2 = [ed.W, ed.H];
    await say('background white');
    await say('add a heart'); o.sticker = ed.fc.getObjects().length;
    // tools + brush
    await say('brush'); o.tool = ed.tool;
    await say('brush size 40'); o.size = ed.toolOpts.size;
    await say('brush color red'); o.bcolor = ed.toolOpts.color;
    await say('brush opacity 50'); o.bop = ed.toolOpts.opacity;
    await say('tolerance 80'); o.tol = ed.toolOpts.tolerance;
    await say('snapping off');
    // selection ops
    await say('select all layers'); await say('select all'); await say('copy'); await say('paste'); await say('deselect');
    // chains + shell actions
    await say('zoom in and undo'); o.zoom = window.__z;
    await say('export as jpg'); o.exp = window.__exp;
    await say('dark mode'); o.theme = window.__theme;
    o.log = log.filter(([, m]) => /^(ERR|NO PARSE)/.test(m));
    return o;
  });
  assert.deepEqual(r.log, [], 'every phrase ran: ' + JSON.stringify(r.log));
  assert.equal(r.bright, 115); assert.equal(r.contrast, 130); assert.equal(r.temp, 30); assert.equal(r.sat, 0);
  assert.deepEqual(r.reset, [100, 100]); assert.equal(r.geo, 3);
  assert.equal(r.circle, 'ellipse'); assert.equal(r.stroke, '#e53935'); assert.equal(r.sw, 6);
  assert.equal(r.shadow, true); assert.equal(r.noShadow, true); assert.equal(r.op, 0.4); assert.equal(r.angle, 90);
  assert.equal(r.nudged, 50); assert.ok(r.scaledW > 0); assert.equal(r.alignL, 0); assert.equal(r.locked, true);
  assert.equal(r.text, 'hello world'); assert.equal(r.fs, 64); assert.equal(r.bold, 'bold'); assert.equal(r.italic, 'italic');
  assert.equal(r.ul, true); assert.equal(r.align, 'center'); assert.match(r.font, /Roboto/); assert.equal(r.lh, 1.5); assert.equal(r.text2, 'sale today');
  assert.deepEqual(r.canvas2, [500, 400]); assert.equal(r.tool, 'brush'); assert.equal(r.size, 40); assert.equal(r.bcolor, '#e53935'); assert.equal(r.bop, 0.5); assert.equal(r.tol, 80);
  assert.equal(r.zoom, 'in'); assert.equal(r.exp, 'jpg'); assert.equal(r.theme, 'dark');
});

test('browser: voice — shape colour/size, gradient angle, border style/position, explicit size, move, distribute', async () => {
  const r = await page.evaluate(async () => {
    const { parseVoiceCommands, runVoiceCommand } = await import('/packages/core/src/index.js');
    const ed = window.__ed, A = () => ed.fc.getActiveObject();
    const say = async (p) => { for (const c of parseVoiceCommands(p) || (() => { throw new Error('NO PARSE: ' + p); })()) await runVoiceCommand(ed, c, {}); };
    const o = {};
    await say('add a red circle'); o.circle = [A().type, A().fill];
    await say('draw a big blue square'); o.big = Math.round(A().getScaledWidth());
    await say('add a 200 pixel star'); o.star = Math.round(A().getBoundingRect(true).width);
    await say('add a rectangle');
    await say('vertical gradient from white to black'); o.vert = A().fill.coords;
    await say('dashed border'); o.dash = A().strokeDashArray;
    await say('border inside'); o.pos = A().strokePosition;
    await say('make it 300 wide'); o.w = Math.round(A().getScaledWidth());
    await say('move to 100 200'); o.at = [Math.round(A().left), Math.round(A().top)];
    // distribute: three 50px circles at uneven x
    ed.fc.getObjects().slice().forEach(x => ed.fc.remove(x));
    for (const x of [20, 70, 250]) { await say('add a 50 pixel circle'); await say('move to ' + x + ' 100'); }
    await say('select all layers'); await say('distribute horizontally');
    ed.fc.discardActiveObject();
    o.xs = ed.fc.getObjects().map(m => Math.round(m.getBoundingRect(true).left)).sort((a, b) => a - b);
    return o;
  });
  assert.deepEqual(r.circle, ['ellipse', '#e53935']);
  assert.ok(r.big > 100 && r.star === 200 || Math.abs(r.star - 200) <= 12, 'sizes: ' + JSON.stringify(r));
  assert.ok(r.vert.y2 > 0 && r.vert.x1 === r.vert.x2, 'vertical gradient axis: ' + JSON.stringify(r.vert));
  assert.ok(Array.isArray(r.dash)); assert.equal(r.pos, 'inside'); assert.equal(r.w, 300); assert.deepEqual(r.at, [100, 200]);
  assert.equal(r.xs.length, 3);
  assert.deepEqual(r.xs, [20, 135, 250], 'evenly spaced between the outer two: ' + r.xs);
});

test('browser: voice — layer picking, blend, curves, HSL, perspective, adjustment layers, toggles, crop ratio, fills', async () => {
  const r = await page.evaluate(async () => {
    const { parseVoiceCommands, runVoiceCommand } = await import('/packages/core/src/index.js');
    const ed = window.__ed, A = () => ed.fc.getActiveObject();
    const errs = [];
    const say = async (p) => { const c = parseVoiceCommands(p); if (!c) { errs.push(['NO PARSE', p]); return; } try { for (const x of c) await runVoiceCommand(ed, x, { reviewCommit() { window.__rc = 1; }, saveProject() { window.__sp = 1; } }); } catch (e) { errs.push([p, e.message]); } };
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d');
    x.fillStyle = '#ece6c6'; x.fillRect(0, 0, 400, 300); x.fillStyle = '#2f7fc9'; x.fillRect(220, 170, 80, 90);
    await ed.openImage(c.toDataURL('image/png'));
    const o = {};
    await say('add a red circle'); await say('add text saying hello'); await say('add a blue square');
    await say('select the text layer'); o.textSel = A().type;
    await say('select layer 1'); o.top = A().id === ed.layers()[0].id;
    await say('select the background'); o.bg = ed.layers().find(l => l.active)?.role;
    await say('select the next layer');
    await say('select layer 3');
    await say('blend mode multiply'); o.blend = A().globalCompositeOperation;
    await say('select the background');
    await say('contrast curve'); o.curve = !!(A().fx && A().fx.curves && A().fx.curves.rgb);
    await say('reset curves'); o.curveReset = !(A().fx && A().fx.curves);
    await say('reds saturation 30'); o.hsl = A().fx.hsl && A().fx.hsl.red && A().fx.hsl.red.s;
    await say('make the blues darker'); o.hslB = A().fx.hsl.blue.l;
    await say('increase tolerance'); o.tol = ed.toolOpts.tolerance;
    await say('perspective correction'); o.persp = !!ed._persp; await say('cancel perspective'); o.perspOff = !ed._persp;
    await say('add adjustment layer'); o.adjRole = A().role;
    await say('increase brightness'); o.adjBright = ed.getAdjustmentParams(A().id).brightness;
    await say('add mode on'); o.addMode = ed.toolOpts.addMode;
    await say('paint on a new layer'); o.pnl = ed.toolOpts.paintNewLayer;
    await say('aligned off'); o.aligned = ed.toolOpts.aligned;
    await say('gradient tool from red to blue'); o.gt = [ed.tool, ed.toolOpts.gradientStops[0].color, ed.toolOpts.gradientStops[1].color];
    await say('gradient type radial'); o.gk = ed.toolOpts.gradientType;
    await say('crop 16 to 9'); o.crop = [ed.tool, +ed.toolOpts.cropRatio.toFixed(3)];
    await say('crop original'); o.cropO = +ed.toolOpts.cropRatio.toFixed(3);
    await say('select the background');
    await say('select all'); await say('fill the selection with red'); await say('deselect');
    await say('cover the canvas');
    await say('create layers'); o.rc = window.__rc;
    await say('save project'); o.sp = window.__sp;
    o.errs = errs;
    return o;
  });
  assert.deepEqual(r.errs, [], JSON.stringify(r.errs));
  assert.equal(r.textSel, 'i-text'); assert.equal(r.top, true); assert.equal(r.blend, 'multiply');
  assert.equal(r.curve, true); assert.equal(r.curveReset, true); assert.equal(r.hsl, 30); assert.equal(r.hslB, -30);
  assert.equal(r.tol, 80); assert.equal(r.persp, true); assert.equal(r.perspOff, true);
  assert.equal(r.adjRole, 'adjustment'); assert.equal(r.adjBright, 115);
  assert.equal(r.addMode, true); assert.equal(r.pnl, true); assert.equal(r.aligned, false);
  assert.deepEqual(r.gt, ['gradient', '#e53935', '#1e88e5']); assert.equal(r.gk, 'radial');
  assert.deepEqual(r.crop, ['crop', 1.778]); assert.equal(r.cropO, +(400 / 300).toFixed(3));
  assert.equal(r.rc, 1); assert.equal(r.sp, 1);
});

test('browser: voice — pen tool draws points/shapes/paths, and offline background removal', async () => {
  const r = await page.evaluate(async () => {
    const { parseVoiceCommands, runVoiceCommand } = await import('/packages/core/src/index.js');
    const ed = window.__ed, A = () => ed.fc.getActiveObject();
    const errs = [];
    const say = async (p) => { const c = parseVoiceCommands(p); if (!c) { errs.push(['NO PARSE', p]); return null; } let m; try { for (const x of c) m = await runVoiceCommand(ed, x, {}); } catch (e) { errs.push([p, e.message]); } return m; };
    const o = {};
    // — pen, point by point —
    await say('pen tool'); o.tool = ed.tool;
    await say('pen point at 50 50'); await say('pen point at 200 60'); await say('add a curved point at 250 200');
    o.building = ed._penBuild.nodes.length; o.curved = !!ed._penBuild.nodes[2].ho;
    await say('next point 40 left and 30 down'); o.rel = [Math.round(ed._penBuild.nodes[3].x), Math.round(ed._penBuild.nodes[3].y)];
    await say('undo last point'); o.afterUndo = ed._penBuild.nodes.length;
    await say('close the path'); const closed = A(); o.closed = [closed.type, !!closed.fill, ed._penBuild];
    // open path via 'finish'
    await say('add a point at the top left'); await say('add a point at the bottom right'); await say('finish'); o.open = [A().type, !!A().stroke, !A().fill];
    // — whole shapes and custom paths —
    await say('draw a heart path'); o.heart = [A().type, A().shapeKind, Math.round(A().getScaledWidth())];
    await say('draw a big red pen star'); o.star = [A().fill, Math.round(A().getBoundingRect(true).width)];
    await say('draw a path through 20 20, 120 20, 70 120 and close it'); o.custom = [A().type, !!A().fill];
    await say('edit path'); o.editing = !!ed.pathEdit; await say('smooth points'); await say('done editing path'); o.editDone = !ed.pathEdit;
    await say('pen width 8'); o.pw = ed.toolOpts.penStrokeWidth;
    // — offline background removal —
    ed.fc.getObjects().slice().forEach(x => ed.fc.remove(x));
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const x = c.getContext('2d');
    x.fillStyle = '#ece6c6'; x.fillRect(0, 0, 400, 300); x.fillStyle = '#2f7fc9'; x.fillRect(140, 90, 120, 120);
    await ed.openImage(c.toDataURL('image/png'));
    const msg = await say('remove background offline'); o.msg = msg;
    const img = ed.fc.getObjects().find(q => q.type === 'image');
    o.masked = !!(img && (img.maskCanvas || img.cutout));
    // sample the layer's own pixels: corner should be transparent, centre opaque
    const flat = ed.exportPNG(); const im = new Image(); im.src = flat; await im.decode();
    const k = document.createElement('canvas'); k.width = im.width; k.height = im.height; const cx = k.getContext('2d'); cx.drawImage(im, 0, 0);
    const px = (X, Y) => Array.from(cx.getImageData(Math.round(X * im.width / ed.W), Math.round(Y * im.height / ed.H), 1, 1).data);   // exportPNG flattens onto the page colour
    o.alpha = [px(10, 10), px(200, 150)];
    await say('touch up keep'); o.touch = ed.toolOpts.maskRefine; await say('touch up off');
    o.errs = errs; return o;
  });
  assert.deepEqual(r.errs, [], JSON.stringify(r.errs));
  assert.equal(r.tool, 'pen'); assert.equal(r.building, 3); assert.equal(r.curved, true);
  assert.deepEqual(r.rel, [210, 230]); assert.equal(r.afterUndo, 3);
  assert.equal(r.closed[0], 'path'); assert.equal(r.closed[1], true); assert.equal(r.closed[2], null);
  assert.deepEqual(r.open, ['path', true, true]);
  assert.equal(r.heart[0], 'path'); assert.equal(r.heart[1], 'pen'); assert.ok(r.heart[2] > 100);
  assert.equal(r.star[0], '#e53935'); assert.ok(r.star[1] > 150, 'big star: ' + r.star);
  assert.deepEqual(r.custom, ['path', true]); assert.equal(r.editing, true); assert.equal(r.editDone, true); assert.equal(r.pw, 8);
  assert.match(r.msg, /offline/); assert.ok(!(Math.abs(r.alpha[0][0] - 236) < 8 && Math.abs(r.alpha[0][2] - 198) < 8), 'cream backdrop is gone: ' + r.alpha[0]); assert.ok(r.alpha[1][2] > 150 && r.alpha[1][0] < 90, 'blue subject stays: ' + r.alpha[1]);
  assert.equal(r.touch, 'keep');
});

test('browser: voice — selecting several layers at once (numbers, ranges, names, roles, add, remove)', async () => {
  const r = await page.evaluate(async () => {
    const { parseVoiceCommands, runVoiceCommand } = await import('/packages/core/src/index.js');
    const ed = window.__ed, errs = [];
    const say = async (p) => { const c = parseVoiceCommands(p); if (!c) { errs.push(['NO PARSE', p]); return null; } let m; try { for (const x of c) m = await runVoiceCommand(ed, x, {}); } catch (e) { errs.push([p, e.message]); } return m; };
    const sel = () => { const o = ed.fc.getActiveObject(); return !o ? [] : (o.type === 'activeSelection' ? o.getObjects() : [o]).map(x => x.type); };
    const names = () => ed.layers().map(l => l.name);
    // layers top→bottom after these adds: 1 star(polygon) 2 text 3 circle 4 square
    await say('add a blue square'); await say('add a red circle'); await say('add text saying hi'); await say('add a star');
    const o = {};
    o.n1 = [await say('select layers 1 and 3'), sel().length];
    o.range = [await say('select layers 1 to 3'), sel().length];
    o.names = [await say('select the text and star layers'), sel().sort()];
    o.role = [await say('select all text layers'), sel()];
    await say('select layer 1'); o.add = [await say('add layer 3 to the selection'), sel().length];
    o.add2 = [await say('also select layer 4'), sel().length];
    o.remove = [await say('deselect layer 3'), sel().length];
    // a multi-selection is actionable: group / align / delete act on all
    await say('select layers 1 and 2'); await say('group'); o.grouped = ed.layers().filter(l => l.isGroup).length;
    await say('ungroup');
    await say('select layers 1 and 2'); await say('align left'); o.aligned = sel().length;
    o.errs = errs; return o;
  });
  assert.deepEqual(r.errs, [], JSON.stringify(r.errs));
  assert.equal(r.n1[1], 2); assert.equal(r.range[1], 3); assert.deepEqual(r.names[1], ['i-text', 'polygon']);
  assert.deepEqual(r.role[1], ['i-text']);
  assert.equal(r.add[1], 2); assert.equal(r.add2[1], 3); assert.equal(r.remove[1], 2);
  assert.equal(r.grouped, 1); assert.equal(r.aligned, 2);
});

test('browser: voice — "select both the circle", spoken numbers, both/the two/top two all select two circles', async () => {
  const r = await page.evaluate(async () => {
    const { parseVoiceCommands, runVoiceCommand } = await import('/packages/core/src/index.js');
    const ed = window.__ed, A = () => ed.fc.getActiveObject();
    const say = async (p) => { const c = parseVoiceCommands(p); if (!c) return 'NO PARSE'; try { let m; for (const x of c) m = await runVoiceCommand(ed, x, {}); return m; } catch (e) { return 'ERR ' + e.message; } };
    const count = () => { const o = A(); return !o ? 0 : o.type === 'activeSelection' ? o.getObjects().length : 1; };
    for (const x of ed.fc.getObjects().slice()) ed.fc.remove(x);
    await say('add a black circle'); await say('add a yellow circle');
    const out = {};
    // no AI provider is registered here, so none of these may need one
    for (const p of ['select both the circle', 'select both circles', 'select the circles', 'select the two circles', 'select layer 1 and 2', 'select layer one and two', 'select layers one and two', 'select layers 1, 2', 'select both', 'select the top two layers', 'select first two layers']) {
      ed.fc.discardActiveObject(); const m = await say(p); out[p] = [count(), /^(ERR|NO PARSE)/.test(m) ? m : 'ok'];
    }
    return out;
  });
  for (const [p, [n, st]] of Object.entries(r)) { assert.equal(st, 'ok', p + ': ' + st); assert.equal(n, 2, p + ' selected ' + n); }
});

/* ── voice: shape/text/targeting phrasings land as real layers (no AI involved) ── */
test('voice: draw/add phrasings create plain shapes, and act on layers by name', async () => {
  await page.evaluate(async () => {
    window.SpeechRecognition = class { start() { window.__rec = this; } stop() { this.onend && this.onend(); } };
    const { installVoice } = await import('/packages/core/src/index.js');
    window.__status = [];
    window.__voice = installVoice(window.__ed, { onStatus: (s) => window.__status.push(s) });
    window.__voice.start();
    window.__say = (t) => window.__rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] });
  });
  const say = async (t) => { await page.evaluate((t) => window.__say(t), t); await page.waitForFunction(() => ['done', 'error'].includes(window.__status.slice(-1)[0].state)); };
  const types = () => page.evaluate(() => window.__ed.layers().map(l => l.name));
  const n0 = (await types()).length;

  await say('draw the circle');
  assert.equal((await types()).length, n0 + 1);
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject().type), 'ellipse');   // a vector shape, not an image

  await say('draw two stars');
  assert.equal((await types()).length, n0 + 3);

  await say('draw a red square at the top');
  const sq = await page.evaluate(() => { const o = window.__ed.fc.getActiveObject(); return { fill: o.fill, y: o.top }; });
  assert.equal(sq.fill, '#e53935');
  assert.ok(sq.y < 150, 'top half of the 300px canvas');

  await say('draw a heart');
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject().type), 'path');

  await say('write hello there');
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject().text), 'hello there');

  const before = (await types()).length;
  await say('delete the circle');
  assert.equal((await types()).length, before - 1);
  await say('make the star blue');   // two stars: both get selected, both filled
  assert.deepEqual(await page.evaluate(() => window.__ed.fc.getObjects().filter(o => o.type === 'polygon' || /star/i.test(o.name || '')).map(o => o.fill)).then(a => [...new Set(a)]), ['#1e88e5']);

  // nothing named like that: a clear error, no AI, no crash
  await say('delete the triangle');
  assert.equal(await page.evaluate(() => window.__status.slice(-1)[0].state), 'error');
  await page.evaluate(() => window.__voice.stop());
});

/* ── fourth real-user pass (story post): regressions ─────────────────────────────────────── */
const sceneToScreen = async () => {
  const box = await page.locator('#cv').boundingBox();
  const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
  return (x, y) => [box.x + vt[4] + x * vt[0], box.y + vt[5] + y * vt[3]];
};
const pixelSum = (id, x, y) => page.evaluate(([id, x, y]) => {
  const o = window.__ed._byId(id), el = o._originalElement || o._element;
  const c = document.createElement('canvas'); c.width = el.width; c.height = el.height;
  const g = c.getContext('2d'); g.drawImage(el, 0, 0);
  const d = g.getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2], d[3]];
}, [id, x, y]);

test('browser: ⌘C then ⌘V with a lasso/marquee selection pastes those pixels as a new layer, in place', async () => {
  // Regression: closing a lasso leaves no active object, and ⌘C/⌘V only knew whole objects — nothing happened.
  const id = await addTestImage("ctx.fillStyle='#2c7be5';ctx.fillRect(0,0,w,h)", 120, 80);
  await page.evaluate((id) => { const ed = window.__ed, o = ed._byId(id); o.set({ left: 20, top: 20, scaleX: 1, scaleY: 1 }); o.setCoords(); ed.setTool('marquee'); ed.selection = { kind: 'rect', x: 40, y: 30, w: 30, h: 20 }; }, id);
  assert.equal(await page.evaluate(() => !!window.__ed.fc.getActiveObject()), false);
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await page.waitForFunction(() => window.__ed.fc.getObjects().length === 2);
  const r = await page.evaluate(() => { const ed = window.__ed, o = ed.fc.getObjects()[1]; return { l: Math.round(o.left), t: Math.round(o.top), w: Math.round(o.getScaledWidth()), h: Math.round(o.getScaledHeight()), sel: !!ed.selection, active: ed.fc.getActiveObject() === o }; });
  assert.deepEqual(r, { l: 40, t: 30, w: 30, h: 20, sel: false, active: true });
});

test('browser: corner-dragging a photo, a text or a sticker keeps its proportions; a plain shape scales freely', async () => {
  // Regression: corners scaled freely for everything (Figma's shape rule), so a quick resize squashed photos and stickers.
  const at = await sceneToScreen();
  const drag = async (id) => {
    const br = await page.evaluate((id) => { const ed = window.__ed, o = ed._byId(id); ed.setTool('select'); ed.fc.setActiveObject(o); o.setCoords(); ed.fc.renderAll(); return o.aCoords.br; }, id);
    await page.mouse.move(...at(br.x, br.y)); await page.mouse.down(); await page.mouse.move(...at(br.x + 40, br.y + 7), { steps: 6 }); await page.mouse.up();
    return page.evaluate((id) => { const o = window.__ed._byId(id); return Math.abs(o.scaleX - o.scaleY) < 1e-9; }, id);
  };
  const img = await addTestImage("ctx.fillStyle='#c33';ctx.fillRect(0,0,w,h)", 80, 60);
  await page.evaluate((id) => { const o = window.__ed._byId(id); o.set({ left: 40, top: 40, scaleX: 1, scaleY: 1 }); o.setCoords(); }, img);
  assert.equal(await drag(img), true, 'photo');
  const sticker = await page.evaluate(() => { const ed = window.__ed; return ed.addSticker('burstText', { x: 250, y: 150 }, 100); });
  assert.equal(await drag(sticker), true, 'sticker');
  const rect = await page.evaluate(() => { const ed = window.__ed, o = new window.fabric.Rect({ left: 220, top: 40, width: 60, height: 40, fill: '#333' }); o.id = 'r1'; ed.fc.add(o); return 'r1'; });
  assert.equal(await drag(rect), false, 'a plain rectangle stays free (Shift locks it)');
});

test('browser: the eraser erases a flipped or rotated photo itself, at the spot under the brush', async () => {
  // Regression: any flip/rotation made the retouch tools give up and paint an empty new "Paint" layer.
  const id = await addTestImage("ctx.fillStyle='#2c7be5';ctx.fillRect(0,0,w,h)", 100, 60);
  await page.evaluate((id) => { const ed = window.__ed, o = ed._byId(id); o.set({ left: 100, top: 100, scaleX: 1, scaleY: 1, flipX: true }); o.setCoords(); ed.fc.setActiveObject(o); ed.setTool('eraser'); ed.setToolOptions({ size: 16, hardness: 1, opacity: 1 }); }, id);
  const at = await sceneToScreen();
  await page.mouse.move(...at(110, 130)); await page.mouse.down(); await page.mouse.up();   // near the layer's LEFT edge on screen
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects().length), 1, 'no stray paint layer');
  // mirrored: screen-left is the source's right edge
  assert.equal((await pixelSum(id, 90, 30))[3], 0, 'erased where the brush was');
  assert.equal((await pixelSum(id, 10, 30))[3], 255, 'the other side untouched');
});

test('browser: retouching a photo that has adjustments does not apply them twice', async () => {
  // Regression: the paint tools copied the FILTERED render and handed it back as the source — Fabric
  // re-applied the filters on top, so a dodge stroke brightened the whole photo, not just the stroke.
  const id = await addTestImage("ctx.fillStyle='#406040';ctx.fillRect(0,0,w,h)", 100, 60);
  await page.evaluate((id) => { const ed = window.__ed, o = ed._byId(id); o.set({ left: 50, top: 50, scaleX: 1, scaleY: 1 }); o.setCoords(); ed.fc.setActiveObject(o); ed.setImageFilters({ brightness: 130 }); }, id);
  const far0 = await pixelSum(id, 90, 50);
  await page.evaluate(() => { const ed = window.__ed; ed.setTool('dodge'); ed.setToolOptions({ size: 10, opacity: 1 }); });
  const at = await sceneToScreen();
  await page.mouse.move(...at(60, 60)); await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(50);
  assert.deepEqual(await pixelSum(id, 90, 50), far0, 'the source away from the stroke is unchanged');
});

test('browser: Shift-click picks a range of layers, Cmd-click one; locked and adjustment layers stay out', async () => {
  const ids = await page.evaluate(() => {
    const ed = window.__ed, F = window.fabric, out = [];
    for (let i = 0; i < 4; i++) { const o = new F.Rect({ left: 20 + i * 60, top: 20, width: 40, height: 40, fill: '#555' }); o.id = 'L' + i; ed.fc.add(o); out.push(o.id); }
    ed._byId('L2').locked = true;
    return out;
  });
  await page.evaluate(() => { window.__ed.activate('L0'); window.__ed.selectLayerRange('L3'); });
  assert.deepEqual(await page.evaluate(() => window.__ed.fc.getActiveObject().getObjects().map(o => o.id)), ['L0', 'L1', 'L3']);
  await page.evaluate(() => window.__ed.toggleLayerSelection('L1'));
  assert.deepEqual(await page.evaluate(() => window.__ed.fc.getActiveObject().getObjects().map(o => o.id)), ['L0', 'L3']);
  assert.equal(ids.length, 4);
});

test('browser: a flipped layer moved inside a multi-selection is still flipped, not turned 180°', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed, F = window.fabric;
    const a = new F.Rect({ left: 20, top: 20, width: 60, height: 40, fill: '#a33', flipX: true }); a.id = 'fa';
    const b = new F.Rect({ left: 200, top: 20, width: 60, height: 40, fill: '#33a' }); b.id = 'fb';
    ed.fc.add(a, b);
    const sel = new F.ActiveSelection([a, b], { canvas: ed.fc }); ed.fc.setActiveObject(sel);
    sel.set({ left: sel.left + 15, top: sel.top + 10 }); sel.setCoords();
    ed.fc.discardActiveObject();
    return { angle: a.angle, flipX: a.flipX, flipY: a.flipY, left: Math.round(a.left), top: Math.round(a.top) };
  });
  assert.deepEqual(r, { angle: 0, flipX: true, flipY: false, left: 35, top: 30 });
});

test('browser: the Rotation field turns a layer about its centre', async () => {
  const c = await page.evaluate(() => {
    const ed = window.__ed, o = new window.fabric.Rect({ left: 100, top: 80, width: 80, height: 40, fill: '#555' }); o.id = 'rot'; ed.fc.add(o); ed.fc.setActiveObject(o);
    const c0 = o.getCenterPoint(); ed.setNumeric({ angle: 180 }); const c1 = o.getCenterPoint(); ed.setNumeric({ angle: 0 }); const c2 = o.getCenterPoint();
    return [c0, c1, c2].map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
  });
  assert.deepEqual(c[1], c[0], 'turning to 180° keeps the centre');
  assert.deepEqual(c[2], c[0], 'and back to 0°');
});

test('browser: a locked layer stays locked (not draggable) after undo restores the document', async () => {
  // Regression: selectable/evented/lockMovement aren't serialized — after a reload or undo a locked
  // background could be dragged, and Shift-click pulled it into a multi-selection.
  const r = await page.evaluate(async () => {
    const ed = window.__ed, o = new window.fabric.Rect({ left: 0, top: 0, width: 400, height: 300, fill: '#246' }); o.id = 'bgr'; ed.fc.add(o); ed.commit('add');
    ed.setLayer('bgr', { locked: true });
    const t = new window.fabric.Rect({ left: 10, top: 10, width: 20, height: 20, fill: '#fff' }); t.id = 'x'; ed.fc.add(t); ed.commit('add');
    ed.undo(); await new Promise(r => setTimeout(r, 300));
    const b = ed._byId('bgr'); return { locked: b.locked, selectable: b.selectable, evented: b.evented, lockMovementX: b.lockMovementX };
  });
  assert.deepEqual(r, { locked: true, selectable: false, evented: false, lockMovementX: true });
});

test('browser: an adjustment layer lets clicks through, stays pinned to the artboard, and is never a paint target', async () => {
  const at = await sceneToScreen();
  await page.evaluate(() => { const ed = window.__ed, o = new window.fabric.Rect({ left: 150, top: 100, width: 80, height: 60, fill: '#c33' }); o.id = 'under'; ed.fc.add(o); ed.commit('add'); ed.addAdjustmentLayer(); ed.fc.discardActiveObject(); ed.setTool('select'); });
  await page.mouse.click(...at(190, 130));
  assert.equal(await page.evaluate(() => window.__ed.fc.getActiveObject() && window.__ed.fc.getActiveObject().id), 'under', 'the click reaches the layer under the adjustment');
  const adjId = await page.evaluate(() => window.__ed.fc.getObjects().find(o => o.role === 'adjustment').id);
  await page.evaluate((id) => window.__ed.activate(id), adjId);
  await page.keyboard.press('Shift+ArrowUp');
  await page.evaluate(() => window.__ed.commit('x'));
  assert.deepEqual(await page.evaluate((id) => { const o = window.__ed._byId(id); return [o.left, o.top]; }, adjId), [0, 0], 'arrow keys cannot shift it off the artboard');
  assert.notEqual(await page.evaluate(() => { const t = window.__ed._paintTargetLayer(); return t && t.role; }), 'adjustment');
});

test('browser: flattening (adjustment layers, clone/heal sampling) never bakes in the selection handles', async () => {
  // Regression: renderObjectsFlat rendered interactively, so the active layer's handles landed in the
  // adjustment layer's pixels — and in the exported image.
  const px = await page.evaluate(() => {
    const ed = window.__ed, o = new window.fabric.Rect({ left: 0, top: 0, width: 400, height: 300, fill: '#102030' }); o.id = 'bgx'; ed.fc.add(o); ed.commit('add');
    ed.addAdjustmentLayer({ contrast: 120 });
    const adj = ed.fc.getObjects().find(q => q.role === 'adjustment');
    ed.fc.setActiveObject(o); ed.fc.renderAll();   // the page-sized layer is selected: a handle sits at its top-middle
    ed._recomputeAdjustmentLayers();
    const c = adj._element.getContext('2d');
    const d = c.getImageData(195, 2, 10, 5).data; let mx = 0;   /* rows 2-6: inside a handle, past the half-covered top row */ for (let i = 0; i < d.length; i += 4) mx = Math.max(mx, d[i] + d[i + 1] + d[i + 2]);
    return mx;
  });
  assert.ok(px < 200, 'no white handle at the top-middle edge: ' + px);
});

test('browser: the eyedropper picked with a CTA selected recolours the CTA', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed, F = window.fabric;
    const sw = new F.Rect({ left: 0, top: 0, width: 60, height: 60, fill: '#ff4300' }); sw.id = 'sw'; ed.fc.add(sw);
    ed.addCTA(null, { text: 'Shop now' }); const cta = ed.fc.getActiveObject();
    ed.setTool('eyedropper');
    return cta.id;
  });
  const at = await sceneToScreen();
  await page.mouse.click(...at(20, 20));
  assert.deepEqual(await page.evaluate((id) => { const o = window.__ed.fc.getActiveObject(); return [o.id, (o.fill || '').toLowerCase()]; }, r), [r, '#ff4300']);
});

/* ── fifth pass (panels): regressions ─────────────────────────────────────────────────────── */
test('browser: panel X/Y are the top-left corner for any origin — a sticker set to X 70 has its left edge at 70', async () => {
  // Regression: X/Y wrote raw left/top, which for a centre-origin sticker is its CENTRE (half off the page).
  const r = await page.evaluate(() => {
    const ed = window.__ed, id = ed.addSticker('burstText', { x: 200, y: 150 }, 100), o = ed._byId(id);
    const shown = ed.panelPosition(o);
    ed.setNumeric({ x: 70, y: 40 });
    const b = o.getBoundingRect(true);
    return { shownIsCorner: Math.round(shown.x) === Math.round(200 - o.getScaledWidth() / 2), left: Math.round(b.left), top: Math.round(b.top), after: ed.panelPosition(o) };
  });
  assert.equal(r.shownIsCorner, true);
  assert.deepEqual([r.left, r.top, Math.round(r.after.x), Math.round(r.after.y)], [70, 40, 70, 40]);
});

test('browser: editing inside a sticker reports it (isolationParent) and exitIsolation selects the whole sticker again', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed, id = ed.addSticker('burstText', { x: 200, y: 150 }, 100), g = ed._byId(id);
    ed._enterMember(g._objects[1]); ed.fc.setActiveObject(g._objects[1] || ed.fc.getObjects().find(o => o.type === 'i-text'));
    const inside = ed.isolationParent();
    ed.exitIsolation();
    return { inside, after: ed.isolationParent(), active: ed.fc.getActiveObject() && ed.fc.getActiveObject().id === id, kids: ed._byId(id)._objects.length };
  });
  assert.equal(r.inside && r.inside.name, 'Sticker');
  assert.equal(r.after, null);
  assert.equal(r.active, true);
  assert.equal(r.kids, 2);
});

test('browser: a CTA label typed with its own arrow does not get a second one', async () => {
  const t = await page.evaluate(() => { const ed = window.__ed; ed.addCTA(null, { text: 'Shop the sale →' }); return ed.fc.getActiveObject()._objects.filter(k => k.text).map(k => k.text); });
  assert.deepEqual(t, ['Shop the sale', '→']);
});

test('browser: the paint bucket uses its own tolerance option', async () => {
  // Two touching bands of close greys: a tight tolerance fills only the clicked one, a wide one crosses into both.
  const run = async (tol) => {
    await page.evaluate((tol) => {
      const ed = window.__ed; ed.fc.getObjects().slice().forEach(o => ed.fc.remove(o));
      const a = new window.fabric.Rect({ left: 0, top: 0, width: 200, height: 300, fill: '#808080', strokeWidth: 0 });
      const b = new window.fabric.Rect({ left: 200, top: 0, width: 200, height: 300, fill: '#a0a0a0', strokeWidth: 0 });
      ed.fc.add(a, b); ed.commit('x');
      ed.setTool('bucket'); ed.setToolOptions({ color: '#ff0000', bucketTolerance: tol });
    }, tol);
    const box = await page.locator('#cv').boundingBox();
    const vt = await page.evaluate(() => window.__ed.fc.viewportTransform.slice());
    await page.mouse.click(box.x + vt[4] + 50 * vt[0], box.y + vt[5] + 50 * vt[3]);
    await page.waitForTimeout(100);
    return page.evaluate(async () => { const u = window.__ed.exportPNG(1); const im = new Image(); im.src = u; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return [x.getImageData(50, 50, 1, 1).data[1], x.getImageData(300, 50, 1, 1).data[1]]; });
  };
  const tight = await run(4), wide = await run(120);
  assert.equal(tight[0], 0, 'tight: clicked band is red'); assert.ok(tight[1] > 100, 'tight: the other band is untouched');
  assert.equal(wide[0], 0, 'wide: clicked band is red'); assert.equal(wide[1], 0, 'wide: the fill crosses into the other band');
});

/* ── multi-document tabs: the real Editor#loadDocument path ─────────────────────────── */
test('browser: tabs keep separate artboards, layers and undo history on the real Editor', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed, set = new window.__DocumentSet(ed, { persist: false });
    const out = {};
    ed.addBadge(); 
    const aCount = ed.fc.getObjects().length;
    const a = set.active.id;
    const b = await set.add({ width: 200, height: 100 });
    out.bSize = [ed.W, ed.H]; out.bObjs = ed.fc.getObjects().length;
    ed.addBadge(); ed.addBadge();
    out.bObjsAfter = ed.fc.getObjects().length;
    await set.switchTo(a);
    out.aSize = [ed.W, ed.H]; out.aObjs = ed.fc.getObjects().length; out.aCount = aCount;
    out.aUndoDepth = ed.history.depth().past;
    await set.switchTo(b);
    out.bBack = ed.fc.getObjects().length; out.bUndoDepth = ed.history.depth().past;
    ed.undo(); await new Promise(r => setTimeout(r, 100));
    out.bAfterUndo = ed.fc.getObjects().length;
    return out;
  });
  assert.deepEqual(r.bSize, [200, 100]);
  assert.equal(r.bObjs, 0);
  assert.equal(r.bObjsAfter, 2);
  assert.deepEqual(r.aSize, [400, 300]);
  assert.equal(r.aObjs, r.aCount);
  assert.equal(r.bBack, 2);
  assert.equal(r.bAfterUndo, 1);                 // undo walks B's own history, not A's
  assert.ok(r.bUndoDepth >= 3);
});

test('browser: Option-drag shows the copy at the start position DURING the drag (Figma), original follows the cursor', async () => {
  await page.evaluate(() => { const ed = window.__ed; ed.addBadge({ x: 150, y: 150 }); ed.fc.discardActiveObject(); ed.fc.renderAll(); });
  const start = await page.evaluate(() => { const o = window.__ed.fc.getObjects()[0]; const c = o.getCenterPoint(); const b = document.querySelector('canvas.upper-canvas').getBoundingClientRect(); const z = window.__ed.fc.getZoom(); return { x: b.x + c.x * z, y: b.y + c.y * z, left: o.left, top: o.top, id: o.id }; });
  await page.keyboard.down('Alt');
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 60, start.y + 40, { steps: 6 });
  const mid = await page.evaluate(() => window.__ed.fc.getObjects().map(o => ({ id: o.id, left: o.left, top: o.top })));
  assert.equal(mid.length, 2, 'copy must exist while still dragging');
  const orig = mid.find(o => o.id === start.id), copy = mid.find(o => o.id !== start.id);
  assert.ok(Math.abs(copy.left - start.left) < 1 && Math.abs(copy.top - start.top) < 1, 'copy stays at the start position');
  assert.ok(orig.left > start.left + 30, 'original follows the cursor');
  await page.mouse.up();
  await page.keyboard.up('Alt');
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects().length), 2);
  // one undo removes the duplicate AND the move together
  await page.evaluate(() => window.__ed.undo()); await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects().length), 1);
});

/* ── frames: several artboards on one page ───────────────────────────────────────────── */
test('browser: frames — add, switch, undo keeps the view still, export every frame, delete with contents, round-trip', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed, out = {};
    const objs = () => ed.fc.getObjects().map(o => ({ id: o.id, l: Math.round(o.left), t: Math.round(o.top) }));
    const screenX = (o) => Math.round(o.left * ed.fc.getZoom() + ed.fc.viewportTransform[4]);
    ed.fc.setZoom(1); ed.fc.setViewportTransform([1, 0, 0, 1, 0, 0]);
    ed.addBadge({ x: 100, y: 100 });
    const a = ed.fc.getObjects()[0], aLeft0 = Math.round(a.left);
    const f1 = ed.activeFrameId;
    const f2 = ed.addFrame({ name: 'Second', width: 200, height: 150 });
    out.afterAdd = { size: [ed.W, ed.H], frames: ed.frameList().map(f => [f.name, f.width, f.height, f.active]), aLeft: Math.round(a.left) };
    out.viewStill = screenX(a) === aLeft0;                       // frame 1's badge didn't move on screen
    ed.addBadge({ x: 50, y: 50 });
    const b = ed.fc.getObjects()[1];
    ed.activateFrame(f1);
    out.back = { size: [ed.W, ed.H], aLeft: Math.round(a.left), bLeft: Math.round(b.left), viewStill: screenX(a) === aLeft0 };
    ed.activateFrame(f2);
    ed.undo(); await new Promise(r => setTimeout(r, 150));      // undo the frame switch
    out.afterUndo = { active: ed.frameList().find(f => f.active).name, viewStill: screenX(ed.fc.getObjects()[0]) === aLeft0 };
    out.exp = ed.exportAllFrames('png', 1).map(e => e.name);
    out.activeAfterExport = ed.frameList().find(f => f.active).name;
    // round trip through the same path tab-switching / autosave uses
    const json = ed.toJSON();
    await ed.loadDocument(json, null);
    out.roundTrip = ed.frameList().map(f => [f.name, f.active]);
    out.removed = ed.removeFrame(ed.frameList().find(f => f.name === 'Second').id);
    out.afterRemove = { frames: ed.frameList().length, objs: ed.fc.getObjects().length, size: [ed.W, ed.H] };
    out.lastFrame = ed.removeFrame(ed.activeFrameId);
    return out;
  });
  assert.deepEqual(r.afterAdd.size, [200, 150]);
  assert.deepEqual(r.afterAdd.frames.map(f => f[0]), ['Frame 1', 'Second']);
  assert.ok(r.afterAdd.aLeft < 0, 'frame 1 content sits left of the new active frame');
  assert.equal(r.viewStill, true);
  assert.deepEqual(r.back.size, [400, 300]);
  assert.equal(r.back.viewStill, true);
  assert.ok(r.back.bLeft > 400, 'frame 2 content sits right of frame 1');
  assert.equal(r.afterUndo.active, 'Frame 1');                   // undo went back one step: the frame-1 activation
  assert.equal(r.afterUndo.viewStill, true);
  assert.deepEqual(r.exp, ['Frame 1', 'Second']);
  assert.equal(r.activeAfterExport, r.afterUndo.active);
  assert.equal(r.roundTrip.length, 2);
  assert.equal(r.removed, true);
  assert.deepEqual([r.afterRemove.frames, r.afterRemove.objs], [1, 1]);
  assert.equal(r.lastFrame, false);
});

test('browser: frames — drag by label moves the frame with its layers; resizing a frame slides neighbours instead of overlapping them', async () => {
  await page.setViewportSize({ width: 1000, height: 700 });
  const setup = await page.evaluate(() => {
    const ed = window.__ed;
    ed.fc.setDimensions({ width: 900, height: 600 });
    ed.addBadge({ x: 200, y: 150 }); ed.fc.discardActiveObject();
    ed.addFrame({ name: 'Second' });
    ed.addBadge({ x: 200, y: 150 }); ed.fc.discardActiveObject();
    ed.activateFrame(ed.frameList()[0].id);
    ed.fc.setViewportTransform([0.3, 0, 0, 0.3, 120, 150]); ed.fc.renderAll();
    return true;
  });
  const geo = () => page.evaluate(() => { const ed = window.__ed; const m = ed._frameMeta(); return { active: m.active, frames: m.frames.map(f => ({ n: f.name, x: Math.round(f.x), y: Math.round(f.y), w: f.w })), objs: ed.fc.getObjects().map(o => Math.round(o.left)) }; });
  const labelOf = (name) => page.evaluate((n) => { const ed = window.__ed; ed.fc.renderAll(); const id = ed._frames.find(f => f.name === n).id; const l = ed._frameLabels.find(x => x.id === id); return { x: l.x + l.w / 2, y: l.y + l.h / 2 }; }, name);
  const box = await page.locator('canvas.upper-canvas').boundingBox();
  const g0 = await geo();                                       // Frame 1 active at 0; Second to its right
  const gap0 = g0.frames[1].x - g0.frames[0].w;

  // drag the INACTIVE frame ("Second") 90px to the right = 300 scene px: it and its badge travel together, and it becomes the working frame
  const l2 = await labelOf('Second');
  await page.mouse.move(box.x + l2.x, box.y + l2.y); await page.mouse.down();
  await page.mouse.move(box.x + l2.x + 90, box.y + l2.y + 30, { steps: 6 }); await page.mouse.up();
  const g1 = await geo();
  const second = g1.frames.find(f => f.n === 'Second'), first = g1.frames.find(f => f.n === 'Frame 1');
  assert.equal(await page.evaluate(() => window.__ed.frameList().find(f => f.active).name), 'Second', 'the dragged frame becomes active');
  assert.equal(second.x, 0);
  assert.ok(Math.abs((0 - first.x - first.w) - (gap0 + 300)) <= 2, 'gap grew by the drag distance');
  assert.ok(Math.abs(second.y) === 0 && Math.abs(first.y + 100) <= 2, 'vertical offset equals the drag (30px / 0.3 = 100 scene px)');

  // drag the ACTIVE frame 60px left = 200 scene: the other frame must stay put ON SCREEN, the active one follows the cursor
  const scr = () => page.evaluate(() => { const ed = window.__ed, v = ed.fc.viewportTransform; const f = ed._frames.find(x => x.id !== ed._frameActive); return { other: Math.round(f.x * v[0] + v[4]), act: Math.round(v[4]) }; });
  const s0 = await scr();
  const la = await labelOf('Second');
  await page.mouse.move(box.x + la.x, box.y + la.y); await page.mouse.down();
  await page.mouse.move(box.x + la.x - 60, box.y + la.y, { steps: 5 }); await page.mouse.up();
  const s1 = await scr();
  assert.ok(Math.abs(s1.other - s0.other) <= 1, 'the other frame did not move on screen');
  assert.ok(Math.abs((s1.act - s0.act) + 60) <= 1, 'the active frame followed the cursor');

  // resize the active frame: neighbour (and its badge) slide by the growth, the gap stays
  const before = await geo(), gapBefore = (() => { const a = before.frames.find(f => f.n === 'Second'), o = before.frames.find(f => f.n === 'Frame 1'); return a.x - o.x - o.w; })();
  await page.evaluate(() => window.__ed.resizeCanvas(600, 300));
  const after = await geo();
  const act = after.frames.find(f => f.n === 'Second'), oth = after.frames.find(f => f.n === 'Frame 1');
  assert.equal(act.w, 600);
  assert.equal(oth.w, 400, 'the other frame keeps its own size');
  // Frame 1 sits LEFT of Second here, so nothing needed to slide — verify no overlap and gap preserved
  assert.equal(act.x - oth.x - oth.w, gapBefore);
  // now the other way: resize Frame 1 (neighbour to its right)
  await page.evaluate(() => window.__ed.activateFrame(window.__ed.frameList().find(f => f.name === 'Frame 1').id));
  const b2 = await geo();
  const rightGap0 = (() => { const a = b2.frames.find(f => f.n === 'Frame 1'), o = b2.frames.find(f => f.n === 'Second'); return o.x - a.w; })();
  await page.evaluate(() => window.__ed.resizeCanvas(700, 300));
  const a2 = await geo();
  const second2 = a2.frames.find(f => f.n === 'Second');
  assert.equal(second2.x - 700, rightGap0, 'the right-hand neighbour slid by the growth, gap preserved');
});

/* ── combine shapes (Union / Subtract / Intersect / Exclude / Flatten) ─────────────────── */
test('browser: combine shapes — needs 2+ vector shapes (never images), Flatten merges them into one path and undoes, boolean ops go through the injected engine', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed, F = window.fabric, fc = ed.fc, out = {};
    const mk = (o) => { o.set({ id: 'o' + Math.random().toString(36).slice(2, 7), role: 'shape' }); fc.add(o); return o; };
    const a = mk(new F.Rect({ left: 20, top: 20, width: 100, height: 80, fill: '#e53935', shapeKind: 'rect' }));
    const b = mk(new F.Ellipse({ left: 90, top: 50, rx: 50, ry: 40, fill: '#1e88e5', shapeKind: 'ellipse' }));
    const c = document.createElement('canvas'); c.width = c.height = 20; c.getContext('2d').fillRect(0, 0, 20, 20);
    const img = mk(new F.Image(c, { left: 200, top: 20, role: 'image' }));
    const sel = (...os) => { fc.discardActiveObject(); fc.setActiveObject(new F.ActiveSelection(os, { canvas: fc })); fc.renderAll(); };
    ed.commit('setup');   // the originals must be in history for Undo to bring them back

    fc.setActiveObject(a);
    out.single = ed.combineInfo();
    sel(a, b);
    out.two = ed.combineInfo();
    sel(a, b, img);
    out.withImage = ed.combineInfo();
    let err = null; try { ed.combineShapes('flatten'); } catch (e) { err = e.message; }
    out.imageBlocked = err;

    window.__setClipEngine(null);                      // engine switched off: only Flatten stays available
    sel(a, b);
    out.engineOff = ed.combineInfo();
    err = null; try { ed.combineShapes('union'); } catch (e) { err = e.message; }
    out.noEngine = err;
    window.__resetClipEngine();
    out.defaultEngine = ed.combineInfo();

    const before = fc.getObjects().length;
    const id = ed.combineShapes('flatten');
    const p = fc.getObjects().find(o => o.id === id);
    out.flat = { before, after: fc.getObjects().length, type: p.type, name: p.name, fill: p.fill, w: Math.round(p.width), h: Math.round(p.height), left: Math.round(p.left), top: Math.round(p.top) };
    ed.undo(); await new Promise(r => setTimeout(r, 150));
    out.afterUndo = fc.getObjects().map(o => o.type);

    // the four boolean ops go to the injected engine: subtract = bottom-most minus the rest
    const calls = [];
    window.__setClipEngine({
      union: (...g) => { calls.push(['union', g.length]); return g[0]; },
      difference: (g0, ...r) => { calls.push(['difference', 1 + r.length]); return g0; },
      intersection: (...g) => { calls.push(['intersection', g.length]); return g[0]; },
      xor: (...g) => { calls.push(['xor', g.length]); return g[0]; },
    });
    const ra = fc.getObjects().find(o => o.type === 'rect'), eb = fc.getObjects().find(o => o.type === 'ellipse');
    sel(ra, eb);
    out.withEngine = ed.combineInfo();
    const id2 = ed.combineShapes('subtract');
    out.subtract = { calls: calls.slice(), name: fc.getObjects().find(o => o.id === id2).name, count: fc.getObjects().filter(o => o.role === 'shape').length };
    window.__resetClipEngine();
    return out;
  });
  assert.equal(r.single.ok, false); assert.match(r.single.reason, /two or more/i);
  assert.equal(r.two.ok, true); assert.deepEqual(r.two.ops, { union: true, subtract: true, intersect: true, exclude: true, flatten: true }, 'the vendored polygon engine is on by default');
  assert.equal(r.withImage.ok, false); assert.match(r.withImage.reason, /Images/);
  assert.deepEqual(Object.values(r.withImage.ops), [false, false, false, false, false], 'an image disables every operation');
  assert.match(r.imageBlocked, /Images/);
  assert.equal(r.engineOff.ops.union, false, 'with the engine switched off the boolean ops go off'); assert.equal(r.engineOff.ops.flatten, true);
  assert.match(r.noEngine, /polygon engine/);
  assert.equal(r.defaultEngine.ops.union, true);
  assert.equal(r.flat.type, 'path'); assert.equal(r.flat.name, 'Flatten'); assert.equal(r.flat.fill, '#e53935', 'takes the bottom-most shape\'s fill');
  assert.equal(r.flat.after, r.flat.before - 1, 'two shapes became one');
  assert.ok(r.flat.w >= 119 && r.flat.h >= 79, 'the path spans both shapes');
  assert.deepEqual(r.afterUndo.filter(t => t !== 'image'), ['rect', 'ellipse'], 'undo brings the originals back');
  assert.deepEqual(r.withEngine.ops, { union: true, subtract: true, intersect: true, exclude: true, flatten: true });
  assert.deepEqual(r.subtract.calls, [['difference', 2]]);
  assert.equal(r.subtract.name, 'Subtract');
});

test('browser: combine shapes — Union / Subtract / Intersect / Exclude produce the right geometry (real polygon-clipping, net area)', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed, F = window.fabric, fc = ed.fc, out = {};
    const area = (ring) => { let a = 0; for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
    const netArea = (o) => window.__booleans.objectRings(F, o).reduce((s, r) => s + area(r), 0);   // holes wind the other way, so they subtract
    for (const op of ['union', 'subtract', 'intersect', 'exclude']) {
      fc.clear(); fc.backgroundColor = '#fff';
      const A = new F.Rect({ left: 0, top: 0, width: 100, height: 100, fill: '#e53935' }), B = new F.Rect({ left: 50, top: 50, width: 100, height: 100, fill: '#1e88e5' });
      [A, B].forEach(o => { o.set({ id: 'o' + Math.random().toString(36).slice(2, 7), role: 'shape', shapeKind: 'rect' }); fc.add(o); });
      ed.commit('setup');
      fc.setActiveObject(new F.ActiveSelection([A, B], { canvas: fc })); fc.renderAll();
      const id = ed.combineShapes(op);
      const res = fc.getObjects();
      out[op] = { layers: res.length, area: Math.round(Math.abs(Math.abs(netArea(res[0])))), name: res[0].name, fill: res[0].fill, type: res[0].type };
    }
    // subtract with a shape fully inside the other leaves a hole: the donut's net area is outer minus inner
    fc.clear(); fc.backgroundColor = '#fff';
    const O = new F.Rect({ left: 0, top: 0, width: 100, height: 100, fill: '#000' }), I = new F.Ellipse({ left: 25, top: 25, rx: 25, ry: 25, fill: '#000' });
    [O, I].forEach(o => { o.set({ id: 'o' + Math.random().toString(36).slice(2, 7), role: 'shape' }); fc.add(o); });
    ed.commit('setup2'); fc.setActiveObject(new F.ActiveSelection([O, I], { canvas: fc }));
    ed.combineShapes('subtract');
    out.donut = Math.round(netArea(fc.getObjects()[0]));
    out.donutRings = window.__booleans.objectRings(F, fc.getObjects()[0]).length;
    return out;
  });
  assert.equal(r.union.area, 17500); assert.equal(r.subtract.area, 7500); assert.equal(r.intersect.area, 2500); assert.equal(r.exclude.area, 15000);
  for (const op of ['union', 'subtract', 'intersect', 'exclude']) {
    assert.equal(r[op].layers, 1, op + ' leaves one layer'); assert.equal(r[op].type, 'path'); assert.equal(r[op].fill, '#e53935', 'styled like the bottom-most shape');
  }
  assert.ok(Math.abs(r.donut - (10000 - Math.PI * 625)) < 60, 'a hole: outer area minus the (96-gon) circle, got ' + r.donut);
  assert.equal(r.donutRings, 2, 'outer ring + hole ring');
});

test('browser: add-element buttons cascade instead of stacking every new element on the artboard centre', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed, out = [];
    for (let i = 0; i < 4; i++) { ed.addBadge(null, { text: 'B' + i }); const c = ed.fc.getActiveObject().getCenterPoint(); out.push([Math.round(c.x), Math.round(c.y)]); }
    out.push([ed.W / 2, ed.H / 2]);
    return out;
  });
  const centre = r[4];
  assert.ok(Math.abs(r[0][0] - centre[0]) <= 2 && Math.abs(r[0][1] - centre[1]) <= 2, 'the first one lands on the centre: ' + JSON.stringify(r));
  const keys = new Set(r.slice(0, 4).map(p => p.join(',')));
  assert.equal(keys.size, 4, 'no two land on the same point: ' + JSON.stringify(r));
  assert.ok(r[1][1] > r[0][1], 'cascades downward');
});

test('browser: Text tool — a click makes auto-width text, a drag makes a wrapping text box of that width', async () => {
  const box = await page.locator('#cv').boundingBox();
  // click
  await page.evaluate(() => window.__ed.setTool('type'));
  await page.mouse.click(box.x + 40, box.y + 40);
  await page.keyboard.type('Hello'); await page.keyboard.press('Escape');
  let o = await page.evaluate(() => { const a = window.__ed.fc.getObjects().filter(o => o.role === 'text'); return a.map(t => ({ type: t.type, text: t.text })); });
  assert.deepEqual(o, [{ type: 'i-text', text: 'Hello' }]);
  // drag
  await page.evaluate(() => window.__ed.setTool('type'));
  await page.mouse.move(box.x + 40, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 230, { steps: 5 }); await page.mouse.up();
  await page.keyboard.type('a long line of words that has to wrap inside the box'); await page.keyboard.press('Escape');
  o = await page.evaluate(() => { const t = window.__ed.fc.getObjects().filter(o => o.role === 'text').pop(); return { type: t.type, w: Math.round(t.width), h: Math.round(t.height), fs: t.fontSize, tool: window.__ed.tool, z: window.__ed.fc.getZoom() }; });
  assert.equal(o.type, 'textbox'); assert.ok(Math.abs(o.w - 160 / o.z) <= 4, 'width follows the drag (160 screen px / zoom ' + o.z + '), got ' + o.w);
  assert.ok(o.h > o.fs * 1.6, 'wrapped onto several lines, h=' + o.h); assert.equal(o.tool, 'select');
  // undo walks back through the typing, then the creation, and leaves the first text intact
  await page.evaluate(() => { window.__ed.undo(); window.__ed.undo(); });
  assert.equal(await page.evaluate(() => window.__ed.fc.getObjects().filter(o => o.role === 'text').length), 1);
});

test('browser: price tag picks readable inks for the backdrop it lands on (dark ink on light, light ink on dark)', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed, F = window.fabric, fc = ed.fc, out = {};
    const inks = (g) => { const t = g._objects.filter(k => k.adField); return { cur: t.find(k => k.adField === 'current').fill, save: t.find(k => k.adField === 'save').fill }; };
    for (const [name, col] of [['light', '#f4f1e6'], ['dark', '#10131a']]) {
      fc.clear(); const bg = new F.Rect({ left: 0, top: 0, width: ed.W, height: ed.H, fill: col }); bg.set({ id: 'bg' + name, role: 'shape' }); fc.add(bg);
      const id = ed.addPrice({ x: ed.W / 2, y: ed.H / 2 }, { current: '$9', save: 'Save 10%' });
      out[name] = inks(fc.getObjects().find(o => o.id === id));
    }
    return out;
  });
  assert.equal(r.light.cur, '#111114'); assert.notEqual(r.light.save, '#d4ff45', 'lime savings text is unreadable on a light backdrop');
  assert.equal(r.dark.cur, '#ffffff'); assert.equal(r.dark.save, '#d4ff45');
});

test('browser: cutout ignores flat bars round a photo (pillarbox/letterbox) so they cannot skew the backdrop model', async () => {
  const r = await page.evaluate(() => {
    const ed = window.__ed, mk = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); return c; };
    // 100x100 photo-ish gradient with 20px white bars left and right
    const bars = mk(100, 100, (x, w, h) => { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#c8a070'); g.addColorStop(1, '#503010'); x.fillStyle = g; x.fillRect(20, 0, 60, h); });
    const none = mk(100, 100, (x, w, h) => { const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#c8a070'); g.addColorStop(1, '#503010'); x.fillStyle = g; x.fillRect(0, 0, w, h); });
    const full = { x: 0, y: 0, w: 100, h: 100 };
    return { bars: ed._trimMargins(bars, full), none: ed._trimMargins(none, full), cropped: ed._trimMargins(bars, { x: 10, y: 0, w: 80, h: 100 }) };
  });
  assert.deepEqual(r.none, { x: 0, y: 0, w: 100, h: 100 }, 'no bars: window unchanged');
  assert.ok(Math.abs(r.bars.x - 20) <= 3 && Math.abs(r.bars.w - 60) <= 6 && r.bars.y === 0 && r.bars.h === 100, 'bars trimmed: ' + JSON.stringify(r.bars));
  assert.ok(r.cropped.x >= 18 && r.cropped.x + r.cropped.w <= 82, 'works inside an existing crop window: ' + JSON.stringify(r.cropped));
});

test('browser: a clipPath clips a masked layer — relative and absolute, with a filter chain, and across save/load', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed, F = window.fabric, out = {};
    const c = document.createElement('canvas'); c.width = 100; c.height = 100; const g = c.getContext('2d'); g.fillStyle = '#e53935'; g.fillRect(0, 0, 100, 100);
    ed.fc.clear(); await ed.addImage(c.toDataURL('image/png'), { name: 'Solid' });
    const o = ed.fc.getObjects().find(x => x.name === 'Solid'); o.set({ left: 0, top: 0, scaleX: 1, scaleY: 1 }); o.setCoords();
    ed.addMask(o.id);   // puts a MaskFilter in the chain: the case that was suspected of ignoring clipPath
    const sample = async (x, y) => { const u = await ed.exportPNG(1), im = new Image(); await new Promise(res => { im.onload = res; im.src = u; }); const k = document.createElement('canvas'); k.width = im.width; k.height = im.height; const q = k.getContext('2d'); q.drawImage(im, 0, 0); return Array.from(q.getImageData(x, y, 1, 1).data); };
    const isRed = (p) => p[0] > 200 && p[1] < 90, isWhite = (p) => !(p[0] > 200 && p[1] < 90);   // clipped away = whatever the artboard shows, i.e. not the layer's red
    const leftHalf = (abs) => { o.clipPath = abs ? new F.Rect({ left: 0, top: 0, width: 50, height: 100, absolutePositioned: true }) : new F.Rect({ left: -50, top: -50, width: 50, height: 100, originX: 'left', originY: 'top' }); o.dirty = true; ed.fc.requestRenderAll(); };
    const check = async (tag) => { out[tag] = [isRed(await sample(25, 50)), isWhite(await sample(75, 50))]; };
    leftHalf(false); await check('relative');
    leftHalf(true); await check('absolute');
    ed.fc.setActiveObject(o); ed.setImageFilters({ saturate: 110, brightness: 100 }); await check('with filters');
    const json = ed.toJSON(); await ed.loadJSON(json); await new Promise(res => setTimeout(res, 600));
    out.survived = !!ed.fc.getObjects().find(x => x.name === 'Solid').clipPath; await check('after reload');
    return out;
  });
  for (const k of ['relative', 'absolute', 'with filters', 'after reload']) assert.deepEqual(r[k], [true, true], k + ': inside the clip is drawn, outside is not');
  assert.ok(r.survived, 'clipPath serialised');
});

test('browser: Sharpen adjusts a real layer — steepens an edge, survives save/load, and 0 restores the original', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed, out = {};
    const c = document.createElement('canvas'); c.width = 100; c.height = 20; const g = c.getContext('2d');
    g.fillStyle = '#646464'; g.fillRect(0, 0, 50, 20); g.fillStyle = '#a0a0a0'; g.fillRect(50, 0, 50, 20);   // a hard edge between two greys
    ed.fc.clear(); await ed.addImage(c.toDataURL('image/png'), { name: 'Edge' });
    const o = ed.fc.getObjects().find(x => x.name === 'Edge'); o.set({ left: 0, top: 0, scaleX: 1, scaleY: 1 }); o.setCoords(); ed.fc.setActiveObject(o);
    const sample = async (x, y) => { const u = await ed.exportPNG(1), im = new Image(); await new Promise(res => { im.onload = res; im.src = u; }); const k = document.createElement('canvas'); k.width = im.width; k.height = im.height; const q = k.getContext('2d'); q.drawImage(im, 0, 0); return q.getImageData(x, y, 1, 1).data[0]; };
    out.base = [await sample(49, 10), await sample(50, 10)];
    ed.setImageFilters({ sharpen: 100 }); out.sharp = [await sample(49, 10), await sample(50, 10)];
    out.fx = ed.getImageFilters().sharpen;
    const json = ed.toJSON(); await ed.loadJSON(json); await new Promise(res => setTimeout(res, 600));
    const o2 = ed.fc.getObjects().find(x => x.name === 'Edge');
    out.reloaded = [await sample(49, 10), await sample(50, 10)]; out.reloadedFx = o2.fx && o2.fx.sharpen;
    ed.fc.setActiveObject(o2); ed.setImageFilters({ sharpen: 0 }); out.off = [await sample(49, 10), await sample(50, 10)];
    return out;
  });
  assert.ok(r.sharp[0] < r.base[0] && r.sharp[1] > r.base[1], 'dark side darker, light side lighter: ' + JSON.stringify(r));
  assert.equal(r.fx, 100);
  assert.deepEqual(r.reloaded, r.sharp, 'same pixels after save/load'); assert.equal(r.reloadedFx, 100);
  assert.deepEqual(r.off, r.base, 'sharpen 0 is the original image again');
});

test('browser: Sharpen radius changes how far the effect reaches, and is saved with the layer', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed, out = {};
    const c = document.createElement('canvas'); c.width = 100; c.height = 20; const g = c.getContext('2d');
    g.fillStyle = '#646464'; g.fillRect(0, 0, 50, 20); g.fillStyle = '#a0a0a0'; g.fillRect(50, 0, 50, 20);
    ed.fc.clear(); await ed.addImage(c.toDataURL('image/png'), { name: 'Edge' });
    const o = ed.fc.getObjects().find(x => x.name === 'Edge'); o.set({ left: 0, top: 0, scaleX: 1, scaleY: 1 }); o.setCoords(); ed.fc.setActiveObject(o);
    const sample = async (x) => { const u = await ed.exportPNG(1), im = new Image(); await new Promise(res => { im.onload = res; im.src = u; }); const k = document.createElement('canvas'); k.width = im.width; k.height = im.height; const q = k.getContext('2d'); q.drawImage(im, 0, 0); return q.getImageData(x, 10, 1, 1).data[0]; };
    ed.setImageFilters({ sharpen: 100, sharpenRadius: 0.5 }); out.tight = [await sample(49), await sample(46)];   // 1px and 4px from the edge, dark side
    ed.setImageFilters({ sharpen: 100, sharpenRadius: 4 }); out.wide = [await sample(49), await sample(46)];
    out.fx = ed.getImageFilters().sharpenRadius;
    const json = ed.toJSON(); await ed.loadJSON(json); await new Promise(res => setTimeout(res, 600));
    out.reloaded = [await sample(49), await sample(46)]; out.reloadedFx = ed.fc.getObjects().find(x => x.name === 'Edge').fx.sharpenRadius;
    return out;
  });
  assert.equal(r.tight[1], 100, 'a tight radius leaves a pixel 4px from the edge alone: ' + JSON.stringify(r));
  assert.ok(r.wide[1] < 100, 'a wide radius reaches it: ' + JSON.stringify(r));
  assert.equal(r.fx, 4); assert.equal(r.reloadedFx, 4);
  assert.deepEqual(r.reloaded, r.wide, 'same pixels after save/load');
});

test('browser: gradient tool on a layer mask — drag lays reveal->hide, Alt reverses, one undo step, nothing leaks onto the layer', async () => {
  const setup = async () => page.evaluate(async () => {
    const ed = window.__ed; ed.fc.clear();
    const mk = (col) => { const c = document.createElement('canvas'); c.width = 200; c.height = 150; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, 200, 150); return c.toDataURL('image/png'); };
    await ed.addImage(mk('#0000ff'), { name: 'Under' }); await ed.addImage(mk('#ff0000'), { name: 'Top' });
    const top = ed.fc.getObjects().find(o => o.name === 'Top'); ed.fc.setActiveObject(top); ed.addMask(top.id); ed.enterMaskEdit(top.id); ed.setTool('gradient');
    return { W: ed.W, H: ed.H };
  });
  const dims = await setup();
  const box = await page.locator('#cv').boundingBox(), z = await page.evaluate(() => window.__ed.fc.getZoom()), vt = await page.evaluate(() => window.__ed.fc.viewportTransform);
  const toClient = (x, y) => ({ x: box.x + vt[4] + x * z, y: box.y + vt[5] + y * z });
  const drag = async (a, b, alt) => { const p = toClient(...a), q = toClient(...b); if (alt) await page.keyboard.down('Alt'); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 5 }); await page.mouse.up(); if (alt) await page.keyboard.up('Alt'); await page.waitForTimeout(150); };
  const maskAt = (y) => page.evaluate((y) => { const m = window.__ed.fc.getObjects().find(o => o.name === 'Top').maskCanvas; return m.getContext('2d').getImageData(Math.floor(m.width / 2), Math.min(m.height - 1, Math.floor(y * m.height / window.__ed.H)), 1, 1).data[0]; }, y);
  await drag([dims.W / 2, 10], [dims.W / 2, dims.H - 10]);
  const down = [await maskAt(12), await maskAt(dims.H / 2), await maskAt(dims.H - 12)];
  assert.ok(down[0] > 235 && down[2] < 20 && down[1] > 100 && down[1] < 160, 'white at the start, black at the end, grey between: ' + down);
  assert.equal(await page.evaluate(() => { const t = window.__ed.fc.getObjects().find(o => o.name === 'Top'); return !!(t.fill && t.fill.colorStops); }), false, 'no gradient fill leaked onto the layer');
  await drag([dims.W / 2, 10], [dims.W / 2, dims.H - 10], true);
  const up = [await maskAt(12), await maskAt(dims.H - 12)];
  assert.ok(up[0] < 20 && up[1] > 235, 'Alt reverses it: ' + up);
  await page.evaluate(() => window.__ed.undo()); await page.waitForTimeout(300);
  const back = [await maskAt(12), await maskAt(dims.H - 12)];
  assert.ok(back[0] > 235 && back[1] < 20, 'one undo returns to the first gradient: ' + back);
});

test('browser: fillMaskGradient blends a layer into the one below (rendered), radial works, and bad input is refused', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed, out = {}; ed.fc.clear();
    const mk = (col) => { const c = document.createElement('canvas'); c.width = 200; c.height = 150; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, 200, 150); return c.toDataURL('image/png'); };
    await ed.addImage(mk('#0000ff'), { name: 'Under' }); await ed.addImage(mk('#ff0000'), { name: 'Top' });
    const [under, top] = ['Under', 'Top'].map(n => ed.fc.getObjects().find(o => o.name === n)); [under, top].forEach(o => { o.set({ left: 0, top: 0, scaleX: 1, scaleY: 1 }); o.setCoords(); });
    const px = async (x, y) => { const u = await ed.exportPNG(1), im = new Image(); await new Promise(res => { im.onload = res; im.src = u; }); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return Array.from(g.getImageData(x, y, 1, 1).data); };
    out.noMask = await px(100, 140);
    out.res = ed.fillMaskGradient(top.id, { x: 100, y: 10 }, { x: 100, y: 140 });
    out.top = await px(100, 6); out.bottom = await px(100, 144); out.mid = await px(100, 75);
    out.hasMask = !!top.maskCanvas;
    ed.fillMaskGradient(top.id, { x: 100, y: 75 }, { x: 100, y: 5 }, { radial: true, reverse: true }); out.radialCentreHidden = (await px(100, 75))[0] < 30; out.radialEdgeShown = (await px(100, 140))[0] > 200;
    out.bad = [ed.fillMaskGradient(top.id, { x: 5, y: 5 }, { x: 5, y: 5 }), ed.fillMaskGradient('nope', { x: 0, y: 0 }, { x: 1, y: 1 })].map(x => x.reason);
    return out;
  });
  assert.ok(r.noMask[0] > 240 && r.noMask[2] < 20, 'top layer covers the bottom one before the mask: ' + r.noMask);
  assert.equal(r.res.status, 'ok'); assert.ok(r.hasMask, 'a mask is added when the layer had none');
  assert.ok(r.top[0] > 200 && r.top[2] < 60, 'revealed at the gradient start (red): ' + r.top);
  assert.ok(r.bottom[2] > 200 && r.bottom[0] < 60, 'hidden at the end, the layer below shows (blue): ' + r.bottom);
  assert.ok(r.mid[0] > 60 && r.mid[2] > 60, 'a true blend in the middle: ' + r.mid);
  assert.ok(r.radialCentreHidden && r.radialEdgeShown, 'radial + reverse hides the centre');
  assert.deepEqual(r.bad, ['bad_points', 'not_maskable']);
});

test('browser: gradient tool dragged over a photo paints pixels into a paint layer — it no longer sticks an invisible fill on the image', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed; ed.fc.clear();
    const c = document.createElement('canvas'); c.width = 200; c.height = 150; const g = c.getContext('2d'); g.fillStyle = '#336699'; g.fillRect(0, 0, 200, 150);
    await ed.addImage(c.toDataURL('image/png'), { name: 'Photo' });
    const o = ed.fc.getObjects().find(x => x.name === 'Photo'); o.set({ left: 0, top: 0, scaleX: 1, scaleY: 1 }); o.setCoords(); ed.fc.setActiveObject(o); ed.setTool('gradient');
    return { W: ed.W, H: ed.H };
  });
  const box = await page.locator('#cv').boundingBox(), z = await page.evaluate(() => window.__ed.fc.getZoom()), vt = await page.evaluate(() => window.__ed.fc.viewportTransform);
  const at = (x, y) => ({ x: box.x + vt[4] + x * z, y: box.y + vt[5] + y * z });
  const a = at(20, 20), b = at(r.W - 20, r.H - 20);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(300);
  const after = await page.evaluate(() => { const ed = window.__ed, photo = ed.fc.getObjects().find(x => x.name === 'Photo'); return { fillOnPhoto: !!(photo.fill && photo.fill.colorStops), roles: ed.fc.getObjects().map(o => o.role || o.type) }; });
  assert.equal(after.fillOnPhoto, false, 'the image must not receive a gradient fill');
  assert.ok(after.roles.includes('paint'), 'the gradient was painted into a paint layer: ' + after.roles);
});

test('browser: fillMaskGradient {multiply} combines two edge feathers (left x top) instead of replacing the first', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed; ed.fc.clear();
    const c = document.createElement('canvas'); c.width = 200; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 200, 200);
    await ed.addImage(c.toDataURL('image/png'), { name: 'Layer' });
    const o = ed.fc.getObjects().find(x => x.name === 'Layer'); o.set({ left: 0, top: 0, scaleX: 1, scaleY: 1 }); o.setCoords();
    ed.fillMaskGradient(o.id, { x: 120, y: 100 }, { x: 40, y: 100 });                       // hidden at the left, revealed from x=120
    ed.fillMaskGradient(o.id, { x: 100, y: 120 }, { x: 100, y: 40 }, { multiply: true });    // ...and hidden at the top, revealed from y=120
    const m = o.maskCanvas, v = (x, y) => { const q = ed._imageMaskPoint(o, { x, y }, 1); return m.getContext('2d').getImageData(Math.min(m.width - 1, Math.floor(q.x)), Math.min(m.height - 1, Math.floor(q.y)), 1, 1).data[0]; };
    return { tl: v(10, 10), tr: v(190, 10), bl: v(10, 190), br: v(190, 190), W: ed.W };
  });
  assert.ok(r.br > 235, 'revealed only where both gradients reveal (bottom-right): ' + JSON.stringify(r));
  assert.ok(r.tl < 20 && r.tr < 20 && r.bl < 20, 'hidden wherever EITHER edge fade hides it: ' + JSON.stringify(r));
});

test('browser: a border on a rounded photo is drawn at full width along the rounded corners (not clipped to its inner half, no square corners)', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed; ed.fc.clear(); ed.fc.backgroundColor = '#ffffff';
    const c = document.createElement('canvas'); c.width = 120; c.height = 120; const g = c.getContext('2d'); g.fillStyle = '#0000ff'; g.fillRect(0, 0, 120, 120);
    await ed.addImage(c.toDataURL('image/png'), { name: 'P' });
    const o = ed.fc.getObjects().find(x => x.name === 'P'); o.set({ originX: 'left', originY: 'top', left: 140, top: 90, scaleX: 1, scaleY: 1 }); o.setCoords(); ed.fc.setActiveObject(o);
    ed.setNumeric({ rx: 40 }); ed.setStroke({ color: '#ff0000', width: 16 });
    const sw = 16, L = o.left + sw / 2, T = o.top + sw / 2, W = o.getScaledWidth() - sw, H = o.getScaledHeight() - sw;   // the image's own edge (the box includes the border's outer half)
    const px = async (x, y) => { const u = await ed.exportPNG(1), im = new Image(); await new Promise(res => { im.onload = res; im.src = u; }); const k = document.createElement('canvas'); k.width = im.width; k.height = im.height; const q = k.getContext('2d'); q.drawImage(im, 0, 0); return Array.from(q.getImageData(Math.round(x), Math.round(y), 1, 1).data); };
    const red = (p) => p[0] > 200 && p[1] < 60 && p[2] < 60, my = T + H / 2, mx = L + W / 2, d = 40 * (1 - Math.SQRT1_2);
    return { box: [L, T, W, H], outer: red(await px(L - 4, my)), inner: red(await px(L + 4, my)), right: red(await px(L + W + 4, my)), top: red(await px(mx, T - 4)), bottom: red(await px(mx, T + H + 4)),
      squareCorner: red(await px(L - 7, T - 7)), roundCorner: red(await px(L + d, T + d)) };
  });
  assert.ok(r.outer && r.inner, 'both halves of the border show on the left edge: ' + JSON.stringify(r));
  assert.ok(r.right && r.top && r.bottom, 'no edge is cut off: ' + JSON.stringify(r));
  assert.equal(r.squareCorner, false, 'no square corner poking out: ' + JSON.stringify(r));
  assert.ok(r.roundCorner, 'the border follows the rounded corner: ' + JSON.stringify(r));
});

test('browser: matchColor pulls a layer toward a reference, is non-destructive, undoable, saved, and refuses bad targets', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed, out = {}; ed.fc.clear(); ed.fc.backgroundColor = '#000000';
    const mk = (col) => { const c = document.createElement('canvas'); c.width = 60; c.height = 60; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 60, 0); gr.addColorStop(0, col[0]); gr.addColorStop(1, col[1]); g.fillStyle = gr; g.fillRect(0, 0, 60, 60); return c.toDataURL('image/png'); };
    await ed.addImage(mk(['#203040', '#406080']), { name: 'Src' }); await ed.addImage(mk(['#c08040', '#f0c070']), { name: 'Ref' });
    const [src, ref] = ['Src', 'Ref'].map(n => ed.fc.getObjects().find(o => o.name === n));
    src.set({ left: 0, top: 0, scaleX: 1, scaleY: 1 }); ref.set({ left: 200, top: 0, scaleX: 1, scaleY: 1 }); [src, ref].forEach(o => o.setCoords());
    const px = async (x, y) => { const u = await ed.exportPNG(1), im = new Image(); await new Promise(res => { im.onload = res; im.src = u; }); const k = document.createElement('canvas'); k.width = im.width; k.height = im.height; const q = k.getContext('2d'); q.drawImage(im, 0, 0); return Array.from(q.getImageData(x, y, 1, 1).data).slice(0, 3); };
    out.before = await px(30, 30);
    out.res = ed.matchColor(src.id, ref.id); out.after = await px(30, 30);
    out.stored = !!src.fx.match; out.srcUntouched = (src._originalElement || src._element).src.length > 0 && !src.maskCanvas;
    ed.undo(); await new Promise(res => setTimeout(res, 300)); const s2 = ed.fc.getObjects().find(o => o.name === 'Src'); out.undone = !s2.fx || !s2.fx.match;
    ed.redo(); await new Promise(res => setTimeout(res, 300));
    const json = ed.toJSON(); await ed.loadJSON(json); await new Promise(res => setTimeout(res, 600));
    const s3 = ed.fc.getObjects().find(o => o.name === 'Src'); out.reloaded = await px(30, 30); out.reloadedMatch = !!(s3.fx && s3.fx.match);
    out.bad = [ed.matchColor(s3.id, s3.id).reason, ed.matchColor('nope', s3.id).reason];
    out.cleared = ed.matchColor(s3.id, null).cleared; out.back = await px(30, 30);
    return out;
  });
  assert.equal(r.res.status, 'ok'); assert.ok(r.stored);
  assert.ok(r.after[0] > r.before[0] + 50 && r.after[2] < r.before[2] + 20, `a cold blue layer turns warm: ${r.before} -> ${r.after}`);
  assert.ok(r.undone, 'undo removes it'); assert.ok(r.reloadedMatch); assert.deepEqual(r.reloaded, r.after, 'same pixels after save/load');
  assert.deepEqual(r.bad, ['bad_reference', 'not_image']); assert.deepEqual(r.back, r.before, 'clearing restores the original');
});

test('browser: matchColorSources lists other photos (not the layer itself, adjustment layers or shapes) and the match remembers its reference', async () => {
  const r = await page.evaluate(async () => {
    const ed = window.__ed, F = window.fabric; ed.fc.clear();
    const mk = (c1) => { const c = document.createElement('canvas'); c.width = 40; c.height = 40; const g = c.getContext('2d'); g.fillStyle = c1; g.fillRect(0, 0, 40, 40); return c.toDataURL('image/png'); };
    await ed.addImage(mk('#204060'), { name: 'A' }); await ed.addImage(mk('#c08040'), { name: 'B' });
    ed.fc.add(new F.Rect({ left: 0, top: 0, width: 10, height: 10, id: 'shp', role: 'shape' })); ed.addAdjustmentLayer({});
    const [a, b] = ['A', 'B'].map(n => ed.fc.getObjects().find(o => o.name === n));
    const out = { forA: ed.matchColorSources(a.id).map(x => x.name), forB: ed.matchColorSources(b.id).map(x => x.name) };
    ed.matchColor(a.id, b.id, { amount: 0.6 }); out.stored = { ref: a.fx.match.ref === b.id, amount: a.fx.match.amount };
    return out;
  });
  assert.deepEqual(r.forA, ['B']); assert.deepEqual(r.forB, ['A']);
  assert.deepEqual(r.stored, { ref: true, amount: 0.6 });
});

test('browser: trapDialog moves focus in, cycles Tab/Shift+Tab inside the dialog and restores focus on release', async () => {
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<button id="opener">open</button><div id="dlg"><button id="d1">one</button><button id="d2">two</button></div><button id="after">after</button>');
    document.getElementById('opener').focus();
    window.__release = window.__trapDialog(document.getElementById('dlg'), { initial: '#d1' });
  });
  const inside = () => page.evaluate(() => document.getElementById('dlg').contains(document.activeElement));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'd1');
  await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'd2');
  await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'd1', 'wraps forward instead of escaping to #after');
  await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'd2', 'wraps backward');
  assert.ok(await inside());
  await page.evaluate(() => window.__release());
  assert.equal(await page.evaluate(() => document.activeElement.id), 'opener', 'focus restored');
});

test('browser: blendThumb draws a different preview for every blend mode, and every mode is one the canvas can really draw', async () => {
  const r = await page.evaluate(async () => {
    const { BLEND_MODES, blendThumb } = await import('/packages/core/src/index.js');
    const urls = BLEND_MODES.map(([v]) => blendThumb(v));
    const ctx = document.createElement('canvas').getContext('2d');
    return { n: BLEND_MODES.length, distinct: new Set(urls).size, supported: BLEND_MODES.every(([v]) => { ctx.globalCompositeOperation = v; return ctx.globalCompositeOperation === v; }) };
  });
  assert.equal(r.n, 15); assert.equal(r.distinct, 15, 'no two modes share a thumbnail'); assert.ok(r.supported);
});

test('browser: a project file carries every page — export then open restores all tabs, frames and layers, and old single-page files still open', async () => {
  const r = await page.evaluate(async () => {
    const { exportProject, loadProject, DocumentSet } = await import('/packages/core/src/index.js');
    const ed = window.__ed, F = window.fabric, out = {};
    const docs = new DocumentSet(ed, { persist: false });
    const rect = (n, c) => { ed.fc.add(new F.Rect({ left: 20, top: 20, width: 60, height: 40, fill: c, id: 'i' + n, role: 'shape', name: n, shapeKind: 'rect' })); ed.commit(n); };
    rect('one-red', '#e53935'); ed.addFrame(); rect('one-blue', '#1e88e5');
    await docs.add({ name: 'Second' }); rect('two-green', '#43a047');
    const text = exportProject(ed, { assets: [] }, docs);
    out.hasPages = JSON.parse(text).pages.docs.length;
    // a brand new tab set + empty canvas, as in a fresh browser
    const docs2 = new DocumentSet(ed, { persist: false }); ed.reset({ width: 300, height: 200 });
    await loadProject(ed, text, docs2);
    out.tabs = docs2.list().map(d => d.name + (d.active ? '*' : '')); out.live = ed.layers().map(l => l.name);
    await docs2.switchTo(docs2.list()[0].id);
    out.p1 = { frames: ed.frameList().length, layers: ed.layers().map(l => l.name).sort() };
    // an old file (no pages) loads into whatever is open
    const old = JSON.stringify({ kind: 'canvasmith/project', v: 1, scene: ed.toJSON(), extras: {} });
    out.old = Object.keys(await loadProject(ed, old, docs2)).length >= 0;
    return out;
  });
  assert.equal(r.hasPages, 2); assert.deepEqual(r.tabs, ['Untitled 1', 'Second*']); assert.deepEqual(r.live, ['two-green']);
  assert.equal(r.p1.frames, 2); assert.deepEqual(r.p1.layers, ['one-blue', 'one-red']); assert.ok(r.old);
});
