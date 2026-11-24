/* Session autosave — survive a tab close/refresh.

   The scene is already fully described by Editor#toJSON() (fabric JSON + the artboard's own W/H
   — see io.js serialize()), so persistence is a storage problem, not a serialization one.

   IT MUST BE IndexedDB, NOT localStorage. A scene embeds every imported photo as a base64 data
   URL inside the fabric JSON, and localStorage's per-origin budget is ~5MB across every browser
   — base64 inflating bytes by ~33% on top. One ordinary 1600×1200 photo serializes to ~7.7MB and
   is refused outright; even a 1200×800 gradient eats 1.9MB of the 5MB. Autosave on localStorage
   therefore fails for exactly the documents people care most about keeping. IndexedDB has no
   comparable ceiling (hundreds of MB, quota-managed per origin) and stores the string without a
   second encoding pass, so a real photo document round-trips.

   localStorage is kept only as a LAST-RESORT fallback for contexts where IndexedDB is missing or
   blocked (some private modes, locked-down embeds). It saves small documents and reports honestly
   when a big one won't fit, rather than silently pretending the work is safe.

   Everything here is async because IndexedDB is. Writes are DEBOUNCED by installAutosave (a brush
   stroke commits on every stroke, and serializing a large scene each time would jank the canvas).

   The backend is injected (`storage` option) so the quota/corruption paths stay testable in bare
   node and so a host can supply its own (a server, OPFS, etc.). */

export const SESSION_KEY = 'canvasmith.session';
/* Where "New" parks the document it just discarded, so the action is recoverable. Separate key,
   same store: it must survive the clearSession() that New performs on the live slot. */
export const TRASH_KEY = 'canvasmith.session.trash';
const DB_NAME = 'canvasmith';
const STORE = 'sessions';
const VERSION = 1;

/* ── IndexedDB backend ─────────────────────────────────────────────────────────────────────
   A deliberately tiny get/set/del over one object store. No index, no migrations: a session is
   a single record read whole at boot and replaced whole on every save. */

function idbAvailable() {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null; } catch (e) { return false; }
}

function openDB() {
  return new Promise((resolve, reject) => {
    let req;
    // Merely CALLING open() throws in some sandboxed iframes, so this is guarded too.
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { return reject(e); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
    // Firefox fires neither success nor error when storage is disabled in a private window.
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
}

function idbBackend() {
  return {
    kind: 'idb',
    async get(key) {
      const db = await openDB();
      try {
        return await new Promise((resolve, reject) => {
          const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
          r.onsuccess = () => resolve(r.result != null ? r.result : null);
          r.onerror = () => reject(r.error);
        });
      } finally { db.close(); }
    },
    async set(key, value) {
      const db = await openDB();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(value, key);
          tx.oncomplete = resolve;
          // A genuine over-quota write surfaces on the transaction, not the request.
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('aborted'));
        });
      } finally { db.close(); }
    },
    async del(key) {
      const db = await openDB();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(key);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('aborted'));
        });
      } finally { db.close(); }
    },
  };
}

/* ── localStorage fallback ───────────────────────────────────────────────────────────────── */

function isQuotaError(e) {
  return e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
}

function lsBackend() {
  let ls = null;
  try {
    ls = typeof window !== 'undefined' ? window.localStorage : null;
    // Touch it: in Safari's private/lockdown modes the object exists but setItem throws.
    if (ls) { const p = '__cm_probe__'; ls.setItem(p, '1'); ls.removeItem(p); }
  } catch (e) { ls = null; }
  if (!ls) return null;
  return {
    kind: 'ls',
    async get(key) { try { return ls.getItem(key); } catch (e) { return null; } },
    async set(key, value) {
      try { ls.setItem(key, value); }
      catch (e) {
        if (!isQuotaError(e)) throw e;
        // Dropping our own stale (possibly larger) record frees the budget it held, which is
        // often enough on its own for the new one to fit.
        try { ls.removeItem(key); ls.setItem(key, value); }
        catch (e2) { throw e2; }
      }
    },
    async del(key) { try { ls.removeItem(key); } catch (e) { } },
  };
}

