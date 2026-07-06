// planDb scheduling-engine tests (workers project, live D1). The engine semantics
// are ported from dcfc-serve/test/planDb.test.ts, adapted to church-cms: i18n
// names (team/position/service_type via *_i18n), no congregation, object-param
// signatures with string-union results, getConflicts(personId, planId). The
// slice-3 respondToAssignment contract is exercised unchanged at the bottom.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assignPerson,
  canEditPosition,
  claimOpenSlot,
  createPlan,
  ensureWeeklyPlans,
  getAssignmentPositionId,
  getConflicts,
  getPlan,
  getTeamAvailability,
  listOpenSlotsForPerson,
  listPlans,
  removeAssignment,
  respondToAssignment,
  setPlanPosition,
} from '../src/lib/planDb';
import { addDays, todayInTz } from '../src/lib/dates';
import type { SessionUser } from '../src/lib/types';

const asUser = (
  id: number,
  opts: { member?: number[]; leader?: number[]; admin?: boolean } = {},
): SessionUser => ({
  id,
  email: `p${id}@example.com`,
  displayName: `P${id}`,
  role: opts.admin ? 'admin' : 'member',
  isAdmin: !!opts.admin,
  isEditor: false,
  memberTeamIds: opts.member ?? [],
  leaderTeamIds: opts.leader ?? [],
  lang: null,
});

