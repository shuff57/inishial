// Teacher accounts: the domain gate, and what counts as a usable password.
//
// Pure functions, no DB. They are the whole security surface of self-service
// sign-up, so they are testable without standing anything up.

/** Lowercased and trimmed. Everything downstream -- the UNIQUE index, the
 *  domain check, the ADMIN_EMAILS comparison -- assumes this has been run. */
export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

/** Comma-separated allowlist from the environment, normalised. */
export const listFrom = (value) =>
  String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Is this address at one of the school's domains?
 *
 * An entry may be written `school.org` (that domain exactly) or `.school.org`
 * (that domain and any subdomain of it). Subdomains are opt-in rather than
 * automatic: plenty of districts host unrelated tenants under one apex, and
 * silently accepting `anything.school.org` would widen the gate past what the
 * person configuring it asked for.
 *
 * `domains` empty means sign-up is not configured. Returns false, never true --
 * a missing allowlist must not be read as "allow everything".
 */
export function domainAllowed(email, domains) {
  if (!domains.length) return false;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return false;
  const host = email.slice(at + 1);
  return domains.some((d) => (d.startsWith('.') ? host === d.slice(1) || host.endsWith(d) : host === d));
}

// One @, no whitespace, a dot in the host. Deliberately loose: this is not the
// thing keeping strangers out -- the domain allowlist is -- and every strict
// email regex ever written rejects somebody's real address.
const SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
export const looksLikeEmail = (email) => SHAPE.test(email);

// Twelve, because this password is the only thing in front of student names,
// student IDs and parent email addresses, and because a teacher types it a
// handful of times a term. Long beats clever: no character-class rules, which
// push people toward P@ssw0rd1 and nothing better.
export const MIN_PASSWORD = 12;

/** null if the password is usable, otherwise the reason to show. */
export function passwordProblem(password, email) {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (value.length > 200) return 'That password is too long.';
  if (value.trim() !== value) return 'Remove the space at the start or end.';
  // The one content rule worth having: the address is public inside the school,
  // so a password derived from it is already known to everyone who can reach
  // the sign-in page.
  //
  // Only for a local part of 4+ characters. Shorter ones are substrings of
  // ordinary English -- `a@school.org` would reject every passphrase with an
  // "a" in it, which is all of them.
  const local = String(email ?? '').split('@')[0];
  if (local.length >= 4 && value.toLowerCase().includes(local.toLowerCase())) {
    return 'Do not use your email address in your password.';
  }
  return null;
}
