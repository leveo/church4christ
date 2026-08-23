import type { AppDb, AppStatement } from './appDb';
import { readSnapshotBatch, type SnapshotBackend } from './appDb';
import {
  consumeEmailOtpChallenge,
  constantTimeIdentityHashEqual,
  hmacIdentityValue,
  prepareIdentityMergeStepUpChallenge,
  prepareIdentityMergeRollbackStepUpChallenge,
  type IdentityAuthEnv,
  type IdentityChallengeSource,
  type IdentityMergeStepUpBinding,
  type IdentityMergeRollbackStepUpBinding,
  type IdentityTrustedRequestContext,
} from './identityAuth';
import {
  IDENTITY_MERGE_RISK_FACT_CATEGORIES,
  buildIdentityMergePreviewSnapshot,
  buildIdentityMergeResolutionCaseBinding,
  buildIdentityMergeRiskState,
  classifyIdentityMergeRisk,
  hashIdentityMergePreview,
  type IdentityMergePreviewSnapshot,
  type IdentityMergeRiskFact,
  type IdentityMergeRiskFactCategory,
  type IdentityMergeRiskFacts,
} from './identityMergeModel';

const MAX_ID = 2_147_483_647;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
type MergeScope = Readonly<{ kind: 'global' } | { kind: 'campus'; campusId: number }>;

export type IdentityMergePlanInput = Readonly<{
  backend: SnapshotBackend;
  caseId: number;
  loserPersonId: number;
  canonicalPersonId: number;
  requestedByPersonId: number;
  scope: MergeScope;
  now?: string;
}>;
export type IdentityMergePreview = Readonly<{
  snapshot: IdentityMergePreviewSnapshot;
  previewHash: string;
  inventoryHash: string;
  inventoryCount: number;
  expectedMutationCount: number;
  expectedIrreversibleCount: number;
  blockers: readonly string[];
  risk: 'normal' | 'high' | 'critical';
  requiredApprovals: 1 | 2;
  referenceFacts: readonly IdentityMergeReferenceFact[];
}>;
export type IdentityMergeReferenceFact = Readonly<{
  referenceKey: CoreReferenceKey;
  policy: 'subject_repoint' | 'dedupe_then_repoint' | 'security_revoke';
  side: 'loser' | 'canonical';
  localRowId: string;
  rowKeyHash: string;
}>;

type CaseRow = Readonly<{
  id: number; campus_id: number; person_a_id: number; person_b_id: number; state: string; version: number;
}>;
type PersonRow = Readonly<{
  id: number; identity_version: number; session_epoch: number; role: string; super_admin: number;
  finance: number; admin_areas: string; active: number; deleted_at: string | null;
  identity_state: string; auth_disabled_at: string | null; stripe_customer_id: string | null; calendar_token: string | null;
}>;
type StaticRiskQuery = Readonly<{
  category: IdentityMergeRiskFactCategory;
  countSql: (backend: SnapshotBackend) => string;
  collisionSql: (backend: SnapshotBackend) => string;
}>;

const personCount = (table: string, predicate = '') =>
  `SELECT COUNT(*) n FROM ${table} x WHERE x.person_id=?1${predicate}`;
// Anchor placeholder types through the closed people IDs. PostgreSQL cannot
// infer a type for the former `? IS NULL` tautology; both target IDs have
// already been loaded as active people before these snapshot reads.
const zeroCount = 'SELECT 0 n FROM people p WHERE p.id=?1';
const zeroCollision = `SELECT 0 n FROM people a JOIN people b ON b.id=?2 WHERE a.id=?1`;

// All SQL identifiers are closed source literals. Callers supply values only.
const RISK_QUERIES: readonly StaticRiskQuery[] = [
  { category: 'privilege', countSql: () => `SELECT COUNT(*) n FROM people p WHERE p.id=?1 AND
      (p.role='admin' OR p.super_admin=1 OR p.finance=1 OR p.admin_areas<>'' OR EXISTS (
        SELECT 1 FROM campus_memberships cm WHERE cm.person_id=p.id AND cm.active=1
          AND (cm.role='admin' OR cm.finance=1 OR cm.admin_areas<>'')))`, collisionSql: () => zeroCollision },
  { category: 'verified_contact_owner', countSql: () => personCount('verified_contact_owners'), collisionSql: () =>
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM verified_contact_owners WHERE person_id=?1)
      AND EXISTS (SELECT 1 FROM verified_contact_owners WHERE person_id=?2) THEN 1 ELSE 0 END n` },
  { category: 'household', countSql: () => personCount('household_members'), collisionSql: () =>
    `SELECT COUNT(*) n FROM household_members a JOIN household_members b ON a.household_id<>b.household_id
      WHERE a.person_id=?1 AND b.person_id=?2` },
  { category: 'stripe_customer', countSql: () =>
    `SELECT COUNT(*) n FROM people p WHERE p.id=?1 AND p.stripe_customer_id IS NOT NULL AND p.stripe_customer_id<>''`, collisionSql: () =>
    `SELECT COUNT(*) n FROM people a JOIN people b ON a.id=?1 AND b.id=?2
      WHERE a.stripe_customer_id IS NOT NULL AND b.stripe_customer_id IS NOT NULL AND a.stripe_customer_id<>b.stripe_customer_id` },
  { category: 'stripe_recurring', countSql: (backend) => backend === 'supabase' ? personCount('recurring_gifts') : zeroCount,
    collisionSql: (backend) => backend === 'supabase' ? `SELECT CASE WHEN EXISTS (SELECT 1 FROM recurring_gifts WHERE person_id=?1)
      AND EXISTS (SELECT 1 FROM recurring_gifts WHERE person_id=?2) THEN 1 ELSE 0 END n` : zeroCollision },
  { category: 'external_identity', countSql: () => personCount('person_external_identities'), collisionSql: () =>
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM person_external_identities WHERE person_id=?1)
      AND EXISTS (SELECT 1 FROM person_external_identities WHERE person_id=?2) THEN 1 ELSE 0 END n` },
  { category: 'learning_identity', countSql: () => personCount('learning_identity_links', " AND x.status='active'"), collisionSql: () =>
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM learning_identity_links WHERE person_id=?1 AND status='active')
      AND EXISTS (SELECT 1 FROM learning_identity_links WHERE person_id=?2 AND status='active') THEN 1 ELSE 0 END n` },
  { category: 'active_credential', countSql: (backend) => backend === 'supabase' ? `SELECT
      ((SELECT COUNT(*) FROM people p WHERE p.id=?1 AND p.calendar_token IS NOT NULL AND p.calendar_token<>'')
      +(SELECT COUNT(*) FROM tokens x WHERE x.person_id=?1 AND x.used_at IS NULL AND x.expires_at::timestamptz>CURRENT_TIMESTAMP)
      +(SELECT COUNT(*) FROM identity_challenges x WHERE x.person_id=?1 AND x.consumed_at IS NULL AND x.superseded_at IS NULL AND x.expires_at::timestamptz>CURRENT_TIMESTAMP)
      +(SELECT COUNT(*) FROM group_attendance_tokens x WHERE x.person_id=?1 AND x.used_at IS NULL AND x.expires_at::timestamptz>CURRENT_TIMESTAMP)
      +(SELECT COUNT(*) FROM learning_google_oauth_states x WHERE x.actor_person_id=?1 AND x.expires_at::timestamptz>CURRENT_TIMESTAMP)
      +(SELECT COUNT(*) FROM learning_canvas_oauth_states x WHERE x.actor_person_id=?1 AND x.expires_at::timestamptz>CURRENT_TIMESTAMP)
      +(SELECT COUNT(*) FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
        WHERE (h.expected_person_id=?1 OR h.expected_reachable_owner_person_id=?1)
          AND c.state='open' AND h.expires_at::timestamptz>CURRENT_TIMESTAMP)) n` : `SELECT
      ((SELECT COUNT(*) FROM people p WHERE p.id=?1 AND p.calendar_token IS NOT NULL AND p.calendar_token<>'')
      +(SELECT COUNT(*) FROM tokens x WHERE x.person_id=?1 AND x.used_at IS NULL AND julianday(x.expires_at)>julianday('now'))
      +(SELECT COUNT(*) FROM identity_challenges x WHERE x.person_id=?1 AND x.consumed_at IS NULL AND x.superseded_at IS NULL AND julianday(x.expires_at)>julianday('now'))
      +(SELECT COUNT(*) FROM group_attendance_tokens x WHERE x.person_id=?1 AND x.used_at IS NULL AND julianday(x.expires_at)>julianday('now'))
      +(SELECT COUNT(*) FROM learning_google_oauth_states x WHERE x.actor_person_id=?1 AND julianday(x.expires_at)>julianday('now'))
      +(SELECT COUNT(*) FROM learning_canvas_oauth_states x WHERE x.actor_person_id=?1 AND julianday(x.expires_at)>julianday('now'))
      +(SELECT COUNT(*) FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
        WHERE (h.expected_person_id=?1 OR h.expected_reachable_owner_person_id=?1)
          AND c.state='open' AND julianday(h.expires_at)>julianday('now'))) n`, collisionSql: () => zeroCollision },
  { category: 'campus_membership', countSql: () => personCount('campus_memberships', ' AND x.active=1'), collisionSql: () =>
    `SELECT COUNT(*) n FROM campus_memberships a JOIN campus_memberships b ON a.campus_id=b.campus_id
      WHERE a.person_id=?1 AND b.person_id=?2 AND a.active=1 AND b.active=1` },
  { category: 'contact_link', countSql: () => personCount('person_contact_links', ' AND x.ended_at IS NULL'), collisionSql: () =>
    `SELECT COUNT(*) n FROM person_contact_links a JOIN person_contact_links b
      ON (a.contact_point_id=b.contact_point_id OR (a.is_primary=1 AND b.is_primary=1 AND a.kind=b.kind))
      WHERE a.person_id=?1 AND b.person_id=?2 AND a.ended_at IS NULL AND b.ended_at IS NULL` },
  { category: 'group_membership', countSql: () => personCount('group_members', ' AND x.removed_at IS NULL'), collisionSql: () =>
    `SELECT COUNT(*) n FROM group_members a JOIN group_members b ON a.group_id=b.group_id
      WHERE a.person_id=?1 AND b.person_id=?2 AND a.removed_at IS NULL AND b.removed_at IS NULL` },
  { category: 'team_membership', countSql: () => personCount('team_members'), collisionSql: () =>
    `SELECT COUNT(*) n FROM team_members a JOIN team_members b ON a.team_id=b.team_id WHERE a.person_id=?1 AND b.person_id=?2` },
  { category: 'roster_assignment', countSql: () => personCount('roster_assignments', ' AND x.deleted_at IS NULL'), collisionSql: () =>
    `SELECT COUNT(*) n FROM roster_assignments a JOIN roster_assignments b ON a.plan_id=b.plan_id AND a.position_id=b.position_id
      WHERE a.person_id=?1 AND b.person_id=?2 AND a.deleted_at IS NULL AND b.deleted_at IS NULL` },
  { category: 'person_interest', countSql: () => personCount('person_interests'), collisionSql: () =>
    `SELECT COUNT(*) n FROM person_interests a JOIN person_interests b ON a.category=b.category WHERE a.person_id=?1 AND b.person_id=?2` },
  { category: 'source_record', countSql: () =>
    'SELECT COUNT(*) n FROM identity_source_records x WHERE x.linked_person_id=?1 OR x.provisional_person_id=?1', collisionSql: () =>
    `SELECT COUNT(*) n FROM identity_source_records a JOIN identity_source_records b ON a.campus_id=b.campus_id AND a.source=b.source
      WHERE (a.linked_person_id=?1 OR a.provisional_person_id=?1) AND (b.linked_person_id=?2 OR b.provisional_person_id=?2)` },
  { category: 'canonical_key', countSql: () => personCount('identity_person_canonical_keys', ' AND x.is_current=1'), collisionSql: () =>
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM identity_person_canonical_keys a JOIN identity_person_canonical_keys b
      ON a.person_id=?1 AND b.person_id=?2 AND a.is_current=1 AND b.is_current=1
      AND ((a.legacy_email_key IS NOT NULL AND a.legacy_email_key=b.legacy_email_key)
        OR (a.normalized_name_key IS NOT NULL AND a.normalized_name_key=b.normalized_name_key))) THEN 1 ELSE 0 END n` },
  { category: 'event_admin', countSql: (backend) => backend === 'supabase' ? personCount('event_admins') : zeroCount,
    collisionSql: (backend) => backend === 'supabase' ? `SELECT COUNT(*) n FROM event_admins a JOIN event_admins b
      ON a.reg_event_id=b.reg_event_id WHERE a.person_id=?1 AND b.person_id=?2` : zeroCollision },
] as const;

