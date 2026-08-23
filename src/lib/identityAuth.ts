import type { AppDb, AppDbResult, AppStatement } from './appDb';
import { findVerifiedContactOwner, normalizeIdentityContact, upsertContactPoint, type ContactPoint, type IdentityContactKind, type VerifiedOwner } from './identityDb';
import { hasValidIdentityVerificationSecret } from './identitySecret';

export type IdentityAuthEnv = { IDENTITY_VERIFICATION_SECRET?: string };
export type IdentityChallengePurpose = 'login' | 'signup' | 'claim' | 'contact_change' | 'recovery' | 'step_up';
export type IdentityChallengeSource = 'web' | 'mobile_web' | 'kiosk' | 'admin' | 'provider';
const trustedRequestContextBrand: unique symbol = Symbol('identity_trusted_request_context');
export type IdentityTrustedRequestContext = Readonly<{ cfConnectingIp: string | null; deviceId: string | null; [trustedRequestContextBrand]: true }>;
type ChallengeKind = 'otp' | 'link';
const PURPOSES = new Set<IdentityChallengePurpose>(['login', 'signup', 'claim', 'contact_change', 'recovery', 'step_up']);
const SOURCES = new Set<IdentityChallengeSource>(['web', 'mobile_web', 'kiosk', 'admin', 'provider']);
const encoder = new TextEncoder();

function assertSecret(env: IdentityAuthEnv): string {
  const secret = env.IDENTITY_VERIFICATION_SECRET;
  if (!hasValidIdentityVerificationSecret(secret)) throw new Error('identity_verification_unavailable');
  return secret;
}
function hex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** HMAC domain-separates every persisted hash from OTPs, buckets, and link tokens. */
export async function hmacIdentityValue(secret: string, scope: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`identity-auth/v1\0${scope}\0${value}`)));
}
export function constantTimeIdentityHashEqual(left: string | null | undefined, right: string): boolean {
  const a = encoder.encode(left ?? ''); const b = encoder.encode(right);
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) different |= (a[index % (a.length || 1)] ?? 0) ^ (b[index % b.length] ?? 0);
  return different === 0;
}
const sameHash = constantTimeIdentityHashEqual;
function format(date: Date): string { return date.toISOString().slice(0, 19).replace('T', ' '); }
function clock(value?: string): { now: string; expiry: string; rateExpiry: string; window: string } {
  const instant = value === undefined ? new Date() : new Date(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(instant.getTime()) || (value !== undefined && format(instant) !== value)) throw new Error('identity_clock_invalid');
  const now = format(instant);
  const expires = new Date(instant.getTime() + 10 * 60_000);
  instant.setUTCMinutes(Math.floor(instant.getUTCMinutes() / 15) * 15, 0, 0);
  const window = format(instant);
  instant.setUTCMinutes(instant.getUTCMinutes() + 15);
  return { now, expiry: format(expires), rateExpiry: format(instant), window };
}
function isPublicId(value: string): boolean { return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value); }
function publicId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const raw = hex(bytes.buffer);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}
function databaseId(): number { return 1_000_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000); }
/** Rejection sampling avoids modulo bias in the one-million code space. */
export function generateOtpCode(
  random: (bytes: Uint32Array<ArrayBuffer>) => Uint32Array<ArrayBuffer> = (bytes) => crypto.getRandomValues(bytes) as Uint32Array<ArrayBuffer>,
): string {
  const bound = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  let value: number;
  do { value = random(new Uint32Array(1))[0]; } while (value >= bound);
  return String(value % 1_000_000).padStart(6, '0');
}
function trustedIp(value: string | null | undefined): string {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  return normalized && normalized.length <= 64 && /^[0-9a-f:.]+$/i.test(normalized) ? normalized : 'unknown';
}
function opaqueDevice(value: string | null | undefined): string {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim();
  return normalized && normalized.length <= 256 && /^[a-zA-Z0-9._-]+$/.test(normalized) ? normalized : 'unknown';
}
function isTrustedRequestContext(value: IdentityTrustedRequestContext | undefined): value is IdentityTrustedRequestContext {
  return Boolean(value && value[trustedRequestContextBrand] === true && Object.isFrozen(value));
}
function count(result: AppDbResult<unknown> | undefined): number | null {
  const row = result?.results?.[0] as { count?: unknown } | undefined;
  return typeof row?.count === 'number' && Number.isSafeInteger(row.count) ? row.count : null;
}
function rateStatement(db: AppDb, campusId: number, scope: string, hash: string, part: { window: string; rateExpiry: string }) {
  return db.prepare(`INSERT INTO identity_rate_limits(campus_id,bucket_hash,scope,window_started_at,count,expires_at)
    VALUES(?1,?2,?3,?4,1,?5)
    ON CONFLICT(campus_id,bucket_hash,scope,window_started_at) DO UPDATE SET count=identity_rate_limits.count+1
    RETURNING count`).bind(campusId, hash, scope, part.window, part.rateExpiry);
}

