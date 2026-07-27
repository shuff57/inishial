// POST /api/register  -- student self-registration (public, QR-code target)
//
// Body: { student_ext_id, last, username, parent_email }
//
// Gated on the student already existing in the teacher's uploaded roster, so
// only real students in real classes can create an account.
//
// No access code is issued here. Codes are minted by the teacher's credential
// export (see api/admin/credentials.js) -- students never handle one.

import { json, badRequest, serverMisconfigured, readJson } from '../_lib/http.js';
import { hit, reset, clientIp } from '../_lib/ratelimit.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/i;
// Deliberately permissive. Strict RFC-5322 validation rejects addresses that
// work; the real check is whether the parent receives the mail.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  if (!body) return badRequest('Expected a JSON body.');

  const studentExtId = String(body.student_ext_id ?? '').trim();
  const last = String(body.last ?? '').trim();
  const username = String(body.username ?? '').trim();
  const parentEmail = String(body.parent_email ?? '').trim();

  if (!studentExtId || !last) return badRequest('Enter your student ID and last name.');
  if (!USERNAME_RE.test(username)) {
    return badRequest('Username must be 3-32 characters: letters, numbers, dot, dash, underscore.');
  }
  // Optional: the roster export already carries a contact address for most
  // families. This is the escape hatch for the ones where it is missing or
  // wrong, so it is validated when given and ignored when not.
  if (parentEmail && !EMAIL_RE.test(parentEmail)) {
    return badRequest("That doesn't look like an email address. Leave it blank to use the one your school has on file.");
  }

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

  const existing = await env.DB.prepare('SELECT username FROM accounts WHERE roster_id = ?1')
    .bind(rosterRow.id).first();
  if (existing) {
    return json({ error: 'You are already registered. Ask your teacher if you need help signing in.' }, 409);
  }

  try {
    await env.DB.prepare(
      'INSERT INTO accounts (roster_id, username, parent_email, created_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(rosterRow.id, username, parentEmail || null, nowSec).run();
  } catch (err) {
    // UNIQUE(username) is the only constraint a well-formed request can trip.
    if (String(err?.message || '').includes('UNIQUE')) {
      return json({ error: 'That username is taken. Pick another.' }, 409);
    }
    throw err;
  }

  await reset(env.DB, `reg:${clientIp(request)}`);

  const hasContact = !!(parentEmail || rosterRow.parent_email);

  // Two things deliberately absent from this response, both of which a student
  // could otherwise read off a shared Chromebook:
  //   - the parent's email address, in any form, masked or not
  //   - the access code, which is minted only by the teacher's export
  return json({
    ok: true,
    username,
    student: `${rosterRow.first} ${rosterRow.last}`,
    course: rosterRow.course,
    period: rosterRow.period,
    has_contact: hasContact,
    message: hasContact
      ? 'You are registered. Your teacher will email your parent or guardian a link to the syllabus.'
      : 'You are registered. Tell your teacher we have no parent email on file for you.',
  }, 201);
}
