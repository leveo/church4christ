-- Durable adapters between identity-source proof and business-domain writes.
-- Core intent/receipt rows carry only opaque ids and cryptographic digests;
-- business payload stays in kind-specific tables and never enters identity audit.

CREATE TABLE identity_business_intents (
  intent_id TEXT PRIMARY KEY CHECK (
    length(CAST(intent_id AS BLOB))=36 AND intent_id=lower(intent_id)
    AND substr(intent_id,9,1)='-' AND substr(intent_id,14,1)='-'
    AND substr(intent_id,19,1)='-' AND substr(intent_id,24,1)='-'
    AND length(replace(intent_id,'-',''))=32 AND intent_id NOT GLOB '*[^0-9a-f-]*'
  ),
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  kind TEXT NOT NULL CHECK (kind IN ('team_application','newcomer_submission','giving_checkout','registration')),
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES identity_source_records(id),
  source_version INTEGER NOT NULL CHECK (source_version BETWEEN 1 AND 2147483647),
  source_digest TEXT NOT NULL CHECK (length(source_digest)=64 AND source_digest=lower(source_digest) AND source_digest NOT GLOB '*[^0-9a-f]*'),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest)=64 AND payload_digest=lower(payload_digest) AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  signup_reservation_id TEXT NOT NULL UNIQUE CHECK (signup_reservation_id=intent_id),
  signup_operation_id TEXT UNIQUE REFERENCES identity_account_operations(operation_id),
  signup_issuance_token TEXT,
  signup_issuance_expires_at TEXT,
  result_person_id INTEGER REFERENCES people(id),
  state TEXT NOT NULL DEFAULT 'pending_verification' CHECK (state IN ('pending_verification','ready','consumed','review','expired')),
  business_record_key TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((state IN ('ready','consumed'))=(result_person_id IS NOT NULL) OR state IN ('review','expired')),
  CHECK ((state='consumed')=(business_record_key IS NOT NULL))
);
CREATE INDEX idx_identity_business_intents_state ON identity_business_intents(campus_id,kind,state,expires_at);

CREATE TABLE identity_team_application_intents (
  intent_id TEXT PRIMARY KEY REFERENCES identity_business_intents(intent_id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  position_id INTEGER REFERENCES positions(id),
  message TEXT CHECK (message IS NULL OR length(CAST(message AS BLOB)) BETWEEN 1 AND 4000)
);

CREATE TABLE identity_newcomer_intents (
  intent_id TEXT PRIMARY KEY REFERENCES identity_business_intents(intent_id),
  submission_id TEXT NOT NULL UNIQUE,
  provisional_person_id INTEGER NOT NULL UNIQUE REFERENCES people(id)
);

CREATE TABLE identity_business_intent_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(CAST(receipt_id AS BLOB))=36 AND receipt_id=lower(receipt_id)
    AND substr(receipt_id,9,1)='-' AND substr(receipt_id,14,1)='-'
    AND substr(receipt_id,19,1)='-' AND substr(receipt_id,24,1)='-'
    AND length(replace(receipt_id,'-',''))=32 AND receipt_id NOT GLOB '*[^0-9a-f-]*'
  ),
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  intent_id TEXT NOT NULL UNIQUE REFERENCES identity_business_intents(intent_id),
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES identity_source_records(id),
  source_version INTEGER NOT NULL CHECK (source_version BETWEEN 1 AND 2147483647),
  source_digest TEXT NOT NULL CHECK (length(source_digest)=64 AND source_digest=lower(source_digest) AND source_digest NOT GLOB '*[^0-9a-f]*'),
  person_id INTEGER REFERENCES people(id),
  business_record_key TEXT NOT NULL CHECK (length(CAST(business_record_key AS BLOB)) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE newcomer_submissions ADD COLUMN identity_source_record_id INTEGER REFERENCES identity_source_records(id);
CREATE UNIQUE INDEX idx_newcomer_submissions_identity_source ON newcomer_submissions(identity_source_record_id)
  WHERE identity_source_record_id IS NOT NULL;

CREATE TRIGGER identity_business_intent_insert_guard
BEFORE INSERT ON identity_business_intents WHEN NEW.state<>'pending_verification' OR NEW.result_person_id IS NOT NULL
  OR NEW.business_record_key IS NOT NULL OR NEW.signup_operation_id IS NOT NULL
  OR NEW.signup_issuance_token IS NOT NULL OR NEW.signup_issuance_expires_at IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM identity_source_records s WHERE s.id=NEW.source_record_id AND s.campus_id=NEW.campus_id
      AND s.version=NEW.source_version AND s.source_digest=NEW.source_digest AND s.state='unlinked'
      AND ((NEW.kind='team_application' AND s.source='team' AND s.attachment_policy='signed_in_or_claim')
        OR (NEW.kind='newcomer_submission' AND s.source='newcomer' AND s.attachment_policy='observation_only')
        OR (NEW.kind='giving_checkout' AND s.source='giving' AND s.attachment_policy='signed_in_or_claim')
        OR (NEW.kind='registration' AND s.source='registration' AND s.attachment_policy='signed_in_or_claim'))
  )
