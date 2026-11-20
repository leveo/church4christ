// Registration refunds against real Postgres: the Stripe Refunds request (shape and idempotency key, through a
// fake fetch), the guards, and the charge.refunded webhook converging with the drawer on ONE cumulative total.
// Self-skips without DATABASE_URL. src/lib/email is replaced by the capturing stand-in (cancel emails).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('../../src/lib/email', async () => (await import('../shared/regMail')).mockEmailModule());

import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { createRegistration, saveEvent } from '../../src/lib/regDb';
import { handleStripeEvent as dispatch, type WebhookDeps } from '../../src/lib/givingWebhook';
import { refundIdempotencyKey, refundRegistration } from '../../src/lib/regRefunds';
import { listActivity } from '../../src/lib/regAdmin';
import { STRIPE_API_VERSION } from '../../src/lib/stripe';
import { mail } from '../shared/regMail';
import { stripeEvent } from '../stripeFixtures';

const DAY = 24 * 3600_000;
const ts = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
const ENV = { DB_BACKEND: 'supabase', STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', APP_ORIGIN: 'https://church.example' };

interface Call { url: string; method: string; headers: Record<string, string>; body: URLSearchParams }

describe.skipIf(!hasPg)('registration refunds (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;
  let seq = 0;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], { env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8' });
    db = new PgAdapter(sql);
  });
  afterAll(async () => { await sql?.end(); });
  beforeEach(() => { mail.sent.length = 0; mail.fail = false; });

  /** A confirmed, card-paid registration of 5000 cents on its own PaymentIntent. */
  async function paid(over: { method?: string | null; pi?: string | null; amount?: number } = {}) {
    const n = ++seq;
    const eventId = await saveEvent(db, { title_en: 'Gala', title_zh: '晚宴', starts_at: ts(30 * DAY), price_cents: 5000, active: 1 });
    const created = await createRegistration(db, {
      eventId, personId: null, name: 'Pia', email: `pia${n}@example.com`, status: 'confirmed', amountCents: 0, currency: 'usd', answers: [], submissionKey: `refund-${n}-${Date.now()}`,
    });
    const pi = over.pi === undefined ? `pi_test_${n}` : over.pi;
    await db.prepare(`UPDATE registrations SET amount_cents = ?2, payment_method = ?3, stripe_payment_intent_id = ?4 WHERE id = ?1`)
      .bind(created.id, over.amount ?? 5000, over.method === undefined ? 'stripe' : over.method, pi).run();
    return { id: created.id, pi: pi as string, email: `pia${n}@example.com` };
  }
  const state = async (id: number) =>
    (await db.prepare(`SELECT refunded_cents, status, amount_cents FROM registrations WHERE id = ?1`).bind(id).first<{ refunded_cents: number; status: string; amount_cents: number }>())!;

  function fakeStripe(onCall?: (call: Call) => Promise<void> | void, reply?: () => Response) {
    const calls: Call[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const call: Call = { url, method: String(init.method), headers: init.headers as Record<string, string>, body: new URLSearchParams(String(init.body)) };
      calls.push(call);
      await onCall?.(call);
      return reply ? reply() : new Response(JSON.stringify({ id: `re_${calls.length}`, amount: Number(call.body.get('amount')), status: 'succeeded' }), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  }
  const charge = (pi: string, refunded: number, extra: Record<string, unknown> = {}) =>
    stripeEvent('charge.refunded', { id: 'ch_1', payment_intent: pi, amount: 5000, amount_refunded: refunded, refunded: refunded >= 5000, metadata: { kind: 'registration' }, ...extra });
  const modules = new Set(['giving', 'registration'] as const);
  const webhook = (event: Record<string, unknown>, mods: WebhookDeps['modules'] = modules) =>
    dispatch({ db, env: ENV as never, modules: mods, fetcher: (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch }, event);

  it('refunds through Stripe with an idempotency key, then records it with the staff member as actor', async () => {
    const reg = await paid();
    const { calls, fetcher } = fakeStripe();
    const result = await refundRegistration(ENV as never, db, { registrationId: reg.id, amountCents: 2000, actor: null }, { fetcher });
    expect(result).toEqual({ ok: true, refundedCents: 2000, remainingCents: 3000, cancelled: false });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://api.stripe.com/v1/refunds');
    expect(call.method).toBe('POST');
    expect(call.headers['Idempotency-Key']).toBe(refundIdempotencyKey(reg.id, 2000));
    expect(call.headers['Idempotency-Key']).toBe(`reg-refund:${reg.id}:2000`);
    expect(call.headers['Stripe-Version']).toBe(STRIPE_API_VERSION);
    expect(call.headers.Authorization).toBe('Bearer sk_test_x');
    expect(Object.fromEntries(call.body)).toEqual({
      payment_intent: reg.pi, amount: '2000', reason: 'requested_by_customer',
      'metadata[kind]': 'registration_refund', 'metadata[registration_id]': String(reg.id),
    });
    const actor = (await db.prepare(`INSERT INTO people (display_name, email) VALUES ('Treasurer', ?1) RETURNING id`).bind(`t${Date.now()}@example.com`).first<{ id: number }>())!.id;
    // a second partial refund is a different cumulative target, so a different key
    const second = fakeStripe();
    expect(await refundRegistration(ENV as never, db, { registrationId: reg.id, amountCents: 1000, actor }, { fetcher: second.fetcher })).toMatchObject({ ok: true, refundedCents: 3000, remainingCents: 2000 });
    expect(second.calls[0].headers['Idempotency-Key']).toBe(`reg-refund:${reg.id}:3000`);
    const history = (await listActivity(db, reg.id)).filter((a) => a.action === 'refund');
    expect(history.map((h) => h.detail)).toEqual([
      { cents: 1000, source: 'stripe', total: 3000 },
      { cents: 2000, source: 'stripe', total: 2000 },
    ]);
    expect(history[0].actor_person_id).toBe(actor);
  });

  it('guards: unavailable, amounts, payment method, PaymentIntent and what was paid', async () => {
    const reg = await paid();
    const { calls, fetcher } = fakeStripe();
    const go = (over: Partial<Parameters<typeof refundRegistration>[2]> & { env?: unknown } = {}) =>
      refundRegistration((over.env ?? ENV) as never, db, { registrationId: reg.id, amountCents: 100, actor: null, ...over }, { fetcher });
    expect(await go({ env: { ...ENV, DB_BACKEND: 'd1' } })).toEqual({ ok: false, code: 'unavailable' });
    expect(await go({ env: { ...ENV, STRIPE_SECRET_KEY: undefined } })).toEqual({ ok: false, code: 'unavailable' });
    for (const bad of [0, -1, 1.5, Number.NaN, 100_000_000]) expect(await go({ amountCents: bad })).toEqual({ ok: false, code: 'invalid_amount' });
    expect(await go({ registrationId: 999_999_999 })).toEqual({ ok: false, code: 'not_found' });
    expect(await go({ amountCents: 5001 })).toEqual({ ok: false, code: 'exceeds_paid' });
    const cash = await paid({ method: 'offline', pi: null });
    const comp = await paid({ method: 'comp', pi: null, amount: 0 });
    const noPi = await paid({ pi: null });
    expect(await go({ registrationId: cash.id })).toEqual({ ok: false, code: 'not_stripe' });
    expect(await go({ registrationId: comp.id })).toEqual({ ok: false, code: 'not_stripe' });
    expect(await go({ registrationId: noPi.id })).toEqual({ ok: false, code: 'no_payment_intent' });
    expect(calls).toHaveLength(0); // no guard failure ever reached Stripe
    // the remaining amount is the limit
    expect(await go({ amountCents: 5000 })).toMatchObject({ ok: true, remainingCents: 0 });
    expect(await go({ amountCents: 1 })).toEqual({ ok: false, code: 'exceeds_paid' });
  });

  it('a Stripe failure changes nothing, and the retry of the same refund reuses the same idempotency key', async () => {
    const reg = await paid();
    const failing = fakeStripe(undefined, () => new Response(JSON.stringify({ error: { message: 'No such charge', type: 'invalid_request_error' } }), { status: 400 }));
    expect(await refundRegistration(ENV as never, db, { registrationId: reg.id, amountCents: 2000, actor: null }, { fetcher: failing.fetcher })).toEqual({ ok: false, code: 'refund_failed' });
    expect((await state(reg.id)).refunded_cents).toBe(0);
    const ok = fakeStripe();
    expect(await refundRegistration(ENV as never, db, { registrationId: reg.id, amountCents: 2000, actor: null }, { fetcher: ok.fetcher })).toMatchObject({ ok: true });
    expect(ok.calls[0].headers['Idempotency-Key']).toBe(failing.calls[0].headers['Idempotency-Key']);
  });

  it('converges with the webhook: the same refund is never counted twice, in either order', async () => {
    // webhook arrives while the drawer is still recording
    const a = await paid();
    const early = fakeStripe(async () => {
      expect(await webhook(charge(a.pi, 2000))).toEqual({ state: 'processed', outcome: 'registration_refund_synced' });
    });
    expect(await refundRegistration(ENV as never, db, { registrationId: a.id, amountCents: 2000, actor: null }, { fetcher: early.fetcher })).toMatchObject({ ok: true, refundedCents: 2000 });
    expect((await state(a.id)).refunded_cents).toBe(2000);
    expect((await listActivity(db, a.id)).filter((h) => h.action === 'refund')).toHaveLength(1);

    // webhook arrives after the drawer finished (and again: redelivery)
    const b = await paid();
    await refundRegistration(ENV as never, db, { registrationId: b.id, amountCents: 2000, actor: null }, { fetcher: fakeStripe().fetcher });
    expect(await webhook(charge(b.pi, 2000))).toEqual({ state: 'processed', outcome: 'registration_refund_repeat' });
    expect(await webhook(charge(b.pi, 2000))).toEqual({ state: 'processed', outcome: 'registration_refund_repeat' });
    expect((await state(b.id)).refunded_cents).toBe(2000);
    expect((await listActivity(db, b.id)).filter((h) => h.action === 'refund')).toHaveLength(1);
  });

  it('a refund made in the Stripe dashboard is picked up: cumulative, never lowered, capped at what was paid', async () => {
    const reg = await paid();
    expect(await webhook(charge(reg.pi, 1500, { metadata: {} }))).toEqual({ state: 'processed', outcome: 'registration_refund_synced' }); // matched by PaymentIntent, not metadata
    expect((await state(reg.id)).refunded_cents).toBe(1500);
    expect(await webhook(charge(reg.pi, 1000))).toEqual({ state: 'processed', outcome: 'registration_refund_repeat' }); // an older event never lowers it
    expect((await state(reg.id)).refunded_cents).toBe(1500);
    expect(await webhook(charge(reg.pi, 9000))).toMatchObject({ state: 'processed' });
    expect((await state(reg.id)).refunded_cents).toBe(5000);
    const h = (await listActivity(db, reg.id)).filter((a) => a.action === 'refund').map((a) => a.detail);
    expect(h).toEqual([{ cents: 3500, source: 'stripe', total: 5000, webhook: true }, { cents: 1500, source: 'stripe', total: 1500, webhook: true }]);
  });

  it('the webhook ignores what is not ours: unknown charges, a disabled module, a bad amount', async () => {
    const reg = await paid();
    expect(await webhook(charge('pi_nobody', 100, { metadata: {} }))).toMatchObject({ state: 'ignored' });
    expect(await webhook(charge('pi_nobody', 100))).toEqual({ state: 'deferred', outcome: 'registration_not_visible' }); // tagged as ours, row not visible yet
    expect(await webhook(charge(reg.pi, 100), new Set(['giving']))).toEqual({ state: 'ignored', outcome: 'module_disabled' });
    expect(await webhook(charge(reg.pi, -5))).toMatchObject({ state: 'ignored' });
    expect((await state(reg.id)).refunded_cents).toBe(0);
  });

  it('can also cancel the registration afterwards, through the normal cancel path (the cancellation email goes out)', async () => {
    const reg = await paid();
    const result = await refundRegistration(ENV as never, db, { registrationId: reg.id, amountCents: 5000, actor: null, alsoCancel: true }, { fetcher: fakeStripe().fetcher });
    expect(result).toEqual({ ok: true, refundedCents: 5000, remainingCents: 0, cancelled: true });
    expect((await state(reg.id)).status).toBe('cancelled');
    expect((await listActivity(db, reg.id)).map((a) => a.action)).toEqual(['cancelled', 'refund']); // cancel goes through the admin op: it leaves a history row
    expect(mail.sent.map((m) => [m.kind, m.to])).toEqual([['regCancelled', reg.email]]);
  });
});
