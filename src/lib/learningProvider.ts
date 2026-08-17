import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  LEARNING_PROVIDERS,
  LEARNING_SYNC_STATUSES,
  LEARNING_SYNC_TRIGGERS,
  LearningProviderError,
  learningValidation,
  normalizeLearningActivity,
  normalizeLearningCourse,
  normalizeLearningLaunchContract,
  normalizeLearningProviderEnrollment,
  normalizeLearningProviderErrorMetadata,
  normalizeLearningResource,
  normalizeLearningSubmissionSnapshot,
  type LearningActivity,
  type LearningActivitySubject,
  type LearningCourse,
  type LearningCourseSubject,
  type LearningConnectionUrlPolicy,
  type LearningErrorCode,
  type LearningIntegerBoolean,
  type LearningLaunchContract,
  type LearningProviderErrorMetadata,
  type LearningProviderEnrollment,
  type LearningProviderKind,
  type LearningProviderSubject,
  type LearningResource,
  type LearningSubmissionSnapshot,
  type LearningSyncStatus,
  type LearningSyncTrigger,
} from './learningModel';

const MEASURED_PAYLOAD_BRAND: unique symbol = Symbol('LearningMeasuredPayload');
const NORMALIZED_PAGE_BRAND: unique symbol = Symbol('LearningProviderPage');

export interface LearningPageRequest {
  readonly pageSize: number;
  readonly pageNumber: number;
  readonly pageToken: string | null;
}

export interface LearningProviderPage<T extends object> {
  readonly [NORMALIZED_PAGE_BRAND]: true;
  readonly items: readonly T[];
  readonly requestPageToken: string | null;
  readonly nextPageToken: string | null;
  readonly pageNumber: number;
  readonly responseBytes: number;
}

/** Created only by readLearningJsonResponse after actual streamed bytes are counted. */
export interface LearningMeasuredPayload {
  readonly [MEASURED_PAYLOAD_BRAND]: true;
  readonly payload: unknown;
  readonly byteCount: number;
}

export interface LearningPageContract<T extends object> {
  readonly normalizeItem: (value: unknown) => T;
  readonly subjectKey: (value: T) => string;
}

export interface LearningPageScope extends LearningProviderSubject {
  readonly externalCourseId: string | null;
  readonly externalActivityId: string | null;
  readonly externalEnrollmentId: string | null;
}

export interface LearningOperationContext {
  readonly scope: LearningPageScope;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly maxPages: number;
  readonly maxItems: number;
  readonly maxRawBytes: number;
  readonly maxNormalizedBytes: number;
  readonly maxUniqueKeyBytes: number;
  readonly signal: AbortSignal;
}

export interface LearningPageAccumulatorView<T extends object> {
  readonly scope: LearningPageScope;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly maxPages: number;
  readonly maxItems: number;
  readonly maxRawBytes: number;
  readonly maxNormalizedBytes: number;
  readonly maxUniqueKeyBytes: number;
  readonly pageCount: number;
  readonly itemCount: number;
  readonly rawResponseBytes: number;
  readonly normalizedItemBytes: number;
  readonly uniquenessKeyBytes: number;
  readonly expectedPageToken: string | null;
  readonly seenPageTokens: readonly string[];
  readonly seenUniquenessKeys: readonly string[];
  readonly items: readonly T[];
  readonly complete: LearningIntegerBoolean;
}

export interface LearningPageAccumulator<T extends object> {
  readonly view: LearningPageAccumulatorView<T>;
  accept(payload: LearningMeasuredPayload, currentTimeEpochMs: number): LearningPageAccumulator<T>;
}

export interface LearningPageSequenceContract<T extends object> {
  readonly normalizeItem: (value: unknown) => T;
  readonly uniquenessKeys: (value: T) => readonly string[];
}

export const LEARNING_MAX_OPERATION_DURATION_MS = 3_600_000;

export interface LearningHealthRequest {
  readonly subject: LearningProviderSubject;
  readonly operation: LearningOperationContext;
}

export interface LearningListCoursesRequest extends LearningHealthRequest {
  readonly page: LearningPageRequest;
}

export interface LearningSyncCourseRequest {
  readonly subject: LearningCourseSubject;
  readonly operation: LearningOperationContext;
}

export interface LearningSyncEnrollmentsRequest extends LearningSyncCourseRequest {
  readonly page: LearningPageRequest;
}

export interface LearningSyncActivitiesRequest extends LearningSyncCourseRequest {
  readonly page: LearningPageRequest;
}

export interface LearningSyncResourcesRequest {
  readonly subject: LearningActivitySubject;
  readonly page: LearningPageRequest;
  readonly operation: LearningOperationContext;
}

export interface LearningSubmissionReadSubject extends LearningActivitySubject {
  readonly externalEnrollmentId: string | null;
}

export interface LearningSyncSubmissionsRequest {
  readonly subject: LearningSubmissionReadSubject;
  readonly page: LearningPageRequest;
  readonly operation: LearningOperationContext;
}

export interface LearningBuildLaunchRequest {
  readonly subject: LearningCourseSubject | LearningActivitySubject;
  readonly operation: LearningOperationContext;
}

export interface LearningSyncResult extends LearningProviderSubject {
  readonly externalCourseId: string | null;
  readonly trigger: LearningSyncTrigger;
  readonly status: LearningSyncStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly attemptCount: number;
  readonly pageCount: number;
  readonly scannedCount: number;
  readonly changedCount: number;
  readonly removedCount: number;
  readonly eventCount: number;
  readonly responseBytes: number;
  readonly errorCode: LearningErrorCode | null;
}

export interface LearningProviderHealth extends LearningProviderSubject {
  readonly healthy: LearningIntegerBoolean;
  readonly checkedAt: string;
  readonly errorCode: LearningErrorCode | null;
}

export interface LearningProviderNotification extends LearningProviderSubject {
  readonly sourceEventId: string;
  readonly externalCourseId: string | null;
  readonly receivedAt: string;
}

/**
 * Narrow provider adapter boundary. Implementations are supplied in later
 * slices; every page and result returned here must first pass the exported
 * normalizers and the explicit LEARNING_LIMITS budgets.
 */
