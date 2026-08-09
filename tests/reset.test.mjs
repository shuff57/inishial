// Teacher password reset: the way back into an account.
//
// Before this there was none. Nothing emailed a teacher address, so forgetting
// a password ended the account -- and the class with it, since the shared
// ADMIN_PASSWORD_HASH is scoped to `owner_id IS NULL` and cannot reach a
// signed-up teacher's own courses. That last part is asserted here, because it
// is the reason this endpoint had to exist rather than pointing people at the
// break-glass password.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, mailEnv, jsonRequest, cookieFrom } from './helpers.mjs';
import { onRequestPost as signup } from '../functions/api/admin/signup.js';
import { onRequestPost as adminLogin } from '../functions/api/admin/login.js';
import { onRequestPost as askReset, onRequestPut as setPassword } from '../functions/api/admin/reset.js';
import { onRequestGet as credentials } from '../functions/api/admin/credentials.js';
import { hashCode } from '../functions/_lib/codes.js';

const EMAIL = 'tracy@school.edu';
const OLD = 'correct horse battery';
const NEW = 'a different long phrase';

const ask = (env, email) =>
  askReset({ request: jsonRequest('https://x/api/admin/reset', { email }), env });

const set = (env, token, password) =>
  setPassword({ request: jsonRequest('https://x/api/admin/reset', { token, password }), env });

const signIn = (env, email, password) =>
  adminLogin({ request: jsonRequest('https://x/api/admin/login', { email, password }), env });

/** A signed-up teacher with one class of their own. Returns their id and the
 *  course id, which is the thing being locked out OF. */
async function teacher(env) {
  await signup({
    request: jsonRequest('https://x/api/admin/signup',
      { email: EMAIL, password: OLD, school: 'Northside High' }), env,
  });
  const id = env._raw.prepare('SELECT id FROM teachers WHERE email = ?').get(EMAIL).id;
  const courseId = Number(env._raw.prepare('INSERT INTO courses (name, created_at, owner_id) VALUES (?, ?, ?)')
    .run('Algebra I', 1000, id).lastInsertRowid);
  return { id, courseId };
}

/** Can this session reach that class? GET /api/admin/credentials is gated by
 *  ownedCourse(), so a 200 here means the course is genuinely theirs. */
const reach = (env, cookie, courseId) => credentials({
  request: new Request(`https://x/api/admin/credentials?course_id=${courseId}&format=json`,
    { headers: { Cookie: cookie } }),
  env,
});

