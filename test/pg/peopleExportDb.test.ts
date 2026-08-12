import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendAuditEvent } from '../../src/lib/auditDb';
import { buildCanonicalExportParts } from '../../src/lib/peopleExport';
import {
  loadCanonicalPeopleExport,
  loadPastoralNotesExport,
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

    const canonical = buildCanonicalExportParts(await loadCanonicalPeopleExport(db, EXPORT_TODAY));
    const expectedCanonical = buildCanonicalExportParts(expectedCanonicalPeopleExportSource());
    const notes = buildPastoralNotesExport(await loadPastoralNotesExport(db));

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
      VALUES (999, 'people_notes_export_generated', '{}')
    `)).rejects.toMatchObject({ code: '23503' });
    await expect(sql.unsafe(`
      INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
      VALUES (1, 'other_kind', '{}')
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
});
