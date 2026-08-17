import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { AppDb } from './appDb';
import { LEARNING_LIMITS, learningValidation } from './learningModel';

const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const MAX_JWKS_BYTES = 131_072;
const MAX_PUSH_BODY_BYTES = 65_536;
const MAX_JWT_BYTES = 8_192;
const MAX_TOKEN_LIFETIME_SECONDS = 3_900;
const CLOCK_SKEW_SECONDS = 30;
const COLLECTIONS = Object.freeze([
  'courses.students',
  'courses.teachers',
  'courses.courseWork',
  'courses.courseWork.studentSubmissions',
] as const);
type GoogleClassroomCollection = (typeof COLLECTIONS)[number];

export class LearningGooglePubSubError extends Error {
  readonly code = 'learning_google_pubsub_invalid' as const;
  constructor() {
    super('learning_google_pubsub_invalid');
    this.name = 'LearningGooglePubSubError';
  }
}

export class LearningGooglePubSubConflictError extends Error {
  readonly code = 'learning_google_pubsub_conflict' as const;
  constructor() {
    super('learning_google_pubsub_conflict');
    this.name = 'LearningGooglePubSubConflictError';
  }
}

const invalid = (): never => { throw new LearningGooglePubSubError(); };

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try { return learningValidation.exactRecord(value, keys); } catch { return invalid(); }
}

function record(value: unknown): Record<string, unknown> {
  try { return learningValidation.dataRecord(value); } catch { return invalid(); }
}

function bounded(value: unknown, minimum: number, maximum: number): string {
  try { return learningValidation.boundedString(value, minimum, maximum); } catch { return invalid(); }
}

function externalId(value: unknown): string {
  try { return learningValidation.externalId(value); } catch { return invalid(); }
}

function timestamp(value: unknown): string {
  try { return learningValidation.timestamp(value); } catch { return invalid(); }
}

function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function httpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > LEARNING_LIMITS.urlBytes) invalid();
  let url: URL;
  try { url = new URL(value as string); } catch { return invalid(); }
  if (
    url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.hash !== '' || url.href !== value
  ) invalid();
  return value as string;
}

function serviceAccountEmail(value: unknown): string {
  const email = bounded(value, 6, 320);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?@[A-Za-z0-9-]+\.iam\.gserviceaccount\.com$/u.test(email)) {
    invalid();
  }
  return email;
}

function subscriptionName(value: unknown): string {
  const name = bounded(value, 28, 512);
  if (!/^projects\/[A-Za-z0-9._:-]+\/subscriptions\/[A-Za-z0-9._~-]+$/u.test(name)) invalid();
  return name;
}

function topicName(value: unknown): string {
  const name = bounded(value, 20, 512);
  if (!/^projects\/[A-Za-z0-9._:-]+\/topics\/[A-Za-z0-9._~-]+$/u.test(name)) invalid();
  return name;
}

function accessToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048 || !/^[\x21-\x7e]+$/u.test(value)) {
    invalid();
  }
  return value as string;
}

function integerSeconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

export interface GooglePubSubIdentity {
  readonly subject: string;
  readonly email: string;
}

export function normalizeGooglePubSubIdentityClaims(
  value: unknown,
  rawOptions: {
    readonly expectedAudience: string;
    readonly expectedServiceAccountEmail: string;
    readonly nowEpochMs: number;
  },
): GooglePubSubIdentity {
  const options = exact(rawOptions, [
    'expectedAudience', 'expectedServiceAccountEmail', 'nowEpochMs',
  ]);
  const audience = httpsUrl(options.expectedAudience);
  const expectedEmail = serviceAccountEmail(options.expectedServiceAccountEmail);
  const nowSeconds = Math.floor(epoch(options.nowEpochMs) / 1_000);
  const claims = record(value);
  if (claims.iss !== GOOGLE_ISSUER || claims.aud !== audience || claims.email_verified !== true) invalid();
  const email = serviceAccountEmail(claims.email);
  if (email !== expectedEmail) invalid();
  const subject = bounded(claims.sub, 1, 255);
  if (!/^[A-Za-z0-9_-]+$/u.test(subject)) invalid();
  const issuedAt = integerSeconds(claims.iat);
  const expiresAt = integerSeconds(claims.exp);
  if (
    issuedAt > nowSeconds + CLOCK_SKEW_SECONDS
    || issuedAt < nowSeconds - MAX_TOKEN_LIFETIME_SECONDS
    || expiresAt <= nowSeconds - CLOCK_SKEW_SECONDS
    || expiresAt > nowSeconds + MAX_TOKEN_LIFETIME_SECONDS
    || expiresAt <= issuedAt
  ) invalid();
  return Object.freeze({ subject, email });
}

