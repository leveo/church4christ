import { describe, expect, it, vi } from 'vitest';
import { hasValidMutationProvenance } from '../src/lib/csrf';
import { moduleForPath } from '../src/lib/modules';
import {
  createGooglePubSubPushHandler,
} from '../src/pages/api/learning/google/pubsub';

const SUBSCRIPTION = 'projects/church-project/subscriptions/classroom';

function context(request: Request, modules: string[] = ['learning']): never {
  return {
    request,
    url: new URL(request.url),
    locals: { modules: new Set(modules), user: null, db: {}, cfContext: { waitUntil: vi.fn() } },
  } as never;
}

function body(): string {
  return JSON.stringify({
    message: {
      attributes: { registrationId: 'registration-1' },
      data: btoa(JSON.stringify({
        collection: 'courses.courseWork', eventType: 'CREATED',
        resourceId: { courseId: 'course-1', id: 'work-1' },
      })),
      messageId: 'message-1', publishTime: '2026-08-17T11:59:59.000Z',
    },
    subscription: SUBSCRIPTION,
  });
}

function documentedWrappedBody(): string {
  return JSON.stringify({
    deliveryAttempt: 5,
    message: {
      attributes: { registrationId: 'registration-1' },
      data: btoa(JSON.stringify({
        collection: 'courses.courseWork', eventType: 'CREATED',
        resourceId: { courseId: 'course-1', id: 'work-1' },
      })),
      messageId: 'message-1',
      message_id: 'message-1',
      orderingKey: 'course-1',
      publishTime: '2026-08-17T11:59:59.000Z',
      publish_time: '2026-08-17T11:59:59.000Z',
    },
    subscription: SUBSCRIPTION,
  });
}

const deps = () => ({
  audience: 'https://church.test/api/learning/google/pubsub',
  serviceAccountEmail: 'classroom-push@church-project.iam.gserviceaccount.com',
  subscriptionName: SUBSCRIPTION,
  now: vi.fn(() => Date.parse('2026-08-17T12:00:00.000Z')),
  verifyAuthorization: vi.fn(async () => ({ subject: '123', email: 'classroom-push@church-project.iam.gserviceaccount.com' })),
  acceptDelivery: vi.fn(async () => ({
    connectionId: 81, externalCourseId: 'course-1', disposition: 'claimed' as const,
    subscriptionName: SUBSCRIPTION, messageId: 'message-1', claimMarker: '10000000-0000-4000-8000-000000000001',
    attemptCount: 1,
  })),
  finishDelivery: vi.fn(async () => undefined),
  reconcileCourse: vi.fn(async () => undefined),
});

