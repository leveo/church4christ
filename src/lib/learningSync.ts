import type { AppDb } from './appDb';
import {
  LearningIdentityConflictError,
  LEARNING_MAX_ATOMIC_ENTITIES,
  LearningPersistenceError,
  LearningSyncConflictError,
  completeLearningCourseSync,
  failLearningSync,
  recoverExpiredLearningSync,
  startLearningSync,
  type LearningSyncCompletion,
  type LearningSyncLease,
  type ResolvedLearningEnrollment,
  type ResolvedLearningSubmission,
} from './learningDb';
import {
  LEARNING_LIMITS,
  LearningProviderError,
  learningActivitySubjectKey,
  learningProviderEnrollmentSubjectKey,
  learningProviderSubmissionSubjectKey,
  learningResourceSubjectKey,
  learningValidation,
  normalizeLearningConnectionUrlPolicy,
  type LearningConnectionUrlPolicy,
  type LearningCourse,
  type LearningErrorCode,
  type LearningProviderEnrollment,
  type LearningProviderKind,
  type LearningProviderSubmission,
  type LearningResource,
  type LearningSyncTrigger,
} from './learningModel';
import {
  invokeLearningProvider,
  normalizeLearningOperationContext,
  type LearningOperationContext,
  type LearningPageRequest,
  type LearningProvider,
  type LearningProviderPage,
} from './learningProvider';

export class LearningSynchronizationError extends Error {
  readonly code: LearningErrorCode;
  readonly provider: LearningProviderKind;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: LearningErrorCode,
    provider: LearningProviderKind,
    metadata: { readonly httpStatus: number | null; readonly retryAfterSeconds: number | null } = {
      httpStatus: null, retryAfterSeconds: null,
    },
  ) {
    super(code);
    this.name = 'LearningSynchronizationError';
    this.code = code;
    this.provider = provider;
    this.httpStatus = metadata.httpStatus;
    this.retryAfterSeconds = metadata.retryAfterSeconds;
    Object.freeze(this);
  }
}

export interface LearningIdentityResolutionSubject {
  readonly connectionId: number;
  readonly provider: LearningProviderKind;
  readonly externalCourseId: string;
  readonly externalUserId: string;
  readonly externalEnrollmentId: string;
}

export interface LearningIdentityResolution {
  readonly personId: number;
}

export interface SynchronizeLearningCourseInput {
  readonly provider: LearningProvider;
  readonly urlPolicy: LearningConnectionUrlPolicy;
  readonly connectionId: number;
  readonly providerKind: LearningProviderKind;
  readonly courseId: number;
  readonly externalCourseId: string;
  readonly trigger: LearningSyncTrigger;
  readonly operation: LearningOperationContext;
  readonly now: () => number;
  readonly resolvePerson: (
    subject: LearningIdentityResolutionSubject,
  ) => Promise<LearningIdentityResolution | null>;
}

interface GlobalBudget {
  pageCount: number;
  itemCount: number;
  rawBytes: number;
  normalizedBytes: number;
  uniquenessBytes: number;
  readonly keys: Set<string>;
}

function safeNow(now: () => number, providerKind: LearningProviderKind): number {
  let value: unknown;
  try { value = now(); } catch { throw new LearningSynchronizationError('invalid_request', providerKind); }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LearningSynchronizationError('invalid_request', providerKind);
  }
  return value as number;
}

function checkActive(operation: LearningOperationContext, now: () => number): void {
  if (operation.signal.aborted) throw new LearningSynchronizationError('cancelled', operation.scope.provider);
  if (safeNow(now, operation.scope.provider) >= Date.parse(operation.deadlineAt)) {
    throw new LearningSynchronizationError('timeout', operation.scope.provider);
  }
}

function scopedOperation(
  base: LearningOperationContext,
  externalActivityId: string | null,
  externalEnrollmentId: string | null,
  now: () => number,
): LearningOperationContext {
  try {
    return normalizeLearningOperationContext({
      ...base,
      scope: {
        provider: base.scope.provider,
        connectionId: base.scope.connectionId,
        externalCourseId: base.scope.externalCourseId,
        externalActivityId,
        externalEnrollmentId,
      },
    }, safeNow(now, base.scope.provider));
  } catch (error) {
    if (error instanceof LearningSynchronizationError) throw error;
    throw new LearningSynchronizationError('invalid_request', base.scope.provider);
  }
}

