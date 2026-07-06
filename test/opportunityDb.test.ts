// opportunityDb aggregations (workers project, live D1). The board is public and
// person-agnostic, so these assert the remaining/exclusion math directly: a slot
// counts only future, non-deleted, open-signup positions that still have a free
// spot (needed − non-declined, non-soft-deleted assignees > 0), grouped
// team → position and capped at the next 3 dates per position.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { listApplicationTeams, listOpportunitySlots } from '../src/lib/opportunityDb';
import { addDays, todayInTz } from '../src/lib/dates';

const TZ = 'America/Chicago';
const today = todayInTz(TZ);
const future = (n: number) => addDays(today, n);
const past = (n: number) => addDays(today, -n);

async function wipe(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM roster_assignments'),
    env.DB.prepare('DELETE FROM plan_positions'),
    env.DB.prepare('DELETE FROM plans'),
    env.DB.prepare('DELETE FROM position_i18n'),
    env.DB.prepare('DELETE FROM positions'),
    env.DB.prepare('DELETE FROM team_members'),
    env.DB.prepare('DELETE FROM team_i18n'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM service_type_i18n'),
    env.DB.prepare('DELETE FROM service_types'),
    env.DB.prepare('DELETE FROM ministry_i18n'),
    env.DB.prepare('DELETE FROM ministries'),
    env.DB.prepare('DELETE FROM people'),
  ]);
}

/**
 * Fixture. Team 1 (Worship, ministry with an icon) has position 1 (Vocalist) on
 * FOUR future open plans and position 2 (Pianist) closed + position 4 (Usher)
 * full; team 2 (AV) has position 3 (Sound) on one future open plan. A past open
 * plan for position 1 must be excluded.
 */
