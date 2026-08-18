import { describe, expect, it, vi } from 'vitest';
import { hasValidMutationProvenance } from '../src/lib/csrf';
import type { AcceptedCanvasLiveEvent } from '../src/lib/learningCanvasLiveEvents';
import { moduleForPath } from '../src/lib/modules';
import { createCanvasLiveEventsHandler } from '../src/pages/api/learning/canvas/live-events';

const PATH = '/api/learning/canvas/live-events';
const TOKEN = 'eyJraWQiOiJrMSIsImFsZyI6IlJTMjU2In0.e30.signature';

function context(request: Request, modules: string[] = ['learning'], db: object = {}, waitUntil = vi.fn()): never {
  return {
    request, url: new URL(request.url),
    locals: { modules: new Set(modules), user: null, db, cfContext: { waitUntil } },
  } as never;
}

function request(body = TOKEN, headers: Record<string, string> = {}): Request {
  return new Request(`https://church.test${PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/jwt', ...headers }, body,
  });
}

const deps = () => ({
  now: vi.fn(() => Date.parse('2026-08-17T12:00:00.000Z')),
  verifyEvent: vi.fn(async () => ({
    sourceEventId: `sha256:${'a'.repeat(43)}`, rootAccountId: 'root-1',
    sourceHostname: 'canvas.church.example', externalCourseId: 'course-1',
    eventName: 'assignment_updated', eventTime: '2026-08-17T11:59:59.000Z',
    receivedAt: '2026-08-17T12:00:00.000Z',
  })),
  acceptEvent: vi.fn(async (): Promise<AcceptedCanvasLiveEvent> => ({
    connectionId: 28202, sourceEventId: `sha256:${'a'.repeat(43)}`,
    externalCourseId: 'course-1', disposition: 'claimed' as const,
    claimMarker: '10000000-0000-4000-8000-000000000001', attemptCount: 1,
  })),
  reconcileCourse: vi.fn(async () => undefined),
  finishEvent: vi.fn(async () => undefined),
  openBackgroundDb: vi.fn(() => ({ db: { background: true }, end: vi.fn(async () => undefined) })),
});

describe('Canvas signed Live Events HTTP boundary', () => {
  it('exempts only the exact signature-authenticated route from browser CSRF provenance', () => {
    expect(moduleForPath(PATH)).toBe('learning');
    expect(hasValidMutationProvenance(request())).toBe(true);
    for (const path of [
      `${PATH}/`, `${PATH}-near`, '/api/learning/canvas/Live-Events',
      '/api/learning/canvas/%6cive-events',
    ]) expect(hasValidMutationProvenance(new Request(`https://church.test${path}`, {
      method: 'POST', body: TOKEN,
    }))).toBe(false);
  });

  it('checks module, method, media type, and declared size before pulling the signed body', async () => {
    let pulled = false;
    const unread = (contentType: string, contentLength?: string): Request => new Request(`https://church.test${PATH}`, {
      method: 'POST', headers: {
        'content-type': contentType, ...(contentLength ? { 'content-length': contentLength } : {}),
      }, body: new ReadableStream({ pull() { pulled = true; throw new Error('must not read'); } }, { highWaterMark: 0 }),
    });
    const injected = deps();
    expect((await createCanvasLiveEventsHandler(injected)(context(unread('application/jwt'), []))).status).toBe(404);
    expect(pulled).toBe(false);
    expect((await createCanvasLiveEventsHandler(injected)(context(unread('text/plain')))).status).toBe(415);
    expect((await createCanvasLiveEventsHandler(injected)(context(unread('application/jwt', '65537')))).status).toBe(413);
    expect(pulled).toBe(false);
    expect(injected.verifyEvent).not.toHaveBeenCalled();
  });

  it('verifies and deduplicates before fast ACK, then reconciles on an independently drained waitUntil DB', async () => {
    const injected = deps();
    let release!: () => void;
    injected.reconcileCourse.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    let background: Promise<unknown> | undefined;
    const response = await createCanvasLiveEventsHandler(injected)(context(request(), ['learning'], {}, (promise) => { background = promise; }));
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
    expect(injected.verifyEvent).toHaveBeenCalledWith({
      compactJwt: TOKEN, receivedAt: '2026-08-17T12:00:00.000Z',
    });
    expect(injected.acceptEvent).toHaveBeenCalledWith({}, expect.objectContaining({
      sourceEventId: `sha256:${'a'.repeat(43)}`, externalCourseId: 'course-1',
    }));
    expect(injected.reconcileCourse).toHaveBeenCalledWith({ background: true }, {
      connectionId: 28202, externalCourseId: 'course-1', trigger: 'notification',
      signal: expect.any(AbortSignal),
    });
    expect(injected.finishEvent).not.toHaveBeenCalled();
    release();
    await expect(background).resolves.toBeUndefined();
    expect(injected.finishEvent).toHaveBeenCalledWith({ background: true }, expect.objectContaining({ outcome: 'succeeded' }));
  });

  it('returns no diagnostic body for invalid signatures, malformed streams, and oversized JWTs', async () => {
    const injected = deps();
    injected.verifyEvent.mockRejectedValueOnce(new Error('signature details'));
    expect((await createCanvasLiveEventsHandler(injected)(context(request()))).status).toBe(401);
    expect((await createCanvasLiveEventsHandler(deps())(context(request('x'.repeat(65_537))))).status).toBe(413);
    const brokenCancel = vi.fn(async () => undefined);
    const broken = request();
    Object.defineProperty(broken, 'body', { value: {
      getReader: () => ({
        read: () => Promise.reject(new Error('private raw')),
        cancel: brokenCancel,
      }),
    } });
    expect((await createCanvasLiveEventsHandler(deps())(context(broken))).status).toBe(400);
    expect(brokenCancel).toHaveBeenCalledOnce();

    const oversizedCancel = vi.fn();
    const oversized = new Request(`https://church.test${PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/jwt' },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(65_537));
          return new Promise(() => undefined);
        },
        cancel: oversizedCancel,
      }),
    });
    expect((await createCanvasLiveEventsHandler(deps())(context(oversized))).status).toBe(413);
    expect(oversizedCancel).toHaveBeenCalledOnce();
  });

  it('times out and cancels a never-resolving body without Content-Length before verification or DB', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-17T12:00:00.000Z'));
    const cancelled = vi.fn();
    const injected = deps();
    try {
      const stalled = new Request(`https://church.test${PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/jwt' },
        body: new ReadableStream<Uint8Array>({
          pull: () => new Promise(() => undefined),
          cancel: cancelled,
        }),
      });
      expect(stalled.headers.get('content-length')).toBeNull();
      const outcome = Promise.resolve(createCanvasLiveEventsHandler(injected)(context(stalled)));
      await vi.advanceTimersByTimeAsync(10_001);
      const result = await Promise.race([outcome, Promise.resolve('pending')]);
      if (!(result instanceof Response)) throw new Error('body deadline did not settle');
      expect(result.status).toBe(408);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(result.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await result.text()).toBe('');
      expect(cancelled).toHaveBeenCalledOnce();
      expect(injected.verifyEvent).not.toHaveBeenCalled();
      expect(injected.acceptEvent).not.toHaveBeenCalled();
      expect(injected.reconcileCourse).not.toHaveBeenCalled();
      expect(injected.finishEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses one absolute body deadline across a slow drip and handles the late pull without rejection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-17T12:00:00.000Z'));
    const cancelled = vi.fn();
    const injected = deps();
    let stopped = false;
    try {
      const drip = new Request(`https://church.test${PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/jwt' },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            return new Promise<void>((resolve) => setTimeout(() => {
              if (!stopped) controller.enqueue(new TextEncoder().encode('jwt.'));
              resolve();
            }, 6_000));
          },
          cancel() { stopped = true; cancelled(); },
        }),
      });
      const pending = Promise.resolve(createCanvasLiveEventsHandler(injected)(context(drip)));
      const outcome = pending.then((result) => result.status);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe(408);
      expect(cancelled).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(injected.verifyEvent).not.toHaveBeenCalled();
      expect(injected.acceptEvent).not.toHaveBeenCalled();
      expect(injected.reconcileCourse).not.toHaveBeenCalled();
      expect(injected.finishEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('combines parent abort with the owned body reader and cancels before verification or DB', async () => {
    const parent = new AbortController();
    const cancelled = vi.fn();
    const injected = deps();
    const stalled = new Request(`https://church.test${PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/jwt' }, signal: parent.signal,
      body: new ReadableStream<Uint8Array>({
        pull: () => new Promise(() => undefined),
        cancel: cancelled,
      }),
    });
    const pending = Promise.resolve(createCanvasLiveEventsHandler(injected)(context(stalled)));
    const outcome = pending.then((result) => result.status);
    await Promise.resolve();
    parent.abort();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(await outcome).toBe(400);
    expect(injected.verifyEvent).not.toHaveBeenCalled();
    expect(injected.acceptEvent).not.toHaveBeenCalled();
    expect(injected.reconcileCourse).not.toHaveBeenCalled();
    expect(injected.finishEvent).not.toHaveBeenCalled();
  });

  it('deduplicates success and keeps failed or concurrent reconciliation retryable', async () => {
    const succeeded = deps();
    succeeded.acceptEvent.mockResolvedValueOnce({
      connectionId: 28202, sourceEventId: `sha256:${'a'.repeat(43)}`,
      externalCourseId: 'course-1', disposition: 'succeeded', claimMarker: null, attemptCount: 1,
    });
    expect((await createCanvasLiveEventsHandler(succeeded)(context(request()))).status).toBe(204);
    expect(succeeded.reconcileCourse).not.toHaveBeenCalled();
    expect(succeeded.finishEvent).not.toHaveBeenCalled();

    const concurrent = deps();
    concurrent.acceptEvent.mockResolvedValueOnce({
      connectionId: 28202, sourceEventId: `sha256:${'a'.repeat(43)}`,
      externalCourseId: 'course-1', disposition: 'in_progress', claimMarker: null, attemptCount: 1,
    });
    expect((await createCanvasLiveEventsHandler(concurrent)(context(request()))).status).toBe(503);

    const failed = deps();
    failed.reconcileCourse.mockRejectedValueOnce(new Error('provider private response'));
    let background: Promise<unknown> | undefined;
    expect((await createCanvasLiveEventsHandler(failed)(context(request(), ['learning'], {}, (promise) => { background = promise; }))).status).toBe(204);
    await expect(background).resolves.toBeUndefined();
    expect(failed.finishEvent).toHaveBeenCalledWith({ background: true }, expect.objectContaining({ outcome: 'failed' }));
  });
});
