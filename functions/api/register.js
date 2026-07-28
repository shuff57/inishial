// POST /api/register  -- student self-registration and re-entry (public,
// QR-code target)
//
// Body: { student_ext_id, last, username, parent_email }
//        username and parent_email are for first-time sign-up only; a returning
//        student sends just the ID and last name.
//
// `username` carries the student's SCHOOL EMAIL. It kept its name -- the column
// is `accounts.username` and is read by the credentials export and the admin
// tables -- because renaming it is a migration and six query sites for a word.
// Nothing signs in with it: /api/sign/login is student ID plus access code. It
// is an identifier the teacher can recognise on a roster, and it is UNIQUE, so
// two students cannot claim the same address.
//
// Gated on the student already existing in the teacher's uploaded roster, so
// only real students in real classes can create an account.
//
// No access code is issued here. Codes are minted by the teacher's credential
// export (see api/admin/credentials.js) -- students never handle one. Instead
// registration itself issues a student-role session, so the student can go
// straight from signing up to initialing their own copy. The parent's code is
// untouched by this: a student session can only ever write role='student'
// signature rows, so the two attestations stay independent on one account.
//
// ponytail: student ID + last name is the whole gate on a student session,
// which is the same gate registration already had -- claiming an account was
// always possible for someone holding both. Add a teacher-approval step if a
// class turns out to have students signing for each other.

import { json, badRequest, serverMisconfigured, readJson } from '../_lib/http.js';
import { hit, reset, clientIp } from '../_lib/ratelimit.js';
import { signSession, sessionCookie } from '../_lib/session.js';
import { generateCode, hashCode } from '../_lib/codes.js';

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

  // Username and email are validated further down, after the returning-student
  // check: someone coming back to finish tomorrow supplies neither.

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

  // A student who already registered gets a fresh session rather than a 409.
  // Sessions last two hours, so without this the student who comes back the
  // next day is locked out: they hold no access code (only the parent does)
  // and re-registering is refused.
  //
  // The rate limiter is deliberately NOT reset on this path. Resetting it after
  // a real registration is safe because that can only happen once per student;
  // resetting it here would let anyone holding one valid ID and last name clear
  // their own counter at will and enumerate the roster behind it.
  const existing = await env.DB.prepare('SELECT id, username, parent_email FROM accounts WHERE roster_id = ?1')
    .bind(rosterRow.id).first();
  if (existing) {
    const token = await signSession(env, Number(existing.id), 'student', nowSec);
    return json({
      ok: true,
      returning: true,
      username: existing.username,
      student: `${rosterRow.first} ${rosterRow.last}`,
      course: rosterRow.course,
      period: rosterRow.period,
      has_contact: !!(existing.parent_email || rosterRow.parent_email),
      next: '/sign/',
      message: 'Welcome back. Pick up where you left off — anything you already initialed is saved.',
    }, 200, { 'Set-Cookie': sessionCookie(token) });
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
  // resume. It is the student's half of the pair; the parent's is minted by the
  // teacher's export and is a different string.
  const studentCode = generateCode();

  let accountId;
  try {
    const insert = await env.DB.prepare(
      `INSERT INTO accounts (roster_id, username, parent_email, created_at,
                             student_code_hash, student_code_issued_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4)`,
    ).bind(rosterRow.id, username, parentEmail || null, nowSec, await hashCode(studentCode)).run();
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
  //   - the PARENT's access code, which is minted only by the teacher's export
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
