import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  LEARNING_PROVIDERS,
  LEARNING_SYNC_STATUSES,
  LEARNING_SYNC_TRIGGERS,
  learningValidation,
  normalizeLearningProviderErrorMetadata,
  type LearningActivity,
  type LearningActivitySubject,
  type LearningCourse,
  type LearningCourseSubject,
  type LearningEnrollment,
  type LearningErrorCode,
  type LearningIntegerBoolean,
  type LearningLaunchContract,
  type LearningProviderErrorMetadata,
  type LearningProviderKind,
  type LearningProviderSubject,
  type LearningResource,
  type LearningSubmissionSnapshot,
  type LearningSyncStatus,
  type LearningSyncTrigger,
} from './learningModel';

export interface LearningPageRequest {
  readonly pageSize: number;
  readonly pageNumber: number;
  readonly pageToken: string | null;
}

export interface LearningProviderPage<T extends object> {
  readonly items: readonly T[];
  readonly requestPageToken: string | null;
  readonly nextPageToken: string | null;
  readonly pageNumber: number;
  readonly responseBytes: number;
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
  readonly signal: AbortSignal;
}

export interface LearningPageSequence<T extends object> {
  readonly scope: LearningPageScope;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly maxPages: number;
  readonly maxItems: number;
  readonly maxRawBytes: number;
  readonly maxNormalizedBytes: number;
  readonly pageCount: number;
  readonly itemCount: number;
  readonly rawResponseBytes: number;
  readonly normalizedItemBytes: number;
  readonly pageResponseBytes: readonly number[];
  readonly expectedPageToken: string | null;
  readonly seenPageTokens: readonly string[];
  readonly seenUniquenessKeys: readonly string[];
  readonly items: readonly T[];
  readonly complete: LearningIntegerBoolean;
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
  listCourses(request: LearningListCoursesRequest): Promise<LearningProviderPage<LearningCourse>>;
  syncCourse(request: LearningSyncCourseRequest): Promise<LearningCourse>;
  syncEnrollments(request: LearningSyncEnrollmentsRequest): Promise<LearningProviderPage<LearningEnrollment>>;
  syncActivities(request: LearningSyncActivitiesRequest): Promise<LearningProviderPage<LearningActivity>>;
  syncResources(request: LearningSyncResourcesRequest): Promise<LearningProviderPage<LearningResource>>;
  syncSubmissions(request: LearningSyncSubmissionsRequest): Promise<LearningProviderPage<LearningSubmissionSnapshot>>;
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

function cloneAndFreeze(
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
        clone[index] = cloneAndFreeze(source[index], state, depth + 1);
      }
      return Object.freeze(clone);
    }
    const row = learningValidation.dataRecord(value);
    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(row).sort()) clone[key] = cloneAndFreeze(row[key], state, depth + 1);
    return Object.freeze(clone);
  } finally {
    state.active.delete(objectValue);
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

export function normalizeLearningPage<T extends object>(
  value: unknown,
  contract: LearningPageContract<T>,
): LearningProviderPage<T> {
  if (!contract || typeof contract.normalizeItem !== 'function' || typeof contract.subjectKey !== 'function') {
    learningValidation.invalid();
  }
  const row = learningValidation.exactRecord(value, [
    'items', 'requestPageToken', 'nextPageToken', 'pageNumber', 'responseBytes',
  ]);
  const itemInputs = learningValidation.dataArray(row.items, LEARNING_LIMITS.maxPageItems);
  const pageNumber = learningValidation.integer(row.pageNumber, 1, LEARNING_LIMITS.maxPages);
  const responseBytes = learningValidation.integer(row.responseBytes, 0, LEARNING_LIMITS.maxPageBytes);
  const byKey = new Map<string, { item: T; json: string }>();
  for (let index = 0; index < itemInputs.length; index += 1) {
    const rawItem = itemInputs[index];
    const normalized = (() => {
      try {
        return contract.normalizeItem(rawItem);
      } catch {
        return learningValidation.invalid();
      }
    })();
    const immutable = cloneAndFreeze(learningValidation.dataRecord(normalized)) as T;
    const itemJson = canonicalJson(immutable);
    if (learningValidation.utf8Bytes(itemJson) > LEARNING_LIMITS.maxItemBytes) learningValidation.invalid();
    let subjectKey = (() => {
      try {
        return contract.subjectKey(immutable);
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
  return Object.freeze({
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
    'maxRawBytes', 'maxNormalizedBytes', 'signal',
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

function stringArray(value: unknown, maximumLength: number, tokenValues = false): readonly string[] {
  const values = learningValidation.dataArray(value, maximumLength);
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const item = tokenValues
      ? token(values[index])
      : learningValidation.boundedString(values[index], 1, LEARNING_LIMITS.urlBytes, false);
    if (item === null) learningValidation.invalid();
    const normalizedItem = item as string;
    if (seen.has(normalizedItem)) learningValidation.invalid();
    seen.add(normalizedItem);
    result[index] = normalizedItem;
  }
  return Object.freeze(result);
}

const MAX_UNIQUENESS_KEYS_PER_ITEM = 4;

function safeNormalizeSequenceItem<T extends object>(
  value: unknown,
  contract: LearningPageSequenceContract<T>,
): T {
  try {
    if (!contract || typeof contract.normalizeItem !== 'function') learningValidation.invalid();
    const normalized = contract.normalizeItem(value);
    return cloneAndFreeze(learningValidation.dataRecord(normalized)) as T;
  } catch {
    return learningValidation.invalid();
  }
}

function safeUniquenessKeys<T extends object>(
  item: T,
  contract: LearningPageSequenceContract<T>,
): readonly string[] {
  try {
    if (!contract || typeof contract.uniquenessKeys !== 'function') learningValidation.invalid();
    const rawKeys = learningValidation.dataArray(
      contract.uniquenessKeys(item),
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

function sequenceItemInfo<T extends object>(
  value: unknown,
  contract: LearningPageSequenceContract<T>,
): SequenceItemInfo<T> {
  const item = safeNormalizeSequenceItem(value, contract);
  return {
    item,
    keys: safeUniquenessKeys(item, contract),
    bytes: learningValidation.utf8Bytes(canonicalJson(item)),
  };
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

function numberArray(value: unknown, maximumLength: number): readonly number[] {
  const inputs = learningValidation.dataArray(value, maximumLength);
  const values: number[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    values[index] = learningValidation.integer(inputs[index], 0, LEARNING_LIMITS.maxPageBytes);
  }
  return Object.freeze(values);
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function normalizeLearningPageSequence<T extends object>(
  value: unknown,
  contract: LearningPageSequenceContract<T>,
): LearningPageSequence<T> {
  const row = learningValidation.exactRecord(value, [
    'scope', 'startedAt', 'deadlineAt', 'maxPages', 'maxItems',
    'maxRawBytes', 'maxNormalizedBytes', 'pageCount', 'itemCount',
    'rawResponseBytes', 'normalizedItemBytes', 'pageResponseBytes',
    'expectedPageToken', 'seenPageTokens', 'seenUniquenessKeys', 'items', 'complete',
  ]);
  const maxPages = learningValidation.integer(row.maxPages, 1, LEARNING_LIMITS.maxPages);
  const maxItems = learningValidation.integer(row.maxItems, 1, LEARNING_LIMITS.maxSyncItems);
  const maxRawBytes = learningValidation.integer(row.maxRawBytes, 1, LEARNING_LIMITS.maxSyncBytes);
  const maxNormalizedBytes = learningValidation.integer(
    row.maxNormalizedBytes, 1, LEARNING_LIMITS.maxSyncBytes,
  );
  const pageCount = learningValidation.integer(row.pageCount, 0, maxPages);
  const itemCount = learningValidation.integer(row.itemCount, 0, maxItems);
  const rawResponseBytes = learningValidation.integer(row.rawResponseBytes, 0, maxRawBytes);
  const normalizedItemBytes = learningValidation.integer(
    row.normalizedItemBytes, 0, maxNormalizedBytes,
  );
  const itemInputs = learningValidation.dataArray(row.items, maxItems);
  if (itemInputs.length !== itemCount) learningValidation.invalid();
  const infos: SequenceItemInfo<T>[] = [];
  let computedNormalizedBytes = 0;
  for (let index = 0; index < itemInputs.length; index += 1) {
    const info = sequenceItemInfo(itemInputs[index], contract);
    computedNormalizedBytes += info.bytes;
    infos[index] = info;
  }
  if (computedNormalizedBytes !== normalizedItemBytes) learningValidation.invalid();
  const computedKeys = sortedUniqueKeys(infos);
  const seenUniquenessKeys = stringArray(
    row.seenUniquenessKeys,
    maxItems * MAX_UNIQUENESS_KEYS_PER_ITEM,
  );
  if (!equalStrings(computedKeys, seenUniquenessKeys)) learningValidation.invalid();

  const pageResponseBytes = numberArray(row.pageResponseBytes, maxPages);
  let computedRawBytes = 0;
  for (let index = 0; index < pageResponseBytes.length; index += 1) {
    computedRawBytes += pageResponseBytes[index];
  }
  if (pageResponseBytes.length !== pageCount || computedRawBytes !== rawResponseBytes) {
    learningValidation.invalid();
  }

  const complete = learningValidation.integer(row.complete, 0, 1) as LearningIntegerBoolean;
  const expectedPageToken = token(row.expectedPageToken);
  const seenPageTokens = stringArray(row.seenPageTokens, maxPages, true);
  if (
    (pageCount === 0 && (
      itemCount !== 0
      || rawResponseBytes !== 0
      || normalizedItemBytes !== 0
      || expectedPageToken !== null
      || seenPageTokens.length !== 0
      || complete !== 0
    ))
    || (pageCount > 0 && complete === 0 && (
      expectedPageToken === null
      || seenPageTokens.length !== pageCount
      || seenPageTokens[seenPageTokens.length - 1] !== expectedPageToken
    ))
    || (complete === 1 && (
      pageCount === 0
      || expectedPageToken !== null
      || seenPageTokens.length !== pageCount - 1
    ))
  ) learningValidation.invalid();

  infos.sort((left, right) => compareCodeUnits(left.keys[0], right.keys[0]));
  const items: T[] = [];
  for (let index = 0; index < infos.length; index += 1) items[index] = infos[index].item;
  return Object.freeze({
    scope: normalizeLearningPageScope(row.scope),
    startedAt: learningValidation.timestamp(row.startedAt),
    deadlineAt: learningValidation.timestamp(row.deadlineAt),
    maxPages,
    maxItems,
    maxRawBytes,
    maxNormalizedBytes,
    pageCount,
    itemCount,
    rawResponseBytes,
    normalizedItemBytes,
    pageResponseBytes,
    expectedPageToken,
    seenPageTokens,
    seenUniquenessKeys,
    items: Object.freeze(items),
    complete,
  });
}

export function createLearningPageSequence<T extends object>(
  rawContext: LearningOperationContext,
): LearningPageSequence<T> {
  const contextRecord = learningValidation.dataRecord(rawContext);
  const startedAt = learningValidation.timestamp(contextRecord.startedAt);
  const context = normalizeLearningOperationContext(rawContext, Date.parse(startedAt));
  return Object.freeze({
    scope: context.scope,
    startedAt: context.startedAt,
    deadlineAt: context.deadlineAt,
    maxPages: context.maxPages,
    maxItems: context.maxItems,
    maxRawBytes: context.maxRawBytes,
    maxNormalizedBytes: context.maxNormalizedBytes,
    pageCount: 0,
    itemCount: 0,
    rawResponseBytes: 0,
    normalizedItemBytes: 0,
    pageResponseBytes: Object.freeze([] as number[]),
    expectedPageToken: null,
    seenPageTokens: Object.freeze([] as string[]),
    seenUniquenessKeys: Object.freeze([] as string[]),
    items: Object.freeze([] as T[]),
    complete: 0,
  });
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

export function acceptLearningPageSequence<T extends object>(
  rawState: LearningPageSequence<T>,
  rawPage: unknown,
  contract: LearningPageSequenceContract<T>,
  rawContext: LearningOperationContext,
  nowEpochMs: number,
): LearningPageSequence<T> {
  const context = normalizeLearningOperationContext(rawContext, nowEpochMs);
  const state = normalizeLearningPageSequence<T>(rawState, contract);
  if (
    !sameScope(state.scope, context.scope)
    || state.startedAt !== context.startedAt
    || state.deadlineAt !== context.deadlineAt
    || state.maxPages !== context.maxPages
    || state.maxItems !== context.maxItems
    || state.maxRawBytes !== context.maxRawBytes
    || state.maxNormalizedBytes !== context.maxNormalizedBytes
    || isCancelled(context.signal)
    || state.complete === 1
  ) learningValidation.invalid();

  const page = normalizeLearningPage(rawPage, {
    normalizeItem(value) {
      return safeNormalizeSequenceItem(value, contract);
    },
    subjectKey(item) {
      return safeUniquenessKeys(item, contract)[0];
    },
  });
  if (
    page.pageNumber !== state.pageCount + 1
    || page.requestPageToken !== state.expectedPageToken
  ) learningValidation.invalid();

  const nextPageCount = state.pageCount + 1;
  const nextItemCount = state.itemCount + page.items.length;
  const nextRawResponseBytes = state.rawResponseBytes + page.responseBytes;
  let incomingNormalizedBytes = 0;
  const incomingInfos: SequenceItemInfo<T>[] = [];
  for (let index = 0; index < page.items.length; index += 1) {
    const info = sequenceItemInfo(page.items[index], contract);
    incomingNormalizedBytes += info.bytes;
    incomingInfos[index] = info;
  }
  const nextNormalizedItemBytes = state.normalizedItemBytes + incomingNormalizedBytes;
  if (
    nextPageCount > context.maxPages
    || nextItemCount > context.maxItems
    || nextRawResponseBytes > context.maxRawBytes
    || nextNormalizedItemBytes > context.maxNormalizedBytes
    || (page.nextPageToken !== null && (
      nextPageCount === context.maxPages
      || nextItemCount === context.maxItems
      || nextRawResponseBytes === context.maxRawBytes
      || nextNormalizedItemBytes === context.maxNormalizedBytes
    ))
  ) learningValidation.invalid();

  const seenKeys = new Set(state.seenUniquenessKeys);
  const infos: SequenceItemInfo<T>[] = [];
  for (let index = 0; index < state.items.length; index += 1) {
    if (!itemMatchesScope(state.items[index], context.scope)) learningValidation.invalid();
    infos[index] = sequenceItemInfo(state.items[index], contract);
  }
  for (let index = 0; index < incomingInfos.length; index += 1) {
    const info = incomingInfos[index];
    if (!itemMatchesScope(info.item, context.scope)) learningValidation.invalid();
    for (let keyIndex = 0; keyIndex < info.keys.length; keyIndex += 1) {
      const key = info.keys[keyIndex];
      if (seenKeys.has(key)) learningValidation.invalid();
      seenKeys.add(key);
    }
    infos[infos.length] = info;
  }
  infos.sort((left, right) => compareCodeUnits(left.keys[0], right.keys[0]));
  const items: T[] = [];
  for (let index = 0; index < infos.length; index += 1) items[index] = infos[index].item;
  const uniquenessKeys = sortedUniqueKeys(infos);

  const pageTokens = [...state.seenPageTokens];
  if (page.nextPageToken !== null) {
    if (pageTokens.includes(page.nextPageToken)) learningValidation.invalid();
    pageTokens[pageTokens.length] = page.nextPageToken;
  }
  const pageResponseBytes = [...state.pageResponseBytes, page.responseBytes];
  return Object.freeze({
    scope: context.scope,
    startedAt: context.startedAt,
    deadlineAt: context.deadlineAt,
    maxPages: context.maxPages,
    maxItems: context.maxItems,
    maxRawBytes: context.maxRawBytes,
    maxNormalizedBytes: context.maxNormalizedBytes,
    pageCount: nextPageCount,
    itemCount: nextItemCount,
    rawResponseBytes: nextRawResponseBytes,
    normalizedItemBytes: nextNormalizedItemBytes,
    pageResponseBytes: Object.freeze(pageResponseBytes),
    expectedPageToken: page.nextPageToken,
    seenPageTokens: Object.freeze(pageTokens),
    seenUniquenessKeys: uniquenessKeys,
    items: Object.freeze(items),
    complete: page.nextPageToken === null ? 1 : 0,
  });
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
    || (finishedAt !== null && finishedAt < startedAt)
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
