/* Voice control — say what you want, the editor does it.

   Three layers, so the interesting parts are testable without a microphone:
     voice-commands.js   the CATALOG: every feature once (phrases, args, AI doc, runner)
     parseVoiceCommand   pure: transcript -> { action, ...args } | null (instant, offline grammar)
     installVoice        browser: Web Speech API -> grammar -> (else) AI provider -> run on the editor

   OFFLINE FIRST (default, `offline: true`): speech is recognised on-device where the browser can
   (Chrome's processLocally), the phrase grammar does the rest, nothing goes to an AI model, and
   AI-only commands say so instead of running. A miss gets a "did you mean …?" hint.
   `offline: false` opts back in: a phrase the grammar doesn't know goes to the registered AI
   provider's interpretCommand (LLM) with the catalog as its menu; whatever comes back is
   re-validated by normalizeCommand before it can run. Things a shell owns (zoom, export, new document, theme, panels...) go through
   opts.actions so both shells can plug in their own.

     const voice = installVoice(ed, { actions: { zoomIn, zoomOut, fit, export, newDoc, ... }, onStatus });
     voice.toggle();   // start/stop listening      voice.supported // false in Firefox */

import { parseCompound, parseCommand, normalizeCommand, runCommand, catalogPrompt, normalizeText, heardVariants, suggestCommand } from './voice-commands.js';

export { COMMANDS, catalogPrompt, suggestCommand } from './voice-commands.js';
export const normalizeLLMCommand = normalizeCommand;

/* "undo and zoom in" / "make it red then add a shadow": chain only when EVERY part is a known
   command, so a stray "and" inside an AI request ("a cat and a dog") never splits it. */
/* "delete the circle", "make the star red", "move the square to the left": an action on a layer
   named by shape/role. Select that layer first, then run the same phrase with "the circle" -> "it".
   Only tried after the plain grammar missed, and only for words that name layers we can find
   without AI (never "the dog" — that stays an AI/LLM request). */
const LAYER_NOUN = /\b(?:the|this) (circle|ellipse|oval|square|rectangle|box|triangle|star|line|polygon|text|title|heading|logo|sticker|shape)\b/;
function parseTargeted(text) {
  const t = normalizeText(text), m = LAYER_NOUN.exec(t);
  if (!m) return null;
  const rest = parseCommand(t.replace(m[0], 'it'));
  return rest ? [{ action: 'selectLayers', targets: [m[1]], mode: 'replace' }, rest] : null;
}

/* "hide layer 2", "delete the first layer", "lock the last layer": an action on a layer named by number
   or position. Select that layer, then run the rest on "it". */
const LAYER_REF = /\b(?:the )?(?:layer (?:number |no |num )?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|top|bottom|next|previous|\d+(?:st|nd|rd|th)) layer(?: from (?:the )?(?:top|bottom))?)/;
function parseLayerRef(text) {
  const t = normalizeText(text), m = LAYER_REF.exec(t);
  if (!m || /^(?:select|pick|choose|go to|activate|open)\b/.test(t)) return null;
  const sel = parseCommand('select ' + m[0].replace(/^the /, ''));
  const rest = sel && sel.action === 'selectLayer' ? parseCommand(t.replace(m[0], 'it')) || parseCommand(t.replace(m[0], ' ')) : null;
  return rest && rest.action !== 'selectLayer' ? [sel, rest] : null;
}

