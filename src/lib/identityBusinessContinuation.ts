import type { AppDb } from './appDb';
import { getFund } from './fundDb';
import {
  attachIdentitySourceForSignedInSession,
  identityGatewaySessionContext,
  getIdentitySourceRecord,
  registerIdentitySource,
  type IdentityGatewaySessionContext,
  type IdentitySourceKeyEnv,
} from './identityGateway';
import { completeVerifiedSignup, prepareSignup } from './identityAccount';
import { consumeIdentityOtpDeliveryRetryLimit, type IdentityAuthEnv, type IdentityTrustedRequestContext } from './identityAuth';
import { getStripeCustomer } from './givingDb';
import { createOneTimeCheckout, createRegistrationCheckoutFromParams, type StripeEnv } from './stripe';
import {
  attachRegistrationCheckoutRequest,
  cancelRegistrationCheckoutRequest,
  continueRegistrationCheckoutRequest,
  resolveRegistrationCheckoutRequest,
  type CheckoutRequestResolution,
} from './stripeCheckoutRequests';
import { classifyRegistrationCheckoutFailure } from './registrationCheckoutFailure';
import { listQuestions, validateAnswers, type RegEvent, type RegQuestion } from './regDb';
import { sha256Utf8 } from './stripeWebhookInbox';
import { newCheckoutRequestId, parseCheckoutRequestId } from './stripeCheckoutRequests';

export type IdentityBusinessContinuationEnv = IdentityAuthEnv & IdentitySourceKeyEnv & StripeEnv;
export type ContinuationLocale = 'en' | 'zh';

export type RawGivingContinuationInput = {
  fundId: number;
  fundName: string;
  amountCents: number;
  currency: string;
  frequency: 'once' | 'week' | 'month';
  locale: ContinuationLocale;
  name: string;
  email: string;
};

export type NormalizedGivingContinuationInput = Readonly<{
  fundId: number;
  fundName: string;
  amountCents: number;
  currency: string;
  frequency: 'once';
  locale: ContinuationLocale;
  donorName: string;
  donorEmail: string;
}>;

export type NormalizedRegistrationContinuationInput = Readonly<{
  eventId: number;
  name: string;
  email: string;
  amountCents: number;
  currency: string;
  locale: ContinuationLocale;
  answers: ReadonlyArray<readonly [number, string]>;
}>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_GIVING_CENTS = 9_999_999;
const MAX_NAME_BYTES = 512;
const DEFAULT_EXPIRY_SWEEP_LIMIT = 100;
const MAX_EXPIRY_SWEEP_LIMIT = 200;
const encoder = new TextEncoder();

