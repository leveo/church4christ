-- Merge operation foundation. Execution and UI are intentionally deferred.
CREATE OR REPLACE FUNCTION julianday(ts TEXT) RETURNS DOUBLE PRECISION
LANGUAGE SQL STABLE AS $$ SELECT EXTRACT(EPOCH FROM ts::timestamptz)/86400.0+2440587.5 $$;
CREATE TABLE person_merge_operations (
  operation_id TEXT PRIMARY KEY CHECK(octet_length(operation_id)=36 AND operation_id=lower(operation_id) AND operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  loser_person_id INTEGER NOT NULL REFERENCES people(id),
  canonical_person_id INTEGER NOT NULL REFERENCES people(id),
  resolution_case_id INTEGER NOT NULL REFERENCES identity_resolution_cases(id),
  expected_resolution_case_version INTEGER NOT NULL CHECK(expected_resolution_case_version BETWEEN 1 AND 2147483647),
  resolution_case_hash TEXT NOT NULL CHECK(octet_length(resolution_case_hash)=64 AND resolution_case_hash ~ '^[0-9a-f]{64}$'),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('campus','global')),
  campus_id INTEGER REFERENCES campuses(id),
  expected_loser_identity_version INTEGER NOT NULL CHECK(expected_loser_identity_version BETWEEN 1 AND 2147483647),
  expected_loser_session_epoch INTEGER NOT NULL CHECK(expected_loser_session_epoch BETWEEN 0 AND 2147483646),
  expected_canonical_identity_version INTEGER NOT NULL CHECK(expected_canonical_identity_version BETWEEN 1 AND 2147483647),
  expected_canonical_session_epoch INTEGER NOT NULL CHECK(expected_canonical_session_epoch BETWEEN 0 AND 2147483646),
  preview_hash TEXT NOT NULL CHECK(octet_length(preview_hash)=64 AND preview_hash ~ '^[0-9a-f]{64}$'),
  preview_version INTEGER NOT NULL DEFAULT 1 CHECK(preview_version=1),
  preview_expires_at TEXT NOT NULL CHECK(octet_length(preview_expires_at)=24
    AND preview_expires_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND to_char(preview_expires_at::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=preview_expires_at),
  risk TEXT NOT NULL CHECK(risk IN ('normal','high','critical')),
  risk_state_hash TEXT NOT NULL CHECK(octet_length(risk_state_hash)=64 AND risk_state_hash ~ '^[0-9a-f]{64}$'),
  risk_state_version INTEGER NOT NULL DEFAULT 1 CHECK(risk_state_version=1),
  required_approvals INTEGER NOT NULL CHECK(required_approvals IN (1,2)),
  state TEXT NOT NULL DEFAULT 'previewed' CHECK(state IN ('previewed','awaiting_approval','approved','executing','completed','failed','cancelled','expired')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
  requested_by_person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  CHECK(loser_person_id<>canonical_person_id),
  CHECK((scope_kind='campus' AND campus_id IS NOT NULL) OR (scope_kind='global' AND campus_id IS NULL))
);
CREATE INDEX idx_person_merge_operations_pair ON person_merge_operations(loser_person_id,canonical_person_id,state);
CREATE INDEX idx_person_merge_operations_case ON person_merge_operations(resolution_case_id);

-- Stable, non-secret generations bind semantic identities into preview snapshots
-- without copying raw Stripe, calendar, provider, or canonical-key values.
ALTER TABLE people ADD COLUMN merge_stripe_customer_binding_version INTEGER NOT NULL DEFAULT 1
  CHECK(merge_stripe_customer_binding_version BETWEEN 1 AND 2147483647);
ALTER TABLE people ADD COLUMN merge_calendar_binding_version INTEGER NOT NULL DEFAULT 1
  CHECK(merge_calendar_binding_version BETWEEN 1 AND 2147483647);
ALTER TABLE person_external_identities ADD COLUMN merge_binding_version INTEGER NOT NULL DEFAULT 1
  CHECK(merge_binding_version BETWEEN 1 AND 2147483647);
ALTER TABLE learning_identity_links ADD COLUMN merge_binding_version INTEGER NOT NULL DEFAULT 1
  CHECK(merge_binding_version BETWEEN 1 AND 2147483647);
ALTER TABLE identity_person_canonical_keys ADD COLUMN merge_binding_version INTEGER NOT NULL DEFAULT 1
  CHECK(merge_binding_version BETWEEN 1 AND 2147483647);
ALTER TABLE recurring_gifts ADD COLUMN merge_binding_version INTEGER NOT NULL DEFAULT 1
  CHECK(merge_binding_version BETWEEN 1 AND 2147483647);

-- Keep the same fail-closed generation contract as D1: only an isolated +1 is
-- accepted, while skips, rollback, and a semantic-value/version co-write abort.
-- An isolated direct +1 merely invalidates existing previews.
CREATE OR REPLACE FUNCTION person_merge_semantic_binding_people_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.merge_stripe_customer_binding_version IS DISTINCT FROM OLD.merge_stripe_customer_binding_version
      AND (NEW.merge_stripe_customer_binding_version<>OLD.merge_stripe_customer_binding_version+1
        OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id))
    OR (NEW.merge_calendar_binding_version IS DISTINCT FROM OLD.merge_calendar_binding_version
      AND (NEW.merge_calendar_binding_version<>OLD.merge_calendar_binding_version+1
        OR NEW.calendar_token IS DISTINCT FROM OLD.calendar_token))
  THEN RAISE EXCEPTION 'person_merge_semantic_binding_version_invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_semantic_binding_people_guard
BEFORE UPDATE OF merge_stripe_customer_binding_version,merge_calendar_binding_version ON people
FOR EACH ROW EXECUTE FUNCTION person_merge_semantic_binding_people_guard_fn();
CREATE OR REPLACE FUNCTION person_merge_semantic_binding_people_stripe_bump_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id THEN
    UPDATE people SET merge_stripe_customer_binding_version=OLD.merge_stripe_customer_binding_version+1 WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_semantic_binding_people_stripe_bump AFTER UPDATE OF stripe_customer_id ON people
FOR EACH ROW EXECUTE FUNCTION person_merge_semantic_binding_people_stripe_bump_fn();
CREATE OR REPLACE FUNCTION person_merge_semantic_binding_people_calendar_bump_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.calendar_token IS DISTINCT FROM OLD.calendar_token THEN
    UPDATE people SET merge_calendar_binding_version=OLD.merge_calendar_binding_version+1 WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_semantic_binding_people_calendar_bump AFTER UPDATE OF calendar_token ON people
FOR EACH ROW EXECUTE FUNCTION person_merge_semantic_binding_people_calendar_bump_fn();

CREATE OR REPLACE FUNCTION person_merge_semantic_binding_external_identity_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.merge_binding_version IS DISTINCT FROM OLD.merge_binding_version
    AND (NEW.merge_binding_version<>OLD.merge_binding_version+1 OR NEW.provider IS DISTINCT FROM OLD.provider
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.external_person_id IS DISTINCT FROM OLD.external_person_id)
  THEN RAISE EXCEPTION 'person_merge_semantic_binding_version_invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_semantic_binding_external_identity_guard BEFORE UPDATE OF merge_binding_version ON person_external_identities
FOR EACH ROW EXECUTE FUNCTION person_merge_semantic_binding_external_identity_guard_fn();
CREATE OR REPLACE FUNCTION person_merge_semantic_binding_external_identity_bump_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.external_person_id IS DISTINCT FROM OLD.external_person_id THEN
    UPDATE person_external_identities SET merge_binding_version=OLD.merge_binding_version+1 WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_semantic_binding_external_identity_bump AFTER UPDATE OF provider,organization_id,external_person_id ON person_external_identities
FOR EACH ROW EXECUTE FUNCTION person_merge_semantic_binding_external_identity_bump_fn();

CREATE OR REPLACE FUNCTION person_merge_semantic_binding_learning_identity_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.merge_binding_version IS DISTINCT FROM OLD.merge_binding_version
    AND (NEW.merge_binding_version<>OLD.merge_binding_version+1 OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
      OR NEW.external_user_id IS DISTINCT FROM OLD.external_user_id)
  THEN RAISE EXCEPTION 'person_merge_semantic_binding_version_invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_semantic_binding_learning_identity_guard BEFORE UPDATE OF merge_binding_version ON learning_identity_links
FOR EACH ROW EXECUTE FUNCTION person_merge_semantic_binding_learning_identity_guard_fn();
CREATE OR REPLACE FUNCTION person_merge_semantic_binding_learning_identity_bump_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.external_user_id IS DISTINCT FROM OLD.external_user_id THEN
    UPDATE learning_identity_links SET merge_binding_version=OLD.merge_binding_version+1 WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_semantic_binding_learning_identity_bump AFTER UPDATE OF connection_id,external_user_id ON learning_identity_links
FOR EACH ROW EXECUTE FUNCTION person_merge_semantic_binding_learning_identity_bump_fn();

CREATE OR REPLACE FUNCTION person_merge_semantic_binding_canonical_key_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.merge_binding_version IS DISTINCT FROM OLD.merge_binding_version
    AND (NEW.merge_binding_version<>OLD.merge_binding_version+1 OR NEW.legacy_email_key IS DISTINCT FROM OLD.legacy_email_key
      OR NEW.normalized_name_key IS DISTINCT FROM OLD.normalized_name_key OR NEW.normalization_version IS DISTINCT FROM OLD.normalization_version)
  THEN RAISE EXCEPTION 'person_merge_semantic_binding_version_invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_semantic_binding_canonical_key_guard BEFORE UPDATE OF merge_binding_version ON identity_person_canonical_keys
FOR EACH ROW EXECUTE FUNCTION person_merge_semantic_binding_canonical_key_guard_fn();
CREATE OR REPLACE FUNCTION person_merge_semantic_binding_canonical_key_bump_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.legacy_email_key IS DISTINCT FROM OLD.legacy_email_key OR NEW.normalized_name_key IS DISTINCT FROM OLD.normalized_name_key
    OR NEW.normalization_version IS DISTINCT FROM OLD.normalization_version THEN
    UPDATE identity_person_canonical_keys SET merge_binding_version=OLD.merge_binding_version+1 WHERE person_id=NEW.person_id;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_semantic_binding_canonical_key_bump AFTER UPDATE OF legacy_email_key,normalized_name_key,normalization_version ON identity_person_canonical_keys
FOR EACH ROW EXECUTE FUNCTION person_merge_semantic_binding_canonical_key_bump_fn();

CREATE OR REPLACE FUNCTION person_merge_semantic_binding_recurring_gift_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.merge_binding_version IS DISTINCT FROM OLD.merge_binding_version
    AND (NEW.merge_binding_version<>OLD.merge_binding_version+1 OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id)
  THEN RAISE EXCEPTION 'person_merge_semantic_binding_version_invalid'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_semantic_binding_recurring_gift_guard BEFORE UPDATE OF merge_binding_version ON recurring_gifts
FOR EACH ROW EXECUTE FUNCTION person_merge_semantic_binding_recurring_gift_guard_fn();
CREATE OR REPLACE FUNCTION person_merge_semantic_binding_recurring_gift_bump_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN
    UPDATE recurring_gifts SET merge_binding_version=OLD.merge_binding_version+1 WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_semantic_binding_recurring_gift_bump AFTER UPDATE OF stripe_subscription_id ON recurring_gifts
FOR EACH ROW EXECUTE FUNCTION person_merge_semantic_binding_recurring_gift_bump_fn();

CREATE TABLE person_merge_risk_facts (
  operation_id TEXT NOT NULL REFERENCES person_merge_operations(operation_id),
  category TEXT NOT NULL CHECK(category IN ('privilege','verified_contact_owner','household','stripe_customer','stripe_recurring','external_identity','learning_identity','active_credential','campus_membership','contact_link','group_membership','team_membership','roster_assignment','person_interest','source_record','canonical_key','event_admin')),
  loser_count INTEGER NOT NULL CHECK(loser_count BETWEEN 0 AND 2147483647),
  canonical_count INTEGER NOT NULL CHECK(canonical_count BETWEEN 0 AND 2147483647),
  presence_count INTEGER NOT NULL CHECK(presence_count BETWEEN 0 AND 2147483647),
  collision_count INTEGER NOT NULL CHECK(collision_count BETWEEN 0 AND 2147483647),
  risk_state_hash TEXT NOT NULL CHECK(octet_length(risk_state_hash)=64 AND risk_state_hash ~ '^[0-9a-f]{64}$'),
  risk_state_version INTEGER NOT NULL DEFAULT 1 CHECK(risk_state_version=1),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(operation_id,category),
  CHECK(presence_count=loser_count+canonical_count)
);

-- Exact, non-secret live-set snapshot. Keys contain only database identifiers,
-- enum/status values, and authorization taxonomy; never contacts, tokens,
-- provider payloads, gift amounts, notes, or answers.
CREATE TABLE person_merge_risk_set_facts (
  operation_id TEXT NOT NULL REFERENCES person_merge_operations(operation_id),
  category TEXT NOT NULL CHECK(category IN ('privilege','verified_contact_owner','household','stripe_customer','stripe_recurring','external_identity','learning_identity','active_credential','campus_membership','contact_link','group_membership','team_membership','roster_assignment','person_interest','source_record','canonical_key','event_admin')),
  side TEXT NOT NULL CHECK(side IN ('loser','canonical')),
  item_key TEXT NOT NULL CHECK(octet_length(item_key) BETWEEN 1 AND 384),
  PRIMARY KEY(operation_id,category,side,item_key)
);
CREATE TABLE person_merge_risk_set_seals (
  operation_id TEXT PRIMARY KEY REFERENCES person_merge_operations(operation_id),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 0 AND 2147483647),
  expected_operation_version INTEGER NOT NULL CHECK(expected_operation_version=1),
  expected_preview_hash TEXT NOT NULL CHECK(octet_length(expected_preview_hash)=64 AND expected_preview_hash ~ '^[0-9a-f]{64}$'),
  expected_risk_state_hash TEXT NOT NULL CHECK(octet_length(expected_risk_state_hash)=64 AND expected_risk_state_hash ~ '^[0-9a-f]{64}$'),
  expected_risk_state_version INTEGER NOT NULL CHECK(expected_risk_state_version=1),
  expected_resolution_case_version INTEGER NOT NULL CHECK(expected_resolution_case_version BETWEEN 1 AND 2147483647),
  expected_resolution_case_hash TEXT NOT NULL CHECK(octet_length(expected_resolution_case_hash)=64 AND expected_resolution_case_hash ~ '^[0-9a-f]{64}$')
);
CREATE VIEW person_merge_operation_sides AS
  SELECT operation_id,'loser'::TEXT AS side,loser_person_id AS person_id FROM person_merge_operations
  UNION ALL
  SELECT operation_id,'canonical'::TEXT,canonical_person_id FROM person_merge_operations;
