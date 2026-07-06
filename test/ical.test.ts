// iCal builder format tests (RFC 5545: CRLF, escaping, all-day vs timed, UID
// stability) plus the calendar-token generate/regenerate lifecycle against a
// live D1 (workers project).
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildICal, generateCalendarToken, getCalendarToken, type ICalEvent } from '../src/lib/ical';

const STAMP = '20260706T000000Z';

function eventOf(over: Partial<ICalEvent> = {}): ICalEvent {
  return {
    uid: 'c4c-assignment-42@church.example',
    date: '2026-07-12',
    summary: 'Vocalist — Sunday Worship (English)',
    ...over,
  };
}

describe('buildICal', () => {
  it('emits a VCALENDAR wrapper with CRLF line endings throughout', () => {
    const ics = buildICal('C4C — Test', [eventOf()], STAMP);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    // No bare \n anywhere: splitting on CRLF must leave no residual newlines.
    for (const line of ics.split('\r\n')) expect(line).not.toContain('\n');
    expect(ics).toContain('VERSION:2.0\r\n');
    expect(ics).toContain('PRODID:-//Church4Christ//EN\r\n');
    expect(ics).toContain(`DTSTAMP:${STAMP}\r\n`);
    expect(ics).toContain('X-WR-CALNAME:C4C — Test\r\n');
  });

  it('renders an all-day event when either time is missing (exclusive DTEND = next day)', () => {
    const ics = buildICal('c', [eventOf({ startTime: null, endTime: null })], STAMP);
    expect(ics).toContain('DTSTART;VALUE=DATE:20260712');
    expect(ics).toContain('DTEND;VALUE=DATE:20260713');

    // Half a time pair is NOT a timed event.
    const half = buildICal('c', [eventOf({ startTime: '09:30', endTime: null })], STAMP);
    expect(half).toContain('DTSTART;VALUE=DATE:20260712');

    // Month rollover: Jul 31 all-day ends Aug 1.
    const roll = buildICal('c', [eventOf({ date: '2026-07-31' })], STAMP);
    expect(roll).toContain('DTEND;VALUE=DATE:20260801');
  });

  it('renders a timed floating event when both times are present (no TZID, no Z)', () => {
    const ics = buildICal('c', [eventOf({ startTime: '09:30', endTime: '10:45' })], STAMP);
    expect(ics).toContain('DTSTART:20260712T093000\r\n');
    expect(ics).toContain('DTEND:20260712T104500\r\n');
    expect(ics).not.toContain('TZID');
  });

  it('escapes commas, semicolons, backslashes, and newlines in text fields', () => {
    const ics = buildICal('Name, with; specials\\', [
      eventOf({ summary: 'a,b;c\\d', description: 'line1\nline2' }),
    ], STAMP);
    expect(ics).toContain('X-WR-CALNAME:Name\\, with\\; specials\\\\');
    expect(ics).toContain('SUMMARY:a\\,b\\;c\\\\d');
    expect(ics).toContain('DESCRIPTION:line1\\nline2');
  });

  it('passes the caller-supplied UID through verbatim (stable per assignment)', () => {
    const a = buildICal('c', [eventOf()], STAMP);
    const b = buildICal('c', [eventOf({ summary: 'renamed' })], '20991231T000000Z');
    expect(a).toContain('UID:c4c-assignment-42@church.example\r\n');
    expect(b).toContain('UID:c4c-assignment-42@church.example\r\n');
  });

  it('renders an empty calendar without VEVENTs', () => {
    const ics = buildICal('c', [], STAMP);
    expect(ics).not.toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VCALENDAR\r\n');
  });
});

describe('calendar token lifecycle', () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM people WHERE id = 71`).run();
    await env.DB
      .prepare(`INSERT INTO people (id, display_name, email) VALUES (71, 'Token Person', 'token71@example.com')`)
      .run();
  });

  it('starts null, generates 32 lowercase hex chars, and regenerating invalidates the old token', async () => {
    expect(await getCalendarToken(env.DB, 71)).toBeNull();

    const first = await generateCalendarToken(env.DB, 71);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(await getCalendarToken(env.DB, 71)).toBe(first);

    const second = await generateCalendarToken(env.DB, 71);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
    expect(await getCalendarToken(env.DB, 71)).toBe(second);

    // The old token matches no row anymore — the feed lookup 404s.
    const stale = await env.DB
      .prepare(`SELECT id FROM people WHERE calendar_token = ?`)
      .bind(first)
      .first<{ id: number }>();
    expect(stale).toBeNull();
  });
});
