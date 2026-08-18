import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import {
  getLearningCourseForLearner,
  listLearningCoursesForLearner,
} from '../../src/lib/learningLearnerDb';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const NOW = '2026-08-17T12:00:00.000Z';

describe.skipIf(!hasPg)('Learning learner read parity (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    db = new PgAdapter(sql);
    await sql.unsafe(`
      INSERT INTO people (id,display_name,email,role,active) VALUES
        (9201,'PG Learner','pg-learner@example.test','member',1),
        (9202,'PG Other','pg-other@example.test','member',1),
        (9203,'PG Admin','pg-admin@example.test','admin',1);
      INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,revision,last_successful_sync_at,
         created_by_person_id,updated_by_person_id)
        VALUES (920,'canvas','PG Canvas','https://pg-canvas.learning.test','active',1,
          '${NOW}',9203,9203);
      INSERT INTO learning_programs
        (id,slug,display_name,status,created_by_person_id,updated_by_person_id)
        VALUES (920,'pg-learning','PG Learning','active',9203,9203);
      INSERT INTO learning_courses
        (id,program_id,connection_id,provider,external_course_id,display_name,launch_url,
         lifecycle_state,provider_updated_at,last_synced_at)
        VALUES (920,920,920,'canvas','pg-course','PG Course',
          'https://pg-canvas.learning.test/courses/1','active','${NOW}','${NOW}');
      INSERT INTO learning_identity_links
        (id,connection_id,person_id,external_user_id,status)
        VALUES (920,920,9201,'pg-user','active');
      INSERT INTO learning_enrollments
        (id,connection_id,course_id,identity_link_id,external_enrollment_id,role,state,last_synced_at)
        VALUES (920,920,920,920,'pg-enrollment','student','active','${NOW}');
      INSERT INTO learning_activities
        (id,course_id,external_activity_id,title,kind,lifecycle_state,launch_url,due_at,
         published_at,provider_updated_at,last_synced_at)
        VALUES (9201,920,'pg-assignment','PG Assignment','assignment','published',
          'https://pg-canvas.learning.test/courses/1/assignments/1',
          '2026-08-18T12:00:00.000Z','${NOW}','${NOW}','${NOW}');
      INSERT INTO learning_submission_snapshots
        (course_id,activity_id,activity_kind,enrollment_id,status,late,attempt_number,
         submitted_at,returned_at,provider_updated_at,synced_at)
        VALUES (920,9201,'assignment',920,'returned',0,1,'${NOW}','${NOW}','${NOW}','${NOW}');
    `);
  });

  afterAll(async () => { await sql?.end(); });

  it('matches D1 authorization, sorting, and privacy-safe snapshot output', async () => {
    const courses = await listLearningCoursesForLearner(db, {
      personId: 9201,
      nowEpochMs: Date.parse(NOW),
    });
    expect(courses).toHaveLength(1);
    expect(courses[0]?.upcomingActivities[0]).toMatchObject({
      title: 'PG Assignment',
      submission: { status: 'returned' },
    });
    expect(await getLearningCourseForLearner(db, {
      courseId: 920,
      personId: 9202,
      nowEpochMs: Date.parse(NOW),
    })).toBeNull();

    await sql.unsafe("UPDATE learning_provider_connections SET status='disabled' WHERE id=920");
    expect(await getLearningCourseForLearner(db, {
      courseId: 920,
      personId: 9201,
      nowEpochMs: Date.parse(NOW),
    })).toBeNull();
  });
});
