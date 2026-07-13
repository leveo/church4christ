import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb, AppStatement } from '../../src/lib/appDb';
import type { DbEnv } from '../../src/lib/dbProvider';
import { clearModuleCache } from '../../src/lib/modules';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { StripeEnv } from '../../src/lib/stripe';
import {
  STRIPE_ATTEMPT_MS,
  STRIPE_LEASE_MS,
  claimStripeEvent,
  listStripeWebhookEvents,
  receiveStripeEvent,
  sha256Utf8,
  type StripeDispatchResult,
  type StripeReceiptInput,
} from '../../src/lib/stripeWebhookInbox';
import {
  drainStripeWebhookInbox,
  processStripeWebhookEvent,
  type ProcessAttemptResult,
  type StripeWebhookProcessorDeps,
} from '../../src/lib/stripeWebhookProcessor';
import { runStripeRecovery } from '../../src/lib/stripeRecovery';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const NOW = new Date('2026-07-13T12:00:00.000Z');
const addMs = (date: Date, milliseconds: number) => new Date(date.getTime() + milliseconds);
const utc = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');
const ENV: StripeEnv & DbEnv = {
  DB_BACKEND: 'supabase',
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_processor_secret',
  STRIPE_WEBHOOK_SECRET: 'whsec_processor_secret',
  APP_ORIGIN: 'https://church.example',
};
const HYPERDRIVE_CONNECTION =
  'postgres://processor_user:processor_password@db.example/postgres?api_key=processor_query_credential';
const SECRET_PARTS = [
  HYPERDRIVE_CONNECTION,
  'processor_user',
  'processor_password',
  'processor_query_credential',
] as const;