interface GoogleJwtVerifyOptions {
  readonly audience: string;
  readonly issuer: typeof GOOGLE_ISSUER;
  readonly algorithms: readonly ['RS256'];
}

export type GooglePubSubTokenVerifier = (
  token: string,
  options: GoogleJwtVerifyOptions,
) => Promise<unknown>;

async function boundedGoogleJwksFetch(
  url: string,
  options: { readonly headers: Headers; readonly method: 'GET'; readonly redirect: 'manual'; readonly signal: AbortSignal },
): Promise<Response> {
  if (url !== GOOGLE_JWKS_URL || options.method !== 'GET' || options.redirect !== 'manual') invalid();
  const response = await fetch(url, options);
  if (!response.ok || response.body === null) {
    try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
    throw new LearningGooglePubSubError();
  }
  const rawLength = response.headers.get('Content-Length');
  if (rawLength !== null && (!/^(?:0|[1-9]\d*)$/u.test(rawLength) || Number(rawLength) > MAX_JWKS_BYTES)) {
    try { void response.body.cancel().catch(() => undefined); } catch { /* best effort */ }
    throw new LearningGooglePubSubError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    if (!(part.value instanceof Uint8Array)) invalid();
    size += part.value.byteLength;
    if (size > MAX_JWKS_BYTES) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      invalid();
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' },
  });
}

const GOOGLE_JWKS = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), {
  timeoutDuration: 3_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
  [customFetch]: boundedGoogleJwksFetch,
});

const productionTokenVerifier: GooglePubSubTokenVerifier = async (token, options) => {
  const result = await jwtVerify(token, GOOGLE_JWKS, {
    audience: options.audience,
    issuer: options.issuer,
    algorithms: [...options.algorithms],
    clockTolerance: CLOCK_SKEW_SECONDS,
  });
  return result.payload;
};

export async function verifyGooglePubSubAuthorization(rawInput: {
  readonly authorizationHeader: string | null;
  readonly expectedAudience: string;
  readonly expectedServiceAccountEmail: string;
  readonly nowEpochMs: number;
  readonly verifyToken?: GooglePubSubTokenVerifier;
}): Promise<GooglePubSubIdentity> {
  const input = exact(rawInput, [
    'authorizationHeader', 'expectedAudience', 'expectedServiceAccountEmail', 'nowEpochMs', 'verifyToken',
  ]);
  if (typeof input.authorizationHeader !== 'string' || input.authorizationHeader.length > MAX_JWT_BYTES + 7) invalid();
  const authorizationHeader = input.authorizationHeader as string;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(authorizationHeader);
  if (!match || learningValidation.utf8Bytes(match[1]) > MAX_JWT_BYTES) invalid();
  const token = match?.[1] ?? invalid();
  const audience = httpsUrl(input.expectedAudience);
  const email = serviceAccountEmail(input.expectedServiceAccountEmail);
  const nowEpochMs = epoch(input.nowEpochMs);
  const verifier = input.verifyToken === undefined ? productionTokenVerifier : input.verifyToken;
  if (typeof verifier !== 'function') invalid();
  let claims: unknown;
  try {
    claims = await (verifier as GooglePubSubTokenVerifier)(token, {
      audience, issuer: GOOGLE_ISSUER, algorithms: ['RS256'],
    });
  } catch {
    return invalid();
  }
  return normalizeGooglePubSubIdentityClaims(claims, {
    expectedAudience: audience, expectedServiceAccountEmail: email, nowEpochMs,
  });
}

export interface GooglePubSubDelivery {
  readonly subscriptionName: string;
  readonly messageId: string;
  readonly registrationId: string;
  readonly collection: GoogleClassroomCollection;
  readonly externalCourseId: string;
  readonly resourceId: Readonly<Record<string, string>>;
  readonly publishedAt: string;
  readonly receivedAt: string;
}

