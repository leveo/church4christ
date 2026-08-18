import type { AppDb } from './appDb';
import {
  LearningCanvasAuthConflictError,
  loadCanvasCredential,
  refreshCanvasAccessToken,
  rotateCanvasCredential,
} from './learningCanvasAuth';
import { createCanvasProvider } from './learningCanvasProvider';
import type { LearningCredentialKeyRing } from './learningCredentials';
import { LEARNING_MAX_ATOMIC_ENTITIES, type LearningSyncCompletion } from './learningDb';
import {
  LEARNING_LIMITS,
  learningSyntheticEnrollmentId,
  learningValidation,
  type LearningConnectionUrlPolicy,
  type LearningSyncTrigger,
} from './learningModel';
import type { LearningOperationContext } from './learningProvider';
import {
  synchronizeLearningCourse,
  LearningSynchronizationError,
  type PreResolvedLearningPerson,
} from './learningSync';
import { requireAllowedCanvasOrigin } from './learningCanvasOrigins';

const REFRESH_SKEW_MS = 5 * 60 * 1_000;
const RECONCILIATION_DEADLINE_MS = 25_000;
// Each omitted-inline-items module phase consumes one request per normalized
// page. A Canvas resource page may still require both its module-item request
// and a page/file metadata request, so that remains the two-request worst case.
// 23 normalized pages therefore consume at most 46 REST
// subrequests; one Live Events JWK lookup, one token refresh, and syncCourse
// keep the whole invocation below Workers Free's 50-subrequest limit.
const RECONCILIATION_MAX_PROVIDER_PAGES = 23;
// Receipt account/course preflight + claim/read (3), course/identity/credential
// reads (3), refresh CAS with one losing-writer reload (4), terminal receipt
// update (1), and one conservative spare query.
const CANVAS_WEBHOOK_RESERVED_D1_QUERIES = 12;

type CanvasReconcileFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class LearningCanvasReconcileError extends Error {
  readonly code = 'learning_canvas_reconcile_failed' as const;
  constructor() {
    super('learning_canvas_reconcile_failed');
    this.name = 'LearningCanvasReconcileError';
  }
}

const failed = (): never => { throw new LearningCanvasReconcileError(); };

function integer(value: unknown): number {
  try { return learningValidation.integer(value, 1, LEARNING_LIMITS.databaseInteger); } catch { return failed(); }
}

function externalId(value: unknown): string {
  try { return learningValidation.externalId(value); } catch { return failed(); }
}

function safeNow(now: () => number): number {
  let value: unknown;
  try { value = now(); } catch { return failed(); }
  if (!Number.isSafeInteger(value) || (value as number) < 0) failed();
  return value as number;
}

function urlPolicy(connectionId: number, baseUrl: string): LearningConnectionUrlPolicy {
  return Object.freeze({
    connectionId,
    provider: 'canvas',
    baseUrl,
    providerLaunchOrigins: Object.freeze([baseUrl]),
    providerFileOrigins: Object.freeze([baseUrl]),
    externalLinkOrigins: Object.freeze([baseUrl]),
  });
}

async function access(
  db: AppDb,
  input: {
    readonly connectionId: number;
    readonly allowedOrigins: readonly string[];
    readonly clientId: string;
    readonly clientSecret: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly fetcher: CanvasReconcileFetcher;
    readonly signal: AbortSignal;
    readonly nowEpochMs: number;
  },
): Promise<{ readonly baseUrl: string; readonly accessToken: string }> {
  let loaded = await loadCanvasCredential(db, {
    connectionId: input.connectionId, keyRing: input.keyRing,
  });
  requireAllowedCanvasOrigin(loaded.baseUrl, input.allowedOrigins);
  if (Date.parse(loaded.credential.accessTokenExpiresAt) > input.nowEpochMs + REFRESH_SKEW_MS) {
    return Object.freeze({ baseUrl: loaded.baseUrl, accessToken: loaded.credential.accessToken });
  }
  const credential = await refreshCanvasAccessToken({
    baseUrl: loaded.baseUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    refreshToken: loaded.credential.refreshToken,
    fetcher: input.fetcher,
    signal: input.signal,
    nowEpochMs: input.nowEpochMs,
  });
  try {
    await rotateCanvasCredential(db, {
      connectionId: input.connectionId,
      expectedRevision: loaded.revision,
      credential,
      keyRing: input.keyRing,
      nowEpochMs: input.nowEpochMs,
    });
    return Object.freeze({ baseUrl: loaded.baseUrl, accessToken: credential.accessToken });
  } catch (error) {
    if (!(error instanceof LearningCanvasAuthConflictError)) throw error;
    loaded = await loadCanvasCredential(db, {
      connectionId: input.connectionId, keyRing: input.keyRing,
    });
    if (Date.parse(loaded.credential.accessTokenExpiresAt) <= input.nowEpochMs) failed();
    return Object.freeze({ baseUrl: loaded.baseUrl, accessToken: loaded.credential.accessToken });
  }
}

async function authoritativeCourse(
  db: AppDb,
  connectionId: number,
  externalCourseId: string,
): Promise<number> {
  const result = await db.prepare(`SELECT course.id AS course_id
    FROM learning_courses course
    JOIN learning_provider_connections connection ON connection.id=course.connection_id
    WHERE course.connection_id=?1 AND course.external_course_id=?2
      AND course.provider='canvas' AND course.lifecycle_state='active'
      AND course.deleted_at IS NULL AND connection.provider='canvas'
      AND connection.status='active' AND connection.deleted_at IS NULL
    ORDER BY course.id LIMIT 2`).bind(connectionId, externalCourseId).all<Record<string, unknown>>();
  if (!result || !Array.isArray(result.results) || result.results.length !== 1) failed();
  return integer(result.results[0]?.course_id);
}

