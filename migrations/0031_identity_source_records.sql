-- Identity source binding gateway. The separately managed stable source-key
-- HMAC configuration is pinned before the first source is stored. In-place key
-- rotation is deliberately rejected: a future migration must transactionally
-- rewrap every observation/source binding before changing this singleton.

CREATE TABLE identity_source_key_config (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id=1),
  key_id TEXT NOT NULL UNIQUE CHECK (
    length(key_id) BETWEEN 1 AND 32 AND key_id=lower(key_id)
    AND key_id NOT GLOB '*[^a-z0-9._-]*' AND substr(key_id,1,1) GLOB '[a-z0-9]'
  ),
  algorithm_version INTEGER NOT NULL CHECK (algorithm_version=1),
  verification_tag TEXT NOT NULL CHECK (
    length(verification_tag)=64 AND verification_tag=lower(verification_tag)
    AND verification_tag NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Domain records keep only this opaque key; observations retain normalized
-- contact hints while attachment requires a current session or exact proof.

CREATE TABLE identity_source_records (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  source TEXT NOT NULL CHECK (source IN ('giving','registration','group','team','newcomer','import','planning_center')),
  source_record_key TEXT NOT NULL CHECK (
    length(source_record_key)=64 AND source_record_key=lower(source_record_key)
    AND source_record_key NOT GLOB '*[^0-9a-f]*'
  ),
  source_key_id TEXT NOT NULL REFERENCES identity_source_key_config(key_id),
  observation_id INTEGER NOT NULL UNIQUE REFERENCES identity_observations(id),
  attachment_policy TEXT NOT NULL CHECK (attachment_policy IN ('signed_in_or_claim','observation_only','external_review')),
  linked_person_id INTEGER REFERENCES people(id),
  provisional_person_id INTEGER UNIQUE REFERENCES people(id),
  state TEXT NOT NULL DEFAULT 'unlinked' CHECK (state IN ('unlinked','linked','review')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  source_digest TEXT NOT NULL CHECK (length(source_digest)=64 AND source_digest=lower(source_digest) AND source_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campus_id,source,source_record_key),
  CHECK ((state='linked')=(linked_person_id IS NOT NULL)),
  CHECK (linked_person_id IS NULL OR linked_person_id<>provisional_person_id),
  CHECK ((source IN ('giving','registration','team') AND attachment_policy='signed_in_or_claim')
    OR (source IN ('group','newcomer','import') AND attachment_policy='observation_only')
    OR (source='planning_center' AND attachment_policy='external_review'))
);
CREATE INDEX idx_identity_source_records_queue ON identity_source_records(campus_id,state,source,created_at);
CREATE INDEX idx_identity_source_records_person ON identity_source_records(linked_person_id,source);

CREATE TRIGGER identity_source_key_config_immutable_update
BEFORE UPDATE ON identity_source_key_config
BEGIN SELECT RAISE(ABORT,'identity_source_key_config_immutable'); END;
CREATE TRIGGER identity_source_key_config_immutable_delete
BEFORE DELETE ON identity_source_key_config
BEGIN SELECT RAISE(ABORT,'identity_source_key_config_immutable'); END;

-- A source record wins one reservation before any provisional person is
-- created. The reservation and person/link/source writes are one atomic batch,
-- so a losing concurrent caller cannot leave an orphan person behind.
CREATE TABLE identity_source_provisional_operations (
  operation_id TEXT PRIMARY KEY CHECK (
    length(CAST(operation_id AS BLOB))=36 AND operation_id=lower(operation_id)
    AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-'
    AND substr(operation_id,19,1)='-' AND substr(operation_id,24,1)='-'
    AND length(replace(operation_id,'-',''))=32 AND operation_id NOT GLOB '*[^0-9a-f-]*'
  ),
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES identity_source_records(id),
  source_version INTEGER NOT NULL CHECK (source_version BETWEEN 1 AND 2147483647),
  source_digest TEXT NOT NULL CHECK (length(source_digest)=64 AND source_digest=lower(source_digest) AND source_digest NOT GLOB '*[^0-9a-f]*'),
  reserved_person_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE identity_source_provisional_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(CAST(receipt_id AS BLOB))=36 AND receipt_id=lower(receipt_id)
    AND substr(receipt_id,9,1)='-' AND substr(receipt_id,14,1)='-'
    AND substr(receipt_id,19,1)='-' AND substr(receipt_id,24,1)='-'
    AND length(replace(receipt_id,'-',''))=32 AND receipt_id NOT GLOB '*[^0-9a-f-]*'
  ),
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES identity_source_provisional_operations(operation_id),
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES identity_source_records(id),
  source_version INTEGER NOT NULL CHECK (source_version BETWEEN 1 AND 2147483647),
  source_digest TEXT NOT NULL CHECK (length(source_digest)=64 AND source_digest=lower(source_digest) AND source_digest NOT GLOB '*[^0-9a-f]*'),
  person_id INTEGER NOT NULL UNIQUE REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE identity_claim_operations (
  operation_id TEXT PRIMARY KEY CHECK (
    length(CAST(operation_id AS BLOB))=36 AND operation_id=lower(operation_id)
    AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-'
    AND substr(operation_id,19,1)='-' AND substr(operation_id,24,1)='-'
    AND length(replace(operation_id,'-',''))=32 AND operation_id NOT GLOB '*[^0-9a-f-]*'
  ),
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  source_record_id INTEGER NOT NULL REFERENCES identity_source_records(id),
  challenge_id INTEGER NOT NULL UNIQUE REFERENCES identity_challenges(id),
  expected_source_version INTEGER NOT NULL CHECK (expected_source_version BETWEEN 1 AND 2147483647),
  expected_source_digest TEXT NOT NULL CHECK (length(expected_source_digest)=64 AND expected_source_digest=lower(expected_source_digest) AND expected_source_digest NOT GLOB '*[^0-9a-f]*'),
  expected_contact_point_id INTEGER NOT NULL REFERENCES contact_points(id),
  expected_owner_person_id INTEGER REFERENCES people(id),
  expected_owner_generation INTEGER CHECK (expected_owner_generation IS NULL OR expected_owner_generation BETWEEN 0 AND 2147483647),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','review','completed','expired')),
  result_person_id INTEGER REFERENCES people(id),
  result_proof_kind TEXT CHECK (result_proof_kind IS NULL OR result_proof_kind IN ('claim_owner','clean_signup')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((expected_owner_person_id IS NULL)=(expected_owner_generation IS NULL)),
  CHECK ((state='completed')=(result_person_id IS NOT NULL)),
  CHECK ((result_person_id IS NULL)=(result_proof_kind IS NULL))
);
CREATE INDEX idx_identity_claim_operations_source_state ON identity_claim_operations(campus_id,source_record_id,state,created_at);

CREATE TABLE identity_source_attachment_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(CAST(receipt_id AS BLOB))=36 AND receipt_id=lower(receipt_id)
    AND substr(receipt_id,9,1)='-' AND substr(receipt_id,14,1)='-'
    AND substr(receipt_id,19,1)='-' AND substr(receipt_id,24,1)='-'
    AND length(replace(receipt_id,'-',''))=32 AND receipt_id NOT GLOB '*[^0-9a-f-]*'
  ),
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES identity_source_records(id),
  source_version INTEGER NOT NULL CHECK (source_version BETWEEN 1 AND 2147483647),
  source_digest TEXT NOT NULL CHECK (length(source_digest)=64 AND source_digest=lower(source_digest) AND source_digest NOT GLOB '*[^0-9a-f]*'),
  person_id INTEGER NOT NULL REFERENCES people(id),
  proof_kind TEXT NOT NULL CHECK (proof_kind IN ('signed_session','claim_owner','clean_signup')),
  claim_operation_id TEXT UNIQUE REFERENCES identity_claim_operations(operation_id),
  challenge_id INTEGER UNIQUE REFERENCES identity_challenges(id),
  contact_point_id INTEGER REFERENCES contact_points(id),
  signup_account_operation_id TEXT REFERENCES identity_account_operations(operation_id),
  session_epoch INTEGER CHECK (session_epoch IS NULL OR session_epoch BETWEEN 0 AND 2147483647),
  owner_generation INTEGER CHECK (owner_generation IS NULL OR owner_generation BETWEEN 0 AND 2147483647),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((proof_kind='signed_session' AND claim_operation_id IS NULL AND challenge_id IS NULL AND contact_point_id IS NULL
      AND signup_account_operation_id IS NULL AND session_epoch IS NOT NULL AND owner_generation IS NULL)
    OR (proof_kind='claim_owner' AND claim_operation_id IS NOT NULL AND challenge_id IS NOT NULL AND contact_point_id IS NOT NULL
      AND signup_account_operation_id IS NULL AND session_epoch IS NULL AND owner_generation IS NOT NULL)
    OR (proof_kind='clean_signup' AND claim_operation_id IS NOT NULL AND challenge_id IS NOT NULL AND contact_point_id IS NOT NULL
      AND signup_account_operation_id IS NOT NULL AND session_epoch IS NULL AND owner_generation IS NULL))
);
CREATE INDEX idx_identity_source_receipts_person ON identity_source_attachment_receipts(person_id,created_at);

CREATE TABLE identity_source_attachment_commits (
  commit_id TEXT PRIMARY KEY CHECK (
    length(CAST(commit_id AS BLOB))=36 AND commit_id=lower(commit_id)
    AND substr(commit_id,9,1)='-' AND substr(commit_id,14,1)='-'
    AND substr(commit_id,19,1)='-' AND substr(commit_id,24,1)='-'
    AND length(replace(commit_id,'-',''))=32 AND commit_id NOT GLOB '*[^0-9a-f-]*'
  ),
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES identity_source_attachment_receipts(receipt_id),
  source_record_id INTEGER NOT NULL UNIQUE REFERENCES identity_source_records(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER identity_source_records_insert_unlinked
BEFORE INSERT ON identity_source_records WHEN NEW.linked_person_id IS NOT NULL OR NEW.provisional_person_id IS NOT NULL
  OR NEW.state<>'unlinked' OR NOT EXISTS (
    SELECT 1 FROM identity_observations o WHERE o.id=NEW.observation_id AND o.campus_id=NEW.campus_id
      AND o.source=NEW.source AND o.source_key=NEW.source_record_key AND o.status='provisional' AND o.linked_person_id IS NULL
  )
  OR NOT EXISTS (
    SELECT 1 FROM identity_source_key_config k WHERE k.singleton_id=1 AND k.key_id=NEW.source_key_id
  )
BEGIN SELECT RAISE(ABORT,'identity_source_insert_invalid'); END;
CREATE TRIGGER identity_source_records_identity_immutable
BEFORE UPDATE OF campus_id,source,source_record_key,source_key_id,observation_id,attachment_policy ON identity_source_records
WHEN OLD.campus_id<>NEW.campus_id OR OLD.source<>NEW.source OR OLD.source_record_key<>NEW.source_record_key
  OR OLD.source_key_id<>NEW.source_key_id OR OLD.observation_id<>NEW.observation_id OR OLD.attachment_policy<>NEW.attachment_policy
BEGIN SELECT RAISE(ABORT,'identity_source_identity_immutable'); END;
CREATE TRIGGER identity_source_records_version_guard
BEFORE UPDATE OF version,source_digest ON identity_source_records
WHEN (NEW.version<>OLD.version OR NEW.source_digest<>OLD.source_digest) AND (
  OLD.state='linked' OR NEW.version<>OLD.version+1 OR NEW.source_digest=OLD.source_digest
  OR NEW.state<>'unlinked' OR NEW.linked_person_id IS NOT NULL OR OLD.provisional_person_id IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM identity_source_provisional_operations op
    WHERE op.source_record_id=OLD.id AND op.source_version=OLD.version AND op.source_digest=OLD.source_digest
  )
)
BEGIN SELECT RAISE(ABORT,'identity_source_version_conflict'); END;

CREATE TRIGGER identity_claim_operation_insert_guard
BEFORE INSERT ON identity_claim_operations WHEN
  NOT EXISTS (
    SELECT 1 FROM identity_source_records s JOIN identity_observations o ON o.id=s.observation_id
    JOIN contact_points cp ON cp.id=NEW.expected_contact_point_id
    WHERE s.id=NEW.source_record_id AND s.campus_id=NEW.campus_id AND s.attachment_policy='signed_in_or_claim'
      AND s.state='unlinked' AND s.version=NEW.expected_source_version AND s.source_digest=NEW.expected_source_digest
      AND cp.kind='email' AND cp.normalized_value=o.normalized_email
  )
  OR NOT EXISTS (
    SELECT 1 FROM identity_challenges c WHERE c.id=NEW.challenge_id AND c.campus_id=NEW.campus_id
      AND c.purpose='claim' AND c.contact_point_id=NEW.expected_contact_point_id
      AND c.consumed_at IS NULL AND c.superseded_at IS NULL AND c.expires_at>datetime('now')
      AND (NEW.expected_owner_person_id IS NULL OR c.person_id=NEW.expected_owner_person_id)
  )
  OR (
    NEW.expected_owner_person_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM verified_contact_owners v JOIN people p ON p.id=v.person_id
      JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=NEW.campus_id AND cm.active=1
      LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
      WHERE v.contact_point_id=NEW.expected_contact_point_id AND v.person_id=NEW.expected_owner_person_id
        AND NEW.expected_owner_generation=COALESCE((SELECT MAX(generation) FROM contact_owner_mutation_claims m WHERE m.contact_point_id=v.contact_point_id),0)
        AND (SELECT COUNT(*) FROM person_contact_links l WHERE l.contact_point_id=v.contact_point_id AND l.ended_at IS NULL)=1
        AND NOT EXISTS (SELECT 1 FROM household_contact_links h WHERE h.campus_id=NEW.campus_id AND h.contact_point_id=v.contact_point_id AND h.ended_at IS NULL)
        AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL
    )
  )
  OR (
    NEW.expected_owner_person_id IS NULL AND EXISTS (
      SELECT 1 FROM verified_contact_owners v JOIN people p ON p.id=v.person_id
      JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=NEW.campus_id AND cm.active=1
      LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
      WHERE v.contact_point_id=NEW.expected_contact_point_id
        AND (SELECT COUNT(*) FROM person_contact_links l WHERE l.contact_point_id=v.contact_point_id AND l.ended_at IS NULL)=1
        AND NOT EXISTS (SELECT 1 FROM household_contact_links h WHERE h.campus_id=NEW.campus_id AND h.contact_point_id=v.contact_point_id AND h.ended_at IS NULL)
        AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL
    )
  )
BEGIN SELECT RAISE(ABORT,'identity_claim_binding_invalid'); END;

CREATE TRIGGER identity_claim_operations_identity_immutable
BEFORE UPDATE OF campus_id,source_record_id,challenge_id,expected_source_version,expected_source_digest,expected_contact_point_id,expected_owner_person_id,expected_owner_generation,expires_at
ON identity_claim_operations
BEGIN SELECT RAISE(ABORT,'identity_claim_operation_immutable'); END;
CREATE TRIGGER identity_claim_operation_transition_guard
BEFORE UPDATE OF state ON identity_claim_operations
WHEN NEW.state<>OLD.state AND NOT (OLD.state='pending' AND NEW.state IN ('review','completed','expired'))
BEGIN SELECT RAISE(ABORT,'identity_claim_transition_invalid'); END;
CREATE TRIGGER identity_claim_operation_completion_guard
BEFORE UPDATE OF state ON identity_claim_operations
WHEN OLD.state='pending' AND NEW.state='completed' AND NOT EXISTS (
  SELECT 1 FROM identity_source_attachment_receipts r JOIN identity_source_attachment_commits c ON c.receipt_id=r.receipt_id
  WHERE r.claim_operation_id=OLD.operation_id AND r.person_id=NEW.result_person_id
    AND r.proof_kind=NEW.result_proof_kind AND c.source_record_id=OLD.source_record_id AND c.person_id=NEW.result_person_id
)
BEGIN SELECT RAISE(ABORT,'identity_claim_completion_invalid'); END;
CREATE TRIGGER identity_claim_operation_completed_immutable
BEFORE UPDATE ON identity_claim_operations
WHEN OLD.state='completed' AND (
  NEW.operation_id IS NOT OLD.operation_id OR NEW.campus_id IS NOT OLD.campus_id
  OR NEW.source_record_id IS NOT OLD.source_record_id OR NEW.challenge_id IS NOT OLD.challenge_id
  OR NEW.expected_source_version IS NOT OLD.expected_source_version OR NEW.expected_source_digest IS NOT OLD.expected_source_digest
  OR NEW.expected_contact_point_id IS NOT OLD.expected_contact_point_id
  OR NEW.expected_owner_person_id IS NOT OLD.expected_owner_person_id OR NEW.expected_owner_generation IS NOT OLD.expected_owner_generation
  OR NEW.state IS NOT OLD.state OR NEW.result_person_id IS NOT OLD.result_person_id
  OR NEW.result_proof_kind IS NOT OLD.result_proof_kind OR NEW.expires_at IS NOT OLD.expires_at
)
BEGIN SELECT RAISE(ABORT,'identity_claim_operation_completed_immutable'); END;

-- SQLite/D1 serializes writers. These guards make a consumed pending claim and
-- a new shared-contact mutation mutually exclusive at that serialization point.
CREATE TRIGGER identity_claim_person_contact_insert_guard
BEFORE INSERT ON person_contact_links
WHEN NEW.ended_at IS NULL AND EXISTS (
  SELECT 1 FROM identity_claim_operations op JOIN identity_challenges c ON c.id=op.challenge_id
  JOIN identity_source_records s ON s.id=op.source_record_id
  WHERE op.expected_contact_point_id=NEW.contact_point_id AND op.state='pending' AND op.expires_at>datetime('now')
    AND c.consumed_at IS NOT NULL AND c.superseded_at IS NULL AND c.ownership_consumed_at IS NULL
    AND s.state='unlinked' AND s.version=op.expected_source_version AND s.source_digest=op.expected_source_digest
)
BEGIN SELECT RAISE(ABORT,'identity_claim_contact_mutation_conflict'); END;
CREATE TRIGGER identity_claim_person_contact_reactivation_guard
BEFORE UPDATE OF ended_at ON person_contact_links
WHEN OLD.ended_at IS NOT NULL AND NEW.ended_at IS NULL AND EXISTS (
  SELECT 1 FROM identity_claim_operations op JOIN identity_challenges c ON c.id=op.challenge_id
  JOIN identity_source_records s ON s.id=op.source_record_id
  WHERE op.expected_contact_point_id=NEW.contact_point_id AND op.state='pending' AND op.expires_at>datetime('now')
    AND c.consumed_at IS NOT NULL AND c.superseded_at IS NULL AND c.ownership_consumed_at IS NULL
    AND s.state='unlinked' AND s.version=op.expected_source_version AND s.source_digest=op.expected_source_digest
)
BEGIN SELECT RAISE(ABORT,'identity_claim_contact_mutation_conflict'); END;
CREATE TRIGGER identity_claim_household_contact_insert_guard
BEFORE INSERT ON household_contact_links
WHEN NEW.ended_at IS NULL AND EXISTS (
  SELECT 1 FROM identity_claim_operations op JOIN identity_challenges c ON c.id=op.challenge_id
  JOIN identity_source_records s ON s.id=op.source_record_id
  WHERE op.campus_id=NEW.campus_id AND op.expected_contact_point_id=NEW.contact_point_id
    AND op.state='pending' AND op.expires_at>datetime('now')
    AND c.consumed_at IS NOT NULL AND c.superseded_at IS NULL AND c.ownership_consumed_at IS NULL
    AND s.state='unlinked' AND s.version=op.expected_source_version AND s.source_digest=op.expected_source_digest
)
BEGIN SELECT RAISE(ABORT,'identity_claim_contact_mutation_conflict'); END;
CREATE TRIGGER identity_claim_household_contact_reactivation_guard
BEFORE UPDATE OF ended_at ON household_contact_links
WHEN OLD.ended_at IS NOT NULL AND NEW.ended_at IS NULL AND EXISTS (
  SELECT 1 FROM identity_claim_operations op JOIN identity_challenges c ON c.id=op.challenge_id
  JOIN identity_source_records s ON s.id=op.source_record_id
  WHERE op.campus_id=NEW.campus_id AND op.expected_contact_point_id=NEW.contact_point_id
    AND op.state='pending' AND op.expires_at>datetime('now')
    AND c.consumed_at IS NOT NULL AND c.superseded_at IS NULL AND c.ownership_consumed_at IS NULL
    AND s.state='unlinked' AND s.version=op.expected_source_version AND s.source_digest=op.expected_source_digest
)
BEGIN SELECT RAISE(ABORT,'identity_claim_contact_mutation_conflict'); END;

CREATE TRIGGER identity_source_attachment_receipt_guard
BEFORE INSERT ON identity_source_attachment_receipts WHEN
  NOT EXISTS (
    SELECT 1 FROM identity_source_records s JOIN identity_observations o ON o.id=s.observation_id
    JOIN people p ON p.id=NEW.person_id
    JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=NEW.campus_id AND cm.active=1
    LEFT JOIN person_merge_redirects redirect ON redirect.loser_person_id=p.id
    WHERE s.id=NEW.source_record_id AND s.campus_id=NEW.campus_id AND s.state='unlinked'
      AND s.version=NEW.source_version AND s.source_digest=NEW.source_digest
      AND s.provisional_person_id IS NULL
      AND o.status='provisional' AND o.linked_person_id IS NULL
      AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
      AND redirect.loser_person_id IS NULL
  )
  OR (NEW.proof_kind='signed_session' AND NOT EXISTS (
    SELECT 1 FROM identity_source_records s JOIN people p ON p.id=NEW.person_id
    WHERE s.id=NEW.source_record_id AND s.attachment_policy='signed_in_or_claim' AND p.session_epoch=NEW.session_epoch
  ))
  OR (NEW.proof_kind='claim_owner' AND NOT EXISTS (
    SELECT 1 FROM identity_claim_operations op JOIN identity_challenges c ON c.id=op.challenge_id
    JOIN verified_contact_owners v ON v.contact_point_id=op.expected_contact_point_id AND v.person_id=NEW.person_id
    WHERE op.operation_id=NEW.claim_operation_id AND op.campus_id=NEW.campus_id AND op.source_record_id=NEW.source_record_id
      AND NEW.contact_point_id=op.expected_contact_point_id
      AND op.state='pending' AND op.expected_source_version=NEW.source_version AND op.expected_source_digest=NEW.source_digest
      AND op.expires_at>datetime('now')
      AND op.expected_owner_person_id=NEW.person_id AND op.expected_owner_generation=NEW.owner_generation
      AND NEW.owner_generation=COALESCE((SELECT MAX(generation) FROM contact_owner_mutation_claims m WHERE m.contact_point_id=v.contact_point_id),0)
      AND c.id=NEW.challenge_id AND c.purpose='claim' AND c.contact_point_id=op.expected_contact_point_id
      AND c.consumed_at IS NOT NULL AND c.superseded_at IS NULL AND c.ownership_consumed_at IS NULL
      AND (SELECT COUNT(*) FROM person_contact_links l WHERE l.contact_point_id=v.contact_point_id AND l.ended_at IS NULL)=1
      AND NOT EXISTS (SELECT 1 FROM household_contact_links h WHERE h.campus_id=NEW.campus_id AND h.contact_point_id=v.contact_point_id AND h.ended_at IS NULL)
  ))
  OR (NEW.proof_kind='clean_signup' AND NOT EXISTS (
    SELECT 1 FROM identity_claim_operations op JOIN identity_challenges c ON c.id=op.challenge_id
    JOIN identity_account_operations signup ON signup.operation_id=NEW.signup_account_operation_id
    JOIN identity_challenges signup_challenge ON signup_challenge.id=signup.challenge_id
    JOIN identity_account_proof_uses proof ON proof.operation_id=signup.operation_id AND proof.challenge_id=signup.challenge_id
    JOIN verified_contact_owners v ON v.contact_point_id=op.expected_contact_point_id AND v.person_id=NEW.person_id
    WHERE op.operation_id=NEW.claim_operation_id AND op.campus_id=NEW.campus_id AND op.source_record_id=NEW.source_record_id
      AND NEW.contact_point_id=op.expected_contact_point_id
      AND op.state='pending' AND op.expected_owner_person_id IS NULL
      AND op.expires_at>datetime('now')
      AND op.expected_source_version=NEW.source_version AND op.expected_source_digest=NEW.source_digest
      AND c.id=NEW.challenge_id AND c.purpose='claim' AND c.contact_point_id=op.expected_contact_point_id
      AND c.consumed_at IS NOT NULL AND c.superseded_at IS NULL AND c.ownership_consumed_at IS NULL
      AND signup.campus_id=NEW.campus_id AND signup.kind='signup' AND signup.state='completed'
      AND signup.result_person_id=NEW.person_id AND signup.reserved_person_id=NEW.person_id
      AND signup_challenge.contact_point_id=op.expected_contact_point_id AND signup_challenge.consumed_at IS NOT NULL
      AND proof.proof_category='signup_create' AND proof.person_id=NEW.person_id
      AND (SELECT COUNT(*) FROM person_contact_links l WHERE l.contact_point_id=v.contact_point_id AND l.ended_at IS NULL)=1
      AND NOT EXISTS (SELECT 1 FROM household_contact_links h WHERE h.campus_id=NEW.campus_id AND h.contact_point_id=v.contact_point_id AND h.ended_at IS NULL)
  ))
BEGIN SELECT RAISE(ABORT,'identity_source_attachment_proof_invalid'); END;

CREATE TRIGGER identity_source_records_attachment_guard
BEFORE UPDATE OF linked_person_id ON identity_source_records
WHEN OLD.linked_person_id IS NULL AND NEW.linked_person_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM identity_source_attachment_receipts r WHERE r.source_record_id=OLD.id
    AND r.source_version=OLD.version AND r.source_digest=OLD.source_digest AND r.person_id=NEW.linked_person_id
)
BEGIN SELECT RAISE(ABORT,'identity_source_direct_attachment_forbidden'); END;
CREATE TRIGGER identity_source_records_link_immutable
BEFORE UPDATE OF linked_person_id,state ON identity_source_records
WHEN OLD.linked_person_id IS NOT NULL AND (
  NEW.linked_person_id IS NOT OLD.linked_person_id OR NEW.state IS NOT OLD.state
)
BEGIN SELECT RAISE(ABORT,'identity_source_attachment_immutable'); END;

