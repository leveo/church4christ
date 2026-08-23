import type { AppDb } from './appDb';
import { beginSignup, claimSignupSessionDelivery, completeVerifiedSignup } from './identityAccount';
import { createNewcomerSubmission } from './newcomerDb';
import type { ValidatedNewcomerIntake } from './newcomerValidation';
import { addMemberByPerson, type InlineMemberInput } from './groupDb';
import type { IdentityAuthEnv, IdentityTrustedRequestContext } from './identityAuth';
import {
  attachIdentitySourceForSignedInSession,
  createProvisionalPersonForObservation,
  getIdentitySourceRecord,
  identityGatewaySessionContext,
  registerIdentitySource,
  type IdentityGatewaySessionContext,
  type IdentitySourceKeyEnv,
} from './identityGateway';

type BusinessEnv = IdentityAuthEnv & IdentitySourceKeyEnv;
type TeamIntentRow = {
  intent_id: string;
  campus_id: number;
  source_record_id: number;
  source_version: number;
  source_digest: string;
  payload_digest: string;
  signup_reservation_id: string;
  signup_operation_id: string | null;
  signup_issuance_token: string | null;
  signup_issuance_expires_at: string | null;
  result_person_id: number | null;
  state: 'pending_verification' | 'ready' | 'consumed' | 'review' | 'expired';
  business_record_key: string | null;
  expires_at: string;
  team_id: number;
  position_id: number | null;
  message: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;
}
function databaseId(): number {
  return 1_100_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000);
}
function cleanMessage(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null;
  const message = value.trim();
  if (encoder.encode(message).byteLength > 4000 || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(message)) {
    throw new Error('identity_business_intent_invalid');
  }
  return message;
}
async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function expiry(now?: string): string {
  const date = now ? new Date(`${now.replace(' ', 'T')}Z`) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error('identity_business_intent_invalid');
  date.setUTCMinutes(date.getUTCMinutes() + 15);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
function canonicalNow(now?: string): string {
  const date = now ? new Date(`${now.replace(' ', 'T')}Z`) : new Date();
  if (!Number.isFinite(date.getTime())) throw new Error('identity_business_intent_invalid');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
function issuanceExpiry(now?: string): string {
  const date = new Date(`${canonicalNow(now).replace(' ', 'T')}Z`); date.setUTCMinutes(date.getUTCMinutes() + 2);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function teamIntent(db: AppDb, campusId: number, intentId: string): Promise<TeamIntentRow | null> {
  return db.prepare(`SELECT i.*,t.team_id,t.position_id,t.message FROM identity_business_intents i
    JOIN identity_team_application_intents t ON t.intent_id=i.intent_id
    WHERE i.intent_id=?1 AND i.campus_id=?2 AND i.kind='team_application'`)
    .bind(intentId, campusId).first<TeamIntentRow>();
}

type TeamIntentInput = {
  campusId: number;
  intentId: string;
  teamId: number;
  positionId: number | null;
  message: string | null;
  name: string;
  email: string;
  phone: string | null;
};

async function ensureTeamIntent(db: AppDb, env: BusinessEnv, input: TeamIntentInput, now?: string): Promise<TeamIntentRow> {
  if (!validId(input.campusId) || !UUID.test(input.intentId) || !validId(input.teamId)
    || (input.positionId !== null && !validId(input.positionId))) throw new Error('identity_business_intent_invalid');
  const message = cleanMessage(input.message);
  const target = await db.prepare(`SELECT 1 ok FROM teams t WHERE t.id=?1 AND t.campus_id=?2 AND t.deleted_at IS NULL
    AND (CAST(?3 AS INTEGER) IS NULL OR EXISTS (SELECT 1 FROM positions p WHERE p.id=CAST(?3 AS INTEGER)
      AND p.team_id=t.id AND p.campus_id=t.campus_id AND p.deleted_at IS NULL))`)
    .bind(input.teamId, input.campusId, input.positionId).first<number>('ok');
  if (target !== 1) throw new Error('identity_business_intent_invalid');
  const payloadDigest = await digest(JSON.stringify({ kind: 'team_application', teamId: input.teamId,
    positionId: input.positionId, message }));
  let existing = await teamIntent(db, input.campusId, input.intentId);
  if (existing) {
    if (existing.payload_digest !== payloadDigest || existing.team_id !== input.teamId
      || existing.position_id !== input.positionId || existing.message !== message) {
      throw new Error('identity_business_intent_payload_drift');
    }
    return existing;
  }
  const source = await registerIdentitySource(db, env, {
    campusId: input.campusId, source: 'team', sourceRecordKey: input.intentId,
    email: input.email, phone: input.phone, name: input.name,
    attachmentPolicy: 'signed_in_or_claim', sourceDigest: payloadDigest,
  });
  try {
    await db.batch([
      db.prepare(`INSERT INTO identity_business_intents(intent_id,campus_id,kind,source_record_id,source_version,
        source_digest,payload_digest,signup_reservation_id,expires_at) VALUES(?1,?2,'team_application',?3,?4,?5,?6,?1,?7)`)
        .bind(input.intentId, input.campusId, source.sourceRecordId, source.version, source.sourceDigest,
          payloadDigest, expiry(now)),
      db.prepare(`INSERT INTO identity_team_application_intents(intent_id,team_id,position_id,message)
        VALUES(?1,?2,?3,?4)`).bind(input.intentId, input.teamId, input.positionId, message),
    ]);
  } catch {
    existing = await teamIntent(db, input.campusId, input.intentId);
    if (!existing || existing.payload_digest !== payloadDigest || existing.team_id !== input.teamId
      || existing.position_id !== input.positionId || existing.message !== message) {
      throw new Error('identity_business_intent_conflict');
    }
    return existing;
  }
  existing = await teamIntent(db, input.campusId, input.intentId);
  if (!existing) throw new Error('identity_business_intent_unavailable');
  return existing;
}

export async function beginTeamApplicationIntent(db: AppDb, env: BusinessEnv, input: TeamIntentInput & {
  requestContext: IdentityTrustedRequestContext;
  now?: string;
}): Promise<{ status: 'verification_required'; intentId: string; delivery: { to: string; publicId: string; code: string; expiresAt: string } }
  | { status: 'pending'; intentId: string }> {
  const intent = await ensureTeamIntent(db, env, input, input.now);
  if (intent.state !== 'pending_verification') {
    return { status: 'pending', intentId: intent.intent_id };
  }
  const now = canonicalNow(input.now);
  if (intent.expires_at <= now) {
    await db.prepare("UPDATE identity_business_intents SET state='expired',updated_at=?1 WHERE intent_id=?2 AND state='pending_verification'")
      .bind(now, intent.intent_id).run();
    return { status: 'pending', intentId: intent.intent_id };
  }
  if (intent.signup_operation_id) return { status: 'pending', intentId: input.intentId };
  const reservedExists = await db.prepare('SELECT 1 ok FROM identity_account_operations WHERE operation_id=?1 AND campus_id=?2')
    .bind(intent.signup_reservation_id, input.campusId).first<number>('ok');
  if (reservedExists === 1) {
    try { await db.prepare(`UPDATE identity_business_intents SET signup_operation_id=signup_reservation_id,
      signup_issuance_token=NULL,signup_issuance_expires_at=NULL,updated_at=?1
      WHERE intent_id=?2 AND campus_id=?3 AND state='pending_verification' AND signup_operation_id IS NULL`)
      .bind(now, input.intentId, input.campusId).run(); } catch { /* a durable concurrent binder wins */ }
    return { status: 'pending', intentId: input.intentId };
  }
  const issuanceToken = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE identity_business_intents SET signup_issuance_token=?1,signup_issuance_expires_at=?2,updated_at=?3
    WHERE intent_id=?4 AND campus_id=?5 AND state='pending_verification' AND signup_operation_id IS NULL
      AND (signup_issuance_token IS NULL OR signup_issuance_expires_at<=?3)`)
    .bind(issuanceToken, issuanceExpiry(input.now), now, input.intentId, input.campusId).run();
  if (claimed.meta.changes !== 1) return { status: 'pending', intentId: input.intentId };
  const signupOperationId = intent.signup_reservation_id;
  const exists = await db.prepare('SELECT 1 ok FROM identity_account_operations WHERE operation_id=?1 AND campus_id=?2')
    .bind(signupOperationId, input.campusId).first<number>('ok');
  if (exists === 1) {
    await db.prepare(`UPDATE identity_business_intents SET signup_operation_id=?1,signup_issuance_token=NULL,
      signup_issuance_expires_at=NULL,updated_at=?2 WHERE intent_id=?3 AND signup_issuance_token=?4`)
      .bind(signupOperationId, now, input.intentId, issuanceToken).run();
    return { status: 'pending', intentId: input.intentId };
  }
  let begun;
  try {
    begun = await beginSignup(db, env, { campusId: input.campusId, email: input.email, displayName: input.name,
      requestContext: input.requestContext, source: 'web', now: input.now, reservedOperationId: signupOperationId });
    const bound = await db.prepare(`UPDATE identity_business_intents SET signup_operation_id=?1,signup_issuance_token=NULL,
      signup_issuance_expires_at=NULL,updated_at=?2 WHERE intent_id=?3 AND campus_id=?4 AND state='pending_verification'
        AND signup_operation_id IS NULL AND signup_issuance_token=?5`)
      .bind(signupOperationId, now, input.intentId, input.campusId, issuanceToken).run();
    if (bound.meta.changes !== 1) throw new Error('identity_business_intent_conflict');
  } catch (error) {
    const raced = await db.prepare('SELECT 1 ok FROM identity_account_operations WHERE operation_id=?1 AND campus_id=?2')
      .bind(signupOperationId, input.campusId).first<number>('ok');
    if (raced === 1) {
      try { await db.prepare(`UPDATE identity_business_intents SET signup_operation_id=?1,signup_issuance_token=NULL,
        signup_issuance_expires_at=NULL,updated_at=?2 WHERE intent_id=?3 AND signup_operation_id IS NULL AND signup_issuance_token=?4`)
        .bind(signupOperationId, now, input.intentId, issuanceToken).run(); } catch { /* durable winner or invalid binding */ }
      return { status: 'pending', intentId: input.intentId };
    }
    await db.prepare(`UPDATE identity_business_intents SET signup_issuance_token=NULL,signup_issuance_expires_at=NULL,updated_at=?1
      WHERE intent_id=?2 AND signup_issuance_token=?3`).bind(now, input.intentId, issuanceToken).run();
    throw error;
  }
  return { status: 'verification_required', intentId: input.intentId, delivery: begun.delivery };
}

async function consumedTeamResult(db: AppDb, intent: TeamIntentRow): Promise<{ status: 'consumed'; applicationId: number; personId: number } | null> {
  if (intent.state !== 'consumed' || intent.result_person_id === null || !/^\d+$/.test(intent.business_record_key ?? '')) return null;
  const applicationId = Number(intent.business_record_key);
  const valid = await db.prepare(`SELECT 1 ok FROM team_applications WHERE id=?1 AND campus_id=?2 AND person_id=?3 AND team_id=?4`)
    .bind(applicationId, intent.campus_id, intent.result_person_id, intent.team_id).first<number>('ok');
  return valid === 1 ? { status: 'consumed', applicationId, personId: intent.result_person_id } : null;
}

async function consumeTeam(db: AppDb, env: BusinessEnv, intent: TeamIntentRow, personId: number,
  sessionEpoch: number): Promise<{ status: 'consumed'; applicationId: number; personId: number }> {
  const prior = await consumedTeamResult(db, intent); if (prior) return prior;
  const source = await getIdentitySourceRecord(db, env, { campusId: intent.campus_id, source: 'team', sourceRecordKey: intent.intent_id });
  if (!source || source.id !== intent.source_record_id || source.version !== intent.source_version
    || source.source_digest !== intent.source_digest) throw new Error('identity_business_intent_stale');
  await attachIdentitySourceForSignedInSession(db, env, {
    campusId: intent.campus_id, source: 'team', sourceRecordKey: intent.intent_id,
    expectedVersion: intent.source_version, sourceDigest: intent.source_digest,
    session: identityGatewaySessionContext({ personId, campusId: intent.campus_id, sessionEpoch }),
  });
  try {
    await db.prepare(`UPDATE identity_business_intents SET state='ready',result_person_id=?1,updated_at=datetime('now')
      WHERE intent_id=?2 AND state='pending_verification'`).bind(personId, intent.intent_id).run();
  } catch {
    const raced = await teamIntent(db, intent.campus_id, intent.intent_id);
    if (!raced || (raced.state !== 'ready' && raced.state !== 'consumed') || raced.result_person_id !== personId) {
      throw new Error('identity_business_intent_conflict');
    }
    intent = raced;
  }
  let applicationId = databaseId();
  const commit = async (id: number) => db.batch([
    db.prepare(`INSERT INTO team_applications(id,campus_id,person_id,team_id,position_id,message,status)
      VALUES(?1,?2,?3,?4,?5,?6,'P') ON CONFLICT(person_id,team_id) WHERE status='P' DO NOTHING`)
      .bind(id, intent.campus_id, personId, intent.team_id, intent.position_id, intent.message),
    db.prepare(`INSERT INTO identity_business_intent_receipts(receipt_id,campus_id,intent_id,source_record_id,
      source_version,source_digest,person_id,business_record_key) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`)
      .bind(crypto.randomUUID(), intent.campus_id, intent.intent_id, intent.source_record_id, intent.source_version,
        intent.source_digest, personId, String(id)),
    db.prepare(`UPDATE identity_business_intents SET state='consumed',business_record_key=?1,updated_at=datetime('now')
      WHERE intent_id=?2 AND state='ready' AND result_person_id=?3`).bind(String(id), intent.intent_id, personId),
    db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,subject_person_id,metadata_json)
      VALUES(?1,'identity_business_intent_consumed',?2,'{}')`).bind(intent.campus_id, personId),
  ]);
  try { await commit(applicationId); }
  catch {
    const saved = await teamIntent(db, intent.campus_id, intent.intent_id);
    const consumed = saved && await consumedTeamResult(db, saved); if (consumed) return consumed;
    const existing = await db.prepare(`SELECT id FROM team_applications WHERE campus_id=?1 AND person_id=?2 AND team_id=?3 AND status='P'`)
      .bind(intent.campus_id, personId, intent.team_id).first<number>('id');
    if (existing === null) throw new Error('identity_business_intent_conflict');
    applicationId = existing;
    try { await db.batch([
      db.prepare(`INSERT INTO identity_business_intent_receipts(receipt_id,campus_id,intent_id,source_record_id,
        source_version,source_digest,person_id,business_record_key) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`)
        .bind(crypto.randomUUID(), intent.campus_id, intent.intent_id, intent.source_record_id, intent.source_version,
          intent.source_digest, personId, String(applicationId)),
      db.prepare(`UPDATE identity_business_intents SET state='consumed',business_record_key=?1,updated_at=datetime('now')
        WHERE intent_id=?2 AND state='ready' AND result_person_id=?3`).bind(String(applicationId), intent.intent_id, personId),
    ]); } catch {
      const late = await teamIntent(db, intent.campus_id, intent.intent_id);
      const durable = late && await consumedTeamResult(db, late); if (durable) return durable;
      throw new Error('identity_business_intent_conflict');
    }
  }
  return { status: 'consumed', applicationId, personId };
}

