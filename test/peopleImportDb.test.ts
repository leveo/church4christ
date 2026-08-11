import { env } from 'cloudflare:test';
import type { AppDb, AppDbResult, AppStatement } from '../src/lib/appDb';
import { PeopleImportNotReadyError, preflightPeopleImport } from '../src/lib/peopleImportDb';
import { parsePeopleImport, type PeopleImportHeader } from '../src/lib/peopleImport';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyPeopleImportFixture,
  parsePeopleImportRecords,
  peopleImportFixture,
} from './fixtures/peopleImport';

const unreachableDb = (): AppDb => ({
  prepare: vi.fn(() => {
    throw new Error('prepare must not be reached');
  }),
  batch: vi.fn(() => {
    throw new Error('batch must not be reached');
  }),
});

interface PreparedCall {
  sql: string;
  values: unknown[];
  operation: 'first' | 'all' | 'run' | null;
}

class RecordingDb implements AppDb {
  readonly prepared: PreparedCall[] = [];
  batchCalls = 0;

  constructor(private readonly delegate: AppDb) {}

  prepare(sql: string): AppStatement {
    const call: PreparedCall = { sql, values: [], operation: null };
    this.prepared.push(call);
    const prepared = this.delegate.prepare(sql);
    let bound = prepared;
    const statement: AppStatement = {
      bind: (...values: unknown[]) => {
        call.values = values;
        bound = prepared.bind(...values);
        return statement;
      },
      first: async <T = unknown>(colName?: string) => {
        call.operation = 'first';
        return bound.first<T>(colName);
      },
      all: async <T = unknown>() => {
        call.operation = 'all';
        return bound.all<T>();
      },
      run: async <T = unknown>() => {
        call.operation = 'run';
        return bound.run<T>();
      },
    };
    return statement;
  }

  batch<T = unknown>(_statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    this.batchCalls += 1;
    throw new Error('preflight must not start a batch');
  }
}

const personRecord = (
  index: number,
  overrides: Partial<Record<PeopleImportHeader, string>> = {},
): Partial<Record<PeopleImportHeader, string>> => ({
  record_type: 'person',
  display_name: `Imported Person ${index}`,
  email: `person-${index}@example.com`,
  ...overrides,
});

const householdPrimaryRecord = (
  index: number,
  overrides: Partial<Record<PeopleImportHeader, string>> = {},
): Partial<Record<PeopleImportHeader, string>> => personRecord(index, {
  household_key: `family-${index}`,
  household_name: `Family ${index}`,
  household_role: 'adult',
  household_primary: 'true',
  ...overrides,
});

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM household_members'),
    env.DB.prepare('DELETE FROM households'),
    env.DB.prepare('DELETE FROM people'),
  ]);
}

beforeEach(reset);

