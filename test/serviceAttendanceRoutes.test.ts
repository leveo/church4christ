import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { todayInTz } from '../src/lib/dates';
import type { SessionUser } from '../src/lib/types';
import { POST as countPost, ALL as countAll } from '../src/pages/admin/attendance/count';
import { POST as linksPost, ALL as linksAll } from '../src/pages/admin/attendance/checkin-links';
import { GET as reportGet, ALL as reportAll } from '../src/pages/admin/attendance/report.csv';

function user(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 7,
    email: 'attendance.admin@example.com',
    displayName: 'Attendance Admin',
    role: 'admin',
    isAdmin: true,
    isEditor: false,
    finance: 0,
    memberTeamIds: [],
    leaderTeamIds: [],
    lang: 'en',
    isSuperAdmin: false,
    adminAreas: ['attendance'],
    ...over,
  };
}

function poisonedContext(path: string, modules: string[], actor: SessionUser | null = user()): never {
  const request = new Request(`https://church.example${path}`, { method: 'POST' });
  Object.defineProperty(request, 'formData', {
    value: () => {
      throw new Error('request body was read');
    },
  });
  const db = new Proxy({}, {
    get() {
      throw new Error('database was queried');
    },
  });
  return {
    request,
    url: new URL(request.url),
    locals: { user: actor, modules: new Set(modules), db },
  } as never;
}

function context(path: string, method: 'GET' | 'POST', form?: FormData): never {
  const request = new Request(`https://church.example${path}`, { method, body: form });
  return {
    request,
    url: new URL(request.url),
    locals: { user: user(), modules: new Set(['attendance', 'children']), db: env.DB },
  } as never;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM service_attendance WHERE service_type_id = 9701'),
    env.DB.prepare("INSERT OR IGNORE INTO people (id, display_name, email, role, active) VALUES (7, 'Attendance Admin', 'attendance.admin@example.com', 'admin', 1)"),
    env.DB.prepare('INSERT OR IGNORE INTO service_types (id, sort) VALUES (9701, 1)'),
    env.DB.prepare("INSERT OR IGNORE INTO service_type_i18n (service_type_id, locale, name) VALUES (9701, 'en', 'Morning Service')"),
    env.DB.prepare("INSERT OR IGNORE INTO checkin_events (id, name, active) VALUES (9711, 'Nursery', 1)"),
    env.DB.prepare("INSERT OR IGNORE INTO checkin_events (id, name, active) VALUES (9712, 'Elementary', 1)"),
  ]);
});

describe('service attendance route guards', () => {
  it('returns 404 before body or database access when Attendance is disabled', async () => {
    expect((await countPost(poisonedContext('/admin/attendance/count', []))).status).toBe(404);
  });

  it('returns 403 before body or database access without the Attendance grant', async () => {
    const noGrant = user({ adminAreas: [] });
    expect((await countPost(poisonedContext('/admin/attendance/count', ['attendance'], noGrant))).status).toBe(403);
  });

  it('returns 404 before body or database access when Children link editing is disabled', async () => {
    expect((await linksPost(poisonedContext('/admin/attendance/checkin-links', ['attendance']))).status).toBe(404);
  });

  it('guards the CSV before database access but does not require Children', async () => {
    const context = poisonedContext('/admin/attendance/report.csv', ['attendance'], user({ adminAreas: [] }));
    expect((await reportGet(context)).status).toBe(403);
  });
});

