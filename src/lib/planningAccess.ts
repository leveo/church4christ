// Who may see or manage a planning event. Admins need the `planning` area
// grant (super admins pass); coordinators are scoped per event; participants
// (called to a non-draft session, or owners of a run-sheet item directly or via
// a team) may read a non-draft event. Everyone else gets nothing.
import type { AppDb } from './appDb';
import { hasAreaAccess } from './adminAreas';
import { copyRunSheet, isCoordinator, listCoordinatedEventIds, type PlanningEvent } from './planningDb';
import type { SessionUser } from './types';

export type PlanningRole = 'admin' | 'coordinator' | 'participant';

export function isPlanningAdmin(user: SessionUser | null): boolean {
  return Boolean(user?.isAdmin) && hasAreaAccess(user, 'planning');
}

export async function isParticipant(db: AppDb, eventId: number, personId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT e.id AS id FROM planning_events e
       WHERE e.id = ?1 AND e.status <> 'draft' AND (
         EXISTS (
           SELECT 1 FROM planning_session_people sp
           JOIN planning_sessions s ON s.id = sp.session_id
           WHERE s.event_id = e.id AND sp.person_id = ?2 AND s.status <> 'draft')
         OR EXISTS (
           SELECT 1 FROM planning_items i
           WHERE i.event_id = e.id AND (
             i.owner_person_id = ?2
             OR i.owner_team_id IN (SELECT tmm.team_id FROM team_members tmm WHERE tmm.person_id = ?2))))`,
    )
    .bind(eventId, personId)
    .first();
  return row !== null;
}

/** The strongest role the user holds on the event, or null. */
export async function planningRole(
  db: AppDb,
  user: SessionUser | null,
  event: Pick<PlanningEvent, 'id'>,
): Promise<PlanningRole | null> {
  if (!user) return null;
  if (isPlanningAdmin(user)) return 'admin';
  if (await isCoordinator(db, event.id, user.id)) return 'coordinator';
  if (await isParticipant(db, event.id, user.id)) return 'participant';
  return null;
}

export const canManage = (role: PlanningRole | null): boolean => role === 'admin' || role === 'coordinator';

// ── Who a coordinator may call or attach ──

export interface CallableScope {
  /** Person ids that may be called or attached; null = unrestricted (planning admin). */
  people: Set<number> | null;
  /** Team ids that may be added or set as owners; null = unrestricted. */
  teams: Set<number> | null;
}

/**
 * Planning admins may call anyone. A non-admin coordinator is limited to the
 * members of serve teams they lead (team_members.is_leader = 1) and of teams
 * already set as run-sheet owners on the event, plus themselves.
 */
export async function callableScope(db: AppDb, user: SessionUser, eventId: number): Promise<CallableScope> {
  if (isPlanningAdmin(user)) return { people: null, teams: null };
  const [led, owned] = await Promise.all([
    db.prepare(`SELECT team_id FROM team_members WHERE person_id = ? AND is_leader = 1`).bind(user.id).all<{ team_id: number }>(),
    db
      .prepare(`SELECT DISTINCT owner_team_id AS team_id FROM planning_items WHERE event_id = ? AND owner_team_id IS NOT NULL`)
      .bind(eventId)
      .all<{ team_id: number }>(),
  ]);
  const teams = new Set([...led.results, ...owned.results].map((r) => r.team_id));
  const people = new Set<number>([user.id]);
  if (teams.size > 0) {
    const ids = [...teams];
    const { results } = await db
      .prepare(`SELECT DISTINCT person_id FROM team_members WHERE team_id IN (${ids.map(() => '?').join(', ')})`)
      .bind(...ids)
      .all<{ person_id: number }>();
    for (const r of results) people.add(r.person_id);
  }
  return { people, teams };
}

export const restrictPeople = (scope: CallableScope, ids: readonly number[]): number[] =>
  scope.people === null ? [...ids] : ids.filter((id) => scope.people!.has(id));

export const teamAllowed = (scope: CallableScope, teamId: number): boolean =>
  scope.teams === null || scope.teams.has(teamId);

/** Copy a run sheet only when the user may manage BOTH events (cue notes are leader-only). */
export async function copyRunSheetChecked(
  db: AppDb,
  user: SessionUser,
  targetEventId: number,
  sourceEventId: number,
  expectedRevision: number,
) {
  const [target, source] = await Promise.all([
    planningRole(db, user, { id: targetEventId }),
    planningRole(db, user, { id: sourceEventId }),
  ]);
  if (!canManage(target) || !canManage(source)) return { ok: false as const, reason: 'forbidden' as const };
  return copyRunSheet(db, targetEventId, sourceEventId, expectedRevision);
}

/** Events (from a candidate list) the user may manage. */
export async function manageableEventIds(db: AppDb, user: SessionUser, ids: readonly number[]): Promise<Set<number>> {
  if (isPlanningAdmin(user)) return new Set(ids);
  const mine = new Set(await listCoordinatedEventIds(db, user.id));
  return new Set(ids.filter((id) => mine.has(id)));
}

/**
 * Drop run-sheet owners a non-admin coordinator may not attach. An owner already
 * on the item (`existing`) is kept so editing other fields never strips it.
 */
export function restrictOwners<T extends { owner_person_id: number | null; owner_team_id: number | null }>(
  scope: CallableScope,
  data: T,
  existing?: { owner_person_id: number | null; owner_team_id: number | null } | null,
): T {
  const person =
    data.owner_person_id !== null &&
    scope.people !== null &&
    !scope.people.has(data.owner_person_id) &&
    data.owner_person_id !== existing?.owner_person_id
      ? null
      : data.owner_person_id;
  const team =
    data.owner_team_id !== null && !teamAllowed(scope, data.owner_team_id) && data.owner_team_id !== existing?.owner_team_id
      ? null
      : data.owner_team_id;
  return { ...data, owner_person_id: person, owner_team_id: team };
}
