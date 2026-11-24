/* User-added fonts: any Google Fonts family by name, or a font file (.ttf/.otf/.woff/.woff2) from
   disk. Both register into a "My fonts" group appended to FONT_GROUPS, so every font picker (and
   fontCss()) sees them with no extra wiring. Google families are remembered across sessions in
   localStorage (just the names — the browser re-fetches them); uploaded files live for the session
   only, since a document referencing one still opens, falling back to the generic family. */
import { FONT_GROUPS } from './shapes.js';

const GROUP_LABEL = 'My fonts';
const STORE_KEY = 'canvasmith.fonts';
const FILE_RE = /\.(ttf|otf|woff2?)$/i;

const quote = (name) => (/^[\w-]+$/.test(name) ? name : `"${name}"`);

function group() {
  let g = FONT_GROUPS.find(x => x.label === GROUP_LABEL);
  if (!g) { g = { label: GROUP_LABEL, fonts: [] }; FONT_GROUPS.push(g); }
  return g;
}
function register(label, css) {
  const g = group();
  if (!g.fonts.some(([l]) => l.toLowerCase() === label.toLowerCase())) g.fonts.push([label, css]);
  return css;
}
const readStore = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch (e) { return []; } };
function remember(name) {
  try {
    const all = readStore();
    if (!all.some(n => n.toLowerCase() === name.toLowerCase())) localStorage.setItem(STORE_KEY, JSON.stringify([...all, name]));
  } catch (e) { /* storage blocked — the font still works for this session */ }
}
async function waitLoaded(spec) {
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return [];
  return Promise.race([document.fonts.load(spec), new Promise(r => setTimeout(() => r(null), 6000))]);
}

/* Loads a Google Fonts family by display name ("Space Grotesk") and returns its CSS font-family
   string. Rejects when Google has no such family, so a typo never lands in the picker. */
export async function addGoogleFont(name) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9 ]{2,60}$/.test(name)) throw new Error('Enter a Google Fonts family name, e.g. "Space Grotesk"');
  const css = `${quote(name)}, sans-serif`;
  const existing = group().fonts.find(([l]) => l.toLowerCase() === name.toLowerCase());
  if (existing) return existing[1];
  const href = 'https://fonts.googleapis.com/css2?family=' + name.replace(/ /g, '+') + ':ital,wght@0,400;0,700;1,400;1,700&display=swap';
  const plain = 'https://fonts.googleapis.com/css2?family=' + name.replace(/ /g, '+') + '&display=swap';
  // Not every family has italic/bold axes (the first URL 400s then) — retry with the bare request.
  const link = await new Promise((resolve, reject) => {
    const tryLoad = (url, fallback) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = url; l.dataset.cmUserFont = name;
      l.onload = () => resolve(l);
      l.onerror = () => { l.remove(); fallback ? tryLoad(fallback) : reject(new Error(`"${name}" was not found on Google Fonts`)); };
      document.head.appendChild(l);
    };
    tryLoad(href, plain);
  });
  const faces = await waitLoaded(`16px ${quote(name)}`);
  if (faces && !faces.length) { link.remove(); throw new Error(`"${name}" was not found on Google Fonts`); }
  remember(name);
  return register(name, css);
}

/* Registers a font file (File/Blob, or an ArrayBuffer with `name`). The picker label defaults to the
   file name without its extension. Returns the CSS font-family string. */
export async function addCustomFont(file, name) {
  const label = String(name || (file && file.name ? file.name.replace(/\.[^.]+$/, '') : '')).replace(/[-_]+/g, ' ').trim();
  if (!label) throw new Error('Give the font a name');
  if (file && file.name && !FILE_RE.test(file.name)) throw new Error('Use a .ttf, .otf, .woff or .woff2 file');
  const data = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const face = new FontFace(label, data);
  await face.load();   // rejects on a corrupt / unsupported file
  document.fonts.add(face);
  return register(label, `${quote(label)}, sans-serif`);
}

/* Re-adds the Google fonts remembered from earlier sessions. Safe to call once at startup; resolves
   when they've all settled (a font that's gone or offline is skipped, not fatal). */
export async function restoreUserFonts() {
  if (typeof document === 'undefined') return;
  await Promise.all(readStore().map(n => addGoogleFont(n).catch(() => {})));
}

/* Forgets a font added by addGoogleFont (picker entry + remembered name). Text already using it
   keeps rendering until reload. */
export function removeUserFont(label) {
  const g = group();
  g.fonts = g.fonts.filter(([l]) => l !== label);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(readStore().filter(n => n.toLowerCase() !== label.toLowerCase()))); } catch (e) { /* ignore */ }
  if (!g.fonts.length) FONT_GROUPS.splice(FONT_GROUPS.indexOf(g), 1);
}
