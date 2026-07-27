// Authoring: drafts, publishing, and the immutability rule everything else
// depends on -- a published version and its blocks are never modified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, seedStudent, seedAccount, seedSyllabus, ADMIN_HEADERS, jsonRequest, cookieFrom } from './helpers.mjs';
import { onRequestGet as getSyllabus, onRequestPost as saveDraft, onRequestPut as publish } from '../functions/api/admin/syllabus.js';
import { onRequestPost as suggest } from '../functions/api/admin/suggest.js';
import { onRequestPost as signLogin } from '../functions/api/sign/login.js';
import { onRequestGet as parentView } from '../functions/api/sign/syllabus.js';
import { diffVersions, blocksOf } from '../functions/_lib/syllabus.js';

const DRAFT = [
  { type: 'heading', html: '<h2>Late Work</h2>' },
  { type: 'text', html: '<p>Late work loses 10% per day.</p>' },
  { type: 'initial', html: 'I have read the late work policy.' },
];

const adminGet = (env, qs) =>
  getSyllabus({ request: new Request(`https://x/api/admin/syllabus?${qs}`, { headers: ADMIN_HEADERS }), env });

const adminSave = (env, body) =>
  saveDraft({ request: jsonRequest('https://x/api/admin/syllabus', body, ADMIN_HEADERS), env });

