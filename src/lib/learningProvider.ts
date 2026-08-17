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
  type LearningProviderErrorMetadata,
  type LearningProviderKind,
  type LearningProviderSubject,
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
  readonly nextPageToken: string | null;
  readonly pageNumber: number;
  readonly responseBytes: number;
}

export interface LearningPageContract<T extends object> {
  readonly normalizeItem: (value: unknown) => T;
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
  healthCheck(subject: LearningProviderSubject): Promise<LearningProviderHealth>;
  listCourses(subject: LearningProviderSubject, page: LearningPageRequest): Promise<LearningProviderPage<LearningCourse>>;
  syncCourse(subject: LearningCourseSubject): Promise<LearningCourse>;
  syncEnrollments(subject: LearningCourseSubject, page: LearningPageRequest): Promise<LearningProviderPage<LearningEnrollment>>;
  syncActivities(subject: LearningCourseSubject, page: LearningPageRequest): Promise<LearningProviderPage<LearningActivity>>;
  syncSubmissions(subject: LearningActivitySubject, page: LearningPageRequest): Promise<LearningProviderPage<LearningSubmissionSnapshot>>;
  buildLaunchUrl(subject: LearningCourseSubject | LearningActivitySubject): Promise<string>;
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
      return Object.freeze(value.map((item) => cloneAndFreeze(item, state, depth + 1)));
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
  const row = learningValidation.exactRecord(value, ['items', 'nextPageToken', 'pageNumber', 'responseBytes']);
  const rawItems = row.items;
  if (!Array.isArray(rawItems) || rawItems.length > LEARNING_LIMITS.maxPageItems) learningValidation.invalid();
  const itemInputs = rawItems as unknown[];
  const pageNumber = learningValidation.integer(row.pageNumber, 1, LEARNING_LIMITS.maxPages);
  const responseBytes = learningValidation.integer(row.responseBytes, 0, LEARNING_LIMITS.maxPageBytes);
  const byKey = new Map<string, { item: T; json: string }>();
  for (const rawItem of itemInputs) {
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
    nextPageToken: token(row.nextPageToken),
    pageNumber,
    responseBytes,
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
