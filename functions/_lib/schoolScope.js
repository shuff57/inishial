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
//   - exactly one school on the install (today's default): scoping is a
//     no-op. `schoolIdFilter` comes back null, and the caller's query must
//     match a roster row regardless of school -- including one behind an
//     unowned course -- exactly as it did before this file existed.
//   - more than one school: the caller must supply a school_id, and only a
//     roster row whose course's owner belongs to that school matches. An
//     unowned/legacy course has no school in this state and is therefore
//     unreachable through these forms until its owner adopts it at sign-up --
//     an accepted gap, not a bug to work around here.
//
// Callers splice `schoolIdFilter` into a `WHERE ... AND (?n IS NULL OR
// sc.id = ?n)` clause against a query that LEFT JOINs
// `courses c ON c.id = r.course_id`, `teachers t ON t.id = c.owner_id`,
// `schools sc ON sc.id = t.school_id` -- one query shape covers both cases,
// since NULL makes the filter a no-op and a real id excludes unowned rows.

/** Resolve the school scope for a request. `requestedSchoolId` is whatever the
 *  client sent (a string, a number, or nothing). Returns:
 *    { ok: true,  schoolIdFilter: null }        -- one school; scoping is a no-op
 *    { ok: true,  schoolIdFilter: <number> }     -- multiple schools; scoped to this one
 *    { ok: false, error: <message> }             -- multiple schools, none given
 */
export async function resolveSchoolScope(db, requestedSchoolId) {
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM schools').first())?.n ?? 0;
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
