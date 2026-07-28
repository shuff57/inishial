// Teacher sign-up, and the course isolation it exists to make possible.
//
// Two things are being pinned here, and the second is the one that matters:
//
//   1. Only an address at the school's domain can create an account.
//   2. An account sees ONLY its own courses. Rosters carry student names,
//      student IDs and parent email addresses, so one teacher reading another
//      teacher's class is a PII disclosure, not a UI wart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedSyllabus, seedAccount, ADMIN_HEADERS, jsonRequest, cookieFrom } from './helpers.mjs';
import { hashCode } from '../functions/_lib/codes.js';
import { onRequestPost as signup, onRequestGet as signupInfo } from '../functions/api/admin/signup.js';
import { onRequestPost as login } from '../functions/api/admin/login.js';
import { onRequestGet as courses } from '../functions/api/admin/roster.js';
import { onRequestGet as progress } from '../functions/api/admin/progress.js';
import { onRequestGet as credentials } from '../functions/api/admin/credentials.js';
import { onRequestGet as syllabusGet, onRequestPut as publish } from '../functions/api/admin/syllabus.js';
import { onRequestGet as signedRecord } from '../functions/admin/signed.js';
import { domainAllowed, passwordProblem, looksLikeEmail, listFrom } from '../functions/_lib/teachers.js';

const PASSWORD = 'chalk dust and coffee';
const DOMAIN = 'pvhs.example.org';

const env = (extra = {}) => freshEnv({ TEACHER_DOMAINS: DOMAIN, ADMIN_EMAILS: '', ...extra });

const create = (e, email, password = PASSWORD, name) =>
  signup({ request: jsonRequest('https://x/api/admin/signup', { email, password, name }), env: e });

const signIn = (e, email, password) =>
  login({ request: jsonRequest('https://x/api/admin/login', { email, password }), env: e });

const get = (e, url, cookie) =>
  new Request(url, { headers: cookie ? { Cookie: cookie } : {} });

/** Sign up and return the session cookie. */
async function teacher(e, email) {
  const res = await create(e, email);
  assert.equal(res.status, 200, `sign-up failed: ${await res.clone().text()}`);
  return cookieFrom(res);
}

// ---- the domain gate ----

test('an address at the school domain gets an account', async () => {
  const e = env();
  const res = await create(e, 'S.Huff@' + DOMAIN, PASSWORD, 'S. Huff');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).email, 's.huff@' + DOMAIN, 'stored and returned lowercased');
  assert.match(res.headers.get('Set-Cookie'), /HttpOnly/, 'sign-up signs you in');
});

test('an address anywhere else is refused', async () => {
  const e = env();
  for (const email of ['teacher@gmail.com', 'teacher@notpvhs.example.org', `teacher@evil.com#@${DOMAIN}`]) {
    const res = await create(e, email);
    assert.equal(res.status, 400, `${email} was let through`);
  }
});

test('a lookalike domain that merely ends the right way is refused', async () => {
  // `endsWith` on the whole address is the classic mistake here: it accepts
  // both of these, and the second is a domain an attacker can register.
  const e = env();
  assert.equal((await create(e, `teacher@x${DOMAIN}`)).status, 400);
  assert.equal((await create(e, `teacher@evil-${DOMAIN}`)).status, 400);
});

test('subdomains are opt-in, not automatic', () => {
  assert.equal(domainAllowed('t@math.school.org', ['school.org']), false);
  assert.equal(domainAllowed('t@math.school.org', ['.school.org']), true);
  assert.equal(domainAllowed('t@school.org', ['.school.org']), true, 'the apex counts too');
  assert.equal(domainAllowed('t@notschool.org', ['.school.org']), false);
});

test('no configured domain means sign-up is off, not open', async () => {
  const e = freshEnv({ TEACHER_DOMAINS: '' });
  assert.equal((await create(e, 'anyone@anywhere.com')).status, 403);
  assert.equal(domainAllowed('t@school.org', []), false, 'an empty list can never allow');
  assert.equal((await signupInfo({ env: e }).json()).available, false);
});

test('the page is told which domains to ask for', async () => {
  const body = await signupInfo({ env: env() }).json();
  assert.equal(body.available, true);
  assert.deepEqual(body.domains, [DOMAIN]);
});

test('listFrom tolerates the spacing people actually type', () => {
  assert.deepEqual(listFrom(' A.org , b.ORG ,,'), ['a.org', 'b.org']);
  assert.deepEqual(listFrom(undefined), []);
});

