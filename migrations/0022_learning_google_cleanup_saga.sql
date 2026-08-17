-- Durable, server-only cleanup outbox for Google Classroom registration
-- replacement and disconnect. No OAuth secret or provider payload is stored.

CREATE TABLE learning_google_cleanup_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL CHECK (task_type IN ('registration','disconnect')),
  registration_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 2147483647),
  claim_marker TEXT CHECK (claim_marker IS NULL OR (
    instr(claim_marker,char(0)) = 0 AND length(claim_marker) = 36
  )),
  claim_expires_at TEXT CHECK (claim_expires_at IS NULL OR (
    instr(claim_expires_at,char(0)) = 0 AND length(CAST(claim_expires_at AS BLOB)) BETWEEN 19 AND 40
  )),
  last_attempt_at TEXT CHECK (last_attempt_at IS NULL OR (
    instr(last_attempt_at,char(0)) = 0 AND length(CAST(last_attempt_at AS BLOB)) BETWEEN 19 AND 40
  )),
  created_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (
    instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) BETWEEN 19 AND 40
  ),
  CHECK (
    (task_type='registration' AND registration_id IS NOT NULL
      AND instr(registration_id,char(0)) = 0
      AND length(CAST(registration_id AS BLOB)) BETWEEN 1 AND 512)
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
