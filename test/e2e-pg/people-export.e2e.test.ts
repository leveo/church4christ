// Portable People downloads against the BUILT Supabase/PostgreSQL worker.
// Fixtures are fictional and this file never logs exported CSV values.
import { env, SELF } from 'cloudflare:test';
import postgres from 'postgres';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseUtf8CsvWithRowNumbers } from '../../src/lib/csvParse';
import { MODULE_KEYS } from '../../src/lib/modules';
import { PEOPLE_IMPORT_HEADERS, parsePeopleImport } from '../../src/lib/peopleImport';
import { PEOPLE_NOTES_ACKNOWLEDGEMENT } from '../../src/lib/peopleExportHttp';
import { PASTORAL_NOTES_EXPORT_HEADERS, PASTORAL_NOTES_EXPORT_LIMITS } from '../../src/lib/pastoralNotesExport';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { get, ORIGIN, post } from '../e2e/helpers';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const DISCOVERY = '/admin/people/export';
const DOWNLOAD = '/admin/people/export.csv?part=1';
const NOTES = '/admin/people/export-notes';
const ENCODER = new TextEncoder();

function pgClient() {
  const connectionString = (env as unknown as { HYPERDRIVE: { connectionString: string } }).HYPERDRIVE.connectionString;
  return postgres(connectionString, {
    max: 1,
    fetch_types: false,
    prepare: false,
    onnotice: () => {},
  });
}

async function withPg<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = pgClient();
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

function todayInChicago(): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function modulesBody(disabled: string[]): string {
  const body = new URLSearchParams();
  body.append('action', 'modules');
  for (const key of MODULE_KEYS) if (!disabled.includes(key)) body.append(`module.${key}`, '1');
  return body.toString();
}