/* Resolves the backend once per call site. An explicit `storage` always wins (tests, custom
   hosts); otherwise IndexedDB, then localStorage, then nothing. */
function backendFor(storage) {
  if (storage) return storage;
  if (idbAvailable()) return idbBackend();
  return lsBackend();
}

/* A saved session is {v, savedAt, scene, extras}, stored as a STRING so both backends hold the
   same bytes and a write is one stringify of a small wrapper rather than a re-serialization of
   the whole scene graph. */

export async function readSession({ storage, key = SESSION_KEY } = {}) {
  const be = backendFor(storage);
  if (!be) return null;
  let raw = null;
  try { raw = await be.get(key); } catch (e) { return null; }
  if (!raw) return null;
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // A record written by a future/older build may not restore cleanly here. Half-restoring it
    // would leave the user with a broken document they can't undo out of, so treat a version
    // mismatch as "no session".
    if (!data || data.v !== VERSION || typeof data.scene !== 'string') return null;
    return { scene: data.scene, extras: data.extras || {}, savedAt: data.savedAt || 0 };
  } catch (e) {
    // Corrupt/truncated record (an interrupted write) — drop it so the next boot starts clean
    // instead of failing the same way forever.
    try { await be.del(key); } catch (e2) { }
    return null;
  }
}

export async function clearSession({ storage, key = SESSION_KEY } = {}) {
  const be = backendFor(storage);
  if (!be) return false;
  try { await be.del(key); return true; } catch (e) { return false; }
}

/* Writes {scene, extras}, shedding `extras` if the payload doesn't fit (only reachable on the
   localStorage fallback in practice). Returns 'ok' | 'ok-trimmed' | 'failed' | 'unavailable' so a
   host can tell the user their work is not being saved rather than silently pretending it is. */
export async function writeSession(scene, extras = {}, { storage, key = SESSION_KEY } = {}) {
  const be = backendFor(storage);
  if (!be) return 'unavailable';
  if (typeof scene !== 'string') return 'failed';
  const put = async (payload) => {
    try { await be.set(key, JSON.stringify(payload)); return true; } catch (e) { return false; }
  };
  const base = { v: VERSION, savedAt: Date.now(), scene };
  if (await put({ ...base, extras })) return 'ok';
  if (Object.keys(extras).length && await put(base)) return 'ok-trimmed';
  // Not even the scene fits — clear the key so a stale older session isn't left behind
  // masquerading as current. The live document is untouched; only the autosave is gone.
  await clearSession({ storage: be, key });
  return 'failed';
}

/* Wires an Editor to a storage key: debounced autosave on 'change', a flush when the page is
   hidden/unloaded, and restore() to bring the last session back.

   `getExtras` lets a host persist its own session-scoped state (the shells' asset tray and
   compare baseline) in the SAME record as the scene — separate keys could leave one session's
   assets pinned next to another session's scene.

   Returns a handle; call stop() to detach (destroy(), hot reload, unmount). */
