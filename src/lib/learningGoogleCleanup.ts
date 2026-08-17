import type { AppDb, AppDbResult } from './appDb';
import {
  loadGoogleCredentialForCleanup,
  refreshGoogleAccessToken,
  revokeGoogleRefreshToken,
} from './learningGoogleAuth';
import type { LearningCredentialKeyRing } from './learningCredentials';
import { deleteGoogleClassroomRegistration } from './learningGooglePubSub';
import { LEARNING_LIMITS, learningValidation } from './learningModel';

const CLAIM_TTL_MS = 60_000;
const REFRESH_SKEW_MS = 5 * 60 * 1_000;
const MAX_CLEANUP_TASKS = 8;

type CleanupFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class LearningGoogleCleanupError extends Error {
  readonly code = 'learning_google_cleanup_failed' as const;
  constructor() {
    super('learning_google_cleanup_failed');
    this.name = 'LearningGoogleCleanupError';
  }
}

export class LearningGoogleCleanupConflictError extends Error {
  readonly code = 'learning_google_cleanup_conflict' as const;
  constructor() {
    super('learning_google_cleanup_conflict');
    this.name = 'LearningGoogleCleanupConflictError';
  }
}

const invalid = (): never => { throw new LearningGoogleCleanupError(); };

function integer(value: unknown, minimum = 1): number {
  try { return learningValidation.integer(value, minimum, LEARNING_LIMITS.databaseInteger); } catch { return invalid(); }
}

function externalId(value: unknown): string {
  try { return learningValidation.externalId(value); } catch { return invalid(); }
}

function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function uuid(): string {
  const value = crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) invalid();
  return value;
}

function rows(result: AppDbResult<unknown> | undefined, maximum: number): Record<string, unknown>[] {
  if (!result || !Array.isArray(result.results) || result.results.length > maximum) invalid();
  return result.results.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
    return value as Record<string, unknown>;
  });
}

function changes(result: AppDbResult<unknown> | undefined): number {
  if (!result || !result.meta || !Number.isInteger(result.meta.changes) || result.meta.changes < 0) invalid();
  return result.meta.changes;
}

export interface GoogleCleanupDrainSummary {
  readonly selected: number;
  readonly cleaned: number;
  readonly pending: number;
}

export async function cleanupGoogleClassroomRegistrationTask(
  db: AppDb,
  input: {
    readonly connectionId: number;
    readonly registrationId: string;
    readonly accessToken: string;
    readonly fetcher: CleanupFetcher;
    readonly signal: AbortSignal;
    readonly nowEpochMs: number;
  },
): Promise<boolean> {
  const connectionId = integer(input.connectionId);
  const registrationId = externalId(input.registrationId);
  const now = epoch(input.nowEpochMs);
  if (typeof input.fetcher !== 'function' || !(input.signal instanceof AbortSignal) || input.signal.aborted) invalid();
  const marker = uuid();
  const claimed = await db.prepare(`UPDATE learning_google_cleanup_tasks SET
    claim_marker=?1,claim_expires_at=?2,attempt_count=attempt_count+1,last_attempt_at=?3
    WHERE connection_id=?4 AND task_type='registration' AND registration_id=?5
      AND (claim_marker IS NULL OR claim_expires_at<=?3)
    RETURNING id`).bind(
    marker, new Date(now + CLAIM_TTL_MS).toISOString(), new Date(now).toISOString(),
    connectionId, registrationId,
  ).run();
  const claimedRows = rows(claimed, 1);
  if (claimedRows.length === 0) return true;
  const taskId = integer(claimedRows[0].id);
  try {
    await deleteGoogleClassroomRegistration({
      accessToken: input.accessToken,
      registrationId,
      fetcher: input.fetcher,
      signal: input.signal,
    });
    const deleted = await db.prepare(`DELETE FROM learning_google_cleanup_tasks
      WHERE id=?1 AND connection_id=?2 AND task_type='registration' AND claim_marker=?3`)
      .bind(taskId, connectionId, marker).run();
    if (changes(deleted) !== 1) throw new LearningGoogleCleanupConflictError();
    return true;
  } catch (error) {
    try {
      await db.prepare(`UPDATE learning_google_cleanup_tasks SET claim_marker=NULL,claim_expires_at=NULL
        WHERE id=?1 AND connection_id=?2 AND claim_marker=?3`).bind(taskId, connectionId, marker).run();
    } catch { /* a stale bounded claim is recovered after CLAIM_TTL_MS */ }
    if (error instanceof LearningGoogleCleanupConflictError) throw error;
    return false;
  }
}

