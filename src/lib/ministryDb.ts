// Ministry detail + serve-landing read queries. `getMinistryBySlug` assembles a
// single active ministry with its serving teams (localized names, member counts,
// leader names, position chips, and open-signup counts on future plans);
// `listPublishedTestimonies` returns approved testimonies for the serve strip,
// ordering the requested locale first and other-locale rows after (so the page
// can badge them). Localized text flows through the shared i18nJoin builder so a
// missing zh row falls back to English. Every query filters soft-deletes.
import { i18nJoin, type Locale } from './db';

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
  db: D1Database,
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
                     AND pl.deleted_at IS NULL AND pl.plan_date >= date('now')
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
}

/**
 * Approved (status='A'), non-deleted testimonies for the serve strip. Rows in the
 * requested locale come first, then other-locale rows; within each group the
 * newest published_at wins. Capped at `limit`.
 */
export async function listPublishedTestimonies(
  db: D1Database,
  locale: Locale,
  limit: number,
): Promise<TestimonyCardRow[]> {
  const { results } = await db
    .prepare(
      `SELECT author_name AS authorName, title, body, locale
       FROM testimonies
       WHERE status = 'A' AND deleted_at IS NULL
       ORDER BY (CASE WHEN locale = ?1 THEN 0 ELSE 1 END), published_at DESC, id DESC
       LIMIT ?2`,
    )
    .bind(locale, limit)
    .all<TestimonyCardRow>();
  return results;
}
