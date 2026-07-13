import { describe, expect, it, vi } from 'vitest';
import registerFormSource from '../src/pages/[locale]/register/[id].astro?raw';
import {
  classifyRegistrationCheckoutFailure,
  createRegistrationSubmitHandler,
} from '../src/pages/api/register/submit';
import { StripeError } from '../src/lib/stripe';
import {
  checkoutRequestIdForRender,
  newCheckoutRequestId,
  parseCheckoutRequestId,
  registrationCheckoutRenderPolicy,
} from '../src/lib/stripeCheckoutRequests';

const REQUEST_ID = '00000000-0000-4000-8000-000000000901';
const WAITING_LOCATION = `/en/register/7?error=waiting&checkoutRequestId=${REQUEST_ID}`;
const savedJson = {
  mode: 'payment' as const,
  line_items: [{ quantity: 1 as const, price_data: { currency: 'usd', unit_amount: 2500, product_data: { name: 'Retreat' } } }],
  success_url: 'http://localhost:4321/en/register/done?ok=1&paid=1',
  cancel_url: `http://localhost:4321/en/register/7?error=waiting&checkoutRequestId=${REQUEST_ID}`,
  customer_email: 'ada@example.com',
  metadata: { kind: 'registration' as const, registration_id: '41', request_id: REQUEST_ID },
  payment_intent_data: { metadata: { kind: 'registration' as const, registration_id: '41', request_id: REQUEST_ID } },
};

const event = (priceCents: number | null) => ({
  id: 7,
  title: 'Retreat',
  price_cents: priceCents,
  currency: 'usd',
});

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    locale: 'en',
    event_id: '7',
    website: '',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    checkoutRequestId: REQUEST_ID,
    ...overrides,
  })) data.set(key, value);
  return data;
}

function context(data: FormData) {
  return {
    request: new Request('https://church.example/api/register/submit', { method: 'POST', body: data }),
    locals: { modules: new Set(['registration']), locale: 'en', user: null, db: {} },
  } as never;
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    stripeEnv: { STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_route', APP_ORIGIN: 'http://localhost:4321' },
    getOpenEvent: vi.fn(async () => event(2500)),
    listQuestions: vi.fn(async () => []),
    validateAnswers: vi.fn(() => []),
    createRegistration: vi.fn(async () => 41),
    resolveRequest: vi.fn(async () => ({ kind: 'create', registrationId: 41, requestId: REQUEST_ID, requestJson: savedJson })),
    continueRequest: vi.fn(async () => ({ kind: 'create', registrationId: 41, requestId: REQUEST_ID, requestJson: savedJson })),
    createCheckout: vi.fn(async () => ({
      id: 'cs_test_route',
      url: 'https://checkout.stripe.com/c/pay/cs_test_route',
      livemode: false as const,
      status: 'open' as const,
      payment_status: 'unpaid' as const,
      payment_intent: null,
      amount_total: 2500,
      currency: 'usd',
      metadata: savedJson.metadata,
    })),
    attachRequest: vi.fn(async () => true),
    cancelRequest: vi.fn(async () => true),
    ...overrides,
  };
}

