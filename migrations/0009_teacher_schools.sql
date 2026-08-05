-- Scoping every teacher to a school.
--
-- NOT NULL is load-bearing, not decorative: a later migration adds
-- UNIQUE (school_id, student_ext_id) on a student-identity table, and SQLite
-- treats NULL as distinct from every other NULL -- a nullable school_id
-- would silently let that constraint through the exact duplicate rows it
-- exists to stop. Teachers who have not chosen a school get a real
-- placeholder row here, not a NULL.
--
-- The placeholder is the first row this brand-new table will ever hold, so
-- its id is always 1 -- which is also why the DEFAULT can be a literal rather
-- than something looked up. The same DEFAULT covers a brand new teacher
-- signing up before this table has anything else to offer them:
-- functions/api/admin/signup.js's INSERT does not name a school_id, so it
-- lands here too, until a later ticket has them choose a real one at sign-up.
--
-- Plain ALTER ADD COLUMN, no REFERENCES. D1's SQLite rejects a REFERENCES
-- column with a non-NULL DEFAULT ("Cannot add a REFERENCES column with
-- non-NULL default value"), and this database is D1. The FK would be
-- nice-to-have; the NOT NULL DEFAULT is the load-bearing part. The join to
-- schools is written explicitly wherever a teacher's school is read, exactly
-- as it would be with the constraint declared.

-- INSERT OR IGNORE, not INSERT: a partial earlier run (or a probing hand on
-- the live database) can leave the placeholder row behind, and a migration
-- that dies on its own leftover state is worse than one that repairs it.
INSERT OR IGNORE INTO schools (name) VALUES ('(unassigned)');

ALTER TABLE teachers ADD COLUMN school_id INTEGER NOT NULL DEFAULT 1;
