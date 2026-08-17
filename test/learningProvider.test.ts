import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  LearningProviderError,
  LearningValidationError,
  learningCourseSubjectKey,
  learningCourseUniquenessKeys,
  learningEnrollmentUniquenessKeys,
  learningIdentityUniquenessKeys,
  learningResourceSubjectKey,
  learningSubmissionSubjectKey,
  learningSubmissionUniquenessKeys,
  normalizeLearningConnectionUrlPolicy,
  normalizeLearningCourse,
  normalizeLearningEnrollment,
  normalizeLearningIdentity,
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
  LEARNING_MAX_OPERATION_DURATION_MS,
  normalizeLearningBuildLaunchRequest,
  normalizeLearningHealthRequest,
  normalizeLearningListCoursesRequest,
  normalizeLearningSyncActivitiesRequest,
  normalizeLearningSyncCourseRequest,
  normalizeLearningSyncEnrollmentsRequest,
  normalizeLearningSyncResourcesRequest,
  normalizeLearningSyncSubmissionsRequest,
  type LearningBuildLaunchRequest,
  type LearningHealthRequest,
  type LearningListCoursesRequest,
  type LearningOperationContext,
  type LearningProvider,
  type LearningProviderPage,
  type LearningSyncActivitiesRequest,
  type LearningSyncCourseRequest,
  type LearningSyncEnrollmentsRequest,
  type LearningSyncResourcesRequest,
  type LearningSyncSubmissionsRequest,
} from '../src/lib/learningProvider';

const URL_POLICY = {
  provider: 'canvas',
  connectionId: 7,
  baseUrl: 'https://canvas.church.test',
  providerLaunchOrigins: ['https://canvas.church.test'],
  providerFileOrigins: ['https://files.church.test'],
  externalLinkOrigins: ['https://links.example.test'],
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
    launchUrl: `https://links.example.test/resources/${encodeURIComponent(externalResourceId)}`,
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
    startedAt: '2026-08-17T11:00:00Z',
    deadlineAt: '2026-08-17T12:00:00Z',
    maxPages: 3,
    maxItems: 4,
    maxRawBytes: 300,
    maxNormalizedBytes: 4_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const NOW = Date.parse('2026-08-17T11:00:00Z');
const COURSE_SEQUENCE = Object.freeze({
  normalizeItem: normalizeCourse,
  uniquenessKeys: learningCourseUniquenessKeys,
});
const IDENTITY_SEQUENCE = Object.freeze({
  normalizeItem: normalizeLearningIdentity,
  uniquenessKeys: learningIdentityUniquenessKeys,
});
const ENROLLMENT_SEQUENCE = Object.freeze({
  normalizeItem: normalizeLearningEnrollment,
  uniquenessKeys: learningEnrollmentUniquenessKeys,
});
const SUBMISSION_SEQUENCE = Object.freeze({
  normalizeItem: normalizeSubmission,
  uniquenessKeys: learningSubmissionUniquenessKeys,
});

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
        externalLinkOrigins: origins,
      }), secret);
      expect(touched.value).toBe(false);
    });
  }
});

