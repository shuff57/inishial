// Heading level, and the thing it protects.
//
// A section is a page, a signing unit, and the exact span a signature is hashed
// against, all at once. Before levels, every heading started one -- so marking
// "Group Assessment:" as a heading, which is typographically correct and what
// the AI pass proposed, cut the grading policy into six pages and left the
// parent initialling the last fragment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sections, sectionRanges, sectionTitle, startsSection } from '../public/shared/sections.js';
import { retag } from '../public/admin/editor/reorder.js';

const h2 = (t) => ({ type: 'heading', level: 2, html: `<h2>${t}</h2>` });
const h3 = (t) => ({ type: 'heading', level: 3, html: `<h3>${t}</h3>` });
const p = (t) => ({ type: 'text', html: `<p>${t}</p>` });
const prompt = (t) => ({ type: 'initial', html: t, needs_initials: true });

test('a subheading does not start a section', () => {
  assert.equal(startsSection(h2('Grading Policy')), true);
  assert.equal(startsSection(h3('Late Work')), false);
  assert.equal(startsSection(p('anything')), false);
});

test('a heading with no level is a section heading', () => {
  // Every heading written before levels existed was a section heading; that was
  // the only kind there was. Reading a missing level as 3 would silently merge
  // every existing syllabus into one page.
  assert.equal(startsSection({ type: 'heading', html: '<h2>Old</h2>' }), true);
});

test('subheadings keep one policy as one signing unit', () => {
  const blocks = [
    h2('Grading Policy'),
    h3('Daily Classwork:'), p('Assigned in Google Classroom.'),
    h3('Group Assessment:'), p('A group test each unit.'),
    h3('Late Work'), p('Ten percent per day.'),
    prompt('I have read the grading policy.'),
    h2('Use of AI'), p('Yellow level.'), prompt('I have read the AI policy.'),
  ];

  const secs = sections(blocks);
  assert.equal(secs.length, 2, 'three subheadings must not make four pages');
  assert.equal(sectionTitle(secs[0]), 'Grading Policy');
  assert.equal(sectionTitle(secs[1]), 'Use of AI');

  // The point of all of it: the prompt still sits in the policy it attests to.
  assert.ok(secs[0].some((b) => b.needs_initials));
  assert.equal(secs[0].filter((b) => b.type === 'heading').length, 4,
    'the subheadings are still IN the section, not dropped');
});

test('promoting a subheading to a heading does split the section', () => {
  // The behaviour is not being removed, only made deliberate.
  const blocks = [h2('Grading'), h3('Late Work'), p('Ten percent.')];
  assert.equal(sections(blocks).length, 1);
  assert.equal(sections(blocks.map((b) => (b === blocks[1] ? h2('Late Work') : b))).length, 2);
});

test('sectionRanges and sections agree about the split', () => {
  const blocks = [h2('A'), h3('a1'), p('x'), h2('B'), p('y')];
  assert.deepEqual(sectionRanges(blocks), [[0, 3], [3, 5]]);
  assert.deepEqual(sections(blocks).map((s) => s.length), [3, 2]);
});

test('a section titled by a subheading has no title of its own', () => {
  // Blocks before the first level-2 heading are a leading section. A level-3
  // heading at the top must not be mistaken for the document's first section.
  assert.equal(sectionTitle([h3('Late Work'), p('x')]), null);
});

// ---- the AI pass speaks in three tags ----

test('retag can nest a line instead of only promoting it', () => {
  const blocks = [h2('Grading'), p('Late Work'), p('Ten percent.')];
  const out = retag(blocks, [{ index: 1, tag: 'subheading' }]);
  assert.equal(out[1].type, 'heading');
  assert.equal(out[1].level, 3);
  assert.match(out[1].html, /^<h3>/);
  assert.equal(sections(out).length, 1, 'nesting must not create a page');
});

test('retag can move a line between the two heading levels', () => {
  const asSub = retag([h2('Late Work')], [{ index: 0, tag: 'subheading' }]);
  assert.equal(asSub[0].level, 3);
  const backUp = retag(asSub, [{ index: 0, tag: 'heading' }]);
  assert.equal(backUp[0].level, 2);
  assert.match(backUp[0].html, /^<h2>/);
});

test('retagging still cannot change a single word', () => {
  const blocks = [p('Late Work &amp; Make-ups')];
  const out = retag(blocks, [{ index: 0, tag: 'subheading' }]);
  assert.match(out[0].html, /Late Work &amp; Make-ups/,
    'the words are re-escaped, never rewritten');
});

