// Draft/version helpers shared by the authoring endpoints.
//
// The model, restated because everything here depends on it:
//   - Exactly one draft per syllabus: the version row with published_at NULL.
//   - Publishing stamps published_at on that draft. From that moment the row
//     and its blocks are immutable -- nothing updates them, ever.
//   - Publishing then clones the frozen version into a fresh draft, so editing
//     always has somewhere to go and never touches signed content.

import { sha256Hex } from './codes.js';

/** The syllabus for a course, creating it on first use. */
export async function ensureSyllabus(db, courseId, title) {
  const found = await db.prepare('SELECT id, title FROM syllabi WHERE course_id = ?1').bind(courseId).first();
  if (found) return found.id;

  // Slug is derived from the course id so two courses cannot collide on title.
  const slug = `${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'syllabus'}-${courseId}`;
  const ins = await db.prepare('INSERT INTO syllabi (course_id, title, slug) VALUES (?1, ?2, ?3)')
    .bind(courseId, title, slug).run();
  return ins.meta.last_row_id;
}

/** The open draft for a syllabus, creating an empty one if none exists. */
export async function ensureDraft(db, syllabusId) {
  const draft = await db.prepare(
    'SELECT id, num FROM versions WHERE syllabus_id = ?1 AND published_at IS NULL ORDER BY num DESC LIMIT 1',
  ).bind(syllabusId).first();
  if (draft) return draft;

  const max = await db.prepare('SELECT MAX(num) AS n FROM versions WHERE syllabus_id = ?1').bind(syllabusId).first();
  const num = (max?.n ?? 0) + 1;
  const ins = await db.prepare('INSERT INTO versions (syllabus_id, num, published_at) VALUES (?1, ?2, NULL)')
    .bind(syllabusId, num).run();
  return { id: ins.meta.last_row_id, num };
}

export async function latestPublished(db, syllabusId) {
  return db.prepare(
    'SELECT id, num, published_at FROM versions WHERE syllabus_id = ?1 AND published_at IS NOT NULL ORDER BY num DESC LIMIT 1',
  ).bind(syllabusId).first();
}

export async function blocksOf(db, versionId) {
  const { results } = await db.prepare(
    'SELECT id, ord, type, html, needs_initials FROM blocks WHERE version_id = ?1 ORDER BY ord',
  ).bind(versionId).all();
  return (results ?? []).map((b) => ({ ...b, needs_initials: !!b.needs_initials }));
}

const TYPES = new Set(['heading', 'text', 'list', 'initial', 'agree']);

/**
 * Replace a draft's blocks wholesale.
 *
 * Safe precisely because it is a DRAFT: published blocks are never touched, so
 * no signature can be orphaned by this. Callers must refuse to call it with a
 * published version id.
 */
export async function replaceDraftBlocks(db, versionId, blocks) {
  await db.prepare('DELETE FROM blocks WHERE version_id = ?1').bind(versionId).run();
  let ord = 0;
  for (const raw of blocks) {
    const type = TYPES.has(raw.type) ? raw.type : 'text';
    // Only prompts can carry initials -- a heading or a bare paragraph asking
    // for initials would render without anything to sign against.
    const needs = (type === 'initial' || type === 'agree') ? 1 : 0;
    await db.prepare(
      'INSERT INTO blocks (version_id, ord, type, html, needs_initials) VALUES (?1, ?2, ?3, ?4, ?5)',
    ).bind(versionId, ord++, type, String(raw.html ?? ''), needs).run();
  }
  return ord;
}

/**
 * What changed between two versions, by block text.
 *
 * Matching is on content hash rather than block id: publishing clones rows, so
 * ids never survive a version boundary, but the text is exactly what a parent
 * agreed to. Sections whose text is unchanged keep their signatures; the ones
 * listed here are the only ones worth re-requesting initials on.
 */
export async function diffVersions(db, fromVersionId, toVersionId) {
  const [before, after] = await Promise.all([
    fromVersionId ? blocksOf(db, fromVersionId) : Promise.resolve([]),
    blocksOf(db, toVersionId),
  ]);

  const hash = async (b) => `${b.type}:${await sha256Hex(b.html)}`;
  const beforeHashes = new Set(await Promise.all(before.map(hash)));
  const afterHashes = new Set(await Promise.all(after.map(hash)));

  const added = [];
  for (const b of after) {
    if (!beforeHashes.has(await hash(b))) added.push({ type: b.type, html: b.html, needs_initials: b.needs_initials });
  }
  const removed = [];
  for (const b of before) {
    if (!afterHashes.has(await hash(b))) removed.push({ type: b.type, html: b.html });
  }

  return {
    added,
    removed,
    unchanged: after.length - added.length,
    // Only changed sections that ask for initials force anyone to re-sign.
    resign_required: added.filter((b) => b.needs_initials).length,
  };
}
