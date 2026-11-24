/* Modal-dialog behaviour the browser doesn't give a plain <div>: focus moves INTO the dialog when it opens, Tab /
   Shift+Tab cycle among the dialog's own controls (never out to the page behind it), and closing hands focus back
   to whatever opened it. Shells add role="dialog" aria-modal="true" aria-labelledby=... themselves.

   trapDialog(el, { initial }) returns release(), which removes the trap and restores focus. `initial` is a
   selector (or element) to focus first; otherwise the first focusable control. */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);

export function focusableIn(el) { return [...el.querySelectorAll(FOCUSABLE)].filter(visible); }

export function trapDialog(el, { initial } = {}) {
  if (!el) return () => {};
  const opener = document.activeElement;
  const first = (typeof initial === 'string' ? el.querySelector(initial) : initial) || focusableIn(el)[0];
  if (first && first.focus) first.focus({ preventScroll: true });
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = focusableIn(el);
    if (!items.length) { e.preventDefault(); return; }
    const a = document.activeElement, i = items.indexOf(a);
    if (i === -1 || !el.contains(a)) { e.preventDefault(); items[e.shiftKey ? items.length - 1 : 0].focus(); return; }
    if (e.shiftKey && i === 0) { e.preventDefault(); items[items.length - 1].focus(); }
    else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  return () => {
    document.removeEventListener('keydown', onKey, true);
    if (opener && opener.isConnected && opener.focus) { try { opener.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  };
}
