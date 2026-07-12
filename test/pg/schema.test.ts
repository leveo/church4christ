import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';

// The D1 migration files whose CREATE TABLE / ADD COLUMN statements define the
// shared schema this port must match. 0004 adds the two people giving columns.
const D1_FILES = [
  '0001_init.sql',
  '0002_email.sql',
  '0003_people.sql',
  '0004_giving_people.sql',
  '0005_custom_pages.sql',
  '0006_groups.sql',
  '0007_children_checkin.sql',
  '0008_admin_permissions.sql',
  '0010_member_portal.sql',
];

describe.skipIf(!hasPg)('Postgres schema port', () => {
  const sql = hasPg ? pgClient() : (null as never);
  beforeAll(async () => {
    await resetSchema(sql);
    // Migrate via the runner so every migrations-supabase/*.sql applies in order
    // (0001_init + 0002_giving), the way an operator ships it.
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
  });
  afterAll(async () => { await sql?.end(); });

  it('creates every table the D1 migrations create', async () => {
    // Parse table names straight out of the D1 migration files so this test
    // can never drift from the source of truth.
    const d1Sql = D1_FILES
      .map((f) => readFileSync(`migrations/${f}`, 'utf8'))
      .join('\n');
    // SQLite CHECK-constraint changes use the table-rebuild idiom (CREATE x_new
    // -> copy -> DROP x -> RENAME x_new TO x); the intermediate name never
    // exists in the final schema on either backend, so fold it into its target.
    const renames = new Map<string, string>();
    for (const m of d1Sql.matchAll(/ALTER TABLE (\w+) RENAME TO (\w+)/gi)) renames.set(m[1].toLowerCase(), m[2].toLowerCase());
    const wanted = [
      ...new Set(
        [...d1Sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+)/gi)].map((m) => {
          const t = m[1].toLowerCase();
          return renames.get(t) ?? t;
        }),
      ),
    ];
    expect(wanted.length).toBeGreaterThan(35);
    const rows = await sql.unsafe(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const have = new Set(rows.map((r) => (r.table_name as string).toLowerCase()));
    const missing = wanted.filter((t) => !have.has(t));
    expect(missing).toEqual([]);
  });

  it('ports every column of every table', async () => {
    // Column-level parity: extract "name TYPE" pairs per table from the D1 SQL
    // (including ALTER TABLE ADD COLUMN lines) and check information_schema.
    const d1Sql = D1_FILES
      .map((f) => readFileSync(`migrations/${f}`, 'utf8'))
      .join('\n');
    const cols: Array<[string, string]> = [];
    // Same rebuild-idiom fold as the tables test above.
    const renames = new Map<string, string>();
    for (const m of d1Sql.matchAll(/ALTER TABLE (\w+) RENAME TO (\w+)/gi)) renames.set(m[1].toLowerCase(), m[2].toLowerCase());
    for (const m of d1Sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+)\s*\(([\s\S]*?)\);/gi)) {
      const table = renames.get(m[1].toLowerCase()) ?? m[1].toLowerCase();
      for (const line of m[2].split('\n')) {
        const cm = line.match(/^\s*(\w+)\s+(TEXT|INTEGER|REAL|BLOB)/i);
        if (cm && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(cm[1])) cols.push([table, cm[1].toLowerCase()]);
      }
    }
    for (const m of d1Sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/gi)) cols.push([m[1].toLowerCase(), m[2].toLowerCase()]);
    const rows = await sql.unsafe(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
    );
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = cols.filter(([t, c]) => !have.has(`${t}.${c}`)).map(([t, c]) => `${t}.${c}`);
    expect(missing).toEqual([]);
  });

  it('identity columns accept explicit ids and still autogenerate afterwards', async () => {
    // people.display_name is NOT NULL with no default, so it is supplied here
    // (the brief authorizes adjusting these INSERTs to the real schema).
    await sql.unsafe("INSERT INTO settings (key, value) VALUES ('probe', '1')");
    await sql.unsafe("INSERT INTO people (id, first_name, last_name, display_name, email) VALUES (9000, 'A', 'B', 'A B', 'probe@example.com')");
    await sql.unsafe("SELECT setval(pg_get_serial_sequence('people', 'id'), (SELECT max(id) FROM people))");
    const r = await sql.unsafe(
      "INSERT INTO people (first_name, last_name, display_name, email) VALUES ('C', 'D', 'C D', 'probe2@example.com') RETURNING id",
    );
    expect(Number(r[0].id)).toBeGreaterThan(9000);
  });
});
