// Create-only source-column mapping against the BUILT PostgreSQL/Hyperdrive
// worker. The disposable schema is migrated through 0012 by global setup.
import { env, SELF } from 'cloudflare:test';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUtf8CsvWithPhysicalRowNumbers } from '../../src/lib/csvParse';
import { MODULE_KEYS } from '../../src/lib/modules';
import { PEOPLE_IMPORT_HEADERS, type PeopleImportHeader } from '../../src/lib/peopleImport';
import type { PeopleImportMappingContract } from '../../src/lib/peopleImportMapping';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { get, ORIGIN, post } from '../e2e/helpers';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const PAGE = '/admin/people/import/map';
const INSPECT = `${PAGE}/inspect`;
const PROFILES = `${PAGE}/profiles`;
const PREVIEW = `${PAGE}/preview`;
const COMMIT = `${PAGE}/commit`;
const EXPORT = '/admin/people/export.csv';
const CSV_LIMITS = { maxBytes: 256 * 1024, maxRows: 201, maxColumns: 128, maxCellChars: 5_000 };

function pgClient() {
  const connectionString = (env as unknown as { HYPERDRIVE: { connectionString: string } })
    .HYPERDRIVE.connectionString;
  return postgres(connectionString, { max: 1, fetch_types: false, prepare: false, onnotice: () => {} });
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

function modulesBody(disabled: string[]): string {
  const body = new URLSearchParams();
  body.append('action', 'modules');
  for (const key of MODULE_KEYS) if (!disabled.includes(key)) body.append(`module.${key}`, '1');
  return body.toString();
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function sourceCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return `${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function canonicalCsv(records: Array<Partial<Record<PeopleImportHeader, string>>>): string {
  return sourceCsv(
    PEOPLE_IMPORT_HEADERS,
    records.map((record) => PEOPLE_IMPORT_HEADERS.map((header) => record[header] ?? '')),
  );
}

function emptyMappings(): Record<PeopleImportHeader, number | null> {
  return Object.fromEntries(PEOPLE_IMPORT_HEADERS.map((header) => [header, null])) as Record<
    PeopleImportHeader,
    number | null
  >;
}

function simpleMappingConfig() {
  const fieldMappings = emptyMappings();
  fieldMappings.display_name = 0;
  fieldMappings.email = 1;
  return { fieldMappings, constants: { record_type: 'person' }, enumTranslations: {} };
}

function identityMappingConfig(): Pick<
  PeopleImportMappingContract,
  'fieldMappings' | 'constants' | 'enumTranslations'
> {
  return {
    fieldMappings: Object.fromEntries(
      PEOPLE_IMPORT_HEADERS.map((header, index) => [header, index]),
    ) as Record<PeopleImportHeader, number>,
    constants: {},
    enumTranslations: {
      record_type: { person: 'person', dependent: 'dependent' },
      language: { en: 'en', zh: 'zh' },
      membership_status: {
        visitor: 'visitor', regular: 'regular', member: 'member', inactive: 'inactive',
      },
      active: { true: 'true', false: 'false' },
      household_role: { adult: 'adult', child: 'child' },
      household_primary: { true: 'true', false: 'false' },
    },
  };
}

async function mappingUpload(
  path: string,
  cookie: string,
  csv: string,
  fields: Record<string, string> = {},
  origin = ORIGIN,
): Promise<Response> {
  const form = new FormData();
  form.set('csv', new File([csv], 'source.csv', { type: 'text/csv' }));
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST', headers: { cookie, origin }, body: form, redirect: 'manual',
  });
}

async function createProfile(
  cookie: string,
  csv: string,
  name: string,
  config: ReturnType<typeof simpleMappingConfig> | ReturnType<typeof identityMappingConfig>,
): Promise<number> {
  const response = await mappingUpload(PROFILES, cookie, csv, {
    profile_name: name,
    mapping_config: JSON.stringify(config),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { profile: { id: number } };
  return body.profile.id;
}

async function counts(): Promise<{
  people: number;
  households: number;
  memberships: number;
  emailLog: number;
  profiles: number;
}> {
  return withPg(async (sql) => {
    const rows = await sql.unsafe<Record<string, string>[]>(`SELECT
      (SELECT COUNT(*) FROM people) AS people,
      (SELECT COUNT(*) FROM households) AS households,
      (SELECT COUNT(*) FROM household_members) AS memberships,
      (SELECT COUNT(*) FROM email_log) AS email_log,
      (SELECT COUNT(*) FROM people_import_mappings) AS profiles`);
    return {
      people: Number(rows[0].people),
      households: Number(rows[0].households),
      memberships: Number(rows[0].memberships),
      emailLog: Number(rows[0].email_log),
      profiles: Number(rows[0].profiles),
    };
  });
}

beforeEach(async () => {
  await withPg(async (sql) => {
    await sql.unsafe('DELETE FROM people_import_mappings');
    await sql.unsafe(`INSERT INTO people
      (id, display_name, email, role, super_admin, admin_areas)
      VALUES (60, 'Limited PG Mapping Admin', 'limited.pg-mapping@example.com', 'admin', 0, 'bulletins')
      ON CONFLICT(id) DO NOTHING`);
    await sql.unsafe(`INSERT INTO people
      (id, display_name, email, role, super_admin, admin_areas)
      VALUES (61, 'People PG Mapping Admin', 'people.pg-mapping@example.com', 'admin', 0, 'people')
      ON CONFLICT(id) DO NOTHING`);
  });
});

afterEach(async () => {
  const admin = await sessionCookie(1, 'admin@example.com');
  await post('/admin/settings', modulesBody([]), { cookie: admin });
  await withPg(async (sql) => {
    await sql.unsafe('DROP TRIGGER IF EXISTS mapping_test_abort_people ON people');
    await sql.unsafe('DROP FUNCTION IF EXISTS mapping_test_abort_people()');
    await sql.unsafe(`DELETE FROM household_members WHERE household_id IN
      (SELECT id FROM households WHERE name = 'PG Mapping Collision Household')`);
    await sql.unsafe("DELETE FROM households WHERE name = 'PG Mapping Collision Household'");
    await sql.unsafe("DELETE FROM people WHERE email = 'household.pg-mapping@example.com'");
  });
});

describe('PostgreSQL mapping access and profile privacy', () => {
  it('enforces auth, People-area, module, CSRF, and immutable method boundaries', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const peopleAdmin = await sessionCookie(61, 'people.pg-mapping@example.com');
    expect((await get(PAGE)).status).toBe(303);
    expect((await get(PAGE, { cookie: peopleAdmin })).status).toBe(200);
    for (const cookie of [
      await sessionCookie(3, 'sarah.johnson@example.com'),
      await sessionCookie(2, 'pastor.david@example.com'),
      await sessionCookie(60, 'limited.pg-mapping@example.com'),
    ]) {
      expect((await get(PAGE, { cookie })).status).toBe(403);
      expect((await post(INSPECT, 'body-must-not-be-read', { cookie })).status).toBe(403);
    }
    for (const path of [INSPECT, PREVIEW, COMMIT]) {
      const response = await get(path, { cookie: admin });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
    const immutable = await SELF.fetch(`${ORIGIN}${PROFILES}`, {
      method: 'PATCH', headers: { cookie: admin, origin: ORIGIN }, body: 'ignored', redirect: 'manual',
    });
    expect(immutable.status).toBe(405);
    expect(immutable.headers.get('allow')).toBe('GET, POST');
    const crossOrigin = await mappingUpload(
      INSPECT,
      admin,
      sourceCsv(['name', 'email'], [['PG Cross Origin', 'pg.cross-origin@example.com']]),
      {},
      'https://cross-origin.example',
    );
    expect(crossOrigin.status).toBe(403);

    expect((await post('/admin/settings', modulesBody(['people']), { cookie: admin })).status).toBe(303);
    for (const path of [PAGE, INSPECT, PROFILES, PREVIEW, COMMIT]) {
      const response = path === PAGE || path === PROFILES
        ? await get(path, { cookie: admin })
        : await post(path, 'body-must-not-be-read', { cookie: admin });
      expect(response.status).toBe(404);
    }
  });

  it('stores only profile configuration and uses fresh bytes without privileged defaults or email', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const privateSaved = 'PRIVATE_PG_PROFILE_ROW_7391';
    const profileId = await createProfile(
      admin,
      sourceCsv([' Name ', ' Email '], [[privateSaved, 'pg.saved-only@example.com']]),
      'PG example CRM',
      simpleMappingConfig(),
    );
    const inspect = await mappingUpload(
      INSPECT,
      admin,
      sourceCsv([' Name ', ' Email '], [[privateSaved, 'pg.saved-only@example.com']]),
    );
    const inspectText = await inspect.text();
    expect(inspectText).not.toContain(privateSaved);
    expect(JSON.parse(inspectText)).toEqual({
      ok: true, headers: ['name', 'email'], headerRowNumber: 1, dataRows: 1, issues: [],
    });
    const raw = await withPg(async (sql) => {
      const rows = await sql.unsafe<Record<string, string>[]>(`SELECT name, expected_headers_json,
        field_mappings_json, constants_json, enum_translations_json
        FROM people_import_mappings WHERE id = ${profileId}`);
      return rows[0];
    });
    expect(JSON.stringify(raw)).not.toContain(privateSaved);
    expect(JSON.parse(raw.expected_headers_json)).toEqual(['name', 'email']);

    const duplicate = await mappingUpload(PROFILES, admin, sourceCsv(['name', 'email'], []), {
      profile_name: ' pg EXAMPLE crm ',
      mapping_config: JSON.stringify(simpleMappingConfig()),
    });
    expect(duplicate.status).toBe(409);
    const current = sourceCsv(
      ['name', 'email'],
      [['Current PG Mapping', 'current.pg-mapping@example.com']],
    );
    const before = await counts();
    const preview = await mappingUpload(PREVIEW, admin, current, {
      profile_id: String(profileId),
      mapping_config: JSON.stringify(identityMappingConfig()),
      model: 'tampered', role: 'admin', operation: 'merge',
    });
    expect(preview.status).toBe(200);
    const previewText = await preview.text();
    expect(previewText).not.toContain(privateSaved);
    expect(JSON.parse(previewText)).toMatchObject({
      ok: true, mappingIssues: [], preview: { summary: { people: 1 }, issues: [] },
    });
    expect(await counts()).toEqual(before);

    const drift = await mappingUpload(
      PREVIEW,
      admin,
      sourceCsv(['email', 'name'], [['pg.drift@example.com', 'PRIVATE_PG_DRIFT_7391']]),
      { profile_id: String(profileId) },
    );
    const driftText = await drift.text();
    expect(driftText).not.toContain('PRIVATE_PG_DRIFT_7391');
    expect(JSON.parse(driftText)).toMatchObject({
      ok: true,
      mappingIssues: [
        { code: 'header_drift', row: 1, column: 1 },
        { code: 'header_drift', row: 1, column: 2 },
      ],
      preview: null,
    });

    const commit = await mappingUpload(COMMIT, admin, current, {
      profile_id: String(profileId),
      mapping_config: JSON.stringify(identityMappingConfig()),
      model: 'tampered', role: 'admin', operation: 'update', acknowledge_warnings: 'true',
    });
    expect(commit.status).toBe(201);
    const inserted = await withPg(async (sql) => {
      const rows = await sql.unsafe<Record<string, string>[]>(`SELECT display_name, role, active,
        super_admin, admin_areas, finance FROM people WHERE email = 'current.pg-mapping@example.com'`);
      return rows[0];
    });
    expect(inserted).toEqual({
      display_name: 'Current PG Mapping', role: 'member', active: 1,
      super_admin: 0, admin_areas: '', finance: 0,
    });
    const after = await counts();
    expect(after.people).toBe(before.people + 1);
    expect(after.emailLog).toBe(before.emailLog);
  });
});

describe('PostgreSQL fresh checks and atomic mapping commit', () => {
  it('requires warning acknowledgement, catches a late collision, and rolls back a trigger failure', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    await withPg((sql) => sql.unsafe(`INSERT INTO households (name, address)
      VALUES ('PG Mapping Collision Household', 'Old Address')`));
    const family = canonicalCsv([{
      record_type: 'person',
      display_name: 'PG Household Mapping Primary',
      email: 'household.pg-mapping@example.com',
      active: 'true',
      household_key: 'pg-mapping-household',
      household_name: 'PG Mapping Collision Household',
      household_address: 'New Address',
      household_role: 'adult',
      household_primary: 'true',
    }]);
    const identityId = await createProfile(admin, family, 'PG canonical warning', identityMappingConfig());
    const warningPreview = await mappingUpload(PREVIEW, admin, family, { profile_id: String(identityId) });
    expect(await warningPreview.json()).toMatchObject({
      ok: true, preview: { issues: [{ severity: 'warning', code: 'household_name_exists' }] },
    });
    const blocked = await mappingUpload(COMMIT, admin, family, { profile_id: String(identityId) });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ ok: false, code: 'warnings_not_acknowledged' });
    const allowed = await mappingUpload(COMMIT, admin, family, {
      profile_id: String(identityId), acknowledge_warnings: 'true',
    });
    expect(allowed.status).toBe(201);
    expect(await withPg(async (sql) => Number((await sql.unsafe<{ n: string }[]>(
      "SELECT COUNT(*) AS n FROM households WHERE lower(name) = lower('PG Mapping Collision Household')",
    ))[0].n))).toBe(2);

    await withPg((sql) => sql.unsafe('DELETE FROM people_import_mappings'));
    const lateCsv = sourceCsv(['name', 'email'], [['PG Late Mapping', 'late.pg-mapping@example.com']]);
    const simpleId = await createProfile(admin, lateCsv, 'PG fresh preflight', simpleMappingConfig());
    const cleanPreview = await mappingUpload(PREVIEW, admin, lateCsv, { profile_id: String(simpleId) });
    expect(await cleanPreview.json()).toMatchObject({ ok: true, preview: { issues: [] } });
    await withPg((sql) => sql.unsafe(`INSERT INTO people (display_name, email, role)
      VALUES ('PG Late Existing', 'late.pg-mapping@example.com', 'member')`));
    const beforeLate = await counts();
    const late = await mappingUpload(COMMIT, admin, lateCsv, { profile_id: String(simpleId) });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ ok: false, code: 'import_conflict' });
    expect(await counts()).toEqual(beforeLate);

    await withPg(async (sql) => {
      await sql.unsafe(`CREATE FUNCTION mapping_test_abort_people() RETURNS trigger
        LANGUAGE plpgsql AS 'BEGIN IF NEW.email = ''atomic.pg-mapping.two@example.com''
        THEN RAISE EXCEPTION ''test mapping persistence failure''; END IF; RETURN NEW; END'`);
      await sql.unsafe(`CREATE TRIGGER mapping_test_abort_people BEFORE INSERT ON people
        FOR EACH ROW EXECUTE FUNCTION mapping_test_abort_people()`);
    });
    const atomic = sourceCsv(['name', 'email'], [
      ['PG Atomic Mapping One', 'atomic.pg-mapping.one@example.com'],
      ['PG Atomic Mapping Two', 'atomic.pg-mapping.two@example.com'],
    ]);
    const beforeAtomic = await counts();
    const failed = await mappingUpload(COMMIT, admin, atomic, { profile_id: String(simpleId) });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ ok: false, code: 'import_failed' });
    expect(await counts()).toEqual(beforeAtomic);
    expect(await withPg(async (sql) => Number((await sql.unsafe<{ n: string }[]>(
      "SELECT COUNT(*) AS n FROM people WHERE email LIKE 'atomic.pg-mapping.%@example.com'",
    ))[0].n))).toBe(0);
  });
});

