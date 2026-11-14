-- Service Planning: run sheets, rehearsal sessions, availability windows, and
-- notification rules. campus_id mirrors 0027_multi_campus.sql (plain column with
-- a default, no foreign key). Blockouts stay in blockout_dates; availability_windows
-- only stores positive "available" windows.

CREATE TABLE planning_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title_en TEXT NOT NULL DEFAULT '',
  title_zh TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL,                 -- YYYY-MM-DD
  start_time TEXT NOT NULL,                 -- HH:MM
  end_time TEXT,                            -- HH:MM target end (overrun warning)
  location_en TEXT NOT NULL DEFAULT '',
  location_zh TEXT NOT NULL DEFAULT '',
  notes_en TEXT NOT NULL DEFAULT '',
  notes_zh TEXT NOT NULL DEFAULT '',
  plan_id INTEGER REFERENCES plans(id),     -- plans soft-delete; the app treats a deleted plan as unlinked
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,      -- optimistic lock: every write checks and bumps
  created_by INTEGER REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_planning_events_date ON planning_events(event_date, status);

CREATE TABLE planning_event_coordinators (
  event_id INTEGER NOT NULL REFERENCES planning_events(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (event_id, person_id)
);
CREATE INDEX idx_planning_coordinators_person ON planning_event_coordinators(person_id);

CREATE TABLE planning_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES planning_events(id),
  sort INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'segment' CHECK (kind IN ('segment','song','heading','note')),
  duration_min INTEGER NOT NULL DEFAULT 0 CHECK (duration_min >= 0 AND duration_min <= 720),
  fixed_start_time TEXT,                    -- HH:MM; when set the clock jumps to it
  title_en TEXT NOT NULL DEFAULT '',
  title_zh TEXT NOT NULL DEFAULT '',
  details_en TEXT NOT NULL DEFAULT '',
  details_zh TEXT NOT NULL DEFAULT '',
  owner_team_id INTEGER REFERENCES teams(id),
  owner_person_id INTEGER REFERENCES people(id),
  owner_label TEXT,                         -- free-text owner
  cue_notes TEXT NOT NULL DEFAULT '',       -- leader-only
  campus_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_planning_items_event ON planning_items(event_id, sort);
CREATE INDEX idx_planning_items_owner_person ON planning_items(owner_person_id);
CREATE INDEX idx_planning_items_owner_team ON planning_items(owner_team_id);

CREATE TABLE planning_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES planning_events(id),
  title_en TEXT NOT NULL DEFAULT '',
  title_zh TEXT NOT NULL DEFAULT '',
  session_date TEXT NOT NULL,               -- YYYY-MM-DD
  start_time TEXT NOT NULL,                 -- HH:MM
  end_time TEXT NOT NULL,                   -- HH:MM
  location_en TEXT NOT NULL DEFAULT '',
  location_zh TEXT NOT NULL DEFAULT '',
  note_en TEXT NOT NULL DEFAULT '',
  note_zh TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','cancelled')),
  acknowledged_unknown INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_unknown IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_planning_sessions_event ON planning_sessions(event_id);
CREATE INDEX idx_planning_sessions_date ON planning_sessions(session_date, status);

CREATE TABLE planning_session_people (
  session_id INTEGER NOT NULL REFERENCES planning_sessions(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  call_time TEXT,                           -- HH:MM, optional per-person call time
  notified_at TEXT,                         -- publish / change notice sent
  reminded_at TEXT,                         -- reminder sent (no duplicates)
  campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, person_id)
);
CREATE INDEX idx_planning_session_people_person ON planning_session_people(person_id);

CREATE TABLE availability_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id),
  kind TEXT NOT NULL DEFAULT 'available' CHECK (kind IN ('available')),
  starts_on TEXT NOT NULL,                  -- YYYY-MM-DD
  ends_on TEXT NOT NULL,                    -- YYYY-MM-DD
  weekdays TEXT NOT NULL DEFAULT '',        -- comma list of 0 (Sun) .. 6 (Sat); empty = every day
  start_minute INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
  end_minute INTEGER NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440),
  note TEXT NOT NULL DEFAULT '',            -- private to the person
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_availability_windows_person ON availability_windows(person_id, ends_on);

CREATE TABLE planning_notification_rules (
  campus_id INTEGER NOT NULL DEFAULT 1,
  rule_key TEXT NOT NULL CHECK (rule_key IN ('publish','change','cancel','remind')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  lead_hours INTEGER NOT NULL DEFAULT 24 CHECK (lead_hours >= 1 AND lead_hours <= 336),
  PRIMARY KEY (campus_id, rule_key)
);
INSERT INTO planning_notification_rules (campus_id, rule_key, enabled, lead_hours) VALUES
  (1, 'publish', 1, 24), (1, 'change', 1, 24), (1, 'cancel', 1, 24), (1, 'remind', 1, 24);

-- Keep the identity merge inventory exhaustive.
DROP TRIGGER person_merge_registry_keys_append_only_insert;
INSERT INTO person_merge_registry_keys(reference_key,policy) VALUES
  ('planning_events.created_by','historical_preserve'),
  ('planning_event_coordinators.person_id','dedupe_then_repoint'),
  ('planning_items.owner_person_id','subject_repoint'),
  ('planning_session_people.person_id','dedupe_then_repoint'),
  ('availability_windows.person_id','dedupe_then_repoint');
CREATE TRIGGER person_merge_registry_keys_append_only_insert BEFORE INSERT ON person_merge_registry_keys
BEGIN SELECT RAISE(ABORT,'person_merge_registry_keys_append_only'); END;

-- Existing installations keep Service Planning off until an administrator turns
-- it on in Settings -> Modules. A fresh database has no module rows and no people
-- yet, so setup's own module choices apply there. An explicit row is never changed.
INSERT INTO settings (key, value)
SELECT 'module.planning', '0'
WHERE EXISTS (SELECT 1 FROM settings WHERE key LIKE 'module.%')
   OR EXISTS (SELECT 1 FROM people)
ON CONFLICT(key) DO NOTHING;
