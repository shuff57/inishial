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

function textBody(studentName, code, url) {
  return [
    `Hi ${studentName}'s parent or guardian,`,
    '',
    `Here is the access code you need to read and initial the course syllabus:`,
    '',
    `    ${code}`,
    '',
    `Open the syllabus here:`,
    `    ${url}`,
    '',
    `Enter your student's ID number and this code, then initial each section.`,
    '',
    `If you did not request this code, you can ignore this email.`,
    '',
    `-- iniSHial`,
  ].join('\r\n');
}

function htmlBody(studentName, code, url) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  return [
    `<p>Hi ${esc(studentName)}'s parent or guardian,</p>`,
    `<p>Here is the access code you need to read and initial the course syllabus:</p>`,
    `<p style="font-size:1.4rem;letter-spacing:.12em;font-weight:700">${esc(code)}</p>`,
    `<p><a href="${esc(url)}">Open the syllabus</a></p>`,
    // The bare URL as well as the link: some clients strip anchors, and a
    // parent who cannot see where a link goes is right not to trust it.
    `<p style="color:#666;font-size:.9rem">Or paste this into your browser:<br>${esc(url)}</p>`,
    `<p>Enter your student's ID number and this code, then initial each section.</p>`,
    `<p style="color:#666">If you did not request this code, you can ignore this email.</p>`,
    `<p style="color:#999;font-size:.8rem">-- iniSHial</p>`,
  ].join('\r\n');
}

/**
 * Send the parent's access code to `toEmail`.
 *
 * Returns { ok: true, messageId, dryRun? } on success, or
 * { ok: false, code, message } on failure. Never throws -- the caller is a
 * public endpoint that reports honestly whether the mail went.
 */
export async function sendAccessCode(env, toEmail, studentName, code) {
  // The mail subdomain, not the apex: huffpalmer.fyi's MX belongs to Cloudflare
  // Email Routing, and a transactional sender on its own subdomain keeps a spam
  // complaint here from dragging down the apex domain's reputation.
  const from = env.MAIL_FROM || 'no-reply@mail.huffpalmer.fyi';
  const replyTo = env.MAIL_REPLY_TO || 'support@mail.huffpalmer.fyi';

  // No credentials and no dry-run: tell the truth. A 502 "could not send" is
  // better than a silent success that leaves the parent waiting at a screen
  // that says "check your inbox".
  if (!env.STALWART_URL || !env.STALWART_API_KEY) {
    if (env.MAIL_DRY_RUN) {
      console.log('[mail:dry-run] to=%s from=%s student=%s code=%s',
        toEmail, from, studentName, code);
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
            to: [{ email: toEmail }],
            replyTo: [{ email: replyTo }],
            subject: SUBJECT,
            textBody: [{ partId: 't', type: 'text/plain' }],
            htmlBody: [{ partId: 'h', type: 'text/html' }],
            bodyValues: {
              t: { value: textBody(studentName, code, signUrl(env)) },
              h: { value: htmlBody(studentName, code, signUrl(env)) },
            },
          },
        },
      }, 'c0'],
      ['EmailSubmission/set', {
        accountId: s.accountId,
        create: {
          s1: {
            emailId: '#e1',
            identityId: s.identityId,
            envelope: { mailFrom: { email: from }, rcptTo: [{ email: toEmail }] },
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
