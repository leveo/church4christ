import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { AppDb } from './appDb';
import {
  LEARNING_LIMITS,
  learningValidation,
  normalizeCanvasBaseUrl,
} from './learningModel';

export const CANVAS_LIVE_EVENTS_JWKS_URL =
  'https://8axpcl50e4.execute-api.us-east-1.amazonaws.com/main/jwks' as const;

const MAX_COMPACT_JWT_BYTES = 65_536;
const MAX_JWKS_BYTES = 131_072;
const CLAIM_TTL_MS = 2 * 60 * 1_000;
const RELEVANT_EVENTS = Object.freeze(new Set([
  'course_created', 'course_updated', 'course_deleted',
  'enrollment_created', 'enrollment_updated', 'enrollment_deleted',
  'enrollment_state_created', 'enrollment_state_updated', 'enrollment_state_deleted',
  'module_created', 'module_updated', 'module_deleted',
  'module_item_created', 'module_item_updated', 'module_item_deleted',
  'wiki_page_created', 'wiki_page_updated', 'wiki_page_deleted',
  'attachment_created', 'attachment_updated', 'attachment_deleted',
  'assignment_created', 'assignment_updated', 'assignment_deleted',
  'quiz_created', 'quiz_updated', 'quiz_deleted',
  'quiz_submission_created', 'quiz_submission_updated',
  'submission_created', 'submission_updated', 'submission_graded',
]));

export class LearningCanvasLiveEventError extends Error {
  readonly code = 'learning_canvas_live_event_invalid' as const;
  constructor() {
    super('learning_canvas_live_event_invalid');
    this.name = 'LearningCanvasLiveEventError';
  }
}

export class LearningCanvasLiveEventConflictError extends Error {
  readonly code = 'learning_canvas_live_event_conflict' as const;
  constructor() {
    super('learning_canvas_live_event_conflict');
    this.name = 'LearningCanvasLiveEventConflictError';
  }
}

const invalid = (): never => { throw new LearningCanvasLiveEventError(); };

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try { return learningValidation.exactRecord(value, keys); } catch { return invalid(); }
}

function record(value: unknown): Record<string, unknown> {
  try { return learningValidation.dataRecord(value); } catch { return invalid(); }
}

function bounded(value: unknown, minimum: number, maximum: number): string {
  try { return learningValidation.boundedString(value, minimum, maximum); } catch { return invalid(); }
}

function externalId(value: unknown): string {
  if (typeof value === 'number') {
    try { return String(learningValidation.integer(value, 1, Number.MAX_SAFE_INTEGER)); } catch { return invalid(); }
  }
  try { return learningValidation.externalId(value); } catch { return invalid(); }
}

function timestamp(value: unknown): string {
  try { return learningValidation.timestamp(value); } catch { return invalid(); }
}

function databaseInteger(value: unknown): number {
  try { return learningValidation.integer(value, 1, LEARNING_LIMITS.databaseInteger); } catch { return invalid(); }
}

function uuid(value: unknown): string {
  const marker = bounded(value, 36, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(marker)) invalid();
  return marker;
}

function hostname(value: unknown): string {
  const result = bounded(value, 1, 253).toLowerCase();
  if (
    result !== value
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(result)
  ) invalid();
  return result;
}

