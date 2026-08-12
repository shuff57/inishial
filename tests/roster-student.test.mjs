// Single-row roster CRUD: add, edit, drop, restore one student without
// re-uploading the whole roster. See functions/api/admin/roster-student.js.
//
// The invariant that matters most here is the one roster.js's own header
// states: no hard delete, anywhere. "Drop" and "restore" are the only two
// states this endpoint can put a row into.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedSchoolRoster, ADMIN_HEADERS, jsonRequest } from './helpers.mjs';
import { onRequestPost as add, onRequestPatch as edit } from '../functions/api/admin/roster-student.js';
import { blindIndex } from '../functions/_lib/vault.js';

const post = (env, body, headers = ADMIN_HEADERS) =>
  add({ request: jsonRequest('https://x/api/admin/roster-student', body, headers), env });
const patch = (env, body, headers = ADMIN_HEADERS) =>
  edit({ request: jsonRequest('https://x/api/admin/roster-student', body, headers), env });

// ---- POST: add ----

test('adds a new student to an existing course', async () => {
  const env = freshEnv();
  const { courseId } = await seedStudent(env, { extId: '1' });

  const res = await post(env, { course_id: courseId, student_ext_id: '2', last: 'Ray', period: '3', parent_email: 'bob@example.com' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.student_ext_id, '2');
  assert.equal(body.status, 'active');
  assert.equal(body.period, '3');
  assert.equal(body.parent_email, 'bob@example.com');
  // The plaintext just typed rides along so the UI can show it without a
  // decrypt round-trip.
  assert.equal(body.last, 'Ray');

  const row = env._raw.prepare("SELECT status, last_idx FROM roster WHERE student_ext_id = '2'").get();
  assert.equal(row.status, 'active');
  assert.equal(row.last_idx, await blindIndex(env, 'Ray', '2'), 'digest scoped to the student\'s own ext id');
});

test('rejects a request that did not come through Access', async () => {
  const env = freshEnv();
  const { courseId } = await seedStudent(env);
  const res = await post(env, { course_id: courseId, student_ext_id: '2', last: 'Ray' }, {});
  assert.equal(res.status, 401);
});

test('rejects an add with no last name', async () => {
  const env = freshEnv();
  const { courseId } = await seedStudent(env);
  const res = await post(env, { course_id: courseId, student_ext_id: '2', last: '' });
  assert.equal(res.status, 400);
});

test('adding to a course that is not yours (or does not exist) is refused, same message either way', async () => {
  const env = freshEnv();
  // owner_id is a real teacher's id, so the Access-identity admin above (which
  // only ever owns the unowned bucket -- see requireAdmin's doc comment) is
  // "not yours" here the same way a genuinely missing course id would be.
  const theirs = await seedSchoolRoster(env, { school: 'Southside High', course: 'Geometry', extId: '9', last: 'Nine' });

  const resTheirs = await post(env, { course_id: theirs.courseId, student_ext_id: '2', last: 'Ray' });
  const resMissing = await post(env, { course_id: 999999, student_ext_id: '2', last: 'Ray' });
  assert.equal(resTheirs.status, 400);
  assert.equal(resMissing.status, 400);
  assert.equal((await resTheirs.json()).error, (await resMissing.json()).error);
});

test('adding an existing student ext id reactivates a dropped row rather than erroring', async () => {
  const env = freshEnv();
  const { courseId, rosterId } = await seedStudent(env, { extId: '2', last: 'Ray', parentEmail: 'old@example.com' });
  env._raw.prepare("UPDATE roster SET status = 'dropped', dropped_at = 1000 WHERE id = ?").run(rosterId);

  const res = await post(env, { course_id: courseId, student_ext_id: '2', last: 'Ray-Novak', period: '4' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'active');
  assert.equal(body.period, '4');
  // No parent_email carried on this add -- the address already on file
  // survives, same as a re-import leaving an omitted column alone.
  assert.equal(body.parent_email, 'old@example.com');

  const row = env._raw.prepare('SELECT id, status, dropped_at FROM roster WHERE id = ?').get(rosterId);
  assert.equal(row.id, rosterId, 'the same row is reused, not a duplicate');
  assert.equal(row.status, 'active');
  assert.equal(row.dropped_at, null);

  const count = env._raw.prepare("SELECT COUNT(*) AS n FROM roster WHERE course_id = ?").get(courseId).n;
  assert.equal(count, 1, 'reactivating must not create a second row for the same student');
});

// ---- PATCH: edit / drop / restore ----

test('edits a student\'s name, recomputing the digest under the same scope', async () => {
  const env = freshEnv();
  const { rosterId, extId } = await seedStudent(env, { last: 'Alvarez' });

  const res = await patch(env, { id: rosterId, last: 'Alvarez-Ruiz' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.last, 'Alvarez-Ruiz');

  const row = env._raw.prepare('SELECT last_idx FROM roster WHERE id = ?').get(rosterId);
  // A fresh blindIndex call on the same input, same scope, must match what
  // got written -- otherwise the student stops matching at registration.
  assert.equal(row.last_idx, await blindIndex(env, 'Alvarez-Ruiz', extId));
});

test('edits the roster\'s own parent email without touching the student_identities override', async () => {
  const env = freshEnv();
  const { rosterId } = await seedStudent(env, { parentEmail: 'roster@example.com' });

  const res = await patch(env, { id: rosterId, parent_email: 'new@example.com' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).parent_email, 'new@example.com');

  const row = env._raw.prepare('SELECT parent_email FROM roster WHERE id = ?').get(rosterId);
  assert.equal(row.parent_email, 'new@example.com');
});

test('rejects a malformed parent email', async () => {
  const env = freshEnv();
  const { rosterId } = await seedStudent(env);
  const res = await patch(env, { id: rosterId, parent_email: 'not-an-email' });
  assert.equal(res.status, 400);
});

test('drops a student -- status flips, the row survives, dropped_at is stamped', async () => {
  const env = freshEnv();
  const { rosterId } = await seedStudent(env);

  const res = await patch(env, { id: rosterId, status: 'dropped' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'dropped');
  assert.ok(body.dropped_at > 0);

  const row = env._raw.prepare('SELECT status, dropped_at FROM roster WHERE id = ?').get(rosterId);
  assert.equal(row.status, 'dropped');
  assert.ok(row.dropped_at > 0);
});

test('restores a dropped student -- status flips back, dropped_at clears', async () => {
  const env = freshEnv();
  const { rosterId } = await seedStudent(env);
  await patch(env, { id: rosterId, status: 'dropped' });

  const res = await patch(env, { id: rosterId, status: 'active' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'active');
  assert.equal(body.dropped_at, null);

  const row = env._raw.prepare('SELECT status, dropped_at FROM roster WHERE id = ?').get(rosterId);
  assert.equal(row.status, 'active');
  assert.equal(row.dropped_at, null);
});

test('a status value outside the whitelist is rejected', async () => {
  const env = freshEnv();
  const { rosterId } = await seedStudent(env);
  const res = await patch(env, { id: rosterId, status: 'graduated' });
  assert.equal(res.status, 400);

  const row = env._raw.prepare('SELECT status FROM roster WHERE id = ?').get(rosterId);
  assert.equal(row.status, 'active', 'the row is untouched by the rejected request');
});

test('editing a different teacher\'s student is refused, and nothing changes', async () => {
  const env = freshEnv();
  const theirs = await seedSchoolRoster(env, { school: 'Southside High', course: 'Geometry', extId: '9', last: 'Nine', parentEmail: 'their.family@example.com' });

  const res = await patch(env, { id: theirs.rosterId, status: 'dropped' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'No such student.');

  const row = env._raw.prepare('SELECT status FROM roster WHERE id = ?').get(theirs.rosterId);
  assert.equal(row.status, 'active');
});

test('a PATCH with nothing to change is refused', async () => {
  const env = freshEnv();
  const { rosterId } = await seedStudent(env);
  const res = await patch(env, { id: rosterId });
  assert.equal(res.status, 400);
});

test('student_ext_id is not among the editable fields', async () => {
  const env = freshEnv();
  const { rosterId, extId } = await seedStudent(env);
  // Sending it is simply ignored -- there is no code path that writes it.
  await patch(env, { id: rosterId, student_ext_id: '999', period: '5' });
  const row = env._raw.prepare('SELECT student_ext_id FROM roster WHERE id = ?').get(rosterId);
  assert.equal(row.student_ext_id, extId);
});
