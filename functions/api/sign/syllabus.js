// GET /api/sign/syllabus   -- the published syllabus for the session's account
//
// Returns the latest published version of the syllabus belonging to the
// student's course, its blocks in order, and which blocks this signer has
// already initialed. The account's own course is the only one reachable --
// there is no id parameter to tamper with.

import { json, unauthorized, serverMisconfigured } from '../../_lib/http.js';
import { currentSession, SIGNER_ROLES } from '../../_lib/session.js';

export async function onRequestGet({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');

  const nowSec = Math.floor(Date.now() / 1000);
  const claims = await currentSession(request, env, nowSec);
  // A teacher session is not a signer. Explicit, so an admin cookie can never
  // produce a signature attributed to a parent.
  if (!claims || !SIGNER_ROLES.has(claims.role)) return unauthorized();

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
  ).bind(claims.sub).first();

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

  const { results: signed } = await env.DB.prepare(
    `SELECT block_id, initials, signed_at
       FROM signatures
      WHERE account_id = ?1 AND version_id = ?2 AND role = ?3`,
  ).bind(claims.sub, version.id, claims.role).all();

  const signedBy = new Map((signed ?? []).map((s) => [s.block_id, s]));
  const required = (blocks ?? []).filter((b) => b.needs_initials);

  return json({
    role: claims.role,
    student: `${version.first} ${version.last}`,
    period: version.period,
    course: version.course,
    title: version.title,
    version: version.num,
    published_at: version.published_at,
    blocks: (blocks ?? []).map((b) => ({
      id: b.id,
      type: b.type,
      html: b.html,
      // The page splits on this. Selecting it in SQL was not enough -- this
      // list is a whitelist, and a field missing from it arrives as undefined,
      // which startsSection reads as level 2. Every subheading then became its
      // own page: 15 for a 9-section syllabus, while the editor showed 9.
      level: b.level ?? 2,
      needs_initials: !!b.needs_initials,
      signed: signedBy.get(b.id) ?? null,
    })),
    progress: { signed: required.filter((b) => signedBy.has(b.id)).length, required: required.length },
  });
}
