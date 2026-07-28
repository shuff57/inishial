-- A code per SIGNER, not a code per account.
--
-- Until now `accounts.code_hash` was the only credential, and /api/sign/login
-- took the role -- 'parent' or 'student' -- as a field in the request body.
-- Whoever held the code chose which of the two attestations to make. The code
-- is mailed to the family, so in practice the student holds it too, and a
-- student could sign their own parent's agreement by picking the other radio.
--
-- The signatures table has always kept the two apart by role. This is what
-- makes the credential keep them apart as well: one hash each, and the role is
-- now DERIVED from which hash the submitted code matches rather than claimed.
--
-- `code_hash` stays the parent's, so codes already sitting in inboxes keep
-- working and no data has to move.

ALTER TABLE accounts ADD COLUMN student_code_hash TEXT;
ALTER TABLE accounts ADD COLUMN student_code_issued_at INTEGER;
