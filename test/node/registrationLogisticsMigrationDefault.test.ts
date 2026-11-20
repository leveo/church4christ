import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// The last statement of 0054 (and its Postgres twin 0046) decides whether upgrading turns Event Logistics on.
const d1 = readFileSync('migrations/0054_registration_logistics.sql', 'utf8');
const pg = readFileSync('migrations-supabase/0046_registration_logistics.sql', 'utf8');
const tail = (sql: string) => sql.slice(sql.indexOf("INSERT INTO settings (key, value)\nSELECT 'module.event-logistics'"));

function database(setup: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE people (id INTEGER PRIMARY KEY);');
  db.exec(setup);
  db.exec(tail(d1));
  return db;
}

const logistics = (db: DatabaseSync) =>
  (db.prepare("SELECT value FROM settings WHERE key='module.event-logistics'").get() as { value: string } | undefined)?.value;

describe('0054 event logistics default for existing installations', () => {
  it('keeps Event Logistics off on an initialized database, Registration on or not', () => {
    expect(logistics(database("INSERT INTO settings VALUES ('module.registration','1');"))).toBe('0');
    expect(logistics(database('INSERT INTO people (id) VALUES (1);'))).toBe('0');
  });

  it('leaves a fresh database to setup and never overrides an explicit choice', () => {
    expect(logistics(database(''))).toBeUndefined();
    expect(logistics(database("INSERT INTO settings VALUES ('module.event-logistics','1');"))).toBe('1');
  });

  it('writes the same default on Postgres', () => {
    expect(tail(pg).replace('ON CONFLICT (key)', 'ON CONFLICT(key)')).toBe(tail(d1));
  });
});
