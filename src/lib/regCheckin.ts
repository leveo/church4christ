// The check-in desk, data layer: find a party by name, confirmation number (a scanned QR holds it), email or
// phone; check people in, undo, check out, or check a whole party in; a cheap change marker the desks poll so
// several devices stay in sync. Runs on D1 and Postgres; every shared statement is dialect-neutral SQL.
//
// Idempotent by construction: reg_checkins has one row per person (primary key = the attendee), so two
// desks checking the same person in at once produce one row, and only the call that created it reports
// `already: false` and writes the activity row. A registration that is not simply confirmed (waitlist, review,
// pending, cancelled, declined) or a cancelled person needs a deliberate confirm: the writer answers
// { ok: false, code: 'NEEDS_CONFIRM', reason: 'status_<status>' | 'attendee_cancelled' } and nothing is written.
import type { AppDb } from './appDb';
import { type Locale } from './db';
import { getRuntimeDefaultLocale } from './locales';
import { activityStatement, intLit, likeSql, likeTerm, logActivity, type NeedsConfirm } from './regAdminCore';
import { listTicketTypes, type RegStatus } from './regDb';
import { assignmentsForAttendees } from './regLogistics';

export interface DeskPerson {
  attendeeId: number;
  name: string;
  ticketLabel: string | null;
  /** The person is at the door now (checked in and not checked out). */
  checkedIn: boolean;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  /** The person was cancelled from the registration. */
  cancelled: boolean;
  /** Event logistics (only when the caller passed `logistics: true`): present when housing / seating is on for the
   *  event; null = not assigned yet. */
  room?: { label: string; venue: string } | null;
  table?: { label: string } | null;
}

export interface DeskParty {
  registrationId: number;
  confirmationNo: string | null;
  name: string;
  status: RegStatus;
  /** Null for a confirmed party; otherwise the reason a check-in needs confirm ('status_<status>'). */
  warning: string | null;
  people: DeskPerson[];
}

export interface DeskSearch {
  /** The query was exactly a confirmation number (case and spacing ignored): the one party it names. */
  exact: boolean;
  parties: DeskParty[];
}

export const DESK_RESULT_LIMIT = 20;

const statusWarning = (status: RegStatus): string | null => (status === 'confirmed' ? null : `status_${status}`);