test('a malformed address is refused before the domain check', async () => {
  const e = env();
  for (const bad of ['', 'teacher', 'teacher@', '@' + DOMAIN, 'a b@' + DOMAIN, 'teacher@localhost']) {
    assert.equal((await create(e, bad)).status, 400, `${bad} was accepted`);
  }
  assert.equal(looksLikeEmail('a.b+tag@sub.school.org'), true, 'ordinary addresses still pass');
});

// ---- passwords ----

test('a short password is refused', async () => {
  assert.equal((await create(env(), 'a@' + DOMAIN, 'short')).status, 400);
  assert.match(passwordProblem('short'), /12 characters/);
});

test('a password containing the email address is refused', () => {
  assert.match(passwordProblem('SHuff-SHuff-SHuff', 'shuff@' + DOMAIN), /email address/);
  assert.equal(passwordProblem('chalk dust and coffee', 'shuff@' + DOMAIN), null);
});

test('the password is stored hashed, never in the clear', async () => {
  const e = env();
  await create(e, 'a@' + DOMAIN);
  const row = e._raw.prepare('SELECT password_hash FROM teachers').get();
  assert.match(row.password_hash, /^pbkdf2\$\d+\$/);
  assert.ok(!row.password_hash.includes(PASSWORD));
});

// ---- one account per address ----

test('the same address cannot be claimed twice', async () => {
  const e = env();
  assert.equal((await create(e, 'a@' + DOMAIN)).status, 200);
  const res = await create(e, 'A@' + DOMAIN, 'a different password entirely');
  assert.equal(res.status, 409, 'case must not be a way around the unique index');
  assert.equal((await res.json()).taken, true);
});

// ---- sign-in ----

test('a teacher signs in with their email and password', async () => {
  const e = env();
  await create(e, 'a@' + DOMAIN);
  const res = await signIn(e, 'A@' + DOMAIN, PASSWORD);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Set-Cookie'), /HttpOnly/);
  assert.ok(e._raw.prepare('SELECT last_login_at FROM teachers').get().last_login_at);
});

test('a wrong password is refused, and says nothing about which half was wrong', async () => {
  const e = env();
  await create(e, 'a@' + DOMAIN);
  const wrongPass = await signIn(e, 'a@' + DOMAIN, 'not the password at all');
  const noSuch = await signIn(e, 'nobody@' + DOMAIN, PASSWORD);
  assert.equal(wrongPass.status, 401);
  assert.equal(noSuch.status, 401);
  assert.equal((await wrongPass.json()).error, (await noSuch.json()).error,
    'a different message would enumerate which addresses have accounts');
});

test('the shared admin password still works alongside teacher accounts', async () => {
  const e = env({ ADMIN_PASSWORD_HASH: await hashCode('the-shared-one-9999') });
  await create(e, 'a@' + DOMAIN);
  const res = await login({ request: jsonRequest('https://x/api/admin/login', { password: 'the-shared-one-9999' }), env: e });
  assert.equal(res.status, 200);
  assert.equal((await courses({ request: get(e, 'https://x/api/admin/roster', cookieFrom(res)), env: e })).status, 200);
});

// ---- course isolation ----

/** Two teachers, one course each, plus a student in the first teacher's class. */
async function twoTeachers() {
  const e = env();
  const alice = await teacher(e, 'alice@' + DOMAIN);
  const bob = await teacher(e, 'bob@' + DOMAIN);
  const ids = e._raw.prepare('SELECT id, email FROM teachers ORDER BY id').all();
  const aliceId = ids.find((t) => t.email.startsWith('alice')).id;
  const bobId = ids.find((t) => t.email.startsWith('bob')).id;

  const { courseId, rosterId } = seedStudent(e._raw, { course: 'Statistics' });
  e._raw.prepare('UPDATE courses SET owner_id = ? WHERE id = ?').run(aliceId, courseId);
  const { accountId } = await seedAccount(e._raw, rosterId);
  const { syllabusId } = seedSyllabus(e._raw, courseId, [{ type: 'initial', html: 'I agree.', needs_initials: true }]);

  // Bob has a class of his own, so "sees nothing" is distinguishable from
  // "sees an empty list because nothing exists".
  const bobCourse = Number(e._raw.prepare('INSERT INTO courses (name, created_at, owner_id) VALUES (?, ?, ?)')
    .run('Statistics', 1000, bobId).lastInsertRowid);

  return { e, alice, bob, courseId, bobCourse, accountId, syllabusId };
}

test("a teacher's course list holds only their own", async () => {
  const { e, alice, bob, courseId, bobCourse } = await twoTeachers();
  const listFor = async (cookie) => (await (await courses({ request: get(e, 'https://x/api/admin/roster', cookie), env: e })).json()).courses;

  assert.deepEqual((await listFor(alice)).map((c) => c.id), [courseId]);
  assert.deepEqual((await listFor(bob)).map((c) => c.id), [bobCourse]);
});

