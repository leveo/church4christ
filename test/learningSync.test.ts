import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createLearningProgram,
  getLearningSyncRun,
  mapLearningCourse,
} from '../src/lib/learningDb';
import {
  LearningProviderError,
  learningSyntheticEnrollmentId,
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

function fakeProvider(options: { failActivityPage?: number } = {}): LearningProvider {
  return {
    provider: 'canvas',
    async healthCheck() { return { connectionId: 901, provider: 'canvas', healthy: 1, checkedAt: new Date(NOW_EPOCH).toISOString(), errorCode: null }; },
    async listCourses(request) { return page<LearningCourse>([COURSE], request, { kind: 'courses', urlPolicy: POLICY }); },
    async syncCourse() { return COURSE; },
    async syncEnrollments(request) {
      return page<LearningProviderEnrollment>([ENROLLMENT], request, { kind: 'provider_enrollments' });
    },
    async syncActivities(request) {
      if (options.failActivityPage === request.page.pageNumber) throw new Error('raw-token-and-grade-must-not-leak');
      return request.page.pageNumber === 1
        ? page<LearningActivity>([ACTIVITIES[0]], request, { kind: 'activities', urlPolicy: POLICY }, 'next-secret-token')
        : page<LearningActivity>([ACTIVITIES[1]], request, { kind: 'activities', urlPolicy: POLICY });
    },
    async syncResources(request) {
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
    maxPages, maxItems: 100, maxRawBytes: 100_000, maxNormalizedBytes: 100_000,
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
      .toEqual({ status: 'failed', error_code: 'cancelled' });
  });
});
