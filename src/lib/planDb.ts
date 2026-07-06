// Scheduling engine: plan creation/generation, per-plan position needs,
// assignments (leader-driven), open-slot claims (volunteer-driven), responses,
// conflicts, open-slot discovery, and team availability.
//
// Authorization invariant: every write that touches a position re-derives the
// team from position_id server-side (canEditPosition) — never trust form-posted
// team ids. Volunteers mutate only their own rows (verified by person_id).
//
// Ported faithfully from dcfc-serve/src/lib/planDb.ts, adapted to church-cms:
// localized names come from *_i18n companion tables (via i18nJoin), there is no
// congregation column, plans/roster_assignments have no updated_at column, and
// team_members has no deleted_at column. respondToAssignment is the slice-3
// contract and is preserved verbatim below.

import { i18nJoin } from './db';
import { addDays, nextWeekday, todayInTz } from './dates';
import type { Locale } from './locales';
import type { SessionUser } from './types';

const TZ = 'America/Chicago';

export interface Conflict {
  kind: 'blockout' | 'double';
  detail: string; // blockout reason/time, or the conflicting service — position label
}

export type AssignResult = 'ok' | 'full' | 'conflicts' | 'duplicate';
export type ClaimResult = 'ok' | 'not_member' | 'closed' | 'full' | 'taken' | 'conflict';

export interface AssignArgs {
  planId: number;
  positionId: number;
  personId: number;
  assignedBy: number;
  force?: boolean;
}

export interface ClaimArgs {
  planId: number;
  positionId: number;
  personId: number;
}

export interface CreatePlanArgs {
  serviceTypeId: number;
  planDate: string;
  title?: string | null;
  series?: string | null;
}

// ── Authorization ──

/** True when the user may edit scheduling for this position's team. */
export async function canEditPosition(db: D1Database, user: SessionUser, positionId: number): Promise<boolean> {
  if (user.isAdmin) return true;
  const row = await db
    .prepare(`SELECT team_id FROM positions WHERE id = ? AND deleted_at IS NULL`)
    .bind(positionId)
    .first<{ team_id: number }>();
  return row !== null && user.leaderTeamIds.includes(row.team_id);
}

// ── Plan creation & weekly generation ──

/** Revive-or-create against UNIQUE(service_type_id, plan_date). Returns the id. */
export async function createPlan(db: D1Database, args: CreatePlanArgs): Promise<number> {
  const { serviceTypeId, planDate, title = null, series = null } = args;
  await db
    .prepare(
      `INSERT INTO plans (service_type_id, plan_date, title, series) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(service_type_id, plan_date)
       DO UPDATE SET deleted_at = NULL, title = excluded.title, series = excluded.series`,
    )
    .bind(serviceTypeId, planDate, title, series)
    .run();
  const row = await db
    .prepare(`SELECT id FROM plans WHERE service_type_id = ? AND plan_date = ?`)
    .bind(serviceTypeId, planDate)
    .first<{ id: number }>();
  return row!.id;
}

/**
 * Create a plan for every `weekday` (0=Sun..6=Sat) from the next occurrence
 * through `throughDate` (idempotent). The horizon is clamped to +370 days so a
 * mis-typed year can't insert hundreds of junk plans (and blow the Workers
 * subrequest cap). Each newly-empty plan copies its position needs from the
 * nearest earlier plan of the same service type that has any.
 */