function notesPost(cookie: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${NOTES}`, {
    method: 'POST',
    headers: {
      cookie,
      origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ acknowledgement: PEOPLE_NOTES_ACKNOWLEDGEMENT }).toString(),
    redirect: 'manual',
  });
}

beforeAll(async () => {
  await withPg(async (sql) => {
    await sql.unsafe(`
      INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
      VALUES (60, 'Lena', 'Limited', 'Lena PG Export Limited', 'lena.pg-export-limited@example.com', 'admin', 0, 'bulletins')
      ON CONFLICT(id) DO NOTHING
    `);
    await sql.unsafe(`
      INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
      VALUES (61, 'Paula', 'People', 'Paula PG Export People', 'paula.pg-export-people@example.com', 'admin', 0, 'people')
      ON CONFLICT(id) DO NOTHING
    `);
  });
});

afterEach(async () => {
  const admin = await sessionCookie(1, 'admin@example.com');
  await post('/admin/settings', modulesBody([]), { cookie: admin });
  await withPg(async (sql) => {
    await sql.unsafe('DROP TRIGGER IF EXISTS people_export_test_abort_audit ON audit_events');
    await sql.unsafe('DROP FUNCTION IF EXISTS people_export_test_abort_audit()');
  });
});

describe('PostgreSQL-backed People export access', () => {
  it('enforces anonymous, limited, full-People, and super-admin boundaries', async () => {
    for (const path of [DISCOVERY, DOWNLOAD, NOTES]) {
      const anonymous = await get(path);
      expect(anonymous.status).toBe(303);
      expect(anonymous.headers.get('location')).toContain('/en/signin?next=');
    }

    const deniedActors = [
      await sessionCookie(3, 'sarah.johnson@example.com'),
      await sessionCookie(2, 'pastor.david@example.com'),
      await sessionCookie(60, 'lena.pg-export-limited@example.com'),
    ];
    for (const cookie of deniedActors) {
      for (const path of [DISCOVERY, DOWNLOAD, NOTES]) {
        expect((await get(path, { cookie })).status).toBe(403);
      }
    }

    const fullPeople = await sessionCookie(61, 'paula.pg-export-people@example.com');
    expect((await get(DISCOVERY, { cookie: fullPeople })).status).toBe(200);
    expect((await get(DOWNLOAD, { cookie: fullPeople })).status).toBe(200);
    expect((await get(NOTES, { cookie: fullPeople })).status).toBe(403);

    const superAdmin = await sessionCookie(1, 'admin@example.com');
    expect((await get(DISCOVERY, { cookie: superAdmin })).status).toBe(200);
    expect((await get(DOWNLOAD, { cookie: superAdmin })).status).toBe(200);
    expect((await get(NOTES, { cookie: superAdmin })).status).toBe(200);
  });

  it('applies the People module 404 before route handling and restores all three routes', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    try {
      expect((await post('/admin/settings', modulesBody(['people']), { cookie: admin })).status).toBe(303);
      for (const path of [DISCOVERY, DOWNLOAD, NOTES]) {
        expect((await get(path, { cookie: admin })).status).toBe(404);
      }
    } finally {
      await post('/admin/settings', modulesBody([]), { cookie: admin });
    }
    expect((await get(DISCOVERY, { cookie: admin })).status).toBe(200);
  });
});

describe('PostgreSQL-backed People export bytes and audit', () => {
  it('returns deterministic canonical and notes CSV bytes from the same fictional fixture', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    await withPg(async (sql) => {
      await sql.unsafe(`INSERT INTO people (id, display_name, email, role)
        VALUES (3000, '=Portable PG Subject', 'pg.portable@example.com', 'member')`);
      await sql.unsafe(`INSERT INTO people (id, display_name, email, role, deleted_at)
        VALUES (3001, 'Deleted PG Subject', 'pg.deleted@example.com', 'member', '2026-01-01 00:00:00')`);
      await sql.unsafe(`INSERT INTO person_notes (id, person_id, author_email, body, created_at)
        VALUES (3000, 3000, '+historical-pg@example.com', '=PG_PRIVATE_FOLLOWUP_7391', '2026-08-01 10:00:00')`);
      await sql.unsafe(`INSERT INTO person_notes (id, person_id, author_email, body, created_at)
        VALUES (3001, 3001, 'deleted-pg@example.com', 'PG_PRIVATE_DELETED_7391', '2026-08-01 11:00:00')`);
    });
    try {
      const firstCanonicalResponse = await get(DOWNLOAD, { cookie: admin });
      expect(firstCanonicalResponse.status).toBe(200);
      const firstCanonical = await firstCanonicalResponse.text();
      const secondCanonical = await (await get(DOWNLOAD, { cookie: admin })).text();
      expect(secondCanonical).toBe(firstCanonical);
      expect(firstCanonical.split('\r\n')[0]).toBe(PEOPLE_IMPORT_HEADERS.join(','));
      const canonical = parsePeopleImport(ENCODER.encode(firstCanonical), { today: todayInChicago() });
      expect(canonical.errors).toEqual([]);
      const portable = canonical.model?.people.find((person) => person.email === 'pg.portable@example.com');
      expect(portable).toMatchObject({
        displayName: "'=Portable PG Subject",
        role: 'member',
        active: true,
      });
      expect(firstCanonical).not.toContain('pg.deleted@example.com');
      expect(firstCanonical).not.toContain('PG_PRIVATE_FOLLOWUP_7391');

      const firstNotesResponse = await notesPost(admin);
      expect(firstNotesResponse.status).toBe(200);
      const firstNotes = await firstNotesResponse.text();
      const secondNotes = await (await notesPost(admin)).text();
      expect(secondNotes).toBe(firstNotes);
      expect(firstNotes.split('\r\n')[0]).toBe(PASTORAL_NOTES_EXPORT_HEADERS.join(','));
      const notes = parseUtf8CsvWithRowNumbers(ENCODER.encode(firstNotes), {
        maxBytes: PASTORAL_NOTES_EXPORT_LIMITS.maxCsvBytes,
        maxRows: PASTORAL_NOTES_EXPORT_LIMITS.maxNotes + 1,
        maxColumns: PASTORAL_NOTES_EXPORT_HEADERS.length,
        maxCellChars: 5_000,
      });
      expect(notes.ok).toBe(true);
      if (!notes.ok) throw new Error('notes CSV did not parse');
      expect(notes.rows[0]).toEqual([...PASTORAL_NOTES_EXPORT_HEADERS]);
      const portableNote = notes.rows.slice(1).find((row) => row[1] === 'pg.portable@example.com');
      expect(portableNote).toBeDefined();
      expect(portableNote![0]).toMatch(/^person-\d+$/);
      expect(portableNote![2]).toBe("'+historical-pg@example.com");
      expect(portableNote![3]).toBe("'=PG_PRIVATE_FOLLOWUP_7391");
      expect(firstNotes).not.toContain('PG_PRIVATE_DELETED_7391');

      const audit = await withPg((sql) => sql.unsafe<{
        actor_person_id: number;
        action_kind: string;
        structural_counts_json: string;
      }[]>(`SELECT actor_person_id, action_kind, structural_counts_json FROM audit_events ORDER BY id`));
      expect(audit).toHaveLength(2);
      for (const row of audit) {
        expect(Number(row.actor_person_id)).toBe(1);
        expect(row.action_kind).toBe('people_notes_export_generated');
        expect(JSON.parse(row.structural_counts_json)).toEqual({ people: 3, notes: 3 });
        expect(JSON.stringify(row)).not.toContain('example.com');
        expect(JSON.stringify(row)).not.toContain('PG_PRIVATE_FOLLOWUP_7391');
      }
    } finally {
      await withPg(async (sql) => {
        await sql.unsafe('DELETE FROM audit_events');
        await sql.unsafe('DELETE FROM person_notes WHERE id IN (3000, 3001)');
        await sql.unsafe('DELETE FROM people WHERE id IN (3000, 3001)');
      });
    }
  });

  it('returns safe 500 JSON and no row when a PostgreSQL audit trigger aborts', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const before = await withPg(async (sql) => {
      const rows = await sql.unsafe<{ n: number }[]>('SELECT COUNT(*) AS n FROM audit_events');
      return Number(rows[0].n);
    });
    await withPg(async (sql) => {
      await sql.unsafe(`
        CREATE FUNCTION people_export_test_abort_audit() RETURNS trigger
        LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''test audit failure''; END'
      `);
      await sql.unsafe(`
        CREATE TRIGGER people_export_test_abort_audit
        BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION people_export_test_abort_audit()
      `);
    });
    try {
      const response = await notesPost(admin);
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ ok: false, code: 'export_failed' });
      const after = await withPg(async (sql) => {
        const rows = await sql.unsafe<{ n: number }[]>('SELECT COUNT(*) AS n FROM audit_events');
        return Number(rows[0].n);
      });
      expect(after).toBe(before);
    } finally {
      await withPg(async (sql) => {
        await sql.unsafe('DROP TRIGGER IF EXISTS people_export_test_abort_audit ON audit_events');
        await sql.unsafe('DROP FUNCTION IF EXISTS people_export_test_abort_audit()');
      });
    }
  });
});
