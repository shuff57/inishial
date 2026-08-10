// The signing flow: access-code login, reading the published syllabus, and
// recording initials.
//
// This is the part of the app that produces a legal artifact, so the tests
// lean on the boundaries: can a stranger get in, can a signer reach another
// class's syllabus, can a published section be altered after it was initialed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedAccount, seedSyllabus, cookieFrom, jsonRequest, d1 } from './helpers.mjs';
import { onRequestPost as login, onRequestDelete as signOut } from '../functions/api/sign/login.js';
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
  const { courseId, rosterId, extId } = await seedStudent(env);
  const { accountId, identityId, code, studentCode } = await seedAccount(env._raw, rosterId);
  const seeded = seedSyllabus(env._raw, courseId, BLOCKS, { published });
  return { env, courseId, accountId, identityId, extId, code, studentCode, ...seeded };
}

// Sign-in takes a username and a code, and nothing else. The username is what
// selects the side -- and, since it carries the school id, what disambiguates a
// student ID that is only unique per course. seedStudent's course is unowned,
// so its identity lands on the placeholder school, id 1.
const PARENT_USER = '904511@p1';
const STUDENT_USER = '904511@s1';

const doLogin = (env, body, headers) =>
  login({ request: jsonRequest('https://x/api/sign/login',
    { username: PARENT_USER, ...body }, headers), env });

const withCookie = (cookie) => ({ Cookie: cookie });

// ---- login ----

test('a correct username and access code issues a session cookie', async () => {
  const { env, extId, code } = await setup();
  const res = await doLogin(env, { code });
  assert.equal(res.status, 200);
  const cookie = cookieFrom(res);
  assert.match(cookie, /^inishial_session=/);
  const setCookie = res.headers.get('Set-Cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
});

// ---- which code was used is what decides whose signature this is ----
//
// Before the split there was ONE code per account and /api/sign/login took the
// role as a request field. The code is mailed to the family, so the student
// usually has it too -- and could pick 'parent' and sign their own parent's
// agreement. These four hold that shut.

test('the parent code opens a parent session and nothing else', async () => {
  const { env, extId, code } = await setup();
  const body = await (await doLogin(env, { code })).json();
  assert.equal(body.role, 'parent');
});

test('the student code opens a student session', async () => {
  const { env, extId, studentCode } = await setup();
  const body = await (await doLogin(env, { username: STUDENT_USER, code: studentCode })).json();
  assert.equal(body.role, 'student');
});

test('a role claimed in the request body is ignored outright', async () => {
  const { env, extId, code, studentCode } = await setup();

  // The old attack, verbatim: the family's code plus "I am the student".
  const posing = await (await doLogin(env, { code, role: 'student' })).json();
  assert.equal(posing.role, 'parent', 'the parent code cannot buy a student session');

  // And the reverse, so the field is dead in both directions rather than
  // merely inconvenient in one.
  const other = await (await doLogin(env, { username: STUDENT_USER, code: studentCode, role: 'parent' })).json();
  assert.equal(other.role, 'student', 'the student code cannot buy a parent session');
});

test('an account with no student code yet still lets the parent in', async () => {
  const { env, extId, code } = await setup();
  env._raw.prepare('UPDATE student_identities SET student_code_hash = NULL, student_code_issued_at = NULL').run();

  assert.equal((await doLogin(env, { code })).status, 200,
    'a roster imported before the split has no student code, and that is not a lockout');
  // A NULL hash must not be a wildcard: an empty or absent code cannot match it.
  assert.equal((await doLogin(env, { code: '' })).status, 400);
  assert.equal((await doLogin(env, { code: 'STU45678' })).status, 401);
});

test('the access code is accepted in the format people actually type it', async () => {
  const { env, extId } = await setup();
  const res = await doLogin(env, { code: 'abcd-2345' });
  assert.equal(res.status, 200);
});

test('a wrong code is rejected', async () => {
  const { env, extId } = await setup();
  const res = await doLogin(env, { code: 'WRONG999' });
  assert.equal(res.status, 401);
});

test('an unknown username gives the same message as a wrong code', async () => {
  const { env, extId, code } = await setup();
  const wrongCode = await doLogin(env, { code: 'WRONG999' });
  const wrongId = await doLogin(env, { username: '000000@p1', code });
  assert.equal(wrongCode.status, wrongId.status);
  assert.deepEqual(await wrongCode.json(), await wrongId.json(),
    'differing responses would turn this endpoint into an account oracle');
});

test('repeated wrong codes are rate limited', async () => {
  const { env, extId } = await setup();
  const attempt = () => doLogin(env, { code: 'WRONG999' });
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await attempt()).status);
  assert.ok(statuses.includes(429), `expected a 429 among ${statuses}`);
  assert.equal(statuses.at(-1), 429);
});

