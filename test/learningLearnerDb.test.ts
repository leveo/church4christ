import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LearningLearnerDataError,
  getLearningCourseForLearner,
  listLearningCoursesForLearner,
} from '../src/lib/learningLearnerDb';

const NOW = '2026-08-17T12:00:00.000Z';
const RECENT = '2026-08-17T10:00:00.000Z';
const SOON = '2026-08-18T12:00:00.000Z';
const LATER = '2026-08-19T12:00:00.000Z';

async function seedLearnerData(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE learning_provider_connections SET status='disabled',
      deleted_at=COALESCE(deleted_at,?1) WHERE id=910`).bind(NOW),
    env.DB.prepare(`UPDATE learning_courses SET lifecycle_state='archived',
      deleted_at=COALESCE(deleted_at,?1) WHERE id IN (910,911)`).bind(NOW),
    env.DB.prepare(`DELETE FROM learning_submission_snapshots WHERE course_id IN (910,911)`),
    env.DB.prepare(`DELETE FROM learning_resources WHERE activity_id BETWEEN 9100 AND 9199`),
    env.DB.prepare(`DELETE FROM learning_activities WHERE course_id IN (910,911)`),
    env.DB.prepare(`DELETE FROM learning_enrollments WHERE course_id IN (910,911)`),
    env.DB.prepare(`DELETE FROM learning_identity_links WHERE id IN (910,911)`),
    env.DB.prepare(`DELETE FROM learning_courses WHERE id IN (910,911)`),
    env.DB.prepare(`DELETE FROM learning_programs WHERE id IN (910,911)`),
    env.DB.prepare(`DELETE FROM learning_provider_connections WHERE id=910`),
    env.DB.prepare(`DELETE FROM people WHERE id BETWEEN 9101 AND 9103`),
  ]);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people
      (id,display_name,email,role,active,deleted_at) VALUES
      (9101,'Learner One','learner-one-9101@example.test','member',1,NULL),
      (9102,'Learner Two','learner-two-9102@example.test','member',1,NULL),
      (9103,'Learning Admin','learning-admin-9103@example.test','admin',1,NULL)`),
    env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,last_successful_sync_at,
       created_by_person_id,updated_by_person_id)
      VALUES
      (910,'canvas','Church Canvas','https://canvas.learning.test','active',1,?1,9103,9103)`)
      .bind(NOW),
    env.DB.prepare(`INSERT INTO learning_programs
      (id,slug,display_name,status,created_by_person_id,updated_by_person_id)
      VALUES
      (910,'genesis-course','Genesis Sunday School','active',9103,9103),
      (911,'other-course','Other Program','active',9103,9103)`),
    env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url,
       lifecycle_state,provider_updated_at,last_synced_at)
      VALUES
      (910,910,910,'canvas','genesis-1','Genesis 1','https://canvas.learning.test/courses/1',
       'active',?1,?1),
      (911,911,910,'canvas','other-1','Other learner course','https://canvas.learning.test/courses/2',
       'active',?1,?1)`).bind(NOW),
    env.DB.prepare(`INSERT INTO learning_identity_links
      (id,connection_id,person_id,external_user_id,status) VALUES
      (910,910,9101,'canvas-user-1','active'),
      (911,910,9102,'canvas-user-2','active')`),
    env.DB.prepare(`INSERT INTO learning_enrollments
      (id,connection_id,course_id,identity_link_id,external_enrollment_id,role,state,last_synced_at)
      VALUES
      (910,910,910,910,'enrollment-1','student','active',?1),
      (911,910,911,911,'enrollment-2','student','active',?1)`).bind(NOW),
    env.DB.prepare(`INSERT INTO learning_activities
      (id,course_id,external_activity_id,title,kind,lifecycle_state,launch_url,due_at,
       published_at,provider_updated_at,last_synced_at)
      VALUES
      (9101,910,'material-1','Recent material','material','published',
       'https://canvas.learning.test/courses/1/modules/items/1',NULL,?1,?2,?2),
      (9102,910,'assignment-1','First assignment','assignment','published',
       'https://canvas.learning.test/courses/1/assignments/1',?3,?1,?2,?2),
      (9103,910,'quiz-1','Later quiz','quiz','published',
       'https://canvas.learning.test/courses/1/quizzes/1',?4,?1,?2,?2),
      (9111,911,'private-1','Private other activity','assignment','published',
       'https://canvas.learning.test/courses/2/assignments/1',?3,?1,?2,?2)`)
      .bind(RECENT, NOW, SOON, LATER),
    env.DB.prepare(`INSERT INTO learning_resources
      (id,activity_id,external_resource_id,title,kind,launch_url,youtube_video_id,mime_type,size_bytes,
       provider_updated_at)
      VALUES
      (9101,9101,'youtube-1','Prepared video','youtube',
       'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ','dQw4w9WgXcQ',NULL,NULL,?1),
      (9102,9101,'file-1','Class handout','provider_file',
       'https://canvas.learning.test/files/1',NULL,'application/pdf',1200,?1),
      (9103,9101,'link-1','Reading link','link',
       'https://canvas.learning.test/courses/1/pages/reading',NULL,NULL,NULL,?1)`).bind(NOW),
    env.DB.prepare(`INSERT INTO learning_submission_snapshots
      (course_id,activity_id,activity_kind,enrollment_id,status,late,attempt_number,
       submitted_at,returned_at,provider_updated_at,synced_at)
      VALUES (910,9102,'assignment',910,'submitted',0,1,?1,NULL,?1,?1)`).bind(NOW),
  ]);
}

