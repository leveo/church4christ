import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  LEARNING_PROVIDERS,
  LEARNING_SYNC_STATUSES,
  LEARNING_SYNC_TRIGGERS,
  LearningProviderError,
  learningActivitySubjectKey,
  learningCourseSubjectKey,
  learningProviderEnrollmentSubjectKey,
  learningProviderSubmissionSubjectKey,
  learningResourceSubjectKey,
  learningValidation,
  normalizeLearningActivity,
  normalizeLearningConnectionUrlPolicy,
  normalizeLearningCourse,
  normalizeLearningLaunchContract,
  normalizeLearningProviderEnrollment,
  normalizeLearningProviderSubmission,
  normalizeLearningProviderErrorMetadata,
  normalizeLearningResource,
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
  type LearningProviderSubmission,
  type LearningProviderSubject,
  type LearningResource,
  type LearningSyncStatus,
  type LearningSyncTrigger,
} from './learningModel';

const BYTE_MEASUREMENT_BRAND: unique symbol = Symbol('LearningByteMeasurement');
const PAGE_OWNER_TOKEN: unique symbol = Symbol('LearningProviderPageOwner');

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

/** Opaque proof created only after actual response bytes are streamed and counted. */
interface LearningByteMeasurement {
  readonly [BYTE_MEASUREMENT_BRAND]: true;
  readonly byteCount: number;
}

interface LearningPageProof {
  readonly measurement: LearningByteMeasurement;
  readonly kind: LearningPageResponseContract['kind'];
  readonly scope: LearningPageScope;
  readonly policyFingerprint: string | null;
}

interface LearningPageContract<T extends object> {
  readonly normalizeItem: (value: unknown) => T;
  readonly subjectKey: (value: T) => string;
}

export interface LearningCoursesPageResponseContract {
  readonly kind: 'courses';
  readonly urlPolicy: LearningConnectionUrlPolicy;
}

export interface LearningProviderEnrollmentsPageResponseContract {
  readonly kind: 'provider_enrollments';
}

export interface LearningActivitiesPageResponseContract {
  readonly kind: 'activities';
  readonly urlPolicy: LearningConnectionUrlPolicy;
}

export interface LearningResourcesPageResponseContract {
  readonly kind: 'resources';
  readonly urlPolicy: LearningConnectionUrlPolicy;
}

export interface LearningProviderSubmissionsPageResponseContract {
  readonly kind: 'provider_submissions';
}

/** Closed module-owned selection of exact provider-neutral page contracts. */
export type LearningPageResponseContract =
  | LearningCoursesPageResponseContract
  | LearningProviderEnrollmentsPageResponseContract
  | LearningActivitiesPageResponseContract
  | LearningResourcesPageResponseContract
  | LearningProviderSubmissionsPageResponseContract;

export type LearningStrictProviderPage =
  | LearningProviderPage<LearningCourse>
  | LearningProviderPage<LearningProviderEnrollment>
  | LearningProviderPage<LearningActivity>
  | LearningProviderPage<LearningResource>
  | LearningProviderPage<LearningProviderSubmission>;

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
  accept(page: LearningProviderPage<T>, currentTimeEpochMs: number): LearningPageAccumulator<T>;
}

export interface LearningPageSequenceContract<T extends object> {
  readonly page: LearningPageResponseContract;
  readonly normalizeItem: (value: unknown) => T;
  readonly uniquenessKeys: (value: T) => readonly string[];
}

export const LEARNING_MAX_OPERATION_DURATION_MS = 3_600_000;

export interface LearningHealthRequest {
  readonly subject: LearningProviderSubject;
  readonly operation: LearningOperationContext;
}

