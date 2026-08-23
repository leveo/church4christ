-- Atomic person-merge execution and bounded rollback evidence. Mirrors D1.

-- 0033 freezes this closed registry after seeding. Extend it only inside this
-- migration, then immediately restore the insert guard for runtime callers.
DROP TRIGGER person_merge_registry_keys_append_only_insert ON person_merge_registry_keys;
INSERT INTO person_merge_registry_keys(reference_key,policy) VALUES
  ('person_merge_rollback_approvals.approver_person_id','historical_preserve'),
  ('person_merge_rollback_operations.requested_by_person_id','historical_preserve');
CREATE TRIGGER person_merge_registry_keys_append_only_insert BEFORE INSERT ON person_merge_registry_keys
FOR EACH ROW EXECUTE FUNCTION person_merge_registry_keys_append_only_insert_fn();

ALTER TABLE person_merge_redirects ADD COLUMN merge_operation_id TEXT
  REFERENCES person_merge_operations(operation_id);
CREATE UNIQUE INDEX idx_person_merge_redirects_operation
  ON person_merge_redirects(merge_operation_id) WHERE merge_operation_id IS NOT NULL;

CREATE TABLE person_merge_reference_facts (
  operation_id TEXT NOT NULL REFERENCES person_merge_operations(operation_id),
  reference_key TEXT NOT NULL,
  policy TEXT NOT NULL CHECK(policy IN ('subject_repoint','dedupe_then_repoint','operational_actor_repoint','historical_preserve','security_revoke','hard_conflict')),
  side TEXT NOT NULL CHECK(side IN ('loser','canonical')),
  -- PostgreSQL text values inherently reject the zero code point.
  local_row_id TEXT NOT NULL CHECK(octet_length(local_row_id) BETWEEN 1 AND 192),
  row_key_hash TEXT NOT NULL CHECK(length(row_key_hash)=64 AND row_key_hash=lower(row_key_hash) AND row_key_hash !~ '[^0-9a-f]'),
  created_at TEXT NOT NULL DEFAULT(CURRENT_TIMESTAMP),
  PRIMARY KEY(operation_id,reference_key,side,local_row_id),
  UNIQUE(operation_id,reference_key,side,row_key_hash),
  FOREIGN KEY(reference_key,policy) REFERENCES person_merge_registry_keys(reference_key,policy)
);

CREATE TABLE person_merge_execution_seals (
  operation_id TEXT PRIMARY KEY REFERENCES person_merge_operations(operation_id),
  expected_operation_version INTEGER NOT NULL CHECK(expected_operation_version=1),
  expected_preview_hash TEXT NOT NULL CHECK(length(expected_preview_hash)=64 AND expected_preview_hash=lower(expected_preview_hash) AND expected_preview_hash !~ '[^0-9a-f]'),
  expected_risk_state_hash TEXT NOT NULL CHECK(length(expected_risk_state_hash)=64 AND expected_risk_state_hash=lower(expected_risk_state_hash) AND expected_risk_state_hash !~ '[^0-9a-f]'),
  expected_risk_state_version INTEGER NOT NULL CHECK(expected_risk_state_version=1),
  expected_resolution_case_version INTEGER NOT NULL CHECK(expected_resolution_case_version BETWEEN 1 AND 2147483647),
  expected_resolution_case_hash TEXT NOT NULL CHECK(length(expected_resolution_case_hash)=64 AND expected_resolution_case_hash=lower(expected_resolution_case_hash) AND expected_resolution_case_hash !~ '[^0-9a-f]'),
  inventory_hash TEXT NOT NULL CHECK(length(inventory_hash)=64 AND inventory_hash=lower(inventory_hash) AND inventory_hash !~ '[^0-9a-f]'),
  inventory_count INTEGER NOT NULL CHECK(inventory_count BETWEEN 0 AND 2147483647),
  expected_mutation_count INTEGER NOT NULL CHECK(expected_mutation_count BETWEEN 0 AND 2147483647),
  expected_irreversible_count INTEGER NOT NULL CHECK(expected_irreversible_count BETWEEN 0 AND expected_mutation_count),
  created_at TEXT NOT NULL DEFAULT(CURRENT_TIMESTAMP)
);

CREATE TABLE person_merge_journal_row_details (
  journal_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  before_local_row_id TEXT NOT NULL CHECK(octet_length(before_local_row_id) BETWEEN 1 AND 192),
  after_local_row_id TEXT NOT NULL CHECK(octet_length(after_local_row_id) BETWEEN 1 AND 192),
  before_row_hash TEXT NOT NULL CHECK(length(before_row_hash)=64 AND before_row_hash=lower(before_row_hash) AND before_row_hash !~ '[^0-9a-f]'),
  after_row_hash TEXT NOT NULL CHECK(length(after_row_hash)=64 AND after_row_hash=lower(after_row_hash) AND after_row_hash !~ '[^0-9a-f]'),
  rollback_mode TEXT NOT NULL CHECK(rollback_mode IN ('reversible','security_irreversible')),
  affected_count INTEGER NOT NULL CHECK(affected_count=1),
  created_at TEXT NOT NULL DEFAULT(CURRENT_TIMESTAMP),
  FOREIGN KEY(operation_id,journal_id) REFERENCES person_merge_reassignment_journal(operation_id,journal_id)
);

