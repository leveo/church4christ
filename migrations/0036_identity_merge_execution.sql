-- Atomic person-merge execution and bounded rollback evidence. 0033 owns the
-- preview/risk/approval state machine; this migration only seals executable
-- local-row references and adds a separately approved rollback operation.

-- 0033 freezes this closed registry after seeding. Extend it only inside this
-- migration, then immediately restore the insert guard for runtime callers.
DROP TRIGGER person_merge_registry_keys_append_only_insert;
INSERT INTO person_merge_registry_keys(reference_key,policy) VALUES
  ('person_merge_rollback_approvals.approver_person_id','historical_preserve'),
  ('person_merge_rollback_operations.requested_by_person_id','historical_preserve');
CREATE TRIGGER person_merge_registry_keys_append_only_insert BEFORE INSERT ON person_merge_registry_keys
BEGIN SELECT RAISE(ABORT,'person_merge_registry_keys_append_only'); END;

ALTER TABLE person_merge_redirects ADD COLUMN merge_operation_id TEXT
  REFERENCES person_merge_operations(operation_id);
CREATE UNIQUE INDEX idx_person_merge_redirects_operation
  ON person_merge_redirects(merge_operation_id) WHERE merge_operation_id IS NOT NULL;

CREATE TABLE person_merge_reference_facts (
  operation_id TEXT NOT NULL REFERENCES person_merge_operations(operation_id),
  reference_key TEXT NOT NULL,
  policy TEXT NOT NULL CHECK(policy IN ('subject_repoint','dedupe_then_repoint','operational_actor_repoint','historical_preserve','security_revoke','hard_conflict')),
  side TEXT NOT NULL CHECK(side IN ('loser','canonical')),
  local_row_id TEXT NOT NULL CHECK(length(CAST(local_row_id AS BLOB)) BETWEEN 1 AND 192 AND instr(local_row_id,char(0))=0),
  row_key_hash TEXT NOT NULL CHECK(length(row_key_hash)=64 AND row_key_hash=lower(row_key_hash) AND row_key_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(operation_id,reference_key,side,local_row_id),
  UNIQUE(operation_id,reference_key,side,row_key_hash),
  FOREIGN KEY(reference_key,policy) REFERENCES person_merge_registry_keys(reference_key,policy)
);

CREATE TABLE person_merge_execution_seals (
  operation_id TEXT PRIMARY KEY REFERENCES person_merge_operations(operation_id),
  expected_operation_version INTEGER NOT NULL CHECK(expected_operation_version=1),
  expected_preview_hash TEXT NOT NULL CHECK(length(expected_preview_hash)=64 AND expected_preview_hash=lower(expected_preview_hash) AND expected_preview_hash NOT GLOB '*[^0-9a-f]*'),
  expected_risk_state_hash TEXT NOT NULL CHECK(length(expected_risk_state_hash)=64 AND expected_risk_state_hash=lower(expected_risk_state_hash) AND expected_risk_state_hash NOT GLOB '*[^0-9a-f]*'),
  expected_risk_state_version INTEGER NOT NULL CHECK(expected_risk_state_version=1),
  expected_resolution_case_version INTEGER NOT NULL CHECK(expected_resolution_case_version BETWEEN 1 AND 2147483647),
  expected_resolution_case_hash TEXT NOT NULL CHECK(length(expected_resolution_case_hash)=64 AND expected_resolution_case_hash=lower(expected_resolution_case_hash) AND expected_resolution_case_hash NOT GLOB '*[^0-9a-f]*'),
  inventory_hash TEXT NOT NULL CHECK(length(inventory_hash)=64 AND inventory_hash=lower(inventory_hash) AND inventory_hash NOT GLOB '*[^0-9a-f]*'),
  inventory_count INTEGER NOT NULL CHECK(inventory_count BETWEEN 0 AND 2147483647),
  expected_mutation_count INTEGER NOT NULL CHECK(expected_mutation_count BETWEEN 0 AND 2147483647),
  expected_irreversible_count INTEGER NOT NULL CHECK(expected_irreversible_count BETWEEN 0 AND expected_mutation_count),
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE person_merge_journal_row_details (
  journal_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  before_local_row_id TEXT NOT NULL CHECK(length(CAST(before_local_row_id AS BLOB)) BETWEEN 1 AND 192 AND instr(before_local_row_id,char(0))=0),
  after_local_row_id TEXT NOT NULL CHECK(length(CAST(after_local_row_id AS BLOB)) BETWEEN 1 AND 192 AND instr(after_local_row_id,char(0))=0),
  before_row_hash TEXT NOT NULL CHECK(length(before_row_hash)=64 AND before_row_hash=lower(before_row_hash) AND before_row_hash NOT GLOB '*[^0-9a-f]*'),
  after_row_hash TEXT NOT NULL CHECK(length(after_row_hash)=64 AND after_row_hash=lower(after_row_hash) AND after_row_hash NOT GLOB '*[^0-9a-f]*'),
  rollback_mode TEXT NOT NULL CHECK(rollback_mode IN ('reversible','security_irreversible')),
  affected_count INTEGER NOT NULL CHECK(affected_count=1),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  FOREIGN KEY(operation_id,journal_id) REFERENCES person_merge_reassignment_journal(operation_id,journal_id)
);

CREATE TABLE person_merge_rollback_operations (
  rollback_id TEXT PRIMARY KEY CHECK(length(rollback_id)=36 AND rollback_id=lower(rollback_id)
    AND substr(rollback_id,9,1)='-' AND substr(rollback_id,14,1)='-'
    AND substr(rollback_id,19,1)='-' AND substr(rollback_id,24,1)='-'
    AND length(replace(rollback_id,'-',''))=32 AND rollback_id NOT GLOB '*[^0-9a-f-]*'),
  operation_id TEXT NOT NULL UNIQUE REFERENCES person_merge_operations(operation_id),
  expected_operation_version INTEGER NOT NULL CHECK(expected_operation_version BETWEEN 1 AND 2147483647),
  journal_hash TEXT NOT NULL CHECK(length(journal_hash)=64 AND journal_hash=lower(journal_hash) AND journal_hash NOT GLOB '*[^0-9a-f]*'),
  journal_count INTEGER NOT NULL CHECK(journal_count BETWEEN 0 AND 2147483647),
  required_approvals INTEGER NOT NULL CHECK(required_approvals IN (1,2)),
  state TEXT NOT NULL DEFAULT 'previewed' CHECK(state IN ('previewed','awaiting_approval','approved','executing','completed','failed','expired','cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
  requested_by_person_id INTEGER NOT NULL REFERENCES people(id),
  expires_at TEXT NOT NULL CHECK(length(expires_at)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',julianday(expires_at)) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',julianday(expires_at))=expires_at),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);

CREATE TABLE person_merge_rollback_approvals (
  approval_id TEXT PRIMARY KEY CHECK(length(approval_id)=36 AND approval_id=lower(approval_id)
    AND substr(approval_id,9,1)='-' AND substr(approval_id,14,1)='-'
    AND substr(approval_id,19,1)='-' AND substr(approval_id,24,1)='-'
    AND length(replace(approval_id,'-',''))=32 AND approval_id NOT GLOB '*[^0-9a-f-]*'),
  rollback_id TEXT NOT NULL REFERENCES person_merge_rollback_operations(rollback_id),
  approver_person_id INTEGER NOT NULL REFERENCES people(id),
  step_up_challenge_id INTEGER NOT NULL UNIQUE REFERENCES identity_challenges(id),
  approval_order INTEGER NOT NULL CHECK(approval_order IN (1,2)),
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
  expected_rollback_version INTEGER NOT NULL CHECK(expected_rollback_version BETWEEN 1 AND 2147483647),
  expected_journal_hash TEXT NOT NULL CHECK(length(expected_journal_hash)=64 AND expected_journal_hash=lower(expected_journal_hash) AND expected_journal_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(rollback_id,approver_person_id),
  UNIQUE(rollback_id,approval_order)
);

ALTER TABLE person_merge_rollback_receipts ADD COLUMN rollback_id TEXT
  REFERENCES person_merge_rollback_operations(rollback_id);
CREATE UNIQUE INDEX idx_person_merge_rollback_receipts_rollback_journal
  ON person_merge_rollback_receipts(rollback_id,journal_id) WHERE rollback_id IS NOT NULL;

CREATE TRIGGER person_merge_reference_facts_binding_guard BEFORE INSERT ON person_merge_reference_facts
BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM person_merge_operations op
    WHERE op.operation_id=NEW.operation_id AND op.state='previewed' AND op.version=1)
  THEN RAISE(ABORT,'person_merge_reference_fact_binding') END; END;
CREATE TRIGGER person_merge_reference_facts_insert_guard BEFORE INSERT ON person_merge_reference_facts
WHEN EXISTS (SELECT 1 FROM person_merge_execution_seals seal WHERE seal.operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'person_merge_reference_facts_sealed'); END;
CREATE TRIGGER person_merge_execution_seals_binding_guard BEFORE INSERT ON person_merge_execution_seals
BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM person_merge_operations op
    WHERE op.operation_id=NEW.operation_id AND op.state='previewed' AND op.version=NEW.expected_operation_version
      AND op.preview_hash=NEW.expected_preview_hash
      AND op.risk_state_hash=NEW.expected_risk_state_hash AND op.risk_state_version=NEW.expected_risk_state_version
      AND op.expected_resolution_case_version=NEW.expected_resolution_case_version
      AND op.resolution_case_hash=NEW.expected_resolution_case_hash)
    OR NEW.inventory_count<>(SELECT COUNT(*) FROM person_merge_reference_facts fact WHERE fact.operation_id=NEW.operation_id)
  THEN RAISE(ABORT,'person_merge_execution_seal_binding') END; END;
CREATE TRIGGER person_merge_journal_row_details_binding_guard BEFORE INSERT ON person_merge_journal_row_details
BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM person_merge_reassignment_journal journal
    JOIN person_merge_operations op ON op.operation_id=journal.operation_id
    WHERE journal.operation_id=NEW.operation_id AND journal.journal_id=NEW.journal_id
      AND journal.affected_count=NEW.affected_count AND op.state='executing')
  THEN RAISE(ABORT,'person_merge_journal_detail_binding') END; END;

-- A receipt is the in-transaction mutation claim.  Closed literal branches
-- prove the exact local row still belongs to the sealed loser before a handler
-- changes or revokes it; the completion guard below proves every post-state.
CREATE TRIGGER person_merge_core_receipt_precondition_guard
BEFORE INSERT ON person_merge_mutation_receipts
WHEN NEW.reference_key IN (
  'gift_results.person_id','identity_observations.linked_person_id','identity_source_records.linked_person_id',
  'newcomer_submissions.linked_person_id','person_notes.person_id','person_contact_links.person_id',
  'group_members.person_id','team_members.person_id','campus_memberships.person_id','tokens.person_id',
  'identity_challenges.person_id','group_attendance_tokens.person_id',
  'learning_google_oauth_states.actor_person_id','learning_canvas_oauth_states.actor_person_id','people.calendar_token')
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM person_merge_reference_facts fact
      WHERE fact.operation_id=NEW.operation_id AND fact.reference_key=NEW.reference_key
        AND fact.policy=NEW.policy AND fact.side='loser' AND fact.row_key_hash=NEW.row_key_hash)
    OR CASE NEW.reference_key
      WHEN 'gift_results.person_id' THEN NOT EXISTS (SELECT 1 FROM gift_results x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.id AS TEXT)
        WHERE x.person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'identity_observations.linked_person_id' THEN NOT EXISTS (SELECT 1 FROM identity_observations x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.id AS TEXT)
        WHERE x.linked_person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'identity_source_records.linked_person_id' THEN NOT EXISTS (SELECT 1 FROM identity_source_records x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.id AS TEXT)
        WHERE x.state='linked' AND x.linked_person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'newcomer_submissions.linked_person_id' THEN NOT EXISTS (SELECT 1 FROM newcomer_submissions x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.id AS TEXT)
        WHERE x.linked_person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'person_notes.person_id' THEN NOT EXISTS (SELECT 1 FROM person_notes x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.id AS TEXT)
        WHERE x.person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'person_contact_links.person_id' THEN NOT EXISTS (SELECT 1 FROM person_contact_links x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.id AS TEXT)
        WHERE x.person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'group_members.person_id' THEN NOT EXISTS (SELECT 1 FROM group_members x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.id AS TEXT)
        WHERE x.person_id=NEW.loser_person_id AND x.is_admin=0 AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'team_members.person_id' THEN NOT EXISTS (SELECT 1 FROM team_members x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.team_id AS TEXT)
        WHERE x.person_id=NEW.loser_person_id AND x.is_leader=0 AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'campus_memberships.person_id' THEN NOT EXISTS (SELECT 1 FROM campus_memberships x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.campus_id AS TEXT)
        WHERE x.person_id=NEW.loser_person_id AND x.role='member' AND x.finance=0 AND x.admin_areas=''
          AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'tokens.person_id' THEN NOT EXISTS (SELECT 1 FROM tokens x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.id AS TEXT)
        WHERE x.person_id=NEW.loser_person_id AND x.used_at IS NULL AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'identity_challenges.person_id' THEN NOT EXISTS (SELECT 1 FROM identity_challenges x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.id AS TEXT)
        WHERE x.person_id=NEW.loser_person_id AND x.consumed_at IS NULL AND x.superseded_at IS NULL
          AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'group_attendance_tokens.person_id' THEN NOT EXISTS (SELECT 1 FROM group_attendance_tokens x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.id AS TEXT)
        WHERE x.person_id=NEW.loser_person_id AND x.used_at IS NULL AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'learning_google_oauth_states.actor_person_id' THEN NOT EXISTS (SELECT 1 FROM learning_google_oauth_states x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.connection_id AS TEXT)
        WHERE x.actor_person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'learning_canvas_oauth_states.actor_person_id' THEN NOT EXISTS (SELECT 1 FROM learning_canvas_oauth_states x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.connection_id AS TEXT)
        WHERE x.actor_person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash)
      WHEN 'people.calendar_token' THEN NOT EXISTS (SELECT 1 FROM people x JOIN person_merge_reference_facts f
        ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=CAST(x.id AS TEXT)
        WHERE x.id=NEW.loser_person_id AND x.calendar_token IS NOT NULL AND x.calendar_token<>''
          AND f.row_key_hash=NEW.row_key_hash)
      ELSE 1 END
  THEN RAISE(ABORT,'person_merge_core_receipt_precondition') END;