export async function ensureWeeklyPlans(
  db: D1Database,
  serviceTypeId: number,
  weekday: number,
  throughDate: string,
  now: Date = new Date(),
): Promise<number> {
  const today = todayInTz(TZ, now);
  const cap = addDays(today, 370);
  if (throughDate > cap) throughDate = cap;
  let created = 0;
  for (let d = nextWeekday(today, weekday); d <= throughDate; d = addDays(d, 7)) {
    await db
      .prepare(
        `INSERT INTO plans (service_type_id, plan_date) VALUES (?1, ?2)
         ON CONFLICT(service_type_id, plan_date) DO UPDATE SET deleted_at = NULL`,
      )
      .bind(serviceTypeId, d)
      .run();
    const plan = (await db
      .prepare(`SELECT id FROM plans WHERE service_type_id = ? AND plan_date = ?`)
      .bind(serviceTypeId, d)
      .first<{ id: number }>())!;

    const hasNeeds = await db
      .prepare(`SELECT 1 AS one FROM plan_positions WHERE plan_id = ? LIMIT 1`)
      .bind(plan.id)
      .first<{ one: number }>();
    if (!hasNeeds) {
      // Template = nearest earlier plan of this type that has needs.
      const template = await db
        .prepare(
          `SELECT plans.id FROM plans
           WHERE plans.service_type_id = ?1 AND plans.plan_date < ?2 AND plans.deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM plan_positions WHERE plan_positions.plan_id = plans.id)
           ORDER BY plans.plan_date DESC LIMIT 1`,
        )
        .bind(serviceTypeId, d)
        .first<{ id: number }>();
      if (template) {
        await db
          .prepare(
            `INSERT INTO plan_positions (plan_id, position_id, needed, open_signup)
             SELECT ?1, position_id, needed, open_signup FROM plan_positions WHERE plan_id = ?2`,
          )
          .bind(plan.id, template.id)
          .run();
      }
      created++;
    }
  }
  return created;
}