type UntargetedPurpose = Exclude<IdentityChallengePurpose, 'contact_change' | 'step_up'>;
type RequestInput = { campusId: number; email: string; source?: IdentityChallengeSource; requestContext: IdentityTrustedRequestContext; now?: string } & (
  { purpose: 'contact_change' | 'step_up'; targetPersonId: number }
  | { purpose: UntargetedPurpose; targetPersonId?: never }
);
export type IdentityMergeStepUpBinding = Readonly<{
  operation_id: string;
  operation_version: number;
  preview_hash: string;
  risk_state_hash: string;
  risk_state_version: number;
  resolution_case_version: number;
  resolution_case_hash: string;
  approver_person_id: number;
  approver_identity_version: number;
  campus_id: number;
}>;
export type IdentityMergeRollbackStepUpBinding = Readonly<{
  rollback_id: string;
  rollback_version: number;
  operation_id: string;
  expected_operation_version: number;
  journal_hash: string;
  journal_count: number;
  approver_person_id: number;
  approver_identity_version: number;
  campus_id: number;
}>;
type TrustedStepUpContext = Readonly<{ person_merge_approval: IdentityMergeStepUpBinding }
  | { person_merge_rollback_approval: IdentityMergeRollbackStepUpBinding }>;
export type IssuedOtp = { limited: boolean; publicId: string; code: string; expiresAt: string };

async function consumeRequestLimits(db: AppDb, secret: string, input: RequestInput, part: { now: string; expiry: string; rateExpiry: string; window: string }): Promise<boolean> {
  const normalized = normalizeIdentityContact('email', input.email);
  if (!normalized || !PURPOSES.has(input.purpose) || !SOURCES.has(input.source ?? 'web') || !isTrustedRequestContext(input.requestContext)) throw new Error('identity_challenge_invalid');
  const [contactHash, ipHash, deviceHash] = await Promise.all([
    hmacIdentityValue(secret, 'rate:contact', `email:${normalized}`),
    hmacIdentityValue(secret, 'rate:ip', trustedIp(input.requestContext?.cfConnectingIp)),
    hmacIdentityValue(secret, 'rate:device', opaqueDevice(input.requestContext?.deviceId)),
  ]);
  const result = await db.batch([
    db.prepare('DELETE FROM identity_rate_limits WHERE expires_at<=?1').bind(part.now),
    rateStatement(db, input.campusId, 'otp_request_contact', contactHash, part),
    rateStatement(db, input.campusId, 'otp_request_ip', ipHash, part),
    rateStatement(db, input.campusId, 'otp_request_device', deviceHash, part),
  ]);
  const contact = count(result[1]); const ip = count(result[2]); const device = count(result[3]);
  if (contact === null || ip === null || device === null) throw new Error('identity_rate_unavailable');
  // The unknown-IP bucket is intentionally stricter, so clients cannot evade it with forwarded headers.
  return contact <= 3 && ip <= (trustedIp(input.requestContext?.cfConnectingIp) === 'unknown' ? 8 : 20) && device <= 12;
}

/** Reused OTP material must spend the same contact/IP/device request budget as
 * a newly issued challenge. Callers still need their own durable resend CAS so
 * concurrent retries cannot turn one budget increment into multiple emails. */
export async function consumeIdentityOtpDeliveryRetryLimit(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number; email: string; requestContext: IdentityTrustedRequestContext; now?: string;
}): Promise<boolean> {
  const secret = assertSecret(env);
  const part = clock(input.now);
  return consumeRequestLimits(db, secret, { ...input, purpose: 'signup', source: 'web' }, part);
}