export interface LearningProvider {
  readonly provider: LearningProviderKind;
  healthCheck(request: LearningHealthRequest): Promise<LearningProviderHealth>;
  listCourses(request: LearningListCoursesRequest): Promise<LearningMeasuredPayload>;
  syncCourse(request: LearningSyncCourseRequest): Promise<LearningCourse>;
  syncEnrollments(request: LearningSyncEnrollmentsRequest): Promise<LearningMeasuredPayload>;
  syncActivities(request: LearningSyncActivitiesRequest): Promise<LearningMeasuredPayload>;
  syncResources(request: LearningSyncResourcesRequest): Promise<LearningMeasuredPayload>;
  syncSubmissions(request: LearningSyncSubmissionsRequest): Promise<LearningMeasuredPayload>;
  buildLaunchUrl(request: LearningBuildLaunchRequest): Promise<LearningLaunchContract>;
  normalizeNotification(input: unknown): Promise<LearningProviderNotification | null>;
}

function token(value: unknown): string | null {
  if (value === null) return null;
  return learningValidation.boundedString(value, 1, LEARNING_LIMITS.paginationTokenBytes);
}

export function normalizeLearningPageRequest(value: unknown): LearningPageRequest {
  const row = learningValidation.exactRecord(value, ['pageSize', 'pageNumber', 'pageToken']);
  return Object.freeze({
    pageSize: learningValidation.integer(row.pageSize, 1, LEARNING_LIMITS.maxPageItems),
    pageNumber: learningValidation.integer(row.pageNumber, 1, LEARNING_LIMITS.maxPages),
    pageToken: token(row.pageToken),
  });
}

interface CloneState {
  readonly active: WeakSet<object>;
  nodes: number;
}

function cloneAndFreezeInternal(
  value: unknown,
  state: CloneState = { active: new WeakSet<object>(), nodes: 0 },
  depth = 0,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) learningValidation.invalid();
    return value;
  }
  if (typeof value !== 'object' || depth > 16 || state.nodes >= 10_000) {
    learningValidation.invalid();
  }
  const objectValue = value as object;
  if (state.active.has(objectValue)) learningValidation.invalid();
  state.nodes += 1;
  state.active.add(objectValue);
  try {
    if (Array.isArray(value)) {
      const source = learningValidation.dataArray(value, 10_000);
      const clone: unknown[] = [];
      for (let index = 0; index < source.length; index += 1) {
        clone[index] = cloneAndFreezeInternal(source[index], state, depth + 1);
      }
      return Object.freeze(clone);
    }
    const row = learningValidation.dataRecord(value);
    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(row).sort()) clone[key] = cloneAndFreezeInternal(row[key], state, depth + 1);
    return Object.freeze(clone);
  } finally {
    state.active.delete(objectValue);
  }
}

function cloneAndFreeze(value: unknown): unknown {
  try {
    return cloneAndFreezeInternal(value);
  } catch {
    return learningValidation.invalid();
  }
}

function canonicalJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') learningValidation.invalid();
    return json;
  } catch {
    return learningValidation.invalid();
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function contractCallbacks(
  value: unknown,
  keys: readonly string[],
): Record<string, (...args: never[]) => unknown> {
  try {
    const row = learningValidation.exactRecord(value, keys);
    const result: Record<string, (...args: never[]) => unknown> = Object.create(null) as Record<
      string,
      (...args: never[]) => unknown
    >;
    for (let index = 0; index < keys.length; index += 1) {
      const callback = row[keys[index]];
      if (typeof callback !== 'function') learningValidation.invalid();
      result[keys[index]] = callback as (...args: never[]) => unknown;
    }
    return result;
  } catch {
    return learningValidation.invalid();
  }
}

function measuredPayload(value: unknown): LearningMeasuredPayload {
  try {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      learningValidation.invalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 3
      || !keys.includes(MEASURED_PAYLOAD_BRAND)
      || !keys.includes('payload')
      || !keys.includes('byteCount')
      || descriptors[MEASURED_PAYLOAD_BRAND]?.value !== true
      || !descriptors.payload
      || !('value' in descriptors.payload)
      || !descriptors.byteCount
      || !('value' in descriptors.byteCount)
      || !Object.isFrozen(value)
    ) learningValidation.invalid();
    learningValidation.integer(descriptors.byteCount.value, 0, LEARNING_LIMITS.maxSyncBytes);
    return value as LearningMeasuredPayload;
  } catch {
    return learningValidation.invalid();
  }
}

function brandedPage<T extends object>(value: Omit<LearningProviderPage<T>, typeof NORMALIZED_PAGE_BRAND>): LearningProviderPage<T> {
  const result = { ...value } as LearningProviderPage<T>;
  Object.defineProperty(result, NORMALIZED_PAGE_BRAND, { value: true });
  return Object.freeze(result);
}

export function normalizeLearningPage<T extends object>(
  value: unknown,
  contract: LearningPageContract<T>,
): LearningProviderPage<T> {
  const callbacks = contractCallbacks(contract, ['normalizeItem', 'subjectKey']);
  const measured = measuredPayload(value);
  const row = learningValidation.exactRecord(measured.payload, [
    'items', 'requestPageToken', 'nextPageToken', 'pageNumber',
  ]);
  const itemInputs = learningValidation.dataArray(row.items, LEARNING_LIMITS.maxPageItems);
  const pageNumber = learningValidation.integer(row.pageNumber, 1, LEARNING_LIMITS.maxPages);
  const responseBytes = learningValidation.integer(measured.byteCount, 0, LEARNING_LIMITS.maxPageBytes);
  const byKey = new Map<string, { item: T; json: string }>();
  for (let index = 0; index < itemInputs.length; index += 1) {
    const rawItem = itemInputs[index];
    const normalized = (() => {
      try {
        return callbacks.normalizeItem(rawItem as never) as T;
      } catch {
        return learningValidation.invalid();
      }
    })();
    const immutable = cloneAndFreeze(learningValidation.dataRecord(normalized)) as T;
    const itemJson = canonicalJson(immutable);
    if (learningValidation.utf8Bytes(itemJson) > LEARNING_LIMITS.maxItemBytes) learningValidation.invalid();
    let subjectKey = (() => {
      try {
        return callbacks.subjectKey(immutable as never) as string;
      } catch {
        return learningValidation.invalid();
      }
    })();
    subjectKey = learningValidation.boundedString(subjectKey, 1, LEARNING_LIMITS.urlBytes, false);
    const previous = byKey.get(subjectKey);
    if (previous) {
      if (previous.json !== itemJson) learningValidation.invalid();
    } else {
      byKey.set(subjectKey, { item: immutable, json: itemJson });
    }
  }
  const entries = [...byKey.entries()].sort(([left], [right]) => compareCodeUnits(left, right));
  const items = Object.freeze(entries.map(([, entry]) => entry.item));
  if (learningValidation.utf8Bytes(canonicalJson(items)) > LEARNING_LIMITS.maxPageBytes) learningValidation.invalid();
  return brandedPage({
    items,
    requestPageToken: token(row.requestPageToken),
    nextPageToken: token(row.nextPageToken),
    pageNumber,
    responseBytes,
  });
}