export function parseVoiceCommands(text) {
  const one = parseCommand(text);
  if (one) return [one];
  const targeted = parseTargeted(text) || parseLayerRef(text);
  if (targeted) return targeted;
  // "undo twice", "add a circle 3 times"
  const rm = /^(.+?) (twice|(?:two|three|four|five|\d+) times)$/.exec(normalizeText(text));
  if (rm) {
    const n = rm[2] === 'twice' ? 2 : ({ two: 2, three: 3, four: 4, five: 5 }[rm[2].split(' ')[0]] || +rm[2].split(' ')[0]);
    const base = n >= 2 && n <= 10 ? parseVoiceCommands(rm[1]) : null;
    if (base) return Array.from({ length: n }, () => base).flat();
  }
  /* chain parts: a part may itself be a misheard phrase ("drawer image") or two commands run together
     with no "and" ("add a circle change color to red"), so split further at a new command verb */
  const part = (p) => {
    const c = parseCommand(p) || heardVariants(p).map(parseCommand).find(Boolean);
    if (c) return [c];
    const bits = p.split(/\s+(?=(?:change|set|make|move|position|put|rotate|delete|flip|resize)\b)/);
    const cs = bits.length > 1 ? bits.map(b => parseCommand(b) || heardVariants(b).map(parseCommand).find(Boolean)) : null;
    return cs && cs.every(Boolean) ? cs : null;
  };
  const parts = normalizeText(text).split(/\s+(?:and then|then|and|after that|next)\s+/).filter(Boolean);
  const cmds = parts.length >= 1 && parts.length <= 5 ? parts.map(part) : null;
  if (cmds && cmds.every(Boolean)) { const flat = cmds.flat(); if (flat.length >= 2) return flat; }
  const comp = parseCompound(text);
  if (comp) return comp;
  // an offline recogniser's usual mishearings ("read" for "red"), tried last: every plain reading of the phrase missed
  for (const v of heardVariants(text)) { const c = parseCommand(v) || parseTargeted(v); if (c) return Array.isArray(c) ? c : [c]; }
  return null;
}
export function parseVoiceCommand(text) { return parseCommand(text); }

/* Run a parsed command. Returns a short human string (or a Promise of one) describing what
   happened; throws if the command can't apply (nothing selected, shell lacks the action...). */
export function runVoiceCommand(editor, cmd, actions = {}, { offline = false } = {}) { return runCommand(editor, cmd, { actions, offline }); }

/* Browser wiring. onStatus({ state: 'listening'|'idle'|'heard'|'done'|'error', text, message }) lets
   a shell show a caption; it never needs to know about SpeechRecognition itself. */
