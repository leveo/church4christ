import type { AppDb } from './appDb';
import { getBackend, type DbEnv } from './dbProvider';
import { reconcileCanvasCourse } from './learningCanvasReconcile';
import { readCanvasAllowedOrigins } from './learningCanvasOrigins';
import { importLearningCredentialKeyRing } from './learningCredentials';
import { reconcileGoogleClassroomCourse } from './learningGoogleReconcile';
import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  learningValidation,
  type LearningErrorCode,
  type LearningProviderKind,
  type LearningSyncTrigger,
} from './learningModel';
import { getEnabledModules } from './modules';
import { LearningSynchronizationError } from './learningSync';

export const LEARNING_SYNC_RUN_LIMITS = Object.freeze({
  maxTargets: 1,
  maxScanTargets: 10,
  maxAttempts: 2,
  maxElapsedMs: 25_000,
  baseBackoffMs: 250,
  maxBackoffMs: 2_000,
  googleMaxPagesPerAttempt: 21,
  canvasMaxPagesPerAttempt: 10,
});

export interface LearningSyncTarget {
  readonly courseId: number;
  readonly connectionId: number;
  readonly provider: LearningProviderKind;
  readonly externalCourseId: string;
}

export interface LearningAdminSyncCourse extends LearningSyncTarget {
  readonly displayName: string;
  readonly lastSyncedAt: string | null;
}

export interface LearningSyncLogEntry {
  readonly event: 'learning_sync_retry' | 'learning_sync_complete' | 'learning_sync_failed';
  readonly provider: LearningProviderKind;
  readonly trigger: LearningSyncTrigger;
  readonly attempt?: number;
  readonly attempts?: number;
  readonly status?: 'succeeded' | 'failed';
  readonly errorCode?: LearningErrorCode;
  readonly httpStatus?: number | null;
  readonly elapsedMs: number;
}

interface RetryDeps {
  readonly now: () => number;
  readonly reconcile: (signal: AbortSignal) => Promise<unknown>;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly markReconnectRequired?: (errorCode: 'authentication_required' | 'permission_denied') => Promise<void>;
  readonly log: (entry: LearningSyncLogEntry) => void;
}

interface ScheduledDeps {
  readonly learningEnabled: (environment: DbEnv, db: AppDb) => Promise<boolean>;
  readonly reconcileTarget: (input: LearningTargetSyncInput) => Promise<LearningSyncRunResult>;
}

export interface LearningTargetSyncInput extends LearningSyncTarget {
  readonly trigger: LearningSyncTrigger;
  readonly maxProviderPages: number;
}

export interface LearningSyncRunResult {
  readonly status: 'succeeded';
  readonly attempts: number;
}

export interface LearningSynchronizationEnv extends DbEnv {
  readonly GOOGLE_CLASSROOM_CLIENT_ID?: string;
  readonly GOOGLE_CLASSROOM_CLIENT_SECRET?: string;
  readonly CANVAS_OAUTH_CLIENT_ID?: string;
  readonly CANVAS_OAUTH_CLIENT_SECRET?: string;
  readonly CANVAS_ALLOWED_ORIGINS?: string;
  readonly LEARNING_CREDENTIAL_KEYS?: string;
}

function safeEpoch(now: () => number, provider: LearningProviderKind): number {
  let value: unknown;
  try { value = now(); } catch { throw new LearningSynchronizationError('invalid_request', provider); }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LearningSynchronizationError('invalid_request', provider);
  }
  return value as number;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function cleanup(): void { signal.removeEventListener('abort', abort); }
    function finish(): void { cleanup(); resolve(); }
    function abort(): void {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function defaultLog(entry: LearningSyncLogEntry): void {
  console.info(JSON.stringify(entry));
}

function permanentReconnect(error: LearningSynchronizationError): boolean {
  return error.code === 'authentication_required' || error.code === 'permission_denied';
}

function transient(error: LearningSynchronizationError): boolean {
  return error.httpStatus === 429 || (error.httpStatus !== null && error.httpStatus >= 500 && error.httpStatus <= 599);
}

function backoff(error: LearningSynchronizationError, attempt: number): number {
  const requested = error.retryAfterSeconds === null
    ? LEARNING_SYNC_RUN_LIMITS.baseBackoffMs * (2 ** (attempt - 1))
    : error.retryAfterSeconds * 1_000;
  return Math.min(LEARNING_SYNC_RUN_LIMITS.maxBackoffMs, Math.max(0, requested));
}

function linkedSignal(parent: AbortSignal, deadlineMs: number): {
  readonly signal: AbortSignal;
  readonly deadline: AbortController;
  readonly dispose: () => void;
} {
  const deadline = new AbortController();
  const combined = new AbortController();
  const abort = (): void => { if (!combined.signal.aborted) combined.abort(); };
  parent.addEventListener('abort', abort, { once: true });
  deadline.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  if (parent.aborted) abort();
  return {
    signal: combined.signal,
    deadline,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
      deadline.signal.removeEventListener('abort', abort);
    },
  };
}

