// The editor's drag model: what a drag carries, where it lands.
//
// The section grouping here has to agree with attestedBlocks() in
// _lib/syllabus.js -- the editor moves a section as a unit and the signature
// hashes that same unit. A drift between the two would let a teacher drag a
// policy out from under the prompt that attests to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragRange, insertionIndex, unitStartBefore, moveRange, keyDestination, sectionRanges, sectionDest, pickTarget, sectionSigns, toggleSigning,
  rangeDestination, ladderTag, retag, blockText, hasShape, isTable, toggleListKind, tableEdit,
  setPendingSuggestions, firstPendingIndex, nextPendingIndex, applyPendingInSection,
  applyAllPending, clearAllPending, clearPendingInSection }
  from '../public/admin/editor/reorder.js';
import { attestedBlocks } from '../functions/_lib/syllabus.js';

const h = (t) => ({ type: 'heading', html: `<h2>${t}</h2>` });
const p = (t) => ({ type: 'text', html: `<p>${t}</p>` });
const ini = (t) => ({ type: 'initial', html: t, needs_initials: true });

//  0 h Late      1 p 10%      2 initial
//  3 h Attend    4 p tardies
//  5 h Materials 6 p pencil
const DOC = [h('Late'), p('10%'), ini('read late'), h('Attend'), p('tardies'), h('Materials'), p('pencil')];

// ---- what a drag carries ----

test('a heading carries its whole section', () => {
  assert.deepEqual(dragRange(DOC, 0), [0, 3]);
  assert.deepEqual(dragRange(DOC, 3), [3, 5]);
});

test('the last section runs to the end of the document', () => {
  assert.deepEqual(dragRange(DOC, 5), [5, 7]);
});

test('a non-heading block moves alone', () => {
  assert.deepEqual(dragRange(DOC, 1), [1, 2]);
  assert.deepEqual(dragRange(DOC, 4), [4, 5]);
});

test('a section is the same grouping the signature hashes', () => {
  // dragRange is indices, attestedBlocks is the blocks themselves. If these
  // ever disagree, dragging a section would silently change what was signed.
  const [from, to] = dragRange(DOC, 0);
  assert.deepEqual(attestedBlocks(DOC, 2), DOC.slice(from, to));
});

// ---- signing is a section decision ----

test('a section reports whether it already asks for initials', () => {
  assert.equal(sectionSigns(DOC, 0, 3), true, 'Late work has a prompt');
  assert.equal(sectionSigns(DOC, 3, 5), false, 'Attendance does not');
});

test('turning signing on appends a prompt without touching the policy text', () => {
  const out = toggleSigning(DOC, 3, 5);                 // Attendance
  assert.equal(out.length, DOC.length + 1);
  assert.deepEqual(out.slice(3, 6).map((b) => b.type), ['heading', 'text', 'initial']);
  assert.equal(out[4].html, '<p>tardies</p>', 'the policy must survive being attested to');
  assert.match(out[5].html, /attend/i, 'the prompt names what it is about');
});

test('the appended prompt lands inside the section it attests to', async () => {
  const out = toggleSigning(DOC, 3, 5);
  const promptAt = out.findIndex((b) => b.type === 'initial' && /attend/i.test(b.html));
  assert.deepEqual(attestedBlocks(out, promptAt).map((b) => b.html),
    ['<h2>Attend</h2>', '<p>tardies</p>', out[promptAt].html],
    'a prompt appended by the toggle must attest to exactly its own section');
});

test('turning signing off removes the prompt and leaves the rest', () => {
  const out = toggleSigning(DOC, 0, 3);                 // Late work
  assert.equal(out.length, DOC.length - 1);
  assert.equal(sectionSigns(out, 0, 2), false);
  assert.deepEqual(out.slice(0, 2).map((b) => b.html), ['<h2>Late</h2>', '<p>10%</p>']);
});

test('toggling twice returns to where it started', () => {
  const on = toggleSigning(DOC, 3, 5);
  const off = toggleSigning(on, 3, 6);
  assert.deepEqual(off.map((b) => b.html), DOC.map((b) => b.html));
});

