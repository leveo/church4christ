import type { AppDb, AppStatement } from './appDb';
import {
  consumeEmailLinkChallenge,
  consumeEmailOtpChallenge,
  hmacIdentityValue,
  issueEmailLinkChallenge,
  issueEmailOtpChallenge,
  prepareEmailOtpChallenge,
  verifyConsumedEmailOtpChallenge,
  type IdentityAuthEnv,
  type IdentityChallengeSource,
  type IdentityTrustedRequestContext,
} from './identityAuth';
import { findVerifiedContactOwner, normalizeIdentityContact, type ContactPoint, type VerifiedOwner } from './identityDb';
import { hasIdentityControlCharacters, normalizeName } from './identityNormalize';
import { hasRecentStepUp, RECENT_STEP_UP_SECONDS, type SessionAssurance } from './sessionAssurance';
import { exactIdentityPersonCanonicalKeyStatement, refreshIdentityPersonCanonicalKeys } from './identityCanonical';
import type { IdentityRecoveryKeyEnv } from './identityRecoveryKey';
import { prepareIdentityRecoveryNotification } from './identityRecoveryOutbox';
import type { Locale } from './locales';

// Keep route-facing response fields existence-neutral. Delivery is an internal
// instruction and must never be serialized as the public response.
type NeutralPublic = Readonly<{ accepted: true }>;
type OperationPublic = Readonly<{ accepted: true; operationId: string; expiresAt: string }>;
type OtpDelivery = Readonly<{ to: string; publicId: string; code: string; expiresAt: string }>;
type LinkDelivery = Readonly<{ to: string; publicId: string; token: string; expiresAt: string }>;

const recentStepUpBrand: unique symbol = Symbol('recent_step_up');
const utf8 = new TextEncoder();
export type RecentStepUpContext = Readonly<{ personId: number; verifiedAt: number; [recentStepUpBrand]: true }>;

type OperationKind = 'signup' | 'contact_change' | 'recovery';
type OperationRow = {
  operation_id: string; campus_id: number; kind: OperationKind; challenge_id: number; observation_id: number | null;
  target_person_id: number | null; prior_contact_point_id: number | null; reserved_person_id: number | null;
  expected_session_epoch: number | null; result_session_epoch: number | null;
  recovery_claim_hash: string | null; recovery_source_version: number;
  requested_display_name: string | null; requested_normalized_name: string | null; state: 'pending' | 'review' | 'completed';
  result_person_id: number | null; result_case_id: number | null; expires_at: string; public_id: string;
  contact_point_id: number; challenge_person_id: number | null; requester_bucket_hash: string;
};

function validId(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function operationId(): string { return crypto.randomUUID(); }
function databaseId(): number { return 1_000_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000); }
function epochSeconds(value: string): number {
  const epoch = Math.floor(new Date(`${value.replace(' ', 'T')}Z`).getTime() / 1000);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error('identity_clock_invalid');
  return epoch;
}
function cleanDisplayName(value: string): { display: string; normalized: string } {
  const display = value.trim(); const normalized = normalizeName(value);
  if (!display || utf8.encode(display).byteLength > 512 || !normalized || utf8.encode(normalized).byteLength > 512
    || hasIdentityControlCharacters(value)) throw new Error('identity_signup_invalid');
  return { display, normalized };
}
function ensureCampus(value: number): void { if (!validId(value)) throw new Error('identity_account_invalid'); }

export function recentStepUpContext(personId: number, assurance: SessionAssurance, nowEpochSeconds = Math.floor(Date.now() / 1000)): RecentStepUpContext {
  if (!validId(personId) || !hasRecentStepUp(assurance, nowEpochSeconds)) throw new Error('identity_recent_step_up_required');
  const verifiedAt = assurance.stepUpTime ?? assurance.authTime;
  if (verifiedAt === null) throw new Error('identity_recent_step_up_required');
  const context = { personId, verifiedAt } as RecentStepUpContext;
  Object.defineProperty(context, recentStepUpBrand, { value: true });
  return Object.freeze(context);
}
function assertRecentStepUp(context: RecentStepUpContext, personId: number, nowEpochSeconds: number): void {
  if (!context || context[recentStepUpBrand] !== true || !Object.isFrozen(context) || context.personId !== personId) {
    throw new Error('identity_recent_step_up_required');
  }
  if (!Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds <= 0 || context.verifiedAt > nowEpochSeconds
    || nowEpochSeconds - context.verifiedAt > RECENT_STEP_UP_SECONDS) throw new Error('identity_recent_step_up_required');
}

async function challengeRow(db: AppDb, campusId: number, publicId: string) {
  return db.prepare(`SELECT id,person_id,contact_point_id,requester_bucket_hash FROM identity_challenges
    WHERE campus_id=?1 AND public_id=?2`).bind(campusId, publicId)
    .first<{ id: number; person_id: number | null; contact_point_id: number; requester_bucket_hash: string }>();
}
async function operation(db: AppDb, campusId: number, id: string, kind: OperationKind): Promise<OperationRow | null> {
  return db.prepare(`SELECT op.*,c.public_id,c.contact_point_id,c.person_id challenge_person_id,c.requester_bucket_hash FROM identity_account_operations op
    JOIN identity_challenges c ON c.id=op.challenge_id WHERE op.operation_id=?1 AND op.campus_id=?2 AND op.kind=?3`)
    .bind(id, campusId, kind).first<OperationRow>();
}
async function consumeOrRecover(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; publicId: string; purpose: 'signup' | 'contact_change' | 'recovery'; code: string; now?: string; source?: IdentityChallengeSource;
}) {
  const consumed = await consumeEmailOtpChallenge(db, env, input);
  return consumed.ok ? consumed : verifyConsumedEmailOtpChallenge(db, env, input);
}

