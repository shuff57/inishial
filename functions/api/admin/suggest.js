// POST /api/admin/suggest   -- ask Ollama which sections deserve initials
//
// Optional by design. The import path works entirely without it: Mammoth emits
// clean semantic HTML and the browser splits it into blocks deterministically.
// The model is only ever asked for an opinion, and only about which sections a
// parent should have to initial.
//
// Three rules this endpoint keeps:
//   - It never rewrites text. It returns indices and reasons, nothing else, so
//     there is no path by which a model edits a policy a parent will sign.
//   - It fails soft. No key, no reachable host, bad JSON back -- all return
//     `available: false` and the editor carries on.
//   - It is authoring-time only. No parent or student request reaches a model.

import { json, badRequest, unauthorized, serverMisconfigured, requireAdmin, readJson } from '../../_lib/http.js';

const MODEL = 'gpt-oss:120b';
// A hosted model that has gone cold takes longer to answer the first request
// than any subsequent one, and 20s was landing inside that window -- the whole
// AI pass reported itself unavailable on the one request most likely to be a
// cold start. This is an authoring-time convenience with a working manual
// path behind it, so waiting is cheaper than failing.
const TIMEOUT_MS = 60_000;

const PROMPT = `You are helping a teacher prepare a course syllabus that parents must read and initial.

Below are the numbered sections of the syllabus. Identify the sections a parent should be required to INITIAL individually, because misunderstanding them causes real disputes later: grading and late work, attendance, academic honesty and AI use, behaviour and discipline, safety, required materials that cost money, and anything about contacting the teacher.

Do NOT select: welcome text, course descriptions, unit outlines, schedules, or headings.

Reply with ONLY a JSON object, no prose:
{"initial":[{"index":<number>,"reason":"<8 words or fewer>"}]}`;

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  if (!body || !Array.isArray(body.blocks)) return badRequest('blocks must be an array.');
  if (!env.OLLAMA_API_KEY) {
    return json({ available: false, reason: 'No OLLAMA_API_KEY is configured.', suggestions: [] });
  }

  // Only prose is worth judging, and long blocks are truncated -- the decision
  // needs the gist, not the whole policy.
  const candidates = body.blocks
    .map((b, i) => ({ i, type: b.type, text: stripHtml(b.html).slice(0, 400) }))
    .filter((b) => b.type === 'text' || b.type === 'list')
    .filter((b) => b.text.length > 40);

  if (!candidates.length) return json({ available: true, suggestions: [] });

  const listing = candidates.map((b) => `[${b.i}] ${b.text}`).join('\n\n');

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

    if (!res.ok) {
      return json({ available: false, reason: `Ollama returned ${res.status}.`, suggestions: [] });
    }

    const payload = await res.json();
    const parsed = JSON.parse(payload?.message?.content ?? '{}');
    const valid = new Set(candidates.map((c) => c.i));

    // Indices are validated against the blocks actually sent. A hallucinated
    // index is dropped rather than trusted.
    const suggestions = (Array.isArray(parsed.initial) ? parsed.initial : [])
      .map((s) => ({ index: Number(s?.index), reason: String(s?.reason ?? '').slice(0, 60) }))
      .filter((s) => valid.has(s.index));

    return json({ available: true, model: env.OLLAMA_MODEL || MODEL, suggestions });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return json({
      available: false,
      reason: aborted
        ? `Ollama did not respond within ${TIMEOUT_MS / 1000}s — the model may be cold. Try again, or tick the sections yourself.`
        : 'Could not reach Ollama.',
      suggestions: [],
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
