-- PostgreSQL parity for the durable, server-only Canvas OAuth revocation outbox.

CREATE TABLE learning_canvas_cleanup_tasks (
  connection_id INTEGER PRIMARY KEY
    REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 16 AND 16384),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  key_version INTEGER NOT NULL CHECK (key_version BETWEEN 1 AND 2147483647),
  envelope_version INTEGER NOT NULL CHECK (envelope_version IN (1,2)),
  expires_at TEXT CHECK (expires_at IS NULL OR octet_length(expires_at) BETWEEN 19 AND 40),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2147483647),
  claim_marker TEXT UNIQUE CHECK (claim_marker IS NULL OR length(claim_marker) = 36),
  claim_expires_at TEXT CHECK (
    claim_expires_at IS NULL OR octet_length(claim_expires_at) BETWEEN 19 AND 40
  ),
  last_attempt_at TEXT CHECK (
    last_attempt_at IS NULL OR octet_length(last_attempt_at) BETWEEN 19 AND 40
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (octet_length(created_at) BETWEEN 19 AND 40)
);

CREATE INDEX idx_learning_canvas_cleanup_recovery
  ON learning_canvas_cleanup_tasks(last_attempt_at,created_at,connection_id);

ALTER TABLE learning_canvas_cleanup_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE learning_canvas_cleanup_tasks FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE learning_canvas_cleanup_tasks FROM %I', client_role);
    END IF;
  END LOOP;
END
$$;
