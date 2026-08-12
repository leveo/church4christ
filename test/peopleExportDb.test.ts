import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AppDb, AppDbResult, AppStatement } from '../src/lib/appDb';
import { appendAuditEvent } from '../src/lib/auditDb';
import { buildCanonicalExportParts } from '../src/lib/peopleExport';
import {
  loadCanonicalPeopleExport,
  loadPastoralNotesExport,
} from '../src/lib/peopleExportDb';
import {
  buildPastoralNotesExport,
  PASTORAL_NOTES_EXPORT_HEADERS,
  PASTORAL_NOTES_EXPORT_LIMITS,
  type PastoralNotesExportResult,
  type PastoralNotesExportSource,
} from '../src/lib/pastoralNotesExport';
import {
  EXPORT_TODAY,
  expectedCanonicalPeopleExportSource,
  seedPortableExportFixture,
} from './fixtures/peopleExportDb';

interface PreparedCall {
  sql: string;
  values: unknown[];
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

  first<T = unknown>(column?: string): Promise<T | null> {
    return this.bound.first<T>(column);
  }

  all<T = unknown>(): Promise<AppDbResult<T>> {
    return this.bound.all<T>();
  }

  run<T = unknown>(): Promise<AppDbResult<T>> {
    return this.bound.run<T>();
  }

  raw(): AppStatement {
    return this.bound;
  }
}

class TrackingDb implements AppDb {
  readonly prepared: PreparedCall[] = [];
  batchCalls = 0;
  batchSizes: number[] = [];

  constructor(private readonly delegate: AppDb) {}

  prepare(sql: string): AppStatement {
    const call = { sql, values: [] as unknown[] };
    this.prepared.push(call);
    return new TrackedStatement(this.delegate.prepare(sql), call);
  }

  async batch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    this.batchCalls += 1;
    this.batchSizes.push(statements.length);
    return this.delegate.batch<T>(statements.map((statement) => {
      if (!(statement instanceof TrackedStatement)) throw new Error('untracked statement');
      return statement.raw();
    }));
  }
}

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM audit_events'),
    env.DB.prepare('DELETE FROM person_notes'),
    env.DB.prepare('DELETE FROM household_members'),
    env.DB.prepare('DELETE FROM households'),
    env.DB.prepare('DELETE FROM people'),
  ]);
}

beforeEach(reset);

describe('portable export migration', () => {
  it('creates a PII-minimal audit table with actor FK, exact kind, bounded counts, and actor/time index', async () => {
    const { results: columns } = await env.DB.prepare('PRAGMA table_info(audit_events)')
      .all<{ name: string }>();
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'actor_person_id',
      'action_kind',
      'structural_counts_json',
      'created_at',
    ]);
    for (const forbidden of ['email', 'name', 'body', 'filename', 'csv', 'note']) {
      expect(columns.some((column) => column.name.includes(forbidden))).toBe(false);
    }

    const { results: foreignKeys } = await env.DB.prepare('PRAGMA foreign_key_list(audit_events)')
      .all<{ from: string; table: string; to: string }>();
    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'actor_person_id', table: 'people', to: 'id' }),
    ]));

    const table = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'",
    ).first<{ sql: string }>();
    expect(table?.sql).toContain("action_kind IN ('people_notes_export_generated')");
    expect(table?.sql).toMatch(/length\s*\(\s*structural_counts_json\s*\)\s+BETWEEN\s+2\s+AND\s+256/i);

    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_audit_events_actor_created'",
    ).first<{ sql: string }>();
    expect(index?.sql).toMatch(/actor_person_id\s*,\s*created_at/i);
  });

  it('enforces the actor FK, exact kind allowlist, and structural JSON length at the schema boundary', async () => {
    await env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Actor', 'actor@example.com')")
      .run();

    await expect(env.DB.prepare(`
      INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
      VALUES (999, 'people_notes_export_generated', '{"people":0,"notes":0}')
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
      VALUES (1, 'other_kind', '{"people":0,"notes":0}')
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
      VALUES (1, 'people_notes_export_generated', '')
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
      VALUES (?, 'people_notes_export_generated', ?)
    `).bind(1, 'x'.repeat(257)).run()).rejects.toThrow();
  });

  it('accepts only canonical numeric people/notes JSON at the database boundary', async () => {
    await env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Actor', 'actor@example.com')")
      .run();
    for (const counts of [
      '{"people":0,"notes":0}',
      '{"people":5000,"notes":5000}',
    ]) {
      await expect(env.DB.prepare(`
        INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
        VALUES (1, 'people_notes_export_generated', ?)
      `).bind(counts).run()).resolves.not.toThrow();
    }

    for (const counts of [
      'not-json-private@example.com',
      '[]',
      '{}',
      '{"people":1}',
      '{"people":1,"notes":1,"body":"PRIVATE PASTORAL NOTE"}',
      '{"people":"1","notes":1}',
      '{"people":true,"notes":1}',
      '{"people":1,"notes":null}',
      '{"people":1.5,"notes":1}',
      '{"people":-1,"notes":1}',
      '{"people":1,"notes":5001}',
    ]) {
      await expect(env.DB.prepare(`
        INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
        VALUES (1, 'people_notes_export_generated', ?)
      `).bind(counts).run()).rejects.toThrow();
    }

    const { results } = await env.DB.prepare(`
      SELECT structural_counts_json FROM audit_events ORDER BY id
    `).all<{ structural_counts_json: string }>();
    expect(results).toEqual([
      { structural_counts_json: '{"people":0,"notes":0}' },
      { structural_counts_json: '{"people":5000,"notes":5000}' },
    ]);
    expect(JSON.stringify(results)).not.toMatch(/PRIVATE PASTORAL NOTE|private@example/i);
  });
});

