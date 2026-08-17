import type { AppDb } from './appDb';
import {
  LearningGoogleAuthConflictError,
  loadGoogleCredential,
  refreshGoogleAccessToken,
  rotateGoogleCredential,
} from './learningGoogleAuth';
import type { LearningCredentialKeyRing } from './learningCredentials';
import { LEARNING_MAX_ATOMIC_ENTITIES, type LearningSyncCompletion } from './learningDb';
import { createGoogleClassroomProvider } from './learningGoogleProvider';
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
  type PreResolvedLearningPerson,
} from './learningSync';

const REFRESH_SKEW_MS = 5 * 60 * 1_000;
// Leave five seconds inside the provider's 30-second per-request ceiling for
// receipt finalization and bounded webhook cleanup.
const RECONCILIATION_DEADLINE_MS = 25_000;
// Worker Free allows 50 external subrequests. Reserve one each for an uncached
// Pub/Sub JWKS fetch, a possible OAuth refresh, and the authoritative course
// GET; every remaining provider request is represented by one collected page.
const RECONCILIATION_MAX_PROVIDER_PAGES = 47;
// Receipt claim (2), authoritative/identity/credential reads (3), refresh CAS
// plus a losing-writer reload (4), and terminal receipt update (1).
const GOOGLE_WEBHOOK_RESERVED_D1_QUERIES = 10;
const GOOGLE_POLICY = Object.freeze({
  providerLaunchOrigins: Object.freeze(['https://classroom.google.com']),
  providerFileOrigins: Object.freeze(['https://drive.google.com', 'https://docs.google.com']),
  externalLinkOrigins: Object.freeze(['https://forms.gle', 'https://forms.google.com']),
});

type GoogleReconcileFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class LearningGoogleReconcileError extends Error {
  readonly code = 'learning_google_reconcile_failed' as const;
  constructor() {
    super('learning_google_reconcile_failed');
    this.name = 'LearningGoogleReconcileError';
  }
}

const failed = (): never => { throw new LearningGoogleReconcileError(); };

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

function urlPolicy(connectionId: number): LearningConnectionUrlPolicy {
  return Object.freeze({
    connectionId,
    provider: 'google_classroom',
    baseUrl: null,
    ...GOOGLE_POLICY,
  });
}

async function accessToken(
  db: AppDb,
  input: {
    readonly connectionId: number;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly fetcher: GoogleReconcileFetcher;
    readonly signal: AbortSignal;
    readonly nowEpochMs: number;
  },
): Promise<string> {
  let loaded = await loadGoogleCredential(db, {
    connectionId: input.connectionId,
    keyRing: input.keyRing,
  });
  if (Date.parse(loaded.credential.accessTokenExpiresAt) > input.nowEpochMs + REFRESH_SKEW_MS) {
    return loaded.credential.accessToken;
  }
  const credential = await refreshGoogleAccessToken({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    refreshToken: loaded.credential.refreshToken,
    refreshTokenExpiresAt: loaded.credential.refreshTokenExpiresAt,
    fetcher: input.fetcher,
    signal: input.signal,
    nowEpochMs: input.nowEpochMs,
  });
  try {
    await rotateGoogleCredential(db, {
      connectionId: input.connectionId,
      expectedRevision: loaded.revision,
      credential,
      keyRing: input.keyRing,
      nowEpochMs: input.nowEpochMs,
    });
    return credential.accessToken;
  } catch (error) {
    if (!(error instanceof LearningGoogleAuthConflictError)) throw error;
    loaded = await loadGoogleCredential(db, {
      connectionId: input.connectionId,
      keyRing: input.keyRing,
    });
    if (Date.parse(loaded.credential.accessTokenExpiresAt) <= input.nowEpochMs) failed();
    return loaded.credential.accessToken;
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
      AND course.provider='google_classroom' AND course.lifecycle_state='active'
      AND course.deleted_at IS NULL AND connection.provider='google_classroom'
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
      provider: 'google_classroom' as const,
      externalCourseId,
      externalUserId,
      externalEnrollmentId: learningSyntheticEnrollmentId({
        provider: 'google_classroom', externalCourseId, externalUserId,
      }),
      personId: integer(row.person_id),
    });
  }));
}

export async function reconcileGoogleClassroomCourse(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly externalCourseId: string;
    readonly trigger: LearningSyncTrigger;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly fetcher: GoogleReconcileFetcher;
    readonly now: () => number;
    readonly signal: AbortSignal;
  },
): Promise<LearningSyncCompletion> {
  try {
    const input = learningValidation.exactRecord(rawInput, [
      'connectionId', 'externalCourseId', 'trigger', 'clientId', 'clientSecret',
      'keyRing', 'fetcher', 'now', 'signal',
    ]);
    const connectionId = integer(input.connectionId);
    const externalCourseId = externalId(input.externalCourseId);
    if (input.trigger !== 'notification') failed();
    if (
      typeof input.clientId !== 'string' || typeof input.clientSecret !== 'string'
      || typeof input.fetcher !== 'function' || typeof input.now !== 'function'
      || !(input.signal instanceof AbortSignal) || input.signal.aborted
    ) failed();
    const fetcher = input.fetcher as GoogleReconcileFetcher;
    const now = input.now as () => number;
    const signal = input.signal as AbortSignal;
    const startedAt = safeNow(now);
    const courseId = await authoritativeCourse(db, connectionId, externalCourseId);
    const preResolvedPeople = await preloadIdentities(db, connectionId, externalCourseId);
    const policy = urlPolicy(connectionId);
    const token = await accessToken(db, {
      connectionId,
      clientId: input.clientId as string,
      clientSecret: input.clientSecret as string,
      keyRing: input.keyRing as LearningCredentialKeyRing,
      fetcher,
      signal,
      nowEpochMs: startedAt,
    });
    const provider = createGoogleClassroomProvider({
      connectionId, accessToken: token, urlPolicy: policy, fetcher, now: () => safeNow(now),
    });
    const operation: LearningOperationContext = Object.freeze({
      scope: Object.freeze({
        connectionId,
        provider: 'google_classroom',
        externalCourseId,
        externalActivityId: null,
        externalEnrollmentId: null,
      }),
      startedAt: new Date(startedAt).toISOString(),
      deadlineAt: new Date(startedAt + RECONCILIATION_DEADLINE_MS).toISOString(),
      maxPages: RECONCILIATION_MAX_PROVIDER_PAGES,
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
      providerKind: 'google_classroom',
      courseId,
      externalCourseId,
      trigger: 'notification',
      operation,
      now: () => safeNow(now),
      preResolvedPeople,
      reservedInvocationQueries: GOOGLE_WEBHOOK_RESERVED_D1_QUERIES,
    });
  } catch (error) {
    if (error instanceof LearningGoogleReconcileError) throw error;
    return failed();
  }
}