export function installVoice(editor, { actions = {}, onStatus = () => {}, lang = 'en-US', offline = true, win = typeof window !== 'undefined' ? window : null } = {}) {
  const SR = win && (win.SpeechRecognition || win.webkitSpeechRecognition);
  if (!SR) return { supported: false, listening: false, start() {}, stop() {}, toggle() {}, destroy() {} };

  let rec = null, wantOn = false, lastCmds = null;
  const api = { supported: true, listening: false };
  const shellActions = { ...actions, stopListening: () => api.stop() };

  /* Utterances run one at a time, in order — "select the dog" must finish before "make it bigger". */
  let queue = Promise.resolve();
  const execAll = async (text, cmds) => {
    const done = [];
    for (const cmd of cmds) {
      let r = runVoiceCommand(editor, cmd, shellActions, { offline });
      if (r && typeof r.then === 'function') { onStatus({ state: 'thinking', text }); r = await r; }
      done.push(r);
    }
    onStatus({ state: 'done', text, message: done.join(', ') });
  };
  /* Grammar missed: ask the LLM (if a provider with a key is registered), handing it the whole
     catalog as its menu. Returns false when no provider is available. */
  const askLLM = async (text) => {
    const ai = editor.ai, p = ai && ai.provider && ai.provider();
    if (!ai || !ai.can('interpretCommand') || (p && typeof p.hasKey === 'function' && !p.hasKey())) return false;
    onStatus({ state: 'thinking', text });
    const act = (editor.layers ? editor.layers() : []).find(l => l.active);
    const r = await ai.run('interpretCommand', text, {
      catalog: catalogPrompt(),
      state: { tool: editor.tool, activeLayer: act ? { role: act.role, name: act.name } : null, hasSelection: !!editor.selection, canvas: { w: editor.W, h: editor.H } },
    });
    if (r.status !== 'ok') { onStatus({ state: 'error', text, message: r.message || 'AI could not interpret that' }); return true; }
    const cmds = (Array.isArray(r.result) ? r.result : []).slice(0, 5).map(normalizeLLMCommand).filter(Boolean);
    if (!cmds.length) { onStatus({ state: 'error', text, message: `Didn't understand "${text}"` }); return true; }
    await execAll(text, cmds);
    return true;
  };
  const handle = (text) => {
    onStatus({ state: 'heard', text });
    queue = queue.then(async () => {
      // "again" / "repeat" re-run the last thing that worked
      if (/^(?:(?:do it |do that )?again|repeat(?: that| it)?)$/.test(normalizeText(text))) {
        if (!lastCmds) return onStatus({ state: 'error', text, message: 'Nothing to repeat yet' });
        return execAll(text, lastCmds);
      }
      const cmds = parseVoiceCommands(text);
      if (cmds) { await execAll(text, cmds); if (!cmds.some(c => c.action === 'help' || c.action === 'stopListening')) lastCmds = cmds; return; }
      if (!offline && (await askLLM(text))) return;
      const near = suggestCommand(text);
      onStatus({ state: 'error', text, message: `Didn't understand "${text}"` + (near ? ` — did you mean "${near.phrase}"?` : '') + (offline ? '' : ' — add a Gemini key to understand free-form requests') });
    }).catch((e) => onStatus({ state: 'error', text, message: (e && e.message) || String(e) }));
  };

  const build = () => {
    const r = new SR();
    r.lang = lang; r.continuous = true; r.interimResults = false;
    r.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) handle(ev.results[i][0].transcript);
    };
    r.onerror = (ev) => {
      if (ev.error === 'no-speech' || ev.error === 'aborted') return;   // routine; onend restarts
      wantOn = false;
      onStatus({ state: 'error', message: ev.error === 'not-allowed' ? 'Microphone permission denied' : `Voice error: ${ev.error}` });
    };
    // Chrome ends a continuous session after silence; restart while the user still wants it on.
    r.onend = () => {
      if (wantOn) { try { r.start(); return; } catch (e) { wantOn = false; } }
      api.listening = false; onStatus({ state: 'idle' });
    };
    return r;
  };

  /* Offline: ask the browser for its on-device recogniser (Chrome's processLocally), downloading the
     language pack once if needed. Returns true only when it's really local. Browsers without the
     API (or without the pack) use their normal recogniser — which may use the network — and we say so. */
  const prepLocal = async () => {
    if (!offline || typeof SR.available !== 'function') return false;
    try {
      const o = { langs: [lang], processLocally: true };
      let st = await SR.available(o);
      if (st === 'downloadable' || st === 'downloading') {
        onStatus({ state: 'thinking', message: 'Downloading the offline speech pack (one time)…' });
        if (typeof SR.install !== 'function' || !(await SR.install(o))) return false;
        st = 'available';
      }
      return st === 'available';
    } catch (e) { return false; }
  };
  const begin = (local) => {
    if (!wantOn) return;   // stopped while the pack was downloading
    rec = build();
    if (local) rec.processLocally = true;
    try {
      rec.start(); api.listening = true; api.local = !!local;
      onStatus({ state: 'listening', local: !!local, message: local ? 'Listening… (on-device)' : offline ? 'Listening… (this browser can\'t recognise speech on-device — it may use the network)' : 'Listening…' });
    } catch (e) { wantOn = false; onStatus({ state: 'error', message: e.message }); }
  };
  api.start = () => {
    if (wantOn) return;
    wantOn = true;
    if (offline && typeof SR.available === 'function') prepLocal().then(begin); else begin(false);
  };
  api.stop = () => { wantOn = false; api.listening = false; if (rec) { try { rec.stop(); } catch (e) { } } onStatus({ state: 'idle' }); };
  api.toggle = () => (wantOn ? api.stop() : api.start());
  api.destroy = api.stop;
  return api;
}
