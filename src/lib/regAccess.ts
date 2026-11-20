// Who may do what on one registration event. Registration admin access (an editor, or an admin holding the
// `registration` area, super admins included) is "registrar" on EVERY event. Anyone else can be given a
// per-event role in reg_event_access:
//   viewer     read the event page: roster, overview, drawer (no changes)
//   desk       the check-in desk only (find people, check in, undo, check out)
//   registrar  everything for that event except event settings, the form builder and refunds
// The roles are capabilities, not a ladder: a desk volunteer cannot read the roster and a viewer cannot check
// anyone in, so every gate asks for a NEED ('view' | 'checkin' | 'manage'), never a minimum role.
//
// Every route derives the event from the row it acts on (eventOfRegistration / eventOfAttendee) BEFORE the
// check; an event id from the client is never trusted. The module gate (404 when registration is off) and the
// route class (regEventStaff, session only) run before any of this; see routePolicy.ts.
import type { AppDb } from './appDb';
import { hasAreaAccess } from './adminAreas';
import type { SessionUser } from './types';

export type RegRole = 'viewer' | 'desk' | 'registrar';
export const REG_ROLES: readonly RegRole[] = ['viewer', 'desk', 'registrar'];
export type RegNeed = 'view' | 'checkin' | 'manage';

const CAPABILITIES: Record<RegRole, readonly RegNeed[]> = {
  viewer: ['view'],
  desk: ['checkin'],
  registrar: ['view', 'checkin', 'manage'],
};

export const isRegRole = (value: unknown): value is RegRole => typeof value === 'string' && (REG_ROLES as readonly string[]).includes(value);

/** Whether `role` may do `need`. A null role may do nothing. */
export const regRoleAllows = (role: RegRole | null, need: RegNeed): boolean => role !== null && CAPABILITIES[role].includes(need);

/** Registration admin access on every event: an editor, or an admin with the `registration` area. */
export const hasRegistrationArea = (user: SessionUser | null): boolean => !!user && (user.isEditor || hasAreaAccess(user, 'registration'));

/** Event settings, the form builder and per-event access are for registration admins only. */
export const canEditEvent = hasRegistrationArea;

/** Refunds need the same permission as payment operations: an admin holding that area, or the finance team. */
export function canRefund(user: SessionUser | null): boolean {
  if (!user) return false;
  return user.isAdmin ? hasAreaAccess(user, 'payment-operations') : user.finance === 1;
}

/** The user's role on the event: 'registrar' for registration admins, else the stored per-event role, else null. */
export async function regEventRole(db: AppDb, user: SessionUser | null, eventId: number): Promise<RegRole | null> {
  if (!user) return null;
  if (hasRegistrationArea(user)) return 'registrar';
  if (!Number.isSafeInteger(eventId)) return null;
  const row = await db
    .prepare(`SELECT role FROM reg_event_access WHERE event_id = ?1 AND person_id = ?2`)
    .bind(eventId, user.id)
    .first<{ role: string }>();
  return row && isRegRole(row.role) ? row.role : null;
}

export type RegRoleCheck = { ok: true; role: RegRole } | { ok: false; status: 403 | 404 };

/** The gate every registration route runs: 403 without the capability, 404 for an unknown event (only ever
 *  told to someone who holds a role, so event ids are not probeable by other signed-in people). */
export async function requireRegRole(db: AppDb, user: SessionUser | null, eventId: number, need: RegNeed): Promise<RegRoleCheck> {
  const role = await regEventRole(db, user, eventId);
  if (role === null) return { ok: false, status: 403 };
  const exists = await db.prepare(`SELECT 1 AS present FROM reg_events WHERE id = ?1`).bind(eventId).first();
  if (!exists) return { ok: false, status: 404 };
  return regRoleAllows(role, need) ? { ok: true, role } : { ok: false, status: 403 };
}

/** The event a registration belongs to, or null. Use this, not a client-supplied event id. */
export async function eventOfRegistration(db: AppDb, registrationId: number): Promise<number | null> {
  if (!Number.isSafeInteger(registrationId)) return null;
  const row = await db.prepare(`SELECT event_id FROM registrations WHERE id = ?1`).bind(registrationId).first<{ event_id: number }>();
  return row?.event_id ?? null;
}

/** The event (and registration) a person on a registration belongs to, or null. */
export async function eventOfAttendee(db: AppDb, attendeeId: number): Promise<{ eventId: number; registrationId: number } | null> {
  if (!Number.isSafeInteger(attendeeId)) return null;
  const row = await db
    .prepare(`SELECT r.event_id AS event_id, a.registration_id AS registration_id
              FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id WHERE a.id = ?1`)
    .bind(attendeeId)
    .first<{ event_id: number; registration_id: number }>();
  return row ? { eventId: row.event_id, registrationId: row.registration_id } : null;
}

// ── Grants (registration admins only: the caller checks canEditEvent) ───────

export interface RegEventAccessRow {
  person_id: number;
  display_name: string;
  email: string | null;
  role: RegRole;
  created_at: string;
}

/** Everyone holding a per-event role, by name. */
export async function listEventRoles(db: AppDb, eventId: number): Promise<RegEventAccessRow[]> {
  const { results } = await db
    .prepare(
      `SELECT a.person_id AS person_id, p.display_name AS display_name, p.email AS email, a.role AS role, a.created_at AS created_at
       FROM reg_event_access a JOIN people p ON p.id = a.person_id
       WHERE a.event_id = ?1
       ORDER BY p.display_name, a.person_id`,
    )
    .bind(eventId)
    .all<RegEventAccessRow>();
  return results;
}

export type GrantResult = { ok: true } | { ok: false; code: 'invalid_role' | 'event_not_found' | 'person_not_found' };

/** Give a person a role on one event (changes it when they already hold one). The person must be an active member. */
export async function grantEventRole(db: AppDb, eventId: number, personId: number, role: unknown): Promise<GrantResult> {
  if (!isRegRole(role)) return { ok: false, code: 'invalid_role' };
  if (!Number.isSafeInteger(personId) || personId < 1) return { ok: false, code: 'person_not_found' };
  const event = await db.prepare(`SELECT 1 AS present FROM reg_events WHERE id = ?1 AND is_template = 0`).bind(eventId).first();
  if (!event) return { ok: false, code: 'event_not_found' };
  const person = await db.prepare(`SELECT 1 AS present FROM people WHERE id = ?1 AND active = 1`).bind(personId).first();
  if (!person) return { ok: false, code: 'person_not_found' };
  await db
    .prepare(
      `INSERT INTO reg_event_access (campus_id, event_id, person_id, role)
       SELECT e.campus_id, e.id, CAST(?2 AS INTEGER), CAST(?3 AS TEXT) FROM reg_events e WHERE e.id = ?1
       ON CONFLICT (event_id, person_id) DO UPDATE SET role = excluded.role`,
    )
    .bind(eventId, personId, role)
    .run();
  return { ok: true };
}

/** Take a person's role on one event away. True when they held one. */
export async function revokeEventRole(db: AppDb, eventId: number, personId: number): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM reg_event_access WHERE event_id = ?1 AND person_id = ?2`).bind(eventId, personId).run();
  return result.meta.changes > 0;
}

/** The events a person holds a per-event role on (for their landing list). */
export async function listEventRolesForPerson(db: AppDb, personId: number): Promise<Array<{ event_id: number; role: RegRole }>> {
  const { results } = await db
    .prepare(`SELECT event_id, role FROM reg_event_access WHERE person_id = ?1 ORDER BY event_id`)
    .bind(personId)
    .all<{ event_id: number; role: RegRole }>();
  return results;
}
