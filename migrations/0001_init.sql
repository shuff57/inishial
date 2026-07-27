-- Interactive Syllabus, initial schema.
-- Design: docs/plans/2026-07-27-interactive-syllabus-design.md
--
-- Two invariants the rest of the app leans on:
--   1. A row in `versions` with published_at NOT NULL is immutable. Nothing
--      updates its blocks, ever. Edits create a new draft version.
--   2. `signatures` is append-only. No UPDATE, no DELETE in application code.
-- Together those two are the entire audit story.

CREATE TABLE courses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Populated from the teacher's SIS roster export. Registration is gated on a
-- student_ext_id existing here, which is what keeps junk accounts out.
--
-- Re-uploading marks absent students 'dropped' rather than deleting them --
-- the practice every roster-sync system converges on (Canvas concludes an
-- enrollment, OneRoster flips status to inactive). Two reasons: a delete
-- cascades away signatures that may still need to be produced for the period
-- the student was enrolled, and students dropped in week two are frequently
-- back in week three, at which point their account and signatures should
-- simply return.
--
-- last_seen_import carries the id of the import that most recently listed this
-- student, which is how a re-upload identifies absentees without binding the
-- entire roster into one NOT IN clause.
--
-- An import id rather than a timestamp: two uploads inside the same second
-- share a wall-clock value, and the absentee sweep would then match nothing.
CREATE TABLE imports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   INTEGER NOT NULL,
  admin_email  TEXT,
  filename     TEXT
);

CREATE TABLE roster (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id         INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  period            TEXT,
  student_ext_id    TEXT    NOT NULL,
  first             TEXT    NOT NULL,
  last              TEXT    NOT NULL,
  -- Contact address from the SIS export. The authoritative one: the teacher
  -- already has these, so students are not asked to retype (and mistype) them.
  parent_email      TEXT,
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','dropped')),
  dropped_at        INTEGER,
  last_seen_import  INTEGER REFERENCES imports(id),
  UNIQUE (course_id, student_ext_id)
);
CREATE INDEX idx_roster_ext ON roster (student_ext_id);
CREATE INDEX idx_roster_course_status ON roster (course_id, status);

-- code_hash is NULL until the teacher exports credentials. Codes are hashed,
-- so they can never be read back out -- which means the plaintext has to be
-- surfaced at the moment it is created. Minting during export (rather than at
-- registration) puts the one and only plaintext in the same CSV the teacher is
-- about to mail, and keeps students from having to carry a code around.
-- accounts.parent_email is an OVERRIDE, not the source. It is only set when a
-- student supplies an address at registration, which is the escape hatch for
-- families whose contact on file is missing or wrong. The effective address is
-- COALESCE(accounts.parent_email, roster.parent_email).
CREATE TABLE accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  roster_id       INTEGER NOT NULL UNIQUE REFERENCES roster(id) ON DELETE CASCADE,
  username        TEXT    NOT NULL UNIQUE,
  code_hash       TEXT,
  code_issued_at  INTEGER,
  parent_email    TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE syllabi (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  slug       TEXT    NOT NULL UNIQUE
);

-- published_at NULL = the editable draft. Exactly one draft per syllabus.
CREATE TABLE versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  syllabus_id   INTEGER NOT NULL REFERENCES syllabi(id) ON DELETE CASCADE,
  num           INTEGER NOT NULL,
  published_at  INTEGER,
  UNIQUE (syllabus_id, num)
);

CREATE TABLE blocks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id      INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,
  type            TEXT    NOT NULL CHECK (type IN ('heading','text','list','initial','agree')),
  html            TEXT    NOT NULL DEFAULT '',
  needs_initials  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_blocks_version ON blocks (version_id, ord);

-- block_hash pins what the text actually said when it was initialed, so a
-- later edit can never retroactively change what someone agreed to.
CREATE TABLE signatures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  version_id  INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  block_id    INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL CHECK (role IN ('student','parent')),
  initials    TEXT    NOT NULL,
  block_hash  TEXT    NOT NULL,
  signed_at   INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  UNIQUE (account_id, version_id, block_id, role)
);
CREATE INDEX idx_sig_version ON signatures (version_id);

-- Fixed-window counter behind the access-code check. The syllabus URL is
-- public, so this is the only thing making an 8-char code meaningful.
CREATE TABLE auth_attempts (
  key           TEXT    PRIMARY KEY,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL
);
