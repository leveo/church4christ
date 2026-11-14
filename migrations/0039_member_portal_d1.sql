-- Member portal basics on D1. The shared-backend portal DDL lives in
-- 0010_member_portal.sql; this adds the two portal tables D1 lacked so the
-- portal works without Supabase. event_admins stays Supabase-only because it
-- belongs to Registration. campus_id mirrors 0027_multi_campus.sql (plain
-- column with a default, no foreign key).

CREATE TABLE group_files (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  uploaded_by INTEGER NOT NULL REFERENCES people(id),
  file_name TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,      -- group-files/{group_id}/{random}
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  campus_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_group_files_group ON group_files(group_id, deleted_at);

-- reg_event_id is a plain column on D1: Registration (reg_events) is
-- Supabase-only, and D1 enforces foreign keys even for NULL values when the
-- parent table is missing. scope='event' is rejected when Registration is off.
CREATE TABLE prayer_items (
  id INTEGER PRIMARY KEY,
  author_person_id INTEGER NOT NULL REFERENCES people(id),
  scope TEXT NOT NULL CHECK (scope IN ('church','group','event','private')),
  group_id INTEGER REFERENCES groups(id),
  reg_event_id INTEGER,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_by INTEGER REFERENCES people(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  campus_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_prayer_items_scope ON prayer_items(scope, status, deleted_at);
CREATE INDEX idx_prayer_items_group ON prayer_items(group_id);
CREATE INDEX idx_prayer_items_event ON prayer_items(reg_event_id);

-- Existing installations keep the portal off until an administrator turns it on
-- in Settings -> Modules. A fresh database has no module rows and no people yet,
-- so setup's own module choices apply there. An explicit row is never changed.
INSERT INTO settings (key, value)
SELECT 'module.portal', '0'
WHERE EXISTS (SELECT 1 FROM settings WHERE key LIKE 'module.%')
   OR EXISTS (SELECT 1 FROM people)
ON CONFLICT(key) DO NOTHING;
