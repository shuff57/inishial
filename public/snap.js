// Force imported content onto the ruled lines.
//
// Everything the app writes itself is already on the grid: line-heights are
// --rule, margins are multiples of it. Imported .docx content is not the app's
// to control. Mammoth emits semantic HTML, and the importer passes a <ul> or a
// <table> through as outerHTML, so whatever the teacher's document contained
// arrives intact -- including the things that do not measure in whole rules:
//
//   - an image, at whatever pixel height the original had
//   - <sup>/<sub>, which grow the line box past its line-height
//   - a nested list, or a table with its own borders
//   - anything a future importer decides to keep
//
// A stylesheet cannot fix that, because the correction depends on a height only
// the browser knows. So it is measured: round each block up to the next whole
// rule with a bottom margin. Content already aligned gets 0px and is untouched,
// which is the normal case -- this is a net, not a layout engine.
//
// Blocks, not the whole sheet: snapping only at the bottom would leave every
// line after a tall image half a rule out for the rest of the page.

const EPSILON = 0.5;   // sub-pixel layout noise, not real drift

/**
 * How much to add to `height` to reach the next whole rule. 0 when it already
 * lands on one, within a sub-pixel tolerance.
 *
 * Split out from the DOM walk so the arithmetic is testable without a browser:
 * fractional heights, a height already on the rule, and a height a hair under
 * one are all cases that produce a visible bug and none of them need layout.
 */
export function gapToNextRule(height, rule) {
  if (!(rule > 0) || !(height > 0)) return 0;
  const over = height % rule;
  // Both ends: a height of 63.9 must round UP to 64, not add 0.1 to reach 64
  // and then a whole rule of blank paper on the next pass.
  if (over < EPSILON || rule - over < EPSILON) return 0;
  // Rounded, because `32 - (64.6 % 32)` is 31.400000000000006 in binary
  // floating point. Two decimals is far below anything a browser can render --
  // it quantises to 1/64px -- and it keeps this a value worth asserting on.
  return Math.round((rule - over) * 100) / 100;
}

/**
 * Round every child of `host` up to a whole number of rules.
 *
 * The correction is a MARGIN, added to whatever margin the element already
 * carries. Padding was the first attempt and silently did nothing in the case
 * that matters most: with `box-sizing: border-box`, padding sits INSIDE the
 * declared height, so an <img> with a height attribute -- the exact thing a
 * .docx brings in -- absorbed the correction and did not grow. A margin is
 * outside the box either way.
 */
export function snapToRules(host) {
  if (!host) return;
  const rule = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rule'));
  if (!(rule > 0)) return;

  for (const sheet of host.querySelectorAll('.sheet')) {
    for (const el of sheet.children) {
      // Clear first, then read. This runs again on resize, and measuring an
      // element still carrying the last correction would compound it every
      // time the window moved.
      el.style.marginBottom = '';
      const gap = gapToNextRule(el.getBoundingClientRect().height, rule);
      if (!gap) continue;
      const own = parseFloat(getComputedStyle(el).marginBottom) || 0;
      el.style.marginBottom = `${own + gap}px`;
    }
  }
}

/**
 * Snap now, and again whenever the measurement could have changed.
 *
 * Three triggers, each for a real case:
 *   - fonts.ready  -- the first measurement can happen in a fallback face whose
 *                     metrics differ from the webfont's
 *   - resize       -- an image capped by max-width changes height with the
 *                     column, and so does any block that rewraps
 *   - load on img  -- a data-URI image from a .docx has no height until it
 *                     decodes, and measuring at zero would snap to nothing
 *
 * Returns a function that stops listening.
 */
export function keepSnapped(host) {
  let frame = 0;
  const run = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => snapToRules(host));
  };

  run();
  document.fonts?.ready.then(run);
  addEventListener('resize', run);
  for (const img of host.querySelectorAll('img')) {
    if (!img.complete) img.addEventListener('load', run, { once: true });
  }

  return () => { cancelAnimationFrame(frame); removeEventListener('resize', run); };
}