/** Raw notification data is request-only and never appears in a result. */
export interface LearningNormalizeNotificationRequest extends LearningHealthRequest {
  readonly payload: unknown;
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
  syncEnrollments(request: LearningSyncEnrollmentsRequest): Promise<LearningProviderPage<LearningProviderEnrollment>>;
  syncActivities(request: LearningSyncActivitiesRequest): Promise<LearningProviderPage<LearningActivity>>;
  syncResources(request: LearningSyncResourcesRequest): Promise<LearningProviderPage<LearningResource>>;
  syncSubmissions(request: LearningSyncSubmissionsRequest): Promise<LearningProviderPage<LearningProviderSubmission>>;
  buildLaunchUrl(request: LearningBuildLaunchRequest): Promise<LearningLaunchContract>;
  normalizeNotification(request: LearningNormalizeNotificationRequest): Promise<LearningProviderNotification | null>;
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

function byteMeasurement(value: unknown): LearningByteMeasurement {
  try {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      learningValidation.invalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 2
      || !keys.includes(BYTE_MEASUREMENT_BRAND)
      || !keys.includes('byteCount')
      || descriptors[BYTE_MEASUREMENT_BRAND]?.value !== true
      || !descriptors.byteCount
      || !('value' in descriptors.byteCount)
      || !Object.isFrozen(value)
    ) learningValidation.invalid();
    learningValidation.integer(descriptors.byteCount.value, 0, LEARNING_LIMITS.maxSyncBytes);
    return value as LearningByteMeasurement;
  } catch {
    return learningValidation.invalid();
  }
}

type NormalizedPageData<T extends object> = LearningProviderPage<T>;

/**
 * Concrete ownership is deliberately module-private. Copying every visible
 * descriptor or the prototype cannot copy an ECMAScript private field, so a
 * page proof is bound to the exact instance that the closed stream boundary
 * constructed.
 */
class ConcreteLearningProviderPage<T extends object> implements LearningProviderPage<T> {
  readonly items: readonly T[];
  readonly requestPageToken: string | null;
  readonly nextPageToken: string | null;
  readonly pageNumber: number;
  readonly responseBytes: number;
  readonly #proof: LearningPageProof;

  constructor(
    value: NormalizedPageData<T>,
    proof: LearningPageProof,
    ownerToken: typeof PAGE_OWNER_TOKEN,
  ) {
    if (ownerToken !== PAGE_OWNER_TOKEN) learningValidation.invalid();
    this.items = value.items;
    this.requestPageToken = value.requestPageToken;
    this.nextPageToken = value.nextPageToken;
    this.pageNumber = value.pageNumber;
    this.responseBytes = value.responseBytes;
    this.#proof = proof;
    Object.freeze(this);
  }

  readProof(ownerToken: typeof PAGE_OWNER_TOKEN): LearningPageProof {
    if (ownerToken !== PAGE_OWNER_TOKEN) learningValidation.invalid();
    return this.#proof;
  }
}

const readConcretePageProof = ConcreteLearningProviderPage.prototype.readProof;
Object.freeze(ConcreteLearningProviderPage.prototype);

function concretePageProof(value: unknown): LearningPageProof {
  try {
    if (
      !(value instanceof ConcreteLearningProviderPage)
      || Object.getPrototypeOf(value) !== ConcreteLearningProviderPage.prototype
      || !Object.isFrozen(value)
    ) learningValidation.invalid();
    return Reflect.apply(readConcretePageProof, value, [PAGE_OWNER_TOKEN]) as LearningPageProof;
  } catch {
    return learningValidation.invalid();
  }
}

function brandedPage<T extends object>(
  value: NormalizedPageData<T>,
  proof: LearningPageProof,
): LearningProviderPage<T> {
  return new ConcreteLearningProviderPage(value, proof, PAGE_OWNER_TOKEN);
}

function revalidateLearningPage<T extends object>(
  value: unknown,
  contract: LearningPageContract<T>,
  expectedProof: LearningPageProofExpectation,
): LearningProviderPage<T> {
  try {
    const proof = concretePageProof(value);
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 5
      || keys.some((key) => typeof key !== 'string')
    ) learningValidation.invalid();
    requireExpectedPageProof(proof, expectedProof);
    const stringKeys = ['items', 'requestPageToken', 'nextPageToken', 'pageNumber', 'responseBytes'] as const;
    const row: Record<(typeof stringKeys)[number], unknown> = Object.create(null) as Record<
      (typeof stringKeys)[number], unknown
    >;
    for (let index = 0; index < stringKeys.length; index += 1) {
      const key = stringKeys[index];
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) learningValidation.invalid();
      row[key] = descriptor.value;
    }
    if (row.responseBytes !== proof.measurement.byteCount) learningValidation.invalid();
    const normalized = normalizeLearningPageCandidate({
      items: row.items,
      requestPageToken: row.requestPageToken,
      nextPageToken: row.nextPageToken,
      pageNumber: row.pageNumber,
    }, proof.measurement, contract);
    return brandedPage(normalized, proof);
  } catch {
    return learningValidation.invalid();
  }
}