type AccountProofRow = { proof_category: string; person_id: number | null; contact_point_id: number };
async function accountProof(db: AppDb, op: OperationRow): Promise<AccountProofRow | null> {
  return db.prepare(`SELECT proof_category,person_id,contact_point_id FROM identity_account_proof_uses
    WHERE operation_id=?1 AND challenge_id=?2`).bind(op.operation_id, op.challenge_id).first<AccountProofRow>();
}
async function verifySavedOtp(db: AppDb, env: IdentityAuthEnv, op: OperationRow, input: {
  campusId: number; publicId: string; code: string; purpose: 'signup' | 'contact_change' | 'recovery';
  source?: IdentityChallengeSource; now?: string;
}) {
  const verified = await verifyConsumedEmailOtpChallenge(db, env, input);
  return verified.ok && verified.contact.id === op.contact_point_id ? verified : null;
}

async function savedSignupResult(db: AppDb, env: IdentityAuthEnv, op: OperationRow, input: {
  campusId: number; publicId: string; code: string; source?: IdentityChallengeSource; now?: string;
}) {
  if (op.state === 'pending') return null;
  const verified = await verifySavedOtp(db, env, op, { ...input, purpose: 'signup' });
  if (!verified) return { status: 'invalid' as const };
  const proof = await accountProof(db, op);
  if (!proof || proof.contact_point_id !== op.contact_point_id) return { status: 'invalid' as const };
  if (op.state === 'review' && op.result_case_id !== null && op.challenge_person_id === null
    && proof.proof_category === 'signup_review' && proof.person_id === null) {
    const savedCase = await db.prepare(`SELECT 1 ok FROM identity_account_review_cases
      WHERE id=?1 AND campus_id=?2 AND operation_id=?3`).bind(op.result_case_id, op.campus_id, op.operation_id).first<number>('ok');
    return savedCase === 1 ? { status: 'review' as const, reviewCaseId: op.result_case_id } : { status: 'invalid' as const };
  }
  if (op.state !== 'completed' || op.result_person_id === null || verified.owner?.personId !== op.result_person_id
    || !await activeCampusMember(db, op.campus_id, op.result_person_id)) return { status: 'invalid' as const };
  const created = op.reserved_person_id === op.result_person_id;
  const consistent = created
    ? op.challenge_person_id === null && proof.proof_category === 'signup_create' && proof.person_id === op.result_person_id
    : op.challenge_person_id === op.result_person_id && proof.proof_category === 'signup_owner' && proof.person_id === op.result_person_id;
  return consistent && Number.isSafeInteger(op.result_session_epoch) && op.result_session_epoch! >= 0
    ? { status: 'authenticated' as const, personId: op.result_person_id, created, sessionEpoch: op.result_session_epoch! } : { status: 'invalid' as const };
}

export async function prepareSignup(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; email: string; displayName: string; requestContext: IdentityTrustedRequestContext; source?: IdentityChallengeSource; now?: string;
  reservedOperationId?: string;
}): Promise<{ public: OperationPublic; delivery: OtpDelivery; statements: AppStatement[] }> {
  ensureCampus(input.campusId); const name = cleanDisplayName(input.displayName);
  if (input.reservedOperationId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.reservedOperationId)) {
    throw new Error('identity_signup_invalid');
  }
  const email = normalizeIdentityContact('email', input.email); if (!email) throw new Error('identity_signup_invalid');
  const issued = await prepareEmailOtpChallenge(db, env, { campusId: input.campusId, email, purpose: 'signup', source: input.source,
    requestContext: input.requestContext, now: input.now });
  if (issued.limited) throw new Error('identity_rate_limited');
  if (issued.challengeId === null || issued.contactPointId === null) throw new Error('identity_account_unavailable');
  const id = input.reservedOperationId ?? operationId(); const observationId = databaseId(); const reservedPersonId = databaseId();
  const statements = [
    ...issued.statements,
    db.prepare(`INSERT INTO identity_observations(id,campus_id,source,source_key,normalized_email,normalized_name,status)
      VALUES(?1,?2,'signup',?3,?4,?5,'provisional')`).bind(observationId, input.campusId, id, email, name.normalized),
    db.prepare(`INSERT INTO identity_account_operations(operation_id,campus_id,kind,challenge_id,observation_id,reserved_person_id,requested_display_name,requested_normalized_name,expires_at)
      VALUES(?1,?2,'signup',?3,?4,?5,?6,?7,?8)`).bind(id, input.campusId, issued.challengeId, observationId, reservedPersonId, name.display, name.normalized, issued.expiresAt),
  ];
  return { public: Object.freeze({ accepted: true, operationId: id, expiresAt: issued.expiresAt }),
    delivery: Object.freeze({ to: email, publicId: issued.publicId, code: issued.code, expiresAt: issued.expiresAt }), statements };
}

export async function beginSignup(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; email: string; displayName: string; requestContext: IdentityTrustedRequestContext; source?: IdentityChallengeSource; now?: string;
  reservedOperationId?: string;
}): Promise<{ public: OperationPublic; delivery: OtpDelivery }> {
  const prepared = await prepareSignup(db, env, input);
  await db.batch(prepared.statements);
  return { public: prepared.public, delivery: prepared.delivery };
}