describe('loadCanonicalPeopleExport', () => {
  it('takes one fixed read-only batch and returns only live safe canonical data, including inactive people and name-only dependents', async () => {
    await seedPortableExportFixture(env.DB);
    const db = new TrackingDb(env.DB);

    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY);

    expect(source).toEqual(expectedCanonicalPeopleExportSource());
    expect(db.batchCalls).toBe(1);
    expect(db.batchSizes).toEqual([3]);
    expect(db.prepared).toHaveLength(3);
    expect(db.prepared.every((call) => call.values.length === 0)).toBe(true);
    expect(db.prepared.every((call) => /^\s*SELECT\b/i.test(call.sql))).toBe(true);
    expect(db.prepared.every((call) => /LIMIT\s+5001\b/i.test(call.sql))).toBe(true);

    const peopleSql = db.prepared.find((call) => /FROM\s+people\b/i.test(call.sql))?.sql ?? '';
    for (const forbidden of [
      'role',
      'avatar_url',
      'session_epoch',
      'calendar_token',
      'super_admin',
      'admin_areas',
      'finance',
      'stripe_customer_id',
      'pending_email',
      'person_notes',
      'body',
      'author_email',
    ]) {
      expect(peopleSql).not.toMatch(new RegExp(`\\b${forbidden}\\b`, 'i'));
    }

    const result = buildCanonicalExportParts(source);
    const expected = buildCanonicalExportParts(expectedCanonicalPeopleExportSource());
    expect(result).toEqual(expected);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    const allCsv = result.parts.map((part) => part.csv).join('\n');
    expect(allCsv).toContain('Beta Inactive');
    expect(allCsv).toContain("'=Formula Child");
    expect(allCsv).toContain('Café Family');
    expect(allCsv).not.toMatch(/Deleted Person|Deleted Household|Historical Display|admin_areas/i);
  });

  it('preserves an orphan real member and an empty live household as bounded repair-required structure', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Live Primary', 'live@example.com')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email, deleted_at) VALUES (2, 'Deleted Member', 'deleted@example.com', '2026-01-01')"),
      env.DB.prepare("INSERT INTO households (id, name) VALUES (10, 'Malformed Household')"),
      env.DB.prepare("INSERT INTO households (id, name) VALUES (11, 'Empty Household')"),
      env.DB.prepare("INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (10, 1, 'Live Primary', 'adult', 1)"),
      env.DB.prepare("INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (10, 2, 'Deleted Member', 'adult', 0)"),
    ]);

    const source = await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY);
    const result = buildCanonicalExportParts(source);

    expect(result.status).toBe('repair_required');
    if (result.status !== 'repair_required') throw new Error('expected repair_required');
    expect(result.counts.issues).toBeGreaterThan(0);
    expect(Object.values(result.counts).every(Number.isSafeInteger)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/csv|Deleted Member|Malformed Household|deleted@example/i);
  });

  it('counts every membership row attached to a soft-deleted household and returns no CSV or deleted-household PII', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Live Person', 'live@example.com')"),
      env.DB.prepare("INSERT INTO households (id, name, deleted_at) VALUES (10, 'Private Deleted Household', '2026-01-01')"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (100, 10, 1, 'Live Person', 'adult', 1)"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (101, 10, NULL, 'Private Deleted Dependent', 'child', 0)"),
    ]);

    const source = await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY);
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBe(2);
    expect(source.people).toEqual([expect.objectContaining({
      email: 'live@example.com',
      household: null,
    })]);
    expect(source.dependents).toEqual([]);
    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 1, dependents: 0, households: 0, issues: 2 },
    });
    expect(JSON.stringify(result)).not.toMatch(/csv|Private Deleted Household|Private Deleted Dependent|live@example/i);
  });

  it('keeps equal normalized household names and Unicode ordering deterministic', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (20, 'Zeta Primary', 'zeta@example.com')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (10, 'Alpha Primary', 'alpha@example.com')"),
      env.DB.prepare("INSERT INTO households (id, name) VALUES (20, 'Café Family')"),
      env.DB.prepare("INSERT INTO households (id, name) VALUES (10, 'Café Family')"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (20, 20, 20, 'Zeta Primary', 'adult', 1)"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (10, 10, 10, 'Alpha Primary', 'adult', 1)"),
    ]);

    const first = buildCanonicalExportParts(await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY));
    const second = buildCanonicalExportParts(await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY));

    expect(first).toEqual(second);
    expect(first.status).toBe('success');
    if (first.status !== 'success') throw new Error('expected success');
    expect(first.parts[0].csv.indexOf('alpha@example.com')).toBeLessThan(
      first.parts[0].csv.indexOf('zeta@example.com'),
    );
    expect(first.parts[0].csv).not.toContain('Café Family');
    expect(first.parts[0].csv.match(/Café Family/g)).toHaveLength(2);
  });

  it('uses the limit-plus-one canonical snapshot to fail closed without partial CSV', async () => {
    await env.DB.prepare(`
      WITH RECURSIVE sequence(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM sequence WHERE n < 5001
      )
      INSERT INTO people (id, display_name, email)
      SELECT n, 'Bounded Person ' || n, 'bounded-' || n || '@example.com'
      FROM sequence
    `).run();

    const source = await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY);
    const result = buildCanonicalExportParts(source);

    expect(source.people).toHaveLength(5001);
    expect(source.integrityIssues).toBeGreaterThan(0);
    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 201, dependents: 0, households: 0, issues: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('csv');
  });
});

