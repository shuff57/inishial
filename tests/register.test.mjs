// Registration, parent-email precedence, and the rule that an access code
// never reaches a student.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedAccount, ADMIN_HEADERS, jsonRequest } from './helpers.mjs';
import { onRequestPost as register } from '../functions/api/register.js';
import { onRequestPost as uploadRoster } from '../functions/api/admin/roster.js';
import { onRequestGet as credentials } from '../functions/api/admin/credentials.js';
import { onRequestPost as login } from '../functions/api/sign/login.js';
import { parseRoster } from '../functions/_lib/csv.js';

const post = (env, body) => register({ request: jsonRequest('https://x/api/register', body), env });

// ---- the roster is the source of truth for contact ----

test('registration succeeds without an email when the roster has one', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });

  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez' });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.has_contact, true);
  assert.equal(env._raw.prepare('SELECT parent_email FROM accounts').get().parent_email, null,
    'no override is stored when the student did not supply one');
});

test('a student never sees a parent email address, in any form', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'jennifer.alvarez@example.com' });

  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez' });
  const text = await res.text();

  assert.ok(!text.includes('jennifer.alvarez@example.com'), 'the full address leaked');
  assert.ok(!text.includes('jennifer'), 'part of the local address leaked');
  assert.ok(!text.includes('example.com'), 'the domain leaked');
  assert.ok(!/@|•/.test(text), 'no address, masked or otherwise, belongs in a student-facing response');
  assert.equal(JSON.parse(text).has_contact, true, 'a plain boolean is all the student needs');
});

test('the address a student supplies is not echoed back either', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: null });

  const res = await post(env, {
    student_ext_id: '904511', last: 'Alvarez', username: 'malvarez', parent_email: 'mom@example.com',
  });
  assert.ok(!(await res.text()).includes('mom@example.com'));
});

test('a student-supplied address overrides the roster one', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'old@example.com' });

  await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez', parent_email: 'New@Example.com' });
  assert.equal(env._raw.prepare('SELECT parent_email FROM accounts').get().parent_email, 'New@Example.com');

  const csv = await (await credentials({
    request: new Request('https://x/api/admin/credentials?course_id=1', { headers: ADMIN_HEADERS }), env,
  })).text();
  assert.match(csv, /New@Example\.com,student-supplied/);
});

test('the roster address is used and labelled when the student adds nothing', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez' });

  const csv = await (await credentials({
    request: new Request('https://x/api/admin/credentials?course_id=1', { headers: ADMIN_HEADERS }), env,
  })).text();
  assert.match(csv, /family@example\.com,roster/);
});

test('a student with no contact anywhere is flagged, not blocked', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: null });

  const body = await (await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez' })).json();
  assert.equal(body.has_contact, false);
  assert.match(body.message, /no parent email on file/);

  const csv = await (await credentials({
    request: new Request('https://x/api/admin/credentials?course_id=1', { headers: ADMIN_HEADERS }), env,
  })).text();
  assert.match(csv, /,missing,/);
});

test('a malformed address is refused rather than silently dropped', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez', parent_email: 'not-an-email' });
  assert.equal(res.status, 400);
});

// ---- access codes never reach a student ----

test('no student-reachable endpoint ever returns an access code', async () => {
  const env = freshEnv();
  const { rosterId } = seedStudent(env._raw, { parentEmail: 'family@example.com' });
  const { code } = await seedAccount(env._raw, rosterId, { code: 'ZZZZ9999' });

  const responses = [
    await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'someone-else' }),
    await login({ request: jsonRequest('https://x/api/sign/login', { student_ext_id: '904511', code }), env }),
  ];

  for (const res of responses) {
    const text = await res.text();
    assert.ok(!text.includes(code), `an access code leaked in a student-facing response: ${text}`);
    assert.ok(!/code_hash|pbkdf2/.test(text), 'a code hash leaked in a student-facing response');
  }
});

test('the credential export is the only place a plaintext code appears', async () => {
  const env = freshEnv();
  const { rosterId } = seedStudent(env._raw, { parentEmail: 'family@example.com' });
  await seedAccount(env._raw, rosterId, { code: 'ZZZZ9999' });

  const csv = await (await credentials({
    request: new Request('https://x/api/admin/credentials?course_id=1&reissue=1', { headers: ADMIN_HEADERS }), env,
  })).text();
  assert.match(csv, /,[2-9A-HJ-NP-Z]{8},http/, 'a freshly minted code belongs in the export');
});