END;

DROP TRIGGER identity_source_records_link_immutable;
CREATE TRIGGER identity_source_records_link_immutable
BEFORE UPDATE OF linked_person_id,state ON identity_source_records
WHEN OLD.linked_person_id IS NOT NULL AND (
  NEW.linked_person_id IS NOT OLD.linked_person_id OR NEW.state IS NOT OLD.state
) AND NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN person_merge_mutation_receipts receipt
    ON receipt.operation_id=op.operation_id AND receipt.reference_key='identity_source_records.linked_person_id'
    JOIN person_merge_reference_facts fact ON fact.operation_id=op.operation_id
      AND fact.reference_key=receipt.reference_key AND fact.row_key_hash=receipt.row_key_hash
  WHERE op.state='executing' AND op.loser_person_id=OLD.linked_person_id
    AND op.canonical_person_id=NEW.linked_person_id AND NEW.state=OLD.state AND fact.side='loser'
    AND fact.local_row_id=CAST(OLD.id AS TEXT))
AND NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
  JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
  JOIN person_merge_rollback_receipts receipt ON receipt.rollback_id=rollback.rollback_id AND receipt.outcome='reverted'
  JOIN person_merge_reassignment_journal journal ON journal.operation_id=op.operation_id AND journal.journal_id=receipt.journal_id
  JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
  WHERE rollback.state='executing' AND journal.reference_key='identity_source_records.linked_person_id'
    AND op.canonical_person_id=OLD.linked_person_id AND op.loser_person_id=NEW.linked_person_id
    AND NEW.state=OLD.state AND detail.after_local_row_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'identity_source_attachment_immutable'); END;

