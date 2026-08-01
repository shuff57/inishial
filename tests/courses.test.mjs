// Creating a class without a roster.
//
// Course creation used to only happen as a side effect of a roster upload, so a
// teacher with no SIS export yet had nothing to write a syllabus against. These
// tests pin the two things that make the separate flow safe: it is idempotent
// on the name, and it is scoped to the teacher who asked -- two teachers each
// have an "Algebra I", and creating one must never hand back the other's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, ADMIN_HEADERS as ADMIN, jsonRequest, cookieFrom, seedStudent, seedAccount, seedSyllabus } from './helpers.mjs';
import { onRequestPost, onRequestPatch, onRequestDelete } from '../functions/api/admin/courses.js';
import { onRequestGet as listCourses } from '../functions/api/admin/roster.js';
import { onRequestPost as signup } from '../functions/api/admin/signup.js';

const create = (env, name, headers = ADMIN) =>
  onRequestPost({
    request: new Request('https://x/api/admin/courses', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
    env,
  });

const listing = async (env, headers = ADMIN) =>
  (await (await listCourses({ request: new Request('https://x/api/admin/roster', { headers }), env })).json()).courses;

test('rejects a request that did not come through Access', async () => {
  assert.equal((await create(freshEnv(), 'Algebra I', {})).status, 401);
});

test('creates a class with no students in it', async () => {
  const env = freshEnv();
  const res = await create(env, 'Algebra I');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).existing, false);

  assert.deepEqual((await listing(env)).map((c) => [c.name, c.students ?? 0]), [['Algebra I', 0]],
    'the class shows up on the dashboard before anyone is enrolled');
});

test('a name you already have comes back instead of duplicating', async () => {
  const env = freshEnv();
  const first = await (await create(env, 'Algebra I')).json();
  const again = await (await create(env, '  Algebra I  ')).json();

  assert.equal(again.existing, true);
  assert.equal(again.course.id, first.course.id);
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM courses').get().n, 1);
});

test('a blank name is refused', async () => {
  assert.equal((await create(freshEnv(), '   ')).status, 400);
});

test('one teacher\'s class is never handed to another with the same name', async () => {
  const DOMAIN = 'pvhs.example.org';
  const env = freshEnv({ TEACHER_DOMAINS: DOMAIN, ADMIN_EMAILS: '' });
  const teacher = async (email) => cookieFrom(await signup({
    request: jsonRequest('https://x/api/admin/signup', { email, password: 'correct-horse-battery-staple' }), env,
  }));
  const alice = await teacher('alice@' + DOMAIN);
  const bob = await teacher('bob@' + DOMAIN);

  const hers = await (await create(env, 'Algebra I', { Cookie: alice })).json();
  const his = await (await create(env, 'Algebra I', { Cookie: bob })).json();

  assert.equal(his.existing, false, 'Bob gets his own class, not a pointer into Alice\'s');
  assert.notEqual(his.course.id, hers.course.id);
  assert.deepEqual((await listing(env, { Cookie: alice })).map((c) => c.id), [hers.course.id]);
  assert.deepEqual((await listing(env, { Cookie: bob })).map((c) => c.id), [his.course.id]);
});

// ---- renaming, archiving, and the one operation that destroys evidence ----
//
// Delete is the only path in this application that removes a signature. Every
// other destructive-looking thing -- a dropped student, a republished syllabus,
// an archived class -- is careful not to, because the initials a family gave in
// September are the whole point of the record. So the tests below spend most of
// their attention on two questions: does the guard actually hold, and when it
// does open, does the delete take EVERYTHING with it rather than leaving
// orphaned rows pointing at a course that is gone.

