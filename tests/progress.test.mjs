// The teacher's working list: who has signed, who hasn't, and who signed a
// version that has since been replaced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedAccount, seedSyllabus, ADMIN_HEADERS, jsonRequest, cookieFrom } from './helpers.mjs';
import { onRequestGet as progress } from '../functions/api/admin/progress.js';
import { onRequestGet as signedCopy } from '../functions/admin/signed.js';
import { onRequestPost as signLogin } from '../functions/api/sign/login.js';
import { onRequestPost as postInitial } from '../functions/api/sign/initial.js';

const BLOCKS = [
  { type: 'text', html: '<p>Late work loses 10% per day.</p>' },
  { type: 'initial', html: 'I have read the late work policy.', needs_initials: true },
  { type: 'initial', html: 'I have read the attendance policy.', needs_initials: true },
];

const get = (env, qs) =>
  progress({ request: new Request(`https://x/api/admin/progress?${qs}`, { headers: ADMIN_HEADERS }), env });

async function setup() {
  const env = freshEnv();
  const { courseId, rosterId } = seedStudent(env._raw, { parentEmail: 'family@example.com' });
  const { accountId, code } = await seedAccount(env._raw, rosterId);
  const { versionId, blockIds } = seedSyllabus(env._raw, courseId, BLOCKS);
  return { env, courseId, rosterId, accountId, code, versionId, blockIds };
}

async function signBlocks(env, code, blockIds) {
  const cookie = cookieFrom(await signLogin({
    request: jsonRequest('https://x/api/sign/login', { student_ext_id: '904511', email: 'parent@example.com', code, role: 'parent' }), env,
  }));
  for (const id of blockIds) {
    await postInitial({
      request: jsonRequest('https://x/api/sign/initial', { block_id: id, initials: 'MRA' }, { Cookie: cookie }), env,
    });
  }
}

// ---- statuses ----

test('a student with no account reads as not registered', async () => {
  const env = freshEnv();
  const { courseId } = seedStudent(env._raw);
  seedSyllabus(env._raw, courseId, BLOCKS);

  const body = await (await get(env, `course_id=${courseId}`)).json();
  assert.equal(body.students[0].status, 'not_registered');
  assert.equal(body.counts.not_registered, 1);
});

test('a registered student with no code issued is distinguished from one who just has not signed', async () => {
  const env = freshEnv();
  const { courseId, rosterId } = seedStudent(env._raw);
  seedSyllabus(env._raw, courseId, BLOCKS);
  env._raw.prepare('INSERT INTO accounts (roster_id, username, created_at) VALUES (?, ?, 1)').run(rosterId, 'malvarez@chicousd.org');

  const body = await (await get(env, `course_id=${courseId}`)).json();
  assert.equal(body.students[0].status, 'no_code',
    'you cannot chase a parent who was never sent a code');
});

test('partly signed is reported with a count', async () => {
  const { env, courseId, code, blockIds } = await setup();
  await signBlocks(env, code, [blockIds[1]]);

  const body = await (await get(env, `course_id=${courseId}`)).json();
  assert.equal(body.students[0].status, 'partial');
  assert.equal(body.students[0].parent_signed, 1);
  assert.equal(body.students[0].required, 2);
});

test('signing every required section reads as complete', async () => {
  const { env, courseId, code, blockIds } = await setup();
  await signBlocks(env, code, [blockIds[1], blockIds[2]]);

  const body = await (await get(env, `course_id=${courseId}`)).json();
  assert.equal(body.students[0].status, 'complete');
  assert.equal(body.counts.complete, 1);
  assert.ok(body.students[0].last_signed_at > 0);
});

test('a parent who completed a version whose text has since changed is flagged', async () => {
  const { env, courseId, code, blockIds } = await setup();
  await signBlocks(env, code, [blockIds[1], blockIds[2]]);

  // A new version goes live, and the policy they agreed to is not what it was.
  seedSyllabus(env._raw, courseId, [
    { type: 'text', html: '<p>Late work loses 5% per day.</p>' },      // amended
    { type: 'initial', html: 'I have read the late work policy.', needs_initials: true },
    { type: 'initial', html: 'I have read the attendance policy.', needs_initials: true },
  ], { num: 2 });

  const body = await (await get(env, `course_id=${courseId}`)).json();
  assert.equal(body.students[0].status, 'stale');
  assert.equal(body.students[0].last_signed_version, 1);
  assert.equal(body.published.num, 2);
  assert.notEqual(body.students[0].status, 'complete',
    'a policy that changed under a signature must not keep counting as signed');
});

test('republishing without touching the text does not ask anyone to sign again', async () => {
  const { env, courseId, code, blockIds } = await setup();
  await signBlocks(env, code, [blockIds[1], blockIds[2]]);

  // The same words, published again -- a typo fixed elsewhere, a section
  // reordered, or simply a second publish. Publishing clones every block, so
  // matching signatures by block id found nothing here and asked a family who
  // had already read the whole syllabus to initial all of it a second time.
  seedSyllabus(env._raw, courseId, BLOCKS, { num: 2 });

  const body = await (await get(env, `course_id=${courseId}`)).json();
  assert.equal(body.students[0].status, 'complete');
  assert.equal(body.students[0].parent_signed, 2);
});