function nullableExternalId(value: unknown): string | null {
  return value === null ? null : learningValidation.externalId(value);
}

export function normalizeLearningPageScope(value: unknown): LearningPageScope {
  const row = learningValidation.exactRecord(value, [
    'provider', 'connectionId', 'externalCourseId', 'externalActivityId', 'externalEnrollmentId',
  ]);
  const externalCourseId = nullableExternalId(row.externalCourseId);
  const externalActivityId = nullableExternalId(row.externalActivityId);
  const externalEnrollmentId = nullableExternalId(row.externalEnrollmentId);
  if ((externalActivityId !== null || externalEnrollmentId !== null) && externalCourseId === null) {
    learningValidation.invalid();
  }
  return Object.freeze({
    provider: learningValidation.oneOf(row.provider, LEARNING_PROVIDERS),
    connectionId: learningValidation.integer(row.connectionId, 1),
    externalCourseId,
    externalActivityId,
    externalEnrollmentId,
  });
}

function abortSignal(value: unknown): AbortSignal {
  try {
    if (typeof AbortSignal === 'undefined' || !(value instanceof AbortSignal)) learningValidation.invalid();
    return value as AbortSignal;
  } catch {
    return learningValidation.invalid();
  }
}

export function normalizeLearningOperationContext(
  value: unknown,
  currentTimeEpochMs: number,
): LearningOperationContext {
  const row = learningValidation.exactRecord(value, [
    'scope', 'startedAt', 'deadlineAt', 'maxPages', 'maxItems',
    'maxRawBytes', 'maxNormalizedBytes', 'maxUniqueKeyBytes', 'signal',
  ]);
  if (!Number.isSafeInteger(currentTimeEpochMs) || currentTimeEpochMs < 0) learningValidation.invalid();
  const startedAt = learningValidation.timestamp(row.startedAt);
  const deadlineAt = learningValidation.timestamp(row.deadlineAt);
  const startedAtEpochMs = Date.parse(startedAt);
  const deadlineAtEpochMs = Date.parse(deadlineAt);
  if (
    startedAtEpochMs > currentTimeEpochMs
    || deadlineAtEpochMs <= currentTimeEpochMs
    || deadlineAtEpochMs <= startedAtEpochMs
    || deadlineAtEpochMs - startedAtEpochMs > LEARNING_MAX_OPERATION_DURATION_MS
  ) learningValidation.invalid();
  return Object.freeze({
    scope: normalizeLearningPageScope(row.scope),
    startedAt,
    deadlineAt,
    maxPages: learningValidation.integer(row.maxPages, 1, LEARNING_LIMITS.maxPages),
    maxItems: learningValidation.integer(row.maxItems, 1, LEARNING_LIMITS.maxSyncItems),
    maxRawBytes: learningValidation.integer(row.maxRawBytes, 1, LEARNING_LIMITS.maxSyncBytes),
    maxNormalizedBytes: learningValidation.integer(row.maxNormalizedBytes, 1, LEARNING_LIMITS.maxSyncBytes),
    maxUniqueKeyBytes: learningValidation.integer(row.maxUniqueKeyBytes, 1, LEARNING_LIMITS.maxSyncBytes),
    signal: abortSignal(row.signal),
  });
}

function normalizeProviderSubject(value: unknown): LearningProviderSubject {
  const row = learningValidation.exactRecord(value, ['provider', 'connectionId']);
  return Object.freeze({
    provider: learningValidation.oneOf(row.provider, LEARNING_PROVIDERS),
    connectionId: learningValidation.integer(row.connectionId, 1),
  });
}

function normalizeCourseSubject(value: unknown): LearningCourseSubject {
  const row = learningValidation.exactRecord(value, ['provider', 'connectionId', 'externalCourseId']);
  return Object.freeze({
    provider: learningValidation.oneOf(row.provider, LEARNING_PROVIDERS),
    connectionId: learningValidation.integer(row.connectionId, 1),
    externalCourseId: learningValidation.externalId(row.externalCourseId),
  });
}

function normalizeActivitySubject(value: unknown): LearningActivitySubject {
  const row = learningValidation.exactRecord(value, [
    'provider', 'connectionId', 'externalCourseId', 'externalActivityId',
  ]);
  return Object.freeze({
    provider: learningValidation.oneOf(row.provider, LEARNING_PROVIDERS),
    connectionId: learningValidation.integer(row.connectionId, 1),
    externalCourseId: learningValidation.externalId(row.externalCourseId),
    externalActivityId: learningValidation.externalId(row.externalActivityId),
  });
}

function normalizeSubmissionReadSubject(value: unknown): LearningSubmissionReadSubject {
  const row = learningValidation.exactRecord(value, [
    'provider', 'connectionId', 'externalCourseId', 'externalActivityId', 'externalEnrollmentId',
  ]);
  return Object.freeze({
    provider: learningValidation.oneOf(row.provider, LEARNING_PROVIDERS),
    connectionId: learningValidation.integer(row.connectionId, 1),
    externalCourseId: learningValidation.externalId(row.externalCourseId),
    externalActivityId: learningValidation.externalId(row.externalActivityId),
    externalEnrollmentId: row.externalEnrollmentId === null
      ? null
      : learningValidation.externalId(row.externalEnrollmentId),
  });
}

function scopeForSubject(
  subject: LearningProviderSubject,
  externalCourseId: string | null,
  externalActivityId: string | null,
  externalEnrollmentId: string | null,
): LearningPageScope {
  return Object.freeze({
    provider: subject.provider,
    connectionId: subject.connectionId,
    externalCourseId,
    externalActivityId,
    externalEnrollmentId,
  });
}

function operationBoundToScope(
  value: unknown,
  expectedScope: LearningPageScope,
  currentTimeEpochMs: number,
): LearningOperationContext {
  const operation = normalizeLearningOperationContext(value, currentTimeEpochMs);
  if (!sameScope(operation.scope, expectedScope)) learningValidation.invalid();
  return operation;
}

export function normalizeLearningHealthRequest(value: unknown, now: number): LearningHealthRequest {
  const row = learningValidation.exactRecord(value, ['subject', 'operation']);
  const subject = normalizeProviderSubject(row.subject);
  const operation = operationBoundToScope(row.operation, scopeForSubject(subject, null, null, null), now);
  return Object.freeze({ subject, operation });
}