async function boundPersonId(db: AppDb, input: RequestInput, contact: ContactPoint): Promise<number | null> {
  const supplied = 'targetPersonId' in input ? input.targetPersonId : undefined;
  if (supplied !== undefined) {
    if ((input.purpose !== 'contact_change' && input.purpose !== 'step_up') || !Number.isSafeInteger(supplied) || supplied <= 0) throw new Error('identity_challenge_invalid');
    const eligible = await db.prepare(`SELECT 1 AS ok FROM people p LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
      WHERE p.id=?1 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL`)
      .bind(supplied).first<{ ok: number }>();
    if (!eligible) throw new Error('identity_challenge_invalid');
    if (input.purpose === 'step_up') {
      const ownsContact = await db.prepare('SELECT 1 AS ok FROM verified_contact_owners WHERE contact_point_id=?1 AND person_id=?2')
        .bind(contact.id, supplied).first<{ ok: number }>();
      if (!ownsContact) throw new Error('identity_challenge_invalid');
    }
    return supplied;
  }
  // Run the same bounded ownership-resolution query for every purpose. Only a
  // claim is allowed to use its result, so known and unknown contacts follow the
  // same operation categories without turning a shared address into identity.
  const linked = await db.prepare(`SELECT DISTINCT p.id FROM person_contact_links l JOIN people p ON p.id=l.person_id
    LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
    WHERE l.contact_point_id=?1 AND l.ended_at IS NULL AND p.active=1 AND p.deleted_at IS NULL
      AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL ORDER BY p.id LIMIT 2`)
    .bind(contact.id).all<{ id: number }>();
  const household = await db.prepare(`SELECT 1 AS linked FROM household_contact_links
    WHERE campus_id=?1 AND contact_point_id=?2 AND ended_at IS NULL LIMIT 1`).bind(input.campusId, contact.id).first<{ linked: number }>();
  const owner = await db.prepare(`SELECT o.person_id FROM verified_contact_owners o
    JOIN person_contact_links l ON l.person_id=o.person_id AND l.contact_point_id=o.contact_point_id AND l.ended_at IS NULL
    JOIN people p ON p.id=o.person_id JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=?2 AND cm.active=1
    LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
    WHERE o.contact_point_id=?1 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active'
      AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL`).bind(contact.id, input.campusId).first<{ person_id: number }>();
  if (input.purpose === 'login' || input.purpose === 'signup') return owner?.person_id ?? null;
  return input.purpose === 'claim' && linked.results.length === 1 && !household ? linked.results[0].id : null;
}

async function challengeBinding(secret: string, input: { publicId: string; campusId: number; purpose: IdentityChallengePurpose; source: IdentityChallengeSource; contactPointId: number; personId: number | null; sessionEpoch: number | null }): Promise<string> {
  return hmacIdentityValue(secret, 'challenge:context', `${input.publicId}\0${input.campusId}\0${input.purpose}\0${input.source}\0${input.contactPointId}\0${input.personId ?? 0}\0${input.sessionEpoch ?? -1}`);
}

function bindingFromJson(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { binding?: unknown }).binding === 'string'
      ? (parsed as { binding: string }).binding : null;
  } catch { return null; }
}

type PreparedChallenge = (IssuedOtp & { token?: string }) & {
  challengeId: number | null;
  contactPointId: number | null;
  statements: AppStatement[];
};

