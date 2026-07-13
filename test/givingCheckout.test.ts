// Pure checkout-form parsing (workers project — no Astro, no DB). parseAmountToCents
// turns a dollars string into integer cents and enforces the $1.00–$99,999.99
// band; parseFrequency whitelists the three cadences. These are the bits of the
// checkout endpoint that are worth unit-testing away from the request lifecycle.
import { describe, expect, it, vi } from 'vitest';
import giveFormSource from '../src/pages/[locale]/give.astro?raw';
import {
  parseAmountToCents,
  parseFrequency,
  signInitialGivingCheckoutProof,
  verifyGivingCheckoutProof,
} from '../src/lib/givingCheckout';
import * as givingCheckout from '../src/lib/givingCheckout';
import { createGivingCheckoutHandler } from '../src/pages/api/giving/checkout';
import { checkoutRequestIdForRender } from '../src/lib/stripeCheckoutRequests';
import { StripeError } from '../src/lib/stripe';

const REQUEST_ID = '00000000-0000-4000-8000-000000000902';
const SESSION_SECRET = 'test-session-secret-at-least-32-characters';

describe('signed giving Checkout browser proof', () => {
  it('signs initial UUID provenance and input-bound retry digests without embedding PII', async () => {
    const api = givingCheckout as unknown as {
      givingCheckoutRequestDigest?: (input: Record<string, unknown>) => Promise<string>;
      signInitialGivingCheckoutProof?: (secret: string, requestId: string) => Promise<string>;
      signRetryGivingCheckoutProof?: (secret: string, requestId: string, digest: string) => Promise<string>;
      verifyGivingCheckoutProof?: (
        secret: string,
        requestId: string,
        proof: string,
      ) => Promise<{ kind: 'initial' } | { kind: 'retry'; digest: string } | null>;
      selectGivingCheckoutIdentityForRender?: (
        secret: string,
        requestId: unknown,
        proof: unknown,
      ) => Promise<{ requestId: string; proof: string; reused: boolean }>;
    };
    expect(api.givingCheckoutRequestDigest).toBeTypeOf('function');
    expect(api.signInitialGivingCheckoutProof).toBeTypeOf('function');
    expect(api.signRetryGivingCheckoutProof).toBeTypeOf('function');
    expect(api.verifyGivingCheckoutProof).toBeTypeOf('function');
    expect(api.selectGivingCheckoutIdentityForRender).toBeTypeOf('function');
    if (!api.givingCheckoutRequestDigest || !api.signInitialGivingCheckoutProof
      || !api.signRetryGivingCheckoutProof || !api.verifyGivingCheckoutProof
      || !api.selectGivingCheckoutIdentityForRender) return;

    const digest = await api.givingCheckoutRequestDigest({
      fundId: 7,
      fundName: 'General',
      amountCents: 2500,
      currency: 'USD',
      frequency: 'once',
      locale: 'en',
      personId: null,
      donorName: ' Ada Lovelace ',
      donorEmail: 'ADA@example.com',
      customerId: null,
    });
    const initial = await api.signInitialGivingCheckoutProof(SESSION_SECRET, REQUEST_ID);
    const retry = await api.signRetryGivingCheckoutProof(SESSION_SECRET, REQUEST_ID, digest);
    expect(await api.verifyGivingCheckoutProof(SESSION_SECRET, REQUEST_ID, initial)).toEqual({ kind: 'initial' });
    expect(await api.verifyGivingCheckoutProof(SESSION_SECRET, REQUEST_ID, retry)).toEqual({ kind: 'retry', digest });
    expect(await api.verifyGivingCheckoutProof(SESSION_SECRET, REQUEST_ID, `${retry}x`)).toBeNull();
    expect(`${digest}.${initial}.${retry}`).not.toContain('Ada');
    expect(`${digest}.${initial}.${retry}`).not.toContain('example.com');

    expect(await api.selectGivingCheckoutIdentityForRender(SESSION_SECRET, REQUEST_ID, retry)).toEqual({
      requestId: REQUEST_ID,
      proof: retry,
      reused: true,
    });
    for (const [requestId, proof] of [[REQUEST_ID, 'attacker-proof'], [REQUEST_ID, null], ['not-a-uuid', retry]]) {
      const selected = await api.selectGivingCheckoutIdentityForRender(SESSION_SECRET, requestId, proof);
      expect(selected.requestId).not.toBe(REQUEST_ID);
      expect(selected.reused).toBe(false);
      expect(await api.verifyGivingCheckoutProof(SESSION_SECRET, selected.requestId, selected.proof)).toEqual({ kind: 'initial' });
    }
  });
});

