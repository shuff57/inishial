// Access codes: generation, hashing, verification.
//
// No student-chosen passwords anywhere in this app -- see the design doc for
// why. A code is random, single-purpose, and worth nothing outside this app.
//
// WebCrypto only. Present in the Workers runtime and in Node 20+, so the same
// code runs in tests without a dependency.

const enc = new TextEncoder();

// Base32-ish, minus characters people misread when copying off a screen or a
// printed slip: 0/O, 1/I/L. 31 symbols.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PBKDF2_ITERATIONS = 100_000;

/** Cryptographically random access code. 8 chars ~= 8.5e11 combinations,
 *  which is only meaningful because the login endpoint is rate limited. */
export function generateCode(length = 8) {
  // Reject-sample so the modulo doesn't bias toward the front of the alphabet.
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = '';
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= max) continue;
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

function b64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}
function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function derive(code, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Hash for storage. Format: pbkdf2$<iterations>$<salt_b64>$<hash_b64> */
export async function hashCode(code) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(normalize(code), salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

function timingSafeEqual(a, b) {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

/** Verify a submitted code against a stored hash. Never throws. */
export async function verifyCode(code, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  let salt; let expected;
  try { salt = unb64(parts[2]); expected = unb64(parts[3]); } catch { return false; }
  const actual = await derive(normalize(code), salt, iterations);
  return timingSafeEqual(actual, expected);
}

// Codes are displayed uppercase and read off paper. Accept lowercase, and
// accept the separators people add on their own (spaces, dashes).
export function normalize(code) {
  return String(code ?? '').toUpperCase().replace(/[\s-]/g, '');
}

/** Hex SHA-256, used to pin block text at signing time. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
