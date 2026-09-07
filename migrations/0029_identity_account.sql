-- Account-level identity operations. These records bridge a consumed challenge
-- to exactly one recoverable account mutation without storing raw secrets.

CREATE TABLE identity_person_canonical_keys (
  person_id INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  legacy_email_key TEXT CHECK (legacy_email_key IS NULL OR length(CAST(legacy_email_key AS BLOB)) BETWEEN 1 AND 512),
  normalized_name_key TEXT CHECK (normalized_name_key IS NULL OR length(CAST(normalized_name_key AS BLOB)) BETWEEN 1 AND 512),
  normalization_version INTEGER NOT NULL DEFAULT 0 CHECK (normalization_version BETWEEN 0 AND 2147483647),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  source_email TEXT NOT NULL,
  source_display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ,CHECK (is_current=0 OR normalization_version=1)
);
CREATE INDEX idx_identity_person_email_key ON identity_person_canonical_keys(normalization_version,is_current,legacy_email_key,person_id);
CREATE INDEX idx_identity_person_name_key ON identity_person_canonical_keys(normalization_version,is_current,normalized_name_key,person_id);
CREATE INDEX idx_identity_person_stale_key ON identity_person_canonical_keys(is_current,person_id);
INSERT INTO identity_person_canonical_keys(person_id,source_email,source_display_name) SELECT id,email,display_name FROM people;
CREATE TRIGGER identity_person_canonical_keys_insert AFTER INSERT ON people BEGIN
  INSERT INTO identity_person_canonical_keys(person_id,source_email,source_display_name) VALUES(NEW.id,NEW.email,NEW.display_name);
END;
CREATE TRIGGER identity_person_canonical_keys_update AFTER UPDATE OF email,display_name ON people BEGIN
  UPDATE identity_person_canonical_keys SET normalization_version=0,is_current=0,source_email=NEW.email,source_display_name=NEW.display_name,updated_at=datetime('now')
    WHERE person_id=NEW.id;
END;
CREATE TRIGGER identity_canonical_exact_guard_insert BEFORE INSERT ON identity_person_canonical_keys
WHEN NEW.is_current=1 AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id=NEW.person_id AND p.email=NEW.source_email AND p.display_name=NEW.source_display_name)
BEGIN SELECT RAISE(ABORT, 'identity_canonical_source_stale'); END;
CREATE TRIGGER identity_canonical_exact_guard_update BEFORE UPDATE ON identity_person_canonical_keys
WHEN NEW.is_current=1 AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id=NEW.person_id AND p.email=NEW.source_email AND p.display_name=NEW.source_display_name)
BEGIN SELECT RAISE(ABORT, 'identity_canonical_source_stale'); END;