export function normalizeLearningListCoursesRequest(value: unknown, now: number): LearningListCoursesRequest {
  const row = learningValidation.exactRecord(value, ['subject', 'page', 'operation']);
  const subject = normalizeProviderSubject(row.subject);
  const page = normalizeLearningPageRequest(row.page);
  const operation = operationBoundToScope(row.operation, scopeForSubject(subject, null, null, null), now);
  return Object.freeze({ subject, page, operation });
}

export function normalizeLearningSyncCourseRequest(value: unknown, now: number): LearningSyncCourseRequest {
  const row = learningValidation.exactRecord(value, ['subject', 'operation']);
  const subject = normalizeCourseSubject(row.subject);
  const operation = operationBoundToScope(
    row.operation, scopeForSubject(subject, subject.externalCourseId, null, null), now,
  );
  return Object.freeze({ subject, operation });
}

function normalizeCoursePageRequest(
  value: unknown,
  now: number,
): LearningSyncEnrollmentsRequest {
  const row = learningValidation.exactRecord(value, ['subject', 'page', 'operation']);
  const subject = normalizeCourseSubject(row.subject);
  const page = normalizeLearningPageRequest(row.page);
  const operation = operationBoundToScope(
    row.operation, scopeForSubject(subject, subject.externalCourseId, null, null), now,
  );
  return Object.freeze({ subject, page, operation });
}

export function normalizeLearningSyncEnrollmentsRequest(
  value: unknown,
  now: number,
): LearningSyncEnrollmentsRequest {
  return normalizeCoursePageRequest(value, now);
}

export function normalizeLearningSyncActivitiesRequest(
  value: unknown,
  now: number,
): LearningSyncActivitiesRequest {
  return normalizeCoursePageRequest(value, now);
}

export function normalizeLearningSyncResourcesRequest(
  value: unknown,
  now: number,
): LearningSyncResourcesRequest {
  const row = learningValidation.exactRecord(value, ['subject', 'page', 'operation']);
  const subject = normalizeActivitySubject(row.subject);
  const page = normalizeLearningPageRequest(row.page);
  const operation = operationBoundToScope(
    row.operation,
    scopeForSubject(subject, subject.externalCourseId, subject.externalActivityId, null),
    now,
  );
  return Object.freeze({ subject, page, operation });
}

export function normalizeLearningSyncSubmissionsRequest(
  value: unknown,
  now: number,
): LearningSyncSubmissionsRequest {
  const row = learningValidation.exactRecord(value, ['subject', 'page', 'operation']);
  const subject = normalizeSubmissionReadSubject(row.subject);
  const page = normalizeLearningPageRequest(row.page);
  const operation = operationBoundToScope(
    row.operation,
    scopeForSubject(
      subject,
      subject.externalCourseId,
      subject.externalActivityId,
      subject.externalEnrollmentId,
    ),
    now,
  );
  return Object.freeze({ subject, page, operation });
}

export function normalizeLearningBuildLaunchRequest(
  value: unknown,
  now: number,
): LearningBuildLaunchRequest {
  const row = learningValidation.exactRecord(value, ['subject', 'operation']);
  const subjectRecord = learningValidation.dataRecord(row.subject);
  const subject = Object.prototype.hasOwnProperty.call(subjectRecord, 'externalActivityId')
    ? normalizeActivitySubject(subjectRecord)
    : normalizeCourseSubject(subjectRecord);
  const externalActivityId = Object.prototype.hasOwnProperty.call(subject, 'externalActivityId')
    ? (subject as LearningActivitySubject).externalActivityId
    : null;
  const operation = operationBoundToScope(
    row.operation,
    scopeForSubject(subject, subject.externalCourseId, externalActivityId, null),
    now,
  );
  return Object.freeze({ subject, operation });
}

function sameScope(left: LearningPageScope, right: LearningPageScope): boolean {
  return left.provider === right.provider
    && left.connectionId === right.connectionId
    && left.externalCourseId === right.externalCourseId
    && left.externalActivityId === right.externalActivityId
    && left.externalEnrollmentId === right.externalEnrollmentId;
}

const MAX_UNIQUENESS_KEYS_PER_ITEM = 4;

function safeUniquenessKeys<T extends object>(
  item: T,
  uniquenessKeys: (value: T) => readonly string[],
): readonly string[] {
  try {
    const rawKeys = learningValidation.dataArray(
      uniquenessKeys(item),
      MAX_UNIQUENESS_KEYS_PER_ITEM,
    );
    if (rawKeys.length < 1) learningValidation.invalid();
    const keys: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < rawKeys.length; index += 1) {
      const key = learningValidation.boundedString(
        rawKeys[index], 1, LEARNING_LIMITS.urlBytes, false,
      );
      if (seen.has(key)) learningValidation.invalid();
      seen.add(key);
      keys[index] = key;
    }
    return Object.freeze(keys);
  } catch {
    return learningValidation.invalid();
  }
}

interface SequenceItemInfo<T extends object> {
  readonly item: T;
  readonly keys: readonly string[];
  readonly bytes: number;
}

function sortedUniqueKeys<T extends object>(infos: readonly SequenceItemInfo<T>[]): readonly string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (let infoIndex = 0; infoIndex < infos.length; infoIndex += 1) {
    const infoKeys = infos[infoIndex].keys;
    for (let keyIndex = 0; keyIndex < infoKeys.length; keyIndex += 1) {
      const key = infoKeys[keyIndex];
      if (seen.has(key)) learningValidation.invalid();
      seen.add(key);
      keys[keys.length] = key;
    }
  }
  keys.sort(compareCodeUnits);
  return Object.freeze(keys);
}

function itemMatchesScope(item: object, scope: LearningPageScope): boolean {
  try {
    const row = learningValidation.dataRecord(item);
    return row.provider === scope.provider
      && row.connectionId === scope.connectionId
      && (scope.externalCourseId === null || row.externalCourseId === scope.externalCourseId)
      && (scope.externalActivityId === null || row.externalActivityId === scope.externalActivityId)
      && (scope.externalEnrollmentId === null || row.externalEnrollmentId === scope.externalEnrollmentId);
  } catch {
    return false;
  }
}

function isCancelled(signal: AbortSignal): boolean {
  try {
    return signal.aborted;
  } catch {
    return learningValidation.invalid();
  }
}

interface AccumulatorState<T extends object> {
  readonly context: LearningOperationContext;
  readonly infos: readonly SequenceItemInfo<T>[];
  readonly pageCount: number;
  readonly rawResponseBytes: number;
  readonly normalizedItemBytes: number;
  readonly uniquenessKeyBytes: number;
  readonly expectedPageToken: string | null;
  readonly seenPageTokens: readonly string[];
  readonly seenUniquenessKeys: readonly string[];
  readonly complete: LearningIntegerBoolean;
}

