// The pure model behind the editor's drag-to-reorder. No DOM in here, so it is
// unit-testable on its own -- the same split bookSHelf uses between
// shared/pageMove.ts (pure, tested) and main/pageMoveEditor.ts (pointers).
//
// A syllabus is a flat list of blocks, and a SECTION is a heading plus every
// block up to the next heading. That grouping is the whole reason this is not a
// generic list sorter: dragging "Late work" has to carry the paragraphs under
// it, and the same grouping is what functions/_lib/syllabus.js hashes a
// signature against. The two definitions must agree.

/** Half-open [from, to) range a drag starting at `index` carries. */
export function dragRange(blocks, index) {
  if (blocks[index]?.type !== 'heading') return [index, index + 1];
  let end = index + 1;
  while (end < blocks.length && blocks[end].type !== 'heading') end++;
  return [index, end];
}

/** Insertion index from the pointer's Y: before the first row whose vertical
 *  midpoint is still below y; append past the last. y exactly on a midpoint
 *  resolves AFTER that row, which keeps the target stable while hovering.
 *  Verbatim from bookSHelf shared/pageMove.ts. */
export function insertionIndex(y, bands) {
  for (let i = 0; i < bands.length; i++) {
    if (y < (bands[i].top + bands[i].bottom) / 2) return i;
  }
  return bands.length;
}

/** First index of the unit ending at `from - 1`: the previous section's
 *  heading, or 0 when there is no heading above it. */
export function unitStartBefore(blocks, from) {
  let i = from - 1;
  while (i > 0 && blocks[i].type !== 'heading') i--;
  return i;
}

// The section split moved to shared/sections.js when the signing page started
// paging by section too. Re-exported so this module still reads as the editor's
// complete model, but there is exactly one definition and it is over there.
export { sectionRanges } from '../../shared/sections.js';
import { sectionRanges } from '../../shared/sections.js';

const PROMPT_TYPES = new Set(['initial', 'agree']);
// The vocabulary the AI pass answers in. 'subheading' is not a stored type --
// it is a heading at level 3 -- but it is a distinct ANSWER, because the two
// differ in whether they split a section, which is what a parent signs.
const RETAGGABLE = new Set(['text', 'heading', 'subheading']);

/** Storage shape for one of those answers. */
function shapeFor(tag, words) {
  if (tag === 'heading') return { type: 'heading', level: 2, html: `<h2>${escapeHtml(words)}</h2>` };
  if (tag === 'subheading') return { type: 'heading', level: 3, html: `<h3>${escapeHtml(words)}</h3>` };
  return { type: 'text', level: 2, html: `<p>${escapeHtml(words)}</p>` };
}

/** What tag a stored block already has, in that same vocabulary. */
const tagOf = (b) => (b.type === 'heading' ? (Number(b.level ?? 2) === 3 ? 'subheading' : 'heading') : b.type);

