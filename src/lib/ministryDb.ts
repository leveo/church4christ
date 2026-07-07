// Ministry detail + serve-landing read queries. `getMinistryBySlug` assembles a
// single active ministry with its serving teams (localized names, member counts,
// leader names, position chips, and open-signup counts on future plans);
// `listPublishedTestimonies` returns approved testimonies for the serve strip,
// ordering the requested locale first and other-locale rows after (so the page
// can badge them). Localized text flows through the shared i18nJoin builder so a
// missing zh row falls back to English. Every query filters soft-deletes.
//
// The admin-console reads/writes (ministry summaries table, active toggle, and
// the 4-step new-ministry wizard) are ported from the reference stack's ministryDb,
// adapted to church-cms's i18n companion tables (no name/category columns on
// teams; localized names in *_i18n) and slug-keyed ministries.
import type { AppDb } from './appDb';
import { i18nJoin, type Locale } from './db';
import { addDays, nextWeekday, todayInTz } from './dates';
import { ensureWeeklyPlans, setPlanPosition } from './planDb';
import type { SessionUser } from './types';

const TZ = 'America/Chicago';

export interface MinistryPositionDetail {
  id: number;
  name: string;
}

export interface MinistryTeamDetail {
  id: number;
  name: string;
  memberCount: number;
  leaderNames: string[];
  openSignupCount: number;
  positions: MinistryPositionDetail[];
}

export interface MinistryDetail {
  id: number;
  slug: string;
  category: string;
  icon: string;
  coverKey: string | null;
  meetingTime: string | null;
  name: string;
  intro: string;
  leaderName: string | null;
  teams: MinistryTeamDetail[];
}

interface MinistryHeadRow {
  id: number;
  slug: string;
  category: string;
  icon: string;
  coverKey: string | null;
  meetingTime: string | null;
  name: string;
  intro: string;
  leaderName: string | null;
}

interface TeamRow {
  id: number;
  name: string;
  memberCount: number;
  openSignupCount: number;
}

/**
 * A single active, non-deleted ministry by slug, with its serving teams. Returns
 * null for an unknown, inactive, or soft-deleted slug. name/intro/team-name/
 * position-name are localized with an en fallback; leaderName is the named
 * leader's display_name (null if unset/deleted). Per team: distinct non-deleted
 * members, leader display_names, non-deleted position chips, and openSignupCount
 * — open-signup plan positions on future (plan_date >= today), non-deleted plans.
 */