function strictBase64Json(value: unknown): unknown {
  const encoded = bounded(value, 4, MAX_PUSH_BODY_BYTES);
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    invalid();
  }
  let binary: string;
  try { binary = atob(encoded); } catch { return invalid(); }
  if (btoa(binary) !== encoded || binary.length > MAX_PUSH_BODY_BYTES) invalid();
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return invalid();
  }
}

function normalizeResourceId(
  rawCollection: unknown,
  value: unknown,
): { readonly collection: GoogleClassroomCollection; readonly externalCourseId: string;
  readonly resourceId: Readonly<Record<string, string>> } {
  let collection: GoogleClassroomCollection;
  try { collection = learningValidation.oneOf(rawCollection, COLLECTIONS); } catch { return invalid(); }
  let row: Record<string, unknown>;
  if (collection === 'courses.students' || collection === 'courses.teachers') {
    row = exact(value, ['courseId', 'userId']);
  } else if (collection === 'courses.courseWork') {
    row = exact(value, ['courseId', 'id']);
  } else {
    row = exact(value, ['courseId', 'courseWorkId', 'id']);
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(row)) result[key] = externalId(row[key]);
  return Object.freeze({
    collection,
    externalCourseId: result.courseId,
    resourceId: Object.freeze({ ...result }),
  });
}

export function parseGooglePubSubPushBody(rawInput: {
  readonly rawBody: Uint8Array;
  readonly expectedSubscriptionName: string;
  readonly receivedAt: string;
}): GooglePubSubDelivery {
  const input = exact(rawInput, ['rawBody', 'expectedSubscriptionName', 'receivedAt']);
  if (!(input.rawBody instanceof Uint8Array) || input.rawBody.byteLength < 2 || input.rawBody.byteLength > MAX_PUSH_BODY_BYTES) {
    invalid();
  }
  const expectedSubscription = subscriptionName(input.expectedSubscriptionName);
  const receivedAt = timestamp(input.receivedAt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.rawBody as Uint8Array)) as unknown;
  } catch { return invalid(); }
  const envelope = exact(parsed, ['message', 'subscription']);
  const actualSubscription = subscriptionName(envelope.subscription);
  if (actualSubscription !== expectedSubscription) invalid();
  const message = record(envelope.message);
  const allowedMessageKeys = ['attributes', 'data', 'messageId', 'publishTime'];
  const keys = Object.keys(message);
  if (
    keys.some((key) => !allowedMessageKeys.includes(key))
    || !['attributes', 'data', 'messageId'].every((key) => Object.hasOwn(message, key))
  ) invalid();
  const attributes = exact(message.attributes, ['registrationId']);
  const registrationId = externalId(attributes.registrationId);
  const messageId = externalId(message.messageId);
  const publishedAt = message.publishTime === undefined ? receivedAt : timestamp(message.publishTime);
  const classroom = exact(strictBase64Json(message.data), ['collection', 'resourceId']);
  const normalized = normalizeResourceId(classroom.collection, classroom.resourceId);
  return Object.freeze({
    subscriptionName: actualSubscription,
    messageId,
    registrationId,
    collection: normalized.collection,
    externalCourseId: normalized.externalCourseId,
    resourceId: normalized.resourceId,
    publishedAt,
    receivedAt,
  });
}

function normalizeDelivery(value: unknown): GooglePubSubDelivery {
  const row = exact(value, [
    'subscriptionName', 'messageId', 'registrationId', 'collection', 'externalCourseId',
    'resourceId', 'publishedAt', 'receivedAt',
  ]);
  const normalized = normalizeResourceId(row.collection, row.resourceId);
  const externalCourseId = externalId(row.externalCourseId);
  if (externalCourseId !== normalized.externalCourseId) invalid();
  return Object.freeze({
    subscriptionName: subscriptionName(row.subscriptionName),
    messageId: externalId(row.messageId),
    registrationId: externalId(row.registrationId),
    collection: normalized.collection,
    externalCourseId,
    resourceId: normalized.resourceId,
    publishedAt: timestamp(row.publishedAt),
    receivedAt: timestamp(row.receivedAt),
  });
}

