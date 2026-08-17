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
  linkLearningIdentity,
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
      trigger: 'manual', startedAt: NOW,
    });
    await completeLearningCourseSync(db, lease, {
      course: course(), urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment, personId: 8012 }], activities: [], resources: [], submissions: [],
    });
    expect((await sql.unsafe(`SELECT e.state,i.person_id FROM learning_enrollments e
      JOIN learning_identity_links i ON i.id=e.identity_link_id`))[0]).toEqual({ state: 'active', person_id: 8012 });
  });

  it('serializes concurrent leases with exactly one winner and one run', async () => {
    const mapped = await mappedCourse();
    const attempts = await Promise.allSettled([
      startLearningSync(db, {
        connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
        trigger: 'manual', startedAt: NOW,
      }),
      startLearningSync(db, {
        connectionId: 801, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
        trigger: 'scheduled', startedAt: NOW,
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
      trigger: 'manual', startedAt: NOW,
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
      trigger: 'scheduled', startedAt: later,
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
