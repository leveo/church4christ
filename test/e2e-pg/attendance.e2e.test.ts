// Four high-value parity cases for Aggregate Attendance against the built Worker
// and the disposable migrated PostgreSQL database reached through Hyperdrive.
import { env } from 'cloudflare:test';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { todayInTz } from '../../src/lib/dates';
import {
  attendanceModulesBody,
  attendanceRequest,
  attendanceSessionCookie,
  consumeStatus,
} from '../e2e/attendanceHelpers';
import { get, post } from '../e2e/helpers';

const connectionString = (env as unknown as { HYPERDRIVE: { connectionString: string } }).HYPERDRIVE.connectionString;

async function withPg<T>(operation: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const sql = postgres(connectionString, { max: 1, fetch_types: false, prepare: false, onnotice: () => {} });
  try {
    return await operation(sql);
  } finally {
    await sql.end();
  }
}

beforeEach(async () => {
  await withPg(async (sql) => {
    await sql.unsafe(`INSERT INTO people (id,first_name,last_name,display_name,email,role,super_admin,admin_areas)
      VALUES (60,'Ada','Aggregate','Ada Aggregate','ada.aggregate@example.com','admin',0,'attendance')
      ON CONFLICT(id) DO UPDATE SET admin_areas='attendance'`);
    await sql.unsafe(`INSERT INTO people (id,first_name,last_name,display_name,email,role,super_admin,admin_areas)
      VALUES (61,'Nora','Grant','Nora Grant','nora.grant@example.com','admin',0,'')
      ON CONFLICT(id) DO UPDATE SET admin_areas=''`);
    await sql.unsafe(`INSERT INTO people (id,first_name,last_name,display_name,email,role,super_admin,admin_areas)
      VALUES (62,'Gia','Groups','Gia Groups','gia.groups@example.com','admin',0,'groups')
      ON CONFLICT(id) DO UPDATE SET admin_areas='groups'`);
  });
});

afterEach(async () => {
  const admin = await attendanceSessionCookie(1, 'admin@example.com');
  await consumeStatus(await post('/admin/settings', attendanceModulesBody([]), { cookie: admin }));
});

