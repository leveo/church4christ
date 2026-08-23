-- Member identity foundation. This is additive: people.email remains the legacy
-- login key while canonical contacts and resolution evidence are introduced.

ALTER TABLE people ADD COLUMN identity_state TEXT NOT NULL DEFAULT 'active'
  CHECK (identity_state IN ('provisional', 'active', 'merged'));
ALTER TABLE people ADD COLUMN identity_version INTEGER NOT NULL DEFAULT 1
  CHECK (identity_version >= 1 AND identity_version <= 2147483647);
ALTER TABLE people ADD COLUMN merged_into_person_id INTEGER REFERENCES people(id);
ALTER TABLE people ADD COLUMN auth_disabled_at TEXT;
ALTER TABLE people ADD COLUMN provisional_source TEXT CHECK (provisional_source IS NULL OR length(provisional_source) BETWEEN 1 AND 64);

CREATE TABLE contact_points (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone')),
  normalized_value TEXT NOT NULL CHECK (length(normalized_value) BETWEEN 3 AND 254 AND instr(normalized_value, char(0)) = 0 AND normalized_value NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
  display_value TEXT NOT NULL CHECK (length(display_value) BETWEEN 1 AND 512 AND instr(display_value, char(0)) = 0 AND display_value NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, normalized_value),
  UNIQUE (id, kind)
);
CREATE INDEX idx_contact_points_kind_value ON contact_points (kind, normalized_value);

CREATE TABLE person_contact_links (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  contact_point_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 64),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  notification_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notification_enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  FOREIGN KEY (contact_point_id, kind) REFERENCES contact_points(id, kind)
);
CREATE UNIQUE INDEX idx_person_contact_links_active_pair
  ON person_contact_links (person_id, contact_point_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX idx_person_contact_links_active_primary_kind
  ON person_contact_links (person_id, kind) WHERE ended_at IS NULL AND is_primary = 1;
CREATE INDEX idx_person_contact_links_contact_active
  ON person_contact_links (contact_point_id, ended_at, person_id);

CREATE TABLE household_contact_links (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  household_id INTEGER NOT NULL REFERENCES households(id),
  contact_point_id INTEGER NOT NULL REFERENCES contact_points(id),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 64),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  notification_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notification_enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE UNIQUE INDEX idx_household_contact_links_active_pair
  ON household_contact_links (campus_id, household_id, contact_point_id) WHERE ended_at IS NULL;
CREATE INDEX idx_household_contact_links_campus_contact
  ON household_contact_links (campus_id, contact_point_id, ended_at);

-- Service code must ensure that the owner retains an active corresponding link;
-- that relationship cannot be expressed as a cross-table CHECK in SQLite.
CREATE TABLE verified_contact_owners (
  contact_point_id INTEGER PRIMARY KEY REFERENCES contact_points(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  verification_method TEXT NOT NULL CHECK (verification_method IN ('legacy_unique', 'email_link', 'sms_code', 'admin_review', 'external_provider')),
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  challenge_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_verified_contact_owners_person ON verified_contact_owners (person_id, verified_at);

-- Every application ownership mutation first claims the next generation. The
-- unique generation plus the current-owner guard turns a stale read into a
-- transaction-aborting constraint error, including inside a D1 batch.
CREATE TABLE contact_owner_mutation_claims (
  id INTEGER PRIMARY KEY,
  contact_point_id INTEGER NOT NULL REFERENCES contact_points(id),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 2147483647),
  expected_person_id INTEGER REFERENCES people(id),
  resulting_person_id INTEGER REFERENCES people(id),
  operation TEXT NOT NULL CHECK (operation IN ('assign', 'transfer', 'revoke')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (contact_point_id, generation),
  CHECK (COALESCE(expected_person_id, 0) <> COALESCE(resulting_person_id, 0))
);
CREATE INDEX idx_contact_owner_mutation_claims_contact_created
  ON contact_owner_mutation_claims (contact_point_id, created_at);
CREATE TRIGGER contact_owner_mutation_claim_guard
BEFORE INSERT ON contact_owner_mutation_claims
WHEN NEW.generation <> COALESCE((SELECT MAX(generation) FROM contact_owner_mutation_claims WHERE contact_point_id=NEW.contact_point_id),0)+1
  OR COALESCE((SELECT person_id FROM verified_contact_owners WHERE contact_point_id=NEW.contact_point_id),0) <> COALESCE(NEW.expected_person_id,0)
BEGIN SELECT RAISE(ABORT, 'contact_owner_mutation_conflict'); END;
CREATE TRIGGER contact_owner_mutation_claims_append_only_update BEFORE UPDATE ON contact_owner_mutation_claims BEGIN SELECT RAISE(ABORT, 'contact_owner_mutation_claims_append_only'); END;
CREATE TRIGGER contact_owner_mutation_claims_append_only_delete BEFORE DELETE ON contact_owner_mutation_claims BEGIN SELECT RAISE(ABORT, 'contact_owner_mutation_claims_append_only'); END;

CREATE TRIGGER verified_contact_owner_requires_active_link_insert
BEFORE INSERT ON verified_contact_owners
WHEN NOT EXISTS (
  SELECT 1 FROM person_contact_links
  WHERE person_id = NEW.person_id AND contact_point_id = NEW.contact_point_id AND ended_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'verified_contact_owner_requires_active_link');
END;
CREATE TRIGGER verified_contact_owner_requires_active_link_update
BEFORE UPDATE OF person_id, contact_point_id ON verified_contact_owners
WHEN NOT EXISTS (
  SELECT 1 FROM person_contact_links
  WHERE person_id = NEW.person_id AND contact_point_id = NEW.contact_point_id AND ended_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'verified_contact_owner_requires_active_link');
END;
CREATE TRIGGER person_contact_link_owner_cannot_end
BEFORE UPDATE OF ended_at ON person_contact_links
WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM verified_contact_owners
  WHERE person_id = OLD.person_id AND contact_point_id = OLD.contact_point_id
)
BEGIN
  SELECT RAISE(ABORT, 'verified_contact_owner_requires_active_link');
END;
CREATE TRIGGER person_contact_link_owner_cannot_delete
BEFORE DELETE ON person_contact_links
WHEN OLD.ended_at IS NULL AND EXISTS (
  SELECT 1 FROM verified_contact_owners
  WHERE person_id = OLD.person_id AND contact_point_id = OLD.contact_point_id
)
BEGIN
  SELECT RAISE(ABORT, 'verified_contact_owner_requires_active_link');
END;
CREATE TRIGGER person_contact_link_identity_immutable
BEFORE UPDATE OF person_id, contact_point_id ON person_contact_links
WHEN OLD.person_id <> NEW.person_id OR OLD.contact_point_id <> NEW.contact_point_id
BEGIN
  SELECT RAISE(ABORT, 'person_contact_link_identity_immutable');
END;

CREATE TABLE contact_ownership_events (
  id INTEGER PRIMARY KEY,
  contact_point_id INTEGER NOT NULL REFERENCES contact_points(id),
  person_id INTEGER REFERENCES people(id),
  previous_person_id INTEGER REFERENCES people(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('verified', 'transferred', 'revoked', 'legacy_backfill')),
  actor_person_id INTEGER REFERENCES people(id),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contact_ownership_events_contact_created ON contact_ownership_events (contact_point_id, created_at);

CREATE TABLE identity_challenges (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE CHECK (
    instr(public_id,char(0)) = 0 AND length(CAST(public_id AS BLOB)) = 36 AND public_id = lower(public_id) AND
    substr(public_id,9,1) = '-' AND substr(public_id,14,1) = '-' AND
    substr(public_id,19,1) = '-' AND substr(public_id,24,1) = '-' AND
    length(replace(public_id,'-','')) = 32 AND public_id NOT GLOB '*[^0-9a-f-]*'
  ),
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'signup', 'claim', 'contact_change', 'recovery', 'step_up')),
  request_source TEXT NOT NULL DEFAULT 'web' CHECK (request_source IN ('web', 'mobile_web', 'kiosk', 'admin', 'provider')),
  person_id INTEGER REFERENCES people(id),
  contact_point_id INTEGER REFERENCES contact_points(id),
  token_hash TEXT CHECK (token_hash IS NULL OR length(token_hash) BETWEEN 32 AND 256),
  code_hash TEXT CHECK (code_hash IS NULL OR length(code_hash) BETWEEN 32 AND 256),
  requester_bucket_hash TEXT NOT NULL CHECK (length(requester_bucket_hash) BETWEEN 32 AND 256),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  ownership_consumed_at TEXT,
  superseded_at TEXT,
  context_json TEXT NOT NULL DEFAULT '{}' CHECK (instr(context_json, char(0)) = 0 AND length(CAST(context_json AS BLOB)) <= 4096 AND json_valid(context_json) AND json_type(context_json) = 'object'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((token_hash IS NOT NULL) != (code_hash IS NOT NULL)),
  CHECK (attempts <= max_attempts)
);
CREATE INDEX idx_identity_challenges_bucket_expiry
  ON identity_challenges (campus_id, requester_bucket_hash, expires_at);
CREATE INDEX idx_identity_challenges_person_expiry
  ON identity_challenges (campus_id, person_id, expires_at);
CREATE TRIGGER identity_step_up_consumption_guard
BEFORE UPDATE OF consumed_at ON identity_challenges
WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND OLD.purpose='step_up' AND NOT EXISTS (
  SELECT 1 FROM verified_contact_owners o
  JOIN person_contact_links l ON l.person_id=o.person_id AND l.contact_point_id=o.contact_point_id AND l.ended_at IS NULL
  JOIN people p ON p.id=o.person_id
  JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=OLD.campus_id AND cm.active=1
  LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
  WHERE o.contact_point_id=OLD.contact_point_id AND o.person_id=OLD.person_id
    AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL
)
BEGIN SELECT RAISE(ABORT, 'identity_step_up_target_invalid'); END;
CREATE TABLE identity_challenge_proof_uses (
  challenge_id INTEGER PRIMARY KEY REFERENCES identity_challenges(id),
  contact_point_id INTEGER NOT NULL REFERENCES contact_points(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('claim', 'contact_change')),
  proof_category TEXT NOT NULL CHECK (proof_category IN ('email_challenge')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER identity_challenge_claim_proof_guard
BEFORE INSERT ON identity_challenge_proof_uses
WHEN NEW.purpose='claim' AND (
  NOT EXISTS (SELECT 1 FROM identity_challenges c WHERE c.id=NEW.challenge_id AND c.contact_point_id=NEW.contact_point_id AND c.person_id=NEW.person_id AND c.purpose='claim' AND c.consumed_at IS NOT NULL AND c.superseded_at IS NULL AND c.ownership_consumed_at IS NULL)
  OR EXISTS (SELECT 1 FROM verified_contact_owners o WHERE o.contact_point_id=NEW.contact_point_id)
  OR (SELECT COUNT(*) FROM person_contact_links l WHERE l.contact_point_id=NEW.contact_point_id AND l.ended_at IS NULL)<>1
  OR NOT EXISTS (SELECT 1 FROM person_contact_links l JOIN people p ON p.id=l.person_id LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id WHERE l.contact_point_id=NEW.contact_point_id AND l.person_id=NEW.person_id AND l.ended_at IS NULL AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL)
  OR EXISTS (SELECT 1 FROM household_contact_links h JOIN identity_challenges c ON c.id=NEW.challenge_id WHERE h.campus_id=c.campus_id AND h.contact_point_id=NEW.contact_point_id AND h.ended_at IS NULL)
)
BEGIN SELECT RAISE(ABORT, 'identity_owner_review_required'); END;
CREATE TRIGGER identity_challenge_proof_uses_append_only_update BEFORE UPDATE ON identity_challenge_proof_uses BEGIN SELECT RAISE(ABORT, 'identity_challenge_proof_uses_append_only'); END;
CREATE TRIGGER identity_challenge_proof_uses_append_only_delete BEFORE DELETE ON identity_challenge_proof_uses BEGIN SELECT RAISE(ABORT, 'identity_challenge_proof_uses_append_only'); END;

CREATE TABLE identity_rate_limits (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  bucket_hash TEXT NOT NULL CHECK (length(bucket_hash) BETWEEN 32 AND 256),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  window_started_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count BETWEEN 0 AND 1000000),
  expires_at TEXT NOT NULL,
  UNIQUE (campus_id, bucket_hash, scope, window_started_at)
);
CREATE INDEX idx_identity_rate_limits_expiry ON identity_rate_limits (campus_id, expires_at);

CREATE TABLE identity_otp_failure_claims (
  claim_id TEXT PRIMARY KEY CHECK (
    length(CAST(claim_id AS BLOB))=36 AND claim_id=lower(claim_id) AND
    substr(claim_id,9,1)='-' AND substr(claim_id,14,1)='-' AND substr(claim_id,19,1)='-' AND substr(claim_id,24,1)='-' AND
    length(replace(claim_id,'-',''))=32 AND claim_id NOT GLOB '*[^0-9a-f-]*'
  ),
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  bucket_hash TEXT NOT NULL CHECK (length(bucket_hash) BETWEEN 32 AND 256),
  window_started_at TEXT NOT NULL,
  challenge_id INTEGER NOT NULL REFERENCES identity_challenges(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_identity_otp_failure_budget
  ON identity_otp_failure_claims(campus_id,bucket_hash,window_started_at);
CREATE TRIGGER identity_otp_failure_budget_guard
BEFORE INSERT ON identity_otp_failure_claims
WHEN (SELECT count(*) FROM identity_otp_failure_claims
  WHERE campus_id=NEW.campus_id AND bucket_hash=NEW.bucket_hash AND window_started_at=NEW.window_started_at)>=5
BEGIN SELECT RAISE(ABORT, 'identity_otp_failure_budget_exhausted'); END;
CREATE TRIGGER identity_otp_acceptance_budget_guard
BEFORE UPDATE OF consumed_at ON identity_challenges
WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND OLD.code_hash IS NOT NULL AND
  (SELECT count(*) FROM identity_otp_failure_claims WHERE campus_id=OLD.campus_id AND bucket_hash=OLD.requester_bucket_hash
    AND window_started_at<=NEW.consumed_at AND datetime(window_started_at,'+15 minutes')>NEW.consumed_at)>=5
BEGIN SELECT RAISE(ABORT, 'identity_otp_failure_budget_exhausted'); END;

CREATE TABLE identity_observations (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  source TEXT NOT NULL CHECK (source IN ('signup', 'giving', 'registration', 'group', 'team', 'newcomer', 'import', 'planning_center')),
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 255 AND instr(source_key, char(0)) = 0 AND source_key NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
  normalized_email TEXT CHECK (normalized_email IS NULL OR (length(normalized_email) BETWEEN 3 AND 254 AND instr(normalized_email, char(0)) = 0 AND normalized_email NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*'))),
  normalized_phone TEXT CHECK (normalized_phone IS NULL OR (length(normalized_phone) BETWEEN 8 AND 16 AND instr(normalized_phone, char(0)) = 0 AND normalized_phone NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*'))),
  normalized_name TEXT CHECK (normalized_name IS NULL OR (length(normalized_name) BETWEEN 1 AND 512 AND instr(normalized_name, char(0)) = 0 AND normalized_name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*'))),
  status TEXT NOT NULL DEFAULT 'provisional' CHECK (status IN ('provisional', 'linked', 'review', 'dismissed')),
  linked_person_id INTEGER REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campus_id, source, source_key)
);
CREATE INDEX idx_identity_observations_campus_status ON identity_observations (campus_id, status, created_at);
CREATE INDEX idx_identity_observations_contacts ON identity_observations (campus_id, normalized_email, normalized_phone);

CREATE TABLE identity_resolution_cases (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  observation_id INTEGER REFERENCES identity_observations(id),
  candidate_person_id INTEGER REFERENCES people(id),
  person_a_id INTEGER REFERENCES people(id),
  person_b_id INTEGER REFERENCES people(id),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (instr(evidence_json, char(0)) = 0 AND length(CAST(evidence_json AS BLOB)) <= 8192 AND json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'same_person', 'different_people', 'merged', 'dismissed')),
  risk TEXT NOT NULL DEFAULT 'normal' CHECK (risk IN ('low', 'normal', 'high')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  reviewer_person_id INTEGER REFERENCES people(id),
  resolution TEXT CHECK (resolution IS NULL OR length(resolution) BETWEEN 1 AND 1024),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  CHECK ((person_a_id IS NOT NULL AND person_b_id IS NOT NULL AND observation_id IS NULL AND candidate_person_id IS NULL AND person_a_id < person_b_id)
      OR (observation_id IS NOT NULL AND candidate_person_id IS NOT NULL AND person_a_id IS NULL AND person_b_id IS NULL))
);
CREATE UNIQUE INDEX idx_identity_resolution_cases_person_pair
  ON identity_resolution_cases (campus_id, person_a_id, person_b_id) WHERE state = 'open';
CREATE UNIQUE INDEX idx_identity_resolution_cases_observation
  ON identity_resolution_cases (campus_id, observation_id, candidate_person_id) WHERE state = 'open';
CREATE INDEX idx_identity_resolution_cases_queue
  ON identity_resolution_cases (campus_id, state, risk, score DESC);

CREATE TABLE person_merge_redirects (
  loser_person_id INTEGER PRIMARY KEY REFERENCES people(id),
  canonical_person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (loser_person_id != canonical_person_id)
);
CREATE INDEX idx_person_merge_redirects_canonical ON person_merge_redirects (canonical_person_id);
CREATE TRIGGER person_merge_redirects_one_hop_insert
BEFORE INSERT ON person_merge_redirects
WHEN EXISTS (SELECT 1 FROM person_merge_redirects WHERE loser_person_id = NEW.canonical_person_id)
  OR EXISTS (SELECT 1 FROM person_merge_redirects WHERE canonical_person_id = NEW.loser_person_id)
BEGIN
  SELECT RAISE(ABORT, 'person_merge_redirect_one_hop_required');
END;
CREATE TRIGGER person_merge_redirects_one_hop_update
BEFORE UPDATE OF loser_person_id, canonical_person_id ON person_merge_redirects
WHEN EXISTS (SELECT 1 FROM person_merge_redirects WHERE loser_person_id = NEW.canonical_person_id AND loser_person_id <> NEW.loser_person_id)
  OR EXISTS (SELECT 1 FROM person_merge_redirects WHERE canonical_person_id = NEW.loser_person_id AND loser_person_id <> NEW.loser_person_id)
BEGIN
  SELECT RAISE(ABORT, 'person_merge_redirect_one_hop_required');
END;

CREATE TABLE person_merge_events (
  id INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE CHECK (length(operation_id) BETWEEN 16 AND 128),
  loser_person_id INTEGER NOT NULL REFERENCES people(id),
  canonical_person_id INTEGER NOT NULL REFERENCES people(id),
  preview_hash TEXT NOT NULL CHECK (length(preview_hash) BETWEEN 32 AND 256),
  counts_json TEXT NOT NULL CHECK (instr(counts_json, char(0)) = 0 AND length(CAST(counts_json AS BLOB)) BETWEEN 2 AND 8192 AND json_valid(counts_json) AND json_type(counts_json) = 'object'),
  requested_by_person_id INTEGER REFERENCES people(id),
  approved_by_person_id INTEGER REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (loser_person_id != canonical_person_id)
);
CREATE INDEX idx_person_merge_events_people_created ON person_merge_events (canonical_person_id, loser_person_id, created_at);

CREATE TABLE identity_recovery_cases (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  person_id INTEGER REFERENCES people(id),
  contact_point_id INTEGER REFERENCES contact_points(id),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'approved', 'rejected', 'expired', 'cancelled')),
  risk TEXT NOT NULL DEFAULT 'normal' CHECK (risk IN ('low', 'normal', 'high')),
  requester_bucket_hash TEXT NOT NULL CHECK (length(requester_bucket_hash) BETWEEN 32 AND 256),
  reviewer_person_id INTEGER REFERENCES people(id),
  resolution TEXT CHECK (resolution IS NULL OR length(resolution) BETWEEN 1 AND 1024),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_identity_recovery_cases_queue ON identity_recovery_cases (campus_id, state, expires_at);

CREATE TABLE person_external_identities (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64 AND instr(provider, char(0)) = 0 AND provider NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 255 AND instr(organization_id, char(0)) = 0 AND organization_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
  external_person_id TEXT NOT NULL CHECK (length(external_person_id) BETWEEN 1 AND 255 AND instr(external_person_id, char(0)) = 0 AND external_person_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, organization_id, external_person_id)
);
CREATE INDEX idx_person_external_identities_person ON person_external_identities (person_id);

CREATE TABLE external_person_mergers (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 255),
  receipt_key TEXT NOT NULL CHECK (length(receipt_key) BETWEEN 1 AND 255),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) BETWEEN 32 AND 256),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, organization_id, receipt_key)
);

CREATE TABLE identity_provider_sync_state (
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 255),
  cursor_value TEXT CHECK (cursor_value IS NULL OR length(cursor_value) <= 4096),
  cursor_updated_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 1024),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, organization_id)
);

CREATE TABLE identity_audit_events (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  actor_person_id INTEGER REFERENCES people(id),
  subject_person_id INTEGER REFERENCES people(id),
  contact_point_id INTEGER REFERENCES contact_points(id),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (instr(metadata_json, char(0)) = 0 AND length(CAST(metadata_json AS BLOB)) <= 4096 AND json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_identity_audit_events_campus_created ON identity_audit_events (campus_id, created_at);
CREATE INDEX idx_identity_audit_events_subject_created ON identity_audit_events (subject_person_id, created_at);
CREATE TRIGGER contact_ownership_events_append_only_update BEFORE UPDATE ON contact_ownership_events BEGIN SELECT RAISE(ABORT, 'contact_ownership_events_append_only'); END;
CREATE TRIGGER contact_ownership_events_append_only_delete BEFORE DELETE ON contact_ownership_events BEGIN SELECT RAISE(ABORT, 'contact_ownership_events_append_only'); END;
CREATE TRIGGER identity_audit_events_append_only_update BEFORE UPDATE ON identity_audit_events BEGIN SELECT RAISE(ABORT, 'identity_audit_events_append_only'); END;
CREATE TRIGGER identity_audit_events_append_only_delete BEFORE DELETE ON identity_audit_events BEGIN SELECT RAISE(ABORT, 'identity_audit_events_append_only'); END;

-- Backfill compatible legacy email records. The old unique email remains in
-- place; a contact owner is only minted when exactly one eligible person holds
-- the normalized email. Any collision deliberately receives no owner.
INSERT OR IGNORE INTO contact_points (kind, normalized_value, display_value)
SELECT 'email', lower(trim(email)), email
FROM people
WHERE deleted_at IS NULL
  AND identity_state = 'active'
  AND active = 1
  AND email = trim(email)
  AND email NOT GLOB '*[^ -~]*'
  AND length(trim(email)) BETWEEN 3 AND 254
  AND instr(trim(email), ' ') = 0
  AND instr(trim(email), '@') > 1
  AND length(trim(email)) - length(replace(trim(email), '@', '')) = 1
  AND instr(substr(trim(email), instr(trim(email), '@') + 1), '.') > 1;

INSERT OR IGNORE INTO person_contact_links
  (person_id, contact_point_id, kind, source, is_primary, notification_enabled)
SELECT p.id, c.id, 'email', 'legacy', 1, 1
FROM people p
JOIN contact_points c ON c.kind = 'email' AND c.normalized_value = lower(trim(p.email))
WHERE p.deleted_at IS NULL
  AND p.identity_state = 'active'
  AND p.active = 1
  AND p.email = trim(p.email)
  AND p.email NOT GLOB '*[^ -~]*'
  AND length(trim(p.email)) BETWEEN 3 AND 254
  AND instr(trim(p.email), ' ') = 0
  AND instr(trim(p.email), '@') > 1
  AND length(trim(p.email)) - length(replace(trim(p.email), '@', '')) = 1
  AND instr(substr(trim(p.email), instr(trim(p.email), '@') + 1), '.') > 1;

INSERT OR IGNORE INTO verified_contact_owners
  (contact_point_id, person_id, verification_method, verified_at)
SELECT c.id, MIN(link.person_id), 'legacy_unique', datetime('now')
FROM contact_points c
JOIN person_contact_links link ON link.contact_point_id = c.id AND link.ended_at IS NULL
JOIN people p ON p.id = link.person_id
WHERE c.kind = 'email' AND link.kind = 'email'
  AND p.deleted_at IS NULL AND p.identity_state = 'active' AND p.active = 1
GROUP BY c.id
HAVING COUNT(*) = 1;

INSERT INTO contact_ownership_events (contact_point_id, person_id, event_type, reason)
SELECT contact_point_id, person_id, 'legacy_backfill', 'unambiguous legacy email backfill'
FROM verified_contact_owners
WHERE verification_method = 'legacy_unique';
