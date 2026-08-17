import { describe, expect, expectTypeOf, it } from 'vitest';
import * as learningModelModule from '../src/lib/learningModel';
import * as learningProviderModule from '../src/lib/learningProvider';
import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  LearningProviderError,
  LearningValidationError,
  learningActivityUniquenessKeys,
  learningCourseUniquenessKeys,
  learningProviderEnrollmentUniquenessKeys,
  learningResourceUniquenessKeys,
  learningSyntheticEnrollmentId,
  normalizeLearningActivity,
  normalizeLearningCourse,
  normalizeLearningProviderEnrollment,
  normalizeLearningResource,
  type LearningActivity,
  type LearningConnectionUrlPolicy,
  type LearningCourse,
  type LearningLaunchContract,
  type LearningProviderEnrollment,
  type LearningProviderSubmission,
  type LearningResource,
} from '../src/lib/learningModel';
import {
  LEARNING_MAX_OPERATION_DURATION_MS,
  normalizeLearningBuildLaunchRequest,
  normalizeLearningHealthRequest,
  normalizeLearningListCoursesRequest,
  normalizeLearningOperationContext,
  normalizeLearningPageRequest,
  normalizeLearningProviderError,
  normalizeLearningSyncActivitiesRequest,
  normalizeLearningSyncCourseRequest,
  normalizeLearningSyncEnrollmentsRequest,
  normalizeLearningSyncResourcesRequest,
  normalizeLearningSyncResult,
  normalizeLearningSyncSubmissionsRequest,
  readAndNormalizeLearningPage,
  type LearningBuildLaunchRequest,
  type LearningHealthRequest,
  type LearningListCoursesRequest,
  type LearningOperationContext,
  type LearningPageAccumulator,
  type LearningProviderPage,
  type LearningProvider,
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

const GOOGLE_URL_POLICY = {
  provider: 'google_classroom',
  connectionId: 8,
  baseUrl: null,
  providerLaunchOrigins: ['https://classroom.google.com'],
  providerFileOrigins: ['https://drive.google.com', 'https://files.googleusercontent.com'],
  externalLinkOrigins: ['https://links.example.test'],
} as const;

const ROLE_SWAPPED_URL_POLICY = {
  ...URL_POLICY,
  providerFileOrigins: URL_POLICY.externalLinkOrigins,
  externalLinkOrigins: URL_POLICY.providerFileOrigins,
} as const;

const NOW = Date.parse('2026-08-17T11:00:00Z');

type RuntimePage<T extends object> = {
  readonly items: readonly T[];
  readonly requestPageToken: string | null;
  readonly nextPageToken: string | null;
  readonly pageNumber: number;
  readonly responseBytes: number;
};
type RuntimeAccumulator<T extends object> = {
  readonly view: {
    readonly scope: Record<string, unknown>;
    readonly pageCount: number;
    readonly itemCount: number;
    readonly rawResponseBytes: number;
    readonly normalizedItemBytes: number;
    readonly uniquenessKeyBytes: number;
    readonly expectedPageToken: string | null;
    readonly seenPageTokens: readonly string[];
    readonly seenUniquenessKeys: readonly string[];
    readonly items: readonly T[];
    readonly complete: 0 | 1;
  };
  accept(page: RuntimePage<T>, now: number): RuntimeAccumulator<T>;
};

const providerApi = learningProviderModule as unknown as {
  readAndNormalizeLearningPage<T extends object>(
    response: Response,
    operation: LearningOperationContext,
    decode: (value: unknown) => unknown,
    contract: RuntimePageContract,
    now: () => number,
  ): Promise<RuntimePage<T>>;
  createLearningPageAccumulator<T extends object>(
    operation: LearningOperationContext,
    contract: {
      page: RuntimePageContract;
      normalizeItem(value: unknown): T;
      uniquenessKeys(value: T): readonly string[];
    },
  ): RuntimeAccumulator<T>;
  invokeLearningProvider(provider: LearningProvider, invocation: Record<string, unknown>): Promise<unknown>;
};

type RuntimePageContract =
  | { readonly kind: 'courses'; readonly urlPolicy: LearningConnectionUrlPolicy }
  | { readonly kind: 'provider_enrollments' }
  | { readonly kind: 'activities'; readonly urlPolicy: LearningConnectionUrlPolicy }
  | { readonly kind: 'resources'; readonly urlPolicy: LearningConnectionUrlPolicy }
  | { readonly kind: 'provider_submissions' };

type RuntimePageItem<C extends RuntimePageContract> =
  C extends { kind: 'courses' } ? LearningCourse
    : C extends { kind: 'provider_enrollments' } ? LearningProviderEnrollment
      : C extends { kind: 'activities' } ? LearningActivity
        : C extends { kind: 'resources' } ? LearningResource
          : LearningProviderSubmission;

const submissionApi = learningModelModule as unknown as {
  normalizeLearningProviderSubmission(value: unknown): LearningProviderSubmission;
  learningProviderSubmissionSubjectKey(value: LearningProviderSubmission): string;
  learningProviderSubmissionUniquenessKeys(value: LearningProviderSubmission): readonly string[];
};

function course(externalCourseId: string, displayName = externalCourseId): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId,
    displayName,
    launchUrl: `https://canvas.church.test/courses/${encodeURIComponent(externalCourseId)}`,
    lifecycleState: 'active',
    providerUpdatedAt: '2026-08-16T15:30:00.123456789Z',
    lastSyncedAt: null,
  };
}

function resource(externalResourceId: string): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId: 'course-42',
    externalActivityId: 'activity-3',
    externalResourceId,
    title: externalResourceId,
    kind: 'link',
    launchUrl: `https://links.example.test/resources/${encodeURIComponent(externalResourceId)}`,
    youtubeVideoId: null,
    mimeType: null,
    sizeBytes: null,
    providerUpdatedAt: '2026-08-16T15:30:00Z',
  };
}

function activity(externalActivityId: string): Record<string, unknown> {
  return {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId: 'course-42',
    externalActivityId,
    title: 'Reflection quiz',
    kind: 'quiz',
    lifecycleState: 'published',
    launchUrl: `https://canvas.church.test/courses/course-42/quizzes/${externalActivityId}`,
    dueAt: null,
    publishedAt: '2026-08-15T12:00:00Z',
    providerUpdatedAt: '2026-08-16T15:32:00Z',
    lastSyncedAt: null,
  };
}

function providerEnrollment(externalUserId: string, role = 'student'): Record<string, unknown> {
  return {
    connectionId: 8,
    provider: 'google_classroom',
    externalCourseId: 'google-course-1',
    externalUserId,
    externalEnrollmentId: learningSyntheticEnrollmentId({
      provider: 'google_classroom', externalCourseId: 'google-course-1', externalUserId,
    }),
    role,
    state: 'active',
  };
}

function providerSubmission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const provider = (overrides.provider ?? 'canvas') as 'canvas' | 'google_classroom';
  const externalCourseId = String(overrides.externalCourseId ?? 'course-42');
  const externalUserId = String(overrides.externalUserId ?? 'user-12');
  return {
    connectionId: provider === 'canvas' ? 7 : 8,
    provider,
    externalCourseId,
    externalActivityId: 'activity-3',
    externalUserId,
    externalEnrollmentId: learningSyntheticEnrollmentId({ provider, externalCourseId, externalUserId }),
    status: 'submitted',
    late: 0,
    attemptNumber: 1,
    submittedAt: '2026-08-16T15:40:00Z',
    returnedAt: null,
    providerUpdatedAt: '2026-08-16T15:40:05Z',
    ...overrides,
  };
}

function pageBody(
  items: unknown,
  pageNumber = 1,
  requestPageToken: string | null = null,
  nextPageToken: string | null = null,
): Record<string, unknown> {
  return { items, requestPageToken, nextPageToken, pageNumber };
}

function operationInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: {
      provider: 'canvas', connectionId: 7,
      externalCourseId: null, externalActivityId: null, externalEnrollmentId: null,
    },
    startedAt: '2026-08-17T11:00:00Z',
    deadlineAt: '2026-08-17T12:00:00Z',
    maxPages: 3,
    maxItems: 4,
    maxRawBytes: 20_000,
    maxNormalizedBytes: 20_000,
    maxUniqueKeyBytes: 4_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function normalizedOperation(overrides: Record<string, unknown> = {}, now = NOW): LearningOperationContext {
  return normalizeLearningOperationContext(operationInput(overrides), now);
}

function expectInvalid(run: () => unknown): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(LearningValidationError);
  expect(String(caught)).toContain('Learning input is invalid');
}

function expectSafeInvalid(run: () => unknown, secret?: string): void {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(LearningValidationError);
  expect(String(caught)).toBe('LearningValidationError: Learning input is invalid');
  if (secret) expect(String(caught)).not.toContain(secret);
}