describe('preflightPeopleImport readiness', () => {
  it('rejects a null model before preparing SQL or starting a batch', async () => {
    const db = unreachableDb();
    const parsed = parsePeopleImport(new Uint8Array(), { today: '2026-08-11' });

    await expect(preflightPeopleImport(db, parsed)).rejects.toBeInstanceOf(PeopleImportNotReadyError);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('rejects a partial model carrying pure validation errors without retaining PII', async () => {
    const db = unreachableDb();
    const parsed = parsePeopleImportRecords([
      personRecord(1, { display_name: '', email: 'private.person@example.com' }),
    ]);
    expect(parsed.model).not.toBeNull();
    expect(parsed.errors.length).toBeGreaterThan(0);

    const error = await preflightPeopleImport(db, parsed).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportNotReadyError);
    expect(error).toMatchObject({ code: 'import_not_ready' });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('private.person@example.com');
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('returns no issues or database work for an empty validated model', async () => {
    const db = new RecordingDb(env.DB);

    await expect(preflightPeopleImport(db, emptyPeopleImportFixture)).resolves.toEqual({
      errors: [],
      warnings: [],
    });
    expect(db.prepared).toEqual([]);
    expect(db.batchCalls).toBe(0);
  });
});

describe('shared people import fixture', () => {
  it('covers ordered households, nullable/profile fields, dependents, and literal-looking text', () => {
    expect(peopleImportFixture.errors).toEqual([]);
    expect(peopleImportFixture.warnings).toEqual([
      { severity: 'warning', code: 'duplicate_household_name', row: 3, field: 'household_name' },
      { severity: 'warning', code: 'duplicate_household_name', row: 6, field: 'household_name' },
    ]);
    expect(peopleImportFixture.model?.summary).toEqual({
      dataRows: 6,
      people: 5,
      dependents: 1,
      households: 2,
      inactivePeople: 1,
    });
    expect(peopleImportFixture.model?.people[0]).toMatchObject({
      firstName: null,
      lastName: "O'Neil",
      active: false,
      language: 'en',
      membershipStatus: 'inactive',
      birthday: '1990-02-03',
      joinedOn: '2020-04-05',
      address: "1 Main St?; DROP TABLE people; --",
    });
    expect(peopleImportFixture.model?.households).toMatchObject([
      {
        key: 'alpha-family',
        name: "St. John's Family?",
        primaryEmail: 'pat@example.com',
        people: [{ row: 3 }, { row: 5 }],
        dependents: [{ row: 4, displayName: 'Kid ?); DELETE FROM people; --' }],
      },
      {
        key: 'beta-family',
        name: "St. John's Family?",
        primaryEmail: 'robin@example.com',
        people: [{ row: 6 }, { row: 7 }],
      },
    ]);
  });

  it('allows pure parser warnings and reports only database issues', async () => {
    const db = new RecordingDb(env.DB);

    await expect(preflightPeopleImport(db, peopleImportFixture)).resolves.toEqual({
      errors: [],
      warnings: [],
    });
    expect(db.batchCalls).toBe(0);
  });
});

describe('preflightPeopleImport email collisions', () => {
  it('blocks live, inactive, soft-deleted, trimmed, and mixed-case existing emails once per import row', async () => {
    const parsed = parsePeopleImportRecords([
      personRecord(1, { email: 'live@example.com' }),
      personRecord(2, { email: 'inactive@example.com' }),
      personRecord(3, { email: 'deleted@example.com' }),
      personRecord(4, { email: 'mixed@example.com' }),
    ]);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)').bind('Live', '  LIVE@EXAMPLE.COM  '),
      env.DB.prepare('INSERT INTO people (display_name, email, active) VALUES (?, ?, 0)').bind('Inactive', 'inactive@example.com'),
      env.DB.prepare('INSERT INTO people (display_name, email, deleted_at) VALUES (?, ?, ?)').bind('Deleted', 'deleted@example.com', '2026-01-01'),
      env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)').bind('Mixed', 'MiXeD@Example.Com'),
    ]);
    const db = new RecordingDb(env.DB);

    const result = await preflightPeopleImport(db, parsed);

    expect(result).toEqual({
      errors: [2, 3, 4, 5].map((row) => ({
        severity: 'error',
        code: 'email_exists',
        row,
        field: 'email',
      })),
      warnings: [],
    });
    const serialized = JSON.stringify(result);
    for (const privateValue of ['live@example.com', 'inactive@example.com', 'deleted@example.com', 'mixed@example.com']) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(db.prepared.every((call) => call.operation === 'all')).toBe(true);
    expect(db.batchCalls).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people').first<number>('n')).toBe(4);
  });

  it('deduplicates canonical query candidates while retaining every imported row mapping', async () => {
    const parsed = parsePeopleImportRecords([personRecord(1, { email: 'same@example.com' })]);
    parsed.model!.people.push({ ...parsed.model!.people[0], row: 40, email: ' SAME@EXAMPLE.COM ' });
    await env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)')
      .bind('Existing', 'same@example.com')
      .run();
    const db = new RecordingDb(env.DB);

    const result = await preflightPeopleImport(db, parsed);

    expect(result.errors.map((issue) => issue.row)).toEqual([2, 40]);
    const emailQueries = db.prepared.filter((call) => call.sql.includes('LOWER(TRIM(email)) IN'));
    expect(emailQueries).toHaveLength(1);
    expect(emailQueries[0].values).toEqual(['same@example.com']);
  });
});

