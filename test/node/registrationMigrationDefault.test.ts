import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// The last statement of 0050 decides whether upgrading turns Registration on.
const sql = readFileSync('migrations/0050_registration_d1.sql', 'utf8');
const statement = sql.slice(sql.indexOf("INSERT INTO settings (key, value)\nSELECT 'module.registration'"));

function database(setup: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE people (id INTEGER PRIMARY KEY);');
  db.exec(setup);
  db.exec(statement);
  return db;
}

const registration = (db: DatabaseSync) =>
  (db.prepare("SELECT value FROM settings WHERE key='module.registration'").get() as { value: string } | undefined)?.value;

describe('0050 registration default for existing installations', () => {
  it('keeps Registration off on an initialized database', () => {
    expect(registration(database("INSERT INTO settings VALUES ('module.serve','1');"))).toBe('0');
    expect(registration(database('INSERT INTO people (id) VALUES (1);'))).toBe('0');
  });

  it('leaves a fresh database to setup and never overrides an explicit choice', () => {
    expect(registration(database(''))).toBeUndefined();
    expect(registration(database("INSERT INTO settings VALUES ('module.registration','1');"))).toBe('1');
  });
});
