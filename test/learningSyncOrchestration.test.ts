import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  LEARNING_SYNC_RUN_LIMITS,
  listLearningSyncTargets,
  runLearningSyncWithRetry,
  runScheduledLearningSyncPass,
} from '../src/lib/learningSyncOrchestration';
import { LearningSynchronizationError } from '../src/lib/learningSync';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

describe('bounded Learning synchronization orchestration', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM learning_courses WHERE id BETWEEN 31001 AND 31009').run();
    await env.DB.prepare('DELETE FROM learning_programs WHERE id BETWEEN 31001 AND 31009').run();
    await env.DB.prepare('DELETE FROM learning_provider_connections WHERE id BETWEEN 31001 AND 31009').run();
    await env.DB.prepare("DELETE FROM people WHERE id=31001").run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(31001,'Orchestration Admin','orchestration@example.test')").run();
    await env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id) VALUES
      (31002,'google_classroom','Classroom',NULL,'active',1,31001),
      (31003,'canvas','Canvas','https://canvas.learning.test','active',1,31001),
      (31004,'google_classroom','Disconnected',NULL,'disabled',2,31001)`).run();
    await env.DB.prepare(`INSERT INTO learning_programs(id,slug,display_name,status) VALUES
      (31002,'scheduled-active','Scheduled active','active'),
      (31003,'scheduled-archived','Scheduled archived','archived')`).run();
    await env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url,lifecycle_state,last_synced_at)
      VALUES
      (31002,31002,31002,'google_classroom','course-old','Old course','https://classroom.google.com/c/old','active','2026-08-17T10:00:00.000Z'),
      (31003,31002,31003,'canvas','course-new','New course','https://canvas.learning.test/courses/3','active','2026-08-18T10:00:00.000Z'),
      (31004,31002,31004,'google_classroom','course-disabled','Disabled course','https://classroom.google.com/c/off','active',NULL),
      (31005,31003,31002,'google_classroom','course-archived-program','Archived program','https://classroom.google.com/c/a','active',NULL),
      (31006,31002,31002,'google_classroom','course-deleted','Deleted course','https://classroom.google.com/c/d','deleted',NULL)`).run();
  });

  it('selects only active mapped graphs in deterministic oldest-first order and exact manual scope', async () => {
    expect(await listLearningSyncTargets(env.DB as AppDb, { limit: 2 })).toEqual([
      { courseId: 31002, connectionId: 31002, provider: 'google_classroom', externalCourseId: 'course-old' },
      { courseId: 31003, connectionId: 31003, provider: 'canvas', externalCourseId: 'course-new' },
    ]);
    expect(await listLearningSyncTargets(env.DB as AppDb, { courseId: 31003, limit: 1 }))
      .toEqual([{ courseId: 31003, connectionId: 31003, provider: 'canvas', externalCourseId: 'course-new' }]);
    expect(await listLearningSyncTargets(env.DB as AppDb, { courseId: 31004, limit: 1 })).toEqual([]);
    await env.DB.prepare("UPDATE learning_provider_connections SET deleted_at='2026-08-18T12:00:00.000Z' WHERE id=31004").run();
    expect(await listLearningSyncTargets(env.DB as AppDb, { courseId: 31004, limit: 1 })).toEqual([]);
  });

  it('retries only transient 429/5xx failures with bounded Retry-After and safe metadata logs', async () => {
    let current = NOW;
    const sleep = vi.fn(async (milliseconds: number) => { current += milliseconds; });
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new LearningSynchronizationError('rate_limited', 'google_classroom', {
        httpStatus: 429, retryAfterSeconds: 999,
      }))
      .mockResolvedValueOnce({ status: 'succeeded' });
    const logs: unknown[] = [];
    await expect(runLearningSyncWithRetry({
      provider: 'google_classroom', trigger: 'scheduled', signal: new AbortController().signal,
    }, { now: () => current, reconcile, sleep, log: (entry) => logs.push(entry) }))
      .resolves.toMatchObject({ attempts: 2, status: 'succeeded' });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenNthCalledWith(1, expect.any(AbortSignal), 1);
    expect(reconcile).toHaveBeenNthCalledWith(2, expect.any(AbortSignal), 2);
    expect(sleep).toHaveBeenCalledWith(LEARNING_SYNC_RUN_LIMITS.maxBackoffMs, expect.any(AbortSignal));
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'learning_sync_retry', provider: 'google_classroom', trigger: 'scheduled', attempt: 1, errorCode: 'rate_limited', httpStatus: 429 }),
      expect.objectContaining({ event: 'learning_sync_complete', attempts: 2, status: 'succeeded' }),
    ]));
    expect(JSON.stringify(logs)).not.toMatch(/course-old|https:|token|Orchestration Admin|3100/);
  });

  it.each([
    new LearningSynchronizationError('authentication_required', 'canvas', { httpStatus: 401, retryAfterSeconds: null }),
    new LearningSynchronizationError('permission_denied', 'canvas', { httpStatus: 403, retryAfterSeconds: null }),
    new LearningSynchronizationError('rate_limited', 'canvas', { httpStatus: 400, retryAfterSeconds: 1 }),
  ])('never retries permanent failures and requests reconnect only for auth failures', async (failure) => {
    const reconnect = vi.fn(async () => undefined);
    const reconcile = vi.fn(async () => { throw failure; });
    await expect(runLearningSyncWithRetry({
      provider: 'canvas', trigger: 'notification', signal: new AbortController().signal,
    }, { now: () => NOW, reconcile, sleep: vi.fn(), markReconnectRequired: reconnect }))
      .rejects.toBe(failure);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconnect).toHaveBeenCalledTimes(
      failure.code === 'authentication_required' || failure.code === 'permission_denied' ? 1 : 0,
    );
  });

  it('honors caller cancellation and one total deadline across retry/backoff', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const never = vi.fn(async () => ({ status: 'succeeded' }));
    await expect(runLearningSyncWithRetry({
      provider: 'canvas', trigger: 'manual', signal: cancelled.signal,
    }, { now: () => NOW, reconcile: never, sleep: vi.fn() }))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(never).not.toHaveBeenCalled();

    let current = NOW;
    const failure = new LearningSynchronizationError('provider_unavailable', 'canvas', {
      httpStatus: 503, retryAfterSeconds: 1,
    });
    const reconcile = vi.fn(async () => { current += LEARNING_SYNC_RUN_LIMITS.maxElapsedMs; throw failure; });
    await expect(runLearningSyncWithRetry({
      provider: 'canvas', trigger: 'scheduled', signal: new AbortController().signal,
    }, { now: () => current, reconcile, sleep: vi.fn() }))
      .rejects.toMatchObject({ code: 'timeout' });
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('gates scheduled scans on the Learning module and processes only one enabled target', async () => {
    const reconcileTarget = vi.fn(async () => ({ status: 'succeeded' as const, attempts: 1 }));
    const enabled = await runScheduledLearningSyncPass({} as never, env.DB as AppDb, {
      learningEnabled: vi.fn(async () => true), reconcileTarget,
    });
    expect(enabled).toEqual({ scanned: 1, attempted: 1, succeeded: 1, failed: 0 });
    expect(reconcileTarget).toHaveBeenCalledOnce();
    expect(reconcileTarget).toHaveBeenCalledWith(expect.objectContaining({
      courseId: 31002, trigger: 'scheduled', maxProviderPages: LEARNING_SYNC_RUN_LIMITS.googleMaxPagesPerAttempt,
    }));

    reconcileTarget.mockClear();
    expect(await runScheduledLearningSyncPass({} as never, env.DB as AppDb, {
      learningEnabled: vi.fn(async () => false), reconcileTarget,
    })).toEqual({ scanned: 0, attempted: 0, succeeded: 0, failed: 0 });
    expect(reconcileTarget).not.toHaveBeenCalled();
  });

  it('records every scheduled attempt so one failing oldest course cannot starve the next course', async () => {
    const attempted: number[] = [];
    let current = NOW;
    const reconcileTarget = vi.fn(async (input: { readonly courseId: number }) => {
      attempted.push(input.courseId);
      throw new LearningSynchronizationError('provider_unavailable', 'google_classroom', {
        httpStatus: 503, retryAfterSeconds: null,
      });
    });
    const dependencies = {
      learningEnabled: vi.fn(async () => true),
      reconcileTarget,
      now: () => current,
    };
    await expect(runScheduledLearningSyncPass({} as never, env.DB as AppDb, dependencies))
      .resolves.toEqual({ scanned: 1, attempted: 1, succeeded: 0, failed: 1 });
    current += 60_000;
    await expect(runScheduledLearningSyncPass({} as never, env.DB as AppDb, dependencies))
      .resolves.toEqual({ scanned: 1, attempted: 1, succeeded: 0, failed: 1 });
    expect(attempted).toEqual([31002, 31003]);
    expect(await env.DB.prepare(`SELECT id,last_sync_attempt_at FROM learning_courses
      WHERE id IN (31002,31003) ORDER BY id`).all()).toMatchObject({ results: [
      { id: 31002, last_sync_attempt_at: '2026-08-18T12:00:00.000Z' },
      { id: 31003, last_sync_attempt_at: '2026-08-18T12:01:00.000Z' },
    ] });
  });
});