test('a section with no heading still gets a usable prompt', () => {
  const loose = [p('some rule')];
  const out = toggleSigning(loose, 0, 1);
  assert.equal(out[1].html, 'I have read and understand this section.');
});

// ---- what a click picks up ----

test('clicking a heading picks up its whole section, not the heading alone', () => {
  assert.deepEqual(pickTarget(DOC, 0, 0), { kind: 'section', at: 0 });
  assert.deepEqual(pickTarget(DOC, 3, 3), { kind: 'section', at: 3 });
});

test('clicking a block inside a section picks up just that block', () => {
  assert.deepEqual(pickTarget(DOC, 0, 1), { kind: 'block', at: 1 });
  assert.deepEqual(pickTarget(DOC, 0, 2), { kind: 'block', at: 2 });
});

test("clicking a section card's own padding picks up the section", () => {
  assert.deepEqual(pickTarget(DOC, 0, null), { kind: 'section', at: 0 });
});

test('a headless run of blocks offers no section to pick up', () => {
  const preamble = [p('intro'), h('Late'), p('10%')];
  assert.equal(pickTarget(preamble, 0, null), null, 'there is no heading, so there is no section');
  assert.deepEqual(pickTarget(preamble, 0, 0), { kind: 'block', at: 0 }, 'the block itself still moves');
});

test('what a click picks up is what a drag then carries', () => {
  // pickTarget and dragRange have to agree, or clicking a heading would select
  // one thing and move another.
  const t = pickTarget(DOC, 0, 0);
  assert.deepEqual(dragRange(DOC, t.at), [0, 3]);
});

// ---- insertion from pointer position ----

test('insertionIndex lands before the first row whose midpoint is below y', () => {
  const bands = [{ top: 0, bottom: 20 }, { top: 20, bottom: 40 }, { top: 40, bottom: 60 }];
  assert.equal(insertionIndex(5, bands), 0);
  assert.equal(insertionIndex(25, bands), 1);
  assert.equal(insertionIndex(45, bands), 2);
  assert.equal(insertionIndex(999, bands), 3, 'past the last row appends');
});

test('a midpoint resolves after its row, so hovering does not oscillate', () => {
  assert.equal(insertionIndex(10, [{ top: 0, bottom: 20 }]), 1);
});

test('an empty list always appends', () => {
  assert.equal(insertionIndex(0, []), 0);
});

// ---- moving ----

test('moving a section keeps its blocks together and in order', () => {
  // dest counts among the four blocks that are NOT moving
  // ([Attend, tardies, Materials, pencil]), so 2 means "before Materials".
  const out = moveRange(DOC, 0, 3, 2);
  assert.deepEqual(out.map((b) => b.html), [
    '<h2>Attend</h2>', '<p>tardies</p>',
    '<h2>Late</h2>', '<p>10%</p>', 'read late',
    '<h2>Materials</h2>', '<p>pencil</p>',
  ]);
});

test('dest past the last non-moving block appends', () => {
  const out = moveRange(DOC, 0, 3, 4);
  assert.deepEqual(out.map((b) => b.html).slice(-3), ['<h2>Late</h2>', '<p>10%</p>', 'read late']);
});

test('a move to where it already sits is a no-op, not a dirty edit', () => {
  assert.equal(moveRange(DOC, 0, 3, 0), null);
  assert.equal(moveRange(DOC, 3, 5, 3), null);
});

test('moving never loses or duplicates a block', () => {
  const census = (list) => list.map((b) => b.html).sort();
  for (let from = 0; from < DOC.length; from++) {
    const [f, t] = dragRange(DOC, from);
    for (let dest = 0; dest <= DOC.length - (t - f); dest++) {
      const out = moveRange(DOC, f, t, dest);
      if (!out) continue;
      assert.equal(out.length, DOC.length, `from ${f} to ${dest} changed the block count`);
      assert.deepEqual(census(out), census(DOC), `from ${f} to ${dest} lost or duplicated a block`);
    }
  }
});

// ---- a section may not be dropped into another section ----

test('sectionRanges groups a heading with the blocks under it', () => {
  assert.deepEqual(sectionRanges(DOC), [[0, 3], [3, 5], [5, 7]]);
});

