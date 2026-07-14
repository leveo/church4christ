// Pure-node tests for the fetch-based Stripe client (src/lib/stripe.ts). This
// suite has NO database dependency and is intentionally NOT skipIf-gated: it
// runs on every `npm test` regardless of DATABASE_URL. The Stripe REST calls are
// exercised through a mock fetcher that captures the outgoing request, and
// webhook signatures are produced in-test with real WebCrypto HMAC-SHA256 so the
// verifier is tested against genuine signatures (never a hand-faked hex string).
import { describe, it, expect } from 'vitest';
import {
  stripeForm,
  stripeRequest,
  createOneTimeCheckout,
  createRecurringCheckout,
  createRegistrationCheckout,
  createRegistrationCheckoutFromParams,
  createPortalSession,
  requireRegistrationCheckoutSession,
  requireTestCheckoutSession,
  retrieveCheckoutSession,
  retrieveSubscription,
  verifyStripeWebhook,
  type StripeEnv,
} from '../../src/lib/stripe';
import { buildRegistrationCheckoutParams } from '../../src/lib/stripeCheckoutRequests';

// ── Test fetcher ─────────────────────────────────────────────────────────────
type Captured = { url: string; init?: RequestInit };
function mockFetch(response: Response | (() => Response)) {
  const calls: Captured[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return typeof response === 'function' ? response() : response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Decode a captured x-www-form-urlencoded body into a plain object. */
const bodyEntries = (call: Captured): Record<string, string> =>
  Object.fromEntries(new URLSearchParams((call.init?.body as string) ?? ''));
const headersOf = (call: Captured): Record<string, string> =>
  call.init?.headers as Record<string, string>;

const ENV: StripeEnv = {
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_secret',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  APP_ORIGIN: 'https://church.example',
};

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const CHECKOUT_SESSION = {
  id: 'cs_test_fixture',
  url: 'https://checkout.stripe.com/c/pay/cs_test_fixture',
  mode: 'payment' as const,
  livemode: false as const,
  status: null,
  payment_status: null,
  payment_intent: null,
  amount_total: 5000,
  currency: 'usd',
  metadata: {
    kind: 'gift', fund_id: '7', person_id: '42',
    donor_name: 'Ada Lovelace', donor_email: 'ada@example.com',
  },
};
const checkoutJson = (overrides: Record<string, unknown> = {}) => json({ ...CHECKOUT_SESSION, ...overrides });

/** Sign a payload the way Stripe does: v1 = hex HMAC-SHA256 over `${t}.${body}`. */
async function signStripe(secret: string, payload: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${hex}`;
}

// ── stripeForm ───────────────────────────────────────────────────────────────
describe('stripeForm', () => {
  it('nests objects as a[b] and arrays as c[0][d]', () => {
    expect(Object.fromEntries(stripeForm({ a: { b: 1 }, c: [{ d: 2 }] }))).toEqual({
      'a[b]': '1',
      'c[0][d]': '2',
    });
  });

  it('deep-nests the checkout line_items shape from the brief', () => {
    expect(Object.fromEntries(stripeForm({ line_items: [{ price_data: { unit_amount: 500 } }] }))).toEqual({
      'line_items[0][price_data][unit_amount]': '500',
    });
  });

  it('skips undefined and null but keeps empty strings', () => {
    expect(Object.fromEntries(stripeForm({ a: undefined, b: null, c: 'keep', d: '' }))).toEqual({
      c: 'keep',
      d: '',
    });
  });

  it('stringifies numbers and booleans', () => {
    expect(Object.fromEntries(stripeForm({ n: 5, t: true, f: false }))).toEqual({
      n: '5',
      t: 'true',
      f: 'false',
    });
  });

  it('indexes every array element', () => {
    expect(Object.fromEntries(stripeForm({ items: ['x', 'y'] }))).toEqual({
      'items[0]': 'x',
      'items[1]': 'y',
    });
  });
});

// ── stripeRequest ────────────────────────────────────────────────────────────
describe('stripeRequest', () => {
  it('POSTs a Bearer-authed form body to the v1 endpoint', async () => {
    const { fn, calls } = mockFetch(json({ id: 'obj_1' }));
    const out = await stripeRequest(ENV, 'checkout/sessions', { mode: 'payment' }, { fetcher: fn });
    expect(out).toEqual({ id: 'obj_1' });
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(calls[0].init?.method).toBe('POST');
    expect(headersOf(calls[0]).Authorization).toBe('Bearer sk_test_secret');
    expect(headersOf(calls[0])['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0].init?.body).toBe('mode=payment');
  });

  it.each(['sk_live_secret', 'rk_test_secret', 'secret', ''])('rejects key %j before fetch', async (key) => {
    const { fn, calls } = mockFetch(json({ id: 'obj_1' }));
    await expect(
      stripeRequest({ ...ENV, STRIPE_SECRET_KEY: key }, 'checkout/sessions', {}, { fetcher: fn }),
    ).rejects.toMatchObject({ code: 'stripe_test_key_required', stage: 'configuration' });
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, '', 'live', 'TEST'])('rejects non-test mode %j before fetch', async (mode) => {
    const { fn, calls } = mockFetch(json({ id: 'obj_1' }));
    await expect(
      stripeRequest({ ...ENV, STRIPE_MODE: mode }, 'checkout/sessions', {}, { fetcher: fn }),
    ).rejects.toMatchObject({ code: 'stripe_test_mode_required', stage: 'configuration' });
    expect(calls).toHaveLength(0);
  });

  it('sends a validated idempotency key and forwards the abort signal', async () => {
    const { fn, calls } = mockFetch(json({ id: 'obj_1' }));
    const signal = AbortSignal.abort();
    const idempotencyKey = `church4christ:registration:${REQUEST_ID}`;
    await stripeRequest(ENV, 'checkout/sessions', { mode: 'payment' }, { fetcher: fn, idempotencyKey, signal });
    expect(headersOf(calls[0])['Idempotency-Key']).toBe(idempotencyKey);
    expect(calls[0].init?.signal).toBe(signal);
  });

  it.each(['', 'a'.repeat(256), 'line\nbreak', 'line\rbreak', 'snowman-☃'])(
    'rejects invalid idempotency key %j before fetch',
    async (idempotencyKey) => {
      const { fn, calls } = mockFetch(json({ id: 'obj_1' }));
      await expect(
        stripeRequest(ENV, 'checkout/sessions', {}, { fetcher: fn, idempotencyKey }),
      ).rejects.toMatchObject({ code: 'stripe_idempotency_key_invalid', stage: 'configuration' });
      expect(calls).toHaveLength(0);
    },
  );

  it('preserves only bounded Stripe classification fields on a non-2xx response', async () => {
    const long = 'x'.repeat(600);
    const { fn } = mockFetch(
      new Response(
        JSON.stringify({
          error: { message: long, type: `type-${long}`, code: `code-${long}`, secret: 'raw-body-marker' },
        }),
        { status: 402, headers: { 'request-id': `req-${long}` } },
      ),
    );
    try {
      await stripeRequest(ENV, 'checkout/sessions', {}, { fetcher: fn });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ status: 402, stage: 'response' });
      expect((error as Error).message).toBe(long.slice(0, 500));
      expect((error as { type?: string }).type).toBe(`type-${long}`.slice(0, 128));
      expect((error as { code?: string }).code).toBe(`code-${long}`.slice(0, 128));
      expect((error as { requestId?: string }).requestId).toBe(`req-${long}`.slice(0, 128));
      expect(error).not.toHaveProperty('body');
      expect(JSON.stringify(error)).not.toContain('raw-body-marker');
      expect((error as Error).message).not.toContain('sk_test_secret');
    }
  });

  it('classifies fetch rejection as a bounded transport error', async () => {
    const fetcher = (async () => {
      throw new Error('network failed '.repeat(100));
    }) as typeof fetch;
    await expect(stripeRequest(ENV, 'checkout/sessions', {}, { fetcher })).rejects.toMatchObject({
      name: 'StripeError',
      stage: 'transport',
    });
    try {
      await stripeRequest(ENV, 'checkout/sessions', {}, { fetcher });
    } catch (error) {
      expect((error as Error).message.length).toBeLessThanOrEqual(500);
    }
  });

  it('classifies malformed successful JSON as a response error without retaining the body', async () => {
    const { fn } = mockFetch(new Response('raw-body-marker', { status: 200 }));
    try {
      await stripeRequest(ENV, 'checkout/sessions', {}, { fetcher: fn });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ code: 'stripe_response_invalid', stage: 'response' });
      expect(JSON.stringify(error)).not.toContain('raw-body-marker');
    }
  });

  it('omits the idempotency header when no key is supplied', async () => {
    const { fn, calls } = mockFetch(json({ id: 'obj_1' }));
    await stripeRequest(ENV, 'checkout/sessions', {}, { fetcher: fn });
    expect(headersOf(calls[0])['Idempotency-Key']).toBeUndefined();
  });

  it('rejects an unset secret after the test-mode marker and never calls fetch', async () => {
    const { fn, calls } = mockFetch(json({}));
    await expect(stripeRequest({ STRIPE_MODE: 'test' }, 'checkout/sessions', {}, { fetcher: fn })).rejects.toMatchObject({
      code: 'stripe_test_key_required',
      stage: 'configuration',
    });
    expect(calls).toHaveLength(0);
  });
});

// ── createOneTimeCheckout ────────────────────────────────────────────────────
// Contract checks for both create and retrieve responses.
describe('Checkout response contract', () => {
  const oneTimeArgs = {
    amountCents: 5000,
    currency: 'usd',
    fundId: 7,
    fundName: 'General',
    locale: 'en',
    personId: 42,
    donorName: 'Ada Lovelace',
    donorEmail: 'ada@example.com',
  };

  const requests = [
    ['create', (body: Record<string, unknown>) => {
      const { fn } = mockFetch(json(body));
      return createOneTimeCheckout(ENV, oneTimeArgs, { fetcher: fn, requestId: REQUEST_ID });
    }],
    ['retrieve', (body: Record<string, unknown>) => {
      const { fn } = mockFetch(json(body));
      return retrieveCheckoutSession(ENV, CHECKOUT_SESSION.id, { fetcher: fn });
    }],
  ] as const;

  it.each(requests)('%s rejects livemode:true before other response defects', async (_name, request) => {
    await expect(request({ livemode: true })).rejects.toMatchObject({
      code: 'live_mode_disabled',
      stage: 'response',
    });
  });

  it.each(requests)('%s rejects missing and non-boolean livemode', async (_name, request) => {
    const { livemode: _livemode, ...missingMode } = CHECKOUT_SESSION;
    await expect(request(missingMode)).rejects.toMatchObject({ code: 'stripe_response_invalid', stage: 'response' });
    await expect(request({ ...CHECKOUT_SESSION, livemode: 'false' })).rejects.toMatchObject({
      code: 'stripe_response_invalid',
      stage: 'response',
    });
  });

  it.each([
    ['id', 'cs_live_bad'],
    ['url', 123],
    ['status', 'pending'],
    ['payment_status', 'processing'],
    ['payment_intent', 123],
    ['amount_total', -1],
    ['amount_total', 1.5],
    ['currency', 'USD'],
    ['currency', 'x'.repeat(129)],
    ['metadata', []],
    ['metadata', { kind: 1 }],
    ['metadata', { ['x'.repeat(129)]: 'value' }],
    ['metadata', { kind: 'x'.repeat(501) }],
  ])('rejects an invalid %s field without coercion', (field, value) => {
    expect(() => requireTestCheckoutSession({ ...CHECKOUT_SESSION, [field]: value })).toThrow(
      expect.objectContaining({ code: 'stripe_response_invalid', stage: 'response' }),
    );
  });

  it('accepts the complete nullable test-mode Checkout shape', () => {
    expect(requireTestCheckoutSession(CHECKOUT_SESSION)).toEqual(CHECKOUT_SESSION);
  });

  it('requires exact test registration identity and payment fields for recovery', () => {
    const expected = {
      requestId: REQUEST_ID,
      registrationId: 88,
      amountCents: 2500,
      currency: 'usd',
      sessionId: 'cs_test_registration_recovery',
    };
    const valid = {
      ...CHECKOUT_SESSION,
      id: expected.sessionId,
      mode: 'payment' as const,
      amount_total: 2500,
      currency: 'usd',
      metadata: {
        kind: 'registration', registration_id: '88', request_id: REQUEST_ID,
      },
    };
    expect(requireRegistrationCheckoutSession(valid, expected)).toEqual(valid);
    for (const override of [
      { livemode: true },
      { id: 'cs_live_wrong' },
      { id: 'cs_test_other' },
      { mode: 'subscription' },
      { amount_total: 2501 },
      { currency: 'cad' },
      { metadata: { kind: 'registration', registration_id: '99', request_id: REQUEST_ID } },
      { metadata: { kind: 'registration', registration_id: '88', request_id: `${REQUEST_ID.slice(0, -1)}2` } },
      { metadata: { kind: 'registration', registration_id: '88', request_id: REQUEST_ID, extra: 'no' } },
      { url: 'https://evil.example/checkout' },
      { payment_status: 'paid', payment_intent: null },
      { payment_status: 'paid', payment_intent: 'not_a_payment_intent' },
    ]) {
      expect(() => requireRegistrationCheckoutSession({ ...valid, ...override }, expected))
        .toThrow(expect.objectContaining({ stage: 'response' }));
    }
  });

  it.each(['cs_live_x', 'cs_test_', `cs_test_${'a'.repeat(241)}`, 'cs_test_bad-value'])(
    'rejects invalid test Checkout id %j before fetch',
    async (id) => {
      const { fn, calls } = mockFetch(checkoutJson());
      await expect(retrieveCheckoutSession(ENV, id, { fetcher: fn })).rejects.toMatchObject({
        code: 'stripe_session_id_invalid',
        stage: 'configuration',
      });
      expect(calls).toHaveLength(0);
    },
  );

  it('retrieves a test Checkout Session with GET, auth, and the supplied signal', async () => {
    const { fn, calls } = mockFetch(checkoutJson());
    const signal = AbortSignal.abort();
    const session = await retrieveCheckoutSession(ENV, CHECKOUT_SESSION.id, { fetcher: fn, signal });
    expect(session).toEqual(CHECKOUT_SESSION);
    expect(calls[0].url).toBe(`https://api.stripe.com/v1/checkout/sessions/${CHECKOUT_SESSION.id}`);
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.body).toBeUndefined();
    expect(calls[0].init?.signal).toBe(signal);
    expect(headersOf(calls[0]).Authorization).toBe('Bearer sk_test_secret');
  });
});