BEGIN SELECT RAISE(ABORT,'identity_business_intent_invalid'); END;

CREATE TRIGGER identity_business_intent_identity_immutable
BEFORE UPDATE OF intent_id,campus_id,kind,source_record_id,source_version,source_digest,payload_digest,signup_reservation_id,signup_operation_id,expires_at
ON identity_business_intents
WHEN NEW.intent_id IS NOT OLD.intent_id OR NEW.campus_id IS NOT OLD.campus_id OR NEW.kind IS NOT OLD.kind
  OR NEW.source_record_id IS NOT OLD.source_record_id OR NEW.source_version IS NOT OLD.source_version
  OR NEW.source_digest IS NOT OLD.source_digest OR NEW.payload_digest IS NOT OLD.payload_digest
  OR NEW.signup_reservation_id IS NOT OLD.signup_reservation_id
  OR (OLD.signup_operation_id IS NOT NULL AND NEW.signup_operation_id IS NOT OLD.signup_operation_id)
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT,'identity_business_intent_immutable'); END;

CREATE TRIGGER identity_business_intent_signup_binding_guard
BEFORE UPDATE OF signup_operation_id ON identity_business_intents
WHEN OLD.signup_operation_id IS NULL AND (NEW.signup_operation_id IS NULL OR NEW.signup_operation_id<>OLD.signup_reservation_id OR NOT EXISTS (
  SELECT 1 FROM identity_account_operations op
  JOIN identity_challenges c ON c.id=op.challenge_id
  JOIN contact_points cp ON cp.id=c.contact_point_id
  JOIN identity_observations oo ON oo.id=op.observation_id
  JOIN identity_source_records s ON s.id=OLD.source_record_id
  JOIN identity_observations so ON so.id=s.observation_id
  WHERE op.operation_id=NEW.signup_operation_id AND op.campus_id=OLD.campus_id AND op.kind='signup' AND op.state='pending'
    AND op.observation_id IS NOT NULL AND c.campus_id=OLD.campus_id AND c.purpose='signup'
    AND cp.kind='email' AND cp.normalized_value=so.normalized_email
    AND oo.campus_id=OLD.campus_id AND oo.normalized_email=so.normalized_email AND oo.normalized_name IS so.normalized_name
    AND op.requested_normalized_name IS so.normalized_name
))
BEGIN SELECT RAISE(ABORT,'identity_business_intent_signup_binding_invalid'); END;

CREATE TRIGGER identity_team_application_intent_immutable
BEFORE UPDATE ON identity_team_application_intents
BEGIN SELECT RAISE(ABORT,'identity_team_application_intent_immutable'); END;
CREATE TRIGGER identity_newcomer_intent_immutable
BEFORE UPDATE ON identity_newcomer_intents
BEGIN SELECT RAISE(ABORT,'identity_newcomer_intent_immutable'); END;

CREATE TRIGGER identity_business_intent_result_immutable
BEFORE UPDATE OF result_person_id,business_record_key ON identity_business_intents
WHEN (OLD.result_person_id IS NOT NULL AND NEW.result_person_id IS NOT OLD.result_person_id)
  OR (OLD.business_record_key IS NOT NULL AND NEW.business_record_key IS NOT OLD.business_record_key)
BEGIN SELECT RAISE(ABORT,'identity_business_intent_result_immutable'); END;

CREATE TRIGGER identity_business_intent_transition_guard
BEFORE UPDATE OF state ON identity_business_intents WHEN NEW.state<>OLD.state AND NOT (
  (OLD.state='pending_verification' AND NEW.state IN ('ready','review','expired'))
  OR (OLD.state='ready' AND NEW.state IN ('consumed','review','expired'))
)
BEGIN SELECT RAISE(ABORT,'identity_business_intent_transition_invalid'); END;

CREATE TRIGGER identity_business_intent_ready_guard
BEFORE UPDATE OF state,result_person_id ON identity_business_intents
WHEN NEW.state='ready' AND (NEW.result_person_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM identity_source_records s WHERE s.id=OLD.source_record_id AND s.campus_id=OLD.campus_id
    AND s.version=OLD.source_version AND s.source_digest=OLD.source_digest
    AND ((OLD.kind='team_application' AND s.state='linked' AND s.linked_person_id=NEW.result_person_id)
      OR (OLD.kind='newcomer_submission' AND s.state='unlinked' AND s.provisional_person_id=NEW.result_person_id))
))
BEGIN SELECT RAISE(ABORT,'identity_business_intent_ready_invalid'); END;

