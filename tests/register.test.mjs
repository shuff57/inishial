// Registration, parent-email precedence, and the rule that an access code
// never reaches a student.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedSchoolRoster, seedAccount, seedSyllabus, cookieFrom, ADMIN_HEADERS, jsonRequest, parentLogin, studentLogin } from './helpers.mjs';
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

  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez' });
  const body = await res.json();

  assert.equal(res.status, 201);
  // The message is what the student is actually told, so it is what is asserted.
  // A `has_contact` boolean used to ride along beside it saying the same thing;
  // nothing ever read it but this line.
  assert.match(body.message, /Your teacher will email your parent or guardian/);
  assert.ok(!/no parent email on file/.test(body.message));
  assert.equal(env._raw.prepare('SELECT si.parent_email FROM student_identities si JOIN accounts a ON a.identity_id = si.id').get().parent_email, null,
    'no override is stored when the student did not supply one');
});

test('a student never sees a parent email address, in any form', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'jennifer.alvarez@example.com' });

  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez' });
  const text = await res.text();

  assert.ok(!text.includes('jennifer.alvarez@example.com'), 'the full address leaked');
  assert.ok(!text.includes('jennifer'), 'part of the local address leaked');
  assert.ok(!text.includes('example.com'), 'the domain leaked');
  // This used to be "no @ anywhere". The student's own school email now comes
  // back -- they typed it two seconds ago -- so the check names the one address
  // allowed instead of banning the character. Any OTHER address is still a leak.
  assert.deepEqual(text.match(/[^\s"@]+@[^\s",}]+/g) ?? [], ['904511@s1'],
    'no address but the student\'s own belongs in a student-facing response');
  assert.ok(!text.includes('•'), 'nor a masked one');
  // The student is still told the mail is going out -- just not to whom. Saying
  // THAT there is an address on file is safe; saying which one is the leak.
  assert.match(JSON.parse(text).message, /Your teacher will email your parent or guardian/);
});

test('the username is auto-generated from the student ID', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: null });

  const ok = await post(env, { student_ext_id: '904511', last: 'Alvarez' });
  assert.equal(ok.status, 201);
  assert.equal(env._raw.prepare('SELECT si.username FROM student_identities si JOIN accounts a ON a.identity_id = si.id').get().username, '904511@s1');
});

test('the address a student supplies is not echoed back either', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: null });

  const res = await post(env, {
    student_ext_id: '904511', last: 'Alvarez', parent_email: 'mom@example.com',
  });
  assert.ok(!(await res.text()).includes('mom@example.com'));
});

test('a student-supplied address overrides the roster one', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'old@example.com' });

  await post(env, { student_ext_id: '904511', last: 'Alvarez', parent_email: 'New@Example.com' });
  assert.equal(env._raw.prepare('SELECT si.parent_email FROM student_identities si JOIN accounts a ON a.identity_id = si.id').get().parent_email, 'New@Example.com');

  const csv = await (await credentials({
    request: new Request('https://x/api/admin/credentials?course_id=1', { headers: ADMIN_HEADERS }), env,
  })).text();
  assert.match(csv, /New@Example\.com,student-supplied/);
});

test('the roster address is used and labelled when the student adds nothing', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  await post(env, { student_ext_id: '904511', last: 'Alvarez' });

  const csv = await (await credentials({
    request: new Request('https://x/api/admin/credentials?course_id=1', { headers: ADMIN_HEADERS }), env,
  })).text();
  assert.match(csv, /family@example\.com,roster/);
});

test('a student with no contact anywhere is flagged, not blocked', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: null });

  const body = await (await post(env, { student_ext_id: '904511', last: 'Alvarez' })).json();
  assert.match(body.message, /no parent email on file/);

  const csv = await (await credentials({
    request: new Request('https://x/api/admin/credentials?course_id=1', { headers: ADMIN_HEADERS }), env,
  })).text();
  assert.match(csv, /,missing,/);
});