export function installAutosave(ed, {
  storage, key = SESSION_KEY, delay = 800, getExtras = null, onStatus = null,
} = {}) {
  const be = backendFor(storage);
  let timer = null, stopped = false, last = null;
  let writing = null;      // in-flight write, so saves can't interleave and land out of order
  let pending = false;     // a change arrived mid-write — save again once it settles

  const status = (s) => { last = s; if (onStatus) { try { onStatus(s); } catch (e) { console.error(e); } } };

  const doWrite = async () => {
    let extras = {};
    if (getExtras) { try { extras = getExtras() || {}; } catch (e) { extras = {}; } }
    // Serialize on the main thread BEFORE awaiting, so the saved scene is the one that existed
    // when the save was triggered rather than whatever it became mid-write.
    const scene = ed.toJSON();
    status(await writeSession(scene, extras, { storage: be, key }));
  };

  /* IndexedDB writes are async, so two rapid commits could otherwise race and leave the OLDER
     scene as the final stored state. Chain them: one write at a time, with at most one more
     queued behind it (any number of changes during a write collapse into that single re-save). */
  const saveNow = () => {
    if (stopped || !be) return writing || Promise.resolve();
    clearTimeout(timer); timer = null;
    if (writing) { pending = true; return writing; }
    writing = doWrite()
      .catch(e => { console.error('[canvasmith] autosave failed', e); status('failed'); })
      .then(() => {
        writing = null;
        if (pending && !stopped) { pending = false; return saveNow(); }
      });
    return writing;
  };

  const schedule = () => {
    if (stopped || !be) return;
    clearTimeout(timer);
    timer = setTimeout(saveNow, delay);
  };

  const off = ed.on('change', schedule);
  // 'pagehide' rather than 'beforeunload': beforeunload never fires on mobile Safari when a tab
  // is backgrounded then discarded, which is exactly the "came back later" case this exists for.
  // visibilitychange covers tab-switch-then-crash.
  //
  // NOTE: an IndexedDB write started here is not guaranteed to complete if the page is actually
  // being torn down — the debounce is deliberately short (800ms) so in practice the scene is
  // already saved well before the user closes anything.
  const onHide = () => { if (timer || pending) saveNow(); };
  const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && (timer || pending)) saveNow(); };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onHide);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  }

  return {
    available: !!be,
    backend: be ? be.kind : null,
    saveNow,
    status: () => last,
    read: () => readSession({ storage: be, key }),
    clear: () => { clearTimeout(timer); timer = null; pending = false; return clearSession({ storage: be, key }); },
    stop() {
      stopped = true;
      clearTimeout(timer); timer = null;
      off();
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onHide);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
      }
    },
  };
}

/* "New" is the one irreversible action in the editor: Editor#reset() empties the undo stack by
   design, and with autosave on it also clears the stored copy — so a mis-click destroys the
   document outright. discardToTrash() copies the current session into a second slot first, and
   restoreDiscarded() brings it back, which turns New from destructive into undoable.

   Kept to ONE trash slot deliberately: this is an "undo that mis-click" affordance, not version
   history. A photo document is tens of MB, and silently retaining every discarded document would
   grow the origin's storage without the user ever asking for it. */
export async function discardToTrash({ storage, key = SESSION_KEY, trashKey = TRASH_KEY } = {}) {
  const be = backendFor(storage);
  if (!be) return false;
  try {
    const raw = await be.get(key);
    if (!raw) return false;
    await be.set(trashKey, raw);
    return true;
  } catch (e) { return false; }
}

export async function readDiscarded({ storage, trashKey = TRASH_KEY } = {}) {
  return readSession({ storage, key: trashKey });
}

export async function clearDiscarded({ storage, trashKey = TRASH_KEY } = {}) {
  return clearSession({ storage, key: trashKey });
}

/* Puts the trashed document back as the live session and loads it. Returns its extras (asset
   tray, compare baseline) like restoreSession, or null when the trash is empty. */
export async function restoreDiscarded(ed, { storage, key = SESSION_KEY, trashKey = TRASH_KEY } = {}) {
  const be = backendFor(storage);
  if (!be) return null;
  let raw = null;
  try { raw = await be.get(trashKey); } catch (e) { return null; }
  if (!raw) return null;
  try { await be.set(key, raw); } catch (e) { /* the load below still works from the trash copy */ }
  const extras = await restoreSession(ed, { storage: be, key: trashKey });
  await clearSession({ storage: be, key: trashKey });
  return extras;
}

/* ── project file (.canvasmith) ────────────────────────────────────────────────────────────
   Export/import gives the document a life outside this browser. Until now the only way out was
   PNG/JPG/SVG — all flattened or lossy — so layers, masks and adjustment stacks could never
   leave, be backed up, moved to another machine, or handed to someone else.

   Same envelope as an autosave record (so the two are interchangeable and one code path reads
   both), plus a `kind` marker to give a clearly wrong file an honest error rather than a
   confusing half-load. */
const PROJECT_KIND = 'canvasmith/project';

export function exportProject(ed, extras = {}, docs = null) {
  // `scene` stays the active page (what every older version reads); `pages` adds the whole tab set when there is one
  const rec = { kind: PROJECT_KIND, v: VERSION, savedAt: Date.now(), scene: ed.toJSON(), extras };
  if (docs && typeof docs.exportState === 'function') rec.pages = docs.exportState();
  return JSON.stringify(rec);
}

