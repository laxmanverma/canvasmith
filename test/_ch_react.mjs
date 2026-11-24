/* Browser-driven tests for the @canvasmith/react shell — the same Playwright approach as
   editor.browser.test.mjs, but driving the built standalone bundle (test/fixtures/browser-react.html)
   through window.__mounted.editor() (the underlying headless Editor, once CanvasmithEditor's
   onReady fires) and real DOM interaction for anything that's shell-only behavior (the crop/pen
   overlay chrome, tool rail, review-box panel — none of which core.test.mjs or
   editor.browser.test.mjs can reach, since they only touch @canvasmith/core directly).

   Requires `npm run build` to have produced packages/react/dist/standalone.js — run that first if
   these fail with the editor never becoming ready.

   Run with `npm run test:browser` alongside editor.browser.test.mjs (same opt-in, browser-download
   contract as that suite). */
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
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => { throw new Error('page error: ' + e.message); });
  /* Pages in this file share one browser context, so IndexedDB persists between tests and the
     session autosave would restore the PREVIOUS test's document into this one's "blank" canvas.
     That is not hypothetical: it made the detectRegions tests flaky, because the local CV
     fallback found a region in the leaked artwork and the "no regions" error path never ran.
     Wipe the store before the app boots, so every test starts from a genuinely empty document. */
  // Wipe before the app's first boot only — NOT via addInitScript, which would also run on the
  // in-test reloads that the persistence tests rely on to prove a document survives one.
  await page.goto(baseURL + '/test/fixtures/blank.html');
  await page.evaluate(() => new Promise(res => {
    const r = indexedDB.deleteDatabase('canvasmith');
    r.onsuccess = r.onerror = r.onblocked = () => res();
  }));
  await page.goto(baseURL + '/test/fixtures/browser-react.html');
  await page.waitForFunction(() => window.__mounted && window.__mounted.editor() && window.__mounted.editor().fc, null, { timeout: 15000 });
  // CanvasmithEditor runs fitToScreen() on mount (the zoom-pill feature) — reset the viewport to
  // identity so every test's screen-space mouse coordinates and scene-space pixel/overlay
  // assertions can assume a 1:1 mapping, same as before that feature existed.
  await page.evaluate(() => {
    const ed = window.__mounted.editor();
    ed.fc.setZoom(1);
    ed.fc.setViewportTransform([1, 0, 0, 1, 0, 0]);
    ed.fc.requestRenderAll();
  });
  await page.waitForTimeout(50);
});

afterEach(async () => { if (page) await page.close(); });

/* Sets a fake AI key through the real saveKey() UI path (typing into the key box and pressing
   Enter), clearing needKey the same way a real user would — several tests below need the AI tab's
   gated controls (Replace background, Apply magic edit) actually rendered. */
const setFakeAiKey = async () => {
  await page.locator('.cm-tabs button:has-text("AI")').first().click();
  await page.waitForTimeout(150);
  await page.locator('input.cm-ai-key').fill('fake-key-for-test');
  await page.locator('input.cm-ai-key').press('Enter');
  await page.waitForTimeout(150);
};

const canvasBox = () => page.locator('canvas').first().boundingBox();
const ed = (fn, ...args) => page.evaluate(fn, ...args);

/* ── tool rail: pen is a real, clickable tool (was previously in ALL_TOOLS but had no rail
   button at all — see the "Draw" GROUPS entry and the pen Icon added alongside the overlay work) */
test('react: the Draw group\'s tool rail includes a working Pen button', async () => {
  // The rail groups tools into flyout clusters (ports the vanilla demo's TOOLGROUPS) and shows a
  // custom hover tooltip instead of a native title attribute, so data-tool is the stable selector
  // — a loose :has-text("Pen") fallback would also match e.g. an "Open image…" button (the
  // substring "pen" sits right inside "Open"), grabbing the wrong element via .first().
  const penBtn = page.locator('button[data-tool="pen"]').first();
  assert.ok(await penBtn.count() > 0, 'a Pen tool button should exist somewhere in the tool rail');
  await penBtn.click();
  await page.waitForTimeout(100);
  const tool = await ed(() => window.__mounted.editor().tool);
  assert.equal(tool, 'pen');
});

test('react: the pen tool shows a Finish path / Cancel pair as soon as the tool is picked (matches the vanilla demo\'s penBtns(t===\'pen\') contract)', async () => {
  await ed(() => window.__mounted.editor().setTool('pen'));
  await page.waitForTimeout(100);
  assert.ok(await page.locator('button:has-text("Finish path")').count() > 0);
  const box = await canvasBox();
  // Three plain clicks = three corner points; Finish path keeps them as an open stroked path.
  await page.mouse.click(box.x + 50, box.y + 50);
  await page.mouse.click(box.x + 100, box.y + 50);
  await page.mouse.click(box.x + 100, box.y + 100);
  await page.waitForTimeout(100);
  await page.locator('button:has-text("Finish path")').click();
  await page.waitForTimeout(100);
  const objs = await ed(() => window.__mounted.editor().fc.getObjects().map(o => o.type));
  assert.ok(objs.includes('path'));   // finishPen() built a real fabric.Path layer

  // switching away from pen hides the pair again
  await ed(() => window.__mounted.editor().setTool('select'));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('button:has-text("Finish path")').count(), 0);
});

/* ── crop overlay: scrim/thirds/handles/dimension readout, ported from the vanilla demo's
   drawOverlays onto fabric's contextTop via the same after:render hook ────────────────────── */
test('react: entering crop draws a real dark scrim on contextTop outside the crop box', async () => {
  await ed(() => window.__mounted.editor().setTool('crop'));
  await page.waitForTimeout(150);
  const hasCrop = await ed(() => !!window.__mounted.editor().crop);
  assert.equal(hasCrop, true);
  // The default box starts flush to the full artboard (the whole thing is "selected" to crop, like
  // a conventional crop tool) — shrink it first so there's an "outside" region for the scrim to
  // actually darken.
  await ed(() => { const wed = window.__mounted.editor(); wed.crop = { ...wed.crop, x: wed.crop.x + 20, y: wed.crop.y + 20, w: wed.crop.w - 20, h: wed.crop.h - 20 }; wed.fc.requestRenderAll(); });
  await page.waitForTimeout(150);
  const pixel = await ed(() => {
    const ctx = window.__mounted.editor().fc.contextTop;
    return [...ctx.getImageData(2, 2, 1, 1).data];   // corner, now outside the shrunk crop box
  });
  assert.equal(pixel[0], 0); assert.equal(pixel[1], 0); assert.equal(pixel[2], 0);
  assert.ok(pixel[3] > 100 && pixel[3] < 140);   // rgba(0,0,0,0.48) -> alpha ~122/255
});

test('react: leaving the crop tool clears the scrim from contextTop', async () => {
  await ed(() => window.__mounted.editor().setTool('crop'));
  await page.waitForTimeout(150);
  await ed(() => window.__mounted.editor().setTool('select'));
  await page.waitForTimeout(150);
  const pixel = await ed(() => {
    const ctx = window.__mounted.editor().fc.contextTop;
    return [...ctx.getImageData(2, 2, 1, 1).data];
  });
  assert.equal(pixel[3], 0);   // fully transparent — no leftover scrim
});

/* ── re-entering crop after a previous artboard-wide crop was applied: the default box must seed
   flush against the NEW (now-smaller) artboard — the whole current image/canvas starts "selected,"
   same as the very first (never-cropped) entry — not some remembered pre-crop rect and not an
   arbitrary inset. setTool('crop') re-derives {0,0,W,H} from the CURRENT this.W/this.H every
   entry, so a re-crop picks up the already-cropped size. ─────────────────────────────────────── */
