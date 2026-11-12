// Outbound transactional email, over SMTP submission to the owner's Stalwart
// server (see _lib/smtp.js).
//
// The mail this app sends: a parent's access code, on demand, from the parent
// self-signup page, and a teacher's password-reset link. Nothing else emails
// anyone -- the teacher's export is still a CSV the teacher mails themselves --
// so this is the entire surface.
//
// It sends the way verSHion does (and raSHio's socket code, which both come
// from): Cloudflare TCP sockets to smtp.huffpalmer.fyi:465, logging in as this
// app's own mailbox, inishial-no-reply@lefthanddev.com, with a Stalwart app
// password (SMTP_USERNAME var, SMTP_PASSWORD secret). Stalwart DKIM-signs for
// lefthanddev.com, so the mail passes DMARC with that address in From.
// MAIL_REPLY_TO carries the mailbox a human reads. The mail never leaves
// infrastructure the owner runs, which suits a message carrying a parent's
// address and a student's access code.
//
// In dev and tests there are no secrets. MAIL_DRY_RUN makes that a log line
// instead of an error, so the flow can be exercised end-to-end without
// credentials. Without either secrets or the dry-run flag, this returns an
// honest failure so the parent endpoint can tell the parent the mail did
// not go, rather than claiming it did.

import { sendViaSmtp } from './smtp.js';

const SUBJECT = 'Your access code for the course syllabus';
const RESET_SUBJECT = 'Reset your iniSHial teacher password';

// ---- what the dry run is allowed to say ----
//
// MAIL_DRY_RUN exists so the flow can be walked without a mail server, and it
// used to print the whole message's worth of secrets to do it: a parent's real
// address, their access code, the student's code, and for a reset the link with
// its live token in the query string. That is the one place this app writes PII
// and working credentials into a log, and a log is read by whoever can see the
// deployment -- which is the reading this masking is meant to close.
//
// Masked by default. `MAIL_DRY_RUN=verbose` prints everything, for the one case
// that needs it: testing the flow locally, where you have to be able to type
// the code the mail would have carried.
//
// Production sets no MAIL_DRY_RUN at all, so neither branch runs there. The
// branch that matters is a PREVIEW deployment, which inherits the top-level
// [vars] in wrangler.toml -- and that does set it.
const HIDDEN = '(codes hidden — MAIL_DRY_RUN=verbose to show)';
const loud = (env) => String(env.MAIL_DRY_RUN ?? '').toLowerCase() === 'verbose';