type HardConflictQuery = Readonly<{ referenceKey: string; sql: (backend: SnapshotBackend) => string | null }>;
const HARD_CONFLICT_QUERIES: readonly HardConflictQuery[] = [
  { referenceKey: 'verified_contact_owners.person_id', sql: () => 'SELECT COUNT(*) n FROM verified_contact_owners WHERE person_id=?1' },
  { referenceKey: 'household_members.person_id', sql: () => 'SELECT COUNT(*) n FROM household_members WHERE person_id=?1' },
  { referenceKey: 'person_external_identities.person_id', sql: () => 'SELECT COUNT(*) n FROM person_external_identities WHERE person_id=?1' },
  { referenceKey: 'learning_identity_links.person_id', sql: () => "SELECT COUNT(*) n FROM learning_identity_links WHERE person_id=?1 AND status='active'" },
  { referenceKey: 'planning_center_person_mappings.person_id', sql: () => "SELECT COUNT(*) n FROM planning_center_person_mappings WHERE person_id=?1 AND match_state='matched'" },
  { referenceKey: 'identity_source_records.provisional_person_id', sql: () => 'SELECT COUNT(*) n FROM identity_source_records WHERE provisional_person_id=?1' },
  { referenceKey: 'identity_newcomer_intents.provisional_person_id', sql: () => 'SELECT COUNT(*) n FROM identity_newcomer_intents WHERE provisional_person_id=?1' },
  { referenceKey: 'identity_person_canonical_keys.person_id', sql: () => 'SELECT COUNT(*) n FROM identity_person_canonical_keys WHERE person_id=?1 AND is_current=1' },
  { referenceKey: 'identity_source_provisional_operations.reserved_person_id', sql: () => 'SELECT COUNT(*) n FROM identity_source_provisional_operations WHERE reserved_person_id=?1' },
  { referenceKey: 'identity_source_provisional_receipts.person_id', sql: () => 'SELECT COUNT(*) n FROM identity_source_provisional_receipts WHERE person_id=?1' },
  { referenceKey: 'identity_account_operations.reserved_person_id', sql: () => 'SELECT COUNT(*) n FROM identity_account_operations WHERE reserved_person_id=?1' },
  { referenceKey: 'external_ids.entity_id', sql: () => "SELECT COUNT(*) n FROM external_ids WHERE entity='people' AND entity_id=?1" },
  { referenceKey: 'campus_memberships.person_id', sql: () => `SELECT COUNT(*) n FROM campus_memberships
    WHERE person_id=?1 AND (role<>'member' OR finance<>0 OR admin_areas<>'')` },
  { referenceKey: 'group_members.person_id', sql: () =>
    'SELECT COUNT(*) n FROM group_members WHERE person_id=?1 AND is_admin=1' },
  { referenceKey: 'team_members.person_id', sql: () =>
    'SELECT COUNT(*) n FROM team_members WHERE person_id=?1 AND is_leader=1' },
  { referenceKey: 'people.merged_into_person_id', sql: () =>
    'SELECT COUNT(*) n FROM people WHERE merged_into_person_id=?1' },
  // Closed, intentionally unsupported mutable references. A non-zero loser
  // count blocks the preview; no generic identifier or partial handler exists.
  { referenceKey: 'activity_score_config.updated_by_person_id', sql: () =>
    'SELECT COUNT(*) n FROM activity_score_config WHERE updated_by_person_id=?1' },
  { referenceKey: 'blockout_dates.person_id', sql: () => 'SELECT COUNT(*) n FROM blockout_dates WHERE person_id=?1' },
  { referenceKey: 'group_join_requests.person_id', sql: () => 'SELECT COUNT(*) n FROM group_join_requests WHERE person_id=?1' },
  { referenceKey: 'learning_activity_events.person_id', sql: () => 'SELECT COUNT(*) n FROM learning_activity_events WHERE person_id=?1' },
  { referenceKey: 'learning_canvas_oauth_states.actor_person_id', sql: () =>
    'SELECT COUNT(*) n FROM learning_canvas_oauth_states WHERE actor_person_id=?1' },
  { referenceKey: 'learning_google_oauth_states.actor_person_id', sql: () =>
    'SELECT COUNT(*) n FROM learning_google_oauth_states WHERE actor_person_id=?1' },
  { referenceKey: 'identity_recovery_holds.expected_person_id', sql: (backend) => backend === 'supabase'
    ? `SELECT COUNT(*) n FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
      WHERE (h.expected_person_id=?1 OR h.expected_reachable_owner_person_id=?1)
        AND c.state='open' AND h.expires_at::timestamptz>CURRENT_TIMESTAMP`
    : `SELECT COUNT(*) n FROM identity_recovery_holds h JOIN identity_recovery_cases c ON c.id=h.case_id
      WHERE (h.expected_person_id=?1 OR h.expected_reachable_owner_person_id=?1)
        AND c.state='open' AND julianday(h.expires_at)>julianday('now')` },
  { referenceKey: 'learning_programs.created_by_person_id', sql: () =>
    'SELECT COUNT(*) n FROM learning_programs WHERE created_by_person_id=?1' },
  { referenceKey: 'learning_programs.updated_by_person_id', sql: () =>
    'SELECT COUNT(*) n FROM learning_programs WHERE updated_by_person_id=?1' },
  { referenceKey: 'learning_provider_connections.created_by_person_id', sql: () =>
    'SELECT COUNT(*) n FROM learning_provider_connections WHERE created_by_person_id=?1' },
  { referenceKey: 'learning_provider_connections.updated_by_person_id', sql: () =>
    'SELECT COUNT(*) n FROM learning_provider_connections WHERE updated_by_person_id=?1' },
  { referenceKey: 'ministries.leader_person_id', sql: () => 'SELECT COUNT(*) n FROM ministries WHERE leader_person_id=?1' },
  { referenceKey: 'newcomer_submissions.assignee_person_id', sql: () =>
    'SELECT COUNT(*) n FROM newcomer_submissions WHERE assignee_person_id=?1' },
  { referenceKey: 'person_interests.person_id', sql: () => 'SELECT COUNT(*) n FROM person_interests WHERE person_id=?1' },
  { referenceKey: 'roster_assignments.person_id', sql: () => 'SELECT COUNT(*) n FROM roster_assignments WHERE person_id=?1' },
  { referenceKey: 'team_applications.person_id', sql: () => 'SELECT COUNT(*) n FROM team_applications WHERE person_id=?1' },
  { referenceKey: 'testimonies.person_id', sql: () => 'SELECT COUNT(*) n FROM testimonies WHERE person_id=?1' },
  { referenceKey: 'event_admins.person_id', sql: (backend) => backend === 'supabase'
    ? 'SELECT COUNT(*) n FROM event_admins WHERE person_id=?1' : null },
  { referenceKey: 'gifts.person_id', sql: (backend) => backend === 'supabase'
    ? 'SELECT COUNT(*) n FROM gifts WHERE person_id=?1' : null },
  { referenceKey: 'registrations.person_id', sql: (backend) => backend === 'supabase'
    ? 'SELECT COUNT(*) n FROM registrations WHERE person_id=?1' : null },
  { referenceKey: 'recurring_gifts.person_id', sql: (backend) => backend === 'supabase' ? 'SELECT COUNT(*) n FROM recurring_gifts WHERE person_id=?1' : null },
] as const;

