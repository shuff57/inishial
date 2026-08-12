// Roster CSV parsing.
//
// The SIS export format is not yet known (see design doc, Open questions), so
// columns are matched by alias against a normalized header rather than by
// position. Most PowerSchool / Aeries / Infinite Campus exports should import
// unchanged; extending ALIASES is the fix if one doesn't.

/**
 * Guess the field separator from the header line.
 *
 * Copying cells out of Excel or Google Sheets puts TAB-separated text on the
 * clipboard, not commas -- so a paste box that assumes commas silently reads
 * the whole row as one field. Semicolons show up in exports from spreadsheets
 * running a European locale.
 */
export function detectDelimiter(text) {
  const line = String(text).replace(/^﻿/, '').split(/\r?\n/)[0] || '';
  // Count only separators outside quoted fields, so "Doyle, Robert" does not
  // make a tab-separated file look comma-separated.
  const counts = { '\t': 0, ',': 0, ';': 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

// RFC4180-ish: handles quoted fields, embedded separators, doubled quotes, and
// both line ending conventions. Not a general CSV library -- just enough.
export function parseCsv(text, delimiter) {
  const sep = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const s = text.replace(/^﻿/, ''); // strip BOM; Excel loves emitting one

  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === sep) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const ALIASES = {
  student_ext_id: [
    'student id', 'studentid', 'student_id', 'stuid', 'stu id', 'student number',
    'studentnumber', 'local id', 'localid', 'perm id', 'permid', 'sis id', 'sisid', 'id',
  ],
  last: ['last name', 'lastname', 'last_name', 'last', 'surname'],
  first: ['first name', 'firstname', 'first_name', 'first', 'given name'],
  period: ['period', 'per', 'block', 'section', 'hour', 'class period'],
  course: ['course', 'course name', 'coursename', 'class', 'class name', 'course title', 'subject'],
  // Fallback when the export has one combined name column.
  fullname: ['name', 'student name', 'student', 'studentname'],
  parent_email: [
    'parent email', 'parent email address', 'guardian email', 'guardian email address',
    'parent guardian email', 'parent/guardian email', 'contact email',
    'primary contact email', 'primary email', 'home email',
    'mother email', 'father email', 'parent e mail', 'guardian e mail',
    // Aeries exports the raw field code when columns aren't renamed.
    // STU.PEM is the parent email address.
    'pem', 'stu.pem',
  ],
  // Matched only so a student's own address is never mistaken for a parent's.
  // STU.SEM is Aeries' student email address.
  student_email: [
    'student email', 'student email address', 'school email', 'student e mail',
    'pupil email', 'sem', 'stu.sem',
  ],
};

// A bare "Email" column is ambiguous: in most SIS exports it is the student's
// school address, not a parent's. Adopting it silently would mail syllabus
// links to students instead of parents, which defeats the point. Detected and
// reported rather than guessed at.
const AMBIGUOUS_EMAIL = ['email', 'e mail', 'email address', 'mail'];

// The field names a column can be mapped to -- shared with anything that
// builds or validates a `columns` map itself instead of getting one from
// mapColumns(). functions/api/admin/roster-fix.js whitelists a model's
// guesses against this; functions/api/admin/roster.js whitelists a forced
// mapping passed in the query string against it too.
export const FIELDS = Object.keys(ALIASES);

function normalizeHeader(h) {
  return String(h)
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[#*]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map header cells to our field names. Returns { field: columnIndex }. */
export function mapColumns(headerRow) {
  const norm = headerRow.map(normalizeHeader);
  const out = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    // Longest alias first so "student id" wins over the bare "id" fallback.
    const ordered = [...aliases].sort((a, b) => b.length - a.length);
    for (const alias of ordered) {
      const idx = norm.indexOf(alias);
      if (idx !== -1) { out[field] = idx; break; }
    }
  }
  return out;
}

// "Doyle, Robert James" -> { last: 'Doyle', first: 'Robert James' }
// "Robert Doyle"        -> { last: 'Doyle', first: 'Robert' }
function splitName(value) {
  const v = String(value).trim();
  if (!v) return null;
  if (v.includes(',')) {
    const [last, ...rest] = v.split(',');
    const first = rest.join(',').trim();
    if (last.trim() && first) return { last: last.trim(), first };
    return null;
  }
  const parts = v.split(/\s+/);
  if (parts.length < 2) return null;
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

/**
 * Turn already-CSV-parsed rows into roster rows, given a column map and
 * where the data starts. This is the part parseRoster() and
 * parseRosterWithColumns() share -- extraction, name-splitting, dedup, and
 * the file-level warnings -- so it exists exactly once regardless of how the
 * column map was produced (alias-matched header, or an AI/forced guess).
 *
 * `hasHeader` both picks where the loop starts and gates the ambiguous-email
 * check, which reads `raw[0]` as header text -- meaningless to run against a
 * row that is actually data.
 */
function extractRows(raw, columns, hasHeader) {
  const rows = [];
  const skipped = [];
  const warnings = [];
  const seen = new Set();

  if (hasHeader && columns.parent_email === undefined) {
    const norm = raw[0].map(normalizeHeader);
    const bare = AMBIGUOUS_EMAIL.find((a) => norm.includes(a));
    if (bare) {
      warnings.push(
        `Found a column named "${raw[0][norm.indexOf(bare)]}" but did not use it: `
        + 'a bare email column is usually the student\'s school address, not a parent\'s. '
        + 'Rename the header to "Parent Email" or "Guardian Email" to import it.',
      );
    }
  }

  for (let i = hasHeader ? 1 : 0; i < raw.length; i++) {
    const r = raw[i];
    const line = i + 1;
    const cell = (idx) => (idx === undefined ? '' : String(r[idx] ?? '').trim());

    const studentExtId = cell(columns.student_ext_id);
    if (!studentExtId) { skipped.push({ line, reason: 'missing student ID' }); continue; }

    let first = cell(columns.first);
    let last = cell(columns.last);
    if (!first || !last) {
      const split = splitName(cell(columns.fullname));
      if (!split) { skipped.push({ line, reason: 'missing or unparseable name' }); continue; }
      first = first || split.first;
      last = last || split.last;
    }

    if (seen.has(studentExtId)) { skipped.push({ line, reason: `duplicate student ID ${studentExtId}` }); continue; }
    seen.add(studentExtId);

    // `first` rides along for display ONLY -- the import preview table shows
    // it so a teacher can tell "Doyle, Robert" from "Doyle, Roberta" while
    // reviewing a paste. Nothing downstream stores it: roster.js's INSERT
    // never references row.first, and the roster table has no column for it.
    // See migration 0017 -- the given name was only ever displayed, and this
    // does not undo the decision to stop keeping it in the database.
    rows.push({
      student_ext_id: studentExtId,
      first,
      last,
      period: cell(columns.period) || null,
      course: cell(columns.course) || null,
      parent_email: cell(columns.parent_email).toLowerCase() || null,
    });
  }

  const withEmail = rows.filter((r) => r.parent_email).length;
  if (columns.parent_email !== undefined && withEmail < rows.length) {
    warnings.push(`${rows.length - withEmail} of ${rows.length} students have no parent email in this file.`);
  }

  return { rows, skipped, warnings };
}

/**
 * Parse roster CSV text into rows.
 * Returns { rows, skipped, warnings, columns }. `skipped` carries the 1-based
 * source line and a reason so the teacher can see which lines didn't import
 * rather than silently losing students; `warnings` carries file-level notes
 * such as an ambiguous email column.
 */
export function parseRoster(text) {
  const delimiter = detectDelimiter(text);
  const raw = parseCsv(text, delimiter);
  if (!raw.length) return { rows: [], skipped: [], warnings: [], columns: {}, delimiter };

  const columns = mapColumns(raw[0]);
  if (columns.student_ext_id === undefined) {
    throw new Error('No student ID column found. Expected a header like "Student ID".');
  }
  const hasNames = columns.first !== undefined && columns.last !== undefined;
  if (!hasNames && columns.fullname === undefined) {
    throw new Error('No name columns found. Expected "First Name"/"Last Name" or "Student Name".');
  }

  const { rows, skipped, warnings } = extractRows(raw, columns, true);
  return { rows, skipped, warnings, columns, delimiter };
}

/**
 * Parse roster CSV text using an explicit column map instead of matching a
 * header by alias -- the path for when parseRoster() couldn't find one: an
 * AI-guessed mapping (functions/api/admin/roster-fix.js) that the teacher
 * has confirmed, or the same mapping replayed on the real import via
 * `?columns=`/`?has_header=` on /api/admin/roster.
 *
 * `columns` is the same shape mapColumns() returns: { field: columnIndex }.
 * No alias-matching and no ID/name-column requirement here -- a caller that
 * hands in an empty or useless map gets rows that mostly skip for "missing
 * student ID", not a thrown error; the caller decides whether that's usable.
 */
export function parseRosterWithColumns(text, columns, hasHeader) {
  const delimiter = detectDelimiter(text);
  const raw = parseCsv(text, delimiter);
  if (!raw.length) return { rows: [], skipped: [], warnings: [], columns, delimiter };

  const { rows, skipped, warnings } = extractRows(raw, columns || {}, Boolean(hasHeader));
  return { rows, skipped, warnings, columns: columns || {}, delimiter };
}
