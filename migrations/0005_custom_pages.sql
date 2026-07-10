-- Custom pages module: admin-authored static pages (e.g. "About", "Give"),
-- rendered from Markdown (src/lib/markdown.ts). Mirrors events/event_i18n's
-- shape and FK style. id is an app-generated TEXT key (crypto.randomUUID(), see
-- pagesDb.ts) rather than an auto-increment rowid — pages need a stable id that
-- the app can mint before the first insert, unlike events' RETURNING-id flow.
CREATE TABLE custom_pages (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE custom_page_i18n (
  page_id TEXT NOT NULL REFERENCES custom_pages(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  title TEXT NOT NULL DEFAULT '',
  body_md TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (page_id, locale)
);

-- revisions.entity's CHECK constraint (0001_init.sql) predates this module and
-- excludes 'custom_page'; SQLite has no ALTER TABLE for CHECK constraints, so
-- the table is rebuilt with the widened list (the standard 12-step procedure).
-- entity_id stays declared INTEGER: SQLite's type affinity only converts
-- well-formed numeric literals on insert, so a custom_pages TEXT id (a UUID) is
-- stored verbatim with no error, and every existing entity's INTEGER ids are
-- completely unaffected. (The Postgres mirror needs a real type change instead,
-- since Postgres enforces column types strictly — see migrations-supabase.)
CREATE TABLE revisions_new (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN
    ('bulletin','sermon','prayer_sheet','announcement','event','custom_page')),
  entity_id INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  edited_by TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO revisions_new (id, entity, entity_id, snapshot_json, edited_by, edited_at)
  SELECT id, entity, entity_id, snapshot_json, edited_by, edited_at FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_new RENAME TO revisions;
CREATE INDEX idx_revisions_entity ON revisions(entity, entity_id, edited_at);