function feedForCollection(collection: GoogleClassroomCollection): 'COURSE_ROSTER_CHANGES' | 'COURSE_WORK_CHANGES' {
  return collection === 'courses.students' || collection === 'courses.teachers'
    ? 'COURSE_ROSTER_CHANGES'
    : 'COURSE_WORK_CHANGES';
}

function databaseInteger(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > LEARNING_LIMITS.databaseInteger) {
    invalid();
  }
  return value as number;
}

export interface AcceptedGooglePubSubDelivery {
  readonly connectionId: number;
  readonly externalCourseId: string;
  readonly accepted: boolean;
}

export async function acceptGooglePubSubDelivery(
  db: AppDb,
  rawDelivery: GooglePubSubDelivery,
): Promise<AcceptedGooglePubSubDelivery> {
  const delivery = normalizeDelivery(rawDelivery);
  const feed = feedForCollection(delivery.collection);
  try {
    const registration = await db.prepare(`SELECT r.connection_id AS connection_id,
      r.external_course_id AS external_course_id
      FROM learning_google_registrations r
      JOIN learning_provider_connections c ON c.id=r.connection_id
      WHERE r.registration_id=?1 AND r.external_course_id=?2 AND r.feed_type=?3
        AND r.expiry_time>?4 AND c.provider='google_classroom' AND c.status='active'
        AND c.deleted_at IS NULL LIMIT 1`)
      .bind(delivery.registrationId, delivery.externalCourseId, feed, delivery.receivedAt)
      .first<Record<string, unknown>>();
    const safeRegistration = registration ?? invalid();
    const connectionId = databaseInteger(safeRegistration.connection_id);
    if (externalId(safeRegistration.external_course_id) !== delivery.externalCourseId) invalid();
    const result = await db.prepare(`INSERT INTO learning_google_notification_receipts
      (subscription_name,message_id,registration_id,external_course_id,collection_name,received_at)
      VALUES(?1,?2,?3,?4,?5,?6)
      ON CONFLICT(subscription_name,message_id) DO NOTHING`)
      .bind(
        delivery.subscriptionName, delivery.messageId, delivery.registrationId,
        delivery.externalCourseId, delivery.collection, delivery.receivedAt,
      ).run();
    const changes = result?.meta?.changes;
    if (changes === 1) return Object.freeze({ connectionId, externalCourseId: delivery.externalCourseId, accepted: true });
    if (changes !== 0) invalid();
    const receipt = await db.prepare(`SELECT registration_id,external_course_id,collection_name
      FROM learning_google_notification_receipts
      WHERE subscription_name=?1 AND message_id=?2 LIMIT 1`)
      .bind(delivery.subscriptionName, delivery.messageId)
      .first<Record<string, unknown>>();
    if (
      receipt === null
      || receipt.registration_id !== delivery.registrationId
      || receipt.external_course_id !== delivery.externalCourseId
      || receipt.collection_name !== delivery.collection
    ) invalid();
    return Object.freeze({ connectionId, externalCourseId: delivery.externalCourseId, accepted: false });
  } catch (error) {
    if (error instanceof LearningGooglePubSubError) throw error;
    return invalid();
  }
}

export const GOOGLE_CLASSROOM_FEED_TYPES = Object.freeze([
  'COURSE_ROSTER_CHANGES', 'COURSE_WORK_CHANGES',
] as const);
export type GoogleClassroomFeedType = (typeof GOOGLE_CLASSROOM_FEED_TYPES)[number];

export interface GoogleClassroomRegistration {
  readonly externalCourseId: string;
  readonly feedType: GoogleClassroomFeedType;
  readonly registrationId: string;
  readonly topicName: string;
  readonly expiryTime: string;
}

function normalizeFeedType(value: unknown): GoogleClassroomFeedType {
  try { return learningValidation.oneOf(value, GOOGLE_CLASSROOM_FEED_TYPES); } catch { return invalid(); }
}

function normalizeRegistration(value: unknown): GoogleClassroomRegistration {
  const row = exact(value, [
    'externalCourseId', 'feedType', 'registrationId', 'topicName', 'expiryTime',
  ]);
  return Object.freeze({
    externalCourseId: externalId(row.externalCourseId),
    feedType: normalizeFeedType(row.feedType),
    registrationId: externalId(row.registrationId),
    topicName: topicName(row.topicName),
    expiryTime: timestamp(row.expiryTime),
  });
}

