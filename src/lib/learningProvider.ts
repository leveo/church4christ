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
  readonly deadlineAt: string;
  readonly maxPages: number;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

export interface LearningPageSequence<T extends object> {
  readonly scope: LearningPageScope;
  readonly deadlineAt: string;
  readonly maxPages: number;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly pageCount: number;
  readonly itemCount: number;
  readonly responseBytes: number;
  readonly expectedPageToken: string | null;
  readonly seenPageTokens: readonly string[];
  readonly seenEntityKeys: readonly string[];
  readonly items: readonly T[];
  readonly complete: LearningIntegerBoolean;
}

export interface LearningPageSequenceContract<T extends object> {
  readonly subjectKey: (value: T) => string;
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
  healthCheck(subject: LearningProviderSubject, operation: LearningOperationContext): Promise<LearningProviderHealth>;
  listCourses(
    subject: LearningProviderSubject,
    page: LearningPageRequest,
    operation: LearningOperationContext,
  ): Promise<LearningProviderPage<LearningCourse>>;
  syncCourse(subject: LearningCourseSubject, operation: LearningOperationContext): Promise<LearningCourse>;
  syncEnrollments(
    subject: LearningCourseSubject,
    page: LearningPageRequest,
    operation: LearningOperationContext,
  ): Promise<LearningProviderPage<LearningEnrollment>>;
  syncActivities(
    subject: LearningCourseSubject,
    page: LearningPageRequest,
    operation: LearningOperationContext,
  ): Promise<LearningProviderPage<LearningActivity>>;
  syncResources(
    subject: LearningActivitySubject,
    page: LearningPageRequest,
    operation: LearningOperationContext,
  ): Promise<LearningProviderPage<LearningResource>>;
  syncSubmissions(
    subject: LearningActivitySubject,
    page: LearningPageRequest,
    operation: LearningOperationContext,
  ): Promise<LearningProviderPage<LearningSubmissionSnapshot>>;
  buildLaunchUrl(
    subject: LearningCourseSubject | LearningActivitySubject,
    operation: LearningOperationContext,
  ): Promise<LearningLaunchContract>;
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

export function normalizeLearningOperationContext(value: unknown): LearningOperationContext {
  const row = learningValidation.exactRecord(value, [
    'scope', 'deadlineAt', 'maxPages', 'maxItems', 'maxBytes', 'signal',
  ]);
  return Object.freeze({
    scope: normalizeLearningPageScope(row.scope),
    deadlineAt: learningValidation.timestamp(row.deadlineAt),
    maxPages: learningValidation.integer(row.maxPages, 1, LEARNING_LIMITS.maxPages),
    maxItems: learningValidation.integer(row.maxItems, 1, LEARNING_LIMITS.maxSyncItems),
    maxBytes: learningValidation.integer(row.maxBytes, 1, LEARNING_LIMITS.maxSyncBytes),
    signal: abortSignal(row.signal),
  });
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

function normalizeLearningPageSequence<T extends object>(value: unknown): LearningPageSequence<T> {
  const row = learningValidation.exactRecord(value, [
    'scope', 'deadlineAt', 'maxPages', 'maxItems', 'maxBytes', 'pageCount', 'itemCount',
    'responseBytes', 'expectedPageToken', 'seenPageTokens', 'seenEntityKeys', 'items', 'complete',
  ]);
  const maxPages = learningValidation.integer(row.maxPages, 1, LEARNING_LIMITS.maxPages);
  const maxItems = learningValidation.integer(row.maxItems, 1, LEARNING_LIMITS.maxSyncItems);
  const maxBytes = learningValidation.integer(row.maxBytes, 1, LEARNING_LIMITS.maxSyncBytes);
  const pageCount = learningValidation.integer(row.pageCount, 0, maxPages);
  const itemCount = learningValidation.integer(row.itemCount, 0, maxItems);
  const responseBytes = learningValidation.integer(row.responseBytes, 0, maxBytes);
  const itemInputs = learningValidation.dataArray(row.items, maxItems);
  if (itemInputs.length !== itemCount) learningValidation.invalid();
  const items: T[] = [];
  for (let index = 0; index < itemInputs.length; index += 1) {
    items[index] = cloneAndFreeze(learningValidation.dataRecord(itemInputs[index])) as T;
  }
  const seenEntityKeys = stringArray(row.seenEntityKeys, maxItems);
  if (seenEntityKeys.length !== itemCount) learningValidation.invalid();
  const complete = learningValidation.integer(row.complete, 0, 1) as LearningIntegerBoolean;
  const expectedPageToken = token(row.expectedPageToken);
  if ((complete === 1 && expectedPageToken !== null) || (complete === 0 && pageCount > 0 && expectedPageToken === null)) {
    learningValidation.invalid();
  }
  return Object.freeze({
    scope: normalizeLearningPageScope(row.scope),
    deadlineAt: learningValidation.timestamp(row.deadlineAt),
    maxPages,
    maxItems,
    maxBytes,
    pageCount,
    itemCount,
    responseBytes,
    expectedPageToken,
    seenPageTokens: stringArray(row.seenPageTokens, maxPages, true),
    seenEntityKeys,
    items: Object.freeze(items),
    complete,
  });
}

export function createLearningPageSequence<T extends object>(
  rawContext: LearningOperationContext,
): LearningPageSequence<T> {
  const context = normalizeLearningOperationContext(rawContext);
  return Object.freeze({
    scope: context.scope,
    deadlineAt: context.deadlineAt,
    maxPages: context.maxPages,
    maxItems: context.maxItems,
    maxBytes: context.maxBytes,
    pageCount: 0,
    itemCount: 0,
    responseBytes: 0,
    expectedPageToken: null,
    seenPageTokens: Object.freeze([] as string[]),
    seenEntityKeys: Object.freeze([] as string[]),
    items: Object.freeze([] as T[]),
    complete: 0,
  });
}

function safeSubjectKey<T extends object>(item: T, contract: LearningPageSequenceContract<T>): string {
  try {
    return learningValidation.boundedString(
      contract.subjectKey(item),
      1,
      LEARNING_LIMITS.urlBytes,
      false,
    );
  } catch {
    return learningValidation.invalid();
  }
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
  rawPage: LearningProviderPage<T>,
  contract: LearningPageSequenceContract<T>,
  rawContext: LearningOperationContext,
  nowEpochMs: number,
): LearningPageSequence<T> {
  const context = normalizeLearningOperationContext(rawContext);
  const state = normalizeLearningPageSequence<T>(rawState);
  if (
    !sameScope(state.scope, context.scope)
    || state.deadlineAt !== context.deadlineAt
    || state.maxPages !== context.maxPages
    || state.maxItems !== context.maxItems
    || state.maxBytes !== context.maxBytes
    || !Number.isSafeInteger(nowEpochMs)
    || nowEpochMs < 0
    || nowEpochMs >= Date.parse(context.deadlineAt)
    || isCancelled(context.signal)
    || state.complete === 1
  ) learningValidation.invalid();

  const page = normalizeLearningPage(rawPage, {
    normalizeItem(value) {
      return learningValidation.dataRecord(value) as T;
    },
    subjectKey(item) {
      return safeSubjectKey(item, contract);
    },
  });
  if (
    page.pageNumber !== state.pageCount + 1
    || page.requestPageToken !== state.expectedPageToken
  ) learningValidation.invalid();

  const nextPageCount = state.pageCount + 1;
  const nextItemCount = state.itemCount + page.items.length;
  const nextResponseBytes = state.responseBytes + page.responseBytes;
  if (
    nextPageCount > context.maxPages
    || nextItemCount > context.maxItems
    || nextResponseBytes > context.maxBytes
  ) learningValidation.invalid();

  const seenKeys = new Set(state.seenEntityKeys);
  const pairs: Array<{ key: string; item: T }> = [];
  for (let index = 0; index < state.items.length; index += 1) {
    if (!itemMatchesScope(state.items[index], context.scope)) learningValidation.invalid();
    const key = safeSubjectKey(state.items[index], contract);
    if (key !== state.seenEntityKeys[index]) learningValidation.invalid();
    pairs[index] = { key, item: state.items[index] };
  }
  for (let index = 0; index < page.items.length; index += 1) {
    const item = page.items[index];
    if (!itemMatchesScope(item, context.scope)) learningValidation.invalid();
    const key = safeSubjectKey(item, contract);
    if (seenKeys.has(key)) learningValidation.invalid();
    seenKeys.add(key);
    pairs[pairs.length] = { key, item };
  }
  pairs.sort((left, right) => compareCodeUnits(left.key, right.key));
  const items: T[] = [];
  const entityKeys: string[] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    items[index] = pairs[index].item;
    entityKeys[index] = pairs[index].key;
  }

  const pageTokens = [...state.seenPageTokens];
  if (page.nextPageToken !== null) {
    if (pageTokens.includes(page.nextPageToken)) learningValidation.invalid();
    pageTokens[pageTokens.length] = page.nextPageToken;
  }
  return Object.freeze({
    scope: context.scope,
    deadlineAt: context.deadlineAt,
    maxPages: context.maxPages,
    maxItems: context.maxItems,
    maxBytes: context.maxBytes,
    pageCount: nextPageCount,
    itemCount: nextItemCount,
    responseBytes: nextResponseBytes,
    expectedPageToken: page.nextPageToken,
    seenPageTokens: Object.freeze(pageTokens),
    seenEntityKeys: Object.freeze(entityKeys),
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