export async function completeTeamApplicationIntent(db: AppDb, env: BusinessEnv, input: {
  campusId: number; intentId: string; publicId: string; code: string; now?: string;
}): Promise<({ status: 'consumed'; applicationId: number; personId: number; createdIdentity: boolean })
  | { status: 'review' } | { status: 'invalid' }> {
  if (!validId(input.campusId) || !UUID.test(input.intentId)) return { status: 'invalid' };
  let intent = await teamIntent(db, input.campusId, input.intentId); if (!intent) return { status: 'invalid' };
  const prior = await consumedTeamResult(db, intent); if (prior) return { ...prior, createdIdentity: false };
  if (intent.expires_at <= canonicalNow(input.now)) {
    try { await db.prepare("UPDATE identity_business_intents SET state='expired',updated_at=?1 WHERE intent_id=?2 AND state='pending_verification'")
      .bind(canonicalNow(input.now), intent.intent_id).run(); } catch { /* a concurrent terminal result wins */ }
    return { status: 'invalid' };
  }
  if (!intent.signup_operation_id) return { status: 'invalid' };
  const result = await completeVerifiedSignup(db, env, { campusId: input.campusId, operationId: intent.signup_operation_id,
    publicId: input.publicId, code: input.code, source: 'web', now: input.now });
  if (result.status === 'review') {
    try { await db.prepare("UPDATE identity_business_intents SET state='review',updated_at=datetime('now') WHERE intent_id=?1 AND state='pending_verification'")
      .bind(intent.intent_id).run(); } catch { /* durable account review remains authoritative */ }
    return { status: 'review' };
  }
  if (result.status !== 'authenticated') return { status: 'invalid' };
  intent = await teamIntent(db, input.campusId, input.intentId); if (!intent) return { status: 'invalid' };
  const consumed = await consumeTeam(db, env, intent, result.personId, result.sessionEpoch);
  return { ...consumed, createdIdentity: result.created };
}