function mergeInfos<T extends object>(
  left: readonly SequenceItemInfo<T>[],
  right: readonly SequenceItemInfo<T>[],
): readonly SequenceItemInfo<T>[] {
  const merged: SequenceItemInfo<T>[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (
      rightIndex >= right.length
      || (leftIndex < left.length
        && compareCodeUnits(left[leftIndex].keys[0], right[rightIndex].keys[0]) <= 0)
    ) {
      merged[merged.length] = left[leftIndex];
      leftIndex += 1;
    } else {
      merged[merged.length] = right[rightIndex];
      rightIndex += 1;
    }
  }
  return Object.freeze(merged);
}

function mergeStrings(left: readonly string[], right: readonly string[]): readonly string[] {
  const result: string[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (
      rightIndex >= right.length
      || (leftIndex < left.length && compareCodeUnits(left[leftIndex], right[rightIndex]) <= 0)
    ) {
      result[result.length] = left[leftIndex];
      leftIndex += 1;
    } else {
      result[result.length] = right[rightIndex];
      rightIndex += 1;
    }
  }
  return Object.freeze(result);
}

function accumulatorView<T extends object>(state: AccumulatorState<T>): LearningPageAccumulatorView<T> {
  const items: T[] = [];
  for (let index = 0; index < state.infos.length; index += 1) items[index] = state.infos[index].item;
  return Object.freeze({
    scope: state.context.scope,
    startedAt: state.context.startedAt,
    deadlineAt: state.context.deadlineAt,
    maxPages: state.context.maxPages,
    maxItems: state.context.maxItems,
    maxRawBytes: state.context.maxRawBytes,
    maxNormalizedBytes: state.context.maxNormalizedBytes,
    maxUniqueKeyBytes: state.context.maxUniqueKeyBytes,
    pageCount: state.pageCount,
    itemCount: state.infos.length,
    rawResponseBytes: state.rawResponseBytes,
    normalizedItemBytes: state.normalizedItemBytes,
    uniquenessKeyBytes: state.uniquenessKeyBytes,
    expectedPageToken: state.expectedPageToken,
    seenPageTokens: state.seenPageTokens,
    seenUniquenessKeys: state.seenUniquenessKeys,
    items: Object.freeze(items),
    complete: state.complete,
  });
}

function makeAccumulator<T extends object>(
  state: AccumulatorState<T>,
  normalizeItem: (value: unknown) => T,
  uniquenessKeys: (value: T) => readonly string[],
): LearningPageAccumulator<T> {
  const view = accumulatorView(state);
  return Object.freeze({
    view,
    accept(payload: LearningMeasuredPayload, currentTimeEpochMs: number): LearningPageAccumulator<T> {
      const context = normalizeLearningOperationContext(state.context, currentTimeEpochMs);
      if (state.complete === 1 || isCancelled(context.signal)) learningValidation.invalid();
      const page = normalizeLearningPage(payload, {
        normalizeItem,
        subjectKey(item) {
          return safeUniquenessKeys(item, uniquenessKeys)[0];
        },
      });
      if (
        page.pageNumber !== state.pageCount + 1
        || page.requestPageToken !== state.expectedPageToken
      ) learningValidation.invalid();

      const incomingInfos: SequenceItemInfo<T>[] = [];
      let incomingNormalizedBytes = 0;
      let incomingKeyBytes = 0;
      const existingKeys = new Set(state.seenUniquenessKeys);
      const incomingSeen = new Set<string>();
      for (let index = 0; index < page.items.length; index += 1) {
        const item = page.items[index];
        if (!itemMatchesScope(item, context.scope)) learningValidation.invalid();
        const itemJson = canonicalJson(item);
        const bytes = learningValidation.utf8Bytes(itemJson);
        if (bytes > LEARNING_LIMITS.maxItemBytes) learningValidation.invalid();
        const keys = safeUniquenessKeys(item, uniquenessKeys);
        for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          const key = keys[keyIndex];
          if (existingKeys.has(key) || incomingSeen.has(key)) learningValidation.invalid();
          incomingSeen.add(key);
          incomingKeyBytes += learningValidation.utf8Bytes(key);
        }
        incomingNormalizedBytes += bytes;
        incomingInfos[index] = { item, keys, bytes };
      }
      incomingInfos.sort((left, right) => compareCodeUnits(left.keys[0], right.keys[0]));
      const incomingSortedKeys = sortedUniqueKeys(incomingInfos);

      const nextPageCount = state.pageCount + 1;
      const nextItemCount = state.infos.length + incomingInfos.length;
      const nextRawResponseBytes = state.rawResponseBytes + page.responseBytes;
      const nextNormalizedItemBytes = state.normalizedItemBytes + incomingNormalizedBytes;
      const nextUniquenessKeyBytes = state.uniquenessKeyBytes + incomingKeyBytes;
      if (
        nextPageCount > context.maxPages
        || nextItemCount > context.maxItems
        || nextRawResponseBytes > context.maxRawBytes
        || nextNormalizedItemBytes > context.maxNormalizedBytes
        || nextUniquenessKeyBytes > context.maxUniqueKeyBytes
        || (page.nextPageToken !== null && (
          nextPageCount === context.maxPages
          || nextItemCount === context.maxItems
          || nextRawResponseBytes === context.maxRawBytes
          || nextNormalizedItemBytes === context.maxNormalizedBytes
          || nextUniquenessKeyBytes === context.maxUniqueKeyBytes
        ))
      ) learningValidation.invalid();

      const seenPageTokens = [...state.seenPageTokens];
      if (page.nextPageToken !== null) {
        if (seenPageTokens.includes(page.nextPageToken)) learningValidation.invalid();
        seenPageTokens[seenPageTokens.length] = page.nextPageToken;
      }
      return makeAccumulator({
        context,
        infos: mergeInfos(state.infos, Object.freeze(incomingInfos)),
        pageCount: nextPageCount,
        rawResponseBytes: nextRawResponseBytes,
        normalizedItemBytes: nextNormalizedItemBytes,
        uniquenessKeyBytes: nextUniquenessKeyBytes,
        expectedPageToken: page.nextPageToken,
        seenPageTokens: Object.freeze(seenPageTokens),
        seenUniquenessKeys: mergeStrings(state.seenUniquenessKeys, incomingSortedKeys),
        complete: page.nextPageToken === null ? 1 : 0,
      }, normalizeItem, uniquenessKeys);
    },
  });
}