-- This is the final statement-level commit assertion for both signed and claim
-- attachment batches. If the exact source CAS updated zero rows, linking the
-- observation aborts and rolls the receipt/audit/operation transaction back.
CREATE TRIGGER identity_source_observation_attachment_guard
BEFORE UPDATE OF status,linked_person_id ON identity_observations
WHEN NEW.status='linked' AND EXISTS (SELECT 1 FROM identity_source_records x WHERE x.observation_id=OLD.id)
  AND NOT EXISTS (
    SELECT 1 FROM identity_source_records s JOIN identity_source_attachment_receipts r ON r.source_record_id=s.id
    WHERE s.observation_id=OLD.id AND s.state='linked' AND s.linked_person_id=NEW.linked_person_id
      AND r.person_id=NEW.linked_person_id AND r.source_version=s.version AND r.source_digest=s.source_digest
  )
BEGIN SELECT RAISE(ABORT,'identity_source_attachment_commit_invalid'); END;

CREATE TRIGGER identity_source_observation_link_immutable
BEFORE UPDATE OF status,linked_person_id ON identity_observations
WHEN EXISTS (
  SELECT 1 FROM identity_source_records s JOIN identity_source_attachment_receipts r ON r.source_record_id=s.id
  WHERE s.observation_id=OLD.id AND s.state='linked' AND s.linked_person_id=r.person_id
) AND NOT EXISTS (
  SELECT 1 FROM identity_source_records s WHERE s.observation_id=OLD.id AND s.state='linked'
    AND NEW.status='linked' AND NEW.linked_person_id IS s.linked_person_id
)
BEGIN SELECT RAISE(ABORT,'identity_source_observation_immutable'); END;

