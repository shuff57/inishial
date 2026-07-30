// The pure model behind the editor's drag-to-reorder. No DOM in here, so it is
// unit-testable on its own -- the same split bookSHelf uses between
// shared/pageMove.ts (pure, tested) and main/pageMoveEditor.ts (pointers).
//
// A syllabus is a flat list of blocks, and a SECTION is a heading plus every
// block up to the next heading. That grouping is the whole reason this is not a
// generic list sorter: dragging "Late work" has to carry the paragraphs under
// it, and the same grouping is what functions/_lib/syllabus.js hashes a
// signature against. The two definitions must agree.

/** Half-open [from, to) range a drag starting at `index` carries.
 *
 *  Bounded by startsSection, NOT by `type === 'heading'`. Once subheadings
 *  existed, the second test stopped a drag at the first one -- so picking up
 *  "Grading Policy" carried the heading alone and left its four subsections and
 *  its initials prompt sitting where they were. A section has to move whole:
 *  it is the unit a signature is hashed against. */
export function dragRange(blocks, index) {
  if (!startsSection(blocks[index])) return [index, index + 1];
  let end = index + 1;
  while (end < blocks.length && !startsSection(blocks[end])) end++;
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
  while (i > 0 && !startsSection(blocks[i])) i--;
  return i;
}

// The section split moved to shared/sections.js when the signing page started
// paging by section too. Re-exported so this module still reads as the editor's
// complete model, but there is exactly one definition and it is over there.
export { sectionRanges, startsSection } from '../../shared/sections.js';
import { sectionRanges, startsSection } from '../../shared/sections.js';

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
 * Pasted plain text to blocks. One block per LINE, not one per blank-line
 * chunk.
 *
 * A pasted syllabus routinely puts a heading on one line and its body on the
 * very next, with no blank line between them. Splitting only on blank lines
 * glued the two into a single block, and the structure pass -- which tags whole
 * blocks, never parts of them -- read the heading at the front and promoted the
 * paragraph behind it along with it. One real paste came back as a
 * 549-character <h2>. Lines are also what that prompt says it is being handed.
 *
 * The heading guess applies to the FIRST line of a chunk only. A heading
 * introduces what follows it, so a later line in the same chunk is body text
 * until the structure pass says otherwise -- and it now can say otherwise,
 * because each line is a block it can retag on its own.
 */
export function textToBlocks(text) {
  const out = [];
  for (const chunk of String(text ?? '').split(/\n{2,}/)) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length;) {
      const line = lines[i];

      // ## Grading Policy -- a syllabus written in Markdown says outright what
      // is a section and what sits inside one, which is the question the AI
      // pass exists to guess at. Take the answer when it is offered: # and ##
      // start a section, ### and deeper are subheadings within it, matching
      // what the .docx importer does with Word's own outline levels.
      const hash = /^(#{1,6})\s+(.+)$/.exec(line);
      if (hash) {
        const level = hash[1].length <= 2 ? 2 : 3;
        out.push({ type: 'heading', level, html: `<h${level}>${inline(hash[2])}</h${level}>` });
        i++;
        continue;
      }

      // A rule between sections is a separator in the source, not content.
      if (/^([-*_])\1{2,}$/.test(line)) { i++; continue; }

      // | Category | Weight |   -- a Markdown table, recognised by its
      // |---|---|                  divider row and read to the end of the run.
      if (isRow(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const body = [];
        while (i < lines.length && isRow(lines[i])) body.push(cells(lines[i++]));
        out.push({ type: 'text', html: table(head, body) });
        continue;
      }

      // A run of consecutive bullets is one list, the way it reads on the page.
      // Numbered runs too: the course objectives are written 1..14, and as
      // separate paragraphs they lose the numbering the college catalogue uses.
      const marker = /^[-*•]\s+/.test(line) ? /^[-*•]\s+/ : (/^\d+[.)]\s+/.test(line) ? /^\d+[.)]\s+/ : null);
      if (marker) {
        const tag = marker.source.startsWith('^\\d') ? 'ol' : 'ul';
        const items = [];
        while (i < lines.length && marker.test(lines[i])) {
          items.push(`<li>${inline(lines[i++].replace(marker, ''))}</li>`);
        }
        out.push({ type: 'list', html: `<${tag}>${items.join('')}</${tag}>` });
        continue;
      }

      // A short line with no terminal punctuation reads as a heading.
      out.push(i === 0 && line.length < 60 && !/[.!?;:]$/.test(line)
        ? { type: 'heading', html: `<h2>${inline(line)}</h2>` }
        : { type: 'text', html: `<p>${inline(line)}</p>` });
      i++;
    }
  }
  return out;
}

const isRow = (line) => /^\|.*\|$/.test(line);
const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function table(head, body) {
  const row = (cs, tag) => `<tr>${cs.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`;
  return `<table><thead>${row(head, 'th')}</thead><tbody>${body.map((r) => row(r, 'td')).join('')}</tbody></table>`;
}

