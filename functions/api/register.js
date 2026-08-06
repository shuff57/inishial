// POST /api/register  -- student self-registration (public, QR-code target)
//
// Body: { student_ext_id, last, username, parent_email }
//
// FIRST-TIME SIGN-UP ONLY. Coming back is /api/sign/login's job, and always was
// -- that endpoint already takes a student's school email plus their own access
// code and hands back a student-role session (see sign/login.js). This endpoint
// used to accept the same two secrets under different field names, ask for a
// last name on top, and land the student on a "welcome back" card instead of
// the syllabus. It was a strictly worse duplicate of a working path, and the
// two spellings of "come back in" were most of what made this form hard to
// read: half its fields existed only for the returning case and had to be
// labelled "leave blank the first time".
//
// A student who already has an account now gets a 409 pointing at /sign/.
//

// `username` carries the student's SCHOOL EMAIL. It kept its name -- the column
// is `student_identities.username` and is read by the credentials export and the
// admin tables -- because renaming it is a migration and six query sites for a
// word. Nothing signs in with it: /api/sign/login is student ID plus access
// code. It is an identifier the teacher can recognise on a roster, and it is
// UNIQUE, so two students cannot claim the same address -- which is also why
// re-entry asks for it: student IDs are unique per course, not globally.
//
// Gated on the student already existing in the teacher's uploaded roster, so
// only real students in real classes can create an account.
//
// BOTH access codes are minted here. The student's own code is shown once on
// the next screen; the parent's is never shown to the student -- it is sealed
// in the vault so the parent self-signup page can mail it on demand (see
// api/sign/request-code.js). Minting the parent code at registration rather
// than at the teacher's credential export is what lets a parent get their code
// without the teacher being involved at all.
//
// Registration still issues a student-role session, so the student can go
// straight from signing up to initialing their own copy. A student session can
// only ever write role='student' signature rows, so the two attestations stay
// independent on one account.
//
// First-time sign-up is still gated on student ID + last name, neither of which
// is secret -- someone holding both can claim an account that has not been
// claimed yet. That window closes the moment the real student registers, after
// which this endpoint only ever says "you already have one, sign in". Add a
// teacher-approval step if first-claim turns out to be abused.
//
// Multi-class: a student enrolled in two of a teacher's classes at one school
// now registers once and gets accounts for BOTH roster rows, sharing one
// student_identities row. The old UNIQUE(username) on accounts blocked the
// second enrolment; moving it to student_identities (one per human) fixes that.

import { json, badRequest, serverMisconfigured, readJson } from '../_lib/http.js';
import { hit, reset, clientIp } from '../_lib/ratelimit.js';
import { signSession, sessionCookie } from '../_lib/session.js';
import { generateCode, hashCode } from '../_lib/codes.js';
import { sealCode } from '../_lib/vault.js';
import { resolveSchoolScope, SCHOOL_SCOPE_JOIN } from '../_lib/schoolScope.js';