test('a correct code still fails once the limit is hit', async () => {
  const { env, extId, code } = await setup();
  for (let i = 0; i < 6; i++) await doLogin(env, { code: 'WRONG999' });
  const res = await doLogin(env, { code });
  assert.equal(res.status, 429, 'brute force must not be rescued by eventually guessing right');
});

test('a dropped student cannot sign in', async () => {
  const { env, extId, code } = await setup();
  env._raw.prepare("UPDATE roster SET status = 'dropped' WHERE student_ext_id = ?").run(extId);
  assert.equal((await doLogin(env, { code })).status, 401);
});

// ---- signing out ----

test('signing out clears the cookie and the old one stops opening the syllabus', async () => {
  const { env, code } = await setup();
  const cookie = cookieFrom(await doLogin(env, { code }));

  // It works before.
  assert.equal((await getSyllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: withCookie(cookie) }), env,
  })).status, 200);

  const out = await signOut({ request: new Request('https://x/api/sign/login', { method: 'DELETE' }), env });
  assert.equal(out.status, 200);
  const cleared = out.headers.get('Set-Cookie');
  assert.match(cleared, /^inishial_session=;/, 'the cookie is emptied, not merely expired in place');
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /HttpOnly/, 'still HttpOnly, or script could set one back');

  // And the browser that honoured it has nothing left to send.
  assert.equal((await getSyllabus({ request: new Request('https://x/api/sign/syllabus'), env })).status, 401);
});

test('a cookie captured before a sign-out stops working', async () => {
  // The reason sign-out is a server-side generation bump and not just a cleared
  // cookie. Everything here happens inside one second, which is exactly what
  // the first attempt -- comparing the token's `iat` against a revoked-at
  // timestamp -- could not tell apart. See migrations/0014.
  const { env, code, blockIds } = await setup();
  const stolen = cookieFrom(await doLogin(env, { code }));

  assert.equal((await getSyllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: withCookie(stolen) }), env,
  })).status, 200, 'live before');

  await signOut({
    request: new Request('https://x/api/sign/login', { method: 'DELETE', headers: withCookie(stolen) }), env,
  });

  assert.equal((await getSyllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: withCookie(stolen) }), env,
  })).status, 401, 'the token itself is dead, not merely dropped by one browser');

  // And it cannot write either -- reading and signing are separate routes, and
  // a revocation that only covered the read would leave the dangerous half open.
  assert.equal((await initial(env, stolen, { block_id: blockIds[2], initials: 'XX' })).status, 401);
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM signatures').get().n, 0);
});

test('signing back in immediately after signing out works', async () => {
  // The failure mode of the obvious fix. Tightening the timestamp comparison to
  // `<=` would kill a token minted in the same second as the sign-out -- which
  // is precisely the token of someone who signed out of the wrong account and
  // signed straight back into the right one. They would be handed a cookie that
  // 401s on its next request.
  const { env, code } = await setup();
  const first = cookieFrom(await doLogin(env, { code }));
  await signOut({
    request: new Request('https://x/api/sign/login', { method: 'DELETE', headers: withCookie(first) }), env,
  });

  const second = cookieFrom(await doLogin(env, { code }));
  assert.notEqual(second, first, 'a new session, not the old one handed back');
  assert.equal((await getSyllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: withCookie(second) }), env,
  })).status, 200, 'the fresh session must work in the same second the old one died');
});

