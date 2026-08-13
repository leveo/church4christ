-- Forward-only onboarding acknowledgement storage. Definitions and copy remain
-- in config/readiness.json; this table records only super-admin attestations.
CREATE TABLE onboarding_acknowledgements (
  check_id TEXT PRIMARY KEY
    CHECK (instr(check_id,char(0)) = 0 AND length(CAST(check_id AS BLOB)) BETWEEN 1 AND 80 AND
      check_id = lower(trim(check_id)) AND substr(check_id,1,1) GLOB '[a-z]' AND check_id NOT GLOB '*[^-a-z0-9]*'),
  actor_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  acknowledged_at TEXT NOT NULL
    CHECK (length(acknowledged_at) = 19 AND instr(acknowledged_at,char(0)) = 0),
  definition_version INTEGER NOT NULL CHECK (definition_version BETWEEN 1 AND 2147483647)
) WITHOUT ROWID;

CREATE INDEX idx_onboarding_acknowledgements_time
  ON onboarding_acknowledgements(acknowledged_at, check_id);