type AmbiguityReason = 'legacy_contact_collision' | 'linked_contact' | 'household_contact' | 'name_collision' | 'external_collision' | 'owned_contact' | 'stale_target' | 'canonical_registry_stale' | 'multiple_signals';
async function ambiguity(db: AppDb, op: OperationRow, contact: ContactPoint, includeName: boolean): Promise<AmbiguityReason | null> {
  const registry = await refreshIdentityPersonCanonicalKeys(db);
  if (!registry.complete || registry.failed) return 'canonical_registry_stale';
  const emailNfc = contact.normalizedValue.normalize('NFC'); const emailNfd = emailNfc.normalize('NFD');
  const nameNfc = op.requested_normalized_name?.normalize('NFC') ?? ''; const nameNfd = nameNfc.normalize('NFD');
  const [legacy, name, links, households, external, anyOwner] = await Promise.all([
    db.prepare(`SELECT 1 ok FROM identity_person_canonical_keys
      WHERE normalization_version=1 AND is_current=1 AND person_id<>?1 AND legacy_email_key IN (?2,?3) LIMIT 1`).bind(op.reserved_person_id ?? 0, emailNfc, emailNfd).first<number>('ok'),
    includeName && nameNfc ? db.prepare(`SELECT 1 ok FROM identity_person_canonical_keys
      WHERE normalization_version=1 AND is_current=1 AND person_id<>?1 AND normalized_name_key IN (?2,?3) LIMIT 1`).bind(op.reserved_person_id ?? 0, nameNfc, nameNfd).first<number>('ok') : Promise.resolve(null),
    db.prepare('SELECT count(*) n FROM person_contact_links WHERE contact_point_id=?1').bind(contact.id).first<number>('n'),
    db.prepare('SELECT count(*) n FROM household_contact_links WHERE contact_point_id=?1').bind(contact.id).first<number>('n'),
    db.prepare(`SELECT count(*) n FROM identity_observations o
      WHERE o.id<>?1 AND o.normalized_email=?2
        AND NOT EXISTS (
          SELECT 1 FROM identity_business_intents bi
          JOIN identity_source_records s ON s.id=bi.source_record_id
          WHERE bi.signup_operation_id=?3 AND bi.campus_id=?4 AND s.observation_id=o.id
        )`)
      .bind(op.observation_id ?? 0, contact.normalizedValue, op.operation_id, op.campus_id).first<number>('n'),
    db.prepare('SELECT count(*) n FROM verified_contact_owners WHERE contact_point_id=?1').bind(contact.id).first<number>('n'),
  ]);
  const reasons: AmbiguityReason[] = [];
  if ((anyOwner ?? 0) > 0) reasons.push('owned_contact');
  if ((links ?? 0) > 0) reasons.push('linked_contact');
  if ((households ?? 0) > 0) reasons.push('household_contact');
  if ((external ?? 0) > 0) reasons.push('external_collision');
  if (legacy === 1) reasons.push('legacy_contact_collision');
  if (name === 1) reasons.push('name_collision');
  return reasons.length > 1 ? 'multiple_signals' : reasons[0] ?? null;
}

