import { describe, expect, it, vi } from 'vitest';
import registerFormSource from '../src/pages/[locale]/register/[id].astro?raw';
import {
  classifyRegistrationCheckoutFailure,
  createRegistrationSubmitHandler,
} from '../src/pages/api/register/submit';
import { StripeError } from '../src/lib/stripe';
import { validateSubmission } from '../src/lib/regManage';
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

function context(
  data: FormData,
  user: null | { id: number; displayName: string; email: string } = {
    id: 9,
    displayName: String(data.get('name') ?? 'Ada Lovelace'),
    email: String(data.get('email') ?? 'ada@example.com'),
  },
  extraLocals: Record<string, unknown> = {},
) {
  return {
    request: new Request('https://church.example/api/register/submit', { method: 'POST', body: data }),
    locals: { modules: new Set(['registration']), locale: 'en', user, rawDb: {}, campusMode: 'single', db: {}, ...extraLocals },
  } as never;
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    stripeEnv: { STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_route', APP_ORIGIN: 'http://localhost:4321' },
    getOpenEvent: vi.fn(async () => event(2500)),
    listQuestions: vi.fn(async () => []),
    listTicketTypes: vi.fn(async () => []),
    validateSubmission: vi.fn(validateSubmission),
    // The household check needs a database; the fake keeps the contact's own link and drops nothing else.
    restrictAttendeePersons: vi.fn(async (_db: unknown, contactPersonId: number | null, attendees: Array<{ name: string; personId: number | null }>) =>
      attendees.map((a, i) => ({ ...a, personId: i === 0 ? contactPersonId : a.personId }))),
    createRegistration: vi.fn(async () => ({ id: 41, status: 'confirmed' as const, confirmationNo: 'R26-0001' })),
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
    attachIdentitySource: vi.fn(async () => ({})),
    attachExistingIdentitySource: vi.fn(async () => ({})),
    getSessionEpoch: vi.fn(async () => 0),
    ...overrides,
  };
}

