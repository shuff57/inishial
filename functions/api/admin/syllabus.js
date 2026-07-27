// GET  /api/admin/syllabus?course_id=N   -- draft + published state
// POST /api/admin/syllabus               -- save the draft
// PUT  /api/admin/syllabus               -- publish the draft
//
// All Cloudflare Access gated.
//
// Saving only ever writes to the draft version. Publishing freezes it and opens
// a fresh draft, so no request handled here can modify content someone has
// already initialed.

import { json, badRequest, unauthorized, serverMisconfigured, requireAdmin, readJson } from '../../_lib/http.js';
import { ensureSyllabus, ensureDraft, latestPublished, blocksOf, replaceDraftBlocks, diffVersions } from '../../_lib/syllabus.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const courseId = Number(new URL(request.url).searchParams.get('course_id'));
  if (!Number.isInteger(courseId) || courseId < 1) return badRequest('course_id is required.');

  const course = await env.DB.prepare('SELECT id, name FROM courses WHERE id = ?1').bind(courseId).first();
  if (!course) return badRequest('No such course.');

  const syllabus = await env.DB.prepare('SELECT id, title FROM syllabi WHERE course_id = ?1').bind(courseId).first();
  if (!syllabus) {
    return json({ course, syllabus: null, draft: null, published: null, blocks: [] });
  }

  const draft = await ensureDraft(env.DB, syllabus.id);
  const published = await latestPublished(env.DB, syllabus.id);

  return json({
    course,
    syllabus,
    draft,
    published,
    blocks: await blocksOf(env.DB, draft.id),
    // How many signatures exist against the live version -- the number that
    // makes republishing consequential rather than free.
    signatures: published
      ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM signatures WHERE version_id = ?1').bind(published.id).first())?.n ?? 0
      : 0,
  });
}

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  if (!body) return badRequest('Expected a JSON body.');

  const courseId = Number(body.course_id);
  if (!Number.isInteger(courseId) || courseId < 1) return badRequest('course_id is required.');
  if (!Array.isArray(body.blocks)) return badRequest('blocks must be an array.');

  const course = await env.DB.prepare('SELECT id, name FROM courses WHERE id = ?1').bind(courseId).first();
  if (!course) return badRequest('No such course.');

  const title = String(body.title || `${course.name} — Course Syllabus`).slice(0, 200);
  const syllabusId = await ensureSyllabus(env.DB, courseId, title);
  await env.DB.prepare('UPDATE syllabi SET title = ?1 WHERE id = ?2').bind(title, syllabusId).run();

  const draft = await ensureDraft(env.DB, syllabusId);
  const count = await replaceDraftBlocks(env.DB, draft.id, body.blocks);

  return json({ ok: true, syllabus_id: syllabusId, draft, blocks: count, title });
}

export async function onRequestPut({ request, env }) {
  if (!await requireAdmin(request, env)) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  const syllabusId = Number(body?.syllabus_id);
  if (!Number.isInteger(syllabusId) || syllabusId < 1) return badRequest('syllabus_id is required.');

  const syllabus = await env.DB.prepare('SELECT id FROM syllabi WHERE id = ?1').bind(syllabusId).first();
  if (!syllabus) return badRequest('No such syllabus.');

  const draft = await ensureDraft(env.DB, syllabusId);
  const draftBlocks = await blocksOf(env.DB, draft.id);
  if (!draftBlocks.length) return badRequest('There is nothing in the draft to publish.');
  if (!draftBlocks.some((b) => b.needs_initials)) {
    return badRequest('Mark at least one section as needing initials before publishing.');
  }

  const previous = await latestPublished(env.DB, syllabusId);
  const diff = await diffVersions(env.DB, previous?.id ?? null, draft.id);

  // Dry run: show what publishing would mean before it becomes permanent.
  if (new URL(request.url).searchParams.get('preview') === '1') {
    return json({ preview: true, version: draft.num, previous: previous?.num ?? null, diff });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  await env.DB.prepare('UPDATE versions SET published_at = ?1 WHERE id = ?2 AND published_at IS NULL')
    .bind(nowSec, draft.id).run();

  // Open the next draft as a copy, so editing continues without touching what
  // was just frozen.
  const next = await env.DB.prepare('INSERT INTO versions (syllabus_id, num, published_at) VALUES (?1, ?2, NULL)')
    .bind(syllabusId, draft.num + 1).run();
  await replaceDraftBlocks(env.DB, next.meta.last_row_id, draftBlocks);

  return json({
    ok: true,
    published_version: draft.num,
    published_at: nowSec,
    next_draft: { id: next.meta.last_row_id, num: draft.num + 1 },
    diff,
  });
}