async function partiesByIds(db: AppDb, eventId: number, ids: number[], locale: Locale, logistics = false): Promise<DeskParty[]> {
  if (ids.length === 0) return [];
  const list = ids.map((id) => intLit(id)).join(',');
  const { results: regs } = await db
    .prepare(`SELECT id, confirmation_no, name, status FROM registrations WHERE event_id = ?1 AND id IN (${list})`)
    .bind(eventId)
    .all<{ id: number; confirmation_no: string | null; name: string; status: RegStatus }>();
  const { results: people } = await db
    .prepare(
      `SELECT a.id AS id, a.registration_id AS registration_id, a.name AS name, a.ticket_type_id AS ticket_type_id, a.status AS status,
              c.checked_in_at AS checked_in_at, c.checked_out_at AS checked_out_at
       FROM reg_attendees a LEFT JOIN reg_checkins c ON c.attendee_id = a.id
       WHERE a.registration_id IN (${list}) ORDER BY a.registration_id, a.sort, a.id`,
    )
    .all<{ id: number; registration_id: number; name: string; ticket_type_id: number | null; status: 'active' | 'cancelled'; checked_in_at: string | null; checked_out_at: string | null }>();
  const labels = new Map((await listTicketTypes(db, locale, eventId)).map((t) => [t.id, t.label]));
  const assigned = logistics ? await assignmentsForAttendees(db, eventId, people.map((p) => p.id)) : null;
  const byReg = new Map<number, DeskPerson[]>();
  for (const p of people) {
    const where = assigned?.get(p.id);
    (byReg.get(p.registration_id) ?? byReg.set(p.registration_id, []).get(p.registration_id)!).push({
      attendeeId: p.id,
      name: p.name,
      ticketLabel: p.ticket_type_id === null ? null : (labels.get(p.ticket_type_id) ?? null),
      checkedIn: p.checked_in_at !== null && p.checked_out_at === null,
      checkedInAt: p.checked_in_at,
      checkedOutAt: p.checked_out_at,
      cancelled: p.status === 'cancelled',
      ...(where && where.room !== undefined ? { room: where.room } : {}),
      ...(where && where.table !== undefined ? { table: where.table } : {}),
    });
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return regs
    .map((r) => ({ registrationId: r.id, confirmationNo: r.confirmation_no, name: r.name, status: r.status, warning: statusWarning(r.status), people: byReg.get(r.id) ?? [] }))
    .sort((a, b) => (order.get(a.registrationId) ?? 0) - (order.get(b.registrationId) ?? 0));
}

/**
 * Parties of one event matching `query`: an exact confirmation number first (what a QR scan sends), else a
 * case-insensitive search of the registration's name, email, phone and confirmation number and every person's
 * name (any status: the desk must find a waitlisted person to warn about them). At most DESK_RESULT_LIMIT.
 */
export async function findForDesk(
  db: AppDb,
  eventId: number,
  query: string,
  locale: Locale = getRuntimeDefaultLocale(),
  /** `logistics`: the event-logistics module is on; adds each person's room and table. */
  opts: { logistics?: boolean } = {},
): Promise<DeskSearch> {
  const q = query.trim();
  if (q === '') return { exact: false, parties: [] };
  const exact = await db
    .prepare(`SELECT id FROM registrations WHERE event_id = ?1 AND confirmation_no = ?2`)
    .bind(eventId, q.replace(/\s+/g, '').toUpperCase())
    .first<{ id: number }>();
  if (exact) return { exact: true, parties: await partiesByIds(db, eventId, [exact.id], locale, opts.logistics) };
  const { results } = await db
    .prepare(
      `SELECT r.id AS id FROM registrations r
       WHERE r.event_id = ?1 AND (${likeSql('r.name', '?2')} OR ${likeSql('r.email', '?2')} OR ${likeSql(`COALESCE(r.phone, '')`, '?2')}
         OR ${likeSql(`COALESCE(r.confirmation_no, '')`, '?2')}
         OR EXISTS (SELECT 1 FROM reg_attendees a WHERE a.registration_id = r.id AND ${likeSql('a.name', '?2')}))
       ORDER BY LOWER(r.name), r.id
       LIMIT ${DESK_RESULT_LIMIT}`,
    )
    .bind(eventId, likeTerm(q))
    .all<{ id: number }>();
  return { exact: false, parties: await partiesByIds(db, eventId, results.map((r) => r.id), locale, opts.logistics) };
}

export interface DeskCounts {
  /** People at the door now. */
  checkedIn: number;
  /** Active people on confirmed registrations. */
  expected: number;
}

export async function deskCounts(db: AppDb, eventId: number): Promise<DeskCounts> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM reg_checkins c JOIN reg_attendees a ON a.id = c.attendee_id JOIN registrations r ON r.id = a.registration_id
               WHERE r.event_id = ?1 AND c.checked_out_at IS NULL) AS checked_in,
              (SELECT COUNT(*) FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
               WHERE r.event_id = ?1 AND a.status = 'active' AND r.status = 'confirmed') AS expected`,
    )
    .bind(eventId)
    .first<{ checked_in: number; expected: number }>();
  return { checkedIn: Number(row?.checked_in ?? 0), expected: Number(row?.expected ?? 0) };
}

/**
 * A cheap change marker for the event: it differs whenever anything a desk shows may have changed (every
 * check-in change and every staff change writes an activity row; every registration write bumps its version;
 * a new registration changes the count). Poll it every few seconds and re-fetch only when it moved.
 */
export async function deskVersion(db: AppDb, eventId: number): Promise<string> {
  const row = await db
    .prepare(
      `SELECT (SELECT COALESCE(MAX(id), 0) FROM reg_activity WHERE event_id = ?1) AS activity,
              (SELECT COUNT(*) FROM registrations WHERE event_id = ?1) AS registrations,
              (SELECT COALESCE(SUM(version), 0) FROM registrations WHERE event_id = ?1) AS versions`,
    )
    .bind(eventId)
    .first<{ activity: number; registrations: number; versions: number }>();
  return `${Number(row?.activity ?? 0)}.${Number(row?.registrations ?? 0)}.${Number(row?.versions ?? 0)}`;
}

// ── Writes ───────────────────────────────────────────────────────────────────

interface AttendeeCtx {
  attendeeId: number;
  registrationId: number;
  eventId: number;
  attendeeStatus: 'active' | 'cancelled';
  registrationStatus: RegStatus;
}

async function loadAttendee(db: AppDb, attendeeId: number): Promise<AttendeeCtx | null> {
  if (!Number.isSafeInteger(attendeeId) || attendeeId < 1) return null;
  const row = await db
    .prepare(
      `SELECT a.id AS attendee_id, a.registration_id AS registration_id, r.event_id AS event_id, a.status AS attendee_status, r.status AS registration_status
       FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id WHERE a.id = ?1`,
    )
    .bind(attendeeId)
    .first<{ attendee_id: number; registration_id: number; event_id: number; attendee_status: 'active' | 'cancelled'; registration_status: RegStatus }>();
  return row
    ? { attendeeId: row.attendee_id, registrationId: row.registration_id, eventId: row.event_id, attendeeStatus: row.attendee_status, registrationStatus: row.registration_status }
    : null;
}

const warningOf = (ctx: AttendeeCtx): string | null =>
  statusWarning(ctx.registrationStatus) ?? (ctx.attendeeStatus === 'cancelled' ? 'attendee_cancelled' : null);

export type CheckInResult =
  | { ok: true; /** True when the person was already checked in (nothing changed). */ already: boolean }
  | NeedsConfirm
  | { ok: false; code: 'not_found' };

/** Check one person in. Idempotent; a non-confirmed registration or a cancelled person needs `confirm`. */
export async function checkIn(db: AppDb, attendeeId: number, actor: number | null, opts: { confirm?: boolean } = {}): Promise<CheckInResult> {
  const ctx = await loadAttendee(db, attendeeId);
  if (!ctx) return { ok: false, code: 'not_found' };
  const warning = warningOf(ctx);
  if (warning && !opts.confirm) return { ok: false, code: 'NEEDS_CONFIRM', reason: warning };
  // Insert the row; a checked-out person is checked back in; a person already in changes nothing (changes = 0).
  const result = await db
    .prepare(
      `INSERT INTO reg_checkins (campus_id, attendee_id, checked_in_by)
       SELECT r.campus_id, a.id, CAST(?2 AS INTEGER) FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id WHERE a.id = ?1
       ON CONFLICT (attendee_id) DO UPDATE SET checked_out_at = NULL WHERE reg_checkins.checked_out_at IS NOT NULL`,
    )
    .bind(attendeeId, actor)
    .run();
  const changed = result.meta.changes > 0;
  if (changed) await logActivity(db, ctx.registrationId, actor, 'checkin', { attendeeId, override: warning });
  return { ok: true, already: !changed };
}

export type UndoResult = { ok: true; changed: boolean } | { ok: false; code: 'not_found' };

/** Take the check-in back entirely (the person was never there). */
export async function undoCheckIn(db: AppDb, attendeeId: number, actor: number | null): Promise<UndoResult> {
  const ctx = await loadAttendee(db, attendeeId);
  if (!ctx) return { ok: false, code: 'not_found' };
  const result = await db.prepare(`DELETE FROM reg_checkins WHERE attendee_id = ?1`).bind(attendeeId).run();
  const changed = result.meta.changes > 0;
  if (changed) await logActivity(db, ctx.registrationId, actor, 'checkin_undo', { attendeeId });
  return { ok: true, changed };
}

export type CheckOutResult = { ok: true; changed: boolean } | { ok: false; code: 'not_found' | 'not_checked_in' };

/** Record that a checked-in person left. */
export async function checkOut(db: AppDb, attendeeId: number, actor: number | null): Promise<CheckOutResult> {
  const ctx = await loadAttendee(db, attendeeId);
  if (!ctx) return { ok: false, code: 'not_found' };
  const result = await db
    .prepare(`UPDATE reg_checkins SET checked_out_at = datetime('now') WHERE attendee_id = ?1 AND checked_out_at IS NULL`)
    .bind(attendeeId)
    .run();
  if (result.meta.changes > 0) {
    await logActivity(db, ctx.registrationId, actor, 'checkout', { attendeeId });
    return { ok: true, changed: true };
  }
  const present = await db.prepare(`SELECT 1 AS present FROM reg_checkins WHERE attendee_id = ?1`).bind(attendeeId).first();
  return present ? { ok: true, changed: false } : { ok: false, code: 'not_checked_in' };
}

export type CheckInPartyResult = { ok: true; checkedIn: number; already: number } | NeedsConfirm | { ok: false; code: 'not_found' };

/** Check in every active person on the registration who is not at the door yet. */
export async function checkInParty(db: AppDb, registrationId: number, actor: number | null, opts: { confirm?: boolean } = {}): Promise<CheckInPartyResult> {
  if (!Number.isSafeInteger(registrationId) || registrationId < 1) return { ok: false, code: 'not_found' };
  const reg = await db.prepare(`SELECT status FROM registrations WHERE id = ?1`).bind(registrationId).first<{ status: RegStatus }>();
  if (!reg) return { ok: false, code: 'not_found' };
  const warning = statusWarning(reg.status);
  if (warning && !opts.confirm) return { ok: false, code: 'NEEDS_CONFIRM', reason: warning };
  const { results: active } = await db
    .prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 AND status = 'active'`)
    .bind(registrationId)
    .all<{ id: number }>();
  const result = await db
    .prepare(
      `INSERT INTO reg_checkins (campus_id, attendee_id, checked_in_by)
       SELECT r.campus_id, a.id, CAST(?2 AS INTEGER) FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id
       WHERE a.registration_id = ?1 AND a.status = 'active'
       ON CONFLICT (attendee_id) DO UPDATE SET checked_out_at = NULL WHERE reg_checkins.checked_out_at IS NOT NULL`,
    )
    .bind(registrationId, actor)
    .run();
  const checkedIn = result.meta.changes;
  if (checkedIn > 0) await activityStatement(db, registrationId, actor, 'checkin_party', { people: checkedIn, override: warning }).run();
  return { ok: true, checkedIn, already: Math.max(0, active.length - checkedIn) };
}
