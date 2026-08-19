import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AppDb, AppDbResult, AppStatement } from '../src/lib/appDb';
import { softDeletePerson } from '../src/lib/adminDb';
import { appendAuditEvent } from '../src/lib/auditDb';
import { buildCanonicalExportParts } from '../src/lib/peopleExport';
import {
  loadCanonicalPeopleExport,
  loadPastoralNotesExport,
  PEOPLE_EXPORT_SNAPSHOT_LIMITS,
} from '../src/lib/peopleExportDb';
import {
  buildPastoralNotesExport,
  PASTORAL_NOTES_EXPORT_HEADERS,
  PASTORAL_NOTES_EXPORT_LIMITS,
  PASTORAL_NOTES_PERSON_REF_SCOPE,
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
  snapshotBatchCalls = 0;
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

  async snapshotBatch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    this.snapshotBatchCalls += 1;
    return this.batch(statements);
  }
}

class SnapshotStatsDb implements AppDb {
  constructor(
    private readonly delegate: AppDb,
    private readonly overrideStats: (row: Record<string, unknown>) => void,
  ) {}

  prepare(sql: string): AppStatement {
    return this.delegate.prepare(sql);
  }

  batch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    return this.delegate.batch<T>(statements);
  }

  async snapshotBatch<T = unknown>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    const results = await this.delegate.batch<T>(statements);
    const row = results[0]?.results[0];
    if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
      this.overrideStats(row as Record<string, unknown>);
    }
    return results;
  }
}

