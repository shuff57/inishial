// Roster ingestion: delimiter handling for spreadsheet pastes, and the
// preview that shows what an import would do before it does it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, ADMIN_HEADERS } from './helpers.mjs';
import { detectDelimiter, parseCsv, parseRoster } from '../functions/_lib/csv.js';
import { onRequestPost as uploadRoster } from '../functions/api/admin/roster.js';

const upload = (env, body, qs = '') =>
  uploadRoster({
    request: new Request(`https://x/api/admin/roster?course=Algebra%20I${qs}`, {
      method: 'POST', headers: ADMIN_HEADERS, body,
    }),
    env,
  });

// ---- delimiters ----

test('a spreadsheet paste is read as tab-separated', () => {
  // This is literally what Excel and Google Sheets put on the clipboard.
  const pasted = 'Student ID\tLast Name\tFirst Name\tPeriod\n904511\tAlvarez\tMaria\t3';
  assert.equal(detectDelimiter(pasted), '\t');

  const { rows, delimiter } = parseRoster(pasted);
  assert.equal(delimiter, '\t');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last, 'Alvarez');
});

test('a comma file is still read as comma-separated', () => {
  assert.equal(detectDelimiter('Student ID,Last Name\n1,Lee'), ',');
});

test('a semicolon export is handled', () => {
  const { rows } = parseRoster('Student ID;Last Name;First Name\n1;Lee;Ann\n');
  assert.deepEqual([rows[0].student_ext_id, rows[0].last], ['1', 'Lee']);
  assert.equal(rows[0].first, undefined, 'given names are parsed but never returned');
});

test('a comma inside a quoted name does not fool tab detection', () => {
  const pasted = 'Student ID\tStudent Name\n77\t"Doyle, Robert"';
  assert.equal(detectDelimiter(pasted), '\t',
    'separators inside quotes must not be counted');
  const { rows } = parseRoster(pasted);
  // The given name still has to be PARSED -- it is how "Doyle, Robert" is
  // split -- it just does not survive into the row that gets stored.
  assert.equal(rows[0].last, 'Doyle');
  assert.equal(rows[0].first, undefined);
});

test('a single-column file falls back to comma rather than throwing', () => {
  assert.equal(detectDelimiter('Student ID\n904511'), ',');
});

test('parseCsv honours an explicit delimiter over detection', () => {
  assert.deepEqual(parseCsv('a;b\n1;2', ';'), [['a', 'b'], ['1', '2']]);
});

// ---- preview ----

test('preview reports what would change and writes nothing', async () => {
  const env = freshEnv();
  const res = await upload(env, 'Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n2,Ray,Bob,3\n', '&preview=1');
  const plan = await res.json();

  assert.equal(plan.preview, true);
  assert.equal(plan.inserts, 2);
  assert.equal(plan.updates, 0);
  assert.equal(plan.would_drop, 0);
  assert.deepEqual(plan.new_courses, ['Algebra I']);

  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM roster').get().n, 0, 'preview must not write');
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM courses').get().n, 0);
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM imports').get().n, 0, 'preview must not consume an import id');
});

test('preview names the students an import would drop', async () => {
  const env = freshEnv();
  await upload(env, 'Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n2,Ray,Bob,3\n');

  const plan = await (await upload(env, 'Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n', '&preview=1')).json();
  assert.equal(plan.would_drop, 1);
  assert.deepEqual(plan.would_drop_students, ['Ray (2)']);
  assert.equal(plan.updates, 1);

  assert.equal(env._raw.prepare("SELECT COUNT(*) AS n FROM roster WHERE status = 'dropped'").get().n, 0,
    'nobody is actually dropped by a preview');
});

test('preview does not report drops in periods the file does not cover', async () => {
  const env = freshEnv();
  await upload(env, 'Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n2,Ray,Bob,4\n');

  const plan = await (await upload(env, 'Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n', '&preview=1')).json();
  assert.equal(plan.would_drop, 0, 'period 4 is untouched by a period 3 file');
});

test('preview matches what the real import then does', async () => {
  const env = freshEnv();
  await upload(env, 'Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n2,Ray,Bob,3\n');

  const file = 'Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n3,Cruz,Dana,3\n';
  const plan = await (await upload(env, file, '&preview=1')).json();
  const result = await (await upload(env, file)).json();

  assert.equal(plan.inserts, result.inserted);
  assert.equal(plan.updates, result.updated);
  assert.equal(plan.would_drop, result.dropped);
});

test('preview carries warnings and skipped lines through', async () => {
  const env = freshEnv();
  const plan = await (await upload(env,
    'Student ID,Last Name,First Name,Email\n1,Lee,Ann,ann@student.edu\n,Bob,Ray,x@y.com\n', '&preview=1')).json();

  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /Parent Email/);
  assert.equal(plan.sample.length, 1);
});

test('preview reports the delimiter it used', async () => {
  const env = freshEnv();
  const plan = await (await upload(env, 'Student ID\tLast Name\tFirst Name\n1\tLee\tAnn\n', '&preview=1')).json();
  assert.equal(plan.delimiter, 'tab');
});

test('preview counts an existing student as an update, not an insert', async () => {
  const env = freshEnv();
  await seedStudent(env, { extId: '1', last: 'Lee', period: '3' });

  const plan = await (await upload(env, 'Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n', '&preview=1')).json();
  assert.equal(plan.updates, 1);
  assert.equal(plan.inserts, 0);
  assert.deepEqual(plan.new_courses, []);
});

test('preview refuses a request without Access', async () => {
  const env = freshEnv();
  const res = await uploadRoster({
    request: new Request('https://x/api/admin/roster?course=X&preview=1', { method: 'POST', body: 'a,b\n1,2\n' }),
    env,
  });
  assert.equal(res.status, 401);
});

test('a multi-word course name does not confuse the drop scope', async () => {
  // Regression: the scope key used to pack course and period into one string
  // and split it back on a space, so "Algebra I" parsed as course "Algebra",
  // period "I", and the drop sweep silently matched nothing.
  const env = freshEnv();
  const upload2 = (body, qs = '') =>
    uploadRoster({
      request: new Request(`https://x/api/admin/roster?course=Algebra%20I${qs}`, {
        method: 'POST', headers: ADMIN_HEADERS, body,
      }),
      env,
    });

  await upload2('Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n2,Ray,Bob,3\n');
  const plan = await (await upload2('Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n', '&preview=1')).json();
  assert.equal(plan.would_drop, 1);
  assert.deepEqual(plan.would_drop_students, ['Ray (2)']);

  const applied = await (await upload2('Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n')).json();
  assert.equal(applied.dropped, 1);
});