CREATE TRIGGER identity_source_attachment_commit_guard
BEFORE INSERT ON identity_source_attachment_commits
WHEN NOT EXISTS (
  SELECT 1 FROM identity_source_attachment_receipts r JOIN identity_source_records s ON s.id=r.source_record_id
  JOIN identity_observations o ON o.id=s.observation_id
  WHERE r.receipt_id=NEW.receipt_id AND r.campus_id=NEW.campus_id AND r.source_record_id=NEW.source_record_id
    AND r.person_id=NEW.person_id AND s.campus_id=NEW.campus_id AND s.state='linked' AND s.linked_person_id=NEW.person_id
    AND s.version=r.source_version AND s.source_digest=r.source_digest
    AND o.status='linked' AND o.linked_person_id=NEW.person_id
)
BEGIN SELECT RAISE(ABORT,'identity_source_attachment_commit_invalid'); END;

CREATE TRIGGER identity_source_provisional_operation_insert_guard
BEFORE INSERT ON identity_source_provisional_operations
WHEN NOT EXISTS (
  SELECT 1 FROM identity_source_records s JOIN identity_observations o ON o.id=s.observation_id
  WHERE s.id=NEW.source_record_id AND s.campus_id=NEW.campus_id AND s.source IN ('group','newcomer','import')
    AND s.attachment_policy='observation_only' AND s.state='unlinked' AND s.linked_person_id IS NULL
    AND s.provisional_person_id IS NULL AND s.version=NEW.source_version AND s.source_digest=NEW.source_digest
    AND o.status='provisional' AND o.linked_person_id IS NULL
) OR EXISTS (SELECT 1 FROM people p WHERE p.id=NEW.reserved_person_id)
BEGIN SELECT RAISE(ABORT,'identity_source_provisional_reservation_invalid'); END;

