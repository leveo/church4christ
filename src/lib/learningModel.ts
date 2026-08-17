/**
 * Provider-neutral Learning records.
 *
 * All normalizers in this module use an exact-field policy: inputs must be
 * data-only plain objects and every field must be explicitly named by the
 * contract. This deliberately rejects future/unknown fields at the provider
 * boundary, including content, grade, answer, comment, rubric, file-byte,
 * credential, token, raw-body, and provider-message carriers.
 */

export const LEARNING_PROVIDERS = Object.freeze(['google_classroom', 'canvas'] as const);
export type LearningProviderKind = (typeof LEARNING_PROVIDERS)[number];

export const LEARNING_CONNECTION_STATUSES = Object.freeze(['pending', 'active', 'error', 'disabled'] as const);
export type LearningConnectionStatus = (typeof LEARNING_CONNECTION_STATUSES)[number];

export const LEARNING_IDENTITY_STATUSES = Object.freeze(['active', 'disabled', 'conflict'] as const);
export type LearningIdentityStatus = (typeof LEARNING_IDENTITY_STATUSES)[number];

export const LEARNING_COURSE_LIFECYCLE_STATES = Object.freeze(['active', 'archived', 'deleted'] as const);
export type LearningCourseLifecycleState = (typeof LEARNING_COURSE_LIFECYCLE_STATES)[number];

export const LEARNING_ENROLLMENT_ROLES = Object.freeze(['student', 'teacher', 'observer'] as const);
export type LearningEnrollmentRole = (typeof LEARNING_ENROLLMENT_ROLES)[number];

export const LEARNING_ENROLLMENT_STATES = Object.freeze(['active', 'invited', 'completed', 'inactive'] as const);
export type LearningEnrollmentState = (typeof LEARNING_ENROLLMENT_STATES)[number];

export const LEARNING_ACTIVITY_KINDS = Object.freeze(['material', 'assignment', 'quiz'] as const);
export type LearningActivityKind = (typeof LEARNING_ACTIVITY_KINDS)[number];

export const LEARNING_ACTIVITY_LIFECYCLE_STATES = Object.freeze(['draft', 'published', 'archived', 'deleted'] as const);
export type LearningActivityLifecycleState = (typeof LEARNING_ACTIVITY_LIFECYCLE_STATES)[number];

export const LEARNING_RESOURCE_KINDS = Object.freeze(['youtube', 'provider_file', 'link'] as const);
export type LearningResourceKind = (typeof LEARNING_RESOURCE_KINDS)[number];

export const LEARNING_SUBMISSION_STATES = Object.freeze(['not_submitted', 'submitted', 'returned', 'excused'] as const);
export type LearningSubmissionState = (typeof LEARNING_SUBMISSION_STATES)[number];

export const LEARNING_EVENT_TYPES = Object.freeze([
  'enrolled',
  'resource_opened',
  'assignment_submitted',
  'quiz_submitted',
  'submission_returned',
  'course_completed',
] as const);
export type LearningEventType = (typeof LEARNING_EVENT_TYPES)[number];

export const LEARNING_SYNC_TRIGGERS = Object.freeze(['manual', 'scheduled', 'notification'] as const);
export type LearningSyncTrigger = (typeof LEARNING_SYNC_TRIGGERS)[number];

export const LEARNING_SYNC_STATUSES = Object.freeze(['running', 'succeeded', 'failed', 'cancelled'] as const);
export type LearningSyncStatus = (typeof LEARNING_SYNC_STATUSES)[number];

export const LEARNING_ERROR_CODES = Object.freeze([
  'invalid_request',
  'authentication_required',
  'permission_denied',
  'not_found',
  'rate_limited',
  'provider_unavailable',
  'malformed_response',
  'response_too_large',
  'pagination_limit',
  'conflict',
  'timeout',
  'cancelled',
  'internal_error',
] as const);
export type LearningErrorCode = (typeof LEARNING_ERROR_CODES)[number];

