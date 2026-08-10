// POST /api/admin/login    -- teacher sign-in
// DELETE /api/admin/login  -- sign out
//
// ONE credential: a signed-up teacher's email and password. The session carries
// their id, and every admin route then shows only their own courses.
//
// The shared ADMIN_PASSWORD_HASH is GONE. It was the site owner's break-glass
// path for a teacher who had lost their account, and it stopped being worth its
// cost once migrations/0015 gave teachers a real password reset -- a better
// answer to the same problem, and one that does not hand anybody a standing key.
//
// What it cost while it existed:
//   - a credential the operator holds that opens courses they do not own
//     (unowned ones -- see owns() in _lib/http.js)
//   - a session carrying `sub` 0, which is not a row in `teachers` and so had
//     no session generation to bump: alone among sessions here, it could not be
//     revoked. Rotating the secret was the only way to end one.
//
// Tokens minted under it are rejected outright rather than left to expire; see
// requireAdmin. Removing a credential should end the sessions it opened.
//
// Cloudflare Access is the other gate and does not pass through here at all:
// when configured it authenticates at the edge and requireAdmin accepts the
// header on its own. An Access identity still owns nothing -- it reaches
// unowned courses only, never a teacher's.

import { json, badRequest, serverMisconfigured, readJson } from '../../_lib/http.js';
import { verifyCode } from '../../_lib/codes.js';
import { hit, reset, clientIp } from '../../_lib/ratelimit.js';
import {
  signSession, sessionCookie, clearCookie, currentSession, revokeTeacher,
} from '../../_lib/session.js';
import { normalizeEmail } from '../../_lib/teachers.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');
  if (!env.SESSION_SECRET) return serverMisconfigured('SESSION_SECRET');

  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password ?? '');

  if (!email) return badRequest('Enter your school email address.');
  if (!password) return badRequest('Enter your password.');

  const nowSec = Math.floor(Date.now() / 1000);
  const ip = clientIp(request);

  // Per IP, not per account: limiting per account would let anyone lock a
  // colleague out of their own roster by guessing at their address five times.
  // Tighter than the parent flow -- legitimate traffic here is a handful of
  // attempts a term, and anything more is someone else trying.
  const limit = await hit(env.DB, `admin:${ip}`, nowSec, { max: 5, windowSec: 30 * 60 });
  if (!limit.allowed) {
    return json({ error: 'Too many attempts. Try again later.' }, 429, { 'Retry-After': String(limit.retryAfter) });
  }

  // verifyCode is PBKDF2 + constant-time compare; reused rather than
  // reimplemented so there is one hashing path in the app, not two.
  const teacher = await env.DB.prepare('SELECT id, password_hash, session_gen FROM teachers WHERE email = ?1')
    .bind(email).first();
  // Same message and the same work either way. Skipping the hash when no such
  // teacher exists would answer "does this address have an account?" in the
  // response time, which is exactly what the domain gate is trying not to
  // give away.
  const ok = await verifyCode(password, teacher?.password_hash ?? DUMMY_HASH);
  if (!teacher || !ok) return json({ error: 'Incorrect email or password.' }, 401);

  await reset(env.DB, `admin:${ip}`);
  await env.DB.prepare('UPDATE teachers SET last_login_at = ?1 WHERE id = ?2').bind(nowSec, teacher.id).run();

  // The generation this account is on, so a later sign-out or password reset
  // can tell this token apart from the ones it is ending. Read from the row
  // already fetched above rather than a second query.
  const token = await signSession(env, teacher.id, 'teacher', nowSec,
    { email, gen: teacher.session_gen });
  return json({ ok: true, email }, 200, { 'Set-Cookie': sessionCookie(token) });
}

// A real PBKDF2 hash of a value nothing can submit, so the no-such-teacher path
// costs the same 100k iterations as a wrong password against a real account.
const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * Sign out.
 *
 * Revokes server-side as well as clearing the cookie, the same way the signer
 * side does (api/sign/login.js). Until migration 0016 this only cleared the
 * cookie, so a captured admin token stayed good for the rest of its two hours
 * -- and an admin token reaches every student record in that teacher's classes.
 *
 * Every admin session now belongs to a real `teachers` row, so every one of
 * them has a generation to bump. The one that did not -- the shared password's
 * `sub` 0 -- no longer exists.
 *
 * The cookie is cleared either way, including for a session too stale to read,
 * so pressing Sign out always signs you out.
 */
export async function onRequestDelete({ request, env }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = await currentSession(request, env, nowSec);
  if (claims?.role === 'teacher' && claims.sub) {
    await revokeTeacher(env, claims.sub);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}
