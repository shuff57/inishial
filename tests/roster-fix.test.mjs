// The AI fallback for a roster paste the deterministic parser can't read.
//
// Same three rules as api/admin/structure.js and api/admin/suggest.js:
//   - It never returns data that gets stored. It returns a column MAP --
//     field name to index -- and a has_header guess, nothing else, so there
//     is no field a hallucinated student record could travel in.
//   - It fails soft. No key, no reachable host, bad JSON back -- all return
//     `available: false` and the caller falls back to today's plain error.
//   - It is only ever reached after the deterministic parseRoster() has
//     already thrown. Every test here that isn't specifically about that
//     boundary uses a paste that fails deterministic parsing on purpose.
//
// This is also the one place in the app that sends real student data to a
// third-party API, so the row cap, cell truncation, and no-logging rules get
// their own tests rather than being assumed from the source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, ADMIN_HEADERS } from './helpers.mjs';
import { onRequestPost as rosterFix } from '../functions/api/admin/roster-fix.js';

// No header row, and nothing in it that looks like one -- parseRoster()
// throws "No student ID column found" on this, which is exactly the case
// this endpoint exists for.
const HEADERLESS = '904511,Alvarez,3\n904512,Chen,4\n904513,Ray,3\n904514,Lee,5\n904515,Cruz,1\n';

function post(env, text, { headers = ADMIN_HEADERS, qs = '' } = {}) {
  return rosterFix({
    request: new Request(`https://x/api/admin/roster-fix${qs}`, { method: 'POST', headers, body: text }),
    env,
  });
}

test('the endpoint refuses a request without admin', async () => {
  const env = freshEnv();
  const res = await post(env, HEADERLESS, { headers: {} });
  assert.equal(res.status, 401);
});

test('is a no-op when the paste already parses, and never calls the model', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test' });
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('the happy path must never reach the model'); };

  const res = await post(env, 'Student ID,Last Name,First Name\n1,Lee,Ann\n');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.available, true);
  assert.equal(body.needed, false);
  assert.equal(called, false);
});

test('with no key it fails soft, so the caller still has today\'s plain error to fall back to', async () => {
  const env = freshEnv();
  const body = await (await post(env, HEADERLESS)).json();
  assert.equal(body.available, false);
  assert.match(body.reason, /OLLAMA_API_KEY/);
  assert.deepEqual(body.columns, {});
});

test('whitelists the mapping: only real field names and in-range indices survive', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test' });
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: JSON.stringify({
      has_header: false,
      columns: {
        student_ext_id: 0,
        last: 1,
        period: 2,
        not_a_real_field: 0,   // bogus field name -- dropped
        course: 99,            // out of range for a 3-column row -- dropped
        parent_email: 1.5,     // not an integer -- dropped
        first: '1',            // numeric string -- coerces fine, kept
      },
    }) },
  }), { status: 200 });

  const body = await (await post(env, HEADERLESS)).json();
  assert.equal(body.available, true);
  assert.deepEqual(body.columns, { student_ext_id: 0, last: 1, period: 2, first: 1 });
  assert.equal(body.has_header, false);
});

test('a model that tries to smuggle extra keys has nowhere to put them', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test' });
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: JSON.stringify({
      has_header: true,
      columns: { student_ext_id: 0 },
      note: 'the student at row 1 is named Robert Doyle',   // never a real field
    }) },
  }), { status: 200 });

  const body = await (await post(env, HEADERLESS)).json();
  assert.deepEqual(Object.keys(body), ['available', 'model', 'has_header', 'columns']);
  assert.ok(!JSON.stringify(body).includes('Robert'), 'only index/tag-shaped data may reach the client');
});

test('an unreachable model fails soft rather than erroring', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test' });
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  const body = await (await post(env, HEADERLESS)).json();
  assert.equal(body.available, false);
  assert.deepEqual(body.columns, {});
});

test('garbage back from the model fails soft', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test' });
  globalThis.fetch = async () => new Response('not json at all', { status: 200 });
  const body = await (await post(env, HEADERLESS)).json();
  assert.equal(body.available, false);
});

test('sends at most row 0 plus 3 data rows, and truncates long cells to 60 chars', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test' });
  const longCell = 'x'.repeat(100);
  const text = [
    `904511,Alvarez,${longCell}`,
    '904512,Chen,3',
    '904513,Ray,3',
    '904514,Lee,3',
    '904515,Cruz,3',   // 5th data row -- must never reach the model
  ].join('\n');

  let sentContent = '';
  globalThis.fetch = async (url, opts) => {
    sentContent = JSON.parse(opts.body).messages[0].content;
    return new Response(JSON.stringify({
      message: { content: JSON.stringify({ has_header: false, columns: {} }) },
    }), { status: 200 });
  };
  await post(env, text);

  assert.ok(sentContent.includes('Row 0:'));
  assert.ok(sentContent.includes('Row 3:'));
  assert.ok(!sentContent.includes('Row 4:'), 'only row 0 plus up to 3 data rows may reach the model');
  assert.ok(!sentContent.includes('904515'), 'a row past the cap must never be sent, in any form');
  assert.ok(sentContent.includes(`${'x'.repeat(60)}…`), 'a long cell is truncated before it leaves the server');
  assert.ok(!sentContent.includes('x'.repeat(61)), 'the untruncated cell must never be sent');
});

test('never logs the pasted text or the model reply', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test' });
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: JSON.stringify({ has_header: false, columns: { student_ext_id: 0 } }) },
  }), { status: 200 });

  const calls = [];
  const realLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    await post(env, HEADERLESS);
  } finally {
    console.log = realLog;
  }
  assert.equal(calls.length, 0, 'nothing about the paste or the model answer may be logged');
});

test('an invalid model name in the query is ignored, falling back to the configured default', async () => {
  const env = freshEnv({ OLLAMA_API_KEY: 'test', OLLAMA_MODEL: 'safe-default' });
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: JSON.stringify({ has_header: false, columns: {} }) },
  }), { status: 200 });

  const body = await (await post(env, HEADERLESS, { qs: `?model=${encodeURIComponent('; rm -rf /')}` })).json();
  assert.equal(body.model, 'safe-default');
});
