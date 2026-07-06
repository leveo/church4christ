// Page-scoped queries for the coordinator-facing serve pages (plans index,
// matrix, teams directory, team detail): service-type/team/position reads with
// localized names, team membership mutations, application review, the
// leader-facing "potential volunteers" union, and the matrix grid data.
//
// Ported from dcfc-serve (adminDb team/application functions, giftDb
// listPotentialVolunteers, db.getMatrix), adapted to church-cms: names come
// from *_i18n companion tables (via i18nJoin, en fallback), there is no
// congregation column, `team_members` has no id/deleted_at/updated_at (so add
// is INSERT-or-ignore and remove is a hard DELETE of the membership row), and
// `team_applications.decided_by` is TEXT (the decider's email).
//
// Authorization stays in the pages: every caller re-checks admin-or-leader of
// the target team (via SessionUser.leaderTeamIds or planDb.canEditPosition)
// before invoking a mutation here.
import { i18nJoin, type Locale } from './db';
import { todayInTz } from './dates';
import { listPlans, type PlanListRow } from './planDb';

const TZ = 'America/Chicago';

// ── Service types ──

export interface ServiceTypeRow {
  id: number;
  name: string;
  start_time: string | null;
  end_time: string | null;
}

/** Active service types, localized name with en fallback, in sort order. */
export async function listServiceTypes(db: D1Database, locale: Locale): Promise<ServiceTypeRow[]> {
  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT st.id AS id, ${stJ.select}, st.start_time AS start_time, st.end_time AS end_time
       FROM service_types st
       ${stJ.joins}
       WHERE st.deleted_at IS NULL
       ORDER BY st.sort, st.id`,
    )
    .all<ServiceTypeRow>();
  return results;
}

export interface ServiceTypeAdminRow extends ServiceTypeRow {
  name_en: string;
  name_zh: string | null;
  sort: number;
}

/** Non-deleted service types with BOTH locale names + sort, for the admin CRUD table. */
export async function listServiceTypesAdmin(db: D1Database): Promise<ServiceTypeAdminRow[]> {
  const { results } = await db
    .prepare(
      `SELECT st.id AS id, st.start_time AS start_time, st.end_time AS end_time, st.sort AS sort,
              en.name AS name_en, zh.name AS name_zh, COALESCE(en.name, zh.name) AS name
       FROM service_types st
       LEFT JOIN service_type_i18n en ON en.service_type_id = st.id AND en.locale = 'en'
       LEFT JOIN service_type_i18n zh ON zh.service_type_id = st.id AND zh.locale = 'zh'
       WHERE st.deleted_at IS NULL
       ORDER BY st.sort, st.id`,
    )
    .all<ServiceTypeAdminRow>();
  return results;
}

export interface ServiceTypeInput {
  nameEn: string;
  nameZh: string | null;
  startTime: string | null;
  endTime: string | null;
  sort: number;
}

async function upsertServiceTypeI18n(db: D1Database, id: number, locale: Locale, name: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES (?1, ?2, ?3)
       ON CONFLICT(service_type_id, locale) DO UPDATE SET name = excluded.name`,
    )
    .bind(id, locale, name)
    .run();
}

/** Create (id null) or update a service type + its i18n names. Returns the id. */
export async function saveServiceType(db: D1Database, id: number | null, input: ServiceTypeInput): Promise<number> {
  let stId = id;
  if (stId) {
    await db
      .prepare(`UPDATE service_types SET start_time = ?1, end_time = ?2, sort = ?3, deleted_at = NULL WHERE id = ?4`)
      .bind(input.startTime, input.endTime, input.sort, stId)
      .run();
  } else {
    const row = await db
      .prepare(`INSERT INTO service_types (start_time, end_time, sort) VALUES (?1, ?2, ?3) RETURNING id`)
      .bind(input.startTime, input.endTime, input.sort)
      .first<{ id: number }>();
    stId = row!.id;
  }
  await upsertServiceTypeI18n(db, stId, 'en', input.nameEn);
  if (input.nameZh) await upsertServiceTypeI18n(db, stId, 'zh', input.nameZh);
  return stId;
}

export async function softDeleteServiceType(db: D1Database, id: number): Promise<void> {
  await db.prepare(`UPDATE service_types SET deleted_at = datetime('now') WHERE id = ?`).bind(id).run();
}

