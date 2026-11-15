-- newcomer status, field and field option translations
--
-- Replaces the hard-coded CHECK (locale IN ('en','zh')) on newcomer_status_i18n, newcomer_field_i18n and newcomer_field_option_i18n with a
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

-- newcomer_status_i18n
CREATE TABLE _locale_bak_newcomer_status_i18n AS SELECT status_id, locale, label, campus_id FROM newcomer_status_i18n;
DROP TABLE newcomer_status_i18n;
CREATE TABLE newcomer_status_i18n (
  status_id INTEGER NOT NULL REFERENCES newcomer_statuses(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (instr(locale,char(0)) = 0) REFERENCES supported_locales(code),
  label TEXT NOT NULL CHECK (
    instr(label,char(0)) = 0 AND label = trim(label) AND length(CAST(label AS BLOB)) BETWEEN 1 AND 100
  ), campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (status_id, locale)
) WITHOUT ROWID;
INSERT INTO newcomer_status_i18n (status_id, locale, label, campus_id)
  SELECT status_id, locale, label, campus_id FROM _locale_bak_newcomer_status_i18n;
DROP TABLE _locale_bak_newcomer_status_i18n;

-- newcomer_field_i18n
CREATE TABLE _locale_bak_newcomer_field_i18n AS SELECT field_id, locale, label, help, campus_id FROM newcomer_field_i18n;
DROP TABLE newcomer_field_i18n;
CREATE TABLE newcomer_field_i18n (
  field_id INTEGER NOT NULL REFERENCES newcomer_fields(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (instr(locale,char(0)) = 0) REFERENCES supported_locales(code),
  label TEXT NOT NULL CHECK (
    instr(label,char(0)) = 0 AND label = trim(label) AND length(CAST(label AS BLOB)) BETWEEN 1 AND 100
  ),
  help TEXT CHECK (help IS NULL OR (instr(help,char(0)) = 0 AND length(CAST(help AS BLOB)) <= 500)), campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (field_id, locale)
) WITHOUT ROWID;
INSERT INTO newcomer_field_i18n (field_id, locale, label, help, campus_id)
  SELECT field_id, locale, label, help, campus_id FROM _locale_bak_newcomer_field_i18n;
DROP TABLE _locale_bak_newcomer_field_i18n;

-- newcomer_field_option_i18n
CREATE TABLE _locale_bak_newcomer_field_option_i18n AS SELECT field_id, value, locale, label, campus_id FROM newcomer_field_option_i18n;
DROP TABLE newcomer_field_option_i18n;
CREATE TABLE newcomer_field_option_i18n (
  field_id INTEGER NOT NULL,
  value TEXT NOT NULL CHECK (instr(value,char(0)) = 0 AND length(CAST(value AS BLOB)) BETWEEN 1 AND 80),
  locale TEXT NOT NULL CHECK (instr(locale,char(0)) = 0) REFERENCES supported_locales(code),
  label TEXT NOT NULL CHECK (
    instr(label,char(0)) = 0 AND label = trim(label) AND length(CAST(label AS BLOB)) BETWEEN 1 AND 100
  ), campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (field_id, value, locale),
  FOREIGN KEY (field_id, value)
    REFERENCES newcomer_field_options(field_id, value) ON DELETE CASCADE
) WITHOUT ROWID;
INSERT INTO newcomer_field_option_i18n (field_id, value, locale, label, campus_id)
  SELECT field_id, value, locale, label, campus_id FROM _locale_bak_newcomer_field_option_i18n;
DROP TABLE _locale_bak_newcomer_field_option_i18n;
