import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PEOPLE_IMPORT_HEADERS, type PeopleImportHeader } from '../src/lib/peopleImport';
import {
  PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS,
  PeopleImportMappingConflictError,
  PeopleImportMappingInvalidError,
  PeopleImportMappingStructuralError,
  createPeopleImportMapping,
  getPeopleImportMapping,
  listPeopleImportMappings,
  type CreatePeopleImportMappingInput,
} from '../src/lib/peopleImportMappingDb';

const fieldMappings = (overrides: Partial<Record<PeopleImportHeader, number | null>> = {}) =>
  Object.fromEntries(PEOPLE_IMPORT_HEADERS.map((header) => [
    header,
    overrides[header] ?? null,
  ])) as Record<PeopleImportHeader, number | null>;

const validInput = (overrides: Partial<CreatePeopleImportMappingInput> = {}): CreatePeopleImportMappingInput => ({
  name: ' Breeze Profile ',
  expectedHeaders: ['full name', 'email address', 'member kind', 'currently active'],
  fieldMappings: fieldMappings({ display_name: 0, email: 1, record_type: 2, active: 3 }),
  constants: { language: 'en' },
  enumTranslations: {
    record_type: { member: 'person', child: 'dependent' },
    active: { yes: 'true', no: 'false' },
  },
  createdByPersonId: 9800,
  ...overrides,
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM people_import_mappings').run();
  await env.DB.prepare(`
    INSERT OR REPLACE INTO people (id, display_name, email, role, active, deleted_at)
    VALUES (9800, 'Mapping Creator', 'mapping-creator@example.com', 'admin', 1, NULL)
  `).run();
});

describe('people import mapping profile schema', () => {
  it('stores immutable v1 JSON contracts with bounded top-level shapes and creator provenance', async () => {
    const columns = await env.DB.prepare(
      'PRAGMA table_info(people_import_mappings)',
    ).all<{ name: string; type: string; notnull: number; pk: number }>();

    expect(columns.results.map((column) => [column.name, column.type, column.notnull, column.pk]))
      .toEqual([
        ['id', 'INTEGER', 1, 1],
        ['name', 'TEXT', 1, 0],
        ['name_key', 'TEXT', 1, 0],
        ['version', 'INTEGER', 1, 0],
        ['expected_headers_json', 'TEXT', 1, 0],
        ['field_mappings_json', 'TEXT', 1, 0],
        ['constants_json', 'TEXT', 1, 0],
        ['enum_translations_json', 'TEXT', 1, 0],
        ['created_by_person_id', 'INTEGER', 1, 0],
        ['created_at', 'TEXT', 1, 0],
      ]);

    const table = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'people_import_mappings'",
    ).first<{ sql: string }>();
    expect(table?.sql).toMatch(/WITHOUT\s+ROWID\s*$/i);
    expect(table?.sql).toMatch(/CHECK\s*\(\s*id\s+BETWEEN\s+1\s+AND\s+100\s*\)/i);
    expect(table?.sql).toMatch(/CHECK\s*\(\s*version\s*=\s*1\s*\)/i);
    expect(table?.sql).toMatch(/json_valid\s*\(\s*expected_headers_json\s*\)/i);
    expect(table?.sql).toMatch(/json_type\s*\(\s*expected_headers_json\s*\)\s*=\s*'array'/i);
    for (const column of ['field_mappings_json', 'constants_json', 'enum_translations_json']) {
      expect(table?.sql).toMatch(new RegExp(`json_type\\s*\\(\\s*${column}\\s*\\)\\s*=\\s*'object'`, 'i'));
    }
    expect(table?.sql).toMatch(/length\s*\(\s*name\s*\)\s+BETWEEN\s+1\s+AND\s+80/i);
    expect(table?.sql).toMatch(/length\s*\(\s*expected_headers_json\s*\)\s+BETWEEN\s+2\s+AND\s+65536/i);

    const indexes = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'people_import_mappings' ORDER BY name",
    ).all<{ name: string; sql: string | null }>();
    expect(indexes.results.map((index) => index.name)).toContain('idx_people_import_mappings_created');
    expect(indexes.results.some((index) => index.sql?.includes('(name_key)'))).toBe(true);

    const foreignKeys = await env.DB.prepare(
      'PRAGMA foreign_key_list(people_import_mappings)',
    ).all<{ table: string; from: string; to: string }>();
    expect(foreignKeys.results).toContainEqual(expect.objectContaining({
      table: 'people',
      from: 'created_by_person_id',
      to: 'id',
    }));
  });

  it('rejects malformed JSON, wrong top-level shapes, wrong version, and missing creators', async () => {
    const canonical: readonly unknown[] = [
      1,
      'Schema Probe',
      'schema probe',
      1,
      '["header"]',
      '{}',
      '{}',
      '{}',
      9800,
    ];
    const insert = (values: readonly unknown[]) => env.DB.prepare(`
      INSERT INTO people_import_mappings
        (id, name, name_key, version, expected_headers_json, field_mappings_json,
         constants_json, enum_translations_json, created_by_person_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...values).run();
    const insertWithoutId = () => env.DB.prepare(`
      INSERT INTO people_import_mappings
        (name, name_key, version, expected_headers_json, field_mappings_json,
         constants_json, enum_translations_json, created_by_person_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...canonical.slice(1)).run();

    await expect(insertWithoutId()).rejects.toThrow();
    await expect(insert(canonical.with(3, 2))).rejects.toThrow();
    await expect(insert(canonical.with(4, '{}'))).rejects.toThrow();
    await expect(insert(canonical.with(5, '[]'))).rejects.toThrow();
    await expect(insert(canonical.with(6, 'not-json'))).rejects.toThrow();
    await expect(insert(canonical.with(7, '[]'))).rejects.toThrow();
    await expect(insert(canonical.with(8, 999999))).rejects.toThrow();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people_import_mappings')
      .first<number>('n')).toBe(0);
  });
});

