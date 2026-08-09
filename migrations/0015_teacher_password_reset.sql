-- A teacher who forgets their password can get back in.
--
-- Before this there was no route at all. Nothing emails a teacher address, so
-- a forgotten password meant the account was gone -- and with it the class,
-- because the shared ADMIN_PASSWORD_HASH is scoped to `owner_id IS NULL`
-- (see owns() in _lib/http.js) and therefore cannot reach a signed-up
-- teacher's own courses. The roster, the syllabus and every signature on it
-- became unreachable through the app by forgetting one string.
--
-- Two columns rather than a table. A reset is single-use and short-lived, so
-- there is never more than one live per teacher and nothing accumulates to
-- sweep: issuing overwrites, completing clears.
--
-- The token is hashed with the same PBKDF2 path as every other secret here
-- (hashCode in _lib/codes.js). A reset link sits in an inbox, which is exactly
-- the place a plaintext token should not be readable from the database as
-- well.

ALTER TABLE teachers ADD COLUMN reset_hash       TEXT;
ALTER TABLE teachers ADD COLUMN reset_expires_at INTEGER;
