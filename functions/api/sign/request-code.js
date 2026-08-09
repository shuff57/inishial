// POST /api/sign/request-code  -- parent asks for their access code by email
//
// Body: { school_id, student_ext_id, last, email }
//
// School, student ID and last name are IDENTIFICATION ONLY, exactly as on
// /register/: they find the roster row. What comes back by email -- a username
// and an access code -- is the whole credential, and /api/sign/login asks for
// those two and nothing else.
//
// The parent self-signup flow. The parent enters their student's ID and an
// email; this endpoint reads (or, for a legacy account, mints) the parent's
// access code and mails it. The page then switches to the access-code screen
// and the parent signs in the usual way.
//
// `email` is CHECKED here, never stored. It has to match the address already on
// file -- from the teacher's roster, or from what the student entered when they
// registered -- and anything else is refused. This endpoint cannot change where
// the mail goes, which is what stops a stranger holding a student ID from
// pointing a family's credentials at their own inbox.
//
// A parent whose address is wrong or missing goes through their teacher, who
// can set it from /admin/codes/. See the note further down for what the
// self-service version cost.
//
// The response carries a masked preview of the address (j***@example.com) so
// the parent can confirm which inbox to check, without leaking the full
// address to a stranger who only has the student ID.
//
// No oracle: a wrong student ID returns the same message the login endpoint
// uses, so this cannot confirm which IDs are on the roster.
//
// With student_identities, UNIQUE (school_id, student_ext_id) means there is
// exactly one identity per school per id -- no more ambiguous roster row
// concern. The lookup goes straight to the identity row.

import { json, badRequest, serverMisconfigured, readJson } from '../../_lib/http.js';
import { generateCode, hashCode } from '../../_lib/codes.js';
import { sealCode, openCode } from '../../_lib/vault.js';
import { hit, clientIp } from '../../_lib/ratelimit.js';
import { sendAccessCode } from '../../_lib/mail.js';
import { resolveSchoolScope, SCHOOL_SCOPE_JOIN } from '../../_lib/schoolScope.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Same message shape as /api/sign/login for a no-show student, so this endpoint
// cannot be used to confirm which student IDs exist.
const NO_STUDENT = "That student ID doesn't match our class roster. Check with your teacher.";

/** j***@example.com -- the parent can see which inbox to check, a stranger
 *  holding only the student ID cannot. */
