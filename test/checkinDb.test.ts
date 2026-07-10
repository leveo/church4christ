// checkinDb (workers project, live D1). Covers Task 2's slice: check-in events
// admin CRUD (list/save/toggle) and the kiosk household search — digit-mode vs
// name-mode dispatch, LIKE-escaping, phone digit-stripping across households.phone
// and an adult member's people.phone, and the "only households with a child"
// filter. Task 3 adds check-in/checkout, the kiosk household status view, the
// roster, and weekly stats.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listEventsAdmin,
  listActiveEvents,
  saveEvent,
  toggleEventActive,
  searchHouseholds,
  checkInChildren,
  checkOutChild,
  staffCheckOut,
  getHouseholdForKiosk,
  todayRoster,
  weeklyStats,
  generateSecurityCode,
} from '../src/lib/checkinDb';

async function reset(): Promise<void> {
  // FK dependency order: checkins -> checkin_events / household_members ->
  // households / people.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM checkins'),
    env.DB.prepare('DELETE FROM checkin_events'),
    env.DB.prepare('DELETE FROM household_members'),
    env.DB.prepare('DELETE FROM households'),
    env.DB.prepare('DELETE FROM people'),
  ]);
}
beforeEach(reset);

/** Seed the three households used by the search tests. */
async function seedHouseholds(): Promise<void> {
  const david = await env.DB
    .prepare('INSERT INTO people (display_name, email, phone) VALUES (?, ?, ?) RETURNING id')
    .bind('David Chen', 'david@example.com', '(555) 010-2000')
    .first<{ id: number }>();
  const chen = await env.DB
    .prepare('INSERT INTO households (name, phone) VALUES (?, ?) RETURNING id')
    .bind('Chen Family', '(555) 010-2000')
    .first<{ id: number }>();
  await env.DB.batch([
    env.DB
      .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, ?, ?, 'adult', 1)`)
      .bind(chen!.id, david!.id, 'David Chen'),
    env.DB
      .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, NULL, ?, 'child', 0)`)
      .bind(chen!.id, 'Ethan Chen'),
    env.DB
      .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, NULL, ?, 'child', 0)`)
      .bind(chen!.id, 'Mia Chen'),
  ]);

  const grace = await env.DB
    .prepare('INSERT INTO people (display_name, email, phone) VALUES (?, ?, ?) RETURNING id')
    .bind('Grace Lin', 'grace@example.com', '555-333-4444')
    .first<{ id: number }>();
  const lin = await env.DB
    .prepare('INSERT INTO households (name, phone) VALUES (?, NULL) RETURNING id')
    .bind('Lin Family')
    .first<{ id: number }>();
  await env.DB.batch([
    env.DB
      .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, ?, ?, 'adult', 1)`)
      .bind(lin!.id, grace!.id, 'Grace Lin'),
    env.DB
      .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, NULL, ?, 'child', 0)`)
      .bind(lin!.id, 'Noah Lin'),
  ]);

  const zhaoAdult = await env.DB
    .prepare('INSERT INTO people (display_name, email, phone) VALUES (?, ?, ?) RETURNING id')
    .bind('Amy Zhao', 'amy.zhao@example.com', '555-999-0000')
    .first<{ id: number }>();
  const zhao = await env.DB
    .prepare('INSERT INTO households (name, phone) VALUES (?, NULL) RETURNING id')
    .bind('Zhao')
    .first<{ id: number }>();
  await env.DB
    .prepare(`INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (?, ?, ?, 'adult', 1)`)
    .bind(zhao!.id, zhaoAdult!.id, 'Amy Zhao')
    .run();
}

describe('checkin events admin CRUD', () => {
  it('saveEvent creates and updates; listEventsAdmin returns all', async () => {
    const id = await saveEvent(env.DB, { name: 'Nursery', weekday: 0 });
    expect(id).toBeGreaterThan(0);
    await saveEvent(env.DB, { id, name: 'Nursery (Sunday)', weekday: 0 });
    await saveEvent(env.DB, { name: "Kids' Church", weekday: null });

    const all = await listEventsAdmin(env.DB);
    expect(all).toHaveLength(2);
    const nursery = all.find((e) => e.id === id)!;
    expect(nursery.name).toBe('Nursery (Sunday)');
    expect(nursery.weekday).toBe(0);
  });

  it('listActiveEvents filters by weekday and NULL-weekday events always match', async () => {
    const sunday = await saveEvent(env.DB, { name: 'Sunday Nursery', weekday: 0 });
    const everyday = await saveEvent(env.DB, { name: 'Everyday Kids', weekday: null });
    const wednesday = await saveEvent(env.DB, { name: 'Wednesday Kids', weekday: 3 });

    const onSunday = await listActiveEvents(env.DB, 0);
    expect(onSunday.map((e) => e.id).sort()).toEqual([sunday, everyday].sort());

    const onWednesday = await listActiveEvents(env.DB, 3);
    expect(onWednesday.map((e) => e.id).sort()).toEqual([everyday, wednesday].sort());
  });

  it('toggleEventActive hides event from listActiveEvents', async () => {
    const id = await saveEvent(env.DB, { name: 'Nursery', weekday: null });
    expect(await listActiveEvents(env.DB, 0)).toHaveLength(1);

    await toggleEventActive(env.DB, id, false);
    expect(await listActiveEvents(env.DB, 0)).toHaveLength(0);
    expect((await listEventsAdmin(env.DB)).find((e) => e.id === id)!.active).toBe(0);

    await toggleEventActive(env.DB, id, true);
    expect(await listActiveEvents(env.DB, 0)).toHaveLength(1);
  });
});

describe('searchHouseholds', () => {
  beforeEach(seedHouseholds);

  it('search by partial child name is case-insensitive and returns household with adults+children', async () => {
    const hits = await searchHouseholds(env.DB, 'eth');
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('Chen Family');
    expect(hits[0].adults).toEqual(expect.arrayContaining(['David Chen']));
    expect(hits[0].children).toEqual(expect.arrayContaining(['Ethan Chen', 'Mia Chen']));
  });

  it('search by phone digits matches household phone regardless of formatting', async () => {
    const hits = await searchHouseholds(env.DB, '0102000');
    expect(hits.map((h) => h.name)).toEqual(['Chen Family']);
  });

  it('matches a leading/middle digit substring of a stored phone (contains, not ends-with)', async () => {
    // '55501' spans the area code into the prefix of '(555) 010-2000' —
    // neither a suffix nor a full number, so only a CONTAINS match finds it.
    const hits = await searchHouseholds(env.DB, '55501');
    expect(hits.map((h) => h.name)).toEqual(['Chen Family']);
  });

  it('search by adult person phone finds the household', async () => {
    const hits = await searchHouseholds(env.DB, '3334444');
    expect(hits.map((h) => h.name)).toEqual(['Lin Family']);
  });

  it('households without children never match', async () => {
    expect(await searchHouseholds(env.DB, 'zhao')).toEqual([]);
  });

  it('LIKE wildcards in query are escaped', async () => {
    expect(await searchHouseholds(env.DB, '%')).toEqual([]);
  });

  it('empty query returns []', async () => {
    expect(await searchHouseholds(env.DB, '')).toEqual([]);
    expect(await searchHouseholds(env.DB, '   ')).toEqual([]);
  });
});

describe('check-in/out, roster, and weekly stats', () => {
  // Fixed Sunday so week-start math ('weekStartOf') is deterministic; never
  // todayInTz() in these unit tests.
  const date = '2026-07-05';

  let chenId: number;
  let linId: number;
  let ethanId: number;
  let miaId: number;
  let davidAdultId: number;
  let noahId: number;
  let graceAdultMemberId: number;
  let eventId: number;

  beforeEach(async () => {
    await seedHouseholds();
    chenId = (await env.DB.prepare(`SELECT id FROM households WHERE name = 'Chen Family'`).first<{ id: number }>())!.id;
    linId = (await env.DB.prepare(`SELECT id FROM households WHERE name = 'Lin Family'`).first<{ id: number }>())!.id;
    ethanId = (
      await env.DB.prepare(`SELECT id FROM household_members WHERE household_id = ? AND display_name = 'Ethan Chen'`).bind(chenId).first<{ id: number }>()
    )!.id;
    miaId = (
      await env.DB.prepare(`SELECT id FROM household_members WHERE household_id = ? AND display_name = 'Mia Chen'`).bind(chenId).first<{ id: number }>()
    )!.id;
    davidAdultId = (
      await env.DB.prepare(`SELECT id FROM household_members WHERE household_id = ? AND display_name = 'David Chen'`).bind(chenId).first<{ id: number }>()
    )!.id;
    noahId = (
      await env.DB.prepare(`SELECT id FROM household_members WHERE household_id = ? AND display_name = 'Noah Lin'`).bind(linId).first<{ id: number }>()
    )!.id;
    graceAdultMemberId = (
      await env.DB.prepare(`SELECT id FROM household_members WHERE household_id = ? AND display_name = 'Grace Lin'`).bind(linId).first<{ id: number }>()
    )!.id;
    eventId = await saveEvent(env.DB, { name: 'Nursery', weekday: 0 });
  });

  describe('checkInChildren', () => {
    it('inserts rows, siblings share one code, names returned', async () => {
      const result = await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId, miaId], date });
      expect(result.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
      expect(result.checkedIn.slice().sort()).toEqual(['Ethan Chen', 'Mia Chen']);

      const { results } = await env.DB
        .prepare(`SELECT security_code AS code FROM checkins WHERE household_id = ? ORDER BY id`)
        .bind(chenId)
        .all<{ code: string }>();
      expect(results).toHaveLength(2);
      expect(results[0].code).toBe(result.code);
      expect(results[1].code).toBe(result.code);
    });

    it('second check-in same child/event/date is idempotent and keeps the code', async () => {
      const first = await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId], date });
      const second = await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId], date });
      expect(second.code).toBe(first.code);
      expect(second.checkedIn).toEqual(['Ethan Chen']);

      const { results } = await env.DB
        .prepare(`SELECT id FROM checkins WHERE household_id = ? AND household_member_id = ?`)
        .bind(chenId, ethanId)
        .all();
      expect(results).toHaveLength(1);
    });

    it('re-checking in a checked-out child re-opens the row instead of silently no-op-ing', async () => {
      const first = await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId], date });
      const checkin = await env.DB
        .prepare(`SELECT id FROM checkins WHERE household_id = ? AND household_member_id = ?`)
        .bind(chenId, ethanId)
        .first<{ id: number }>();
      const out = await checkOutChild(env.DB, { checkinId: checkin!.id, code: first.code });
      expect(out).toBe(true);

      const second = await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId], date });
      expect(second.code).toBe(first.code);
      expect(second.checkedIn).toEqual(['Ethan Chen']);

      const { results } = await env.DB
        .prepare(`SELECT id, checked_out_at AS checkedOutAt, security_code AS code FROM checkins WHERE household_id = ? AND household_member_id = ?`)
        .bind(chenId, ethanId)
        .all<{ id: number; checkedOutAt: string | null; code: string }>();
      expect(results).toHaveLength(1);
      expect(results[0].checkedOutAt).toBeNull();
      expect(results[0].code).toBe(first.code);
    });

    it('same household, different event gets a different code (not reused across events)', async () => {
      const otherEventId = await saveEvent(env.DB, { name: "Kids' Church", weekday: null });

      // Force distinct codes deterministically: the default code path draws
      // from crypto.getRandomValues, so stub it — the first call's buffer is
      // all-zero words ('AAAA'), the second all-30 words ('9999') — avoiding
      // a real (if astronomically unlikely) flake from letting two
      // independently-random 4-char codes collide.
      const fills = [0, 30];
      let call = 0;
      vi.spyOn(crypto, 'getRandomValues').mockImplementation(((buf: Uint32Array) => {
        buf.fill(fills[call++]);
        return buf;
      }) as typeof crypto.getRandomValues);
      try {
        const first = await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId], date });
        const second = await checkInChildren(env.DB, { eventId: otherEventId, householdId: chenId, memberIds: [miaId], date });
        expect(second.code).not.toBe(first.code);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('rejects member ids from another household', async () => {
      await expect(
        checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [graceAdultMemberId], date }),
      ).rejects.toThrow('no_children');
    });

    it('rejects an adult member id even within the same household', async () => {
      await expect(
        checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [davidAdultId], date }),
      ).rejects.toThrow('no_children');
    });

    it('rejects an empty memberIds list', async () => {
      await expect(checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [], date })).rejects.toThrow('no_children');
    });
  });

  describe('getHouseholdForKiosk', () => {
    it('shows checked-in status per event', async () => {
      await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId], date });

      const result = await getHouseholdForKiosk(env.DB, chenId, date);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Chen Family');

      const ethan = result!.children.find((c) => c.name === 'Ethan Chen')!;
      expect(ethan.checkins).toHaveLength(1);
      expect(ethan.checkins[0].eventName).toBe('Nursery');
      expect(ethan.checkins[0].checkedOutAt).toBeNull();

      const mia = result!.children.find((c) => c.name === 'Mia Chen')!;
      expect(mia.checkins).toHaveLength(0);
    });

    it('returns null for a missing or deleted household', async () => {
      expect(await getHouseholdForKiosk(env.DB, 999999, date)).toBeNull();
    });
  });

  describe('checkOutChild / staffCheckOut', () => {
    it('wrong code returns false and leaves the row open', async () => {
      const { code } = await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId], date });
      const checkin = await env.DB.prepare(`SELECT id FROM checkins WHERE household_member_id = ?`).bind(ethanId).first<{ id: number }>();
      const wrongCode = code === 'QQQQ' ? 'PPPP' : 'QQQQ';

      const ok = await checkOutChild(env.DB, { checkinId: checkin!.id, code: wrongCode });
      expect(ok).toBe(false);

      const row = await env.DB.prepare(`SELECT checked_out_at FROM checkins WHERE id = ?`).bind(checkin!.id).first<{ checked_out_at: string | null }>();
      expect(row!.checked_out_at).toBeNull();
    });

    it('right code (case-insensitive) sets checked_out_at once, and a second attempt fails', async () => {
      const { code } = await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId], date });
      const checkin = await env.DB.prepare(`SELECT id FROM checkins WHERE household_member_id = ?`).bind(ethanId).first<{ id: number }>();

      const ok = await checkOutChild(env.DB, { checkinId: checkin!.id, code: code.toLowerCase() });
      expect(ok).toBe(true);

      const row = await env.DB.prepare(`SELECT checked_out_at FROM checkins WHERE id = ?`).bind(checkin!.id).first<{ checked_out_at: string | null }>();
      expect(row!.checked_out_at).not.toBeNull();

      const again = await checkOutChild(env.DB, { checkinId: checkin!.id, code });
      expect(again).toBe(false);
    });

    it('staffCheckOut needs no code', async () => {
      await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId], date });
      const checkin = await env.DB.prepare(`SELECT id FROM checkins WHERE household_member_id = ?`).bind(ethanId).first<{ id: number }>();

      await staffCheckOut(env.DB, checkin!.id);

      const row = await env.DB.prepare(`SELECT checked_out_at FROM checkins WHERE id = ?`).bind(checkin!.id).first<{ checked_out_at: string | null }>();
      expect(row!.checked_out_at).not.toBeNull();
    });
  });

  describe('todayRoster', () => {
    it('returns joined child/household/event rows for the date only', async () => {
      await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId, miaId], date });
      await checkInChildren(env.DB, { eventId, householdId: linId, memberIds: [noahId], date: '2026-07-06' });

      const roster = await todayRoster(env.DB, date);
      expect(roster).toHaveLength(2);
      expect(roster.map((r) => r.childName).slice().sort()).toEqual(['Ethan Chen', 'Mia Chen']);
      expect(roster.every((r) => r.householdName === 'Chen Family')).toBe(true);
      expect(roster.every((r) => r.eventName === 'Nursery')).toBe(true);
      expect(roster.every((r) => r.checkedOutAt === null)).toBe(true);
    });
  });

  describe('weeklyStats', () => {
    it('zero-fills 12 weeks, buckets Sat/Sun boundary correctly', async () => {
      // 2026-06-27 is a Saturday (week starting 2026-06-21); 2026-06-28 is the
      // very next day, a Sunday (week starting on itself) — different weeks.
      await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [ethanId], date: '2026-06-27' });
      await checkInChildren(env.DB, { eventId, householdId: linId, memberIds: [noahId], date: '2026-06-28' });
      await checkInChildren(env.DB, { eventId, householdId: chenId, memberIds: [miaId], date });

      const stats = await weeklyStats(env.DB, { today: date });

      expect(stats.weeks).toHaveLength(12);
      expect(stats.weeks.every((w) => new Date(`${w.weekStart}T00:00:00Z`).getUTCDay() === 0)).toBe(true);
      expect(stats.weeks[stats.weeks.length - 1].weekStart).toBe(date);

      const satWeek = stats.weeks.find((w) => w.weekStart === '2026-06-21')!;
      const sunWeek = stats.weeks.find((w) => w.weekStart === '2026-06-28')!;
      expect(satWeek.total).toBe(1);
      expect(sunWeek.total).toBe(1);

      expect(stats.thisWeek).toBe(1);
      expect(stats.distinctChildrenThisMonth).toBe(1); // only the 'date' (July) check-in
      expect(stats.activeEvents).toBe(1);

      const eventStats = stats.byEvent.find((e) => e.eventId === eventId)!;
      expect(eventStats.name).toBe('Nursery');
      expect(eventStats.counts).toHaveLength(4);
      expect(eventStats.counts[3]).toBe(1); // last (this week) bucket
    });
  });
});

describe('generateSecurityCode', () => {
  it('is 4 chars from the unambiguous alphabet (no 0/O/1/I/L) via the default CSPRNG path', () => {
    // No-arg calls exercise the crypto.getRandomValues path; sample repeatedly
    // so every generated word must map into the alphabet.
    for (let i = 0; i < 50; i++) {
      const code = generateSecurityCode();
      expect(code).toHaveLength(4);
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
    }
  });

  it('is deterministic given a rand function', () => {
    expect(generateSecurityCode(() => 0)).toBe('AAAA');
  });
});