test('blocks before the first heading form a section of their own', () => {
  const withPreamble = [p('intro'), h('Late'), p('10%')];
  assert.deepEqual(sectionRanges(withPreamble), [[0, 1], [1, 3]]);
});

test('an empty document has no sections', () => {
  assert.deepEqual(sectionRanges([]), []);
});

test('every section drop lands on a section boundary', () => {
  const [from, to] = dragRange(DOC, 3);            // Attendance
  const starts = new Set([...sectionRanges(DOC).map(([s]) => s), DOC.length - (to - from)]);
  for (let slot = 0; slot <= 2; slot++) {
    const dest = sectionDest(DOC, from, to, slot);
    const out = moveRange(DOC, from, to, dest);
    if (!out) continue;
    // Every heading still owns the blocks that were under it.
    assert.deepEqual(sectionRanges(out).map(([s, e]) => e - s).sort(), [2, 2, 3],
      `slot ${slot} split a section`);
  }
  assert.ok(starts.size > 0);
});

test('a section dropped past the last slot goes to the end', () => {
  const [from, to] = dragRange(DOC, 0);            // Late work
  const out = moveRange(DOC, from, to, sectionDest(DOC, from, to, 99));
  assert.deepEqual(out.slice(-3).map((b) => b.html), ['<h2>Late</h2>', '<p>10%</p>', 'read late']);
});

test('a lone block is still free to land anywhere, including mid-section', () => {
  // The 10% paragraph moves out of Late work and lands at the end of Attendance.
  const out = moveRange(DOC, 1, 2, 4);
  assert.deepEqual(out.map((b) => b.html).slice(2, 5),
    ['<h2>Attend</h2>', '<p>tardies</p>', '<p>10%</p>']);
});

// ---- keyboard ----

test('Alt+Down on a heading steps over the whole next section', () => {
  const move = keyDestination(DOC, 0, 1);
  const out = moveRange(DOC, move.from, move.to, move.dest);
  assert.deepEqual(out.map((b) => b.html).slice(0, 3),
    ['<h2>Attend</h2>', '<p>tardies</p>', '<h2>Late</h2>'],
    'Late should land after Attend entirely, not inside it');
});

test('Alt+Up on a heading steps back over the whole previous section', () => {
  const move = keyDestination(DOC, 3, -1);
  const out = moveRange(DOC, move.from, move.to, move.dest);
  assert.deepEqual(out.map((b) => b.html).slice(0, 2), ['<h2>Attend</h2>', '<p>tardies</p>']);
});

test('Alt+Arrow on a lone block steps one block', () => {
  const move = keyDestination(DOC, 1, 1);
  const out = moveRange(DOC, move.from, move.to, move.dest);
  assert.deepEqual(out.map((b) => b.html).slice(0, 3), ['<h2>Late</h2>', 'read late', '<p>10%</p>']);
});

test('the ends of the document refuse to move further', () => {
  assert.equal(keyDestination(DOC, 0, -1), null);
  assert.equal(keyDestination(DOC, 6, 1), null);
});

test('unitStartBefore finds the previous section heading', () => {
  assert.equal(unitStartBefore(DOC, 3), 0);
  assert.equal(unitStartBefore(DOC, 5), 3);
});

test('unitStartBefore falls back to the top when there is no heading above', () => {
  const preamble = [p('intro'), p('more'), h('Late'), p('10%')];
  assert.equal(unitStartBefore(preamble, 2), 0);
});

// ---- promoting and demoting a line, and moving several at once ----

test('the ladder runs text -> subheading -> section and back', () => {
  const text = { type: 'text', html: '<p>Late Work</p>' };
  assert.equal(ladderTag(text, 1), 'subheading');
  assert.equal(ladderTag({ type: 'heading', level: 3, html: '<h3>Late Work</h3>' }, 1), 'heading');
  assert.equal(ladderTag({ type: 'heading', level: 2, html: '<h2>Late Work</h2>' }, 1), null, 'nothing above a section');
  assert.equal(ladderTag({ type: 'heading', level: 2, html: '<h2>Late Work</h2>' }, -1), 'subheading');
  assert.equal(ladderTag({ type: 'heading', level: 3, html: '<h3>Late Work</h3>' }, -1), 'text');
  assert.equal(ladderTag(text, -1), null, 'nothing below body text');
});

