// Outbound email over SMTP submission (AUTH LOGIN) with a mailbox login.
//
// Ported from raSHio's functions/utils/smtp.js, and shaped like verSHion's
// worker/src/mail_smtp.ts: Cloudflare's TCP sockets (`cloudflare:sockets`) to
// the owner's Stalwart server, smtp.huffpalmer.fyi. Port 465 is implicit TLS
// (the TLS handshake comes first); any other port starts in the clear and
// upgrades with STARTTLS. It authenticates as the app's own mailbox with a
// Stalwart app password. Workers may not open port 25, which is why this is
// submission with a login, not a relay.
//
// Stalwart DKIM-signs for lefthanddev.com and the sending IP is the domain's MX,
// so SPF and DKIM both align and the domain's DMARC reject policy passes. The
// same code also works against Gmail (smtp.gmail.com:587 and an app password) if
// SMTP_HOSTNAME and SMTP_PORT are changed; Gmail would then send as the account
// that signs in, whatever MAIL_FROM says.
//
// Differences from the raSHio original, all for a mail that carries a parent's
// credentials:
//   - a response reader that keeps leftover bytes and understands multi-line
//     replies ("250-..." continues until "250 ..."), so two replies landing in
//     one network chunk cannot be dropped
//   - a timeout on every read, so a stalled connection fails the request
//     instead of hanging the parent at a spinner
//   - bodies are base64, so a student's name with an accent survives and no
//     body line can end DATA early or fake a MIME boundary
//   - a non-ASCII Subject or display name is RFC 2047 encoded
//   - every header value is stripped of CR/LF, and the recipient must look like
//     a bare address, so nothing the caller passes can add headers or recipients
//
// The socket opener is read from env.SMTP_CONNECT when present so tests can swap
// in a fake server; production never sets it and gets the real one.

const READ_TIMEOUT_MS = 15000;

function smtpError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const noCRLF = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

// Bare address only: no display name, angle brackets, quotes, commas or spaces.
const BARE_ADDRESS = /^[^\s<>"',;:\\]+@[^\s<>"',;:\\]+$/;

const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);
const utf8Bytes = (s) => new TextEncoder().encode(s);

function b64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64Lines = (s) => b64(utf8Bytes(s)).replace(/(.{76})/g, '$1\r\n');

/** RFC 2047: =?UTF-8?B?...?= for anything that is not plain printable ASCII. */
function encodeHeader(value) {
  const v = noCRLF(value);
  return isAscii(v) ? v : `=?UTF-8?B?${b64(utf8Bytes(v))}?=`;
}