CREATE VIEW person_merge_live_risk_set AS
  SELECT s.operation_id,'privilege'::TEXT category,s.side,'global:role:admin'::TEXT item_key FROM person_merge_operation_sides s JOIN people p ON p.id=s.person_id WHERE p.role='admin'
  UNION SELECT s.operation_id,'privilege',s.side,'global:super_admin' FROM person_merge_operation_sides s JOIN people p ON p.id=s.person_id WHERE p.super_admin=1
  UNION SELECT s.operation_id,'privilege',s.side,'global:finance' FROM person_merge_operation_sides s JOIN people p ON p.id=s.person_id WHERE p.finance=1
  UNION SELECT s.operation_id,'privilege',s.side,'global:admin_areas:'||p.admin_areas FROM person_merge_operation_sides s JOIN people p ON p.id=s.person_id WHERE p.admin_areas<>''
  UNION SELECT s.operation_id,'privilege',s.side,'campus:'||cm.campus_id||':role:'||cm.role||':finance:'||cm.finance||':areas:'||cm.admin_areas FROM person_merge_operation_sides s JOIN campus_memberships cm ON cm.person_id=s.person_id WHERE cm.active=1 AND (cm.role='admin' OR cm.finance=1 OR cm.admin_areas<>'')
  UNION SELECT s.operation_id,'verified_contact_owner',s.side,'contact:'||v.contact_point_id||':method:'||v.verification_method FROM person_merge_operation_sides s JOIN verified_contact_owners v ON v.person_id=s.person_id
  UNION SELECT s.operation_id,'household',s.side,'household:'||h.household_id||':role:'||h.role||':primary:'||h.is_primary FROM person_merge_operation_sides s JOIN household_members h ON h.person_id=s.person_id
  UNION SELECT s.operation_id,'stripe_customer',s.side,'customer:binding-version:'||p.merge_stripe_customer_binding_version FROM person_merge_operation_sides s JOIN people p ON p.id=s.person_id WHERE p.stripe_customer_id IS NOT NULL AND p.stripe_customer_id<>''
  UNION SELECT s.operation_id,'stripe_recurring',s.side,'gift:'||x.id||':status:'||x.status||':binding-version:'||x.merge_binding_version FROM person_merge_operation_sides s JOIN recurring_gifts x ON x.person_id=s.person_id WHERE x.status IN ('active','past_due')
  UNION SELECT s.operation_id,'external_identity',s.side,'identity:'||x.id||':binding-version:'||x.merge_binding_version FROM person_merge_operation_sides s JOIN person_external_identities x ON x.person_id=s.person_id
  UNION SELECT s.operation_id,'learning_identity',s.side,'link:'||x.id||':connection:'||x.connection_id||':status:'||x.status||':binding-version:'||x.merge_binding_version FROM person_merge_operation_sides s JOIN learning_identity_links x ON x.person_id=s.person_id WHERE x.status='active'
  UNION SELECT s.operation_id,'active_credential',s.side,'calendar:binding-version:'||p.merge_calendar_binding_version FROM person_merge_operation_sides s JOIN people p ON p.id=s.person_id WHERE p.calendar_token IS NOT NULL AND p.calendar_token<>''
  UNION SELECT s.operation_id,'active_credential',s.side,'token:'||x.id||':purpose:'||x.purpose FROM person_merge_operation_sides s JOIN tokens x ON x.person_id=s.person_id WHERE x.used_at IS NULL AND julianday(x.expires_at)>julianday('now')
  UNION SELECT s.operation_id,'active_credential',s.side,'challenge:'||x.id FROM person_merge_operation_sides s JOIN identity_challenges x ON x.person_id=s.person_id WHERE x.consumed_at IS NULL AND x.superseded_at IS NULL AND julianday(x.expires_at)>julianday('now')
  UNION SELECT s.operation_id,'active_credential',s.side,'group_token:'||x.id||':occurrence:'||x.occurrence_id FROM person_merge_operation_sides s JOIN group_attendance_tokens x ON x.person_id=s.person_id WHERE x.used_at IS NULL AND julianday(x.expires_at)>julianday('now')
  UNION SELECT s.operation_id,'active_credential',s.side,'google_oauth:'||x.connection_id FROM person_merge_operation_sides s JOIN learning_google_oauth_states x ON x.actor_person_id=s.person_id WHERE julianday(x.expires_at)>julianday('now')
  UNION SELECT s.operation_id,'active_credential',s.side,'canvas_oauth:'||x.connection_id FROM person_merge_operation_sides s JOIN learning_canvas_oauth_states x ON x.actor_person_id=s.person_id WHERE julianday(x.expires_at)>julianday('now')
  UNION SELECT s.operation_id,'active_credential',s.side,'recovery_hold:'||h.case_id FROM person_merge_operation_sides s JOIN identity_recovery_holds h ON h.expected_person_id=s.person_id OR h.expected_reachable_owner_person_id=s.person_id JOIN identity_recovery_cases c ON c.id=h.case_id WHERE c.state='open' AND julianday(h.expires_at)>julianday('now')
  UNION SELECT s.operation_id,'campus_membership',s.side,'campus:'||x.campus_id||':role:'||x.role||':finance:'||x.finance||':areas:'||x.admin_areas FROM person_merge_operation_sides s JOIN campus_memberships x ON x.person_id=s.person_id WHERE x.active=1
  UNION SELECT s.operation_id,'contact_link',s.side,'link:'||x.id||':contact:'||x.contact_point_id||':kind:'||x.kind||':primary:'||x.is_primary||':notify:'||x.notification_enabled FROM person_merge_operation_sides s JOIN person_contact_links x ON x.person_id=s.person_id WHERE x.ended_at IS NULL
  UNION SELECT s.operation_id,'group_membership',s.side,'member:'||x.id||':group:'||x.group_id||':admin:'||x.is_admin FROM person_merge_operation_sides s JOIN group_members x ON x.person_id=s.person_id WHERE x.removed_at IS NULL
  UNION SELECT s.operation_id,'team_membership',s.side,'team:'||x.team_id||':leader:'||x.is_leader FROM person_merge_operation_sides s JOIN team_members x ON x.person_id=s.person_id
  UNION SELECT s.operation_id,'roster_assignment',s.side,'assignment:'||x.id||':plan:'||x.plan_id||':position:'||x.position_id||':status:'||x.status||':signup:'||x.is_signup FROM person_merge_operation_sides s JOIN roster_assignments x ON x.person_id=s.person_id WHERE x.deleted_at IS NULL
  UNION SELECT s.operation_id,'person_interest',s.side,'category:'||x.category FROM person_merge_operation_sides s JOIN person_interests x ON x.person_id=s.person_id
  UNION SELECT s.operation_id,'source_record',s.side,'record:'||x.id||':campus:'||x.campus_id||':source:'||x.source||':state:'||x.state||':owner:'||CASE WHEN x.linked_person_id=s.person_id THEN 'linked' ELSE 'provisional' END FROM person_merge_operation_sides s JOIN identity_source_records x ON x.linked_person_id=s.person_id OR x.provisional_person_id=s.person_id
  UNION SELECT s.operation_id,'canonical_key',s.side,'current:version:'||x.normalization_version||':binding-version:'||x.merge_binding_version FROM person_merge_operation_sides s JOIN identity_person_canonical_keys x ON x.person_id=s.person_id WHERE x.is_current=1
  UNION SELECT s.operation_id,'event_admin',s.side,'event:'||x.reg_event_id FROM person_merge_operation_sides s JOIN event_admins x ON x.person_id=s.person_id;

