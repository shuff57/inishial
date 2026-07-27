// GET /api/admin/credentials?course_id=<n>[&reissue=1]   (Access gated)
//
// The mail-merge source. Returns CSV: student, period, parent email, access
// code, and the syllabus link -- ready to paste into a mail merge from the
// teacher's own account. Nothing is emailed from here by design; that removes
// the only proprietary dependency the app would otherwise need.
//
// Codes are hashed at rest and therefore unrecoverable, so this endpoint is
// where the one and only plaintext appears. Accounts that already have a code
// are returned with an empty code column rather than a fresh one, so exporting
// twice does not silently invalidate codes already sitting in parents'
// inboxes. `reissue=1` overrides that for the "we lost the email" case.

import { unauthorized, serverMisconfigured, badRequest, requireAdmin, csvResponse, csvRow } from '../../_lib/http.js';
import { generateCode, hashCode } from '../../_lib/codes.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const url = new URL(request.url);
  const courseId = Number(url.searchParams.get('course_id'));
  if (!Number.isInteger(courseId) || courseId < 1) return badRequest('course_id is required.');
  const reissue = url.searchParams.get('reissue') === '1';

  const course = await env.DB.prepare('SELECT name FROM courses WHERE id = ?1').bind(courseId).first();
  if (!course) return badRequest('No such course.');

  // The roster address is authoritative; a student-supplied one overrides it
  // only when they bothered to enter one, which is the "not on file" case.
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.username, a.code_hash,
            COALESCE(a.parent_email, r.parent_email) AS email,
            CASE
              WHEN a.parent_email IS NOT NULL THEN 'student-supplied'
              WHEN r.parent_email IS NOT NULL THEN 'roster'
              ELSE 'missing'
            END AS email_source,
            r.first, r.last, r.period, r.student_ext_id
       FROM accounts a
       JOIN roster r ON r.id = a.roster_id
      WHERE r.course_id = ?1 AND r.status = 'active'
      ORDER BY r.period, r.last, r.first`,
  ).bind(courseId).all();

  const nowSec = Math.floor(Date.now() / 1000);
  const origin = url.origin;
  const link = `${origin}/sign`;

  const lines = [csvRow(['Student', 'Student ID', 'Period', 'Parent email', 'Email source', 'Access code', 'Link'])];

  for (const row of results ?? []) {
    let code = '';
    if (reissue || !row.code_hash) {
      code = generateCode();
      await env.DB.prepare('UPDATE accounts SET code_hash = ?1, code_issued_at = ?2 WHERE id = ?3')
        .bind(await hashCode(code), nowSec, row.id).run();
    }
    lines.push(csvRow([
      `${row.last}, ${row.first}`,
      row.student_ext_id,
      row.period ?? '',
      row.email ?? '',
      row.email_source,
      code,
      link,
    ]));
  }

  const slug = String(course.name).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return csvResponse(`credentials-${slug || courseId}.csv`, lines.join('\r\n') + '\r\n');
}
