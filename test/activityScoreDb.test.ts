import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ActivityScoreConflictError,
  getActivityScoreConfig,
  listEligibleActivityPeople,
  listGroupAttendanceEvidence,
  listServingEvidence,
  saveActivityScoreConfig,
} from '../src/lib/activityScoreDb';
import type { ActivityScoreConfig } from '../src/lib/activityScoreModel';

const defaults: ActivityScoreConfig = {
  windowDays: 90,
  includedStatuses: ['regular', 'member'],
  activeThreshold: 70,
  watchThreshold: 40,
  revision: 0,
  dimensions: {
    group_attendance: { enabled: true, weight: 50, targetCount: null },
    serving: { enabled: true, weight: 50, targetCount: 3 },
    registration: { enabled: false, weight: 0, targetCount: 2 },
  },
};

async function reset(): Promise<void> {
  await env.DB.prepare(`
    UPDATE activity_score_config SET
      window_days=90, include_visitor=0, include_regular=1, include_member=1,
      include_inactive=0, active_threshold=70, watch_threshold=40,
      revision=0, last_mutation_id='', updated_by_person_id=NULL, updated_at=datetime('now')
    WHERE id=1
  `).run();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM group_attendance'),
    env.DB.prepare('DELETE FROM group_event_occurrences'),
    env.DB.prepare('DELETE FROM group_events'),
    env.DB.prepare('DELETE FROM group_members'),
    env.DB.prepare('DELETE FROM groups'),
    env.DB.prepare('DELETE FROM roster_assignments'),
    env.DB.prepare('DELETE FROM plan_positions'),
    env.DB.prepare('DELETE FROM plans'),
    env.DB.prepare('DELETE FROM positions'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM ministries'),
    env.DB.prepare('DELETE FROM service_type_i18n'),
    env.DB.prepare('DELETE FROM service_types'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  await env.DB.batch([
    env.DB.prepare(`UPDATE activity_score_dimensions SET enabled=1, weight=50, target_count=NULL WHERE dimension_key='group_attendance'`),
    env.DB.prepare(`UPDATE activity_score_dimensions SET enabled=1, weight=50, target_count=3 WHERE dimension_key='serving'`),
    env.DB.prepare(`UPDATE activity_score_dimensions SET enabled=0, weight=0, target_count=2 WHERE dimension_key='registration'`),
  ]);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people (id, display_name, email, active, membership_status) VALUES (9101, 'Actor', 'score-actor@example.com', 1, 'member')`),
    env.DB.prepare(`INSERT INTO people (id, display_name, email, active, membership_status) VALUES (9102, 'Regular Amy', 'score-amy@example.com', 1, 'regular')`),
    env.DB.prepare(`INSERT INTO people (id, display_name, email, active, membership_status) VALUES (9103, 'Member Bea', 'score-bea@example.com', 1, 'member')`),
    env.DB.prepare(`INSERT INTO people (id, display_name, email, active, membership_status) VALUES (9104, 'Visitor Cal', 'score-cal@example.com', 1, 'visitor')`),
    env.DB.prepare(`INSERT INTO people (id, display_name, email, active, membership_status) VALUES (9105, 'Inactive Dee', 'score-dee@example.com', 0, 'member')`),
  ]);
}

beforeEach(reset);

describe('activity score configuration persistence', () => {
  it('reads the seeded model exactly', async () => {
    expect(await getActivityScoreConfig(env.DB)).toEqual(defaults);
  });

  it('atomically saves a valid model and rejects a stale revision without partial dimension writes', async () => {
    const next: ActivityScoreConfig = {
      ...defaults,
      windowDays: 60,
      includedStatuses: ['visitor', 'regular', 'member'],
      activeThreshold: 80,
      watchThreshold: 50,
      dimensions: {
        group_attendance: { enabled: true, weight: 40, targetCount: null },
        serving: { enabled: true, weight: 40, targetCount: 4 },
        registration: { enabled: true, weight: 20, targetCount: 2 },
      },
    };
    const saved = await saveActivityScoreConfig(env.DB, next, 0, 9101);
    expect(saved).toMatchObject({ ...next, revision: 1 });

    const stale: ActivityScoreConfig = {
      ...next,
      dimensions: {
        group_attendance: { enabled: false, weight: 0, targetCount: null },
        serving: { enabled: true, weight: 100, targetCount: 9 },
        registration: { enabled: false, weight: 0, targetCount: 2 },
      },
    };
    await expect(saveActivityScoreConfig(env.DB, stale, 0, 9101)).rejects.toBeInstanceOf(ActivityScoreConflictError);
    expect(await getActivityScoreConfig(env.DB)).toEqual(saved);
  });

  it('rejects invalid config and actors before changing the stored model', async () => {
    await expect(saveActivityScoreConfig(env.DB, { ...defaults, windowDays: 45 } as never, 0, 9101)).rejects.toThrow(/configuration/i);
    await expect(saveActivityScoreConfig(env.DB, defaults, 0, 0)).rejects.toThrow(/configuration/i);
    expect(await getActivityScoreConfig(env.DB)).toEqual(defaults);
  });
});

describe('activity score evidence queries', () => {
  it('lists only live, active people in selected statuses with a strict limit', async () => {
    expect(await listEligibleActivityPeople(env.DB, ['regular', 'member'], 5_000)).toEqual([
      { personId: 9101, name: 'Actor', membershipStatus: 'member' },
      { personId: 9102, name: 'Regular Amy', membershipStatus: 'regular' },
      { personId: 9103, name: 'Member Bea', membershipStatus: 'member' },
    ]);
    await expect(listEligibleActivityPeople(env.DB, ['member'], 1)).rejects.toMatchObject({ code: 'activity_score_limit' });
  });

  it('counts explicit present/absent group rows on inclusive live occurrence bounds', async () => {
    await env.DB.prepare(`INSERT INTO groups (id, name) VALUES (9201, 'Group')`).run();
    await env.DB.prepare(`
      INSERT INTO group_events (id, group_id, title, starts_on, start_time, track_attendance)
      VALUES (9202, 9201, 'Meeting', '2026-05-01', '19:00', 1)
    `).run();
    await env.DB.prepare(`
      INSERT INTO group_members (id, group_id, person_id, display_name) VALUES
        (9203, 9201, 9102, 'Regular Amy'), (9204, 9201, 9103, 'Member Bea')
    `).run();
    for (const [id, date] of [[9210, '2026-05-31'], [9211, '2026-06-01'], [9212, '2026-06-30'], [9213, '2026-07-01']] as const) {
      await env.DB.prepare(`
        INSERT INTO group_event_occurrences (id, event_id, occurs_on, starts_at, ends_at)
        VALUES (?, 9202, ?, ? || ' 19:00:00', ? || ' 20:00:00')
      `).bind(id, date, date, date).run();
    }
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO group_attendance (occurrence_id, member_id, present) VALUES (9210, 9203, 1)`),
      env.DB.prepare(`INSERT INTO group_attendance (occurrence_id, member_id, present) VALUES (9211, 9203, 1)`),
      env.DB.prepare(`INSERT INTO group_attendance (occurrence_id, member_id, present) VALUES (9212, 9203, 0)`),
      env.DB.prepare(`INSERT INTO group_attendance (occurrence_id, member_id, present) VALUES (9213, 9203, 1)`),
      env.DB.prepare(`INSERT INTO group_attendance (occurrence_id, member_id, present) VALUES (9211, 9204, 0)`),
    ]);

    expect(await listGroupAttendanceEvidence(env.DB, '2026-06-01', '2026-06-30', 5_000)).toEqual([
      { personId: 9102, present: 1, opportunities: 2 },
      { personId: 9103, present: 0, opportunities: 1 },
    ]);
    await env.DB.prepare(`UPDATE group_members SET removed_at=datetime('now') WHERE id=9204`).run();
    expect(await listGroupAttendanceEvidence(env.DB, '2026-06-01', '2026-06-30', 5_000)).toEqual([
      { personId: 9102, present: 1, opportunities: 2 },
    ]);
  });

  it('counts only confirmed, non-deleted assignments on inclusive plan bounds', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO ministries (id, slug, category) VALUES (9301, 'score-ministry', 'care')`),
      env.DB.prepare(`INSERT INTO teams (id, ministry_id) VALUES (9302, 9301)`),
      env.DB.prepare(`INSERT INTO positions (id, team_id) VALUES (9303, 9302)`),
      env.DB.prepare(`INSERT INTO service_types (id) VALUES (9304)`),
    ]);
    for (const [id, date] of [[9310, '2026-05-31'], [9311, '2026-06-01'], [9312, '2026-06-30'], [9313, '2026-07-01']] as const) {
      await env.DB.prepare(`INSERT INTO plans (id, service_type_id, plan_date) VALUES (?, 9304, ?)`).bind(id, date).run();
    }
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO roster_assignments (plan_id, position_id, person_id, status) VALUES (9310, 9303, 9102, 'C')`),
      env.DB.prepare(`INSERT INTO roster_assignments (plan_id, position_id, person_id, status) VALUES (9311, 9303, 9102, 'C')`),
      env.DB.prepare(`INSERT INTO roster_assignments (plan_id, position_id, person_id, status) VALUES (9312, 9303, 9102, 'D')`),
      env.DB.prepare(`INSERT INTO roster_assignments (plan_id, position_id, person_id, status, deleted_at) VALUES (9312, 9303, 9103, 'C', datetime('now'))`),
      env.DB.prepare(`INSERT INTO roster_assignments (plan_id, position_id, person_id, status) VALUES (9313, 9303, 9103, 'C')`),
    ]);

    expect(await listServingEvidence(env.DB, '2026-06-01', '2026-06-30', 5_000)).toEqual([
      { personId: 9102, count: 1 },
    ]);
  });
});