// ── Team soft-delete / restore (admin teams page) ──

export interface TeamAdminRow extends TeamSummary {
  deleted_at: string | null;
}

/** All teams INCLUDING soft-deleted ones, for the admin teams list. */
export async function listTeamsAdmin(db: D1Database, locale: Locale): Promise<TeamAdminRow[]> {
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const minJ = i18nJoin('ministry_i18n', 'min', 'ministry_id', ['name'], locale);
  const today = todayInTz(TZ);
  const { results } = await db
    .prepare(
      `SELECT tm.id AS id, COALESCE(tm_l.name, tm_d.name) AS name, tm.deleted_at AS deleted_at,
              min.id AS ministry_id, min.slug AS ministry_slug,
              COALESCE(min_l.name, min_d.name) AS ministry_name,
              (SELECT COUNT(*) FROM team_members
                 JOIN people ON people.id = team_members.person_id AND people.deleted_at IS NULL
                 WHERE team_members.team_id = tm.id) AS member_count,
              (SELECT COUNT(*) FROM team_members
                 JOIN people ON people.id = team_members.person_id AND people.deleted_at IS NULL
                 WHERE team_members.team_id = tm.id AND team_members.is_leader = 1) AS leader_count,
              (SELECT COUNT(*) FROM plan_positions pp
                 JOIN plans ON plans.id = pp.plan_id AND plans.deleted_at IS NULL AND plans.plan_date >= ?1
                 JOIN positions pos ON pos.id = pp.position_id AND pos.deleted_at IS NULL AND pos.team_id = tm.id
                 WHERE pp.open_signup = 1) AS open_slots
       FROM teams tm
       ${tmJ.joins}
       LEFT JOIN ministries min ON min.id = tm.ministry_id
       ${minJ.joins}
       ORDER BY tm.deleted_at IS NOT NULL, tm.sort, tm.id`,
    )
    .bind(today)
    .all<TeamAdminRow>();
  return results;
}

export async function softDeleteTeam(db: D1Database, id: number): Promise<void> {
  await db.prepare(`UPDATE teams SET deleted_at = datetime('now') WHERE id = ?`).bind(id).run();
}

export async function restoreTeam(db: D1Database, id: number): Promise<void> {
  await db.prepare(`UPDATE teams SET deleted_at = NULL WHERE id = ?`).bind(id).run();
}

// ── Teams directory ──

export interface TeamSummary {
  id: number;
  name: string;
  ministry_id: number | null;
  ministry_slug: string | null;
  ministry_name: string | null;
  member_count: number;
  leader_count: number;
  /** Open-signup plan positions on future, non-deleted plans of this team. */
  open_slots: number;
}

/** All teams with localized names, their ministry, member/leader counts, and an open-slot count. */
export async function listTeamSummaries(db: D1Database, locale: Locale): Promise<TeamSummary[]> {
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const minJ = i18nJoin('ministry_i18n', 'min', 'ministry_id', ['name'], locale);
  const today = todayInTz(TZ);
  const { results } = await db
    .prepare(
      `SELECT tm.id AS id, COALESCE(tm_l.name, tm_d.name) AS name,
              min.id AS ministry_id, min.slug AS ministry_slug,
              COALESCE(min_l.name, min_d.name) AS ministry_name,
              (SELECT COUNT(*) FROM team_members
                 JOIN people ON people.id = team_members.person_id AND people.deleted_at IS NULL
                 WHERE team_members.team_id = tm.id) AS member_count,
              (SELECT COUNT(*) FROM team_members
                 JOIN people ON people.id = team_members.person_id AND people.deleted_at IS NULL
                 WHERE team_members.team_id = tm.id AND team_members.is_leader = 1) AS leader_count,
              (SELECT COUNT(*) FROM plan_positions pp
                 JOIN plans ON plans.id = pp.plan_id AND plans.deleted_at IS NULL AND plans.plan_date >= ?1
                 JOIN positions pos ON pos.id = pp.position_id AND pos.deleted_at IS NULL AND pos.team_id = tm.id
                 WHERE pp.open_signup = 1) AS open_slots
       FROM teams tm
       ${tmJ.joins}
       LEFT JOIN ministries min ON min.id = tm.ministry_id AND min.deleted_at IS NULL
       ${minJ.joins}
       WHERE tm.deleted_at IS NULL
       ORDER BY tm.sort, tm.id`,
    )
    .bind(today)
    .all<TeamSummary>();
  return results;
}

