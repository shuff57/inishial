// The admin gate: a teacher password login, Cloudflare Access, or both.
//
// requireAdmin accepts either independently, so the app works with or without
// Zero Trust and gains edge-level protection for free if Access is added later.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedAccount, ADMIN_HEADERS, jsonRequest, cookieFrom, parentLogin } from './helpers.mjs';
import { hashCode } from '../functions/_lib/codes.js';
import { onRequestPost as adminLogin, onRequestDelete as adminLogout } from '../functions/api/admin/login.js';
import { onRequestPost as signup } from '../functions/api/admin/signup.js';
import { onRequestGet as rosterSummary } from '../functions/api/admin/roster.js';
import { onRequestGet as progress } from '../functions/api/admin/progress.js';
import { onRequestGet as credentials } from '../functions/api/admin/credentials.js';
import { onRequestPost as signLogin } from '../functions/api/sign/login.js';
import { onRequestGet as parentView } from '../functions/api/sign/syllabus.js';
import { signSession } from '../functions/_lib/session.js';

const PASSWORD = 'correct-horse-battery-staple';

async function adminEnv(extra = {}) {
  const env = freshEnv(extra);
  env.ADMIN_PASSWORD_HASH = await hashCode(PASSWORD);
  return env;
}

const login = (env, password) =>
  adminLogin({ request: jsonRequest('https://x/api/admin/login', { password }), env });

const summary = (env, headers = {}) =>
  rosterSummary({ request: new Request('https://x/api/admin/roster', { headers }), env });

// ---- password login ----

test('the correct password issues an admin session', async () => {
  const env = await adminEnv();
  const res = await login(env, PASSWORD);
  assert.equal(res.status, 200);

  const setCookie = res.headers.get('Set-Cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
});

test('that session opens the admin routes', async () => {
  const env = await adminEnv();
  const cookie = cookieFrom(await login(env, PASSWORD));
  const res = await summary(env, { Cookie: cookie });
  assert.equal(res.status, 200);
});

test('a wrong password is refused', async () => {
  const env = await adminEnv();
  assert.equal((await login(env, 'guess')).status, 401);
});

test('an empty password is refused before any hashing happens', async () => {
  const env = await adminEnv();
  assert.equal((await login(env, '')).status, 400);
});

test('admin login is rate limited harder than the parent flow', async () => {
  const env = await adminEnv();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await login(env, 'guess')).status);
  assert.ok(codes.includes(429), `expected a 429 among ${codes}`);
  assert.equal((await login(env, PASSWORD)).status, 429,
    'guessing correctly after the limit must not be rescued');
});

test('a misconfigured server says so rather than letting everyone in', async () => {
  const env = freshEnv();            // no ADMIN_PASSWORD_HASH
  const res = await login(env, PASSWORD);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /ADMIN_PASSWORD_HASH/);
  assert.equal((await summary(env)).status, 401, 'and the routes stay shut');
});

