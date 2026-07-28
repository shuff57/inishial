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

/** Mint a session token for `accountId` acting as `role`.
 *
 *  `email` is carried only for a signed-up teacher, so the roster-import audit
 *  trail can record who uploaded a file. It is a convenience, never a
 *  credential: authorisation reads `sub` and `role`, both of which are covered
 *  by the signature, and nothing trusts this field to decide access. */
export async function signSession(env, accountId, role, nowSec, email) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not configured');
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: accountId, role, iat: nowSec, exp: nowSec + TTL_SEC };
  if (email) payload.email = email;
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

/** Claims for the current request, or null. */
export async function currentSession(request, env, nowSec) {
  return verifySession(env, readCookie(request), nowSec);
}
