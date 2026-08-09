// Schools: the public lookup, and the placeholder-rename nudge.
//
// Two different surfaces, gated differently on purpose:
//
//   GET /api/schools        public, unauthenticated -- a type-ahead source,
//                            not a place that ever creates or exposes PII.
//   GET/PATCH /api/admin/school   a signed-up teacher's own row, so they can
//                            get off the placeholder every account starts on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, ADMIN_HEADERS, jsonRequest, cookieFrom } from './helpers.mjs';
import { onRequestGet as lookup } from '../functions/api/schools.js';
import { onRequestGet as getSchool, onRequestPatch as patchSchool } from '../functions/api/admin/school.js';
import { onRequestPost as signup } from '../functions/api/admin/signup.js';
import { signSession, sessionCookie } from '../functions/_lib/session.js';

const lookupReq = (env, q) => lookup({ request: new Request(`https://x/api/schools${q !== undefined ? `?q=${encodeURIComponent(q)}` : ''}`), env });

/** Sign up a teacher and return their session cookie. */
async function teacher(env, email = 'a@school.org', school = 'Pleasant Valley High') {
  const res = await signup({ request: jsonRequest('https://x/api/admin/signup', { email, password: 'chalk dust and coffee', school }), env });
  assert.equal(res.status, 200, `sign-up failed: ${await res.clone().text()}`);
  return cookieFrom(res);
}

const schoolReq = (method, env, cookie, body) => (method === 'GET' ? getSchool : patchSchool)({
  request: body
    ? new Request('https://x/api/admin/school', { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    : new Request('https://x/api/admin/school', { headers: cookie ? { Cookie: cookie } : {} }),
  env,
});

// ---- GET /api/schools ----

test('with no q, every school comes back', async () => {
  // migrations/0011 seeds a Chico-area reference list alongside the
  // placeholder, so this isn't a single-row install any more -- the
  // behaviour under test is "unfiltered", not "small".
  const env = freshEnv();
  const raw = env._raw.prepare('SELECT COUNT(*) AS n FROM schools').get().n;
  const body = await (await lookupReq(env, undefined)).json();
  assert.equal(body.schools.length, raw, 'no q returns the whole table, not a filtered subset');
  assert.ok(body.schools.some((s) => s.id === 1 && s.name === '(unassigned)'),
    'the placeholder the migration seeds is a real school row');
});

test('matches case-insensitively, by substring', async () => {
  const env = freshEnv();
  env._raw.prepare('INSERT INTO schools (name) VALUES (?)').run('Southside High');
  const body = await (await lookupReq(env, 'southside')).json();
  assert.deepEqual(body.schools.map((s) => s.name), ['Southside High']);
});

test('no match returns an empty list, not an error', async () => {
  const env = freshEnv();
  const res = await lookupReq(env, 'nonexistent-school-xyz');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).schools, []);
});

test('the endpoint needs no admin session at all', async () => {
  const env = freshEnv();
  assert.equal((await lookupReq(env, undefined)).status, 200);
});

// ---- GET /api/admin/school ----

/** A teacher row created directly, bypassing signup's required-school flow, to
 *  test the migration-time state: existing teachers backfilled by migration
 *  0009 still sit on the placeholder row. */