function normalizeLearningPageCandidate<T extends object>(
  value: unknown,
  measurement: LearningByteMeasurement,
  contract: LearningPageContract<T>,
): NormalizedPageData<T> {
  const callbacks = contractCallbacks(contract, ['normalizeItem', 'subjectKey']);
  const verifiedMeasurement = byteMeasurement(measurement);
  const row = learningValidation.exactRecord(value, [
    'items', 'requestPageToken', 'nextPageToken', 'pageNumber',
  ]);
  const itemInputs = learningValidation.dataArray(row.items, LEARNING_LIMITS.maxPageItems);
  const pageNumber = learningValidation.integer(row.pageNumber, 1, LEARNING_LIMITS.maxPages);
  const responseBytes = learningValidation.integer(
    verifiedMeasurement.byteCount, 0, LEARNING_LIMITS.maxPageBytes,
  );
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
  return Object.freeze({
    items,
    requestPageToken: token(row.requestPageToken),
    nextPageToken: token(row.nextPageToken),
    pageNumber,
    responseBytes,
  });
}

type ClosedPageContract = {
  readonly kind: LearningPageResponseContract['kind'];
  readonly policy: LearningConnectionUrlPolicy | null;
  readonly page: LearningPageContract<object>;
};

interface LearningPageProofExpectation {
  readonly kind: LearningPageResponseContract['kind'];
  readonly scope: LearningPageScope;
  readonly policyFingerprint: string | null;
}

function urlPolicyFingerprint(policy: LearningConnectionUrlPolicy): string {
  const sorted = (values: readonly string[]): readonly string[] => Object.freeze([...values].sort(compareCodeUnits));
  const fingerprint = canonicalJson({
    provider: policy.provider,
    connectionId: policy.connectionId,
    baseUrl: policy.baseUrl,
    providerLaunchOrigins: sorted(policy.providerLaunchOrigins),
    providerFileOrigins: sorted(policy.providerFileOrigins),
    externalLinkOrigins: sorted(policy.externalLinkOrigins),
  });
  if (learningValidation.utf8Bytes(fingerprint) > LEARNING_LIMITS.maxSyncBytes) learningValidation.invalid();
  return fingerprint;
}

function expectedPageProof(
  operation: LearningOperationContext,
  contract: ClosedPageContract,
): LearningPageProofExpectation {
  const scope = operation.scope;
  if (contract.policy !== null && (
    contract.policy.provider !== scope.provider
    || contract.policy.connectionId !== scope.connectionId
  )) learningValidation.invalid();
  if (contract.kind === 'courses') {
    if (
      scope.externalCourseId !== null
      || scope.externalActivityId !== null
      || scope.externalEnrollmentId !== null
    ) learningValidation.invalid();
  } else if (contract.kind === 'provider_enrollments' || contract.kind === 'activities') {
    if (
      scope.externalCourseId === null
      || scope.externalActivityId !== null
      || scope.externalEnrollmentId !== null
    ) learningValidation.invalid();
  } else if (contract.kind === 'resources') {
    if (
      scope.externalCourseId === null
      || scope.externalActivityId === null
      || scope.externalEnrollmentId !== null
    ) learningValidation.invalid();
  } else if (scope.externalCourseId === null || scope.externalActivityId === null) {
    learningValidation.invalid();
  }
  return Object.freeze({
    kind: contract.kind,
    scope,
    policyFingerprint: contract.policy === null ? null : urlPolicyFingerprint(contract.policy),
  });
}

function makePageProof(
  measurement: LearningByteMeasurement,
  expected: LearningPageProofExpectation,
): LearningPageProof {
  return Object.freeze({
    measurement: byteMeasurement(measurement),
    kind: expected.kind,
    scope: expected.scope,
    policyFingerprint: expected.policyFingerprint,
  });
}