CREATE TRIGGER identity_source_provisional_guard
BEFORE UPDATE OF provisional_person_id ON identity_source_records
WHEN COALESCE(OLD.provisional_person_id,0)<>COALESCE(NEW.provisional_person_id,0) AND (
  OLD.provisional_person_id IS NOT NULL OR NEW.provisional_person_id IS NULL OR NEW.linked_person_id IS NOT NULL
  OR NEW.state<>'unlinked' OR NEW.source NOT IN ('group','newcomer','import') OR NEW.attachment_policy<>'observation_only'
  OR NOT EXISTS (
    SELECT 1 FROM identity_source_provisional_operations op WHERE op.source_record_id=NEW.id
      AND op.campus_id=NEW.campus_id AND op.source_version=NEW.version AND op.source_digest=NEW.source_digest
      AND op.reserved_person_id=NEW.provisional_person_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM people p WHERE p.id=NEW.provisional_person_id AND p.active=0 AND p.deleted_at IS NULL
      AND p.identity_state='provisional' AND p.auth_disabled_at IS NOT NULL AND p.provisional_source=NEW.source
  )
  OR NOT EXISTS (
    SELECT 1 FROM person_contact_links l JOIN contact_points cp ON cp.id=l.contact_point_id
    JOIN identity_observations o ON o.id=NEW.observation_id
    WHERE l.person_id=NEW.provisional_person_id AND l.ended_at IS NULL AND l.notification_enabled=1
      AND ((cp.kind='email' AND cp.normalized_value=o.normalized_email) OR (cp.kind='phone' AND cp.normalized_value=o.normalized_phone))
  )
  OR EXISTS (
    SELECT 1 FROM person_contact_links l JOIN verified_contact_owners v ON v.contact_point_id=l.contact_point_id
    WHERE l.person_id=NEW.provisional_person_id AND l.ended_at IS NULL
  )
  OR EXISTS (
    SELECT 1 FROM person_contact_links candidate JOIN person_contact_links existing
      ON existing.contact_point_id=candidate.contact_point_id
    WHERE candidate.person_id=NEW.provisional_person_id AND candidate.ended_at IS NULL
      AND existing.person_id<>NEW.provisional_person_id AND existing.ended_at IS NULL
  )
  OR EXISTS (
    SELECT 1 FROM person_contact_links candidate JOIN household_contact_links household
      ON household.contact_point_id=candidate.contact_point_id
    WHERE candidate.person_id=NEW.provisional_person_id AND candidate.ended_at IS NULL
      AND household.ended_at IS NULL
  )
)
BEGIN SELECT RAISE(ABORT,'identity_source_provisional_invalid'); END;