describe('preflightPeopleImport household warnings', () => {
  it('warns once per imported key for a normalized live name, ignores soft-deleted names, and never attaches', async () => {
    const parsed = parsePeopleImportRecords([
      householdPrimaryRecord(1, { household_key: 'one', household_name: 'Smith Family' }),
      householdPrimaryRecord(2, { household_key: 'two', household_name: ' smith family ' }),
      householdPrimaryRecord(3, { household_key: 'archived', household_name: 'Archived Family' }),
    ]);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO households (name) VALUES (?)').bind('  SMITH FAMILY  '),
      env.DB.prepare('INSERT INTO households (name) VALUES (?)').bind('smith family'),
      env.DB.prepare('INSERT INTO households (name, deleted_at) VALUES (?, ?)').bind('ARCHIVED FAMILY', '2026-01-01'),
    ]);
    const db = new RecordingDb(env.DB);

    const result = await preflightPeopleImport(db, parsed);

    expect(result).toEqual({
      errors: [],
      warnings: [2, 3].map((row) => ({
        severity: 'warning',
        code: 'household_name_exists',
        row,
        field: 'household_name',
      })),
    });
    expect(db.batchCalls).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM households').first<number>('n')).toBe(3);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM household_members').first<number>('n')).toBe(0);
    const householdQueries = db.prepared.filter((call) => call.sql.includes('LOWER(TRIM(name)) IN'));
    expect(householdQueries).toHaveLength(1);
    expect(householdQueries[0].values).toEqual(['smith family', 'archived family']);
  });
});

describe('preflightPeopleImport bounded query construction', () => {
  it.each([
    [0, 0],
    [1, 1],
    [100, 1],
    [101, 2],
    [200, 2],
  ])('checks %i email candidates in %i non-empty chunks of at most 100 binds', async (count, chunks) => {
    const parsed = parsePeopleImportRecords(
      Array.from({ length: count }, (_, index) => personRecord(index)),
    );
    expect(parsed.errors).toEqual([]);
    const db = new RecordingDb(env.DB);

    await preflightPeopleImport(db, parsed);

    const emailQueries = db.prepared.filter((call) => call.sql.includes('LOWER(TRIM(email)) IN'));
    expect(emailQueries).toHaveLength(chunks);
    expect(emailQueries.every((call) => call.values.length > 0 && call.values.length <= 100)).toBe(true);
    expect(db.prepared.every((call) => !call.sql.includes('IN ()'))).toBe(true);
    expect(db.prepared.every((call) => call.operation === 'all')).toBe(true);
    expect(db.batchCalls).toBe(0);
  });
});

describe('preflightPeopleImport Unicode parity fallback', () => {
  it('matches composed/decomposed and non-ASCII case variants for emails through a JS full-column read', async () => {
    const parsed = parsePeopleImportRecords([
      personRecord(1, { email: 'jos\u00e9@example.com' }),
      personRecord(2, { email: '\u00e9lodie@example.com' }),
    ]);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)').bind('One', '  JOSE\u0301@EXAMPLE.COM  '),
      env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)').bind('Two', '\u00c9LODIE@EXAMPLE.COM'),
    ]);
    const db = new RecordingDb(env.DB);

    const result = await preflightPeopleImport(db, parsed);

    expect(result.errors).toEqual([2, 3].map((row) => ({
      severity: 'error', code: 'email_exists', row, field: 'email',
    })));
    expect(db.prepared).toEqual(expect.arrayContaining([
      expect.objectContaining({ sql: expect.stringMatching(/^SELECT email AS identifier FROM people$/), values: [] }),
    ]));
  });

  it('matches composed/decomposed and non-ASCII case variants for live household names only', async () => {
    const parsed = parsePeopleImportRecords([
      householdPrimaryRecord(1, { household_name: 'Caf\u00e9 Family' }),
      householdPrimaryRecord(2, { household_name: '\u00e9toile Family' }),
      householdPrimaryRecord(3, { household_name: '\u00e9teint Family' }),
    ]);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO households (name) VALUES (?)').bind('  CAFE\u0301 FAMILY  '),
      env.DB.prepare('INSERT INTO households (name) VALUES (?)').bind('\u00c9TOILE FAMILY'),
      env.DB.prepare('INSERT INTO households (name, deleted_at) VALUES (?, ?)').bind('\u00c9TEINT FAMILY', '2026-01-01'),
    ]);
    const db = new RecordingDb(env.DB);

    const result = await preflightPeopleImport(db, parsed);

    expect(result.warnings).toEqual([2, 3].map((row) => ({
      severity: 'warning', code: 'household_name_exists', row, field: 'household_name',
    })));
    expect(db.prepared).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sql: expect.stringMatching(/^SELECT name AS identifier FROM households WHERE deleted_at IS NULL$/),
        values: [],
      }),
    ]));
  });
});

