// The signing flow: access-code login, reading the published syllabus, and
// recording initials.
//
// This is the part of the app that produces a legal artifact, so the tests
// lean on the boundaries: can a stranger get in, can a signer reach another
// class's syllabus, can a published section be altered after it was initialed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedAccount, seedSyllabus, cookieFrom, jsonRequest } from './helpers.mjs';
import { onRequestPost as login } from '../functions/api/sign/login.js';
import { onRequestGet as getSyllabus } from '../functions/api/sign/syllabus.js';
import { onRequestPost as postInitial } from '../functions/api/sign/initial.js';
import { signSession } from '../functions/_lib/session.js';

const BLOCKS = [
  { type: 'heading', html: '<h2>Late Work</h2>' },
  { type: 'text', html: '<p>Late work loses 10% per day.</p>' },
  { type: 'initial', html: 'I have read the late work policy.', needs_initials: true },
  { type: 'heading', html: '<h2>Attendance</h2>' },
  { type: 'initial', html: 'I have read the attendance policy.', needs_initials: true },
];

async function setup({ published = true } = {}) {
  const env = freshEnv();
  const { courseId, rosterId, extId } = seedStudent(env._raw);
  const { accountId, code } = await seedAccount(env._raw, rosterId);
  const seeded = seedSyllabus(env._raw, courseId, BLOCKS, { published });
  return { env, courseId, accountId, extId, code, ...seeded };
}

const doLogin = (env, body, headers) =>
  login({ request: jsonRequest('https://x/api/sign/login', body, headers), env });

const withCookie = (cookie) => ({ Cookie: cookie });

// ---- login ----

test('a correct student ID and access code issues a session cookie', async () => {
  const { env, extId, code } = await setup();
  const res = await doLogin(env, { student_ext_id: extId, code, role: 'parent' });
  assert.equal(res.status, 200);
  const cookie = cookieFrom(res);
  assert.match(cookie, /^inishial_session=/);
  const setCookie = res.headers.get('Set-Cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
});

test('the access code is accepted in the format people actually type it', async () => {
  const { env, extId } = await setup();
  const res = await doLogin(env, { student_ext_id: extId, code: 'abcd-2345', role: 'parent' });
  assert.equal(res.status, 200);
});

test('a wrong code is rejected', async () => {
  const { env, extId } = await setup();
  const res = await doLogin(env, { student_ext_id: extId, code: 'WRONG999', role: 'parent' });
  assert.equal(res.status, 401);
});

test('an unknown student ID gives the same message as a wrong code', async () => {
  const { env, extId, code } = await setup();
  const wrongCode = await doLogin(env, { student_ext_id: extId, code: 'WRONG999' });
  const wrongId = await doLogin(env, { student_ext_id: '000000', code });
  assert.equal(wrongCode.status, wrongId.status);
  assert.deepEqual(await wrongCode.json(), await wrongId.json(),
    'differing responses would turn this endpoint into a student-ID oracle');
});

test('repeated wrong codes are rate limited', async () => {
  const { env, extId } = await setup();
  const attempt = () => doLogin(env, { student_ext_id: extId, code: 'WRONG999' });
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await attempt()).status);
  assert.ok(statuses.includes(429), `expected a 429 among ${statuses}`);
  assert.equal(statuses.at(-1), 429);
});

test('a correct code still fails once the limit is hit', async () => {
  const { env, extId, code } = await setup();
  for (let i = 0; i < 6; i++) await doLogin(env, { student_ext_id: extId, code: 'WRONG999' });
  const res = await doLogin(env, { student_ext_id: extId, code });
  assert.equal(res.status, 429, 'brute force must not be rescued by eventually guessing right');
});

test('a dropped student cannot sign in', async () => {
  const { env, extId, code } = await setup();
  env._raw.prepare("UPDATE roster SET status = 'dropped' WHERE student_ext_id = ?").run(extId);
  assert.equal((await doLogin(env, { student_ext_id: extId, code })).status, 401);
});

// ---- reading the syllabus ----

test('the syllabus is unreachable without a session', async () => {
  const { env } = await setup();
  const res = await getSyllabus({ request: new Request('https://x/api/sign/syllabus'), env });
  assert.equal(res.status, 401);
});

test('a tampered session cookie is rejected', async () => {
  const { env, extId, code } = await setup();
  const cookie = cookieFrom(await doLogin(env, { student_ext_id: extId, code }));
  const forged = cookie.slice(0, -4) + 'AAAA';
  const res = await getSyllabus({ request: new Request('https://x/api/sign/syllabus', { headers: withCookie(forged) }), env });
  assert.equal(res.status, 401);
});

test('an expired session is rejected', async () => {
  const { env, accountId } = await setup();
  const stale = await signSession(env, accountId, 'parent', Math.floor(Date.now() / 1000) - 60 * 60 * 24);
  const res = await getSyllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: withCookie(`inishial_session=${stale}`) }), env,
  });
  assert.equal(res.status, 401);
});