export async function getMinistryBySlug(
  db: AppDb,
  slug: string,
  locale: Locale,
): Promise<MinistryDetail | null> {
  const { select, joins } = i18nJoin('ministry_i18n', 'm', 'ministry_id', ['name', 'intro'], locale);
  const ministry = await db
    .prepare(
      `SELECT m.id AS id, m.slug AS slug, m.category AS category, m.icon AS icon,
              m.cover_key AS coverKey, m.meeting_time AS meetingTime,
              ${select}, ldr.display_name AS leaderName
       FROM ministries m
       ${joins}
       LEFT JOIN people ldr ON ldr.id = m.leader_person_id AND ldr.deleted_at IS NULL
       WHERE m.slug = ?1 AND m.active = 1 AND m.deleted_at IS NULL`,
    )
    .bind(slug)
    .first<MinistryHeadRow>();
  if (!ministry) return null;

  const teamJoin = i18nJoin('team_i18n', 't', 'team_id', ['name'], locale);
  const posJoin = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);

  const [{ results: teams }, { results: leaders }, { results: positions }] = await Promise.all([
    db
      .prepare(
        `SELECT t.id AS id, ${teamJoin.select},
                (SELECT COUNT(DISTINCT tm.person_id) FROM team_members tm
                   JOIN people p ON p.id = tm.person_id AND p.deleted_at IS NULL
                   WHERE tm.team_id = t.id) AS memberCount,
                (SELECT COUNT(*) FROM plan_positions pp
                   JOIN plans pl ON pl.id = pp.plan_id
                     -- 2-arg date(): Postgres parses the bare 1-arg form as a CAST to the
                     -- date type, never our compat function; 2-arg is identical on SQLite/D1.
                     AND pl.deleted_at IS NULL AND pl.plan_date >= date('now', 'start of day')
                   JOIN positions pos ON pos.id = pp.position_id
                     AND pos.deleted_at IS NULL AND pos.team_id = t.id
                   WHERE pp.open_signup = 1) AS openSignupCount
         FROM teams t
         ${teamJoin.joins}
         WHERE t.ministry_id = ?1 AND t.deleted_at IS NULL
         ORDER BY t.sort, t.id`,
      )
      .bind(ministry.id)
      .all<TeamRow>(),
    db
      .prepare(
        `SELECT tm.team_id AS teamId, ppl.display_name AS name
         FROM team_members tm
         JOIN people ppl ON ppl.id = tm.person_id AND ppl.deleted_at IS NULL
         JOIN teams t ON t.id = tm.team_id AND t.deleted_at IS NULL
         WHERE t.ministry_id = ?1 AND tm.is_leader = 1
         ORDER BY tm.team_id, ppl.display_name`,
      )
      .bind(ministry.id)
      .all<{ teamId: number; name: string }>(),
    db
      .prepare(
        `SELECT pos.id AS id, pos.team_id AS teamId, ${posJoin.select}
         FROM positions pos
         ${posJoin.joins}
         JOIN teams t ON t.id = pos.team_id AND t.deleted_at IS NULL
         WHERE t.ministry_id = ?1 AND pos.deleted_at IS NULL
         ORDER BY pos.sort, pos.id`,
      )
      .bind(ministry.id)
      .all<{ id: number; teamId: number; name: string }>(),
  ]);

  return {
    ...ministry,
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      memberCount: t.memberCount,
      openSignupCount: t.openSignupCount,
      leaderNames: leaders.filter((l) => l.teamId === t.id).map((l) => l.name),
      positions: positions.filter((p) => p.teamId === t.id).map((p) => ({ id: p.id, name: p.name })),
    })),
  };
}

export interface TestimonyCardRow {
  authorName: string;
  title: string;
  body: string;
  /** The row's own locale — badge it when it differs from the requested one. */
  locale: Locale;
  /** Publish timestamp (SQL datetime) — used for the date on the full page. */
  publishedAt: string | null;
}

/**
 * Approved (status='A'), non-deleted testimonies for the serve strip. Rows in the
 * requested locale come first, then other-locale rows; within each group the
 * newest published_at wins. Capped at `limit`.
 */
export async function listPublishedTestimonies(
  db: AppDb,
  locale: Locale,
  limit: number,
): Promise<TestimonyCardRow[]> {
  const { results } = await db
    .prepare(
      `SELECT author_name AS authorName, title, body, locale, published_at AS publishedAt
       FROM testimonies
       WHERE status = 'A' AND deleted_at IS NULL
       ORDER BY (CASE WHEN locale = ?1 THEN 0 ELSE 1 END), published_at DESC, id DESC
       LIMIT ?2`,
    )
    .bind(locale, limit)
    .all<TestimonyCardRow>();
  return results;
}

// ── Admin console: ministry management + new-ministry wizard ──

export interface MinistrySummary {
  id: number;
  name: string;
  category: string;
  icon: string;
  active: number;
  team_count: number;
  member_count: number;
  roles_count: number;
  open_count: number;
}

/**
 * Every ministry (active or not, non-deleted) with team/member/role/open-slot
 * aggregates for the console Ministries table. `fromDate` scopes "open roles" to
 * upcoming plans. Names are localized (en fallback).
 */
