import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import type { DbEnv } from '../../src/lib/dbProvider';
import { handleStripeEvent } from '../../src/lib/givingWebhook';
import { PgAdapter } from '../../src/lib/pgAdapter';
import {
  attachVerifiedCheckoutSession,
  cancelPendingCheckoutRequest,
  drainStripeCheckoutRecovery,
  reconcileCheckoutRequestNow,
} from '../../src/lib/stripeCheckoutRecovery';
import { StripeError, type StripeCheckoutSession, type StripeEnv } from '../../src/lib/stripe';
import {
  attachRegistrationCheckoutRequest,
  resolveRegistrationCheckoutRequest,
} from '../../src/lib/stripeCheckoutRequests';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { clearModuleCache } from '../../src/lib/modules';

const ENV: StripeEnv & DbEnv = {
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_checkout_recovery',
  STRIPE_WEBHOOK_SECRET: 'whsec_checkout_recovery',
  DB_BACKEND: 'supabase',
  HYPERDRIVE: { connectionString: DATABASE_URL },
};
const T0 = new Date('2026-07-13T12:00:00.000Z');
const REQUEST = '00000000-0000-4000-8000-000000000811';
const CHECKPOINTS = [45, 90, 180, 480, 960, 1425];
const sqlTime = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');
const plusMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

