// Amending a published syllabus.
//
// The thing being pinned here is a promise made to families: initial the
// syllabus once, and a later correction to ONE policy asks you about that
// policy and nothing else. Publishing clones every block, so nothing about
// that promise is automatic -- a signature is matched to a section by the hash
// of the text it covers, and these tests exist because the obvious
// implementation (match on version_id and block_id) silently asks every parent
// to re-initial the entire document each time the teacher fixes a typo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedAccount, seedSyllabus, ADMIN_HEADERS, jsonRequest, cookieFrom } from './helpers.mjs';
import { onRequestPost as login } from '../functions/api/sign/login.js';
import { onRequestGet as getSyllabus } from '../functions/api/sign/syllabus.js';
import { onRequestPost as postInitial } from '../functions/api/sign/initial.js';
import { onRequestGet as progress } from '../functions/api/admin/progress.js';
import { onRequestGet as signedCopy } from '../functions/admin/signed.js';

const LATE = '<p>Late work loses 10% per day.</p>';
const BLOCKS = [
  { type: 'heading', html: '<h2>Late Work</h2>' },
  { type: 'text', html: LATE },
  { type: 'initial', html: 'I have read the late work policy.', needs_initials: true },
  { type: 'heading', html: '<h2>Attendance</h2>' },
  { type: 'text', html: '<p>Three absences triggers a call home.</p>' },
  { type: 'initial', html: 'I have read the attendance policy.', needs_initials: true },
];

/** The same syllabus with the late-work paragraph rewritten. */
const amended = () => BLOCKS.map((b) => (b.html === LATE ? { ...b, html: '<p>Late work loses 5% per day.</p>' } : b));

async function setup() {
  const env = freshEnv();
  const { courseId, rosterId, extId } = seedStudent(env._raw, { parentEmail: 'family@example.com' });
  const { accountId, code } = await seedAccount(env._raw, rosterId);
  const v1 = seedSyllabus(env._raw, courseId, BLOCKS);
  return { env, courseId, accountId, extId, code, v1 };
}

const signInAs = async (env, extId, code, role = 'parent') => cookieFrom(await login({
  // The email decides which side signs in: the school address is the student,
  // the family address is the parent.
  request: jsonRequest('https://x/api/sign/login', {
    student_ext_id: extId, code, role,
    email: role === 'student' ? '904511@s' : 'parent@example.com',
  }), env,
}));

const view = async (env, cookie) => (await getSyllabus({
  request: new Request('https://x/api/sign/syllabus', { headers: { Cookie: cookie } }), env,
})).json();

const initial = (env, cookie, blockId) => postInitial({
  request: jsonRequest('https://x/api/sign/initial', { block_id: blockId, initials: 'MRA' }, { Cookie: cookie }), env,
});

/** Sign every prompt currently on offer. */
async function signEverything(env, cookie) {
  const doc = await view(env, cookie);
  for (const b of doc.blocks.filter((x) => x.needs_initials)) await initial(env, cookie, b.id);
}

// ---- the promise ----

test('an unchanged section keeps its initials across a republish', async () => {
  const { env, courseId, extId, code } = await setup();
  const cookie = await signInAs(env, extId, code);
  await signEverything(env, cookie);
  assert.deepEqual((await view(env, cookie)).progress, { signed: 2, required: 2 });

  // The teacher amends the late work policy and publishes again.
  seedSyllabus(env._raw, courseId, amended(), { num: 2 });

  const after = await view(env, cookie);
  assert.equal(after.version, 2);
  assert.equal(after.progress.signed, 1, 'attendance still stands');
  assert.equal(after.progress.required, 2);

  const prompts = after.blocks.filter((b) => b.needs_initials);
  assert.equal(prompts[0].signed, null, 'late work: the words moved, so the signature does not carry');
  assert.ok(prompts[1].signed, 'attendance: untouched, still signed');
  assert.equal(prompts[1].signed.version_num, 1, 'and still dated to when they actually signed it');
});

test('only the changed section is flagged as updated', async () => {
  const { env, courseId, extId, code } = await setup();
  const cookie = await signInAs(env, extId, code);
  await signEverything(env, cookie);
  seedSyllabus(env._raw, courseId, amended(), { num: 2 });

  const after = await view(env, cookie);
  assert.equal(after.amended, 1);
  assert.deepEqual(after.blocks.filter((b) => b.updated).map((b) => b.html),
    ['I have read the late work policy.']);
});

test('a family arriving for the first time is told nothing was amended', async () => {
  const { env, courseId, extId, code } = await setup();
  seedSyllabus(env._raw, courseId, amended(), { num: 2 });
  const cookie = await signInAs(env, extId, code);

  const doc = await view(env, cookie);
  assert.equal(doc.amended, 0, 'nothing changed under someone who has never signed');
  assert.equal(doc.blocks.some((b) => b.updated), false);
  assert.equal(doc.progress.signed, 0);
});