DROP TRIGGER identity_source_observation_link_immutable;
DROP TRIGGER identity_source_observation_attachment_guard;
CREATE TRIGGER identity_source_observation_attachment_guard
BEFORE UPDATE OF status,linked_person_id ON identity_observations
WHEN NEW.status='linked' AND EXISTS (SELECT 1 FROM identity_source_records x WHERE x.observation_id=OLD.id)
AND NOT EXISTS (SELECT 1 FROM identity_source_records s JOIN identity_source_attachment_receipts r ON r.source_record_id=s.id
  WHERE s.observation_id=OLD.id AND s.state='linked' AND s.linked_person_id=NEW.linked_person_id
    AND r.person_id=NEW.linked_person_id AND r.source_version=s.version AND r.source_digest=s.source_digest)
AND NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN person_merge_mutation_receipts receipt
    ON receipt.operation_id=op.operation_id AND receipt.reference_key='identity_observations.linked_person_id'
    JOIN person_merge_reference_facts fact ON fact.operation_id=op.operation_id
      AND fact.reference_key=receipt.reference_key AND fact.row_key_hash=receipt.row_key_hash
  WHERE op.state='executing' AND op.loser_person_id=OLD.linked_person_id
    AND op.canonical_person_id=NEW.linked_person_id AND NEW.status=OLD.status AND fact.side='loser'
    AND fact.local_row_id=CAST(OLD.id AS TEXT))
AND NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
  JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
  JOIN person_merge_rollback_receipts receipt ON receipt.rollback_id=rollback.rollback_id AND receipt.outcome='reverted'
  JOIN person_merge_reassignment_journal journal ON journal.operation_id=op.operation_id AND journal.journal_id=receipt.journal_id
  JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
  WHERE rollback.state='executing' AND journal.reference_key='identity_observations.linked_person_id'
    AND op.canonical_person_id=OLD.linked_person_id AND op.loser_person_id=NEW.linked_person_id
    AND NEW.status=OLD.status AND detail.after_local_row_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'identity_source_attachment_commit_invalid'); END;

CREATE TRIGGER identity_source_observation_link_immutable
BEFORE UPDATE OF status,linked_person_id ON identity_observations
WHEN EXISTS (SELECT 1 FROM identity_source_records s JOIN identity_source_attachment_receipts r ON r.source_record_id=s.id
  WHERE s.observation_id=OLD.id AND s.state='linked' AND s.linked_person_id=r.person_id)
AND NOT EXISTS (SELECT 1 FROM identity_source_records s WHERE s.observation_id=OLD.id AND s.state='linked'
  AND NEW.status='linked' AND NEW.linked_person_id IS s.linked_person_id)
AND NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN person_merge_mutation_receipts receipt
    ON receipt.operation_id=op.operation_id AND receipt.reference_key='identity_observations.linked_person_id'
    JOIN person_merge_reference_facts fact ON fact.operation_id=op.operation_id
      AND fact.reference_key=receipt.reference_key AND fact.row_key_hash=receipt.row_key_hash
  WHERE op.state='executing' AND op.loser_person_id=OLD.linked_person_id
    AND op.canonical_person_id=NEW.linked_person_id AND NEW.status=OLD.status AND fact.side='loser'
    AND fact.local_row_id=CAST(OLD.id AS TEXT))
AND NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
  JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
  JOIN person_merge_rollback_receipts receipt ON receipt.rollback_id=rollback.rollback_id AND receipt.outcome='reverted'
  JOIN person_merge_reassignment_journal journal ON journal.operation_id=op.operation_id AND journal.journal_id=receipt.journal_id
  JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
  WHERE rollback.state='executing' AND journal.reference_key='identity_observations.linked_person_id'
    AND op.canonical_person_id=OLD.linked_person_id AND op.loser_person_id=NEW.linked_person_id
    AND NEW.status=OLD.status AND detail.after_local_row_id=CAST(OLD.id AS TEXT))