export async function drainGoogleClassroomRegistrationCleanup(
  db: AppDb,
  input: {
    readonly connectionId: number;
    readonly accessToken: string;
    readonly fetcher: CleanupFetcher;
    readonly signal: AbortSignal;
    readonly nowEpochMs: number;
    readonly limit: number;
  },
): Promise<GoogleCleanupDrainSummary> {
  const connectionId = integer(input.connectionId);
  const limit = integer(input.limit);
  if (limit > MAX_CLEANUP_TASKS) invalid();
  const now = new Date(epoch(input.nowEpochMs)).toISOString();
  const result = await db.prepare(`SELECT registration_id FROM learning_google_cleanup_tasks
    WHERE connection_id=?1 AND task_type='registration'
      AND (claim_marker IS NULL OR claim_expires_at<=?2)
    ORDER BY id LIMIT ?3`).bind(connectionId, now, limit).all<Record<string, unknown>>();
  const selected = rows(result, limit).map((row) => externalId(row.registration_id));
  let cleaned = 0;
  let pending = 0;
  for (const registrationId of selected) {
    const completed = await cleanupGoogleClassroomRegistrationTask(db, {
      ...input, connectionId, registrationId,
    });
    if (completed) cleaned += 1;
    else {
      pending += 1;
      break;
    }
  }
  return Object.freeze({ selected: selected.length, cleaned, pending });
}

export async function commitGoogleClassroomDisconnect(
  db: AppDb,
  input: {
    readonly connectionId: number;
    readonly expectedRevision: number;
    readonly actorPersonId: number;
    readonly nowEpochMs: number;
  },
): Promise<{ readonly connectionId: number; readonly connectionRevision: number }> {
  const connectionId = integer(input.connectionId);
  const expectedRevision = integer(input.expectedRevision, 0);
  if (expectedRevision >= LEARNING_LIMITS.databaseInteger) invalid();
  const actor = integer(input.actorPersonId);
  const now = epoch(input.nowEpochMs);
  const marker = uuid();
  const nextRevision = expectedRevision + 1;
  try {
    const results = await db.batch([
      db.prepare(`UPDATE learning_provider_connections SET operation_marker=?1,
        operation_expires_at=?2,revision=revision+1,updated_by_person_id=?3,updated_at=datetime('now')
        WHERE id=?4 AND provider='google_classroom' AND status IN ('active','error')
          AND revision=?5 AND deleted_at IS NULL AND operation_marker IS NULL`)
        .bind(marker, new Date(now + CLAIM_TTL_MS).toISOString(), actor, connectionId, expectedRevision),
      db.prepare(`INSERT INTO learning_google_cleanup_tasks(connection_id,task_type,registration_id)
        SELECT r.connection_id,'registration',r.registration_id FROM learning_google_registrations r
        WHERE r.connection_id=?1 AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?1 AND c.revision=?2 AND c.operation_marker=?3)
        ON CONFLICT(registration_id) WHERE task_type='registration' DO NOTHING`)
        .bind(connectionId, nextRevision, marker),
      db.prepare(`INSERT INTO learning_google_cleanup_tasks(connection_id,task_type,registration_id)
        SELECT c.id,'disconnect',NULL FROM learning_provider_connections c
        WHERE c.id=?1 AND c.revision=?2 AND c.operation_marker=?3
        ON CONFLICT(connection_id) WHERE task_type='disconnect' DO NOTHING`)
        .bind(connectionId, nextRevision, marker),
      db.prepare(`DELETE FROM learning_google_registrations WHERE connection_id=?1
        AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?1 AND c.revision=?2 AND c.operation_marker=?3)`)
        .bind(connectionId, nextRevision, marker),
      db.prepare(`UPDATE learning_provider_connections SET status='disabled',operation_marker=NULL,
        operation_expires_at=NULL,last_error_code=NULL,updated_by_person_id=?1,
        updated_at=datetime('now'),deleted_at=datetime('now')
        WHERE id=?2 AND revision=?3 AND operation_marker=?4
          AND EXISTS (SELECT 1 FROM learning_google_cleanup_tasks t
            WHERE t.connection_id=?2 AND t.task_type='disconnect')
          AND NOT EXISTS (SELECT 1 FROM learning_google_registrations r WHERE r.connection_id=?2)
        RETURNING id AS connection_id,revision`).bind(actor, connectionId, nextRevision, marker),
    ]);
    if (!Array.isArray(results) || results.length !== 5 || changes(results[0]) !== 1) {
      throw new LearningGoogleCleanupConflictError();
    }
    const finalRows = rows(results[4], 1);
    if (finalRows.length !== 1 || integer(finalRows[0].revision) !== nextRevision) {
      throw new LearningGoogleCleanupConflictError();
    }
    return Object.freeze({ connectionId, connectionRevision: nextRevision });
  } catch (error) {
    if (error instanceof LearningGoogleCleanupError || error instanceof LearningGoogleCleanupConflictError) throw error;
    throw new LearningGoogleCleanupConflictError();
  }
}

