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
// is `accounts.username` and is read by the credentials export and the admin
// tables -- because renaming it is a migration and six query sites for a word.
// Nothing signs in with it: /api/sign/login is student ID plus access code. It
// is an identifier the teacher can recognise on a roster, and it is UNIQUE, so
// two students cannot claim the same address -- which is also why re-entry
// asks for it: student IDs are unique per course, not globally.
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

import { json, badRequest, serverMisconfigured, readJson } from '../_lib/http.js';
import { hit, reset, clientIp } from '../_lib/ratelimit.js';
import { signSession, sessionCookie } from '../_lib/session.js';
import { generateCode, hashCode } from '../_lib/codes.js';
import { sealCode } from '../_lib/vault.js';

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
  // Lowercased: an address is case-insensitive, and without this Sam@ and sam@
  // are two accounts as far as UNIQUE is concerned.
  const username = String(body.username ?? '').trim().toLowerCase();
  const parentEmail = String(body.parent_email ?? '').trim();

  if (!studentExtId || !last) return badRequest('Enter your student ID and last name.');

  // Username and email are validated further down, after the roster lookup and
  // the already-registered check: neither is worth checking for a student who
  // is not on the roster or who is being sent to /sign/ anyway.

  const nowSec = Math.floor(Date.now() / 1000);

  // Registration is public and takes a student ID, so it is an enumeration
  // target as much as a login is. Rate limit before touching the roster.
  const limit = await hit(env.DB, `reg:${clientIp(request)}`, nowSec, { max: 20 });
  if (!limit.allowed) {
    return json({ error: 'Too many attempts. Try again later.' }, 429, {
      'Retry-After': String(limit.retryAfter),
    });
  }

  const rosterRow = await env.DB.prepare(
    `SELECT r.id, r.first, r.last, r.period, r.parent_email, c.name AS course
       FROM roster r JOIN courses c ON c.id = r.course_id
      WHERE r.student_ext_id = ?1 AND lower(r.last) = lower(?2)
        AND r.status = 'active'
      LIMIT 1`,
  ).bind(studentExtId, last).first();

  // Same message whether the ID is absent or the name doesn't match, so this
  // endpoint can't be used to confirm which student IDs exist.
  if (!rosterRow) {
    return badRequest("That student ID and last name don't match our class roster. Check with your teacher.");
  }

  // Already registered. Point at /sign/ rather than re-authenticating here:
  // signing in is that endpoint's job, and it wants the same school email and
  // student code this one would have asked for.
  //
  // 409 rather than 400 because nothing the student typed is wrong. The client
  // renders it as a card with a button, not as a red validation error.
  //
  // No new disclosure: this confirms an account exists from an ID and a last
  // name, neither secret -- but the alternative branch below CREATES an account
  // from exactly those two, so whether one already exists was always observable
  // from which of the two answers came back.
  //
  // The rate limiter is deliberately NOT reset here. Resetting it after a real
  // registration is safe because that can only happen once per student;
  // resetting it here would let anyone holding one valid ID and last name clear
  // their own counter at will and enumerate the roster behind it.
  const existing = await env.DB.prepare(
    'SELECT id FROM accounts WHERE roster_id = ?1',
  ).bind(rosterRow.id).first();
  if (existing) {
    return json({
      error: 'You already have an account. Sign in with your school email and your access code to read the syllabus.',
      registered: true,
      next: '/sign/',
    }, 409);
  }

  if (!EMAIL_RE.test(username)) {
    return badRequest('Enter your school email address.');
  }
  // Optional: the roster export already carries a contact address for most
  // families. This is the escape hatch for the ones where it is missing or
  // wrong, so it is validated when given and ignored when not.
  if (parentEmail && !EMAIL_RE.test(parentEmail)) {
    return badRequest("That doesn't look like an email address. Leave it blank to use the one your school has on file.");
  }

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

  let accountId;
  try {
    const insert = await env.DB.prepare(
      `INSERT INTO accounts (roster_id, username, parent_email, created_at,
                             student_code_hash, student_code_issued_at, student_code_enc,
                             code_hash, code_issued_at, code_enc)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?6, ?7, ?4, ?8)`,
    ).bind(rosterRow.id, username, parentEmail || null, nowSec,
      // Hash to verify against, ciphertext so the teacher/self-signup page can
      // read it back to a student/parent who shut the tab. Both, or neither is
      // any use. sealCode returns null with no CODE_SECRET set, and the page
      // says so.
      await hashCode(studentCode), await sealCode(env, studentCode),
      await hashCode(parentCode), await sealCode(env, parentCode)).run();
    accountId = Number(insert.meta.last_row_id);
  } catch (err) {
    // UNIQUE(username) is the only constraint a well-formed request can trip.
    if (String(err?.message || '').includes('UNIQUE')) {
      return json({ error: 'That school email is already registered to another student.' }, 409);
    }
    throw err;
  }

  await reset(env.DB, `reg:${clientIp(request)}`);

  const hasContact = !!(parentEmail || rosterRow.parent_email);

  // Still deliberately absent from this response, and readable off a shared
  // Chromebook if it were not:
  //   - the parent's email address, in any form, masked or not
  //   - the PARENT's access code, which is minted here alongside the student's
  //     but sealed for the self-signup page to mail, never shown to the student
  //
  // The student's own code is here, and only here: it is hashed at rest like
  // every other code, so this response is the one and only time the plaintext
  // exists. A student who loses it asks their teacher to reissue.
  const token = await signSession(env, accountId, 'student', nowSec);

  return json({
    ok: true,
    username,
    student_code: studentCode,
    student: `${rosterRow.first} ${rosterRow.last}`,
    course: rosterRow.course,
    period: rosterRow.period,
    has_contact: hasContact,
    next: '/sign/',
    message: hasContact
      ? 'You are registered. Read the syllabus and add your initials now. Your teacher will email your parent or guardian to do the same.'
      : 'You are registered. Read the syllabus and add your initials now, and tell your teacher we have no parent email on file for you.',
  }, 201, { 'Set-Cookie': sessionCookie(token) });
}
