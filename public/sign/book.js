// Turning the syllabus a section at a time.
//
// The DOM is built by the signing page; this only decides which sheet is on top
// and animates getting to the next one. It never creates or destroys a sheet,
// so an initials box keeps its listeners and its typed value across a turn.
//
// Two rules it exists to keep:
//   - Every sheet stays in the DOM. Print, find-in-page and "read as one page"
//     must see the whole document, because the whole document is what a parent
//     is attesting to.
//   - Nothing here gates reading. You can turn past a section you have not
//     initialled; the progress spine is a count, not a lock.

import { sections, sectionTitle } from '../shared/sections.js';

export { sections, sectionTitle };

const EDGE_MAX = 26;      // px of visible stacked paper at the start
const COMMIT = 0.32;      // fraction of the sheet's width that commits a turn

export function createBook(host, { onTurn } = {}) {
  const sheets = [...host.querySelectorAll('.sheet')];
  if (sheets.length < 2) return null;   // one section is not a book

  const edge = document.createElement('div');
  edge.className = 'page-edge';
  edge.setAttribute('aria-hidden', 'true');   // the buttons are the real control
  host.appendChild(edge);

  let index = 0;
  let drag = null;

  /* Every sheet is as tall as the tallest one, so turning a page does not
     resize the notebook under the reader's hands. Measured while all sheets are
     still in normal flow -- once they are stacked with inset:0 they all report
     the container's height and the answer would be circular. */
  function equaliseHeight() {
    host.style.minHeight = '';
    delete host.dataset.paged;
    sheets.forEach((s) => { s.style.position = 'relative'; s.style.visibility = 'visible'; });
    const tallest = Math.max(...sheets.map((s) => s.getBoundingClientRect().height));
    sheets.forEach((s) => { s.style.position = ''; s.style.visibility = ''; });
    host.style.minHeight = `${Math.ceil(tallest)}px`;
  }

  const at = () => index;
  const count = () => sheets.length;

  function paint() {
    host.dataset.paged = '1';
    sheets.forEach((sheet, i) => {
      sheet.toggleAttribute('data-current', i === index);
      sheet.toggleAttribute('data-next', i === index + 1);
      // Sheets you cannot see must not hold focus, or Tab walks into a section
      // that is not on screen and the page appears to jump on its own.
      sheet.inert = i !== index;
      sheet.style.transform = '';
    });
    // The stack thins as you work through it -- the notebook shows how much is
    // left without anyone having to read a number.
    const left = sheets.length - 1 - index;
    edge.style.setProperty('--edge', `${Math.round(Math.min(EDGE_MAX, left * 5))}px`);
    edge.hidden = left === 0;
    onTurn?.(index, sheets.length);
  }

  function go(to, { animate = true } = {}) {
    const target = Math.max(0, Math.min(sheets.length - 1, to));
    if (target === index) return;
    const forward = target > index;
    const leaving = sheets[forward ? index : target];

    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      index = target; paint(); return;
    }

    // Turning FORWARD swings the current sheet away; turning BACK swings the
    // previous one home from where it went. Same sheet, opposite direction, so
    // going back undoes what you saw rather than inventing a new motion.
    index = target;
    paint();
    leaving.setAttribute('data-turning', '');
    leaving.setAttribute('data-settling', '');
    leaving.style.transform = forward ? 'rotateY(-96deg)' : 'rotateY(0deg)';
    if (!forward) {
      leaving.removeAttribute('data-settling');
      leaving.style.transform = 'rotateY(-96deg)';
      requestAnimationFrame(() => {
        leaving.setAttribute('data-settling', '');
        leaving.style.transform = 'rotateY(0deg)';
      });
    }
    const done = () => {
      leaving.removeAttribute('data-turning');
      leaving.removeAttribute('data-settling');
      leaving.style.transform = '';
      leaving.removeEventListener('transitionend', done);
    };
    leaving.addEventListener('transitionend', done);
    // transitionend does not fire if the sheet is display:none by then.
    setTimeout(done, 500);
  }

  // ---- dragging the edge ----

  edge.addEventListener('pointerdown', (event) => {
    if (index >= sheets.length - 1) return;
    drag = { x: event.clientX, width: sheets[index].getBoundingClientRect().width };
    edge.dataset.grabbing = '1';
    edge.setPointerCapture(event.pointerId);
    sheets[index].setAttribute('data-turning', '');
    sheets[index].removeAttribute('data-settling');
    event.preventDefault();
  });

  edge.addEventListener('pointermove', (event) => {
    if (!drag) return;
    // Pull LEFT to turn forward. Clamped at 0 so dragging the wrong way does
    // nothing rather than bending the sheet backwards off its hinge.
    const pulled = Math.max(0, drag.x - event.clientX);
    drag.fraction = Math.min(1, pulled / (drag.width * 0.8));
    sheets[index].style.transform = `rotateY(${-96 * drag.fraction}deg)`;
  });

  const release = (event) => {
    if (!drag) return;
    const { fraction = 0 } = drag;
    const sheet = sheets[index];
    drag = null;
    delete edge.dataset.grabbing;
    try { edge.releasePointerCapture(event.pointerId); } catch { /* already gone */ }

    if (fraction >= COMMIT) {
      sheet.setAttribute('data-settling', '');
      sheet.style.transform = 'rotateY(-96deg)';
      index += 1;
      paint();
      setTimeout(() => {
        sheet.removeAttribute('data-turning');
        sheet.removeAttribute('data-settling');
        sheet.style.transform = '';
      }, 420);
    } else {
      // Short of the threshold it falls back. Same sheet, no navigation.
      sheet.setAttribute('data-settling', '');
      sheet.style.transform = 'rotateY(0deg)';
      setTimeout(() => {
        sheet.removeAttribute('data-turning');
        sheet.removeAttribute('data-settling');
      }, 420);
    }
  };
  edge.addEventListener('pointerup', release);
  edge.addEventListener('pointercancel', release);

  // ---- keyboard ----
  //
  // On the document, not the edge: the edge is aria-hidden and never focused,
  // so binding there would make the arrows a mouse-only feature.
  addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
      || event.target.isContentEditable;
    if (typing) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { go(index + 1); event.preventDefault(); }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') { go(index - 1); event.preventDefault(); }
  });

  equaliseHeight();
  paint();
  // Re-measure when the sheets reflow: a narrower window wraps more lines, and
  // a stale height would either clip a section or leave a gap under it.
  if ('ResizeObserver' in window) {
    let width = host.getBoundingClientRect().width;
    new ResizeObserver(() => {
      const now = host.getBoundingClientRect().width;
      if (Math.abs(now - width) < 1) return;   // height changes are our own doing
      width = now;
      if (host.dataset.paged) { equaliseHeight(); paint(); }
    }).observe(host);
  }

  return {
    at, count, go,
    equaliseHeight,
    /** Drop back to one continuous document -- the reading mode for anyone who
     *  wants the whole thing at once, and what print uses. */
    unpage() {
      delete host.dataset.paged;
      host.style.minHeight = '';        // one continuous document sets its own
      sheets.forEach((s) => { s.inert = false; s.style.transform = ''; });
      edge.hidden = true;
    },
    repage() { edge.hidden = false; equaliseHeight(); paint(); },
    /** Bring a section on screen, e.g. after initialling elsewhere. */
    showSection(i) { go(i, { animate: false }); },
  };
}