export const LEARNING_LIMITS = Object.freeze({
  databaseInteger: 2_147_483_647,
  connectionDisplayNameBytes: 120,
  courseDisplayNameBytes: 200,
  titleBytes: 300,
  externalIdBytes: 255,
  urlBytes: 2_048,
  mimeTypeBytes: 127,
  errorCodeBytes: 64,
  paginationTokenBytes: 1_024,
  maxPageItems: 100,
  maxPages: 100,
  maxPageBytes: 1_048_576,
  maxItemBytes: 65_536,
  maxSyncItems: 100_000,
  maxSyncBytes: 10_485_760,
  maxRetryAfterSeconds: 86_400,
  maxSubmissionAttempts: 1_000,
  maxSyncAttempts: 10,
} as const);

export type LearningIntegerBoolean = 0 | 1;

export interface LearningUrlPolicy {
  readonly allowedOrigins: readonly string[];
  readonly allowLocalDevelopmentHttp?: boolean;
}

export interface LearningProviderSubject {
  readonly connectionId: number;
  readonly provider: LearningProviderKind;
}

export interface LearningCourseSubject extends LearningProviderSubject {
  readonly externalCourseId: string;
}

export interface LearningIdentitySubject extends LearningProviderSubject {
  readonly externalUserId: string;
}

export interface LearningActivitySubject extends LearningCourseSubject {
  readonly externalActivityId: string;
}

export interface LearningConnection extends LearningProviderSubject {
  readonly displayName: string;
  readonly baseUrl: string | null;
  readonly status: LearningConnectionStatus;
  readonly revision: number;
  readonly lastSuccessfulSyncAt: string | null;
  readonly lastErrorCode: LearningErrorCode | null;
}

export interface LearningCourse extends LearningCourseSubject {
  readonly displayName: string;
  readonly launchUrl: string;
  readonly lifecycleState: LearningCourseLifecycleState;
  readonly providerUpdatedAt: string | null;
  readonly lastSyncedAt: string | null;
}

export interface LearningIdentity extends LearningIdentitySubject {
  readonly personId: number;
  readonly status: LearningIdentityStatus;
}

export interface LearningEnrollment extends LearningCourseSubject, LearningIdentitySubject {
  readonly personId: number;
  readonly externalEnrollmentId: string;
  readonly role: LearningEnrollmentRole;
  readonly state: LearningEnrollmentState;
  readonly lastSyncedAt: string | null;
}

export interface LearningActivity extends LearningActivitySubject {
  readonly title: string;
  readonly kind: LearningActivityKind;
  readonly lifecycleState: LearningActivityLifecycleState;
  readonly launchUrl: string;
  readonly dueAt: string | null;
  readonly publishedAt: string | null;
  readonly providerUpdatedAt: string | null;
  readonly lastSyncedAt: string | null;
}

export interface LearningResource extends LearningActivitySubject {
  readonly externalResourceId: string;
  readonly title: string;
  readonly kind: LearningResourceKind;
  readonly launchUrl: string;
  readonly youtubeVideoId: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly providerUpdatedAt: string | null;
}

export interface LearningSubmissionSnapshot extends LearningActivitySubject, LearningIdentitySubject {
  readonly activityKind: 'assignment' | 'quiz';
  readonly personId: number;
  readonly externalEnrollmentId: string;
  readonly status: LearningSubmissionState;
  readonly late: LearningIntegerBoolean;
  readonly attemptNumber: number;
  readonly submittedAt: string | null;
  readonly returnedAt: string | null;
  readonly providerUpdatedAt: string | null;
  readonly syncedAt: string;
}

export interface LearningActivityEvent extends LearningProviderSubject {
  readonly id: string;
  readonly sourceEventId: string;
  readonly eventType: LearningEventType;
  readonly personId: number;
  readonly identityLinkId: number;
  readonly enrollmentId: number;
  readonly courseId: number;
  readonly activityId: number | null;
  readonly activityKind: LearningActivityKind | null;
  readonly occurredAt: string;
  readonly ingestedAt: string;
}

