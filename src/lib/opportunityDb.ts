// Opportunity-board aggregations (spec addendum §B.2). Two public reads that
// power `/{locale}/serve/opportunities`:
//   (a) listApplicationTeams — every active team a person could apply to, with
//       its ministry (name + icon), leader count, and localized position chips.
//   (b) listOpportunitySlots — future, non-deleted, open-signup plan positions
//       that still have a free spot (remaining = needed − non-declined
//       assignees > 0), grouped by team → position, capped at the next 3 dates
//       per position. The remaining/exclusion logic mirrors planDb's
//       listOpenSlotsForPerson (declined 'D' and soft-deleted assignments don't
//       count, past plans and closed positions are excluded) but is PUBLIC — it
//       carries no person scoping (no team-membership / blockout filters).
import type { AppDb } from './appDb';
import { i18nJoin, type Locale } from './db';
import { todayInTz } from './dates';

const TZ = 'America/Chicago';

// ── (a) Teams accepting applications ──

export interface ApplicationTeam {
  team_id: number;
  team_name: string;
  ministry_name: string | null;
  ministry_icon: string | null;
  leader_count: number;
  /** Localized position names (chips), in position sort order. */
  positions: string[];
}

/** All active teams with their ministry, leader count and position chips. */
export async function listApplicationTeams(db: AppDb, locale: Locale): Promise<ApplicationTeam[]> {
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const minJ = i18nJoin('ministry_i18n', 'min', 'ministry_id', ['name'], locale);
  const { results: teams } = await db
    .prepare(
      `SELECT tm.id AS team_id, COALESCE(tm_l.name, tm_d.name) AS team_name,
              COALESCE(min_l.name, min_d.name) AS ministry_name, min.icon AS ministry_icon,
              (SELECT COUNT(*) FROM team_members
                 JOIN people ON people.id = team_members.person_id AND people.deleted_at IS NULL
                 WHERE team_members.team_id = tm.id AND team_members.is_leader = 1) AS leader_count
       FROM teams tm
       ${tmJ.joins}
       LEFT JOIN ministries min ON min.id = tm.ministry_id AND min.deleted_at IS NULL
       ${minJ.joins}
       WHERE tm.deleted_at IS NULL
       ORDER BY tm.sort, tm.id`,
    )
    .all<Omit<ApplicationTeam, 'positions'>>();
  if (teams.length === 0) return [];

  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);
  const { results: positions } = await db
    .prepare(
      `SELECT pos.team_id AS team_id, COALESCE(pos_l.name, pos_d.name) AS name
       FROM positions pos
       ${posJ.joins}
       WHERE pos.deleted_at IS NULL
       ORDER BY pos.sort, pos.id`,
    )
    .all<{ team_id: number; name: string }>();

  const byTeam = new Map<number, string[]>();
  for (const p of positions) {
    const list = byTeam.get(p.team_id);
    if (list) list.push(p.name);
    else byTeam.set(p.team_id, [p.name]);
  }
  return teams.map((t) => ({ ...t, positions: byTeam.get(t.team_id) ?? [] }));
}

// ── (b) Open self-signup slots ──

export interface OpportunityDate {
  plan_id: number;
  position_id: number;
  plan_date: string;
  service_type_name: string;
  remaining: number;
}

export interface OpportunityPosition {
  position_id: number;
  position_name: string;
  /** The soonest open dates for this position, capped at 3. */
  dates: OpportunityDate[];
}

export interface OpportunityTeam {
  team_id: number;
  team_name: string;
  ministry_name: string | null;
  ministry_icon: string | null;
  positions: OpportunityPosition[];
}

interface OpenSlotFlat {
  plan_id: number;
  position_id: number;
  needed: number;
  taken: number;
  plan_date: string;
  service_type_name: string;
  position_name: string;
  team_id: number;
  team_name: string;
  ministry_name: string | null;
  ministry_icon: string | null;
}

const MAX_DATES_PER_POSITION = 3;

/**
 * Future open-signup slots with a free spot, grouped team → position and capped
 * at the next {@link MAX_DATES_PER_POSITION} dates per position. A slot counts as
 * open when needed − (assignees whose status is not 'D' and not soft-deleted) > 0
 * on a non-deleted, non-past plan whose position/team/service-type are all live.
 */
export async function listOpportunitySlots(db: AppDb, locale: Locale): Promise<OpportunityTeam[]> {
  const fromDate = todayInTz(TZ);
  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const minJ = i18nJoin('ministry_i18n', 'min', 'ministry_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT pp.plan_id AS plan_id, pp.position_id AS position_id, pp.needed AS needed,
              plans.plan_date AS plan_date,
              COALESCE(st_l.name, st_d.name) AS service_type_name,
              COALESCE(pos_l.name, pos_d.name) AS position_name,
              tm.id AS team_id, COALESCE(tm_l.name, tm_d.name) AS team_name,
              COALESCE(min_l.name, min_d.name) AS ministry_name, min.icon AS ministry_icon,
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
       LEFT JOIN ministries min ON min.id = tm.ministry_id AND min.deleted_at IS NULL
       ${minJ.joins}
       WHERE pp.open_signup = 1 AND plans.plan_date >= ?1
         AND (SELECT COUNT(*) FROM roster_assignments ra
              WHERE ra.plan_id = pp.plan_id AND ra.position_id = pp.position_id
                AND ra.status != 'D' AND ra.deleted_at IS NULL) < pp.needed
       ORDER BY tm.sort, tm.id, pos.sort, pos.id, plans.plan_date, plans.id`,
    )
    .bind(fromDate)
    .all<OpenSlotFlat>();

  const teams: OpportunityTeam[] = [];
  const teamIndex = new Map<number, OpportunityTeam>();
  const posIndex = new Map<string, OpportunityPosition>();
  for (const r of results) {
    let team = teamIndex.get(r.team_id);
    if (!team) {
      team = {
        team_id: r.team_id,
        team_name: r.team_name,
        ministry_name: r.ministry_name,
        ministry_icon: r.ministry_icon,
        positions: [],
      };
      teamIndex.set(r.team_id, team);
      teams.push(team);
    }
    const posKey = `${r.team_id}:${r.position_id}`;
    let pos = posIndex.get(posKey);
    if (!pos) {
      pos = { position_id: r.position_id, position_name: r.position_name, dates: [] };
      posIndex.set(posKey, pos);
      team.positions.push(pos);
    }
    if (pos.dates.length >= MAX_DATES_PER_POSITION) continue;
    pos.dates.push({
      plan_id: r.plan_id,
      position_id: r.position_id,
      plan_date: r.plan_date,
      service_type_name: r.service_type_name,
      remaining: r.needed - r.taken,
    });
  }
  return teams;
}
