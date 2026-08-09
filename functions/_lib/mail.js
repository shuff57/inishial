// Outbound transactional email via Stalwart's JMAP API.
//
// The one mail this app sends: a parent's access code, on demand, from the
// parent self-signup page. Nothing else emails the parent -- the teacher's
// export is still a CSV the teacher mails themselves -- so this is the entire
// surface.
//
// JMAP is used over SMTP because Cloudflare Workers cannot open raw TCP
// sockets, which SMTP needs. JMAP is HTTPS: a fetch() to the mail server's
// API URL with an `Authorization: Bearer <api key>` header.
//
// Sending is two JMAP method calls in one request: Email/set creates the
// message in Drafts, EmailSubmission/set hands it to the queue. The draft is
// destroyed on success (onSuccessDestroyEmail) so nothing accumulates.
//
// Before either can run we need three ids the server assigns: the mail
// accountId, an identityId (which From address the submission is allowed to
// use), and the Drafts mailbox id (Email/set requires mailboxIds). Those come
// from the JMAP session document plus one Identity/get + Mailbox/get call,
// cached at module level for the life of the isolate. Concurrency-safe: the
// in-flight bootstrap is shared so two sends landing together wait on one
// promise rather than racing.
//
// In dev and tests there are no secrets. MAIL_DRY_RUN makes that a log line
// instead of an error, so the flow can be exercised end-to-end without
// credentials. Without either secrets or the dry-run flag, this returns an
// honest failure so the parent endpoint can tell the parent the mail did
// not go, rather than claiming it did.

const SUBJECT = 'Your access code for the course syllabus';
const RESET_SUBJECT = 'Reset your iniSHial teacher password';

const USING = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:submission',
];

