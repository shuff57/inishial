-- Student identity: one row per (school, student), carrying the username and
-- both code pairs that used to live on `accounts`. `accounts` becomes purely
-- the roster-enrolment join row.
--
-- This is a contract-style migration, not expand/contract: the columns being
-- dropped from `accounts` are the ones every consumer reads, so schema and
-- application code must land together. See the school-scoping-and-identity
-- plan, Step 2.
--
-- `signatures.account_id` does NOT move. `accounts` stays one row per
-- enrolment, so `UNIQUE (account_id, version_id, block_id, role)` and the
-- seven files that read it are untouched. This is the decision that keeps the
-- change bounded.

CREATE TABLE student_identities (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id              INTEGER NOT NULL REFERENCES schools(id),
  student_ext_id         TEXT    NOT NULL,
  username               TEXT    NOT NULL UNIQUE,
  code_hash              TEXT,
  code_issued_at         INTEGER,
  code_enc               TEXT,
  student_code_hash      TEXT,
  student_code_issued_at INTEGER,
  student_code_enc       TEXT,
  parent_email           TEXT,
  created_at             INTEGER NOT NULL,
  UNIQUE (school_id, student_ext_id)
);

-- Backfill: one identity per existing account. The current schema cannot
-- express more than one enrolment per student, so this is exactly right, not
-- an approximation. Resolve school_id through roster -> courses -> teachers ->
-- schools, falling back to the placeholder school (id 1) when the course is
-- unowned -- the same policy migration 0009 already established for teachers
-- with no chosen school.
INSERT INTO student_identities
  (school_id, student_ext_id, username, code_hash, code_issued_at, code_enc,
   student_code_hash, student_code_issued_at, student_code_enc, parent_email,
   created_at)
SELECT
  COALESCE(t.school_id, 1),
  r.student_ext_id,
  a.username,
  a.code_hash,
  a.code_issued_at,
  a.code_enc,
  a.student_code_hash,
  a.student_code_issued_at,
  a.student_code_enc,
  a.parent_email,
  a.created_at
FROM accounts a
JOIN roster   r ON r.id = a.roster_id
JOIN courses  c ON c.id = r.course_id
LEFT JOIN teachers t ON t.id = c.owner_id;

-- Rebuild accounts: drop the columns that moved to student_identities, add
-- identity_id. SQLite's ALTER TABLE cannot drop multiple columns and add a
-- NOT NULL FK in one step, so this is create-new/copy/drop-old/rename.
--
-- CRITICAL: the new table's rows MUST preserve the exact same `id` values as
-- the old ones. If ids shift, every `signatures.account_id` silently points at
-- the wrong account, or at nothing. The INSERT below names the id column
-- explicitly rather than relying on autoincrement.
--
-- CRITICAL: `signatures.account_id REFERENCES accounts(id)` means dropping the
-- old `accounts` table with FK enforcement on will either block the drop or
-- cascade-delete every signature. The rebuild is wrapped in PRAGMA
-- foreign_keys = OFF / ON, and PRAGMA foreign_key_check is run afterward.

PRAGMA foreign_keys = OFF;

CREATE TABLE accounts_new (
  id          INTEGER PRIMARY KEY,
  roster_id   INTEGER NOT NULL UNIQUE REFERENCES roster(id) ON DELETE CASCADE,
  identity_id INTEGER NOT NULL REFERENCES student_identities(id),
  created_at  INTEGER NOT NULL
);

INSERT INTO accounts_new (id, roster_id, identity_id, created_at)
SELECT a.id, a.roster_id, si.id, a.created_at
FROM accounts a
JOIN roster r ON r.id = a.roster_id
JOIN courses c ON c.id = r.course_id
LEFT JOIN teachers t ON t.id = c.owner_id
JOIN student_identities si
  ON si.school_id = COALESCE(t.school_id, 1)
 AND si.student_ext_id = r.student_ext_id;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

PRAGMA foreign_keys = ON;

-- Verify nothing is dangling. If this returns rows, the migration is broken
-- and must not proceed.
PRAGMA foreign_key_check;
