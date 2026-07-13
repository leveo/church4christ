// The Stripe webhook event dispatcher (src/lib/givingWebhook.ts) against real
// Postgres. Migrates + seeds a fresh DB the runner way, builds a PgAdapter, then
// drives handleStripeEvent with synthetic Stripe event objects and a stubbed
// fetcher for retrieveSubscription (so no network). Covers the one-time and
// recurring happy paths, redelivery idempotency, the invoice-before-checkout
// webhook-order race, the refund flip, the subscription lifecycle, and the
// 'ignored' outcome for foreign traffic / missing metadata (a giving event must
// never throw on someone else's Stripe payload). Self-skips without DATABASE_URL.
// The isDbConnectivityError describe at the bottom is pure (no DB) and deliberately
// NOT gated — it runs on every `npm test`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { saveFund } from '../../src/lib/fundDb';
import { getStripeCustomer, getRecurringBySubscription, fundTotals } from '../../src/lib/givingDb';
import {
  handleStripeEvent as dispatchStripeEvent,
  isDbConnectivityError,
  isRetryableWebhookError,
  type WebhookDeps,
} from '../../src/lib/givingWebhook';
import { retrieveSubscription, StripeError, type StripeEnv } from '../../src/lib/stripe';
import { stripeEvent } from '../stripeFixtures';

const ENV: StripeEnv = {
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_x',
  APP_ORIGIN: 'https://church.example',
};

/** A fetch stub that answers GET /v1/subscriptions/<id> from a fixture map, so
 *  retrieveSubscription resolves without touching the network. */