describe('pastoral notes export', () => {
  it('loads one bounded live-subject/live-note snapshot and emits deterministic NFC CRLF CSV with formula safety and historical author text', async () => {
    await seedPortableExportFixture(env.DB);
    const db = new TrackingDb(env.DB);

    const source = await loadPastoralNotesExport(db);
    const result = buildPastoralNotesExport(source);

    expect(db.batchCalls).toBe(1);
    expect(db.batchSizes).toEqual([1]);
    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0].values).toEqual([]);
    expect(db.prepared[0].sql).toMatch(/LIMIT\s+5001\b/i);
    expect(db.prepared[0].sql).toMatch(/n\.deleted_at\s+IS\s+NULL/i);
    expect(db.prepared[0].sql).toMatch(/p\.deleted_at\s+IS\s+NULL/i);
    expect(db.prepared[0].sql).not.toMatch(/\b(role|super_admin|admin_areas|session_epoch|calendar_token|avatar_url)\b/i);

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.counts).toEqual({ people: 2, notes: 2 });
    expect(result.csv).toBe(
      `${PASTORAL_NOTES_EXPORT_HEADERS.join(',')}\r\n`
      + `person-1,beta@example.com,'+departed.author@example.com,"Line one,\nline two",2026-08-09 08:00:00\r\n`
      + `person-2,zeta@example.com,former.author@example.com,'=Call after service,2026-08-10 09:00:00\r\n`,
    );
    expect(result.csv).not.toMatch(/Deleted note body|Deleted subject body|deleted-note-author/i);
    expect(result.csv).not.toMatch(/\b(?:200|201|202|203)\b/);
  });

  it('is deterministic across source order and keeps author attribution independent from resolvable people', () => {
    const source: PastoralNotesExportSource = {
      notes: [
        {
          stableKey: 'note-z',
          personStableKey: 'person-z',
          personEmail: ' ZETA@EXAMPLE.COM ',
          authorAttribution: 'former.account@example.com',
          body: 'Second',
          createdAt: '2026-08-11 10:00:00',
        },
        {
          stableKey: 'note-a',
          personStableKey: 'person-z',
          personEmail: 'zeta@example.com',
          authorAttribution: 'renamed-or-deleted@example.com',
          body: 'First',
          createdAt: '2026-08-10 10:00:00',
        },
      ],
    };

    const forward = buildPastoralNotesExport(source);
    const reversed = buildPastoralNotesExport({ notes: [...source.notes].reverse() });

    expect(forward).toEqual(reversed);
    expect(JSON.stringify(forward)).not.toContain('authorPersonId');
    expect(JSON.stringify(forward)).not.toContain('author_person_id');
  });

  it('orders double-digit person references by assigned ordinal rather than lexicographically', () => {
    const result = buildPastoralNotesExport({
      notes: Array.from({ length: 12 }, (_, index) => ({
        stableKey: `note-${index + 1}`,
        personStableKey: `subject-${index + 1}`,
        personEmail: `person-${String(index + 1).padStart(2, '0')}@example.com`,
        authorAttribution: 'historical@example.com',
        body: `Body ${index + 1}`,
        createdAt: '2026-08-11 00:00:00',
      })).reverse(),
    });

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.csv.split('\r\n').slice(1, -1).map((row) => row.split(',')[0])).toEqual(
      Array.from({ length: 12 }, (_, index) => `person-${index + 1}`),
    );
  });

  it('fails closed with numeric-only bounded results for invalid runtime data, too many notes, and oversized UTF-8 CSV', () => {
    const privateBody = 'Private invalid pastoral body';
    const invalid = buildPastoralNotesExport({
      notes: [{
        stableKey: 'note-private',
        personStableKey: 'person-private',
        personEmail: 'private@example.com',
        authorAttribution: 'private-author@example.com',
        body: privateBody,
        createdAt: 42,
      }],
    } as unknown as PastoralNotesExportSource);
    const tooMany = buildPastoralNotesExport({
      notes: Array.from({ length: PASTORAL_NOTES_EXPORT_LIMITS.maxNotes + 1 }, (_, index) => ({
        stableKey: `note-${index}`,
        personStableKey: 'person-1',
        personEmail: 'private@example.com',
        authorAttribution: 'private-author@example.com',
        body: privateBody,
        createdAt: '2026-08-11 00:00:00',
      })),
    });
    const tooLarge = buildPastoralNotesExport({
      notes: [{
        stableKey: 'note-large',
        personStableKey: 'person-large',
        personEmail: 'large@example.com',
        authorAttribution: 'author@example.com',
        body: '😀'.repeat(Math.ceil(PASTORAL_NOTES_EXPORT_LIMITS.maxCsvBytes / 4)),
        createdAt: '2026-08-11 00:00:00',
      }],
    });

    for (const result of [invalid, tooMany, tooLarge]) {
      expect(result.status).toBe('repair_required');
      if (result.status !== 'repair_required') throw new Error('expected repair_required');
      expect(Object.keys(result).sort()).toEqual(['counts', 'status']);
      expect(Object.values(result.counts).every(Number.isSafeInteger)).toBe(true);
      expect(Object.values(result.counts).every((value) => value >= 0)).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/csv|Private invalid|private@example|pastoral body/i);
    }
    expect(tooMany).toEqual({
      status: 'repair_required',
      counts: { people: 0, notes: 5001, issues: 1 },
    });
  });

  it('exposes a discriminated result that never places CSV on repair results', () => {
    expectTypeOf<Extract<PastoralNotesExportResult, { status: 'success' }>>().toEqualTypeOf<{
      status: 'success';
      counts: { people: number; notes: number };
      csv: string;
    }>();
    expectTypeOf<Extract<PastoralNotesExportResult, { status: 'repair_required' }>>().toEqualTypeOf<{
      status: 'repair_required';
      counts: { people: number; notes: number; issues: number };
    }>();
  });

  it('uses the limit-plus-one note snapshot to fail closed without a partial CSV', async () => {
    await env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Subject', 'subject@example.com')")
      .run();
    await env.DB.prepare(`
      WITH RECURSIVE sequence(n) AS (
        SELECT 1
        UNION ALL
        SELECT n + 1 FROM sequence WHERE n < 5001
      )
      INSERT INTO person_notes (id, person_id, author_email, body, created_at)
      SELECT n, 1, 'historical@example.com', 'Bounded note', '2026-08-11 00:00:00'
      FROM sequence
    `).run();

    const source = await loadPastoralNotesExport(env.DB);
    const result = buildPastoralNotesExport(source);

    expect(source.notes).toHaveLength(5001);
    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 0, notes: 5001, issues: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('csv');
  });
});