export interface NormalizedYouTube {
  readonly videoId: string;
  readonly embedUrl: string;
}

export interface LearningProviderErrorMetadata {
  readonly code: LearningErrorCode;
  readonly provider: LearningProviderKind;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;
}

export class LearningValidationError extends Error {
  readonly code = 'learning_invalid_input' as const;

  constructor() {
    super('Learning input is invalid');
    this.name = 'LearningValidationError';
  }
}

export class LearningProviderError extends Error implements LearningProviderErrorMetadata {
  readonly code: LearningErrorCode;
  readonly provider: LearningProviderKind;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(input: unknown) {
    const metadata = normalizeLearningProviderErrorMetadata(input);
    super(`Learning provider request failed: ${metadata.code}`);
    this.name = 'LearningProviderError';
    this.code = metadata.code;
    this.provider = metadata.provider;
    this.httpStatus = metadata.httpStatus;
    this.retryAfterSeconds = metadata.retryAfterSeconds;
    Object.freeze(this);
  }
}

const utf8 = new TextEncoder();
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/u;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;
const INVALID_PERCENT_RE = /%(?![0-9a-f]{2})/iu;
const AMBIGUOUS_PERCENT_RE = /%(?:0[0-9a-f]|1[0-9a-f]|7f|2e|2f|5c|23|3f|40)/iu;

function invalid(): never {
  throw new LearningValidationError();
}

function dataRecord(value: unknown): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') invalid();
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) invalid();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return invalid();
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = dataRecord(value);
  const actual = Object.keys(row);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
  return row;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid();
  return value as T;
}

function integer(value: unknown, minimum: number, maximum: number = LEARNING_LIMITS.databaseInteger): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}

function nullableInteger(value: unknown, minimum: number, maximum: number = LEARNING_LIMITS.databaseInteger): number | null {
  return value === null ? null : integer(value, minimum, maximum);
}

function boundedString(value: unknown, minimumBytes: number, maximumBytes: number, trim = true): string {
  if (typeof value !== 'string') invalid();
  if (CONTROL_RE.test(value)) invalid();
  const normalized = trim ? value.trim() : value;
  const length = utf8.encode(normalized).byteLength;
  if (length < minimumBytes || length > maximumBytes) invalid();
  return normalized;
}

function externalId(value: unknown): string {
  return boundedString(value, 1, LEARNING_LIMITS.externalIdBytes);
}

function nullableBoundedString(value: unknown, maximumBytes: number): string | null {
  return value === null ? null : boundedString(value, 1, maximumBytes);
}

function timestamp(value: unknown): string {
  const source = boundedString(value, 19, 40, false);
  const match = TIMESTAMP_RE.exec(source);
  if (!match) invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const calendarProbe = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarProbe.getUTCFullYear() !== year
    || calendarProbe.getUTCMonth() !== month - 1
    || calendarProbe.getUTCDate() !== day
    || hour > 23
    || minute > 59
    || second > 59
  ) invalid();
  if (match[7] !== 'Z') {
    const offsetHour = Number(match[7].slice(1, 3));
    const offsetMinute = Number(match[7].slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) invalid();
  }
  const milliseconds = Date.parse(source);
  if (!Number.isFinite(milliseconds)) invalid();
  return new Date(milliseconds).toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function parsedUrl(value: unknown): { raw: string; url: URL } {
  const raw = boundedString(value, 9, LEARNING_LIMITS.urlBytes, false);
  if (
    raw !== raw.trim()
    || raw.includes('\\')
    || raw.includes('#')
    || INVALID_PERCENT_RE.test(raw)
    || AMBIGUOUS_PERCENT_RE.test(raw)
  ) invalid();
  let url: URL;
  try {
    url = new URL(raw);
    decodeURIComponent(`${url.pathname}${url.search}`);
  } catch {
    invalid();
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
  ) invalid();
  return { raw, url };
}

