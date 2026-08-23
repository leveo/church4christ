-- Durable anonymous continuations for the Supabase-only Giving and
-- Registration modules.  The tables deliberately keep module payload out of
-- identity audit/receipt rows; the source observation carries the normalized
-- name/email and these child rows carry only the minimum business payload.

ALTER TABLE identity_business_intents ADD COLUMN signup_delivery_ciphertext TEXT
  CHECK (signup_delivery_ciphertext IS NULL OR length(CAST(signup_delivery_ciphertext AS BLOB)) BETWEEN 80 AND 4096);
ALTER TABLE identity_business_intents ADD COLUMN signup_delivery_count INTEGER NOT NULL DEFAULT 0
  CHECK (signup_delivery_count BETWEEN 0 AND 3);
ALTER TABLE identity_business_intents ADD COLUMN signup_delivery_not_before TEXT;

CREATE TABLE identity_giving_checkout_continuations (
  intent_id TEXT PRIMARY KEY REFERENCES identity_business_intents(intent_id),
  fund_id INTEGER NOT NULL CHECK (fund_id > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency=lower(currency) AND length(currency)=3 AND currency NOT GLOB '*[^a-z]*'),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  checkout_request_id TEXT NOT NULL UNIQUE CHECK (
    length(CAST(checkout_request_id AS BLOB))=36 AND checkout_request_id=lower(checkout_request_id)
    AND substr(checkout_request_id,9,1)='-' AND substr(checkout_request_id,14,1)='-'
    AND substr(checkout_request_id,19,1)='-' AND substr(checkout_request_id,24,1)='-'
    AND length(replace(checkout_request_id,'-',''))=32
    AND checkout_request_id NOT GLOB '*[^0-9a-f-]*'
  ),
  stripe_session_id TEXT UNIQUE,
  stripe_session_url TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','creating','attached','consumed','review','expired')),
  claim_token_hash TEXT CHECK (claim_token_hash IS NULL OR (length(claim_token_hash)=64 AND claim_token_hash NOT GLOB '*[^0-9a-f]*')),
  claim_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((stripe_session_id IS NULL)=(stripe_session_url IS NULL)),
  CHECK ((state IN ('attached','consumed'))=(stripe_session_id IS NOT NULL))
);
CREATE INDEX idx_identity_giving_continuations_state
  ON identity_giving_checkout_continuations(state,claim_expires_at,updated_at);