test('a table, a list or a prompt has no rung on the ladder', () => {
  // retag() keeps a block's words and nothing else, so laddering any of these
  // would quietly destroy what it holds.
  assert.equal(ladderTag({ type: 'text', html: '<table><tr><td>A</td><td>90%</td></tr></table>' }, 1), null);
  assert.equal(ladderTag({ type: 'list', html: '<ul><li>A pencil</li></ul>' }, 1), null);
  assert.equal(ladderTag({ type: 'initial', html: 'I have read the late work policy.' }, 1), null);
  assert.equal(ladderTag({ type: 'agree', html: 'I agree.' }, -1), null);
});

test('the ladder is what retag already speaks, so the words survive', () => {
  const blocks = [{ type: 'text', html: '<p>Late Work</p>' }];
  const out = retag(blocks, [{ index: 0, tag: ladderTag(blocks[0], 1) }]);
  assert.equal(out[0].type, 'heading');
  assert.equal(out[0].level, 3);
  assert.equal(blockText(out[0].html), 'Late Work');
});

test('a picked span steps one line, not one section', () => {
  const blocks = [
    { type: 'heading', html: '<h2>One</h2>' },
    { type: 'text', html: '<p>a</p>' },
    { type: 'text', html: '<p>b</p>' },
    { type: 'text', html: '<p>c</p>' },
  ];
  const down = rangeDestination(blocks, 1, 3, 1);      // rows a and b, together
  assert.deepEqual(down, { from: 1, to: 3, dest: 2 });
  const moved = moveRange(blocks, down.from, down.to, down.dest);
  assert.deepEqual(moved.map((b) => blockText(b.html)), ['One', 'c', 'a', 'b']);

  const back = rangeDestination(moved, 2, 4, -1);
  assert.deepEqual(moveRange(moved, back.from, back.to, back.dest).map((b) => blockText(b.html)),
    ['One', 'a', 'b', 'c']);
});

test('a span at either end of the document does not move', () => {
  const blocks = [{ type: 'text', html: '<p>a</p>' }, { type: 'text', html: '<p>b</p>' }];
  assert.equal(rangeDestination(blocks, 0, 2, -1), null);
  assert.equal(rangeDestination(blocks, 0, 2, 1), null);
});

// ---- shape: lists and tables ----
//
// A table is a 'text' block that happens to hold <table>, so every one of these
// is really a question about markup rather than about type. The last row and
// the last column are held back on purpose: nothing else in the editor could
// put them back, and the block would be stranded.

const TABLE = '<table><thead><tr><th>Category</th><th>Weight</th></tr></thead>'
  + '<tbody><tr><td>Homework</td><td>15%</td></tr><tr><td>Tests</td><td>75%</td></tr></tbody></table>';

const rows = (html) => html.match(/<tr\b/gi)?.length ?? 0;
const cols = (html) => (html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/i)?.[0].match(/<t[dh]\b/gi) ?? []).length;

test('a list changes between bulleted and numbered, and keeps its items', () => {
  const ul = '<ul><li>Pencil</li><li>Calculator</li></ul>';
  const ol = toggleListKind(ul);
  assert.equal(ol, '<ol><li>Pencil</li><li>Calculator</li></ol>');
  assert.equal(toggleListKind(ol), ul);
  assert.equal(blockText(ol), 'Pencil Calculator');
});

test('a table grows a row shaped like the one above it', () => {
  const grown = tableEdit(TABLE, 'row+');
  assert.equal(rows(grown), rows(TABLE) + 1);
  assert.equal(cols(grown), 2);
  // Grown at the END, so the header is still the header.
  assert.match(grown, /<th>Category<\/th>/);
  assert.match(grown, /<tr><td><\/td><td><\/td><\/tr><\/tbody>/);
});

test('a table grows a column in every row, header cell in the header row', () => {
  const grown = tableEdit(TABLE, 'col+');
  assert.equal(cols(grown), 3);
  assert.equal(rows(grown), rows(TABLE));
  assert.match(grown, /<th>Weight<\/th><th><\/th>/);   // header row gets a th
  assert.match(grown, /<td>15%<\/td><td><\/td>/);      // body rows get a td
});

