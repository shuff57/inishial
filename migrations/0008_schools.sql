-- Schools: the scope every teacher, and every later student identity, sits
-- inside.
--
-- Two unrelated students at different schools can share a student ID -- SIS
-- ids are only unique within a school -- and until now nothing in this app
-- knew a school existed to disambiguate them. `register` and `request-code`
-- pick a roster row by ID alone, which is a cross-school mixup waiting to
-- happen the moment a second school joins the install. This table is what
-- lets a later change scope those lookups; it does nothing on its own.
--
-- Named by typing against existing rows, or created on an exact no-match --
-- see GET /api/schools?q=. No seed list: the first teacher to sign up
-- creates their school.
CREATE TABLE schools (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT    NOT NULL UNIQUE
);
