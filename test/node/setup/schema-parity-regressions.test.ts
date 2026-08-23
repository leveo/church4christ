import { describe, expect, it } from 'vitest';
import { parseFinalD1Schema } from '../../pg/schemaParity';

describe('schema parity regression boundaries', () => {
  it('does not classify foreign-key or singleton integer primary keys as generated identities', () => {
    const schema = parseFinalD1Schema([
      `CREATE TABLE parents (id INTEGER PRIMARY KEY);
       CREATE TABLE owned (
         parent_id INTEGER PRIMARY KEY REFERENCES parents(id)
       );
       CREATE TABLE singleton (
         singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1)
       );`,
    ]);

    expect(schema.tables.get('parents')?.columns.get('id')?.identity).toBe(true);
    expect(schema.tables.get('owned')?.columns.get('parent_id')?.identity).toBe(false);
    expect(schema.tables.get('singleton')?.columns.get('singleton_id')?.identity).toBe(false);
  });

  it('retains an application-significant descending index direction', () => {
    const schema = parseFinalD1Schema([
      `CREATE TABLE queue (id INTEGER PRIMARY KEY, score INTEGER NOT NULL);
       CREATE INDEX idx_queue_score ON queue (score DESC);`,
    ]);

    expect(schema.indexes.get('idx_queue_score')?.columns).toEqual(['score desc']);
  });
});