CREATE TRIGGER identity_newcomer_submission_binding_guard
BEFORE INSERT ON newcomer_submissions WHEN NEW.identity_source_record_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM identity_source_records s WHERE s.id=NEW.identity_source_record_id AND s.campus_id=NEW.campus_id
    AND s.source='newcomer' AND s.attachment_policy='observation_only' AND s.state='unlinked'
    AND s.provisional_person_id=NEW.linked_person_id
)
BEGIN SELECT RAISE(ABORT,'identity_newcomer_submission_binding_invalid'); END;
CREATE TRIGGER identity_newcomer_submission_binding_update_guard
BEFORE UPDATE OF identity_source_record_id,linked_person_id,campus_id ON newcomer_submissions
WHEN (OLD.identity_source_record_id IS NULL AND NEW.identity_source_record_id IS NOT NULL)
  OR (OLD.identity_source_record_id IS NOT NULL AND (
    NEW.identity_source_record_id IS NOT OLD.identity_source_record_id OR NEW.linked_person_id IS NOT OLD.linked_person_id
    OR NEW.campus_id IS NOT OLD.campus_id))
BEGIN SELECT RAISE(ABORT,'identity_newcomer_submission_binding_immutable'); END;

CREATE TRIGGER identity_business_intent_receipt_guard
BEFORE INSERT ON identity_business_intent_receipts WHEN NOT EXISTS (
  SELECT 1 FROM identity_business_intents i JOIN identity_source_records s ON s.id=i.source_record_id
  WHERE i.intent_id=NEW.intent_id AND i.campus_id=NEW.campus_id AND i.state='ready'
    AND i.source_record_id=NEW.source_record_id AND i.source_version=NEW.source_version AND i.source_digest=NEW.source_digest
    AND s.version=i.source_version AND s.source_digest=i.source_digest AND i.result_person_id IS NEW.person_id
    AND ((i.kind='team_application' AND s.state='linked' AND s.linked_person_id=NEW.person_id AND EXISTS (
      SELECT 1 FROM identity_team_application_intents ti JOIN team_applications a
        ON a.team_id=ti.team_id AND a.person_id=NEW.person_id
      WHERE ti.intent_id=i.intent_id AND CAST(a.id AS TEXT)=NEW.business_record_key
    )) OR (i.kind='newcomer_submission' AND s.state='unlinked' AND s.provisional_person_id=NEW.person_id AND EXISTS (
      SELECT 1 FROM identity_newcomer_intents ni JOIN newcomer_submissions n
        ON n.id=ni.submission_id AND n.identity_source_record_id=s.id AND n.linked_person_id=NEW.person_id
      WHERE ni.intent_id=i.intent_id AND ni.submission_id=NEW.business_record_key
    )))
)
BEGIN SELECT RAISE(ABORT,'identity_business_intent_receipt_invalid'); END;

CREATE TRIGGER identity_business_intent_consumed_guard
BEFORE UPDATE OF state,business_record_key ON identity_business_intents
WHEN OLD.state<>'consumed' AND NEW.state='consumed' AND NOT EXISTS (
  SELECT 1 FROM identity_business_intent_receipts r WHERE r.intent_id=OLD.intent_id
    AND r.source_record_id=OLD.source_record_id AND r.source_version=OLD.source_version
    AND r.source_digest=OLD.source_digest AND r.person_id IS NEW.result_person_id
    AND r.business_record_key=NEW.business_record_key
)
BEGIN SELECT RAISE(ABORT,'identity_business_intent_consume_invalid'); END;

CREATE TRIGGER identity_business_intent_receipts_append_only_update
BEFORE UPDATE ON identity_business_intent_receipts BEGIN SELECT RAISE(ABORT,'identity_business_intent_receipts_append_only'); END;
CREATE TRIGGER identity_business_intent_receipts_append_only_delete
BEFORE DELETE ON identity_business_intent_receipts BEGIN SELECT RAISE(ABORT,'identity_business_intent_receipts_append_only'); END;

-- The source observation owned by this exact signup intent is expected input,
-- not evidence that a different person already exists.
DROP TRIGGER identity_signup_create_clean_guard;
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
    OR EXISTS (
      SELECT 1 FROM identity_observations x WHERE x.id<>op.observation_id AND x.normalized_email=cp.normalized_value
        AND NOT EXISTS (
          SELECT 1 FROM identity_business_intents bi JOIN identity_source_records s ON s.id=bi.source_record_id
          WHERE bi.signup_operation_id=op.operation_id AND bi.campus_id=op.campus_id AND s.observation_id=x.id
        )
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'identity_signup_review_required'); END;