async function prepareIssue(
  db: AppDb,
  env: IdentityAuthEnv,
  input: RequestInput,
  kind: ChallengeKind,
  trustedStepUpContext?: TrustedStepUpContext,
): Promise<PreparedChallenge> {
  const secret = assertSecret(env); const part = clock(input.now);
  if (!Number.isSafeInteger(input.campusId) || input.campusId <= 0) throw new Error('identity_challenge_invalid');
  if ((input.purpose === 'contact_change' || input.purpose === 'step_up')
    && (!Number.isSafeInteger(input.targetPersonId) || (input.targetPersonId ?? 0) <= 0)) throw new Error('identity_challenge_invalid');
  const permitted = await consumeRequestLimits(db, secret, input, part);
  if (!permitted) return { limited: true, publicId: '', code: '', expiresAt: part.expiry,
    challengeId: null, contactPointId: null, statements: [] };
  const contact = await upsertContactPoint(db, { kind: 'email', value: input.email });
  const id = publicId(); const challengeId = databaseId();
  const personId = await boundPersonId(db, input, contact);
  // Snapshot the epoch before the credential is made usable.  The snapshot is
  // both HMAC-bound and checked at consumption, so a later reload can never
  // turn a pre-signout credential into a post-signout session.
  const sessionEpoch = await db.prepare(`SELECT session_epoch FROM people p
    LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
    WHERE p.id=?1 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active'
      AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL`).bind(personId ?? 0).first<number>('session_epoch');
  if (personId !== null && (!Number.isSafeInteger(sessionEpoch) || (sessionEpoch ?? -1) < 0)) throw new Error('identity_challenge_invalid');
  const raw = kind === 'otp' ? generateOtpCode() : base64url(crypto.getRandomValues(new Uint8Array(32)));
  const source = input.source ?? 'web';
  const hash = await hmacIdentityValue(secret, `${kind}:${input.purpose}:${source}`, `${id}\0${personId ?? 0}\0${raw}`);
  const binding = await challengeBinding(secret, { publicId: id, campusId: input.campusId, purpose: input.purpose, source, contactPointId: contact.id, personId, sessionEpoch });
  const requester = await hmacIdentityValue(secret, 'rate:contact', `email:${contact.normalizedValue}`);
  const hashColumn = kind === 'otp' ? 'code_hash' : 'token_hash';
  const statements = [
    db.prepare(`UPDATE identity_challenges SET superseded_at=?1 WHERE campus_id=?2 AND contact_point_id=?3 AND purpose=?4
      AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>?1`).bind(part.now, input.campusId, contact.id, input.purpose),
    db.prepare(`INSERT INTO identity_challenges(id,public_id,campus_id,purpose,request_source,person_id,contact_point_id,expected_session_epoch,${hashColumn},requester_bucket_hash,expires_at,max_attempts,context_json)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,5,?12)`).bind(challengeId, id, input.campusId, input.purpose, source, personId, contact.id, sessionEpoch, hash, requester, part.expiry, JSON.stringify({ binding, ...trustedStepUpContext })),
  ];
  return kind === 'otp'
    ? { limited: false, publicId: id, code: raw, expiresAt: part.expiry, challengeId, contactPointId: contact.id, statements }
    : { limited: false, publicId: id, code: '', token: raw, expiresAt: part.expiry, challengeId, contactPointId: contact.id, statements };
}

async function issue(db: AppDb, env: IdentityAuthEnv, input: RequestInput, kind: ChallengeKind): Promise<IssuedOtp & { token?: string }> {
  const prepared = await prepareIssue(db, env, input, kind);
  if (!prepared.limited) await db.batch(prepared.statements);
  return prepared;
}