function stringifyAggregateStats(row: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(row)) {
    if ((key.endsWith('_count') || key.endsWith('_bytes')) && typeof value === 'number') {
      row[key] = String(value);
    }
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
      'campus_id',
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
      '{"people": 1,"notes":1}',
      '{"notes":1,"people":1}',
      '{"people":1,"people":1,"notes":1}',
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
  it('accepts canonical Postgres int8 aggregate strings for canonical and notes snapshots', async () => {
    await seedPortableExportFixture(env.DB);
    const db = new SnapshotStatsDb(env.DB, stringifyAggregateStats);

    const canonical = buildCanonicalExportParts(
      await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'd1'),
    );
    const notes = buildPastoralNotesExport(await loadPastoralNotesExport(db, 'd1'));

    expect(canonical).toEqual(buildCanonicalExportParts(expectedCanonicalPeopleExportSource()));
    expect(notes.status).toBe('success');
    if (notes.status !== 'success') throw new Error('expected success');
    expect(notes.counts).toEqual({ people: 3, notes: 3 });
  });

  it.each([
    ['whitespace', ' 1'],
    ['trailing whitespace', '1 '],
    ['explicit plus', '+1'],
    ['negative', '-1'],
    ['leading zero', '01'],
    ['empty string', ''],
    ['fraction', '1.5'],
    ['exponent', '1e1'],
    ['infinity string', 'Infinity'],
    ['unsafe decimal string', '9007199254740992'],
    ['numeric infinity', Number.POSITIVE_INFINITY],
    ['unsafe number', Number.MAX_SAFE_INTEGER + 1],
  ])('fails closed for %s aggregate stats without exposing export PII', async (_label, invalid) => {
    await seedPortableExportFixture(env.DB);
    const canonicalDb = new SnapshotStatsDb(env.DB, (row) => {
      stringifyAggregateStats(row);
      row.people_count = invalid;
    });
    const notesDb = new SnapshotStatsDb(env.DB, (row) => {
      stringifyAggregateStats(row);
      row.notes_count = invalid;
    });

    const canonical = buildCanonicalExportParts(
      await loadCanonicalPeopleExport(canonicalDb, EXPORT_TODAY, 'd1'),
    );
    const notes = buildPastoralNotesExport(await loadPastoralNotesExport(notesDb, 'd1'));

    expect(canonical.status).toBe('repair_required');
    expect(notes.status).toBe('repair_required');
    expect(JSON.stringify({ canonical, notes })).not.toMatch(
      /csv|zeta@example|beta@example|former\.author|Call after service/i,
    );
  });

  it('requires a real snapshot seam for Supabase before preparing or executing reads', async () => {
    const privateMessage = 'private.person@example.com must not escape';
    const prepare = vi.fn(() => { throw new Error(privateMessage); });
    const batch = vi.fn(async () => { throw new Error(privateMessage); });
    const db = { prepare, batch } as unknown as AppDb;

    const error = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'supabase')
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ message: 'export_snapshot_unavailable' });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(privateMessage);
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it('falls back to D1 transactional batch when snapshotBatch is unavailable', async () => {
    let batchCalls = 0;
    const delegate: AppDb = env.DB;
    const db: AppDb = {
      prepare: (sql) => delegate.prepare(sql),
      batch: async <T = unknown>(statements: AppStatement[]) => {
        batchCalls += 1;
        return delegate.batch<T>(statements);
      },
    };

    await expect(loadCanonicalPeopleExport(db, EXPORT_TODAY, 'd1')).resolves.toEqual({
      today: EXPORT_TODAY,
      people: [],
      dependents: [],
    });
    expect(batchCalls).toBe(1);
    expect(db.snapshotBatch).toBeUndefined();
  });

  it('takes one fixed read-only batch and returns only live safe canonical data, including inactive people and name-only dependents', async () => {
    await seedPortableExportFixture(env.DB);
    const db = new TrackingDb(env.DB);

    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'd1');

    expect(source).toEqual(expectedCanonicalPeopleExportSource());
    expect(db.snapshotBatchCalls).toBe(1);
    expect(db.batchCalls).toBe(1);
    expect(db.batchSizes).toEqual([4]);
    expect(db.prepared).toHaveLength(4);
    expect(db.prepared[0].values).toEqual([]);
    expect(db.prepared.slice(1).every((call) => call.values.length > 0)).toBe(true);
    expect(db.prepared.every((call) => /^\s*(?:SELECT|WITH)\b/i.test(call.sql))).toBe(true);
    expect(db.prepared[0].sql).toMatch(/total_bytes/i);
    expect(db.prepared[0].sql).toMatch(/length\s*\(\s*CAST\s*\(/i);
    expect(db.prepared[0].sql).toMatch(/COALESCE\s*\(\s*p\.lang\b/i);
    for (const call of db.prepared) {
      expect(call.sql).toMatch(/export_people\s+AS\s*\([\s\S]*?FROM\s+people\s+p[\s\S]*?ORDER\s+BY\s+p\.id[\s\S]*?LIMIT\s+5001[\s\S]*?\)/i);
      expect(call.sql).toMatch(/export_households\s+AS\s*\([\s\S]*?FROM\s+households\s+h[\s\S]*?ORDER\s+BY\s+h\.id[\s\S]*?LIMIT\s+5001[\s\S]*?\)/i);
      expect(call.sql).toMatch(/export_memberships\s+AS\s*\([\s\S]*?FROM\s+household_members\s+hm[\s\S]*?ORDER\s+BY\s+hm\.id[\s\S]*?LIMIT\s+5001[\s\S]*?\)/i);
      expect(call.sql).toMatch(/people_stats\s+AS\s*\([\s\S]*?COUNT\s*\(\s*\*\s*\)[\s\S]*?SUM\s*\([\s\S]*?FROM\s+export_people\s+p/i);
      expect(call.sql).toMatch(/household_stats\s+AS\s*\([\s\S]*?COUNT\s*\(\s*\*\s*\)[\s\S]*?SUM\s*\([\s\S]*?FROM\s+export_households\s+h/i);
      expect(call.sql).toMatch(/membership_stats\s+AS\s*\([\s\S]*?COUNT\s*\(\s*\*\s*\)[\s\S]*?SUM\s*\([\s\S]*?FROM\s+export_memberships\s+m/i);
      expect(call.sql).not.toMatch(/COUNT\s*\(\s*\*\s*\)\s+FROM\s+(?:people|households|household_members)\b/i);
    }
    expect(db.prepared.slice(1).every((call) => /LIMIT\s+5001\b/i.test(call.sql))).toBe(true);
    expect(db.prepared.slice(1).every((call) => /CASE\s+WHEN\s+length\s*\(/i.test(call.sql))).toBe(true);
    expect(db.prepared.slice(1).every((call) => call.values.includes(
      PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxCanonicalBytes,
    ))).toBe(true);

    const peopleSql = db.prepared.find((call) => /SELECT\s+p\.id\b/i.test(call.sql))?.sql ?? '';
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

  it('excludes a soft-deleted non-primary person membership and exports the remaining household', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Live Primary', 'live@example.com')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (2, 'Deleted Member', 'deleted@example.com')"),
      env.DB.prepare("INSERT INTO households (id, name) VALUES (10, 'Live Household')"),
      env.DB.prepare("INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (10, 1, 'Live Primary', 'adult', 1)"),
      env.DB.prepare("INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (10, 2, 'Deleted Member', 'adult', 0)"),
    ]);
    await softDeletePerson(env.DB, 2);

    const source = await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY, 'd1');
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBeUndefined();
    expect(source.people).toEqual([expect.objectContaining({
      email: 'live@example.com',
      household: expect.objectContaining({ stableKey: 'household-10', primary: true }),
    })]);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.parts[0].csv).toContain('live@example.com');
    expect(result.parts[0].csv).not.toMatch(/Deleted Member|deleted@example/i);
  });

  it('ignores every membership row under a soft-deleted household', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Live Person', 'live@example.com')"),
      env.DB.prepare("INSERT INTO households (id, name, deleted_at) VALUES (10, 'Private Deleted Household', '2026-01-01')"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (100, 10, 1, 'Live Person', 'adult', 1)"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (101, 10, NULL, 'Private Deleted Dependent', 'child', 0)"),
    ]);

    const source = await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY, 'd1');
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBeUndefined();
    expect(source.people).toEqual([expect.objectContaining({
      email: 'live@example.com',
      household: null,
    })]);
    expect(source.dependents).toEqual([]);
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.parts[0].csv).toContain('live@example.com');
    expect(result.parts[0].csv).not.toMatch(/Private Deleted Household|Private Deleted Dependent/i);
  });

  it('requires repair when a deleted primary leaves live secondary and dependent relationships', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Deleted Primary', 'deleted-primary@example.com')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (2, 'Live Secondary', 'secondary@example.com')"),
      env.DB.prepare("INSERT INTO households (id, name) VALUES (10, 'Needs Primary Household')"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (100, 10, 1, 'Deleted Primary', 'adult', 1)"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (101, 10, 2, 'Live Secondary', 'adult', 0)"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (102, 10, NULL, 'Live Dependent', 'child', 0)"),
    ]);
    await softDeletePerson(env.DB, 1);

    const source = await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY, 'd1');
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBeUndefined();
    expect(source.people).toEqual([expect.objectContaining({
      email: 'secondary@example.com',
      household: expect.objectContaining({ primary: false }),
    })]);
    expect(source.dependents).toHaveLength(1);
    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 1, dependents: 1, households: 1, issues: 1 },
    });
  });

  it('reports one empty-live-household issue when every residual member is soft-deleted', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email, deleted_at) VALUES (1, 'Deleted One', 'deleted-one@example.com', '2026-01-01')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email, deleted_at) VALUES (2, 'Deleted Two', 'deleted-two@example.com', '2026-01-01')"),
      env.DB.prepare("INSERT INTO households (id, name) VALUES (10, 'Empty Live Household')"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (100, 10, 1, 'Deleted One', 'adult', 1)"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (101, 10, 2, 'Deleted Two', 'adult', 0)"),
    ]);

    const source = await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY, 'd1');
    const result = buildCanonicalExportParts(source);

    expect(source).toEqual({
      today: EXPORT_TODAY,
      people: [],
      dependents: [],
      integrityIssues: 1,
    });
    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 0, dependents: 0, households: 0, issues: 1 },
    });
  });

  it('does not let a deleted household consume the membership snapshot bound', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO households (id, name, deleted_at) VALUES (10, 'Deleted Household', '2026-01-01')"),
      env.DB.prepare(`
        WITH RECURSIVE sequence(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 5001
        )
        INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary)
        SELECT n, 10, NULL, 'Deleted Dependent ' || n, 'child', 0 FROM sequence
      `),
    ]);

    const source = await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY, 'd1');
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBeUndefined();
    expect(result.status).toBe('success');
  });

  it('does not let deleted-person memberships consume the membership snapshot bound', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (10000, 'Live Primary', 'live@example.com')"),
      env.DB.prepare("INSERT INTO households (id, name) VALUES (11, 'Live Household')"),
      env.DB.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (1, 11, 10000, 'Live Primary', 'adult', 1)"),
      env.DB.prepare(`
        WITH RECURSIVE sequence(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 5000
        )
        INSERT INTO people (id, display_name, email, deleted_at)
        SELECT n, 'Deleted Person ' || n, 'deleted-' || n || '@example.com', '2026-01-01'
        FROM sequence
      `),
      env.DB.prepare(`
        WITH RECURSIVE sequence(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 5000
        )
        INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary)
        SELECT 10000 + n, 11, n, 'Deleted Person ' || n, 'adult', 0 FROM sequence
      `),
    ]);

    const source = await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY, 'd1');
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBeUndefined();
    expect(result.status).toBe('success');
  });

  it('keeps a genuinely missing person target as an orphan and empty-household repair issue', async () => {
    await env.DB.prepare("INSERT INTO households (id, name) VALUES (10, 'Orphan Household')").run();
    const delegate: AppDb = env.DB;
    const db: AppDb = {
      prepare: (sql) => delegate.prepare(sql),
      batch: <T = unknown>(statements: AppStatement[]) => delegate.batch<T>(statements),
      snapshotBatch: async <T = unknown>(statements: AppStatement[]) => {
        const results = await delegate.batch<T>(statements);
        Object.assign(results[0].results[0] as object, { memberships_count: 1 });
        results[3] = {
          results: [{
            id: 100,
            household_id: 10,
            person_id: 999,
            display_name: 'Missing Person',
            display_name_valid: 1,
            role: 'adult',
            is_primary: 1,
            household_exists: 1,
            household_live: 1,
            person_exists: 0,
            person_live: 0,
          } as T],
          success: true,
          meta: { changes: 0 },
        };
        return results;
      },
    };

    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'd1');
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBe(2);
    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 0, dependents: 0, households: 0, issues: 2 },
    });
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

    const first = buildCanonicalExportParts(await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY, 'd1'));
    const second = buildCanonicalExportParts(await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY, 'd1'));

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
    const privateTail = `PRIVATE-CANONICAL-TAIL-${'x'.repeat(900_000)}`;
    for (let index = 6001; index <= 6010; index += 1) {
      await env.DB.prepare(`
        INSERT INTO people (id, display_name, email, address)
        VALUES (?, ?, ?, ?)
      `).bind(index, `Tail ${index}`, `tail-${index}@example.com`, privateTail).run();
    }

    const db = new TrackingDb(env.DB);
    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'd1');
    const result = buildCanonicalExportParts(source);
    const stats = await env.DB.prepare(db.prepared[0].sql).first<{
      people_count: number;
      total_bytes: number;
    }>();

    expect(stats?.people_count).toBe(5001);
    expect(stats?.total_bytes).toBeLessThan(PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxCanonicalBytes);
    expect(source.people).toEqual([]);
    expect(source.integrityIssues).toBeGreaterThan(0);
    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 0, dependents: 0, households: 0, issues: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('csv');
  });

  it('does not return an oversized canonical database payload or materialize its corrupt text', async () => {
    const privatePrefix = 'PRIVATE-HUGE-CANONICAL-';
    const chunk = 'x'.repeat(900_000);
    for (let index = 1; index <= 10; index += 1) {
      await env.DB.prepare(`
        INSERT INTO people (id, display_name, email, address)
        VALUES (?, ?, ?, ?)
      `).bind(
        index,
        index === 1 ? privatePrefix : `Huge Person ${index}`,
        `huge-${index}@example.com`,
        chunk,
      ).run();
    }

    const source = await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY, 'd1');
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBeGreaterThan(0);
    expect(source.people).toEqual([]);
    expect(JSON.stringify(source)).not.toContain(privatePrefix);
    expect(result.status).toBe('repair_required');
    expect(JSON.stringify(result)).not.toMatch(/csv|PRIVATE-HUGE|huge@example/i);
  });

  it('marks an individually oversized nullable canonical field without returning its raw text', async () => {
    const privateAddress = `PRIVATE-OVERSIZED-ADDRESS-${'x'.repeat(1_000)}`;
    await env.DB.prepare(`
      INSERT INTO people (id, display_name, email, address)
      VALUES (1, 'Safe Person', 'safe@example.com', ?)
    `).bind(privateAddress).run();

    const source = await loadCanonicalPeopleExport(env.DB, EXPORT_TODAY, 'd1');
    const result = buildCanonicalExportParts(source);

    expect(source.people).toEqual([expect.objectContaining({ address: null })]);
    expect(source.integrityIssues).toBeGreaterThan(0);
    expect(JSON.stringify(source)).not.toContain(privateAddress);
    expect(result.status).toBe('repair_required');
    expect(JSON.stringify(result)).not.toMatch(/csv|PRIVATE-OVERSIZED-ADDRESS/i);
  });
});

