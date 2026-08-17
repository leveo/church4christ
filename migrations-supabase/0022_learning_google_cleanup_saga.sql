-- Durable, server-only cleanup outbox for Google Classroom registration
-- replacement and disconnect. No OAuth secret or provider payload is stored.

CREATE TABLE learning_google_cleanup_tasks (
  id BIGSERIAL PRIMARY KEY,
  connection_id BIGINT NOT NULL REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL CHECK (task_type IN ('registration','disconnect')),
  registration_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2147483647),
  claim_marker TEXT CHECK (claim_marker IS NULL OR length(claim_marker) = 36),
  claim_expires_at TEXT CHECK (claim_expires_at IS NULL OR
    octet_length(claim_expires_at) BETWEEN 19 AND 40),
  last_attempt_at TEXT CHECK (last_attempt_at IS NULL OR
    octet_length(last_attempt_at) BETWEEN 19 AND 40),
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
    CHECK (octet_length(created_at) BETWEEN 19 AND 40),
  CHECK (
    (task_type='registration' AND registration_id IS NOT NULL
      AND octet_length(registration_id) BETWEEN 1 AND 512)
    OR (task_type='disconnect' AND registration_id IS NULL)
  )
);

CREATE UNIQUE INDEX idx_learning_google_cleanup_registration
  ON learning_google_cleanup_tasks(registration_id) WHERE task_type='registration';
CREATE UNIQUE INDEX idx_learning_google_cleanup_disconnect
  ON learning_google_cleanup_tasks(connection_id) WHERE task_type='disconnect';
CREATE INDEX idx_learning_google_cleanup_drain
  ON learning_google_cleanup_tasks(connection_id,task_type,id);
CREATE UNIQUE INDEX idx_learning_google_cleanup_claim
  ON learning_google_cleanup_tasks(claim_marker) WHERE claim_marker IS NOT NULL;

ALTER TABLE learning_google_cleanup_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE learning_google_cleanup_tasks FROM PUBLIC;
REVOKE ALL ON SEQUENCE learning_google_cleanup_tasks_id_seq FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE learning_google_cleanup_tasks FROM %I', client_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE learning_google_cleanup_tasks_id_seq FROM %I', client_role);
    END IF;
  END LOOP;
END
$$;