function subFetcher(subs: Record<string, Record<string, unknown>>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const m = String(url).match(/subscriptions\/([^/?]+)/);
    const id = m ? decodeURIComponent(m[1]) : '';
    const sub = subs[id];
    const body = sub ? JSON.stringify(sub) : '{"error":{"message":"no such subscription"}}';
    return new Response(body, {
      status: sub ? 200 : 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

/** A subscription object shaped like Stripe's retrieve response. */
function subFixture(id: string, fundId: number, personId: number, amountCents: number, status = 'active') {
  return {
    id,
    status,
    customer: `cus_for_${id}`,
    metadata: { kind: 'gift', fund_id: String(fundId), person_id: String(personId) },
    items: { data: [{ price: { unit_amount: amountCents, currency: 'usd', recurring: { interval: 'month' } } }] },
  };
}

const ALL_MODULES = new Set(['giving', 'registration'] as const);
const handleStripeEvent = (
  deps: Omit<WebhookDeps, 'modules'>,
  event: Record<string, unknown>,
) => dispatchStripeEvent({ ...deps, modules: ALL_MODULES }, event);
const ev = stripeEvent;
const processed = (outcome: string) => ({ state: 'processed', outcome });
const ignored = (outcome = 'ignored') => ({ state: 'ignored', outcome });

describe.skipIf(!hasPg)('handleStripeEvent (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;
  let fund: number;

  const run = (script: string) =>
    execFileSync('node', [`scripts/db/${script}`], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    run('migrate-supabase.mjs');
    run('seed-supabase.mjs');
    db = new PgAdapter(sql);
    fund = await saveFund(db, { fund_number: 'W100', name_en: 'General', name_zh: '总奉献', active: 1, sort: 1 });
  });
  afterAll(async () => {
    await sql?.end();
  });

  const giftRow = (col: string, val: string) =>
    sql.unsafe(`SELECT * FROM gifts WHERE ${col} = $1`, [val]);

  // ── one-time checkout ────────────────────────────────────────────────────────
  it('one-time checkout.session.completed (guest) records a succeeded card gift', async () => {
    const outcome = await handleStripeEvent(
      { db, env: ENV },
      ev('checkout.session.completed', {
        id: 'cs_guest',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_guest',
        amount_total: 5000,
        currency: 'usd',
        customer: null,
        customer_details: { email: 'guest@example.com' },
        metadata: { kind: 'gift', fund_id: String(fund), person_id: '', donor_name: 'Guest Giver' },
      }),
    );
    expect(outcome).toEqual(processed('gift_recorded'));
    const rows = await giftRow('stripe_payment_intent_id', 'pi_guest');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      person_id: null,
      donor_name: 'Guest Giver',
      donor_email: 'guest@example.com',
      fund_id: fund,
      amount_cents: 5000,
      method: 'card',
      status: 'succeeded',
    });
  });

  it('one-time checkout for a member links the person and saves the Stripe customer', async () => {
    const outcome = await handleStripeEvent(
      { db, env: ENV },
      ev('checkout.session.completed', {
        id: 'cs_member',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_member',
        amount_total: 2500,
        currency: 'usd',
        customer: 'cus_member1',
        customer_details: { email: 'ben@example.com' },
        metadata: { kind: 'gift', fund_id: String(fund), person_id: '6', donor_name: 'Ben' },
      }),
    );
    expect(outcome).toEqual(processed('gift_recorded'));
    const rows = await giftRow('stripe_payment_intent_id', 'pi_member');
    expect(rows[0]).toMatchObject({ person_id: 6, amount_cents: 2500 });
    expect(await getStripeCustomer(db, 6)).toBe('cus_member1');
  });

  it('redelivery of the same checkout event inserts only one gift', async () => {
    const event = ev('checkout.session.completed', {
      id: 'cs_dup',
      mode: 'payment',
      payment_status: 'paid',
      payment_intent: 'pi_dup',
      amount_total: 1000,
      currency: 'usd',
      metadata: { kind: 'gift', fund_id: String(fund), person_id: '', donor_name: 'Dup' },
    });
    await handleStripeEvent({ db, env: ENV }, event);
    await handleStripeEvent({ db, env: ENV }, event); // Stripe re-sends
    expect(await giftRow('stripe_payment_intent_id', 'pi_dup')).toHaveLength(1);
  });

  // ── recurring ────────────────────────────────────────────────────────────────
  it('subscription checkout starts a recurring gift + saves the customer, no money row yet', async () => {
    const fetcher = subFetcher({ sub_100: subFixture('sub_100', fund, 10, 3000) });
    const outcome = await handleStripeEvent(
      { db, env: ENV, fetcher },
      ev('checkout.session.completed', {
        id: 'cs_sub',
        mode: 'subscription',
        subscription: 'sub_100',
        customer: 'cus_sub1',
        metadata: { kind: 'gift', fund_id: String(fund), person_id: '10' },
      }),
    );
    expect(outcome).toEqual(processed('recurring_started'));
    expect(await getRecurringBySubscription(db, 'sub_100')).toEqual({ person_id: 10, fund_id: fund });
    const [rec] = await sql.unsafe('SELECT amount_cents, "interval", status FROM recurring_gifts WHERE stripe_subscription_id = $1', ['sub_100']);
    expect(rec).toMatchObject({ amount_cents: 3000, interval: 'month', status: 'active' });
    expect(await getStripeCustomer(db, 10)).toBe('cus_sub1');
    // No card gift materializes from the checkout — money rows come from invoice.paid.
    expect(await giftRow('stripe_subscription_id', 'sub_100')).toHaveLength(0);
  });

  it('invoice.paid on a known subscription records the money row', async () => {
    const outcome = await handleStripeEvent(
      { db, env: ENV },
      ev('invoice.paid', {
        id: 'in_100',
        subscription: 'sub_100',
        payment_intent: 'pi_inv100',
        amount_paid: 3000,
        currency: 'usd',
        customer_email: 'zhao@example.com',
      }),
    );
    expect(outcome).toEqual(processed('gift_recorded'));
    const rows = await giftRow('stripe_invoice_id', 'in_100');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ person_id: 10, fund_id: fund, amount_cents: 3000, method: 'card', status: 'succeeded' });
  });

  it('records and deduplicates a current Basil subscription invoice without legacy top-level fields', async () => {
    const fetcher = subFetcher({ sub_basil: subFixture('sub_basil', fund, 3, 4500) });
    const event = ev('invoice.paid', {
      id: 'in_basil',
      amount_paid: 4500,
      currency: 'usd',
      customer_email: 'basil@example.com',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_basil' },
      },
      payments: {
        object: 'list',
        data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_basil' } }],
      },
    });

    expect(await handleStripeEvent({ db, env: ENV, fetcher }, event)).toEqual(processed('gift_recorded'));
    expect(await handleStripeEvent({ db, env: ENV, fetcher }, event)).toEqual(processed('gift_recorded'));
    const rows = await giftRow('stripe_invoice_id', 'in_basil');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      person_id: 3,
      fund_id: fund,
      amount_cents: 4500,
      stripe_subscription_id: 'sub_basil',
      stripe_payment_intent_id: 'pi_basil',
    });
  });

  it.each([
    ['multiple payment intents', {
      data: [
        { payment: { type: 'payment_intent', payment_intent: 'pi_multi_a' } },
        { payment: { type: 'payment_intent', payment_intent: 'pi_multi_b' } },
      ],
    }],
    ['no payment intent', { data: [{ payment: { type: 'charge', charge: 'ch_invoice' } }] }],
  ])('uses the invoice ID safely when a current invoice has %s', async (label, payments) => {
    const invoiceId = label === 'multiple payment intents' ? 'in_multi_pi' : 'in_no_pi';
    const event = ev('invoice.paid', {
      id: invoiceId,
      amount_paid: 3000,
      currency: 'usd',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_100' },
      },
      payments,
    });

    expect(await handleStripeEvent({ db, env: ENV }, event)).toEqual(processed('gift_recorded'));
    expect(await handleStripeEvent({ db, env: ENV }, event)).toEqual(processed('gift_recorded'));
    const rows = await giftRow('stripe_invoice_id', invoiceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].stripe_payment_intent_id).toBeNull();
  });

  it.each([
    ['legacy', { id: 'in_zero_legacy', subscription: 'sub_zero_legacy', payment_intent: 'pi_zero_legacy' }],
    ['current', {
      id: 'in_zero_current',
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_zero_current' } },
      payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_zero_current' } }] },
    }],
  ])('terminally ignores a %s paid invoice with zero amount and writes no gift', async (_shape, invoice) => {
    let fetches = 0;
    const fetcher = (async () => {
      fetches += 1;
      throw new Error('zero amount must not fetch or back-fill a subscription');
    }) as typeof fetch;
    expect(await handleStripeEvent({ db, env: ENV, fetcher }, ev('invoice.paid', {
      ...invoice,
      amount_paid: 0,
      currency: 'usd',
    }))).toEqual(ignored());
    expect(fetches).toBe(0);
    expect(await giftRow('stripe_invoice_id', String(invoice.id))).toHaveLength(0);
  });

  it('invoice.paid BEFORE checkout.completed (webhook race) retrieves + upserts the sub, then records the gift', async () => {
    const fetcher = subFetcher({ sub_200: subFixture('sub_200', fund, 3, 4000) });
    // No recurring row for sub_200 yet — the invoice arrived first.
    expect(await getRecurringBySubscription(db, 'sub_200')).toBeNull();
    const outcome = await handleStripeEvent(
      { db, env: ENV, fetcher },
      ev('invoice.paid', {
        id: 'in_200',
        subscription: 'sub_200',
        payment_intent: 'pi_inv200',
        amount_paid: 4000,
        currency: 'usd',
      }),
    );
    expect(outcome).toEqual(processed('gift_recorded'));
    // The race handler back-filled the subscription…
    expect(await getRecurringBySubscription(db, 'sub_200')).toEqual({ person_id: 3, fund_id: fund });
    // …and the money row landed.
    const rows = await giftRow('stripe_invoice_id', 'in_200');
    expect(rows[0]).toMatchObject({ person_id: 3, amount_cents: 4000 });
  });

  // ── refund ─────────────────────────────────────────────────────────────────
  it('a FULL charge.refunded flips the matching gift to refunded', async () => {
    const event = ev('charge.refunded', {
      id: 'ch_1', payment_intent: 'pi_guest', refunded: true, amount: 5000, amount_refunded: 5000,
      metadata: { kind: 'gift' },
    });
    const outcome = await handleStripeEvent({ db, env: ENV }, event);
    expect(outcome).toEqual(processed('refunded'));
    const [row] = await giftRow('stripe_payment_intent_id', 'pi_guest');
    expect(row.status).toBe('refunded');

    // The domain UPDATE may commit before inbox finalization. Replaying the same
    // claim must converge terminally instead of treating the applied refund as missing.
    expect(await handleStripeEvent({ db, env: ENV }, event)).toEqual(processed('refunded'));
  });

  it('a PARTIAL refund leaves the gift succeeded + counted; a FULL refund excludes it from totals', async () => {
    // A clean fund so fundTotals reflects only these two gifts.
    const rfund = await saveFund(db, { fund_number: 'W900', name_en: 'Refunds', name_zh: '退款', active: 1, sort: 9 });
    const mkGift = (pi: string, cents: number) =>
      handleStripeEvent(
        { db, env: ENV },
        ev('checkout.session.completed', {
          id: `cs_${pi}`, mode: 'payment', payment_status: 'paid', payment_intent: pi, amount_total: cents, currency: 'usd',
          metadata: { kind: 'gift', fund_id: String(rfund), person_id: '', donor_name: 'R' },
        }),
      );
    expect(await mkGift('pi_full', 1000)).toEqual(processed('gift_recorded'));
    expect(await mkGift('pi_partial', 1000)).toEqual(processed('gift_recorded'));

    // Full refund (Stripe's refunded:true) → the gift flips to 'refunded'.
    expect(
      await handleStripeEvent(
        { db, env: ENV },
        ev('charge.refunded', {
          id: 'ch_full', payment_intent: 'pi_full', refunded: true, amount: 1000, amount_refunded: 1000,
          metadata: { kind: 'gift' },
        }),
      ),
    ).toEqual(processed('refunded'));

    // Partial refund ($5 of $10) → NO flip: the gift stays 'succeeded' and keeps
    // its FULL amount in totals (a partial-refund ledger is out of scope).
    expect(
      await handleStripeEvent(
        { db, env: ENV },
        ev('charge.refunded', {
          id: 'ch_part', payment_intent: 'pi_partial', refunded: false, amount: 1000, amount_refunded: 500,
          metadata: { kind: 'gift' },
        }),
      ),
    ).toEqual(ignored());

    const [full] = await giftRow('stripe_payment_intent_id', 'pi_full');
    const [partial] = await giftRow('stripe_payment_intent_id', 'pi_partial');
    expect(full.status).toBe('refunded');
    expect(partial.status).toBe('succeeded');

    // fundTotals filters status='succeeded': the partially-refunded gift's whole
    // $10 counts; the fully-refunded gift is excluded entirely.
    const row = (await fundTotals(db, 'en', {})).find((t) => t.fund_id === rfund)!;
    expect(row.total_cents).toBe(1000);
    expect(row.gift_count).toBe(1);
  });

  // ── payment_status gate (only a settled session books a gift) ────────────────
  it('a completed payment session that is not paid records no gift; paid does', async () => {
    const mk = (pi: string, status: string) =>
      ev('checkout.session.completed', {
        id: `cs_${pi}`, mode: 'payment', payment_status: status, payment_intent: pi, amount_total: 1234, currency: 'usd',
        metadata: { kind: 'gift', fund_id: String(fund), person_id: '', donor_name: 'PS' },
      });
    expect(await handleStripeEvent({ db, env: ENV }, mk('pi_unpaid', 'unpaid'))).toEqual(ignored('awaiting_async_payment'));
    expect(await giftRow('stripe_payment_intent_id', 'pi_unpaid')).toHaveLength(0);

    expect(await handleStripeEvent({ db, env: ENV }, mk('pi_paid', 'paid'))).toEqual(processed('gift_recorded'));
    expect(await giftRow('stripe_payment_intent_id', 'pi_paid')).toHaveLength(1);
  });

  it('does not mutate Giving when only Registration is enabled', async () => {
    const event = ev('checkout.session.completed', {
      id: 'cs_giving_disabled', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_giving_disabled',
      amount_total: 1700, currency: 'usd',
      metadata: { kind: 'gift', fund_id: String(fund), person_id: '', donor_name: 'Disabled' },
    });
    expect(await dispatchStripeEvent({ db, env: ENV, modules: new Set(['registration']) }, event))
      .toEqual(ignored('module_disabled'));
    expect(await giftRow('stripe_payment_intent_id', 'pi_giving_disabled')).toHaveLength(0);
  });

  it.each(['payment_intent.succeeded', 'checkout.session.unsupported'])(
    'keeps unsupported %s terminally ignored even when metadata names a disabled module', async (type) => {
    expect(await dispatchStripeEvent(
      { db, env: ENV, modules: new Set(['registration']) },
      ev(type, { id: 'pi_unsupported_gift', metadata: { kind: 'gift' } }),
    )).toEqual(ignored());
  });

  it('checkpoints before a Stripe fetch and before each following domain write', async () => {
    let checkpoints = 0;
    const fetcher = subFetcher({ sub_checkpoint: subFixture('sub_checkpoint', fund, 10, 3300) });
    expect(await dispatchStripeEvent(
      { db, env: ENV, modules: ALL_MODULES, fetcher, checkpoint: async () => { checkpoints += 1; } },
      ev('checkout.session.completed', {
        id: 'cs_checkpoint', mode: 'subscription', subscription: 'sub_checkpoint', customer: 'cus_checkpoint',
        metadata: { kind: 'gift', fund_id: String(fund), person_id: '10' },
      }),
    )).toEqual(processed('recurring_started'));
    expect(checkpoints).toBe(3); // retrieveSubscription, upsertRecurringGift, setStripeCustomer
  });

  it('routes async payment success through paid gift fulfillment and ignores async failure', async () => {
    const base = {
      id: 'cs_async_gift', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_async_gift',
      amount_total: 2100, currency: 'usd',
      metadata: { kind: 'gift', fund_id: String(fund), person_id: '', donor_name: 'Async' },
    };
    expect(await handleStripeEvent({ db, env: ENV }, ev('checkout.session.async_payment_succeeded', base)))
      .toEqual(processed('gift_recorded'));
    expect(await giftRow('stripe_payment_intent_id', 'pi_async_gift')).toHaveLength(1);
    expect(await handleStripeEvent({ db, env: ENV }, ev('checkout.session.async_payment_failed', {
      ...base, id: 'cs_async_gift_failed', payment_intent: 'pi_async_gift_failed', payment_status: 'unpaid',
    }))).toEqual(ignored('awaiting_async_payment'));
    expect(await giftRow('stripe_payment_intent_id', 'pi_async_gift_failed')).toHaveLength(0);
  });

  it('defers an internal full refund whose gift row is not visible yet', async () => {
    expect(await handleStripeEvent({ db, env: ENV }, ev('charge.refunded', {
      id: 'ch_early_internal', payment_intent: 'pi_early_internal', refunded: true,
      amount: 3200, amount_refunded: 3200, metadata: { kind: 'gift' },
    }))).toEqual({ state: 'deferred', outcome: 'gift_not_visible' });
  });

  it('keeps foreign full refunds and internal partial refunds terminally ignored', async () => {
    expect(await handleStripeEvent({ db, env: ENV }, ev('charge.refunded', {
      id: 'ch_foreign', payment_intent: 'pi_foreign', refunded: true, amount: 1000, amount_refunded: 1000,
    }))).toEqual(ignored());
    expect(await handleStripeEvent({ db, env: ENV }, ev('charge.refunded', {
      id: 'ch_partial_internal', payment_intent: 'pi_partial_internal', refunded: false,
      amount: 1000, amount_refunded: 500, metadata: { kind: 'gift' },
    }))).toEqual(ignored());
  });

  // ── subscription lifecycle ───────────────────────────────────────────────────
  it('customer.subscription.updated syncs status (past_due), .deleted cancels', async () => {
    expect(
      await handleStripeEvent(
        { db, env: ENV },
        ev('customer.subscription.updated', { id: 'sub_100', status: 'past_due', metadata: { kind: 'gift' } }),
      ),
    ).toEqual(processed('status_synced'));
    let [rec] = await sql.unsafe('SELECT status FROM recurring_gifts WHERE stripe_subscription_id = $1', ['sub_100']);
    expect(rec.status).toBe('past_due');

    expect(
      await handleStripeEvent(
        { db, env: ENV },
        ev('customer.subscription.deleted', { id: 'sub_100', status: 'canceled', metadata: { kind: 'gift' } }),
      ),
    ).toEqual(processed('status_synced'));
    [rec] = await sql.unsafe('SELECT status FROM recurring_gifts WHERE stripe_subscription_id = $1', ['sub_100']);
    expect(rec.status).toBe('canceled');
  });

  // ── foreign / malformed traffic must be a no-op, never a throw ────────────────
  it("returns 'ignored' for foreign events and missing metadata", async () => {
    const cases: Record<string, unknown>[] = [
      ev('customer.created', { id: 'cus_x' }),
      ev('payment_intent.succeeded', { id: 'pi_x' }),
      ev('checkout.session.completed', { mode: 'payment', metadata: {} }), // no kind
      ev('checkout.session.completed', { mode: 'payment', metadata: { kind: 'other' } }), // foreign kind
      ev('invoice.paid', { id: 'in_none', amount_paid: 100 }), // no subscription
      ev('customer.subscription.updated', { id: 'sub_x', status: 'active' }), // no metadata.kind
      { type: 'checkout.session.completed' }, // no data at all
      {}, // no type at all
    ];
    for (const c of cases) {
      expect(await handleStripeEvent({ db, env: ENV }, c)).toEqual(ignored());
    }
  });
});

