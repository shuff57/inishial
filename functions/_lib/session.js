// Signed session cookie for a parent or student who has entered a valid
// access code. HS256 over WebCrypto, adapted from bookshelf's
// functions/_lib/studio_jwt.js.
//
// Deliberately short-lived and single-purpose: it says "this browser proved it
// holds the access code for account N, acting as role R". It grants nothing
// beyond reading and initialing that one account's syllabus.
//
// Secret is a Pages secret, never in the repo:
//   npx wrangler pages secret put SESSION_SECRET --project-name inishial

const enc = new TextEncoder();
const dec = new TextDecoder();

const TTL_SEC = 2 * 60 * 60; // two hours; long enough to read a syllabus
export const COOKIE_NAME = 'inishial_session';

// 'teacher' is the admin session. It shares this signed-cookie scheme, but every
// consumer checks the role explicitly: a parent cookie must never reach an admin
// route, and a teacher cookie must never sign anything.
const ROLES = new Set(['parent', 'student', 'teacher']);
export const SIGNER_ROLES = new Set(['parent', 'student']);

function b64urlFromBytes(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64url(b64) {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  const s = atob(padded + '==='.slice((padded.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const b64urlJson = (obj) => b64urlFromBytes(enc.encode(JSON.stringify(obj)));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Mint a session token for an identity (or teacher) id acting as `role`.
 *
 *  `sub` is an identity id for parent/student sessions, a teacher id for admin
 *  sessions. The field is opaque to this function -- callers decide what it
 *  carries.
 *
 *  `email` is carried only for a signed-up teacher, so the roster-import audit
 *  trail can record who uploaded a file. It is a convenience, never a
 *  credential: authorisation reads `sub` and `role`, both of which are covered
 *  by the signature, and nothing trusts this field to decide access.
 *
 *  `gen` is the session generation for parent/student tokens -- see
 *  migrations/0014. Omitted for teachers, who have no sign-out revocation.
 *
 *  An options object rather than two more optional positionals: `email` was
 *  already trailing and optional, and a second one beside it is the shape that
 *  quietly put the word "null" in a parent's inbox over in _lib/mail.js. */
export async function signSession(env, sub, role, nowSec, { email, gen } = {}) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not configured');
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub, role, iat: nowSec, exp: nowSec + TTL_SEC };
  if (email) payload.email = email;
  if (gen) payload.gen = gen;
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET), enc.encode(input));
  return `${input}.${b64urlFromBytes(sig)}`;
}

/** Verify signature and expiry. Returns claims, or null. Never throws. */
export async function verifySession(env, token, nowSec) {
  if (!env.SESSION_SECRET || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  let header;
  try { header = JSON.parse(dec.decode(bytesFromB64url(h))); } catch { return null; }
  // Pin the algorithm. Trusting the header's `alg` is how "alg: none" happens.
  if (!header || header.alg !== 'HS256') return null;

  let ok;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_SECRET), bytesFromB64url(s), enc.encode(`${h}.${p}`));
  } catch { return null; }
  if (!ok) return null;

  let claims;
  try { claims = JSON.parse(dec.decode(bytesFromB64url(p))); } catch { return null; }
  if (!claims || typeof claims.exp !== 'number' || claims.exp < nowSec) return null;
  if (!ROLES.has(claims.role)) return null;
  if (!Number.isInteger(claims.sub)) return null;
  return claims;
}

export function sessionCookie(token) {
  // HttpOnly so script cannot read it; SameSite=Lax so a cross-site POST
  // cannot ride the session; Secure because this is only ever served over TLS.
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL_SEC}`;
}

export const clearCookie = () =>
  `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

export function readCookie(request, name = COOKIE_NAME) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** Claims for the current request, or null.
 *
 *  Signature-only: this says the cookie is authentic and unexpired, nothing
 *  more. Signer routes want currentSigner() below, which also asks whether the
 *  session was signed out. */
export async function currentSession(request, env, nowSec) {
  return verifySession(env, readCookie(request), nowSec);
}

// The session-generation column for each signer role. Two columns because
// parent and student share one student_identities row and are two different
// people: a student signing out must not end their parent's session. See
// migration 0014, including why this is a counter and not a timestamp.
const GEN_COLUMN = { parent: 'parent_session_gen', student: 'student_session_gen' };

