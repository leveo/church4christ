import type { AppDb } from './appDb';
import type { CampusContext } from './campusDb';
import type { SessionUser } from './types';

export type CampusSessionUser = SessionUser & {
  campusMode: 'all' | 'campus';
  campus: { id: number; slug: string; name: string } | null;
};

export async function applyCampusContextToUser(
  db: AppDb,
  user: SessionUser,
  context: CampusContext,
): Promise<CampusSessionUser | null> {
  if (context.mode === 'all' && !user.isSuperAdmin) return null;
  if (context.mode === 'campus' && !context.campus) return null;
  if (!user.isSuperAdmin) {
    if (!context.membership || context.membership.personId !== user.id || context.membership.active !== 1) {
      return null;
    }
  }

  const campusId = context.mode === 'campus' ? context.campus!.id : null;
  const { results } = await db.prepare(
    `SELECT tm.team_id, tm.is_leader
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id AND t.deleted_at IS NULL
     WHERE tm.person_id = ?1 ${campusId === null ? '' : 'AND t.campus_id = ?2'}
     ORDER BY tm.team_id`,
  ).bind(...(campusId === null ? [user.id] : [user.id, campusId]))
    .all<{ team_id: number; is_leader: number }>();

  const membership = context.membership;
  const role = user.isSuperAdmin ? user.role : membership!.role;
  return {
    ...user,
    role,
    isAdmin: user.isSuperAdmin || role === 'admin',
    isEditor: !user.isSuperAdmin && role === 'editor',
    finance: user.isSuperAdmin ? user.finance : membership!.finance,
    adminAreas: user.isSuperAdmin ? user.adminAreas : membership!.adminAreas,
    memberTeamIds: results.map(({ team_id }) => team_id),
    leaderTeamIds: results.filter(({ is_leader }) => is_leader === 1).map(({ team_id }) => team_id),
    campusMode: context.mode,
    campus: context.campus
      ? { id: context.campus.id, slug: context.campus.slug, name: context.campus.name }
      : null,
  };
}
