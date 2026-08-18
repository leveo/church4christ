import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ACTIVITY_SCORE_EVENTS,
  isLearningActivitySourceAvailable,
  listLearningEngagementEvidence,
} from '../src/lib/activityScoreDb';

beforeEach(async () => {
  await env.DB.prepare(`UPDATE learning_provider_connections SET status='disabled'
    WHERE id=19510 AND deleted_at IS NULL`).run();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM learning_activity_events WHERE connection_id=19510`),
    env.DB.prepare(`DELETE FROM learning_activities WHERE course_id=19530`),
    env.DB.prepare(`DELETE FROM learning_enrollments WHERE connection_id=19510`),
    env.DB.prepare(`DELETE FROM learning_identity_links WHERE connection_id=19510`),
    env.DB.prepare(`DELETE FROM learning_courses WHERE connection_id=19510`),
    env.DB.prepare(`DELETE FROM learning_programs WHERE id=19520`),
    env.DB.prepare(`DELETE FROM learning_provider_connections WHERE id=19510`),
    env.DB.prepare(`DELETE FROM people WHERE id IN (19501,19502)`),
  ]);
});

async function seedLearningEvidence(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people
      (id,display_name,email,active,membership_status) VALUES
      (19501,'Eligible learner','score-learning@example.test',1,'member'),
      (19502,'Inactive learner','score-learning-inactive@example.test',0,'member')`),
    env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,status) VALUES
      (19510,'google_classroom','Activity source','active')`),
    env.DB.prepare(`INSERT INTO learning_programs
      (id,slug,display_name,status) VALUES (19520,'score-learning','Learning score','active')`),
    env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url,lifecycle_state)
      VALUES (19530,19520,19510,'google_classroom','course-score','Score course',
        'https://classroom.google.com/c/score','active')`),
    env.DB.prepare(`INSERT INTO learning_identity_links
      (id,connection_id,person_id,external_user_id,status) VALUES
      (19540,19510,19501,'user-score','active'),
      (19541,19510,19502,'user-inactive','active')`),
    env.DB.prepare(`INSERT INTO learning_enrollments
      (id,connection_id,course_id,identity_link_id,external_enrollment_id,role,state) VALUES
      (19550,19510,19530,19540,'enrollment-score','student','active'),
      (19551,19510,19530,19541,'enrollment-inactive','student','active')`),
    env.DB.prepare(`INSERT INTO learning_activities
      (id,course_id,external_activity_id,title,kind,lifecycle_state,launch_url) VALUES
      (19560,19530,'assignment-score','Hostile assignment title','assignment','published',
        'https://classroom.google.com/a/score'),
      (19561,19530,'quiz-score','Private quiz title','quiz','published',
        'https://classroom.google.com/q/score'),
      (19562,19530,'material-score','Private material title','material','published',
        'https://classroom.google.com/m/score')`),
  ]);

  const event = (
    id: string,
    type: string,
    personId: number,
    identityId: number,
    enrollmentId: number,
    activityId: number | null,
    kind: string | null,
    occurredAt: string,
  ) => env.DB.prepare(`INSERT INTO learning_activity_events
    (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
     enrollment_id,course_id,activity_id,activity_kind,occurred_at)
    VALUES (?,19510,'google_classroom',?,?,?,?,?,19530,?,?,?)`)
    .bind(id, id, type, personId, identityId, enrollmentId, activityId, kind, occurredAt);
  await env.DB.batch([
    event('score-at-start', 'assignment_submitted', 19501, 19540, 19550, 19560, 'assignment', '2026-06-01T00:00:00Z'),
    event('score-at-end', 'quiz_submitted', 19501, 19540, 19550, 19561, 'quiz', '2026-06-30T23:59:59Z'),
    event('score-before', 'assignment_submitted', 19501, 19540, 19550, 19560, 'assignment', '2026-05-31T23:59:59Z'),
    event('score-after', 'quiz_submitted', 19501, 19540, 19550, 19561, 'quiz', '2026-07-01T00:00:00Z'),
    event('score-returned', 'submission_returned', 19501, 19540, 19550, 19560, 'assignment', '2026-06-15T12:00:00Z'),
    event('score-material', 'resource_opened', 19501, 19540, 19550, 19562, 'material', '2026-06-15T12:00:00Z'),
    event('score-enrolled', 'enrolled', 19501, 19540, 19550, null, null, '2026-06-15T12:00:00Z'),
    event('score-inactive-person', 'quiz_submitted', 19502, 19541, 19551, 19561, 'quiz', '2026-06-15T12:00:00Z'),
  ]);
  await env.DB.prepare(`INSERT INTO learning_activity_events
    (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
     enrollment_id,course_id,activity_id,activity_kind,occurred_at)
    VALUES ('duplicate-id',19510,'google_classroom','score-at-start','assignment_submitted',
      19501,19540,19550,19530,19560,'assignment','2026-06-01T00:00:00Z')
    ON CONFLICT(connection_id,source_event_id) DO NOTHING`).run();
}

describe('Learning engagement Activity Score evidence (D1)', () => {
  it('counts only deduplicated assignment and quiz submissions on inclusive bounds', async () => {
    await seedLearningEvidence();
    expect(MAX_ACTIVITY_SCORE_EVENTS).toBe(5_000);
    expect(await isLearningActivitySourceAvailable(env.DB)).toBe(true);
    expect(await listLearningEngagementEvidence(
      env.DB, '2026-06-01', '2026-06-30', 5_000, 5_000,
    )).toEqual([{ personId: 19501, count: 2 }]);
  });

  it('fails the live identity/connection chain closed without deleting historical events', async () => {
    await seedLearningEvidence();
    await env.DB.prepare(`UPDATE learning_identity_links SET status='disabled' WHERE id=19540`).run();
    expect(await listLearningEngagementEvidence(env.DB, '2026-06-01', '2026-06-30')).toEqual([]);
    await env.DB.prepare(`UPDATE learning_provider_connections SET status='disabled' WHERE id=19510`).run();
    expect(await isLearningActivitySourceAvailable(env.DB)).toBe(false);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_activity_events`).first()).toEqual({ count: 8 });
  });

  it('uses one aggregate query and rejects an event count beyond the independent 5,000 bound', async () => {
    await seedLearningEvidence();
    const prepared: string[] = [];
    const db = {
      prepare(sql: string) {
        prepared.push(sql);
        return env.DB.prepare(sql);
      },
    } as typeof env.DB;
    await expect(listLearningEngagementEvidence(db, '2026-06-01', '2026-06-30', 5_000, 1))
      .rejects.toMatchObject({ code: 'activity_score_limit' });
    expect(prepared).toHaveLength(1);
  });

  it('returns only person ids and bounded counts, never provider or private content fields', async () => {
    await seedLearningEvidence();
    const rows = await listLearningEngagementEvidence(env.DB, '2026-06-01', '2026-06-30');
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['count', 'personId']);
    expect(JSON.stringify(rows)).not.toMatch(/Hostile|Private|course|grade|late|answer|file|comment/i);
  });
});