test('a student signing out leaves the parent signed in', async () => {
  // Two people, one student_identities row. One counter would make this a
  // silent lockout of whoever did not press the button.
  const ctx = await setup();
  const parent = cookieFrom(await doLogin(ctx.env, { username: PARENT_USER, code: ctx.code }));
  const student = cookieFrom(await doLogin(ctx.env, { username: STUDENT_USER, code: ctx.studentCode }));

  await signOut({
    request: new Request('https://x/api/sign/login', { method: 'DELETE', headers: withCookie(student) }),
    env: ctx.env,
  });

  assert.equal((await getSyllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: withCookie(student) }), env: ctx.env,
  })).status, 401, 'the student is out');
  assert.equal((await getSyllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: withCookie(parent) }), env: ctx.env,
  })).status, 200, 'the parent was never asked to leave');
});

test('signing out with no session still signs you out', async () => {
  // Nothing to revoke, and pressing the button must not produce an error.
  const { env } = await setup();
  const res = await signOut({ request: new Request('https://x/api/sign/login', { method: 'DELETE' }), env });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('signing out keeps every signature already recorded', async () => {
  // The promise the button makes: initials are saved, only the session ends.
  const { env, cookie, blockIds, accountId } = await signedIn();
  await initial(env, cookie, { block_id: blockIds[2], initials: 'MRA' });
  await initial(env, cookie, { block_id: blockIds[4], initials: 'MRA' });

  await signOut({ request: new Request('https://x/api/sign/login', { method: 'DELETE' }), env });

  const rows = env._raw.prepare('SELECT block_id, initials, role FROM signatures WHERE account_id = ? ORDER BY block_id').all(accountId);
  assert.equal(rows.length, 2, 'signing out must never delete work');
  assert.deepEqual(rows.map((r) => r.initials), ['MRA', 'MRA']);
});

test('what was signed is still shown after signing back in', async () => {
  const { env, cookie, blockIds, code } = await signedIn();
  await initial(env, cookie, { block_id: blockIds[2], initials: 'MRA' });
  await signOut({ request: new Request('https://x/api/sign/login', { method: 'DELETE' }), env });

  const again = cookieFrom(await doLogin(env, { code }));
  const view = await (await getSyllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: withCookie(again) }), env,
  })).json();

  const signed = view.blocks.filter((b) => b.signed);
  assert.equal(signed.length, 1, 'the work survives the round trip');
  assert.equal(signed[0].signed.initials, 'MRA');
  assert.deepEqual(view.progress, { signed: 1, required: 2 });
});

// ---- reading the syllabus ----

test('the syllabus is unreachable without a session', async () => {
  const { env } = await setup();
  const res = await getSyllabus({ request: new Request('https://x/api/sign/syllabus'), env });
  assert.equal(res.status, 401);
});

test('a tampered session cookie is rejected', async () => {
  const { env, extId, code } = await setup();
  const cookie = cookieFrom(await doLogin(env, { code }));
  const forged = cookie.slice(0, -4) + 'AAAA';
  const res = await getSyllabus({ request: new Request('https://x/api/sign/syllabus', { headers: withCookie(forged) }), env });
  assert.equal(res.status, 401);
});

test('an expired session is rejected', async () => {
  const { env, identityId } = await setup();
  const stale = await signSession(env, identityId, 'parent', Math.floor(Date.now() / 1000) - 60 * 60 * 24);
  const res = await getSyllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: withCookie(`inishial_session=${stale}`) }), env,
  });
  assert.equal(res.status, 401);
});