export interface TeamDetailRow {
  id: number;
  name: string;
  ministry_id: number | null;
  ministry_slug: string | null;
  ministry_name: string | null;
  /** The ministry's category — drives the potential-volunteers match. */
  category: string | null;
}

/** One non-deleted team with its localized name and ministry (null-safe). */
export async function getTeam(db: D1Database, id: number, locale: Locale): Promise<TeamDetailRow | null> {
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const minJ = i18nJoin('ministry_i18n', 'min', 'ministry_id', ['name'], locale);
  return db
    .prepare(
      `SELECT tm.id AS id, COALESCE(tm_l.name, tm_d.name) AS name,
              min.id AS ministry_id, min.slug AS ministry_slug,
              COALESCE(min_l.name, min_d.name) AS ministry_name, min.category AS category
       FROM teams tm
       ${tmJ.joins}
       LEFT JOIN ministries min ON min.id = tm.ministry_id AND min.deleted_at IS NULL
       ${minJ.joins}
       WHERE tm.id = ? AND tm.deleted_at IS NULL`,
    )
    .bind(id)
    .first<TeamDetailRow>();
}

export interface MinistryOption {
  id: number;
  name: string;
  category: string;
}

/** Active ministries as select options (id + localized name), in sort order. */
export async function listMinistryOptions(db: D1Database, locale: Locale): Promise<MinistryOption[]> {
  const minJ = i18nJoin('ministry_i18n', 'min', 'ministry_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT min.id AS id, COALESCE(min_l.name, min_d.name) AS name, min.category AS category
       FROM ministries min
       ${minJ.joins}
       WHERE min.active = 1 AND min.deleted_at IS NULL
       ORDER BY min.sort, min.id`,
    )
    .all<MinistryOption>();
  return results;
}

export interface CreateTeamArgs {
  ministryId: number | null;
  nameEn: string;
  nameZh?: string | null;
  sort?: number;
}

/** Create a team + its i18n names (en required; zh only when provided). Returns the id. */
export async function createTeam(db: D1Database, args: CreateTeamArgs): Promise<number> {
  const { ministryId, nameEn, nameZh = null, sort = 0 } = args;
  const r = await db
    .prepare(`INSERT INTO teams (ministry_id, sort) VALUES (?, ?)`)
    .bind(ministryId, sort)
    .run();
  const teamId = r.meta.last_row_id;
  const stmts = [
    db.prepare(`INSERT INTO team_i18n (team_id, locale, name) VALUES (?, 'en', ?)`).bind(teamId, nameEn),
  ];
  if (nameZh) {
    stmts.push(db.prepare(`INSERT INTO team_i18n (team_id, locale, name) VALUES (?, 'zh', ?)`).bind(teamId, nameZh));
  }
  await db.batch(stmts);
  return teamId;
}

// ── Members ──

export interface TeamMemberRow {
  person_id: number;
  display_name: string;
  email: string | null;
  is_leader: number;
}

/** A team's roster (leaders first), excluding soft-deleted people. */
export async function listTeamMembers(db: D1Database, teamId: number): Promise<TeamMemberRow[]> {
  const { results } = await db
    .prepare(
      `SELECT team_members.person_id AS person_id, people.display_name AS display_name,
              people.email AS email, team_members.is_leader AS is_leader
       FROM team_members
       JOIN people ON people.id = team_members.person_id AND people.deleted_at IS NULL
       WHERE team_members.team_id = ?
       ORDER BY team_members.is_leader DESC, people.display_name`,
    )
    .bind(teamId)
    .all<TeamMemberRow>();
  return results;
}

/** Idempotent add (UNIQUE(team_id, person_id); an existing row is left as-is). */
export async function addTeamMember(db: D1Database, teamId: number, personId: number): Promise<void> {
  await db
    .prepare(`INSERT INTO team_members (team_id, person_id) VALUES (?, ?) ON CONFLICT(team_id, person_id) DO NOTHING`)
    .bind(teamId, personId)
    .run();
}

/** Remove a membership row (team_members has no soft-delete column). */
export async function removeTeamMember(db: D1Database, teamId: number, personId: number): Promise<void> {
  await db.prepare(`DELETE FROM team_members WHERE team_id = ? AND person_id = ?`).bind(teamId, personId).run();
}

export async function setTeamLeader(db: D1Database, teamId: number, personId: number, isLeader: boolean): Promise<void> {
  await db
    .prepare(`UPDATE team_members SET is_leader = ? WHERE team_id = ? AND person_id = ?`)
    .bind(isLeader ? 1 : 0, teamId, personId)
    .run();
}

export interface PositionRow {
  id: number;
  name: string;
  sort: number;
}

/** A team's non-deleted positions, localized, in sort order. */
export async function listTeamPositions(db: D1Database, teamId: number, locale: Locale): Promise<PositionRow[]> {
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT pos.id AS id, ${posJ.select}, pos.sort AS sort
       FROM positions pos
       ${posJ.joins}
       WHERE pos.team_id = ? AND pos.deleted_at IS NULL
       ORDER BY pos.sort, pos.id`,
    )
    .bind(teamId)
    .all<PositionRow>();
  return results;
}