BEGIN SELECT RAISE(ABORT,'identity_source_observation_immutable'); END;

DROP TRIGGER identity_newcomer_submission_binding_update_guard;
CREATE TRIGGER identity_newcomer_submission_binding_update_guard
BEFORE UPDATE OF identity_source_record_id,linked_person_id,campus_id ON newcomer_submissions
WHEN ((OLD.identity_source_record_id IS NULL AND NEW.identity_source_record_id IS NOT NULL)
  OR (OLD.identity_source_record_id IS NOT NULL AND (
    NEW.identity_source_record_id IS NOT OLD.identity_source_record_id OR NEW.linked_person_id IS NOT OLD.linked_person_id
    OR NEW.campus_id IS NOT OLD.campus_id)))
AND NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN person_merge_mutation_receipts receipt
    ON receipt.operation_id=op.operation_id AND receipt.reference_key='newcomer_submissions.linked_person_id'
    JOIN person_merge_reference_facts fact ON fact.operation_id=op.operation_id
      AND fact.reference_key=receipt.reference_key AND fact.row_key_hash=receipt.row_key_hash
  WHERE op.state='executing' AND op.loser_person_id=OLD.linked_person_id
    AND op.canonical_person_id=NEW.linked_person_id
    AND NEW.identity_source_record_id IS OLD.identity_source_record_id AND NEW.campus_id=OLD.campus_id
    AND fact.side='loser' AND fact.local_row_id=OLD.id)
AND NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
  JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
  JOIN person_merge_rollback_receipts receipt ON receipt.rollback_id=rollback.rollback_id AND receipt.outcome='reverted'
  JOIN person_merge_reassignment_journal journal ON journal.operation_id=op.operation_id AND journal.journal_id=receipt.journal_id
  JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
  WHERE rollback.state='executing' AND journal.reference_key='newcomer_submissions.linked_person_id'
    AND op.canonical_person_id=OLD.linked_person_id AND op.loser_person_id=NEW.linked_person_id
    AND NEW.identity_source_record_id IS OLD.identity_source_record_id AND NEW.campus_id=OLD.campus_id
    AND detail.after_local_row_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'identity_newcomer_submission_binding_immutable'); END;

