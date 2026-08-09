-- Usernames become the whole sign-in identity, so they have to be unique by
-- construction rather than by luck.
--
-- The student username was `<student_ext_id>@s` against a globally UNIQUE
-- column, and a student_ext_id is unique per COURSE, not per install
-- (migrations/0001). Two schools sharing this install and one ID number was
-- therefore not a login ambiguity but a hard registration failure: the second
-- student's INSERT tripped UNIQUE(username) and they were told "that school
-- email is already registered to another student" about an address they never
-- typed. There was no way for them to ever register.
--
-- Both usernames now carry the school id, which makes them unique for the same
-- reason UNIQUE(school_id, student_ext_id) is:
--
--   student   <student_ext_id>@s<school_id>     100001@s1
--   parent    <student_ext_id>@p<school_id>     100001@p1
--
-- Rewritten outright rather than backfilled-if-null. Sign-in takes the username
-- and the access code and nothing else now, so a row left on the old format
-- would be a row nobody can sign in as. This is safe here because nothing has
-- been signed yet -- `signatures` is empty, and the only non-demo identity
-- belongs to a teacher who has not run a class through it.
--
-- lower() so the string printed on the registration screen and the string in
-- the parent's email are the one the student types back. Sign-in lowercases
-- both sides anyway; this keeps the displayed form consistent with it. It can
-- only conflict if one school has two roster rows whose IDs differ by case
-- alone, in which case this migration fails loudly rather than silently
-- merging them.
--
-- Also the backfill migration 0012 never had: parent_username was added
-- nullable with no UPDATE, so every identity predating it had NULL, and the
-- access-code email printed "YOUR username: null".

UPDATE student_identities
   SET username        = lower(student_ext_id) || '@s' || school_id,
       parent_username = lower(student_ext_id) || '@p' || school_id;
