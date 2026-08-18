import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import {
  listLearningSyncTargets,
  markLearningConnectionReconnectRequired,
  runScheduledLearningSyncPass,
} from '../../src/lib/learningSyncOrchestration';
import { LearningSynchronizationError } from '../../src/lib/learningSync';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('Learning synchronization target parity (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    db = new PgAdapter(sql);
    await sql.unsafe(`
      INSERT INTO people(id,display_name,email,role) VALUES
        (9301,'PG Sync Admin','pg-sync-admin@example.test','admin');
      INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,revision,created_by_person_id) VALUES
        (9301,'google_classroom','PG Classroom',NULL,'active',1,9301),
        (9302,'canvas','PG Canvas','https://pg-canvas-sync.test','disabled',2,9301);
      INSERT INTO learning_programs(id,slug,display_name,status) VALUES
        (9301,'pg-sync-active','PG Sync Active','active'),
        (9302,'pg-sync-archived','PG Sync Archived','archived');
      INSERT INTO learning_courses
        (id,program_id,connection_id,provider,external_course_id,display_name,launch_url,lifecycle_state,last_synced_at) VALUES
        (9301,9301,9301,'google_classroom','pg-course','PG Course','https://classroom.google.com/c/pg','active',NULL),
        (9302,9301,9302,'canvas','pg-off','PG Off','https://pg-canvas-sync.test/courses/2','active',NULL),
        (9303,9302,9301,'google_classroom','pg-program-off','PG Program Off','https://classroom.google.com/c/off','active',NULL),
        (9304,9301,9301,'google_classroom','pg-course-next','PG Course Next','https://classroom.google.com/c/next','active','2026-08-18T11:00:00.000Z');
    `);
  });

  afterAll(async () => { await sql?.end(); });

  it('matches D1 active-graph authorization and exact manual scope', async () => {
    expect(await listLearningSyncTargets(db, { limit: 2 })).toEqual([
      { courseId: 9301, connectionId: 9301, provider: 'google_classroom', externalCourseId: 'pg-course' },
      { courseId: 9304, connectionId: 9301, provider: 'google_classroom', externalCourseId: 'pg-course-next' },
    ]);
    expect(await listLearningSyncTargets(db, { courseId: 9302, limit: 1 })).toEqual([]);
  });

  it('persists fair scheduled attempts and reconnect state through the AppDb PostgreSQL path', async () => {
    const attempted: number[] = [];
    let current = Date.parse('2026-08-18T12:00:00.000Z');
    const dependencies = {
      learningEnabled: async () => true,
      now: () => current,
      reconcileTarget: async (input: { readonly courseId: number }) => {
        attempted.push(input.courseId);
        throw new LearningSynchronizationError('provider_unavailable', 'google_classroom', {
          httpStatus: 503, retryAfterSeconds: null,
        });
      },
    };
    await runScheduledLearningSyncPass({} as never, db, dependencies);
    current += 60_000;
    await runScheduledLearningSyncPass({} as never, db, dependencies);
    expect(attempted).toEqual([9301, 9304]);
    expect(await sql.unsafe(`SELECT id,last_sync_attempt_at FROM learning_courses
      WHERE id IN (9301,9304) ORDER BY id`)).toEqual([
      { id: 9301, last_sync_attempt_at: '2026-08-18T12:00:00.000Z' },
      { id: 9304, last_sync_attempt_at: '2026-08-18T12:01:00.000Z' },
    ]);
    await markLearningConnectionReconnectRequired(db, {
      connectionId: 9301, provider: 'google_classroom', errorCode: 'authentication_required',
    });
    expect(await listLearningSyncTargets(db, { courseId: 9301, limit: 1 })).toEqual([]);
  });
});
