import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb, AppDbResult, AppStatement } from '../../src/lib/appDb';
import {
  PeopleImportConflictError,
  PeopleImportPersistenceError,
  commitPeopleImport,
  preflightPeopleImport,
} from '../../src/lib/peopleImportDb';
import type { PeopleImportHeader } from '../../src/lib/peopleImport';
import { PgAdapter } from '../../src/lib/pgAdapter';
import {
  parsePeopleImportRecords,
  peopleImportFixture,
} from '../fixtures/peopleImport';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

interface PreparedCall {
  sql: string;
  values: unknown[];
  operation: 'first' | 'all' | 'run' | null;
}

class TrackedStatement implements AppStatement {
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

class TrackingDb implements AppDb {
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
    return new TrackedStatement(this.delegate.prepare(sql), call);
  }

  async batch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    this.batchCalls += 1;
    this.lastBatchSize = statements.length;
    await this.beforeBatch?.();
    return this.delegate.batch<T>(statements.map((statement) => {
      if (!(statement instanceof TrackedStatement)) {
        throw new Error('unexpected untracked statement');
      }
      return statement.raw();
    }));
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

describe.skipIf(!hasPg)('people import persistence (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });

  beforeEach(async () => {
    await sql.unsafe('TRUNCATE TABLE household_members, households, people RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await sql?.end();
  });

  const tableCounts = async (): Promise<{ people: number; households: number; members: number }> => {
    const [people, households, members] = await Promise.all([
      db.prepare('SELECT COUNT(*)::int AS n FROM people').first<number>('n'),
      db.prepare('SELECT COUNT(*)::int AS n FROM households').first<number>('n'),
      db.prepare('SELECT COUNT(*)::int AS n FROM household_members').first<number>('n'),
    ]);
    return { people: people ?? 0, households: households ?? 0, members: members ?? 0 };
  };

  it('preflights live and soft-deleted emails plus only live canonical household names without writes', async () => {
    const parsed = parsePeopleImportRecords([
      personRecord(1, { email: 'live@example.com' }),
      personRecord(2, { email: 'deleted@example.com' }),
      householdPrimaryRecord(3, {
        email: 'new-primary@example.com',
        household_name: 'Caf\u00e9 Family',
      }),
      householdPrimaryRecord(4, {
        email: 'archived-primary@example.com',
        household_name: 'Archived Family',
      }),
    ]);
    await db.batch([
      db.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)')
        .bind('Live', '  LIVE@EXAMPLE.COM  '),
      db.prepare('INSERT INTO people (display_name, email, deleted_at) VALUES (?, ?, ?)')
        .bind('Deleted', 'deleted@example.com', '2026-01-01'),
      db.prepare('INSERT INTO households (name) VALUES (?)').bind('  CAFE\u0301 FAMILY  '),
      db.prepare('INSERT INTO households (name, deleted_at) VALUES (?, ?)')
        .bind('ARCHIVED FAMILY', '2026-01-01'),
    ]);
    const before = await tableCounts();

    const result = await preflightPeopleImport(db, parsed);

    expect(result).toEqual({
      errors: [2, 3].map((row) => ({
        severity: 'error', code: 'email_exists', row, field: 'email',
      })),
      warnings: [{
        severity: 'warning', code: 'household_name_exists', row: 4, field: 'household_name',
      }],
    });
    expect(await tableCounts()).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/live@example|deleted@example|Caf/i);
  });

