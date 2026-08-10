// Integration tests for the roster import handler, run against a real SQLite
// database built from the migrations.
//
// node:sqlite is stdlib (Node 22+), so this needs no dependency and no running
// wrangler. D1 is SQLite, so the schema and every query here are the same ones
// production executes -- the only thing faked is the client API shape.
//
// The drop-scoping rule is the reason this file exists: uploading one period
// must never mark another period's students as dropped.
//
// The harness comes from helpers.mjs rather than a copy here. This file used to
// carry its own, pinned to 0001_init.sql, and a later migration was therefore
// invisible to every test in it -- they passed against a schema production did
// not have.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, ADMIN_HEADERS as ADMIN } from './helpers.mjs';
import { onRequestPost, onRequestGet } from '../functions/api/admin/roster.js';
import { open, blindIndex } from '../functions/_lib/vault.js';

function upload(csv, { course = 'Algebra I', headers = ADMIN } = {}) {
  return new Request(`https://x/api/admin/roster?course=${encodeURIComponent(course)}`, {
    method: 'POST', headers, body: csv,
  });
}

const roster = (rows) =>
  ['Student ID,Last Name,First Name,Period', ...rows].join('\n');

test('rejects a request that did not come through Access', async () => {
  const env = freshEnv();
  const res = await onRequestPost({ request: upload(roster(['1,Lee,Ann,3']), { headers: {} }), env });
  assert.equal(res.status, 401);
});

test('rejects an authenticated identity outside ADMIN_EMAILS', async () => {
  const env = freshEnv();
  const res = await onRequestPost({
    request: upload(roster(['1,Lee,Ann,3']), { headers: { 'Cf-Access-Authenticated-User-Email': 'someone@else.com' } }),
    env,
  });
  assert.equal(res.status, 401);
});

test('imports a roster and reports counts', async () => {
  const env = freshEnv();
  const res = await onRequestPost({ request: upload(roster(['1,Lee,Ann,3', '2,Ray,Bob,3'])), env });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.inserted, 2);
  assert.equal(body.updated, 0);
  assert.equal(body.dropped, 0);
});

test('uploading one period does not drop another period of the same course', async () => {
  const env = freshEnv();
  await onRequestPost({ request: upload(roster(['1,Lee,Ann,3', '2,Ray,Bob,3'])), env });
  const res = await onRequestPost({ request: upload(roster(['3,Cruz,Dana,4'])), env });
  const body = await res.json();

  assert.equal(body.inserted, 1);
  assert.equal(body.dropped, 0, 'period 3 must survive an upload that only covers period 4');

  const active = env._raw.prepare("SELECT student_ext_id FROM roster WHERE status = 'active' ORDER BY student_ext_id").all();
  assert.deepEqual(active.map((r) => r.student_ext_id), ['1', '2', '3']);
});

test('a student absent from a re-upload of their own period is dropped, not deleted', async () => {
  const env = freshEnv();
  await onRequestPost({ request: upload(roster(['1,Lee,Ann,3', '2,Ray,Bob,3'])), env });
  const res = await onRequestPost({ request: upload(roster(['1,Lee,Ann,3'])), env });
  const body = await res.json();

  assert.equal(body.dropped, 1);
  const bob = env._raw.prepare("SELECT status, dropped_at FROM roster WHERE student_ext_id = '2'").get();
  assert.equal(bob.status, 'dropped');
  assert.ok(bob.dropped_at > 0, 'drop is timestamped');
  assert.ok(bob, 'the row still exists -- deleting it would cascade away signatures');
});

test('a returning student is reactivated with their account intact', async () => {
  const env = freshEnv();
  await onRequestPost({ request: upload(roster(['1,Lee,Ann,3', '2,Ray,Bob,3'])), env });

  // Bob registers, then drops.
  const bobRosterId = env._raw.prepare("SELECT id FROM roster WHERE student_ext_id = '2'").get().id;
  const extId = env._raw.prepare('SELECT student_ext_id FROM roster WHERE id = ?').get(bobRosterId).student_ext_id;
  const identityId = Number(env._raw.prepare(
    'INSERT INTO student_identities (school_id, student_ext_id, username, parent_email, created_at) VALUES (1, ?, ?, ?, ?)',
  ).run(extId, 'bobray', 'parent@example.com', 1000).lastInsertRowid);
  env._raw.prepare(
    'INSERT INTO accounts (roster_id, identity_id, created_at) VALUES (?, ?, ?)',
  ).run(bobRosterId, identityId, 1000);
  await onRequestPost({ request: upload(roster(['1,Lee,Ann,3'])), env });

  // ...and is back on next week's roster.
  await onRequestPost({ request: upload(roster(['1,Lee,Ann,3', '2,Ray,Bob,3'])), env });

  const bob = env._raw.prepare("SELECT status, dropped_at FROM roster WHERE student_ext_id = '2'").get();
  assert.equal(bob.status, 'active');
  assert.equal(bob.dropped_at, null);

  const account = env._raw.prepare('SELECT si.username FROM student_identities si JOIN accounts a ON a.identity_id = si.id WHERE a.roster_id = ?').get(bobRosterId);
  assert.equal(account.username, 'bobray', 'the account survived the drop and came back with them');
});

test('a name change in the SIS updates in place rather than duplicating', async () => {
  const env = freshEnv();
  await onRequestPost({ request: upload(roster(['1,Lee,Ann,3'])), env });
  const res = await onRequestPost({ request: upload(roster(['1,Lee-Novak,Ann,3'])), env });
  const body = await res.json();

  assert.equal(body.inserted, 0);
  assert.equal(body.updated, 1);
  assert.equal(body.dropped, 0);
  const rows = env._raw.prepare("SELECT last_enc, last_idx FROM roster WHERE student_ext_id = '1'").all();
  assert.equal(rows.length, 1);
  assert.equal(await open(env, rows[0].last_enc), 'Lee-Novak', 'the sealed name follows the change');
  // The digest has to move with it, or the student keeps matching under their
  // old surname and stops matching under the new one.
  assert.equal(rows[0].last_idx, await blindIndex(env, 'Lee-Novak', '1'));
});

test('a Course column splits one file across courses', async () => {
  const env = freshEnv();
  const csv = [
    'Student ID,Last Name,First Name,Period,Course',
    '1,Lee,Ann,3,Algebra I',
    '2,Ray,Bob,1,Geometry',
  ].join('\n');
  const res = await onRequestPost({
    request: new Request('https://x/api/admin/roster', { method: 'POST', headers: ADMIN, body: csv }),
    env,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.courses.sort(), ['Algebra I', 'Geometry']);
});

test('a file with no Course column and no ?course= is refused', async () => {
  const env = freshEnv();
  const res = await onRequestPost({
    request: new Request('https://x/api/admin/roster', { method: 'POST', headers: ADMIN, body: roster(['1,Lee,Ann,3']) }),
    env,
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Course column/);
});

test('the course summary counts active and dropped separately', async () => {
  const env = freshEnv();
  await onRequestPost({ request: upload(roster(['1,Lee,Ann,3', '2,Ray,Bob,3'])), env });
  await onRequestPost({ request: upload(roster(['1,Lee,Ann,3'])), env });

  const res = await onRequestGet({ request: new Request('https://x/api/admin/roster', { headers: ADMIN }), env });
  const { courses } = await res.json();
  assert.equal(courses.length, 1);
  assert.equal(courses[0].students, 1);
  assert.equal(courses[0].dropped, 1);
});
