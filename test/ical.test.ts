// iCal builder format tests (RFC 5545: CRLF, escaping, all-day vs timed, UID
// stability, multi-day all-day spans) plus the calendar-token generate/regenerate
// lifecycle against a live D1 (workers project).
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildICal,
  generateCalendarToken,
  getCalendarToken,
  occurrenceToICalEvent,
  regToICalEvent,
  type ICalEvent,
} from '../src/lib/ical';
import type { PersonOccurrence } from '../src/lib/groupEventDb';
import type { MyRegistration } from '../src/lib/regDb';

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

    const half = buildICal('c', [eventOf({ startTime: '09:30', endTime: null })], STAMP);
    expect(half).toContain('DTSTART;VALUE=DATE:20260712');

    const roll = buildICal('c', [eventOf({ date: '2026-07-31' })], STAMP);
    expect(roll).toContain('DTEND;VALUE=DATE:20260801');
  });

  it('renders a timed floating event when both times are present (no TZID, no Z)', () => {
    const ics = buildICal('c', [eventOf({ startTime: '09:30', endTime: '10:45' })], STAMP);
    expect(ics).toContain('DTSTART:20260712T093000\r\n');
    expect(ics).toContain('DTEND:20260712T104500\r\n');
    expect(ics).not.toContain('TZID');
  });

  it('honors endDate for a multi-day all-day span (DTEND exclusive of the day after)', () => {
    const ics = buildICal('c', [eventOf({ startTime: null, endTime: null, endDate: '2026-07-14' })], STAMP);
    expect(ics).toContain('DTSTART;VALUE=DATE:20260712');
    expect(ics).toContain('DTEND;VALUE=DATE:20260715');
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

describe('occurrenceToICalEvent', () => {
  function occOf(over: Partial<PersonOccurrence> = {}): PersonOccurrence {
    return {
      id: 7,
      group_id: 6,
      group_name: 'Campus Fellowship',
      title: 'Bible Study',
      location: 'Room 203',
      occurs_on: '2026-07-12',
      starts_at: '2026-07-13 00:00:00', // 2026-07-12 19:00 local (America/Chicago, CDT UTC-5)
      ends_at: '2026-07-13 02:00:00', //   2026-07-12 21:00 local
      ...over,
    };
  }

  it('converts UTC start/end to church-local as a timed event with a stable per-occurrence UID', () => {
    const e = occurrenceToICalEvent(occOf(), 'church.example');
    expect(e).toMatchObject({
      uid: 'c4c-groupocc-7@church.example',
      date: '2026-07-12',
      summary: 'Campus Fellowship — Bible Study',
      description: 'Room 203',
      startTime: '19:00',
      endTime: '21:00',
    });
  });

  it('renders an occurrence spanning local midnight as a 2-day all-day span', () => {
    // Local: starts 2026-07-12 22:00, ends 2026-07-13 01:00.
    const e = occurrenceToICalEvent(occOf({ starts_at: '2026-07-13 03:00:00', ends_at: '2026-07-13 06:00:00' }), 'church.example');
    expect(e.date).toBe('2026-07-12');
    expect(e.endDate).toBe('2026-07-13');
    expect(e.startTime).toBeNull();
    expect(e.endTime).toBeNull();

    const ics = buildICal('c', [e], STAMP);
    expect(ics).toContain('DTSTART;VALUE=DATE:20260712');
    expect(ics).toContain('DTEND;VALUE=DATE:20260714');
  });
});

describe('regToICalEvent', () => {
  function regOf(over: Partial<MyRegistration> = {}): MyRegistration {
    return {
      id: 9,
      event_id: 1,
      event_title: 'Fall Retreat',
      starts_at: '2026-07-12 14:30:00',
      ends_at: '2026-07-12 16:00:00',
      location: 'Camp Hall',
      status: 'confirmed',
      amount_cents: 0,
      currency: 'usd',
      created_at: '2026-06-01 00:00:00',
      ...over,
    };
  }

  it('converts UTC to church-local wall clock as a timed event when both times convert', () => {
    const e = regToICalEvent(regOf(), 'church.example');
    expect(e).toMatchObject({
      uid: 'c4c-reg-9@church.example',
      date: '2026-07-12',
      summary: 'Fall Retreat',
      description: 'Camp Hall',
      startTime: '09:30', // America/Chicago, CDT (UTC-5) in July
      endTime: '11:00',
    });
  });

  it('appends " (?)" to a pending registration, mirroring the serving convention', () => {
    const e = regToICalEvent(regOf({ status: 'pending' }), 'church.example');
    expect(e.summary).toBe('Fall Retreat (?)');
  });

  it('falls back to all-day on the start date when ends_at is missing', () => {
    const e = regToICalEvent(regOf({ ends_at: null }), 'church.example');
    expect(e.date).toBe('2026-07-12');
    expect(e.startTime).toBeNull();
    expect(e.endTime).toBeNull();
  });

  it('renders an overnight registration as a 2-day all-day span', () => {
    const e = regToICalEvent(
      regOf({ starts_at: '2026-07-13 00:00:00', ends_at: '2026-07-13 12:00:00' }),
      'church.example',
    );
    expect(e.date).toBe('2026-07-12');
    expect(e.endDate).toBe('2026-07-13');
    expect(e.startTime).toBeNull();
    expect(e.endTime).toBeNull();

    const ics = buildICal('c', [e], STAMP);
    expect(ics).toContain('DTSTART;VALUE=DATE:20260712');
    expect(ics).toContain('DTEND;VALUE=DATE:20260714');
    expect(ics.indexOf('DTSTART')).toBeLessThan(ics.indexOf('DTEND'));
  });

  it('renders a 3-day retreat as an all-day span (DTEND exclusive of the day after the last day)', () => {
    const e = regToICalEvent(
      regOf({ starts_at: '2026-07-10 14:00:00', ends_at: '2026-07-12 21:00:00' }),
      'church.example',
    );
    expect(e.date).toBe('2026-07-10');
    expect(e.endDate).toBe('2026-07-12');
    expect(e.startTime).toBeNull();
    expect(e.endTime).toBeNull();

    const ics = buildICal('c', [e], STAMP);
    expect(ics).toContain('DTSTART;VALUE=DATE:20260710');
    expect(ics).toContain('DTEND;VALUE=DATE:20260713');
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

    const stale = await env.DB
      .prepare(`SELECT id FROM people WHERE calendar_token = ?`)
      .bind(first)
      .first<{ id: number }>();
    expect(stale).toBeNull();
  });
});
