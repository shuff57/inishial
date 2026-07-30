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
import { MODEL, chat, streamChat, failure, parseJsonAnswer } from '../../_lib/ollama.js';
import { isModelName } from './models.js';

// Only these two can be reinterpreted. A prompt, a list or a table is never
// silently retagged -- an `initial` block carries a signature obligation, and
// turning one into a heading would drop it from the document without a trace.
const RETAGGABLE = new Set(['text', 'heading', 'subheading']);

const PROMPT = `Below are the numbered lines of a course syllabus, in order.

Give each line one of three tags:

- "heading" — a SECTION heading: a short title introducing a major part of the syllabus, e.g. "Late Work", "Grading Policy", "Attendance", "Academic Honesty".
- "subheading" — a title for a part of the section above it, not a section of its own, e.g. "Late Work" under "Grading Policy", or "Consequences" under "Academic Honesty". Use this when the line titles something that belongs INSIDE the nearest heading rather than starting a new part of the document.
- "text" — body text: sentences, policies, lists, contact details, labelled fields such as "Email: someone@school.edu".

A short bold line is not automatically a heading. A labelled field like "Instructor: Jane Doe" is body text. A heading or subheading introduces what comes after it.

Work down the list in order, keeping track of the last "heading" you assigned. If a title line names a part of THAT topic rather than a new topic, it is a "subheading". A syllabus where every title is a "heading" is usually wrong about several of them.

Example input:
[0] (text) Instructor
[1] (text) Steven Huff
[2] (text) Email
[3] (text) shuff@chicousd.org
[4] (text) Attendance and Participation
[5] (text) If you are not in your seat by the time I take roll, you will be marked tardy.
[6] (text) Dropping the Butte College Course
[7] (text) This class runs on the high school schedule, but the college deadlines are separate.
[8] (text) Academic Honesty
[9] (text) Neither cheating nor plagiarism will be tolerated.
[10] (text) Definitions
[11] (text) Plagiarism is presenting the words of another as your own.
[12] (text) Consequences — High School
[13] (text) A first offence earns a zero and a call home.
[14] (text) Grading Policy
[15] (text) Grade Weights
[16] (text) Daily homework 15%, group assessments 10%, individual assessments 75%.
[17] (text) Grading Scheme

Example output. "Attendance and Participation", "Academic Honesty" and "Grading Policy" each start a new topic, so they are headings. "Dropping the Butte College Course" is part of attendance; "Definitions" and "Consequences — High School" are parts of academic honesty; "Grade Weights" and "Grading Scheme" are parts of the grading policy — all subheadings. Lines 0 to 3 are a labelled contact field split across lines, not titles: they stay "text", so they do not appear in the answer at all.
{"retag":[{"index":4,"tag":"heading"},{"index":6,"tag":"subheading"},{"index":8,"tag":"heading"},{"index":10,"tag":"subheading"},{"index":12,"tag":"subheading"},{"index":14,"tag":"heading"},{"index":15,"tag":"subheading"},{"index":17,"tag":"subheading"}]}

Now do the same for the lines below. Reply with ONLY a JSON object, no prose. Include a line only if its tag should CHANGE:
{"retag":[{"index":<number>,"tag":"heading"|"subheading"|"text"}]}`;

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  if (!body || !Array.isArray(body.blocks)) return badRequest('blocks must be an array.');
  if (!env.OLLAMA_API_KEY) {
    return json({ available: false, reason: 'No OLLAMA_API_KEY is configured.', retag: [] });
  }

  // `type` here is the vocabulary the MODEL uses, not the storage one: a
  // heading is stored as type 'heading' with a level, and flattening both into
  // "heading" would ask the model to choose between two words it cannot see
  // the difference between.
  const asTag = (b) => (b?.type === 'heading' ? (Number(b.level ?? 2) === 3 ? 'subheading' : 'heading') : b?.type);
  const candidates = body.blocks
    .map((b, i) => ({ i, type: asTag(b), text: stripHtml(b?.html).slice(0, 200) }))
    .filter((b) => RETAGGABLE.has(b.type) && b.text.length > 0);

  if (!candidates.length) return json({ available: true, retag: [] });

  const listing = candidates.map((b) => `[${b.i}] (${b.type}) ${b.text}`).join('\n');

  // The whitelist, applied identically whether the answer arrived in one piece
  // or a token at a time. Streaming must not become a second, laxer path into
  // the document -- so there is exactly one, and both callers go through it.
  const decide = (text) => {
    try {
      const parsed = parseJsonAnswer(text);

      // A whitelist, not a parse: an index must be one we actually sent, a tag
      // must be one of two literals, and the change must be a real change.
      // Anything else the model returns is dropped on the floor.
      const byIndex = new Map(candidates.map((c) => [c.i, c.type]));
      const seen = new Set();
      const retag = (Array.isArray(parsed.retag) ? parsed.retag : [])
        .map((r) => ({ index: Number(r?.index), tag: String(r?.tag ?? '') }))
        .filter((r) => Number.isInteger(r.index) && byIndex.has(r.index))
        .filter((r) => RETAGGABLE.has(r.tag))
        .filter((r) => r.tag !== byIndex.get(r.index))
        .filter((r) => (seen.has(r.index) ? false : seen.add(r.index)));

      return { available: true, model: picked || env.OLLAMA_MODEL || MODEL, retag };
    } catch (err) {
      return {
        available: false,
        reason: `Ollama replied with something unreadable: ${String(err?.message || err).slice(0, 120)}`,
        retag: [],
      };
    }
  };

  // The editor may name a model. Validated, never trusted: an unrecognised
  // shape falls back to the configured default rather than being sent onward.
  const picked = isModelName(String(body.model ?? '')) ? String(body.model) : null;
  const prompt = `${PROMPT}

${listing}`;

  // ?stream=1 reports the model as it works. Same request, same whitelist; the
  // only difference is that the teacher gets to watch a slow one.
  if (new URL(request.url).searchParams.get('stream') === '1') {
    return streamChat(env, prompt, decide, picked);
  }

  try {
    return json(decide(await chat(env, prompt, picked)));
  } catch (err) {
    return json({ ...failure(err), retag: [] });
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

