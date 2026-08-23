-- Planning Center read-only synchronization. Client credentials remain Worker
-- secret bindings; this connection
-- table stores only non-secret configuration and status. Receipts/evidence
-- retain only bounded opaque ids and digests, never source payloads or contact fields.

CREATE TABLE planning_center_connections (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL REFERENCES campuses(id),
  base_url TEXT NOT NULL CHECK (length(base_url) BETWEEN 12 AND 200),
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 32 AND organization_id NOT GLOB '*[^0-9]*'),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','error','disabled')),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128),
  last_success_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_planning_center_connections_current_campus
  ON planning_center_connections(campus_id) WHERE state IN ('active','paused','error');
CREATE UNIQUE INDEX idx_planning_center_connections_current_organization
  ON planning_center_connections(organization_id) WHERE state IN ('active','paused','error');

CREATE TABLE planning_center_sync_cursors (
  connection_id INTEGER NOT NULL REFERENCES planning_center_connections(id),
  stream TEXT NOT NULL CHECK (stream IN ('people','person_mergers')),
  next_url TEXT CHECK (next_url IS NULL OR length(next_url) BETWEEN 1 AND 2048),
  high_watermark TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connection_id,stream)
);

CREATE TABLE planning_center_sync_jobs (
  id INTEGER PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES planning_center_connections(id),
  stream TEXT NOT NULL CHECK (stream IN ('people','person_mergers')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','review','failed')),
  cursor TEXT CHECK (cursor IS NULL OR length(cursor) BETWEEN 1 AND 2048),
  pending_cursor TEXT CHECK (pending_cursor IS NULL OR length(pending_cursor) BETWEEN 1 AND 2048),
  lease_token_hash TEXT CHECK (lease_token_hash IS NULL OR (length(lease_token_hash)=64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2147483647),
  not_before TEXT,
  rerun_requested INTEGER NOT NULL DEFAULT 0 CHECK (rerun_requested IN (0,1)),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (connection_id,stream)
);
CREATE INDEX idx_planning_center_sync_jobs_lease ON planning_center_sync_jobs(state,lease_until,not_before,updated_at);

CREATE TABLE planning_center_person_mappings (
  connection_id INTEGER NOT NULL REFERENCES planning_center_connections(id),
  provider_person_id TEXT NOT NULL CHECK (length(provider_person_id) BETWEEN 1 AND 128),
  source_record_id INTEGER NOT NULL REFERENCES identity_source_records(id),
  person_id INTEGER REFERENCES people(id),
  match_state TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_state IN ('unmatched','matched','review','deleted')),
  provider_updated_at TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connection_id,provider_person_id),
  CHECK ((match_state='matched')=(person_id IS NOT NULL))
);

