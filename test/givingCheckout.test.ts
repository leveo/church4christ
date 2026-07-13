// Pure checkout-form parsing (workers project — no Astro, no DB). parseAmountToCents
// turns a dollars string into integer cents and enforces the $1.00–$99,999.99
// band; parseFrequency whitelists the three cadences. These are the bits of the
// checkout endpoint that are worth unit-testing away from the request lifecycle.
import { describe, expect, it, vi } from 'vitest';
import giveFormSource from '../src/pages/[locale]/give.astro?raw';
import { parseAmountToCents, parseFrequency } from '../src/lib/givingCheckout';
import { createGivingCheckoutHandler } from '../src/pages/api/giving/checkout';

const REQUEST_ID = '00000000-0000-4000-8000-000000000902';

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
  const form = (requestId = REQUEST_ID) => {
    const data = new FormData();
    for (const [key, value] of Object.entries({
      locale: 'en', fund_id: '7', amount: '25.00', frequency: 'once',
      name: 'Ada Lovelace', email: 'ada@example.com', checkoutRequestId: requestId,
    })) data.set(key, value);
    return data;
  };
  const context = (data: FormData) => ({
    request: new Request('https://church.example/api/giving/checkout', { method: 'POST', body: data }),
    locals: { modules: new Set(['giving']), locale: 'en', user: null, db: {} },
  } as never);
  const deps = (overrides: Record<string, unknown> = {}) => ({
    stripeEnv: { STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_route', APP_ORIGIN: 'https://church.example' },
    getFund: vi.fn(async () => ({ id: 7, name: 'General', active: 1 })),
    getSetting: vi.fn(async () => 'usd'),
    getStripeCustomer: vi.fn(async () => null),
    createOneTimeCheckout: vi.fn(async () => ({ id: 'cs_test_give', url: 'https://checkout.stripe.com/c/pay/cs_test_give' })),
    createRecurringCheckout: vi.fn(async () => ({ id: 'cs_test_give', url: 'https://checkout.stripe.com/c/pay/cs_test_give' })),
    ...overrides,
  });

  it('renders a server-generated checkoutRequestId hidden field', () => {
    expect(giveFormSource).toContain('const checkoutRequestId = newCheckoutRequestId()');
    expect(giveFormSource).toMatch(/name="checkoutRequestId"\s+value=\{checkoutRequestId\}/);
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
    await handler(context(form()));
    await handler(context(form()));
    expect(dependencies.createOneTimeCheckout).toHaveBeenCalledTimes(2);
    for (const call of dependencies.createOneTimeCheckout.mock.calls as unknown as unknown[][]) {
      expect(call[2]).toMatchObject({ requestId: REQUEST_ID });
    }
  });

  it('does not log Stripe errors, secrets, request data, or Checkout URLs', async () => {
    const dependencies = deps({
      createOneTimeCheckout: vi.fn(async () => { throw new Error('sk_test_secret https://checkout.stripe.com/sensitive'); }),
    });
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await createGivingCheckoutHandler(dependencies as never)(context(form()));
    expect(response.headers.get('location')).toBe('/en/give?error=stripe');
    expect(logger).not.toHaveBeenCalled();
    logger.mockRestore();
  });
});
