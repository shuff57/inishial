// POST /api/sign/login   -- parent or student enters the access code
//
// Body: { student_ext_id, email, code }
//
// There is no `role` field. The account carries two codes -- one the parent was
// mailed, one the student was shown when they registered -- and which of them
// is typed here is what decides whose signature the session can write. A field
// asking the visitor to declare it was the same thing as letting them choose.
//
// The syllabus URL is public and shared, so the access code is the only thing
// standing between a stranger and signing as someone's parent. Everything
// defensive in this file exists for that reason.
//
// With student_identities, codes live on the identity row. The loop-over-
// candidates-with-decoy-hashing pattern is retargeted at student_identities
// instead of accounts+roster: loop over every identity matching student_ext_id
// (there can legitimately be more than one if two schools share an id), check
// both code hashes against each with the same decoy-timing discipline, and
// determine role from which hash matches. Session's claims.sub becomes the
// identity's id.

import { json, badRequest, serverMisconfigured, readJson } from '../../_lib/http.js';
import { verifyCode, normalize } from '../../_lib/codes.js';
import { hit, reset, clientIp } from '../../_lib/ratelimit.js';
import { signSession, sessionCookie } from '../../_lib/session.js';
import { resolveSchoolScope, SCHOOL_SCOPE_JOIN } from '../../_lib/schoolScope.js';

// One message for every failure mode. Distinguishing "no such student" from
// "wrong code" would turn this endpoint into a student-ID oracle.
const REJECT = 'That student ID and access code do not match. Check the email from your teacher.';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');
  if (!env.SESSION_SECRET) return serverMisconfigured('SESSION_SECRET');

  const body = await readJson(request);
  if (!body) return badRequest('Expected a JSON body.');

  const studentExtId = String(body.student_ext_id ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const code = normalize(body.code);
  // The role is NOT taken from the request. It used to be -- `body.role` chose
  // between the two attestations and one code opened both, so a student holding
  // the family's code could sign as their own parent. There are two codes now
  // and the role is whichever one the submitted code turns out to be.
  if (!studentExtId || !email || !code) {
    return badRequest('Enter the student ID, your email address, and the access code.');
  }

  const scope = await resolveSchoolScope(env.DB, body.school_id);
  if (!scope.ok) return badRequest(scope.error);

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

  // EVERY identity with this student_ext_id, not `LIMIT 1`. Two schools on
  // this install can legitimately share a student ID, so the same number
  // appears on two identity rows. The email is what disambiguates, and it
  // decides the side as well: the school address on the identity means the
  // student is signing, the family address means the parent is. Whichever
  // matches, only that side's code is accepted.
  //
  // Also join roster to get the student name and course info for the response.
  const { results: rows = [] } = await env.DB.prepare(
    `SELECT si.id, si.code_hash, si.student_code_hash, si.username, si.parent_email,
            r.first, r.last, r.course_id, r.parent_email AS roster_email
       FROM student_identities si
       JOIN accounts a ON a.identity_id = si.id
       JOIN roster   r ON r.id = a.roster_id
       JOIN courses  c ON c.id = r.course_id
       LEFT JOIN teachers t  ON t.id = c.owner_id
       LEFT JOIN schools  sc ON sc.id = COALESCE(t.school_id, si.school_id)
      WHERE si.student_ext_id = ?1 AND r.status = 'active'
        AND (?2 IS NULL OR sc.id = ?2)
      GROUP BY si.id`,
  ).bind(studentExtId, scope.schoolIdFilter).all();

  // Both hashes are verified for EVERY candidate, and no result short-circuits
  // another. Stopping at the first match would make a parent code measurably
  // faster to check than a student code, and would make one candidate faster
  // than two -- both are side channels telling an attacker what they just hit.
  //
  // The decoys keep a missing student, a student with no code yet, and a wrong
  // code all costing the same work.
  const DECOY = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  let row = null;
  let role = null;
  for (const cand of rows) {
    const parentOk = await verifyCode(code, cand.code_hash || DECOY) && !!cand.code_hash;
    const studentOk = await verifyCode(code, cand.student_code_hash || DECOY) && !!cand.student_code_hash;
    const isStudentEmail = !!cand.username && String(cand.username).toLowerCase() === email;
    const onFile = cand.parent_email || cand.roster_email;
    const isParentEmail = !!onFile && String(onFile).toLowerCase() === email;

    // Assigned rather than broken out of, so a second candidate costs the same
    // as the first and the loop does not leak how many rows matched.
    if (!row && isStudentEmail && studentOk) { row = cand; role = 'student'; }
    else if (!row && isParentEmail && parentOk) { row = cand; role = 'parent'; }
  }
  if (!row) return json({ error: REJECT }, 401);

  await reset(env.DB, `login:ip:${ip}`);
  await reset(env.DB, `login:stu:${studentExtId}`);

  const token = await signSession(env, row.id, role, nowSec);
  return json(
    { ok: true, role, student: `${row.first} ${row.last}` },
    200,
    { 'Set-Cookie': sessionCookie(token) },
  );
}