CREATE TABLE person_merge_approvals (
  approval_id TEXT PRIMARY KEY CHECK(octet_length(approval_id)=36 AND approval_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  operation_id TEXT NOT NULL REFERENCES person_merge_operations(operation_id),
  approver_person_id INTEGER NOT NULL REFERENCES people(id),
  step_up_challenge_id INTEGER NOT NULL UNIQUE REFERENCES identity_challenges(id),
  approval_order INTEGER NOT NULL CHECK(approval_order IN (1,2)),
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
  expected_operation_version INTEGER NOT NULL CHECK(expected_operation_version BETWEEN 1 AND 2147483647),
  expected_preview_hash TEXT NOT NULL CHECK(octet_length(expected_preview_hash)=64 AND expected_preview_hash ~ '^[0-9a-f]{64}$'),
  expected_risk_state_hash TEXT NOT NULL CHECK(octet_length(expected_risk_state_hash)=64 AND expected_risk_state_hash ~ '^[0-9a-f]{64}$'),
  expected_risk_state_version INTEGER NOT NULL CHECK(expected_risk_state_version=1),
  expected_resolution_case_version INTEGER NOT NULL CHECK(expected_resolution_case_version BETWEEN 1 AND 2147483647),
  expected_resolution_case_hash TEXT NOT NULL CHECK(octet_length(expected_resolution_case_hash)=64 AND expected_resolution_case_hash ~ '^[0-9a-f]{64}$'),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(operation_id,approver_person_id),
  UNIQUE(operation_id,approval_order)
);

CREATE TABLE person_merge_conflict_decisions (
  decision_id TEXT PRIMARY KEY CHECK(octet_length(decision_id)=36 AND decision_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  operation_id TEXT NOT NULL REFERENCES person_merge_operations(operation_id),
  category TEXT NOT NULL CHECK(category IN ('campus_membership','contact_owner','external_identity','household','learning_identity','privilege','recurring_gift','unique_collision')),
  decision TEXT NOT NULL CHECK(decision IN ('canonical_only','dedupe','keep_both','manual_required','preserve_history','reject','revoke_loser')),
  decided_by_person_id INTEGER NOT NULL REFERENCES people(id),
  expected_operation_version INTEGER NOT NULL CHECK(expected_operation_version BETWEEN 1 AND 2147483647),
  expected_preview_hash TEXT NOT NULL CHECK(octet_length(expected_preview_hash)=64 AND expected_preview_hash ~ '^[0-9a-f]{64}$'),
  expected_risk_state_hash TEXT NOT NULL CHECK(octet_length(expected_risk_state_hash)=64 AND expected_risk_state_hash ~ '^[0-9a-f]{64}$'),
  expected_risk_state_version INTEGER NOT NULL CHECK(expected_risk_state_version=1),
  expected_resolution_case_version INTEGER NOT NULL CHECK(expected_resolution_case_version BETWEEN 1 AND 2147483647),
  expected_resolution_case_hash TEXT NOT NULL CHECK(octet_length(expected_resolution_case_hash)=64 AND expected_resolution_case_hash ~ '^[0-9a-f]{64}$'),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(operation_id,category),
  CHECK(category<>'privilege' OR decision='canonical_only')
);

CREATE TABLE person_merge_registry_keys (
  reference_key TEXT PRIMARY KEY CHECK(octet_length(reference_key) BETWEEN 3 AND 128 AND reference_key ~ '^[a-z0-9_.]+$' AND position('.' IN reference_key)>1),
  policy TEXT NOT NULL CHECK(policy IN ('subject_repoint','dedupe_then_repoint','operational_actor_repoint','historical_preserve','security_revoke','hard_conflict')),
  UNIQUE(reference_key,policy)
);

-- Generated from the static TypeScript registry; values only, never executable identifiers.
INSERT INTO person_merge_registry_keys(reference_key,policy) VALUES
  ('activity_score_config.updated_by_person_id','operational_actor_repoint'),
  ('audit_events.actor_person_id','historical_preserve'),
  ('blockout_dates.person_id','dedupe_then_repoint'),
  ('bulletins.updated_by','historical_preserve'),
  ('campus_memberships.person_id','dedupe_then_repoint'),
  ('church_private.stripe_checkout_requests.last_action_by','historical_preserve'),
  ('church_private.stripe_webhook_events.last_action_by','historical_preserve'),
  ('contact_owner_mutation_claims.expected_person_id','historical_preserve'),
  ('contact_owner_mutation_claims.resulting_person_id','historical_preserve'),
  ('contact_ownership_events.actor_person_id','historical_preserve'),
  ('contact_ownership_events.person_id','historical_preserve'),
  ('contact_ownership_events.previous_person_id','historical_preserve'),
  ('event_admins.person_id','dedupe_then_repoint'),
  ('external_ids.entity_id','hard_conflict'),
  ('gift_results.person_id','subject_repoint'),
  ('gifts.person_id','subject_repoint'),
  ('gifts.recorded_by','historical_preserve'),
  ('group_attendance_tokens.person_id','security_revoke'),
  ('group_attendance.recorded_by','historical_preserve'),
  ('group_files.uploaded_by','historical_preserve'),
  ('group_join_requests.decided_by','historical_preserve'),
  ('group_join_requests.person_id','dedupe_then_repoint'),
  ('group_members.person_id','dedupe_then_repoint'),
  ('household_members.person_id','hard_conflict'),
  ('identity_account_operations.reserved_person_id','hard_conflict'),
  ('identity_account_operations.result_person_id','historical_preserve'),
  ('identity_account_operations.target_person_id','historical_preserve'),
  ('identity_account_proof_uses.person_id','historical_preserve'),
  ('identity_account_review_cases.reviewer_person_id','historical_preserve'),
  ('identity_audit_events.actor_person_id','historical_preserve'),
  ('identity_audit_events.subject_person_id','historical_preserve'),
  ('identity_business_intent_receipts.person_id','historical_preserve'),
  ('identity_business_intents.result_person_id','historical_preserve'),
  ('identity_challenge_proof_uses.person_id','historical_preserve'),
  ('identity_challenges.person_id','security_revoke'),
  ('identity_claim_operations.expected_owner_person_id','historical_preserve'),
  ('identity_claim_operations.result_person_id','historical_preserve'),
  ('identity_observations.linked_person_id','subject_repoint'),
  ('identity_newcomer_intents.provisional_person_id','hard_conflict'),
  ('identity_person_canonical_keys.person_id','hard_conflict'),
  ('identity_recovery_cases.person_id','historical_preserve'),
  ('identity_recovery_cases.reviewer_person_id','historical_preserve'),
  ('identity_recovery_decisions.actor_person_id','historical_preserve'),
  ('identity_recovery_decisions.expected_person_id','historical_preserve'),
  ('identity_recovery_decisions.expected_reachable_owner_person_id','historical_preserve'),
  ('identity_recovery_holds.expected_person_id','historical_preserve'),
  ('identity_recovery_holds.expected_reachable_owner_person_id','historical_preserve'),
  ('identity_recovery_holds.first_approver_person_id','historical_preserve'),
  ('identity_recovery_owner_snapshots.expected_owner_person_id','historical_preserve'),
  ('identity_resolution_cases.candidate_person_id','historical_preserve'),
  ('identity_resolution_cases.person_a_id','historical_preserve'),
  ('identity_resolution_cases.person_b_id','historical_preserve'),
  ('identity_resolution_cases.reviewer_person_id','historical_preserve'),
  ('identity_session_delivery_claims.person_id','historical_preserve'),
  ('identity_session_epoch_claims.person_id','historical_preserve'),
  ('identity_source_attachment_commits.person_id','historical_preserve'),
  ('identity_source_attachment_receipts.person_id','historical_preserve'),
  ('identity_source_provisional_operations.reserved_person_id','hard_conflict'),
  ('identity_source_provisional_receipts.person_id','hard_conflict'),
  ('identity_source_records.linked_person_id','subject_repoint'),
  ('identity_source_records.provisional_person_id','hard_conflict'),
  ('learning_activity_events.person_id','subject_repoint'),
  ('learning_canvas_oauth_states.actor_person_id','security_revoke'),
  ('learning_google_oauth_states.actor_person_id','security_revoke'),
  ('learning_identity_links.person_id','hard_conflict'),
  ('learning_programs.created_by_person_id','operational_actor_repoint'),
  ('learning_programs.updated_by_person_id','operational_actor_repoint'),
  ('learning_provider_connections.created_by_person_id','operational_actor_repoint'),
  ('learning_provider_connections.updated_by_person_id','operational_actor_repoint'),
  ('media.uploaded_by','historical_preserve'),
  ('ministries.leader_person_id','subject_repoint'),
  ('newcomer_activity.actor_person_id','historical_preserve'),
  ('newcomer_notes.author_person_id','historical_preserve'),
  ('newcomer_submissions.assignee_person_id','operational_actor_repoint'),
  ('newcomer_submissions.linked_person_id','subject_repoint'),
  ('onboarding_acknowledgements.actor_person_id','historical_preserve'),
  ('people_import_mappings.created_by_person_id','historical_preserve'),
  ('people.merged_into_person_id','hard_conflict'),
  ('person_contact_links.person_id','dedupe_then_repoint'),
  ('person_external_identities.person_id','hard_conflict'),
  ('person_interests.person_id','dedupe_then_repoint'),
  ('person_merge_approvals.approver_person_id','historical_preserve'),
  ('person_merge_conflict_decisions.decided_by_person_id','historical_preserve'),
  ('person_merge_events.approved_by_person_id','historical_preserve'),
  ('person_merge_events.canonical_person_id','historical_preserve'),
  ('person_merge_events.loser_person_id','historical_preserve'),
  ('person_merge_events.requested_by_person_id','historical_preserve'),
  ('person_merge_mutation_receipts.canonical_person_id','historical_preserve'),
  ('person_merge_mutation_receipts.loser_person_id','historical_preserve'),
  ('person_merge_operations.canonical_person_id','historical_preserve'),
  ('person_merge_operations.loser_person_id','historical_preserve'),
  ('person_merge_operations.requested_by_person_id','historical_preserve'),
  ('person_merge_redirects.canonical_person_id','historical_preserve'),
  ('person_merge_redirects.loser_person_id','historical_preserve'),
  ('person_notes.author_email','historical_preserve'),
  ('person_notes.person_id','subject_repoint'),
  ('planning_center_person_mappings.person_id','hard_conflict'),
  ('prayer_activity.author','historical_preserve'),
  ('prayer_items.approved_by','historical_preserve'),
  ('prayer_items.author_person_id','historical_preserve'),
  ('prayer_sheets.updated_by','historical_preserve'),
  ('recurring_gifts.person_id','hard_conflict'),
  ('registrations.person_id','subject_repoint'),
  ('revisions.edited_by','historical_preserve'),
  ('roster_assignments.assigned_by','historical_preserve'),
  ('roster_assignments.person_id','dedupe_then_repoint'),
  ('sermons.updated_by','historical_preserve'),
  ('service_attendance.recorded_by_person_id','historical_preserve'),
  ('service_attendance.updated_by_person_id','historical_preserve'),
  ('service_type_checkin_events.closed_by_person_id','historical_preserve'),
  ('service_type_checkin_events.created_by_person_id','historical_preserve'),
  ('team_applications.decided_by','historical_preserve'),
  ('team_applications.person_id','dedupe_then_repoint'),
  ('team_members.person_id','dedupe_then_repoint'),
  ('testimonies.author_name','historical_preserve'),
  ('testimonies.person_id','subject_repoint'),
  ('tokens.person_id','security_revoke'),
  ('verified_contact_owners.person_id','hard_conflict');

CREATE TABLE person_merge_mutation_receipts (
  mutation_receipt_id TEXT PRIMARY KEY CHECK(octet_length(mutation_receipt_id)=36 AND mutation_receipt_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  operation_id TEXT NOT NULL REFERENCES person_merge_operations(operation_id),
  execution_version INTEGER NOT NULL CHECK(execution_version BETWEEN 1 AND 2147483647),
  reference_key TEXT NOT NULL,
  policy TEXT NOT NULL,
  row_key_hash TEXT NOT NULL CHECK(octet_length(row_key_hash)=64 AND row_key_hash ~ '^[0-9a-f]{64}$'),
  loser_person_id INTEGER NOT NULL REFERENCES people(id),
  canonical_person_id INTEGER NOT NULL REFERENCES people(id),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('campus','global')),
  campus_id INTEGER REFERENCES campuses(id),
  affected_count INTEGER NOT NULL DEFAULT 1 CHECK(affected_count=1),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(operation_id,reference_key,row_key_hash),
  UNIQUE(operation_id,mutation_receipt_id,reference_key,policy,row_key_hash,affected_count),
  FOREIGN KEY(reference_key,policy) REFERENCES person_merge_registry_keys(reference_key,policy),
  CHECK(loser_person_id<>canonical_person_id),
  CHECK((scope_kind='campus' AND campus_id IS NOT NULL) OR (scope_kind='global' AND campus_id IS NULL))
);

CREATE TABLE person_merge_reassignment_journal (
  journal_id TEXT PRIMARY KEY CHECK(octet_length(journal_id)=36 AND journal_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  operation_id TEXT NOT NULL REFERENCES person_merge_operations(operation_id),
  mutation_receipt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 2147483647),
  reference_key TEXT NOT NULL CHECK(octet_length(reference_key) BETWEEN 3 AND 128 AND reference_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
  policy TEXT NOT NULL CHECK(policy IN ('subject_repoint','dedupe_then_repoint','operational_actor_repoint','historical_preserve','security_revoke','hard_conflict')),
  row_key_hash TEXT NOT NULL CHECK(octet_length(row_key_hash)=64 AND row_key_hash ~ '^[0-9a-f]{64}$'),
  affected_count INTEGER NOT NULL CHECK(affected_count=1),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(operation_id,sequence),
  UNIQUE(operation_id,journal_id),
  UNIQUE(mutation_receipt_id),
  FOREIGN KEY(reference_key,policy) REFERENCES person_merge_registry_keys(reference_key,policy),
  FOREIGN KEY(operation_id,mutation_receipt_id,reference_key,policy,row_key_hash,affected_count)
    REFERENCES person_merge_mutation_receipts(operation_id,mutation_receipt_id,reference_key,policy,row_key_hash,affected_count)
);

CREATE TABLE person_merge_rollback_receipts (
  receipt_id TEXT PRIMARY KEY CHECK(octet_length(receipt_id)=36 AND receipt_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  operation_id TEXT NOT NULL REFERENCES person_merge_operations(operation_id),
  journal_id TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK(outcome IN ('reverted','skipped','failed')),
  reverted_count INTEGER NOT NULL CHECK(reverted_count BETWEEN 0 AND 2147483647),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  FOREIGN KEY(operation_id,journal_id) REFERENCES person_merge_reassignment_journal(operation_id,journal_id)
);

CREATE FUNCTION identity_resolution_cases_merge_binding_immutable_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF (EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.resolution_case_id=OLD.id)) AND
  (NEW.id IS DISTINCT FROM OLD.id OR NEW.campus_id IS DISTINCT FROM OLD.campus_id
    OR NEW.person_a_id IS DISTINCT FROM OLD.person_a_id OR NEW.person_b_id IS DISTINCT FROM OLD.person_b_id)
  THEN RAISE EXCEPTION 'identity_resolution_case_merge_binding_immutable'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER identity_resolution_cases_merge_binding_immutable_guard BEFORE UPDATE ON identity_resolution_cases
FOR EACH ROW EXECUTE FUNCTION identity_resolution_cases_merge_binding_immutable_guard_fn();
CREATE FUNCTION identity_resolution_cases_merge_version_cas_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF (EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.resolution_case_id=OLD.id))
  AND (NEW.version<>OLD.version+1)
  THEN RAISE EXCEPTION 'identity_resolution_case_merge_version_cas'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER identity_resolution_cases_merge_version_cas_guard BEFORE UPDATE ON identity_resolution_cases
FOR EACH ROW EXECUTE FUNCTION identity_resolution_cases_merge_version_cas_guard_fn();

CREATE FUNCTION person_merge_operations_initial_state_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.version<>1 OR NEW.state<>'previewed' THEN RAISE EXCEPTION 'person_merge_operation_initial_state'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_initial_state_guard BEFORE INSERT ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_initial_state_guard_fn();

CREATE FUNCTION person_merge_operations_insert_expiry_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF julianday(NEW.preview_expires_at)<=julianday('now') THEN RAISE EXCEPTION 'person_merge_preview_expired'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_insert_expiry_guard BEFORE INSERT ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_insert_expiry_guard_fn();

CREATE FUNCTION person_merge_operations_case_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
PERFORM 1 FROM identity_resolution_cases c WHERE c.id=NEW.resolution_case_id FOR UPDATE;
IF NOT EXISTS (SELECT 1 FROM identity_resolution_cases c WHERE c.id=NEW.resolution_case_id
  AND c.state='same_person' AND c.version=NEW.expected_resolution_case_version
  AND ((c.person_a_id=NEW.loser_person_id AND c.person_b_id=NEW.canonical_person_id)
    OR (c.person_a_id=NEW.canonical_person_id AND c.person_b_id=NEW.loser_person_id))
  AND (NEW.scope_kind='global' OR (c.campus_id=NEW.campus_id
    AND EXISTS (SELECT 1 FROM campuses campus WHERE campus.id=NEW.campus_id AND campus.active=1)))) THEN RAISE EXCEPTION 'person_merge_case_binding'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_case_guard BEFORE INSERT ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_case_guard_fn();

CREATE FUNCTION person_merge_operations_identity_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM people loser,people canonical
  WHERE loser.id=NEW.loser_person_id AND canonical.id=NEW.canonical_person_id
    AND loser.identity_version=NEW.expected_loser_identity_version AND loser.session_epoch=NEW.expected_loser_session_epoch
    AND canonical.identity_version=NEW.expected_canonical_identity_version AND canonical.session_epoch=NEW.expected_canonical_session_epoch
    AND loser.active=1 AND loser.deleted_at IS NULL AND loser.identity_state='active' AND loser.auth_disabled_at IS NULL
    AND canonical.active=1 AND canonical.deleted_at IS NULL AND canonical.identity_state='active' AND canonical.auth_disabled_at IS NULL)
  THEN RAISE EXCEPTION 'person_merge_identity_stale'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_identity_guard BEFORE INSERT ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_identity_guard_fn();

CREATE FUNCTION person_merge_operations_redirect_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM person_merge_redirects r WHERE r.loser_person_id IN (NEW.loser_person_id,NEW.canonical_person_id))
  THEN RAISE EXCEPTION 'person_merge_redirect_guard'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_redirect_guard BEFORE INSERT ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_redirect_guard_fn();

