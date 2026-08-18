-- Fair scheduled Learning reconciliation. This server-only timestamp records
-- scheduler attempts, including failures before a provider snapshot starts, so
-- one unhealthy course cannot permanently starve the remaining active graph.

ALTER TABLE learning_courses ADD COLUMN last_sync_attempt_at TEXT CHECK (
  last_sync_attempt_at IS NULL OR (
    instr(last_sync_attempt_at,char(0)) = 0 AND
    length(CAST(last_sync_attempt_at AS BLOB)) BETWEEN 19 AND 40
  )
);

CREATE INDEX idx_learning_courses_sync_schedule
  ON learning_courses(last_sync_attempt_at,last_synced_at,id)
  WHERE deleted_at IS NULL AND lifecycle_state='active';
