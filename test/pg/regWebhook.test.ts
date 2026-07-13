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
import { handleStripeEvent as dispatchStripeEvent, type WebhookDeps } from '../../src/lib/givingWebhook';
import type { StripeEnv } from '../../src/lib/stripe';
import { stripeEvent } from '../stripeFixtures';

const ENV: StripeEnv = { STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_x', APP_ORIGIN: 'https://church.example' };

const DAY = 24 * 60 * 60 * 1000;
/** A UTC 'YYYY-MM-DD HH:MM:SS' timestamp `offsetMs` from now (matches datetime('now')). */
const ts = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
const ALL_MODULES = new Set(['giving', 'registration'] as const);
const handleStripeEvent = (
  deps: Omit<WebhookDeps, 'modules'>,
  event: Record<string, unknown>,
) => dispatchStripeEvent({ ...deps, modules: ALL_MODULES }, event);
const ev = stripeEvent;
const processed = (outcome: string) => ({ state: 'processed', outcome });
const ignored = (outcome = 'ignored') => ({ state: 'ignored', outcome });

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
    sessionId: string | null,
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
    if (sessionId) await attachCheckoutSession(db, reg, sessionId);
    return { eid, reg };
  }

  const regRow = (id: number) =>
    sql.unsafe('SELECT status, stripe_checkout_session_id, stripe_payment_intent_id FROM registrations WHERE id = $1', [id]);

  async function checkoutRequest(requestId: string, registrationId: number) {
    await sql.unsafe(
      `INSERT INTO church_private.stripe_checkout_requests
         (request_id, request_sha256, registration_id, request_json, state)
       VALUES ($1, $2, $3, '{}', 'creating')`,
      [requestId, 'a'.repeat(64), registrationId],
    );
  }

  it('checkout.session.completed confirms the pending registration exactly once (idempotent)', async () => {
    const { reg } = await pendingReg('cs_done');
    const event = ev('checkout.session.completed', {
      id: 'cs_done',
      mode: 'payment',
      payment_status: 'paid',
      amount_total: 2000,
      currency: 'usd',
      payment_intent: 'pi_done',
      metadata: { kind: 'registration', registration_id: String(reg) },
    });

    expect(await handleStripeEvent({ db, env: ENV }, event)).toEqual(processed('registration_confirmed'));
    let [row] = await regRow(reg);
    expect(row.status).toBe('confirmed');
    expect(row.stripe_payment_intent_id).toBe('pi_done');

    // Stripe re-sends → the already-confirmed row does not move (idempotent).
    expect(await handleStripeEvent({ db, env: ENV }, event)).toEqual(processed('registration_confirmed'));
    [row] = await regRow(reg);
    expect(row.status).toBe('confirmed');
    expect(row.stripe_payment_intent_id).toBe('pi_done');
  });

  it('checkout.session.expired cancels the pending registration and frees the held seat', async () => {
    const { eid, reg } = await pendingReg('cs_exp', { title_en: 'Capped', title_zh: '限额', capacity: 1 });
    // The pending row holds the only seat.
    expect((await getOpenEvent(db, 'en', eid))!.taken_count).toBe(1);

    const event = ev('checkout.session.expired', {
      id: 'cs_exp', amount_total: 2000, currency: 'usd',
      metadata: { kind: 'registration', registration_id: String(reg) },
    });
    expect(await handleStripeEvent({ db, env: ENV }, event)).toEqual(processed('registration_cancelled'));
    expect((await regRow(reg))[0].status).toBe('cancelled');
    // Seat freed → the event is open again.
    expect((await getOpenEvent(db, 'en', eid))!.taken_count).toBe(0);

    // Redelivery is a no-op (only a still-pending row moves).
    expect(await handleStripeEvent({ db, env: ENV }, event)).toEqual(processed('registration_cancelled'));
  });

  it("expired session for a NON-registration kind is ignored (a gift checkout holds no seat)", async () => {
    const event = ev('checkout.session.expired', { id: 'cs_gift_exp', metadata: { kind: 'gift' } });
    expect(await handleStripeEvent({ db, env: ENV }, event)).toEqual(ignored());
  });

  it('does not mutate Registration when only Giving is enabled', async () => {
    const { reg } = await pendingReg('cs_registration_disabled');
    const event = ev('checkout.session.completed', {
      id: 'cs_registration_disabled', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_disabled',
      amount_total: 2000, currency: 'usd', metadata: { kind: 'registration', registration_id: String(reg) },
    });
    expect(await dispatchStripeEvent({ db, env: ENV, modules: new Set(['giving']) }, event))
      .toEqual(ignored('module_disabled'));
    expect((await regRow(reg))[0]).toMatchObject({ status: 'pending', stripe_payment_intent_id: null });
  });

  it('does not confirm an unpaid completion and later async success confirms it', async () => {
    const { reg } = await pendingReg('cs_async_registration');
    const session = {
      id: 'cs_async_registration', mode: 'payment', payment_status: 'unpaid', payment_intent: null,
      amount_total: 2000, currency: 'usd', metadata: { kind: 'registration', registration_id: String(reg) },
    };
    expect(await handleStripeEvent({ db, env: ENV }, ev('checkout.session.completed', session)))
      .toEqual(ignored('awaiting_async_payment'));
    expect((await regRow(reg))[0].status).toBe('pending');

    expect(await handleStripeEvent({ db, env: ENV }, ev('checkout.session.async_payment_succeeded', {
      ...session, payment_status: 'paid', payment_intent: 'pi_async_registration',
    }))).toEqual(processed('registration_confirmed'));
    expect((await regRow(reg))[0]).toMatchObject({ status: 'confirmed', stripe_payment_intent_id: 'pi_async_registration' });
  });

  it('async payment failure cancels only a pending registration', async () => {
    const { reg } = await pendingReg('cs_async_failed');
    const failed = ev('checkout.session.async_payment_failed', {
      id: 'cs_async_failed', payment_status: 'unpaid', amount_total: 2000, currency: 'usd',
      metadata: { kind: 'registration', registration_id: String(reg) },
    });
    expect(await handleStripeEvent({ db, env: ENV }, failed)).toEqual(processed('registration_cancelled'));
    expect((await regRow(reg))[0].status).toBe('cancelled');
    expect(await handleStripeEvent({ db, env: ENV }, failed)).toEqual(processed('registration_cancelled'));
  });

  it('self-attaches and confirms an exact pending registration request', async () => {
    const requestId = '00000000-0000-4000-8000-000000000501';
    const { reg } = await pendingReg(null);
    await checkoutRequest(requestId, reg);
    const event = ev('checkout.session.completed', {
      id: 'cs_self_attach', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_self_attach',
      amount_total: 2000, currency: 'usd',
      metadata: { kind: 'registration', registration_id: String(reg), request_id: requestId },
    });
    expect(await handleStripeEvent({ db, env: ENV }, event)).toEqual(processed('registration_confirmed'));
    expect((await regRow(reg))[0]).toMatchObject({
      status: 'confirmed', stripe_checkout_session_id: 'cs_self_attach', stripe_payment_intent_id: 'pi_self_attach',
    });
    const [request] = await sql.unsafe(
      'SELECT state, request_json, session_url FROM church_private.stripe_checkout_requests WHERE request_id = $1',
      [requestId],
    );
    expect(request).toMatchObject({ state: 'resolved', request_json: null, session_url: null });
  });

  it('passes lease checkpoints into both guarded Registration writes and replay finishes cleanup', async () => {
    const requestId = '00000000-0000-4000-8000-000000000597';
    const { reg } = await pendingReg(null);
    await checkoutRequest(requestId, reg);
    const event = ev('checkout.session.completed', {
      id: 'cs_dispatch_checkpoint', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_dispatch_checkpoint',
      amount_total: 2000, currency: 'usd',
      metadata: { kind: 'registration', registration_id: String(reg), request_id: requestId },
    });
    let checkpoints = 0;
    await expect(handleStripeEvent({
      db,
      env: ENV,
      checkpoint: async () => {
        checkpoints += 1;
        if (checkpoints === 2) throw new Error('stripe_attempt_lease_lost');
      },
    }, event)).rejects.toThrow('stripe_attempt_lease_lost');
    expect(checkpoints).toBe(2);
    expect((await regRow(reg))[0].status).toBe('confirmed');
    expect((await sql.unsafe(
      'SELECT state FROM church_private.stripe_checkout_requests WHERE request_id = $1',
      [requestId],
    ))[0].state).toBe('creating');

    expect(await handleStripeEvent({ db, env: ENV }, event)).toEqual(processed('registration_confirmed'));
    expect((await sql.unsafe(
      'SELECT state FROM church_private.stripe_checkout_requests WHERE request_id = $1',
      [requestId],
    ))[0].state).toBe('resolved');
  });

  it.each<[string, string, { requestId?: string; registrationId?: 'other'; amountTotal?: number; currency?: string }]>([
    ['request ID', '701', { requestId: '00000000-0000-4000-8000-000000000799' }],
    ['registration ID', '702', { registrationId: 'other' }],
    ['amount', '703', { amountTotal: 2001 }],
    ['currency', '704', { currency: 'cad' }],
  ])('ignores self-attachment with mismatched %s', async (_label, suffix, mismatch) => {
    const requestId = `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
    const { reg } = await pendingReg(null);
    await checkoutRequest(requestId, reg);
    let registrationId = String(reg);
    if (mismatch.registrationId) {
      registrationId = String((await pendingReg(null)).reg);
    }
    const event = ev('checkout.session.completed', {
      id: `cs_mismatch_${suffix}`, mode: 'payment', payment_status: 'paid', payment_intent: `pi_mismatch_${suffix}`,
      amount_total: mismatch.amountTotal ?? 2000, currency: mismatch.currency ?? 'usd',
      metadata: {
        kind: 'registration', registration_id: registrationId,
        request_id: mismatch.requestId ?? requestId,
      },
    });
    expect(await handleStripeEvent({ db, env: ENV }, event)).toEqual(ignored('registration_mismatch'));
    expect((await regRow(reg))[0]).toMatchObject({ status: 'pending', stripe_checkout_session_id: null });
  });

  it('defers a known registration request while its row is not visible', async () => {
    expect(await handleStripeEvent({ db, env: ENV }, ev('checkout.session.completed', {
      id: 'cs_registration_not_visible', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_not_visible',
      amount_total: 2000, currency: 'usd',
      metadata: {
        kind: 'registration', registration_id: '2147483000',
        request_id: '00000000-0000-4000-8000-000000000598',
      },
    }))).toEqual({ state: 'deferred', outcome: 'registration_not_visible' });
  });

  it('converges an attached legacy registration without a private request row', async () => {
    const { reg } = await pendingReg('cs_legacy_attached');
    expect(await handleStripeEvent({ db, env: ENV }, ev('checkout.session.completed', {
      id: 'cs_legacy_attached', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_legacy_attached',
      amount_total: 2000, currency: 'usd', metadata: { kind: 'registration', registration_id: String(reg) },
    }))).toEqual(processed('registration_confirmed'));
    expect((await regRow(reg))[0].status).toBe('confirmed');
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
    expect(outcome).toEqual(processed('gift_recorded'));
    const [row] = await sql.unsafe('SELECT amount_cents, status FROM gifts WHERE stripe_payment_intent_id = $1', ['pi_gift']);
    expect(row).toMatchObject({ amount_cents: 5000, status: 'succeeded' });
  });
});
