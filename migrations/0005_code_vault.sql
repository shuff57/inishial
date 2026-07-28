-- Codes the teacher can read back, without the database being enough to read
-- them.
--
-- Each code is stored twice and the two copies do different jobs:
--
--   code_hash / student_code_hash  PBKDF2. What sign-in verifies against.
--                                  Never reversible, never needs the key.
--   code_enc  / student_code_enc   AES-GCM under CODE_SECRET. What the Access
--                                  codes page decrypts to display. Display
--                                  only -- nothing authenticates against it.
--
-- Before this the plaintext existed for exactly one instant, in the CSV that
-- minted it, and a teacher who lost that file could only invalidate the code
-- and issue another. Handing codes out is the job; the storage had made the
-- job impossible.
--
-- NULL here means "not recoverable" -- an account whose code was issued before
-- this, or sealed under a secret since rotated. The page reports that and
-- offers to reissue rather than pretending the column is empty.

ALTER TABLE accounts ADD COLUMN code_enc TEXT;
ALTER TABLE accounts ADD COLUMN student_code_enc TEXT;