function boundedId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_ID) throw new Error(`identity_merge_invalid_${label}`);
  return Number(value);
}
function canonicalTime(value?: string): string {
  const now = value ?? new Date().toISOString();
  const parsed = Date.parse(now);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== now) throw new Error('identity_merge_invalid_time');
  return now;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const CORE_REFERENCES = [
  { referenceKey: 'gift_results.person_id', policy: 'subject_repoint',
    selectSql: 'SELECT CAST(id AS TEXT) local_row_id FROM gift_results WHERE person_id=?1 ORDER BY id' },
  { referenceKey: 'identity_observations.linked_person_id', policy: 'subject_repoint',
    selectSql: 'SELECT CAST(id AS TEXT) local_row_id FROM identity_observations WHERE linked_person_id=?1 ORDER BY id' },
  { referenceKey: 'identity_source_records.linked_person_id', policy: 'subject_repoint',
    selectSql: 'SELECT CAST(id AS TEXT) local_row_id FROM identity_source_records WHERE linked_person_id=?1 ORDER BY id' },
  { referenceKey: 'newcomer_submissions.linked_person_id', policy: 'subject_repoint',
    selectSql: 'SELECT CAST(id AS TEXT) local_row_id FROM newcomer_submissions WHERE linked_person_id=?1 ORDER BY id' },
  { referenceKey: 'person_notes.person_id', policy: 'subject_repoint',
    selectSql: 'SELECT CAST(id AS TEXT) local_row_id FROM person_notes WHERE person_id=?1 ORDER BY id' },
  { referenceKey: 'person_contact_links.person_id', policy: 'dedupe_then_repoint',
    selectSql: 'SELECT CAST(id AS TEXT) local_row_id FROM person_contact_links WHERE person_id=?1 ORDER BY id' },
  { referenceKey: 'group_members.person_id', policy: 'dedupe_then_repoint',
    selectSql: 'SELECT CAST(id AS TEXT) local_row_id FROM group_members WHERE person_id=?1 AND is_admin=0 ORDER BY id' },
  { referenceKey: 'team_members.person_id', policy: 'dedupe_then_repoint',
    selectSql: 'SELECT CAST(team_id AS TEXT) local_row_id FROM team_members WHERE person_id=?1 AND is_leader=0 ORDER BY team_id' },
  { referenceKey: 'campus_memberships.person_id', policy: 'dedupe_then_repoint',
    selectSql: `SELECT CAST(campus_id AS TEXT) local_row_id FROM campus_memberships
      WHERE person_id=?1 AND role='member' AND finance=0 AND admin_areas='' ORDER BY campus_id` },
  { referenceKey: 'tokens.person_id', policy: 'security_revoke',
    selectSql: 'SELECT CAST(id AS TEXT) local_row_id FROM tokens WHERE person_id=?1 AND used_at IS NULL ORDER BY id' },
  { referenceKey: 'identity_challenges.person_id', policy: 'security_revoke',
    selectSql: `SELECT CAST(id AS TEXT) local_row_id FROM identity_challenges
      WHERE person_id=?1 AND consumed_at IS NULL AND superseded_at IS NULL ORDER BY id` },
  { referenceKey: 'group_attendance_tokens.person_id', policy: 'security_revoke',
    selectSql: `SELECT CAST(id AS TEXT) local_row_id FROM group_attendance_tokens
      WHERE person_id=?1 AND used_at IS NULL ORDER BY id` },
  { referenceKey: 'people.calendar_token', policy: 'security_revoke',
    selectSql: `SELECT CAST(id AS TEXT) local_row_id FROM people
      WHERE id=?1 AND calendar_token IS NOT NULL AND calendar_token<>''` },
] as const;
type CoreReferenceKey = typeof CORE_REFERENCES[number]['referenceKey'];
export const IDENTITY_MERGE_EXECUTION_COVERAGE_KEYS = Object.freeze([
  ...CORE_REFERENCES.map(({ referenceKey }) => referenceKey),
  ...HARD_CONFLICT_QUERIES.map(({ referenceKey }) => referenceKey),
]);

async function loadExecutionInventory(
  db: AppDb,
  backend: SnapshotBackend,
  loserPersonId: number,
  canonicalPersonId: number,
): Promise<readonly IdentityMergeReferenceFact[]> {
  const statements: AppStatement[] = [];
  for (const reference of CORE_REFERENCES) {
    statements.push(db.prepare(reference.selectSql).bind(loserPersonId));
    statements.push(db.prepare(reference.selectSql).bind(canonicalPersonId));
  }
  const results = await readSnapshotBatch<{ local_row_id: string }>(db, backend, statements);
  const facts: IdentityMergeReferenceFact[] = [];
  let resultIndex = 0;
  for (const reference of CORE_REFERENCES) {
    for (const side of ['loser', 'canonical'] as const) {
      for (const row of results[resultIndex++]?.results ?? []) {
        const localRowId = String(row.local_row_id);
        facts.push(Object.freeze({
          referenceKey: reference.referenceKey,
          policy: reference.policy,
          side,
          localRowId,
          rowKeyHash: await sha256({ referenceKey: reference.referenceKey, side, localRowId }),
        }));
      }
    }
  }
  return Object.freeze(facts.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))));
}
function resultCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_ID) throw new Error('identity_merge_invalid_count');
  return parsed;
}
function active(person: PersonRow | undefined): person is PersonRow {
  return Boolean(person && person.active === 1 && person.deleted_at === null
    && person.identity_state === 'active' && person.auth_disabled_at === null);
}

async function loadBinding(db: AppDb, input: IdentityMergePlanInput) {
  const caseId = boundedId(input.caseId, 'case');
  const loserId = boundedId(input.loserPersonId, 'loser');
  const canonicalId = boundedId(input.canonicalPersonId, 'canonical');
  const requesterId = boundedId(input.requestedByPersonId, 'requester');
  if (loserId === canonicalId) throw new Error('identity_merge_pair_invalid');
  if (input.backend !== 'd1' && input.backend !== 'supabase') throw new Error('identity_merge_backend_invalid');
  if (!input.scope || (input.scope.kind !== 'global' && input.scope.kind !== 'campus')) throw new Error('identity_merge_scope_invalid');
  const campusId = input.scope.kind === 'campus' ? boundedId(input.scope.campusId, 'campus') : null;
  const personSql = `SELECT id,identity_version,session_epoch,role,super_admin,finance,admin_areas,active,deleted_at,
    identity_state,auth_disabled_at,stripe_customer_id,calendar_token FROM people WHERE id=?1`;
  const results = await readSnapshotBatch<CaseRow | PersonRow | { ok: number }>(db, input.backend, [
    db.prepare('SELECT id,campus_id,person_a_id,person_b_id,state,version FROM identity_resolution_cases WHERE id=?1').bind(caseId),
    db.prepare(personSql).bind(loserId), db.prepare(personSql).bind(canonicalId), db.prepare(personSql).bind(requesterId),
    campusId === null ? db.prepare('SELECT 1 ok') : db.prepare(`SELECT 1 ok FROM campus_memberships
      WHERE campus_id=?1 AND person_id=?2 AND active=1 AND role='admin'`).bind(campusId, requesterId),
  ]);
  const resolutionCase = results[0].results[0] as CaseRow | undefined;
  const loser = results[1].results[0] as PersonRow | undefined;
  const canonical = results[2].results[0] as PersonRow | undefined;
  const requester = results[3].results[0] as PersonRow | undefined;
  if (!resolutionCase || resolutionCase.state !== 'same_person'
    || !((resolutionCase.person_a_id === loserId && resolutionCase.person_b_id === canonicalId)
      || (resolutionCase.person_a_id === canonicalId && resolutionCase.person_b_id === loserId))) {
    throw new Error('identity_merge_requires_confirmed_same_person');
  }
  if (input.scope.kind === 'campus' && resolutionCase.campus_id !== campusId) throw new Error('identity_merge_case_scope_mismatch');
  if (!active(loser) || !active(canonical)) throw new Error('identity_merge_identity_inactive');
  if (!active(requester) || requester.role !== 'admin'
    || (input.scope.kind === 'global' ? requester.super_admin !== 1 : results[4].results.length !== 1)) {
    throw new Error('identity_merge_forbidden');
  }
  return { resolutionCase, loser, canonical };
}

async function loadRiskFacts(db: AppDb, backend: SnapshotBackend, loserId: number, canonicalId: number): Promise<IdentityMergeRiskFacts> {
  const statements: AppStatement[] = [];
  for (const query of RISK_QUERIES) statements.push(
    db.prepare(query.countSql(backend)).bind(loserId),
    db.prepare(query.countSql(backend)).bind(canonicalId),
    db.prepare(query.collisionSql(backend)).bind(loserId, canonicalId),
  );
  const results = await readSnapshotBatch<{ n: number }>(db, backend, statements);
  const facts = {} as Record<IdentityMergeRiskFactCategory, IdentityMergeRiskFact>;
  RISK_QUERIES.forEach(({ category }, index) => {
    const loserCount = resultCount(results[index * 3].results[0]?.n);
    const canonicalCount = resultCount(results[index * 3 + 1].results[0]?.n);
    facts[category] = Object.freeze({
      loserCount, canonicalCount, presenceCount: loserCount + canonicalCount,
      collisionCount: resultCount(results[index * 3 + 2].results[0]?.n),
    });
  });
  return facts as IdentityMergeRiskFacts;
}

async function loadHardConflictBlockers(db: AppDb, backend: SnapshotBackend, loserId: number): Promise<readonly string[]> {
  const selected = HARD_CONFLICT_QUERIES.flatMap((query) => {
    const sql = query.sql(backend);
    return sql ? [{ referenceKey: query.referenceKey, sql }] : [];
  });
  const results = await readSnapshotBatch<{ n: number }>(db, backend,
    selected.map(({ sql }) => db.prepare(sql).bind(loserId)));
  return selected.filter((_, index) => resultCount(results[index].results[0]?.n) > 0)
    .map(({ referenceKey }) => referenceKey).sort();
}

function privileges(loser: PersonRow, canonical: PersonRow): readonly ('admin_area' | 'finance' | 'role' | 'super_admin')[] {
  const result = new Set<'admin_area' | 'finance' | 'role' | 'super_admin'>();
  for (const person of [loser, canonical]) {
    if (person.admin_areas !== '') result.add('admin_area');
    if (person.finance === 1) result.add('finance');
    if (person.role === 'admin') result.add('role');
    if (person.super_admin === 1) result.add('super_admin');
  }
  return [...result].sort();
}

export async function previewIdentityMerge(db: AppDb, input: IdentityMergePlanInput): Promise<IdentityMergePreview> {
  const now = canonicalTime(input.now);
  const { resolutionCase: caseRow, loser, canonical } = await loadBinding(db, input);
  const facts = await loadRiskFacts(db, input.backend, loser.id, canonical.id);
  const blockers = await loadHardConflictBlockers(db, input.backend, loser.id);
  const referenceFacts = await loadExecutionInventory(db, input.backend, loser.id, canonical.id);
  const riskState = await buildIdentityMergeRiskState({ privilegedCategories: privileges(loser, canonical), facts });
  const risk = await classifyIdentityMergeRisk(riskState);
  const resolutionCase = await buildIdentityMergeResolutionCaseBinding({
    caseId: caseRow.id, caseVersion: caseRow.version, campusId: caseRow.campus_id,
    personAId: caseRow.person_a_id, personBId: caseRow.person_b_id, state: 'same_person',
  });
  const snapshot = await buildIdentityMergePreviewSnapshot({
    loser: { personId: loser.id, identityVersion: loser.identity_version, sessionEpoch: loser.session_epoch },
    canonical: { personId: canonical.id, identityVersion: canonical.identity_version, sessionEpoch: canonical.session_epoch },
    resolutionCase, scope: input.scope, riskState,
    counts: {
      active_credentials: facts.active_credential.presenceCount,
      campus_memberships: facts.campus_membership.presenceCount,
      contact_links: facts.contact_link.presenceCount,
      external_identities: facts.external_identity.presenceCount,
      group_memberships: facts.group_membership.presenceCount,
      households: facts.household.presenceCount,
      learning_identities: facts.learning_identity.presenceCount,
      person_interests: facts.person_interest.presenceCount,
      recurring_gifts: facts.stripe_recurring.presenceCount,
      roster_assignments: facts.roster_assignment.presenceCount,
      source_records: facts.source_record.presenceCount,
      team_memberships: facts.team_membership.presenceCount,
      verified_contact_owners: facts.verified_contact_owner.presenceCount,
      event_admins: facts.event_admin.presenceCount,
    },
    decisions: {}, expiresAt: new Date(Date.parse(now) + PREVIEW_TTL_MS).toISOString(),
  });
  const inventory = referenceFacts.map(({ referenceKey, policy, side, localRowId, rowKeyHash }) =>
    ({ referenceKey, policy, side, localRowId, rowKeyHash }));
  const expectedMutationCount = referenceFacts.filter(({ side }) => side === 'loser').length;
  const expectedIrreversibleCount = referenceFacts.filter(({ side, policy }) =>
    side === 'loser' && policy === 'security_revoke').length;
  return Object.freeze({
    snapshot, previewHash: await hashIdentityMergePreview(snapshot), inventoryHash: await sha256(inventory),
    inventoryCount: inventory.length, expectedMutationCount, expectedIrreversibleCount,
    blockers: Object.freeze(blockers), risk: risk.level, requiredApprovals: risk.requiredApprovals,
    referenceFacts,
  });
}