CREATE TRIGGER person_merge_operations_completion_seal_guard
BEFORE UPDATE ON person_merge_operations WHEN NEW.state='completed'
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM person_merge_execution_seals seal
      WHERE seal.operation_id=OLD.operation_id
        AND seal.inventory_count=(SELECT COUNT(*) FROM person_merge_reference_facts fact WHERE fact.operation_id=OLD.operation_id)
        AND seal.expected_mutation_count=(SELECT COUNT(*) FROM person_merge_reference_facts fact
          WHERE fact.operation_id=OLD.operation_id AND fact.side='loser')
        AND seal.expected_irreversible_count=(SELECT COUNT(*) FROM person_merge_reference_facts fact
          WHERE fact.operation_id=OLD.operation_id AND fact.side='loser' AND fact.policy='security_revoke')
        AND seal.expected_mutation_count=(SELECT COUNT(*) FROM person_merge_mutation_receipts receipt WHERE receipt.operation_id=OLD.operation_id)
        AND seal.expected_mutation_count=(SELECT COUNT(*) FROM person_merge_reassignment_journal journal WHERE journal.operation_id=OLD.operation_id)
        AND seal.expected_mutation_count=(SELECT COUNT(*) FROM person_merge_journal_row_details detail WHERE detail.operation_id=OLD.operation_id))
    OR EXISTS (SELECT 1 FROM person_merge_reference_facts fact
      WHERE fact.operation_id=OLD.operation_id AND fact.side='loser' AND fact.reference_key NOT IN (
        'gift_results.person_id','identity_observations.linked_person_id','identity_source_records.linked_person_id',
        'newcomer_submissions.linked_person_id','person_notes.person_id','person_contact_links.person_id',
        'group_members.person_id','team_members.person_id','campus_memberships.person_id','tokens.person_id',
        'identity_challenges.person_id','group_attendance_tokens.person_id',
        'people.calendar_token'))
    OR EXISTS (SELECT 1 FROM person_merge_reference_facts fact
      WHERE fact.operation_id=OLD.operation_id AND fact.side='loser' AND CASE fact.reference_key
        WHEN 'gift_results.person_id' THEN NOT EXISTS (SELECT 1 FROM gift_results x
          WHERE CAST(x.id AS TEXT)=fact.local_row_id AND x.person_id=OLD.canonical_person_id)
        WHEN 'identity_observations.linked_person_id' THEN NOT EXISTS (SELECT 1 FROM identity_observations x
          WHERE CAST(x.id AS TEXT)=fact.local_row_id AND x.linked_person_id=OLD.canonical_person_id)
        WHEN 'identity_source_records.linked_person_id' THEN NOT EXISTS (SELECT 1 FROM identity_source_records x
          WHERE CAST(x.id AS TEXT)=fact.local_row_id AND x.linked_person_id=OLD.canonical_person_id AND x.state='linked')
        WHEN 'newcomer_submissions.linked_person_id' THEN NOT EXISTS (SELECT 1 FROM newcomer_submissions x
          WHERE x.id=fact.local_row_id AND x.linked_person_id=OLD.canonical_person_id)
        WHEN 'person_notes.person_id' THEN NOT EXISTS (SELECT 1 FROM person_notes x
          WHERE CAST(x.id AS TEXT)=fact.local_row_id AND x.person_id=OLD.canonical_person_id)
        WHEN 'person_contact_links.person_id' THEN NOT EXISTS (SELECT 1 FROM person_contact_links x
          WHERE CAST(x.id AS TEXT)=fact.local_row_id AND x.person_id=OLD.canonical_person_id)
        WHEN 'group_members.person_id' THEN NOT EXISTS (SELECT 1 FROM group_members x
          WHERE CAST(x.id AS TEXT)=fact.local_row_id AND x.person_id=OLD.canonical_person_id AND x.is_admin=0)
        WHEN 'team_members.person_id' THEN NOT EXISTS (SELECT 1 FROM team_members x
          WHERE CAST(x.team_id AS TEXT)=fact.local_row_id AND x.person_id=OLD.canonical_person_id AND x.is_leader=0)
        WHEN 'campus_memberships.person_id' THEN NOT EXISTS (SELECT 1 FROM campus_memberships x
          WHERE CAST(x.campus_id AS TEXT)=fact.local_row_id AND x.person_id=OLD.canonical_person_id
            AND x.role='member' AND x.finance=0 AND x.admin_areas='')
        WHEN 'tokens.person_id' THEN NOT EXISTS (SELECT 1 FROM tokens x
          WHERE CAST(x.id AS TEXT)=fact.local_row_id AND x.person_id=OLD.loser_person_id AND x.used_at IS NOT NULL)
        WHEN 'identity_challenges.person_id' THEN NOT EXISTS (SELECT 1 FROM identity_challenges x
          WHERE CAST(x.id AS TEXT)=fact.local_row_id AND x.person_id=OLD.loser_person_id AND x.superseded_at IS NOT NULL)
        WHEN 'group_attendance_tokens.person_id' THEN NOT EXISTS (SELECT 1 FROM group_attendance_tokens x
          WHERE CAST(x.id AS TEXT)=fact.local_row_id AND x.person_id=OLD.loser_person_id AND x.used_at IS NOT NULL)
        WHEN 'people.calendar_token' THEN NOT EXISTS (SELECT 1 FROM people x
          WHERE CAST(x.id AS TEXT)=fact.local_row_id AND x.id=OLD.loser_person_id AND x.calendar_token IS NULL)
        ELSE 1 END)
    OR EXISTS (SELECT 1 FROM gift_results WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM identity_observations WHERE linked_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM identity_source_records WHERE linked_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM newcomer_submissions WHERE linked_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM person_notes WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM person_contact_links WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM group_members WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM team_members WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM campus_memberships WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM tokens WHERE person_id=OLD.loser_person_id AND used_at IS NULL)
    OR EXISTS (SELECT 1 FROM identity_challenges WHERE person_id=OLD.loser_person_id
      AND consumed_at IS NULL AND superseded_at IS NULL)
    OR EXISTS (SELECT 1 FROM group_attendance_tokens WHERE person_id=OLD.loser_person_id AND used_at IS NULL)
    OR EXISTS (SELECT 1 FROM activity_score_config WHERE updated_by_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM blockout_dates WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM group_join_requests WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM learning_activity_events WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM learning_canvas_oauth_states WHERE actor_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM learning_google_oauth_states WHERE actor_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM learning_programs WHERE created_by_person_id=OLD.loser_person_id OR updated_by_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM learning_provider_connections
      WHERE created_by_person_id=OLD.loser_person_id OR updated_by_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM ministries WHERE leader_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM newcomer_submissions WHERE assignee_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM person_interests WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM roster_assignments WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM team_applications WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM testimonies WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM people WHERE merged_into_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM verified_contact_owners WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM household_members WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM person_external_identities WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM learning_identity_links WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM planning_center_person_mappings WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM identity_source_records WHERE provisional_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM identity_newcomer_intents WHERE provisional_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM identity_person_canonical_keys WHERE person_id=OLD.loser_person_id AND is_current=1)
    OR EXISTS (SELECT 1 FROM identity_source_provisional_operations WHERE reserved_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM identity_source_provisional_receipts WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM identity_account_operations WHERE reserved_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM external_ids WHERE entity='people' AND entity_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
      WHERE (h.expected_person_id=OLD.loser_person_id OR h.expected_reachable_owner_person_id=OLD.loser_person_id)
        AND c.state='open' AND julianday(h.expires_at)>julianday('now'))
    OR EXISTS (SELECT 1 FROM person_merge_reference_facts fact WHERE fact.operation_id=OLD.operation_id AND fact.side='loser'
      AND NOT EXISTS (SELECT 1 FROM person_merge_mutation_receipts receipt JOIN person_merge_reassignment_journal journal
          ON journal.operation_id=receipt.operation_id AND journal.mutation_receipt_id=receipt.mutation_receipt_id
        JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
        WHERE receipt.operation_id=fact.operation_id AND receipt.reference_key=fact.reference_key
          AND receipt.row_key_hash=fact.row_key_hash AND receipt.policy=fact.policy))
    OR NOT EXISTS (SELECT 1 FROM people loser,people canonical
      WHERE loser.id=OLD.loser_person_id AND loser.active=0 AND loser.identity_state='merged'
        AND loser.merged_into_person_id=OLD.canonical_person_id AND loser.auth_disabled_at IS NOT NULL
        AND loser.identity_version=OLD.expected_loser_identity_version+1
        AND loser.session_epoch=OLD.expected_loser_session_epoch+1 AND loser.calendar_token IS NULL
        AND canonical.id=OLD.canonical_person_id AND canonical.active=1 AND canonical.deleted_at IS NULL
        AND canonical.identity_state='active' AND canonical.auth_disabled_at IS NULL
        AND canonical.identity_version=OLD.expected_canonical_identity_version+1
        AND canonical.session_epoch=OLD.expected_canonical_session_epoch+1)
    OR NOT EXISTS (SELECT 1 FROM person_merge_redirects redirect WHERE redirect.loser_person_id=OLD.loser_person_id
      AND redirect.canonical_person_id=OLD.canonical_person_id AND redirect.merge_operation_id=OLD.operation_id)
    OR NOT EXISTS (SELECT 1 FROM identity_resolution_cases c WHERE c.id=OLD.resolution_case_id
      AND c.state='merged' AND c.version=OLD.expected_resolution_case_version+1)
  THEN RAISE(ABORT,'person_merge_completion_seal_invalid') END;
END;

CREATE TRIGGER person_merge_rollback_operations_insert_guard BEFORE INSERT ON person_merge_rollback_operations
BEGIN SELECT CASE WHEN NEW.state<>'previewed' OR NEW.version<>1
    OR julianday(NEW.expires_at)<=julianday('now') OR julianday(NEW.expires_at)>julianday('now','+24 hours')
    OR NOT EXISTS (SELECT 1 FROM person_merge_operations op
      JOIN people requester ON requester.id=NEW.requested_by_person_id
      WHERE op.operation_id=NEW.operation_id AND op.state='completed' AND op.version=NEW.expected_operation_version
        AND requester.role='admin' AND requester.active=1 AND requester.deleted_at IS NULL
        AND requester.identity_state='active' AND requester.auth_disabled_at IS NULL
        AND (op.scope_kind<>'global' OR requester.super_admin=1)
        AND (op.risk='normal' OR requester.super_admin=1)
        AND julianday(NEW.expires_at)<=julianday(op.updated_at,'+24 hours')
        AND NEW.required_approvals=op.required_approvals
        AND NEW.journal_count=(SELECT COUNT(*) FROM person_merge_reassignment_journal journal WHERE journal.operation_id=op.operation_id))
  THEN RAISE(ABORT,'person_merge_rollback_binding') END; END;
