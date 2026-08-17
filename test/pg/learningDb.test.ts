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
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const NOW = '2026-08-17T12:00:00.000Z';
const POLICY = Object.freeze({
  provider: 'canvas' as const, connectionId: 801, baseUrl: 'https://canvas.learning.test',
  providerLaunchOrigins: ['https://canvas.learning.test'], providerFileOrigins: ['https://files.learning.test'],
  externalLinkOrigins: ['https://links.learning.test'],
});
const course = () => ({
  connectionId: 801, provider: 'canvas' as const, externalCourseId: 'genesis-1', displayName: 'Genesis 1',
  launchUrl: 'https://canvas.learning.test/courses/genesis-1', lifecycleState: 'active' as const,
  providerUpdatedAt: NOW, lastSyncedAt: NOW,
});

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
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY,
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
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY,
    });
    await expect(completeLearningCourseSync(db, lease, {
      course: course(), urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment, personId: 8012 }], activities: [], resources: [], submissions: [],
    })).rejects.toBeInstanceOf(LearningIdentityConflictError);
    expect((await sql.unsafe(`SELECT status FROM learning_identity_links
      WHERE connection_id=801 AND external_user_id='disabled-user'`))[0]).toEqual({ status: 'disabled' });
    expect((await sql.unsafe(`SELECT COUNT(*)::int AS count FROM learning_enrollments`))[0]).toEqual({ count: 0 });
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
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY,
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
      trigger: 'scheduled', startedAt: later, urlPolicy: POLICY,
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
      trigger: 'scheduled', startedAt: exactReplayAt, urlPolicy: POLICY,
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
  });

  it('serializes concurrent leases with exactly one winner and one run', async () => {
    const mapped = await mappedCourse();
    const attempts = await Promise.allSettled([
      startLearningSync(db, {
        connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
        trigger: 'manual', startedAt: NOW, urlPolicy: POLICY,
      }),
      startLearningSync(db, {
        connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
        trigger: 'scheduled', startedAt: NOW, urlPolicy: POLICY,
      }),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((item) => item.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(LearningSyncConflictError) });
    expect((await sql.unsafe(`SELECT COUNT(*)::int AS count FROM learning_sync_runs`))[0]).toEqual({ count: 1 });
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
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY,
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
      trigger: 'scheduled', startedAt: later, urlPolicy: POLICY,
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
});