export async function listLearningSyncTargets(
  db: AppDb,
  rawInput: { readonly courseId?: number; readonly limit: number },
): Promise<readonly LearningSyncTarget[]> {
  const allowed = Object.hasOwn(rawInput, 'courseId') ? ['courseId', 'limit'] : ['limit'];
  const input = learningValidation.exactRecord(rawInput, allowed);
  const limit = learningValidation.integer(input.limit, 1, LEARNING_SYNC_RUN_LIMITS.maxScanTargets);
  const hasCourse = Object.hasOwn(input, 'courseId');
  const courseId = hasCourse
    ? learningValidation.integer(input.courseId, 1, LEARNING_LIMITS.databaseInteger)
    : null;
  const result = await db.prepare(`SELECT course.id AS course_id,
      course.connection_id AS connection_id, course.provider AS provider,
      course.external_course_id AS external_course_id
    FROM learning_courses course
    JOIN learning_programs program ON program.id=course.program_id
    JOIN learning_provider_connections connection ON connection.id=course.connection_id
      AND connection.provider=course.provider
    WHERE course.lifecycle_state='active' AND course.deleted_at IS NULL
      AND program.status='active' AND program.deleted_at IS NULL
      AND connection.status='active' AND connection.deleted_at IS NULL
      AND (?1 IS NULL OR course.id=?1)
    ORDER BY CASE WHEN course.last_synced_at IS NULL THEN 0 ELSE 1 END,
      course.last_synced_at, course.id
    LIMIT ?2`).bind(courseId, limit).all<Record<string, unknown>>();
  if (!result || !Array.isArray(result.results) || result.results.length > limit) {
    throw new LearningSynchronizationError('internal_error', 'google_classroom');
  }
  return Object.freeze(result.results.map((row) => Object.freeze({
    courseId: learningValidation.integer(row.course_id, 1, LEARNING_LIMITS.databaseInteger),
    connectionId: learningValidation.integer(row.connection_id, 1, LEARNING_LIMITS.databaseInteger),
    provider: learningValidation.oneOf(row.provider, ['google_classroom', 'canvas'] as const),
    externalCourseId: learningValidation.externalId(row.external_course_id),
  })));
}

export async function listLearningAdminSyncCourses(
  db: AppDb,
  limit = 50,
): Promise<readonly LearningAdminSyncCourse[]> {
  const boundedLimit = learningValidation.integer(limit, 1, 100);
  const result = await db.prepare(`SELECT course.id AS course_id,
      course.connection_id AS connection_id, course.provider AS provider,
      course.external_course_id AS external_course_id,
      course.display_name AS display_name, course.last_synced_at AS last_synced_at
    FROM learning_courses course
    JOIN learning_programs program ON program.id=course.program_id
    JOIN learning_provider_connections connection ON connection.id=course.connection_id
      AND connection.provider=course.provider
    WHERE course.lifecycle_state='active' AND course.deleted_at IS NULL
      AND program.status='active' AND program.deleted_at IS NULL
      AND connection.status='active' AND connection.deleted_at IS NULL
    ORDER BY course.display_name, course.id LIMIT ?1`).bind(boundedLimit).all<Record<string, unknown>>();
  if (!result || !Array.isArray(result.results) || result.results.length > boundedLimit) {
    throw new LearningSynchronizationError('internal_error', 'google_classroom');
  }
  return Object.freeze(result.results.map((row) => Object.freeze({
    courseId: learningValidation.integer(row.course_id, 1, LEARNING_LIMITS.databaseInteger),
    connectionId: learningValidation.integer(row.connection_id, 1, LEARNING_LIMITS.databaseInteger),
    provider: learningValidation.oneOf(row.provider, ['google_classroom', 'canvas'] as const),
    externalCourseId: learningValidation.externalId(row.external_course_id),
    displayName: learningValidation.boundedString(row.display_name, 1, LEARNING_LIMITS.courseDisplayNameBytes),
    lastSyncedAt: row.last_synced_at === null ? null : learningValidation.timestamp(row.last_synced_at),
  })));
}