function validId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function text(value: unknown, code: string, maxBytes = MAX_NAME_BYTES): string {
  if (typeof value !== 'string') throw new Error(code);
  const result = value.normalize('NFC').trim();
  if (!result || encoder.encode(result).byteLength > maxBytes || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(result)) throw new Error(code);
  return result;
}
function nowUtc(value?: string): string {
  const date = value === undefined ? new Date() : new Date(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(date.getTime())) throw new Error('identity_clock_invalid');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
function expiresAt(value?: string): string {
  const date = new Date(`${nowUtc(value).replace(' ', 'T')}Z`);
  date.setUTCMinutes(date.getUTCMinutes() + 30);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
function leaseAt(value?: string): string {
  const date = new Date(`${nowUtc(value).replace(' ', 'T')}Z`);
  date.setUTCMinutes(date.getUTCMinutes() + 5);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
function deliveryRetryAt(value?: string): string {
  const date = new Date(`${nowUtc(value).replace(' ', 'T')}Z`);
  date.setUTCMinutes(date.getUTCMinutes() + 1);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
function validIntentId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function databaseId(): number { return 1_100_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000); }

export async function normalizeGivingContinuationInput(input: RawGivingContinuationInput): Promise<NormalizedGivingContinuationInput> {
  if (!validId(input.fundId) || !Number.isSafeInteger(input.amountCents) || input.amountCents < 100 || input.amountCents > MAX_GIVING_CENTS) {
    throw new Error('identity_continuation_amount_invalid');
  }
  if (input.frequency !== 'once') throw new Error('identity_continuation_frequency_invalid');
  const currency = text(input.currency, 'identity_continuation_currency_invalid', 16).toLowerCase();
  if (!/^[a-z]{3}$/u.test(currency)) throw new Error('identity_continuation_currency_invalid');
  if (input.locale !== 'en' && input.locale !== 'zh') throw new Error('identity_continuation_locale_invalid');
  const donorName = text(input.name, 'identity_continuation_name_invalid');
  const donorEmail = text(input.email, 'identity_continuation_email_invalid', 320).toLowerCase();
  if (!EMAIL.test(donorEmail)) throw new Error('identity_continuation_email_invalid');
  const fundName = text(input.fundName, 'identity_continuation_fund_invalid');
  return Object.freeze({ fundId: input.fundId, fundName, amountCents: input.amountCents, currency,
    frequency: 'once', locale: input.locale, donorName, donorEmail });
}

export async function normalizeRegistrationContinuationInput(input: {
  eventId: number; name: string; email: string; amountCents: number; currency: string;
  locale: ContinuationLocale; answers: Array<[number, string]>;
}): Promise<NormalizedRegistrationContinuationInput> {
  if (!validId(input.eventId) || !Number.isSafeInteger(input.amountCents) || input.amountCents < 0) {
    throw new Error('identity_continuation_registration_invalid');
  }
  const name = text(input.name, 'identity_continuation_name_invalid');
  const email = text(input.email, 'identity_continuation_email_invalid', 320).toLowerCase();
  if (!EMAIL.test(email)) throw new Error('identity_continuation_email_invalid');
  const currency = text(input.currency, 'identity_continuation_currency_invalid', 16).toLowerCase();
  if (!/^[a-z]{3}$/u.test(currency) || (input.locale !== 'en' && input.locale !== 'zh')) throw new Error('identity_continuation_registration_invalid');
  if (!Array.isArray(input.answers) || input.answers.length > 200) throw new Error('identity_continuation_answers_invalid');
  const answers = input.answers.map(([questionId, answer]) => {
    if (!validId(questionId)) throw new Error('identity_continuation_answers_invalid');
    return [questionId, text(answer, 'identity_continuation_answers_invalid', 2000)] as const;
  }).sort(([left], [right]) => left - right);
  if (answers.some((answer, index) => index > 0 && answers[index - 1][0] === answer[0])) throw new Error('identity_continuation_answers_invalid');
  return Object.freeze({ eventId: input.eventId, name, email, amountCents: input.amountCents, currency,
    locale: input.locale, answers: Object.freeze(answers) });
}

export async function continuationPayloadDigest(value: unknown): Promise<string> {
  return sha256Utf8(JSON.stringify(value));
}

function canonicalRegistrationAnswers(answers: ReadonlyArray<readonly [number, string]>): Array<[number, string]> {
  return answers.map(([questionId, answer]) => [questionId, answer] as [number, string])
    .sort(([left], [right]) => left - right);
}

function revalidateRegistrationAnswers(questions: RegQuestion[], persisted: ReadonlyArray<readonly [number, string]>): Array<[number, string]> {
  const questionsById = new Map(questions.map((question) => [question.id, question] as const));
  const form: Record<string, string | string[]> = {};
  for (const [questionId, answer] of persisted) {
    const question = questionsById.get(questionId);
    if (!question) throw new Error('identity_continuation_answers_invalid');
    if (question.type !== 'checkbox') {
      form[String(questionId)] = answer;
      continue;
    }
    const values = JSON.parse(answer) as unknown;
    if (!Array.isArray(values) || values.length === 0
      || values.some((value) => typeof value !== 'string')) throw new Error('identity_continuation_answers_invalid');
    form[String(questionId)] = values as string[];
  }
  return canonicalRegistrationAnswers(validateAnswers(questions, form));
}

async function registrationQuestionDigest(questions: RegQuestion[]): Promise<string> {
  const definitions = questions.map((question) => ({
    id: question.id,
    type: question.type,
    required: question.required === 1 ? 1 : 0,
    options: question.options === null ? null : [...question.options].sort(),
  })).sort((left, right) => left.id - right.id);
  return sha256Utf8(JSON.stringify(definitions));
}

type IntentRow = {
  intent_id: string; campus_id: number; kind: 'giving_checkout' | 'registration'; source_record_id: number; source_version: number; source_digest: string;
  payload_digest: string; signup_operation_id: string | null; signup_issuance_token: string | null;
  signup_issuance_expires_at: string | null; result_person_id: number | null;
  state: 'pending_verification' | 'ready' | 'consumed' | 'review' | 'expired';
  business_record_key: string | null; expires_at: string;
  normalized_email: string | null; normalized_name: string | null;
  signup_delivery_ciphertext: string | null;
};

type SignupDelivery = Readonly<{ to: string; publicId: string; code: string; expiresAt: string }>;

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
function base64urlToBytes(value: string): Uint8Array | null {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
  } catch { return null; }
}
async function deliveryKey(env: IdentityBusinessContinuationEnv): Promise<CryptoKey> {
  const secret = env.IDENTITY_VERIFICATION_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 1024) throw new Error('identity_verification_unavailable');
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`identity-business-delivery:v1\0${secret}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function sealSignupDelivery(env: IdentityBusinessContinuationEnv, campusId: number, intentId: string, operationId: string,
  delivery: SignupDelivery): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(`identity-business-delivery:v2\0${campusId}\0${intentId}\0${operationId}`);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad },
    await deliveryKey(env), encoder.encode(JSON.stringify(delivery))));
  const packed = new Uint8Array(iv.length + ciphertext.length); packed.set(iv); packed.set(ciphertext, iv.length);
  return `v2.${bytesToBase64url(packed)}`;
}
async function openSignupDelivery(env: IdentityBusinessContinuationEnv, campusId: number, intentId: string, operationId: string,
  value: string | null): Promise<SignupDelivery | null> {
  if (!value?.startsWith('v2.')) return null;
  const packed = base64urlToBytes(value.slice(3)); if (!packed || packed.length < 29) return null;
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12),
      additionalData: encoder.encode(`identity-business-delivery:v2\0${campusId}\0${intentId}\0${operationId}`) },
    await deliveryKey(env), packed.slice(12));
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as SignupDelivery;
    if (!EMAIL.test(parsed.to) || !UUID.test(parsed.publicId) || !/^\d{6}$/u.test(parsed.code)
      || typeof parsed.expiresAt !== 'string') return null;
    return Object.freeze(parsed);
  } catch { return null; }
}

/** Returns only the opaque challenge identifier needed to resume the same
 * operation. Retry delivery material is separately stored as an authenticated
 * ciphertext bound to the exact campus and intent. */
export async function signupOperationPublicId(db: AppDb, campusId: number, operationId: string): Promise<string | null> {
  if (!validId(campusId) || !validIntentId(operationId)) return null;
  const row = await db.prepare(`SELECT c.public_id FROM identity_account_operations o
    JOIN identity_challenges c ON c.id=o.challenge_id
    WHERE o.operation_id=?1 AND o.campus_id=?2 AND o.kind='signup' AND o.state='pending'`).bind(operationId, campusId).first<{ public_id: string }>();
  return row?.public_id ?? null;
}

async function loadIntent(db: AppDb, campusId: number, intentId: string, kind: 'giving_checkout' | 'registration'): Promise<IntentRow | null> {
  return db.prepare(`SELECT i.*,o.normalized_email,o.normalized_name
    FROM identity_business_intents i JOIN identity_source_records s ON s.id=i.source_record_id
    JOIN identity_observations o ON o.id=s.observation_id
    WHERE i.intent_id=?1 AND i.campus_id=?2 AND i.kind=?3`)
    .bind(intentId, campusId, kind).first<IntentRow>();
}

async function bindSignupOperation(db: AppDb, env: IdentityBusinessContinuationEnv, input: {
  campusId: number; intentId: string; email: string; name: string; requestContext: IdentityTrustedRequestContext; now?: string;
}): Promise<{ status: 'verification_required'; operationId: string; delivery: { to: string; publicId: string; code: string; expiresAt: string } } | { status: 'pending'; operationId: string }> {
  let intent = await db.prepare(`SELECT signup_operation_id,signup_issuance_token,signup_issuance_expires_at,signup_delivery_ciphertext,
      signup_delivery_count,signup_delivery_not_before
    FROM identity_business_intents WHERE intent_id=?1 AND campus_id=?2 AND state='pending_verification'`)
    .bind(input.intentId, input.campusId).first<{ signup_operation_id: string | null; signup_issuance_token: string | null; signup_issuance_expires_at: string | null; signup_delivery_ciphertext: string | null; signup_delivery_count: number; signup_delivery_not_before: string | null }>();
  if (!intent) throw new Error('identity_continuation_not_found');
  if (intent.signup_operation_id) {
    const delivery = await openSignupDelivery(env, input.campusId, input.intentId, intent.signup_operation_id, intent.signup_delivery_ciphertext);
    const publicId = await signupOperationPublicId(db, input.campusId, intent.signup_operation_id);
    const now = nowUtc(input.now);
    if (delivery && delivery.to === input.email && delivery.publicId === publicId && delivery.expiresAt > now) {
      const claimed = await db.prepare(`UPDATE identity_business_intents SET signup_delivery_count=signup_delivery_count+1,
        signup_delivery_not_before=?1,updated_at=?2 WHERE intent_id=?3 AND campus_id=?4 AND state='pending_verification'
          AND signup_operation_id=?5 AND signup_delivery_ciphertext=?6 AND signup_delivery_count BETWEEN 1 AND 2
          AND signup_delivery_not_before IS NOT NULL AND signup_delivery_not_before<=?2`)
        .bind(deliveryRetryAt(input.now), now, input.intentId, input.campusId, intent.signup_operation_id, intent.signup_delivery_ciphertext).run();
      if (claimed.meta.changes === 1 && await consumeIdentityOtpDeliveryRetryLimit(db, env, {
        campusId: input.campusId, email: input.email, requestContext: input.requestContext, now: input.now,
      })) return { status: 'verification_required', operationId: intent.signup_operation_id, delivery };
    }
    return { status: 'pending', operationId: intent.signup_operation_id };
  }
  const now = nowUtc(input.now);
  const token = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE identity_business_intents SET signup_issuance_token=?1,signup_issuance_expires_at=?2,updated_at=?3
    WHERE intent_id=?4 AND campus_id=?5 AND state='pending_verification' AND signup_operation_id IS NULL
      AND (signup_issuance_token IS NULL OR signup_issuance_expires_at<=?3)`)
    .bind(token, leaseAt(input.now), now, input.intentId, input.campusId).run();
  if (claimed.meta.changes !== 1) {
    intent = await db.prepare(`SELECT signup_operation_id,signup_issuance_token,signup_issuance_expires_at,signup_delivery_ciphertext,
      signup_delivery_count,signup_delivery_not_before FROM identity_business_intents WHERE intent_id=?1 AND campus_id=?2`)
      .bind(input.intentId, input.campusId).first<{
        signup_operation_id: string | null;
        signup_issuance_token: string | null;
        signup_issuance_expires_at: string | null;
        signup_delivery_ciphertext: string | null;
        signup_delivery_count: number;
        signup_delivery_not_before: string | null;
      }>();
    if (intent?.signup_operation_id) {
      const delivery = await openSignupDelivery(env, input.campusId, input.intentId, intent.signup_operation_id, intent.signup_delivery_ciphertext);
      const publicId = await signupOperationPublicId(db, input.campusId, intent.signup_operation_id);
      // A concurrent binder owns initial delivery. A later request can claim a
      // resend through the normal top-level path after the one-minute cooldown.
      void delivery; void publicId;
      return { status: 'pending', operationId: intent.signup_operation_id };
    }
    throw new Error('identity_continuation_pending');
  }
  try {
    const begun = await prepareSignup(db, env, { campusId: input.campusId, email: input.email, displayName: input.name,
      requestContext: input.requestContext, source: 'web', now: input.now, reservedOperationId: input.intentId });
    const deliveryCiphertext = await sealSignupDelivery(env, input.campusId, input.intentId, input.intentId, begun.delivery);
    const retryAt = deliveryRetryAt(input.now);
    await db.batch([
      ...begun.statements,
      db.prepare(`UPDATE identity_business_intents SET signup_operation_id=?1,signup_issuance_token=NULL,
        signup_issuance_expires_at=NULL,signup_delivery_ciphertext=?2,signup_delivery_count=1,
        signup_delivery_not_before=?3,updated_at=?4
        WHERE intent_id=?5 AND campus_id=?6 AND state='pending_verification'
          AND signup_operation_id IS NULL AND signup_issuance_token=?7`)
        .bind(input.intentId, deliveryCiphertext, retryAt, now, input.intentId, input.campusId, token),
      // A zero-row parent CAS must abort this same transaction. Both SQLite and
      // PostgreSQL turn an empty scalar subquery into NULL, violating this
      // assertion table's NOT NULL primary key and rolling every prepared
      // challenge/operation statement back.
      db.prepare(`INSERT INTO identity_business_signup_binding_assertions(intent_id)
        VALUES((SELECT intent_id FROM identity_business_intents
          WHERE intent_id=?1 AND campus_id=?2 AND state='pending_verification'
            AND signup_operation_id=?1 AND signup_issuance_token IS NULL AND signup_issuance_expires_at IS NULL
            AND signup_delivery_ciphertext=?3 AND signup_delivery_count=1
            AND signup_delivery_not_before=?4 AND updated_at=?5))`)
        .bind(input.intentId, input.campusId, deliveryCiphertext, retryAt, now),
      db.prepare('DELETE FROM identity_business_signup_binding_assertions WHERE intent_id=?1').bind(input.intentId),
    ]);
    return { status: 'verification_required', operationId: input.intentId, delivery: begun.delivery };
  } catch (error) {
    await db.prepare(`UPDATE identity_business_intents SET signup_issuance_token=NULL,signup_issuance_expires_at=NULL,updated_at=?1
      WHERE intent_id=?2 AND signup_issuance_token=?3`).bind(now, input.intentId, token).run();
    throw error;
  }
}