function addPageToBudget<T extends object>(
  page: LearningProviderPage<T>,
  operation: LearningOperationContext,
  budget: GlobalBudget,
  uniquenessKey: (item: T) => string,
  entityKind: 'enrollment' | 'activity' | 'resource' | 'submission',
): void {
  budget.pageCount += 1;
  budget.rawBytes += page.responseBytes;
  if (budget.pageCount > operation.maxPages || budget.rawBytes > operation.maxRawBytes) {
    throw new LearningSynchronizationError('pagination_limit', operation.scope.provider);
  }
  for (const item of page.items) {
    let json: string;
    let key: string;
    try {
      json = JSON.stringify(item);
      key = JSON.stringify([entityKind, uniquenessKey(item)]);
    } catch {
      throw new LearningSynchronizationError('malformed_response', operation.scope.provider);
    }
    const itemBytes = learningValidation.utf8Bytes(json);
    const keyBytes = learningValidation.utf8Bytes(key);
    budget.itemCount += 1;
    budget.normalizedBytes += itemBytes;
    if (!budget.keys.has(key)) {
      budget.keys.add(key);
      budget.uniquenessBytes += keyBytes;
    } else {
      throw new LearningSynchronizationError('malformed_response', operation.scope.provider);
    }
    if (
      budget.itemCount > operation.maxItems
      || budget.normalizedBytes > operation.maxNormalizedBytes
      || budget.uniquenessBytes > operation.maxUniqueKeyBytes
    ) throw new LearningSynchronizationError('pagination_limit', operation.scope.provider);
  }
}

async function collectPages<T extends object>(options: {
  readonly operation: LearningOperationContext;
  readonly now: () => number;
  readonly budget: GlobalBudget;
  readonly call: (page: LearningPageRequest, operation: LearningOperationContext) => Promise<LearningProviderPage<T>>;
  readonly uniquenessKey: (item: T) => string;
  readonly entityKind: 'enrollment' | 'activity' | 'resource' | 'submission';
}): Promise<readonly T[]> {
  let pageNumber = 1;
  let pageToken: string | null = null;
  const seenTokens = new Set<string>();
  const items: T[] = [];
  while (true) {
    checkActive(options.operation, options.now);
    if (options.budget.pageCount >= options.operation.maxPages) {
      throw new LearningSynchronizationError('pagination_limit', options.operation.scope.provider);
    }
    const request = Object.freeze({
      pageSize: Math.min(LEARNING_LIMITS.maxPageItems, options.operation.maxItems),
      pageNumber,
      pageToken,
    });
    const page = await options.call(request, options.operation);
    addPageToBudget(page, options.operation, options.budget, options.uniquenessKey, options.entityKind);
    items.push(...page.items);
    if (page.nextPageToken === null) return Object.freeze(items);
    if (seenTokens.has(page.nextPageToken)) {
      throw new LearningSynchronizationError('malformed_response', options.operation.scope.provider);
    }
    seenTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
    pageNumber += 1;
    if (pageNumber > LEARNING_LIMITS.maxPages) {
      throw new LearningSynchronizationError('pagination_limit', options.operation.scope.provider);
    }
  }
}

function subjectFor(operation: LearningOperationContext) {
  if (operation.scope.externalCourseId === null) {
    throw new LearningSynchronizationError('invalid_request', operation.scope.provider);
  }
  return Object.freeze({
    connectionId: operation.scope.connectionId,
    provider: operation.scope.provider,
    externalCourseId: operation.scope.externalCourseId,
  });
}

async function resolveEnrollments(
  enrollments: readonly LearningProviderEnrollment[],
  resolver: SynchronizeLearningCourseInput['resolvePerson'],
  operation: LearningOperationContext,
  now: () => number,
): Promise<readonly ResolvedLearningEnrollment[]> {
  const resolved: ResolvedLearningEnrollment[] = [];
  for (const providerEnrollment of enrollments) {
    let result: unknown;
    try {
      const resolution = Promise.resolve().then(() => resolver(Object.freeze({
        connectionId: providerEnrollment.connectionId,
        provider: providerEnrollment.provider,
        externalCourseId: providerEnrollment.externalCourseId,
        externalUserId: providerEnrollment.externalUserId,
        externalEnrollmentId: providerEnrollment.externalEnrollmentId,
      })));
      result = await raceWithOperation(resolution, operation, now);
    } catch (error) {
      if (error instanceof LearningSynchronizationError) throw error;
      throw new LearningSynchronizationError('provider_unavailable', operation.scope.provider);
    }
    if (result === null) continue;
    try {
      const row = learningValidation.exactRecord(result, ['personId']);
      const personId = learningValidation.integer(row.personId, 1, LEARNING_LIMITS.databaseInteger);
      resolved.push(Object.freeze({ providerEnrollment, personId }));
    } catch {
      throw new LearningSynchronizationError('malformed_response', operation.scope.provider);
    }
  }
  return Object.freeze(resolved);
}

