-- People module (spec addendum §B): membership-profile depth on `people`, plus
-- households (with name-only dependents) and pastoral notes. Additive only —
-- migration policy is append-only and `people.email` stays NOT NULL UNIQUE (it
-- is the auth key), so dependents without accounts are name-only member rows
-- (person_id NULL) rather than nullable-email people.

-- people: membership-profile columns. SQLite ADD COLUMN allows a CHECK and a
-- constant NOT NULL DEFAULT, so membership_status backfills every existing row
-- to 'visitor'. birthday/address/joined_on are nullable free text (YYYY-MM-DD).
ALTER TABLE people ADD COLUMN birthday TEXT;
ALTER TABLE people ADD COLUMN address TEXT;
ALTER TABLE people ADD COLUMN membership_status TEXT NOT NULL DEFAULT 'visitor'
  CHECK (membership_status IN ('visitor','regular','member','inactive'));
ALTER TABLE people ADD COLUMN joined_on TEXT;

-- households: one shared card per family unit. Soft-deleted (deleted_at) when the
-- last real member leaves; its name-only dependent rows are hard-deleted then.
CREATE TABLE households (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

-- household_members: real members carry person_id; dependents (children or
-- account-less adults) are name-only rows with person_id NULL. role/is_primary
-- default to the common case (an adult, non-primary).
CREATE TABLE household_members (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id),
  person_id INTEGER REFERENCES people(id),
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'adult' CHECK (role IN ('adult','child')),
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A real person belongs to at most one household (partial: dependents are exempt).
CREATE UNIQUE INDEX idx_household_members_person
  ON household_members(person_id) WHERE person_id IS NOT NULL;
-- Belt-and-braces uniqueness of a real person within a single household.
CREATE UNIQUE INDEX idx_household_members_hh_person
  ON household_members(household_id, person_id) WHERE person_id IS NOT NULL;
CREATE INDEX idx_household_members_household ON household_members(household_id);

-- person_notes: pastoral notes, admin-only read/write (privacy rule — ministry
-- leaders never see notes). Soft-deleted via deleted_at.
CREATE TABLE person_notes (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  author_email TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX idx_person_notes_person ON person_notes(person_id);