  it('persists the shared fixture with ordered memberships, blank names, active flags, and safe defaults', async () => {
    const result = await commitPeopleImport(db, 'supabase', peopleImportFixture);

    expect(result).toEqual({ people: 5, households: 2, dependents: 1 });
    const { results: people } = await db.prepare(`
      SELECT id, first_name, last_name, email, role, active, lang,
             birthday, address, membership_status, joined_on,
             finance, super_admin, admin_areas, session_epoch, calendar_token,
             avatar_url, deleted_at, pending_email, stripe_customer_id
      FROM people ORDER BY id
    `).all<Record<string, unknown>>();
    expect(people.map((person) => ({
      id: person.id,
      first_name: person.first_name,
      last_name: person.last_name,
      email: person.email,
      active: person.active,
      lang: person.lang,
      membership_status: person.membership_status,
    }))).toEqual([
      { id: 1, first_name: '', last_name: "O'Neil", email: 'standalone@example.com', active: 0, lang: 'en', membership_status: 'inactive' },
      { id: 2, first_name: '', last_name: '', email: 'mina@example.com', active: 1, lang: null, membership_status: 'visitor' },
      { id: 3, first_name: 'Pat', last_name: '', email: 'pat@example.com', active: 1, lang: 'zh', membership_status: 'member' },
      { id: 4, first_name: 'Robin', last_name: 'Question?', email: 'robin@example.com', active: 1, lang: null, membership_status: 'visitor' },
      { id: 5, first_name: '', last_name: '', email: 'taylor@example.com', active: 1, lang: null, membership_status: 'visitor' },
    ]);
    expect(people.every((person) => person.role === 'member'
      && person.finance === 0
      && person.super_admin === 0
      && person.admin_areas === ''
      && person.session_epoch === 0
      && person.calendar_token === null
      && person.avatar_url === null
      && person.deleted_at === null
      && person.pending_email === null
      && person.stripe_customer_id === null)).toBe(true);
    expect(people[0]).toMatchObject({
      birthday: '1990-02-03',
      address: "1 Main St?; DROP TABLE people; --",
      joined_on: '2020-04-05',
    });

    const { results: members } = await db.prepare(`
      SELECT h.id AS household_id, h.name AS household_name, p.email,
             hm.display_name, hm.role, hm.is_primary, hm.is_owner,
             CASE WHEN hm.person_id IS NULL THEN 1 ELSE 0 END AS dependent
      FROM household_members hm
      JOIN households h ON h.id = hm.household_id
      LEFT JOIN people p ON p.id = hm.person_id
      ORDER BY h.id, hm.id
    `).all();
    expect(members).toEqual([
      { household_id: 1, household_name: "St. John's Family?", email: 'pat@example.com', display_name: "Pat O'Primary", role: 'adult', is_primary: 1, is_owner: 0, dependent: 0 },
      { household_id: 1, household_name: "St. John's Family?", email: 'mina@example.com', display_name: 'Mina Child', role: 'child', is_primary: 0, is_owner: 0, dependent: 0 },
      { household_id: 1, household_name: "St. John's Family?", email: null, display_name: 'Kid ?); DELETE FROM people; --', role: 'child', is_primary: 0, is_owner: 0, dependent: 1 },
      { household_id: 2, household_name: "St. John's Family?", email: 'robin@example.com', display_name: 'Robin Primary', role: 'adult', is_primary: 1, is_owner: 0, dependent: 0 },
      { household_id: 2, household_name: "St. John's Family?", email: 'taylor@example.com', display_name: 'Taylor Adult', role: 'adult', is_primary: 0, is_owner: 0, dependent: 0 },
    ]);
  });

  it('binds each primary to the immediately preceding household sequence value', async () => {
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

    await commitPeopleImport(db, 'supabase', parsed);

    const { results } = await db.prepare(`
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

  it('maps a late 23505 membership conflict safely and rolls back people, households, and members', async () => {
    const privateEmail = 'private.primary@example.com';
    const parsed = parsePeopleImportRecords([
      householdPrimaryRecord(1, {
        household_key: 'first-family',
        household_name: 'First Family',
        email: privateEmail,
      }),
      householdPrimaryRecord(2, {
        household_key: 'second-family',
        household_name: 'Second Family',
        email: 'second.primary@example.com',
      }),
    ]);
    const firstPrimary = parsed.model!.households[0].people[0];
    parsed.model!.households[1].primaryEmail = firstPrimary.email;
    parsed.model!.households[1].people[0] = firstPrimary;

    const error = await commitPeopleImport(db, 'supabase', parsed).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportConflictError);
    expect(error).toMatchObject({ code: 'import_conflict' });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('detail');
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/23505|duplicate key|private\.primary/i);
    expect(await tableCounts()).toEqual({ people: 0, households: 0, members: 0 });
  });

  it('maps a non-unique final-statement failure safely and rolls back the complete import', async () => {
    const privateRole = 'guardian-private';
    const parsed = parsePeopleImportRecords([
      householdPrimaryRecord(1),
      {
        record_type: 'dependent',
        display_name: 'Late Dependent',
        household_key: 'family-1',
        household_role: 'child',
      },
    ]);
    parsed.model!.households[0].dependents[0].household.role = privateRole as 'child';

    const error = await commitPeopleImport(db, 'supabase', parsed).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PeopleImportPersistenceError);
    expect(error).toMatchObject({ code: 'import_failed' });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('detail');
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/23514|check constraint|guardian-private/i);
    expect(await tableCounts()).toEqual({ people: 0, households: 0, members: 0 });
  });

  it('executes the maximum model in one 500-statement batch with every value bound', async () => {
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
    const trackingDb = new TrackingDb(db);

    await expect(commitPeopleImport(trackingDb, 'supabase', parsed)).resolves.toEqual({
      people: 200,
      households: 100,
      dependents: 0,
    });

    expect(trackingDb.batchCalls).toBe(1);
    expect(trackingDb.lastBatchSize).toBe(500);
    expect(trackingDb.prepared.every((call) => call.values.every((value) => value !== undefined))).toBe(true);
    expect(trackingDb.prepared.filter((call) => call.operation === null)
      .every((call) => !call.sql.includes('@example.com') && !call.sql.includes('Family 0'))).toBe(true);
    expect(await tableCounts()).toEqual({ people: 200, households: 100, members: 200 });
  }, 30_000);
});