CREATE TRIGGER person_merge_rollback_operations_immutable_guard BEFORE UPDATE ON person_merge_rollback_operations
BEGIN SELECT CASE WHEN NEW.rollback_id IS NOT OLD.rollback_id OR NEW.operation_id IS NOT OLD.operation_id
    OR NEW.expected_operation_version IS NOT OLD.expected_operation_version OR NEW.journal_hash IS NOT OLD.journal_hash
    OR NEW.journal_count IS NOT OLD.journal_count OR NEW.required_approvals IS NOT OLD.required_approvals
    OR NEW.requested_by_person_id IS NOT OLD.requested_by_person_id OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.created_at IS NOT OLD.created_at THEN RAISE(ABORT,'person_merge_rollback_immutable') END; END;
CREATE TRIGGER person_merge_rollback_operations_state_cas_guard BEFORE UPDATE ON person_merge_rollback_operations
BEGIN SELECT CASE WHEN NEW.version<>OLD.version+1 THEN RAISE(ABORT,'person_merge_rollback_state_cas') END; END;
CREATE TRIGGER person_merge_rollback_operations_transition_guard BEFORE UPDATE ON person_merge_rollback_operations
BEGIN SELECT CASE WHEN NOT ((OLD.state='previewed' AND NEW.state IN ('awaiting_approval','cancelled','expired'))
    OR (OLD.state='awaiting_approval' AND NEW.state IN ('approved','cancelled','expired'))
    OR (OLD.state='approved' AND NEW.state IN ('executing','cancelled','expired'))
    OR (OLD.state='executing' AND NEW.state IN ('completed','failed')))
  THEN RAISE(ABORT,'person_merge_rollback_transition') END; END;
CREATE TRIGGER person_merge_rollback_operations_expiry_guard BEFORE UPDATE ON person_merge_rollback_operations
WHEN NEW.state IN ('awaiting_approval','approved','executing','completed') AND julianday(OLD.expires_at)<=julianday('now')
BEGIN SELECT RAISE(ABORT,'person_merge_rollback_expired'); END;

CREATE TRIGGER person_merge_rollback_approvals_binding_guard BEFORE INSERT ON person_merge_rollback_approvals
BEGIN SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM person_merge_rollback_operations rollback
  JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
  JOIN people approver ON approver.id=NEW.approver_person_id
  JOIN identity_challenges stepup ON stepup.id=NEW.step_up_challenge_id
  WHERE rollback.rollback_id=NEW.rollback_id AND rollback.state='awaiting_approval'
    AND rollback.version=NEW.expected_rollback_version AND rollback.journal_hash=NEW.expected_journal_hash
    AND NEW.approval_order=(SELECT COUNT(*)+1 FROM person_merge_rollback_approvals a WHERE a.rollback_id=NEW.rollback_id)
    AND NEW.approval_order<=rollback.required_approvals
    AND approver.role='admin' AND approver.active=1 AND approver.deleted_at IS NULL
    AND approver.identity_state='active' AND approver.auth_disabled_at IS NULL
    AND (op.risk='normal' OR approver.super_admin=1)
    AND (op.scope_kind='global' OR EXISTS (SELECT 1 FROM campus_memberships cm JOIN campuses campus ON campus.id=cm.campus_id
      WHERE cm.person_id=approver.id AND cm.campus_id=op.campus_id AND cm.active=1 AND cm.role='admin' AND campus.active=1))
    AND stepup.purpose='step_up' AND stepup.person_id=approver.id AND stepup.expected_session_epoch=approver.session_epoch
    AND stepup.consumed_at IS NOT NULL AND stepup.superseded_at IS NULL
    AND julianday(stepup.created_at)<=julianday(stepup.consumed_at)
    AND julianday(stepup.consumed_at)<=julianday(stepup.expires_at)
    AND julianday(stepup.consumed_at)>julianday('now','-10 minutes') AND julianday(stepup.consumed_at)<=julianday('now')
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.rollback_id') AS TEXT)=rollback.rollback_id
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.rollback_version') AS INTEGER)=NEW.expected_rollback_version
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.operation_id') AS TEXT)=rollback.operation_id
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.expected_operation_version') AS INTEGER)=rollback.expected_operation_version
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.journal_hash') AS TEXT)=rollback.journal_hash
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.journal_count') AS INTEGER)=rollback.journal_count
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.approver_person_id') AS INTEGER)=approver.id
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.approver_identity_version') AS INTEGER)=approver.identity_version
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.campus_id') AS INTEGER)=stepup.campus_id
    AND (op.scope_kind='global' OR stepup.campus_id=op.campus_id)
    AND EXISTS (SELECT 1 FROM campus_memberships cm JOIN campuses campus ON campus.id=cm.campus_id
      WHERE cm.person_id=approver.id AND cm.campus_id=stepup.campus_id AND cm.active=1 AND cm.role='admin' AND campus.active=1)
) THEN RAISE(ABORT,'person_merge_rollback_approval_invalid') END; END;

CREATE TRIGGER person_merge_rollback_approval_gate_guard BEFORE UPDATE ON person_merge_rollback_operations
WHEN NEW.state='approved'
BEGIN SELECT CASE WHEN (SELECT COUNT(*) FROM person_merge_rollback_approvals approval
    WHERE approval.rollback_id=OLD.rollback_id AND approval.decision='approve'
      AND approval.expected_rollback_version=OLD.version AND approval.expected_journal_hash=OLD.journal_hash)<OLD.required_approvals
  THEN RAISE(ABORT,'person_merge_rollback_approvals_missing') END; END;

CREATE TRIGGER person_merge_rollback_approval_live_guard BEFORE UPDATE ON person_merge_rollback_operations
WHEN NEW.state IN ('approved','executing')
BEGIN SELECT CASE WHEN (SELECT COUNT(*) FROM person_merge_rollback_approvals approval
  JOIN people approver ON approver.id=approval.approver_person_id
  JOIN identity_challenges stepup ON stepup.id=approval.step_up_challenge_id
  JOIN person_merge_operations op ON op.operation_id=OLD.operation_id
  WHERE approval.rollback_id=OLD.rollback_id AND approval.decision='approve'
    AND ((NEW.state='approved' AND approval.expected_rollback_version=OLD.version)
      OR (NEW.state='executing' AND approval.expected_rollback_version=OLD.version-1))
    AND approval.expected_journal_hash=OLD.journal_hash
    AND approver.role='admin' AND approver.active=1 AND approver.deleted_at IS NULL
    AND approver.identity_state='active' AND approver.auth_disabled_at IS NULL
    AND (op.risk='normal' OR approver.super_admin=1)
    AND stepup.purpose='step_up' AND stepup.person_id=approver.id AND stepup.expected_session_epoch=approver.session_epoch
    AND stepup.consumed_at IS NOT NULL AND stepup.superseded_at IS NULL
    AND julianday(stepup.consumed_at)>julianday('now','-10 minutes') AND julianday(stepup.consumed_at)<=julianday('now')
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.rollback_id') AS TEXT)=OLD.rollback_id
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.rollback_version') AS INTEGER)=approval.expected_rollback_version
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.operation_id') AS TEXT)=OLD.operation_id
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.expected_operation_version') AS INTEGER)=OLD.expected_operation_version
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.journal_hash') AS TEXT)=OLD.journal_hash
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.journal_count') AS INTEGER)=OLD.journal_count
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.approver_person_id') AS INTEGER)=approver.id
    AND CAST(json_extract(stepup.context_json,'$.person_merge_rollback_approval.approver_identity_version') AS INTEGER)=approver.identity_version
    AND (op.scope_kind='global' OR EXISTS (SELECT 1 FROM campus_memberships cm JOIN campuses campus ON campus.id=cm.campus_id
      WHERE cm.person_id=approver.id AND cm.campus_id=op.campus_id AND cm.active=1 AND cm.role='admin' AND campus.active=1)))
  <OLD.required_approvals THEN RAISE(ABORT,'person_merge_rollback_approval_stale') END; END;