/** Set (or clear, with needed <= 0) how many people a plan needs in a position. */
export async function setPlanPosition(
  db: D1Database,
  planId: number,
  positionId: number,
  needed: number,
  openSignup: boolean,
): Promise<void> {
  if (needed <= 0) {
    await db.prepare(`DELETE FROM plan_positions WHERE plan_id = ? AND position_id = ?`).bind(planId, positionId).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO plan_positions (plan_id, position_id, needed, open_signup) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(plan_id, position_id) DO UPDATE SET needed = excluded.needed, open_signup = excluded.open_signup`,
    )
    .bind(planId, positionId, needed, openSignup ? 1 : 0)
    .run();
}

// ── Conflicts ──

/**
 * Blockout + same-day double-booking warnings for scheduling personId on the
 * given plan. (a) Blockout overlap: the plan_date falls inside [start_date,
 * end_date]; when both the blockout and the plan's service type carry a time
 * range, a non-overlapping blockout auto-resolves (no conflict) — a whole-day
 * blockout always conflicts. (b) Double-booking: any non-declined, non-deleted
 * assignment the person holds on a same-date plan of ANY service type —
 * including a different position on this same plan. The exact target slot never
 * self-flags because assignPerson/claimOpenSlot return 'duplicate'/'taken'
 * before conflicts are checked, and declined/deleted rows are filtered here.
 * Double-booking labels use the English (default) name — callers needing the
 * viewer's locale re-localize from the ids.
 */
export async function getConflicts(db: D1Database, personId: number, planId: number): Promise<Conflict[]> {
  const plan = await db
    .prepare(
      `SELECT plans.plan_date, service_types.start_time, service_types.end_time
       FROM plans JOIN service_types ON service_types.id = plans.service_type_id
       WHERE plans.id = ? AND plans.deleted_at IS NULL`,
    )
    .bind(planId)
    .first<{ plan_date: string; start_time: string | null; end_time: string | null }>();
  if (!plan) return [];

  const conflicts: Conflict[] = [];
  const { results: blockouts } = await db
    .prepare(
      `SELECT reason, start_time, end_time FROM blockout_dates
       WHERE person_id = ?1 AND start_date <= ?2 AND end_date >= ?2`,
    )
    .bind(personId, plan.plan_date)
    .all<{ reason: string | null; start_time: string | null; end_time: string | null }>();
  for (const b of blockouts) {
    if (b.start_time && b.end_time && plan.start_time && plan.end_time) {
      const overlaps = b.start_time < plan.end_time && b.end_time > plan.start_time;
      if (!overlaps) continue;
    }
    const time = b.start_time && b.end_time ? `${b.start_time}–${b.end_time}` : '';
    const detail = [time, b.reason ?? ''].filter(Boolean).join(' · ');
    conflicts.push({ kind: 'blockout', detail });
  }

  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], 'en');
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], 'en');
  const { results: doubles } = await db
    .prepare(
      `SELECT COALESCE(st_l.name, st_d.name) AS st_name,
              COALESCE(pos_l.name, pos_d.name) AS pos_name
       FROM roster_assignments ra
       JOIN plans p ON p.id = ra.plan_id AND p.deleted_at IS NULL
       JOIN service_types st ON st.id = p.service_type_id
       ${stJ.joins}
       JOIN positions pos ON pos.id = ra.position_id
       ${posJ.joins}
       WHERE ra.person_id = ?1 AND p.plan_date = ?2
         AND ra.status != 'D' AND ra.deleted_at IS NULL`,
    )
    .bind(personId, plan.plan_date)
    .all<{ st_name: string; pos_name: string }>();
  for (const d of doubles) conflicts.push({ kind: 'double', detail: `${d.st_name} — ${d.pos_name}` });
  return conflicts;
}

// ── Assignment (leader-driven) ──

/**
 * Leader-driven assignment: creates/revives an Unconfirmed request. Returns
 * 'duplicate' when the person is already actively assigned to this slot; 'full'
 * when the position's `needed` cap (counting non-declined assignees) is reached;
 * 'conflicts' when getConflicts is non-empty and `force` is not set (conflicts
 * are warnings — pass force=true to override); otherwise 'ok'. A soft-deleted or
 * previously-declined row for the same slot is revived to status 'U'.
 */
export async function assignPerson(db: D1Database, args: AssignArgs): Promise<AssignResult> {
  const { planId, positionId, personId, assignedBy, force = false } = args;

  const plan = await db
    .prepare(`SELECT id FROM plans WHERE id = ? AND deleted_at IS NULL`)
    .bind(planId)
    .first<{ id: number }>();
  if (!plan) return 'full';

  // Already actively assigned to this exact slot → duplicate. A declined or
  // soft-deleted row is not a duplicate; it gets revived below.
  const existing = await db
    .prepare(
      `SELECT status FROM roster_assignments
       WHERE plan_id = ?1 AND position_id = ?2 AND person_id = ?3
         AND deleted_at IS NULL AND status != 'D'`,
    )
    .bind(planId, positionId, personId)
    .first<{ status: string }>();
  if (existing) return 'duplicate';

  const cap = await db
    .prepare(
      `SELECT (SELECT needed FROM plan_positions WHERE plan_id = ?1 AND position_id = ?2) AS needed,
              (SELECT COUNT(*) FROM roster_assignments
               WHERE plan_id = ?1 AND position_id = ?2 AND status != 'D' AND deleted_at IS NULL
                 AND person_id != ?3) AS taken`,
    )
    .bind(planId, positionId, personId)
    .first<{ needed: number | null; taken: number }>();
  if ((cap?.needed ?? 0) <= (cap?.taken ?? 0)) return 'full';

  if (!force) {
    const conflicts = await getConflicts(db, personId, planId);
    if (conflicts.length > 0) return 'conflicts';
  }

  await db
    .prepare(
      `INSERT INTO roster_assignments (plan_id, position_id, person_id, status, assigned_by)
       VALUES (?1, ?2, ?3, 'U', ?4)
       ON CONFLICT(plan_id, position_id, person_id)
       DO UPDATE SET status = 'U', decline_reason = NULL, responded_at = NULL, notified_at = NULL,
                     is_signup = 0, assigned_by = excluded.assigned_by, deleted_at = NULL`,
    )
    .bind(planId, positionId, personId, assignedBy)
    .run();
  return 'ok';
}

// ── Open-slot claim (volunteer-driven) ──

/**
 * Volunteer-driven claim of an open slot: creates a Confirmed self-signup.
 * Guards (re-derived server-side): the person must be a member of the position's
 * team ('not_member'); the slot must exist and be open_signup ('closed'); the
 * person must not already hold it ('taken'); it must not be full ('full'); and
 * getConflicts must be empty — claims NEVER force ('conflict'). On success the
 * row is status 'C', is_signup 1.
 */
export async function claimOpenSlot(db: D1Database, args: ClaimArgs): Promise<ClaimResult> {
  const { planId, positionId, personId } = args;

  const state = await db
    .prepare(
      `SELECT pos.team_id AS team_id, pp.needed AS needed, pp.open_signup AS open_signup,
              (SELECT COUNT(*) FROM team_members WHERE team_id = pos.team_id AND person_id = ?3) AS is_member,
              (SELECT COUNT(*) FROM roster_assignments
               WHERE plan_id = ?1 AND position_id = ?2 AND status != 'D' AND deleted_at IS NULL) AS taken,
              (SELECT COUNT(*) FROM roster_assignments
               WHERE plan_id = ?1 AND position_id = ?2 AND person_id = ?3 AND status != 'D' AND deleted_at IS NULL) AS mine
       FROM plan_positions pp
       JOIN plans ON plans.id = pp.plan_id AND plans.deleted_at IS NULL
       JOIN positions pos ON pos.id = pp.position_id AND pos.deleted_at IS NULL
       WHERE pp.plan_id = ?1 AND pp.position_id = ?2`,
    )
    .bind(planId, positionId, personId)
    .first<{ team_id: number; needed: number; open_signup: number; is_member: number; taken: number; mine: number }>();
  if (!state) return 'closed';
  if (state.is_member === 0) return 'not_member';
  if (state.open_signup !== 1) return 'closed';
  if (state.mine > 0) return 'taken';
  if (state.taken >= state.needed) return 'full';

  const conflicts = await getConflicts(db, personId, planId);
  if (conflicts.length > 0) return 'conflict';

  await db
    .prepare(
      `INSERT INTO roster_assignments (plan_id, position_id, person_id, status, is_signup, assigned_by, responded_at)
       VALUES (?1, ?2, ?3, 'C', 1, ?3, datetime('now'))
       ON CONFLICT(plan_id, position_id, person_id)
       DO UPDATE SET status = 'C', is_signup = 1, decline_reason = NULL,
                     responded_at = datetime('now'), deleted_at = NULL`,
    )
    .bind(planId, positionId, personId)
    .run();
  return 'ok';
}

// ── Removal ──

/** Soft-delete an assignment. Authorize via getAssignmentPositionId + canEditPosition. */
export async function removeAssignment(db: D1Database, assignmentId: number): Promise<void> {
  await db
    .prepare(`UPDATE roster_assignments SET deleted_at = datetime('now') WHERE id = ?`)
    .bind(assignmentId)
    .run();
}

/** The position_id of a live assignment (for re-deriving the team to authorize). */
export async function getAssignmentPositionId(db: D1Database, assignmentId: number): Promise<number | null> {
  const row = await db
    .prepare(`SELECT position_id FROM roster_assignments WHERE id = ? AND deleted_at IS NULL`)
    .bind(assignmentId)
    .first<{ position_id: number }>();
  return row?.position_id ?? null;
}

// ── Open-slot discovery (volunteer) ──

export interface OpenSlot {
  plan_id: number;
  position_id: number;
  needed: number;
  taken: number;
  plan_date: string;
  service_type_name: string;
  position_name: string;
  team_id: number;
  team_name: string;
}

/**
 * Future open-signup slots the person could still claim: on teams they belong
 * to, not full, not already theirs, and excluding dates where they're blocked
 * out or already serving. Localized names via i18n with an en fallback.
 */
export async function listOpenSlotsForPerson(db: D1Database, personId: number, locale: Locale): Promise<OpenSlot[]> {
  const fromDate = todayInTz(TZ);
  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT pp.plan_id AS plan_id, pp.position_id AS position_id, pp.needed AS needed,
              plans.plan_date AS plan_date,
              COALESCE(st_l.name, st_d.name) AS service_type_name,
              COALESCE(pos_l.name, pos_d.name) AS position_name,
              tm.id AS team_id, COALESCE(tm_l.name, tm_d.name) AS team_name,
              (SELECT COUNT(*) FROM roster_assignments ra
               WHERE ra.plan_id = pp.plan_id AND ra.position_id = pp.position_id
                 AND ra.status != 'D' AND ra.deleted_at IS NULL) AS taken
       FROM plan_positions pp
       JOIN plans ON plans.id = pp.plan_id AND plans.deleted_at IS NULL
       JOIN service_types st ON st.id = plans.service_type_id AND st.deleted_at IS NULL
       ${stJ.joins}
       JOIN positions pos ON pos.id = pp.position_id AND pos.deleted_at IS NULL
       ${posJ.joins}
       JOIN teams tm ON tm.id = pos.team_id AND tm.deleted_at IS NULL
       ${tmJ.joins}
       WHERE pp.open_signup = 1 AND plans.plan_date >= ?1
         AND tm.id IN (SELECT team_id FROM team_members WHERE person_id = ?2)
         AND (SELECT COUNT(*) FROM roster_assignments ra
              WHERE ra.plan_id = pp.plan_id AND ra.position_id = pp.position_id
                AND ra.status != 'D' AND ra.deleted_at IS NULL) < pp.needed
         AND NOT EXISTS (SELECT 1 FROM roster_assignments ra
              WHERE ra.plan_id = pp.plan_id AND ra.position_id = pp.position_id
                AND ra.person_id = ?2 AND ra.status != 'D' AND ra.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM blockout_dates b
              WHERE b.person_id = ?2 AND b.start_date <= plans.plan_date AND b.end_date >= plans.plan_date)
         AND NOT EXISTS (SELECT 1 FROM roster_assignments ra2
              JOIN plans p2 ON p2.id = ra2.plan_id AND p2.deleted_at IS NULL
              WHERE ra2.person_id = ?2 AND p2.plan_date = plans.plan_date
                AND ra2.status != 'D' AND ra2.deleted_at IS NULL)
       ORDER BY plans.plan_date, tm.sort, pos.sort`,
    )
    .bind(fromDate, personId)
    .all<OpenSlot>();
  return results;
}

