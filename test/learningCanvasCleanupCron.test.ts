import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import { runCanvasDisconnectCleanupPass } from '../src/lib/learningCanvasCleanupCron';
import { clearModuleCache } from '../src/lib/modules';
import { setSetting } from '../src/lib/settings';

const COMPLETE_ENV = Object.freeze({
  DB_BACKEND: 'd1',
  CANVAS_OAUTH_CLIENT_ID: 'canvas-client',
  CANVAS_OAUTH_CLIENT_SECRET: 'canvas-secret',
  CANVAS_ALLOWED_ORIGINS: '["https://canvas.church.example"]',
  LEARNING_CREDENTIAL_KEYS: 'private-key-ring',
});

describe('production Canvas disconnect cleanup pass', () => {
  beforeEach(async () => {
    await setSetting(env.DB, 'module.learning', '1');
    clearModuleCache();
  });

  it('runs at most one bounded durable cleanup task with parsed exact origins', async () => {
    const keyRing = { currentVersion: 1 } as never;
    const importKeyRing = vi.fn(async () => keyRing);
    const list = vi.fn(async (_db: AppDb, _limit: number) => [28302] as const);
    const recover = vi.fn(async (_db: AppDb, _input: unknown) => ({ selected: 1, cleaned: 0, pending: 1 }));
    const fetcher = vi.fn();
    await expect(runCanvasDisconnectCleanupPass(COMPLETE_ENV, env.DB as AppDb, {
      fetcher, now: () => Date.parse('2026-08-17T12:00:00.000Z'), importKeyRing,
      listCleanupConnectionIds: list, recoverCleanup: recover,
    })).resolves.toEqual({ status: 'completed', summary: { selected: 1, cleaned: 0, pending: 1 } });
    expect(list).toHaveBeenCalledOnce();
    expect(list.mock.calls[0]?.[0] === env.DB).toBe(true);
    expect(list.mock.calls[0]?.[1]).toBe(1);
    expect(recover).toHaveBeenCalledOnce();
    expect(recover.mock.calls[0]?.[0] === env.DB).toBe(true);
    expect(recover.mock.calls[0]?.[1]).toEqual({
      connectionId: 28302, clientId: 'canvas-client', clientSecret: 'canvas-secret',
      allowedOrigins: Object.freeze(['https://canvas.church.example']), keyRing, fetcher,
      signal: expect.any(AbortSignal), now: expect.any(Function),
    });
  });

  it('skips credentials and database work when configuration is absent', async () => {
    const importKeyRing = vi.fn();
    const list = vi.fn();
    await expect(runCanvasDisconnectCleanupPass({ DB_BACKEND: 'd1' }, env.DB as AppDb, {
      fetcher: vi.fn(), now: Date.now, importKeyRing,
      listCleanupConnectionIds: list, recoverCleanup: vi.fn(),
    })).resolves.toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(importKeyRing).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});
