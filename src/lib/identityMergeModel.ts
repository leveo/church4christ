export const IDENTITY_MERGE_PREVIEW_VERSION = 1 as const;
export const IDENTITY_MERGE_RISK_STATE_VERSION = 1 as const;
export const IDENTITY_MERGE_RESOLUTION_BINDING_VERSION = 2 as const;

// Closed inventory of person-bound bearer credentials counted by the merge
// risk snapshot. Global kiosk secrets and internal worker lease tokens are not
// person-bound and therefore do not belong in this list.
export const IDENTITY_MERGE_ACTIVE_CREDENTIAL_SOURCES = [
  'people.calendar_token',
  'tokens.token_hash',
  'identity_challenges.token_or_code_hash',
  'group_attendance_tokens.token_hash',
  'learning_google_oauth_states.state_hash',
  'learning_canvas_oauth_states.state_hash',
  'identity_recovery_holds.veto_token_hash',
] as const;

export const IDENTITY_MERGE_RISK_FACT_CATEGORIES = [
  'privilege', 'verified_contact_owner', 'household', 'stripe_customer', 'stripe_recurring',
  'external_identity', 'learning_identity', 'active_credential', 'campus_membership',
  'contact_link', 'group_membership', 'team_membership', 'roster_assignment', 'person_interest',
  'source_record', 'canonical_key', 'event_admin',
] as const;
const PRIVILEGED_CATEGORIES = ['admin_area', 'finance', 'role', 'super_admin'] as const;
const COUNT_CATEGORIES = [
  'active_credentials', 'campus_memberships', 'contact_links', 'external_identities', 'gifts',
  'group_memberships', 'households', 'learning_identities', 'notes', 'person_interests',
  'recurring_gifts', 'registrations', 'roster_assignments', 'source_records', 'team_memberships',
  'verified_contact_owners', 'event_admins',
] as const;
const DECISION_CATEGORIES = [
  'campus_membership', 'contact_owner', 'external_identity', 'household', 'learning_identity',
  'privilege', 'recurring_gift', 'unique_collision',
] as const;
const DECISIONS = [
  'canonical_only', 'dedupe', 'keep_both', 'manual_required', 'preserve_history', 'reject', 'revoke_loser',
] as const;

export type IdentityMergeRiskFactCategory = typeof IDENTITY_MERGE_RISK_FACT_CATEGORIES[number];
type PrivilegedCategory = typeof PRIVILEGED_CATEGORIES[number];
type CountCategory = typeof COUNT_CATEGORIES[number];
type DecisionCategory = typeof DECISION_CATEGORIES[number];
type MergeDecision = typeof DECISIONS[number];
export type IdentityMergeRiskLevel = 'normal' | 'high' | 'critical';
export type IdentityMergeRiskFact = Readonly<{
  loserCount: number;
  canonicalCount: number;
  presenceCount: number;
  collisionCount: number;
}>;
export type IdentityMergeRiskFacts = Readonly<Record<IdentityMergeRiskFactCategory, IdentityMergeRiskFact>>;
export type IdentityMergeRiskState = Readonly<{
  version: typeof IDENTITY_MERGE_RISK_STATE_VERSION;
  privilegedCategories: readonly PrivilegedCategory[];
  facts: IdentityMergeRiskFacts;
  hash: string;
}>;
export type IdentityMergeRisk = Readonly<{
  level: IdentityMergeRiskLevel;
  reasons: readonly `${'present' | 'collision'}:${IdentityMergeRiskFactCategory}`[];
  requiredApprovals: 1 | 2;
  privilegePolicy: 'canonical_only';
}>;