/* Parses and validates a .canvasmith file's text. Throws with a message meant to be SHOWN to the
   user — "this isn't a project file" is the single most likely thing to go wrong here (someone
   picks a .png), and it deserves a real sentence rather than a silent no-op. */
export function parseProject(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error('That file isn\u2019t a Canvasmith project (it isn\u2019t valid JSON).'); }
  if (!data || typeof data !== 'object' || typeof data.scene !== 'string') {
    throw new Error('That file isn\u2019t a Canvasmith project.');
  }
  if (data.kind && data.kind !== PROJECT_KIND) throw new Error('That file isn\u2019t a Canvasmith project.');
  if (data.v > VERSION) throw new Error('That project was saved by a newer version of Canvasmith.');
  return { scene: data.scene, extras: data.extras || {}, pages: data.pages && Array.isArray(data.pages.docs) ? data.pages : null };
}

/* Loads a parsed project into `ed`. Rebases history for the same reason restoreSession does:
   an opened document is not an edit made in this session, so undo must not walk back into
   whatever was on the canvas before it. */
export function loadProject(ed, text, docs = null) {
  /* Parse INSIDE the promise: a synchronous throw from an async-looking function is a trap for
     callers (a .catch() on the returned promise never runs, and the error escapes to wherever
     the call happened to sit instead). Rejecting keeps one error path for every failure. */
  let parsed;
  try { parsed = parseProject(text); }
  catch (e) { return Promise.reject(e); }
  const { scene, extras, pages } = parsed;
  // a multi-page project: hand the whole set to the tab manager (it loads the active page and rebases undo itself)
  if (pages && docs && typeof docs.importState === 'function') {
    return docs.importState(pages).then(ok => { if (ok) return extras; return loadProject(ed, text, null); });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; ed.history.rebase(ed.toJSON()); resolve(extras); };
    const off = ed.on('change', () => { off(); done(); });
    ed.loadJSON(scene);
    setTimeout(() => { off(); done(); }, 4000);
  });
}

/* Restores a saved scene into `ed`. Resolves with the extras the host stashed alongside it (so
   the caller can repopulate its asset tray etc.) or null when there was nothing to restore.

   The restored scene becomes the BASELINE history entry, not an edit layered on top of one. The
   Editor's constructor has already pushed an empty canvas as entry #1 by the time this runs, so
   without dropping that, a single Ctrl+Z right after a restore would wipe the user's document
   back to the blank canvas it replaced — the restored work is not an edit the user made in this
   session, so there is nothing there to undo.

   The restore REBASES the undo stack (History#rebase) rather than clearing it at a chosen
   moment. loadJSON finishes through fabric's async enlivenObjects and hosts commit on their own
   schedule inside and after that window — the React shell's mount effect and its fit-to-screen
   pass both do — so any "clear it now" approach loses the race whenever a commit lands just
   after the clear and reinstates a blank entry underneath the document. Rebasing is ordering-
   independent: it makes the restored scene the floor of the stack, and later commits stack on
   top of it the way ordinary edits should. */
export async function restoreSession(ed, { storage, key = SESSION_KEY } = {}) {
  const saved = await readSession({ storage, key });
  if (!saved) return null;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      /* Rebase onto the LIVE canvas, not `saved.scene` verbatim: loadJSON normalises the scene
         (enlivened objects re-serialize with fabric's defaults filled in), and a floor that
         didn't match the canvas would make the first undo a visible no-op jump. */
      if (v) ed.history.rebase(ed.toJSON());
      resolve(v);
    };
    try {
      /* Subscribe BEFORE loading. Fabric's enlivenObjects calls back synchronously when nothing
         in the scene needs fetching (shapes/text — only images actually go async), so loadJSON's
         own commit can fire before this line would otherwise have run, and a listener registered
         afterwards would wait out the timeout on every text/shape document. */
      const off = ed.on('change', () => { off(); done(saved.extras); });
      ed.loadJSON(saved.scene);
      // Backstop for the async path (images still decoding) and for a load that never commits.
      setTimeout(() => { off(); done(saved.extras); }, 4000);
    } catch (e) {
      console.error('[canvasmith] could not restore session', e);
      clearSession({ storage, key });
      done(null);
    }
  });
}
