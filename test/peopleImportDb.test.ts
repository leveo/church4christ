import { env } from 'cloudflare:test';
import type { AppDb, AppDbResult, AppStatement } from '../src/lib/appDb';
import type { DbBackend } from '../src/lib/dbProvider';
import {
  PeopleImportConflictError,
  PeopleImportNotReadyError,
  PeopleImportPersistenceError,
  commitPeopleImport,
  preflightPeopleImport,
} from '../src/lib/peopleImportDb';
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

class AtomicStatement implements AppStatement {
  private bound: AppStatement;

  constructor(
    private readonly prepared: AppStatement,
    private readonly call: PreparedCall,
  ) {
    this.bound = prepared;
  }

  bind(...values: unknown[]): AppStatement {
    this.call.values = values;
    this.bound = this.prepared.bind(...values);
    return this;
  }

  first<T = unknown>(colName?: string): Promise<T | null> {
    this.call.operation = 'first';
    return this.bound.first<T>(colName);
  }

  all<T = unknown>(): Promise<AppDbResult<T>> {
    this.call.operation = 'all';
    return this.bound.all<T>();
  }

  run<T = unknown>(): Promise<AppDbResult<T>> {
    this.call.operation = 'run';
    return this.bound.run<T>();
  }

  raw(): AppStatement {
    return this.bound;
  }
}

class AtomicRecordingDb implements AppDb {
  readonly prepared: PreparedCall[] = [];
  batchCalls = 0;
  lastBatchSize = 0;

  constructor(
    private readonly delegate: AppDb,
    private readonly beforeBatch?: () => Promise<void>,
  ) {}

  prepare(sql: string): AppStatement {
    const call: PreparedCall = { sql, values: [], operation: null };
    this.prepared.push(call);
    return new AtomicStatement(this.delegate.prepare(sql), call);
  }

  async batch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    this.batchCalls += 1;
    this.lastBatchSize = statements.length;
    await this.beforeBatch?.();
    return this.delegate.batch<T>(
      statements.map((statement) => {
        if (!(statement instanceof AtomicStatement)) {
          throw new Error('unexpected untracked statement');
        }
        return statement.raw();
      }),
    );
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

async function seedCollidingPeople(count: number): Promise<void> {
  if (count === 0) return;
  await env.DB.prepare(`
    WITH RECURSIVE sequence(n) AS (
      SELECT 0
      UNION ALL
      SELECT n + 1 FROM sequence WHERE n + 1 < ?
    )
    INSERT INTO people (display_name, email)
    SELECT 'Existing ' || n, 'person-' || n || '@example.com' FROM sequence
  `).bind(count).run();
}

async function seedPagedIdentifiers(count: number, targetId: number): Promise<void> {
  await env.DB.prepare(`
    WITH RECURSIVE sequence(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM sequence WHERE n < ?
    )
    INSERT INTO people (id, display_name, email)
    SELECT
      n,
      'Existing ' || n,
      CASE WHEN n = ? THEN 'target@example.com' ELSE 'existing-' || n || '@example.com' END
    FROM sequence
  `).bind(count, targetId).run();
  await env.DB.prepare(`
    WITH RECURSIVE sequence(n) AS (
      SELECT 1
      UNION ALL
      SELECT n + 1 FROM sequence WHERE n < ?
    )
    INSERT INTO households (id, name)
    SELECT
      n,
      CASE WHEN n = ? THEN 'Target Family' ELSE 'Existing Family ' || n END
    FROM sequence
  `).bind(count, targetId).run();
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
    const emailQueries = db.prepared.filter((call) => call.sql.includes('FROM people'));
    expect(emailQueries).toHaveLength(1);
    expect(emailQueries[0].values).toEqual([]);
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
    const householdQueries = db.prepared.filter((call) => call.sql.includes('FROM households'));
    expect(householdQueries).toHaveLength(1);
    expect(householdQueries[0].values).toEqual([]);
  });
});