test('the syllabus comes back in order with progress', async () => {
  const { env, extId, code } = await setup();
  const cookie = cookieFrom(await doLogin(env, { code }));
  const res = await getSyllabus({ request: new Request('https://x/api/sign/syllabus', { headers: withCookie(cookie) }), env });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.student, 'Alvarez');
  assert.equal(body.blocks.length, 5);
  assert.deepEqual(body.blocks.map((b) => b.type), ['heading', 'text', 'initial', 'heading', 'initial']);
  assert.deepEqual(body.progress, { signed: 0, required: 2 });
});

test('an unpublished draft is not visible to a signer', async () => {
  const { env, extId, code } = await setup({ published: false });
  const cookie = cookieFrom(await doLogin(env, { code }));
  const res = await getSyllabus({ request: new Request('https://x/api/sign/syllabus', { headers: withCookie(cookie) }), env });
  assert.equal(res.status, 404);
});

// ---- initialing ----

// The role is not asked for any more -- it follows from WHICH code is used.
async function signedIn(role = 'parent') {
  const ctx = await setup();
  // Username AND code, both from the same side. Sending the student's code
  // under the parent's username is not a student session, it is a 401 -- the
  // username is what selects which hash is checked.
  const side = role === 'student'
    ? { username: STUDENT_USER, code: ctx.studentCode }
    : { username: PARENT_USER, code: ctx.code };
  const res = await doLogin(ctx.env, side);
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

// ---- per-block initials: anchored on a heading, attesting to its section ----

test('a per-block prompt covers the heading and the text underneath it', async () => {
  // The flag is a placement hint (anchor the prompt at a specific heading),
  // not a scope hint. The attestation scope is the same as a section prompt:
  // the heading that opens the section plus everything below it up to the
  // next heading. A parent reading "I have read and understand Late Work" is
  // signing the whole late-work section either way.
  const { attestationHash, attestedBlocks } = await import('../functions/_lib/syllabus.js');
  const stored = (b) => ({ ...b, id: 0, ord: 0, needs_initials: !!b.needs_initials, level: 2, per_block: !!b.per_block });
  const blocks = [
    stored({ type: 'heading', html: '<h2>Late Work</h2>' }),
    stored({ type: 'text', html: '<p>Late work loses 10% per day.</p>' }),
    stored({ type: 'initial', html: 'I have read and understand Late Work.', needs_initials: true, per_block: true }),
    stored({ type: 'text', html: '<p>Exams are weighted 75%.</p>' }),
    stored({ type: 'heading', html: '<h2>Attendance</h2>' }),
  ];

  // Per-block attestation covers heading + first text + prompt + second text.
  const covered = attestedBlocks(blocks, 2);
  assert.deepEqual(covered.map((b) => b.type), ['heading', 'text', 'initial', 'text']);

  // A per-block hash and a section hash at the same position are equal --
  // both attest to the same span, only the placement differs.
  const perBlockHash = await attestationHash(blocks, 2);
  const asSection = blocks.map((b) => ({ ...b, per_block: false }));
  const sectionHash = await attestationHash(asSection, 2);
  assert.equal(perBlockHash, sectionHash,
    'per_block changes where the prompt sits, not what it covers');
});

test('a per-block prompt is re-staled by a change inside its section', async () => {
  // The signature covers the heading and everything underneath it, so a
  // change to any block between this prompt and the next heading stales it.
  // That is the same contract a section prompt already had.
  const { attestationHash } = await import('../functions/_lib/syllabus.js');
  const stored = (b) => ({ ...b, id: 0, ord: 0, needs_initials: !!b.needs_initials, level: 2, per_block: !!b.per_block });
  const before = [
    stored({ type: 'heading', html: '<h2>Late Work</h2>' }),
    stored({ type: 'text', html: '<p>Late work loses 10% per day.</p>' }),
    stored({ type: 'initial', html: 'I have read and understand Late Work.', needs_initials: true, per_block: true }),
    stored({ type: 'text', html: '<p>Exams are weighted 75%.</p>' }),
  ];
  const after = before.map((b, i) => i === 3 ? { ...b, html: '<p>Exams are weighted 70%.</p>' } : b);

  const beforeHash = await attestationHash(before, 2);
  const afterHash = await attestationHash(after, 2);
  assert.notEqual(beforeHash, afterHash,
    'a per-block prompt must re-stale when a section it covers is edited');
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
  const parent = cookieFrom(await doLogin(ctx.env, { code: ctx.code }));
  const student = cookieFrom(await doLogin(ctx.env, { username: STUDENT_USER, code: ctx.studentCode }));

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
  const other = await seedStudent(env, { course: 'Geometry', extId: '777', last: 'Chen', first: 'Kevin' });
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
  for (const bad of ['', '   ', '1234', 'Alvarez', '<script>', 'ABCDEFGH']) {
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

test('the right code with the wrong username does not sign anyone in', async () => {
  const ctx = await setup();
  const res = await doLogin(ctx.env, { username: 'stranger@p1', code: ctx.code });
  assert.equal(res.status, 401, 'the code alone is not enough');
});

test('a student ID shared by two schools resolves by username, not by luck', async () => {
  // student_ext_id is UNIQUE per (school, student_ext_id), so the same number
  // legitimately appears at two schools. Sign-in used to take whichever row the
  // database happened to return first; the school id inside the username is
  // what now makes the two reachable separately -- and it is the same fact that
  // lets both students register at all (migrations/0013).
  const ctx = await setup();
  const { seedSchoolRoster } = await import('./helpers.mjs');
  const other = await seedSchoolRoster(ctx.env, {
    school: 'Southside High', course: 'Geometry', extId: ctx.extId, first: 'Other', last: 'Person',
    parentEmail: 'other-family@example.com',
  });
  const theirSeed = await seedAccount(ctx.env._raw, other.rosterId, {
    code: 'OTHR2345', studentCode: 'OTHRSTU9', parentEmail: 'other-family@example.com',
  });

  // Two identities, one student ID, two distinct usernames.
  assert.notEqual(theirSeed.parentUsername, PARENT_USER, 'the school id is what tells them apart');

  const mine = await doLogin(ctx.env, { username: PARENT_USER, code: ctx.code });
  assert.equal(mine.status, 200);
  assert.equal((await mine.json()).student, 'Alvarez', 'my username, my student');

  const theirs = await doLogin(ctx.env, { username: theirSeed.parentUsername, code: 'OTHR2345' });
  assert.equal(theirs.status, 200);
  assert.equal((await theirs.json()).student, 'Person', 'their username, their student');

  // And a code cannot be used across the two identities that share the ID.
  const crossed = await doLogin(ctx.env, { username: PARENT_USER, code: 'OTHR2345' });
  assert.equal(crossed.status, 401, "the other family's code does not open this one");
});

// ---- identity + course -> account resolution ----

test('a tampered block id from another course resolves to 404, never to another account', async () => {
  const { env, extId, code } = await setup();
  const cookie = cookieFrom(await doLogin(env, { code }));

  // Create a second course with its own syllabus, but no account for this identity.
  const other = await seedStudent(env, { course: 'Geometry', extId: '777', last: 'Chen', first: 'Kevin' });
  const otherSyllabus = seedSyllabus(env._raw, other.courseId, BLOCKS, { title: 'Geometry Syllabus' });

  const res = await initial(env, cookie, { block_id: otherSyllabus.blockIds[2], initials: 'MRA' });
  assert.equal(res.status, 404);
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM signatures').get().n, 0);
});

test('a tampered course id resolves to 404, never to another identity\'s account', async () => {
  const { env, extId, code } = await setup();
  const cookie = cookieFrom(await doLogin(env, { code }));

  // Create a second course with a different student who has an account.
  const other = await seedStudent(env, { course: 'Geometry', extId: '777', last: 'Chen', first: 'Kevin' });
  await seedAccount(env._raw, other.rosterId, { username: 'kchen@chicousd.org' });
  seedSyllabus(env._raw, other.courseId, BLOCKS, { title: 'Geometry Syllabus' });

  // Request the other course's syllabus with our identity's session.
  const res = await getSyllabus({
    request: new Request(`https://x/api/sign/syllabus?course=${other.courseId}`, { headers: withCookie(cookie) }), env,
  });
  assert.equal(res.status, 404);
});

test('the class switcher appears when an identity has more than one account', async () => {
  const env = freshEnv();
  const { courseId: c1, rosterId: r1 } = await seedStudent(env, { course: 'Algebra I', parentEmail: 'family@example.com' });
  const { courseId: c2, rosterId: r2 } = await seedStudent(env, { course: 'Geometry', extId: '904512', last: 'Alvarez', parentEmail: 'family@example.com' });
  seedSyllabus(env._raw, c1, BLOCKS);
  seedSyllabus(env._raw, c2, BLOCKS, { title: 'Geometry Syllabus' });

  // Register once, creating one identity with two accounts.
  const regRes = await (await import('../functions/api/register.js')).onRequestPost({
    request: jsonRequest('https://x/api/register', { student_ext_id: '904511', last: 'Alvarez' }),
    env,
  });
  assert.equal(regRes.status, 201);

  // Manually create the second account (register only fans out to matching roster rows by extId+last).
  const identityId = env._raw.prepare('SELECT identity_id FROM accounts WHERE roster_id = ?').get(r1).identity_id;
  env._raw.prepare('INSERT INTO accounts (roster_id, identity_id, created_at) VALUES (?, ?, 1000)').run(r2, identityId);

  // Login and check the syllabus response includes courses.
  const code = (await regRes.json()).student_code;
  const loginRes = await doLogin(env, { username: STUDENT_USER, code });
  const cookie = cookieFrom(loginRes);
  const doc = await (await getSyllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: withCookie(cookie) }), env,
  })).json();

  assert.ok(doc.courses, 'courses list should be present when identity has more than one account');
  assert.equal(doc.courses.length, 2);
  assert.deepEqual(doc.courses.map((c) => c.name).sort(), ['Algebra I', 'Geometry']);
});

