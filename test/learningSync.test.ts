import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb, AppStatement } from '../src/lib/appDb';
import {
  createLearningProgram,
  getLearningSyncRun,
  mapLearningCourse,
  recoverExpiredLearningSync,
  startLearningSync,
} from '../src/lib/learningDb';
import {
  LearningProviderError,
  learningActivitySubjectKey,
  learningProviderEnrollmentSubjectKey,
  learningSyntheticEnrollmentId,
  learningValidation,
  type LearningActivity,
  type LearningCourse,
  type LearningProviderEnrollment,
  type LearningProviderSubmission,
  type LearningResource,
} from '../src/lib/learningModel';
import {
  readAndNormalizeLearningPage,
  type LearningProvider,
  type LearningProviderPage,
} from '../src/lib/learningProvider';
import { LearningSynchronizationError, synchronizeLearningCourse } from '../src/lib/learningSync';

const NOW_EPOCH = Date.parse('2026-08-17T12:00:00.000Z');
const POLICY = Object.freeze({
  provider: 'canvas' as const, connectionId: 901, baseUrl: 'https://canvas.sync.test',
  providerLaunchOrigins: ['https://canvas.sync.test'],
  providerFileOrigins: ['https://files.sync.test'],
  externalLinkOrigins: ['https://links.sync.test'],
});
const COURSE = Object.freeze({
  connectionId: 901, provider: 'canvas' as const, externalCourseId: 'genesis-1', displayName: 'Genesis 1',
  launchUrl: 'https://canvas.sync.test/courses/genesis-1', lifecycleState: 'active' as const,
  providerUpdatedAt: '2026-08-17T11:59:00.000Z', lastSyncedAt: null,
});
const ENROLLMENT = Object.freeze({
  connectionId: 901, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalUserId: 'opaque-user-1',
  externalEnrollmentId: learningSyntheticEnrollmentId({
    provider: 'canvas', externalCourseId: 'genesis-1', externalUserId: 'opaque-user-1',
  }),
  role: 'student' as const, state: 'active' as const,
});
const ACTIVITIES = Object.freeze([
  {
    connectionId: 901, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalActivityId: 'lesson-video',
    title: 'Creation video', kind: 'material' as const, lifecycleState: 'published' as const,
    launchUrl: 'https://canvas.sync.test/courses/genesis-1/modules/lesson-video', dueAt: null,
    publishedAt: '2026-08-17T11:00:00.000Z', providerUpdatedAt: '2026-08-17T11:00:00.000Z', lastSyncedAt: null,
  },
  {
    connectionId: 901, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalActivityId: 'quiz-1',
    title: 'Genesis quiz', kind: 'quiz' as const, lifecycleState: 'published' as const,
    launchUrl: 'https://canvas.sync.test/courses/genesis-1/quizzes/quiz-1', dueAt: '2026-08-18T12:00:00.000Z',
    publishedAt: '2026-08-17T11:00:00.000Z', providerUpdatedAt: '2026-08-17T11:00:00.000Z', lastSyncedAt: null,
  },
]);

function materialActivity(index: number): LearningActivity {
  const externalActivityId = `planned-material-${index}`;
  return Object.freeze({
    connectionId: 901, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalActivityId,
    title: `Planned material ${index}`, kind: 'material' as const, lifecycleState: 'published' as const,
    launchUrl: `https://canvas.sync.test/courses/genesis-1/modules/${externalActivityId}`,
    dueAt: null, publishedAt: '2026-08-17T11:00:00.000Z',
    providerUpdatedAt: '2026-08-17T11:00:00.000Z', lastSyncedAt: null,
  });
}

function materialResource(activity: LearningActivity, index: number): LearningResource {
  const externalResourceId = `planned-resource-${index}`;
  return Object.freeze({
    connectionId: 901, provider: 'canvas' as const, externalCourseId: 'genesis-1',
    externalActivityId: activity.externalActivityId, externalResourceId,
    title: `Planned resource ${index}`, kind: 'link' as const,
    launchUrl: `https://links.sync.test/resources/${externalResourceId}`,
    youtubeVideoId: null, mimeType: null, sizeBytes: null,
    providerUpdatedAt: '2026-08-17T11:00:00.000Z',
  });
}