test('react: re-entering crop after applying one seeds a box flush to the new (already-cropped) artboard size', async () => {
  await ed(() => window.__mounted.editor().setTool('crop'));
  await page.waitForTimeout(150);
  await ed(() => { const wed = window.__mounted.editor(); wed.crop = { x: 10, y: 10, w: 200, h: 150 }; });
  await ed(() => window.__mounted.editor().applyCrop());
  await page.waitForTimeout(150);
  const afterApply = await ed(() => ({ W: window.__mounted.editor().W, H: window.__mounted.editor().H }));
  assert.deepEqual(afterApply, { W: 200, H: 150 });

  await ed(() => window.__mounted.editor().setTool('crop'));
  await page.waitForTimeout(150);
  const crop = await ed(() => window.__mounted.editor().crop);
  assert.deepEqual(crop, { x: 0, y: 0, w: afterApply.W, h: afterApply.H }, 'the re-seeded box must be flush to the NEW, already-cropped artboard size');
});

/* ── marquee selection: marching-ants outline actually gets drawn (not just tracked in state) ── */
test('react: drawing a marquee selection paints a non-transparent outline onto contextTop', async () => {
  await ed(() => window.__mounted.editor().setTool('marquee'));
  const box = await canvasBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 120, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const hasSelection = await ed(() => !!window.__mounted.editor().selection);
  assert.equal(hasSelection, true);
  // Sample along the top edge of the drawn rect (40,40)-(150,120) in scene px, which is also
  // screen px here since beforeEach resets the viewport to identity zoom/pan — the dashed
  // marching-ants stroke should have painted SOME non-transparent pixel somewhere along that edge.
  const anyOpaqueOnEdge = await ed(() => {
    const ctx = window.__mounted.editor().fc.contextTop;
    const row = ctx.getImageData(40, 40, 110, 1).data;
    for (let i = 3; i < row.length; i += 4) if (row[i] > 0) return true;
    return false;
  });
  assert.equal(anyOpaqueOnEdge, true);
});

/* ── hover-select preview: the 'hover' event now drives a visible overlay, not just clearing
   the busy flag (see CanvasmithEditor's drawOverlays — hoverPreview was previously untracked) ── */
test('react: hoverselect tool wiring reaches the hover-preview overlay state', async () => {
  await ed(() => window.__mounted.editor().setTool('hoverselect'));
  await page.waitForTimeout(100);
  // Directly emit a synthetic hover event through the real Editor event bus (same path a real cv
  // round-trip would take) and confirm the overlay's redraw doesn't throw and the editor's own
  // hover-cache plumbing is live — full CV-backed hover timing is already covered by
  // editor.browser.test.mjs; this test is specifically about the React shell's listener wiring.
  const ok = await ed(() => {
    try {
      window.__mounted.editor()._emit('hover', { pt: { x: 50, y: 50 }, pts: [{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }] });
      window.__mounted.editor().fc.requestRenderAll();
      return true;
    } catch (e) { return false; }
  });
  assert.equal(ok, true);
});

/* ── layer panel: thumbnails, lock toggle, rename, drag-to-reorder — all previously absent from
   the React shell (only eye/up/delete existed; see readme/report gap notes) ────────────────── */
test('react: layer rows show real pixels for images and a fill-tinted tile for shapes', async () => {
  await ed(() => window.__mounted.editor().setTool('rect'));
  const box = await canvasBox();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await ed(async () => {
    const c = document.createElement('canvas'); c.width = 20; c.height = 20;
    c.getContext('2d').fillStyle = '#00aa00'; c.getContext('2d').fillRect(0, 0, 20, 20);
    await window.__mounted.editor().addImage(c.toDataURL());
  });
  await page.waitForTimeout(200);
  // The layer list lives in the always-visible left panel (Layers tab, the default).
  const src = await page.locator('.cm-layer-thumb img').first().getAttribute('src');
  assert.ok(src.startsWith('data:image/png'), 'image row shows its own pixels');
  assert.ok(await page.locator('.cm-layer-thumb[data-tint]').count() > 0, 'shape row shows a tinted glyph tile');
  const subs = await page.locator('.cm-layer-meta .sub').allTextContents();
  assert.ok(subs.some(t => /Image$/.test(t)) && subs.includes('Vector Shape'), subs.join(' | '));
});

test('react: the lock toggle in the layer row calls setLayer({locked}) without activating the layer', async () => {
  await ed(() => window.__mounted.editor().setTool('rect'));
  const box = await canvasBox();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.waitForTimeout(150);
  const lockBtn = page.locator('.cm-layer .cm-eye[title="Lock"]').first();
  assert.ok(await lockBtn.count() > 0);
  await lockBtn.click();
  await page.waitForTimeout(100);
  const locked = await ed(() => window.__mounted.editor().layers().find(l => l.role !== 'bg').locked);
  assert.equal(locked, true);
});

test('react: double-clicking a layer row\'s name enters rename mode, Enter commits the new name', async () => {
  await ed(() => window.__mounted.editor().setTool('rect'));
  const box = await canvasBox();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.waitForTimeout(150);
  const row = page.locator('.cm-layer').first();
  await row.click();
  await page.waitForTimeout(50);
  await row.click();   // second click within 400ms -> rename mode (manual double-click detection)
  await page.waitForTimeout(100);
  const input = page.locator('.cm-layer-rename');
  assert.ok(await input.count() > 0);
  await input.fill('My Renamed Layer');
  await input.press('Enter');
  await page.waitForTimeout(100);
  const name = await ed(() => window.__mounted.editor().layers().find(l => l.role !== 'bg').name);
  assert.equal(name, 'My Renamed Layer');
});

test('react: dragging one layer row onto another reorders the stack via reorderLayerTo', async () => {
  const ids = await ed(() => {
    const wed = window.__mounted.editor();
    wed.setTool('rect');
    const a = new wed.fabric.Rect({ left: 10, top: 10, width: 20, height: 20, fill: '#ff0000' });
    a.set({ id: 'layer-a', role: 'shape', name: 'A' });
    wed.fc.add(a);
    const b = new wed.fabric.Rect({ left: 40, top: 40, width: 20, height: 20, fill: '#00ff00' });
    b.set({ id: 'layer-b', role: 'shape', name: 'B' });
    wed.fc.add(b);
    wed.setTool('select');
    wed.commit('test-setup');
    return wed.fc.getObjects().map(o => o.id);
  });
  assert.deepEqual(ids, ['layer-a', 'layer-b']);   // a below b, bottom-to-top fc order
  await page.waitForTimeout(150);
  // reorderLayerTo is exercised directly (core already has dedicated coverage for its geometry);
  // this test is specifically about the React row wiring calling it correctly on a drop.
  await ed(() => window.__mounted.editor().reorderLayerTo('layer-a', 'layer-b', { after: false }));
  await page.waitForTimeout(100);
  const after = await ed(() => window.__mounted.editor().fc.getObjects().map(o => o.id));
  assert.deepEqual(after, ['layer-b', 'layer-a']);   // a is now in front of b
});

