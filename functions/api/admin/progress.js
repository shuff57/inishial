// GET /api/admin/progress?course_id=N[&format=csv]   (Access gated)
//
// Who has signed, who hasn't, and who signed something you have since
// replaced. The three things actually worth chasing.
//
// Reported against the CURRENTLY published version. A parent who completed
// version 1 is not "done" once version 2 is live if the sections they signed
// changed -- `stale` exists to make that visible instead of quietly counting
// them as complete.

import { json, badRequest, unauthorized, serverMisconfigured, requireAdmin, ownedCourse, csvResponse, csvRow } from '../../_lib/http.js';

const STATUS = {
  not_registered: 'Not registered',
  no_code: 'No code issued',
  not_started: 'Not started',
  partial: 'Partly signed',
  stale: 'Signed an older version',
  complete: 'Complete',
};

export async function onRequestGet({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const url = new URL(request.url);
  const courseId = Number(url.searchParams.get('course_id'));
  if (!Number.isInteger(courseId) || courseId < 1) return badRequest('course_id is required.');

  const course = await ownedCourse(env, courseId, admin);
  if (!course) return badRequest('No such course.');

  const published = await env.DB.prepare(
    `SELECT v.id, v.num FROM versions v
       JOIN syllabi s ON s.id = v.syllabus_id
      WHERE s.course_id = ?1 AND v.published_at IS NOT NULL
      ORDER BY v.num DESC LIMIT 1`,
  ).bind(courseId).first();

  const required = published
    ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM blocks WHERE version_id = ?1 AND needs_initials = 1')
      .bind(published.id).first())?.n ?? 0
    : 0;

  const versionId = published?.id ?? -1;

  const { results } = await env.DB.prepare(
    `SELECT r.student_ext_id, r.first, r.last, r.period,
            a.id AS account_id, a.username,
            COALESCE(a.parent_email, r.parent_email) AS email,
            CASE WHEN a.code_hash IS NOT NULL THEN 1 ELSE 0 END AS code_issued,
            (SELECT COUNT(*) FROM signatures s
              WHERE s.account_id = a.id AND s.version_id = ?2 AND s.role = 'parent')  AS parent_signed,
            (SELECT COUNT(*) FROM signatures s
              WHERE s.account_id = a.id AND s.version_id = ?2 AND s.role = 'student') AS student_signed,
            (SELECT MAX(v2.num) FROM signatures s2
               JOIN versions v2 ON v2.id = s2.version_id
              WHERE s2.account_id = a.id AND s2.role = 'parent')                      AS last_signed_version,
            (SELECT MAX(s3.signed_at) FROM signatures s3
              WHERE s3.account_id = a.id AND s3.version_id = ?2)                      AS last_signed_at
       FROM roster r
       LEFT JOIN accounts a ON a.roster_id = r.id
      WHERE r.course_id = ?1 AND r.status = 'active'
      ORDER BY r.period, r.last, r.first`,
  ).bind(courseId, versionId).all();

  const students = (results ?? []).map((r) => {
    const parentSigned = r.parent_signed ?? 0;
    let status;
    if (!r.account_id) status = 'not_registered';
    else if (!r.code_issued) status = 'no_code';
    else if (required && parentSigned >= required) status = 'complete';
    else if (parentSigned > 0) status = 'partial';
    else if (r.last_signed_version && published && r.last_signed_version < published.num) status = 'stale';
    else status = 'not_started';

    return {
      student: `${r.last}, ${r.first}`,
      student_ext_id: r.student_ext_id,
      period: r.period,
      username: r.username,
      email: r.email,
      account_id: r.account_id,
      code_issued: !!r.code_issued,
      parent_signed: parentSigned,
      student_signed: r.student_signed ?? 0,
      required,
      last_signed_version: r.last_signed_version,
      last_signed_at: r.last_signed_at,
      status,
      status_label: STATUS[status],
    };
  });

  const counts = students.reduce((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {});

  if (url.searchParams.get('format') === 'csv') {
    const lines = [csvRow(['Student', 'Student ID', 'Period', 'Parent email', 'Status', 'Sections initialed', 'Required', 'Signed on'])];
    for (const s of students) {
      lines.push(csvRow([
        s.student, s.student_ext_id, s.period ?? '', s.email ?? '', s.status_label,
        s.parent_signed, s.required,
        s.last_signed_at ? new Date(s.last_signed_at * 1000).toISOString() : '',
      ]));
    }
    const slug = course.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    return csvResponse(`signatures-${slug || courseId}.csv`, lines.join('\r\n') + '\r\n');
  }

  return json({
    course,
    published: published ? { num: published.num, required } : null,
    counts,
    total: students.length,
    students,
  });
}
