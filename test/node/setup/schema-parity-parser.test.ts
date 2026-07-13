import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFinalD1Schema } from '../../pg/schemaParity';

const files = [
  '0001_init.sql',
  '0002_email.sql',
  '0003_people.sql',
  '0004_giving_people.sql',
  '0005_custom_pages.sql',
  '0006_children_checkin.sql',
  '0007_page_builder.sql',
  '0008_member_portal.sql',
];

function finalSchema() {
  return parseFinalD1Schema(files.map((file) => readFileSync(`migrations/${file}`, 'utf8')));
}

describe('final D1 schema parser', () => {
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
});
