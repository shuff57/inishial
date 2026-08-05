-- Prepopulate the Chico-area school list, so the type-ahead on /register,
-- /register/code/ and /admin/signup/ offers the real schools instead of an
-- empty datalist that asks a teacher to invent a name from nothing.
--
-- A name typed against the list still creates a new school on an exact
-- no-match, and any teacher who already named their school keeps that row.
-- INSERT OR IGNORE rather than plain INSERT: schools.name is UNIQUE, and a
-- teacher may have already created "Chico High School" by typing it before
-- this migration ran -- a plain INSERT would fail the whole migration over
-- one row, which is the kind of failure that strands a deploy half-applied.
--
-- No delete feature exists on schools, so this list is effectively permanent.
-- Only schools this install is likely to serve: Chico Unified, the districts
-- whose students might cross-register into a Chico class, and the secondary
-- schools of the surrounding counties (Glenn, Tehama, Colusa, Sutter, Yuba).
--
-- Names follow the district's own usage ("Chico High School", not OSM's
-- "Chico Senior High School"; "Fair View", not "Fairview"). Secondary
-- schools only -- elementary campuses don't run syllabi through iniSHial.
-- Where OSM and the district disagree, the district wins.
INSERT OR IGNORE INTO schools (name) VALUES
  -- Chico Unified School District
  ('Chico High School'),
  ('Pleasant Valley High School'),
  ('Fair View High School'),
  ('Bidwell Junior High School'),
  ('Chico Junior High School'),
  ('Marsh Junior High School'),
  -- Durham Unified
  ('Durham High School'),
  ('Durham Intermediate School'),
  -- Paradise Unified
  ('Paradise High School'),
  ('Paradise Intermediate School'),
  ('Paradise Junior High School'),
  -- Oroville City / Oroville Union
  ('Oroville High School'),
  ('Las Plumas High School'),
  ('Central Middle School'),
  ('Ishi Hills Middle School'),
  ('Butte View High School'),
  -- Gridley / Biggs
  ('Gridley High School'),
  ('Gridley Middle School'),
  ('Biggs High School'),
  -- Hamilton City
  ('Hamilton High School'),
  ('Hamilton Middle School'),
  -- Glenn County (Orland / Willows)
  ('Orland High School'),
  ('Orland Junior High School'),
  ('Centennial Continuation High School'),
  ('Willows High School'),
  ('Willows Intermediate School'),
  -- Tehama County (Corning / Red Bluff / Los Molinos)
  ('Corning High School'),
  ('Corning Middle School'),
  ('Los Molinos High School'),
  ('Red Bluff High School'),
  ('Vista Middle School'),
  ('Mercy High School'),
  ('Notre Dame High School'),
  -- Colusa County
  ('Colusa High School'),
  ('Princeton Junior-Senior High School'),
  ('Pierce High School'),
  ('Williams High School'),
  ('Williams Middle School'),
  ('Maxwell High School'),
  -- Sutter / Yuba County
  ('Live Oak High School'),
  ('Live Oak Middle School'),
  ('Sutter High School'),
  ('Marysville High School'),
  ('Lindhurst High School'),
  ('Yuba Gardens Intermediate School'),
  ('Maywood Middle School'),
  ('Wheatland Union High School'),
  ('Anderson Union High School'),
  ('Anderson New Technology High School'),
  ('West Cottonwood Junior High School');
