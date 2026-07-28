// Streaming the model's work to the editor.
//
// The framing is the part that breaks: Ollama sends one JSON object per line,
// but a network chunk boundary can fall anywhere, including the middle of a
// line. Reassembling that wrongly drops decisions silently -- the retag list
// comes back short and nothing says why.
//
// The other invariant here is the one that matters for trust: a `done` line is
// emitted on EVERY path, including a refusal and a timeout. A stream that ends
// without one leaves the editor spinning until the teacher reloads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, failure } from '../functions/_lib/ollama.js';

const env = { OLLAMA_API_KEY: 'test-key', OLLAMA_HOST: 'https://ollama.test', OLLAMA_MODEL: 'test-model' };

/** Stand in for Ollama, handing back `chunks` exactly as written. */
function fakeOllama(chunks, { ok = true, status = 200 } = {}) {
  return () => Promise.resolve({
    ok,
    status,
    body: new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
  });
}

/** Read a streamed NDJSON response back into an array of events. */
async function events(response) {
  const text = await new Response(response.body).text();
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const line = (obj) => JSON.stringify(obj) + '\n';
const say = (content) => line({ message: { content } });

test('tokens arrive as separate events and accumulate into one answer', async () => {
  globalThis.fetch = fakeOllama([say('{"retag":'), say('[1,2]}')]);
  const got = [];
  const res = streamChat(env, 'prompt', (text) => { got.push(text); return { available: true }; });
  const ev = await events(res);

  assert.equal(ev[0].type, 'open');
  assert.deepEqual(ev.filter((e) => e.type === 'token').map((e) => e.text), ['{"retag":', '[1,2]}']);
  assert.equal(got[0], '{"retag":[1,2]}', 'finish() sees the whole answer, not the last piece');
});

test('a chunk boundary in the middle of a line loses nothing', async () => {
  // The failure this exists for. Split one JSON line across two network chunks
  // and across a third that also carries the start of the next.
  const whole = say('alpha') + say('beta') + say('gamma');
  const cut1 = Math.floor(whole.length * 0.37);
  const cut2 = Math.floor(whole.length * 0.71);
  globalThis.fetch = fakeOllama([whole.slice(0, cut1), whole.slice(cut1, cut2), whole.slice(cut2)]);

  let answer = null;
  const ev = await events(streamChat(env, 'p', (t) => { answer = t; return { available: true }; }));
  assert.deepEqual(ev.filter((e) => e.type === 'token').map((e) => e.text), ['alpha', 'beta', 'gamma']);
  assert.equal(answer, 'alphabetagamma');
});

test('a line split character by character still reassembles', async () => {
  const whole = say('x') + say('y');
  globalThis.fetch = fakeOllama([...whole]);
  let answer = null;
  await events(streamChat(env, 'p', (t) => { answer = t; return { available: true }; }));
  assert.equal(answer, 'xy');
});

test('reasoning is reported separately from the answer', async () => {
  // It must never reach `finish` -- the model thinking aloud is not its answer,
  // and folding the two together would feed prose into a JSON parse.
  globalThis.fetch = fakeOllama([line({ message: { thinking: 'let me see' } }), say('{}')]);
  let answer = null;
  const ev = await events(streamChat(env, 'p', (t) => { answer = t; return { available: true }; }));
  assert.deepEqual(ev.filter((e) => e.type === 'think').map((e) => e.text), ['let me see']);
  assert.equal(answer, '{}', 'thinking is shown, never accumulated');
});

test('the whitelist result is what the done line carries', async () => {
  globalThis.fetch = fakeOllama([say('anything at all')]);
  const ev = await events(streamChat(env, 'p', () => ({ available: true, retag: [{ index: 3, tag: 'heading' }] })));
  const done = ev.at(-1);
  assert.equal(done.type, 'done');
  assert.deepEqual(done.retag, [{ index: 3, tag: 'heading' }]);
});

test('exactly one done line, and it is last', async () => {
  globalThis.fetch = fakeOllama([say('a'), say('b')]);
  const ev = await events(streamChat(env, 'p', () => ({ available: true })));
  assert.equal(ev.filter((e) => e.type === 'done').length, 1);
  assert.equal(ev.at(-1).type, 'done');
});

test('a refusal from Ollama still ends with a done line', async () => {
  globalThis.fetch = fakeOllama([], { ok: false, status: 401 });
  const ev = await events(streamChat(env, 'p', () => ({ available: true })));
  const done = ev.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.available, false);
  assert.match(done.reason, /401/, 'the status is the whole diagnosis; do not bury it');
});

test('an unreachable host still ends with a done line', async () => {
  globalThis.fetch = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
  const ev = await events(streamChat(env, 'p', () => ({ available: true })));
  assert.equal(ev.at(-1).type, 'done');
  assert.equal(ev.at(-1).available, false);
});

test('a keepalive or half-written line is skipped, not fatal', async () => {
  globalThis.fetch = fakeOllama(['\n', 'not json at all\n', say('ok')]);
  let answer = null;
  const ev = await events(streamChat(env, 'p', (t) => { answer = t; return { available: true }; }));
  assert.equal(answer, 'ok');
  assert.equal(ev.at(-1).type, 'done');
});

test('a timeout is reported as a timeout, not as a network fault', () => {
  const reported = failure(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal(reported.available, false);
  assert.match(reported.reason, /did not respond within 60s/);
  assert.match(reported.reason, /cold/, 'name the likely cause, so the fix is "try again"');
});

test('an HTTP status is reported verbatim rather than as unreachable', () => {
  assert.equal(failure(Object.assign(new Error('Ollama returned 503.'), { status: 503 })).reason,
    'Ollama returned 503.');
  assert.match(failure(new Error('socket hang up')).reason, /Could not reach Ollama/);
});
