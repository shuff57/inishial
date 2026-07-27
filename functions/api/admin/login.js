// POST /api/admin/login    -- teacher sign-in
// DELETE /api/admin/login  -- sign out
//
// The alternative to Cloudflare Access, not a replacement for it: when Access
// is configured it gates the request first and this never runs. Both are
// accepted by requireAdmin(), so adding Zero Trust later needs no code change.
//
// The password is stored as a PBKDF2 hash in ADMIN_PASSWORD_HASH (a Pages
// secret). The plaintext exists only where the teacher keeps it. It should be
// generated, not chosen -- a memorable password guarding student PII is the
// weak point this whole design otherwise avoids.

import { json, badRequest, serverMisconfigured, readJson } from '../../_lib/http.js';
import { verifyCode } from '../../_lib/codes.js';
import { hit, reset, clientIp } from '../../_lib/ratelimit.js';
import { signSession, sessionCookie, clearCookie } from '../../_lib/session.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');
  if (!env.SESSION_SECRET) return serverMisconfigured('SESSION_SECRET');
  if (!env.ADMIN_PASSWORD_HASH) {
    return serverMisconfigured('ADMIN_PASSWORD_HASH (run: wrangler pages secret put ADMIN_PASSWORD_HASH)');
  }

  const body = await readJson(request);
  const password = String(body?.password ?? '');
  if (!password) return badRequest('Enter the admin password.');

  const nowSec = Math.floor(Date.now() / 1000);
  const ip = clientIp(request);

  // Tighter than the parent limiter: there is exactly one admin credential, so
  // legitimate traffic here is a handful of attempts a term, and anything more
  // is someone else trying.
  const limit = await hit(env.DB, `admin:${ip}`, nowSec, { max: 5, windowSec: 30 * 60 });
  if (!limit.allowed) {
    return json({ error: 'Too many attempts. Try again later.' }, 429, { 'Retry-After': String(limit.retryAfter) });
  }

  // verifyCode is PBKDF2 + constant-time compare; reused rather than
  // reimplemented so there is one hashing path in the app, not two.
  if (!(await verifyCode(password, env.ADMIN_PASSWORD_HASH))) {
    return json({ error: 'Incorrect password.' }, 401);
  }

  await reset(env.DB, `admin:${ip}`);

  // sub 0 is not a real account id, so a teacher cookie cannot be mistaken for
  // a signer even if one reached a signing route.
  const token = await signSession(env, 0, 'teacher', nowSec);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
}

export async function onRequestDelete() {
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}
