import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  LearningProviderError,
  LearningValidationError,
  learningCourseSubjectKey,
  normalizeLearningCourse,
} from '../src/lib/learningModel';
import {
  normalizeLearningPage,
  normalizeLearningPageRequest,
  normalizeLearningProviderError,
  normalizeLearningSyncResult,
  type LearningProvider,
  type LearningProviderPage,
} from '../src/lib/learningProvider';

const URL_POLICY = {
  allowedOrigins: ['https://canvas.church.test'],
} as const;

function course(externalCourseId: string, displayName = externalCourseId): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId,
    displayName,
    launchUrl: `https://canvas.church.test/courses/${encodeURIComponent(externalCourseId)}`,
    lifecycleState: 'active',
    providerUpdatedAt: '2026-08-16T15:30:00Z',
    lastSyncedAt: null,
  };
}

const normalizeCourse = (value: unknown) => normalizeLearningCourse(value, URL_POLICY);

const expectInvalid = (run: () => unknown): void => {
  expect(run).toThrow(LearningValidationError);
  expect(run).toThrow('Learning input is invalid');
};

describe('bounded page requests', () => {
  it('normalizes explicit page size, number, and bounded opaque token', () => {
    expect(normalizeLearningPageRequest({ pageSize: 100, pageNumber: 100, pageToken: ' next-page ' }))
      .toEqual({ pageSize: 100, pageNumber: 100, pageToken: 'next-page' });
  });

  it('rejects malformed records and off-by-one limits', () => {
    for (const input of [
      null,
      [],
      { pageSize: 0, pageNumber: 1, pageToken: null },
      { pageSize: 101, pageNumber: 1, pageToken: null },
      { pageSize: 10.5, pageNumber: 1, pageToken: null },
      { pageSize: 10, pageNumber: 0, pageToken: null },
      { pageSize: 10, pageNumber: 101, pageToken: null },
      { pageSize: 10, pageNumber: 1, pageToken: 'x'.repeat(LEARNING_LIMITS.paginationTokenBytes + 1) },
      { pageSize: 10, pageNumber: 1, pageToken: 'bad\ntoken' },
      { pageSize: 10, pageNumber: 1, pageToken: null, accessToken: 'secret' },
    ]) expectInvalid(() => normalizeLearningPageRequest(input));
  });
});

