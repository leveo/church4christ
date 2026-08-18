import type { AppDb, AppDbResult } from './appDb';
import {
  decodeCanvasCredential,
  encodeCanvasCredential,
  refreshCanvasAccessToken,
  revokeCanvasAccessToken,
} from './learningCanvasAuth';
import {
  decryptLearningCredential,
  encryptLearningCredential,
  type LearningCredentialEnvelope,
  type LearningCredentialKeyRing,
} from './learningCredentials';
import { requireAllowedCanvasOrigin } from './learningCanvasOrigins';
import { LEARNING_LIMITS, learningValidation, normalizeCanvasBaseUrl } from './learningModel';

const CLAIM_TTL_MS = 60_000;
const REFRESH_SKEW_MS = 5 * 60 * 1_000;
type CleanupFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class LearningCanvasCleanupError extends Error {
  readonly code = 'learning_canvas_cleanup_failed' as const;
  constructor() { super('learning_canvas_cleanup_failed'); this.name = 'LearningCanvasCleanupError'; }
}

export class LearningCanvasCleanupConflictError extends Error {
  readonly code = 'learning_canvas_cleanup_conflict' as const;
  constructor() { super('learning_canvas_cleanup_conflict'); this.name = 'LearningCanvasCleanupConflictError'; }
}

const invalid = (): never => { throw new LearningCanvasCleanupError(); };

function integer(value: unknown, minimum = 1): number {
  try { return learningValidation.integer(value, minimum, LEARNING_LIMITS.databaseInteger); } catch { return invalid(); }
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
  if (!result) return invalid();
  if (!Array.isArray(result.results) || result.results.length > maximum) invalid();
  return result.results.map((value) => learningValidation.dataRecord(value));
}

function changes(result: AppDbResult<unknown> | undefined): number {
  if (!result) return invalid();
  if (!result.meta || !Number.isInteger(result.meta.changes) || result.meta.changes < 0) invalid();
  return result.meta.changes;
}

function bytes(value: unknown, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  let view: Uint8Array;
  if (value instanceof Uint8Array) view = value;
  else if (value instanceof ArrayBuffer) view = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else if (Array.isArray(value) && value.every(
    (byte) => Number.isInteger(byte) && (byte as number) >= 0 && (byte as number) <= 255,
  )) view = new Uint8Array(value as number[]);
  else return invalid();
  if (view.byteLength < minimum || view.byteLength > maximum) invalid();
  return Uint8Array.from(view) as Uint8Array<ArrayBuffer>;
}

function timestampOrNull(value: unknown): string | null {
  if (value === null) return null;
  try { return learningValidation.timestamp(value); } catch { return invalid(); }
}

function envelope(row: Record<string, unknown>): LearningCredentialEnvelope {
  return Object.freeze({
    ciphertext: bytes(row.ciphertext, 16, 16_384),
    nonce: bytes(row.nonce, 12, 12),
    algorithm: row.algorithm === 'AES-256-GCM' ? 'AES-256-GCM' : invalid(),
    keyVersion: integer(row.key_version),
    envelopeVersion: row.envelope_version === 1 || row.envelope_version === 2
      ? row.envelope_version : invalid(),
    expiresAt: timestampOrNull(row.expires_at),
  });
}