async function expectProviderReject(
  run: () => Promise<unknown>, code: string, secret?: string,
): Promise<void> {
  let caught: unknown;
  try { await run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(LearningProviderError);
  expect(caught).toMatchObject({ code });
  if (secret) expect(String(caught)).not.toContain(secret);
}

const COURSE_PAGE = Object.freeze({ kind: 'courses', urlPolicy: URL_POLICY } as const);
const COURSE_SEQUENCE = Object.freeze({
  page: COURSE_PAGE,
  normalizeItem: (value: unknown) => normalizeLearningCourse(value, URL_POLICY),
  uniquenessKeys: learningCourseUniquenessKeys,
});
const PROVIDER_ENROLLMENT_PAGE = Object.freeze({ kind: 'provider_enrollments' } as const);
const ACTIVITY_PAGE = Object.freeze({ kind: 'activities', urlPolicy: URL_POLICY } as const);
const RESOURCE_PAGE = Object.freeze({ kind: 'resources', urlPolicy: URL_POLICY } as const);
const PROVIDER_SUBMISSION_PAGE = Object.freeze({ kind: 'provider_submissions' } as const);
const PROVIDER_ENROLLMENT_SEQUENCE = Object.freeze({
  page: PROVIDER_ENROLLMENT_PAGE,
  normalizeItem: normalizeLearningProviderEnrollment,
  uniquenessKeys: learningProviderEnrollmentUniquenessKeys,
});
const ACTIVITY_SEQUENCE = Object.freeze({
  page: ACTIVITY_PAGE,
  normalizeItem: (value: unknown) => normalizeLearningActivity(value, URL_POLICY),
  uniquenessKeys: learningActivityUniquenessKeys,
});
const RESOURCE_SEQUENCE = Object.freeze({
  page: RESOURCE_PAGE,
  normalizeItem: (value: unknown) => normalizeLearningResource(value, URL_POLICY),
  uniquenessKeys: learningResourceUniquenessKeys,
});
const PROVIDER_SUBMISSION_SEQUENCE = Object.freeze({
  page: PROVIDER_SUBMISSION_PAGE,
  normalizeItem: submissionApi.normalizeLearningProviderSubmission,
  uniquenessKeys: submissionApi.learningProviderSubmissionUniquenessKeys,
});

async function normalizedPage<C extends RuntimePageContract>(
  body: unknown,
  contract: C,
  operation = normalizedOperation(),
  headers?: HeadersInit,
  decode: (value: unknown) => unknown = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return { ...(value as Record<string, unknown>) };
  },
): Promise<RuntimePage<RuntimePageItem<C>>> {
  return providerApi.readAndNormalizeLearningPage<RuntimePageItem<C>>(
    new Response(JSON.stringify(body), { headers }), operation, decode, contract, () => NOW,
  );
}

function chunkedResponse(
  chunks: readonly Uint8Array[], onCancel: () => void, headers?: HeadersInit,
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() { onCancel(); },
  }), { headers });
}

describe('bounded page requests and measured response bodies', () => {
  it('exports only a closed page stream boundary, never a generic raw/value envelope', () => {
    expect('readLearningJsonResponse' in learningProviderModule).toBe(false);
    expect('LearningMeasuredPayload' in learningProviderModule).toBe(false);
    expect('readAndNormalizeLearningResponse' in learningProviderModule).toBe(false);
    expect('normalizeLearningPage' in learningProviderModule).toBe(false);
    expect('readAndNormalizeLearningPage' in learningProviderModule).toBe(true);
  });

  it('normalizes explicit page bounds and rejects unsafe tokens', () => {
    expect(normalizeLearningPageRequest({ pageSize: 100, pageNumber: 100, pageToken: ' next ' }))
      .toEqual({ pageSize: 100, pageNumber: 100, pageToken: 'next' });
    for (const input of [
      { pageSize: 0, pageNumber: 1, pageToken: null },
      { pageSize: 101, pageNumber: 1, pageToken: null },
      { pageSize: 10, pageNumber: 0, pageToken: null },
      { pageSize: 10, pageNumber: 1, pageToken: 'bad\ntoken' },
      { pageSize: 10, pageNumber: 1, pageToken: null, accessToken: 'secret' },
    ]) expectInvalid(() => normalizeLearningPageRequest(input));
  });

  it('measures exact streamed UTF-8 bytes and returns only the final branded frozen page', async () => {
    const secret = 'raw-token-must-disappear';
    const text = JSON.stringify({ rawToken: secret, page: pageBody([course('course-a')]) });
    const byteCount = new TextEncoder().encode(text).byteLength;
    const result = await providerApi.readAndNormalizeLearningPage<LearningCourse>(
      new Response(text, { headers: { 'Content-Length': String(byteCount) } }),
      normalizedOperation({ maxRawBytes: byteCount }),
      (value) => (value as { page: unknown }).page,
      COURSE_PAGE,
      () => NOW,
    );
    expect(result.responseBytes).toBe(byteCount);
    expect(result.items[0].externalCourseId).toBe('course-a');
    expect(result).not.toHaveProperty('payload');
    expect(result).not.toHaveProperty('value');
    expect(result).not.toHaveProperty('measurement');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
  });

  it('rejects shallow and deep raw clones before any raw carrier can escape', async () => {
    const secret = 'secret-token-retained-by-clone';
    const body = { ...pageBody([course('course-a')]), token: secret };
    const decoders = [
      (value: unknown) => ({ ...(value as Record<string, unknown>) }),
      (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown,
    ];
    for (const decode of decoders) {
      await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
        new Response(JSON.stringify(body)), normalizedOperation(), decode, COURSE_PAGE, () => NOW,
      ), 'malformed_response', secret);
    }
  });

  it('rejects identity/raw entity candidates and sanitizes their provider body', async () => {
    const secret = 'secret-grade-and-answer';
    await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
      new Response(JSON.stringify(pageBody([{ ...course('course-a'), grade: secret, answer: secret }]))),
      normalizedOperation(),
      (value) => value,
      COURSE_PAGE,
      () => NOW,
    ), 'malformed_response', secret);
  });

  it('sanitizes provider decoder exceptions without exposing adapter messages', async () => {
    const secret = 'secret-provider-decoder-message';
    await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
      new Response(JSON.stringify(pageBody([course('course-a')]))),
      normalizedOperation(),
      () => { throw new Error(secret); },
      COURSE_PAGE,
      () => NOW,
    ), 'malformed_response', secret);
  });

  it('rejects lying Content-Length and invalid JSON without leaking raw bodies', async () => {
    const body = '{"access_token":"secret-not-json"';
    await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
      new Response(body, { headers: { 'Content-Length': String(body.length - 1) } }),
      normalizedOperation(), (value) => value, COURSE_PAGE, () => NOW,
    ), 'malformed_response', 'secret-not-json');
    await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
      new Response(body), normalizedOperation(), (value) => value, COURSE_PAGE, () => NOW,
    ), 'malformed_response', 'secret-not-json');
  });

  it('rejects invalid UTF-8 before JSON parsing', async () => {
    const response = new Response(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]));
    await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
      response, normalizedOperation(), (value) => value, COURSE_PAGE, () => NOW,
    ), 'malformed_response');
  });

  it('cancels a multi-chunk reader immediately on actual-byte overflow', async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const response = chunkedResponse([
      encoder.encode('{"items":['),
      encoder.encode('"secret-overflow-payload"'.repeat(20)),
      encoder.encode(']}'),
    ], () => { cancelled = true; }, { 'Content-Length': '1' });
    await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
      response, normalizedOperation({ maxRawBytes: 32 }), (value) => value, COURSE_PAGE, () => NOW,
    ), 'response_too_large', 'secret-overflow-payload');
    expect(cancelled).toBe(true);
  });

  it('rejects an over-limit declared length and cancels before reading', async () => {
    let cancelled = false;
    const response = chunkedResponse(
      [new TextEncoder().encode('{"items":[]}')],
      () => { cancelled = true; },
      { 'Content-Length': '33' },
    );
    await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
      response, normalizedOperation({ maxRawBytes: 32 }), (value) => value, COURSE_PAGE, () => NOW,
    ), 'response_too_large');
    expect(cancelled).toBe(true);
  });

  it('cancels supplied readers on abort and deadline before JSON parsing', async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    controller.abort();
    let abortCancelled = false;
    await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
      chunkedResponse([encoder.encode('{"secret":"abort"}')], () => { abortCancelled = true; }),
      normalizedOperation({ signal: controller.signal }), (value) => value, COURSE_PAGE, () => NOW,
    ), 'cancelled', 'abort');
    expect(abortCancelled).toBe(true);

    let deadlineCancelled = false;
    await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
      chunkedResponse([encoder.encode('{"secret":"deadline"}')], () => { deadlineCancelled = true; }),
      normalizedOperation(), (value) => value, COURSE_PAGE, () => Date.parse('2026-08-17T12:00:00Z'),
    ), 'timeout', 'deadline');
    expect(deadlineCancelled).toBe(true);
  });
});

