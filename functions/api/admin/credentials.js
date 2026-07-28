// GET /api/admin/credentials?course_id=<n>[&reissue=1][&format=json]
//
// The access codes for one class. Two shapes, one set of rules:
//
//   CSV (default)   the mail-merge source -- paste into a merge from the
//                   teacher's own account. Nothing is emailed from here, which
//                   is what keeps the app free of a mail provider.
//   format=json     what /admin/codes/ renders as a table on screen.
//
// Both go through the same minting and the same ownership check, because two
// copies of "who may read this and when is a code replaced" is how the two
// drift until one of them is wrong.
//
// Codes are stored hashed (for sign-in) AND sealed under CODE_SECRET (so this
// endpoint can read them back). A row sealed before the vault existed, or under
// a since-rotated secret, comes back with the code null and `recoverable:
// false` -- the page offers to reissue rather than pretending it is blank.

import {
  unauthorized, serverMisconfigured, badRequest, requireAdmin, ownedCourse,
  csvResponse, csvRow, json,
} from '../../_lib/http.js';
import { generateCode, hashCode } from '../../_lib/codes.js';
import { sealCode, openCode, vaultReady } from '../../_lib/vault.js';

export async function onRequestGet({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const url = new URL(request.url);
  const courseId = Number(url.searchParams.get('course_id'));
  if (!Number.isInteger(courseId) || courseId < 1) return badRequest('course_id is required.');
  const reissue = url.searchParams.get('reissue') === '1';
  const wantsJson = url.searchParams.get('format') === 'json';
  // One student, by account id. The remedy for "this one leaked" that does not
  // involve invalidating every code in the class.
  const only = Number(url.searchParams.get('account_id')) || null;

  // Ownership matters more here than anywhere else in the app: this response is
  // parent email addresses and live access codes for every student in a class.
  const course = await ownedCourse(env, courseId, admin);
  if (!course) return badRequest('No such course.');

  // The roster address is authoritative; a student-supplied one overrides it
  // only when they bothered to enter one, which is the "not on file" case.
  // Driven from the ROSTER, not from accounts, so a student who has not
  // registered is a row saying so rather than a name missing from the page.
  // The join used to be the other way round and a class of three showed one
  // student, which reads as "the other two are gone" rather than "the other
  // two have not signed up". There is nothing to hand out for them yet -- the
  // codes live on the account -- and that is the thing worth seeing.
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.username, a.code_hash, a.student_code_hash,
            a.code_enc, a.student_code_enc,
            a.code_issued_at, a.student_code_issued_at,
            COALESCE(a.parent_email, r.parent_email) AS email,
            CASE
              WHEN a.parent_email IS NOT NULL THEN 'student-supplied'
              WHEN r.parent_email IS NOT NULL THEN 'roster'
              ELSE 'missing'
            END AS email_source,
            r.first, r.last, r.period, r.student_ext_id
       FROM roster r
       LEFT JOIN accounts a ON a.roster_id = r.id
      WHERE r.course_id = ?1 AND r.status = 'active'
      ORDER BY r.period, r.last, r.first`,
  ).bind(courseId).all();

  const nowSec = Math.floor(Date.now() / 1000);
  const link = `${url.origin}/sign`;

  /**
   * The current plaintext for one code, minting a new one when there is none
   * or when a reissue was asked for.
   *
   * Reissue writes the hash and the ciphertext together. If they ever came
   * apart the page would show one code while sign-in accepted another, and
   * the teacher would be reading a wrong answer off a screen with no way to
   * tell -- so both columns move in the same statement or neither does.
   */
  const settle = async (row, kind) => {
    // No account: there is nowhere to put a code. Minting one would need a row
    // that registration is going to create anyway, and creating it here would
    // mark a student as registered when they have never opened the app.
    if (row.id == null) return { code: null, issued_at: null, fresh: false, recoverable: false, no_account: true };

    const hashCol = kind === 'parent' ? 'code_hash' : 'student_code_hash';
    const encCol = kind === 'parent' ? 'code_enc' : 'student_code_enc';
    const atCol = kind === 'parent' ? 'code_issued_at' : 'student_code_issued_at';
    const mine = only == null || only === row.id;

    if (mine && (reissue || !row[hashCol])) {
      const code = generateCode();
      await env.DB.prepare(
        `UPDATE accounts SET ${hashCol} = ?1, ${encCol} = ?2, ${atCol} = ?3 WHERE id = ?4`,
      ).bind(await hashCode(code), await sealCode(env, code), nowSec, row.id).run();
      return { code, issued_at: nowSec, fresh: true, recoverable: true };
    }
    if (!row[hashCol]) return { code: null, issued_at: null, fresh: false, recoverable: false };

    const code = await openCode(env, row[encCol]);
    return { code, issued_at: row[atCol], fresh: false, recoverable: code !== null };
  };

  const students = [];
  for (const row of results ?? []) {
    students.push({
      account_id: row.id,
      student: `${row.last}, ${row.first}`,
      student_ext_id: row.student_ext_id,
      period: row.period ?? '',
      email: row.email ?? '',
      email_source: row.email_source,
      school_email: row.username,
      parent: await settle(row, 'parent'),
      student_code: await settle(row, 'student'),
    });
  }

  if (wantsJson) {
    return json({
      course: course.name,
      link,
      // The page needs to distinguish "no code yet" from "cannot be shown", and
      // the second is a deployment problem rather than a per-student one.
      vault: vaultReady(env),
      students,
    });
  }

  const lines = [csvRow([
    'Student', 'Student ID', 'Period', 'Parent email', 'Email source',
    'Parent access code', 'Student access code', 'Link',
  ])];
  for (const s of students) {
    lines.push(csvRow([
      s.student, s.student_ext_id, s.period, s.email, s.email_source,
      s.parent.code ?? '', s.student_code.code ?? '', link,
    ]));
  }

  const slug = String(course.name).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return csvResponse(`access-codes-${slug || courseId}.csv`, lines.join('\r\n') + '\r\n');
}
