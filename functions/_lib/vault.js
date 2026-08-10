// Access codes, kept readable for the teacher without being readable from the
// database alone.
//
// A code is stored TWICE, deliberately:
//
//   code_hash  -- PBKDF2, what /api/sign/login verifies against. Sign-in never
//                 touches the key below, so a signing request cannot leak it
//                 and the auth path is unchanged by any of this.
//   code_enc   -- AES-GCM ciphertext, what the teacher's Access codes page
//                 decrypts to show. Display only. Nothing authenticates
//                 against it.
//
// Two copies of one secret is not two secrets: whoever can read the plaintext
// can read it either way. What the split buys is that the thing which must be
// online for every parent sign-in (the hash) is not the thing that can be
// turned back into a code (the ciphertext), and only the admin path ever loads
// the key.
//
// The alternative was leaving codes hashed and showing them only at the moment
// they were minted -- which is what this app did, and which made the review
// page mostly a list of "issued 3 Aug". The teacher's actual job is reading
// codes off a screen and handing them out.
//
// CODE_SECRET is a Worker secret. Without it, everything here returns null and
// the page says the code cannot be shown rather than failing: a missing secret
// must never take down sign-in or the roster.

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes) => {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
};
const unb64 = (str) => {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

// The secret is a passphrase, not key material, so it is stretched rather than
// used raw. Fixed salt: there is one key for the whole deployment, so a random
// salt would have to be stored beside it and buys nothing.
const SALT = enc.encode('inishial/code-vault/v1');
const ITERATIONS = 100_000;

const keyCache = new Map();

async function keyFor(secret) {
  if (keyCache.has(secret)) return keyCache.get(secret);
  const material = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  // Derivation is ~100ms and the key is the same for every row in an export of
  // 180 students. Cached per isolate, keyed by the secret itself so rotating it
  // cannot serve a stale key.
  keyCache.set(secret, key);
  return key;
}

export const vaultReady = (env) => typeof env?.CODE_SECRET === 'string' && env.CODE_SECRET.length >= 16;

// --- Blind index -------------------------------------------------------
//
// Student surnames are sealed like codes, which would make them unmatchable:
// registration has to find a roster row from a name typed by someone who is not
// signed in, and AES-GCM ciphertext differs every time it is written. So the
// surname is ALSO stored as a keyed digest, and matching compares digests.
//
// Keyed, not a plain hash, and that is the whole point. Surnames come from a
// space of maybe a hundred thousand candidates, so an unkeyed digest of one is
// a dictionary attack with no key to steal -- a leaked database would give up
// every name in it. HMAC under CODE_SECRET means a stolen copy of the database
// is not enough on its own.
//
// Read the limit honestly: this defends the DATABASE, not against whoever runs
// the deployment. Anyone holding both the data and CODE_SECRET can confirm a
// guessed surname, and the guess space is small. See DEPLOY.md 5a.
const indexKeyCache = new Map();

async function indexKeyFor(secret) {
  if (indexKeyCache.has(secret)) return indexKeyCache.get(secret);
  const material = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  // A DIFFERENT salt from the encryption key above: one secret, two purposes,
  // and the same bytes should never be both an AES key and a MAC key.
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('inishial/blind-index/v1'), iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  indexKeyCache.set(secret, key);
  return key;
}

/**
 * Lookup digest for a surname, scoped to a school so the same name in two
 * schools does not share a digest. Returns null with no secret configured;
 * callers treat that as "cannot match" rather than falling back to plaintext.
 */
export async function blindIndex(env, text, scope) {
  if (!vaultReady(env)) return null;
  const key = await indexKeyFor(env.CODE_SECRET);
  // Normalised the same way on write and on read, or the digests never meet.
  const value = `${scope}|${String(text ?? '').trim().toLowerCase()}`;
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Seal/open any short string, not just a code. Same key, same format. */
export const seal = (env, text) => sealCode(env, text);
export const open = (env, sealed) => openCode(env, sealed);

/**
 * Encrypt a code for storage. Returns null when no secret is configured, which
 * the callers store as NULL -- an account with a hash and no ciphertext is one
 * whose code simply cannot be shown again.
 *
 * Format: v1$<iv_b64>$<ciphertext_b64>. The version prefix is there so a future
 * key rotation can tell old rows from new ones without guessing.
 */
export async function sealCode(env, code) {
  if (!vaultReady(env)) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(env.CODE_SECRET);
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(code)));
  return `v1$${b64(iv)}$${b64(buf)}`;
}

/** Decrypt for display. Never throws: a row sealed with a since-rotated secret,
 *  or corrupted, comes back null and is reported as unreadable rather than
 *  taking the whole page down. */
export async function openCode(env, sealed) {
  if (!vaultReady(env) || typeof sealed !== 'string') return null;
  const parts = sealed.split('$');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const key = await keyFor(env.CODE_SECRET);
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(parts[1]) }, key, unb64(parts[2]),
    );
    return dec.decode(buf);
  } catch {
    return null;
  }
}
