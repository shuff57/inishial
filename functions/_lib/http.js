// Response helpers + the admin gate.
//
// Cloudflare Access (Zero Trust) sits in front of /api/admin/*. Once a request
// passes the Access policy it arrives carrying the authenticated identity as a
// header. We re-check it here as defense in depth: if anyone ever reaches the
// Function without going through Access (misconfigured rule, deleted
// application, direct *.pages.dev hit), the request is refused in code rather
// than silently trusted. Same pattern as bookshelf's functions/_lib/auth.js.

import { currentSession } from './session.js';

export const ACCESS_EMAIL_HEADER = 'Cf-Access-Authenticated-User-Email';

export function json(body, status = 200, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(extraHeaders || {}) },
  });
}

export const badRequest = (message) => json({ error: message }, 400);
export const unauthorized = () => json({ error: 'Unauthorized.' }, 401);
export const serverMisconfigured = (what) => json({ error: `Server is missing ${what}.` }, 503);

/**
 * Authenticated teacher email from Cloudflare Access, or null.
 *
 * ADMIN_EMAILS (comma-separated var) narrows access further than the Access
 * policy itself. This app holds student PII, so a loose Access rule should not
 * be the only thing standing in front of it.
 */
export function readAdminEmail(request, env) {
  const email = (request.headers.get(ACCESS_EMAIL_HEADER) || '').trim().toLowerCase();
  if (!email) return null;
  const allow = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length && !allow.includes(email)) return null;
  return email;
}

/**
 * Admin identity for this request, or null.
 *
 * Accepts EITHER of two independent gates:
 *   1. A Cloudflare Access identity header, when Access is configured.
 *   2. A signed teacher session cookie from /api/admin/login.
 *
 * Either alone is sufficient, so the app works with or without Zero Trust and
 * gains edge-level protection for free if Access is added later. The role is
 * checked explicitly: a parent or student cookie is not an admin cookie.
 *
 * `teacherId` is what scopes the data:
 *
 *   a number -- a teacher who signed up. Their own courses, and no others.
 *   null     -- the shared ADMIN_PASSWORD_HASH, or a Cloudflare Access
 *               identity. UNOWNED courses only: the ones imported before
 *               teacher accounts existed.
 *
 * That second case used to mean "sees everything", which made the shared
 * password a skeleton key to every class in the school. A colleague's roster
 * is their students' names, their parents' addresses and their signing codes,
 * and nobody needs a view across all of it to run this app. The legacy bucket
 * still needs an owner, hence unowned-only rather than nothing at all; sign-up
 * can adopt those courses and take them out of it.
 *
 * Read the limit of this honestly: it is an authorization boundary inside the
 * app, not a wall against whoever operates the server. Anyone holding the
 * database and CODE_SECRET can read any class, and no amount of server-side
 * encryption changes that -- the server has to be able to decrypt to display.
 * What this does guarantee is that no request through this app hands one
 * teacher another teacher's students.
 */
export async function requireAdmin(request, env, nowSec = Math.floor(Date.now() / 1000)) {
  const viaAccess = readAdminEmail(request, env);
  if (viaAccess) return { via: 'access', email: viaAccess, teacherId: null };

  const claims = await currentSession(request, env, nowSec);
  if (claims?.role !== 'teacher') return null;

  // sub 0 is the shared password: it says nothing about which person typed it,
  // so the audit trail records the method rather than a name it cannot
  // actually establish. Any other sub is a row in `teachers`.
  return claims.sub
    ? { via: 'teacher', email: claims.email || `teacher#${claims.sub}`, teacherId: claims.sub }
    : { via: 'session', email: 'password-login', teacherId: null };
}

/**
 * The course row this admin is allowed to act on, or null.
 *
 * Null covers both "no such course" and "not yours" on purpose. Distinguishing
 * them would let a teacher enumerate which course ids exist at the school by
 * watching for a different error, and there is nothing a caller does with the
 * difference anyway.
 */
export async function ownedCourse(env, courseId, admin) {
  if (!Number.isInteger(courseId) || courseId < 1) return null;
  const row = await env.DB.prepare('SELECT * FROM courses WHERE id = ?1').bind(courseId).first();
  if (!row) return null;
  // `==` is deliberate on both sides: D1 hands back null for an unowned course
  // and the shared-password admin carries undefined, and those two have to
  // meet. A signed-up teacher matches only their own id -- there is no branch
  // here that lets one identity through to another's course.
  return owns(row.owner_id, admin) ? row : null;
}

/** Does this admin own that course? The single definition of the boundary --
 *  every list query below and every by-id check above goes through it. */
export const owns = (ownerId, admin) =>
  admin.teacherId == null ? ownerId == null : ownerId === admin.teacherId;

/** Bind value for the owner clause in list queries. Pair it with
 *  `WHERE owner_id IS ?n` -- SQLite's IS compares NULLs, so one bound value
 *  covers both "mine" and "the unowned ones" without a second code path.
 *
 *  It used to be paired with `(?n IS NULL OR owner_id = ?n)`, which read as a
 *  filter and behaved as a bypass: NULL matched every row rather than the
 *  unowned ones. */
export const ownerFilter = (admin) => admin.teacherId ?? null;

/** Parse a JSON body, returning null rather than throwing on malformed input. */
export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

export function csvResponse(filename, text) {
  return new Response('﻿' + text, {
    headers: {
      // BOM above so Excel opens UTF-8 names (Alvarez, Nguyễn) correctly.
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

/**
 * Quote a value for CSV output, and neutralise spreadsheet formulas.
 *
 * Excel, Sheets, and LibreOffice treat a cell starting with = + - @ (or a tab
 * / carriage return) as a formula and evaluate it on open. Names and emails in
 * these exports come from an uploaded roster and from student input, so a
 * student called `=HYPERLINK("http://evil","Click")` would otherwise become a
 * live link in the teacher's spreadsheet. Prefixing with an apostrophe is the
 * standard mitigation: the cell displays as text and is never evaluated.
 */
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells) => cells.map(csvCell).join(',');

/** Escape for interpolation into HTML text or a double-quoted attribute. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