CREATE TABLE planning_center_sync_receipts (
  receipt_id TEXT PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES planning_center_connections(id),
  provider_person_id TEXT,
  source_record_id INTEGER REFERENCES identity_source_records(id),
  source_version INTEGER,
  source_digest TEXT CHECK (source_digest IS NULL OR (length(source_digest)=64 AND source_digest NOT GLOB '*[^0-9a-f]*')),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK (action IN ('created','updated','deleted','review','unchanged')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE planning_center_webhook_receipts (
  receipt_id TEXT PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES planning_center_connections(id),
  delivery_id TEXT NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 256),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  signature_digest TEXT NOT NULL CHECK (length(signature_digest)=64 AND signature_digest NOT GLOB '*[^0-9a-f]*'),
  event_digest TEXT NOT NULL CHECK (length(event_digest)=64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (connection_id,delivery_id)
);

CREATE TABLE planning_center_external_evidence (
  evidence_id TEXT PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES planning_center_connections(id),
  provider_person_id TEXT,
  provider_person_remove_id TEXT CHECK (provider_person_remove_id IS NULL OR length(provider_person_remove_id) BETWEEN 1 AND 128),
  external_event_id TEXT NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 256),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('person_merger','person_deleted','person_changed')),
  event_digest TEXT NOT NULL CHECK (length(event_digest)=64 AND event_digest NOT GLOB '*[^0-9a-f]*'),
  review_case_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 0033 predates this provider table. Preserve the exact provider-mapping set
-- seen by a merge preview so a later provider sync cannot make an old approval
-- authorize a different identity graph.
CREATE TABLE planning_center_merge_mapping_snapshots (
  operation_id TEXT NOT NULL REFERENCES person_merge_operations(operation_id),
  side TEXT NOT NULL CHECK (side IN ('loser','canonical')),
  connection_id INTEGER NOT NULL REFERENCES planning_center_connections(id),
  provider_person_id TEXT NOT NULL CHECK (length(provider_person_id) BETWEEN 1 AND 128),
  source_record_id INTEGER NOT NULL REFERENCES identity_source_records(id),
  PRIMARY KEY (operation_id,side,connection_id,provider_person_id)
);
CREATE TABLE planning_center_merge_mapping_snapshot_seals (
  operation_id TEXT PRIMARY KEY REFERENCES person_merge_operations(operation_id),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 2147483647),
  expected_operation_version INTEGER NOT NULL CHECK (expected_operation_version=1),
  expected_preview_hash TEXT NOT NULL CHECK (length(expected_preview_hash)=64 AND expected_preview_hash NOT GLOB '*[^0-9a-f]*'),
  expected_risk_state_hash TEXT NOT NULL CHECK (length(expected_risk_state_hash)=64 AND expected_risk_state_hash NOT GLOB '*[^0-9a-f]*'),
  expected_risk_state_version INTEGER NOT NULL CHECK (expected_risk_state_version=1),
  expected_resolution_case_version INTEGER NOT NULL CHECK (expected_resolution_case_version BETWEEN 1 AND 2147483647),
  expected_resolution_case_hash TEXT NOT NULL CHECK (length(expected_resolution_case_hash)=64 AND expected_resolution_case_hash NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX idx_planning_center_person_mappings_person
  ON planning_center_person_mappings(person_id,connection_id,provider_person_id);

CREATE TRIGGER planning_center_person_mapping_identity_immutable
BEFORE UPDATE OF connection_id,provider_person_id,source_record_id ON planning_center_person_mappings
WHEN NEW.connection_id IS NOT OLD.connection_id OR NEW.provider_person_id IS NOT OLD.provider_person_id OR NEW.source_record_id IS NOT OLD.source_record_id
BEGIN SELECT RAISE(ABORT,'planning_center_person_mapping_identity_immutable'); END;
CREATE TRIGGER planning_center_merge_external_identity_review_guard
BEFORE INSERT ON person_merge_operations
WHEN EXISTS (SELECT 1 FROM planning_center_person_mappings m WHERE m.person_id IN (NEW.loser_person_id,NEW.canonical_person_id))
  AND (NEW.risk='normal' OR NEW.required_approvals<>2)
BEGIN SELECT RAISE(ABORT,'planning_center_merge_requires_external_identity_review'); END;
CREATE TRIGGER planning_center_merge_mapping_snapshot
AFTER INSERT ON person_merge_operations
BEGIN
  INSERT INTO planning_center_merge_mapping_snapshots(operation_id,side,connection_id,provider_person_id,source_record_id)
  SELECT NEW.operation_id,CASE WHEN m.person_id=NEW.loser_person_id THEN 'loser' ELSE 'canonical' END,
    m.connection_id,m.provider_person_id,m.source_record_id
  FROM planning_center_person_mappings m
  WHERE m.person_id IN (NEW.loser_person_id,NEW.canonical_person_id);
  INSERT INTO planning_center_merge_mapping_snapshot_seals(
    operation_id,item_count,expected_operation_version,expected_preview_hash,expected_risk_state_hash,
    expected_risk_state_version,expected_resolution_case_version,expected_resolution_case_hash)
  SELECT NEW.operation_id,COUNT(*),NEW.version,NEW.preview_hash,NEW.risk_state_hash,
    NEW.risk_state_version,NEW.expected_resolution_case_version,NEW.resolution_case_hash
  FROM planning_center_merge_mapping_snapshots WHERE operation_id=NEW.operation_id;
END;
CREATE TRIGGER planning_center_merge_mapping_stale_guard
BEFORE UPDATE ON person_merge_operations
WHEN NEW.state<>OLD.state AND NEW.state IN ('awaiting_approval','approved','executing','completed') AND (
  NOT EXISTS (SELECT 1 FROM planning_center_merge_mapping_snapshot_seals seal
    WHERE seal.operation_id=OLD.operation_id
      AND seal.item_count=(SELECT COUNT(*) FROM planning_center_merge_mapping_snapshots s WHERE s.operation_id=OLD.operation_id)
      AND seal.expected_operation_version=1 AND seal.expected_preview_hash=OLD.preview_hash
      AND seal.expected_risk_state_hash=OLD.risk_state_hash AND seal.expected_risk_state_version=OLD.risk_state_version
      AND seal.expected_resolution_case_version=OLD.expected_resolution_case_version
      AND seal.expected_resolution_case_hash=OLD.resolution_case_hash)
  OR EXISTS (SELECT CASE WHEN m.person_id=OLD.loser_person_id THEN 'loser' ELSE 'canonical' END,m.connection_id,m.provider_person_id,m.source_record_id
    FROM planning_center_person_mappings m WHERE m.person_id IN (OLD.loser_person_id,OLD.canonical_person_id)
    EXCEPT SELECT s.side,s.connection_id,s.provider_person_id,s.source_record_id FROM planning_center_merge_mapping_snapshots s WHERE s.operation_id=OLD.operation_id)
  OR EXISTS (SELECT s.side,s.connection_id,s.provider_person_id,s.source_record_id FROM planning_center_merge_mapping_snapshots s WHERE s.operation_id=OLD.operation_id
    EXCEPT SELECT CASE WHEN m.person_id=OLD.loser_person_id THEN 'loser' ELSE 'canonical' END,m.connection_id,m.provider_person_id,m.source_record_id
      FROM planning_center_person_mappings m WHERE m.person_id IN (OLD.loser_person_id,OLD.canonical_person_id))
)
BEGIN SELECT RAISE(ABORT,'planning_center_merge_mapping_stale'); END;
CREATE TRIGGER planning_center_merge_external_identity_decision_guard
BEFORE UPDATE ON person_merge_operations
WHEN NEW.state IN ('approved','executing')
  AND EXISTS (SELECT 1 FROM planning_center_merge_mapping_snapshots s WHERE s.operation_id=OLD.operation_id)
  AND NOT EXISTS (SELECT 1 FROM person_merge_conflict_decisions d WHERE d.operation_id=OLD.operation_id AND d.category='external_identity'
    AND d.expected_preview_hash=OLD.preview_hash AND d.expected_risk_state_hash=OLD.risk_state_hash
    AND d.expected_risk_state_version=OLD.risk_state_version
    AND d.expected_resolution_case_version=OLD.expected_resolution_case_version
    AND d.expected_resolution_case_hash=OLD.resolution_case_hash)
BEGIN SELECT RAISE(ABORT,'planning_center_merge_external_identity_decision_missing'); END;
CREATE TRIGGER planning_center_mapping_executing_insert_guard
BEFORE INSERT ON planning_center_person_mappings
WHEN NEW.person_id IS NOT NULL AND EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.state='executing'
  AND NEW.person_id IN (op.loser_person_id,op.canonical_person_id))
BEGIN SELECT RAISE(ABORT,'planning_center_mapping_merge_executing'); END;
CREATE TRIGGER planning_center_mapping_executing_update_guard
BEFORE UPDATE ON planning_center_person_mappings
WHEN EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.state='executing'
  AND (OLD.person_id IN (op.loser_person_id,op.canonical_person_id) OR NEW.person_id IN (op.loser_person_id,op.canonical_person_id)))
