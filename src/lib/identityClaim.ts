import type { AppDb } from './appDb';
import {
  consumeEmailLinkChallenge,
  consumeEmailOtpChallenge,
  issueEmailLinkChallenge,
  issueEmailOtpChallenge,
  peekEmailLinkChallenge,
  verifyConsumedEmailOtpChallenge,
  type IdentityAuthEnv,
  type IdentityChallengeSource,
  type IdentityTrustedRequestContext,
} from './identityAuth';
import { getIdentitySourceRecord, type IdentitySourceKeyEnv } from './identityGateway';
import type { IdentitySource } from './identitySourceRegistry';

type ClaimOperation = {
  operation_id: string;
  campus_id: number;
  source_record_id: number;
  challenge_id: number;
  expected_source_version: number;
  expected_source_digest: string;
  expected_contact_point_id: number;
  expected_owner_person_id: number | null;
  expected_owner_generation: number | null;
  state: 'pending' | 'review' | 'completed' | 'expired';
  result_person_id: number | null;
  result_proof_kind: 'claim_owner' | 'clean_signup' | null;
  expires_at: string;
  public_id: string;
};

type OtpDelivery = Readonly<{ kind: 'otp'; to: string; publicId: string; code: string; expiresAt: string }>;
type LinkDelivery = Readonly<{ kind: 'link'; to: string; publicId: string; token: string; expiresAt: string }>;
type PublicOperation = Readonly<{ accepted: true; operationId: string; expiresAt: string }>;

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;
}
function validDigest(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }

async function operation(db: AppDb, campusId: number, operationId: string): Promise<ClaimOperation | null> {
  return db.prepare(`SELECT op.*,c.public_id FROM identity_claim_operations op JOIN identity_challenges c ON c.id=op.challenge_id
    WHERE op.operation_id=?1 AND op.campus_id=?2`).bind(operationId, campusId).first<ClaimOperation>();
}

async function uniqueOwnerAtContact(db: AppDb, campusId: number, contactPointId: number): Promise<{ personId: number; generation: number } | null> {
  const row = await db.prepare(`SELECT v.person_id,
      COALESCE((SELECT MAX(generation) FROM contact_owner_mutation_claims m WHERE m.contact_point_id=v.contact_point_id),0) generation
    FROM verified_contact_owners v JOIN people p ON p.id=v.person_id
    JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=?2 AND cm.active=1
    LEFT JOIN person_merge_redirects redirect ON redirect.loser_person_id=p.id
    WHERE v.contact_point_id=?1
      AND (SELECT COUNT(*) FROM person_contact_links l WHERE l.contact_point_id=v.contact_point_id AND l.ended_at IS NULL)=1
      AND NOT EXISTS (SELECT 1 FROM household_contact_links h WHERE h.campus_id=?2 AND h.contact_point_id=v.contact_point_id AND h.ended_at IS NULL)
      AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
      AND redirect.loser_person_id IS NULL`)
    .bind(contactPointId, campusId).first<{ person_id: number; generation: number }>();
  return row ? { personId: row.person_id, generation: row.generation } : null;
}

