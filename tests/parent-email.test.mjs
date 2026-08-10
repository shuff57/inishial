// Who may set the family contact address, and how a wrong one is repaired.
//
// This used to be a one-way door. The parent self-signup page set the address
// on the FIRST request and refused every other one afterwards, and nothing in
// the app could change it -- not the teacher, not a corrected roster upload,
// because the override wins over the roster. A single typo therefore:
//
//   - mailed a working parent code AND the student's code to whatever inbox
//     was typed, which for a plausible slip (gmial.com) is a domain someone
//     else owns, and
//   - locked the real family out permanently.
//
// Setting the address is now the teacher's job, and request-code only ever
// reads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedSchoolRoster, seedAccount, jsonRequest, mailEnv, ADMIN_HEADERS } from './helpers.mjs';
import { onRequestPost as register } from '../functions/api/register.js';
import { onRequestPost as requestCode } from '../functions/api/sign/request-code.js';
import { onRequestGet as credentials, onRequestPatch as patchEmail } from '../functions/api/admin/credentials.js';

const ask = (env, body) =>
  requestCode({ request: jsonRequest('https://x/api/sign/request-code', body), env });

const setEmail = (env, body, headers = ADMIN_HEADERS) =>
  patchEmail({ request: jsonRequest('https://x/api/admin/credentials', body, headers), env });

const forStudent = (email) => ({ student_ext_id: '904511', last: 'Alvarez', email });

// ---- request-code cannot set the address ----

test('with no address on file anywhere, no mail goes and nothing is written', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    await seedStudent(env, { parentEmail: null });
    await register({ request: jsonRequest('https://x/api/register', { student_ext_id: '904511', last: 'Alvarez' }), env });

    const res = await ask(env, forStudent('whoever@example.com'));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Ask their teacher/);
    assert.equal(sent.length, 0, 'credentials must not go to an address nobody has verified');
    assert.equal(
      env._raw.prepare('SELECT parent_email FROM student_identities').get().parent_email, null,
      'and the address must not become the lock',
    );
  } finally { restore(); }
});

test('a first request can no longer claim the family contact', async () => {
  // The old behaviour, stated as what must NOT happen: whoever asked first won
  // the address for good.
  const { env, sent, restore } = mailEnv();
  try {
    await seedStudent(env, { parentEmail: null });
    await register({ request: jsonRequest('https://x/api/register', { student_ext_id: '904511', last: 'Alvarez' }), env });

    await ask(env, forStudent('stranger@example.com'));
    // The real parent is not locked out by the attempt, because nothing stuck.
    const stored = env._raw.prepare('SELECT parent_email FROM student_identities').get().parent_email;
    assert.equal(stored, null);
    assert.equal(sent.length, 0);
  } finally { restore(); }
});

// ---- the teacher's repair ----

test('a teacher can clear an override and the roster address applies again', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    // The state a typo used to leave behind: an override nobody can shift,
    // with the correct address sitting on the roster being ignored.
    const { rosterId } = await seedStudent(env, { parentEmail: 'family@example.com' });
    const { accountId } = await seedAccount(env._raw, rosterId, { parentEmail: 'parnet@gmial.com' });

    assert.equal((await ask(env, forStudent('family@example.com'))).status, 400,
      'the roster address is refused while the typo holds the override');

    const cleared = await setEmail(env, { account_id: accountId, parent_email: '' });
    assert.equal(cleared.status, 200);
    const body = await cleared.json();
    assert.equal(body.email, 'family@example.com', 'falls back to the roster');
    assert.equal(body.email_source, 'roster');

    // And the family is reachable again.
    const now = await ask(env, forStudent('family@example.com'));
    assert.equal(now.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'family@example.com');
  } finally { restore(); }
});

