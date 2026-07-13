import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgAdapter } from '../../src/lib/pgAdapter';
import {
  STRIPE_FAILED_REPLAY_WARNING_MS,
  dismissStripeEvent,
  listStripeWebhookEvents,
  replayStripeEvent,
  stripeWebhookReplayAvailability,
} from '../../src/lib/stripeWebhookInbox';
import { listRegistrationCheckoutRequests } from '../../src/lib/stripeCheckoutRequests';
import { dismissStripeWebhookEvent, replayStripeWebhookEvent } from '../../src/lib/stripeWebhookProcessor';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const NOW = new Date('2026-07-13T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const utc = (date: Date) => date.toISOString().replace('T', ' ').replace('Z', '');

describe('Stripe admin replay availability', () => {
  it('warns from day 150 and disables replay at the 180-day cutoff', () => {
    expect(STRIPE_FAILED_REPLAY_WARNING_MS).toBe(150 * DAY);
    const failed = { status: 'failed' as const, payloadAvailable: true, completedAt: utc(NOW) };
    expect(stripeWebhookReplayAvailability(failed, new Date(NOW.getTime() + 150 * DAY - 1))).toBe('available');
    expect(stripeWebhookReplayAvailability(failed, new Date(NOW.getTime() + 150 * DAY))).toBe('warning');
    expect(stripeWebhookReplayAvailability(failed, new Date(NOW.getTime() + 180 * DAY))).toBe('expired');
    expect(stripeWebhookReplayAvailability({ ...failed, payloadAvailable: false }, NOW)).toBe('expired');
  });
});

describe('Stripe admin event services', () => {
  const env = { STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_admin', STRIPE_WEBHOOK_SECRET: 'whsec_admin', DB_BACKEND: 'supabase' } as any;

  it('queues replay with the actor, closes the admin client, then processes through a fresh lease service', async () => {
    const order: string[] = [];
    const replay = vi.fn(async () => { order.push('queue'); return true; });
    const process = vi.fn(async () => { order.push('process'); return { state: 'processed', outcome: 'gift_recorded' } as const; });
    const end = vi.fn(async () => { order.push('close'); });
    const result = await replayStripeWebhookEvent('evt_test_admin_service', 9, {
      env, now: () => NOW, openDb: () => ({ db: {} as any, backend: 'supabase', end }), replay, process,
    });
    expect(result).toEqual({ state: 'processed', outcome: 'gift_recorded' });
    expect(replay).toHaveBeenCalledWith(expect.anything(), 'evt_test_admin_service', 9, NOW);
    expect(order).toEqual(['queue', 'close', 'process']);
  });

  it('dismisses through the audited inbox transition without invoking processing', async () => {
    const dismiss = vi.fn(async () => true);
    const end = vi.fn(async () => {});
    await expect(dismissStripeWebhookEvent('evt_test_admin_service', 9, {
      env, now: () => NOW, openDb: () => ({ db: {} as any, backend: 'supabase', end }), dismiss,
    })).resolves.toEqual({ state: 'dismissed' });
    expect(dismiss).toHaveBeenCalledWith(expect.anything(), 'evt_test_admin_service', 9, NOW);
    expect(end).toHaveBeenCalledOnce();
  });

  it('refuses every admin transition unless the runtime is explicitly test mode with a test key', async () => {
    const openDb = vi.fn();
    await expect(replayStripeWebhookEvent('evt_test_admin_service', 9, {
      env: { ...env, STRIPE_MODE: 'live' }, openDb,
    })).resolves.toEqual({ state: 'not_claimed' });
    await expect(dismissStripeWebhookEvent('evt_test_admin_service', 9, {
      env: { ...env, STRIPE_SECRET_KEY: 'sk_live_forbidden' }, openDb,
    })).resolves.toEqual({ state: 'not_dismissed' });
    expect(openDb).not.toHaveBeenCalled();
  });
});

describe.skipIf(!hasPg)('Stripe admin operations (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const db = hasPg ? new PgAdapter(sql) : (null as never);

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    execFileSync('node', ['scripts/db/seed-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
  });

  beforeEach(async () => {
    await sql.unsafe(`
      TRUNCATE church_private.stripe_checkout_requests,
        church_private.stripe_webhook_events,
        reg_answers, registrations, reg_event_i18n, reg_events RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => { await sql?.end(); });

  async function insertEvent(eventId: string, status: 'failed' | 'processed', receivedAt: Date) {
    const payload = JSON.stringify({ id: eventId, customer_email: 'private@example.test', secret: 'never-render' });
    await sql.unsafe(`
      INSERT INTO church_private.stripe_webhook_events
        (event_id,payload_json,payload_sha256,event_type,event_created,livemode,status,outcome,
         attempt_count,retry_cycle_attempts,last_error,received_at,completed_at,updated_at)
      VALUES ($1,$2,repeat('a',64),'checkout.session.completed',1700000000,0,$3,'attempt_failed',
              6,6,'sanitized_failure',$4,$4,$4)
    `, [eventId, payload, status, utc(receivedAt)]);
  }

  async function paymentDomainSnapshot() {
    const [registrations, events, gifts, recurring] = await Promise.all([
      sql.unsafe(`SELECT id,event_id,status,amount_cents,currency,stripe_checkout_session_id FROM registrations ORDER BY id`),
      sql.unsafe(`SELECT id,capacity,price_cents,currency FROM reg_events ORDER BY id`),
      sql.unsafe(`SELECT id,person_id,fund_id,amount_cents,status,stripe_payment_intent_id FROM gifts ORDER BY id`),
      sql.unsafe(`SELECT id,person_id,fund_id,amount_cents,status,stripe_subscription_id FROM recurring_gifts ORDER BY id`),
    ]);
    return JSON.stringify({ registrations, events, gifts, recurring });
  }

  it('paginates and filters bounded receipt columns without returning raw payload data', async () => {
    await insertEvent('evt_test_admin_1', 'failed', new Date(NOW.getTime() - 2_000));
    await insertEvent('evt_test_admin_2', 'processed', new Date(NOW.getTime() - 1_000));
    await insertEvent('evt_test_admin_3', 'failed', NOW);
    const rows = await listStripeWebhookEvents(db, { status: 'failed', limit: 1, offset: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: 'evt_test_admin_1', status: 'failed', payloadAvailable: true });
    const output = JSON.stringify(rows);
    expect(output).not.toContain('private@example.test');
    expect(output).not.toContain('never-render');
    expect(output).not.toContain('payloadJson');
  });

  it('paginates bounded Checkout request projections without request JSON, email, secrets, or URLs', async () => {
    const [event] = await sql.unsafe(`INSERT INTO reg_events (starts_at,price_cents,currency) VALUES (datetime('now','+1 day'),2500,'usd') RETURNING id`);
    const [registration] = await sql.unsafe(`
      INSERT INTO registrations (event_id,name,email,status,amount_cents,currency)
      VALUES ($1,'Private Person','private@example.test','pending',2500,'usd') RETURNING id
    `, [event.id]);
    await sql.unsafe(`
      INSERT INTO church_private.stripe_checkout_requests
        (request_id,request_sha256,registration_id,request_json,session_url,state,reconcile_attempts,next_reconcile_at,last_error)
      VALUES ('00000000-0000-4000-8000-000000000901',repeat('b',64),$1,
              '{"customer_email":"private@example.test","secret":"never-render"}',
              'https://checkout.stripe.com/c/pay/private-url','creating',6,NULL,'sanitized_failure')
    `, [registration.id]);
    const rows = await listRegistrationCheckoutRequests(db, { state: 'creating', limit: 10, offset: 0 });
    expect(rows).toEqual([expect.objectContaining({
      requestId: '00000000-0000-4000-8000-000000000901', registrationId: registration.id,
      state: 'creating', registrationStatus: 'pending', reconcileAttempts: 6,
    })]);
    const output = JSON.stringify(rows);
    for (const sensitive of ['private@example.test', 'never-render', 'checkout.stripe.com', 'requestJson', 'sessionUrl']) {
      expect(output).not.toContain(sensitive);
    }
  });

  it('enforces the replay cutoff and dismissal changes no public domain row', async () => {
    const expiredAt = new Date(NOW.getTime() - 180 * DAY);
    const [domainEvent] = await sql.unsafe(`
      INSERT INTO reg_events (starts_at,capacity,price_cents,currency)
      VALUES (datetime('now','+2 days'),12,2500,'usd') RETURNING id
    `);
    await sql.unsafe(`
      INSERT INTO registrations (event_id,name,email,status,amount_cents,currency)
      VALUES ($1,'Seat Holder','seat-holder@example.test','pending',2500,'usd')
    `, [domainEvent.id]);
    await insertEvent('evt_test_admin_still_replayable', 'failed', new Date(expiredAt.getTime() + 1_000));
    await insertEvent('evt_test_admin_expired', 'failed', expiredAt);
    const before = await paymentDomainSnapshot();
    expect(await replayStripeEvent(db, 'evt_test_admin_still_replayable', 1, NOW)).toBe(true);
    expect(await replayStripeEvent(db, 'evt_test_admin_expired', 1, NOW)).toBe(false);
    expect(await dismissStripeEvent(db, 'evt_test_admin_expired', 1, NOW)).toBe(true);
    expect(await paymentDomainSnapshot()).toBe(before);
    const [row] = await sql.unsafe(`SELECT status,payload_json,last_action_by FROM church_private.stripe_webhook_events WHERE event_id='evt_test_admin_expired'`);
    expect(row).toEqual({ status: 'dismissed', payload_json: null, last_action_by: 1 });
  });
});
