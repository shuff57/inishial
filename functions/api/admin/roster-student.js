// /api/admin/roster-student   -- single-row roster CRUD  (Access gated)
//
//   POST    add one student to a course (or reactivate a dropped one)
//   PATCH   edit a student's name / parent email / period, or drop / restore
//
// The bulk path (roster.js) is for a whole spreadsheet; this is for the one
// student a teacher needs to fix without re-uploading the rest of the class.
//
// NO HARD DELETE, ANYWHERE -- same invariant roster.js's header states and
// this endpoint must not break: a roster row backs accounts and signatures
// that have to survive a student leaving, so "remove" only ever means
// status = 'dropped'. "Restore" undoes it. There is no path back to a real
// DELETE from here.

import {
  json, badRequest, unauthorized, serverMisconfigured, requireAdmin, ownedCourse, readJson,
} from '../../_lib/http.js';
import { seal, open, blindIndex, vaultReady } from '../../_lib/vault.js';

// Same deliberately-permissive shape credentials.js and request-code.js use.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const ROW_COLUMNS = 'id, course_id, period, student_ext_id, parent_email, status, dropped_at';
// Same columns plus the sealed name -- needed only to open() it for a PATCH
// response that did not touch `last`; never spread straight into a response.
const ROW_COLUMNS_ENC = `${ROW_COLUMNS}, last_enc`;

/**
 * POST -- add one student. `{ course_id, student_ext_id, last, parent_email?, period? }`
 *
 * Upserts on (course_id, student_ext_id), the same key and the same
 * ON CONFLICT DO UPDATE shape roster.js's import loop uses: a student who
 * already has a row for this course -- active or previously dropped -- is
 * reactivated and updated rather than rejected as a duplicate. That is what
 * lets "add the student back" work whether they were never on the roster or
 * left it, without the teacher needing to know which case they are in.
 */