function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!local || !domain) return '•••';
  const head = local[0] || '•';
  return `${head}${'•'.repeat(Math.min(local.length - 1, 3))}@${domain}`;
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  if (!body) return badRequest('Expected a JSON body.');

  const studentExtId = String(body.student_ext_id ?? '').trim();
  const last = String(body.last ?? '').trim();
  const email = String(body.email ?? '').trim();

  if (!studentExtId || !last) return badRequest('Enter the student ID and last name.');
  if (!email) return badRequest('Enter your email address.');
  if (!EMAIL_RE.test(email)) return badRequest('That doesn\'t look like an email address.');

  const scope = await resolveSchoolScope(env.DB, body.school_id);
  if (!scope.ok) return badRequest(scope.error);

  const nowSec = Math.floor(Date.now() / 1000);
  const ip = clientIp(request);

  // Three limits, because one number cannot serve both cases here.
  //
  // Per student (3/15min) is the tight one, and it is what protects a family:
  // enough for retries with a typo, not enough to flood one inbox.
  //
  // Per IP is DELIBERATELY VERY LOOSE, and it is sized for the worst honest
  // case rather than the typical one: ten teachers of forty told to request
  // their codes at the same moment is 400 requests in one window from a single
  // school address. Mobile carriers stack many parents behind one CGNAT
  // address too. 500 clears that with headroom.
  //
  // It can afford to be this loose because it is not the control that matters.
  // Flooding one family is bounded by the per-student limit below; handing a
  // code to a stranger is bounded by the redirect limit further down. What is
  // left for this cap is a runaway script burning sending reputation, and 500
  // in fifteen minutes is unmistakably that rather than a school event.
  //
  // If a bigger district ever needs more, this is one constant -- but raise it
  // knowingly: the per-student and redirect caps are what keep it safe to.
  for (const [key, max] of [
    [`reqcode:ip:${ip}`, 500],
    [`reqcode:stu:${studentExtId}`, 3],
  ]) {
    const limit = await hit(env.DB, key, nowSec, { max });
    if (!limit.allowed) {
      return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429, {
        'Retry-After': String(limit.retryAfter),
      });
    }
  }

  // Roster lookup, scoped by school and matched by last name.
  const { results: rosterRows = [] } = await env.DB.prepare(
    `SELECT r.id, r.first, r.last, r.parent_email AS roster_email
       FROM roster r
       JOIN courses c ON c.id = r.course_id
       ${SCHOOL_SCOPE_JOIN}
      WHERE r.student_ext_id = ?1 AND lower(r.last) = lower(?2)
        AND r.status = 'active'
        AND (?3 IS NULL OR sc.id = ?3)`,
  ).bind(studentExtId, last, scope.schoolIdFilter).all();

  if (rosterRows.length === 0) return badRequest(NO_STUDENT);
  const rosterRow = rosterRows[0];

  // Resolve the school_id for the identity lookup.
  const schoolIdRow = await env.DB.prepare(
    `SELECT COALESCE(t.school_id, 1) AS school_id
       FROM courses c
       LEFT JOIN teachers t ON t.id = c.owner_id
      WHERE c.id = (SELECT course_id FROM roster WHERE id = ?1)`,
  ).bind(rosterRow.id).first();
  const schoolId = schoolIdRow ? schoolIdRow.school_id : 1;

  // Same check register.js makes, for the same reason: at a one-school install
  // resolveSchoolScope filters nothing, so a wrong pick would otherwise sail
  // through ignored. Here it cannot corrupt anything -- the school is derived
  // from the roster either way -- but a parent who picked the wrong school
  // should be told, not quietly handed the right family's code. Roster-miss
  // message, so this cannot be asked which school a student ID belongs to.
  if (body.school_id && Number(body.school_id) !== schoolId) {
    return badRequest(NO_STUDENT);
  }

  const identity = await env.DB.prepare(
    `SELECT id, code_hash, code_enc, student_code_enc, parent_email, parent_username, username
       FROM student_identities
      WHERE school_id = ?1 AND student_ext_id = ?2`,
  ).bind(schoolId, studentExtId).first();

  if (!identity) {
    return badRequest('Your student needs to set up their account before you can request your code. Ask them to do that, or check back tomorrow.');
  }

  // The address must ALREADY be on file, from the roster the teacher uploaded
  // or from what the student entered when they registered. This endpoint only
  // ever reads it.
  //
  // It used to write: with nothing on file, the first request set the address
  // and locked it. Two things were wrong with that, and the second is the
  // serious one. A typo locked the family out permanently -- nothing in the
  // app could clear the override, not even the teacher re-uploading the roster
  // with the right address, because the override wins over the roster. And the
  // typo'd inbox was mailed a working parent code and the student's code on
  // the way in, so a plausible slip (`gmial.com`) handed signing credentials
  // to whoever owns that domain.
  //
  // Refusing instead means a family with no address on file has to go through
  // their teacher, who can now set one directly (PATCH /api/admin/credentials).
  // That is one extra step in an uncommon case, against silently mailing
  // credentials to an address nobody has ever verified.
  const onFile = identity.parent_email || rosterRow.roster_email;
  if (!onFile) {
    return badRequest('We do not have a contact address for this student yet. Ask their teacher to add yours, then try again.');
  }
  if (onFile.toLowerCase() !== email.toLowerCase()) {
    return badRequest("That email doesn't match the one on file for this student. Use the address the school has, or ask their teacher to update it.");
  }

  // Resolve the parent code: read it from the vault, or mint one if the
  // identity predates registration-minting (legacy account with no parent
  // code yet). Minting here is a fallback, not the normal path.
  // A code that exists but cannot be opened (sealed under a rotated secret, or
  // before the vault existed) is reissued rather than reported: the parent
  // needs something they can actually type, and nothing else holds the old one.
  let code = await openCode(env, identity.code_enc);
  if (!code) {
    code = generateCode();
    await env.DB.prepare(
      `UPDATE student_identities SET code_hash = ?1, code_enc = ?2, code_issued_at = ?3 WHERE id = ?4`,
    ).bind(await hashCode(code), await sealCode(env, code), nowSec, identity.id).run();
  }

  // The student's code rides along. A student who loses theirs cannot be mailed
  // one: district mail systems block external senders for student accounts, so
  // the school address is not a recovery path. Read-only -- unlike the parent
  // code above, a student code that cannot be opened is NOT reissued here.
  // Rotating it silently would invalidate a code the student may be holding,
  // and the teacher's export can reissue deliberately.
  const studentCode = await openCode(env, identity.student_code_enc);

  // Both usernames go too. Sign-in takes a username and a code, so a code on
  // its own is half a credential -- and the student's username is the half
  // they are most likely to have lost, since they saw it once on a screen.
  const studentName = `${rosterRow.first} ${rosterRow.last}`;
  const sent = await sendAccessCode(env, email, studentName, {
    parentCode: code,
    studentCode,
    parentUsername: identity.parent_username,
    studentUsername: identity.username,
  });

  if (!sent.ok) {
    // Honest failure: the parent would otherwise stare at "check your inbox"
    // for a mail that never went.
    return json({ error: 'Could not send the email right now. Try again in a moment, or ask your teacher to send your code directly.' }, 502);
  }

  // No reset on success. Unlike login, a successful send still consumed a
  // real inbox -- resetting here would let an attacker spam a family by
  // always succeeding. The window is 15 minutes; honest retries with a typo
  // fit in three.
  return json({ ok: true, email_preview: maskEmail(email), dry_run: sent.dryRun || false });
}
