import { describe, expect, expectTypeOf, it } from 'vitest';
import * as learningProviderModule from '../src/lib/learningProvider';
import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  LearningProviderError,
  LearningValidationError,
  learningCourseSubjectKey,
  learningCourseUniquenessKeys,
  learningProviderEnrollmentUniquenessKeys,
  learningResourceUniquenessKeys,
  learningSyntheticEnrollmentId,
  normalizeLearningCourse,
  normalizeLearningProviderEnrollment,
  normalizeLearningResource,
  type LearningCourse,
  type LearningLaunchContract,
  type LearningProviderEnrollment,
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
  type LearningBuildLaunchRequest,
  type LearningHealthRequest,
  type LearningListCoursesRequest,
  type LearningMeasuredPayload,
  type LearningOperationContext,
  type LearningPageAccumulator,
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

const NOW = Date.parse('2026-08-17T11:00:00Z');

type RuntimeMeasuredPayload = { readonly payload: unknown; readonly byteCount: number };
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
  accept(payload: RuntimeMeasuredPayload, now: number): RuntimeAccumulator<T>;
};

const providerApi = learningProviderModule as unknown as {
  readLearningJsonResponse(
    response: Response,
    operation: LearningOperationContext,
    now: () => number,
  ): Promise<RuntimeMeasuredPayload>;
  normalizeLearningPage<T extends object>(
    payload: RuntimeMeasuredPayload,
    contract: { normalizeItem(value: unknown): T; subjectKey(value: T): string },
  ): RuntimePage<T>;
  createLearningPageAccumulator<T extends object>(
    operation: LearningOperationContext,
    contract: { normalizeItem(value: unknown): T; uniquenessKeys(value: T): readonly string[] },
  ): RuntimeAccumulator<T>;
  invokeLearningProvider(provider: LearningProvider, invocation: Record<string, unknown>): Promise<unknown>;
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

const COURSE_PAGE = Object.freeze({
  normalizeItem: (value: unknown) => normalizeLearningCourse(value, URL_POLICY),
  subjectKey: learningCourseSubjectKey,
});
const COURSE_SEQUENCE = Object.freeze({
  normalizeItem: (value: unknown) => normalizeLearningCourse(value, URL_POLICY),
  uniquenessKeys: learningCourseUniquenessKeys,
});

async function measured(
  body: unknown,
  operation = normalizedOperation(),
  headers?: HeadersInit,
): Promise<RuntimeMeasuredPayload> {
  return providerApi.readLearningJsonResponse(
    new Response(JSON.stringify(body), { headers }), operation, () => NOW,
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

  it('measures exact streamed UTF-8 bytes, validates Content-Length, and freezes the payload', async () => {
    const body = pageBody([course('a')]);
    const text = JSON.stringify(body);
    const byteCount = new TextEncoder().encode(text).byteLength;
    const payload = await providerApi.readLearningJsonResponse(
      new Response(text, { headers: { 'Content-Length': String(byteCount) } }),
      normalizedOperation({ maxRawBytes: byteCount }),
      () => NOW,
    );
    expect(payload.byteCount).toBe(byteCount);
    expect(payload.payload).toEqual(body);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.payload)).toBe(true);
  });

  it('rejects lying Content-Length and invalid JSON without leaking raw bodies', async () => {
    const body = '{"access_token":"secret-not-json"';
    await expectProviderReject(() => providerApi.readLearningJsonResponse(
      new Response(body, { headers: { 'Content-Length': String(body.length - 1) } }),
      normalizedOperation(), () => NOW,
    ), 'malformed_response', 'secret-not-json');
    await expectProviderReject(() => providerApi.readLearningJsonResponse(
      new Response(body), normalizedOperation(), () => NOW,
    ), 'malformed_response', 'secret-not-json');
  });

  it('rejects invalid UTF-8 before JSON parsing', async () => {
    const response = new Response(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]));
    await expectProviderReject(() => providerApi.readLearningJsonResponse(
      response, normalizedOperation(), () => NOW,
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
    await expectProviderReject(() => providerApi.readLearningJsonResponse(
      response, normalizedOperation({ maxRawBytes: 32 }), () => NOW,
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
    await expectProviderReject(() => providerApi.readLearningJsonResponse(
      response, normalizedOperation({ maxRawBytes: 32 }), () => NOW,
    ), 'response_too_large');
    expect(cancelled).toBe(true);
  });

  it('cancels supplied readers on abort and deadline before JSON parsing', async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    controller.abort();
    let abortCancelled = false;
    await expectProviderReject(() => providerApi.readLearningJsonResponse(
      chunkedResponse([encoder.encode('{"secret":"abort"}')], () => { abortCancelled = true; }),
      normalizedOperation({ signal: controller.signal }), () => NOW,
    ), 'cancelled', 'abort');
    expect(abortCancelled).toBe(true);

    let deadlineCancelled = false;
    await expectProviderReject(() => providerApi.readLearningJsonResponse(
      chunkedResponse([encoder.encode('{"secret":"deadline"}')], () => { deadlineCancelled = true; }),
      normalizedOperation(), () => Date.parse('2026-08-17T12:00:00Z'),
    ), 'timeout', 'deadline');
    expect(deadlineCancelled).toBe(true);
  });
});

