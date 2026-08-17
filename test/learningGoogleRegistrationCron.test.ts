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

  it('imports the server key ring and runs one bounded, no-backoff renewal drain', async () => {
    const keyRing = { currentVersion: 1, keys: new Map() } as never;
    const importKeyRing = vi.fn(async () => keyRing);
    const renew = vi.fn(async () => ({ selected: 2, renewed: 1, conflicted: 1, failed: 0 }));
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
      signal: expect.any(AbortSignal),
    });
  });
});
