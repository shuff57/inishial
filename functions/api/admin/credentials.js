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

import { unauthorized, serverMisconfigured, badRequest, requireAdmin, ownedCourse, csvResponse, csvRow } from '../../_lib/http.js';
import { generateCode, hashCode } from '../../_lib/codes.js';

export async function onRequestGet({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const url = new URL(request.url);
  const courseId = Number(url.searchParams.get('course_id'));
  if (!Number.isInteger(courseId) || courseId < 1) return badRequest('course_id is required.');
  const reissue = url.searchParams.get('reissue') === '1';

  // Ownership matters more here than anywhere else in the app: this response is
  // parent email addresses and live access codes for every student in a class.
  const course = await ownedCourse(env, courseId, admin);
  if (!course) return badRequest('No such course.');

  // The roster address is authoritative; a student-supplied one overrides it
  // only when they bothered to enter one, which is the "not on file" case.
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.username, a.code_hash, a.student_code_hash,
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

  // Two codes per student now, in two columns. The parent's is the one to mail;
  // the student's exists so a teacher can hand it back to whoever shut the tab
  // before finishing. They are different strings on purpose -- that is what
  // keeps a student from signing their own parent's agreement.
  const lines = [csvRow([
    'Student', 'Student ID', 'Period', 'Parent email', 'Email source',
    'Parent access code', 'Student access code', 'Link',
  ])];

  for (const row of results ?? []) {
    // Same rule for both: an existing code is left alone and its column comes
    // back empty, so exporting twice does not invalidate what is already in an
    // inbox. reissue=1 replaces both.
    let parentCode = '';
    if (reissue || !row.code_hash) {
      parentCode = generateCode();
      await env.DB.prepare('UPDATE accounts SET code_hash = ?1, code_issued_at = ?2 WHERE id = ?3')
        .bind(await hashCode(parentCode), nowSec, row.id).run();
    }
    // A student who has not registered yet has no student code and gets none
    // here: the code is minted when they register, and issuing one now would
    // overwrite it a minute later. Accounts predating the two-code split have
    // no student code either, and this is where they get one.
    let studentCode = '';
    if (reissue || !row.student_code_hash) {
      studentCode = generateCode();
      await env.DB.prepare('UPDATE accounts SET student_code_hash = ?1, student_code_issued_at = ?2 WHERE id = ?3')
        .bind(await hashCode(studentCode), nowSec, row.id).run();
    }
    lines.push(csvRow([
      `${row.last}, ${row.first}`,
      row.student_ext_id,
      row.period ?? '',
      row.email ?? '',
      row.email_source,
      parentCode,
      studentCode,
      link,
    ]));
  }

  const slug = String(course.name).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return csvResponse(`credentials-${slug || courseId}.csv`, lines.join('\r\n') + '\r\n');
}