test('signing out clears the cookie, even with no session to end', async () => {
  const env = freshEnv();
  const res = await adminLogout({ request: new Request('https://x/api/admin/login', { method: 'DELETE' }), env });
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('a teacher cookie captured before a sign-out stops working', async () => {
  // The admin half of migration 0014's guarantee, added in 0016. It matters
  // more here than on the signer side: this token reaches every student's
  // name, ID, parent address and access code in the teacher's classes.
  const env = freshEnv();
  await signup({
    request: jsonRequest('https://x/api/admin/signup',
      { email: 'tracy@school.edu', password: 'correct horse battery', school: 'Northside High' }), env,
  });
  const cookie = cookieFrom(await adminLogin({
    request: jsonRequest('https://x/api/admin/login',
      { email: 'tracy@school.edu', password: 'correct horse battery' }), env,
  }));

  assert.equal((await summary(env, { Cookie: cookie })).status, 200, 'live before');

  await adminLogout({
    request: new Request('https://x/api/admin/login', { method: 'DELETE', headers: { Cookie: cookie } }), env,
  });

  assert.equal((await summary(env, { Cookie: cookie })).status, 401,
    'the token is dead, not merely dropped by one browser');

  // And signing back in immediately works -- the counter has no clock in it,
  // so there is no window where a fresh session is born rejected.
  const again = cookieFrom(await adminLogin({
    request: jsonRequest('https://x/api/admin/login',
      { email: 'tracy@school.edu', password: 'correct horse battery' }), env,
  }));
  assert.equal((await summary(env, { Cookie: again })).status, 200);
});

test('the shared password session is cleared but cannot be revoked', async () => {
  // Honest about the limit: sub 0 is not a row, so there is no counter to
  // bump. Rotating ADMIN_PASSWORD_HASH is what ends those sessions. Asserted
  // so the property is recorded rather than discovered.
  const env = await adminEnv();
  const cookie = cookieFrom(await login(env, PASSWORD));
  assert.equal((await summary(env, { Cookie: cookie })).status, 200);

  const out = await adminLogout({
    request: new Request('https://x/api/admin/login', { method: 'DELETE', headers: { Cookie: cookie } }), env,
  });
  assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/, 'the browser is signed out');
  assert.equal((await summary(env, { Cookie: cookie })).status, 200,
    'but a captured shared-password token survives -- rotate the secret to end it');
});

// ---- Cloudflare Access, independently ----

test('an Access header alone opens the admin routes', async () => {
  const env = await adminEnv();
  assert.equal((await summary(env, ADMIN_HEADERS)).status, 200);
});

test('Access still works when no password is configured at all', async () => {
  const env = freshEnv();
  assert.equal((await summary(env, ADMIN_HEADERS)).status, 200,
    'Zero Trust alone must remain a complete gate');
});

test('an Access identity outside ADMIN_EMAILS is refused', async () => {
  const env = await adminEnv();
  const res = await summary(env, { 'Cf-Access-Authenticated-User-Email': 'stranger@example.com' });
  assert.equal(res.status, 401);
});

test('no credential at all is refused', async () => {
  const env = await adminEnv();
  assert.equal((await summary(env)).status, 401);
});

// ---- role separation ----

test('a parent session is not an admin session', async () => {
  const env = await adminEnv();
  const { rosterId } = seedStudent(env._raw);
  const { code } = await seedAccount(env._raw, rosterId);

  const cookie = cookieFrom(await signLogin({
    request: jsonRequest('https://x/api/sign/login', parentLogin(code)), env,
  }));

  assert.equal((await summary(env, { Cookie: cookie })).status, 401,
    'a parent cookie must never reach roster or signing records');
  assert.equal((await progress({
    request: new Request('https://x/api/admin/progress?course_id=1', { headers: { Cookie: cookie } }), env,
  })).status, 401);
});

test('a teacher session cannot sign anything', async () => {
  const env = await adminEnv();
  const cookie = cookieFrom(await login(env, PASSWORD));
  const res = await parentView({
    request: new Request('https://x/api/sign/syllabus', { headers: { Cookie: cookie } }), env,
  });
  assert.equal(res.status, 401,
    'an admin cookie must not produce a signature attributed to a parent');
});

test('a forged role is rejected because the cookie is signed', async () => {
  const env = await adminEnv();
  // Minted under a different secret, as an attacker would have to.
  const forged = await signSession({ SESSION_SECRET: 'not-the-real-secret' }, 0, 'teacher', Math.floor(Date.now() / 1000));
  assert.equal((await summary(env, { Cookie: `inishial_session=${forged}` })).status, 401);
});

test('an expired admin session is refused', async () => {
  const env = await adminEnv();
  const stale = await signSession(env, 0, 'teacher', Math.floor(Date.now() / 1000) - 60 * 60 * 24);
  assert.equal((await summary(env, { Cookie: `inishial_session=${stale}` })).status, 401);
});

// ---- CSV formula injection ----

test('a formula-looking cell is neutralised in exports', async () => {
  const { csvCell } = await import('../functions/_lib/http.js');
  // Excel/Sheets evaluate these on open; the leading apostrophe stops that.
  assert.equal(csvCell('=HYPERLINK("http://evil","Click")'), `"'=HYPERLINK(""http://evil"",""Click"")"`);
  assert.equal(csvCell('+1234'), "'+1234");
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  // A tab needs no quoting in comma-delimited CSV, but still gets the guard.
  assert.equal(csvCell('\tinjected'), "'\tinjected");
});

test('ordinary values are untouched by the formula guard', async () => {
  const { csvCell } = await import('../functions/_lib/http.js');
  assert.equal(csvCell('Alvarez, Maria'), '"Alvarez, Maria"');
  assert.equal(csvCell('parent@example.com'), 'parent@example.com');
  assert.equal(csvCell('904511'), '904511');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell(null), '');
});

