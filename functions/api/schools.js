// GET /api/schools?q=   -- type-ahead lookup, public and unauthenticated
//
// Deliberately open: it serves both the public register/request-code forms
// and teacher signup, neither of which has a session yet to gate behind.
// School names are not secret, so revealing which schools are on an install
// is an accepted trade for a form that can disambiguate them.
//
// `q` missing or blank returns every school -- there is no seed list, so on
// a small install this is a handful of rows, and the type-ahead needs a full
// list to show before anyone has typed anything. Substring match, and
// case-insensitive for free: SQLite's LIKE only folds case on ASCII, which is
// exactly the alphabet school names are typed in.
import { json, serverMisconfigured } from '../_lib/http.js';

export async function onRequestGet({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');

  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  const { results } = q
    ? await env.DB.prepare('SELECT id, name FROM schools WHERE name LIKE ?1 ORDER BY name')
        .bind(`%${q}%`).all()
    : await env.DB.prepare('SELECT id, name FROM schools ORDER BY name').all();

  return json({ schools: results ?? [] });
}
