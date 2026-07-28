// The sign-here flags, defined once.
//
// Two things build them now: the signing page, and the editor's "as a parent
// sees it" preview. The whole point of that preview is to be the same thing a
// parent gets, so a second copy of this would be a preview that could quietly
// stop telling the truth -- the same reason the section split lives in
// shared/sections.js rather than in each consumer.
//
// Built from the rendered sheets rather than from blocks, so there is nothing
// here that has to agree separately about what a section is or which ones ask
// for something.

/**
 * One flag per section that asks for initials, inserted before `host`.
 *
 * `onPick(index)` is called with the page a flag points at. The caller owns
 * what that means -- turning the page on the signing side, turning the preview
 * in the editor -- so this module never needs to know about either.
 *
 * Returns [pageIndex, button] pairs so the caller can light the current one
 * without keeping a second idea of which page is showing.
 */
export function buildFlags(host, { onPick } = {}) {
  const sheets = [...host.querySelectorAll('.sheet')];
  const rail = document.createElement('nav');
  rail.className = 'flags';
  rail.setAttribute('aria-label', 'Sections needing initials');

  const flags = [];
  for (const [i, sheet] of sheets.entries()) {
    const prompts = [...sheet.querySelectorAll('.initial-box')];
    // Only sections that ask for something. A flag on every section was the
    // version before this, and the ones that wanted nothing were the loudest
    // thing on the page -- a marker means "here", and marking everywhere marks
    // nothing.
    if (!prompts.length) continue;

    const label = sheet.getAttribute('aria-label') || `Page ${i + 1}`;
    const done = prompts.every((p) => p.classList.contains('done'));

    const flag = document.createElement('button');
    flag.type = 'button';
    flag.textContent = label;
    // The visible label is clipped by CSS at this width, so the accessible
    // name carries the whole thing plus the state -- a screen reader must not
    // be handed "Academic Honesty and Use…" with no idea whether it is done.
    flag.title = `${label} — ${done ? 'initialled' : 'needs initials'}`;
    flag.setAttribute('aria-label', `${label}, page ${i + 1}, ${done ? 'initialled' : 'needs initials'}`);
    if (done) flag.dataset.signed = '1';
    flag.addEventListener('click', () => onPick?.(i));
    rail.appendChild(flag);
    flags.push([i, flag]);
  }

  // Nothing to sign: no rail at all, rather than an empty strip of nothing.
  if (!flags.length) return [];
  host.before(rail);
  return flags;
}

/** Drop any rail already on the page. It is a SIBLING of the book host, so
 *  emptying the host does not take it with it -- and without this every
 *  re-render leaves another strip of flags down the page. */
export const clearFlags = (root = document) => root.querySelector('.flags')?.remove();