const patch = (env, body, headers = ADMIN) =>
  onRequestPatch({
    request: new Request('https://x/api/admin/courses', {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  });

const del = (env, body, headers = ADMIN) =>
  onRequestDelete({
    request: new Request('https://x/api/admin/courses', {
      method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  });

/** A class with a student, an account, a published syllabus, and one signature. */
async function classWithSignature(env, course = 'Algebra I') {
  const { courseId, rosterId } = seedStudent(env._raw, { course });
  const { accountId } = await seedAccount(env._raw, rosterId, { username: course + '@x' });
  const { versionId, blockIds } = seedSyllabus(env._raw, courseId,
    [{ type: 'agree', html: 'I agree.', needs_initials: 1 }], { title: course + ' Syllabus' });
  env._raw.prepare(
    `INSERT INTO signatures (account_id, version_id, block_id, role, initials, block_hash, signed_at)
     VALUES (?, ?, ?, 'parent', 'MA', 'hash', 3000)`,
  ).run(accountId, versionId, blockIds[0]);
  return { courseId, rosterId, accountId };
}

const count = (env, table) => env._raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('renaming a class changes the name and nothing else', async () => {
  const env = freshEnv();
  const { courseId } = await classWithSignature(env);

  const res = await patch(env, { id: courseId, name: 'Algebra I Honors' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).course.name, 'Algebra I Honors');
  assert.deepEqual((await listing(env)).map((c) => c.name), ['Algebra I Honors']);
  assert.equal(count(env, 'signatures'), 1, 'a rename is a label change, not a data change');
});

test('a rename cannot collide with another of your own classes', async () => {
  const env = freshEnv();
  await create(env, 'Algebra I');
  const second = await (await create(env, 'Geometry')).json();

  // Not tidiness: POST resolves a name to a course to stay idempotent, so two
  // classes sharing a name make the next roster import a coin toss.
  assert.equal((await patch(env, { id: second.course.id, name: 'Algebra I' })).status, 400);
  assert.deepEqual((await listing(env)).map((c) => c.name).sort(), ['Algebra I', 'Geometry']);
});

test('archiving hides a class from the year without touching what it holds', async () => {
  const env = freshEnv();
  const { courseId } = await classWithSignature(env);

  const res = await patch(env, { id: courseId, archived: true });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).course.archived_at > 0, 'stamped with when it was put away');

  // Still listed -- the page renders it under "Previous years" rather than
  // fetching last year's classes separately.
  const [row] = await listing(env);
  assert.ok(row.archived_at > 0);
  assert.equal(row.students, 1);
  assert.equal(count(env, 'signatures'), 1, 'archiving is not a soft delete');

  await patch(env, { id: courseId, archived: false });
  assert.equal((await listing(env))[0].archived_at, null,
    'restoring clears the date rather than keeping a second flag');
});

test('the listing counts signatures without inflating the other columns', async () => {
  const env = freshEnv();
  const { courseId, rosterId } = await classWithSignature(env);
  // A second signature on the same account. Joined rather than subqueried, this
  // is the row that would double `students` and `registered` along with it.
  const { versionId, blockIds } = seedSyllabus(env._raw, courseId,
    [{ type: 'agree', html: 'And this.', needs_initials: 1 }], { num: 2 });
  const accountId = env._raw.prepare('SELECT id FROM accounts WHERE roster_id = ?').get(rosterId).id;
  env._raw.prepare(
    `INSERT INTO signatures (account_id, version_id, block_id, role, initials, block_hash, signed_at)
     VALUES (?, ?, ?, 'student', 'MA', 'hash', 3100)`,
  ).run(accountId, versionId, blockIds[0]);

  const [row] = await listing(env);
  assert.equal(row.signatures, 2);
  assert.equal(row.students, 1, 'one student, whatever they signed');
  assert.equal(row.registered, 1);
});

test('deleting refuses until the class name is typed back', async () => {
  const env = freshEnv();
  const { courseId } = await classWithSignature(env);

  assert.equal((await del(env, { id: courseId })).status, 400, 'no confirmation at all');
  assert.equal((await del(env, { id: courseId, confirm_name: 'Algebra' })).status, 400, 'close is not the same');
  assert.equal(count(env, 'courses'), 1);
  assert.equal(count(env, 'signatures'), 1, 'nothing went while the guard was closed');
});

test('the typed name is forgiving about case and spacing, and nothing else', async () => {
  const env = freshEnv();
  const { courseId } = await classWithSignature(env);
  // The guard is against a stray click, not against a teacher who capitalised
  // their own class differently. One that rejects the right answer teaches
  // people to distrust it.
  assert.equal((await del(env, { id: courseId, confirm_name: '  algebra i  ' })).status, 200);
  assert.equal(count(env, 'courses'), 0);
});

test('deleting a class takes every row that hung off it', async () => {
  const env = freshEnv();
  const { courseId } = await classWithSignature(env);
  await classWithSignature(env, 'Geometry');       // the bystander

  const res = await del(env, { id: courseId, confirm_name: 'Algebra I' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).deleted, { name: 'Algebra I', students: 1, signatures: 1 },
    'reports what actually went, counted before the delete');

  // One of each is left, and it is Geometry's. An orphan here would be a roster
  // row -- a student name, an ID and a parent address -- pointing at a course
  // that no longer exists to scope it to a teacher.
  assert.equal(count(env, 'courses'), 1);
  assert.equal(count(env, 'roster'), 1);
  assert.equal(count(env, 'accounts'), 1);
  assert.equal(count(env, 'signatures'), 1);
  assert.equal(count(env, 'syllabi'), 1);
  assert.equal(count(env, 'blocks'), 1);
  assert.deepEqual((await listing(env)).map((c) => c.name), ['Geometry']);
});

test('one teacher cannot rename, archive or delete another class', async () => {
  const DOMAIN = 'pvhs.example.org';
  const env = freshEnv({ TEACHER_DOMAINS: DOMAIN, ADMIN_EMAILS: '' });
  const teacher = async (email) => cookieFrom(await signup({
    request: jsonRequest('https://x/api/admin/signup', { email, password: 'correct-horse-battery-staple' }), env,
  }));
  const alice = await teacher('alice@' + DOMAIN);
  const bob = await teacher('bob@' + DOMAIN);
  const hers = (await (await create(env, 'Algebra I', { Cookie: alice })).json()).course;

  for (const attempt of [
    patch(env, { id: hers.id, name: 'Bobs Now' }, { Cookie: bob }),
    patch(env, { id: hers.id, archived: true }, { Cookie: bob }),
    del(env, { id: hers.id, confirm_name: 'Algebra I' }, { Cookie: bob }),
  ]) {
    const res = await attempt;
    assert.equal(res.status, 400);
    // "No such class", never "not yours" -- course ids must not be enumerable
    // across a school.
    assert.match((await res.json()).error, /No such class/);
  }

  assert.equal(count(env, 'courses'), 1);
  assert.deepEqual((await listing(env, { Cookie: alice })).map((c) => [c.name, c.archived_at]),
    [['Algebra I', null]]);
});