CREATE TRIGGER person_merge_rollback_approval_veto_guard BEFORE UPDATE ON person_merge_rollback_operations
WHEN NEW.state IN ('approved','executing') AND EXISTS (SELECT 1 FROM person_merge_rollback_approvals approval
  WHERE approval.rollback_id=OLD.rollback_id AND approval.decision='reject')
BEGIN SELECT RAISE(ABORT,'person_merge_rollback_approval_veto'); END;

CREATE TRIGGER person_merge_rollback_step_up_direct_consumed_guard BEFORE INSERT ON identity_challenges
WHEN NEW.purpose='step_up' AND NEW.consumed_at IS NOT NULL
  AND json_type(NEW.context_json,'$.person_merge_rollback_approval')='object'
BEGIN SELECT RAISE(ABORT,'person_merge_rollback_step_up_must_be_consumed'); END;
CREATE TRIGGER person_merge_rollback_step_up_binding_immutable BEFORE UPDATE ON identity_challenges
WHEN OLD.purpose='step_up' AND OLD.consumed_at IS NOT NULL
  AND json_type(OLD.context_json,'$.person_merge_rollback_approval')='object'
  AND (NEW.purpose<>OLD.purpose OR NEW.person_id IS NOT OLD.person_id OR NEW.campus_id<>OLD.campus_id
    OR NEW.context_json<>OLD.context_json OR NEW.created_at<>OLD.created_at OR NEW.consumed_at IS NOT OLD.consumed_at
    OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NOT OLD.superseded_at))
BEGIN SELECT RAISE(ABORT,'person_merge_rollback_step_up_binding_immutable'); END;

DROP TRIGGER person_merge_redirects_append_only_delete;
CREATE TRIGGER person_merge_redirects_append_only_delete BEFORE DELETE ON person_merge_redirects
WHEN NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
  JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
  WHERE rollback.state='executing' AND rollback.operation_id=OLD.merge_operation_id
    AND op.state='completed' AND op.loser_person_id=OLD.loser_person_id
    AND op.canonical_person_id=OLD.canonical_person_id)
BEGIN SELECT RAISE(ABORT,'person_merge_redirects_append_only'); END;

DROP TRIGGER person_merge_rollback_receipts_state_guard;
CREATE TRIGGER person_merge_rollback_receipts_state_guard BEFORE INSERT ON person_merge_rollback_receipts
BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
    JOIN person_merge_reassignment_journal journal ON journal.operation_id=rollback.operation_id
    WHERE rollback.rollback_id=NEW.rollback_id AND rollback.state='executing'
      AND journal.journal_id=NEW.journal_id AND journal.operation_id=NEW.operation_id)
  THEN RAISE(ABORT,'person_merge_rollback_state') END; END;

CREATE TRIGGER person_merge_rollback_receipt_precondition_guard BEFORE INSERT ON person_merge_rollback_receipts
WHEN NEW.outcome='reverted'
BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
    JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
    JOIN person_merge_reassignment_journal journal ON journal.operation_id=op.operation_id AND journal.journal_id=NEW.journal_id
    JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
    WHERE rollback.rollback_id=NEW.rollback_id AND rollback.state='executing' AND journal.policy<>'security_revoke'
      AND ((journal.reference_key='gift_results.person_id' AND EXISTS (SELECT 1 FROM gift_results x
          WHERE CAST(x.id AS TEXT)=detail.after_local_row_id AND x.person_id=op.canonical_person_id))
        OR (journal.reference_key='identity_observations.linked_person_id' AND EXISTS (SELECT 1 FROM identity_observations x
          WHERE CAST(x.id AS TEXT)=detail.after_local_row_id AND x.linked_person_id=op.canonical_person_id))
        OR (journal.reference_key='identity_source_records.linked_person_id' AND EXISTS (SELECT 1 FROM identity_source_records x
          WHERE CAST(x.id AS TEXT)=detail.after_local_row_id AND x.linked_person_id=op.canonical_person_id AND x.state='linked'))
        OR (journal.reference_key='newcomer_submissions.linked_person_id' AND EXISTS (SELECT 1 FROM newcomer_submissions x
          WHERE x.id=detail.after_local_row_id AND x.linked_person_id=op.canonical_person_id))
        OR (journal.reference_key='person_notes.person_id' AND EXISTS (SELECT 1 FROM person_notes x
          WHERE CAST(x.id AS TEXT)=detail.after_local_row_id AND x.person_id=op.canonical_person_id))
        OR (journal.reference_key='person_contact_links.person_id' AND EXISTS (SELECT 1 FROM person_contact_links x
          WHERE CAST(x.id AS TEXT)=detail.after_local_row_id AND x.person_id=op.canonical_person_id))
        OR (journal.reference_key='group_members.person_id' AND EXISTS (SELECT 1 FROM group_members x
          WHERE CAST(x.id AS TEXT)=detail.after_local_row_id AND x.person_id=op.canonical_person_id AND x.is_admin=0))
        OR (journal.reference_key='team_members.person_id' AND EXISTS (SELECT 1 FROM team_members x
          WHERE CAST(x.team_id AS TEXT)=detail.after_local_row_id AND x.person_id=op.canonical_person_id AND x.is_leader=0))
        OR (journal.reference_key='campus_memberships.person_id' AND EXISTS (SELECT 1 FROM campus_memberships x
          WHERE CAST(x.campus_id AS TEXT)=detail.after_local_row_id AND x.person_id=op.canonical_person_id
            AND x.role='member' AND x.finance=0 AND x.admin_areas=''))))
  THEN RAISE(ABORT,'person_merge_rollback_row_drift') END; END;