function requireExpectedPageProof(
  proof: LearningPageProof,
  expected: LearningPageProofExpectation,
): void {
  if (
    proof.kind !== expected.kind
    || !sameScope(proof.scope, expected.scope)
    || proof.policyFingerprint !== expected.policyFingerprint
  ) learningValidation.invalid();
}

function closedPageContract(value: unknown): ClosedPageContract {
  try {
    const discriminator = learningValidation.dataRecord(value);
    const kind = learningValidation.oneOf(discriminator.kind, [
      'courses', 'provider_enrollments', 'activities', 'resources', 'provider_submissions',
    ] as const);
    if (kind === 'courses') {
      const row = learningValidation.exactRecord(value, ['kind', 'urlPolicy']);
      const policy = normalizeLearningConnectionUrlPolicy(row.urlPolicy);
      return Object.freeze({
        kind,
        policy,
        page: Object.freeze({
          normalizeItem: (item: unknown) => normalizeLearningCourse(item, policy),
          subjectKey: (item: object) => learningCourseSubjectKey(item as LearningCourse),
        }),
      });
    }
    if (kind === 'provider_enrollments') {
      learningValidation.exactRecord(value, ['kind']);
      return Object.freeze({
        kind,
        policy: null,
        page: Object.freeze({
          normalizeItem: normalizeLearningProviderEnrollment,
          subjectKey: (item: object) => learningProviderEnrollmentSubjectKey(item as LearningProviderEnrollment),
        }),
      });
    }
    if (kind === 'activities') {
      const row = learningValidation.exactRecord(value, ['kind', 'urlPolicy']);
      const policy = normalizeLearningConnectionUrlPolicy(row.urlPolicy);
      return Object.freeze({
        kind,
        policy,
        page: Object.freeze({
          normalizeItem: (item: unknown) => normalizeLearningActivity(item, policy),
          subjectKey: (item: object) => learningActivitySubjectKey(item as LearningActivity),
        }),
      });
    }
    if (kind === 'resources') {
      const row = learningValidation.exactRecord(value, ['kind', 'urlPolicy']);
      const policy = normalizeLearningConnectionUrlPolicy(row.urlPolicy);
      return Object.freeze({
        kind,
        policy,
        page: Object.freeze({
          normalizeItem: (item: unknown) => normalizeLearningResource(item, policy),
          subjectKey: (item: object) => learningResourceSubjectKey(item as LearningResource),
        }),
      });
    }
    learningValidation.exactRecord(value, ['kind']);
    return Object.freeze({
      kind,
      policy: null,
      page: Object.freeze({
        normalizeItem: normalizeLearningProviderSubmission,
        subjectKey: (item: object) => learningProviderSubmissionSubjectKey(item as LearningProviderSubmission),
      }),
    });
  } catch {
    return learningValidation.invalid();
  }
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

export function normalizeLearningNormalizeNotificationRequest(
  value: unknown,
  now: number,
): LearningNormalizeNotificationRequest {
  const row = learningValidation.exactRecord(value, ['subject', 'payload', 'operation']);
  const subject = normalizeProviderSubject(row.subject);
  const operation = operationBoundToScope(row.operation, scopeForSubject(subject, null, null, null), now);
  return Object.freeze({ subject, payload: row.payload, operation });
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
  expectedProof: LearningPageProofExpectation,
): LearningPageAccumulator<T> {
  const view = accumulatorView(state);
  return Object.freeze({
    view,
    accept(rawPage: LearningProviderPage<T>, currentTimeEpochMs: number): LearningPageAccumulator<T> {
      const context = normalizeLearningOperationContext(state.context, currentTimeEpochMs);
      if (state.complete === 1 || isCancelled(context.signal)) learningValidation.invalid();
      const page = revalidateLearningPage(rawPage, {
        normalizeItem,
        subjectKey(item) {
          return safeUniquenessKeys(item, uniquenessKeys)[0];
        },
      }, expectedProof);
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
      }, normalizeItem, uniquenessKeys, expectedProof);
    },
  });
}