export async function createIdentityMergeOperation(db: AppDb, input: IdentityMergePlanInput): Promise<Readonly<{
  status: 'created'; operationId: string; version: 1; preview: IdentityMergePreview;
}>> {
  const preview = await previewIdentityMerge(db, input);
  if (preview.blockers.length) throw new Error('identity_merge_hard_conflict');
  const operationId = crypto.randomUUID();
  const { snapshot } = preview;
  const statements: AppStatement[] = [db.prepare(`INSERT INTO person_merge_operations(
    operation_id,loser_person_id,canonical_person_id,resolution_case_id,expected_resolution_case_version,resolution_case_hash,
    scope_kind,campus_id,expected_loser_identity_version,expected_loser_session_epoch,
    expected_canonical_identity_version,expected_canonical_session_epoch,preview_hash,preview_version,preview_expires_at,
    risk,risk_state_hash,risk_state_version,required_approvals,state,requested_by_person_id)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,1,?14,?15,?16,1,?17,'previewed',?18)`)
    .bind(operationId, snapshot.loser.personId, snapshot.canonical.personId, snapshot.resolutionCase.caseId,
      snapshot.resolutionCase.caseVersion, snapshot.resolutionCase.hash, snapshot.scope.kind,
      snapshot.scope.kind === 'campus' ? snapshot.scope.campusId : null,
      snapshot.loser.identityVersion, snapshot.loser.sessionEpoch,
      snapshot.canonical.identityVersion, snapshot.canonical.sessionEpoch,
      preview.previewHash, snapshot.expiresAt, preview.risk, snapshot.riskState.hash,
      preview.requiredApprovals, input.requestedByPersonId)];
  for (const category of IDENTITY_MERGE_RISK_FACT_CATEGORIES) {
    const fact = snapshot.riskState.facts[category];
    statements.push(db.prepare(`INSERT INTO person_merge_risk_facts(
      operation_id,category,loser_count,canonical_count,presence_count,collision_count,risk_state_hash,risk_state_version)
      VALUES(?1,?2,?3,?4,?5,?6,?7,1)`).bind(operationId, category, fact.loserCount,
      fact.canonicalCount, fact.presenceCount, fact.collisionCount, snapshot.riskState.hash));
  }
  for (const fact of preview.referenceFacts) {
    statements.push(db.prepare(`INSERT INTO person_merge_reference_facts(
      operation_id,reference_key,policy,side,local_row_id,row_key_hash) VALUES(?1,?2,?3,?4,?5,?6)`)
      .bind(operationId, fact.referenceKey, fact.policy, fact.side, fact.localRowId, fact.rowKeyHash));
  }
  statements.push(db.prepare(`INSERT INTO person_merge_execution_seals(
    operation_id,expected_operation_version,expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
    expected_resolution_case_version,expected_resolution_case_hash,inventory_hash,inventory_count,
    expected_mutation_count,expected_irreversible_count) VALUES(?1,1,?2,?3,1,?4,?5,?6,?7,?8,?9)`)
    .bind(operationId, preview.previewHash, snapshot.riskState.hash, snapshot.resolutionCase.caseVersion,
      snapshot.resolutionCase.hash, preview.inventoryHash, preview.inventoryCount,
      preview.expectedMutationCount, preview.expectedIrreversibleCount));
  try { await db.batch(statements); }
  catch (error) { throw new Error('identity_merge_create_stale', { cause: error }); }
  return Object.freeze({ status: 'created', operationId, version: 1, preview });
}

const OPERATION_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const DECISION_CATEGORIES = new Set([
  'campus_membership', 'contact_owner', 'external_identity', 'household', 'learning_identity',
  'privilege', 'recurring_gift', 'unique_collision',
] as const);
const MERGE_DECISIONS = new Set([
  'canonical_only', 'dedupe', 'keep_both', 'manual_required', 'preserve_history', 'reject', 'revoke_loser',
] as const);
export type IdentityMergeDecisionCategory = 'campus_membership' | 'contact_owner' | 'external_identity'
  | 'household' | 'learning_identity' | 'privilege' | 'recurring_gift' | 'unique_collision';
export type IdentityMergeDecision = 'canonical_only' | 'dedupe' | 'keep_both' | 'manual_required'
  | 'preserve_history' | 'reject' | 'revoke_loser';
type OperationBindingRow = Readonly<{
  operation_id: string; state: string; version: number; preview_hash: string; risk_state_hash: string;
  risk_state_version: number; expected_resolution_case_version: number; resolution_case_hash: string;
  risk: 'normal' | 'high' | 'critical'; required_approvals: 1 | 2; scope_kind: 'global' | 'campus'; campus_id: number | null;
}>;

function operationId(value: unknown): string {
  if (typeof value !== 'string' || !OPERATION_ID_RE.test(value)) throw new Error('identity_merge_operation_invalid');
  return value;
}
async function operationBinding(db: AppDb, value: unknown): Promise<OperationBindingRow> {
  const id = operationId(value);
  const row = await db.prepare(`SELECT operation_id,state,version,preview_hash,risk_state_hash,risk_state_version,
    expected_resolution_case_version,resolution_case_hash,risk,required_approvals,scope_kind,campus_id
    FROM person_merge_operations WHERE operation_id=?1`).bind(id).first<OperationBindingRow>();
  if (!row) throw new Error('identity_merge_operation_not_found');
  return row;
}
async function assertOperationActor(db: AppDb, operation: OperationBindingRow, actorPersonId: number): Promise<void> {
  const actor = boundedId(actorPersonId, 'actor');
  const eligible = await db.prepare(`SELECT 1 ok FROM people p WHERE p.id=?1 AND p.role='admin'
    AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
    AND (?2='campus' OR p.super_admin=1)
    AND (?4='normal' OR p.super_admin=1)
    AND (?2='global' OR EXISTS (SELECT 1 FROM campus_memberships cm
      WHERE cm.person_id=p.id AND cm.campus_id=?3 AND cm.active=1 AND cm.role='admin'))`)
    .bind(actor, operation.scope_kind, operation.campus_id, operation.risk).first<number>('ok');
  if (eligible !== 1) throw new Error('identity_merge_forbidden');
}

export async function recordIdentityMergeDecision(db: AppDb, input: Readonly<{
  operationId: string; expectedVersion: number; decidedByPersonId: number;
  category: IdentityMergeDecisionCategory; decision: IdentityMergeDecision;
}>): Promise<Readonly<{ status: 'recorded'; operationId: string; version: number }>> {
  const operation = await operationBinding(db, input.operationId);
  const expectedVersion = boundedId(input.expectedVersion, 'version');
  if (operation.version !== expectedVersion || !['previewed', 'awaiting_approval'].includes(operation.state)) {
    throw new Error('identity_merge_decision_stale');
  }
  if (!DECISION_CATEGORIES.has(input.category) || !MERGE_DECISIONS.has(input.decision)) {
    throw new Error('identity_merge_decision_invalid');
  }
  if (input.category === 'privilege' && input.decision !== 'canonical_only') {
    throw new Error('identity_merge_privilege_requires_canonical_only');
  }
  await assertOperationActor(db, operation, input.decidedByPersonId);
  try {
    await db.prepare(`INSERT INTO person_merge_conflict_decisions(
      decision_id,operation_id,category,decision,decided_by_person_id,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`)
      .bind(crypto.randomUUID(), operation.operation_id, input.category, input.decision,
        input.decidedByPersonId, expectedVersion, operation.preview_hash, operation.risk_state_hash,
        operation.risk_state_version, operation.expected_resolution_case_version, operation.resolution_case_hash).run();
  } catch (error) { throw new Error('identity_merge_decision_stale', { cause: error }); }
  return Object.freeze({ status: 'recorded', operationId: operation.operation_id, version: operation.version });
}

export async function submitIdentityMergeForApproval(db: AppDb, input: Readonly<{
  operationId: string; expectedVersion: number; actorPersonId: number;
}>): Promise<Readonly<{ status: 'awaiting_approval'; operationId: string; version: number }>> {
  const operation = await operationBinding(db, input.operationId);
  const expectedVersion = boundedId(input.expectedVersion, 'version');
  if (operation.state !== 'previewed' || operation.version !== expectedVersion) throw new Error('identity_merge_submit_stale');
  await assertOperationActor(db, operation, input.actorPersonId);
  try {
    const changed = await db.prepare(`UPDATE person_merge_operations SET state='awaiting_approval',version=version+1,
      updated_at=CURRENT_TIMESTAMP WHERE operation_id=?1 AND state='previewed' AND version=?2`)
      .bind(operation.operation_id, expectedVersion).run();
    if (changed.meta.changes !== 1) throw new Error('identity_merge_submit_stale');
  } catch (error) { throw new Error('identity_merge_submit_stale', { cause: error }); }
  return Object.freeze({ status: 'awaiting_approval', operationId: operation.operation_id, version: expectedVersion + 1 });
}

export type IdentityMergeApprovalDelivery = Readonly<{
  to: string; publicId: string; code: string; expiresAt: string;
}>;
export type BeginIdentityMergeApprovalInput = Readonly<{
  operationId: string;
  expectedVersion: number;
  approverPersonId: number;
  campusId: number;
  requestContext: IdentityTrustedRequestContext;
  source?: IdentityChallengeSource;
  now?: string;
}>;