export function createLearningPageAccumulator<T extends object>(
  rawContext: LearningOperationContext,
  contract: LearningPageSequenceContract<T>,
): LearningPageAccumulator<T> {
  const callbacks = contractCallbacks(contract, ['normalizeItem', 'uniquenessKeys']);
  const contextRecord = learningValidation.dataRecord(rawContext);
  const startedAt = learningValidation.timestamp(contextRecord.startedAt);
  const context = normalizeLearningOperationContext(rawContext, Date.parse(startedAt));
  return makeAccumulator({
    context,
    infos: Object.freeze([] as SequenceItemInfo<T>[]),
    pageCount: 0,
    rawResponseBytes: 0,
    normalizedItemBytes: 0,
    uniquenessKeyBytes: 0,
    expectedPageToken: null,
    seenPageTokens: Object.freeze([] as string[]),
    seenUniquenessKeys: Object.freeze([] as string[]),
    complete: 0,
  }, callbacks.normalizeItem as (value: unknown) => T, callbacks.uniquenessKeys as (value: T) => readonly string[]);
}

function providerFailure(
  code: LearningErrorCode,
  provider: LearningProviderKind,
  httpStatus: number | null = null,
  retryAfterSeconds: number | null = null,
): LearningProviderError {
  return new LearningProviderError({ code, provider, httpStatus, retryAfterSeconds });
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best-effort; the original bounded error remains authoritative.
  }
}

function activeProviderOperation(operation: LearningOperationContext, now: number): void {
  if (isCancelled(operation.signal)) throw providerFailure('cancelled', operation.scope.provider);
  if (!Number.isSafeInteger(now) || now < 0) throw providerFailure('invalid_request', operation.scope.provider);
  if (now >= Date.parse(operation.deadlineAt)) throw providerFailure('timeout', operation.scope.provider);
}

async function guardedRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  operation: LearningOperationContext,
  now: () => number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const current = now();
  activeProviderOperation(operation, current);
  const remaining = Date.parse(operation.deadlineAt) - current;
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation.signal.removeEventListener('abort', abort);
      run();
    };
    const abort = (): void => finish(() => reject(providerFailure('cancelled', operation.scope.provider)));
    const timer = setTimeout(
      () => finish(() => reject(providerFailure('timeout', operation.scope.provider))),
      Math.max(0, remaining),
    );
    operation.signal.addEventListener('abort', abort, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      () => finish(() => reject(providerFailure('malformed_response', operation.scope.provider))),
    );
  });
}

function makeMeasuredPayload(payload: unknown, byteCount: number): LearningMeasuredPayload {
  const result = {
    payload: cloneAndFreeze(payload),
    byteCount,
  } as LearningMeasuredPayload;
  Object.defineProperty(result, MEASURED_PAYLOAD_BRAND, { value: true });
  return Object.freeze(result);
}

/**
 * Measures a supplied response stream before parsing JSON. It performs no
 * fetch and is the only constructor for the opaque measured-payload brand.
 */
export async function readLearningJsonResponse(
  response: Response,
  rawOperation: LearningOperationContext,
  now: () => number,
): Promise<LearningMeasuredPayload> {
  let operation: LearningOperationContext;
  let provider: LearningProviderKind = 'canvas';
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    if (typeof now !== 'function') learningValidation.invalid();
    const initialNow = now();
    const rawOperationRow = learningValidation.dataRecord(rawOperation);
    const rawScope = learningValidation.dataRecord(rawOperationRow.scope);
    provider = learningValidation.oneOf(rawScope.provider, LEARNING_PROVIDERS);
    if (!(response instanceof Response) || response.body === null) {
      throw providerFailure('malformed_response', provider);
    }
    reader = response.body.getReader();
    const rawSignal = abortSignal(rawOperationRow.signal);
    if (isCancelled(rawSignal)) {
      await cancelReader(reader);
      throw providerFailure('cancelled', provider);
    }
    const rawDeadline = learningValidation.timestamp(rawOperationRow.deadlineAt);
    if (initialNow >= Date.parse(rawDeadline)) {
      await cancelReader(reader);
      throw providerFailure('timeout', provider);
    }
    operation = normalizeLearningOperationContext(rawOperation, initialNow);
    activeProviderOperation(operation, initialNow);
    const contentLengthValue = response.headers.get('Content-Length');
    let declaredLength: number | null = null;
    if (contentLengthValue !== null) {
      if (!/^(?:0|[1-9]\d*)$/u.test(contentLengthValue)) {
        throw providerFailure('malformed_response', provider);
      }
      declaredLength = Number(contentLengthValue);
      if (!Number.isSafeInteger(declaredLength)) throw providerFailure('malformed_response', provider);
      if (declaredLength > operation.maxRawBytes) {
        await cancelReader(reader);
        throw providerFailure('response_too_large', provider);
      }
    }

    const chunks: Uint8Array[] = [];
    let byteCount = 0;
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await guardedRead(reader, operation, now);
      } catch (error) {
        await cancelReader(reader);
        throw error;
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        await cancelReader(reader);
        throw providerFailure('malformed_response', provider);
      }
      byteCount += result.value.byteLength;
      if (byteCount > operation.maxRawBytes) {
        await cancelReader(reader);
        throw providerFailure('response_too_large', provider);
      }
      chunks[chunks.length] = result.value;
    }
    if (declaredLength !== null && declaredLength !== byteCount) {
      throw providerFailure('malformed_response', provider);
    }
    const bytes = new Uint8Array(byteCount);
    let offset = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      bytes.set(chunks[index], offset);
      offset += chunks[index].byteLength;
    }
    let parsed: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw providerFailure('malformed_response', provider);
    }
    return makeMeasuredPayload(parsed, byteCount);
  } catch (error) {
    if (error instanceof LearningProviderError) throw error;
    throw providerFailure('malformed_response', provider);
  }
}

export type LearningProviderMethod =
  | 'healthCheck'
  | 'listCourses'
  | 'syncCourse'
  | 'syncEnrollments'
  | 'syncActivities'
  | 'syncResources'
  | 'syncSubmissions'
  | 'buildLaunchUrl';

export interface LearningProviderInvocation {
  readonly method: LearningProviderMethod;
  readonly request: unknown;
  readonly now: () => number;
  readonly urlPolicy?: LearningConnectionUrlPolicy;
}

