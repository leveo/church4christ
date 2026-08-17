import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  LearningProviderError,
  LearningValidationError,
  learningCourseSubjectKey,
  learningResourceSubjectKey,
  learningSubmissionSubjectKey,
  normalizeLearningConnectionUrlPolicy,
  normalizeLearningCourse,
  normalizeLearningResource,
  normalizeLearningSubmissionSnapshot,
  type LearningLaunchContract,
  type LearningResource,
} from '../src/lib/learningModel';
import {
  acceptLearningPageSequence,
  createLearningPageSequence,
  normalizeLearningPage,
  normalizeLearningPageRequest,
  normalizeLearningOperationContext,
  normalizeLearningProviderError,
  normalizeLearningSyncResult,
  type LearningOperationContext,
  type LearningProvider,
  type LearningProviderPage,
} from '../src/lib/learningProvider';

const URL_POLICY = {
  provider: 'canvas',
  connectionId: 7,
  baseUrl: 'https://canvas.church.test',
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

function resource(externalResourceId: string, title = externalResourceId): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId: 'course-42',
    externalActivityId: 'activity-3',
    externalResourceId,
    title,
    kind: 'link',
    launchUrl: `https://canvas.church.test/resources/${encodeURIComponent(externalResourceId)}`,
    youtubeVideoId: null,
    mimeType: null,
    sizeBytes: null,
    providerUpdatedAt: '2026-08-16T15:30:00Z',
  };
}

const normalizeResource = (value: unknown) => normalizeLearningResource(value, URL_POLICY);

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId: 'course-42',
    externalActivityId: 'activity-3',
    activityKind: 'quiz',
    personId: 12,
    externalUserId: 'user-12',
    externalEnrollmentId: 'enrollment-9',
    status: 'submitted',
    late: 0,
    attemptNumber: 1,
    submittedAt: '2026-08-16T15:40:00Z',
    returnedAt: null,
    providerUpdatedAt: '2026-08-16T15:40:05Z',
    syncedAt: '2026-08-16T15:41:00Z',
    ...overrides,
  };
}

const normalizeSubmission = (value: unknown) => normalizeLearningSubmissionSnapshot(value);

const expectInvalid = (run: () => unknown): void => {
  expect(run).toThrow(LearningValidationError);
  expect(run).toThrow('Learning input is invalid');
};

function expectSafeInvalid(run: () => unknown, secret?: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LearningValidationError);
  expect(String(caught)).toContain('Learning input is invalid');
  if (secret) expect(String(caught)).not.toContain(secret);
}

function page(
  items: unknown,
  pageNumber = 1,
  requestPageToken: string | null = null,
  nextPageToken: string | null = null,
  responseBytes = 100,
): Record<string, unknown> {
  return { items, requestPageToken, nextPageToken, pageNumber, responseBytes };
}

function operationInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: {
      provider: 'canvas',
      connectionId: 7,
      externalCourseId: null,
      externalActivityId: null,
      externalEnrollmentId: null,
    },
    deadlineAt: '2026-08-17T12:00:00Z',
    maxPages: 3,
    maxItems: 4,
    maxBytes: 300,
    signal: new AbortController().signal,
    ...overrides,
  };
}

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
      requestPageToken: null,
      nextPageToken: 'page-2',
      pageNumber: 1,
      responseBytes: 800,
    };
    const result = normalizeLearningPage(input, {
      normalizeItem: normalizeCourse,
      subjectKey: learningCourseSubjectKey,
    });
    expect(result.items.map((item) => item.externalCourseId)).toEqual(['a', 'z']);
    expect(result).toMatchObject({ requestPageToken: null, nextPageToken: 'page-2', pageNumber: 1, responseBytes: 800 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
  });

  it('is idempotent for already normalized pages', () => {
    const first = normalizeLearningPage({
      items: [course('b'), course('a')], requestPageToken: null,
      nextPageToken: null, pageNumber: 1, responseBytes: 500,
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
      requestPageToken: null,
      nextPageToken: null,
      pageNumber: 1,
      responseBytes: 500,
    }, { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey }));
    expectInvalid(() => normalizeLearningPage({
      items: [course('same'), { ...course('same'), connectionId: 8 }],
      requestPageToken: null,
      nextPageToken: null,
      pageNumber: 1,
      responseBytes: 500,
    }, {
      normalizeItem: normalizeCourse,
      subjectKey: () => 'same',
    }));
    const secret = 'provider-secret-body';
    expect(() => normalizeLearningPage({
      items: [{}], requestPageToken: null, nextPageToken: null, pageNumber: 1, responseBytes: 10,
    }, {
      normalizeItem: () => Object.assign(new Error(secret), { name: 'LearningValidationError' }) as never,
      subjectKey: () => 'never',
    })).toThrow('Learning input is invalid');
    try {
      normalizeLearningPage({
        items: [{}], requestPageToken: null, nextPageToken: null, pageNumber: 1, responseBytes: 10,
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
      requestPageToken: null,
      nextPageToken: null,
      pageNumber: 1,
      responseBytes: 1_000,
    }, { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey }));
    expectInvalid(() => normalizeLearningPage({
      items: [course('large', 'x'.repeat(300))],
      requestPageToken: null,
      nextPageToken: null,
      pageNumber: 1,
      responseBytes: LEARNING_LIMITS.maxPageBytes + 1,
    }, { normalizeItem: (value) => value as Record<string, unknown>, subjectKey: () => 'large' }));
    expectInvalid(() => normalizeLearningPage({
      items: [{ id: 'large', text: 'x'.repeat(LEARNING_LIMITS.maxItemBytes + 1) }],
      requestPageToken: null,
      nextPageToken: null,
      pageNumber: 1,
      responseBytes: 100,
    }, { normalizeItem: (value) => value as Record<string, unknown>, subjectKey: () => 'large' }));
    expectInvalid(() => normalizeLearningPage({
      items: [], requestPageToken: null,
      nextPageToken: null, pageNumber: LEARNING_LIMITS.maxPages + 1, responseBytes: 0,
    }, { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey }));
    expectInvalid(() => normalizeLearningPage({
      items: [], requestPageToken: null,
      nextPageToken: null, pageNumber: 1, responseBytes: 0, rawBody: 'secret',
    }, { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey }));
    const cyclic: Record<string, unknown> = { id: 'cyclic' };
    cyclic.self = cyclic;
    expectInvalid(() => normalizeLearningPage({
      items: [cyclic], requestPageToken: null,
      nextPageToken: null, pageNumber: 1, responseBytes: 10,
    }, {
      normalizeItem: (value) => value as Record<string, unknown>,
      subjectKey: () => 'cyclic',
    }));
  });
});

describe('resource pages', () => {
  it('normalizes, provider-scopes, sorts, deduplicates, and freezes resource pages', () => {
    const normalized = normalizeLearningPage(page([
      resource('z'), resource('a'), resource('z'),
    ], 1, null, 'resources-2', 600), {
      normalizeItem: normalizeResource,
      subjectKey: learningResourceSubjectKey,
    });
    expect(normalized.items.map((item) => item.externalResourceId)).toEqual(['a', 'z']);
    expect(normalized.items.every((item) => item.externalActivityId === 'activity-3')).toBe(true);
    expect(Object.isFrozen(normalized.items)).toBe(true);
  });

  it('rejects conflicting resource duplicates and resource page overflow', () => {
    expectInvalid(() => normalizeLearningPage(page([
      resource('same', 'First'), resource('same', 'Second'),
    ]), {
      normalizeItem: normalizeResource,
      subjectKey: learningResourceSubjectKey,
    }));
    expectInvalid(() => normalizeLearningPage(page(
      Array.from({ length: LEARNING_LIMITS.maxPageItems + 1 }, (_, index) => resource(String(index))),
    ), {
      normalizeItem: normalizeResource,
      subjectKey: learningResourceSubjectKey,
    }));
  });
});