CREATE TABLE identity_account_operations (
  operation_id TEXT PRIMARY KEY CHECK (
    length(operation_id) = 36 AND operation_id = lower(operation_id) AND
    substr(operation_id,9,1) = '-' AND substr(operation_id,14,1) = '-' AND
    substr(operation_id,19,1) = '-' AND substr(operation_id,24,1) = '-' AND
    length(replace(operation_id,'-','')) = 32 AND operation_id NOT GLOB '*[^0-9a-f-]*'
  ),
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  kind TEXT NOT NULL CHECK (kind IN ('signup','contact_change','recovery')),
  challenge_id INTEGER NOT NULL UNIQUE REFERENCES identity_challenges(id),
  observation_id INTEGER UNIQUE REFERENCES identity_observations(id),
  target_person_id INTEGER REFERENCES people(id),
  prior_contact_point_id INTEGER REFERENCES contact_points(id),
  expected_session_epoch INTEGER CHECK (expected_session_epoch IS NULL OR expected_session_epoch BETWEEN 0 AND 2147483646),
  reserved_person_id INTEGER UNIQUE,
  requested_display_name TEXT CHECK (requested_display_name IS NULL OR length(CAST(requested_display_name AS BLOB)) BETWEEN 1 AND 512),
  requested_normalized_name TEXT CHECK (requested_normalized_name IS NULL OR length(CAST(requested_normalized_name AS BLOB)) BETWEEN 1 AND 512),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','review','completed')),
  result_person_id INTEGER REFERENCES people(id),
  result_case_id INTEGER,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((kind='signup' AND observation_id IS NOT NULL AND target_person_id IS NULL AND reserved_person_id IS NOT NULL AND expected_session_epoch IS NULL AND requested_display_name IS NOT NULL AND requested_normalized_name IS NOT NULL)
    OR (kind='contact_change' AND observation_id IS NULL AND target_person_id IS NOT NULL AND prior_contact_point_id IS NOT NULL AND expected_session_epoch IS NOT NULL AND reserved_person_id IS NULL AND requested_display_name IS NULL AND requested_normalized_name IS NULL)
    OR (kind='recovery' AND observation_id IS NULL AND reserved_person_id IS NULL AND expected_session_epoch IS NULL AND requested_display_name IS NULL AND requested_normalized_name IS NULL))
);
CREATE INDEX idx_identity_account_operations_campus_state
  ON identity_account_operations(campus_id,state,created_at);

CREATE TABLE identity_account_review_cases (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES identity_account_operations(operation_id),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('legacy_contact_collision','linked_contact','household_contact','name_collision','external_collision','owned_contact','stale_target','canonical_registry_stale','multiple_signals')),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','approved','rejected','dismissed')),
  risk TEXT NOT NULL DEFAULT 'high' CHECK (risk IN ('normal','high')),
  reviewer_person_id INTEGER REFERENCES people(id),
  resolution TEXT CHECK (resolution IS NULL OR length(CAST(resolution AS BLOB)) BETWEEN 1 AND 1024),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_identity_account_review_queue
  ON identity_account_review_cases(campus_id,state,risk,created_at);