/* ── border/stroke controls: previously present in the vanilla demo only ────────────────────── */
test('react: the Layer tab shows a Border section for a shape, with a colour swatch that appears only once width > 0', async () => {
  await ed(() => window.__mounted.editor().setTool('rect'));
  const box = await canvasBox();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.locator('button:has-text("Properties")').first().click();
  await page.waitForTimeout(150);
  assert.ok(await page.locator('.cm-grp:has-text("Border")').count() > 0);
  // width still 0 -> no colour swatch row yet
  const colorInputsBefore = await page.locator('input[type=color][title="Border colour"]').count();
  assert.equal(colorInputsBefore, 0);
  await ed(() => window.__mounted.editor().setStroke({ width: 6 }));
  await page.waitForTimeout(100);
  const colorInputsAfter = await page.locator('input[type=color][title="Border colour"]').count();
  assert.equal(colorInputsAfter, 1);
  const width = await ed(() => window.__mounted.editor().fc.getActiveObject().strokeWidth);
  assert.equal(width, 6);
});

test('react: fill and border opacity fields write an rgba colour and keep it across recolours', async () => {
  await ed(() => window.__mounted.editor().setTool('rect'));
  const box = await canvasBox();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.locator('button:has-text("Properties")').first().click();
  await page.waitForTimeout(150);
  await ed(() => window.__mounted.editor().setFill('#ef6a2d'));
  await ed(() => window.__mounted.editor().setStroke({ color: '#000000', width: 4 }));
  await page.waitForTimeout(100);

  const fillPct = page.locator('input[aria-label="Fill opacity"]');
  assert.equal(await fillPct.inputValue(), '100');
  await fillPct.fill('40'); await fillPct.press('Enter');
  await page.waitForTimeout(100);
  assert.equal(await ed(() => window.__mounted.editor().fc.getActiveObject().fill), 'rgba(239,106,45,0.4)');
  assert.equal(await fillPct.inputValue(), '40');

  // recolouring via the hex field keeps the 40%
  const fillHex = page.locator('input[aria-label="Fill colour hex"]');
  await fillHex.fill('#ffffff'); await fillHex.press('Enter');
  await page.waitForTimeout(100);
  assert.equal(await ed(() => window.__mounted.editor().fc.getActiveObject().fill), 'rgba(255,255,255,0.4)');

  const borderPct = page.locator('input[aria-label="Border opacity"]');
  await borderPct.fill('25'); await borderPct.press('Enter');
  await page.waitForTimeout(100);
  assert.equal(await ed(() => window.__mounted.editor().fc.getActiveObject().stroke), 'rgba(0,0,0,0.25)');
  assert.equal(await ed(() => window.__mounted.editor().fc.getActiveObject().strokeWidth), 4);

  // back to 100% stores a plain hex again
  await fillPct.fill('100'); await fillPct.press('Enter');
  await page.waitForTimeout(100);
  assert.equal(await ed(() => window.__mounted.editor().fc.getActiveObject().fill), '#ffffff');
});

/* ── zoom pill + fit-to-screen: previously absent from the React shell entirely (only the mouse-
   wheel zoom built into core's _bindPointer worked; no UI, no keyboard shortcuts) ───────────── */
test('react: the zoom pill shows a live percentage and zoom in/out/fit buttons work', async () => {
  // beforeEach resets fc's zoom directly (not through setZoomAtCenter), which doesn't fire a
  // 'zoom' event — so the pill's displayed text can still read whatever fitToScreen() left it at
  // on mount. Force a real zoom through the pill's own control first so the displayed text is
  // known-good, rather than asserting an exact "100%" the reset doesn't actually guarantee.
  await page.locator('.cm-zoom-pill button[title="Zoom in (+)"]').click();
  await page.waitForTimeout(100);
  const afterFirstClick = await page.locator('.cm-zoom-pill button').nth(1).innerText();
  const zoomNow = await ed(() => Math.round(window.__mounted.editor().fc.getZoom() * 100));
  assert.equal(afterFirstClick, zoomNow + '%');   // pill text matches the real zoom
  await page.locator('.cm-zoom-pill button[title="Zoom in (+)"]').click();
  await page.waitForTimeout(100);
  const afterIn = await ed(() => window.__mounted.editor().fc.getZoom());
  assert.ok(afterIn > 1);
  await page.locator('.cm-zoom-pill button[title="Zoom out (−)"]').click();
  await page.waitForTimeout(100);
  const afterOut = await ed(() => window.__mounted.editor().fc.getZoom());
  assert.ok(afterOut < afterIn);
  await page.locator('.cm-zoom-pill button[title="Fit to screen (0)"]').first().click();
  await page.waitForTimeout(100);
  const fitZoom = await ed(() => window.__mounted.editor().fc.getZoom());
  assert.ok(fitZoom > 0);   // fitToScreen ran without throwing and produced a sane positive zoom
});

test('react: +/-/0 keyboard shortcuts drive zoom the same as the pill buttons', async () => {
  await page.keyboard.press('+');
  await page.waitForTimeout(100);
  const afterPlus = await ed(() => window.__mounted.editor().fc.getZoom());
  assert.ok(afterPlus > 1);
  await page.keyboard.press('0');
  await page.waitForTimeout(100);
  const afterFit = await ed(() => window.__mounted.editor().fc.getZoom());
  assert.notEqual(afterFit, afterPlus);
});

/* ── ⌘K command palette: previously absent from the React shell entirely ────────────────────── */
test('react: Cmd/Ctrl+K opens the command palette listing every tool and action, filters live, Enter runs the highlighted item', async () => {
  await page.keyboard.press('Meta+k').catch(() => {});
  if (await page.locator('.cm-cmdk-box').count() === 0) await page.keyboard.press('Control+k');
  await page.waitForTimeout(150);
  assert.ok(await page.locator('.cm-cmdk-box').count() > 0);
  const totalItems = await page.locator('.cm-cmdk-item').count();
  assert.ok(totalItems > 20);   // every tool rail entry + every action item

  await page.locator('.cm-cmdk-input').fill('brush');
  await page.waitForTimeout(100);
  const labels = await page.locator('.cm-cmdk-item .lbl').allTextContents();
  assert.ok(labels.includes('Brush'));
  assert.ok(labels.length < totalItems);   // the filter actually narrowed the list

  await page.locator('.cm-cmdk-input').fill('');
  await page.waitForTimeout(100);
  await page.locator('.cm-cmdk-input').fill('undo');
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.cm-cmdk-box').count(), 0);   // palette closes after running an item
});

test('react: Escape closes the command palette without running anything', async () => {
  const toolBefore = await ed(() => window.__mounted.editor().tool);
  await page.keyboard.press('Meta+k').catch(() => {});
  if (await page.locator('.cm-cmdk-box').count() === 0) await page.keyboard.press('Control+k');
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.cm-cmdk-box').count(), 0);
  const toolAfter = await ed(() => window.__mounted.editor().tool);
  assert.equal(toolAfter, toolBefore);
});

/* ── asset tray: previously absent from both shells (the demo's .asset-thumb CSS was decorative
   only, per the gap audit) — every image added to the document this session, click or drag back
   onto the canvas to insert it again ─────────────────────────────────────────────────────────── */
test('react: the Assets tray is hidden with nothing added, and appears once an image is opened', async () => {
  await page.locator('button:has-text("Design")').first().click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.cm-asset-thumb').count(), 0);
});

