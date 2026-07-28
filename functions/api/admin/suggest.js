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
import { MODEL, chat, streamChat, failure } from '../../_lib/ollama.js';

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

  // The whitelist, applied identically whether the answer arrived in one piece
  // or a token at a time. Streaming must not become a second, laxer path into
  // the document -- so there is exactly one, and both callers go through it.
  const decide = (text) => {
    try {
      const parsed = JSON.parse(text || '{}');
      const valid = new Set(candidates.map((c) => c.i));

      // Indices are validated against the blocks actually sent. A hallucinated
      // index is dropped rather than trusted.
      const suggestions = (Array.isArray(parsed.initial) ? parsed.initial : [])
        .map((s) => ({ index: Number(s?.index), reason: String(s?.reason ?? '').slice(0, 60) }))
        .filter((s) => valid.has(s.index));

      return { available: true, model: env.OLLAMA_MODEL || MODEL, suggestions };
    } catch (err) {
      return {
        available: false,
        reason: `Ollama replied with something unreadable: ${String(err?.message || err).slice(0, 120)}`,
        suggestions: [],
      };
    }
  };

  const prompt = `${PROMPT}

${listing}`;

  // ?stream=1 reports the model as it works. Same request, same whitelist; the
  // only difference is that the teacher gets to watch a slow one.
  if (new URL(request.url).searchParams.get('stream') === '1') {
    return streamChat(env, prompt, decide);
  }

  try {
    return json(decide(await chat(env, prompt)));
  } catch (err) {
    return json({ ...failure(err), suggestions: [] });
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

