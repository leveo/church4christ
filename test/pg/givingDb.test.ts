// givingDb (Supabase-only giving module) against real Postgres. Migrates + seeds
// a fresh database the runner way, builds a PgAdapter, and exercises the manual
// ledger (record/list/filters/totals), the household privacy boundary, year
// totals, the recurring lifecycle, the Stripe-customer round-trip, and every
// idempotent webhook writer (double-insert dedup on both partial unique indexes,
// refund flip). Money is integer cents throughout. Self-skips without DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { saveFund } from '../../src/lib/fundDb';
import {
  recordManualGift,
  listGifts,
  fundTotals,
  listHouseholdGifts,
  householdYearTotals,
  listRecurringForPerson,
  insertCardGift,
  markGiftRefunded,
  upsertRecurringGift,
  setRecurringStatus,
  getRecurringBySubscription,
  setStripeCustomer,
  getStripeCustomer,
} from '../../src/lib/givingDb';

// Seed households: 1 Chen (person 2 David + 7 Amy + dependent), 2 Lin (4 + 9),
// 3 Zhao (10). Household-less real people: 1, 3, 5, 6, 8.
describe.skipIf(!hasPg)('givingDb (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;
  let generalFund: number;

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
    generalFund = await saveFund(db, { fund_number: 'G100', name_en: 'General', name_zh: '总奉献', active: 1, sort: 1 });
  });
  afterAll(async () => {
    await sql?.end();
  });

  // ── Manual ledger ──────────────────────────────────────────────────────────
  it('recordManualGift inserts a succeeded check gift that listGifts returns localized', async () => {
    const id = await recordManualGift(db, {
      personId: 2,
      fundId: generalFund,
      amountCents: 5000,
      method: 'check',
      checkNumber: '1042',
      receivedOn: '2026-02-01',
      note: 'tithe',
      recordedBy: 1,
      currency: 'usd',
    });
    expect(typeof id).toBe('number');

    const rows = await listGifts(db, 'en', { fundId: generalFund });
    const row = rows.find((r) => r.id === id)!;
    expect(row).toMatchObject({
      person_id: 2,
      fund_id: generalFund,
      fund_name: 'General',
      amount_cents: 5000,
      currency: 'usd',
      method: 'check',
      status: 'succeeded',
      received_on: '2026-02-01',
      check_number: '1042',
      note: 'tithe',
    });
    // zh locale resolves the Chinese fund name.
    const zh = await listGifts(db, 'zh', { fundId: generalFund });
    expect(zh.find((r) => r.id === id)!.fund_name).toBe('总奉献');
  });

  it('listGifts filters by fund, method, and effective-date range', async () => {
    const fund = await saveFund(db, { fund_number: 'G200', name_en: 'Missions', name_zh: '宣教', active: 1, sort: 2 });
    const cash = await recordManualGift(db, { personId: 3, fundId: fund, amountCents: 2000, method: 'cash', receivedOn: '2026-03-10', recordedBy: 1, currency: 'usd' });
    const check = await recordManualGift(db, { personId: 3, fundId: fund, amountCents: 3000, method: 'check', checkNumber: '55', receivedOn: '2026-05-20', recordedBy: 1, currency: 'usd' });

    expect((await listGifts(db, 'en', { fundId: fund })).map((r) => r.id).sort()).toEqual([cash, check].sort());
    expect((await listGifts(db, 'en', { fundId: fund, method: 'cash' })).map((r) => r.id)).toEqual([cash]);
    // Date window Apr–Jun keeps only the May gift.
    const windowed = await listGifts(db, 'en', { fundId: fund, from: '2026-04-01', to: '2026-06-30' });
    expect(windowed.map((r) => r.id)).toEqual([check]);
  });

  it('fundTotals sums succeeded gifts per fund and EXCLUDES refunded money', async () => {
    const fund = await saveFund(db, { fund_number: 'G300', name_en: 'Building', name_zh: '建堂', active: 1, sort: 3 });
    await recordManualGift(db, { personId: 4, fundId: fund, amountCents: 1000, method: 'cash', receivedOn: '2026-01-05', recordedBy: 1, currency: 'usd' });
    await recordManualGift(db, { personId: 4, fundId: fund, amountCents: 2500, method: 'check', checkNumber: '9', receivedOn: '2026-01-06', recordedBy: 1, currency: 'usd' });
    // A refunded card gift on the same fund must NOT count toward the total.
    await insertCardGift(db, { personId: 4, donorName: null, donorEmail: null, fundId: fund, amountCents: 9999, currency: 'usd', sessionId: null, paymentIntentId: 'pi_refund_total' });
    await markGiftRefunded(db, 'pi_refund_total');

    const totals = await fundTotals(db, 'en', {});
    const row = totals.find((t) => t.fund_id === fund)!;
    expect(row).toMatchObject({ fund_name: 'Building', fund_number: 'G300', total_cents: 3500, gift_count: 2 });
  });

  it('fundTotals honors the date window', async () => {
    const fund = await saveFund(db, { fund_number: 'G350', name_en: 'Youth', name_zh: '青年', active: 1, sort: 4 });
    await recordManualGift(db, { personId: 5, fundId: fund, amountCents: 700, method: 'cash', receivedOn: '2026-01-15', recordedBy: 1, currency: 'usd' });
    await recordManualGift(db, { personId: 5, fundId: fund, amountCents: 800, method: 'cash', receivedOn: '2026-07-15', recordedBy: 1, currency: 'usd' });
    const totals = await fundTotals(db, 'en', { from: '2026-06-01', to: '2026-12-31' });
    expect(totals.find((t) => t.fund_id === fund)!.total_cents).toBe(800);
  });

  // ── Household privacy boundary ───────────────────────────────────────────────
  it('listHouseholdGifts returns every household member gift but never an outsider gift', async () => {
    const fund = await saveFund(db, { fund_number: 'G400', name_en: 'Care', name_zh: '关怀', active: 1, sort: 5 });
    // Household 1: David (2) + Amy (7). Outsider: Grace (4), household 2.
    const davidGift = await recordManualGift(db, { personId: 2, fundId: fund, amountCents: 1111, method: 'cash', receivedOn: '2026-02-10', recordedBy: 1, currency: 'usd' });
    const amyGift = await recordManualGift(db, { personId: 7, fundId: fund, amountCents: 2222, method: 'cash', receivedOn: '2026-02-11', recordedBy: 1, currency: 'usd' });
    const graceGift = await recordManualGift(db, { personId: 4, fundId: fund, amountCents: 3333, method: 'cash', receivedOn: '2026-02-12', recordedBy: 1, currency: 'usd' });

    const view = await listHouseholdGifts(db, 'en', 2);
    const ids = view.map((g) => g.id);
    expect(ids).toContain(davidGift);
    expect(ids).toContain(amyGift);
    expect(ids).not.toContain(graceGift);
    // giver_name resolves the person's display name.
    expect(view.find((g) => g.id === davidGift)!.giver_name).toBe('陈大卫 David Chen');
    expect(view.find((g) => g.id === amyGift)!.giver_name).toBe('Amy Chen 陈爱美');
    // Amy (7) is the same household → sees David's gift too (symmetric).
    expect((await listHouseholdGifts(db, 'en', 7)).map((g) => g.id)).toContain(davidGift);
  });

  it('listHouseholdGifts includes refunded gifts and orders newest first', async () => {
    const fund = await saveFund(db, { fund_number: 'G450', name_en: 'Special', name_zh: '特别', active: 1, sort: 6 });
    const older = await recordManualGift(db, { personId: 2, fundId: fund, amountCents: 100, method: 'cash', receivedOn: '2025-01-01', recordedBy: 1, currency: 'usd' });
    const newer = await recordManualGift(db, { personId: 2, fundId: fund, amountCents: 200, method: 'cash', receivedOn: '2026-12-31', recordedBy: 1, currency: 'usd' });
    await insertCardGift(db, { personId: 2, donorName: null, donorEmail: null, fundId: fund, amountCents: 500, currency: 'usd', sessionId: null, paymentIntentId: 'pi_hh_refund' });
    await markGiftRefunded(db, 'pi_hh_refund');

    const view = (await listHouseholdGifts(db, 'en', 2)).filter((g) => g.fund_id === fund);
    const statuses = view.map((g) => g.status);
    expect(statuses).toContain('refunded'); // refunds stay visible in the ledger
    // newest received_on first within this fund
    const idxNewer = view.findIndex((g) => g.id === newer);
    const idxOlder = view.findIndex((g) => g.id === older);
    expect(idxNewer).toBeLessThan(idxOlder);
  });

  it('listHouseholdGifts falls back to the viewer alone when they have no household', async () => {
    const fund = await saveFund(db, { fund_number: 'G500', name_en: 'Solo', name_zh: '个人', active: 1, sort: 7 });
    // Person 3 (Sarah) belongs to no household; person 5 (Mark) also household-less.
    const sarahGift = await recordManualGift(db, { personId: 3, fundId: fund, amountCents: 4444, method: 'cash', receivedOn: '2026-02-13', recordedBy: 1, currency: 'usd' });
    const markGift = await recordManualGift(db, { personId: 5, fundId: fund, amountCents: 5555, method: 'cash', receivedOn: '2026-02-14', recordedBy: 1, currency: 'usd' });
    const view = await listHouseholdGifts(db, 'en', 3);
    const ids = view.map((g) => g.id);
    expect(ids).toContain(sarahGift);
    expect(ids).not.toContain(markGift);
  });

  it('householdYearTotals sums succeeded gifts per year for the whole household', async () => {
    // This rollup spans ALL funds (no fund filter), so isolate household 2's
    // members from gifts other tests in this shared-DB suite recorded for them.
    await sql.unsafe('DELETE FROM gifts WHERE person_id IN (4, 9)');
    const fund = await saveFund(db, { fund_number: 'G600', name_en: 'Yearly', name_zh: '年度', active: 1, sort: 8 });
    // Household 2: Grace (4) + Esther (9).
    await recordManualGift(db, { personId: 4, fundId: fund, amountCents: 1000, method: 'cash', receivedOn: '2025-06-01', recordedBy: 1, currency: 'usd' });
    await recordManualGift(db, { personId: 9, fundId: fund, amountCents: 2000, method: 'cash', receivedOn: '2025-07-01', recordedBy: 1, currency: 'usd' });
    await recordManualGift(db, { personId: 4, fundId: fund, amountCents: 3000, method: 'cash', receivedOn: '2026-01-01', recordedBy: 1, currency: 'usd' });
    // Refund on a 2026 card gift must not inflate the year total.
    await insertCardGift(db, { personId: 9, donorName: null, donorEmail: null, fundId: fund, amountCents: 8000, currency: 'usd', sessionId: null, paymentIntentId: 'pi_year_refund' });
    await markGiftRefunded(db, 'pi_year_refund');

    const totals = await householdYearTotals(db, 4);
    const byYear = Object.fromEntries(totals.map((t) => [t.year, t.total_cents]));
    expect(byYear['2025']).toBe(3000); // 1000 + 2000 across both members
    expect(byYear['2026']).toBe(3000); // refund excluded
  });

  // ── Webhook idempotency ──────────────────────────────────────────────────────
  it('insertCardGift is idempotent on a redelivered payment_intent_id', async () => {
    const fund = await saveFund(db, { fund_number: 'G700', name_en: 'Card', name_zh: '刷卡', active: 1, sort: 9 });
    const g = { personId: 6, donorName: null, donorEmail: 'ben@example.com', fundId: fund, amountCents: 4200, currency: 'usd', sessionId: 'cs_1', paymentIntentId: 'pi_once' };
    await insertCardGift(db, g);
    await insertCardGift(db, { ...g, amountCents: 9999 }); // redelivery, different amount → ignored
    const rows = await sql.unsafe('SELECT amount_cents FROM gifts WHERE stripe_payment_intent_id = $1', ['pi_once']);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount_cents)).toBe(4200); // first write wins
  });

  it('insertCardGift dedups on stripe_invoice_id even when the PI differs', async () => {
    const fund = await saveFund(db, { fund_number: 'G750', name_en: 'Sub', name_zh: '定期', active: 1, sort: 10 });
    await insertCardGift(db, { personId: 6, donorName: null, donorEmail: null, fundId: fund, amountCents: 1000, currency: 'usd', sessionId: null, paymentIntentId: 'pi_inv_a', invoiceId: 'in_1', subscriptionId: 'sub_1' });
    await insertCardGift(db, { personId: 6, donorName: null, donorEmail: null, fundId: fund, amountCents: 1000, currency: 'usd', sessionId: null, paymentIntentId: 'pi_inv_b', invoiceId: 'in_1', subscriptionId: 'sub_1' });
    const rows = await sql.unsafe('SELECT id FROM gifts WHERE stripe_invoice_id = $1', ['in_1']);
    expect(rows).toHaveLength(1);
  });

  it('markGiftRefunded flips a succeeded gift once and returns false for an unknown PI', async () => {
    const fund = await saveFund(db, { fund_number: 'G800', name_en: 'Refund', name_zh: '退款', active: 1, sort: 11 });
    await insertCardGift(db, { personId: 8, donorName: null, donorEmail: null, fundId: fund, amountCents: 6000, currency: 'usd', sessionId: null, paymentIntentId: 'pi_flip' });
    expect(await markGiftRefunded(db, 'pi_flip')).toBe(true);
    const [row] = await sql.unsafe('SELECT status FROM gifts WHERE stripe_payment_intent_id = $1', ['pi_flip']);
    expect(row.status).toBe('refunded');
    // Second call: already refunded → no row moves.
    expect(await markGiftRefunded(db, 'pi_flip')).toBe(false);
    // Unknown PI → false.
    expect(await markGiftRefunded(db, 'pi_missing')).toBe(false);
  });

  // ── Recurring lifecycle + Stripe customer ────────────────────────────────────
  it('recurring gifts: upsert creates, re-upsert updates, status syncs, lookup resolves', async () => {
    const fund = await saveFund(db, { fund_number: 'G900', name_en: 'Monthly', name_zh: '每月', active: 1, sort: 12 });
    await upsertRecurringGift(db, { personId: 10, fundId: fund, amountCents: 2500, currency: 'usd', interval: 'month', subscriptionId: 'sub_r', status: 'active' });

    expect(await getRecurringBySubscription(db, 'sub_r')).toEqual({ person_id: 10, fund_id: fund });

    let list = await listRecurringForPerson(db, 'en', 10);
    let row = list.find((r) => r.fund_name === 'Monthly')!;
    expect(row).toMatchObject({ amount_cents: 2500, interval: 'month', status: 'active' });

    // Re-upsert (subscription.updated) changes amount; no duplicate row appears.
    await upsertRecurringGift(db, { personId: 10, fundId: fund, amountCents: 4000, currency: 'usd', interval: 'month', subscriptionId: 'sub_r', status: 'active' });
    list = await listRecurringForPerson(db, 'en', 10);
    expect(list.filter((r) => r.fund_name === 'Monthly')).toHaveLength(1);
    expect(list.find((r) => r.fund_name === 'Monthly')!.amount_cents).toBe(4000);

    // Status sync (subscription.deleted → canceled).
    await setRecurringStatus(db, 'sub_r', 'canceled');
    expect(await getRecurringBySubscription(db, 'sub_r')).toEqual({ person_id: 10, fund_id: fund });
    expect((await listRecurringForPerson(db, 'en', 10)).find((r) => r.fund_name === 'Monthly')!.status).toBe('canceled');

    expect(await getRecurringBySubscription(db, 'sub_unknown')).toBeNull();
  });

  it('setStripeCustomer / getStripeCustomer round-trip on the people row', async () => {
    expect(await getStripeCustomer(db, 8)).toBeNull();
    await setStripeCustomer(db, 8, 'cus_abc123');
    expect(await getStripeCustomer(db, 8)).toBe('cus_abc123');
  });
});