CREATE TRIGGER person_merge_rollback_completion_guard BEFORE UPDATE ON person_merge_rollback_operations
WHEN NEW.state='completed'
BEGIN SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM person_merge_operations op
    WHERE op.operation_id=OLD.operation_id AND op.state='completed' AND op.version=OLD.expected_operation_version
      AND NOT EXISTS (SELECT 1 FROM person_merge_redirects redirect WHERE redirect.merge_operation_id=op.operation_id)
      AND EXISTS (SELECT 1 FROM people loser,people canonical WHERE loser.id=op.loser_person_id
        AND loser.active=1 AND loser.deleted_at IS NULL AND loser.identity_state='active'
        AND loser.auth_disabled_at IS NULL AND loser.merged_into_person_id IS NULL AND loser.calendar_token IS NULL
        AND loser.identity_version=op.expected_loser_identity_version+2
        AND loser.session_epoch=op.expected_loser_session_epoch+2
        AND canonical.id=op.canonical_person_id AND canonical.active=1 AND canonical.deleted_at IS NULL
        AND canonical.identity_state='active' AND canonical.auth_disabled_at IS NULL
        AND canonical.identity_version=op.expected_canonical_identity_version+2
        AND canonical.session_epoch=op.expected_canonical_session_epoch+2)
      AND EXISTS (SELECT 1 FROM identity_resolution_cases c WHERE c.id=op.resolution_case_id
        AND c.state='same_person' AND c.version=op.expected_resolution_case_version+2))
    OR OLD.journal_count<>(SELECT COUNT(*) FROM person_merge_rollback_receipts receipt WHERE receipt.rollback_id=OLD.rollback_id)
    OR EXISTS (SELECT 1 FROM person_merge_reassignment_journal journal
      LEFT JOIN person_merge_rollback_receipts receipt ON receipt.rollback_id=OLD.rollback_id AND receipt.journal_id=journal.journal_id
      WHERE journal.operation_id=OLD.operation_id AND (receipt.receipt_id IS NULL
        OR (journal.policy='security_revoke' AND (receipt.outcome<>'skipped' OR receipt.reverted_count<>0))
        OR (journal.policy<>'security_revoke' AND (receipt.outcome<>'reverted' OR receipt.reverted_count<>1))))
    OR EXISTS (SELECT 1 FROM person_merge_reassignment_journal journal
      JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
      JOIN person_merge_operations op ON op.operation_id=journal.operation_id
      WHERE journal.operation_id=OLD.operation_id AND journal.policy<>'security_revoke' AND NOT (
        (journal.reference_key='gift_results.person_id' AND EXISTS (SELECT 1 FROM gift_results x WHERE CAST(x.id AS TEXT)=detail.before_local_row_id AND x.person_id=op.loser_person_id))
        OR (journal.reference_key='identity_observations.linked_person_id' AND EXISTS (SELECT 1 FROM identity_observations x WHERE CAST(x.id AS TEXT)=detail.before_local_row_id AND x.linked_person_id=op.loser_person_id))
        OR (journal.reference_key='identity_source_records.linked_person_id' AND EXISTS (SELECT 1 FROM identity_source_records x WHERE CAST(x.id AS TEXT)=detail.before_local_row_id AND x.linked_person_id=op.loser_person_id))
        OR (journal.reference_key='newcomer_submissions.linked_person_id' AND EXISTS (SELECT 1 FROM newcomer_submissions x WHERE x.id=detail.before_local_row_id AND x.linked_person_id=op.loser_person_id))
        OR (journal.reference_key='person_notes.person_id' AND EXISTS (SELECT 1 FROM person_notes x WHERE CAST(x.id AS TEXT)=detail.before_local_row_id AND x.person_id=op.loser_person_id))
        OR (journal.reference_key='person_contact_links.person_id' AND EXISTS (SELECT 1 FROM person_contact_links x WHERE CAST(x.id AS TEXT)=detail.before_local_row_id AND x.person_id=op.loser_person_id))
        OR (journal.reference_key='group_members.person_id' AND EXISTS (SELECT 1 FROM group_members x WHERE CAST(x.id AS TEXT)=detail.before_local_row_id AND x.person_id=op.loser_person_id))
        OR (journal.reference_key='team_members.person_id' AND EXISTS (SELECT 1 FROM team_members x WHERE CAST(x.team_id AS TEXT)=detail.before_local_row_id AND x.person_id=op.loser_person_id))
        OR (journal.reference_key='campus_memberships.person_id' AND EXISTS (SELECT 1 FROM campus_memberships x WHERE CAST(x.campus_id AS TEXT)=detail.before_local_row_id AND x.person_id=op.loser_person_id))))
  THEN RAISE(ABORT,'person_merge_rollback_completion_invalid') END; END;

CREATE TRIGGER person_merge_reference_facts_append_only_update BEFORE UPDATE ON person_merge_reference_facts
BEGIN SELECT RAISE(ABORT,'person_merge_reference_facts_append_only'); END;
CREATE TRIGGER person_merge_reference_facts_append_only_delete BEFORE DELETE ON person_merge_reference_facts
BEGIN SELECT RAISE(ABORT,'person_merge_reference_facts_append_only'); END;
CREATE TRIGGER person_merge_execution_seals_append_only_update BEFORE UPDATE ON person_merge_execution_seals
BEGIN SELECT RAISE(ABORT,'person_merge_execution_seals_append_only'); END;
CREATE TRIGGER person_merge_execution_seals_append_only_delete BEFORE DELETE ON person_merge_execution_seals
BEGIN SELECT RAISE(ABORT,'person_merge_execution_seals_append_only'); END;
CREATE TRIGGER person_merge_journal_row_details_append_only_update BEFORE UPDATE ON person_merge_journal_row_details
BEGIN SELECT RAISE(ABORT,'person_merge_journal_row_details_append_only'); END;
CREATE TRIGGER person_merge_journal_row_details_append_only_delete BEFORE DELETE ON person_merge_journal_row_details
BEGIN SELECT RAISE(ABORT,'person_merge_journal_row_details_append_only'); END;
CREATE TRIGGER person_merge_rollback_approvals_append_only_update BEFORE UPDATE ON person_merge_rollback_approvals
BEGIN SELECT RAISE(ABORT,'person_merge_rollback_approvals_append_only'); END;
CREATE TRIGGER person_merge_rollback_approvals_append_only_delete BEFORE DELETE ON person_merge_rollback_approvals
BEGIN SELECT RAISE(ABORT,'person_merge_rollback_approvals_append_only'); END;
CREATE TRIGGER person_merge_rollback_operations_delete_guard BEFORE DELETE ON person_merge_rollback_operations
BEGIN SELECT RAISE(ABORT,'person_merge_rollback_operations_append_only'); END;
