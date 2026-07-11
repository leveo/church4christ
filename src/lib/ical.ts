// Minimal iCalendar (RFC 5545) feed builder for a volunteer's serving schedule,
// plus the people.calendar_token helpers behind /cal/[token].ics. Ported from
// the reference stack's src/lib/ical.ts, adapted to church-cms: the caller passes the FULL
// UID (stable `c4c-assignment-<id>@<host>`), and the token is an explicit
// generate/regenerate action (32 hex chars) instead of create-on-view —
// regenerating invalidates the old subscription URL.

import type { AppDb } from './appDb';
import { utcToDatetimeLocal } from './dates';
import type { MeetingOccurrence } from './groupDb';
import type { MyRegistration } from './regDb';

export interface ICalEvent {
  /** Full, stable UID (e.g. `c4c-assignment-42@church.example`). */
  uid: string;
  date: string; // 'YYYY-MM-DD'
  summary: string;
  description?: string;
  startTime?: string | null; // 'HH:MM' — timed event when BOTH present, else all-day
  endTime?: string | null;
  /**
   * Last day (inclusive, 'YYYY-MM-DD') of a multi-day all-day span. Only
   * consulted when the event renders all-day (see {@link buildICal}); ignored
   * by timed events. Additive — existing callers that never set it keep
   * emitting a single-day all-day DTEND (`nextDay(date)`).
   */
  endDate?: string;
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** The day after an ISO date, compacted to YYYYMMDD (all-day DTEND is exclusive). */
function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Build a VCALENDAR document. Timed events use floating local time (the reference stack's
 * choice — a 9:30 service reads as 9:30 in any viewer's calendar, no TZID);
 * events without both times render as all-day. CRLF line endings per RFC 5545.
 */
export function buildICal(calName: string, events: ICalEvent[], stamp: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Church4Christ//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calName)}`,
  ];
  for (const e of events) {
    const day = e.date.replace(/-/g, '');
    const timed = e.startTime && e.endTime;
    const hhmmss = (t: string) => `${t.replace(':', '')}00`;
    const when = timed
      ? [`DTSTART:${day}T${hhmmss(e.startTime!)}`, `DTEND:${day}T${hhmmss(e.endTime!)}`]
      : [`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${nextDay(e.endDate ?? e.date)}`];
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      ...when,
      `SUMMARY:${esc(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/**
 * Add `hours` to an 'HH:MM' time, clamped to '23:59' rather than rolling into
 * the next calendar day (a group meeting's default duration must stay a
 * same-day timed VEVENT). Portal Task 3: group meetings have no stored end
 * time, so the feed assumes a 2h duration from `meeting_time`.
 */
export function addHoursClamped(hhmm: string, hours: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + hours * 60;
  if (total >= 24 * 60) return '23:59';
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A portal group's meeting occurrence as a feed VEVENT: timed with a 2h
 * default duration when `meeting_time` is set (see {@link addHoursClamped}),
 * else all-day. UID is stable across requests: derived from the group id and
 * the occurrence date, not a row id (occurrences are computed, not stored).
 */
export function meetingToICalEvent(m: MeetingOccurrence, host: string): ICalEvent {
  const timed = Boolean(m.meeting_time);
  return {
    uid: `c4c-group-${m.group_id}-${m.date.replace(/-/g, '')}@${host}`,
    date: m.date,
    summary: m.group_name,
    description: m.meeting_location ?? undefined,
    startTime: timed ? m.meeting_time : null,
    endTime: timed ? addHoursClamped(m.meeting_time!, 2) : null,
  };
}

/**
 * A member's event registration as a feed VEVENT: UTC `starts_at`/`ends_at`
 * converted to church-local wall clock (floating time, matching the rest of
 * the feed); timed only when both convert AND land on the same local date,
 * else all-day. When the local end date differs from the start date
 * (overnight or multi-day registrations), a timed VEVENT would either
 * compress the span onto the start day or — when the end time-of-day is
 * earlier than the start's — emit an RFC-invalid DTEND < DTSTART, so it
 * renders as an all-day span from the start date through the end date
 * instead (see {@link ICalEvent.endDate}). A still-pending registration
 * (Checkout not yet confirmed) gets the same ' (?)' summary suffix the
 * serving section uses for an unconfirmed assignment.
 */
export function regToICalEvent(r: MyRegistration, host: string): ICalEvent {
  const startLocal = utcToDatetimeLocal(r.starts_at);
  const endLocal = utcToDatetimeLocal(r.ends_at);
  const [date, startTime] = startLocal.split('T');
  const [endDate, endTimeOfDay] = endLocal.split('T');
  const sameDay = Boolean(endDate) && endDate === date;
  const timed = Boolean(startTime) && Boolean(endTimeOfDay) && sameDay;
  return {
    uid: `c4c-reg-${r.id}@${host}`,
    date,
    endDate: !timed && endDate && endDate !== date ? endDate : undefined,
    summary: `${r.event_title}${r.status === 'pending' ? ' (?)' : ''}`,
    description: r.location ?? undefined,
    startTime: timed ? startTime : null,
    endTime: timed ? endTimeOfDay : null,
  };
}

/** The person's current calendar-feed token, or null when never generated. */
export async function getCalendarToken(db: AppDb, personId: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT calendar_token FROM people WHERE id = ?`)
    .bind(personId)
    .first<{ calendar_token: string | null }>();
  return row?.calendar_token ?? null;
}

/**
 * Generate (or regenerate) the person's calendar token: 32 lowercase hex chars
 * from 16 crypto-random bytes. Overwrites any previous token, so an old
 * subscription URL stops resolving — that is the revocation story.
 */
export async function generateCalendarToken(db: AppDb, personId: number): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await db.prepare(`UPDATE people SET calendar_token = ? WHERE id = ?`).bind(token, personId).run();
  return token;
}
