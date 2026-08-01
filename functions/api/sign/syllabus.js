// GET /api/sign/syllabus   -- the published syllabus for the session's account
//
// Returns the latest published version of the syllabus belonging to the
// student's course, its blocks in order, and which blocks this signer has
// already initialed. The account's own course is the only one reachable --
// there is no id parameter to tamper with.

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

  // Matched on what was AGREED TO, not on which row said it.
  //
  // Publishing clones every block, so ids do not cross a version boundary and
  // the old `version_id = current AND block_id = ...` lookup found nothing the
  // moment an amendment went live -- a family that changed one line of the late
  // work policy asked every parent to re-initial the entire syllabus. Sections
  // whose text is untouched keep the signature they already have; the ones that
  // moved come back unsigned, because their hash moved with them.
  const attested = await attestedByAccount(env.DB, claims.sub, claims.role);
  const hashes = await promptKeys(blocks ?? []);

  // Has this family signed anything at all, ever? It decides whether an
  // unsigned prompt is NEW or CHANGED, and those are different sentences: a
  // parent opening the syllabus for the first time is not being told something
  // was amended.
  const returning = attested.size > 0;

  const signedAt = (i) => (hashes[i] ? attested.get(hashes[i]) ?? null : null);
  const required = (blocks ?? []).filter((b) => b.needs_initials);

  return json({
    role: claims.role,
    student: `${version.first} ${version.last}`,
    period: version.period,
    course: version.course,
    title: version.title,
    version: version.num,
    published_at: version.published_at,
    blocks: (blocks ?? []).map((b, i) => ({
      id: b.id,
      type: b.type,
      html: b.html,
      // The page splits on this. Selecting it in SQL was not enough -- this
      // list is a whitelist, and a field missing from it arrives as undefined,
      // which startsSection reads as level 2. Every subheading then became its
      // own page: 15 for a 9-section syllabus, while the editor showed 9.
      level: b.level ?? 2,
      needs_initials: !!b.needs_initials,
      signed: signedAt(i),
      // This section asks for initials, this family has signed before, and what
      // it says now is not what they agreed to. That is an amendment, and it is
      // the only thing on the page they actually have to read again.
      updated: !!b.needs_initials && returning && !signedAt(i),
    })),
    progress: {
      signed: (blocks ?? []).filter((b, i) => b.needs_initials && signedAt(i)).length,
      required: required.length,
    },
    // How many sections changed under a returning family. Zero for a first
    // visit, however many prompts are outstanding.
    amended: (blocks ?? []).filter((b, i) => b.needs_initials && returning && !signedAt(i)).length,
  });
}