export async function beginIdentityMergeApproval(
  db: AppDb,
  env: IdentityAuthEnv,
  input: BeginIdentityMergeApprovalInput,
): Promise<Readonly<{ status: 'issued'; operationId: string; version: number; delivery: IdentityMergeApprovalDelivery }>> {
  const operation = await operationBinding(db, input.operationId);
  const expectedVersion = boundedId(input.expectedVersion, 'version');
  const approverPersonId = boundedId(input.approverPersonId, 'approver');
  const campusId = boundedId(input.campusId, 'campus');
  if (operation.state !== 'awaiting_approval' || operation.version !== expectedVersion) {
    throw new Error('identity_merge_approval_stale');
  }
  await assertOperationActor(db, operation, approverPersonId);
  if (operation.scope_kind === 'campus' && operation.campus_id !== campusId) throw new Error('identity_merge_approval_scope');
  const approver = await db.prepare(`SELECT p.identity_version,c.normalized_value,c.display_value FROM people p
    JOIN verified_contact_owners owner ON owner.person_id=p.id
    JOIN contact_points c ON c.id=owner.contact_point_id AND c.kind='email'
    JOIN person_contact_links link ON link.person_id=p.id AND link.contact_point_id=c.id AND link.ended_at IS NULL
    JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=?2 AND cm.active=1 AND cm.role='admin'
    WHERE p.id=?1 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
    ORDER BY owner.verified_at DESC,c.id LIMIT 1`).bind(approverPersonId, campusId)
    .first<{ identity_version: number; normalized_value: string; display_value: string }>();
  if (!approver) throw new Error('identity_merge_approval_unavailable');
  const binding: IdentityMergeStepUpBinding = Object.freeze({
    operation_id: operation.operation_id,
    operation_version: operation.version,
    preview_hash: operation.preview_hash,
    risk_state_hash: operation.risk_state_hash,
    risk_state_version: operation.risk_state_version,
    resolution_case_version: operation.expected_resolution_case_version,
    resolution_case_hash: operation.resolution_case_hash,
    approver_person_id: approverPersonId,
    approver_identity_version: approver.identity_version,
    campus_id: campusId,
  });
  const prepared = await prepareIdentityMergeStepUpChallenge(db, env, {
    campusId, email: approver.normalized_value, targetPersonId: approverPersonId,
    requestContext: input.requestContext, binding, source: input.source ?? 'admin', now: input.now,
  });
  if (prepared.limited) throw new Error('identity_rate_limited');
  await db.batch(prepared.statements);
  return Object.freeze({
    status: 'issued', operationId: operation.operation_id, version: operation.version,
    delivery: Object.freeze({ to: approver.display_value, publicId: prepared.publicId,
      code: prepared.code, expiresAt: prepared.expiresAt }),
  });
}

export type CompleteIdentityMergeApprovalInput = Readonly<{
  operationId: string;
  expectedVersion: number;
  approverPersonId: number;
  campusId: number;
  publicId: string;
  code: string;
  decision?: 'approve' | 'reject';
  source?: IdentityChallengeSource;
  now?: string;
}>;

function canonicalSqlNow(value?: string): string {
  if (value === undefined) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  const parsed = new Date(`${value.replace(' ', 'T')}Z`);
  const canonical = Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 19).replace('T', ' ') : '';
  if (canonical !== value) throw new Error('identity_clock_invalid');
  return canonical;
}

/** Normalize D1 text, PostgreSQL text/timestamptz, and postgres.js Date values. */
function databaseTimeMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
  const trimmed = value.trim();
  const timezoneFree = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed);
  const isoLike = trimmed.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  return Date.parse(timezoneFree ? `${isoLike}Z` : isoLike);
}

function databaseTimeExpired(expiresAt: unknown, now: string): boolean {
  const expiryMs = databaseTimeMs(expiresAt);
  const nowMs = databaseTimeMs(now);
  return !Number.isFinite(expiryMs) || !Number.isFinite(nowMs) || expiryMs <= nowMs;
}

function exactMergeApprovalBinding(value: string, expected: IdentityMergeStepUpBinding): boolean {
  try {
    const parsed = JSON.parse(value) as { person_merge_approval?: unknown };
    return canonicalJson(parsed.person_merge_approval) === canonicalJson(expected);
  } catch { return false; }
}

export async function completeIdentityMergeApproval(
  db: AppDb,
  env: IdentityAuthEnv,
  input: CompleteIdentityMergeApprovalInput,
): Promise<Readonly<{ status: 'invalid' } | { status: 'awaiting_approval' | 'approved' | 'cancelled'; operationId: string; version: number }>> {
  const operation = await operationBinding(db, input.operationId);
  const expectedVersion = boundedId(input.expectedVersion, 'version');
  const approverPersonId = boundedId(input.approverPersonId, 'approver');
  const campusId = boundedId(input.campusId, 'campus');
  const now = canonicalSqlNow(input.now);
  if (operation.version !== expectedVersion || operation.state !== 'awaiting_approval') return { status: 'invalid' };
  await assertOperationActor(db, operation, approverPersonId);
  if (operation.scope_kind === 'campus' && operation.campus_id !== campusId) return { status: 'invalid' };
  const challenge = await db.prepare(`SELECT challenge.id,challenge.person_id,challenge.expected_session_epoch,
    challenge.code_hash,challenge.context_json,challenge.attempts,challenge.max_attempts,challenge.expires_at,
    challenge.consumed_at,challenge.superseded_at,p.identity_version,p.session_epoch
    FROM identity_challenges challenge JOIN people p ON p.id=challenge.person_id
    WHERE challenge.campus_id=?1 AND challenge.public_id=?2 AND challenge.purpose='step_up'
      AND challenge.request_source=?3 AND challenge.person_id=?4`)
    .bind(campusId, input.publicId, input.source ?? 'admin', approverPersonId).first<{
      id: number; person_id: number; expected_session_epoch: number; code_hash: string; context_json: string;
      attempts: number; max_attempts: number; expires_at: string; consumed_at: string | null;
      superseded_at: string | null; identity_version: number; session_epoch: number;
    }>();
  if (!challenge || challenge.expected_session_epoch !== challenge.session_epoch || challenge.superseded_at !== null
    || challenge.consumed_at !== null || databaseTimeExpired(challenge.expires_at, now)
    || challenge.attempts >= challenge.max_attempts) {
    return { status: 'invalid' };
  }
  const binding: IdentityMergeStepUpBinding = Object.freeze({
    operation_id: operation.operation_id, operation_version: operation.version,
    preview_hash: operation.preview_hash, risk_state_hash: operation.risk_state_hash,
    risk_state_version: operation.risk_state_version,
    resolution_case_version: operation.expected_resolution_case_version,
    resolution_case_hash: operation.resolution_case_hash,
    approver_person_id: approverPersonId, approver_identity_version: challenge.identity_version, campus_id: campusId,
  });
  if (!exactMergeApprovalBinding(challenge.context_json, binding)) return { status: 'invalid' };
  const secret = env.IDENTITY_VERIFICATION_SECRET;
  if (typeof secret !== 'string') throw new Error('identity_verification_unavailable');
  const candidate = await hmacIdentityValue(secret, `otp:step_up:${input.source ?? 'admin'}`,
    `${input.publicId}\0${approverPersonId}\0${typeof input.code === 'string' ? input.code : ''}`);
  if (!constantTimeIdentityHashEqual(challenge.code_hash, candidate)) {
    await consumeEmailOtpChallenge(db, env, {
      campusId, publicId: input.publicId, purpose: 'step_up', code: input.code,
      source: input.source ?? 'admin', now,
    });
    return { status: 'invalid' };
  }
  const existing = await db.prepare(`SELECT approval_id FROM person_merge_approvals
    WHERE operation_id=?1 AND approver_person_id=?2 AND step_up_challenge_id=?3`)
    .bind(operation.operation_id, approverPersonId, challenge.id).first<string>('approval_id');
  if (existing) {
    const replay = await operationBinding(db, operation.operation_id);
    return Object.freeze({ status: replay.state === 'approved' ? 'approved' : 'awaiting_approval',
      operationId: replay.operation_id, version: replay.version });
  }
  const decision = input.decision ?? 'approve';
  if (decision !== 'approve' && decision !== 'reject') return { status: 'invalid' };
  const approvalId = crypto.randomUUID();
  try {
    const results = await db.batch([
      db.prepare(`UPDATE identity_challenges SET consumed_at=?6
        WHERE id=?1 AND person_id=?2 AND expected_session_epoch=?3 AND code_hash=?4
          AND attempts<max_attempts AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>?6
          AND context_json=?5`).bind(challenge.id, approverPersonId, challenge.session_epoch, candidate, challenge.context_json, now),
      db.prepare(`INSERT INTO person_merge_approvals(
        approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,
        expected_operation_version,expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES(?1,?2,?3,?4,(SELECT COUNT(*)+1 FROM person_merge_approvals WHERE operation_id=?2),?5,
          ?6,?7,?8,?9,?10,?11)`).bind(approvalId, operation.operation_id, approverPersonId, challenge.id,
        decision, operation.version, operation.preview_hash, operation.risk_state_hash, operation.risk_state_version,
        operation.expected_resolution_case_version, operation.resolution_case_hash),
      decision === 'approve'
        ? db.prepare(`UPDATE person_merge_operations SET state='approved',version=version+1,updated_at=CURRENT_TIMESTAMP
          WHERE operation_id=?1 AND state='awaiting_approval' AND version=?2
            AND required_approvals<=(SELECT COUNT(*) FROM person_merge_approvals
              WHERE operation_id=?1 AND decision='approve' AND expected_operation_version=?2)`)
          .bind(operation.operation_id, operation.version)
        : db.prepare(`UPDATE person_merge_operations SET state='cancelled',version=version+1,updated_at=CURRENT_TIMESTAMP
          WHERE operation_id=?1 AND state='awaiting_approval' AND version=?2`).bind(operation.operation_id, operation.version),
      db.prepare('SELECT state,version FROM person_merge_operations WHERE operation_id=?1').bind(operation.operation_id),
    ]);
    if (results[0].meta.changes !== 1) return { status: 'invalid' };
    const final = results[3].results[0] as { state: string; version: number } | undefined;
    if (!final) return { status: 'invalid' };
    const status = final.state === 'approved' ? 'approved' : final.state === 'cancelled' ? 'cancelled' : 'awaiting_approval';
    return Object.freeze({ status, operationId: operation.operation_id, version: final.version });
  } catch { return { status: 'invalid' }; }
}

export type ExecuteIdentityMergeInput = Readonly<{
  backend: SnapshotBackend;
  operationId: string;
  expectedVersion: number;
  actorPersonId: number;
}>;
type ExecutionOperationRow = OperationBindingRow & Readonly<{
  loser_person_id: number; canonical_person_id: number; resolution_case_id: number;
  expected_loser_identity_version: number; expected_loser_session_epoch: number;
  expected_canonical_identity_version: number; expected_canonical_session_epoch: number;
}>;

