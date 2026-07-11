// Postgres-backed e2e for the member portal's personal calendar and its public
// iCal feed (Member Portal Phase 4, Task 4): /my/calendar's month grid gains
// group-meeting + event-registration dots (buildCalendarMarks' `meetings`/
// `events` options, Task 1-3), and /cal/[token].ics gains the matching
// `c4c-group-<id>-<date>` / `c4c-reg-<id>` VEVENTs (ical.ts's
// meetingToICalEvent/regToICalEvent). All driven through the BUILT worker
// (SELF.fetch) over Postgres.
//
// Seed anchors (seed/dev-seed.sql + seed/portal-seed.sql): group 1
// ('young-adults', Young Adults Fellowship) has David Chen (person 2) as
// leader and Amy Chen (person 7) as a plain member, but ships with no
// meeting_weekday/time/frequency — this file sets those directly (a Monday,
// 19:30, weekly) in beforeAll so the group has real recurring occurrences.
// Ben Wu (person 8) belongs to neither seeded group — the negative-feed
// anchor. reg_events/registrations carry no seed rows (see
// portal-dashboard.test.ts's header), so a reg_event + a confirmed
// registration for David are fabricated here through the same library
// writers (saveEvent/createRegistration) the admin console and Stripe
// webhooks use. The event's start date is pinned to day 15 of the CURRENT
// month (todayInTz-derived, never hardcoded) since /my/calendar defaults to
// the current month.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { get, post } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { openDb, type DbEnv } from '../../src/lib/dbProvider';
import { saveEvent, createRegistration } from '../../src/lib/regDb';
import { generateCalendarToken, getCalendarToken } from '../../src/lib/ical';
import { computeMeetingDates } from '../../src/lib/groupDb';
import { addDays, datetimeLocalToUtc, todayInTz } from '../../src/lib/dates';
import type { AppDb } from '../../src/lib/appDb';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

/** Open a request-scoped Postgres AppDb (same factory the worker uses), run
 *  `fn`, then drain the client — mirrors portal-dashboard.test.ts. */
async function withDb<T>(fn: (db: AppDb) => Promise<T>): Promise<T> {
  const { db, end } = openDb(env as unknown as DbEnv);
  try {
    return await fn(db);
  } finally {
    await end();
  }
}

const DAVID_ID = 2;
const DAVID_EMAIL = 'pastor.david@example.com';
const BEN_ID = 8; // in no group — the negative-feed anchor (mints his token directly, no session needed)
const GROUP_1 = 1; // young-adults fellowship: David leads it, Ben is not a member
const MEETING_WEEKDAY = 1; // Monday — arbitrary; group 1 has no term bounds, so every month has one

const ym = todayInTz().slice(0, 7); // current 'YYYY-MM' — the month /my/calendar defaults to

beforeAll(async () => {
  // Give group 1 a real weekly meeting schedule (seeded with none — see header).
  await withDb((db) =>
    db
      .prepare(`UPDATE member_groups SET meeting_weekday = ?1, meeting_time = '19:30', meeting_frequency = 'weekly' WHERE id = ?2`)
      .bind(MEETING_WEEKDAY, GROUP_1)
      .run(),
  );

  // A reg_event landing on day 15 of the CURRENT month, plus a confirmed
  // registration for David, through the same writers /register and the
  // Stripe webhook use.
  const eventId = await withDb((db) =>
    saveEvent(db, {
      title_en: 'E2E Calendar Retreat',
      title_zh: '',
      starts_at: datetimeLocalToUtc(`${ym}-15T10:00`)!,
      active: 1,
    }),
  );
  await withDb((db) =>
    createRegistration(db, {
      eventId,
      personId: DAVID_ID,
      name: '陈大卫 David Chen',
      email: DAVID_EMAIL,
      status: 'confirmed',
      amountCents: 0,
      currency: 'usd',
      answers: [],
    }),
  );
});

describe('Postgres-backed worker: /my/calendar (month marks)', () => {
  it('David GETs /en/my/calendar: 200, group-meeting + event dots and legend render for the current month', async () => {
    const res = await get('/en/my/calendar', { cookie: await sessionCookie(DAVID_ID, DAVID_EMAIL) });
    expect(res.status).toBe(200);
    const body = await res.text();
    // MonthCalendar's meeting dot: title = [group_name, meeting_time, meeting_location].join(' · ')
    expect(body).toContain('title="Young Adults Fellowship · 19:30"');
    // MonthCalendar's event dot: title = event_title
    expect(body).toContain('title="E2E Calendar Retreat"');
    expect(body).toContain('Event'); // portal.calendar.legendEvent
    expect(body).toContain('Group meeting'); // portal.calendar.legendMeeting
  });
});

describe('Postgres-backed worker: /cal/[token].ics (calendar-feed expansion)', () => {
  let davidToken: string;

  it('David generates his token (POST _action=token) then GETs the feed: group-meeting UID/local time + registration UID', async () => {
    const cookie = await sessionCookie(DAVID_ID, DAVID_EMAIL);
    const genRes = await post('/en/my/calendar', '_action=token', { cookie });
    expect(genRes.status).toBe(303);
    expect(genRes.headers.get('location')).toBe('/en/my/calendar');

    davidToken = (await withDb((db) => getCalendarToken(db, DAVID_ID)))!;
    expect(davidToken).toMatch(/^[0-9a-f]{32}$/);

    const res = await get(`/cal/${davidToken}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    const ics = await res.text();

    // Group-meeting occurrences: same weekly window the route queries
    // (today-30 .. today+180), computed independently via the pure
    // computeMeetingDates helper rather than re-deriving the route's logic.
    const from = addDays(todayInTz(), -30);
    const to = addDays(todayInTz(), 180);
    const occurrences = computeMeetingDates(
      { meeting_weekday: MEETING_WEEKDAY, meeting_frequency: 'weekly', term_start: null, term_end: null, created_at: '2020-01-01 00:00:00' },
      from,
      to,
    );
    expect(occurrences.length).toBeGreaterThan(0);
    const occ = occurrences[0].replace(/-/g, '');
    expect(ics).toContain(`UID:c4c-group-${GROUP_1}-${occ}@church.example`);
    expect(ics).toContain(`DTSTART:${occ}T193000`); // meeting_time 19:30, floating local time

    expect(ics).toMatch(/UID:c4c-reg-\d+@church\.example/); // David's registration VEVENT
  });

  it("Ben's feed (not a group-1 member) has no c4c-group-1- meeting UID", async () => {
    const benToken = await withDb((db) => generateCalendarToken(db, BEN_ID));
    const res = await get(`/cal/${benToken}.ics`);
    expect(res.status).toBe(200);
    const ics = await res.text();
    expect(ics).not.toContain(`c4c-group-${GROUP_1}-`);
  });

  it('David regenerates his token: the old feed URL 404s, the new one 200s', async () => {
    const cookie = await sessionCookie(DAVID_ID, DAVID_EMAIL);
    const oldToken = davidToken;

    const res = await post('/en/my/calendar', '_action=token', { cookie });
    expect(res.status).toBe(303);

    const newToken = await withDb((db) => getCalendarToken(db, DAVID_ID));
    expect(newToken).not.toBe(oldToken);

    expect((await get(`/cal/${oldToken}.ics`)).status).toBe(404);
    expect((await get(`/cal/${newToken}.ics`)).status).toBe(200);
  });
});
