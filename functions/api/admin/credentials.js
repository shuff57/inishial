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
import { sealCode, openCode, open, vaultReady } from '../../_lib/vault.js';

// Same deliberately-permissive shape as registration uses. Strict RFC-5322
// validation rejects addresses that work; the real check is whether the mail
// arrives.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
    `SELECT a.id, si.username, si.parent_username, si.code_hash, si.student_code_hash,
            si.code_enc, si.student_code_enc,
            si.code_issued_at, si.student_code_issued_at,
            COALESCE(si.parent_email, r.parent_email) AS email,
            CASE
              WHEN si.parent_email IS NOT NULL THEN 'student-supplied'
              WHEN r.parent_email IS NOT NULL THEN 'roster'
              ELSE 'missing'
            END AS email_source,
            r.last_enc, r.period, r.student_ext_id
       FROM roster r
       LEFT JOIN accounts a ON a.roster_id = r.id
       LEFT JOIN student_identities si ON si.id = a.identity_id
      WHERE r.course_id = ?1 AND r.status = 'active'
      -- Alphabetical by surname is what a teacher wants and SQL can no longer
      -- do it: the name is ciphertext, which sorts by its random IV. Ordered
      -- by ID here to keep the result stable, then re-sorted below once the
      -- names are open. Fine at roster scale, which is tens of rows.
      ORDER BY r.period, r.student_ext_id`,
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
        `UPDATE student_identities SET ${hashCol} = ?1, ${encCol} = ?2, ${atCol} = ?3 WHERE id = ?4`,
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
      // Surname only since migration 0017. A row whose name will not open is
      // still listed -- the teacher needs the codes either way -- with the ID
      // standing in for the name rather than an empty cell.
      student: (await open(env, row.last_enc)) || `(ID ${row.student_ext_id})`,
      student_ext_id: row.student_ext_id,
      period: row.period ?? '',
      email: row.email ?? '',
      email_source: row.email_source,
      // Both usernames, because sign-in is username + code and a code alone is
      // half a credential. The student sees theirs once at registration and the
      // parent gets theirs by email; when either is lost this export is the
      // only place left that holds it, and it used to hold neither -- the
      // student's was in the JSON under a name the page never rendered, and the
      // parent's was nowhere at all.
      username: row.username,
      parent_username: row.parent_username,
      parent: await settle(row, 'parent'),
      student_code: await settle(row, 'student'),
    });
  }

  // The alphabetical order SQL gave up when the surname became ciphertext.
  // Period first, so a teacher reading down a printed sheet still sees their
  // classes in blocks rather than one interleaved list.
  students.sort((a, b) =>
    String(a.period).localeCompare(String(b.period))
    || a.student.localeCompare(b.student));

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

  // Username beside its own code in both pairs, since that is how they are
  // typed and how they are mail-merged.
  const lines = [csvRow([
    'Student', 'Student ID', 'Period', 'Parent email', 'Email source',
    'Parent username', 'Parent access code',
    'Student username', 'Student access code', 'Link',
  ])];
  for (const s of students) {
    lines.push(csvRow([
      s.student, s.student_ext_id, s.period, s.email, s.email_source,
      s.parent_username ?? '', s.parent.code ?? '',
      s.username ?? '', s.student_code.code ?? '', link,
    ]));
  }

  const slug = String(course.name).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return csvResponse(`access-codes-${slug || courseId}.csv`, lines.join('\r\n') + '\r\n');
}

/**
 * PATCH /api/admin/credentials -- set or clear one student's parent email.
 *
 * Body: { account_id, parent_email }  -- an empty or null address clears it.
 *
 * The teacher's fix for a contact address that is wrong, missing, or was
 * locked to a typo. Until this existed there was no way to change
 * `student_identities.parent_email` from anywhere in the app: the parent
 * self-signup page set it once, on first request, and then refused every
 * address that did not match -- so a mistyped address permanently locked the
 * family out, and re-uploading the roster did not help, because the override
 * wins over the roster.
 *
 * CLEARING is the important half and is why this takes a null rather than only
 * a new address. With the override gone the roster address applies again,
 * which is the state the account should have been in all along.
 *
 * Lives on this route because it is the same subject as the codes beside it,
 * the same ownership boundary, and the same page. A teacher who can already
 * read a class's access codes is not gaining reach by editing a contact
 * address in the same table.
 */
export async function onRequestPatch({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  let body;
  try { body = await request.json(); } catch { return badRequest('Expected a JSON body.'); }

  const accountId = Number(body?.account_id);
  if (!Number.isInteger(accountId) || accountId < 1) return badRequest('account_id is required.');

  const raw = String(body?.parent_email ?? '').trim();
  if (raw && !EMAIL_RE.test(raw)) return badRequest("That doesn't look like an email address.");

  // Ownership is checked through the account's own course, not a course id the
  // caller supplies -- otherwise a teacher could name their own course while
  // pointing at somebody else's student.
  const row = await env.DB.prepare(
    `SELECT a.identity_id, r.course_id, r.last_enc
       FROM accounts a
       JOIN roster r ON r.id = a.roster_id
      WHERE a.id = ?1`,
  ).bind(accountId).first();
  // Same answer for "no such account" and "not yours", exactly as ownedCourse
  // does, so this cannot be used to probe which account ids exist.
  if (!row || !(await ownedCourse(env, row.course_id, admin))) return badRequest('No such student.');

  await env.DB.prepare(
    'UPDATE student_identities SET parent_email = ?1 WHERE id = ?2',
  ).bind(raw || null, row.identity_id).run();

  // What the page should now show: the override if one was set, otherwise
  // whatever the roster carries, which is what the parent flow will use.
  const after = await env.DB.prepare(
    `SELECT COALESCE(si.parent_email, r.parent_email) AS email,
            CASE
              WHEN si.parent_email IS NOT NULL THEN 'student-supplied'
              WHEN r.parent_email  IS NOT NULL THEN 'roster'
              ELSE 'missing'
            END AS email_source
       FROM accounts a
       JOIN roster r ON r.id = a.roster_id
       JOIN student_identities si ON si.id = a.identity_id
      WHERE a.id = ?1`,
  ).bind(accountId).first();

  return json({
    ok: true,
    student: (await open(env, row.last_enc)) || '',
    email: after?.email ?? '',
    email_source: after?.email_source ?? 'missing',
  });
}
