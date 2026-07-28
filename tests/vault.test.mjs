// The code vault: codes readable by the teacher, useless from the database.
//
// Two properties matter and they pull against each other -- the page must be
// able to show a code, and the stored bytes must not be a code. Everything
// here is one or the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, ADMIN_HEADERS } from './helpers.mjs';
import { sealCode, openCode, vaultReady } from '../functions/_lib/vault.js';
import { onRequestGet as credentials } from '../functions/api/admin/credentials.js';
import { onRequestPost as register } from '../functions/api/register.js';
import { onRequestPost as login } from '../functions/api/sign/login.js';

const SECRET = 'a-test-secret-long-enough';
const withSecret = (extra = {}) => {
  const e = freshEnv();
  return Object.assign(e, { CODE_SECRET: SECRET, ...extra });
};

test('a sealed code round-trips, and the ciphertext is not the code', async () => {
  const env = { CODE_SECRET: SECRET };
  const sealed = await sealCode(env, 'ABCD2345');

  assert.equal(await openCode(env, sealed), 'ABCD2345');
  assert.ok(!sealed.includes('ABCD2345'), 'the plaintext is sitting in the column');
  assert.match(sealed, /^v1\$/, 'versioned, so a future key rotation can tell old rows apart');

  // AES-GCM is randomised: the same code sealed twice must not produce the same
  // bytes, or the column leaks which students share a code.
  assert.notEqual(sealed, await sealCode(env, 'ABCD2345'));
});

test('the wrong secret does not open a code, and does not throw', async () => {
  const sealed = await sealCode({ CODE_SECRET: SECRET }, 'ABCD2345');
  assert.equal(await openCode({ CODE_SECRET: 'a-different-secret-entirely' }, sealed), null);
  assert.equal(await openCode({ CODE_SECRET: SECRET }, 'v1$garbage$garbage'), null);
  assert.equal(await openCode({ CODE_SECRET: SECRET }, null), null);
});

test('no secret means no vault, and nothing crashes', async () => {
  assert.equal(vaultReady({}), false);
  assert.equal(vaultReady({ CODE_SECRET: 'tooshort' }), false, 'a short secret is not a secret');
  assert.equal(await sealCode({}, 'ABCD2345'), null);
  assert.equal(await openCode({}, 'v1$x$y'), null);
});

test('the codes page shows a code the teacher can read back later', async () => {
  const env = withSecret();
  seedStudent(env._raw, { parentEmail: 'family@example.com' });

  // Registering mints the student's code...
  const reg = await (await register({
    request: new Request('https://x/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_ext_id: '904511', last: 'Alvarez', username: 'm@chicousd.org' }),
    }),
    env,
  })).json();

  // ...and the page reads that same code back on a later request, which is the
  // whole point of the vault. Hashing alone made this impossible.
  const body = await (await credentials({
    request: new Request('https://x/api/admin/credentials?course_id=1&format=json', { headers: ADMIN_HEADERS }),
    env,
  })).json();

  const row = body.students[0];
  assert.equal(body.vault, true);
  assert.equal(row.student_code.code, reg.student_code, 'the code on screen is the code they were shown');
  assert.equal(row.student_code.recoverable, true);

  // And it is still the code that actually signs in -- the hash and the
  // ciphertext have not drifted apart.
  const res = await login({
    request: new Request('https://x/api/sign/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_ext_id: '904511', code: row.student_code.code }),
    }),
    env,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).role, 'student');
});

test('a code from before the vault reports itself unreadable rather than blank', async () => {
  const env = withSecret();
  const { rosterId } = seedStudent(env._raw);
  // Hash but no ciphertext: exactly what an account issued before this looks like.
  env._raw.prepare(
    `INSERT INTO accounts (roster_id, username, code_hash, code_issued_at, created_at)
     VALUES (?, 'old@chicousd.org', 'pbkdf2$1$AA==$AA==', 1000, 1000)`,
  ).run(rosterId);

  const body = await (await credentials({
    request: new Request('https://x/api/admin/credentials?course_id=1&format=json', { headers: ADMIN_HEADERS }),
    env,
  })).json();

  const parent = body.students[0].parent;
  assert.equal(parent.code, null);
  assert.equal(parent.recoverable, false, 'the page must offer a reissue, not an empty cell');
  assert.equal(parent.issued_at, 1000, 'and still say when it was issued');
});

test('reissuing one student leaves the rest of the class alone', async () => {
  const env = withSecret();
  seedStudent(env._raw, { extId: '904511', last: 'Alvarez' });
  seedStudent(env._raw, { extId: '904512', last: 'Chen', first: 'Kevin', course: 'Algebra I' });
  for (const [roster, name] of [[1, 'a@chicousd.org'], [2, 'b@chicousd.org']]) {
    env._raw.prepare('INSERT INTO accounts (roster_id, username, created_at) VALUES (?, ?, 1000)').run(roster, name);
  }

  const read = async (qs = '') => (await (await credentials({
    request: new Request(`https://x/api/admin/credentials?course_id=1&format=json${qs}`, { headers: ADMIN_HEADERS }),
    env,
  })).json()).students;

  const before = await read();                       // mints both students' codes
  const target = before[0].account_id;
  const after = await read(`&reissue=1&account_id=${target}`);

  assert.notEqual(after[0].parent.code, before[0].parent.code, 'the named student got new codes');
  assert.notEqual(after[0].student_code.code, before[0].student_code.code);
  assert.equal(after[1].parent.code, before[1].parent.code, 'nobody else was touched');
  assert.equal(after[1].student_code.code, before[1].student_code.code);
});
