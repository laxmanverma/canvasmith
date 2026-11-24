/* Multi-document tabs (Photoshop-style): several independent artboards open at once, one live on
   the canvas at a time.

   ONE Editor/fabric canvas is reused for every tab. A document is parked as its serialized scene
   (Editor#toJSON — fabric JSON + the artboard's W/H) plus its own undo/redo stacks, and switching
   is "park the current, Editor#loadDocument the target". That keeps every tool, the AI/CV
   engines and the host's event wiring pointed at a single Editor — nothing downstream has to
   know there is more than one document.

   Persistence is layered on session.js's autosave, which already stores the LIVE document:
     - the live document is the session record's job;
     - this module persists the tab list plus every PARKED document's scene under its own key.
   A switch writes a full record first (live scene included), then lets the host flush its
   session autosave, then rewrites the record without the live scene. A reload at any point in
   between restores a consistent set — never tab B's name over tab A's pixels.

   Depends only on a small Editor surface (toJSON, loadDocument, reset, history, W/H) so it stays
   testable in bare node with a fake editor. */

import { readSession, writeSession, clearSession } from './session.js';

export const DOCS_KEY = 'canvasmith.docs';
export const MAX_DOCS = 3;   // product limit: at most 3 pages open at once

let _n = 0;
const newId = () => 'd' + Date.now().toString(36) + (++_n).toString(36) + Math.random().toString(36).slice(2, 5);