// ── isDbConnectivityError (pure, no DB — ungated on purpose) ───────────────────
// The webhook endpoint's 500-vs-200 fork: a transient connectivity failure must
// 500 so Stripe redelivers (money integrity — never silently drop an
// invoice.paid); everything else is a logic bug it logs and swallows as 200.
describe('isDbConnectivityError', () => {
  it('true for postgres.js client codes and socket errnos', () => {
    expect(isDbConnectivityError({ code: 'CONNECTION_CLOSED' })).toBe(true);
    expect(isDbConnectivityError({ code: 'CONNECT_TIMEOUT' })).toBe(true);
    expect(isDbConnectivityError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isDbConnectivityError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('true for Postgres transient SQLSTATEs (08*, 53*, 57P*, 40*)', () => {
    expect(isDbConnectivityError({ code: '08006' })).toBe(true); // connection_failure
    expect(isDbConnectivityError({ code: '08000' })).toBe(true); // connection_exception
    expect(isDbConnectivityError({ code: '53300' })).toBe(true); // too_many_connections
    expect(isDbConnectivityError({ code: '57P01' })).toBe(true); // admin_shutdown
    expect(isDbConnectivityError({ code: '57P03' })).toBe(true); // cannot_connect_now
    expect(isDbConnectivityError({ code: '40P01' })).toBe(true); // deadlock_detected
    expect(isDbConnectivityError({ code: '40001' })).toBe(true); // serialization_failure
  });

  it('false for logic errors: constraint SQLSTATEs, code-less errors, non-errors', () => {
    expect(isDbConnectivityError({ code: '23505' })).toBe(false); // unique_violation
    expect(isDbConnectivityError(new TypeError('x is not a function'))).toBe(false);
    expect(isDbConnectivityError(new Error('boom'))).toBe(false);
    expect(isDbConnectivityError({ code: undefined })).toBe(false);
    expect(isDbConnectivityError({})).toBe(false);
    expect(isDbConnectivityError(null)).toBe(false);
    expect(isDbConnectivityError(undefined)).toBe(false);
    expect(isDbConnectivityError('CONNECTION_CLOSED')).toBe(false); // string, not an error object
    expect(isDbConnectivityError({ code: 57 })).toBe(false); // numeric code is not a SQLSTATE
  });
});

// ── isRetryableWebhookError (pure, no DB — ungated on purpose) ─────────────────
// The endpoint's 500-vs-200 fork widened beyond DB connectivity: a failed Stripe
// API call (retrieveSubscription during the invoice-before-completed race) or a
// network error while processing a money event must retry, or the first month's
// gift is dropped. A definitive logic/constraint error still 200s so a real bug
// can't wedge an infinite retry loop.
describe('isRetryableWebhookError', () => {
  it('retries the genuine Stripe transport error emitted by a rejecting subscription fetch', async () => {
    const fetcher = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    let error: unknown;
    try {
      await retrieveSubscription(ENV, 'sub_test_transport', { fetcher });
      expect.unreachable('retrieveSubscription should reject');
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ name: 'StripeError', stage: 'transport' });
    expect(isRetryableWebhookError(error)).toBe(true);
  });

  it('true for a StripeError (numeric .status) — a failed Stripe API call', () => {
    const stripeErr = Object.assign(new Error('No such subscription'), { status: 404 });
    expect(isRetryableWebhookError(stripeErr)).toBe(true);
    expect(isRetryableWebhookError(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(true);
    expect(isRetryableWebhookError(Object.assign(new Error('stripe down'), { status: 500 }))).toBe(true);
  });

  it('true for a transient DB failure (delegates to isDbConnectivityError)', () => {
    expect(isRetryableWebhookError({ code: 'CONNECTION_CLOSED' })).toBe(true);
    expect(isRetryableWebhookError({ code: '08006' })).toBe(true);
    expect(isRetryableWebhookError({ code: '40P01' })).toBe(true);
  });

  it('true for a network/fetch failure with the socket errno nested on .cause', () => {
    const netErr = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(isRetryableWebhookError(netErr)).toBe(true);
  });

  it('false for definitive logic/constraint errors (200 so no infinite retry)', () => {
    expect(isRetryableWebhookError({ code: '23505' })).toBe(false); // unique_violation
    expect(isRetryableWebhookError({ code: '23503' })).toBe(false); // foreign_key_violation
    expect(isRetryableWebhookError(new TypeError('x is not a function'))).toBe(false);
    expect(isRetryableWebhookError(new Error('boom'))).toBe(false);
    expect(isRetryableWebhookError({ stage: 'transport' })).toBe(false); // only nominal Stripe transport errors retry
    expect(isRetryableWebhookError(new StripeError('bad config', { stage: 'configuration' }))).toBe(false);
    expect(isRetryableWebhookError(new StripeError('bad response', { stage: 'response' }))).toBe(false);
    expect(isRetryableWebhookError(null)).toBe(false);
    expect(isRetryableWebhookError(undefined)).toBe(false);
    // A non-numeric status is not a StripeError signal.
    expect(isRetryableWebhookError({ status: '500' })).toBe(false);
  });
});