async function createReview(db: AppDb, op: OperationRow, reason: AmbiguityReason): Promise<{ status: 'review'; reviewCaseId: number }> {
  const existing = await db.prepare('SELECT id FROM identity_account_review_cases WHERE operation_id=?1').bind(op.operation_id).first<number>('id');
  if (existing !== null) return { status: 'review', reviewCaseId: existing };
  const caseId = databaseId(); const proof = op.kind === 'signup' ? 'signup_review' : 'contact_change_review';
  const statements = [
    db.prepare(`INSERT INTO identity_account_proof_uses(challenge_id,operation_id,contact_point_id,person_id,proof_category)
      VALUES(?1,?2,?3,?4,?5)`).bind(op.challenge_id, op.operation_id, op.contact_point_id, op.target_person_id, proof),
    db.prepare(`INSERT INTO identity_account_review_cases(id,campus_id,operation_id,reason_code,risk) VALUES(?1,?2,?3,?4,'high')`)
      .bind(caseId, op.campus_id, op.operation_id, reason),
    db.prepare("UPDATE identity_account_operations SET state='review',result_case_id=?1,updated_at=datetime('now') WHERE operation_id=?2 AND state='pending'").bind(caseId, op.operation_id),
    db.prepare("UPDATE identity_challenges SET ownership_consumed_at=datetime('now') WHERE id=?1 AND ownership_consumed_at IS NULL").bind(op.challenge_id),
    db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,subject_person_id,contact_point_id,metadata_json)
      VALUES(?1,'identity_account_review_created',?2,?3,'{}')`).bind(op.campus_id, op.target_person_id, op.contact_point_id),
  ];
  if (op.observation_id !== null) statements.splice(3, 0,
    db.prepare("UPDATE identity_observations SET status='review',linked_person_id=NULL,updated_at=datetime('now') WHERE id=?1").bind(op.observation_id));
  try { await db.batch(statements); }
  catch {
    const saved = await db.prepare('SELECT result_case_id FROM identity_account_operations WHERE operation_id=?1 AND state=?2')
      .bind(op.operation_id, 'review').first<number>('result_case_id');
    if (saved !== null) return { status: 'review', reviewCaseId: saved };
    throw new Error('identity_account_conflict');
  }
  return { status: 'review', reviewCaseId: caseId };
}

export async function completeVerifiedSignup(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; operationId: string; publicId: string; code: string; source?: IdentityChallengeSource; now?: string;
}): Promise<{ status: 'authenticated'; personId: number; created: boolean; sessionEpoch: number } | { status: 'review'; reviewCaseId: number } | { status: 'invalid' }> {
  const op = await operation(db, input.campusId, input.operationId, 'signup'); if (!op || op.public_id !== input.publicId) return { status: 'invalid' };
  const priorResult = await savedSignupResult(db, env, op, input); if (priorResult) return priorResult;
  const verified = await consumeOrRecover(db, env, { campusId: input.campusId, publicId: input.publicId, purpose: 'signup', code: input.code, source: input.source, now: input.now });
  if (!verified.ok || op.observation_id === null || op.reserved_person_id === null || !op.requested_display_name) return { status: 'invalid' };
  if (op.challenge_person_id !== null) {
    if (verified.owner?.personId !== op.challenge_person_id || !await activeCampusMember(db, op.campus_id, op.challenge_person_id)) {
      return { status: 'invalid' };
    }
    try { await db.batch([
      db.prepare(`INSERT INTO identity_account_proof_uses(challenge_id,operation_id,contact_point_id,person_id,proof_category)
        VALUES(?1,?2,?3,?4,'signup_owner')`).bind(op.challenge_id, op.operation_id, verified.contact.id, op.challenge_person_id),
      db.prepare("UPDATE identity_observations SET status='linked',linked_person_id=?1,updated_at=datetime('now') WHERE id=?2")
        .bind(op.challenge_person_id, op.observation_id),
      db.prepare("UPDATE identity_account_operations SET state='completed',result_person_id=?1,result_session_epoch=?2,updated_at=datetime('now') WHERE operation_id=?3 AND state='pending'")
        .bind(op.challenge_person_id, verified.sessionEpoch, op.operation_id),
      db.prepare("UPDATE identity_challenges SET ownership_consumed_at=datetime('now') WHERE id=?1 AND ownership_consumed_at IS NULL").bind(op.challenge_id),
      db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,subject_person_id,contact_point_id,metadata_json)
        VALUES(?1,'signup_existing_owner_authenticated',?2,?3,'{}')`).bind(op.campus_id, op.challenge_person_id, verified.contact.id),
    ]); } catch {
      const saved = await operation(db, input.campusId, input.operationId, 'signup');
      const completed = saved && await savedSignupResult(db, env, saved, input);
      return completed ?? { status: 'invalid' };
    }
    return { status: 'authenticated', personId: op.challenge_person_id, created: false, sessionEpoch: verified.sessionEpoch! };
  }
  const reason = await ambiguity(db, op, verified.contact, true); if (reason) return createReview(db, op, reason);
  const mutation = await db.prepare(`SELECT COALESCE(MAX(generation),0) generation FROM contact_owner_mutation_claims WHERE contact_point_id=?1`)
    .bind(verified.contact.id).first<number>('generation');
  try { await db.batch([
    db.prepare(`INSERT INTO people(id,display_name,email,role,active,home_campus_id,membership_status,identity_state,auth_disabled_at,provisional_source)
      VALUES(?1,?2,?3,'member',0,?4,'visitor','provisional',datetime('now'),'verified_signup')`)
      .bind(op.reserved_person_id, op.requested_display_name, verified.contact.normalizedValue, op.campus_id),
    exactIdentityPersonCanonicalKeyStatement(db, { personId: op.reserved_person_id, email: verified.contact.normalizedValue,
      displayName: op.requested_display_name }),
    db.prepare(`INSERT INTO identity_account_proof_uses(challenge_id,operation_id,contact_point_id,person_id,proof_category)
      VALUES(?1,?2,?3,?4,'signup_create')`).bind(op.challenge_id, op.operation_id, verified.contact.id, op.reserved_person_id),
    db.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,is_primary,notification_enabled)
      VALUES(?1,?2,'email','verified_signup',1,1)`).bind(op.reserved_person_id, verified.contact.id),
    db.prepare(`INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation)
      VALUES(?1,?2,NULL,?3,'assign')`).bind(verified.contact.id, (mutation ?? 0) + 1, op.reserved_person_id),
    db.prepare(`INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method,challenge_id)
      VALUES(?1,?2,'email_link',?3)`).bind(verified.contact.id, op.reserved_person_id, op.challenge_id),
    db.prepare(`INSERT INTO contact_ownership_events(contact_point_id,person_id,event_type,reason)
      VALUES(?1,?2,'verified',NULL)`).bind(verified.contact.id, op.reserved_person_id),
    db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,subject_person_id,contact_point_id,metadata_json)
      VALUES(?1,'verified_signup_created',?2,?3,'{}')`).bind(op.campus_id, op.reserved_person_id, verified.contact.id),
    db.prepare("UPDATE identity_challenges SET ownership_consumed_at=datetime('now') WHERE id=?1 AND ownership_consumed_at IS NULL").bind(op.challenge_id),
    db.prepare("UPDATE identity_observations SET status='linked',linked_person_id=?1,updated_at=datetime('now') WHERE id=?2")
      .bind(op.reserved_person_id, op.observation_id),
    db.prepare("UPDATE people SET active=1,identity_state='active',auth_disabled_at=NULL,provisional_source=NULL,updated_at=datetime('now') WHERE id=?1 AND active=0 AND identity_state='provisional'")
      .bind(op.reserved_person_id),
    db.prepare("UPDATE campus_memberships SET active=1,updated_at=datetime('now') WHERE campus_id=?1 AND person_id=?2").bind(op.campus_id, op.reserved_person_id),
    // A new identity begins at epoch zero. Store that immutable credential
    // snapshot with the completed operation before another request can revoke it.
    db.prepare("UPDATE identity_account_operations SET state='completed',result_person_id=?1,result_session_epoch=0,updated_at=datetime('now') WHERE operation_id=?2 AND state='pending'")
      .bind(op.reserved_person_id, op.operation_id),
  ]); } catch {
    const saved = await operation(db, input.campusId, input.operationId, 'signup');
    const result = saved && await savedSignupResult(db, env, saved, input); if (result) return result;
    const lateReason = await ambiguity(db, op, verified.contact, true); if (lateReason) return createReview(db, op, lateReason);
    return { status: 'invalid' };
  }
  return { status: 'authenticated', personId: op.reserved_person_id, created: true, sessionEpoch: 0 };
}

/** One-time gate between an idempotent signup workflow and session minting. */
export async function resolveSignupSessionDelivery(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; operationId: string; publicId: string; code: string; source?: IdentityChallengeSource; now?: string;
}): Promise<{ status: 'claimed' | 'already_claimed'; sessionEpoch: number } | { status: 'invalid' }> {
  const op = await operation(db, input.campusId, input.operationId, 'signup');
  if (!op || op.public_id !== input.publicId) return { status: 'invalid' };
  const completed = await savedSignupResult(db, env, op, input);
  const sessionEpoch = op.result_session_epoch;
  if (!completed || completed.status !== 'authenticated' || !Number.isSafeInteger(sessionEpoch)
    || sessionEpoch === null || sessionEpoch < 0) return { status: 'invalid' };
  const alreadyClaimed = async () => await db.prepare(`SELECT 1 ok FROM identity_session_delivery_claims
    WHERE operation_id=?1 AND challenge_id=?2 AND person_id=?3 AND session_epoch=?4`)
    .bind(op.operation_id, op.challenge_id, completed.personId, sessionEpoch).first<number>('ok') === 1;
  if (await alreadyClaimed()) return { status: 'already_claimed', sessionEpoch };
  try {
    const write = await db.prepare(`INSERT INTO identity_session_delivery_claims(operation_id,challenge_id,person_id,session_epoch)
      VALUES(?1,?2,?3,?4)`).bind(op.operation_id, op.challenge_id, completed.personId, sessionEpoch).run();
    if (write.meta.changes === 1) return { status: 'claimed', sessionEpoch };
  } catch { /* A concurrent exact claim is resolved below. */ }
  return await alreadyClaimed() ? { status: 'already_claimed', sessionEpoch } : { status: 'invalid' };
}

