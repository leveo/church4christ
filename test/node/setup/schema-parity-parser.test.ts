import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverD1MigrationFiles,
  normalizeIndexPredicate,
  parseFinalD1Schema,
} from '../../pg/schemaParity';

function finalSchema() {
  const files = discoverD1MigrationFiles();
  return parseFinalD1Schema(files.map((file) => readFileSync(`migrations/${file}`, 'utf8')));
}

describe('final D1 schema parser', () => {
  it('normalizes Postgres atom parentheses without corrupting sibling predicates', () => {
    expect(normalizeIndexPredicate('((person_id IS NOT NULL) AND (removed_at IS NULL))')).toBe(
      'person_id is not null and removed_at is null',
    );
    expect(normalizeIndexPredicate('(lower(email) = \'member@example.test\')')).toBe(
      "lower(email) = 'member@example.test'",
    );
    expect(normalizeIndexPredicate("status = 'P'")).toBe("status = 'P'");
    expect(normalizeIndexPredicate("status = 'P'")).not.toBe(normalizeIndexPredicate("status = 'p'"));
    expect(normalizeIndexPredicate("note = '(x)'  AND  kind = 'a::text  b'")).toBe(
      "note = '(x)' and kind = 'a::text  b'",
    );
    expect(normalizeIndexPredicate("note = '(x)' ")).not.toBe(normalizeIndexPredicate("note = 'x'"));
  });

  it('discovers every lowercase SQL migration in lexical order, including newly added files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd1-migrations-'));
    writeFileSync(join(directory, '0002_second.sql'), 'ALTER TABLE example ADD COLUMN added TEXT;');
    writeFileSync(join(directory, '0001_first.sql'), 'CREATE TABLE example (id INTEGER PRIMARY KEY);');
    writeFileSync(join(directory, '9999_new.sql'), 'CREATE INDEX idx_example_added ON example (added);');
    writeFileSync(join(directory, 'notes.txt'), 'not a migration');

    const files = discoverD1MigrationFiles(directory);
    expect(files).toEqual(['0001_first.sql', '0002_second.sql', '9999_new.sql']);

    const schema = parseFinalD1Schema(
      files.map((file) => readFileSync(join(directory, file), 'utf8')),
    );
    expect(schema.tables.get('example')?.columns.has('added')).toBe(true);
    expect(schema.indexes.has('idx_example_added')).toBe(true);
  });

  it('applies ALTER ADD and table rebuilds in migration order', () => {
    const schema = finalSchema();

    expect(schema.tables.size).toBeGreaterThan(40);
    expect(schema.tables.has('revisions_new')).toBe(false);
    expect(schema.tables.has('tokens_new')).toBe(false);
    expect(schema.tables.get('people')?.columns.get('finance')).toMatchObject({
      type: 'integer',
      nullable: false,
      defaultValue: '0',
    });
    expect(schema.tables.get('custom_pages')?.columns.get('format')).toMatchObject({
      type: 'text',
      nullable: false,
      defaultValue: 'markdown',
    });
  });

  it('captures normalized keys, foreign targets, and application indexes', () => {
    const schema = finalSchema();
    const ministryI18n = schema.tables.get('ministry_i18n');
    const teamMembers = schema.tables.get('team_members');
    const checkins = schema.tables.get('checkins');

    expect(ministryI18n?.constraints).toContainEqual({
      kind: 'primary',
      columns: ['ministry_id', 'locale'],
    });
    expect(teamMembers?.constraints).toContainEqual({
      kind: 'unique',
      columns: ['team_id', 'person_id'],
    });
    expect(checkins?.constraints).toContainEqual({
      kind: 'foreign',
      columns: ['household_member_id'],
      foreignTable: 'household_members',
      foreignColumns: ['id'],
    });
    expect(schema.indexes.get('idx_app_pending_unique')).toEqual({
      name: 'idx_app_pending_unique',
      table: 'team_applications',
      columns: ['person_id', 'team_id'],
      unique: true,
      predicate: "status = 'P'",
    });
  });

  it('fails closed when schema DDL contains an unsupported column type', () => {
    expect(() => parseFinalD1Schema(['CREATE TABLE example (id INTEGER PRIMARY KEY, payload JSON);'])).toThrow(
      /unsupported table entry.*payload JSON/i,
    );
  });

  it('fails closed on unsupported table mutations', () => {
    expect(() =>
      parseFinalD1Schema([
        'CREATE TABLE example (id INTEGER PRIMARY KEY); ALTER TABLE example DROP COLUMN id;',
      ]),
    ).toThrow(/unsupported schema DDL.*DROP COLUMN/i);
  });

  it('applies DROP INDEX and DROP INDEX IF EXISTS in migration order', () => {
    const schema = parseFinalD1Schema([
      [
        'CREATE TABLE example (id INTEGER PRIMARY KEY, name TEXT);',
        'CREATE INDEX idx_keep ON example (name);',
        'CREATE INDEX idx_remove ON example (name);',
        'DROP INDEX idx_remove;',
        'DROP INDEX IF EXISTS idx_already_absent;',
      ].join('\n'),
    ]);

    expect([...schema.indexes.keys()]).toEqual(['idx_keep']);
  });

  it.each([
    'CREATE VIEW example_view AS SELECT 1',
    'ALTER INDEX idx_example RENAME TO idx_other',
    'DROP TRIGGER example_trigger',
  ])('fails closed on unknown schema-affecting DDL: %s', (statement) => {
    expect(() => parseFinalD1Schema([`${statement};`])).toThrow(/unsupported schema DDL/i);
  });
});
