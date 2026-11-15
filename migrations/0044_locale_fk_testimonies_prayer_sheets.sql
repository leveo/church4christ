-- testimonies and prayer sheets
--
-- Replaces the hard-coded CHECK (locale IN ('en','zh')) on testimonies.locale and prayer_sheets.locale (nullable) with a
-- foreign key to supported_locales (0041), so a new language is an INSERT rather than a
-- schema change. Row data, column order, indexes and triggers are unchanged.
-- SQLite cannot alter a CHECK, so each table is rebuilt: its rows are copied aside, the
-- table is dropped and recreated under its own name (never renamed, so foreign keys and
-- triggers in other tables keep resolving), the rows are copied back, and every index and
-- trigger is recreated verbatim.
--
-- D1 enforces foreign keys and ignores PRAGMA foreign_keys = OFF, so deferring the check
-- lets the parent be recreated inside this migration's transaction.
-- Back up before applying (docs/upgrade.md). There is no down migration.

PRAGMA defer_foreign_keys = ON;

-- testimonies
CREATE TABLE _locale_bak_testimonies AS SELECT id, person_id, author_name, locale, title, body, category, status, published_at, created_at, deleted_at, campus_id FROM testimonies;
DROP TABLE testimonies;
CREATE TABLE testimonies (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id),
  author_name TEXT NOT NULL,
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'P' CHECK (status IN ('P','A','R')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
, campus_id INTEGER NOT NULL DEFAULT 1);
INSERT INTO testimonies (id, person_id, author_name, locale, title, body, category, status, published_at, created_at, deleted_at, campus_id)
  SELECT id, person_id, author_name, locale, title, body, category, status, published_at, created_at, deleted_at, campus_id FROM _locale_bak_testimonies;
CREATE INDEX idx_testimonies_status ON testimonies(status, locale);
DROP TABLE _locale_bak_testimonies;

-- prayer_sheets
CREATE TABLE _locale_bak_prayer_sheets AS SELECT id, sheet_date, locale, sections_json, status, publish_at, updated_by, updated_at, deleted_at, campus_id FROM prayer_sheets;
DROP TABLE prayer_sheets;
CREATE TABLE prayer_sheets (
  id INTEGER PRIMARY KEY,
  sheet_date TEXT NOT NULL UNIQUE,
  locale TEXT REFERENCES supported_locales(code),
  sections_json TEXT,                      -- [{heading,items[]}]
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  publish_at TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
, campus_id INTEGER NOT NULL DEFAULT 1);
INSERT INTO prayer_sheets (id, sheet_date, locale, sections_json, status, publish_at, updated_by, updated_at, deleted_at, campus_id)
  SELECT id, sheet_date, locale, sections_json, status, publish_at, updated_by, updated_at, deleted_at, campus_id FROM _locale_bak_prayer_sheets;
DROP TABLE _locale_bak_prayer_sheets;
