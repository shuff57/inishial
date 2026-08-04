// POST /api/sign/request-code  -- parent asks for their access code by email
//
// Body: { student_ext_id, email }
//
// The parent self-signup flow. The parent enters their student's ID and an
// email; this endpoint reads (or, for a legacy account, mints) the parent's
// access code and mails it. The page then switches to the access-code screen
// and the parent signs in the usual way.
//
// `email` is pre-filled from the roster on the page but is editable here: a
// parent who spots a roster typo can correct it, and the corrected address is
// stored as the accounts.parent_email override (the same field registration
// uses). A stranger holding the student ID can re-point the mail to their own
// inbox -- that is the cost of letting parents fix typos without the teacher.
// The code itself is still rate-limited at /api/sign/login (31^8 keyspace,
// 5/15min), so redirecting the email does not alone hand over a signature.
//
// The response carries a masked preview of the address (j***@example.com) so
// the parent can confirm which inbox to check, without leaking the full
// address to a stranger who only has the student ID.
//
// No oracle: a wrong student ID returns the same message the login endpoint
// uses, so this cannot confirm which IDs are on the roster.

import { json, badRequest, serverMisconfigured, readJson } from '../../_lib/http.js';
import { generateCode, hashCode } from '../../_lib/codes.js';
import { sealCode, openCode } from '../../_lib/vault.js';
import { hit, clientIp } from '../../_lib/ratelimit.js';
import { sendAccessCode } from '../../_lib/mail.js';

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
  const email = String(body.email ?? '').trim();

  if (!studentExtId || !email) return badRequest('Enter the student ID and your email address.');
  if (!EMAIL_RE.test(email)) return badRequest('That doesn\'t look like an email address.');

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

  // Roster first, so a no-show student fails before any account lookup. Same
  // join shape as login.
  const rosterRow = await env.DB.prepare(
    `SELECT r.id, r.first, r.last, r.parent_email AS roster_email
       FROM roster r
      WHERE r.student_ext_id = ?1 AND r.status = 'active'
      LIMIT 1`,
  ).bind(studentExtId).first();

  if (!rosterRow) return badRequest(NO_STUDENT);

  const account = await env.DB.prepare(
    `SELECT id, code_hash, code_enc, student_code_enc, parent_email
       FROM accounts WHERE roster_id = ?1 LIMIT 1`,
  ).bind(rosterRow.id).first();

  if (!account) {
    // The parent code is minted at registration now. No account means the
    // student has not registered yet, which means there is no code to mail.
    // Tell the parent plainly: the student must register first.
    return badRequest('Your student needs to set up their account before you can request your code. Ask them to do that, or check back tomorrow.');
  }

  // Effective email on file, before any override this request might write.
  const effectiveOnFile = account.parent_email || rosterRow.roster_email;
  const emailLower = email.toLowerCase();
  const differsFromOnFile = !effectiveOnFile || effectiveOnFile.toLowerCase() !== emailLower;

  // If the supplied email differs from BOTH the roster and any existing
  // override, write it as the override. This is the "parent fixes a roster
  // typo" path. If it matches what's on file, no write -- a no-op that keeps
  // the override column null when the roster is correct.
  if (differsFromOnFile) {
    // The loose per-IP cap above cannot be the only guard, because THIS is the
    // path that actually hands a code to a new address. Redirecting requires
    // knowing a student ID, and IDs may well be guessable, so one source
    // walking a list of them is the real attack -- not volume as such.
    //
    // Splitting the limit this way is what lets the general cap stay generous:
    // a hall full of parents using their own address on file is untouched,
    // while anyone redirecting codes to somewhere new is held to 5 per 15
    // minutes from one address. Honest typo-fixing is one request, rarely two.
    const redirect = await hit(env.DB, `reqcode:redirect:${ip}`, nowSec, { max: 5 });
    if (!redirect.allowed) {
      return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429, {
        'Retry-After': String(redirect.retryAfter),
      });
    }
    await env.DB.prepare('UPDATE accounts SET parent_email = ?1 WHERE id = ?2')
      .bind(email, account.id).run();
  }

  // Resolve the parent code: read it from the vault, or mint one if the
  // account predates registration-minting (legacy account with no parent
  // code yet). Minting here is a fallback, not the normal path.
  let code = await openCode(env, account.code_enc);
  if (!code) {
    if (account.code_hash) {
      // A code exists but the vault can't read it (sealed under a rotated
      // secret, or before the vault existed). Reissue: mint a new one, so
      // the parent gets something they can actually type.
    }
    code = generateCode();
    await env.DB.prepare(
      `UPDATE accounts SET code_hash = ?1, code_enc = ?2, code_issued_at = ?3 WHERE id = ?4`,
    ).bind(await hashCode(code), await sealCode(env, code), nowSec, account.id).run();
  }

  // The student's code rides along. A student who loses theirs cannot be mailed
  // one: district mail systems block external senders for student accounts, so
  // the school address is not a recovery path. Read-only -- unlike the parent
  // code above, a student code that cannot be opened is NOT reissued here.
  // Rotating it silently would invalidate a code the student may be holding,
  // and the teacher's export can reissue deliberately.
  const studentCode = await openCode(env, account.student_code_enc);

  const studentName = `${rosterRow.first} ${rosterRow.last}`;
  const sent = await sendAccessCode(env, email, studentName, code, studentCode);

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