test('removing takes the last row and the last column, not the first', () => {
  assert.equal(blockText(tableEdit(TABLE, 'row-')), 'Category Weight Homework 15%');
  assert.equal(blockText(tableEdit(TABLE, 'col-')), 'Category Homework Tests');
});

test('identical blank rows do not make the wrong one disappear', () => {
  // Two rows with byte-identical markup. A first-match replace would delete the
  // upper one and leave the table looking unchanged from the bottom.
  const twin = '<table><tbody><tr><td>keep</td></tr><tr><td></td></tr><tr><td></td></tr></tbody></table>';
  const cut = tableEdit(twin, 'row-');
  assert.equal(rows(cut), 2);
  assert.equal(cut, '<table><tbody><tr><td>keep</td></tr><tr><td></td></tr></tbody></table>');
});

test('a table never loses its last row or its last column', () => {
  const one = '<table><tbody><tr><td>only</td></tr></tbody></table>';
  assert.equal(tableEdit(one, 'row-'), one);
  assert.equal(tableEdit(one, 'col-'), one);
  // Unchanged is how the editor knows to explain itself instead of redrawing.
  assert.equal(tableEdit('<p>not a table</p>', 'row+'), '<p>not a table</p>');
});

test('shape is read off the markup, because a table is stored as text', () => {
  const table = { type: 'text', html: TABLE };
  assert.equal(isTable(table), true);
  assert.equal(hasShape(table), true);
  assert.equal(hasShape({ type: 'list', html: '<ul><li>a</li></ul>' }), true);
  assert.equal(hasShape({ type: 'text', html: '<p>Late work loses 10%.</p>' }), false);
  // The same guard the ladder already applies -- one definition, two callers.
  assert.equal(ladderTag(table, 1), null);
});

// ---- pending initials: a model pointer, never the document's decision ----

test('a suggestion stamps a per-block pointer, not a real initial', () => {
  // The model points. The block stays type: 'text'; the only change is a
  // pending field that the editor's own Accept button is the only thing that
  // turns into a real initial. The existing sectionSigns() must keep
  // returning false -- otherwise toggleSigning would short-circuit and the
  // Accept button would silently no-op.
  const blocks = setPendingSuggestions(DOC, [{ index: 1, reason: 'grading impact' }]);
  assert.equal(blocks[1].type, 'text', 'still a paragraph');
  assert.deepEqual(blocks[1].pendingInitial, { reason: 'grading impact' });
  assert.equal(sectionSigns(blocks, 0, 3), true, 'late-work already has a prompt from DOC; the other two do not');
  assert.equal(sectionSigns(blocks, 3, 5), false, 'a pending on Attend does not count as a signed section');
});

test('a suggestion that the model stopped making clears the prior pending', () => {
  // Re-running suggest with a shorter list must not leave the dropped block
  // still wearing a stale pointer; otherwise the Accept button could fire on
  // a reason the teacher never saw.
  const once = setPendingSuggestions(DOC, [{ index: 1, reason: 'a' }, { index: 4, reason: 'b' }]);
  const again = setPendingSuggestions(once, [{ index: 1, reason: 'a' }]);
  assert.equal(again[4].pendingInitial, undefined);
  assert.deepEqual(again[1].pendingInitial, { reason: 'a' });
});

test('firstPendingIndex walks the document top to bottom', () => {
  const blocks = setPendingSuggestions(DOC, [{ index: 4, reason: 'attendance' }]);
  assert.equal(firstPendingIndex(blocks), 4);
  assert.equal(nextPendingIndex(blocks, 5), -1, 'past the end, nothing more');
});