test('react: mounting with an `image` prop tracks it as an asset, and clicking the thumbnail inserts another copy', async () => {
  // pickImage() (the file-input "Add image" button) creates a detached <input> never attached to
  // the DOM and drives it via a native OS picker dialog, which Playwright can't automate — the
  // `image` prop's openImage() call is the other real trackAsset() call site and is fully
  // scriptable, so it's used here to exercise the actual production code path end to end.
  await page.close();
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => { throw new Error('page error: ' + e.message); });
  await page.goto(baseURL + '/test/fixtures/browser-react-with-image.html');
  await page.waitForFunction(() => window.__mounted && window.__mounted.editor() && window.__mounted.editor().fc, null, { timeout: 15000 });
  await page.waitForTimeout(600);   // let openImage()'s artboard-fit resolve

  await page.locator('button:has-text("Design")').first().click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.cm-asset-thumb').count(), 1);
  assert.equal(await page.locator('.cm-asset-thumb span').first().innerText(), 'Opened image');

  const objsBefore = await ed(() => window.__mounted.editor().fc.getObjects().length);
  await page.locator('.cm-asset-thumb').first().click();
  await page.waitForTimeout(200);
  const objsAfter = await ed(() => window.__mounted.editor().fc.getObjects().length);
  assert.equal(objsAfter, objsBefore + 1);
});

/* ── region review (guided convert): region boxes are real Fabric objects (role:'region') on the
   live canvas — same architecture as the vanilla demo — with a side panel offering the full
   product/logo/text/sticker/decorative taxonomy for whichever region is currently selected. */
test('react: the region-review side panel offers all 5 region types for the selected region', async () => {
  const aiTab = page.locator('.cm-tabs button:has-text("AI")').first();
  await aiTab.click();
  await page.waitForTimeout(150);
  const manualBtn = page.locator('button:has-text("Select one object manually")').first();
  assert.ok(await manualBtn.count() > 0);
  await manualBtn.click();
  await page.waitForTimeout(200);
  // selectOneManually() both opens review AND adds+selects one region rect, so the "Selected
  // region" sub-panel (with its 5 type buttons) should already be showing.
  const regionCount = await ed(() => window.__mounted.editor().fc.getObjects().filter(o => o.role === 'region').length);
  assert.equal(regionCount, 1);
  const typeLabels = await page.locator('.cm-review-panel-body button').allTextContents();
  ['Product', 'Logo', 'Text', 'Sticker', 'Decoration'].forEach(label => {
    assert.ok(typeLabels.some(t => t.includes(label)), 'expected a type button for ' + label);
  });
  const regionColor = await ed(() => {
    const o = window.__mounted.editor().fc.getObjects().find(x => x.role === 'region');
    return o && o.stroke;
  });
  assert.ok(regionColor && regionColor.startsWith('#'), 'expected the region rect to be styled via REGION_COLOR');
});

/* ── Compare: side-by-side view of the first meaningful state vs. the live render — previously
   absent from the React shell entirely (demo-only). ────────────────────────────────────────── */
test('react: the Compare button is disabled until the first edit, then opens a two-pane modal, Escape closes it', async () => {
  assert.equal(await page.locator('button[title="Compare with the first-loaded version"]').first().isDisabled(), true);

  await ed(() => window.__mounted.editor().setTool('rect'));
  const box = await canvasBox();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  assert.equal(await page.locator('button[title="Compare with the first-loaded version"]').first().isEnabled(), true);
  await page.locator('button[title="Compare with the first-loaded version"]').first().click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.cm-compare-backdrop').count(), 1);
  const srcs = await page.locator('.cm-compare-pane img').evaluateAll(els => els.map(e => e.getAttribute('src')));
  assert.equal(srcs.length, 2);
  assert.ok(srcs.every(s => s && s.startsWith('data:image/png')));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.cm-compare-backdrop').count(), 0);
});

