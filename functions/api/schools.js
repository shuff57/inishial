// GET /api/schools?q=   -- type-ahead lookup, public and unauthenticated
//
// Deliberately open: it serves both the public register/request-code forms
// and teacher signup, neither of which has a session yet to gate behind.
// School names are not secret, so revealing which schools are on an install
// is an accepted trade for a form that can disambiguate them.
//
// `q` missing or blank returns every school -- migrations/0011 seeds a Chico-
// area reference list, so this can be dozens of rows even before any teacher
// has signed up. Substring match, and case-insensitive for free: SQLite's
// LIKE only folds case on ASCII, which is exactly the alphabet school names
// are typed in.
//
// `required` tells the public register/request-code forms whether to show
// the field at all -- it mirrors schoolScope.js's own "schools in use"
// threshold (teachers actually assigned), not the size of the reference
// list, so a solo-teacher install stays a no-op even with 50 seeded rows
// nobody has picked yet.
import { json, serverMisconfigured } from '../_lib/http.js';
import { schoolsInUseCount } from '../_lib/schoolScope.js';

export async function onRequestGet({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');

  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  const { results } = q
    ? await env.DB.prepare('SELECT id, name FROM schools WHERE name LIKE ?1 ORDER BY name')
        .bind(`%${q}%`).all()
    : await env.DB.prepare('SELECT id, name FROM schools ORDER BY name').all();

  const required = (await schoolsInUseCount(env.DB)) > 1;
  return json({ schools: results ?? [], required });
}