describe('stable registration Checkout browser identity', () => {
  it.each([
    ['free', form()],
    ['paid', form()],
    ['continue', form({ action: 'continue' })],
  ])('rejects an anonymous direct %s POST before any business or Stripe work', async (kind, data) => {
    const dependencies = deps({
      getOpenEvent: vi.fn(async () => event(kind === 'free' ? 0 : 2500)),
    });
    const response = await createRegistrationSubmitHandler(dependencies as never)(context(data, null));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/en/signin?next=%2Fen%2Fregister%2F7');
    expect(dependencies.getOpenEvent).not.toHaveBeenCalled();
    expect(dependencies.createRegistration).not.toHaveBeenCalled();
    expect(dependencies.resolveRequest).not.toHaveBeenCalled();
    expect(dependencies.continueRequest).not.toHaveBeenCalled();
    expect(dependencies.createCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ['free', form(), 0, 'attachIdentitySource'],
    ['paid', form(), 2500, 'attachIdentitySource'],
    ['continue', form({ action: 'continue', identitySource: '0' }), 2500, 'attachExistingIdentitySource'],
  ] as const)('always attaches signed-in %s registration before its business sink', async (_kind, data, price, attachment) => {
    const dependencies = deps({ getOpenEvent: vi.fn(async () => event(price)) });
    await createRegistrationSubmitHandler(dependencies as never)(context(data));
    expect(dependencies[attachment]).toHaveBeenCalledOnce();
    const sink = attachment === 'attachExistingIdentitySource'
      ? dependencies.continueRequest
      : price === 0 ? dependencies.createRegistration : dependencies.resolveRequest;
    expect(dependencies[attachment].mock.invocationCallOrder[0]).toBeLessThan(sink.mock.invocationCallOrder[0]);
  });

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

  it('requires the server-rendered idempotent source key before free registration', async () => {
    const dependencies = deps({ getOpenEvent: vi.fn(async () => event(0)) });
    const data = form();
    data.delete('checkoutRequestId');
    const response = await createRegistrationSubmitHandler(dependencies as never)(context(data));
    expect(response.headers.get('location')).toBe('/en/register/7?error=invalid');
    expect(dependencies.createRegistration).not.toHaveBeenCalled();
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
    expect(dependencies.validateSubmission).not.toHaveBeenCalled();
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

describe('registration submit: D1 paid refusal, waitlist, submission key', () => {
  const user = { id: 9, displayName: 'Ada Lovelace', email: 'ada@example.com' };
  const run = (dependencies: ReturnType<typeof deps>, data: FormData, locals: Record<string, unknown> = {}) =>
    createRegistrationSubmitHandler(dependencies as never)(context(data, user, locals));

  it('refuses a priced event on D1 before any identity, registration or Stripe work', async () => {
    const dependencies = deps({ getOpenEvent: vi.fn(async () => event(2500)) });
    const response = await run(dependencies, form(), { dbBackend: 'd1' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/en/register/7?error=paid_unavailable');
    for (const name of ['attachIdentitySource', 'createRegistration', 'resolveRequest', 'createCheckout'] as const) {
      expect(dependencies[name]).not.toHaveBeenCalled();
    }
  });

  it('still takes a free event on D1 and keeps the paid flow on Postgres', async () => {
    const free = deps({ getOpenEvent: vi.fn(async () => event(0)) });
    // No manage token in this fake result = a replayed submission, which lands on the member's own page.
    expect((await run(free, form(), { dbBackend: 'd1' })).headers.get('location')).toBe('/en/my/events/41?new=1');
    expect(free.createRegistration).toHaveBeenCalledOnce();

    const paid = deps({ getOpenEvent: vi.fn(async () => event(2500)) });
    const response = await run(paid, form(), { dbBackend: 'supabase' });
    expect(paid.resolveRequest).toHaveBeenCalledOnce();
    expect(response.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_route');
  });

  it('sends a free registration (confirmed or waitlisted) to its manage page with the token in the fragment only', async () => {
    const token = 'W'.repeat(43);
    for (const status of ['confirmed', 'waitlist'] as const) {
      const dependencies = deps({
        getOpenEvent: vi.fn(async () => event(0)),
        createRegistration: vi.fn(async () => ({ id: 42, status, confirmationNo: 'R26-0002', manageToken: token })),
        sendConfirmation: vi.fn(async () => true),
      });
      const response = await run(dependencies, form(), { dbBackend: 'd1' });
      expect(response.status).toBe(303);
      const location = response.headers.get('location')!;
      expect(location).toBe(`/en/register/manage?new=1#t=${token}`);
      expect(new URL(location, 'https://church.example').search).toBe('?new=1');
    }
  });

  it('sends a replayed submission (no token) to the member’s own registration page', async () => {
    const dependencies = deps({
      getOpenEvent: vi.fn(async () => event(0)),
      createRegistration: vi.fn(async () => ({ id: 43, status: 'confirmed' as const, confirmationNo: 'R26-0003', manageToken: null })),
    });
    const response = await run(dependencies, form(), { dbBackend: 'd1' });
    expect(response.headers.get('location')).toBe('/en/my/events/43?new=1');
  });

  it('maps event_full to the full error', async () => {
    const dependencies = deps({
      getOpenEvent: vi.fn(async () => event(0)),
      createRegistration: vi.fn(async () => { throw new Error('event_full'); }),
    });
    expect((await run(dependencies, form())).headers.get('location')).toBe('/en/register/7?error=full');
  });

  it('passes a server-derived submission key and allows the waitlist for a free event', async () => {
    const dependencies = deps({ getOpenEvent: vi.fn(async () => event(0)) });
    await run(dependencies, form());
    expect(dependencies.createRegistration).toHaveBeenCalledWith({}, expect.objectContaining({
      eventId: 7, status: 'confirmed', amountCents: 0, allowWaitlist: true, submissionKey: `form:${REQUEST_ID}`,
    }));
  });

  it.each(['abcdefghij123456', 'A_b-C_d-E_f-G_h-I_j-K_l-M_n-O_p-Q_r-S_t-U_v-W_x-Y_z-0123456789ab'.slice(0, 64), 'x'.repeat(16)])(
    'accepts a well-formed client submission_key (%s)',
    async (clientKey) => {
      const dependencies = deps({ getOpenEvent: vi.fn(async () => event(0)) });
      await run(dependencies, form({ submission_key: clientKey }));
      expect(dependencies.createRegistration).toHaveBeenCalledWith({}, expect.objectContaining({ submissionKey: clientKey }));
    },
  );

  it.each([
    ['too short', 'abc123'],
    ['too long', 'k'.repeat(65)],
    ['a colon (the server namespace)', 'srv:abcdefghijklmnop'],
    ['a space', 'abcdefgh ijklmnop'],
    ['a slash', 'abcdefgh/ijklmnop'],
    ['empty', ''],
  ])('ignores a malformed client submission_key (%s) and falls back to the derived one', async (_label, clientKey) => {
    const dependencies = deps({ getOpenEvent: vi.fn(async () => event(0)) });
    await run(dependencies, form({ submission_key: clientKey }));
    expect(dependencies.createRegistration).toHaveBeenCalledWith({}, expect.objectContaining({ submissionKey: `form:${REQUEST_ID}` }));
  });
});

describe('registration submit: confirmation email', () => {
  const freeDeps = (created: Record<string, unknown>) => {
    const sendConfirmation = vi.fn(async () => true);
    return {
      ...deps({
        getOpenEvent: vi.fn(async () => event(0)),
        createRegistration: vi.fn(async () => created),
        sendConfirmation,
      }),
      sendConfirmation,
    };
  };

  it('mails the confirmation with the creation-time manage token and the form language', async () => {
    const dependencies = freeDeps({ id: 41, status: 'confirmed', confirmationNo: 'R26-0001', manageToken: 'T'.repeat(43) });
    const response = await createRegistrationSubmitHandler(dependencies as never)(context(form({ locale: 'zh' })));
    expect(response.status).toBe(303);
    expect(dependencies.createRegistration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locale: 'zh' }));
    expect(dependencies.sendConfirmation).toHaveBeenCalledOnce();
    expect(dependencies.sendConfirmation).toHaveBeenCalledWith(expect.anything(), expect.anything(), 41, { manageToken: 'T'.repeat(43) });
  });

  it('does not mail a replayed submission (no token), and mails a waitlisted one', async () => {
    const replay = freeDeps({ id: 41, status: 'confirmed', confirmationNo: 'R26-0001', manageToken: null });
    await createRegistrationSubmitHandler(replay as never)(context(form()));
    expect(replay.sendConfirmation).not.toHaveBeenCalled();

    const waitlisted = freeDeps({ id: 42, status: 'waitlist', confirmationNo: 'R26-0002', manageToken: 'U'.repeat(43) });
    const response = await createRegistrationSubmitHandler(waitlisted as never)(context(form()));
    expect(response.headers.get('location')).toBe(`/en/register/manage?new=1#t=${'U'.repeat(43)}`);
    expect(waitlisted.sendConfirmation).toHaveBeenCalledOnce();
  });
});

describe('registration submit: a party, validation and household links', () => {
  const user = { id: 9, displayName: 'Ada Lovelace', email: 'ada@example.com' };
  const partyEvent = (priceCents: number | null) => ({ ...event(priceCents), max_party_size: 4 });
  const run = (dependencies: ReturnType<typeof deps>, data: FormData, locals: Record<string, unknown> = {}) =>
    createRegistrationSubmitHandler(dependencies as never)(context(data, user, locals));
  const sink = () => vi.fn(async () => true);

  it('writes the whole party and the phone, then lands on the manage page', async () => {
    const dependencies = deps({
      getOpenEvent: vi.fn(async () => partyEvent(0)),
      createRegistration: vi.fn(async () => ({ id: 50, status: 'confirmed' as const, confirmationNo: 'R26-0050', manageToken: 'M'.repeat(43) })),
      sendConfirmation: sink(),
    });
    const response = await run(
      dependencies,
      form({ phone: '+1 555 0100', person_name_1: 'Byron Lovelace', person_id_1: '12', person_name_2: '', person_name_3: 'Anne Isabella' }),
    );
    expect(response.headers.get('location')).toBe(`/en/register/manage?new=1#t=${'M'.repeat(43)}`);
    expect(dependencies.restrictAttendeePersons).toHaveBeenCalledWith(expect.anything(), 9, [
      { name: 'Ada Lovelace', personId: null, ticketTypeId: null, answers: [] },
      { name: 'Byron Lovelace', personId: 12, ticketTypeId: null, answers: [] },
      { name: 'Anne Isabella', personId: null, ticketTypeId: null, answers: [] },
    ]);
    expect(dependencies.createRegistration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      personId: 9,
      phone: '+1 555 0100',
      attendees: [
        { name: 'Ada Lovelace', personId: 9 },
        { name: 'Byron Lovelace', personId: 12 },
        { name: 'Anne Isabella', personId: null },
      ],
    }));
  });

  it('uses what restrictAttendeePersons returns, so a forged household link is dropped', async () => {
    const dependencies = deps({
      getOpenEvent: vi.fn(async () => partyEvent(0)),
      restrictAttendeePersons: vi.fn(async (_db: unknown, _id: number, attendees: Array<{ name: string }>) =>
        attendees.map((a) => ({ name: a.name, personId: null }))),
      sendConfirmation: sink(),
    });
    await run(dependencies, form({ person_name_1: 'Stranger', person_id_1: '999' }));
    const written = (dependencies.createRegistration.mock.calls as unknown as Array<[unknown, { attendees: Array<{ personId: number | null }> }]>)[0][1];
    expect(written.attendees.every((a) => a.personId === null)).toBe(true);
  });

  it('sends a failed validation back to the form with the same body (307) and writes nothing', async () => {
    const dependencies = deps({ getOpenEvent: vi.fn(async () => partyEvent(0)) });
    const response = await run(dependencies, form({ phone: 'call me', person_name_1: 'x'.repeat(121) }));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/en/register/7');
    expect(response.headers.get('location')).not.toContain('?');
    for (const name of ['attachIdentitySource', 'createRegistration', 'resolveRequest'] as const) {
      expect(dependencies[name]).not.toHaveBeenCalled();
    }
  });

  it('refuses more people than the event allows', async () => {
    const dependencies = deps({ getOpenEvent: vi.fn(async () => ({ ...event(0), max_party_size: 2 })) });
    // The form only reads rows up to max_party_size, so a larger party cannot even be posted: row 3 is ignored.
    await run(dependencies, form({ person_name_1: 'Byron', person_name_2: 'Anne' }));
    const written = (dependencies.createRegistration.mock.calls as unknown as Array<[unknown, { attendees: unknown[] }]>)[0][1];
    expect(written.attendees).toHaveLength(2);
  });

  it('charges the per-person price for the party: the request carries the people, the checkout multiplies', async () => {
    const dependencies = deps({ getOpenEvent: vi.fn(async () => partyEvent(2500)) });
    await run(dependencies, form({ person_name_1: 'Byron Lovelace', phone: '555 0100' }), { dbBackend: 'supabase' });
    expect(dependencies.resolveRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      amountCents: 2500,
      party: {
        phone: '555 0100',
        attendees: [
          { name: 'Ada Lovelace', personId: 9 },
          { name: 'Byron Lovelace', personId: null },
        ],
      },
    }));
  });

  it('an old single-person form still registers one person', async () => {
    const dependencies = deps({ getOpenEvent: vi.fn(async () => event(0)), sendConfirmation: sink() });
    await run(dependencies, form());
    expect(dependencies.createRegistration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      attendees: [{ name: 'Ada Lovelace', personId: 9 }],
    }));
  });
});