// ── Team availability matrix (members × next N plans) ──

export interface AvailPlan {
  id: number;
  plan_date: string;
}

export interface AvailCell {
  state: 'scheduled' | 'available' | 'blocked';
  label: string; // scheduled position name, or blockout time/reason
}

export interface AvailRow {
  person_id: number;
  name: string;
  cells: AvailCell[];
}

export interface AvailabilityData {
  plans: AvailPlan[];
  rows: AvailRow[];
}

/** Team roster availability across the next 4 plans carrying any of the team's positions. */
export async function getTeamAvailability(db: D1Database, teamId: number, locale: Locale): Promise<AvailabilityData> {
  const fromDate = todayInTz(TZ);
  const { results: plans } = await db
    .prepare(
      `SELECT DISTINCT plans.id, plans.plan_date
       FROM plans
       JOIN plan_positions ON plan_positions.plan_id = plans.id
       JOIN positions ON positions.id = plan_positions.position_id
         AND positions.team_id = ?1 AND positions.deleted_at IS NULL
       WHERE plans.plan_date >= ?2 AND plans.deleted_at IS NULL
       ORDER BY plans.plan_date LIMIT 4`,
    )
    .bind(teamId, fromDate)
    .all<AvailPlan>();

  const { results: members } = await db
    .prepare(
      `SELECT people.id AS person_id, people.display_name AS name
       FROM team_members
       JOIN people ON people.id = team_members.person_id AND people.deleted_at IS NULL
       WHERE team_members.team_id = ?
       ORDER BY people.display_name`,
    )
    .bind(teamId)
    .all<{ person_id: number; name: string }>();

  if (plans.length === 0 || members.length === 0) return { plans, rows: [] };

  const planIds = plans.map((p) => p.id);
  const memberIds = members.map((m) => m.person_id);
  const planPh = planIds.map(() => '?').join(',');
  const memberPh = memberIds.map(() => '?').join(',');
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);

  const [{ results: assignments }, { results: blockouts }] = await Promise.all([
    db
      .prepare(
        `SELECT ra.plan_id, ra.person_id, COALESCE(pos_l.name, pos_d.name) AS position_name
         FROM roster_assignments ra
         JOIN positions pos ON pos.id = ra.position_id
         ${posJ.joins}
         WHERE ra.plan_id IN (${planPh}) AND ra.person_id IN (${memberPh})
           AND ra.status != 'D' AND ra.deleted_at IS NULL`,
      )
      .bind(...planIds, ...memberIds)
      .all<{ plan_id: number; person_id: number; position_name: string }>(),
    db
      .prepare(
        `SELECT person_id, start_date, end_date, start_time, end_time, reason
         FROM blockout_dates WHERE person_id IN (${memberPh})`,
      )
      .bind(...memberIds)
      .all<{ person_id: number; start_date: string; end_date: string; start_time: string | null; end_time: string | null; reason: string | null }>(),
  ]);

  const rows = members.map((m) => ({
    person_id: m.person_id,
    name: m.name,
    cells: plans.map((p): AvailCell => {
      const sched = assignments.find((a) => a.plan_id === p.id && a.person_id === m.person_id);
      if (sched) return { state: 'scheduled', label: sched.position_name };
      const blocked = blockouts.find(
        (b) => b.person_id === m.person_id && b.start_date <= p.plan_date && b.end_date >= p.plan_date,
      );
      if (blocked) {
        const time = blocked.start_time && blocked.end_time ? `${blocked.start_time}–${blocked.end_time}` : '';
        return { state: 'blocked', label: [time, blocked.reason ?? ''].filter(Boolean).join(' · ') };
      }
      return { state: 'available', label: '' };
    }),
  }));

  return { plans, rows };
}

