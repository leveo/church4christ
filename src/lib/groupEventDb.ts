// Routine (recurring) group events, materialized as occurrence rows — the
// planDb.ensureWeeklyPlans precedent, generalized to none/weekly/biweekly/monthly
// recurrence. Occurrence dates (occurs_on) are computed in the site TZ
// (America/Chicago, like digest.ts); starts_at/ends_at are the corresponding UTC
// 'YYYY-MM-DD HH:MM:SS' instants (DST-aware via dates.datetimeLocalToUtc), so they
// are directly comparable with datetime('now'). No RRULE engine — generation runs
// on save and via the attendance cron's top-up. Soft deletes: group_events.deleted_at,
// group_event_occurrences.deleted_at. No authorization here (pages gate).
import type { AppDb } from './appDb';
import { addDays, addMinutesToUtcSql, addMonthsSameDom, datetimeLocalToUtc, todayInTz, toUtcSql } from './dates';

const TZ = 'America/Chicago';

export const RECURRENCES = ['none', 'weekly', 'biweekly', 'monthly'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export interface GroupEventInput {
  title: string;
  description: string;
  location: string | null;
  recurrence: Recurrence;
  startsOn: string; // YYYY-MM-DD (site TZ)
  startTime: string; // HH:MM (site TZ)
  durationMin: number;
  endsOn: string | null; // optional series end date
  trackAttendance: boolean;
}

export interface GroupEventRow {
  id: number;
  group_id: number;
  title: string;
  description: string;
  location: string | null;
  recurrence: Recurrence;
  starts_on: string;
  start_time: string;
  duration_min: number;
  ends_on: string | null;
  track_attendance: number; // 0 | 1
  active: number; // 0 | 1
}

const EVENT_COLS = `id, group_id, title, description, location, recurrence, starts_on, start_time,
  duration_min, ends_on, track_attendance, active`;

// ── Event CRUD ─────────────────────────────────────────────────────────────

/** Create a routine event; returns the new id. Occurrences are materialized
 *  separately (ensureOccurrences), called by the page after save. */
export async function createEvent(db: AppDb, groupId: number, input: GroupEventInput): Promise<number> {
  const created = await db
    .prepare(
      `INSERT INTO group_events (group_id, title, description, location, recurrence, starts_on, start_time,
            duration_min, ends_on, track_attendance)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id`,
    )
    .bind(
      groupId,
      input.title,
      input.description,
      input.location,
      input.recurrence,
      input.startsOn,
      input.startTime,
      input.durationMin,
      input.endsOn,
      input.trackAttendance ? 1 : 0,
    )
    .first<{ id: number }>();
  return created!.id;
}

/** Update a live event. Returns true when a row changed. */
export async function updateEvent(db: AppDb, id: number, input: GroupEventInput): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE group_events SET title = ?2, description = ?3, location = ?4, recurrence = ?5, starts_on = ?6,
            start_time = ?7, duration_min = ?8, ends_on = ?9, track_attendance = ?10, updated_at = datetime('now')
       WHERE id = ?1 AND deleted_at IS NULL`,
    )
    .bind(
      id,
      input.title,
      input.description,
      input.location,
      input.recurrence,
      input.startsOn,
      input.startTime,
      input.durationMin,
      input.endsOn,
      input.trackAttendance ? 1 : 0,
    )
    .run();
  return r.meta.changes > 0;
}

/** Soft-delete an event and its future occurrences (past occurrences keep their
 *  attendance history). Returns nothing. */
export async function softDeleteEvent(db: AppDb, id: number, now: Date = new Date()): Promise<void> {
  const today = todayInTz(TZ, now);
  await db.batch([
    db.prepare(`UPDATE group_events SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1`).bind(id),
    db
      .prepare(
        `UPDATE group_event_occurrences SET deleted_at = datetime('now')
         WHERE event_id = ?1 AND deleted_at IS NULL AND occurs_on >= ?2`,
      )
      .bind(id, today),
  ]);
}

/** A single live event, or null if missing/soft-deleted. */
export async function getEvent(db: AppDb, id: number): Promise<GroupEventRow | null> {
  return db
    .prepare(`SELECT ${EVENT_COLS} FROM group_events WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(id)
    .first<GroupEventRow>();
}

