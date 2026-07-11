-- Member portal (fusion onto the existing groups module). Shared-backend DDL
-- only; portal-only tables (group_files, event_admins, prayer_items) are
-- Supabase-only — see migrations-supabase/0009_member_portal.sql.

-- Group kind + seasonal term fields. Fellowships run long; Sunday School
-- classes are seasonal. CHECK-on-ADD is allowed by SQLite's ALTER TABLE.
ALTER TABLE groups ADD COLUMN kind TEXT NOT NULL DEFAULT 'fellowship'
  CHECK (kind IN ('fellowship','sunday_school'));
ALTER TABLE groups ADD COLUMN term_label TEXT; -- seasonal classes, e.g. '2026 Fall'
ALTER TABLE groups ADD COLUMN term_start TEXT; -- YYYY-MM-DD; NULL for long-running
ALTER TABLE groups ADD COLUMN term_end TEXT;

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