test('the credential export refuses a request without Access', async () => {
  const env = freshEnv();
  const res = await credentials({ request: new Request('https://x/api/admin/credentials?course_id=1'), env });
  assert.equal(res.status, 401);
});

// ---- parsing parent emails out of the roster file ----

test('a Parent Email column is imported', async () => {
  const csv = 'Student ID,Last Name,First Name,Period,Parent Email\n1,Lee,Ann,3,Mom@Example.com\n';
  const { rows, warnings } = parseRoster(csv);
  assert.equal(rows[0].parent_email, 'mom@example.com', 'addresses are normalized to lowercase');
  assert.deepEqual(warnings, []);
});

test('Guardian Email and Parent/Guardian Email are recognised', () => {
  for (const header of ['Guardian Email', 'Parent/Guardian Email', 'Primary Contact Email', 'Parent_Email']) {
    const { rows } = parseRoster(`Student ID,Last Name,First Name,${header}\n1,Lee,Ann,mom@example.com\n`);
    assert.equal(rows[0].parent_email, 'mom@example.com', `${header} should map to parent_email`);
  }
});

test("Aeries' own field names are recognised", () => {
  // Aeries emits the raw STU field codes when columns are not renamed on
  // export: PEM is the parent email address, SEM the student's.
  for (const header of ['PEM', 'STU.PEM', 'Parent Email Address']) {
    const { rows } = parseRoster(`Student ID,Last Name,First Name,${header}\n1,Lee,Ann,mom@example.com\n`);
    assert.equal(rows[0].parent_email, 'mom@example.com', `${header} should map to parent_email`);
  }
  for (const header of ['SEM', 'STU.SEM', 'Student Email Address']) {
    const { rows } = parseRoster(`Student ID,Last Name,First Name,${header}\n1,Lee,Ann,ann@student.edu\n`);
    assert.equal(rows[0].parent_email, null, `${header} is the student's own address, not a parent's`);
  }
});

test('an Aeries export with both PEM and SEM takes only PEM', () => {
  const { rows, warnings } = parseRoster(
    'Student ID,Last Name,First Name,SEM,PEM\n1,Lee,Ann,ann@student.edu,mom@example.com\n',
  );
  assert.equal(rows[0].parent_email, 'mom@example.com');
  assert.deepEqual(warnings, []);
});

test('a bare Email column is reported, not adopted', () => {
  const { rows, warnings } = parseRoster('Student ID,Last Name,First Name,Email\n1,Lee,Ann,ann.lee@student.school.edu\n');
  assert.equal(rows[0].parent_email, null,
    'a bare Email column is usually the student address; adopting it would mail links to students');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Parent Email/);
});

test('a Student Email column is never mistaken for a parent address', () => {
  const { rows, warnings } = parseRoster('Student ID,Last Name,First Name,Student Email\n1,Lee,Ann,ann@student.edu\n');
  assert.equal(rows[0].parent_email, null);
  assert.deepEqual(warnings, [], 'an explicit student column is unambiguous, so there is nothing to warn about');
});

test('partial email coverage is counted for the teacher', () => {
  const { warnings } = parseRoster('Student ID,Last Name,First Name,Parent Email\n1,Lee,Ann,mom@example.com\n2,Ray,Bob,\n');
  assert.match(warnings[0], /1 of 2 students have no parent email/);
});

test('a later export that omits emails does not blank the ones on file', async () => {
  const env = freshEnv();
  const withEmail = 'Student ID,Last Name,First Name,Period,Parent Email\n1,Lee,Ann,3,mom@example.com\n';
  const without = 'Student ID,Last Name,First Name,Period\n1,Lee,Ann,3\n';
  const upload = (body) =>
    uploadRoster({ request: new Request('https://x/api/admin/roster?course=Algebra%20I', { method: 'POST', headers: ADMIN_HEADERS, body }), env });

  await upload(withEmail);
  await upload(without);

  assert.equal(env._raw.prepare('SELECT parent_email FROM roster').get().parent_email, 'mom@example.com',
    'a working contact must survive an export that simply lacks the column');
});