describe('service attendance route methods', () => {
  it('advertises POST for count and link mutations', async () => {
    for (const handler of [countAll, linksAll]) {
      const response = await handler({} as never);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('advertises GET for CSV reports', async () => {
    const response = await reportAll({} as never);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('service attendance route behavior', () => {
  it('uses the authenticated actor and strict adult form, ignoring actor fields', async () => {
    const today = todayInTz();
    const form = new FormData();
    form.set('service_type_id', '9701');
    form.set('attendance_date', today);
    form.set('adult_count', '42');
    form.set('actor_person_id', '999999');
    const response = await countPost(context('/admin/attendance/count', 'POST', form));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/attendance?saved=count');
    expect(await env.DB.prepare(`
      SELECT adult_count, recorded_by_person_id, updated_by_person_id
      FROM service_attendance WHERE service_type_id = 9701 AND attendance_date = ?
    `).bind(today).first()).toEqual({ adult_count: 42, recorded_by_person_id: 7, updated_by_person_id: 7 });

    const invalid = new FormData();
    invalid.set('service_type_id', '9701');
    invalid.set('attendance_date', today);
    invalid.set('adult_count', 'private@example.com');
    const invalidResponse = await countPost(context('/admin/attendance/count', 'POST', invalid));
    expect(invalidResponse.status).toBe(303);
    expect(invalidResponse.headers.get('location')).toBe('/admin/attendance?error=attendance_invalid');
    expect(invalidResponse.headers.get('location')).not.toContain('private');

    const duplicated = new FormData();
    duplicated.append('service_type_id', '9701');
    duplicated.append('service_type_id', '9999');
    duplicated.set('attendance_date', today);
    duplicated.set('adult_count', '4');
    const duplicateResponse = await countPost(context('/admin/attendance/count', 'POST', duplicated));
    expect(duplicateResponse.status).toBe(303);
    expect(duplicateResponse.headers.get('location')).toBe('/admin/attendance?error=attendance_invalid');
  });

  it('rejects a non-form request with one fixed PII-free code', async () => {
    const request = new Request('https://church.example/admin/attendance/count', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'private@example.com',
    });
    const response = await countPost({
      request,
      url: new URL(request.url),
      locals: { user: user(), modules: new Set(['attendance']), db: env.DB },
    } as never);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/attendance?error=attendance_invalid');
    expect(response.headers.get('location')).not.toContain('private');
  });

  it('uses the server date and exact repeated event ids, ignoring client date and actor', async () => {
    const form = new FormData();
    form.set('service_type_id', '9701');
    form.append('checkin_event_id', '9712');
    form.append('checkin_event_id', '9711');
    form.append('checkin_event_id', '9712');
    form.set('today', '2000-01-01');
    form.set('actor_person_id', '999999');
    const response = await linksPost(context('/admin/attendance/checkin-links', 'POST', form));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/attendance?saved=links');
    const rows = await env.DB.prepare(`
      SELECT checkin_event_id, starts_on, created_by_person_id
      FROM service_type_checkin_events WHERE service_type_id = 9701 ORDER BY checkin_event_id
    `).all();
    expect(rows.results).toEqual([
      { checkin_event_id: 9711, starts_on: todayInTz(), created_by_person_id: 7 },
      { checkin_event_id: 9712, starts_on: todayInTz(), created_by_person_id: 7 },
    ]);

    const invalid = new FormData();
    invalid.append('service_type_id', '9701');
    invalid.append('service_type_id', '9999');
    invalid.append('checkin_event_id', '9711');
    const invalidResponse = await linksPost(context('/admin/attendance/checkin-links', 'POST', invalid));
    expect(invalidResponse.status).toBe(303);
    expect(invalidResponse.headers.get('location')).toBe('/admin/attendance?error=attendance_invalid');
  });

  it('exports default and explicit bounded windows with safe UTF-8 attachment headers', async () => {
    const today = todayInTz();
    const countForm = new FormData();
    countForm.set('service_type_id', '9701');
    countForm.set('attendance_date', today);
    countForm.set('adult_count', '9');
    await countPost(context('/admin/attendance/count', 'POST', countForm));

    for (const path of [
      '/admin/attendance/report.csv',
      `/admin/attendance/report.csv?from=${today}&to=${today}`,
    ]) {
      const response = await reportGet(context(path, 'GET'));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="church4christ-service-attendance-\d{4}-\d{2}-\d{2}\.csv"$/);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const csv = new TextDecoder().decode(bytes);
      expect(Number(response.headers.get('content-length'))).toBe(bytes.byteLength);
      expect(csv).toMatch(new RegExp(`${today},9701,Morning Service,9,(?:,|0,9)`));
      expect(csv).not.toMatch(/email|person|member|roster|recorded_by/i);
    }

    const overLimit = await reportGet(context('/admin/attendance/report.csv?from=2025-01-01&to=2026-08-12', 'GET'));
    expect(overLimit.status).toBe(400);
    expect(await overLimit.text()).toBe('attendance_window_limit');
    expect(overLimit.headers.get('cache-control')).toBe('no-store');
  });
});
