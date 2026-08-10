// The two whole journeys, end to end, each as one test.
//
// Every other file here tests a seam. This one walks the path a real person
// walks, in order, through the real handlers -- sign-up, sign-in, read, initial,
// sign out, come back -- and asserts the things that person would notice.
//
// It exists because the seams were all green while the flow was broken: the
// suite passed with a student username that could not be minted twice at one
// install, a confirmation card printing the word "null" as an access code, and
// an access-code email that named the parent's username as "null". None of
// those is visible from inside a single endpoint's tests.
//
// The rule the whole design rests on, asserted in both journeys: school, last
// name and student ID identify a person ONCE, at sign-up. After that the
// credential is a username and an access code, and sign-in accepts nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedSchoolRoster, seedSyllabus, cookieFrom, jsonRequest } from './helpers.mjs';
import { onRequestPost as register } from '../functions/api/register.js';
import { onRequestPost as login, onRequestDelete as signOut } from '../functions/api/sign/login.js';
import { onRequestPost as requestCode } from '../functions/api/sign/request-code.js';
import { onRequestGet as getSyllabus } from '../functions/api/sign/syllabus.js';
import { onRequestPost as postInitial } from '../functions/api/sign/initial.js';

const BLOCKS = [
  { type: 'heading', html: '<h2>Late Work</h2>' },
  { type: 'text', html: '<p>Late work loses 10% per day.</p>' },
  { type: 'initial', html: 'I have read the late work policy.', needs_initials: true },
  { type: 'heading', html: '<h2>Attendance</h2>' },
  { type: 'initial', html: 'I have read the attendance policy.', needs_initials: true },
];

/** A school with one course, one roster row, and a published syllabus. */
async function school(env) {
  const seat = await seedSchoolRoster(env, {
    school: 'Northside High', course: 'Algebra I',
    extId: '904511', last: 'Alvarez', period: '3',
    parentEmail: 'family@example.com',
  });
  const syllabus = seedSyllabus(env._raw, seat.courseId, BLOCKS);
  return { ...seat, ...syllabus };
}

const post = (env, url, body, headers) =>
  ({ register, requestCode, login }[url])({ request: jsonRequest(`https://x/api/${url}`, body, headers), env });

const view = (env, cookie) =>
  getSyllabus({ request: new Request('https://x/api/sign/syllabus', { headers: { Cookie: cookie } }), env });

const initial = (env, cookie, blockId, initials) =>
  postInitial({ request: jsonRequest('https://x/api/sign/initial', { block_id: blockId, initials }, { Cookie: cookie }), env });

// The cookie goes WITH the sign-out. Without it the endpoint has no claims to
// revoke, and "signed out" would mean only that this request forgot to send
// one -- which is a test that proves nothing about the session.
const out = (env, cookie) => signOut({
  request: new Request('https://x/api/sign/login', { method: 'DELETE', headers: { Cookie: cookie } }), env,
});

// ---------------------------------------------------------------------------