describe('PostgreSQL canonical export identity round trip', () => {
  it('imports every export part and re-exports an equivalent canonical row set', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    await withPg(async (sql) => {
      const values = Array.from({ length: 190 }, (_, index) => {
        const id = 6_000 + index;
        return `(${id}, 'Portable', 'PG Mapping', 'Portable PG Mapping ${id}',
          'portable.pg-mapping.${id}@example.com', 'member', 'regular', 1)`;
      }).join(',');
      await sql.unsafe(`INSERT INTO people
        (id, first_name, last_name, display_name, email, role, membership_status, active)
        VALUES ${values}`);
      await sql.unsafe(`SELECT setval(pg_get_serial_sequence('people', 'id'),
        (SELECT MAX(id) FROM people))`);
    });
    const first = await get(`${EXPORT}?part=1`, { cookie: admin });
    expect(first.status).toBe(200);
    const partCount = Number(first.headers.get('x-people-export-parts'));
    expect(partCount).toBeGreaterThan(1);
    const parts = [await first.text()];
    for (let part = 2; part <= partCount; part += 1) {
      const response = await get(`${EXPORT}?part=${part}`, { cookie: admin });
      expect(response.status).toBe(200);
      parts.push(await response.text());
    }
    for (const csv of parts) {
      const parsed = parseUtf8CsvWithPhysicalRowNumbers(new TextEncoder().encode(csv), CSV_LIMITS);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('PG canonical export part did not parse');
      expect(parsed.rows[0]).toEqual([...PEOPLE_IMPORT_HEADERS]);
      expect(parsed.rows.length - 1).toBeLessThanOrEqual(200);
    }

    const profileId = await createProfile(admin, parts[0], 'PG canonical identity', identityMappingConfig());
    const sourceRows = parts.flatMap((csv) => {
      const parsed = parseUtf8CsvWithPhysicalRowNumbers(new TextEncoder().encode(csv), CSV_LIMITS);
      if (!parsed.ok) throw new Error('PG canonical source did not parse');
      return parsed.rows.slice(1);
    });
    const emailIndex = PEOPLE_IMPORT_HEADERS.indexOf('email');
    const typeIndex = PEOPLE_IMPORT_HEADERS.indexOf('record_type');
    const householdNameIndex = PEOPLE_IMPORT_HEADERS.indexOf('household_name');
    const householdKeyIndex = PEOPLE_IMPORT_HEADERS.indexOf('household_key');
    const sourceEmails = new Set(
      sourceRows.filter((row) => row[typeIndex] === 'person').map((row) => row[emailIndex]),
    );
    const sourceHouseholdNames = new Set(
      sourceRows.map((row) => row[householdNameIndex]).filter((name) => name !== ''),
    );
    await withPg(async (sql) => {
      await sql.unsafe("UPDATE people SET email = 'retarget-pg-' || id || '@example.com'");
      await sql.unsafe("UPDATE households SET name = 'retarget-pg-household-' || id");
    });
    const before = await counts();
    let importedRows = 0;
    for (const csv of parts) {
      const response = await mappingUpload(COMMIT, admin, csv, {
        profile_id: String(profileId), acknowledge_warnings: 'true',
      });
      const body = await response.json() as {
        ok: boolean;
        code?: string;
        counts: { people: number; households: number; dependents: number };
      };
      expect({ status: response.status, code: body.code }).toEqual({ status: 201, code: undefined });
      importedRows += body.counts.people + body.counts.dependents;
    }
    expect(importedRows).toBe(sourceRows.length);
    const after = await counts();
    expect(after.people).toBe(before.people + sourceEmails.size);
    expect(after.emailLog).toBe(before.emailLog);
    expect(after.profiles).toBe(1);

    const targetFirst = await get(`${EXPORT}?part=1`, { cookie: admin });
    expect(targetFirst.status).toBe(200);
    const targetPartCount = Number(targetFirst.headers.get('x-people-export-parts'));
    const targetParts = [await targetFirst.text()];
    for (let part = 2; part <= targetPartCount; part += 1) {
      targetParts.push(await (await get(`${EXPORT}?part=${part}`, { cookie: admin })).text());
    }
    const targetRows = targetParts.flatMap((csv) => {
      const parsed = parseUtf8CsvWithPhysicalRowNumbers(new TextEncoder().encode(csv), CSV_LIMITS);
      if (!parsed.ok) throw new Error('PG canonical target did not parse');
      return parsed.rows.slice(1);
    }).filter((row) => (
      (row[typeIndex] === 'person' && sourceEmails.has(row[emailIndex]))
      || (row[typeIndex] === 'dependent' && sourceHouseholdNames.has(row[householdNameIndex]))
    ));
    const semanticRows = (rows: string[][]): string[] => rows.map((row) => {
      const copy = [...row];
      copy[householdKeyIndex] = copy[householdNameIndex] === ''
        ? ''
        : `household:${copy[householdNameIndex].trim().normalize('NFC').toLowerCase()}`;
      return JSON.stringify(copy);
    }).sort();
    expect(semanticRows(targetRows)).toEqual(semanticRows(sourceRows));
  });
});
