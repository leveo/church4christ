// Admin console Overview data + the per-person serving report. Everything is
// role-scoped: 'admin' sees the whole church; 'leader' sees only the teams they
// lead (via SessionUser.leaderTeamIds). Ported from the reference stack's adminOverviewDb,
// adapted to church-cms: localized names come from *_i18n companion tables,
// hrefs are locale-prefixed serve routes, and testimonies use the shared status.
import { i18nJoin, type Locale } from './db';
import type { SessionUser } from './types';

export type Scope = 'admin' | 'leader';

export interface StatCard {
  value: number;
  key: 'people' | 'ministries' | 'plans' | 'apps' | 'members' | 'unfilled';
}

function leaderTeamFilter(user: SessionUser): { clause: string; binds: number[] } {
  if (user.leaderTeamIds.length === 0) return { clause: '0', binds: [] };
  const placeholders = user.leaderTeamIds.map(() => '?').join(',');
  return { clause: `teams.id IN (${placeholders})`, binds: user.leaderTeamIds };
}

/** Four headline counts for the Overview cards, scoped by role. */
export async function getStats(db: D1Database, scope: Scope, user: SessionUser, fromDate: string): Promise<StatCard[]> {
  if (scope === 'admin') {
    const [people, ministries, plans, apps] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS n FROM people WHERE active = 1 AND deleted_at IS NULL`).first<{ n: number }>(),
      db.prepare(`SELECT COUNT(*) AS n FROM ministries WHERE deleted_at IS NULL`).first<{ n: number }>(),
      db.prepare(`SELECT COUNT(*) AS n FROM plans WHERE plan_date >= ? AND deleted_at IS NULL`).bind(fromDate).first<{ n: number }>(),
      db.prepare(`SELECT COUNT(*) AS n FROM team_applications WHERE status = 'P'`).first<{ n: number }>(),
    ]);
    return [
      { value: people?.n ?? 0, key: 'people' },
      { value: ministries?.n ?? 0, key: 'ministries' },
      { value: plans?.n ?? 0, key: 'plans' },
      { value: apps?.n ?? 0, key: 'apps' },
    ];
  }

  const { clause, binds } = leaderTeamFilter(user);
  const [members, apps, plans, unfilled] = await Promise.all([
    db.prepare(
      `SELECT COUNT(DISTINCT team_members.person_id) AS n FROM team_members
       JOIN teams ON teams.id = team_members.team_id AND teams.deleted_at IS NULL
       WHERE ${clause}`,
    ).bind(...binds).first<{ n: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS n FROM team_applications
       JOIN teams ON teams.id = team_applications.team_id
       WHERE team_applications.status = 'P' AND ${clause}`,
    ).bind(...binds).first<{ n: number }>(),
    db.prepare(
      `SELECT COUNT(DISTINCT plans.id) AS n FROM plans
       JOIN plan_positions ON plan_positions.plan_id = plans.id
       JOIN positions ON positions.id = plan_positions.position_id
       JOIN teams ON teams.id = positions.team_id
       WHERE plans.plan_date >= ? AND plans.deleted_at IS NULL AND ${clause}`,
    ).bind(fromDate, ...binds).first<{ n: number }>(),
    db.prepare(
      `SELECT COALESCE(SUM(MAX(0, plan_positions.needed - (
         SELECT COUNT(*) FROM roster_assignments
         WHERE roster_assignments.plan_id = plan_positions.plan_id
           AND roster_assignments.position_id = plan_positions.position_id
           AND roster_assignments.status != 'D' AND roster_assignments.deleted_at IS NULL))), 0) AS n
       FROM plan_positions
       JOIN plans ON plans.id = plan_positions.plan_id AND plans.deleted_at IS NULL AND plans.plan_date >= ?
       JOIN positions ON positions.id = plan_positions.position_id
       JOIN teams ON teams.id = positions.team_id
       WHERE ${clause}`,
    ).bind(fromDate, ...binds).first<{ n: number }>(),
  ]);
  return [
    { value: members?.n ?? 0, key: 'members' },
    { value: apps?.n ?? 0, key: 'apps' },
    { value: plans?.n ?? 0, key: 'plans' },
    { value: unfilled?.n ?? 0, key: 'unfilled' },
  ];
}

export interface AttentionItem {
  icon: string;
  kind: 'apps' | 'testimonies' | 'understaffed' | 'stale';
  zh: string;
  en: string;
  href: string;
}

/**
 * Actionable items for the Overview "needs your attention" panel: pending
 * applications, pending testimonies (admin only), understaffed upcoming plans
 * (filled < needed within 14 days), and stale unconfirmed requests (notified >3
 * days ago). Names are localized in `locale`; hrefs point at the console tabs and
 * locale-prefixed serve routes.
 */
