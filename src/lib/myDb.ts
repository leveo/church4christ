// Person-scoped volunteer queries for the /my* and /profile pages: a person's
// assignments (with localized names), blockout dates (list / add with optional
// weekly-biweekly recurrence / delete single / delete series), team chips,
// serving history, their own applications, ministry interests, and the latest
// gifts-quiz result.
//
// Ported from dcfc-serve/src/lib/db.ts (listPersonAssignments, listBlockouts,
// listPersonTeams, listPersonServingHistory) + adminDb (listApplicationsByPerson)
// + giftDb (interests, latest gift result), adapted to church-cms: localized
// names come from *_i18n companion tables (i18nJoin, en fallback), there is no
// congregation column, and the blockout mutations live here (not inline in the
// page) so the materialize/series-delete semantics are unit-testable.
//
// Authorization: every mutation takes the OWNING person_id and scopes its WHERE
// to it — a volunteer can only ever touch their own rows. Pages pass the
// session user's id, never a form-posted one.
import { i18nJoin, type Locale } from './db';
import { addDays } from './dates';
import type { BlockoutInput } from './validate';

// ── Assignments ──

export interface MyAssignment {
  id: number;
  plan_id: number;
  plan_date: string;
  status: 'U' | 'C' | 'D';
  decline_reason: string | null;
  position_name: string;
  team_name: string;
  service_type_name: string;
}

/** A person's live assignments on/after `fromDate`, soonest first, localized. */
export async function listPersonAssignments(
  db: D1Database,
  personId: number,
  fromDate: string,
  locale: Locale,
): Promise<MyAssignment[]> {
  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT ra.id AS id, plans.id AS plan_id, plans.plan_date AS plan_date,
              ra.status AS status, ra.decline_reason AS decline_reason,
              COALESCE(pos_l.name, pos_d.name) AS position_name,
              COALESCE(tm_l.name, tm_d.name) AS team_name,
              COALESCE(st_l.name, st_d.name) AS service_type_name
       FROM roster_assignments ra
       JOIN plans ON plans.id = ra.plan_id AND plans.deleted_at IS NULL
       JOIN service_types st ON st.id = plans.service_type_id
       ${stJ.joins}
       JOIN positions pos ON pos.id = ra.position_id
       ${posJ.joins}
       JOIN teams tm ON tm.id = pos.team_id
       ${tmJ.joins}
       WHERE ra.person_id = ?1 AND ra.deleted_at IS NULL AND plans.plan_date >= ?2
       ORDER BY plans.plan_date, tm.sort, pos.sort, ra.id`,
    )
    .bind(personId, fromDate)
    .all<MyAssignment>();
  return results;
}

// ── Blockouts ──

export interface BlockoutRow {
  id: number;
  person_id: number;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
  recurrence_group: string | null;
}

/** A person's blockouts still ending on/after `fromDate`, earliest first. */
export async function listBlockouts(db: D1Database, personId: number, fromDate: string): Promise<BlockoutRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, person_id, start_date, end_date, start_time, end_time, reason, recurrence_group
       FROM blockout_dates
       WHERE person_id = ? AND end_date >= ?
       ORDER BY start_date, id`,
    )
    .bind(personId, fromDate)
    .all<BlockoutRow>();
  return results;
}

/**
 * Insert a blockout for `personId` from a parsed form. A weekly/biweekly repeat
 * materializes `count` rows shifted by 7/14 days, all sharing one
 * crypto.randomUUID() recurrence_group so they can be deleted as a series;
 * repeat 'none' inserts a single row with a NULL group. Returns rows inserted.
 */
