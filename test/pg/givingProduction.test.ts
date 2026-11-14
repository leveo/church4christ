// Production Giving against real Postgres: live/test mode separation in the webhook,
// ACH pending -> settled/failed, refunds and disputes attributed by the database,
// subscription sync, campus handling, Stripe-time year bucketing, annual statement
// totals, and the durable statement outbox. Stripe and email are faked (injected
// fetchers, a mocked sendEmail); nothing here proves live Stripe delivery.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

// sendEmail imports the Workers-only `cloudflare:email`; the outbox only needs its contract.
const sendEmailMock = vi.fn(async (..._args: unknown[]) => true);
vi.mock('../../src/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
  escapeHtml: (value: string) => value,
}));

import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { scopeDatabase } from '../../src/lib/campusScope';
import type { AppDb } from '../../src/lib/appDb';
import { saveFund } from '../../src/lib/fundDb';
import {
  fundTotals,
  getStripeCustomer,
  insertCardGift,
  listGiftsForExport,
  listStatementRecipients,
  recordManualGift,
  statementTotals,
  statementYears,
  householdYearTotals,
  personYearTotals,
} from '../../src/lib/givingDb';
import { handleStripeEvent as dispatch, type WebhookDeps } from '../../src/lib/givingWebhook';
import {
  drainStatementOutbox,
  enqueueStatementBatch,
  listStatementBatches,
  STATEMENT_MAX_ATTEMPTS,
  statementBackoffMinutes,
} from '../../src/lib/givingStatements';
import { buildGiftsCsv } from '../../src/lib/givingExport';
import type { StripeEnv } from '../../src/lib/stripe';
import { stripeEvent } from '../stripeFixtures';

const TEST_ENV: StripeEnv = { STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_x', APP_ORIGIN: 'https://church.example' };
const LIVE_ENV: StripeEnv = {
  STRIPE_MODE: 'live',
  STRIPE_SECRET_KEY: 'sk_live_x',
  STRIPE_LIVE_CONFIRMED: '1',
  APP_ORIGIN: 'https://church.example',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A Stripe fetcher driven by a URL -> body map; anything unmapped is an empty list. */
function stripeFetcher(routes: Array<[RegExp, unknown]> = []): { fetcher: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    for (const [re, body] of routes) if (re.test(u)) return json(body);
    return json({ object: 'list', data: [] });
  }) as unknown as typeof fetch;
  return { fetcher, urls };
}

const MODULES = new Set(['giving', 'registration'] as const);
const processed = (outcome: string) => ({ state: 'processed', outcome });
const ignored = (outcome = 'ignored') => ({ state: 'ignored', outcome });

// 2027-01-01 05:30:00Z is Dec 31 2026 23:30 in America/Chicago (CST, UTC-6).
const NEW_YEARS_EVE_2026_2330_CT = Date.UTC(2027, 0, 1, 5, 30, 0) / 1000;
// 2027-01-01 07:00:00Z is Jan 1 2027 01:00 Central.
const NEW_YEARS_DAY_2027_0100_CT = Date.UTC(2027, 0, 1, 7, 0, 0) / 1000;

