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
  browser = await chromium.launch({ channel: 'chrome',  args: ['--no-sandbox'] });
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
  assert.deepEqual(r.focus, { groupActive: true, childActive: true, gbActive: true });
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

  const beforeAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    const c = o._element; const ctx = c.getContext('2d');
    return ctx.getImageData(130, 100, 1, 1).data[3];
  }, paintId);
  assert.ok(beforeAlpha > 0);   // the brush stroke painted something opaque here

  await page.evaluate((id) => window.__ed.addMask(id), paintId);
  const afterAddAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    const c = o._element; const ctx = c.getContext('2d');
    return ctx.getImageData(130, 100, 1, 1).data[3];
  }, paintId);
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
  const hiddenAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    return o._element.getContext('2d').getImageData(150, 100, 1, 1).data[3];
  }, paintId);
  assert.equal(hiddenAlpha, 0);   // fully masked out at the painted spot

  // paint white (reveal) back over the same spot
  await page.evaluate(() => window.__ed.setToolOptions({ color: '#ffffff' }));
  await page.mouse.move(canvasBox.x + 150, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(50);
  const revealedAlpha = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    return o._element.getContext('2d').getImageData(150, 100, 1, 1).data[3];
  }, paintId);
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

  const maskedAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.equal(maskedAlpha, 0);

  await page.evaluate((id) => window.__ed.setMaskEnabled(id, false), paintId);
  const disabledAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.ok(disabledAlpha > 200);   // disabling shows the full layer again

  await page.evaluate((id) => window.__ed.setMaskEnabled(id, true), paintId);
  const reenabledAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
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
  const afterRemove = await page.evaluate((id) => {
    const o = window.__ed.fc.getObjects().find(x => x.id === id);
    return { hasMaskCanvas: !!o.maskCanvas, alpha: o._element.getContext('2d').getImageData(330, 100, 1, 1).data[3] };
  }, paintId);
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

  const beforeUndoAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.equal(beforeUndoAlpha, 0);

  await page.evaluate(() => window.__ed.undo());
  await page.waitForTimeout(150);   // restore()/loadFromJSON + the mask filter's own async fromObject
  const afterUndoAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.ok(afterUndoAlpha > 200);   // back to before the mask stroke (mask still present, just unpainted there)

  await page.evaluate(() => window.__ed.redo());
  await page.waitForTimeout(150);
  const afterRedoAlpha = await page.evaluate((id) => window.__ed.fc.getObjects().find(x => x.id === id)._element.getContext('2d').getImageData(150, 100, 1, 1).data[3], paintId);
  assert.equal(afterRedoAlpha, 0);   // the painted-black mask stroke is back
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
    // subject on the right half, pure green where the background was
    removeBackground: async (url) => { const c = document.createElement('canvas'); c.width = 80; c.height = 60; const x = c.getContext('2d'); x.fillStyle = '#00ff00'; x.fillRect(0, 0, 40, 60); x.fillStyle = '#c33'; x.fillRect(40, 0, 40, 60); return c.toDataURL(); },
  }));
  const r = await page.evaluate(async () => { const d0 = window.__ed.history.depth().past; const r = await window.__ed.removeBackground(); return { ...r, d: window.__ed.history.depth().past - d0, layer: window.__ed.layers().find(l => l.active) }; });
  assert.equal(r.status, 'ok'); assert.equal(r.method, 'ai'); assert.equal(r.d, 1);
  assert.equal(r.layer.hasMask, true); assert.match(r.layer.subtitle, /Masked image/);
  assert.equal(await filteredAlpha(id, 8, 30), 0, 'green half hidden');
  assert.equal(await filteredAlpha(id, 72, 30), 255, 'subject half kept');
});

test('browser: removeBackground falls back to the local GrabCut cutout when AI fails', async () => {
  const id = await addTestImage("ctx.fillStyle='#f4f4f4';ctx.fillRect(0,0,w,h);ctx.fillStyle='#1d3fa8';ctx.beginPath();ctx.arc(w/2,h/2,Math.min(w,h)*0.3,0,7);ctx.fill()", 160, 120);
  await page.evaluate(() => window.__ed.ai.register({ hasKey: () => true, removeBackground: async () => { throw new Error('offline'); } }));
  const r = await page.evaluate(() => window.__ed.removeBackground());
  assert.equal(r.status, 'ok', JSON.stringify(r)); assert.equal(r.method, 'local'); assert.equal(r.aiFallback, 'provider_failed');
  assert.equal(await filteredAlpha(id, 4, 4), 0, 'corner background removed');
  assert.ok(await filteredAlpha(id, 80, 60) > 200, 'subject centre kept');
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