describe('sanitized page and contract normalization', () => {
  it('dispatches every closed page kind through its module-owned exact normalizer', async () => {
    const operation = normalizedOperation({
      scope: {
        provider: 'canvas', connectionId: 7, externalCourseId: 'course-42',
        externalActivityId: null, externalEnrollmentId: null,
      },
    });
    const page = await normalizedPage(pageBody([activity('activity-3')]), ACTIVITY_PAGE, operation);
    expect(page.items[0]).toMatchObject({ externalActivityId: 'activity-3', kind: 'quiz' });
    expect(Object.isFrozen(page.items[0])).toBe(true);
    await expectProviderReject(() => normalizedPage(
      pageBody([]), { kind: 'activities' } as RuntimePageContract, operation,
    ), 'malformed_response');
    await expectProviderReject(() => normalizedPage(
      pageBody([]), { kind: 'unknown' } as unknown as RuntimePageContract, operation,
    ), 'malformed_response');
    await expectProviderReject(() => normalizedPage(
      pageBody([]), { kind: 'activities', urlPolicy: { ...URL_POLICY, connectionId: 8 } }, operation,
    ), 'malformed_response');
  });

  it('normalizes measured pages deterministically and rejects conflicting duplicates', async () => {
    const raw = pageBody([course('z'), course('a'), course('z')], 1, null, 'next');
    const page = await normalizedPage(raw, COURSE_PAGE);
    expect(page.items.map((item) => item.externalCourseId)).toEqual(['a', 'z']);
    expect(page.responseBytes).toBe(new TextEncoder().encode(JSON.stringify(raw)).byteLength);
    expect(Object.isFrozen(page.items[0])).toBe(true);
    await expectProviderReject(() => normalizedPage(
      pageBody([course('same', 'First'), course('same', 'Second')]), COURSE_PAGE,
    ), 'malformed_response');
  });

  it('enforces page item counts, page numbers, per-item bytes, and exact page fields', async () => {
    const largeResponseOperation = normalizedOperation({ maxRawBytes: LEARNING_LIMITS.maxSyncBytes });
    await expectProviderReject(() => normalizedPage(pageBody(
      Array.from({ length: LEARNING_LIMITS.maxPageItems + 1 }, (_, index) => course(String(index))),
    ), COURSE_PAGE, largeResponseOperation), 'malformed_response');
    await expectProviderReject(() => normalizedPage(
      pageBody([], LEARNING_LIMITS.maxPages + 1), COURSE_PAGE,
    ), 'malformed_response');
    await expectProviderReject(() => normalizedPage(
      pageBody([course('large', 'x'.repeat(LEARNING_LIMITS.maxItemBytes + 1))]),
      COURSE_PAGE, largeResponseOperation,
    ), 'malformed_response');
    await expectProviderReject(() => normalizedPage(
      { ...pageBody([]), rawBody: 'secret' }, COURSE_PAGE,
    ), 'malformed_response', 'secret');
  });

  it('has no public generic envelope or standalone page-branding surface', () => {
    expect('readAndNormalizeLearningResponse' in learningProviderModule).toBe(false);
    expect('normalizeLearningPage' in learningProviderModule).toBe(false);
    expect('LearningNormalizedResponse' in learningProviderModule).toBe(false);
  });

  it('retrieves closed contract properties through data descriptors without invoking hostile getters', async () => {
    const secret = 'secret-contract-getter';
    let touched = false;
    const contract = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(contract, 'kind', { enumerable: true, value: 'courses' });
    Object.defineProperty(contract, 'urlPolicy', {
      enumerable: true,
      get() { touched = true; throw new Error(secret); },
    });
    await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
      new Response(JSON.stringify(pageBody([]))), normalizedOperation(),
      (value) => value, contract as RuntimePageContract, () => NOW,
    ), 'malformed_response', secret);
    expect(touched).toBe(false);
  });

  it('sanitizes contract descriptor and ownKeys Proxy failures', () => {
    for (const contract of [
      new Proxy({}, { ownKeys() { throw new Error('secret-ownKeys'); } }),
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('secret-descriptor'); } }),
    ]) expectSafeInvalid(() => providerApi.createLearningPageAccumulator(
      normalizedOperation(), contract as never,
    ), 'secret');
  });

  it('sanitizes nested revoked proxies, accessors, and stateful reflection from normalizers', async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const values: Array<() => unknown> = [
      () => ({ id: 'revoked', nested: revoked.proxy }),
      () => {
        const value = { id: 'getter' } as Record<string, unknown>;
        Object.defineProperty(value, 'nested', {
          enumerable: true, get() { throw new Error('secret-nested-getter'); },
        });
        return value;
      },
      () => {
        let reflected = false;
        return new Proxy({ id: 'stateful' }, {
          ownKeys() {
            reflected = true;
            return ['id'];
          },
          getOwnPropertyDescriptor() {
            if (reflected) throw new Error('secret-stateful-reflection');
            return undefined;
          },
        });
      },
    ];
    for (const make of values) {
      await expectProviderReject(() => providerApi.readAndNormalizeLearningPage(
        new Response(JSON.stringify(pageBody([course('safe')]))), normalizedOperation(),
        () => pageBody([make()]), COURSE_PAGE, () => NOW,
      ), 'malformed_response', 'secret');
    }
  });
});