async function claimDisconnectTask(
  db: AppDb,
  connectionId: number,
  nowEpochMs: number,
): Promise<string | null> {
  const marker = uuid();
  const now = new Date(nowEpochMs).toISOString();
  const result = await db.prepare(`UPDATE learning_google_cleanup_tasks SET
    claim_marker=?1,claim_expires_at=?2,attempt_count=attempt_count+1,last_attempt_at=?3
    WHERE connection_id=?4 AND task_type='disconnect'
      AND (claim_marker IS NULL OR claim_expires_at<=?3)
    RETURNING id`).bind(marker, new Date(nowEpochMs + CLAIM_TTL_MS).toISOString(), now, connectionId).run();
  return rows(result, 1).length === 1 ? marker : null;
}

async function releaseDisconnectTask(db: AppDb, connectionId: number, marker: string): Promise<void> {
  await db.prepare(`UPDATE learning_google_cleanup_tasks SET claim_marker=NULL,claim_expires_at=NULL
    WHERE connection_id=?1 AND task_type='disconnect' AND claim_marker=?2`).bind(connectionId, marker).run();
}

async function finalizeDisconnectTask(
  db: AppDb,
  connectionId: number,
  marker: string,
  grantRevoked: boolean,
): Promise<void> {
  const results = await db.batch([
    db.prepare(`DELETE FROM learning_google_cleanup_tasks WHERE connection_id=?1
      AND task_type='registration' AND ?2=1`).bind(connectionId, grantRevoked ? 1 : 0),
    db.prepare(`DELETE FROM learning_provider_credentials WHERE connection_id=?1
      AND NOT EXISTS (SELECT 1 FROM learning_google_cleanup_tasks t
        WHERE t.connection_id=?1 AND t.task_type='registration')
      AND EXISTS (SELECT 1 FROM learning_google_cleanup_tasks t
        WHERE t.connection_id=?1 AND t.task_type='disconnect' AND t.claim_marker=?2)`)
      .bind(connectionId, marker),
    db.prepare(`DELETE FROM learning_google_cleanup_tasks WHERE connection_id=?1
      AND task_type='disconnect' AND claim_marker=?2
      AND NOT EXISTS (SELECT 1 FROM learning_provider_credentials p WHERE p.connection_id=?1)
      AND NOT EXISTS (SELECT 1 FROM learning_google_cleanup_tasks t
        WHERE t.connection_id=?1 AND t.task_type='registration')`).bind(connectionId, marker),
  ]);
  if (!Array.isArray(results) || results.length !== 3 || changes(results[2]) !== 1) {
    throw new LearningGoogleCleanupConflictError();
  }
}

