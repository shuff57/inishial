// Registration, parent-email precedence, and the rule that an access code
// never reaches a student.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedAccount, seedSyllabus, cookieFrom, ADMIN_HEADERS, jsonRequest } from './helpers.mjs';
import { onRequestPost as register } from '../functions/api/register.js';
import { onRequestPost as uploadRoster } from '../functions/api/admin/roster.js';
import { onRequestGet as credentials } from '../functions/api/admin/credentials.js';
import { onRequestPost as login } from '../functions/api/sign/login.js';
import { onRequestGet as syllabus } from '../functions/api/sign/syllabus.js';
import { onRequestPost as initial } from '../functions/api/sign/initial.js';
import { parseRoster } from '../functions/_lib/csv.js';
import { hashCode } from '../functions/_lib/codes.js';

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

// ---- registration hands the student their own copy to initial ----

const BLOCKS = [
  { type: 'heading', html: '<h2>Late work</h2>' },
  { type: 'initial', html: 'I have read the late work policy.', needs_initials: true },
  { type: 'initial', html: 'I have read the attendance policy.', needs_initials: true },
];

test('registering issues a student session, so the syllabus is reachable at once', async () => {
  const env = freshEnv();
  const { courseId } = seedStudent(env._raw, { parentEmail: 'family@example.com' });
  seedSyllabus(env._raw, courseId, BLOCKS);

  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez' });
  const cookie = cookieFrom(res);
  assert.ok(cookie.startsWith('inishial_session='), 'registration should hand back a session');
  assert.equal((await res.json()).next, '/sign/');

  const doc = await (await syllabus({ request: new Request('https://x/api/sign/syllabus', { headers: { Cookie: cookie } }), env })).json();
  assert.equal(doc.role, 'student', 'the session registration issues signs as the student, never the parent');
  assert.equal(doc.progress.required, 2);
});

test('a registration session cannot sign as the parent', async () => {
  const env = freshEnv();
  const { courseId } = seedStudent(env._raw, { parentEmail: 'family@example.com' });
  seedSyllabus(env._raw, courseId, BLOCKS);

  const cookie = cookieFrom(await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez' }));
  const blockId = env._raw.prepare('SELECT id FROM blocks WHERE needs_initials = 1 ORDER BY ord').get().id;

  await initial({ request: jsonRequest('https://x/api/sign/initial', { block_id: blockId, initials: 'MA' }, { Cookie: cookie }), env });

  const roles = env._raw.prepare('SELECT role FROM signatures').all().map((r) => r.role);
  assert.deepEqual(roles, ['student'], 'a student session must never write a parent attestation');
});

test('student and parent initials land on the same student, counted apart', async () => {
  const env = freshEnv();
  const { courseId, rosterId } = seedStudent(env._raw, { parentEmail: 'family@example.com' });
  seedSyllabus(env._raw, courseId, BLOCKS);

  // The student registers and initials both sections themselves.
  const studentCookie = cookieFrom(await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez' }));
  const blockIds = env._raw.prepare('SELECT id FROM blocks WHERE needs_initials = 1 ORDER BY ord').all().map((b) => b.id);
  for (const id of blockIds) {
    await initial({ request: jsonRequest('https://x/api/sign/initial', { block_id: id, initials: 'MA' }, { Cookie: studentCookie }), env });
  }

  // The teacher's export mints the code onto the account the student created.
  const code = 'ABCD2345';
  env._raw.prepare('UPDATE accounts SET code_hash = ?, code_issued_at = ? WHERE roster_id = ?')
    .run(await hashCode(code), 1000, rosterId);

  const parentCookie = cookieFrom(await login({
    request: jsonRequest('https://x/api/sign/login', { student_ext_id: '904511', code, role: 'parent' }), env,
  }));
  await initial({ request: jsonRequest('https://x/api/sign/initial', { block_id: blockIds[0], initials: 'JA' }, { Cookie: parentCookie }), env });

  const rows = env._raw.prepare('SELECT role, initials, account_id FROM signatures ORDER BY role, block_id').all();
  assert.equal(new Set(rows.map((r) => r.account_id)).size, 1, 'both roles must record against the one student account');
  assert.deepEqual(rows.map((r) => `${r.role}:${r.initials}`), ['parent:JA', 'student:MA', 'student:MA']);

  // The parent's view shows only the parent's own progress, not the student's.
  const parentDoc = await (await syllabus({ request: new Request('https://x/api/sign/syllabus', { headers: { Cookie: parentCookie } }), env })).json();
  assert.equal(parentDoc.progress.signed, 1, "the student's initials must not complete the parent's copy");
  assert.equal(parentDoc.progress.required, 2);
});

// ---- coming back the next day ----

test('a returning student gets a session back, not a 409', async () => {
  const env = freshEnv();
  const { courseId } = seedStudent(env._raw, { parentEmail: 'family@example.com' });
  seedSyllabus(env._raw, courseId, BLOCKS);

  const first = cookieFrom(await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez' }));
  const blockIds = env._raw.prepare('SELECT id FROM blocks WHERE needs_initials = 1 ORDER BY ord').all().map((b) => b.id);
  await initial({ request: jsonRequest('https://x/api/sign/initial', { block_id: blockIds[0], initials: 'MA' }, { Cookie: first }), env });

  // The next day: no code, no username, just the ID and last name off their card.
  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.returning, true);
  assert.equal(body.username, 'malvarez', 'the username they picked is theirs to keep');

  const doc = await (await syllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: { Cookie: cookieFrom(res) } }), env,
  })).json();
  assert.equal(doc.role, 'student');
  assert.equal(doc.progress.signed, 1, 'work already done is still there');
});

test('re-entry does not create a second account or change the first', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });

  await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez' });
  await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'someone-else' });

  const rows = env._raw.prepare('SELECT username FROM accounts').all();
  assert.deepEqual(rows.map((r) => r.username), ['malvarez'],
    're-entry must not mint a second account or let the username be reassigned');
});

test('a wrong last name is refused even once the account exists', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez' });

  const res = await post(env, { student_ext_id: '904511', last: 'Wrong' });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('Set-Cookie'), null, 'no session for a failed match');
});

test('re-entry does not reset the rate limiter', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  await post(env, { student_ext_id: '904511', last: 'Alvarez', username: 'malvarez' });

  // Holding one valid ID and last name must not buy an attacker a fresh budget
  // of roster guesses between every successful re-entry.
  let refused = false;
  for (let i = 0; i < 40; i++) {
    const res = await post(env, { student_ext_id: '904511', last: 'Alvarez' });
    if (res.status === 429) { refused = true; break; }
  }
  assert.ok(refused, 'repeated re-entry must eventually hit the limiter');
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