export async function markLearningConnectionReconnectRequired(
  db: AppDb,
  input: { readonly connectionId: number; readonly provider: LearningProviderKind; readonly errorCode: LearningErrorCode },
): Promise<void> {
  const connectionId = learningValidation.integer(input.connectionId, 1, LEARNING_LIMITS.databaseInteger);
  const provider = learningValidation.oneOf(input.provider, ['google_classroom', 'canvas'] as const);
  const errorCode = learningValidation.oneOf(input.errorCode, LEARNING_ERROR_CODES);
  if (errorCode !== 'authentication_required' && errorCode !== 'permission_denied') {
    throw new LearningSynchronizationError('invalid_request', provider);
  }
  const result = await db.prepare(`UPDATE learning_provider_connections
    SET status='error', last_error_code=?1, revision=revision+1, updated_at=datetime('now'),
      operation_marker=NULL, operation_expires_at=NULL
    WHERE id=?2 AND provider=?3 AND status='active' AND deleted_at IS NULL
      AND revision<2147483647`).bind(errorCode, connectionId, provider).run();
  if (!result || result.success !== true) throw new LearningSynchronizationError('internal_error', provider);
}

export async function runLearningSyncWithRetry(
  input: {
    readonly provider: LearningProviderKind;
    readonly trigger: LearningSyncTrigger;
    readonly signal: AbortSignal;
  },
  dependencies: Partial<RetryDeps> & Pick<RetryDeps, 'now' | 'reconcile'>,
): Promise<LearningSyncRunResult> {
  const provider = learningValidation.oneOf(input.provider, ['google_classroom', 'canvas'] as const);
  const trigger = learningValidation.oneOf(input.trigger, ['manual', 'scheduled', 'notification'] as const);
  if (!(input.signal instanceof AbortSignal)) throw new LearningSynchronizationError('invalid_request', provider);
  const sleep = dependencies.sleep ?? defaultSleep;
  const log = dependencies.log ?? defaultLog;
  const started = safeEpoch(dependencies.now, provider);
  if (input.signal.aborted) throw new LearningSynchronizationError('cancelled', provider);
  const linked = linkedSignal(input.signal, LEARNING_SYNC_RUN_LIMITS.maxElapsedMs);
  try {
    for (let attempt = 1; attempt <= LEARNING_SYNC_RUN_LIMITS.maxAttempts; attempt += 1) {
      if (input.signal.aborted) throw new LearningSynchronizationError('cancelled', provider);
      if (linked.deadline.signal.aborted || safeEpoch(dependencies.now, provider) - started >= LEARNING_SYNC_RUN_LIMITS.maxElapsedMs) {
        throw new LearningSynchronizationError('timeout', provider);
      }
      try {
        await dependencies.reconcile(linked.signal);
        const elapsedMs = Math.max(0, safeEpoch(dependencies.now, provider) - started);
        if (linked.deadline.signal.aborted || elapsedMs >= LEARNING_SYNC_RUN_LIMITS.maxElapsedMs) {
          throw new LearningSynchronizationError('timeout', provider);
        }
        log({ event: 'learning_sync_complete', provider, trigger, attempts: attempt, status: 'succeeded', elapsedMs });
        return Object.freeze({ status: 'succeeded', attempts: attempt });
      } catch (error) {
        if (input.signal.aborted) throw new LearningSynchronizationError('cancelled', provider);
        if (linked.deadline.signal.aborted || safeEpoch(dependencies.now, provider) - started >= LEARNING_SYNC_RUN_LIMITS.maxElapsedMs) {
          throw new LearningSynchronizationError('timeout', provider);
        }
        const safe = error instanceof LearningSynchronizationError
          ? error : new LearningSynchronizationError('internal_error', provider);
        if (permanentReconnect(safe) && dependencies.markReconnectRequired) {
          try { await dependencies.markReconnectRequired(safe.code as 'authentication_required' | 'permission_denied'); }
          catch { /* keep the authoritative provider failure */ }
        }
        if (!transient(safe) || attempt >= LEARNING_SYNC_RUN_LIMITS.maxAttempts) {
          log({
            event: 'learning_sync_failed', provider, trigger, attempts: attempt, status: 'failed',
            errorCode: safe.code, httpStatus: safe.httpStatus,
            elapsedMs: Math.max(0, safeEpoch(dependencies.now, provider) - started),
          });
          throw safe;
        }
        log({
          event: 'learning_sync_retry', provider, trigger, attempt, errorCode: safe.code,
          httpStatus: safe.httpStatus, elapsedMs: Math.max(0, safeEpoch(dependencies.now, provider) - started),
        });
        try { await sleep(backoff(safe, attempt), linked.signal); } catch {
          throw new LearningSynchronizationError(input.signal.aborted ? 'cancelled' : 'timeout', provider);
        }
      }
    }
    throw new LearningSynchronizationError('internal_error', provider);
  } finally {
    linked.dispose();
  }
}

function configured(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}

export async function reconcileLearningSyncTarget(
  environment: LearningSynchronizationEnv,
  db: AppDb,
  input: LearningTargetSyncInput,
): Promise<LearningSyncRunResult> {
  return reconcileLearningProviderCourse(environment, db, input);
}

