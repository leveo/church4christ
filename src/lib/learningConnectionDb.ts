import type { AppDb, AppDbResult, AppStatement } from './appDb';
import type { LearningCredentialEnvelope } from './learningCredentials';
import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  normalizeCanvasBaseUrl,
  type LearningErrorCode,
  type LearningProviderKind,
} from './learningModel';

export interface LearningConnectionRecord {
  readonly connectionId: number;
  readonly provider: LearningProviderKind;
  readonly displayName: string;
  readonly baseUrl: string | null;
  readonly status: 'pending' | 'active' | 'error' | 'disabled';
  readonly revision: number;
  readonly lastSuccessfulSyncAt: string | null;
  readonly lastErrorCode: string | null;
  readonly deletedAt: string | null;
}

export class LearningConnectionConflictError extends Error {
  readonly code = 'learning_connection_conflict' as const;
  constructor() { super('learning_connection_conflict'); this.name = 'LearningConnectionConflictError'; }
}

export class LearningConnectionInvalidError extends Error {
  readonly code = 'learning_connection_invalid' as const;
  constructor() { super('learning_connection_invalid'); this.name = 'LearningConnectionInvalidError'; }
}

export class LearningConnectionPersistenceError extends Error {
  readonly code = 'learning_connection_failed' as const;
  constructor() { super('learning_connection_failed'); this.name = 'LearningConnectionPersistenceError'; }
}

const invalid = (): never => { throw new LearningConnectionInvalidError(); };
const failed = (): never => { throw new LearningConnectionPersistenceError(); };

function integer(value: unknown, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > LEARNING_LIMITS.databaseInteger) invalid();
  return value as number;
}

function provider(value: unknown): LearningProviderKind {
  if (value !== 'canvas' && value !== 'google_classroom') invalid();
  return value as LearningProviderKind;
}

function connectionStatus(value: unknown): LearningConnectionRecord['status'] {
  if (value !== 'pending' && value !== 'active' && value !== 'error' && value !== 'disabled') invalid();
  return value as LearningConnectionRecord['status'];
}

function nextRevision(value: unknown): number {
  const revision = integer(value, 0);
  if (revision >= LEARNING_LIMITS.databaseInteger) invalid();
  return revision + 1;
}

function operationMarker(): string {
  return crypto.randomUUID();
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function displayName(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength < 1
    || new TextEncoder().encode(value).byteLength > LEARNING_LIMITS.connectionDisplayNameBytes
    || /[\u0000-\u001f\u007f]/.test(value)
    || !hasWellFormedUnicode(value)
  ) invalid();
  return value as string;
}

function baseUrl(kind: LearningProviderKind, value: unknown): string | null {
  if (kind === 'google_classroom') {
    if (value !== null) invalid();
    return null;
  }
  try { return normalizeCanvasBaseUrl(value); } catch { return invalid(); }
}

function safeEnvelope(value: LearningCredentialEnvelope): LearningCredentialEnvelope {
  if (
    value === null
    || typeof value !== 'object'
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== 'algorithm,ciphertext,envelopeVersion,expiresAt,keyVersion,nonce'
    || value.algorithm !== 'AES-256-GCM'
    || (value.envelopeVersion !== 1 && value.envelopeVersion !== 2)
    || !Number.isInteger(value.keyVersion)
    || value.keyVersion < 1
    || value.keyVersion > LEARNING_LIMITS.databaseInteger
    || !(value.ciphertext instanceof Uint8Array)
    || value.ciphertext.byteLength < 16
    || value.ciphertext.byteLength > 16_384
    || !(value.nonce instanceof Uint8Array)
    || value.nonce.byteLength !== 12
    || (value.expiresAt !== null && (typeof value.expiresAt !== 'string' || value.expiresAt.length < 19 || value.expiresAt.length > 40))
  ) invalid();
  return {
    ciphertext: value.ciphertext.slice(), nonce: value.nonce.slice(),
    algorithm: 'AES-256-GCM', keyVersion: value.keyVersion,
    envelopeVersion: value.envelopeVersion, expiresAt: value.expiresAt,
  };
}

