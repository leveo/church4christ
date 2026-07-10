// groupEventDb (workers project, live D1). Event CRUD, occurrence generation for
// every recurrence kind (incl. ends_on, idempotency, horizon clamp), and the
// occurrence reads — especially the needing-attendance window boundaries.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, todayInTz } from '../src/lib/dates';
import {
  createEvent,
  ensureOccurrences,
  getEvent,
  getOccurrenceWithEvent,
  listEventsForGroup,
  listOccurrencesNeedingAttendance,
  listUpcomingOccurrencesForGroup,
  softDeleteEvent,
  type GroupEventInput,
} from '../src/lib/groupEventDb';

const TZ = 'America/Chicago';

async function reset(): Promise<number> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM group_attendance'),
    env.DB.prepare('DELETE FROM group_event_occurrences'),
    env.DB.prepare('DELETE FROM group_events'),
    env.DB.prepare('DELETE FROM groups'),
  ]);
  const g = await env.DB.prepare(`INSERT INTO groups (name) VALUES ('G') RETURNING id`).first<{ id: number }>();
  return g!.id;
}

let groupId: number;
beforeEach(async () => {
  groupId = await reset();
});

const base: GroupEventInput = {
  title: 'Bible Study',
  description: 'desc',
  location: 'Hall',
  recurrence: 'weekly',
  startsOn: '2030-06-07',
  startTime: '19:00',
  durationMin: 90,
  endsOn: null,
  trackAttendance: true,
};

async function occurrenceDates(eventId: number): Promise<string[]> {
  const { results } = await env.DB
    .prepare(`SELECT occurs_on FROM group_event_occurrences WHERE event_id = ?1 AND deleted_at IS NULL ORDER BY occurs_on`)
    .bind(eventId)
    .all<{ occurs_on: string }>();
  return results.map((r: { occurs_on: string }) => r.occurs_on);
}

describe('event CRUD', () => {
  it('creates, reads, lists, and soft-deletes an event', async () => {
    const id = await createEvent(env.DB, groupId, base);
    expect((await getEvent(env.DB, id))).toMatchObject({ title: 'Bible Study', recurrence: 'weekly', track_attendance: 1 });
    expect(await listEventsForGroup(env.DB, groupId)).toHaveLength(1);
    await softDeleteEvent(env.DB, id);
    expect(await getEvent(env.DB, id)).toBeNull();
    expect(await listEventsForGroup(env.DB, groupId)).toHaveLength(0);
  });
});

describe('ensureOccurrences recurrence', () => {
  const NOW = new Date('2030-06-01T12:00:00Z');

  it('weekly generates every 7 days through the horizon', async () => {
    const id = await createEvent(env.DB, groupId, base);
    const n = await ensureOccurrences(env.DB, (await getEvent(env.DB, id))!, '2030-06-28', NOW);
    expect(n).toBe(4);
    expect(await occurrenceDates(id)).toEqual(['2030-06-07', '2030-06-14', '2030-06-21', '2030-06-28']);
  });

  it('biweekly generates every 14 days', async () => {
    const id = await createEvent(env.DB, groupId, { ...base, recurrence: 'biweekly' });
    await ensureOccurrences(env.DB, (await getEvent(env.DB, id))!, '2030-07-05', NOW);
    expect(await occurrenceDates(id)).toEqual(['2030-06-07', '2030-06-21', '2030-07-05']);
  });

  it('monthly keeps the day-of-month and skips months that lack it', async () => {
    const id = await createEvent(env.DB, groupId, { ...base, recurrence: 'monthly', startsOn: '2030-01-31' });
    await ensureOccurrences(env.DB, (await getEvent(env.DB, id))!, '2030-05-31', new Date('2030-01-01T12:00:00Z'));
    // Feb (28) and Apr (30) lack the 31st → skipped.
    expect(await occurrenceDates(id)).toEqual(['2030-01-31', '2030-03-31', '2030-05-31']);
  });

  it('none generates exactly one occurrence at starts_on', async () => {
    const id = await createEvent(env.DB, groupId, { ...base, recurrence: 'none' });
    const n = await ensureOccurrences(env.DB, (await getEvent(env.DB, id))!, '2030-12-31', NOW);
    expect(n).toBe(1);
    expect(await occurrenceDates(id)).toEqual(['2030-06-07']);
  });

  it('respects ends_on', async () => {
    const id = await createEvent(env.DB, groupId, { ...base, endsOn: '2030-06-14' });
    await ensureOccurrences(env.DB, (await getEvent(env.DB, id))!, '2030-07-31', NOW);
    expect(await occurrenceDates(id)).toEqual(['2030-06-07', '2030-06-14']);
  });

  it('is idempotent (ON CONFLICT revives, never duplicates)', async () => {
    const id = await createEvent(env.DB, groupId, base);
    const ev = (await getEvent(env.DB, id))!;
    await ensureOccurrences(env.DB, ev, '2030-06-28', NOW);
    await ensureOccurrences(env.DB, ev, '2030-06-28', NOW);
    expect(await occurrenceDates(id)).toEqual(['2030-06-07', '2030-06-14', '2030-06-21', '2030-06-28']);
  });

  it('clamps a runaway horizon to today+370 days', async () => {
    const id = await createEvent(env.DB, groupId, base);
    const n = await ensureOccurrences(env.DB, (await getEvent(env.DB, id))!, '2099-01-01', NOW);
    // 5+ years of weekly would be ~260 rows; the clamp keeps it near one year.
    expect(n).toBeLessThan(60);
    const dates = await occurrenceDates(id);
    const cap = addDays(todayInTz(TZ, NOW), 370);
    expect(dates[dates.length - 1] <= cap).toBe(true);
  });

  it('computes UTC starts_at/ends_at with the duration applied', async () => {
    const id = await createEvent(env.DB, groupId, { ...base, recurrence: 'none' });
    await ensureOccurrences(env.DB, (await getEvent(env.DB, id))!, '2030-12-31', NOW);
    const row = await env.DB
      .prepare(`SELECT starts_at, ends_at FROM group_event_occurrences WHERE event_id = ?1`)
      .bind(id)
      .first<{ starts_at: string; ends_at: string }>();
    // 19:00 America/Chicago on 2030-06-07 (CDT, UTC-5) → 00:00 UTC next day; +90 min → 01:30.
    expect(row?.starts_at).toBe('2030-06-08 00:00:00');
    expect(row?.ends_at).toBe('2030-06-08 01:30:00');
  });
});