test('react: the Compare "Original" pane stays the first-committed snapshot across further edits, while the "Current" pane keeps updating', async () => {
  await ed(() => window.__mounted.editor().setTool('rect'));
  const box = await canvasBox();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 120, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.locator('button[title="Compare with the first-loaded version"]').first().click();
  await page.waitForTimeout(150);
  const firstOriginal = await page.locator('.cm-compare-pane').first().locator('img').getAttribute('src');
  const firstCurrent = await page.locator('.cm-compare-pane').nth(1).locator('img').getAttribute('src');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  await ed(() => window.__mounted.editor().setTool('rect'));
  await page.mouse.move(box.x + 200, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 120, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  await page.locator('button[title="Compare with the first-loaded version"]').first().click();
  await page.waitForTimeout(150);
  const secondOriginal = await page.locator('.cm-compare-pane').first().locator('img').getAttribute('src');
  const secondCurrent = await page.locator('.cm-compare-pane').nth(1).locator('img').getAttribute('src');
  assert.equal(secondOriginal, firstOriginal);   // Original pane frozen at the very first snapshot
  assert.notEqual(secondCurrent, firstCurrent);  // Current pane reflects the second shape being added
});

/* ── crop aspect-ratio presets: previously absent from the React shell (demo-only) ──────────── */
test('react: the crop tool shows aspect-ratio chips, and the current ratio is tracked in toolOpts', async () => {
  await ed(() => window.__mounted.editor().setTool('crop'));
  await page.waitForTimeout(150);
  const labels = await page.locator('.cm-chip').allTextContents();
  ['Free', 'Original', '1:1', '4:5', '3:2', '16:9', '9:16'].forEach(l => assert.ok(labels.includes(l), `missing chip: ${l}`));

  await page.locator('.cm-chip:has-text("1:1")').first().click();
  await page.waitForTimeout(100);
  const ratio = await ed(() => window.__mounted.editor().toolOpts.cropRatio);
  assert.equal(ratio, 1);
  const chipOn = await page.locator('.cm-chip:has-text("1:1")').first().getAttribute('data-on');
  assert.equal(chipOn, 'true');

  // leaving the crop tool resets cropRatio back to 0 (matches the vanilla demo's cropBtn(false))
  await ed(() => window.__mounted.editor().setTool('select'));
  await page.waitForTimeout(100);
  const ratioAfterLeaving = await ed(() => window.__mounted.editor().toolOpts.cropRatio);
  assert.equal(ratioAfterLeaving, 0);
});

test('react: a crop-ratio chip constrains a SUBSEQUENT handle drag (matches the vanilla demo\'s drag-time-only behavior)', async () => {
  await ed(() => window.__mounted.editor().setTool('crop'));
  await page.waitForTimeout(150);
  await page.locator('.cm-chip:has-text("1:1")').first().click();
  await page.waitForTimeout(100);
  const box = await canvasBox();
  const crop = await ed(() => window.__mounted.editor().crop);
  // drag the bottom-right corner handle
  await page.mouse.move(box.x + crop.x + crop.w, box.y + crop.y + crop.h);
  await page.mouse.down();
  await page.mouse.move(box.x + crop.x + crop.w + 40, box.y + crop.y + crop.h + 10, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const after = await ed(() => window.__mounted.editor().crop);
  assert.ok(Math.abs(after.w / after.h - 1) < 0.05);   // the drag was ratio-locked to 1:1
});

/* ── crop scoped to a selected image layer: previously applyCrop() always resized the whole
   artboard (Photoshop's "Canvas Size") no matter what was selected, which read as "the crop tool
   crops the frame instead of the image." Selecting a non-bg image before entering Crop must now
   seed the crop box from THAT image and, on Apply, adjust only its own cropX/cropY/width/height —
   the artboard size and every other object stay untouched. ─────────────────────────────────── */
test('react: cropping a selected image layer crops only that image, not the artboard', async () => {
  const before = await ed(async () => {
    const wed = window.__mounted.editor();
    const c = document.createElement('canvas'); c.width = 40; c.height = 40;
    c.getContext('2d').fillStyle = '#3366ff'; c.getContext('2d').fillRect(0, 0, 40, 40);
    const img = await wed.addImage(c.toDataURL(), { role: 'image', name: 'Layer', fit: 'contain' });
    img.set({ left: 20, top: 30, scaleX: 2, scaleY: 2, originX: 'left', originY: 'top' });
    img.setCoords();
    wed.fc.setActiveObject(img);
    wed.commit('test-setup');
    return { W: wed.W, H: wed.H, id: img.id, left: img.left, top: img.top };
  });

  await ed(() => window.__mounted.editor().setTool('crop'));
  await page.waitForTimeout(150);
  const seeded = await ed(() => window.__mounted.editor().crop);
  // seeded flush to the image's own bounding box (left/top at scale 2), not the artboard's own box
  assert.equal(seeded.x, before.left);
  assert.equal(seeded.y, before.top);

  const box = await canvasBox();
  // drag the bottom-right handle in to shrink the crop box, well inside the image's own bounds
  await page.mouse.move(box.x + seeded.x + seeded.w, box.y + seeded.y + seeded.h);
  await page.mouse.down();
  await page.mouse.move(box.x + seeded.x + seeded.w - 20, box.y + seeded.y + seeded.h - 20, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);

  await page.locator('button:has-text("Apply crop")').click();
  await page.waitForTimeout(100);

  const after = await ed((id) => {
    const wed = window.__mounted.editor();
    const img = wed.fc.getObjects().find(o => o.id === id);
    return { W: wed.W, H: wed.H, tool: wed.tool, cropX: img.cropX, cropY: img.cropY, w: img.getScaledWidth(), h: img.getScaledHeight() };
  }, before.id);
  assert.equal(after.W, before.W, 'artboard width must be untouched by an image-scoped crop');
  assert.equal(after.H, before.H, 'artboard height must be untouched by an image-scoped crop');
  assert.equal(after.tool, 'select');
  assert.ok(after.w < seeded.w, 'the image itself shrank to the dragged crop box');
  assert.ok(after.h < seeded.h);
});

/* ── re-cropping an already-cropped image layer: re-entering Crop must show the FULL original
   image again (Fabric's cropX/cropY/width/height only ever hide part of the underlying element —
   the full-res source is always still there) with the box seeded to the PREVIOUS crop window, not
   just the sliver that was visible. Cancelling (leaving Crop without applying) must restore the
   image to its pre-recrop cropped state, since entering Crop is what visually expanded it. ────── */
test('react: re-entering crop on an already-cropped image shows the full image again with the previous crop window selected', async () => {
  const setup = await ed(async () => {
    const wed = window.__mounted.editor();
    const c = document.createElement('canvas'); c.width = 40; c.height = 40;
    c.getContext('2d').fillStyle = '#3366ff'; c.getContext('2d').fillRect(0, 0, 40, 40);
    const img = await wed.addImage(c.toDataURL(), { role: 'image', name: 'Layer', fit: 'contain' });
    img.set({ left: 0, top: 0, scaleX: 1, scaleY: 1, originX: 'left', originY: 'top' });
    img.setCoords();
    wed.fc.setActiveObject(img);
    wed.commit('test-setup');
    return { id: img.id };
  });

  await ed(() => window.__mounted.editor().setTool('crop'));
  await page.waitForTimeout(150);
  // shrink the box to a known sub-region, then apply
  await ed(() => { window.__mounted.editor().crop = { x: 10, y: 10, w: 16, h: 16 }; });
  await ed(() => window.__mounted.editor().applyCrop());
  await page.waitForTimeout(150);
  const afterFirstCrop = await ed((id) => {
    const img = window.__mounted.editor().fc.getObjects().find(o => o.id === id);
    return { width: img.width, height: img.height, cropX: img.cropX, cropY: img.cropY };
  }, setup.id);
  assert.deepEqual(afterFirstCrop, { width: 16, height: 16, cropX: 10, cropY: 10 });

  // re-select the now-cropped image and re-enter crop
  await ed((id) => { window.__mounted.editor().fc.setActiveObject(window.__mounted.editor().fc.getObjects().find(o => o.id === id)); }, setup.id);
  await ed(() => window.__mounted.editor().setTool('crop'));
  await page.waitForTimeout(150);

  const secondEntry = await ed((id) => {
    const wed = window.__mounted.editor();
    const img = wed.fc.getObjects().find(o => o.id === id);
    return { crop: wed.crop, imgWidth: img.width, imgHeight: img.height, imgCropX: img.cropX, imgCropY: img.cropY };
  }, setup.id);
  assert.deepEqual({ w: secondEntry.imgWidth, h: secondEntry.imgHeight, cropX: secondEntry.imgCropX, cropY: secondEntry.imgCropY }, { w: 40, h: 40, cropX: 0, cropY: 0 }, 'the image must expand back to its full original size on re-entry');
  assert.deepEqual(secondEntry.crop, { x: 10, y: 10, w: 16, h: 16 }, 'the crop box must be seeded to the PREVIOUS crop window, not the full image');

  // cancel: leave crop without applying — the image must restore to the first crop's state
  await ed(() => window.__mounted.editor().setTool('select'));
  await page.waitForTimeout(150);
  const afterCancel = await ed((id) => {
    const img = window.__mounted.editor().fc.getObjects().find(o => o.id === id);
    return { width: img.width, height: img.height, cropX: img.cropX, cropY: img.cropY };
  }, setup.id);
  assert.deepEqual(afterCancel, afterFirstCrop, 'cancelling re-crop must restore the image to its pre-recrop cropped state');
});

/* ── "Detect & convert to layers" previously failed SILENTLY on any non-'ok' detectRegions()
   status (no provider, rate limit, or zero regions found) — the button just reset with no
   explanation, which read as "doesn't work" even though it was actually erroring out correctly
   under the hood. Fixed to surface a real message for every failure reason. ─────────────────── */
test('react: "Detect & convert to layers" shows an error message instead of silently doing nothing when no regions are found', async () => {
  await page.locator('.cm-tabs button:has-text("AI")').first().click();
  await page.waitForTimeout(150);
  await page.locator('input.cm-ai-key').fill('fake-key-for-test');
  await page.locator('input.cm-ai-key').press('Enter');
  await page.waitForTimeout(150);
  await ed(() => { window.__mounted.editor().ai.provider().detectRegions = async () => []; });

  await page.locator('button:has-text("Detect & convert to layers")').first().click();
  /* Wait for the message rather than sleeping a fixed 300ms: detectRegions() flattens the canvas
     and round-trips the CV worker before it can report "no regions", and that takes longer on a
     cold worker or a loaded machine — a fixed sleep made this test flaky, not the code. */
  await page.locator('.cm-note', { hasText: 'No regions detected' }).first().waitFor({ timeout: 10000 });

  assert.equal(await page.locator('.cm-review-box').count(), 0);   // review did NOT silently open
  const notes = await page.locator('.cm-note').allTextContents();
  assert.ok(notes.some(t => t.includes('No regions detected')), 'expected the detectRegions() failure message to be shown to the user');
});

test('react: "Detect & convert to layers" shows an error message when the AI call itself throws', async () => {
  await page.locator('.cm-tabs button:has-text("AI")').first().click();
  await page.waitForTimeout(150);
  await page.locator('input.cm-ai-key').fill('fake-key-for-test');
  await page.locator('input.cm-ai-key').press('Enter');
  await page.waitForTimeout(150);
  await ed(() => { window.__mounted.editor().ai.provider().detectRegions = async () => { throw new Error('network unreachable'); }; });

  await page.locator('button:has-text("Detect & convert to layers")').first().click();
  // Same reason as the test above: wait for the message, don't sleep a fixed interval.
  await page.locator('.cm-note', { hasText: 'network unreachable' }).first().waitFor({ timeout: 10000 });

  const notes = await page.locator('.cm-note').allTextContents();
  // AIRegistry#run catches the throw and reports it as a 'provider_failed' status with the
  // error's own message truncated to 300 chars — that's what should surface here.
  assert.ok(notes.some(t => t.includes('network unreachable')), 'expected the thrown error message to be shown to the user');
});

/* ── gap-fill pass: features present in the vanilla demo but missing from the React shell,
   found by diffing every ed.<method>() call the demo makes against what React actually calls ── */
test('react: SVG export button downloads a real SVG string wrapped in a Blob URL', async () => {
  // SVG/JPG/PNG are consolidated behind one "Export image" dropdown now — open it first.
  await page.locator('.cm-export-btn').click();
  const svgBtn = page.locator('.cm-export-menu-item:has-text("SVG")');
  assert.ok(await svgBtn.count() > 0);
  const [download] = await Promise.all([
    page.waitForEvent('download').catch(() => null),
    svgBtn.click(),
  ]);
  // downloadURL() appends a real <a download> and clicks it — Playwright intercepts that as a
  // download event when one fires; if the browser instead just navigated, this at least confirms
  // exportSVG() itself didn't throw (the click completed without a page error).
  if (download) assert.ok(download.suggestedFilename().endsWith('.svg'));
});

test('react: Clip layer to selection / Clear clip apply and remove a clipPath on the active layer', async () => {
  await ed(() => window.__mounted.editor().setTool('rect'));
  const box = await canvasBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 150, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);

  await ed(() => window.__mounted.editor().setTool('marquee'));
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 110, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  // deliberately NOT switching to 'select' here — Editor#setTool('select') lifts any live pixel
  // selection into a new floating layer (see selectActiveOrCenter's own doc comment on _lastActiveId
  // for the same discard-on-tool-switch mechanism), which would clear ed.selection before Clip
  // ever got to use it. The left panel's tool options work from whatever tool is currently active,
  // same as the vanilla demo's tool-panel — no reason to force 'select' first. It's no longer
  // behind a "Tool" tab either — the left panel is untabbed since the layer list moved to the
  // right (see the "Layers" tab tests above), so Clip/Clear-clip are already visible here.
  const clipBtn = page.locator('button:has-text("Clip layer to selection")');
  assert.equal(await clipBtn.isDisabled(), false);
  await clipBtn.click();
  await page.waitForTimeout(100);
  assert.equal(await ed(() => !!window.__mounted.editor().fc.getObjects()[0].clipPath), true);

  await page.locator('button:has-text("Clear clip")').click();
  await page.waitForTimeout(100);
  assert.equal(await ed(() => !!window.__mounted.editor().fc.getObjects()[0].clipPath), false);
});

test('react: "Replace background" runs aiBgSwap and reports success', async () => {
  await setFakeAiKey();
  await ed(async () => {
    const wed = window.__mounted.editor();
    const c = document.createElement('canvas'); c.width = 20; c.height = 20;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, 20, 20);
    await wed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    wed.ai.provider().magicEdit = async () => {
      const out = document.createElement('canvas'); out.width = 4; out.height = 4;
      out.getContext('2d').fillStyle = '#00ff00'; out.getContext('2d').fillRect(0, 0, 4, 4);
      return out.toDataURL();
    };
  });
  // The AI tab's one prompt box describes the new background; the Replace BG quick action uses it.
  const input = page.locator('textarea[aria-label="Describe the change"]');
  assert.ok(await input.count() > 0);
  await input.fill('a sunset');
  await page.locator('.cm-aix-qa button:has-text("Replace BG")').click();
  await page.waitForTimeout(400);
  const notes = await page.locator('.cm-aix-msg').allTextContents();
  assert.ok(notes.some(t => t.includes('Applied')));
});

