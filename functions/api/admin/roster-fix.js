// POST /api/admin/roster-fix   -- ask Ollama to guess a roster's columns
// when the deterministic header match failed
//
// The normal path is functions/_lib/csv.js's parseRoster(): match a header
// row against a fixed alias list, no model involved. This endpoint exists
// for the pastes that don't match it -- an unrecognised header ("Learner
// ID", "Guardian Contact"), or no header row at all. It is never called on
// the happy path; the caller only reaches it after parseRoster() has
// already thrown.
//
// The same rule as api/admin/structure.js and api/admin/suggest.js: the
// model never returns a value that becomes stored data. It returns a column
// MAP -- field name to column index -- and a has_header guess, both
// whitelisted below against the eight real field names and the column count
// of the row actually sent. Nothing the model writes reaches the response
// except that map; the actual student data used to parse the roster is
// still the teacher's own pasted text, read straight off their paste, not
// off anything Ollama said.
//
// Privacy: OLLAMA_HOST (ollama.com) is a third-party cloud API, not
// self-hosted, and this app otherwise minimises what it exposes -- given
// names are dropped at the door (migration 0017), surnames are sealed
// (_lib/vault.js), and mail.js was patched to stop logging PII. This
// endpoint is the one deliberate exception: when there's truly no header to
// go on, a *few* real data rows are sent so the model has something to
// guess from. That tradeoff is scoped as tightly as it can be and still
// work:
//   - only row 0 plus up to 3 data rows, never the whole paste
//   - every cell truncated before it leaves this file
//   - nothing here is ever logged -- no console.log of the prompt, the
//     pasted text, or the model's answer, matching the mail.js dry-run fix
//   - the guessed mapping is never applied on its own; the UI shows it in
//     plain language and requires the teacher to click "Use this mapping"
//     before it parses anything

import { json, badRequest, unauthorized, serverMisconfigured, requireAdmin } from '../../_lib/http.js';
import { MODEL, chat, streamChat, failure, parseJsonAnswer } from '../../_lib/ollama.js';
import { isModelName } from './models.js';
import { parseCsv, detectDelimiter, parseRoster, FIELDS } from '../../_lib/csv.js';

const VALID_FIELDS = new Set(FIELDS);

// Row 0 plus up to 3 data rows -- enough for the model to see a pattern,
// never the whole paste.
const MAX_ROWS = 4;
// Long free-text cells (a pasted comment, a stray paragraph) truncate here
// before they're sent anywhere.
const CELL_LIMIT = 60;

const PROMPT = `Below are the first few rows of a roster pasted from a spreadsheet. The
normal column-matching failed: either the header row uses labels we don't
recognize, or there is no header row at all and row 0 is already data.

Guess which column holds which of these fields. Valid field names:

- "student_ext_id" -- the student's ID number in the school's system.
- "last" -- last name, when it is in its own column.
- "first" -- first name, when it is in its own column. Use "last" and
  "first" TOGETHER, only when the roster has them as separate columns.
- "fullname" -- one column holding a whole name (e.g. "Doyle, Robert" or
  "Robert Doyle"). Use "fullname" ALONE, never together with "last"/"first".
- "period" -- class period, section, or block.
- "course" -- course or class name, when the file covers more than one class.
- "parent_email" -- a parent or guardian's email address.
- "student_email" -- the student's own email address, not a parent's.

Row 0 might be a header row (short labels like "Learner ID") or might
already be a data row (a real ID, a real name). Decide which, and set
"has_header" accordingly. If row 0 is a header, use its labels to guess the
columns; if it's data, use the data itself.

Only include a field in "columns" when you are confident about it. Reply
with ONLY a JSON object, no prose:
{"has_header": <bool>, "columns": {"<field>": <column index>}}`;

export async function onRequestPost({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const text = await request.text();
  if (!text.trim()) return badRequest('The pasted text was empty.');

  // Never reached on the happy path: if the deterministic parser already
  // works, there is nothing here to fix and no reason for a data row to
  // leave the server.
  try {
    parseRoster(text);
    return json({ available: true, needed: false, has_header: null, columns: {} });
  } catch {
    // This is exactly the case the AI fix exists for -- fall through.
  }

  if (!env.OLLAMA_API_KEY) {
    return json({ available: false, reason: 'No OLLAMA_API_KEY is configured.', has_header: null, columns: {} });
  }

  const raw = parseCsv(text, detectDelimiter(text));
  if (!raw.length) {
    return json({ available: false, reason: 'No usable rows found in that paste.', has_header: null, columns: {} });
  }

  const colCount = raw[0].length;
  const truncate = (v) => {
    const s = String(v ?? '');
    return s.length > CELL_LIMIT ? `${s.slice(0, CELL_LIMIT)}…` : s;
  };
  const listing = raw
    .slice(0, MAX_ROWS)
    .map((row, i) => `Row ${i}: ${row.map((cell, ci) => `[${ci}] "${truncate(cell)}"`).join('  ')}`)
    .join('\n');

  // The whitelist, applied identically whether the answer arrived in one
  // piece or a token at a time. A field name must be one of the eight real
  // ones and an index must fall inside the row actually sent -- anything
  // else the model returns is dropped rather than trusted.
  const decide = (answer) => {
    try {
      const parsed = parseJsonAnswer(answer);
      const hasHeader = Boolean(parsed.has_header);
      const columns = {};
      if (parsed.columns && typeof parsed.columns === 'object') {
        for (const [field, value] of Object.entries(parsed.columns)) {
          const idx = Number(value);
          if (VALID_FIELDS.has(field) && Number.isInteger(idx) && idx >= 0 && idx < colCount) {
            columns[field] = idx;
          }
        }
      }
      return { available: true, model: picked || env.OLLAMA_MODEL || MODEL, has_header: hasHeader, columns };
    } catch (err) {
      return {
        available: false,
        reason: `Ollama replied with something unreadable: ${String(err?.message || err).slice(0, 120)}`,
        has_header: null,
        columns: {},
      };
    }
  };

  // The editor may name a model, the same way structure.js and suggest.js
  // let one be named in the JSON body -- but this endpoint's body is the
  // raw paste, not JSON, so it travels as a query param instead. Validated,
  // never trusted: an unrecognised shape falls back to the configured
  // default rather than being sent onward.
  const requestedModel = new URL(request.url).searchParams.get('model') || '';
  const picked = isModelName(requestedModel) ? requestedModel : null;
  const prompt = `${PROMPT}

${listing}`;

  // ?stream=1 reports the model as it works, same as structure.js and
  // suggest.js. Same request, same whitelist either way.
  if (new URL(request.url).searchParams.get('stream') === '1') {
    return streamChat(env, prompt, decide, picked);
  }

  try {
    return json(decide(await chat(env, prompt, picked)));
  } catch (err) {
    return json({ ...failure(err), has_header: null, columns: {} });
  }
}