export async function beginSourceClaim(db: AppDb, env: IdentityAuthEnv & IdentitySourceKeyEnv, input: {
  campusId: number;
  source: IdentitySource;
  sourceRecordKey: string;
  expectedVersion: number;
  sourceDigest: string;
  mode: 'otp' | 'link';
  requestContext: IdentityTrustedRequestContext;
  challengeSource?: IdentityChallengeSource;
  now?: string;
}): Promise<{ public: PublicOperation; delivery: OtpDelivery | LinkDelivery }> {
  if (!validId(input.campusId) || !validId(input.expectedVersion) || !validDigest(input.sourceDigest)) {
    throw new Error('identity_source_claim_invalid');
  }
  const source = await getIdentitySourceRecord(db, env, input);
  if (!source) throw new Error('identity_source_not_found');
  if (source.attachment_policy !== 'signed_in_or_claim') throw new Error('identity_source_claim_not_allowed');
  if (source.state !== 'unlinked' || source.linked_person_id !== null
    || source.version !== input.expectedVersion || source.source_digest !== input.sourceDigest) {
    throw new Error('identity_source_version_conflict');
  }
  if (!source.normalized_email) throw new Error('identity_source_email_required');
  const issued = input.mode === 'otp'
    ? await issueEmailOtpChallenge(db, env, { campusId: input.campusId, email: source.normalized_email, purpose: 'claim',
      source: input.challengeSource, requestContext: input.requestContext, now: input.now })
    : await issueEmailLinkChallenge(db, env, { campusId: input.campusId, email: source.normalized_email, purpose: 'claim',
      source: input.challengeSource, requestContext: input.requestContext, now: input.now });
  if (issued.limited) throw new Error('identity_rate_limited');
  const challenge = await db.prepare(`SELECT id,contact_point_id FROM identity_challenges
    WHERE campus_id=?1 AND public_id=?2 AND purpose='claim' AND consumed_at IS NULL AND superseded_at IS NULL`)
    .bind(input.campusId, issued.publicId).first<{ id: number; contact_point_id: number }>();
  if (!challenge) throw new Error('identity_source_claim_unavailable');
  const owner = await uniqueOwnerAtContact(db, input.campusId, challenge.contact_point_id);
  const operationId = crypto.randomUUID();
  try {
    await db.prepare(`INSERT INTO identity_claim_operations(operation_id,campus_id,source_record_id,challenge_id,
      expected_source_version,expected_source_digest,expected_contact_point_id,expected_owner_person_id,expected_owner_generation,expires_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`)
      .bind(operationId, input.campusId, source.id, challenge.id, source.version, source.source_digest,
        challenge.contact_point_id, owner?.personId ?? null, owner?.generation ?? null, issued.expiresAt).run();
  } catch { throw new Error('identity_source_claim_conflict'); }
  const publicResult = Object.freeze({ accepted: true as const, operationId, expiresAt: issued.expiresAt });
  return input.mode === 'otp'
    ? { public: publicResult, delivery: Object.freeze({ kind: 'otp' as const, to: source.normalized_email,
      publicId: issued.publicId, code: 'code' in issued ? issued.code : '', expiresAt: issued.expiresAt }) }
    : { public: publicResult, delivery: Object.freeze({ kind: 'link' as const, to: source.normalized_email,
      publicId: issued.publicId, token: 'token' in issued ? issued.token : '', expiresAt: issued.expiresAt }) };
}

async function consumeOrRecoverClaim(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number;
  publicId: string;
  proof: { kind: 'otp'; code: string } | { kind: 'link'; token: string };
  challengeSource?: IdentityChallengeSource;
  now?: string;
}) {
  if (input.proof.kind === 'otp') {
    const values = { campusId: input.campusId, publicId: input.publicId, purpose: 'claim' as const,
      code: input.proof.code, source: input.challengeSource, now: input.now };
    const consumed = await consumeEmailOtpChallenge(db, env, values);
    return consumed.ok ? consumed : verifyConsumedEmailOtpChallenge(db, env, values);
  }
  const values = { campusId: input.campusId, publicId: input.publicId, purpose: 'claim' as const,
    token: input.proof.token, source: input.challengeSource, now: input.now };
  const consumed = await consumeEmailLinkChallenge(db, env, values);
  return consumed.ok ? consumed : peekEmailLinkChallenge(db, env, values);
}

async function cleanSignupPerson(db: AppDb, input: {
  campusId: number;
  signupOperationId: string;
  contactPointId: number;
}): Promise<number | null> {
  return db.prepare(`SELECT signup.result_person_id FROM identity_account_operations signup
    JOIN identity_challenges c ON c.id=signup.challenge_id
    JOIN identity_account_proof_uses proof ON proof.operation_id=signup.operation_id AND proof.challenge_id=signup.challenge_id
    JOIN verified_contact_owners owner ON owner.contact_point_id=c.contact_point_id AND owner.person_id=signup.result_person_id
    JOIN people p ON p.id=signup.result_person_id
    JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=?2 AND cm.active=1
    LEFT JOIN person_merge_redirects redirect ON redirect.loser_person_id=p.id
    WHERE signup.operation_id=?1 AND signup.campus_id=?2 AND signup.kind='signup' AND signup.state='completed'
      AND signup.reserved_person_id=signup.result_person_id AND c.contact_point_id=?3 AND c.consumed_at IS NOT NULL
      AND proof.proof_category='signup_create' AND proof.person_id=signup.result_person_id
      AND (SELECT COUNT(*) FROM person_contact_links l WHERE l.contact_point_id=c.contact_point_id AND l.ended_at IS NULL)=1
      AND NOT EXISTS (SELECT 1 FROM household_contact_links h WHERE h.campus_id=?2 AND h.contact_point_id=c.contact_point_id AND h.ended_at IS NULL)
      AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
      AND redirect.loser_person_id IS NULL`)
    .bind(input.signupOperationId, input.campusId, input.contactPointId).first<number>('result_person_id');
}