test('only the section that changed comes back unsigned', async () => {
  // Headings matter here: a prompt attests to its own section, so with them
  // an amendment to one policy leaves the others alone. This is the whole
  // point of an amendment rather than a re-signing.
  const SECTIONED = [
    { type: 'heading', html: 'Late Work' },
    { type: 'text', html: '<p>Late work loses 10% per day.</p>' },
    { type: 'initial', html: 'I have read the late work policy.', needs_initials: true },
    { type: 'heading', html: 'Attendance' },
    { type: 'text', html: '<p>Three absences triggers a call home.</p>' },
    { type: 'initial', html: 'I have read the attendance policy.', needs_initials: true },
  ];
  const env = freshEnv();
  const { courseId, rosterId } = seedStudent(env._raw, { parentEmail: 'family@example.com' });
  const { code } = await seedAccount(env._raw, rosterId);
  const { blockIds } = seedSyllabus(env._raw, courseId, SECTIONED);
  await signBlocks(env, code, [blockIds[2], blockIds[5]]);

  assert.equal((await (await get(env, `course_id=${courseId}`)).json()).students[0].status, 'complete');

  // Amend late work only.
  const amended = SECTIONED.map((b, i) => (i === 1 ? { ...b, html: '<p>Late work loses 5% per day.</p>' } : b));
  seedSyllabus(env._raw, courseId, amended, { num: 2 });

  const body = await (await get(env, `course_id=${courseId}`)).json();
  assert.equal(body.students[0].required, 2);
  assert.equal(body.students[0].parent_signed, 1, 'attendance still stands; late work does not');
  assert.equal(body.students[0].status, 'stale');
});

test('a dropped student disappears from the working list', async () => {
  const { env, courseId } = await setup();
  env._raw.prepare("UPDATE roster SET status = 'dropped'").run();
  const body = await (await get(env, `course_id=${courseId}`)).json();
  assert.equal(body.total, 0);
});

test('a course with no published syllabus reports nobody as signable', async () => {
  const env = freshEnv();
  const { courseId, rosterId } = seedStudent(env._raw);
  await seedAccount(env._raw, rosterId);
  seedSyllabus(env._raw, courseId, BLOCKS, { published: false });

  const body = await (await get(env, `course_id=${courseId}`)).json();
  assert.equal(body.published, null);
  assert.equal(body.students[0].required, 0);
  assert.equal(body.students[0].status, 'not_started');
});

// ---- export ----

test('the CSV export carries the status and the timestamp', async () => {
  const { env, courseId, code, blockIds } = await setup();
  await signBlocks(env, code, [blockIds[1], blockIds[2]]);

  const res = await get(env, `course_id=${courseId}&format=csv`);
  const csv = await res.text();
  assert.match(res.headers.get('Content-Disposition'), /signatures-algebra-i\.csv/);
  assert.match(csv, /Alvarez, Maria/);
  assert.match(csv, /Complete/);
  assert.match(csv, /2,2,\d{4}-\d{2}-\d{2}T/);
});

test('progress requires Access', async () => {
  const { env, courseId } = await setup();
  const res = await progress({ request: new Request(`https://x/api/admin/progress?course_id=${courseId}`), env });
  assert.equal(res.status, 401);
});

// ---- printable signed copy ----

const printed = (env, qs) =>
  signedCopy({ request: new Request(`https://x/admin/signed?${qs}`, { headers: ADMIN_HEADERS }), env });

test('the signed copy stamps each initial with its audit detail', async () => {
  const { env, accountId, code, blockIds } = await setup();
  await signBlocks(env, code, [blockIds[1], blockIds[2]]);

  const page = await (await printed(env, `account_id=${accountId}`)).text();
  assert.match(page, /Alvarez, Maria/);
  assert.match(page, /ID 904511/);
  assert.match(page, /2 of 2 required sections/);
  assert.match(page, /<b>MRA<\/b>/);
  assert.match(page, /text hash [0-9a-f]{16}/, 'the record shows the hash of what was agreed to');
});

test('the signed copy marks sections that were never initialed', async () => {
  const { env, accountId, code, blockIds } = await setup();
  await signBlocks(env, code, [blockIds[1]]);

  const page = await (await printed(env, `account_id=${accountId}`)).text();
  assert.match(page, /1 of 2 required sections/);
  assert.match(page, /not initialed/);
});

test('the signed copy shows the version actually signed, not the current one', async () => {
  const { env, courseId, accountId, code, blockIds } = await setup();
  await signBlocks(env, code, [blockIds[1], blockIds[2]]);

  seedSyllabus(env._raw, courseId, [
    { type: 'initial', html: 'Revised policy nobody has signed.', needs_initials: true },
  ], { num: 2 });

  const page = await (await printed(env, `account_id=${accountId}`)).text();
  assert.match(page, /Version<\/dt><dd>1,/);
  assert.ok(!page.includes('Revised policy nobody has signed'),
    'printing current text over an old signature would misrepresent what was agreed to');
});

test('the signed copy escapes content rather than rendering it', async () => {
  const env = freshEnv();
  const { courseId, rosterId } = seedStudent(env._raw, { last: '<script>alert(1)</script>' });
  const { accountId } = await seedAccount(env._raw, rosterId);
  seedSyllabus(env._raw, courseId, BLOCKS);

  const page = await (await printed(env, `account_id=${accountId}`)).text();
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.match(page, /&lt;script&gt;/);
});

test('the signed copy requires Access', async () => {
  const { env, accountId } = await setup();
  const res = await signedCopy({ request: new Request(`https://x/admin/signed?account_id=${accountId}`), env });
  assert.equal(res.status, 401);
});

test('an unknown account is refused', async () => {
  const { env } = await setup();
  assert.equal((await printed(env, 'account_id=99999')).status, 400);
});
