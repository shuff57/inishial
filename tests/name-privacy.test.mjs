// What migration 0017 is actually for.
//
// Every other test here asserts that a name comes back on a screen. These
// assert what is NOT in the database when it does, which is the whole point of
// the change and the part that would rot silently: a future `SELECT r.last`
// added back for convenience would break nothing visible, and every one of
// those other tests would still pass.
//
// The property, stated exactly:
//
//   * given names are not stored at all -- no column, no ciphertext
//   * surnames are stored sealed, and appear nowhere in the clear
//   * matching still works, because the digest is what is compared
//
// The limit is asserted too, at the bottom. This defends a copy of the
// database, not against whoever holds CODE_SECRET, and a test that implied
// otherwise would be worse than no test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedSchoolRoster, ADMIN_HEADERS } from './helpers.mjs';
import { onRequestPost as register } from '../functions/api/register.js';
import { onRequestPost as uploadRoster } from '../functions/api/admin/roster.js';
import { blindIndex, open } from '../functions/_lib/vault.js';

/** Every value in every row of a table, flattened to one searchable string. */
function dumpOf(db, table) {
  return JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
}

const upload = (env, body) => uploadRoster({
  request: new Request('https://x/api/admin/roster?course=Algebra%20I', {
    method: 'POST', headers: ADMIN_HEADERS, body,
  }),
  env,
});

test('the roster table has no given-name column at all', () => {
  const env = freshEnv();
  const columns = env._raw.prepare('PRAGMA table_info(roster)').all().map((c) => c.name);
  assert.ok(!columns.includes('first'), 'given names are dropped, not encrypted');
  assert.ok(!columns.includes('last'), 'the plaintext surname column is gone too');
  assert.ok(columns.includes('last_enc') && columns.includes('last_idx'));
});

test('an imported surname is nowhere in the clear, and the given name is nowhere at all', async () => {
  const env = freshEnv();
  await upload(env, 'Student ID,Last Name,First Name,Period\n904511,Alvarez,Maria,3\n');

  const dump = dumpOf(env._raw, 'roster');
  assert.ok(!dump.includes('Alvarez'), 'the surname must not appear in the roster row');
  assert.ok(!dump.includes('Maria'), 'the given name must not have been stored anywhere');
  // The student ID is deliberately still readable -- registration matches on it
  // and it cannot be blinded. Asserted so the honest limit is visible here.
  assert.ok(dump.includes('904511'), 'student IDs remain in the clear by necessity');

  // And it is genuinely recoverable by someone holding the secret, or the
  // teacher's own pages would be showing blanks.
  const row = env._raw.prepare('SELECT last_enc FROM roster').get();
  assert.equal(await open(env, row.last_enc), 'Alvarez');
});

test('the sealed surname is different every time, so equal names are not visibly equal', async () => {
  const env = freshEnv();
  await upload(env, 'Student ID,Last Name,First Name\n1,Alvarez,Ann\n2,Alvarez,Bob\n');

  const [a, b] = env._raw.prepare('SELECT last_enc, last_idx FROM roster ORDER BY student_ext_id').all();
  assert.notEqual(a.last_enc, b.last_enc,
    'AES-GCM with a fresh IV: two identical surnames must not produce one ciphertext');
  // The digests DO differ here, and only because they are scoped per student
  // ID. Two siblings would otherwise share a value, which leaks that they are
  // siblings to anyone reading the table.
  assert.notEqual(a.last_idx, b.last_idx, 'the digest is scoped per student, not global');
});

test('registration still matches a surname, and still ignores its capitalisation', async () => {
  const env = freshEnv();
  const seat = await seedSchoolRoster(env, {
    school: 'Northside High', course: 'Algebra I', extId: '904511', last: 'Alvarez',
  });

  // Typed in lower case, as a phone keyboard will. The old SQL did this with
  // lower() on both sides; blindIndex has to normalise identically or every
  // student whose keyboard disagrees with the SIS is locked out.
  const res = await register({
    request: new Request('https://x/api/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ school_id: seat.schoolId, student_ext_id: '904511', last: '  aLvArEz ' }),
    }),
    env,
  });
  assert.equal(res.status, 201, 'case and stray spaces must not decide whether a student can register');
  assert.equal((await res.json()).student, 'Alvarez', 'and the card shows the roster spelling back');
});

test('a wrong surname still fails, so the digest is being checked and not skipped', async () => {
  const env = freshEnv();
  const seat = await seedSchoolRoster(env, {
    school: 'Northside High', course: 'Algebra I', extId: '904511', last: 'Alvarez',
  });

  const res = await register({
    request: new Request('https://x/api/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ school_id: seat.schoolId, student_ext_id: '904511', last: 'Nguyen' }),
    }),
    env,
  });
  assert.equal(res.status, 400);
});

test('an import is refused outright when there is no secret to seal names with', async () => {
  // Fails closed. The alternative -- writing rows with a NULL digest -- looks
  // like a successful import and then refuses every student who tries to
  // register against it, days later, with no clue why.
  const env = freshEnv({ CODE_SECRET: undefined });
  const res = await upload(env, 'Student ID,Last Name,First Name\n1,Lee,Ann\n');

  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /CODE_SECRET/);
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM roster').get().n, 0,
    'and nothing was written on the way to refusing');
});

test('THE LIMIT: holding the secret is enough to confirm a guessed surname', async () => {
  // Not a defect -- a boundary, pinned so nobody later reads the sealing above
  // as more than it is. Registration has to match a name typed by someone who
  // is not signed in, so the server must hold the key, so the operator does
  // too. Confirming a guess costs one HMAC.
  const env = freshEnv();
  await upload(env, 'Student ID,Last Name,First Name\n904511,Alvarez,Maria\n');

  const stored = env._raw.prepare('SELECT last_idx FROM roster').get().last_idx;
  assert.equal(stored, await blindIndex(env, 'Alvarez', '904511'),
    'a guessed surname can be confirmed by anyone holding CODE_SECRET');
  assert.notEqual(stored, await blindIndex(env, 'Nguyen', '904511'));
});