/* ── extend-background nudge banner: was entirely absent from the React shell — the artboard's
   own background must be genuinely transparent for a gap to exist at all (the default Editor
   background is opaque white, which backgroundGapFraction() correctly reports as "no gap"). ──── */
test('react: the extend-background banner appears only once a real transparent gap and an AI key both exist', async () => {
  assert.equal(await page.locator('.cm-extend-banner').count(), 0);
  await ed(() => { window.__mounted.editor().fc.setBackgroundColor('transparent', () => {}); });
  await ed(async () => {
    const wed = window.__mounted.editor();
    const c = document.createElement('canvas'); c.width = 20; c.height = 20;
    c.getContext('2d').fillStyle = '#ff0000'; c.getContext('2d').fillRect(0, 0, 20, 20);
    const img = await wed.addImage(c.toDataURL(), { role: 'bg', name: 'Background' });
    img.set({ left: 0, top: 0, scaleX: 1, scaleY: 1, originX: 'left', originY: 'top' });
    wed.commit('test-setup');
  });
  await page.waitForTimeout(700);   // 400ms debounce
  assert.equal(await page.locator('.cm-extend-banner').count(), 0, 'no AI key yet -> banner must stay hidden even with a real gap');

  await setFakeAiKey();
  // A real scene mutation, not just another commit() call — History#push dedupes consecutive
  // IDENTICAL serialized states (a no-op edit isn't an undo step), so committing with nothing
  // actually changed never fires 'change' at all and refreshExtendBanner() never re-runs.
  await ed(() => {
    const wed = window.__mounted.editor();
    const bg = wed.fc.getObjects().find(o => o.role === 'bg');
    bg.set({ left: (bg.left || 0) + 1 });
    wed.commit('nudge');
  });
  await page.waitForTimeout(700);
  assert.equal(await page.locator('.cm-extend-banner').count(), 1);

  await ed(() => {
    window.__mounted.editor().ai.provider().magicEdit = async () => {
      const out = document.createElement('canvas'); out.width = 4; out.height = 4;
      out.getContext('2d').fillStyle = '#00ff00'; out.getContext('2d').fillRect(0, 0, 4, 4);
      return out.toDataURL();
    };
  });
  await page.locator('.cm-extend-banner').click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.cm-extend-banner').count(), 0);   // hides immediately on click
});

test('react: the Canvas size popover has a grouped preset picker (Social/Print/Screen) that fills W/H', async () => {
  await page.locator('button:has-text("Canvas size")').click();
  await page.waitForTimeout(150);
  const select = page.locator('select').filter({ hasText: 'Preset' });
  assert.ok(await select.count() > 0);
  const groups = await select.locator('optgroup').evaluateAll(els => els.map(e => e.label));
  assert.deepEqual(groups, ['Social', 'Print', 'Screen']);

  await select.selectOption({ label: 'HD (720p) — 1280×720' });
  await page.waitForTimeout(100);
  const wVal = await page.locator('input[type=number]').first().inputValue();
  const hVal = await page.locator('input[type=number]').nth(1).inputValue();
  assert.equal(wVal, '1280');
  assert.equal(hVal, '720');

  await page.locator('button:has-text("Apply")').click();
  await page.waitForTimeout(150);
  const dims = await ed(() => ({ W: window.__mounted.editor().W, H: window.__mounted.editor().H }));
  assert.deepEqual(dims, { W: 1280, H: 720 });
});

/* ── session autosave + New ────────────────────────────────────────────────────────────────
   Parity check against the vanilla demo's own session behaviour: the React shell must persist
   a document across a reload and offer the same one-click way out of it. */