describe('sanitized page and contract normalization', () => {
  it('normalizes measured pages deterministically and rejects conflicting duplicates', async () => {
    const payload = await measured(pageBody([course('z'), course('a'), course('z')], 1, null, 'next'));
    const page = providerApi.normalizeLearningPage(payload, COURSE_PAGE);
    expect(page.items.map((item) => item.externalCourseId)).toEqual(['a', 'z']);
    expect(page.responseBytes).toBe(payload.byteCount);
    expect(Object.isFrozen(page.items[0])).toBe(true);
    const conflicting = await measured(pageBody([course('same', 'First'), course('same', 'Second')]));
    expectInvalid(() => providerApi.normalizeLearningPage(conflicting, COURSE_PAGE));
  });

  it('enforces page item counts, page numbers, per-item bytes, and exact page fields', async () => {
    const largeResponseOperation = normalizedOperation({ maxRawBytes: LEARNING_LIMITS.maxSyncBytes });
    const tooMany = await measured(pageBody(
      Array.from({ length: LEARNING_LIMITS.maxPageItems + 1 }, (_, index) => course(String(index))),
    ), largeResponseOperation);
    expectInvalid(() => providerApi.normalizeLearningPage(tooMany, COURSE_PAGE));
    const badPageNumber = await measured(pageBody([], LEARNING_LIMITS.maxPages + 1));
    expectInvalid(() => providerApi.normalizeLearningPage(badPageNumber, COURSE_PAGE));
    const largeItem = await measured(
      pageBody([course('large', 'x'.repeat(LEARNING_LIMITS.maxItemBytes + 1))]),
      largeResponseOperation,
    );
    expectInvalid(() => providerApi.normalizeLearningPage(largeItem, COURSE_PAGE));
    const extraField = await measured({ ...pageBody([]), rawBody: 'secret' });
    expectSafeInvalid(() => providerApi.normalizeLearningPage(extraField, COURSE_PAGE), 'secret');
  });

  it('rejects forged measured payloads and opaque page-byte under-reporting', () => {
    for (const forged of [
      { payload: pageBody([course('a')]), byteCount: 1 },
      Object.freeze({ payload: pageBody([course('a')]), byteCount: 1 }),
      new Proxy({}, { ownKeys() { throw new Error('secret-measured-proxy'); } }),
    ]) expectSafeInvalid(() => providerApi.normalizeLearningPage(forged as RuntimeMeasuredPayload, COURSE_PAGE), 'secret');
  });

  it('retrieves contract callbacks through data descriptors without invoking hostile getters', () => {
    const secret = 'secret-contract-getter';
    let touched = false;
    const contract = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(contract, 'normalizeItem', {
      enumerable: true,
      get() { touched = true; throw new Error(secret); },
    });
    Object.defineProperty(contract, 'subjectKey', { enumerable: true, value: () => 'key' });
    expectSafeInvalid(() => (learningProviderModule as unknown as {
      normalizeLearningPage(value: unknown, contract: unknown): unknown;
    }).normalizeLearningPage({}, contract), secret);
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
    const payload = await measured(pageBody([{}]));
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
    for (const make of values) expectSafeInvalid(() => providerApi.normalizeLearningPage(payload, {
      normalizeItem: () => make() as object,
      subjectKey: (item: { id: string }) => item.id,
    }), 'secret');
  });
});