describe('appendAuditEvent', () => {
  it('accepts only canonical structural counts and inserts one parameterized PII-free row', async () => {
    await env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Actor', 'actor@example.com')")
      .run();
    const db = new TrackingDb(env.DB);

    await appendAuditEvent(db, {
      kind: 'people_notes_export_generated',
      actorPersonId: 1,
      counts: { people: 1, notes: 2 },
    });

    expect(db.batchCalls).toBe(0);
    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0].sql).toMatch(/^\s*INSERT\s+INTO\s+audit_events\b/i);
    expect(db.prepared[0].sql).not.toMatch(/actor@example|private|note body/i);
    expect(db.prepared[0].values).toEqual([
      1,
      'people_notes_export_generated',
      '{"people":1,"notes":2}',
    ]);
    const row = await env.DB.prepare(`
      SELECT actor_person_id, action_kind, structural_counts_json, created_at
      FROM audit_events
    `).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      actor_person_id: 1,
      action_kind: 'people_notes_export_generated',
      structural_counts_json: '{"people":1,"notes":2}',
    });
    expect(typeof row?.created_at).toBe('string');
  });

  it.each([
    [{ kind: 'other_kind', actorPersonId: 1, counts: { people: 1, notes: 1 } }],
    [{ kind: 'people_notes_export_generated', actorPersonId: 0, counts: { people: 1, notes: 1 } }],
    [{ kind: 'people_notes_export_generated', actorPersonId: 1.5, counts: { people: 1, notes: 1 } }],
    [{ kind: 'people_notes_export_generated', actorPersonId: 1, counts: { people: -1, notes: 1 } }],
    [{ kind: 'people_notes_export_generated', actorPersonId: 1, counts: { people: 1, notes: 5001 } }],
    [{ kind: 'people_notes_export_generated', actorPersonId: 1, counts: { people: 1, notes: 1, body: 2 } }],
    [{ kind: 'people_notes_export_generated', actorPersonId: 1, counts: [1, 2] }],
  ])('rejects malformed runtime input before database access', async (input) => {
    const db = {
      prepare: vi.fn(() => { throw new Error('must not prepare'); }),
      batch: vi.fn(() => { throw new Error('must not batch'); }),
    } satisfies AppDb;

    await expect(appendAuditEvent(db, input as never)).rejects.toThrow('audit_event_invalid');
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('maps database errors and zero-change writes to one constant safe failure without a cause', async () => {
    const privateMessage = 'private@example.com duplicate payload';
    const failingDb = {
      prepare: () => ({
        bind: () => ({
          bind: vi.fn(),
          first: vi.fn(),
          all: vi.fn(),
          run: vi.fn().mockRejectedValue(new Error(privateMessage)),
        }),
        first: vi.fn(),
        all: vi.fn(),
        run: vi.fn(),
      }),
      batch: vi.fn(),
    } satisfies AppDb;
    const zeroChangeDb = {
      prepare: () => ({
        bind: () => ({
          bind: vi.fn(),
          first: vi.fn(),
          all: vi.fn(),
          run: vi.fn().mockResolvedValue({ results: [], meta: { changes: 0 } }),
        }),
        first: vi.fn(),
        all: vi.fn(),
        run: vi.fn(),
      }),
      batch: vi.fn(),
    } satisfies AppDb;
    const input = {
      kind: 'people_notes_export_generated' as const,
      actorPersonId: 1,
      counts: { people: 1, notes: 1 },
    };

    for (const db of [failingDb, zeroChangeDb]) {
      const error = await appendAuditEvent(db, input).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ message: 'audit_event_failed' });
      expect(error).not.toHaveProperty('cause');
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(privateMessage);
    }
  });

  it('maps hostile runtime getters to a constant invalid-input error without leaking their message', async () => {
    const privateMessage = 'private.person@example.com getter failure';
    const input = new Proxy({}, {
      get: () => { throw new Error(privateMessage); },
    });
    const db = {
      prepare: vi.fn(() => { throw new Error('must not prepare'); }),
      batch: vi.fn(() => { throw new Error('must not batch'); }),
    } satisfies AppDb;

    const error = await appendAuditEvent(db, input as never).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: 'audit_event_invalid' });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(privateMessage);
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
