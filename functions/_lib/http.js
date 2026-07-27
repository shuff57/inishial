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
 */
export async function requireAdmin(request, env, nowSec = Math.floor(Date.now() / 1000)) {
  const viaAccess = readAdminEmail(request, env);
  if (viaAccess) return { via: 'access', email: viaAccess };

  const claims = await currentSession(request, env, nowSec);
  // ADMIN_EMAILS may hold several addresses and the password says nothing about
  // which person typed it, so the audit trail records the method, not a name it
  // cannot actually establish.
  if (claims?.role === 'teacher') return { via: 'session', email: 'password-login' };

  return null;
}

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
