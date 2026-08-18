-- Durable, server-only Canvas OAuth revocation outbox. The encrypted credential
-- moves here before the active envelope is deleted, so local disconnect never
-- depends on Canvas availability and a bounded scheduled pass can retry safely.

CREATE TABLE learning_canvas_cleanup_tasks (
  connection_id INTEGER PRIMARY KEY
    REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  ciphertext BLOB NOT NULL CHECK (
    typeof(ciphertext) = 'blob' AND length(ciphertext) BETWEEN 16 AND 16384
  ),
  nonce BLOB NOT NULL CHECK (typeof(nonce) = 'blob' AND length(nonce) = 12),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  key_version INTEGER NOT NULL CHECK (
    typeof(key_version) = 'integer' AND key_version BETWEEN 1 AND 2147483647
  ),
  envelope_version INTEGER NOT NULL CHECK (
    typeof(envelope_version) = 'integer' AND envelope_version IN (1,2)
  ),
  expires_at TEXT CHECK (
    expires_at IS NULL OR (
      instr(expires_at,char(0)) = 0 AND length(CAST(expires_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 2147483647
  ),
  claim_marker TEXT UNIQUE CHECK (
    claim_marker IS NULL OR (instr(claim_marker,char(0)) = 0 AND length(claim_marker) = 36)
  ),
  claim_expires_at TEXT CHECK (
    claim_expires_at IS NULL OR (
      instr(claim_expires_at,char(0)) = 0 AND length(CAST(claim_expires_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  last_attempt_at TEXT CHECK (
    last_attempt_at IS NULL OR (
      instr(last_attempt_at,char(0)) = 0 AND length(CAST(last_attempt_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (
    instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) BETWEEN 19 AND 40
  )
) WITHOUT ROWID;

CREATE INDEX idx_learning_canvas_cleanup_recovery
  ON learning_canvas_cleanup_tasks(last_attempt_at,created_at,connection_id);