function rawOperationStatus(request: unknown, provider: LearningProviderKind, now: number): void {
  try {
    const requestRow = learningValidation.dataRecord(request);
    const operationRow = learningValidation.dataRecord(requestRow.operation);
    const signal = abortSignal(operationRow.signal);
    if (isCancelled(signal)) throw providerFailure('cancelled', provider);
    const deadline = learningValidation.timestamp(operationRow.deadlineAt);
    if (now >= Date.parse(deadline)) throw providerFailure('timeout', provider);
  } catch (error) {
    if (error instanceof LearningProviderError) throw error;
  }
}

async function guardedProviderCall<T>(
  call: () => Promise<T>,
  operation: LearningOperationContext,
  now: number,
): Promise<T> {
  activeProviderOperation(operation, now);
  const remaining = Date.parse(operation.deadlineAt) - now;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation.signal.removeEventListener('abort', abort);
      run();
    };
    const abort = (): void => finish(() => reject(providerFailure('cancelled', operation.scope.provider)));
    const timer = setTimeout(
      () => finish(() => reject(providerFailure('timeout', operation.scope.provider))),
      Math.max(0, remaining),
    );
    operation.signal.addEventListener('abort', abort, { once: true });
    let promise: Promise<T>;
    try {
      promise = call();
    } catch {
      finish(() => reject(providerFailure('provider_unavailable', operation.scope.provider)));
      return;
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(
        error instanceof LearningProviderError
          ? providerFailure(error.code, error.provider, error.httpStatus, error.retryAfterSeconds)
          : providerFailure('provider_unavailable', operation.scope.provider),
      )),
    );
  });
}

function providerAdapter(value: unknown, method: LearningProviderMethod): {
  readonly provider: LearningProviderKind;
  readonly call: (request: never) => Promise<unknown>;
} {
  try {
    const row = learningValidation.dataRecord(value);
    const provider = learningValidation.oneOf(row.provider, LEARNING_PROVIDERS);
    const call = row[method];
    if (typeof call !== 'function') learningValidation.invalid();
    return {
      provider,
      call: (request: never) => Reflect.apply(
        call as (...args: never[]) => Promise<unknown>, value, [request],
      ),
    };
  } catch {
    return learningValidation.invalid();
  }
}

function pageMatchesRequest<T extends object>(
  page: LearningProviderPage<T>,
  request: LearningListCoursesRequest | LearningSyncEnrollmentsRequest | LearningSyncActivitiesRequest
    | LearningSyncResourcesRequest | LearningSyncSubmissionsRequest,
): void {
  if (
    page.pageNumber !== request.page.pageNumber
    || page.requestPageToken !== request.page.pageToken
  ) learningValidation.invalid();
  for (let index = 0; index < page.items.length; index += 1) {
    if (!itemMatchesScope(page.items[index], request.operation.scope)) learningValidation.invalid();
  }
}

/** Single runtime gate for every network-capable provider adapter method. */
export async function invokeLearningProvider(
  rawProvider: LearningProvider,
  rawInvocation: LearningProviderInvocation,
): Promise<unknown> {
  let provider: LearningProviderKind = 'canvas';
  let operation: LearningOperationContext | null = null;
  let phase: 'request' | 'call' | 'result' = 'request';
  try {
    let invocation = learningValidation.dataRecord(rawInvocation);
    const method = learningValidation.oneOf(invocation.method, [
      'healthCheck', 'listCourses', 'syncCourse', 'syncEnrollments',
      'syncActivities', 'syncResources', 'syncSubmissions', 'buildLaunchUrl',
    ] as const);
    invocation = Object.prototype.hasOwnProperty.call(invocation, 'urlPolicy')
      ? learningValidation.exactRecord(rawInvocation, ['method', 'request', 'now', 'urlPolicy'])
      : learningValidation.exactRecord(rawInvocation, ['method', 'request', 'now']);
    const adapter = providerAdapter(rawProvider, method);
    provider = adapter.provider;
    if (typeof invocation.now !== 'function') learningValidation.invalid();
    const now = (invocation.now as () => number)();
    if (!Number.isSafeInteger(now) || now < 0) learningValidation.invalid();
    rawOperationStatus(invocation.request, provider, now);

    let request: LearningHealthRequest | LearningListCoursesRequest | LearningSyncCourseRequest
      | LearningSyncEnrollmentsRequest | LearningSyncActivitiesRequest | LearningSyncResourcesRequest
      | LearningSyncSubmissionsRequest | LearningBuildLaunchRequest;
    if (method === 'healthCheck') request = normalizeLearningHealthRequest(invocation.request, now);
    else if (method === 'listCourses') request = normalizeLearningListCoursesRequest(invocation.request, now);
    else if (method === 'syncCourse') request = normalizeLearningSyncCourseRequest(invocation.request, now);
    else if (method === 'syncEnrollments') request = normalizeLearningSyncEnrollmentsRequest(invocation.request, now);
    else if (method === 'syncActivities') request = normalizeLearningSyncActivitiesRequest(invocation.request, now);
    else if (method === 'syncResources') request = normalizeLearningSyncResourcesRequest(invocation.request, now);
    else if (method === 'syncSubmissions') request = normalizeLearningSyncSubmissionsRequest(invocation.request, now);
    else request = normalizeLearningBuildLaunchRequest(invocation.request, now);
    operation = request.operation;
    if (request.subject.provider !== provider) learningValidation.invalid();

    phase = 'call';
    const rawResult = await guardedProviderCall(
      () => adapter.call(request as never), operation, now,
    );
    phase = 'result';

    if (method === 'healthCheck') {
      const result = normalizeLearningProviderHealth(rawResult);
      if (result.provider !== provider || result.connectionId !== request.subject.connectionId) learningValidation.invalid();
      return result;
    }
    if (method === 'syncCourse') {
      const policy = invocation.urlPolicy;
      const result = normalizeLearningCourse(rawResult, policy);
      const subject = (request as LearningSyncCourseRequest).subject;
      if (result.externalCourseId !== subject.externalCourseId) learningValidation.invalid();
      return result;
    }
    if (method === 'buildLaunchUrl') {
      return normalizeLearningLaunchContract(
        rawResult,
        invocation.urlPolicy,
        (request as LearningBuildLaunchRequest).subject,
      );
    }

    let page: LearningProviderPage<LearningCourse | LearningProviderEnrollment | LearningActivity
      | LearningResource | LearningSubmissionSnapshot>;
    if (method === 'listCourses') {
      page = normalizeLearningPage(rawResult, {
        normalizeItem: (value) => normalizeLearningCourse(value, invocation.urlPolicy),
        subjectKey: (value) => JSON.stringify([value.provider, value.connectionId, value.externalCourseId]),
      });
    } else if (method === 'syncEnrollments') {
      page = normalizeLearningPage(rawResult, {
        normalizeItem: normalizeLearningProviderEnrollment,
        subjectKey: (value) => JSON.stringify([
          value.provider, value.connectionId, value.externalCourseId, value.externalEnrollmentId,
        ]),
      });
    } else if (method === 'syncActivities') {
      page = normalizeLearningPage(rawResult, {
        normalizeItem: (value) => normalizeLearningActivity(value, invocation.urlPolicy),
        subjectKey: (value) => JSON.stringify([
          value.provider, value.connectionId, value.externalCourseId, value.externalActivityId,
        ]),
      });
    } else if (method === 'syncResources') {
      page = normalizeLearningPage(rawResult, {
        normalizeItem: (value) => normalizeLearningResource(value, invocation.urlPolicy),
        subjectKey: (value) => JSON.stringify([
          value.provider, value.connectionId, value.externalCourseId,
          value.externalActivityId, value.externalResourceId,
        ]),
      });
    } else {
      page = normalizeLearningPage(rawResult, {
        normalizeItem: normalizeLearningSubmissionSnapshot,
        subjectKey: (value) => JSON.stringify([
          value.provider, value.connectionId, value.externalCourseId,
          value.externalActivityId, value.externalEnrollmentId,
        ]),
      });
    }
    pageMatchesRequest(page, request as LearningListCoursesRequest | LearningSyncEnrollmentsRequest
      | LearningSyncActivitiesRequest | LearningSyncResourcesRequest | LearningSyncSubmissionsRequest);
    return page;
  } catch (error) {
    if (error instanceof LearningProviderError) throw error;
    const code: LearningErrorCode = phase === 'result'
      ? 'malformed_response'
      : phase === 'call' ? 'provider_unavailable' : 'invalid_request';
    throw providerFailure(code, operation?.scope.provider ?? provider);
  }
}

