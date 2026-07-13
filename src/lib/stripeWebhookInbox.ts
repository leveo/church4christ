import type { AppDb } from './appDb';

export const STRIPE_WEBHOOK_MAX_BYTES = 1024 * 1024;
export const STRIPE_LEASE_MS = 10 * 60_000;
export const STRIPE_ATTEMPT_MS = 25_000;
export const STRIPE_MAX_CYCLE_ATTEMPTS = 6;
export const STRIPE_DRAIN_LIMIT = 10;

export type StripeWebhookStatus =
  | 'pending'
  | 'processing'
  | 'processed'
  | 'ignored'
  | 'failed'
  | 'dismissed';

export type StripeDispatchResult =
  | { state: 'processed'; outcome: string }
  | { state: 'ignored'; outcome: string }
  | { state: 'deferred'; outcome: string };

export interface StripeEnvelope {
  eventId: string;
  eventType: string;
  apiVersion: string | null;
  eventCreated: number;
  livemode: boolean;
  event: Record<string, unknown>;
}

type StripeEnvelopeErrorCode =
  | 'stripe_event_invalid_object'
  | 'stripe_event_invalid_id'
  | 'stripe_event_invalid_type'
  | 'stripe_event_invalid_created'
  | 'stripe_event_invalid_livemode'
  | 'stripe_event_invalid_api_version';

export class StripeEnvelopeError extends Error {
  readonly code: StripeEnvelopeErrorCode;

  constructor(code: StripeEnvelopeErrorCode) {
    super(code);
    this.name = 'StripeEnvelopeError';
    this.code = code;
  }
}

const encoder = new TextEncoder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function boundedNonemptyString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && encoder.encode(value).byteLength <= maxBytes;
}

export function parseStripeEnvelope(value: unknown): StripeEnvelope {
  if (!isPlainObject(value)) throw new StripeEnvelopeError('stripe_event_invalid_object');

  const readField = (key: string, code: StripeEnvelopeErrorCode): unknown => {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new StripeEnvelopeError(code);
    }
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) throw new StripeEnvelopeError(code);
    return descriptor.value;
  };

  const id = readField('id', 'stripe_event_invalid_id');
  if (!boundedNonemptyString(id, 255)) {
    throw new StripeEnvelopeError('stripe_event_invalid_id');
  }
  const type = readField('type', 'stripe_event_invalid_type');
  if (!boundedNonemptyString(type, 255)) {
    throw new StripeEnvelopeError('stripe_event_invalid_type');
  }
  const created = readField('created', 'stripe_event_invalid_created');
  if (!Number.isSafeInteger(created) || (created as number) < 0) {
    throw new StripeEnvelopeError('stripe_event_invalid_created');
  }
  const livemode = readField('livemode', 'stripe_event_invalid_livemode');
  if (typeof livemode !== 'boolean') {
    throw new StripeEnvelopeError('stripe_event_invalid_livemode');
  }
  const apiVersion = readField('api_version', 'stripe_event_invalid_api_version');
  if (apiVersion !== undefined && apiVersion !== null && !boundedNonemptyString(apiVersion, 64)) {
    throw new StripeEnvelopeError('stripe_event_invalid_api_version');
  }

  return {
    eventId: id,
    eventType: type,
    apiVersion: apiVersion ?? null,
    eventCreated: created as number,
    livemode,
    event: value,
  };
}

export async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

const RETRY_DELAYS_MS = [
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

/**
 * Returns the delay before the next claim after the numbered attempt finishes.
 * Attempt 6 is claimable but completes the cycle, so it and invalid attempts
 * have no next delay and return null.
 */
export function retryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > RETRY_DELAYS_MS.length) {
    return null;
  }
  return RETRY_DELAYS_MS[attempt - 1];
}

const DIAGNOSTIC_MAX_BYTES = 1000;