describe('hostile collection safety', () => {
  const arrayCases: Array<{ name: string; make: (secret: string, touched: { value: boolean }) => unknown }> = [
    {
      name: 'accessor index',
      make(secret, touched) {
        const values = [course('a')];
        Object.defineProperty(values, '0', {
          enumerable: true,
          get() {
            touched.value = true;
            throw new Error(secret);
          },
        });
        return values;
      },
    },
    {
      name: 'throwing proxy reflection',
      make(secret) {
        return new Proxy([course('a')], {
          ownKeys() {
            throw new Error(secret);
          },
        });
      },
    },
    {
      name: 'own map override',
      make(_secret, touched) {
        const values = [course('a')];
        Object.defineProperty(values, 'map', {
          enumerable: true,
          value() {
            touched.value = true;
            return [];
          },
        });
        return values;
      },
    },
    {
      name: 'own iterator override',
      make(_secret, touched) {
        const values = [course('a')];
        Object.defineProperty(values, Symbol.iterator, {
          value() {
            touched.value = true;
            throw new Error('iterator-called');
          },
        });
        return values;
      },
    },
    {
      name: 'extra string property',
      make() {
        const values = [course('a')] as Array<unknown> & { payload?: string };
        values.payload = 'forbidden';
        return values;
      },
    },
    {
      name: 'sparse array',
      make() {
        return new Array(1);
      },
    },
    {
      name: 'array subclass',
      make() {
        class ProviderItems extends Array<unknown> {}
        const values = new ProviderItems();
        values.push(course('a'));
        return values;
      },
    },
  ];

  for (const testCase of arrayCases) {
    it(`rejects ${testCase.name} page items without invoking attacker code`, () => {
      const secret = `secret-${testCase.name}`;
      const touched = { value: false };
      expectSafeInvalid(() => normalizeLearningPage(page(testCase.make(secret, touched)), {
        normalizeItem: normalizeCourse,
        subjectKey: learningCourseSubjectKey,
      }), secret);
      expect(touched.value).toBe(false);
    });

    it(`rejects ${testCase.name} URL-origin collections without leaking`, () => {
      const secret = `origin-secret-${testCase.name}`;
      const touched = { value: false };
      const origins = testCase.make(secret, touched);
      expectSafeInvalid(() => normalizeLearningConnectionUrlPolicy({
        ...URL_POLICY,
        allowedOrigins: origins,
      }), secret);
      expect(touched.value).toBe(false);
    });
  }
});

