-- PostgreSQL parity for fair scheduled Learning reconciliation.

ALTER TABLE learning_courses ADD COLUMN last_sync_attempt_at TEXT CHECK (
  last_sync_attempt_at IS NULL OR octet_length(last_sync_attempt_at) BETWEEN 19 AND 40
);

CREATE INDEX idx_learning_courses_sync_schedule
  ON learning_courses(last_sync_attempt_at,last_synced_at,id)
  WHERE deleted_at IS NULL AND lifecycle_state='active';
