// Minimal iCalendar (RFC 5545) feed builder for a volunteer's serving schedule,
// plus the people.calendar_token helpers behind /cal/[token].ics. Ported from
// the reference stack's src/lib/ical.ts, adapted to church-cms: the caller passes the FULL
// UID (stable `c4c-assignment-<id>@<host>`), and the token is an explicit
// generate/regenerate action (32 hex chars) instead of create-on-view —
// regenerating invalidates the old subscription URL.

export interface ICalEvent {
  /** Full, stable UID (e.g. `c4c-assignment-42@church.example`). */
  uid: string;
  date: string; // 'YYYY-MM-DD'
  summary: string;
  description?: string;
  startTime?: string | null; // 'HH:MM' — timed event when BOTH present, else all-day
  endTime?: string | null;
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
      : [`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${nextDay(e.date)}`];
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

/** The person's current calendar-feed token, or null when never generated. */
export async function getCalendarToken(db: D1Database, personId: number): Promise<string | null> {
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
export async function generateCalendarToken(db: D1Database, personId: number): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await db.prepare(`UPDATE people SET calendar_token = ? WHERE id = ?`).bind(token, personId).run();
  return token;
}