describe('opaque page accumulators', () => {
  it('closes over private history and exposes only a frozen derivable view', async () => {
    expect('acceptLearningPageSequence' in learningProviderModule).toBe(false);
    const operation = normalizedOperation({ maxPages: 2, maxItems: 2 });
    const initial = providerApi.createLearningPageAccumulator<LearningCourse>(operation, COURSE_SEQUENCE);
    expect(initial.view).toMatchObject({ pageCount: 0, itemCount: 0, complete: 0 });
    const first = initial.accept(await measured(pageBody([course('b')], 1, null, 'next'), operation), NOW);
    const final = first.accept(await measured(pageBody([course('a')], 2, 'next', null), operation), NOW);
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
      normalizeItem(value: unknown) {
        normalizeCalls += 1;
        return normalizeLearningCourse(value, URL_POLICY);
      },
      uniquenessKeys: learningCourseUniquenessKeys,
    };
    const operation = normalizedOperation({ maxPages: 3, maxItems: 3 });
    const initial = providerApi.createLearningPageAccumulator<LearningCourse>(operation, contract);
    const first = initial.accept(await measured(pageBody([course('a')], 1, null, 'next-2'), operation), NOW);
    const second = first.accept(await measured(pageBody([course('b')], 2, 'next-2', 'next-3'), operation), NOW);
    const final = second.accept(await measured(pageBody([course('c')], 3, 'next-3', null), operation), NOW);
    expect(final.view.itemCount).toBe(3);
    expect(normalizeCalls).toBe(3);
  });

  it('enforces exact scope, unique keys, token progression, and branded inputs', async () => {
    const operation = normalizedOperation({ maxPages: 2, maxItems: 2 });
    const initial = providerApi.createLearningPageAccumulator<LearningCourse>(operation, COURSE_SEQUENCE);
    const first = initial.accept(await measured(pageBody([course('a')], 1, null, 'next'), operation), NOW);
    expectInvalid(() => first.accept({} as RuntimeMeasuredPayload, NOW));
    expectInvalid(() => first.accept({ payload: pageBody([course('b')], 2, 'next', null), byteCount: 1 }, NOW));
    const repeated = await measured(pageBody([course('b')], 2, 'next', 'next'), operation);
    expectInvalid(() => first.accept(repeated, NOW));
    const outOfScope = await measured(pageBody([{ ...course('b'), connectionId: 8 }], 2, 'next', null), operation);
    expectInvalid(() => first.accept(outOfScope, NOW));
    const duplicate = await measured(pageBody([course('a')], 2, 'next', null), operation);
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
      normalizeItem: normalizeLearningProviderEnrollment,
      uniquenessKeys: learningProviderEnrollmentUniquenessKeys,
    });
    const firstPayload = await measured(
      pageBody([providerEnrollment('user-a')], 1, null, 'next'), operation,
    );
    const first = providerApi.createLearningPageAccumulator<LearningProviderEnrollment>(operation, contract)
      .accept(firstPayload, NOW);
    const duplicate = await measured(
      pageBody([providerEnrollment('user-a')], 2, 'next', null), operation,
    );
    expectInvalid(() => first.accept(duplicate, NOW));

    const sameSyntheticId = {
      ...providerEnrollment('user-b'),
      externalEnrollmentId: learningSyntheticEnrollmentId({
        provider: 'google_classroom', externalCourseId: 'google-course-1', externalUserId: 'user-a',
      }),
    };
    const conflicting = await measured(pageBody([sameSyntheticId], 2, 'next', null), operation);
    expectInvalid(() => first.accept(conflicting, NOW));
  });

  it('rejects non-monotonic pages and repeated or cyclic pagination tokens', async () => {
    const operation = normalizedOperation({ maxPages: 3, maxItems: 3 });
    const initial = providerApi.createLearningPageAccumulator<LearningCourse>(operation, COURSE_SEQUENCE);
    const nonMonotonic = await measured(pageBody([course('a')], 2), operation);
    expectInvalid(() => initial.accept(nonMonotonic, NOW));
    const first = initial.accept(await measured(pageBody([course('a')], 1, null, 'token-a'), operation), NOW);
    const wrong = await measured(pageBody([course('b')], 2, 'wrong-token', null), operation);
    expectInvalid(() => first.accept(wrong, NOW));
    const repeated = await measured(pageBody([course('b')], 2, 'token-a', 'token-a'), operation);
    expectInvalid(() => first.accept(repeated, NOW));
    const second = first.accept(
      await measured(pageBody([course('b')], 2, 'token-a', 'token-b'), operation), NOW,
    );
    const cyclic = await measured(pageBody([course('c')], 3, 'token-b', 'token-a'), operation);
    expectInvalid(() => second.accept(cyclic, NOW));
  });

  it('bounds measured raw and normalized item bytes independently', async () => {
    const generous = normalizedOperation({ maxPages: 1, maxItems: 1 });
    const payload = await measured(pageBody([course('a')]), generous);
    const baseline = providerApi.createLearningPageAccumulator<LearningCourse>(generous, COURSE_SEQUENCE)
      .accept(payload, NOW).view;
    expect(baseline.rawResponseBytes).toBe(payload.byteCount);

    const rawOverflow = normalizedOperation({
      maxPages: 1, maxItems: 1, maxRawBytes: payload.byteCount - 1,
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
    const payload = await measured(pageBody([course('a')], 1, null, 'more'), generous);
    const completePayload = await measured(pageBody([course('a')]), generous);
    const baseline = providerApi.createLearningPageAccumulator<LearningCourse>(generous, COURSE_SEQUENCE)
      .accept(completePayload, NOW).view;
    const limits = [
      { maxPages: 1 },
      { maxItems: 1 },
      { maxRawBytes: payload.byteCount },
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
    const exactPayload = await measured(pageBody([course('a')]), exactOperation);
    const exact = providerApi.createLearningPageAccumulator<LearningCourse>(exactOperation, COURSE_SEQUENCE)
      .accept(exactPayload, NOW);
    expect(exact.view.uniquenessKeyBytes).toBe(keyBytes);

    const overflowOperation = normalizedOperation({ maxUniqueKeyBytes: keyBytes - 1 });
    const overflowPayload = await measured(pageBody([course('a')]), overflowOperation);
    expectInvalid(() => providerApi.createLearningPageAccumulator<LearningCourse>(overflowOperation, COURSE_SEQUENCE)
      .accept(overflowPayload, NOW));

    const terminalOperation = normalizedOperation({ maxPages: 1, maxItems: 1, maxUniqueKeyBytes: keyBytes });
    const incomplete = await measured(pageBody([course('a')], 1, null, 'more'), terminalOperation);
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
    const payload = await measured(pageBody([{
      ...resource('youtube'), kind: 'youtube',
      launchUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      youtubeVideoId: 'dQw4w9WgXcQ',
    }]), operation);
    const accumulator = providerApi.createLearningPageAccumulator<LearningResource>(operation, {
      normalizeItem: (value) => normalizeLearningResource(value, URL_POLICY),
      uniquenessKeys: learningResourceUniquenessKeys,
    });
    expect(accumulator.accept(payload, NOW).view.itemCount).toBe(1);
    expectInvalid(() => accumulator.accept(payload, Date.parse('2026-08-17T12:00:00Z')));

    const controller = new AbortController();
    const cancelledOperation = normalizedOperation({ signal: controller.signal });
    const cancelled = providerApi.createLearningPageAccumulator(cancelledOperation, COURSE_SEQUENCE);
    controller.abort();
    expectInvalid(() => cancelled.accept(payload, NOW));
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

  it('requires branded measured page results and exact item normalizers', async () => {
    const request = {
      subject,
      page: { pageSize: 50, pageNumber: 1, pageToken: null },
      operation: operationInput(),
    };
    const operation = normalizedOperation();
    const payload = await measured(pageBody([course('course-42')]), operation);
    const page = await providerApi.invokeLearningProvider(mockProvider({
      async listCourses() { return payload as LearningMeasuredPayload; },
    }), { method: 'listCourses', request, urlPolicy: URL_POLICY, now: () => NOW }) as RuntimePage<LearningCourse>;
    expect(page.items[0].externalCourseId).toBe('course-42');
    expect(page.responseBytes).toBe(payload.byteCount);
    await expectProviderReject(() => providerApi.invokeLearningProvider(mockProvider({
      async listCourses() { return { payload: pageBody([course('course-42')]), byteCount: 1 } as LearningMeasuredPayload; },
    }), { method: 'listCourses', request, urlPolicy: URL_POLICY, now: () => NOW }), 'malformed_response');
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
    expectTypeOf<ReturnType<LearningProvider['syncEnrollments']>>()
      .toEqualTypeOf<Promise<LearningMeasuredPayload>>();
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
  });
});