function originSuffix(raw: string): string {
  const authorityStart = raw.indexOf('://') + 3;
  if (authorityStart < 3) invalid();
  const slash = raw.indexOf('/', authorityStart);
  const query = raw.indexOf('?', authorityStart);
  const indexes = [slash, query].filter((index) => index >= 0);
  const suffixStart = indexes.length === 0 ? raw.length : Math.min(...indexes);
  return raw.slice(suffixStart);
}

function allowedOrigins(policy: LearningUrlPolicy): ReadonlySet<string> {
  if (
    policy === null
    || typeof policy !== 'object'
    || !Array.isArray(policy.allowedOrigins)
    || policy.allowedOrigins.length < 1
    || policy.allowedOrigins.length > 100
  ) invalid();
  const origins = new Set<string>();
  for (const candidate of policy.allowedOrigins) {
    const { raw, url } = parsedUrl(candidate);
    if (url.pathname !== '/' || url.search !== '' || !['', '/'].includes(originSuffix(raw))) invalid();
    if (url.protocol === 'http:' && (!policy.allowLocalDevelopmentHttp || !isLocalHostname(url.hostname))) invalid();
    origins.add(url.origin);
  }
  return origins;
}

export function normalizeLearningLaunchUrl(value: unknown, policy: LearningUrlPolicy): string {
  const { url } = parsedUrl(value);
  if (url.protocol === 'http:' && (!policy.allowLocalDevelopmentHttp || !isLocalHostname(url.hostname))) invalid();
  if (!allowedOrigins(policy).has(url.origin)) invalid();
  const normalized = url.toString();
  if (utf8.encode(normalized).byteLength > LEARNING_LIMITS.urlBytes) invalid();
  return normalized;
}

export function normalizeCanvasBaseUrl(value: unknown, policy: LearningUrlPolicy): string {
  const { raw, url } = parsedUrl(value);
  if (url.pathname !== '/' || url.search !== '' || !['', '/'].includes(originSuffix(raw))) invalid();
  if (url.protocol === 'http:' && (!policy.allowLocalDevelopmentHttp || !isLocalHostname(url.hostname))) invalid();
  if (!allowedOrigins(policy).has(url.origin)) invalid();
  return url.origin;
}

function youtubeId(value: unknown): string {
  const id = boundedString(value, 11, 11);
  if (!YOUTUBE_ID_RE.test(id)) invalid();
  return id;
}

export function normalizeYouTube(value: unknown): NormalizedYouTube {
  if (typeof value !== 'string') invalid();
  const source = value.trim();
  let videoId: string;
  if (YOUTUBE_ID_RE.test(source)) {
    videoId = source;
  } else {
    const { url } = parsedUrl(source);
    if (url.protocol !== 'https:' || url.port !== '') invalid();
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 1 || url.pathname !== `/${parts[0]}` || url.searchParams.has('v')) invalid();
      videoId = youtubeId(parts[0]);
    } else if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
      if (url.pathname === '/watch') {
        const candidates = url.searchParams.getAll('v');
        if (candidates.length !== 1) invalid();
        videoId = youtubeId(candidates[0]);
      } else {
        const match = /^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})$/u.exec(url.pathname);
        if (!match || url.searchParams.has('v')) invalid();
        videoId = match[1];
      }
    } else {
      invalid();
    }
  }
  return frozen({
    videoId,
    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
  });
}

export function normalizeLearningConnection(value: unknown, policy: LearningUrlPolicy): LearningConnection {
  const row = exactRecord(value, [
    'connectionId', 'provider', 'displayName', 'baseUrl', 'status', 'revision',
    'lastSuccessfulSyncAt', 'lastErrorCode',
  ]);
  const provider = oneOf(row.provider, LEARNING_PROVIDERS);
  const baseUrl = provider === 'canvas'
    ? normalizeCanvasBaseUrl(row.baseUrl, policy)
    : row.baseUrl === null ? null : invalid();
  return frozen({
    connectionId: integer(row.connectionId, 1),
    provider,
    displayName: boundedString(row.displayName, 1, LEARNING_LIMITS.connectionDisplayNameBytes),
    baseUrl,
    status: oneOf(row.status, LEARNING_CONNECTION_STATUSES),
    revision: integer(row.revision, 0),
    lastSuccessfulSyncAt: nullableTimestamp(row.lastSuccessfulSyncAt),
    lastErrorCode: row.lastErrorCode === null ? null : oneOf(row.lastErrorCode, LEARNING_ERROR_CODES),
  });
}

