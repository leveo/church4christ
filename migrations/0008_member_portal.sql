-- Member portal (spec: docs/superpowers/specs/2026-07-10-member-portal-design.md).
-- Shared-backend DDL only; portal-only tables (group_members,
-- group_applications, group_files, event_admins, prayer_items) are
-- Supabase-only — see migrations-supabase/0007_member_portal.sql.

-- Household ownership: max 2 owners per household (app-layer enforced);
-- an owner must be an adult member with a linked person (portalDb checks).
ALTER TABLE household_members ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;

-- Pending email-change target (one at a time; see src/lib/emailChange.ts).
ALTER TABLE people ADD COLUMN pending_email TEXT;

-- Widen tokens.purpose CHECK to allow 'email_change'. SQLite cannot alter a
-- CHECK, so rebuild (idiom precedent: revisions rebuild in 0005_custom_pages.sql).
CREATE TABLE tokens_new (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  person_id INTEGER NOT NULL REFERENCES people(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('login','respond','email_change')),
  assignment_id INTEGER REFERENCES roster_assignments(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO tokens_new (id, token_hash, person_id, purpose, assignment_id, expires_at, used_at, created_at)
  SELECT id, token_hash, person_id, purpose, assignment_id, expires_at, used_at, created_at FROM tokens;
DROP TABLE tokens;
ALTER TABLE tokens_new RENAME TO tokens;
CREATE INDEX idx_tokens_person ON tokens(person_id, purpose);

-- Member groups: fellowships (long-running) + Sunday School classes (seasonal).
-- Graduated from content collections to DB entities (owner decision).
-- Definitions live in BOTH backends (public /fellowships page must work on D1);
-- membership + files are Supabase-only. Table is member_groups, not "groups"
-- (window-frame keyword in both engines).
CREATE TABLE member_groups (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'fellowship' CHECK (kind IN ('fellowship','sunday_school')),
  term_label TEXT,                 -- seasonal classes, e.g. '2026 Fall'
  term_start TEXT,                 -- YYYY-MM-DD; NULL for long-running
  term_end TEXT,
  meeting_weekday INTEGER CHECK (meeting_weekday BETWEEN 0 AND 6), -- 0=Sunday
  meeting_time TEXT,               -- 'HH:MM' church-local
  meeting_frequency TEXT CHECK (meeting_frequency IN ('weekly','biweekly','monthly')),
  meeting_location TEXT,
  open_signup INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE member_group_i18n (
  group_id INTEGER NOT NULL REFERENCES member_groups(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  name TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (group_id, locale)
);