describe.skipIf(!hasPg)('registration Checkout recovery (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;
  let sequence = 0;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    execFileSync('node', ['scripts/db/seed-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });

  beforeEach(async () => {
    sequence = 0;
    await sql.unsafe(`
      TRUNCATE church_private.stripe_checkout_requests,
        church_private.stripe_webhook_events,
        reg_answers, registrations, reg_event_i18n, reg_events RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => { await sql?.end(); });

  const opened = () => ({ db, backend: 'supabase' as const, end: vi.fn(async () => {}) });

  it('skips new Checkout recovery without a complete test pair or Registration enablement', async () => {
    const missingOpen = vi.fn(opened);
    await expect(drainStripeCheckoutRecovery({ env: { ...ENV, STRIPE_WEBHOOK_SECRET: undefined }, openDb: missingOpen, now: () => T0 })).resolves.toEqual([]);
    expect(missingOpen).not.toHaveBeenCalled();

    await sql.unsafe(`INSERT INTO settings (key, value) VALUES ('module.registration', '0') ON CONFLICT (key) DO UPDATE SET value='0'`);
    clearModuleCache();
    const disabled = opened(); const disabledOpen = vi.fn(() => disabled);
    try {
      await expect(drainStripeCheckoutRecovery({ env: ENV, openDb: disabledOpen, now: () => T0 })).resolves.toEqual([]);
      expect(disabledOpen).toHaveBeenCalledOnce();
      expect(disabled.end).toHaveBeenCalledOnce();
    } finally {
      await sql.unsafe(`UPDATE settings SET value='1' WHERE key='module.registration'`);
      clearModuleCache();
    }
  });

  const createRequest = async (requestId = REQUEST, createdAt = T0) => {
    sequence += 1;
    const [event] = await sql.unsafe(
      `INSERT INTO reg_events (starts_at, capacity, price_cents, currency)
       VALUES (datetime('now', '+1 day'), 20, 2500, 'usd') RETURNING id`,
    );
    await sql.unsafe(
      `INSERT INTO reg_event_i18n (event_id, locale, title) VALUES ($1, 'en', $2)`,
      [event.id, `Recovery Event ${sequence}`],
    );
    const resolved = await resolveRegistrationCheckoutRequest(db, {
      requestId,
      eventId: event.id,
      personId: null,
      name: 'Ada Lovelace',
      email: `ada${sequence}@example.com`,
      amountCents: 2500,
      currency: 'usd',
      answers: [],
      eventTitle: `Recovery Event ${sequence}`,
      locale: 'en',
      appOrigin: 'http://localhost:4321',
    });
    if (resolved.kind !== 'create') throw new Error('expected create');
    await sql.unsafe(
      `UPDATE church_private.stripe_checkout_requests
       SET created_at=$2, updated_at=$2, next_reconcile_at=$3 WHERE request_id=$1`,
      [requestId, sqlTime(createdAt), sqlTime(plusMinutes(createdAt, 45))],
    );
    return { registrationId: resolved.registrationId, params: resolved.requestJson, eventId: event.id };
  };

  const session = (
    registrationId: number,
    requestId = REQUEST,
    overrides: Partial<StripeCheckoutSession> = {},
  ): StripeCheckoutSession => ({
    id: `cs_test_recovery_${requestId.slice(-3)}`,
    url: `https://checkout.stripe.com/c/pay/cs_test_recovery_${requestId.slice(-3)}`,
    mode: 'payment',
    livemode: false,
    status: 'open',
    payment_status: 'unpaid',
    payment_intent: null,
    amount_total: 2500,
    currency: 'usd',
    metadata: { kind: 'registration', registration_id: String(registrationId), request_id: requestId },
    ...overrides,
  });

  const row = async (requestId = REQUEST) => (await sql.unsafe(
    `SELECT q.state,q.request_json,q.session_url,q.reconcile_attempts,q.next_reconcile_at,
            q.last_error,q.last_action_by,q.updated_at,
            r.status,r.stripe_checkout_session_id,r.stripe_payment_intent_id
     FROM church_private.stripe_checkout_requests q
     JOIN registrations r ON r.id=q.registration_id WHERE q.request_id=$1`,
    [requestId],
  ))[0];

  it('starts at 45m, attempts only exact immutable-age checkpoints, and finalizes ambiguity at 23h45', async () => {
    await createRequest();
    const createCheckout = vi.fn(async () => {
      throw new StripeError('transport secret body', { stage: 'transport' });
    });
    const retrieveCheckout = vi.fn();

    for (let index = 0; index < CHECKPOINTS.length; index += 1) {
      const checkpoint = CHECKPOINTS[index];
      expect(await drainStripeCheckoutRecovery({
        env: ENV, openDb: opened, now: () => plusMinutes(T0, checkpoint - 1 / 60),
        createCheckout, retrieveCheckout,
      })).toEqual([]);
      expect(createCheckout).toHaveBeenCalledTimes(index);

      const results = await drainStripeCheckoutRecovery({
        env: ENV, openDb: opened, now: () => plusMinutes(T0, checkpoint),
        createCheckout, retrieveCheckout,
      });
      expect(results).toHaveLength(1);
      expect(createCheckout).toHaveBeenCalledTimes(index + 1);
      const calls = createCheckout.mock.calls as unknown as unknown[][];
      expect(calls[index]?.[2]).toEqual({ requestId: REQUEST });
      const current = await row();
      if (index < CHECKPOINTS.length - 1) {
        expect(current.state).toBe('creating');
        expect(new Date(`${current.next_reconcile_at}Z`).getTime()).toBe(plusMinutes(T0, CHECKPOINTS[index + 1]).getTime());
        expect(current.request_json).not.toBeNull();
      } else {
        expect(current).toMatchObject({ state: 'manual_review', request_json: null, session_url: null });
        expect(current.next_reconcile_at).toBeNull();
      }
      expect(String(current.last_error)).not.toContain('secret');
      expect(String(current.last_error).length).toBeLessThanOrEqual(1000);
    }
    expect(retrieveCheckout).not.toHaveBeenCalled();
  });

  it('byte-bounds, normalizes, and redacts hostile Stripe diagnostic codes without stranding claims', async () => {
    const variants = [
      { code: '😀'.repeat(400), now: plusMinutes(T0, 45), state: 'creating' },
      { code: 'bad\ncode\u0000with\tcontrols', now: plusMinutes(T0, 45), state: 'creating' },
      { code: `leaked_${ENV.STRIPE_SECRET_KEY}_marker`, now: plusMinutes(T0, 1425), state: 'manual_review' },
    ] as const;
    for (let index = 0; index < variants.length; index += 1) {
      if (index > 0) await sql.unsafe('TRUNCATE church_private.stripe_checkout_requests, registrations CASCADE');
      await createRequest();
      const hostile = new StripeError('hostile diagnostic', { stage: 'response', code: 'placeholder' });
      hostile.code = variants[index].code;
      const results = await drainStripeCheckoutRecovery({
        env: ENV, openDb: opened, now: () => variants[index].now,
        createCheckout: vi.fn(async () => { throw hostile; }), retrieveCheckout: vi.fn(),
      });
      expect(results).toHaveLength(1);
      const [diagnostic] = await sql.unsafe(
        `SELECT state,last_error,octet_length(last_error) AS error_bytes
         FROM church_private.stripe_checkout_requests WHERE request_id=$1`,
        [REQUEST],
      );
      expect(diagnostic.state).toBe(variants[index].state);
      expect(Number(diagnostic.error_bytes)).toBeLessThanOrEqual(1000);
      expect(String(diagnostic.last_error)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      expect(String(diagnostic.last_error)).not.toContain(ENV.STRIPE_SECRET_KEY);
    }
  });

  it('replays the exact saved create/key then retrieves, but never creates at or beyond 24h', async () => {
    const { registrationId, params } = await createRequest();
    const open = session(registrationId);
    const createCheckout = vi.fn(async () => open as StripeCheckoutSession & { url: string });
    const retrieveCheckout = vi.fn(async () => open);
    await drainStripeCheckoutRecovery({
      env: ENV, openDb: opened, now: () => plusMinutes(T0, 45), createCheckout, retrieveCheckout,
    });
    expect(createCheckout).toHaveBeenCalledWith(ENV, params, { requestId: REQUEST });
    expect(retrieveCheckout).toHaveBeenCalledWith(ENV, open.id, expect.any(Object));

    await sql.unsafe('TRUNCATE church_private.stripe_checkout_requests, registrations CASCADE');
    const old = new Date(T0.getTime() - 24 * 60 * 60_000);
    await createRequest(REQUEST, old);
    await sql.unsafe(
      `UPDATE church_private.stripe_checkout_requests SET next_reconcile_at=$2 WHERE request_id=$1`,
      [REQUEST, sqlTime(T0)],
    );
    createCheckout.mockClear();
    await drainStripeCheckoutRecovery({ env: ENV, openDb: opened, now: () => T0, createCheckout, retrieveCheckout });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ state: 'manual_review', request_json: null, session_url: null });
  });

  it('durably attaches a verified create response before retrieval can time out', async () => {
    const { registrationId } = await createRequest();
    const created = session(registrationId);
    await drainStripeCheckoutRecovery({
      env: ENV,
      openDb: opened,
      now: () => plusMinutes(T0, 1425),
      createCheckout: vi.fn(async () => created as StripeCheckoutSession & { url: string }),
      retrieveCheckout: vi.fn(async () => {
        throw new StripeError('retrieve timeout', { stage: 'transport' });
      }),
    });
    expect(await row()).toMatchObject({
      status: 'pending',
      state: 'attached',
      request_json: null,
      stripe_checkout_session_id: created.id,
    });
    expect((await row()).next_reconcile_at).not.toBeNull();
  });

  it.each([
    ['paid', { status: 'complete', payment_status: 'paid', payment_intent: 'pi_recovered' },
      { status: 'confirmed', state: 'resolved', request_json: null, session_url: null }],
    ['complete unpaid', { status: 'complete', payment_status: 'unpaid' },
      { status: 'pending', state: 'attached', request_json: null, session_url: null }],
    ['expired', { status: 'expired', payment_status: 'unpaid', url: null },
      { status: 'cancelled', state: 'resolved', request_json: null, session_url: null }],
    ['open', { status: 'open', payment_status: 'unpaid' },
      { status: 'pending', state: 'attached', request_json: null,
        session_url: 'https://checkout.stripe.com/c/pay/cs_test_recovery_811' }],
  ] as const)('applies the guarded %s recovery outcome', async (_label, overrides, expected) => {
    const { registrationId } = await createRequest();
    const recovered = session(registrationId, REQUEST, overrides);
    await drainStripeCheckoutRecovery({
      env: ENV,
      openDb: opened,
      now: () => plusMinutes(T0, 45),
      createCheckout: vi.fn(async () => recovered as StripeCheckoutSession & { url: string }),
      retrieveCheckout: vi.fn(async () => recovered),
    });
    expect(await row()).toMatchObject(expected);
  });

  it('attached requests retrieve only and unresolved sessions use a once-daily cadence', async () => {
    const { registrationId } = await createRequest();
    const open = session(registrationId);
    const initialDeadline = (await row()).next_reconcile_at;
    expect(await attachRegistrationCheckoutRequest(db, {
      requestId: REQUEST,
      registrationId,
      sessionId: open.id,
      sessionUrl: open.url as string,
      amountCents: 2500,
      currency: 'usd',
    })).toBe(true);
    expect((await row()).next_reconcile_at).toBe(initialDeadline);
    const createCheckout = vi.fn();
    const retrieveCheckout = vi.fn(async () => open);
    await drainStripeCheckoutRecovery({
      env: ENV, openDb: opened, now: () => plusMinutes(T0, 45), createCheckout, retrieveCheckout,
    });
    expect(createCheckout).not.toHaveBeenCalled();
    expect(retrieveCheckout).toHaveBeenCalledOnce();
    const next = plusMinutes(T0, 45 + 24 * 60);
    expect(new Date(`${(await row()).next_reconcile_at}Z`).getTime()).toBe(next.getTime());
    expect(await drainStripeCheckoutRecovery({
      env: ENV, openDb: opened, now: () => new Date(next.getTime() - 1), createCheckout, retrieveCheckout,
    })).toEqual([]);
    await drainStripeCheckoutRecovery({ env: ENV, openDb: opened, now: () => next, createCheckout, retrieveCheckout });
    expect(retrieveCheckout).toHaveBeenCalledTimes(2);
  });

  it('cron/manual overlap has one claim-version winner', async () => {
    await createRequest();
    const createCheckout = vi.fn(async () => {
      throw new StripeError('timeout', { stage: 'transport' });
    });
    const deps = {
      env: ENV, openDb: opened, now: () => plusMinutes(T0, 45), createCheckout, retrieveCheckout: vi.fn(),
    };
    const [cron, manual] = await Promise.all([
      drainStripeCheckoutRecovery(deps),
      reconcileCheckoutRequestNow(deps, REQUEST, 1),
    ]);
    expect(createCheckout).toHaveBeenCalledOnce();
    expect([cron.length, manual.state === 'not_claimed' ? 0 : 1].sort()).toEqual([0, 1]);
  });

  it('a manual retry cannot steal a cron claim during its ten-minute lease', async () => {
    await createRequest();
    let releaseCreate!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let createCalls = 0;
    const createCheckout = vi.fn(async () => {
      createCalls += 1;
      markStarted();
      if (createCalls === 1) await release;
      throw new StripeError('timeout', { stage: 'transport' });
    });
    const cron = drainStripeCheckoutRecovery({
      env: ENV, openDb: opened, now: () => plusMinutes(T0, 45), createCheckout, retrieveCheckout: vi.fn(),
    });
    await started;
    const manual = await reconcileCheckoutRequestNow({
      env: ENV, openDb: opened, now: () => plusMinutes(T0, 46), createCheckout, retrieveCheckout: vi.fn(),
    }, REQUEST, 9);
    expect(manual).toEqual({ requestId: REQUEST, state: 'not_claimed' });
    expect(createCheckout).toHaveBeenCalledOnce();
    releaseCreate();
    await cron;
  });

  it('reports no work when a successor changes the claim before ambiguity is scheduled', async () => {
    await createRequest();
    const results = await drainStripeCheckoutRecovery({
      env: ENV,
      openDb: opened,
      now: () => plusMinutes(T0, 45),
      createCheckout: vi.fn(async () => {
        await sql.unsafe(
          `UPDATE church_private.stripe_checkout_requests
           SET last_error='successor_owned',updated_at=$2 WHERE request_id=$1`,
          [REQUEST, sqlTime(new Date(plusMinutes(T0, 45).getTime() + 1000))],
        );
        throw new StripeError('stale timeout', { stage: 'transport' });
      }),
      retrieveCheckout: vi.fn(),
    });
    expect(results).toEqual([]);
    expect(await row()).toMatchObject({ last_error: 'successor_owned' });
  });

  it('contains malformed retained parameters to one request and continues the due batch', async () => {
    await createRequest();
    const secondRequest = '00000000-0000-4000-8000-000000000812';
    const second = await createRequest(secondRequest);
    await sql.unsafe(
      `UPDATE church_private.stripe_checkout_requests SET request_json='{"bad":true}' WHERE request_id=$1`,
      [REQUEST],
    );
    const recovered = session(second.registrationId, secondRequest);
    const createCheckout = vi.fn(async (_env, params) => {
      expect(params.metadata.request_id).toBe(secondRequest);
      return recovered as StripeCheckoutSession & { url: string };
    });
    const results = await drainStripeCheckoutRecovery({
      env: ENV, openDb: opened, now: () => plusMinutes(T0, 45), createCheckout,
      retrieveCheckout: vi.fn(async () => recovered),
    });
    expect(results).toHaveLength(2);
    expect(createCheckout).toHaveBeenCalledOnce();
    expect(await row()).toMatchObject({ state: 'creating', last_error: expect.any(String) });
    expect(String((await row()).last_error).length).toBeLessThanOrEqual(1000);
    expect(await row(secondRequest)).toMatchObject({ state: 'attached', stripe_checkout_session_id: recovered.id });
  });

  it('keeps manual-cancel healing authority through an expired webhook for an attached session', async () => {
    const { registrationId } = await createRequest();
    const attached = session(registrationId);
    await sql.unsafe(`UPDATE registrations SET stripe_checkout_session_id=$2 WHERE id=$1`, [registrationId, attached.id]);
    await sql.unsafe(
      `UPDATE church_private.stripe_checkout_requests
       SET state='attached',request_json=NULL,next_reconcile_at=$2 WHERE request_id=$1`,
      [REQUEST, sqlTime(plusMinutes(T0, 45))],
    );
    const deps = { env: ENV, openDb: opened, now: () => plusMinutes(T0, 10) };
    expect(await cancelPendingCheckoutRequest(
      deps, REQUEST, 5, `cancel-registration-${registrationId}`,
    )).toEqual({ state: 'applied' });
    expect(await handleStripeEvent({ db, env: ENV, modules: new Set(['registration']) }, {
      id: 'evt_test_expired_after_manual_cancel', type: 'checkout.session.expired', livemode: false,
      data: { object: session(registrationId, REQUEST, { status: 'expired', url: null }) },
    })).toMatchObject({ state: 'processed' });
    expect(await row()).toMatchObject({ status: 'cancelled', last_error: 'manual_cancel' });
    expect(await handleStripeEvent({ db, env: ENV, modules: new Set(['registration']) }, {
      id: 'evt_test_paid_after_expired', type: 'checkout.session.completed', livemode: false,
      data: { object: session(registrationId, REQUEST, {
        status: 'complete', payment_status: 'paid', payment_intent: 'pi_after_expired',
      }) },
    })).toMatchObject({ state: 'processed' });
    expect(await row()).toMatchObject({ status: 'confirmed', last_error: null });
  });

  it('a late valid webhook heals manual_review and clears retained private state', async () => {
    const { registrationId } = await createRequest();
    await sql.unsafe(
      `UPDATE church_private.stripe_checkout_requests
       SET state='manual_review',request_json=NULL,session_url=NULL,next_reconcile_at=NULL WHERE request_id=$1`,
      [REQUEST],
    );
    expect(await handleStripeEvent({ db, env: ENV, modules: new Set(['registration']) }, {
      id: 'evt_test_late_recovery',
      type: 'checkout.session.completed',
      livemode: false,
      data: { object: session(registrationId, REQUEST, {
        status: 'complete', payment_status: 'paid', payment_intent: 'pi_late',
      }) },
    })).toMatchObject({ state: 'processed' });
    expect(await row()).toMatchObject({ status: 'confirmed', state: 'resolved', request_json: null, session_url: null });
  });

  it('strictly rejects live, wrong-ID, identity, amount, and currency retrievals without a status transition', async () => {
    const variants: Array<Partial<StripeCheckoutSession>> = [
      { livemode: true as never },
      { id: 'cs_live_wrong' },
      { id: 'cs_test_different' },
      { metadata: { kind: 'registration', registration_id: '999', request_id: REQUEST } },
      { metadata: { kind: 'registration', registration_id: '1', request_id: '00000000-0000-4000-8000-000000000899' } },
      { amount_total: 9999 },
      { currency: 'cad' },
    ];
    for (let index = 0; index < variants.length; index += 1) {
      if (index > 0) await sql.unsafe('TRUNCATE church_private.stripe_checkout_requests, registrations CASCADE');
      const { registrationId } = await createRequest();
      const invalid = session(registrationId, REQUEST, variants[index]);
      await drainStripeCheckoutRecovery({
        env: ENV, openDb: opened, now: () => plusMinutes(T0, 45),
        createCheckout: vi.fn(async () => ({ ...session(registrationId), id: 'cs_test_expected' }) as never),
        retrieveCheckout: vi.fn(async () => invalid),
      });
      expect(await row()).toMatchObject({
        status: 'pending', state: 'attached', request_json: null, session_url: null,
        stripe_checkout_session_id: 'cs_test_expected',
      });
    }
  });

  it('does not confirm a paid response without a durable payment-intent identity', async () => {
    const { registrationId } = await createRequest();
    const missingPaymentIntent = session(registrationId, REQUEST, {
      status: 'complete', payment_status: 'paid', payment_intent: null,
    });
    await drainStripeCheckoutRecovery({
      env: ENV, openDb: opened, now: () => plusMinutes(T0, 45),
      createCheckout: vi.fn(async () => missingPaymentIntent as StripeCheckoutSession & { url: string }),
      retrieveCheckout: vi.fn(async () => missingPaymentIntent),
    });
    expect(await row()).toMatchObject({
      status: 'pending', state: 'creating', stripe_checkout_session_id: null,
      stripe_payment_intent_id: null,
    });
  });

  it('an invalid manual attachment preserves automated recovery state at the final checkpoint', async () => {
    const { registrationId } = await createRequest();
    const invalid = session(registrationId, REQUEST, { status: null, payment_status: null, url: null });
    const before = await row();
    const result = await attachVerifiedCheckoutSession({
      env: ENV, openDb: opened, now: () => plusMinutes(T0, 1425),
      retrieveCheckout: vi.fn(async () => invalid),
    }, REQUEST, invalid.id, 7);
    expect(result).toEqual({ state: 'invalid' });
    expect(await row()).toMatchObject({
      status: 'pending', state: 'creating', request_json: expect.any(String),
      stripe_checkout_session_id: null, next_reconcile_at: before.next_reconcile_at,
      last_action_by: 7, reconcile_attempts: before.reconcile_attempts,
    });
  });

  it('manual verified attach/reconcile/cancel require exact validation, actor, and confirmation audit', async () => {
    const { registrationId } = await createRequest();
    const open = session(registrationId);
    const deps = {
      env: ENV, openDb: opened, now: () => plusMinutes(T0, 10),
      createCheckout: vi.fn(), retrieveCheckout: vi.fn(async () => open),
    };
    await sql.unsafe(
      `UPDATE church_private.stripe_checkout_requests
       SET state='manual_review',request_json=NULL,session_url=NULL,next_reconcile_at=NULL WHERE request_id=$1`,
      [REQUEST],
    );
    expect(await attachVerifiedCheckoutSession(deps, REQUEST, open.id, 1)).toMatchObject({ state: 'applied' });
    expect(await row()).toMatchObject({ state: 'attached', last_action_by: 1, reconcile_attempts: 0 });

    await sql.unsafe('TRUNCATE church_private.stripe_checkout_requests, registrations CASCADE');
    const second = await createRequest();
    await sql.unsafe(
      `UPDATE church_private.stripe_checkout_requests
       SET state='manual_review',request_json=NULL,session_url=NULL,next_reconcile_at=NULL WHERE request_id=$1`,
      [REQUEST],
    );
    expect(await cancelPendingCheckoutRequest(deps, REQUEST, 1, 'wrong')).toEqual({ state: 'confirmation_required' });
    expect((await row()).status).toBe('pending');
    expect(await cancelPendingCheckoutRequest(deps, REQUEST, 1, `cancel-registration-${second.registrationId}`))
      .toMatchObject({ state: 'applied' });
    expect(await row()).toMatchObject({
      status: 'cancelled', state: 'resolved', last_action_by: 1, reconcile_attempts: 0,
    });
    expect(await resolveRegistrationCheckoutRequest(db, {
      requestId: REQUEST,
      eventId: second.eventId,
      personId: null,
      name: 'Ada Lovelace',
      email: 'ada2@example.com',
      amountCents: 2500,
      currency: 'usd',
      answers: [],
      eventTitle: 'Recovery Event 2',
      locale: 'en',
      appOrigin: 'http://localhost:4321',
    })).toEqual({ kind: 'expired' });
    expect(await row()).toMatchObject({ last_error: 'manual_cancel' });
    expect(await handleStripeEvent({ db, env: ENV, modules: new Set(['registration']) }, {
      id: 'evt_test_paid_after_manual_cancel',
      type: 'checkout.session.completed',
      livemode: false,
      data: { object: session(second.registrationId, REQUEST, {
        status: 'complete', payment_status: 'paid', payment_intent: 'pi_after_manual_cancel',
      }) },
    })).toMatchObject({ state: 'processed' });
    expect(await row()).toMatchObject({ status: 'confirmed', state: 'resolved', last_error: null });
  });
});
