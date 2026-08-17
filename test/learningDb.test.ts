import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import * as learningDb from '../src/lib/learningDb';
import {
  LearningIdentityConflictError,
  LearningSyncConflictError,
  completeLearningCourseSync,
  createLearningProgram,
  failLearningSync,
  getLearningSyncRun,
  linkLearningIdentity,
  listLearningEnrollmentsForPerson,
  mapLearningCourse,
  recoverExpiredLearningSync,
  startLearningSync,
} from '../src/lib/learningDb';
import { learningSyntheticEnrollmentId } from '../src/lib/learningModel';

const NOW = '2026-08-17T12:00:00.000Z';
const LATER = '2026-08-17T12:05:00.000Z';
const AFTER = '2026-08-17T12:10:00.000Z';
const FINAL = '2026-08-17T12:15:00.000Z';
const LEASE_END = '2026-08-17T12:30:00.000Z';
const POLICY = Object.freeze({
  provider: 'canvas' as const,
  connectionId: 701,
  baseUrl: 'https://canvas.learning.test',
  providerLaunchOrigins: ['https://canvas.learning.test'],
  providerFileOrigins: ['https://files.learning.test'],
  externalLinkOrigins: ['https://links.learning.test'],
});
const POLICY_WITH_DIFFERENT_ROLE_ORIGINS = Object.freeze({
  ...POLICY,
  providerFileOrigins: ['https://alternate-files.learning.test'],
  externalLinkOrigins: ['https://alternate-links.learning.test'],
});

function course(externalCourseId = 'genesis-1', displayName = 'Genesis 1') {
  return {
    connectionId: 701, provider: 'canvas' as const, externalCourseId, displayName,
    launchUrl: `https://canvas.learning.test/courses/${externalCourseId}`,
    lifecycleState: 'active' as const, providerUpdatedAt: NOW, lastSyncedAt: null,
  };
}

function enrollment(externalUserId: string, role: 'student' | 'teacher' = 'student') {
  return {
    connectionId: 701, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalUserId,
    externalEnrollmentId: learningSyntheticEnrollmentId({ provider: 'canvas', externalCourseId: 'genesis-1', externalUserId }),
    role, state: 'active' as const,
  };
}

function activity(externalActivityId: string, kind: 'material' | 'assignment' | 'quiz') {
  return {
    connectionId: 701, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalActivityId,
    title: `${kind} ${externalActivityId}`, kind, lifecycleState: 'published' as const,
    launchUrl: `https://canvas.learning.test/courses/genesis-1/${kind}/${externalActivityId}`,
    dueAt: kind === 'material' ? null : LATER, publishedAt: NOW, providerUpdatedAt: NOW, lastSyncedAt: null,
  };
}

function submission(externalActivityId: string, externalUserId: string, status: 'submitted' | 'returned' = 'submitted') {
  return {
    connectionId: 701, provider: 'canvas' as const, externalCourseId: 'genesis-1', externalActivityId,
    externalUserId,
    externalEnrollmentId: learningSyntheticEnrollmentId({ provider: 'canvas', externalCourseId: 'genesis-1', externalUserId }),
    status, late: 0 as const, attemptNumber: 1, submittedAt: NOW,
    returnedAt: status === 'returned' ? LATER : null, providerUpdatedAt: status === 'returned' ? LATER : NOW,
  };
}

async function seed() {
  await env.DB.prepare(`INSERT INTO people (id,display_name,email,role) VALUES
    (7011,'Learning Admin','learning-admin@example.test','admin'),
    (7012,'Learner One','learner-one@example.test','member'),
    (7013,'Learner Two','learner-two@example.test','member')`).run();
  await env.DB.prepare(`INSERT INTO learning_provider_connections
    (id,provider,display_name,base_url,status,revision,created_by_person_id,updated_by_person_id)
    VALUES (701,'canvas','Learning Canvas','https://canvas.learning.test','active',0,7011,7011)`).run();
  const program = await createLearningProgram(env.DB, {
    slug: 'genesis-sunday-school', displayName: 'Genesis Sunday School', actorPersonId: 7011,
  });
  const mapped = await mapLearningCourse(env.DB, { programId: program.programId, course: course(), urlPolicy: POLICY });
  return { program, mapped };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`UPDATE learning_provider_connections SET status='disabled',
      deleted_at=COALESCE(deleted_at,'2026-08-17T00:00:00.000Z')`),
    env.DB.prepare(`UPDATE learning_courses SET lifecycle_state='archived',
      deleted_at=COALESCE(deleted_at,'2026-08-17T00:00:00.000Z')`),
    env.DB.prepare('DELETE FROM learning_sync_runs'),
    env.DB.prepare('DELETE FROM learning_activity_events'),
    env.DB.prepare('DELETE FROM learning_submission_snapshots'),
    env.DB.prepare('DELETE FROM learning_resources'),
    env.DB.prepare('DELETE FROM learning_activities'),
    env.DB.prepare('DELETE FROM learning_enrollments'),
    env.DB.prepare('DELETE FROM learning_identity_links'),
    env.DB.prepare('DELETE FROM learning_courses'),
    env.DB.prepare('DELETE FROM learning_programs'),
    env.DB.prepare('DELETE FROM learning_provider_connections'),
    env.DB.prepare('DELETE FROM people'),
  ]);
});