async function legacyPlaceholderTeacher(env, email = 'legacy@school.org') {
  const nowSec = Math.floor(Date.now() / 1000);
  const id = Number(env._raw.prepare('INSERT INTO teachers (email, name, password_hash, school_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(email, 'Legacy Teacher', 'pbkdf2$1$deadbeef', 1, nowSec).lastInsertRowid);
  const token = await signSession(env, id, 'teacher', nowSec, { email });
  return sessionCookie(token).split(';')[0];
}

test('a teacher who predates required school selection still sees the placeholder flagged', async () => {
  const env = freshEnv();
  const cookie = await legacyPlaceholderTeacher(env);
  const body = await (await schoolReq('GET', env, cookie)).json();
  assert.equal(body.school.name, '(unassigned)');
  assert.equal(body.is_placeholder, true);
});

test('the shared password and a bare Access identity have no school to show', async () => {
  const env = freshEnv();
  const viaAccess = await getSchool({ request: new Request('https://x/api/admin/school', { headers: ADMIN_HEADERS }), env });
  assert.deepEqual(await viaAccess.json(), { school: null });
});

test('no credential at all is refused', async () => {
  const env = freshEnv();
  assert.equal((await schoolReq('GET', env, undefined)).status, 401);
});

// ---- PATCH /api/admin/school ----

test('a teacher renames their school, clearing the placeholder flag', async () => {
  const env = freshEnv();
  const cookie = await teacher(env, 't@school.org', '(unassigned)');
  const res = await schoolReq('PATCH', env, cookie, { name: 'Pleasant Valley High' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).school.name, 'Pleasant Valley High');

  const after = await (await schoolReq('GET', env, cookie)).json();
  assert.equal(after.school.name, 'Pleasant Valley High');
  assert.equal(after.is_placeholder, false);
});

test('naming an existing school joins that row rather than erroring', async () => {
  const env = freshEnv();
  const southsideId = env._raw.prepare('INSERT INTO schools (name) VALUES (?)').run('Southside High').lastInsertRowid;
  const cookie = await teacher(env, 't@school.org', '(unassigned)');
  const res = await schoolReq('PATCH', env, cookie, { name: 'Southside High' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).school.id, Number(southsideId), 'the existing row, not a duplicate');
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM schools WHERE name = ?').get('Southside High').n, 1);
});

test('a different-case match still joins the existing row, not a case-variant duplicate', async () => {
  const env = freshEnv();
  const southsideId = env._raw.prepare('INSERT INTO schools (name) VALUES (?)').run('Southside High').lastInsertRowid;
  const before = env._raw.prepare('SELECT COUNT(*) AS n FROM schools').get().n;
  const cookie = await teacher(env, 't@school.org', '(unassigned)');
  const res = await schoolReq('PATCH', env, cookie, { name: 'southside high' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.school.id, Number(southsideId), 'the existing row, not a duplicate');
  assert.equal(body.school.name, 'Southside High', 'the row keeps its original casing');
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM schools').get().n, before,
    'no case-variant third row was created');
});

test("renaming your own school does not relabel a colleague still on the placeholder", async () => {
  // The legacy path: one teacher was already on the placeholder and names
  // their school, while a second teacher is still backfilled on the placeholder.
  // A plain UPDATE on that shared row would rename it for both of them;
  // find-or-create must move only the caller's own pointer.
  const env = freshEnv();
  const alice = await teacher(env, 'alice@school.org');
  const bob = await legacyPlaceholderTeacher(env, 'bob@school.org');

  await schoolReq('PATCH', env, alice, { name: 'Northside High' });

  const bobsView = await (await schoolReq('GET', env, bob)).json();
  assert.equal(bobsView.school.name, '(unassigned)', "bob's school must not change because alice named hers");
  assert.equal(bobsView.is_placeholder, true);

  const alicesView = await (await schoolReq('GET', env, alice)).json();
  assert.equal(alicesView.school.name, 'Northside High');
  assert.equal(alicesView.is_placeholder, false);
});

test('two teachers at the same real school share one row once both name it', async () => {
  const env = freshEnv();
  const alice = await teacher(env, 'alice@school.org');
  const bob = await teacher(env, 'bob@school.org');

  const aliceSchool = (await (await schoolReq('PATCH', env, alice, { name: 'Northside High' })).json()).school;
  const bobSchool = (await (await schoolReq('PATCH', env, bob, { name: 'Northside High' })).json()).school;
  assert.equal(aliceSchool.id, bobSchool.id);
});

test('an empty name is refused', async () => {
  const env = freshEnv();
  const cookie = await teacher(env);
  assert.equal((await schoolReq('PATCH', env, cookie, { name: '  ' })).status, 400);
});

test('the shared password has no teacher row to rename a school for', async () => {
  const env = freshEnv();
  const res = await patchSchool({
    request: new Request('https://x/api/admin/school', { method: 'PATCH', headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X' }) }),
    env,
  });
  assert.equal(res.status, 400);
});

test('renaming without a session is refused', async () => {
  const env = freshEnv();
  const res = await patchSchool({ request: new Request('https://x/api/admin/school', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X' }) }), env });
  assert.equal(res.status, 401);
});
