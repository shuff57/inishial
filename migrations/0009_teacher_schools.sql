-- Scoping every teacher to a school.
--
-- NOT NULL is load-bearing, not decorative: a later migration adds
-- UNIQUE (school_id, student_ext_id) on a student-identity table, and SQLite
-- treats NULL as distinct from every other NULL -- a nullable school_id
-- would silently let that constraint through the exact duplicate rows it
-- exists to stop. Teachers who have not chosen a school get a real
-- placeholder row here, not a NULL.
--
-- SQLite's ALTER TABLE ADD COLUMN requires a non-NULL DEFAULT whenever the
-- new column is NOT NULL, and that default is applied to every existing row
-- as the column is added -- which is also the entire backfill; there is no
-- separate UPDATE to run. The placeholder is the first row this brand-new
-- table will ever hold, so its id is always 1, which is also why the DEFAULT
-- below can be a literal rather than something looked up.
--
-- The same DEFAULT covers a brand new teacher signing up before this table
-- has anything else to offer them: functions/api/admin/signup.js's INSERT
-- does not name a school_id, so it lands here too, until a later ticket has
-- them choose a real one at sign-up.
INSERT INTO schools (name) VALUES ('(unassigned)');

ALTER TABLE teachers ADD COLUMN school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id);