describe('Learning persistence and atomic reconciliation (D1)', () => {
  it('maps a provider course to one program with exact connection/provider scope', async () => {
    const { program, mapped } = await seed();
    expect(program).toMatchObject({ slug: 'genesis-sunday-school', status: 'active' });
    expect(mapped).toMatchObject({
      programId: program.programId, connectionId: 701, provider: 'canvas', externalCourseId: 'genesis-1',
    });
    await expect(mapLearningCourse(env.DB, {
      programId: program.programId,
      course: { ...course('foreign'), connectionId: 702 },
      urlPolicy: { ...POLICY, connectionId: 702 },
    })).rejects.toThrow('learning_persistence_failed');
    await expect(mapLearningCourse(env.DB, {
      programId: program.programId,
      course: {
        ...course('wrong-base'),
        launchUrl: 'https://other-canvas.learning.test/courses/wrong-base',
      },
      urlPolicy: {
        ...POLICY,
        baseUrl: 'https://other-canvas.learning.test',
        providerLaunchOrigins: ['https://other-canvas.learning.test'],
      },
    })).rejects.toThrow('learning_persistence_failed');
  });

  it('fails closed when an exact identity was disabled instead of silently reactivating it', async () => {
    const { mapped } = await seed();
    await linkLearningIdentity(env.DB, {
      connectionId: 701, provider: 'canvas', externalUserId: 'disabled-user', personId: 7012,
    });
    await env.DB.prepare(`UPDATE learning_identity_links SET status='disabled'
      WHERE connection_id=701 AND external_user_id='disabled-user'`).run();
    const lease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await expect(completeLearningCourseSync(env.DB, lease, {
      course: { ...course(), lastSyncedAt: NOW }, urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment: enrollment('disabled-user'), personId: 7012 }],
      activities: [activity('must-not-commit', 'quiz')], resources: [], submissions: [],
    })).rejects.toBeInstanceOf(LearningIdentityConflictError);
    expect(await env.DB.prepare(`SELECT status FROM learning_identity_links
      WHERE connection_id=701 AND external_user_id='disabled-user'`).first()).toEqual({ status: 'disabled' });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_activities`).first()).toEqual({ count: 0 });
  });

  it('atomically rejects completion under a different URL policy than the lease started with', async () => {
    const { mapped } = await seed();
    const stableLease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await completeLearningCourseSync(env.DB, stableLease, {
      course: { ...course('genesis-1', 'Stable policy generation'), lastSyncedAt: NOW },
      urlPolicy: POLICY, syncedAt: NOW, enrollments: [],
      activities: [activity('stable-policy-activity', 'material')], resources: [], submissions: [],
    });

    const driftedLease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: LATER, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await expect(completeLearningCourseSync(env.DB, driftedLease, {
      course: { ...course('genesis-1', 'Must not commit'), lastSyncedAt: AFTER },
      urlPolicy: POLICY_WITH_DIFFERENT_ROLE_ORIGINS, syncedAt: AFTER, enrollments: [],
      activities: [activity('must-not-commit-policy-activity', 'material')], resources: [], submissions: [],
    })).rejects.toBeInstanceOf(LearningSyncConflictError);

    expect(await env.DB.prepare(`SELECT display_name,last_synced_at FROM learning_courses
      WHERE id=?`).bind(mapped.courseId).first()).toEqual({
      display_name: 'Stable policy generation', last_synced_at: NOW,
    });
    expect(await env.DB.prepare(`SELECT external_activity_id,lifecycle_state FROM learning_activities
      ORDER BY external_activity_id`).all()).toMatchObject({ results: [
      { external_activity_id: 'stable-policy-activity', lifecycle_state: 'published' },
    ] });
    expect(await env.DB.prepare(`SELECT status,finalization_marker FROM learning_sync_runs
      WHERE id=?`).bind(driftedLease.runId).first()).toEqual({ status: 'running', finalization_marker: null });
    await failLearningSync(env.DB, driftedLease, { finishedAt: FINAL, errorCode: 'invalid_request' });
    expect(await getLearningSyncRun(env.DB, driftedLease.runId)).toMatchObject({
      status: 'failed', errorCode: 'invalid_request',
    });
  });

  it('links exact identities idempotently and rejects either alternate-unique conflict without remapping', async () => {
    await seed();
    const first = await linkLearningIdentity(env.DB, {
      connectionId: 701, provider: 'canvas', externalUserId: 'canvas-user-1', personId: 7012,
    });
    expect(await linkLearningIdentity(env.DB, {
      connectionId: 701, provider: 'canvas', externalUserId: 'canvas-user-1', personId: 7012,
    })).toEqual(first);
    await expect(linkLearningIdentity(env.DB, {
      connectionId: 701, provider: 'google_classroom', externalUserId: 'canvas-user-1', personId: 7012,
    })).rejects.toThrow('learning_persistence_failed');
    for (const input of [
      { connectionId: 701, provider: 'canvas' as const, externalUserId: 'canvas-user-2', personId: 7012 },
      { connectionId: 701, provider: 'canvas' as const, externalUserId: 'canvas-user-1', personId: 7013 },
    ]) await expect(linkLearningIdentity(env.DB, input)).rejects.toBeInstanceOf(LearningIdentityConflictError);
    expect(await env.DB.prepare(`SELECT external_user_id,person_id,status FROM learning_identity_links`).all())
      .toMatchObject({ results: [{ external_user_id: 'canvas-user-1', person_id: 7012, status: 'active' }] });
  });

  it('atomically upserts one authoritative course generation, deduplicates events, and reconciles absent rows', async () => {
    const { mapped } = await seed();
    const lease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    const firstEnrollment = enrollment('canvas-user-1');
    const assignment = activity('homework-1', 'assignment');
    const quiz = activity('quiz-1', 'quiz');
    const first = await completeLearningCourseSync(env.DB, lease, {
      course: { ...course(), lastSyncedAt: NOW }, urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment: firstEnrollment, personId: 7012 }],
      activities: [assignment, quiz],
      resources: [{
        connectionId: 701, provider: 'canvas', externalCourseId: 'genesis-1', externalActivityId: 'homework-1',
        externalResourceId: 'worksheet', title: 'Worksheet', kind: 'provider_file' as const,
        launchUrl: 'https://files.learning.test/worksheet.pdf', youtubeVideoId: null,
        mimeType: 'application/pdf', sizeBytes: 2048, providerUpdatedAt: NOW,
      }],
      submissions: [{ providerSubmission: submission('homework-1', 'canvas-user-1'), personId: 7012 }],
    });
    expect(first).toMatchObject({ status: 'succeeded', scannedCount: 5 });
    expect(await env.DB.prepare(`SELECT status FROM learning_submission_snapshots`).first()).toEqual({ status: 'submitted' });
    expect(await env.DB.prepare(`SELECT event_type FROM learning_activity_events ORDER BY event_type`).all())
      .toMatchObject({ results: [{ event_type: 'assignment_submitted' }, { event_type: 'enrolled' }] });

    const replayLease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: LATER, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await completeLearningCourseSync(env.DB, replayLease, {
      course: { ...course('genesis-1', 'Genesis 1 updated'), lastSyncedAt: LATER }, urlPolicy: POLICY, syncedAt: LATER,
      enrollments: [{ providerEnrollment: firstEnrollment, personId: 7012 }],
      activities: [quiz], resources: [], submissions: [],
    });
    expect(await env.DB.prepare(`SELECT display_name,last_synced_at FROM learning_courses WHERE id=?`).bind(mapped.courseId).first())
      .toEqual({ display_name: 'Genesis 1 updated', last_synced_at: LATER });
    expect(await env.DB.prepare(`SELECT external_activity_id,lifecycle_state FROM learning_activities ORDER BY external_activity_id`).all())
      .toMatchObject({ results: [
        { external_activity_id: 'homework-1', lifecycle_state: 'deleted' },
        { external_activity_id: 'quiz-1', lifecycle_state: 'published' },
      ] });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_resources`).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_submission_snapshots`).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_activity_events`).first()).toEqual({ count: 2 });
  });

  it('preserves the prior complete snapshot and records a bounded failed run when any entity conflicts', async () => {
    const { mapped } = await seed();
    await linkLearningIdentity(env.DB, {
      connectionId: 701, provider: 'canvas', externalUserId: 'canvas-user-1', personId: 7012,
    });
    const initialLease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await completeLearningCourseSync(env.DB, initialLease, {
      course: { ...course('genesis-1', 'Last complete generation'), lastSyncedAt: NOW }, urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment: enrollment('canvas-user-1'), personId: 7012 }],
      activities: [activity('stable-activity', 'assignment')], resources: [], submissions: [],
    });
    const lease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: LATER, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await expect(completeLearningCourseSync(env.DB, lease, {
      course: { ...course('genesis-1', 'Must not commit'), lastSyncedAt: LATER }, urlPolicy: POLICY, syncedAt: LATER,
      enrollments: [{ providerEnrollment: enrollment('canvas-user-1'), personId: 7013 }],
      activities: [activity('must-not-exist', 'quiz')], resources: [], submissions: [],
    })).rejects.toBeInstanceOf(LearningIdentityConflictError);
    await failLearningSync(env.DB, lease, { finishedAt: LATER, errorCode: 'malformed_response' });
    expect(await env.DB.prepare(`SELECT display_name,last_synced_at FROM learning_courses WHERE id=?`).bind(mapped.courseId).first())
      .toEqual({ display_name: 'Last complete generation', last_synced_at: NOW });
    expect(await env.DB.prepare(`SELECT external_activity_id,kind FROM learning_activities`).all())
      .toMatchObject({ results: [{ external_activity_id: 'stable-activity', kind: 'assignment' }] });
    expect(await getLearningSyncRun(env.DB, lease.runId)).toMatchObject({ status: 'failed', errorCode: 'malformed_response' });
  });

  it('scopes learner reads inside SQL by course and person and never leaks another learner or course', async () => {
    const { mapped } = await seed();
    const lease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await completeLearningCourseSync(env.DB, lease, {
      course: { ...course(), lastSyncedAt: NOW }, urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [
        { providerEnrollment: enrollment('canvas-user-1'), personId: 7012 },
        { providerEnrollment: enrollment('canvas-user-2'), personId: 7013 },
      ], activities: [], resources: [], submissions: [],
    });
    expect(await listLearningEnrollmentsForPerson(env.DB, { courseId: mapped.courseId, personId: 7012 }))
      .toEqual([expect.objectContaining({ personId: 7012, externalUserId: 'canvas-user-1' })]);
    expect(await listLearningEnrollmentsForPerson(env.DB, { courseId: mapped.courseId, personId: 7013 }))
      .toEqual([expect.objectContaining({ personId: 7013, externalUserId: 'canvas-user-2' })]);
    expect(await listLearningEnrollmentsForPerson(env.DB, { courseId: mapped.courseId + 999, personId: 7012 })).toEqual([]);

    await env.DB.prepare(`UPDATE learning_enrollments SET state='invited'
      WHERE course_id=? AND external_enrollment_id=?`)
      .bind(mapped.courseId, learningSyntheticEnrollmentId({ provider: 'canvas', externalCourseId: 'genesis-1', externalUserId: 'canvas-user-1' })).run();
    expect(await listLearningEnrollmentsForPerson(env.DB, { courseId: mapped.courseId, personId: 7012 })).toEqual([]);
    await env.DB.prepare(`UPDATE learning_enrollments SET state='active'
      WHERE course_id=?`).bind(mapped.courseId).run();
    await env.DB.prepare(`UPDATE learning_courses SET lifecycle_state='archived' WHERE id=?`).bind(mapped.courseId).run();
    expect(await listLearningEnrollmentsForPerson(env.DB, { courseId: mapped.courseId, personId: 7012 })).toEqual([]);
    await env.DB.prepare(`UPDATE learning_courses SET lifecycle_state='active' WHERE id=?`).bind(mapped.courseId).run();
    await env.DB.prepare(`UPDATE learning_provider_connections SET status='error' WHERE id=701`).run();
    expect(await listLearningEnrollmentsForPerson(env.DB, { courseId: mapped.courseId, personId: 7012 })).toEqual([]);
  });

  it('emits stable submitted and returned transitions and reports only actual per-run differences', async () => {
    const { mapped } = await seed();
    const firstLease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    const quiz = activity('quiz-returned', 'quiz');
    const returned = submission('quiz-returned', 'canvas-user-1', 'returned');
    const first = await completeLearningCourseSync(env.DB, firstLease, {
      course: { ...course(), lastSyncedAt: NOW }, urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment: enrollment('canvas-user-1'), personId: 7012 }],
      activities: [quiz], resources: [],
      submissions: [{ providerSubmission: returned, personId: 7012 }],
    });
    expect(first).toMatchObject({ scannedCount: 3, changedCount: 3, removedCount: 0, eventCount: 3 });
    expect(await env.DB.prepare(`SELECT event_type,occurred_at FROM learning_activity_events
      ORDER BY occurred_at,event_type`).all()).toMatchObject({ results: [
      { event_type: 'enrolled', occurred_at: NOW },
      { event_type: 'quiz_submitted', occurred_at: NOW },
      { event_type: 'submission_returned', occurred_at: LATER },
    ] });

    const replayLease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: AFTER, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    const replay = await completeLearningCourseSync(env.DB, replayLease, {
      course: { ...course(), lastSyncedAt: AFTER }, urlPolicy: POLICY, syncedAt: AFTER,
      enrollments: [{ providerEnrollment: enrollment('canvas-user-1'), personId: 7012 }],
      activities: [quiz], resources: [],
      submissions: [{ providerSubmission: { ...returned, providerUpdatedAt: AFTER }, personId: 7012 }],
    });
    expect(replay).toMatchObject({ scannedCount: 3, changedCount: 1, removedCount: 0, eventCount: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_activity_events`).first()).toEqual({ count: 3 });

    const exactReplayLease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: FINAL, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    const exactReplay = await completeLearningCourseSync(env.DB, exactReplayLease, {
      course: { ...course(), lastSyncedAt: FINAL }, urlPolicy: POLICY, syncedAt: FINAL,
      enrollments: [{ providerEnrollment: enrollment('canvas-user-1'), personId: 7012 }],
      activities: [quiz], resources: [],
      submissions: [{ providerSubmission: { ...returned, providerUpdatedAt: AFTER }, personId: 7012 }],
    });
    expect(exactReplay).toMatchObject({ scannedCount: 3, changedCount: 0, removedCount: 0, eventCount: 0 });
  });

  it('rejects a generation above the explicit atomic entity ceiling before replacing the prior snapshot', async () => {
    const { mapped } = await seed();
    const initialLease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await completeLearningCourseSync(env.DB, initialLease, {
      course: { ...course(), displayName: 'Stable generation', lastSyncedAt: NOW }, urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [],
      activities: Array.from({ length: 50 }, (_, index) => activity(`stable-${index}`, 'material')),
      resources: [], submissions: [],
    });
    const oversizedLease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: LATER, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
    });
    await expect(completeLearningCourseSync(env.DB, oversizedLease, {
      course: { ...course(), displayName: 'Oversized generation', lastSyncedAt: LATER }, urlPolicy: POLICY, syncedAt: LATER,
      enrollments: [],
      activities: Array.from({ length: 51 }, (_, index) => activity(`oversized-${index}`, 'material')),
      resources: [], submissions: [],
    })).rejects.toThrow('learning_limit_exceeded');
    expect(await env.DB.prepare(`SELECT display_name FROM learning_courses WHERE id=?`).bind(mapped.courseId).first())
      .toEqual({ display_name: 'Stable generation' });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_activities
      WHERE lifecycle_state<>'deleted'`).first()).toEqual({ count: 50 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_activities
      WHERE external_activity_id LIKE 'oversized-%'`).first()).toEqual({ count: 0 });
  });

  it('allows only one concurrent lease per connection and leaves no losing run or mixed generation', async () => {
    const { mapped } = await seed();
    const attempts = await Promise.allSettled([
      startLearningSync(env.DB, {
        connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
        trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
      }),
      startLearningSync(env.DB, {
        connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
        trigger: 'scheduled', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LEASE_END,
      }),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(attempts.find((item) => item.status === 'rejected')).toMatchObject({ reason: expect.any(LearningSyncConflictError) });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_sync_runs`).first()).toEqual({ count: 1 });
  });

  it('heartbeats a live lease, rejects expired completion, and crash-recovers with a cancelled old run', async () => {
    const { mapped } = await seed();
    const first = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LATER,
    } as never);
    const heartbeat = (learningDb as unknown as {
      heartbeatLearningSync?: (
        db: AppDb,
        lease: typeof first,
        input: { heartbeatAt: string; leaseExpiresAt: string },
      ) => Promise<typeof first>;
    }).heartbeatLearningSync;
    expect(heartbeat).toBeTypeOf('function');
    if (!heartbeat) return;
    const extended = await heartbeat(env.DB, first, {
      heartbeatAt: '2026-08-17T12:04:00.000Z', leaseExpiresAt: AFTER,
    });
    expect(extended).toMatchObject({ leaseExpiresAt: AFTER });
    await completeLearningCourseSync(env.DB, extended, {
      course: { ...course(), lastSyncedAt: '2026-08-17T12:06:00.000Z' },
      urlPolicy: POLICY, syncedAt: '2026-08-17T12:06:00.000Z',
      enrollments: [], activities: [], resources: [], submissions: [],
    });

    const expired = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: AFTER, urlPolicy: POLICY, leaseExpiresAt: FINAL,
    } as never);
    const replacement = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'scheduled', startedAt: '2026-08-17T12:16:00.000Z', urlPolicy: POLICY,
      leaseExpiresAt: '2026-08-17T12:25:00.000Z',
    } as never);
    expect(await getLearningSyncRun(env.DB, expired.runId)).toMatchObject({ status: 'cancelled', errorCode: null });
    await expect(completeLearningCourseSync(env.DB, expired, {
      course: { ...course(), lastSyncedAt: '2026-08-17T12:17:00.000Z' },
      urlPolicy: POLICY, syncedAt: '2026-08-17T12:17:00.000Z',
      enrollments: [], activities: [], resources: [], submissions: [],
    })).rejects.toBeInstanceOf(LearningSyncConflictError);
    await failLearningSync(env.DB, replacement, {
      finishedAt: '2026-08-17T12:17:00.000Z', errorCode: 'cancelled',
    });
    expect(await getLearningSyncRun(env.DB, replacement.runId)).toMatchObject({ status: 'cancelled', errorCode: null });
  });

  it('makes concurrent expired-lease terminal recovery idempotent without overwriting the winner', async () => {
    const { mapped } = await seed();
    const expired = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: LATER,
    });
    const outcomes = await Promise.allSettled([
      recoverExpiredLearningSync(env.DB, expired, { finishedAt: AFTER, errorCode: 'timeout' }),
      recoverExpiredLearningSync(env.DB, expired, { finishedAt: AFTER, errorCode: 'rate_limited' }),
    ]);
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ]);
    expect(await getLearningSyncRun(env.DB, expired.runId)).toMatchObject({
      status: 'failed', errorCode: expect.stringMatching(/^(?:timeout|rate_limited)$/),
    });
    expect(await env.DB.prepare(`SELECT operation_marker,operation_expires_at
      FROM learning_provider_connections WHERE id=701`).first())
      .toEqual({ operation_marker: null, operation_expires_at: null });
  });

  it('rolls back a generation when an admin disables its exact identity after preflight', async () => {
    const { mapped } = await seed();
    await linkLearningIdentity(env.DB, {
      connectionId: 701, provider: 'canvas', externalUserId: 'raced-user', personId: 7012,
    });
    const lease = await startLearningSync(env.DB, {
      connectionId: 701, provider: 'canvas', courseId: mapped.courseId, externalCourseId: 'genesis-1',
      trigger: 'manual', startedAt: NOW, urlPolicy: POLICY, leaseExpiresAt: AFTER,
    } as never);
    let raced = false;
    const racingDb: AppDb = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          await env.DB.prepare(`UPDATE learning_identity_links SET status='disabled'
            WHERE connection_id=701 AND external_user_id='raced-user'`).run();
        }
        return env.DB.batch(statements as D1PreparedStatement[]);
      },
    };
    await expect(completeLearningCourseSync(racingDb, lease, {
      course: { ...course(), lastSyncedAt: NOW }, urlPolicy: POLICY, syncedAt: NOW,
      enrollments: [{ providerEnrollment: enrollment('raced-user'), personId: 7012 }],
      activities: [activity('raced-activity', 'quiz')], resources: [], submissions: [],
    })).rejects.toBeInstanceOf(LearningIdentityConflictError);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_activities`).first()).toEqual({ count: 0 });
    expect(await getLearningSyncRun(env.DB, lease.runId)).toMatchObject({ status: 'running' });
  });
});