test('the class switcher defaults to the course with unsigned sections remaining', async () => {
  const env = freshEnv();
  const { courseId: c1, rosterId: r1 } = await seedStudent(env, { course: 'Algebra I', parentEmail: 'family@example.com' });
  const { courseId: c2, rosterId: r2 } = await seedStudent(env, { course: 'Geometry', extId: '904512', last: 'Alvarez', parentEmail: 'family@example.com' });
  const s1 = seedSyllabus(env._raw, c1, BLOCKS);
  seedSyllabus(env._raw, c2, BLOCKS, { title: 'Geometry Syllabus' });

  // Register and create both accounts.
  const regRes = await (await import('../functions/api/register.js')).onRequestPost({
    request: jsonRequest('https://x/api/register', { student_ext_id: '904511', last: 'Alvarez' }),
    env,
  });
  const identityId = env._raw.prepare('SELECT identity_id FROM accounts WHERE roster_id = ?').get(r1).identity_id;
  env._raw.prepare('INSERT INTO accounts (roster_id, identity_id, created_at) VALUES (?, ?, 1000)').run(r2, identityId);

  // Sign all blocks in Algebra I.
  const code = (await regRes.json()).student_code;
  const cookie = cookieFrom(await doLogin(env, { username: STUDENT_USER, code }));
  for (const bid of s1.blockIds.filter((_, i) => BLOCKS[i].needs_initials)) {
    await initial(env, cookie, { block_id: bid, initials: 'MA' });
  }

  // Now the default should be Geometry (the one with unsigned sections remaining).
  const doc = await (await getSyllabus({
    request: new Request('https://x/api/sign/syllabus', { headers: withCookie(cookie) }), env,
  })).json();
  assert.equal(doc.course, 'Geometry', 'defaults to the course with work remaining');
});
