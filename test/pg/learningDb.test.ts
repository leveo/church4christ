import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import {
  LearningIdentityConflictError,
  LearningPersistenceError,
  LearningSyncConflictError,
  completeLearningCourseSync,
  createLearningProgram,
  failLearningSync,
  getLearningSyncRun,
  linkLearningIdentity,
  listLearningEnrollmentsForPerson,
  mapLearningCourse,
  startLearningSync,
} from '../../src/lib/learningDb';
import { learningSyntheticEnrollmentId } from '../../src/lib/learningModel';
import type { LearningCourse } from '../../src/lib/learningModel';
import {
  readAndNormalizeLearningPage,
  type LearningProvider,
  type LearningProviderPage,
} from '../../src/lib/learningProvider';
import { synchronizeLearningCourse } from '../../src/lib/learningSync';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const NOW = '2026-08-17T12:00:00.000Z';
const LATER = '2026-08-17T12:05:00.000Z';
const AFTER = '2026-08-17T12:10:00.000Z';
const FINAL = '2026-08-17T12:15:00.000Z';
const LEASE_END = '2026-08-17T12:30:00.000Z';
const POLICY = Object.freeze({
  provider: 'canvas' as const, connectionId: 801, baseUrl: 'https://canvas.learning.test',
  providerLaunchOrigins: ['https://canvas.learning.test'], providerFileOrigins: ['https://files.learning.test'],
  externalLinkOrigins: ['https://links.learning.test'],
});
const POLICY_WITH_DIFFERENT_ROLE_ORIGINS = Object.freeze({
  ...POLICY,
  providerFileOrigins: ['https://alternate-files.learning.test'],
  externalLinkOrigins: ['https://alternate-links.learning.test'],
});
const course = () => ({
  connectionId: 801, provider: 'canvas' as const, externalCourseId: 'genesis-1', displayName: 'Genesis 1',
  launchUrl: 'https://canvas.learning.test/courses/genesis-1', lifecycleState: 'active' as const,
  providerUpdatedAt: NOW, lastSyncedAt: NOW,
});

async function providerPage<T extends object>(
  items: readonly T[],
  request: { page: { pageNumber: number; pageToken: string | null }; operation: any },
  contract: any,
  nextPageToken: string | null = null,
): Promise<LearningProviderPage<T>> {
  return readAndNormalizeLearningPage(
    new Response(JSON.stringify({
      items, requestPageToken: request.page.pageToken,
      nextPageToken, pageNumber: request.page.pageNumber,
    })),
    request.operation,
    (value) => ({ ...(value as Record<string, unknown>) }),
    contract,
    () => Date.parse(NOW),
  ) as Promise<LearningProviderPage<T>>;
}

function orchestrationProvider(continueForever = false): LearningProvider {
  return {
    provider: 'canvas',
    async healthCheck() {
      return { connectionId: 801, provider: 'canvas', healthy: 1, checkedAt: NOW, errorCode: null };
    },
    async listCourses(request) {
      return providerPage<LearningCourse>([course()], request, { kind: 'courses', urlPolicy: POLICY });
    },
    async syncCourse() { return course(); },
    async syncEnrollments(request) {
      return providerPage([], request, { kind: 'provider_enrollments' }, continueForever ? 'next-secret' : null);
    },
    async syncActivities(request) {
      return providerPage([], request, { kind: 'activities', urlPolicy: POLICY });
    },
    async syncResources(request) {
      return providerPage([], request, { kind: 'resources', urlPolicy: POLICY });
    },
    async syncSubmissions(request) {
      return providerPage([], request, { kind: 'provider_submissions' });
    },
    async buildLaunchUrl(request) {
      return {
        ...request.subject,
        externalActivityId: 'externalActivityId' in request.subject ? request.subject.externalActivityId : null,
        url: course().launchUrl, origin: 'https://canvas.learning.test',
      };
    },
    async normalizeNotification() { return null; },
  };
}