describe('cross-page scope, progression, and cumulative budgets', () => {
  const normalizeOperation = (overrides: Record<string, unknown> = {}) =>
    normalizeLearningOperationContext(operationInput(overrides), NOW);

  it('re-normalizes forged incoming and existing entity values before accepting them', () => {
    const context = normalizeOperation();
    const initial = createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context);
    for (const [carrierName, carrier] of [
      ['rawPayload', 'secret-provider-raw-payload'],
      ['grade', 'secret-grade'],
      ['unknownField', 'secret-unknown'],
    ] as const) {
      const rawForgedPage = page([
        { ...course('forged'), [carrierName]: carrier },
      ], 1, null, null, 1) as unknown as LearningProviderPage<ReturnType<typeof normalizeCourse>>;
      expectSafeInvalid(() => acceptLearningPageSequence(
        initial, rawForgedPage, COURSE_SEQUENCE, context, NOW,
      ), carrier);
    }
    const missingFieldPage = page([
      { ...course('missing'), displayName: undefined },
    ], 1, null, null, 1) as unknown as LearningProviderPage<ReturnType<typeof normalizeCourse>>;
    expectSafeInvalid(() => acceptLearningPageSequence(
      initial, missingFieldPage, COURSE_SEQUENCE, context, NOW,
    ));

    const first = acceptLearningPageSequence(
      initial, page([course('first')], 1, null, 'next-2'), COURSE_SEQUENCE, context, NOW,
    );
    for (const forgedExisting of [
      { ...first, items: [{ ...first.items[0], rawPayload: 'state-secret' }] },
      { ...first, items: [{ ...first.items[0], grade: 'state-grade-secret' }] },
      { ...first, items: [{ connectionId: 7, provider: 'canvas' }] },
    ]) expectSafeInvalid(() => acceptLearningPageSequence(
      forgedExisting as unknown as typeof first,
      page([course('second')], 2, 'next-2', null),
      COURSE_SEQUENCE,
      context,
      NOW,
    ), 'state-secret');
  });

  it('validates forged state counters, tokens, normalized bytes, and uniqueness keys', () => {
    const context = normalizeOperation();
    const first = acceptLearningPageSequence(
      createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context),
      page([course('first')], 1, null, 'next-2', 100), COURSE_SEQUENCE, context, NOW,
    );
    const forgedStates = [
      { ...first, pageCount: 0 },
      { ...first, itemCount: 2 },
      { ...first, rawResponseBytes: 99 },
      { ...first, normalizedItemBytes: first.normalizedItemBytes + 1 },
      { ...first, seenUniquenessKeys: [] },
      { ...first, seenPageTokens: [] },
      { ...first, expectedPageToken: 'not-the-last-seen-token' },
      { ...first, complete: 1 },
      { ...first, items: [] },
    ];
    for (const forged of forgedStates) expectInvalid(() => acceptLearningPageSequence(
      forged as typeof first,
      page([course('second')], 2, 'next-2', null),
      COURSE_SEQUENCE,
      context,
      NOW,
    ));
  });

  it('deduplicates identities on external-user and person uniqueness within and across pages', () => {
    const context = normalizeOperation();
    const initial = createLearningPageSequence<ReturnType<typeof normalizeLearningIdentity>>(context);
    expectInvalid(() => acceptLearningPageSequence(initial, page([
      { connectionId: 7, provider: 'canvas', personId: 12, externalUserId: 'user-a', status: 'active' },
      { connectionId: 7, provider: 'canvas', personId: 12, externalUserId: 'user-b', status: 'active' },
    ]), IDENTITY_SEQUENCE, context, NOW));

    const first = acceptLearningPageSequence(initial, page([
      { connectionId: 7, provider: 'canvas', personId: 12, externalUserId: 'same-user', status: 'active' },
    ], 1, null, 'next-2'), IDENTITY_SEQUENCE, context, NOW);
    expectInvalid(() => acceptLearningPageSequence(first, page([
      { connectionId: 7, provider: 'canvas', personId: 13, externalUserId: 'same-user', status: 'active' },
    ], 2, 'next-2', null), IDENTITY_SEQUENCE, context, NOW));
  });

  it('deduplicates enrollments on external-enrollment and resolved identity-link uniqueness', () => {
    const context = normalizeOperation({
      scope: {
        provider: 'canvas', connectionId: 7, externalCourseId: 'course-42',
        externalActivityId: null, externalEnrollmentId: null,
      },
    });
    const initial = createLearningPageSequence<ReturnType<typeof normalizeLearningEnrollment>>(context);
    const enrollment = (externalEnrollmentId: string, personId: number, externalUserId: string) => ({
      connectionId: 7, provider: 'canvas', externalCourseId: 'course-42', personId,
      externalUserId, externalEnrollmentId, role: 'student', state: 'active', lastSyncedAt: null,
    });
    expectInvalid(() => acceptLearningPageSequence(initial, page([
      enrollment('enrollment-a', 12, 'user-12'),
      enrollment('enrollment-b', 12, 'user-12'),
    ]), ENROLLMENT_SEQUENCE, context, NOW));
    expectInvalid(() => acceptLearningPageSequence(initial, page([
      enrollment('enrollment-a', 12, 'user-a'),
      enrollment('enrollment-b', 12, 'user-b'),
    ]), ENROLLMENT_SEQUENCE, context, NOW));
    expectInvalid(() => acceptLearningPageSequence(initial, page([
      enrollment('enrollment-a', 12, 'same-user'),
      enrollment('enrollment-b', 13, 'same-user'),
    ]), ENROLLMENT_SEQUENCE, context, NOW));
    const first = acceptLearningPageSequence(
      initial, page([enrollment('same-enrollment', 12, 'user-12')], 1, null, 'next-2'),
      ENROLLMENT_SEQUENCE, context, NOW,
    );
    expectInvalid(() => acceptLearningPageSequence(
      first, page([enrollment('same-enrollment', 13, 'user-13')], 2, 'next-2', null),
      ENROLLMENT_SEQUENCE, context, NOW,
    ));
  });

  it('requires ordinary nonempty uniqueness-key arrays and never leaks hostile failures', () => {
    const context = normalizeOperation();
    const initial = createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context);
    expectInvalid(() => acceptLearningPageSequence(
      initial, page([course('a')]), { normalizeItem: normalizeCourse, uniquenessKeys: () => [] }, context, NOW,
    ));
    const secret = 'secret-uniqueness-reflection';
    expectSafeInvalid(() => acceptLearningPageSequence(initial, page([course('a')]), {
      normalizeItem: normalizeCourse,
      uniquenessKeys() {
        return new Proxy(['key'], { ownKeys() { throw new Error(secret); } });
      },
    }, context, NOW), secret);
  });

  it('accepts a deterministic monotonic sequence and freezes independent byte counters', () => {
    const context = normalizeOperation({ maxPages: 2, maxItems: 2, maxRawBytes: 200 });
    const initial = createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context);
    const afterFirst = acceptLearningPageSequence(
      initial, page([course('b')], 1, null, 'next-2', 100), COURSE_SEQUENCE, context, NOW,
    );
    const complete = acceptLearningPageSequence(
      afterFirst, page([course('a')], 2, 'next-2', null, 100), COURSE_SEQUENCE, context, NOW,
    );
    expect(complete).toMatchObject({
      pageCount: 2, itemCount: 2, rawResponseBytes: 200,
      expectedPageToken: null, complete: 1,
    });
    expect(complete.normalizedItemBytes).toBeGreaterThan(200);
    expect(complete.items.map((item) => item.externalCourseId)).toEqual(['a', 'b']);
    expect(Object.isFrozen(complete)).toBe(true);
    expect(Object.isFrozen(complete.items)).toBe(true);
    expect(Object.isFrozen(complete.seenUniquenessKeys)).toBe(true);
    expect(Object.isFrozen(complete.seenPageTokens)).toBe(true);
  });

  it('rejects out-of-scope new and forged existing records', () => {
    const context = normalizeOperation();
    const initial = createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context);
    const wrongPolicy = { ...URL_POLICY, connectionId: 8 } as const;
    expectInvalid(() => acceptLearningPageSequence(
      initial, page([{ ...course('wrong'), connectionId: 8 }]), {
        normalizeItem: (value) => normalizeLearningCourse(value, wrongPolicy),
        uniquenessKeys: learningCourseUniquenessKeys,
      }, context, NOW,
    ));
    const first = acceptLearningPageSequence(
      initial, page([course('first')], 1, null, 'next-2'), COURSE_SEQUENCE, context, NOW,
    );
    const wrongExistingItem = normalizeLearningCourse({
      ...course('wrong-existing'), connectionId: 8,
    }, wrongPolicy);
    expectInvalid(() => acceptLearningPageSequence({
      ...first,
      items: [wrongExistingItem],
      seenUniquenessKeys: learningCourseUniquenessKeys(wrongExistingItem),
    }, page([course('second')], 2, 'next-2', null), COURSE_SEQUENCE, context, NOW));
  });

  it('binds nested course, activity, and enrollment scope for submissions', () => {
    const context = normalizeOperation({
      scope: {
        provider: 'canvas', connectionId: 7, externalCourseId: 'course-42',
        externalActivityId: 'activity-3', externalEnrollmentId: 'enrollment-9',
      },
    });
    const initial = createLearningPageSequence<ReturnType<typeof normalizeSubmission>>(context);
    expect(acceptLearningPageSequence(
      initial, page([submission()]), SUBMISSION_SEQUENCE, context, NOW,
    ).complete).toBe(1);
    expectInvalid(() => acceptLearningPageSequence(
      initial, page([submission({ externalEnrollmentId: 'enrollment-other' })]),
      SUBMISSION_SEQUENCE, context, NOW,
    ));
  });

  it('rejects non-monotonic pages and repeated or cyclic pagination tokens', () => {
    const context = normalizeOperation();
    const initial = createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context);
    expectInvalid(() => acceptLearningPageSequence(
      initial, page([course('a')], 2), COURSE_SEQUENCE, context, NOW,
    ));
    const first = acceptLearningPageSequence(
      initial, page([course('a')], 1, null, 'token-a'), COURSE_SEQUENCE, context, NOW,
    );
    expectInvalid(() => acceptLearningPageSequence(
      first, page([course('b')], 2, 'wrong-token'), COURSE_SEQUENCE, context, NOW,
    ));
    expectInvalid(() => acceptLearningPageSequence(
      first, page([course('b')], 2, 'token-a', 'token-a'), COURSE_SEQUENCE, context, NOW,
    ));
    const second = acceptLearningPageSequence(
      first, page([course('b')], 2, 'token-a', 'token-b'), COURSE_SEQUENCE, context, NOW,
    );
    expectInvalid(() => acceptLearningPageSequence(
      second, page([course('c')], 3, 'token-b', 'token-a'), COURSE_SEQUENCE, context, NOW,
    ));
  });

  it('bounds raw and normalized bytes independently even when raw bytes are underreported', () => {
    const normalized = normalizeCourse(course('a'));
    const sorted = Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
    const normalizedBytes = new TextEncoder().encode(JSON.stringify(sorted)).byteLength;
    const exactContext = normalizeOperation({
      maxPages: 1, maxItems: 1, maxRawBytes: 100, maxNormalizedBytes: normalizedBytes,
    });
    const final = acceptLearningPageSequence(
      createLearningPageSequence<ReturnType<typeof normalizeCourse>>(exactContext),
      page([course('a')], 1, null, null, 100), COURSE_SEQUENCE, exactContext, NOW,
    );
    expect(final).toMatchObject({ rawResponseBytes: 100, normalizedItemBytes: normalizedBytes, complete: 1 });

    const normalizedOverflow = normalizeOperation({ maxNormalizedBytes: normalizedBytes - 1 });
    expectInvalid(() => acceptLearningPageSequence(
      createLearningPageSequence<ReturnType<typeof normalizeCourse>>(normalizedOverflow),
      page([course('a')], 1, null, null, 0), COURSE_SEQUENCE, normalizedOverflow, NOW,
    ));
    const rawOverflow = normalizeOperation({ maxRawBytes: 99 });
    expectInvalid(() => acceptLearningPageSequence(
      createLearningPageSequence<ReturnType<typeof normalizeCourse>>(rawOverflow),
      page([course('a')], 1, null, null, 100), COURSE_SEQUENCE, rawOverflow, NOW,
    ));
  });

  it('rejects incomplete pages that exactly exhaust any terminal capacity', () => {
    const normalized = normalizeCourse(course('a'));
    const sorted = Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
    const normalizedBytes = new TextEncoder().encode(JSON.stringify(sorted)).byteLength;
    const cases = [
      { maxPages: 1 },
      { maxItems: 1 },
      { maxRawBytes: 100 },
      { maxNormalizedBytes: normalizedBytes },
    ];
    for (const limits of cases) {
      const context = normalizeOperation(limits);
      expectInvalid(() => acceptLearningPageSequence(
        createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context),
        page([course('a')], 1, null, 'requires-another-page', 100),
        COURSE_SEQUENCE,
        context,
        NOW,
      ));
    }
  });

  it('caps operation duration and rejects past, future-started, reversed, and expired contexts', () => {
    expect(LEARNING_MAX_OPERATION_DURATION_MS).toBe(3_600_000);
    const exact = normalizeLearningOperationContext(operationInput({
      deadlineAt: new Date(NOW + LEARNING_MAX_OPERATION_DURATION_MS).toISOString(),
    }), NOW);
    expect(Object.isFrozen(exact)).toBe(true);
    expect(Object.isFrozen(exact.scope)).toBe(true);
    for (const overrides of [
      { deadlineAt: new Date(NOW + LEARNING_MAX_OPERATION_DURATION_MS + 1).toISOString() },
      { startedAt: new Date(NOW + 1).toISOString() },
      { deadlineAt: new Date(NOW).toISOString() },
      { startedAt: new Date(NOW + 10).toISOString(), deadlineAt: new Date(NOW + 5).toISOString() },
      { deadlineAt: 'not-a-time' },
    ]) expectInvalid(() => normalizeLearningOperationContext(operationInput(overrides), NOW));
  });

  it('rejects deadline expiry before page normalization and observes cancellation', () => {
    const deadline = Date.parse('2026-08-17T12:00:00Z');
    const controller = new AbortController();
    const context = normalizeLearningOperationContext(operationInput({ signal: controller.signal }), NOW);
    const initial = createLearningPageSequence<ReturnType<typeof normalizeCourse>>(context);
    expect(acceptLearningPageSequence(
      initial, page([course('a')]), COURSE_SEQUENCE, context, deadline - 1,
    ).pageCount).toBe(1);
    expectInvalid(() => acceptLearningPageSequence(
      initial, page([course('a')]), COURSE_SEQUENCE, context, deadline,
    ));
    controller.abort();
    expectInvalid(() => acceptLearningPageSequence(
      initial, page([course('a')]), COURSE_SEQUENCE, context, deadline - 1,
    ));
  });

  it('normalizes independent budget bounds and rejects malformed contexts', () => {
    const normalized = normalizeOperation({
      maxPages: LEARNING_LIMITS.maxPages,
      maxItems: LEARNING_LIMITS.maxSyncItems,
      maxRawBytes: LEARNING_LIMITS.maxSyncBytes,
      maxNormalizedBytes: LEARNING_LIMITS.maxSyncBytes,
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    for (const overrides of [
      { maxPages: 0 }, { maxPages: LEARNING_LIMITS.maxPages + 1 },
      { maxItems: 0 }, { maxItems: LEARNING_LIMITS.maxSyncItems + 1 },
      { maxRawBytes: 0 }, { maxRawBytes: LEARNING_LIMITS.maxSyncBytes + 1 },
      { maxNormalizedBytes: 0 }, { maxNormalizedBytes: LEARNING_LIMITS.maxSyncBytes + 1 },
      { signal: {} },
    ]) expectInvalid(() => normalizeLearningOperationContext(operationInput(overrides), NOW));
  });
});

