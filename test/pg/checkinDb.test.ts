import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getHouseholdForKiosk, todayRoster, weeklyStats } from '../../src/lib/checkinDb';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('children check-in result contracts (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: PgAdapter;
  const today = '2026-07-05';

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    db = new PgAdapter(sql);
    await sql.unsafe(`
      INSERT INTO households (id, name) VALUES (1, 'Chen Family');
      INSERT INTO household_members (id, household_id, display_name, role) VALUES
        (1, 1, 'Ethan Chen', 'child'), (2, 1, 'Mia Chen', 'child');
      INSERT INTO checkin_events (id, name, active) VALUES
        (10, 'Nursery', 1), (11, 'Blue Room', 1);
      INSERT INTO checkins
        (id, event_id, household_id, household_member_id, child_name, security_code,
         checkin_date, checked_in_at, checked_out_at) VALUES
        (1, 10, 1, 1, 'Ethan Chen', 'A2B3', '2026-06-27', '2026-06-27 09:00:00', NULL),
        (2, 10, 1, 1, 'Ethan Chen', 'A2B3', '2026-06-28', '2026-06-28 09:00:00', NULL),
        (3, 10, 1, 2, 'Mia Chen', 'C4D5', '2026-07-05', '2026-07-05 09:00:00', NULL),
        (4, 11, 1, 2, 'Mia Chen', 'E6F7', '2026-07-05', '2026-07-05 09:30:00', '2026-07-05 10:00:00')
    `);
  });

  afterAll(async () => { await sql?.end(); });

  it('buckets TEXT check-in dates across Saturday/Sunday and preserves numeric event totals', async () => {
    const stats = await weeklyStats(db, { today });
    expect(stats.weeks).toHaveLength(12);
    expect(stats.weeks.slice(-4)).toEqual([
      { weekStart: '2026-06-14', total: 0 },
      { weekStart: '2026-06-21', total: 1 },
      { weekStart: '2026-06-28', total: 1 },
      { weekStart: today, total: 2 },
    ]);
    expect(stats).toMatchObject({ thisWeek: 2, fourWeekAvg: 1, distinctChildrenThisMonth: 1, activeEvents: 2 });
    expect(stats.byEvent.slice().sort((a, b) => a.eventId - b.eventId)).toEqual([
      { eventId: 10, name: 'Nursery', counts: [0, 1, 1, 1] },
      { eventId: 11, name: 'Blue Room', counts: [0, 0, 0, 1] },
    ]);
  });

  it('returns the staff roster identities, pickup codes, and timestamp strings under their declared keys', async () => {
    expect(await todayRoster(db, today)).toEqual([
      { checkinId: 3, childName: 'Mia Chen', householdName: 'Chen Family', eventName: 'Nursery',
        securityCode: 'C4D5', checkedInAt: '2026-07-05 09:00:00', checkedOutAt: null },
      { checkinId: 4, childName: 'Mia Chen', householdName: 'Chen Family', eventName: 'Blue Room',
        securityCode: 'E6F7', checkedInAt: '2026-07-05 09:30:00', checkedOutAt: '2026-07-05 10:00:00' },
    ]);
  });

  it('associates existing open and checked-out kiosk entries with the correct child', async () => {
    expect(await getHouseholdForKiosk(db, 1, today)).toEqual({
      id: 1, name: 'Chen Family', children: [
        { memberId: 1, name: 'Ethan Chen', checkins: [] },
        { memberId: 2, name: 'Mia Chen', checkins: expect.arrayContaining([
          { checkinId: 3, eventId: 10, eventName: 'Nursery', securityCode: 'C4D5', checkedOutAt: null },
          { checkinId: 4, eventId: 11, eventName: 'Blue Room', securityCode: 'E6F7', checkedOutAt: '2026-07-05 10:00:00' },
        ]) },
      ],
    });
  });
});
