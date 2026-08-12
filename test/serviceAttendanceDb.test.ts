import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppDb, AppDbResult, AppStatement } from '../src/lib/appDb';
import {
  ServiceAttendanceConflictError,
  ServiceAttendanceInvalidError,
  ServiceAttendancePersistenceError,
  ServiceAttendanceReportLimitError,
  getServiceCheckinLinkSnapshot,
  listCurrentServiceCheckinLinks,
  listServiceAttendanceReport,
  replaceServiceCheckinLinksToday,
  upsertServiceAttendance,
} from '../src/lib/serviceAttendanceDb';

describe('current service check-in link listing', () => {
  it('reads every current link in one bounded query without initializing CAS state', async () => {
    const sql: string[] = [];
    let batchCalls = 0;
    const statement: AppStatement = {
      bind: () => statement,
      first: async () => { throw new Error('unexpected first'); },
      run: async () => { throw new Error('unexpected write'); },
      all: async <T>() => ({
        results: [
          { service_type_id: 4, checkin_event_id: 7 },
          { service_type_id: 4, checkin_event_id: 9 },
          { service_type_id: 8, checkin_event_id: 3 },
        ] as T[],
        meta: { changes: 0 },
      }),
    };
    const readOnlyDb: AppDb = {
      prepare: (query) => { sql.push(query); return statement; },
      batch: async () => { batchCalls += 1; return []; },
    };

    await expect(listCurrentServiceCheckinLinks(readOnlyDb)).resolves.toEqual([
      { serviceTypeId: 4, eventId: 7 },
      { serviceTypeId: 4, eventId: 9 },
      { serviceTypeId: 8, eventId: 3 },
    ]);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/ends_on IS NULL/i);
    expect(sql[0]).toMatch(/ORDER BY service_type_id, checkin_event_id/i);
    expect(sql[0]).toMatch(/LIMIT 5001/i);
    expect(sql[0]).not.toMatch(/INSERT|UPDATE|DELETE/i);
    expect(batchCalls).toBe(0);
  });

  it('fails closed on malformed, duplicate, or over-limit current-link rows', async () => {
    const cases: unknown[][] = [
      [{ service_type_id: 1, checkin_event_id: 2 }, { service_type_id: 1, checkin_event_id: 2 }],
      [{ service_type_id: 'private@example.com', checkin_event_id: 2 }],
      new Array(5001).fill({ service_type_id: 1, checkin_event_id: 2 }),
    ];
    for (const results of cases) {
      const statement: AppStatement = {
        bind: () => statement,
        first: async () => null,
        run: async () => ({ results: [], meta: { changes: 0 } }),
        all: async <T>() => ({ results: results as T[], meta: { changes: 0 } }),
      };
      const db: AppDb = { prepare: () => statement, batch: async () => [] };
      await expect(listCurrentServiceCheckinLinks(db)).rejects.toMatchObject({ code: 'attendance_failed' });
    }
  });
});

async function seedBase(serviceId: number, eventIds: number[], personIds = [9101, 9102]): Promise<void> {
  await env.DB.batch([
    ...personIds.map((id) => env.DB.prepare(
      'INSERT OR IGNORE INTO people (id, display_name, email) VALUES (?, ?, ?)',
    ).bind(id, `Attendance Actor ${id}`, `attendance-actor-${id}@example.com`)),
    env.DB.prepare('INSERT OR IGNORE INTO service_types (id, sort) VALUES (?, ?)').bind(serviceId, serviceId % 100),
    env.DB.prepare("INSERT OR IGNORE INTO service_type_i18n (service_type_id, locale, name) VALUES (?, 'en', ?)")
      .bind(serviceId, `Service ${serviceId}`),
    ...eventIds.map((id) => env.DB.prepare(
      "INSERT OR IGNORE INTO checkin_events (id, name, active) VALUES (?, ?, 1)",
    ).bind(id, `Room ${id}`)),
  ]);
}

