/* Command-palette ranking, shared by both shells. It was a plain substring test in list order, so
   "cta" put "Rectangular marquee" and "Rectangle" (re-cta-ngle) above "Add CTA button" and Enter
   picked a tool, and "flip h" matched nothing. Each typed word must match somewhere; a match at the
   start of a word beats one inside a word, and the label beats the group name. */
export function rankCommands(items, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.slice();
  const score = (it) => {
    const label = String(it.label || '').toLowerCase(), group = String(it.group || '').toLowerCase();
    let total = 0;
    for (const w of words) {
      const re = new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const word = new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])');
      if (label === w) total += 100;
      else if (word.test(label)) total += 70;   // a whole word: "cta" in "Add CTA button"
      else if (label.startsWith(w)) total += 60 - Math.min(20, label.length - w.length) / 2;   // shorter labels first: Rectangle before Rectangular marquee
      else if (re.test(label)) total += 40;
      else if (label.includes(w)) total += 10;
      else if (group.startsWith(w)) total += 8;
      else if (group.includes(w)) total += 3;
      else return -1;   // every word has to match
    }
    return total;
  };
  return items.map((it, i) => ({ it, i, s: score(it) })).filter(x => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.it);
}