export async function recoverGoogleClassroomCleanup(
  db: AppDb,
  input: {
    readonly connectionId: number;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly fetcher: CleanupFetcher;
    readonly signal: AbortSignal;
    readonly nowEpochMs: number;
    readonly limit: number;
  },
): Promise<GoogleCleanupDrainSummary & { readonly finalizedDisconnect: boolean }> {
  const connectionId = integer(input.connectionId);
  const now = epoch(input.nowEpochMs);
  const loaded = await loadGoogleCredentialForCleanup(db, { connectionId, keyRing: input.keyRing });
  const disconnectMarker = loaded.status === 'disabled' ? await claimDisconnectTask(db, connectionId, now) : null;
  if (loaded.status === 'disabled' && disconnectMarker === null) {
    return Object.freeze({ selected: 0, cleaned: 0, pending: 0, finalizedDisconnect: false });
  }
  let accessToken = loaded.credential.accessToken;
  let refreshToken = loaded.credential.refreshToken;
  try {
    if (Date.parse(loaded.credential.accessTokenExpiresAt) <= now + REFRESH_SKEW_MS) {
      try {
        const refreshed = await refreshGoogleAccessToken({
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          refreshToken,
          refreshTokenExpiresAt: loaded.credential.refreshTokenExpiresAt,
          fetcher: input.fetcher,
          signal: input.signal,
          nowEpochMs: now,
        });
        accessToken = refreshed.accessToken;
        refreshToken = refreshed.refreshToken;
      } catch (error) {
        if (disconnectMarker === null) throw error;
        await revokeGoogleRefreshToken({ refreshToken, fetcher: input.fetcher, signal: input.signal });
        await finalizeDisconnectTask(db, connectionId, disconnectMarker, true);
        return Object.freeze({ selected: 0, cleaned: 0, pending: 0, finalizedDisconnect: true });
      }
    }
    const drained = await drainGoogleClassroomRegistrationCleanup(db, {
      connectionId,
      accessToken,
      fetcher: input.fetcher,
      signal: input.signal,
      nowEpochMs: now,
      limit: input.limit,
    });
    if (disconnectMarker === null) return Object.freeze({ ...drained, finalizedDisconnect: false });
    const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM learning_google_cleanup_tasks
      WHERE connection_id=?1 AND task_type='registration'`).bind(connectionId).first<number>('count');
    if (!Number.isInteger(remaining) || (remaining as number) < 0 || (remaining as number) > 2_000) invalid();
    if (drained.pending > 0 || remaining !== 0) {
      await releaseDisconnectTask(db, connectionId, disconnectMarker);
      return Object.freeze({ ...drained, finalizedDisconnect: false });
    }
    await revokeGoogleRefreshToken({ refreshToken, fetcher: input.fetcher, signal: input.signal });
    await finalizeDisconnectTask(db, connectionId, disconnectMarker, false);
    return Object.freeze({ ...drained, finalizedDisconnect: true });
  } catch (error) {
    if (disconnectMarker !== null) {
      try { await releaseDisconnectTask(db, connectionId, disconnectMarker); } catch { /* stale claim recovery */ }
    }
    throw error;
  }
}

export async function listGoogleClassroomCleanupConnectionIds(
  db: AppDb,
  rawLimit: number,
): Promise<readonly number[]> {
  const limit = integer(rawLimit);
  if (limit > 4) invalid();
  const result = await db.prepare(`SELECT t.connection_id FROM learning_google_cleanup_tasks t
    JOIN learning_provider_connections c ON c.id=t.connection_id
    WHERE c.provider='google_classroom' AND c.status IN ('active','error','disabled')
      AND c.operation_marker IS NULL
    GROUP BY t.connection_id ORDER BY MIN(t.id) LIMIT ?1`).bind(limit).all<Record<string, unknown>>();
  return Object.freeze(rows(result, limit).map((row) => integer(row.connection_id)));
}