test('a malformed address is refused rather than silently dropped', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez', parent_email: 'not-an-email' });
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

  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez' });
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

  const cookie = cookieFrom(await post(env, { student_ext_id: '904511', last: 'Alvarez' }));
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
  const studentCookie = cookieFrom(await post(env, { student_ext_id: '904511', last: 'Alvarez' }));
  const blockIds = env._raw.prepare('SELECT id FROM blocks WHERE needs_initials = 1 ORDER BY ord').all().map((b) => b.id);
  for (const id of blockIds) {
    await initial({ request: jsonRequest('https://x/api/sign/initial', { block_id: id, initials: 'MA' }, { Cookie: studentCookie }), env });
  }

  // The teacher's export mints the code onto the identity the student created.
  const code = 'ABCD2345';
  const identityId = env._raw.prepare(
    'SELECT si.id FROM student_identities si JOIN accounts a ON a.identity_id = si.id WHERE a.roster_id = ?',
  ).get(rosterId).id;
  env._raw.prepare('UPDATE student_identities SET code_hash = ?, code_issued_at = ? WHERE id = ?')
    .run(await hashCode(code), 1000, identityId);

  const parentCookie = cookieFrom(await login({
    request: jsonRequest('https://x/api/sign/login', parentLogin(code)), env,
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
//
// Re-entry is /api/sign/login's job and always was: it takes the student's
// school email plus their own access code and hands back a student session.
// This endpoint used to accept the same two secrets under different field names
// and land the student on a "welcome back" card instead of the syllabus. It now
// says "you already have one" and points at /sign/.

test('a student who already registered is sent to /sign/, not signed in', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  await post(env, { student_ext_id: '904511', last: 'Alvarez' });

  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez' });
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.registered, true, 'the client tells this apart from a validation error');
  assert.equal(body.next, '/sign/');
  assert.equal(res.headers.get('Set-Cookie'), null, 'no session is minted on this path');
});

test('deleting the re-entry path strands nobody: the work is still reachable', async () => {
  const env = freshEnv();
  const { courseId } = seedStudent(env._raw, { parentEmail: 'family@example.com' });
  seedSyllabus(env._raw, courseId, BLOCKS);

  const firstRes = await post(env, { student_ext_id: '904511', last: 'Alvarez' });
  const STUDENT_CODE = (await firstRes.clone().json()).student_code;
  const blockIds = env._raw.prepare('SELECT id FROM blocks WHERE needs_initials = 1 ORDER BY ord').all().map((b) => b.id);
  await initial({
    request: jsonRequest('https://x/api/sign/initial', { block_id: blockIds[0], initials: 'MA' },
      { Cookie: cookieFrom(firstRes) }), env,
  });

  // The next day, through the front door this time. Same two secrets the old
  // re-entry branch wanted, minus the last name it also asked for.
  const back = await login({
    request: jsonRequest('https://x/api/sign/login', {
      username: '904511@s1', code: STUDENT_CODE,
    }), env,
  });
  assert.equal(back.status, 200);

  const doc = await (await syllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: { Cookie: cookieFrom(back) } }), env,
  })).json();
  assert.equal(doc.role, 'student');
  assert.equal(doc.progress.signed, 1, 'work already done is still there');
});

test('re-entry does not create a second account or change the first', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });

  await post(env, { student_ext_id: '904511', last: 'Alvarez' });
  await post(env, { student_ext_id: '904511', last: 'Alvarez' });

  const rows = env._raw.prepare('SELECT si.username FROM student_identities si JOIN accounts a ON a.identity_id = si.id').all();
  assert.deepEqual(rows.map((r) => r.username), ['904511@s1'],
    're-entry must not mint a second account or let the username be reassigned');
});

test('a wrong last name is refused even once the account exists', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  await post(env, { student_ext_id: '904511', last: 'Alvarez' });

  const res = await post(env, { student_ext_id: '904511', last: 'Wrong' });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('Set-Cookie'), null, 'no session for a failed match');
});