function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function base64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function sourceEventId(compactJwt: string): Promise<string> {
  const bytes = owned(new TextEncoder().encode(compactJwt));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${base64Url(digest)}`;
}

async function boundedCanvasJwksFetch(
  url: string,
  options: {
    readonly headers: Headers;
    readonly method: 'GET';
    readonly redirect: 'manual';
    readonly signal: AbortSignal;
  },
): Promise<Response> {
  if (
    url !== CANVAS_LIVE_EVENTS_JWKS_URL
    || options.method !== 'GET'
    || options.redirect !== 'manual'
  ) invalid();
  const response = await fetch(url, options);
  const body = response.body;
  if (!response.ok || body === null) {
    try { void body?.cancel().catch(() => undefined); } catch { /* best effort */ }
    return invalid();
  }
  const declared = response.headers.get('Content-Length');
  if (declared !== null && (
    !/^(?:0|[1-9]\d*)$/u.test(declared)
    || Number(declared) > MAX_JWKS_BYTES
  )) {
    try { void body.cancel().catch(() => undefined); } catch { /* best effort */ }
    return invalid();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    if (!(part.value instanceof Uint8Array)) invalid();
    total += part.value.byteLength;
    if (total > MAX_JWKS_BYTES) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      return invalid();
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' },
  });
}

// RemoteJWKSet caches only public Canvas signing keys. It never contains
// request-specific state or event bodies and bounds every cache-miss fetch.
const CANVAS_LIVE_EVENTS_JWKS = createRemoteJWKSet(new URL(CANVAS_LIVE_EVENTS_JWKS_URL), {
  timeoutDuration: 3_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
  [customFetch]: boundedCanvasJwksFetch,
});

interface CanvasJwtVerifyOptions {
  readonly algorithms: readonly ['RS256'];
  readonly jwkSetUrl: typeof CANVAS_LIVE_EVENTS_JWKS_URL;
}

export type CanvasLiveEventTokenVerifier = (
  compactJwt: string,
  options: CanvasJwtVerifyOptions,
) => Promise<unknown>;

const productionTokenVerifier: CanvasLiveEventTokenVerifier = async (compactJwt) => {
  const verified = await jwtVerify(compactJwt, CANVAS_LIVE_EVENTS_JWKS, {
    algorithms: ['RS256'],
  });
  return { payload: verified.payload };
};

export interface CanvasLiveEvent {
  readonly sourceEventId: string;
  readonly rootAccountId: string;
  readonly sourceHostname: string;
  readonly externalCourseId: string;
  readonly eventName: string;
  readonly eventTime: string;
  readonly receivedAt: string;
}

function courseId(metadata: Record<string, unknown>, body: Record<string, unknown>): string {
  const candidates: string[] = [];
  if (metadata.context_type === 'Course' && metadata.context_id !== undefined) {
    candidates.push(externalId(metadata.context_id));
  }
  if (body.course_id !== undefined) candidates.push(externalId(body.course_id));
  if (body.context_type === 'Course' && body.context_id !== undefined) {
    candidates.push(externalId(body.context_id));
  }
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) invalid();
  return unique[0] ?? invalid();
}

function sourceHostname(metadata: Record<string, unknown>): string {
  if (metadata.hostname !== undefined) return hostname(metadata.hostname);
  const guid = bounded(metadata.root_account_lti_guid, 3, 512);
  const separator = guid.indexOf('.');
  if (separator < 1 || separator === guid.length - 1) invalid();
  return hostname(guid.slice(separator + 1));
}

function normalizeClaims(value: unknown, receivedAt: string, sourceId: string): CanvasLiveEvent {
  const claims = record(value);
  const metadata = record(claims.metadata);
  const body = record(claims.body);
  if (metadata.producer !== 'canvas') invalid();
  const eventName = bounded(metadata.event_name, 1, 96);
  if (!RELEVANT_EVENTS.has(eventName)) invalid();
  return Object.freeze({
    sourceEventId: sourceId,
    rootAccountId: externalId(metadata.root_account_id),
    sourceHostname: sourceHostname(metadata),
    externalCourseId: courseId(metadata, body),
    eventName,
    eventTime: timestamp(metadata.event_time),
    receivedAt: timestamp(receivedAt),
  });
}

export async function verifyCanvasLiveEventJwt(rawInput: {
  readonly compactJwt: string;
  readonly receivedAt: string;
  readonly verifyToken?: CanvasLiveEventTokenVerifier;
}): Promise<CanvasLiveEvent> {
  try {
    const input = exact(rawInput, ['compactJwt', 'receivedAt', 'verifyToken']);
    const compactJwt = bounded(input.compactJwt, 1, MAX_COMPACT_JWT_BYTES);
    if (
      learningValidation.utf8Bytes(compactJwt) > MAX_COMPACT_JWT_BYTES
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(compactJwt)
    ) invalid();
    const receivedAt = timestamp(input.receivedAt);
    const verifier = input.verifyToken === undefined ? productionTokenVerifier : input.verifyToken;
    if (typeof verifier !== 'function') invalid();
    let result: unknown;
    try {
      result = await (verifier as CanvasLiveEventTokenVerifier)(compactJwt, {
        algorithms: ['RS256'], jwkSetUrl: CANVAS_LIVE_EVENTS_JWKS_URL,
      });
    } catch { return invalid(); }
    const verified = exact(result, ['payload']);
    return normalizeClaims(verified.payload, receivedAt, await sourceEventId(compactJwt));
  } catch (error) {
    if (error instanceof LearningCanvasLiveEventError) throw error;
    return invalid();
  }
}

function normalizeEvent(value: unknown): CanvasLiveEvent {
  const row = exact(value, [
    'sourceEventId', 'rootAccountId', 'sourceHostname', 'externalCourseId',
    'eventName', 'eventTime', 'receivedAt',
  ]);
  const sourceId = bounded(row.sourceEventId, 50, 50);
  if (!/^sha256:[A-Za-z0-9_-]{43}$/u.test(sourceId)) invalid();
  const eventName = bounded(row.eventName, 1, 96);
  if (!RELEVANT_EVENTS.has(eventName)) invalid();
  return Object.freeze({
    sourceEventId: sourceId,
    rootAccountId: externalId(row.rootAccountId),
    sourceHostname: hostname(row.sourceHostname),
    externalCourseId: externalId(row.externalCourseId),
    eventName,
    eventTime: timestamp(row.eventTime),
    receivedAt: timestamp(row.receivedAt),
  });
}

export interface AcceptedCanvasLiveEvent {
  readonly connectionId: number;
  readonly sourceEventId: string;
  readonly externalCourseId: string;
  readonly disposition: 'claimed' | 'in_progress' | 'succeeded';
  readonly claimMarker: string | null;
  readonly attemptCount: number;
}

function receiptResult(
  value: unknown,
  event: CanvasLiveEvent,
  connectionId: number,
  ownMarker: string,
): AcceptedCanvasLiveEvent {
  const row = record(value);
  if (row.external_course_id !== event.externalCourseId || row.event_name !== event.eventName) invalid();
  const attemptCount = databaseInteger(row.attempt_count);
  let disposition: AcceptedCanvasLiveEvent['disposition'] = 'in_progress';
  let claimMarker: string | null = null;
  if (row.status === 'succeeded') {
    if (row.claim_marker !== null || row.claim_expires_at !== null) invalid();
    disposition = 'succeeded';
  } else if (row.status === 'pending') {
    claimMarker = uuid(row.claim_marker);
    timestamp(row.claim_expires_at);
    disposition = claimMarker === ownMarker ? 'claimed' : 'in_progress';
  } else invalid();
  return Object.freeze({
    connectionId,
    sourceEventId: event.sourceEventId,
    externalCourseId: event.externalCourseId,
    disposition,
    claimMarker,
    attemptCount,
  });
}

export async function acceptCanvasLiveEvent(
  db: AppDb,
  rawEvent: CanvasLiveEvent,
): Promise<AcceptedCanvasLiveEvent> {
  const event = normalizeEvent(rawEvent);
  try {
    const result = await db.prepare(`SELECT connection.id AS connection_id,
        connection.base_url AS base_url
      FROM learning_canvas_webhook_configs config
      JOIN learning_provider_connections connection ON connection.id=config.connection_id
      JOIN learning_courses course ON course.connection_id=connection.id
      WHERE config.root_account_id=?1 AND config.verification_mode='instructure_jwt'
        AND config.jwk_set_url=?2 AND config.status='active'
        AND connection.provider='canvas' AND connection.status='active'
        AND connection.deleted_at IS NULL AND course.provider='canvas'
        AND course.external_course_id=?3 AND course.lifecycle_state='active'
        AND course.deleted_at IS NULL
      ORDER BY connection.id LIMIT 3`)
      .bind(event.rootAccountId, CANVAS_LIVE_EVENTS_JWKS_URL, event.externalCourseId)
      .all<Record<string, unknown>>();
    if (!result || !Array.isArray(result.results)) invalid();
    const matches = result.results.filter((row) => {
      try {
        return new URL(normalizeCanvasBaseUrl(row.base_url)).hostname === event.sourceHostname;
      } catch { return false; }
    });
    if (matches.length !== 1) invalid();
    const connectionId = databaseInteger(matches[0]?.connection_id);
    const marker = uuid(crypto.randomUUID());
    const claimExpiresAt = new Date(Date.parse(event.receivedAt) + CLAIM_TTL_MS).toISOString();
    const claimed = await db.prepare(`INSERT INTO learning_canvas_event_receipts AS receipt
      (connection_id,source_event_id,external_course_id,event_name,received_at,status,
       attempt_count,claim_marker,claim_expires_at,completed_at)
      VALUES(?1,?2,?3,?4,?5,'pending',1,?6,?7,NULL)
      ON CONFLICT(connection_id,source_event_id) DO UPDATE SET
        received_at=excluded.received_at,status='pending',attempt_count=receipt.attempt_count+1,
        claim_marker=excluded.claim_marker,claim_expires_at=excluded.claim_expires_at,completed_at=NULL
      WHERE receipt.external_course_id=excluded.external_course_id
        AND receipt.event_name=excluded.event_name
        AND (
          receipt.status='failed'
          OR (receipt.status='pending' AND (
            receipt.claim_expires_at IS NULL OR receipt.claim_expires_at<=excluded.received_at
          ))
        )
      RETURNING external_course_id,event_name,status,attempt_count,claim_marker,claim_expires_at`)
      .bind(
        connectionId, event.sourceEventId, event.externalCourseId, event.eventName,
        event.receivedAt, marker, claimExpiresAt,
      ).run<Record<string, unknown>>();
    if (!claimed || !Array.isArray(claimed.results) || claimed.results.length > 1) invalid();
    if (claimed.results.length === 1) {
      return receiptResult(claimed.results[0], event, connectionId, marker);
    }
    const existing = await db.prepare(`SELECT external_course_id,event_name,status,
        attempt_count,claim_marker,claim_expires_at
      FROM learning_canvas_event_receipts
      WHERE connection_id=?1 AND source_event_id=?2 LIMIT 1`)
      .bind(connectionId, event.sourceEventId).first<Record<string, unknown>>();
    return receiptResult(existing, event, connectionId, marker);
  } catch (error) {
    if (error instanceof LearningCanvasLiveEventError) throw error;
    return invalid();
  }
}

export async function finishCanvasLiveEvent(
  db: AppDb,
  rawInput: {
    readonly receipt: AcceptedCanvasLiveEvent;
    readonly outcome: 'failed' | 'succeeded';
    readonly completedAt: string;
  },
): Promise<void> {
  try {
    const input = exact(rawInput, ['receipt', 'outcome', 'completedAt']);
    const receipt = exact(input.receipt, [
      'connectionId', 'sourceEventId', 'externalCourseId', 'disposition',
      'claimMarker', 'attemptCount',
    ]);
    const connectionId = databaseInteger(receipt.connectionId);
    const sourceId = bounded(receipt.sourceEventId, 50, 50);
    externalId(receipt.externalCourseId);
    if (receipt.disposition !== 'claimed') invalid();
    const marker = uuid(receipt.claimMarker);
    databaseInteger(receipt.attemptCount);
    if (input.outcome !== 'failed' && input.outcome !== 'succeeded') invalid();
    const outcome = input.outcome as 'failed' | 'succeeded';
    const completedAt = timestamp(input.completedAt);
    const result = await db.prepare(`UPDATE learning_canvas_event_receipts SET
        status=?1,claim_marker=NULL,claim_expires_at=NULL,completed_at=?2
      WHERE connection_id=?3 AND source_event_id=?4
        AND status='pending' AND claim_marker=?5
      RETURNING connection_id,source_event_id`)
      .bind(outcome, completedAt, connectionId, sourceId, marker)
      .run<Record<string, unknown>>();
    if (
      !result || !Array.isArray(result.results) || result.results.length !== 1
      || databaseInteger(result.results[0]?.connection_id) !== connectionId
      || result.results[0]?.source_event_id !== sourceId
    ) throw new LearningCanvasLiveEventConflictError();
  } catch (error) {
    if (
      error instanceof LearningCanvasLiveEventError
      || error instanceof LearningCanvasLiveEventConflictError
    ) throw error;
    return invalid();
  }
}
