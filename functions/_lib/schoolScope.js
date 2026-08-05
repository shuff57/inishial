// Shared by the public forms that disambiguate a roster row by school:
// register.js and sign/request-code.js. See the school-scoping-and-identity
// plan, "Why: the leak, reproduced".
//
// A student_ext_id is unique per COURSE (migrations/0001), not per install, so
// two schools sharing an install can genuinely reuse one. A course reaches its
// school through its owning teacher (roster -> courses -> teachers -> schools),
// and courses.owner_id can be NULL -- a course imported before any teacher
// signed up (migrations/0002's comment). That means an unowned course has no
// school to match against at all, which is why the two cases below are
// deliberately different rather than one query with a fallback:
//
//   - exactly one school in use (today's default): scoping is a no-op.
//     `schoolIdFilter` comes back null, and the caller's query must match a
//     roster row regardless of school -- including one behind an unowned
//     course -- exactly as it did before this file existed.
//   - more than one school in use: the caller must supply a school_id, and
//     only a roster row whose course's owner belongs to that school matches.
//     An unowned/legacy course has no school in this state and is therefore
//     unreachable through these forms until its owner adopts it at sign-up --
//     an accepted gap, not a bug to work around here.
//
// "In use" is schools with a teacher assigned (COUNT(DISTINCT teachers.school_id)),
// not every row in the schools table. migrations/0011 pre-seeds ~50 Chico-area
// schools with no teacher attached, as a type-ahead reference list -- a plain
// COUNT(*) would flip every solo-teacher install into "multiple schools" mode
// the moment that migration lands, forcing a school pick on every parent and
// student even though only one real school is in use.
//
// Callers splice `schoolIdFilter` into a `WHERE ... AND (?n IS NULL OR
// sc.id = ?n)` clause against a query that LEFT JOINs
// `courses c ON c.id = r.course_id`, `teachers t ON t.id = c.owner_id`,
// `schools sc ON sc.id = t.school_id` -- one query shape covers both cases,
// since NULL makes the filter a no-op and a real id excludes unowned rows.

/** Schools actually in use -- see the module comment for why this isn't
 *  COUNT(*) FROM schools. Exported so GET /api/schools can tell the public
 *  forms whether to show the field at all, matching this file's own no-op
 *  threshold instead of counting the whole reference list. */
export async function schoolsInUseCount(db) {
  return (await db.prepare('SELECT COUNT(DISTINCT school_id) AS n FROM teachers').first())?.n ?? 0;
}

/** Resolve the school scope for a request. `requestedSchoolId` is whatever the
 *  client sent (a string, a number, or nothing). Returns:
 *    { ok: true,  schoolIdFilter: null }        -- one school; scoping is a no-op
 *    { ok: true,  schoolIdFilter: <number> }     -- multiple schools; scoped to this one
 *    { ok: false, error: <message> }             -- multiple schools, none given
 */
export async function resolveSchoolScope(db, requestedSchoolId) {
  const count = await schoolsInUseCount(db);
  if (count <= 1) return { ok: true, schoolIdFilter: null };

  const schoolId = requestedSchoolId ? Number(requestedSchoolId) : null;
  if (!schoolId || !Number.isInteger(schoolId)) {
    return { ok: false, error: 'Select your school.' };
  }
  return { ok: true, schoolIdFilter: schoolId };
}

/** The LEFT JOIN chain every school-scoped roster query needs, reaching a
 *  school through the roster row's course's owning teacher. Assumes the
 *  caller's own query already joins `courses c ON c.id = r.course_id`; this
 *  continues from that alias rather than joining courses a second time.
 *  Pair with `AND (?n IS NULL OR sc.id = ?n)` in the caller's WHERE, binding
 *  `schoolIdFilter` at position n -- NULL makes the filter a no-op (the
 *  single-school case), a real id excludes rows behind an unowned course. */
export const SCHOOL_SCOPE_JOIN = `
     LEFT JOIN teachers t  ON t.id = c.owner_id
     LEFT JOIN schools  sc ON sc.id = t.school_id`;