async function raceWithOperation<T>(
  action: Promise<T>,
  operation: LearningOperationContext,
  now: () => number,
): Promise<T> {
  checkActive(operation, now);
  const remaining = Date.parse(operation.deadlineAt) - safeNow(now, operation.scope.provider);
  if (remaining <= 0) throw new LearningSynchronizationError('timeout', operation.scope.provider);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abortHandler = () => reject(new LearningSynchronizationError('cancelled', operation.scope.provider));
    operation.signal.addEventListener('abort', abortHandler, { once: true });
    if (operation.signal.aborted) abortHandler();
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new LearningSynchronizationError('timeout', operation.scope.provider)),
      remaining,
    );
  });
  try {
    const value = await Promise.race([action, cancelled, deadline]);
    checkActive(operation, now);
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortHandler) operation.signal.removeEventListener('abort', abortHandler);
  }
}

function resolvedSubmissions(
  submissions: readonly LearningProviderSubmission[],
  enrollments: readonly ResolvedLearningEnrollment[],
  providerKind: LearningProviderKind,
): readonly ResolvedLearningSubmission[] {
  const enrollmentById = new Map(enrollments.map((item) => [
    item.providerEnrollment.externalEnrollmentId, item,
  ]));
  const resolved: ResolvedLearningSubmission[] = [];
  for (const providerSubmission of submissions) {
    const enrollment = enrollmentById.get(providerSubmission.externalEnrollmentId);
    if (!enrollment) continue;
    if (enrollment.providerEnrollment.externalUserId !== providerSubmission.externalUserId) {
      throw new LearningSynchronizationError('malformed_response', providerKind);
    }
    resolved.push(Object.freeze({ providerSubmission, personId: enrollment.personId }));
  }
  return Object.freeze(resolved);
}

function classify(error: unknown, providerKind: LearningProviderKind): LearningSynchronizationError {
  if (error instanceof LearningSynchronizationError) return error;
  if (error instanceof LearningProviderError) return new LearningSynchronizationError(error.code, providerKind, {
    httpStatus: error.httpStatus, retryAfterSeconds: error.retryAfterSeconds,
  });
  if (error instanceof LearningIdentityConflictError) return new LearningSynchronizationError('malformed_response', providerKind);
  if (error instanceof LearningPersistenceError) return new LearningSynchronizationError('provider_unavailable', providerKind);
  if (error instanceof LearningSyncConflictError) return new LearningSynchronizationError('invalid_request', providerKind);
  return new LearningSynchronizationError('provider_unavailable', providerKind);
}