export function createLearningPageAccumulator<T extends object>(
  rawContext: LearningOperationContext,
  contract: LearningPageSequenceContract<T>,
): LearningPageAccumulator<T> {
  const contractRow = learningValidation.exactRecord(contract, ['page', 'normalizeItem', 'uniquenessKeys']);
  const callbacks = contractCallbacks(Object.freeze({
    normalizeItem: contractRow.normalizeItem,
    uniquenessKeys: contractRow.uniquenessKeys,
  }), ['normalizeItem', 'uniquenessKeys']);
  const contextRecord = learningValidation.dataRecord(rawContext);
  const startedAt = learningValidation.timestamp(contextRecord.startedAt);
  const context = normalizeLearningOperationContext(rawContext, Date.parse(startedAt));
  const expectedProof = expectedPageProof(context, closedPageContract(contractRow.page));
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
  }, callbacks.normalizeItem as (value: unknown) => T,
  callbacks.uniquenessKeys as (value: T) => readonly string[], expectedProof);
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

function makeByteMeasurement(value: unknown): LearningByteMeasurement {
  const result = {
    byteCount: learningValidation.integer(value, 0, LEARNING_LIMITS.maxSyncBytes),
  } as LearningByteMeasurement;
  Object.defineProperty(result, BYTE_MEASUREMENT_BRAND, { value: true });
  return Object.freeze(result);
}

interface DecodedLearningPageCandidate {
  readonly candidate: unknown;
  readonly measurement: LearningByteMeasurement;
  readonly operation: LearningOperationContext;
}