export async function getNeedsAttention(
  db: D1Database,
  scope: Scope,
  user: SessionUser,
  fromDate: string,
  toDate: string,
  locale: Locale,
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const { clause, binds } = scope === 'leader' ? leaderTeamFilter(user) : { clause: '1', binds: [] as number[] };
  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], locale);
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], locale);

  const [apps, testi, understaffed, stale] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS n FROM team_applications
       JOIN teams ON teams.id = team_applications.team_id
       WHERE team_applications.status = 'P' AND ${clause}`,
    ).bind(...binds).first<{ n: number }>(),
    scope === 'admin'
      ? db.prepare(`SELECT COUNT(*) AS n FROM testimonies WHERE status = 'P' AND deleted_at IS NULL`).first<{ n: number }>()
      : Promise.resolve(null),
    db.prepare(
      `SELECT plans.id AS id, plans.plan_date AS plan_date, COALESCE(st_l.name, st_d.name) AS service_name,
              SUM(MAX(0, plan_positions.needed - (
                SELECT COUNT(*) FROM roster_assignments
                WHERE roster_assignments.plan_id = plan_positions.plan_id
                  AND roster_assignments.position_id = plan_positions.position_id
                  AND roster_assignments.status != 'D' AND roster_assignments.deleted_at IS NULL))) AS gap
       FROM plan_positions
       JOIN plans ON plans.id = plan_positions.plan_id AND plans.deleted_at IS NULL
         AND plans.plan_date >= ?1 AND plans.plan_date <= ?2
       JOIN service_types st ON st.id = plans.service_type_id
       ${stJ.joins}
       JOIN positions ON positions.id = plan_positions.position_id
       JOIN teams ON teams.id = positions.team_id
       WHERE ${clause}
       GROUP BY plans.id HAVING gap > 0
       ORDER BY plans.plan_date LIMIT 3`,
    ).bind(fromDate, toDate, ...binds).all<{ id: number; plan_date: string; service_name: string; gap: number }>(),
    db.prepare(
      `SELECT people.display_name AS name, plans.plan_date AS plan_date, COALESCE(pos_l.name, pos_d.name) AS position_name
       FROM roster_assignments
       JOIN people ON people.id = roster_assignments.person_id
       JOIN plans ON plans.id = roster_assignments.plan_id AND plans.deleted_at IS NULL AND plans.plan_date >= ?
       JOIN positions pos ON pos.id = roster_assignments.position_id
       ${posJ.joins}
       JOIN teams ON teams.id = pos.team_id
       WHERE roster_assignments.status = 'U' AND roster_assignments.deleted_at IS NULL
         AND roster_assignments.notified_at IS NOT NULL
         AND roster_assignments.notified_at < datetime('now', '-3 days')
         AND ${clause}
       ORDER BY roster_assignments.notified_at LIMIT 3`,
    ).bind(fromDate, ...binds).all<{ name: string; plan_date: string; position_name: string }>(),
  ]);

  if ((apps?.n ?? 0) > 0) {
    items.push({
      icon: '📥', kind: 'apps', href: '/admin/ministries?tab=applications',
      zh: `${apps!.n} 笔新的事奉申请等待审核`, en: `${apps!.n} new serving applications await review`,
    });
  }
  if ((testi?.n ?? 0) > 0) {
    items.push({
      icon: '✍️', kind: 'testimonies', href: '/admin/testimonies',
      zh: `${testi!.n} 篇见证待审核发布`, en: `${testi!.n} testimonies pending publication`,
    });
  }
  for (const p of understaffed.results) {
    items.push({
      icon: '⚠️', kind: 'understaffed', href: `/${locale}/serve/plans/${p.id}`,
      zh: `${p.plan_date} ${p.service_name} 仍缺 ${p.gap} 个岗位`, en: `${p.plan_date} ${p.service_name} still needs ${p.gap} role(s)`,
    });
  }
  for (const s of stale.results) {
    items.push({
      icon: '⏳', kind: 'stale', href: `/${locale}/serve/matrix`,
      zh: `${s.name} 尚未回覆 ${s.plan_date} ${s.position_name} 的邀请`,
      en: `${s.name} hasn't replied to the ${s.plan_date} ${s.position_name} request`,
    });
  }

  return items;
}

// ── Serving report (admin): per-person activity for burnout / re-engagement ──

export interface ServeReportRow {
  person_id: number;
  name: string;
  email: string | null;
  confirmed: number; // past+present confirmed serves
  upcoming: number; // future non-declined
  declines: number;
  last_served: string | null;
}

/** Per-person serving tallies since `fromDate`, busiest first. Admin-only. */
export async function listServeReport(db: D1Database, fromDate: string, today: string): Promise<ServeReportRow[]> {
  const { results } = await db
    .prepare(
      `SELECT people.id AS person_id, people.display_name AS name, people.email AS email,
              SUM(CASE WHEN ra.status = 'C' AND plans.plan_date <= ?2 THEN 1 ELSE 0 END) AS confirmed,
              SUM(CASE WHEN ra.status != 'D' AND plans.plan_date > ?2 THEN 1 ELSE 0 END) AS upcoming,
              SUM(CASE WHEN ra.status = 'D' THEN 1 ELSE 0 END) AS declines,
              MAX(CASE WHEN ra.status = 'C' AND plans.plan_date <= ?2 THEN plans.plan_date END) AS last_served
       FROM people
       JOIN roster_assignments ra ON ra.person_id = people.id AND ra.deleted_at IS NULL
       JOIN plans ON plans.id = ra.plan_id AND plans.deleted_at IS NULL AND plans.plan_date >= ?1
       WHERE people.deleted_at IS NULL
       GROUP BY people.id
       ORDER BY confirmed DESC, upcoming DESC`,
    )
    .bind(fromDate, today)
    .all<ServeReportRow>();
  return results;
}