describe('people import mapping profile persistence', () => {
  it('creates, lists, and gets an immutable detached v1 profile with canonical name identity', async () => {
    const created = await createPeopleImportMapping(env.DB, validInput({
      name: '  Bre\u0301eze Profile  ',
    }));

    expect(created).toMatchObject({
      id: 1,
      name: 'Bréeze Profile',
      nameKey: 'bréeze profile',
      version: 1,
      createdByPersonId: 9800,
    });
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(created.expectedHeaders).toEqual(['full name', 'email address', 'member kind', 'currently active']);
    expect(Object.keys(created.fieldMappings)).toEqual([...PEOPLE_IMPORT_HEADERS]);
    expect(created.constants).toEqual({ language: 'en' });
    expect(created.enumTranslations).toEqual({
      record_type: { member: 'person', child: 'dependent' },
      active: { yes: 'true', no: 'false' },
    });

    expect(Object.isFrozen(created.expectedHeaders)).toBe(true);
    expect(Object.isFrozen(created.fieldMappings)).toBe(true);
    expect(Object.isFrozen(created.constants)).toBe(true);
    expect(Object.isFrozen(created.enumTranslations)).toBe(true);
    expect(() => { created.expectedHeaders[0] = 'mutated'; }).toThrow(TypeError);
    expect(() => { created.constants.language = 'zh'; }).toThrow(TypeError);
    const loaded = await getPeopleImportMapping(env.DB, created.id);
    expect(loaded?.expectedHeaders[0]).toBe('full name');
    expect(loaded?.constants.language).toBe('en');
    expect(await getPeopleImportMapping(env.DB, 999)).toBeNull();
    expect(await listPeopleImportMappings(env.DB)).toEqual([{
      id: 1,
      name: created.name,
      version: 1,
      createdByPersonId: 9800,
      createdAt: created.createdAt,
    }]);

    const raw = await env.DB.prepare('SELECT * FROM people_import_mappings WHERE id = 1')
      .first<Record<string, unknown>>();
    expect(raw).toMatchObject({
      name: created.name,
      name_key: created.nameKey,
      version: 1,
      expected_headers_json: '["full name","email address","member kind","currently active"]',
    });
    expect(JSON.stringify(raw)).not.toMatch(/sample|sourceRows|mapping-creator@example/i);
  });

  it('round-trips own constructor and __proto__ translation keys', async () => {
    const translations = Object.create(null) as Record<string, string>;
    Object.defineProperty(translations, 'constructor', {
      value: 'person',
      enumerable: true,
    });
    Object.defineProperty(translations, '__proto__', {
      value: 'dependent',
      enumerable: true,
    });

    const created = await createPeopleImportMapping(env.DB, validInput({
      enumTranslations: { record_type: translations },
    }));
    const loaded = await getPeopleImportMapping(env.DB, created.id);

    for (const profile of [created, loaded]) {
      const recordType = profile?.enumTranslations.record_type;
      expect(recordType && Object.hasOwn(recordType, 'constructor')).toBe(true);
      expect(recordType && Object.hasOwn(recordType, '__proto__')).toBe(true);
      expect(recordType?.constructor).toBe('person');
      expect(recordType?.__proto__).toBe('dependent');
    }
    const raw = await env.DB.prepare(
      'SELECT enum_translations_json FROM people_import_mappings WHERE id = ?',
    ).bind(created.id).first<string>('enum_translations_json');
    expect(raw).toBe('{"record_type":{"constructor":"person","__proto__":"dependent"}}');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people_import_mappings')
      .first<number>('n')).toBe(1);
  });

  it('rejects sparse expected headers before the DB snapshot attempts to expand them', async () => {
    const sparseHeaders = new Array(1_000_000_000) as string[];
    const arrayFrom = vi.spyOn(Array, 'from').mockImplementation(() => {
      throw new Error('must reject before expanding a sparse array');
    });
    let error: unknown;
    let expansionAttempts = -1;

    try {
      error = await createPeopleImportMapping(env.DB, validInput({
        expectedHeaders: sparseHeaders,
      })).catch((caught: unknown) => caught);
      expansionAttempts = arrayFrom.mock.calls.length;
    } finally {
      arrayFrom.mockRestore();
    }
    expect(error).toBeInstanceOf(PeopleImportMappingInvalidError);
    expect(expansionAttempts).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people_import_mappings')
      .first<number>('n')).toBe(0);
  });

  it('reads a proxied expected-header length at most once before DB snapshot rejection', async () => {
    const sparseHeaders = new Array(1_000_000_000);
    let lengthReads = 0;
    const driftedHeaders = new Proxy(sparseHeaders, {
      get: (target, property, receiver) => {
        if (property === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 0 : target.length;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const arrayFrom = vi.spyOn(Array, 'from').mockImplementation(() => {
      throw new Error('must reject before expanding a drifted sparse array');
    });
    let error: unknown;
    let expansionAttempts = -1;

    try {
      error = await createPeopleImportMapping(env.DB, validInput({
        expectedHeaders: driftedHeaders,
      })).catch((caught: unknown) => caught);
      expansionAttempts = arrayFrom.mock.calls.length;
    } finally {
      arrayFrom.mockRestore();
    }
    expect(error).toBeInstanceOf(PeopleImportMappingInvalidError);
    expect(lengthReads).toBeLessThanOrEqual(1);
    expect(expansionAttempts).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people_import_mappings')
      .first<number>('n')).toBe(0);
  });

  it('rejects every open or invalid contract before persistence with one PII-free error', async () => {
    const invalidInputs: unknown[] = [
      { ...validInput(), privateSampleRow: 'PRIVATE SAMPLE ROW' },
      { ...validInput(), name: '   ' },
      { ...validInput(), name: 'x'.repeat(PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxNameCodePoints + 1) },
      { ...validInput(), expectedHeaders: [] },
      { ...validInput(), expectedHeaders: ['email', 'email'] },
      { ...validInput(), expectedHeaders: [' Not Normalized '] },
      { ...validInput(), expectedHeaders: new Array(129).fill('header') },
      { ...validInput(), fieldMappings: { ...fieldMappings(), unknown: 0 } },
      { ...validInput(), fieldMappings: { ...fieldMappings(), email: 99 } },
      { ...validInput(), fieldMappings: { ...fieldMappings(), email: 1.5 } },
      { ...validInput(), constants: { email: 'PRIVATE MEMBER VALUE' } },
      { ...validInput(), constants: { record_type: 'admin' } },
      { ...validInput(), constants: { household_role: '' } },
      { ...validInput(), constants: { active: 'true' }, fieldMappings: fieldMappings({ active: 0 }) },
      { ...validInput(), enumTranslations: { email: { private: 'PRIVATE MEMBER VALUE' } } },
      { ...validInput(), constants: {}, enumTranslations: { language: { english: 'en' } } },
      { ...validInput(), enumTranslations: { language: { english: 'en' } } },
      { ...validInput(), enumTranslations: { record_type: { member: 'admin' } } },
      { ...validInput(), enumTranslations: { active: { no: '' } } },
      { ...validInput(), enumTranslations: { active: { ' Not Normalized ': 'true' } } },
      { ...validInput(), createdByPersonId: 0 },
    ];

    for (const input of invalidInputs) {
      const error = await createPeopleImportMapping(
        env.DB,
        input as CreatePeopleImportMappingInput,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PeopleImportMappingInvalidError);
      expect(error).toMatchObject({ code: 'mapping_profile_invalid', message: 'Mapping profile is invalid' });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/PRIVATE|admin|unknown|email/i);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people_import_mappings')
      .first<number>('n')).toBe(0);
  });

  it('rejects a translation without a source mapping before it can consume the final profile slot', async () => {
    const rows = Array.from({ length: 99 }, (_, index) => env.DB.prepare(`
      INSERT INTO people_import_mappings
        (id, name, name_key, expected_headers_json, field_mappings_json,
         constants_json, enum_translations_json, created_by_person_id)
      VALUES (?, ?, ?, '["header"]', ?, '{}', '{}', 9800)
    `).bind(index + 1, `Profile ${index + 1}`, `profile ${index + 1}`, JSON.stringify(fieldMappings())));
    await env.DB.batch(rows);

    const rejected = await createPeopleImportMapping(env.DB, validInput({
      name: 'Invalid final slot',
      enumTranslations: { language: { english: 'en' } },
    })).catch((caught: unknown) => caught);
    expect(rejected).toBeInstanceOf(PeopleImportMappingInvalidError);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people_import_mappings')
      .first<number>('n')).toBe(99);

    const created = await createPeopleImportMapping(env.DB, validInput({ name: 'Valid final slot' }));
    expect(created.id).toBe(100);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people_import_mappings')
      .first<number>('n')).toBe(100);
  });

  it('maps duplicate names and the atomic 100-profile ceiling to one safe conflict', async () => {
    await createPeopleImportMapping(env.DB, validInput({ name: 'Bréeze Profile' }));
    const duplicate = await createPeopleImportMapping(env.DB, validInput({
      name: '  BRÉEZE PROFILE  ',
    })).catch((caught: unknown) => caught);
    expect(duplicate).toBeInstanceOf(PeopleImportMappingConflictError);
    expect(duplicate).toMatchObject({ code: 'mapping_profile_conflict', message: 'Mapping profile conflicts' });

    await env.DB.prepare('DELETE FROM people_import_mappings').run();
    const rows = Array.from({ length: 100 }, (_, index) => env.DB.prepare(`
      INSERT INTO people_import_mappings
        (id, name, name_key, expected_headers_json, field_mappings_json,
         constants_json, enum_translations_json, created_by_person_id)
      VALUES (?, ?, ?, '["header"]', ?, '{}', '{}', 9800)
    `).bind(index + 1, `Profile ${index + 1}`, `profile ${index + 1}`, JSON.stringify(fieldMappings())));
    await env.DB.batch(rows);

    const full = await createPeopleImportMapping(env.DB, validInput({ name: 'Profile 101' }))
      .catch((caught: unknown) => caught);
    expect(full).toBeInstanceOf(PeopleImportMappingConflictError);
    expect(full).toMatchObject({ code: 'mapping_profile_conflict', message: 'Mapping profile conflicts' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people_import_mappings')
      .first<number>('n')).toBe(100);
  });

  it('allows exactly one concurrent insert into the final immutable slot', async () => {
    const rows = Array.from({ length: 99 }, (_, index) => env.DB.prepare(`
      INSERT INTO people_import_mappings
        (id, name, name_key, expected_headers_json, field_mappings_json,
         constants_json, enum_translations_json, created_by_person_id)
      VALUES (?, ?, ?, '["header"]', ?, '{}', '{}', 9800)
    `).bind(index + 1, `Profile ${index + 1}`, `profile ${index + 1}`, JSON.stringify(fieldMappings())));
    await env.DB.batch(rows);

    const results = await Promise.allSettled([
      createPeopleImportMapping(env.DB, validInput({ name: 'Final Alpha' })),
      createPeopleImportMapping(env.DB, validInput({ name: 'Final Beta' })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'mapping_profile_conflict' }),
    });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people_import_mappings')
      .first<number>('n')).toBe(100);
  });

  it('fails closed with one structural error when persisted JSON or row shapes are corrupt', async () => {
    await env.DB.prepare(`
      INSERT INTO people_import_mappings
        (id, name, name_key, expected_headers_json, field_mappings_json,
         constants_json, enum_translations_json, created_by_person_id)
      VALUES (1, 'Corrupt', 'corrupt', '["private-header"]',
        '{"record_type":0}', '{"language":"PRIVATE VALUE"}', '{}', 9800)
    `).run();

    const getError = await getPeopleImportMapping(env.DB, 1).catch((caught: unknown) => caught);
    expect(getError).toBeInstanceOf(PeopleImportMappingStructuralError);
    expect(getError).toMatchObject({
      code: 'mapping_profile_corrupt',
      message: 'Mapping profile data is corrupt',
    });
    expect(`${String(getError)} ${JSON.stringify(getError)}`).not.toMatch(/private|record_type|language/i);

    const listError = await listPeopleImportMappings(env.DB).catch((caught: unknown) => caught);
    expect(listError).toBeInstanceOf(PeopleImportMappingStructuralError);
    expect(listError).toMatchObject({
      code: 'mapping_profile_corrupt',
      message: 'Mapping profile data is corrupt',
    });
    expect(`${String(listError)} ${JSON.stringify(listError)}`).not.toMatch(/private|record_type|language/i);
  });

  it('rejects impossible persisted calendar timestamps as corrupt structural data', async () => {
    const created = await createPeopleImportMapping(env.DB, validInput());
    await env.DB.prepare(`
      UPDATE people_import_mappings
      SET created_at = '2026-13-40 29:00:00'
      WHERE id = ?
    `).bind(created.id).run();

    const error = await getPeopleImportMapping(env.DB, created.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PeopleImportMappingStructuralError);
    expect(error).toMatchObject({ code: 'mapping_profile_corrupt' });
  });
});