/** A group's live events (both active and inactive), title-ordered. */
export async function listEventsForGroup(db: AppDb, groupId: number): Promise<GroupEventRow[]> {
  const { results } = await db
    .prepare(`SELECT ${EVENT_COLS} FROM group_events WHERE group_id = ?1 AND deleted_at IS NULL ORDER BY starts_on, id`)
    .bind(groupId)
    .all<GroupEventRow>();
  return results;
}

// ── Occurrence generation ──────────────────────────────────────────────────

/** The subset of an event ensureOccurrences needs (a full row satisfies it). */
export interface RecurringEvent {
  id: number;
  recurrence: Recurrence;
  starts_on: string;
  start_time: string;
  duration_min: number;
  ends_on: string | null;
}

/**
 * Materialize occurrence rows for a routine event from starts_on through
 * `throughDate` (idempotent — ON CONFLICT(event_id, occurs_on) revives a
 * soft-deleted row and refreshes its computed times). The horizon is clamped to
 * ≤ 370 days from today (the ensureWeeklyPlans precedent — a mistyped year can't
 * insert hundreds of rows) and further to the event's ends_on when set. Recurrence:
 * none = the single occurrence at starts_on; weekly/biweekly = every 7 / 14 days;
 * monthly = same day-of-month, skipping months that lack the day. Returns the
 * number of occurrence dates ensured.
 */
export async function ensureOccurrences(
  db: AppDb,
  event: RecurringEvent,
  throughDate: string,
  now: Date = new Date(),
): Promise<number> {
  const today = todayInTz(TZ, now);
  let horizon = throughDate;
  const cap = addDays(today, 370);
  if (horizon > cap) horizon = cap;
  if (event.ends_on && event.ends_on < horizon) horizon = event.ends_on;

  const dates = occurrenceDates(event, horizon);
  let count = 0;
  for (const d of dates) {
    const startsAt = datetimeLocalToUtc(`${d}T${event.start_time}`, TZ);
    if (!startsAt) continue; // malformed start_time → skip (never insert a bad row)
    const endsAt = addMinutesToUtcSql(startsAt, event.duration_min);
    await db
      .prepare(
        `INSERT INTO group_event_occurrences (event_id, occurs_on, starts_at, ends_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(event_id, occurs_on) DO UPDATE SET deleted_at = NULL, starts_at = excluded.starts_at, ends_at = excluded.ends_at`,
      )
      .bind(event.id, d, startsAt, endsAt)
      .run();
    count++;
  }
  return count;
}

/** The occurrence dates (site-TZ 'YYYY-MM-DD') for an event up to and including
 *  `horizon`. Pure — the loops are bounded by the horizon (and a hard cap). */
function occurrenceDates(event: RecurringEvent, horizon: string): string[] {
  const start = event.starts_on;
  if (start > horizon) return []; // the first (or only) occurrence is beyond the horizon
  if (event.recurrence === 'none') return [start];
  const out: string[] = [];
  if (event.recurrence === 'monthly') {
    for (let k = 0; k < 500; k++) {
      const firstOfMonth = addMonthsSameDom(monthAnchor(start), k);
      if (firstOfMonth && firstOfMonth > horizon) break; // whole month past the horizon
      const d = addMonthsSameDom(start, k);
      if (d === null) continue; // this month lacks the day-of-month
      if (d > horizon) break;
      out.push(d);
    }
    return out;
  }
  const step = event.recurrence === 'weekly' ? 7 : 14;
  for (let k = 0; k < 1000; k++) {
    const d = addDays(start, step * k);
    if (d > horizon) break;
    out.push(d);
  }
  return out;
}

/** The first-of-month for a date string (used to test whether a month is wholly
 *  past the horizon in the monthly loop). */
function monthAnchor(dateStr: string): string {
  return `${dateStr.slice(0, 7)}-01`;
}

// ── Occurrence reads ───────────────────────────────────────────────────────