/** Backward-compatible one-time gate for callers that must never accept an
 * already-delivered result. */
export async function claimSignupSessionDelivery(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; operationId: string; publicId: string; code: string; source?: IdentityChallengeSource; now?: string;
}): Promise<{ sessionEpoch: number } | null> {
  const resolution = await resolveSignupSessionDelivery(db, env, input);
  return resolution.status === 'claimed' ? { sessionEpoch: resolution.sessionEpoch } : null;
}

export async function beginSignin(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; email: string; requestContext: IdentityTrustedRequestContext; source?: IdentityChallengeSource; now?: string;
}): Promise<{ public: NeutralPublic; delivery: LinkDelivery | null }> {
  ensureCampus(input.campusId); const email = normalizeIdentityContact('email', input.email); if (!email) throw new Error('identity_signin_invalid');
  const issued = await issueEmailLinkChallenge(db, env, { campusId: input.campusId, email, purpose: 'login', source: input.source,
    requestContext: input.requestContext, now: input.now });
  const owner = await findVerifiedContactOwner(db, { kind: 'email', value: email });
  const challenge = issued.limited ? null : await challengeRow(db, input.campusId, issued.publicId);
  const delivery = !issued.limited && owner && challenge?.person_id === owner.personId
    ? Object.freeze({ to: owner.displayValue, publicId: issued.publicId, token: issued.token, expiresAt: issued.expiresAt }) : null;
  return { public: Object.freeze({ accepted: true }), delivery };
}

export async function completeSigninLink(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; publicId: string; token: string; source?: IdentityChallengeSource; now?: string;
}): Promise<{ status: 'authenticated'; personId: number; sessionEpoch: number } | { status: 'invalid' }> {
  const consumed = await consumeEmailLinkChallenge(db, env, { ...input, purpose: 'login' });
  const sessionEpoch = consumed.ok ? consumed.sessionEpoch : null;
  return consumed.ok && consumed.owner && Number.isSafeInteger(sessionEpoch) && sessionEpoch !== null && sessionEpoch >= 0
    ? { status: 'authenticated', personId: consumed.owner.personId, sessionEpoch } : { status: 'invalid' };
}

async function ownedEmail(db: AppDb, personId: number): Promise<VerifiedOwner | null> {
  const row = await db.prepare(`SELECT c.normalized_value FROM verified_contact_owners o JOIN contact_points c ON c.id=o.contact_point_id
    JOIN person_contact_links l ON l.person_id=o.person_id AND l.contact_point_id=o.contact_point_id AND l.ended_at IS NULL
    JOIN people p ON p.id=o.person_id LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
    WHERE o.person_id=?1 AND c.kind='email' AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active'
      AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL ORDER BY l.is_primary DESC,o.verified_at DESC LIMIT 1`)
    .bind(personId).first<{ normalized_value: string }>();
  return row ? findVerifiedContactOwner(db, { kind: 'email', value: row.normalized_value }) : null;
}
async function activeCampusMember(db: AppDb, campusId: number, personId: number): Promise<boolean> {
  return await db.prepare('SELECT 1 ok FROM campus_memberships WHERE campus_id=?1 AND person_id=?2 AND active=1')
    .bind(campusId, personId).first<number>('ok') === 1;
}
async function challengeTargets(db: AppDb, campusId: number, publicId: string, purpose: 'step_up' | 'contact_change', personId: number): Promise<boolean> {
  const row = await db.prepare('SELECT 1 ok FROM identity_challenges WHERE campus_id=?1 AND public_id=?2 AND purpose=?3 AND person_id=?4')
    .bind(campusId, publicId, purpose, personId).first<number>('ok');
  return row === 1;
}

async function savedContactChangeResult(db: AppDb, env: IdentityAuthEnv, op: OperationRow, input: {
  campusId: number; personId: number; publicId: string; code: string; source?: IdentityChallengeSource; now?: string;
}) {
  if (op.state === 'pending') return null;
  const verified = await verifySavedOtp(db, env, op, { ...input, purpose: 'contact_change' });
  if (!verified) return { status: 'invalid' as const };
  const proof = await accountProof(db, op);
  if (!proof || proof.contact_point_id !== op.contact_point_id || proof.person_id !== input.personId
    || op.challenge_person_id !== input.personId) return { status: 'invalid' as const };
  if (op.state === 'review' && op.result_case_id !== null && proof.proof_category === 'contact_change_review') {
    const savedCase = await db.prepare(`SELECT 1 ok FROM identity_account_review_cases
      WHERE id=?1 AND campus_id=?2 AND operation_id=?3`).bind(op.result_case_id, op.campus_id, op.operation_id).first<number>('ok');
    return savedCase === 1 ? { status: 'review' as const, reviewCaseId: op.result_case_id } : { status: 'invalid' as const };
  }
  if (op.state !== 'completed' || op.result_person_id !== input.personId || proof.proof_category !== 'contact_change'
    || verified.owner?.personId !== input.personId || op.expected_session_epoch === null || op.prior_contact_point_id === null) {
    return { status: 'invalid' as const };
  }
  const claim = await db.prepare(`SELECT resulting_epoch FROM identity_session_epoch_claims
    WHERE operation_id=?1 AND person_id=?2 AND expected_epoch=?3`).bind(op.operation_id, input.personId, op.expected_session_epoch)
    .first<number>('resulting_epoch');
  const person = await db.prepare('SELECT session_epoch,email FROM people WHERE id=?1').bind(input.personId)
    .first<{ session_epoch: number; email: string }>();
  const oldContact = await db.prepare('SELECT display_value FROM contact_points WHERE id=?1').bind(op.prior_contact_point_id)
    .first<string>('display_value');
  if (claim !== op.expected_session_epoch + 1 || person?.session_epoch !== claim
    || normalizeIdentityContact('email', person.email) !== verified.contact.normalizedValue || oldContact === null) {
    return { status: 'invalid' as const };
  }
  return { status: 'changed' as const, personId: input.personId, sessionEpoch: claim, notifyOldContact: { to: oldContact } };
}

