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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
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

function diagnosticText(error: unknown): string {
  if (error instanceof Error) {
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

function secretVariants(secrets: readonly string[]): string[] {
  const variants = new Set<string>();
  const add = (secret: string) => {
    if (!secret) return;
    variants.add(secret);
    try {
      const decoded = decodeURIComponent(secret);
      if (decoded) variants.add(decoded);
    } catch {
      // A malformed percent sequence has no decoded variant.
    }
    try {
      const encoded = encodeURIComponent(secret);
      if (encoded) variants.add(encoded);
    } catch {
      // Lone surrogates have no URI-encoded variant; the exact secret remains.
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

export function sanitizeStripeDiagnostic(error: unknown, secrets: readonly string[] = []): string {
  let output = diagnosticText(error)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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

  return truncateUtf8(output, DIAGNOSTIC_MAX_BYTES);
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
