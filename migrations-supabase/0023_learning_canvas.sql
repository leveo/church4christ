-- PostgreSQL parity for Canvas OAuth state, signed Live Events binding, and
-- payload-free receipt lifecycle. No provider payload, token, or student work.

CREATE TABLE learning_canvas_oauth_states (
  connection_id INTEGER PRIMARY KEY
    REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  state_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
  session_hash bytea NOT NULL CHECK (octet_length(session_hash) = 32),
  actor_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  connection_revision INTEGER NOT NULL CHECK (connection_revision BETWEEN 1 AND 2147483647),
  base_url TEXT NOT NULL CHECK (
    base_url = trim(base_url) AND octet_length(base_url) BETWEEN 9 AND 2048 AND
    base_url LIKE 'https://%' AND position('/' in substring(base_url from 9)) = 0 AND
    position('@' in substring(base_url from 9)) = 0 AND position('?' in base_url) = 0 AND
    position('#' in base_url) = 0
  ),
  redirect_uri TEXT NOT NULL CHECK (
    redirect_uri = trim(redirect_uri) AND octet_length(redirect_uri) BETWEEN 49 AND 2048 AND
    redirect_uri LIKE 'https://%/admin/learning/canvas/callback' AND
    position('@' in substring(redirect_uri from 9)) = 0 AND
    position('?' in redirect_uri) = 0 AND position('#' in redirect_uri) = 0
  ),
  verifier_ciphertext bytea NOT NULL
    CHECK (octet_length(verifier_ciphertext) BETWEEN 16 AND 16384),
  verifier_nonce bytea NOT NULL CHECK (octet_length(verifier_nonce) = 12),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  key_version INTEGER NOT NULL CHECK (key_version BETWEEN 1 AND 2147483647),
  envelope_version INTEGER NOT NULL CHECK (envelope_version IN (1,2)),
  expires_at TEXT NOT NULL CHECK (octet_length(expires_at) BETWEEN 19 AND 40),
  claim_marker TEXT UNIQUE CHECK (claim_marker IS NULL OR length(claim_marker) = 36),
  created_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (octet_length(created_at) BETWEEN 19 AND 40)
);

CREATE INDEX idx_learning_canvas_oauth_expiry
  ON learning_canvas_oauth_states(expires_at, connection_id);

CREATE TABLE learning_canvas_webhook_configs (
  connection_id INTEGER PRIMARY KEY
    REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  root_account_id TEXT NOT NULL CHECK (
    root_account_id = trim(root_account_id) AND octet_length(root_account_id) BETWEEN 1 AND 255
  ),
  verification_mode TEXT NOT NULL DEFAULT 'instructure_jwt'
    CHECK (verification_mode = 'instructure_jwt'),
  jwk_set_url TEXT NOT NULL DEFAULT 'https://8axpcl50e4.execute-api.us-east-1.amazonaws.com/main/jwks'
    CHECK (jwk_set_url = 'https://8axpcl50e4.execute-api.us-east-1.amazonaws.com/main/jwks'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (octet_length(updated_at) BETWEEN 19 AND 40)
);

CREATE UNIQUE INDEX idx_learning_canvas_webhook_account
  ON learning_canvas_webhook_configs(root_account_id, connection_id);

CREATE TABLE learning_canvas_event_receipts (
  connection_id INTEGER NOT NULL REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  source_event_id TEXT NOT NULL CHECK (
    source_event_id = trim(source_event_id) AND octet_length(source_event_id) BETWEEN 1 AND 255
  ),
  external_course_id TEXT NOT NULL CHECK (
    external_course_id = trim(external_course_id) AND octet_length(external_course_id) BETWEEN 1 AND 255
  ),
  event_name TEXT NOT NULL CHECK (
    event_name = trim(event_name) AND octet_length(event_name) BETWEEN 1 AND 96
  ),
  received_at TEXT NOT NULL CHECK (octet_length(received_at) BETWEEN 19 AND 40),
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 2147483647),
  claim_marker TEXT CHECK (claim_marker IS NULL OR length(claim_marker) = 36),
  claim_expires_at TEXT CHECK (claim_expires_at IS NULL OR octet_length(claim_expires_at) BETWEEN 19 AND 40),
  completed_at TEXT CHECK (completed_at IS NULL OR octet_length(completed_at) BETWEEN 19 AND 40),
  PRIMARY KEY (connection_id, source_event_id),
  CHECK (
    (status='pending' AND claim_marker IS NOT NULL AND claim_expires_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('succeeded','failed') AND claim_marker IS NULL AND claim_expires_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_learning_canvas_receipts_retention
  ON learning_canvas_event_receipts(received_at, connection_id, source_event_id);

CREATE INDEX idx_learning_canvas_receipts_recovery
  ON learning_canvas_event_receipts(status, claim_expires_at, connection_id, source_event_id);

ALTER TABLE learning_canvas_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_canvas_webhook_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_canvas_event_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  learning_canvas_oauth_states,
  learning_canvas_webhook_configs,
  learning_canvas_event_receipts
FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE
        learning_canvas_oauth_states,
        learning_canvas_webhook_configs,
        learning_canvas_event_receipts
      FROM %I', client_role);
    END IF;
  END LOOP;
END
$$;