async function createBaseIntent(db: AppDb, input: {
  campusId: number; intentId: string; kind: 'giving_checkout' | 'registration'; sourceRecordId: number; sourceVersion: number;
  sourceDigest: string; payloadDigest: string; expiresAt: string;
}): Promise<void> {
  try {
    await db.prepare(`INSERT INTO identity_business_intents(intent_id,campus_id,kind,source_record_id,source_version,
      source_digest,payload_digest,signup_reservation_id,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?1,?8)`)
      .bind(input.intentId, input.campusId, input.kind, input.sourceRecordId, input.sourceVersion, input.sourceDigest, input.payloadDigest, input.expiresAt).run();
  } catch {
    const existing = await db.prepare('SELECT kind,payload_digest,source_record_id,source_version,source_digest,expires_at FROM identity_business_intents WHERE intent_id=?1 AND campus_id=?2')
      .bind(input.intentId, input.campusId).first<{ kind: 'giving_checkout' | 'registration'; payload_digest: string; source_record_id: number; source_version: number; source_digest: string; expires_at: string }>();
    if (!existing || existing.kind !== input.kind || existing.payload_digest !== input.payloadDigest
      || existing.source_record_id !== input.sourceRecordId || existing.source_version !== input.sourceVersion
      || existing.source_digest !== input.sourceDigest) throw new Error('identity_continuation_payload_drift');
  }
}

export async function beginGivingContinuation(db: AppDb, env: IdentityBusinessContinuationEnv, input: RawGivingContinuationInput & {
  campusId: number; intentId: string; requestContext: IdentityTrustedRequestContext; now?: string;
}): Promise<{ status: 'verification_required'; intentId: string; operationId: string; delivery: { to: string; publicId: string; code: string; expiresAt: string } } | { status: 'pending'; intentId: string; operationId: string }> {
  if (!validId(input.campusId) || !validIntentId(input.intentId)) throw new Error('identity_continuation_invalid');
  const normalized = await normalizeGivingContinuationInput(input);
  const payloadDigest = await continuationPayloadDigest(normalized);
  const source = await registerIdentitySource(db, env, { campusId: input.campusId, source: 'giving', sourceRecordKey: input.intentId,
    email: normalized.donorEmail, name: normalized.donorName, attachmentPolicy: 'signed_in_or_claim', sourceDigest: payloadDigest });
  await createBaseIntent(db, { campusId: input.campusId, intentId: input.intentId, kind: 'giving_checkout', sourceRecordId: source.sourceRecordId,
    sourceVersion: source.version, sourceDigest: source.sourceDigest, payloadDigest, expiresAt: expiresAt(input.now) });
  try {
    await db.prepare(`INSERT INTO identity_giving_checkout_continuations(intent_id,fund_id,amount_cents,currency,locale,checkout_request_id)
      VALUES(?1,?2,?3,?4,?5,?6)`).bind(input.intentId, normalized.fundId, normalized.amountCents, normalized.currency, normalized.locale, newCheckoutRequestId()).run();
  } catch {
    const existing = await db.prepare('SELECT intent_id FROM identity_giving_checkout_continuations WHERE intent_id=?1').bind(input.intentId).first<{ intent_id: string }>();
    if (!existing) throw new Error('identity_continuation_conflict');
  }
  const signup = await bindSignupOperation(db, env, { campusId: input.campusId, intentId: input.intentId, email: normalized.donorEmail,
    name: normalized.donorName, requestContext: input.requestContext, now: input.now });
  return signup.status === 'verification_required'
    ? { status: signup.status, intentId: input.intentId, operationId: signup.operationId, delivery: signup.delivery }
    : { status: signup.status, intentId: input.intentId, operationId: signup.operationId };
}