test('JOURNEY: a student signs up, reads, initials, signs out, and comes back', async () => {
  const env = freshEnv();
  const seat = await school(env);

  // --- 1. First day of class. School, last name, student ID: identification,
  //        and the only time any of it is asked for.
  const regRes = await post(env, 'register', {
    school_id: seat.schoolId, student_ext_id: '904511', last: 'Alvarez',
  });
  assert.equal(regRes.status, 201);
  const reg = await regRes.json();

  // The two things they walk away with, and the screen is the only place the
  // code will ever appear.
  assert.equal(reg.username, `904511@s${seat.schoolId}`);
  assert.match(reg.student_code, /^[2-9A-HJ-NP-Z]{8}$/);
  assert.equal(reg.student, 'Alvarez', 'surname only -- given names are not stored');
  // Nothing about the family leaks onto a screen in a classroom.
  assert.ok(!JSON.stringify(reg).includes('family@example.com'));

  // Registration signs them straight in, so they can initial without typing
  // the code they were handed five seconds ago.
  const first = cookieFrom(regRes);
  assert.match(first, /^inishial_session=/);

  // --- 2. They read, and initial one of the two sections.
  const opened = await (await view(env, first)).json();
  assert.equal(opened.role, 'student');
  assert.deepEqual(opened.progress, { signed: 0, required: 2 });

  const prompts = opened.blocks.filter((b) => b.needs_initials);
  assert.equal((await initial(env, first, prompts[0].id, 'MA')).status, 201);

  // --- 3. Bell rings. They sign out of a shared Chromebook.
  const signedOut = await out(env, first);
  assert.equal(signedOut.status, 200);
  assert.match(signedOut.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await getSyllabus({ request: new Request('https://x/api/sign/syllabus'), env })).status, 401,
    'the next person at this machine is nobody');
  // And the token itself is dead, not merely dropped by this browser. Someone
  // holding a copy of the cookie gets nothing.
  assert.equal((await view(env, first)).status, 401,
    'a captured cookie must not outlive the sign-out');

  // --- 4. Back that evening, with the two things they wrote down and nothing
  //        else. No student ID, no school, no last name.
  const backRes = await post(env, 'login', { username: reg.username, code: reg.student_code });
  assert.equal(backRes.status, 200);
  assert.equal((await backRes.json()).role, 'student');
  const back = cookieFrom(backRes);

  // --- 5. The morning's work is still there, and the rest is still to do.
  const evening = await (await view(env, back)).json();
  assert.deepEqual(evening.progress, { signed: 1, required: 2 });
  const done = evening.blocks.filter((b) => b.signed);
  assert.equal(done.length, 1);
  assert.equal(done[0].signed.initials, 'MA');

  // --- 6. Finish.
  const remaining = evening.blocks.filter((b) => b.needs_initials && !b.signed);
  assert.equal((await initial(env, back, remaining[0].id, 'MA')).status, 201);
  assert.deepEqual((await (await view(env, back)).json()).progress, { signed: 2, required: 2 });

  // Two signatures, both the student's, on the one account.
  const rows = env._raw.prepare('SELECT role FROM signatures').all();
  assert.deepEqual(rows.map((r) => r.role), ['student', 'student']);
});

// ---------------------------------------------------------------------------

test('JOURNEY: a parent is emailed their credentials, signs, and signs out', async () => {
  const env = freshEnv({ MAIL_DRY_RUN: '1', CODE_SECRET: 'test-code-secret-at-least-16-chars' });
  const seat = await school(env);

  // --- 1. The student has to exist before there is anything to mail.
  const early = await post(env, 'requestCode', {
    school_id: seat.schoolId, student_ext_id: '904511', last: 'Alvarez', email: 'family@example.com',
  });
  assert.equal(early.status, 400, 'nothing to send until the student sets up their account');

  const reg = await (await post(env, 'register', {
    school_id: seat.schoolId, student_ext_id: '904511', last: 'Alvarez',
  })).json();

  // --- 2. The parent asks for their code. Same three identifying facts as the
  //        student gave, plus the inbox it should go to.
  const askRes = await post(env, 'requestCode', {
    school_id: seat.schoolId, student_ext_id: '904511', last: 'Alvarez', email: 'family@example.com',
  });
  assert.equal(askRes.status, 200);
  const ask = await askRes.json();
  assert.equal(ask.email_preview, 'f•••@example.com', 'enough to know which inbox, not enough to harvest');

  // --- 3. What the mail carries. Read from the database because MAIL_DRY_RUN
  //        does not deliver, but these are the exact values it was handed.
  const identity = env._raw.prepare('SELECT username, parent_username FROM student_identities').get();
  assert.equal(identity.parent_username, `904511@p${seat.schoolId}`);
  assert.equal(identity.username, `904511@s${seat.schoolId}`);
  assert.notEqual(identity.parent_username, identity.username, 'two people, two usernames');

  const parentCode = await (await import('../functions/_lib/vault.js'))
    .openCode(env, env._raw.prepare('SELECT code_enc FROM student_identities').get().code_enc);
  assert.match(parentCode, /^[2-9A-HJ-NP-Z]{8}$/);

  // --- 4. Sign in. Username and code, nothing else -- and the code decides the
  //        role, so the parent gets a parent session without ever claiming one.
  const inRes = await post(env, 'login', { username: identity.parent_username, code: parentCode });
  assert.equal(inRes.status, 200);
  assert.equal((await inRes.json()).role, 'parent');
  const cookie = cookieFrom(inRes);

  // The student's code does NOT open the parent's side, and vice versa. This is
  // the whole reason there are two codes.
  assert.equal((await post(env, 'login', { username: identity.parent_username, code: reg.student_code })).status, 401);
  assert.equal((await post(env, 'login', { username: identity.username, code: parentCode })).status, 401);

  // --- 5. Read and initial both sections.
  const doc = await (await view(env, cookie)).json();
  assert.equal(doc.role, 'parent');
  assert.equal(doc.student, 'Alvarez');
  for (const b of doc.blocks.filter((x) => x.needs_initials)) {
    assert.equal((await initial(env, cookie, b.id, 'JA')).status, 201);
  }
  assert.deepEqual((await (await view(env, cookie)).json()).progress, { signed: 2, required: 2 });

  // --- 6. Sign out. The signatures stay; the session does not.
  assert.equal((await out(env, cookie)).status, 200);
  assert.equal((await view(env, cookie)).status, 401, 'the parent cookie is dead');

  const saved = env._raw.prepare("SELECT role, initials FROM signatures WHERE role = 'parent'").all();
  assert.equal(saved.length, 2, 'signing out never costs a signature');

  // --- 7. Back in, and it still reads as done.
  const again = cookieFrom(await post(env, 'login', { username: identity.parent_username, code: parentCode }));
  assert.deepEqual((await (await view(env, again)).json()).progress, { signed: 2, required: 2 });
});