async function preloadIdentities(
  db: AppDb,
  connectionId: number,
  externalCourseId: string,
): Promise<readonly PreResolvedLearningPerson[]> {
  const result = await db.prepare(`SELECT identity.external_user_id AS external_user_id,
      identity.person_id AS person_id
    FROM learning_identity_links identity
    WHERE identity.connection_id=?1 AND identity.status='active'
    ORDER BY identity.id LIMIT ?2`)
    .bind(connectionId, LEARNING_MAX_ATOMIC_ENTITIES + 1)
    .all<Record<string, unknown>>();
  if (
    !result || !Array.isArray(result.results)
    || result.results.length > LEARNING_MAX_ATOMIC_ENTITIES
  ) failed();
  return Object.freeze(result.results.map((row) => {
    const externalUserId = externalId(row.external_user_id);
    return Object.freeze({
      connectionId,
      provider: 'canvas' as const,
      externalCourseId,
      externalUserId,
      externalEnrollmentId: learningSyntheticEnrollmentId({
        provider: 'canvas', externalCourseId, externalUserId,
      }),
      personId: integer(row.person_id),
    });
  }));
}

export async function reconcileCanvasCourse(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly allowedOrigins: readonly string[];
    readonly externalCourseId: string;
    readonly trigger: LearningSyncTrigger;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly fetcher: CanvasReconcileFetcher;
    readonly now: () => number;
    readonly signal: AbortSignal;
    readonly maxProviderPages?: number;
  },
): Promise<LearningSyncCompletion> {
  try {
    const allowed = Object.hasOwn(rawInput, 'maxProviderPages') ? [
      'connectionId', 'externalCourseId', 'trigger', 'clientId', 'clientSecret',
      'keyRing', 'fetcher', 'now', 'signal', 'allowedOrigins', 'maxProviderPages',
    ] : [
      'connectionId', 'externalCourseId', 'trigger', 'clientId', 'clientSecret',
      'keyRing', 'fetcher', 'now', 'signal', 'allowedOrigins',
    ];
    const input = learningValidation.exactRecord(rawInput, allowed);
    const connectionId = integer(input.connectionId);
    const externalCourseId = externalId(input.externalCourseId);
    if (!['manual', 'scheduled', 'notification'].includes(input.trigger as string)) failed();
    if (
      typeof input.clientId !== 'string' || input.clientId.length < 1
      || typeof input.clientSecret !== 'string' || input.clientSecret.length < 1
      || typeof input.fetcher !== 'function' || typeof input.now !== 'function'
      || !(input.signal instanceof AbortSignal) || input.signal.aborted
    ) failed();
    const now = input.now as () => number;
    const signal = input.signal as AbortSignal;
    const fetcher = input.fetcher as CanvasReconcileFetcher;
    const startedAt = safeNow(now);
    const maxProviderPages = Object.hasOwn(input, 'maxProviderPages')
      ? learningValidation.integer(input.maxProviderPages, 1, RECONCILIATION_MAX_PROVIDER_PAGES)
      : RECONCILIATION_MAX_PROVIDER_PAGES;
    const courseId = await authoritativeCourse(db, connectionId, externalCourseId);
    const preResolvedPeople = await preloadIdentities(db, connectionId, externalCourseId);
    const credentials = await access(db, {
      connectionId,
      allowedOrigins: input.allowedOrigins as readonly string[],
      clientId: input.clientId as string,
      clientSecret: input.clientSecret as string,
      keyRing: input.keyRing as LearningCredentialKeyRing,
      fetcher,
      signal,
      nowEpochMs: startedAt,
    });
    const policy = urlPolicy(connectionId, credentials.baseUrl);
    const provider = createCanvasProvider({
      connectionId,
      baseUrl: credentials.baseUrl,
      accessToken: credentials.accessToken,
      urlPolicy: policy,
      fetcher,
      now: () => safeNow(now),
    });
    const operation: LearningOperationContext = Object.freeze({
      scope: Object.freeze({
        connectionId,
        provider: 'canvas',
        externalCourseId,
        externalActivityId: null,
        externalEnrollmentId: null,
      }),
      startedAt: new Date(startedAt).toISOString(),
      deadlineAt: new Date(startedAt + RECONCILIATION_DEADLINE_MS).toISOString(),
      maxPages: maxProviderPages,
      maxItems: LEARNING_MAX_ATOMIC_ENTITIES,
      maxRawBytes: LEARNING_LIMITS.maxSyncBytes,
      maxNormalizedBytes: LEARNING_LIMITS.maxSyncBytes,
      maxUniqueKeyBytes: LEARNING_LIMITS.maxSyncBytes,
      signal,
    });
    return await synchronizeLearningCourse(db, {
      provider,
      urlPolicy: policy,
      connectionId,
      providerKind: 'canvas',
      courseId,
      externalCourseId,
      trigger: input.trigger as LearningSyncTrigger,
      operation,
      now: () => safeNow(now),
      preResolvedPeople,
      reservedInvocationQueries: CANVAS_WEBHOOK_RESERVED_D1_QUERIES,
    });
  } catch (error) {
    if (error instanceof LearningSynchronizationError) throw error;
    if (error instanceof LearningCanvasReconcileError) throw error;
    return failed();
  }
}