export async function commitCanvasDisconnect(
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
  const actorPersonId = integer(input.actorPersonId);
  const now = epoch(input.nowEpochMs);
  const marker = uuid();
  const nextRevision = expectedRevision + 1;
  try {
    const results = await db.batch([
      db.prepare(`UPDATE learning_provider_connections SET operation_marker=?1,
        operation_expires_at=?2,revision=revision+1,updated_by_person_id=?3,updated_at=datetime('now')
        WHERE id=?4 AND provider='canvas' AND status IN ('active','error')
          AND revision=?5 AND deleted_at IS NULL AND operation_marker IS NULL
          AND EXISTS (SELECT 1 FROM learning_provider_credentials p WHERE p.connection_id=?4)`)
        .bind(marker, new Date(now + CLAIM_TTL_MS).toISOString(), actorPersonId, connectionId, expectedRevision),
      db.prepare(`INSERT INTO learning_canvas_cleanup_tasks
        (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
        SELECT p.connection_id,p.ciphertext,p.nonce,p.algorithm,p.key_version,p.envelope_version,p.expires_at
        FROM learning_provider_credentials p JOIN learning_provider_connections c ON c.id=p.connection_id
        WHERE p.connection_id=?1 AND c.provider='canvas' AND c.revision=?2 AND c.operation_marker=?3`)
        .bind(connectionId, nextRevision, marker),
      db.prepare(`DELETE FROM learning_provider_credentials WHERE connection_id=?1
        AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?1 AND c.revision=?2 AND c.operation_marker=?3)
        AND EXISTS (SELECT 1 FROM learning_canvas_cleanup_tasks t WHERE t.connection_id=?1)`)
        .bind(connectionId, nextRevision, marker),
      db.prepare(`DELETE FROM learning_canvas_oauth_states WHERE connection_id=?1
        AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?1 AND c.revision=?2 AND c.operation_marker=?3)`)
        .bind(connectionId, nextRevision, marker),
      db.prepare(`DELETE FROM learning_canvas_event_receipts WHERE connection_id=?1
        AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?1 AND c.revision=?2 AND c.operation_marker=?3)`)
        .bind(connectionId, nextRevision, marker),
      db.prepare(`DELETE FROM learning_canvas_webhook_configs WHERE connection_id=?1
        AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?1 AND c.revision=?2 AND c.operation_marker=?3)`)
        .bind(connectionId, nextRevision, marker),
      db.prepare(`UPDATE learning_provider_connections SET status='disabled',operation_marker=NULL,
        operation_expires_at=NULL,last_error_code=NULL,updated_by_person_id=?1,
        updated_at=datetime('now'),deleted_at=datetime('now')
        WHERE id=?2 AND provider='canvas' AND revision=?3 AND operation_marker=?4
          AND EXISTS (SELECT 1 FROM learning_canvas_cleanup_tasks t WHERE t.connection_id=?2)
          AND NOT EXISTS (SELECT 1 FROM learning_provider_credentials p WHERE p.connection_id=?2)
          AND NOT EXISTS (SELECT 1 FROM learning_canvas_oauth_states s WHERE s.connection_id=?2)
          AND NOT EXISTS (SELECT 1 FROM learning_canvas_event_receipts r WHERE r.connection_id=?2)
          AND NOT EXISTS (SELECT 1 FROM learning_canvas_webhook_configs w WHERE w.connection_id=?2)
        RETURNING id AS connection_id,revision`)
        .bind(actorPersonId, connectionId, nextRevision, marker),
    ]);
    if (!Array.isArray(results) || results.length !== 7 || changes(results[0]) !== 1 || changes(results[1]) !== 1) {
      throw new LearningCanvasCleanupConflictError();
    }
    const completed = rows(results[6], 1);
    if (completed.length !== 1 || integer(completed[0].revision) !== nextRevision) {
      throw new LearningCanvasCleanupConflictError();
    }
    return Object.freeze({ connectionId, connectionRevision: nextRevision });
  } catch (error) {
    if (error instanceof LearningCanvasCleanupError || error instanceof LearningCanvasCleanupConflictError) throw error;
    throw new LearningCanvasCleanupConflictError();
  }
}

export interface CanvasCleanupSummary {
  readonly selected: number;
  readonly cleaned: number;
  readonly pending: number;
}

