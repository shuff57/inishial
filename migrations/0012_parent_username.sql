-- Add parent_username to student_identities, so parents have a username
-- matching the student flow. Generated at registration as p{studentExtId}@s.
-- SQLite cannot add a UNIQUE column via ALTER TABLE, so the constraint is
-- enforced by a unique index instead.
ALTER TABLE student_identities ADD COLUMN parent_username TEXT;
CREATE UNIQUE INDEX idx_student_identities_parent_username ON student_identities (parent_username);