describe.skipIf(!hasPg)('Stripe webhook processor and recovery (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  const receipt = async (eventId: string, event: Record<string, unknown> = {
    id: eventId,
    type: 'unknown.test',
    created: 1_700_000_000,
    livemode: false,
    data: { object: {} },
  }) => {
    const body = JSON.stringify(event);
    const input: StripeReceiptInput = {
      eventId,
      payloadJson: body,
      payloadSha256: await sha256Utf8(body),
      eventType: String(event.type),
      apiVersion: null,
      eventCreated: Number(event.created),
      livemode: false,
    };
    await receiveStripeEvent(db, input, NOW);
  };

  const opened = (overrides: Partial<{ db: AppDb; backend: 'supabase' | 'd1'; end: () => Promise<void> }> = {}) => {
    const end = overrides.end ?? vi.fn(async () => {});
    return { db: overrides.db ?? db, backend: overrides.backend ?? 'supabase', end };
  };

  const hookedDb = (
    matches: (query: string) => boolean,
    hooks: {
      beforeFirst?: () => void | Promise<void>;
      afterFirst?: () => void | Promise<void>;
      afterAll?: () => void | Promise<void>;
    },
  ): AppDb => ({
    ...db,
    prepare(query: string) {
      const source = db.prepare(query);
      if (!matches(query)) return source;
      let current = source;
      const wrapped: AppStatement = {
        bind(...values: unknown[]) {
          current = current.bind(...values);
          return wrapped;
        },
        async first<T = unknown>(column?: string) {
          await hooks.beforeFirst?.();
          const result = await current.first<T>(column);
          await hooks.afterFirst?.();
          return result;
        },
        async all<T = unknown>() {
          const result = await current.all<T>();
          await hooks.afterAll?.();
          return result;
        },
        run<T = unknown>() {
          return current.run<T>();
        },
      };
      return wrapped;
    },
  });

  const deps = (
    dispatch: (deps: Parameters<NonNullable<StripeWebhookProcessorDeps['dispatch']>>[0], event: Record<string, unknown>) => Promise<StripeDispatchResult>,
    overrides: Partial<StripeWebhookProcessorDeps> = {},
  ) => {
    const handle = opened();
    return {
      handle,
      value: {
        env: ENV,
        openDb: () => handle,
        now: () => NOW,
        newLeaseToken: () => 'lease-test',
        dispatch,
        ...overrides,
      } satisfies StripeWebhookProcessorDeps,
    };
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
    clearModuleCache();
    await sql.unsafe('TRUNCATE church_private.stripe_webhook_events');
  });

  afterAll(async () => {
    await sql?.end();
  });

  it.each([
    { result: { state: 'processed', outcome: 'gift_recorded' } as const, status: 'processed' },
    { result: { state: 'ignored', outcome: 'unsupported_event' } as const, status: 'ignored' },
    { result: { state: 'deferred', outcome: 'gift_not_visible' } as const, status: 'pending' },
  ])('returns $result.state, finalizes it, and ends exactly once', async ({ result, status }) => {
    await receipt(`evt_test_${result.state}`);
    const dispatch = vi.fn(async () => result);
    const test = deps(dispatch);

    await expect(processStripeWebhookEvent(`evt_test_${result.state}`, test.value)).resolves.toEqual(result);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(test.handle.end).toHaveBeenCalledOnce();
    expect((await listStripeWebhookEvents(db))[0]).toMatchObject({ status, outcome: result.outcome });
  });

  it('uses real global crypto for the default lease token and completes the claim', async () => {
    await receipt('evt_test_default_crypto');
    const end = vi.fn(async () => {});
    const dispatch = vi.fn(async () => ({ state: 'processed', outcome: 'default_token_ok' } as const));

    expect(await processStripeWebhookEvent('evt_test_default_crypto', {
      env: ENV,
      openDb: () => opened({ end }),
      now: () => NOW,
      dispatch,
    })).toEqual({ state: 'processed', outcome: 'default_token_ok' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(await sql.unsafe(
      `SELECT status,lease_token FROM church_private.stripe_webhook_events WHERE event_id='evt_test_default_crypto'`,
    )).toEqual([{ status: 'processed', lease_token: null }]);
  });

  it('returns not_claimed without dispatch for a missing row or an actually processing active lease', async () => {
    await receipt('evt_test_active');
    expect(await claimStripeEvent(db, 'evt_test_active', NOW, 'lease-held'))
      .toMatchObject({ leaseToken: 'lease-held' });

    const dispatch = vi.fn(async () => ({ state: 'processed', outcome: 'forbidden' } as const));
    const activeHandle = opened();
    await expect(processStripeWebhookEvent('evt_test_active', {
      env: ENV,
      openDb: () => activeHandle,
      now: () => NOW,
      newLeaseToken: () => 'lease-second',
      dispatch,
    })).resolves.toEqual({ state: 'not_claimed' });
    const missingHandle = opened();
    await expect(processStripeWebhookEvent('evt_test_missing', {
      env: ENV,
      openDb: () => missingHandle,
      now: () => NOW,
      newLeaseToken: () => 'lease-missing',
      dispatch,
    })).resolves.toEqual({ state: 'not_claimed' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(activeHandle.end).toHaveBeenCalledOnce();
    expect(missingHandle.end).toHaveBeenCalledOnce();
  });

  it.each(['deadline', 'lease_changed'] as const)(
    'checkpoints after module load so %s prevents dispatch',
    async (mode) => {
      const eventId = `evt_test_modules_${mode}`;
      await receipt(eventId);
      clearModuleCache();
      let current = NOW;
      const moduleDb = hookedDb(
        (query) => query.includes('FROM settings'),
        {
          afterAll: async () => {
            if (mode === 'deadline') current = addMs(NOW, STRIPE_ATTEMPT_MS);
            else {
              await sql.unsafe(
                'UPDATE church_private.stripe_webhook_events SET lease_token=$1 WHERE event_id=$2',
                ['lease-successor', eventId],
              );
            }
          },
        },
      );
      const end = vi.fn(async () => {});
      const dispatch = vi.fn(async () => ({ state: 'processed', outcome: 'forbidden' } as const));

      expect(await processStripeWebhookEvent(eventId, {
        env: ENV,
        openDb: () => opened({ db: moduleDb, end }),
        now: () => current,
        newLeaseToken: () => 'lease-module-load',
        dispatch,
      })).toEqual({ state: 'failed' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(end).toHaveBeenCalledOnce();
    },
  );

  it('returns failed for thrown dispatch and records a sanitized retry without masking the result', async () => {
    await receipt('evt_test_throw');
    const test = deps(vi.fn(async () => { throw new Error('boom sk_test_processor_secret\nnext'); }));
    await expect(processStripeWebhookEvent('evt_test_throw', test.value)).resolves.toEqual({ state: 'failed' });
    expect(test.handle.end).toHaveBeenCalledOnce();
    expect((await listStripeWebhookEvents(db))[0]).toMatchObject({
      status: 'pending',
      outcome: 'attempt_failed',
      lastError: expect.not.stringContaining('sk_test_processor_secret'),
    });
  });

  it('redacts the Hyperdrive URL and its credential components from stored processor diagnostics', async () => {
    await receipt('evt_test_hyperdrive_diagnostic');
    const hyperdriveEnv: StripeEnv & DbEnv = {
      ...ENV,
      HYPERDRIVE: { connectionString: HYPERDRIVE_CONNECTION },
    };
    const test = deps(vi.fn(async () => {
      throw new Error(`database ${SECRET_PARTS.join(' ')} unavailable`);
    }), { env: hyperdriveEnv });

    expect(await processStripeWebhookEvent('evt_test_hyperdrive_diagnostic', test.value))
      .toEqual({ state: 'failed' });
    const [row] = await sql.unsafe(
      `SELECT last_error FROM church_private.stripe_webhook_events WHERE event_id='evt_test_hyperdrive_diagnostic'`,
    );
    expect(row.last_error).toEqual(expect.any(String));
    for (const secret of SECRET_PARTS) expect(row.last_error).not.toContain(secret);
  });

  it('returns failed for invalid stored JSON, module-load failure, finalization failure, and open failure', async () => {
    await receipt('evt_test_json');
    await sql.unsafe(`UPDATE church_private.stripe_webhook_events SET payload_json='{' WHERE event_id='evt_test_json'`);
    const json = deps(vi.fn(async () => ({ state: 'processed', outcome: 'never' } as const)));
    expect(await processStripeWebhookEvent('evt_test_json', json.value)).toEqual({ state: 'failed' });
    expect(json.handle.end).toHaveBeenCalledOnce();

    await receipt('evt_test_modules');
    clearModuleCache();
    const moduleDb: AppDb = {
      ...db,
      prepare(query: string) {
        if (query.includes('FROM settings')) throw new Error('module load failed');
        return db.prepare(query);
      },
    };
    const moduleHandle = opened({ db: moduleDb });
    const modules = deps(vi.fn(async () => ({ state: 'processed', outcome: 'never' } as const)), {
      openDb: () => moduleHandle,
      newLeaseToken: () => 'lease-modules',
    });
    expect(await processStripeWebhookEvent('evt_test_modules', modules.value)).toEqual({ state: 'failed' });
    expect(moduleHandle.end).toHaveBeenCalledOnce();

    await receipt('evt_test_finalize');
    let dispatchFinished = false;
    const unavailableDb: AppDb = {
      ...db,
      prepare(query: string) {
        if (dispatchFinished && query.trimStart().startsWith('UPDATE church_private.stripe_webhook_events')) {
          throw new Error('db unavailable');
        }
        return db.prepare(query);
      },
    };
    const finalizeHandle = opened({ db: unavailableDb });
    const finalization = {
      env: ENV,
      openDb: () => finalizeHandle,
      now: () => NOW,
      newLeaseToken: () => 'lease-finalize',
      dispatch: vi.fn(async () => {
        dispatchFinished = true;
        return { state: 'processed', outcome: 'effect_committed' } as const;
      }),
    } satisfies StripeWebhookProcessorDeps;
    expect(await processStripeWebhookEvent('evt_test_finalize', finalization)).toEqual({ state: 'failed' });
    expect(finalizeHandle.end).toHaveBeenCalledOnce();
    expect(await sql.unsafe(
      `SELECT status,outcome FROM church_private.stripe_webhook_events WHERE event_id='evt_test_finalize'`,
    )).toEqual([{ status: 'processing', outcome: null }]);

    const openDb = vi.fn(() => { throw new Error('open failed'); });
    expect(await processStripeWebhookEvent('evt_test_open', { env: ENV, openDb })).toEqual({ state: 'failed' });
    expect(openDb).toHaveBeenCalledOnce();
  });

  it('does not let an error-record UPDATE failure or end failure mask the result and recovers by lease', async () => {
    await receipt('evt_test_record_failure');
    const brokenDb = hookedDb(
      (query) => query.trimStart().startsWith('UPDATE church_private.stripe_webhook_events')
        && query.includes('last_error=?4'),
      { beforeFirst: () => { throw new Error('recording unavailable'); } },
    );
    const handle = opened({ db: brokenDb, end: vi.fn(async () => { throw new Error('end failed'); }) });
    const result = await processStripeWebhookEvent('evt_test_record_failure', {
      env: ENV,
      openDb: () => handle,
      now: () => NOW,
      newLeaseToken: () => 'lease-record',
      dispatch: vi.fn(async () => {
        throw new Error('handler failed');
      }),
    });
    expect(result).toEqual({ state: 'failed' });
    expect(handle.end).toHaveBeenCalledOnce();
    expect(await sql.unsafe(
      `SELECT status,lease_token FROM church_private.stripe_webhook_events WHERE event_id='evt_test_record_failure'`,
    )).toEqual([{ status: 'processing', lease_token: 'lease-record' }]);

    const recovered = deps(vi.fn(async () => ({ state: 'processed', outcome: 'recovered' } as const)), {
      now: () => addMs(NOW, STRIPE_LEASE_MS),
      newLeaseToken: () => 'lease-recovery',
    });
    expect(await processStripeWebhookEvent('evt_test_record_failure', recovered.value))
      .toEqual({ state: 'processed', outcome: 'recovered' });
  });

  it('rejects the checkpoint at the 25-second deadline before a later write', async () => {
    await receipt('evt_test_deadline');
    const laterWrite = vi.fn();
    let current = NOW;
    const test = deps(vi.fn(async ({ checkpoint }) => {
      current = addMs(NOW, STRIPE_ATTEMPT_MS);
      await checkpoint?.();
      laterWrite();
      return { state: 'processed', outcome: 'late' } as const;
    }), { now: () => current });

    expect(await processStripeWebhookEvent('evt_test_deadline', test.value)).toEqual({ state: 'failed' });
    expect(laterWrite).not.toHaveBeenCalled();
  });

  it('rejects a changed or expired lease checkpoint before a later fetch/write', async () => {
    for (const mode of ['changed', 'expired'] as const) {
      const eventId = `evt_test_${mode}_checkpoint`;
      await receipt(eventId);
      const laterEffect = vi.fn();
      const test = deps(vi.fn(async ({ checkpoint }) => {
        if (mode === 'changed') {
          await sql.unsafe('UPDATE church_private.stripe_webhook_events SET lease_token=$1 WHERE event_id=$2', ['successor', eventId]);
        } else {
          await sql.unsafe('UPDATE church_private.stripe_webhook_events SET lease_expires_at=$1 WHERE event_id=$2', [utc(NOW), eventId]);
        }
        await checkpoint?.();
        laterEffect();
        return { state: 'processed', outcome: 'forbidden' } as const;
      }), { newLeaseToken: () => `lease-${mode}` });
      expect(await processStripeWebhookEvent(eventId, test.value)).toEqual({ state: 'failed' });
      expect(laterEffect).not.toHaveBeenCalled();
      const [row] = await sql.unsafe(
        'SELECT status,lease_token FROM church_private.stripe_webhook_events WHERE event_id=$1',
        [eventId],
      );
      expect(row).toEqual({
        status: 'processing',
        lease_token: mode === 'changed' ? 'successor' : `lease-${mode}`,
      });
    }
  });

  it('cannot finalize with a stale token and recovers a failed finalization after the ten-minute lease', async () => {
    await receipt('evt_test_recover_finalize');
    let rejectWrites = false;
    const failingDb: AppDb = {
      ...db,
      prepare(query: string) {
        if (rejectWrites && query.trimStart().startsWith('UPDATE church_private.stripe_webhook_events')) {
          throw new Error('finalize offline');
        }
        return db.prepare(query);
      },
    };
    const first = deps(vi.fn(async () => {
      rejectWrites = true;
      return { state: 'processed', outcome: 'first_effect' } as const;
    }), { openDb: () => opened({ db: failingDb }), newLeaseToken: () => 'lease-stale' });
    expect(await processStripeWebhookEvent('evt_test_recover_finalize', first.value)).toEqual({ state: 'failed' });
    rejectWrites = false;

    const beforeExpiry = deps(vi.fn(async () => ({ state: 'processed', outcome: 'early' } as const)), {
      now: () => addMs(NOW, STRIPE_LEASE_MS - 1),
      newLeaseToken: () => 'lease-early',
    });
    expect(await processStripeWebhookEvent('evt_test_recover_finalize', beforeExpiry.value)).toEqual({ state: 'not_claimed' });

    const afterExpiry = deps(vi.fn(async () => ({ state: 'processed', outcome: 'converged' } as const)), {
      now: () => addMs(NOW, STRIPE_LEASE_MS),
      newLeaseToken: () => 'lease-successor',
    });
    expect(await processStripeWebhookEvent('evt_test_recover_finalize', afterExpiry.value))
      .toEqual({ state: 'processed', outcome: 'converged' });
    expect((await listStripeWebhookEvents(db))[0]).toMatchObject({ status: 'processed', outcome: 'converged', attemptCount: 2 });
  });

  it('cannot finalize when ownership changes after checkpoint three and immediately before the finish UPDATE', async () => {
    await receipt('evt_test_stale_finish');
    const dispatch = vi.fn(async () => ({ state: 'processed', outcome: 'must_not_finalize' } as const));
    const racingDb = hookedDb(
      (query) => query.trimStart().startsWith('UPDATE church_private.stripe_webhook_events')
        && query.includes('last_error=NULL,completed_at=?3'),
      {
        beforeFirst: async () => {
          await sql.unsafe(
            'UPDATE church_private.stripe_webhook_events SET lease_token=$1,lease_expires_at=$2 WHERE event_id=$3',
            ['lease-successor', utc(addMs(NOW, STRIPE_LEASE_MS)), 'evt_test_stale_finish'],
          );
        },
      },
    );
    const end = vi.fn(async () => {});
    expect(await processStripeWebhookEvent('evt_test_stale_finish', {
      env: ENV,
      openDb: () => opened({ db: racingDb, end }),
      now: () => NOW,
      newLeaseToken: () => 'lease-stale-finisher',
      dispatch,
    })).toEqual({ state: 'failed' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(await sql.unsafe(
      `SELECT status,outcome,lease_token FROM church_private.stripe_webhook_events WHERE event_id='evt_test_stale_finish'`,
    )).toEqual([{ status: 'processing', outcome: null, lease_token: 'lease-successor' }]);
  });

  it('makes the sixth thrown claim terminal failed', async () => {
    await receipt('evt_test_six_failures');
    const delays = [0, 5 * 60_000, 35 * 60_000, 155 * 60_000, 875 * 60_000, 2315 * 60_000];
    const dispatch = vi.fn(async () => { throw new Error('retry me'); });
    for (let index = 0; index < 6; index += 1) {
      const current = addMs(NOW, delays[index] + index * 1_000);
      const test = deps(dispatch, { now: () => current, newLeaseToken: () => `lease-${index + 1}` });
      expect(await processStripeWebhookEvent('evt_test_six_failures', test.value)).toEqual({ state: 'failed' });
    }
    expect(dispatch).toHaveBeenCalledTimes(6);
    expect((await listStripeWebhookEvents(db))[0]).toMatchObject({
      status: 'failed', attemptCount: 6, retryCycleAttempts: 6, outcome: 'attempt_failed',
    });
  });

  it('lists with one short-lived client, then processes at most 10 events sequentially without overlap', async () => {
    for (let index = 0; index < 11; index += 1) await receipt(`evt_test_drain_${String(index).padStart(2, '0')}`);
    const listingEnd = vi.fn(async () => {});
    const listingHandle = opened({ end: listingEnd });
    let active = 0;
    let maximumActive = 0;
    const process = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return { state: 'processed', outcome: 'ok' } as ProcessAttemptResult;
    });
    const results = await drainStripeWebhookInbox({
      env: ENV,
      openDb: () => listingHandle,
      now: () => NOW,
      process,
    });
    expect(results).toHaveLength(10);
    expect(process).toHaveBeenCalledTimes(10);
    expect(maximumActive).toBe(1);
    expect(listingHandle.end).toHaveBeenCalledOnce();
    expect(listingEnd.mock.invocationCallOrder[0]).toBeLessThan(process.mock.invocationCallOrder[0]);
  });

  it('stops launching drain attempts at the 25-second pass deadline and is an empty no-op', async () => {
    await receipt('evt_test_drain_deadline_a');
    await receipt('evt_test_drain_deadline_b');
    let current = NOW;
    const process = vi.fn(async () => {
      current = addMs(NOW, STRIPE_ATTEMPT_MS);
      return { state: 'processed', outcome: 'one' } as ProcessAttemptResult;
    });
    const handle = opened();
    expect(await drainStripeWebhookInbox({ env: ENV, openDb: () => handle, now: () => current, process }))
      .toHaveLength(1);
    expect(process).toHaveBeenCalledOnce();

    await sql.unsafe('TRUNCATE church_private.stripe_webhook_events');
    const emptyProcess = vi.fn();
    expect(await drainStripeWebhookInbox({ env: ENV, openDb: () => opened(), now: () => NOW, process: emptyProcess }))
      .toEqual([]);
    expect(emptyProcess).not.toHaveBeenCalled();
  });

  it('aborts the drain when the listing client fails to close and starts no processor clients', async () => {
    await receipt('evt_test_listing_close_failure');
    const process = vi.fn();
    const handle = opened({ end: vi.fn(async () => { throw new Error('listing close failed'); }) });
    await expect(drainStripeWebhookInbox({
      env: ENV,
      openDb: () => handle,
      now: () => NOW,
      process,
    })).rejects.toThrow('listing close failed');
    expect(handle.end).toHaveBeenCalledOnce();
    expect(process).not.toHaveBeenCalled();

    const recoveryProcess = vi.fn();
    const recoveryHandle = opened({
      end: vi.fn(async () => { throw new Error('listing sk_test_processor_secret close failed'); }),
    });
    const retention = vi.fn(async () => ({ processedOrIgnored: 0, failed: 0 }));
    const recovery = await runStripeRecovery({
      env: ENV,
      openDb: () => recoveryHandle,
      now: () => NOW,
      process: recoveryProcess,
      retention,
    });
    expect(recovery.inbox).toEqual({ state: 'failed', error: expect.any(String) });
    expect(JSON.stringify(recovery.inbox)).not.toContain('sk_test_processor_secret');
    expect(recoveryProcess).not.toHaveBeenCalled();
    expect(retention).toHaveBeenCalledOnce();
  });

  it('does not claim Stripe work on D1 and still closes listing and attempt clients', async () => {
    const d1 = opened({ backend: 'd1' });
    expect(await processStripeWebhookEvent('evt_test_d1', { env: ENV, openDb: () => d1 }))
      .toEqual({ state: 'not_claimed' });
    expect(d1.end).toHaveBeenCalledOnce();

    const d1List = opened({ backend: 'd1' });
    expect(await drainStripeWebhookInbox({ env: ENV, openDb: () => d1List })).toEqual([]);
    expect(d1List.end).toHaveBeenCalledOnce();
  });

  it('runs inbox then retention as isolated bounded phases and sanitizes top-level errors', async () => {
    const order: string[] = [];
    const drain = vi.fn(async () => {
      order.push('inbox');
      throw new Error('inbox sk_test_processor_secret\nfailed');
    });
    const retention = vi.fn(async () => {
      order.push('retention');
      throw new Error('retention whsec_processor_secret failed');
    });
    const result = await runStripeRecovery({ env: ENV, drain, retention, now: () => NOW });
    expect(order).toEqual(['inbox', 'retention']);
    expect(result).toEqual({
      inbox: { state: 'failed', error: expect.any(String) },
      retention: { state: 'failed', error: expect.any(String) },
    });
    expect(JSON.stringify(result)).not.toContain('sk_test_processor_secret');
    expect(JSON.stringify(result)).not.toContain('whsec_processor_secret');
    expect(result.inbox.state === 'failed' && result.inbox.error).not.toContain('\n');
  });

  it('redacts the Hyperdrive URL and credential components from recovery phase errors', async () => {
    const hyperdriveEnv: StripeEnv & DbEnv = {
      ...ENV,
      HYPERDRIVE: { connectionString: HYPERDRIVE_CONNECTION },
    };
    const result = await runStripeRecovery({
      env: hyperdriveEnv,
      drain: vi.fn(async () => {
        throw new Error(`recovery ${SECRET_PARTS.join(' ')} unavailable`);
      }),
      retention: vi.fn(async () => ({ processedOrIgnored: 0, failed: 0 })),
      now: () => NOW,
    });
    expect(result.inbox).toEqual({ state: 'failed', error: expect.any(String) });
    const serialized = JSON.stringify(result);
    for (const secret of SECRET_PARTS) expect(serialized).not.toContain(secret);
  });
});