describe('pastoral notes export', () => {
  it('requires a real snapshot seam for Supabase before preparing or executing note reads', async () => {
    const privateMessage = 'private.note@example.com must not escape';
    const prepare = vi.fn(() => { throw new Error(privateMessage); });
    const batch = vi.fn(async () => { throw new Error(privateMessage); });
    const db = { prepare, batch } as unknown as AppDb;

    const error = await loadPastoralNotesExport(db, 'supabase').catch((caught: unknown) => caught);

    expect(error).toMatchObject({ message: 'export_snapshot_unavailable' });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(privateMessage);
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it('loads one bounded live-subject/live-note snapshot and emits deterministic NFC CRLF CSV with formula safety and historical author text', async () => {
    await seedPortableExportFixture(env.DB);
    const db = new TrackingDb(env.DB);

    const source = await loadPastoralNotesExport(db, 'd1');
    const result = buildPastoralNotesExport(source);

    expect(db.snapshotBatchCalls).toBe(1);
    expect(db.batchCalls).toBe(1);
    expect(db.batchSizes).toEqual([3]);
    expect(db.prepared).toHaveLength(3);
    expect(db.prepared[0].values).toEqual([]);
    expect(db.prepared[0].sql).toMatch(/total_bytes/i);
    expect(db.prepared[0].sql).toMatch(/length\s*\(\s*CAST\s*\(/i);
    for (const call of db.prepared) {
      expect(call.sql).toMatch(/export_notes\s+AS\s*\([\s\S]*?FROM\s+person_notes\s+n[\s\S]*?ORDER\s+BY\s+n\.id[\s\S]*?LIMIT\s+5001[\s\S]*?\)/i);
      expect(call.sql).toMatch(/notes_stats\s+AS\s*\([\s\S]*?COUNT\s*\(\s*\*\s*\)[\s\S]*?SUM\s*\([\s\S]*?FROM\s+export_notes\s+n/i);
      expect(call.sql).not.toMatch(/COUNT\s*\(\s*\*\s*\)\s+FROM\s+person_notes\b/i);
    }
    expect(db.prepared[1].values).toContain(PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxNotesBytes);
    expect(db.prepared[1].sql).toMatch(/LIMIT\s+5001\b/i);
    expect(db.prepared[1].sql).toMatch(/CASE\s+WHEN\s+length\s*\(/i);
    expect(db.prepared[1].sql).toMatch(/n\.deleted_at\s+IS\s+NULL/i);
    expect(db.prepared[1].sql).toMatch(/p\.deleted_at\s+IS\s+NULL/i);
    expect(db.prepared[1].sql).not.toMatch(/\b(super_admin|admin_areas|session_epoch|calendar_token|avatar_url)\b/i);
    expect(db.prepared[2].values).toContain(PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxNotesBytes);
    expect(db.prepared[2].sql).toMatch(/FROM\s+export_order_people\b/i);
    expect(db.prepared[2].sql).toMatch(/p\.deleted_at\s+IS\s+NULL/i);
    expect(db.prepared[2].sql).not.toMatch(/\b(?:birthday|joined_on|membership_status|first_name|last_name)\b/i);

    expect(source.peopleOrder).toHaveLength(3);
    expect(source.peopleOrder?.map((person) => person.stableKey)).toEqual([
      'person-1',
      'person-2',
      'person-4',
    ]);
    expect(JSON.stringify(source.peopleOrder)).not.toMatch(/person-3|deleted@example/i);

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.counts).toEqual({ people: 3, notes: 3 });
    expect(result.csv).toBe(
      `${PASTORAL_NOTES_EXPORT_HEADERS.join(',')}\r\n`
      + `person-1,beta@example.com,'+departed.author@example.com,"Line one,\nline two",2026-08-09 08:00:00\r\n`
      + `person-2,zeta@example.com,former.author@example.com,'=Call after service,2026-08-10 09:00:00\r\n`
      + `person-3,alpha@example.com,standalone.author@example.com,Standalone follow-up,2026-08-11 10:00:00\r\n`,
    );
    expect(result.csv).not.toMatch(/Deleted note body|Deleted subject body|deleted-note-author/i);
    expect(result.csv).not.toMatch(/\b(?:200|201|202|203)\b/);
  });

  it('is deterministic across source order and keeps author attribution independent from resolvable people', () => {
    const source: PastoralNotesExportSource = {
      peopleOrder: [{ stableKey: 'person-z', email: 'zeta@example.com', household: null }],
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
    const reversed = buildPastoralNotesExport({
      peopleOrder: [...(source.peopleOrder ?? [])].reverse(),
      notes: [...source.notes].reverse(),
    });

    expect(forward).toEqual(reversed);
    expect(JSON.stringify(forward)).not.toContain('authorPersonId');
    expect(JSON.stringify(forward)).not.toContain('author_person_id');
  });

  it('assigns notes-local refs by canonical household-first People order, never by notes email or database IDs', () => {
    expect(PASTORAL_NOTES_PERSON_REF_SCOPE).toBe('notes_export_local');
    const peopleOrder: NonNullable<PastoralNotesExportSource['peopleOrder']> = [
      {
        stableKey: 'database-person-1',
        email: 'a@example.com',
        household: null,
      },
      {
        stableKey: 'database-person-999',
        email: 'z@example.com',
        household: {
          stableKey: 'database-household-500',
          name: 'Alpha Household',
          address: null,
          phone: null,
          role: 'adult',
          primary: true,
        },
      },
    ];
    const notes = [
      {
        stableKey: 'internal-note-2',
        personStableKey: 'database-person-999',
        personEmail: 'z@example.com',
        authorAttribution: 'Historical text only',
        body: 'Zeta note',
        createdAt: '2026-08-11 10:00:00',
      },
      {
        stableKey: 'internal-note-1',
        personStableKey: 'database-person-1',
        personEmail: 'a@example.com',
        authorAttribution: 'Historical text only',
        body: 'Alpha note',
        createdAt: '2026-08-11 09:00:00',
      },
    ];
    const result = buildPastoralNotesExport({ peopleOrder, notes });
    const reversed = buildPastoralNotesExport({
      peopleOrder: [...peopleOrder].reverse(),
      notes: [...notes].reverse(),
    });

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(reversed).toEqual(result);
    expect(result.csv.split('\r\n').slice(1, -1).map((row) => row.split(',').slice(0, 2))).toEqual([
      ['person-1', 'z@example.com'],
      ['person-2', 'a@example.com'],
    ]);
    expect(result.csv).not.toMatch(/database-person|internal-note/);
  });

  it('fails closed when a note subject is absent from or duplicated in canonical People ordering', () => {
    const note = {
      stableKey: 'note-private',
      personStableKey: 'person-subject',
      personEmail: 'private@example.com',
      authorAttribution: 'Historical text',
      body: 'Private pastoral body',
      createdAt: '2026-08-11 09:00:00',
    };
    const absent = buildPastoralNotesExport({
      peopleOrder: [{ stableKey: 'different-person', email: 'different@example.com', household: null }],
      notes: [note],
    });
    const duplicate = buildPastoralNotesExport({
      peopleOrder: [
        { stableKey: 'person-subject', email: 'private@example.com', household: null },
        { stableKey: 'person-subject', email: 'private@example.com', household: null },
      ],
      notes: [note],
    });

    for (const result of [absent, duplicate]) {
      expect(result).toEqual({
        status: 'repair_required',
        counts: { people: 1, notes: 1, issues: 1 },
      });
      expect(JSON.stringify(result)).not.toMatch(/csv|private@example|pastoral body/i);
    }
  });

  it('snapshots hostile root, array, and note properties exactly once before serialization', () => {
    const counts = new Map<PropertyKey, number>();
    const once = <T>(key: PropertyKey, value: T, hostile: T): T => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count === 1 ? value : hostile;
    };
    const note = {} as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      stableKey: 'note-safe',
      personStableKey: 'person-safe',
      personEmail: 'safe@example.com',
      authorAttribution: 'Safe attribution',
      body: 'Safe body',
      createdAt: '2026-08-11 10:00:00',
    })) {
      Object.defineProperty(note, key, {
        enumerable: true,
        get: () => once(`note.${key}`, value, 'PRIVATE SECOND READ'),
      });
    }
    const rows = new Proxy([note], {
      get(target, key, receiver) {
        if (key === Symbol.iterator) throw new Error('array iterator must not be used');
        if (key === 'length') return once('array.length', 1, 1000);
        if (key === '0') return once('array.0', note, { body: 'PRIVATE SECOND ROW' });
        return Reflect.get(target, key, receiver);
      },
    });
    const input = Object.defineProperties({}, {
      notes: {
        enumerable: true,
        get: () => once('root.notes', rows, [{ body: 'PRIVATE SECOND NOTES' }]),
      },
      peopleOrder: {
        enumerable: true,
        value: [{ stableKey: 'person-safe', email: 'safe@example.com', household: null }],
      },
    });

    const result = buildPastoralNotesExport(input as PastoralNotesExportSource);

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.csv).toContain('Safe attribution,Safe body');
    expect(JSON.stringify(result)).not.toContain('PRIVATE SECOND');
    for (const value of counts.values()) expect(value).toBe(1);
  });

  it('maps proxy and getter failures to constant numeric repair results without leaking PII', () => {
    const privateMessage = 'private.pastoral@example.com getter failure';
    const hostileArray = new Proxy([], {
      get: (_target, key) => {
        if (key === 'length') throw new Error(privateMessage);
        return undefined;
      },
    });
    const hostileNote = Object.defineProperty({}, 'body', {
      get: () => { throw new Error(privateMessage); },
    });

    for (const input of [{ notes: hostileArray }, { notes: [hostileNote] }]) {
      const result = buildPastoralNotesExport(input as unknown as PastoralNotesExportSource);
      expect(result).toEqual({
        status: 'repair_required',
        counts: { people: 0, notes: 0, issues: 1 },
      });
      expect(JSON.stringify(result)).not.toContain(privateMessage);
    }
  });

  it.each([
    ['invalid subject email', { personEmail: 'not-an-email' }],
    ['timestamp with timezone suffix', { createdAt: '2026-08-11T10:00:00Z' }],
    ['timestamp with fractional seconds', { createdAt: '2026-08-11 10:00:00.123' }],
    ['impossible timestamp', { createdAt: '2026-02-30 10:00:00' }],
  ])('fails closed for %s', (_label, overrides) => {
    const result = buildPastoralNotesExport({
      notes: [{
        stableKey: 'note-invalid',
        personStableKey: 'person-invalid',
        personEmail: 'valid@example.com',
        authorAttribution: 'historical free text',
        body: 'private body',
        createdAt: '2026-08-11 10:00:00',
        ...overrides,
      }],
    });

    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 0, notes: 1, issues: 1 },
    });
    expect(JSON.stringify(result)).not.toMatch(/private body|not-an-email|csv/i);
  });

  it('orders double-digit person references by assigned ordinal rather than lexicographically', () => {
    const result = buildPastoralNotesExport({
      peopleOrder: Array.from({ length: 12 }, (_, index) => ({
        stableKey: `subject-${index + 1}`,
        email: `person-${String(index + 1).padStart(2, '0')}@example.com`,
        household: null,
      })).reverse(),
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
    const privateTail = `PRIVATE-NOTES-TAIL-${'x'.repeat(900_000)}`;
    for (let index = 6001; index <= 6012; index += 1) {
      await env.DB.prepare(`
        INSERT INTO person_notes (id, person_id, author_email, body, created_at)
        VALUES (?, 1, 'historical@example.com', ?, '2026-08-11 00:00:00')
      `).bind(index, privateTail).run();
    }

    const db = new TrackingDb(env.DB);
    const source = await loadPastoralNotesExport(db, 'd1');
    const result = buildPastoralNotesExport(source);
    const stats = await env.DB.prepare(db.prepared[0].sql).first<{
      notes_count: number;
      total_bytes: number;
    }>();

    expect(stats?.notes_count).toBe(5001);
    expect(stats?.total_bytes).toBeLessThan(PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxNotesBytes);
    expect(source.notes).toEqual([]);
    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 0, notes: 0, issues: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('csv');
  });

  it('does not return an oversized notes database payload or materialize its pastoral body', async () => {
    const privatePrefix = 'PRIVATE-HUGE-PASTORAL-';
    await env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Subject', 'subject@example.com')")
      .run();
    const chunk = 'x'.repeat(900_000);
    for (let index = 1; index <= 12; index += 1) {
      await env.DB.prepare(`
        INSERT INTO person_notes (id, person_id, author_email, body, created_at)
        VALUES (?, 1, 'historical@example.com', ?, '2026-08-11 00:00:00')
      `).bind(index, index === 1 ? `${privatePrefix}${chunk}` : chunk).run();
    }

    const source = await loadPastoralNotesExport(env.DB, 'd1');
    const result = buildPastoralNotesExport(source);

    expect(source.integrityIssues).toBeGreaterThan(0);
    expect(source.notes).toEqual([]);
    expect(JSON.stringify(source)).not.toContain(privatePrefix);
    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 0, notes: 0, issues: 1 },
    });
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

  it('captures every hostile audit property once and serializes only the plain validated snapshot', async () => {
    await env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Actor', 'actor@example.com')")
      .run();
    const counts = new Map<string, number>();
    const once = <T>(key: string, value: T): T => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > 1) throw new Error(`PRIVATE SECOND READ ${key}`);
      return value;
    };
    const structuralCounts = {};
    Object.defineProperties(structuralCounts, {
      people: { enumerable: true, get: () => once('counts.people', 1) },
      notes: { enumerable: true, get: () => once('counts.notes', 2) },
    });
    const input = {};
    Object.defineProperties(input, {
      kind: { enumerable: true, get: () => once('kind', 'people_notes_export_generated') },
      actorPersonId: { enumerable: true, get: () => once('actorPersonId', 1) },
      counts: { enumerable: true, get: () => once('counts', structuralCounts) },
    });

    await appendAuditEvent(env.DB, input as never);

    expect(Object.fromEntries(counts)).toEqual({
      kind: 1,
      actorPersonId: 1,
      counts: 1,
      'counts.people': 1,
      'counts.notes': 1,
    });
    expect(await env.DB.prepare('SELECT structural_counts_json FROM audit_events')
      .first<string>('structural_counts_json')).toBe('{"people":1,"notes":2}');
  });
});