describe('Google Pub/Sub HTTP push boundary', () => {
  it('exempts only the exact OIDC-authenticated push path from browser CSRF provenance', () => {
    expect(moduleForPath('/api/learning/google/pubsub')).toBe('learning');
    expect(hasValidMutationProvenance(new Request('https://church.test/api/learning/google/pubsub', { method: 'POST' }))).toBe(true);
    for (const path of [
      '/api/learning/google/pubsub/', '/api/learning/google/pubsub-near',
      '/api/learning/google/PubSub', '/api/learning/google/%70ubsub',
    ]) expect(hasValidMutationProvenance(new Request(`https://church.test${path}`, { method: 'POST' }))).toBe(false);
  });

  it('checks module, method, content headers, and OIDC before reading the body', async () => {
    let pulled = false;
    const request = new Request('https://church.test/api/learning/google/pubsub', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      body: new ReadableStream({ pull() { pulled = true; throw new Error('must not read'); } }, { highWaterMark: 0 }),
    });
    const injected = deps();
    expect((await createGooglePubSubPushHandler(injected)(context(request, []))).status).toBe(404);
    expect(injected.verifyAuthorization).not.toHaveBeenCalled();
    injected.verifyAuthorization.mockRejectedValueOnce(new Error('invalid OIDC'));
    expect((await createGooglePubSubPushHandler(injected)(context(request))).status).toBe(401);
    expect(pulled).toBe(false);
    expect(request.body?.locked).toBe(false);
  });

  it('bounds the body from Content-Length before pull and rejects media types safely', async () => {
    for (const [contentType, contentLength, status] of [
      ['text/plain', '2', 415], ['application/json', '65537', 413],
    ] as const) {
      let pulled = false;
      const request = new Request('https://church.test/api/learning/google/pubsub', {
        method: 'POST', headers: {
          'content-type': contentType, 'content-length': contentLength, authorization: 'Bearer token',
        }, body: new ReadableStream({ pull() { pulled = true; throw new Error('must not read'); } }, { highWaterMark: 0 }),
      });
      const response = await createGooglePubSubPushHandler(deps())(context(request));
      expect(response.status).toBe(status);
      expect(pulled).toBe(false);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('marks a claimed reconciliation succeeded and skips a terminal succeeded duplicate', async () => {
    const injected = deps();
    const request = new Request('https://church.test/api/learning/google/pubsub', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token' }, body: body(),
    });
    const response = await createGooglePubSubPushHandler(injected)(context(request));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(injected.acceptDelivery).toHaveBeenCalledWith({}, expect.objectContaining({
      messageId: 'message-1', registrationId: 'registration-1', externalCourseId: 'course-1',
    }));
    expect(injected.reconcileCourse).toHaveBeenCalledWith({}, {
      connectionId: 81, externalCourseId: 'course-1', trigger: 'notification',
      signal: expect.any(AbortSignal),
    });
    expect(injected.finishDelivery).toHaveBeenCalledWith({}, expect.objectContaining({
      outcome: 'succeeded', receipt: expect.objectContaining({ disposition: 'claimed' }),
    }));
    injected.acceptDelivery.mockResolvedValueOnce({
      connectionId: 81, externalCourseId: 'course-1', disposition: 'succeeded',
      subscriptionName: SUBSCRIPTION, messageId: 'message-1', claimMarker: null, attemptCount: 1,
    } as never);
    const duplicate = await createGooglePubSubPushHandler(injected)(context(new Request('https://church.test/api/learning/google/pubsub', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token' }, body: body(),
    })));
    expect(duplicate.status).toBe(204);
    expect(injected.reconcileCourse).toHaveBeenCalledTimes(1);
    expect(injected.finishDelivery).toHaveBeenCalledTimes(1);
  });

  it('accepts the recorded official wrapped Pub/Sub envelope at the HTTP route', async () => {
    const injected = deps();
    const request = new Request('https://church.test/api/learning/google/pubsub', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      body: documentedWrappedBody(),
    });
    expect((await createGooglePubSubPushHandler(injected)(context(request))).status).toBe(204);
    expect(injected.acceptDelivery).toHaveBeenCalledWith({}, expect.objectContaining({
      messageId: 'message-1', registrationId: 'registration-1', publishedAt: '2026-08-17T11:59:59.000Z',
    }));
  });

  it('marks failed reconciliation retryable and returns 503 for failed or concurrent pending work', async () => {
    const injected = deps();
    injected.reconcileCourse.mockRejectedValueOnce(new Error('provider private body'));
    const request = () => new Request('https://church.test/api/learning/google/pubsub', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token' }, body: body(),
    });
    expect((await createGooglePubSubPushHandler(injected)(context(request()))).status).toBe(503);
    expect(injected.finishDelivery).toHaveBeenCalledWith({}, expect.objectContaining({ outcome: 'failed' }));
    injected.acceptDelivery.mockResolvedValueOnce({
      connectionId: 81, externalCourseId: 'course-1', disposition: 'in_progress',
      subscriptionName: SUBSCRIPTION, messageId: 'message-1', claimMarker: null, attemptCount: 1,
    } as never);
    expect((await createGooglePubSubPushHandler(injected)(context(request()))).status).toBe(503);
    expect(injected.reconcileCourse).toHaveBeenCalledTimes(1);
  });
});
