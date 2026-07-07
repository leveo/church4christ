// Loads the request's SessionUser from D1: the person row plus their team
// memberships, mapped to the shape middleware attaches as `Astro.locals.user`.
// The person row is re-read on every request so deactivation (active=0),
// soft-delete, and a session_epoch bump (signout) take effect immediately.
// Two queries per call. Ported from the reference stack's getActivePersonById +
// getPersonTeamIds, adapted to the role model and the team_members schema
// (which — unlike the reference stack — has no soft-delete column, so only teams.deleted_at
// is filtered).
import type { AppDb } from './appDb';
import type { SessionUser } from './types';

interface PersonAuthRow {
  id: number;
  email: string;
  display_name: string;
  role: 'member' | 'editor' | 'admin';
  lang: string | null;
}

const PERSON_AUTH_COLS = 'id, email, display_name, role, lang';

/** A person's member ∪ leader team ids, excluding soft-deleted teams. */
async function loadTeamIds(
  db: AppDb,
  personId: number,
): Promise<{ memberTeamIds: number[]; leaderTeamIds: number[] }> {
  const { results } = await db
    .prepare(
      `SELECT tm.team_id, tm.is_leader
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id AND t.deleted_at IS NULL
       WHERE tm.person_id = ?`,
    )
    .bind(personId)
    .all<{ team_id: number; is_leader: number }>();
  return {
    memberTeamIds: results.map((r) => r.team_id),
    leaderTeamIds: results.filter((r) => r.is_leader === 1).map((r) => r.team_id),
  };
}

function toSessionUser(
  person: PersonAuthRow,
  teams: { memberTeamIds: number[]; leaderTeamIds: number[] },
): SessionUser {
  return {
    id: person.id,
    email: person.email,
    displayName: person.display_name,
    role: person.role,
    isAdmin: person.role === 'admin',
    isEditor: person.role === 'editor',
    memberTeamIds: teams.memberTeamIds,
    leaderTeamIds: teams.leaderTeamIds,
    lang: person.lang === 'en' || person.lang === 'zh' ? person.lang : null,
  };
}

/**
 * Load the SessionUser for a verified session. The person must be active, not
 * soft-deleted, and carry the epoch the session was minted at — an epoch bump
 * (signout / forced logout) revokes every older cookie. Returns null when any of
 * those checks fail. Two queries: the person row, then their team ids.
 */
export async function loadSessionUser(
  db: AppDb,
  personId: number,
  epoch: number,
): Promise<SessionUser | null> {
  const person = await db
    .prepare(
      `SELECT ${PERSON_AUTH_COLS} FROM people
       WHERE id = ? AND active = 1 AND deleted_at IS NULL AND session_epoch = ?`,
    )
    .bind(personId, epoch)
    .first<PersonAuthRow>();
  if (!person) return null;
  return toSessionUser(person, await loadTeamIds(db, person.id));
}

/**
 * Dev-only: attach a person by email with no session cookie, for the
 * AUTH_DEV_BYPASS_EMAIL middleware shortcut. Active + non-deleted only; there is
 * no epoch to check since no cookie is involved. Returns null if no such person.
 */
export async function loadSessionUserByEmail(db: AppDb, email: string): Promise<SessionUser | null> {
  const person = await db
    .prepare(
      `SELECT ${PERSON_AUTH_COLS} FROM people
       WHERE email = ? AND active = 1 AND deleted_at IS NULL`,
    )
    .bind(email.trim().toLowerCase())
    .first<PersonAuthRow>();
  if (!person) return null;
  return toSessionUser(person, await loadTeamIds(db, person.id));
}