test('re-entry does not reset the rate limiter', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  await post(env, { student_ext_id: '904511', last: 'Alvarez' });

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
    await post(env, { student_ext_id: '904511', last: 'Alvarez' }),
    await login({ request: jsonRequest('https://x/api/sign/login', parentLogin(code)), env }),
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
  // BOTH columns, and named separately. Asserting one 8-character code before
  // the link would have passed on the student column alone.
  assert.match(csv, /Parent username,Parent access code,Student username,Student access code,Link/);
  // Counted from the END: the Student column is "Last, First" and is quoted,
  // so splitting on commas from the left lands a field early. Trailing five,
  // in order: parent username, parent code, student username, student code, link.
  const cells = csv.trim().split('\r\n')[1].split(',');
  const [parentUser, parentCode, studentUser, studentCode] = cells.slice(-5, -1);
  assert.match(parentCode, /^[2-9A-HJ-NP-Z]{8}$/, 'a freshly minted parent code belongs in the export');
  assert.match(studentCode, /^[2-9A-HJ-NP-Z]{8}$/, 'and the teacher can hand the student theirs back');
  assert.notEqual(parentCode, studentCode, 'one code for both would be the hole this split closed');
  // Sign-in is username + code, so a code without its username is half a
  // credential and this export is where a lost one is looked up.
  assert.equal(parentUser, '904511@p1');
  assert.equal(studentUser, '904511@s1');
});

test('registering mints the student their own code, and it signs them in', async () => {
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });

  const body = await (await post(env, {
    student_ext_id: '904511', last: 'Alvarez',
  })).json();

  assert.match(body.student_code, /^[2-9A-HJ-NP-Z]{8}$/, 'shown once, on the confirmation screen');
  // Hashed at rest like every other code -- the screen above is the only
  // plaintext that ever exists.
  const stored = env._raw.prepare('SELECT si.student_code_hash FROM student_identities si JOIN accounts a ON a.identity_id = si.id').get().student_code_hash;
  assert.ok(stored && !stored.includes(body.student_code), 'the code was stored in the clear');

  const res = await login({ request: jsonRequest('https://x/api/sign/login', {
    username: '904511@s1', code: body.student_code,
  }), env });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, 'student', 'their own code brings them back as themselves');
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

test('an ID and a last name never open an existing account', async () => {
  // The point of the change. Both are printed on a class roster and visible on
  // an ID card, so on their own they must not let any classmate take a student
  // session and initial the syllabus as someone else. There is no combination
  // of fields that opens one here any more -- signing in only happens at
  // /api/sign/login, which wants the access code.
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });
  const reg = await (await post(env, {
    student_ext_id: '904511', last: 'Alvarez',
  })).json();

  for (const body of [
    { student_ext_id: '904511', last: 'Alvarez' },
    { student_ext_id: '904511', last: 'Alvarez' },
    // Even holding the real access code. This endpoint does not sign anyone in.
    { student_ext_id: '904511', last: 'Alvarez', student_code: reg.student_code },
  ]) {
    const res = await post(env, body);
    assert.equal(res.status, 409, `no session for ${JSON.stringify(body)}`);
    assert.equal(res.headers.get('Set-Cookie'), null, 'and no session is issued');
  }
});

// ---- school scoping: the same class of bug as request-code.js ----
//
// Lower risk here -- it also needs the last name -- but the same fix. See the
// school-scoping-and-identity plan, "Why: the leak, reproduced".

