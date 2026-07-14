import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import type { DbEnv } from '../../src/lib/dbProvider';
import { handleStripeEvent } from '../../src/lib/givingWebhook';
import { clearModuleCache } from '../../src/lib/modules';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { type StripeCheckoutSession, StripeError, type StripeEnv } from '../../src/lib/stripe';
import { drainStripeCheckoutRecovery, reconcileCheckoutRequestNow } from '../../src/lib/stripeCheckoutRecovery';
import { resolveRegistrationCheckoutRequest } from '../../src/lib/stripeCheckoutRequests';
import { handleStripeWebhookRequest } from '../../src/lib/stripeWebhookEndpoint';
import {
  STRIPE_LEASE_MS,
  receiveStripeEvent,
  sha256Utf8,
  type StripeReceiptInput,
} from '../../src/lib/stripeWebhookInbox';
import { processStripeWebhookEvent, type StripeWebhookProcessorDeps } from '../../src/lib/stripeWebhookProcessor';
import { signedStripeRequest, stripeEvent } from '../stripeFixtures';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const T0 = new Date('2026-07-13T12:00:00.000Z');
const NOW_SECONDS = Math.floor(T0.getTime() / 1000);
const REQUEST_ID = '00000000-0000-4000-8000-000000000913';
const ENV: StripeEnv & DbEnv = {
  DB_BACKEND: 'supabase',
  HYPERDRIVE: { connectionString: DATABASE_URL },
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_reliability',
  STRIPE_WEBHOOK_SECRET: 'whsec_reliability',
  APP_ORIGIN: 'https://church.example',
};

const addMs = (date: Date, milliseconds: number) => new Date(date.getTime() + milliseconds);
const sqlTime = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');
const parseSqlTime = (value: string) => new Date(`${value.replace(' ', 'T')}Z`);
const BARRIER_DEADLOCK_GUARD_MS = 5_000;

function oneShotBarrier() {
  let markReached!: () => void;
  let releaseWaiter!: () => void;
  let announced = false;
  let didRelease = false;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  const released = new Promise<void>((resolve) => { releaseWaiter = resolve; });
  return {
    async waitUntilReached(label: string) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reached,
          new Promise<void>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error(
                `Barrier "${label}" was not reached within ${BARRIER_DEADLOCK_GUARD_MS}ms; possible test deadlock`,
              ));
            }, BARRIER_DEADLOCK_GUARD_MS);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
    release() {
      if (didRelease) return;
      didRelease = true;
      releaseWaiter();
    },
    async wait() {
      if (!announced) {
        announced = true;
        markReached();
      }
      await released;
    },
  };
}