export interface UpcomingOccurrence {
  id: number;
  event_id: number;
  title: string;
  location: string | null;
  occurs_on: string;
  starts_at: string;
  ends_at: string;
  track_attendance: number; // 0 | 1
}

/** Upcoming occurrences (occurs_on >= today, site TZ) for a group's live active
 *  events, soonest first — the group detail + manage schedule. */
export async function listUpcomingOccurrencesForGroup(
  db: AppDb,
  groupId: number,
  now: Date = new Date(),
): Promise<UpcomingOccurrence[]> {
  const today = todayInTz(TZ, now);
  const { results } = await db
    .prepare(
      `SELECT geo.id AS id, geo.event_id AS event_id, ge.title AS title, ge.location AS location,
              geo.occurs_on AS occurs_on, geo.starts_at AS starts_at, geo.ends_at AS ends_at,
              ge.track_attendance AS track_attendance
       FROM group_event_occurrences geo
       JOIN group_events ge ON ge.id = geo.event_id AND ge.deleted_at IS NULL AND ge.active = 1
       WHERE ge.group_id = ?1 AND geo.deleted_at IS NULL AND geo.occurs_on >= ?2
       ORDER BY geo.occurs_on, geo.starts_at, geo.id`,
    )
    .bind(groupId, today)
    .all<UpcomingOccurrence>();
  return results;
}

export interface OccurrenceWithEvent {
  id: number;
  event_id: number;
  group_id: number;
  group_name: string;
  title: string;
  location: string | null;
  occurs_on: string;
  starts_at: string;
  ends_at: string;
  track_attendance: number; // 0 | 1
}

/** One occurrence joined to its event + group (the attendance sheet's header),
 *  or null if missing/soft-deleted. */
export async function getOccurrenceWithEvent(db: AppDb, occurrenceId: number): Promise<OccurrenceWithEvent | null> {
  return db
    .prepare(
      `SELECT geo.id AS id, geo.event_id AS event_id, ge.group_id AS group_id, g.name AS group_name,
              ge.title AS title, ge.location AS location, geo.occurs_on AS occurs_on,
              geo.starts_at AS starts_at, geo.ends_at AS ends_at, ge.track_attendance AS track_attendance
       FROM group_event_occurrences geo
       JOIN group_events ge ON ge.id = geo.event_id
       JOIN groups g ON g.id = ge.group_id
       WHERE geo.id = ?1 AND geo.deleted_at IS NULL`,
    )
    .bind(occurrenceId)
    .first<OccurrenceWithEvent>();
}

export interface OccurrenceNeedingAttendance {
  id: number;
  event_id: number;
  group_id: number;
  group_name: string;
  title: string;
  occurs_on: string;
  ends_at: string;
}

/**
 * Occurrences whose attendance email is due: track_attendance events that ended
 * within the last 24h and have not been claimed yet (attendance_email_sent_at
 * IS NULL), on a live active event and a live group. The 24h floor keeps a cron
 * outage from blasting mail for long-past meetings. `now` drives the window.
 */
export async function listOccurrencesNeedingAttendance(
  db: AppDb,
  now: Date = new Date(),
): Promise<OccurrenceNeedingAttendance[]> {
  const nowSql = toUtcSql(now);
  const dayAgoSql = toUtcSql(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const { results } = await db
    .prepare(
      `SELECT geo.id AS id, geo.event_id AS event_id, ge.group_id AS group_id, g.name AS group_name,
              ge.title AS title, geo.occurs_on AS occurs_on, geo.ends_at AS ends_at
       FROM group_event_occurrences geo
       JOIN group_events ge ON ge.id = geo.event_id AND ge.deleted_at IS NULL AND ge.active = 1 AND ge.track_attendance = 1
       JOIN groups g ON g.id = ge.group_id AND g.deleted_at IS NULL
       WHERE geo.deleted_at IS NULL AND geo.attendance_email_sent_at IS NULL
         AND geo.ends_at <= ?1 AND geo.ends_at > ?2
       ORDER BY geo.ends_at, geo.id`,
    )
    .bind(nowSql, dayAgoSql)
    .all<OccurrenceNeedingAttendance>();
  return results;
}
