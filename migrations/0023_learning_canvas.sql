-- Canvas OAuth state, signed Live Events binding, and payload-free receipt lifecycle.
-- Raw OAuth state/verifiers/tokens and raw Live Events payloads are deliberately absent.

CREATE TABLE learning_canvas_oauth_states (
  connection_id INTEGER PRIMARY KEY
    REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  state_hash BLOB NOT NULL UNIQUE
    CHECK (typeof(state_hash) = 'blob' AND length(state_hash) = 32),
  session_hash BLOB NOT NULL
    CHECK (typeof(session_hash) = 'blob' AND length(session_hash) = 32),
  actor_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  connection_revision INTEGER NOT NULL CHECK (
    typeof(connection_revision) = 'integer' AND connection_revision BETWEEN 1 AND 2147483647
  ),
  base_url TEXT NOT NULL CHECK (
    instr(base_url,char(0)) = 0 AND base_url = trim(base_url) AND
    length(CAST(base_url AS BLOB)) BETWEEN 9 AND 2048 AND substr(base_url,1,8) = 'https://' AND
    instr(substr(base_url,9),'/') = 0 AND instr(substr(base_url,9),'@') = 0 AND
    instr(base_url,'?') = 0 AND instr(base_url,'#') = 0
  ),
  redirect_uri TEXT NOT NULL CHECK (
    instr(redirect_uri,char(0)) = 0 AND redirect_uri = trim(redirect_uri) AND
    length(CAST(redirect_uri AS BLOB)) BETWEEN 49 AND 2048 AND
    substr(redirect_uri,1,8) = 'https://' AND
    redirect_uri GLOB 'https://*/admin/learning/canvas/callback' AND
    instr(substr(redirect_uri,9),'@') = 0 AND instr(redirect_uri,'?') = 0 AND
    instr(redirect_uri,'#') = 0
  ),
  verifier_ciphertext BLOB NOT NULL CHECK (
    typeof(verifier_ciphertext) = 'blob' AND length(verifier_ciphertext) BETWEEN 16 AND 16384
  ),
  verifier_nonce BLOB NOT NULL
    CHECK (typeof(verifier_nonce) = 'blob' AND length(verifier_nonce) = 12),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  key_version INTEGER NOT NULL CHECK (
    typeof(key_version) = 'integer' AND key_version BETWEEN 1 AND 2147483647
  ),
  envelope_version INTEGER NOT NULL CHECK (
    typeof(envelope_version) = 'integer' AND envelope_version IN (1,2)
  ),
  expires_at TEXT NOT NULL CHECK (
    instr(expires_at,char(0)) = 0 AND length(CAST(expires_at AS BLOB)) BETWEEN 19 AND 40
  ),
  claim_marker TEXT UNIQUE CHECK (
    claim_marker IS NULL OR (instr(claim_marker,char(0)) = 0 AND length(claim_marker) = 36)
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (
    instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) BETWEEN 19 AND 40
  )
) WITHOUT ROWID;

CREATE INDEX idx_learning_canvas_oauth_expiry
  ON learning_canvas_oauth_states(expires_at, connection_id);

CREATE TABLE learning_canvas_webhook_configs (
  connection_id INTEGER PRIMARY KEY
    REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  root_account_id TEXT NOT NULL CHECK (
    instr(root_account_id,char(0)) = 0 AND root_account_id = trim(root_account_id) AND
    length(CAST(root_account_id AS BLOB)) BETWEEN 1 AND 255
  ),
  verification_mode TEXT NOT NULL DEFAULT 'instructure_jwt'
    CHECK (verification_mode = 'instructure_jwt'),
  jwk_set_url TEXT NOT NULL DEFAULT 'https://8axpcl50e4.execute-api.us-east-1.amazonaws.com/main/jwks'
    CHECK (jwk_set_url = 'https://8axpcl50e4.execute-api.us-east-1.amazonaws.com/main/jwks'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (
    instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) BETWEEN 19 AND 40
  )
) WITHOUT ROWID;

CREATE UNIQUE INDEX idx_learning_canvas_webhook_account
  ON learning_canvas_webhook_configs(root_account_id, connection_id);

CREATE TABLE learning_canvas_event_receipts (
  connection_id INTEGER NOT NULL REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  source_event_id TEXT NOT NULL CHECK (
    instr(source_event_id,char(0)) = 0 AND source_event_id = trim(source_event_id) AND
    length(CAST(source_event_id AS BLOB)) BETWEEN 1 AND 255
  ),
  external_course_id TEXT NOT NULL CHECK (
    instr(external_course_id,char(0)) = 0 AND external_course_id = trim(external_course_id) AND
    length(CAST(external_course_id AS BLOB)) BETWEEN 1 AND 255
  ),
  event_name TEXT NOT NULL CHECK (
    instr(event_name,char(0)) = 0 AND event_name = trim(event_name) AND
    length(CAST(event_name AS BLOB)) BETWEEN 1 AND 96
  ),
  received_at TEXT NOT NULL CHECK (
    instr(received_at,char(0)) = 0 AND length(CAST(received_at AS BLOB)) BETWEEN 19 AND 40
  ),
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 1 AND 2147483647
  ),
  claim_marker TEXT CHECK (
    claim_marker IS NULL OR (instr(claim_marker,char(0)) = 0 AND length(claim_marker) = 36)
  ),
  claim_expires_at TEXT CHECK (
    claim_expires_at IS NULL OR (
      instr(claim_expires_at,char(0)) = 0 AND length(CAST(claim_expires_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  completed_at TEXT CHECK (
    completed_at IS NULL OR (
      instr(completed_at,char(0)) = 0 AND length(CAST(completed_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  PRIMARY KEY (connection_id, source_event_id),
  CHECK (
    (status='pending' AND claim_marker IS NOT NULL AND claim_expires_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('succeeded','failed') AND claim_marker IS NULL AND claim_expires_at IS NULL AND completed_at IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE INDEX idx_learning_canvas_receipts_retention
  ON learning_canvas_event_receipts(received_at, connection_id, source_event_id);

CREATE INDEX idx_learning_canvas_receipts_recovery
  ON learning_canvas_event_receipts(status, claim_expires_at, connection_id, source_event_id);
