// POST   /api/sign/login  -- parent or student enters their username and code
// DELETE /api/sign/login  -- sign out
//
// Body: { username, code }
//
// Two fields, and they are the two the app itself issued. School, student ID
// and last name are asked for ONCE, at /register/ or /register/code/, where
// they identify a roster row and mint these credentials; they are not a second
// login form and are not asked for again. A student ID is not a secret, and
// re-asking for it at sign-in bought nothing -- the student's username is
// derived from it (see api/register.js), so the field above the username was
// the answer to the field below it.
//
// There is no `role` field either. The account carries two codes -- one the
// parent was mailed, one the student was shown when they registered -- and the
// USERNAME says which of the two is being offered. A field asking the visitor
// to declare it was the same thing as letting them choose.
//
// The syllabus URL is public and shared, so the access code is the only thing
// standing between a stranger and signing as someone's parent. Everything
// defensive in this file exists for that reason.
//
// No school scoping here, unlike register.js and request-code.js: since
// migrations/0013 the school id is part of the username, so a username already
// names exactly one identity across the whole install.

import { json, badRequest, serverMisconfigured, readJson } from '../../_lib/http.js';
import { verifyCode, normalize } from '../../_lib/codes.js';
import { open } from '../../_lib/vault.js';
import { hit, reset, clientIp } from '../../_lib/ratelimit.js';
import {
  signSession, sessionCookie, clearCookie, currentSession, revokeSigner, SIGNER_ROLES,
} from '../../_lib/session.js';

// One message for every failure mode. Distinguishing "no such username" from
// "wrong code" would turn this endpoint into an account oracle.
const REJECT = 'That username and access code do not match. Check the email from your teacher, or the code you were shown when you set up your account.';

// A real PBKDF2 hash of a value nothing can submit, so a username that does not
// exist costs the same 100k iterations as one that does.
const DECOY = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');
  if (!env.SESSION_SECRET) return serverMisconfigured('SESSION_SECRET');

  const body = await readJson(request);
  if (!body) return badRequest('Expected a JSON body.');

  const username = String(body.username ?? '').trim().toLowerCase();
  const code = normalize(body.code);
  if (!username || !code) return badRequest('Enter your username and access code.');

  const nowSec = Math.floor(Date.now() / 1000);
  const ip = clientIp(request);

  // Two independent buckets. Per-IP stops one attacker walking many accounts;
  // per-username stops a distributed attempt concentrating on one. Counted
  // before verification, so failures and successes both cost quota.
  for (const key of [`login:ip:${ip}`, `login:user:${username}`]) {
    const limit = await hit(env.DB, key, nowSec);
    if (!limit.allowed) {
      return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429, {
        'Retry-After': String(limit.retryAfter),
      });
    }
  }

  // Matched against BOTH username columns in one query, because which one hits
  // is what decides the role. An identity has at most one row here; the join to
  // roster is for the student's name in the response, and GROUP BY collapses a
  // student enrolled in two of a teacher's classes back to one candidate.
  const { results: rows = [] } = await env.DB.prepare(
    `SELECT si.id, si.code_hash, si.student_code_hash, si.username, si.parent_username,
            si.parent_session_gen, si.student_session_gen,
            r.last_enc
       FROM student_identities si
       JOIN accounts a ON a.identity_id = si.id
       JOIN roster   r ON r.id = a.roster_id
      WHERE (lower(si.username) = ?1 OR lower(si.parent_username) = ?1)
        AND r.status = 'active'
      GROUP BY si.id`,
  ).bind(username).all();

  // A username nobody holds must cost what a real one costs. Without this the
  // response time answers "is this an account?" before any code is checked,
  // which is the one question the single REJECT message exists to refuse.
  if (rows.length === 0) {
    await verifyCode(code, DECOY);
    return json({ error: REJECT }, 401);
  }

  // The username already picked the side, so exactly one hash is in play and
  // every candidate costs exactly one verification. No short-circuit: stopping
  // early would make one candidate measurably cheaper than two.
  let row = null;
  let role = null;
  for (const cand of rows) {
    const isStudent = String(cand.username ?? '').toLowerCase() === username;
    const wanted = isStudent ? cand.student_code_hash : cand.code_hash;
    const ok = await verifyCode(code, wanted || DECOY) && !!wanted;
    if (!row && ok) { row = cand; role = isStudent ? 'student' : 'parent'; }
  }
  if (!row) return json({ error: REJECT }, 401);

  await reset(env.DB, `login:ip:${ip}`);
  await reset(env.DB, `login:user:${username}`);

  // The generation this side is currently on, so a later sign-out can tell
  // this token apart from the ones it is ending. Read from the row already
  // fetched above rather than a second query.
  const gen = role === 'student' ? row.student_session_gen : row.parent_session_gen;

  const token = await signSession(env, row.id, role, nowSec, { gen });
  return json(
    // Surname only, and null rather than a blank if it will not open: the
    // caller renders a greeting, and "Welcome, " with nothing after it reads as
    // a bug where a missing name should simply not be greeted.
    { ok: true, role, student: (await open(env, row.last_enc)) || null },
    200,
    { 'Set-Cookie': sessionCookie(token) },
  );
}

/**
 * Sign out. Mirrors DELETE /api/admin/login, and exists for the same reason the
 * admin side has one -- except it matters more here: this side is used on a
 * shared classroom Chromebook, where the next person to open the browser is a
 * different family. Before this, the only way out was to wait two hours for the
 * cookie to expire or to know how to clear site data.
 *
 * Nothing is flushed on the way out and nothing needs to be. An initial is
 * written by POST /api/sign/initial the moment the button is pressed -- there
 * is no draft, no autosave timer and no buffer -- so every signature that
 * exists is already durable before this is ever called. What the CLIENT guards
 * against is the one thing not yet sent: initials typed into a box whose button
 * has not been pressed. See the sign-out handler in public/app.js.
 *
 * Two things happen, and the order matters less than the fact that the second
 * happens even if the first does not:
 *
 *   1. The session is REVOKED server-side -- stamped on the identity, scoped to
 *      the role in the token, so every session this person holds stops being
 *      accepted. Without it, clearing the cookie only asked this browser to
 *      forget a token that went on working for the rest of its two hours.
 *      A student signing out does not end their parent's session; see
 *      migrations/0014 for why that is two columns rather than one.
 *   2. The cookie is cleared, unconditionally.
 *
 * Step 2 runs even when step 1 cannot -- an expired or unreadable cookie has no
 * claims to revoke, and someone pressing Sign out with a dead session should
 * still land signed out rather than on an error.
 */
export async function onRequestDelete({ request, env }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = await currentSession(request, env, nowSec);
  if (claims && SIGNER_ROLES.has(claims.role)) {
    await revokeSigner(env, claims);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}