function coreMutationStatement(
  db: AppDb,
  referenceKey: IdentityMergeReferenceFact['referenceKey'],
  localRowId: string,
  loserPersonId: number,
  canonicalPersonId: number,
): AppStatement {
  switch (referenceKey) {
    case 'gift_results.person_id':
      return db.prepare('UPDATE gift_results SET person_id=?3 WHERE id=?1 AND person_id=?2')
        .bind(localRowId, loserPersonId, canonicalPersonId);
    case 'identity_observations.linked_person_id':
      return db.prepare(`UPDATE identity_observations SET linked_person_id=?3,updated_at=CURRENT_TIMESTAMP
        WHERE id=?1 AND linked_person_id=?2`).bind(localRowId, loserPersonId, canonicalPersonId);
    case 'identity_source_records.linked_person_id':
      return db.prepare(`UPDATE identity_source_records SET linked_person_id=?3,updated_at=CURRENT_TIMESTAMP
        WHERE id=?1 AND state='linked' AND linked_person_id=?2`).bind(localRowId, loserPersonId, canonicalPersonId);
    case 'newcomer_submissions.linked_person_id':
      return db.prepare('UPDATE newcomer_submissions SET linked_person_id=?3 WHERE id=?1 AND linked_person_id=?2')
        .bind(localRowId, loserPersonId, canonicalPersonId);
    case 'person_notes.person_id':
      return db.prepare('UPDATE person_notes SET person_id=?3 WHERE id=?1 AND person_id=?2')
        .bind(localRowId, loserPersonId, canonicalPersonId);
    case 'person_contact_links.person_id':
      return db.prepare('UPDATE person_contact_links SET person_id=?3 WHERE id=?1 AND person_id=?2')
        .bind(localRowId, loserPersonId, canonicalPersonId);
    case 'group_members.person_id':
      return db.prepare('UPDATE group_members SET person_id=?3 WHERE id=?1 AND person_id=?2 AND is_admin=0')
        .bind(localRowId, loserPersonId, canonicalPersonId);
    case 'team_members.person_id':
      return db.prepare(`UPDATE team_members SET person_id=?3
        WHERE team_id=?1 AND person_id=?2 AND is_leader=0`).bind(localRowId, loserPersonId, canonicalPersonId);
    case 'campus_memberships.person_id':
      return db.prepare(`UPDATE campus_memberships SET person_id=?3,updated_at=CURRENT_TIMESTAMP
        WHERE campus_id=?1 AND person_id=?2 AND role='member' AND finance=0 AND admin_areas=''`)
        .bind(localRowId, loserPersonId, canonicalPersonId);
    case 'tokens.person_id':
      return db.prepare(`UPDATE tokens SET used_at=CURRENT_TIMESTAMP
        WHERE id=?1 AND person_id=?2 AND used_at IS NULL`).bind(localRowId, loserPersonId);
    case 'identity_challenges.person_id':
      return db.prepare(`UPDATE identity_challenges SET superseded_at=CURRENT_TIMESTAMP
        WHERE id=?1 AND person_id=?2 AND consumed_at IS NULL AND superseded_at IS NULL`).bind(localRowId, loserPersonId);
    case 'group_attendance_tokens.person_id':
      return db.prepare(`UPDATE group_attendance_tokens SET used_at=CURRENT_TIMESTAMP
        WHERE id=?1 AND person_id=?2 AND used_at IS NULL`).bind(localRowId, loserPersonId);
    case 'people.calendar_token':
      return db.prepare(`UPDATE people SET calendar_token=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE id=?1 AND id=?2 AND calendar_token IS NOT NULL AND calendar_token<>''`).bind(localRowId, loserPersonId);
  }
}

export async function executeIdentityMerge(
  db: AppDb,
  input: ExecuteIdentityMergeInput,
): Promise<Readonly<{ status: 'completed'; operationId: string; version: 5; mutationCount: number }>> {
  if (input.backend !== 'd1' && input.backend !== 'supabase') throw new Error('identity_merge_backend_invalid');
  const id = operationId(input.operationId);
  const expectedVersion = boundedId(input.expectedVersion, 'version');
  const operation = await db.prepare(`SELECT operation_id,state,version,preview_hash,risk_state_hash,risk_state_version,
    expected_resolution_case_version,resolution_case_hash,risk,required_approvals,scope_kind,campus_id,
    loser_person_id,canonical_person_id,resolution_case_id,expected_loser_identity_version,expected_loser_session_epoch,
    expected_canonical_identity_version,expected_canonical_session_epoch
    FROM person_merge_operations WHERE operation_id=?1`).bind(id).first<ExecutionOperationRow>();
  if (!operation || operation.state !== 'approved' || operation.version !== expectedVersion || expectedVersion !== 3) {
    throw new Error('identity_merge_execute_stale');
  }
  await assertOperationActor(db, operation, input.actorPersonId);
  const seal = await db.prepare(`SELECT inventory_hash,inventory_count,expected_mutation_count,expected_irreversible_count
    FROM person_merge_execution_seals WHERE operation_id=?1`).bind(id).first<{
      inventory_hash: string; inventory_count: number; expected_mutation_count: number; expected_irreversible_count: number;
    }>();
  if (!seal) throw new Error('identity_merge_execution_coverage_blocked');
  const currentFacts = await loadExecutionInventory(db, input.backend, operation.loser_person_id, operation.canonical_person_id);
  if ((await loadHardConflictBlockers(db, input.backend, operation.loser_person_id)).length !== 0) {
    throw new Error('identity_merge_execution_coverage_blocked');
  }
  const currentInventoryHash = await sha256(currentFacts.map(({ referenceKey, policy, side, localRowId, rowKeyHash }) =>
    ({ referenceKey, policy, side, localRowId, rowKeyHash })));
  const mutations = currentFacts.filter((fact) => fact.side === 'loser');
  if (currentInventoryHash !== seal.inventory_hash || currentFacts.length !== seal.inventory_count
    || mutations.length !== seal.expected_mutation_count) throw new Error('identity_merge_execution_inventory_drift');
  const unsafeCollisionCount = await db.prepare(`SELECT COALESCE(SUM(collision_count),0) n
    FROM person_merge_risk_facts WHERE operation_id=?1
      AND category IN ('campus_membership','contact_link','group_membership','team_membership')`)
    .bind(id).first<number>('n');
  if (Number(unsafeCollisionCount) !== 0) throw new Error('identity_merge_execution_coverage_blocked');

  const statements: AppStatement[] = [db.prepare(`UPDATE person_merge_operations
    SET state='executing',version=version+1,updated_at=CURRENT_TIMESTAMP
    WHERE operation_id=?1 AND state='approved' AND version=?2`).bind(id, expectedVersion)];
  let sequence = 0;
  for (const fact of mutations) {
    const mutationReceiptId = crypto.randomUUID();
    const journalId = crypto.randomUUID();
    const beforeHash = await sha256({ referenceKey: fact.referenceKey, localRowId: fact.localRowId,
      personId: operation.loser_person_id });
    const afterHash = await sha256({ referenceKey: fact.referenceKey, localRowId: fact.localRowId,
      personId: operation.canonical_person_id });
    statements.push(db.prepare(`INSERT INTO person_merge_mutation_receipts(
      mutation_receipt_id,operation_id,execution_version,reference_key,policy,row_key_hash,
      loser_person_id,canonical_person_id,scope_kind,campus_id,affected_count)
      VALUES(?1,?2,4,?3,?4,?5,?6,?7,?8,?9,1)`)
      .bind(mutationReceiptId, id, fact.referenceKey, fact.policy, fact.rowKeyHash, operation.loser_person_id,
        operation.canonical_person_id, operation.scope_kind, operation.campus_id));
    statements.push(coreMutationStatement(db, fact.referenceKey, fact.localRowId,
      operation.loser_person_id, operation.canonical_person_id));
    statements.push(db.prepare(`INSERT INTO person_merge_reassignment_journal(
      journal_id,operation_id,mutation_receipt_id,sequence,reference_key,policy,row_key_hash,affected_count)
      VALUES(?1,?2,?3,?4,?5,?6,?7,1)`)
      .bind(journalId, id, mutationReceiptId, ++sequence, fact.referenceKey, fact.policy, fact.rowKeyHash));
    statements.push(db.prepare(`INSERT INTO person_merge_journal_row_details(
      journal_id,operation_id,before_local_row_id,after_local_row_id,before_row_hash,after_row_hash,
      rollback_mode,affected_count) VALUES(?1,?2,?3,?3,?4,?5,?6,1)`)
      .bind(journalId, id, fact.localRowId, beforeHash, afterHash,
        fact.policy === 'security_revoke' ? 'security_irreversible' : 'reversible'));
  }
  statements.push(
    db.prepare(`UPDATE people SET active=0,identity_state='merged',merged_into_person_id=?2,
      auth_disabled_at=CURRENT_TIMESTAMP,calendar_token=NULL,identity_version=identity_version+1,
      session_epoch=session_epoch+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=?1 AND active=1 AND deleted_at IS NULL AND identity_state='active' AND auth_disabled_at IS NULL
        AND identity_version=?3 AND session_epoch=?4`).bind(operation.loser_person_id, operation.canonical_person_id,
      operation.expected_loser_identity_version, operation.expected_loser_session_epoch),
    db.prepare(`UPDATE people SET identity_version=identity_version+1,session_epoch=session_epoch+1,
      updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND active=1 AND deleted_at IS NULL
      AND identity_state='active' AND auth_disabled_at IS NULL AND identity_version=?2 AND session_epoch=?3`)
      .bind(operation.canonical_person_id, operation.expected_canonical_identity_version,
        operation.expected_canonical_session_epoch),
    db.prepare(`INSERT INTO person_merge_redirects(loser_person_id,canonical_person_id,merge_operation_id)
      VALUES(?1,?2,?3)`).bind(operation.loser_person_id, operation.canonical_person_id, id),
    db.prepare(`UPDATE identity_resolution_cases SET state='merged',version=version+1,
      reviewer_person_id=?3,resolved_at=CURRENT_TIMESTAMP WHERE id=?1 AND state='same_person' AND version=?2`)
      .bind(operation.resolution_case_id, operation.expected_resolution_case_version, input.actorPersonId),
    db.prepare(`UPDATE person_merge_operations SET state='completed',version=version+1,updated_at=CURRENT_TIMESTAMP
      WHERE operation_id=?1 AND state='executing' AND version=4`).bind(id),
  );
  try { await db.batch(statements); }
  catch (error) { throw new Error('identity_merge_execute_stale', { cause: error }); }
  return Object.freeze({ status: 'completed', operationId: id, version: 5, mutationCount: mutations.length });
}
type RollbackBindingRow = Readonly<{
  rollback_id: string; operation_id: string; expected_operation_version: number; journal_hash: string;
  journal_count: number; required_approvals: 1 | 2; state: string; version: number; expires_at: string | Date;
  risk: 'normal' | 'high' | 'critical'; scope_kind: 'global' | 'campus'; campus_id: number | null;
}>;
async function rollbackBinding(db: AppDb, rollbackIdValue: unknown): Promise<RollbackBindingRow> {
  const rollbackId = operationId(rollbackIdValue);
  const row = await db.prepare(`SELECT rollback.rollback_id,rollback.operation_id,rollback.expected_operation_version,
    rollback.journal_hash,rollback.journal_count,rollback.required_approvals,rollback.state,rollback.version,
    rollback.expires_at,op.risk,op.scope_kind,op.campus_id
    FROM person_merge_rollback_operations rollback JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
    WHERE rollback.rollback_id=?1`).bind(rollbackId).first<RollbackBindingRow>();
  if (!row) throw new Error('identity_merge_rollback_not_found');
  return row;
}
function rollbackAsOperation(row: RollbackBindingRow): OperationBindingRow {
  return {
    operation_id: row.operation_id, state: row.state, version: row.version, preview_hash: row.journal_hash,
    risk_state_hash: row.journal_hash, risk_state_version: 1, expected_resolution_case_version: 1,
    resolution_case_hash: row.journal_hash, risk: row.risk, required_approvals: row.required_approvals,
    scope_kind: row.scope_kind, campus_id: row.campus_id,
  };
}
type JournalSealRow = Readonly<{
  journal_id: string; sequence: number; reference_key: CoreReferenceKey; policy: string; row_key_hash: string;
  before_local_row_id: string; after_local_row_id: string; before_row_hash: string; after_row_hash: string;
  rollback_mode: 'reversible' | 'security_irreversible';
}>;
async function rollbackJournal(db: AppDb, operationIdValue: string): Promise<readonly JournalSealRow[]> {
  const rows = await db.prepare(`SELECT journal.journal_id,journal.sequence,journal.reference_key,journal.policy,
    journal.row_key_hash,detail.before_local_row_id,detail.after_local_row_id,detail.before_row_hash,
    detail.after_row_hash,detail.rollback_mode FROM person_merge_reassignment_journal journal
    JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
    WHERE journal.operation_id=?1 ORDER BY journal.sequence`).bind(operationIdValue).all<JournalSealRow>();
  return Object.freeze(rows.results.map(Object.freeze));
}
async function journalSealHash(rows: readonly JournalSealRow[]): Promise<string> {
  return sha256(rows.map((row) => ({ journalId: row.journal_id, sequence: row.sequence,
    referenceKey: row.reference_key, policy: row.policy, rowKeyHash: row.row_key_hash,
    beforeLocalRowId: row.before_local_row_id, afterLocalRowId: row.after_local_row_id,
    beforeRowHash: row.before_row_hash, afterRowHash: row.after_row_hash, rollbackMode: row.rollback_mode })));
}

