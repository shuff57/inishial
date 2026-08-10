// POST /api/admin/reset   -- ask for a reset link  { email }
// PUT  /api/admin/reset   -- set a new password    { token, password }
//
// The way back into a teacher account, and now the only one. Before this there
// was none: nothing emailed a teacher address, so a forgotten password ended
// the account and the class with it. The shared ADMIN_PASSWORD_HASH was kept as
// break-glass for exactly that, and could not do it -- scoped to unowned
// courses (owns() in _lib/http.js), it never reached a teacher's own. This
// endpoint is what let that credential be retired.
//
// Both halves are public, which decides most of what follows.
//
// NO ORACLE. POST answers identically for an address with an account and one
// without. Sign-up already refuses to say whether an address is taken -- it
// returns the same 409 shape for any collision -- and a reset form that
// happily reported "no account with that address" would hand back exactly what
// that was protecting. The cost is a teacher who mistypes their address gets a
// cheerful "check your inbox" and no email; the alternative is a public list
// of who works at the school.
//
// The token is 32 random bytes, not an 8-character access code. A code lives
// behind a rate-limited form a human types into; this lives in a URL, and a URL
// that sets a password is worth brute-forcing offline if it is short. It is
// stored hashed for the same reason the access codes are -- a reset link is a
// live credential sitting in an inbox, and it should not also be readable out
// of the database.

import { json, badRequest, serverMisconfigured, readJson } from '../../_lib/http.js';
import { hashCode, verifyCode } from '../../_lib/codes.js';
import { hit, clientIp } from '../../_lib/ratelimit.js';
import { sendPasswordReset } from '../../_lib/mail.js';
import { normalizeEmail, looksLikeEmail, passwordProblem } from '../../_lib/teachers.js';

// Long enough to walk to a different device and find the mail; short enough
// that a link left in an inbox is not a standing key to the account.
const TTL_SEC = 30 * 60;
const TTL_MIN = TTL_SEC / 60;

// Said whether or not anything was sent. See the header.
const SENT = 'If that address has an account, a reset link is on its way. It expires in 30 minutes.';

/** A URL-safe token with real entropy behind it. */
function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!email || !looksLikeEmail(email)) return badRequest('Enter your email address.');

  const nowSec = Math.floor(Date.now() / 1000);

  // Per IP. Tight, because the honest rate is a couple of resets a term and
  // anything faster is either someone walking a list of addresses or trying to
  // bury a real reset mail under noise.
  const limit = await hit(env.DB, `reset:${clientIp(request)}`, nowSec, { max: 5, windowSec: 60 * 60 });
  if (!limit.allowed) {
    return json({ error: 'Too many reset requests. Try again later.' }, 429,
      { 'Retry-After': String(limit.retryAfter) });
  }

  const teacher = await env.DB.prepare('SELECT id FROM teachers WHERE email = ?1').bind(email).first();

  // No account: stop here, and say exactly what the success path says.
  if (!teacher) return json({ ok: true, message: SENT });

  const token = generateToken();
  await env.DB.prepare(
    'UPDATE teachers SET reset_hash = ?1, reset_expires_at = ?2 WHERE id = ?3',
  ).bind(await hashCode(token), nowSec + TTL_SEC, teacher.id).run();

  const sent = await sendPasswordReset(env, email, token, TTL_MIN);
  if (!sent.ok) {
    // Undo the issue rather than leave a live token nobody received.
    await env.DB.prepare(
      'UPDATE teachers SET reset_hash = NULL, reset_expires_at = NULL WHERE id = ?1',
    ).bind(teacher.id).run();
    // The one case worth breaking the no-oracle rule for: this is a server
    // fault, not a statement about the address. Saying "check your inbox" here
    // would strand a locked-out teacher waiting on a mail that never went.
    return json({ error: 'Could not send the reset email right now. Try again in a moment.' }, 502);
  }

  // EXACTLY the body the no-account path returns, field for field. It carried
  // `dry_run` for a while and that was an enumeration oracle on its own: an
  // address with an account came back with the extra key and one without did
  // not, so the two were trivially distinguishable no matter how carefully the
  // message was worded. Nothing read the field. If a local-development signal
  // is ever wanted again, it belongs in a log line, not in a public response.
  return json({ ok: true, message: SENT });
}

export async function onRequestPut({ request, env }) {
  if (!env.DB) return serverMisconfigured('the DB binding');

  const body = await readJson(request);
  const token = String(body?.token ?? '').trim();
  const password = String(body?.password ?? '');
  if (!token) return badRequest('That reset link is not valid. Ask for a new one.');

  const nowSec = Math.floor(Date.now() / 1000);

  // Rate limited too: this endpoint takes a guessable-in-principle secret, and
  // an unlimited one would be an offline attack with extra steps.
  const limit = await hit(env.DB, `resetput:${clientIp(request)}`, nowSec, { max: 10, windowSec: 60 * 60 });
  if (!limit.allowed) {
    return json({ error: 'Too many attempts. Try again later.' }, 429,
      { 'Retry-After': String(limit.retryAfter) });
  }

  // Every unexpired candidate, because the token itself names nobody -- the
  // link deliberately carries no email, so a reset URL in an inbox does not
  // also disclose which account it belongs to. In practice this is one row:
  // resets are rare and live for half an hour.
  const { results: rows = [] } = await env.DB.prepare(
    'SELECT id, email, reset_hash FROM teachers WHERE reset_hash IS NOT NULL AND reset_expires_at > ?1',
  ).bind(nowSec).all();

  let teacher = null;
  for (const row of rows) {
    if (await verifyCode(token, row.reset_hash)) { teacher = row; break; }
  }
  if (!teacher) {
    return badRequest('That reset link has expired or has already been used. Ask for a new one.');
  }

  // Checked AFTER the token, so a bad password on a good link says so, and a
  // bad link never gets to comment on the password.
  const problem = passwordProblem(password, teacher.email);
  if (problem) return badRequest(problem);

  // Password, token and session generation all move in ONE statement.
  //
  // The generation bump is what makes this a real reset rather than a new
  // password beside an old session. Someone who reached the account before
  // this -- which is the usual reason a reset gets asked for -- is signed out
  // by it, on every device they hold. Changing the password alone would leave
  // them exactly where they were.
  //
  // One UPDATE, not three: if the password moved and the generation did not,
  // the account would report itself reset while still open to whoever it was
  // being taken back from, and nothing would say so.
  await env.DB.prepare(
    `UPDATE teachers
        SET password_hash = ?1, reset_hash = NULL, reset_expires_at = NULL,
            session_gen = session_gen + 1
      WHERE id = ?2`,
  ).bind(await hashCode(password), teacher.id).run();

  // Not signed in here. The new password is typed once on this page and once
  // at sign-in, which is the confirmation step this form does not otherwise
  // have -- and it means the reset link alone never becomes a session.
  return json({ ok: true, email: teacher.email });
}
