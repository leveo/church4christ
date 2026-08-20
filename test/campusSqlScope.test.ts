import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  POSTGRES_ONLY_CAMPUS_SCOPED_TABLES,
  scopeCampusSql,
  scopeDatabase,
} from '../src/lib/campusScope';
import { deleteSetting, getSetting, setSetting } from '../src/lib/settings';

const db = env.DB;
const CAMPUS = 81001;
const OTHER = 81002;

beforeEach(async () => {
  await db.prepare('DELETE FROM events WHERE campus_id >= 81000 OR campus_id = 1').run();
  await db.prepare('DELETE FROM campuses WHERE id >= 81000').run();
  await db.prepare(
    `INSERT INTO campuses (id, slug, name) VALUES
       (81001, 'sql-north', 'SQL North'),
       (81002, 'sql-south', 'SQL South')`,
  ).run();
});

describe('campus SQL transformation', () => {
  it('injects campus_id into every tuple of a multi-row INSERT', async () => {
    const scoped = scopeDatabase(db, CAMPUS);
    await scoped.prepare(
      "INSERT INTO events (starts_at) VALUES ('2026-10-01'), ('2026-10-02')",
    ).run();

    const rows = await db.prepare(
      "SELECT starts_at, campus_id FROM events WHERE starts_at LIKE '2026-10-%' ORDER BY starts_at",
    ).all<{ starts_at: string; campus_id: number }>();
    expect(rows.results).toEqual([
      { starts_at: '2026-10-01', campus_id: CAMPUS },
      { starts_at: '2026-10-02', campus_id: CAMPUS },
    ]);
  });

  it('injects campus_id into INSERT DEFAULT VALUES and INSERT SELECT', async () => {
    const scoped = scopeDatabase(db, CAMPUS);
    await scoped.prepare('INSERT INTO events DEFAULT VALUES').run();
    await scoped.prepare("INSERT INTO events (starts_at) VALUES ('2026-10-03')").run();
    await scoped.prepare(
      "INSERT INTO events (starts_at) SELECT starts_at FROM events WHERE starts_at = '2026-10-03'",
    ).run();

    const row = await db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE campus_id = ?1`,
    ).bind(CAMPUS).first<{ n: number }>();
    expect(row?.n).toBe(3);
  });

  it('preserves SELECT DISTINCT placement in an INSERT SELECT', async () => {
    const scoped = scopeDatabase(db, CAMPUS);
    await scoped.prepare("INSERT INTO events (starts_at) VALUES ('2026-10-04')").run();
    await scoped.prepare(
      `INSERT INTO events (starts_at)
       SELECT DISTINCT starts_at FROM events WHERE starts_at = '2026-10-04'`,
    ).run();
    expect(await db.prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE campus_id = ?1 AND starts_at = '2026-10-04'`,
    ).bind(CAMPUS).first('n')).toBe(2);
  });

  it('does not rewrite table-like text inside literals, quoted identifiers, or comments', () => {
    const sql = `SELECT 'FROM groups', "events" FROM events -- JOIN groups\n/* FROM sermons */`;
    const scoped = scopeCampusSql(sql, CAMPUS);
    expect(scoped).toContain(`'FROM groups'`);
    expect(scoped).toContain(`"events"`);
    expect(scoped).toContain('-- JOIN groups');
    expect(scoped).toContain('/* FROM sermons */');
    expect(scoped.match(/campus_id = 81001/g)).toHaveLength(1);
  });

  it('scopes a mutation with no WHERE and preserves RETURNING', async () => {
    const north = scopeDatabase(db, CAMPUS);
    const south = scopeDatabase(db, OTHER);
    await north.prepare("INSERT INTO events (active) VALUES (1)").run();
    await south.prepare("INSERT INTO events (active) VALUES (1)").run();

    const changed = await north.prepare(
      'UPDATE events SET active = 0 RETURNING campus_id',
    ).all<{ campus_id: number }>();
    expect(changed.results).toEqual([{ campus_id: CAMPUS }]);
    expect(await south.prepare('SELECT active FROM events').first()).toEqual({ active: 1 });
  });

  it('does not inject campus_id twice when a trusted internal statement supplies it', () => {
    const sql = 'INSERT INTO events (campus_id, starts_at) VALUES (?1, ?2)';
    expect(scopeCampusSql(sql, CAMPUS)).toBe(sql);
  });

  it('partitions every Supabase-only feature and private payment table', () => {
    expect(POSTGRES_ONLY_CAMPUS_SCOPED_TABLES).toEqual(expect.arrayContaining([
      'funds',
      'gifts',
      'reg_events',
      'registrations',
      'group_files',
      'prayer_items',
      'church_private.stripe_webhook_events',
      'church_private.stripe_checkout_requests',
    ]));
    for (const table of POSTGRES_ONLY_CAMPUS_SCOPED_TABLES) {
      expect(scopeCampusSql(`SELECT * FROM ${table}`, CAMPUS)).toContain(`campus_id = ${CAMPUS}`);
      expect(scopeCampusSql(`INSERT INTO ${table} (id) VALUES (?1)`, CAMPUS))
        .toContain('campus_id');
    }
  });

  it('reads, writes, and deletes settings independently per campus', async () => {
    await db.prepare(
      `INSERT INTO campus_settings (campus_id, key, value) VALUES
         (?1, 'site.name.en', 'SQL North'),
         (?2, 'site.name.en', 'SQL South')`,
    ).bind(CAMPUS, OTHER).run();
    const north = scopeDatabase(db, CAMPUS);
    const south = scopeDatabase(db, OTHER);

    expect(await getSetting(north, 'site.name.en')).toBe('SQL North');
    expect(await getSetting(south, 'site.name.en')).toBe('SQL South');
    await setSetting(north, 'site.name.en', 'North Updated');
    expect(await getSetting(north, 'site.name.en')).toBe('North Updated');
    expect(await getSetting(south, 'site.name.en')).toBe('SQL South');
    await deleteSetting(north, 'site.name.en');
    expect(await getSetting(north, 'site.name.en', 'missing')).toBe('missing');
    expect(await getSetting(south, 'site.name.en')).toBe('SQL South');
  });

  it('keeps the upgraded default campus compatible with the global settings store', async () => {
    await db.prepare(
      `INSERT INTO settings (key, value) VALUES ('compat.default-campus', 'legacy')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();
    const main = scopeDatabase(db, 1);
    expect(await getSetting(main, 'compat.default-campus')).toBe('legacy');
    await setSetting(main, 'compat.default-campus', 'updated');
    expect(await db.prepare(
      `SELECT value FROM settings WHERE key = 'compat.default-campus'`,
    ).first('value')).toBe('updated');
  });
});