beforeEach(seedLearnerData);

describe('Learning learner reads (D1)', () => {
  it('returns only SQL-authorized courses and deterministic upcoming/recent metadata', async () => {
    const courses = await listLearningCoursesForLearner(env.DB, {
      personId: 9101,
      nowEpochMs: Date.parse(NOW),
    });

    expect(courses).toHaveLength(1);
    expect(courses[0]).toMatchObject({
      courseId: 910,
      displayName: 'Genesis 1',
      programName: 'Genesis Sunday School',
      provider: 'canvas',
      providerStatus: 'active',
      isStale: false,
    });
    expect(courses[0]?.upcomingActivities.map((activity) => activity.title)).toEqual([
      'First assignment',
      'Later quiz',
    ]);
    expect(courses[0]?.recentMaterials.map((activity) => activity.title)).toEqual(['Recent material']);
    expect(courses[0]?.upcomingActivities[0]?.submission).toMatchObject({
      status: 'submitted',
      late: 0,
      attemptNumber: 1,
    });
    expect(JSON.stringify(courses)).not.toMatch(/canvas-user|enrollment-1|Private other activity/);
  });

  it('loads a detail only through the same live-person and active-parent SQL scope', async () => {
    const course = await getLearningCourseForLearner(env.DB, {
      courseId: 910,
      personId: 9101,
      nowEpochMs: Date.parse(NOW),
    });
    expect(course?.activities.map((activity) => activity.activityId)).toEqual([9102, 9103, 9101]);
    expect(course?.activities[2]?.resources.map((resource) => resource.kind)).toEqual([
      'youtube',
      'provider_file',
      'link',
    ]);
    expect(await getLearningCourseForLearner(env.DB, {
      courseId: 911,
      personId: 9101,
      nowEpochMs: Date.parse(NOW),
    })).toBeNull();
    expect(await getLearningCourseForLearner(env.DB, {
      courseId: 999_999,
      personId: 9101,
      nowEpochMs: Date.parse(NOW),
    })).toBeNull();
  });

  it.each([
    ['non-live person', "UPDATE people SET active=0 WHERE id=9101"],
    ['soft-deleted person', "UPDATE people SET deleted_at=?1 WHERE id=9101"],
    ['disabled identity', "UPDATE learning_identity_links SET status='disabled' WHERE id=910"],
    ['inactive enrollment', "UPDATE learning_enrollments SET state='inactive' WHERE id=910"],
    ['archived program', "UPDATE learning_programs SET status='archived' WHERE id=910"],
    ['soft-deleted program', "UPDATE learning_programs SET status='archived',deleted_at=?1 WHERE id=910"],
    ['archived course', "UPDATE learning_courses SET lifecycle_state='archived' WHERE id=910"],
    ['soft-deleted course', "UPDATE learning_courses SET lifecycle_state='archived',deleted_at=?1 WHERE id=910"],
    ['disabled connection', "UPDATE learning_provider_connections SET status='disabled' WHERE id=910"],
    ['disconnected connection', "UPDATE learning_provider_connections SET status='disabled',deleted_at=?1 WHERE id=910"],
  ])('fails closed for a %s', async (_label, sql) => {
    const statement = env.DB.prepare(sql);
    await (sql.includes('?1') ? statement.bind(NOW) : statement).run();
    expect(await listLearningCoursesForLearner(env.DB, {
      personId: 9101,
      nowEpochMs: Date.parse(NOW),
    })).toEqual([]);
    expect(await getLearningCourseForLearner(env.DB, {
      courseId: 910,
      personId: 9101,
      nowEpochMs: Date.parse(NOW),
    })).toBeNull();
  });

  it('revalidates every persisted URL against its exact provider role before rendering', async () => {
    await env.DB.prepare(`UPDATE learning_resources
      SET launch_url='https://evil.example/stolen' WHERE id=9102`).run();
    await expect(getLearningCourseForLearner(env.DB, {
      courseId: 910,
      personId: 9101,
      nowEpochMs: Date.parse(NOW),
    })).rejects.toBeInstanceOf(LearningLearnerDataError);
  });

  it('marks missing and old course sync snapshots stale without claiming provider freshness', async () => {
    await env.DB.prepare(`UPDATE learning_courses SET last_synced_at=NULL WHERE id=910`).run();
    let [course] = await listLearningCoursesForLearner(env.DB, {
      personId: 9101,
      nowEpochMs: Date.parse(NOW),
    });
    expect(course).toMatchObject({ lastSyncedAt: null, isStale: true });

    await env.DB.prepare(`UPDATE learning_courses SET last_synced_at=?1 WHERE id=910`)
      .bind('2026-08-15T11:59:59.000Z').run();
    [course] = await listLearningCoursesForLearner(env.DB, {
      personId: 9101,
      nowEpochMs: Date.parse(NOW),
    });
    expect(course).toMatchObject({ isStale: true });
  });
});