export async function listMinistrySummaries(db: AppDb, locale: Locale, fromDate: string): Promise<MinistrySummary[]> {
  const minJ = i18nJoin('ministry_i18n', 'm', 'ministry_id', ['name'], locale);
  const { results } = await db
    .prepare(
      `SELECT m.id AS id, COALESCE(m_l.name, m_d.name) AS name, m.category AS category,
              m.icon AS icon, m.active AS active,
              (SELECT COUNT(*) FROM teams t WHERE t.ministry_id = m.id AND t.deleted_at IS NULL) AS team_count,
              (SELECT COUNT(DISTINCT tm.person_id) FROM team_members tm
                 JOIN teams t ON t.id = tm.team_id AND t.deleted_at IS NULL AND t.ministry_id = m.id
                 JOIN people p ON p.id = tm.person_id AND p.deleted_at IS NULL) AS member_count,
              (SELECT COUNT(*) FROM positions pos
                 JOIN teams t ON t.id = pos.team_id AND t.deleted_at IS NULL AND t.ministry_id = m.id
                 WHERE pos.deleted_at IS NULL) AS roles_count,
              (SELECT COALESCE(SUM(MAX(0, pp.needed - (
                   SELECT COUNT(*) FROM roster_assignments ra
                   WHERE ra.plan_id = pp.plan_id AND ra.position_id = pp.position_id
                     AND ra.status != 'D' AND ra.deleted_at IS NULL))), 0)
                 FROM plan_positions pp
                 JOIN plans pl ON pl.id = pp.plan_id AND pl.deleted_at IS NULL AND pl.plan_date >= ?1
                 JOIN positions pos ON pos.id = pp.position_id AND pos.deleted_at IS NULL
                 JOIN teams t ON t.id = pos.team_id AND t.deleted_at IS NULL AND t.ministry_id = m.id) AS open_count
       FROM ministries m
       ${minJ.joins}
       WHERE m.deleted_at IS NULL
       ORDER BY m.sort, m.id`,
    )
    .bind(fromDate)
    .all<MinistrySummary>();
  return results;
}

export interface MinistryEditRow {
  id: number;
  name_en: string | null;
  name_zh: string | null;
  intro_en: string | null;
  intro_zh: string | null;
  category: string;
  icon: string;
  leader_person_id: number | null;
}

