// GET /api/admin/schools/search?q=   -- find a real school outside the seed
//
// Public, unauthenticated -- same stance as GET /api/schools, and for the same
// reason: a school's name is not secret, and this endpoint only reads. It
// lives under /api/admin/ because its only two callers are teacher-facing
// pages (signup, the placeholder-rename banner), not because it requires a
// session. It CANNOT require one: the primary caller is a teacher who is on
// this page BECAUSE they do not have an account yet, so gating this behind
// requireAdmin made the endpoint permanently unreachable from the one form it
// exists for and it 401'd on every call from there. Only the banner rename
// (an already-signed-up teacher) ever had a session to satisfy.
//
// The public register/request-code forms are deliberately select-only (a
// student must not mint a school row) and never call this endpoint -- the
// teacher forms already create on an exact no-match, so this fills the one
// remaining gap: a teacher whose school is NOT in the seed list, who would
// otherwise have to invent the official name from memory and risk typing it
// wrong enough to mint a near-duplicate of a real school.
//
// It proxies OpenStreetMap's Nominatim for the Chico-region bounding box and
// returns the real school names, each annotated with whether it already exists
// on this install (matched by containment, not just equality -- Nominatim
// knows "Chico Senior High School", the seed knows "Chico High School", and
// the two should meet, not double up).
//
// This is a proxy, not a pass-through:
//   - filtered to real schools, so a search never returns a park or a store
//   - rate limited per IP, since Nominatim's public instance tolerates about
//     1 request per second and this is a typing-ahead endpoint
//   - bounded to California. The seed list only covers Chico and the
//     surrounding counties, so a teacher whose school is genuinely elsewhere
//     (Sacramento, the Bay Area, ...) would otherwise have to invent the
//     official name from memory -- the viewbox is deliberately state-wide so
//     the search finds the real school by name wherever it is.
//
// Data is from OpenStreetMap, © OpenStreetMap contributors, ODbL. The response
// carries an `attribution` field the UI shows where the results are displayed.
//
// Failure is honest and never blocks sign-up: on a Nominatim error this returns
// { error } with 502, and the admin signup page falls back to plain free text
// (which the server has always accepted).

import { json, badRequest, serverMisconfigured } from '../../../_lib/http.js';
import { hit, clientIp } from '../../../_lib/ratelimit.js';

// Nominatim's public instance. 1 req/sec sustained, 30/min bursts -- the rate
// limit below is set well under that so a whole hall of teachers signing up at
// once cannot get us (or Nominatim) throttled.
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// California. The seed list is Chico-region, but a teacher is not -- a school
// in Sacramento or the Bay Area is as real as one in Butte County, and the
// search should find it by name rather than sending the teacher to free text.
// 33.0..42.5 lat is California's footprint plus a little margin.
const VIEWBOX = '-124.4,42.5,-114.0,33.0';
const ATTRIBUTION = 'Data © OpenStreetMap contributors (ODbL)';

// Nominatim returns one name with several spellings; the seed list uses the
// district's own. Word-bag subset: if every word of one name appears in the
// other, they are the same school ("Chico Senior High School" matches the
// seeded "Chico High School"). Grade qualifiers are what differ, and the seed
// never holds both a plain and a qualified variant of one school -- the
// nearest pairs ("Corning High School" / "Corning Middle School") are not
// subsets of each other, so they stay distinct.
const overlaps = (a, b) => {
  const words = (s) => new Set(String(s).toLowerCase().replace(/\./g, '').trim().split(/\s+/).filter(Boolean));
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  const smaller = x.size <= y.size ? x : y;
  const larger = x.size <= y.size ? y : x;
  for (const w of smaller) if (!larger.has(w)) return false;
  return true;
};

