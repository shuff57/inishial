// POST /api/admin/login    -- teacher sign-in
// DELETE /api/admin/login  -- sign out
//
// Two credentials arrive here, and which one it is depends on whether `email`
// was sent:
//
//   email + password -- a teacher who signed up. Session carries their id, and
//                       every admin route then shows only their courses.
//   password alone   -- the shared ADMIN_PASSWORD_HASH secret. The site owner:
//                       sub 0, scoped to nothing, sees every course. Kept
//                       because it is the break-glass path if a teacher account
//                       is lost, and because it predates teacher accounts.
//
// Cloudflare Access is the third gate and does not pass through here at all:
// when it is configured it authenticates at the edge and requireAdmin accepts
// the header on its own.
//
// The shared password is a Pages secret. It should be generated, not chosen --
// a memorable password guarding student PII is the weak point this whole design
// otherwise avoids.

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

  if (!email && !env.ADMIN_PASSWORD_HASH) {
    return serverMisconfigured('ADMIN_PASSWORD_HASH (run: wrangler pages secret put ADMIN_PASSWORD_HASH)');
  }
  if (!password) return badRequest(email ? 'Enter your password.' : 'Enter the admin password.');

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
  if (email) {
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

  if (!(await verifyCode(password, env.ADMIN_PASSWORD_HASH))) {
    return json({ error: 'Incorrect password.' }, 401);
  }
  await reset(env.DB, `admin:${ip}`);

  // sub 0 is not a real account id, so a teacher cookie cannot be mistaken for
  // a signer even if one reached a signing route.
  const token = await signSession(env, 0, 'teacher', nowSec);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
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
 * The shared ADMIN_PASSWORD_HASH session carries `sub` 0 and has no row to
 * bump, so it clears the cookie and nothing more. Rotating the secret is what
 * ends those; see migrations/0016.
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
