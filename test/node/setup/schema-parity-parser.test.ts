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
      "lower(email)='member@example.test'",
    );
    expect(normalizeIndexPredicate("status = 'P'")).toBe("status='P'");
    expect(normalizeIndexPredicate("status = 'P'")).not.toBe(normalizeIndexPredicate("status = 'p'"));
    expect(normalizeIndexPredicate("note = '(x)'  AND  kind = 'a::text  b'")).toBe(
      "note='(x)' and kind='a::text  b'",
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

  it('distinguishes rowid identity from application-managed WITHOUT ROWID primary keys', () => {
    const schema = parseFinalD1Schema([
      [
        'CREATE TABLE generated (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
        'CREATE TABLE managed (id INTEGER PRIMARY KEY, name TEXT NOT NULL) WITHOUT ROWID;',
      ].join('\n'),
    ]);

    expect(schema.tables.get('generated')?.columns.get('id')?.identity).toBe(true);
    expect(schema.tables.get('managed')?.columns.get('id')?.identity).toBe(false);
  });

  it('does not confuse a nullable date CHECK with a column NOT NULL constraint', () => {
    const schema = finalSchema();
    expect(schema.tables.get('service_type_checkin_events')?.columns.get('ends_on')).toMatchObject({
      nullable: true,
      type: 'text',
    });
  });

  it('recognizes NOT NULL only at column-tail depth zero', () => {
    const schema = parseFinalD1Schema([
      `CREATE TABLE checked_nullable (
        id INTEGER PRIMARY KEY,
        value TEXT CHECK (value IS NULL OR length(value) IS NOT NULL),
        required TEXT NOT NULL CHECK (required IS NOT NULL)
      );`,
    ]);
    expect(schema.tables.get('checked_nullable')?.columns.get('value')?.nullable).toBe(true);
    expect(schema.tables.get('checked_nullable')?.columns.get('required')?.nullable).toBe(false);
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
      onDelete: 'no action',
      onUpdate: 'no action',
    });
    expect(schema.indexes.get('idx_app_pending_unique')).toEqual({
      name: 'idx_app_pending_unique',
      table: 'team_applications',
      columns: ['person_id', 'team_id'],
      unique: true,
      predicate: "status = 'P'",
    });
  });

  it('models inline and table-level foreign-key update/delete actions', () => {
    const schema = parseFinalD1Schema([
      `CREATE TABLE parents (id INTEGER PRIMARY KEY);
       CREATE TABLE children (
         id INTEGER PRIMARY KEY,
         inline_parent_id INTEGER REFERENCES parents(id) ON DELETE CASCADE ON UPDATE RESTRICT,
         table_parent_id INTEGER,
         FOREIGN KEY (table_parent_id) REFERENCES parents(id) ON DELETE SET NULL ON UPDATE SET DEFAULT
       );`,
    ]);

    expect(schema.tables.get('children')?.constraints).toEqual(expect.arrayContaining([
      {
        kind: 'foreign',
        columns: ['inline_parent_id'],
        foreignTable: 'parents',
        foreignColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'restrict',
      },
      {
        kind: 'foreign',
        columns: ['table_parent_id'],
        foreignTable: 'parents',
        foreignColumns: ['id'],
        onDelete: 'set null',
        onUpdate: 'set default',
      },
    ]));
  });

  it('ignores quoted, commented, and nested fake foreign-key actions', () => {
    const schema = parseFinalD1Schema([
      `CREATE TABLE parents (id INTEGER PRIMARY KEY);
       CREATE TABLE children (
         id INTEGER PRIMARY KEY,
         inline_parent_id INTEGER REFERENCES parents(id)
           CHECK (
             inline_parent_id <> 'ON DELETE CASCADE' AND
             inline_parent_id <> 'it''s ON UPDATE SET NULL' AND
             "ON DELETE SET DEFAULT" <> 'quoted identifier'
           )
           /* ON DELETE RESTRICT */,
         table_parent_id INTEGER,
         real_parent_id INTEGER REFERENCES parents(id)
           ON DELETE CASCADE /* ON UPDATE SET NULL */ ON UPDATE RESTRICT,
         FOREIGN KEY (table_parent_id) REFERENCES parents(id)
           /* ON DELETE CASCADE */
           -- ON UPDATE SET DEFAULT
       );`,
    ]);

    expect(schema.tables.get('children')?.constraints).toEqual(expect.arrayContaining([
      {
        kind: 'foreign',
        columns: ['inline_parent_id'],
        foreignTable: 'parents',
        foreignColumns: ['id'],
        onDelete: 'no action',
        onUpdate: 'no action',
      },
      {
        kind: 'foreign',
        columns: ['table_parent_id'],
        foreignTable: 'parents',
        foreignColumns: ['id'],
        onDelete: 'no action',
        onUpdate: 'no action',
      },
      {
        kind: 'foreign',
        columns: ['real_parent_id'],
        foreignTable: 'parents',
        foreignColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'restrict',
      },
    ]));
  });

  it('models trigger metadata, WHEN guards, and abort body semantics instead of stripping them', () => {
    const schema = parseFinalD1Schema([
      `CREATE TABLE protected_rows (id INTEGER PRIMARY KEY, fixed INTEGER NOT NULL);
       CREATE TRIGGER protected_rows_fixed_insert
       BEFORE INSERT ON protected_rows
       WHEN NEW.fixed <> 0
       BEGIN
         SELECT RAISE(ABORT, 'protected_rows_fixed');
       END;
       CREATE TRIGGER protected_rows_no_delete
       BEFORE DELETE ON protected_rows
       BEGIN
         SELECT CASE WHEN OLD.fixed = 1
           THEN RAISE(ABORT, 'protected_rows_immutable') END;
       END;`,
    ]);

    expect([...schema.triggers.values()]).toEqual([
      {
        name: 'protected_rows_fixed_insert',
        table: 'protected_rows',
        timing: 'before',
        event: 'insert',
        when: 'new.fixed <> 0',
        bodyGuard: null,
        semanticGuard: 'new . fixed <> 0',
        abortMessage: 'protected_rows_fixed',
      },
      {
        name: 'protected_rows_no_delete',
        table: 'protected_rows',
        timing: 'before',
        event: 'delete',
        when: null,
        bodyGuard: 'old.fixed = 1',
        semanticGuard: 'old . fixed = 1',
        abortMessage: 'protected_rows_immutable',
      },
    ]);
  });

  it('models every actual D1 trigger, including guarded service-attendance and newcomer bodies', () => {
    const schema = finalSchema();
    expect([...schema.triggers.keys()]).toEqual([
      'service_checkin_links_no_overlap_insert',
      'service_checkin_links_close_only',
      'service_checkin_links_no_delete',
      'newcomer_statuses_boundary_insert',
      'newcomer_statuses_boundary_update',
      'newcomer_statuses_core_delete',
      'newcomer_fields_boundary_insert',
      'newcomer_fields_boundary_update',
      'newcomer_fields_core_delete',
      'newcomer_field_options_custom_insert',
      'newcomer_field_options_custom_update',
      'newcomer_answers_custom_insert',
      'newcomer_answers_custom_update',
      'learning_activities_no_delete',
      'learning_activity_events_no_update',
      'learning_activity_events_no_delete',
    ]);
    expect(schema.triggers.get('service_checkin_links_no_overlap_insert')).toMatchObject({
      table: 'service_type_checkin_events',
      timing: 'before',
      event: 'insert',
      when: 'new.ends_on is null or new.ends_on > new.starts_on',
      abortMessage: 'service_attendance_link_conflict',
    });
    expect(schema.triggers.get('service_checkin_links_no_overlap_insert')?.semanticGuard)
      .toMatch(/^\( new \. ends_on is null or new \. ends_on > new \. starts_on \) and \( exists \(/);
    expect(schema.triggers.get('service_checkin_links_no_overlap_insert')?.bodyGuard)
      .toMatch(/^exists \( select 1 from service_type_checkin_events existing where /);
    const newcomerGuards = Object.fromEntries(
      [...schema.triggers]
        .filter(([name]) => name.startsWith('newcomer_'))
        .map(([name, trigger]) => [name, trigger.semanticGuard]),
    );
    const customField = "new . id > 7 and new . key not in ( 'name' , 'email' , 'phone' , 'preferred_language' , 'visit_date' , 'service_type' , 'contact_consent' ) and new . fixed = 0";
    const boundaryUpdate = `not ( ${[
      "( new . id = 1 and new . key = 'name' and new . type = 'text' and new . required = 0 and new . active = 1 and new . fixed = 1 )",
      "( new . id = 2 and new . key = 'email' and new . type = 'text' and new . required = 0 and new . active = 1 and new . fixed = 1 )",
      "( new . id = 3 and new . key = 'phone' and new . type = 'text' and new . required = 0 and new . active = 1 and new . fixed = 1 )",
      "( new . id = 4 and new . key = 'preferred_language' and new . type = 'select' and new . required = 0 and new . active = 1 and new . fixed = 1 )",
      "( new . id = 5 and new . key = 'visit_date' and new . type = 'text' and new . required = 0 and new . active = 1 and new . fixed = 1 )",
      "( new . id = 6 and new . key = 'service_type' and new . type = 'select' and new . required = 0 and new . active = 1 and new . fixed = 1 )",
      "( new . id = 7 and new . key = 'contact_consent' and new . type = 'checkbox' and new . required = 0 and new . active = 1 and new . fixed = 1 )",
      `( ${customField} )`,
    ].join(' or ')} )`;
    const customValueGuard = 'exists ( select 1 from newcomer_fields where id = new . field_id and fixed = 1 )';
    expect(newcomerGuards).toEqual({
      newcomer_statuses_boundary_insert: `not ( ( new . id = 1 and new . key = 'new' ) or ( new . id = 2 and new . key = 'assigned' ) or ( new . id = 3 and new . key = 'contacted' ) or ( new . id = 4 and new . key = 'connected' ) or ( new . id = 5 and new . key = 'closed' ) or ( new . id > 5 and new . key not in ( 'new' , 'assigned' , 'contacted' , 'connected' , 'closed' ) ) )`,
      newcomer_statuses_boundary_update: `not ( new . id = old . id and new . key = old . key and new . category = old . category )`,
      newcomer_statuses_core_delete: 'old . id <= 5',
      newcomer_fields_boundary_insert: `not ( ${customField} )`,
      newcomer_fields_boundary_update: boundaryUpdate,
      newcomer_fields_core_delete: 'old . fixed = 1',
      newcomer_field_options_custom_insert: customValueGuard,
      newcomer_field_options_custom_update: customValueGuard,
      newcomer_answers_custom_insert: customValueGuard,
      newcomer_answers_custom_update: customValueGuard,
    });
    expect(schema.triggers.get('learning_activity_events_no_update')).toMatchObject({
      table: 'learning_activity_events',
      timing: 'before',
      semanticGuard: 'true',
      abortMessage: 'learning_event_append_only',
    });
    expect(schema.triggers.get('learning_activity_events_no_delete')).toMatchObject({
      table: 'learning_activity_events',
      timing: 'before',
      abortMessage: 'learning_event_append_only',
    });
    expect(schema.triggers.get('learning_activity_events_no_delete')?.semanticGuard)
      .toMatch(/exists \( select 1 from people.*and exists \( select 1 from learning_identity_links.*and exists \( select 1 from learning_enrollments.*and exists \( select 1 from learning_courses.*and exists \( select 1 from learning_provider_connections/);
    expect(schema.triggers.get('learning_activities_no_delete')).toMatchObject({
      table: 'learning_activities',
      timing: 'before',
      event: 'delete',
      abortMessage: 'learning_activity_active_parent',
    });
    expect(schema.triggers.get('learning_activities_no_delete')?.semanticGuard)
      .toMatch(/exists \( select 1 from learning_courses.*and exists \( select 1 from learning_provider_connections/);
  });

  it('fails closed on unsupported trigger bodies and duplicate trigger names', () => {
    expect(() => parseFinalD1Schema([
      `CREATE TABLE example (id INTEGER PRIMARY KEY);
       CREATE TRIGGER example_log AFTER INSERT ON example BEGIN INSERT INTO example VALUES (2); END;`,
    ])).toThrow(/unsupported trigger body/i);
    expect(() => parseFinalD1Schema([
      `CREATE TABLE example (id INTEGER PRIMARY KEY);
       CREATE TRIGGER duplicate BEFORE DELETE ON example BEGIN SELECT RAISE(ABORT, 'one'); END;
       CREATE TRIGGER duplicate BEFORE DELETE ON example BEGIN SELECT RAISE(ABORT, 'two'); END;`,
    ])).toThrow(/duplicate trigger/i);
  });

  it('applies create, drop, and recreate trigger statements in migration order', () => {
    const schema = parseFinalD1Schema([
      `CREATE TABLE protected_rows (id INTEGER PRIMARY KEY, fixed INTEGER NOT NULL);
       CREATE TRIGGER protected_rows_guard BEFORE INSERT ON protected_rows
       WHEN NEW.fixed = 1 BEGIN SELECT RAISE(ABORT, 'first_guard'); END;
       DROP TRIGGER protected_rows_guard;
       CREATE TRIGGER protected_rows_guard BEFORE INSERT ON protected_rows
       WHEN NEW.fixed = 0 BEGIN SELECT RAISE(ABORT, 'replacement_guard'); END;`,
    ]);

    expect(schema.triggers.get('protected_rows_guard')).toMatchObject({
      table: 'protected_rows',
      semanticGuard: 'new . fixed = 0',
      abortMessage: 'replacement_guard',
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
  ])('fails closed on unknown schema-affecting DDL: %s', (statement) => {
    expect(() => parseFinalD1Schema([`${statement};`])).toThrow(/unsupported schema DDL/i);
  });

  it('fails closed when dropping a missing trigger', () => {
    expect(() => parseFinalD1Schema(['DROP TRIGGER example_trigger;']))
      .toThrow(/cannot drop missing trigger example_trigger/i);
  });
});
