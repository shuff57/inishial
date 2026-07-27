// POST /api/admin/roster   -- upload a roster CSV  (Cloudflare Access gated)
// GET  /api/admin/roster   -- list courses and their registration counts
//
// Body: raw CSV text. Course comes from a `Course` column when the export has
// one (typical multi-section SIS dumps), otherwise from ?course=<name>.
//
// Re-uploading is the expected way to handle adds and drops. Students in the
// file are inserted or updated; students absent from it are marked 'dropped',
// never deleted -- a delete would cascade away signatures that may still need
// producing, and returning students should get their account back rather than
// re-register. This is what every roster-sync system converges on: Canvas
// concludes an enrollment, OneRoster flips status to inactive.
//
// Scoped to the (course, period) pairs the file actually contains. Uploading
// one period must not mark every other period of that course as dropped, and
// that is the mistake this guard exists to prevent.

import { json, badRequest, unauthorized, serverMisconfigured, requireAdmin } from '../../_lib/http.js';
import { parseRoster } from '../../_lib/csv.js';

export async function onRequestPost({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const url = new URL(request.url);
  const fallbackCourse = (url.searchParams.get('course') || '').trim();

  const text = await request.text();
  if (!text.trim()) return badRequest('The uploaded file was empty.');

  let parsed;
  try {
    parsed = parseRoster(text);
  } catch (err) {
    return badRequest(err.message);
  }
  const { rows, skipped, warnings, delimiter } = parsed;
  if (!rows.length) return badRequest('No usable rows found in that file.');

  const needsFallback = rows.some((r) => !r.course);
  if (needsFallback && !fallbackCourse) {
    return badRequest('This file has no Course column. Add ?course=<name> to say which course it is.');
  }

  // Preview: say exactly what this file would do, write nothing. Drops are the
  // part worth seeing before it happens, so the count is surfaced up front
  // rather than reported after the fact.
  if (url.searchParams.get('preview') === '1') {
    return json(await previewPlan(env.DB, rows, fallbackCourse, { skipped, warnings, delimiter }));
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const courseIds = new Map();

  async function courseId(name) {
    if (courseIds.has(name)) return courseIds.get(name);
    const found = await env.DB.prepare('SELECT id FROM courses WHERE name = ?1').bind(name).first();
    let id = found?.id;
    if (!id) {
      const ins = await env.DB.prepare('INSERT INTO courses (name, created_at) VALUES (?1, ?2)')
        .bind(name, nowSec).run();
      id = ins.meta.last_row_id;
    }
    courseIds.set(name, id);
    return id;
  }

  // Every upload gets an id. Rows this import touched carry it; rows that do
  // not are the absentees. Doubles as an audit trail of who uploaded what.
  //
  // An id rather than a timestamp: two uploads inside the same second share a
  // wall-clock value, and the absentee sweep would then match nothing.
  const importRow = await env.DB.prepare(
    'INSERT INTO imports (created_at, admin_email) VALUES (?1, ?2)',
  ).bind(nowSec, admin.email).run();
  const importId = importRow.meta.last_row_id;

  // ON CONFLICT DO UPDATE leaves lastInsertRowid untouched, so per-statement
  // metadata cannot tell an insert from an update. Counting rows either side
  // of the loop can, in two queries rather than one per student.
  const countRoster = async () =>
    (await env.DB.prepare('SELECT COUNT(*) AS n FROM roster').first())?.n ?? 0;
  const before = await countRoster();

  // (course_id, period) pairs present in this file -- the only scopes that may
  // have absentees marked dropped.
  const scopes = new Map();

  for (const row of rows) {
    const cid = await courseId(row.course || fallbackCourse);
    await env.DB.prepare(
      `INSERT INTO roster (course_id, period, student_ext_id, first, last, parent_email, status, last_seen_import)
       VALUES (?1, ?2, ?3, ?4, ?5, ?7, 'active', ?6)
       ON CONFLICT(course_id, student_ext_id) DO UPDATE SET
         period           = excluded.period,
         first            = excluded.first,
         last             = excluded.last,
         last_seen_import = excluded.last_seen_import,
         -- Keep the address already on file when a later export omits it,
         -- rather than blanking a contact that was working.
         parent_email     = COALESCE(excluded.parent_email, roster.parent_email),
         -- A student back on the roster is active again, and their account and
         -- signatures come with them.
         status           = 'active',
         dropped_at       = NULL`,
    ).bind(cid, row.period, row.student_ext_id, row.first, row.last, importId, row.parent_email).run();
    // Key is opaque; the values below are what the drop sweep actually uses.
    scopes.set(JSON.stringify([cid, row.period ?? null]), { cid, period: row.period });
  }

  const inserted = (await countRoster()) - before;
  const updated = rows.length - inserted;

  // Anyone in a scope this file covered but whose row this import did not
  // touch has left that section.
  let dropped = 0;
  for (const { cid, period } of scopes.values()) {
    const result = await env.DB.prepare(
      `UPDATE roster SET status = 'dropped', dropped_at = ?1
        WHERE course_id = ?2
          AND (period IS ?3 OR period = ?3)
          AND status = 'active'
          AND (last_seen_import IS NULL OR last_seen_import < ?4)`,
    ).bind(nowSec, cid, period, importId).run();
    dropped += result.meta.changes ?? 0;
  }

  return json({
    ok: true,
    courses: [...courseIds.keys()],
    imported: rows.length,
    inserted,
    updated,
    dropped,
    skipped,
    warnings,
    with_parent_email: rows.filter((r) => r.parent_email).length,
  });
}

/** Read-only: what a POST of these rows would change. Writes nothing. */
async function previewPlan(db, rows, fallbackCourse, extra) {
  const courses = new Map();   // course name -> course id, or null if new
  // Scope key is only ever an opaque lookup handle. The course id and period
  // are carried in the VALUE rather than parsed back out of the key -- packing
  // them into a string and splitting it breaks the moment a course is called
  // "Algebra I", which is to say immediately.
  const scopes = new Map();
  let inserts = 0;
  let updates = 0;

  for (const row of rows) {
    const name = row.course || fallbackCourse;
    if (!courses.has(name)) {
      const found = await db.prepare('SELECT id FROM courses WHERE name = ?1').bind(name).first();
      courses.set(name, found?.id ?? null);
    }
    const courseId = courses.get(name);

    const existing = courseId
      ? await db.prepare('SELECT status FROM roster WHERE course_id = ?1 AND student_ext_id = ?2')
        .bind(courseId, row.student_ext_id).first()
      : null;
    if (existing) updates++; else inserts++;

    const key = JSON.stringify([name, row.period ?? null]);
    if (!scopes.has(key)) scopes.set(key, { courseId, period: row.period ?? null, present: new Set() });
    scopes.get(key).present.add(row.student_ext_id);
  }

  // Active students inside a covered (course, period) scope but absent from
  // the file. These would be marked dropped -- never deleted.
  const wouldDrop = [];
  for (const { courseId, period, present } of scopes.values()) {
    if (!courseId) continue;
    const { results } = await db.prepare(
      `SELECT student_ext_id, first, last FROM roster
        WHERE course_id = ?1 AND (period IS ?2 OR period = ?2) AND status = 'active'`,
    ).bind(courseId, period).all();
    for (const r of results ?? []) {
      if (!present.has(r.student_ext_id)) wouldDrop.push(`${r.last}, ${r.first} (${r.student_ext_id})`);
    }
  }

  return {
    preview: true,
    delimiter: extra.delimiter === '\t' ? 'tab' : extra.delimiter,
    courses: [...courses.keys()],
    new_courses: [...courses].filter(([, id]) => !id).map(([name]) => name),
    parsed: rows.length,
    inserts,
    updates,
    would_drop: wouldDrop.length,
    would_drop_students: wouldDrop.slice(0, 25),
    with_parent_email: rows.filter((r) => r.parent_email).length,
    sample: rows.slice(0, 5),
    skipped: extra.skipped,
    warnings: extra.warnings,
  };
}

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name,
            SUM(CASE WHEN r.status = 'active'  THEN 1 ELSE 0 END)    AS students,
            SUM(CASE WHEN r.status = 'dropped' THEN 1 ELSE 0 END)    AS dropped,
            COUNT(a.id)                                              AS registered,
            SUM(CASE WHEN a.code_hash IS NOT NULL THEN 1 ELSE 0 END) AS codes_issued
       FROM courses c
       LEFT JOIN roster   r ON r.course_id = c.id
       LEFT JOIN accounts a ON a.roster_id = r.id AND r.status = 'active'
      GROUP BY c.id, c.name
      ORDER BY c.name`,
  ).all();

  return json({ courses: results ?? [] });
}
