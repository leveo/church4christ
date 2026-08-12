import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { softDeletePerson } from '../../src/lib/adminDb';
import { appendAuditEvent } from '../../src/lib/auditDb';
import { buildCanonicalExportParts } from '../../src/lib/peopleExport';
import {
  loadCanonicalPeopleExport,
  loadPastoralNotesExport,
  PEOPLE_EXPORT_SNAPSHOT_LIMITS,
} from '../../src/lib/peopleExportDb';
import { buildPastoralNotesExport } from '../../src/lib/pastoralNotesExport';
import { PgAdapter } from '../../src/lib/pgAdapter';
import {
  EXPORT_TODAY,
  expectedCanonicalPeopleExportSource,
  seedPortableExportFixture,
} from '../fixtures/peopleExportDb';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('portable people exports (Postgres)', () => {
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
    await sql.unsafe(
      'TRUNCATE TABLE audit_events, person_notes, household_members, households, people RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('produces byte-identical canonical and notes exports from the shared cross-backend fixture', async () => {
    await seedPortableExportFixture(db);

    const canonical = buildCanonicalExportParts(await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'supabase'));
    const expectedCanonical = buildCanonicalExportParts(expectedCanonicalPeopleExportSource());
    const notes = buildPastoralNotesExport(await loadPastoralNotesExport(db, 'supabase'));

    expect(canonical).toEqual(expectedCanonical);
    expect(notes).toEqual({
      status: 'success',
      counts: { people: 2, notes: 2 },
      csv: 'person_ref,person_email,author_attribution,body,created_at\r\n'
        + 'person-1,beta@example.com,\'+departed.author@example.com,"Line one,\nline two",2026-08-09 08:00:00\r\n'
        + 'person-2,zeta@example.com,former.author@example.com,\'=Call after service,2026-08-10 09:00:00\r\n',
    });
  });

  it('enforces audit constraints and persists the same canonical numeric JSON through PgAdapter', async () => {
    await sql.unsafe("INSERT INTO people (id, display_name, email) VALUES (1, 'Actor', 'actor@example.com')");

    await expect(sql.unsafe(`
      INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
      VALUES (999, 'people_notes_export_generated', '{"people":0,"notes":0}')
    `)).rejects.toMatchObject({ code: '23503' });
    await expect(sql.unsafe(`
      INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
      VALUES (1, 'other_kind', '{"people":0,"notes":0}')
    `)).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe(`
      INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
      VALUES (1, 'people_notes_export_generated', '')
    `)).rejects.toMatchObject({ code: '23514' });

    await appendAuditEvent(db, {
      kind: 'people_notes_export_generated',
      actorPersonId: 1,
      counts: { people: 2, notes: 4 },
    });

    const rows = await sql.unsafe(`
      SELECT actor_person_id, action_kind, structural_counts_json
      FROM audit_events
      ORDER BY id
    `);
    expect(rows).toEqual([{
      actor_person_id: 1,
      action_kind: 'people_notes_export_generated',
      structural_counts_json: '{"people":2,"notes":4}',
    }]);
  });

  it('rejects every non-canonical or non-integer audit count shape at the database boundary', async () => {
    await sql.unsafe("INSERT INTO people (id, display_name, email) VALUES (1, 'Actor', 'actor@example.com')");
    for (const counts of [
      '{"people":0,"notes":0}',
      '{"people":5000,"notes":5000}',
    ]) {
      await expect(sql.unsafe(`
        INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
        VALUES (1, 'people_notes_export_generated', $1)
      `, [counts])).resolves.not.toThrow();
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
      await expect(sql.unsafe(`
        INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
        VALUES (1, 'people_notes_export_generated', $1)
      `, [counts])).rejects.toBeDefined();
    }

    const rows = await sql.unsafe('SELECT structural_counts_json FROM audit_events ORDER BY id');
    expect(rows).toEqual([
      { structural_counts_json: '{"people":0,"notes":0}' },
      { structural_counts_json: '{"people":5000,"notes":5000}' },
    ]);
  });

  it('excludes a soft-deleted non-primary person membership and exports the remaining household', async () => {
    await db.batch([
      db.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Live Primary', 'live@example.com')"),
      db.prepare("INSERT INTO people (id, display_name, email) VALUES (2, 'Deleted Member', 'deleted@example.com')"),
      db.prepare("INSERT INTO households (id, name) VALUES (10, 'Live Household')"),
      db.prepare("INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (10, 1, 'Live Primary', 'adult', 1)"),
      db.prepare("INSERT INTO household_members (household_id, person_id, display_name, role, is_primary) VALUES (10, 2, 'Deleted Member', 'adult', 0)"),
    ]);
    await softDeletePerson(db, 2);

    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'supabase');
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
    await db.batch([
      db.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Live Person', 'live@example.com')"),
      db.prepare("INSERT INTO households (id, name, deleted_at) VALUES (10, 'Private Deleted Household', '2026-01-01')"),
      db.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (100, 10, 1, 'Live Person', 'adult', 1)"),
      db.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (101, 10, NULL, 'Private Deleted Dependent', 'child', 0)"),
    ]);

    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'supabase');
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
    await db.batch([
      db.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Deleted Primary', 'deleted-primary@example.com')"),
      db.prepare("INSERT INTO people (id, display_name, email) VALUES (2, 'Live Secondary', 'secondary@example.com')"),
      db.prepare("INSERT INTO households (id, name) VALUES (10, 'Needs Primary Household')"),
      db.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (100, 10, 1, 'Deleted Primary', 'adult', 1)"),
      db.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (101, 10, 2, 'Live Secondary', 'adult', 0)"),
      db.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (102, 10, NULL, 'Live Dependent', 'child', 0)"),
    ]);
    await softDeletePerson(db, 1);

    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'supabase');
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
    await db.batch([
      db.prepare("INSERT INTO people (id, display_name, email, deleted_at) VALUES (1, 'Deleted One', 'deleted-one@example.com', '2026-01-01')"),
      db.prepare("INSERT INTO people (id, display_name, email, deleted_at) VALUES (2, 'Deleted Two', 'deleted-two@example.com', '2026-01-01')"),
      db.prepare("INSERT INTO households (id, name) VALUES (10, 'Empty Live Household')"),
      db.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (100, 10, 1, 'Deleted One', 'adult', 1)"),
      db.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (101, 10, 2, 'Deleted Two', 'adult', 0)"),
    ]);

    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'supabase');
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
    await db.prepare("INSERT INTO households (id, name, deleted_at) VALUES (10, 'Deleted Household', '2026-01-01')").run();
    await sql.unsafe(`
      INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary)
      SELECT n, 10, NULL, 'Deleted Dependent ' || n, 'child', 0
      FROM generate_series(1, 5001) AS sequence(n)
    `);

    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'supabase');
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBeUndefined();
    expect(result.status).toBe('success');
  });

  it('does not let deleted-person memberships consume the membership snapshot bound', async () => {
    await db.batch([
      db.prepare("INSERT INTO people (id, display_name, email) VALUES (10000, 'Live Primary', 'live@example.com')"),
      db.prepare("INSERT INTO households (id, name) VALUES (11, 'Live Household')"),
      db.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (1, 11, 10000, 'Live Primary', 'adult', 1)"),
    ]);
    await sql.unsafe(`
      INSERT INTO people (id, display_name, email, deleted_at)
      SELECT n, 'Deleted Person ' || n, 'deleted-' || n || '@example.com', '2026-01-01'
      FROM generate_series(1, 5000) AS sequence(n)
    `);
    await sql.unsafe(`
      INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary)
      SELECT 10000 + n, 11, n, 'Deleted Person ' || n, 'adult', 0
      FROM generate_series(1, 5000) AS sequence(n)
    `);

    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'supabase');
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBeUndefined();
    expect(result.status).toBe('success');
  });

  it('keeps a genuinely missing person target as an orphan and empty-household repair issue', async () => {
    await db.prepare("INSERT INTO households (id, name) VALUES (10, 'Orphan Household')").run();
    await sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL session_replication_role = replica');
      await tx.unsafe(`
        INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary)
        VALUES (100, 10, 999, 'Missing Person', 'adult', 1)
      `);
    });

    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'supabase');
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBe(2);
    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 0, dependents: 0, households: 0, issues: 2 },
    });
  });

  it('suppresses oversized canonical and notes payloads inside the real database snapshot', async () => {
    const privateCanonical = 'PRIVATE-PG-CANONICAL-' + 'x'.repeat(
      PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxCanonicalBytes + 1,
    );
    await sql.unsafe(`
      INSERT INTO people (id, display_name, email)
      VALUES (1, $1, 'huge@example.com')
    `, [privateCanonical]);

    const canonicalSource = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'supabase');
    const canonicalResult = buildCanonicalExportParts(canonicalSource);

    expect(canonicalSource.people).toEqual([]);
    expect(canonicalSource.integrityIssues).toBeGreaterThan(0);
    expect(JSON.stringify(canonicalSource)).not.toContain('PRIVATE-PG-CANONICAL');
    expect(canonicalResult.status).toBe('repair_required');

    await sql.unsafe("UPDATE people SET display_name = 'Safe Subject' WHERE id = 1");
    const privatePastoral = 'PRIVATE-PG-PASTORAL-' + 'x'.repeat(
      PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxNotesBytes + 1,
    );
    await sql.unsafe(`
      INSERT INTO person_notes (id, person_id, author_email, body, created_at)
      VALUES (1, 1, 'historical@example.com', $1, '2026-08-11 00:00:00')
    `, [privatePastoral]);

    const notesSource = await loadPastoralNotesExport(db, 'supabase');
    const notesResult = buildPastoralNotesExport(notesSource);

    expect(notesSource.notes).toEqual([]);
    expect(notesSource.integrityIssues).toBeGreaterThan(0);
    expect(JSON.stringify(notesSource)).not.toContain('PRIVATE-PG-PASTORAL');
    expect(notesResult.status).toBe('repair_required');
  });
});