export async function claimTeamApplicationSessionDelivery(db: AppDb, env: BusinessEnv, input: {
  campusId: number; intentId: string; publicId: string; code: string;
}): Promise<{ personId: number; sessionEpoch: number } | null> {
  if (!validId(input.campusId) || !UUID.test(input.intentId)) return null;
  const intent = await teamIntent(db, input.campusId, input.intentId);
  if (!intent || intent.state !== 'consumed' || intent.result_person_id === null || !intent.signup_operation_id) return null;
  const claim = await claimSignupSessionDelivery(db, env, { campusId: input.campusId,
    operationId: intent.signup_operation_id, publicId: input.publicId, code: input.code, source: 'web' });
  return claim ? { personId: intent.result_person_id, sessionEpoch: claim.sessionEpoch } : null;
}

export async function consumeSignedInTeamApplicationIntent(db: AppDb, env: BusinessEnv, input: Omit<TeamIntentInput, 'name' | 'email' | 'phone'> & {
  session: IdentityGatewaySessionContext;
}): Promise<{ status: 'consumed'; applicationId: number; personId: number }> {
  const owner = await db.prepare(`SELECT p.display_name,cp.normalized_value email FROM people p
    JOIN verified_contact_owners o ON o.person_id=p.id JOIN contact_points cp ON cp.id=o.contact_point_id AND cp.kind='email'
    LEFT JOIN person_contact_links l ON l.person_id=p.id AND l.contact_point_id=cp.id
    WHERE p.id=?1 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
    ORDER BY COALESCE(l.is_primary,0) DESC,cp.id LIMIT 1`)
    .bind(input.session.personId).first<{ display_name: string; email: string }>();
  if (!owner) throw new Error('identity_business_intent_verified_owner_required');
  const intent = await ensureTeamIntent(db, env, { ...input, name: owner.display_name, email: owner.email, phone: null });
  if (intent.expires_at <= canonicalNow()) throw new Error('identity_business_intent_expired');
  return consumeTeam(db, env, intent, input.session.personId, input.session.sessionEpoch);
}

