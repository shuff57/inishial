-- Teacher accounts, and course ownership.
--
-- Before this, "teacher" was one shared password in ADMIN_PASSWORD_HASH and
-- every admin route served any course_id to anyone who held it. That is fine
-- for one teacher and wrong the moment a colleague signs up: rosters carry
-- student names, student IDs, and parent email addresses, so a second teacher
-- reading the first one's course is a PII disclosure, not an inconvenience.
--
-- Sign-up is gated on the email domain (TEACHER_DOMAINS) and nothing else --
-- there is no mail sender in this app, so the address is asserted rather than
-- proven. What that buys is narrowing: only someone who already knows the
-- school's domain can make an account, and only their own courses are behind
-- it. It is not proof of identity. If that ever needs to be true, add an
-- emailed verification token or put Cloudflare Access in front of /admin/*.

CREATE TABLE teachers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Stored lowercased. The UNIQUE index is the only thing stopping two people
  -- claiming the same address, and SQLite compares TEXT case-sensitively, so
  -- normalising on the way in is load-bearing rather than cosmetic.
  email          TEXT    NOT NULL UNIQUE,
  name           TEXT,
  password_hash  TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

-- NULL means unowned: a course created before teacher accounts existed, or one
-- imported under the shared admin password. Those stay visible to the shared
-- password and to a Cloudflare Access identity (both of which are the person
-- who deployed this), and the first sign-up adopts them -- see signup.js.
ALTER TABLE courses ADD COLUMN owner_id INTEGER REFERENCES teachers(id);
CREATE INDEX idx_courses_owner ON courses (owner_id);