function readStringField(value: object, key: string): string | undefined {
  try {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === 'string' && field.length > 0 ? field : undefined;
  } catch {
    return undefined;
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function diagnosticText(error: unknown): string {
  if (isError(error)) {
    const name = readStringField(error, 'name') ?? 'Error';
    const code = readStringField(error, 'code');
    const message = readStringField(error, 'message');
    const classification = code ? `${name} [${code}]` : name;
    return message ? `${classification}: ${message}` : classification;
  }
  if (typeof error === 'string') return error || 'Unknown error';
  if (error !== null && typeof error === 'object') {
    const code = readStringField(error, 'code');
    const message = readStringField(error, 'message');
    if (code && message) return `${code}: ${message}`;
    if (code) return code;
    if (message) return message;
  }
  return 'Unknown error';
}

function normalizeDiagnosticLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function secretVariants(secrets: readonly string[]): string[] {
  const variants = new Set<string>();
  const add = (secret: string) => {
    if (!secret) return;
    const bases = [secret];
    try {
      const decoded = decodeURIComponent(secret);
      if (decoded) bases.push(decoded);
    } catch {
      // A malformed percent sequence has no decoded variant.
    }

    for (const base of bases) {
      const normalized = normalizeDiagnosticLine(base);
      for (const variant of [base, normalized]) {
        if (!variant) continue;
        variants.add(variant);
        try {
          variants.add(encodeURIComponent(variant));
        } catch {
          // Lone surrogates have no URI-encoded variant; the exact secret remains.
        }
      }
    }
  };

  for (const secret of secrets) {
    if (!secret) continue;
    add(secret);
    try {
      const url = new URL(secret);
      add(url.username);
      add(url.password);
      for (const value of url.searchParams.values()) add(value);
    } catch {
      // Most secrets are intentionally not URLs.
    }
  }

  return [...variants].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let output = '';
  let bytes = 0;
  for (const codePoint of value) {
    const size = encoder.encode(codePoint).byteLength;
    if (bytes + size > maxBytes) break;
    output += codePoint;
    bytes += size;
  }
  return output;
}

function safeRedactionMarker(variants: readonly string[]): string {
  for (const candidate of ['[REDACTED]', '***', '…', '‹redacted›']) {
    if (variants.every((secret) => !candidate.includes(secret) && !secret.includes(candidate))) {
      return candidate;
    }
  }
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (variants.every((secret) => !secret.includes(candidate))) return candidate;
  }
  return '';
}

function removeSecretVariants(value: string, variants: readonly string[]): string {
  let output = value;
  let passesRemaining = value.length + 1;
  let changed: boolean;
  do {
    changed = false;
    for (const secret of variants) {
      if (!output.includes(secret)) continue;
      output = output.replaceAll(secret, '');
      changed = true;
    }
    passesRemaining -= 1;
  } while (changed && passesRemaining > 0);
  return output;
}

export function sanitizeStripeDiagnostic(error: unknown, secrets: readonly string[] = []): string {
  let output = normalizeDiagnosticLine(diagnosticText(error));

  const variants = secretVariants(secrets);
  const marker = safeRedactionMarker(variants);
  let changed: boolean;
  do {
    changed = false;
    for (const secret of variants) {
      if (!output.includes(secret)) continue;
      output = output.replaceAll(secret, marker);
      changed = true;
    }
  } while (marker === '' && changed);

  output = output.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#]*@/g,
    `$1${marker || '[REDACTED]'}@`,
  );
  if (marker === '') {
    do {
      changed = false;
      for (const secret of variants) {
        if (!output.includes(secret)) continue;
        output = output.replaceAll(secret, '');
        changed = true;
      }
    } while (changed);
  }

  output = truncateUtf8(output, DIAGNOSTIC_MAX_BYTES);
  return removeSecretVariants(output, variants);
}

export const STRIPE_PROCESSED_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const STRIPE_FAILED_RETENTION_MS = 180 * 24 * 60 * 60_000;

export type StripePayloadRetentionDecision = 'prune' | 'retain' | 'already_null';