test('a shared student ID with a matching last name across two schools resolves only the caller\'s own school', async () => {
  const env = freshEnv();
  // Two unrelated students happen to share both an ID and a last name across
  // two schools -- the coincidence that makes this endpoint's bug reachable.
  const reyes = seedSchoolRoster(env._raw, {
    school: 'Northside High', course: 'Algebra I', extId: '123456', first: 'Ana', last: 'Reyes',
  });
  const other = seedSchoolRoster(env._raw, {
    school: 'Southside High', course: 'Geometry', extId: '123456', first: 'Amelia', last: 'Reyes',
  });

  const res = await post(env, {
    student_ext_id: '123456', last: 'Reyes', school_id: other.schoolId,
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.student, 'Amelia Reyes', 'the Southside student, not the Northside one');

  // Exactly one account, tied to the Southside roster row.
  const accounts = env._raw.prepare('SELECT roster_id FROM accounts').all();
  assert.deepEqual(accounts.map((a) => a.roster_id), [other.rosterId]);
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM accounts WHERE roster_id = ?').get(reyes.rosterId).n, 0,
    "the Northside student's roster row must remain unregistered");
});

test('both students behind a shared ID number can register, and each signs in as themselves', async () => {
  // The bug migrations/0013 fixes. The student username was `<id>@s` against a
  // globally UNIQUE column, so the SECOND school's student to register tripped
  // UNIQUE(username) and was told "that school email is already registered to
  // another student" -- about an address they never typed, with no way past it
  // ever. The school id in the username is what makes both reachable.
  const env = freshEnv();
  const north = seedSchoolRoster(env._raw, {
    school: 'Northside High', course: 'Algebra I', extId: '123456', first: 'Ana', last: 'Reyes',
  });
  const south = seedSchoolRoster(env._raw, {
    school: 'Southside High', course: 'Geometry', extId: '123456', first: 'Amelia', last: 'Reyes',
  });

  const first = await post(env, { student_ext_id: '123456', last: 'Reyes', school_id: south.schoolId });
  assert.equal(first.status, 201);
  const second = await post(env, { student_ext_id: '123456', last: 'Reyes', school_id: north.schoolId });
  assert.equal(second.status, 201, 'the second school must not be locked out by the first');

  const amelia = await first.json();
  const ana = await second.json();
  assert.notEqual(amelia.username, ana.username, 'two students, two usernames');
  assert.equal(amelia.username, `123456@s${south.schoolId}`);
  assert.equal(ana.username, `123456@s${north.schoolId}`);

  // And each code opens its own student's syllabus, never the other's.
  const mine = await login({ request: jsonRequest('https://x/api/sign/login',
    { username: ana.username, code: ana.student_code }), env });
  assert.equal(mine.status, 200);
  assert.equal((await mine.json()).student, 'Ana Reyes');

  const crossed = await login({ request: jsonRequest('https://x/api/sign/login',
    { username: amelia.username, code: ana.student_code }), env });
  assert.equal(crossed.status, 401, "the other student's code does not open this account");
});

test('a second enrolment shows no access code, because there is no new one', async () => {
  // The confirmation card printed the literal string "null" under "write this
  // down" here: an identity that already exists is not issued a fresh code, and
  // the response said so with a null the page rendered as text.
  const env = freshEnv();
  const a = seedSchoolRoster(env._raw, { school: 'Northside High', course: 'Algebra I', extId: '555555', first: 'Sam', last: 'Kim' });
  const firstReg = await (await post(env, { student_ext_id: '555555', last: 'Kim', school_id: a.schoolId })).json();
  assert.match(firstReg.student_code, /^[2-9A-HJ-NP-Z]{8}$/);

  // Enrolled in a second class after registering, then back through the form.
  seedSchoolRoster(env._raw, { school: 'Northside High', course: 'Geometry', extId: '555555', first: 'Sam', last: 'Kim' });
  const again = await post(env, { student_ext_id: '555555', last: 'Kim', school_id: a.schoolId });
  const body = await again.json();

  assert.equal(again.status, 201, 'the new enrolment is created');
  assert.equal(body.student_code, null, 'no second code is minted');
  assert.equal(body.username, firstReg.username, 'and the username does not change');
  assert.doesNotMatch(body.message, /write it down/i,
    'the card must not tell them to write down a code it is not showing');

  // The code they already hold is still the one that works.
  const back = await login({ request: jsonRequest('https://x/api/sign/login',
    { username: firstReg.username, code: firstReg.student_code }), env });
  assert.equal(back.status, 200);
});