test('two teachers may both have a course of the same name', async () => {
  const { e, courseId, bobCourse } = await twoTeachers();
  assert.notEqual(courseId, bobCourse);
  const names = e._raw.prepare('SELECT name FROM courses').all().map((c) => c.name);
  assert.deepEqual(names, ['Statistics', 'Statistics'],
    'course names are not unique across a school, and must not have to be');
});

test("another teacher cannot read a class's progress, codes, or syllabus", async () => {
  const { e, bob, courseId } = await twoTeachers();
  const q = `?course_id=${courseId}`;
  for (const [what, handler, url] of [
    ['progress', progress, 'https://x/api/admin/progress' + q],
    ['credentials', credentials, 'https://x/api/admin/credentials' + q],
    ['syllabus', syllabusGet, 'https://x/api/admin/syllabus' + q],
  ]) {
    const res = await handler({ request: get(e, url, bob), env: e });
    assert.equal(res.status, 400, `${what} served another teacher's course`);
    assert.match((await res.json()).error, /No such course/,
      'and must not confirm the course exists');
  }
});

test('the credentials export is the one that matters most', async () => {
  // Parent email addresses and live access codes for every student in a class.
  const { e, bob, alice, courseId } = await twoTeachers();
  const url = `https://x/api/admin/credentials?course_id=${courseId}`;
  assert.equal((await credentials({ request: get(e, url, bob), env: e })).status, 400);

  const mine = await credentials({ request: get(e, url, alice), env: e });
  assert.equal(mine.status, 200);
  assert.match(await mine.text(), /Alvarez/);
});

test("another teacher cannot open a student's signed record", async () => {
  const { e, alice, bob, accountId } = await twoTeachers();
  const url = `https://x/admin/signed?account_id=${accountId}`;
  assert.equal((await signedRecord({ request: get(e, url, bob), env: e })).status, 400);
  assert.equal((await signedRecord({ request: get(e, url, alice), env: e })).status, 200);
});

test('another teacher cannot publish over a syllabus', async () => {
  // Publishing is addressed by syllabus_id rather than course_id, so it needs
  // its own check -- and it is the one action that resets who has signed.
  const { e, bob, syllabusId } = await twoTeachers();
  const res = await publish({
    request: new Request('https://x/api/admin/syllabus', {
      method: 'PUT',
      headers: { Cookie: bob, 'Content-Type': 'application/json' },
      body: JSON.stringify({ syllabus_id: syllabusId }),
    }),
    env: e,
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /No such syllabus/);
});

// ---- the site owner ----

test('a Cloudflare Access identity still sees every course', async () => {
  const { e, courseId, bobCourse } = await twoTeachers();
  const res = await courses({ request: new Request('https://x/api/admin/roster', { headers: ADMIN_HEADERS }), env: e });
  const ids = (await res.json()).courses.map((c) => c.id).sort();
  assert.deepEqual(ids, [courseId, bobCourse].sort(),
    'the deployment owner is not scoped to a teacher account');
});

test('the first sign-up adopts courses that predate teacher accounts', async () => {
  const e = env();
  const { courseId } = seedStudent(e._raw);
  assert.equal(e._raw.prepare('SELECT owner_id FROM courses WHERE id = ?').get(courseId).owner_id, null);

  await create(e, 'first@' + DOMAIN);
  const owner = e._raw.prepare('SELECT owner_id FROM courses WHERE id = ?').get(courseId).owner_id;
  assert.equal(owner, e._raw.prepare('SELECT id FROM teachers').get().id);

  // And the second teacher inherits nothing.
  await create(e, 'second@' + DOMAIN);
  assert.equal(e._raw.prepare('SELECT owner_id FROM courses WHERE id = ?').get(courseId).owner_id, owner);
});

test('with ADMIN_EMAILS set, only that address adopts them', async () => {
  const e = env({ ADMIN_EMAILS: 'owner@' + DOMAIN });
  const { courseId } = seedStudent(e._raw);

  await create(e, 'someone.else@' + DOMAIN);
  assert.equal(e._raw.prepare('SELECT owner_id FROM courses WHERE id = ?').get(courseId).owner_id, null,
    'a colleague signing up first must not walk off with the deployment owner\'s classes');

  await create(e, 'owner@' + DOMAIN);
  assert.ok(e._raw.prepare('SELECT owner_id FROM courses WHERE id = ?').get(courseId).owner_id);
});

// ---- rate limiting ----

test('sign-up is rate limited', async () => {
  const e = env();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await create(e, `t${i}@` + DOMAIN)).status);
  assert.ok(codes.includes(429), `expected a 429 among ${codes}`);
});
