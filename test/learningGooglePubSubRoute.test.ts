import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { AppDb, AppStatement } from '../src/lib/appDb';
import { hasValidMutationProvenance } from '../src/lib/csrf';
import { encodeGoogleCredential, GOOGLE_CLASSROOM_SCOPES } from '../src/lib/learningGoogleAuth';
import {
  encryptLearningCredential,
  importLearningCredentialKeyRing,
} from '../src/lib/learningCredentials';
import {
  acceptGooglePubSubDelivery,
  finishGooglePubSubDelivery,
} from '../src/lib/learningGooglePubSub';
import { reconcileGoogleClassroomCourse } from '../src/lib/learningGoogleReconcile';
import { moduleForPath } from '../src/lib/modules';
import {
  createGooglePubSubPushHandler,
} from '../src/pages/api/learning/google/pubsub';

const SUBSCRIPTION = 'projects/church-project/subscriptions/classroom';
const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const KEY_SECRET = JSON.stringify({
  currentVersion: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(61))) },
});

function context(request: Request, modules: string[] = ['learning'], db: object = {}): never {
  return {
    request,
    url: new URL(request.url),
    locals: { modules: new Set(modules), user: null, db, cfContext: { waitUntil: vi.fn() } },
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

  it('reserves the whole D1 webhook budget through refresh, sync rejection, and failed receipt finalization', async () => {
    await env.DB.prepare('DELETE FROM learning_provider_connections WHERE id=27802').run();
    await env.DB.prepare('DELETE FROM learning_programs WHERE id=27803').run();
    await env.DB.prepare('DELETE FROM people WHERE id=27801').run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(27801,'Budget Admin','budget@example.test')").run();
    await env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(27802,'google_classroom','Budget Classroom',NULL,'active',1,27801)`).run();
    await env.DB.prepare("INSERT INTO learning_programs(id,slug,display_name) VALUES(27803,'budget-classroom','Budget Classroom')").run();
    await env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url)
      VALUES(27804,27803,27802,'google_classroom','course-1','Budget course',
        'https://classroom.google.com/c/course-1')`).run();
    await env.DB.prepare(`INSERT INTO learning_google_registrations
      (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time)
      VALUES(27802,'course-1','COURSE_WORK_CHANGES','registration-1',
        'projects/church-project/topics/classroom','2026-08-24T12:00:00.000Z')`).run();
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const envelope = await encryptLearningCredential(keyRing, {
      provider: 'google_classroom', connectionId: 27802,
      plaintext: encodeGoogleCredential({
        version: 1, accessToken: 'expired-access', refreshToken: 'budget-refresh',
        accessTokenExpiresAt: '2026-08-17T11:00:00.000Z',
        refreshTokenExpiresAt: '2026-08-24T12:00:00.000Z',
        grantedScopes: GOOGLE_CLASSROOM_SCOPES,
      }), expiresAt: '2026-08-24T12:00:00.000Z',
    });
    await env.DB.prepare(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES(27802,?1,?2,?3,?4,?5,?6)`).bind(
      envelope.ciphertext, envelope.nonce, envelope.algorithm,
      envelope.keyVersion, envelope.envelopeVersion, envelope.expiresAt,
    ).run();

    const metrics = { queries: 0, maxBinds: 0, overQueryAttempts: [] as number[] };
    const charge = (amount: number): void => {
      if (metrics.queries + amount > 50) {
        metrics.overQueryAttempts.push(amount);
        throw new Error('test_whole_webhook_d1_budget_exceeded');
      }
      metrics.queries += amount;
    };
    interface TrackedStatement extends AppStatement { readonly inner: D1PreparedStatement }
    const wrap = (inner: D1PreparedStatement): TrackedStatement => ({
      inner,
      bind(...values: unknown[]) {
        metrics.maxBinds = Math.max(metrics.maxBinds, values.length);
        return wrap(inner.bind(...values));
      },
      async first<T = unknown>(column?: string) {
        charge(1);
        return column === undefined ? inner.first<T>() : inner.first<T>(column);
      },
      async all<T = unknown>() { charge(1); return inner.all<T>(); },
      async run<T = unknown>() { charge(1); return inner.run<T>(); },
    });
    const trackedDb: AppDb = {
      prepare: (sql) => wrap(env.DB.prepare(sql)),
      async batch<T = unknown>(statements: AppStatement[]) {
        charge(statements.length);
        return env.DB.batch<T>(statements.map((statement) => (statement as TrackedStatement).inner));
      },
    };
    const activities = Array.from({ length: 10 }, (_, index) => ({
      id: `material-${index + 1}`, title: `Material ${index + 1}`, state: 'PUBLISHED',
      alternateLink: `https://classroom.google.com/c/course-1/m/material-${index + 1}/details`,
      updateTime: '2026-08-17T11:30:00.000Z',
    }));
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.toString() === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'budget-access', expires_in: 3_600,
          refresh_token: 'budget-rotated-refresh', refresh_token_expires_in: 604_800,
          scope: GOOGLE_CLASSROOM_SCOPES.join(' '), token_type: 'Bearer',
        }), { headers: { 'content-type': 'application/json' } });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer budget-access');
      if (url.pathname === '/v1/courses/course-1') return new Response(JSON.stringify({
        id: 'course-1', name: 'Budget course', courseState: 'ACTIVE',
        alternateLink: 'https://classroom.google.com/c/course-1',
        updateTime: '2026-08-17T11:55:00.000Z',
      }));
      if (url.pathname.endsWith('/teachers')) return new Response('{}');
      if (url.pathname.endsWith('/students')) return new Response('{}');
      if (url.pathname.endsWith('/courseWorkMaterials')) {
        return new Response(JSON.stringify({ courseWorkMaterial: activities }));
      }
      if (url.pathname.endsWith('/courseWork')) return new Response('{}');
      const material = /\/courseWorkMaterials\/(material-\d+)$/u.exec(url.pathname)?.[1];
      if (material) return new Response(JSON.stringify({
        id: material, title: material, state: 'PUBLISHED',
        materials: material === 'material-1'
          ? [{ link: { url: 'https://forms.google.com/budget', title: 'Budget resource' } }]
          : [],
      }));
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const productionDeps = {
      ...deps(),
      acceptDelivery: acceptGooglePubSubDelivery,
      finishDelivery: finishGooglePubSubDelivery,
      reconcileCourse: (db: AppDb, input: {
        readonly connectionId: number; readonly externalCourseId: string;
        readonly trigger: 'notification'; readonly signal: AbortSignal;
      }) => reconcileGoogleClassroomCourse(db, {
        ...input, clientId: 'client.apps.googleusercontent.com',
        clientSecret: 'private-client-secret', keyRing, fetcher, now: () => NOW,
      }).then(() => undefined),
    };
    const request = new Request('https://church.test/api/learning/google/pubsub', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      body: body(),
    });
    expect((await createGooglePubSubPushHandler(productionDeps)(context(request, ['learning'], trackedDb))).status)
      .toBe(503);
    expect(metrics.overQueryAttempts).toEqual([]);
    expect(metrics.queries).toBe(16);
    expect(metrics.maxBinds).toBeLessThanOrEqual(100);
    expect(await env.DB.prepare(`SELECT status FROM learning_google_notification_receipts
      WHERE subscription_name=?1 AND message_id='message-1'`).bind(SUBSCRIPTION).first('status')).toBe('failed');
  });
});
