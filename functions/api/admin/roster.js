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

import { json, badRequest, unauthorized, serverMisconfigured, requireAdmin, ownerFilter } from '../../_lib/http.js';
import { parseRoster } from '../../_lib/csv.js';
import { seal, open, blindIndex, vaultReady } from '../../_lib/vault.js';

export async function onRequestPost({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  // Fails CLOSED, unlike the access-code vault, and for the opposite reason.
  // A missing secret there costs a teacher the ability to re-read a code; here
  // it would mean writing surnames the app cannot match on -- rows that look
  // imported and then refuse every student who tries to register against them.
  // Refusing the upload is recoverable; a silently unusable roster is not.
  if (!vaultReady(env)) return serverMisconfigured('CODE_SECRET, which student names are sealed with');

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
    return json(await previewPlan(env.DB, rows, fallbackCourse, admin, { skipped, warnings, delimiter, env }));
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const owner = ownerFilter(admin);
  const courseIds = new Map();

  async function courseId(name) {
    if (courseIds.has(name)) return courseIds.get(name);
    // Scoped to the uploader. Course names are not unique across the school --
    // two teachers both have an "Algebra I" -- so an unscoped match by name
    // would drop one teacher's students into the other's roster, and the drop
    // sweep below would then mark the rightful class as having left.
    //
    // `IS` rather than `=`: owner is NULL for the site owner, and `= NULL`
    // matches nothing in SQL.
    const found = await env.DB.prepare('SELECT id FROM courses WHERE name = ?1 AND owner_id IS ?2')
      .bind(name, owner).first();
    let id = found?.id;
    if (!id) {
      const ins = await env.DB.prepare('INSERT INTO courses (name, created_at, owner_id) VALUES (?1, ?2, ?3)')
        .bind(name, nowSec, owner).run();
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
    // Sealed for display, digested for matching. The digest is scoped by
    // student ID so the same surname in two classes does not share one value;
    // the ID is not a secret, it is a domain separator. Registration recomputes
    // this from what the student types, so the normalisation inside blindIndex
    // is the contract between the two.
    const lastEnc = await seal(env, row.last);
    const lastIdx = await blindIndex(env, row.last, row.student_ext_id);
    await env.DB.prepare(
      `INSERT INTO roster (course_id, period, student_ext_id, last_enc, last_idx, parent_email, status, last_seen_import)
       VALUES (?1, ?2, ?3, ?4, ?5, ?7, 'active', ?6)
       ON CONFLICT(course_id, student_ext_id) DO UPDATE SET
         period           = excluded.period,
         last_enc         = excluded.last_enc,
         last_idx         = excluded.last_idx,
         last_seen_import = excluded.last_seen_import,
         -- Keep the address already on file when a later export omits it,
         -- rather than blanking a contact that was working.
         parent_email     = COALESCE(excluded.parent_email, roster.parent_email),
         -- A student back on the roster is active again, and their account and
         -- signatures come with them.
         status           = 'active',
         dropped_at       = NULL`,
    ).bind(cid, row.period, row.student_ext_id, lastEnc, lastIdx, importId, row.parent_email).run();
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
async function previewPlan(db, rows, fallbackCourse, admin, extra) {
  const owner = ownerFilter(admin);
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
      // Same owner scoping as the write path, or the preview would report
      // "updates 30" against a course the upload is not going to touch.
      const found = await db.prepare('SELECT id FROM courses WHERE name = ?1 AND owner_id IS ?2')
        .bind(name, owner).first();
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
      `SELECT student_ext_id, last_enc FROM roster
        WHERE course_id = ?1 AND (period IS ?2 OR period = ?2) AND status = 'active'`,
    ).bind(courseId, period).all();
    for (const r of results ?? []) {
      if (present.has(r.student_ext_id)) continue;
      // Falls back to the ID alone when the name will not open -- a preview of
      // who is about to be dropped is too important to blank out over a row
      // sealed under a rotated secret.
      const name = await open(extra.env, r.last_enc);
      wouldDrop.push(name ? `${name} (${r.student_ext_id})` : r.student_ext_id);
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
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.archived_at,
            SUM(CASE WHEN r.status = 'active'  THEN 1 ELSE 0 END)    AS students,
            SUM(CASE WHEN r.status = 'dropped' THEN 1 ELSE 0 END)    AS dropped,
            COUNT(a.id)                                              AS registered,
            SUM(CASE WHEN si.code_hash IS NOT NULL THEN 1 ELSE 0 END) AS codes_issued,
            -- A SUBQUERY, not a fourth join. Joining signatures here would
            -- multiply every roster row by the number of initials that student
            -- gave, and the four counts above -- all computed off that same
            -- fanned-out row set -- would silently inflate with it. This is the
            -- number Delete quotes back before it destroys anything, so it has
            -- to be the true one.
            (SELECT COUNT(*)
               FROM signatures s
               JOIN accounts a2 ON a2.id = s.account_id
               JOIN roster   r2 ON r2.id = a2.roster_id
              WHERE r2.course_id = c.id)                             AS signatures
       FROM courses c
       LEFT JOIN roster   r ON r.course_id = c.id
       LEFT JOIN accounts a ON a.roster_id = r.id AND r.status = 'active'
       LEFT JOIN student_identities si ON si.id = a.identity_id
      -- IS, not =: one bound value covers "mine" and, for the shared
      -- password, the unowned ones. The old (?1 IS NULL OR owner_id = ?1)
      -- read as a filter and behaved as a bypass -- NULL matched every
      -- course in the school rather than the unowned ones.
      WHERE c.owner_id IS ?1
      GROUP BY c.id, c.name
      -- Archived classes come back with the rest rather than being filtered
      -- out here: the page still has to render them, in their own section, and
      -- a second round trip to fetch last year's list would buy nothing at the
      -- scale one teacher's classes actually reach.
      ORDER BY c.archived_at IS NOT NULL, c.name`,
  ).bind(ownerFilter(admin)).all();

  return json({ courses: results ?? [] });
}
