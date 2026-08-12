import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

  it('fails closed for every membership row attached to a soft-deleted household', async () => {
    await db.batch([
      db.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Live Person', 'live@example.com')"),
      db.prepare("INSERT INTO households (id, name, deleted_at) VALUES (10, 'Private Deleted Household', '2026-01-01')"),
      db.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (100, 10, 1, 'Live Person', 'adult', 1)"),
      db.prepare("INSERT INTO household_members (id, household_id, person_id, display_name, role, is_primary) VALUES (101, 10, NULL, 'Private Deleted Dependent', 'child', 0)"),
    ]);

    const source = await loadCanonicalPeopleExport(db, EXPORT_TODAY, 'supabase');
    const result = buildCanonicalExportParts(source);

    expect(source.integrityIssues).toBe(2);
    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 1, dependents: 0, households: 0, issues: 2 },
    });
    expect(JSON.stringify(result)).not.toMatch(/csv|Private Deleted Household|Private Deleted Dependent|live@example/i);
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