export async function createIdentityMergeRollback(db: AppDb, input: Readonly<{
  operationId: string; expectedVersion: number; requestedByPersonId: number; now?: string;
}>): Promise<Readonly<{ status: 'awaiting_approval'; rollbackId: string; operationId: string; version: 2; expiresAt: string }>> {
  const operation = await operationBinding(db, input.operationId);
  const expectedVersion = boundedId(input.expectedVersion, 'version');
  if (operation.state !== 'completed' || operation.version !== expectedVersion) throw new Error('identity_merge_rollback_stale');
  await assertOperationActor(db, operation, input.requestedByPersonId);
  const rows = await rollbackJournal(db, operation.operation_id);
  const now = canonicalSqlNow(input.now);
  const completed = await db.prepare('SELECT updated_at FROM person_merge_operations WHERE operation_id=?1')
    .bind(operation.operation_id).first<unknown>('updated_at');
  const completedAt = databaseTimeMs(completed);
  const nowAt = databaseTimeMs(now);
  if (!Number.isFinite(completedAt) || !Number.isFinite(nowAt) || nowAt >= completedAt + 24 * 60 * 60_000) {
    throw new Error('identity_merge_rollback_expired');
  }
  const expiresAt = new Date(completedAt + 24 * 60 * 60_000).toISOString();
  const rollbackId = crypto.randomUUID();
  const journalHash = await journalSealHash(rows);
  try {
    await db.batch([
      db.prepare(`INSERT INTO person_merge_rollback_operations(
        rollback_id,operation_id,expected_operation_version,journal_hash,journal_count,required_approvals,
        state,version,requested_by_person_id,expires_at)
        VALUES(?1,?2,?3,?4,?5,?6,'previewed',1,?7,?8)`)
        .bind(rollbackId, operation.operation_id, expectedVersion, journalHash, rows.length,
          operation.required_approvals, input.requestedByPersonId, expiresAt),
      db.prepare(`UPDATE person_merge_rollback_operations SET state='awaiting_approval',version=2,updated_at=CURRENT_TIMESTAMP
        WHERE rollback_id=?1 AND state='previewed' AND version=1`).bind(rollbackId),
    ]);
  } catch (error) { throw new Error('identity_merge_rollback_stale', { cause: error }); }
  return Object.freeze({ status: 'awaiting_approval', rollbackId, operationId: operation.operation_id, version: 2, expiresAt });
}

export type BeginIdentityMergeRollbackApprovalInput = Readonly<{
  rollbackId: string; expectedVersion: number; approverPersonId: number; campusId: number;
  requestContext: IdentityTrustedRequestContext; source?: IdentityChallengeSource; now?: string;
}>;
export async function beginIdentityMergeRollbackApproval(
  db: AppDb,
  env: IdentityAuthEnv,
  input: BeginIdentityMergeRollbackApprovalInput,
): Promise<Readonly<{ status: 'issued'; rollbackId: string; operationId: string; version: number; delivery: IdentityMergeApprovalDelivery }>> {
  const rollback = await rollbackBinding(db, input.rollbackId);
  const expectedVersion = boundedId(input.expectedVersion, 'version');
  const approverPersonId = boundedId(input.approverPersonId, 'approver');
  const campusId = boundedId(input.campusId, 'campus');
  const now = canonicalSqlNow(input.now);
  if (rollback.state !== 'awaiting_approval' || rollback.version !== expectedVersion
    || databaseTimeExpired(rollback.expires_at, now)) {
    throw new Error('identity_merge_rollback_approval_stale');
  }
  await assertOperationActor(db, rollbackAsOperation(rollback), approverPersonId);
  if (rollback.scope_kind === 'campus' && rollback.campus_id !== campusId) throw new Error('identity_merge_rollback_approval_scope');
  const approver = await db.prepare(`SELECT p.identity_version,c.normalized_value,c.display_value FROM people p
    JOIN verified_contact_owners owner ON owner.person_id=p.id JOIN contact_points c ON c.id=owner.contact_point_id AND c.kind='email'
    JOIN person_contact_links link ON link.person_id=p.id AND link.contact_point_id=c.id AND link.ended_at IS NULL
    JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=?2 AND cm.active=1 AND cm.role='admin'
    WHERE p.id=?1 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
    ORDER BY owner.verified_at DESC,c.id LIMIT 1`).bind(approverPersonId, campusId)
    .first<{ identity_version: number; normalized_value: string; display_value: string }>();
  if (!approver) throw new Error('identity_merge_rollback_approval_unavailable');
  const binding: IdentityMergeRollbackStepUpBinding = Object.freeze({
    rollback_id: rollback.rollback_id, rollback_version: rollback.version, operation_id: rollback.operation_id,
    expected_operation_version: rollback.expected_operation_version, journal_hash: rollback.journal_hash,
    journal_count: rollback.journal_count, approver_person_id: approverPersonId,
    approver_identity_version: approver.identity_version, campus_id: campusId,
  });
  const prepared = await prepareIdentityMergeRollbackStepUpChallenge(db, env, {
    campusId, email: approver.normalized_value, targetPersonId: approverPersonId, requestContext: input.requestContext,
    binding, source: input.source ?? 'admin', now: input.now,
  });
  if (prepared.limited) throw new Error('identity_rate_limited');
  await db.batch(prepared.statements);
  return Object.freeze({ status: 'issued', rollbackId: rollback.rollback_id, operationId: rollback.operation_id,
    version: rollback.version, delivery: Object.freeze({ to: approver.display_value, publicId: prepared.publicId,
      code: prepared.code, expiresAt: prepared.expiresAt }) });
}