BEGIN SELECT RAISE(ABORT,'planning_center_mapping_merge_executing'); END;
CREATE TRIGGER planning_center_mapping_executing_delete_guard
BEFORE DELETE ON planning_center_person_mappings
WHEN OLD.person_id IS NOT NULL AND EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.state='executing'
  AND OLD.person_id IN (op.loser_person_id,op.canonical_person_id))
BEGIN SELECT RAISE(ABORT,'planning_center_mapping_merge_executing'); END;
CREATE TRIGGER planning_center_merge_mapping_snapshots_append_only_update
BEFORE UPDATE ON planning_center_merge_mapping_snapshots BEGIN SELECT RAISE(ABORT,'planning_center_merge_mapping_snapshots_append_only'); END;
CREATE TRIGGER planning_center_merge_mapping_snapshots_append_only_delete
BEFORE DELETE ON planning_center_merge_mapping_snapshots BEGIN SELECT RAISE(ABORT,'planning_center_merge_mapping_snapshots_append_only'); END;
CREATE TRIGGER planning_center_merge_mapping_snapshots_sealed_insert
BEFORE INSERT ON planning_center_merge_mapping_snapshots
WHEN EXISTS (SELECT 1 FROM planning_center_merge_mapping_snapshot_seals seal WHERE seal.operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'planning_center_merge_mapping_snapshots_sealed'); END;
CREATE TRIGGER planning_center_merge_mapping_snapshot_seals_append_only_update
BEFORE UPDATE ON planning_center_merge_mapping_snapshot_seals BEGIN SELECT RAISE(ABORT,'planning_center_merge_mapping_snapshot_seals_append_only'); END;
CREATE TRIGGER planning_center_merge_mapping_snapshot_seals_append_only_delete
BEFORE DELETE ON planning_center_merge_mapping_snapshot_seals BEGIN SELECT RAISE(ABORT,'planning_center_merge_mapping_snapshot_seals_append_only'); END;
CREATE TRIGGER planning_center_sync_receipts_append_only_update
BEFORE UPDATE ON planning_center_sync_receipts BEGIN SELECT RAISE(ABORT,'planning_center_sync_receipts_append_only'); END;
CREATE TRIGGER planning_center_sync_receipts_append_only_delete
BEFORE DELETE ON planning_center_sync_receipts BEGIN SELECT RAISE(ABORT,'planning_center_sync_receipts_append_only'); END;
CREATE TRIGGER planning_center_webhook_receipts_append_only_update
BEFORE UPDATE ON planning_center_webhook_receipts BEGIN SELECT RAISE(ABORT,'planning_center_webhook_receipts_append_only'); END;
CREATE TRIGGER planning_center_webhook_receipts_append_only_delete
BEFORE DELETE ON planning_center_webhook_receipts BEGIN SELECT RAISE(ABORT,'planning_center_webhook_receipts_append_only'); END;
CREATE TRIGGER planning_center_external_evidence_append_only_update
BEFORE UPDATE ON planning_center_external_evidence BEGIN SELECT RAISE(ABORT,'planning_center_external_evidence_append_only'); END;
CREATE TRIGGER planning_center_external_evidence_append_only_delete
BEFORE DELETE ON planning_center_external_evidence BEGIN SELECT RAISE(ABORT,'planning_center_external_evidence_append_only'); END;