export async function beginRegistrationContinuation(db: AppDb, env: IdentityBusinessContinuationEnv, input: {
  campusId: number; intentId: string; requestContext: IdentityTrustedRequestContext; now?: string;
  event: Pick<RegEvent, 'id' | 'title' | 'price_cents' | 'currency' | 'active' | 'closes_at' | 'starts_at'>;
  name: string; email: string; locale: ContinuationLocale; answers: Array<[number, string]>;
}): Promise<{ status: 'verification_required'; intentId: string; operationId: string; delivery: { to: string; publicId: string; code: string; expiresAt: string } } | { status: 'pending'; intentId: string; operationId: string }> {
  if (!validId(input.campusId) || !validIntentId(input.intentId)) throw new Error('identity_continuation_invalid');
  if (input.event.active !== 1 || (input.event.closes_at ?? input.event.starts_at) <= nowUtc(input.now)) throw new Error('identity_continuation_event_closed');
  const normalized = await normalizeRegistrationContinuationInput({ eventId: input.event.id, name: input.name, email: input.email,
    amountCents: input.event.price_cents && input.event.price_cents > 0 ? input.event.price_cents : 0, currency: input.event.currency,
    locale: input.locale, answers: input.answers });
  const questions = await listQuestions(db, normalized.locale, normalized.eventId);
  if (JSON.stringify(revalidateRegistrationAnswers(questions, [...normalized.answers])) !== JSON.stringify(normalized.answers)) {
    throw new Error('identity_continuation_answers_invalid');
  }
  const questionDigest = await registrationQuestionDigest(questions);
  const payloadDigest = await continuationPayloadDigest(normalized);
  const source = await registerIdentitySource(db, env, { campusId: input.campusId, source: 'registration', sourceRecordKey: input.intentId,
    email: normalized.email, name: normalized.name, attachmentPolicy: 'signed_in_or_claim', sourceDigest: payloadDigest });
  await createBaseIntent(db, { campusId: input.campusId, intentId: input.intentId, kind: 'registration', sourceRecordId: source.sourceRecordId,
    sourceVersion: source.version, sourceDigest: source.sourceDigest, payloadDigest, expiresAt: expiresAt(input.now) });
  try {
    await db.prepare(`INSERT INTO identity_registration_continuations(intent_id,event_id,amount_cents,currency,locale,answers_json,question_digest,checkout_request_id)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(input.intentId, normalized.eventId, normalized.amountCents, normalized.currency,
      normalized.locale, JSON.stringify(normalized.answers), questionDigest, normalized.amountCents > 0 ? newCheckoutRequestId() : null).run();
  } catch {
    const existing = await db.prepare('SELECT intent_id,question_digest FROM identity_registration_continuations WHERE intent_id=?1')
      .bind(input.intentId).first<{ intent_id: string; question_digest: string }>();
    if (!existing) throw new Error('identity_continuation_conflict');
    if (existing.question_digest !== questionDigest) throw new Error('identity_continuation_payload_drift');
  }
  const signup = await bindSignupOperation(db, env, { campusId: input.campusId, intentId: input.intentId, email: normalized.email,
    name: normalized.name, requestContext: input.requestContext, now: input.now });
  return signup.status === 'verification_required'
    ? { status: signup.status, intentId: input.intentId, operationId: signup.operationId, delivery: signup.delivery }
    : { status: signup.status, intentId: input.intentId, operationId: signup.operationId };
}

async function authenticateAndAttach(db: AppDb, env: IdentityBusinessContinuationEnv, input: {
  intent: IntentRow; publicId: string; code: string; now?: string;
}): Promise<{ status: 'authenticated'; personId: number; sessionEpoch: number } | { status: 'review' } | { status: 'invalid' }> {
  if (!input.intent.signup_operation_id) return { status: 'invalid' };
  const result = await completeVerifiedSignup(db, env, { campusId: input.intent.campus_id, operationId: input.intent.signup_operation_id,
    publicId: input.publicId, code: input.code, source: 'web', now: input.now });
  if (result.status !== 'authenticated') return result.status === 'review' ? { status: 'review' } : { status: 'invalid' };
  await attachIdentitySourceForSignedInSession(db, env, { campusId: input.intent.campus_id, source: input.intent.kind === 'giving_checkout' ? 'giving' : 'registration',
    sourceRecordKey: input.intent.intent_id, expectedSourceRecordId: input.intent.source_record_id,
    expectedVersion: input.intent.source_version, sourceDigest: input.intent.source_digest,
    session: identityGatewaySessionContext({ personId: result.personId, campusId: input.intent.campus_id, sessionEpoch: result.sessionEpoch }) });
  return result;
}

function continuationChildTable(kind: IntentRow['kind']): 'identity_giving_checkout_continuations' | 'identity_registration_continuations' {
  return kind === 'giving_checkout' ? 'identity_giving_checkout_continuations' : 'identity_registration_continuations';
}

async function setReady(db: AppDb, intent: IntentRow, personId: number): Promise<boolean> {
  const table = continuationChildTable(intent.kind);
  try {
    await db.batch([
      db.prepare(`UPDATE ${table} SET state='ready',updated_at=datetime('now') WHERE intent_id=?1 AND state='pending'`)
        .bind(intent.intent_id),
      db.prepare(`UPDATE identity_business_intents SET state='ready',result_person_id=?1,signup_delivery_ciphertext=NULL,
        signup_delivery_count=0,signup_delivery_not_before=NULL,updated_at=datetime('now')
        WHERE intent_id=?2 AND campus_id=?3 AND state='pending_verification'`).bind(personId, intent.intent_id, intent.campus_id),
    ]);
  } catch { /* The exact durable state check below decides whether a race won safely. */ }
  const saved = await db.prepare('SELECT state,result_person_id FROM identity_business_intents WHERE intent_id=?1 AND campus_id=?2')
    .bind(intent.intent_id, intent.campus_id).first<{ state: string; result_person_id: number | null }>();
  const child = await db.prepare(`SELECT state FROM ${table} WHERE intent_id=?1`).bind(intent.intent_id).first<string>('state');
  return saved?.result_person_id === personId && (saved.state === 'ready' || saved.state === 'consumed')
    && child !== null && ['ready', 'creating', 'attached', 'consumed'].includes(child);
}

async function terminalizeContinuation(
  db: AppDb,
  intent: Pick<IntentRow, 'intent_id' | 'campus_id' | 'kind'>,
  state: 'review' | 'expired',
  now?: string,
): Promise<boolean> {
  const table = continuationChildTable(intent.kind);
  const current = nowUtc(now);
  try {
    const results = await db.batch([
      db.prepare(`UPDATE ${table} SET state=?1,claim_token_hash=NULL,claim_expires_at=NULL,updated_at=?2
        WHERE intent_id=?3 AND (state IN ('pending','ready')
          OR (state='creating' AND (claim_expires_at IS NULL OR claim_expires_at<=?2)))`)
        .bind(state, current, intent.intent_id),
      db.prepare(`UPDATE identity_business_intents SET state=?1,signup_delivery_ciphertext=NULL,signup_delivery_count=0,
        signup_delivery_not_before=NULL,updated_at=?2 WHERE intent_id=?3 AND campus_id=?4
        AND state IN ('pending_verification','ready')`).bind(state, current, intent.intent_id, intent.campus_id),
    ]);
    return results[1]?.meta.changes === 1;
  } catch { /* A concurrent terminal or consumed result remains authoritative. */ }
  return false;
}

/** Bounded hourly privacy sweep for continuations that expire without another
 * browser request. Each candidate is terminalized child-first in one D1/PG
 * transaction; an unexpired checkout claim lease is never interrupted. */
export async function expireIdentityBusinessContinuations(
  db: AppDb,
  options: { now?: string; limit?: number } = {},
): Promise<{ scanned: number; expired: number }> {
  const current = nowUtc(options.now);
  const limit = options.limit ?? DEFAULT_EXPIRY_SWEEP_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPIRY_SWEEP_LIMIT) {
    throw new Error('identity_continuation_sweep_limit_invalid');
  }
  const candidates = await db.prepare(`SELECT i.intent_id,i.campus_id,i.kind
    FROM identity_business_intents i
    WHERE i.state IN ('pending_verification','ready') AND i.expires_at<=?1 AND (
      (i.kind='giving_checkout' AND EXISTS (
        SELECT 1 FROM identity_giving_checkout_continuations g WHERE g.intent_id=i.intent_id
          AND (g.state IN ('pending','ready') OR (g.state='creating' AND (g.claim_expires_at IS NULL OR g.claim_expires_at<=?1)))
      )) OR
      (i.kind='registration' AND EXISTS (
        SELECT 1 FROM identity_registration_continuations r WHERE r.intent_id=i.intent_id
          AND (r.state IN ('pending','ready') OR (r.state='creating' AND (r.claim_expires_at IS NULL OR r.claim_expires_at<=?1)))
      ))
    ) ORDER BY i.expires_at,i.intent_id LIMIT ?2`).bind(current, limit)
    .all<Pick<IntentRow, 'intent_id' | 'campus_id' | 'kind'>>();
  let expired = 0;
  for (const intent of candidates.results) {
    if (await terminalizeContinuation(db, intent, 'expired', current)) expired += 1;
  }
  return { scanned: candidates.results.length, expired };
}

export async function claimContinuationChild(db: AppDb, kind: 'giving' | 'registration', intentId: string, now?: string): Promise<{ status: 'claimed' | 'busy' | 'done'; claimHash?: string }> {
  const table = kind === 'giving' ? 'identity_giving_checkout_continuations' : 'identity_registration_continuations';
  const resultColumn = kind === 'giving' ? 'stripe_session_id' : 'registration_id';
  const claimHash = await sha256Utf8(crypto.randomUUID()); const current = nowUtc(now);
  const row = await db.prepare(`SELECT state,${resultColumn} AS result_id,claim_expires_at FROM ${table} WHERE intent_id=?1`).bind(intentId)
    .first<{ state: string; result_id: string | number | null; claim_expires_at: string | null }>();
  if (!row) throw new Error('identity_continuation_not_found');
  if (row.state === 'consumed' || row.result_id !== null) return { status: 'done' };
  const claimed = await db.prepare(`UPDATE ${table} SET state='creating',claim_token_hash=?1,claim_expires_at=?2,updated_at=?3
    WHERE intent_id=?4 AND state IN ('ready','creating') AND (state='ready' OR claim_expires_at IS NULL OR claim_expires_at<=?3)`)
    .bind(claimHash, leaseAt(now), current, intentId).run();
  return claimed.meta.changes === 1 ? { status: 'claimed', claimHash } : { status: 'busy' };
}

async function markGivingConsumed(db: AppDb, intent: IntentRow, personId: number, session: { id: string; url: string }, claimHash: string): Promise<void> {
  const child = await db.prepare('SELECT checkout_request_id FROM identity_giving_checkout_continuations WHERE intent_id=?1').bind(intent.intent_id).first<{ checkout_request_id: string }>();
  if (!child) throw new Error('identity_continuation_not_found');
  await db.batch([
    db.prepare(`UPDATE identity_giving_checkout_continuations SET state='attached',stripe_session_id=?1,stripe_session_url=?2,claim_token_hash=NULL,claim_expires_at=NULL,updated_at=datetime('now')
      WHERE intent_id=?3 AND state='creating' AND claim_token_hash=?4 AND stripe_session_id IS NULL`).bind(session.id, session.url, intent.intent_id, claimHash),
    db.prepare(`INSERT INTO identity_business_intent_receipts(receipt_id,campus_id,intent_id,source_record_id,source_version,source_digest,person_id,business_record_key)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(crypto.randomUUID(), intent.campus_id, intent.intent_id, intent.source_record_id, intent.source_version, intent.source_digest, personId, child.checkout_request_id),
    // Keep Stripe ids and URLs in the business child row, never in identity
    // receipts or audit metadata.
    db.prepare(`UPDATE identity_business_intents SET state='consumed',business_record_key=?1,signup_delivery_ciphertext=NULL,
      signup_delivery_count=0,signup_delivery_not_before=NULL,updated_at=datetime('now') WHERE intent_id=?2 AND state='ready' AND result_person_id=?3`)
      .bind(child.checkout_request_id, intent.intent_id, personId),
    db.prepare(`UPDATE identity_giving_checkout_continuations SET state='consumed',updated_at=datetime('now') WHERE intent_id=?1 AND state='attached' AND stripe_session_id=?2`)
      .bind(intent.intent_id, session.id),
  ]);
}

