import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import { PgAdapter } from '../../src/lib/pgAdapter';
import {
  STRIPE_FAILED_RETENTION_MS,
  STRIPE_LEASE_MS,
  STRIPE_PROCESSED_RETENTION_MS,
  assertStripeLease,
  claimStripeEvent,
  dismissStripeEvent,
  finalizeStripeEvent,
  listStripeWebhookEvents,
  pruneStripeWebhookPayloads,
  receiveStripeEvent,
  recordStripeAttemptFailure,
  replayStripeEvent,
  sha256Utf8,
  type StripeReceiptInput,
} from '../../src/lib/stripeWebhookInbox';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const NOW = new Date('2026-07-13T12:00:00.000Z');
const addMs = (date: Date, milliseconds: number) => new Date(date.getTime() + milliseconds);
const utc = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');

describe.skipIf(!hasPg)('Stripe webhook inbox state machine (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  const receipt = async (eventId: string, overrides: Partial<StripeReceiptInput> = {}) => {
    const body = JSON.stringify({
      id: eventId,
      type: 'invoice.paid',
      created: 1_700_000_000,
      livemode: false,
      data: { object: { id: 'in_test_1' } },
    });
    const input: StripeReceiptInput = {
      eventId,
      payloadJson: body,
      payloadSha256: await sha256Utf8(body),
      eventType: 'invoice.paid',
      apiVersion: '2026-06-30',
      eventCreated: 1_700_000_000,
      livemode: false,
      ...overrides,
    };
    return { input, result: await receiveStripeEvent(db, input, NOW) };
  };

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    execFileSync('node', ['scripts/db/seed-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });

  beforeEach(async () => {
    await sql.unsafe('TRUNCATE church_private.stripe_webhook_events');
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('stores the exact body once, returns safe duplicates, and detects digest collisions without mutation', async () => {
    const eventId = 'evt_test_receipt';
    const { input, result } = await receipt(eventId);
    expect(result).toEqual({ kind: 'inserted', status: 'pending', outcome: null });
    expect(await receiveStripeEvent(db, input, addMs(NOW, 5_000)))
      .toEqual({ kind: 'duplicate', status: 'pending', outcome: null });
    expect(await receiveStripeEvent(db, { ...input, payloadSha256: 'f'.repeat(64) }, addMs(NOW, 10_000)))
      .toEqual({ kind: 'collision' });

    const [row] = await sql.unsafe(`
      SELECT payload_json, payload_sha256, received_at, event_type, api_version, event_created, livemode
      FROM church_private.stripe_webhook_events WHERE event_id=$1
    `, [eventId]);
    expect(row).toEqual(expect.objectContaining({
      payload_json: input.payloadJson,
      payload_sha256: input.payloadSha256,
      received_at: utc(NOW),
      event_type: input.eventType,
      api_version: input.apiVersion,
      event_created: input.eventCreated,
      livemode: 0,
    }));
  });

  it('uses insert-first conflict handling safely under concurrent receipt delivery', async () => {
    const eventId = 'evt_test_concurrent_receipt';
    const body = JSON.stringify({ id: eventId, type: 'invoice.paid', created: 1, livemode: false });
    const input: StripeReceiptInput = {
      eventId,
      payloadJson: body,
      payloadSha256: await sha256Utf8(body),
      eventType: 'invoice.paid',
      apiVersion: null,
      eventCreated: 1,
      livemode: false,
    };
    const results = await Promise.all([
      receiveStripeEvent(db, input, NOW),
      receiveStripeEvent(db, input, addMs(NOW, 1_000)),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(['duplicate', 'inserted']);
    expect(await sql.unsafe(`SELECT count(*)::int AS count FROM church_private.stripe_webhook_events WHERE event_id=$1`, [eventId]))
      .toEqual([{ count: 1 }]);
  });

  it('claims atomically, excludes active leases, reclaims at expiry, and rejects stale tokens', async () => {
    const { input } = await receipt('evt_test_lease');
    const first = await claimStripeEvent(db, input.eventId, NOW, 'lease-a');
    expect(first).toMatchObject({
      eventId: input.eventId,
      leaseToken: 'lease-a',
      attemptCount: 1,
      retryCycleAttempts: 1,
      payloadJson: input.payloadJson,
    });
    expect(await assertStripeLease(db, input.eventId, 'lease-a', NOW)).toBe(true);
    expect(await claimStripeEvent(db, input.eventId, addMs(NOW, STRIPE_LEASE_MS - 1), 'lease-b')).toBeNull();
    expect(await assertStripeLease(db, input.eventId, 'lease-a', addMs(NOW, STRIPE_LEASE_MS))).toBe(false);

    const second = await claimStripeEvent(db, input.eventId, addMs(NOW, STRIPE_LEASE_MS), 'lease-b');
    expect(second).toMatchObject({ leaseToken: 'lease-b', attemptCount: 2, retryCycleAttempts: 2 });
    expect(await finalizeStripeEvent(db, input.eventId, 'lease-a', { state: 'processed', outcome: 'late' }, NOW)).toBe(false);
    expect(await finalizeStripeEvent(db, input.eventId, 'lease-b', { state: 'processed', outcome: 'gift_recorded' }, addMs(NOW, STRIPE_LEASE_MS))).toBe(true);
    expect(await assertStripeLease(db, input.eventId, 'lease-b', addMs(NOW, STRIPE_LEASE_MS))).toBe(false);

    const [row] = await sql.unsafe(`SELECT status,outcome,attempt_count,retry_cycle_attempts,lease_token,lease_expires_at,next_attempt_at,last_error,completed_at FROM church_private.stripe_webhook_events WHERE event_id=$1`, [input.eventId]);
    expect(row).toEqual({
      status: 'processed',
      outcome: 'gift_recorded',
      attempt_count: 2,
      retry_cycle_attempts: 2,
      lease_token: null,
      lease_expires_at: null,
      next_attempt_at: null,
      last_error: null,
      completed_at: utc(addMs(NOW, STRIPE_LEASE_MS)),
    });
  });

  it('allows only one of two concurrent claimants and increments counters only for the winner', async () => {
    const { input } = await receipt('evt_test_claim_race');
    const claims = await Promise.all([
      claimStripeEvent(db, input.eventId, NOW, 'lease-race-a'),
      claimStripeEvent(db, input.eventId, NOW, 'lease-race-b'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const [row] = await sql.unsafe(`SELECT attempt_count,retry_cycle_attempts FROM church_private.stripe_webhook_events WHERE event_id=$1`, [input.eventId]);
    expect(row).toEqual({ attempt_count: 1, retry_cycle_attempts: 1 });
  });

  it('atomically fails an expired sixth claim without allowing a seventh dispatch or counter increment', async () => {
    const { input } = await receipt('evt_test_crash_exhaustion');
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const claimedAt = addMs(NOW, (attempt - 1) * STRIPE_LEASE_MS);
      expect(await claimStripeEvent(db, input.eventId, claimedAt, `lease-crash-${attempt}`))
        .toMatchObject({ attemptCount: attempt, retryCycleAttempts: attempt, leaseToken: `lease-crash-${attempt}` });
    }

    const exhaustedAt = addMs(NOW, 6 * STRIPE_LEASE_MS);
    const exhaustedClaims = await Promise.all([
      claimStripeEvent(db, input.eventId, exhaustedAt, 'lease-forbidden-7a'),
      claimStripeEvent(db, input.eventId, exhaustedAt, 'lease-forbidden-7b'),
    ]);
    expect(exhaustedClaims).toEqual([null, null]);

    const [row] = await sql.unsafe(`
      SELECT status,outcome,attempt_count,retry_cycle_attempts,next_attempt_at,
             lease_token,lease_expires_at,last_error,completed_at,updated_at
      FROM church_private.stripe_webhook_events WHERE event_id=$1
    `, [input.eventId]);
    expect(row).toEqual({
      status: 'failed',
      outcome: 'lease_expired',
      attempt_count: 6,
      retry_cycle_attempts: 6,
      next_attempt_at: null,
      lease_token: null,
      lease_expires_at: null,
      last_error: 'Processing lease expired after maximum attempts',
      completed_at: utc(exhaustedAt),
      updated_at: utc(exhaustedAt),
    });
  });

  it('finalizes ignored outcomes as terminal through the owned lease', async () => {
    const { input } = await receipt('evt_test_ignored_finalize');
    expect(await claimStripeEvent(db, input.eventId, NOW, 'lease-ignore')).not.toBeNull();
    expect(await finalizeStripeEvent(db, input.eventId, 'lease-ignore', { state: 'ignored', outcome: 'module_disabled' }, NOW)).toBe(true);
    const [row] = await sql.unsafe(`SELECT status,outcome,completed_at,lease_token FROM church_private.stripe_webhook_events WHERE event_id=$1`, [input.eventId]);
    expect(row).toEqual({ status: 'ignored', outcome: 'module_disabled', completed_at: utc(NOW), lease_token: null });
    expect(await claimStripeEvent(db, input.eventId, addMs(NOW, STRIPE_LEASE_MS), 'lease-late')).toBeNull();
  });

  it('schedules attempts 1-5 exactly and makes attempt 6 terminal failed', async () => {
    const { input } = await receipt('evt_test_retries');
    const delays = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000, 24 * 60 * 60_000];
    let claimAt = NOW;
    for (let index = 0; index < 6; index += 1) {
      const claim = await claimStripeEvent(db, input.eventId, claimAt, `lease-${index + 1}`);
      expect(claim).not.toBeNull();
      const failedAt = addMs(claimAt, 1_000);
      expect(await recordStripeAttemptFailure(db, claim!, new Error(`secret failure ${index + 1}`), failedAt, ['secret']))
        .toBe(true);
      const [row] = await sql.unsafe(`SELECT status,outcome,next_attempt_at,last_error,completed_at,attempt_count,retry_cycle_attempts FROM church_private.stripe_webhook_events WHERE event_id=$1`, [input.eventId]);
      if (index < 5) {
        const next = addMs(failedAt, delays[index]);
        expect(row).toEqual(expect.objectContaining({
          status: 'pending',
          outcome: 'attempt_failed',
          next_attempt_at: utc(next),
          last_error: `Error: [REDACTED] failure ${index + 1}`,
          completed_at: null,
          attempt_count: index + 1,
          retry_cycle_attempts: index + 1,
        }));
        claimAt = next;
      } else {
        expect(row).toEqual(expect.objectContaining({
          status: 'failed',
          outcome: 'attempt_failed',
          next_attempt_at: null,
          last_error: 'Error: [REDACTED] failure 6',
          completed_at: utc(failedAt),
          attempt_count: 6,
          retry_cycle_attempts: 6,
        }));
      }
    }
  });

  it('schedules deferred results through the same retry policy and rejects stale failure writes', async () => {
    const { input } = await receipt('evt_test_deferred');
    const first = await claimStripeEvent(db, input.eventId, NOW, 'lease-deferred');
    expect(await finalizeStripeEvent(db, input.eventId, 'wrong-token', { state: 'deferred', outcome: 'registration_missing' }, NOW)).toBe(false);
    expect(await finalizeStripeEvent(db, input.eventId, 'lease-deferred', { state: 'deferred', outcome: 'registration_missing' }, NOW)).toBe(true);
    const [row] = await sql.unsafe(`SELECT status,outcome,next_attempt_at,last_error,completed_at FROM church_private.stripe_webhook_events WHERE event_id=$1`, [input.eventId]);
    expect(row).toEqual({
      status: 'pending',
      outcome: 'registration_missing',
      next_attempt_at: utc(addMs(NOW, 5 * 60_000)),
      last_error: 'registration_missing',
      completed_at: null,
    });
    expect(await recordStripeAttemptFailure(db, first!, new Error('late'), NOW)).toBe(false);
  });

  it('replays only retained failed or ignored payloads, resets only cycle state, and audits the actor', async () => {
    for (const [eventId, status] of [['evt_test_replay_failed', 'failed'], ['evt_test_replay_ignored', 'ignored']] as const) {
      await receipt(eventId);
      await sql.unsafe(`UPDATE church_private.stripe_webhook_events SET status=$2,outcome='old',attempt_count=9,retry_cycle_attempts=6,completed_at=$3,last_error='old error' WHERE event_id=$1`, [eventId, status, utc(addMs(NOW, -1_000))]);
      expect(await replayStripeEvent(db, eventId, 1, NOW)).toBe(true);
      const [row] = await sql.unsafe(`SELECT status,outcome,attempt_count,retry_cycle_attempts,next_attempt_at,last_error,last_action_by,last_action_at,completed_at FROM church_private.stripe_webhook_events WHERE event_id=$1`, [eventId]);
      expect(row).toEqual({
        status: 'pending',
        outcome: 'manual_replay',
        attempt_count: 9,
        retry_cycle_attempts: 0,
        next_attempt_at: utc(NOW),
        last_error: null,
        last_action_by: 1,
        last_action_at: utc(NOW),
        completed_at: null,
      });
    }

    for (const [eventId, status, payload] of [
      ['evt_test_no_replay_processed', 'processed', '{}'],
      ['evt_test_no_replay_pending', 'pending', '{}'],
      ['evt_test_no_replay_dismissed', 'dismissed', null],
      ['evt_test_no_replay_expired', 'failed', null],
    ] as const) {
      await receipt(eventId);
      await sql.unsafe(`UPDATE church_private.stripe_webhook_events SET status=$2,payload_json=$3,lease_token=NULL,lease_expires_at=NULL WHERE event_id=$1`, [eventId, status, payload]);
      expect(await replayStripeEvent(db, eventId, 1, NOW)).toBe(false);
    }
  });

  it('dismisses only failed events, nulls payload atomically, audits the actor, and permanently disables replay', async () => {
    const { input } = await receipt('evt_test_dismiss');
    await sql.unsafe(`UPDATE church_private.stripe_webhook_events SET status='failed',completed_at=$2 WHERE event_id=$1`, [input.eventId, utc(addMs(NOW, -1_000))]);
    expect(await dismissStripeEvent(db, input.eventId, 1, NOW)).toBe(true);
    const [row] = await sql.unsafe(`SELECT status,outcome,payload_json,last_action_by,last_action_at,completed_at,lease_token,lease_expires_at FROM church_private.stripe_webhook_events WHERE event_id=$1`, [input.eventId]);
    expect(row).toEqual({
      status: 'dismissed',
      outcome: 'dismissed_by_operator',
      payload_json: null,
      last_action_by: 1,
      last_action_at: utc(NOW),
      completed_at: utc(NOW),
      lease_token: null,
      lease_expires_at: null,
    });
    expect(await replayStripeEvent(db, input.eventId, 1, addMs(NOW, 1_000))).toBe(false);

    await receipt('evt_test_dismiss_pending');
    expect(await dismissStripeEvent(db, 'evt_test_dismiss_pending', 1, NOW)).toBe(false);
  });

  it('lists bounded audit metadata newest-first without either sensitive JSON column', async () => {
    await receipt('evt_test_list_old');
    await receipt('evt_test_list_new');
    await sql.unsafe(`UPDATE church_private.stripe_webhook_events SET received_at=$2 WHERE event_id=$1`, ['evt_test_list_old', utc(addMs(NOW, -1_000))]);
    const rows = await listStripeWebhookEvents(db, { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: 'evt_test_list_new', status: 'pending', eventType: 'invoice.paid' });
    expect(rows[0]).not.toHaveProperty('payloadJson');
    expect(rows[0]).not.toHaveProperty('payload_json');
    expect(rows[0]).not.toHaveProperty('requestJson');
    expect(rows[0]).not.toHaveProperty('request_json');
  });

  it('prunes processed/ignored at exactly 90 days and failed at exactly 180 days only', async () => {
    const seeds = [
      ['evt_processed_boundary', 'processed', STRIPE_PROCESSED_RETENTION_MS, 'done'],
      ['evt_ignored_boundary', 'ignored', STRIPE_PROCESSED_RETENTION_MS, 'ignored'],
      ['evt_processed_inside', 'processed', STRIPE_PROCESSED_RETENTION_MS - 1_000, 'done'],
      ['evt_failed_boundary', 'failed', STRIPE_FAILED_RETENTION_MS, 'attempt_failed'],
      ['evt_failed_inside', 'failed', STRIPE_FAILED_RETENTION_MS - 1_000, 'attempt_failed'],
      ['evt_pending_old', 'pending', STRIPE_FAILED_RETENTION_MS + 1_000, null],
    ] as const;
    for (const [eventId, status, age, outcome] of seeds) {
      await receipt(eventId);
      await sql.unsafe(`UPDATE church_private.stripe_webhook_events SET status=$2,outcome=$3,completed_at=$4 WHERE event_id=$1`, [eventId, status, outcome, status === 'pending' ? null : utc(addMs(NOW, -age))]);
    }
    expect(await pruneStripeWebhookPayloads(db, NOW)).toEqual({ processedOrIgnored: 2, failed: 1 });

    const rows = await sql.unsafe(`SELECT event_id,status,payload_json,outcome FROM church_private.stripe_webhook_events ORDER BY event_id`);
    const byId = Object.fromEntries(rows.map((row) => [row.event_id, row]));
    expect(byId.evt_processed_boundary.payload_json).toBeNull();
    expect(byId.evt_ignored_boundary.payload_json).toBeNull();
    expect(byId.evt_processed_inside.payload_json).not.toBeNull();
    expect(byId.evt_failed_boundary).toEqual(expect.objectContaining({ payload_json: null, outcome: 'payload_expired', status: 'failed' }));
    expect(byId.evt_failed_inside).toEqual(expect.objectContaining({ payload_json: expect.any(String), outcome: 'attempt_failed' }));
    expect(byId.evt_pending_old.payload_json).not.toBeNull();
    expect(await pruneStripeWebhookPayloads(db, NOW)).toEqual({ processedOrIgnored: 0, failed: 0 });
  });
});