describe('preflightPeopleImport bounded canonical scans', () => {
  it.each([
    [0, 0, false],
    [1, 1, false],
    [100, 100, false],
    [101, 100, true],
    [200, 100, true],
  ])('maps %i email candidates into %i bounded issues (truncated: %s)', async (count, issueCount, truncated) => {
    const parsed = parsePeopleImportRecords(
      Array.from({ length: count }, (_, index) => personRecord(index)),
    );
    expect(parsed.errors).toEqual([]);
    await seedCollidingPeople(count);
    const db = new RecordingDb(env.DB);

    const result = await preflightPeopleImport(db, parsed);

    const emailQueries = db.prepared.filter((call) => call.sql.includes('FROM people'));
    expect(emailQueries).toHaveLength(count === 0 ? 0 : 1);
    expect(emailQueries.every((call) => call.sql.includes('ORDER BY id LIMIT 500'))).toBe(true);
    expect(emailQueries.every((call) => !call.sql.includes('LOWER(') && !call.sql.includes(' IN ('))).toBe(true);
    expect(result.errors).toHaveLength(issueCount);
    expect(result.errors.at(-1)?.code === 'issues_truncated').toBe(truncated);
    expect(result.errors.slice(0, truncated ? 99 : issueCount).map((issue) => issue.row)).toEqual(
      Array.from({ length: truncated ? 99 : issueCount }, (_, index) => index + 2),
    );
    expect(db.prepared.every((call) => call.operation === 'all')).toBe(true);
    expect(db.batchCalls).toBe(0);
  });

  it('uses fixed 500-row id-keyset pages for both identifier kinds', async () => {
    await seedPagedIdentifiers(501, 501);
    const parsed = parsePeopleImportRecords([
      householdPrimaryRecord(999, {
        email: 'target@example.com',
        household_name: 'Target Family',
      }),
    ]);
    const db = new RecordingDb(env.DB);

    const result = await preflightPeopleImport(db, parsed);

    expect(result).toEqual({
      errors: [{ severity: 'error', code: 'email_exists', row: 2, field: 'email' }],
      warnings: [{ severity: 'warning', code: 'household_name_exists', row: 2, field: 'household_name' }],
    });
    const emailPages = db.prepared.filter((call) => call.sql.includes('FROM people'));
    expect(emailPages).toEqual([
      expect.objectContaining({
        sql: 'SELECT id, email AS identifier FROM people ORDER BY id LIMIT 500',
        values: [],
      }),
      expect.objectContaining({
        sql: 'SELECT id, email AS identifier FROM people WHERE id > ? ORDER BY id LIMIT 500',
        values: [500],
      }),
    ]);
    const householdPages = db.prepared.filter((call) => call.sql.includes('FROM households'));
    expect(householdPages).toEqual([
      expect.objectContaining({
        sql: 'SELECT id, name AS identifier FROM households WHERE deleted_at IS NULL ORDER BY id LIMIT 500',
        values: [],
      }),
      expect.objectContaining({
        sql: 'SELECT id, name AS identifier FROM households WHERE deleted_at IS NULL AND id > ? ORDER BY id LIMIT 500',
        values: [500],
      }),
    ]);
  });

  it('stops after the first page once every imported identity is found', async () => {
    await seedPagedIdentifiers(600, 1);
    const parsed = parsePeopleImportRecords([personRecord(999, { email: 'target@example.com' })]);
    const db = new RecordingDb(env.DB);

    const result = await preflightPeopleImport(db, parsed);

    expect(result.errors).toEqual([
      { severity: 'error', code: 'email_exists', row: 2, field: 'email' },
    ]);
    expect(db.prepared.filter((call) => call.sql.includes('FROM people'))).toEqual([
      expect.objectContaining({
        sql: 'SELECT id, email AS identifier FROM people ORDER BY id LIMIT 500',
        values: [],
      }),
    ]);
  });

  it('does not scan an identifier kind with no candidates', async () => {
    const standalone = parsePeopleImportRecords([personRecord(1)]);
    const householdOnly = parsePeopleImportRecords([householdPrimaryRecord(2)]);
    householdOnly.model!.people = [];
    const standaloneDb = new RecordingDb(env.DB);
    const householdDb = new RecordingDb(env.DB);

    await preflightPeopleImport(standaloneDb, standalone);
    await preflightPeopleImport(householdDb, householdOnly);

    expect(standaloneDb.prepared.some((call) => call.sql.includes('FROM households'))).toBe(false);
    expect(householdDb.prepared.some((call) => call.sql.includes('FROM people'))).toBe(false);
  });
});