test('accepting one section flips the section\'s sign and clears pendings inside it', () => {
  // Late (0..3) already has a prompt in DOC. Accepting on a section that is
  // already signed must still clear the pendings -- the model pointed, the
  // teacher agreed, and "the sign is on" is what survives. Without the
  // clear, a second run of suggest would re-mark the same blocks and the
  // count would only ever go up.
  const blocks = setPendingSuggestions(DOC, [{ index: 1, reason: 'grading' }]);
  const r = applyPendingInSection(blocks, 0, 3);
  assert.equal(r.applied, true);
  assert.equal(r.blocks[1].pendingInitial, undefined);
  assert.equal(sectionSigns(r.blocks, 0, 3), true, 'still signed -- was already signed');
  // Attend is in 3..5 and has no pending here. No-op, no flip.
  const r2 = applyPendingInSection(blocks, 3, 5);
  assert.equal(r2.applied, false);
  assert.deepEqual(r2.blocks, blocks, 'no change when the section had no pendings');
});

test('accepting one section that was not yet signed turns on the sign', () => {
  // Materials (5..7) has no initial block. The pointer must turn into a real
  // sign when the teacher accepts. toggleSigning appends a prompt at the
  // end of the section, so the section GROWS by one and its [from,to) range
  // shifts; assert on the new range the sectioning code would compute.
  const blocks = setPendingSuggestions(DOC, [{ index: 6, reason: 'cost' }]);
  const r = applyPendingInSection(blocks, 5, 7);
  assert.equal(r.applied, true);
  assert.equal(r.blocks[6].pendingInitial, undefined);
  const ranges = sectionRanges(r.blocks);
  const materials = ranges.find(([f]) => f === 5);
  assert.ok(materials, 'Materials is still a section after the append');
  assert.equal(sectionSigns(r.blocks, materials[0], materials[1]), true, 'now signed');
  // The initial block ends up at the end of the section, the same place
  // toggleSigning always puts it.
  assert.equal(r.blocks[materials[1] - 1].type, 'initial');
});

test('accept all flips every pending section and clears every pointer', () => {
  const blocks = setPendingSuggestions(DOC, [
    { index: 1, reason: 'grading' },
    { index: 4, reason: 'attendance' },
    { index: 6, reason: 'cost' },
  ]);
  const next = applyAllPending(blocks);
  // Three sections had pendings; one was already signed (Late), two are now.
  // The two newly-signed sections each grew by an initial block, so the
  // original block indices 4 and 6 may have shifted. Walk the live ranges.
  assert.equal(firstPendingIndex(next), -1, 'no pendings left');
  const ranges = sectionRanges(next);
  // Late, Attend, Materials are the three sections. Each must end in an
  // initial block (toggleSigning puts it at the tail) -- the cheapest test
  // of "every section is signed" without chasing shifted indices.
  for (const [from, to] of ranges) {
    const tail = next[to - 1];
    assert.ok(tail && (tail.type === 'initial' || tail.type === 'agree'),
      `section [${from},${to}) ends in a prompt (got type=${tail?.type})`);
  }
  // Late was already signed, the others were not. The number of initial
  // blocks went from 1 (DOC) to 3 (one per section).
  const initials = next.filter((b) => b.type === 'initial' || b.type === 'agree').length;
  assert.equal(initials, 3, 'one prompt per section');
});

test('dismiss clears pendings on one section, leaving the rest alone', () => {
  const blocks = setPendingSuggestions(DOC, [
    { index: 1, reason: 'grading' },
    { index: 4, reason: 'attendance' },
  ]);
  const next = clearPendingInSection(blocks, 0, 3);
  assert.equal(next[1].pendingInitial, undefined);
  assert.deepEqual(next[4].pendingInitial, { reason: 'attendance' });
  // The walk-through cursor lands on the next pending, in order.
  assert.equal(firstPendingIndex(next), 4);
});

test('an out-of-range index from the model is dropped, not silently shifted', () => {
  // The endpoint validates the index against the whitelist; this side
  // (the editor) drops anything that does not point at a real block. A
  // model that invents a block at -1 or 99 must not change anything.
  const blocks = setPendingSuggestions(DOC, [
    { index: -1, reason: 'before' },
    { index: 99, reason: 'after' },
    { index: 1, reason: 'real' },
  ]);
  assert.equal(blocks[1].pendingInitial?.reason, 'real');
  for (const b of blocks) {
    if (b === blocks[1]) continue;
    assert.equal(b.pendingInitial, undefined, 'nothing else got marked');
  }
});