async function markReview(db: AppDb, op: ClaimOperation): Promise<{ status: 'review'; operationId: string }> {
  try {
    await db.batch([
      db.prepare(`UPDATE identity_source_records SET state='review',linked_person_id=NULL,updated_at=datetime('now')
        WHERE id=?1 AND state='unlinked' AND version=?2 AND source_digest=?3`)
        .bind(op.source_record_id, op.expected_source_version, op.expected_source_digest),
      db.prepare(`UPDATE identity_observations SET status='review',linked_person_id=NULL,updated_at=datetime('now')
        WHERE id=(SELECT observation_id FROM identity_source_records WHERE id=?1)`).bind(op.source_record_id),
      db.prepare(`UPDATE identity_claim_operations SET state='review',updated_at=datetime('now')
        WHERE operation_id=?1 AND state='pending'`).bind(op.operation_id),
      db.prepare(`UPDATE identity_challenges SET ownership_consumed_at=datetime('now')
        WHERE id=?1 AND ownership_consumed_at IS NULL`).bind(op.challenge_id),
      db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,metadata_json)
        VALUES(?1,'identity_source_claim_review','{}')`).bind(op.campus_id),
    ]);
  } catch {
    const saved = await operation(db, op.campus_id, op.operation_id);
    if (saved?.state !== 'review') throw new Error('identity_source_claim_conflict');
  }
  return { status: 'review', operationId: op.operation_id };
}

export async function completeSourceClaim(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number;
  operationId: string;
  publicId: string;
  proof: { kind: 'otp'; code: string } | { kind: 'link'; token: string };
  signupOperationId?: string;
  challengeSource?: IdentityChallengeSource;
  now?: string;
}): Promise<
  { status: 'attached'; personId: number }
  | { status: 'review'; operationId: string }
  | { status: 'stale' }
  | { status: 'invalid' }
> {
  if (!validId(input.campusId)) return { status: 'invalid' };
  const op = await operation(db, input.campusId, input.operationId);
  if (!op || op.public_id !== input.publicId) return { status: 'invalid' };
  const verified = await consumeOrRecoverClaim(db, env, input);
  if (!verified.ok || verified.contact.id !== op.expected_contact_point_id) return { status: 'invalid' };
  if (op.state === 'completed' && op.result_person_id !== null) return { status: 'attached', personId: op.result_person_id };
  if (op.state === 'review') return { status: 'review', operationId: op.operation_id };
  if (op.state === 'expired') return { status: 'stale' };

  const current = await db.prepare(`SELECT version,source_digest,state,linked_person_id FROM identity_source_records
    WHERE id=?1 AND campus_id=?2`).bind(op.source_record_id, op.campus_id)
    .first<{ version: number; source_digest: string; state: string; linked_person_id: number | null }>();
  if (!current || current.version !== op.expected_source_version || current.source_digest !== op.expected_source_digest) {
    try { await db.batch([
      db.prepare(`UPDATE identity_claim_operations SET state='expired',updated_at=datetime('now')
        WHERE operation_id=?1 AND state='pending'`).bind(op.operation_id),
      db.prepare(`UPDATE identity_challenges SET ownership_consumed_at=datetime('now')
        WHERE id=?1 AND ownership_consumed_at IS NULL`).bind(op.challenge_id),
    ]); } catch { /* A concurrent completion determines the durable result below. */ }
    const saved = await operation(db, op.campus_id, op.operation_id);
    return saved?.state === 'completed' && saved.result_person_id !== null
      ? { status: 'attached', personId: saved.result_person_id } : { status: 'stale' };
  }
  if (current.linked_person_id !== null) {
    const saved = await operation(db, op.campus_id, op.operation_id);
    return saved?.state === 'completed' && saved.result_person_id === current.linked_person_id
      ? { status: 'attached', personId: current.linked_person_id } : { status: 'invalid' };
  }
  if (current.state === 'review') return markReview(db, op);
  if (current.state !== 'unlinked') return { status: 'invalid' };

  const owner = await uniqueOwnerAtContact(db, op.campus_id, op.expected_contact_point_id);
  let personId: number | null = null;
  let proofKind: 'claim_owner' | 'clean_signup' | null = null;
  if (op.expected_owner_person_id !== null && op.expected_owner_generation !== null
    && owner?.personId === op.expected_owner_person_id && owner.generation === op.expected_owner_generation) {
    personId = owner.personId;
    proofKind = 'claim_owner';
  } else if (op.expected_owner_person_id === null && input.signupOperationId) {
    personId = await cleanSignupPerson(db, { campusId: op.campus_id, signupOperationId: input.signupOperationId,
      contactPointId: op.expected_contact_point_id });
    if (personId !== null) proofKind = 'clean_signup';
  }
  if (personId === null || proofKind === null) return markReview(db, op);

  const receiptId = crypto.randomUUID();
  const receipt = db.prepare(`INSERT INTO identity_source_attachment_receipts(receipt_id,campus_id,source_record_id,
    source_version,source_digest,person_id,proof_kind,claim_operation_id,challenge_id,contact_point_id,signup_account_operation_id,session_epoch,owner_generation)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,?12)`)
    .bind(receiptId, op.campus_id, op.source_record_id, op.expected_source_version, op.expected_source_digest,
      personId, proofKind, op.operation_id, op.challenge_id, op.expected_contact_point_id,
      proofKind === 'clean_signup' ? input.signupOperationId ?? null : null,
      proofKind === 'claim_owner' ? op.expected_owner_generation : null);
  try {
    await db.batch([
      receipt,
      db.prepare(`UPDATE identity_source_records SET state='linked',linked_person_id=?1,updated_at=datetime('now')
        WHERE id=?2 AND state='unlinked' AND version=?3 AND source_digest=?4`)
        .bind(personId, op.source_record_id, op.expected_source_version, op.expected_source_digest),
      db.prepare(`UPDATE identity_observations SET status='linked',linked_person_id=?1,updated_at=datetime('now')
        WHERE id=(SELECT observation_id FROM identity_source_records WHERE id=?2)`).bind(personId, op.source_record_id),
      db.prepare(`INSERT INTO identity_source_attachment_commits(commit_id,campus_id,receipt_id,source_record_id,person_id)
        VALUES(?1,?2,?3,?4,?5)`).bind(crypto.randomUUID(), op.campus_id, receiptId, op.source_record_id, personId),
      db.prepare(`UPDATE identity_claim_operations SET state='completed',result_person_id=?1,result_proof_kind=?2,updated_at=datetime('now')
        WHERE operation_id=?3 AND state='pending'`).bind(personId, proofKind, op.operation_id),
      db.prepare(`UPDATE identity_challenges SET ownership_consumed_at=datetime('now')
        WHERE id=?1 AND ownership_consumed_at IS NULL`).bind(op.challenge_id),
      db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,subject_person_id,contact_point_id,metadata_json)
        VALUES(?1,'identity_source_claim_attached',?2,?3,'{}')`).bind(op.campus_id, personId, op.expected_contact_point_id),
    ]);
  } catch {
    const saved = await operation(db, op.campus_id, op.operation_id);
    if (saved?.state === 'completed' && saved.result_person_id !== null) {
      return { status: 'attached', personId: saved.result_person_id };
    }
    const lateOwner = await uniqueOwnerAtContact(db, op.campus_id, op.expected_contact_point_id);
    if (proofKind === 'claim_owner' && (lateOwner?.personId !== personId || lateOwner.generation !== op.expected_owner_generation)) {
      return markReview(db, op);
    }
    throw new Error('identity_source_claim_conflict');
  }
  const committed = await db.prepare(`SELECT 1 ok FROM identity_claim_operations op
    JOIN identity_source_records s ON s.id=op.source_record_id
    JOIN identity_source_attachment_receipts r ON r.claim_operation_id=op.operation_id
    JOIN identity_source_attachment_commits c ON c.receipt_id=r.receipt_id AND c.source_record_id=s.id
    JOIN identity_observations o ON o.id=s.observation_id
    WHERE op.operation_id=?1 AND op.state='completed' AND op.result_person_id=?2 AND op.result_proof_kind=?3
      AND s.state='linked' AND s.linked_person_id=?2 AND s.version=op.expected_source_version
      AND s.source_digest=op.expected_source_digest AND r.person_id=?2 AND r.proof_kind=?3
      AND c.person_id=?2
      AND r.source_version=s.version AND r.source_digest=s.source_digest
      AND o.status='linked' AND o.linked_person_id=?2`).bind(op.operation_id, personId, proofKind).first<number>('ok');
  if (committed !== 1) throw new Error('identity_source_claim_conflict');
  return { status: 'attached', personId };
}