describe('opaque page accumulators', () => {
  it('rejects valid empty-page replay across kind, scope, activity, and role-separated policy', async () => {
    const courseScope = (externalCourseId: string) => normalizedOperation({
      scope: {
        provider: 'canvas', connectionId: 7, externalCourseId,
        externalActivityId: null, externalEnrollmentId: null,
      },
    });
    const activityScope = (externalActivityId: string) => normalizedOperation({
      scope: {
        provider: 'canvas', connectionId: 7, externalCourseId: 'course-42',
        externalActivityId, externalEnrollmentId: null,
      },
    });
    const sourceCourse = await normalizedPage(pageBody([]), COURSE_PAGE, normalizedOperation());
    const sourceActivity = await normalizedPage(pageBody([]), ACTIVITY_PAGE, courseScope('course-42'));
    const sourceEnrollment = await normalizedPage(
      pageBody([]), PROVIDER_ENROLLMENT_PAGE, courseScope('course-42'),
    );
    const sourceResource = await normalizedPage(pageBody([]), RESOURCE_PAGE, activityScope('activity-3'));
    const sourceSubmission = await normalizedPage(
      pageBody([]), PROVIDER_SUBMISSION_PAGE, activityScope('activity-3'),
    );
    const sourceEnrolledSubmission = await normalizedPage(
      pageBody([]), PROVIDER_SUBMISSION_PAGE, normalizedOperation({ scope: {
        ...activityScope('activity-3').scope, externalEnrollmentId: 'enrollment-a',
      } }),
    );
    const googleOperation = normalizedOperation({
      scope: {
        provider: 'google_classroom', connectionId: 8, externalCourseId: null,
        externalActivityId: null, externalEnrollmentId: null,
      },
    });
    const accepted: string[] = [];
    const replay = <T extends object>(
      label: string,
      operation: LearningOperationContext,
      contract: {
        page: RuntimePageContract;
        normalizeItem(value: unknown): T;
        uniquenessKeys(value: T): readonly string[];
      },
      page: RuntimePage<T>,
    ): void => {
      try {
        providerApi.createLearningPageAccumulator<T>(operation, contract).accept(page, NOW);
        accepted.push(label);
      } catch (error) {
        expect(error).toBeInstanceOf(LearningValidationError);
      }
    };

    replay('kind', courseScope('course-42'), PROVIDER_ENROLLMENT_SEQUENCE,
      sourceActivity as unknown as RuntimePage<LearningProviderEnrollment>);
    replay('provider_connection', googleOperation, {
      page: { kind: 'courses', urlPolicy: GOOGLE_URL_POLICY },
      normalizeItem: (value) => normalizeLearningCourse(value, GOOGLE_URL_POLICY),
      uniquenessKeys: learningCourseUniquenessKeys,
    }, sourceCourse as unknown as RuntimePage<LearningCourse>);
    replay('course', courseScope('course-99'), PROVIDER_ENROLLMENT_SEQUENCE, sourceEnrollment);
    replay('resource_activity', activityScope('activity-4'), RESOURCE_SEQUENCE, sourceResource);
    replay('submission_activity', activityScope('activity-4'), PROVIDER_SUBMISSION_SEQUENCE, sourceSubmission);
    replay('submission_enrollment', normalizedOperation({ scope: {
      ...activityScope('activity-3').scope, externalEnrollmentId: 'enrollment-b',
    } }), PROVIDER_SUBMISSION_SEQUENCE, sourceEnrolledSubmission);
    replay('role_policy', activityScope('activity-3'), {
      page: { kind: 'resources', urlPolicy: ROLE_SWAPPED_URL_POLICY },
      normalizeItem: (value) => normalizeLearningResource(value, ROLE_SWAPPED_URL_POLICY),
      uniquenessKeys: learningResourceUniquenessKeys,
    }, sourceResource);
    expect(accepted).toEqual([]);

    for (const copied of [
      Object.freeze({ ...sourceCourse }),
      JSON.parse(JSON.stringify(sourceCourse)) as RuntimePage<LearningCourse>,
    ]) expectInvalid(() => providerApi.createLearningPageAccumulator<LearningCourse>(
      normalizedOperation(), COURSE_SEQUENCE,
    ).accept(copied, NOW));
  });

  it('uses deterministic URL-policy fingerprints without conflating origin roles', async () => {
    const operation = normalizedOperation({ scope: {
      provider: 'google_classroom', connectionId: 8, externalCourseId: null,
      externalActivityId: null, externalEnrollmentId: null,
    } });
    const page = await normalizedPage(
      pageBody([]), { kind: 'courses', urlPolicy: GOOGLE_URL_POLICY }, operation,
    );
    const reorderedPolicy = {
      ...GOOGLE_URL_POLICY,
      providerFileOrigins: [...GOOGLE_URL_POLICY.providerFileOrigins].reverse(),
    } as const;
    const accumulator = providerApi.createLearningPageAccumulator<LearningCourse>(operation, {
      page: { kind: 'courses', urlPolicy: reorderedPolicy },
      normalizeItem: (value) => normalizeLearningCourse(value, reorderedPolicy),
      uniquenessKeys: learningCourseUniquenessKeys,
    });
    expect(accumulator.accept(page, NOW).view).toMatchObject({ pageCount: 1, complete: 1 });
  });

  it('closes over private history and exposes only a frozen derivable view', async () => {
    expect('acceptLearningPageSequence' in learningProviderModule).toBe(false);
    const operation = normalizedOperation({ maxPages: 2, maxItems: 2 });
    const initial = providerApi.createLearningPageAccumulator<LearningCourse>(operation, COURSE_SEQUENCE);
    expect(initial.view).toMatchObject({ pageCount: 0, itemCount: 0, complete: 0 });
    const first = initial.accept(
      await normalizedPage(pageBody([course('b')], 1, null, 'next'), COURSE_PAGE, operation), NOW,
    );
    const final = first.accept(
      await normalizedPage(pageBody([course('a')], 2, 'next', null), COURSE_PAGE, operation), NOW,
    );
    expect(final.view.items.map((item) => item.externalCourseId)).toEqual(['a', 'b']);
    expect(final.view.itemCount).toBe(final.view.items.length);
    expect(final.view.seenUniquenessKeys.length).toBe(2);
    expect(final.view.complete).toBe(1);
    expect(Object.isFrozen(final)).toBe(true);
    expect(Object.isFrozen(final.view)).toBe(true);
    expect(initial.view.itemCount).toBe(0);
  });

  it('has no fabricated-history restoration surface, including coherent and oversized views', () => {
    const operation = normalizedOperation();
    const fabricated = Object.freeze({
      scope: operation.scope,
      pageCount: 2,
      itemCount: 1,
      rawResponseBytes: 10,
      normalizedItemBytes: 10,
      uniquenessKeyBytes: 10,
      expectedPageToken: null,
      seenPageTokens: Object.freeze(['token']),
      seenUniquenessKeys: Object.freeze(['key']),
      items: Object.freeze([{ ...course('restored'), displayName: 'x'.repeat(LEARNING_LIMITS.maxItemBytes + 1) }]),
      complete: 1,
    });
    const accumulator = (providerApi.createLearningPageAccumulator as unknown as (
      operation: LearningOperationContext,
      contract: typeof COURSE_SEQUENCE,
      restored?: unknown,
    ) => RuntimeAccumulator<LearningCourse>)(operation, COURSE_SEQUENCE, fabricated);
    expect(accumulator.view).toMatchObject({ pageCount: 0, itemCount: 0, rawResponseBytes: 0 });
    expect(accumulator.view.items).toEqual([]);
  });

  it('normalizes only newly received items and never replays historical callbacks', async () => {
    let normalizeCalls = 0;
    const contract = {
      page: COURSE_PAGE,
      normalizeItem(value: unknown) {
        normalizeCalls += 1;
        return normalizeLearningCourse(value, URL_POLICY);
      },
      uniquenessKeys: learningCourseUniquenessKeys,
    };
    const operation = normalizedOperation({ maxPages: 3, maxItems: 3 });
    const initial = providerApi.createLearningPageAccumulator<LearningCourse>(operation, contract);
    const first = initial.accept(
      await normalizedPage(pageBody([course('a')], 1, null, 'next-2'), COURSE_PAGE, operation), NOW,
    );
    const second = first.accept(
      await normalizedPage(pageBody([course('b')], 2, 'next-2', 'next-3'), COURSE_PAGE, operation), NOW,
    );
    const final = second.accept(
      await normalizedPage(pageBody([course('c')], 3, 'next-3', null), COURSE_PAGE, operation), NOW,
    );
    expect(final.view.itemCount).toBe(3);
    expect(normalizeCalls).toBe(3);
  });

  it('enforces exact scope, unique keys, token progression, and branded inputs', async () => {
    const operation = normalizedOperation({ maxPages: 2, maxItems: 2 });
    const initial = providerApi.createLearningPageAccumulator<LearningCourse>(operation, COURSE_SEQUENCE);
    const first = initial.accept(
      await normalizedPage(pageBody([course('a')], 1, null, 'next'), COURSE_PAGE, operation), NOW,
    );
    expectInvalid(() => first.accept({} as RuntimePage<LearningCourse>, NOW));
    expectInvalid(() => first.accept({
      items: [], requestPageToken: 'next', nextPageToken: null, pageNumber: 2, responseBytes: 1,
    }, NOW));
    const repeated = await normalizedPage(
      pageBody([course('b')], 2, 'next', 'next'), COURSE_PAGE, operation,
    );
    expectInvalid(() => first.accept(repeated, NOW));
    await expectProviderReject(() => normalizedPage(
      pageBody([{ ...course('b'), connectionId: 8 }], 2, 'next', null),
      { kind: 'courses', urlPolicy: { ...URL_POLICY, connectionId: 8 } },
      operation,
    ), 'malformed_response');
    const duplicate = await normalizedPage(
      pageBody([course('a')], 2, 'next', null), COURSE_PAGE, operation,
    );
    expectInvalid(() => first.accept(duplicate, NOW));
  });

  it('tracks every provider-roster uniqueness key within and across pages', async () => {
    const operation = normalizedOperation({
      scope: {
        provider: 'google_classroom', connectionId: 8, externalCourseId: 'google-course-1',
        externalActivityId: null, externalEnrollmentId: null,
      },
      maxPages: 2,
      maxItems: 3,
    });
    const contract = Object.freeze({
      page: PROVIDER_ENROLLMENT_PAGE,
      normalizeItem: normalizeLearningProviderEnrollment,
      uniquenessKeys: learningProviderEnrollmentUniquenessKeys,
    });
    const firstPayload = await normalizedPage(
      pageBody([providerEnrollment('user-a')], 1, null, 'next'), PROVIDER_ENROLLMENT_PAGE, operation,
    );
    const first = providerApi.createLearningPageAccumulator<LearningProviderEnrollment>(operation, contract)
      .accept(firstPayload, NOW);
    const duplicate = await normalizedPage(
      pageBody([providerEnrollment('user-a')], 2, 'next', null), PROVIDER_ENROLLMENT_PAGE, operation,
    );
    expectInvalid(() => first.accept(duplicate, NOW));

  });

  it('sequences pre-resolution submissions with exact activity scope and stable deduplication', async () => {
    const operation = normalizedOperation({
      scope: {
        provider: 'canvas', connectionId: 7, externalCourseId: 'course-42',
        externalActivityId: 'activity-3', externalEnrollmentId: null,
      },
      maxPages: 2,
      maxItems: 2,
    });
    const initial = providerApi.createLearningPageAccumulator<LearningProviderSubmission>(
      operation, PROVIDER_SUBMISSION_SEQUENCE,
    );
    const first = initial.accept(await normalizedPage(
      pageBody([providerSubmission()], 1, null, 'next'), PROVIDER_SUBMISSION_PAGE, operation,
    ), NOW);
    expect(first.view.items[0]).not.toHaveProperty('personId');
    expect(first.view.seenUniquenessKeys).toHaveLength(2);
    const duplicate = await normalizedPage(
      pageBody([providerSubmission()], 2, 'next', null), PROVIDER_SUBMISSION_PAGE, operation,
    );
    expectInvalid(() => first.accept(duplicate, NOW));

    await expectProviderReject(() => normalizedPage(pageBody([providerSubmission({
      externalActivityId: 'other-activity',
    })], 2, 'next', null), PROVIDER_SUBMISSION_PAGE, operation), 'malformed_response');
  });

  it('rejects non-monotonic pages and repeated or cyclic pagination tokens', async () => {
    const operation = normalizedOperation({ maxPages: 3, maxItems: 3 });
    const initial = providerApi.createLearningPageAccumulator<LearningCourse>(operation, COURSE_SEQUENCE);
    const nonMonotonic = await normalizedPage(pageBody([course('a')], 2), COURSE_PAGE, operation);
    expectInvalid(() => initial.accept(nonMonotonic, NOW));
    const first = initial.accept(
      await normalizedPage(pageBody([course('a')], 1, null, 'token-a'), COURSE_PAGE, operation), NOW,
    );
    const wrong = await normalizedPage(pageBody([course('b')], 2, 'wrong-token', null), COURSE_PAGE, operation);
    expectInvalid(() => first.accept(wrong, NOW));
    const repeated = await normalizedPage(
      pageBody([course('b')], 2, 'token-a', 'token-a'), COURSE_PAGE, operation,
    );
    expectInvalid(() => first.accept(repeated, NOW));
    const second = first.accept(
      await normalizedPage(pageBody([course('b')], 2, 'token-a', 'token-b'), COURSE_PAGE, operation), NOW,
    );
    const cyclic = await normalizedPage(pageBody([course('c')], 3, 'token-b', 'token-a'), COURSE_PAGE, operation);
    expectInvalid(() => second.accept(cyclic, NOW));
  });

  it('bounds measured raw and normalized item bytes independently', async () => {
    const generous = normalizedOperation({ maxPages: 1, maxItems: 1 });
    const payload = await normalizedPage(pageBody([course('a')]), COURSE_PAGE, generous);
    const baseline = providerApi.createLearningPageAccumulator<LearningCourse>(generous, COURSE_SEQUENCE)
      .accept(payload, NOW).view;
    expect(baseline.rawResponseBytes).toBe(payload.responseBytes);

    const rawOverflow = normalizedOperation({
      maxPages: 1, maxItems: 1, maxRawBytes: payload.responseBytes - 1,
    });
    expectInvalid(() => providerApi.createLearningPageAccumulator<LearningCourse>(rawOverflow, COURSE_SEQUENCE)
      .accept(payload, NOW));
    const normalizedOverflow = normalizedOperation({
      maxPages: 1, maxItems: 1, maxNormalizedBytes: baseline.normalizedItemBytes - 1,
    });
    expectInvalid(() => providerApi.createLearningPageAccumulator<LearningCourse>(normalizedOverflow, COURSE_SEQUENCE)
      .accept(payload, NOW));
  });

  it('rejects incomplete pages that exactly exhaust every terminal capacity', async () => {
    const generous = normalizedOperation({ maxPages: 2, maxItems: 2 });
    const payload = await normalizedPage(pageBody([course('a')], 1, null, 'more'), COURSE_PAGE, generous);
    const completePayload = await normalizedPage(pageBody([course('a')]), COURSE_PAGE, generous);
    const baseline = providerApi.createLearningPageAccumulator<LearningCourse>(generous, COURSE_SEQUENCE)
      .accept(completePayload, NOW).view;
    const limits = [
      { maxPages: 1 },
      { maxItems: 1 },
      { maxRawBytes: payload.responseBytes },
      { maxNormalizedBytes: baseline.normalizedItemBytes },
      { maxUniqueKeyBytes: baseline.uniquenessKeyBytes },
    ];
    for (const limit of limits) {
      const operation = normalizedOperation({ maxPages: 2, maxItems: 2, ...limit });
      expectInvalid(() => providerApi.createLearningPageAccumulator<LearningCourse>(operation, COURSE_SEQUENCE)
        .accept(payload, NOW));
    }
  });

  it('bounds cumulative uniqueness-key bytes explicitly at exact and off-by-one capacities', async () => {
    const normalized = normalizeLearningCourse(course('a'), URL_POLICY);
    const keyBytes = new TextEncoder().encode(learningCourseUniquenessKeys(normalized)[0]).byteLength;
    const exactOperation = normalizedOperation({ maxPages: 1, maxItems: 1, maxUniqueKeyBytes: keyBytes });
    const exactPayload = await normalizedPage(pageBody([course('a')]), COURSE_PAGE, exactOperation);
    const exact = providerApi.createLearningPageAccumulator<LearningCourse>(exactOperation, COURSE_SEQUENCE)
      .accept(exactPayload, NOW);
    expect(exact.view.uniquenessKeyBytes).toBe(keyBytes);

    const overflowOperation = normalizedOperation({ maxUniqueKeyBytes: keyBytes - 1 });
    const overflowPayload = await normalizedPage(pageBody([course('a')]), COURSE_PAGE, overflowOperation);
    expectInvalid(() => providerApi.createLearningPageAccumulator<LearningCourse>(overflowOperation, COURSE_SEQUENCE)
      .accept(overflowPayload, NOW));

    const terminalOperation = normalizedOperation({ maxPages: 1, maxItems: 1, maxUniqueKeyBytes: keyBytes });
    const incomplete = await normalizedPage(
      pageBody([course('a')], 1, null, 'more'), COURSE_PAGE, terminalOperation,
    );
    expectInvalid(() => providerApi.createLearningPageAccumulator<LearningCourse>(terminalOperation, COURSE_SEQUENCE)
      .accept(incomplete, NOW));
  });

  it('accepts canonical YouTube resources and checks deadline/cancellation for every page', async () => {
    const operation = normalizedOperation({
      scope: {
        provider: 'canvas', connectionId: 7, externalCourseId: 'course-42',
        externalActivityId: 'activity-3', externalEnrollmentId: null,
      },
    });
    const payload = await normalizedPage(pageBody([{
      ...resource('youtube'), kind: 'youtube',
      launchUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      youtubeVideoId: 'dQw4w9WgXcQ',
    }]), RESOURCE_PAGE, operation);
    const accumulator = providerApi.createLearningPageAccumulator<LearningResource>(operation, {
      page: RESOURCE_PAGE,
      normalizeItem: (value) => normalizeLearningResource(value, URL_POLICY),
      uniquenessKeys: learningResourceUniquenessKeys,
    });
    expect(accumulator.accept(payload, NOW).view.itemCount).toBe(1);
    expectInvalid(() => accumulator.accept(payload, Date.parse('2026-08-17T12:00:00Z')));

    const controller = new AbortController();
    const cancelledOperation = normalizedOperation({ signal: controller.signal });
    const cancelled = providerApi.createLearningPageAccumulator(cancelledOperation, COURSE_SEQUENCE);
    controller.abort();
    expectInvalid(() => cancelled.accept(payload as unknown as RuntimePage<LearningCourse>, NOW));
  });
});

