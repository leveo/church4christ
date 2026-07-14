import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';

// The pg project runs serially (fileParallelism: false) and every other suite
// drops/recreates the public schema in its own beforeAll, so this suite must
// not assume any schema state — it resets first, then drives the real scripts
// end to end via execFileSync (the way an operator runs them).
describe.skipIf(!hasPg)('Supabase migration runner + seed script', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const migrationFiles = () =>
    readdirSync('migrations-supabase').filter((f) => f.endsWith('.sql')).sort();
  const run = (script: string) =>
    execFileSync('node', [`scripts/db/${script}`], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('applies every migration once and records each in _migrations', async () => {
    run('migrate-supabase.mjs');
    const rows = await sql.unsafe('SELECT name FROM _migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(migrationFiles());
  });

  it('is idempotent — a second run errors on nothing and adds no rows', async () => {
    run('migrate-supabase.mjs'); // must not throw
    const rows = await sql.unsafe('SELECT name FROM _migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(migrationFiles());
    const privateRows = await sql.unsafe(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'church_private' ORDER BY table_name",
    );
    expect(privateRows.map((row) => row.table_name)).toEqual([
      'stripe_checkout_requests',
      'stripe_webhook_events',
    ]);
  });

  it('seeds the demo data (people rows exist)', async () => {
    run('seed-supabase.mjs');
    const [{ count }] = await sql.unsafe('SELECT count(*)::int AS count FROM people');
    expect(count).toBeGreaterThan(0);
  });

  it('reset every identity sequence so a fresh insert does not collide', async () => {
    const [{ m }] = await sql.unsafe('SELECT max(id)::int AS m FROM people');
    const r = await sql.unsafe(
      "INSERT INTO people (first_name, last_name, display_name, email) " +
        "VALUES ('Seq', 'Test', 'Seq Test', 'seq.test@example.com') RETURNING id",
    );
    expect(Number(r[0].id)).toBeGreaterThan(Number(m));
  });
});
