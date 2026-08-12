-- Immutable create-only import mapping profiles. Uploaded rows and sample values
-- never enter this table; only bounded structural JSON configuration is stored.
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
      AND CASE WHEN json_valid(expected_headers_json) THEN
        json_type(expected_headers_json) = 'array'
      ELSE 0 END
    ),
  field_mappings_json TEXT NOT NULL
    CHECK (
      length(field_mappings_json) BETWEEN 2 AND 8192
      AND CASE WHEN json_valid(field_mappings_json) THEN
        json_type(field_mappings_json) = 'object'
      ELSE 0 END
    ),
  constants_json TEXT NOT NULL
    CHECK (
      length(constants_json) BETWEEN 2 AND 4096
      AND CASE WHEN json_valid(constants_json) THEN
        json_type(constants_json) = 'object'
      ELSE 0 END
    ),
  enum_translations_json TEXT NOT NULL
    CHECK (
      length(enum_translations_json) BETWEEN 2 AND 65536
      AND CASE WHEN json_valid(enum_translations_json) THEN
        json_type(enum_translations_json) = 'object'
      ELSE 0 END
    ),
  created_by_person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
) WITHOUT ROWID;

CREATE UNIQUE INDEX idx_people_import_mappings_name_key
  ON people_import_mappings(name_key);
CREATE INDEX idx_people_import_mappings_created
  ON people_import_mappings(created_at, id);