describe('preflightPeopleImport Unicode parity scan', () => {
  it('matches composed/decomposed and non-ASCII case variants for emails in JavaScript', async () => {
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
      expect.objectContaining({
        sql: expect.stringMatching(/^SELECT id, email AS identifier FROM people ORDER BY id LIMIT 500$/),
        values: [],
      }),
    ]));
  });

  it('matches composed/decomposed and non-ASCII case variants for live household names in JavaScript', async () => {
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
        sql: expect.stringMatching(/^SELECT id, name AS identifier FROM households WHERE deleted_at IS NULL ORDER BY id LIMIT 500$/),
        values: [],
      }),
    ]));
  });

  it('matches an existing Kelvin-sign email to an imported ASCII k identity', async () => {
    const parsed = parsePeopleImportRecords([personRecord(1, { email: 'k@example.com' })]);
    await env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)')
      .bind('Kelvin', '\u212A@example.com')
      .run();

    const result = await preflightPeopleImport(env.DB, parsed);

    expect(result.errors).toEqual([
      { severity: 'error', code: 'email_exists', row: 2, field: 'email' },
    ]);
  });

  it('matches an existing Kelvin-sign household to an imported ASCII k identity', async () => {
    const parsed = parsePeopleImportRecords([
      householdPrimaryRecord(1, { household_name: 'k family' }),
    ]);
    await env.DB.prepare('INSERT INTO households (name) VALUES (?)').bind('\u212A FAMILY').run();

    const result = await preflightPeopleImport(env.DB, parsed);

    expect(result.warnings).toEqual([
      { severity: 'warning', code: 'household_name_exists', row: 2, field: 'household_name' },
    ]);
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

async function importTableCounts(): Promise<{ people: number; households: number; members: number }> {
  const [people, households, members] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM people').first<number>('n'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM households').first<number>('n'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM household_members').first<number>('n'),
  ]);
  return { people: people ?? 0, households: households ?? 0, members: members ?? 0 };
}