async function readDecodedLearningPageCandidate(
  response: Response,
  rawOperation: LearningOperationContext,
  decode: (value: unknown) => unknown,
  now: () => number,
): Promise<DecodedLearningPageCandidate> {
  let operation: LearningOperationContext;
  let provider: LearningProviderKind = 'canvas';
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    if (typeof decode !== 'function' || typeof now !== 'function') learningValidation.invalid();
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
    const responseLimit = Math.min(operation.maxRawBytes, LEARNING_LIMITS.maxPageBytes);
    const contentLengthValue = response.headers.get('Content-Length');
    let declaredLength: number | null = null;
    if (contentLengthValue !== null) {
      if (!/^(?:0|[1-9]\d*)$/u.test(contentLengthValue)) {
        throw providerFailure('malformed_response', provider);
      }
      declaredLength = Number(contentLengthValue);
      if (!Number.isSafeInteger(declaredLength)) throw providerFailure('malformed_response', provider);
      if (declaredLength > responseLimit) {
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
      if (byteCount > responseLimit) {
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
    let candidate: unknown;
    try {
      candidate = decode(parsed);
    } catch {
      throw providerFailure('malformed_response', provider);
    }
    return Object.freeze({
      candidate,
      measurement: makeByteMeasurement(byteCount),
      operation,
    });
  } catch (error) {
    if (error instanceof LearningProviderError) throw error;
    throw providerFailure('malformed_response', provider);
  }
}

/**
 * Streams and measures a supplied response, decodes provider JSON, and then
 * selects a module-owned exact provider-neutral page normalizer. Parsed JSON,
 * decoded candidates, and byte proof are never exposed separately.
 */
export function readAndNormalizeLearningPage(
  response: Response,
  operation: LearningOperationContext,
  decode: (value: unknown) => unknown,
  contract: LearningCoursesPageResponseContract,
  now: () => number,
): Promise<LearningProviderPage<LearningCourse>>;
export function readAndNormalizeLearningPage(
  response: Response,
  operation: LearningOperationContext,
  decode: (value: unknown) => unknown,
  contract: LearningProviderEnrollmentsPageResponseContract,
  now: () => number,
): Promise<LearningProviderPage<LearningProviderEnrollment>>;
export function readAndNormalizeLearningPage(
  response: Response,
  operation: LearningOperationContext,
  decode: (value: unknown) => unknown,
  contract: LearningActivitiesPageResponseContract,
  now: () => number,
): Promise<LearningProviderPage<LearningActivity>>;
export function readAndNormalizeLearningPage(
  response: Response,
  operation: LearningOperationContext,
  decode: (value: unknown) => unknown,
  contract: LearningResourcesPageResponseContract,
  now: () => number,
): Promise<LearningProviderPage<LearningResource>>;
export function readAndNormalizeLearningPage(
  response: Response,
  operation: LearningOperationContext,
  decode: (value: unknown) => unknown,
  contract: LearningProviderSubmissionsPageResponseContract,
  now: () => number,
): Promise<LearningProviderPage<LearningProviderSubmission>>;
export async function readAndNormalizeLearningPage(
  response: Response,
  operation: LearningOperationContext,
  decode: (value: unknown) => unknown,
  contract: LearningPageResponseContract,
  now: () => number,
): Promise<LearningStrictProviderPage> {
  let decoded: DecodedLearningPageCandidate | null = null;
  let provider: LearningProviderKind = 'canvas';
  try {
    decoded = await readDecodedLearningPageCandidate(response, operation, decode, now);
    provider = decoded.operation.scope.provider;
    const selected = closedPageContract(contract);
    const expected = expectedPageProof(decoded.operation, selected);
    const normalized = normalizeLearningPageCandidate(decoded.candidate, decoded.measurement, selected.page);
    for (let index = 0; index < normalized.items.length; index += 1) {
      if (!itemMatchesScope(normalized.items[index], decoded.operation.scope)) learningValidation.invalid();
    }
    return brandedPage(
      normalized,
      makePageProof(decoded.measurement, expected),
    ) as unknown as LearningStrictProviderPage;
  } catch (error) {
    if (error instanceof LearningProviderError) throw error;
    throw providerFailure('malformed_response', decoded?.operation.scope.provider ?? provider);
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
  | 'buildLaunchUrl'
  | 'normalizeNotification';

/** Method-specific invocation shapes keep URL policy roles explicit. */
export type LearningProviderInvocation =
  | { readonly method: 'healthCheck'; readonly request: LearningHealthRequest; readonly now: () => number }
  | {
    readonly method: 'listCourses'; readonly request: LearningListCoursesRequest;
    readonly now: () => number; readonly urlPolicy: LearningConnectionUrlPolicy;
  }
  | {
    readonly method: 'syncCourse'; readonly request: LearningSyncCourseRequest;
    readonly now: () => number; readonly urlPolicy: LearningConnectionUrlPolicy;
  }
  | { readonly method: 'syncEnrollments'; readonly request: LearningSyncEnrollmentsRequest; readonly now: () => number }
  | {
    readonly method: 'syncActivities'; readonly request: LearningSyncActivitiesRequest;
    readonly now: () => number; readonly urlPolicy: LearningConnectionUrlPolicy;
  }
  | {
    readonly method: 'syncResources'; readonly request: LearningSyncResourcesRequest;
    readonly now: () => number; readonly urlPolicy: LearningConnectionUrlPolicy;
  }
  | { readonly method: 'syncSubmissions'; readonly request: LearningSyncSubmissionsRequest; readonly now: () => number }
  | {
    readonly method: 'buildLaunchUrl'; readonly request: LearningBuildLaunchRequest;
    readonly now: () => number; readonly urlPolicy: LearningConnectionUrlPolicy;
  }
  | {
    readonly method: 'normalizeNotification'; readonly request: LearningNormalizeNotificationRequest;
    readonly now: () => number;
  };

export type LearningProviderInvocationResult =
  | LearningProviderHealth
  | LearningProviderPage<LearningCourse>
  | LearningCourse
  | LearningProviderPage<LearningProviderEnrollment>
  | LearningProviderPage<LearningActivity>
  | LearningProviderPage<LearningResource>
  | LearningProviderPage<LearningProviderSubmission>
  | LearningLaunchContract
  | LearningProviderNotification
  | null;

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
  call: (signal: AbortSignal) => Promise<T>,
  operation: LearningOperationContext,
  now: () => number,
): Promise<T> {
  const initialNow = now();
  activeProviderOperation(operation, initialNow);
  const remaining = Date.parse(operation.deadlineAt) - initialNow;
  const combinedController = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation.signal.removeEventListener('abort', abort);
      run();
    };
    const fail = (code: 'cancelled' | 'timeout'): void => {
      combinedController.abort();
      finish(() => reject(providerFailure(code, operation.scope.provider)));
    };
    const abort = (): void => fail('cancelled');
    const timer = setTimeout(
      () => fail('timeout'),
      Math.max(0, remaining),
    );
    operation.signal.addEventListener('abort', abort, { once: true });
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(call(combinedController.signal));
    } catch {
      finish(() => reject(providerFailure('provider_unavailable', operation.scope.provider)));
      return;
    }
    promise.then(
      (value) => {
        try {
          activeProviderOperation(operation, now());
          if (combinedController.signal.aborted) {
            throw providerFailure(operation.signal.aborted ? 'cancelled' : 'timeout', operation.scope.provider);
          }
          finish(() => resolve(value));
        } catch (error) {
          const safe = error instanceof LearningProviderError
            ? providerFailure(error.code, error.provider, error.httpStatus, error.retryAfterSeconds)
            : providerFailure('provider_unavailable', operation.scope.provider);
          combinedController.abort();
          finish(() => reject(safe));
        }
      },
      (error: unknown) => finish(() => reject(
        error instanceof LearningProviderError
          ? providerFailure(error.code, error.provider, error.httpStatus, error.retryAfterSeconds)
          : providerFailure('provider_unavailable', operation.scope.provider),
      )),
    );
  });
}

