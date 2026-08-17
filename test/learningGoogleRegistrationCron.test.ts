import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import { clearModuleCache } from '../src/lib/modules';
import { runGoogleClassroomRegistrationRenewalPass } from '../src/lib/learningGoogleRegistrationCron';
import { setSetting } from '../src/lib/settings';

const COMPLETE_ENV = Object.freeze({
  DB_BACKEND: 'd1',
  GOOGLE_CLASSROOM_CLIENT_ID: 'client.apps.googleusercontent.com',
  GOOGLE_CLASSROOM_CLIENT_SECRET: 'private-client-secret',
  GOOGLE_CLASSROOM_PUBSUB_TOPIC: 'projects/church-project/topics/classroom',
  GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL: 'classroom-push@church-project.iam.gserviceaccount.com',
  GOOGLE_PUBSUB_SUBSCRIPTION_NAME: 'projects/church-project/subscriptions/classroom',
  LEARNING_CREDENTIAL_KEYS: 'private-key-ring',
});

describe('production Google Classroom registration renewal pass', () => {
  beforeEach(async () => {
    await setSetting(env.DB, 'module.learning', '1');
    clearModuleCache();
  });

  it('skips before credential import when required server configuration is absent', async () => {
    const importKeyRing = vi.fn();
    const renew = vi.fn();
    await expect(runGoogleClassroomRegistrationRenewalPass({ DB_BACKEND: 'd1' }, env.DB as AppDb, {
      fetcher: vi.fn(), now: () => Date.parse('2026-08-17T12:00:00.000Z'),
      importKeyRing, renew,
    })).resolves.toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(importKeyRing).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
  });

  it('skips all credentials and provider I/O when the Learning module is off', async () => {
    await setSetting(env.DB, 'module.learning', '0');
    clearModuleCache();
    const importKeyRing = vi.fn();
    const renew = vi.fn();
    await expect(runGoogleClassroomRegistrationRenewalPass(COMPLETE_ENV, env.DB as AppDb, {
      fetcher: vi.fn(), now: () => Date.parse('2026-08-17T12:00:00.000Z'),
      importKeyRing, renew,
    })).resolves.toEqual({ status: 'skipped', reason: 'module_disabled' });
    expect(importKeyRing).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
  });

  it('does not renew registrations for a removed or incomplete current push binding', async () => {
    const keyRing = { currentVersion: 1, keys: new Map() } as never;
    const importKeyRing = vi.fn(async () => keyRing);
    const renew = vi.fn();
    const listCleanupConnectionIds = vi.fn(async (_db: AppDb, _limit: number) => [27302] as const);
    const recoverCleanup = vi.fn(async (_db: AppDb, _input: unknown) => ({
      selected: 1, cleaned: 1, pending: 0, finalizedDisconnect: true,
    }));
    await expect(runGoogleClassroomRegistrationRenewalPass({
      DB_BACKEND: 'd1',
      GOOGLE_CLASSROOM_CLIENT_ID: 'client.apps.googleusercontent.com',
      GOOGLE_CLASSROOM_CLIENT_SECRET: 'private-client-secret',
      LEARNING_CREDENTIAL_KEYS: 'private-key-ring',
    }, env.DB as AppDb, {
      fetcher: vi.fn(), now: () => Date.parse('2026-08-17T12:00:00.000Z'),
      importKeyRing, renew, listCleanupConnectionIds, recoverCleanup,
    })).resolves.toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(importKeyRing).toHaveBeenCalledWith('private-key-ring');
    expect(listCleanupConnectionIds).toHaveBeenCalledTimes(1);
    expect(listCleanupConnectionIds.mock.calls[0]?.[0] === env.DB).toBe(true);
    expect(listCleanupConnectionIds.mock.calls[0]?.[1]).toBe(1);
    expect(recoverCleanup).toHaveBeenCalledTimes(1);
    expect(recoverCleanup.mock.calls[0]?.[0] === env.DB).toBe(true);
    expect(recoverCleanup.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      connectionId: 27302, keyRing, limit: 1,
    }));
    expect(renew).not.toHaveBeenCalled();
  });

  it('imports the server key ring and runs one bounded, no-backoff renewal drain', async () => {
    const keyRing = { currentVersion: 1, keys: new Map() } as never;
    const importKeyRing = vi.fn(async () => keyRing);
    const renew = vi.fn(async (..._args: [AppDb, unknown]) => (
      { selected: 2, renewed: 1, conflicted: 1, failed: 0 }
    ));
    const fetcher = vi.fn();
    await expect(runGoogleClassroomRegistrationRenewalPass(COMPLETE_ENV, env.DB as AppDb, {
      fetcher, now: () => Date.parse('2026-08-17T12:00:00.000Z'), importKeyRing, renew,
    })).resolves.toEqual({
      status: 'completed', summary: { selected: 2, renewed: 1, conflicted: 1, failed: 0 },
    });
    expect(importKeyRing).toHaveBeenCalledWith('private-key-ring');
    expect(renew).toHaveBeenCalledTimes(1);
    const call = renew.mock.calls[0];
    expect(call?.[0] === env.DB).toBe(true);
    expect(call?.[1]).toEqual({
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing, fetcher, nowEpochMs: Date.parse('2026-08-17T12:00:00.000Z'),
      topicName: 'projects/church-project/topics/classroom',
      signal: expect.any(AbortSignal),
    });
  });

  it('reserves one durable cleanup task and still renews when cleanup remains pending', async () => {
    const keyRing = { currentVersion: 1, keys: new Map() } as never;
    const importKeyRing = vi.fn(async () => keyRing);
    const renew = vi.fn(async () => ({ selected: 8, renewed: 8, conflicted: 0, failed: 0 }));
    const listCleanupConnectionIds = vi.fn(async (_db: AppDb, _limit: number) => [27302] as const);
    const recoverCleanup = vi.fn(async (_db: AppDb, _input: unknown) => ({
      selected: 1, cleaned: 0, pending: 1, finalizedDisconnect: false,
    }));
    const fetcher = vi.fn();
    await expect(runGoogleClassroomRegistrationRenewalPass(COMPLETE_ENV, env.DB as AppDb, {
      fetcher, now: () => Date.parse('2026-08-17T12:00:00.000Z'), importKeyRing, renew,
      listCleanupConnectionIds, recoverCleanup,
    })).resolves.toEqual({
      status: 'completed', summary: { selected: 8, renewed: 8, conflicted: 0, failed: 0 },
    });
    expect(listCleanupConnectionIds).toHaveBeenCalledTimes(1);
    expect(listCleanupConnectionIds.mock.calls[0]?.[0] === env.DB).toBe(true);
    expect(listCleanupConnectionIds.mock.calls[0]?.[1]).toBe(1);
    expect(recoverCleanup).toHaveBeenCalledTimes(1);
    expect(recoverCleanup.mock.calls[0]?.[0] === env.DB).toBe(true);
    expect(recoverCleanup.mock.calls[0]?.[1]).toEqual({
      connectionId: 27302,
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing, fetcher, nowEpochMs: Date.parse('2026-08-17T12:00:00.000Z'),
      signal: expect.any(AbortSignal), limit: 1,
    });
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('continues the reserved renewal drain when persistent cleanup throws safely', async () => {
    const keyRing = { currentVersion: 1, keys: new Map() } as never;
    const renew = vi.fn(async () => ({ selected: 2, renewed: 2, conflicted: 0, failed: 0 }));
    await expect(runGoogleClassroomRegistrationRenewalPass(COMPLETE_ENV, env.DB as AppDb, {
      fetcher: vi.fn(), now: () => Date.parse('2026-08-17T12:00:00.000Z'),
      importKeyRing: vi.fn(async () => keyRing), renew,
      listCleanupConnectionIds: vi.fn(async () => [27302] as const),
      recoverCleanup: vi.fn(async () => { throw new Error('private provider failure'); }),
    })).resolves.toEqual({
      status: 'completed', summary: { selected: 2, renewed: 2, conflicted: 0, failed: 0 },
    });
    expect(renew).toHaveBeenCalledTimes(1);
  });
});
