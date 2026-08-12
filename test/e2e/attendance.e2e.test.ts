// Aggregate Attendance integration against the built Worker and a real migrated
// D1 binding. Every HTTP assertion consumes its response body per Workers test
// guidance, and every mutation uses fictional, file-local fixtures.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { todayInTz } from '../../src/lib/dates';
import { get, post } from './helpers';
import {
  attendanceModulesBody as modulesBody,
  attendanceRequest as rawRequest,
  attendanceSessionCookie as sessionCookie,
  consumeStatus as status,
} from './attendanceHelpers';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
      VALUES (60, 'Ada', 'Aggregate', 'Ada Aggregate', 'ada.aggregate@example.com', 'admin', 0, 'attendance')
      ON CONFLICT(id) DO UPDATE SET admin_areas='attendance'`),
    env.DB.prepare(`INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
      VALUES (61, 'Nora', 'Grant', 'Nora Grant', 'nora.grant@example.com', 'admin', 0, '')
      ON CONFLICT(id) DO UPDATE SET admin_areas=''`),
    env.DB.prepare(`INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
      VALUES (62, 'Gia', 'Groups', 'Gia Groups', 'gia.groups@example.com', 'admin', 0, 'groups')
      ON CONFLICT(id) DO UPDATE SET admin_areas='groups'`),
  ]);
});

afterEach(async () => {
  const admin = await sessionCookie(1, 'admin@example.com');
  await status(await post('/admin/settings', modulesBody([]), { cookie: admin }));
});

describe('aggregate Attendance access and HTTP contracts', () => {
  it('redirects anonymous GET, denies non-admin and ungranted roles, and allows Attendance grant plus super', async () => {
    const anonymous = await get('/admin/attendance');
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toContain('/signin');
    await anonymous.arrayBuffer();

    for (const [id, email] of [
      [3, 'sarah.johnson@example.com'],
      [2, 'pastor.david@example.com'],
      [61, 'nora.grant@example.com'],
    ] as const) {
      expect(await status(await get('/admin/attendance', { cookie: await sessionCookie(id, email) }))).toBe(403);
    }
    for (const [id, email] of [
      [60, 'ada.aggregate@example.com'],
      [1, 'admin@example.com'],
    ] as const) {
      const response = await get('/admin/attendance', { cookie: await sessionCookie(id, email) });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Service attendance');
      expect(html).not.toMatch(/adult_(?:person|member|attendee|identity|name|email)/i);
    }
  });

  it('enforces method Allow headers and rejects cross-origin mutations without writes', async () => {
    const attendance = await sessionCookie(60, 'ada.aggregate@example.com');
    for (const [path, method, allow] of [
      ['/admin/attendance', 'HEAD', 'GET'],
      ['/admin/attendance', 'OPTIONS', 'GET'],
      ['/admin/attendance', 'POST', 'GET'],
      ['/admin/attendance/count', 'GET', 'POST'],
      ['/admin/attendance/count', 'OPTIONS', 'POST'],
      ['/admin/attendance/checkin-links', 'GET', 'POST'],
      ['/admin/attendance/report.csv', 'POST', 'GET'],
    ] as const) {
      const response = await rawRequest(path, method, attendance);
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get('allow'), `${method} ${path}`).toBe(allow);
      await response.arrayBuffer();
    }

    const day = '2031-01-12';
    const crossOrigin = await rawRequest(
      '/admin/attendance/count',
      'POST',
      attendance,
      new URLSearchParams({ service_type_id: '1', attendance_date: day, adult_count: '99' }).toString(),
      'https://cross-origin.example',
    );
    expect(await status(crossOrigin)).toBe(403);
    expect(await env.DB.prepare(
      'SELECT 1 AS x FROM service_attendance WHERE service_type_id=1 AND attendance_date=?',
    ).bind(day).first()).toBeNull();
  });

  it('404s the exact Attendance subtree before auth and CSRF while off, then restores it', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const raw = 'attendance-module-ownership-token';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare(
      `INSERT INTO group_attendance_tokens (occurrence_id,person_id,token_hash,expires_at)
       VALUES (1,8,?,datetime('now','+72 hours'))`,
    ).bind(hash).run();
    expect(await status(await post('/admin/settings', modulesBody(['attendance']), { cookie: admin }))).toBe(303);

    expect(await status(await get('/admin/attendance'))).toBe(404);
    expect(await status(await get('/admin/attendance/report.csv'))).toBe(404);
    const hostilePost = await rawRequest(
      '/admin/attendance/count', 'POST', undefined, 'not-valid-form-data',
    );
    expect(await status(hostilePost)).toBe(404);
    expect(await status(await get(`/attendance/${raw}`))).toBe(200);

    expect(await status(await post('/admin/settings', modulesBody([]), { cookie: admin }))).toBe(303);
    expect(await status(await get('/admin/attendance', { cookie: admin }))).toBe(200);
  });
});

describe('aggregate Attendance records and reports', () => {
  it('inserts and corrects one adult aggregate while retaining the first recorder', async () => {
    const attendance = await sessionCookie(60, 'ada.aggregate@example.com');
    const superAdmin = await sessionCookie(1, 'admin@example.com');
    const day = '2031-02-02';
    const body = (count: number, actor: string) => new URLSearchParams({
      service_type_id: '1', attendance_date: day, adult_count: String(count), recorded_by_person_id: actor,
    }).toString();

    expect(await status(await post('/admin/attendance/count', body(123, '1'), { cookie: attendance }))).toBe(303);
    const first = await env.DB.prepare(
      `SELECT adult_count, recorded_by_person_id, updated_by_person_id, created_at
       FROM service_attendance WHERE service_type_id=1 AND attendance_date=?`,
    ).bind(day).first<{ adult_count: number; recorded_by_person_id: number; updated_by_person_id: number; created_at: string }>();
    expect(first).toMatchObject({ adult_count: 123, recorded_by_person_id: 60, updated_by_person_id: 60 });

    expect(await status(await post('/admin/attendance/count', body(129, '60'), { cookie: superAdmin }))).toBe(303);
    const corrected = await env.DB.prepare(
      `SELECT adult_count, recorded_by_person_id, updated_by_person_id, created_at
       FROM service_attendance WHERE service_type_id=1 AND attendance_date=?`,
    ).bind(day).first<typeof first>();
    expect(corrected).toEqual({ ...first!, adult_count: 129, updated_by_person_id: 1 });
  });

  it('derives distinct children across real linked rooms and preserves null versus configured zero', async () => {
    const attendance = await sessionCookie(60, 'ada.aggregate@example.com');
    const day = todayInTz();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO checkin_events (id,name,weekday,active) VALUES (91,'Inactive Room',NULL,0)`),
      env.DB.prepare(`INSERT INTO checkin_events (id,name,weekday,active) VALUES (92,'Empty Room',NULL,1)`),
      env.DB.prepare(`UPDATE households SET deleted_at=datetime('now') WHERE id=2`),
    ]);
    for (const [service, count] of [[1, 140], [2, 110]] as const) {
      await status(await post('/admin/attendance/count', new URLSearchParams({
        service_type_id: String(service), attendance_date: day, adult_count: String(count),
      }).toString(), { cookie: attendance }));
    }

    const before = await get(`/admin/attendance/report.csv?from=${day}&to=${day}`, { cookie: attendance });
    expect(before.status).toBe(200);
    expect(await before.text()).toContain(`${day},2,Chinese Sunday Worship,110,,`);

    const linkOne = new URLSearchParams({ service_type_id: '1' });
    linkOne.append('checkin_event_id', '1');
    linkOne.append('checkin_event_id', '91');
    expect(await status(await post('/admin/attendance/checkin-links', linkOne.toString(), { cookie: attendance }))).toBe(303);
    expect(await status(await post('/admin/attendance/checkin-links', new URLSearchParams({
      service_type_id: '2', checkin_event_id: '92',
    }).toString(), { cookie: attendance }))).toBe(303);

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO checkins (event_id,household_id,household_member_id,child_name,security_code,checkin_date,checked_in_at)
        VALUES (1,2,8,'Noah Lin 林诺亚','A2B3',?,datetime('now'))`).bind(day),
      env.DB.prepare(`INSERT INTO checkins (event_id,household_id,household_member_id,child_name,security_code,checkin_date,checked_in_at,checked_out_at)
        VALUES (91,2,8,'Noah Lin 林诺亚','A2B3',?,datetime('now'),datetime('now'))`).bind(day),
      env.DB.prepare(`INSERT INTO checkins (event_id,household_id,household_member_id,child_name,security_code,checkin_date,checked_in_at)
        VALUES (91,2,9,'Lily Lin 林莉莉','C4D5',?,datetime('now'))`).bind(day),
    ]);

    const csvResponse = await get(`/admin/attendance/report.csv?from=${day}&to=${day}`, { cookie: attendance });
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get('cache-control')).toBe('no-store');
    const csv = await csvResponse.text();
    expect(csv).toContain(`${day},1,Sunday Worship (English),140,2,142`);
    expect(csv).toContain(`${day},2,Chinese Sunday Worship,110,0,110`);
    expect(csv).not.toMatch(/Noah|Lily|recorded_by|updated_by|person_email|member_id/i);
  });

  it('keeps historical page and CSV data when Children is off but hides and rejects link editing', async () => {
    const attendance = await sessionCookie(60, 'ada.aggregate@example.com');
    const admin = await sessionCookie(1, 'admin@example.com');
    const to = todayInTz();
    const fromDate = new Date(`${to}T00:00:00Z`);
    fromDate.setUTCDate(fromDate.getUTCDate() - 83);
    const from = fromDate.toISOString().slice(0, 10);
    const path = `/admin/attendance/report.csv?from=${from}&to=${to}`;
    const beforeResponse = await get(path, { cookie: attendance });
    expect(beforeResponse.status).toBe(200);
    const before = new Uint8Array(await beforeResponse.arrayBuffer());

    expect(await status(await post('/admin/settings', modulesBody(['children']), { cookie: admin }))).toBe(303);
    const page = await get('/admin/attendance', { cookie: attendance });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Historical child totals remain available');
    expect(html).not.toContain('action="/admin/attendance/checkin-links"');
    expect(await status(await post('/admin/attendance/checkin-links', 'service_type_id=1', { cookie: attendance }))).toBe(404);

    const afterResponse = await get(path, { cookie: attendance });
    expect(afterResponse.status).toBe(200);
    expect(new Uint8Array(await afterResponse.arrayBuffer())).toEqual(before);
  });
});

describe('aggregate Attendance never grants Groups per-person tracking', () => {
  it('denies Attendance-only override/history but allows Groups grant, active group admin, and super', async () => {
    const attendance = await sessionCookie(60, 'ada.aggregate@example.com');
    expect(await status(await get('/attendance/o/1', { cookie: attendance }))).toBe(404);
    const personPage = await get('/admin/people/5', { cookie: attendance });
    expect(personPage.status).toBe(200);
    expect(await personPage.text()).not.toContain('Group activity');

    for (const [id, email] of [
      [62, 'gia.groups@example.com'],
      [8, 'ben.wu@example.com'],
      [1, 'admin@example.com'],
    ] as const) {
      expect(await status(await get('/attendance/o/1', { cookie: await sessionCookie(id, email) }))).toBe(200);
    }
  });

  it('keeps token attendance multi-use and writes present plus absent rows for every active/name-only member', async () => {
    const raw = 'attendance-phase3-token';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare(
      `INSERT INTO group_attendance_tokens (occurrence_id,person_id,token_hash,expires_at)
       VALUES (1,8,?,datetime('now','+72 hours'))`,
    ).bind(hash).run();

    expect(await status(await get(`/attendance/${raw}`))).toBe(200);
    expect(await status(await post(`/attendance/${raw}`, `token=${raw}&member=1`))).toBe(303);
    const rows = await env.DB.prepare(
      'SELECT member_id,present FROM group_attendance WHERE occurrence_id=1 ORDER BY member_id',
    ).all<{ member_id: number; present: number }>();
    expect(rows.results).toEqual([
      { member_id: 1, present: 1 },
      { member_id: 2, present: 0 },
      { member_id: 3, present: 0 },
      { member_id: 4, present: 0 },
    ]);
    expect(await status(await get(`/attendance/${raw}`))).toBe(200);
  });
});