async function boundedResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const body = response.body ?? invalid();
  const rawLength = response.headers.get('Content-Length');
  let expectedLength: number | null = null;
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) invalid();
    expectedLength = Number(rawLength);
    if (!Number.isSafeInteger(expectedLength) || expectedLength > MAX_PUSH_BODY_BYTES) invalid();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    if (signal.aborted) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      invalid();
    }
    let part: ReadableStreamReadResult<Uint8Array>;
    try { part = await reader.read(); } catch { return invalid(); }
    if (part.done) break;
    if (!(part.value instanceof Uint8Array)) invalid();
    length += part.value.byteLength;
    if (length > MAX_PUSH_BODY_BYTES) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      invalid();
    }
    chunks.push(part.value);
  }
  if (expectedLength !== null && expectedLength !== length) invalid();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch { return invalid(); }
}

type GoogleRegistrationFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function registrationFetch(
  fetcher: GoogleRegistrationFetcher,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  if (url.origin !== 'https://classroom.googleapis.com' || typeof fetcher !== 'function') invalid();
  let response: Response;
  try { response = await fetcher(url, init); } catch { return invalid(); }
  if (!(response instanceof Response)) invalid();
  return response;
}

export async function createGoogleClassroomRegistration(rawInput: {
  readonly accessToken: string;
  readonly externalCourseId: string;
  readonly feedType: GoogleClassroomFeedType;
  readonly topicName: string;
  readonly fetcher: GoogleRegistrationFetcher;
  readonly signal: AbortSignal;
  readonly nowEpochMs: number;
}): Promise<GoogleClassroomRegistration> {
  const input = exact(rawInput, [
    'accessToken', 'externalCourseId', 'feedType', 'topicName', 'fetcher', 'signal', 'nowEpochMs',
  ]);
  const token = accessToken(input.accessToken);
  const courseId = externalId(input.externalCourseId);
  const feedType = normalizeFeedType(input.feedType);
  const topic = topicName(input.topicName);
  const now = epoch(input.nowEpochMs);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted) invalid();
  const signal = input.signal as AbortSignal;
  if (typeof input.fetcher !== 'function') invalid();
  const url = new URL('/v1/registrations', 'https://classroom.googleapis.com');
  url.searchParams.set('fields', 'registrationId,expiryTime');
  const feedInfo = feedType === 'COURSE_ROSTER_CHANGES'
    ? { courseRosterChangesInfo: { courseId } }
    : { courseWorkChangesInfo: { courseId } };
  const response = await registrationFetch(input.fetcher as GoogleRegistrationFetcher, url, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      feed: { feedType, ...feedInfo },
      cloudPubsubTopic: { topicName: topic },
    }),
    signal,
  });
  if (!response.ok) {
    try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
    invalid();
  }
  const row = exact(await boundedResponseJson(response, signal), ['registrationId', 'expiryTime']);
  const registration = normalizeRegistration({
    externalCourseId: courseId,
    feedType,
    registrationId: row.registrationId,
    topicName: topic,
    expiryTime: row.expiryTime,
  });
  const expiry = Date.parse(registration.expiryTime);
  if (expiry <= now || expiry > now + 8 * 24 * 60 * 60 * 1_000) invalid();
  return registration;
}

export async function deleteGoogleClassroomRegistration(rawInput: {
  readonly accessToken: string;
  readonly registrationId: string;
  readonly fetcher: GoogleRegistrationFetcher;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const input = exact(rawInput, ['accessToken', 'registrationId', 'fetcher', 'signal']);
  const token = accessToken(input.accessToken);
  const registrationId = externalId(input.registrationId);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted || typeof input.fetcher !== 'function') invalid();
  const url = new URL(
    `/v1/registrations/${encodeURIComponent(registrationId)}`,
    'https://classroom.googleapis.com',
  );
  const response = await registrationFetch(input.fetcher as GoogleRegistrationFetcher, url, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: input.signal as AbortSignal,
  });
  try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
  if (response.status === 404) return false;
  if (!response.ok) invalid();
  return true;
}