// Deliberately permissive. Strict RFC-5322 validation rejects addresses that
// work; the real check is whether the mail arrives.
//
// Not restricted to the school's domain. Locking the field to one domain locks
// out every student the district put on a different one, and that failure is
// silent from here -- the student simply cannot register. The teacher sees the
// address in the credentials export either way. If every student really is on
// one domain, `domainAllowed` in _lib/teachers.js is the check to reuse.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');
  // Checked before the insert, not after: a thrown session mint would otherwise
  // leave the account created but the student staring at a 500.
  if (!env.SESSION_SECRET) return serverMisconfigured('SESSION_SECRET');

  const body = await readJson(request);
  if (!body) return badRequest('Expected a JSON body.');

  const studentExtId = String(body.student_ext_id ?? '').trim();
  const last = String(body.last ?? '').trim();
  const parentEmail = String(body.parent_email ?? '').trim();

  if (!studentExtId || !last) return badRequest('Enter your student ID and last name.');

  const nowSec = Math.floor(Date.now() / 1000);

  // Registration is public and takes a student ID, so it is an enumeration
  // target as much as a login is. Rate limit before touching the roster.
  const limit = await hit(env.DB, `reg:${clientIp(request)}`, nowSec, { max: 20 });
  if (!limit.allowed) {
    return json({ error: 'Too many attempts. Try again later.' }, 429, {
      'Retry-After': String(limit.retryAfter),
    });
  }

  const scope = await resolveSchoolScope(env.DB, body.school_id);
  if (!scope.ok) return badRequest(scope.error);

  // Scoped by school. A student_ext_id is unique per course, not per install,
  // so two schools sharing an install can genuinely reuse one. Within one
  // school, a student enrolled in two courses has two roster rows sharing one
  // student_ext_id -- that is the multi-class case this endpoint now handles
  // by fanning out accounts across all matching rows.
  const { results: rosterRows = [] } = await env.DB.prepare(
    `SELECT r.id, r.first, r.last, r.period, r.parent_email, c.name AS course, c.id AS course_id
       FROM roster r
       JOIN courses c ON c.id = r.course_id
       ${SCHOOL_SCOPE_JOIN}
      WHERE r.student_ext_id = ?1 AND lower(r.last) = lower(?2)
        AND r.status = 'active'
        AND (?3 IS NULL OR sc.id = ?3)`,
  ).bind(studentExtId, last, scope.schoolIdFilter).all();

  // Same message whether the ID is absent or the name doesn't match, so this
  // endpoint can't be used to confirm which student IDs exist.
  if (rosterRows.length === 0) {
    return badRequest("That student ID and last name don't match our class roster. Check with your teacher.");
  }

  // Find or create the student_identities row for (school_id, student_ext_id).
  // Resolve school_id through the first roster row's course -> teacher -> school,
  // falling back to the placeholder (id 1) for an unowned course.
  const primaryRow = rosterRows[0];
  const schoolId = await resolveIdentitySchool(env.DB, primaryRow.course_id);

  let identity = await env.DB.prepare(
    'SELECT id, username, code_hash FROM student_identities WHERE school_id = ?1 AND student_ext_id = ?2',
  ).bind(schoolId, studentExtId).first();

  if (identity) {
    // This student already registered for a different class earlier. Do NOT
    // ask for or overwrite username, and do NOT mint new codes -- this is
    // just adding more enrolments to an identity that already has its login
    // set up.
    //
    // Check whether EVERY matched roster row already has an account. If so,
    // this is the "already registered" 409.
    const existingCount = await countExistingAccounts(env.DB, rosterRows);
    if (existingCount === rosterRows.length) {
      return json({
        error: 'You already have an account. Sign in with your school email and your access code to read the syllabus.',
        registered: true,
        next: '/sign/',
      }, 409);
    }
  } else {
    // First-time registration: validate the parent email if supplied.
    if (parentEmail && !EMAIL_RE.test(parentEmail)) {
      return badRequest("That doesn't look like an email address. Leave it blank to use the one your school has on file.");
    }
  }

  // Auto-generate a username from the student ID. The student sees this on the
  // confirmation screen and enters it at sign-in alongside their access code.
  const username = `${studentExtId}@s`;

  // The student's own access code, minted here and shown once on the next
  // screen. Without it the only way back in is to register again, which works
  // but asks a fifteen-year-old to remember that re-entering a form is how you
  // resume. It is the student's half of the pair.
  //
  // The PARENT code is minted here too, now. It is NOT shown to the student
  // -- it is sealed in the vault (code_enc) so the parent self-signup page can
  // mail it later, and hashed (code_hash) so /api/sign/login verifies it. The
  // teacher's export reads the sealed copy back; it no longer mints.
  const studentCode = generateCode();
  const parentCode = generateCode();

  let identityId;
  try {
    if (identity) {
      identityId = identity.id;
    } else {
      const insert = await env.DB.prepare(
        `INSERT INTO student_identities (school_id, student_ext_id, username, parent_email, created_at,
                                         student_code_hash, student_code_issued_at, student_code_enc,
                                         code_hash, code_issued_at, code_enc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5, ?7, ?8, ?5, ?9)`,
      ).bind(schoolId, studentExtId, username, parentEmail || null, nowSec,
        await hashCode(studentCode), await sealCode(env, studentCode),
        await hashCode(parentCode), await sealCode(env, parentCode)).run();
      identityId = Number(insert.meta.last_row_id);
    }
  } catch (err) {
    // UNIQUE(username) is the only constraint a well-formed request can trip.
    if (String(err?.message || '').includes('UNIQUE')) {
      return json({ error: 'That school email is already registered to another student.' }, 409);
    }
    throw err;
  }

  // For EVERY matched roster row that does not already have an accounts row,
  // create one. A student enrolled in two courses gets two accounts sharing
  // one identity_id.
  let accountsCreated = 0;
  for (const row of rosterRows) {
    const existing = await env.DB.prepare(
      'SELECT id FROM accounts WHERE roster_id = ?1',
    ).bind(row.id).first();
    if (!existing) {
      await env.DB.prepare(
        'INSERT INTO accounts (roster_id, identity_id, created_at) VALUES (?1, ?2, ?3)',
      ).bind(row.id, identityId, nowSec).run();
      accountsCreated++;
    }
  }

  await reset(env.DB, `reg:${clientIp(request)}`);

  const hasContact = !!(parentEmail || primaryRow.parent_email);

  // Still deliberately absent from this response, and readable off a shared
  // Chromebook if it were not:
  //   - the parent's email address, in any form, masked or not
  //   - the PARENT's access code, which is minted here alongside the student's
  //     but sealed for the self-signup page to mail, never shown to the student
  //
  // The student's own code is here, and only here: it is hashed at rest like
  // every other code, so this response is the one and only time the plaintext
  // exists. A student who loses it asks their teacher to reissue.
  const token = await signSession(env, identityId, 'student', nowSec);

  const extraMsg = accountsCreated > 1
    ? ` You are enrolled in ${accountsCreated} classes; your syllabus covers all of them.`
    : '';

  return json({
    ok: true,
    username,
    student_code: identity ? null : studentCode,
    student: `${primaryRow.first} ${primaryRow.last}`,
    course: primaryRow.course,
    period: primaryRow.period,
    has_contact: hasContact,
    next: '/sign/',
    message: (hasContact
      ? 'You are registered. Read the syllabus and add your initials now. Your teacher will email your parent or guardian to do the same.'
      : 'You are registered. Read the syllabus and add your initials now, and tell your teacher we have no parent email on file for you.')
      + extraMsg,
  }, 201, { 'Set-Cookie': sessionCookie(token) });
}

/** Resolve the school_id for a course, falling back to the placeholder (id 1)
 *  when the course is unowned -- the same policy migration 0009 established. */
async function resolveIdentitySchool(db, courseId) {
  const row = await db.prepare(
    `SELECT COALESCE(t.school_id, 1) AS school_id
       FROM courses c
       LEFT JOIN teachers t ON t.id = c.owner_id
      WHERE c.id = ?1`,
  ).bind(courseId).first();
  return row ? row.school_id : 1;
}

/** Count how many of the given roster rows already have an accounts row. */
async function countExistingAccounts(db, rosterRows) {
  let count = 0;
  for (const row of rosterRows) {
    const existing = await db.prepare(
      'SELECT id FROM accounts WHERE roster_id = ?1',
    ).bind(row.id).first();
    if (existing) count++;
  }
  return count;
}