CREATE FUNCTION person_merge_operations_redirect_chain_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM person_merge_redirects r WHERE r.canonical_person_id=NEW.loser_person_id)
  THEN RAISE EXCEPTION 'person_merge_redirect_chain_guard'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_redirect_chain_guard BEFORE INSERT ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_redirect_chain_guard_fn();

CREATE FUNCTION person_merge_redirects_append_only_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_redirects_append_only'; END; $$;
CREATE TRIGGER person_merge_redirects_append_only_update BEFORE UPDATE ON person_merge_redirects
FOR EACH ROW EXECUTE FUNCTION person_merge_redirects_append_only_fn();
CREATE TRIGGER person_merge_redirects_append_only_delete BEFORE DELETE ON person_merge_redirects
FOR EACH ROW EXECUTE FUNCTION person_merge_redirects_append_only_fn();

CREATE FUNCTION person_merge_operations_global_admin_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.scope_kind='global' AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id=NEW.requested_by_person_id
  AND p.role='admin' AND p.super_admin=1 AND p.active=1 AND p.deleted_at IS NULL
  AND p.identity_state='active' AND p.auth_disabled_at IS NULL)
  THEN RAISE EXCEPTION 'person_merge_global_requires_master_admin'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_global_admin_guard BEFORE INSERT ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_global_admin_guard_fn();

CREATE FUNCTION person_merge_operations_active_pair_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(least(NEW.loser_person_id,NEW.canonical_person_id));
  PERFORM pg_advisory_xact_lock(greatest(NEW.loser_person_id,NEW.canonical_person_id));
  IF EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.state IN ('previewed','awaiting_approval','approved','executing')
    AND ((op.loser_person_id=NEW.loser_person_id AND op.canonical_person_id=NEW.canonical_person_id)
      OR (op.loser_person_id=NEW.canonical_person_id AND op.canonical_person_id=NEW.loser_person_id)))
  THEN RAISE EXCEPTION 'person_merge_active_pair'; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_operations_active_pair_guard BEFORE INSERT ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_active_pair_guard_fn();

CREATE FUNCTION person_merge_operations_risk_set_snapshot_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO person_merge_risk_set_facts(operation_id,category,side,item_key)
  SELECT NEW.operation_id,live.category,live.side,live.item_key
  FROM person_merge_live_risk_set live WHERE live.operation_id=NEW.operation_id;
  INSERT INTO person_merge_risk_set_seals(
    operation_id,item_count,expected_operation_version,expected_preview_hash,expected_risk_state_hash,
    expected_risk_state_version,expected_resolution_case_version,expected_resolution_case_hash)
  SELECT NEW.operation_id,COUNT(*),NEW.version,NEW.preview_hash,NEW.risk_state_hash,
    NEW.risk_state_version,NEW.expected_resolution_case_version,NEW.resolution_case_hash
  FROM person_merge_risk_set_facts fact WHERE fact.operation_id=NEW.operation_id;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_operations_risk_set_snapshot AFTER INSERT ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_risk_set_snapshot_fn();

CREATE FUNCTION person_merge_operations_immutable_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.operation_id IS DISTINCT FROM OLD.operation_id
  OR NEW.loser_person_id IS DISTINCT FROM OLD.loser_person_id OR NEW.canonical_person_id IS DISTINCT FROM OLD.canonical_person_id
  OR NEW.resolution_case_id IS DISTINCT FROM OLD.resolution_case_id
  OR NEW.expected_resolution_case_version IS DISTINCT FROM OLD.expected_resolution_case_version
  OR NEW.resolution_case_hash IS DISTINCT FROM OLD.resolution_case_hash OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
  OR NEW.campus_id IS DISTINCT FROM OLD.campus_id OR NEW.expected_loser_identity_version IS DISTINCT FROM OLD.expected_loser_identity_version
  OR NEW.expected_loser_session_epoch IS DISTINCT FROM OLD.expected_loser_session_epoch
  OR NEW.expected_canonical_identity_version IS DISTINCT FROM OLD.expected_canonical_identity_version
  OR NEW.expected_canonical_session_epoch IS DISTINCT FROM OLD.expected_canonical_session_epoch
  OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash OR NEW.preview_version IS DISTINCT FROM OLD.preview_version
  OR NEW.preview_expires_at IS DISTINCT FROM OLD.preview_expires_at OR NEW.risk IS DISTINCT FROM OLD.risk
  OR NEW.risk_state_hash IS DISTINCT FROM OLD.risk_state_hash OR NEW.risk_state_version IS DISTINCT FROM OLD.risk_state_version
  OR NEW.required_approvals IS DISTINCT FROM OLD.required_approvals
  OR NEW.requested_by_person_id IS DISTINCT FROM OLD.requested_by_person_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN RAISE EXCEPTION 'person_merge_operation_immutable'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_immutable_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_immutable_guard_fn();

CREATE FUNCTION person_merge_operations_state_cas_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'person_merge_state_cas'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_state_cas_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_state_cas_guard_fn();

CREATE FUNCTION person_merge_operations_state_transition_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT ((OLD.state='previewed' AND NEW.state IN ('awaiting_approval','cancelled','expired'))
  OR (OLD.state='awaiting_approval' AND NEW.state IN ('approved','cancelled','expired'))
  OR (OLD.state='approved' AND NEW.state IN ('executing','cancelled','expired'))
  OR (OLD.state='executing' AND NEW.state IN ('completed','failed')))
  THEN RAISE EXCEPTION 'person_merge_state_transition'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_state_transition_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_state_transition_guard_fn();

CREATE FUNCTION person_merge_operations_update_expiry_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.state IN ('awaiting_approval','approved','executing') AND julianday(OLD.preview_expires_at)<=julianday('now')
  THEN RAISE EXCEPTION 'person_merge_preview_expired'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_update_expiry_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_update_expiry_guard_fn();

