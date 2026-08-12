-- PostgreSQL parity for migrations/0012_people_import_mappings.sql.
-- IDs are allocated by the immutable insert-select in the application so the
-- cross-backend 100-profile ceiling remains concurrency safe.
CREATE TABLE people_import_mappings (
  id INTEGER PRIMARY KEY
    CHECK (id BETWEEN 1 AND 100),
  name TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 80),
  name_key TEXT NOT NULL
    CHECK (length(name_key) BETWEEN 1 AND 80),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (version = 1),
  expected_headers_json TEXT NOT NULL
    CHECK (
      length(expected_headers_json) BETWEEN 2 AND 65536
      AND jsonb_typeof(expected_headers_json::jsonb) = 'array'
    ),
  field_mappings_json TEXT NOT NULL
    CHECK (
      length(field_mappings_json) BETWEEN 2 AND 8192
      AND jsonb_typeof(field_mappings_json::jsonb) = 'object'
    ),
  constants_json TEXT NOT NULL
    CHECK (
      length(constants_json) BETWEEN 2 AND 4096
      AND jsonb_typeof(constants_json::jsonb) = 'object'
    ),
  enum_translations_json TEXT NOT NULL
    CHECK (
      length(enum_translations_json) BETWEEN 2 AND 65536
      AND jsonb_typeof(enum_translations_json::jsonb) = 'object'
    ),
  created_by_person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_people_import_mappings_name_key
  ON people_import_mappings(name_key);
CREATE INDEX idx_people_import_mappings_created
  ON people_import_mappings(created_at, id);