async function savedRecoveryResult(db: AppDb, env: IdentityAuthEnv, op: OperationRow, input: {
  campusId: number; publicId: string; code: string; source?: IdentityChallengeSource; now?: string;
}) {
  if (op.state === 'pending') return null;
  const verified = await verifySavedOtp(db, env, op, { ...input, purpose: 'recovery' });
  if (!verified) return { status: 'invalid' as const };
  const proof = await accountProof(db, op);
  if (op.state !== 'review' || op.result_case_id === null || !proof || proof.proof_category !== 'recovery_case'
    || proof.contact_point_id !== op.contact_point_id || proof.person_id !== op.target_person_id) return { status: 'invalid' as const };
  const savedCase = await db.prepare(`SELECT 1 ok FROM identity_recovery_cases
    WHERE id=?1 AND campus_id=?2 AND contact_point_id=?3 AND COALESCE(person_id,0)=COALESCE(?4,0)`)
    .bind(op.result_case_id, op.campus_id, verified.contact.id, op.target_person_id).first<number>('ok');
  return savedCase === 1 ? { status: 'review' as const, recoveryCaseId: op.result_case_id } : { status: 'invalid' as const };
}

export async function beginStepUp(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; personId: number; requestContext: IdentityTrustedRequestContext; source?: IdentityChallengeSource; now?: string;
}): Promise<{ public: NeutralPublic; delivery: OtpDelivery }> {
  if (!await activeCampusMember(db, input.campusId, input.personId)) throw new Error('identity_step_up_unavailable');
  const owner = await ownedEmail(db, input.personId); if (!owner) throw new Error('identity_step_up_unavailable');
  const issued = await issueEmailOtpChallenge(db, env, { campusId: input.campusId, email: owner.normalizedValue, purpose: 'step_up', targetPersonId: input.personId,
    source: input.source, requestContext: input.requestContext, now: input.now });
  if (issued.limited) throw new Error('identity_rate_limited');
  return { public: Object.freeze({ accepted: true }), delivery: Object.freeze({ to: owner.displayValue, publicId: issued.publicId, code: issued.code, expiresAt: issued.expiresAt }) };
}

export async function completeStepUp(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; personId: number; publicId: string; code: string; source?: IdentityChallengeSource; now?: string;
}): Promise<{ status: 'verified'; personId: number; sessionEpoch: number; authMethod: 'email_otp'; stepUpTime: number } | { status: 'invalid' }> {
  if (!await challengeTargets(db, input.campusId, input.publicId, 'step_up', input.personId)) return { status: 'invalid' };
  if (!await activeCampusMember(db, input.campusId, input.personId)) return { status: 'invalid' };
  const consumed = await consumeEmailOtpChallenge(db, env, { campusId: input.campusId, publicId: input.publicId, purpose: 'step_up', code: input.code, source: input.source, now: input.now });
  const sessionEpoch = consumed.ok ? consumed.sessionEpoch : null;
  if (!consumed.ok || consumed.owner?.personId !== input.personId || !Number.isSafeInteger(sessionEpoch) || sessionEpoch === null || sessionEpoch < 0
    || !await activeCampusMember(db, input.campusId, input.personId)) return { status: 'invalid' };
  return { status: 'verified', personId: input.personId, sessionEpoch, authMethod: 'email_otp', stepUpTime: epochSeconds(input.now ?? new Date().toISOString().slice(0, 19).replace('T', ' ')) };
}

export async function beginContactChange(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; personId: number; newEmail: string; recentStepUp: RecentStepUpContext; requestContext: IdentityTrustedRequestContext;
  source?: IdentityChallengeSource; now?: string;
}): Promise<{ public: OperationPublic; delivery: OtpDelivery }> {
  const nowEpoch = input.now ? epochSeconds(input.now) : Math.floor(Date.now() / 1000);
  assertRecentStepUp(input.recentStepUp, input.personId, nowEpoch);
  if (!await activeCampusMember(db, input.campusId, input.personId)) throw new Error('identity_contact_change_unavailable');
  const oldOwner = await ownedEmail(db, input.personId); if (!oldOwner) throw new Error('identity_contact_change_unavailable');
  const expectedEpoch = await db.prepare('SELECT session_epoch FROM people WHERE id=?1').bind(input.personId).first<number>('session_epoch');
  if (expectedEpoch === null || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) throw new Error('identity_contact_change_unavailable');
  const email = normalizeIdentityContact('email', input.newEmail); if (!email) throw new Error('identity_contact_invalid');
  const issued = await issueEmailOtpChallenge(db, env, { campusId: input.campusId, email, purpose: 'contact_change', targetPersonId: input.personId,
    source: input.source, requestContext: input.requestContext, now: input.now });
  if (issued.limited) throw new Error('identity_rate_limited');
  const challenge = await challengeRow(db, input.campusId, issued.publicId); if (!challenge) throw new Error('identity_account_unavailable');
  const id = operationId();
  await db.prepare(`INSERT INTO identity_account_operations(operation_id,campus_id,kind,challenge_id,target_person_id,prior_contact_point_id,expected_session_epoch,expires_at)
    VALUES(?1,?2,'contact_change',?3,?4,?5,?6,?7)`).bind(id, input.campusId, challenge.id, input.personId, oldOwner.contactPointId, expectedEpoch, issued.expiresAt).run();
  return { public: Object.freeze({ accepted: true, operationId: id, expiresAt: issued.expiresAt }),
    delivery: Object.freeze({ to: email, publicId: issued.publicId, code: issued.code, expiresAt: issued.expiresAt }) };
}