/** Both-locale names/intros + basics for every non-deleted ministry (edit forms). */
export async function listMinistryEditRows(db: AppDb): Promise<MinistryEditRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id AS id, m.category AS category, m.icon AS icon, m.leader_person_id AS leader_person_id,
              en.name AS name_en, zh.name AS name_zh, en.intro AS intro_en, zh.intro AS intro_zh
       FROM ministries m
       LEFT JOIN ministry_i18n en ON en.ministry_id = m.id AND en.locale = 'en'
       LEFT JOIN ministry_i18n zh ON zh.ministry_id = m.id AND zh.locale = 'zh'
       WHERE m.deleted_at IS NULL
       ORDER BY m.sort, m.id`,
    )
    .all<MinistryEditRow>();
  return results;
}

/** True if the user may manage this ministry (admin, its named leader, or leads one of its teams). */
export async function canManageMinistry(db: AppDb, user: SessionUser, ministryId: number): Promise<boolean> {
  if (user.isAdmin) return true;
  const m = await db
    .prepare(`SELECT leader_person_id FROM ministries WHERE id = ? AND deleted_at IS NULL`)
    .bind(ministryId)
    .first<{ leader_person_id: number | null }>();
  if (!m) return false;
  if (m.leader_person_id === user.id) return true;
  const { results } = await db
    .prepare(`SELECT id FROM teams WHERE ministry_id = ? AND deleted_at IS NULL`)
    .bind(ministryId)
    .all<{ id: number }>();
  return results.some((t) => user.leaderTeamIds.includes(t.id));
}

/** Ministry ids the user leads (named leader ∪ ministries of teams they lead). */
export async function leaderMinistryIds(db: AppDb, user: SessionUser): Promise<number[]> {
  const ids = new Set<number>();
  const named = await db
    .prepare(`SELECT id FROM ministries WHERE leader_person_id = ? AND deleted_at IS NULL`)
    .bind(user.id)
    .all<{ id: number }>();
  for (const r of named.results) ids.add(r.id);
  if (user.leaderTeamIds.length > 0) {
    const placeholders = user.leaderTeamIds.map(() => '?').join(',');
    const viaTeams = await db
      .prepare(`SELECT DISTINCT ministry_id FROM teams WHERE id IN (${placeholders}) AND ministry_id IS NOT NULL AND deleted_at IS NULL`)
      .bind(...user.leaderTeamIds)
      .all<{ ministry_id: number }>();
    for (const r of viaTeams.results) ids.add(r.ministry_id);
  }
  return [...ids];
}

export async function toggleMinistryActive(db: AppDb, id: number, active: boolean): Promise<void> {
  await db.prepare(`UPDATE ministries SET active = ? WHERE id = ?`).bind(active ? 1 : 0, id).run();
}

export interface MinistryBasics {
  name_en: string;
  name_zh: string;
  category: string;
  icon: string;
  intro_en: string | null;
  intro_zh: string | null;
  leader_person_id: number | null;
}

/** Update a ministry's editable basics (used by the Ministries-tab inline edit). */
export async function updateMinistryBasics(db: AppDb, id: number, b: MinistryBasics): Promise<void> {
  await db
    .prepare(`UPDATE ministries SET category = ?1, icon = ?2, leader_person_id = ?3 WHERE id = ?4`)
    .bind(b.category, b.icon || '📋', b.leader_person_id, id)
    .run();
  await upsertI18n(db, 'ministry_i18n', 'ministry_id', id, 'en', { name: b.name_en || b.name_zh, intro: b.intro_en ?? '' });
  if (b.name_zh) await upsertI18n(db, 'ministry_i18n', 'ministry_id', id, 'zh', { name: b.name_zh, intro: b.intro_zh ?? '' });
}

/** Upsert a companion-table i18n row (columns validated by the caller's literals). */
async function upsertI18n(
  db: AppDb,
  table: 'ministry_i18n' | 'team_i18n' | 'position_i18n' | 'service_type_i18n',
  fk: string,
  id: number,
  locale: Locale,
  cols: Record<string, string>,
): Promise<void> {
  const names = Object.keys(cols);
  const set = names.map((n) => `${n} = excluded.${n}`).join(', ');
  const placeholders = names.map((_, i) => `?${i + 3}`).join(', ');
  await db
    .prepare(
      `INSERT INTO ${table} (${fk}, locale, ${names.join(', ')}) VALUES (?1, ?2, ${placeholders})
       ON CONFLICT(${fk}, locale) DO UPDATE SET ${set}`,
    )
    .bind(id, locale, ...names.map((n) => cols[n]))
    .run();
}

export interface WizardPosition {
  name_en: string;
  name_zh: string;
  needed: number;
  open: boolean;
}

export interface MinistryWizardInput {
  name_en: string;
  name_zh: string;
  category: string;
  icon: string;
  intro_en: string | null;
  intro_zh: string | null;
  leader_person_id: number | null;
  meeting_time: string | null;
  positions: WizardPosition[];
  frequency: 'sun' | 'sat' | 'biweekly' | 'monthly' | 'irregular';
  autoGenerate: boolean;
}

/** ASCII slug from a name, collapsing to a safe token; '' when nothing survives. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** A slug not yet taken (appends -2, -3, … on collision). */
async function uniqueSlug(db: AppDb, base: string): Promise<string> {
  const root = base || 'ministry';
  let candidate = root;
  for (let n = 2; ; n++) {
    const hit = await db.prepare(`SELECT 1 AS x FROM ministries WHERE slug = ?`).bind(candidate).first<{ x: number }>();
    if (!hit) return candidate;
    candidate = `${root}-${n}`;
  }
}

/**
 * Create a ministry plus its first team, positions, the named leader's team
 * membership, and — only for a weekly frequency (Sun/Sat) with autoGenerate — a
 * matching service type and 8 weeks of plans with the position needs applied.
 * Returns the new ministry id.
 *
 * D1 has no cross-statement transaction here, so the inserts run SEQUENTIALLY; a
 * mid-way failure can leave a partial ministry, which an admin can clean up. This
 * is intentional and documented — the wizard is a low-frequency admin action.
 */
export async function createMinistryFromWizard(
  db: AppDb,
  input: MinistryWizardInput,
  now: Date = new Date(),
): Promise<number> {
  const enName = input.name_en || input.name_zh;
  const slug = await uniqueSlug(db, slugify(input.name_en || input.name_zh));

  const ministry = await db
    .prepare(
      `INSERT INTO ministries (slug, category, icon, leader_person_id, meeting_time, active, sort)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, COALESCE((SELECT MAX(sort) + 1 FROM ministries), 1))
       RETURNING id`,
    )
    .bind(slug, input.category, input.icon || '📋', input.leader_person_id, input.meeting_time)
    .first<{ id: number }>();
  const ministryId = ministry!.id;

  await upsertI18n(db, 'ministry_i18n', 'ministry_id', ministryId, 'en', { name: enName, intro: input.intro_en ?? '' });
  if (input.name_zh) await upsertI18n(db, 'ministry_i18n', 'ministry_id', ministryId, 'zh', { name: input.name_zh, intro: input.intro_zh ?? '' });

  const team = await db
    .prepare(`INSERT INTO teams (ministry_id, sort) VALUES (?1, 0) RETURNING id`)
    .bind(ministryId)
    .first<{ id: number }>();
  const teamId = team!.id;
  await upsertI18n(db, 'team_i18n', 'team_id', teamId, 'en', { name: enName });
  if (input.name_zh) await upsertI18n(db, 'team_i18n', 'team_id', teamId, 'zh', { name: input.name_zh });

  // The ministry's named leader becomes a team leader automatically.
  if (input.leader_person_id) {
    await db
      .prepare(
        `INSERT INTO team_members (team_id, person_id, is_leader) VALUES (?1, ?2, 1)
         ON CONFLICT(team_id, person_id) DO UPDATE SET is_leader = 1`,
      )
      .bind(teamId, input.leader_person_id)
      .run();
  }

  const positionIds: number[] = [];
  for (let i = 0; i < input.positions.length; i++) {
    const p = input.positions[i];
    const row = await db.prepare(`INSERT INTO positions (team_id, sort) VALUES (?1, ?2) RETURNING id`).bind(teamId, i).first<{ id: number }>();
    positionIds.push(row!.id);
    await upsertI18n(db, 'position_i18n', 'position_id', row!.id, 'en', { name: p.name_en || p.name_zh });
    if (p.name_zh) await upsertI18n(db, 'position_i18n', 'position_id', row!.id, 'zh', { name: p.name_zh });
  }

  // Only weekly frequencies auto-generate plans; other cadences leave the leader
  // to create plans manually, so we don't spawn an orphan service type for them.
  const weekday = input.frequency === 'sat' ? 6 : input.frequency === 'sun' ? 0 : null;
  if (weekday !== null && input.autoGenerate) {
    const serviceType = await db
      .prepare(`INSERT INTO service_types (sort) VALUES (COALESCE((SELECT MAX(sort) + 1 FROM service_types), 1)) RETURNING id`)
      .first<{ id: number }>();
    const serviceTypeId = serviceType!.id;
    await upsertI18n(db, 'service_type_i18n', 'service_type_id', serviceTypeId, 'en', { name: enName });
    if (input.name_zh) await upsertI18n(db, 'service_type_i18n', 'service_type_id', serviceTypeId, 'zh', { name: input.name_zh });

    // 8 occurrences: the next `weekday` through 7 weeks later, inclusive.
    const first = nextWeekday(todayInTz(TZ, now), weekday);
    await ensureWeeklyPlans(db, serviceTypeId, weekday, addDays(first, 49), now);

    const { results: plans } = await db
      .prepare(`SELECT id FROM plans WHERE service_type_id = ? AND deleted_at IS NULL`)
      .bind(serviceTypeId)
      .all<{ id: number }>();
    for (const plan of plans) {
      for (let i = 0; i < input.positions.length; i++) {
        await setPlanPosition(db, plan.id, positionIds[i], input.positions[i].needed, input.positions[i].open);
      }
    }
  }

  return ministryId;
}
