// myDb person-scoped volunteer queries (workers project, live D1): my-schedule
// assignment filtering + localization, blockout add (recurrence materialization
// sharing one group) / delete / series-delete person scoping, interests replace
// semantics, latest-gift selection, and the person's application list.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addBlockout,
  deleteBlockout,
  deleteBlockoutSeries,
  getLatestGiftResult,
  listApplicationsByPerson,
  listBlockouts,
  listPersonAssignments,
  listPersonServingHistory,
  listPersonTeams,
  listPersonInterests,
  setPersonInterests,
} from '../src/lib/myDb';
import type { BlockoutInput } from '../src/lib/validate';

const blockoutOf = (over: Partial<BlockoutInput> = {}): BlockoutInput => ({
  startDate: '2030-03-01',
  endDate: '2030-03-01',
  startTime: null,
  endTime: null,
  reason: null,
  repeat: 'none',
  count: 1,
  ...over,
});

async function wipe(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM roster_assignments'),
    env.DB.prepare('DELETE FROM plan_positions'),
    env.DB.prepare('DELETE FROM blockout_dates'),
    env.DB.prepare('DELETE FROM team_applications'),
    env.DB.prepare('DELETE FROM person_interests'),
    env.DB.prepare('DELETE FROM gift_results'),
    env.DB.prepare('DELETE FROM plans'),
    env.DB.prepare('DELETE FROM position_i18n'),
    env.DB.prepare('DELETE FROM positions'),
    env.DB.prepare('DELETE FROM team_members'),
    env.DB.prepare('DELETE FROM team_i18n'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM service_type_i18n'),
    env.DB.prepare('DELETE FROM service_types'),
    env.DB.prepare('DELETE FROM people'),
  ]);
}