CREATE TABLE person_merge_rollback_operations (
  rollback_id TEXT PRIMARY KEY CHECK(rollback_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  operation_id TEXT NOT NULL UNIQUE REFERENCES person_merge_operations(operation_id),
  expected_operation_version INTEGER NOT NULL CHECK(expected_operation_version BETWEEN 1 AND 2147483647),
  journal_hash TEXT NOT NULL CHECK(length(journal_hash)=64 AND journal_hash=lower(journal_hash) AND journal_hash !~ '[^0-9a-f]'),
  journal_count INTEGER NOT NULL CHECK(journal_count BETWEEN 0 AND 2147483647),
  required_approvals INTEGER NOT NULL CHECK(required_approvals IN (1,2)),
  state TEXT NOT NULL DEFAULT 'previewed' CHECK(state IN ('previewed','awaiting_approval','approved','executing','completed','failed','expired','cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
  requested_by_person_id INTEGER NOT NULL REFERENCES people(id),
  expires_at TEXT NOT NULL CHECK(expires_at=to_char((expires_at::timestamptz AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  created_at TEXT NOT NULL DEFAULT(CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT(CURRENT_TIMESTAMP)
);

CREATE TABLE person_merge_rollback_approvals (
  approval_id TEXT PRIMARY KEY CHECK(approval_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  rollback_id TEXT NOT NULL REFERENCES person_merge_rollback_operations(rollback_id),
  approver_person_id INTEGER NOT NULL REFERENCES people(id),
  step_up_challenge_id INTEGER NOT NULL UNIQUE REFERENCES identity_challenges(id),
  approval_order INTEGER NOT NULL CHECK(approval_order IN (1,2)),
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
  expected_rollback_version INTEGER NOT NULL CHECK(expected_rollback_version BETWEEN 1 AND 2147483647),
  expected_journal_hash TEXT NOT NULL CHECK(length(expected_journal_hash)=64 AND expected_journal_hash=lower(expected_journal_hash) AND expected_journal_hash !~ '[^0-9a-f]'),
  created_at TEXT NOT NULL DEFAULT(CURRENT_TIMESTAMP),
  UNIQUE(rollback_id,approver_person_id),
  UNIQUE(rollback_id,approval_order)
);

ALTER TABLE person_merge_rollback_receipts ADD COLUMN rollback_id TEXT
  REFERENCES person_merge_rollback_operations(rollback_id);
CREATE UNIQUE INDEX idx_person_merge_rollback_receipts_rollback_journal
  ON person_merge_rollback_receipts(rollback_id,journal_id) WHERE rollback_id IS NOT NULL;

CREATE FUNCTION person_merge_reference_facts_binding_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.operation_id=NEW.operation_id AND op.state='previewed' AND op.version=1)
  THEN RAISE EXCEPTION 'person_merge_reference_fact_binding'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_reference_facts_binding_guard BEFORE INSERT ON person_merge_reference_facts
FOR EACH ROW EXECUTE FUNCTION person_merge_reference_facts_binding_guard_fn();
CREATE FUNCTION person_merge_reference_facts_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM person_merge_execution_seals seal WHERE seal.operation_id=NEW.operation_id)
  THEN RAISE EXCEPTION 'person_merge_reference_facts_sealed'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_reference_facts_insert_guard BEFORE INSERT ON person_merge_reference_facts
FOR EACH ROW EXECUTE FUNCTION person_merge_reference_facts_insert_guard_fn();
CREATE FUNCTION person_merge_execution_seals_binding_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM person_merge_operations op
    WHERE op.operation_id=NEW.operation_id AND op.state='previewed' AND op.version=NEW.expected_operation_version
      AND op.preview_hash=NEW.expected_preview_hash
      AND op.risk_state_hash=NEW.expected_risk_state_hash AND op.risk_state_version=NEW.expected_risk_state_version
      AND op.expected_resolution_case_version=NEW.expected_resolution_case_version
      AND op.resolution_case_hash=NEW.expected_resolution_case_hash)
    OR NEW.inventory_count<>(SELECT COUNT(*) FROM person_merge_reference_facts fact WHERE fact.operation_id=NEW.operation_id)
  THEN RAISE EXCEPTION 'person_merge_execution_seal_binding'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_execution_seals_binding_guard BEFORE INSERT ON person_merge_execution_seals
FOR EACH ROW EXECUTE FUNCTION person_merge_execution_seals_binding_guard_fn();
CREATE FUNCTION person_merge_journal_row_details_binding_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM person_merge_reassignment_journal journal JOIN person_merge_operations op ON op.operation_id=journal.operation_id
    WHERE journal.operation_id=NEW.operation_id AND journal.journal_id=NEW.journal_id
      AND journal.affected_count=NEW.affected_count AND op.state='executing')
  THEN RAISE EXCEPTION 'person_merge_journal_detail_binding'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_journal_row_details_binding_guard BEFORE INSERT ON person_merge_journal_row_details
FOR EACH ROW EXECUTE FUNCTION person_merge_journal_row_details_binding_guard_fn();

CREATE FUNCTION person_merge_core_receipt_precondition_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reference_key IN (
      'gift_results.person_id','identity_observations.linked_person_id','identity_source_records.linked_person_id',
      'newcomer_submissions.linked_person_id','person_notes.person_id','person_contact_links.person_id',
      'group_members.person_id','team_members.person_id','campus_memberships.person_id','tokens.person_id',
      'identity_challenges.person_id','group_attendance_tokens.person_id','people.calendar_token')
    AND (NOT EXISTS (SELECT 1 FROM person_merge_reference_facts fact
        WHERE fact.operation_id=NEW.operation_id AND fact.reference_key=NEW.reference_key
          AND fact.policy=NEW.policy AND fact.side='loser' AND fact.row_key_hash=NEW.row_key_hash)
      OR NOT (
        (NEW.reference_key='gift_results.person_id' AND EXISTS (SELECT 1 FROM gift_results x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.id::text
          WHERE x.person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='identity_observations.linked_person_id' AND EXISTS (SELECT 1 FROM identity_observations x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.id::text
          WHERE x.linked_person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='identity_source_records.linked_person_id' AND EXISTS (SELECT 1 FROM identity_source_records x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.id::text
          WHERE x.state='linked' AND x.linked_person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='newcomer_submissions.linked_person_id' AND EXISTS (SELECT 1 FROM newcomer_submissions x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.id::text
          WHERE x.linked_person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='person_notes.person_id' AND EXISTS (SELECT 1 FROM person_notes x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.id::text
          WHERE x.person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='person_contact_links.person_id' AND EXISTS (SELECT 1 FROM person_contact_links x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.id::text
          WHERE x.person_id=NEW.loser_person_id AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='group_members.person_id' AND EXISTS (SELECT 1 FROM group_members x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.id::text
          WHERE x.person_id=NEW.loser_person_id AND x.is_admin=0 AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='team_members.person_id' AND EXISTS (SELECT 1 FROM team_members x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.team_id::text
          WHERE x.person_id=NEW.loser_person_id AND x.is_leader=0 AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='campus_memberships.person_id' AND EXISTS (SELECT 1 FROM campus_memberships x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.campus_id::text
          WHERE x.person_id=NEW.loser_person_id AND x.role='member' AND x.finance=0 AND x.admin_areas=''
            AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='tokens.person_id' AND EXISTS (SELECT 1 FROM tokens x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.id::text
          WHERE x.person_id=NEW.loser_person_id AND x.used_at IS NULL AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='identity_challenges.person_id' AND EXISTS (SELECT 1 FROM identity_challenges x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.id::text
          WHERE x.person_id=NEW.loser_person_id AND x.consumed_at IS NULL AND x.superseded_at IS NULL
            AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='group_attendance_tokens.person_id' AND EXISTS (SELECT 1 FROM group_attendance_tokens x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.id::text
          WHERE x.person_id=NEW.loser_person_id AND x.used_at IS NULL AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))
        OR (NEW.reference_key='people.calendar_token' AND EXISTS (SELECT 1 FROM people x JOIN person_merge_reference_facts f
          ON f.operation_id=NEW.operation_id AND f.reference_key=NEW.reference_key AND f.local_row_id=x.id::text
          WHERE x.id=NEW.loser_person_id AND x.calendar_token IS NOT NULL AND x.calendar_token<>''
            AND f.row_key_hash=NEW.row_key_hash FOR UPDATE OF x))))
  THEN RAISE EXCEPTION 'person_merge_core_receipt_precondition'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_core_receipt_precondition_guard BEFORE INSERT ON person_merge_mutation_receipts
FOR EACH ROW EXECUTE FUNCTION person_merge_core_receipt_precondition_guard_fn();

CREATE OR REPLACE FUNCTION identity_source_records_link_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.linked_person_id IS NOT NULL AND (
      NEW.linked_person_id IS DISTINCT FROM OLD.linked_person_id OR NEW.state IS DISTINCT FROM OLD.state)
    AND NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN person_merge_mutation_receipts receipt
        ON receipt.operation_id=op.operation_id AND receipt.reference_key='identity_source_records.linked_person_id'
      JOIN person_merge_reference_facts fact ON fact.operation_id=op.operation_id
        AND fact.reference_key=receipt.reference_key AND fact.row_key_hash=receipt.row_key_hash
      WHERE op.state='executing' AND op.loser_person_id=OLD.linked_person_id
        AND op.canonical_person_id=NEW.linked_person_id AND NEW.state IS NOT DISTINCT FROM OLD.state
        AND fact.side='loser' AND fact.local_row_id=OLD.id::text)
    AND NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
      JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
      JOIN person_merge_rollback_receipts receipt ON receipt.rollback_id=rollback.rollback_id AND receipt.outcome='reverted'
      JOIN person_merge_reassignment_journal journal ON journal.operation_id=op.operation_id AND journal.journal_id=receipt.journal_id
      JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
      WHERE rollback.state='executing' AND journal.reference_key='identity_source_records.linked_person_id'
        AND op.canonical_person_id=OLD.linked_person_id AND op.loser_person_id=NEW.linked_person_id
        AND NEW.state IS NOT DISTINCT FROM OLD.state AND detail.after_local_row_id=OLD.id::text)
  THEN RAISE EXCEPTION 'identity_source_attachment_immutable'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION identity_source_observation_attachment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='linked' AND EXISTS (SELECT 1 FROM identity_source_records x WHERE x.observation_id=OLD.id)
    AND NOT EXISTS (SELECT 1 FROM identity_source_records s JOIN identity_source_attachment_receipts r ON r.source_record_id=s.id
      WHERE s.observation_id=OLD.id AND s.state='linked' AND s.linked_person_id=NEW.linked_person_id
        AND r.person_id=NEW.linked_person_id AND r.source_version=s.version AND r.source_digest=s.source_digest)
    AND NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN person_merge_mutation_receipts receipt
        ON receipt.operation_id=op.operation_id AND receipt.reference_key='identity_observations.linked_person_id'
      JOIN person_merge_reference_facts fact ON fact.operation_id=op.operation_id
        AND fact.reference_key=receipt.reference_key AND fact.row_key_hash=receipt.row_key_hash
      WHERE op.state='executing' AND op.loser_person_id=OLD.linked_person_id
        AND op.canonical_person_id=NEW.linked_person_id AND NEW.status=OLD.status
        AND fact.side='loser' AND fact.local_row_id=OLD.id::text)
    AND NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
      JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
      JOIN person_merge_rollback_receipts receipt ON receipt.rollback_id=rollback.rollback_id AND receipt.outcome='reverted'
      JOIN person_merge_reassignment_journal journal ON journal.operation_id=op.operation_id AND journal.journal_id=receipt.journal_id
      JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
      WHERE rollback.state='executing' AND journal.reference_key='identity_observations.linked_person_id'
        AND op.canonical_person_id=OLD.linked_person_id AND op.loser_person_id=NEW.linked_person_id
        AND NEW.status=OLD.status AND detail.after_local_row_id=OLD.id::text)
  THEN RAISE EXCEPTION 'identity_source_attachment_commit_invalid'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION identity_source_observation_link_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM identity_source_records s JOIN identity_source_attachment_receipts r ON r.source_record_id=s.id
      WHERE s.observation_id=OLD.id AND s.state='linked' AND s.linked_person_id=r.person_id)
    AND NOT EXISTS (SELECT 1 FROM identity_source_records s WHERE s.observation_id=OLD.id AND s.state='linked'
      AND NEW.status='linked' AND NEW.linked_person_id IS NOT DISTINCT FROM s.linked_person_id)
    AND NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN person_merge_mutation_receipts receipt
        ON receipt.operation_id=op.operation_id AND receipt.reference_key='identity_observations.linked_person_id'
      JOIN person_merge_reference_facts fact ON fact.operation_id=op.operation_id
        AND fact.reference_key=receipt.reference_key AND fact.row_key_hash=receipt.row_key_hash
      WHERE op.state='executing' AND op.loser_person_id=OLD.linked_person_id
        AND op.canonical_person_id=NEW.linked_person_id AND NEW.status=OLD.status
        AND fact.side='loser' AND fact.local_row_id=OLD.id::text)
    AND NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
      JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
      JOIN person_merge_rollback_receipts receipt ON receipt.rollback_id=rollback.rollback_id AND receipt.outcome='reverted'
      JOIN person_merge_reassignment_journal journal ON journal.operation_id=op.operation_id AND journal.journal_id=receipt.journal_id
      JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
      WHERE rollback.state='executing' AND journal.reference_key='identity_observations.linked_person_id'
        AND op.canonical_person_id=OLD.linked_person_id AND op.loser_person_id=NEW.linked_person_id
        AND NEW.status=OLD.status AND detail.after_local_row_id=OLD.id::text)
  THEN RAISE EXCEPTION 'identity_source_observation_immutable'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION identity_newcomer_submission_binding_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ((OLD.identity_source_record_id IS NULL AND NEW.identity_source_record_id IS NOT NULL)
      OR (OLD.identity_source_record_id IS NOT NULL AND (
        NEW.identity_source_record_id IS DISTINCT FROM OLD.identity_source_record_id
        OR NEW.linked_person_id IS DISTINCT FROM OLD.linked_person_id OR NEW.campus_id IS DISTINCT FROM OLD.campus_id)))
    AND NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN person_merge_mutation_receipts receipt
        ON receipt.operation_id=op.operation_id AND receipt.reference_key='newcomer_submissions.linked_person_id'
      JOIN person_merge_reference_facts fact ON fact.operation_id=op.operation_id
        AND fact.reference_key=receipt.reference_key AND fact.row_key_hash=receipt.row_key_hash
      WHERE op.state='executing' AND op.loser_person_id=OLD.linked_person_id
        AND op.canonical_person_id=NEW.linked_person_id
        AND NEW.identity_source_record_id IS NOT DISTINCT FROM OLD.identity_source_record_id
        AND NEW.campus_id IS NOT DISTINCT FROM OLD.campus_id AND fact.side='loser' AND fact.local_row_id=OLD.id::text)
    AND NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
      JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
      JOIN person_merge_rollback_receipts receipt ON receipt.rollback_id=rollback.rollback_id AND receipt.outcome='reverted'
      JOIN person_merge_reassignment_journal journal ON journal.operation_id=op.operation_id AND journal.journal_id=receipt.journal_id
      JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
      WHERE rollback.state='executing' AND journal.reference_key='newcomer_submissions.linked_person_id'
        AND op.canonical_person_id=OLD.linked_person_id AND op.loser_person_id=NEW.linked_person_id
        AND NEW.identity_source_record_id IS NOT DISTINCT FROM OLD.identity_source_record_id
        AND NEW.campus_id IS NOT DISTINCT FROM OLD.campus_id AND detail.after_local_row_id=OLD.id::text)
  THEN RAISE EXCEPTION 'identity_newcomer_submission_binding_immutable'; END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION person_merge_operations_completion_seal_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='completed' AND (
    NOT EXISTS (SELECT 1 FROM person_merge_execution_seals seal WHERE seal.operation_id=OLD.operation_id
      AND seal.inventory_count=(SELECT COUNT(*) FROM person_merge_reference_facts fact WHERE fact.operation_id=OLD.operation_id)
      AND seal.expected_mutation_count=(SELECT COUNT(*) FROM person_merge_reference_facts fact
        WHERE fact.operation_id=OLD.operation_id AND fact.side='loser')
      AND seal.expected_irreversible_count=(SELECT COUNT(*) FROM person_merge_reference_facts fact
        WHERE fact.operation_id=OLD.operation_id AND fact.side='loser' AND fact.policy='security_revoke')
      AND seal.expected_mutation_count=(SELECT COUNT(*) FROM person_merge_mutation_receipts receipt WHERE receipt.operation_id=OLD.operation_id)
      AND seal.expected_mutation_count=(SELECT COUNT(*) FROM person_merge_reassignment_journal journal WHERE journal.operation_id=OLD.operation_id)
      AND seal.expected_mutation_count=(SELECT COUNT(*) FROM person_merge_journal_row_details detail WHERE detail.operation_id=OLD.operation_id))
    OR EXISTS (SELECT 1 FROM person_merge_reference_facts fact WHERE fact.operation_id=OLD.operation_id AND fact.side='loser'
      AND fact.reference_key NOT IN ('gift_results.person_id','identity_observations.linked_person_id',
        'identity_source_records.linked_person_id','newcomer_submissions.linked_person_id','person_notes.person_id',
        'person_contact_links.person_id','group_members.person_id','team_members.person_id','campus_memberships.person_id',
        'tokens.person_id','identity_challenges.person_id','group_attendance_tokens.person_id','people.calendar_token'))
    OR EXISTS (SELECT 1 FROM person_merge_reference_facts fact
      WHERE fact.operation_id=OLD.operation_id AND fact.side='loser' AND NOT (
        (fact.reference_key='gift_results.person_id' AND EXISTS (SELECT 1 FROM gift_results x
          WHERE x.id::text=fact.local_row_id AND x.person_id=OLD.canonical_person_id))
        OR (fact.reference_key='identity_observations.linked_person_id' AND EXISTS (SELECT 1 FROM identity_observations x
          WHERE x.id::text=fact.local_row_id AND x.linked_person_id=OLD.canonical_person_id))
        OR (fact.reference_key='identity_source_records.linked_person_id' AND EXISTS (SELECT 1 FROM identity_source_records x
          WHERE x.id::text=fact.local_row_id AND x.linked_person_id=OLD.canonical_person_id AND x.state='linked'))
        OR (fact.reference_key='newcomer_submissions.linked_person_id' AND EXISTS (SELECT 1 FROM newcomer_submissions x
          WHERE x.id=fact.local_row_id AND x.linked_person_id=OLD.canonical_person_id))
        OR (fact.reference_key='person_notes.person_id' AND EXISTS (SELECT 1 FROM person_notes x
          WHERE x.id::text=fact.local_row_id AND x.person_id=OLD.canonical_person_id))
        OR (fact.reference_key='person_contact_links.person_id' AND EXISTS (SELECT 1 FROM person_contact_links x
          WHERE x.id::text=fact.local_row_id AND x.person_id=OLD.canonical_person_id))
        OR (fact.reference_key='group_members.person_id' AND EXISTS (SELECT 1 FROM group_members x
          WHERE x.id::text=fact.local_row_id AND x.person_id=OLD.canonical_person_id AND x.is_admin=0))
        OR (fact.reference_key='team_members.person_id' AND EXISTS (SELECT 1 FROM team_members x
          WHERE x.team_id::text=fact.local_row_id AND x.person_id=OLD.canonical_person_id AND x.is_leader=0))
        OR (fact.reference_key='campus_memberships.person_id' AND EXISTS (SELECT 1 FROM campus_memberships x
          WHERE x.campus_id::text=fact.local_row_id AND x.person_id=OLD.canonical_person_id
            AND x.role='member' AND x.finance=0 AND x.admin_areas=''))
        OR (fact.reference_key='tokens.person_id' AND EXISTS (SELECT 1 FROM tokens x
          WHERE x.id::text=fact.local_row_id AND x.person_id=OLD.loser_person_id AND x.used_at IS NOT NULL))
        OR (fact.reference_key='identity_challenges.person_id' AND EXISTS (SELECT 1 FROM identity_challenges x
          WHERE x.id::text=fact.local_row_id AND x.person_id=OLD.loser_person_id AND x.superseded_at IS NOT NULL))
        OR (fact.reference_key='group_attendance_tokens.person_id' AND EXISTS (SELECT 1 FROM group_attendance_tokens x
          WHERE x.id::text=fact.local_row_id AND x.person_id=OLD.loser_person_id AND x.used_at IS NOT NULL))
        OR (fact.reference_key='people.calendar_token' AND EXISTS (SELECT 1 FROM people x
          WHERE x.id::text=fact.local_row_id AND x.id=OLD.loser_person_id AND x.calendar_token IS NULL))))
    OR EXISTS (SELECT 1 FROM person_merge_reference_facts fact WHERE fact.operation_id=OLD.operation_id AND fact.side='loser'
      AND NOT EXISTS (SELECT 1 FROM person_merge_mutation_receipts receipt JOIN person_merge_reassignment_journal journal
          ON journal.operation_id=receipt.operation_id AND journal.mutation_receipt_id=receipt.mutation_receipt_id
        JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
        WHERE receipt.operation_id=fact.operation_id AND receipt.reference_key=fact.reference_key
          AND receipt.row_key_hash=fact.row_key_hash AND receipt.policy=fact.policy))
    OR EXISTS (SELECT 1 FROM gift_results WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM identity_observations WHERE linked_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM identity_source_records WHERE linked_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM newcomer_submissions WHERE linked_person_id=OLD.loser_person_id OR assignee_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM person_notes WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM person_contact_links WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM group_members WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM team_members WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM campus_memberships WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM tokens WHERE person_id=OLD.loser_person_id AND used_at IS NULL)
    OR EXISTS (SELECT 1 FROM identity_challenges WHERE person_id=OLD.loser_person_id AND consumed_at IS NULL AND superseded_at IS NULL)
    OR EXISTS (SELECT 1 FROM group_attendance_tokens WHERE person_id=OLD.loser_person_id AND used_at IS NULL)
    OR EXISTS (SELECT 1 FROM activity_score_config WHERE updated_by_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM blockout_dates WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM group_join_requests WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM learning_activity_events WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM learning_canvas_oauth_states WHERE actor_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM learning_google_oauth_states WHERE actor_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM learning_programs WHERE created_by_person_id=OLD.loser_person_id OR updated_by_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM learning_provider_connections WHERE created_by_person_id=OLD.loser_person_id OR updated_by_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM ministries WHERE leader_person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM person_interests WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM roster_assignments WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM team_applications WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM testimonies WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM event_admins WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM gifts WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM registrations WHERE person_id=OLD.loser_person_id)
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
    OR EXISTS (SELECT 1 FROM recurring_gifts WHERE person_id=OLD.loser_person_id)
    OR EXISTS (SELECT 1 FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
      WHERE (h.expected_person_id=OLD.loser_person_id OR h.expected_reachable_owner_person_id=OLD.loser_person_id)
        AND c.state='open' AND h.expires_at::timestamptz>CURRENT_TIMESTAMP)
    OR NOT EXISTS (SELECT 1 FROM people loser,people canonical WHERE loser.id=OLD.loser_person_id
      AND loser.active=0 AND loser.identity_state='merged' AND loser.merged_into_person_id=OLD.canonical_person_id
      AND loser.auth_disabled_at IS NOT NULL AND loser.identity_version=OLD.expected_loser_identity_version+1
      AND loser.session_epoch=OLD.expected_loser_session_epoch+1 AND loser.calendar_token IS NULL
      AND canonical.id=OLD.canonical_person_id AND canonical.active=1 AND canonical.deleted_at IS NULL
      AND canonical.identity_state='active' AND canonical.auth_disabled_at IS NULL
      AND canonical.identity_version=OLD.expected_canonical_identity_version+1
      AND canonical.session_epoch=OLD.expected_canonical_session_epoch+1)
    OR NOT EXISTS (SELECT 1 FROM person_merge_redirects redirect WHERE redirect.loser_person_id=OLD.loser_person_id
      AND redirect.canonical_person_id=OLD.canonical_person_id AND redirect.merge_operation_id=OLD.operation_id)
    OR NOT EXISTS (SELECT 1 FROM identity_resolution_cases c WHERE c.id=OLD.resolution_case_id
      AND c.state='merged' AND c.version=OLD.expected_resolution_case_version+1))
  THEN RAISE EXCEPTION 'person_merge_completion_seal_invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_operations_completion_seal_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_completion_seal_guard_fn();

CREATE FUNCTION person_merge_rollback_operations_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.operation_id));
  IF NEW.state<>'previewed' OR NEW.version<>1 OR NEW.expires_at::timestamptz<=CURRENT_TIMESTAMP
    OR NEW.expires_at::timestamptz>CURRENT_TIMESTAMP+INTERVAL '24 hours'
    OR NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN people requester ON requester.id=NEW.requested_by_person_id
      WHERE op.operation_id=NEW.operation_id AND op.state='completed' AND op.version=NEW.expected_operation_version
        AND requester.role='admin' AND requester.active=1 AND requester.deleted_at IS NULL
        AND requester.identity_state='active' AND requester.auth_disabled_at IS NULL
        AND (op.scope_kind<>'global' OR requester.super_admin=1)
        AND (op.risk='normal' OR requester.super_admin=1)
        AND NEW.expires_at::timestamptz<=op.updated_at::timestamptz+INTERVAL '24 hours'
        AND NEW.required_approvals=op.required_approvals
        AND NEW.journal_count=(SELECT COUNT(*) FROM person_merge_reassignment_journal journal WHERE journal.operation_id=op.operation_id))
  THEN RAISE EXCEPTION 'person_merge_rollback_binding'; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_rollback_operations_insert_guard BEFORE INSERT ON person_merge_rollback_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_operations_insert_guard_fn();
CREATE FUNCTION person_merge_rollback_operations_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(OLD.operation_id));
  IF NEW.rollback_id IS DISTINCT FROM OLD.rollback_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.expected_operation_version IS DISTINCT FROM OLD.expected_operation_version OR NEW.journal_hash IS DISTINCT FROM OLD.journal_hash
    OR NEW.journal_count IS DISTINCT FROM OLD.journal_count OR NEW.required_approvals IS DISTINCT FROM OLD.required_approvals
    OR NEW.requested_by_person_id IS DISTINCT FROM OLD.requested_by_person_id OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'person_merge_rollback_immutable'; END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'person_merge_rollback_state_cas'; END IF;
  IF NOT ((OLD.state='previewed' AND NEW.state IN ('awaiting_approval','cancelled','expired'))
    OR (OLD.state='awaiting_approval' AND NEW.state IN ('approved','cancelled','expired'))
    OR (OLD.state='approved' AND NEW.state IN ('executing','cancelled','expired'))
    OR (OLD.state='executing' AND NEW.state IN ('completed','failed')))
    THEN RAISE EXCEPTION 'person_merge_rollback_transition'; END IF;
  IF NEW.state IN ('awaiting_approval','approved','executing','completed') AND OLD.expires_at::timestamptz<=CURRENT_TIMESTAMP
    THEN RAISE EXCEPTION 'person_merge_rollback_expired'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_rollback_operations_update_guard BEFORE UPDATE ON person_merge_rollback_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_operations_update_guard_fn();

DROP TRIGGER person_merge_redirects_append_only_delete ON person_merge_redirects;
CREATE FUNCTION person_merge_redirects_rollback_delete_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
    JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
    WHERE rollback.state='executing' AND rollback.operation_id=OLD.merge_operation_id
      AND op.state='completed' AND op.loser_person_id=OLD.loser_person_id
      AND op.canonical_person_id=OLD.canonical_person_id)
  THEN RAISE EXCEPTION 'person_merge_redirects_append_only'; END IF;
  RETURN OLD;
END; $$;
CREATE TRIGGER person_merge_redirects_append_only_delete BEFORE DELETE ON person_merge_redirects
FOR EACH ROW EXECUTE FUNCTION person_merge_redirects_rollback_delete_guard_fn();

CREATE OR REPLACE FUNCTION person_merge_rollback_receipts_state_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
    JOIN person_merge_reassignment_journal journal ON journal.operation_id=rollback.operation_id
    WHERE rollback.rollback_id=NEW.rollback_id AND rollback.state='executing'
      AND journal.journal_id=NEW.journal_id AND journal.operation_id=NEW.operation_id)
  THEN RAISE EXCEPTION 'person_merge_rollback_state'; END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION person_merge_rollback_approval_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.rollback_id));
  IF NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
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
      AND stepup.created_at::timestamp<=stepup.consumed_at::timestamp
      AND stepup.consumed_at::timestamp<=stepup.expires_at::timestamp
      AND stepup.consumed_at::timestamp>clock_timestamp()-interval '10 minutes'
      AND stepup.consumed_at::timestamp<=clock_timestamp()
      AND stepup.context_json::jsonb #>> '{person_merge_rollback_approval,rollback_id}'=rollback.rollback_id
      AND (stepup.context_json::jsonb #>> '{person_merge_rollback_approval,rollback_version}')::integer=NEW.expected_rollback_version
      AND stepup.context_json::jsonb #>> '{person_merge_rollback_approval,operation_id}'=rollback.operation_id
      AND (stepup.context_json::jsonb #>> '{person_merge_rollback_approval,expected_operation_version}')::integer=rollback.expected_operation_version
      AND stepup.context_json::jsonb #>> '{person_merge_rollback_approval,journal_hash}'=rollback.journal_hash
      AND (stepup.context_json::jsonb #>> '{person_merge_rollback_approval,journal_count}')::integer=rollback.journal_count
      AND (stepup.context_json::jsonb #>> '{person_merge_rollback_approval,approver_person_id}')::integer=approver.id
      AND (stepup.context_json::jsonb #>> '{person_merge_rollback_approval,approver_identity_version}')::integer=approver.identity_version
      AND (stepup.context_json::jsonb #>> '{person_merge_rollback_approval,campus_id}')::integer=stepup.campus_id
      AND (op.scope_kind='global' OR stepup.campus_id=op.campus_id)
      AND EXISTS (SELECT 1 FROM campus_memberships cm JOIN campuses campus ON campus.id=cm.campus_id
        WHERE cm.person_id=approver.id AND cm.campus_id=stepup.campus_id AND cm.active=1 AND cm.role='admin' AND campus.active=1))
  THEN RAISE EXCEPTION 'person_merge_rollback_approval_invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_rollback_approvals_binding_guard BEFORE INSERT ON person_merge_rollback_approvals
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_approval_guard_fn();

CREATE FUNCTION person_merge_rollback_state_approval_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eligible_count integer;
BEGIN
  IF NEW.state IN ('approved','executing') THEN
    SELECT COUNT(*) INTO eligible_count FROM person_merge_rollback_approvals approval
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
      AND stepup.consumed_at::timestamp>clock_timestamp()-interval '10 minutes'
      AND stepup.consumed_at::timestamp<=clock_timestamp()
      AND stepup.context_json::jsonb #>> '{person_merge_rollback_approval,rollback_id}'=OLD.rollback_id
      AND (stepup.context_json::jsonb #>> '{person_merge_rollback_approval,rollback_version}')::integer=approval.expected_rollback_version
      AND stepup.context_json::jsonb #>> '{person_merge_rollback_approval,operation_id}'=OLD.operation_id
      AND (stepup.context_json::jsonb #>> '{person_merge_rollback_approval,expected_operation_version}')::integer=OLD.expected_operation_version
      AND stepup.context_json::jsonb #>> '{person_merge_rollback_approval,journal_hash}'=OLD.journal_hash
      AND (stepup.context_json::jsonb #>> '{person_merge_rollback_approval,journal_count}')::integer=OLD.journal_count
      AND (stepup.context_json::jsonb #>> '{person_merge_rollback_approval,approver_person_id}')::integer=approver.id
      AND (stepup.context_json::jsonb #>> '{person_merge_rollback_approval,approver_identity_version}')::integer=approver.identity_version
      AND (op.scope_kind='global' OR EXISTS (SELECT 1 FROM campus_memberships cm JOIN campuses campus ON campus.id=cm.campus_id
        WHERE cm.person_id=approver.id AND cm.campus_id=op.campus_id AND cm.active=1 AND cm.role='admin' AND campus.active=1));
    IF eligible_count<OLD.required_approvals THEN RAISE EXCEPTION 'person_merge_rollback_approval_stale'; END IF;
    IF EXISTS (SELECT 1 FROM person_merge_rollback_approvals approval
      WHERE approval.rollback_id=OLD.rollback_id AND approval.decision='reject')
      THEN RAISE EXCEPTION 'person_merge_rollback_approval_veto'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_rollback_state_approval_guard BEFORE UPDATE ON person_merge_rollback_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_state_approval_guard_fn();

CREATE FUNCTION person_merge_rollback_step_up_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purpose='step_up' AND NEW.consumed_at IS NOT NULL
    AND jsonb_typeof(NEW.context_json::jsonb->'person_merge_rollback_approval')='object'
    THEN RAISE EXCEPTION 'person_merge_rollback_step_up_must_be_consumed'; END IF;
  RETURN NEW;
END; $$;
CREATE FUNCTION person_merge_rollback_step_up_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.purpose='step_up' AND OLD.consumed_at IS NOT NULL
    AND jsonb_typeof(OLD.context_json::jsonb->'person_merge_rollback_approval')='object'
    AND (NEW.purpose<>OLD.purpose OR NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.campus_id<>OLD.campus_id
      OR NEW.context_json<>OLD.context_json OR NEW.created_at<>OLD.created_at
      OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
      OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at))
    THEN RAISE EXCEPTION 'person_merge_rollback_step_up_binding_immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_rollback_step_up_direct_consumed_guard BEFORE INSERT ON identity_challenges
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_step_up_insert_guard_fn();
CREATE TRIGGER person_merge_rollback_step_up_binding_immutable BEFORE UPDATE ON identity_challenges
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_step_up_update_guard_fn();

CREATE FUNCTION person_merge_rollback_receipt_precondition_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome='reverted' AND NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
    JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
    JOIN person_merge_reassignment_journal journal ON journal.operation_id=op.operation_id AND journal.journal_id=NEW.journal_id
    JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
    WHERE rollback.rollback_id=NEW.rollback_id AND rollback.state='executing' AND journal.policy<>'security_revoke'
      AND ((journal.reference_key='gift_results.person_id' AND EXISTS (SELECT 1 FROM gift_results x WHERE x.id::text=detail.after_local_row_id AND x.person_id=op.canonical_person_id))
        OR (journal.reference_key='identity_observations.linked_person_id' AND EXISTS (SELECT 1 FROM identity_observations x WHERE x.id::text=detail.after_local_row_id AND x.linked_person_id=op.canonical_person_id))
        OR (journal.reference_key='identity_source_records.linked_person_id' AND EXISTS (SELECT 1 FROM identity_source_records x WHERE x.id::text=detail.after_local_row_id AND x.linked_person_id=op.canonical_person_id AND x.state='linked'))
        OR (journal.reference_key='newcomer_submissions.linked_person_id' AND EXISTS (SELECT 1 FROM newcomer_submissions x WHERE x.id=detail.after_local_row_id AND x.linked_person_id=op.canonical_person_id))
        OR (journal.reference_key='person_notes.person_id' AND EXISTS (SELECT 1 FROM person_notes x WHERE x.id::text=detail.after_local_row_id AND x.person_id=op.canonical_person_id))
        OR (journal.reference_key='person_contact_links.person_id' AND EXISTS (SELECT 1 FROM person_contact_links x WHERE x.id::text=detail.after_local_row_id AND x.person_id=op.canonical_person_id))
        OR (journal.reference_key='group_members.person_id' AND EXISTS (SELECT 1 FROM group_members x WHERE x.id::text=detail.after_local_row_id AND x.person_id=op.canonical_person_id AND x.is_admin=0))
        OR (journal.reference_key='team_members.person_id' AND EXISTS (SELECT 1 FROM team_members x WHERE x.team_id::text=detail.after_local_row_id AND x.person_id=op.canonical_person_id AND x.is_leader=0))
        OR (journal.reference_key='campus_memberships.person_id' AND EXISTS (SELECT 1 FROM campus_memberships x WHERE x.campus_id::text=detail.after_local_row_id AND x.person_id=op.canonical_person_id AND x.role='member' AND x.finance=0 AND x.admin_areas=''))))
  THEN RAISE EXCEPTION 'person_merge_rollback_row_drift'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_rollback_receipt_precondition_guard BEFORE INSERT ON person_merge_rollback_receipts
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_receipt_precondition_guard_fn();

CREATE FUNCTION person_merge_rollback_completion_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='completed' AND (NOT EXISTS (SELECT 1 FROM person_merge_operations op
      WHERE op.operation_id=OLD.operation_id AND op.state='completed' AND op.version=OLD.expected_operation_version
        AND NOT EXISTS (SELECT 1 FROM person_merge_redirects redirect WHERE redirect.merge_operation_id=op.operation_id)
        AND EXISTS (SELECT 1 FROM people loser,people canonical WHERE loser.id=op.loser_person_id
          AND loser.active=1 AND loser.deleted_at IS NULL AND loser.identity_state='active'
          AND loser.auth_disabled_at IS NULL AND loser.merged_into_person_id IS NULL AND loser.calendar_token IS NULL
          AND loser.identity_version=op.expected_loser_identity_version+2 AND loser.session_epoch=op.expected_loser_session_epoch+2
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
          (journal.reference_key='gift_results.person_id' AND EXISTS (SELECT 1 FROM gift_results x WHERE x.id::text=detail.before_local_row_id AND x.person_id=op.loser_person_id))
          OR (journal.reference_key='identity_observations.linked_person_id' AND EXISTS (SELECT 1 FROM identity_observations x WHERE x.id::text=detail.before_local_row_id AND x.linked_person_id=op.loser_person_id))
          OR (journal.reference_key='identity_source_records.linked_person_id' AND EXISTS (SELECT 1 FROM identity_source_records x WHERE x.id::text=detail.before_local_row_id AND x.linked_person_id=op.loser_person_id))
          OR (journal.reference_key='newcomer_submissions.linked_person_id' AND EXISTS (SELECT 1 FROM newcomer_submissions x WHERE x.id=detail.before_local_row_id AND x.linked_person_id=op.loser_person_id))
          OR (journal.reference_key='person_notes.person_id' AND EXISTS (SELECT 1 FROM person_notes x WHERE x.id::text=detail.before_local_row_id AND x.person_id=op.loser_person_id))
          OR (journal.reference_key='person_contact_links.person_id' AND EXISTS (SELECT 1 FROM person_contact_links x WHERE x.id::text=detail.before_local_row_id AND x.person_id=op.loser_person_id))
          OR (journal.reference_key='group_members.person_id' AND EXISTS (SELECT 1 FROM group_members x WHERE x.id::text=detail.before_local_row_id AND x.person_id=op.loser_person_id))
          OR (journal.reference_key='team_members.person_id' AND EXISTS (SELECT 1 FROM team_members x WHERE x.team_id::text=detail.before_local_row_id AND x.person_id=op.loser_person_id))
          OR (journal.reference_key='campus_memberships.person_id' AND EXISTS (SELECT 1 FROM campus_memberships x WHERE x.campus_id::text=detail.before_local_row_id AND x.person_id=op.loser_person_id)))))
    THEN RAISE EXCEPTION 'person_merge_rollback_completion_invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_rollback_completion_guard BEFORE UPDATE ON person_merge_rollback_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_completion_guard_fn();

CREATE FUNCTION person_merge_execution_append_only_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_execution_evidence_append_only'; END; $$;
CREATE TRIGGER person_merge_reference_facts_append_only_update BEFORE UPDATE ON person_merge_reference_facts FOR EACH ROW EXECUTE FUNCTION person_merge_execution_append_only_guard_fn();
CREATE TRIGGER person_merge_reference_facts_append_only_delete BEFORE DELETE ON person_merge_reference_facts FOR EACH ROW EXECUTE FUNCTION person_merge_execution_append_only_guard_fn();
CREATE TRIGGER person_merge_execution_seals_append_only_update BEFORE UPDATE ON person_merge_execution_seals FOR EACH ROW EXECUTE FUNCTION person_merge_execution_append_only_guard_fn();
CREATE TRIGGER person_merge_execution_seals_append_only_delete BEFORE DELETE ON person_merge_execution_seals FOR EACH ROW EXECUTE FUNCTION person_merge_execution_append_only_guard_fn();
CREATE TRIGGER person_merge_journal_row_details_append_only_update BEFORE UPDATE ON person_merge_journal_row_details FOR EACH ROW EXECUTE FUNCTION person_merge_execution_append_only_guard_fn();
CREATE TRIGGER person_merge_journal_row_details_append_only_delete BEFORE DELETE ON person_merge_journal_row_details FOR EACH ROW EXECUTE FUNCTION person_merge_execution_append_only_guard_fn();
CREATE TRIGGER person_merge_rollback_approvals_append_only_update BEFORE UPDATE ON person_merge_rollback_approvals FOR EACH ROW EXECUTE FUNCTION person_merge_execution_append_only_guard_fn();
CREATE TRIGGER person_merge_rollback_approvals_append_only_delete BEFORE DELETE ON person_merge_rollback_approvals FOR EACH ROW EXECUTE FUNCTION person_merge_execution_append_only_guard_fn();
CREATE TRIGGER person_merge_rollback_operations_delete_guard BEFORE DELETE ON person_merge_rollback_operations FOR EACH ROW EXECUTE FUNCTION person_merge_execution_append_only_guard_fn();