export async function completeContactChange(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; personId: number; operationId: string; publicId: string; code: string; source?: IdentityChallengeSource; now?: string;
}): Promise<{ status: 'changed'; personId: number; sessionEpoch: number; notifyOldContact: { to: string } } | { status: 'review'; reviewCaseId: number } | { status: 'invalid' }> {
  const op = await operation(db, input.campusId, input.operationId, 'contact_change');
  if (!op || op.public_id !== input.publicId || op.target_person_id !== input.personId || op.prior_contact_point_id === null
    || op.expected_session_epoch === null) return { status: 'invalid' };
  const priorResult = await savedContactChangeResult(db, env, op, input); if (priorResult) return priorResult;
  if (!await challengeTargets(db, input.campusId, input.publicId, 'contact_change', input.personId)) return { status: 'invalid' };
  const verified = await consumeOrRecover(db, env, { campusId: input.campusId, publicId: input.publicId, purpose: 'contact_change', code: input.code, source: input.source, now: input.now });
  if (!verified.ok) return { status: 'invalid' };
  const reason = await ambiguity(db, op, verified.contact, false); if (reason) return createReview(db, op, reason);
  const oldContact = await db.prepare('SELECT display_value FROM contact_points WHERE id=?1').bind(op.prior_contact_point_id).first<string>('display_value');
  const person = await db.prepare(`SELECT p.session_epoch,p.display_name FROM people p JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=?2 AND cm.active=1
    LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
    WHERE p.id=?1 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL`)
    .bind(input.personId, input.campusId).first<{ session_epoch: number; display_name: string }>();
  if (oldContact === null || !person) return createReview(db, op, 'stale_target');
  if (person.session_epoch !== op.expected_session_epoch) return createReview(db, op, 'stale_target');
  const currentOldOwner = await db.prepare(`SELECT 1 ok FROM verified_contact_owners o JOIN person_contact_links l
    ON l.person_id=o.person_id AND l.contact_point_id=o.contact_point_id AND l.ended_at IS NULL
    WHERE o.contact_point_id=?1 AND o.person_id=?2`).bind(op.prior_contact_point_id, input.personId).first<number>('ok');
  if (currentOldOwner !== 1) return createReview(db, op, 'stale_target');
  const oldGeneration = await db.prepare('SELECT COALESCE(MAX(generation),0) generation FROM contact_owner_mutation_claims WHERE contact_point_id=?1')
    .bind(op.prior_contact_point_id).first<number>('generation');
  const newGeneration = await db.prepare('SELECT COALESCE(MAX(generation),0) generation FROM contact_owner_mutation_claims WHERE contact_point_id=?1')
    .bind(verified.contact.id).first<number>('generation');
  const nextEpoch = op.expected_session_epoch + 1;
  try { await db.batch([
    db.prepare(`INSERT INTO identity_account_proof_uses(challenge_id,operation_id,contact_point_id,person_id,proof_category)
      VALUES(?1,?2,?3,?4,'contact_change')`).bind(op.challenge_id, op.operation_id, verified.contact.id, input.personId),
    db.prepare(`INSERT INTO identity_session_epoch_claims(operation_id,person_id,expected_epoch,resulting_epoch)
      VALUES(?1,?2,?3,?4)`).bind(op.operation_id, input.personId, op.expected_session_epoch, nextEpoch),
    db.prepare(`INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation)
      VALUES(?1,?2,?3,NULL,'revoke')`).bind(op.prior_contact_point_id, (oldGeneration ?? 0) + 1, input.personId),
    db.prepare('DELETE FROM verified_contact_owners WHERE contact_point_id=?1 AND person_id=?2').bind(op.prior_contact_point_id, input.personId),
    db.prepare("UPDATE person_contact_links SET ended_at=datetime('now'),is_primary=0 WHERE person_id=?1 AND contact_point_id=?2 AND ended_at IS NULL")
      .bind(input.personId, op.prior_contact_point_id),
    db.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,is_primary,notification_enabled)
      VALUES(?1,?2,'email','verified_contact_change',1,1)`).bind(input.personId, verified.contact.id),
    db.prepare(`INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation)
      VALUES(?1,?2,NULL,?3,'assign')`).bind(verified.contact.id, (newGeneration ?? 0) + 1, input.personId),
    db.prepare(`INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method,challenge_id)
      VALUES(?1,?2,'email_link',?3)`).bind(verified.contact.id, input.personId, op.challenge_id),
    db.prepare(`INSERT INTO contact_ownership_events(contact_point_id,person_id,previous_person_id,event_type,reason)
      VALUES(?1,NULL,?2,'revoked',NULL)`).bind(op.prior_contact_point_id, input.personId),
    db.prepare(`INSERT INTO contact_ownership_events(contact_point_id,person_id,previous_person_id,event_type,reason)
      VALUES(?1,?2,NULL,'verified',NULL)`).bind(verified.contact.id, input.personId),
    db.prepare("UPDATE people SET email=?1,session_epoch=session_epoch+1,identity_version=identity_version+1,updated_at=datetime('now') WHERE id=?2 AND session_epoch=?3")
      .bind(verified.contact.normalizedValue, input.personId, op.expected_session_epoch),
    exactIdentityPersonCanonicalKeyStatement(db, { personId: input.personId, email: verified.contact.normalizedValue,
      displayName: person.display_name }),
    db.prepare("UPDATE identity_challenges SET ownership_consumed_at=datetime('now') WHERE id=?1 AND ownership_consumed_at IS NULL").bind(op.challenge_id),
    db.prepare("UPDATE identity_account_operations SET state='completed',result_person_id=?1,updated_at=datetime('now') WHERE operation_id=?2 AND state='pending'")
      .bind(input.personId, op.operation_id),
    db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,subject_person_id,contact_point_id,metadata_json)
      VALUES(?1,'verified_contact_changed',?2,?3,'{}')`).bind(op.campus_id, input.personId, verified.contact.id),
  ]); } catch {
    const saved = await operation(db, input.campusId, input.operationId, 'contact_change');
    if (saved) {
      const result = await savedContactChangeResult(db, env, saved, input); if (result) return result;
    }
    const lateReason = await ambiguity(db, op, verified.contact, false); if (lateReason) return createReview(db, op, lateReason);
    return { status: 'invalid' };
  }
  return { status: 'changed', personId: input.personId, sessionEpoch: nextEpoch, notifyOldContact: { to: oldContact } };
}

