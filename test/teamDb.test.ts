// teamDb tests (workers project, live D1): teams directory summaries, roster
// mutations, application review (decided fields + membership + the pending-
// unique partial index), the potential-volunteers union with source badges,
// the matrix grid data, and the plans-index fill summary.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addTeamMember,
  createTeam,
  decideApplication,
  getMatrix,
  getTeam,
  listActivePeople,
  listMinistryOptions,
  listPendingApplicationsForTeams,
  listPlanFills,
  listPotentialVolunteers,
  listServiceTypes,
  listTeamMembers,
  listTeamPositions,
  listTeamSummaries,
  removeTeamMember,
  setTeamLeader,
} from '../src/lib/teamDb';

/** Delete every table this suite touches in FK-safe (child → parent) order. */
async function wipe(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM roster_assignments'),
    env.DB.prepare('DELETE FROM plan_positions'),
    env.DB.prepare('DELETE FROM plans'),
    env.DB.prepare('DELETE FROM team_applications'),
    env.DB.prepare('DELETE FROM person_interests'),
    env.DB.prepare('DELETE FROM gift_results'),
    env.DB.prepare('DELETE FROM position_i18n'),
    env.DB.prepare('DELETE FROM positions'),
    env.DB.prepare('DELETE FROM team_members'),
    env.DB.prepare('DELETE FROM team_i18n'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM ministry_i18n'),
    env.DB.prepare('DELETE FROM ministries'),
    env.DB.prepare('DELETE FROM service_type_i18n'),
    env.DB.prepare('DELETE FROM service_types'),
    env.DB.prepare('DELETE FROM people'),
  ]);
}

