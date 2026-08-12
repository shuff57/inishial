// Self-checks for the two pieces of non-obvious logic: roster parsing (which
// has to survive whatever the SIS emits) and access codes (which are the whole
// security boundary). Run: npm test
//
// node:test + node:assert only. No framework, nothing to install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, mapColumns, parseRoster, parseRosterWithColumns } from '../functions/_lib/csv.js';
import { generateCode, hashCode, verifyCode, normalize, sha256Hex } from '../functions/_lib/codes.js';

test('parseCsv handles quotes, embedded commas, and doubled quotes', () => {
  const rows = parseCsv('a,b\n"Doyle, Robert",7\n"say ""hi""",8\n');
  assert.deepEqual(rows, [['a', 'b'], ['Doyle, Robert', '7'], ['say "hi"', '8']]);
});

test('parseCsv strips the BOM Excel adds', () => {
  assert.equal(parseCsv('﻿Student ID\n123\n')[0][0], 'Student ID');
});

test('mapColumns matches aliases case- and separator-insensitively', () => {
  const cols = mapColumns(['Student_ID', 'LAST NAME', 'first name', 'Per']);
  assert.equal(cols.student_ext_id, 0);
  assert.equal(cols.last, 1);
  assert.equal(cols.first, 2);
  assert.equal(cols.period, 3);
});

test('mapColumns prefers "Student ID" over a bare "ID" column', () => {
  const cols = mapColumns(['ID', 'Student ID', 'Last Name', 'First Name']);
  assert.equal(cols.student_ext_id, 1, 'bare ID must not shadow the real student ID column');
});

test('parseRoster reads a typical SIS export', () => {
  const csv = [
    'Student ID,Last Name,First Name,Period,Course',
    '904511,Alvarez,Maria,3,Algebra I',
    '904512,Chen,Kevin,3,Algebra I',
  ].join('\n');
  const { rows, skipped } = parseRoster(csv);
  assert.equal(skipped.length, 0);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    student_ext_id: '904511', first: 'Maria', last: 'Alvarez', period: '3', course: 'Algebra I', parent_email: null,
  });
});

test('parseRoster falls back to splitting a combined name column', () => {
  const { rows } = parseRoster('Student Number,Student Name\n77,"Doyle, Robert James"\n78,Kevin Chen\n');
  assert.deepEqual(rows[0], { student_ext_id: '77', first: 'Robert James', last: 'Doyle', period: null, course: null, parent_email: null });
  assert.deepEqual(rows[1], { student_ext_id: '78', first: 'Kevin', last: 'Chen', period: null, course: null, parent_email: null });
});

test('parseRoster reports skipped lines instead of dropping students silently', () => {
  const { rows, skipped } = parseRoster('Student ID,First Name,Last Name\n1,Ann,Lee\n,Bob,Ray\n1,Dup,Licate\n');
  assert.equal(rows.length, 1);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /missing student ID/);
  assert.match(skipped[1].reason, /duplicate/);
  assert.equal(skipped[1].line, 4, 'skipped lines report their 1-based source line');
});

test('parseRoster refuses a file with no identifiable student ID column', () => {
  assert.throws(() => parseRoster('Name,Grade\nAnn Lee,A\n'), /student ID column/);
});

// ---- parseRosterWithColumns: the AI-fix path, once the mapping is known ----

test('parseRosterWithColumns reads a headerless paste when row 0 is data', () => {
  const text = '904511,Alvarez,Maria,3\n904512,Chen,Kevin,4\n';
  const { rows, skipped } = parseRosterWithColumns(text, { student_ext_id: 0, last: 1, first: 2, period: 3 }, false);
  assert.equal(skipped.length, 0);
  assert.deepEqual(rows, [
    { student_ext_id: '904511', first: 'Maria', last: 'Alvarez', period: '3', course: null, parent_email: null },
    { student_ext_id: '904512', first: 'Kevin', last: 'Chen', period: '4', course: null, parent_email: null },
  ]);
});