test('a school that is not the roster row\'s is refused, not silently used', async () => {
  // The picker is on the form for every student, and at a ONE-school install
  // resolveSchoolScope filters nothing -- so nothing but this check stops a
  // wrong pick. It used to win: the identity was written under the submitted
  // school while the roster row lived at another, producing `904511@s52` for a
  // class at school 1. The parent side derives the school from the roster, so
  // it would then look up school 1, find no identity, and tell the family
  // their student had never registered.
  const env = freshEnv();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });   // unowned course -> school 1
  const other = Number(env._raw.prepare("INSERT INTO schools (name) VALUES ('Somewhere Else')").run().lastInsertRowid);

  const wrong = await post(env, { student_ext_id: '904511', last: 'Alvarez', school_id: other });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /don't match our class roster/,
    'the roster-miss message, so this cannot be asked which school an ID belongs to');
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM student_identities').get().n, 0,
    'and nothing is written on the way out');

  // The right one still works, and lands on the roster row's school.
  const ok = await post(env, { student_ext_id: '904511', last: 'Alvarez', school_id: 1 });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).username, '904511@s1');
  assert.equal(env._raw.prepare('SELECT school_id FROM student_identities').get().school_id, 1);
});

test('more than one school on the install requires a school_id', async () => {
  const env = freshEnv();
  seedSchoolRoster(env._raw, { school: 'Northside High', course: 'Algebra I', extId: '904511', last: 'Alvarez' });
  seedSchoolRoster(env._raw, { school: 'Southside High', course: 'Geometry', extId: '904512', last: 'Ortiz' });

  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez' });
  assert.equal(res.status, 400);
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0, 'no account without a resolved school');
});

test('a student enrolled in two courses at one school registers once and gets accounts for both', async () => {
  // The multi-class fix: a student with two active roster rows at one school
  // registers once and gets accounts for BOTH, sharing one identity_id.
  const env = freshEnv();
  const a = seedSchoolRoster(env._raw, { school: 'Northside High', course: 'Algebra I', extId: '555555', first: 'Sam', last: 'Kim' });
  seedSchoolRoster(env._raw, { school: 'Northside High', course: 'Trigonometry', extId: '555555', first: 'Sam', last: 'Kim' });

  const res = await post(env, { student_ext_id: '555555', last: 'Kim', school_id: a.schoolId });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.student, 'Sam Kim');

  // Both roster rows now have accounts sharing one identity_id.
  const accounts = env._raw.prepare('SELECT a.id, a.identity_id, a.roster_id FROM accounts a ORDER BY a.id').all();
  assert.equal(accounts.length, 2, 'accounts created: 2 of 2 enrolments');
  assert.equal(accounts[0].identity_id, accounts[1].identity_id, 'both accounts share one identity');
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM student_identities').get().n, 1, 'exactly one identity row');
});

test('a single-school install still registers a student behind an unowned legacy course', async () => {
  // seedStudent's course has no owner_id (migrations/0002's shape) and
  // freshEnv has no teacher assigned to any school yet -- migrations/0011's
  // seeded reference list doesn't count (schoolScope.js counts schools in
  // use, not every row in the table). Scoping must be a complete no-op here
  // -- every existing install is in this shape until a second school joins.
  const env = freshEnv();
  assert.equal(env._raw.prepare('SELECT COUNT(DISTINCT school_id) AS n FROM teachers').get().n, 0);
  seedStudent(env._raw, { parentEmail: 'family@example.com' });

  const res = await post(env, { student_ext_id: '904511', last: 'Alvarez' });
  assert.equal(res.status, 201);
});