async function directLink(
  serviceId: number,
  eventId: number,
  startsOn: string,
  endsOn: string | null = null,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO service_type_checkin_events
      (service_type_id, checkin_event_id, starts_on, ends_on,
       created_by_person_id, closed_by_person_id, closed_at)
    VALUES (?, ?, ?, ?, 9101,
      CASE WHEN ? IS NULL THEN NULL ELSE 9101 END,
      CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)
  `).bind(serviceId, eventId, startsOn, endsOn, endsOn, endsOn).run();
}

describe('adult service attendance upsert', () => {
  it('preserves the first writer and creation time while corrections update only count and updater', async () => {
    await seedBase(9201, []);
    const first = await upsertServiceAttendance(env.DB, {
      serviceTypeId: 9201, attendanceDate: '2026-08-09', adultCount: 42,
    }, 9101);
    await env.DB.prepare(`
      UPDATE service_attendance SET created_at = '2026-08-09 12:00:00', updated_at = '2026-08-09 12:00:00'
      WHERE service_type_id = 9201
    `).run();
    const corrected = await upsertServiceAttendance(env.DB, {
      serviceTypeId: 9201, attendanceDate: '2026-08-09', adultCount: 45,
    }, 9102);

    expect(first).toMatchObject({ adultCount: 42, recordedByPersonId: 9101, updatedByPersonId: 9101 });
    expect(corrected).toMatchObject({
      adultCount: 45,
      recordedByPersonId: 9101,
      updatedByPersonId: 9102,
      createdAt: '2026-08-09 12:00:00',
    });
  });

  it('fails closed on malformed or stateful database result rows', async () => {
    let adultReads = 0;
    const malicious = {
      service_type_id: 9201,
      attendance_date: '2026-08-09',
      get adult_count() { adultReads += 1; return adultReads === 1 ? 42 : Number.NaN; },
      recorded_by_person_id: 9101,
      updated_by_person_id: 9101,
      created_at: '2026-08-09 12:00:00',
      updated_at: '2026-08-09 12:00:00',
    };
    const statement: AppStatement = {
      bind: () => statement,
      first: async <T>() => malicious as T,
      all: async () => ({ results: [], meta: { changes: 0 } }),
      run: async () => ({ results: [], meta: { changes: 0 } }),
    };
    const malformedDb: AppDb = { prepare: () => statement, batch: async () => [] };

    await expect(upsertServiceAttendance(malformedDb, {
      serviceTypeId: 9201, attendanceDate: '2026-08-09', adultCount: 42,
    }, 9101)).rejects.toBeInstanceOf(ServiceAttendancePersistenceError);
    expect(adultReads).toBe(0);
  });

  it('keeps one valid row under concurrent first writes and never accepts actor/count from data fields', async () => {
    await seedBase(9202, []);
    const results = await Promise.all([
      upsertServiceAttendance(env.DB, { serviceTypeId: 9202, attendanceDate: '2026-08-10', adultCount: 7 }, 9101),
      upsertServiceAttendance(env.DB, { serviceTypeId: 9202, attendanceDate: '2026-08-10', adultCount: 8 }, 9102),
    ]);
    const row = await env.DB.prepare('SELECT * FROM service_attendance WHERE service_type_id = 9202').first<{
      adult_count: number; recorded_by_person_id: number; updated_by_person_id: number;
    }>();
    expect(results).toHaveLength(2);
    expect([7, 8]).toContain(row?.adult_count);
    expect([9101, 9102]).toContain(row?.recorded_by_person_id);
    expect([9101, 9102]).toContain(row?.updated_by_person_id);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM service_attendance WHERE service_type_id=9202').first<number>('n')).toBe(1);

    for (const call of [
      () => upsertServiceAttendance(env.DB, { serviceTypeId: 9202, attendanceDate: 'bad', adultCount: 1 }, 9101),
      () => upsertServiceAttendance(env.DB, { serviceTypeId: 9202, attendanceDate: '2026-08-10', adultCount: 100001 }, 9101),
      () => upsertServiceAttendance(env.DB, { serviceTypeId: 9202, attendanceDate: '2026-08-10', adultCount: 1 }, 0),
    ]) await expect(call()).rejects.toBeInstanceOf(ServiceAttendanceInvalidError);
  });
});

describe('service to check-in event link replacement', () => {
  it('replaces the whole current set, preserves unchanged pairs, closes removals, and unlinks to empty', async () => {
    await seedBase(9210, [9310, 9311, 9312]);
    await directLink(9210, 9310, '2026-08-01');
    await directLink(9210, 9311, '2026-08-01');

    await expect(replaceServiceCheckinLinksToday(env.DB, 9210, [9311, 9312, 9312], '2026-08-12', 9102))
      .resolves.toMatchObject({ eventIds: [9311, 9312], changed: true });
    expect((await getServiceCheckinLinkSnapshot(env.DB, 9210)).eventIds).toEqual([9311, 9312]);
    expect(await env.DB.prepare(`
      SELECT starts_on, ends_on, closed_by_person_id FROM service_type_checkin_events
      WHERE service_type_id=9210 AND checkin_event_id=9310
    `).first()).toEqual({ starts_on: '2026-08-01', ends_on: '2026-08-12', closed_by_person_id: 9102 });
    expect(await env.DB.prepare(`
      SELECT starts_on FROM service_type_checkin_events
      WHERE service_type_id=9210 AND checkin_event_id=9311 AND ends_on IS NULL
    `).first()).toEqual({ starts_on: '2026-08-01' });

    const unchanged = await replaceServiceCheckinLinksToday(env.DB, 9210, [9312, 9311], '2026-08-12', 9101);
    expect(unchanged).toMatchObject({ changed: false, eventIds: [9311, 9312] });
    await replaceServiceCheckinLinksToday(env.DB, 9210, [], '2026-08-12', 9101);
    expect((await getServiceCheckinLinkSnapshot(env.DB, 9210)).eventIds).toEqual([]);
    expect(await env.DB.prepare(`
      SELECT starts_on, ends_on FROM service_type_checkin_events
      WHERE service_type_id=9210 AND checkin_event_id=9312
    `).first()).toEqual({ starts_on: '2026-08-12', ends_on: '2026-08-12' });
  });

  it('rejects malformed link snapshots with bounded, single-pass row decoding', async () => {
    let lengthReads = 0;
    const eventRows = new Proxy([{ checkin_event_id: 9311 }], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : 101;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const results = [
      { results: [{ revision: '0' }], meta: { changes: 0 } },
      { results: eventRows, meta: { changes: 0 } },
    ];
    const statement: AppStatement = {
      bind: () => statement,
      first: async () => null,
      all: async () => ({ results: [], meta: { changes: 0 } }),
      run: async () => ({ results: [], meta: { changes: 0 } }),
    };
    const malformedDb: AppDb = {
      prepare: () => statement,
      batch: async <T>() => results as AppDbResult<T>[],
    };

    await expect(getServiceCheckinLinkSnapshot(malformedDb, 9210))
      .resolves.toEqual({ revision: 0, eventIds: [9311] });
    expect(lengthReads).toBe(1);
  });

  it('snapshots caller event ids with one bounded length read', async () => {
    await seedBase(9212, [9321]);
    let lengthReads = 0;
    const eventIds = new Proxy([9321], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : 101;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(replaceServiceCheckinLinksToday(env.DB, 9212, eventIds, '2026-08-12', 9101))
      .resolves.toMatchObject({ eventIds: [9321], changed: true });
    expect(lengthReads).toBe(1);
  });

  it('maps invalid input, nonexistent FK, and same-day re-add collisions to PII-free safe errors', async () => {
    await seedBase(9211, [9320]);
    await replaceServiceCheckinLinksToday(env.DB, 9211, [9320], '2026-08-12', 9101);
    await replaceServiceCheckinLinksToday(env.DB, 9211, [], '2026-08-12', 9101);

    await expect(replaceServiceCheckinLinksToday(env.DB, 9211, [9320], '2026-08-12', 9101))
      .rejects.toBeInstanceOf(ServiceAttendanceConflictError);
    for (const args of [
      [0, [9320], '2026-08-12', 9101],
      [9211, [0], '2026-08-12', 9101],
      [9211, [999999], '2026-08-13', 9101],
      [9211, [9320], 'private@example.com', 9101],
    ] as const) {
      const [serviceTypeId, eventIds, today, actorPersonId] = args;
      const error = await replaceServiceCheckinLinksToday(
        env.DB, serviceTypeId, eventIds, today, actorPersonId,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(args[1][0] === 999999 ? ServiceAttendanceConflictError : ServiceAttendanceInvalidError);
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/private|999999|9320/i);
    }
  });
});

class BatchBarrierDb implements AppDb {
  constructor(private readonly db: AppDb, private readonly barrier: () => Promise<void>) {}
  prepare(sql: string): AppStatement { return this.db.prepare(sql); }
  async snapshotBatch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    const result = this.db.snapshotBatch
      ? await this.db.snapshotBatch<T>(statements)
      : await this.db.batch<T>(statements);
    await this.barrier();
    return result;
  }
  batch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    return this.db.batch<T>(statements);
  }
}

describe('service-level replacement CAS', () => {
  it('allows exactly one divergent replacement from the same old revision and never merges targets', async () => {
    await seedBase(9220, [9330, 9331, 9332]);
    await directLink(9220, 9330, '2026-08-01');
    let waiting = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const barrier = async () => {
      waiting += 1;
      if (waiting === 2) release?.();
      await gate;
    };
    const dbA = new BatchBarrierDb(env.DB, barrier);
    const dbB = new BatchBarrierDb(env.DB, barrier);

    const settled = await Promise.allSettled([
      replaceServiceCheckinLinksToday(dbA, 9220, [9331], '2026-08-12', 9101),
      replaceServiceCheckinLinksToday(dbB, 9220, [9332], '2026-08-12', 9102),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.any(ServiceAttendanceConflictError) }),
    ]);
    expect([[9331], [9332]]).toContainEqual((await getServiceCheckinLinkSnapshot(env.DB, 9220)).eventIds);
  });

  it('makes a stale no-op replacement and a concurrent change contend for one revision', async () => {
    await seedBase(9221, [9333, 9334]);
    await directLink(9221, 9333, '2026-08-01');
    await getServiceCheckinLinkSnapshot(env.DB, 9221); // initialize CAS state before the barrier
    let waiting = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const barrier = async () => {
      waiting += 1;
      if (waiting === 2) release?.();
      await gate;
    };

    const settled = await Promise.allSettled([
      replaceServiceCheckinLinksToday(new BatchBarrierDb(env.DB, barrier), 9221, [9333], '2026-08-12', 9101),
      replaceServiceCheckinLinksToday(new BatchBarrierDb(env.DB, barrier), 9221, [9334], '2026-08-12', 9102),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.any(ServiceAttendanceConflictError) }),
    ]);
    expect([[9333], [9334]]).toContainEqual((await getServiceCheckinLinkSnapshot(env.DB, 9221)).eventIds);
  });

  it('fails closed on malformed CAS result wrappers, metadata, or returned revisions', async () => {
    const snapshotResults: AppDbResult<unknown>[] = [
      { results: [{ revision: 0 }], meta: { changes: 0 } },
      { results: [], meta: { changes: 0 } },
    ];
    for (const casResult of [
      { results: [{ revision: 1 }], meta: { changes: '1' } },
      { results: [{ revision: Number.NaN }], meta: { changes: 1 } },
      { results: [{ revision: 2 }], meta: { changes: 1 } },
      { results: [{ revision: 1 }], meta: {} },
    ] as unknown as AppDbResult<unknown>[]) {
      let batches = 0;
      const statement: AppStatement = {
        bind: () => statement,
        first: async () => null,
        all: async () => ({ results: [], meta: { changes: 0 } }),
        run: async () => ({ results: [], meta: { changes: 0 } }),
      };
      const malformedDb: AppDb = {
        prepare: () => statement,
        batch: async <T>() => {
          batches += 1;
          return (batches === 1 ? snapshotResults : [casResult]) as AppDbResult<T>[];
        },
      };

      await expect(replaceServiceCheckinLinksToday(
        malformedDb, 9220, [], '2026-08-12', 9101,
      )).rejects.toBeInstanceOf(ServiceAttendancePersistenceError);
    }
  });
});

async function seedChild(
  seed: number,
  eventId: number,
  checkinDate: string,
  memberId: number,
  checkedOut = false,
): Promise<void> {
  const householdId = 9400 + seed;
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO households (id, name) VALUES (?, ?)').bind(householdId, `Example Household ${seed}`),
    env.DB.prepare(`
      INSERT OR IGNORE INTO household_members (id, household_id, display_name, role)
      VALUES (?, ?, ?, 'child')
    `).bind(memberId, householdId, `Example Child ${seed}`),
    env.DB.prepare(`
      INSERT OR IGNORE INTO checkins
        (id, event_id, household_id, household_member_id, child_name, security_code,
         checkin_date, checked_out_at)
      VALUES (?, ?, ?, ?, ?, 'SAFE01', ?, ?)
    `).bind(9500 + seed, eventId, householdId, memberId, `Example Child ${seed}`, checkinDate, checkedOut ? '2026-08-12 12:00:00' : null),
  ]);
}

describe('attendance reports and historical child counts', () => {
  it('uses adult rows as the driver and returns null without config, zero without checkins', async () => {
    await seedBase(9230, [9340]);
    await upsertServiceAttendance(env.DB, { serviceTypeId: 9230, attendanceDate: '2026-08-10', adultCount: 10 }, 9101);
    await upsertServiceAttendance(env.DB, { serviceTypeId: 9230, attendanceDate: '2026-08-11', adultCount: 11 }, 9101);
    await directLink(9230, 9340, '2026-08-10', '2026-08-10');
    await directLink(9230, 9340, '2026-08-11');

    expect((await listServiceAttendanceReport(env.DB, 'en', { from: '2026-08-10', to: '2026-08-11' }))
      .filter((row) => row.serviceTypeId === 9230))
      .toMatchObject([
        { attendanceDate: '2026-08-11', adultCount: 11, childCount: 0, combinedCount: 11 },
        { attendanceDate: '2026-08-10', adultCount: 10, childCount: null, combinedCount: null },
      ]);
    await seedChild(30, 9340, '2026-08-12', 9630);
    expect(await listServiceAttendanceReport(env.DB, 'en', { from: '2026-08-12', to: '2026-08-12' })).toEqual([]);
  });

  it('counts distinct children across rooms, including checked-out and inactive-event history', async () => {
    await seedBase(9231, [9341, 9342]);
    await directLink(9231, 9341, '2026-08-01');
    await directLink(9231, 9342, '2026-08-01');
    await env.DB.prepare('UPDATE checkin_events SET active=0 WHERE id=9342').run();
    await seedChild(31, 9341, '2026-08-12', 9631, true);
    const householdId = 9431;
    await env.DB.prepare(`
      INSERT INTO checkins
        (id,event_id,household_id,household_member_id,child_name,security_code,checkin_date)
      VALUES (9532,9342,?,?,?,'SAFE02','2026-08-12')
    `).bind(householdId, 9631, 'Example Child 31').run();
    await seedChild(33, 9342, '2026-08-12', 9633);
    await upsertServiceAttendance(env.DB, { serviceTypeId: 9231, attendanceDate: '2026-08-12', adultCount: 20 }, 9101);

    expect((await listServiceAttendanceReport(env.DB, 'en', { from: '2026-08-12', to: '2026-08-12' }))[0])
      .toMatchObject({ adultCount: 20, childCount: 2, combinedCount: 22 });
  });

  it('uses the link effective on each historical date and keeps deterministic service ordering', async () => {
    await seedBase(9232, [9343, 9344]);
    await seedBase(9233, []);
    await directLink(9232, 9343, '2026-08-01', '2026-08-10');
    await directLink(9232, 9344, '2026-08-10');
    await seedChild(34, 9343, '2026-08-09', 9634);
    await seedChild(35, 9343, '2026-08-10', 9635);
    await seedChild(36, 9344, '2026-08-10', 9636);
    for (const [serviceTypeId, attendanceDate, adultCount] of [
      [9232, '2026-08-09', 30], [9232, '2026-08-10', 31], [9233, '2026-08-10', 32],
    ] as const) await upsertServiceAttendance(env.DB, { serviceTypeId, attendanceDate, adultCount }, 9101);

    const rows = (await listServiceAttendanceReport(env.DB, 'en', { from: '2026-08-09', to: '2026-08-10' }))
      .filter((row) => row.serviceTypeId === 9232 || row.serviceTypeId === 9233);
    expect(rows.map((row) => [row.attendanceDate, row.serviceTypeId, row.childCount])).toEqual([
      ['2026-08-10', 9232, 1],
      ['2026-08-10', 9233, null],
      ['2026-08-09', 9232, 1],
    ]);
  });

  it('rejects invalid windows and fails at limit+1 rather than truncating', async () => {
    await seedBase(9240, []);
    await expect(listServiceAttendanceReport(env.DB, 'en', { from: '2025-01-01', to: '2026-08-12' }))
      .rejects.toBeInstanceOf(ServiceAttendanceInvalidError);
    let sqlText = '';
    const rows = Array.from({ length: 5001 }, () => ({
      service_type_id: 9240,
      service_name: 'Example Service',
      service_sort: 1,
      attendance_date: '2026-08-12',
      adult_count: 1,
      child_count: null,
    }));
    const statement: AppStatement = {
      bind: () => statement,
      first: async () => null,
      all: async <T>() => ({ results: rows as T[], meta: { changes: 0 } }),
      run: async () => ({ results: [], meta: { changes: 0 } }),
    };
    const limitDb: AppDb = {
      prepare: (sql) => { sqlText = sql; return statement; },
      batch: async () => [],
    };
    await expect(listServiceAttendanceReport(limitDb, 'en', { from: '2026-08-12', to: '2026-08-12' }))
      .rejects.toBeInstanceOf(ServiceAttendanceReportLimitError);
    expect(sqlText).toMatch(/LIMIT\s+5001\b/);
  });

  it('fails closed on malformed report values and snapshots accessors once', async () => {
    let nameReads = 0;
    const reportRow = {
      service_type_id: '9240',
      get service_name() { nameReads += 1; return nameReads === 1 ? 'Public Service' : 'private@example.com'; },
      service_sort: '1',
      attendance_date: '2026-08-12',
      adult_count: '1',
      child_count: 'NaN',
    };
    const statement: AppStatement = {
      bind: () => statement,
      first: async () => null,
      all: async <T>() => ({ results: [reportRow] as T[], meta: { changes: 0 } }),
      run: async () => ({ results: [], meta: { changes: 0 } }),
    };
    const malformedDb: AppDb = { prepare: () => statement, batch: async () => [] };

    await expect(listServiceAttendanceReport(
      malformedDb, 'en', { from: '2026-08-12', to: '2026-08-12' },
    )).rejects.toBeInstanceOf(ServiceAttendancePersistenceError);
    expect(nameReads).toBe(0);

    const exactDerivedDb: AppDb = {
      prepare: () => env.DB.prepare(`
        SELECT 9240 AS service_type_id, 'Public Service' AS service_name,
          1 AS service_sort, '2026-08-12' AS attendance_date,
          1 AS adult_count, 100001 AS child_count
        WHERE ?1 IS NOT NULL AND ?2 IS NOT NULL AND ?3 IS NOT NULL
      `),
      batch: async () => [],
    };
    await expect(listServiceAttendanceReport(
      exactDerivedDb,
      'en', { from: '2026-08-12', to: '2026-08-12' },
    )).resolves.toEqual([expect.objectContaining({
      adultCount: 1,
      childCount: 100001,
      combinedCount: 100002,
    })]);
  });
});