describe('operation and request scope validation', () => {
  const providerSubject = { provider: 'canvas', connectionId: 7 } as const;
  const courseSubject = { ...providerSubject, externalCourseId: 'course-42' } as const;
  const activitySubject = { ...courseSubject, externalActivityId: 'activity-3' } as const;
  const submissionSubject = { ...activitySubject, externalEnrollmentId: 'enrollment-9' } as const;
  const pageRequest = { pageSize: 50, pageNumber: 1, pageToken: null } as const;
  const operationFor = (
    externalCourseId: string | null,
    externalActivityId: string | null,
    externalEnrollmentId: string | null,
  ) => operationInput({ scope: { ...providerSubject, externalCourseId, externalActivityId, externalEnrollmentId } });

  it('caps operation time and independent uniqueness-key budget', () => {
    expect(LEARNING_MAX_OPERATION_DURATION_MS).toBe(3_600_000);
    const exact = normalizedOperation({
      deadlineAt: new Date(NOW + LEARNING_MAX_OPERATION_DURATION_MS).toISOString(),
      maxUniqueKeyBytes: LEARNING_LIMITS.maxSyncBytes,
    });
    expect(exact.maxUniqueKeyBytes).toBe(LEARNING_LIMITS.maxSyncBytes);
    for (const overrides of [
      { deadlineAt: new Date(NOW + LEARNING_MAX_OPERATION_DURATION_MS + 1).toISOString() },
      { maxUniqueKeyBytes: 0 },
      { maxUniqueKeyBytes: LEARNING_LIMITS.maxSyncBytes + 1 },
      { signal: {} },
    ]) expectInvalid(() => normalizedOperation(overrides));
  });

  it('enforces every operation budget at exact and off-by-one limits', () => {
    const exact = normalizedOperation({
      maxPages: LEARNING_LIMITS.maxPages,
      maxItems: LEARNING_LIMITS.maxSyncItems,
      maxRawBytes: LEARNING_LIMITS.maxSyncBytes,
      maxNormalizedBytes: LEARNING_LIMITS.maxSyncBytes,
      maxUniqueKeyBytes: LEARNING_LIMITS.maxSyncBytes,
    });
    expect(Object.isFrozen(exact)).toBe(true);
    for (const overrides of [
      { maxPages: 0 }, { maxPages: LEARNING_LIMITS.maxPages + 1 },
      { maxItems: 0 }, { maxItems: LEARNING_LIMITS.maxSyncItems + 1 },
      { maxRawBytes: 0 }, { maxRawBytes: LEARNING_LIMITS.maxSyncBytes + 1 },
      { maxNormalizedBytes: 0 }, { maxNormalizedBytes: LEARNING_LIMITS.maxSyncBytes + 1 },
      { maxUniqueKeyBytes: 0 }, { maxUniqueKeyBytes: LEARNING_LIMITS.maxSyncBytes + 1 },
      { startedAt: new Date(NOW + 1).toISOString() },
      { deadlineAt: new Date(NOW).toISOString() },
    ]) expectInvalid(() => normalizedOperation(overrides));
  });

  it('normalizes every exact request and rejects scope mismatch', () => {
    const requests = [
      normalizeLearningHealthRequest({ subject: providerSubject, operation: operationFor(null, null, null) }, NOW),
      normalizeLearningListCoursesRequest({ subject: providerSubject, page: pageRequest, operation: operationFor(null, null, null) }, NOW),
      normalizeLearningSyncCourseRequest({ subject: courseSubject, operation: operationFor('course-42', null, null) }, NOW),
      normalizeLearningSyncEnrollmentsRequest({ subject: courseSubject, page: pageRequest, operation: operationFor('course-42', null, null) }, NOW),
      normalizeLearningSyncActivitiesRequest({ subject: courseSubject, page: pageRequest, operation: operationFor('course-42', null, null) }, NOW),
      normalizeLearningSyncResourcesRequest({ subject: activitySubject, page: pageRequest, operation: operationFor('course-42', 'activity-3', null) }, NOW),
      normalizeLearningSyncSubmissionsRequest({ subject: submissionSubject, page: pageRequest, operation: operationFor('course-42', 'activity-3', 'enrollment-9') }, NOW),
      normalizeLearningBuildLaunchRequest({ subject: activitySubject, operation: operationFor('course-42', 'activity-3', null) }, NOW),
    ];
    expect(requests.every(Object.isFrozen)).toBe(true);
    expectInvalid(() => normalizeLearningSyncResourcesRequest({
      subject: activitySubject, page: pageRequest,
      operation: operationFor('course-42', 'other-activity', null),
    }, NOW));
  });

  it('rejects provider, connection, course, activity, and enrollment scope mismatch for every method', () => {
    const cases: Array<[(value: unknown, now: number) => unknown, unknown]> = [
      [normalizeLearningHealthRequest, {
        subject: providerSubject,
        operation: operationInput({ scope: {
          ...providerSubject, connectionId: 8,
          externalCourseId: null, externalActivityId: null, externalEnrollmentId: null,
        } }),
      }],
      [normalizeLearningListCoursesRequest, {
        subject: providerSubject, page: pageRequest,
        operation: operationInput({ scope: {
          provider: 'google_classroom', connectionId: 7,
          externalCourseId: null, externalActivityId: null, externalEnrollmentId: null,
        } }),
      }],
      [normalizeLearningSyncCourseRequest, {
        subject: courseSubject, operation: operationFor('other-course', null, null),
      }],
      [normalizeLearningSyncEnrollmentsRequest, {
        subject: courseSubject, page: pageRequest, operation: operationFor('other-course', null, null),
      }],
      [normalizeLearningSyncActivitiesRequest, {
        subject: courseSubject, page: pageRequest, operation: operationFor('other-course', null, null),
      }],
      [normalizeLearningSyncResourcesRequest, {
        subject: activitySubject, page: pageRequest, operation: operationFor('course-42', 'other-activity', null),
      }],
      [normalizeLearningSyncSubmissionsRequest, {
        subject: submissionSubject, page: pageRequest,
        operation: operationFor('course-42', 'activity-3', 'other-enrollment'),
      }],
      [normalizeLearningBuildLaunchRequest, {
        subject: activitySubject, operation: operationFor('course-42', 'other-activity', null),
      }],
    ];
    for (const [normalize, input] of cases) expectInvalid(() => normalize(input, NOW));
  });
});