export async function onRequestGet({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');

  const q = new URL(request.url).searchParams.get('q')?.trim();
  if (!q) return badRequest('Type a school name to search for.');
  if (q.length > 120) return badRequest('That search is too long.');

  const nowSec = Math.floor(Date.now() / 1000);
  const limit = await hit(env.DB, `schsearch:ip:${clientIp(request)}`, nowSec, { max: 60, windowSec: 15 * 60 });
  if (!limit.allowed) {
    return json({ error: 'Too many searches. Try again in a few minutes.' }, 429, {
      'Retry-After': String(limit.retryAfter),
    });
  }

  // TWO passes, because one query cannot serve both ways people search.
  //
  // Nominatim's free text finds a school when the text resolves to one, so
  // "Luther Burbank High School" works. A PLACE does not: "Sacramento" resolves
  // to the city, which the amenity filter below then correctly discards, and
  // the teacher is told nothing was found in the very region they teach in.
  // That is how this read to anyone whose school is not in the Chico seed --
  // it worked only if you already knew and typed the school's full official
  // name, which is the thing the search exists to save you from.
  //
  // Adding the word "school" is what turns a place into a school query, and it
  // is Nominatim's own free-text ranking doing the work rather than a second
  // API shape. Measured against the live service:
  //
  //   "Sacramento"        -> 0   |  "Sacramento school"  -> 6
  //   "Elk Grove"         -> 0   |  "Elk Grove school"   -> 4
  //   "sacramento high"   -> 0   |  + " school"          -> Sacramento High
  //
  // Structured search (amenity=school&city=...) was tried first and is not
  // dependable: city=Elk Grove returns four schools, city=Sacramento returns
  // nothing, because it matches administrative boundaries rather than the name
  // people type.
  //
  // The second pass runs ONLY when the first found nothing, so an exact name
  // still costs one request. Skipped when the text already says "school",
  // which would otherwise ask for "... school school".
  const attempts = [q];
  if (!/\bschools?\b/i.test(q)) attempts.push(`${q} school`);

  let results = null;
  for (const attempt of attempts) {
    const found = await askNominatim(attempt);
    if (found === null) {
      return json({ error: 'The school search is unavailable right now. Type the school name instead and it will be created.' }, 502);
    }
    results = found;
    if (found.some((r) => r.type === 'school')) break;
  }

  // The seeded schools, once, for the containment match below.
  const seeded = await env.DB.prepare('SELECT id, name FROM schools').all();

  const schools = (results ?? [])
    // jsonv2 names these `category`/`type`, not `class` -- a school comes back
    // as { category: 'amenity', type: 'school' }, a park as
    // { category: 'leisure', type: 'park' }. Filtering on `class` matched
    // nothing and returned every query empty; this is the filter that works
    // against the real response shape.
    .filter((r) => r.type === 'school' && r.display_name)
    .map((r) => {
      // "Chico Senior High School, Legion Avenue, Chico, ..." -> the first
      // comma segment is the school's name.
      const name = String(r.display_name).split(',')[0].trim();
      // Prefer an existing seeded/created row the search result overlaps, so
      // picking an OSM result joins rather than duplicates.
      const existing = (seeded.results ?? []).find((s) => overlaps(s.name, name));
      return {
        name: existing ? existing.name : name,
        existing_id: existing ? existing.id : null,
        district: String(r.display_name).split(',').slice(2).find((p) => /county|district/i.test(p))?.trim() ?? '',
        place: String(r.display_name).split(',').slice(1, 3).join(',').trim(),
      };
    })
    // Dedupe by name, keeping the first (which is also the one joined to an
    // existing row when that happened).
    .filter((s, i, arr) => arr.findIndex((x) => x.name === s.name) === i);

  return json({ schools, attribution: ATTRIBUTION });
}

/**
 * One Nominatim query. Returns the raw result array, or null when the service
 * could not be reached -- null rather than [] so the caller can tell "nothing
 * matched" from "the search is down" and say the honest thing about each.
 *
 * Nominatim asks for an identifying User-Agent. This install's name is fine;
 * the request is outbound from Cloudflare, so the worker itself is the client.
 */
async function askNominatim(q) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    q,
    limit: '6',
    viewbox: VIEWBOX,
    bounded: '1',
    'accept-language': 'en',
  });
  let res;
  try {
    res = await fetch(`${NOMINATIM}?${params}`, {
      headers: { 'User-Agent': 'inishial-school-search/1.0 (syllabus app)' },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}