describe('normalized pages, ordering, and deduplication', () => {
  it('sorts by provider-scoped key, collapses identical duplicates, and deeply freezes output', () => {
    const input = {
      items: [course('z'), course('a'), course('z')],
      nextPageToken: 'page-2',
      pageNumber: 1,
      responseBytes: 800,
    };
    const result = normalizeLearningPage(input, {
      normalizeItem: normalizeCourse,
      subjectKey: learningCourseSubjectKey,
    });
    expect(result.items.map((item) => item.externalCourseId)).toEqual(['a', 'z']);
    expect(result).toMatchObject({ nextPageToken: 'page-2', pageNumber: 1, responseBytes: 800 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
  });

  it('is idempotent for already normalized pages', () => {
    const first = normalizeLearningPage({
      items: [course('b'), course('a')], nextPageToken: null, pageNumber: 1, responseBytes: 500,
    }, { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey });
    const second = normalizeLearningPage(first, {
      normalizeItem: normalizeCourse,
      subjectKey: learningCourseSubjectKey,
    });
    expect(second).toEqual(first);
  });

  it('rejects conflicting duplicates and cross-page/provider ambiguity', () => {
    expectInvalid(() => normalizeLearningPage({
      items: [course('same', 'First'), course('same', 'Second')],
      nextPageToken: null,
      pageNumber: 1,
      responseBytes: 500,
    }, { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey }));
    expectInvalid(() => normalizeLearningPage({
      items: [course('same'), { ...course('same'), connectionId: 8 }],
      nextPageToken: null,
      pageNumber: 1,
      responseBytes: 500,
    }, {
      normalizeItem: normalizeCourse,
      subjectKey: () => 'same',
    }));
    const secret = 'provider-secret-body';
    expect(() => normalizeLearningPage({
      items: [{}], nextPageToken: null, pageNumber: 1, responseBytes: 10,
    }, {
      normalizeItem: () => Object.assign(new Error(secret), { name: 'LearningValidationError' }) as never,
      subjectKey: () => 'never',
    })).toThrow('Learning input is invalid');
    try {
      normalizeLearningPage({
        items: [{}], nextPageToken: null, pageNumber: 1, responseBytes: 10,
      }, {
        normalizeItem: () => { throw Object.assign(new Error(secret), { name: 'LearningValidationError' }); },
        subjectKey: () => 'never',
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('enforces page/item/count/byte bounds and exact page fields', () => {
    expectInvalid(() => normalizeLearningPage({
      items: Array.from({ length: LEARNING_LIMITS.maxPageItems + 1 }, (_, index) => course(String(index))),
      nextPageToken: null,
      pageNumber: 1,
      responseBytes: 1_000,
    }, { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey }));
    expectInvalid(() => normalizeLearningPage({
      items: [course('large', 'x'.repeat(300))],
      nextPageToken: null,
      pageNumber: 1,
      responseBytes: LEARNING_LIMITS.maxPageBytes + 1,
    }, { normalizeItem: (value) => value as Record<string, unknown>, subjectKey: () => 'large' }));
    expectInvalid(() => normalizeLearningPage({
      items: [{ id: 'large', text: 'x'.repeat(LEARNING_LIMITS.maxItemBytes + 1) }],
      nextPageToken: null,
      pageNumber: 1,
      responseBytes: 100,
    }, { normalizeItem: (value) => value as Record<string, unknown>, subjectKey: () => 'large' }));
    expectInvalid(() => normalizeLearningPage({
      items: [], nextPageToken: null, pageNumber: LEARNING_LIMITS.maxPages + 1, responseBytes: 0,
    }, { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey }));
    expectInvalid(() => normalizeLearningPage({
      items: [], nextPageToken: null, pageNumber: 1, responseBytes: 0, rawBody: 'secret',
    }, { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey }));
    const cyclic: Record<string, unknown> = { id: 'cyclic' };
    cyclic.self = cyclic;
    expectInvalid(() => normalizeLearningPage({
      items: [cyclic], nextPageToken: null, pageNumber: 1, responseBytes: 10,
    }, {
      normalizeItem: (value) => value as Record<string, unknown>,
      subjectKey: () => 'cyclic',
    }));
  });
});

describe('bounded sync results', () => {
  const validResult = {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId: 'course-42',
    trigger: 'manual',
    status: 'succeeded',
    startedAt: '2026-08-16T15:30:00Z',
    finishedAt: '2026-08-16T15:31:00Z',
    attemptCount: 1,
    pageCount: 2,
    scannedCount: 20,
    changedCount: 4,
    removedCount: 1,
    eventCount: 3,
    responseBytes: 4096,
    errorCode: null,
  };

  it('normalizes success output and timestamps', () => {
    expect(normalizeLearningSyncResult(validResult)).toEqual({
      ...validResult,
      startedAt: '2026-08-16T15:30:00.000Z',
      finishedAt: '2026-08-16T15:31:00.000Z',
    });
  });

  it('enforces result count, page, byte, attempt, and status/error coherence limits', () => {
    for (const overrides of [
      { attemptCount: 0 },
      { attemptCount: 11 },
      { pageCount: LEARNING_LIMITS.maxPages + 1 },
      { scannedCount: LEARNING_LIMITS.maxSyncItems + 1 },
      { changedCount: 21 },
      { removedCount: 21 },
      { eventCount: LEARNING_LIMITS.maxSyncItems + 1 },
      { responseBytes: LEARNING_LIMITS.maxSyncBytes + 1 },
      { status: 'failed', errorCode: null },
      { status: 'succeeded', errorCode: 'provider_unavailable' },
      { status: 'running', finishedAt: '2026-08-16T15:31:00Z' },
      { status: 'cancelled', errorCode: 'cancelled' },
      { trigger: 'webhook' },
      { status: 'complete' },
    ]) expectInvalid(() => normalizeLearningSyncResult({ ...validResult, ...overrides }));
  });
});

describe('safe structured provider errors', () => {
  it('exports an allowlist and preserves only bounded structural metadata', () => {
    expect(LEARNING_ERROR_CODES).toEqual([
      'invalid_request', 'authentication_required', 'permission_denied', 'not_found',
      'rate_limited', 'provider_unavailable', 'malformed_response', 'response_too_large',
      'pagination_limit', 'conflict', 'timeout', 'cancelled', 'internal_error',
    ]);
    expect(normalizeLearningProviderError({
      code: 'rate_limited', provider: 'canvas', httpStatus: 429, retryAfterSeconds: 60,
    })).toEqual({ code: 'rate_limited', provider: 'canvas', httpStatus: 429, retryAfterSeconds: 60 });
  });

  it('rejects raw response/message/url/token carriers and over-limit metadata', () => {
    for (const input of [
      { code: 'unknown', provider: 'canvas', httpStatus: 500, retryAfterSeconds: null },
      { code: 'provider_unavailable', provider: 'moodle', httpStatus: 503, retryAfterSeconds: null },
      { code: 'provider_unavailable', provider: 'canvas', httpStatus: 399, retryAfterSeconds: null },
      { code: 'provider_unavailable', provider: 'canvas', httpStatus: 600, retryAfterSeconds: null },
      { code: 'rate_limited', provider: 'canvas', httpStatus: 429, retryAfterSeconds: LEARNING_LIMITS.maxRetryAfterSeconds + 1 },
      { code: 'provider_unavailable', provider: 'canvas', httpStatus: 503, retryAfterSeconds: null, body: 'secret' },
      { code: 'provider_unavailable', provider: 'canvas', httpStatus: 503, retryAfterSeconds: null, message: 'token=secret' },
      { code: 'provider_unavailable', provider: 'canvas', httpStatus: 503, retryAfterSeconds: null, url: 'https://x.test/?token=secret' },
    ]) expectInvalid(() => normalizeLearningProviderError(input));
  });

  it('never leaks rejected provider data through thrown errors', () => {
    const secret = 'top-secret-access-token';
    let caught: unknown;
    try {
      normalizeLearningProviderError({
        code: 'provider_unavailable', provider: 'canvas', httpStatus: 503,
        retryAfterSeconds: null, rawBody: secret,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LearningValidationError);
    expect(String(caught)).not.toContain(secret);

    const providerError = new LearningProviderError({
      code: 'rate_limited', provider: 'canvas', httpStatus: 429, retryAfterSeconds: 60,
    });
    expect(providerError.message).toBe('Learning provider request failed: rate_limited');
    expect(JSON.stringify(providerError)).not.toContain('token');
    expect(providerError.code).toBe('rate_limited');
  });
});

describe('provider-neutral interface', () => {
  it('requires bounded paginated reads and normalized sync boundaries without implementation state', () => {
    expectTypeOf<LearningProvider['healthCheck']>().toBeFunction();
    expectTypeOf<LearningProvider['listCourses']>().toBeFunction();
    expectTypeOf<LearningProvider['syncCourse']>().toBeFunction();
    expectTypeOf<LearningProvider['syncEnrollments']>().toBeFunction();
    expectTypeOf<LearningProvider['syncActivities']>().toBeFunction();
    expectTypeOf<LearningProvider['syncSubmissions']>().toBeFunction();
    expectTypeOf<LearningProvider['buildLaunchUrl']>().toBeFunction();
    expectTypeOf<LearningProvider['normalizeNotification']>().toBeFunction();
    expectTypeOf<ReturnType<LearningProvider['listCourses']>>()
      .toEqualTypeOf<Promise<LearningProviderPage<ReturnType<typeof normalizeCourse>>>>();
  });
});
