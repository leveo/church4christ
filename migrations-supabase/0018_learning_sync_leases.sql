-- PostgreSQL parity for bounded crash-recoverable Learning sync leases.

ALTER TABLE learning_provider_connections ADD COLUMN operation_expires_at TEXT
  CHECK (operation_expires_at IS NULL OR octet_length(operation_expires_at) BETWEEN 19 AND 40);

ALTER TABLE learning_sync_runs ADD COLUMN lease_marker TEXT
  CHECK (lease_marker IS NULL OR length(lease_marker) = 36);
ALTER TABLE learning_sync_runs ADD COLUMN lease_expires_at TEXT
  CHECK (lease_expires_at IS NULL OR octet_length(lease_expires_at) BETWEEN 19 AND 40);
ALTER TABLE learning_sync_runs ADD COLUMN finalization_marker TEXT
  CHECK (finalization_marker IS NULL OR length(finalization_marker) = 36);

-- Legacy 0017 work cannot be resumed because it has no bounded lease. Safely
-- terminalize every such run and release both sync and credential crash
-- markers. The predicates make the data backfill idempotent.
UPDATE learning_sync_runs
SET status='failed',finished_at=started_at,error_code='internal_error',
  lease_marker=NULL,lease_expires_at=NULL,finalization_marker=NULL
WHERE status='running';

UPDATE learning_provider_connections
SET operation_marker=NULL,operation_expires_at=NULL
WHERE operation_marker IS NOT NULL OR operation_expires_at IS NOT NULL;

CREATE UNIQUE INDEX idx_learning_sync_runs_lease
  ON learning_sync_runs(lease_marker) WHERE lease_marker IS NOT NULL;
CREATE UNIQUE INDEX idx_learning_sync_runs_finalization
  ON learning_sync_runs(finalization_marker) WHERE finalization_marker IS NOT NULL;

-- Reassert the server-only posture after altering these existing relations.
ALTER TABLE learning_provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_sync_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE learning_provider_connections,learning_sync_runs FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE learning_provider_connections,learning_sync_runs FROM %I',
        client_role
      );
    END IF;
  END LOOP;
END
$$;
