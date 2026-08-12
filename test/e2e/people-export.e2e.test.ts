// Portable People downloads against the BUILT D1 worker. All fixtures are
// fictional example.com records and assertions avoid printing exported values.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUtf8CsvWithRowNumbers } from '../../src/lib/csvParse';
import { MODULE_KEYS } from '../../src/lib/modules';
import { PEOPLE_IMPORT_HEADERS, parsePeopleImport } from '../../src/lib/peopleImport';
import { PEOPLE_NOTES_ACKNOWLEDGEMENT } from '../../src/lib/peopleExportHttp';
import { PASTORAL_NOTES_EXPORT_HEADERS, PASTORAL_NOTES_EXPORT_LIMITS } from '../../src/lib/pastoralNotesExport';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { get, ORIGIN, post } from './helpers';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const DISCOVERY = '/admin/people/export';
const DOWNLOAD = '/admin/people/export.csv';
const NOTES = '/admin/people/export-notes';
const ENCODER = new TextEncoder();

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

function notesPost(cookie: string, acknowledgement: string = PEOPLE_NOTES_ACKNOWLEDGEMENT, origin = ORIGIN): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${NOTES}`, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ acknowledgement }).toString(),
    redirect: 'manual',
  });
}

async function auditRows(): Promise<Array<{
  actor_person_id: number;
  action_kind: string;
  structural_counts_json: string;
  created_at: string;
}>> {
  return (await env.DB.prepare(`
    SELECT actor_person_id, action_kind, structural_counts_json, created_at
    FROM audit_events ORDER BY id
  `).all<{
    actor_person_id: number;
    action_kind: string;
    structural_counts_json: string;
    created_at: string;
  }>()).results;
}

beforeEach(async () => {
  await env.DB.prepare(`
    INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
    VALUES (60, 'Lena', 'Limited', 'Lena Export Limited', 'lena.export-limited@example.com', 'admin', 0, 'bulletins')
    ON CONFLICT(id) DO NOTHING
  `).run();
  await env.DB.prepare(`
    INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
    VALUES (61, 'Paula', 'People', 'Paula Export People', 'paula.export-people@example.com', 'admin', 0, 'people')
    ON CONFLICT(id) DO NOTHING
  `).run();
});

// Module state is cached per worker isolate, so every case restores the all-on
// setting even when an assertion in the module-off case fails.
afterEach(async () => {
  const admin = await sessionCookie(1, 'admin@example.com');
  await post('/admin/settings', modulesBody([]), { cookie: admin });
  await env.DB.prepare('DROP TRIGGER IF EXISTS people_export_test_abort_audit').run();
});

describe('People export access and module boundary', () => {
  it('enforces anonymous, role, People-grant, and super-admin access across all three routes', async () => {
    for (const path of [DISCOVERY, `${DOWNLOAD}?part=1`, NOTES]) {
      const anonymous = await get(path);
      expect(anonymous.status).toBe(303);
      expect(anonymous.headers.get('location')).toContain('/en/signin?next=');
    }

    const denied = [
      await sessionCookie(3, 'sarah.johnson@example.com'),
      await sessionCookie(2, 'pastor.david@example.com'),
      await sessionCookie(60, 'lena.export-limited@example.com'),
    ];
    for (const cookie of denied) {
      for (const path of [DISCOVERY, `${DOWNLOAD}?part=1`, NOTES]) {
        expect((await get(path, { cookie })).status).toBe(403);
      }
    }

    const peopleAdmin = await sessionCookie(61, 'paula.export-people@example.com');
    expect((await get(DISCOVERY, { cookie: peopleAdmin })).status).toBe(200);
    expect((await get(`${DOWNLOAD}?part=1`, { cookie: peopleAdmin })).status).toBe(200);
    expect((await get(NOTES, { cookie: peopleAdmin })).status).toBe(403);

    const superAdmin = await sessionCookie(1, 'admin@example.com');
    expect((await get(DISCOVERY, { cookie: superAdmin })).status).toBe(200);
    expect((await get(`${DOWNLOAD}?part=1`, { cookie: superAdmin })).status).toBe(200);
    expect((await get(NOTES, { cookie: superAdmin })).status).toBe(200);
  });

  it('404s every export route and hides both directory links while People is off, then restores it', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    try {
      expect((await post('/admin/settings', modulesBody(['people']), { cookie: admin })).status).toBe(303);
      expect((await get(DISCOVERY, { cookie: admin })).status).toBe(404);
      expect((await get(`${DOWNLOAD}?part=1`, { cookie: admin })).status).toBe(404);
      expect((await get(NOTES, { cookie: admin })).status).toBe(404);

      const directory = await get('/admin/people', { cookie: admin });
      expect(directory.status).toBe(200);
      const html = await directory.text();
      expect(html).not.toContain(DISCOVERY);
      expect(html).not.toContain(NOTES);
    } finally {
      await post('/admin/settings', modulesBody([]), { cookie: admin });
    }
    expect((await get(DISCOVERY, { cookie: admin })).status).toBe(200);
  });
});

describe('canonical People export through the built worker', () => {
  it('discovers and downloads every row exactly once across two bounded CSV parts', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const statements = Array.from({ length: 190 }, (_, index) => {
      const id = 1_000 + index;
      return env.DB.prepare(`
        INSERT INTO people (id, first_name, last_name, display_name, email, role, active)
        VALUES (?, 'Export', 'Example', ?, ?, 'member', 1)
      `).bind(id, `Export Example ${id}`, `portable-${id}@example.com`);
    });
    await env.DB.batch(statements);

    const discovery = await get(DISCOVERY, { cookie: admin });
    expect(discovery.status).toBe(200);
    expect(discovery.headers.get('cache-control')).toContain('no-store');
    const discoveryHtml = await discovery.text();
    expect(discoveryHtml).toContain(`${DOWNLOAD}?part=1`);
    expect(discoveryHtml).toContain(`${DOWNLOAD}?part=2`);
    expect(discoveryHtml).not.toContain(`${DOWNLOAD}?part=3`);
    expect(discoveryHtml).not.toContain('portable-1000@example.com');
    expect(discoveryHtml).not.toContain('Export Example 1000');

    const expectedPeople = (await env.DB.prepare(`
      SELECT lower(email) AS email FROM people WHERE deleted_at IS NULL ORDER BY lower(email), id
    `).all<{ email: string }>()).results.map((row) => row.email);
    const expectedDependents = (await env.DB.prepare(`
      SELECT hm.display_name
      FROM household_members hm
      JOIN households h ON h.id = hm.household_id
      WHERE hm.person_id IS NULL AND h.deleted_at IS NULL
      ORDER BY hm.display_name, hm.id
    `).all<{ display_name: string }>()).results.map((row) => row.display_name);

    const observedPeople: string[] = [];
    const observedDependents: string[] = [];
    for (const partNumber of [1, 2]) {
      const response = await get(`${DOWNLOAD}?part=${partNumber}`, { cookie: admin });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(response.headers.get('content-disposition')).toMatch(
        new RegExp(`^attachment; filename="people-\\d{4}-\\d{2}-\\d{2}-part-${partNumber}-of-2\\.csv"$`),
      );
      expect(response.headers.get('x-people-export-part')).toBe(String(partNumber));
      expect(response.headers.get('x-people-export-parts')).toBe('2');
      const csv = await response.text();
      expect(csv.split('\r\n')[0]).toBe(PEOPLE_IMPORT_HEADERS.join(','));
      expect(csv).not.toContain('Met with David');
      expect(csv).not.toContain('session_epoch');
      expect(csv).not.toContain('super_admin');
      expect(csv).not.toContain('admin_areas');
      const parsed = parsePeopleImport(ENCODER.encode(csv), { today: todayInChicago() });
      expect(parsed.errors).toEqual([]);
      expect(parsed.model).not.toBeNull();
      observedPeople.push(...parsed.model!.people.map((person) => person.email));
      observedDependents.push(...parsed.model!.dependents.map((dependent) => dependent.displayName));
    }

    expect(new Set(observedPeople).size).toBe(observedPeople.length);
    expect(new Set(observedDependents).size).toBe(observedDependents.length);
    expect([...observedPeople].sort()).toEqual([...expectedPeople].sort());
    expect([...observedDependents].sort()).toEqual([...expectedDependents].sort());
    expect(await auditRows()).toEqual([]);
  });

  it('returns bounded repair metadata and no CSV for a household without a live adult primary', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const privateName = 'PRIVATE_REPAIR_HOUSEHOLD_7391';
    const household = await env.DB.prepare(
      'INSERT INTO households (name) VALUES (?)',
    ).bind(privateName).run();
    const householdId = household.meta.last_row_id as number;
    await env.DB.prepare(`
      INSERT INTO household_members (household_id, person_id, display_name, role, is_primary)
      VALUES (?, NULL, 'PRIVATE_REPAIR_DEPENDENT_7391', 'child', 0)
    `).bind(householdId).run();
    try {
      const discovery = await get(DISCOVERY, { cookie: admin });
      expect(discovery.status).toBe(200);
      const html = await discovery.text();
      expect(html).toContain('data-people-export-discovery');
      expect(html).not.toContain(privateName);
      expect(html).not.toContain('PRIVATE_REPAIR_DEPENDENT_7391');

      const download = await get(`${DOWNLOAD}?part=1`, { cookie: admin });
      expect(download.status).toBe(409);
      expect(download.headers.get('content-type')).toContain('application/json');
      const body = await download.text();
      expect(JSON.parse(body)).toMatchObject({ ok: false, code: 'repair_required' });
      expect(body).not.toContain(privateName);
      expect(body).not.toContain('PRIVATE_REPAIR_DEPENDENT_7391');
      expect(body).not.toContain(PEOPLE_IMPORT_HEADERS.join(','));
    } finally {
      await env.DB.prepare('DELETE FROM household_members WHERE household_id = ?').bind(householdId).run();
      await env.DB.prepare('DELETE FROM households WHERE id = ?').bind(householdId).run();
    }
  });
});

describe('pastoral-notes export through the built worker', () => {
  it('keeps GET non-generating, blocks bad/cross-origin acknowledgements, and audits each successful CSV', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const livePersonId = 3_000;
    const deletedPersonId = 3_001;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO people (id, display_name, email, role)
        VALUES (?, 'Current Notes Subject', 'current.notes@example.com', 'member')`).bind(livePersonId),
      env.DB.prepare(`INSERT INTO people (id, display_name, email, role, deleted_at)
        VALUES (?, 'Deleted Notes Subject', 'deleted.notes@example.com', 'member', '2026-01-01 00:00:00')`).bind(deletedPersonId),
      env.DB.prepare(`INSERT INTO person_notes
        (id, person_id, author_email, body, created_at)
        VALUES (3000, ?, '+historical-author@example.com', '=FOLLOW_UP_PRIVATE_7391', '2026-08-01 10:00:00')`).bind(livePersonId),
      env.DB.prepare(`INSERT INTO person_notes
        (id, person_id, author_email, body, created_at, deleted_at)
        VALUES (3001, ?, 'deleted-note-author@example.com', 'PRIVATE_DELETED_NOTE_7391', '2026-08-01 11:00:00', '2026-08-02 00:00:00')`).bind(livePersonId),
      env.DB.prepare(`INSERT INTO person_notes
        (id, person_id, author_email, body, created_at)
        VALUES (3002, ?, 'deleted-subject-author@example.com', 'PRIVATE_DELETED_SUBJECT_7391', '2026-08-01 12:00:00')`).bind(deletedPersonId),
    ]);
    try {
      const before = await auditRows();
      const warning = await get(NOTES, { cookie: admin });
      expect(warning.status).toBe(200);
      expect(warning.headers.get('cache-control')).toContain('no-store');
      const warningHtml = await warning.text();
      expect(warningHtml).toContain(PEOPLE_NOTES_ACKNOWLEDGEMENT);
      expect(warningHtml).not.toContain('FOLLOW_UP_PRIVATE_7391');
      expect(await auditRows()).toEqual(before);

      const badAck = await notesPost(admin, 'EXPORT NOTES');
      expect(badAck.status).toBe(400);
      expect(await badAck.json()).toEqual({ ok: false, code: 'acknowledgement_required' });
      const crossOrigin = await notesPost(admin, PEOPLE_NOTES_ACKNOWLEDGEMENT, 'https://cross-origin.example');
      expect(crossOrigin.status).toBe(403);
      expect(await auditRows()).toEqual(before);

      let firstCsv = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await notesPost(admin);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
        expect(response.headers.get('content-disposition')).toMatch(
          /^attachment; filename="pastoral-notes-\d{4}-\d{2}-\d{2}\.csv"$/,
        );
        const csv = await response.text();
        if (attempt === 0) firstCsv = csv;
        else expect(csv).toBe(firstCsv);
      }

      expect(firstCsv.split('\r\n')[0]).toBe(PASTORAL_NOTES_EXPORT_HEADERS.join(','));
      const parsed = parseUtf8CsvWithRowNumbers(ENCODER.encode(firstCsv), {
        maxBytes: PASTORAL_NOTES_EXPORT_LIMITS.maxCsvBytes,
        maxRows: PASTORAL_NOTES_EXPORT_LIMITS.maxNotes + 1,
        maxColumns: PASTORAL_NOTES_EXPORT_HEADERS.length,
        maxCellChars: 5_000,
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('notes CSV did not parse');
      expect(parsed.rows[0]).toEqual([...PASTORAL_NOTES_EXPORT_HEADERS]);
      const exportedRows = parsed.rows.slice(1);
      expect(exportedRows).toHaveLength(3);
      const current = exportedRows.find((row) => row[1] === 'current.notes@example.com');
      expect(current).toBeDefined();
      expect(current![0]).toMatch(/^person-\d+$/);
      expect(current![2]).toBe("'+historical-author@example.com");
      expect(current![3]).toBe("'=FOLLOW_UP_PRIVATE_7391");
      expect(firstCsv).not.toContain('PRIVATE_DELETED_NOTE_7391');
      expect(firstCsv).not.toContain('PRIVATE_DELETED_SUBJECT_7391');

      const rows = await auditRows();
      expect(rows).toHaveLength(before.length + 2);
      for (const row of rows.slice(before.length)) {
        expect(row.actor_person_id).toBe(1);
        expect(row.action_kind).toBe('people_notes_export_generated');
        expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        expect(JSON.parse(row.structural_counts_json)).toEqual({ people: 3, notes: 3 });
        expect(Object.keys(JSON.parse(row.structural_counts_json)).sort()).toEqual(['notes', 'people']);
        expect(JSON.stringify(row)).not.toContain('example.com');
        expect(JSON.stringify(row)).not.toContain('FOLLOW_UP_PRIVATE_7391');
      }
    } finally {
      await env.DB.prepare('DELETE FROM audit_events').run();
      await env.DB.prepare('DELETE FROM person_notes WHERE id BETWEEN 3000 AND 3002').run();
      await env.DB.prepare('DELETE FROM people WHERE id IN (?, ?)').bind(livePersonId, deletedPersonId).run();
    }
  });

  it('fails closed with safe JSON and no partial audit when the audit append aborts', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const before = await auditRows();
    await env.DB.prepare(`
      CREATE TRIGGER people_export_test_abort_audit
      BEFORE INSERT ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'test audit failure');
      END
    `).run();
    try {
      const response = await notesPost(admin);
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ ok: false, code: 'export_failed' });
      expect(await auditRows()).toEqual(before);
    } finally {
      await env.DB.prepare('DROP TRIGGER IF EXISTS people_export_test_abort_audit').run();
    }
  });
});
