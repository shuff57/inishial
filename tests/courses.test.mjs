// Creating a class without a roster.
//
// Course creation used to only happen as a side effect of a roster upload, so a
// teacher with no SIS export yet had nothing to write a syllabus against. These
// tests pin the two things that make the separate flow safe: it is idempotent
// on the name, and it is scoped to the teacher who asked -- two teachers each
// have an "Algebra I", and creating one must never hand back the other's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, ADMIN_HEADERS as ADMIN, jsonRequest, cookieFrom } from './helpers.mjs';
import { onRequestPost } from '../functions/api/admin/courses.js';
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
