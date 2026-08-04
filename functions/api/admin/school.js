// GET   /api/admin/school  -- the signed-in teacher's school, and whether
//                              it is still the placeholder migration seeded
// PATCH /api/admin/school  -- set it, by name   { name }
//
// Every teacher row now carries a school_id (see migrations/0009), but for
// everyone who existed before that migration -- and every new signup, until
// the next ticket has them choose one -- it points at the placeholder row.
// See migrations/0009's comment for why its id is always 1. Until a teacher
// moves off it, school-scoping is a no-op for their account: this is the
// admin-side nudge to do that, not a schools-management page. There is
// deliberately no way here to list, merge or delete schools.
//
// PATCH does NOT rename the row in place -- that row may be the shared
// placeholder, still holding every other teacher who hasn't moved off it
// either, and an UPDATE would relabel their school out from under them too.
// Instead it's the same find-or-create the plan specifies for how a school
// gets named everywhere else (GET /api/schools is the type-ahead source for
// it): an exact match on an existing row joins it -- the ordinary case for a
// second teacher at a school someone already named -- and only an exact
// no-match creates a new one. Either way, only THIS teacher's own pointer
// moves.
//
// Only a teacher who signed up (admin.teacherId set) has a school row to
// show. The shared password and a bare Cloudflare Access identity are not
// tied to any one teacher, so there is nothing here for them to rename.

import { json, badRequest, unauthorized, serverMisconfigured, requireAdmin, readJson } from '../../_lib/http.js';

// The migration's placeholder is the first row `schools` will ever hold, so
// its id is always 1. "Still the placeholder" means this teacher has not yet
// moved off that shared row -- not that the row still carries its original
// name, since a colleague could rename it out from under an old check without
// this teacher having done anything.
const PLACEHOLDER_ID = 1;

export async function onRequestGet({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  if (admin.teacherId == null) return json({ school: null });

  const school = await env.DB.prepare(
    `SELECT s.id, s.name FROM teachers t JOIN schools s ON s.id = t.school_id WHERE t.id = ?1`,
  ).bind(admin.teacherId).first();

  return json({ school, is_placeholder: school?.id === PLACEHOLDER_ID });
}

export async function onRequestPatch({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');
  if (admin.teacherId == null) return badRequest('No teacher account to set a school for.');

  const body = await readJson(request);
  const name = String(body?.name ?? '').trim().slice(0, 120);
  if (!name) return badRequest('A school name is required.');

  // COLLATE NOCASE so "southside high" joins an existing "Southside High"
  // rather than minting a case-variant duplicate -- the same failure the
  // plan calls out for wording ("Chico High" vs "Chico High School"), just
  // triggered by case instead. Matches GET /api/schools?q=, whose LIKE is
  // already case-insensitive for ASCII. A match keeps the row's original
  // casing rather than renaming it to what this teacher typed.
  const findExisting = () => env.DB.prepare('SELECT id, name FROM schools WHERE name = ?1 COLLATE NOCASE').bind(name).first();
  let school = await findExisting();
  if (!school) {
    // The UNIQUE index decides on a race, the same as signup.js's account
    // creation: two teachers typing the same brand-new school name at once
    // would otherwise both pass a check-then-insert.
    try {
      const ins = await env.DB.prepare('INSERT INTO schools (name) VALUES (?1)').bind(name).run();
      school = { id: ins.meta.last_row_id, name };
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err?.message))) throw err;
      school = await findExisting();
    }
  }

  await env.DB.prepare('UPDATE teachers SET school_id = ?1 WHERE id = ?2').bind(school.id, admin.teacherId).run();

  return json({ ok: true, school });
}
