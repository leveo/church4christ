-- ministry, team, position and service type translations
--
-- Replaces the hard-coded CHECK (locale IN ('en','zh')) on ministry_i18n, team_i18n, position_i18n and service_type_i18n with a
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

-- ministry_i18n
CREATE TABLE _locale_bak_ministry_i18n AS SELECT ministry_id, locale, name, intro, campus_id FROM ministry_i18n;
DROP TABLE ministry_i18n;
CREATE TABLE ministry_i18n (
  ministry_id INTEGER NOT NULL REFERENCES ministries(id),
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  name TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '', campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ministry_id, locale)
);
INSERT INTO ministry_i18n (ministry_id, locale, name, intro, campus_id)
  SELECT ministry_id, locale, name, intro, campus_id FROM _locale_bak_ministry_i18n;
DROP TABLE _locale_bak_ministry_i18n;

-- team_i18n
CREATE TABLE _locale_bak_team_i18n AS SELECT team_id, locale, name, campus_id FROM team_i18n;
DROP TABLE team_i18n;
CREATE TABLE team_i18n (
  team_id INTEGER NOT NULL REFERENCES teams(id),
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  name TEXT NOT NULL, campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (team_id, locale)
);
INSERT INTO team_i18n (team_id, locale, name, campus_id)
  SELECT team_id, locale, name, campus_id FROM _locale_bak_team_i18n;
DROP TABLE _locale_bak_team_i18n;

-- position_i18n
CREATE TABLE _locale_bak_position_i18n AS SELECT position_id, locale, name, campus_id FROM position_i18n;
DROP TABLE position_i18n;
CREATE TABLE position_i18n (
  position_id INTEGER NOT NULL REFERENCES positions(id),
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  name TEXT NOT NULL, campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (position_id, locale)
);
INSERT INTO position_i18n (position_id, locale, name, campus_id)
  SELECT position_id, locale, name, campus_id FROM _locale_bak_position_i18n;
DROP TABLE _locale_bak_position_i18n;

-- service_type_i18n
CREATE TABLE _locale_bak_service_type_i18n AS SELECT service_type_id, locale, name, campus_id FROM service_type_i18n;
DROP TABLE service_type_i18n;
CREATE TABLE service_type_i18n (
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  name TEXT NOT NULL, campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (service_type_id, locale)
);
INSERT INTO service_type_i18n (service_type_id, locale, name, campus_id)
  SELECT service_type_id, locale, name, campus_id FROM _locale_bak_service_type_i18n;
DROP TABLE _locale_bak_service_type_i18n;