type NewcomerIntentRow = {
  intent_id: string;
  campus_id: number;
  source_record_id: number;
  source_version: number;
  source_digest: string;
  payload_digest: string;
  result_person_id: number | null;
  state: 'pending_verification' | 'ready' | 'consumed' | 'review' | 'expired';
  business_record_key: string | null;
  submission_id: string;
  provisional_person_id: number;
};

async function newcomerIntent(db: AppDb, campusId: number, intentId: string): Promise<NewcomerIntentRow | null> {
  return db.prepare(`SELECT i.*,n.submission_id,n.provisional_person_id FROM identity_business_intents i
    JOIN identity_newcomer_intents n ON n.intent_id=i.intent_id
    WHERE i.intent_id=?1 AND i.campus_id=?2 AND i.kind='newcomer_submission'`)
    .bind(intentId, campusId).first<NewcomerIntentRow>();
}

function newcomerDigestPayload(intake: ValidatedNewcomerIntake): string {
  return JSON.stringify({
    kind: 'newcomer_submission', name: intake.name, email: intake.email, phone: intake.phone,
    locale: intake.locale, visitDate: intake.visitDate, serviceTypeId: intake.serviceTypeId,
    contactConsent: intake.contactConsent,
    answers: intake.answers.map((answer) => ({ fieldId: answer.fieldId, value: answer.value })),
  });
}

