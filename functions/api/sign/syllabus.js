// GET /api/sign/syllabus   -- the published syllabus for the session's identity
//
// Returns the latest published version of the syllabus belonging to the
// student's course, its blocks in order, and which blocks this signer has
// already initialed. The identity's own courses are the only ones reachable --
// there is no id parameter to tamper with.
//
// ?course=N selects a specific course. Without it, defaults to the identity's
// course with unsigned required blocks remaining; if none are outstanding (or
// the identity has only one course), uses the first.
//
// When the identity has more than one account (more than one course), the
// response includes a `courses` list for a class switcher.

import { json, unauthorized, serverMisconfigured } from '../../_lib/http.js';
import { currentSession, SIGNER_ROLES } from '../../_lib/session.js';
import { attestedByAccount, promptKeys } from '../../_lib/syllabus.js';

export async function onRequestGet({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');

  const nowSec = Math.floor(Date.now() / 1000);
  const claims = await currentSession(request, env, nowSec);
  // A teacher session is not a signer. Explicit, so an admin cookie can never
  // produce a signature attributed to a parent.
  if (!claims || !SIGNER_ROLES.has(claims.role)) return unauthorized();

  const url = new URL(request.url);
  const requestedCourse = Number(url.searchParams.get('course')) || null;

  // All courses this identity is enrolled in, for the class switcher.
  const { results: courses } = await env.DB.prepare(
    `SELECT DISTINCT c.id, c.name
       FROM accounts a
       JOIN roster   r ON r.id = a.roster_id
       JOIN courses  c ON c.id = r.course_id
      WHERE a.identity_id = ?1 AND r.status = 'active'
      ORDER BY c.name`,
  ).bind(claims.sub).all();

  if (!courses || courses.length === 0) {
    return json({ error: 'You are not enrolled in any courses.' }, 404);
  }

  // Pick the course: explicit ?course= param, or default to the one with
  // unsigned sections remaining, or the first.
  let courseId;
  if (requestedCourse) {
    if (!courses.some((c) => c.id === requestedCourse)) {
      return json({ error: 'That course is not part of your syllabus.' }, 404);
    }
    courseId = requestedCourse;
  } else if (courses.length === 1) {
    courseId = courses[0].id;
  } else {
    // Default to the course with unsigned required blocks remaining.
    courseId = await defaultCourse(env.DB, claims.sub, claims.role, courses);
  }

  // Resolve the specific account row for this identity + course.
  const account = await env.DB.prepare(
    `SELECT a.id AS account_id
       FROM accounts a
       JOIN roster   r ON r.id = a.roster_id
      WHERE a.identity_id = ?1 AND r.course_id = ?2 AND r.status = 'active'
      LIMIT 1`,
  ).bind(claims.sub, courseId).first();

  if (!account) {
    return json({ error: 'That course is not part of your syllabus.' }, 404);
  }

  const version = await env.DB.prepare(
    `SELECT v.id, v.num, v.published_at, s.title, c.name AS course, r.first, r.last, r.period
       FROM accounts  a
       JOIN roster    r ON r.id = a.roster_id
       JOIN courses   c ON c.id = r.course_id
       JOIN syllabi   s ON s.course_id = c.id
       JOIN versions  v ON v.syllabus_id = s.id AND v.published_at IS NOT NULL
      WHERE a.id = ?1
      ORDER BY v.num DESC
      LIMIT 1`,
  ).bind(account.account_id).first();

  if (!version) {
    return json({ error: 'Your teacher has not published a syllabus yet.' }, 404);
  }

  // `level` is not decoration here. The page splits on it, and a heading whose
  // level does not arrive defaults to 2 -- which turned every subheading into
  // its own page, and the parent's syllabus into 15 pages instead of 9.
  const { results: blocks } = await env.DB.prepare(
    `SELECT id, ord, type, html, needs_initials, level
       FROM blocks WHERE version_id = ?1 ORDER BY ord`,
  ).bind(version.id).all();

  // Matched on what was AGREED TO, not on which row said it.
  //
  // Publishing clones every block, so ids do not cross a version boundary and
  // the old `version_id = current AND block_id = ...` lookup found nothing the
  // moment an amendment went live -- a family that changed one line of the late
  // work policy asked every parent to re-initial the entire syllabus. Sections
  // whose text is untouched keep the signature they already have; the ones that
  // moved come back unsigned, because their hash moved with them.
  const attested = await attestedByAccount(env.DB, account.account_id, claims.role);
  const hashes = await promptKeys(blocks ?? []);

  // Has this family signed anything at all, ever? It decides whether an
  // unsigned prompt is NEW or CHANGED, and those are different sentences: a
  // parent opening the syllabus for the first time is not being told something
  // was amended.
  const returning = attested.size > 0;

  const signedAt = (i) => (hashes[i] ? attested.get(hashes[i]) ?? null : null);
  const required = (blocks ?? []).filter((b) => b.needs_initials);

  const response = {
    role: claims.role,
    student: `${version.first} ${version.last}`,
    period: version.period,
    course: version.course,
    course_id: courseId,
    title: version.title,
    version: version.num,
    published_at: version.published_at,
    blocks: (blocks ?? []).map((b, i) => ({
      id: b.id,
      type: b.type,
      html: b.html,
      level: b.level ?? 2,
      needs_initials: !!b.needs_initials,
      signed: signedAt(i),
      updated: !!b.needs_initials && returning && !signedAt(i),
    })),
    progress: {
      signed: (blocks ?? []).filter((b, i) => b.needs_initials && signedAt(i)).length,
      required: required.length,
    },
    amended: (blocks ?? []).filter((b, i) => b.needs_initials && returning && !signedAt(i)).length,
  };

  // Include the course list for the class switcher when there's more than one.
  if (courses.length > 1) {
    response.courses = courses.map((c) => ({ id: c.id, name: c.name }));
  }

  return json(response);
}

/** Pick the default course: the one with unsigned required blocks remaining,
 *  or the first if all are complete. */
async function defaultCourse(db, identityId, role, courses) {
  for (const c of courses) {
    const account = await db.prepare(
      `SELECT a.id FROM accounts a
         JOIN roster r ON r.id = a.roster_id
        WHERE a.identity_id = ?1 AND r.course_id = ?2 AND r.status = 'active'
        LIMIT 1`,
    ).bind(identityId, c.id).first();
    if (!account) continue;

    const version = await db.prepare(
      `SELECT v.id FROM versions v
         JOIN syllabi s ON s.id = v.syllabus_id
        WHERE s.course_id = ?1 AND v.published_at IS NOT NULL
        ORDER BY v.num DESC LIMIT 1`,
    ).bind(c.id).first();
    if (!version) continue;

    const { results: blocks } = await db.prepare(
      'SELECT id, ord, type, html, needs_initials, level FROM blocks WHERE version_id = ?1 ORDER BY ord',
    ).bind(version.id).all();

    const attested = await attestedByAccount(db, account.id, role);
    const hashes = await promptKeys(blocks ?? []);
    const signed = (blocks ?? []).filter((b, i) => b.needs_initials && hashes[i] && attested.has(hashes[i])).length;
    const required = (blocks ?? []).filter((b) => b.needs_initials).length;

    if (signed < required) return c.id;
  }
  return courses[0].id;
}
