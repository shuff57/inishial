// GET /api/admin/schools/search -- Nominatim-backed "not listed?" lookup.
//
// Public (no session), rate-limited, and a proxy that filters Nominatim's
// results down to real schools in the Chico region. The point of the endpoint
// is joining a seed-list row when OSM and the district disagree on a name, so a
// teacher who picks an OSM result never mints a duplicate school. It lives
// under /api/admin/ only because its two callers are teacher-facing pages, NOT
// because it requires a session -- the primary caller is a teacher who is on
// the signup page because they have no account yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, ADMIN_HEADERS } from './helpers.mjs';
import { onRequestGet as search } from '../functions/api/admin/schools-search.js';

/** Stub global fetch to answer the Nominatim call the endpoint makes. */
function fakeNominatim(results) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(results), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  return () => { globalThis.fetch = original; };
}

const req = (env, q, headers = ADMIN_HEADERS) => search({
  request: new Request(`https://x/api/admin/schools/search?q=${encodeURIComponent(q)}`, { headers }),
  env,
});

// jsonv2 shapes. Nominatim's `jsonv2` gives a school back as
// `{ category: 'amenity', type: 'school' }` -- a park as
// `{ category: 'leisure', type: 'park' }`. There is no `class` field. These
// mirror the real response shape, so a filter that passes them passes real data.
const OSM_SEED_OVERLAP = {
  category: 'amenity', type: 'school',
  display_name: 'Chico Senior High School, Legion Avenue, Chico, Butte County, California, United States',
};
// A real secondary school NOT on the seed list.
const OSM_NEW_SCHOOL = {
  category: 'amenity', type: 'school',
  display_name: 'Sacred Heart School, Park Avenue, Red Bluff, Tehama County, California, United States',
};
const OSM_PARK = { category: 'leisure', type: 'park', display_name: 'Bidwell Park, Chico, Butte County, California, United States' };

test('works without a session — sign-up has no account to gate on', async () => {
  const env = freshEnv();
  // The endpoint must be reachable by a teacher who has not signed up yet; the
  // previous requireAdmin gate made it 401 from the exact form it exists for.
  const restore = fakeNominatim([OSM_NEW_SCHOOL]);
  try {
    const res = await req(env, 'Red Bluff', {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.schools[0].name, 'Sacred Heart School');
  } finally { restore(); }
});

test('blank or missing q is a 400', async () => {
  const env = freshEnv();
  const res = await search({ request: new Request('https://x/api/admin/schools/search?q=', { headers: ADMIN_HEADERS }), env });
  assert.equal(res.status, 400);
});

test('filters Nominatim results to schools only', async () => {
  const env = freshEnv();
  const restore = fakeNominatim([OSM_SEED_OVERLAP, OSM_PARK, OSM_NEW_SCHOOL]);
  try {
    const body = await (await req(env, 'school')).json();
    assert.deepEqual(body.schools.map((s) => s.name).sort(),
      ['Chico High School', 'Sacred Heart School']);
  } finally { restore(); }
});

test('an overlapping seed-list row is joined, not duplicated', async () => {
  const env = freshEnv();
  // Migration 0011 already seeds "Chico High School".
  const restore = fakeNominatim([OSM_SEED_OVERLAP]);
  try {
    const body = await (await req(env, 'Chico')).json();
    assert.equal(body.schools.length, 1);
    assert.equal(body.schools[0].name, 'Chico High School',
      'the OSM spelling is corrected to the seeded row so the sign-up joins it');
    assert.ok(body.schools[0].existing_id, 'carries the seeded row id');
  } finally { restore(); }
});

test('a genuinely new school comes through under its OSM name, with no existing_id', async () => {
  const env = freshEnv();
  const restore = fakeNominatim([OSM_NEW_SCHOOL]);
  try {
    const body = await (await req(env, 'Red Bluff')).json();
    assert.equal(body.schools[0].name, 'Sacred Heart School');
    assert.equal(body.schools[0].existing_id, null);
  } finally { restore(); }
});

test('duplicate result names collapse to one row', async () => {
  const env = freshEnv();
  const restore = fakeNominatim([OSM_SEED_OVERLAP, OSM_SEED_OVERLAP]);
  try {
    const body = await (await req(env, 'Chico')).json();
    assert.equal(body.schools.length, 1);
  } finally { restore(); }
});

test('carries the OSM attribution for display', async () => {
  const env = freshEnv();
  const restore = fakeNominatim([OSM_NEW_SCHOOL]);
  try {
    const body = await (await req(env, 'Red Bluff')).json();
    assert.match(body.attribution, /OpenStreetMap/);
  } finally { restore(); }
});

test('Nominatim being down is an honest 502, not a crash', async () => {
  const env = freshEnv();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const res = await req(env, 'Chico');
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /school search is unavailable/i);
  } finally { globalThis.fetch = original; }
});

test('rate limits per IP', async () => {
  const env = freshEnv();
  const restore = fakeNominatim([OSM_NEW_SCHOOL]);
  try {
    let status = 200;
    for (let i = 0; i < 61; i++) status = (await req(env, 'Red Bluff')).status;
    assert.equal(status, 429);
  } finally { restore(); }
});