// Module-level bootstrap cache: { apiUrl, accountId, identityId, draftsId }.
// One isolate serves many requests; caching saves two round-trips on every
// send after the first. Cleared on a 401 so a rotated key cannot wedge the
// isolate into failing every send until it recycles.
let session = null;
let sessionInFlight = null;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function headers(env) {
  return {
    'Authorization': `Bearer ${env.STALWART_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** The method response tagged with `id`, or throws if the server errored on it. */
function responseFor(body, id) {
  const found = (body?.methodResponses || []).find((m) => m[2] === id);
  if (!found) throw fail('E_STALWART_NO_RESPONSE', `The mail server did not answer the ${id} call.`);
  if (found[0] === 'error') {
    throw fail(`E_STALWART_${String(found[1]?.type || 'ERROR').toUpperCase()}`,
      found[1]?.description || `The mail server rejected the ${id} call.`);
  }
  return found[1];
}

async function jmap(env, apiUrl, methodCalls) {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ using: USING, methodCalls }),
  });
  if (!res.ok) {
    if (res.status === 401) session = null;
    let detail = '';
    try { detail = (await res.json())?.detail || ''; } catch { /* not JSON */ }
    throw fail(`E_STALWART_${res.status}`, detail || `The mail server returned ${res.status}.`);
  }
  return res.json();
}

async function getSession(env) {
  if (session) return session;
  if (sessionInFlight) return sessionInFlight;
  sessionInFlight = (async () => {
    const base = String(env.STALWART_URL).replace(/\/+$/, '');
    const res = await fetch(`${base}/.well-known/jmap`, { headers: headers(env) });
    if (!res.ok) {
      throw fail(`E_STALWART_SESSION_${res.status}`,
        `The mail server session request returned ${res.status}.`);
    }
    const doc = await res.json();
    const accountId = doc?.primaryAccounts?.['urn:ietf:params:jmap:mail'];
    if (!accountId) throw fail('E_STALWART_NO_ACCOUNT', 'The API key has no mail account.');
    // Take only the PATH the session advertises, and pin it to STALWART_URL's
    // origin. Two reasons. Practically: a server that does not know it is
    // published on a non-standard port advertises an apiUrl without the port
    // (Stalwart does exactly this), and following it lands somewhere else
    // entirely. In principle: the API key rides on this request, so the origin
    // it is sent to must be the one we configured, never one the response
    // picked for us.
    const advertised = new URL(doc.apiUrl || '/jmap', base);
    const apiUrl = new URL(advertised.pathname + advertised.search, base).toString();

    const from = String(env.MAIL_FROM || '').toLowerCase();
    const body = await jmap(env, apiUrl, [
      ['Identity/get', { accountId, ids: null }, 'i'],
      ['Mailbox/get', { accountId, ids: null, properties: ['id', 'role'] }, 'm'],
    ]);
    const identities = responseFor(body, 'i')?.list || [];
    const mailboxes = responseFor(body, 'm')?.list || [];

    // Prefer the identity that owns MAIL_FROM -- a key with several identities
    // would otherwise send as whichever happened to be listed first, and the
    // submission would be refused or rewritten.
    const identity = identities.find((x) => String(x.email).toLowerCase() === from) || identities[0];
    const drafts = mailboxes.find((b) => b.role === 'drafts');
    if (!identity) throw fail('E_STALWART_NO_IDENTITY', 'The mail account has no send identity.');
    if (!drafts) throw fail('E_STALWART_NO_DRAFTS', 'The mail account has no Drafts mailbox.');

    session = { apiUrl, accountId, identityId: identity.id, draftsId: drafts.id };
    return session;
  })().finally(() => { sessionInFlight = null; });
  return sessionInFlight;
}

/** Where the parent actually goes. `/sign` is a client-side route, so the
 *  path is the same on any host. Configurable because the app will move off
 *  pages.dev to a huffpalmer.fyi hostname, and a mail whose link points at a
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
    dryRunLog: () => console.log('[mail:dry-run] reset to=%s url=%s', toEmail, url),
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
    dryRunLog: () => console.log(
      '[mail:dry-run] to=%s student=%s parentUser=%s code=%s studentUser=%s studentCode=%s',
      toEmail, studentName, creds.parentUsername || '(none)', creds.parentCode,
      creds.studentUsername || '(none)', creds.studentCode || '(none)'),
  });
}

/**
 * Put one message on the wire. The JMAP dance is identical for every mail this
 * app sends, so it lives here once rather than being copied per message type --
 * the bootstrap cache, the dry-run branch, and the two-call create-then-submit
 * are all things that would drift if there were two of them.
 *
 * Returns { ok: true, messageId, dryRun? } on success, or
 * { ok: false, code, message } on failure. Never throws -- every caller is an
 * endpoint that has to report honestly whether the mail went.
 */
async function send(env, { to, subject, text, html, dryRunLog }) {
  // The mail subdomain, not the apex: huffpalmer.fyi's MX belongs to Cloudflare
  // Email Routing, and a transactional sender on its own subdomain keeps a spam
  // complaint here from dragging down the apex domain's reputation.
  const from = env.MAIL_FROM || 'no-reply@mail.huffpalmer.fyi';
  const replyTo = env.MAIL_REPLY_TO || 'support@mail.huffpalmer.fyi';

  // No credentials and no dry-run: tell the truth. A 502 "could not send" is
  // better than a silent success that leaves someone waiting at a screen that
  // says "check your inbox".
  if (!env.STALWART_URL || !env.STALWART_API_KEY) {
    if (env.MAIL_DRY_RUN) {
      dryRunLog?.();
      return { ok: true, dryRun: true, messageId: 'dry-run' };
    }
    return { ok: false, code: 'E_NO_CREDS', message: 'Mail server credentials are not configured on this deployment.' };
  }

  try {
    const s = await getSession(env);
    const body = await jmap(env, s.apiUrl, [
      ['Email/set', {
        accountId: s.accountId,
        create: {
          e1: {
            mailboxIds: { [s.draftsId]: true },
            keywords: { $draft: true },
            from: [{ name: 'iniSHial', email: from }],
            to: [{ email: to }],
            replyTo: [{ email: replyTo }],
            subject,
            textBody: [{ partId: 't', type: 'text/plain' }],
            htmlBody: [{ partId: 'h', type: 'text/html' }],
            bodyValues: { t: { value: text }, h: { value: html } },
          },
        },
      }, 'c0'],
      ['EmailSubmission/set', {
        accountId: s.accountId,
        create: {
          s1: {
            emailId: '#e1',
            identityId: s.identityId,
            envelope: { mailFrom: { email: from }, rcptTo: [{ email: to }] },
          },
        },
        // ponytail: the draft is destroyed once queued, so nothing accumulates
        // in Drafts. No Sent copy -- swap this for onSuccessUpdateEmail moving
        // it to Sent if an outbound archive is ever wanted.
        onSuccessDestroyEmail: ['#s1'],
      }, 'c1'],
    ]);

    const created = responseFor(body, 'c0');
    if (!created?.created?.e1) {
      const why = created?.notCreated?.e1;
      throw fail(`E_STALWART_${String(why?.type || 'EMAIL_REJECTED').toUpperCase()}`,
        why?.description || 'The mail server would not accept the message.');
    }
    const submitted = responseFor(body, 'c1');
    if (!submitted?.created?.s1) {
      const why = submitted?.notCreated?.s1;
      throw fail(`E_STALWART_${String(why?.type || 'SUBMIT_REJECTED').toUpperCase()}`,
        why?.description || 'The mail server would not queue the message.');
    }
    return { ok: true, messageId: submitted.created.s1.id };
  } catch (err) {
    return {
      ok: false,
      code: err?.code || 'E_SEND_FAILED',
      message: err?.message || 'The mail could not be sent.',
    };
  }
}