describe('commitPeopleImport readiness and preflight', () => {
  it('rejects a null model before preparing SQL or starting a batch', async () => {
    const db = unreachableDb();
    const parsed = parsePeopleImport(new Uint8Array(), { today: '2026-08-11' });

    await expect(commitPeopleImport(db, 'd1', parsed)).rejects.toBeInstanceOf(PeopleImportNotReadyError);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('rejects a partial model carrying pure errors before database work', async () => {
    const db = unreachableDb();
    const parsed = parsePeopleImportRecords([
      personRecord(1, { display_name: '', email: 'private.not-ready@example.com' }),
    ]);
    expect(parsed.model).not.toBeNull();
    expect(parsed.errors.length).toBeGreaterThan(0);

    const error = await commitPeopleImport(db, 'd1', parsed).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportNotReadyError);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('private.not-ready@example.com');
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('returns zero array-derived counts for an empty validated model without database work', async () => {
    const db = unreachableDb();
    const parsed = parsePeopleImportRecords([]);
    parsed.model!.summary = {
      dataRows: 999,
      people: 999,
      dependents: 999,
      households: 999,
      inactivePeople: 999,
    };

    await expect(commitPeopleImport(db, 'd1', parsed)).resolves.toEqual({
      people: 0,
      households: 0,
      dependents: 0,
    });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('turns blocking preflight issues into a safe conflict without a batch', async () => {
    const privateEmail = 'private.preflight@example.com';
    const parsed = parsePeopleImportRecords([personRecord(1, { email: privateEmail })]);
    await env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)')
      .bind('Existing', privateEmail)
      .run();
    const db = new AtomicRecordingDb(env.DB);

    const error = await commitPeopleImport(db, 'd1', parsed).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportConflictError);
    expect(error).toMatchObject({ code: 'import_conflict' });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('detail');
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(privateEmail);
    expect(db.batchCalls).toBe(0);
    expect(await importTableCounts()).toEqual({ people: 1, households: 0, members: 0 });
  });

  it('fails safely for an unknown runtime backend before database work', async () => {
    const db = unreachableDb();
    const parsed = parsePeopleImportRecords([personRecord(1)]);

    const error = await commitPeopleImport(db, 'other' as DbBackend, parsed)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportPersistenceError);
    expect(error).toMatchObject({ code: 'import_failed' });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });
});

describe('commitPeopleImport person persistence', () => {
  it('stores blank names, active flags, and optional profile fields', async () => {
    const parsed = parsePeopleImportRecords([
      personRecord(1, { display_name: 'Blank Names', email: 'blank@example.com' }),
      personRecord(2, {
        display_name: 'Profile Person',
        email: 'profile@example.com',
        first_name: 'Profile',
        last_name: 'Person',
        phone: '555-0111',
        language: 'zh',
        birthday: '1988-07-06',
        address: '88 Profile Lane',
        membership_status: 'member',
        joined_on: '2024-05-04',
        active: 'false',
      }),
    ]);

    await expect(commitPeopleImport(env.DB, 'd1', parsed)).resolves.toEqual({
      people: 2,
      households: 0,
      dependents: 0,
    });
    const { results } = await env.DB.prepare(`
      SELECT first_name, last_name, display_name, email, phone, active, lang,
             birthday, address, membership_status, joined_on
      FROM people ORDER BY id
    `).all();
    expect(results).toEqual([
      {
        first_name: '',
        last_name: '',
        display_name: 'Blank Names',
        email: 'blank@example.com',
        phone: null,
        active: 1,
        lang: null,
        birthday: null,
        address: null,
        membership_status: 'visitor',
        joined_on: null,
      },
      {
        first_name: 'Profile',
        last_name: 'Person',
        display_name: 'Profile Person',
        email: 'profile@example.com',
        phone: '555-0111',
        active: 0,
        lang: 'zh',
        birthday: '1988-07-06',
        address: '88 Profile Lane',
        membership_status: 'member',
        joined_on: '2024-05-04',
      },
    ]);
  });

  it('uses a literal member role and leaves every sensitive field at its safe schema default', async () => {
    const parsed = parsePeopleImportRecords([
      householdPrimaryRecord(1, { email: 'tampered@example.com' }),
    ]);
    Object.assign(parsed.model!.people[0] as unknown as Record<string, unknown>, {
      role: 'admin',
      finance: 1,
      superAdmin: 1,
      adminAreas: 'people,giving,settings',
      sessionEpoch: 91,
      calendarToken: 'private-calendar-token',
      avatarUrl: 'https://private.example/avatar.png',
      deletedAt: '2026-01-01',
      pendingEmail: 'attacker@example.com',
      stripeCustomerId: 'cus_private',
      isOwner: 1,
    });

    await commitPeopleImport(env.DB, 'd1', parsed);

    const person = await env.DB.prepare(`
      SELECT role, finance, super_admin, admin_areas, session_epoch, calendar_token,
             avatar_url, deleted_at, pending_email, stripe_customer_id
      FROM people WHERE email = ?
    `).bind('tampered@example.com').first();
    expect(person).toEqual({
      role: 'member',
      finance: 0,
      super_admin: 0,
      admin_areas: '',
      session_epoch: 0,
      calendar_token: null,
      avatar_url: null,
      deleted_at: null,
      pending_email: null,
      stripe_customer_id: null,
    });
    expect(await env.DB.prepare('SELECT is_owner FROM household_members').first()).toEqual({ is_owner: 0 });
  });
});

describe('commitPeopleImport household associations', () => {
  it('creates standalone people, primary-first households, remaining members by CSV row, and dependents', async () => {
    const db = new AtomicRecordingDb(env.DB);

    const result = await commitPeopleImport(db, 'd1', peopleImportFixture);

    expect(result).toEqual({ people: 5, households: 2, dependents: 1 });
    expect(db.batchCalls).toBe(1);
    const { results } = await env.DB.prepare(`
      SELECT hm.household_id, p.email, hm.display_name, hm.role, hm.is_primary, hm.person_id
      FROM household_members hm
      LEFT JOIN people p ON p.id = hm.person_id
      ORDER BY hm.household_id, hm.id
    `).all<{
      household_id: number;
      email: string | null;
      display_name: string;
      role: string;
      is_primary: number;
      person_id: number | null;
    }>();
    const groups = Map.groupBy(results, (row) => row.household_id);
    expect([...groups.values()].map((members) => members.map((member) => ({
      email: member.email,
      display_name: member.display_name,
      role: member.role,
      is_primary: member.is_primary,
      dependent: member.person_id === null,
    })))).toEqual([
      [
        { email: 'pat@example.com', display_name: "Pat O'Primary", role: 'adult', is_primary: 1, dependent: false },
        { email: 'mina@example.com', display_name: 'Mina Child', role: 'child', is_primary: 0, dependent: false },
        { email: null, display_name: 'Kid ?); DELETE FROM people; --', role: 'child', is_primary: 0, dependent: true },
      ],
      [
        { email: 'robin@example.com', display_name: 'Robin Primary', role: 'adult', is_primary: 1, dependent: false },
        { email: 'taylor@example.com', display_name: 'Taylor Adult', role: 'adult', is_primary: 0, dependent: false },
      ],
    ]);
    expect(await env.DB.prepare(`
      SELECT email FROM people WHERE email = 'standalone@example.com'
        AND id NOT IN (SELECT person_id FROM household_members WHERE person_id IS NOT NULL)
    `).first()).toEqual({ email: 'standalone@example.com' });
  });

  it('never attaches by household name and does not cross-link same-name imported keys', async () => {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)')
        .bind('Legacy Person', 'legacy@example.com'),
      env.DB.prepare('INSERT INTO households (name) VALUES (?)')
        .bind("St. John's Family?"),
      env.DB.prepare(`
        INSERT INTO household_members (household_id, person_id, display_name, role, is_primary)
        VALUES (last_insert_rowid(), (SELECT id FROM people WHERE email = ?), ?, 'adult', 1)
      `).bind('legacy@example.com', 'Legacy Person'),
    ]);
    const db = new AtomicRecordingDb(env.DB);

    await commitPeopleImport(db, 'd1', peopleImportFixture);

    expect(db.batchCalls).toBe(1);
    const { results: primaries } = await env.DB.prepare(`
      SELECT h.id AS household_id, p.email
      FROM households h
      JOIN household_members hm ON hm.household_id = h.id AND hm.is_primary = 1
      JOIN people p ON p.id = hm.person_id
      WHERE h.name = ? ORDER BY h.id
    `).bind("St. John's Family?").all<{ household_id: number; email: string }>();
    expect(primaries.map((row) => row.email)).toEqual([
      'legacy@example.com',
      'pat@example.com',
      'robin@example.com',
    ]);
    const householdMembers = await Promise.all(primaries.map(async (primary) => {
      const { results } = await env.DB.prepare(`
        SELECT p.email, hm.display_name
        FROM household_members hm LEFT JOIN people p ON p.id = hm.person_id
        WHERE hm.household_id = ? ORDER BY hm.id
      `).bind(primary.household_id).all();
      return results;
    }));
    expect(householdMembers).toEqual([
      [{ email: 'legacy@example.com', display_name: 'Legacy Person' }],
      [
        { email: 'pat@example.com', display_name: "Pat O'Primary" },
        { email: 'mina@example.com', display_name: 'Mina Child' },
        { email: null, display_name: 'Kid ?); DELETE FROM people; --' },
      ],
      [
        { email: 'robin@example.com', display_name: 'Robin Primary' },
        { email: 'taylor@example.com', display_name: 'Taylor Adult' },
      ],
    ]);
    expect(db.prepared.filter((call) => call.operation === null)
      .every((call) => !/households?[^\n]*name\s*=|WHERE\s+name/i.test(call.sql))).toBe(true);
  });

  it('binds each D1 primary to the immediately preceding household insert', async () => {
    const parsed = parsePeopleImportRecords([
      householdPrimaryRecord(1, {
        household_key: 'first-household',
        household_name: 'First Household',
        email: 'first-primary@example.com',
      }),
      householdPrimaryRecord(2, {
        household_key: 'second-household',
        household_name: 'Second Household',
        email: 'second-primary@example.com',
      }),
    ]);

    await commitPeopleImport(env.DB, 'd1', parsed);

    const { results } = await env.DB.prepare(`
      SELECT h.name, p.email
      FROM households h
      JOIN household_members hm ON hm.household_id = h.id AND hm.is_primary = 1
      JOIN people p ON p.id = hm.person_id
      ORDER BY h.id
    `).all();
    expect(results).toEqual([
      { name: 'First Household', email: 'first-primary@example.com' },
      { name: 'Second Household', email: 'second-primary@example.com' },
    ]);
  });

  it('uses primaryEmail rather than a tampered primary flag to select membership metadata', async () => {
    const parsed = parsePeopleImportRecords([
      householdPrimaryRecord(1, {
        display_name: 'Authoritative Primary',
        email: 'authoritative@example.com',
      }),
      personRecord(2, {
        display_name: 'Flagged Other',
        email: 'other@example.com',
        household_key: 'family-1',
        household_role: 'child',
        household_primary: 'false',
      }),
    ]);
    const [authoritative, other] = parsed.model!.households[0].people;
    authoritative.household!.primary = false;
    other.household!.primary = true;

    await commitPeopleImport(env.DB, 'd1', parsed);

    expect(await env.DB.prepare(`
      SELECT p.email, hm.display_name, hm.role
      FROM household_members hm JOIN people p ON p.id = hm.person_id
      WHERE hm.is_primary = 1
    `).first()).toEqual({
      email: 'authoritative@example.com',
      display_name: 'Authoritative Primary',
      role: 'adult',
    });
  });

  it('fails safely instead of defaulting a missing primary household role', async () => {
    const parsed = parsePeopleImportRecords([householdPrimaryRecord(1)]);
    parsed.model!.households[0].people[0].household = null;
    const db = new AtomicRecordingDb(env.DB);

    const error = await commitPeopleImport(db, 'd1', parsed).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportPersistenceError);
    expect(error).toMatchObject({ code: 'import_failed' });
    expect(error).not.toHaveProperty('cause');
    expect(db.batchCalls).toBe(0);
    expect(await importTableCounts()).toEqual({ people: 0, households: 0, members: 0 });
  });
});

