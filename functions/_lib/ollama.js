// Talking to Ollama, once, for both authoring-time endpoints.
//
// The security rule these endpoints keep does not change here: a model's words
// never become syllabus text. It only ever returns indices and tags, and each
// endpoint whitelists those itself. This file moves the transport, not the
// trust boundary -- `finish` is the endpoint's own whitelist and stays there.
//
// Streaming exists for one reason: a cold hosted model can take most of a
// minute, and a button that sits disabled for 50 seconds is indistinguishable
// from a broken one. Watching the model think is the difference between waiting
// and wondering.

export const MODEL = 'gpt-oss:120b';
export const TIMEOUT_MS = 60_000;

/** Ollama's own OLLAMA_HOST convention allows a bare `host:port`, which is not a
 *  URL -- fetch() rejects it outright. Add the scheme when it is missing. */
export function ollamaBase(env) {
  const raw = String(env.OLLAMA_HOST || 'https://ollama.com').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}

const body = (env, content, stream) => JSON.stringify({
  model: env.OLLAMA_MODEL || MODEL,
  stream,
  format: 'json',
  options: { temperature: 0 },
  messages: [{ role: 'user', content }],
});

const headers = (env) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${env.OLLAMA_API_KEY}`,
});

/** One request, one answer. Returns the assistant's raw text, or throws. */
export async function chat(env, content) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const res = await fetch(`${ollamaBase(env)}/api/chat`, {
    method: 'POST', signal: controller.signal, headers: headers(env), body: body(env, content, false),
  }).finally(() => clearTimeout(timer));
  if (!res.ok) throw Object.assign(new Error(`Ollama returned ${res.status}.`), { status: res.status });
  return (await res.json())?.message?.content ?? '';
}

/**
 * The same request, reported as it happens.
 *
 * Emits newline-delimited JSON, one object per line:
 *
 *   {"type":"open","model":"..."}          once, before the model speaks
 *   {"type":"think","text":"..."}          reasoning, if the model exposes any
 *   {"type":"token","text":"..."}          the answer, in pieces
 *   {"type":"done", ...}                   exactly one, always, last
 *
 * The `done` line is whatever `finish(text)` returns -- the endpoint's own
 * whitelist applied to the accumulated answer. Nothing before it is allowed to
 * change a document; those lines exist to be looked at and thrown away.
 *
 * NDJSON rather than server-sent events: the client is a fetch() reader either
 * way, and SSE would add a framing format for a stream that is already one
 * object per line.
 */
export function streamChat(env, content, finish) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (obj) => writer.write(encoder.encode(JSON.stringify(obj) + '\n'));

  // Deliberately not awaited: the Response has to be returned while this runs,
  // or nothing streams and the whole point is lost.
  (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let answer = '';
    try {
      const res = await fetch(`${ollamaBase(env)}/api/chat`, {
        method: 'POST', signal: controller.signal, headers: headers(env), body: body(env, content, true),
      });
      if (!res.ok) throw Object.assign(new Error(`Ollama returned ${res.status}.`), { status: res.status });

      await send({ type: 'open', model: env.OLLAMA_MODEL || MODEL });

      // Ollama streams one JSON object per line, but a chunk boundary can fall
      // anywhere -- including mid-line. `carry` holds the incomplete tail.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let carry = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        carry += decoder.decode(value, { stream: true });
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }   // a keepalive, or noise
          const piece = obj?.message?.content ?? '';
          const thought = obj?.message?.thinking ?? '';
          if (thought) await send({ type: 'think', text: thought });
          if (piece) { answer += piece; await send({ type: 'token', text: piece }); }
        }
      }
      await send({ type: 'done', ...finish(answer) });
    } catch (err) {
      await send({ type: 'done', ...failure(err) });
    } finally {
      clearTimeout(timer);
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // Without this an intermediary can hold the whole body to buffer it, and
      // the stream arrives all at once at the end -- which looks exactly like
      // no streaming at all.
      'X-Accel-Buffering': 'no',
    },
  });
}

/** The shape both endpoints report a failure in. Never throws past here: a
 *  stream that ends without a `done` line leaves the page spinning forever. */
export function failure(err) {
  if (err?.name === 'AbortError') {
    return {
      available: false,
      reason: `Ollama did not respond within ${TIMEOUT_MS / 1000}s — the model may be cold. Try again, or do it by hand.`,
    };
  }
  // A refusal from Ollama and an unreachable host are different problems with
  // different fixes -- a wrong error message here once sent me hunting a
  // network fault while the model was answering 401 all along.
  if (err?.status) return { available: false, reason: err.message };
  return { available: false, reason: `Could not reach Ollama: ${String(err?.message || err).slice(0, 120)}` };
}
