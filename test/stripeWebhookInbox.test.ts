import { describe, expect, expectTypeOf, it } from 'vitest';
import { verifyStripeWebhook } from '../src/lib/stripe';
import {
  STRIPE_ATTEMPT_MS,
  STRIPE_DRAIN_LIMIT,
  STRIPE_LEASE_MS,
  STRIPE_MAX_CYCLE_ATTEMPTS,
  STRIPE_PROCESSED_RETENTION_MS,
  STRIPE_FAILED_RETENTION_MS,
  STRIPE_WEBHOOK_MAX_BYTES,
  decideStripePayloadRetention,
  parseStripeEnvelope,
  retryDelayMs,
  sanitizeStripeDiagnostic,
  sha256Utf8,
  type StripeDispatchResult,
} from '../src/lib/stripeWebhookInbox';
import { signedStripeRequest, stripeEvent } from './stripeFixtures';

const expectEnvelopeError = (value: unknown, code: string) => {
  try {
    parseStripeEnvelope(value);
    expect.unreachable('expected parseStripeEnvelope to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).toBe(code);
  }
};

describe('stripe webhook constants', () => {
  it('fixes the bounded drain and claim timings', () => {
    expect(STRIPE_WEBHOOK_MAX_BYTES).toBe(1024 * 1024);
    expect(STRIPE_LEASE_MS).toBe(10 * 60_000);
    expect(STRIPE_ATTEMPT_MS).toBe(25_000);
    expect(STRIPE_MAX_CYCLE_ATTEMPTS).toBe(6);
    expect(STRIPE_DRAIN_LIMIT).toBe(10);
  });

  it('exposes the approved state-discriminated dispatch result', () => {
    expectTypeOf<StripeDispatchResult>().toEqualTypeOf<
      | { state: 'processed'; outcome: string }
      | { state: 'ignored'; outcome: string }
      | { state: 'deferred'; outcome: string }
    >();
  });
});

describe('parseStripeEnvelope', () => {
  it('returns strict envelope fields and the original complete event', () => {
    const event = stripeEvent('checkout.session.completed', { id: 'cs_test_1' });

    expect(parseStripeEnvelope(event)).toEqual({
      eventId: 'evt_test_000000000001',
      eventType: 'checkout.session.completed',
      apiVersion: '2026-06-30',
      eventCreated: 1_700_000_000,
      livemode: false,
      event,
    });
    expect(parseStripeEnvelope(event).event).toBe(event);
  });

  it.each([null, [], 'event', 42, true, new Date(), new (class EventLike {})()])(
    'rejects non-plain event %j',
    (event) => expectEnvelopeError(event, 'stripe_event_invalid_object'),
  );

  it('classifies a throwing getPrototypeOf trap as invalid_object', () => {
    const event = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('ARBITRARY PROTOTYPE TRAP');
      },
    });

    expectEnvelopeError(event, 'stripe_event_invalid_object');
  });

  it.each([
    ['id', 'stripe_event_invalid_id'],
    ['type', 'stripe_event_invalid_type'],
    ['created', 'stripe_event_invalid_created'],
    ['livemode', 'stripe_event_invalid_livemode'],
    ['api_version', 'stripe_event_invalid_api_version'],
  ] as const)('rejects an accessor for %s with stable classification', (field, code) => {
    const event = stripeEvent('event.test', {});
    Object.defineProperty(event, field, {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error(`ARBITRARY ${field} GETTER`);
      },
    });

    expectEnvelopeError(event, code);
  });

  it.each([
    ['id', 'stripe_event_invalid_id'],
    ['type', 'stripe_event_invalid_type'],
    ['created', 'stripe_event_invalid_created'],
    ['livemode', 'stripe_event_invalid_livemode'],
    ['api_version', 'stripe_event_invalid_api_version'],
  ] as const)('rejects a descriptor trap for %s with stable classification', (field, code) => {
    const event = new Proxy(stripeEvent('event.test', {}), {
      getOwnPropertyDescriptor(target, property) {
        if (property === field) throw new Error(`ARBITRARY ${field} DESCRIPTOR TRAP`);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expectEnvelopeError(event, code);
  });

  it.each([
    [{ type: 'event.test', created: 0, livemode: false }, 'stripe_event_invalid_id'],
    [{ id: '', type: 'event.test', created: 0, livemode: false }, 'stripe_event_invalid_id'],
    [{ id: 7, type: 'event.test', created: 0, livemode: false }, 'stripe_event_invalid_id'],
    [{ id: 'a'.repeat(256), type: 'event.test', created: 0, livemode: false }, 'stripe_event_invalid_id'],
    [{ id: 'evt_1', created: 0, livemode: false }, 'stripe_event_invalid_type'],
    [{ id: 'evt_1', type: '', created: 0, livemode: false }, 'stripe_event_invalid_type'],
    [{ id: 'evt_1', type: 9, created: 0, livemode: false }, 'stripe_event_invalid_type'],
    [{ id: 'evt_1', type: 'a'.repeat(256), created: 0, livemode: false }, 'stripe_event_invalid_type'],
  ] as const)('rejects invalid id/type without coercion', (event, code) => {
    expectEnvelopeError(event, code);
  });

  it('measures id and type limits in UTF-8 bytes', () => {
    const base = { created: 0, livemode: false };
    expect(parseStripeEnvelope({ ...base, id: 'é'.repeat(127) + 'a', type: 'x' }).eventId)
      .toBe('é'.repeat(127) + 'a');
    expectEnvelopeError(
      { ...base, id: 'é'.repeat(128), type: 'x' },
      'stripe_event_invalid_id',
    );
    expect(parseStripeEnvelope({ ...base, id: 'evt_1', type: '雪'.repeat(85) }).eventType)
      .toBe('雪'.repeat(85));
    expectEnvelopeError(
      { ...base, id: 'evt_1', type: `${'雪'.repeat(85)}a` },
      'stripe_event_invalid_type',
    );
  });

  it.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1700000000', null])(
    'rejects invalid created %j without coercion',
    (created) => expectEnvelopeError(
      { id: 'evt_1', type: 'event.test', created, livemode: false },
      'stripe_event_invalid_created',
    ),
  );

  it.each([undefined, null, 0, 1, 'false'])('rejects nonboolean livemode %j', (livemode) => {
    expectEnvelopeError(
      { id: 'evt_1', type: 'event.test', created: 0, livemode },
      'stripe_event_invalid_livemode',
    );
  });

  it('accepts absent or null api_version', () => {
    const base = { id: 'evt_1', type: 'event.test', created: 0, livemode: false };
    expect(parseStripeEnvelope(base).apiVersion).toBeNull();
    expect(parseStripeEnvelope({ ...base, api_version: null }).apiVersion).toBeNull();
  });

  it.each(['', 20260630, false, 'a'.repeat(65)])('rejects invalid api_version %j', (api_version) => {
    expectEnvelopeError(
      { id: 'evt_1', type: 'event.test', created: 0, livemode: false, api_version },
      'stripe_event_invalid_api_version',
    );
  });

  it('measures api_version limits in UTF-8 bytes', () => {
    const base = { id: 'evt_1', type: 'event.test', created: 0, livemode: false };
    expect(parseStripeEnvelope({ ...base, api_version: 'é'.repeat(32) }).apiVersion)
      .toBe('é'.repeat(32));
    expectEnvelopeError(
      { ...base, api_version: `${'é'.repeat(32)}a` },
      'stripe_event_invalid_api_version',
    );
  });
});