describe('commitPeopleImport atomic behavior and safe errors', () => {
  it('redacts an unexpected preflight query failure as import_failed', async () => {
    const privateDetail = 'private.preflight@example.com in SELECT email FROM people';
    const statement = {
      bind() { return statement; },
      first: async () => { throw new Error(privateDetail); },
      all: async () => { throw new Error(privateDetail); },
      run: async () => { throw new Error(privateDetail); },
    } as AppStatement;
    let batchCalls = 0;
    const db: AppDb = {
      prepare: () => statement,
      batch: async () => {
        batchCalls += 1;
        return [];
      },
    };
    const parsed = parsePeopleImportRecords([
      personRecord(1, { email: 'private.preflight@example.com' }),
    ]);

    const error = await commitPeopleImport(db, 'd1', parsed).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportPersistenceError);
    expect(error).toMatchObject({ code: 'import_failed' });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('detail');
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(privateDetail);
    expect(batchCalls).toBe(0);
  });

  it.each(['prepare', 'bind'] as const)(
    'redacts an unexpected synchronous write %s failure as import_failed',
    async (phase) => {
      const privateDetail = `private.${phase}@example.com in INSERT INTO people`;
      let batchCalls = 0;
      const db: AppDb = {
        prepare(sql: string): AppStatement {
          if (!sql.startsWith('INSERT INTO people')) return env.DB.prepare(sql);
          if (phase === 'prepare') throw new Error(privateDetail);
          return {
            bind: () => { throw new Error(privateDetail); },
          } as unknown as AppStatement;
        },
        batch: async () => {
          batchCalls += 1;
          return [];
        },
      };
      const parsed = parsePeopleImportRecords([
        personRecord(1, { email: `private.${phase}@example.com` }),
      ]);

      const error = await commitPeopleImport(db, 'd1', parsed).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PeopleImportPersistenceError);
      expect(error).toMatchObject({ code: 'import_failed' });
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('detail');
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(privateDetail);
      expect(batchCalls).toBe(0);
    },
  );

  it('maps a synchronous unique bind failure to a redacted import_conflict', async () => {
    const privateDetail = 'UNIQUE constraint failed: private.unique@example.com';
    let batchCalls = 0;
    const db: AppDb = {
      prepare(sql: string): AppStatement {
        if (!sql.startsWith('INSERT INTO people')) return env.DB.prepare(sql);
        return {
          bind: () => { throw new Error(privateDetail); },
        } as unknown as AppStatement;
      },
      batch: async () => {
        batchCalls += 1;
        return [];
      },
    };
    const parsed = parsePeopleImportRecords([
      personRecord(1, { email: 'private.unique@example.com' }),
    ]);

    const error = await commitPeopleImport(db, 'd1', parsed).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportConflictError);
    expect(error).toMatchObject({ code: 'import_conflict' });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('detail');
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(privateDetail);
    expect(batchCalls).toBe(0);
  });

  it('calls batch once, derives counts from arrays, and makes a second commit a zero-batch safe conflict', async () => {
    const parsed = parsePeopleImportRecords([
      householdPrimaryRecord(1),
      personRecord(2, {
        household_key: 'family-1',
        household_role: 'child',
        household_primary: 'false',
      }),
    ]);
    parsed.model!.summary = {
      dataRows: 999,
      people: 999,
      dependents: 999,
      households: 999,
      inactivePeople: 999,
    };
    const firstDb = new AtomicRecordingDb(env.DB);

    await expect(commitPeopleImport(firstDb, 'd1', parsed)).resolves.toEqual({
      people: 2,
      households: 1,
      dependents: 0,
    });
    expect(firstDb.batchCalls).toBe(1);
    const before = await importTableCounts();
    const secondDb = new AtomicRecordingDb(env.DB);

    const error = await commitPeopleImport(secondDb, 'd1', parsed).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportConflictError);
    expect(error).toMatchObject({ code: 'import_conflict' });
    expect(error).not.toHaveProperty('cause');
    expect(secondDb.batchCalls).toBe(0);
    expect(await importTableCounts()).toEqual(before);
  });

  it('rolls back earlier people when a later email becomes a unique conflict', async () => {
    const privateLateEmail = 'late.private@example.com';
    const parsed = parsePeopleImportRecords([
      personRecord(1, { email: 'early@example.com' }),
      personRecord(2, { email: privateLateEmail }),
    ]);
    const db = new AtomicRecordingDb(env.DB, async () => {
      await env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)')
        .bind('Racing Winner', privateLateEmail)
        .run();
    });

    const error = await commitPeopleImport(db, 'd1', parsed).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportConflictError);
    expect(error).toMatchObject({ code: 'import_conflict' });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('detail');
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/late\.private|UNIQUE constraint/i);
    expect(db.batchCalls).toBe(1);
    expect(await env.DB.prepare('SELECT email FROM people ORDER BY id').all()).toMatchObject({
      results: [{ email: privateLateEmail }],
    });
  });

  it.each([
    {
      label: 'a missing real-member lookup',
      privateValue: 'missing.private@example.com',
      parsed: () => {
        const parsed = parsePeopleImportRecords([
          householdPrimaryRecord(1),
          personRecord(2, {
            household_key: 'family-1',
            household_role: 'adult',
            household_primary: 'false',
          }),
        ]);
        const household = parsed.model!.households[0];
        household.people[1] = {
          ...household.people[1],
          email: 'missing.private@example.com',
        };
        return parsed;
      },
    },
    {
      label: 'a final invalid membership role',
      privateValue: 'guardian-private',
      parsed: () => {
        const parsed = parsePeopleImportRecords([
          householdPrimaryRecord(1),
          {
            record_type: 'dependent',
            display_name: 'Late Dependent',
            household_key: 'family-1',
            household_role: 'child',
          },
        ]);
        parsed.model!.households[0].dependents[0].household.role = 'guardian-private' as 'child';
        return parsed;
      },
    },
  ])('rolls back all three tables and maps $label to import_failed', async ({ parsed: makeParsed, privateValue }) => {
    const parsed = makeParsed();

    const error = await commitPeopleImport(env.DB, 'd1', parsed).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportPersistenceError);
    expect(error).toMatchObject({ code: 'import_failed' });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('detail');
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/FOREIGN KEY|CHECK constraint/i);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(privateValue);
    expect(await importTableCounts()).toEqual({ people: 0, households: 0, members: 0 });
  });
});