describe('provider invocation boundary', () => {
  const subject = { provider: 'canvas', connectionId: 7 } as const;
  const healthRequest = () => ({ subject, operation: operationInput() });

  function mockProvider(overrides: Partial<LearningProvider> = {}): LearningProvider {
    return {
      provider: 'canvas',
      async healthCheck() {
        return { connectionId: 7, provider: 'canvas', healthy: 1, checkedAt: '2026-08-17T11:00:00.123456789Z', errorCode: null };
      },
      async listCourses() { throw new Error('unused'); },
      async syncCourse() { return normalizeLearningCourse(course('course-42'), URL_POLICY); },
      async syncEnrollments() { throw new Error('unused'); },
      async syncActivities() { throw new Error('unused'); },
      async syncResources() { throw new Error('unused'); },
      async syncSubmissions() { throw new Error('unused'); },
      async buildLaunchUrl() {
        return {
          provider: 'canvas', connectionId: 7, externalCourseId: 'course-42', externalActivityId: null,
          url: 'https://canvas.church.test/courses/42', origin: 'https://canvas.church.test',
        };
      },
      async normalizeNotification() { return null; },
      ...overrides,
    };
  }

  it('runtime-validates requests and freezes mutable provider results', async () => {
    const raw: {
      connectionId: number;
      provider: 'canvas';
      healthy: 0 | 1;
      checkedAt: string;
      errorCode: null;
    } = { connectionId: 7, provider: 'canvas', healthy: 1, checkedAt: '2026-08-17T11:00:00.123456789Z', errorCode: null };
    const result = await providerApi.invokeLearningProvider(
      mockProvider({ async healthCheck() { return raw; } }),
      { method: 'healthCheck', request: healthRequest(), now: () => NOW },
    ) as Record<string, unknown>;
    raw.healthy = 0;
    expect(result).toMatchObject({ provider: 'canvas', connectionId: 7, healthy: 1 });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('invokes adapter methods with their validated provider receiver', async () => {
    let receiverMatched = false;
    const provider = mockProvider({
      async healthCheck() {
        receiverMatched = this.provider === 'canvas';
        return {
          connectionId: 7, provider: 'canvas', healthy: 1,
          checkedAt: '2026-08-17T11:00:00Z', errorCode: null,
        };
      },
    });
    await providerApi.invokeLearningProvider(
      provider, { method: 'healthCheck', request: healthRequest(), now: () => NOW },
    );
    expect(receiverMatched).toBe(true);
  });

  it('sanitizes adapter rejection, invalid results, provider mismatch, and secret carriers', async () => {
    const secret = 'secret-sdk-token-and-url';
    await expectProviderReject(() => providerApi.invokeLearningProvider(mockProvider({
      async healthCheck() { throw new Error(secret); },
    }), { method: 'healthCheck', request: healthRequest(), now: () => NOW }), 'provider_unavailable', secret);
    await expectProviderReject(() => providerApi.invokeLearningProvider(mockProvider({
      async healthCheck() {
        return { connectionId: 7, provider: 'canvas', healthy: 1, checkedAt: 'bad', errorCode: null, rawBody: secret } as never;
      },
    }), { method: 'healthCheck', request: healthRequest(), now: () => NOW }), 'malformed_response', secret);
    await expectProviderReject(() => providerApi.invokeLearningProvider(
      { ...mockProvider(), provider: 'google_classroom' },
      { method: 'healthCheck', request: healthRequest(), now: () => NOW },
    ), 'invalid_request');
  });

  it('rejects invocation/provider accessors and unknown carriers without invoking or leaking them', async () => {
    const secret = 'secret-provider-method-getter';
    let touched = false;
    const hostileProvider = { ...mockProvider() } as Record<string, unknown>;
    Object.defineProperty(hostileProvider, 'healthCheck', {
      enumerable: true,
      get() { touched = true; throw new Error(secret); },
    });
    await expectProviderReject(() => providerApi.invokeLearningProvider(
      hostileProvider as unknown as LearningProvider,
      { method: 'healthCheck', request: healthRequest(), now: () => NOW },
    ), 'invalid_request', secret);
    expect(touched).toBe(false);

    await expectProviderReject(() => providerApi.invokeLearningProvider(mockProvider(), {
      method: 'healthCheck', request: healthRequest(), now: () => NOW, rawBody: secret,
    }), 'invalid_request', secret);
  });

  it('enforces already-cancelled, already-expired, during-call abort, and deadline', async () => {
    const cancelledController = new AbortController();
    cancelledController.abort();
    await expectProviderReject(() => providerApi.invokeLearningProvider(mockProvider(), {
      method: 'healthCheck',
      request: { ...healthRequest(), operation: operationInput({ signal: cancelledController.signal }) },
      now: () => NOW,
    }), 'cancelled');
    await expectProviderReject(() => providerApi.invokeLearningProvider(mockProvider(), {
      method: 'healthCheck', request: healthRequest(), now: () => Date.parse('2026-08-17T12:00:00Z'),
    }), 'timeout');

    const duringController = new AbortController();
    const never = mockProvider({ healthCheck: () => new Promise(() => undefined) });
    const during = providerApi.invokeLearningProvider(never, {
      method: 'healthCheck',
      request: { ...healthRequest(), operation: operationInput({ signal: duringController.signal }) },
      now: () => NOW,
    });
    duringController.abort();
    await expectProviderReject(() => during, 'cancelled');
    await expectProviderReject(() => providerApi.invokeLearningProvider(never, {
      method: 'healthCheck',
      request: { ...healthRequest(), operation: operationInput({ deadlineAt: new Date(NOW + 5).toISOString() }) },
      now: () => NOW,
    }), 'timeout');
  });

  it('requires strict branded provider-neutral pages and exact item normalizers', async () => {
    const request = {
      subject,
      page: { pageSize: 50, pageNumber: 1, pageToken: null },
      operation: operationInput(),
    };
    const operation = normalizedOperation();
    const providerPage = await normalizedPage(pageBody([course('course-42')]), COURSE_PAGE, operation);
    const page = await providerApi.invokeLearningProvider(mockProvider({
      async listCourses() { return providerPage as LearningProviderPage<LearningCourse>; },
    }), { method: 'listCourses', request, urlPolicy: URL_POLICY, now: () => NOW }) as RuntimePage<LearningCourse>;
    expect(page.items[0].externalCourseId).toBe('course-42');
    expect(page.responseBytes).toBe(providerPage.responseBytes);
    await expectProviderReject(() => providerApi.invokeLearningProvider(mockProvider({
      async listCourses() {
        return {
          items: [course('course-42')], requestPageToken: null,
          nextPageToken: null, pageNumber: 1, responseBytes: 1,
        } as unknown as LearningProviderPage<LearningCourse>;
      },
    }), { method: 'listCourses', request, urlPolicy: URL_POLICY, now: () => NOW }), 'malformed_response');
  });

  it('rejects valid empty-page replay at invocation across every proof dimension', async () => {
    const pageRequest = { pageSize: 50, pageNumber: 1, pageToken: null } as const;
    const courseScope = (externalCourseId: string) => ({
      provider: 'canvas' as const, connectionId: 7, externalCourseId,
      externalActivityId: null, externalEnrollmentId: null,
    });
    const activityScope = (externalActivityId: string) => ({
      provider: 'canvas' as const, connectionId: 7, externalCourseId: 'course-42',
      externalActivityId, externalEnrollmentId: null,
    });
    const sourceCourse = await normalizedPage(pageBody([]), COURSE_PAGE, normalizedOperation());
    const sourceActivity = await normalizedPage(
      pageBody([]), ACTIVITY_PAGE, normalizedOperation({ scope: courseScope('course-42') }),
    );
    const sourceEnrollment = await normalizedPage(
      pageBody([]), PROVIDER_ENROLLMENT_PAGE, normalizedOperation({ scope: courseScope('course-42') }),
    );
    const sourceResource = await normalizedPage(
      pageBody([]), RESOURCE_PAGE, normalizedOperation({ scope: activityScope('activity-3') }),
    );
    const sourceSubmission = await normalizedPage(
      pageBody([]), PROVIDER_SUBMISSION_PAGE, normalizedOperation({ scope: activityScope('activity-3') }),
    );
    const sourceEnrolledSubmission = await normalizedPage(
      pageBody([]), PROVIDER_SUBMISSION_PAGE, normalizedOperation({ scope: {
        ...activityScope('activity-3'), externalEnrollmentId: 'enrollment-a',
      } }),
    );
    const accepted: string[] = [];
    const replay = async (
      label: string,
      provider: LearningProvider,
      invocation: Record<string, unknown>,
    ): Promise<void> => {
      try {
        await providerApi.invokeLearningProvider(provider, invocation);
        accepted.push(label);
      } catch (error) {
        expect(error).toBeInstanceOf(LearningProviderError);
        expect(error).toMatchObject({ code: 'malformed_response' });
      }
    };

    await replay('kind', mockProvider({
      async syncEnrollments() {
        return sourceActivity as unknown as LearningProviderPage<LearningProviderEnrollment>;
      },
    }), {
      method: 'syncEnrollments',
      request: {
        subject: { provider: 'canvas', connectionId: 7, externalCourseId: 'course-42' },
        page: pageRequest,
        operation: operationInput({ scope: courseScope('course-42') }),
      },
      now: () => NOW,
    });

    await replay('provider_connection', {
      ...mockProvider({
        async listCourses() { return sourceCourse as LearningProviderPage<LearningCourse>; },
      }),
      provider: 'google_classroom',
    }, {
      method: 'listCourses',
      request: {
        subject: { provider: 'google_classroom', connectionId: 8 },
        page: pageRequest,
        operation: operationInput({ scope: {
          provider: 'google_classroom', connectionId: 8, externalCourseId: null,
          externalActivityId: null, externalEnrollmentId: null,
        } }),
      },
      urlPolicy: GOOGLE_URL_POLICY,
      now: () => NOW,
    });

    await replay('course', mockProvider({
      async syncEnrollments() { return sourceEnrollment as LearningProviderPage<LearningProviderEnrollment>; },
    }), {
      method: 'syncEnrollments',
      request: {
        subject: { provider: 'canvas', connectionId: 7, externalCourseId: 'course-99' },
        page: pageRequest,
        operation: operationInput({ scope: courseScope('course-99') }),
      },
      now: () => NOW,
    });

    await replay('resource_activity', mockProvider({
      async syncResources() { return sourceResource as LearningProviderPage<LearningResource>; },
    }), {
      method: 'syncResources',
      request: {
        subject: {
          provider: 'canvas', connectionId: 7, externalCourseId: 'course-42', externalActivityId: 'activity-4',
        },
        page: pageRequest,
        operation: operationInput({ scope: activityScope('activity-4') }),
      },
      urlPolicy: URL_POLICY,
      now: () => NOW,
    });

    await replay('submission_activity', mockProvider({
      async syncSubmissions() {
        return sourceSubmission as LearningProviderPage<LearningProviderSubmission>;
      },
    }), {
      method: 'syncSubmissions',
      request: {
        subject: { ...activityScope('activity-4'), externalEnrollmentId: null },
        page: pageRequest,
        operation: operationInput({ scope: activityScope('activity-4') }),
      },
      now: () => NOW,
    });

    await replay('submission_enrollment', mockProvider({
      async syncSubmissions() {
        return sourceEnrolledSubmission as LearningProviderPage<LearningProviderSubmission>;
      },
    }), {
      method: 'syncSubmissions',
      request: {
        subject: { ...activityScope('activity-3'), externalEnrollmentId: 'enrollment-b' },
        page: pageRequest,
        operation: operationInput({ scope: {
          ...activityScope('activity-3'), externalEnrollmentId: 'enrollment-b',
        } }),
      },
      now: () => NOW,
    });

    await replay('role_policy', mockProvider({
      async syncResources() { return sourceResource as LearningProviderPage<LearningResource>; },
    }), {
      method: 'syncResources',
      request: {
        subject: {
          provider: 'canvas', connectionId: 7, externalCourseId: 'course-42', externalActivityId: 'activity-3',
        },
        page: pageRequest,
        operation: operationInput({ scope: activityScope('activity-3') }),
      },
      urlPolicy: ROLE_SWAPPED_URL_POLICY,
      now: () => NOW,
    });
    expect(accepted).toEqual([]);
  });

  it('revalidates pre-resolution submission pages without local People fields', async () => {
    const operation = normalizedOperation({
      scope: {
        provider: 'canvas', connectionId: 7, externalCourseId: 'course-42',
        externalActivityId: 'activity-3', externalEnrollmentId: null,
      },
    });
    const request = {
      subject: {
        provider: 'canvas', connectionId: 7, externalCourseId: 'course-42',
        externalActivityId: 'activity-3', externalEnrollmentId: null,
      },
      page: { pageSize: 50, pageNumber: 1, pageToken: null },
      operation,
    };
    const providerPage = await normalizedPage(
      pageBody([providerSubmission()]), PROVIDER_SUBMISSION_PAGE, operation,
    );
    const result = await providerApi.invokeLearningProvider(mockProvider({
      async syncSubmissions() {
        return providerPage as LearningProviderPage<LearningProviderSubmission>;
      },
    }), { method: 'syncSubmissions', request, now: () => NOW }) as RuntimePage<LearningProviderSubmission>;
    expect(result.items[0]).not.toHaveProperty('personId');
    expect(result.items[0]).not.toHaveProperty('enrollmentId');

    await expectProviderReject(() => normalizedPage(
      pageBody([{ ...providerSubmission(), grade: 'secret-grade' }]),
      PROVIDER_SUBMISSION_PAGE,
      operation,
      undefined,
      (value) => ({ ...(value as Record<string, unknown>) }),
    ), 'malformed_response', 'secret-grade');
  });
});

describe('bounded sync results and safe errors', () => {
  const validResult = {
    connectionId: 7,
    provider: 'canvas',
    externalCourseId: 'course-42',
    trigger: 'manual',
    status: 'succeeded',
    startedAt: '2026-08-16T15:30:00.123456788Z',
    finishedAt: '2026-08-16T15:30:00.123456789Z',
    attemptCount: 1,
    pageCount: 2,
    scannedCount: 20,
    changedCount: 4,
    removedCount: 1,
    eventCount: 3,
    responseBytes: 4096,
    errorCode: null,
  };

  it('preserves precise ordering and bounded status/count coherence', () => {
    expect(normalizeLearningSyncResult(validResult)).toEqual(validResult);
    for (const overrides of [
      { attemptCount: 0 },
      { attemptCount: LEARNING_LIMITS.maxSyncAttempts + 1 },
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

  it('orders canonical timestamps by nanoseconds even when fraction lengths differ', () => {
    expect(normalizeLearningSyncResult({
      ...validResult,
      startedAt: '2026-08-16T15:30:00.123Z',
      finishedAt: '2026-08-16T15:30:00.1234Z',
    })).toMatchObject({
      startedAt: '2026-08-16T15:30:00.123Z',
      finishedAt: '2026-08-16T15:30:00.1234Z',
    });
    expectInvalid(() => normalizeLearningSyncResult({
      ...validResult,
      startedAt: '2026-08-16T15:30:00.1234Z',
      finishedAt: '2026-08-16T15:30:00.123Z',
    }));
  });

  it('keeps provider errors allowlisted and free of raw carriers', () => {
    expect(LEARNING_ERROR_CODES).toContain('response_too_large');
    expect(normalizeLearningProviderError({
      code: 'rate_limited', provider: 'canvas', httpStatus: 429, retryAfterSeconds: 60,
    })).toEqual({ code: 'rate_limited', provider: 'canvas', httpStatus: 429, retryAfterSeconds: 60 });
    expectInvalid(() => normalizeLearningProviderError({
      code: 'provider_unavailable', provider: 'canvas', httpStatus: 503,
      retryAfterSeconds: null, body: 'secret',
    }));
    for (const input of [
      { code: 'unknown', provider: 'canvas', httpStatus: 500, retryAfterSeconds: null },
      { code: 'provider_unavailable', provider: 'moodle', httpStatus: 503, retryAfterSeconds: null },
      { code: 'provider_unavailable', provider: 'canvas', httpStatus: 399, retryAfterSeconds: null },
      { code: 'provider_unavailable', provider: 'canvas', httpStatus: 600, retryAfterSeconds: null },
      {
        code: 'rate_limited', provider: 'canvas', httpStatus: 429,
        retryAfterSeconds: LEARNING_LIMITS.maxRetryAfterSeconds + 1,
      },
      {
        code: 'provider_unavailable', provider: 'canvas', httpStatus: 503,
        retryAfterSeconds: null, url: 'https://example.test/?token=secret',
      },
    ]) expectInvalid(() => normalizeLearningProviderError(input));

    const providerError = new LearningProviderError({
      code: 'rate_limited', provider: 'canvas', httpStatus: 429, retryAfterSeconds: 60,
    });
    expect(providerError.message).toBe('Learning provider request failed: rate_limited');
    expect(JSON.stringify(providerError)).not.toContain('token');
  });
});

describe('provider-neutral interface implementability', () => {
  const googleProvider: LearningProvider = {
    provider: 'google_classroom',
    async healthCheck() {
      return { connectionId: 8, provider: 'google_classroom', healthy: 1, checkedAt: '2026-08-17T11:00:00Z', errorCode: null };
    },
    async listCourses() { throw new Error('not implemented'); },
    async syncCourse() { throw new Error('not implemented'); },
    async syncEnrollments() { throw new Error('not implemented'); },
    async syncActivities() { throw new Error('not implemented'); },
    async syncResources() { throw new Error('not implemented'); },
    async syncSubmissions() { throw new Error('not implemented'); },
    async buildLaunchUrl() { throw new Error('not implemented'); },
    async normalizeNotification() { return null; },
  };
  const canvasProvider: LearningProvider = {
    ...googleProvider,
    provider: 'canvas',
    async healthCheck() {
      return { connectionId: 7, provider: 'canvas', healthy: 1, checkedAt: '2026-08-17T11:00:00Z', errorCode: null };
    },
  };

  it('supports representative Google and Canvas adapter implementations', () => {
    expect(googleProvider.provider).toBe('google_classroom');
    expect(canvasProvider.provider).toBe('canvas');
    expectTypeOf<Awaited<ReturnType<LearningProvider['listCourses']>>>()
      .toEqualTypeOf<LearningProviderPage<LearningCourse>>();
    expectTypeOf<ReturnType<LearningProvider['syncEnrollments']>>()
      .toEqualTypeOf<Promise<LearningProviderPage<LearningProviderEnrollment>>>();
    expectTypeOf<ReturnType<LearningProvider['syncActivities']>>()
      .toEqualTypeOf<Promise<LearningProviderPage<LearningActivity>>>();
    expectTypeOf<ReturnType<LearningProvider['syncResources']>>()
      .toEqualTypeOf<Promise<LearningProviderPage<LearningResource>>>();
    expectTypeOf<ReturnType<LearningProvider['syncSubmissions']>>()
      .toEqualTypeOf<Promise<LearningProviderPage<LearningProviderSubmission>>>();
    type PaginatedResult = Awaited<ReturnType<LearningProvider['syncSubmissions']>>;
    expectTypeOf<'payload' extends keyof PaginatedResult ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'value' extends keyof PaginatedResult ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'measurement' extends keyof PaginatedResult ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<LearningProviderEnrollment>().toMatchTypeOf<{
      provider: 'google_classroom' | 'canvas';
      connectionId: number;
      externalCourseId: string;
      externalUserId: string;
      externalEnrollmentId: string;
      role: 'student' | 'teacher' | 'observer';
      state: 'active' | 'invited' | 'completed' | 'inactive';
    }>();
    expectTypeOf<LearningPageAccumulator<LearningCourse>['accept']>().toBeFunction();
    expectTypeOf<Parameters<LearningProvider['healthCheck']>[0]>().toEqualTypeOf<LearningHealthRequest>();
    expectTypeOf<Parameters<LearningProvider['listCourses']>[0]>().toEqualTypeOf<LearningListCoursesRequest>();
    expectTypeOf<Parameters<LearningProvider['syncCourse']>[0]>().toEqualTypeOf<LearningSyncCourseRequest>();
    expectTypeOf<Parameters<LearningProvider['syncEnrollments']>[0]>().toEqualTypeOf<LearningSyncEnrollmentsRequest>();
    expectTypeOf<Parameters<LearningProvider['syncActivities']>[0]>().toEqualTypeOf<LearningSyncActivitiesRequest>();
    expectTypeOf<Parameters<LearningProvider['syncResources']>[0]>().toEqualTypeOf<LearningSyncResourcesRequest>();
    expectTypeOf<Parameters<LearningProvider['syncSubmissions']>[0]>().toEqualTypeOf<LearningSyncSubmissionsRequest>();
    expectTypeOf<Parameters<LearningProvider['buildLaunchUrl']>[0]>().toEqualTypeOf<LearningBuildLaunchRequest>();
    expectTypeOf<Awaited<ReturnType<LearningProvider['buildLaunchUrl']>>>().toEqualTypeOf<LearningLaunchContract>();

    const typedCourseBoundary = (
      response: Response,
      operation: LearningOperationContext,
    ) => readAndNormalizeLearningPage(response, operation, (value) => value, COURSE_PAGE, () => NOW);
    type ClosedCoursePage = Awaited<ReturnType<typeof typedCourseBoundary>>;
    expectTypeOf<ClosedCoursePage>().toEqualTypeOf<LearningProviderPage<LearningCourse>>();
    expectTypeOf<'payload' extends keyof ClosedCoursePage ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'value' extends keyof ClosedCoursePage ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'measurement' extends keyof ClosedCoursePage ? true : false>().toEqualTypeOf<false>();
  });

  it('executes representative submission adapters without any local identity data', async () => {
    const googleOperation = normalizedOperation({
      scope: {
        provider: 'google_classroom', connectionId: 8, externalCourseId: 'google-course-1',
        externalActivityId: 'coursework-9', externalEnrollmentId: null,
      },
    });
    const googlePage = await normalizedPage(pageBody([providerSubmission({
      provider: 'google_classroom', connectionId: 8, externalCourseId: 'google-course-1',
      externalActivityId: 'coursework-9', externalUserId: 'google-user-7',
      externalEnrollmentId: learningSyntheticEnrollmentId({
        provider: 'google_classroom', externalCourseId: 'google-course-1', externalUserId: 'google-user-7',
      }),
    })]), PROVIDER_SUBMISSION_PAGE, googleOperation);
    const runnableGoogle: LearningProvider = {
      ...googleProvider,
      async syncSubmissions() { return googlePage as LearningProviderPage<LearningProviderSubmission>; },
    };
    const returned = await runnableGoogle.syncSubmissions({} as LearningSyncSubmissionsRequest);
    expect(returned.items[0]).not.toHaveProperty('personId');
    expect(returned.items[0]).not.toHaveProperty('identityLinkId');
    expect(JSON.stringify(returned)).not.toContain('rawPayload');
  });
});
