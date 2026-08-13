-- PostgreSQL parity for migrations/0015_onboarding.sql.
CREATE TABLE onboarding_acknowledgements (
  check_id TEXT PRIMARY KEY
    CHECK (octet_length(check_id) BETWEEN 1 AND 80 AND check_id ~ '^[a-z][a-z0-9-]*$'),
  actor_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  acknowledged_at TEXT NOT NULL
    CHECK (acknowledged_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'),
  definition_version INTEGER NOT NULL CHECK (definition_version BETWEEN 1 AND 2147483647)
);

CREATE INDEX idx_onboarding_acknowledgements_time
  ON onboarding_acknowledgements(acknowledged_at, check_id);