/** Delete every scheduling table in FK-safe (child → parent) order. */
async function wipe(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM roster_assignments'),
    env.DB.prepare('DELETE FROM plan_positions'),
    env.DB.prepare('DELETE FROM blockout_dates'),
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

/** Wipe every scheduling table and lay down a standard fixture. */
async function seed(): Promise<void> {
  await wipe();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people (id, display_name, email) VALUES
      (1, 'Leader', 'p1@example.com'), (2, 'Vol A', 'p2@example.com'),
      (3, 'Vol B', 'p3@example.com'), (4, 'Outsider', 'p4@example.com')`),
    env.DB.prepare(`INSERT INTO teams (id, ministry_id, sort) VALUES (1, NULL, 0), (2, NULL, 1)`),
    env.DB.prepare(`INSERT INTO team_i18n (team_id, locale, name) VALUES
      (1, 'en', 'Worship'), (1, 'zh', '敬拜'), (2, 'en', 'AV'), (2, 'zh', '音响')`),
    env.DB.prepare(`INSERT INTO positions (id, team_id, sort) VALUES (1, 1, 0), (2, 1, 1), (3, 2, 0)`),
    env.DB.prepare(`INSERT INTO position_i18n (position_id, locale, name) VALUES
      (1, 'en', 'Vocalist'), (1, 'zh', '主唱'), (2, 'en', 'Pianist'), (2, 'zh', '钢琴'),
      (3, 'en', 'Sound'), (3, 'zh', '音控')`),
    env.DB.prepare(`INSERT INTO team_members (team_id, person_id, is_leader) VALUES
      (1, 1, 1), (1, 2, 0), (1, 3, 0), (2, 3, 0)`),
    env.DB.prepare(`INSERT INTO service_types (id, start_time, end_time, sort) VALUES
      (1, NULL, NULL, 0), (2, NULL, NULL, 1)`),
    env.DB.prepare(`INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES
      (1, 'en', 'Chinese'), (1, 'zh', '中文'), (2, 'en', 'English'), (2, 'zh', '英文')`),
    env.DB.prepare(`INSERT INTO plans (id, service_type_id, plan_date) VALUES
      (1, 1, '2030-06-02'), (2, 2, '2030-06-02')`),
    env.DB.prepare(`INSERT INTO plan_positions (plan_id, position_id, needed, open_signup) VALUES
      (1, 1, 2, 1), (1, 2, 1, 0), (2, 3, 1, 1)`),
    env.DB.prepare(`INSERT INTO blockout_dates (person_id, start_date, end_date, reason) VALUES
      (2, '2030-06-01', '2030-06-03', 'travel')`),
  ]);
}

async function assignmentIdOf(planId: number, positionId: number, personId: number): Promise<number> {
  const row = await env.DB
    .prepare('SELECT id FROM roster_assignments WHERE plan_id = ? AND position_id = ? AND person_id = ?')
    .bind(planId, positionId, personId)
    .first<{ id: number }>();
  return row!.id;
}

describe('planDb engine', () => {
  beforeEach(seed);

  describe('canEditPosition', () => {
    it('admits admins, team leaders (own team only), and rejects plain members', async () => {
      expect(await canEditPosition(env.DB, asUser(9, { admin: true }), 1)).toBe(true);
      expect(await canEditPosition(env.DB, asUser(1, { member: [1], leader: [1] }), 1)).toBe(true); // pos1 → team1
      expect(await canEditPosition(env.DB, asUser(1, { member: [1], leader: [1] }), 3)).toBe(false); // pos3 → team2
      expect(await canEditPosition(env.DB, asUser(2, { member: [1] }), 1)).toBe(false); // member, not leader
    });
  });

  describe('ensureWeeklyPlans', () => {
    // 2030-06-05 is a Wednesday, so generation starts at Sunday 2030-06-09.
    const now = new Date('2030-06-05T12:00:00-05:00');

    it('creates weekly plans, copies needs from the latest prior plan, and is idempotent', async () => {
      const created = await ensureWeeklyPlans(env.DB, 1, 0, '2030-06-23', now);
      expect(created).toBe(3); // 06-09, 06-16, 06-23
      const plan = await env.DB
        .prepare(`SELECT id FROM plans WHERE service_type_id = 1 AND plan_date = '2030-06-16'`)
        .first<{ id: number }>();
      const { results: needs } = await env.DB
        .prepare('SELECT position_id, needed FROM plan_positions WHERE plan_id = ? ORDER BY position_id')
        .bind(plan!.id)
        .all<{ position_id: number; needed: number }>();
      expect(needs.map((n) => [n.position_id, n.needed])).toEqual([
        [1, 2],
        [2, 1],
      ]);

      const again = await ensureWeeklyPlans(env.DB, 1, 0, '2030-06-23', now);
      expect(again).toBe(0);
      const { results: dupes } = await env.DB
        .prepare(`SELECT plan_date, COUNT(*) AS n FROM plans WHERE service_type_id = 1 GROUP BY plan_date HAVING n > 1`)
        .all();
      expect(dupes).toEqual([]);
    });

    it('clamps the horizon to +370 days', async () => {
      const created = await ensureWeeklyPlans(env.DB, 1, 0, '2099-01-01', now);
      const cap = addDays(todayInTz('America/Chicago', now), 370);
      const max = await env.DB
        .prepare('SELECT MAX(plan_date) AS m FROM plans WHERE service_type_id = 1')
        .first<{ m: string }>();
      expect(created).toBeGreaterThan(45);
      expect(max!.m <= cap).toBe(true);
      expect(max!.m > '2031-01-01').toBe(true); // still generated roughly a year out
    });
  });

  describe('getConflicts', () => {
    it('detects blockout overlap edges inclusively', async () => {
      const start = await createPlan(env.DB, { serviceTypeId: 1, planDate: '2030-06-01' });
      const end = await createPlan(env.DB, { serviceTypeId: 1, planDate: '2030-06-03' });
      const outside = await createPlan(env.DB, { serviceTypeId: 1, planDate: '2030-06-04' });
      expect(await getConflicts(env.DB, 2, start)).toHaveLength(1); // start edge
      expect(await getConflicts(env.DB, 2, end)).toHaveLength(1); // end edge
      expect(await getConflicts(env.DB, 2, outside)).toHaveLength(0); // outside
    });

    it('detects same-date double booking, including same-plan other positions, excluding declined', async () => {
      expect(await assignPerson(env.DB, { planId: 1, positionId: 2, personId: 3, assignedBy: 1 })).toBe('ok');
      // Viewing from plan 2 (English, same date) surfaces the plan-1 (Chinese) booking.
      expect(await getConflicts(env.DB, 3, 2)).toEqual([{ kind: 'double', detail: 'Chinese — Pianist' }]);
      // Viewing from plan 1 itself: a DIFFERENT position on the SAME plan is still
      // a double (the exact target slot is guarded by duplicate/taken upstream).
      expect(await getConflicts(env.DB, 3, 1)).toEqual([{ kind: 'double', detail: 'Chinese — Pianist' }]);

      const id = await assignmentIdOf(1, 2, 3);
      await respondToAssignment(env.DB, id, 3, 'decline', 'busy');
      expect(await getConflicts(env.DB, 3, 2)).toEqual([]); // declined ≠ conflict
      expect(await getConflicts(env.DB, 3, 1)).toEqual([]);
    });

    it('auto-resolves a partial blockout that does not overlap the service time', async () => {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO service_types (id, start_time, end_time) VALUES
          (10, '14:00', '15:00'), (11, '09:00', '11:00'), (12, NULL, NULL)`),
        env.DB.prepare(
          `INSERT INTO blockout_dates (person_id, start_date, end_date, start_time, end_time)
           VALUES (4, '2030-07-07', '2030-07-07', '08:00', '10:00')`,
        ),
      ]);
      const noOverlap = await createPlan(env.DB, { serviceTypeId: 10, planDate: '2030-07-07' });
      const overlap = await createPlan(env.DB, { serviceTypeId: 11, planDate: '2030-07-07' });
      const untimed = await createPlan(env.DB, { serviceTypeId: 12, planDate: '2030-07-07' });
      expect(await getConflicts(env.DB, 4, noOverlap)).toEqual([]); // 14:00–15:00 vs 08:00–10:00
      const clash = await getConflicts(env.DB, 4, overlap); // 09:00–11:00 overlaps
      expect(clash).toHaveLength(1);
      expect(clash[0].kind).toBe('blockout');
      expect(await getConflicts(env.DB, 4, untimed)).toHaveLength(1); // no service time → still warns
    });
  });

  describe('assignPerson', () => {
    it('returns "conflicts" unless forced', async () => {
      expect(await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 2, assignedBy: 1 })).toBe('conflicts');
      expect(await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 2, assignedBy: 1, force: true })).toBe('ok');
    });

    it('enforces the needed cap counting non-declined assignees', async () => {
      expect(await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 2, assignedBy: 1, force: true })).toBe('ok');
      expect(await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 3, assignedBy: 1, force: true })).toBe('ok');
      expect(await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 1, assignedBy: 1, force: true })).toBe('full');
    });

    it('reports "duplicate" for an already-active assignment', async () => {
      expect(await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 3, assignedBy: 1, force: true })).toBe('ok');
      expect(await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 3, assignedBy: 1, force: true })).toBe('duplicate');
    });

    it('flags a same-plan different-position double as "conflicts" unless forced', async () => {
      expect(await assignPerson(env.DB, { planId: 1, positionId: 2, personId: 3, assignedBy: 1 })).toBe('ok');
      // Same plan, different position: a double-booking warning, not a duplicate.
      expect(await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 3, assignedBy: 1 })).toBe('conflicts');
      expect(await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 3, assignedBy: 1, force: true })).toBe('ok');
    });

    it('revives a soft-deleted assignment on re-assign (status back to U)', async () => {
      expect(await assignPerson(env.DB, { planId: 1, positionId: 2, personId: 3, assignedBy: 1 })).toBe('ok');
      const id = await assignmentIdOf(1, 2, 3);
      await removeAssignment(env.DB, id);
      expect(await assignPerson(env.DB, { planId: 1, positionId: 2, personId: 3, assignedBy: 1 })).toBe('ok');
      const row = await env.DB
        .prepare('SELECT status, deleted_at FROM roster_assignments WHERE id = ?')
        .bind(id)
        .first<{ status: string; deleted_at: string | null }>();
      expect(row).toEqual({ status: 'U', deleted_at: null });
    });

    it('revives a declined assignment on re-assign (status back to U, reason cleared)', async () => {
      expect(await assignPerson(env.DB, { planId: 1, positionId: 2, personId: 3, assignedBy: 1 })).toBe('ok');
      const id = await assignmentIdOf(1, 2, 3);
      expect(await respondToAssignment(env.DB, id, 3, 'decline', 'busy')).toEqual({ ok: true });
      // Declined is not 'duplicate' — re-assign revives the same row as a fresh request.
      expect(await assignPerson(env.DB, { planId: 1, positionId: 2, personId: 3, assignedBy: 1 })).toBe('ok');
      const row = await env.DB
        .prepare('SELECT status, decline_reason, deleted_at FROM roster_assignments WHERE id = ?')
        .bind(id)
        .first<{ status: string; decline_reason: string | null; deleted_at: string | null }>();
      expect(row).toEqual({ status: 'U', decline_reason: null, deleted_at: null });
    });
  });

  describe('claimOpenSlot', () => {
    it('rejects non-members', async () => {
      // person 4 is not a member of team 2 (which owns position 3).
      expect(await claimOpenSlot(env.DB, { planId: 2, positionId: 3, personId: 4 })).toBe('not_member');
    });

    it('rejects a closed (non-open-signup) slot', async () => {
      // position 2 is open_signup=0; person 3 is a member of its team 1.
      expect(await claimOpenSlot(env.DB, { planId: 1, positionId: 2, personId: 3 })).toBe('closed');
    });

    it('claims an open slot as a confirmed self-signup, then rejects a duplicate', async () => {
      expect(await claimOpenSlot(env.DB, { planId: 2, positionId: 3, personId: 3 })).toBe('ok');
      const row = await env.DB
        .prepare(`SELECT status, is_signup FROM roster_assignments WHERE plan_id = 2 AND position_id = 3 AND person_id = 3`)
        .first<{ status: string; is_signup: number }>();
      expect(row).toEqual({ status: 'C', is_signup: 1 });
      expect(await claimOpenSlot(env.DB, { planId: 2, positionId: 3, personId: 3 })).toBe('taken');
    });

    it('rejects when the slot is already full', async () => {
      expect(await claimOpenSlot(env.DB, { planId: 2, positionId: 3, personId: 3 })).toBe('ok');
      await env.DB.prepare(`INSERT INTO team_members (team_id, person_id) VALUES (2, 4)`).run();
      expect(await claimOpenSlot(env.DB, { planId: 2, positionId: 3, personId: 4 })).toBe('full');
    });

    it('rejects a claim that would land on a blocked-out date', async () => {
      // person 2 is blocked 06-01..06-03; put them on team 2 so they clear membership.
      await env.DB.prepare(`INSERT INTO team_members (team_id, person_id) VALUES (2, 2)`).run();
      expect(await claimOpenSlot(env.DB, { planId: 2, positionId: 3, personId: 2 })).toBe('conflict');
    });

    it('rejects a claim for a different position on a plan the person already serves', async () => {
      // person 3 already Pianist on plan 1 → claiming the open Vocalist slot on
      // the SAME plan is a double-booking conflict (claims never force).
      expect(await assignPerson(env.DB, { planId: 1, positionId: 2, personId: 3, assignedBy: 1 })).toBe('ok');
      expect(await claimOpenSlot(env.DB, { planId: 1, positionId: 1, personId: 3 })).toBe('conflict');
    });
  });

  describe('listOpenSlotsForPerson', () => {
    it('lists open, claimable slots on the teams the person belongs to', async () => {
      const slots = await listOpenSlotsForPerson(env.DB, 3, 'en'); // person 3 ∈ teams 1 and 2
      expect(slots.map((s) => [s.position_id, s.position_name]).sort()).toEqual([
        [1, 'Vocalist'],
        [3, 'Sound'],
      ]);
      expect(slots.every((s) => s.plan_date === '2030-06-02')).toBe(true);
    });

    it('excludes slots on dates the person already serves (double-booking) or that are theirs', async () => {
      await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 3, assignedBy: 1, force: true });
      // Now serving on 2030-06-02 → the same-date open slot on plan 2 is hidden too.
      expect(await listOpenSlotsForPerson(env.DB, 3, 'en')).toEqual([]);
    });

    it('excludes slots on blocked-out dates', async () => {
      // person 2 ∈ team 1 (open slot on plan 1) but is blocked out 06-01..06-03.
      expect(await listOpenSlotsForPerson(env.DB, 2, 'en')).toEqual([]);
    });
  });

  describe('getTeamAvailability', () => {
    it('builds a scheduled / blocked / available cell per member × plan', async () => {
      await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 1, assignedBy: 1, force: true });
      const avail = await getTeamAvailability(env.DB, 1, 'en');
      expect(avail.plans.map((p) => p.plan_date)).toEqual(['2030-06-02']); // only plan 1 carries team-1 positions
      const byName = Object.fromEntries(avail.rows.map((r) => [r.name, r.cells[0]]));
      expect(byName['Leader']).toEqual({ state: 'scheduled', label: 'Vocalist' });
      expect(byName['Vol A'].state).toBe('blocked');
      expect(byName['Vol A'].label).toContain('travel');
      expect(byName['Vol B']).toEqual({ state: 'available', label: '' });
    });
  });

  describe('getPlan', () => {
    it('returns localized plan detail with positions and their assignees', async () => {
      await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 2, assignedBy: 1, force: true });
      const plan = await getPlan(env.DB, 1, 'en');
      expect(plan?.service_type_name).toBe('Chinese');
      expect(plan?.positions.map((p) => [p.position_name, p.needed, p.open_signup])).toEqual([
        ['Vocalist', 2, 1],
        ['Pianist', 1, 0],
      ]);
      expect(plan?.positions[0].assignees).toEqual([
        { assignment_id: expect.any(Number), person_id: 2, person_name: 'Vol A', status: 'U', decline_reason: null, is_signup: 0 },
      ]);
      expect(plan?.positions[1].assignees).toEqual([]);
    });

    it('honors the locale', async () => {
      const plan = await getPlan(env.DB, 1, 'zh');
      expect(plan?.service_type_name).toBe('中文');
      expect(plan?.positions[0].position_name).toBe('主唱');
    });

    it('returns null for an unknown plan', async () => {
      expect(await getPlan(env.DB, 9999, 'en')).toBeNull();
    });
  });

  describe('listPlans', () => {
    it('lists plans from a date, optionally scoped to one service type', async () => {
      const all = await listPlans(env.DB, null, 'en', { from: '2030-01-01' });
      expect(all.map((p) => p.id).sort()).toEqual([1, 2]);
      const scoped = await listPlans(env.DB, 1, 'en', { from: '2030-01-01' });
      expect(scoped.map((p) => [p.id, p.service_type_name])).toEqual([[1, 'Chinese']]);
      expect(await listPlans(env.DB, null, 'en', { from: '2031-01-01' })).toEqual([]);
    });
  });

  describe('getAssignmentPositionId', () => {
    it('returns the position of a live assignment and null for a removed one', async () => {
      await assignPerson(env.DB, { planId: 1, positionId: 1, personId: 3, assignedBy: 1, force: true });
      const id = await assignmentIdOf(1, 1, 3);
      expect(await getAssignmentPositionId(env.DB, id)).toBe(1);
      await removeAssignment(env.DB, id);
      expect(await getAssignmentPositionId(env.DB, id)).toBeNull();
    });
  });
});