/** Escape first, then put back the few marks a syllabus actually uses.
 *
 *  Order matters: escaping turns any real markup in the source into text, so
 *  the tags added afterwards are the only ones in the result. A teacher pasting
 *  `<script>` gets the words, never the tag. */
function inline(s) {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

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
 * Set a per-block "the model thinks this should require initials" flag.
 *
 * A suggestion is a pointer, not a decision. The model is only ever allowed to
 * point -- see suggest.js:9-12 -- and the teacher is the one who decides. This
 * helper just stamps the pointer on the right blocks and returns a new array;
 * applying it is a separate step (see applyPendingSigning).
 *
 * Each candidate gets its own reason on its own block. A reason is a STRING,
 * not a value of the model -- the model returns it, but only the teacher
 * accepts it, and storing it on the block keeps the audit trail with the
 * block rather than in a side table that could lose sync on a re-render.
 */
export function setPendingSuggestions(blocks, suggestions) {
  const want = new Map();
  for (const s of suggestions ?? []) {
    const i = Number(s?.index);
    const reason = String(s?.reason ?? '').slice(0, 80);
    if (Number.isInteger(i) && i >= 0 && i < blocks.length) want.set(i, reason);
  }
  return blocks.map((b, i) => {
    const reason = want.get(i);
    if (reason === undefined) {
      // Clear any prior pending on this block when the model stops suggesting it.
      return b.pendingInitial ? { ...b, pendingInitial: undefined } : b;
    }
    return { ...b, pendingInitial: { reason } };
  });
}

/**
 * The next block index with a pending suggestion, or -1 when there is none.
 *
 * Forward-only. A teacher walks the list top to bottom, and rewinding would
 * make Accept All + a single Accept land back on a block they already saw.
 * The reason is a string (the model's words), not a number; the reason's
 * presence is the flag, which keeps the block's data flat.
 */
export function nextPendingIndex(blocks, from = 0) {
  for (let i = Math.max(0, from); i < blocks.length; i++) {
    if (blocks[i].pendingInitial) return i;
  }
  return -1;
}

/** First pending index across the whole document, or -1. */
export const firstPendingIndex = (blocks) => nextPendingIndex(blocks, 0);

/**
 * Apply the pending suggestion on a single section: mark the section as
 * requiring initials (if it doesn't already) and clear the pendings inside it.
 *
 * Returns { blocks, applied } where `applied` is true iff at least one
 * pending lived in the section. The caller uses that to know whether to
 * advance the walk-through cursor.
 *
 * toggleSigning is the canonical way to flip a section's sign, so the apply
 * path goes through it -- a single rule, single reason for what "initials
 * required" means. If the section already asks for initials, the pendings
 * still need to be cleared; the model pointed, the teacher did not act, and
 * "still want it" is the same as "got it, move on".
 */
export function applyPendingInSection(blocks, from, to) {
  const pendings = blocks.slice(from, to).filter((b) => b.pendingInitial);
  if (!pendings.length) return { blocks, applied: false };
  const cleared = blocks.map((b, i) =>
    i >= from && i < to && b.pendingInitial
      ? { ...b, pendingInitial: undefined }
      : b);
  return { blocks: sectionSigns(cleared, from, to) ? cleared : toggleSigning(cleared, from, to), applied: true };
}

/**
 * Apply every pending suggestion across the document. Idempotent: a section
 * with no pendings is left exactly as it was.
 *
 * Walks by SECTION, not by index. Iterating a fixed `ranges` once would be
 * wrong: every accepted section GROWS by one block (the new prompt), which
 * shifts every later section's [from, to) by one. The next step would be
 * checking the wrong span and leave the rest of the pendings stuck on.
 * Re-deriving the ranges from the live array at each step keeps the loop
 * honest at the cost of one O(n) walk per section, which is fine -- a
 * syllabus has dozens of sections, not thousands.
 */
export function applyAllPending(blocks) {
  let next = blocks;
  for (;;) {
    const ranges = sectionRanges(next);
    const target = ranges.find(([from, to]) =>
      next.slice(from, to).some((b) => b.pendingInitial));
    if (!target) return next;
    const r = applyPendingInSection(next, target[0], target[1]);
    next = r.blocks;
  }
}

/** Drop every pending suggestion without applying. */
export function clearAllPending(blocks) {
  return blocks.some((b) => b.pendingInitial)
    ? blocks.map((b) => b.pendingInitial ? { ...b, pendingInitial: undefined } : b)
    : blocks;
}

/** Drop pendings inside a single section, leaving the rest of the document
 *  alone. Used when the teacher dismisses a suggestion but wants the rest of
 *  the walk-through to keep going. */
export function clearPendingInSection(blocks, from, to) {
  const any = blocks.slice(from, to).some((b) => b.pendingInitial);
  if (!any) return blocks;
  return blocks.map((b, i) =>
    i >= from && i < to && b.pendingInitial
      ? { ...b, pendingInitial: undefined }
      : b);
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
  const fix = ' "Fix format" retags them for you; your wording is never changed.';
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
/** Where a SPAN of picked rows lands when nudged one line.
 *
 *  Deliberately not keyDestination's rule. That one hops a whole section at a
 *  time, because moving a section past half of another would tear it. A hand-
 *  picked span is not a section and carries no such promise: the teacher chose
 *  these rows, so it steps one line, which is the only way to walk a pair of
 *  lines up through a paragraph and stop in the middle of it. */
export function rangeDestination(blocks, from, to, dir) {
  if (dir < 0) return from === 0 ? null : { from, to, dest: from - 1 };
  return to >= blocks.length ? null : { from, to, dest: from + 1 };
}

/** One rung up or down the text -> subheading -> section ladder.
 *
 *  Returns the tag to move to, or null when there is no rung that way -- which
 *  includes every block that must not be retagged at all. A list or a table is
 *  stored as 'text', and retag() keeps only a block's WORDS, so laddering a
 *  weights table would flatten it into one run of numbers. A prompt is worse:
 *  it carries a signature obligation, and promoting it would drop that
 *  obligation out of the document without a trace. */
export function ladderTag(block, dir) {
  if (!block) return null;
  if (hasShape(block)) return null;
  const rungs = ['text', 'subheading', 'heading'];
  const at = rungs.indexOf(tagOf(block));
  if (at < 0) return null;
  return rungs[at + dir] ?? null;
}

/** A block whose meaning is in its SHAPE, not just its words.
 *
 *  A table is stored as a plain 'text' block -- the importer has always done it
 *  that way, and the signing page, the hash and the schema all read it as text.
 *  So "is this a table" is a question about the markup, not the type, and every
 *  operation that keeps only a block's words has to ask it first. */
export const hasShape = (b) => /<(table|ul|ol)[\s>]/i.test(String(b?.html ?? ''));
export const isTable = (b) => /<table[\s>]/i.test(String(b?.html ?? ''));

/** Bulleted <-> numbered. The course objectives import as a numbered run and
 *  the materials as bullets; either can arrive as the wrong one. */
export function toggleListKind(html) {
  const s = String(html ?? '');
  const [from, to] = /^\s*<ol[\s>]/i.test(s) ? ['ol', 'ul'] : ['ul', 'ol'];
  return s
    .replace(new RegExp(`^(\\s*)<${from}\\b`, 'i'), `$1<${to}`)
    .replace(new RegExp(`</${from}>(\\s*)$`, 'i'), `</${to}>$1`);
}

// Rows and cells of a table, as written by table() above and by Mammoth. Both
// emit one flat row of cells per line with no nesting, which is what lets these
// two patterns stand in for a parser.
//
// ponytail: regex, not a DOM. reorder.js is deliberately DOM-free so it stays
// unit-testable under plain node, and a table nested inside another table would
// defeat this -- no importer here produces one. Parse properly if that changes.
const ROW = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
const CELL = /<(t[dh])\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Splice at the LAST occurrence, not the first.
 *
 *  String.replace(needle, …) takes the first, and in a table the thing being
 *  removed is routinely identical to something above it -- two empty cells, two
 *  blank rows -- so the first match is the wrong one often enough to look like
 *  the button deletes at random. */
function atLast(hay, needle, replacement) {
  const at = hay.lastIndexOf(needle);
  return at < 0 ? hay : hay.slice(0, at) + replacement + hay.slice(at + needle.length);
}

/**
 * Grow or shrink a table by one row or one column. `op` is 'row+', 'row-',
 * 'col+' or 'col-'; anything it cannot do returns the table unchanged.
 *
 * From the end, not from the caret. Following a caret would let a teacher
 * insert a row where they are looking, which is nicer -- and needs a live
 * selection, which is the one thing this module has no access to.
 * ponytail: last-row/last-column. Wire it to the caret if teachers ask.
 *
 * Never removes the final row or the final column: a table with neither is not
 * a smaller table, it is markup with nothing in it, and the block would then be
 * unrecoverable by any other button. Delete the block to get rid of it.
 */
export function tableEdit(html, op) {
  const s = String(html ?? '');
  const rows = s.match(ROW);
  if (!rows) return s;

  if (op === 'col+' || op === 'col-') {
    return s.replace(ROW, (row) => {
      const cells = row.match(CELL) ?? [];
      if (op === 'col-') return cells.length < 2 ? row : atLast(row, cells[cells.length - 1], '');
      // A header row grows a header cell; a body row grows a body cell.
      const tag = /<th\b/i.test(row) ? 'th' : 'td';
      return row.replace(/<\/tr>\s*$/i, `<${tag}></${tag}></tr>`);
    });
  }

  const last = rows[rows.length - 1];
  if (op === 'row-') return rows.length < 2 ? s : atLast(s, last, '');
  if (op !== 'row+') return s;
  // Shaped like the row it follows, so a new row lines up under the header.
  const width = (last.match(CELL) ?? []).length || 1;
  return atLast(s, last, last + `<tr>${'<td></td>'.repeat(width)}</tr>`);
}

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
