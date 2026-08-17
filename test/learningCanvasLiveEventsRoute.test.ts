import { describe, expect, it, vi } from 'vitest';
import { hasValidMutationProvenance } from '../src/lib/csrf';
import { moduleForPath } from '../src/lib/modules';
import { createCanvasLiveEventsHandler } from '../src/pages/api/learning/canvas/live-events';

const PATH = '/api/learning/canvas/live-events';
const TOKEN = 'eyJraWQiOiJrMSIsImFsZyI6IlJTMjU2In0.e30.signature';

function context(request: Request, modules: string[] = ['learning'], db: object = {}): never {
  return {
    request, url: new URL(request.url),
    locals: { modules: new Set(modules), user: null, db, cfContext: { waitUntil: vi.fn() } },
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
  acceptEvent: vi.fn(async () => ({
    connectionId: 28202, sourceEventId: `sha256:${'a'.repeat(43)}`,
    externalCourseId: 'course-1', disposition: 'claimed' as const,
    claimMarker: '10000000-0000-4000-8000-000000000001', attemptCount: 1,
  })),
  reconcileCourse: vi.fn(async () => undefined),
  finishEvent: vi.fn(async () => undefined),
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

  it('verifies the bounded JWT before DB binding and authoritative reconcile', async () => {
    const injected = deps();
    const response = await createCanvasLiveEventsHandler(injected)(context(request()));
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
    expect(injected.verifyEvent).toHaveBeenCalledWith({
      compactJwt: TOKEN, receivedAt: '2026-08-17T12:00:00.000Z',
    });
    expect(injected.acceptEvent).toHaveBeenCalledWith({}, expect.objectContaining({
      sourceEventId: `sha256:${'a'.repeat(43)}`, externalCourseId: 'course-1',
    }));
    expect(injected.reconcileCourse).toHaveBeenCalledWith({}, {
      connectionId: 28202, externalCourseId: 'course-1', trigger: 'notification',
      signal: expect.any(AbortSignal),
    });
    expect(injected.finishEvent).toHaveBeenCalledWith({}, expect.objectContaining({ outcome: 'succeeded' }));
  });

  it('returns no diagnostic body for invalid signatures, malformed streams, and oversized JWTs', async () => {
    const injected = deps();
    injected.verifyEvent.mockRejectedValueOnce(new Error('signature details'));
    expect((await createCanvasLiveEventsHandler(injected)(context(request()))).status).toBe(401);
    expect((await createCanvasLiveEventsHandler(deps())(context(request('x'.repeat(65_537))))).status).toBe(413);
    const broken = request();
    Object.defineProperty(broken, 'body', { value: new ReadableStream({ pull() { throw new Error('private raw'); } }) });
    expect((await createCanvasLiveEventsHandler(deps())(context(broken))).status).toBe(400);
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
    expect((await createCanvasLiveEventsHandler(failed)(context(request()))).status).toBe(503);
    expect(failed.finishEvent).toHaveBeenCalledWith({}, expect.objectContaining({ outcome: 'failed' }));
  });
});