CREATE TRIGGER identity_source_provisional_receipt_guard
BEFORE INSERT ON identity_source_provisional_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM identity_source_provisional_operations op JOIN identity_source_records s ON s.id=op.source_record_id
  JOIN people p ON p.id=op.reserved_person_id
  WHERE op.operation_id=NEW.operation_id AND op.campus_id=NEW.campus_id AND op.source_record_id=NEW.source_record_id
    AND op.source_version=NEW.source_version AND op.source_digest=NEW.source_digest AND op.reserved_person_id=NEW.person_id
    AND s.campus_id=NEW.campus_id AND s.provisional_person_id=NEW.person_id AND s.state='unlinked'
    AND s.version=NEW.source_version AND s.source_digest=NEW.source_digest
    AND p.active=0 AND p.deleted_at IS NULL AND p.identity_state='provisional' AND p.auth_disabled_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT,'identity_source_provisional_commit_invalid'); END;

CREATE TRIGGER identity_source_provisional_operations_append_only_update
BEFORE UPDATE ON identity_source_provisional_operations BEGIN SELECT RAISE(ABORT,'identity_source_provisional_operations_append_only'); END;
CREATE TRIGGER identity_source_provisional_operations_append_only_delete
BEFORE DELETE ON identity_source_provisional_operations BEGIN SELECT RAISE(ABORT,'identity_source_provisional_operations_append_only'); END;
CREATE TRIGGER identity_source_provisional_receipts_append_only_update
BEFORE UPDATE ON identity_source_provisional_receipts BEGIN SELECT RAISE(ABORT,'identity_source_provisional_receipts_append_only'); END;
CREATE TRIGGER identity_source_provisional_receipts_append_only_delete
BEFORE DELETE ON identity_source_provisional_receipts BEGIN SELECT RAISE(ABORT,'identity_source_provisional_receipts_append_only'); END;

CREATE TRIGGER identity_source_attachment_receipts_append_only_update
BEFORE UPDATE ON identity_source_attachment_receipts BEGIN SELECT RAISE(ABORT,'identity_source_attachment_receipts_append_only'); END;
CREATE TRIGGER identity_source_attachment_receipts_append_only_delete
BEFORE DELETE ON identity_source_attachment_receipts BEGIN SELECT RAISE(ABORT,'identity_source_attachment_receipts_append_only'); END;
CREATE TRIGGER identity_source_attachment_commits_append_only_update
BEFORE UPDATE ON identity_source_attachment_commits BEGIN SELECT RAISE(ABORT,'identity_source_attachment_commits_append_only'); END;
CREATE TRIGGER identity_source_attachment_commits_append_only_delete
BEFORE DELETE ON identity_source_attachment_commits BEGIN SELECT RAISE(ABORT,'identity_source_attachment_commits_append_only'); END;