describe('registration submit: ticket types, per-person questions and terms', () => {
  const user = { id: 9, displayName: 'Ada Lovelace', email: 'ada@example.com' };
  const base = { sort: 0, required: 0, options: null, label: '', condition: null, max_length: null, help: null, placeholder: null, option_labels: {} };
  const questions = [
    { ...base, id: 1, type: 'yesno', scope: 'registration', label: 'Need childcare?' },
    { ...base, id: 2, type: 'select', scope: 'attendee', options: ['vegan', 'plain'], required: 1, label: 'Meal' },
    { ...base, id: 3, type: 'text', scope: 'attendee', condition: { q: 2, op: 'eq', value: 'vegan' }, label: 'Notes' },
    { ...base, id: 4, type: 'terms', scope: 'registration', required: 1, label: 'Photo release' },
  ];
  const ticketTypes = [
    { id: 7, sort: 0, price_cents: 0, capacity: null, active: 1, label: 'Adult', description: null, taken: 0, seats_left: null },
    { id: 8, sort: 1, price_cents: 0, capacity: 1, active: 1, label: 'Child', description: null, taken: 0, seats_left: 1 },
  ];
  const typedDeps = () => deps({
    getOpenEvent: vi.fn(async () => ({ ...event(null), max_party_size: 3 })),
    listQuestions: vi.fn(async () => questions),
    listTicketTypes: vi.fn(async () => ticketTypes),
    createRegistration: vi.fn(async () => ({ id: 60, status: 'confirmed' as const, confirmationNo: 'R26-0060', manageToken: 'M'.repeat(43) })),
    sendConfirmation: vi.fn(async () => true),
  });
  const run = (dependencies: ReturnType<typeof deps>, data: FormData) =>
    createRegistrationSubmitHandler(dependencies as never)(context(data, user));
  const good = { ticket_0: '7', pq_0_2: 'vegan', pq_0_3: 'no nuts', '4': 'on' };

  it('writes each person\'s ticket type and answers, drops a hidden answer, and stores terms as plain acceptance', async () => {
    const dependencies = typedDeps();
    const response = await run(dependencies, form({ ...good, person_name_1: 'Mia', ticket_1: '8', pq_1_2: 'plain', pq_1_3: 'hidden by Meal = plain', '1': 'yes' }));
    expect(response.status).toBe(303);
    const written = (dependencies.createRegistration.mock.calls as unknown as Array<[unknown, { attendees: unknown[]; answers: Array<[number, string]> }]>)[0][1];
    expect(written.attendees).toEqual([
      { name: 'Ada Lovelace', personId: 9, ticketTypeId: 7, answers: [[2, 'vegan'], [3, 'no nuts']] },
      { name: 'Mia', personId: null, ticketTypeId: 8, answers: [[2, 'plain']] },
    ]);
    expect(written.answers).toEqual([[1, 'yes'], [4, '@accepted']]);
  });

  it('bounces a form where a person has no ticket type, a client-sent terms timestamp, or a type from elsewhere (307, nothing written)', async () => {
    for (const bad of [
      { ...good, ticket_0: '' },
      { ...good, person_name_1: 'Mia', pq_1_2: 'plain' },
      { ...good, '4': '2026-01-01 10:00:00' },
      { ...good, ticket_0: '999' },
    ]) {
      const dependencies = typedDeps();
      const response = await run(dependencies, form(bad));
      expect(response.status).toBe(307);
      expect(dependencies.createRegistration).not.toHaveBeenCalled();
    }
  });
});