interface D1BudgetMetrics {
  queryCount: number;
  readonly overQueryAttempts: number[];
  readonly overBindAttempts: number[];
  readonly batchSizes: number[];
  singleQueryAttempts: number;
}

function freePlanBudgetDb(): { readonly db: AppDb; readonly metrics: D1BudgetMetrics } {
  const metrics: D1BudgetMetrics = {
    queryCount: 0, overQueryAttempts: [], overBindAttempts: [], batchSizes: [], singleQueryAttempts: 0,
  };
  interface TrackedStatement extends AppStatement {
    readonly inner: D1PreparedStatement;
  }
  const charge = (queries: number): void => {
    if (metrics.queryCount + queries > 50) {
      metrics.overQueryAttempts.push(queries);
      throw new Error('test_d1_query_budget_exceeded');
    }
    metrics.queryCount += queries;
  };
  const wrap = (inner: D1PreparedStatement): TrackedStatement => ({
    inner,
    bind(...values: unknown[]) {
      if (values.length > 100) {
        metrics.overBindAttempts.push(values.length);
        throw new Error('test_d1_bind_budget_exceeded');
      }
      return wrap(inner.bind(...values));
    },
    async first<T = unknown>(column?: string) {
      metrics.singleQueryAttempts += 1;
      charge(1);
      return column === undefined ? inner.first<T>() : inner.first<T>(column);
    },
    async all<T = unknown>() {
      metrics.singleQueryAttempts += 1;
      charge(1);
      return inner.all<T>();
    },
    async run<T = unknown>() {
      metrics.singleQueryAttempts += 1;
      charge(1);
      return inner.run<T>();
    },
  });
  const db: AppDb = {
    prepare(sql: string) { return wrap(env.DB.prepare(sql)); },
    async batch<T = unknown>(statements: AppStatement[]) {
      metrics.batchSizes.push(statements.length);
      charge(statements.length);
      return env.DB.batch<T>(statements.map((statement) => (statement as TrackedStatement).inner));
    },
  };
  return Object.freeze({ db, metrics });
}

async function page<T extends object>(
  items: readonly T[], request: { page: { pageNumber: number; pageToken: string | null }; operation: any },
  contract: any, nextPageToken: string | null = null,
): Promise<LearningProviderPage<T>> {
  const body = { items, requestPageToken: request.page.pageToken, nextPageToken, pageNumber: request.page.pageNumber };
  return readAndNormalizeLearningPage(
    new Response(JSON.stringify(body)), request.operation,
    (value) => ({ ...(value as Record<string, unknown>) }), contract, () => NOW_EPOCH,
  ) as Promise<LearningProviderPage<T>>;
}