export interface PersonOption {
  id: number;
  display_name: string;
}

/** Active, non-deleted people for the add-member select. */
export async function listActivePeople(db: D1Database): Promise<PersonOption[]> {
  const { results } = await db
    .prepare(
      `SELECT id, display_name FROM people
       WHERE active = 1 AND deleted_at IS NULL
       ORDER BY display_name`,
    )
    .all<PersonOption>();
  return results;
}

// ── Applications ──

export interface ApplicationRow {
  id: number;
  person_id: number;
  person_name: string;
  person_email: string | null;
  team_id: number;
  team_name: string;
  position_name: string | null;
  message: string | null;
  status: 'P' | 'A' | 'R';
  created_at: string;
  /** 1 when the applicant has ever completed the spiritual-gifts quiz. */
  has_gifts: number;
}

/** Pending applications for the given teams (localized team/position names, gift
 *  badge flag), oldest first. */
export async function listPendingApplicationsForTeams(
  db: D1Database,
  teamIds: number[],
  locale: Locale,
): Promise<ApplicationRow[]> {
  if (teamIds.length === 0) return [];
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const placeholders = teamIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT ta.id AS id, ta.person_id AS person_id, people.display_name AS person_name,
              people.email AS person_email, ta.team_id AS team_id,
              COALESCE(tm_l.name, tm_d.name) AS team_name,
              COALESCE(pos_l.name, pos_d.name) AS position_name,
              ta.message AS message, ta.status AS status, ta.created_at AS created_at,
              EXISTS(SELECT 1 FROM gift_results gr WHERE gr.person_id = ta.person_id) AS has_gifts
       FROM team_applications ta
       JOIN people ON people.id = ta.person_id AND people.deleted_at IS NULL
       JOIN teams tm ON tm.id = ta.team_id
       ${tmJ.joins}
       LEFT JOIN positions pos ON pos.id = ta.position_id
       ${posJ.joins}
       WHERE ta.status = 'P' AND ta.team_id IN (${placeholders})
       ORDER BY ta.created_at, ta.id`,
    )
    .bind(...teamIds)
    .all<ApplicationRow>();
  return results;
}

/** All non-deleted team ids (for admin-scope application review). */
export async function listAllTeamIds(db: D1Database): Promise<number[]> {
  const { results } = await db.prepare(`SELECT id FROM teams WHERE deleted_at IS NULL`).all<{ id: number }>();
  return results.map((r) => r.id);
}

/** True when the person already has a PENDING application for this team. */
export async function hasPendingApplication(db: D1Database, personId: number, teamId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM team_applications WHERE person_id = ? AND team_id = ? AND status = 'P'`)
    .bind(personId, teamId)
    .first<{ x: number }>();
  return row !== null;
}

/**
 * Create a pending application. The partial UNIQUE index (person_id, team_id
 * WHERE status='P') makes a concurrent duplicate a 0-change no-op instead of a
 * 500 — callers pre-check hasPendingApplication for the friendly message.
 */