/** Standard fixture: a worship ministry/team with members, plans, and one AV team. */
async function seed(): Promise<void> {
  await wipe();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people (id, display_name, email, active) VALUES
      (1, 'Anna Leader', 'p1@example.com', 1), (2, 'Ben Member', 'p2@example.com', 1),
      (3, 'Cara Outside', 'p3@example.com', 1), (4, 'Dan Inactive', 'p4@example.com', 0),
      (5, 'Eve Gifted', 'p5@example.com', 1)`),
    env.DB.prepare(`INSERT INTO ministries (id, slug, category, active, sort) VALUES
      (1, 'worship', 'worship', 1, 1), (2, 'av-tech', 'av-tech', 1, 2)`),
    env.DB.prepare(`INSERT INTO ministry_i18n (ministry_id, locale, name, intro) VALUES
      (1, 'en', 'Worship', ''), (1, 'zh', '敬拜', ''), (2, 'en', 'AV', '')`),
    env.DB.prepare(`INSERT INTO teams (id, ministry_id, sort) VALUES (1, 1, 0), (2, 2, 1)`),
    env.DB.prepare(`INSERT INTO team_i18n (team_id, locale, name) VALUES
      (1, 'en', 'Worship Team'), (1, 'zh', '敬拜队'), (2, 'en', 'AV Team')`),
    env.DB.prepare(`INSERT INTO positions (id, team_id, sort) VALUES (1, 1, 0), (2, 1, 1), (3, 2, 0)`),
    env.DB.prepare(`INSERT INTO position_i18n (position_id, locale, name) VALUES
      (1, 'en', 'Vocalist'), (1, 'zh', '主唱'), (2, 'en', 'Pianist'), (3, 'en', 'Sound')`),
    env.DB.prepare(`INSERT INTO team_members (team_id, person_id, is_leader) VALUES
      (1, 1, 1), (1, 2, 0)`),
    env.DB.prepare(`INSERT INTO service_types (id, start_time, end_time, sort) VALUES
      (1, '09:30', '10:45', 0)`),
    env.DB.prepare(`INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES
      (1, 'en', 'Sunday Worship'), (1, 'zh', '主日崇拜')`),
    env.DB.prepare(`INSERT INTO plans (id, service_type_id, plan_date) VALUES
      (1, 1, '2030-06-02'), (2, 1, '2030-06-09')`),
    env.DB.prepare(`INSERT INTO plan_positions (plan_id, position_id, needed, open_signup) VALUES
      (1, 1, 2, 1), (1, 2, 1, 0), (2, 1, 1, 0)`),
    env.DB.prepare(`INSERT INTO roster_assignments (plan_id, position_id, person_id, status) VALUES
      (1, 1, 1, 'C'), (1, 1, 2, 'D'), (1, 2, 2, 'U')`),
  ]);
}

describe('teamDb', () => {
  beforeEach(seed);

  describe('listServiceTypes / getTeam / listTeamSummaries', () => {
    it('localizes names with an en fallback', async () => {
      const zh = await listServiceTypes(env.DB, 'zh');
      expect(zh.map((s) => s.name)).toEqual(['主日崇拜']);

      const team = await getTeam(env.DB, 1, 'zh');
      expect(team).toMatchObject({ name: '敬拜队', ministry_name: '敬拜', ministry_slug: 'worship', category: 'worship' });
      // Team 2 has no zh row → en fallback.
      const av = await getTeam(env.DB, 2, 'zh');
      expect(av!.name).toBe('AV Team');
      expect(await getTeam(env.DB, 99, 'en')).toBeNull();
    });

    it('summaries carry member/leader counts and future open-slot counts', async () => {
      const teams = await listTeamSummaries(env.DB, 'en');
      const worship = teams.find((tm) => tm.id === 1)!;
      expect(worship).toMatchObject({ name: 'Worship Team', member_count: 2, leader_count: 1 });
      // Plan 1 (2030-06-02) is in the future and position 1 is open_signup → 1 open slot row.
      expect(worship.open_slots).toBe(1);
      const av = teams.find((tm) => tm.id === 2)!;
      expect(av).toMatchObject({ member_count: 0, leader_count: 0, open_slots: 0 });
    });
  });

  describe('roster mutations', () => {
    it('addTeamMember is idempotent, remove deletes, setTeamLeader toggles', async () => {
      await addTeamMember(env.DB, 1, 3);
      await addTeamMember(env.DB, 1, 3); // second add is a no-op, not an error
      let members = await listTeamMembers(env.DB, 1);
      expect(members.map((m) => m.person_id).sort()).toEqual([1, 2, 3]);

      // An existing member's leader flag survives a duplicate add.
      await addTeamMember(env.DB, 1, 1);
      members = await listTeamMembers(env.DB, 1);
      expect(members.find((m) => m.person_id === 1)!.is_leader).toBe(1);

      await setTeamLeader(env.DB, 1, 3, true);
      members = await listTeamMembers(env.DB, 1);
      expect(members.find((m) => m.person_id === 3)!.is_leader).toBe(1);
      await setTeamLeader(env.DB, 1, 3, false);
      members = await listTeamMembers(env.DB, 1);
      expect(members.find((m) => m.person_id === 3)!.is_leader).toBe(0);

      await removeTeamMember(env.DB, 1, 3);
      members = await listTeamMembers(env.DB, 1);
      expect(members.map((m) => m.person_id).sort()).toEqual([1, 2]);
    });

    it('createTeam writes i18n names (zh optional → en fallback)', async () => {
      const id = await createTeam(env.DB, { ministryId: 2, nameEn: 'Stream Team' });
      expect((await getTeam(env.DB, id, 'zh'))!.name).toBe('Stream Team');
      const id2 = await createTeam(env.DB, { ministryId: null, nameEn: 'Ushers', nameZh: '招待' });
      expect((await getTeam(env.DB, id2, 'zh'))!.name).toBe('招待');
      expect((await getTeam(env.DB, id2, 'en'))!.ministry_name).toBeNull();
    });

    it('lists positions localized and active people only', async () => {
      const zhPositions = await listTeamPositions(env.DB, 1, 'zh');
      expect(zhPositions.map((p) => p.name)).toEqual(['主唱', 'Pianist']);
      const people = await listActivePeople(env.DB);
      expect(people.map((p) => p.id)).not.toContain(4); // inactive excluded
      const ministries = await listMinistryOptions(env.DB, 'zh');
      expect(ministries.map((m) => m.name)).toEqual(['敬拜', 'AV']);
    });
  });

  describe('applications', () => {
    async function apply(personId: number, teamId: number, positionId: number | null = 1): Promise<number> {
      const r = await env.DB
        .prepare(
          `INSERT INTO team_applications (person_id, team_id, position_id, message)
           VALUES (?, ?, ?, 'hi') ON CONFLICT DO NOTHING`,
        )
        .bind(personId, teamId, positionId)
        .run();
      return r.meta.last_row_id;
    }

    it('lists pending applications for the given teams with localized position names', async () => {
      const appId = await apply(3, 1);
      await apply(5, 2, 3);
      const apps = await listPendingApplicationsForTeams(env.DB, [1], 'zh');
      expect(apps).toHaveLength(1);
      expect(apps[0]).toMatchObject({ id: appId, person_name: 'Cara Outside', position_name: '主唱', status: 'P' });
      expect(await listPendingApplicationsForTeams(env.DB, [], 'en')).toEqual([]);
    });

    it('approve sets decided fields and adds the member; reject only decides', async () => {
      const approveId = await apply(3, 1);
      const decided = await decideApplication(env.DB, approveId, true, 'leader@example.com', 1);
      expect(decided).toEqual({ person_id: 3, team_id: 1 });
      const row = await env.DB
        .prepare('SELECT status, decided_by, decided_at FROM team_applications WHERE id = ?')
        .bind(approveId)
        .first<{ status: string; decided_by: string | null; decided_at: string | null }>();
      expect(row!.status).toBe('A');
      expect(row!.decided_by).toBe('leader@example.com');
      expect(row!.decided_at).not.toBeNull();
      expect((await listTeamMembers(env.DB, 1)).map((m) => m.person_id)).toContain(3);

      const rejectId = await apply(5, 1);
      await decideApplication(env.DB, rejectId, false, 'leader@example.com', 1);
      const rejected = await env.DB
        .prepare('SELECT status, decided_by, decided_at FROM team_applications WHERE id = ?')
        .bind(rejectId)
        .first<{ status: string; decided_by: string | null; decided_at: string | null }>();
      expect(rejected!.status).toBe('R');
      expect(rejected!.decided_by).toBe('leader@example.com');
      expect(rejected!.decided_at).not.toBeNull();
      expect((await listTeamMembers(env.DB, 1)).map((m) => m.person_id)).not.toContain(5);
    });

    it('refuses the wrong team, non-pending rows, and double-deciding', async () => {
      const appId = await apply(3, 1);
      // A leader of team 2 can't decide team 1's application.
      expect(await decideApplication(env.DB, appId, true, 'other@example.com', 2)).toBeNull();
      expect(await decideApplication(env.DB, appId, true, 'leader@example.com', 1)).not.toBeNull();
      // Already decided → null (no double-processing).
      expect(await decideApplication(env.DB, appId, false, 'leader@example.com', 1)).toBeNull();
      expect(
        (await env.DB.prepare('SELECT status FROM team_applications WHERE id = ?').bind(appId).first<{ status: string }>())!
          .status,
      ).toBe('A');
    });

    it('pending-unique: one pending row per person+team; re-apply allowed after a decision', async () => {
      await apply(3, 1);
      // Second pending insert for the same person+team hits the partial unique
      // index and is swallowed by ON CONFLICT DO NOTHING (no duplicate row).
      const dup = await env.DB
        .prepare(`INSERT INTO team_applications (person_id, team_id) VALUES (3, 1) ON CONFLICT DO NOTHING`)
        .run();
      expect(dup.meta.changes).toBe(0);
      const { results } = await env.DB
        .prepare(`SELECT id FROM team_applications WHERE person_id = 3 AND team_id = 1 AND status = 'P'`)
        .all();
      expect(results).toHaveLength(1);

      // After a rejection the pending slot frees up: a new application lands.
      const firstId = (results[0] as { id: number }).id;
      await decideApplication(env.DB, firstId, false, 'leader@example.com', 1);
      const again = await env.DB
        .prepare(`INSERT INTO team_applications (person_id, team_id) VALUES (3, 1) ON CONFLICT DO NOTHING`)
        .run();
      expect(again.meta.changes).toBe(1);
    });
  });

  describe('listPotentialVolunteers', () => {
    it('unions interest and latest-gift sources with per-source badges', async () => {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO person_interests (person_id, category) VALUES (3, 'worship'), (5, 'worship')`),
        env.DB.prepare(`INSERT INTO gift_results (person_id, top_gifts_json, recommended_json) VALUES
          (5, '[]', '["worship","children"]')`),
      ]);
      const list = await listPotentialVolunteers(env.DB, 'worship', 1);
      expect(list.map((p) => p.person_id)).toEqual([3, 5]);
      expect(list.find((p) => p.person_id === 3)).toMatchObject({ via_interest: 1, via_gift: 0 });
      expect(list.find((p) => p.person_id === 5)).toMatchObject({ via_interest: 1, via_gift: 1 });
    });

    it('honors only the most recent gift result and excludes members/inactive people', async () => {
      await env.DB.batch([
        // Current team members and inactive people never appear.
        env.DB.prepare(`INSERT INTO person_interests (person_id, category) VALUES (2, 'worship'), (4, 'worship')`),
        // Person 3's earlier result recommended worship, but the retake dropped it.
        env.DB.prepare(`INSERT INTO gift_results (id, person_id, top_gifts_json, recommended_json, created_at) VALUES
          (1, 3, '[]', '["worship"]', '2030-01-01 00:00:00'),
          (2, 3, '[]', '["children"]', '2030-02-01 00:00:00')`),
      ]);
      const list = await listPotentialVolunteers(env.DB, 'worship', 1);
      expect(list).toEqual([]);
    });
  });

  describe('getMatrix / listPlanFills', () => {
    it('returns plans, team-grouped rows, needs, and live assignments', async () => {
      const m = await getMatrix(env.DB, 1, '2030-06-01', 8, 'zh');
      expect(m.plans.map((p) => p.plan_date)).toEqual(['2030-06-02', '2030-06-09']);
      expect(m.rows.map((r) => r.position_name)).toEqual(['主唱', 'Pianist']);
      expect(m.rows.every((r) => r.team_name === '敬拜队')).toBe(true);
      expect(m.needs).toHaveLength(3);
      // Declined rows stay visible in the grid (struck through by the page).
      expect(m.assignments.map((a) => [a.position_id, a.person_id, a.status])).toEqual([
        [1, 1, 'C'],
        [1, 2, 'D'],
        [2, 2, 'U'],
      ]);
      const empty = await getMatrix(env.DB, 1, '2031-01-01', 8, 'en');
      expect(empty).toEqual({ plans: [], rows: [], needs: [], assignments: [] });
    });

    it('fill summary counts non-declined assignees capped per position', async () => {
      // Overfill position 2 (needed 1) with a second non-declined assignee.
      await env.DB
        .prepare(`INSERT INTO roster_assignments (plan_id, position_id, person_id, status) VALUES (1, 2, 3, 'U')`)
        .run();
      const fills = await listPlanFills(env.DB, [1, 2]);
      // Plan 1: pos1 needs 2 (1 active — the 'D' row doesn't count), pos2 needs 1
      // (2 active, capped at 1) → 2/3 filled. Plan 2 has a need but no assignees.
      expect(fills.find((f) => f.plan_id === 1)).toMatchObject({ needed: 3, filled: 2 });
      expect(fills.find((f) => f.plan_id === 2)).toMatchObject({ needed: 1, filled: 0 });
      expect(await listPlanFills(env.DB, [])).toEqual([]);
    });
  });
});