test('the syllabus comes back in order with progress', async () => {
  const { env, extId, code } = await setup();
  const cookie = cookieFrom(await doLogin(env, { student_ext_id: extId, code }));
  const res = await getSyllabus({ request: new Request('https://x/api/sign/syllabus', { headers: withCookie(cookie) }), env });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.student, 'Maria Alvarez');
  assert.equal(body.blocks.length, 5);
  assert.deepEqual(body.blocks.map((b) => b.type), ['heading', 'text', 'initial', 'heading', 'initial']);
  assert.deepEqual(body.progress, { signed: 0, required: 2 });
});

test('an unpublished draft is not visible to a signer', async () => {
  const { env, extId, code } = await setup({ published: false });
  const cookie = cookieFrom(await doLogin(env, { student_ext_id: extId, code }));
  const res = await getSyllabus({ request: new Request('https://x/api/sign/syllabus', { headers: withCookie(cookie) }), env });
  assert.equal(res.status, 404);
});

// ---- initialing ----

async function signedIn(role = 'parent') {
  const ctx = await setup();
  const res = await doLogin(ctx.env, { student_ext_id: ctx.extId, code: ctx.code, role });
  return { ...ctx, cookie: cookieFrom(res) };
}

const initial = (env, cookie, body) =>
  postInitial({ request: jsonRequest('https://x/api/sign/initial', body, { Cookie: cookie, 'User-Agent': 'TestAgent/1.0' }), env });

test('initialing a section records the signature with an audit trail', async () => {
  const { env, cookie, blockIds, accountId } = await signedIn();
  const res = await initial(env, cookie, { block_id: blockIds[2], initials: 'mra' });
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.initials, 'MRA');
  assert.deepEqual(body.progress, { signed: 1, required: 2 });
  assert.equal(body.complete, false);

  const row = env._raw.prepare('SELECT * FROM signatures WHERE account_id = ?').get(accountId);
  assert.equal(row.role, 'parent');
  assert.equal(row.user_agent, 'TestAgent/1.0');
  assert.ok(row.signed_at > 0);
  assert.equal(row.block_hash.length, 64);
});

test('the recorded hash is of the stored text, not anything the client sent', async () => {
  const { env, cookie, blockIds } = await signedIn();
  await initial(env, cookie, { block_id: blockIds[2], initials: 'MRA', html: '<p>I agree to nothing.</p>' });

  const row = env._raw.prepare('SELECT block_hash FROM signatures').get();
  const { attestationHash } = await import('../functions/_lib/syllabus.js');
  const stored = env._raw.prepare('SELECT type, html, needs_initials FROM blocks WHERE version_id = (SELECT version_id FROM blocks WHERE id = ?) ORDER BY ord').all(blockIds[2]);
  assert.equal(row.block_hash, await attestationHash(stored, 2));
});

test('the hash covers the policy, not just the prompt sentence', async () => {
  const { env, cookie, blockIds } = await signedIn();
  await initial(env, cookie, { block_id: blockIds[2], initials: 'MRA' });
  const recorded = env._raw.prepare('SELECT block_hash FROM signatures').get().block_hash;

  const { sha256Hex } = await import('../functions/_lib/codes.js');
  const promptOnly = await sha256Hex('I have read the late work policy.');
  assert.notEqual(recorded, promptOnly,
    'hashing the prompt alone would let the 10%-per-day policy be rewritten under a live signature');
});

test('rewriting the policy changes the hash even when the prompt is untouched', async () => {
  const { attestationHash } = await import('../functions/_lib/syllabus.js');
  const before = [
    { type: 'heading', html: '<h2>Late Work</h2>' },
    { type: 'text', html: '<p>Late work loses 10% per day.</p>' },
    { type: 'initial', html: 'I have read the late work policy.', needs_initials: true },
  ];
  const after = before.map((b, i) => (i === 1 ? { ...b, html: '<p>Late work loses 5% per day.</p>' } : b));

  assert.notEqual(await attestationHash(before, 2), await attestationHash(after, 2),
    'the prompt is identical in both; the policy it attests to is not');
});

test('a prompt is unaffected by a change in someone else\'s section', async () => {
  const { attestationHash } = await import('../functions/_lib/syllabus.js');
  const before = [
    { type: 'heading', html: '<h2>Late Work</h2>' },
    { type: 'text', html: '<p>Late work loses 10% per day.</p>' },
    { type: 'initial', html: 'I have read the late work policy.', needs_initials: true },
    { type: 'heading', html: '<h2>Attendance</h2>' },
    { type: 'text', html: '<p>Three tardies equal one absence.</p>' },
  ];
  const after = before.map((b, i) => (i === 4 ? { ...b, html: '<p>Four tardies equal one absence.</p>' } : b));

  assert.equal(await attestationHash(before, 2), await attestationHash(after, 2),
    'a section boundary has to actually bound something, or every edit re-signs everything');
});