function pgOperation(signal = new AbortController().signal, maxPages = 10) {
  return {
    scope: {
      provider: 'canvas' as const, connectionId: 801, externalCourseId: 'genesis-1',
      externalActivityId: null, externalEnrollmentId: null,
    },
    startedAt: NOW, deadlineAt: LEASE_END, maxPages, maxItems: 50,
    maxRawBytes: 100_000, maxNormalizedBytes: 100_000, maxUniqueKeyBytes: 100_000,
    signal,
  };
}

describe.skipIf(!hasPg)('Learning persistence parity (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;
  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });
  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE learning_provider_connections, people RESTART IDENTITY CASCADE;
      INSERT INTO people (id,display_name,email,role) VALUES
      (8011,'Admin','admin-pg@example.test','admin'),
      (8012,'Learner','learner-pg@example.test','member'),
      (8013,'Other','other-pg@example.test','member');
      INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id,updated_by_person_id)
      VALUES (801,'canvas','Canvas','https://canvas.learning.test','active',0,8011,8011);`);
  });
  afterAll(async () => { await sql?.end(); });

  async function mappedCourse() {
    const program = await createLearningProgram(db, {
      slug: 'genesis-pg', displayName: 'Genesis PG', actorPersonId: 8011,
    });
    return mapLearningCourse(db, { programId: program.programId, course: course(), urlPolicy: POLICY });
  }

  it('matches D1 identity conflict and authoritative reconciliation semantics', async () => {
    const mapped = await mappedCourse();
    await linkLearningIdentity(db, {
      connectionId: 801, provider: 'canvas', externalUserId: 'user-1', personId: 8012,
    });
    await expect(linkLearningIdentity(db, {
      connectionId: 801, provider: 'canvas', externalUserId: 'user-1', personId: 8013,
    })).rejects.toBeInstanceOf(LearningIdentityConflictError);
    const providerEnrollment = {
      connectionId: 801, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalUserId: 'user-1',
      externalEnrollmentId: learningSyntheticEnrollmentId({ provider: 'canvas', externalCourseId: 'genesis-1', externalUserId: 'user-1' }),
      role: 'student' as const, state: 'active' as const,
    };
    const lease = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await completeLearningCourseSync(db, lease, {
      course: course(), urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment, personId: 8012 }], activities: [], resources: [], submissions: [],
    });
    expect((await sql.unsafe(`SELECT e.state,i.person_id FROM learning_enrollments e
      JOIN learning_identity_links i ON i.id=e.identity_link_id`))[0]).toEqual({ state: 'active', person_id: 8012 });
  });

  it('rejects URL-policy drift and exact disabled identities without mutating the PostgreSQL generation', async () => {
    const mapped = await mappedCourse();
    await expect(mapLearningCourse(db, {
      programId: mapped.programId,
      course: {
        ...course(), externalCourseId: 'wrong-base',
        launchUrl: 'https://other-canvas.learning.test/courses/wrong-base',
      },
      urlPolicy: {
        ...POLICY, baseUrl: 'https://other-canvas.learning.test',
        providerLaunchOrigins: ['https://other-canvas.learning.test'],
      },
    })).rejects.toBeInstanceOf(LearningPersistenceError);

    await linkLearningIdentity(db, {
      connectionId: 801, provider: 'canvas', externalUserId: 'disabled-user', personId: 8012,
    });
    await sql.unsafe(`UPDATE learning_identity_links SET status='disabled'
      WHERE connection_id=801 AND external_user_id='disabled-user'`);
    const providerEnrollment = {
      connectionId: 801, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalUserId: 'disabled-user',
      externalEnrollmentId: learningSyntheticEnrollmentId({ provider: 'canvas', externalCourseId: 'genesis-1', externalUserId: 'disabled-user' }),
      role: 'student' as const, state: 'active' as const,
    };
    const lease = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await expect(completeLearningCourseSync(db, lease, {
      course: course(), urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment, personId: 8012 }], activities: [], resources: [], submissions: [],
    })).rejects.toBeInstanceOf(LearningIdentityConflictError);
    expect((await sql.unsafe(`SELECT status FROM learning_identity_links
      WHERE connection_id=801 AND external_user_id='disabled-user'`))[0]).toEqual({ status: 'disabled' });
    expect((await sql.unsafe(`SELECT COUNT(*)::int AS count FROM learning_enrollments`))[0]).toEqual({ count: 0 });
  });

  it('atomically rejects PostgreSQL completion under policy role drift from the acquired lease', async () => {
    const mapped = await mappedCourse();
    const stableLease = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await completeLearningCourseSync(db, stableLease, {
      course: { ...course(), displayName: 'Stable policy generation', lastSyncedAt: NOW },
      urlPolicy: POLICY, syncedAt: NOW, enrollments: [],
      activities: [{
        connectionId: 801, provider: 'canvas', externalCourseId: 'genesis-1',
        externalActivityId: 'stable-policy-activity', title: 'Stable policy activity', kind: 'material',
        lifecycleState: 'published', launchUrl: 'https://canvas.learning.test/courses/genesis-1/stable',
        dueAt: null, publishedAt: NOW, providerUpdatedAt: NOW, lastSyncedAt: null,
      }], resources: [], submissions: [],
    });

    const driftedLease = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: LATER, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await expect(completeLearningCourseSync(db, driftedLease, {
      course: { ...course(), displayName: 'Must not commit', lastSyncedAt: AFTER },
      urlPolicy: POLICY_WITH_DIFFERENT_ROLE_ORIGINS, syncedAt: AFTER, enrollments: [],
      activities: [{
        connectionId: 801, provider: 'canvas', externalCourseId: 'genesis-1',
        externalActivityId: 'must-not-commit-policy-activity', title: 'Must not commit', kind: 'material',
        lifecycleState: 'published', launchUrl: 'https://canvas.learning.test/courses/genesis-1/new',
        dueAt: null, publishedAt: AFTER, providerUpdatedAt: AFTER, lastSyncedAt: null,
      }], resources: [], submissions: [],
    })).rejects.toBeInstanceOf(LearningSyncConflictError);

    expect((await sql.unsafe(`SELECT display_name,last_synced_at FROM learning_courses
      WHERE id=${mapped.courseId}`))[0]).toEqual({
      display_name: 'Stable policy generation', last_synced_at: NOW,
    });
    expect(await sql.unsafe(`SELECT external_activity_id,lifecycle_state FROM learning_activities
      ORDER BY external_activity_id`)).toEqual([
      { external_activity_id: 'stable-policy-activity', lifecycle_state: 'published' },
    ]);
    expect((await sql.unsafe(`SELECT status,finalization_marker FROM learning_sync_runs
      WHERE id=${driftedLease.runId}`))[0]).toEqual({ status: 'running', finalization_marker: null });
    await failLearningSync(db, driftedLease, { finishedAt: FINAL, errorCode: 'invalid_request' });
    expect(await getLearningSyncRun(db, driftedLease.runId)).toMatchObject({
      status: 'failed', errorCode: 'invalid_request',
    });
  });

  it('matches D1 stable returned-event, actual-count, and active-only learner semantics', async () => {
    const mapped = await mappedCourse();
    const externalEnrollmentId = learningSyntheticEnrollmentId({
      provider: 'canvas', externalCourseId: 'genesis-1', externalUserId: 'user-1',
    });
    const providerEnrollment = {
      connectionId: 801, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalUserId: 'user-1',
      externalEnrollmentId, role: 'student' as const, state: 'active' as const,
    };
    const quiz = {
      connectionId: 801, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalActivityId: 'quiz-returned',
      title: 'Returned quiz', kind: 'quiz' as const, lifecycleState: 'published' as const,
      launchUrl: 'https://canvas.learning.test/courses/genesis-1/quizzes/quiz-returned', dueAt: null,
      publishedAt: NOW, providerUpdatedAt: NOW, lastSyncedAt: null,
    };
    const returned = {
      connectionId: 801, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalActivityId: 'quiz-returned',
      externalUserId: 'user-1', externalEnrollmentId, status: 'returned' as const, late: 0 as const,
      attemptNumber: 1, submittedAt: NOW, returnedAt: '2026-08-17T12:05:00.000Z',
      providerUpdatedAt: '2026-08-17T12:05:00.000Z',
    };
    const firstLease = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    const first = await completeLearningCourseSync(db, firstLease, {
      course: course(), urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment, personId: 8012 }], activities: [quiz], resources: [],
      submissions: [{ providerSubmission: returned, personId: 8012 }],
    });
    expect(first).toMatchObject({ scannedCount: 3, changedCount: 3, removedCount: 0, eventCount: 3 });

    const later = '2026-08-17T12:10:00.000Z';
    const replayLease = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: later, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await completeLearningCourseSync(db, replayLease, {
      course: { ...course(), lastSyncedAt: later }, urlPolicy: POLICY, syncedAt: later,
      enrollments: [{ providerEnrollment, personId: 8012 }], activities: [quiz], resources: [],
      submissions: [{ providerSubmission: { ...returned, providerUpdatedAt: later }, personId: 8012 }],
    });
    expect(await getLearningSyncRun(db, replayLease.runId)).toMatchObject({
      scannedCount: 3, changedCount: 1, removedCount: 0, eventCount: 0,
    });
    expect((await sql.unsafe(`SELECT event_type FROM learning_activity_events ORDER BY occurred_at,event_type`))
      .map((row) => row.event_type)).toEqual(['enrolled', 'quiz_submitted', 'submission_returned']);
    const exactReplayAt = '2026-08-17T12:15:00.000Z';
    const exactReplayLease = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: exactReplayAt, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await completeLearningCourseSync(db, exactReplayLease, {
      course: { ...course(), lastSyncedAt: exactReplayAt }, urlPolicy: POLICY, syncedAt: exactReplayAt,
      enrollments: [{ providerEnrollment, personId: 8012 }], activities: [quiz], resources: [],
      submissions: [{ providerSubmission: { ...returned, providerUpdatedAt: later }, personId: 8012 }],
    });
    expect(await getLearningSyncRun(db, exactReplayLease.runId)).toMatchObject({
      scannedCount: 3, changedCount: 0, removedCount: 0, eventCount: 0,
    });
    expect(await listLearningEnrollmentsForPerson(db, { courseId: mapped.courseId, personId: 8012 }))
      .toHaveLength(1);
    await sql.unsafe(`UPDATE learning_enrollments SET state='invited' WHERE course_id=$1`, [mapped.courseId]);
    expect(await listLearningEnrollmentsForPerson(db, { courseId: mapped.courseId, personId: 8012 })).toEqual([]);
    await sql.unsafe(`UPDATE learning_enrollments SET state='active' WHERE course_id=$1`, [mapped.courseId]);
    const removalAt = '2026-08-17T12:20:00.000Z';
    const removalLease = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: removalAt, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    const removed = await completeLearningCourseSync(db, removalLease, {
      course: { ...course(), lastSyncedAt: removalAt }, urlPolicy: POLICY, syncedAt: removalAt,
      enrollments: [], activities: [], resources: [], submissions: [],
    });
    expect(removed).toMatchObject({ scannedCount: 0, changedCount: 0, removedCount: 3, eventCount: 0 });
    expect((await sql.unsafe(`SELECT state FROM learning_enrollments WHERE course_id=$1`, [mapped.courseId]))[0])
      .toEqual({ state: 'inactive' });
    expect((await sql.unsafe(`SELECT lifecycle_state FROM learning_activities WHERE course_id=$1`, [mapped.courseId]))[0])
      .toEqual({ lifecycle_state: 'deleted' });
    expect((await sql.unsafe(`SELECT COUNT(*)::int AS count FROM learning_submission_snapshots
      WHERE course_id=$1`, [mapped.courseId]))[0]).toEqual({ count: 0 });
    expect((await sql.unsafe(`SELECT COUNT(*)::int AS count FROM learning_activity_events
      WHERE course_id=$1`, [mapped.courseId]))[0]).toEqual({ count: 3 });
  });

  it('serializes concurrent leases with exactly one winner and one run', async () => {
    const mapped = await mappedCourse();
    const attempts = await Promise.allSettled([
      startLearningSync(db, {
        connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
        trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
      }),
      startLearningSync(db, {
        connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
        trigger: 'scheduled', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
      }),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((item) => item.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(LearningSyncConflictError) });
    expect((await sql.unsafe(`SELECT COUNT(*)::int AS count FROM learning_sync_runs`))[0]).toEqual({ count: 1 });
  });

  it('isolates the same Person and opaque user across PostgreSQL connections, providers, and courses', async () => {
    const canvasMapped = await mappedCourse();
    await sql.unsafe(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id,updated_by_person_id)
      VALUES (802,'google_classroom','Classroom',NULL,'active',0,8011,8011)`);
    const googleProgram = await createLearningProgram(db, {
      slug: 'genesis-google-pg', displayName: 'Genesis Google PG', actorPersonId: 8011,
    });
    const googlePolicy = {
      provider: 'google_classroom' as const, connectionId: 802, baseUrl: null,
      providerLaunchOrigins: ['https://classroom.google.com'],
      providerFileOrigins: ['https://drive.google.com'], externalLinkOrigins: [],
    };
    const googleCourse = {
      connectionId: 802, provider: 'google_classroom' as const, externalCourseId: 'genesis-1',
      displayName: 'Genesis Google', launchUrl: 'https://classroom.google.com/c/genesis-1',
      lifecycleState: 'active' as const, providerUpdatedAt: NOW, lastSyncedAt: NOW,
    };
    const googleMapped = await mapLearningCourse(db, {
      programId: googleProgram.programId, course: googleCourse, urlPolicy: googlePolicy,
    });
    const canvasEnrollmentId = learningSyntheticEnrollmentId({
      provider: 'canvas', externalCourseId: 'genesis-1', externalUserId: 'shared-opaque-user',
    });
    const googleEnrollmentId = learningSyntheticEnrollmentId({
      provider: 'google_classroom', externalCourseId: 'genesis-1', externalUserId: 'shared-opaque-user',
    });
    for (const sync of [
      {
        connectionId: 801, provider: 'canvas' as const, courseId: canvasMapped.courseId,
        policy: POLICY, courseValue: course(), externalEnrollmentId: canvasEnrollmentId,
      },
      {
        connectionId: 802, provider: 'google_classroom' as const, courseId: googleMapped.courseId,
        policy: googlePolicy, courseValue: googleCourse, externalEnrollmentId: googleEnrollmentId,
      },
    ]) {
      await linkLearningIdentity(db, {
        connectionId: sync.connectionId, provider: sync.provider,
        externalUserId: 'shared-opaque-user', personId: 8012,
      });
      const lease = await startLearningSync(db, {
        connectionId: sync.connectionId, provider: sync.provider, courseId: sync.courseId,
        externalCourseId: 'genesis-1', trigger: 'manual', startedAt: NOW,
        urlPolicy: sync.policy, leaseExpiresAt: LEASE_END,
      });
      await completeLearningCourseSync(db, lease, {
        course: sync.courseValue, urlPolicy: sync.policy, syncedAt: NOW,
        enrollments: [{
          providerEnrollment: {
            connectionId: sync.connectionId, provider: sync.provider, externalCourseId: 'genesis-1',
            externalUserId: 'shared-opaque-user', externalEnrollmentId: sync.externalEnrollmentId,
            role: 'student', state: 'active',
          },
          personId: 8012,
        }], activities: [], resources: [], submissions: [],
      });
    }
    expect(await listLearningEnrollmentsForPerson(db, { courseId: canvasMapped.courseId, personId: 8012 }))
      .toEqual([expect.objectContaining({ connectionId: 801, externalEnrollmentId: canvasEnrollmentId })]);
    expect(await listLearningEnrollmentsForPerson(db, { courseId: googleMapped.courseId, personId: 8012 }))
      .toEqual([expect.objectContaining({ connectionId: 802, externalEnrollmentId: googleEnrollmentId })]);
    expect((await sql.unsafe(`SELECT connection_id,provider,source_event_id FROM learning_activity_events
      ORDER BY connection_id`)).map((row) => row.connection_id)).toEqual([801, 802]);
  });

  it('rolls back an entity conflict and preserves the prior complete PostgreSQL generation', async () => {
    const mapped = await mappedCourse();
    const providerEnrollment = {
      connectionId: 801, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalUserId: 'user-1',
      externalEnrollmentId: learningSyntheticEnrollmentId({ provider: 'canvas', externalCourseId: 'genesis-1', externalUserId: 'user-1' }),
      role: 'student' as const, state: 'active' as const,
    };
    const first = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await completeLearningCourseSync(db, first, {
      course: course(), urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment, personId: 8012 }],
      activities: [{
        connectionId: 801, provider: 'canvas', externalCourseId: 'genesis-1', externalActivityId: 'stable',
        title: 'Stable assignment', kind: 'assignment', lifecycleState: 'published',
        launchUrl: 'https://canvas.learning.test/courses/genesis-1/assignments/stable', dueAt: null,
        publishedAt: NOW, providerUpdatedAt: NOW, lastSyncedAt: null,
      }], resources: [], submissions: [],
    });
    const later = '2026-08-17T12:05:00.000Z';
    const second = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: later, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await expect(completeLearningCourseSync(db, second, {
      course: { ...course(), displayName: 'Must roll back' }, urlPolicy: POLICY, syncedAt: later,
      enrollments: [{ providerEnrollment, personId: 8012 }],
      activities: [{
        connectionId: 801, provider: 'canvas', externalCourseId: 'genesis-1', externalActivityId: 'stable',
        title: 'Conflicting quiz', kind: 'quiz', lifecycleState: 'published',
        launchUrl: 'https://canvas.learning.test/courses/genesis-1/quizzes/stable', dueAt: null,
        publishedAt: later, providerUpdatedAt: later, lastSyncedAt: null,
      }], resources: [], submissions: [],
    })).rejects.toBeInstanceOf(LearningPersistenceError);
    await failLearningSync(db, second, { finishedAt: later, errorCode: 'malformed_response' });
    expect((await sql.unsafe(`SELECT c.display_name,a.title,a.kind FROM learning_courses c
      JOIN learning_activities a ON a.course_id=c.id WHERE c.id=$1`, [mapped.courseId]))[0])
      .toEqual({ display_name: 'Genesis 1', title: 'Stable assignment', kind: 'assignment' });
    expect((await sql.unsafe(`SELECT status,error_code FROM learning_sync_runs WHERE id=$1`, [second.runId]))[0])
      .toEqual({ status: 'failed', error_code: 'malformed_response' });
  });

  it('has one PostgreSQL finalization winner when complete and fail race', async () => {
    const mapped = await mappedCourse();
    const lease = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY,
      leaseExpiresAt: '2026-08-17T12:10:00.000Z',
    } as never);
    const completed = completeLearningCourseSync(db, lease, {
      course: course(), urlPolicy: POLICY, syncedAt: '2026-08-17T12:05:00.000Z',
      enrollments: [], activities: [{
        connectionId: 801, provider: 'canvas', externalCourseId: 'genesis-1', externalActivityId: 'winner',
        title: 'Winning generation', kind: 'material', lifecycleState: 'published',
        launchUrl: 'https://canvas.learning.test/courses/genesis-1/modules/winner', dueAt: null,
        publishedAt: NOW, providerUpdatedAt: NOW, lastSyncedAt: null,
      }], resources: [], submissions: [],
    });
    const failed = failLearningSync(db, lease, {
      finishedAt: '2026-08-17T12:05:00.000Z', errorCode: 'provider_unavailable',
    });
    const outcomes = await Promise.allSettled([completed, failed]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const run = (await sql.unsafe(`SELECT status,finalization_marker FROM learning_sync_runs WHERE id=$1`, [lease.runId]))[0];
    expect(run.finalization_marker).toMatch(/^[0-9a-f-]{36}$/);
    expect(['succeeded', 'failed']).toContain(run.status);
    expect((await sql.unsafe(`SELECT COUNT(*)::int AS count FROM learning_activities
      WHERE course_id=$1 AND external_activity_id='winner'`, [mapped.courseId]))[0])
      .toEqual({ count: run.status === 'succeeded' ? 1 : 0 });
  });

  it('rolls back on a PostgreSQL admin identity race between preflight and commit', async () => {
    const mapped = await mappedCourse();
    await linkLearningIdentity(db, {
      connectionId: 801, provider: 'canvas', externalUserId: 'raced-user', personId: 8012,
    });
    const lease = await startLearningSync(db, {
      connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY,
      leaseExpiresAt: '2026-08-17T12:10:00.000Z',
    } as never);
    let raced = false;
    const racingDb: AppDb = {
      prepare: (statement) => db.prepare(statement),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          await sql.unsafe(`UPDATE learning_identity_links SET status='disabled'
            WHERE connection_id=801 AND external_user_id='raced-user'`);
        }
        return db.batch(statements);
      },
    };
    const providerEnrollment = {
      connectionId: 801, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalUserId: 'raced-user',
      externalEnrollmentId: learningSyntheticEnrollmentId({ provider: 'canvas', externalCourseId: 'genesis-1', externalUserId: 'raced-user' }),
      role: 'student' as const, state: 'active' as const,
    };
    await expect(completeLearningCourseSync(racingDb, lease, {
      course: course(), urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment, personId: 8012 }], activities: [], resources: [], submissions: [],
    })).rejects.toBeInstanceOf(LearningIdentityConflictError);
    expect((await sql.unsafe(`SELECT COUNT(*)::int AS count FROM learning_enrollments`))[0]).toEqual({ count: 0 });
    expect((await sql.unsafe(`SELECT status FROM learning_sync_runs WHERE id=$1`, [lease.runId]))[0])
      .toEqual({ status: 'running' });
  });

  it('matches D1 pagination and cancellation failure lifecycle through PostgreSQL orchestration', async () => {
    const mapped = await mappedCourse();
    await expect(synchronizeLearningCourse(db, {
      provider: orchestrationProvider(true), urlPolicy: POLICY,
      connectionId: 801, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'manual', operation: pgOperation(undefined, 1),
      now: () => Date.parse(NOW), resolvePerson: async () => null,
    })).rejects.toMatchObject({ code: 'pagination_limit', provider: 'canvas' });
    expect((await sql.unsafe(`SELECT status,error_code FROM learning_sync_runs ORDER BY id DESC LIMIT 1`))[0])
      .toEqual({ status: 'failed', error_code: 'pagination_limit' });

    const controller = new AbortController();
    controller.abort();
    await expect(synchronizeLearningCourse(db, {
      provider: orchestrationProvider(), urlPolicy: POLICY,
      connectionId: 801, providerKind: 'canvas', courseId: mapped.courseId,
      externalCourseId: 'genesis-1', trigger: 'scheduled', operation: pgOperation(controller.signal),
      now: () => Date.parse(NOW), resolvePerson: async () => null,
    })).rejects.toMatchObject({ code: 'cancelled', provider: 'canvas' });
    expect((await sql.unsafe(`SELECT status,error_code FROM learning_sync_runs ORDER BY id DESC LIMIT 1`))[0])
      .toEqual({ status: 'cancelled', error_code: null });
    expect(JSON.stringify(await sql.unsafe(`SELECT * FROM learning_sync_runs`))).not.toContain('next-secret');
  });
});