/** The current session generation for one side of an identity, or null if the
 *  identity is gone. Sign-in stamps this into the token it mints. */
export async function sessionGen(env, identityId, role) {
  const column = GEN_COLUMN[role];
  if (!column || !env.DB) return null;
  const row = await env.DB.prepare(
    `SELECT ${column} AS gen FROM student_identities WHERE id = ?1`,
  ).bind(identityId).first();
  return row ? (row.gen ?? 0) : null;
}

/**
 * Claims for a parent or student who is still signed in, or null.
 *
 * Three questions, and every signer route needs all three: is the cookie
 * authentic and unexpired (verifySession), is it a SIGNER rather than a teacher
 * cookie, and has this person signed out since it was minted.
 *
 * The third is why this exists. The token is stateless, so clearing the cookie
 * only asks the browser to forget it -- a copy captured beforehand kept working
 * for the rest of its two hours. A token whose generation is not the current
 * one was minted before a sign-out and is dead.
 *
 * A token with no `gen` at all predates migration 0014 and reads as generation
 * 0, which is what every untouched row still holds -- so shipping this does not
 * sign anyone out.
 *
 * One lookup by primary key per signer request. These routes already run
 * several queries; this is not the expensive one.
 */
export async function currentSigner(request, env, nowSec) {
  const claims = await currentSession(request, env, nowSec);
  // A teacher session is not a signer. Explicit, so an admin cookie can never
  // produce a signature attributed to a parent.
  if (!claims || !SIGNER_ROLES.has(claims.role)) return null;
  if (!env.DB) return claims;

  const current = await sessionGen(env, claims.sub, claims.role);
  // null means the identity is gone; a token for it is not a live session.
  if (current === null) return null;
  if ((claims.gen ?? 0) !== current) return null;
  return claims;
}

/**
 * End every session this person holds, by moving their generation on.
 *
 * Scoped to the ROLE in the token, so a student signing out on a Chromebook
 * leaves their parent signed in on a phone. Incremented in SQL rather than
 * read-then-written, so two sign-outs racing each other cannot land on the
 * same number and leave one of the sessions alive.
 *
 * Best-effort: the caller clears the cookie whether or not this succeeds,
 * because a browser that has forgotten its token is still better than one
 * that has not.
 */
export async function revokeSigner(env, claims) {
  const column = GEN_COLUMN[claims?.role];
  if (!column || !env.DB || !Number.isInteger(claims.sub)) return false;
  await env.DB.prepare(
    `UPDATE student_identities SET ${column} = ${column} + 1 WHERE id = ?1`,
  ).bind(claims.sub).run();
  return true;
}

// ---- the same thing for teachers ----
//
// Separate functions rather than one parameterised by table and column: two
// tables, two shapes, and the shared-password case below has no row at all.
// Generalising these would cost more in indirection than the duplication does
// in lines.

/** The current session generation for a teacher, or null if there is no such
 *  row. Sign-in stamps this into the token it mints. */
export async function teacherSessionGen(env, teacherId) {
  if (!env.DB || !teacherId) return null;
  const row = await env.DB.prepare(
    'SELECT session_gen FROM teachers WHERE id = ?1',
  ).bind(teacherId).first();
  return row ? (row.session_gen ?? 0) : null;
}

/**
 * End every session this teacher holds.
 *
 * Called on sign-out and on a completed password reset. The reset case is the
 * one that matters: a new password that leaves the old session running does
 * not answer "someone else is in my account", which is what a reset is usually
 * for.
 *
 * Guarded on a real row id anyway. `sub` 0 was the shared ADMIN_PASSWORD_HASH,
 * which no longer exists and whose tokens requireAdmin now refuses outright --
 * but returning false rather than pretending to revoke is the right shape for
 * anything else that turns up without a row behind it.
 */
export async function revokeTeacher(env, teacherId) {
  if (!env.DB || !Number.isInteger(teacherId) || teacherId < 1) return false;
  await env.DB.prepare(
    'UPDATE teachers SET session_gen = session_gen + 1 WHERE id = ?1',
  ).bind(teacherId).run();
  return true;
}
