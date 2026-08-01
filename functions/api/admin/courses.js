// /api/admin/courses   -- the life of a class, start to end  (Access gated)
//
//   POST    make one, with no roster
//   PATCH   rename it, put it away at the end of a year, bring it back
//   DELETE  destroy it and everything under it
//
// The roster import creates courses as a side effect of the first upload, which
// is right when the SIS export is in hand and wrong when it is not. A syllabus
// is worth writing in August; the roster does not settle until September, and
// until now the only way to get a class to write against was to invent a CSV.
//
// Listing lives in roster.js alongside the counts it reports.
//
// ARCHIVE IS THE ORDINARY END OF A CLASS; DELETE IS THE EXCEPTION. A course
// deletion cascades through roster -> accounts -> signatures and, separately,
// through syllabi -> versions -> blocks -> signatures. There is no soft-delete
// hiding underneath and no copy kept anywhere: the initials a family gave last
// September stop existing, and /admin/signed can no longer produce the record.
// That is why archiving costs one click and deleting a class with signatures on
// it makes you type its name.

import { json, badRequest, unauthorized, serverMisconfigured, requireAdmin, ownerFilter, ownedCourse, readJson } from '../../_lib/http.js';

export async function onRequestPost({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  const name = String(body?.name ?? '').trim().slice(0, 120);
  if (!name) return badRequest('A class name is required.');

  const owner = ownerFilter(admin);
  // Owner-scoped name match, the same one the roster import uses. Two teachers
  // both have an "Algebra I"; an unscoped lookup would hand one of them the
  // other's class. `IS` rather than `=` because owner is NULL for the site
  // owner, and `= NULL` matches nothing in SQL.
  //
  // An existing class comes back rather than erroring: the button is idempotent
  // then, and a teacher who types a name they already have gets taken to it
  // instead of being told off for it.
  const found = await env.DB.prepare('SELECT id, name FROM courses WHERE name = ?1 AND owner_id IS ?2')
    .bind(name, owner).first();
  if (found) return json({ ok: true, course: found, existing: true });

  const ins = await env.DB.prepare('INSERT INTO courses (name, created_at, owner_id) VALUES (?1, ?2, ?3)')
    .bind(name, Math.floor(Date.now() / 1000), owner).run();

  return json({ ok: true, course: { id: ins.meta.last_row_id, name }, existing: false });
}

/**
 * PATCH -- rename, archive, restore. `{ id, name?, archived? }`
 *
 * Both fields are optional and both may arrive at once; whatever is present is
 * what changes. Renaming and archiving share an endpoint because they share
 * everything that matters: the same ownership check, the same row, and neither
 * one touches a single thing a student or parent ever signed.
 */
export async function onRequestPatch({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  const course = await ownedCourse(env, Number(body?.id), admin);
  // "No such class" rather than "not yours", the same as everywhere else here:
  // course ids should not be enumerable across a school.
  if (!course) return badRequest('No such class.');

  const sets = [];
  const binds = [];
  const set = (column, value) => { binds.push(value); sets.push(`${column} = ?${binds.length}`); };

  if (body?.name !== undefined) {
    const name = String(body.name).trim().slice(0, 120);
    if (!name) return badRequest('A class name is required.');
    // The same owner-scoped uniqueness POST leans on. Two classes with one name
    // is not merely untidy: POST resolves a name to a course to stay
    // idempotent, and a duplicate makes that lookup a coin toss over which one
    // the next roster import pours students into.
    const clash = await env.DB.prepare(
      'SELECT id FROM courses WHERE name = ?1 AND owner_id IS ?2 AND id <> ?3',
    ).bind(name, ownerFilter(admin), course.id).first();
    if (clash) return badRequest(`You already have a class called "${name}".`);
    set('name', name);
  }

  if (body?.archived !== undefined) {
    // A timestamp going in, NULL coming back out. Restoring drops the date
    // rather than keeping it beside a flag -- there is one fact here ("is this
    // put away, and since when"), so there is one column holding it.
    set('archived_at', body.archived ? Math.floor(Date.now() / 1000) : null);
  }

  if (!sets.length) return badRequest('Nothing to change.');

  binds.push(course.id);
  await env.DB.prepare(`UPDATE courses SET ${sets.join(', ')} WHERE id = ?${binds.length}`)
    .bind(...binds).run();

  const after = await env.DB.prepare('SELECT id, name, archived_at FROM courses WHERE id = ?1')
    .bind(course.id).first();
  return json({ ok: true, course: after });
}

/**
 * DELETE -- destroy a class and everything beneath it. `{ id, confirm_name }`
 *
 * `confirm_name` must match the class name. Not decoration: the rows this takes
 * with it include signatures, which the schema's own header calls the entire
 * audit story, and which nothing in this application is otherwise permitted to
 * delete. A dialog you dismiss by reflex is not a guard; typing the name is the
 * cheapest thing that requires having read what is about to happen.
 *
 * Matched case-insensitively and trimmed. The guard is against a stray click,
 * not against a teacher who capitalised their own class differently -- and a
 * guard that rejects the right answer teaches people to distrust it.
 */
export async function onRequestDelete({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  const course = await ownedCourse(env, Number(body?.id), admin);
  if (!course) return badRequest('No such class.');

  const typed = String(body?.confirm_name ?? '').trim().toLowerCase();
  if (typed !== String(course.name).trim().toLowerCase()) {
    return badRequest(`Type the class name exactly -- "${course.name}" -- to delete it.`);
  }

  // Counted before the delete, and returned after it, so the confirmation the
  // teacher reads afterwards is what actually went rather than what the page
  // happened to be showing when they clicked.
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM roster WHERE course_id = ?1) AS students,
            (SELECT COUNT(*) FROM signatures s
               JOIN accounts a ON a.id = s.account_id
               JOIN roster   r ON r.id = a.roster_id
              WHERE r.course_id = ?1)                          AS signatures`,
  ).bind(course.id).first();

  // One statement. Every child hangs off this row by ON DELETE CASCADE --
  // roster, accounts, signatures down one side; syllabi, versions, blocks down
  // the other -- so hand-deleting them in order would only be a second, weaker
  // copy of a rule the schema already states.
  await env.DB.prepare('DELETE FROM courses WHERE id = ?1').bind(course.id).run();

  return json({ ok: true, deleted: { name: course.name, ...counts } });
}
