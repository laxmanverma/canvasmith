/* Searchable Google Fonts catalog. A bundled list of popular families (name + category) so the font
   picker can offer search and live previews with no API key and no network call until the user looks.
   The list is a curated subset — any other family can still be added by exact name via addGoogleFont().
   Previews load lazily: one stylesheet per page of results, subset (`&text=`) to just the family
   names, so browsing costs a few KB per page rather than whole font files. */

const RAW = {
  'sans-serif': 'Roboto|Open Sans|Noto Sans|Montserrat|Lato|Poppins|Inter|Source Sans 3|Raleway|Nunito|Nunito Sans|Ubuntu|Rubik|Work Sans|Mulish|PT Sans|Fira Sans|Quicksand|Barlow|Karla|DM Sans|Manrope|Josefin Sans|Heebo|Cabin|Oxygen|Hind|Titillium Web|Assistant|Libre Franklin|Archivo|Public Sans|Outfit|Plus Jakarta Sans|Lexend|Figtree|Sora|Space Grotesk|Urbanist|Red Hat Display|Red Hat Text|IBM Plex Sans|Overpass|Exo 2|Catamaran|Asap|Varela Round|Signika|Maven Pro|Dosis|Questrial|Jost|Be Vietnam Pro|Albert Sans|Epilogue|Onest|Instrument Sans|Schibsted Grotesk|Bricolage Grotesque|Hanken Grotesk|Geologica|Gabarito|Readex Pro|Kanit|Prompt|Sarabun|Mukta|Noto Sans JP|Noto Sans KR|Noto Sans SC|Cairo|Tajawal|M PLUS Rounded 1c|Comfortaa|Nobile|Yantramanav|Abel|Anton|Bebas Neue|Oswald|Fjalla One|Archivo Narrow|Pathway Gothic One|Teko|Saira|Chakra Petch|Orbitron|Rajdhani|Russo One|Staatliches|Alfa Slab One|Passion One|Righteous|Concert One|Fredoka|Baloo 2|Lilita One|Bangers|Luckiest Guy|Titan One|Chewy|Paytone One|Secular One|Black Ops One|Bungee|Monoton|Press Start 2P|Silkscreen|VT323',
  'serif': 'Playfair Display|Merriweather|Lora|PT Serif|Noto Serif|Roboto Serif|Source Serif 4|Libre Baskerville|Crimson Text|Crimson Pro|EB Garamond|Cormorant Garamond|Cormorant|Bitter|Domine|Cardo|Vollkorn|Spectral|Alegreya|Arvo|Zilla Slab|Slabo 27px|Roboto Slab|Josefin Slab|Rokkitt|Old Standard TT|Libre Caslon Text|Frank Ruhl Libre|DM Serif Display|DM Serif Text|Abril Fatface|Bodoni Moda|Cinzel|Cinzel Decorative|Gloock|Fraunces|Newsreader|Literata|Gelasio|Noticia Text|Neuton|Prata|Rufina|Yeseva One|Marcellus|Unna|Taviraj|Young Serif|Instrument Serif|IBM Plex Serif|Playfair Display SC|Ultra|Rozha One|Special Elite',
  'display': 'Lobster|Pacifico|Satisfy|Great Vibes|Cookie|Sacramento|Kaushan Script|Shadows Into Light|Amatic SC|Permanent Marker|Caveat|Dancing Script|Indie Flower|Courgette|Yellowtail|Allura|Alex Brush|Parisienne|Tangerine|Marck Script|Gloria Hallelujah|Patrick Hand|Architects Daughter|Covered By Your Grace|Rock Salt|Reenie Beanie|Homemade Apple|Nothing You Could Do|Handlee|Kalam|Caveat Brush|Merienda|Sriracha|Pangolin|Bad Script|Cherry Cream Soda|Fugaz One|Faster One|Rubik Mono One|Rubik Glitch|Eater|Creepster|Nosifer|Metal Mania|Pirata One|UnifrakturCook|Fruktur|Londrina Solid|Gochi Hand|Chelsea Market|Frijole|Bungee Shade|Bungee Inline|Fascinate|Emilys Candy|Modak|Spicy Rice|Sigmar One|Shrikhand|Playwrite US Trad|Mynerve|Yuji Syuku',
  'monospace': 'Roboto Mono|Source Code Pro|Fira Code|Fira Mono|JetBrains Mono|IBM Plex Mono|Space Mono|Inconsolata|Ubuntu Mono|PT Mono|Courier Prime|Cousine|Overpass Mono|DM Mono|Red Hat Mono|Anonymous Pro|Share Tech Mono|Major Mono Display|Nova Mono|Oxygen Mono|Cutive Mono|Azeret Mono|Martian Mono|Geist Mono|Sometype Mono|B612 Mono',
};

export const GOOGLE_FONT_CATEGORIES = ['all', 'sans-serif', 'serif', 'display', 'monospace'];

export const GOOGLE_FONT_CATALOG = (() => {
  const seen = new Set(), out = [];
  for (const cat of Object.keys(RAW)) for (const name of RAW[cat].split('|')) {
    if (!seen.has(name)) { seen.add(name); out.push({ name, category: cat }); }
  }
  return out;
})();

/* Case-insensitive search by name. Prefix matches rank above substring matches; `category` narrows
   to one group ('all' or omitted for everything). An empty query lists the catalog in its curated
   (roughly popularity) order. */
export function searchGoogleFonts(query = '', category = 'all', limit = 40) {
  const q = String(query).trim().toLowerCase();
  const pool = category && category !== 'all' ? GOOGLE_FONT_CATALOG.filter(f => f.category === category) : GOOGLE_FONT_CATALOG;
  if (!q) return pool.slice(0, limit);
  const starts = [], has = [];
  for (const f of pool) {
    const n = f.name.toLowerCase();
    if (n.startsWith(q) || n.split(' ').some(w => w.startsWith(q))) starts.push(f);
    else if (n.includes(q)) has.push(f);
  }
  return starts.concat(has).slice(0, limit);
}

const previewed = new Set();

/* Loads tiny glyph-subset previews so each result row can render in its own face. Resolves when the
   stylesheet settles; never rejects (offline just leaves the fallback face). */
export function loadFontPreviews(names) {
  if (typeof document === 'undefined') return Promise.resolve();
  const todo = [...new Set(names)].filter(n => !previewed.has(n) && /^[A-Za-z0-9 ]{2,60}$/.test(n));
  if (!todo.length) return Promise.resolve();
  todo.forEach(n => previewed.add(n));
  const text = [...new Set(todo.join('') + 'Ag')].join('');
  const href = 'https://fonts.googleapis.com/css2?' + todo.map(n => 'family=' + n.replace(/ /g, '+')).join('&') +
    '&text=' + encodeURIComponent(text) + '&display=swap';
  return new Promise(resolve => {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.dataset.cmFontPreview = '1';
    l.onload = l.onerror = () => resolve();
    document.head.appendChild(l);
  });
}
