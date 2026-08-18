import { describe, expect, it, vi } from 'vitest';
import { createLearningManualSyncHandler } from '../src/pages/admin/learning/sync';

const USER = Object.freeze({
  id: 77, role: 'admin', isAdmin: true, isSuperAdmin: false,
  adminAreas: Object.freeze(['learning']), lang: 'en',
});

function request(body = 'course_id=42', headers: Record<string, string> = {}): Request {
  return new Request('https://church.test/admin/learning/sync', {
    method: 'POST', headers: {
      origin: 'https://church.test', 'content-type': 'application/x-www-form-urlencoded', ...headers,
    }, body,
  });
}

function context(req: Request, options: {
  modules?: string[]; user?: object | null; waitUntil?: (promise: Promise<unknown>) => void;
} = {}): never {
  return { request: req, url: new URL(req.url), locals: {
    modules: new Set(options.modules ?? ['learning']), user: options.user === undefined ? USER : options.user,
    db: {}, cfContext: options.waitUntil ? { waitUntil: options.waitUntil } : undefined,
  } } as never;
}

describe('authorized manual Learning sync route', () => {
  it('fails closed before reading for module-off, anonymous, unauthorized, method, and provenance', async () => {
    const start = vi.fn(async () => undefined);
    const handler = createLearningManualSyncHandler({ startBackgroundSync: start });
    expect((await handler(context(request(), { modules: [] }))).status).toBe(404);
    expect((await handler(context(request(), { user: null }))).status).toBe(403);
    expect((await handler(context(request(), { user: { ...USER, adminAreas: [] } }))).status).toBe(403);
    expect((await handler(context(new Request('https://church.test/admin/learning/sync'), { user: USER }))).status).toBe(405);
    expect((await handler(context(request('course_id=42', { origin: 'https://evil.test' })))).status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it('bounds and validates the exact form before scheduling', async () => {
    const start = vi.fn(async () => undefined);
    const handler = createLearningManualSyncHandler({ startBackgroundSync: start });
    expect((await handler(context(request('course_id=42&extra=x')))).status).toBe(303);
    expect((await handler(context(request(`course_id=${'9'.repeat(70_000)}`)))).status).toBe(413);
    expect((await handler(context(request('course_id=0')))).status).toBe(303);
    expect(start).not.toHaveBeenCalled();
  });

  it('hands an independent, handled background promise to waitUntil and redirects immediately', async () => {
    let release!: () => void;
    const background = new Promise<void>((resolve) => { release = resolve; });
    const start = vi.fn(() => background);
    let scheduled: Promise<unknown> | undefined;
    const response = await createLearningManualSyncHandler({ startBackgroundSync: start })(
      context(request(), { waitUntil: (promise) => { scheduled = promise; } }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/learning?saved=sync_started');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(start).toHaveBeenCalledWith({ courseId: 42, trigger: 'manual' });
    expect(scheduled).toBeInstanceOf(Promise);
    release();
    await expect(scheduled).resolves.toBeUndefined();
  });

  it('does not start work without a usable execution context', async () => {
    const start = vi.fn(async () => undefined);
    const response = await createLearningManualSyncHandler({ startBackgroundSync: start })(context(request()));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/learning?error=sync_unavailable');
    expect(start).not.toHaveBeenCalled();
  });
});