CREATE TABLE identity_registration_continuations (
  intent_id TEXT PRIMARY KEY REFERENCES identity_business_intents(intent_id),
  event_id INTEGER NOT NULL CHECK (event_id > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL CHECK (currency=lower(currency) AND length(currency)=3 AND currency NOT GLOB '*[^a-z]*'),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  answers_json TEXT NOT NULL CHECK (length(CAST(answers_json AS BLOB)) BETWEEN 2 AND 16000),
  question_digest TEXT NOT NULL CHECK (length(question_digest)=64 AND question_digest=lower(question_digest) AND question_digest NOT GLOB '*[^0-9a-f]*'),
  checkout_request_id TEXT UNIQUE,
  registration_id INTEGER UNIQUE REFERENCES registrations(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','creating','attached','consumed','review','expired')),
  claim_token_hash TEXT CHECK (claim_token_hash IS NULL OR (length(claim_token_hash)=64 AND claim_token_hash NOT GLOB '*[^0-9a-f]*')),
  claim_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (amount_cents=0 OR checkout_request_id IS NOT NULL),
  CHECK ((state IN ('attached','consumed'))=(registration_id IS NOT NULL))
);
CREATE INDEX idx_identity_registration_continuations_state
  ON identity_registration_continuations(state,claim_expires_at,updated_at);

-- Transaction-local assertion sentinel. Application batches insert a scalar
-- subquery of the exact bound parent row and immediately delete it. If the
-- parent CAS changed zero rows, the subquery yields NULL and this NOT NULL
-- primary key aborts the whole D1 transaction, including the prepared OTP
-- challenge and signup operation.
CREATE TABLE identity_business_signup_binding_assertions (
  intent_id TEXT PRIMARY KEY NOT NULL REFERENCES identity_business_intents(intent_id)
);

CREATE TRIGGER identity_giving_continuation_identity_immutable
BEFORE UPDATE OF intent_id,fund_id,amount_cents,currency,locale,checkout_request_id
ON identity_giving_checkout_continuations
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_immutable'); END;
CREATE TRIGGER identity_registration_continuation_identity_immutable
BEFORE UPDATE OF intent_id,event_id,amount_cents,currency,locale,answers_json,question_digest,checkout_request_id
ON identity_registration_continuations
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_immutable'); END;

CREATE TRIGGER identity_giving_continuation_state_guard
BEFORE UPDATE OF state ON identity_giving_checkout_continuations
WHEN NEW.state<>OLD.state AND NOT ((OLD.state='pending' AND NEW.state IN ('ready','review','expired'))
  OR (OLD.state='ready' AND NEW.state IN ('creating','review','expired'))
  OR (OLD.state='creating' AND NEW.state IN ('ready','attached','review','expired'))
  OR (OLD.state='attached' AND NEW.state='consumed'))
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_transition_invalid'); END;
CREATE TRIGGER identity_registration_continuation_state_guard
BEFORE UPDATE OF state ON identity_registration_continuations
WHEN NEW.state<>OLD.state AND NOT ((OLD.state='pending' AND NEW.state IN ('ready','review','expired'))
  OR (OLD.state='ready' AND NEW.state IN ('creating','review','expired'))
  OR (OLD.state='creating' AND NEW.state IN ('ready','attached','review','expired'))
  OR (OLD.state='attached' AND NEW.state='consumed'))
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_transition_invalid'); END;
CREATE TRIGGER identity_giving_continuation_result_immutable
BEFORE UPDATE OF stripe_session_id,stripe_session_url ON identity_giving_checkout_continuations
WHEN (OLD.stripe_session_id IS NOT NULL AND NEW.stripe_session_id IS NOT OLD.stripe_session_id)
  OR (OLD.stripe_session_url IS NOT NULL AND NEW.stripe_session_url IS NOT OLD.stripe_session_url)
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_result_immutable'); END;
CREATE TRIGGER identity_registration_continuation_result_immutable
BEFORE UPDATE OF registration_id ON identity_registration_continuations
WHEN OLD.registration_id IS NOT NULL AND NEW.registration_id IS NOT OLD.registration_id
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_result_immutable'); END;

-- Encrypted retry material is short-lived challenge material, never a durable
-- profile attribute. It may be written once for a pending bound operation,
-- advanced only by a bounded resend CAS, and must be erased before any terminal
-- or business-ready state is visible.
CREATE TRIGGER identity_business_delivery_insert_guard
BEFORE INSERT ON identity_business_intents
WHEN NEW.signup_delivery_ciphertext IS NOT NULL OR NEW.signup_delivery_count<>0 OR NEW.signup_delivery_not_before IS NOT NULL
BEGIN SELECT RAISE(ABORT,'identity_business_delivery_lifecycle_invalid'); END;
CREATE TRIGGER identity_business_delivery_lifecycle_guard
BEFORE UPDATE OF state,signup_delivery_ciphertext,signup_delivery_count,signup_delivery_not_before ON identity_business_intents
WHEN (NEW.state<>'pending_verification' AND (NEW.signup_delivery_ciphertext IS NOT NULL
    OR NEW.signup_delivery_count<>0 OR NEW.signup_delivery_not_before IS NOT NULL))
  OR (NEW.signup_delivery_ciphertext IS NULL AND (NEW.signup_delivery_count<>0 OR NEW.signup_delivery_not_before IS NOT NULL))
  OR (OLD.signup_delivery_ciphertext IS NULL AND NEW.signup_delivery_ciphertext IS NOT NULL AND (
    OLD.state<>'pending_verification' OR NEW.state<>'pending_verification' OR OLD.signup_operation_id IS NOT NULL
    OR NEW.signup_operation_id IS NULL OR NEW.signup_delivery_count<>1 OR NEW.signup_delivery_not_before IS NULL))
  OR (OLD.signup_delivery_ciphertext IS NOT NULL AND NEW.signup_delivery_ciphertext IS NOT NULL AND (
    NEW.signup_delivery_ciphertext IS NOT OLD.signup_delivery_ciphertext OR OLD.state<>'pending_verification'
    OR NEW.state<>'pending_verification' OR NEW.signup_operation_id IS NOT OLD.signup_operation_id
    OR NEW.signup_delivery_count<>OLD.signup_delivery_count+1 OR NEW.signup_delivery_count>3
    OR NEW.signup_delivery_not_before IS NULL OR NEW.signup_delivery_not_before<=OLD.signup_delivery_not_before))
BEGIN SELECT RAISE(ABORT,'identity_business_delivery_lifecycle_invalid'); END;
CREATE TRIGGER identity_business_continuation_terminal_guard
BEFORE UPDATE OF state ON identity_business_intents
WHEN NEW.state IN ('review','expired') AND OLD.kind IN ('giving_checkout','registration') AND NOT (
  (OLD.kind='giving_checkout' AND EXISTS (
    SELECT 1 FROM identity_giving_checkout_continuations g WHERE g.intent_id=OLD.intent_id AND g.state=NEW.state))
  OR (OLD.kind='registration' AND EXISTS (
    SELECT 1 FROM identity_registration_continuations r WHERE r.intent_id=OLD.intent_id AND r.state=NEW.state))
)
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_terminal_invalid'); END;

-- 0034's generic receipt guard covered Team/Newcomer only.  Extend it for the
-- two module continuations without weakening the existing exact source/version
-- and linked-person checks.  Existing receipt append_only triggers remain in
-- force; this migration only replaces the guard predicate.
DROP TRIGGER identity_business_intent_ready_guard;
CREATE TRIGGER identity_business_intent_ready_guard
BEFORE UPDATE OF state,result_person_id ON identity_business_intents
WHEN NEW.state='ready' AND (NEW.result_person_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM identity_source_records s WHERE s.id=OLD.source_record_id AND s.campus_id=OLD.campus_id
    AND s.version=OLD.source_version AND s.source_digest=OLD.source_digest
    AND ((OLD.kind='team_application' AND s.state='linked' AND s.linked_person_id=NEW.result_person_id)
      OR (OLD.kind='giving_checkout' AND s.state='linked' AND s.linked_person_id=NEW.result_person_id AND EXISTS (
        SELECT 1 FROM identity_giving_checkout_continuations g WHERE g.intent_id=OLD.intent_id AND g.state='ready'))
      OR (OLD.kind='registration' AND s.state='linked' AND s.linked_person_id=NEW.result_person_id AND EXISTS (
        SELECT 1 FROM identity_registration_continuations r WHERE r.intent_id=OLD.intent_id AND r.state='ready'))
      OR (OLD.kind='newcomer_submission' AND s.state='unlinked' AND s.provisional_person_id=NEW.result_person_id))
))
BEGIN SELECT RAISE(ABORT,'identity_business_intent_ready_invalid'); END;

DROP TRIGGER identity_business_intent_receipt_guard;
CREATE TRIGGER identity_business_intent_receipt_guard
BEFORE INSERT ON identity_business_intent_receipts WHEN NOT EXISTS (
  SELECT 1 FROM identity_business_intents i JOIN identity_source_records s ON s.id=i.source_record_id
  WHERE i.intent_id=NEW.intent_id AND i.campus_id=NEW.campus_id AND i.state='ready'
    AND i.source_record_id=NEW.source_record_id AND i.source_version=NEW.source_version AND i.source_digest=NEW.source_digest
    AND s.version=i.source_version AND s.source_digest=i.source_digest AND i.result_person_id IS NEW.person_id
    AND ((i.kind='team_application' AND s.state='linked' AND s.linked_person_id=NEW.person_id AND EXISTS (
      SELECT 1 FROM identity_team_application_intents ti JOIN team_applications a ON a.team_id=ti.team_id AND a.person_id=NEW.person_id
      WHERE ti.intent_id=i.intent_id AND CAST(a.id AS TEXT)=NEW.business_record_key
    )) OR (i.kind='newcomer_submission' AND s.state='unlinked' AND s.provisional_person_id=NEW.person_id AND EXISTS (
      SELECT 1 FROM identity_newcomer_intents ni JOIN newcomer_submissions n
        ON n.id=ni.submission_id AND n.identity_source_record_id=s.id AND n.linked_person_id=NEW.person_id
      WHERE ni.intent_id=i.intent_id AND ni.submission_id=NEW.business_record_key
    )) OR (i.kind='giving_checkout' AND s.state='linked' AND s.linked_person_id=NEW.person_id AND EXISTS (
      SELECT 1 FROM identity_giving_checkout_continuations g
      WHERE g.intent_id=i.intent_id AND g.checkout_request_id=NEW.business_record_key AND g.state='attached' AND g.stripe_session_id IS NOT NULL
    )) OR (i.kind='registration' AND s.state='linked' AND s.linked_person_id=NEW.person_id AND EXISTS (
      SELECT 1 FROM identity_registration_continuations r
      WHERE r.intent_id=i.intent_id AND r.state='attached' AND CAST(r.registration_id AS TEXT)=NEW.business_record_key
    )))
)
BEGIN SELECT RAISE(ABORT,'identity_business_intent_receipt_invalid'); END;