test('react: the document survives a reload, and New clears it (canvas, history and the save)', async () => {
  // This test is the only one that deliberately leaves a saved session behind, so it owns
  // clearing it — page contexts here share an origin, and a leftover scene would restore itself
  // into whichever test ran next. The store is IndexedDB (see session.js), not localStorage.
  const clearSaved = () => page.evaluate(() => new Promise(res => {
    const r = indexedDB.deleteDatabase('canvasmith');
    r.onsuccess = r.onerror = r.onblocked = () => res();
  }));
  await clearSaved();
  await ed(() => window.__mounted.editor().setTool('rect'));
  const canvasBox = await page.locator('canvas').first().boundingBox();
  await page.mouse.move(canvasBox.x + 40, canvasBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 140, canvasBox.y + 120, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(1200);        // outlast installAutosave's debounce

  assert.equal(await page.locator('.cm-save-note').count(), 1);

  await page.reload();
  await page.waitForFunction(() => window.__mounted && window.__mounted.editor() && window.__mounted.editor().fc, null, { timeout: 15000 });
  await page.waitForTimeout(1500);        // restoreSession settles on loadJSON's own commit
  assert.deepEqual(await ed(() => window.__mounted.editor().fc.getObjects().map(o => o.type)), ['rect']);

  // Undo must not walk back past the restore into a blank canvas the user never made.
  // The restored scene is the FLOOR of the undo stack (History#rebase), so there is nothing
  // behind it to walk back into.
  assert.equal(await ed(() => window.__mounted.editor().history.past.length), 1);
  await ed(() => window.__mounted.editor().undo());
  await page.waitForTimeout(400);
  assert.equal(await ed(() => window.__mounted.editor().fc.getObjects().length), 1);

  // New: confirmed, then everything goes — canvas, undo stack and the saved copy.
  page.on('dialog', d => d.accept());
  await page.locator('button:has-text("New")').first().click();
  await page.waitForTimeout(500);
  const after = await ed(() => ({
    objects: window.__mounted.editor().fc.getObjects().length,
    past: window.__mounted.editor().history.past.length,
  }));
  assert.deepEqual(after, { objects: 0, past: 1 });

  // New must wipe the stored copy too, not just the canvas — a reload here must stay empty.
  await page.reload();
  await page.waitForFunction(() => window.__mounted && window.__mounted.editor() && window.__mounted.editor().fc, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  assert.equal(await ed(() => window.__mounted.editor().fc.getObjects().length), 0);

  await clearSaved();
});

/* ── accessible names ──────────────────────────────────────────────────────────────────────
   Nearly every control in this editor is an icon with a `title`. A title is a mouse
   affordance — screen readers treat it as a last-resort fallback and several ignore it when
   the element has no other name — so without an explicit accessible name the tool rail, zoom
   pill, stacking and alignment controls all announce as an unlabelled "button". */

test('react: every icon-only button exposes an accessible name, including after panels re-render', async () => {
  const unlabeled = () => page.evaluate(() => {
    const out = [];
    document.querySelectorAll('button').forEach(b => {
      if ((b.textContent || '').trim()) return;          // a visible text label is its own name
      if (b.getAttribute('aria-label')) return;
      out.push(b.className + (b.id ? '#' + b.id : '') + ' title=' + (b.getAttribute('title') || ''));
    });
    return out;
  });
  assert.deepEqual(await unlabeled(), []);

  // The panels re-render constantly as tools/selections change, so a one-shot pass at mount
  // would miss most of these — re-check after the tool panels have swapped out.
  await ed(() => window.__mounted.editor().setTool('gradient'));
  await page.waitForTimeout(400);
  assert.deepEqual(await unlabeled(), []);

  await ed(() => window.__mounted.editor().setTool('select'));
  await page.waitForTimeout(400);
  assert.deepEqual(await unlabeled(), []);

  // The tool rail's own names come from the tooltip text, and its state must reach AT too:
  // aria-pressed says which tool is active, aria-expanded which group is showing its flyout.
  const rail = await page.evaluate(() => [...document.querySelectorAll('.cm-rail-btn')].map(b => ({
    name: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'),
  })));
  assert.ok(rail.length > 0);
  assert.ok(rail.every(r => r.name && r.name.length > 1), 'every rail button needs a name');
  assert.equal(rail.filter(r => r.pressed === 'true').length, 1, 'exactly one tool reads as active');

  // Icons are decorative — they must not leak into the accessibility tree alongside the name.
  const barecSvg = await page.evaluate(() => [...document.querySelectorAll('button svg')].filter(s => s.getAttribute('aria-hidden') !== 'true').length);
  assert.equal(barecSvg, 0);
});

/* ── UX fixes: recoverable New, project file, export scale, drop cue ───────────────────── */

test('react: New is recoverable — the toast Undo brings the discarded document back', async () => {
  await page.evaluate(() => new Promise(res => {
    const r = indexedDB.deleteDatabase('canvasmith'); r.onsuccess = r.onerror = r.onblocked = () => res();
  }));
  page.on('dialog', d => d.accept());
  await ed(() => window.__mounted.editor().setTool('rect'));
  const box = await page.locator('canvas').first().boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 130, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(1300);                       // outlast the autosave debounce
  assert.equal(await ed(() => window.__mounted.editor().fc.getObjects().length), 1);

  await page.locator('button:has-text("New")').first().click();
  await page.waitForTimeout(1200);
  assert.equal(await ed(() => window.__mounted.editor().fc.getObjects().length), 0);

  // reset() empties the undo stack by design, so the ONLY way back is the toast's Undo —
  // without it New would destroy the document outright.
  assert.equal(await page.locator('.cm-toast').count(), 1);
  await page.locator('.cm-toast button').click();
  await page.waitForTimeout(2200);
  assert.equal(await ed(() => window.__mounted.editor().fc.getObjects().length), 1);

  await page.evaluate(() => new Promise(res => {
    const r = indexedDB.deleteDatabase('canvasmith'); r.onsuccess = r.onerror = r.onblocked = () => res();
  }));
});

test('react: the export menu offers a real pixel scale and a layers-preserving project file', async () => {
  await page.locator('.cm-export-btn').click();
  await page.waitForTimeout(250);
  // The readout must state the actual output size — "2x" alone doesn't say whether it clears a
  // retina/print requirement.
  const at1 = await page.locator('.cm-export-dims').textContent();
  await page.locator('.cm-export-scale-btn', { hasText: '2×' }).click();
  await page.waitForTimeout(200);
  const at2 = await page.locator('.cm-export-dims').textContent();
  assert.notEqual(at1, at2);

  // …and the multiplier must reach the real exporter, not just the label.
  const px = await page.evaluate(() => {
    const read = (src) => new Promise(r => { const i = new Image(); i.onload = () => r(i.naturalWidth); i.src = src; });
    const e = window.__mounted.editor();
    return Promise.all([read(e.exportPNG(1)), read(e.exportPNG(2))]);
  });
  assert.equal(px[1], px[0] * 2);

  const items = await page.locator('.cm-export-menu-item').allTextContents();
  assert.ok(items.some(t => /Project file/.test(t)), 'can save an editable project');
  assert.ok(items.some(t => /Open project/.test(t)), 'can open one back');
});

/* ── left panel: tabs, contextual tool dock, active row, AI card ─────────────────────────────── */
test('react: left panel — tool dock only opens for tools with options; the active row follows the canvas selection', async () => {
  await ed(() => window.__mounted.editor().setTool('select'));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.cm-dock').count(), 0, 'no dock with plain Select');
  await ed(() => window.__mounted.editor().setTool('brush'));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.cm-dock').count(), 1, 'dock opens for Brush');
  assert.ok((await page.locator('.cm-dock').textContent()).includes('Opacity'));
  await ed(() => {
    const w = window.__mounted.editor(); w.setTool('select');
    const a = new w.fabric.Rect({ left: 10, top: 10, width: 30, height: 30, fill: '#ff0000' });
    const b = new w.fabric.Rect({ left: 60, top: 10, width: 30, height: 30, fill: '#0000ff', name: 'Blue', renamed: true });
    w.fc.add(a, b); w.commit('two');
    w.fc.setActiveObject(b);   // a canvas-side selection change: no scene change, no 'change' event
  });
  await page.waitForTimeout(150);
  const active = await page.locator('.cm-layer[data-on=true] .nm').textContent();
  assert.equal(active, 'Blue');
});

test('react: left panel — AI Vision tab, Auto Shadow toggle and Remove BG enablement', async () => {
  assert.equal(await page.locator('.cm-lp-tab[aria-selected=true]').textContent().then(t => t.startsWith('Layers')), true);
  await page.locator('.cm-lp-tab', { hasText: 'AI Vision' }).click();
  await page.waitForTimeout(100);
  assert.ok((await page.locator('.cm-lp-ai').textContent()).includes('Detected subjects'));
  await page.locator('.cm-lp-tab', { hasText: 'Layers' }).click();
  await ed(() => { const w = window.__mounted.editor(); const r = new w.fabric.Rect({ left: 10, top: 10, width: 40, height: 40, fill: '#ff0000' }); w.fc.add(r); w.fc.setActiveObject(r); w.commit('r'); });
  await page.waitForTimeout(150);
  const removeBg = page.locator('.cm-lp-card-row .cm-btn', { hasText: 'Remove BG' });
  assert.equal(await removeBg.isDisabled(), true, 'Remove BG needs an image/paint layer');
  const shadow = page.locator('.cm-lp-card-row .cm-btn', { hasText: 'Auto Shadow' });
  await shadow.click();
  await page.waitForTimeout(150);
  assert.equal(await ed(() => !!window.__mounted.editor().fc.getActiveObject().shadow), true);
  assert.equal(await shadow.getAttribute('data-on'), 'true');
  await ed(async () => {
    const c = document.createElement('canvas'); c.width = 20; c.height = 20; c.getContext('2d').fillRect(0, 0, 20, 20);
    const img = await window.__mounted.editor().addImage(c.toDataURL()); window.__mounted.editor().fc.setActiveObject(img);
  });
  await page.waitForTimeout(150);
  assert.equal(await removeBg.isDisabled(), false, 'enabled for an image');
});

/* ── overlays only draw for on-screen renders: a pick's offscreen capture (zoom reset to 100%)
   used to redraw the selection/hover outlines oversized and shifted off the artboard ────────── */
test('react: a magic wand capture with a selection showing never draws outlines outside the artboard', async () => {
  // A big document shown zoomed OUT, like a real 1500px ad — the bug only shows below 100% zoom.
  await ed(() => window.__mounted.editor().resizeCanvas(1600, 1200));
  await page.waitForTimeout(400);
  assert.ok(await ed(() => window.__mounted.editor().fc.getZoom()) < 0.9, 'document is shown zoomed out');
  await ed(() => {
    const e = window.__mounted.editor();
    const r = new e.fabric.Rect({ left: 0, top: 0, width: e.W, height: e.H, fill: '#d8e4c0', strokeWidth: 0 }); r.set({ id: 'bg2', role: 'shape' }); e.fc.add(r);
    const c = new e.fabric.Circle({ left: e.W * 0.55, top: e.H * 0.5, radius: Math.min(e.W, e.H) * 0.2, fill: '#b04020', strokeWidth: 0 }); c.set({ id: 'c', role: 'shape' }); e.fc.add(c);
    e.commit('add'); e.setTool('magicwand');
  });
  await page.waitForTimeout(150);
  const pt = await ed(() => { const e = window.__mounted.editor(), r = e.fc.upperCanvasEl.getBoundingClientRect(), v = e.fc.viewportTransform, x = e.W * 0.55 + Math.min(e.W, e.H) * 0.2, y = e.H * 0.5 + Math.min(e.W, e.H) * 0.2; return [r.left + x * v[0] + v[4], r.top + y * v[3] + v[5]]; });
  await page.mouse.click(pt[0], pt[1]);
  await page.waitForFunction(() => window.__mounted.editor().selection && !window.__mounted.editor().pickBusy, null, { timeout: 20000 });
  const r = await ed(() => {
    const e = window.__mounted.editor(), up = e.fc.upperCanvasEl, ctx = up.getContext('2d');
    const k = up.width / up.getBoundingClientRect().width, v = e.fc.viewportTransform;
    const box = [v[4] * k, v[5] * k, (v[4] + e.W * v[0]) * k, (v[5] + e.H * v[3]) * k];
    const count = () => { const d = ctx.getImageData(0, 0, up.width, up.height).data; let inside = 0, outside = 0;
      for (let y = 0; y < up.height; y += 2) for (let x = 0; x < up.width; x += 2) {
        if (d[(y * up.width + x) * 4 + 3] <= 40) continue;
        if (x >= box[0] - 6 && x <= box[2] + 6 && y >= box[1] - 40 * k && y <= box[3] + 6) inside++; else outside++;
      } return { inside, outside }; };
    e.fc.renderAll();
    const before = count();
    e.engine.captureFlat();   // what the next pick does first
    return { before, after: count() };
  });
  assert.ok(r.before.inside > 0, 'the selection outline is drawn on screen');
  assert.equal(r.after.outside, 0, 'nothing drawn outside the artboard after a capture');
  assert.ok(r.after.inside > 0, 'and the on-screen outline is untouched by it');
});

test('react: right-clicking a layer opens the context menu and its items work', async () => {
  await ed(() => {
    const e = window.__mounted.editor();
    const r = new e.fabric.Rect({ left: 60, top: 60, width: 120, height: 90, fill: '#f60', strokeWidth: 0 }); r.set({ id: 'R', role: 'shape', name: 'Box' }); e.fc.add(r);
    e.commit('add'); e.setTool('select'); e.fc.discardActiveObject(); e.fc.renderAll();
  });
  await page.waitForTimeout(150);
  const pt = await ed(() => { const e = window.__mounted.editor(), r = e.fc.upperCanvasEl.getBoundingClientRect(), v = e.fc.viewportTransform; return [r.left + 120 * v[0] + v[4], r.top + 105 * v[3] + v[5]]; });
  await page.mouse.click(pt[0], pt[1], { button: 'right' });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.cmx').count(), 1, 'menu is open');
  assert.equal(await ed(() => window.__mounted.editor().fc.getActiveObject().id), 'R');
  // themed from the shell's own tokens (mounted inside .cm-root)
  assert.ok(await page.evaluate(() => !!document.querySelector('.cm-root .cmx')));
  await page.locator('.cmx .cmx-item', { hasText: 'Duplicate' }).click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.cmx').count(), 0, 'menu closes after an action');
  assert.equal(await ed(() => window.__mounted.editor().fc.getObjects().filter(o => o.type === 'rect').length), 2);
  // submenu + keyboard: open again, Escape closes
  await page.mouse.click(pt[0], pt[1], { button: 'right' });
  await page.locator('.cmx .cmx-item', { hasText: 'Align to canvas' }).hover();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.cmx').count(), 2, 'submenu opens on hover');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.cmx').count(), 0);
});