describe('Postgres-backed aggregate Attendance parity', () => {
  it('enforces access, HTTP methods, CSRF, and exact module ownership', async () => {
    const anonymous = await get('/admin/attendance');
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toContain('/signin');
    await anonymous.arrayBuffer();

    for (const [id, email] of [
      [3, 'sarah.johnson@example.com'],
      [2, 'pastor.david@example.com'],
      [61, 'nora.grant@example.com'],
    ] as const) {
      expect(await consumeStatus(await get('/admin/attendance', {
        cookie: await attendanceSessionCookie(id, email),
      }))).toBe(403);
    }
    const attendance = await attendanceSessionCookie(60, 'ada.aggregate@example.com');
    expect(await consumeStatus(await get('/admin/attendance', { cookie: attendance }))).toBe(200);
    expect(await consumeStatus(await get('/admin/attendance', {
      cookie: await attendanceSessionCookie(1, 'admin@example.com'),
    }))).toBe(200);

    for (const [path, method, allow] of [
      ['/admin/attendance', 'HEAD', 'GET'],
      ['/admin/attendance/count', 'GET', 'POST'],
      ['/admin/attendance/report.csv', 'POST', 'GET'],
    ] as const) {
      const response = await attendanceRequest(path, method, attendance);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe(allow);
      await response.arrayBuffer();
    }
    expect(await consumeStatus(await attendanceRequest(
      '/admin/attendance/count', 'POST', attendance,
      'service_type_id=1&attendance_date=2031-01-05&adult_count=90',
      'https://cross-origin.example',
    ))).toBe(403);

    const admin = await attendanceSessionCookie(1, 'admin@example.com');
    expect(await consumeStatus(await post('/admin/settings', attendanceModulesBody(['attendance']), { cookie: admin }))).toBe(303);
    expect(await consumeStatus(await get('/admin/attendance'))).toBe(404);
    expect(await consumeStatus(await get('/admin/attendance/report.csv'))).toBe(404);
    expect(await consumeStatus(await attendanceRequest(
      '/admin/attendance/count', 'POST', undefined, 'malformed-before-body',
    ))).toBe(404);
  });

  it('preserves first-recorder adult correction and child history bytes with Children off', async () => {
    const attendance = await attendanceSessionCookie(60, 'ada.aggregate@example.com');
    const admin = await attendanceSessionCookie(1, 'admin@example.com');
    const day = todayInTz();
    const countBody = (service: number, count: number) => new URLSearchParams({
      service_type_id: String(service), attendance_date: day, adult_count: String(count), recorded_by_person_id: '999',
    }).toString();

    expect(await consumeStatus(await post('/admin/attendance/count', countBody(1, 140), { cookie: attendance }))).toBe(303);
    expect(await consumeStatus(await post('/admin/attendance/count', countBody(1, 141), { cookie: admin }))).toBe(303);
    expect(await consumeStatus(await post('/admin/attendance/count', countBody(2, 110), { cookie: attendance }))).toBe(303);

    await withPg(async (sql) => {
      const [adult] = await sql.unsafe<{ adult_count: number; recorded_by_person_id: number; updated_by_person_id: number }[]>(
        `SELECT adult_count,recorded_by_person_id,updated_by_person_id FROM service_attendance
         WHERE service_type_id=1 AND attendance_date=$1`, [day],
      );
      expect({
        adultCount: Number(adult.adult_count),
        recordedBy: Number(adult.recorded_by_person_id),
        updatedBy: Number(adult.updated_by_person_id),
      }).toEqual({ adultCount: 141, recordedBy: 60, updatedBy: 1 });

      await sql.unsafe(`INSERT INTO checkin_events (id,name,weekday,active) VALUES (91,'Inactive Room',NULL,0)`);
      await sql.unsafe(`INSERT INTO checkin_events (id,name,weekday,active) VALUES (92,'Empty Room',NULL,1)`);
      await sql.unsafe(`UPDATE households SET deleted_at=datetime('now') WHERE id=2`);
    });

    const linked = new URLSearchParams({ service_type_id: '1' });
    linked.append('checkin_event_id', '1');
    linked.append('checkin_event_id', '91');
    expect(await consumeStatus(await post('/admin/attendance/checkin-links', linked.toString(), { cookie: attendance }))).toBe(303);
    expect(await consumeStatus(await post('/admin/attendance/checkin-links', new URLSearchParams({
      service_type_id: '2', checkin_event_id: '92',
    }).toString(), { cookie: attendance }))).toBe(303);

    await withPg(async (sql) => {
      await sql.unsafe(`INSERT INTO checkins (event_id,household_id,household_member_id,child_name,security_code,checkin_date,checked_in_at)
        VALUES (1,2,8,'Noah Lin 林诺亚','A2B3',$1,datetime('now'))`, [day]);
      await sql.unsafe(`INSERT INTO checkins (event_id,household_id,household_member_id,child_name,security_code,checkin_date,checked_in_at,checked_out_at)
        VALUES (91,2,8,'Noah Lin 林诺亚','A2B3',$1,datetime('now'),datetime('now'))`, [day]);
      await sql.unsafe(`INSERT INTO checkins (event_id,household_id,household_member_id,child_name,security_code,checkin_date,checked_in_at)
        VALUES (91,2,9,'Lily Lin 林莉莉','C4D5',$1,datetime('now'))`, [day]);
    });

    const path = `/admin/attendance/report.csv?from=${day}&to=${day}`;
    const beforeResponse = await get(path, { cookie: attendance });
    expect(beforeResponse.status).toBe(200);
    const before = new Uint8Array(await beforeResponse.arrayBuffer());
    const text = new TextDecoder().decode(before);
    expect(text).toContain(`${day},1,Sunday Worship (English),141,2,143`);
    expect(text).toContain(`${day},2,Chinese Sunday Worship,110,0,110`);

    expect(await consumeStatus(await post('/admin/settings', attendanceModulesBody(['children']), { cookie: admin }))).toBe(303);
    const page = await get('/admin/attendance', { cookie: attendance });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Historical child totals remain available');
    expect(html).not.toContain('action="/admin/attendance/checkin-links"');
    expect(await consumeStatus(await post('/admin/attendance/checkin-links', 'service_type_id=1', { cookie: attendance }))).toBe(404);
    const after = await get(path, { cookie: attendance });
    expect(after.status).toBe(200);
    expect(new Uint8Array(await after.arrayBuffer())).toEqual(before);
  });

  it('keeps aggregate Attendance isolated from Groups while preserving token tracking', async () => {
    const attendance = await attendanceSessionCookie(60, 'ada.aggregate@example.com');
    expect(await consumeStatus(await get('/attendance/o/1', { cookie: attendance }))).toBe(404);
    const history = await get('/admin/people/5', { cookie: attendance });
    expect(history.status).toBe(200);
    expect(await history.text()).not.toContain('Group activity');
    for (const [id, email] of [
      [62, 'gia.groups@example.com'],
      [8, 'ben.wu@example.com'],
      [1, 'admin@example.com'],
    ] as const) {
      expect(await consumeStatus(await get('/attendance/o/1', {
        cookie: await attendanceSessionCookie(id, email),
      }))).toBe(200);
    }

    const raw = 'attendance-phase3-pg-token';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    await withPg(async (sql) => {
      await sql.unsafe(`INSERT INTO group_attendance_tokens (occurrence_id,person_id,token_hash,expires_at)
        VALUES (1,8,$1,datetime('now','+72 hours'))`, [hash]);
    });
    expect(await consumeStatus(await get(`/attendance/${raw}`))).toBe(200);
    expect(await consumeStatus(await post(`/attendance/${raw}`, `token=${raw}&member=1`))).toBe(303);
    const rows = await withPg(async (sql) => sql.unsafe<{ member_id: number; present: number }[]>(
      'SELECT member_id,present FROM group_attendance WHERE occurrence_id=1 ORDER BY member_id',
    ));
    expect(rows.map((row) => ({ memberId: Number(row.member_id), present: Number(row.present) }))).toEqual([
      { memberId: 1, present: 1 },
      { memberId: 2, present: 0 },
      { memberId: 3, present: 0 },
      { memberId: 4, present: 0 },
    ]);
    expect(await consumeStatus(await get(`/attendance/${raw}`))).toBe(200);
  });

  it('returns a bounded no-store UTF-8 CSV without adult or child identities', async () => {
    const attendance = await attendanceSessionCookie(60, 'ada.aggregate@example.com');
    const response = await get('/admin/attendance/report.csv', { cookie: attendance });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="church4christ-service-attendance-/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    const csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    expect(csv).toContain('attendance_date,service_type_id,service_name,adult_count,child_count,combined_count');
    expect(csv).not.toMatch(/Noah|Lily|recorded_by|updated_by|person_email|member_id|adult_name/i);
  });
});
