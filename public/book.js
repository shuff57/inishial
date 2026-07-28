// The syllabus, one section per page.
//
// A page is a MAJOR SECTION: a heading and everything under it until the next
// heading. That definition is shared/sections.js — the same one the editor drags
// by and the same one a signature is hashed against, so a page is exactly the
// span of text a parent initials. Nothing here decides what a section is; it
// only decides which one is on screen.
//
// No turn animation. A page turn built from CSS transforms can only pivot a
// rigid rectangle — it cannot bend paper — so it read as a flash rather than as
// a page. The lined paper and the page count carry the notebook instead.
//
// Two rules it keeps:
//   - Every sheet stays in the DOM, so print sees the whole document. The whole
//     document is what is being attested to.
//   - Nothing gates reading. You can page past a section you have not
//     initialled; the progress spine is a count, not a lock.

import { sections, sectionTitle } from './shared/sections.js';

export { sections, sectionTitle };

export function createBook(host, { onTurn } = {}) {
  const sheets = [...host.querySelectorAll('.sheet')];
  if (!sheets.length) return null;

  let index = 0;

  const at = () => index;
  const count = () => sheets.length;
  const clamp = (i) => Math.max(0, Math.min(sheets.length - 1, i));

  function place() {
    host.dataset.paged = '1';
    for (const [i, sheet] of sheets.entries()) {
      const on = i === index;
      sheet.hidden = !on;
      // A page you cannot see must not hold focus, or Tab walks into a section
      // that is off screen and the page appears to jump on its own.
      sheet.inert = !on;
    }
    onTurn?.(index, sheets.length);
  }

  function go(to) {
    const target = clamp(Math.round(to));
    if (target === index) return;
    index = target;
    place();
    toTop();
  }

  /** Every page starts at its first line.
   *
   *  scrollIntoView() was not enough: it aligns the element with the top of the
   *  VIEWPORT, and the nav and the progress spine are sticky over it, so the
   *  first line landed behind them -- and a page shorter than the last left the
   *  reader partway down anyway, because the document had shrunk beneath them.
   *  The syllabus title sits just above the page, so the top of the document is
   *  the top of the page. */
  function toTop() {
    scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }

  // Arrow keys, bound to the document rather than to a control: the buttons are
  // elsewhere in the page, so binding to one would make this pointer-only.
  //
  // Behind an AbortController because a book is rebuilt on every render -- once
  // per signature on the signing page, once per edit in the editor's preview.
  // Without destroy() each rebuild left the previous listener alive, still
  // holding a detached host whose dataset.paged is still set, so an arrow key
  // drove every book ever created.
  const stop = new AbortController();
  addEventListener('keydown', (event) => {
    if (event.defaultPrevented || !host.dataset.paged) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
      || event.target.isContentEditable;
    if (typing) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { go(index + 1); event.preventDefault(); }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') { go(index - 1); event.preventDefault(); }
  }, { signal: stop.signal });

  place();

  return {
    at, count, go,
    /** Release the key bindings. Call before building another book. */
    destroy() { stop.abort(); },
    /** Bring a section on screen, e.g. after re-rendering following a
     *  signature, so initialling does not send the reader back to page 1. */
    showSection(i) { index = clamp(i); place(); },
  };
}