export async function issueEmailOtpChallenge(db: AppDb, env: IdentityAuthEnv, input: RequestInput): Promise<IssuedOtp> { return issue(db, env, input, 'otp'); }
export async function prepareEmailOtpChallenge(db: AppDb, env: IdentityAuthEnv, input: RequestInput): Promise<PreparedChallenge> {
  return prepareIssue(db, env, input, 'otp');
}
export async function prepareIdentityMergeStepUpChallenge(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number;
  email: string;
  targetPersonId: number;
  requestContext: IdentityTrustedRequestContext;
  binding: IdentityMergeStepUpBinding;
  source?: IdentityChallengeSource;
  now?: string;
}): Promise<PreparedChallenge> {
  const binding = input.binding;
  const operationId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
  const hash = /^[0-9a-f]{64}$/u;
  if (!binding || !Object.isFrozen(binding) || !operationId.test(binding.operation_id)
    || !hash.test(binding.preview_hash) || !hash.test(binding.risk_state_hash) || !hash.test(binding.resolution_case_hash)
    || !Number.isSafeInteger(binding.operation_version) || binding.operation_version < 1
    || binding.risk_state_version !== 1 || !Number.isSafeInteger(binding.resolution_case_version) || binding.resolution_case_version < 1
    || binding.approver_person_id !== input.targetPersonId || !Number.isSafeInteger(binding.approver_identity_version)
    || binding.approver_identity_version < 1 || binding.campus_id !== input.campusId) {
    throw new Error('identity_merge_step_up_binding_invalid');
  }
  return prepareIssue(db, env, {
    campusId: input.campusId, email: input.email, purpose: 'step_up', targetPersonId: input.targetPersonId,
    requestContext: input.requestContext, source: input.source ?? 'admin', now: input.now,
  }, 'otp', Object.freeze({ person_merge_approval: binding }));
}
export async function prepareIdentityMergeRollbackStepUpChallenge(db: AppDb, env: IdentityAuthEnv, input: {
  campusId: number;
  email: string;
  targetPersonId: number;
  requestContext: IdentityTrustedRequestContext;
  binding: IdentityMergeRollbackStepUpBinding;
  source?: IdentityChallengeSource;
  now?: string;
}): Promise<PreparedChallenge> {
  const binding = input.binding;
  const operationId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
  const hash = /^[0-9a-f]{64}$/u;
  if (!binding || !Object.isFrozen(binding) || !operationId.test(binding.rollback_id)
    || !operationId.test(binding.operation_id) || !hash.test(binding.journal_hash)
    || !Number.isSafeInteger(binding.rollback_version) || binding.rollback_version < 1
    || !Number.isSafeInteger(binding.expected_operation_version) || binding.expected_operation_version < 1
    || !Number.isSafeInteger(binding.journal_count) || binding.journal_count < 0
    || binding.approver_person_id !== input.targetPersonId || !Number.isSafeInteger(binding.approver_identity_version)
    || binding.approver_identity_version < 1 || binding.campus_id !== input.campusId) {
    throw new Error('identity_merge_rollback_step_up_binding_invalid');
  }
  return prepareIssue(db, env, {
    campusId: input.campusId, email: input.email, purpose: 'step_up', targetPersonId: input.targetPersonId,
    requestContext: input.requestContext, source: input.source ?? 'admin', now: input.now,
  }, 'otp', Object.freeze({ person_merge_rollback_approval: binding }));
}
export async function issueEmailLinkChallenge(db: AppDb, env: IdentityAuthEnv, input: RequestInput): Promise<{ limited: boolean; publicId: string; token: string; expiresAt: string }> {
  const result = await issue(db, env, input, 'link');
  return { limited: result.limited, publicId: result.publicId, token: result.token ?? '', expiresAt: result.expiresAt };
}

type ConsumeInput = { campusId: number; publicId: string; purpose: IdentityChallengePurpose; source?: IdentityChallengeSource; code: string; now?: string };
export type ConsumedOtp = { ok: false } | { ok: true; contact: ContactPoint; owner: VerifiedOwner | null; sessionEpoch: number | null };
type Challenge = { id: number; campus_id: number; purpose: IdentityChallengePurpose; request_source: IdentityChallengeSource; person_id: number | null; expected_session_epoch: number | null; code_hash: string | null; token_hash: string | null; contact_point_id: number | null; requester_bucket_hash: string; attempts: number; max_attempts: number; expires_at: string; consumed_at: string | null; superseded_at: string | null; context_json: string };

