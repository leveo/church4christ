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
  createPortalSession,
  retrieveSubscription,
  verifyStripeWebhook,
  type StripeEnv,
} from '../../src/lib/stripe';

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
  STRIPE_SECRET_KEY: 'sk_test_secret',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  APP_ORIGIN: 'https://church.example',
};

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
    const out = await stripeRequest(ENV, 'checkout/sessions', { mode: 'payment' }, fn);
    expect(out).toEqual({ id: 'obj_1' });
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(calls[0].init?.method).toBe('POST');
    expect(headersOf(calls[0]).Authorization).toBe('Bearer sk_test_secret');
    expect(headersOf(calls[0])['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0].init?.body).toBe('mode=payment');
  });

  it('throws Stripe\'s error.message with a .status on a non-2xx response', async () => {
    // Factory: a fresh Response per call (a body can only be read once).
    const { fn } = mockFetch(() => json({ error: { message: 'Your card was declined.' } }, 402));
    await expect(stripeRequest(ENV, 'checkout/sessions', {}, fn)).rejects.toThrow('Your card was declined.');
    try {
      await stripeRequest(ENV, 'checkout/sessions', {}, fn);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as { status?: number }).status).toBe(402);
      // The secret must never leak into an error surfaced to callers/logs.
      expect((e as Error).message).not.toContain('sk_test_secret');
    }
  });

  it('falls back to status text when the error body has no message', async () => {
    const { fn } = mockFetch(new Response('nope', { status: 500, statusText: 'Internal Server Error' }));
    await expect(stripeRequest(ENV, 'x', {}, fn)).rejects.toThrow('Internal Server Error');
  });

  it('throws when STRIPE_SECRET_KEY is unset (and never calls fetch)', async () => {
    const { fn, calls } = mockFetch(json({}));
    await expect(stripeRequest({}, 'checkout/sessions', {}, fn)).rejects.toThrow(/STRIPE_SECRET_KEY/);
    expect(calls).toHaveLength(0);
  });
});

