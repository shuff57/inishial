// The syllabus as an open notebook: two pages side by side, hinged down the
// middle, turned a spread at a time. Sections are laid out as a book is —
// 1|2, turn, 3|4.
//
// This only decides which sheets are on screen and animates getting to the next
// pair. It never creates or destroys a sheet, so an initials box keeps its
// listeners and its typed value across a turn.
//
// Two rules it exists to keep:
//   - Every sheet stays in the DOM. Print, find-in-page and "read as one page"
//     must see the whole document, because the whole document is what a parent
//     is attesting to.
//   - Nothing here gates reading. You can turn past a section you have not
//     initialled; the progress spine is a count, not a lock.

import { sections, sectionTitle } from './shared/sections.js';
import { foldLine, reflection, clipRect, polygon, clampPointer } from './fold.js';

export { sections, sectionTitle };

const SPREAD_MIN = 52 * 17;   // px; matches the @media breakpoint in app.css

export function createBook(host, { onTurn } = {}) {
  const sheets = [...host.querySelectorAll('.sheet')];
  if (!sheets.length) return null;

  let index = 0;          // index of the LEFT page of the current spread
  let turning = false;

  /** Two pages at a time when there is room, one when there is not. A spread on
   *  a phone is two unreadable columns, so the width decides the step. */
  const perSpread = () => (innerWidth >= SPREAD_MIN ? 2 : 1);
  const lastIndex = () => {
    const step = perSpread();
    return Math.max(0, Math.floor((sheets.length - 1) / step) * step);
  };

  const at = () => index;
  const count = () => sheets.length;

  function place() {
    host.dataset.paged = '1';
    const step = perSpread();
    for (const [i, sheet] of sheets.entries()) {
      const slot = i === index ? 'left' : (step === 2 && i === index + 1 ? 'right' : null);
      if (slot) sheet.setAttribute('data-slot', slot); else sheet.removeAttribute('data-slot');
      sheet.removeAttribute('data-beneath');
      // A page you cannot see must not hold focus, or Tab walks into a section
      // that is off screen and the notebook appears to jump on its own.
      sheet.inert = !slot;
      sheet.style.transform = '';
    }
    equaliseSpread();
    onTurn?.(index, sheets.length, step);
  }

  /* Both pages of a spread have to be the same height or the book is a
     staircase. So: a floor that still reads as a page, raised to fit whichever
     of the two is taller.
     Sizing every page in the DOCUMENT to the tallest was the first attempt and
     it was wrong -- real sections run 256px to 2592px, so a three-line section
     got 2300px of blank paper. This only equalises the two on screen. */
  const FLOOR = () => Math.round(Math.min(innerHeight * 0.62, 640));

  function equaliseSpread() {
    const step = perSpread();
    const shown = sheets.slice(index, index + step);
    for (const s of shown) s.style.minHeight = '';
    const tallest = Math.max(FLOOR(), ...shown.map((s) => s.getBoundingClientRect().height));
    for (const s of shown) s.style.minHeight = `${Math.ceil(tallest)}px`;
  }

  function go(to, { animate = true } = {}) {
    if (turning) return;
    const step = perSpread();
    const target = Math.max(0, Math.min(lastIndex(), Math.round(to / step) * step));
    if (target === index) return;

    const forward = target > index;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduced) { index = target; place(); return; }

    // The leaf that turns is the RIGHT page going forward, and the page that
    // was the right of the spread you are returning to coming back -- the same
    // physical leaf either way, which is what makes Back feel like undo rather
    // than a second, different animation.
    const leaf = forward
      ? sheets[index + (step === 2 ? 1 : 0)]
      : sheets[target + (step === 2 ? 1 : 0)];
    if (!leaf) { index = target; place(); return; }

    // Show the spread being turned TO, underneath, so the turn reveals the real
    // pages rather than blank paper.
    sheets.slice(target, target + step).forEach((s, n) => {
      if (s === leaf) return;
      s.setAttribute('data-beneath', n === 0 ? 'left' : 'right');
      s.inert = true;
    });

    turning = true;
    leaf.setAttribute('data-turning', '');
    if (forward) {
      leaf.setAttribute('data-settling', '');
      leaf.style.transform = 'rotateY(-172deg)';
    } else {
      leaf.style.transform = 'rotateY(-172deg)';
      requestAnimationFrame(() => {
        leaf.setAttribute('data-settling', '');
        leaf.style.transform = 'rotateY(0deg)';
      });
    }

    const finish = () => {
      leaf.removeEventListener('transitionend', finish);
      leaf.removeAttribute('data-turning');
      leaf.removeAttribute('data-settling');
      leaf.style.transform = '';
      turning = false;
      index = target;
      place();
    };
    leaf.addEventListener('transitionend', finish);
    // transitionend does not fire if the leaf is display:none by then.
    setTimeout(() => { if (turning) finish(); }, 640);
  }

  // ---- keyboard ----
  //
  // On the document, not a control: the buttons are elsewhere in the page, so
  // binding to one of them would make the arrows a pointer-only feature.
  addEventListener('keydown', (event) => {
    if (event.defaultPrevented || !host.dataset.paged) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
      || event.target.isContentEditable;
    if (typing) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { go(index + perSpread()); event.preventDefault(); }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') { go(index - perSpread()); event.preventDefault(); }
  });

  // ---- folding the corner ----
  //
  // Grab the outer corner of the right-hand page and it folds along the
  // perpendicular bisector between the corner and your finger, which is what
  // folding paper actually does: every point on the crease is the same distance
  // from both, so the corner lands exactly under the pointer.
  //
  // Three layers, because the flap is showing the REVERSE of the sheet:
  // the page clipped to everything behind the crease, whatever is underneath,
  // and a mirrored clone clipped to the part in front of it.
  const grip = document.createElement('div');
  grip.className = 'fold-grip';
  grip.setAttribute('aria-hidden', 'true');   // the buttons are the real control
  host.appendChild(grip);

  let flap = null;
  let crease = null;
  let peel = null;

  function rightPage() {
    return sheets.find((s) => s.dataset.slot === (perSpread() === 2 ? 'right' : 'left'));
  }

  function beginFold(page) {
    // A live clone: inert, so the copied initials boxes cannot take focus or be
    // typed into while they are lying on their back.
    const clone = page.cloneNode(true);
    clone.removeAttribute('data-slot');
    clone.removeAttribute('id');
    clone.classList.add('fold-face');
    clone.inert = true;
    flap = document.createElement('div');
    flap.className = 'fold-flap';
    flap.setAttribute('aria-hidden', 'true');
    flap.appendChild(clone);
    page.parentElement.appendChild(flap);

    // The crease shadow. StPageFlip's realism is four gradient layers rotated
    // onto the fold with opacity driven by progress -- the geometry is the same
    // clip-path polygon everyone ends up with, and the shadows are what make it
    // read as paper rather than as a shape. This is that idea, as one band:
    // dark at the crease, falling off both ways.
    crease = document.createElement('div');
    crease.className = 'fold-crease';
    crease.setAttribute('aria-hidden', 'true');
    page.parentElement.appendChild(crease);
    // The shadow band is deliberately longer than the page so it spans the
    // crease at any angle; clip it to the book, or it falls across the desk.
    host.dataset.folding = '1';
    const box = page.getBoundingClientRect();
    Object.assign(flap.style, {
      left: `${page.offsetLeft}px`, top: `${page.offsetTop}px`,
      width: `${box.width}px`, height: `${box.height}px`,
    });
    Object.assign(clone.style, { width: `${box.width}px`, height: `${box.height}px`, margin: '0' });
    return box;
  }

  function drawFold(page, box, pointer) {
    const corner = { x: box.width, y: box.height };
    const local = clampPointer(
      { x: pointer.x - box.left, y: pointer.y - box.top }, corner, box.width, box.height);
    const line = foldLine(corner, local);
    const m = reflection(line.mid, line.theta);
    page.style.clipPath = polygon(clipRect(box.width, box.height, corner, line, false));
    flap.style.clipPath = polygon(clipRect(box.width, box.height, corner, line, true));
    flap.style.transform = `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;

    // Lay the shadow band along the crease. Long enough to span the page
    // whatever angle the fold is at, and it deepens as the page lifts.
    const span = Math.hypot(box.width, box.height) * 2;
    const spread = 46;
    const progress = Math.min(1, line.length / Math.hypot(box.width, box.height));
    Object.assign(crease.style, {
      left: `${page.offsetLeft + line.mid.x - spread}px`,
      top: `${page.offsetTop + line.mid.y - span / 2}px`,
      width: `${spread * 2}px`,
      height: `${span}px`,
      opacity: String(0.25 + progress * 0.55),
      transform: `rotate(${line.theta - Math.PI / 2}rad)`,
    });
    return progress;
  }

  function endFold(page) {
    page.style.clipPath = '';
    delete host.dataset.folding;
    flap?.remove();
    crease?.remove();
    flap = null;
    crease = null;
    peel = null;
  }

  grip.addEventListener('pointerdown', (event) => {
    if (turning) return;
    const page = rightPage();
    if (!page || index + perSpread() >= sheets.length) return;
    const box = beginFold(page);
    peel = { page, box, fraction: 0 };
    grip.setPointerCapture(event.pointerId);
    grip.dataset.grabbing = '1';
    drawFold(page, box, { x: event.clientX, y: event.clientY });
    event.preventDefault();
  });

  grip.addEventListener('pointermove', (event) => {
    if (!peel) return;
    peel.fraction = drawFold(peel.page, peel.box, { x: event.clientX, y: event.clientY });
  });

  const releaseFold = (event) => {
    if (!peel) return;
    const { page, fraction } = peel;
    delete grip.dataset.grabbing;
    try { grip.releasePointerCapture(event.pointerId); } catch { /* gone */ }
    endFold(page);
    // Past halfway the page has committed to turning; short of it, it drops back.
    if (fraction > 0.5) go(index + perSpread());
  };
  grip.addEventListener('pointerup', releaseFold);
  grip.addEventListener('pointercancel', releaseFold);

  place();

  // A resize can turn one page into two, and rewraps every line either way.
  if ('ResizeObserver' in window) {
    let width = innerWidth;
    new ResizeObserver(() => {
      if (Math.abs(innerWidth - width) < 1) return;   // height changes are our own doing
      width = innerWidth;
      if (host.dataset.paged) { index = Math.min(index, lastIndex()); place(); }
    }).observe(document.documentElement);
  }

  return {
    at, count, go, perSpread,
    /** Drop back to one continuous document -- the reading mode for anyone who
     *  wants the whole thing at once, and what print uses. */
    unpage() {
      delete host.dataset.paged;
      sheets.forEach((s) => {
        s.inert = false;
        s.style.transform = '';
        s.style.minHeight = '';
        s.removeAttribute('data-slot');
        s.removeAttribute('data-beneath');
      });
    },
    repage() { place(); },
    /** Bring a section on screen, e.g. after initialling elsewhere. */
    showSection(i) {
      const step = perSpread();
      index = Math.max(0, Math.min(lastIndex(), Math.floor(i / step) * step));
      place();
    },
  };
}
