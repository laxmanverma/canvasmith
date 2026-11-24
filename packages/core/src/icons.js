/* Free icon library via Iconify (api.iconify.design): 200k+ open-licensed vector icons, no API key.
   We search only fill-based sets (Material Design Icons, Remix, Bootstrap, Phosphor, Material
   Symbols, Font Awesome Solid) so an icon recolours with the Fill swatch like any other shape —
   stroke-based sets (Lucide, Tabler…) would lose their lines when "fill" is applied. Licences of
   these sets are permissive (Apache-2.0 / MIT / CC-BY-4.0 for Font Awesome Free); see iconify.design. */

export const ICON_API = 'https://api.iconify.design';
export const ICON_PREFIXES = ['mdi', 'ri', 'bi', 'ph', 'material-symbols', 'fa6-solid'];
export const ICON_SUGGESTIONS = ['heart', 'star', 'arrow', 'home', 'user', 'camera', 'cart', 'phone', 'mail', 'music', 'location', 'gift', 'sun', 'leaf', 'fire', 'check', 'tag', 'bell'];

const ID_RE = /^[a-z0-9-]+:[a-z0-9-]+$/;
export const isIconId = (id) => ID_RE.test(String(id || ''));

/* Icon data is fetched in BATCHES (one request per icon set via Iconify's JSON endpoint) and the SVG
   is built locally — a 60-result search is ~3 requests, not 60, which keeps us well inside Iconify's
   rate limit. Cached for the page's lifetime. */
const cache = new Map();   // id -> { body, left, top, width, height }

async function loadIcons(ids, signal) {
  const need = ids.filter(id => !cache.has(id));
  const byPrefix = {};
  for (const id of need) { const [pre, name] = id.split(':'); (byPrefix[pre] = byPrefix[pre] || []).push(name); }
  await Promise.all(Object.entries(byPrefix).map(async ([pre, names]) => {
    const res = await fetch(`${ICON_API}/${pre}.json?icons=${names.join(',')}`, { signal });
    if (!res.ok) throw new Error('Could not load icons (' + res.status + ')');
    const d = await res.json();
    for (const name of names) {
      let ic = d.icons && d.icons[name];
      if (!ic && d.aliases && d.aliases[name]) {
        const al = d.aliases[name]; ic = d.icons && d.icons[al.parent];
        if (ic) ic = { ...ic, ...al };
      }
      if (ic && ic.body) cache.set(pre + ':' + name, { body: ic.body, left: ic.left || 0, top: ic.top || 0, width: ic.width || d.width || 16, height: ic.height || d.height || 16 });
    }
  }));
}

const svgOf = (ic, color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ic.left} ${ic.top} ${ic.width} ${ic.height}" width="${ic.width}" height="${ic.height}">${ic.body.replace(/currentColor/g, color)}</svg>`;

/* Thumbnail source (a data: URI, usable in a CSS mask so it takes the UI's text colour). Only valid for
   ids returned by searchIcons() — those are already loaded into the cache. */
export function iconUrl(id) {
  const ic = cache.get(id);
  return ic ? 'data:image/svg+xml,' + encodeURIComponent(svgOf(ic, '#000')) : '';
}

/* Search icon ids ("mdi:heart") by keyword; the icons' shapes are loaded alongside, so every returned
   id can be drawn immediately. [] for an empty query; rejects on network failure. */
export async function searchIcons(query, limit = 60, signal) {
  const q = String(query || '').trim();
  if (!q) return [];
  const res = await fetch(`${ICON_API}/search?query=${encodeURIComponent(q)}&limit=${limit}&prefixes=${ICON_PREFIXES.join(',')}`, { signal });
  if (!res.ok) throw new Error('Icon search failed (' + res.status + ')');
  const ids = ((await res.json()).icons || []).filter(isIconId);
  await loadIcons(ids, signal);
  return ids.filter(id => cache.has(id));
}

/* The icon's SVG markup, with its colour baked to `color` so it never depends on currentColor. */
export async function fetchIconSVG(id, color = '#111111') {
  if (!isIconId(id)) throw new Error('Not an icon id: ' + id);
  await loadIcons([id]);
  const ic = cache.get(id);
  if (!ic) throw new Error('Could not load that icon');
  return svgOf(ic, color);
}