export interface StoredGoogleClassroomRegistration extends GoogleClassroomRegistration {
  readonly connectionId: number;
}

export async function listGoogleClassroomRegistrationsDue(
  db: AppDb,
  rawInput: { readonly now: string; readonly renewalHorizon: string; readonly limit: number },
): Promise<readonly StoredGoogleClassroomRegistration[]> {
  const input = exact(rawInput, ['now', 'renewalHorizon', 'limit']);
  const now = timestamp(input.now);
  const horizon = timestamp(input.renewalHorizon);
  if (horizon <= now || Date.parse(horizon) - Date.parse(now) > 7 * 24 * 60 * 60 * 1_000) invalid();
  const limit = learningValidation.integer(input.limit, 1, 100);
  try {
    const result = await db.prepare(`SELECT r.connection_id AS connection_id,
      r.external_course_id AS external_course_id,r.feed_type AS feed_type,
      r.registration_id AS registration_id,r.topic_name AS topic_name,r.expiry_time AS expiry_time
      FROM learning_google_registrations r
      JOIN learning_provider_connections c ON c.id=r.connection_id
      WHERE r.expiry_time>?1 AND r.expiry_time<=?2
        AND c.provider='google_classroom' AND c.status='active' AND c.deleted_at IS NULL
      ORDER BY r.expiry_time,r.connection_id,r.external_course_id,r.feed_type LIMIT ?3`)
      .bind(now, horizon, limit).all<Record<string, unknown>>();
    if (!result || !Array.isArray(result.results) || result.results.length > limit) invalid();
    return Object.freeze(result.results.map((row) => Object.freeze({
      connectionId: databaseInteger(row.connection_id),
      ...normalizeRegistration({
        externalCourseId: row.external_course_id,
        feedType: row.feed_type,
        registrationId: row.registration_id,
        topicName: row.topic_name,
        expiryTime: row.expiry_time,
      }),
    })));
  } catch (error) {
    if (error instanceof LearningGooglePubSubError) throw error;
    return invalid();
  }
}

export async function saveGoogleClassroomRegistration(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly expectedRegistrationId: string | null;
    readonly registration: GoogleClassroomRegistration;
    readonly now: string;
  },
): Promise<{ readonly connectionId: number; readonly registrationId: string }> {
  const input = exact(rawInput, ['connectionId', 'expectedRegistrationId', 'registration', 'now']);
  const connectionId = databaseInteger(input.connectionId);
  const expected = input.expectedRegistrationId === null ? null : externalId(input.expectedRegistrationId);
  const registration = normalizeRegistration(input.registration);
  const now = timestamp(input.now);
  if (registration.expiryTime <= now) invalid();
  try {
    const statement = expected === null
      ? db.prepare(`INSERT INTO learning_google_registrations
          (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time,updated_at)
          SELECT ?1,?2,?3,?4,?5,?6,?7
          FROM learning_courses lc JOIN learning_provider_connections c ON c.id=lc.connection_id
          WHERE lc.connection_id=?1 AND lc.external_course_id=?2 AND lc.provider='google_classroom'
            AND c.status='active' AND c.deleted_at IS NULL
          ON CONFLICT(connection_id,external_course_id,feed_type) DO NOTHING`)
        .bind(
          connectionId, registration.externalCourseId, registration.feedType, registration.registrationId,
          registration.topicName, registration.expiryTime, now,
        )
      : db.prepare(`UPDATE learning_google_registrations SET
          registration_id=?4,topic_name=?5,expiry_time=?6,updated_at=?7
          WHERE connection_id=?1 AND external_course_id=?2 AND feed_type=?3 AND registration_id=?8`)
        .bind(
          connectionId, registration.externalCourseId, registration.feedType, registration.registrationId,
          registration.topicName, registration.expiryTime, now, expected,
        );
    const result = await statement.run();
    if (result?.meta?.changes !== 1) throw new LearningGooglePubSubConflictError();
    return Object.freeze({ connectionId, registrationId: registration.registrationId });
  } catch (error) {
    if (error instanceof LearningGooglePubSubConflictError || error instanceof LearningGooglePubSubError) throw error;
    return invalid();
  }
}