/** Visible words of a block, with markup removed. */
export function blockText(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Apply {index, tag} changes from the structure pass.
 *
 * The one guarantee this has to keep: the WORDS never change. Only the tag
 * around them does. That is the whole reason a model is allowed near the import
 * at all -- the text is what a parent legally initials, so a pass that could
 * reword it would be unusable regardless of how good the model is.
 *
 * Prompts, lists and tables are never retagged, even if asked: an `initial`
 * block carries a signature obligation, and turning one into a heading would
 * quietly drop that obligation from the document.
 */
export function retag(blocks, changes) {
  const want = new Map((changes ?? [])
    .filter((c) => RETAGGABLE.has(c?.tag))
    .map((c) => [Number(c.index), c.tag]));

  return blocks.map((block, i) => {
    const tag = want.get(i);
    const was = tagOf(block);
    if (!tag || tag === was || !RETAGGABLE.has(was)) return block;
    const words = blockText(block.html);
    if (!words) return block;
    return { ...block, ...shapeFor(tag, words) };
  });
}

/** Does this section already ask for initials? */
export function sectionSigns(blocks, from, to) {
  return blocks.slice(from, to).some((b) => PROMPT_TYPES.has(b.type));
}

/**
 * Turn a section's initials requirement on or off, returning a new array.
 *
 * Requiring initials is a SECTION decision, never a per-line one: a parent
 * initialing "I have read the late work policy" is attesting to the whole
 * section, which is exactly what attestationHash() covers. Offering it per
 * paragraph would let a stray line be marked and produce a prompt attesting to
 * a section nobody meant to bound.
 *
 * Turning it ON appends a prompt at the END of the section rather than
 * converting a paragraph into one -- the policy text has to survive, because
 * the prompt is an attestation ABOUT it, not a replacement for it.
 */
export function toggleSigning(blocks, from, to) {
  if (sectionSigns(blocks, from, to)) {
    return blocks.filter((b, i) => !(i >= from && i < to && PROMPT_TYPES.has(b.type)));
  }
  // Only a real heading names the prompt. Reading blocks[from] unconditionally
  // would put the first PARAGRAPH's text in there for a headless run, giving
  // "I have read and understand the assignments turned in after... policy."
  const head = blocks[from]?.type === 'heading'
    ? String(blocks[from].html).replace(/<[^>]+>/g, '').trim().toLowerCase()
    : '';
  const prompt = {
    type: 'initial',
    html: head
      ? `I have read and understand the ${head} policy.`
      : 'I have read and understand this section.',
  };
  return [...blocks.slice(0, to), prompt, ...blocks.slice(to)];
}

/**
 * Does this document's heading structure look wrong on arrival?
 *
 * Cheap and deterministic -- no model involved. It only decides whether to OFFER
 * the AI pass, so a false positive costs a dismissible notice and a false
 * negative costs nothing (the toolbar button is always there).
 *
 * Three shapes, because both import paths fail in opposite directions:
 *
 *   - No headings at all. A .docx whose author bolded lines instead of using
 *     heading styles arrives as one flat run.
 *   - One section swallowing most of the document -- the same problem with a
 *     single title on top.
 *   - TOO MANY headings. textToBlocks() guesses that "a short line with no
 *     terminal punctuation" is a heading, which promotes "Instructor: Steven
 *     Huff" and "Email: someone@school.edu" right along with "Late Work". A
 *     pasted syllabus routinely comes out more than half headings.
 *
 * All three break section dragging and section-level initials, which is the
 * symptom a teacher would otherwise have to diagnose alone.
 */
export function looksUnstructured(blocks) {
  return structureProblem(blocks) !== null;
}

/**
 * Which of the three problems this is, or null. Separate from the boolean so the
 * notice can describe what actually happened -- telling a teacher their document
 * "arrived without headings" when it in fact arrived with too many is worse than
 * saying nothing, because they will go looking for the wrong thing.
 */
export function structureProblem(blocks) {
  if (blocks.length < 6) return null;                        // too short to tell
  const headings = blocks.filter((b) => b.type === 'heading').length;
  if (headings === 0) return 'none';
  if (headings > blocks.length * 0.4) return 'too-many';
  const biggest = Math.max(...sectionRanges(blocks).map(([from, to]) => to - from));
  return biggest > blocks.length * 0.6 ? 'lopsided' : null;
}

/** One sentence naming the problem and what the fix does about it. */
export function structureAdvice(problem) {
  const fix = ' "Fix headings" retags them for you; your wording is never changed.';
  if (problem === 'none') {
    return 'This came in with no headings, so the whole thing is one block —'
      + ' nothing can be dragged or marked for initials as a section yet.' + fix;
  }
  if (problem === 'too-many') {
    return 'Lines like "Instructor: …" and "Email: …" were read as headings, so the sections'
      + ' are split in the wrong places.' + fix;
  }
  if (problem === 'lopsided') {
    return 'Almost everything landed under one heading, so there is really only one section.' + fix;
  }
  return '';
}

/**
 * What a press picks up.
 *
 * `from` is the start of the section pressed in; `rowIndex` is the block row
 * under the pointer, or null when the press landed on the card's own padding.
 * Mirrors bookSHelf's pageMoveTarget, which resolves a click to the innermost
 * movable unit rather than to whatever element happened to be hit.
 *
 * A heading has no independent existence -- moving it moves its section -- so
 * pressing one picks up the section, not a lone row. Blocks before the first
 * heading belong to no section, so pressing that card's padding picks up
 * nothing rather than inventing a headless section to drag.
 */
export function pickTarget(blocks, from, rowIndex) {
  const headed = blocks[from]?.type === 'heading';
  if (rowIndex === null || (headed && rowIndex === from)) {
    return headed ? { kind: 'section', at: from } : null;
  }
  return { kind: 'block', at: rowIndex };
}

/**
 * Where a section drag lands, given the slot it was dropped into among the
 * sections that remain. Returns an index among the blocks that are NOT moving,
 * ready for moveRange().
 *
 * A section is dropped BETWEEN whole sections -- never into the middle of one.
 * That falls out of the drag offering only section cards as targets, and this
 * function preserves it: every value it returns is a section start (or the end
 * of the document). It matters more here than in bookSHelf, where the same rule
 * is tidiness: in a syllabus the section is the unit a signature attests to, so
 * splitting one changes what an already-initialed prompt covers.
 */
export function sectionDest(blocks, from, to, slot) {
  const remaining = sectionRanges(blocks).filter(([start]) => start !== from);
  const len = to - from;
  if (slot >= remaining.length) return blocks.length - len;
  const startsAt = remaining[slot][0];
  return startsAt > from ? startsAt - len : startsAt;
}

/**
 * Move [from, to) so it lands before position `dest`, where `dest` counts among
 * the blocks that are NOT moving. Returns a new array, or null when that is
 * where the range already sits (so callers can skip a pointless re-render and
 * a spurious dirty flag).
 */
export function moveRange(blocks, from, to, dest) {
  if (dest === from) return null;
  const moving = blocks.slice(from, to);
  const rest = blocks.filter((_, i) => i < from || i >= to);
  return [...rest.slice(0, dest), ...moving, ...rest.slice(dest)];
}

/**
 * Where Alt+Arrow sends the block at `index`: a heading steps over a whole
 * neighbouring section rather than burrowing into it, a lone block steps over
 * one block. Returns {from, to, dest} or null at the ends of the list.
 */
export function keyDestination(blocks, index, dir) {
  const [from, to] = dragRange(blocks, index);
  const isSection = blocks[index]?.type === 'heading';
  if (dir < 0) {
    if (from === 0) return null;
    return { from, to, dest: isSection ? unitStartBefore(blocks, from) : from - 1 };
  }
  if (to >= blocks.length) return null;
  // `dest` counts among the non-moving blocks, so landing after the next unit
  // is just `from` plus that unit's length.
  const nextLen = isSection ? dragRange(blocks, to)[1] - to : 1;
  return { from, to, dest: from + nextLen };
}
