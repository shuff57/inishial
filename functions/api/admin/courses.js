// POST /api/admin/courses   -- create a class with no roster  (Access gated)
//
// The roster import creates courses as a side effect of the first upload, which
// is right when the SIS export is in hand and wrong when it is not. A syllabus
// is worth writing in August; the roster does not settle until September, and
// until now the only way to get a class to write against was to invent a CSV.
//
// Listing lives in roster.js alongside the counts it reports. This file only
// makes them.

import { json, badRequest, unauthorized, serverMisconfigured, requireAdmin, ownerFilter, readJson } from '../../_lib/http.js';

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