describe.skipIf(!hasPg)('production Giving (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;
  let fund: number;
  let eastFund: number;
  let nonDeductibleFund: number;
  let seq = 0;

  const run = (script: string) =>
    execFileSync('node', [`scripts/db/${script}`], { env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8' });
  const handle = (deps: Omit<WebhookDeps, 'modules'>, event: Record<string, unknown>) =>
    dispatch({ ...deps, modules: MODULES }, event);
  const gift = async (col: string, val: string) => (await sql.unsafe(`SELECT * FROM gifts WHERE ${col} = $1`, [val]))[0];
  const uid = (prefix: string) => `${prefix}_${++seq}_${Math.random().toString(36).slice(2, 8)}`;

  /** A paid one-time Checkout session event for the live-or-test fixtures. */
  const sessionEvent = (
    over: { type?: string; status?: string; pi: string; amount?: number; fundId?: number; personId?: string; created?: number; livemode?: boolean; meta?: Record<string, string>; customer?: string | null },
  ) => stripeEvent(
    over.type ?? 'checkout.session.completed',
    {
      id: uid('cs'),
      mode: 'payment',
      payment_status: over.status ?? 'paid',
      payment_intent: over.pi,
      amount_total: over.amount ?? 5000,
      currency: 'usd',
      customer: over.customer ?? null,
      customer_details: { email: 'donor@example.com' },
      metadata: { kind: 'gift', fund_id: String(over.fundId ?? fund), person_id: over.personId ?? '', donor_name: 'Donor', ...over.meta },
    },
    { id: uid('evt'), created: over.created ?? 1_700_000_000, livemode: over.livemode ?? false },
  );

  beforeAll(async () => {
    await resetSchema(sql);
    run('migrate-supabase.mjs');
    run('seed-supabase.mjs');
    db = new PgAdapter(sql);
    await sql.unsafe("INSERT INTO campuses(id,slug,name) VALUES(2,'east','East Campus')");
    fund = await saveFund(db, { fund_number: 'P100', name_en: 'General', name_zh: '总奉献', active: 1, sort: 1 });
    nonDeductibleFund = await saveFund(db, { fund_number: 'P200', name_en: 'Benevolence', name_zh: '互助', active: 1, sort: 2, tax_deductible: false });
    eastFund = await saveFund(scopeDatabase(db, 2), { fund_number: 'E100', name_en: 'East General', name_zh: '东堂', active: 1, sort: 1 });
  });
  afterAll(async () => {
    await sql?.end();
  });
  beforeEach(() => sendEmailMock.mockClear());

  // ── mode separation ────────────────────────────────────────────────────────
  describe('livemode must equal the configured mode', () => {
    it('ignores a live event under test mode and a test event under live mode, writing nothing', async () => {
      const liveEvent = sessionEvent({ pi: 'pi_mode_live_in_test', livemode: true });
      const testEvent = sessionEvent({ pi: 'pi_mode_test_in_live', livemode: false });
      expect(await handle({ db, env: TEST_ENV }, liveEvent)).toEqual(ignored('livemode_mismatch'));
      expect(await handle({ db, env: LIVE_ENV }, testEvent)).toEqual(ignored('livemode_mismatch'));
      expect(await gift('stripe_payment_intent_id', 'pi_mode_live_in_test')).toBeUndefined();
      expect(await gift('stripe_payment_intent_id', 'pi_mode_test_in_live')).toBeUndefined();
    });

    it('records a live gift with livemode=true and keeps its Stripe customer per mode', async () => {
      const event = sessionEvent({ pi: 'pi_live_ok', livemode: true, personId: '6', customer: 'cus_live_6' });
      expect(await handle({ db, env: LIVE_ENV }, event)).toEqual(processed('gift_recorded'));
      expect(await gift('stripe_payment_intent_id', 'pi_live_ok')).toMatchObject({ livemode: true, status: 'succeeded', person_id: 6 });
      expect(await getStripeCustomer(db, 6, true)).toBe('cus_live_6');
      expect(await getStripeCustomer(db, 6, false)).not.toBe('cus_live_6');
      const testEvent = sessionEvent({ pi: 'pi_test_ok', personId: '6', customer: 'cus_test_6' });
      expect(await handle({ db, env: TEST_ENV }, testEvent)).toEqual(processed('gift_recorded'));
      expect(await gift('stripe_payment_intent_id', 'pi_test_ok')).toMatchObject({ livemode: false });
      expect(await getStripeCustomer(db, 6, false)).toBe('cus_test_6');
    });
  });

  // ── ACH ───────────────────────────────────────────────────────────────────────
  describe('ACH (us_bank_account) asynchronous payments', () => {
    it('books pending on completion, settles on async success with the Stripe time, and is idempotent', async () => {
      const pi = 'pi_ach_ok';
      const unpaid = sessionEvent({ pi, status: 'unpaid', livemode: true, created: 1_800_000_000 });
      expect(await handle({ db, env: LIVE_ENV }, unpaid)).toEqual(processed('gift_pending'));
      expect(await gift('stripe_payment_intent_id', pi)).toMatchObject({ status: 'pending', method: 'us_bank_account', paid_at: null, livemode: true });

      // Settlement arrives three days later; paid_at is that event's time, not "now".
      const settled = sessionEvent({ pi, type: 'checkout.session.async_payment_succeeded', livemode: true, created: 1_800_000_000 + 3 * 86_400 });
      expect(await handle({ db, env: LIVE_ENV }, settled)).toEqual(processed('gift_recorded'));
      const row = await gift('stripe_payment_intent_id', pi);
      expect(row).toMatchObject({ status: 'succeeded', method: 'us_bank_account' });
      expect(row.paid_at).toBe(new Date((1_800_000_000 + 3 * 86_400) * 1000).toISOString().slice(0, 19).replace('T', ' '));

      // Redelivering either event never duplicates or downgrades the settled gift.
      await handle({ db, env: LIVE_ENV }, unpaid);
      await handle({ db, env: LIVE_ENV }, settled);
      expect(await sql.unsafe('SELECT status FROM gifts WHERE stripe_payment_intent_id = $1', [pi])).toEqual([{ status: 'succeeded' }]);
    });

    it('a pending ACH gift never counts, and async failure ends it as failed', async () => {
      const pi = 'pi_ach_fail';
      const total2023 = async () => (await statementTotals(db, 'en', { personId: 6, household: false }, 2023)).reduce((sum, l) => sum + l.total_cents, 0);
      const before = await total2023();
      await handle({ db, env: LIVE_ENV }, sessionEvent({ pi, status: 'unpaid', livemode: true, personId: '6', amount: 7777 }));
      let row = await gift('stripe_payment_intent_id', pi);
      expect(await total2023()).toBe(before); // pending money is not counted
      expect(row.status).toBe('pending');

      expect(await handle({ db, env: LIVE_ENV }, sessionEvent({ pi, type: 'checkout.session.async_payment_failed', status: 'unpaid', livemode: true, personId: '6', amount: 7777 })))
        .toEqual(processed('gift_failed'));
      row = await gift('stripe_payment_intent_id', pi);
      expect(row.status).toBe('failed');
      expect(row.paid_at).toBeNull();
    });

    it('charge.failed (a bank return after recording) fails an ACH gift but never a card gift', async () => {
      const achPi = 'pi_ach_return';
      await handle({ db, env: LIVE_ENV }, sessionEvent({ pi: achPi, type: 'checkout.session.async_payment_succeeded', livemode: true }));
      expect((await gift('stripe_payment_intent_id', achPi)).status).toBe('succeeded');
      expect(await handle({ db, env: LIVE_ENV }, stripeEvent('charge.failed', { id: 'ch_ach_return', payment_intent: achPi }, { livemode: true, id: uid('evt') })))
        .toEqual(processed('gift_failed'));
      expect((await gift('stripe_payment_intent_id', achPi)).status).toBe('failed');

      const cardPi = 'pi_card_not_failed';
      await handle({ db, env: LIVE_ENV }, sessionEvent({ pi: cardPi, livemode: true }));
      expect(await handle({ db, env: LIVE_ENV }, stripeEvent('charge.failed', { id: 'ch_card', payment_intent: cardPi }, { livemode: true, id: uid('evt') })))
        .toEqual(ignored());
      expect((await gift('stripe_payment_intent_id', cardPi)).status).toBe('succeeded');
    });
  });

  // ── paid_at and year bucketing ──────────────────────────────────────────────
  describe('paid_at comes from Stripe and buckets in the church time zone', () => {
    it('Dec 31 23:30 Central counts in that year; Jan 1 01:00 Central in the next', async () => {
      // person 8 is household-less: isolate the rollup from other tests' gifts.
      await sql.unsafe('DELETE FROM gifts WHERE person_id = 8');
      await handle({ db, env: LIVE_ENV }, sessionEvent({ pi: 'pi_nye', livemode: true, personId: '8', amount: 1000, created: NEW_YEARS_EVE_2026_2330_CT }));
      await handle({ db, env: LIVE_ENV }, sessionEvent({ pi: 'pi_nyd', livemode: true, personId: '8', amount: 2000, created: NEW_YEARS_DAY_2027_0100_CT }));
      expect((await gift('stripe_payment_intent_id', 'pi_nye')).paid_at).toBe('2027-01-01 05:30:00'); // stored in UTC

      const y2026 = await statementTotals(db, 'en', { personId: 8, household: false }, 2026);
      const y2027 = await statementTotals(db, 'en', { personId: 8, household: false }, 2027);
      expect(y2026.map((l) => l.total_cents)).toEqual([1000]);
      expect(y2027.map((l) => l.total_cents)).toEqual([2000]);
      expect(await statementYears(db, { personId: 8, household: false })).toEqual([2027, 2026]);
      // The /my/giving year rollup uses the very same rule.
      const totals = await personYearTotals(db, 8);
      expect(Object.fromEntries(totals.map((t) => [t.year, t.total_cents]))).toEqual({ '2026': 1000, '2027': 2000 });
    });

    it('a manual gift buckets on received_on, not on insert time', async () => {
      const id = await recordManualGift(db, { personId: 5, fundId: fund, amountCents: 4200, method: 'check', checkNumber: '7', receivedOn: '2024-12-31', recordedBy: 1, currency: 'usd' });
      const [row] = await sql.unsafe('SELECT livemode FROM gifts WHERE id = $1', [id]);
      expect(row.livemode).toBe(true); // manual gifts are real money
      expect((await statementTotals(db, 'en', { personId: 5, household: false }, 2024)).map((l) => l.total_cents)).toEqual([4200]);
    });
  });

  // ── refunds and disputes, attributed by the database ─────────────────────────
  describe('refunds and disputes', () => {
    it('attributes a refund on a subscription charge via charge.invoice (pre-Basil) and backfills the PI', async () => {
      await sql.unsafe(`INSERT INTO recurring_gifts (person_id, fund_id, amount_cents, currency, "interval", stripe_subscription_id, status, livemode)
        VALUES (3, $1, 3000, 'usd', 'month', 'sub_refund_legacy', 'active', true)`, [fund]);
      await handle({ db, env: LIVE_ENV }, stripeEvent('invoice.paid', {
        id: 'in_legacy', subscription: 'sub_refund_legacy', payment_intent: 'pi_legacy_inv', amount_paid: 3000, currency: 'usd',
      }, { livemode: true, id: uid('evt'), created: 1_800_000_000 }));
      expect(await handle({ db, env: LIVE_ENV }, stripeEvent('charge.refunded', {
        id: 'ch_legacy', payment_intent: 'pi_other', invoice: 'in_legacy', refunded: false, amount: 3000, amount_refunded: 1000,
      }, { livemode: true, id: uid('evt') }))).toEqual(processed('partial_refund'));
      const row = await gift('stripe_invoice_id', 'in_legacy');
      expect(row).toMatchObject({ refunded_cents: 1000, status: 'succeeded', stripe_charge_id: 'ch_legacy' });
    });

    it('attributes a Basil refund through the invoice-payments lookup and backfills the PaymentIntent', async () => {
      await sql.unsafe(`INSERT INTO recurring_gifts (person_id, fund_id, amount_cents, currency, "interval", stripe_subscription_id, status, livemode)
        VALUES (3, $1, 2000, 'usd', 'month', 'sub_refund_basil', 'active', true)`, [fund]);
      // Basil invoice.paid has no payment_intent; the expand fetch learns it.
      const { fetcher, urls } = stripeFetcher([[/invoices\/in_basil_refund/, {
        id: 'in_basil_refund',
        payments: { data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_basil_refund' } }] },
      }]]);
      expect(await handle({ db, env: LIVE_ENV, fetcher }, stripeEvent('invoice.paid', {
        id: 'in_basil_refund', amount_paid: 2000, currency: 'usd',
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_refund_basil' } },
        status_transitions: { paid_at: 1_800_000_000 },
      }, { livemode: true, id: uid('evt') }))).toEqual(processed('gift_recorded'));
      expect(urls.some((u) => u.includes('/v1/invoices/in_basil_refund') && u.includes('expand'))).toBe(true);
      expect(await gift('stripe_invoice_id', 'in_basil_refund')).toMatchObject({
        stripe_payment_intent_id: 'pi_basil_refund', paid_at: '2027-01-15 08:00:00',
      });

      // A second gift whose PI was never backfilled: the refund resolves it by the invoice-payments lookup.
      await sql.unsafe(`INSERT INTO gifts (person_id, fund_id, amount_cents, currency, method, status, stripe_invoice_id, stripe_subscription_id, livemode, paid_at)
        VALUES (3, $1, 2000, 'usd', 'card', 'succeeded', 'in_basil_two', 'sub_refund_basil', true, '2027-02-01 00:00:00')`, [fund]);
      const lookup = stripeFetcher([[/invoice_payments/, { object: 'list', data: [{ invoice: 'in_basil_two' }] }]]);
      expect(await handle({ db, env: LIVE_ENV, fetcher: lookup.fetcher }, stripeEvent('charge.refunded', {
        id: 'ch_basil_two', payment_intent: 'pi_basil_two', refunded: true, amount: 2000, amount_refunded: 2000,
      }, { livemode: true, id: uid('evt') }))).toEqual(processed('refunded'));
      expect(lookup.urls.some((u) => u.includes('/v1/invoice_payments') && u.includes('pi_basil_two'))).toBe(true);
      expect(await gift('stripe_invoice_id', 'in_basil_two')).toMatchObject({
        status: 'refunded', refunded_cents: 2000, stripe_payment_intent_id: 'pi_basil_two',
      });
    });

    it('partial then full refunds keep refunded_cents monotonic and flip to refunded only when full', async () => {
      await handle({ db, env: LIVE_ENV }, sessionEvent({ pi: 'pi_part_full', livemode: true, amount: 10_000 }));
      const refund = (cents: number, full: boolean) => handle({ db, env: LIVE_ENV }, stripeEvent('charge.refunded', {
        id: 'ch_pf', payment_intent: 'pi_part_full', refunded: full, amount: 10_000, amount_refunded: cents,
      }, { livemode: true, id: uid('evt') }));
      expect(await refund(2500, false)).toEqual(processed('partial_refund'));
      expect(await gift('stripe_payment_intent_id', 'pi_part_full')).toMatchObject({ status: 'succeeded', refunded_cents: 2500 });
      // An older, smaller event delivered late must not lower the amount.
      expect(await refund(1000, false)).toEqual(processed('partial_refund'));
      expect((await gift('stripe_payment_intent_id', 'pi_part_full')).refunded_cents).toBe(2500);
      expect(await refund(10_000, true)).toEqual(processed('refunded'));
      expect(await gift('stripe_payment_intent_id', 'pi_part_full')).toMatchObject({ status: 'refunded', refunded_cents: 10_000 });
    });

    it('dispute lifecycle: created -> disputed; closed won -> succeeded; closed lost stays disputed', async () => {
      await handle({ db, env: LIVE_ENV }, sessionEvent({ pi: 'pi_dispute_won', livemode: true, personId: '5', amount: 3000 }));
      await handle({ db, env: LIVE_ENV }, sessionEvent({ pi: 'pi_dispute_lost', livemode: true, personId: '5', amount: 4000 }));
      const dispute = (type: string, pi: string, status: string) => handle({ db, env: LIVE_ENV }, stripeEvent(type, {
        id: `dp_${pi}`, charge: `ch_${pi}`, payment_intent: pi, status,
      }, { livemode: true, id: uid('evt') }));

      expect(await dispute('charge.dispute.created', 'pi_dispute_won', 'needs_response')).toEqual(processed('disputed'));
      expect(await dispute('charge.dispute.created', 'pi_dispute_lost', 'needs_response')).toEqual(processed('disputed'));
      expect(await gift('stripe_payment_intent_id', 'pi_dispute_won')).toMatchObject({ status: 'disputed', stripe_charge_id: 'ch_pi_dispute_won' });
      // Disputed money is excluded from statements while the dispute is open.
      const during = (await statementTotals(db, 'en', { personId: 5, household: false }, 2023)).reduce((sum, l) => sum + l.total_cents, 0);

      expect(await dispute('charge.dispute.closed', 'pi_dispute_won', 'won')).toEqual(processed('dispute_won'));
      expect(await dispute('charge.dispute.closed', 'pi_dispute_lost', 'lost')).toEqual(processed('dispute_lost'));
      expect((await gift('stripe_payment_intent_id', 'pi_dispute_won')).status).toBe('succeeded');
      expect((await gift('stripe_payment_intent_id', 'pi_dispute_lost')).status).toBe('disputed');
      // The won dispute returns to the totals; the lost one never does (both are 2023 Stripe gifts).
      const after = (await statementTotals(db, 'en', { personId: 5, household: false }, 2023)).reduce((sum, l) => sum + l.total_cents, 0);
      expect(during).toBe(0);
      expect(after).toBe(3000);
    });
  });

  // ── subscriptions ─────────────────────────────────────────────────────────────
  describe('recurring giving', () => {
    const subObject = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      status: 'active',
      customer: 'cus_sub',
      metadata: { kind: 'gift', fund_id: String(fund), person_id: '10', campus_id: '1', livemode: 'true' },
      items: { data: [{ price: { unit_amount: 2500, currency: 'usd', recurring: { interval: 'month' } } }] },
      ...over,
    });

    it('customer.subscription.updated syncs amount, interval, fund, and status from the Billing Portal change', async () => {
      await sql.unsafe(`INSERT INTO recurring_gifts (person_id, fund_id, amount_cents, currency, "interval", stripe_subscription_id, status, livemode)
        VALUES (10, $1, 2500, 'usd', 'month', 'sub_sync', 'active', true)`, [fund]);
      const updated = subObject('sub_sync', {
        status: 'past_due',
        metadata: { kind: 'gift', fund_id: String(nonDeductibleFund), person_id: '10', campus_id: '1' },
        items: { data: [{ price: { unit_amount: 12_000, currency: 'usd', recurring: { interval: 'year' } } }] },
      });
      expect(await handle({ db, env: LIVE_ENV }, stripeEvent('customer.subscription.updated', updated, { livemode: true, id: uid('evt') })))
        .toEqual(processed('subscription_synced'));
      const [row] = await sql.unsafe('SELECT amount_cents, "interval", fund_id, status FROM recurring_gifts WHERE stripe_subscription_id = $1', ['sub_sync']);
      expect(row).toMatchObject({ amount_cents: 12_000, interval: 'year', fund_id: nonDeductibleFund, status: 'past_due' });
    });

    it('an updated subscription with an unmapped status keeps the stored status, and an unsupported interval falls back to status-only', async () => {
      await sql.unsafe(`INSERT INTO recurring_gifts (person_id, fund_id, amount_cents, currency, "interval", stripe_subscription_id, status, livemode)
        VALUES (10, $1, 2500, 'usd', 'month', 'sub_keep', 'past_due', true)`, [fund]);
      await handle({ db, env: LIVE_ENV }, stripeEvent('customer.subscription.updated', subObject('sub_keep', { status: 'trialing' }), { livemode: true, id: uid('evt') }));
      expect((await sql.unsafe('SELECT status FROM recurring_gifts WHERE stripe_subscription_id = $1', ['sub_keep']))[0].status).toBe('past_due');

      const daily = subObject('sub_keep', {
        status: 'active',
        items: { data: [{ price: { unit_amount: 100, currency: 'usd', recurring: { interval: 'day' } } }] },
      });
      expect(await handle({ db, env: LIVE_ENV }, stripeEvent('customer.subscription.updated', daily, { livemode: true, id: uid('evt') })))
        .toEqual(processed('status_synced'));
      expect(await sql.unsafe('SELECT amount_cents, status FROM recurring_gifts WHERE stripe_subscription_id = $1', ['sub_keep']))
        .toEqual([{ amount_cents: 2500, status: 'active' }]);
    });

    it('creates a missing recurring row from an updated event, with the live flag and campus', async () => {
      expect(await handle({ db, env: LIVE_ENV }, stripeEvent('customer.subscription.updated', subObject('sub_created_by_update'), { livemode: true, id: uid('evt') })))
        .toEqual(processed('subscription_synced'));
      expect((await sql.unsafe('SELECT livemode, campus_id FROM recurring_gifts WHERE stripe_subscription_id = $1', ['sub_created_by_update']))[0])
        .toEqual({ livemode: true, campus_id: 1 });
    });

    it('invoice.payment_failed marks past_due with NO donor email; a canceled subscription stays canceled', async () => {
      await sql.unsafe(`INSERT INTO recurring_gifts (person_id, fund_id, amount_cents, currency, "interval", stripe_subscription_id, status, livemode)
        VALUES (10, $1, 2500, 'usd', 'month', 'sub_failed', 'active', true), (10, $1, 2500, 'usd', 'month', 'sub_gone', 'canceled', true)`, [fund]);
      const [{ n: emailsBefore }] = await sql.unsafe('SELECT count(*)::int AS n FROM email_log');
      const failed = (sub: string) => handle({ db, env: LIVE_ENV }, stripeEvent('invoice.payment_failed', {
        id: uid('in'), amount_due: 2500,
        parent: { type: 'subscription_details', subscription_details: { subscription: sub } },
      }, { livemode: true, id: uid('evt') }));
      expect(await failed('sub_failed')).toEqual(processed('recurring_past_due'));
      expect(await failed('sub_gone')).toEqual(ignored('recurring_not_active'));
      expect((await sql.unsafe('SELECT status FROM recurring_gifts WHERE stripe_subscription_id = $1', ['sub_failed']))[0].status).toBe('past_due');
      expect((await sql.unsafe('SELECT status FROM recurring_gifts WHERE stripe_subscription_id = $1', ['sub_gone']))[0].status).toBe('canceled');
      // Stripe's dunning emails the donor; this app sends nothing.
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect((await sql.unsafe('SELECT count(*)::int AS n FROM email_log'))[0].n).toBe(emailsBefore);
    });
  });

  // ── campus ────────────────────────────────────────────────────────────────────
  describe('campus_id from metadata is validated and honored', () => {
    it('writes the gift to the metadata campus when it matches the fund', async () => {
      expect(await handle({ db, env: LIVE_ENV }, sessionEvent({ pi: 'pi_east', livemode: true, fundId: eastFund, meta: { campus_id: '2' } })))
        .toEqual(processed('gift_recorded'));
      expect((await gift('stripe_payment_intent_id', 'pi_east')).campus_id).toBe(2);
    });

    it('rejects a campus that disagrees with the fund, and inherits the fund campus when absent (legacy sessions)', async () => {
      expect(await handle({ db, env: LIVE_ENV }, sessionEvent({ pi: 'pi_east_bad', livemode: true, fundId: eastFund, meta: { campus_id: '1' } })))
        .toEqual(ignored('campus_mismatch'));
      expect(await gift('stripe_payment_intent_id', 'pi_east_bad')).toBeUndefined();
      expect(await handle({ db, env: LIVE_ENV }, sessionEvent({ pi: 'pi_east_legacy', livemode: true, fundId: eastFund })))
        .toEqual(processed('gift_recorded'));
      expect((await gift('stripe_payment_intent_id', 'pi_east_legacy')).campus_id).toBe(2);
      expect(await handle({ db, env: LIVE_ENV }, sessionEvent({ pi: 'pi_nan', livemode: true, meta: { campus_id: 'abc' } })))
        .toEqual(ignored('campus_mismatch'));
    });
  });

  // ── statement totals ──────────────────────────────────────────────────────────
  describe('statement totals', () => {
    const YEAR = 2031;
    const seedGift = (over: Record<string, unknown>) => sql.unsafe(
      `INSERT INTO gifts (person_id, fund_id, amount_cents, currency, method, status, livemode, paid_at, refunded_cents, received_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [over.person ?? 9, over.fund ?? fund, over.amount ?? 1000, over.currency ?? 'usd', over.method ?? 'card',
        over.status ?? 'succeeded', over.live ?? true, over.paidAt ?? `${YEAR}-06-15 18:00:00`, over.refunded ?? 0, over.receivedOn ?? null] as never,
    );

    it('is live, succeeded, deductible, and net of refunds, grouped by fund and currency; excludes the rest', async () => {
      await sql.unsafe('DELETE FROM gifts WHERE person_id IN (4, 9)');
      await seedGift({ amount: 10_000, refunded: 2_500 });                       // net 7,500 in General
      await seedGift({ amount: 3_000, person: 4, receivedOn: `${YEAR}-03-01`, method: 'check', paidAt: null }); // manual counts as live
      await seedGift({ amount: 5_000, fund: nonDeductibleFund });                // non-deductible fund
      await seedGift({ amount: 6_000, live: false });                            // Stripe test mode
      await seedGift({ amount: 7_000, status: 'pending' });
      await seedGift({ amount: 8_000, status: 'failed' });
      await seedGift({ amount: 9_000, status: 'disputed' });
      await seedGift({ amount: 1_100, status: 'refunded', refunded: 1_100 });
      await seedGift({ amount: 4_000, currency: 'cad' });                        // separate currency line
      await seedGift({ amount: 2_000, paidAt: `${YEAR + 1}-02-01 12:00:00` });   // another year

      // Household 2 (Grace 4 + Esther 9): the household view sums both donors; one person sees only their own.
      const household = await statementTotals(db, 'en', { personId: 9, household: true }, YEAR);
      expect(household.map((l) => [l.fund_name, l.currency, l.total_cents, l.gift_count])).toEqual([
        ['General', 'cad', 4_000, 1],
        ['General', 'usd', 10_500, 2],
      ]);
      const own = await statementTotals(db, 'en', { personId: 4, household: false }, YEAR);
      expect(own.map((l) => [l.currency, l.total_cents])).toEqual([['usd', 3_000]]);
      expect(await statementYears(db, { personId: 9, household: true })).toEqual([YEAR + 1, YEAR]);
      // Totals pages group by currency and never mix amounts.
      const yearTotals = await householdYearTotals(db, 9);
      expect(yearTotals.filter((t) => t.year === String(YEAR)).map((t) => [t.currency, t.total_cents]).sort())
        .toEqual([['cad', 4_000], ['usd', 15_500]]); // totals include the non-deductible fund, statements do not
    });

    it('year totals hide test-mode money unless asked (a test-mode deployment)', async () => {
      const live = await personYearTotals(db, 9);
      const withTest = await personYearTotals(db, 9, { includeTest: true });
      const sum = (rows: Array<{ year: string; currency: string; total_cents: number }>) =>
        rows.filter((r) => r.year === String(YEAR) && r.currency === 'usd').reduce((n, r) => n + r.total_cents, 0);
      expect(sum(withTest)).toBe(sum(live) + 6_000);
    });

    it('recipients are donors with an email and statement-eligible giving in the year', async () => {
      const recipients = await listStatementRecipients(db, YEAR);
      expect(recipients).toEqual(expect.arrayContaining([4, 9]));
      expect(recipients).not.toContain(10);
      await sql.unsafe("UPDATE people SET email = '' WHERE id = 4");
      expect(await listStatementRecipients(db, YEAR)).not.toContain(4);
      await sql.unsafe("UPDATE people SET email = 'grace.lin@example.com' WHERE id = 4");
    });

    it('fundTotals are net and group money by currency', async () => {
      const rows = await fundTotals(db, 'en', { from: `${YEAR}-01-01`, to: `${YEAR}-12-31` });
      const general = rows.filter((r) => r.fund_id === fund);
      expect(general.map((r) => [r.currency, r.total_cents]).sort()).toEqual([['cad', 4_000], ['usd', 10_500]]);
    });
  });

  // ── statement outbox ──────────────────────────────────────────────────────────
  describe('statement outbox', () => {
    const YEAR = 2031;
    const env = { APP_ORIGIN: 'https://church.example' };
    const outbox = (batch: string) => sql.unsafe('SELECT * FROM giving_statement_outbox WHERE batch_id = $1 ORDER BY person_id', [batch]);

    it('enqueues one row per donor, is unique per batch, and records an audit row', async () => {
      const { batchId, queued } = await enqueueStatementBatch(db, YEAR, 1);
      expect(queued).toBeGreaterThanOrEqual(2);
      const rows = await outbox(batchId);
      expect(rows.map((r) => r.status)).toEqual(rows.map(() => 'pending'));
      // The same batch id again is a no-op (UNIQUE person/year/batch)…
      await enqueueStatementBatch(db, YEAR, 1, { batchId });
      expect(await outbox(batchId)).toHaveLength(rows.length);
      // …while a new batch is an explicit second send.
      const second = await enqueueStatementBatch(db, YEAR, 1);
      expect(second.batchId).not.toBe(batchId);
      expect(await sql.unsafe("SELECT 1 FROM giving_audit_events WHERE action = 'statements_queued'")).not.toHaveLength(0);
      const summary = (await listStatementBatches(db)).find((b) => b.batch_id === batchId)!;
      expect(summary).toMatchObject({ year: YEAR, total: rows.length, pending: rows.length, sent: 0 });
    });

    it('drains a bounded batch per tick, emailing the statement link in the donor language', async () => {
      await sql.unsafe('DELETE FROM giving_statement_outbox');
      const { batchId } = await enqueueStatementBatch(db, YEAR, 1);
      const total = (await outbox(batchId)).length;
      const result = await drainStatementOutbox(env, db, { now: new Date('2032-01-10T00:00:00Z'), limit: 1 });
      expect(result).toEqual({ attempted: 1, sent: 1, retrying: 0, failed: 0 });
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      const [, , message] = sendEmailMock.mock.calls[0] as [unknown, unknown, { to: string; kind: string; text: string; subject: string }];
      expect(message.kind).toBe('givingStatement');
      expect(message.text).toContain(`https://church.example/zh/my/giving/statement/${YEAR}`); // Grace (4) is zh; no attachment
      expect((await outbox(batchId)).filter((r) => r.status === 'sent')).toHaveLength(1);
      expect(total).toBeGreaterThan(1);

      const rest = await drainStatementOutbox(env, db, { now: new Date('2032-01-10T00:05:00Z') });
      expect(rest.sent).toBe(total - 1);
      expect(await drainStatementOutbox(env, db, { now: new Date('2032-01-10T00:10:00Z') })).toMatchObject({ attempted: 0 });
    });

    it('a failed send retries with backoff and ends failed after the attempt cap', async () => {
      await sql.unsafe('DELETE FROM giving_statement_outbox');
      const { batchId } = await enqueueStatementBatch(db, YEAR, 1);
      sendEmailMock.mockImplementation(async () => false);
      let now = new Date('2032-02-01T00:00:00Z');
      let result = await drainStatementOutbox(env, db, { now, limit: 25 });
      expect(result.sent).toBe(0);
      expect(result.retrying).toBeGreaterThan(0);
      let row = (await outbox(batchId))[0];
      expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'send_failed' });
      expect(row.next_attempt_at).toBe('2032-02-01 00:05:00'); // backoff: 5 minutes

      // Not due yet: nothing is attempted.
      expect(await drainStatementOutbox(env, db, { now: new Date('2032-02-01T00:04:00Z') })).toMatchObject({ attempted: 0 });

      for (let attempt = 2; attempt <= STATEMENT_MAX_ATTEMPTS; attempt++) {
        now = new Date(now.getTime() + statementBackoffMinutes(attempt - 1) * 60_000 + 1000);
        result = await drainStatementOutbox(env, db, { now, limit: 25 });
      }
      row = (await outbox(batchId))[0];
      expect(row).toMatchObject({ status: 'failed', attempts: STATEMENT_MAX_ATTEMPTS });
      expect(result.failed).toBeGreaterThan(0);
      sendEmailMock.mockImplementation(async () => true);
    });

    it('leases a row while sending, so an overlapping tick skips it; an expired lease is reclaimed', async () => {
      await sql.unsafe('DELETE FROM giving_statement_outbox');
      const { batchId } = await enqueueStatementBatch(db, YEAR, 1);
      const first = (await outbox(batchId))[0];
      // A tick that is mid-send holds a live lease.
      await sql.unsafe(`UPDATE giving_statement_outbox SET status='sending', lease_token='other', lease_expires_at='2032-03-01 00:10:00', attempts=1 WHERE id=$1`, [first.id]);
      const during = await drainStatementOutbox(env, db, { now: new Date('2032-03-01T00:05:00Z'), limit: 25 });
      expect((await sql.unsafe('SELECT status, lease_token FROM giving_statement_outbox WHERE id=$1', [first.id]))[0]).toEqual({ status: 'sending', lease_token: 'other' });
      expect(during.attempted).toBe((await outbox(batchId)).length - 1);
      // After the lease expires (a crashed tick) the row is claimed and sent.
      const after = await drainStatementOutbox(env, db, { now: new Date('2032-03-01T00:20:00Z'), limit: 25 });
      expect(after).toMatchObject({ attempted: 1, sent: 1 });
      expect((await sql.unsafe('SELECT status, lease_token FROM giving_statement_outbox WHERE id=$1', [first.id]))[0]).toEqual({ status: 'sent', lease_token: null });
    });

    it('permanently fails a row whose donor has nothing to report or no email', async () => {
      await sql.unsafe('DELETE FROM giving_statement_outbox');
      await sql.unsafe(`INSERT INTO giving_statement_outbox (person_id, year, batch_id) VALUES (10, 2031, 'nothing'), (3, 2031, 'nothing')`);
      await sql.unsafe("UPDATE people SET email = '' WHERE id = 3");
      const result = await drainStatementOutbox(env, db, { now: new Date('2032-04-01T00:00:00Z'), limit: 25 });
      expect(result.failed).toBe(2);
      const rows = await outbox('nothing');
      expect(rows.map((r) => r.last_error).sort()).toEqual(['no_recipient', 'nothing_to_report']);
      await sql.unsafe("UPDATE people SET email = 'sarah.johnson@example.com' WHERE id = 3");
    });
  });

  // ── CSV export ────────────────────────────────────────────────────────────────
  describe('gift CSV export', () => {
    it('neutralizes formula injection in donor names and notes and labels test/live rows', async () => {
      await recordManualGift(db, { donorName: '=HYPERLINK("http://evil")', fundId: fund, amountCents: 1234, method: 'cash', receivedOn: '2033-05-05', note: '+cmd|calc', recordedBy: 1, currency: 'usd' });
      await insertCardGift(db, { personId: null, donorName: 'Test, Donor', donorEmail: null, fundId: fund, amountCents: 500, currency: 'usd', sessionId: null, paymentIntentId: 'pi_csv_test', livemode: false, paidAt: '2033-05-06 12:00:00' });
      const rows = await listGiftsForExport(db, { from: '2033-05-01', to: '2033-05-31' });
      expect(rows).toHaveLength(2);
      const csv = buildGiftsCsv(rows);
      const lines = csv.trim().split('\r\n');
      expect(lines[0]).toContain('Gift ID,Date,Donor');
      expect(csv).toContain("\"'=HYPERLINK(\"\"http://evil\"\")\""); // quote-prefixed, then RFC 4180 quoted
      expect(csv).toContain("'+cmd|calc");
      expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
      expect(csv).toContain('12.34');
      expect(csv).toMatch(/,live,/);
      expect(csv).toMatch(/,test,/);
      expect(csv).toContain('"Test, Donor"');
    });

    it('respects campus scope', async () => {
      await sql.unsafe(`INSERT INTO gifts (fund_id, amount_cents, currency, method, status, livemode, received_on, donor_name, campus_id)
        VALUES ($1, 999, 'usd', 'cash', 'succeeded', true, '2033-06-01', 'East Donor', 2)`, [eastFund]);
      const main = await listGiftsForExport(scopeDatabase(db, 1), { from: '2033-06-01', to: '2033-06-30' });
      const east = await listGiftsForExport(scopeDatabase(db, 2), { from: '2033-06-01', to: '2033-06-30' });
      expect(main.map((r) => r.donor_name)).not.toContain('East Donor');
      expect(east.map((r) => r.donor_name)).toEqual(['East Donor']);
    });
  });
});