function fakeProvider(options: {
  failActivityPage?: number;
  onSyncCourse?: () => void;
  onlyEnrollment?: boolean;
  crossKindCollision?: boolean;
  providerError?: LearningProviderError;
  activities?: readonly LearningActivity[];
  resourcesByActivity?: Readonly<Record<string, readonly LearningResource[]>>;
  emptyEnrollments?: boolean;
} = {}): LearningProvider {
  return {
    provider: 'canvas',
    async healthCheck() { return { connectionId: 901, provider: 'canvas', healthy: 1, checkedAt: new Date(NOW_EPOCH).toISOString(), errorCode: null }; },
    async listCourses(request) { return page<LearningCourse>([COURSE], request, { kind: 'courses', urlPolicy: POLICY }); },
    async syncCourse() {
      options.onSyncCourse?.();
      if (options.providerError) throw options.providerError;
      return COURSE;
    },
    async syncEnrollments(request) {
      return page<LearningProviderEnrollment>(options.emptyEnrollments ? [] : [ENROLLMENT], request, { kind: 'provider_enrollments' });
    },
    async syncActivities(request) {
      if (options.activities) return page<LearningActivity>(options.activities, request, { kind: 'activities', urlPolicy: POLICY });
      if (options.onlyEnrollment) return page<LearningActivity>([], request, { kind: 'activities', urlPolicy: POLICY });
      if (options.crossKindCollision) {
        return page<LearningActivity>([{
          ...ACTIVITIES[0], externalActivityId: ENROLLMENT.externalEnrollmentId,
          launchUrl: `https://canvas.sync.test/courses/genesis-1/modules/${ENROLLMENT.externalEnrollmentId}`,
        }], request, { kind: 'activities', urlPolicy: POLICY });
      }
      if (options.failActivityPage === request.page.pageNumber) throw new Error('raw-token-and-grade-must-not-leak');
      return request.page.pageNumber === 1
        ? page<LearningActivity>([ACTIVITIES[0]], request, { kind: 'activities', urlPolicy: POLICY }, 'next-secret-token')
        : page<LearningActivity>([ACTIVITIES[1]], request, { kind: 'activities', urlPolicy: POLICY });
    },
    async syncResources(request) {
      if (options.resourcesByActivity) {
        return page(
          options.resourcesByActivity[request.subject.externalActivityId] ?? [],
          request,
          { kind: 'resources', urlPolicy: POLICY },
        );
      }
      const resources: LearningResource[] = request.subject.externalActivityId === 'lesson-video' ? [{
        connectionId: 901, provider: 'canvas', externalCourseId: 'genesis-1', externalActivityId: 'lesson-video',
        externalResourceId: 'youtube-1', title: 'Creation video', kind: 'youtube',
        launchUrl: 'https://www.youtube-nocookie.com/embed/abcdefghijk', youtubeVideoId: 'abcdefghijk',
        mimeType: null, sizeBytes: null, providerUpdatedAt: '2026-08-17T11:00:00.000Z',
      }] : [];
      return page(resources, request, { kind: 'resources', urlPolicy: POLICY });
    },
    async syncSubmissions(request) {
      const submissions: LearningProviderSubmission[] = request.subject.externalActivityId === 'quiz-1' ? [{
        connectionId: 901, provider: 'canvas', externalCourseId: 'genesis-1', externalActivityId: 'quiz-1',
        externalUserId: 'opaque-user-1', externalEnrollmentId: ENROLLMENT.externalEnrollmentId,
        status: 'submitted', late: 0, attemptNumber: 1, submittedAt: '2026-08-17T11:58:00.000Z',
        returnedAt: null, providerUpdatedAt: '2026-08-17T11:58:01.000Z',
      }] : [];
      return page(submissions, request, { kind: 'provider_submissions' });
    },
    async buildLaunchUrl(request) {
      return {
        ...request.subject, externalActivityId: 'externalActivityId' in request.subject ? request.subject.externalActivityId : null,
        url: COURSE.launchUrl, origin: 'https://canvas.sync.test',
      };
    },
    async normalizeNotification() { return null; },
  };
}

function operation(maxPages = 20, signal = new AbortController().signal) {
  return {
    scope: {
      provider: 'canvas' as const, connectionId: 901, externalCourseId: 'genesis-1',
      externalActivityId: null, externalEnrollmentId: null,
    },
    startedAt: '2026-08-17T12:00:00.000Z', deadlineAt: '2026-08-17T12:30:00.000Z',
    maxPages, maxItems: 50, maxRawBytes: 100_000, maxNormalizedBytes: 100_000,
    maxUniqueKeyBytes: 20_000, signal,
  };
}

async function seed() {
  await env.DB.prepare(`INSERT INTO people (id,display_name,email,role) VALUES
    (9011,'Admin','sync-admin@example.test','admin'),
    (9012,'Learner','sync-learner@example.test','member')`).run();
  await env.DB.prepare(`INSERT INTO learning_provider_connections
    (id,provider,display_name,base_url,status,revision,created_by_person_id,updated_by_person_id)
    VALUES (901,'canvas','Sync Canvas','https://canvas.sync.test','active',0,9011,9011)`).run();
  const program = await createLearningProgram(env.DB, {
    slug: 'genesis-sync', displayName: 'Genesis Sync', actorPersonId: 9011,
  });
  return mapLearningCourse(env.DB, { programId: program.programId, course: COURSE, urlPolicy: POLICY });
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`UPDATE learning_provider_connections SET status='disabled',deleted_at=COALESCE(deleted_at,'2026-08-17T00:00:00.000Z')`),
    env.DB.prepare(`UPDATE learning_courses SET lifecycle_state='archived',deleted_at=COALESCE(deleted_at,'2026-08-17T00:00:00.000Z')`),
    env.DB.prepare('DELETE FROM learning_sync_runs'), env.DB.prepare('DELETE FROM learning_activity_events'),
    env.DB.prepare('DELETE FROM learning_submission_snapshots'), env.DB.prepare('DELETE FROM learning_resources'),
    env.DB.prepare('DELETE FROM learning_activities'), env.DB.prepare('DELETE FROM learning_enrollments'),
    env.DB.prepare('DELETE FROM learning_identity_links'), env.DB.prepare('DELETE FROM learning_courses'),
    env.DB.prepare('DELETE FROM learning_programs'), env.DB.prepare('DELETE FROM learning_provider_connections'),
    env.DB.prepare('DELETE FROM people'),
  ]);
});