/** j•••@example.com -- enough to tell which inbox, not enough to harvest. */
function maskEmail(email) {
  const [local, domain] = String(email ?? '').split('@');
  if (!local || !domain) return '•••';
  return `${local[0]}${'•'.repeat(Math.min(local.length - 1, 3))}@${domain}`;
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Where the parent actually goes. `/sign` is a client-side route, so the
 *  path is the same on any host. Configurable because the app can move between
 *  hostnames, and a mail whose link points at a
 *  different registrable domain than its From address is both worse for the
 *  parent and a signal spam filters score against. */
function signUrl(env) {
  const base = String(env.APP_URL || 'https://inishial.pages.dev').replace(/\/+$/, '');
  return `${base}/sign`;
}

/** The reset link a teacher clicks. Same APP_URL as the parent's link, for the
 *  same reason: a mail whose link sits on a different registrable domain than
 *  its From address is both worse for the reader and worse for deliverability. */
function resetUrl(env, token) {
  const base = String(env.APP_URL || 'https://inishial.pages.dev').replace(/\/+$/, '');
  return `${base}/admin/reset/?token=${encodeURIComponent(token)}`;
}

/**
 * Mail a teacher a link to set a new password.
 *
 * Deliberately says almost nothing. This address may not belong to whoever
 * asked -- the request endpoint answers the same way for an address with an
 * account and one without, so that it cannot be used to find out which
 * teachers exist -- so the mail has to read sensibly to someone who did not
 * request it, and must not confirm anything about the account beyond the fact
 * that a reset was attempted.
 */
export async function sendPasswordReset(env, toEmail, token, minutes) {
  const url = resetUrl(env, token);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  return send(env, {
    to: toEmail,
    subject: RESET_SUBJECT,
    text: [
      'Someone asked to reset the iniSHial password for this address.',
      '',
      'Set a new one here:',
      `    ${url}`,
      '',
      `The link works once and expires in ${minutes} minutes.`,
      '',
      'If this was not you, nothing has changed and you can ignore this email.',
      'Your current password still works.',
      '',
      '-- iniSHial',
    ].join('\r\n'),
    html: [
      '<p>Someone asked to reset the iniSHial password for this address.</p>',
      `<p><a href="${esc(url)}">Set a new password</a></p>`,
      `<p style="color:#666;font-size:.9rem">Or paste this into your browser:<br>${esc(url)}</p>`,
      `<p>The link works once and expires in ${esc(minutes)} minutes.</p>`,
      '<p style="color:#666">If this was not you, nothing has changed and you can ignore this email. Your current password still works.</p>',
      '<p style="color:#999;font-size:.8rem">-- iniSHial</p>',
    ].join('\r\n'),
    // The token is a credential: it is the whole content of the link. Logged
    // in dry-run because that is a local console with no mail server, and it
    // is the only way to exercise the flow without one.
    dryRunLog: () => (loud(env)
      ? console.log('[mail:dry-run] reset to=%s url=%s', toEmail, url)
      : console.log('[mail:dry-run] reset to=%s %s', maskEmail(toEmail), HIDDEN)),
  });
}

// Both codes go to this address on purpose. A student who loses theirs has no
// way back in otherwise: district mail systems routinely block external senders
// for student accounts, so their school address is not a recovery path, and a
// parent sitting down to do this WITH their child needs both halves in reach.
//
// The cost is real and worth stating: whoever holds this email can sign as
// either party, so the two attestations are no longer independent for a family
// that shares an inbox. That was the deliberate trade -- recoverability over a
// separation that only held as long as nobody ever lost a slip of paper.
// This email is now the parent's ONLY source for their username, and the
// student's only recovery path for theirs. Sign-in takes a username and a code
// and asks for nothing else, so a pair that arrives half-complete is an account
// nobody can open -- which is why every line below is guarded rather than
// interpolated blind. A missing value drops its line; it never prints "null"
// under a heading telling someone to type it in.
function textBody(studentName, url, { parentCode, studentCode, parentUsername, studentUsername }) {
  const lines = [
    `Hi ${studentName}'s parent or guardian,`,
    '',
    `Open the syllabus here:`,
    `    ${url}`,
    '',
    `YOUR sign-in details (parent or guardian):`,
    '',
  ];
  if (parentUsername) lines.push(`    username:    ${parentUsername}`);
  lines.push(`    access code: ${parentCode}`, '');
  if (studentCode || studentUsername) {
    lines.push(`${studentName}'s own details, in case they have been lost:`, '');
    if (studentUsername) lines.push(`    username:    ${studentUsername}`);
    if (studentCode) lines.push(`    access code: ${studentCode}`);
    lines.push(
      '',
      `Keep these separate when you sign. Each of you initials your own copy,`,
      `so use your own code -- signing both as one person defeats the point.`,
      '',
    );
  }
  lines.push(
    `Enter your username and access code, then initial each section.`,
    '',
    `If you did not request this, you can ignore this email.`,
    '',
    `-- iniSHial`,
  );
  return lines.join('\r\n');
}

function htmlBody(studentName, url, { parentCode, studentCode, parentUsername, studentUsername }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const codeStyle = 'font-size:1.4rem;letter-spacing:.12em;font-weight:700;margin:.2rem 0';
  const nameStyle = 'font-size:1.1rem;font-weight:700;margin:.2rem 0';
  const out = [
    `<p>Hi ${esc(studentName)}'s parent or guardian,</p>`,
    `<p><a href="${esc(url)}">Open the syllabus</a></p>`,
    `<p style="color:#666;font-size:.9rem">Or paste this into your browser:<br>${esc(url)}</p>`,
  ];
  // See textBody: a missing value drops its line rather than printing "null".
  if (parentUsername) {
    out.push(
      `<p style="margin-bottom:0"><strong>Your username</strong> (parent or guardian):</p>`,
      `<p style="${nameStyle}">${esc(parentUsername)}</p>`,
    );
  }
  out.push(
    `<p style="margin-bottom:0"><strong>Your access code</strong>:</p>`,
    `<p style="${codeStyle}">${esc(parentCode)}</p>`,
  );
  if (studentCode || studentUsername) {
    out.push(`<p style="margin-bottom:0"><strong>${esc(studentName)}'s own details</strong>, in case they have been lost:</p>`);
    if (studentUsername) out.push(`<p style="${nameStyle}">${esc(studentUsername)}</p>`);
    if (studentCode) out.push(`<p style="${codeStyle}">${esc(studentCode)}</p>`);
    out.push(`<p style="color:#666">Keep these separate when you sign. Each of you initials your own copy, so use your own code &mdash; signing both as one person defeats the point.</p>`);
  }
  out.push(
    `<p>Enter your username and access code, then initial each section.</p>`,
    `<p style="color:#666">If you did not request this, you can ignore this email.</p>`,
    `<p style="color:#999;font-size:.8rem">-- iniSHial</p>`,
  );
  return out.join('\r\n');
}

/**
 * Send the parent's sign-in details to `toEmail`, and the student's with them.
 *
 * `creds` is { parentCode, studentCode, parentUsername, studentUsername }.
 * Only parentCode is required; each of the other three drops its own line when
 * absent. An object rather than four optional trailing positionals, because
 * that shape is what let an unset parentUsername reach a parent's inbox as the
 * word "null" -- a wrong argument in the right slot looks like nothing.
 *
 * Returns { ok: true, messageId, dryRun? } on success, or
 * { ok: false, code, message } on failure. Never throws -- the caller is a
 * public endpoint that reports honestly whether the mail went.
 */
export async function sendAccessCode(env, toEmail, studentName, creds) {
  return send(env, {
    to: toEmail,
    subject: SUBJECT,
    text: textBody(studentName, signUrl(env), creds),
    html: htmlBody(studentName, signUrl(env), creds),
    dryRunLog: () => (loud(env)
      ? console.log('[mail:dry-run] to=%s student=%s parentUser=%s code=%s studentUser=%s studentCode=%s',
        toEmail, studentName, creds.parentUsername || '(none)', creds.parentCode,
        creds.studentUsername || '(none)', creds.studentCode || '(none)')
      : console.log('[mail:dry-run] to=%s user=%s %s',
        maskEmail(toEmail), creds.parentUsername || '(none)', HIDDEN)),
  });
}

/**
 * Put one message on the wire. Sending is identical for every mail this app
 * sends, so it lives here once rather than being copied per message type --
 * the credentials check, the dry-run branch and the error mapping are all
 * things that would drift if there were two of them.
 *
 * Returns { ok: true, messageId, dryRun? } on success, or
 * { ok: false, code, message } on failure. Never throws -- every caller is an
 * endpoint that has to report honestly whether the mail went.
 */
async function send(env, { to, subject, text, html, dryRunLog }) {
  // Replies go to a mailbox a human reads, not to the no-reply sender.
  const replyTo = env.MAIL_REPLY_TO || 'inishial-support@lefthanddev.com';

  // No credentials and no dry-run: tell the truth. A 502 "could not send" is
  // better than a silent success that leaves someone waiting at a screen that
  // says "check your inbox".
  if (!env.SMTP_HOSTNAME || !env.SMTP_USERNAME || !env.SMTP_PASSWORD) {
    if (env.MAIL_DRY_RUN) {
      dryRunLog?.();
      return { ok: true, dryRun: true, messageId: 'dry-run' };
    }
    return { ok: false, code: 'E_NO_CREDS', message: 'Mail server credentials are not configured on this deployment.' };
  }

  try {
    const sent = await sendViaSmtp(env, { to, subject, text, html, replyTo });
    return { ok: true, messageId: sent.messageId };
  } catch (err) {
    return {
      ok: false,
      code: err?.code || 'E_SEND_FAILED',
      message: err?.message || 'The mail could not be sent.',
    };
  }
}
