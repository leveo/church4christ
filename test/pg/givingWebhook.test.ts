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
import { getStripeCustomer, getRecurringBySubscription } from '../../src/lib/givingDb';
import { handleStripeEvent, isDbConnectivityError } from '../../src/lib/givingWebhook';
import type { StripeEnv } from '../../src/lib/stripe';

const ENV: StripeEnv = { STRIPE_SECRET_KEY: 'sk_test_x', APP_ORIGIN: 'https://church.example' };

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

const ev = (type: string, object: Record<string, unknown>): Record<string, unknown> => ({ type, data: { object } });

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
        payment_intent: 'pi_guest',
        amount_total: 5000,
        currency: 'usd',
        customer: null,
        customer_details: { email: 'guest@example.com' },
        metadata: { kind: 'gift', fund_id: String(fund), person_id: '', donor_name: 'Guest Giver' },
      }),
    );
    expect(outcome).toBe('gift_recorded');
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
        payment_intent: 'pi_member',
        amount_total: 2500,
        currency: 'usd',
        customer: 'cus_member1',
        customer_details: { email: 'ben@example.com' },
        metadata: { kind: 'gift', fund_id: String(fund), person_id: '6', donor_name: 'Ben' },
      }),
    );
    expect(outcome).toBe('gift_recorded');
    const rows = await giftRow('stripe_payment_intent_id', 'pi_member');
    expect(rows[0]).toMatchObject({ person_id: 6, amount_cents: 2500 });
    expect(await getStripeCustomer(db, 6)).toBe('cus_member1');
  });

  it('redelivery of the same checkout event inserts only one gift', async () => {
    const event = ev('checkout.session.completed', {
      id: 'cs_dup',
      mode: 'payment',
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
    expect(outcome).toBe('recurring_started');
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
    expect(outcome).toBe('gift_recorded');
    const rows = await giftRow('stripe_invoice_id', 'in_100');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ person_id: 10, fund_id: fund, amount_cents: 3000, method: 'card', status: 'succeeded' });
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
    expect(outcome).toBe('gift_recorded');
    // The race handler back-filled the subscription…
    expect(await getRecurringBySubscription(db, 'sub_200')).toEqual({ person_id: 3, fund_id: fund });
    // …and the money row landed.
    const rows = await giftRow('stripe_invoice_id', 'in_200');
    expect(rows[0]).toMatchObject({ person_id: 3, amount_cents: 4000 });
  });

  // ── refund ─────────────────────────────────────────────────────────────────
  it('charge.refunded flips the matching gift to refunded', async () => {
    const outcome = await handleStripeEvent(
      { db, env: ENV },
      ev('charge.refunded', { id: 'ch_1', payment_intent: 'pi_guest' }),
    );
    expect(outcome).toBe('refunded');
    const [row] = await giftRow('stripe_payment_intent_id', 'pi_guest');
    expect(row.status).toBe('refunded');
  });

  // ── subscription lifecycle ───────────────────────────────────────────────────
  it('customer.subscription.updated syncs status (past_due), .deleted cancels', async () => {
    expect(
      await handleStripeEvent(
        { db, env: ENV },
        ev('customer.subscription.updated', { id: 'sub_100', status: 'past_due', metadata: { kind: 'gift' } }),
      ),
    ).toBe('status_synced');
    let [rec] = await sql.unsafe('SELECT status FROM recurring_gifts WHERE stripe_subscription_id = $1', ['sub_100']);
    expect(rec.status).toBe('past_due');

    expect(
      await handleStripeEvent(
        { db, env: ENV },
        ev('customer.subscription.deleted', { id: 'sub_100', status: 'canceled', metadata: { kind: 'gift' } }),
      ),
    ).toBe('status_synced');
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
      expect(await handleStripeEvent({ db, env: ENV }, c)).toBe('ignored');
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

  it('true for Postgres connection-class SQLSTATEs (08*, 53*, 57P*)', () => {
    expect(isDbConnectivityError({ code: '08006' })).toBe(true); // connection_failure
    expect(isDbConnectivityError({ code: '08000' })).toBe(true); // connection_exception
    expect(isDbConnectivityError({ code: '53300' })).toBe(true); // too_many_connections
    expect(isDbConnectivityError({ code: '57P01' })).toBe(true); // admin_shutdown
    expect(isDbConnectivityError({ code: '57P03' })).toBe(true); // cannot_connect_now
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