export async function createApplication(
  db: D1Database,
  personId: number,
  teamId: number,
  positionId: number | null,
  message: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO team_applications (person_id, team_id, position_id, message) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(person_id, team_id) WHERE status = 'P' DO NOTHING`,
    )
    .bind(personId, teamId, positionId, message)
    .run();
}

/**
 * Signed-out apply support: the person for `email` (stored lowercased), or a
 * minimal new one (display_name = name, role 'member', active 1). An existing
 * row — even a soft-deleted one — is returned as-is: applying must never
 * resurrect or overwrite an account. The UNIQUE(email) race between the SELECT
 * and INSERT resolves by re-reading the winner's row.
 */
export async function findOrCreatePersonByEmail(
  db: D1Database,
  email: string,
  name: string,
  phone: string | null,
): Promise<number> {
  const normalized = email.trim().toLowerCase();
  const existing = await db
    .prepare(`SELECT id FROM people WHERE email = ?`)
    .bind(normalized)
    .first<{ id: number }>();
  if (existing) return existing.id;
  try {
    const r = await db
      .prepare(
        `INSERT INTO people (display_name, first_name, last_name, email, phone, role, active)
         VALUES (?1, '', '', ?2, ?3, 'member', 1)`,
      )
      .bind(name, normalized, phone)
      .run();
    return r.meta.last_row_id;
  } catch (e) {
    if (String(e).includes('UNIQUE constraint failed')) {
      const winner = await db
        .prepare(`SELECT id FROM people WHERE email = ?`)
        .bind(normalized)
        .first<{ id: number }>();
      if (winner) return winner.id;
    }
    throw e;
  }
}

/**
 * Approve/reject a pending application. Pass `expectedTeamId` (the team the
 * caller is authorized for) so a leader can't decide another team's application
 * by posting its id. The status flip (guarded by `status = 'P'` so a
 * double-submit can't double-process) and the approve-path membership insert
 * run in one batch. Returns the application's person/team, or null when it was
 * not pending / not on the expected team.
 */
export async function decideApplication(
  db: D1Database,
  applicationId: number,
  approve: boolean,
  deciderEmail: string,
  expectedTeamId?: number,
): Promise<{ person_id: number; team_id: number } | null> {
  const row = await db
    .prepare(
      `SELECT person_id, team_id FROM team_applications
       WHERE id = ?1 AND status = 'P'${expectedTeamId != null ? ' AND team_id = ?2' : ''}`,
    )
    .bind(...(expectedTeamId != null ? [applicationId, expectedTeamId] : [applicationId]))
    .first<{ person_id: number; team_id: number }>();
  if (!row) return null;

  const statements = [
    db
      .prepare(
        `UPDATE team_applications SET status = ?1, decided_by = ?2, decided_at = datetime('now')
         WHERE id = ?3 AND status = 'P'`,
      )
      .bind(approve ? 'A' : 'R', deciderEmail, applicationId),
  ];
  if (approve) {
    statements.push(
      db
        .prepare(
          `INSERT INTO team_members (team_id, person_id) VALUES (?, ?)
           ON CONFLICT(team_id, person_id) DO NOTHING`,
        )
        .bind(row.team_id, row.person_id),
    );
  }
  await db.batch(statements);
  return row;
}

// ── Potential volunteers (leader recruiting aid) ──

export interface PotentialVolunteer {
  person_id: number;
  display_name: string;
  email: string | null;
  via_interest: number;
  via_gift: number;
}

/**
 * People a leader could recruit for a ministry `category`: those who expressed
 * interest in it (person_interests) UNION those whose most recent gifts-quiz
 * result recommended it (so a retake that drops the category removes them),
 * badged by source, excluding current members of `excludeTeamId` and inactive
 * or soft-deleted people.
 */
export async function listPotentialVolunteers(
  db: D1Database,
  category: string,
  excludeTeamId: number,
): Promise<PotentialVolunteer[]> {
  const { results } = await db
    .prepare(
      `WITH candidates AS (
         SELECT person_id, 1 AS via_interest, 0 AS via_gift FROM person_interests WHERE category = ?1
         UNION ALL
         SELECT gift_results.person_id, 0 AS via_interest, 1 AS via_gift
         FROM gift_results, json_each(gift_results.recommended_json)
         WHERE json_each.value = ?1
           AND gift_results.id = (SELECT id FROM gift_results g2 WHERE g2.person_id = gift_results.person_id
                                  ORDER BY g2.created_at DESC, g2.id DESC LIMIT 1)
       )
       SELECT people.id AS person_id, people.display_name AS display_name, people.email AS email,
              MAX(candidates.via_interest) AS via_interest, MAX(candidates.via_gift) AS via_gift
       FROM candidates
       JOIN people ON people.id = candidates.person_id AND people.active = 1 AND people.deleted_at IS NULL
       WHERE people.id NOT IN (SELECT person_id FROM team_members WHERE team_id = ?2)
       GROUP BY people.id
       ORDER BY people.display_name`,
    )
    .bind(category, excludeTeamId)
    .all<PotentialVolunteer>();
  return results;
}

// ── Matrix (next N plans × positions grid) ──

export interface MatrixNeedRow {
  plan_id: number;
  position_id: number;
  needed: number;
  open_signup: number;
}

export interface MatrixRow {
  position_id: number;
  position_name: string;
  team_id: number;
  team_name: string;
}

export interface MatrixAssignmentRow {
  id: number;
  plan_id: number;
  position_id: number;
  person_id: number;
  person_name: string;
  status: 'U' | 'C' | 'D';
}

export interface MatrixData {
  plans: PlanListRow[];
  rows: MatrixRow[];
  needs: MatrixNeedRow[];
  assignments: MatrixAssignmentRow[];
}

/**
 * Grid data for one service type: the next `limit` plans from `fromDate`, the
 * distinct positions those plans need (rows, grouped by team in team/position
 * sort order, localized), every need cell, and every live assignment.
 */
export async function getMatrix(
  db: D1Database,
  serviceTypeId: number,
  fromDate: string,
  limit: number,
  locale: Locale,
): Promise<MatrixData> {
  const plans = await listPlans(db, serviceTypeId, locale, { from: fromDate, limit });
  if (plans.length === 0) return { plans, rows: [], needs: [], assignments: [] };
  const ids = plans.map((p) => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);

  const [{ results: needs }, { results: rows }, { results: assignments }] = await Promise.all([
    db
      .prepare(`SELECT plan_id, position_id, needed, open_signup FROM plan_positions WHERE plan_id IN (${placeholders})`)
      .bind(...ids)
      .all<MatrixNeedRow>(),
    db
      .prepare(
        `SELECT DISTINCT pos.id AS position_id, COALESCE(pos_l.name, pos_d.name) AS position_name,
                tm.id AS team_id, COALESCE(tm_l.name, tm_d.name) AS team_name
         FROM plan_positions pp
         JOIN positions pos ON pos.id = pp.position_id AND pos.deleted_at IS NULL
         ${posJ.joins}
         JOIN teams tm ON tm.id = pos.team_id AND tm.deleted_at IS NULL
         ${tmJ.joins}
         WHERE pp.plan_id IN (${placeholders})
         ORDER BY tm.sort, tm.id, pos.sort, pos.id`,
      )
      .bind(...ids)
      .all<MatrixRow>(),
    db
      .prepare(
        `SELECT ra.id AS id, ra.plan_id AS plan_id, ra.position_id AS position_id,
                ra.person_id AS person_id, people.display_name AS person_name, ra.status AS status
         FROM roster_assignments ra
         JOIN people ON people.id = ra.person_id
         WHERE ra.plan_id IN (${placeholders}) AND ra.deleted_at IS NULL
         ORDER BY ra.id`,
      )
      .bind(...ids)
      .all<MatrixAssignmentRow>(),
  ]);
  return { plans, rows, needs, assignments };
}

// ── Plans-index fill summary ──

export interface PlanFill {
  plan_id: number;
  /** Sum of `needed` across the plan's positions. */
  needed: number;
  /** Non-declined live assignees, capped per position at its `needed`. */
  filled: number;
}

/** Per-plan filled/needed totals for the plans list. */
export async function listPlanFills(db: D1Database, planIds: number[]): Promise<PlanFill[]> {
  if (planIds.length === 0) return [];
  const placeholders = planIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT pp.plan_id AS plan_id, SUM(pp.needed) AS needed,
              SUM(MIN(pp.needed,
                (SELECT COUNT(*) FROM roster_assignments ra
                 WHERE ra.plan_id = pp.plan_id AND ra.position_id = pp.position_id
                   AND ra.status != 'D' AND ra.deleted_at IS NULL))) AS filled
       FROM plan_positions pp
       WHERE pp.plan_id IN (${placeholders})
       GROUP BY pp.plan_id`,
    )
    .bind(...planIds)
    .all<PlanFill>();
  return results;
}