export async function addBlockout(db: D1Database, personId: number, input: BlockoutInput): Promise<number> {
  const interval = input.repeat === 'weekly' ? 7 : input.repeat === 'biweekly' ? 14 : 0;
  const count = interval ? input.count : 1;
  const group = interval ? crypto.randomUUID() : null;
  const stmts = Array.from({ length: count }, (_, i) =>
    db
      .prepare(
        `INSERT INTO blockout_dates (person_id, start_date, end_date, start_time, end_time, reason, recurrence_group)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        personId,
        addDays(input.startDate, interval * i),
        addDays(input.endDate, interval * i),
        input.startTime,
        input.endTime,
        input.reason,
        group,
      ),
  );
  await db.batch(stmts);
  return count;
}

/** Delete one blockout — scoped to person_id so nobody can delete another's. */
export async function deleteBlockout(db: D1Database, personId: number, id: number): Promise<void> {
  await db.prepare(`DELETE FROM blockout_dates WHERE id = ? AND person_id = ?`).bind(id, personId).run();
}

/** Delete a whole recurrence series — scoped to person_id like deleteBlockout. */
export async function deleteBlockoutSeries(db: D1Database, personId: number, group: string): Promise<void> {
  await db
    .prepare(`DELETE FROM blockout_dates WHERE recurrence_group = ? AND person_id = ?`)
    .bind(group, personId)
    .run();
}

// ── Teams / history / applications (profile pages) ──

export interface PersonTeamRow {
  team_id: number;
  name: string;
  is_leader: number;
}

/** A person's team memberships (localized name + leader flag). */
export async function listPersonTeams(db: D1Database, personId: number, locale: Locale): Promise<PersonTeamRow[]> {
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT tm.id AS team_id, COALESCE(tm_l.name, tm_d.name) AS name, team_members.is_leader AS is_leader
       FROM team_members
       JOIN teams tm ON tm.id = team_members.team_id AND tm.deleted_at IS NULL
       ${tmJ.joins}
       WHERE team_members.person_id = ?
       ORDER BY tm.sort, tm.id`,
    )
    .bind(personId)
    .all<PersonTeamRow>();
  return results;
}

export interface ServingHistoryRow {
  id: number;
  status: 'U' | 'C' | 'D';
  plan_date: string;
  position_name: string;
  team_name: string;
  ministry_name: string | null;
  service_type_name: string;
}

/** A person's entire live serving history (past + future), newest first, localized. */
export async function listPersonServingHistory(
  db: D1Database,
  personId: number,
  locale: Locale,
): Promise<ServingHistoryRow[]> {
  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const minJ = i18nJoin('ministry_i18n', 'min', 'ministry_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT ra.id AS id, ra.status AS status, plans.plan_date AS plan_date,
              COALESCE(pos_l.name, pos_d.name) AS position_name,
              COALESCE(tm_l.name, tm_d.name) AS team_name,
              COALESCE(min_l.name, min_d.name) AS ministry_name,
              COALESCE(st_l.name, st_d.name) AS service_type_name
       FROM roster_assignments ra
       JOIN plans ON plans.id = ra.plan_id AND plans.deleted_at IS NULL
       JOIN service_types st ON st.id = plans.service_type_id
       ${stJ.joins}
       JOIN positions pos ON pos.id = ra.position_id
       ${posJ.joins}
       JOIN teams tm ON tm.id = pos.team_id
       ${tmJ.joins}
       LEFT JOIN ministries min ON min.id = tm.ministry_id AND min.deleted_at IS NULL
       ${minJ.joins}
       WHERE ra.person_id = ? AND ra.deleted_at IS NULL
       ORDER BY plans.plan_date DESC, ra.id DESC`,
    )
    .bind(personId)
    .all<ServingHistoryRow>();
  return results;
}

export interface MyApplicationRow {
  id: number;
  team_id: number;
  team_name: string;
  position_name: string | null;
  status: 'P' | 'A' | 'R';
  created_at: string;
}

/** A person's most recent team applications (newest first, capped at 10). */
export async function listApplicationsByPerson(
  db: D1Database,
  personId: number,
  locale: Locale,
): Promise<MyApplicationRow[]> {
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], locale);
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT ta.id AS id, ta.team_id AS team_id,
              COALESCE(tm_l.name, tm_d.name) AS team_name,
              COALESCE(pos_l.name, pos_d.name) AS position_name,
              ta.status AS status, ta.created_at AS created_at
       FROM team_applications ta
       JOIN teams tm ON tm.id = ta.team_id AND tm.deleted_at IS NULL
       ${tmJ.joins}
       LEFT JOIN positions pos ON pos.id = ta.position_id
       ${posJ.joins}
       WHERE ta.person_id = ?
       ORDER BY ta.created_at DESC, ta.id DESC
       LIMIT 10`,
    )
    .bind(personId)
    .all<MyApplicationRow>();
  return results;
}

// ── Interests & gifts (profile) ──

/** The person's selected ministry-interest categories. */
export async function listPersonInterests(db: D1Database, personId: number): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT category FROM person_interests WHERE person_id = ? ORDER BY category`)
    .bind(personId)
    .all<{ category: string }>();
  return results.map((r) => r.category);
}

/**
 * Replace the person's interests with `categories` (validated by the caller
 * against the known category list). Delete + inserts run in one batch so a
 * failed save can't leave a half-replaced set.
 */
export async function setPersonInterests(db: D1Database, personId: number, categories: string[]): Promise<void> {
  const unique = [...new Set(categories)];
  const stmts = [db.prepare(`DELETE FROM person_interests WHERE person_id = ?`).bind(personId)];
  for (const c of unique) {
    stmts.push(db.prepare(`INSERT INTO person_interests (person_id, category) VALUES (?, ?)`).bind(personId, c));
  }
  await db.batch(stmts);
}

export interface GiftResultRow {
  top_gifts: string[];
  recommended: string[];
  created_at: string;
}

/** The person's most recent gifts-quiz result, JSON columns parsed (null-safe). */
export async function getLatestGiftResult(db: D1Database, personId: number): Promise<GiftResultRow | null> {
  const row = await db
    .prepare(
      `SELECT top_gifts_json, recommended_json, created_at FROM gift_results
       WHERE person_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(personId)
    .first<{ top_gifts_json: string; recommended_json: string; created_at: string }>();
  if (!row) return null;
  const parse = (json: string): string[] => {
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  };
  return { top_gifts: parse(row.top_gifts_json), recommended: parse(row.recommended_json), created_at: row.created_at };
}