CREATE TABLE identity_account_proof_uses (
  challenge_id INTEGER PRIMARY KEY REFERENCES identity_challenges(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES identity_account_operations(operation_id),
  contact_point_id INTEGER NOT NULL REFERENCES contact_points(id),
  person_id INTEGER REFERENCES people(id),
  proof_category TEXT NOT NULL CHECK (proof_category IN ('signup_create','signup_owner','signup_review','contact_change','contact_change_review','recovery_case')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE identity_session_epoch_claims (
  operation_id TEXT PRIMARY KEY REFERENCES identity_account_operations(operation_id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  expected_epoch INTEGER NOT NULL CHECK (expected_epoch BETWEEN 0 AND 2147483646),
  resulting_epoch INTEGER NOT NULL CHECK (resulting_epoch=expected_epoch+1),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE identity_session_delivery_claims (
  operation_id TEXT PRIMARY KEY REFERENCES identity_account_operations(operation_id),
  challenge_id INTEGER NOT NULL UNIQUE REFERENCES identity_challenges(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER identity_session_delivery_claim_guard BEFORE INSERT ON identity_session_delivery_claims
WHEN NOT EXISTS (
  SELECT 1 FROM identity_account_operations op
  JOIN identity_challenges c ON c.id=op.challenge_id
  JOIN identity_account_proof_uses u ON u.operation_id=op.operation_id AND u.challenge_id=c.id
  WHERE op.operation_id=NEW.operation_id AND op.kind='signup' AND op.state='completed'
    AND op.challenge_id=NEW.challenge_id AND op.result_person_id=NEW.person_id
    AND c.purpose='signup' AND c.consumed_at IS NOT NULL AND c.ownership_consumed_at IS NOT NULL
    AND u.person_id=NEW.person_id AND u.proof_category IN ('signup_create','signup_owner')
)
BEGIN SELECT RAISE(ABORT, 'identity_session_delivery_invalid'); END;
CREATE TRIGGER identity_session_delivery_claims_append_only_update BEFORE UPDATE ON identity_session_delivery_claims BEGIN SELECT RAISE(ABORT, 'identity_session_delivery_claims_append_only'); END;
CREATE TRIGGER identity_session_delivery_claims_append_only_delete BEFORE DELETE ON identity_session_delivery_claims BEGIN SELECT RAISE(ABORT, 'identity_session_delivery_claims_append_only'); END;
CREATE TRIGGER identity_session_epoch_claim_guard
BEFORE INSERT ON identity_session_epoch_claims
WHEN NOT EXISTS (SELECT 1 FROM identity_account_operations op JOIN people p ON p.id=op.target_person_id
  WHERE op.operation_id=NEW.operation_id AND op.kind='contact_change' AND op.state='pending'
    AND op.target_person_id=NEW.person_id AND op.expected_session_epoch=NEW.expected_epoch AND p.session_epoch=NEW.expected_epoch)
BEGIN SELECT RAISE(ABORT, 'identity_contact_change_epoch_conflict'); END;
CREATE TRIGGER identity_session_epoch_claims_append_only_update BEFORE UPDATE ON identity_session_epoch_claims BEGIN SELECT RAISE(ABORT, 'identity_session_epoch_claims_append_only'); END;
CREATE TRIGGER identity_session_epoch_claims_append_only_delete BEFORE DELETE ON identity_session_epoch_claims BEGIN SELECT RAISE(ABORT, 'identity_session_epoch_claims_append_only'); END;

CREATE TRIGGER identity_account_proof_guard
BEFORE INSERT ON identity_account_proof_uses
WHEN NOT EXISTS (
    SELECT 1 FROM identity_account_operations op
    JOIN identity_challenges c ON c.id=op.challenge_id
    WHERE op.operation_id=NEW.operation_id AND op.challenge_id=NEW.challenge_id
      AND op.state='pending' AND c.contact_point_id=NEW.contact_point_id
      AND c.campus_id=op.campus_id AND c.consumed_at IS NOT NULL
      AND c.superseded_at IS NULL AND c.ownership_consumed_at IS NULL
      AND ((NEW.proof_category='signup_create' AND op.kind='signup' AND c.purpose='signup' AND c.person_id IS NULL AND NEW.person_id=op.reserved_person_id)
        OR (NEW.proof_category='signup_owner' AND op.kind='signup' AND c.purpose='signup' AND c.person_id=NEW.person_id AND EXISTS (
          SELECT 1 FROM verified_contact_owners o JOIN people p ON p.id=o.person_id
          JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=op.campus_id AND cm.active=1
          LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
          WHERE o.contact_point_id=NEW.contact_point_id AND o.person_id=NEW.person_id AND p.active=1 AND p.deleted_at IS NULL
            AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL))
        OR (NEW.proof_category='signup_review' AND op.kind='signup' AND c.purpose='signup' AND c.person_id IS NULL AND NEW.person_id IS NULL)
        OR (NEW.proof_category='contact_change' AND op.kind='contact_change' AND c.purpose='contact_change' AND NEW.person_id=op.target_person_id AND c.person_id=op.target_person_id)
        OR (NEW.proof_category='contact_change_review' AND op.kind='contact_change' AND c.purpose='contact_change' AND NEW.person_id=op.target_person_id AND c.person_id=op.target_person_id)
        OR (NEW.proof_category='recovery_case' AND op.kind='recovery' AND c.purpose='recovery' AND COALESCE(NEW.person_id,0)=COALESCE(op.target_person_id,0)))
  )
BEGIN SELECT RAISE(ABORT, 'identity_account_proof_invalid'); END;

CREATE TRIGGER identity_signup_create_clean_guard
BEFORE INSERT ON identity_account_proof_uses
WHEN NEW.proof_category='signup_create' AND EXISTS (
  SELECT 1 FROM identity_account_operations op JOIN identity_challenges c ON c.id=op.challenge_id JOIN contact_points cp ON cp.id=c.contact_point_id
  WHERE op.operation_id=NEW.operation_id AND (
    EXISTS (SELECT 1 FROM verified_contact_owners o WHERE o.contact_point_id=cp.id)
    OR EXISTS (SELECT 1 FROM person_contact_links l WHERE l.contact_point_id=cp.id)
    OR EXISTS (SELECT 1 FROM household_contact_links h WHERE h.contact_point_id=cp.id)
    OR EXISTS (SELECT 1 FROM identity_person_canonical_keys k WHERE k.is_current=0 OR k.normalization_version<>1)
    OR EXISTS (SELECT 1 FROM identity_person_canonical_keys k WHERE k.normalization_version=1 AND k.is_current=1 AND k.person_id<>op.reserved_person_id AND (k.legacy_email_key=cp.normalized_value OR k.normalized_name_key=op.requested_normalized_name))
    OR EXISTS (SELECT 1 FROM identity_observations x WHERE x.id<>op.observation_id AND x.normalized_email=cp.normalized_value)
  )
)
BEGIN SELECT RAISE(ABORT, 'identity_signup_review_required'); END;

CREATE TRIGGER identity_contact_change_clean_guard
BEFORE INSERT ON identity_account_proof_uses
WHEN NEW.proof_category='contact_change' AND EXISTS (
  SELECT 1 FROM identity_account_operations op JOIN identity_challenges c ON c.id=op.challenge_id JOIN contact_points cp ON cp.id=c.contact_point_id
  WHERE op.operation_id=NEW.operation_id AND (
    EXISTS (SELECT 1 FROM verified_contact_owners o WHERE o.contact_point_id=cp.id)
    OR EXISTS (SELECT 1 FROM person_contact_links l WHERE l.contact_point_id=cp.id)
    OR EXISTS (SELECT 1 FROM household_contact_links h WHERE h.contact_point_id=cp.id)
    OR EXISTS (SELECT 1 FROM identity_person_canonical_keys k WHERE k.is_current=0 OR k.normalization_version<>1)
    OR EXISTS (SELECT 1 FROM identity_person_canonical_keys k WHERE k.normalization_version=1 AND k.is_current=1 AND k.person_id<>op.target_person_id AND k.legacy_email_key=cp.normalized_value)
    OR NOT EXISTS (SELECT 1 FROM people p LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
      WHERE p.id=op.target_person_id AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL)
    OR NOT EXISTS (SELECT 1 FROM campus_memberships cm WHERE cm.campus_id=op.campus_id AND cm.person_id=op.target_person_id AND cm.active=1)
  )
)
BEGIN SELECT RAISE(ABORT, 'identity_contact_change_review_required'); END;

CREATE TRIGGER identity_account_proof_uses_append_only_update BEFORE UPDATE ON identity_account_proof_uses BEGIN SELECT RAISE(ABORT, 'identity_account_proof_uses_append_only'); END;
CREATE TRIGGER identity_account_proof_uses_append_only_delete BEFORE DELETE ON identity_account_proof_uses BEGIN SELECT RAISE(ABORT, 'identity_account_proof_uses_append_only'); END;

CREATE TRIGGER identity_contact_change_completion_guard
BEFORE UPDATE OF state ON identity_account_operations
WHEN OLD.kind='contact_change' AND OLD.state='pending' AND NEW.state='completed' AND (
  NOT EXISTS (SELECT 1 FROM people p WHERE p.id=OLD.target_person_id AND p.session_epoch=OLD.expected_session_epoch+1)
  OR NOT EXISTS (SELECT 1 FROM identity_account_proof_uses u WHERE u.operation_id=OLD.operation_id AND u.proof_category='contact_change')
)
BEGIN SELECT RAISE(ABORT, 'identity_contact_change_epoch_conflict'); END;
