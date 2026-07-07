// The registration branch of the shared Stripe webhook dispatcher
// (src/lib/givingWebhook.ts) against real Postgres. Migrates + seeds a fresh DB
// the runner way, builds a PgAdapter, then drives handleStripeEvent with
// synthetic Stripe events. Covers the paid-registration confirm (idempotent on
// redelivery), the session-expired cancel that frees the held seat, and a
// regression that a kind:'gift' event STILL routes to the giving path unchanged.
// Self-skips without DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { saveFund } from '../../src/lib/fundDb';
import { saveEvent, createRegistration, attachCheckoutSession, getOpenEvent } from '../../src/lib/regDb';
import { handleStripeEvent } from '../../src/lib/givingWebhook';
import type { StripeEnv } from '../../src/lib/stripe';

const ENV: StripeEnv = { STRIPE_SECRET_KEY: 'sk_test_x', APP_ORIGIN: 'https://church.example' };

const DAY = 24 * 60 * 60 * 1000;
/** A UTC 'YYYY-MM-DD HH:MM:SS' timestamp `offsetMs` from now (matches datetime('now')). */
const ts = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
const ev = (type: string, object: Record<string, unknown>): Record<string, unknown> => ({ type, data: { object } });

describe.skipIf(!hasPg)('handleStripeEvent — registration branch (Postgres)', () => {
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

  /** An open, paid event carrying one pending registration whose Checkout session
   *  id is `sessionId`. Returns the event + registration ids. */
  async function pendingReg(
    sessionId: string,
    over: Partial<Parameters<typeof saveEvent>[1]> = {},
  ): Promise<{ eid: number; reg: number }> {
    const eid = await saveEvent(db, {
      title_en: 'Retreat',
      title_zh: '退修会',
      starts_at: ts(DAY),
      price_cents: 2000,
      active: 1,
      ...over,
    });
    const reg = await createRegistration(db, {
      eventId: eid,
      personId: null,
      name: 'Ann',
      email: 'ann@example.com',
      status: 'pending',
      amountCents: 2000,
      currency: 'usd',
      answers: [],
    });
    await attachCheckoutSession(db, reg, sessionId);
    return { eid, reg };
  }

  const regRow = (id: number) =>
    sql.unsafe('SELECT status, stripe_payment_intent_id FROM registrations WHERE id = $1', [id]);

  it('checkout.session.completed confirms the pending registration exactly once (idempotent)', async () => {
    const { reg } = await pendingReg('cs_done');
    const event = ev('checkout.session.completed', {
      id: 'cs_done',
      mode: 'payment',
      payment_intent: 'pi_done',
      metadata: { kind: 'registration', registration_id: String(reg) },
    });

    expect(await handleStripeEvent({ db, env: ENV }, event)).toBe('registration_confirmed');
    let [row] = await regRow(reg);
    expect(row.status).toBe('confirmed');
    expect(row.stripe_payment_intent_id).toBe('pi_done');

    // Stripe re-sends → the already-confirmed row does not move (idempotent).
    expect(await handleStripeEvent({ db, env: ENV }, event)).toBe('ignored');
    [row] = await regRow(reg);
    expect(row.status).toBe('confirmed');
    expect(row.stripe_payment_intent_id).toBe('pi_done');
  });

  it('checkout.session.expired cancels the pending registration and frees the held seat', async () => {
    const { eid, reg } = await pendingReg('cs_exp', { title_en: 'Capped', title_zh: '限额', capacity: 1 });
    // The pending row holds the only seat.
    expect((await getOpenEvent(db, 'en', eid))!.taken_count).toBe(1);

    const event = ev('checkout.session.expired', { id: 'cs_exp', metadata: { kind: 'registration' } });
    expect(await handleStripeEvent({ db, env: ENV }, event)).toBe('registration_cancelled');
    expect((await regRow(reg))[0].status).toBe('cancelled');
    // Seat freed → the event is open again.
    expect((await getOpenEvent(db, 'en', eid))!.taken_count).toBe(0);

    // Redelivery is a no-op (only a still-pending row moves).
    expect(await handleStripeEvent({ db, env: ENV }, event)).toBe('ignored');
  });

  it("expired session for a NON-registration kind is ignored (a gift checkout holds no seat)", async () => {
    const event = ev('checkout.session.expired', { id: 'cs_gift_exp', metadata: { kind: 'gift' } });
    expect(await handleStripeEvent({ db, env: ENV }, event)).toBe('ignored');
  });

  // ── Regression: gift routing is untouched by the new registration branch ──────
  it('a kind:gift checkout.session.completed STILL records a card gift', async () => {
    const outcome = await handleStripeEvent(
      { db, env: ENV },
      ev('checkout.session.completed', {
        id: 'cs_gift',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: 'pi_gift',
        amount_total: 5000,
        currency: 'usd',
        customer_details: { email: 'giver@example.com' },
        metadata: { kind: 'gift', fund_id: String(fund), person_id: '', donor_name: 'Giver' },
      }),
    );
    expect(outcome).toBe('gift_recorded');
    const [row] = await sql.unsafe('SELECT amount_cents, status FROM gifts WHERE stripe_payment_intent_id = $1', ['pi_gift']);
    expect(row).toMatchObject({ amount_cents: 5000, status: 'succeeded' });
  });
});
