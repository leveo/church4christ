-- Crash-safe Google Pub/Sub receipt claims. A succeeded receipt is terminal;
-- failed or expired pending work may be reclaimed by a later redelivery.

ALTER TABLE learning_google_notification_receipts
  ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','failed','succeeded')),
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 2147483647),
  ADD COLUMN claim_marker TEXT
    CHECK (claim_marker IS NULL OR length(claim_marker) = 36),
  ADD COLUMN claim_expires_at TEXT
    CHECK (claim_expires_at IS NULL OR octet_length(claim_expires_at) BETWEEN 19 AND 40),
  ADD COLUMN completed_at TEXT
    CHECK (completed_at IS NULL OR octet_length(completed_at) BETWEEN 19 AND 40);

CREATE UNIQUE INDEX idx_learning_google_receipts_claim_marker
  ON learning_google_notification_receipts(claim_marker) WHERE claim_marker IS NOT NULL;
CREATE INDEX idx_learning_google_receipts_recovery
  ON learning_google_notification_receipts(status, claim_expires_at, subscription_name, message_id);

ALTER TABLE learning_google_notification_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE learning_google_notification_receipts FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE learning_google_notification_receipts FROM %I', client_role);
    END IF;
  END LOOP;
END
$$;