export type CompleteIdentityMergeRollbackApprovalInput = Readonly<{
  rollbackId: string; expectedVersion: number; approverPersonId: number; campusId: number;
  publicId: string; code: string; decision?: 'approve' | 'reject'; source?: IdentityChallengeSource; now?: string;
}>;
function exactRollbackApprovalBinding(value: string, expected: IdentityMergeRollbackStepUpBinding): boolean {
  try { return canonicalJson((JSON.parse(value) as { person_merge_rollback_approval?: unknown }).person_merge_rollback_approval)
    === canonicalJson(expected); } catch { return false; }
}
export async function completeIdentityMergeRollbackApproval(
  db: AppDb,
  env: IdentityAuthEnv,
  input: CompleteIdentityMergeRollbackApprovalInput,
): Promise<Readonly<{ status: 'invalid' } | { status: 'awaiting_approval' | 'approved' | 'cancelled'; rollbackId: string; operationId: string; version: number }>> {
  const rollback = await rollbackBinding(db, input.rollbackId);
  const expectedVersion = boundedId(input.expectedVersion, 'version');
  const approverPersonId = boundedId(input.approverPersonId, 'approver');
  const campusId = boundedId(input.campusId, 'campus');
  const now = canonicalSqlNow(input.now);
  if (rollback.state !== 'awaiting_approval' || rollback.version !== expectedVersion
    || databaseTimeExpired(rollback.expires_at, now)) return { status: 'invalid' };
  await assertOperationActor(db, rollbackAsOperation(rollback), approverPersonId);
  const challenge = await db.prepare(`SELECT challenge.id,challenge.expected_session_epoch,challenge.code_hash,
    challenge.context_json,challenge.attempts,challenge.max_attempts,challenge.expires_at,challenge.consumed_at,
    challenge.superseded_at,p.identity_version,p.session_epoch FROM identity_challenges challenge JOIN people p ON p.id=challenge.person_id
    WHERE challenge.campus_id=?1 AND challenge.public_id=?2 AND challenge.purpose='step_up'
      AND challenge.request_source=?3 AND challenge.person_id=?4`)
    .bind(campusId, input.publicId, input.source ?? 'admin', approverPersonId).first<{
      id: number; expected_session_epoch: number; code_hash: string; context_json: string; attempts: number;
      max_attempts: number; expires_at: string; consumed_at: string | null; superseded_at: string | null;
      identity_version: number; session_epoch: number;
    }>();
  if (!challenge || challenge.expected_session_epoch !== challenge.session_epoch || challenge.attempts >= challenge.max_attempts
    || databaseTimeExpired(challenge.expires_at, now)
    || challenge.consumed_at !== null || challenge.superseded_at !== null) return { status: 'invalid' };
  const binding: IdentityMergeRollbackStepUpBinding = Object.freeze({
    rollback_id: rollback.rollback_id, rollback_version: rollback.version, operation_id: rollback.operation_id,
    expected_operation_version: rollback.expected_operation_version, journal_hash: rollback.journal_hash,
    journal_count: rollback.journal_count, approver_person_id: approverPersonId,
    approver_identity_version: challenge.identity_version, campus_id: campusId,
  });
  if (!exactRollbackApprovalBinding(challenge.context_json, binding)) return { status: 'invalid' };
  const secret = env.IDENTITY_VERIFICATION_SECRET;
  if (typeof secret !== 'string') throw new Error('identity_verification_unavailable');
  const candidate = await hmacIdentityValue(secret, `otp:step_up:${input.source ?? 'admin'}`,
    `${input.publicId}\0${approverPersonId}\0${typeof input.code === 'string' ? input.code : ''}`);
  if (!constantTimeIdentityHashEqual(challenge.code_hash, candidate)) {
    await consumeEmailOtpChallenge(db, env, { campusId, publicId: input.publicId, purpose: 'step_up',
      code: input.code, source: input.source ?? 'admin', now });
    return { status: 'invalid' };
  }
  const decision = input.decision ?? 'approve';
  if (decision !== 'approve' && decision !== 'reject') return { status: 'invalid' };
  try {
    const results = await db.batch([
      db.prepare(`UPDATE identity_challenges SET consumed_at=?6 WHERE id=?1 AND person_id=?2
        AND expected_session_epoch=?3 AND code_hash=?4 AND context_json=?5 AND attempts<max_attempts
        AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>?6`)
        .bind(challenge.id, approverPersonId, challenge.session_epoch, candidate, challenge.context_json, now),
      db.prepare(`INSERT INTO person_merge_rollback_approvals(
        approval_id,rollback_id,approver_person_id,step_up_challenge_id,approval_order,decision,
        expected_rollback_version,expected_journal_hash)
        VALUES(?1,?2,?3,?4,(SELECT COUNT(*)+1 FROM person_merge_rollback_approvals WHERE rollback_id=?2),?5,?6,?7)`)
        .bind(crypto.randomUUID(), rollback.rollback_id, approverPersonId, challenge.id,
          decision, rollback.version, rollback.journal_hash),
      decision === 'approve'
        ? db.prepare(`UPDATE person_merge_rollback_operations SET state='approved',version=version+1,updated_at=CURRENT_TIMESTAMP
          WHERE rollback_id=?1 AND state='awaiting_approval' AND version=?2
            AND required_approvals<=(SELECT COUNT(*) FROM person_merge_rollback_approvals
              WHERE rollback_id=?1 AND decision='approve' AND expected_rollback_version=?2)`)
          .bind(rollback.rollback_id, rollback.version)
        : db.prepare(`UPDATE person_merge_rollback_operations SET state='cancelled',version=version+1,updated_at=CURRENT_TIMESTAMP
          WHERE rollback_id=?1 AND state='awaiting_approval' AND version=?2`).bind(rollback.rollback_id, rollback.version),
      db.prepare('SELECT state,version FROM person_merge_rollback_operations WHERE rollback_id=?1').bind(rollback.rollback_id),
    ]);
    if (results[0].meta.changes !== 1) return { status: 'invalid' };
    const final = results[3].results[0] as { state: string; version: number } | undefined;
    if (!final) return { status: 'invalid' };
    const status = final.state === 'approved' ? 'approved' : final.state === 'cancelled' ? 'cancelled' : 'awaiting_approval';
    return Object.freeze({ status, rollbackId: rollback.rollback_id, operationId: rollback.operation_id, version: final.version });
  } catch { return { status: 'invalid' }; }
}
function rollbackCoreStatement(
  db: AppDb,
  row: JournalSealRow,
  loserPersonId: number,
  canonicalPersonId: number,
): AppStatement {
  switch (row.reference_key) {
    case 'gift_results.person_id':
      return db.prepare('UPDATE gift_results SET person_id=?3 WHERE id=?1 AND person_id=?2')
        .bind(row.after_local_row_id, canonicalPersonId, loserPersonId);
    case 'identity_observations.linked_person_id':
      return db.prepare(`UPDATE identity_observations SET linked_person_id=?3,updated_at=CURRENT_TIMESTAMP
        WHERE id=?1 AND linked_person_id=?2`).bind(row.after_local_row_id, canonicalPersonId, loserPersonId);
    case 'identity_source_records.linked_person_id':
      return db.prepare(`UPDATE identity_source_records SET linked_person_id=?3,updated_at=CURRENT_TIMESTAMP
        WHERE id=?1 AND state='linked' AND linked_person_id=?2`).bind(row.after_local_row_id, canonicalPersonId, loserPersonId);
    case 'newcomer_submissions.linked_person_id':
      return db.prepare('UPDATE newcomer_submissions SET linked_person_id=?3 WHERE id=?1 AND linked_person_id=?2')
        .bind(row.after_local_row_id, canonicalPersonId, loserPersonId);
    case 'person_notes.person_id':
      return db.prepare('UPDATE person_notes SET person_id=?3 WHERE id=?1 AND person_id=?2')
        .bind(row.after_local_row_id, canonicalPersonId, loserPersonId);
    case 'person_contact_links.person_id':
      return db.prepare('UPDATE person_contact_links SET person_id=?3 WHERE id=?1 AND person_id=?2')
        .bind(row.after_local_row_id, canonicalPersonId, loserPersonId);
    case 'group_members.person_id':
      return db.prepare('UPDATE group_members SET person_id=?3 WHERE id=?1 AND person_id=?2 AND is_admin=0')
        .bind(row.after_local_row_id, canonicalPersonId, loserPersonId);
    case 'team_members.person_id':
      return db.prepare(`UPDATE team_members SET person_id=?3
        WHERE team_id=?1 AND person_id=?2 AND is_leader=0`).bind(row.after_local_row_id, canonicalPersonId, loserPersonId);
    case 'campus_memberships.person_id':
      return db.prepare(`UPDATE campus_memberships SET person_id=?3,updated_at=CURRENT_TIMESTAMP
        WHERE campus_id=?1 AND person_id=?2 AND role='member' AND finance=0 AND admin_areas=''`)
        .bind(row.after_local_row_id, canonicalPersonId, loserPersonId);
    default: throw new Error('identity_merge_rollback_reference_unsupported');
  }
}

export async function executeIdentityMergeRollback(db: AppDb, input: Readonly<{
  rollbackId: string; expectedVersion: number; actorPersonId: number; now?: string;
}>): Promise<Readonly<{ status: 'completed'; rollbackId: string; operationId: string; version: 5;
  revertedCount: number; skippedSecurityCount: number }>> {
  const rollback = await rollbackBinding(db, input.rollbackId);
  const expectedVersion = boundedId(input.expectedVersion, 'version');
  const now = canonicalSqlNow(input.now);
  if (rollback.state !== 'approved' || rollback.version !== expectedVersion || expectedVersion !== 3
    || databaseTimeExpired(rollback.expires_at, now)) throw new Error('identity_merge_rollback_execute_stale');
  await assertOperationActor(db, rollbackAsOperation(rollback), input.actorPersonId);
  const operation = await db.prepare(`SELECT operation_id,state,version,preview_hash,risk_state_hash,risk_state_version,
    expected_resolution_case_version,resolution_case_hash,risk,required_approvals,scope_kind,campus_id,
    loser_person_id,canonical_person_id,resolution_case_id,expected_loser_identity_version,expected_loser_session_epoch,
    expected_canonical_identity_version,expected_canonical_session_epoch
    FROM person_merge_operations WHERE operation_id=?1`).bind(rollback.operation_id).first<ExecutionOperationRow>();
  if (!operation || operation.state !== 'completed' || operation.version !== rollback.expected_operation_version) {
    throw new Error('identity_merge_rollback_execute_stale');
  }
  const rows = await rollbackJournal(db, operation.operation_id);
  if (rows.length !== rollback.journal_count || await journalSealHash(rows) !== rollback.journal_hash) {
    throw new Error('identity_merge_rollback_journal_drift');
  }
  const reversible = rows.filter((row) => row.rollback_mode === 'reversible');
  const irreversible = rows.filter((row) => row.rollback_mode === 'security_irreversible');
  const statements: AppStatement[] = [db.prepare(`UPDATE person_merge_rollback_operations
    SET state='executing',version=version+1,updated_at=CURRENT_TIMESTAMP
    WHERE rollback_id=?1 AND state='approved' AND version=?2`).bind(rollback.rollback_id, expectedVersion)];
  for (const row of rows) {
    const security = row.rollback_mode === 'security_irreversible';
    statements.push(db.prepare(`INSERT INTO person_merge_rollback_receipts(
      receipt_id,operation_id,journal_id,outcome,reverted_count,rollback_id)
      VALUES(?1,?2,?3,?4,?5,?6)`)
      .bind(crypto.randomUUID(), operation.operation_id, row.journal_id,
        security ? 'skipped' : 'reverted', security ? 0 : 1, rollback.rollback_id));
    if (!security) statements.push(rollbackCoreStatement(db, row, operation.loser_person_id, operation.canonical_person_id));
  }
  statements.push(
    db.prepare(`DELETE FROM person_merge_redirects WHERE loser_person_id=?1 AND canonical_person_id=?2
      AND merge_operation_id=?3`).bind(operation.loser_person_id, operation.canonical_person_id, operation.operation_id),
    db.prepare(`UPDATE people SET active=1,identity_state='active',merged_into_person_id=NULL,auth_disabled_at=NULL,
      identity_version=identity_version+1,session_epoch=session_epoch+1,updated_at=CURRENT_TIMESTAMP
      WHERE id=?1 AND active=0 AND identity_state='merged' AND merged_into_person_id=?2 AND auth_disabled_at IS NOT NULL
        AND identity_version=?3 AND session_epoch=?4 AND calendar_token IS NULL`)
      .bind(operation.loser_person_id, operation.canonical_person_id,
        operation.expected_loser_identity_version + 1, operation.expected_loser_session_epoch + 1),
    db.prepare(`UPDATE people SET identity_version=identity_version+1,session_epoch=session_epoch+1,
      updated_at=CURRENT_TIMESTAMP WHERE id=?1 AND active=1 AND deleted_at IS NULL AND identity_state='active'
      AND auth_disabled_at IS NULL AND identity_version=?2 AND session_epoch=?3`)
      .bind(operation.canonical_person_id, operation.expected_canonical_identity_version + 1,
        operation.expected_canonical_session_epoch + 1),
    db.prepare(`UPDATE identity_resolution_cases SET state='same_person',version=version+1,
      reviewer_person_id=?3,resolved_at=CURRENT_TIMESTAMP WHERE id=?1 AND state='merged' AND version=?2`)
      .bind(operation.resolution_case_id, operation.expected_resolution_case_version + 1, input.actorPersonId),
    db.prepare(`UPDATE person_merge_rollback_operations SET state='completed',version=version+1,
      updated_at=CURRENT_TIMESTAMP WHERE rollback_id=?1 AND state='executing' AND version=4`).bind(rollback.rollback_id),
  );
  try { await db.batch(statements); }
  catch (error) { throw new Error('identity_merge_rollback_execute_stale', { cause: error }); }
  return Object.freeze({ status: 'completed', rollbackId: rollback.rollback_id, operationId: operation.operation_id,
    version: 5, revertedCount: reversible.length, skippedSecurityCount: irreversible.length });
}