export async function synchronizeLearningCourse(
  db: AppDb,
  rawInput: SynchronizeLearningCourseInput,
): Promise<LearningSyncCompletion> {
  let ownLease: LearningSyncLease | null = null;
  let providerKind: LearningProviderKind = 'canvas';
  let now: (() => number) = () => Date.now();
  try {
    try {
      if (rawInput && typeof rawInput === 'object') {
        const descriptor = Object.getOwnPropertyDescriptor(rawInput, 'providerKind');
        if (descriptor && 'value' in descriptor
          && (descriptor.value === 'google_classroom' || descriptor.value === 'canvas')) {
          providerKind = descriptor.value;
        }
      }
    } catch { /* the exact validator below owns malformed objects */ }
    let input: Record<string, unknown>;
    try {
      input = learningValidation.exactRecord(rawInput, [
        'provider', 'urlPolicy', 'connectionId', 'providerKind', 'courseId', 'externalCourseId',
        'trigger', 'operation', 'now', 'resolvePerson',
      ]);
    } catch {
      throw new LearningSynchronizationError('invalid_request', providerKind);
    }
    providerKind = learningValidation.oneOf(input.providerKind, ['google_classroom', 'canvas'] as const);
    const connectionId = learningValidation.integer(input.connectionId, 1, LEARNING_LIMITS.databaseInteger);
    const courseId = learningValidation.integer(input.courseId, 1, LEARNING_LIMITS.databaseInteger);
    const externalCourseId = learningValidation.externalId(input.externalCourseId);
    const trigger = learningValidation.oneOf(input.trigger, ['manual', 'scheduled', 'notification'] as const);
    if (typeof input.now !== 'function' || typeof input.resolvePerson !== 'function') {
      throw new LearningSynchronizationError('invalid_request', providerKind);
    }
    now = input.now as () => number;
    const current = safeNow(now, providerKind);
    let operation: LearningOperationContext;
    let urlPolicy: LearningConnectionUrlPolicy;
    try {
      operation = normalizeLearningOperationContext(input.operation, current);
      urlPolicy = normalizeLearningConnectionUrlPolicy(input.urlPolicy);
    } catch {
      throw new LearningSynchronizationError('invalid_request', providerKind);
    }
    if (
      operation.scope.provider !== providerKind
      || operation.scope.connectionId !== connectionId
      || operation.scope.externalCourseId !== externalCourseId
      || operation.scope.externalActivityId !== null
      || operation.scope.externalEnrollmentId !== null
      || urlPolicy.provider !== providerKind
      || urlPolicy.connectionId !== connectionId
      || operation.maxItems > LEARNING_MAX_ATOMIC_ENTITIES
    ) throw new LearningSynchronizationError('invalid_request', providerKind);

    ownLease = await startLearningSync(db, {
      connectionId, provider: providerKind, courseId, externalCourseId,
      trigger, startedAt: operation.startedAt, urlPolicy, leaseExpiresAt: operation.deadlineAt,
    });
    checkActive(operation, now);
    const providerAdapter = input.provider as LearningProvider;
    const courseSubject = subjectFor(operation);
    const courseValue = await invokeLearningProvider(providerAdapter, {
      method: 'syncCourse', request: { subject: courseSubject, operation }, now, urlPolicy,
    });
    const budget: GlobalBudget = {
      pageCount: 0, itemCount: 0, rawBytes: 0, normalizedBytes: 0, uniquenessBytes: 0,
      keys: new Set<string>(),
    };
    const enrollments = await collectPages({
      operation, now, budget,
      call: (page, childOperation) => invokeLearningProvider(providerAdapter, {
        method: 'syncEnrollments', request: { subject: courseSubject, page, operation: childOperation }, now,
      }),
      uniquenessKey: learningProviderEnrollmentSubjectKey,
      entityKind: 'enrollment',
    });
    const activities = await collectPages({
      operation, now, budget,
      call: (page, childOperation) => invokeLearningProvider(providerAdapter, {
        method: 'syncActivities', request: { subject: courseSubject, page, operation: childOperation }, now, urlPolicy,
      }),
      uniquenessKey: learningActivitySubjectKey,
      entityKind: 'activity',
    });

    const resources: LearningResource[] = [];
    const submissions: LearningProviderSubmission[] = [];
    for (const activity of activities) {
      const activityOperation = scopedOperation(operation, activity.externalActivityId, null, now);
      const activitySubject = Object.freeze({
        ...courseSubject, externalActivityId: activity.externalActivityId,
      });
      resources.push(...await collectPages({
        operation: activityOperation, now, budget,
        call: (page, childOperation) => invokeLearningProvider(providerAdapter, {
          method: 'syncResources', request: { subject: activitySubject, page, operation: childOperation }, now, urlPolicy,
        }),
        uniquenessKey: learningResourceSubjectKey,
        entityKind: 'resource',
      }));
      if (activity.kind === 'assignment' || activity.kind === 'quiz') {
        submissions.push(...await collectPages({
          operation: activityOperation, now, budget,
          call: (page, childOperation) => invokeLearningProvider(providerAdapter, {
            method: 'syncSubmissions', request: {
              subject: { ...activitySubject, externalEnrollmentId: null }, page, operation: childOperation,
            }, now,
          }),
          uniquenessKey: learningProviderSubmissionSubjectKey,
          entityKind: 'submission',
        }));
      }
    }
    const resolvedEnrollments = await resolveEnrollments(
      enrollments, input.resolvePerson as SynchronizeLearningCourseInput['resolvePerson'], operation, now,
    );
    checkActive(operation, now);
    const resolvedSubmissionValues = resolvedSubmissions(submissions, resolvedEnrollments, providerKind);
    checkActive(operation, now);
    const syncedAt = new Date(safeNow(now, providerKind)).toISOString();
    return await completeLearningCourseSync(db, ownLease, {
      course: courseValue as LearningCourse, urlPolicy, syncedAt,
      enrollments: resolvedEnrollments, activities, resources,
      submissions: resolvedSubmissionValues,
    }, () => checkActive(operation, now));
  } catch (error) {
    const safe = classify(error, providerKind);
    if (ownLease !== null) {
      let finishedAt = ownLease.leaseExpiresAt;
      try {
        finishedAt = new Date(safeNow(now, providerKind)).toISOString();
      } catch { /* preserve the original classified failure and use the bounded lease deadline */ }
      try {
        if (Date.parse(finishedAt) >= Date.parse(ownLease.leaseExpiresAt)) {
          await recoverExpiredLearningSync(db, ownLease, { finishedAt, errorCode: safe.code });
        } else {
          await failLearningSync(db, ownLease, { finishedAt, errorCode: safe.code });
        }
      } catch {
        throw new LearningSynchronizationError('provider_unavailable', providerKind);
      }
    }
    throw safe;
  }
}