function sortableCanonicalTimestamp(value: string): string {
  const fractionStart = value.indexOf('.') + 1;
  const fractionEnd = value.length - 1;
  return `${value.slice(0, fractionStart)}${value.slice(fractionStart, fractionEnd).padEnd(9, '0')}Z`;
}

export function normalizeLearningSyncResult(value: unknown): LearningSyncResult {
  const row = learningValidation.exactRecord(value, [
    'connectionId', 'provider', 'externalCourseId', 'trigger', 'status', 'startedAt',
    'finishedAt', 'attemptCount', 'pageCount', 'scannedCount', 'changedCount',
    'removedCount', 'eventCount', 'responseBytes', 'errorCode',
  ]);
  const status = learningValidation.oneOf(row.status, LEARNING_SYNC_STATUSES);
  const startedAt = learningValidation.timestamp(row.startedAt);
  const finishedAt = learningValidation.nullableTimestamp(row.finishedAt);
  const errorCode = row.errorCode === null
    ? null
    : learningValidation.oneOf(row.errorCode, LEARNING_ERROR_CODES);
  if (
    (status === 'running' && (finishedAt !== null || errorCode !== null))
    || (status === 'succeeded' && (finishedAt === null || errorCode !== null))
    || (status === 'failed' && (finishedAt === null || errorCode === null))
    || (status === 'cancelled' && (finishedAt === null || errorCode !== null))
    || (finishedAt !== null
      && sortableCanonicalTimestamp(finishedAt) < sortableCanonicalTimestamp(startedAt))
  ) learningValidation.invalid();
  const scannedCount = learningValidation.integer(row.scannedCount, 0, LEARNING_LIMITS.maxSyncItems);
  const changedCount = learningValidation.integer(row.changedCount, 0, LEARNING_LIMITS.maxSyncItems);
  const removedCount = learningValidation.integer(row.removedCount, 0, LEARNING_LIMITS.maxSyncItems);
  if (changedCount > scannedCount || removedCount > scannedCount) learningValidation.invalid();
  return Object.freeze({
    connectionId: learningValidation.integer(row.connectionId, 1),
    provider: learningValidation.oneOf(row.provider, LEARNING_PROVIDERS),
    externalCourseId: row.externalCourseId === null ? null : learningValidation.externalId(row.externalCourseId),
    trigger: learningValidation.oneOf(row.trigger, LEARNING_SYNC_TRIGGERS),
    status,
    startedAt,
    finishedAt,
    attemptCount: learningValidation.integer(row.attemptCount, 1, LEARNING_LIMITS.maxSyncAttempts),
    pageCount: learningValidation.integer(row.pageCount, 0, LEARNING_LIMITS.maxPages),
    scannedCount,
    changedCount,
    removedCount,
    eventCount: learningValidation.integer(row.eventCount, 0, LEARNING_LIMITS.maxSyncItems),
    responseBytes: learningValidation.integer(row.responseBytes, 0, LEARNING_LIMITS.maxSyncBytes),
    errorCode,
  });
}

export function normalizeLearningProviderError(value: unknown): LearningProviderErrorMetadata {
  return normalizeLearningProviderErrorMetadata(value);
}

export function normalizeLearningProviderHealth(value: unknown): LearningProviderHealth {
  const row = learningValidation.exactRecord(value, ['connectionId', 'provider', 'healthy', 'checkedAt', 'errorCode']);
  const healthy = learningValidation.integer(row.healthy, 0, 1) as LearningIntegerBoolean;
  const errorCode = row.errorCode === null ? null : learningValidation.oneOf(row.errorCode, LEARNING_ERROR_CODES);
  if ((healthy === 1 && errorCode !== null) || (healthy === 0 && errorCode === null)) learningValidation.invalid();
  return Object.freeze({
    connectionId: learningValidation.integer(row.connectionId, 1),
    provider: learningValidation.oneOf(row.provider, LEARNING_PROVIDERS),
    healthy,
    checkedAt: learningValidation.timestamp(row.checkedAt),
    errorCode,
  });
}

export function normalizeLearningProviderNotification(value: unknown): LearningProviderNotification {
  const row = learningValidation.exactRecord(value, [
    'connectionId', 'provider', 'sourceEventId', 'externalCourseId', 'receivedAt',
  ]);
  return Object.freeze({
    connectionId: learningValidation.integer(row.connectionId, 1),
    provider: learningValidation.oneOf(row.provider, LEARNING_PROVIDERS),
    sourceEventId: learningValidation.externalId(row.sourceEventId),
    externalCourseId: row.externalCourseId === null ? null : learningValidation.externalId(row.externalCourseId),
    receivedAt: learningValidation.timestamp(row.receivedAt),
  });
}
