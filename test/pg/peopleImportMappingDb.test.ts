import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PEOPLE_IMPORT_HEADERS, type PeopleImportHeader } from '../../src/lib/peopleImport';
import {
  PeopleImportMappingConflictError,
  PeopleImportMappingStructuralError,
  createPeopleImportMapping,
  getPeopleImportMapping,
  listPeopleImportMappings,
  type CreatePeopleImportMappingInput,
} from '../../src/lib/peopleImportMappingDb';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const fieldMappings = (overrides: Partial<Record<PeopleImportHeader, number | null>> = {}) =>
  Object.fromEntries(PEOPLE_IMPORT_HEADERS.map((header) => [
    header,
    overrides[header] ?? null,
  ])) as Record<PeopleImportHeader, number | null>;

const validInput = (name: string): CreatePeopleImportMappingInput => ({
  name,
  expectedHeaders: ['full name', 'email address', 'member kind', 'currently active'],
  fieldMappings: fieldMappings({ display_name: 0, email: 1, record_type: 2, active: 3 }),
  constants: { language: 'en' },
  enumTranslations: {
    record_type: { member: 'person', child: 'dependent' },
    active: { yes: 'true', no: 'false' },
  },
  createdByPersonId: 9800,
});

describe.skipIf(!hasPg)('people import mapping profiles (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const db = new PgAdapter(sql);

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
  });

  beforeEach(async () => {
    await sql.unsafe('TRUNCATE people_import_mappings, people RESTART IDENTITY CASCADE');
    await sql.unsafe(`
      INSERT INTO people (id, display_name, email, role, active)
      VALUES (9800, 'Mapping Creator', 'mapping-creator@example.com', 'admin', 1)
    `);
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('migrates explicit integer slots, JSON TEXT checks, unique name identity, and creator FK', async () => {
    const columns = await sql.unsafe<{
      column_name: string;
      data_type: string;
      is_identity: string;
    }[]>(`
      SELECT column_name, data_type, is_identity
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'people_import_mappings'
      ORDER BY ordinal_position
    `);
    expect(columns.map((column) => column.column_name)).toEqual([
      'id',
      'name',
      'name_key',
      'version',
      'expected_headers_json',
      'field_mappings_json',
      'constants_json',
      'enum_translations_json',
      'created_by_person_id',
      'created_at',
    ]);
    expect(columns[0]).toMatchObject({ data_type: 'integer', is_identity: 'NO' });

    const constraints = await sql.unsafe<{ definition: string }[]>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'people_import_mappings'::regclass
      ORDER BY conname
    `);
    const ddl = constraints.map((row) => row.definition).join('\n');
    expect(ddl).toMatch(/id\s*>=\s*1[\s\S]*id\s*<=\s*100/i);
    expect(ddl).toContain('FOREIGN KEY (created_by_person_id) REFERENCES people(id)');
    expect(ddl).toMatch(/version\s*=\s*1/i);
    expect(ddl).toMatch(/jsonb_typeof\(\(expected_headers_json\)::jsonb\) = 'array'/i);
    expect(ddl).toMatch(/jsonb_typeof\(\(field_mappings_json\)::jsonb\) = 'object'/i);

    await expect(sql.unsafe(`
      INSERT INTO people_import_mappings
        (id, name, name_key, expected_headers_json, field_mappings_json,
         constants_json, enum_translations_json, created_by_person_id)
      VALUES (1, 'Bad', 'bad', '{}', '{}', '{}', '{}', 9800)
    `)).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe(`
      INSERT INTO people_import_mappings
        (id, name, name_key, expected_headers_json, field_mappings_json,
         constants_json, enum_translations_json, created_by_person_id)
      VALUES (1, 'Bad', 'bad', '["header"]', '{}', '{}', '{}', 999999)
    `)).rejects.toMatchObject({ code: '23503' });
  });

  it('creates byte-equivalent JSON and returns the same immutable list/get contract as D1', async () => {
    const created = await createPeopleImportMapping(db, validInput('  Bre\u0301eze Profile  '));
    const loaded = await getPeopleImportMapping(db, created.id);
    const list = await listPeopleImportMappings(db);
    const [raw] = await sql.unsafe<Record<string, unknown>[]>(
      'SELECT * FROM people_import_mappings WHERE id = 1',
    );

    expect(created).toEqual(loaded);
    expect(created).toMatchObject({ id: 1, name: 'Bréeze Profile', nameKey: 'bréeze profile', version: 1 });
    expect(list).toEqual([{
      id: 1,
      name: 'Bréeze Profile',
      version: 1,
      createdByPersonId: 9800,
      createdAt: created.createdAt,
    }]);
    expect(raw).toMatchObject({
      expected_headers_json: '["full name","email address","member kind","currently active"]',
      constants_json: '{"language":"en"}',
    });
  });

  it('allows one of two concurrent requests into slot 100 and never exceeds the ceiling', async () => {
    const mappingJson = JSON.stringify(fieldMappings());
    for (let index = 1; index <= 99; index += 1) {
      await sql.unsafe(`
        INSERT INTO people_import_mappings
          (id, name, name_key, expected_headers_json, field_mappings_json,
           constants_json, enum_translations_json, created_by_person_id)
        VALUES ($1, $2, $3, '["header"]', $4, '{}', '{}', 9800)
      `, [index, `Profile ${index}`, `profile ${index}`, mappingJson]);
    }

    const results = await Promise.allSettled([
      createPeopleImportMapping(db, validInput('Final Alpha')),
      createPeopleImportMapping(db, validInput('Final Beta')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'mapping_profile_conflict' }),
    });
    const [{ count }] = await sql.unsafe<{ count: string }[]>(
      'SELECT COUNT(*) AS count FROM people_import_mappings',
    );
    expect(Number(count)).toBe(100);

    const full = await createPeopleImportMapping(db, validInput('Profile 101'))
      .catch((caught: unknown) => caught);
    expect(full).toBeInstanceOf(PeopleImportMappingConflictError);
    expect(full).toMatchObject({ code: 'mapping_profile_conflict', message: 'Mapping profile conflicts' });
  });

  it('maps internally corrupt JSON to the same PII-free structural error', async () => {
    await sql.unsafe(`
      INSERT INTO people_import_mappings
        (id, name, name_key, expected_headers_json, field_mappings_json,
         constants_json, enum_translations_json, created_by_person_id)
      VALUES (1, 'Corrupt', 'corrupt', '["private-header"]',
        '{"record_type":0}', '{"language":"PRIVATE VALUE"}', '{}', 9800)
    `);

    for (const operation of [
      () => getPeopleImportMapping(db, 1),
      () => listPeopleImportMappings(db),
    ]) {
      const error = await operation().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PeopleImportMappingStructuralError);
      expect(error).toMatchObject({
        code: 'mapping_profile_corrupt',
        message: 'Mapping profile data is corrupt',
      });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/private|record_type|language/i);
    }
  });
});