beforeEach(async () => {
  await wipe();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people (id, display_name, email) VALUES
      (1, 'Ana', 'ana@example.com'), (2, 'Ben', 'ben@example.com')`),
    env.DB.prepare(`INSERT INTO teams (id) VALUES (1)`),
    env.DB.prepare(`INSERT INTO team_i18n (team_id, locale, name) VALUES (1, 'en', 'Worship Team'), (1, 'zh', '敬拜队')`),
    env.DB.prepare(`INSERT INTO team_members (team_id, person_id, is_leader) VALUES (1, 1, 1)`),
    env.DB.prepare(`INSERT INTO positions (id, team_id) VALUES (1, 1)`),
    env.DB.prepare(`INSERT INTO position_i18n (position_id, locale, name) VALUES (1, 'en', 'Vocalist'), (1, 'zh', '歌手')`),
    env.DB.prepare(`INSERT INTO service_types (id, start_time, end_time) VALUES (1, '09:30', '10:45')`),
    env.DB.prepare(`INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES (1, 'en', 'English Service')`),
    env.DB.prepare(`INSERT INTO plans (id, service_type_id, plan_date) VALUES
      (1, 1, '2030-01-05'), (2, 1, '2030-01-12'), (3, 1, '2029-12-01')`),
    env.DB.prepare(`INSERT INTO roster_assignments (id, plan_id, position_id, person_id, status) VALUES
      (1, 1, 1, 1, 'U'), (2, 2, 1, 1, 'C'), (3, 3, 1, 1, 'C'), (4, 1, 1, 2, 'C')`),
  ]);
});

describe('listPersonAssignments (my-schedule filtering)', () => {
  it('returns only this person’s live rows on/after fromDate, localized, soonest first', async () => {
    const rows = await listPersonAssignments(env.DB, 1, '2030-01-01', 'zh');
    expect(rows.map((r) => r.id)).toEqual([1, 2]); // past plan 3 excluded, Ben's row excluded
    expect(rows[0]).toMatchObject({
      plan_id: 1,
      plan_date: '2030-01-05',
      status: 'U',
      position_name: '歌手',
      team_name: '敬拜队',
      service_type_name: 'English Service', // zh missing → en fallback
    });
  });

  it('excludes soft-deleted assignments and soft-deleted plans', async () => {
    await env.DB.prepare(`UPDATE roster_assignments SET deleted_at = datetime('now') WHERE id = 1`).run();
    await env.DB.prepare(`UPDATE plans SET deleted_at = datetime('now') WHERE id = 2`).run();
    expect(await listPersonAssignments(env.DB, 1, '2030-01-01', 'en')).toHaveLength(0);
  });
});

describe('blockouts', () => {
  it('repeat none inserts one row with a NULL recurrence_group', async () => {
    expect(await addBlockout(env.DB, 1, blockoutOf({ reason: 'trip' }))).toBe(1);
    const rows = await listBlockouts(env.DB, 1, '2000-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      person_id: 1, start_date: '2030-03-01', end_date: '2030-03-01', reason: 'trip', recurrence_group: null,
    });
  });

  it('weekly recurrence materializes N rows 7 days apart sharing one group (range preserved)', async () => {
    await addBlockout(env.DB, 1, blockoutOf({ endDate: '2030-03-02', repeat: 'weekly', count: 3 }));
    const rows = await listBlockouts(env.DB, 1, '2000-01-01');
    expect(rows.map((r) => [r.start_date, r.end_date])).toEqual([
      ['2030-03-01', '2030-03-02'],
      ['2030-03-08', '2030-03-09'],
      ['2030-03-15', '2030-03-16'],
    ]);
    const groups = new Set(rows.map((r) => r.recurrence_group));
    expect(groups.size).toBe(1);
    expect([...groups][0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('biweekly recurrence shifts by 14 days and keeps the time pair on every row', async () => {
    await addBlockout(env.DB, 1, blockoutOf({ startTime: '09:00', endTime: '11:00', repeat: 'biweekly', count: 2 }));
    const rows = await listBlockouts(env.DB, 1, '2000-01-01');
    expect(rows.map((r) => r.start_date)).toEqual(['2030-03-01', '2030-03-15']);
    for (const r of rows) expect(r).toMatchObject({ start_time: '09:00', end_time: '11:00' });
  });

  it('deleteBlockout only deletes the owner’s row', async () => {
    await addBlockout(env.DB, 1, blockoutOf());
    const [row] = await listBlockouts(env.DB, 1, '2000-01-01');
    await deleteBlockout(env.DB, 2, row.id); // wrong person → no-op
    expect(await listBlockouts(env.DB, 1, '2000-01-01')).toHaveLength(1);
    await deleteBlockout(env.DB, 1, row.id);
    expect(await listBlockouts(env.DB, 1, '2000-01-01')).toHaveLength(0);
  });

  it('deleteBlockoutSeries removes only the owner’s rows for that group', async () => {
    await addBlockout(env.DB, 1, blockoutOf({ repeat: 'weekly', count: 4 }));
    const group = (await listBlockouts(env.DB, 1, '2000-01-01'))[0].recurrence_group!;
    // Another person's row sharing the same group id must survive.
    await env.DB
      .prepare(`INSERT INTO blockout_dates (person_id, start_date, end_date, recurrence_group) VALUES (2, '2030-03-01', '2030-03-01', ?)`)
      .bind(group)
      .run();

    await deleteBlockoutSeries(env.DB, 2, 'not-a-real-group'); // unknown group → no-op
    expect(await listBlockouts(env.DB, 1, '2000-01-01')).toHaveLength(4);

    await deleteBlockoutSeries(env.DB, 1, group);
    expect(await listBlockouts(env.DB, 1, '2000-01-01')).toHaveLength(0);
    expect(await listBlockouts(env.DB, 2, '2000-01-01')).toHaveLength(1);
  });

  it('listBlockouts hides ranges that ended before fromDate', async () => {
    await addBlockout(env.DB, 1, blockoutOf({ startDate: '2030-03-01', endDate: '2030-03-05' }));
    expect(await listBlockouts(env.DB, 1, '2030-03-05')).toHaveLength(1); // still ending today
    expect(await listBlockouts(env.DB, 1, '2030-03-06')).toHaveLength(0);
  });
});

describe('interests & gifts', () => {
  it('setPersonInterests replaces the whole set (dedupe included)', async () => {
    await setPersonInterests(env.DB, 1, ['worship', 'care', 'worship']);
    expect(await listPersonInterests(env.DB, 1)).toEqual(['care', 'worship']);
    await setPersonInterests(env.DB, 1, ['youth']);
    expect(await listPersonInterests(env.DB, 1)).toEqual(['youth']);
    await setPersonInterests(env.DB, 1, []);
    expect(await listPersonInterests(env.DB, 1)).toEqual([]);
  });

  it('getLatestGiftResult returns the newest row with parsed JSON (null when none)', async () => {
    expect(await getLatestGiftResult(env.DB, 1)).toBeNull();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO gift_results (person_id, top_gifts_json, recommended_json, created_at)
        VALUES (1, '["service"]', '["care"]', '2030-01-01 00:00:00')`),
      env.DB.prepare(`INSERT INTO gift_results (person_id, top_gifts_json, recommended_json, created_at)
        VALUES (1, '["teaching","mercy"]', '["worship"]', '2030-02-01 00:00:00')`),
    ]);
    const latest = await getLatestGiftResult(env.DB, 1);
    expect(latest).toMatchObject({ top_gifts: ['teaching', 'mercy'], recommended: ['worship'] });
  });
});

describe('teams / history / applications', () => {
  it('listPersonTeams returns localized names with the leader flag', async () => {
    expect(await listPersonTeams(env.DB, 1, 'zh')).toEqual([{ team_id: 1, name: '敬拜队', is_leader: 1 }]);
    expect(await listPersonTeams(env.DB, 2, 'en')).toEqual([]);
  });

  it('listPersonServingHistory returns every live row, newest first', async () => {
    const rows = await listPersonServingHistory(env.DB, 1, 'en');
    expect(rows.map((r) => r.plan_date)).toEqual(['2030-01-12', '2030-01-05', '2029-12-01']);
    expect(rows[0]).toMatchObject({ position_name: 'Vocalist', team_name: 'Worship Team', ministry_name: null });
  });

  it('listApplicationsByPerson lists only that person’s applications, newest first', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO team_applications (person_id, team_id, position_id, status, created_at)
        VALUES (1, 1, 1, 'A', '2030-01-01 00:00:00')`),
      env.DB.prepare(`INSERT INTO team_applications (person_id, team_id, status, created_at)
        VALUES (1, 1, 'P', '2030-02-01 00:00:00')`),
      env.DB.prepare(`INSERT INTO team_applications (person_id, team_id, status) VALUES (2, 1, 'P')`),
    ]);
    const rows = await listApplicationsByPerson(env.DB, 1, 'zh');
    expect(rows.map((r) => r.status)).toEqual(['P', 'A']);
    expect(rows[0]).toMatchObject({ team_name: '敬拜队', position_name: null });
    expect(rows[1].position_name).toBe('歌手');
  });
});