async function contactById(db: AppDb, contactPointId: number): Promise<ContactPoint | null> {
  const row = await db.prepare('SELECT id,kind,normalized_value,display_value FROM contact_points WHERE id=?1').bind(contactPointId)
    .first<{ id: number; kind: IdentityContactKind; normalized_value: string; display_value: string }>();
  return row ? { id: row.id, kind: row.kind, normalizedValue: row.normalized_value, displayValue: row.display_value } : null;
}
export async function consumeEmailOtpChallenge(db: AppDb, env: IdentityAuthEnv, input: ConsumeInput): Promise<ConsumedOtp> {
  const secret = assertSecret(env); const part = clock(input.now);
  // Always calculate the candidate HMAC first, including malformed public IDs and substituted purposes.
  const source = input.source ?? 'web';
  await hmacIdentityValue(secret, `otp:${input.purpose}:${source}`, ['invalid', '0', typeof input.code === 'string' ? input.code : ''].join('\0'));
  if (!isPublicId(input.publicId) || !PURPOSES.has(input.purpose) || !SOURCES.has(source) || !/^\d{6}$/.test(input.code) || !Number.isSafeInteger(input.campusId)) return { ok: false };
  const challenge = await db.prepare(`SELECT id,campus_id,purpose,request_source,person_id,expected_session_epoch,code_hash,token_hash,contact_point_id,requester_bucket_hash,attempts,max_attempts,expires_at,consumed_at,superseded_at,context_json
    FROM identity_challenges WHERE campus_id=?1 AND public_id=?2`).bind(input.campusId, input.publicId).first<Challenge>();
  const candidate = await hmacIdentityValue(secret, `otp:${input.purpose}:${source}`, `${input.publicId}\0${challenge?.person_id ?? 0}\0${typeof input.code === 'string' ? input.code : ''}`);
  const expectedBinding = challenge?.contact_point_id == null ? '' : await challengeBinding(secret, { publicId: input.publicId, campusId: input.campusId, purpose: input.purpose, source, contactPointId: challenge.contact_point_id, personId: challenge.person_id, sessionEpoch: challenge.expected_session_epoch });
  const activeCandidate = challenge && challenge.purpose === input.purpose && challenge.request_source === source
    && challenge.token_hash === null && sameHash(bindingFromJson(challenge.context_json), expectedBinding)
    && !((challenge.purpose === 'contact_change' || challenge.purpose === 'step_up') && challenge.person_id === null)
    && challenge.expires_at > part.now && challenge.consumed_at === null && challenge.superseded_at === null && challenge.attempts < challenge.max_attempts;
  if (!activeCandidate || !sameHash(challenge.code_hash, candidate)) {
    if (activeCandidate) {
      try { await db.batch([
        db.prepare(`INSERT INTO identity_otp_failure_claims(claim_id,campus_id,bucket_hash,window_started_at,challenge_id)
          VALUES(?1,?2,?3,?4,?5)`).bind(crypto.randomUUID(), challenge.campus_id, challenge.requester_bucket_hash, part.window, challenge.id),
        db.prepare(`UPDATE identity_challenges SET attempts=attempts+1 WHERE id=?1 AND attempts<max_attempts AND consumed_at IS NULL AND superseded_at IS NULL`).bind(challenge.id),
        rateStatement(db, challenge.campus_id, 'otp_failure', challenge.requester_bucket_hash, part),
      ]); } catch { /* The shared failure budget is exhausted; do not grant another guess. */ }
    }
    return { ok: false };
  }
  let write: AppDbResult<unknown>;
  try {
    write = await db.prepare(`UPDATE identity_challenges SET consumed_at=?1 WHERE id=?2 AND purpose=?3 AND code_hash=?4
      AND attempts<max_attempts AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>?1
      AND (person_id IS NULL OR EXISTS (SELECT 1 FROM people p WHERE p.id=identity_challenges.person_id
        AND p.session_epoch=identity_challenges.expected_session_epoch AND p.active=1 AND p.deleted_at IS NULL
        AND p.identity_state='active' AND p.auth_disabled_at IS NULL))`).bind(part.now, challenge.id, input.purpose, candidate).run();
  } catch { return { ok: false }; }
  if (write.meta.changes !== 1 || challenge.contact_point_id === null) return { ok: false };
  const contact = await contactById(db, challenge.contact_point_id); if (!contact) return { ok: false };
  return { ok: true, contact, owner: await findVerifiedContactOwner(db, { kind: contact.kind, value: contact.normalizedValue }), sessionEpoch: challenge.expected_session_epoch };
}

/**
 * Revalidates the secret for an already-consumed OTP. This is deliberately
 * separate from normal authentication replay: account workflows use it only
 * to resume a pending, database-bound operation after a post-consumption fault.
 */
