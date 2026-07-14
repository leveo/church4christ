-- Private Stripe durability tables. These relations are intentionally outside
-- public so Supabase Data API roles cannot access raw webhook or Checkout data.
CREATE SCHEMA IF NOT EXISTS church_private;
REVOKE ALL ON SCHEMA church_private FROM PUBLIC;

CREATE TABLE church_private.stripe_webhook_events (
  event_id TEXT PRIMARY KEY CHECK (octet_length(event_id) BETWEEN 1 AND 255),
  payload_json TEXT,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  event_type TEXT NOT NULL CHECK (octet_length(event_type) BETWEEN 1 AND 255),
  api_version TEXT CHECK (api_version IS NULL OR octet_length(api_version) BETWEEN 1 AND 64),
  event_created INTEGER NOT NULL CHECK (event_created >= 0),
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','processed','ignored','failed','dismissed')),
  outcome TEXT CHECK (outcome IS NULL OR octet_length(outcome) <= 128),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_cycle_attempts INTEGER NOT NULL DEFAULT 0 CHECK (retry_cycle_attempts >= 0),
  next_attempt_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR octet_length(last_error) <= 1000),
  last_action_by INTEGER REFERENCES public.people(id) ON DELETE SET NULL,
  last_action_at TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((status = 'processing') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX stripe_webhook_events_due_idx
  ON church_private.stripe_webhook_events(status, next_attempt_at);
CREATE INDEX stripe_webhook_events_lease_idx
  ON church_private.stripe_webhook_events(lease_expires_at);
CREATE INDEX stripe_webhook_events_received_idx
  ON church_private.stripe_webhook_events(received_at DESC, event_id DESC);

CREATE TABLE church_private.stripe_checkout_requests (
  request_id TEXT PRIMARY KEY CHECK (octet_length(request_id) BETWEEN 1 AND 255),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  registration_id INTEGER NOT NULL UNIQUE REFERENCES public.registrations(id) ON DELETE CASCADE,
  request_json TEXT,
  session_url TEXT,
  state TEXT NOT NULL DEFAULT 'creating'
    CHECK (state IN ('creating','attached','manual_review','resolved')),
  reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0),
  next_reconcile_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR octet_length(last_error) <= 1000),
  last_action_by INTEGER REFERENCES public.people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (state <> 'creating' OR request_json IS NOT NULL),
  CHECK (state NOT IN ('manual_review','resolved') OR (request_json IS NULL AND session_url IS NULL))
);

CREATE INDEX stripe_checkout_requests_due_idx
  ON church_private.stripe_checkout_requests(state, next_reconcile_at);
CREATE INDEX stripe_checkout_requests_registration_idx
  ON church_private.stripe_checkout_requests(registration_id);

REVOKE ALL ON ALL TABLES IN SCHEMA church_private FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA church_private FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA church_private FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA church_private FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA church_private FROM authenticated;
  END IF;
END $$;
