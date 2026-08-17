-- Crash-safe Google Pub/Sub receipt claims. A succeeded receipt is terminal;
-- failed or expired pending work may be reclaimed by a later redelivery.

ALTER TABLE learning_google_notification_receipts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending','failed','succeeded'));
ALTER TABLE learning_google_notification_receipts ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 2147483647);
ALTER TABLE learning_google_notification_receipts ADD COLUMN claim_marker TEXT
  CHECK (claim_marker IS NULL OR (instr(claim_marker,char(0)) = 0 AND length(claim_marker) = 36));
ALTER TABLE learning_google_notification_receipts ADD COLUMN claim_expires_at TEXT
  CHECK (claim_expires_at IS NULL OR (
    instr(claim_expires_at,char(0)) = 0 AND length(CAST(claim_expires_at AS BLOB)) BETWEEN 19 AND 40
  ));
ALTER TABLE learning_google_notification_receipts ADD COLUMN completed_at TEXT
  CHECK (completed_at IS NULL OR (
    instr(completed_at,char(0)) = 0 AND length(CAST(completed_at AS BLOB)) BETWEEN 19 AND 40
  ));

CREATE UNIQUE INDEX idx_learning_google_receipts_claim_marker
  ON learning_google_notification_receipts(claim_marker) WHERE claim_marker IS NOT NULL;
CREATE INDEX idx_learning_google_receipts_recovery
  ON learning_google_notification_receipts(status, claim_expires_at, subscription_name, message_id);
