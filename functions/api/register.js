// POST /api/register  -- student self-registration (public, QR-code target)
//
// Body: { school_id, student_ext_id, last, parent_email }
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

// School, last name and student ID are IDENTIFICATION ONLY. They exist to find
// the right roster row and to prove the person filling this in is on it. None
// of them is asked for again: this endpoint's output -- a username and an
// access code -- is the entire credential from here on, and /api/sign/login
// takes those two and nothing else.
//
// Both usernames are derived, not chosen, so a student never invents one and a
// teacher can reconstruct either from the roster:
//
//   student   <student_ext_id>@s<school_id>
//   parent    <student_ext_id>@p<school_id>
//
// The school id is in there because a student_ext_id is unique per COURSE, not
// per install, while `student_identities.username` is globally UNIQUE. Without
// it, the second school on this install to have a student with a given ID
// number could not register at all -- see migrations/0013.
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
import { sealCode, open, blindIndex } from '../_lib/vault.js';
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
  // Matched on a DIGEST of the surname, not the surname: since migration 0017
  // the roster stores `last_idx` (keyed HMAC, for this) and `last_enc` (sealed,
  // for display), and no plaintext column to compare against. Equality on the
  // digest is exactly the old case-insensitive match -- blindIndex lowercases
  // and trims on both sides -- so the behaviour here is unchanged.
  //
  // Null when CODE_SECRET is missing. Registration then matches nothing, which
  // is the right failure: the import path refuses to write rows it could not
  // seal, so a live install cannot reach this state without the secret being
  // pulled out from under existing data.
  const lastIdx = await blindIndex(env, last, studentExtId);
  const { results: rosterRows = [] } = await env.DB.prepare(
    `SELECT r.id, r.last_enc, r.period, r.parent_email, c.name AS course, c.id AS course_id
       FROM roster r
       JOIN courses c ON c.id = r.course_id
       ${SCHOOL_SCOPE_JOIN}
      WHERE r.student_ext_id = ?1 AND r.last_idx = ?2
        AND r.status = 'active'
        AND (?3 IS NULL OR sc.id = ?3)`,
  ).bind(studentExtId, lastIdx, scope.schoolIdFilter).all();

  // Same message whether the ID is absent or the name doesn't match, so this
  // endpoint can't be used to confirm which student IDs exist.
  if (rosterRows.length === 0) {
    return badRequest("That student ID and last name don't match our class roster. Check with your teacher.");
  }

  // Find or create the student_identities row for (school_id, student_ext_id).
  //
  // The school comes from the ROSTER ROW, never from the form. The submitted
  // value is checked against it and then discarded.
  //
  // It used to be the other way round -- the submitted id won, falling back to
  // the roster only when the form left it out -- and that is a split-brain
  // waiting to happen, because resolveSchoolScope is a NO-OP at a one-school
  // install: nothing filtered the roster by school, so a student who picked
  // the wrong entry registered successfully against the right roster row while
  // their identity was written under the wrong school. Username `<id>@s52` for
  // a student whose class lives at school 1. The parent side then derives the
  // school from the roster (see sign/request-code.js), looks up school 1, finds
  // nothing, and tells the family their student never registered.
  //
  // Rejected with the roster-miss message rather than one of its own, so this
  // cannot be used to ask which school a given student ID belongs to.
  const primaryRow = rosterRows[0];
  const schoolId = await resolveIdentitySchool(env.DB, primaryRow.course_id);
  if (body.school_id && Number(body.school_id) !== schoolId) {
    return badRequest("That student ID and last name don't match our class roster. Check with your teacher.");
  }

  let identity = await env.DB.prepare(
    'SELECT id, username, code_hash, student_session_gen FROM student_identities WHERE school_id = ?1 AND student_ext_id = ?2',
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
        error: 'You already have an account. Sign in with the username and access code you were given to read the syllabus.',
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

  // Derived from (student id, school), which is exactly the pair
  // UNIQUE (school_id, student_ext_id) already guarantees is unique -- so the
  // globally UNIQUE username column can never collide across schools. Lowercase
  // so the string on screen is the string they type back; sign-in lowercases
  // both sides regardless.
  const idPart = studentExtId.toLowerCase();
  const username = identity ? identity.username : `${idPart}@s${schoolId}`;
  const parentUsername = `${idPart}@p${schoolId}`;

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
        `INSERT INTO student_identities (school_id, student_ext_id, username, parent_username, parent_email, created_at,
                                         student_code_hash, student_code_issued_at, student_code_enc,
                                         code_hash, code_issued_at, code_enc)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?8, ?9, ?6, ?10)`,
      ).bind(schoolId, studentExtId, username, parentUsername, parentEmail || null, nowSec,
        await hashCode(studentCode), await sealCode(env, studentCode),
        await hashCode(parentCode), await sealCode(env, parentCode)).run();
      identityId = Number(insert.meta.last_row_id);
    }
  } catch (err) {
    // UNIQUE(username) is the only constraint a well-formed request can trip,
    // and since migrations/0013 scoped the username by school it should no
    // longer be reachable at all: the pair it is derived from is already
    // guaranteed unique. Kept as a real error rather than deleted, because
    // "should be unreachable" is not the same as "is".
    if (String(err?.message || '').includes('UNIQUE')) {
      return json({ error: 'That student is already registered. Sign in instead.' }, 409);
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

  // Whether the school has any way to reach a parent. Shapes the message and
  // nothing else -- it used to ride along in the response as `has_contact` too,
  // where it said the same thing in a second format that no client ever read.
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
  // A new identity starts at generation 0. A returning one -- a student being
  // added to a second class -- keeps whatever generation it is on, so getting
  // set up for another course does not sign them out of the session they are
  // already using on another device.
  const token = await signSession(env, identityId, 'student', nowSec, {
    gen: identity ? identity.student_session_gen : 0,
  });

  const extraMsg = accountsCreated > 1
    ? ` You are enrolled in ${accountsCreated} classes; your syllabus covers all of them.`
    : '';

  // An identity that already existed is a student being added to a SECOND
  // class, not a new sign-up: their code was minted and shown the first time
  // and is not re-shown here, because it is hashed and this endpoint no longer
  // holds the plaintext. Saying so is the point -- the confirmation card used
  // to print the word "null" under "write this down" and offer no clue that the
  // code they already have is the one that still works.
  const returning = !!identity;

  return json({
    ok: true,
    username,
    student_code: returning ? null : studentCode,
    // Surname only -- given names are not stored any more (migration 0017).
    // Decrypted rather than echoing what was typed, so the card shows the
    // roster's capitalisation; falls back to their own spelling if it will not
    // open, which is better than a blank where a name should be.
    student: (await open(env, primaryRow.last_enc)) || last,
    course: primaryRow.course,
    period: primaryRow.period,
    next: '/sign/',
    message: (returning
      ? 'You are set up for this class too. Keep using the username and access code you already have.'
      : hasContact
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
