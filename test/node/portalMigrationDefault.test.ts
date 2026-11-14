import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// The last statement of 0039 decides whether upgrading turns the portal on.
const sql = readFileSync('migrations/0039_member_portal_d1.sql', 'utf8');
const statement = sql.slice(sql.indexOf("INSERT INTO settings (key, value)\nSELECT 'module.portal'"));

function database(setup: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE people (id INTEGER PRIMARY KEY);');
  db.exec(setup);
  db.exec(statement);
  return db;
}

const portal = (db: DatabaseSync) =>
  (db.prepare("SELECT value FROM settings WHERE key='module.portal'").get() as { value: string } | undefined)?.value;

describe('0039 portal default for existing installations', () => {
  it('keeps the portal off on an initialized database', () => {
    expect(portal(database("INSERT INTO settings VALUES ('module.serve','1');"))).toBe('0');
    expect(portal(database('INSERT INTO people (id) VALUES (1);'))).toBe('0');
  });

  it('leaves a fresh database to setup and never overrides an explicit choice', () => {
    expect(portal(database(''))).toBeUndefined();
    expect(portal(database("INSERT INTO settings VALUES ('module.portal','1');"))).toBe('1');
  });
});