export async function verifyConsumedEmailOtpChallenge(db: AppDb, env: IdentityAuthEnv, input: ConsumeInput): Promise<ConsumedOtp> {
  const secret = assertSecret(env); const part = clock(input.now); const source = input.source ?? 'web';
  await hmacIdentityValue(secret, `otp:${input.purpose}:${source}`, ['invalid', '0', typeof input.code === 'string' ? input.code : ''].join('\0'));
  if (!isPublicId(input.publicId) || !PURPOSES.has(input.purpose) || !SOURCES.has(source)
    || !/^\d{6}$/.test(input.code) || !Number.isSafeInteger(input.campusId)) return { ok: false };
  const challenge = await db.prepare(`SELECT id,campus_id,purpose,request_source,person_id,expected_session_epoch,code_hash,token_hash,contact_point_id,requester_bucket_hash,attempts,max_attempts,expires_at,consumed_at,superseded_at,context_json
    FROM identity_challenges WHERE campus_id=?1 AND public_id=?2`).bind(input.campusId, input.publicId).first<Challenge>();
  const candidate = await hmacIdentityValue(secret, `otp:${input.purpose}:${source}`, `${input.publicId}\0${challenge?.person_id ?? 0}\0${input.code}`);
  const expectedBinding = challenge?.contact_point_id == null ? '' : await challengeBinding(secret, {
    publicId: input.publicId, campusId: input.campusId, purpose: input.purpose, source,
    contactPointId: challenge.contact_point_id, personId: challenge.person_id, sessionEpoch: challenge.expected_session_epoch,
  });
  const replayCandidate = challenge && challenge.purpose === input.purpose && challenge.request_source === source
    && challenge.token_hash === null && sameHash(bindingFromJson(challenge.context_json), expectedBinding)
    && challenge.consumed_at !== null && challenge.superseded_at === null && challenge.expires_at > part.now
    && challenge.contact_point_id !== null;
  if (!replayCandidate) return { ok: false };
  if (!sameHash(challenge.code_hash, candidate)) {
    if (challenge.attempts < challenge.max_attempts) {
      try {
        await db.batch([
          db.prepare(`INSERT INTO identity_otp_failure_claims(claim_id,campus_id,bucket_hash,window_started_at,challenge_id)
            VALUES(?1,?2,?3,?4,?5)`).bind(crypto.randomUUID(), challenge.campus_id, challenge.requester_bucket_hash, part.window, challenge.id),
          db.prepare(`UPDATE identity_challenges SET attempts=attempts+1 WHERE id=?1 AND attempts<max_attempts
            AND consumed_at IS NOT NULL AND superseded_at IS NULL AND expires_at>?2`).bind(challenge.id, part.now),
          rateStatement(db, challenge.campus_id, 'otp_failure', challenge.requester_bucket_hash, part),
        ]);
      } catch { /* The challenge or shared contact budget is exhausted; fail closed. */ }
    }
    return { ok: false };
  }
  // Turn replay acceptance into a serialized database decision. A no-op write
  // locks the exact challenge on PostgreSQL and joins D1's serialized write
  // path; the shared contact budget is checked in that same statement.
  const accepted = await db.prepare(`UPDATE identity_challenges SET attempts=attempts WHERE id=?1
    AND consumed_at IS NOT NULL AND superseded_at IS NULL AND expires_at>?2 AND attempts<max_attempts
    AND (SELECT count(*) FROM identity_otp_failure_claims f
      WHERE f.campus_id=identity_challenges.campus_id AND f.bucket_hash=identity_challenges.requester_bucket_hash
        AND f.window_started_at<=?2 AND datetime(f.window_started_at,'+15 minutes')>?2)<5`).bind(challenge.id, part.now).run();
  if (accepted.meta.changes !== 1) return { ok: false };
  const contact = await contactById(db, challenge.contact_point_id); if (!contact) return { ok: false };
  return { ok: true, contact, owner: await findVerifiedContactOwner(db, { kind: contact.kind, value: contact.normalizedValue }), sessionEpoch: challenge.expected_session_epoch };
}