describe('occurrence reads', () => {
  it('listUpcomingOccurrencesForGroup returns future occurrences of live active events', async () => {
    const id = await createEvent(env.DB, groupId, base);
    await ensureOccurrences(env.DB, (await getEvent(env.DB, id))!, '2030-06-28', new Date('2030-06-01T12:00:00Z'));
    const upcoming = await listUpcomingOccurrencesForGroup(env.DB, groupId, new Date('2030-06-15T12:00:00Z'));
    expect(upcoming.map((o) => o.occurs_on)).toEqual(['2030-06-21', '2030-06-28']);
    expect(upcoming[0]).toMatchObject({ title: 'Bible Study', track_attendance: 1 });
  });

  it('getOccurrenceWithEvent joins the event + group, null when missing', async () => {
    const id = await createEvent(env.DB, groupId, { ...base, recurrence: 'none' });
    await ensureOccurrences(env.DB, (await getEvent(env.DB, id))!, '2030-12-31', new Date('2030-06-01T12:00:00Z'));
    const occ = (await occurrenceRow(id));
    const got = await getOccurrenceWithEvent(env.DB, occ);
    expect(got).toMatchObject({ group_id: groupId, group_name: 'G', title: 'Bible Study', occurs_on: '2030-06-07' });
    expect(await getOccurrenceWithEvent(env.DB, 999999)).toBeNull();
  });
});

describe('listOccurrencesNeedingAttendance boundaries', () => {
  const NOW = new Date('2030-06-10T12:00:00Z'); // nowSql = '2030-06-10 12:00:00'

  async function occ(endsAt: string, opts: { claimed?: boolean; track?: boolean; active?: boolean } = {}): Promise<void> {
    const ev = await env.DB
      .prepare(
        `INSERT INTO group_events (group_id, title, recurrence, starts_on, start_time, track_attendance, active)
         VALUES (?1, 'E', 'weekly', '2030-06-01', '19:00', ?2, ?3) RETURNING id`,
      )
      .bind(groupId, opts.track === false ? 0 : 1, opts.active === false ? 0 : 1)
      .first<{ id: number }>();
    await env.DB
      .prepare(
        `INSERT INTO group_event_occurrences (event_id, occurs_on, starts_at, ends_at, attendance_email_sent_at)
         VALUES (?1, ?2, '2030-06-01 00:00:00', ?3, ?4)`,
      )
      .bind(ev!.id, endsAt.slice(0, 10), endsAt, opts.claimed ? '2030-06-10 11:00:00' : null)
      .run();
  }

  it('includes just-ended, excludes >24h, not-ended, already-claimed, untracked, inactive', async () => {
    await occ('2030-06-10 11:00:00'); // 1h ago → YES
    await occ('2030-06-09 10:00:00'); // 26h ago → too old
    await occ('2030-06-10 13:00:00'); // future → not ended
    await occ('2030-06-10 11:30:00', { claimed: true }); // already claimed
    await occ('2030-06-10 11:15:00', { track: false }); // not tracked
    await occ('2030-06-10 11:45:00', { active: false }); // inactive event

    const due = await listOccurrencesNeedingAttendance(env.DB, NOW);
    expect(due.map((o) => o.ends_at)).toEqual(['2030-06-10 11:00:00']);
  });
});

async function occurrenceRow(eventId: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT id FROM group_event_occurrences WHERE event_id = ?1`).bind(eventId).first<{ id: number }>();
  return row!.id;
}