// ---------------------------------------------------------------------------

test('JOURNEY: the two attestations stay independent on one account', async () => {
  // A family sharing one inbox holds both codes -- the access-code email sends
  // both on purpose. What must remain true is that each code writes only its
  // own side, so "the parent agreed" and "the student agreed" never collapse
  // into one signature made twice by whoever was sitting there.
  const env = freshEnv({ MAIL_DRY_RUN: '1', CODE_SECRET: 'test-code-secret-at-least-16-chars' });
  const seat = await school(env);

  const reg = await (await post(env, 'register', {
    school_id: seat.schoolId, student_ext_id: '904511', last: 'Alvarez',
  })).json();
  await post(env, 'requestCode', {
    school_id: seat.schoolId, student_ext_id: '904511', last: 'Alvarez', email: 'family@example.com',
  });
  const identity = env._raw.prepare('SELECT username, parent_username, code_enc FROM student_identities').get();
  const parentCode = await (await import('../functions/_lib/vault.js')).openCode(env, identity.code_enc);

  // Both signed in at once -- the normal case, one kitchen table, two people.
  const asStudent = cookieFrom(await post(env, 'login', { username: identity.username, code: reg.student_code }));
  const asParent = cookieFrom(await post(env, 'login', { username: identity.parent_username, code: parentCode }));

  // The student signs everything, then signs out.
  const blocks = (await (await view(env, asStudent)).json()).blocks.filter((b) => b.needs_initials);
  for (const b of blocks) await initial(env, asStudent, b.id, 'MA');
  await out(env, asStudent);

  assert.equal((await view(env, asStudent)).status, 401, 'the student is signed out');
  assert.equal((await view(env, asParent)).status, 200,
    "a student signing out must not end their parent's session -- two people, one account row");
  // The parent's own view shows NOTHING signed yet: the student's initials are
  // not the parent's, and a page that showed them as done would collect no
  // parent signature at all.
  const parentView = await (await view(env, asParent)).json();
  assert.deepEqual(parentView.progress, { signed: 0, required: 2 },
    "the student's work must not read as the parent's");
  for (const b of parentView.blocks.filter((x) => x.needs_initials)) {
    await initial(env, asParent, b.id, 'JA');
  }

  // Four signatures on one account: two roles, two sections each, kept apart.
  const rows = env._raw.prepare('SELECT role, initials FROM signatures ORDER BY role, block_id').all();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => `${r.role}:${r.initials}`),
    ['parent:JA', 'parent:JA', 'student:MA', 'student:MA']);
  assert.equal(new Set(env._raw.prepare('SELECT account_id FROM signatures').all().map((r) => r.account_id)).size, 1,
    'one student, one account, both attestations');
});