-- Every operation-side writer locks the complete person set in one numeric
-- order after serializing on the operation row. Risk-source row triggers use
-- the same person advisory keys, so eligibility can be re-read without taking
-- tuple locks after advisory locks (which would invert PostgreSQL's row-trigger
-- lock order for concurrent UPDATE/DELETE statements).
CREATE FUNCTION person_merge_lock_operation_people_fn(target_operation_id TEXT, extra_person_id BIGINT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE lock_person_id BIGINT;
BEGIN
  FOR lock_person_id IN
    SELECT person_id FROM (
      SELECT op.loser_person_id AS person_id FROM person_merge_operations op WHERE op.operation_id=target_operation_id
      UNION
      SELECT op.canonical_person_id FROM person_merge_operations op WHERE op.operation_id=target_operation_id
      UNION
      SELECT approval.approver_person_id FROM person_merge_approvals approval
        WHERE approval.operation_id=target_operation_id AND approval.decision='approve'
      UNION
      SELECT extra_person_id WHERE extra_person_id IS NOT NULL
    ) operation_people
    ORDER BY person_id
  LOOP
    PERFORM pg_advisory_xact_lock(lock_person_id);
  END LOOP;
END; $$;

CREATE FUNCTION person_merge_operations_a_global_lock_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('awaiting_approval','approved','executing') THEN
    PERFORM person_merge_lock_operation_people_fn(OLD.operation_id,NULL);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_operations_a_global_lock_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_a_global_lock_guard_fn();

CREATE FUNCTION person_merge_operations_approval_gate_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.state='approved' AND (
  (OLD.required_approvals=1 AND (SELECT COUNT(*) FROM person_merge_approvals a WHERE a.operation_id=OLD.operation_id
    AND a.decision='approve' AND a.expected_operation_version=OLD.version AND a.expected_preview_hash=OLD.preview_hash)<1)
  OR (OLD.required_approvals=2 AND (SELECT COUNT(*) FROM person_merge_approvals a WHERE a.operation_id=OLD.operation_id
    AND a.decision='approve' AND a.expected_operation_version=OLD.version AND a.expected_preview_hash=OLD.preview_hash)<2))
  THEN RAISE EXCEPTION 'person_merge_approvals_missing'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_approval_gate_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_approval_gate_guard_fn();

CREATE FUNCTION person_merge_operations_approval_eligibility_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('approved','executing') THEN
    IF (SELECT COUNT(*) FROM person_merge_approvals a JOIN people p ON p.id=a.approver_person_id
      JOIN identity_challenges stepup ON stepup.id=a.step_up_challenge_id
      WHERE a.operation_id=OLD.operation_id AND a.decision='approve'
        AND ((NEW.state='approved' AND a.expected_operation_version=OLD.version)
          OR (NEW.state='executing' AND a.expected_operation_version=OLD.version-1))
        AND a.expected_preview_hash=OLD.preview_hash
        AND a.expected_risk_state_hash=OLD.risk_state_hash AND a.expected_risk_state_version=OLD.risk_state_version
        AND a.expected_resolution_case_version=OLD.expected_resolution_case_version
        AND a.expected_resolution_case_hash=OLD.resolution_case_hash
        AND p.role='admin' AND (OLD.risk='normal' OR p.super_admin=1) AND p.active=1 AND p.deleted_at IS NULL
        AND p.identity_state='active' AND p.auth_disabled_at IS NULL
        AND stepup.purpose='step_up' AND stepup.person_id=a.approver_person_id
        AND stepup.expected_session_epoch=p.session_epoch
        AND stepup.consumed_at IS NOT NULL AND stepup.superseded_at IS NULL
        AND stepup.created_at::timestamp<=stepup.consumed_at::timestamp
        AND stepup.consumed_at::timestamp<=stepup.expires_at::timestamp
        AND stepup.consumed_at::timestamp<=stepup.created_at::timestamp+interval '10 minutes'
        AND stepup.consumed_at::timestamp>clock_timestamp()-interval '10 minutes'
        AND stepup.consumed_at::timestamp<=clock_timestamp()
        AND stepup.context_json::jsonb #>> '{person_merge_approval,operation_id}'=OLD.operation_id
        AND (stepup.context_json::jsonb #>> '{person_merge_approval,operation_version}')::integer=a.expected_operation_version
        AND stepup.context_json::jsonb #>> '{person_merge_approval,preview_hash}'=a.expected_preview_hash
        AND stepup.context_json::jsonb #>> '{person_merge_approval,risk_state_hash}'=a.expected_risk_state_hash
        AND (stepup.context_json::jsonb #>> '{person_merge_approval,risk_state_version}')::integer=a.expected_risk_state_version
        AND (stepup.context_json::jsonb #>> '{person_merge_approval,resolution_case_version}')::integer=a.expected_resolution_case_version
        AND stepup.context_json::jsonb #>> '{person_merge_approval,resolution_case_hash}'=a.expected_resolution_case_hash
        AND (stepup.context_json::jsonb #>> '{person_merge_approval,approver_person_id}')::integer=a.approver_person_id
        AND (stepup.context_json::jsonb #>> '{person_merge_approval,approver_identity_version}')::integer=p.identity_version
        AND (stepup.context_json::jsonb #>> '{person_merge_approval,campus_id}')::integer=stepup.campus_id
        AND (OLD.scope_kind='global' OR EXISTS (SELECT 1 FROM campuses campus
          JOIN campus_memberships cm ON cm.campus_id=campus.id AND cm.person_id=p.id
          WHERE campus.id=OLD.campus_id AND stepup.campus_id=OLD.campus_id AND campus.active=1 AND cm.active=1 AND cm.role='admin'))
        AND (OLD.scope_kind<>'global' OR EXISTS (SELECT 1 FROM campuses campus
          JOIN campus_memberships cm ON cm.campus_id=campus.id AND cm.person_id=p.id
          WHERE campus.id=stepup.campus_id AND campus.active=1 AND cm.active=1 AND cm.role='admin')))<OLD.required_approvals
    THEN RAISE EXCEPTION 'person_merge_approval_eligibility_stale'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_operations_approval_eligibility_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_approval_eligibility_guard_fn();

CREATE FUNCTION person_merge_operations_veto_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.state IN ('approved','executing') AND (
  EXISTS (SELECT 1 FROM person_merge_approvals a WHERE a.operation_id=OLD.operation_id AND a.decision='reject')
  OR EXISTS (SELECT 1 FROM person_merge_conflict_decisions d WHERE d.operation_id=OLD.operation_id AND d.decision='reject'))
  THEN RAISE EXCEPTION 'person_merge_approval_veto'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_veto_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_veto_guard_fn();

CREATE FUNCTION person_merge_operations_decision_gate_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.state IN ('approved','executing') AND (
  EXISTS (SELECT 1 FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id AND f.category='privilege' AND f.presence_count>0)
    AND NOT EXISTS (SELECT 1 FROM person_merge_conflict_decisions d WHERE d.operation_id=OLD.operation_id AND d.category='privilege' AND d.decision='canonical_only' AND d.expected_preview_hash=OLD.preview_hash AND d.expected_risk_state_hash=OLD.risk_state_hash AND d.expected_risk_state_version=OLD.risk_state_version AND d.expected_resolution_case_version=OLD.expected_resolution_case_version AND d.expected_resolution_case_hash=OLD.resolution_case_hash)
  OR EXISTS (SELECT 1 FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id AND f.category='verified_contact_owner' AND f.presence_count>0)
    AND NOT EXISTS (SELECT 1 FROM person_merge_conflict_decisions d WHERE d.operation_id=OLD.operation_id AND d.category='contact_owner' AND d.expected_preview_hash=OLD.preview_hash AND d.expected_risk_state_hash=OLD.risk_state_hash AND d.expected_risk_state_version=OLD.risk_state_version AND d.expected_resolution_case_version=OLD.expected_resolution_case_version AND d.expected_resolution_case_hash=OLD.resolution_case_hash)
  OR EXISTS (SELECT 1 FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id AND f.category='household' AND f.presence_count>0)
    AND NOT EXISTS (SELECT 1 FROM person_merge_conflict_decisions d WHERE d.operation_id=OLD.operation_id AND d.category='household' AND d.expected_preview_hash=OLD.preview_hash AND d.expected_risk_state_hash=OLD.risk_state_hash AND d.expected_risk_state_version=OLD.risk_state_version AND d.expected_resolution_case_version=OLD.expected_resolution_case_version AND d.expected_resolution_case_hash=OLD.resolution_case_hash)
  OR EXISTS (SELECT 1 FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id AND f.category='external_identity' AND f.presence_count>0)
    AND NOT EXISTS (SELECT 1 FROM person_merge_conflict_decisions d WHERE d.operation_id=OLD.operation_id AND d.category='external_identity' AND d.expected_preview_hash=OLD.preview_hash AND d.expected_risk_state_hash=OLD.risk_state_hash AND d.expected_risk_state_version=OLD.risk_state_version AND d.expected_resolution_case_version=OLD.expected_resolution_case_version AND d.expected_resolution_case_hash=OLD.resolution_case_hash)
  OR EXISTS (SELECT 1 FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id AND f.category='learning_identity' AND f.presence_count>0)
    AND NOT EXISTS (SELECT 1 FROM person_merge_conflict_decisions d WHERE d.operation_id=OLD.operation_id AND d.category='learning_identity' AND d.expected_preview_hash=OLD.preview_hash AND d.expected_risk_state_hash=OLD.risk_state_hash AND d.expected_risk_state_version=OLD.risk_state_version AND d.expected_resolution_case_version=OLD.expected_resolution_case_version AND d.expected_resolution_case_hash=OLD.resolution_case_hash)
  OR EXISTS (SELECT 1 FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id AND f.category='stripe_recurring' AND f.presence_count>0)
    AND NOT EXISTS (SELECT 1 FROM person_merge_conflict_decisions d WHERE d.operation_id=OLD.operation_id AND d.category='recurring_gift' AND d.expected_preview_hash=OLD.preview_hash AND d.expected_risk_state_hash=OLD.risk_state_hash AND d.expected_risk_state_version=OLD.risk_state_version AND d.expected_resolution_case_version=OLD.expected_resolution_case_version AND d.expected_resolution_case_hash=OLD.resolution_case_hash)
  OR EXISTS (SELECT 1 FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id AND f.category='campus_membership' AND f.presence_count>0)
    AND NOT EXISTS (SELECT 1 FROM person_merge_conflict_decisions d WHERE d.operation_id=OLD.operation_id AND d.category='campus_membership' AND d.expected_preview_hash=OLD.preview_hash AND d.expected_risk_state_hash=OLD.risk_state_hash AND d.expected_risk_state_version=OLD.risk_state_version AND d.expected_resolution_case_version=OLD.expected_resolution_case_version AND d.expected_resolution_case_hash=OLD.resolution_case_hash)
  OR EXISTS (SELECT 1 FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id AND f.category IN ('stripe_customer','contact_link','group_membership','team_membership','roster_assignment','person_interest','source_record','canonical_key','event_admin') AND f.collision_count>0)
    AND NOT EXISTS (SELECT 1 FROM person_merge_conflict_decisions d WHERE d.operation_id=OLD.operation_id AND d.category='unique_collision' AND d.expected_preview_hash=OLD.preview_hash AND d.expected_risk_state_hash=OLD.risk_state_hash AND d.expected_risk_state_version=OLD.risk_state_version AND d.expected_resolution_case_version=OLD.expected_resolution_case_version AND d.expected_resolution_case_hash=OLD.resolution_case_hash)
) THEN RAISE EXCEPTION 'person_merge_decisions_missing'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_decision_gate_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_decision_gate_guard_fn();

CREATE FUNCTION person_merge_operations_update_identity_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.state IN ('awaiting_approval','approved','executing') AND NOT EXISTS (
  SELECT 1 FROM people loser,people canonical
  WHERE loser.id=OLD.loser_person_id AND canonical.id=OLD.canonical_person_id
    AND loser.identity_version=OLD.expected_loser_identity_version AND loser.session_epoch=OLD.expected_loser_session_epoch
    AND canonical.identity_version=OLD.expected_canonical_identity_version AND canonical.session_epoch=OLD.expected_canonical_session_epoch
    AND loser.active=1 AND loser.deleted_at IS NULL AND loser.identity_state='active' AND loser.auth_disabled_at IS NULL
    AND canonical.active=1 AND canonical.deleted_at IS NULL AND canonical.identity_state='active' AND canonical.auth_disabled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM person_merge_redirects r WHERE r.loser_person_id IN (OLD.loser_person_id,OLD.canonical_person_id))
    AND NOT EXISTS (SELECT 1 FROM person_merge_redirects r WHERE r.canonical_person_id=OLD.loser_person_id))
  THEN RAISE EXCEPTION 'person_merge_identity_stale'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_update_identity_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_update_identity_guard_fn();

CREATE FUNCTION person_merge_operations_case_stale_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF NEW.state IN ('awaiting_approval','approved','executing') THEN
  PERFORM 1 FROM identity_resolution_cases c WHERE c.id=OLD.resolution_case_id FOR UPDATE;
END IF;
IF NEW.state IN ('awaiting_approval','approved','executing') AND NOT EXISTS (
  SELECT 1 FROM identity_resolution_cases c WHERE c.id=OLD.resolution_case_id AND c.state='same_person'
    AND c.version=OLD.expected_resolution_case_version
    AND ((c.person_a_id=OLD.loser_person_id AND c.person_b_id=OLD.canonical_person_id)
      OR (c.person_a_id=OLD.canonical_person_id AND c.person_b_id=OLD.loser_person_id))
    AND (OLD.scope_kind='global' OR (c.campus_id=OLD.campus_id
      AND EXISTS (SELECT 1 FROM campuses campus WHERE campus.id=OLD.campus_id AND campus.active=1))))
  THEN RAISE EXCEPTION 'person_merge_case_stale'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_case_stale_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_case_stale_guard_fn();

CREATE FUNCTION person_merge_operations_risk_facts_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.state IN ('awaiting_approval','approved','executing') AND NOT (
  (SELECT COUNT(*) FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id
    AND f.risk_state_hash=OLD.risk_state_hash AND f.risk_state_version=OLD.risk_state_version)=17
  AND ((OLD.required_approvals=1 AND (SELECT SUM(f.presence_count+f.collision_count) FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id)=0)
    OR (OLD.required_approvals=2 AND (SELECT SUM(f.presence_count+f.collision_count) FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id)>0))
  AND ((OLD.risk='normal' AND (SELECT SUM(f.presence_count+f.collision_count) FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id)=0)
    OR (OLD.risk='critical' AND EXISTS (SELECT 1 FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id
      AND ((f.category='privilege' AND f.presence_count>0) OR (f.category='stripe_recurring' AND f.presence_count>0)
        OR (f.category IN ('verified_contact_owner','household','stripe_customer','stripe_recurring','external_identity','learning_identity') AND f.collision_count>0))))
    OR (OLD.risk='high' AND (SELECT SUM(f.presence_count+f.collision_count) FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id)>0
      AND NOT EXISTS (SELECT 1 FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id
        AND ((f.category='privilege' AND f.presence_count>0) OR (f.category='stripe_recurring' AND f.presence_count>0)
          OR (f.category IN ('verified_contact_owner','household','stripe_customer','stripe_recurring','external_identity','learning_identity') AND f.collision_count>0))))))
  THEN RAISE EXCEPTION 'person_merge_risk_facts_stale'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_risk_facts_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_risk_facts_guard_fn();

CREATE FUNCTION person_merge_operations_risk_source_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.state IN ('awaiting_approval','approved','executing') AND EXISTS (
    SELECT 1 FROM person_merge_risk_facts f WHERE f.operation_id=OLD.operation_id
      AND (f.loser_count<>CASE f.category
        WHEN 'privilege' THEN (SELECT COUNT(*) FROM people p WHERE p.id=OLD.loser_person_id AND (p.role='admin' OR p.super_admin=1 OR p.finance=1 OR p.admin_areas<>'' OR EXISTS (SELECT 1 FROM campus_memberships cm WHERE cm.person_id=p.id AND cm.active=1 AND (cm.role='admin' OR cm.finance=1 OR cm.admin_areas<>''))))
        WHEN 'verified_contact_owner' THEN (SELECT COUNT(*) FROM verified_contact_owners x WHERE x.person_id=OLD.loser_person_id)
        WHEN 'household' THEN (SELECT COUNT(*) FROM household_members x WHERE x.person_id=OLD.loser_person_id)
        WHEN 'stripe_customer' THEN (SELECT COUNT(*) FROM people p WHERE p.id=OLD.loser_person_id AND p.stripe_customer_id IS NOT NULL AND p.stripe_customer_id<>'')
        WHEN 'stripe_recurring' THEN (SELECT COUNT(*) FROM recurring_gifts x WHERE x.person_id=OLD.loser_person_id AND x.status IN ('active','past_due'))
        WHEN 'external_identity' THEN (SELECT COUNT(*) FROM person_external_identities x WHERE x.person_id=OLD.loser_person_id)
        WHEN 'learning_identity' THEN (SELECT COUNT(*) FROM learning_identity_links x WHERE x.person_id=OLD.loser_person_id AND x.status='active')
        WHEN 'active_credential' THEN ((SELECT COUNT(*) FROM people p WHERE p.id=OLD.loser_person_id AND p.calendar_token IS NOT NULL AND p.calendar_token<>'')+(SELECT COUNT(*) FROM tokens x WHERE x.person_id=OLD.loser_person_id AND x.used_at IS NULL AND julianday(x.expires_at)>julianday('now'))+(SELECT COUNT(*) FROM identity_challenges x WHERE x.person_id=OLD.loser_person_id AND x.consumed_at IS NULL AND x.superseded_at IS NULL AND julianday(x.expires_at)>julianday('now'))+(SELECT COUNT(*) FROM group_attendance_tokens x WHERE x.person_id=OLD.loser_person_id AND x.used_at IS NULL AND julianday(x.expires_at)>julianday('now'))+(SELECT COUNT(*) FROM learning_google_oauth_states x WHERE x.actor_person_id=OLD.loser_person_id AND julianday(x.expires_at)>julianday('now'))+(SELECT COUNT(*) FROM learning_canvas_oauth_states x WHERE x.actor_person_id=OLD.loser_person_id AND julianday(x.expires_at)>julianday('now'))+(SELECT COUNT(*) FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id WHERE (h.expected_person_id=OLD.loser_person_id OR h.expected_reachable_owner_person_id=OLD.loser_person_id) AND c.state='open' AND julianday(h.expires_at)>julianday('now')))
        WHEN 'campus_membership' THEN (SELECT COUNT(*) FROM campus_memberships x WHERE x.person_id=OLD.loser_person_id AND x.active=1)
        WHEN 'contact_link' THEN (SELECT COUNT(*) FROM person_contact_links x WHERE x.person_id=OLD.loser_person_id AND x.ended_at IS NULL)
        WHEN 'group_membership' THEN (SELECT COUNT(*) FROM group_members x WHERE x.person_id=OLD.loser_person_id AND x.removed_at IS NULL)
        WHEN 'team_membership' THEN (SELECT COUNT(*) FROM team_members x WHERE x.person_id=OLD.loser_person_id)
        WHEN 'roster_assignment' THEN (SELECT COUNT(*) FROM roster_assignments x WHERE x.person_id=OLD.loser_person_id AND x.deleted_at IS NULL)
        WHEN 'person_interest' THEN (SELECT COUNT(*) FROM person_interests x WHERE x.person_id=OLD.loser_person_id)
        WHEN 'source_record' THEN (SELECT COUNT(*) FROM identity_source_records x WHERE x.linked_person_id=OLD.loser_person_id OR x.provisional_person_id=OLD.loser_person_id)
        WHEN 'canonical_key' THEN (SELECT COUNT(*) FROM identity_person_canonical_keys x WHERE x.person_id=OLD.loser_person_id AND x.is_current=1)
        WHEN 'event_admin' THEN (SELECT COUNT(*) FROM event_admins x WHERE x.person_id=OLD.loser_person_id) END
      OR f.canonical_count<>CASE f.category
        WHEN 'privilege' THEN (SELECT COUNT(*) FROM people p WHERE p.id=OLD.canonical_person_id AND (p.role='admin' OR p.super_admin=1 OR p.finance=1 OR p.admin_areas<>'' OR EXISTS (SELECT 1 FROM campus_memberships cm WHERE cm.person_id=p.id AND cm.active=1 AND (cm.role='admin' OR cm.finance=1 OR cm.admin_areas<>''))))
        WHEN 'verified_contact_owner' THEN (SELECT COUNT(*) FROM verified_contact_owners x WHERE x.person_id=OLD.canonical_person_id)
        WHEN 'household' THEN (SELECT COUNT(*) FROM household_members x WHERE x.person_id=OLD.canonical_person_id)
        WHEN 'stripe_customer' THEN (SELECT COUNT(*) FROM people p WHERE p.id=OLD.canonical_person_id AND p.stripe_customer_id IS NOT NULL AND p.stripe_customer_id<>'')
        WHEN 'stripe_recurring' THEN (SELECT COUNT(*) FROM recurring_gifts x WHERE x.person_id=OLD.canonical_person_id AND x.status IN ('active','past_due'))
        WHEN 'external_identity' THEN (SELECT COUNT(*) FROM person_external_identities x WHERE x.person_id=OLD.canonical_person_id)
        WHEN 'learning_identity' THEN (SELECT COUNT(*) FROM learning_identity_links x WHERE x.person_id=OLD.canonical_person_id AND x.status='active')
        WHEN 'active_credential' THEN ((SELECT COUNT(*) FROM people p WHERE p.id=OLD.canonical_person_id AND p.calendar_token IS NOT NULL AND p.calendar_token<>'')+(SELECT COUNT(*) FROM tokens x WHERE x.person_id=OLD.canonical_person_id AND x.used_at IS NULL AND julianday(x.expires_at)>julianday('now'))+(SELECT COUNT(*) FROM identity_challenges x WHERE x.person_id=OLD.canonical_person_id AND x.consumed_at IS NULL AND x.superseded_at IS NULL AND julianday(x.expires_at)>julianday('now'))+(SELECT COUNT(*) FROM group_attendance_tokens x WHERE x.person_id=OLD.canonical_person_id AND x.used_at IS NULL AND julianday(x.expires_at)>julianday('now'))+(SELECT COUNT(*) FROM learning_google_oauth_states x WHERE x.actor_person_id=OLD.canonical_person_id AND julianday(x.expires_at)>julianday('now'))+(SELECT COUNT(*) FROM learning_canvas_oauth_states x WHERE x.actor_person_id=OLD.canonical_person_id AND julianday(x.expires_at)>julianday('now'))+(SELECT COUNT(*) FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id WHERE (h.expected_person_id=OLD.canonical_person_id OR h.expected_reachable_owner_person_id=OLD.canonical_person_id) AND c.state='open' AND julianday(h.expires_at)>julianday('now')))
        WHEN 'campus_membership' THEN (SELECT COUNT(*) FROM campus_memberships x WHERE x.person_id=OLD.canonical_person_id AND x.active=1)
        WHEN 'contact_link' THEN (SELECT COUNT(*) FROM person_contact_links x WHERE x.person_id=OLD.canonical_person_id AND x.ended_at IS NULL)
        WHEN 'group_membership' THEN (SELECT COUNT(*) FROM group_members x WHERE x.person_id=OLD.canonical_person_id AND x.removed_at IS NULL)
        WHEN 'team_membership' THEN (SELECT COUNT(*) FROM team_members x WHERE x.person_id=OLD.canonical_person_id)
        WHEN 'roster_assignment' THEN (SELECT COUNT(*) FROM roster_assignments x WHERE x.person_id=OLD.canonical_person_id AND x.deleted_at IS NULL)
        WHEN 'person_interest' THEN (SELECT COUNT(*) FROM person_interests x WHERE x.person_id=OLD.canonical_person_id)
        WHEN 'source_record' THEN (SELECT COUNT(*) FROM identity_source_records x WHERE x.linked_person_id=OLD.canonical_person_id OR x.provisional_person_id=OLD.canonical_person_id)
        WHEN 'canonical_key' THEN (SELECT COUNT(*) FROM identity_person_canonical_keys x WHERE x.person_id=OLD.canonical_person_id AND x.is_current=1)
        WHEN 'event_admin' THEN (SELECT COUNT(*) FROM event_admins x WHERE x.person_id=OLD.canonical_person_id) END
      OR f.collision_count<>CASE f.category
        WHEN 'privilege' THEN 0
        WHEN 'verified_contact_owner' THEN CASE WHEN (SELECT COUNT(*) FROM verified_contact_owners x WHERE x.person_id=OLD.loser_person_id)>0 AND (SELECT COUNT(*) FROM verified_contact_owners x WHERE x.person_id=OLD.canonical_person_id)>0 THEN 1 ELSE 0 END
        WHEN 'household' THEN CASE WHEN EXISTS (SELECT 1 FROM household_members a JOIN household_members b ON a.household_id<>b.household_id WHERE a.person_id=OLD.loser_person_id AND b.person_id=OLD.canonical_person_id) THEN 1 ELSE 0 END
        WHEN 'stripe_customer' THEN CASE WHEN EXISTS (SELECT 1 FROM people a JOIN people b ON a.id=OLD.loser_person_id AND b.id=OLD.canonical_person_id WHERE a.stripe_customer_id IS NOT NULL AND b.stripe_customer_id IS NOT NULL AND a.stripe_customer_id<>b.stripe_customer_id) THEN 1 ELSE 0 END
        WHEN 'stripe_recurring' THEN CASE WHEN (SELECT COUNT(*) FROM recurring_gifts x WHERE x.person_id=OLD.loser_person_id AND x.status IN ('active','past_due'))>0 AND (SELECT COUNT(*) FROM recurring_gifts x WHERE x.person_id=OLD.canonical_person_id AND x.status IN ('active','past_due'))>0 THEN 1 ELSE 0 END
        WHEN 'external_identity' THEN CASE WHEN (SELECT COUNT(*) FROM person_external_identities x WHERE x.person_id=OLD.loser_person_id)>0 AND (SELECT COUNT(*) FROM person_external_identities x WHERE x.person_id=OLD.canonical_person_id)>0 THEN 1 ELSE 0 END
        WHEN 'learning_identity' THEN CASE WHEN (SELECT COUNT(*) FROM learning_identity_links x WHERE x.person_id=OLD.loser_person_id AND x.status='active')>0 AND (SELECT COUNT(*) FROM learning_identity_links x WHERE x.person_id=OLD.canonical_person_id AND x.status='active')>0 THEN 1 ELSE 0 END
        WHEN 'active_credential' THEN 0
        WHEN 'campus_membership' THEN (SELECT COUNT(*) FROM campus_memberships a JOIN campus_memberships b ON a.campus_id=b.campus_id WHERE a.person_id=OLD.loser_person_id AND b.person_id=OLD.canonical_person_id AND a.active=1 AND b.active=1)
        WHEN 'contact_link' THEN (SELECT COUNT(*) FROM person_contact_links a JOIN person_contact_links b ON a.contact_point_id=b.contact_point_id WHERE a.person_id=OLD.loser_person_id AND b.person_id=OLD.canonical_person_id AND a.ended_at IS NULL AND b.ended_at IS NULL)
        WHEN 'group_membership' THEN (SELECT COUNT(*) FROM group_members a JOIN group_members b ON a.group_id=b.group_id WHERE a.person_id=OLD.loser_person_id AND b.person_id=OLD.canonical_person_id AND a.removed_at IS NULL AND b.removed_at IS NULL)
        WHEN 'team_membership' THEN (SELECT COUNT(*) FROM team_members a JOIN team_members b ON a.team_id=b.team_id WHERE a.person_id=OLD.loser_person_id AND b.person_id=OLD.canonical_person_id)
        WHEN 'roster_assignment' THEN (SELECT COUNT(*) FROM roster_assignments a JOIN roster_assignments b ON a.plan_id=b.plan_id AND a.position_id=b.position_id WHERE a.person_id=OLD.loser_person_id AND b.person_id=OLD.canonical_person_id AND a.deleted_at IS NULL AND b.deleted_at IS NULL)
        WHEN 'person_interest' THEN (SELECT COUNT(*) FROM person_interests a JOIN person_interests b ON a.category=b.category WHERE a.person_id=OLD.loser_person_id AND b.person_id=OLD.canonical_person_id)
        WHEN 'source_record' THEN (SELECT COUNT(*) FROM identity_source_records a JOIN identity_source_records b ON a.campus_id=b.campus_id AND a.source=b.source WHERE (a.linked_person_id=OLD.loser_person_id OR a.provisional_person_id=OLD.loser_person_id) AND (b.linked_person_id=OLD.canonical_person_id OR b.provisional_person_id=OLD.canonical_person_id))
        WHEN 'canonical_key' THEN CASE WHEN EXISTS (SELECT 1 FROM identity_person_canonical_keys a JOIN identity_person_canonical_keys b ON a.person_id=OLD.loser_person_id AND b.person_id=OLD.canonical_person_id AND a.is_current=1 AND b.is_current=1 AND ((a.legacy_email_key IS NOT NULL AND a.legacy_email_key=b.legacy_email_key) OR (a.normalized_name_key IS NOT NULL AND a.normalized_name_key=b.normalized_name_key))) THEN 1 ELSE 0 END
        WHEN 'event_admin' THEN (SELECT COUNT(*) FROM event_admins a JOIN event_admins b ON a.reg_event_id=b.reg_event_id WHERE a.person_id=OLD.loser_person_id AND b.person_id=OLD.canonical_person_id) END)
  ) THEN RAISE EXCEPTION 'person_merge_risk_source_stale'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_operations_risk_source_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_risk_source_guard_fn();

CREATE FUNCTION person_merge_operations_risk_set_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('awaiting_approval','approved','executing') AND (
    NOT EXISTS (SELECT 1 FROM person_merge_risk_set_seals seal WHERE seal.operation_id=OLD.operation_id
      AND seal.item_count=(SELECT COUNT(*) FROM person_merge_risk_set_facts fact WHERE fact.operation_id=OLD.operation_id)
      AND seal.expected_operation_version=1 AND seal.expected_preview_hash=OLD.preview_hash
      AND seal.expected_risk_state_hash=OLD.risk_state_hash AND seal.expected_risk_state_version=OLD.risk_state_version
      AND seal.expected_resolution_case_version=OLD.expected_resolution_case_version
      AND seal.expected_resolution_case_hash=OLD.resolution_case_hash)
    OR EXISTS (SELECT category,side,item_key FROM person_merge_live_risk_set WHERE operation_id=OLD.operation_id
      EXCEPT SELECT category,side,item_key FROM person_merge_risk_set_facts WHERE operation_id=OLD.operation_id)
    OR EXISTS (SELECT category,side,item_key FROM person_merge_risk_set_facts WHERE operation_id=OLD.operation_id
      EXCEPT SELECT category,side,item_key FROM person_merge_live_risk_set WHERE operation_id=OLD.operation_id)
  ) THEN RAISE EXCEPTION 'person_merge_risk_set_stale'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER person_merge_operations_risk_set_guard BEFORE UPDATE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_risk_set_guard_fn();

CREATE FUNCTION person_merge_risk_source_writer_lock_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  column_name TEXT;
  risk_person_id BIGINT;
  risk_person_ids BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    IF TG_OP<>'INSERT' THEN
      risk_person_id := NULLIF(to_jsonb(OLD)->>column_name,'')::BIGINT;
      IF risk_person_id IS NOT NULL THEN risk_person_ids := array_append(risk_person_ids,risk_person_id); END IF;
    END IF;
    IF TG_OP<>'DELETE' THEN
      risk_person_id := NULLIF(to_jsonb(NEW)->>column_name,'')::BIGINT;
      IF risk_person_id IS NOT NULL THEN risk_person_ids := array_append(risk_person_ids,risk_person_id); END IF;
    END IF;
  END LOOP;
  FOR risk_person_id IN SELECT DISTINCT unnest(risk_person_ids) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(risk_person_id);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER person_merge_risk_writer_people BEFORE INSERT OR UPDATE OR DELETE ON people
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('id');
CREATE TRIGGER person_merge_risk_writer_verified_contact_owners BEFORE INSERT OR UPDATE OR DELETE ON verified_contact_owners
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_household_members BEFORE INSERT OR UPDATE OR DELETE ON household_members
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_recurring_gifts BEFORE INSERT OR UPDATE OR DELETE ON recurring_gifts
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_person_external_identities BEFORE INSERT OR UPDATE OR DELETE ON person_external_identities
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_learning_identity_links BEFORE INSERT OR UPDATE OR DELETE ON learning_identity_links
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_tokens BEFORE INSERT OR UPDATE OR DELETE ON tokens
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_identity_challenges BEFORE INSERT OR UPDATE OR DELETE ON identity_challenges
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_group_attendance_tokens BEFORE INSERT OR UPDATE OR DELETE ON group_attendance_tokens
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_learning_google_oauth_states BEFORE INSERT OR UPDATE OR DELETE ON learning_google_oauth_states
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('actor_person_id');
CREATE TRIGGER person_merge_risk_writer_learning_canvas_oauth_states BEFORE INSERT OR UPDATE OR DELETE ON learning_canvas_oauth_states
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('actor_person_id');
CREATE TRIGGER person_merge_risk_writer_identity_recovery_holds BEFORE INSERT OR UPDATE OR DELETE ON identity_recovery_holds
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('expected_person_id','expected_reachable_owner_person_id');
CREATE TRIGGER person_merge_risk_writer_identity_recovery_cases BEFORE INSERT OR UPDATE OR DELETE ON identity_recovery_cases
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_campus_memberships BEFORE INSERT OR UPDATE OR DELETE ON campus_memberships
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_person_contact_links BEFORE INSERT OR UPDATE OR DELETE ON person_contact_links
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_group_members BEFORE INSERT OR UPDATE OR DELETE ON group_members
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_team_members BEFORE INSERT OR UPDATE OR DELETE ON team_members
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_roster_assignments BEFORE INSERT OR UPDATE OR DELETE ON roster_assignments
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_person_interests BEFORE INSERT OR UPDATE OR DELETE ON person_interests
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_identity_source_records BEFORE INSERT OR UPDATE OR DELETE ON identity_source_records
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('linked_person_id','provisional_person_id');
CREATE TRIGGER person_merge_risk_writer_identity_person_canonical_keys BEFORE INSERT OR UPDATE OR DELETE ON identity_person_canonical_keys
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');
CREATE TRIGGER person_merge_risk_writer_event_admins BEFORE INSERT OR UPDATE OR DELETE ON event_admins
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_source_writer_lock_fn('person_id');

CREATE FUNCTION person_merge_operations_delete_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_operations_append_only'; END; $$;
CREATE TRIGGER person_merge_operations_delete_guard BEFORE DELETE ON person_merge_operations
FOR EACH ROW EXECUTE FUNCTION person_merge_operations_delete_guard_fn();

CREATE FUNCTION person_merge_approvals_stale_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
PERFORM pg_advisory_xact_lock(hashtext(NEW.operation_id));
PERFORM person_merge_lock_operation_people_fn(NEW.operation_id,NEW.approver_person_id);
IF NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN identity_resolution_cases c ON c.id=op.resolution_case_id
  WHERE op.operation_id=NEW.operation_id
  AND op.state IN ('awaiting_approval','approved') AND op.version=NEW.expected_operation_version
  AND op.preview_hash=NEW.expected_preview_hash
  AND op.risk_state_hash=NEW.expected_risk_state_hash AND op.risk_state_version=NEW.expected_risk_state_version
  AND op.expected_resolution_case_version=NEW.expected_resolution_case_version
  AND op.resolution_case_hash=NEW.expected_resolution_case_hash
  AND c.state='same_person' AND c.version=op.expected_resolution_case_version
  AND julianday(op.preview_expires_at)>julianday('now'))
THEN RAISE EXCEPTION 'person_merge_approval_stale'; END IF;
RETURN NEW; END; $$;
CREATE TRIGGER person_merge_approvals_stale_guard BEFORE INSERT ON person_merge_approvals
FOR EACH ROW EXECUTE FUNCTION person_merge_approvals_stale_guard_fn();

CREATE FUNCTION person_merge_approvals_master_admin_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
PERFORM 1 FROM person_merge_operations op WHERE op.operation_id=NEW.operation_id FOR UPDATE;
IF FOUND THEN PERFORM person_merge_lock_operation_people_fn(NEW.operation_id,NEW.approver_person_id); END IF;
IF EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.operation_id=NEW.operation_id
  AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id=NEW.approver_person_id AND p.role='admin'
    AND (op.risk='normal' OR p.super_admin=1)
    AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
    AND (op.scope_kind='global' OR EXISTS (SELECT 1 FROM campuses campus
      JOIN campus_memberships cm ON cm.campus_id=campus.id AND cm.person_id=p.id
      WHERE campus.id=op.campus_id AND campus.active=1 AND cm.active=1 AND cm.role='admin'))))
  THEN RAISE EXCEPTION 'person_merge_approval_requires_master_admin'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_approvals_master_admin_guard BEFORE INSERT ON person_merge_approvals
FOR EACH ROW EXECUTE FUNCTION person_merge_approvals_master_admin_guard_fn();

-- The approval UI consumes a server-issued purpose=step_up challenge with an
-- exact person_merge_approval binding and submits only its id. Client timestamps
-- and JWT auth_time are deliberately not approval evidence.
CREATE FUNCTION person_merge_approvals_step_up_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
IF NOT EXISTS (
  SELECT 1 FROM identity_challenges stepup JOIN person_merge_operations op ON op.operation_id=NEW.operation_id
    JOIN people p ON p.id=NEW.approver_person_id
  WHERE stepup.id=NEW.step_up_challenge_id AND stepup.purpose='step_up'
    AND stepup.person_id=NEW.approver_person_id AND stepup.consumed_at IS NOT NULL AND stepup.superseded_at IS NULL
    AND stepup.expected_session_epoch=p.session_epoch
    AND stepup.created_at::timestamp<=stepup.consumed_at::timestamp
    AND stepup.consumed_at::timestamp<=stepup.expires_at::timestamp
    AND stepup.consumed_at::timestamp<=stepup.created_at::timestamp+interval '10 minutes'
    AND stepup.consumed_at::timestamp>clock_timestamp()-interval '10 minutes'
    AND stepup.consumed_at::timestamp<=clock_timestamp()
    AND stepup.context_json::jsonb #>> '{person_merge_approval,operation_id}'=NEW.operation_id
    AND (stepup.context_json::jsonb #>> '{person_merge_approval,operation_version}')::integer=NEW.expected_operation_version
    AND stepup.context_json::jsonb #>> '{person_merge_approval,preview_hash}'=NEW.expected_preview_hash
    AND stepup.context_json::jsonb #>> '{person_merge_approval,risk_state_hash}'=NEW.expected_risk_state_hash
    AND (stepup.context_json::jsonb #>> '{person_merge_approval,risk_state_version}')::integer=NEW.expected_risk_state_version
    AND (stepup.context_json::jsonb #>> '{person_merge_approval,resolution_case_version}')::integer=NEW.expected_resolution_case_version
    AND stepup.context_json::jsonb #>> '{person_merge_approval,resolution_case_hash}'=NEW.expected_resolution_case_hash
    AND (stepup.context_json::jsonb #>> '{person_merge_approval,approver_person_id}')::integer=NEW.approver_person_id
    AND (stepup.context_json::jsonb #>> '{person_merge_approval,approver_identity_version}')::integer=p.identity_version
    AND (stepup.context_json::jsonb #>> '{person_merge_approval,campus_id}')::integer=stepup.campus_id
    AND (op.scope_kind='global' OR stepup.campus_id=op.campus_id)
    AND EXISTS (SELECT 1 FROM campuses campus JOIN campus_memberships cm
      ON cm.campus_id=campus.id AND cm.person_id=p.id
      WHERE campus.id=stepup.campus_id AND campus.active=1 AND cm.active=1 AND cm.role='admin')
) THEN RAISE EXCEPTION 'person_merge_approval_step_up_invalid'; END IF;
RETURN NEW; END; $$;
CREATE TRIGGER person_merge_approvals_step_up_guard BEFORE INSERT ON person_merge_approvals
FOR EACH ROW EXECUTE FUNCTION person_merge_approvals_step_up_guard_fn();

CREATE FUNCTION person_merge_step_up_direct_consumed_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.purpose='step_up' AND NEW.consumed_at IS NOT NULL
  AND jsonb_typeof(NEW.context_json::jsonb->'person_merge_approval')='object'
  THEN RAISE EXCEPTION 'person_merge_step_up_must_be_consumed'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_step_up_direct_consumed_guard BEFORE INSERT ON identity_challenges
FOR EACH ROW EXECUTE FUNCTION person_merge_step_up_direct_consumed_guard_fn();
CREATE FUNCTION person_merge_step_up_binding_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.purpose='step_up' AND OLD.consumed_at IS NOT NULL
  AND jsonb_typeof(OLD.context_json::jsonb->'person_merge_approval')='object'
  AND (NEW.purpose<>OLD.purpose OR NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.campus_id<>OLD.campus_id
    OR NEW.context_json<>OLD.context_json OR NEW.created_at<>OLD.created_at OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at
    OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at))
  THEN RAISE EXCEPTION 'person_merge_step_up_binding_immutable'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_step_up_binding_immutable BEFORE UPDATE ON identity_challenges
FOR EACH ROW EXECUTE FUNCTION person_merge_step_up_binding_immutable_fn();

CREATE FUNCTION person_merge_conflict_decisions_stale_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
PERFORM pg_advisory_xact_lock(hashtext(NEW.operation_id));
PERFORM person_merge_lock_operation_people_fn(NEW.operation_id,NEW.decided_by_person_id);
IF NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN identity_resolution_cases c ON c.id=op.resolution_case_id
  WHERE op.operation_id=NEW.operation_id AND op.version=NEW.expected_operation_version
  AND op.state IN ('previewed','awaiting_approval') AND op.preview_hash=NEW.expected_preview_hash
  AND op.risk_state_hash=NEW.expected_risk_state_hash AND op.risk_state_version=NEW.expected_risk_state_version
  AND op.expected_resolution_case_version=NEW.expected_resolution_case_version
  AND op.resolution_case_hash=NEW.expected_resolution_case_hash
  AND c.state='same_person' AND c.version=op.expected_resolution_case_version
  AND julianday(op.preview_expires_at)>julianday('now'))
THEN RAISE EXCEPTION 'person_merge_decision_stale'; END IF;
RETURN NEW; END; $$;
CREATE TRIGGER person_merge_conflict_decisions_stale_guard BEFORE INSERT ON person_merge_conflict_decisions
FOR EACH ROW EXECUTE FUNCTION person_merge_conflict_decisions_stale_guard_fn();

CREATE FUNCTION person_merge_risk_facts_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.operation_id=NEW.operation_id
  AND op.state='previewed' AND op.risk_state_hash=NEW.risk_state_hash AND op.risk_state_version=NEW.risk_state_version)
  THEN RAISE EXCEPTION 'person_merge_risk_fact_binding'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_risk_facts_insert_guard BEFORE INSERT ON person_merge_risk_facts
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_facts_insert_guard_fn();

CREATE FUNCTION person_merge_risk_set_facts_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM person_merge_risk_set_seals seal WHERE seal.operation_id=NEW.operation_id)
  OR NOT EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.operation_id=NEW.operation_id
    AND op.state='previewed' AND op.version=1)
  THEN RAISE EXCEPTION 'person_merge_risk_set_fact_binding'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_risk_set_facts_insert_guard BEFORE INSERT ON person_merge_risk_set_facts
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_set_facts_insert_guard_fn();

CREATE FUNCTION person_merge_mutation_receipts_binding_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM person_merge_operations op
  WHERE op.operation_id=NEW.operation_id AND op.state='executing' AND op.version=NEW.execution_version
    AND op.loser_person_id=NEW.loser_person_id AND op.canonical_person_id=NEW.canonical_person_id
    AND op.scope_kind=NEW.scope_kind AND op.campus_id IS NOT DISTINCT FROM NEW.campus_id)
  THEN RAISE EXCEPTION 'person_merge_mutation_receipt_binding'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_mutation_receipts_binding_guard BEFORE INSERT ON person_merge_mutation_receipts
FOR EACH ROW EXECUTE FUNCTION person_merge_mutation_receipts_binding_guard_fn();

CREATE FUNCTION person_merge_reassignment_journal_state_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.operation_id=NEW.operation_id AND op.state='executing')
  THEN RAISE EXCEPTION 'person_merge_journal_state'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_reassignment_journal_state_guard BEFORE INSERT ON person_merge_reassignment_journal
FOR EACH ROW EXECUTE FUNCTION person_merge_reassignment_journal_state_guard_fn();

CREATE FUNCTION person_merge_reassignment_journal_receipt_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.operation_id=NEW.operation_id AND op.state='executing')
  AND NOT EXISTS (SELECT 1 FROM person_merge_mutation_receipts receipt
    WHERE receipt.operation_id=NEW.operation_id AND receipt.mutation_receipt_id=NEW.mutation_receipt_id
      AND receipt.reference_key=NEW.reference_key AND receipt.policy=NEW.policy
      AND receipt.row_key_hash=NEW.row_key_hash AND receipt.affected_count=NEW.affected_count)
  THEN RAISE EXCEPTION 'person_merge_journal_receipt_binding'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_reassignment_journal_receipt_guard BEFORE INSERT ON person_merge_reassignment_journal
FOR EACH ROW EXECUTE FUNCTION person_merge_reassignment_journal_receipt_guard_fn();

CREATE FUNCTION person_merge_rollback_receipts_state_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM person_merge_operations op WHERE op.operation_id=NEW.operation_id AND op.state='failed')
  THEN RAISE EXCEPTION 'person_merge_rollback_state'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_rollback_receipts_state_guard BEFORE INSERT ON person_merge_rollback_receipts
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_receipts_state_guard_fn();