async function seed(): Promise<void> {
  await wipe();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people (id, display_name, email) VALUES
      (1, 'Alice', 'a@example.com'), (2, 'Bob', 'b@example.com'), (3, 'Cara', 'c@example.com')`),
    env.DB.prepare(`INSERT INTO ministries (id, slug, category, icon, sort) VALUES (1, 'worship', 'worship', '🎵', 0)`),
    env.DB.prepare(`INSERT INTO ministry_i18n (ministry_id, locale, name) VALUES (1, 'en', 'Worship Ministry'), (1, 'zh', '敬拜事工')`),
    env.DB.prepare(`INSERT INTO teams (id, ministry_id, sort) VALUES (1, 1, 0), (2, NULL, 1)`),
    env.DB.prepare(`INSERT INTO team_i18n (team_id, locale, name) VALUES
      (1, 'en', 'Worship'), (1, 'zh', '敬拜'), (2, 'en', 'AV'), (2, 'zh', '音响')`),
    env.DB.prepare(`INSERT INTO positions (id, team_id, sort) VALUES (1, 1, 0), (2, 1, 1), (4, 1, 2), (3, 2, 0)`),
    env.DB.prepare(`INSERT INTO position_i18n (position_id, locale, name) VALUES
      (1, 'en', 'Vocalist'), (1, 'zh', '主唱'), (2, 'en', 'Pianist'), (2, 'zh', '钢琴'),
      (4, 'en', 'Usher'), (4, 'zh', '招待'), (3, 'en', 'Sound'), (3, 'zh', '音控')`),
    env.DB.prepare(`INSERT INTO team_members (team_id, person_id, is_leader) VALUES (1, 1, 1), (1, 2, 0), (2, 3, 1)`),
    env.DB.prepare(`INSERT INTO service_types (id, sort) VALUES (1, 0)`),
    env.DB.prepare(`INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES (1, 'en', 'Sunday'), (1, 'zh', '主日')`),
  ]);
  await env.DB.batch([
    // 4 future plans + 1 past + carrier plan for the closed/full positions.
    env.DB.prepare(`INSERT INTO plans (id, service_type_id, plan_date) VALUES
      (100, 1, ?), (101, 1, ?), (102, 1, ?), (103, 1, ?), (200, 1, ?)`).bind(
      future(7),
      future(14),
      future(21),
      future(28),
      past(7),
    ),
    // Vocalist(1): 4 future open dates. Pianist(2): closed. Usher(4): open→full.
    // Sound(3, team 2): open. Vocalist past plan (200): excluded.
    env.DB.prepare(`INSERT INTO plan_positions (plan_id, position_id, needed, open_signup) VALUES
      (100, 1, 2, 1), (101, 1, 2, 1), (102, 1, 2, 1), (103, 1, 2, 1),
      (100, 2, 1, 0),
      (100, 4, 1, 1),
      (100, 3, 1, 1),
      (200, 1, 1, 1)`),
    // plan 100 Vocalist (needed 2): one confirmed (counts), one declined and one
    // soft-deleted (neither counts) → taken 1, remaining 1. Usher: one confirmed → full.
    env.DB.prepare(`INSERT INTO roster_assignments (plan_id, position_id, person_id, status, deleted_at) VALUES
      (100, 1, 1, 'C', NULL), (100, 1, 2, 'D', NULL), (100, 1, 3, 'U', datetime('now')),
      (100, 4, 1, 'C', NULL)`),
  ]);
}
beforeEach(seed);

describe('listOpportunitySlots', () => {
  it('groups open future slots by team → position, soonest dates first', async () => {
    const teams = await listOpportunitySlots(env.DB, 'en');
    expect(teams.map((t) => t.team_id)).toEqual([1, 2]); // team sort order

    const worship = teams[0];
    expect(worship).toMatchObject({ team_name: 'Worship', ministry_name: 'Worship Ministry', ministry_icon: '🎵' });
    // Only Vocalist qualifies: Pianist is closed, Usher is full → both dropped.
    expect(worship.positions.map((p) => p.position_name)).toEqual(['Vocalist']);

    const av = teams[1];
    expect(av).toMatchObject({ team_name: 'AV', ministry_name: null });
    expect(av.positions.map((p) => p.position_name)).toEqual(['Sound']);
  });

  it('caps each position at the next 3 dates and excludes past plans', async () => {
    const [worship] = await listOpportunitySlots(env.DB, 'en');
    const vocalist = worship.positions[0];
    // 4 future open dates exist, but the board shows only the soonest 3; the past
    // plan (200) never appears.
    expect(vocalist.dates.map((d) => d.plan_date)).toEqual([future(7), future(14), future(21)]);
  });

  it('remaining excludes declined and soft-deleted assignees', async () => {
    const [worship] = await listOpportunitySlots(env.DB, 'en');
    const byDate = new Map(worship.positions[0].dates.map((d) => [d.plan_date, d.remaining]));
    expect(byDate.get(future(7))).toBe(1); // needed 2 − 1 confirmed (declined + deleted ignored)
    expect(byDate.get(future(14))).toBe(2); // needed 2 − 0
  });

  it('drops a position with no free spot (remaining 0)', async () => {
    const [worship] = await listOpportunitySlots(env.DB, 'en');
    expect(worship.positions.some((p) => p.position_name === 'Usher')).toBe(false);
  });

  it('excludes a closed position even on a future plan', async () => {
    const [worship] = await listOpportunitySlots(env.DB, 'en');
    expect(worship.positions.some((p) => p.position_name === 'Pianist')).toBe(false);
  });

  it('localizes names to the requested locale', async () => {
    const [worship] = await listOpportunitySlots(env.DB, 'zh');
    expect(worship.team_name).toBe('敬拜');
    expect(worship.positions[0].position_name).toBe('主唱');
    expect(worship.positions[0].dates[0].service_type_name).toBe('主日');
  });
});

describe('listApplicationTeams', () => {
  it('lists active teams with ministry, leader count and position chips', async () => {
    const teams = await listApplicationTeams(env.DB, 'en');
    expect(teams.map((t) => t.team_id)).toEqual([1, 2]);
    expect(teams[0]).toMatchObject({
      team_name: 'Worship',
      ministry_name: 'Worship Ministry',
      ministry_icon: '🎵',
      leader_count: 1,
    });
    expect(teams[0].positions).toEqual(['Vocalist', 'Pianist', 'Usher']); // position sort order
    expect(teams[1]).toMatchObject({ team_name: 'AV', ministry_name: null, leader_count: 1 });
    expect(teams[1].positions).toEqual(['Sound']);
  });

  it('excludes soft-deleted teams', async () => {
    await env.DB.prepare(`UPDATE teams SET deleted_at = datetime('now') WHERE id = 2`).run();
    const teams = await listApplicationTeams(env.DB, 'en');
    expect(teams.map((t) => t.team_id)).toEqual([1]);
  });
});
