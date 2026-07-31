// POST /api/admin/signup   -- a teacher creates their own account
// GET  /api/admin/signup   -- is sign-up available, and for which domains
//
// Open by default: anyone who finds the site can create a teacher account.
// TEACHER_DOMAINS is now an optional restriction rather than a required one. Set
// it to a school's domains and only those addresses are accepted; leave it unset
// and any address is.
//
// What this deliberately is NOT: proof of identity. Nothing emails the address,
// so an account proves only that someone typed a plausible string. What is left
// holding the line is that an account can claim only ONE address, it holds only
// its own courses, the address is recorded against every roster import made
// with it, and sign-ups are rate limited per IP. Real proof needs either a
// verification email (no mail sender exists here) or Cloudflare Access in front
// of /admin/*, which requireAdmin already accepts.

import { json, badRequest, serverMisconfigured, readJson } from '../../_lib/http.js';
import { hashCode } from '../../_lib/codes.js';
import { hit, clientIp } from '../../_lib/ratelimit.js';
import { signSession, sessionCookie } from '../../_lib/session.js';
import { normalizeEmail, listFrom, domainAllowed, looksLikeEmail, passwordProblem } from '../../_lib/teachers.js';

/** What the sign-up page needs to render itself, without leaking anything: the
 *  domain list is about to be shown to anyone who submits the form anyway. */
export function onRequestGet({ env }) {
  // Always available now. `domains` empty tells the page there is no rule to
  // announce, rather than that the form is closed.
  const domains = listFrom(env.TEACHER_DOMAINS);
  return json({ available: true, domains });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');
  if (!env.SESSION_SECRET) return serverMisconfigured('SESSION_SECRET');

  // No 403 for an empty list any more: unset TEACHER_DOMAINS now means sign-up
  // is open to anyone, not that it is switched off. See domainAllowed().
  const domains = listFrom(env.TEACHER_DOMAINS);

  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const password = String(body?.password ?? '');
  const name = String(body?.name ?? '').trim().slice(0, 120) || null;

  if (!email) return badRequest('Enter your school email address.');
  if (!looksLikeEmail(email)) return badRequest('That does not look like an email address.');

  // Before the domain check and before any hashing: an unlimited signup
  // endpoint is an unlimited way to probe which addresses are already taken.
  const nowSec = Math.floor(Date.now() / 1000);
  const limit = await hit(env.DB, `signup:${clientIp(request)}`, nowSec, { max: 5, windowSec: 60 * 60 });
  if (!limit.allowed) {
    return json({ error: 'Too many sign-up attempts. Try again later.' }, 429,
      { 'Retry-After': String(limit.retryAfter) });
  }

  if (!domainAllowed(email, domains)) {
    const list = domains.map((d) => (d.startsWith('.') ? `*${d}` : `@${d}`)).join(' or ');
    return badRequest(`Use your school email address — it has to end in ${list}.`);
  }

  const problem = passwordProblem(password, email);
  if (problem) return badRequest(problem);

  const hash = await hashCode(password);

  // The UNIQUE index decides, not a SELECT beforehand: two sign-ups for the
  // same address racing each other would both pass a check-then-insert.
  let teacherId;
  try {
    const row = await env.DB.prepare(
      'INSERT INTO teachers (email, name, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(email, name, hash, nowSec).run();
    teacherId = row.meta.last_row_id;
  } catch (err) {
    if (/UNIQUE|constraint/i.test(String(err?.message))) {
      return json({ error: 'That address already has an account. Sign in instead.', taken: true }, 409);
    }
    throw err;
  }

  await adoptUnownedCourses(env, teacherId, email);

  const token = await signSession(env, teacherId, 'teacher', nowSec, email);
  return json({ ok: true, email }, 200, { 'Set-Cookie': sessionCookie(token) });
}

/**
 * Hand the site owner the courses that predate teacher accounts.
 *
 * Courses imported under the shared admin password have no owner. Without this
 * the person who deployed the app signs up and finds their own classes gone --
 * they are still reachable through the shared password, but that is a
 * confusing place to leave them.
 *
 * Who counts as the site owner: an address in ADMIN_EMAILS, which is already
 * "the people who deployed this". With ADMIN_EMAILS unset there is nothing to
 * check against, so it falls back to whoever signs up first -- fine on a fresh
 * deployment, where there is nothing to adopt anyway.
 *
 * ponytail: no UI for transferring a course between teachers. Add one when a
 * class actually changes hands mid-year; a D1 UPDATE covers it until then.
 */
async function adoptUnownedCourses(env, teacherId, email) {
  const owners = listFrom(env.ADMIN_EMAILS);
  const isOwner = owners.length
    ? owners.includes(email)
    : (await env.DB.prepare('SELECT COUNT(*) AS n FROM teachers').first())?.n === 1;
  if (!isOwner) return;
  await env.DB.prepare('UPDATE courses SET owner_id = ?1 WHERE owner_id IS NULL').bind(teacherId).run();
}