export async function recoverCanvasDisconnectCleanup(
  db: AppDb,
  input: {
    readonly connectionId: number;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly allowedOrigins: readonly string[];
    readonly keyRing: LearningCredentialKeyRing;
    readonly fetcher: CleanupFetcher;
    readonly signal: AbortSignal;
    readonly now: () => number;
  },
): Promise<CanvasCleanupSummary> {
  const connectionId = integer(input.connectionId);
  if (
    typeof input.clientId !== 'string' || input.clientId.length < 1 || input.clientId.length > 512
    || typeof input.clientSecret !== 'string' || input.clientSecret.length < 1 || input.clientSecret.length > 8_192
    || !Array.isArray(input.allowedOrigins) || !Object.isFrozen(input.allowedOrigins)
    || typeof input.fetcher !== 'function' || !(input.signal instanceof AbortSignal)
    || input.signal.aborted || typeof input.now !== 'function'
  ) invalid();
  const now = epoch(input.now());
  const marker = uuid();
  const claimed = await db.prepare(`UPDATE learning_canvas_cleanup_tasks SET
    claim_marker=?1,claim_expires_at=?2,attempt_count=attempt_count+1,last_attempt_at=?3
    WHERE connection_id=?4 AND (claim_marker IS NULL OR claim_expires_at<=?3)
    RETURNING ciphertext,nonce,algorithm,key_version,envelope_version,expires_at`)
    .bind(marker, new Date(now + CLAIM_TTL_MS).toISOString(), new Date(now).toISOString(), connectionId)
    .run();
  const claimedRows = rows(claimed, 1);
  if (claimedRows.length === 0) return Object.freeze({ selected: 0, cleaned: 0, pending: 0 });
  try {
    const connectionResult = await db.prepare(`SELECT base_url,revision,status FROM learning_provider_connections
      WHERE id=?1 AND provider='canvas' AND status IN ('active','error','disabled')
        AND operation_marker IS NULL LIMIT 2`).bind(connectionId).all<Record<string, unknown>>();
    const connections = rows(connectionResult, 2);
    if (connections.length !== 1) throw new LearningCanvasCleanupConflictError();
    const baseUrl = normalizeCanvasBaseUrl(connections[0].base_url);
    requireAllowedCanvasOrigin(baseUrl, input.allowedOrigins);
    let credential = decodeCanvasCredential(await decryptLearningCredential(input.keyRing, {
      provider: 'canvas', connectionId, envelope: envelope(claimedRows[0]),
    }));
    if (Date.parse(credential.accessTokenExpiresAt) <= now + REFRESH_SKEW_MS) {
      credential = await refreshCanvasAccessToken({
        baseUrl, clientId: input.clientId, clientSecret: input.clientSecret,
        refreshToken: credential.refreshToken, fetcher: input.fetcher,
        signal: input.signal, nowEpochMs: now,
      });
      const rotated = await encryptLearningCredential(input.keyRing, {
        provider: 'canvas', connectionId, plaintext: encodeCanvasCredential(credential), expiresAt: null,
      });
      const saved = await db.prepare(`UPDATE learning_canvas_cleanup_tasks SET
        ciphertext=?1,nonce=?2,algorithm=?3,key_version=?4,envelope_version=?5,expires_at=?6
        WHERE connection_id=?7 AND claim_marker=?8 AND claim_expires_at>?9
        RETURNING connection_id`).bind(
        rotated.ciphertext, rotated.nonce, rotated.algorithm, rotated.keyVersion,
        rotated.envelopeVersion, rotated.expiresAt, connectionId, marker, new Date(epoch(input.now())).toISOString(),
      ).run();
      if (rows(saved, 1).length !== 1) throw new LearningCanvasCleanupConflictError();
    }
    await revokeCanvasAccessToken({
      baseUrl, accessToken: credential.accessToken, fetcher: input.fetcher, signal: input.signal,
    });
    const deleted = await db.prepare(`DELETE FROM learning_canvas_cleanup_tasks
      WHERE connection_id=?1 AND claim_marker=?2`).bind(connectionId, marker).run();
    if (changes(deleted) !== 1) throw new LearningCanvasCleanupConflictError();
    return Object.freeze({ selected: 1, cleaned: 1, pending: 0 });
  } catch (error) {
    try {
      await db.prepare(`UPDATE learning_canvas_cleanup_tasks SET claim_marker=NULL,claim_expires_at=NULL
        WHERE connection_id=?1 AND claim_marker=?2`).bind(connectionId, marker).run();
    } catch { /* the bounded claim becomes recoverable after CLAIM_TTL_MS */ }
    return Object.freeze({ selected: 1, cleaned: 0, pending: 1 });
  }
}

export async function listCanvasDisconnectCleanupConnectionIds(
  db: AppDb,
  rawLimit: number,
): Promise<readonly number[]> {
  const limit = integer(rawLimit);
  if (limit > 4) invalid();
  const result = await db.prepare(`SELECT t.connection_id FROM learning_canvas_cleanup_tasks t
    JOIN learning_provider_connections c ON c.id=t.connection_id
    WHERE c.provider='canvas' AND c.status IN ('active','error','disabled') AND c.operation_marker IS NULL
    ORDER BY COALESCE(t.last_attempt_at,t.created_at),t.connection_id LIMIT ?1`)
    .bind(limit).all<Record<string, unknown>>();
  return Object.freeze(rows(result, limit).map((row) => integer(row.connection_id)));
}
