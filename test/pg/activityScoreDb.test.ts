import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import {
  ActivityScoreConflictError,
  getActivityScoreConfig,
  listGroupAttendanceEvidence,
  listRegistrationEvidence,
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
});