// ── Plan detail & listing reads ──

export interface PlanAssignee {
  assignment_id: number;
  person_id: number;
  person_name: string;
  status: 'U' | 'C' | 'D';
  decline_reason: string | null;
  is_signup: number;
}

export interface PlanDetailPosition {
  position_id: number;
  team_id: number;
  team_name: string;
  position_name: string;
  needed: number;
  open_signup: number;
  assignees: PlanAssignee[];
}

export interface PlanDetail {
  id: number;
  service_type_id: number;
  service_type_name: string;
  plan_date: string;
  title: string | null;
  series: string | null;
  positions: PlanDetailPosition[];
}

/** Full plan detail: metadata + positions (needed/open) each with their assignees. */
export async function getPlan(db: D1Database, id: number, locale: Locale): Promise<PlanDetail | null> {
  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const meta = await db
    .prepare(
      `SELECT plans.id, plans.service_type_id,
              COALESCE(st_l.name, st_d.name) AS service_type_name,
              plans.plan_date, plans.title, plans.series
       FROM plans
       JOIN service_types st ON st.id = plans.service_type_id
       ${stJ.joins}
       WHERE plans.id = ? AND plans.deleted_at IS NULL`,
    )
    .bind(id)
    .first<{ id: number; service_type_id: number; service_type_name: string; plan_date: string; title: string | null; series: string | null }>();
  if (!meta) return null;

  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const { results: positions } = await db
    .prepare(
      `SELECT pp.position_id AS position_id, pos.team_id AS team_id,
              COALESCE(tm_l.name, tm_d.name) AS team_name,
              COALESCE(pos_l.name, pos_d.name) AS position_name,
              pp.needed AS needed, pp.open_signup AS open_signup
       FROM plan_positions pp
       JOIN positions pos ON pos.id = pp.position_id AND pos.deleted_at IS NULL
       ${posJ.joins}
       JOIN teams tm ON tm.id = pos.team_id AND tm.deleted_at IS NULL
       ${tmJ.joins}
       WHERE pp.plan_id = ?
       ORDER BY tm.sort, tm.id, pos.sort, pos.id`,
    )
    .bind(id)
    .all<{ position_id: number; team_id: number; team_name: string; position_name: string; needed: number; open_signup: number }>();

  const { results: assignees } = await db
    .prepare(
      `SELECT ra.id AS assignment_id, ra.position_id, ra.person_id,
              people.display_name AS person_name, ra.status, ra.decline_reason, ra.is_signup
       FROM roster_assignments ra
       JOIN people ON people.id = ra.person_id
       WHERE ra.plan_id = ? AND ra.deleted_at IS NULL
       ORDER BY ra.id`,
    )
    .bind(id)
    .all<PlanAssignee & { position_id: number }>();

  return {
    ...meta,
    positions: positions.map((p) => ({
      ...p,
      assignees: assignees
        .filter((a) => a.position_id === p.position_id)
        .map(({ position_id: _pid, ...rest }) => rest),
    })),
  };
}

