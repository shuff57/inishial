// POST /api/sign/login   -- parent or student enters the access code
//
// Body: { student_ext_id, code, role }   role: 'parent' | 'student'
//
// The syllabus URL is public and shared, so the access code is the only thing
// standing between a stranger and signing as someone's parent. Everything
// defensive in this file exists for that reason.

import { json, badRequest, serverMisconfigured, readJson } from '../../_lib/http.js';
import { verifyCode, normalize } from '../../_lib/codes.js';
import { hit, reset, clientIp } from '../../_lib/ratelimit.js';
import { signSession, sessionCookie } from '../../_lib/session.js';

// One message for every failure mode. Distinguishing "no such student" from
// "wrong code" would turn this endpoint into a student-ID oracle.
const REJECT = 'That student ID and access code do not match. Check the email from your teacher.';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');
  if (!env.SESSION_SECRET) return serverMisconfigured('SESSION_SECRET');

  const body = await readJson(request);
  if (!body) return badRequest('Expected a JSON body.');

  const studentExtId = String(body.student_ext_id ?? '').trim();
  const code = normalize(body.code);
  const role = body.role === 'student' ? 'student' : 'parent';
  if (!studentExtId || !code) return badRequest('Enter the student ID and the access code.');

  const nowSec = Math.floor(Date.now() / 1000);
  const ip = clientIp(request);

  // Two independent buckets. Per-IP stops one attacker walking many students;
  // per-student stops a distributed attempt concentrating on one account.
  // Counted before verification, so failures and successes both cost quota.
  for (const key of [`login:ip:${ip}`, `login:stu:${studentExtId}`]) {
    const limit = await hit(env.DB, key, nowSec);
    if (!limit.allowed) {
      return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429, {
        'Retry-After': String(limit.retryAfter),
      });
    }
  }

  const row = await env.DB.prepare(
    `SELECT a.id, a.code_hash, r.first, r.last, r.course_id
       FROM accounts a
       JOIN roster r ON r.id = a.roster_id
      WHERE r.student_ext_id = ?1 AND r.status = 'active'
      LIMIT 1`,
  ).bind(studentExtId).first();

  // Verify against a decoy hash when the account is absent, so a missing
  // student and a wrong code take the same amount of time to reject.
  const stored = row?.code_hash || 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const valid = await verifyCode(code, stored);
  if (!row || !row.code_hash || !valid) return json({ error: REJECT }, 401);

  await reset(env.DB, `login:ip:${ip}`);
  await reset(env.DB, `login:stu:${studentExtId}`);

  const token = await signSession(env, row.id, role, nowSec);
  return json(
    { ok: true, role, student: `${row.first} ${row.last}` },
    200,
    { 'Set-Cookie': sessionCookie(token) },
  );
}