export type GivingContinuationResult =
  | { status: 'redirect'; personId: number; sessionEpoch: number; sessionId: string; url: string; replay?: true }
  | { status: 'waiting'; personId: number; sessionEpoch: number; replay?: never }
  | { status: 'review' | 'invalid'; replay?: never };

export async function completeGivingContinuation(db: AppDb, env: IdentityBusinessContinuationEnv, input: {
  campusId: number; intentId: string; publicId: string; code: string; now?: string;
}): Promise<GivingContinuationResult> {
  if (!validId(input.campusId) || !validIntentId(input.intentId)) return { status: 'invalid' };
  const intent = await loadIntent(db, input.campusId, input.intentId, 'giving_checkout');
  if (!intent) return { status: 'invalid' };
  if (intent.expires_at <= nowUtc(input.now)) {
    await terminalizeContinuation(db, intent, 'expired', input.now);
    return { status: 'invalid' };
  }
  const auth = await authenticateAndAttach(db, env, { intent, publicId: input.publicId, code: input.code, now: input.now });
  if (auth.status !== 'authenticated') {
    if (auth.status === 'review' && intent.state !== 'consumed') await terminalizeContinuation(db, intent, 'review', input.now);
    return auth;
  }
  if (intent.state === 'consumed' && intent.business_record_key) {
    const saved = await db.prepare('SELECT stripe_session_id,stripe_session_url FROM identity_giving_checkout_continuations WHERE intent_id=?1').bind(input.intentId)
      .first<{ stripe_session_id: string | null; stripe_session_url: string | null }>();
    return saved?.stripe_session_id && saved.stripe_session_url
      ? { status: 'redirect', personId: auth.personId, sessionEpoch: auth.sessionEpoch,
        sessionId: saved.stripe_session_id, url: saved.stripe_session_url, replay: true }
      : { status: 'invalid' };
  }
  if (!await setReady(db, intent, auth.personId)) return { status: 'invalid' };
  const claim = await claimContinuationChild(db, 'giving', input.intentId, input.now);
  if (claim.status === 'busy') return { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch };
  if (claim.status === 'done') {
    const saved = await db.prepare('SELECT stripe_session_id,stripe_session_url FROM identity_giving_checkout_continuations WHERE intent_id=?1').bind(input.intentId)
      .first<{ stripe_session_id: string | null; stripe_session_url: string | null }>();
    return saved?.stripe_session_id && saved.stripe_session_url
      ? { status: 'redirect', personId: auth.personId, sessionEpoch: auth.sessionEpoch,
        sessionId: saved.stripe_session_id, url: saved.stripe_session_url, replay: true }
      : { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch };
  }
  const child = await db.prepare('SELECT fund_id,amount_cents,currency,locale,checkout_request_id FROM identity_giving_checkout_continuations WHERE intent_id=?1')
    .bind(input.intentId).first<{ fund_id: number; amount_cents: number; currency: string; locale: ContinuationLocale; checkout_request_id: string }>();
  const person = await db.prepare('SELECT display_name,email FROM people WHERE id=?1').bind(auth.personId).first<{ display_name: string; email: string }>();
  if (!child || !person) {
    await db.prepare(`UPDATE identity_giving_checkout_continuations SET state='ready',claim_token_hash=NULL,claim_expires_at=NULL,
      updated_at=datetime('now') WHERE intent_id=?1 AND state='creating' AND claim_token_hash=?2`).bind(input.intentId, claim.claimHash!).run();
    return { status: 'invalid' };
  }
  let fund;
  try { fund = await getFund(db, child.locale, child.fund_id); } catch {
    await db.prepare(`UPDATE identity_giving_checkout_continuations SET state='ready',claim_token_hash=NULL,claim_expires_at=NULL,
      updated_at=datetime('now') WHERE intent_id=?1 AND state='creating' AND claim_token_hash=?2`).bind(input.intentId, claim.claimHash!).run();
    return { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch };
  }
  if (!fund || fund.active !== 1) {
    await db.prepare(`UPDATE identity_giving_checkout_continuations SET state='ready',claim_token_hash=NULL,claim_expires_at=NULL,
      updated_at=datetime('now') WHERE intent_id=?1 AND state='creating' AND claim_token_hash=?2`).bind(input.intentId, claim.claimHash!).run();
    return { status: 'invalid' };
  }
  try {
    const session = await createOneTimeCheckout(env, { amountCents: child.amount_cents, currency: child.currency, fundId: child.fund_id,
      fundName: fund.name, locale: child.locale, personId: auth.personId, donorName: person.display_name, donorEmail: person.email,
      customerId: await getStripeCustomer(db, auth.personId) }, { requestId: parseCheckoutRequestId(child.checkout_request_id) });
    await markGivingConsumed(db, intent, auth.personId, session, claim.claimHash!);
    return { status: 'redirect', personId: auth.personId, sessionEpoch: auth.sessionEpoch, sessionId: session.id, url: session.url };
  } catch {
    await db.prepare(`UPDATE identity_giving_checkout_continuations SET state='ready',claim_token_hash=NULL,claim_expires_at=NULL,updated_at=datetime('now') WHERE intent_id=?1 AND state='creating' AND claim_token_hash=?2`).bind(input.intentId, claim.claimHash!).run();
    return { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch };
  }
}

