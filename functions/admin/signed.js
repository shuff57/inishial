// GET /admin/signed?account_id=N   (Access gated)
//
// The printable record: the syllabus exactly as it was published, with each
// initial stamped inline where it was given, plus the audit detail. This is
// what you hand to an administrator or a parent who disputes having agreed to
// something.
//
// Server-rendered rather than fetched by a page, so printing is one step and
// there is no client state to get out of sync with the record.
//
// It renders the version the parent ACTUALLY SIGNED, not the current one.
// Printing today's text over last term's signature would misrepresent what was
// agreed to.

import { unauthorized, serverMisconfigured, badRequest, requireAdmin, owns, escapeHtml, html } from '../_lib/http.js';

export async function onRequestGet({ request, env }) {
  const admin = await requireAdmin(request, env);
  if (!admin) return unauthorized();
  if (!env.DB) return serverMisconfigured('the DB binding');

  const accountId = Number(new URL(request.url).searchParams.get('account_id'));
  if (!Number.isInteger(accountId) || accountId < 1) return badRequest('account_id is required.');

  const who = await env.DB.prepare(
    `SELECT a.id, a.username, COALESCE(a.parent_email, r.parent_email) AS email,
            r.first, r.last, r.student_ext_id, r.period, c.name AS course, c.owner_id
       FROM accounts a
       JOIN roster r ON r.id = a.roster_id
       JOIN courses c ON c.id = r.course_id
      WHERE a.id = ?1`,
  ).bind(accountId).first();
  // This page is a named student, their parent's email, and everything they
  // agreed to. Addressed by account_id, so the owner check comes through the
  // course; "not yours" is reported as "no such student" so account ids are not
  // enumerable across the school.
  if (!who || !owns(who.owner_id, admin)) {
    return badRequest('No such student.');
  }

  // The version they signed. Falls back to the live one when nothing is signed
  // yet, so the page still shows what they were asked to agree to.
  const signedVersion = await env.DB.prepare(
    `SELECT v.id, v.num, v.published_at, s.title
       FROM signatures sg
       JOIN versions v ON v.id = sg.version_id
       JOIN syllabi  s ON s.id = v.syllabus_id
      WHERE sg.account_id = ?1
      ORDER BY v.num DESC LIMIT 1`,
  ).bind(accountId).first();

  const version = signedVersion ?? await env.DB.prepare(
    `SELECT v.id, v.num, v.published_at, s.title
       FROM versions v
       JOIN syllabi s ON s.id = v.syllabus_id
       JOIN roster  r ON r.course_id = s.course_id
       JOIN accounts a ON a.roster_id = r.id
      WHERE a.id = ?1 AND v.published_at IS NOT NULL
      ORDER BY v.num DESC LIMIT 1`,
  ).bind(accountId).first();

  if (!version) return badRequest('No published syllabus for this student yet.');

  const { results: blocks } = await env.DB.prepare(
    'SELECT id, type, html, needs_initials, level FROM blocks WHERE version_id = ?1 ORDER BY ord',
  ).bind(version.id).all();

  const { results: sigs } = await env.DB.prepare(
    `SELECT block_id, role, initials, signed_at, ip, user_agent, block_hash
       FROM signatures WHERE account_id = ?1 AND version_id = ?2`,
  ).bind(accountId, version.id).all();

  const byBlock = new Map();
  for (const s of sigs ?? []) {
    if (!byBlock.has(s.block_id)) byBlock.set(s.block_id, {});
    byBlock.get(s.block_id)[s.role] = s;
  }

  const when = (t) => (t ? new Date(t * 1000).toISOString().replace('T', ' ').replace(/\..+/, ' UTC') : '—');

  const body = (blocks ?? []).map((b) => {
    if (!b.needs_initials) return `<div class="block">${b.html}</div>`;

    const signed = byBlock.get(b.id) || {};
    const stamp = (role, label) => {
      const s = signed[role];
      if (!s) return `<div class="unsigned">${label}: not initialed</div>`;
      return `<div class="stamp"><b>${escapeHtml(s.initials)}</b> — ${label}, ${escapeHtml(when(s.signed_at))}`
        + `<div class="audit">IP ${escapeHtml(s.ip ?? '—')} · text hash ${escapeHtml(String(s.block_hash).slice(0, 16))}…</div></div>`;
    };
    return `<div class="initial-box${signed.parent ? ' done' : ''}">
      <p class="prompt">${escapeHtml(b.html)}</p>
      ${stamp('parent', 'Parent or guardian')}
      ${signed.student ? stamp('student', 'Student') : ''}
    </div>`;
  }).join('\n');

  const required = (blocks ?? []).filter((b) => b.needs_initials).length;
  const done = (blocks ?? []).filter((b) => b.needs_initials && byBlock.get(b.id)?.parent).length;

  return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(who.last)}, ${escapeHtml(who.first)} — signed syllabus</title>
<link rel="stylesheet" href="/app.css">
<style>
  .record { border: 1px solid var(--ring); border-radius: var(--radius-sm); padding: .8rem 1rem; margin: 0 0 1.5rem; background: var(--ivory); }
  .record dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .9rem; margin: 0; font-size: .9rem; }
  .record dt { color: var(--ink-stone); }
  .record dd { margin: 0; }
  .unsigned { color: var(--rose); font-size: .9rem; font-weight: 600; }
  .audit { font: 11px var(--font-mono); color: var(--ink-stone); margin-top: .15rem; }
  @media print { .record { border-color: #999; background: #fff; } }
</style>
</head>
<body>
<header class="site"><div>
  <div class="brand">ini<span class="sh">SH</span>ial</div>
  <p class="tagline">No backpack required.</p>
</div></header>

<main>
  <h1>${escapeHtml(version.title)}</h1>

  <div class="record">
    <dl>
      <dt>Student</dt><dd>${escapeHtml(who.last)}, ${escapeHtml(who.first)} (ID ${escapeHtml(who.student_ext_id)})</dd>
      <dt>Class</dt><dd>${escapeHtml(who.course)}${who.period ? ` · Period ${escapeHtml(who.period)}` : ''}</dd>
      <dt>Contact</dt><dd>${escapeHtml(who.email ?? 'none on file')}</dd>
      <dt>Version</dt><dd>${version.num}, published ${escapeHtml(when(version.published_at))}</dd>
      <dt>Initialed</dt><dd>${done} of ${required} required sections</dd>
    </dl>
  </div>

  <p class="no-print"><button onclick="window.print()">Print this record</button></p>

  ${body}

  <p class="small muted" style="margin-top:2rem">
    Each initial is recorded with a timestamp, the originating IP address, and a SHA-256
    hash of the exact section text as it stood when initialed. Published versions are
    immutable, so the text above is what was agreed to.
  </p>
</main>
</body>
</html>`);
}