export function normalizeLearningCourse(value: unknown, policy: LearningUrlPolicy): LearningCourse {
  const row = exactRecord(value, [
    'connectionId', 'provider', 'externalCourseId', 'displayName', 'launchUrl',
    'lifecycleState', 'providerUpdatedAt', 'lastSyncedAt',
  ]);
  return frozen({
    connectionId: integer(row.connectionId, 1),
    provider: oneOf(row.provider, LEARNING_PROVIDERS),
    externalCourseId: externalId(row.externalCourseId),
    displayName: boundedString(row.displayName, 1, LEARNING_LIMITS.courseDisplayNameBytes),
    launchUrl: normalizeLearningLaunchUrl(row.launchUrl, policy),
    lifecycleState: oneOf(row.lifecycleState, LEARNING_COURSE_LIFECYCLE_STATES),
    providerUpdatedAt: nullableTimestamp(row.providerUpdatedAt),
    lastSyncedAt: nullableTimestamp(row.lastSyncedAt),
  });
}

export function normalizeLearningIdentity(value: unknown): LearningIdentity {
  const row = exactRecord(value, ['connectionId', 'provider', 'personId', 'externalUserId', 'status']);
  return frozen({
    connectionId: integer(row.connectionId, 1),
    provider: oneOf(row.provider, LEARNING_PROVIDERS),
    personId: integer(row.personId, 1),
    externalUserId: externalId(row.externalUserId),
    status: oneOf(row.status, LEARNING_IDENTITY_STATUSES),
  });
}

export function normalizeLearningEnrollment(value: unknown): LearningEnrollment {
  const row = exactRecord(value, [
    'connectionId', 'provider', 'externalCourseId', 'personId', 'externalUserId',
    'externalEnrollmentId', 'role', 'state', 'lastSyncedAt',
  ]);
  return frozen({
    connectionId: integer(row.connectionId, 1),
    provider: oneOf(row.provider, LEARNING_PROVIDERS),
    externalCourseId: externalId(row.externalCourseId),
    personId: integer(row.personId, 1),
    externalUserId: externalId(row.externalUserId),
    externalEnrollmentId: externalId(row.externalEnrollmentId),
    role: oneOf(row.role, LEARNING_ENROLLMENT_ROLES),
    state: oneOf(row.state, LEARNING_ENROLLMENT_STATES),
    lastSyncedAt: nullableTimestamp(row.lastSyncedAt),
  });
}

export function normalizeLearningActivity(value: unknown, policy: LearningUrlPolicy): LearningActivity {
  const row = exactRecord(value, [
    'connectionId', 'provider', 'externalCourseId', 'externalActivityId', 'title',
    'kind', 'lifecycleState', 'launchUrl', 'dueAt', 'publishedAt',
    'providerUpdatedAt', 'lastSyncedAt',
  ]);
  return frozen({
    connectionId: integer(row.connectionId, 1),
    provider: oneOf(row.provider, LEARNING_PROVIDERS),
    externalCourseId: externalId(row.externalCourseId),
    externalActivityId: externalId(row.externalActivityId),
    title: boundedString(row.title, 1, LEARNING_LIMITS.titleBytes),
    kind: oneOf(row.kind, LEARNING_ACTIVITY_KINDS),
    lifecycleState: oneOf(row.lifecycleState, LEARNING_ACTIVITY_LIFECYCLE_STATES),
    launchUrl: normalizeLearningLaunchUrl(row.launchUrl, policy),
    dueAt: nullableTimestamp(row.dueAt),
    publishedAt: nullableTimestamp(row.publishedAt),
    providerUpdatedAt: nullableTimestamp(row.providerUpdatedAt),
    lastSyncedAt: nullableTimestamp(row.lastSyncedAt),
  });
}

