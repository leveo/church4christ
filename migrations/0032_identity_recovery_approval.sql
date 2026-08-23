-- Two-person, cooling-period account recovery.  Public requests prove only the
-- new reachable mailbox; all authority-changing decisions are append-only and
-- version-bound to the exact person and contact-owner state reviewed.

ALTER TABLE identity_account_operations ADD COLUMN recovery_claim_hash TEXT
  CHECK (recovery_claim_hash IS NULL OR (length(recovery_claim_hash)=64 AND recovery_claim_hash=lower(recovery_claim_hash) AND recovery_claim_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE identity_account_operations ADD COLUMN recovery_source_version INTEGER NOT NULL DEFAULT 1
  CHECK (recovery_source_version BETWEEN 1 AND 2147483647);

ALTER TABLE identity_recovery_cases ADD COLUMN version INTEGER NOT NULL DEFAULT 1
  CHECK (version BETWEEN 1 AND 2147483647);
ALTER TABLE identity_recovery_cases ADD COLUMN source_operation_id TEXT REFERENCES identity_account_operations(operation_id);
ALTER TABLE identity_recovery_cases ADD COLUMN claimed_target_hash TEXT
  CHECK (claimed_target_hash IS NULL OR (length(claimed_target_hash)=64 AND claimed_target_hash=lower(claimed_target_hash) AND claimed_target_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE identity_recovery_cases ADD COLUMN source_version INTEGER NOT NULL DEFAULT 1
  CHECK (source_version BETWEEN 1 AND 2147483647);
CREATE UNIQUE INDEX idx_identity_recovery_cases_source_operation ON identity_recovery_cases(source_operation_id);
CREATE TRIGGER identity_recovery_case_source_guard BEFORE INSERT ON identity_recovery_cases
WHEN NEW.source_operation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM identity_account_operations op JOIN identity_challenges ch ON ch.id=op.challenge_id
  JOIN identity_account_proof_uses proof ON proof.operation_id=op.operation_id AND proof.challenge_id=ch.id
  WHERE op.operation_id=NEW.source_operation_id AND op.campus_id=NEW.campus_id AND op.kind='recovery' AND op.state='pending'
    AND op.target_person_id IS NEW.person_id AND op.recovery_claim_hash=NEW.claimed_target_hash
    AND op.recovery_source_version=NEW.source_version AND ch.purpose='recovery' AND ch.contact_point_id=NEW.contact_point_id
    AND ch.consumed_at IS NOT NULL AND ch.superseded_at IS NULL AND proof.proof_category='recovery_case'
    AND proof.contact_point_id=NEW.contact_point_id AND proof.person_id IS NEW.person_id
)
BEGIN SELECT RAISE(ABORT,'identity_recovery_source_guard'); END;

CREATE TABLE identity_recovery_decisions (
  decision_id TEXT PRIMARY KEY CHECK (
    length(CAST(decision_id AS BLOB))=36 AND decision_id=lower(decision_id)
    AND substr(decision_id,9,1)='-' AND substr(decision_id,14,1)='-'
    AND substr(decision_id,19,1)='-' AND substr(decision_id,24,1)='-'
    AND length(replace(decision_id,'-',''))=32 AND decision_id NOT GLOB '*[^0-9a-f-]*'
  ),
  case_id INTEGER NOT NULL REFERENCES identity_recovery_cases(id),
  decision TEXT NOT NULL CHECK (decision IN ('first_approval','second_approval','rejected','veto','executed')),
  actor_person_id INTEGER REFERENCES people(id),
  expected_case_version INTEGER NOT NULL CHECK (expected_case_version BETWEEN 1 AND 2147483647),
  expected_person_id INTEGER REFERENCES people(id),
  expected_person_identity_version INTEGER CHECK (expected_person_identity_version IS NULL OR expected_person_identity_version BETWEEN 0 AND 2147483647),
  expected_person_session_epoch INTEGER CHECK (expected_person_session_epoch IS NULL OR expected_person_session_epoch BETWEEN 0 AND 2147483646),
  expected_reachable_owner_person_id INTEGER REFERENCES people(id),
  expected_reachable_owner_generation INTEGER NOT NULL CHECK (expected_reachable_owner_generation BETWEEN 0 AND 2147483647),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((decision='veto')=(actor_person_id IS NULL))
);
CREATE UNIQUE INDEX idx_identity_recovery_decisions_stage ON identity_recovery_decisions(case_id,decision);
CREATE UNIQUE INDEX idx_identity_recovery_distinct_approvers ON identity_recovery_decisions(case_id,actor_person_id)
  WHERE decision IN ('first_approval','second_approval');
CREATE INDEX idx_identity_recovery_decisions_case_created ON identity_recovery_decisions(case_id,created_at);

-- Recovery veto and queued-mail crypto is deliberately isolated from the
-- rotatable OTP verification secret. The first configured key is pinned; an
-- implicit in-place rotation is rejected until an explicit rewrap migration.
CREATE TABLE identity_recovery_key_config (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id=1),
  key_id TEXT NOT NULL UNIQUE CHECK (length(key_id) BETWEEN 1 AND 32 AND key_id=lower(key_id)
    AND substr(key_id,1,1) GLOB '[a-z0-9]' AND key_id NOT GLOB '*[^a-z0-9._-]*'),
  algorithm_version INTEGER NOT NULL CHECK (algorithm_version=1),
  verification_tag TEXT NOT NULL CHECK (length(verification_tag)=64 AND verification_tag=lower(verification_tag) AND verification_tag NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER identity_recovery_key_config_append_only_update BEFORE UPDATE ON identity_recovery_key_config
BEGIN SELECT RAISE(ABORT,'identity_recovery_key_config_append_only'); END;
CREATE TRIGGER identity_recovery_key_config_append_only_delete BEFORE DELETE ON identity_recovery_key_config
BEGIN SELECT RAISE(ABORT,'identity_recovery_key_config_append_only'); END;

CREATE TABLE identity_recovery_holds (
  case_id INTEGER PRIMARY KEY REFERENCES identity_recovery_cases(id),
  first_decision_id TEXT NOT NULL UNIQUE REFERENCES identity_recovery_decisions(decision_id),
  first_approver_person_id INTEGER NOT NULL REFERENCES people(id),
  expected_case_version INTEGER NOT NULL CHECK (expected_case_version BETWEEN 1 AND 2147483647),
  expected_person_id INTEGER NOT NULL REFERENCES people(id),
  expected_person_identity_version INTEGER NOT NULL CHECK (expected_person_identity_version BETWEEN 0 AND 2147483647),
  expected_person_session_epoch INTEGER NOT NULL CHECK (expected_person_session_epoch BETWEEN 0 AND 2147483646),
  reachable_contact_point_id INTEGER NOT NULL REFERENCES contact_points(id),
  expected_reachable_owner_person_id INTEGER REFERENCES people(id),
  expected_reachable_owner_generation INTEGER NOT NULL CHECK (expected_reachable_owner_generation BETWEEN 0 AND 2147483647),
  owner_policy TEXT NOT NULL DEFAULT 'replace_auth_owners' CHECK (owner_policy='replace_auth_owners'),
  veto_key_id TEXT NOT NULL,
  veto_token_hash TEXT NOT NULL UNIQUE CHECK (length(veto_token_hash)=64 AND veto_token_hash=lower(veto_token_hash) AND veto_token_hash NOT GLOB '*[^0-9a-f]*'),
  not_before_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (not_before_at>created_at AND expires_at>not_before_at)
);
CREATE INDEX idx_identity_recovery_holds_window ON identity_recovery_holds(not_before_at,expires_at);

CREATE TABLE identity_recovery_owner_snapshots (
  case_id INTEGER NOT NULL REFERENCES identity_recovery_cases(id),
  contact_point_id INTEGER NOT NULL REFERENCES contact_points(id),
  snapshot_role TEXT NOT NULL CHECK (snapshot_role IN ('target_auth','reachable')),
  expected_owner_person_id INTEGER REFERENCES people(id),
  expected_generation INTEGER NOT NULL CHECK (expected_generation BETWEEN 0 AND 2147483647),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (case_id,contact_point_id,snapshot_role)
);

CREATE TABLE identity_recovery_notification_outbox (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES identity_recovery_cases(id),
  category TEXT NOT NULL CHECK (category IN ('request_old_contact','hold_old_contact','completed_old_contact')),
  contact_point_id INTEGER NOT NULL REFERENCES contact_points(id),
  recipient_hash TEXT NOT NULL CHECK (length(recipient_hash)=64 AND recipient_hash=lower(recipient_hash) AND recipient_hash NOT GLOB '*[^0-9a-f]*'),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  payload_key_id TEXT,
  payload_ciphertext TEXT CHECK (payload_ciphertext IS NULL OR length(payload_ciphertext) BETWEEN 32 AND 1024),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','sent','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  lease_token_hash TEXT CHECK (lease_token_hash IS NULL OR (length(lease_token_hash)=64 AND lease_token_hash=lower(lease_token_hash) AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
  lease_expires_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code IN ('send_failed','payload_invalid')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  UNIQUE(case_id,category,contact_point_id),
  UNIQUE(case_id,category,recipient_hash),
  CHECK ((state='claimed')=(lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state='sent')=(sent_at IS NOT NULL)),
  CHECK ((category='hold_old_contact')=(payload_ciphertext IS NOT NULL AND payload_key_id IS NOT NULL))
);
CREATE INDEX idx_identity_recovery_notification_outbox_ready ON identity_recovery_notification_outbox(state,lease_expires_at,case_id,id);

CREATE TABLE identity_recovery_notification_receipts (
  id INTEGER PRIMARY KEY,
  outbox_id INTEGER NOT NULL REFERENCES identity_recovery_notification_outbox(id),
  event TEXT NOT NULL CHECK (event IN ('pending','claimed','sent','failed')),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 0 AND 100),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('send_failed','payload_invalid')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A public case may be deliberately resolved from no target to one active,
-- canonical target exactly once before review. Every other identity/source
-- binding is immutable, and even that one-way bind is forbidden after a hold.
CREATE TRIGGER identity_recovery_case_binding_guard
BEFORE UPDATE OF campus_id,person_id,contact_point_id,source_operation_id,claimed_target_hash,source_version
ON identity_recovery_cases
WHEN (
  OLD.campus_id IS NOT NEW.campus_id OR OLD.person_id IS NOT NEW.person_id
  OR OLD.contact_point_id IS NOT NEW.contact_point_id OR OLD.source_operation_id IS NOT NEW.source_operation_id
  OR OLD.claimed_target_hash IS NOT NEW.claimed_target_hash OR OLD.source_version IS NOT NEW.source_version
) AND NOT (
  OLD.state='open' AND NEW.state='open' AND OLD.person_id IS NULL AND NEW.person_id IS NOT NULL
  AND OLD.campus_id=NEW.campus_id AND OLD.contact_point_id=NEW.contact_point_id
  AND OLD.source_operation_id IS NEW.source_operation_id AND OLD.claimed_target_hash IS NEW.claimed_target_hash
  AND OLD.source_version=NEW.source_version AND NEW.version=OLD.version+1
  AND NOT EXISTS (SELECT 1 FROM identity_recovery_holds h WHERE h.case_id=OLD.id)
  AND EXISTS (SELECT 1 FROM people p LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
    WHERE p.id=NEW.person_id AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active'
      AND p.auth_disabled_at IS NULL AND p.merged_into_person_id IS NULL AND r.loser_person_id IS NULL)
)
BEGIN SELECT RAISE(ABORT,'identity_recovery_binding_immutable'); END;

CREATE TRIGGER identity_recovery_decisions_append_only_update BEFORE UPDATE ON identity_recovery_decisions
BEGIN SELECT RAISE(ABORT,'identity_recovery_decisions_append_only'); END;
CREATE TRIGGER identity_recovery_decisions_append_only_delete BEFORE DELETE ON identity_recovery_decisions
BEGIN SELECT RAISE(ABORT,'identity_recovery_decisions_append_only'); END;
CREATE TRIGGER identity_recovery_holds_append_only_update BEFORE UPDATE ON identity_recovery_holds
BEGIN SELECT RAISE(ABORT,'identity_recovery_holds_append_only'); END;
CREATE TRIGGER identity_recovery_holds_append_only_delete BEFORE DELETE ON identity_recovery_holds
BEGIN SELECT RAISE(ABORT,'identity_recovery_holds_append_only'); END;
CREATE TRIGGER identity_recovery_owner_snapshots_append_only_update BEFORE UPDATE ON identity_recovery_owner_snapshots
BEGIN SELECT RAISE(ABORT,'identity_recovery_owner_snapshots_append_only'); END;
CREATE TRIGGER identity_recovery_owner_snapshots_append_only_delete BEFORE DELETE ON identity_recovery_owner_snapshots
BEGIN SELECT RAISE(ABORT,'identity_recovery_owner_snapshots_append_only'); END;
CREATE TRIGGER identity_recovery_notification_outbox_insert_receipt AFTER INSERT ON identity_recovery_notification_outbox
BEGIN INSERT INTO identity_recovery_notification_receipts(outbox_id,event,attempt) VALUES(NEW.id,'pending',0); END;
CREATE TRIGGER identity_recovery_notification_outbox_transition_guard BEFORE UPDATE ON identity_recovery_notification_outbox
WHEN OLD.case_id IS NOT NEW.case_id OR OLD.category IS NOT NEW.category OR OLD.contact_point_id IS NOT NEW.contact_point_id
  OR OLD.recipient_hash IS NOT NEW.recipient_hash OR OLD.locale IS NOT NEW.locale OR OLD.payload_key_id IS NOT NEW.payload_key_id
  OR OLD.payload_ciphertext IS NOT NEW.payload_ciphertext
  OR OLD.created_at IS NOT NEW.created_at OR NOT (
    (OLD.state IN ('pending','failed') AND NEW.state='claimed' AND NEW.attempt_count=OLD.attempt_count+1)
    OR (OLD.state='claimed' AND OLD.lease_expires_at<=datetime('now') AND NEW.state='claimed' AND NEW.attempt_count=OLD.attempt_count+1)
    OR (OLD.state='claimed' AND NEW.state IN ('sent','failed') AND NEW.attempt_count=OLD.attempt_count)
  )
BEGIN SELECT RAISE(ABORT,'identity_recovery_notification_transition_guard'); END;
CREATE TRIGGER identity_recovery_notification_outbox_transition_receipt AFTER UPDATE OF state ON identity_recovery_notification_outbox
BEGIN INSERT INTO identity_recovery_notification_receipts(outbox_id,event,attempt,error_code)
  VALUES(NEW.id,NEW.state,NEW.attempt_count,NEW.last_error_code); END;
CREATE TRIGGER identity_recovery_notification_outbox_delete_guard BEFORE DELETE ON identity_recovery_notification_outbox
BEGIN SELECT RAISE(ABORT,'identity_recovery_notification_outbox_delete_guard'); END;
CREATE TRIGGER identity_recovery_notification_receipts_append_only_update BEFORE UPDATE ON identity_recovery_notification_receipts
BEGIN SELECT RAISE(ABORT,'identity_recovery_notification_receipts_append_only'); END;
CREATE TRIGGER identity_recovery_notification_receipts_append_only_delete BEFORE DELETE ON identity_recovery_notification_receipts
BEGIN SELECT RAISE(ABORT,'identity_recovery_notification_receipts_append_only'); END;

CREATE TRIGGER identity_recovery_household_contact_insert_guard BEFORE INSERT ON household_contact_links
WHEN NEW.ended_at IS NULL AND EXISTS (SELECT 1 FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
  WHERE c.state IN ('open','approved') AND h.reachable_contact_point_id=NEW.contact_point_id)
BEGIN SELECT RAISE(ABORT,'identity_recovery_reachable_household_conflict'); END;
CREATE TRIGGER identity_recovery_household_contact_update_guard BEFORE UPDATE OF ended_at,contact_point_id ON household_contact_links
WHEN NEW.ended_at IS NULL AND EXISTS (SELECT 1 FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
  WHERE c.state IN ('open','approved') AND h.reachable_contact_point_id=NEW.contact_point_id)
BEGIN SELECT RAISE(ABORT,'identity_recovery_reachable_household_conflict'); END;

CREATE TRIGGER identity_recovery_person_contact_insert_guard BEFORE INSERT ON person_contact_links
WHEN NEW.ended_at IS NULL AND EXISTS (SELECT 1 FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
  WHERE c.state IN ('open','approved') AND h.reachable_contact_point_id=NEW.contact_point_id
    AND NOT (NEW.person_id=h.expected_person_id AND EXISTS (SELECT 1 FROM identity_recovery_decisions d
      WHERE d.case_id=h.case_id AND d.decision='second_approval')))
BEGIN SELECT RAISE(ABORT,'identity_recovery_reachable_person_link_conflict'); END;
CREATE TRIGGER identity_recovery_person_contact_update_guard BEFORE UPDATE OF ended_at ON person_contact_links
WHEN NEW.ended_at IS NULL AND EXISTS (SELECT 1 FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
  WHERE c.state IN ('open','approved') AND h.reachable_contact_point_id=NEW.contact_point_id
    AND NOT (NEW.person_id=h.expected_person_id AND EXISTS (SELECT 1 FROM identity_recovery_decisions d
      WHERE d.case_id=h.case_id AND d.decision='second_approval')))
BEGIN SELECT RAISE(ABORT,'identity_recovery_reachable_person_link_conflict'); END;

CREATE TRIGGER identity_recovery_first_decision_guard BEFORE INSERT ON identity_recovery_decisions
WHEN NEW.decision='first_approval' AND (
  NOT EXISTS (SELECT 1 FROM identity_recovery_cases c JOIN people p ON p.id=NEW.expected_person_id
    WHERE c.id=NEW.case_id AND c.state='open' AND c.version=NEW.expected_case_version
      AND c.person_id=NEW.expected_person_id AND c.contact_point_id IS NOT NULL AND c.expires_at>NEW.created_at
      AND NOT EXISTS (SELECT 1 FROM person_contact_links link WHERE link.contact_point_id=c.contact_point_id AND link.ended_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM household_contact_links household WHERE household.contact_point_id=c.contact_point_id AND household.ended_at IS NULL)
      AND COALESCE((SELECT person_id FROM verified_contact_owners owner WHERE owner.contact_point_id=c.contact_point_id),0)
        =COALESCE(NEW.expected_reachable_owner_person_id,0)
      AND COALESCE((SELECT MAX(generation) FROM contact_owner_mutation_claims mutation WHERE mutation.contact_point_id=c.contact_point_id),0)
        =NEW.expected_reachable_owner_generation
      AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
      AND p.identity_version=NEW.expected_person_identity_version AND p.session_epoch=NEW.expected_person_session_epoch
      AND p.merged_into_person_id IS NULL AND NOT EXISTS (SELECT 1 FROM person_merge_redirects r WHERE r.loser_person_id=p.id))
  OR NOT EXISTS (SELECT 1 FROM people a WHERE a.id=NEW.actor_person_id AND a.role='admin' AND a.super_admin=1
      AND a.active=1 AND a.deleted_at IS NULL AND a.identity_state='active' AND a.auth_disabled_at IS NULL)
  OR EXISTS (SELECT 1 FROM identity_recovery_holds h WHERE h.case_id=NEW.case_id)
)
BEGIN SELECT RAISE(ABORT,'identity_recovery_first_guard'); END;

CREATE TRIGGER identity_recovery_hold_guard BEFORE INSERT ON identity_recovery_holds WHEN
  NOT EXISTS (SELECT 1 FROM identity_recovery_decisions d JOIN identity_recovery_cases c ON c.id=d.case_id
    WHERE d.decision_id=NEW.first_decision_id AND d.case_id=NEW.case_id AND d.decision='first_approval'
      AND d.actor_person_id=NEW.first_approver_person_id AND d.expected_case_version=NEW.expected_case_version
      AND d.expected_person_id=NEW.expected_person_id AND d.expected_person_identity_version=NEW.expected_person_identity_version
      AND d.expected_person_session_epoch=NEW.expected_person_session_epoch
      AND d.expected_reachable_owner_generation=NEW.expected_reachable_owner_generation
      AND COALESCE(d.expected_reachable_owner_person_id,0)=COALESCE(NEW.expected_reachable_owner_person_id,0)
      AND c.state='open' AND c.version=NEW.expected_case_version AND c.person_id=NEW.expected_person_id
      AND c.contact_point_id=NEW.reachable_contact_point_id AND c.expires_at>=NEW.expires_at)
BEGIN SELECT RAISE(ABORT,'identity_recovery_hold_guard'); END;

CREATE TRIGGER identity_recovery_second_decision_guard BEFORE INSERT ON identity_recovery_decisions
WHEN NEW.decision='second_approval' AND (
  NOT EXISTS (SELECT 1 FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
    JOIN people p ON p.id=h.expected_person_id
    WHERE h.case_id=NEW.case_id AND c.state='open' AND c.version=h.expected_case_version+1
      AND c.person_id=h.expected_person_id AND c.contact_point_id=h.reachable_contact_point_id
      AND NEW.expected_case_version=c.version AND NEW.expected_person_id=h.expected_person_id
      AND NEW.expected_person_identity_version=h.expected_person_identity_version
      AND NEW.expected_person_session_epoch=h.expected_person_session_epoch
      AND NEW.expected_reachable_owner_generation=h.expected_reachable_owner_generation
      AND COALESCE(NEW.expected_reachable_owner_person_id,0)=COALESCE(h.expected_reachable_owner_person_id,0)
      AND NEW.actor_person_id<>h.first_approver_person_id AND NEW.created_at>=h.not_before_at AND NEW.created_at<h.expires_at
      AND NOT EXISTS (SELECT 1 FROM identity_recovery_decisions veto WHERE veto.case_id=h.case_id AND veto.decision='veto')
      AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
      AND p.identity_version=h.expected_person_identity_version AND p.session_epoch=h.expected_person_session_epoch
      AND p.merged_into_person_id IS NULL AND NOT EXISTS (SELECT 1 FROM person_merge_redirects r WHERE r.loser_person_id=p.id)
      AND NOT EXISTS (SELECT 1 FROM identity_person_canonical_keys stale
        WHERE stale.is_current<>1 OR stale.normalization_version<>1)
      AND NOT EXISTS (SELECT 1 FROM identity_person_canonical_keys canonical JOIN people other ON other.id=canonical.person_id
        WHERE canonical.person_id<>p.id AND other.deleted_at IS NULL AND canonical.is_current=1
          AND canonical.normalization_version=1
          AND canonical.legacy_email_key=(SELECT normalized_value FROM contact_points WHERE id=h.reachable_contact_point_id))
      AND NOT EXISTS (SELECT 1 FROM people other WHERE other.id<>p.id AND other.deleted_at IS NULL
        AND lower(other.email)=(SELECT normalized_value FROM contact_points WHERE id=h.reachable_contact_point_id)))
  OR NOT EXISTS (SELECT 1 FROM people a WHERE a.id=NEW.actor_person_id AND a.role='admin' AND a.super_admin=1
      AND a.active=1 AND a.deleted_at IS NULL AND a.identity_state='active' AND a.auth_disabled_at IS NULL)
  OR EXISTS (SELECT 1 FROM person_contact_links l JOIN identity_recovery_holds h ON h.reachable_contact_point_id=l.contact_point_id
      WHERE h.case_id=NEW.case_id AND l.ended_at IS NULL)
  OR EXISTS (SELECT 1 FROM household_contact_links l JOIN identity_recovery_holds h ON h.reachable_contact_point_id=l.contact_point_id
      WHERE h.case_id=NEW.case_id AND l.ended_at IS NULL)
  OR EXISTS (SELECT 1 FROM identity_recovery_holds h
      WHERE h.case_id=NEW.case_id AND COALESCE((SELECT person_id FROM verified_contact_owners v WHERE v.contact_point_id=h.reachable_contact_point_id),0)
        <>COALESCE(h.expected_reachable_owner_person_id,0))
  OR EXISTS (SELECT 1 FROM identity_recovery_holds h
      WHERE h.case_id=NEW.case_id AND COALESCE((SELECT MAX(generation) FROM contact_owner_mutation_claims m WHERE m.contact_point_id=h.reachable_contact_point_id),0)
        <>h.expected_reachable_owner_generation)
  OR EXISTS (SELECT 1 FROM identity_recovery_owner_snapshots s JOIN identity_recovery_holds h ON h.case_id=s.case_id
      WHERE s.case_id=NEW.case_id AND s.snapshot_role='target_auth' AND (
        COALESCE((SELECT person_id FROM verified_contact_owners v WHERE v.contact_point_id=s.contact_point_id),0)<>COALESCE(s.expected_owner_person_id,0)
        OR COALESCE((SELECT MAX(generation) FROM contact_owner_mutation_claims m WHERE m.contact_point_id=s.contact_point_id),0)<>s.expected_generation))
  OR EXISTS (SELECT 1 FROM verified_contact_owners v JOIN identity_recovery_holds h ON h.expected_person_id=v.person_id
      WHERE h.case_id=NEW.case_id AND NOT EXISTS (SELECT 1 FROM identity_recovery_owner_snapshots s
        WHERE s.case_id=NEW.case_id AND s.snapshot_role='target_auth' AND s.contact_point_id=v.contact_point_id))
)
BEGIN SELECT RAISE(ABORT,'identity_recovery_second_guard'); END;

CREATE TRIGGER identity_recovery_veto_guard BEFORE INSERT ON identity_recovery_decisions
WHEN NEW.decision='veto' AND NOT EXISTS (SELECT 1 FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
  WHERE h.case_id=NEW.case_id AND c.state='open' AND c.person_id=h.expected_person_id
    AND c.contact_point_id=h.reachable_contact_point_id AND NEW.created_at<h.expires_at
    AND NOT EXISTS (SELECT 1 FROM identity_recovery_decisions d WHERE d.case_id=h.case_id AND d.decision IN ('second_approval','executed')))
BEGIN SELECT RAISE(ABORT,'identity_recovery_veto_guard'); END;

CREATE TRIGGER identity_recovery_case_resolution_guard BEFORE UPDATE OF state ON identity_recovery_cases
WHEN OLD.state='open' AND NEW.state<>OLD.state AND (
  (NEW.state='approved' AND NOT EXISTS (
    SELECT 1 FROM identity_recovery_holds h JOIN people p ON p.id=h.expected_person_id
    JOIN verified_contact_owners o ON o.contact_point_id=h.reachable_contact_point_id AND o.person_id=p.id
    WHERE h.case_id=OLD.id AND NEW.version=OLD.version+1
      AND OLD.person_id=h.expected_person_id AND OLD.contact_point_id=h.reachable_contact_point_id
      AND NOT EXISTS (SELECT 1 FROM household_contact_links household WHERE household.contact_point_id=h.reachable_contact_point_id AND household.ended_at IS NULL)
      AND p.session_epoch=h.expected_person_session_epoch+1 AND p.identity_version=h.expected_person_identity_version+1
      AND EXISTS (SELECT 1 FROM identity_recovery_decisions d WHERE d.case_id=OLD.id AND d.decision='second_approval')
      AND EXISTS (SELECT 1 FROM identity_recovery_decisions d WHERE d.case_id=OLD.id AND d.decision='executed')
      AND NOT EXISTS (SELECT 1 FROM identity_recovery_decisions d WHERE d.case_id=OLD.id AND d.decision='veto')))
  OR (NEW.state='rejected' AND NEW.resolution='veto' AND (
      NOT EXISTS (SELECT 1 FROM identity_recovery_holds h WHERE h.case_id=OLD.id
        AND OLD.person_id=h.expected_person_id AND OLD.contact_point_id=h.reachable_contact_point_id)
      OR NOT EXISTS (SELECT 1 FROM identity_recovery_decisions d WHERE d.case_id=OLD.id AND d.decision='veto')
      OR EXISTS (SELECT 1 FROM identity_recovery_decisions d WHERE d.case_id=OLD.id AND d.decision IN ('second_approval','executed'))))
)
BEGIN SELECT RAISE(ABORT,'identity_recovery_resolution_guard'); END;