describe('provider operation request scope binding', () => {
  const providerSubject = { provider: 'canvas', connectionId: 7 } as const;
  const courseSubject = { ...providerSubject, externalCourseId: 'course-42' } as const;
  const activitySubject = { ...courseSubject, externalActivityId: 'activity-3' } as const;
  const submissionSubject = { ...activitySubject, externalEnrollmentId: 'enrollment-9' } as const;
  const pageRequest = { pageSize: 50, pageNumber: 1, pageToken: null } as const;
  const operationFor = (
    externalCourseId: string | null,
    externalActivityId: string | null,
    externalEnrollmentId: string | null,
  ) => operationInput({
    scope: { ...providerSubject, externalCourseId, externalActivityId, externalEnrollmentId },
  });

  it('normalizes every exact provider request category and keeps cancellation in the request', () => {
    const requests = [
      normalizeLearningHealthRequest({
        subject: providerSubject, operation: operationFor(null, null, null),
      }, NOW),
      normalizeLearningListCoursesRequest({
        subject: providerSubject, page: pageRequest, operation: operationFor(null, null, null),
      }, NOW),
      normalizeLearningSyncCourseRequest({
        subject: courseSubject, operation: operationFor('course-42', null, null),
      }, NOW),
      normalizeLearningSyncEnrollmentsRequest({
        subject: courseSubject, page: pageRequest, operation: operationFor('course-42', null, null),
      }, NOW),
      normalizeLearningSyncActivitiesRequest({
        subject: courseSubject, page: pageRequest, operation: operationFor('course-42', null, null),
      }, NOW),
      normalizeLearningSyncResourcesRequest({
        subject: activitySubject, page: pageRequest, operation: operationFor('course-42', 'activity-3', null),
      }, NOW),
      normalizeLearningSyncSubmissionsRequest({
        subject: submissionSubject,
        page: pageRequest,
        operation: operationFor('course-42', 'activity-3', 'enrollment-9'),
      }, NOW),
      normalizeLearningBuildLaunchRequest({
        subject: activitySubject, operation: operationFor('course-42', 'activity-3', null),
      }, NOW),
    ];
    for (const request of requests) {
      expect(Object.isFrozen(request)).toBe(true);
      expect(request.operation.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('rejects provider, course, activity, and enrollment scope mismatches for every operation', () => {
    const cases: Array<[(value: unknown, now: number) => unknown, Record<string, unknown>]> = [
      [normalizeLearningHealthRequest, {
        subject: providerSubject,
        operation: operationInput({
          scope: {
            ...providerSubject, connectionId: 8,
            externalCourseId: null, externalActivityId: null, externalEnrollmentId: null,
          },
        }),
      }],
      [normalizeLearningListCoursesRequest, {
        subject: providerSubject,
        page: pageRequest,
        operation: operationInput({
          scope: {
            provider: 'google_classroom', connectionId: 7,
            externalCourseId: null, externalActivityId: null, externalEnrollmentId: null,
          },
        }),
      }],
      [normalizeLearningSyncCourseRequest, {
        subject: courseSubject, operation: operationFor('course-other', null, null),
      }],
      [normalizeLearningSyncEnrollmentsRequest, {
        subject: courseSubject, page: pageRequest, operation: operationFor('course-other', null, null),
      }],
      [normalizeLearningSyncActivitiesRequest, {
        subject: courseSubject, page: pageRequest, operation: operationFor('course-other', null, null),
      }],
      [normalizeLearningSyncResourcesRequest, {
        subject: activitySubject, page: pageRequest, operation: operationFor('course-42', 'activity-other', null),
      }],
      [normalizeLearningSyncSubmissionsRequest, {
        subject: submissionSubject,
        page: pageRequest,
        operation: operationFor('course-42', 'activity-3', 'enrollment-other'),
      }],
      [normalizeLearningBuildLaunchRequest, {
        subject: activitySubject, operation: operationFor('course-42', 'activity-other', null),
      }],
    ];
    for (const [normalize, input] of cases) expectInvalid(() => normalize(input, NOW));
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
    expectTypeOf<Parameters<LearningProvider['healthCheck']>[0]>().toEqualTypeOf<LearningHealthRequest>();
    expectTypeOf<Parameters<LearningProvider['listCourses']>[0]>().toEqualTypeOf<LearningListCoursesRequest>();
    expectTypeOf<Parameters<LearningProvider['syncCourse']>[0]>().toEqualTypeOf<LearningSyncCourseRequest>();
    expectTypeOf<Parameters<LearningProvider['syncEnrollments']>[0]>()
      .toEqualTypeOf<LearningSyncEnrollmentsRequest>();
    expectTypeOf<Parameters<LearningProvider['syncActivities']>[0]>()
      .toEqualTypeOf<LearningSyncActivitiesRequest>();
    expectTypeOf<Parameters<LearningProvider['syncResources']>[0]>()
      .toEqualTypeOf<LearningSyncResourcesRequest>();
    expectTypeOf<Parameters<LearningProvider['syncSubmissions']>[0]>()
      .toEqualTypeOf<LearningSyncSubmissionsRequest>();
    expectTypeOf<Parameters<LearningProvider['buildLaunchUrl']>[0]>()
      .toEqualTypeOf<LearningBuildLaunchRequest>();
    expectTypeOf<LearningHealthRequest['operation']>().toEqualTypeOf<LearningOperationContext>();
  });
});