export async function beginRecovery(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; accountEmail: string; reachableEmail: string; requestContext: IdentityTrustedRequestContext; source?: IdentityChallengeSource; now?: string;
}): Promise<{ public: OperationPublic; delivery: OtpDelivery }> {
  ensureCampus(input.campusId); const reachable = normalizeIdentityContact('email', input.reachableEmail); if (!reachable) throw new Error('identity_recovery_invalid');
  const verificationSecret = env.IDENTITY_VERIFICATION_SECRET;
  if (typeof verificationSecret !== 'string') throw new Error('identity_verification_unavailable');
  const claimedTarget = normalizeIdentityContact('email', input.accountEmail);
  const claimedTargetHash = await hmacIdentityValue(verificationSecret, 'recovery:claimed-target', claimedTarget ?? 'invalid');
  const resolvedOwner = await findVerifiedContactOwner(db, { kind: 'email', value: input.accountEmail });
  const owner = resolvedOwner && await activeCampusMember(db, input.campusId, resolvedOwner.personId) ? resolvedOwner : null;
  const issued = await issueEmailOtpChallenge(db, env, { campusId: input.campusId, email: reachable, purpose: 'recovery', source: input.source,
    requestContext: input.requestContext, now: input.now });
  if (issued.limited) throw new Error('identity_rate_limited');
  const challenge = await challengeRow(db, input.campusId, issued.publicId); if (!challenge) throw new Error('identity_account_unavailable');
  const id = operationId();
  await db.prepare(`INSERT INTO identity_account_operations(operation_id,campus_id,kind,challenge_id,target_person_id,expires_at,recovery_claim_hash,recovery_source_version)
    VALUES(?1,?2,'recovery',?3,?4,?5,?6,1)`).bind(id, input.campusId, challenge.id, owner?.personId ?? null, issued.expiresAt, claimedTargetHash).run();
  return { public: Object.freeze({ accepted: true, operationId: id, expiresAt: issued.expiresAt }),
    delivery: Object.freeze({ to: reachable, publicId: issued.publicId, code: issued.code, expiresAt: issued.expiresAt }) };
}

export async function completeRecoveryRequest(db: AppDb, env: IdentityAuthEnv & IdentityRecoveryKeyEnv, input: {
  campusId: number; operationId: string; publicId: string; code: string; source?: IdentityChallengeSource; now?: string; notificationLocale?: Locale;
}): Promise<{ status: 'review'; recoveryCaseId: number } | { status: 'invalid' }> {
  const op = await operation(db, input.campusId, input.operationId, 'recovery'); if (!op || op.public_id !== input.publicId) return { status: 'invalid' };
  const priorResult = await savedRecoveryResult(db, env, op, input); if (priorResult) return priorResult;
  const verified = await consumeOrRecover(db, env, { campusId: input.campusId, publicId: input.publicId, purpose: 'recovery', code: input.code, source: input.source, now: input.now });
  if (!verified.ok) return { status: 'invalid' };
  const caseId = databaseId(); const recoveryExpiry = input.now ? new Date(`${input.now.replace(' ', 'T')}Z`) : new Date();
  recoveryExpiry.setUTCDate(recoveryExpiry.getUTCDate() + 7);
  const expiresAt = recoveryExpiry.toISOString().slice(0, 19).replace('T', ' ');
  const requestNoticeRows = op.target_person_id === null ? [] : (await db.prepare(`SELECT cp.id contact_point_id,cp.normalized_value
    FROM verified_contact_owners owner JOIN contact_points cp ON cp.id=owner.contact_point_id AND cp.kind='email'
    WHERE owner.person_id=?1 ORDER BY cp.id`).bind(op.target_person_id)
    .all<{ contact_point_id: number; normalized_value: string }>()).results;
  const requestNotices = (await Promise.all(requestNoticeRows.map((recipient) => prepareIdentityRecoveryNotification(db, env, {
    caseId, category: 'request_old_contact', contactPointId: recipient.contact_point_id,
    recipient: recipient.normalized_value, locale: input.notificationLocale ?? 'en',
  })))).filter((statement): statement is AppStatement => statement !== null);
  try { await db.batch([
    db.prepare(`INSERT INTO identity_account_proof_uses(challenge_id,operation_id,contact_point_id,person_id,proof_category)
      VALUES(?1,?2,?3,?4,'recovery_case')`).bind(op.challenge_id, op.operation_id, verified.contact.id, op.target_person_id),
    db.prepare(`INSERT INTO identity_recovery_cases(id,campus_id,person_id,contact_point_id,state,risk,requester_bucket_hash,expires_at,
        source_operation_id,claimed_target_hash,source_version)
      VALUES(?1,?2,?3,?4,'open','high',?5,?6,?7,?8,?9)`).bind(caseId, op.campus_id, op.target_person_id,
        verified.contact.id, op.requester_bucket_hash, expiresAt, op.operation_id, op.recovery_claim_hash, op.recovery_source_version),
    db.prepare("UPDATE identity_account_operations SET state='review',result_case_id=?1,updated_at=datetime('now') WHERE operation_id=?2 AND state='pending'")
      .bind(caseId, op.operation_id),
    db.prepare("UPDATE identity_challenges SET ownership_consumed_at=datetime('now') WHERE id=?1 AND ownership_consumed_at IS NULL").bind(op.challenge_id),
    ...requestNotices,
    db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,subject_person_id,contact_point_id,metadata_json)
      VALUES(?1,'identity_recovery_requested',?2,?3,'{}')`).bind(op.campus_id, op.target_person_id, verified.contact.id),
  ]); } catch {
    const saved = await operation(db, input.campusId, input.operationId, 'recovery');
    if (saved) {
      const result = await savedRecoveryResult(db, env, saved, input); if (result) return result;
    }
    return { status: 'invalid' };
  }
  return { status: 'review', recoveryCaseId: caseId };
}
