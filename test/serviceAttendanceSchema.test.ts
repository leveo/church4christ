import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM service_attendance'),
    env.DB.prepare("INSERT OR IGNORE INTO people (id, display_name, email) VALUES (8101, 'Attendance Recorder', 'attendance-recorder@example.com')"),
    env.DB.prepare("INSERT OR IGNORE INTO people (id, display_name, email) VALUES (8102, 'Attendance Corrector', 'attendance-corrector@example.com')"),
    env.DB.prepare('INSERT OR IGNORE INTO service_types (id, sort) VALUES (8201, 1), (8203, 3), (8204, 4), (8205, 5)'),
    env.DB.prepare("INSERT OR IGNORE INTO checkin_events (id, name, active) VALUES (8301, 'Blue Room', 1), (8303, 'Green Room', 1), (8304, 'Gold Room', 1), (8305, 'Red Room', 1)"),
  ]);
}

beforeEach(reset);

describe('service attendance schema', () => {
  it('stores only aggregate adult attendance with immutable first-writer and correction provenance fields', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(service_attendance)')
      .all<{ name: string; type: string; notnull: number; pk: number }>();
    expect(columns.results.map((column) => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['service_type_id', 'INTEGER', 1, 1],
      ['attendance_date', 'TEXT', 1, 2],
      ['adult_count', 'INTEGER', 1, 0],
      ['recorded_by_person_id', 'INTEGER', 1, 0],
      ['updated_by_person_id', 'INTEGER', 1, 0],
      ['created_at', 'TEXT', 1, 0],
      ['updated_at', 'TEXT', 1, 0],
    ]);
    expect(columns.results.map((column) => column.name).join(' ')).not.toMatch(/child|member|roster|newcomer|visitor|adult_person/i);

    await expect(env.DB.prepare(`
      INSERT INTO service_attendance
        (service_type_id, attendance_date, adult_count, recorded_by_person_id, updated_by_person_id)
      VALUES (8201, '2026-08-10', -1, 8101, 8101)
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      INSERT INTO service_attendance
        (service_type_id, attendance_date, adult_count, recorded_by_person_id, updated_by_person_id)
      VALUES (8201, '2026-08-10', 100001, 8101, 8101)
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      INSERT INTO service_attendance
        (service_type_id, attendance_date, adult_count, recorded_by_person_id, updated_by_person_id)
      VALUES (8201, '2026-08-10', 1, 999999, 999999)
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      INSERT INTO service_attendance
        (service_type_id, attendance_date, adult_count, recorded_by_person_id, updated_by_person_id)
      VALUES (8201, '2026-02-30', 1, 8101, 8101)
    `).run()).rejects.toThrow();
    await env.DB.prepare(`
      INSERT INTO service_attendance
        (service_type_id, attendance_date, adult_count, recorded_by_person_id, updated_by_person_id)
      VALUES (8201, '2028-02-29', 1, 8101, 8101)
    `).run();
  });

  it('defines bounded historical link columns and lookup/open backstop indexes', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(service_type_checkin_events)')
      .all<{ name: string; type: string; notnull: number; pk: number }>();
    expect(columns.results.map((column) => column.name)).toEqual([
      'id',
      'service_type_id',
      'checkin_event_id',
      'starts_on',
      'ends_on',
      'created_by_person_id',
      'created_at',
      'closed_by_person_id',
      'closed_at',
    ]);
    const indexes = await env.DB.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'service_type_checkin_events'
      ORDER BY name
    `).all<{ name: string; sql: string | null }>();
    expect(indexes.results.map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_service_checkin_links_dates',
      'idx_service_checkin_links_one_open',
      'idx_service_checkin_links_start',
    ]));
    expect(indexes.results.find((index) => index.name === 'idx_service_checkin_links_one_open')?.sql)
      .toMatch(/UNIQUE[\s\S]*service_type_id\s*,\s*checkin_event_id[\s\S]*ends_on IS NULL/i);
  });

  it('allows effective and same-day zero-length cancellation rows but rejects malformed close audit', async () => {
    await env.DB.prepare(`
      INSERT INTO service_type_checkin_events
        (service_type_id, checkin_event_id, starts_on, ends_on,
         created_by_person_id, closed_by_person_id, closed_at)
      VALUES (8203, 8303, '2026-08-10', '2026-08-11', 8101, 8102, datetime('now'))
    `).run();
    await env.DB.prepare(`
      INSERT INTO service_type_checkin_events
        (service_type_id, checkin_event_id, starts_on, ends_on,
         created_by_person_id, closed_by_person_id, closed_at)
      VALUES (8203, 8303, '2026-08-12', '2026-08-12', 8101, 8101, datetime('now'))
    `).run();
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM service_type_checkin_events
      WHERE starts_on < COALESCE(ends_on, '9999-12-31')
    `).first<number>('n')).toBe(1);

    await expect(env.DB.prepare(`
      INSERT INTO service_type_checkin_events
        (service_type_id, checkin_event_id, starts_on, ends_on, created_by_person_id)
      VALUES (8203, 8303, '2026-08-13', '2026-08-12', 8101)
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      INSERT INTO service_type_checkin_events
        (service_type_id, checkin_event_id, starts_on, created_by_person_id)
      VALUES (8203, 8303, '2026-02-30', 8101)
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      INSERT INTO service_type_checkin_events
        (service_type_id, checkin_event_id, starts_on, ends_on, created_by_person_id)
      VALUES (8203, 8303, '2026-08-13', '2026-08-14', 8101)
    `).run()).rejects.toThrow();
  });

  it('rejects overlapping effective ranges while allowing adjacent ranges and only one open row', async () => {
    await env.DB.prepare(`
      INSERT INTO service_type_checkin_events
        (service_type_id, checkin_event_id, starts_on, ends_on,
         created_by_person_id, closed_by_person_id, closed_at)
      VALUES (8204, 8304, '2026-08-01', '2026-08-10', 8101, 8101, datetime('now'))
    `).run();
    await env.DB.prepare(`
      INSERT INTO service_type_checkin_events
        (service_type_id, checkin_event_id, starts_on, ends_on, created_by_person_id)
      VALUES (8204, 8304, '2026-08-10', NULL, 8101)
    `).run();

    await expect(env.DB.prepare(`
      INSERT INTO service_type_checkin_events
        (service_type_id, checkin_event_id, starts_on, ends_on,
         created_by_person_id, closed_by_person_id, closed_at)
      VALUES (8204, 8304, '2026-08-05', '2026-08-06', 8101, 8101, datetime('now'))
    `).run()).rejects.toThrow(/service_attendance_link_conflict/i);
    await expect(env.DB.prepare(`
      INSERT INTO service_type_checkin_events
        (service_type_id, checkin_event_id, starts_on, ends_on, created_by_person_id)
      VALUES (8204, 8304, '2026-08-12', NULL, 8101)
    `).run()).rejects.toThrow();
  });

  it('is append/close-only: permits one close and rejects delete, reopen, moves, and effective edits', async () => {
    const inserted = await env.DB.prepare(`
      INSERT INTO service_type_checkin_events
        (service_type_id, checkin_event_id, starts_on, created_by_person_id)
      VALUES (8205, 8305, '2026-08-12', 8101) RETURNING id
    `).first<{ id: number }>();
    await env.DB.prepare(`
      UPDATE service_type_checkin_events
      SET ends_on = '2026-08-12', closed_by_person_id = 8102, closed_at = datetime('now')
      WHERE id = ?
    `).bind(inserted!.id).run();

    await expect(env.DB.prepare('DELETE FROM service_type_checkin_events WHERE id = ?')
      .bind(inserted!.id).run()).rejects.toThrow(/service_attendance_link_immutable/i);
    await expect(env.DB.prepare(`
      UPDATE service_type_checkin_events
      SET ends_on = NULL, closed_by_person_id = NULL, closed_at = NULL WHERE id = ?
    `).bind(inserted!.id).run()).rejects.toThrow(/service_attendance_link_immutable/i);
    await expect(env.DB.prepare(`
      UPDATE service_type_checkin_events SET starts_on = '2026-08-11' WHERE id = ?
    `).bind(inserted!.id).run()).rejects.toThrow(/service_attendance_link_immutable/i);
  });
});