type ProviderAdapterRequest = LearningHealthRequest | LearningListCoursesRequest | LearningSyncCourseRequest
  | LearningSyncEnrollmentsRequest | LearningSyncActivitiesRequest | LearningSyncResourcesRequest
  | LearningSyncSubmissionsRequest | LearningBuildLaunchRequest | LearningNormalizeNotificationRequest;

function requestWithSignal<T extends ProviderAdapterRequest>(request: T, signal: AbortSignal): T {
  return Object.freeze({
    ...request,
    operation: Object.freeze({ ...request.operation, signal }),
  }) as T;
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
export function invokeLearningProvider(
  rawProvider: LearningProvider,
  invocation: Extract<LearningProviderInvocation, { method: 'healthCheck' }>,
): Promise<LearningProviderHealth>;
export function invokeLearningProvider(
  rawProvider: LearningProvider,
  invocation: Extract<LearningProviderInvocation, { method: 'listCourses' }>,
): Promise<LearningProviderPage<LearningCourse>>;
export function invokeLearningProvider(
  rawProvider: LearningProvider,
  invocation: Extract<LearningProviderInvocation, { method: 'syncCourse' }>,
): Promise<LearningCourse>;
export function invokeLearningProvider(
  rawProvider: LearningProvider,
  invocation: Extract<LearningProviderInvocation, { method: 'syncEnrollments' }>,
): Promise<LearningProviderPage<LearningProviderEnrollment>>;
export function invokeLearningProvider(
  rawProvider: LearningProvider,
  invocation: Extract<LearningProviderInvocation, { method: 'syncActivities' }>,
): Promise<LearningProviderPage<LearningActivity>>;
export function invokeLearningProvider(
  rawProvider: LearningProvider,
  invocation: Extract<LearningProviderInvocation, { method: 'syncResources' }>,
): Promise<LearningProviderPage<LearningResource>>;
export function invokeLearningProvider(
  rawProvider: LearningProvider,
  invocation: Extract<LearningProviderInvocation, { method: 'syncSubmissions' }>,
): Promise<LearningProviderPage<LearningProviderSubmission>>;
export function invokeLearningProvider(
  rawProvider: LearningProvider,
  invocation: Extract<LearningProviderInvocation, { method: 'buildLaunchUrl' }>,
): Promise<LearningLaunchContract>;
export function invokeLearningProvider(
  rawProvider: LearningProvider,
  invocation: Extract<LearningProviderInvocation, { method: 'normalizeNotification' }>,
): Promise<LearningProviderNotification | null>;
export function invokeLearningProvider(
  rawProvider: LearningProvider,
  rawInvocation: unknown,
): Promise<LearningProviderInvocationResult>;
export async function invokeLearningProvider(
  rawProvider: LearningProvider,
  rawInvocation: unknown,
): Promise<LearningProviderInvocationResult> {
  let provider: LearningProviderKind = 'canvas';
  let operation: LearningOperationContext | null = null;
  let phase: 'request' | 'call' | 'result' = 'request';
  try {
    let invocation = learningValidation.dataRecord(rawInvocation);
    const method = learningValidation.oneOf(invocation.method, [
      'healthCheck', 'listCourses', 'syncCourse', 'syncEnrollments',
      'syncActivities', 'syncResources', 'syncSubmissions', 'buildLaunchUrl',
      'normalizeNotification',
    ] as const);
    const requiresUrlPolicy = method === 'listCourses'
      || method === 'syncCourse'
      || method === 'syncActivities'
      || method === 'syncResources'
      || method === 'buildLaunchUrl';
    invocation = requiresUrlPolicy
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
      | LearningSyncSubmissionsRequest | LearningBuildLaunchRequest | LearningNormalizeNotificationRequest;
    if (method === 'healthCheck') request = normalizeLearningHealthRequest(invocation.request, now);
    else if (method === 'listCourses') request = normalizeLearningListCoursesRequest(invocation.request, now);
    else if (method === 'syncCourse') request = normalizeLearningSyncCourseRequest(invocation.request, now);
    else if (method === 'syncEnrollments') request = normalizeLearningSyncEnrollmentsRequest(invocation.request, now);
    else if (method === 'syncActivities') request = normalizeLearningSyncActivitiesRequest(invocation.request, now);
    else if (method === 'syncResources') request = normalizeLearningSyncResourcesRequest(invocation.request, now);
    else if (method === 'syncSubmissions') request = normalizeLearningSyncSubmissionsRequest(invocation.request, now);
    else if (method === 'buildLaunchUrl') request = normalizeLearningBuildLaunchRequest(invocation.request, now);
    else request = normalizeLearningNormalizeNotificationRequest(invocation.request, now);
    operation = request.operation;
    if (request.subject.provider !== provider) learningValidation.invalid();
    const urlPolicy = requiresUrlPolicy
      ? normalizeLearningConnectionUrlPolicy(invocation.urlPolicy)
      : null;
    if (urlPolicy !== null && (
      urlPolicy.provider !== request.subject.provider
      || urlPolicy.connectionId !== request.subject.connectionId
    )) learningValidation.invalid();

    phase = 'call';
    const rawResult = await guardedProviderCall(
      (signal) => adapter.call(requestWithSignal(request, signal) as never), operation, invocation.now as () => number,
    );
    phase = 'result';

    if (method === 'healthCheck') {
      const result = normalizeLearningProviderHealth(rawResult);
      if (result.provider !== provider || result.connectionId !== request.subject.connectionId) learningValidation.invalid();
      return result;
    }
    if (method === 'normalizeNotification') {
      if (rawResult === null) return null;
      const result = normalizeLearningProviderNotification(rawResult);
      if (
        result.provider !== provider
        || result.connectionId !== request.subject.connectionId
      ) learningValidation.invalid();
      return result;
    }
    if (method === 'syncCourse') {
      const result = normalizeLearningCourse(rawResult, urlPolicy);
      const subject = (request as LearningSyncCourseRequest).subject;
      if (result.externalCourseId !== subject.externalCourseId) learningValidation.invalid();
      return result;
    }
    if (method === 'buildLaunchUrl') {
      return normalizeLearningLaunchContract(
        rawResult,
        urlPolicy,
        (request as LearningBuildLaunchRequest).subject,
      );
    }

    let responseContract: LearningPageResponseContract;
    if (method === 'listCourses') {
      responseContract = {
        kind: 'courses', urlPolicy: urlPolicy as LearningConnectionUrlPolicy,
      };
    } else if (method === 'syncEnrollments') {
      responseContract = { kind: 'provider_enrollments' };
    } else if (method === 'syncActivities') {
      responseContract = {
        kind: 'activities', urlPolicy: urlPolicy as LearningConnectionUrlPolicy,
      };
    } else if (method === 'syncResources') {
      responseContract = {
        kind: 'resources', urlPolicy: urlPolicy as LearningConnectionUrlPolicy,
      };
    } else {
      responseContract = { kind: 'provider_submissions' };
    }
    const selected = closedPageContract(responseContract);
    const page = revalidateLearningPage(
      rawResult, selected.page, expectedPageProof(operation, selected),
    );
    pageMatchesRequest(page, request as LearningListCoursesRequest | LearningSyncEnrollmentsRequest
      | LearningSyncActivitiesRequest | LearningSyncResourcesRequest | LearningSyncSubmissionsRequest);
    return page as LearningStrictProviderPage;
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