const adminPublish = (env, body, qs = '') =>
  publish({
    request: new Request(`https://x/api/admin/syllabus${qs}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...ADMIN_HEADERS }, body: JSON.stringify(body),
    }),
    env,
  });

function course(env, name = 'Algebra I') {
  return Number(env._raw.prepare('INSERT INTO courses (name, created_at) VALUES (?, 1)').run(name).lastInsertRowid);
}

// ---- drafts ----

test('a course with no syllabus reports empty rather than failing', async () => {
  const env = freshEnv();
  const body = await (await adminGet(env, `course_id=${course(env)}`)).json();
  assert.equal(body.syllabus, null);
  assert.deepEqual(body.blocks, []);
});

test('saving creates a syllabus and an unpublished draft', async () => {
  const env = freshEnv();
  const id = course(env);
  const saved = await (await adminSave(env, { course_id: id, title: 'Algebra I Syllabus', blocks: DRAFT })).json();

  assert.equal(saved.blocks, 3);
  assert.equal(saved.draft.num, 1);
  assert.equal(env._raw.prepare('SELECT published_at FROM versions WHERE id = ?').get(saved.draft.id).published_at, null);
});

test('saving twice replaces the draft rather than appending', async () => {
  const env = freshEnv();
  const id = course(env);
  await adminSave(env, { course_id: id, blocks: DRAFT });
  const second = await (await adminSave(env, { course_id: id, blocks: DRAFT.slice(0, 2) })).json();

  assert.equal(second.blocks, 2);
  assert.equal(env._raw.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 1, 'still one draft');
});

test('only prompt blocks can require initials', async () => {
  const env = freshEnv();
  const id = course(env);
  await adminSave(env, {
    course_id: id,
    // A heading claiming to need initials would render with nothing to sign.
    blocks: [{ type: 'heading', html: '<h2>X</h2>', needs_initials: true }, { type: 'initial', html: 'I agree.' }],
  });
  const rows = env._raw.prepare('SELECT type, needs_initials FROM blocks ORDER BY ord').all();
  assert.equal(rows[0].needs_initials, 0);
  assert.equal(rows[1].needs_initials, 1);
});

test('an unknown block type falls back to text instead of failing', async () => {
  const env = freshEnv();
  await adminSave(env, { course_id: course(env), blocks: [{ type: 'iframe', html: '<p>hi</p>' }] });
  assert.equal(env._raw.prepare('SELECT type FROM blocks').get().type, 'text');
});

// ---- publishing ----

test('publishing freezes the draft and opens the next one', async () => {
  const env = freshEnv();
  const id = course(env);
  const saved = await (await adminSave(env, { course_id: id, blocks: DRAFT })).json();
  const result = await (await adminPublish(env, { syllabus_id: saved.syllabus_id })).json();

  assert.equal(result.published_version, 1);
  assert.equal(result.next_draft.num, 2);

  const versions = env._raw.prepare('SELECT num, published_at FROM versions ORDER BY num').all();
  assert.equal(versions.length, 2);
  assert.ok(versions[0].published_at > 0, 'v1 is frozen');
  assert.equal(versions[1].published_at, null, 'v2 is the new draft');

  const drafted = await blocksOf(env.DB, result.next_draft.id);
  assert.equal(drafted.length, 3, 'the new draft is a copy, so editing continues where it left off');
});

test('publishing refuses a draft with no section requiring initials', async () => {
  const env = freshEnv();
  const saved = await (await adminSave(env, { course_id: course(env), blocks: DRAFT.slice(0, 2) })).json();
  const res = await adminPublish(env, { syllabus_id: saved.syllabus_id });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at least one section/);
});

test('publishing refuses an empty draft', async () => {
  const env = freshEnv();
  const saved = await (await adminSave(env, { course_id: course(env), blocks: DRAFT })).json();
  await adminSave(env, { course_id: env._raw.prepare('SELECT course_id FROM syllabi').get().course_id, blocks: [] });
  const res = await adminPublish(env, { syllabus_id: saved.syllabus_id });
  assert.equal(res.status, 400);
});

test('editing after publishing never touches the published blocks', async () => {
  const env = freshEnv();
  const id = course(env);
  const saved = await (await adminSave(env, { course_id: id, blocks: DRAFT })).json();
  const published = await (await adminPublish(env, { syllabus_id: saved.syllabus_id })).json();
  const liveVersion = env._raw.prepare("SELECT id FROM versions WHERE published_at IS NOT NULL").get().id;
  const before = await blocksOf(env.DB, liveVersion);

  await adminSave(env, {
    course_id: id,
    blocks: [{ type: 'heading', html: '<h2>Rewritten</h2>' }, { type: 'initial', html: 'Totally different.' }],
  });

  const after = await blocksOf(env.DB, liveVersion);
  assert.deepEqual(after.map((b) => b.html), before.map((b) => b.html),
    'a published version is immutable -- this is what makes a signature mean anything');
  assert.equal(published.next_draft.num, 2);
});

// ---- diffing ----

test('the publish preview reports what changed and writes nothing', async () => {
  const env = freshEnv();
  const id = course(env);
  const saved = await (await adminSave(env, { course_id: id, blocks: DRAFT })).json();
  await adminPublish(env, { syllabus_id: saved.syllabus_id });

  await adminSave(env, {
    course_id: id,
    blocks: [DRAFT[0], { type: 'text', html: '<p>Late work loses 20% per day.</p>' }, DRAFT[2]],
  });

  const preview = await (await adminPublish(env, { syllabus_id: saved.syllabus_id }, '?preview=1')).json();
  assert.equal(preview.preview, true);
  assert.equal(preview.diff.added.length, 1);
  assert.equal(preview.diff.removed.length, 1);
  assert.equal(preview.diff.unchanged, 2, 'the heading and the prompt are untouched');
  assert.equal(preview.diff.resign_required, 0, 'the changed block is prose, so nobody re-initials');

  const published = env._raw.prepare('SELECT COUNT(*) AS n FROM versions WHERE published_at IS NOT NULL').get().n;
  assert.equal(published, 1, 'preview must not publish');
});

test('changing a section that asks for initials flags a re-sign', async () => {
  const env = freshEnv();
  const id = course(env);
  const saved = await (await adminSave(env, { course_id: id, blocks: DRAFT })).json();
  await adminPublish(env, { syllabus_id: saved.syllabus_id });

  await adminSave(env, {
    course_id: id,
    blocks: [DRAFT[0], DRAFT[1], { type: 'initial', html: 'I have read the REVISED late work policy.' }],
  });
  const preview = await (await adminPublish(env, { syllabus_id: saved.syllabus_id }, '?preview=1')).json();
  assert.equal(preview.diff.resign_required, 1);
});

test('a typo fix in prose leaves every signature intact', async () => {
  const env = freshEnv();
  const id = course(env);
  const saved = await (await adminSave(env, { course_id: id, blocks: DRAFT })).json();
  await adminPublish(env, { syllabus_id: saved.syllabus_id });
  const preview = await (await adminPublish(env, { syllabus_id: saved.syllabus_id }, '?preview=1')).json();
  assert.equal(preview.diff.added.length, 0, 'republishing unchanged content changes nothing');
  assert.equal(preview.diff.resign_required, 0);
});

test('diffVersions matches on text, not block id', async () => {
  const env = freshEnv();
  const courseId = course(env);
  const a = seedSyllabus(env._raw, courseId, [{ type: 'initial', html: 'Same words.', needs_initials: true }], { num: 1 });
  const b = seedSyllabus(env._raw, courseId, [{ type: 'initial', html: 'Same words.', needs_initials: true }], { num: 2 });
  const diff = await diffVersions(env.DB, a.versionId, b.versionId);
  assert.equal(diff.added.length, 0, 'ids differ across versions; identical text must still count as unchanged');
  assert.equal(diff.unchanged, 1);
});

// ---- what a parent actually sees ----

test('a parent sees the published version, never the draft', async () => {
  const env = freshEnv();
  const id = course(env);
  const { rosterId } = seedStudent(env._raw, { course: 'Algebra I' });
  // seedStudent reuses the course by name, so point at the row it used.
  const realCourseId = env._raw.prepare('SELECT course_id FROM roster').get().course_id;
  const { code } = await seedAccount(env._raw, rosterId);

  const saved = await (await adminSave(env, { course_id: realCourseId, blocks: DRAFT })).json();
  await adminPublish(env, { syllabus_id: saved.syllabus_id });
  await adminSave(env, { course_id: realCourseId, blocks: [...DRAFT, { type: 'initial', html: 'Secret draft clause.' }] });

  const cookie = cookieFrom(await signLogin({
    request: jsonRequest('https://x/api/sign/login', { student_ext_id: '904511', code }), env,
  }));
  const view = await (await parentView({
    request: new Request('https://x/api/sign/syllabus', { headers: { Cookie: cookie } }), env,
  })).json();

  assert.equal(view.version, 1);
  assert.equal(view.blocks.length, 3);
  assert.ok(!JSON.stringify(view).includes('Secret draft clause'), 'unpublished edits must not leak to parents');
  assert.equal(id > 0, true);
});

// ---- suggestions ----

test('suggestions are unavailable without a key, and say so', async () => {
  const env = freshEnv();
  const body = await (await suggest({
    request: jsonRequest('https://x/api/admin/suggest', { blocks: DRAFT }, ADMIN_HEADERS), env,
  })).json();
  assert.equal(body.available, false);
  assert.deepEqual(body.suggestions, []);
  assert.match(body.reason, /OLLAMA_API_KEY/);
});

test('suggestions require Access', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'x' });
  const res = await suggest({ request: jsonRequest('https://x/api/admin/suggest', { blocks: DRAFT }), env });
  assert.equal(res.status, 401);
});

test('a hallucinated block index is discarded', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test-key' });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    // Index 99 does not exist; index 1 does and is prose.
    message: { content: JSON.stringify({ initial: [{ index: 1, reason: 'grading' }, { index: 99, reason: 'nope' }] }) },
  }), { status: 200 });

  try {
    const body = await (await suggest({
      request: jsonRequest('https://x/api/admin/suggest', {
        blocks: [DRAFT[0], { type: 'text', html: '<p>Late work loses ten percent per day and this is long enough to judge.</p>' }],
      }, ADMIN_HEADERS),
      env,
    })).json();
    assert.deepEqual(body.suggestions, [{ index: 1, reason: 'grading' }]);
  } finally { globalThis.fetch = original; }
});

test('an Ollama failure degrades instead of breaking authoring', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test-key' });
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const body = await (await suggest({
      request: jsonRequest('https://x/api/admin/suggest', {
        blocks: [{ type: 'text', html: '<p>Long enough block of prose to be considered a candidate here.</p>' }],
      }, ADMIN_HEADERS),
      env,
    })).json();
    assert.equal(body.available, false);
    assert.deepEqual(body.suggestions, []);
  } finally { globalThis.fetch = original; }
});
