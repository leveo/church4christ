-- Explainable, live-calculated member activity scoring. The database stores
-- one revisioned church-wide model; calculated person scores are never stored.

CREATE TABLE activity_score_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_days INTEGER NOT NULL DEFAULT 90 CHECK (window_days IN (30, 60, 90, 180)),
  include_visitor INTEGER NOT NULL DEFAULT 0 CHECK (include_visitor IN (0, 1)),
  include_regular INTEGER NOT NULL DEFAULT 1 CHECK (include_regular IN (0, 1)),
  include_member INTEGER NOT NULL DEFAULT 1 CHECK (include_member IN (0, 1)),
  include_inactive INTEGER NOT NULL DEFAULT 0 CHECK (include_inactive IN (0, 1)),
  active_threshold INTEGER NOT NULL DEFAULT 70 CHECK (active_threshold BETWEEN 1 AND 100),
  watch_threshold INTEGER NOT NULL DEFAULT 40 CHECK (watch_threshold BETWEEN 0 AND 99),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by_person_id INTEGER REFERENCES people(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (include_visitor + include_regular + include_member + include_inactive > 0),
  CHECK (watch_threshold < active_threshold)
);

CREATE TABLE activity_score_dimensions (
  dimension_key TEXT PRIMARY KEY
    CHECK (dimension_key IN ('group_attendance', 'serving', 'registration')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  weight INTEGER NOT NULL CHECK (weight BETWEEN 0 AND 100),
  target_count INTEGER CHECK (target_count BETWEEN 1 AND 100),
  CHECK ((enabled = 1 AND weight > 0) OR (enabled = 0 AND weight = 0)),
  CHECK (
    (dimension_key = 'group_attendance' AND target_count IS NULL)
    OR (dimension_key IN ('serving', 'registration') AND target_count IS NOT NULL)
  )
);

INSERT INTO activity_score_config (id) VALUES (1);
INSERT INTO activity_score_dimensions (dimension_key, enabled, weight, target_count) VALUES
  ('group_attendance', 1, 50, NULL),
  ('serving', 1, 50, 3),
  ('registration', 0, 0, 2);