test('an agree block attests to the whole document', async () => {
  const { attestationHash, attestedBlocks } = await import('../functions/_lib/syllabus.js');
  const blocks = [
    { type: 'heading', html: '<h2>Late Work</h2>' },
    { type: 'text', html: '<p>Late work loses 10% per day.</p>' },
    { type: 'agree', html: 'I have read this syllabus in full and agree to its terms.', needs_initials: true },
  ];
  assert.equal(attestedBlocks(blocks, 2).length, 3, 'in full means in full');

  const edited = blocks.map((b, i) => (i === 1 ? { ...b, html: '<p>Late work loses 5% per day.</p>' } : b));
  assert.notEqual(await attestationHash(blocks, 2), await attestationHash(edited, 2));
});

test('editing a published section would break its recorded hash', async () => {
  const { env, cookie, blockIds } = await signedIn();
  await initial(env, cookie, { block_id: blockIds[2], initials: 'MRA' });
  const recorded = env._raw.prepare('SELECT block_hash FROM signatures').get().block_hash;

  const { sha256Hex } = await import('../functions/_lib/codes.js');
  const tampered = await sha256Hex('I have read nothing.');
  assert.notEqual(recorded, tampered, 'a changed policy must not silently inherit an old signature');
});

test('a second submission returns the first rather than overwriting it', async () => {
  const { env, cookie, blockIds } = await signedIn();
  const first = await (await initial(env, cookie, { block_id: blockIds[2], initials: 'MRA' })).json();
  const second = await (await initial(env, cookie, { block_id: blockIds[2], initials: 'ZZZ' })).json();

  assert.equal(second.already_signed, true);
  assert.equal(second.initials, 'MRA');
  assert.equal(second.signed_at, first.signed_at);
  const count = env._raw.prepare('SELECT COUNT(*) AS n FROM signatures').get().n;
  assert.equal(count, 1, 'signatures are append-only');
});

test('a parent and a student sign the same section independently', async () => {
  const ctx = await setup();
  const parent = cookieFrom(await doLogin(ctx.env, { student_ext_id: ctx.extId, code: ctx.code, role: 'parent' }));
  const student = cookieFrom(await doLogin(ctx.env, { student_ext_id: ctx.extId, code: ctx.code, role: 'student' }));

  await initial(ctx.env, parent, { block_id: ctx.blockIds[2], initials: 'PAR' });
  await initial(ctx.env, student, { block_id: ctx.blockIds[2], initials: 'STU' });

  // node:sqlite hands back null-prototype rows; spread them so deepEqual can
  // compare against plain object literals.
  const roles = ctx.env._raw.prepare('SELECT role, initials FROM signatures ORDER BY role').all().map((r) => ({ ...r }));
  assert.deepEqual(roles, [{ role: 'parent', initials: 'PAR' }, { role: 'student', initials: 'STU' }]);
});

test('completing every required section reports complete', async () => {
  const { env, cookie, blockIds } = await signedIn();
  await initial(env, cookie, { block_id: blockIds[2], initials: 'MRA' });
  const res = await initial(env, cookie, { block_id: blockIds[4], initials: 'MRA' });
  const body = await res.json();
  assert.deepEqual(body.progress, { signed: 2, required: 2 });
  assert.equal(body.complete, true);
});

test('a block from another class is not reachable', async () => {
  const { env, cookie } = await signedIn();
  const other = seedStudent(env._raw, { course: 'Geometry', extId: '777', last: 'Chen', first: 'Kevin' });
  const otherSyllabus = seedSyllabus(env._raw, other.courseId, BLOCKS, { title: 'Geometry Syllabus' });

  const res = await initial(env, cookie, { block_id: otherSyllabus.blockIds[2], initials: 'MRA' });
  assert.equal(res.status, 404);
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM signatures').get().n, 0);
});

test('a section that does not ask for initials refuses them', async () => {
  const { env, cookie, blockIds } = await signedIn();
  const res = await initial(env, cookie, { block_id: blockIds[1], initials: 'MRA' });
  assert.equal(res.status, 400);
});

test('initials must look like initials', async () => {
  const { env, cookie, blockIds } = await signedIn();
  for (const bad of ['', '   ', '1234', 'Maria Alvarez', '<script>', 'ABCDEFGH']) {
    const res = await initial(env, cookie, { block_id: blockIds[2], initials: bad });
    assert.equal(res.status, 400, `expected "${bad}" to be refused`);
  }
});

test('accented initials are accepted', async () => {
  const { env, cookie, blockIds } = await signedIn();
  const res = await initial(env, cookie, { block_id: blockIds[2], initials: 'Ña' });
  assert.equal(res.status, 201);
});

test('initialing without a session is refused', async () => {
  const { env, blockIds } = await setup();
  const res = await postInitial({ request: jsonRequest('https://x/api/sign/initial', { block_id: blockIds[2], initials: 'MRA' }), env });
  assert.equal(res.status, 401);
});