type LinkInput = { campusId: number; publicId: string; purpose: IdentityChallengePurpose; source?: IdentityChallengeSource; token: string; now?: string };
async function linkChallenge(db: AppDb, env: IdentityAuthEnv, input: LinkInput, consume: boolean): Promise<ConsumedOtp> {
  const secret = assertSecret(env); const part = clock(input.now);
  const source = input.source ?? 'web';
  if (typeof input.token !== 'string' || encoder.encode(input.token).byteLength > 256) return { ok: false };
  await hmacIdentityValue(secret, `link:${input.purpose}:${source}`, ['invalid', '0', typeof input.token === 'string' ? input.token : ''].join('\0'));
  if (!isPublicId(input.publicId) || !PURPOSES.has(input.purpose) || !SOURCES.has(source) || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) return { ok: false };
  const challenge = await db.prepare(`SELECT id,campus_id,purpose,request_source,person_id,expected_session_epoch,code_hash,token_hash,contact_point_id,requester_bucket_hash,attempts,max_attempts,expires_at,consumed_at,superseded_at,context_json
    FROM identity_challenges WHERE campus_id=?1 AND public_id=?2`).bind(input.campusId, input.publicId).first<Challenge>();
  const candidate = await hmacIdentityValue(secret, `link:${input.purpose}:${source}`, `${input.publicId}\0${challenge?.person_id ?? 0}\0${typeof input.token === 'string' ? input.token : ''}`);
  const expectedBinding = challenge?.contact_point_id == null ? '' : await challengeBinding(secret, { publicId: input.publicId, campusId: input.campusId, purpose: input.purpose, source, contactPointId: challenge.contact_point_id, personId: challenge.person_id, sessionEpoch: challenge.expected_session_epoch });
  if (!challenge || challenge.purpose !== input.purpose || challenge.request_source !== source || !sameHash(challenge.token_hash, candidate) || challenge.code_hash !== null
    || !sameHash(bindingFromJson(challenge.context_json), expectedBinding)
    || ((challenge.purpose === 'contact_change' || challenge.purpose === 'step_up') && challenge.person_id === null)
    || challenge.expires_at <= part.now || challenge.superseded_at !== null || (consume && challenge.consumed_at !== null) || challenge.contact_point_id === null) return { ok: false };
  const contact = await contactById(db, challenge.contact_point_id); if (!contact) return { ok: false };
  const owner = await findVerifiedContactOwner(db, { kind: contact.kind, value: contact.normalizedValue });
  if (challenge.purpose === 'login') {
    const sameCampusOwner = challenge.person_id === null ? null : await db.prepare(`SELECT 1 ok FROM verified_contact_owners o
      JOIN person_contact_links l ON l.person_id=o.person_id AND l.contact_point_id=o.contact_point_id AND l.ended_at IS NULL
      JOIN people p ON p.id=o.person_id JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=?3 AND cm.active=1
      LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
      WHERE o.contact_point_id=?1 AND o.person_id=?2 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active'
        AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL`).bind(challenge.contact_point_id, challenge.person_id, input.campusId).first<number>('ok');
    if (sameCampusOwner !== 1 || owner?.personId !== challenge.person_id) return { ok: false };
  }
  if (consume) {
    const loginGuard = challenge.purpose === 'login' ? `AND person_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM verified_contact_owners o JOIN person_contact_links l ON l.person_id=o.person_id AND l.contact_point_id=o.contact_point_id AND l.ended_at IS NULL
      JOIN people p ON p.id=o.person_id JOIN campus_memberships cm ON cm.person_id=p.id AND cm.campus_id=?4 AND cm.active=1
      LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id WHERE o.contact_point_id=identity_challenges.contact_point_id
        AND o.person_id=identity_challenges.person_id AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active'
        AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL)` : '';
    const statement = db.prepare(`UPDATE identity_challenges SET consumed_at=?1 WHERE id=?2 AND token_hash=?3
      AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at>?1
      AND (person_id IS NULL OR EXISTS (SELECT 1 FROM people p WHERE p.id=identity_challenges.person_id
        AND p.session_epoch=identity_challenges.expected_session_epoch AND p.active=1 AND p.deleted_at IS NULL
        AND p.identity_state='active' AND p.auth_disabled_at IS NULL)) ${loginGuard}`);
    const write = await (challenge.purpose === 'login'
      ? statement.bind(part.now, challenge.id, candidate, input.campusId)
      : statement.bind(part.now, challenge.id, candidate)).run();
    if (write.meta.changes !== 1) return { ok: false };
  }
  const currentOwner = await findVerifiedContactOwner(db, { kind: contact.kind, value: contact.normalizedValue });
  if (challenge.purpose === 'login' && currentOwner?.personId !== challenge.person_id) return { ok: false };
  return { ok: true, contact, owner: currentOwner, sessionEpoch: challenge.expected_session_epoch };
}
export function peekEmailLinkChallenge(db: AppDb, env: IdentityAuthEnv, input: LinkInput): Promise<ConsumedOtp> { return linkChallenge(db, env, input, false); }
export function consumeEmailLinkChallenge(db: AppDb, env: IdentityAuthEnv, input: LinkInput): Promise<ConsumedOtp> { return linkChallenge(db, env, input, true); }

/** Extracts only Cloudflare's direct connection header; forwarded headers are never trusted. */
export function identityTrustedRequestContext(headers: Pick<Headers, 'get'>, deviceId?: string | null): IdentityTrustedRequestContext {
  const ip = headers.get('CF-Connecting-IP');
  const context = { cfConnectingIp: ip && trustedIp(ip) !== 'unknown' ? ip.trim().toLowerCase() : null, deviceId: deviceId ?? null } as IdentityTrustedRequestContext;
  Object.defineProperty(context, trustedRequestContextBrand, { value: true });
  return Object.freeze(context);
}