/** The token out of the link in the mail that was actually sent. */
const tokenFrom = (mail) => new URL(mail.body.match(/https?:\/\/\S*?token=[^\s"<]+/)[0]).searchParams.get('token');

// ---- the whole errand ----

test('a locked-out teacher resets and gets back into their own class', async () => {
  const { env, sent, restore } = mailEnv({
    APP_URL: 'https://x',
    ADMIN_PASSWORD_HASH: await hashCode('the shared break-glass password'),
  });
  try {
    const { id: teacherId, courseId } = await teacher(env);

    // Locked out.
    assert.equal((await signIn(env, EMAIL, 'whatever I guessed')).status, 401);

    // And the shared break-glass password is NOT a way back to this class --
    // it is scoped to unowned courses, and this one has an owner. That is the
    // whole reason a reset had to exist.
    const sharedCookie = cookieFrom(await adminLogin({
      request: jsonRequest('https://x/api/admin/login', { password: 'the shared break-glass password' }), env,
    }));
    assert.notEqual((await reach(env, sharedCookie, courseId)).status, 200,
      'the shared password must not reach a signed-up teacher\'s class');

    // 1. Ask.
    const res = await ask(env, EMAIL);
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, EMAIL);
    assert.match(sent[0].subject, /reset/i);

    // 2. The token is stored HASHED -- the link lives in an inbox, so the
    //    database should not hold a second readable copy of it.
    const token = tokenFrom(sent[0]);
    const stored = env._raw.prepare('SELECT reset_hash FROM teachers WHERE id = ?').get(teacherId).reset_hash;
    assert.ok(stored.startsWith('pbkdf2$'));
    assert.ok(!stored.includes(token));

    // 3. Set a new password.
    assert.equal((await set(env, token, NEW)).status, 200);

    // 4. The new one works and the old one does not.
    assert.equal((await signIn(env, EMAIL, NEW)).status, 200);
    assert.equal((await signIn(env, EMAIL, OLD)).status, 401);

    // 5. And the class is theirs again -- which is what being locked out cost.
    const cookie = cookieFrom(await signIn(env, EMAIL, NEW));
    const back = await reach(env, cookie, courseId);
    assert.equal(back.status, 200);
    assert.equal((await back.json()).course, 'Algebra I');
  } finally { restore(); }
});

test('a reset ends sessions opened with the old password', async () => {
  // The reason a reset gets asked for is usually that someone else is in the
  // account. A new password beside a still-live old session does not answer
  // that, so the reset bumps the session generation (migrations/0016) and the
  // intruder is signed out on every device they hold.
  const { env, sent, restore } = mailEnv({ APP_URL: 'https://x' });
  try {
    const { courseId } = await teacher(env);

    // Someone is already in, holding a session from the old password.
    const intruder = cookieFrom(await signIn(env, EMAIL, OLD));
    assert.equal((await reach(env, intruder, courseId)).status, 200, 'in before the reset');

    await ask(env, EMAIL);
    assert.equal((await set(env, tokenFrom(sent[0]), NEW)).status, 200);

    assert.equal((await reach(env, intruder, courseId)).status, 401,
      'the old session must not survive the reset that was meant to end it');

    // And the real teacher's new session works.
    const owner = cookieFrom(await signIn(env, EMAIL, NEW));
    assert.equal((await reach(env, owner, courseId)).status, 200);
  } finally { restore(); }
});

// ---- the link is a credential ----

test('the link works once', async () => {
  const { env, sent, restore } = mailEnv({ APP_URL: 'https://x' });
  try {
    await teacher(env);
    await ask(env, EMAIL);
    const token = tokenFrom(sent[0]);

    assert.equal((await set(env, token, NEW)).status, 200);
    const again = await set(env, token, 'yet another long phrase');
    assert.equal(again.status, 400, 'a spent link cannot be replayed out of an inbox');
    assert.equal((await signIn(env, EMAIL, NEW)).status, 200, 'and the first reset still stands');
  } finally { restore(); }
});

test('an expired link is refused', async () => {
  const { env, sent, restore } = mailEnv({ APP_URL: 'https://x' });
  try {
    await teacher(env);
    await ask(env, EMAIL);
    const token = tokenFrom(sent[0]);
    env._raw.prepare('UPDATE teachers SET reset_expires_at = 1 WHERE email = ?').run(EMAIL);

    const res = await set(env, token, NEW);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /expired|already been used/);
    assert.equal((await signIn(env, EMAIL, OLD)).status, 200, 'the old password is untouched');
  } finally { restore(); }
});

test('a wrong token changes nothing', async () => {
  const { env, restore } = mailEnv({ APP_URL: 'https://x' });
  try {
    await teacher(env);
    await ask(env, EMAIL);
    assert.equal((await set(env, 'not-the-token', NEW)).status, 400);
    assert.equal((await signIn(env, EMAIL, OLD)).status, 200);
  } finally { restore(); }
});

test('a new request replaces the previous link', async () => {
  const { env, sent, restore } = mailEnv({ APP_URL: 'https://x' });
  try {
    await teacher(env);
    await ask(env, EMAIL);
    const first = tokenFrom(sent[0]);
    await ask(env, EMAIL);
    const second = tokenFrom(sent[1]);
    assert.notEqual(first, second);

    assert.equal((await set(env, first, NEW)).status, 400, 'the superseded link is dead');
    assert.equal((await set(env, second, NEW)).status, 200);
  } finally { restore(); }
});

// ---- what it refuses to tell you ----

test('an address with no account gets the same answer as one with', async () => {
  const { env, sent, restore } = mailEnv({ APP_URL: 'https://x' });
  try {
    await teacher(env);

    const real = await ask(env, EMAIL);
    const fake = await ask(env, 'nobody@school.edu');
    assert.equal(real.status, fake.status);

    // Byte for byte, with nothing excused. An earlier version of this test
    // compared the two with `dry_run` stripped out, and that is precisely how
    // the oracle it was meant to catch survived: the real address came back
    // with an extra key and the unknown one did not. A test that normalises
    // away a difference cannot see that difference.
    assert.equal(await real.text(), await fake.text(),
      'a differing answer would list who works at the school');
    assert.equal(sent.length, 1, 'and only the real one is actually mailed');
  } finally { restore(); }
});

test('a weak new password is refused, and the link survives to try again', async () => {
  const { env, sent, restore } = mailEnv({ APP_URL: 'https://x' });
  try {
    await teacher(env);
    await ask(env, EMAIL);
    const token = tokenFrom(sent[0]);

    const weak = await set(env, token, 'short');
    assert.equal(weak.status, 400);
    assert.match((await weak.json()).error, /at least 12/);

    // Not spent by the rejection -- otherwise one fat-fingered attempt costs
    // another round trip through an inbox.
    assert.equal((await set(env, token, NEW)).status, 200);
  } finally { restore(); }
});

test('a failed send does not leave a live token behind', async () => {
  // No mail credentials and no dry-run: the send fails honestly, so the reset
  // that was issued for it has to be taken back.
  const env = freshEnv();
  await teacher(env);

  const res = await ask(env, EMAIL);
  assert.equal(res.status, 502);
  const row = env._raw.prepare('SELECT reset_hash, reset_expires_at FROM teachers WHERE email = ?').get(EMAIL);
  assert.equal(row.reset_hash, null);
  assert.equal(row.reset_expires_at, null);
});

test('reset requests are rate limited', async () => {
  const { env, restore } = mailEnv({ APP_URL: 'https://x' });
  try {
    await teacher(env);
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await ask(env, EMAIL)).status);
    assert.ok(statuses.includes(429), `expected a 429 among ${statuses}`);
  } finally { restore(); }
});
