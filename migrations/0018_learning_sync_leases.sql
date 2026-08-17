-- Forward-only bounded leases for crash recovery and one-winner Learning sync finalization.

ALTER TABLE learning_provider_connections ADD COLUMN operation_expires_at TEXT CHECK (
  operation_expires_at IS NULL OR (
    instr(operation_expires_at,char(0)) = 0 AND
    length(CAST(operation_expires_at AS BLOB)) BETWEEN 19 AND 40
  )
);

ALTER TABLE learning_sync_runs ADD COLUMN lease_marker TEXT CHECK (
  lease_marker IS NULL OR (
    instr(lease_marker,char(0)) = 0 AND length(lease_marker) = 36
  )
);
ALTER TABLE learning_sync_runs ADD COLUMN lease_expires_at TEXT CHECK (
  lease_expires_at IS NULL OR (
    instr(lease_expires_at,char(0)) = 0 AND
    length(CAST(lease_expires_at AS BLOB)) BETWEEN 19 AND 40
  )
);
ALTER TABLE learning_sync_runs ADD COLUMN finalization_marker TEXT CHECK (
  finalization_marker IS NULL OR (
    instr(finalization_marker,char(0)) = 0 AND length(finalization_marker) = 36
  )
);

-- A 0017 process could crash after claiming the shared connection marker but
-- before recording a terminal run or finishing a credential operation. No
-- legacy running row has a resumable lease, so converge it to a bounded safe
-- terminal fact and release every legacy marker. Both updates are idempotent.
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