export function normalizeLearningResource(value: unknown, policy: LearningUrlPolicy): LearningResource {
  const row = exactRecord(value, [
    'connectionId', 'provider', 'externalCourseId', 'externalActivityId', 'externalResourceId',
    'title', 'kind', 'launchUrl', 'youtubeVideoId', 'mimeType', 'sizeBytes', 'providerUpdatedAt',
  ]);
  const kind = oneOf(row.kind, LEARNING_RESOURCE_KINDS);
  const launchUrl = normalizeLearningLaunchUrl(row.launchUrl, policy);
  let youtubeVideoId: string | null;
  let mimeType: string | null;
  let sizeBytes: number | null;
  if (kind === 'youtube') {
    youtubeVideoId = youtubeId(row.youtubeVideoId);
    if (normalizeYouTube(launchUrl).videoId !== youtubeVideoId || row.mimeType !== null || row.sizeBytes !== null) invalid();
    mimeType = null;
    sizeBytes = null;
  } else if (kind === 'provider_file') {
    if (row.youtubeVideoId !== null) invalid();
    youtubeVideoId = null;
    mimeType = nullableBoundedString(row.mimeType, LEARNING_LIMITS.mimeTypeBytes);
    sizeBytes = nullableInteger(row.sizeBytes, 0);
  } else {
    if (row.youtubeVideoId !== null || row.mimeType !== null || row.sizeBytes !== null) invalid();
    youtubeVideoId = null;
    mimeType = null;
    sizeBytes = null;
  }
  return frozen({
    connectionId: integer(row.connectionId, 1),
    provider: oneOf(row.provider, LEARNING_PROVIDERS),
    externalCourseId: externalId(row.externalCourseId),
    externalActivityId: externalId(row.externalActivityId),
    externalResourceId: externalId(row.externalResourceId),
    title: boundedString(row.title, 1, LEARNING_LIMITS.titleBytes),
    kind,
    launchUrl,
    youtubeVideoId,
    mimeType,
    sizeBytes,
    providerUpdatedAt: nullableTimestamp(row.providerUpdatedAt),
  });
}

export function normalizeLearningSubmissionSnapshot(value: unknown): LearningSubmissionSnapshot {
  const row = exactRecord(value, [
    'connectionId', 'provider', 'externalCourseId', 'externalActivityId', 'activityKind',
    'personId', 'externalUserId', 'externalEnrollmentId', 'status', 'late',
    'attemptNumber', 'submittedAt', 'returnedAt', 'providerUpdatedAt', 'syncedAt',
  ]);
  const activityKind = oneOf(row.activityKind, ['assignment', 'quiz'] as const);
  const status = oneOf(row.status, LEARNING_SUBMISSION_STATES);
  const submittedAt = nullableTimestamp(row.submittedAt);
  const returnedAt = nullableTimestamp(row.returnedAt);
  if (status === 'not_submitted' && (submittedAt !== null || returnedAt !== null)) invalid();
  if ((status === 'submitted' || status === 'returned') && submittedAt === null) invalid();
  if (status === 'returned' && returnedAt === null) invalid();
  if (returnedAt !== null && submittedAt === null) invalid();
  const late = integer(row.late, 0, 1) as LearningIntegerBoolean;
  return frozen({
    connectionId: integer(row.connectionId, 1),
    provider: oneOf(row.provider, LEARNING_PROVIDERS),
    externalCourseId: externalId(row.externalCourseId),
    externalActivityId: externalId(row.externalActivityId),
    activityKind,
    personId: integer(row.personId, 1),
    externalUserId: externalId(row.externalUserId),
    externalEnrollmentId: externalId(row.externalEnrollmentId),
    status,
    late,
    attemptNumber: integer(row.attemptNumber, 0, LEARNING_LIMITS.maxSubmissionAttempts),
    submittedAt,
    returnedAt,
    providerUpdatedAt: nullableTimestamp(row.providerUpdatedAt),
    syncedAt: timestamp(row.syncedAt),
  });
}