test('a no-op retag returns the block untouched', () => {
  // Asking for the tag a line already has must not rebuild its html -- that
  // would strip any inline markup the document arrived with.
  const rich = { type: 'heading', level: 3, html: '<h3>Late <em>Work</em></h3>' };
  assert.equal(retag([rich], [{ index: 0, tag: 'subheading' }])[0], rich);
});

test('a prompt is never retagged, at either level', () => {
  const blocks = [prompt('I agree.')];
  for (const tag of ['heading', 'subheading', 'text']) {
    assert.equal(retag(blocks, [{ index: 0, tag }])[0].type, 'initial',
      'retagging a prompt would drop a signature obligation from the document');
  }
});

// ---- the level has to survive the whole way to the reader ----
//
// This is the test that should have existed first. Adding `level` to the SQL
// was not enough: the sign endpoint shapes its response through a field
// whitelist, so the column arrived and was then dropped on the way out. The
// parent's syllabus served 15 pages of a 9-section document while the editor
// showed 9, and nothing failed.
//
// So it is asserted end to end -- seed a syllabus with subheadings, call the
// real handler, and count the pages the way the page itself does.

import { freshEnv, seedStudent, seedAccount, jsonRequest, cookieFrom } from './helpers.mjs';
import { onRequestPost as signLogin } from '../functions/api/sign/login.js';
import { onRequestGet as parentView } from '../functions/api/sign/syllabus.js';

/** A published syllabus: two sections, three subheadings inside the first. */
function seedLevelled(db, courseId) {
  const syllabusId = Number(db.prepare('INSERT INTO syllabi (course_id, title, slug) VALUES (?, ?, ?)')
    .run(courseId, 'Levels', 'levels').lastInsertRowid);
  const versionId = Number(db.prepare('INSERT INTO versions (syllabus_id, num, published_at) VALUES (?, 1, 2000)')
    .run(syllabusId).lastInsertRowid);
  const rows = [
    ['heading', '<h2>Grading Policy</h2>', 0, 2],
    ['heading', '<h3>Daily work</h3>', 0, 3],
    ['text', '<p>Completion.</p>', 0, 2],
    ['heading', '<h3>Late work</h3>', 0, 3],
    ['text', '<p>Ten percent.</p>', 0, 2],
    ['initial', 'I have read the grading policy.', 1, 2],
    ['heading', '<h2>Attendance</h2>', 0, 2],
    ['text', '<p>Daily.</p>', 0, 2],
    ['initial', 'I have read the attendance policy.', 1, 2],
  ];
  rows.forEach(([type, html, needs, level], i) => {
    db.prepare('INSERT INTO blocks (version_id, ord, type, html, needs_initials, level) VALUES (?, ?, ?, ?, ?, ?)')
      .run(versionId, i, type, html, needs, level);
  });
}

test('the parent view receives the level, and pages on it', async () => {
  const env = freshEnv();
  const { rosterId, courseId } = seedStudent(env._raw);
  const { code } = await seedAccount(env._raw, rosterId);
  seedLevelled(env._raw, courseId);

  const cookie = cookieFrom(await signLogin({
    request: jsonRequest('https://x/api/sign/login', { student_ext_id: '904511', code, role: 'parent' }), env,
  }));
  const body = await (await parentView({
    request: new Request('https://x/api/sign/syllabus', { headers: { Cookie: cookie } }), env,
  })).json();

  const heads = body.blocks.filter((b) => b.type === 'heading');
  assert.equal(heads.length, 4, 'two section headings and two subheadings');
  assert.deepEqual(heads.map((h) => h.level), [2, 3, 3, 2],
    'a level dropped anywhere between the table and the page turns every subheading into a page');

  // Counted exactly as the signing page counts it.
  assert.equal(sections(body.blocks).length, 2,
    'three subheadings must not become three extra pages for the parent');
  assert.equal(sectionTitle(sections(body.blocks)[0]), 'Grading Policy');
});

test('each signing prompt stays in the section it attests to', async () => {
  const env = freshEnv();
  const { rosterId, courseId } = seedStudent(env._raw);
  const { code } = await seedAccount(env._raw, rosterId);
  seedLevelled(env._raw, courseId);

  const cookie = cookieFrom(await signLogin({
    request: jsonRequest('https://x/api/sign/login', { student_ext_id: '904511', code, role: 'parent' }), env,
  }));
  const body = await (await parentView({
    request: new Request('https://x/api/sign/syllabus', { headers: { Cookie: cookie } }), env,
  })).json();

  for (const section of sections(body.blocks)) {
    const prompts = section.filter((b) => b.needs_initials);
    assert.equal(prompts.length, 1, 'one prompt per section');
    assert.equal(section.at(-1), prompts[0], 'and it is the last thing on the page');
  }
});