type PersonSnapshot = Readonly<{ personId: number; identityVersion: number; sessionEpoch: number }>;
type MergeScope = Readonly<{ kind: 'global'; campusId?: never } | { kind: 'campus'; campusId: number }>;
export type IdentityMergeResolutionCaseBinding = Readonly<{
  bindingVersion: typeof IDENTITY_MERGE_RESOLUTION_BINDING_VERSION;
  caseId: number;
  caseVersion: number;
  campusId: number;
  personAId: number;
  personBId: number;
  state: 'same_person';
  hash: string;
}>;
export type IdentityMergePreviewInput = Readonly<{
  loser: PersonSnapshot;
  canonical: PersonSnapshot;
  resolutionCase: IdentityMergeResolutionCaseBinding;
  scope: MergeScope;
  riskState: IdentityMergeRiskState;
  counts: Partial<Record<CountCategory, number>>;
  decisions: Partial<Record<DecisionCategory, MergeDecision>>;
  expiresAt: string;
}>;
export type IdentityMergePreviewSnapshot = Readonly<IdentityMergePreviewInput & {
  previewVersion: typeof IDENTITY_MERGE_PREVIEW_VERSION;
  risk: IdentityMergeRiskLevel;
  requiredApprovals: 1 | 2;
}>;

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unsupported ${label} field`);
}
function assertSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > 2_147_483_647) {
    throw new Error(`${label} count must be a bounded integer`);
  }
}
function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} hash is invalid`);
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
function personSnapshot(value: PersonSnapshot, label: string): PersonSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} snapshot is required`);
  exactKeys(value, ['personId', 'identityVersion', 'sessionEpoch'], `${label} snapshot`);
  assertSafeInteger(value.personId, `${label} person`, 1);
  assertSafeInteger(value.identityVersion, `${label} identity version`, 1);
  assertSafeInteger(value.sessionEpoch, `${label} session epoch`);
  return { personId: value.personId, identityVersion: value.identityVersion, sessionEpoch: value.sessionEpoch };
}
function sortedPrivileges(value: readonly PrivilegedCategory[]): readonly PrivilegedCategory[] {
  if (!Array.isArray(value)) throw new Error('privileged category list is required');
  const result = [...value].sort();
  if (new Set(result).size !== result.length) throw new Error('duplicate privileged category');
  if (result.some((item) => !PRIVILEGED_CATEGORIES.includes(item))) throw new Error('unsupported privileged category');
  return result;
}
function normalizedFacts(value: IdentityMergeRiskFacts): IdentityMergeRiskFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('risk facts are required');
  exactKeys(value, IDENTITY_MERGE_RISK_FACT_CATEGORIES, 'risk fact');
  const result = {} as Record<IdentityMergeRiskFactCategory, IdentityMergeRiskFact>;
  for (const category of IDENTITY_MERGE_RISK_FACT_CATEGORIES) {
    const fact = value[category];
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) throw new Error(`missing risk fact category: ${category}`);
    exactKeys(fact, ['loserCount', 'canonicalCount', 'presenceCount', 'collisionCount'], `${category} risk fact`);
    assertSafeInteger(fact.loserCount, `${category} loser`);
    assertSafeInteger(fact.canonicalCount, `${category} canonical`);
    assertSafeInteger(fact.presenceCount, `${category} presence`);
    assertSafeInteger(fact.collisionCount, `${category} collision`);
    if (fact.presenceCount !== fact.loserCount + fact.canonicalCount) {
      throw new Error(`${category} presence must equal per-side sum`);
    }
    result[category] = {
      loserCount: fact.loserCount,
      canonicalCount: fact.canonicalCount,
      presenceCount: fact.presenceCount,
      collisionCount: fact.collisionCount,
    };
  }
  return result;
}

export async function buildIdentityMergeRiskState(input: Readonly<{
  privilegedCategories: readonly PrivilegedCategory[];
  facts: IdentityMergeRiskFacts;
}>): Promise<IdentityMergeRiskState> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('risk state input is required');
  exactKeys(input, ['privilegedCategories', 'facts'], 'risk state');
  const core = {
    version: IDENTITY_MERGE_RISK_STATE_VERSION,
    privilegedCategories: sortedPrivileges(input.privilegedCategories),
    facts: normalizedFacts(input.facts),
  } as const;
  return { ...core, hash: await sha256(core) };
}
async function validateRiskState(state: IdentityMergeRiskState): Promise<IdentityMergeRiskState> {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('risk state is required');
  exactKeys(state, ['version', 'privilegedCategories', 'facts', 'hash'], 'risk state');
  if (state.version !== IDENTITY_MERGE_RISK_STATE_VERSION) throw new Error('unsupported risk state version');
  assertHash(state.hash, 'risk state');
  const { hash: _hash, version: _version, ...input } = state;
  const rebuilt = await buildIdentityMergeRiskState(input);
  if (rebuilt.hash !== state.hash) throw new Error('risk state hash mismatch');
  return rebuilt;
}
export async function classifyIdentityMergeRisk(state: IdentityMergeRiskState): Promise<IdentityMergeRisk> {
  const current = await validateRiskState(state);
  const reasons: `${'present' | 'collision'}:${IdentityMergeRiskFactCategory}`[] = [];
  for (const category of IDENTITY_MERGE_RISK_FACT_CATEGORIES) {
    if (current.facts[category].presenceCount > 0) reasons.push(`present:${category}`);
    if (current.facts[category].collisionCount > 0) reasons.push(`collision:${category}`);
  }
  const criticalCollision = ['verified_contact_owner', 'household', 'stripe_customer', 'stripe_recurring', 'external_identity', 'learning_identity']
    .some((category) => current.facts[category as IdentityMergeRiskFactCategory].collisionCount > 0);
  const critical = current.privilegedCategories.length > 0 || current.facts.privilege.presenceCount > 0
    || current.facts.stripe_recurring.presenceCount > 0 || criticalCollision;
  return {
    level: critical ? 'critical' : reasons.length ? 'high' : 'normal',
    reasons,
    requiredApprovals: reasons.length ? 2 : 1,
    privilegePolicy: 'canonical_only',
  };
}

const UNIQUE_COLLISION_FACTS: readonly IdentityMergeRiskFactCategory[] = [
  'stripe_customer', 'contact_link', 'group_membership', 'team_membership',
  'roster_assignment', 'person_interest', 'source_record', 'canonical_key', 'event_admin',
];

/** Closed mapping from risk facts to conflict decisions that must be recorded. */
export async function requiredIdentityMergeDecisions(state: IdentityMergeRiskState): Promise<readonly DecisionCategory[]> {
  const current = await validateRiskState(state);
  const required = new Set<DecisionCategory>();
  if (current.facts.campus_membership.presenceCount > 0) required.add('campus_membership');
  if (current.facts.verified_contact_owner.presenceCount > 0) required.add('contact_owner');
  if (current.facts.external_identity.presenceCount > 0) required.add('external_identity');
  if (current.facts.household.presenceCount > 0) required.add('household');
  if (current.facts.learning_identity.presenceCount > 0) required.add('learning_identity');
  if (current.privilegedCategories.length > 0 || current.facts.privilege.presenceCount > 0) required.add('privilege');
  if (current.facts.stripe_recurring.presenceCount > 0) required.add('recurring_gift');
  if (UNIQUE_COLLISION_FACTS.some((category) => current.facts[category].collisionCount > 0)) required.add('unique_collision');
  return DECISION_CATEGORIES.filter((category) => required.has(category));
}

export async function buildIdentityMergeResolutionCaseBinding(input: Readonly<{
  caseId: number; caseVersion: number; campusId: number; personAId: number; personBId: number; state: 'same_person';
}>): Promise<IdentityMergeResolutionCaseBinding> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('resolution case binding is required');
  exactKeys(input, ['caseId', 'caseVersion', 'campusId', 'personAId', 'personBId', 'state'], 'resolution case');
  assertSafeInteger(input.caseId, 'resolution case', 1); assertSafeInteger(input.caseVersion, 'resolution case version', 1);
  assertSafeInteger(input.campusId, 'resolution campus', 1);
  assertSafeInteger(input.personAId, 'resolution person A', 1); assertSafeInteger(input.personBId, 'resolution person B', 1);
  if (input.personAId === input.personBId || input.state !== 'same_person') throw new Error('confirmed same_person resolution case is required');
  const core = { bindingVersion: IDENTITY_MERGE_RESOLUTION_BINDING_VERSION, ...input } as const;
  return { ...core, hash: await sha256(core) };
}
async function validateResolutionCase(binding: IdentityMergeResolutionCaseBinding): Promise<IdentityMergeResolutionCaseBinding> {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('resolution case binding is required');
  exactKeys(binding, ['bindingVersion', 'caseId', 'caseVersion', 'campusId', 'personAId', 'personBId', 'state', 'hash'], 'resolution case binding');
  if (binding.bindingVersion !== IDENTITY_MERGE_RESOLUTION_BINDING_VERSION) throw new Error('unsupported resolution binding version');
  assertHash(binding.hash, 'resolution case');
  const { hash: _hash, bindingVersion: _bindingVersion, ...input } = binding;
  const rebuilt = await buildIdentityMergeResolutionCaseBinding(input);
  if (rebuilt.hash !== binding.hash) throw new Error('resolution case hash mismatch');
  return rebuilt;
}
function sortedSafeRecord(value: Record<string, unknown>, allowed: readonly string[], label: 'count' | 'decision') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} record is required`);
  const result: Record<string, number | MergeDecision> = {};
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) throw new Error(`unsupported ${label} category`);
    const item = value[key];
    if (label === 'count') assertSafeInteger(item, key);
    else if (typeof item !== 'string' || !DECISIONS.includes(item as MergeDecision)) throw new Error('unsupported merge decision');
    if (label === 'decision' && key === 'privilege' && item !== 'canonical_only') throw new Error('privilege decision must be canonical_only');
    result[key] = item as number | MergeDecision;
  }
  return result;
}
export async function buildIdentityMergePreviewSnapshot(input: IdentityMergePreviewInput): Promise<IdentityMergePreviewSnapshot> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('preview input is required');
  exactKeys(input, ['loser', 'canonical', 'resolutionCase', 'scope', 'riskState', 'counts', 'decisions', 'expiresAt'], 'preview');
  const loser = personSnapshot(input.loser, 'loser'); const canonical = personSnapshot(input.canonical, 'canonical');
  if (loser.personId === canonical.personId) throw new Error('merge pair must contain different people');
  const resolutionCase = await validateResolutionCase(input.resolutionCase);
  if (![loser.personId, canonical.personId].every((id) => id === resolutionCase.personAId || id === resolutionCase.personBId)) {
    throw new Error('resolution case pair mismatch');
  }
  if (!input.scope || typeof input.scope !== 'object' || Array.isArray(input.scope)) throw new Error('scope is required');
  exactKeys(input.scope, input.scope.kind === 'campus' ? ['kind', 'campusId'] : ['kind'], 'scope');
  if (input.scope.kind !== 'campus' && input.scope.kind !== 'global') throw new Error('unsupported merge scope');
  const scope: MergeScope = input.scope.kind === 'campus'
    ? (assertSafeInteger(input.scope.campusId, 'campus', 1), { kind: 'campus', campusId: input.scope.campusId }) : { kind: 'global' };
  if (scope.kind === 'campus' && resolutionCase.campusId !== scope.campusId) throw new Error('resolution case campus mismatch');
  const riskState = await validateRiskState(input.riskState); const risk = await classifyIdentityMergeRisk(riskState);
  const parsed = Date.parse(input.expiresAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== input.expiresAt) throw new Error('invalid preview expiry');
  return {
    previewVersion: IDENTITY_MERGE_PREVIEW_VERSION, loser, canonical, resolutionCase, scope, riskState,
    risk: risk.level, requiredApprovals: risk.requiredApprovals,
    counts: sortedSafeRecord(input.counts as Record<string, unknown>, COUNT_CATEGORIES, 'count') as Partial<Record<CountCategory, number>>,
    decisions: sortedSafeRecord(input.decisions as Record<string, unknown>, DECISION_CATEGORIES, 'decision') as Partial<Record<DecisionCategory, MergeDecision>>,
    expiresAt: input.expiresAt,
  };
}
async function validateSnapshot(snapshot: IdentityMergePreviewSnapshot): Promise<void> {
  if (snapshot.previewVersion !== IDENTITY_MERGE_PREVIEW_VERSION) throw new Error('unsupported preview version');
  const { previewVersion: _previewVersion, risk: _risk, requiredApprovals: _requiredApprovals, ...input } = snapshot;
  const rebuilt = await buildIdentityMergePreviewSnapshot(input);
  if (canonicalJson(rebuilt) !== canonicalJson(snapshot)) throw new Error('preview snapshot derived fields mismatch');
}
export async function hashIdentityMergePreview(snapshot: IdentityMergePreviewSnapshot): Promise<string> {
  await validateSnapshot(snapshot); return sha256(snapshot);
}
export async function assertIdentityMergePreviewFresh(snapshot: IdentityMergePreviewSnapshot, current: Readonly<{
  loser: PersonSnapshot; canonical: PersonSnapshot; resolutionCase: IdentityMergeResolutionCaseBinding;
  riskState: IdentityMergeRiskState; previewHash: string; now: string;
}>): Promise<void> {
  await validateSnapshot(snapshot);
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('current merge state is required');
  exactKeys(current, ['loser', 'canonical', 'resolutionCase', 'riskState', 'previewHash', 'now'], 'current merge state');
  const now = Date.parse(current.now);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== current.now) throw new Error('invalid current time');
  const loser = personSnapshot(current.loser, 'current loser'); const canonical = personSnapshot(current.canonical, 'current canonical');
  const resolutionCase = await validateResolutionCase(current.resolutionCase); const riskState = await validateRiskState(current.riskState);
  if (canonicalJson(snapshot.loser) !== canonicalJson(loser) || canonicalJson(snapshot.canonical) !== canonicalJson(canonical)
    || canonicalJson(snapshot.resolutionCase) !== canonicalJson(resolutionCase)
    || canonicalJson(snapshot.riskState) !== canonicalJson(riskState)) throw new Error('stale identity merge preview');
  if (now >= Date.parse(snapshot.expiresAt)) throw new Error('identity merge preview expired');
  assertHash(current.previewHash, 'preview');
  if (await hashIdentityMergePreview(snapshot) !== current.previewHash) throw new Error('identity merge preview hash mismatch');
}