// ── createOneTimeCheckout ────────────────────────────────────────────────────
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
    const { fn, calls } = mockFetch(json({ id: 'cs_1', url: 'https://checkout/cs_1' }));
    const out = await createOneTimeCheckout(ENV, { ...base, customerId: 'cus_123' }, fn);
    expect(out).toEqual({ id: 'cs_1', url: 'https://checkout/cs_1' });
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
    const { fn, calls } = mockFetch(json({ id: 'cs_2', url: 'https://checkout/cs_2' }));
    await createOneTimeCheckout(ENV, { ...base, customerId: null }, fn);
    const b = bodyEntries(calls[0]);
    expect(b.customer_email).toBe('ada@example.com');
    expect(b.customer_creation).toBe('always');
    expect(b.customer).toBeUndefined();
    expect(b['metadata[person_id]']).toBe('42');
  });

  it('anonymous donor → customer_email only, NO customer_creation, blank person_id', async () => {
    const { fn, calls } = mockFetch(json({ id: 'cs_3', url: 'https://checkout/cs_3' }));
    await createOneTimeCheckout(ENV, { ...base, personId: null }, fn);
    const b = bodyEntries(calls[0]);
    expect(b.customer_email).toBe('ada@example.com');
    expect(b.customer_creation).toBeUndefined();
    expect(b.customer).toBeUndefined();
    expect(b['metadata[person_id]']).toBe('');
    expect(b['payment_intent_data[metadata][person_id]']).toBe('');
  });

  it('rejects a non-integer or non-positive amount', async () => {
    const { fn } = mockFetch(json({ id: 'x', url: 'y' }));
    await expect(createOneTimeCheckout(ENV, { ...base, amountCents: 10.5 }, fn)).rejects.toThrow();
    await expect(createOneTimeCheckout(ENV, { ...base, amountCents: 0 }, fn)).rejects.toThrow();
    await expect(createOneTimeCheckout(ENV, { ...base, amountCents: -100 }, fn)).rejects.toThrow();
  });

  it('throws when APP_ORIGIN is unset', async () => {
    const { fn } = mockFetch(json({ id: 'x', url: 'y' }));
    await expect(
      createOneTimeCheckout({ STRIPE_SECRET_KEY: 'sk' }, { ...base, customerId: 'cus_1' }, fn),
    ).rejects.toThrow(/APP_ORIGIN/);
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
    const { fn, calls } = mockFetch(json({ id: 'cs_r', url: 'https://checkout/cs_r' }));
    const out = await createRecurringCheckout(ENV, { ...base, customerId: 'cus_9' }, fn);
    expect(out).toEqual({ id: 'cs_r', url: 'https://checkout/cs_r' });
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
    const { fn, calls } = mockFetch(json({ id: 'cs_r2', url: 'https://checkout/cs_r2' }));
    await createRecurringCheckout(ENV, { ...base, customerId: null }, fn);
    const b = bodyEntries(calls[0]);
    expect(b.customer_email).toBe('bo@example.com');
    expect(b.customer).toBeUndefined();
    expect(b.customer_creation).toBeUndefined();
  });

  it('rejects a non-integer or non-positive amount', async () => {
    const { fn } = mockFetch(json({ id: 'x', url: 'y' }));
    await expect(createRecurringCheckout(ENV, { ...base, amountCents: 0.5 }, fn)).rejects.toThrow();
    await expect(createRecurringCheckout(ENV, { ...base, amountCents: 0 }, fn)).rejects.toThrow();
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

  it('builds the payment-mode registration checkout param map with a 30-min expiry', async () => {
    const { fn, calls } = mockFetch(json({ id: 'cs_reg', url: 'https://checkout/cs_reg' }));
    const before = Math.floor(Date.now() / 1000);
    const out = await createRegistrationCheckout(ENV, base, fn);
    const after = Math.floor(Date.now() / 1000);
    expect(out).toEqual({ id: 'cs_reg', url: 'https://checkout/cs_reg' });

    const b = bodyEntries(calls[0]);
    // expires_at is computed from Date.now() at call time → now + 1800s.
    const exp = Number(b.expires_at);
    expect(exp).toBeGreaterThanOrEqual(before + 1800);
    expect(exp).toBeLessThanOrEqual(after + 1800);
    delete b.expires_at;
    expect(b).toEqual({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '2500',
      'line_items[0][price_data][product_data][name]': 'Summer Retreat',
      success_url: 'https://church.example/en/register/done?ok=1&paid=1',
      cancel_url: 'https://church.example/en/register/12',
      customer_email: 'reg@example.com',
      'metadata[kind]': 'registration',
      'metadata[registration_id]': '88',
      'payment_intent_data[metadata][kind]': 'registration',
      'payment_intent_data[metadata][registration_id]': '88',
    });
  });

  it('carries the locale + event id into the success/cancel URLs', async () => {
    const { fn, calls } = mockFetch(json({ id: 'cs_reg2', url: 'https://checkout/cs_reg2' }));
    await createRegistrationCheckout(ENV, { ...base, locale: 'zh', eventId: 7 }, fn);
    const b = bodyEntries(calls[0]);
    expect(b.success_url).toBe('https://church.example/zh/register/done?ok=1&paid=1');
    expect(b.cancel_url).toBe('https://church.example/zh/register/7');
  });

  it('rejects a non-positive amount (a free registration never builds a checkout)', async () => {
    const { fn } = mockFetch(json({ id: 'x', url: 'y' }));
    await expect(createRegistrationCheckout(ENV, { ...base, amountCents: 0 }, fn)).rejects.toThrow();
    await expect(createRegistrationCheckout(ENV, { ...base, amountCents: -100 }, fn)).rejects.toThrow();
  });

  it('throws when APP_ORIGIN is unset', async () => {
    const { fn } = mockFetch(json({ id: 'x', url: 'y' }));
    await expect(createRegistrationCheckout({ STRIPE_SECRET_KEY: 'sk' }, base, fn)).rejects.toThrow(/APP_ORIGIN/);
  });
});

// ── createPortalSession + retrieveSubscription ───────────────────────────────
describe('billing portal + subscription retrieve', () => {
  it('createPortalSession posts customer + return_url and returns the url', async () => {
    const { fn, calls } = mockFetch(json({ url: 'https://billing/portal' }));
    const out = await createPortalSession(ENV, 'cus_1', 'https://church.example/en/give', fn);
    expect(out).toEqual({ url: 'https://billing/portal' });
    expect(calls[0].url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(bodyEntries(calls[0])).toEqual({
      customer: 'cus_1',
      return_url: 'https://church.example/en/give',
    });
  });

  it('retrieveSubscription does a GET with no body', async () => {
    const { fn, calls } = mockFetch(json({ id: 'sub_1', status: 'active' }));
    const out = await retrieveSubscription(ENV, 'sub_1', fn);
    expect(out).toMatchObject({ id: 'sub_1', status: 'active' });
    expect(calls[0].url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.body).toBeUndefined();
    expect(headersOf(calls[0]).Authorization).toBe('Bearer sk_test_secret');
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