export interface StripePayloadRetentionInput {
  status: StripeWebhookStatus;
  completedAtMs: number | null;
  nowMs: number;
  payloadPresent: boolean;
}

/** Pure payload-retention policy for the later SQL pruning implementation. */
export function decideStripePayloadRetention({
  status,
  completedAtMs,
  nowMs,
  payloadPresent,
}: StripePayloadRetentionInput): StripePayloadRetentionDecision {
  if (!payloadPresent) return 'already_null';
  if (status === 'dismissed') return 'prune';
  if (status === 'pending' || status === 'processing' || completedAtMs === null) return 'retain';

  const retentionMs = status === 'failed'
    ? STRIPE_FAILED_RETENTION_MS
    : STRIPE_PROCESSED_RETENTION_MS;
  return nowMs - completedAtMs >= retentionMs ? 'prune' : 'retain';
}

export interface StripeReceiptInput {
  eventId: string;
  payloadJson: string;
  payloadSha256: string;
  eventType: string;
  apiVersion: string | null;
  eventCreated: number;
  livemode: boolean;
}

export type StripeReceiptResult =
  | { kind: 'inserted' | 'duplicate'; status: StripeWebhookStatus; outcome: string | null }
  | { kind: 'collision' };

export interface StripeWebhookClaim {
  eventId: string;
  payloadJson: string;
  payloadSha256: string;
  eventType: string;
  apiVersion: string | null;
  eventCreated: number;
  livemode: number;
  leaseToken: string;
  leaseExpiresAt: string;
  attemptCount: number;
  retryCycleAttempts: number;
}