describe('parseAmountToCents', () => {
  const ok: [string, number][] = [
    ['50', 5000],
    ['50.00', 5000],
    ['1', 100], // exactly the floor
    ['1.00', 100],
    ['0.99', -1], // below floor → rejected (sentinel replaced below)
    ['99999.99', 9_999_999], // exactly the ceiling
    ['  25  ', 2500], // trimmed
    ['12.5', 1250],
    ['12.34', 1234],
  ];
  for (const [input, expected] of ok) {
    if (expected < 0) continue;
    it(`"${input}" → ${expected}`, () => {
      expect(parseAmountToCents(input)).toBe(expected);
    });
  }

  const rejected = ['', '0', '0.99', '0.50', 'abc', '-5', '5.005', '1e3', '100000', '1000000', '.5', '50.', '  '];
  for (const input of rejected) {
    it(`rejects "${input}"`, () => {
      expect(parseAmountToCents(input)).toBeNull();
    });
  }
});

describe('parseFrequency', () => {
  it('accepts the three cadences', () => {
    expect(parseFrequency('once')).toBe('once');
    expect(parseFrequency('week')).toBe('week');
    expect(parseFrequency('month')).toBe('month');
  });
  it('rejects anything else (defaults handled by caller)', () => {
    expect(parseFrequency('year')).toBeNull();
    expect(parseFrequency('')).toBeNull();
    expect(parseFrequency(null)).toBeNull();
    expect(parseFrequency('ONCE')).toBeNull();
  });
});

