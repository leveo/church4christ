import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { get, post } from './helpers';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const cookie = async (id: number, email: string) => `${SESSION_COOKIE}=${await mintSession(SECRET, { id, email, sessionEpoch: 0 })}`;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM newcomer_activity').run();
  await env.DB.prepare('DELETE FROM newcomer_answers').run();
  await env.DB.prepare('DELETE FROM newcomer_submissions').run();
  await env.DB.prepare('DELETE FROM newcomer_rate_limits').run();
  await env.DB.prepare(`INSERT INTO people (id,first_name,last_name,display_name,email,role,admin_areas)
    VALUES (70,'Nina','Newcomer','Nina Newcomer','nina.newcomer@example.com','member','newcomers')
    ON CONFLICT(id) DO UPDATE SET admin_areas='newcomers'`).run();
});

describe('built D1 Newcomers experience', () => {
  it('accepts public intake generically without creating a Person', async () => {
    expect((await get('/en/new-here')).status).toBe(200);
    const peopleBefore = await env.DB.prepare('SELECT COUNT(*) AS n FROM people').first<number>('n');
    const response = await post('/en/new-here', new URLSearchParams({
      website: '', name: 'Taylor Guest', email: 'taylor.guest@example.test', phone: '',
      visit_date: '2026-08-12', service_type_id: '', contact_consent: 'true',
    }).toString(), { 'CF-Connecting-IP': '203.0.113.20' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_submissions').first<number>('n')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people').first<number>('n')).toBe(peopleBefore);
  });

  it('lets scoped staff use the queue and create a staff intake but not settings', async () => {
    const staff = await cookie(70, 'nina.newcomer@example.com');
    expect((await get('/admin/newcomers', { cookie: staff })).status).toBe(200);
    expect((await get('/admin/newcomers/settings', { cookie: staff })).status).toBe(403);
    const response = await post('/admin/newcomers/new', new URLSearchParams({
      name: 'Phone Guest', email: '', phone: '+1 312 555 0123', locale: 'en',
      visit_date: '2026-08-12', service_type_id: '', contact_consent: 'false',
    }).toString(), { cookie: staff });
    expect(response.status).toBe(303);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM newcomer_submissions WHERE source='staff'").first<number>('n')).toBe(1);
  });

  it('rejects cross-site staff mutation through middleware CSRF', async () => {
    const staff = await cookie(70, 'nina.newcomer@example.com');
    const response = await post('/admin/newcomers/new', 'name=Blocked', {
      cookie: staff, origin: 'https://attacker.example',
    });
    expect(response.status).toBe(403);
  });
});