describe('sha256Utf8', () => {
  it('hashes exact UTF-8 bytes as lowercase hex', async () => {
    expect(await sha256Utf8('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Utf8('Stripe ☃ 支付')).toBe(
      '63cdccc77ec5de5304bd7a28e7ac4ded7eea3440a38675573e02664a20bb43c8',
    );
  });
});

describe('retryDelayMs', () => {
  it('returns the exact next-claim delay for attempts 1 through 5', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([
      5 * 60_000,
      30 * 60_000,
      2 * 60 * 60_000,
      12 * 60 * 60_000,
      24 * 60 * 60_000,
    ]);
  });

  it.each([6, 0, -1, 1.5, 7, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns null when attempt %j has no next delay',
    (attempt) => expect(retryDelayMs(attempt)).toBeNull(),
  );
});

describe('sanitizeStripeDiagnostic', () => {
  it('extracts bounded Error classification, flattens controls, and omits the stack', () => {
    const error = new Error('first\nsecond\tthird\u0000last') as Error & { code?: string };
    error.name = 'StripeError';
    error.code = 'card_error\runsafe';
    error.stack = 'SECRET STACK TRACE';

    const safe = sanitizeStripeDiagnostic(error);

    expect(safe).toBe('StripeError [card_error unsafe]: first second third last');
    expect(safe).not.toContain('STACK');
    expect(safe).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('redacts every supplied nonempty secret longest-first and common encoded forms', () => {
    const short = 'xy';
    const secret = 's3cr et/雪';
    const encoded = encodeURIComponent(secret);
    const error = new Error(`bad ${secret} ${encoded} ${short}`);

    const safe = sanitizeStripeDiagnostic(error, [short, secret, '']);

    expect(safe).not.toContain(secret);
    expect(safe).not.toContain(encoded);
    expect(safe).not.toContain(short);
    expect(safe).toContain('[REDACTED]');
  });

  it('does not reintroduce a short secret through its redaction marker', () => {
    const secrets = ['[REDACTED]', 'R', '*', '…'];
    const safe = sanitizeStripeDiagnostic(new Error(secrets.join(' ')), secrets);

    for (const secret of secrets) expect(safe).not.toContain(secret);
  });

  it('never throws or retains a lone-surrogate secret', () => {
    const secret = '\ud800';
    let safe = '';

    expect(() => {
      safe = sanitizeStripeDiagnostic(new Error(`unsafe ${secret}`), [secret]);
    }).not.toThrow();
    expect(safe).not.toContain(secret);
  });

  it('never reintroduces fallback text when all safe markers are exhausted', () => {
    const allPrivateUseMarkers = Array.from(
      { length: 0xf8ff - 0xe000 + 1 },
      (_, index) => String.fromCodePoint(0xe000 + index),
    ).join('');
    const secrets = [
      '[REDACTED]',
      '***',
      '…',
      '‹redacted›',
      allPrivateUseMarkers,
      'Unknown error',
    ];

    const safe = sanitizeStripeDiagnostic({ raw: 'ignored' }, secrets);

    expect(safe).toBe('');
    for (const secret of secrets) expect(safe).not.toContain(secret);
  });

  it('removes URL userinfo even when it was not registered as a secret', () => {
    const safe = sanitizeStripeDiagnostic(
      new Error('POST https://stripe-user:stripe-pass@example.com/v1 failed'),
    );

    expect(safe).toBe('Error: POST https://[REDACTED]@example.com/v1 failed');
    expect(safe).not.toContain('stripe-user');
    expect(safe).not.toContain('stripe-pass');
  });

  it('reads only message/code fields from raw objects and never serializes them', () => {
    const safe = sanitizeStripeDiagnostic({
      code: 'request_failed',
      message: 'safe summary',
      rawBody: 'DO_NOT_SERIALIZE',
      stack: 'DO_NOT_INCLUDE',
    });

    expect(safe).toBe('request_failed: safe summary');
    expect(safe).not.toContain('DO_NOT');
    expect(sanitizeStripeDiagnostic({ raw: 'secret' })).toBe('Unknown error');
  });

  it('stays within 1000 UTF-8 bytes without splitting a multibyte code point', () => {
    const safe = sanitizeStripeDiagnostic(new Error('雪'.repeat(500)));
    const bytes = new TextEncoder().encode(safe);

    expect(bytes.byteLength).toBeLessThanOrEqual(1000);
    expect(safe.endsWith('�')).toBe(false);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow();
  });
});

describe('decideStripePayloadRetention', () => {
  const completedAtMs = Date.UTC(2026, 0, 1);

  it('prunes processed and ignored payloads at exactly 90 days, not before', () => {
    for (const status of ['processed', 'ignored'] as const) {
      expect(decideStripePayloadRetention({
        status,
        completedAtMs,
        nowMs: completedAtMs + STRIPE_PROCESSED_RETENTION_MS - 1,
        payloadPresent: true,
      })).toBe('retain');
      expect(decideStripePayloadRetention({
        status,
        completedAtMs,
        nowMs: completedAtMs + STRIPE_PROCESSED_RETENTION_MS,
        payloadPresent: true,
      })).toBe('prune');
    }
  });

  it('prunes failed payloads at exactly 180 days, not before', () => {
    expect(decideStripePayloadRetention({
      status: 'failed',
      completedAtMs,
      nowMs: completedAtMs + STRIPE_FAILED_RETENTION_MS - 1,
      payloadPresent: true,
    })).toBe('retain');
    expect(decideStripePayloadRetention({
      status: 'failed',
      completedAtMs,
      nowMs: completedAtMs + STRIPE_FAILED_RETENTION_MS,
      payloadPresent: true,
    })).toBe('prune');
  });

  it('prunes dismissed immediately and never age-prunes pending or processing', () => {
    expect(decideStripePayloadRetention({
      status: 'dismissed', completedAtMs: null, nowMs: 0, payloadPresent: true,
    })).toBe('prune');
    for (const status of ['pending', 'processing'] as const) {
      expect(decideStripePayloadRetention({
        status, completedAtMs: 0, nowMs: Number.MAX_SAFE_INTEGER, payloadPresent: true,
      })).toBe('retain');
    }
  });

  it('does not prune completed statuses without completed_at and no-ops null payloads', () => {
    expect(decideStripePayloadRetention({
      status: 'processed', completedAtMs: null, nowMs: Number.MAX_SAFE_INTEGER, payloadPresent: true,
    })).toBe('retain');
    expect(decideStripePayloadRetention({
      status: 'dismissed', completedAtMs: null, nowMs: 0, payloadPresent: false,
    })).toBe('already_null');
  });
});

describe('signed Stripe fixture', () => {
  it('preserves the exact body and verifies with real WebCrypto HMAC', async () => {
    const event = stripeEvent('payment_intent.succeeded', { id: 'pi_test_1', note: '雪' });
    const request = await signedStripeRequest(event);
    const body = await request.text();

    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/api/stripe/webhook');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(body).toBe(JSON.stringify(event));
    expect(await verifyStripeWebhook(
      body,
      request.headers.get('stripe-signature') ?? '',
      'whsec_test',
      300,
      1_700_000_000,
    )).toEqual(event);
  });

  it('fails verification after the exact body is tampered', async () => {
    const event = stripeEvent('payment_intent.succeeded', { id: 'pi_test_1' });
    const request = await signedStripeRequest(event);
    const body = await request.text();

    expect(await verifyStripeWebhook(
      body.replace('pi_test_1', 'pi_test_2'),
      request.headers.get('stripe-signature') ?? '',
      'whsec_test',
      300,
      1_700_000_000,
    )).toBeNull();
  });
});