describe('cross-page scope, progression, and cumulative budgets', () => {
  it('accepts a monotonic in-scope sequence exactly at item/page/byte limits', () => {
    const context = normalizeLearningOperationContext(operationInput({
      maxPages: 2, maxItems: 2, maxBytes: 200,
    }));
    const initial = createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context);
    const firstPage = normalizeLearningPage(page([course('b')], 1, null, 'next-2', 100), {
      normalizeItem: normalizeCourse,
      subjectKey: learningCourseSubjectKey,
    });
    const afterFirst = acceptLearningPageSequence(
      initial, firstPage, { subjectKey: learningCourseSubjectKey }, context,
      Date.parse('2026-08-17T11:59:59.999Z'),
    );
    const secondPage = normalizeLearningPage(page([course('a')], 2, 'next-2', null, 100), {
      normalizeItem: normalizeCourse,
      subjectKey: learningCourseSubjectKey,
    });
    const complete = acceptLearningPageSequence(
      afterFirst, secondPage, { subjectKey: learningCourseSubjectKey }, context,
      Date.parse('2026-08-17T11:59:59.999Z'),
    );
    expect(complete).toMatchObject({
      pageCount: 2, itemCount: 2, responseBytes: 200,
      expectedPageToken: null, complete: 1,
    });
    expect(complete.items.map((item) => item.externalCourseId)).toEqual(['a', 'b']);
    expect(Object.isFrozen(complete)).toBe(true);
    expect(Object.isFrozen(complete.items)).toBe(true);
    expect(Object.isFrozen(complete.seenEntityKeys)).toBe(true);
    expect(Object.isFrozen(complete.seenPageTokens)).toBe(true);
  });

  it('rejects out-of-scope records and cross-page duplicate entity keys', () => {
    const context = normalizeLearningOperationContext(operationInput());
    const initial = createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context);
    const wrongPolicy = { ...URL_POLICY, connectionId: 8 } as const;
    const outOfScope = normalizeLearningPage(page([{ ...course('wrong'), connectionId: 8 }]), {
      normalizeItem: (value) => normalizeLearningCourse(value, wrongPolicy),
      subjectKey: learningCourseSubjectKey,
    });
    expectInvalid(() => acceptLearningPageSequence(
      initial, outOfScope, { subjectKey: learningCourseSubjectKey }, context,
      Date.parse('2026-08-17T11:00:00Z'),
    ));

    const first = acceptLearningPageSequence(initial, normalizeLearningPage(
      page([course('same')], 1, null, 'next-2'),
      { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey },
    ), { subjectKey: learningCourseSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z'));
    const wrongExistingItem = normalizeLearningCourse({
      ...course('forged-existing'), connectionId: 8,
    }, wrongPolicy);
    expectInvalid(() => acceptLearningPageSequence({
      ...first,
      items: [wrongExistingItem],
      seenEntityKeys: [learningCourseSubjectKey(wrongExistingItem)],
    }, normalizeLearningPage(
      page([course('b')], 2, 'next-2', null),
      { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey },
    ), { subjectKey: learningCourseSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z')));
    expectInvalid(() => acceptLearningPageSequence(first, normalizeLearningPage(
      page([course('same')], 2, 'next-2', null),
      { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey },
    ), { subjectKey: learningCourseSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z')));
  });

  it('binds nested course/activity/enrollment scope for submission pages', () => {
    const context = normalizeLearningOperationContext(operationInput({
      scope: {
        provider: 'canvas',
        connectionId: 7,
        externalCourseId: 'course-42',
        externalActivityId: 'activity-3',
        externalEnrollmentId: 'enrollment-9',
      },
    }));
    const initial = createLearningPageSequence<ReturnType<typeof normalizeSubmission>>(context);
    const accepted = acceptLearningPageSequence(initial, normalizeLearningPage(
      page([submission()]),
      { normalizeItem: normalizeSubmission, subjectKey: learningSubmissionSubjectKey },
    ), { subjectKey: learningSubmissionSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z'));
    expect(accepted.complete).toBe(1);

    expectInvalid(() => acceptLearningPageSequence(initial, normalizeLearningPage(
      page([submission({ externalEnrollmentId: 'enrollment-other' })]),
      { normalizeItem: normalizeSubmission, subjectKey: learningSubmissionSubjectKey },
    ), { subjectKey: learningSubmissionSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z')));
  });

  it('rejects non-monotonic pages and repeated or cyclic pagination tokens', () => {
    const context = normalizeLearningOperationContext(operationInput());
    const initial = createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context);
    expectInvalid(() => acceptLearningPageSequence(initial, normalizeLearningPage(
      page([course('a')], 2, null, null),
      { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey },
    ), { subjectKey: learningCourseSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z')));

    const first = acceptLearningPageSequence(initial, normalizeLearningPage(
      page([course('a')], 1, null, 'token-a'),
      { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey },
    ), { subjectKey: learningCourseSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z'));
    expectInvalid(() => acceptLearningPageSequence(first, normalizeLearningPage(
      page([course('b')], 2, 'wrong-token', null),
      { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey },
    ), { subjectKey: learningCourseSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z')));
    expectInvalid(() => acceptLearningPageSequence(first, normalizeLearningPage(
      page([course('b')], 2, 'token-a', 'token-a'),
      { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey },
    ), { subjectKey: learningCourseSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z')));
    const second = acceptLearningPageSequence(first, normalizeLearningPage(
      page([course('b')], 2, 'token-a', 'token-b'),
      { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey },
    ), { subjectKey: learningCourseSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z'));
    expectInvalid(() => acceptLearningPageSequence(second, normalizeLearningPage(
      page([course('c')], 3, 'token-b', 'token-a'),
      { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey },
    ), { subjectKey: learningCourseSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z')));
  });

  it('rejects cumulative page, item, and byte off-by-one overflow', () => {
    const limits = [
      { maxPages: 1, maxItems: 4, maxBytes: 300, firstItems: [course('a')], secondItems: [course('b')], firstBytes: 100, secondBytes: 100 },
      { maxPages: 3, maxItems: 1, maxBytes: 300, firstItems: [course('a')], secondItems: [course('b')], firstBytes: 100, secondBytes: 100 },
      { maxPages: 3, maxItems: 4, maxBytes: 199, firstItems: [course('a')], secondItems: [course('b')], firstBytes: 100, secondBytes: 100 },
    ];
    for (const limit of limits) {
      const context = normalizeLearningOperationContext(operationInput({
        maxPages: limit.maxPages,
        maxItems: limit.maxItems,
        maxBytes: limit.maxBytes,
      }));
      const initial = createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context);
      const first = acceptLearningPageSequence(initial, normalizeLearningPage(
        page(limit.firstItems, 1, null, 'next-2', limit.firstBytes),
        { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey },
      ), { subjectKey: learningCourseSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z'));
      expectInvalid(() => acceptLearningPageSequence(first, normalizeLearningPage(
        page(limit.secondItems, 2, 'next-2', null, limit.secondBytes),
        { normalizeItem: normalizeCourse, subjectKey: learningCourseSubjectKey },
      ), { subjectKey: learningCourseSubjectKey }, context, Date.parse('2026-08-17T11:00:00Z')));
    }
  });

  it('rejects deadline expiry before page acceptance and observes cancellation', () => {
    const deadline = Date.parse('2026-08-17T12:00:00Z');
    const controller = new AbortController();
    const context = normalizeLearningOperationContext(operationInput({ signal: controller.signal }));
    const initial = createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context);
    const firstPage = normalizeLearningPage(page([course('a')]), {
      normalizeItem: normalizeCourse,
      subjectKey: learningCourseSubjectKey,
    });
    expect(acceptLearningPageSequence(
      initial, firstPage, { subjectKey: learningCourseSubjectKey }, context, deadline - 1,
    ).pageCount).toBe(1);
    expectInvalid(() => acceptLearningPageSequence(
      initial, firstPage, { subjectKey: learningCourseSubjectKey }, context, deadline,
    ));
    controller.abort();
    expectInvalid(() => acceptLearningPageSequence(
      initial, firstPage, { subjectKey: learningCourseSubjectKey }, context, deadline - 1,
    ));
  });

  it('normalizes exact operation budget bounds and rejects malformed contexts', () => {
    const normalized = normalizeLearningOperationContext(operationInput({
      maxPages: LEARNING_LIMITS.maxPages,
      maxItems: LEARNING_LIMITS.maxSyncItems,
      maxBytes: LEARNING_LIMITS.maxSyncBytes,
    }));
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.scope)).toBe(true);
    for (const overrides of [
      { maxPages: 0 }, { maxPages: LEARNING_LIMITS.maxPages + 1 },
      { maxItems: 0 }, { maxItems: LEARNING_LIMITS.maxSyncItems + 1 },
      { maxBytes: 0 }, { maxBytes: LEARNING_LIMITS.maxSyncBytes + 1 },
      { signal: {} }, { deadlineAt: 'not-a-time' },
    ]) expectInvalid(() => normalizeLearningOperationContext(operationInput(overrides)));
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
    expectTypeOf<LearningProvider['syncResources']>().toBeFunction();
    expectTypeOf<LearningProvider['syncSubmissions']>().toBeFunction();
    expectTypeOf<LearningProvider['buildLaunchUrl']>().toBeFunction();
    expectTypeOf<LearningProvider['normalizeNotification']>().toBeFunction();
    expectTypeOf<ReturnType<LearningProvider['listCourses']>>()
      .toEqualTypeOf<Promise<LearningProviderPage<ReturnType<typeof normalizeCourse>>>>();
    expectTypeOf<ReturnType<LearningProvider['syncResources']>>()
      .toEqualTypeOf<Promise<LearningProviderPage<LearningResource>>>();
    expectTypeOf<Awaited<ReturnType<LearningProvider['buildLaunchUrl']>>>()
      .toEqualTypeOf<LearningLaunchContract>();
    expectTypeOf<Parameters<LearningProvider['healthCheck']>[1]>()
      .toEqualTypeOf<LearningOperationContext>();
    expectTypeOf<Parameters<LearningProvider['listCourses']>[2]>()
      .toEqualTypeOf<LearningOperationContext>();
    expectTypeOf<Parameters<LearningProvider['syncResources']>[2]>()
      .toEqualTypeOf<LearningOperationContext>();
  });
});