test('a hostile student name cannot inject a formula into the credentials CSV', async () => {
  const env = await adminEnv();
  const { seedSyllabus } = await import('./helpers.mjs');
  const { rosterId, courseId } = seedStudent(env._raw, { last: '=HYPERLINK("http://evil","Click")' });
  await seedAccount(env._raw, rosterId);
  seedSyllabus(env._raw, courseId, [{ type: 'initial', html: 'I agree.', needs_initials: true }]);

  const { onRequestGet: credentials } = await import('../functions/api/admin/credentials.js');
  const csv = await (await credentials({
    request: new Request('https://x/api/admin/credentials?course_id=' + courseId, { headers: ADMIN_HEADERS }), env,
  })).text();

  assert.ok(!/(^|,)=HYPERLINK/m.test(csv), 'a live formula reached the spreadsheet');
  assert.match(csv, /"'=HYPERLINK/);
});

// ---- the operator is not above the boundary ----
//
// Stated requirement: whoever runs this app must not be able to read another
// teacher's students through it. The two credentials the operator holds are the
// shared ADMIN_PASSWORD_HASH and a Cloudflare Access identity, and both resolve
// to teacherId null -- which owns() reads as "unowned courses only", NOT as
// "everything". These pin that, because the difference is one `==` in owns()
// and the failure would be silent and total.

async function teacherWithAClass(env, email = 'someone.else@school.edu') {
  await signup({
    request: jsonRequest('https://x/api/admin/signup',
      { email, password: 'correct horse battery', school: 'Southside High' }), env,
  });
  const id = env._raw.prepare('SELECT id FROM teachers WHERE email = ?').get(email).id;
  const courseId = Number(env._raw.prepare('INSERT INTO courses (name, created_at, owner_id) VALUES (?,?,?)')
    .run('Their Biology', 1000, id).lastInsertRowid);
  const { rosterId } = seedStudent(env._raw, { course: 'Their Biology', extId: '777777', last: 'Private' });
  env._raw.prepare('UPDATE roster SET course_id = ? WHERE id = ?').run(courseId, rosterId);
  return { id, courseId };
}

const codesFor = (env, courseId, headers) => credentials({
  request: new Request(`https://x/api/admin/credentials?course_id=${courseId}&format=json`, { headers }),
  env,
});

test('the shared admin password cannot read another teacher\'s students', async () => {
  const env = await adminEnv();
  const theirs = await teacherWithAClass(env);
  const cookie = cookieFrom(await login(env, PASSWORD));

  const res = await codesFor(env, theirs.courseId, { Cookie: cookie });
  assert.notEqual(res.status, 200, 'break-glass is not a skeleton key');
  assert.match((await res.json()).error, /No such course/,
    'and it does not distinguish "not yours" from "does not exist"');
});

test('a Cloudflare Access identity cannot read another teacher\'s students', async () => {
  const env = await adminEnv();
  const theirs = await teacherWithAClass(env);

  const res = await codesFor(env, theirs.courseId, ADMIN_HEADERS);
  assert.notEqual(res.status, 200, 'authenticating at the edge is not ownership');
});

test('a teacher reads their own class and no one else\'s', async () => {
  const env = await adminEnv();
  const theirs = await teacherWithAClass(env);
  await signup({
    request: jsonRequest('https://x/api/admin/signup',
      { email: 'me@school.edu', password: 'a different long phrase', school: 'Northside High' }), env,
  });
  const mineId = env._raw.prepare("SELECT id FROM teachers WHERE email='me@school.edu'").get().id;
  const mineCourse = Number(env._raw.prepare('INSERT INTO courses (name, created_at, owner_id) VALUES (?,?,?)')
    .run('My Algebra', 1000, mineId).lastInsertRowid);

  const cookie = cookieFrom(await adminLogin({
    request: jsonRequest('https://x/api/admin/login',
      { email: 'me@school.edu', password: 'a different long phrase' }), env,
  }));

  assert.equal((await codesFor(env, mineCourse, { Cookie: cookie })).status, 200, 'my own class');
  assert.notEqual((await codesFor(env, theirs.courseId, { Cookie: cookie })).status, 200, 'never theirs');
});