export function normalizeLearningActivityEvent(value: unknown): LearningActivityEvent {
  const row = exactRecord(value, [
    'id', 'connectionId', 'provider', 'sourceEventId', 'eventType', 'personId',
    'identityLinkId', 'enrollmentId', 'courseId', 'activityId', 'activityKind',
    'occurredAt', 'ingestedAt',
  ]);
  const eventType = oneOf(row.eventType, LEARNING_EVENT_TYPES);
  const activityId = nullableInteger(row.activityId, 1);
  const activityKind = row.activityKind === null ? null : oneOf(row.activityKind, LEARNING_ACTIVITY_KINDS);
  const isCourseEvent = eventType === 'enrolled' || eventType === 'course_completed';
  const referencesAnyActivity = activityId !== null && activityKind !== null;
  if (
    (isCourseEvent && (activityId !== null || activityKind !== null))
    || (!isCourseEvent && !referencesAnyActivity)
    || (eventType === 'assignment_submitted' && activityKind !== 'assignment')
    || (eventType === 'quiz_submitted' && activityKind !== 'quiz')
    || (eventType === 'submission_returned' && activityKind !== 'assignment' && activityKind !== 'quiz')
  ) invalid();
  return frozen({
    id: externalId(row.id),
    connectionId: integer(row.connectionId, 1),
    provider: oneOf(row.provider, LEARNING_PROVIDERS),
    sourceEventId: externalId(row.sourceEventId),
    eventType,
    personId: integer(row.personId, 1),
    identityLinkId: integer(row.identityLinkId, 1),
    enrollmentId: integer(row.enrollmentId, 1),
    courseId: integer(row.courseId, 1),
    activityId,
    activityKind,
    occurredAt: timestamp(row.occurredAt),
    ingestedAt: timestamp(row.ingestedAt),
  });
}

export function learningProviderSubjectKey(subject: LearningProviderSubject): string {
  return JSON.stringify([subject.provider, subject.connectionId]);
}

export function learningCourseSubjectKey(subject: LearningCourseSubject): string {
  return JSON.stringify([subject.provider, subject.connectionId, subject.externalCourseId]);
}

export function learningIdentitySubjectKey(subject: LearningIdentitySubject): string {
  return JSON.stringify([subject.provider, subject.connectionId, subject.externalUserId]);
}

export function learningActivitySubjectKey(subject: LearningActivitySubject): string {
  return JSON.stringify([
    subject.provider,
    subject.connectionId,
    subject.externalCourseId,
    subject.externalActivityId,
  ]);
}

export function learningActivityEventDeduplicationKey(event: LearningActivityEvent): string {
  return JSON.stringify([event.provider, event.connectionId, event.sourceEventId]);
}

export function normalizeLearningProviderErrorMetadata(value: unknown): LearningProviderErrorMetadata {
  const row = exactRecord(value, ['code', 'provider', 'httpStatus', 'retryAfterSeconds']);
  return frozen({
    code: oneOf(row.code, LEARNING_ERROR_CODES),
    provider: oneOf(row.provider, LEARNING_PROVIDERS),
    httpStatus: nullableInteger(row.httpStatus, 400, 599),
    retryAfterSeconds: nullableInteger(row.retryAfterSeconds, 0, LEARNING_LIMITS.maxRetryAfterSeconds),
  });
}

/** Internal helpers shared by the dependency-light provider contract module. */
export const learningValidation = Object.freeze({
  dataRecord,
  exactRecord,
  oneOf,
  integer,
  externalId,
  timestamp,
  nullableTimestamp,
  boundedString,
  invalid,
  utf8Bytes(value: string): number {
    return utf8.encode(value).byteLength;
  },
});