describe.skipIf(!hasPg)('Stripe crash and concurrency reliability (Postgres)', () => {
  const sqlA = hasPg ? pgClient() : (null as never);
  const sqlB = hasPg ? pgClient() : (null as never);
  let dbA: AppDb;
  let dbB: AppDb;

  const opened = (db: AppDb) => ({ db, backend: 'supabase' as const, end: async () => {} });

  async function receive(event: Record<string, unknown>) {
    const body = JSON.stringify(event);
    const input: StripeReceiptInput = {
      eventId: String(event.id),
      payloadJson: body,
      payloadSha256: await sha256Utf8(body),
      eventType: String(event.type),
      apiVersion: null,
      eventCreated: Number(event.created),
      livemode: false,
    };
    return receiveStripeEvent(dbA, input, T0);
  }

  async function fundId() {
    const [fund] = await sqlA.unsafe('SELECT id FROM funds ORDER BY id LIMIT 1');
    if (!fund) throw new Error('seeded fund missing');
    return Number(fund.id);
  }

  function giftEvent(
    eventId: string,
    paymentIntentId: string,
    giftFundId: number,
    personId: string = '',
  ) {
    return stripeEvent('checkout.session.completed', {
      id: `cs_test_${paymentIntentId}`,
      mode: 'payment',
      payment_status: 'paid',
      payment_intent: paymentIntentId,
      amount_total: 5000,
      currency: 'usd',
      customer: personId ? `cus_${paymentIntentId}` : null,
      customer_details: { email: `${paymentIntentId}@example.test` },
      metadata: { kind: 'gift', fund_id: String(giftFundId), person_id: personId },
    }, { id: eventId, created: NOW_SECONDS });
  }

  async function createCheckoutRequest(requestId = REQUEST_ID) {
    const [event] = await sqlA.unsafe(
      `INSERT INTO reg_events (starts_at,capacity,price_cents,currency)
       VALUES (datetime('now','+1 day'),1,2500,'usd') RETURNING id`,
    );
    await sqlA.unsafe(
      `INSERT INTO reg_event_i18n (event_id,locale,title) VALUES ($1,'en','Reliability event')`,
      [event.id],
    );
    const resolved = await resolveRegistrationCheckoutRequest(dbA, {
      requestId,
      eventId: Number(event.id),
      personId: null,
      name: 'Reliability Tester',
      email: 'reliability@example.test',
      amountCents: 2500,
      currency: 'usd',
      answers: [],
      eventTitle: 'Reliability event',
      locale: 'en',
      appOrigin: ENV.APP_ORIGIN!,
    });
    if (resolved.kind !== 'create') throw new Error('expected checkout create');
    await sqlA.unsafe(
      `UPDATE church_private.stripe_checkout_requests
       SET created_at=$2,updated_at=$2,next_reconcile_at=$3 WHERE request_id=$1`,
      [requestId, sqlTime(T0), sqlTime(addMs(T0, 45 * 60_000))],
    );
    return { eventId: Number(event.id), registrationId: resolved.registrationId };
  }

  function registrationSession(registrationId: number, overrides: Partial<StripeCheckoutSession> = {}): StripeCheckoutSession {
    return {
      id: 'cs_test_reliability_registration',
      url: 'https://checkout.stripe.com/c/pay/cs_test_reliability_registration',
      mode: 'payment',
      livemode: false,
      status: 'open',
      payment_status: 'unpaid',
      payment_intent: null,
      amount_total: 2500,
      currency: 'usd',
      metadata: {
        kind: 'registration',
        registration_id: String(registrationId),
        request_id: REQUEST_ID,
      },
      ...overrides,
    };
  }

  function pausedDomainDispatch(barrier: ReturnType<typeof oneShotBarrier>) {
    return async (
      deps: Parameters<NonNullable<StripeWebhookProcessorDeps['dispatch']>>[0],
      event: Record<string, unknown>,
    ) => handleStripeEvent({
      ...deps,
      checkpoint: async () => {
        await deps.checkpoint?.();
        await barrier.wait();
      },
    }, event);
  }

  beforeAll(async () => {
    await resetSchema(sqlA);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    execFileSync('node', ['scripts/db/seed-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    dbA = new PgAdapter(sqlA);
    dbB = new PgAdapter(sqlB);
  });

  beforeEach(async () => {
    clearModuleCache();
    await sqlA.unsafe(`
      TRUNCATE church_private.stripe_checkout_requests,
        church_private.stripe_webhook_events,
        reg_answers, registrations, reg_event_i18n, reg_events,
        gifts, recurring_gifts RESTART IDENTITY CASCADE
    `);
    await sqlA.unsafe(`UPDATE settings SET value='1' WHERE key IN ('module.giving','module.registration')`);
    await sqlA.unsafe(`UPDATE people SET stripe_customer_id=NULL`);
  });

  afterAll(async () => {
    await Promise.all([sqlA?.end(), sqlB?.end()]);
  });

  it('an expired gift worker can overlap its successor without duplicating the gift', async () => {
    const eventId = 'evt_test_expired_gift_overlap';
    const event = giftEvent(eventId, 'pi_reliability_overlap', await fundId());
    await receive(event);
    const barrier = oneShotBarrier();

    const stale = processStripeWebhookEvent(eventId, {
      env: ENV,
      openDb: () => opened(dbA),
      now: () => T0,
      newLeaseToken: () => 'lease-expired-gift',
      dispatch: pausedDomainDispatch(barrier),
    });
    let successor;
    try {
      await barrier.waitUntilReached('expired gift worker domain checkpoint');
      successor = await processStripeWebhookEvent(eventId, {
        env: ENV,
        openDb: () => opened(dbB),
        now: () => addMs(T0, STRIPE_LEASE_MS),
        newLeaseToken: () => 'lease-successor-gift',
      });
    } finally {
      barrier.release();
    }

    expect(successor).toEqual({ state: 'processed', outcome: 'gift_recorded' });
    expect(await stale).toEqual({ state: 'failed' });
    expect(await sqlA.unsafe(
      `SELECT stripe_payment_intent_id FROM gifts WHERE stripe_payment_intent_id='pi_reliability_overlap'`,
    )).toHaveLength(1);
    expect(await sqlA.unsafe(
      `SELECT status,outcome,attempt_count,lease_token
       FROM church_private.stripe_webhook_events WHERE event_id=$1`,
      [eventId],
    )).toEqual([{ status: 'processed', outcome: 'gift_recorded', attempt_count: 2, lease_token: null }]);
  });

  it('a malformed paid gift without a PaymentIntent stays a no-op across an expired-lease overlap', async () => {
    const eventId = 'evt_test_malformed_gift_overlap';
    const event = stripeEvent('checkout.session.completed', {
      id: 'cs_test_malformed_gift_overlap',
      mode: 'payment',
      payment_status: 'paid',
      amount_total: 5000,
      currency: 'usd',
      metadata: { kind: 'gift', fund_id: String(await fundId()), person_id: '' },
    }, { id: eventId, created: NOW_SECONDS });
    await receive(event);
    const barrier = oneShotBarrier();
    const stale = processStripeWebhookEvent(eventId, {
      env: ENV,
      openDb: () => opened(dbA),
      now: () => T0,
      newLeaseToken: () => 'lease-malformed-gift',
      dispatch: vi.fn(async (deps, storedEvent) => {
        await barrier.wait();
        return handleStripeEvent(deps, storedEvent);
      }),
    });
    let successor;
    try {
      await barrier.waitUntilReached('malformed gift worker before domain dispatch');
      successor = await processStripeWebhookEvent(eventId, {
        env: ENV,
        openDb: () => opened(dbB),
        now: () => addMs(T0, STRIPE_LEASE_MS),
        newLeaseToken: () => 'lease-malformed-gift-successor',
      });
    } finally {
      barrier.release();
    }

    expect(successor).toEqual({ state: 'ignored', outcome: 'ignored' });
    expect(await stale).toEqual({ state: 'failed' });
    expect(await sqlA.unsafe('SELECT id FROM gifts')).toHaveLength(0);
    expect(await sqlA.unsafe(
      `SELECT status,outcome,attempt_count FROM church_private.stripe_webhook_events WHERE event_id=$1`,
      [eventId],
    )).toEqual([{ status: 'ignored', outcome: 'ignored', attempt_count: 2 }]);
  });

  it('an expired registration worker overlaps its successor without duplicating the row or held seat', async () => {
    const { eventId: registrationEventId, registrationId } = await createCheckoutRequest();
    const eventId = 'evt_test_expired_registration_overlap';
    const session = registrationSession(registrationId, {
      status: 'complete', payment_status: 'paid', payment_intent: 'pi_reliability_registration',
    });
    const event = stripeEvent('checkout.session.completed', session, { id: eventId, created: NOW_SECONDS });
    await receive(event);
    const barrier = oneShotBarrier();

    const stale = processStripeWebhookEvent(eventId, {
      env: ENV,
      openDb: () => opened(dbA),
      now: () => T0,
      newLeaseToken: () => 'lease-expired-registration',
      dispatch: pausedDomainDispatch(barrier),
    });
    let successor;
    try {
      await barrier.waitUntilReached('expired registration worker domain checkpoint');
      successor = await processStripeWebhookEvent(eventId, {
        env: ENV,
        openDb: () => opened(dbB),
        now: () => addMs(T0, STRIPE_LEASE_MS),
        newLeaseToken: () => 'lease-successor-registration',
      });
    } finally {
      barrier.release();
    }

    expect(successor).toEqual({ state: 'processed', outcome: 'registration_confirmed' });
    expect(await stale).toEqual({ state: 'failed' });
    expect(await sqlA.unsafe(
      `SELECT id,status,stripe_checkout_session_id FROM registrations WHERE event_id=$1`,
      [registrationEventId],
    )).toEqual([{
      id: registrationId,
      status: 'confirmed',
      stripe_checkout_session_id: session.id,
    }]);
    expect(await sqlA.unsafe(
      `SELECT count(*)::int AS seats FROM registrations
       WHERE event_id=$1 AND status IN ('pending','confirmed')`,
      [registrationEventId],
    )).toEqual([{ seats: 1 }]);
    expect(await sqlA.unsafe(
      `SELECT state FROM church_private.stripe_checkout_requests WHERE request_id=$1`,
      [REQUEST_ID],
    )).toEqual([{ state: 'resolved' }]);
  });

  it('a stale lease cannot overwrite the successor finalization', async () => {
    const eventId = 'evt_test_stale_finalization_barrier';
    await receive(stripeEvent('customer.created', {}, { id: eventId, created: NOW_SECONDS }));
    const barrier = oneShotBarrier();
    const stale = processStripeWebhookEvent(eventId, {
      env: ENV,
      openDb: () => opened(dbA),
      now: () => T0,
      newLeaseToken: () => 'lease-stale-finalizer',
      dispatch: vi.fn(async () => {
        await barrier.wait();
        return { state: 'processed', outcome: 'stale_must_not_win' } as const;
      }),
    });
    try {
      await barrier.waitUntilReached('stale finalizer dispatch');
      expect(await processStripeWebhookEvent(eventId, {
        env: ENV,
        openDb: () => opened(dbB),
        now: () => addMs(T0, STRIPE_LEASE_MS),
        newLeaseToken: () => 'lease-successor-finalizer',
        dispatch: vi.fn(async () => ({ state: 'ignored', outcome: 'successor_won' } as const)),
      })).toEqual({ state: 'ignored', outcome: 'successor_won' });
    } finally {
      barrier.release();
    }

    expect(await stale).toEqual({ state: 'failed' });
    expect(await sqlA.unsafe(
      `SELECT status,outcome,attempt_count FROM church_private.stripe_webhook_events WHERE event_id=$1`,
      [eventId],
    )).toEqual([{ status: 'ignored', outcome: 'successor_won', attempt_count: 2 }]);
  });

  it('a crash after the gift write resumes through checkpoints without duplicating effects', async () => {
    const eventId = 'evt_test_crash_after_gift_write';
    const event = giftEvent(eventId, 'pi_reliability_crash', await fundId(), '1');
    await receive(event);
    let firstCheckpoints = 0;

    expect(await processStripeWebhookEvent(eventId, {
      env: ENV,
      openDb: () => opened(dbA),
      now: () => T0,
      newLeaseToken: () => 'lease-crash-after-write',
      dispatch: async (deps, storedEvent) => handleStripeEvent({
        ...deps,
        checkpoint: async () => {
          await deps.checkpoint?.();
          firstCheckpoints += 1;
          if (firstCheckpoints === 2) throw new Error('simulated_crash_after_gift_write');
        },
      }, storedEvent),
    })).toEqual({ state: 'failed' });
    expect(firstCheckpoints).toBe(2);
    expect(await sqlA.unsafe(
      `SELECT id FROM gifts WHERE stripe_payment_intent_id='pi_reliability_crash'`,
    )).toHaveLength(1);
    expect(await sqlA.unsafe(`SELECT stripe_customer_id FROM people WHERE id=1`))
      .toEqual([{ stripe_customer_id: null }]);

    const [pending] = await sqlA.unsafe(
      `SELECT next_attempt_at FROM church_private.stripe_webhook_events WHERE event_id=$1`,
      [eventId],
    );
    let resumedCheckpoints = 0;
    expect(await processStripeWebhookEvent(eventId, {
      env: ENV,
      openDb: () => opened(dbB),
      now: () => parseSqlTime(String(pending.next_attempt_at)),
      newLeaseToken: () => 'lease-resume-after-write',
      dispatch: async (deps, storedEvent) => handleStripeEvent({
        ...deps,
        checkpoint: async () => {
          await deps.checkpoint?.();
          resumedCheckpoints += 1;
        },
      }, storedEvent),
    })).toEqual({ state: 'processed', outcome: 'gift_recorded' });

    expect(resumedCheckpoints).toBe(2);
    expect(await sqlA.unsafe(
      `SELECT id FROM gifts WHERE stripe_payment_intent_id='pi_reliability_crash'`,
    )).toHaveLength(1);
    expect(await sqlA.unsafe(`SELECT stripe_customer_id FROM people WHERE id=1`))
      .toEqual([{ stripe_customer_id: 'cus_pi_reliability_crash' }]);
    expect(await sqlA.unsafe(
      `SELECT status,attempt_count FROM church_private.stripe_webhook_events WHERE event_id=$1`,
      [eventId],
    )).toEqual([{ status: 'processed', attempt_count: 2 }]);
  });

  it('cron and manual Checkout reconciliation have one barrier-proven CAS winner', async () => {
    await createCheckoutRequest();
    const barrier = oneShotBarrier();
    const createCheckout = vi.fn(async () => {
      await barrier.wait();
      throw new StripeError('simulated timeout', { stage: 'transport' });
    });
    const cron = drainStripeCheckoutRecovery({
      env: ENV,
      openDb: () => opened(dbA),
      now: () => addMs(T0, 45 * 60_000),
      createCheckout,
      retrieveCheckout: vi.fn(),
    });
    try {
      await barrier.waitUntilReached('cron Checkout create after claim');
      const manual = await reconcileCheckoutRequestNow({
        env: ENV,
        openDb: () => opened(dbB),
        now: () => addMs(T0, 46 * 60_000),
        createCheckout,
        retrieveCheckout: vi.fn(),
      }, REQUEST_ID, 1);
      expect(manual).toEqual({ requestId: REQUEST_ID, state: 'not_claimed' });
      expect(createCheckout).toHaveBeenCalledOnce();
    } finally {
      barrier.release();
    }
    expect(await cron).toEqual([{ requestId: REQUEST_ID, state: 'scheduled' }]);
  });

  it('a webhook heals a request during outbound recovery without a stale overwrite', async () => {
    const { registrationId } = await createCheckoutRequest();
    const barrier = oneShotBarrier();
    const open = registrationSession(registrationId);
    const recovery = drainStripeCheckoutRecovery({
      env: ENV,
      openDb: () => opened(dbA),
      now: () => addMs(T0, 45 * 60_000),
      createCheckout: vi.fn(async () => {
        await barrier.wait();
        return open as StripeCheckoutSession & { url: string };
      }),
      retrieveCheckout: vi.fn(),
    });
    try {
      await barrier.waitUntilReached('outbound recovery Checkout create after claim');
      expect(await handleStripeEvent({ db: dbB, env: ENV, modules: new Set(['registration']) },
        stripeEvent('checkout.session.completed', registrationSession(registrationId, {
          status: 'complete',
          payment_status: 'paid',
          payment_intent: 'pi_reliability_webhook_heal',
        }), { id: 'evt_test_webhook_heals_recovery', created: NOW_SECONDS })))
        .toEqual({ state: 'processed', outcome: 'registration_confirmed' });
    } finally {
      barrier.release();
    }

    expect(await recovery).toEqual([]);
    expect(await sqlA.unsafe(
      `SELECT r.status,r.stripe_payment_intent_id,q.state,q.request_json,q.session_url
       FROM registrations r JOIN church_private.stripe_checkout_requests q ON q.registration_id=r.id
       WHERE q.request_id=$1`,
      [REQUEST_ID],
    )).toEqual([{
      status: 'confirmed',
      stripe_payment_intent_id: 'pi_reliability_webhook_heal',
      state: 'resolved',
      request_json: null,
      session_url: null,
    }]);
  });

  it('a duplicate delivery during processing returns durable 200 without a second mutation', async () => {
    const eventId = 'evt_test_duplicate_while_processing';
    const event = giftEvent(eventId, 'pi_reliability_duplicate', await fundId());
    const barrier = oneShotBarrier();
    const process = vi.fn(async (id: string) => processStripeWebhookEvent(id, {
      env: ENV,
      openDb: () => opened(dbB),
      now: () => T0,
      newLeaseToken: () => 'lease-duplicate-processing',
      dispatch: pausedDomainDispatch(barrier),
    }));
    let background!: Promise<unknown>;
    const firstRequest = await signedStripeRequest(event, ENV.STRIPE_WEBHOOK_SECRET!, NOW_SECONDS);
    const first = await handleStripeWebhookRequest(firstRequest, {
      db: dbA,
      env: ENV,
      modules: new Set(['giving']),
      nowSeconds: NOW_SECONDS,
      process,
      waitUntil: (promise) => { background = promise; },
    });
    expect([first.status, await first.text()]).toEqual([200, 'received']);
    try {
      await barrier.waitUntilReached('first duplicate-delivery processor domain checkpoint');
      const duplicateWaitUntil = vi.fn();
      const duplicateRequest = await signedStripeRequest(event, ENV.STRIPE_WEBHOOK_SECRET!, NOW_SECONDS);
      const duplicate = await handleStripeWebhookRequest(duplicateRequest, {
        db: dbA,
        env: ENV,
        modules: new Set(['giving']),
        nowSeconds: NOW_SECONDS,
        process,
        waitUntil: duplicateWaitUntil,
      });
      expect([duplicate.status, await duplicate.text()]).toEqual([200, 'processing']);
      expect(process).toHaveBeenCalledOnce();
      expect(duplicateWaitUntil).not.toHaveBeenCalled();
    } finally {
      barrier.release();
    }
    await background;
    expect(await sqlA.unsafe(
      `SELECT id FROM gifts WHERE stripe_payment_intent_id='pi_reliability_duplicate'`,
    )).toHaveLength(1);
  });
});