// createOneTimeCheckout
describe('createOneTimeCheckout', () => {
  const base = {
    amountCents: 5000,
    currency: 'usd',
    fundId: 7,
    fundName: 'General',
    locale: 'en',
    personId: 42,
    donorName: 'Ada Lovelace',
    donorEmail: 'ada@example.com',
  };

  it('signed-in donor with a saved customer → customer set, no email/creation', async () => {
    const { fn, calls } = mockFetch(checkoutJson({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }));
    const out = await createOneTimeCheckout(ENV, { ...base, customerId: 'cus_123' }, { fetcher: fn, requestId: REQUEST_ID });
    expect(out).toEqual({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    expect(headersOf(calls[0])['Idempotency-Key']).toBe(`church4christ:giving:${REQUEST_ID}`);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(bodyEntries(calls[0])).toEqual({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '5000',
      'line_items[0][price_data][product_data][name]': 'General (giving)',
      success_url: 'https://church.example/en/give/thanks?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://church.example/en/give',
      'metadata[kind]': 'gift',
      'metadata[fund_id]': '7',
      'metadata[person_id]': '42',
      'metadata[donor_name]': 'Ada Lovelace',
      'metadata[donor_email]': 'ada@example.com',
      'payment_intent_data[metadata][kind]': 'gift',
      'payment_intent_data[metadata][fund_id]': '7',
      'payment_intent_data[metadata][person_id]': '42',
      customer: 'cus_123',
    });
  });

  it('signed-in donor without a customer → customer_email + customer_creation:always', async () => {
    const { fn, calls } = mockFetch(checkoutJson({ id: 'cs_test_2' }));
    await createOneTimeCheckout(ENV, { ...base, customerId: null }, { fetcher: fn, requestId: REQUEST_ID });
    const b = bodyEntries(calls[0]);
    expect(b.customer_email).toBe('ada@example.com');
    expect(b.customer_creation).toBe('always');
    expect(b.customer).toBeUndefined();
    expect(b['metadata[person_id]']).toBe('42');
  });

  it('anonymous donor → customer_email only, NO customer_creation, blank person_id', async () => {
    const { fn, calls } = mockFetch(checkoutJson({
      id: 'cs_test_3',
      metadata: {
        kind: 'gift', fund_id: '7', person_id: '',
        donor_name: 'Ada Lovelace', donor_email: 'ada@example.com',
      },
    }));
    await createOneTimeCheckout(ENV, { ...base, personId: null }, { fetcher: fn, requestId: REQUEST_ID });
    const b = bodyEntries(calls[0]);
    expect(b.customer_email).toBe('ada@example.com');
    expect(b.customer_creation).toBeUndefined();
    expect(b.customer).toBeUndefined();
    expect(b['metadata[person_id]']).toBe('');
    expect(b['payment_intent_data[metadata][person_id]']).toBe('');
  });

  it('rejects a non-integer or non-positive amount', async () => {
    const { fn } = mockFetch(checkoutJson());
    await expect(createOneTimeCheckout(ENV, { ...base, amountCents: 10.5 }, { fetcher: fn, requestId: REQUEST_ID })).rejects.toThrow();
    await expect(createOneTimeCheckout(ENV, { ...base, amountCents: 0 }, { fetcher: fn, requestId: REQUEST_ID })).rejects.toThrow();
    await expect(createOneTimeCheckout(ENV, { ...base, amountCents: -100 }, { fetcher: fn, requestId: REQUEST_ID })).rejects.toThrow();
  });

  it('throws when APP_ORIGIN is unset', async () => {
    const { fn } = mockFetch(checkoutJson());
    await expect(
      createOneTimeCheckout(
        { STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_secret' },
        { ...base, customerId: 'cus_1' },
        { fetcher: fn, requestId: REQUEST_ID },
      ),
    ).rejects.toThrow(/APP_ORIGIN/);
  });

  it.each([null, '', 'http://checkout.stripe.test/session'])(
    'requires a non-empty HTTPS Checkout URL before returning redirect output',
    async (url) => {
      const { fn } = mockFetch(checkoutJson({ url }));
      await expect(createOneTimeCheckout(ENV, base, { fetcher: fn, requestId: REQUEST_ID })).rejects.toMatchObject({
        code: 'stripe_response_invalid',
        stage: 'response',
      });
    },
  );

  it.each([
    ['http://localhost:4321', 'http://localhost:4321/en/give'],
    ['http://127.0.0.1:8787', 'http://127.0.0.1:8787/en/give'],
    ['http://[::1]:3000', 'http://[::1]:3000/en/give'],
  ])('allows exact loopback APP_ORIGIN %s for local setup', async (origin, cancelUrl) => {
    const { fn, calls } = mockFetch(checkoutJson({
      amount_total: 5000,
      currency: 'usd',
      metadata: {
        kind: 'gift', fund_id: '7', person_id: '42',
        donor_name: 'Ada Lovelace', donor_email: 'ada@example.com',
      },
    }));
    await createOneTimeCheckout({ ...ENV, APP_ORIGIN: origin }, base, { fetcher: fn, requestId: REQUEST_ID });
    expect(bodyEntries(calls[0]).cancel_url).toBe(cancelUrl);
  });

  it.each([
    'http://church.example',
    'http://localhost.evil.example:4321',
    'http://user:pass@localhost:4321',
    'http://0.0.0.0:4321',
    'http://127.1:4321',
    'http://2130706433:4321',
    'http://0x7f000001:4321',
    'http://[0:0:0:0:0:0:0:1]:4321',
  ])('rejects non-loopback or credentialed HTTP APP_ORIGIN %s before fetch', async (origin) => {
    const { fn, calls } = mockFetch(checkoutJson());
    await expect(createOneTimeCheckout({ ...ENV, APP_ORIGIN: origin }, base, {
      fetcher: fn,
      requestId: REQUEST_ID,
    })).rejects.toThrow('checkout_origin_invalid');
    expect(calls).toHaveLength(0);
  });

  it.each([
    { url: 'https://evil.example/c/pay/cs_test_bad' },
    { url: 'https://user:pass@checkout.stripe.com/c/pay/cs_test_bad' },
    { url: 'https://checkout.stripe.com:444/c/pay/cs_test_bad' },
    { mode: 'subscription' },
    { amount_total: 9999 },
    { currency: 'cad' },
    { metadata: { kind: 'gift', fund_id: '8', person_id: '42', donor_name: 'Ada Lovelace', donor_email: 'ada@example.com' } },
    { metadata: { kind: 'gift', fund_id: '7', person_id: '99', donor_name: 'Ada Lovelace', donor_email: 'ada@example.com' } },
    { metadata: { kind: 'gift', fund_id: '7', person_id: '42', donor_name: 'Wrong', donor_email: 'ada@example.com' } },
    { metadata: { kind: 'gift', fund_id: '7', person_id: '42', donor_name: 'Ada Lovelace' } },
    {
      metadata: {
        kind: 'gift', fund_id: '7', person_id: '42', donor_name: 'Ada Lovelace',
        donor_email: 'ada@example.com', unexpected: 'value',
      },
    },
  ])('fails closed on mismatched one-time Checkout response %#', async (override) => {
    const valid = {
      mode: 'payment',
      amount_total: 5000,
      currency: 'usd',
      metadata: {
        kind: 'gift', fund_id: '7', person_id: '42',
        donor_name: 'Ada Lovelace', donor_email: 'ada@example.com',
      },
    };
    const { fn } = mockFetch(checkoutJson({ ...valid, ...override }));
    await expect(createOneTimeCheckout(ENV, base, { fetcher: fn, requestId: REQUEST_ID }))
      .rejects.toMatchObject({ code: 'stripe_response_invalid', stage: 'response' });
  });
});

// ── createRecurringCheckout ──────────────────────────────────────────────────
describe('createRecurringCheckout', () => {
  const base = {
    amountCents: 2000,
    currency: 'usd',
    interval: 'month' as const,
    fundId: 3,
    fundName: 'Missions',
    locale: 'zh',
    personId: 9,
    email: 'bo@example.com',
  };

  it('subscription-mode donor with a customer → recurring price + subscription metadata', async () => {
    const { fn, calls } = mockFetch(
      checkoutJson({
        id: 'cs_test_r',
        url: 'https://checkout.stripe.com/c/pay/cs_test_r',
        mode: 'subscription',
        amount_total: 2000,
        metadata: { kind: 'gift', fund_id: '3', person_id: '9' },
      }),
    );
    const out = await createRecurringCheckout(ENV, { ...base, customerId: 'cus_9' }, {
      fetcher: fn,
      requestId: REQUEST_ID,
    });
    expect(out).toEqual({ id: 'cs_test_r', url: 'https://checkout.stripe.com/c/pay/cs_test_r' });
    expect(headersOf(calls[0])['Idempotency-Key']).toBe(`church4christ:giving:${REQUEST_ID}`);
    expect(bodyEntries(calls[0])).toEqual({
      mode: 'subscription',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '2000',
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][product_data][name]': 'Missions (giving)',
      success_url: 'https://church.example/zh/give/thanks?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://church.example/zh/give',
      'subscription_data[metadata][kind]': 'gift',
      'subscription_data[metadata][fund_id]': '3',
      'subscription_data[metadata][person_id]': '9',
      'metadata[kind]': 'gift',
      'metadata[fund_id]': '3',
      'metadata[person_id]': '9',
      customer: 'cus_9',
    });
  });

  it('without a customer → customer_email and never customer_creation', async () => {
    const { fn, calls } = mockFetch(checkoutJson({
      id: 'cs_test_r2',
      mode: 'subscription',
      amount_total: 2000,
      metadata: { kind: 'gift', fund_id: '3', person_id: '9' },
    }));
    await createRecurringCheckout(ENV, { ...base, customerId: null }, { fetcher: fn, requestId: REQUEST_ID });
    const b = bodyEntries(calls[0]);
    expect(b.customer_email).toBe('bo@example.com');
    expect(b.customer).toBeUndefined();
    expect(b.customer_creation).toBeUndefined();
  });

  it('rejects a non-integer or non-positive amount', async () => {
    const { fn } = mockFetch(checkoutJson());
    await expect(createRecurringCheckout(ENV, { ...base, amountCents: 0.5 }, { fetcher: fn, requestId: REQUEST_ID })).rejects.toThrow();
    await expect(createRecurringCheckout(ENV, { ...base, amountCents: 0 }, { fetcher: fn, requestId: REQUEST_ID })).rejects.toThrow();
  });

  it.each([
    { url: 'https://evil.example/c/pay/cs_test_bad' },
    { url: 'https://user:pass@checkout.stripe.com/c/pay/cs_test_bad' },
    { url: 'https://checkout.stripe.com:444/c/pay/cs_test_bad' },
    { mode: 'payment' },
    { amount_total: 9999 },
    { currency: 'cad' },
    { metadata: { kind: 'gift', fund_id: '4', person_id: '9' } },
    { metadata: { kind: 'gift', fund_id: '3', person_id: '10' } },
  ])('fails closed on mismatched recurring Checkout response %#', async (override) => {
    const valid = {
      mode: 'subscription',
      amount_total: 2000,
      currency: 'usd',
      metadata: { kind: 'gift', fund_id: '3', person_id: '9' },
    };
    const { fn } = mockFetch(checkoutJson({ ...valid, ...override }));
    await expect(createRecurringCheckout(ENV, base, { fetcher: fn, requestId: REQUEST_ID }))
      .rejects.toMatchObject({ code: 'stripe_response_invalid', stage: 'response' });
  });
});

// ── createRegistrationCheckout ───────────────────────────────────────────────
describe('createRegistrationCheckout', () => {
  const base = {
    amountCents: 2500,
    currency: 'usd',
    eventTitle: 'Summer Retreat',
    eventId: 12,
    locale: 'en',
    registrationId: 88,
    email: 'reg@example.com',
  };

  it('builds registration Checkout params with stable request metadata and no absolute expiry', async () => {
    const { fn, calls } = mockFetch(
      checkoutJson({ id: 'cs_test_reg', url: 'https://checkout.stripe.com/c/pay/cs_test_reg' }),
    );
    const out = await createRegistrationCheckout(ENV, base, { fetcher: fn, requestId: REQUEST_ID });
    expect(out).toEqual({ id: 'cs_test_reg', url: 'https://checkout.stripe.com/c/pay/cs_test_reg' });
    expect(headersOf(calls[0])['Idempotency-Key']).toBe(`church4christ:registration:${REQUEST_ID}`);

    const b = bodyEntries(calls[0]);
    expect(b.expires_at).toBeUndefined();
    expect(b).toEqual({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '2500',
      'line_items[0][price_data][product_data][name]': 'Summer Retreat',
      success_url: 'https://church.example/en/register/done?ok=1&paid=1',
      cancel_url: `https://church.example/en/register/12?error=waiting&checkoutRequestId=${REQUEST_ID}`,
      customer_email: 'reg@example.com',
      'metadata[kind]': 'registration',
      'metadata[registration_id]': '88',
      'metadata[request_id]': REQUEST_ID,
      'payment_intent_data[metadata][kind]': 'registration',
      'payment_intent_data[metadata][registration_id]': '88',
      'payment_intent_data[metadata][request_id]': REQUEST_ID,
    });
  });

  it('carries the locale + event id into the success/cancel URLs', async () => {
    const { fn, calls } = mockFetch(checkoutJson({ id: 'cs_test_reg2' }));
    await createRegistrationCheckout(ENV, { ...base, locale: 'zh', eventId: 7 }, { fetcher: fn, requestId: REQUEST_ID });
    const b = bodyEntries(calls[0]);
    expect(b.success_url).toBe('https://church.example/zh/register/done?ok=1&paid=1');
    expect(b.cancel_url).toBe(`https://church.example/zh/register/7?error=waiting&checkoutRequestId=${REQUEST_ID}`);
  });

  it('rejects a non-positive amount (a free registration never builds a checkout)', async () => {
    const { fn } = mockFetch(checkoutJson());
    await expect(createRegistrationCheckout(ENV, { ...base, amountCents: 0 }, { fetcher: fn, requestId: REQUEST_ID })).rejects.toThrow();
    await expect(createRegistrationCheckout(ENV, { ...base, amountCents: -100 }, { fetcher: fn, requestId: REQUEST_ID })).rejects.toThrow();
  });

  it('throws when APP_ORIGIN is unset', async () => {
    const { fn } = mockFetch(checkoutJson());
    await expect(
      createRegistrationCheckout(
        { STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_secret' },
        base,
        { fetcher: fn, requestId: REQUEST_ID },
      ),
    ).rejects.toThrow(/APP_ORIGIN/);
  });
});

describe('createRegistrationCheckoutFromParams', () => {
  const params = buildRegistrationCheckoutParams({
    requestId: REQUEST_ID,
    registrationId: 88,
    eventId: 12,
    personId: null,
    name: 'Ada',
    email: 'reg@example.com',
    amountCents: 2500,
    currency: 'usd',
    answers: [],
    eventTitle: 'Summer Retreat',
    locale: 'en',
    appOrigin: 'https://church.example',
  });

  it('posts the exact saved canonical params with the stable registration key', async () => {
    const { fn, calls } = mockFetch(checkoutJson({
      id: 'cs_test_saved',
      url: 'https://checkout.stripe.com/c/pay/cs_test_saved',
      status: 'open',
      payment_status: 'unpaid',
      amount_total: 2500,
      currency: 'usd',
      metadata: params.metadata,
    }));
    const session = await createRegistrationCheckoutFromParams(ENV, params, { fetcher: fn, requestId: REQUEST_ID });
    expect(session.id).toBe('cs_test_saved');
    expect(calls[0].init?.body).toBe(stripeForm(params as unknown as Record<string, unknown>).toString());
    expect(headersOf(calls[0])['Idempotency-Key']).toBe(`church4christ:registration:${REQUEST_ID}`);
    expect(bodyEntries(calls[0]).expires_at).toBeUndefined();
  });

  it('rejects response identity or payment fields that do not match the saved pair', async () => {
    for (const overrides of [
      { metadata: { ...params.metadata, request_id: '00000000-0000-4000-8000-000000000999' } },
      { amount_total: 9999, metadata: params.metadata },
      { currency: 'cad', metadata: params.metadata },
      { livemode: true, metadata: params.metadata },
    ]) {
      const { fn } = mockFetch(checkoutJson(Object.assign({
        id: 'cs_test_saved',
        url: 'https://checkout.stripe.com/c/pay/cs_test_saved',
        amount_total: 2500,
        currency: 'usd',
        metadata: params.metadata,
      }, overrides)));
      await expect(createRegistrationCheckoutFromParams(ENV, params, { fetcher: fn, requestId: REQUEST_ID }))
        .rejects.toMatchObject({ stage: 'response' });
    }
  });
});

// ── createPortalSession + retrieveSubscription ───────────────────────────────
describe('billing portal + subscription retrieve', () => {
  it('createPortalSession posts customer + return_url and returns the url', async () => {
    const { fn, calls } = mockFetch(json({ url: 'https://billing/portal' }));
    const signal = AbortSignal.abort();
    const out = await createPortalSession(ENV, 'cus_1', 'https://church.example/en/give', { fetcher: fn, signal });
    expect(out).toEqual({ url: 'https://billing/portal' });
    expect(calls[0].url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(bodyEntries(calls[0])).toEqual({
      customer: 'cus_1',
      return_url: 'https://church.example/en/give',
    });
    expect(calls[0].init?.signal).toBe(signal);
  });

  it('retrieveSubscription does a GET with no body', async () => {
    const { fn, calls } = mockFetch(json({ id: 'sub_1', status: 'active' }));
    const signal = AbortSignal.abort();
    const out = await retrieveSubscription(ENV, 'sub_1', { fetcher: fn, signal });
    expect(out).toMatchObject({ id: 'sub_1', status: 'active' });
    expect(calls[0].url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.body).toBeUndefined();
    expect(calls[0].init?.signal).toBe(signal);
    expect(headersOf(calls[0]).Authorization).toBe('Bearer sk_test_secret');
  });

  it('retrieveSubscription enforces the test-key guard before fetch', async () => {
    const { fn, calls } = mockFetch(json({ id: 'sub_1' }));
    await expect(
      retrieveSubscription({ ...ENV, STRIPE_SECRET_KEY: 'sk_live_secret' }, 'sub_1', { fetcher: fn }),
    ).rejects.toMatchObject({ code: 'stripe_test_key_required', stage: 'configuration' });
    expect(calls).toHaveLength(0);
  });
});

// ── verifyStripeWebhook ──────────────────────────────────────────────────────
describe('verifyStripeWebhook', () => {
  const secret = 'whsec_abc';
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const now = 1_700_000_000;

  it('accepts a correctly-signed payload and returns the parsed event', async () => {
    const sig = await signStripe(secret, payload, now);
    const event = await verifyStripeWebhook(payload, sig, secret, 300, now);
    expect(event).toMatchObject({ id: 'evt_1', type: 'checkout.session.completed' });
  });

  it('accepts a future timestamp still within tolerance', async () => {
    const future = now + 100;
    const sig = await signStripe(secret, payload, future);
    expect(await verifyStripeWebhook(payload, sig, secret, 300, now)).not.toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const sig = await signStripe(secret, payload, now);
    const tampered = JSON.stringify({ id: 'evt_1', type: 'account.updated' });
    expect(await verifyStripeWebhook(tampered, sig, secret, 300, now)).toBeNull();
  });

  it('rejects the wrong secret', async () => {
    const sig = await signStripe(secret, payload, now);
    expect(await verifyStripeWebhook(payload, sig, 'whsec_other', 300, now)).toBeNull();
  });

  it('rejects a stale timestamp beyond tolerance', async () => {
    const stale = now - 301;
    const sig = await signStripe(secret, payload, stale);
    expect(await verifyStripeWebhook(payload, sig, secret, 300, now)).toBeNull();
  });

  it('rejects a future timestamp beyond tolerance', async () => {
    const future = now + 400;
    const sig = await signStripe(secret, payload, future);
    expect(await verifyStripeWebhook(payload, sig, secret, 300, now)).toBeNull();
  });

  it('rejects a malformed signature header', async () => {
    expect(await verifyStripeWebhook(payload, 'garbage', secret, 300, now)).toBeNull();
    expect(await verifyStripeWebhook(payload, `t=${now}`, secret, 300, now)).toBeNull(); // no v1
    expect(await verifyStripeWebhook(payload, `t=nope,v1=abc`, secret, 300, now)).toBeNull(); // bad t + short v1
  });

  // Secret rotation: during a rotation window Stripe sends one v1 entry per
  // active secret, and its own libraries accept when ANY of them verifies. The
  // parser must therefore keep every v1 entry, not just the last one.
  it('accepts when only the FIRST of two v1 entries is valid (rotation)', async () => {
    const good = await signStripe(secret, payload, now); // "t=<now>,v1=<good>"
    const stale = (await signStripe('whsec_old', payload, now)).split('v1=')[1];
    const header = `${good},v1=${stale}`;
    expect(await verifyStripeWebhook(payload, header, secret, 300, now)).toMatchObject({ id: 'evt_1' });
  });

  it('accepts when only the SECOND of two v1 entries is valid (rotation)', async () => {
    const goodV1 = (await signStripe(secret, payload, now)).split('v1=')[1];
    const staleV1 = (await signStripe('whsec_old', payload, now)).split('v1=')[1];
    const header = `t=${now},v1=${staleV1},v1=${goodV1}`;
    expect(await verifyStripeWebhook(payload, header, secret, 300, now)).toMatchObject({ id: 'evt_1' });
  });

  it('rejects when both v1 entries are garbage', async () => {
    // One well-formed hex signed with the wrong secret, one not even hex.
    const wrongV1 = (await signStripe('whsec_old', payload, now)).split('v1=')[1];
    const header = `t=${now},v1=${wrongV1},v1=nothex`;
    expect(await verifyStripeWebhook(payload, header, secret, 300, now)).toBeNull();
  });

  it('rejects a valid signature over a non-JSON payload (parse guard)', async () => {
    const notJson = 'this is not json';
    const sig = await signStripe(secret, notJson, now);
    expect(await verifyStripeWebhook(notJson, sig, secret, 300, now)).toBeNull();
  });
});