// ── slice-3 contract: respondToAssignment (ownership scope + past-refusal) ──
describe('respondToAssignment', () => {
  beforeEach(async () => {
    await wipe();
    await env.DB.prepare(
      `INSERT INTO people (id, display_name, email) VALUES
        (1, 'One', 'one@example.com'), (2, 'Two', 'two@example.com')`,
    ).run();
  });

  async function makeAssignment(personId: number, planDate: string): Promise<number> {
    await env.DB.prepare("INSERT INTO service_types (start_time) VALUES ('09:30')").run();
    const st = (await env.DB.prepare('SELECT id FROM service_types ORDER BY id DESC LIMIT 1').first<{ id: number }>())!;
    await env.DB.prepare('INSERT INTO plans (service_type_id, plan_date) VALUES (?, ?)').bind(st.id, planDate).run();
    const plan = (await env.DB.prepare('SELECT id FROM plans ORDER BY id DESC LIMIT 1').first<{ id: number }>())!;
    await env.DB.prepare('INSERT INTO teams (ministry_id) VALUES (NULL)').run();
    const team = (await env.DB.prepare('SELECT id FROM teams ORDER BY id DESC LIMIT 1').first<{ id: number }>())!;
    await env.DB.prepare('INSERT INTO positions (team_id) VALUES (?)').bind(team.id).run();
    const pos = (await env.DB.prepare('SELECT id FROM positions ORDER BY id DESC LIMIT 1').first<{ id: number }>())!;
    await env.DB.prepare('INSERT INTO roster_assignments (plan_id, position_id, person_id) VALUES (?, ?, ?)')
      .bind(plan.id, pos.id, personId)
      .run();
    return (await env.DB.prepare('SELECT id FROM roster_assignments ORDER BY id DESC LIMIT 1').first<{ id: number }>())!.id;
  }

  async function statusOf(id: number): Promise<{ status: string; decline_reason: string | null; responded_at: string | null }> {
    return (await env.DB
      .prepare('SELECT status, decline_reason, responded_at FROM roster_assignments WHERE id = ?')
      .bind(id)
      .first<{ status: string; decline_reason: string | null; responded_at: string | null }>())!;
  }

  it('accept sets status C, stamps responded_at, clears any decline reason', async () => {
    const id = await makeAssignment(1, '2999-01-01');
    expect(await respondToAssignment(env.DB, id, 1, 'accept', null)).toEqual({ ok: true });
    const row = await statusOf(id);
    expect(row.status).toBe('C');
    expect(row.decline_reason).toBeNull();
    expect(row.responded_at).not.toBeNull();
  });

  it('decline sets status D and stores the reason', async () => {
    const id = await makeAssignment(1, '2999-01-01');
    expect(await respondToAssignment(env.DB, id, 1, 'decline', 'out of town')).toEqual({ ok: true });
    const row = await statusOf(id);
    expect(row.status).toBe('D');
    expect(row.decline_reason).toBe('out of town');
  });

  it('refuses a plan already in the past and leaves the row unchanged', async () => {
    const id = await makeAssignment(1, '2000-01-01');
    expect(await respondToAssignment(env.DB, id, 1, 'accept', null)).toEqual({ ok: false, reason: 'past' });
    expect((await statusOf(id)).status).toBe('U');
  });

  it('refuses a request that belongs to a different person', async () => {
    const id = await makeAssignment(1, '2999-01-01');
    expect(await respondToAssignment(env.DB, id, 2, 'accept', null)).toEqual({ ok: false, reason: 'notfound' });
    expect((await statusOf(id)).status).toBe('U');
  });
});