/** A quoted display name: ASCII gets quotes (and escapes), anything else is encoded. */
function displayName(name) {
  const v = noCRLF(name);
  if (!v) return '';
  if (!isAscii(v)) return encodeHeader(v);
  return `"${v.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Reads SMTP replies off a stream. Keeps a buffer across calls, and a reply is
 * complete when a line starts with three digits then a space.
 */
function makeReader(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseOne = () => {
    const lines = buffer.split('\r\n');
    // The last element is an unterminated partial line (or '') -- not usable yet.
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const taken = lines.slice(0, i + 1);
        buffer = lines.slice(i + 1).join('\r\n');
        return { code: Number(taken[i].slice(0, 3)), text: taken.join('\n') };
      }
    }
    return null;
  };

  const read = async () => {
    for (;;) {
      const got = parseOne();
      if (got) return got;
      let timer;
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(smtpError('E_SMTP_TIMEOUT', 'The mail server did not answer in time.')), READ_TIMEOUT_MS);
      });
      let chunk;
      try { chunk = await Promise.race([reader.read(), timeout]); } finally { clearTimeout(timer); }
      if (chunk.done) throw smtpError('E_SMTP_CLOSED', 'The mail server closed the connection.');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  return { read, release: () => { try { reader.releaseLock(); } catch { /* already released */ } } };
}

function makeWriter(writable) {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  return {
    send: (line) => writer.write(encoder.encode(line + '\r\n')),
    raw: (data) => writer.write(encoder.encode(data)),
    release: () => { try { writer.releaseLock(); } catch { /* already released */ } },
  };
}

function expect(reply, ok, code, what) {
  const accepted = Array.isArray(ok) ? ok.includes(reply.code) : reply.code === ok;
  if (!accepted) {
    // Keep the server's first line (it names the reason) but never echo anything
    // the client sent, so a credential cannot be reflected into a log or response.
    throw smtpError(code, `${what}: ${reply.text.split('\n')[0].slice(0, 160)}`);
  }
}

/** The host to announce in EHLO and Message-ID: APP_URL's, else a fixed fallback. */
function localHost(env) {
  try { return new URL(env.APP_URL).hostname; } catch { return 'inishial.pages.dev'; }
}

/** Port 465 is implicit TLS; SMTP_SECURE can force either mode (like verSHion's). */
function smtpPort(env) {
  const n = Number(env.SMTP_PORT ?? '465');
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 465;
}
function smtpImplicitTls(env) {
  const v = String(env.SMTP_SECURE ?? '').trim().toLowerCase();
  if (['on', '1', 'true', 'implicit'].includes(v)) return true;
  if (['off', '0', 'false', 'starttls'].includes(v)) return false;
  return smtpPort(env) === 465;
}

/**
 * The address on the envelope and in From: MAIL_FROM when set (an address this
 * mailbox may send as, such as one of its aliases), else the mailbox that signs
 * in. A bare address only, because Stalwart answers 501 to the "Name <addr>" form.
 */
function fromAddress(env, user) {
  const f = noCRLF(env.MAIL_FROM || '');
  if (!f) return user;
  if (!BARE_ADDRESS.test(f)) throw smtpError('E_SMTP_BAD_FROM', 'MAIL_FROM must be a plain email address.');
  return f;
}

/**
 * Sends one message. Resolves { messageId } or throws an Error with `.code`.
 *   login         = env.SMTP_USERNAME + env.SMTP_PASSWORD (a Stalwart app password)
 *   from address  = env.MAIL_FROM, else SMTP_USERNAME
 *   from name     = env.SMTP_FROM_NAME || 'iniSHial'
 *   reply-to      = replyTo, optional
 */
export async function sendViaSmtp(env, { to, subject, text, html, replyTo }) {
  const user = String(env.SMTP_USERNAME || '').trim();
  const pass = String(env.SMTP_PASSWORD || '').replace(/\s/g, ''); // Google shows app passwords in spaced groups
  if (!user || !pass) throw smtpError('E_NO_CREDS', 'SMTP credentials are not configured (SMTP_USERNAME, SMTP_PASSWORD).');

  to = noCRLF(to);
  if (!BARE_ADDRESS.test(to)) throw smtpError('E_SMTP_BAD_RECIPIENT', 'The recipient is not a plain email address.');
  const reply = replyTo ? noCRLF(replyTo) : '';
  if (reply && !BARE_ADDRESS.test(reply)) throw smtpError('E_SMTP_BAD_REPLY_TO', 'The reply-to is not a plain email address.');

  // No default host: a missing setting must fail, not quietly send somewhere.
  const hostname = String(env.SMTP_HOSTNAME || '').trim();
  if (!hostname) throw smtpError('E_NO_CREDS', 'SMTP_HOSTNAME is not configured.');
  const port = smtpPort(env);
  const implicit = smtpImplicitTls(env);
  const from = fromAddress(env, user);
  const me = localHost(env);

  const connect = env.SMTP_CONNECT || (await import('cloudflare:sockets')).connect;
  let socket;
  try {
    // 'on' = TLS from the first byte (port 465). 'starttls' keeps the socket
    // upgradable after the greeting.
    socket = connect({ hostname, port }, { secureTransport: implicit ? 'on' : 'starttls' });
  } catch (err) {
    throw smtpError('E_SMTP_CONNECT', `Could not reach the mail server: ${String(err?.message || err).slice(0, 120)}`);
  }

  let w = makeWriter(socket.writable);
  let r = makeReader(socket.readable);
  try {
    expect(await r.read(), 220, 'E_SMTP_GREETING', 'Mail server greeting');

    await w.send(`EHLO ${me}`);
    expect(await r.read(), 250, 'E_SMTP_EHLO', 'EHLO refused');

    if (!implicit) {
      await w.send('STARTTLS');
      expect(await r.read(), 220, 'E_SMTP_STARTTLS', 'STARTTLS refused');

      // Nothing may be buffered across the upgrade; hand the socket to TLS.
      w.release(); r.release();
      const secure = socket.startTls();
      w = makeWriter(secure.writable);
      r = makeReader(secure.readable);

      await w.send(`EHLO ${me}`);
      expect(await r.read(), 250, 'E_SMTP_EHLO', 'EHLO refused after TLS');
    }

    await w.send('AUTH LOGIN');
    expect(await r.read(), 334, 'E_SMTP_AUTH', 'AUTH LOGIN refused');
    await w.send(btoa(user));
    expect(await r.read(), 334, 'E_SMTP_AUTH', 'Username refused');
    await w.send(btoa(pass));
    expect(await r.read(), 235, 'E_SMTP_AUTH', 'Sign-in to the mail server failed');

    await w.send(`MAIL FROM:<${from}>`);
    expect(await r.read(), 250, 'E_SMTP_MAIL_FROM', 'Sender refused');
    await w.send(`RCPT TO:<${to}>`);
    expect(await r.read(), [250, 251], 'E_SMTP_RCPT', 'Recipient refused');
    await w.send('DATA');
    expect(await r.read(), 354, 'E_SMTP_DATA', 'DATA refused');

    const boundary = `inishial_${crypto.randomUUID().replace(/-/g, '')}`;
    const messageId = `<${crypto.randomUUID()}@${me}>`;
    const name = displayName(env.SMTP_FROM_NAME || 'iniSHial');
    const parts = [
      `From: ${name ? name + ' ' : ''}<${from}>`,
      `To: ${to}`,
      ...(reply ? [`Reply-To: ${reply}`] : []),
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64Lines(text ?? ''),
      ...(html ? [
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        b64Lines(html),
      ] : []),
      `--${boundary}--`,
    ];
    // base64 never yields a line that is just "." so no dot-stuffing is needed.
    await w.raw(parts.join('\r\n') + '\r\n.\r\n');
    expect(await r.read(), 250, 'E_SMTP_REJECTED', 'Message refused');

    try { await w.send('QUIT'); } catch { /* the message is already accepted */ }
    return { messageId };
  } finally {
    w.release(); r.release();
    try { socket.close(); } catch { /* already closed */ }
  }
}