export async function onRequestPost({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');
  // Fails closed, same reasoning as roster.js: a row written without a
  // working seal looks imported and then matches no one at registration.
  if (!vaultReady(env)) return serverMisconfigured('CODE_SECRET, which student names are sealed with');

  const body = await readJson(request);
  if (!body) return badRequest('Expected a JSON body.');

  const courseId = Number(body.course_id);
  // Null covers "no such course" and "not yours" alike, same as everywhere
  // else this check is used -- a teacher should not be able to tell the two
  // apart by watching for a different error.
  const course = await ownedCourse(env, courseId, admin);
  if (!course) return badRequest('No such course.');

  const extId = String(body.student_ext_id ?? '').trim();
  if (!extId) return badRequest('A student ID is required.');
  const last = String(body.last ?? '').trim();
  if (!last) return badRequest('A last name is required.');

  const parentEmail = String(body.parent_email ?? '').trim();
  if (parentEmail && !EMAIL_RE.test(parentEmail)) return badRequest("That doesn't look like an email address.");
  const period = body.period != null ? String(body.period).trim() || null : null;

  // Sealed for display, digested for matching -- scoped to the student's own
  // ID, exactly as roster.js seals a name, so registration keeps matching
  // this student under the same digest a re-import would have produced.
  const lastEnc = await seal(env, last);
  const lastIdx = await blindIndex(env, last, extId);

  await env.DB.prepare(
    `INSERT INTO roster (course_id, period, student_ext_id, last_enc, last_idx, parent_email, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active')
     ON CONFLICT(course_id, student_ext_id) DO UPDATE SET
       period       = excluded.period,
       last_enc     = excluded.last_enc,
       last_idx     = excluded.last_idx,
       -- Keep the address already on file when this add did not carry one,
       -- same as a re-import leaves an omitted column alone.
       parent_email = COALESCE(excluded.parent_email, roster.parent_email),
       -- A student added back is active again, and their account and
       -- signatures come with them -- never a fresh row, never a delete.
       status       = 'active',
       dropped_at   = NULL`,
  ).bind(courseId, period, extId, lastEnc, lastIdx, parentEmail || null).run();

  // ON CONFLICT DO UPDATE leaves lastInsertRowid pointing at nothing useful,
  // so the row is read back by its real key rather than trusted off the
  // insert metadata (roster.js hits the same wall and works around it the
  // same way, by counting instead of trusting the id).
  const row = await env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM roster WHERE course_id = ?1 AND student_ext_id = ?2`)
    .bind(courseId, extId).first();

  // The plaintext the teacher just typed rides along in the response so the
  // page can show it immediately, without a decrypt round-trip -- same
  // reasoning as `first` riding along in csv.js's preview rows.
  return json({ ...row, last });
}

/**
 * PATCH -- edit a student, or change status. `{ id, last?, parent_email?, period?, status? }`
 *
 * `id` is the roster row's own id. `student_ext_id` is not editable here: it
 * is a matching key other tables reference by value, so fixing a wrong one is
 * drop-the-old-row-add-a-new-one, not an in-place rename.
 *
 * `status`, when present, is whitelisted to exactly 'active' or 'dropped' --
 * this is the entire remove/restore mechanism and the only place either one
 * happens. There is no delete branch here, on purpose: see the file header.
 */
export async function onRequestPatch({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  if (!body) return badRequest('Expected a JSON body.');

  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return badRequest('id is required.');

  const existing = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM roster WHERE id = ?1`,
  ).bind(id).first();
  // Same "No such student" for missing and for not-yours as ownedCourse's own
  // doc comment: a teacher should not learn which roster ids exist elsewhere.
  if (!existing || !(await ownedCourse(env, existing.course_id, admin))) return badRequest('No such student.');

  const sets = [];
  const binds = [];
  const set = (column, value) => { binds.push(value); sets.push(`${column} = ?${binds.length}`); };

  let lastForResponse;
  if (body.last !== undefined) {
    const last = String(body.last ?? '').trim();
    if (!last) return badRequest('A last name is required.');
    // Same scope as POST and as roster.js's import loop: the row's own
    // student_ext_id, which this endpoint does not allow changing.
    set('last_enc', await seal(env, last));
    set('last_idx', await blindIndex(env, last, existing.student_ext_id));
    lastForResponse = last;
  }

  if (body.parent_email !== undefined) {
    // This is roster.parent_email -- the SIS-sourced value, same column a
    // re-import writes. Deliberately not student_identities.parent_email,
    // which is credentials.js's override on top of it; that stays untouched
    // here, and its own PATCH is the only thing that ever edits it.
    const raw = String(body.parent_email ?? '').trim();
    if (raw && !EMAIL_RE.test(raw)) return badRequest("That doesn't look like an email address.");
    set('parent_email', raw || null);
  }

  if (body.period !== undefined) {
    const period = String(body.period ?? '').trim();
    set('period', period || null);
  }

  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'dropped') {
      return badRequest("status must be 'active' or 'dropped'.");
    }
    set('status', body.status);
    // The drop/restore mechanism in full: a timestamp going in, NULL coming
    // back out, same shape courses.js uses for archived_at.
    set('dropped_at', body.status === 'dropped' ? Math.floor(Date.now() / 1000) : null);
  }

  if (!sets.length) return badRequest('Nothing to change.');

  binds.push(id);
  await env.DB.prepare(`UPDATE roster SET ${sets.join(', ')} WHERE id = ?${binds.length}`).bind(...binds).run();

  const row = await env.DB.prepare(`SELECT ${ROW_COLUMNS_ENC} FROM roster WHERE id = ?1`).bind(id).first();
  // Same plaintext-last-included shape as POST's response, every time -- the
  // name just typed when this edit touched it, opened from storage otherwise
  // (same fallback credentials.js's PATCH uses), so the caller never has to
  // make a second round trip just to know what it now shows.
  const { last_enc, ...visible } = row;
  const last = lastForResponse !== undefined ? lastForResponse : (await open(env, last_enc)) || '';
  return json({ ...visible, last });
}
