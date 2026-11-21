import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// The last statement of 0055/0056 (and their Postgres twins 0047/0048) decides whether upgrading turns
// Pledges or Missions on. Both must stay off on an installation that already exists.
const cases = [
  { key: 'pledges', d1: 'migrations/0055_pledges.sql', pg: 'migrations-supabase/0047_pledges.sql' },
  { key: 'missions', d1: 'migrations/0056_missions.sql', pg: 'migrations-supabase/0048_missions.sql' },
] as const;

for (const { key, d1: d1Path, pg: pgPath } of cases) {
  const d1 = readFileSync(d1Path, 'utf8');
  const pg = readFileSync(pgPath, 'utf8');
  const tail = (sql: string) => sql.slice(sql.indexOf(`INSERT INTO settings (key, value)\nSELECT 'module.${key}'`));

  function database(setup: string): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE people (id INTEGER PRIMARY KEY);');
    db.exec(setup);
    db.exec(tail(d1));
    return db;
  }
  const value = (db: DatabaseSync) =>
    (db.prepare(`SELECT value FROM settings WHERE key='module.${key}'`).get() as { value: string } | undefined)?.value;

  describe(`${d1Path} default for existing installations`, () => {
    it('keeps the module off on an initialized database', () => {
      expect(value(database("INSERT INTO settings VALUES ('module.sermons','1');"))).toBe('0');
      expect(value(database('INSERT INTO people (id) VALUES (1);'))).toBe('0');
    });

    it('leaves a fresh database to setup and never overrides an explicit choice', () => {
      expect(value(database(''))).toBeUndefined();
      expect(value(database(`INSERT INTO settings VALUES ('module.${key}','1');`))).toBe('1');
    });

    it('writes the same default on Postgres and keeps the schema twins aligned', () => {
      expect(tail(pg).replace('ON CONFLICT (key)', 'ON CONFLICT(key)')).toBe(tail(d1));
      const tables = (sql: string) => [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);
      expect(tables(pg)).toEqual(tables(d1));
    });
  });
}