export interface PlanListRow {
  id: number;
  service_type_id: number;
  service_type_name: string;
  plan_date: string;
  title: string | null;
  series: string | null;
}

/** Plans on/after `from` (default today), soonest first. Optionally scoped to one service type. */
export async function listPlans(
  db: D1Database,
  serviceTypeId: number | null,
  locale: Locale,
  opts: { from?: string; limit?: number } = {},
): Promise<PlanListRow[]> {
  const from = opts.from ?? todayInTz(TZ);
  const limit = opts.limit ?? 100;
  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT plans.id, plans.service_type_id,
              COALESCE(st_l.name, st_d.name) AS service_type_name,
              plans.plan_date, plans.title, plans.series
       FROM plans
       JOIN service_types st ON st.id = plans.service_type_id
       ${stJ.joins}
       WHERE plans.deleted_at IS NULL AND plans.plan_date >= ?1
         AND (?2 IS NULL OR plans.service_type_id = ?2)
       ORDER BY plans.plan_date LIMIT ?3`,
    )
    .bind(from, serviceTypeId, limit)
    .all<PlanListRow>();
  return results;
}

// ── Response (slice 3 — preserved verbatim) ──

export type RespondAction = 'accept' | 'decline';
export type RespondResult = { ok: true } | { ok: false; reason: 'past' | 'notfound' };

/**
 * A volunteer accepts or declines a serving request via their single-use respond
 * link. Scoped to `personId` (the token's owner) so a token can only touch its
 * own assignment. Refuses to rewrite serving history for a service that has
 * already happened — `plan_date` earlier than yesterday returns
 * `{ ok: false, reason: 'past' }` (a 1-day grace absorbs timezone slop). Accept
 * sets status 'C' and clears any prior decline reason; decline sets 'D' and
 * stores the reason. Returns `{ ok: false, reason: 'notfound' }` when no such
 * assignment belongs to the person.
 */
export async function respondToAssignment(
  db: D1Database,
  assignmentId: number,
  personId: number,
  action: RespondAction,
  reason: string | null,
): Promise<RespondResult> {
  const status = action === 'accept' ? 'C' : 'D';
  const declineReason = action === 'accept' ? null : reason;

  // The WHERE clause is the guard: right person, live assignment, and a plan
  // whose date is not in the past. changes>0 means all held and we mutated.
  const res = await db
    .prepare(
      `UPDATE roster_assignments
       SET status = ?1, decline_reason = ?2, responded_at = datetime('now')
       WHERE id = ?3 AND person_id = ?4 AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM plans
                       WHERE plans.id = roster_assignments.plan_id
                         AND plans.deleted_at IS NULL
                         AND plans.plan_date >= date('now', '-1 day'))`,
    )
    .bind(status, declineReason, assignmentId, personId)
    .run();
  if (res.meta.changes > 0) return { ok: true };

  // Nothing changed: distinguish "belongs to someone else / gone" from "in the
  // past" so the page can show the right message.
  const owned = await db
    .prepare(
      `SELECT 1 AS x FROM roster_assignments WHERE id = ? AND person_id = ? AND deleted_at IS NULL`,
    )
    .bind(assignmentId, personId)
    .first<{ x: number }>();
  return owned ? { ok: false, reason: 'past' } : { ok: false, reason: 'notfound' };
}