async function loadRegistrationContinuation(db: AppDb, campusId: number, intentId: string) {
  return db.prepare(`SELECT i.*,o.normalized_email,o.normalized_name,
    r.event_id,r.amount_cents,r.currency,r.locale,r.answers_json,r.checkout_request_id,r.registration_id,r.state continuation_state
    FROM identity_business_intents i JOIN identity_registration_continuations r ON r.intent_id=i.intent_id
    JOIN identity_source_records s ON s.id=i.source_record_id JOIN identity_observations o ON o.id=s.observation_id
    WHERE i.intent_id=?1 AND i.campus_id=?2 AND i.kind='registration'`).bind(intentId, campusId)
    .first<IntentRow & { event_id: number; amount_cents: number; currency: string; locale: ContinuationLocale; answers_json: string; checkout_request_id: string | null; registration_id: number | null; continuation_state: string }>();
}

type RegistrationCheckoutSagaDeps = {
  createCheckout: typeof createRegistrationCheckoutFromParams;
  attachRequest: typeof attachRegistrationCheckoutRequest;
  cancelRequest: typeof cancelRegistrationCheckoutRequest;
  continueRequest: typeof continueRegistrationCheckoutRequest;
};

const defaultRegistrationCheckoutSagaDeps: RegistrationCheckoutSagaDeps = {
  createCheckout: createRegistrationCheckoutFromParams,
  attachRequest: attachRegistrationCheckoutRequest,
  cancelRequest: cancelRegistrationCheckoutRequest,
  continueRequest: continueRegistrationCheckoutRequest,
};

/**
 * Completes the existing private registration checkout state machine. Stripe
 * is called only for a durable `create` resolution; every other state is
 * converged through the stored request, so retries never create a second
 * session. The returned state is safe for the identity continuation to bind.
 */
export async function continuePaidRegistrationCheckout(
  db: AppDb,
  env: IdentityBusinessContinuationEnv,
  resolution: CheckoutRequestResolution,
  eventId: number,
  deps: RegistrationCheckoutSagaDeps = defaultRegistrationCheckoutSagaDeps,
): Promise<CheckoutRequestResolution> {
  if (resolution.kind !== 'create') return resolution;
  const price = resolution.requestJson.line_items[0]?.price_data;
  if (!price || resolution.registrationId <= 0) return { kind: 'review', registrationId: resolution.registrationId, reason: 'request_corrupt' };
  try {
    const session = await deps.createCheckout(env, resolution.requestJson, { requestId: resolution.requestId });
    const attached = await deps.attachRequest(db, {
      requestId: resolution.requestId,
      registrationId: resolution.registrationId,
      sessionId: session.id,
      sessionUrl: session.url,
      amountCents: price.unit_amount,
      currency: price.currency,
    });
    if (attached) return { kind: 'redirect', registrationId: resolution.registrationId, checkoutUrl: session.url };
    const converged = await deps.continueRequest(db, resolution.requestId, eventId);
    return converged.kind === 'create' ? { kind: 'waiting', registrationId: resolution.registrationId } : converged;
  } catch (error) {
    if (classifyRegistrationCheckoutFailure(error) === 'cancel') {
      try {
        if (await deps.cancelRequest(db, resolution.requestId, resolution.registrationId)) return { kind: 'expired' };
      } catch { /* Recovery service owns an unresolved compensation. */ }
    }
    return { kind: 'waiting', registrationId: resolution.registrationId };
  }
}

