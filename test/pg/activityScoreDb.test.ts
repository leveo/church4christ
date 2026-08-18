import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import {
  ActivityScoreConflictError,
  getActivityScoreConfig,
  isLearningActivitySourceAvailable,
  listGroupAttendanceEvidence,
  listRegistrationEvidence,
  listLearningEngagementEvidence,
  listServingEvidence,
  saveActivityScoreConfig,
} from '../../src/lib/activityScoreDb';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('activity score DB (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(`
      TRUNCATE registrations, reg_events, group_attendance, group_event_occurrences,
        group_events, group_members, groups, roster_assignments, plan_positions,
        plans, positions, teams, ministries, service_type_i18n, service_types,
        people RESTART IDENTITY CASCADE;
      INSERT INTO activity_score_config (id) VALUES (1)
        ON CONFLICT (id) DO NOTHING;
      UPDATE activity_score_config SET
        window_days=90, include_visitor=0, include_regular=1, include_member=1,
        include_inactive=0, active_threshold=70, watch_threshold=40,
        revision=0, last_mutation_id='', updated_by_person_id=NULL,
        updated_at=datetime('now') WHERE id=1;
      UPDATE activity_score_dimensions SET enabled=1, weight=50, target_count=NULL
        WHERE dimension_key='group_attendance';
      UPDATE activity_score_dimensions SET enabled=1, weight=50, target_count=3
        WHERE dimension_key='serving';
      UPDATE activity_score_dimensions SET enabled=0, weight=0, target_count=2
        WHERE dimension_key='registration';
      UPDATE activity_score_dimensions SET enabled=0, weight=0, target_count=3
        WHERE dimension_key='learning_engagement';
      INSERT INTO people (id, display_name, email, membership_status) VALUES
        (1, 'Actor', 'pg-score-actor@example.com', 'member'),
        (2, 'Member', 'pg-score-member@example.com', 'member');
    `);
  });

  afterAll(async () => { await sql?.end(); });

  it('ports revision-safe configuration without stale partial writes', async () => {
    const initial = await getActivityScoreConfig(db);
    const next = {
      ...initial,
      windowDays: 60 as const,
      dimensions: {
        group_attendance: { enabled: true, weight: 25, targetCount: null },
        serving: { enabled: true, weight: 50, targetCount: 4 },
        registration: { enabled: true, weight: 25, targetCount: 2 },
        learning_engagement: { enabled: false, weight: 0, targetCount: 3 },
      },
    };
    expect(await saveActivityScoreConfig(db, next, 0, 1)).toMatchObject({ revision: 1, windowDays: 60 });
    await expect(saveActivityScoreConfig(db, next, 0, 1)).rejects.toBeInstanceOf(ActivityScoreConflictError);
    expect((await getActivityScoreConfig(db)).dimensions.serving.targetCount).toBe(4);
  });

  it('returns equivalent group, serving, and registration evidence', async () => {
    await sql.unsafe(`
      INSERT INTO groups (id, name) VALUES (10, 'Group');
      INSERT INTO group_events (id, group_id, title, starts_on, start_time, track_attendance)
        VALUES (11, 10, 'Meeting', '2026-06-01', '19:00', 1);
      INSERT INTO group_members (id, group_id, person_id, display_name)
        VALUES (12, 10, 2, 'Member');
      INSERT INTO group_event_occurrences (id, event_id, occurs_on, starts_at, ends_at)
        VALUES (13, 11, '2026-06-01', '2026-06-01 19:00:00', '2026-06-01 20:00:00');
      INSERT INTO group_attendance (occurrence_id, member_id, present)
        VALUES (13, 12, 1);

      INSERT INTO ministries (id, slug, category) VALUES (20, 'pg-score', 'care');
      INSERT INTO teams (id, ministry_id) VALUES (21, 20);
      INSERT INTO positions (id, team_id) VALUES (22, 21);
      INSERT INTO service_types (id) VALUES (23);
      INSERT INTO plans (id, service_type_id, plan_date) VALUES (24, 23, '2026-06-02');
      INSERT INTO roster_assignments (plan_id, position_id, person_id, status)
        VALUES (24, 22, 2, 'C');

      INSERT INTO reg_events (id, starts_at, active) VALUES (30, '2026-06-03 18:00:00', 1);
      INSERT INTO registrations (id, event_id, person_id, name, email, status)
        VALUES (31, 30, 2, 'Member', 'pg-score-member@example.com', 'confirmed');
    `);

    expect(await listGroupAttendanceEvidence(db, '2026-06-01', '2026-06-30')).toEqual([
      { personId: 2, present: 1, opportunities: 1 },
    ]);
    expect(await listServingEvidence(db, '2026-06-01', '2026-06-30')).toEqual([{ personId: 2, count: 1 }]);
    expect(await listRegistrationEvidence(db, '2026-06-01', '2026-06-30')).toEqual([{ personId: 2, count: 1 }]);
  });

  it('matches D1 Learning submission evidence and active-provider availability', async () => {
    await sql.unsafe(`
      INSERT INTO learning_provider_connections
        (id,provider,display_name,status) VALUES (100,'google_classroom','PG score source','active');
      INSERT INTO learning_programs (id,slug,display_name,status)
        VALUES (101,'pg-score-learning','PG score program','active');
      INSERT INTO learning_courses
        (id,program_id,connection_id,provider,external_course_id,display_name,launch_url,lifecycle_state)
        VALUES (102,101,100,'google_classroom','pg-score-course','PG score course',
          'https://classroom.google.com/c/pg-score','active');
      INSERT INTO learning_identity_links
        (id,connection_id,person_id,external_user_id,status)
        VALUES (103,100,2,'pg-score-user','active');
      INSERT INTO learning_enrollments
        (id,connection_id,course_id,identity_link_id,external_enrollment_id,role,state)
        VALUES (104,100,102,103,'pg-score-enrollment','student','completed');
      INSERT INTO learning_activities
        (id,course_id,external_activity_id,title,kind,lifecycle_state,launch_url) VALUES
        (105,102,'pg-score-assignment','Private title','assignment','published',
          'https://classroom.google.com/a/pg-score'),
        (106,102,'pg-score-quiz','Private quiz','quiz','published',
          'https://classroom.google.com/q/pg-score');
      INSERT INTO learning_activity_events
        (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
         enrollment_id,course_id,activity_id,activity_kind,occurred_at) VALUES
        ('pg-score-a',100,'google_classroom','pg-score-a','assignment_submitted',2,103,104,102,105,'assignment','2026-06-01T00:00:00Z'),
        ('pg-score-q',100,'google_classroom','pg-score-q','quiz_submitted',2,103,104,102,106,'quiz','2026-06-30T23:59:59Z'),
        ('pg-score-return',100,'google_classroom','pg-score-return','submission_returned',2,103,104,102,105,'assignment','2026-06-15T00:00:00Z');
    `);
    expect(await isLearningActivitySourceAvailable(db)).toBe(true);
    expect(await listLearningEngagementEvidence(db, '2026-06-01', '2026-06-30')).toEqual([
      { personId: 2, count: 2 },
    ]);
  });
});