test('a teacher can set an address for a student who has none', async () => {
  const { env, sent, restore } = mailEnv();
  try {
    const { rosterId } = await seedStudent(env, { parentEmail: null });
    const { accountId } = await seedAccount(env._raw, rosterId, { parentEmail: null });

    assert.equal((await ask(env, forStudent('mum@example.com'))).status, 400, 'nothing on file yet');

    const set = await setEmail(env, { account_id: accountId, parent_email: 'mum@example.com' });
    assert.equal(set.status, 200);
    assert.equal((await set.json()).email_source, 'student-supplied');

    const res = await ask(env, forStudent('mum@example.com'));
    assert.equal(res.status, 200);
    assert.equal(sent[0].to, 'mum@example.com');
  } finally { restore(); }
});

test('the address the teacher sets is the only one accepted', async () => {
  const env = freshEnv({ CODE_SECRET: 'test-code-secret-at-least-16-chars' });
  const { rosterId } = await seedStudent(env, { parentEmail: null });
  const { accountId } = await seedAccount(env._raw, rosterId, { parentEmail: null });
  await setEmail(env, { account_id: accountId, parent_email: 'mum@example.com' });

  const other = await ask(env, forStudent('someone.else@example.com'));
  assert.equal(other.status, 400);
  assert.match((await other.json()).error, /doesn't match the one on file/);
});

test('a malformed address is refused', async () => {
  const env = freshEnv();
  const { rosterId } = await seedStudent(env, { parentEmail: null });
  const { accountId } = await seedAccount(env._raw, rosterId, { parentEmail: null });
  const res = await setEmail(env, { account_id: accountId, parent_email: 'not-an-email' });
  assert.equal(res.status, 400);
});

// ---- the boundary ----

test('a teacher cannot touch another teacher\'s student', async () => {
  const env = freshEnv();
  const mine = await seedSchoolRoster(env, {
    school: 'Northside High', course: 'Algebra I', extId: '111111', first: 'A', last: 'One',
  });
  const theirs = await seedSchoolRoster(env, {
    school: 'Southside High', course: 'Geometry', extId: '222222', first: 'B', last: 'Two',
  });
  const seat = await seedAccount(env._raw, theirs.rosterId, { parentEmail: 'their.family@example.com' });

  // Signed in as the teacher who owns the OTHER course.
  const asMine = { 'Cf-Access-Authenticated-User-Email': 'nobody@school.edu' };
  const res = await patchEmail({
    request: jsonRequest('https://x/api/admin/credentials',
      { account_id: seat.accountId, parent_email: 'attacker@example.com' }, asMine),
    env,
  });
  assert.notEqual(res.status, 200);
  assert.equal(
    env._raw.prepare('SELECT parent_email FROM student_identities WHERE id = ?').get(seat.identityId).parent_email,
    'their.family@example.com',
    'the address must be untouched',
  );
  void mine;
});

test('signing in is required at all', async () => {
  const env = freshEnv();
  const { rosterId } = await seedStudent(env, { parentEmail: null });
  const { accountId } = await seedAccount(env._raw, rosterId, { parentEmail: null });
  const res = await patchEmail({
    request: jsonRequest('https://x/api/admin/credentials', { account_id: accountId, parent_email: 'x@example.com' }),
    env,
  });
  assert.equal(res.status, 401);
});

test('the codes page shows the change', async () => {
  const env = freshEnv({ CODE_SECRET: 'test-code-secret-at-least-16-chars' });
  const { rosterId, courseId } = await seedStudent(env, { parentEmail: 'family@example.com' });
  const { accountId } = await seedAccount(env._raw, rosterId, { parentEmail: 'typo@example.com' });

  await setEmail(env, { account_id: accountId, parent_email: '' });

  const page = await (await credentials({
    request: new Request(`https://x/api/admin/credentials?course_id=${courseId}&format=json`, { headers: ADMIN_HEADERS }),
    env,
  })).json();
  assert.equal(page.students[0].email, 'family@example.com');
  assert.equal(page.students[0].email_source, 'roster');
});
