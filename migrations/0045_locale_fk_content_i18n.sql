-- announcement, event, email template and custom page translations
--
-- Replaces the hard-coded CHECK (locale IN ('en','zh')) on announcement_i18n, event_i18n, email_templates and custom_page_i18n with a
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

-- announcement_i18n
CREATE TABLE _locale_bak_announcement_i18n AS SELECT announcement_id, locale, title, campus_id FROM announcement_i18n;
DROP TABLE announcement_i18n;
CREATE TABLE announcement_i18n (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id),
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  title TEXT NOT NULL, campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (announcement_id, locale)
);
INSERT INTO announcement_i18n (announcement_id, locale, title, campus_id)
  SELECT announcement_id, locale, title, campus_id FROM _locale_bak_announcement_i18n;
DROP TABLE _locale_bak_announcement_i18n;

-- event_i18n
CREATE TABLE _locale_bak_event_i18n AS SELECT event_id, locale, title, blurb, campus_id FROM event_i18n;
DROP TABLE event_i18n;
CREATE TABLE event_i18n (
  event_id INTEGER NOT NULL REFERENCES events(id),
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  title TEXT NOT NULL,
  blurb TEXT NOT NULL DEFAULT '', campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (event_id, locale)
);
INSERT INTO event_i18n (event_id, locale, title, blurb, campus_id)
  SELECT event_id, locale, title, blurb, campus_id FROM _locale_bak_event_i18n;
DROP TABLE _locale_bak_event_i18n;

-- email_templates
CREATE TABLE _locale_bak_email_templates AS SELECT template_key, locale, subject, body, campus_id FROM email_templates;
DROP TABLE email_templates;
CREATE TABLE email_templates (
  template_key TEXT NOT NULL CHECK (template_key IN ('remind','request','appResult','digestAM')),
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  subject TEXT NOT NULL,
  body TEXT NOT NULL, campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (template_key, locale)
);
INSERT INTO email_templates (template_key, locale, subject, body, campus_id)
  SELECT template_key, locale, subject, body, campus_id FROM _locale_bak_email_templates;
DROP TABLE _locale_bak_email_templates;

-- custom_page_i18n
CREATE TABLE _locale_bak_custom_page_i18n AS SELECT page_id, locale, title, body_md, campus_id FROM custom_page_i18n;
DROP TABLE custom_page_i18n;
CREATE TABLE custom_page_i18n (
  page_id TEXT NOT NULL REFERENCES custom_pages(id) ON DELETE CASCADE,
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  title TEXT NOT NULL DEFAULT '',
  body_md TEXT NOT NULL DEFAULT '', campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (page_id, locale)
);
INSERT INTO custom_page_i18n (page_id, locale, title, body_md, campus_id)
  SELECT page_id, locale, title, body_md, campus_id FROM _locale_bak_custom_page_i18n;
DROP TABLE _locale_bak_custom_page_i18n;