CREATE FUNCTION person_merge_rollback_receipts_count_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NOT EXISTS (SELECT 1 FROM person_merge_reassignment_journal journal
  WHERE journal.operation_id=NEW.operation_id AND journal.journal_id=NEW.journal_id
    AND NEW.reverted_count<=journal.affected_count
    AND ((NEW.outcome='reverted' AND NEW.reverted_count=journal.affected_count)
      OR (NEW.outcome='skipped' AND NEW.reverted_count=0)
      OR (NEW.outcome='failed' AND NEW.reverted_count=0)))
  THEN RAISE EXCEPTION 'person_merge_rollback_count'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER person_merge_rollback_receipts_count_guard BEFORE INSERT ON person_merge_rollback_receipts
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_receipts_count_guard_fn();

CREATE FUNCTION person_merge_approvals_append_only_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_approvals_append_only'; END; $$;
CREATE TRIGGER person_merge_approvals_append_only_update BEFORE UPDATE ON person_merge_approvals
FOR EACH ROW EXECUTE FUNCTION person_merge_approvals_append_only_update_fn();
CREATE FUNCTION person_merge_approvals_append_only_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_approvals_append_only'; END; $$;
CREATE TRIGGER person_merge_approvals_append_only_delete BEFORE DELETE ON person_merge_approvals
FOR EACH ROW EXECUTE FUNCTION person_merge_approvals_append_only_delete_fn();
CREATE FUNCTION person_merge_conflict_decisions_append_only_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_conflict_decisions_append_only'; END; $$;
CREATE TRIGGER person_merge_conflict_decisions_append_only_update BEFORE UPDATE ON person_merge_conflict_decisions
FOR EACH ROW EXECUTE FUNCTION person_merge_conflict_decisions_append_only_update_fn();
CREATE FUNCTION person_merge_conflict_decisions_append_only_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_conflict_decisions_append_only'; END; $$;
CREATE TRIGGER person_merge_conflict_decisions_append_only_delete BEFORE DELETE ON person_merge_conflict_decisions
FOR EACH ROW EXECUTE FUNCTION person_merge_conflict_decisions_append_only_delete_fn();
CREATE FUNCTION person_merge_risk_facts_append_only_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_risk_facts_append_only'; END; $$;
CREATE TRIGGER person_merge_risk_facts_append_only_update BEFORE UPDATE ON person_merge_risk_facts
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_facts_append_only_update_fn();
CREATE FUNCTION person_merge_risk_facts_append_only_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_risk_facts_append_only'; END; $$;
CREATE TRIGGER person_merge_risk_facts_append_only_delete BEFORE DELETE ON person_merge_risk_facts
FOR EACH ROW EXECUTE FUNCTION person_merge_risk_facts_append_only_delete_fn();
CREATE FUNCTION person_merge_risk_set_append_only_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_risk_set_append_only'; END; $$;
CREATE TRIGGER person_merge_risk_set_facts_append_only_update BEFORE UPDATE ON person_merge_risk_set_facts FOR EACH ROW EXECUTE FUNCTION person_merge_risk_set_append_only_fn();
CREATE TRIGGER person_merge_risk_set_facts_append_only_delete BEFORE DELETE ON person_merge_risk_set_facts FOR EACH ROW EXECUTE FUNCTION person_merge_risk_set_append_only_fn();
CREATE TRIGGER person_merge_risk_set_seals_append_only_update BEFORE UPDATE ON person_merge_risk_set_seals FOR EACH ROW EXECUTE FUNCTION person_merge_risk_set_append_only_fn();
CREATE TRIGGER person_merge_risk_set_seals_append_only_delete BEFORE DELETE ON person_merge_risk_set_seals FOR EACH ROW EXECUTE FUNCTION person_merge_risk_set_append_only_fn();
CREATE FUNCTION person_merge_registry_keys_append_only_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_registry_keys_append_only'; END; $$;
CREATE TRIGGER person_merge_registry_keys_append_only_update BEFORE UPDATE ON person_merge_registry_keys
FOR EACH ROW EXECUTE FUNCTION person_merge_registry_keys_append_only_update_fn();
CREATE FUNCTION person_merge_registry_keys_append_only_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_registry_keys_append_only'; END; $$;
CREATE TRIGGER person_merge_registry_keys_append_only_delete BEFORE DELETE ON person_merge_registry_keys
FOR EACH ROW EXECUTE FUNCTION person_merge_registry_keys_append_only_delete_fn();
CREATE FUNCTION person_merge_registry_keys_append_only_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_registry_keys_append_only'; END; $$;
CREATE TRIGGER person_merge_registry_keys_append_only_insert BEFORE INSERT ON person_merge_registry_keys
FOR EACH ROW EXECUTE FUNCTION person_merge_registry_keys_append_only_insert_fn();
CREATE FUNCTION person_merge_mutation_receipts_append_only_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_mutation_receipts_append_only'; END; $$;
CREATE TRIGGER person_merge_mutation_receipts_append_only_update BEFORE UPDATE ON person_merge_mutation_receipts
FOR EACH ROW EXECUTE FUNCTION person_merge_mutation_receipts_append_only_update_fn();
CREATE FUNCTION person_merge_mutation_receipts_append_only_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_mutation_receipts_append_only'; END; $$;
CREATE TRIGGER person_merge_mutation_receipts_append_only_delete BEFORE DELETE ON person_merge_mutation_receipts
FOR EACH ROW EXECUTE FUNCTION person_merge_mutation_receipts_append_only_delete_fn();
CREATE FUNCTION person_merge_reassignment_journal_append_only_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_reassignment_journal_append_only'; END; $$;
CREATE TRIGGER person_merge_reassignment_journal_append_only_update BEFORE UPDATE ON person_merge_reassignment_journal
FOR EACH ROW EXECUTE FUNCTION person_merge_reassignment_journal_append_only_update_fn();
CREATE FUNCTION person_merge_reassignment_journal_append_only_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_reassignment_journal_append_only'; END; $$;
CREATE TRIGGER person_merge_reassignment_journal_append_only_delete BEFORE DELETE ON person_merge_reassignment_journal
FOR EACH ROW EXECUTE FUNCTION person_merge_reassignment_journal_append_only_delete_fn();
CREATE FUNCTION person_merge_rollback_receipts_append_only_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_rollback_receipts_append_only'; END; $$;
CREATE TRIGGER person_merge_rollback_receipts_append_only_update BEFORE UPDATE ON person_merge_rollback_receipts
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_receipts_append_only_update_fn();
CREATE FUNCTION person_merge_rollback_receipts_append_only_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'person_merge_rollback_receipts_append_only'; END; $$;
CREATE TRIGGER person_merge_rollback_receipts_append_only_delete BEFORE DELETE ON person_merge_rollback_receipts
FOR EACH ROW EXECUTE FUNCTION person_merge_rollback_receipts_append_only_delete_fn();