export interface StripeWebhookAdminRow {
  eventId: string;
  eventType: string;
  apiVersion: string | null;
  eventCreated: number;
  livemode: number;
  status: StripeWebhookStatus;
  outcome: string | null;
  attemptCount: number;
  retryCycleAttempts: number;
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  lastActionBy: number | null;
  lastActionAt: string | null;
  receivedAt: string;
  lastAttemptAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

function utcText(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid date');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function validActorId(actorId: number): boolean {
  return Number.isSafeInteger(actorId) && actorId > 0;
}

/** Durably receive exact signed bytes without ever replacing an existing event. */
export async function receiveStripeEvent(
  db: AppDb,
  input: StripeReceiptInput,
  now: Date,
): Promise<StripeReceiptResult> {
  const stamp = utcText(now);
  const inserted = await db.prepare(`
    INSERT INTO church_private.stripe_webhook_events
      (event_id,payload_json,payload_sha256,event_type,api_version,event_created,livemode,status,next_attempt_at,received_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?8,?8)
    ON CONFLICT(event_id) DO NOTHING
    RETURNING status,outcome
  `).bind(
    input.eventId,
    input.payloadJson,
    input.payloadSha256,
    input.eventType,
    input.apiVersion,
    input.eventCreated,
    input.livemode ? 1 : 0,
    stamp,
  ).first<{ status: StripeWebhookStatus; outcome: string | null }>();
  if (inserted) return { kind: 'inserted', status: inserted.status, outcome: inserted.outcome };

  const existing = await db.prepare(`
    SELECT payload_sha256,status,outcome
    FROM church_private.stripe_webhook_events
    WHERE event_id=?1
  `).bind(input.eventId).first<{
    payload_sha256: string;
    status: StripeWebhookStatus;
    outcome: string | null;
  }>();
  if (!existing || existing.payload_sha256 !== input.payloadSha256) return { kind: 'collision' };
  return { kind: 'duplicate', status: existing.status, outcome: existing.outcome };
}

/** Atomically acquire a due row or reclaim an expired lease. */
export async function claimStripeEvent(
  db: AppDb,
  eventId: string,
  now: Date,
  leaseToken: string,
): Promise<StripeWebhookClaim | null> {
  const stamp = utcText(now);
  const leaseExpiresAt = utcText(new Date(now.getTime() + STRIPE_LEASE_MS));
  return db.prepare(`
    UPDATE church_private.stripe_webhook_events
    SET status='processing',lease_token=?3,lease_expires_at=?4,
        attempt_count=attempt_count+1,retry_cycle_attempts=retry_cycle_attempts+1,
        last_attempt_at=?2,updated_at=?2
    WHERE event_id=?1 AND payload_json IS NOT NULL AND (
      (status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?2))
      OR (status='processing' AND lease_expires_at<=?2)
    )
    RETURNING
      event_id AS "eventId",payload_json AS "payloadJson",payload_sha256 AS "payloadSha256",
      event_type AS "eventType",api_version AS "apiVersion",event_created AS "eventCreated",
      livemode,lease_token AS "leaseToken",lease_expires_at AS "leaseExpiresAt",
      attempt_count AS "attemptCount",retry_cycle_attempts AS "retryCycleAttempts"
  `).bind(eventId, stamp, leaseToken, leaseExpiresAt).first<StripeWebhookClaim>();
}

/** Read only lease metadata and require an unexpired matching processing token. */
export async function assertStripeLease(
  db: AppDb,
  eventId: string,
  leaseToken: string,
  now: Date,
): Promise<boolean> {
  const row = await db.prepare(`
    SELECT event_id,lease_token,lease_expires_at,status
    FROM church_private.stripe_webhook_events
    WHERE event_id=?1
  `).bind(eventId).first<{
    event_id: string;
    lease_token: string | null;
    lease_expires_at: string | null;
    status: StripeWebhookStatus;
  }>();
  return row?.status === 'processing'
    && row.lease_token === leaseToken
    && row.lease_expires_at !== null
    && row.lease_expires_at > utcText(now);
}

async function finishTerminalStripeEvent(
  db: AppDb,
  eventId: string,
  leaseToken: string,
  result: Extract<StripeDispatchResult, { state: 'processed' | 'ignored' }>,
  now: Date,
): Promise<boolean> {
  const stamp = utcText(now);
  const updated = await db.prepare(`
    UPDATE church_private.stripe_webhook_events
    SET status=?1,outcome=?2,next_attempt_at=NULL,lease_token=NULL,lease_expires_at=NULL,
        last_error=NULL,completed_at=?3,updated_at=?3
    WHERE event_id=?4 AND status='processing' AND lease_token=?5
    RETURNING event_id
  `).bind(result.state, result.outcome, stamp, eventId, leaseToken).first<{ event_id: string }>();
  return updated !== null;
}

async function rescheduleOwnedStripeEvent(
  db: AppDb,
  claim: Pick<StripeWebhookClaim, 'eventId' | 'leaseToken' | 'retryCycleAttempts'>,
  outcome: string,
  diagnostic: string,
  now: Date,
): Promise<boolean> {
  const exhausted = claim.retryCycleAttempts >= STRIPE_MAX_CYCLE_ATTEMPTS;
  const delay = retryDelayMs(claim.retryCycleAttempts);
  const next = exhausted || delay === null ? null : utcText(new Date(now.getTime() + delay));
  const stamp = utcText(now);
  const updated = await db.prepare(`
    UPDATE church_private.stripe_webhook_events
    SET status=?1,outcome=?2,next_attempt_at=?3,lease_token=NULL,lease_expires_at=NULL,
        last_error=?4,completed_at=?5,updated_at=?6
    WHERE event_id=?7 AND status='processing' AND lease_token=?8
    RETURNING event_id
  `).bind(
    exhausted ? 'failed' : 'pending',
    outcome,
    next,
    diagnostic,
    exhausted ? stamp : null,
    stamp,
    claim.eventId,
    claim.leaseToken,
  ).first<{ event_id: string }>();
  return updated !== null;
}

/** Finalize a structured dispatch through the current lease token only. */
export async function finalizeStripeEvent(
  db: AppDb,
  eventId: string,
  leaseToken: string,
  result: StripeDispatchResult,
  now: Date,
): Promise<boolean> {
  if (result.state !== 'deferred') {
    return finishTerminalStripeEvent(db, eventId, leaseToken, result, now);
  }
  const claim = await db.prepare(`
    SELECT event_id AS "eventId",lease_token AS "leaseToken",
           retry_cycle_attempts AS "retryCycleAttempts"
    FROM church_private.stripe_webhook_events
    WHERE event_id=?1 AND status='processing' AND lease_token=?2
  `).bind(eventId, leaseToken).first<Pick<StripeWebhookClaim, 'eventId' | 'leaseToken' | 'retryCycleAttempts'>>();
  if (!claim) return false;
  const diagnostic = sanitizeStripeDiagnostic(result.outcome);
  return rescheduleOwnedStripeEvent(db, claim, result.outcome, diagnostic, now);
}

/** Record a thrown attempt error only if the supplied claim still owns the row. */
export async function recordStripeAttemptFailure(
  db: AppDb,
  claim: Pick<StripeWebhookClaim, 'eventId' | 'leaseToken' | 'retryCycleAttempts'>,
  error: unknown,
  now: Date,
  secrets: readonly string[] = [],
): Promise<boolean> {
  return rescheduleOwnedStripeEvent(
    db,
    claim,
    'attempt_failed',
    sanitizeStripeDiagnostic(error, secrets),
    now,
  );
}

/** Compatibility seam used by the processor: all dispatch outcomes share one call. */
export async function finishStripeDispatch(
  db: AppDb,
  claim: Pick<StripeWebhookClaim, 'eventId' | 'leaseToken' | 'retryCycleAttempts'>,
  result: StripeDispatchResult,
  now: Date,
): Promise<boolean> {
  return finalizeStripeEvent(db, claim.eventId, claim.leaseToken, result, now);
}

export async function recordClaimErrorWhenOwned(
  db: AppDb,
  claim: Pick<StripeWebhookClaim, 'eventId' | 'leaseToken' | 'retryCycleAttempts'>,
  error: unknown,
  now: Date,
  secrets: readonly string[] = [],
): Promise<boolean> {
  return recordStripeAttemptFailure(db, claim, error, now, secrets);
}

/** Move an audited terminal event into a fresh retry cycle without resetting lifetime claims. */
export async function replayStripeEvent(
  db: AppDb,
  eventId: string,
  actorId: number,
  now: Date,
): Promise<boolean> {
  if (!validActorId(actorId)) return false;
  const stamp = utcText(now);
  const updated = await db.prepare(`
    UPDATE church_private.stripe_webhook_events
    SET status='pending',outcome='manual_replay',retry_cycle_attempts=0,next_attempt_at=?1,
        lease_token=NULL,lease_expires_at=NULL,last_error=NULL,last_action_by=?2,last_action_at=?1,
        completed_at=NULL,updated_at=?1
    WHERE event_id=?3 AND status IN ('failed','ignored') AND payload_json IS NOT NULL
    RETURNING event_id
  `).bind(stamp, actorId, eventId).first<{ event_id: string }>();
  return updated !== null;
}

/** Make a failed event permanently non-replayable and prune its raw payload immediately. */
export async function dismissStripeEvent(
  db: AppDb,
  eventId: string,
  actorId: number,
  now: Date,
): Promise<boolean> {
  if (!validActorId(actorId)) return false;
  const stamp = utcText(now);
  const updated = await db.prepare(`
    UPDATE church_private.stripe_webhook_events
    SET status='dismissed',outcome='dismissed_by_operator',payload_json=NULL,
        next_attempt_at=NULL,lease_token=NULL,lease_expires_at=NULL,
        last_action_by=?1,last_action_at=?2,completed_at=?2,updated_at=?2
    WHERE event_id=?3 AND status='failed'
    RETURNING event_id
  `).bind(actorId, stamp, eventId).first<{ event_id: string }>();
  return updated !== null;
}

export interface ListStripeWebhookEventsOptions {
  status?: StripeWebhookStatus;
  limit?: number;
}

/** Bounded admin projection; raw event and Checkout request JSON are never selected. */
export async function listStripeWebhookEvents(
  db: AppDb,
  options: ListStripeWebhookEventsOptions = {},
): Promise<StripeWebhookAdminRow[]> {
  const limit = Math.max(1, Math.min(100, Number.isSafeInteger(options.limit) ? options.limit! : 50));
  const { results } = await db.prepare(`
    SELECT event_id AS "eventId",event_type AS "eventType",api_version AS "apiVersion",
      event_created AS "eventCreated",livemode,status,outcome,attempt_count AS "attemptCount",
      retry_cycle_attempts AS "retryCycleAttempts",next_attempt_at AS "nextAttemptAt",
      lease_expires_at AS "leaseExpiresAt",last_error AS "lastError",last_action_by AS "lastActionBy",
      last_action_at AS "lastActionAt",received_at AS "receivedAt",last_attempt_at AS "lastAttemptAt",
      completed_at AS "completedAt",updated_at AS "updatedAt"
    FROM church_private.stripe_webhook_events
    WHERE (CAST(?1 AS TEXT) IS NULL OR status=?1)
    ORDER BY received_at DESC,event_id DESC
    LIMIT ?2
  `).bind(options.status ?? null, limit).all<StripeWebhookAdminRow>();
  return results;
}

/** Return only bounded due identifiers; each later processor opens its own client. */
export async function listDueStripeEventIds(
  db: AppDb,
  now: Date,
  limit = STRIPE_DRAIN_LIMIT,
): Promise<string[]> {
  const boundedLimit = Math.max(1, Math.min(STRIPE_DRAIN_LIMIT, Number.isSafeInteger(limit) ? limit : STRIPE_DRAIN_LIMIT));
  const { results } = await db.prepare(`
    SELECT event_id
    FROM church_private.stripe_webhook_events
    WHERE payload_json IS NOT NULL AND (
      (status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?1))
      OR (status='processing' AND lease_expires_at<=?1)
    )
    ORDER BY COALESCE(next_attempt_at,received_at),event_id
    LIMIT ?2
  `).bind(utcText(now), boundedLimit).all<{ event_id: string }>();
  return results.map((row) => row.event_id);
}

export interface StripePayloadPruneResult {
  processedOrIgnored: number;
  failed: number;
}

/** Apply the exact terminal-payload windows while retaining permanent audit metadata. */
export async function pruneStripeWebhookPayloads(
  db: AppDb,
  now: Date,
): Promise<StripePayloadPruneResult> {
  const processedCutoff = utcText(new Date(now.getTime() - STRIPE_PROCESSED_RETENTION_MS));
  const failedCutoff = utcText(new Date(now.getTime() - STRIPE_FAILED_RETENTION_MS));
  const stamp = utcText(now);
  const processed = await db.prepare(`
    UPDATE church_private.stripe_webhook_events
    SET payload_json=NULL,updated_at=?1
    WHERE status='processed' AND payload_json IS NOT NULL AND completed_at<=?2
  `).bind(stamp, processedCutoff).run();
  const ignored = await db.prepare(`
    UPDATE church_private.stripe_webhook_events
    SET payload_json=NULL,updated_at=?1
    WHERE status='ignored' AND payload_json IS NOT NULL AND completed_at<=?2
  `).bind(stamp, processedCutoff).run();
  const failed = await db.prepare(`
    UPDATE church_private.stripe_webhook_events
    SET payload_json=NULL,outcome='payload_expired',updated_at=?1
    WHERE status='failed' AND payload_json IS NOT NULL AND completed_at<=?2
  `).bind(stamp, failedCutoff).run();
  return {
    processedOrIgnored: processed.meta.changes + ignored.meta.changes,
    failed: failed.meta.changes,
  };
}
