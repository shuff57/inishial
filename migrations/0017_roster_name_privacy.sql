-- Student names out of the clear.
--
-- Two separate decisions, and they are different in kind:
--
--   first  -- DROPPED. Not encrypted, deleted. It was only ever displayed, and
--             nothing in the app matches on it, so storing it bought a greeting
--             and cost a real name sitting in the database. The cheapest way to
--             stop a dump revealing a child's given name is to not have it.
--
--   last   -- SEALED, because it cannot be dropped: registration finds a roster
--             row from a surname typed by someone who is not signed in. It is
--             now kept twice, in the same shape as the access codes above it
--             (see migrations/0005 and _lib/vault.js):
--
--               last_enc  AES-GCM ciphertext, for display
--               last_idx  keyed HMAC digest, for matching
--
-- What this is worth, stated plainly so nobody reads more into it later: it
-- protects a COPY of the database -- a stray export, an old backup, a leaked
-- snapshot -- from anyone who does not also hold CODE_SECRET. It does not
-- protect against whoever runs the deployment, who holds both. Surnames are
-- also a small guess space, so the digest resists bulk reading, not a targeted
-- confirmation. DEPLOY.md 5a has the honest version.
--
-- Applied with no backfill on purpose. At the time of writing the only rows in
-- production were five synthetic demo students, so there was nothing to
-- preserve and a re-import fills the new columns properly. A deployment that
-- DOES have real rosters must seal them before this runs -- ALTER TABLE cannot
-- encrypt, and rows left with a NULL last_idx will not match at registration.

ALTER TABLE roster ADD COLUMN last_enc TEXT;
ALTER TABLE roster ADD COLUMN last_idx TEXT;

-- Order matters: add the replacements first so a half-applied migration leaves
-- the table readable rather than nameless.
ALTER TABLE roster DROP COLUMN first;
ALTER TABLE roster DROP COLUMN last;