export class DocumentSet {
  /* opts.flush: async () => void — host's session.saveNow, called while persisting a switch.
     opts.storage / opts.key: injected backend, like session.js. opts.blank: {width,height} for
     new tabs when add() isn't told. */
  constructor(ed, { storage, key = DOCS_KEY, flush = null, blank = { width: 960, height: 640 }, persist = true } = {}) {
    this.ed = ed;
    this.storage = storage;
    this.key = key;
    this.flush = flush;
    this.blank = blank;
    this.persist = persist;
    this.docs = [{ id: newId(), name: 'Untitled 1', parked: null }];
    this.activeId = this.docs[0].id;
    this._seq = 1;              // names only ever count up, so closing "Untitled 2" never reuses it
    this._listeners = new Set();
    this._busy = null;          // serializes switch/add/close — each awaits an async canvas load
    this._saving = Promise.resolve();
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit(kind) { const s = this.list(); this._listeners.forEach(fn => { try { fn(s, kind); } catch (e) { console.error(e); } }); }

  list() { return this.docs.map(d => ({ id: d.id, name: d.name, active: d.id === this.activeId })); }
  get active() { return this.docs.find(d => d.id === this.activeId); }
  get count() { return this.docs.length; }

  _park(d) {
    const h = this.ed.history;
    d.parked = { scene: this.ed.toJSON(), past: h.past.slice(), future: h.future.slice() };
  }

  /* One structural operation at a time: loadDocument is async, and a second click during it would
     park a half-loaded canvas as the "current" document. */
  _run(fn) {
    const next = (this._busy || Promise.resolve()).then(fn, fn);
    this._busy = next.catch(() => { });
    return next;
  }

  async _load(d) {
    if (d.parked) await this.ed.loadDocument(d.parked.scene, d.parked);
    else this.ed.reset({ width: d.w || this.blank.width, height: d.h || this.blank.height });
    d.parked = null;
    this.activeId = d.id;
  }

  /* Opens a new blank tab and makes it active. `scene` (an Editor#toJSON string) opens that
     document instead — used by duplicate(). Returns the new id, or null at the tab limit. */
  add({ name, width, height, scene } = {}) {
    return this._run(async () => {
      if (this.docs.length >= MAX_DOCS) return null;
      const cur = this.active;
      this._park(cur);
      const d = { id: newId(), name: name || `Untitled ${++this._seq}`, w: width, h: height, parked: scene ? { scene, past: [], future: [] } : null };
      const at = this.docs.indexOf(cur) + 1;      // opens next to the tab you were on, like a browser
      this.docs.splice(at, 0, d);
      await this._load(d);
      this._emit('switch');
      await this._save(true);
      return d.id;
    });
  }

  switchTo(id) {
    return this._run(async () => {
      const d = this.docs.find(x => x.id === id);
      if (!d || d.id === this.activeId) return false;
      this._park(this.active);
      await this._load(d);
      this._emit('switch');
      await this._save(true);
      return true;
    });
  }

  /* Closing the live tab activates its neighbour; the last remaining tab can't be closed (use New
     to clear it) so the editor never has zero documents. */
  close(id) {
    return this._run(async () => {
      if (this.docs.length < 2) return false;
      const i = this.docs.findIndex(x => x.id === id);
      if (i < 0) return false;
      const wasActive = this.docs[i].id === this.activeId;
      if (wasActive) {
        const next = this.docs[i + 1] || this.docs[i - 1];
        this.docs.splice(i, 1);
        await this._load(next);
        this._emit('switch');
      } else {
        this.docs.splice(i, 1);
        this._emit('list');
      }
      await this._save(true);
      return true;
    });
  }

  duplicate(id = this.activeId) {
    const d = this.docs.find(x => x.id === id);
    if (!d) return Promise.resolve(null);
    const scene = d.id === this.activeId ? this.ed.toJSON() : d.parked.scene;
    return this.add({ name: d.name + ' copy', scene });
  }

  rename(id, name) {
    const d = this.docs.find(x => x.id === id);
    name = String(name || '').trim().slice(0, 40);
    if (!d || !name || name === d.name) return false;
    d.name = name;
    this._emit('list');
    this._save(false);
    return true;
  }

  /* ── persistence ───────────────────────────────────────────────────────────────────── */
  _record(withLive) {
    return JSON.stringify({
      activeId: this.activeId,
      seq: this._seq,
      docs: this.docs.map(d => {
        const live = d.id === this.activeId;
        const scene = live ? (withLive ? this.ed.toJSON() : null) : (d.parked && d.parked.scene) || null;
        return { id: d.id, name: d.name, scene };
      }),
    });
  }

  /* Chained, like installAutosave's writes — two quick tab operations must not land out of order. */
  _save(full) {
    if (!this.persist) return Promise.resolve();
    const run = async () => {
      const be = { storage: this.storage, key: this.key };
      if (full && this.flush) {
        await writeSession(this._record(true), {}, be);
        try { await this.flush(); } catch (e) { /* the lean record below is still correct without it */ }
      }
      await writeSession(this._record(false), {}, be);
    };
    this._saving = this._saving.then(run, run).catch(e => console.error('[canvasmith] tab save failed', e));
    return this._saving;
  }

  /* Rebuilds the tab list after a reload. Call it BEFORE restoreSession(), not after: that waits
     out a 4s backstop whenever the saved scene is identical to the blank one already on the canvas
     (no 'change' ever fires), and the tab strip shouldn't sit stale for that long.

     Resolves false (nothing saved), 'tabs' (list rebuilt; the live document is the session's job,
     so go on and restoreSession) or 'loaded' (the record still carried the live tab's scene — a
     reload that landed mid-switch — and it is already on the canvas, so the session's copy, which
     is the stale one, must NOT be loaded over it). */
  async restore() {
    const rec = await readSession({ storage: this.storage, key: this.key });
    if (!rec) return false;
    let data;
    try { data = JSON.parse(rec.scene); } catch (e) { return false; }
    return this._adopt(data);
  }

  /* The whole tab set as plain data — every page's scene (the live one included) — for a project file. */
  exportState() { return JSON.parse(this._record(true)); }

  /* Replaces the open pages with a saved set (a project file's `pages`). Resolves false when the data isn't a usable
     set, else true once the active page is on the canvas. Undo is rebased so Ctrl+Z can't walk back into the
     document that was open before. */
  async importState(data) {
    const ok = await this._run(async () => { const r = await this._adopt(data); return !!r; });
    if (ok) await this._save(true);
    return ok;
  }

  async _adopt(data) {
    if (!data || !Array.isArray(data.docs) || !data.docs.length) return false;
    const docs = data.docs.filter(d => d && typeof d.id === 'string').slice(0, MAX_DOCS)
      .map(d => ({ id: d.id, name: String(d.name || 'Untitled').slice(0, 40), parked: typeof d.scene === 'string' ? { scene: d.scene, past: [], future: [] } : null }));
    if (!docs.length) return false;
    const active = docs.find(d => d.id === data.activeId) || docs[0];
    // A parked doc must carry a scene; the live one may not (the session holds it).
    this.docs = docs.filter(d => d === active || d.parked);
    this.activeId = active.id;
    this._seq = Math.max(data.seq || 0, this.docs.length);
    let loaded = false;
    if (active.parked) {
      const p = active.parked; active.parked = null;
      await this.ed.loadDocument(p.scene, null);
      this.ed.history.rebase(this.ed.toJSON());
      loaded = true;
    }
    this._emit('switch');
    return loaded ? 'loaded' : 'tabs';
  }

  clearSaved() { return clearSession({ storage: this.storage, key: this.key }); }
}

export function installDocuments(ed, opts) { return new DocumentSet(ed, opts); }