test('re-initialing the amended section completes the syllabus again', async () => {
  const { env, courseId, extId, code } = await setup();
  const cookie = await signInAs(env, extId, code);
  await signEverything(env, cookie);
  seedSyllabus(env._raw, courseId, amended(), { num: 2 });

  const outstanding = (await view(env, cookie)).blocks.find((b) => b.updated);
  assert.equal((await initial(env, cookie, outstanding.id)).status, 201, 'a new signature, not a replay of the old one');

  const done = await view(env, cookie);
  assert.deepEqual(done.progress, { signed: 2, required: 2 });
  assert.equal(done.amended, 0);
});

test('two prompts in one section are not satisfied by initialing one of them', async () => {
  // They attest to the identical span of text, so the section hash alone cannot
  // tell them apart -- the key carries the prompt's own sentence for exactly
  // this case. Without it, initialing one filled in the other.
  const env = freshEnv();
  const { courseId, rosterId, extId } = seedStudent(env._raw);
  const { code } = await seedAccount(env._raw, rosterId);
  seedSyllabus(env._raw, courseId, [
    { type: 'heading', html: '<h2>Policies</h2>' },
    { type: 'text', html: '<p>Two things to agree to.</p>' },
    { type: 'initial', html: 'I have read the late work policy.', needs_initials: true },
    { type: 'initial', html: 'I have read the attendance policy.', needs_initials: true },
  ]);

  const cookie = await signInAs(env, extId, code);
  const doc = await view(env, cookie);
  await initial(env, cookie, doc.blocks.filter((b) => b.needs_initials)[0].id);

  const after = await view(env, cookie);
  assert.deepEqual(after.progress, { signed: 1, required: 2 });
});

// ---- what the teacher is shown ----

test('the notify panel names the sections that changed', async () => {
  const { env, courseId, extId, code } = await setup();
  const cookie = await signInAs(env, extId, code);
  await signEverything(env, cookie);
  seedSyllabus(env._raw, courseId, amended(), { num: 2 });

  const body = await (await progress({
    request: new Request(`https://x/api/admin/progress?course_id=${courseId}`, { headers: ADMIN_HEADERS }), env,
  })).json();

  assert.deepEqual(body.amendment, {
    version: 2, previous_version: 1, changed_sections: ['Late Work'],
  });
});

test('a first publish is not described as an amendment', async () => {
  const { env, courseId } = await setup();
  const body = await (await progress({
    request: new Request(`https://x/api/admin/progress?course_id=${courseId}`, { headers: ADMIN_HEADERS }), env,
  })).json();
  assert.equal(body.amendment, null);
});

test('an agree block is not reported as a changed section', async () => {
  // It attests to the whole document, so any edit re-stales it and its
  // "section" is whatever heading opens the syllabus. Still re-initialed;
  // just not something that changed.
  const env = freshEnv();
  const { courseId, rosterId } = seedStudent(env._raw);
  await seedAccount(env._raw, rosterId);
  const WITH_AGREE = [...BLOCKS, { type: 'agree', html: 'I have read this syllabus in full.', needs_initials: true }];
  seedSyllabus(env._raw, courseId, WITH_AGREE);
  seedSyllabus(env._raw, courseId, [...amended(), WITH_AGREE[WITH_AGREE.length - 1]], { num: 2 });

  const body = await (await progress({
    request: new Request(`https://x/api/admin/progress?course_id=${courseId}`, { headers: ADMIN_HEADERS }), env,
  })).json();
  assert.deepEqual(body.amendment.changed_sections, ['Late Work']);
});

// ---- the printable record ----

test('the signed copy stamps a carried signature with the version it was given on', async () => {
  const { env, courseId, accountId, extId, code } = await setup();
  const cookie = await signInAs(env, extId, code);
  await signEverything(env, cookie);
  seedSyllabus(env._raw, courseId, amended(), { num: 2 });

  // Re-initial only the amended section, which is all the app asks for.
  const outstanding = (await view(env, cookie)).blocks.find((b) => b.updated);
  await initial(env, cookie, outstanding.id);

  const page = await (await signedCopy({
    request: new Request(`https://x/admin/signed?account_id=${accountId}`, { headers: ADMIN_HEADERS }), env,
  })).text();

  // Both sections stamped, neither reading as unsigned -- the record is
  // legitimately spread across two versions and the printout has to show that
  // rather than leaving August's signature off the page.
  assert.equal(page.includes('not initialed'), false,
    'a carried signature must not print as missing on the legal record');
  assert.match(page, /on version 1/, 'attendance was agreed to on version 1');
  assert.match(page, /on version 2/, 'late work was re-agreed on version 2');
});
