// Giving history panel gating (Task 7), Postgres-backed: the panel only renders
// for admins holding the 'giving' area grant, and giving is a Supabase-only
// module, so this is the one place that can actually exercise
// listHouseholdGifts / householdYearTotals returning real rows (D1 forces the
// module off, so test/e2e/admin-permissions.e2e.test.ts never reaches them).
//
// seed/dev-seed.sql (loaded by ./setup.ts for every e2e-pg file) carries no
// gift rows — the demo gifts live in seed/giving-seed.sql, which is a
// deploy-time seed applied by scripts/db/seed-supabase.mjs and never loaded by
// this test harness. So this file seeds one fund + one succeeded gift for
// person 3 (Sarah Johnson, an existing dev-seed person) directly over the same
// HYPERDRIVE connection ./setup.ts itself uses, plus two ad hoc limited admins
// (one granted 'giving', one granted nothing) — mirroring the D1 suite's
// beforeEach person-50 insert pattern.
import { env } from 'cloudflare:test';
import postgres from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { get } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

const GIVING_HEADING = 'Giving history'; // src/i18n/en.ts: admin.person.giving.title

beforeAll(async () => {
  const hyperdrive = (env as unknown as { HYPERDRIVE: { connectionString: string } }).HYPERDRIVE;
  const sql = postgres(hyperdrive.connectionString, {
    max: 1,
    fetch_types: false,
    prepare: false,
    onnotice: () => {},
  });
  try {
    await sql.unsafe(`INSERT INTO funds (id, fund_number, active, sort) VALUES (1, '100', 1, 1)
      ON CONFLICT (id) DO NOTHING`);
    await sql.unsafe(`INSERT INTO fund_i18n (fund_id, locale, name) VALUES (1, 'en', 'General')
      ON CONFLICT DO NOTHING`);
    await sql.unsafe(`INSERT INTO gifts (id, person_id, fund_id, amount_cents, currency, method, status, received_on, recorded_by)
      VALUES (1, 3, 1, 5000, 'usd', 'cash', 'succeeded', date('now','start of day'), 1)
      ON CONFLICT (id) DO NOTHING`);
    // Two ad hoc limited admins: Gail holds the giving grant, Nora holds none.
    // Neither carries an explicit lang, so both render admin.person.giving.*
    // in English (person.lang NULL -> SessionUser.lang null -> page default 'en').
    await sql.unsafe(`INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
      VALUES (60, 'Gail', 'Giving', 'Gail Giving', 'gail.giving@example.com', 'admin', 0, 'giving')
      ON CONFLICT (id) DO NOTHING`);
    await sql.unsafe(`INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
      VALUES (61, 'Nora', 'Nogrant', 'Nora Nogrant', 'nora.nogrant@example.com', 'admin', 0, '')
      ON CONFLICT (id) DO NOTHING`);
  } finally {
    await sql.end();
  }
});

describe('giving history panel follows the giving area grant (Postgres, real gift data)', () => {
  it('super admin sees the giving heading and the seeded gift', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const html = await (await get('/admin/people/3', { cookie })).text();
    expect(html).toContain(GIVING_HEADING);
    expect(html).toContain('General'); // seeded fund name
  });

  it('admin granted the giving area sees it', async () => {
    const cookie = await sessionCookie(60, 'gail.giving@example.com');
    const html = await (await get('/admin/people/3', { cookie })).text();
    expect(html).toContain(GIVING_HEADING);
  });

  it('admin without the giving area does not see it', async () => {
    const cookie = await sessionCookie(61, 'nora.nogrant@example.com');
    const html = await (await get('/admin/people/3', { cookie })).text();
    expect(html).not.toContain(GIVING_HEADING);
  });
});
