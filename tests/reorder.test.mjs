// The editor's drag model: what a drag carries, where it lands.
//
// The section grouping here has to agree with attestedBlocks() in
// _lib/syllabus.js -- the editor moves a section as a unit and the signature
// hashes that same unit. A drift between the two would let a teacher drag a
// policy out from under the prompt that attests to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragRange, insertionIndex, unitStartBefore, moveRange, keyDestination, sectionRanges, sectionDest, pickTarget, sectionSigns, toggleSigning }
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
