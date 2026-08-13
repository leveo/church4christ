import { env } from 'cloudflare:test';
import postgres from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { get, post } from '../e2e/helpers';

const bindings = env as unknown as {
  HYPERDRIVE: { connectionString: string };
  SESSION_SECRET: string;
};

async function withPg<T>(operation: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const sql = postgres(bindings.HYPERDRIVE.connectionString, {
    max: 1, fetch_types: false, prepare: false, onnotice: () => {},
  });
  try { return await operation(sql); } finally { await sql.end(); }
}

const staffCookie = async () => `${SESSION_COOKIE}=${await mintSession(bindings.SESSION_SECRET, {
  id: 70, email: 'nina.newcomer@example.com', sessionEpoch: 0,
})}`;

beforeEach(async () => {
  await withPg(async (sql) => {
    await sql.unsafe('DELETE FROM newcomer_submissions');
    await sql.unsafe('DELETE FROM newcomer_rate_limits');
    await sql.unsafe(`INSERT INTO people (id,first_name,last_name,display_name,email,role,super_admin,admin_areas)
      VALUES (70,'Nina','Newcomer','Nina Newcomer','nina.newcomer@example.com','member',0,'newcomers')
      ON CONFLICT(id) DO UPDATE SET admin_areas='newcomers'`);
  });
});

describe('built PostgreSQL Newcomers experience', () => {
  it('keeps public intake generic and People-isolated, then exposes it to scoped staff', async () => {
    const before = await withPg(async (sql) => sql.unsafe<{ count: string }[]>('SELECT COUNT(*) AS count FROM people'));
    const publicResponse = await post('/zh/new-here', new URLSearchParams({
      website: '', name: 'Morgan Guest', email: 'morgan.guest@example.test', phone: '',
      visit_date: '2026-08-12', service_type_id: '', contact_consent: 'true',
    }).toString(), { 'CF-Connecting-IP': '203.0.113.21' });
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get('cache-control')).toContain('no-store');

    const counts = await withPg(async (sql) => ({
      people: await sql.unsafe<{ count: string }[]>('SELECT COUNT(*) AS count FROM people'),
      submissions: await sql.unsafe<{ count: string }[]>("SELECT COUNT(*) AS count FROM newcomer_submissions WHERE source='public'"),
      plaintext: await sql.unsafe<{ count: string }[]>("SELECT COUNT(*) AS count FROM newcomer_rate_limits WHERE bucket_hash LIKE '%morgan%' OR bucket_hash LIKE '%203.0.113.21%'"),
    }));
    expect(Number(counts.people[0].count)).toBe(Number(before[0].count));
    expect(Number(counts.submissions[0].count)).toBe(1);
    expect(Number(counts.plaintext[0].count)).toBe(0);

    const cookie = await staffCookie();
    expect((await get('/admin/newcomers', { cookie })).status).toBe(200);
    expect((await get('/admin/newcomers/settings', { cookie })).status).toBe(403);
    expect((await post('/admin/newcomers/new', new URLSearchParams({
      name: 'Phone Guest', email: '', phone: '+1 312 555 0123', locale: 'en',
      visit_date: '2026-08-12', service_type_id: '', contact_consent: 'false',
    }).toString(), { cookie })).status).toBe(303);
  });
});