export async function reconcileLearningProviderCourse(
  environment: LearningSynchronizationEnv,
  db: AppDb,
  input: Omit<LearningTargetSyncInput, 'courseId'>,
): Promise<LearningSyncRunResult> {
  const keySecret = environment.LEARNING_CREDENTIAL_KEYS;
  if (!configured(keySecret, 16_384)) throw new LearningSynchronizationError('authentication_required', input.provider);
  const keyRing = await importLearningCredentialKeyRing(keySecret);
  const controller = new AbortController();
  return runLearningSyncWithRetry({ provider: input.provider, trigger: input.trigger, signal: controller.signal }, {
    now: Date.now,
    markReconnectRequired: (errorCode) => markLearningConnectionReconnectRequired(db, {
      connectionId: input.connectionId, provider: input.provider, errorCode,
    }),
    reconcile: async (signal) => {
      if (input.provider === 'google_classroom') {
        if (!configured(environment.GOOGLE_CLASSROOM_CLIENT_ID, 512)
          || !configured(environment.GOOGLE_CLASSROOM_CLIENT_SECRET, 2_048)) {
          throw new LearningSynchronizationError('authentication_required', input.provider);
        }
        await reconcileGoogleClassroomCourse(db, {
          connectionId: input.connectionId, externalCourseId: input.externalCourseId,
          trigger: input.trigger, clientId: environment.GOOGLE_CLASSROOM_CLIENT_ID,
          clientSecret: environment.GOOGLE_CLASSROOM_CLIENT_SECRET, keyRing, fetcher: fetch,
          now: Date.now, signal, maxProviderPages: input.maxProviderPages,
        });
        return;
      }
      if (!configured(environment.CANVAS_OAUTH_CLIENT_ID, 512)
        || !configured(environment.CANVAS_OAUTH_CLIENT_SECRET, 8_192)) {
        throw new LearningSynchronizationError('authentication_required', input.provider);
      }
      await reconcileCanvasCourse(db, {
        connectionId: input.connectionId, externalCourseId: input.externalCourseId,
        trigger: input.trigger, clientId: environment.CANVAS_OAUTH_CLIENT_ID,
        clientSecret: environment.CANVAS_OAUTH_CLIENT_SECRET,
        allowedOrigins: readCanvasAllowedOrigins(environment.CANVAS_ALLOWED_ORIGINS),
        keyRing, fetcher: fetch, now: Date.now, signal, maxProviderPages: input.maxProviderPages,
      });
    },
  });
}

const DEFAULT_SCHEDULED_DEPS: ScheduledDeps = Object.freeze({
  learningEnabled: async (environment: DbEnv, db: AppDb) => (
    await getEnabledModules(db, getBackend(environment))
  ).has('learning'),
  reconcileTarget: async () => { throw new Error('default_reconcile_requires_environment'); },
});

export async function runScheduledLearningSyncPass(
  environment: LearningSynchronizationEnv,
  db: AppDb,
  dependencies?: Partial<ScheduledDeps>,
): Promise<{ readonly scanned: number; readonly attempted: number; readonly succeeded: number; readonly failed: number }> {
  const learningEnabled = dependencies?.learningEnabled ?? DEFAULT_SCHEDULED_DEPS.learningEnabled;
  if (!(await learningEnabled(environment, db))) {
    return Object.freeze({ scanned: 0, attempted: 0, succeeded: 0, failed: 0 });
  }
  const targets = await listLearningSyncTargets(db, { limit: LEARNING_SYNC_RUN_LIMITS.maxTargets });
  const target = targets[0];
  if (!target) return Object.freeze({ scanned: 0, attempted: 0, succeeded: 0, failed: 0 });
  const reconcileTarget = dependencies?.reconcileTarget
    ?? ((input: LearningTargetSyncInput) => reconcileLearningSyncTarget(environment, db, input));
  try {
    await reconcileTarget({
      ...target,
      trigger: 'scheduled',
      maxProviderPages: target.provider === 'google_classroom'
        ? LEARNING_SYNC_RUN_LIMITS.googleMaxPagesPerAttempt
        : LEARNING_SYNC_RUN_LIMITS.canvasMaxPagesPerAttempt,
    });
    return Object.freeze({ scanned: 1, attempted: 1, succeeded: 1, failed: 0 });
  } catch (error) {
    const errorCode = error instanceof LearningSynchronizationError ? error.code : 'internal_error';
    console.warn(JSON.stringify({
      event: 'learning_sync_pass_complete', trigger: 'scheduled', provider: target.provider,
      status: 'failed', errorCode, scanned: 1, attempted: 1, succeeded: 0, failed: 1,
    }));
    return Object.freeze({ scanned: 1, attempted: 1, succeeded: 0, failed: 1 });
  }
}