function row(value: unknown): LearningConnectionRecord {
  if (!value || typeof value !== 'object') failed();
  const record = value as Record<string, unknown>;
  const kind = provider(record.provider);
  const connectionId = integer(record.connection_id, 1);
  const revision = integer(record.revision, 0);
  const safeStatus = connectionStatus(record.status);
  if (record.last_successful_sync_at !== null && typeof record.last_successful_sync_at !== 'string') failed();
  if (record.last_error_code !== null && typeof record.last_error_code !== 'string') failed();
  if (record.deleted_at !== null && typeof record.deleted_at !== 'string') failed();
  return Object.freeze({
    connectionId, provider: kind, displayName: displayName(record.display_name),
    baseUrl: baseUrl(kind, record.base_url), status: safeStatus, revision,
    lastSuccessfulSyncAt: record.last_successful_sync_at as string | null,
    lastErrorCode: record.last_error_code as string | null,
    deletedAt: record.deleted_at as string | null,
  });
}

const RETURNING = `RETURNING id AS connection_id,provider,display_name,
  base_url,status,revision,last_successful_sync_at,last_error_code,deleted_at`;

function returnedConnection(result: AppDbResult<unknown> | undefined): LearningConnectionRecord | null {
  if (!result) return failed();
  if (!Array.isArray(result.results) || result.results.length > 1) return failed();
  const rows = result.results;
  return rows.length === 0 ? null : row(rows[0]);
}

function credentialInsert(
  db: AppDb,
  connectionId: number,
  credential: LearningCredentialEnvelope,
): AppStatement {
  return db.prepare(`INSERT INTO learning_provider_credentials
    (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,datetime('now'))`)
    .bind(
      connectionId, credential.ciphertext, credential.nonce, credential.algorithm,
      credential.keyVersion, credential.envelopeVersion, credential.expiresAt,
    );
}

export interface CreateLearningConnectionInput {
  readonly connectionId: number;
  readonly provider: LearningProviderKind;
  readonly displayName: string;
  readonly baseUrl: string | null;
  readonly actorPersonId: number;
  readonly credential: LearningCredentialEnvelope | null;
}

export async function createLearningConnection(
  db: AppDb,
  input: CreateLearningConnectionInput,
): Promise<LearningConnectionRecord> {
  const connectionId = integer(input.connectionId, 1);
  const kind = provider(input.provider);
  const name = displayName(input.displayName);
  const url = baseUrl(kind, input.baseUrl);
  const actor = integer(input.actorPersonId, 1);
  if (kind === 'google_classroom' && input.credential !== null) invalid();
  const credential = input.credential === null ? null : safeEnvelope(input.credential);
  const status = credential === null ? 'pending' : 'active';
  const statements = [
    db.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id,updated_by_person_id,created_at,updated_at)
      VALUES (?1,?2,?3,?4,?5,0,?6,?6,datetime('now'),datetime('now')) ${RETURNING}`)
      .bind(connectionId, kind, name, url, status, actor),
  ];
  if (credential) statements.push(credentialInsert(db, connectionId, credential));
  try {
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length) failed();
    const created = returnedConnection(results[0]);
    if (created === null) return failed();
    return created;
  } catch (error) {
    if (error instanceof LearningConnectionInvalidError || error instanceof LearningConnectionPersistenceError) throw error;
    throw new LearningConnectionPersistenceError();
  }
}

export interface UpdateLearningConnectionInput {
  readonly connectionId: number;
  readonly expectedRevision: number;
  readonly provider: LearningProviderKind;
  readonly displayName: string;
  readonly baseUrl: string | null;
  readonly actorPersonId: number;
}

export async function updateLearningConnection(
  db: AppDb,
  input: UpdateLearningConnectionInput,
): Promise<LearningConnectionRecord> {
  const connectionId = integer(input.connectionId, 1);
  const expectedRevision = integer(input.expectedRevision, 0);
  const kind = provider(input.provider);
  const name = displayName(input.displayName);
  const url = baseUrl(kind, input.baseUrl);
  const actor = integer(input.actorPersonId, 1);
  try {
    const result = await db.prepare(`UPDATE learning_provider_connections SET
      display_name=?1,base_url=?2,revision=revision+1,updated_by_person_id=?3,updated_at=datetime('now')
      WHERE id=?4 AND provider=?5 AND revision=?6 AND deleted_at IS NULL
        AND operation_marker IS NULL ${RETURNING}`)
      .bind(name, url, actor, connectionId, kind, expectedRevision).run();
    const updated = returnedConnection(result);
    if (!updated) throw new LearningConnectionConflictError();
    return updated;
  } catch (error) {
    if (error instanceof LearningConnectionConflictError) throw error;
    throw new LearningConnectionPersistenceError();
  }
}

export interface DisconnectLearningConnectionInput {
  readonly connectionId: number;
  readonly expectedRevision: number;
  readonly actorPersonId: number;
}

export async function disconnectLearningConnection(
  db: AppDb,
  input: DisconnectLearningConnectionInput,
): Promise<LearningConnectionRecord> {
  const connectionId = integer(input.connectionId, 1);
  const expectedRevision = integer(input.expectedRevision, 0);
  const claimedRevision = nextRevision(expectedRevision);
  const actor = integer(input.actorPersonId, 1);
  const marker = operationMarker();
  try {
    const results = await db.batch([
      db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=?1,revision=revision+1,updated_by_person_id=?2,updated_at=datetime('now')
        WHERE id=?3 AND revision=?4 AND deleted_at IS NULL AND operation_marker IS NULL`)
        .bind(marker, actor, connectionId, expectedRevision),
      db.prepare(`DELETE FROM learning_google_registrations WHERE connection_id=?1 AND EXISTS (
        SELECT 1 FROM learning_provider_connections
        WHERE id=?1 AND revision=?2 AND operation_marker=?3
      )`).bind(connectionId, claimedRevision, marker),
      db.prepare(`DELETE FROM learning_provider_credentials WHERE connection_id=?1 AND EXISTS (
        SELECT 1 FROM learning_provider_connections
        WHERE id=?1 AND revision=?2 AND operation_marker=?3
      )`).bind(connectionId, claimedRevision, marker),
      db.prepare(`UPDATE learning_provider_connections SET
        status='disabled',operation_marker=NULL,last_error_code=NULL,
        updated_by_person_id=?1,updated_at=datetime('now'),deleted_at=datetime('now')
        WHERE id=?2 AND revision=?3 AND operation_marker=?4 ${RETURNING}`)
        .bind(actor, connectionId, claimedRevision, marker),
    ]);
    if (!Array.isArray(results) || results.length !== 4) failed();
    const disconnected = returnedConnection(results[3]);
    if (!disconnected) throw new LearningConnectionConflictError();
    return disconnected;
  } catch (error) {
    if (error instanceof LearningConnectionConflictError) throw error;
    if (error instanceof LearningConnectionPersistenceError) throw error;
    throw new LearningConnectionPersistenceError();
  }
}