export async function createNewcomerObservationIntent(db: AppDb, env: BusinessEnv, input: {
  campusId: number;
  intentId: string;
  backend: 'd1' | 'supabase';
  intake: ValidatedNewcomerIntake;
}): Promise<{ status: 'consumed'; submissionId: string; provisionalPersonId: number; createdProvisional: boolean }
  | { status: 'review' }> {
  if (!validId(input.campusId) || !UUID.test(input.intentId)
    || (input.backend !== 'd1' && input.backend !== 'supabase')) throw new Error('identity_business_intent_invalid');
  const payloadDigest = await digest(newcomerDigestPayload(input.intake));
  const source = await registerIdentitySource(db, env, {
    campusId: input.campusId, source: 'newcomer', sourceRecordKey: input.intentId,
    email: input.intake.email, phone: input.intake.phone, name: input.intake.name,
    attachmentPolicy: 'observation_only', sourceDigest: payloadDigest,
  });
  const prior = await newcomerIntent(db, input.campusId, input.intentId);
  if (prior) {
    if (prior.payload_digest !== payloadDigest || prior.source_record_id !== source.sourceRecordId) {
      throw new Error('identity_business_intent_payload_drift');
    }
    if (prior.state === 'review') return { status: 'review' };
    if (prior.state === 'consumed' && prior.result_person_id !== null && prior.business_record_key === prior.submission_id) {
      return { status: 'consumed', submissionId: prior.submission_id,
        provisionalPersonId: prior.result_person_id, createdProvisional: false };
    }
  }
  let provisional;
  try {
    provisional = await createProvisionalPersonForObservation(db, env, {
      campusId: input.campusId, source: 'newcomer', sourceRecordKey: input.intentId,
      expectedVersion: source.version, sourceDigest: source.sourceDigest,
    });
  } catch {
    try { await db.batch([
      db.prepare("UPDATE identity_source_records SET state='review',updated_at=datetime('now') WHERE id=?1 AND state='unlinked' AND provisional_person_id IS NULL")
        .bind(source.sourceRecordId),
      db.prepare("UPDATE identity_observations SET status='review',updated_at=datetime('now') WHERE id=?1 AND status='provisional' AND linked_person_id IS NULL")
        .bind(source.observationId),
    ]); } catch { /* remain unlinked rather than guessing an identity */ }
    return { status: 'review' };
  }
  await createNewcomerSubmission(db, null, 'public', input.intake, {
    backend: input.backend, operationId: input.intentId,
    identitySourceRecordId: source.sourceRecordId, linkedPersonId: provisional.personId,
  });
  let intent = await newcomerIntent(db, input.campusId, input.intentId);
  if (!intent) {
    try { await db.batch([
      db.prepare(`INSERT INTO identity_business_intents(intent_id,campus_id,kind,source_record_id,source_version,
        source_digest,payload_digest,signup_reservation_id,expires_at)
        VALUES(?1,?2,'newcomer_submission',?3,?4,?5,?6,?1,datetime('now','+7 days'))`)
        .bind(input.intentId, input.campusId, source.sourceRecordId, source.version, source.sourceDigest, payloadDigest),
      db.prepare(`INSERT INTO identity_newcomer_intents(intent_id,submission_id,provisional_person_id)
        VALUES(?1,?1,?2)`).bind(input.intentId, provisional.personId),
    ]); } catch { /* a concurrent exact creator may have won */ }
    intent = await newcomerIntent(db, input.campusId, input.intentId);
  }
  if (!intent || intent.payload_digest !== payloadDigest || intent.provisional_person_id !== provisional.personId) {
    throw new Error('identity_business_intent_conflict');
  }
  if (intent.state !== 'consumed') {
    try { await db.batch([
      db.prepare(`UPDATE identity_business_intents SET state='ready',result_person_id=?1,updated_at=datetime('now')
        WHERE intent_id=?2 AND state='pending_verification'`).bind(provisional.personId, input.intentId),
      db.prepare(`INSERT INTO identity_business_intent_receipts(receipt_id,campus_id,intent_id,source_record_id,
        source_version,source_digest,person_id,business_record_key) VALUES(?1,?2,?3,?4,?5,?6,?7,?3)`)
        .bind(crypto.randomUUID(), input.campusId, input.intentId, source.sourceRecordId, source.version,
          source.sourceDigest, provisional.personId),
      db.prepare(`UPDATE identity_business_intents SET state='consumed',business_record_key=?1,updated_at=datetime('now')
        WHERE intent_id=?1 AND state='ready' AND result_person_id=?2`).bind(input.intentId, provisional.personId),
      db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,subject_person_id,metadata_json)
        VALUES(?1,'identity_newcomer_observation_consumed',?2,'{}')`).bind(input.campusId, provisional.personId),
    ]); } catch {
      const raced = await newcomerIntent(db, input.campusId, input.intentId);
      if (!raced || raced.state !== 'consumed' || raced.result_person_id !== provisional.personId
        || raced.business_record_key !== input.intentId) throw new Error('identity_business_intent_conflict');
    }
  }
  return { status: 'consumed', submissionId: input.intentId, provisionalPersonId: provisional.personId,
    createdProvisional: provisional.created };
}

export async function createGroupMemberObservation(db: AppDb, env: BusinessEnv, input: {
  campusId: number;
  operationId: string;
  groupId: number;
  member: InlineMemberInput;
}): Promise<{ status: 'created'; memberId: number; provisionalPersonId: number } | { status: 'review' }> {
  if (!validId(input.campusId) || !UUID.test(input.operationId) || !validId(input.groupId)) {
    throw new Error('identity_business_intent_invalid');
  }
  const group = await db.prepare('SELECT 1 ok FROM groups WHERE id=?1 AND campus_id=?2 AND deleted_at IS NULL')
    .bind(input.groupId, input.campusId).first<number>('ok');
  if (group !== 1) throw new Error('identity_business_intent_invalid');
  const displayName = [input.member.firstName, input.member.lastName].map((part) => part.trim()).filter(Boolean).join(' ');
  if (!input.member.email && !input.member.phone) throw new Error('identity_source_notification_contact_required');
  const sourceDigest = await digest(JSON.stringify({ kind: 'group_member_observation', groupId: input.groupId }));
  const source = await registerIdentitySource(db, env, {
    campusId: input.campusId, source: 'group', sourceRecordKey: input.operationId,
    email: input.member.email, phone: input.member.phone, name: displayName,
    attachmentPolicy: 'observation_only', sourceDigest,
  });
  let provisional;
  try {
    provisional = await createProvisionalPersonForObservation(db, env, { campusId: input.campusId, source: 'group',
      sourceRecordKey: input.operationId, expectedVersion: source.version, sourceDigest: source.sourceDigest });
  } catch {
    try { await db.batch([
      db.prepare("UPDATE identity_source_records SET state='review',updated_at=datetime('now') WHERE id=?1 AND state='unlinked' AND provisional_person_id IS NULL")
        .bind(source.sourceRecordId),
      db.prepare("UPDATE identity_observations SET status='review',updated_at=datetime('now') WHERE id=?1 AND status='provisional' AND linked_person_id IS NULL")
        .bind(source.observationId),
    ]); } catch { /* fail closed as review */ }
    return { status: 'review' };
  }
  const memberId = await addMemberByPerson(db, input.groupId, provisional.personId);
  return { status: 'created', memberId, provisionalPersonId: provisional.personId };
}
