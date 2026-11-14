// Who may see or manage a planning event. Admins need the `planning` area
// grant (super admins pass); coordinators are scoped per event; participants
// (called to a non-draft session, or owners of a run-sheet item directly or via
// a team) may read a non-draft event. Everyone else gets nothing.
import type { AppDb } from './appDb';
import { hasAreaAccess } from './adminAreas';
import { isCoordinator, type PlanningEvent } from './planningDb';
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