describe('commitPeopleImport SQL safety and maximum model', () => {
  it('keeps SQL-looking values in binds, stores them literally, and leaves the schema intact', async () => {
    const db = new AtomicRecordingDb(env.DB);

    await commitPeopleImport(db, 'd1', peopleImportFixture);

    const privateLiterals = [
      "Standalone O'Neil?",
      "1 Main St?; DROP TABLE people; --",
      "St. John's Family?",
      "2 Oak St'; DROP TABLE households; --",
      'Kid ?); DELETE FROM people; --',
    ];
    const writeCalls = db.prepared.filter((call) => call.operation === null);
    for (const literal of privateLiterals) {
      expect(writeCalls.some((call) => call.sql.includes(literal))).toBe(false);
      expect(writeCalls.some((call) => call.values.includes(literal))).toBe(true);
    }
    expect(await env.DB.prepare('SELECT address FROM people WHERE email = ?')
      .bind('standalone@example.com').first()).toEqual({
      address: "1 Main St?; DROP TABLE people; --",
    });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people').first<number>('n')).toBe(5);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM households').first<number>('n')).toBe(2);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM household_members').first<number>('n')).toBe(5);
  });

  it('executes the 200-person, 100-household model as one 500-statement D1 batch', async () => {
    const records: Array<Partial<Record<PeopleImportHeader, string>>> = [];
    for (let family = 0; family < 100; family += 1) {
      const primary = family * 2;
      const other = primary + 1;
      records.push(householdPrimaryRecord(primary));
      records.push(personRecord(other, {
        household_key: `family-${primary}`,
        household_role: family % 2 === 0 ? 'adult' : 'child',
        household_primary: 'false',
      }));
    }
    const parsed = parsePeopleImportRecords(records);
    expect(parsed.errors).toEqual([]);
    expect(parsed.model?.people).toHaveLength(200);
    expect(parsed.model?.households).toHaveLength(100);
    const db = new AtomicRecordingDb(env.DB);

    await expect(commitPeopleImport(db, 'd1', parsed)).resolves.toEqual({
      people: 200,
      households: 100,
      dependents: 0,
    });
    expect(db.batchCalls).toBe(1);
    expect(db.lastBatchSize).toBe(500);
    expect(await importTableCounts()).toEqual({ people: 200, households: 100, members: 200 });
    const { results } = await env.DB.prepare(`
      SELECT h.name, COUNT(*) AS member_count,
             SUM(CASE WHEN hm.is_primary = 1 THEN 1 ELSE 0 END) AS primary_count,
             SUM(CASE WHEN hm.person_id IS NULL THEN 1 ELSE 0 END) AS missing_people
      FROM households h JOIN household_members hm ON hm.household_id = h.id
      GROUP BY h.id, h.name ORDER BY h.id
    `).all<{ name: string; member_count: number; primary_count: number; missing_people: number }>();
    expect(results).toHaveLength(100);
    expect(results.every((row) => row.member_count === 2
      && row.primary_count === 1
      && row.missing_people === 0)).toBe(true);
  }, 20_000);
});