test('parseRosterWithColumns skips row 0 when hasHeader is true, even with unrecognised labels', () => {
  const text = 'Learner ID,Contact,First\n904511,Alvarez,Maria\n';
  const { rows } = parseRosterWithColumns(text, { student_ext_id: 0, last: 1, first: 2 }, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].student_ext_id, '904511');
});

test('parseRosterWithColumns works with a mapping that only sets a subset of fields', () => {
  // Just enough to identify students -- a single fullname column, no period,
  // no course, no parent email.
  const { rows, warnings } = parseRosterWithColumns(
    '904511,"Alvarez, Maria"\n904512,"Chen, Kevin"\n', { student_ext_id: 0, fullname: 1 }, false,
  );
  assert.deepEqual(rows, [
    { student_ext_id: '904511', first: 'Maria', last: 'Alvarez', period: null, course: null, parent_email: null },
    { student_ext_id: '904512', first: 'Kevin', last: 'Chen', period: null, course: null, parent_email: null },
  ]);
  // parent_email was never mapped, so the "N of M have no parent email"
  // warning -- which only fires once the column exists -- must not appear.
  assert.deepEqual(warnings, []);
});

test('parseRosterWithColumns applies the same dedup and skip rules as parseRoster', () => {
  const text = '1,Lee,Ann\n,Ray,Bob\n1,Dup,Licate\n';
  const { rows, skipped } = parseRosterWithColumns(text, { student_ext_id: 0, last: 1, first: 2 }, false);
  assert.equal(rows.length, 1);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /missing student ID/);
  assert.match(skipped[1].reason, /duplicate/);
});

test('parseRosterWithColumns falls back to splitting a fullname column, same as parseRoster', () => {
  const { rows } = parseRosterWithColumns('77,"Doyle, Robert James"\n', { student_ext_id: 0, fullname: 1 }, false);
  assert.deepEqual(rows[0], { student_ext_id: '77', first: 'Robert James', last: 'Doyle', period: null, course: null, parent_email: null });
});

test('parseRosterWithColumns never throws for missing ID/name columns -- it just yields no rows', () => {
  const { rows, skipped } = parseRosterWithColumns('a,b\nc,d\n', { period: 0 }, false);
  assert.equal(rows.length, 0);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /missing student ID/);
});

test('generateCode avoids characters people misread', () => {
  const joined = Array.from({ length: 200 }, () => generateCode()).join('');
  assert.equal(joined.length, 200 * 8);
  assert.doesNotMatch(joined, /[01OIL]/, 'ambiguous glyphs must never appear in a code');
});

test('generateCode does not repeat', () => {
  const seen = new Set(Array.from({ length: 500 }, () => generateCode()));
  assert.equal(seen.size, 500);
});

test('hashCode round-trips and rejects the wrong code', async () => {
  const code = generateCode();
  const stored = await hashCode(code);
  assert.match(stored, /^pbkdf2\$\d+\$/);
  assert.ok(!stored.includes(code), 'the plaintext code must not survive in the hash');
  assert.equal(await verifyCode(code, stored), true);
  assert.equal(await verifyCode(generateCode(), stored), false);
});

test('verifyCode accepts the formatting people actually type', async () => {
  const stored = await hashCode('ABCD2345');
  assert.equal(await verifyCode('abcd2345', stored), true);
  assert.equal(await verifyCode('ABCD-2345', stored), true);
  assert.equal(await verifyCode(' abcd 2345 ', stored), true);
});

test('verifyCode never throws on malformed stored values', async () => {
  for (const bad of [null, undefined, '', 'garbage', 'pbkdf2$x$y$z', 'pbkdf2$1$!!!$!!!']) {
    assert.equal(await verifyCode('ABCD2345', bad), false);
  }
});

test('normalize is idempotent', () => {
  assert.equal(normalize(normalize(' ab-cd ')), normalize(' ab-cd '));
});

test('sha256Hex pins block text', async () => {
  const a = await sha256Hex('<p>Late work loses 10%.</p>');
  const b = await sha256Hex('<p>Late work loses 20%.</p>');
  assert.equal(a.length, 64);
  assert.notEqual(a, b, 'an edited policy must produce a different hash');
});