describe('Learning provider orchestration', () => {
  const fiftyActivities = Object.freeze(Array.from({ length: 50 }, (_, index) => materialActivity(index + 1)));
  const oneActivity = Object.freeze([materialActivity(1)]);
  const fortyNineResources = Object.freeze(Array.from(
    { length: 49 }, (_, index) => materialResource(oneActivity[0], index + 1),
  ));
  const mixedActivities = Object.freeze(Array.from({ length: 6 }, (_, index) => materialActivity(index + 1)));
  const mixedResources = Object.freeze(Object.fromEntries(mixedActivities.map((activity, activityIndex) => [
    activity.externalActivityId,
    Object.freeze([
      materialResource(activity, activityIndex * 2 + 1),
      materialResource(activity, activityIndex * 2 + 2),
    ]),
  ])));
  const tenBoundaryActivities = Object.freeze(Array.from(
    { length: 10 }, (_, index) => materialActivity(index + 1),
  ));
  const elevenBoundaryActivities = Object.freeze([
    ...tenBoundaryActivities, materialActivity(11),
  ]);
  const boundaryResource = materialResource(tenBoundaryActivities[0], 1);

  it.each([
    {
      name: '50 activities', activities: fiftyActivities,
      resourcesByActivity: Object.freeze({}) as Readonly<Record<string, readonly LearningResource[]>>,
    },
    {
      name: 'one activity and 49 resources', activities: oneActivity,
      resourcesByActivity: Object.freeze({
        [oneActivity[0].externalActivityId]: fortyNineResources,
      }),
    },
    {
      name: 'a mixed activity/resource snapshot', activities: mixedActivities,
      resourcesByActivity: mixedResources,
    },
  ])('rejects $name before constructing or calling a D1-over-limit batch', async ({
    activities, resourcesByActivity,
  }) => {
    const mapped = await seed();
    await synchronizeLearningCourse(env.DB, {
      provider: fakeProvider(), urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas',
      courseId: mapped.courseId, externalCourseId: 'genesis-1', trigger: 'manual',
      operation: operation(100), now: () => NOW_EPOCH,
      resolvePerson: async () => ({ personId: 9012 }),
    });
    const { db, metrics } = freePlanBudgetDb();
    const failed = synchronizeLearningCourse(db, {
      provider: fakeProvider({ activities, resourcesByActivity, emptyEnrollments: true }),
      urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'scheduled', operation: operation(100),
      now: () => NOW_EPOCH, resolvePerson: async () => null,
    });
    await expect(failed).rejects.toMatchObject({ code: 'provider_unavailable', provider: 'canvas' });
    await expect(failed).rejects.not.toThrow(/planned-material|planned-resource|test_d1/i);
    expect(metrics.overQueryAttempts).toEqual([]);
    expect(metrics.overBindAttempts).toEqual([]);
    expect(metrics.queryCount).toBeLessThanOrEqual(50);
    expect(await env.DB.prepare(`SELECT external_activity_id FROM learning_activities
      ORDER BY external_activity_id`).all()).toMatchObject({
      results: [{ external_activity_id: 'lesson-video' }, { external_activity_id: 'quiz-1' }],
    });
    expect(await env.DB.prepare(`SELECT status,error_code FROM learning_sync_runs
      ORDER BY id DESC LIMIT 1`).first()).toEqual({ status: 'failed', error_code: 'provider_unavailable' });
    expect(await env.DB.prepare(`SELECT operation_marker,operation_expires_at
      FROM learning_provider_connections WHERE id=901`).first())
      .toEqual({ operation_marker: null, operation_expires_at: null });
  });

  it('commits a legal small snapshot within the same D1 Free execution budget', async () => {
    const mapped = await seed();
    const { db, metrics } = freePlanBudgetDb();
    await expect(synchronizeLearningCourse(db, {
      provider: fakeProvider(), urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas',
      courseId: mapped.courseId, externalCourseId: 'genesis-1', trigger: 'manual',
      operation: operation(100), now: () => NOW_EPOCH,
      resolvePerson: async () => ({ personId: 9012 }),
    })).resolves.toMatchObject({ status: 'succeeded', scannedCount: 5 });
    expect(metrics.overQueryAttempts).toEqual([]);
    expect(metrics.overBindAttempts).toEqual([]);
    expect(metrics.queryCount).toBeLessThanOrEqual(50);
  });

  it('counts expired recovery as four queries for the winner and five for a loser', async () => {
    const mapped = await seed();
    const expiresAt = new Date(NOW_EPOCH + 1_000).toISOString();
    const finishedAt = new Date(NOW_EPOCH + 1_001).toISOString();
    const start = () => startLearningSync(env.DB, {
      connectionId: 901, provider: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'manual',
      startedAt: new Date(NOW_EPOCH).toISOString(), urlPolicy: POLICY, leaseExpiresAt: expiresAt,
    });

    const winningLease = await start();
    const winning = freePlanBudgetDb();
    await recoverExpiredLearningSync(winning.db, winningLease, { finishedAt, errorCode: 'rate_limited' });
    expect(winning.metrics.batchSizes).toEqual([4]);
    expect(winning.metrics.singleQueryAttempts).toBe(0);
    expect(winning.metrics.queryCount).toBe(4);

    const losingLease = await start();
    await recoverExpiredLearningSync(env.DB, losingLease, { finishedAt, errorCode: 'rate_limited' });
    const losing = freePlanBudgetDb();
    await expect(recoverExpiredLearningSync(losing.db, losingLease, {
      finishedAt, errorCode: 'provider_unavailable',
    })).resolves.toBeUndefined();
    expect(losing.metrics.batchSizes).toEqual([4]);
    expect(losing.metrics.singleQueryAttempts).toBe(1);
    expect(losing.metrics.queryCount).toBe(5);
  });

  it('accepts a 50-query worst-case plan and rejects the adjacent 51-query plan', async () => {
    const mapped = await seed();
    const accepted = freePlanBudgetDb();
    await expect(synchronizeLearningCourse(accepted.db, {
      provider: fakeProvider({
        activities: tenBoundaryActivities, emptyEnrollments: true,
        resourcesByActivity: Object.freeze({
          [tenBoundaryActivities[0].externalActivityId]: Object.freeze([boundaryResource]),
        }),
      }),
      urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'scheduled',
      operation: operation(100), now: () => NOW_EPOCH, resolvePerson: async () => null,
    })).resolves.toMatchObject({ status: 'succeeded', scannedCount: 11 });
    expect(accepted.metrics.batchSizes).toEqual([3, 42]);
    expect(accepted.metrics.singleQueryAttempts).toBe(0);
    expect(accepted.metrics.overQueryAttempts).toEqual([]);
    expect(accepted.metrics.queryCount).toBe(45);

    const rejected = freePlanBudgetDb();
    await expect(synchronizeLearningCourse(rejected.db, {
      provider: fakeProvider({ activities: elevenBoundaryActivities, emptyEnrollments: true }),
      urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'scheduled',
      operation: operation(100), now: () => NOW_EPOCH, resolvePerson: async () => null,
    })).rejects.toMatchObject({ code: 'provider_unavailable', provider: 'canvas' });
    expect(rejected.metrics.batchSizes).toEqual([3, 4]);
    expect(rejected.metrics.singleQueryAttempts).toBe(0);
    expect(rejected.metrics.overQueryAttempts).toEqual([]);
    expect(rejected.metrics.queryCount).toBe(7);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count,
      SUM(CASE WHEN external_activity_id='planned-material-11' THEN 1 ELSE 0 END) AS rejected_count
      FROM learning_activities WHERE course_id=?1`).bind(mapped.courseId).first())
      .toEqual({ count: 10, rejected_count: 0 });
  });

  it('rejects an atomic entity budget above 50 before provider work or a sync run', async () => {
    const mapped = await seed();
    let providerCalls = 0;
    await expect(synchronizeLearningCourse(env.DB, {
      provider: fakeProvider({ onSyncCourse: () => { providerCalls += 1; } }),
      urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'manual',
      operation: { ...operation(), maxItems: 51 }, now: () => NOW_EPOCH,
      resolvePerson: async () => ({ personId: 9012 }),
    })).rejects.toMatchObject({ code: 'invalid_request', provider: 'canvas' });
    expect(providerCalls).toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_sync_runs`).first()).toEqual({ count: 0 });
  });

  it('extracts a legal Google provider hint before exact-shape rejection', async () => {
    await expect(synchronizeLearningCourse(env.DB, {
      provider: fakeProvider(),
      urlPolicy: {
        provider: 'google_classroom', connectionId: 902, baseUrl: null,
        providerLaunchOrigins: ['https://classroom.google.com'],
        providerFileOrigins: ['https://drive.google.com'], externalLinkOrigins: [],
      },
      connectionId: 902, providerKind: 'google_classroom', courseId: 999,
      externalCourseId: 'google-course', trigger: 'manual',
      operation: {
        ...operation(),
        scope: {
          provider: 'google_classroom', connectionId: 902, externalCourseId: 'google-course',
          externalActivityId: null, externalEnrollmentId: null,
        },
      },
      now: () => NOW_EPOCH, resolvePerson: async () => null,
      unexpectedField: 'reject-before-persistence',
    } as never)).rejects.toMatchObject({ code: 'invalid_request', provider: 'google_classroom' });
  });

  it('namespaces uniqueness keys by entity kind while charging namespace bytes to the global budget', async () => {
    const mapped = await seed();
    await expect(synchronizeLearningCourse(env.DB, {
      provider: fakeProvider({ crossKindCollision: true }), urlPolicy: POLICY,
      connectionId: 901, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'manual', operation: operation(), now: () => NOW_EPOCH,
      resolvePerson: async () => ({ personId: 9012 }),
    })).resolves.toMatchObject({ status: 'succeeded', scannedCount: 2 });

    const rawKeyBudget = learningValidation.utf8Bytes(learningProviderEnrollmentSubjectKey(ENROLLMENT));
    await expect(synchronizeLearningCourse(env.DB, {
      provider: fakeProvider({ onlyEnrollment: true }), urlPolicy: POLICY,
      connectionId: 901, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'scheduled',
      operation: { ...operation(), maxUniqueKeyBytes: rawKeyBudget }, now: () => NOW_EPOCH,
      resolvePerson: async () => ({ personId: 9012 }),
    })).rejects.toMatchObject({ code: 'pagination_limit', provider: 'canvas' });
    expect(learningActivitySubjectKey({ ...ACTIVITIES[0], externalActivityId: ENROLLMENT.externalEnrollmentId }))
      .toBe(learningProviderEnrollmentSubjectKey({ ...ENROLLMENT, externalEnrollmentId: ENROLLMENT.externalEnrollmentId }));
  });

  it('races every pending People resolution against caller cancellation and deadline', async () => {
    const mapped = await seed();
    const controller = new AbortController();
    const cancelled = synchronizeLearningCourse(env.DB, {
      provider: fakeProvider({ onlyEnrollment: true }), urlPolicy: POLICY,
      connectionId: 901, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'manual', operation: operation(20, controller.signal),
      now: () => NOW_EPOCH,
      resolvePerson: async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { personId: 9012 };
      },
    });
    const earlyCancellation = await Promise.race([
      cancelled.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('resolver_still_pending'), 20)),
    ]);
    expect(earlyCancellation).toMatchObject({ code: 'cancelled', provider: 'canvas' });
    await cancelled.catch(() => undefined);

    const deadlineOperation = {
      ...operation(), deadlineAt: '2026-08-17T12:00:00.010Z',
    };
    const timedOut = synchronizeLearningCourse(env.DB, {
      provider: fakeProvider({ onlyEnrollment: true }), urlPolicy: POLICY,
      connectionId: 901, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'scheduled', operation: deadlineOperation,
      now: () => NOW_EPOCH,
      resolvePerson: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { personId: 9012 };
      },
    });
    const earlyTimeout = await Promise.race([
      timedOut.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('resolver_still_pending'), 30)),
    ]);
    expect(earlyTimeout).toMatchObject({ code: 'timeout', provider: 'canvas' });
    await timedOut.catch(() => undefined);
  });

  it('preserves bounded provider retry metadata for Task 10 without retrying or sleeping here', async () => {
    const mapped = await seed();
    let calls = 0;
    const failure = new LearningProviderError({
      code: 'rate_limited', provider: 'canvas', httpStatus: 429, retryAfterSeconds: 17,
    });
    await expect(synchronizeLearningCourse(env.DB, {
      provider: fakeProvider({ providerError: failure, onSyncCourse: () => { calls += 1; } }),
      urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'manual', operation: operation(),
      now: () => NOW_EPOCH, resolvePerson: async () => ({ personId: 9012 }),
    })).rejects.toMatchObject({
      code: 'rate_limited', provider: 'canvas', httpStatus: 429, retryAfterSeconds: 17,
    });
    expect(calls).toBe(1);
  });

  it.each([
    { scenario: 'deadline', expectedCode: 'timeout', expectedStatus: 'failed', expectedDbCode: 'timeout' },
    { scenario: 'cancellation', expectedCode: 'cancelled', expectedStatus: 'cancelled', expectedDbCode: null },
    { scenario: 'provider metadata', expectedCode: 'rate_limited', expectedStatus: 'failed', expectedDbCode: 'rate_limited' },
  ] as const)('recovers an expired lease without replacing $scenario classification', async ({
    scenario, expectedCode, expectedStatus, expectedDbCode,
  }) => {
    const mapped = await seed();
    const controller = new AbortController();
    const deadline = NOW_EPOCH + 1_000;
    let clock = NOW_EPOCH;
    const providerError = scenario === 'provider metadata' ? new LearningProviderError({
      code: 'rate_limited', provider: 'canvas', httpStatus: 429, retryAfterSeconds: 23,
    }) : undefined;
    const sync = synchronizeLearningCourse(env.DB, {
      provider: fakeProvider({
        providerError,
        onSyncCourse: () => {
          clock = deadline + 1;
          if (scenario === 'cancellation') controller.abort();
        },
      }),
      urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'manual',
      operation: {
        ...operation(20, controller.signal), deadlineAt: new Date(deadline).toISOString(),
      },
      now: () => clock, resolvePerson: async () => ({ personId: 9012 }),
    });
    await expect(sync).rejects.toMatchObject({
      code: expectedCode, provider: 'canvas',
      httpStatus: scenario === 'provider metadata' ? 429 : null,
      retryAfterSeconds: scenario === 'provider metadata' ? 23 : null,
    });
    const run = await env.DB.prepare(`SELECT status,error_code FROM learning_sync_runs`).first();
    expect(run).toEqual({ status: expectedStatus, error_code: expectedDbCode });
    expect(await env.DB.prepare(`SELECT operation_marker,operation_expires_at FROM learning_provider_connections
      WHERE id=901`).first()).toEqual({ operation_marker: null, operation_expires_at: null });
  });

  it('rejects database connection URL-policy drift before any provider work or sync run', async () => {
    const mapped = await seed();
    let providerCalls = 0;
    await expect(synchronizeLearningCourse(env.DB, {
      provider: fakeProvider({ onSyncCourse: () => { providerCalls += 1; } }),
      urlPolicy: {
        ...POLICY,
        baseUrl: 'https://other-canvas.sync.test',
        providerLaunchOrigins: ['https://other-canvas.sync.test'],
      },
      connectionId: 901, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'manual', operation: operation(),
      now: () => NOW_EPOCH, resolvePerson: async () => ({ personId: 9012 }),
    })).rejects.toMatchObject({ code: 'invalid_request', provider: 'canvas' });
    expect(providerCalls).toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_sync_runs`).first()).toEqual({ count: 0 });
  });

  it('attributes request-clock failures to the requested provider without touching persistence', async () => {
    await expect(synchronizeLearningCourse(env.DB, {
      provider: fakeProvider(),
      urlPolicy: {
        provider: 'google_classroom', connectionId: 902, baseUrl: null,
        providerLaunchOrigins: ['https://classroom.google.com'],
        providerFileOrigins: ['https://drive.google.com'], externalLinkOrigins: [],
      },
      connectionId: 902, providerKind: 'google_classroom', courseId: 999,
      externalCourseId: 'google-course', trigger: 'manual',
      operation: {
        ...operation(),
        scope: {
          provider: 'google_classroom', connectionId: 902, externalCourseId: 'google-course',
          externalActivityId: null, externalEnrollmentId: null,
        },
      },
      now: () => Number.NaN,
      resolvePerson: async () => null,
    })).rejects.toMatchObject({ code: 'invalid_request', provider: 'google_classroom' });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_sync_runs`).first()).toEqual({ count: 0 });
  });

  it('paginates an injected provider, resolves People at the app seam, and commits one complete generation', async () => {
    const mapped = await seed();
    const resolutions: unknown[] = [];
    const result = await synchronizeLearningCourse(env.DB, {
      provider: fakeProvider(), urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas',
      courseId: mapped.courseId, externalCourseId: 'genesis-1', trigger: 'manual', operation: operation(),
      now: () => NOW_EPOCH,
      resolvePerson: async (subject) => { resolutions.push(subject); return { personId: 9012 }; },
    });
    expect(result).toMatchObject({ status: 'succeeded', scannedCount: 5 });
    expect(resolutions).toEqual([{
      connectionId: 901, provider: 'canvas', externalCourseId: 'genesis-1',
      externalUserId: 'opaque-user-1', externalEnrollmentId: ENROLLMENT.externalEnrollmentId,
    }]);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_activities`).first()).toEqual({ count: 2 });
    expect(await env.DB.prepare(`SELECT status FROM learning_submission_snapshots`).first()).toEqual({ status: 'submitted' });
    const databaseText = JSON.stringify((await env.DB.prepare(`SELECT * FROM learning_sync_runs`).all()).results);
    expect(databaseText).not.toMatch(/next-secret-token|raw-token|grade/i);
  });

  it('records a safe failed run and preserves the last generation when a later provider page fails', async () => {
    const mapped = await seed();
    const base = {
      urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas' as const,
      courseId: mapped.courseId, externalCourseId: 'genesis-1', operation: operation(), now: () => NOW_EPOCH,
      resolvePerson: async () => ({ personId: 9012 }),
    };
    await synchronizeLearningCourse(env.DB, { ...base, provider: fakeProvider(), trigger: 'manual' });
    const failed = synchronizeLearningCourse(env.DB, {
      ...base, provider: fakeProvider({ failActivityPage: 2 }), trigger: 'scheduled',
    });
    await expect(failed).rejects.toBeInstanceOf(LearningSynchronizationError);
    await expect(failed).rejects.not.toThrow(/raw-token|grade/i);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_activities`).first()).toEqual({ count: 2 });
    const run = await env.DB.prepare(`SELECT id FROM learning_sync_runs ORDER BY id DESC LIMIT 1`).first<{ id: number }>();
    expect(await getLearningSyncRun(env.DB, run!.id)).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable' });
  });

  it('fails closed on a global pagination budget and never persists the continuation token', async () => {
    const mapped = await seed();
    await expect(synchronizeLearningCourse(env.DB, {
      provider: fakeProvider(), urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas',
      courseId: mapped.courseId, externalCourseId: 'genesis-1', trigger: 'manual', operation: operation(2),
      now: () => NOW_EPOCH, resolvePerson: async () => ({ personId: 9012 }),
    })).rejects.toMatchObject({ code: 'pagination_limit' });
    expect(JSON.stringify((await env.DB.prepare(`SELECT * FROM learning_sync_runs`).all()).results))
      .not.toContain('next-secret-token');
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_activities`).first()).toEqual({ count: 0 });
  });

  it('honors caller cancellation before provider work and stores only the bounded cancelled code', async () => {
    const mapped = await seed();
    const controller = new AbortController();
    controller.abort();
    await expect(synchronizeLearningCourse(env.DB, {
      provider: fakeProvider(), urlPolicy: POLICY, connectionId: 901, providerKind: 'canvas',
      courseId: mapped.courseId, externalCourseId: 'genesis-1', trigger: 'manual',
      operation: operation(20, controller.signal), now: () => NOW_EPOCH,
      resolvePerson: async () => ({ personId: 9012 }),
    })).rejects.toMatchObject({ code: 'cancelled' });
    expect(await env.DB.prepare(`SELECT status,error_code FROM learning_sync_runs`).first())
      .toEqual({ status: 'cancelled', error_code: null });
  });
});