describe('stable registration Checkout browser identity', () => {
  it('keeps a full paid registration form available only for a valid waiting request identity', () => {
    expect(registrationCheckoutRenderPolicy({
      paid: true,
      capacity: 1,
      takenCount: 1,
      error: 'waiting',
      checkoutRequestId: REQUEST_ID,
      ownsWaitingSeat: true,
    })).toEqual({ checkoutRequestId: REQUEST_ID, isFull: false, reused: true });

    for (const input of [
      { paid: true, capacity: 1, takenCount: 1, error: null, checkoutRequestId: null, ownsWaitingSeat: false },
      { paid: true, capacity: 1, takenCount: 1, error: 'waiting', checkoutRequestId: null, ownsWaitingSeat: false },
      { paid: true, capacity: 1, takenCount: 1, error: 'waiting', checkoutRequestId: 'not-a-uuid', ownsWaitingSeat: false },
      { paid: true, capacity: 1, takenCount: 1, error: 'invalid', checkoutRequestId: REQUEST_ID, ownsWaitingSeat: true },
      { paid: true, capacity: 1, takenCount: 1, error: 'waiting', checkoutRequestId: REQUEST_ID, ownsWaitingSeat: false },
    ]) {
      const policy = registrationCheckoutRenderPolicy(input);
      expect(policy.isFull).toBe(true);
      expect(policy.reused).toBe(false);
      expect(parseCheckoutRequestId(policy.checkoutRequestId)).toBe(policy.checkoutRequestId);
      expect(policy.checkoutRequestId).not.toBe(REQUEST_ID);
    }

    expect(registrationCheckoutRenderPolicy({
      paid: false,
      capacity: 1,
      takenCount: 1,
      error: 'waiting',
      checkoutRequestId: REQUEST_ID,
      ownsWaitingSeat: true,
    })).toEqual({ checkoutRequestId: REQUEST_ID, isFull: false, reused: true });
  });

  it('renders a server-generated UUID in the checkoutRequestId hidden field', () => {
    expect(registerFormSource).toContain('registrationCheckoutRenderPolicy({');
    expect(registerFormSource).toContain('ownsRecoverableRegistrationCheckoutRequest(');
    expect(registerFormSource).toContain(
      "const requestedCheckoutId = errParam === 'waiting' ? Astro.url.searchParams.get('checkoutRequestId') : null",
    );
    expect(registerFormSource).toMatch(
      /isCheckoutRequestId\(requestedCheckoutId\)[\s\S]*await ownsRecoverableRegistrationCheckoutRequest/,
    );
    expect(registerFormSource).toMatch(/name="checkoutRequestId"\s+value=\{checkoutRequestId\}/);
    expect(registerFormSource).toMatch(/name="action"\s+value="continue"/);
    expect(registerFormSource).toContain('!event && ownsWaitingSeat');
    const generated = newCheckoutRequestId();
    expect(parseCheckoutRequestId(generated)).toBe(generated);
  });

  it.each([undefined, '', 'not-a-uuid', '00000000-0000-1000-8000-000000000901']) (
    'rejects paid request id %j before creating or resolving a registration',
    async (checkoutRequestId) => {
      const dependencies = deps();
      const data = form();
      if (checkoutRequestId === undefined) data.delete('checkoutRequestId');
      else data.set('checkoutRequestId', checkoutRequestId);
      const response = await createRegistrationSubmitHandler(dependencies as never)(context(data));
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/en/register/7?error=invalid');
      expect(dependencies.createRegistration).not.toHaveBeenCalled();
      expect(dependencies.resolveRequest).not.toHaveBeenCalled();
    },
  );

  it('keeps free registration on the existing confirmed flow without requiring a request id', async () => {
    const dependencies = deps({ getOpenEvent: vi.fn(async () => event(0)) });
    const data = form();
    data.delete('checkoutRequestId');
    const response = await createRegistrationSubmitHandler(dependencies as never)(context(data));
    expect(response.headers.get('location')).toBe('/en/register/done?ok=1');
    expect(dependencies.createRegistration).toHaveBeenCalledWith({}, expect.objectContaining({ status: 'confirmed' }));
    expect(dependencies.resolveRequest).not.toHaveBeenCalled();
  });

  it('reuses the saved canonical JSON and exact namespaced key on browser retries', async () => {
    const dependencies = deps();
    const handler = createRegistrationSubmitHandler(dependencies as never);
    const first = await handler(context(form()));
    const second = await handler(context(form()));
    expect(first.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_route');
    expect(second.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_route');
    expect(dependencies.createCheckout).toHaveBeenCalledTimes(2);
    for (const call of dependencies.createCheckout.mock.calls as unknown as unknown[][]) {
      expect(JSON.stringify(call[1])).toBe(JSON.stringify(savedJson));
      expect(call[2]).toMatchObject({ requestId: REQUEST_ID });
    }
    expect(dependencies.resolveRequest).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ appOrigin: 'http://localhost:4321' }),
    );
    expect(savedJson).not.toHaveProperty('expires_at');
  });

  it('continues an anonymous required-answer checkout from exact durable server state without browser PII', async () => {
    const dependencies = deps({
      listQuestions: vi.fn(async () => { throw new Error('must not reconstruct answers'); }),
      validateAnswers: vi.fn(() => { throw new Error('must not validate browser answers'); }),
    });
    const data = new FormData();
    for (const [key, value] of Object.entries({
      locale: 'en', event_id: '7', website: '', action: 'continue', checkoutRequestId: REQUEST_ID,
    })) data.set(key, value);

    const response = await createRegistrationSubmitHandler(dependencies as never)(context(data));
    expect(response.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_route');
    expect(dependencies.continueRequest).toHaveBeenCalledWith({}, REQUEST_ID, 7);
    expect(dependencies.resolveRequest).not.toHaveBeenCalled();
    expect(dependencies.listQuestions).not.toHaveBeenCalled();
    expect(dependencies.validateAnswers).not.toHaveBeenCalled();
  });

  it('continues durable checkout state even when the event is no longer open or currently paid', async () => {
    const dependencies = deps({
      getOpenEvent: vi.fn(async () => null),
    });
    const data = new FormData();
    for (const [key, value] of Object.entries({
      locale: 'en', event_id: '7', action: 'continue', checkoutRequestId: REQUEST_ID,
    })) data.set(key, value);

    const response = await createRegistrationSubmitHandler(dependencies as never)(context(data));
    expect(response.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_route');
    expect(dependencies.continueRequest).toHaveBeenCalledWith({}, REQUEST_ID, 7);
    expect(dependencies.getOpenEvent).not.toHaveBeenCalled();
  });

  it('returns persisted done/redirect/wait/review outcomes without a new Stripe call', async () => {
    const cases = [
      [{ kind: 'done', registrationId: 41 }, '/en/register/done?ok=1&paid=1'],
      [{ kind: 'redirect', registrationId: 41, checkoutUrl: 'https://checkout.stripe.com/c/pay/saved' }, 'https://checkout.stripe.com/c/pay/saved'],
      [{ kind: 'waiting', registrationId: 41 }, WAITING_LOCATION],
      [{ kind: 'review', registrationId: 41, reason: 'manual_review' }, WAITING_LOCATION],
    ] as const;
    for (const [resolution, location] of cases) {
      const dependencies = deps({ resolveRequest: vi.fn(async () => resolution) });
      const response = await createRegistrationSubmitHandler(dependencies as never)(context(form()));
      expect(response.headers.get('location')).toBe(location);
      expect(dependencies.createCheckout).not.toHaveBeenCalled();
    }
  });

  it('classifies only preflight/configuration and definitive Stripe 4xx as compensating cancellation', () => {
    expect(classifyRegistrationCheckoutFailure(new StripeError('config', { stage: 'configuration' }))).toBe('cancel');
    expect(classifyRegistrationCheckoutFailure(new StripeError('bad', { stage: 'response', status: 400 }))).toBe('cancel');
    for (const status of [408, 409, 424, 429, 500]) {
      expect(classifyRegistrationCheckoutFailure(new StripeError('ambiguous', { stage: 'response', status }))).toBe('recover');
    }
    expect(classifyRegistrationCheckoutFailure(new StripeError('network', { stage: 'transport' }))).toBe('recover');
    expect(classifyRegistrationCheckoutFailure(new StripeError('malformed', { stage: 'response', code: 'stripe_response_invalid' }))).toBe('recover');
  });

  it('does not log Stripe errors or saved request data and does not cancel ambiguous failures', async () => {
    const error = new StripeError('transport marker saved-json-marker', { stage: 'transport' });
    const dependencies = deps({ createCheckout: vi.fn(async () => { throw error; }) });
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await createRegistrationSubmitHandler(dependencies as never)(context(form()));
    const location = response.headers.get('location')!;
    expect(location).toBe(WAITING_LOCATION);
    expect(checkoutRequestIdForRender(new URL(location, 'https://church.example').searchParams.get('checkoutRequestId')))
      .toBe(REQUEST_ID);
    expect(dependencies.cancelRequest).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalled();
    logger.mockRestore();
  });

  it.each([
    new StripeError('preflight', { stage: 'configuration', code: 'stripe_test_key_required' }),
    new StripeError('declined', { stage: 'response', status: 400, code: 'parameter_invalid' }),
  ])('cancels and clears the pending pair after a definitive failure', async (error) => {
    const dependencies = deps({ createCheckout: vi.fn(async () => { throw error; }) });
    const response = await createRegistrationSubmitHandler(dependencies as never)(context(form()));
    expect(response.headers.get('location')).toBe('/en/register/7?error=invalid');
    expect(dependencies.cancelRequest).toHaveBeenCalledWith({}, REQUEST_ID, 41);
  });

  it('leaves the pair recoverable when guarded attachment fails after Stripe responds', async () => {
    const dependencies = deps({ attachRequest: vi.fn(async () => { throw new Error('database unavailable'); }) });
    const response = await createRegistrationSubmitHandler(dependencies as never)(context(form()));
    expect(response.headers.get('location')).toBe(WAITING_LOCATION);
    expect(dependencies.cancelRequest).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'done', registrationId: 41 }, '/en/register/done?ok=1&paid=1'],
    [{ kind: 'redirect', registrationId: 41, checkoutUrl: 'https://checkout.stripe.com/c/pay/race-winner' }, 'https://checkout.stripe.com/c/pay/race-winner'],
  ] as const)('converges an attach-false race before deciding to wait', async (continued, expected) => {
    const dependencies = deps({
      attachRequest: vi.fn(async () => false),
      continueRequest: vi.fn(async () => continued),
    });
    const response = await createRegistrationSubmitHandler(dependencies as never)(context(form()));
    expect(response.headers.get('location')).toBe(expected);
    expect(dependencies.continueRequest).toHaveBeenCalledWith({}, REQUEST_ID, 7);
  });

  it('returns waiting when a definitive Stripe failure cannot be durably compensated', async () => {
    const dependencies = deps({
      createCheckout: vi.fn(async () => {
        throw new StripeError('bad request', { stage: 'response', status: 400 });
      }),
      cancelRequest: vi.fn(async () => false),
    });
    const response = await createRegistrationSubmitHandler(dependencies as never)(context(form()));
    expect(response.headers.get('location')).toBe(WAITING_LOCATION);
  });

  it('preserves the submitted UUID through resolver errors and attach-false redirects', async () => {
    for (const dependencies of [
      deps({ resolveRequest: vi.fn(async () => { throw new Error('database unavailable'); }) }),
      deps({ attachRequest: vi.fn(async () => false) }),
    ]) {
      const response = await createRegistrationSubmitHandler(dependencies as never)(context(form()));
      const location = response.headers.get('location')!;
      expect(location).toBe(WAITING_LOCATION);
      const queryId = new URL(location, 'https://church.example').searchParams.get('checkoutRequestId');
      expect(checkoutRequestIdForRender(queryId)).toBe(REQUEST_ID);
    }
  });

  it('never preserves a stale UUID after conflict, expiry, or successful definitive cancellation', async () => {
    for (const dependencies of [
      deps({ resolveRequest: vi.fn(async () => ({ kind: 'conflict' })) }),
      deps({ resolveRequest: vi.fn(async () => ({ kind: 'expired' })) }),
      deps({ createCheckout: vi.fn(async () => { throw new StripeError('bad', { stage: 'response', status: 400 }); }) }),
    ]) {
      const response = await createRegistrationSubmitHandler(dependencies as never)(context(form()));
      const location = response.headers.get('location')!;
      expect(location).toBe('/en/register/7?error=invalid');
      expect(new URL(location, 'https://church.example').searchParams.has('checkoutRequestId')).toBe(false);
    }
  });
});
