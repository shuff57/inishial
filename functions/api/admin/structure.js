// POST /api/admin/structure   -- ask Ollama which blocks are really headings
//
// The problem this solves: plenty of teachers make a heading by BOLDING a line
// rather than using Word's heading styles. Mammoth faithfully emits that as
// <p><strong>Late Work</strong></p>, so the import files it as body text and the
// whole syllabus collapses into one section -- section-level dragging and
// section-level initials both stop working.
//
// A regex handles this badly. "Late Work" and "Instructor: Jane Okafor" are both
// short bold lines; only one is a heading.
//
// The same three rules as api/admin/suggest.js, for the same reason -- this text
// is what a parent legally initials:
//   - It never rewrites. It returns {index, tag} pairs, nothing else. There is
//     no field in the response a word could travel in, so no prompt injection
//     and no model slip can alter a policy.
//   - It fails soft. No key, no host, bad JSON -- `available: false` and the
//     editor carries on exactly as it does today.
//   - It is authoring-time only. No parent or student request reaches a model.

import { json, badRequest, unauthorized, serverMisconfigured, requireAdmin, readJson } from '../../_lib/http.js';

const MODEL = 'gpt-oss:120b';
const TIMEOUT_MS = 20_000;

// Only these two can be reinterpreted. A prompt, a list or a table is never
// silently retagged -- an `initial` block carries a signature obligation, and
// turning one into a heading would drop it from the document without a trace.
const RETAGGABLE = new Set(['text', 'heading']);

const PROMPT = `Below are the numbered lines of a course syllabus, in order.

Decide which lines are SECTION HEADINGS (a short title introducing the material that follows, e.g. "Late Work", "Grading Policy", "Attendance") and which are BODY TEXT (sentences, policies, lists, contact details, labelled fields such as "Email: someone@school.edu").

A short bold line is not automatically a heading. A labelled field like "Instructor: Jane Doe" is body text. A heading introduces what comes after it.

Reply with ONLY a JSON object, no prose. Include a line only if its tag should CHANGE:
{"retag":[{"index":<number>,"tag":"heading"|"text"}]}`;

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  if (!body || !Array.isArray(body.blocks)) return badRequest('blocks must be an array.');
  if (!env.OLLAMA_API_KEY) {
    return json({ available: false, reason: 'No OLLAMA_API_KEY is configured.', retag: [] });
  }

  const candidates = body.blocks
    .map((b, i) => ({ i, type: b?.type, text: stripHtml(b?.html).slice(0, 200) }))
    .filter((b) => RETAGGABLE.has(b.type) && b.text.length > 0);

  if (!candidates.length) return json({ available: true, retag: [] });

  const listing = candidates.map((b) => `[${b.i}] (${b.type}) ${b.text}`).join('\n');

  // Two try blocks, not one. Folding them together reported every failure as
  // "could not reach Ollama", which sent me hunting a network problem when the
  // model had in fact answered fine -- a wrong error message costs more time
  // than no error message.
  let payload;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`${ollamaBase(env)}/api/chat`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OLLAMA_API_KEY}` },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL || MODEL,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [{ role: 'user', content: `${PROMPT}\n\n${listing}` }],
      }),
    }).finally(() => clearTimeout(timer));

    if (!res.ok) return json({ available: false, reason: `Ollama returned ${res.status}.`, retag: [] });
    payload = await res.json();
  } catch (err) {
    return json({
      available: false,
      reason: err?.name === 'AbortError'
        ? `Ollama did not respond within ${TIMEOUT_MS / 1000}s.`
        : `Could not reach Ollama: ${String(err?.message || err).slice(0, 120)}`,
      retag: [],
    });
  }

  try {
    const parsed = JSON.parse(payload?.message?.content ?? '{}');

    // Everything below is a whitelist, not a parse: an index must be one we
    // actually sent, a tag must be one of two literals, and the change must be
    // a real change. Anything else the model returns is dropped on the floor.
    const byIndex = new Map(candidates.map((c) => [c.i, c.type]));
    const seen = new Set();
    const retag = (Array.isArray(parsed.retag) ? parsed.retag : [])
      .map((r) => ({ index: Number(r?.index), tag: String(r?.tag ?? '') }))
      .filter((r) => Number.isInteger(r.index) && byIndex.has(r.index))
      .filter((r) => RETAGGABLE.has(r.tag))
      .filter((r) => r.tag !== byIndex.get(r.index))
      .filter((r) => (seen.has(r.index) ? false : seen.add(r.index)));

    return json({ available: true, model: env.OLLAMA_MODEL || MODEL, retag });
  } catch (err) {
    return json({
      available: false,
      reason: `Ollama replied with something unreadable: ${String(err?.message || err).slice(0, 120)}`,
      retag: [],
    });
  }
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ollama's own OLLAMA_HOST convention allows a bare `host:port`, which is not a
 *  URL -- fetch() rejects it outright. Add the scheme when it is missing. */
function ollamaBase(env) {
  const raw = String(env.OLLAMA_HOST || 'https://ollama.com').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
}