export async function completeRegistrationContinuation(db: AppDb, env: IdentityBusinessContinuationEnv, input: {
  campusId: number; intentId: string; publicId: string; code: string; appOrigin: string; now?: string;
}): Promise<{ status: 'done' | 'redirect' | 'waiting' | 'review' | 'invalid'; personId?: number; sessionEpoch?: number;
  resolution?: CheckoutRequestResolution; replay?: true }> {
  if (!validId(input.campusId) || !validIntentId(input.intentId)) return { status: 'invalid' };
  const intent = await loadRegistrationContinuation(db, input.campusId, input.intentId);
  if (!intent) return { status: 'invalid' };
  if (intent.expires_at <= nowUtc(input.now)) {
    await terminalizeContinuation(db, intent, 'expired', input.now);
    return { status: 'invalid' };
  }
  const auth = await authenticateAndAttach(db, env, { intent, publicId: input.publicId, code: input.code, now: input.now });
  if (auth.status !== 'authenticated') {
    if (auth.status === 'review') await terminalizeContinuation(db, intent, 'review', input.now);
    return auth.status === 'review' ? { status: 'review' } : { status: 'invalid' };
  }
  if (!await setReady(db, intent, auth.personId)) return { status: 'invalid' };
  if (intent.registration_id !== null) {
    let resolution = intent.checkout_request_id
      ? await continueRegistrationCheckoutRequest(db, intent.checkout_request_id, intent.event_id)
      : { kind: 'done', registrationId: intent.registration_id } as CheckoutRequestResolution;
    // A transport failure may leave the private request in `creating`. A
    // replay retries that exact idempotency key through the same saga; it never
    // creates a new request or Stripe session identity.
    if (resolution.kind === 'create') resolution = await continuePaidRegistrationCheckout(db, env, resolution, intent.event_id);
    if (resolution.kind === 'conflict' || resolution.kind === 'expired') return { status: 'invalid' };
    if (resolution.kind === 'review') return { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch, resolution };
    return resolution.kind === 'done' ? { status: 'done', personId: auth.personId, sessionEpoch: auth.sessionEpoch, resolution, replay: true }
      : resolution.kind === 'redirect' ? { status: 'redirect', personId: auth.personId, sessionEpoch: auth.sessionEpoch, resolution, replay: true }
        : { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch, resolution };
  }
  const claim = await claimContinuationChild(db, 'registration', input.intentId, input.now);
  if (claim.status === 'busy') return { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch };
  if (claim.status === 'done') {
    const saved = await db.prepare('SELECT registration_id FROM identity_registration_continuations WHERE intent_id=?1').bind(input.intentId).first<{ registration_id: number | null }>();
    return saved?.registration_id !== null && saved?.registration_id !== undefined
      ? { status: 'done', personId: auth.personId, sessionEpoch: auth.sessionEpoch, replay: true }
      : { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch };
  }
  const child = await db.prepare('SELECT event_id,amount_cents,currency,locale,answers_json,question_digest,checkout_request_id FROM identity_registration_continuations WHERE intent_id=?1')
    .bind(input.intentId).first<{ event_id: number; amount_cents: number; currency: string; locale: ContinuationLocale;
      answers_json: string; question_digest: string; checkout_request_id: string | null }>();
  if (!child) {
    await db.prepare(`UPDATE identity_registration_continuations SET state='ready',claim_token_hash=NULL,claim_expires_at=NULL,updated_at=datetime('now') WHERE intent_id=?1 AND state='creating' AND claim_token_hash=?2`).bind(input.intentId, claim.claimHash!).run();
    return { status: 'invalid' };
  }
  let answers: Array<[number, string]>;
  try { answers = JSON.parse(child.answers_json) as Array<[number, string]>; } catch {
    await db.prepare(`UPDATE identity_registration_continuations SET state='ready',claim_token_hash=NULL,claim_expires_at=NULL,updated_at=datetime('now') WHERE intent_id=?1 AND state='creating' AND claim_token_hash=?2`).bind(input.intentId, claim.claimHash!).run();
    return { status: 'invalid' };
  }
  const event = await db.prepare(`SELECT e.id,COALESCE(el.title,en.title,'') title,e.price_cents,e.currency,e.active,e.closes_at,e.starts_at
    FROM reg_events e LEFT JOIN reg_event_i18n el ON el.event_id=e.id AND el.locale=?2
    LEFT JOIN reg_event_i18n en ON en.event_id=e.id AND en.locale='en' WHERE e.id=?1`)
    .bind(child.event_id, child.locale).first<Pick<RegEvent, 'id' | 'title' | 'price_cents' | 'currency' | 'active' | 'closes_at' | 'starts_at'>>();
  const release = () => db.prepare(`UPDATE identity_registration_continuations SET state='ready',claim_token_hash=NULL,claim_expires_at=NULL,updated_at=datetime('now') WHERE intent_id=?1 AND state='creating' AND claim_token_hash=?2`).bind(input.intentId, claim.claimHash!);
  if (!event || event.active !== 1 || (event.closes_at ?? event.starts_at) <= nowUtc(input.now)
    || (event.price_cents && event.price_cents > 0 ? event.price_cents : 0) !== child.amount_cents || event.currency.toLowerCase() !== child.currency) {
    await release().run();
    return { status: 'invalid' };
  }
  try {
    const questions = await listQuestions(db, child.locale, child.event_id);
    if (await registrationQuestionDigest(questions) !== child.question_digest) {
      await release().run(); return { status: 'invalid' };
    }
    const checked = revalidateRegistrationAnswers(questions, answers);
    if (JSON.stringify(checked) !== JSON.stringify(canonicalRegistrationAnswers(answers))) {
      await release().run(); return { status: 'invalid' };
    }
  } catch { await release().run(); return { status: 'invalid' }; }
  const owner = await db.prepare('SELECT display_name,email FROM people WHERE id=?1 AND active=1 AND deleted_at IS NULL').bind(auth.personId).first<{ display_name: string; email: string }>();
  if (!owner) { await release().run(); return { status: 'invalid' }; }
  if (child.amount_cents === 0) {
    const registrationId = databaseId();
    try {
      await db.batch([
        // This harmless write is the portable per-event capacity mutex: it
        // takes a PostgreSQL row lock and enters D1's serialized write
        // transaction before the capacity predicate is evaluated.
        db.prepare('UPDATE reg_events SET updated_at=updated_at WHERE id=?1').bind(child.event_id),
        db.prepare(`INSERT INTO registrations(id,event_id,person_id,name,email,status,amount_cents,currency)
          SELECT ?1,e.id,?3,?4,?5,'confirmed',0,?6 FROM reg_events e
          WHERE e.id=?2 AND e.active=1 AND COALESCE(e.closes_at,e.starts_at)>?7
            AND COALESCE(e.price_cents,0)=0 AND lower(e.currency)=?6
            AND (e.capacity IS NULL OR (SELECT count(*) FROM registrations r
              WHERE r.event_id=e.id AND r.status IN ('pending','confirmed'))<e.capacity)`)
          .bind(registrationId, child.event_id, auth.personId, owner.display_name, owner.email, child.currency, nowUtc(input.now)),
        ...answers.map(([questionId, answer]) => db.prepare('INSERT INTO reg_answers(registration_id,question_id,value) VALUES(?1,?2,?3)').bind(registrationId, questionId, answer)),
        db.prepare(`UPDATE identity_registration_continuations SET state='attached',registration_id=?1,claim_token_hash=NULL,claim_expires_at=NULL,updated_at=datetime('now') WHERE intent_id=?2 AND state='creating' AND claim_token_hash=?3`).bind(registrationId, input.intentId, claim.claimHash!),
        db.prepare(`INSERT INTO identity_business_intent_receipts(receipt_id,campus_id,intent_id,source_record_id,source_version,source_digest,person_id,business_record_key)
          VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(crypto.randomUUID(), intent.campus_id, intent.intent_id, intent.source_record_id, intent.source_version, intent.source_digest, auth.personId, String(registrationId)),
        db.prepare(`UPDATE identity_business_intents SET state='consumed',business_record_key=?1,signup_delivery_ciphertext=NULL,
          signup_delivery_count=0,signup_delivery_not_before=NULL,updated_at=datetime('now') WHERE intent_id=?2 AND state='ready' AND result_person_id=?3`).bind(String(registrationId), input.intentId, auth.personId),
        db.prepare(`UPDATE identity_registration_continuations SET state='consumed',updated_at=datetime('now') WHERE intent_id=?1 AND registration_id=?2`).bind(input.intentId, registrationId),
      ]);
    } catch (error) {
      await db.prepare(`UPDATE identity_registration_continuations SET state='ready',claim_token_hash=NULL,claim_expires_at=NULL,updated_at=datetime('now') WHERE intent_id=?1 AND state='creating' AND claim_token_hash=?2`).bind(input.intentId, claim.claimHash!).run();
      const capacity = await db.prepare(`SELECT e.capacity,(SELECT count(*) FROM registrations r
        WHERE r.event_id=e.id AND r.status IN ('pending','confirmed')) taken FROM reg_events e WHERE e.id=?1`)
        .bind(child.event_id).first<{ capacity: number | null; taken: number }>();
      if (capacity && capacity.capacity !== null && capacity.taken >= capacity.capacity) return { status: 'invalid' };
      return { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch };
    }
    return { status: 'done', personId: auth.personId, sessionEpoch: auth.sessionEpoch };
  }
  if (!child.checkout_request_id) return { status: 'invalid' };
  let resolution: CheckoutRequestResolution;
  try {
    resolution = await resolveRegistrationCheckoutRequest(db, { requestId: child.checkout_request_id, eventId: child.event_id, personId: auth.personId,
      name: owner.display_name, email: owner.email, amountCents: child.amount_cents, currency: child.currency,
      answers, eventTitle: event.title, locale: child.locale, appOrigin: input.appOrigin });
  } catch {
    await db.prepare(`UPDATE identity_registration_continuations SET state='ready',claim_token_hash=NULL,claim_expires_at=NULL,updated_at=datetime('now') WHERE intent_id=?1 AND state='creating' AND claim_token_hash=?2`).bind(input.intentId, claim.claimHash!).run();
    return { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch };
  }
  resolution = await continuePaidRegistrationCheckout(db, env, resolution, child.event_id);
  if (resolution.kind === 'conflict' || resolution.kind === 'expired') {
    await release().run();
    return { status: 'invalid' };
  }
  if (resolution.kind === 'review') {
    await release().run();
    return { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch, resolution };
  }
  if (resolution.kind === 'waiting' || resolution.kind === 'redirect' || resolution.kind === 'done') {
    const registrationId = resolution.registrationId;
    try {
      await db.batch([
        db.prepare(`UPDATE identity_registration_continuations SET state='attached',registration_id=?1,claim_token_hash=NULL,claim_expires_at=NULL,updated_at=datetime('now') WHERE intent_id=?2 AND state='creating' AND claim_token_hash=?3`).bind(registrationId, input.intentId, claim.claimHash!),
        db.prepare(`INSERT INTO identity_business_intent_receipts(receipt_id,campus_id,intent_id,source_record_id,source_version,source_digest,person_id,business_record_key)
          VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(crypto.randomUUID(), intent.campus_id, intent.intent_id, intent.source_record_id, intent.source_version, intent.source_digest, auth.personId, String(registrationId)),
        db.prepare(`UPDATE identity_business_intents SET state='consumed',business_record_key=?1,signup_delivery_ciphertext=NULL,
          signup_delivery_count=0,signup_delivery_not_before=NULL,updated_at=datetime('now') WHERE intent_id=?2 AND state='ready' AND result_person_id=?3`).bind(String(registrationId), input.intentId, auth.personId),
        db.prepare(`UPDATE identity_registration_continuations SET state='consumed',updated_at=datetime('now') WHERE intent_id=?1 AND registration_id=?2`).bind(input.intentId, registrationId),
      ]);
    } catch { return { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch, resolution }; }
  }
  return resolution.kind === 'done' ? { status: 'done', personId: auth.personId, sessionEpoch: auth.sessionEpoch, resolution }
    : resolution.kind === 'redirect' ? { status: 'redirect', personId: auth.personId, sessionEpoch: auth.sessionEpoch, resolution }
      : { status: 'waiting', personId: auth.personId, sessionEpoch: auth.sessionEpoch, resolution };
}

export async function signedInIdentitySourceContext(db: AppDb, env: IdentityBusinessContinuationEnv, input: {
  campusId: number; source: 'giving' | 'registration'; intentId: string; personId: number; sessionEpoch: number;
  sourceDigest: string; name: string; email: string;
}): Promise<IdentityGatewaySessionContext> {
  if (!validId(input.campusId) || !validId(input.personId) || !validIntentId(input.intentId)) throw new Error('identity_continuation_invalid');
  const source = await registerIdentitySource(db, env, { campusId: input.campusId, source: input.source, sourceRecordKey: input.intentId,
    email: input.email, name: input.name, attachmentPolicy: 'signed_in_or_claim', sourceDigest: input.sourceDigest });
  const session = identityGatewaySessionContext({ personId: input.personId, campusId: input.campusId, sessionEpoch: input.sessionEpoch });
  await attachIdentitySourceForSignedInSession(db, env, { campusId: input.campusId, source: input.source, sourceRecordKey: input.intentId,
    expectedSourceRecordId: source.sourceRecordId, expectedVersion: source.version, sourceDigest: source.sourceDigest, session });
  return session;
}

export async function signedInExistingIdentitySourceContext(db: AppDb, env: IdentityBusinessContinuationEnv, input: {
  campusId: number; source: 'giving' | 'registration'; intentId: string; personId: number; sessionEpoch: number;
}): Promise<IdentityGatewaySessionContext> {
  if (!validId(input.campusId) || !validId(input.personId) || !validIntentId(input.intentId)) throw new Error('identity_continuation_invalid');
  const source = await getIdentitySourceRecord(db, env, { campusId: input.campusId, source: input.source, sourceRecordKey: input.intentId });
  if (!source) throw new Error('identity_source_not_found');
  const session = identityGatewaySessionContext({ personId: input.personId, campusId: input.campusId, sessionEpoch: input.sessionEpoch });
  await attachIdentitySourceForSignedInSession(db, env, { campusId: input.campusId, source: input.source,
    sourceRecordKey: input.intentId, expectedSourceRecordId: source.id, expectedVersion: source.version,
    sourceDigest: source.source_digest, session });
  return session;
}
