import { describe, expect, it, vi } from 'vitest';
import {
  LearningGooglePubSubError,
  normalizeGooglePubSubIdentityClaims,
  parseGooglePubSubPushBody,
  verifyGooglePubSubAuthorization,
} from '../src/lib/learningGooglePubSub';

const AUDIENCE = 'https://church.example.test/api/learning/google/pubsub';
const SERVICE_ACCOUNT = 'classroom-push@church-project.iam.gserviceaccount.com';
const NOW = Date.parse('2026-08-17T12:00:00.000Z');

function message(data: unknown, overrides: Record<string, unknown> = {}): Uint8Array {
  const encoded = btoa(JSON.stringify(data));
  return new TextEncoder().encode(JSON.stringify({
    message: {
      attributes: { registrationId: 'registration-1' },
      data: encoded,
      messageId: 'message-1',
      publishTime: '2026-08-17T11:59:59.000Z',
    },
    subscription: 'projects/church-project/subscriptions/classroom',
    ...overrides,
  }));
}

describe('Google Pub/Sub push authentication and envelope', () => {
  it('accepts only exact Google issuer, audience, verified service-account email, and bounded JWT time claims', () => {
    expect(normalizeGooglePubSubIdentityClaims({
      iss: 'https://accounts.google.com', aud: AUDIENCE,
      email: SERVICE_ACCOUNT, email_verified: true, sub: '1234567890',
      iat: Math.floor(NOW / 1_000) - 10, exp: Math.floor(NOW / 1_000) + 300,
    }, { expectedAudience: AUDIENCE, expectedServiceAccountEmail: SERVICE_ACCOUNT, nowEpochMs: NOW }))
      .toEqual({ subject: '1234567890', email: SERVICE_ACCOUNT });
    for (const claims of [
      { iss: 'https://evil.example.test', aud: AUDIENCE, email: SERVICE_ACCOUNT, email_verified: true,
        sub: '1', iat: NOW / 1_000, exp: NOW / 1_000 + 60 },
      { iss: 'https://accounts.google.com', aud: `${AUDIENCE}/alias`, email: SERVICE_ACCOUNT,
        email_verified: true, sub: '1', iat: NOW / 1_000, exp: NOW / 1_000 + 60 },
      { iss: 'https://accounts.google.com', aud: AUDIENCE, email: SERVICE_ACCOUNT,
        email_verified: false, sub: '1', iat: NOW / 1_000, exp: NOW / 1_000 + 60 },
    ]) expect(() => normalizeGooglePubSubIdentityClaims(claims, {
      expectedAudience: AUDIENCE, expectedServiceAccountEmail: SERVICE_ACCOUNT, nowEpochMs: NOW,
    })).toThrow(LearningGooglePubSubError);
  });

  it('extracts one Bearer JWT and delegates signature verification with exact production expectations', async () => {
    const verifyToken = vi.fn(async () => ({
      iss: 'https://accounts.google.com', aud: AUDIENCE, email: SERVICE_ACCOUNT,
      email_verified: true, sub: '1234567890', iat: NOW / 1_000 - 1, exp: NOW / 1_000 + 60,
    }));
    await expect(verifyGooglePubSubAuthorization({
      authorizationHeader: 'Bearer header.payload.signature',
      expectedAudience: AUDIENCE,
      expectedServiceAccountEmail: SERVICE_ACCOUNT,
      nowEpochMs: NOW,
      verifyToken,
    })).resolves.toEqual({ subject: '1234567890', email: SERVICE_ACCOUNT });
    expect(verifyToken).toHaveBeenCalledWith('header.payload.signature', {
      audience: AUDIENCE, issuer: 'https://accounts.google.com', algorithms: ['RS256'],
    });
    await expect(verifyGooglePubSubAuthorization({
      authorizationHeader: 'Basic private', expectedAudience: AUDIENCE,
      expectedServiceAccountEmail: SERVICE_ACCOUNT, nowEpochMs: NOW, verifyToken,
    })).rejects.toBeInstanceOf(LearningGooglePubSubError);
  });

  it('strictly decodes the wrapped base64 Classroom message without retaining the raw body', () => {
    const delivery = parseGooglePubSubPushBody({
      rawBody: message({
        collection: 'courses.courseWork.studentSubmissions',
        eventType: 'CREATED',
        resourceId: { courseId: 'course-1', courseWorkId: 'quiz-1', id: 'submission-1' },
      }),
      expectedSubscriptionName: 'projects/church-project/subscriptions/classroom',
      receivedAt: '2026-08-17T12:00:00.000Z',
    });
    expect(delivery).toEqual({
      subscriptionName: 'projects/church-project/subscriptions/classroom',
      messageId: 'message-1', registrationId: 'registration-1',
      collection: 'courses.courseWork.studentSubmissions', externalCourseId: 'course-1',
      resourceId: { courseId: 'course-1', courseWorkId: 'quiz-1', id: 'submission-1' },
      publishedAt: '2026-08-17T11:59:59.000Z', receivedAt: '2026-08-17T12:00:00.000Z',
    });
    expect(JSON.stringify(delivery)).not.toMatch(/rawBody|encoded|submission-1.*private/iu);
  });

  it('accepts the documented wrapped aliases and optional delivery metadata without retaining it', () => {
    const data = btoa(JSON.stringify({
      collection: 'courses.courseWork', eventType: 'UPDATED',
      resourceId: { courseId: 'course-1', id: 'work-1' },
    }));
    const delivery = parseGooglePubSubPushBody({
      rawBody: new TextEncoder().encode(JSON.stringify({
        deliveryAttempt: 5,
        message: {
          attributes: { registrationId: 'registration-1' }, data,
          messageId: 'message-1', message_id: 'message-1', orderingKey: 'course-1',
          publishTime: '2026-08-17T11:59:59.000Z', publish_time: '2026-08-17T11:59:59.000Z',
        },
        subscription: 'projects/church-project/subscriptions/classroom',
      })),
      expectedSubscriptionName: 'projects/church-project/subscriptions/classroom',
      receivedAt: '2026-08-17T12:00:00.000Z',
    });
    expect(delivery).toMatchObject({ messageId: 'message-1', publishedAt: '2026-08-17T11:59:59.000Z' });
    expect(JSON.stringify(delivery)).not.toMatch(/deliveryAttempt|orderingKey|message_id|publish_time/u);
  });

  it('accepts a snake-only wrapped alias variant and rejects alias conflicts or unbounded delivery metadata', () => {
    const data = btoa(JSON.stringify({
      collection: 'courses.courseWork', eventType: 'DELETED',
      resourceId: { courseId: 'course-1', id: 'work-1' },
    }));
    const envelope = (overrides: Record<string, unknown>, outer: Record<string, unknown> = {}) =>
      new TextEncoder().encode(JSON.stringify({
        message: {
          attributes: { registrationId: 'registration-1' }, data,
          message_id: 'message-1', publish_time: '2026-08-17T11:59:59.000Z',
          ...overrides,
        },
        subscription: 'projects/church-project/subscriptions/classroom',
        ...outer,
      }));
    expect(parseGooglePubSubPushBody({
      rawBody: envelope({}), expectedSubscriptionName: 'projects/church-project/subscriptions/classroom',
      receivedAt: '2026-08-17T12:00:00.000Z',
    })).toMatchObject({ messageId: 'message-1', publishedAt: '2026-08-17T11:59:59.000Z' });
    for (const rawBody of [
      envelope({ messageId: 'other-message' }),
      envelope({ publishTime: '2026-08-17T11:58:00.000Z' }),
      envelope({ orderingKey: 'x'.repeat(1_025) }),
      envelope({}, { deliveryAttempt: 0 }),
      envelope({}, { deliveryAttempt: 1.5 }),
      envelope({}, { delivery_attempt: 2 }),
    ]) expect(() => parseGooglePubSubPushBody({
      rawBody, expectedSubscriptionName: 'projects/church-project/subscriptions/classroom',
      receivedAt: '2026-08-17T12:00:00.000Z',
    })).toThrow(LearningGooglePubSubError);
  });

  it('rejects wrong subscriptions, unknown fields, malformed base64/JSON, collection-resource mismatch, and oversized bodies', () => {
    const validData = {
      collection: 'courses.courseWork', eventType: 'CREATED',
      resourceId: { courseId: 'course-1', id: 'work-1' },
    };
    const inputs = [
      { rawBody: message(validData), expectedSubscriptionName: 'projects/other/subscriptions/classroom' },
      { rawBody: message(validData, { surprise: true }), expectedSubscriptionName: 'projects/church-project/subscriptions/classroom' },
      { rawBody: message({ collection: 'courses.courseWork',
        resourceId: { courseId: 'course-1', id: 'work-1' } }),
        expectedSubscriptionName: 'projects/church-project/subscriptions/classroom' },
      { rawBody: new TextEncoder().encode(JSON.stringify({
        message: { attributes: { registrationId: 'registration-1' }, data: '*not-base64*', messageId: 'message-1' },
        subscription: 'projects/church-project/subscriptions/classroom',
      })), expectedSubscriptionName: 'projects/church-project/subscriptions/classroom' },
      { rawBody: message({ collection: 'courses.students', eventType: 'CREATED',
        resourceId: { courseId: 'course-1', id: 'not-user' } }),
        expectedSubscriptionName: 'projects/church-project/subscriptions/classroom' },
      { rawBody: message({ collection: 'courses.courseWork', eventType: 'created',
        resourceId: { courseId: 'course-1', id: 'work-1' } }),
        expectedSubscriptionName: 'projects/church-project/subscriptions/classroom' },
      { rawBody: message({ collection: 'courses.courseWork', eventType: 'CREATED', providerBody: 'private',
        resourceId: { courseId: 'course-1', id: 'work-1' } }),
        expectedSubscriptionName: 'projects/church-project/subscriptions/classroom' },
      { rawBody: new Uint8Array(65_537), expectedSubscriptionName: 'projects/church-project/subscriptions/classroom' },
    ];
    for (const input of inputs) expect(() => parseGooglePubSubPushBody({
      ...input, receivedAt: '2026-08-17T12:00:00.000Z',
    })).toThrow(LearningGooglePubSubError);
  });
});