describe('stable giving Checkout browser identity', () => {
  const form = (requestId = REQUEST_ID, proof = '') => {
    const data = new FormData();
    for (const [key, value] of Object.entries({
      locale: 'en', fund_id: '7', amount: '25.00', frequency: 'once',
      name: 'Ada Lovelace', email: 'ada@example.com', checkoutRequestId: requestId,
      checkoutRequestProof: proof,
    })) data.set(key, value);
    return data;
  };
  const signedForm = async (requestId = REQUEST_ID) => form(
    requestId,
    await signInitialGivingCheckoutProof(SESSION_SECRET, requestId),
  );
  const context = (data: FormData) => ({
    request: new Request('https://church.example/api/giving/checkout', { method: 'POST', body: data }),
    locals: { modules: new Set(['giving']), locale: 'en', user: null, db: {} },
  } as never);
  const deps = (overrides: Record<string, unknown> = {}) => ({
    sessionSecret: SESSION_SECRET,
    stripeEnv: { STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_route', APP_ORIGIN: 'https://church.example' },
    getFund: vi.fn(async () => ({ id: 7, name: 'General', active: 1 })),
    getSetting: vi.fn(async () => 'usd'),
    getStripeCustomer: vi.fn(async () => null),
    createOneTimeCheckout: vi.fn(async () => ({ id: 'cs_test_give', url: 'https://checkout.stripe.com/c/pay/cs_test_give' })),
    createRecurringCheckout: vi.fn(async () => ({ id: 'cs_test_give', url: 'https://checkout.stripe.com/c/pay/cs_test_give' })),
    ...overrides,
  });

  it('renders a server-signed checkout identity and accepts query values only after verification', () => {
    expect(giveFormSource).toContain('selectGivingCheckoutIdentityForRender');
    expect(giveFormSource).toContain("errParam === 'stripe' ? Astro.url.searchParams.get('checkoutRequestProof') : null");
    expect(giveFormSource).toMatch(/name="checkoutRequestId"\s+value=\{checkoutIdentity\.requestId\}/);
    expect(giveFormSource).toMatch(/name="checkoutRequestProof"\s+value=\{checkoutIdentity\.proof\}/);
  });

  it.each(['', 'not-a-uuid', '00000000-0000-1000-8000-000000000902']) (
    'rejects malformed request id %j before fund or Stripe work',
    async (requestId) => {
      const dependencies = deps();
      const response = await createGivingCheckoutHandler(dependencies as never)(context(form(requestId)));
      expect(response.headers.get('location')).toBe('/en/give?error=form');
      expect(dependencies.getFund).not.toHaveBeenCalled();
      expect(dependencies.createOneTimeCheckout).not.toHaveBeenCalled();
    },
  );

  it('passes the same giving request id on repeated browser submissions', async () => {
    const dependencies = deps();
    const handler = createGivingCheckoutHandler(dependencies as never);
    await handler(context(await signedForm()));
    await handler(context(await signedForm()));
    expect(dependencies.createOneTimeCheckout).toHaveBeenCalledTimes(2);
    for (const call of dependencies.createOneTimeCheckout.mock.calls as unknown as unknown[][]) {
      expect(call[2]).toMatchObject({ requestId: REQUEST_ID });
    }
  });

  it('returns a signed, input-bound retry identity only after an ambiguous Stripe failure', async () => {
    const dependencies = deps({
      createOneTimeCheckout: vi.fn(async () => {
        throw new StripeError('sk_test_secret https://checkout.stripe.com/sensitive', { stage: 'transport' });
      }),
    });
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await createGivingCheckoutHandler(dependencies as never)(context(await signedForm()));
    const location = response.headers.get('location')!;
    const query = new URL(location, 'https://church.example').searchParams;
    const queryId = query.get('checkoutRequestId');
    const queryProof = query.get('checkoutRequestProof')!;
    expect(query.get('error')).toBe('stripe');
    expect(checkoutRequestIdForRender(queryId)).toBe(REQUEST_ID);
    expect(await verifyGivingCheckoutProof(SESSION_SECRET, REQUEST_ID, queryProof)).toMatchObject({ kind: 'retry' });
    expect(location).not.toContain('Ada');
    expect(location).not.toContain('example.com');
    expect(logger).not.toHaveBeenCalled();
    logger.mockRestore();
  });

  it('reuses an ambiguous retry identity only when the normalized Checkout input is unchanged', async () => {
    const ambiguous = deps({
      createOneTimeCheckout: vi.fn(async () => {
        throw new StripeError('timeout', { stage: 'transport' });
      }),
    });
    const first = await createGivingCheckoutHandler(ambiguous as never)(context(await signedForm()));
    const query = new URL(first.headers.get('location')!, 'https://church.example').searchParams;
    const retryProof = query.get('checkoutRequestProof')!;

    const same = deps();
    await createGivingCheckoutHandler(same as never)(context(form(REQUEST_ID, retryProof)));
    expect(same.createOneTimeCheckout).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { requestId: REQUEST_ID },
    );

    const changedData = form(REQUEST_ID, retryProof);
    changedData.set('amount', '30.00');
    const changed = deps();
    await createGivingCheckoutHandler(changed as never)(context(changedData));
    const changedCalls = changed.createOneTimeCheckout.mock.calls as unknown as unknown[][];
    expect((changedCalls[0][2] as { requestId: string }).requestId).not.toBe(REQUEST_ID);
  });

  it('rotates an attacker-provided UUID when its browser proof is invalid', async () => {
    const dependencies = deps();
    await createGivingCheckoutHandler(dependencies as never)(context(form(REQUEST_ID, 'attacker-proof')));
    const calls = dependencies.createOneTimeCheckout.mock.calls as unknown as unknown[][];
    expect((calls[0][2] as { requestId: string }).requestId).not.toBe(REQUEST_ID);
  });

  it.each([
    new StripeError('configuration', { stage: 'configuration' }),
    new StripeError('card declined', { stage: 'response', status: 400, code: 'card_declined' }),
    new Error('unexpected implementation failure'),
  ])('does not expose a reusable identity after a definitive failure', async (failure) => {
    const dependencies = deps({
      createOneTimeCheckout: vi.fn(async () => { throw failure; }),
    });
    const response = await createGivingCheckoutHandler(dependencies as never)(context(await signedForm()));
    expect(response.headers.get('location')).toBe('/en/give?error=stripe');
  });

  it('never reflects an invalid query ID into the next rendered form identity', () => {
    const selected = checkoutRequestIdForRender('not-a-uuid<script>');
    expect(selected).not.toBe('not-a-uuid<script>');
    expect(selected).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
