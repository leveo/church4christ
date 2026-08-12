import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb, AppDbResult, AppStatement } from '../../src/lib/appDb';
import {
  ServiceAttendanceConflictError,
  getServiceCheckinLinkSnapshot,
  listServiceAttendanceReport,
  replaceServiceCheckinLinksToday,
  upsertServiceAttendance,
} from '../../src/lib/serviceAttendanceDb';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('service attendance schema and DB (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(`
      TRUNCATE service_checkin_link_state, service_type_checkin_events,
        service_attendance, checkins, checkin_events, household_members,
        households, service_type_i18n, service_types, people
      RESTART IDENTITY CASCADE
    `);
    await sql.unsafe(`
      INSERT INTO people (id, display_name, email) VALUES
        (1, 'Attendance Recorder', 'attendance-recorder@example.com'),
        (2, 'Attendance Corrector', 'attendance-corrector@example.com');
      INSERT INTO service_types (id, sort) VALUES (10, 1), (11, 2);
      INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES
        (10, 'en', 'First Service'), (11, 'en', 'Second Service');
      INSERT INTO checkin_events (id, name, active) VALUES
        (20, 'Blue Room', 1), (21, 'Green Room', 1), (22, 'Gold Room', 1);
    `);
  });

  afterAll(async () => { await sql?.end(); });

  it('ports exact columns, keys, FKs, identity, and report/current-link indexes', async () => {
    const columns = await sql.unsafe<{
      table_name: string; column_name: string; is_nullable: string; is_identity: string;
    }[]>(`
      SELECT table_name, column_name, is_nullable, is_identity
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN (
        'service_attendance','service_type_checkin_events','service_checkin_link_state'
      )
      ORDER BY table_name, ordinal_position
    `);
    expect(columns.filter((column) => column.table_name === 'service_attendance').map((column) => column.column_name))
      .toEqual(['service_type_id', 'attendance_date', 'adult_count', 'recorded_by_person_id', 'updated_by_person_id', 'created_at', 'updated_at']);
    expect(columns.find((column) => column.table_name === 'service_type_checkin_events' && column.column_name === 'id'))
      .toMatchObject({ is_identity: 'YES' });
    expect(columns.find((column) => column.table_name === 'service_type_checkin_events' && column.column_name === 'ends_on'))
      .toMatchObject({ is_nullable: 'YES' });

    const indexes = await sql.unsafe<{ indexname: string }[]>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname IN (
        'idx_service_attendance_date','idx_service_checkin_links_dates',
        'idx_service_checkin_links_one_open','idx_service_checkin_links_start'
      ) ORDER BY indexname
    `);
    expect(indexes.map((index) => index.indexname)).toEqual([
      'idx_service_attendance_date',
      'idx_service_checkin_links_dates',
      'idx_service_checkin_links_one_open',
      'idx_service_checkin_links_start',
    ]);
    const foreignKeys = await sql.unsafe<{ table_name: string; foreign_table: string }[]>(`
      SELECT child.relname AS table_name, parent.relname AS foreign_table
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_class parent ON parent.oid = constraint_row.confrelid
      WHERE constraint_row.contype='f' AND child.relname IN (
        'service_attendance','service_type_checkin_events','service_checkin_link_state'
      ) ORDER BY table_name, foreign_table
    `);
    expect(foreignKeys).toEqual(expect.arrayContaining([
      { table_name: 'service_attendance', foreign_table: 'people' },
      { table_name: 'service_attendance', foreign_table: 'service_types' },
      { table_name: 'service_type_checkin_events', foreign_table: 'checkin_events' },
      { table_name: 'service_type_checkin_events', foreign_table: 'people' },
      { table_name: 'service_type_checkin_events', foreign_table: 'service_types' },
      { table_name: 'service_checkin_link_state', foreign_table: 'service_types' },
    ]));

    for (const statement of [
      `INSERT INTO service_attendance
        (service_type_id,attendance_date,adult_count,recorded_by_person_id,updated_by_person_id)
       VALUES (999,'2026-08-12',1,1,1)`,
      `INSERT INTO service_attendance
        (service_type_id,attendance_date,adult_count,recorded_by_person_id,updated_by_person_id)
       VALUES (10,'2026-08-12',1,999,1)`,
      `INSERT INTO service_attendance
        (service_type_id,attendance_date,adult_count,recorded_by_person_id,updated_by_person_id)
       VALUES (10,'2026-08-12',1,1,999)`,
      `INSERT INTO service_type_checkin_events
        (service_type_id,checkin_event_id,starts_on,created_by_person_id)
       VALUES (999,20,'2026-08-12',1)`,
      `INSERT INTO service_type_checkin_events
        (service_type_id,checkin_event_id,starts_on,created_by_person_id)
       VALUES (10,999,'2026-08-12',1)`,
      `INSERT INTO service_type_checkin_events
        (service_type_id,checkin_event_id,starts_on,created_by_person_id)
       VALUES (10,20,'2026-08-12',999)`,
      `INSERT INTO service_type_checkin_events
        (service_type_id,checkin_event_id,starts_on,ends_on,created_by_person_id,closed_by_person_id,closed_at)
       VALUES (10,20,'2026-08-12','2026-08-12',1,999,datetime('now'))`,
      `INSERT INTO service_checkin_link_state (service_type_id) VALUES (999)`,
    ]) await expect(sql.unsafe(statement)).rejects.toMatchObject({ code: '23503' });
  });

  it('enforces aggregate count, strict dates, and actor/service FKs while preserving correction provenance', async () => {
    for (const count of [0, 100000]) {
      await sql.unsafe(`
        INSERT INTO service_attendance
          (service_type_id, attendance_date, adult_count, recorded_by_person_id, updated_by_person_id)
        VALUES (10, $1, $2, 1, 1)
      `, [count === 0 ? '2028-02-29' : '2028-03-01', count]);
    }
    for (const [date, count, actor] of [
      ['2026-02-30', 1, 1], ['abcd-02-29', 1, 1], ['0000-01-01', 1, 1], ['2026-08-12', -1, 1],
      ['2026-08-12', 100001, 1], ['2026-08-12', 1, 999],
    ] as const) await expect(sql.unsafe(`
      INSERT INTO service_attendance
        (service_type_id, attendance_date, adult_count, recorded_by_person_id, updated_by_person_id)
      VALUES (11, $1, $2, $3, $3)
    `, [date, count, actor])).rejects.toBeTruthy();

    const created = await upsertServiceAttendance(db, {
      serviceTypeId: 11, attendanceDate: '2026-08-12', adultCount: 30,
    }, 1);
    const corrected = await upsertServiceAttendance(db, {
      serviceTypeId: 11, attendanceDate: '2026-08-12', adultCount: 31,
    }, 2);
    expect(corrected).toMatchObject({
      adultCount: 31, recordedByPersonId: 1, updatedByPersonId: 2, createdAt: created.createdAt,
    });

    const clientA = pgClient();
    const clientB = pgClient();
    try {
      const raced = await Promise.all([
        upsertServiceAttendance(new PgAdapter(clientA), {
          serviceTypeId: 10, attendanceDate: '2026-08-13', adultCount: 20,
        }, 1),
        upsertServiceAttendance(new PgAdapter(clientB), {
          serviceTypeId: 10, attendanceDate: '2026-08-13', adultCount: 21,
        }, 2),
      ]);
      expect(raced).toHaveLength(2);
      const [stored] = await sql.unsafe<{
        adult_count: number; recorded_by_person_id: number; updated_by_person_id: number;
      }[]>(`SELECT adult_count,recorded_by_person_id,updated_by_person_id
        FROM service_attendance WHERE service_type_id=10 AND attendance_date='2026-08-13'`);
      expect([20, 21]).toContain(Number(stored.adult_count));
      expect([1, 2]).toContain(Number(stored.recorded_by_person_id));
      expect([1, 2]).toContain(Number(stored.updated_by_person_id));
    } finally {
      await Promise.all([clientA.end(), clientB.end()]);
    }
  });

  it('enforces half-open effective ranges, cancellation, overlap, one-open, and append/close-only history', async () => {
    await sql.unsafe(`
      INSERT INTO service_type_checkin_events
        (service_type_id,checkin_event_id,starts_on,ends_on,created_by_person_id,closed_by_person_id,closed_at)
      VALUES
        (10,20,'2026-08-01','2026-08-10',1,1,datetime('now')),
        (10,20,'2026-08-09','2026-08-09',1,1,datetime('now')),
        (10,20,'2026-08-10',NULL,1,NULL,NULL)
    `);
    expect(Number((await sql.unsafe(`
      SELECT count(*)::int AS n FROM service_type_checkin_events
      WHERE starts_on < COALESCE(ends_on, '9999-12-31')
    `))[0].n)).toBe(2);
    for (const statement of [
      `INSERT INTO service_type_checkin_events (service_type_id,checkin_event_id,starts_on,ends_on,created_by_person_id,closed_by_person_id,closed_at)
       VALUES (10,20,'2026-08-05','2026-08-06',1,1,datetime('now'))`,
      `INSERT INTO service_type_checkin_events (service_type_id,checkin_event_id,starts_on,created_by_person_id)
       VALUES (10,20,'2026-08-12',1)`,
      `INSERT INTO service_type_checkin_events (service_type_id,checkin_event_id,starts_on,created_by_person_id)
       VALUES (10,21,'abcd-02-29',1)`,
      `INSERT INTO service_type_checkin_events (service_type_id,checkin_event_id,starts_on,ends_on,created_by_person_id)
       VALUES (10,21,'2026-08-12','2026-08-11',1)`,
    ]) await expect(sql.unsafe(statement)).rejects.toBeTruthy();

    const [open] = await sql.unsafe<{ id: number }[]>(`
      INSERT INTO service_type_checkin_events (service_type_id,checkin_event_id,starts_on,created_by_person_id)
      VALUES (10,21,'2026-08-12',1) RETURNING id
    `);
    await expect(sql.unsafe(`
      UPDATE service_type_checkin_events
      SET service_type_id=11,ends_on='2026-08-12',closed_by_person_id=2,closed_at=datetime('now')
      WHERE id=$1
    `, [open.id])).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe(`
      UPDATE service_type_checkin_events
      SET checkin_event_id=22,ends_on='2026-08-12',closed_by_person_id=2,closed_at=datetime('now')
      WHERE id=$1
    `, [open.id])).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe(`
      UPDATE service_type_checkin_events
      SET id=id+100, ends_on='2026-08-12',closed_by_person_id=2,closed_at=datetime('now')
      WHERE id=$1
    `, [open.id])).rejects.toMatchObject({ code: '23514' });
    await sql.unsafe(`
      UPDATE service_type_checkin_events
      SET ends_on='2026-08-12',closed_by_person_id=2,closed_at=datetime('now') WHERE id=$1
    `, [open.id]);
    await expect(sql.unsafe('DELETE FROM service_type_checkin_events WHERE id=$1', [open.id]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe(`
      UPDATE service_type_checkin_events
      SET ends_on=NULL,closed_by_person_id=NULL,closed_at=NULL WHERE id=$1
    `, [open.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('counts historical distinct children across inactive rooms and checked-out records', async () => {
    await sql.unsafe(`
      INSERT INTO service_type_checkin_events
        (service_type_id,checkin_event_id,starts_on,created_by_person_id)
      VALUES (10,20,'2026-08-01',1),(10,21,'2026-08-01',1);
      UPDATE checkin_events SET active=0 WHERE id=21;
      INSERT INTO households (id,name) VALUES (30,'Example Household A'),(31,'Example Household B');
      INSERT INTO household_members (id,household_id,display_name,role) VALUES
        (40,30,'Example Child A','child'),(41,31,'Example Child B','child');
      INSERT INTO checkins
        (event_id,household_id,household_member_id,child_name,security_code,checkin_date,checked_out_at)
      VALUES
        (20,30,40,'Example Child A','SAFE01','2026-08-12',datetime('now')),
        (21,30,40,'Example Child A','SAFE02','2026-08-12',NULL),
        (21,31,41,'Example Child B','SAFE03','2026-08-12',NULL);
    `);
    await upsertServiceAttendance(db, { serviceTypeId: 10, attendanceDate: '2026-08-12', adultCount: 50 }, 1);
    expect((await listServiceAttendanceReport(db, 'en', { from: '2026-08-12', to: '2026-08-12' }))[0])
      .toMatchObject({ childCount: 2, combinedCount: 52 });
  });

  class SnapshotBarrierDb implements AppDb {
    constructor(private readonly delegate: AppDb, private readonly barrier: () => Promise<void>) {}
    prepare(text: string): AppStatement { return this.delegate.prepare(text); }
    batch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
      return this.delegate.batch<T>(statements);
    }
    async snapshotBatch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
      const result = await this.delegate.snapshotBatch!<T>(statements);
      await this.barrier();
      return result;
    }
  }

  it('allows one divergent service-level replacement and never merges targets', async () => {
    await sql.unsafe(`
      INSERT INTO service_type_checkin_events
        (service_type_id,checkin_event_id,starts_on,created_by_person_id)
      VALUES (10,20,'2026-08-01',1)
    `);
    await getServiceCheckinLinkSnapshot(db, 10);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const barrier = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
    };
    const clientA = pgClient();
    const clientB = pgClient();
    try {
      const settled = await Promise.allSettled([
        replaceServiceCheckinLinksToday(
          new SnapshotBarrierDb(new PgAdapter(clientA), barrier), 10, [21], '2026-08-12', 1,
        ),
        replaceServiceCheckinLinksToday(
          new SnapshotBarrierDb(new PgAdapter(clientB), barrier), 10, [22], '2026-08-12', 2,
        ),
      ]);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((result) => result.status === 'rejected')).toEqual([
        expect.objectContaining({ reason: expect.any(ServiceAttendanceConflictError) }),
      ]);
      expect([[21], [22]]).toContainEqual((await getServiceCheckinLinkSnapshot(db, 10)).eventIds);
    } finally {
      await Promise.all([clientA.end(), clientB.end()]);
    }
  }, 20_000);
});