describe('preflightPeopleImport issue bounds and ordering', () => {
  it('sorts issues stably by severity, row, field, and code regardless of model array order', async () => {
    const parsed = parsePeopleImportRecords([
      householdPrimaryRecord(1, { email: 'first@example.com', household_name: 'Existing Family' }),
      personRecord(2, { email: 'second@example.com' }),
      householdPrimaryRecord(3, { email: 'third@example.com', household_name: 'Another Existing Family' }),
    ]);
    parsed.model!.people.reverse();
    parsed.model!.households.reverse();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)').bind('Third', 'third@example.com'),
      env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)').bind('First', 'first@example.com'),
      env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)').bind('Second', 'second@example.com'),
      env.DB.prepare('INSERT INTO households (name) VALUES (?)').bind('Another Existing Family'),
      env.DB.prepare('INSERT INTO households (name) VALUES (?)').bind('Existing Family'),
    ]);

    const result = await preflightPeopleImport(env.DB, parsed);

    expect(result.errors.map((issue) => issue.row)).toEqual([2, 3, 4]);
    expect(result.warnings.map((issue) => issue.row)).toEqual([2, 4]);
  });

  it('keeps the first 99 errors before warnings and appends one safe truncation error', async () => {
    const records: Array<Partial<Record<PeopleImportHeader, string>>> = [];
    const peopleSeeds: AppStatement[] = [];
    const householdSeeds: AppStatement[] = [];
    for (let family = 0; family < 100; family += 1) {
      const primary = family * 2;
      const other = primary + 1;
      records.push(householdPrimaryRecord(primary));
      records.push(personRecord(other, {
        household_key: `family-${primary}`,
        household_role: 'adult',
        household_primary: 'false',
      }));
      peopleSeeds.push(
        env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)')
          .bind(`Existing ${primary}`, `person-${primary}@example.com`),
        env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)')
          .bind(`Existing ${other}`, `person-${other}@example.com`),
      );
      householdSeeds.push(
        env.DB.prepare('INSERT INTO households (name) VALUES (?)').bind(`Family ${primary}`),
      );
    }
    const parsed = parsePeopleImportRecords(records);
    expect(parsed.errors).toEqual([]);
    await env.DB.batch([...peopleSeeds, ...householdSeeds] as D1PreparedStatement[]);
    const db = new RecordingDb(env.DB);

    const result = await preflightPeopleImport(db, parsed);

    expect(result.errors).toHaveLength(100);
    expect(result.warnings).toEqual([]);
    expect(result.errors.slice(0, 99)).toEqual(
      Array.from({ length: 99 }, (_, index) => ({
        severity: 'error',
        code: 'email_exists',
        row: index + 2,
        field: 'email',
      })),
    );
    expect(result.errors[99]).toEqual({
      severity: 'error',
      code: 'issues_truncated',
      row: null,
      field: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/person-|Family |Existing /);
    expect(result.errors.length + result.warnings.length).toBe(100);
    expect(db.batchCalls).toBe(0);
  });
});