export interface ReconnectLearningConnectionInput {
  readonly connectionId: number;
  readonly expectedRevision: number;
  readonly provider: 'canvas';
  readonly baseUrl: string;
  readonly actorPersonId: number;
  readonly credential: LearningCredentialEnvelope;
}

export async function reconnectLearningConnection(
  db: AppDb,
  input: ReconnectLearningConnectionInput,
): Promise<LearningConnectionRecord> {
  const connectionId = integer(input.connectionId, 1);
  const expectedRevision = integer(input.expectedRevision, 0);
  const claimedRevision = nextRevision(expectedRevision);
  const kind = provider(input.provider);
  if (kind !== 'canvas') invalid();
  const url = baseUrl(kind, input.baseUrl);
  const actor = integer(input.actorPersonId, 1);
  const credential = safeEnvelope(input.credential);
  const marker = operationMarker();
  try {
    const results = await db.batch([
      db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=?1,revision=revision+1,updated_by_person_id=?2,updated_at=datetime('now')
        WHERE id=?3 AND provider='canvas' AND revision=?4 AND status='disabled'
          AND deleted_at IS NOT NULL AND operation_marker IS NULL`)
        .bind(marker, actor, connectionId, expectedRevision),
      db.prepare(`INSERT INTO learning_provider_credentials
        (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at,updated_at)
        SELECT ?1,?2,?3,?4,?5,?6,?7,datetime('now')
        WHERE EXISTS (SELECT 1 FROM learning_provider_connections
          WHERE id=?1 AND provider='canvas' AND revision=?8 AND status='disabled'
            AND deleted_at IS NOT NULL AND operation_marker=?9)
        ON CONFLICT(connection_id) DO UPDATE SET
          ciphertext=excluded.ciphertext,nonce=excluded.nonce,algorithm=excluded.algorithm,
          key_version=excluded.key_version,envelope_version=excluded.envelope_version,
          expires_at=excluded.expires_at,updated_at=datetime('now')`)
        .bind(
          connectionId, credential.ciphertext, credential.nonce, credential.algorithm,
          credential.keyVersion, credential.envelopeVersion, credential.expiresAt, claimedRevision, marker,
        ),
      db.prepare(`UPDATE learning_provider_connections SET
        base_url=?1,status='active',operation_marker=NULL,last_error_code=NULL,
        updated_by_person_id=?2,updated_at=datetime('now'),deleted_at=NULL
        WHERE id=?3 AND provider='canvas' AND revision=?4 AND status='disabled'
          AND deleted_at IS NOT NULL AND operation_marker=?5 ${RETURNING}`)
        .bind(url, actor, connectionId, claimedRevision, marker),
    ]);
    if (!Array.isArray(results) || results.length !== 3) failed();
    const reconnected = returnedConnection(results[2]);
    if (!reconnected) throw new LearningConnectionConflictError();
    return reconnected;
  } catch (error) {
    if (error instanceof LearningConnectionConflictError) throw error;
    if (error instanceof LearningConnectionPersistenceError) throw error;
    throw new LearningConnectionPersistenceError();
  }
}

export interface UpdateLearningConnectionHealthInput {
  readonly connectionId: number;
  readonly expectedRevision: number;
  readonly expectedProvider: LearningProviderKind;
  readonly expectedStatus: LearningConnectionRecord['status'];
  readonly ok: boolean;
  readonly errorCode: LearningErrorCode | null;
  readonly actorPersonId: number;
}

export async function updateLearningConnectionHealth(
  db: AppDb,
  input: UpdateLearningConnectionHealthInput,
): Promise<LearningConnectionRecord> {
  const connectionId = integer(input.connectionId, 1);
  const expectedRevision = integer(input.expectedRevision, 0);
  nextRevision(expectedRevision);
  const expectedProvider = provider(input.expectedProvider);
  const expectedStatus = connectionStatus(input.expectedStatus);
  const actor = integer(input.actorPersonId, 1);
  if (typeof input.ok !== 'boolean') invalid();
  if (input.ok ? input.errorCode !== null : !LEARNING_ERROR_CODES.includes(input.errorCode as LearningErrorCode)) invalid();
  try {
    const result = await db.prepare(`UPDATE learning_provider_connections SET
      status=?1,last_error_code=?2,revision=revision+1,
      updated_by_person_id=?3,updated_at=datetime('now')
      WHERE id=?4 AND revision=?5 AND provider=?6 AND status=?7
        AND deleted_at IS NULL AND operation_marker IS NULL ${RETURNING}`)
      .bind(
        input.ok ? 'active' : 'error', input.errorCode, actor, connectionId,
        expectedRevision, expectedProvider, expectedStatus,
      ).run();
    const updated = returnedConnection(result);
    if (!updated) throw new LearningConnectionConflictError();
    return updated;
  } catch (error) {
    if (error instanceof LearningConnectionConflictError) throw error;
    throw new LearningConnectionPersistenceError();
  }
}

export async function getLearningConnection(
  db: AppDb,
  rawConnectionId: number,
  options: { readonly includeDeleted?: boolean } = {},
): Promise<LearningConnectionRecord | null> {
  const connectionId = integer(rawConnectionId, 1);
  try {
    const result = await db.prepare(`SELECT id AS connection_id,provider,display_name,
      base_url,status,revision,last_successful_sync_at,last_error_code,deleted_at
      FROM learning_provider_connections WHERE id=?1 ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'}`)
      .bind(connectionId).first();
    return result === null ? null : row(result);
  } catch (error) {
    if (error instanceof LearningConnectionInvalidError || error instanceof LearningConnectionPersistenceError) throw error;
    throw new LearningConnectionPersistenceError();
  }
}

export async function listLearningConnections(
  db: AppDb,
  options: { readonly includeDeleted?: boolean; readonly limit: number },
): Promise<readonly LearningConnectionRecord[]> {
  const limit = integer(options.limit, 1);
  if (limit > 100) invalid();
  try {
    const result = await db.prepare(`SELECT id AS connection_id,provider,display_name,
      base_url,status,revision,last_successful_sync_at,last_error_code,deleted_at
      FROM learning_provider_connections
      ${options.includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
      ORDER BY id ASC LIMIT ?1`).bind(limit).all();
    if (!Array.isArray(result.results) || result.results.length > limit) failed();
    return Object.freeze(result.results.map(row));
  } catch (error) {
    if (error instanceof LearningConnectionInvalidError || error instanceof LearningConnectionPersistenceError) throw error;
    throw new LearningConnectionPersistenceError();
  }
}
