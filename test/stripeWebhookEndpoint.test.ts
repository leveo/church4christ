import { describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import { STRIPE_WEBHOOK_MAX_BYTES, sha256Utf8, type StripeReceiptResult } from '../src/lib/stripeWebhookInbox';
import { handleStripeWebhookRequest, type StripeWebhookEndpointDeps } from '../src/lib/stripeWebhookEndpoint';
import type { StripeWebhookProcessorDeps } from '../src/lib/stripeWebhookProcessor';
import { signedStripeRequest, stripeEvent, type StripeTestEvent } from './stripeFixtures';

const NOW = 1_700_000_000;
const ENV = {
  DB_BACKEND: 'supabase',
  HYPERDRIVE: { connectionString: 'postgres://test-only.invalid/church' },
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_secret',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  APP_ORIGIN: 'https://church.example',
} as const;

const db = {} as AppDb;

function deps(over: Partial<StripeWebhookEndpointDeps> = {}): StripeWebhookEndpointDeps {
  return {
    db,
    env: ENV,
    modules: new Set(['giving']),
    nowSeconds: NOW,
    receive: vi.fn(async () => ({ kind: 'inserted', status: 'pending', outcome: null } as const)),
    process: vi.fn(async () => ({ state: 'not_claimed' } as const)),
    ...over,
  };
}

async function signed(event: StripeTestEvent = stripeEvent('payment_intent.succeeded', { id: 'pi_test_1' })) {
  return signedStripeRequest(event, ENV.STRIPE_WEBHOOK_SECRET, NOW);
}

async function responseText(response: Response): Promise<[number, string]> {
  return [response.status, await response.text()];
}

describe('handleStripeWebhookRequest', () => {
  it('returns 404 before reading or touching any Stripe dependency when both modules are disabled', async () => {
    const text = vi.fn(async () => { throw new Error('must not read'); });
    const receive = vi.fn();
    const process = vi.fn();
    const waitUntil = vi.fn();
    const request = { headers: new Headers(), text } as unknown as Request;

    const response = await handleStripeWebhookRequest(request, deps({
      modules: new Set(),
      receive,
      process,
      waitUntil,
    }));

    expect(await responseText(response)).toEqual([404, 'Not found']);
    expect(text).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('rejects a declared body above 1 MiB before reading it', async () => {
    const text = vi.fn(async () => { throw new Error('must not read'); });
    const request = {
      headers: new Headers({ 'content-length': String(STRIPE_WEBHOOK_MAX_BYTES + 1) }),
      text,
    } as unknown as Request;

    expect(await responseText(await handleStripeWebhookRequest(request, deps())))
      .toEqual([413, 'payload_too_large']);
    expect(text).not.toHaveBeenCalled();
  });

  it('rejects a measured UTF-8 body above 1 MiB before signature or receipt', async () => {
    const receive = vi.fn();
    const request = new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      body: '雪'.repeat(Math.floor(STRIPE_WEBHOOK_MAX_BYTES / 3) + 1),
    });

    expect(await responseText(await handleStripeWebhookRequest(request, deps({ receive }))))
      .toEqual([413, 'payload_too_large']);
    expect(receive).not.toHaveBeenCalled();
  });

  it.each([
    ['without a content length', undefined],
    ['with a falsely small content length', '1'],
  ])('stops and cancels a chunked body above 1 MiB %s', async (_label, contentLength) => {
    const pulls = vi.fn();
    const cancel = vi.fn();
    const chunks = [
      new Uint8Array(STRIPE_WEBHOOK_MAX_BYTES),
      new Uint8Array([0x78]),
      new TextEncoder().encode('must-not-be-consumed'),
    ];
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls(next);
        if (next >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[next++]!);
      },
      cancel,
    }, { highWaterMark: 0 });
    const headers = contentLength === undefined ? undefined : { 'content-length': contentLength };
    const request = new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers,
      body,
    });
    const receive = vi.fn();

    expect(await responseText(await handleStripeWebhookRequest(request, deps({ receive }))))
      .toEqual([413, 'payload_too_large']);
    expect(pulls).toHaveBeenCalledTimes(2);
    expect(pulls).not.toHaveBeenCalledWith(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(receive).not.toHaveBeenCalled();
  });

  it('rejects a missing webhook secret', async () => {
    const request = await signed();
    const receive = vi.fn();

    expect(await responseText(await handleStripeWebhookRequest(request, deps({
      env: { ...ENV, STRIPE_WEBHOOK_SECRET: undefined },
      receive,
    })))).toEqual([400, 'webhook_not_configured']);
    expect(receive).not.toHaveBeenCalled();
  });

  it('rejects a bad signature', async () => {
    const receive = vi.fn();
    const request = new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': `t=${NOW},v1=${'0'.repeat(64)}` },
      body: JSON.stringify(stripeEvent('payment_intent.succeeded', { id: 'pi_test_1' })),
    });

    expect(await responseText(await handleStripeWebhookRequest(request, deps({ receive }))))
      .toEqual([400, 'invalid_signature']);
    expect(receive).not.toHaveBeenCalled();
  });

  it('rejects a signed malformed envelope without receiving it', async () => {
    const receive = vi.fn();
    const request = await signedStripeRequest({
      ...stripeEvent('payment_intent.succeeded', { id: 'pi_test_1' }),
      id: '',
    }, ENV.STRIPE_WEBHOOK_SECRET, NOW);

    expect(await responseText(await handleStripeWebhookRequest(request, deps({ receive }))))
      .toEqual([400, 'invalid_envelope']);
    expect(receive).not.toHaveBeenCalled();
  });

  it('rejects a signed live envelope before receipt, dispatch, domain mutation, scheduling, or log leakage', async () => {
    const receive = vi.fn();
    const domainMutation = vi.fn();
    const process = vi.fn(async () => {
      domainMutation();
      return { state: 'processed', outcome: 'must_not_run' } as const;
    });
    const waitUntil = vi.fn();
    const rawPayloadMarker = 'raw-live-payload-marker';
    const requestJsonMarker = '{"request_json":"private-live-request"}';
    const secretMarker = 'sk_live_must_not_log';
    const checkoutUrlMarker = 'https://checkout.stripe.com/c/pay/live-private-url';
    const request = await signed(stripeEvent('payment_intent.succeeded', {
      id: 'pi_live_1',
      description: rawPayloadMarker,
      metadata: { request_json: requestJsonMarker, secret: secretMarker },
      url: checkoutUrlMarker,
    }, {
      id: 'evt_live_1',
      livemode: true,
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(await responseText(await handleStripeWebhookRequest(request, deps({ receive, process, waitUntil }))))
        .toEqual([400, 'live_mode_disabled']);
      expect(receive).not.toHaveBeenCalled();
      expect(process).not.toHaveBeenCalled();
      expect(domainMutation).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
      const captured = JSON.stringify([
        ...log.mock.calls, ...info.mock.calls, ...warn.mock.calls, ...error.mock.calls,
      ]);
      for (const privateValue of [rawPayloadMarker, requestJsonMarker, secretMarker, checkoutUrlMarker]) {
        expect(captured).not.toContain(privateValue);
      }
    } finally {
      log.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('returns 500 when durable receipt storage fails without scheduling', async () => {
    const process = vi.fn();
    const waitUntil = vi.fn();

    expect(await responseText(await handleStripeWebhookRequest(await signed(), deps({
      receive: vi.fn(async () => { throw new Error('private storage details'); }),
      process,
      waitUntil,
    })))).toEqual([500, 'receipt_failed']);
    expect(process).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    ['inserted', 'received'],
    ['duplicate', 'pending'],
  ] as const)('does not acknowledge a %s receipt until its write resolves', async (kind, body) => {
    let resolveReceipt!: (value: StripeReceiptResult) => void;
    const receipt = new Promise<StripeReceiptResult>((resolve) => { resolveReceipt = resolve; });
    const receive = vi.fn(() => receipt);
    const responsePromise = handleStripeWebhookRequest(await signed(), deps({
      receive,
    }));
    let settled = false;
    void responsePromise.then(() => { settled = true; });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    resolveReceipt({ kind, status: 'pending', outcome: null });
    expect(await responseText(await responsePromise)).toEqual([200, body]);
  });

  it('passes the exact signed body and envelope metadata into durable receipt', async () => {
    const event = stripeEvent('checkout.session.completed', { id: 'cs_test_1' }, {
      id: 'evt_test_exact',
      api_version: null,
      created: NOW - 30,
    });
    const request = await signed(event);
    const body = JSON.stringify(event);
    const receive = vi.fn(async () => ({ kind: 'inserted', status: 'pending', outcome: null } as const));

    expect((await handleStripeWebhookRequest(request, deps({ receive }))).status).toBe(200);
    expect(receive).toHaveBeenCalledWith(db, {
      eventId: event.id,
      payloadJson: body,
      payloadSha256: await sha256Utf8(body),
      eventType: event.type,
      apiVersion: null,
      eventCreated: event.created,
      livemode: false,
    }, new Date(NOW * 1000));
  });

  it('rejects an event-id collision without scheduling', async () => {
    const process = vi.fn();
    const waitUntil = vi.fn();
    expect(await responseText(await handleStripeWebhookRequest(await signed(), deps({
      receive: vi.fn(async () => ({ kind: 'collision' } as const)),
      process,
      waitUntil,
    })))).toEqual([400, 'event_id_collision']);
    expect(process).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('logs a collision with only a fixed code and safe digest metadata', async () => {
    const event = stripeEvent('payment_intent.succeeded', { secret: 'whsec_do_not_log' }, {
      id: 'evt_test_control\r\nsk_test_do_not_log',
    });
    const request = await signed(event);
    const body = JSON.stringify(event);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(await responseText(await handleStripeWebhookRequest(request, deps({
        receive: vi.fn(async () => ({ kind: 'collision' } as const)),
      })))).toEqual([400, 'event_id_collision']);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('stripe_webhook_event_id_collision', {
        payloadSha256: await sha256Utf8(body),
      });
      const diagnostic = JSON.stringify(warn.mock.calls);
      expect(diagnostic).not.toContain('evt_test_control');
      expect(diagnostic).not.toContain('sk_test_do_not_log');
      expect(diagnostic).not.toContain('whsec_do_not_log');
      expect(diagnostic).not.toMatch(/[\r\n]/);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    [{ kind: 'inserted', status: 'pending', outcome: null }, true, 'received'],
    [{ kind: 'duplicate', status: 'pending', outcome: null }, true, 'pending'],
    [{ kind: 'duplicate', status: 'processing', outcome: null }, false, 'processing'],
    [{ kind: 'duplicate', status: 'processed', outcome: 'gift_recorded' }, false, 'processed'],
    [{ kind: 'duplicate', status: 'ignored', outcome: 'unsupported' }, false, 'ignored'],
    [{ kind: 'duplicate', status: 'failed', outcome: 'attempts_exhausted' }, false, 'failed'],
    [{ kind: 'duplicate', status: 'dismissed', outcome: 'operator_dismissed' }, false, 'dismissed'],
  ] as const)('schedules only inserted or pending duplicate receipt %#', async (receipt, scheduled, body) => {
    const process = vi.fn(async (
      _eventId: string,
      _deps: StripeWebhookProcessorDeps,
    ) => ({ state: 'not_claimed' } as const));
    const waitUntil = vi.fn();

    expect(await responseText(await handleStripeWebhookRequest(await signed(), deps({
      receive: vi.fn(async () => receipt),
      process,
      waitUntil,
    })))).toEqual([200, body]);
    expect(process).toHaveBeenCalledTimes(scheduled ? 1 : 0);
    expect(waitUntil).toHaveBeenCalledTimes(scheduled ? 1 : 0);
  });

  it('acknowledges a duplicate processing receipt durably without launching a second mutation', async () => {
    let resolveReceipt!: (value: StripeReceiptResult) => void;
    const storedReceipt = new Promise<StripeReceiptResult>((resolve) => { resolveReceipt = resolve; });
    const receive = vi.fn(() => storedReceipt);
    const domainMutation = vi.fn();
    const process = vi.fn(async () => {
      domainMutation();
      return { state: 'processed', outcome: 'unsafe_second_mutation' } as const;
    });
    const waitUntil = vi.fn();

    const responsePromise = handleStripeWebhookRequest(await signed(stripeEvent(
      'checkout.session.completed',
      { id: 'cs_test_processing_duplicate' },
      { id: 'evt_test_processing_duplicate' },
    )), deps({ receive, process, waitUntil }));
    let acknowledged = false;
    void responsePromise.then(() => { acknowledged = true; });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);

    resolveReceipt({ kind: 'duplicate', status: 'processing', outcome: null });
    expect(await responseText(await responsePromise)).toEqual([200, 'processing']);
    expect(process).not.toHaveBeenCalled();
    expect(domainMutation).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('never logs raw payload, request JSON, secrets, or Checkout URLs on endpoint failures', async () => {
    const markers = {
      rawPayload: 'raw-customer-payload-marker',
      requestJson: '{"request_json":"private-checkout-request"}',
      secret: 'whsec_endpoint_log_marker',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/private-endpoint-url',
    };
    const event = stripeEvent('checkout.session.completed', {
      id: 'cs_test_log_hygiene',
      description: markers.rawPayload,
      metadata: { request_json: markers.requestJson, secret: markers.secret },
      url: markers.checkoutUrl,
    }, { id: 'evt_test_log_hygiene' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(await responseText(await handleStripeWebhookRequest(await signed(event), deps({
        receive: vi.fn(async () => { throw new Error(
          `${markers.rawPayload} ${markers.requestJson} ${markers.secret} ${markers.checkoutUrl}`,
        ); }),
      })))).toEqual([500, 'receipt_failed']);

      expect(await responseText(await handleStripeWebhookRequest(await signed(event), deps({
        receive: vi.fn(async () => ({ kind: 'collision' } as const)),
      })))).toEqual([400, 'event_id_collision']);

      const captured = JSON.stringify([
        ...log.mock.calls, ...info.mock.calls, ...warn.mock.calls, ...error.mock.calls,
      ]);
      expect(warn).toHaveBeenCalledWith('stripe_webhook_event_id_collision', {
        payloadSha256: await sha256Utf8(JSON.stringify(event)),
      });
      for (const privateValue of Object.values(markers)) expect(captured).not.toContain(privateValue);
    } finally {
      log.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('background acceleration captures only the event id and environment', async () => {
    const process = vi.fn(async (
      _eventId: string,
      _deps: StripeWebhookProcessorDeps,
    ) => ({ state: 'not_claimed' } as const));
    const waitUntil = vi.fn();
    await handleStripeWebhookRequest(await signed(stripeEvent('payment_intent.succeeded', {}, {
      id: 'evt_test_background',
    })), deps({ process, waitUntil }));

    expect(process).toHaveBeenCalledWith('evt_test_background', { env: ENV });
    expect(process.mock.calls[0]).toHaveLength(2);
    expect(process.mock.calls[0]?.[1]).not.toHaveProperty('db');
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it('acknowledges an inserted receipt when the processor seam throws synchronously', async () => {
    const process = vi.fn(() => { throw new Error('processor sync failure'); });
    const waitUntil = vi.fn();

    expect(await responseText(await handleStripeWebhookRequest(await signed(), deps({ process, waitUntil }))))
      .toEqual([200, 'received']);
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it('acknowledges an inserted receipt when waitUntil throws synchronously', async () => {
    const process = vi.fn(async () => ({ state: 'not_claimed' } as const));
    const waitUntil = vi.fn(() => { throw new Error('execution context closed'); });

    expect(await responseText(await handleStripeWebhookRequest(await signed(), deps({ process, waitUntil }))))
      .toEqual([200, 'received']);
    expect(waitUntil).toHaveBeenCalledOnce();
  });
});
