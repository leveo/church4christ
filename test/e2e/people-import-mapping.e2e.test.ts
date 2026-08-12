// Create-only source-column mapping against the BUILT D1 worker. Fixtures are
// fictional example.com records; response assertions never print uploaded cells.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseUtf8CsvWithPhysicalRowNumbers } from '../../src/lib/csvParse';
import { MODULE_KEYS } from '../../src/lib/modules';
import { PEOPLE_IMPORT_HEADERS, type PeopleImportHeader } from '../../src/lib/peopleImport';
import type { PeopleImportMappingContract } from '../../src/lib/peopleImportMapping';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { get, ORIGIN, post } from './helpers';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const PAGE = '/admin/people/import/map';
const INSPECT = `${PAGE}/inspect`;
const PROFILES = `${PAGE}/profiles`;
const PREVIEW = `${PAGE}/preview`;
const COMMIT = `${PAGE}/commit`;
const EXPORT = '/admin/people/export.csv';
const CSV_LIMITS = { maxBytes: 256 * 1024, maxRows: 201, maxColumns: 128, maxCellChars: 5_000 };

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
  return {
    fieldMappings,
    constants: { record_type: 'person' },
    enumTranslations: {},
  };
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
    method: 'POST',
    headers: { cookie, origin },
    body: form,
    redirect: 'manual',
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
  const count = async (table: string): Promise<number> => {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return row?.n ?? -1;
  };
  return {
    people: await count('people'),
    households: await count('households'),
    memberships: await count('household_members'),
    emailLog: await count('email_log'),
    profiles: await count('people_import_mappings'),
  };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM people_import_mappings').run();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people
      (id, display_name, email, role, super_admin, admin_areas)
      VALUES (60, 'Limited Mapping Admin', 'limited.mapping@example.com', 'admin', 0, 'bulletins')
      ON CONFLICT(id) DO NOTHING`),
    env.DB.prepare(`INSERT INTO people
      (id, display_name, email, role, super_admin, admin_areas)
      VALUES (61, 'People Mapping Admin', 'people.mapping@example.com', 'admin', 0, 'people')
      ON CONFLICT(id) DO NOTHING`),
  ]);
});

afterEach(async () => {
  const admin = await sessionCookie(1, 'admin@example.com');
  await post('/admin/settings', modulesBody([]), { cookie: admin });
  await env.DB.prepare('DROP TRIGGER IF EXISTS mapping_test_abort_people').run();
  await env.DB.prepare(`DELETE FROM household_members WHERE household_id IN
    (SELECT id FROM households WHERE name = 'Mapping Collision Household')`).run();
  await env.DB.prepare("DELETE FROM households WHERE name = 'Mapping Collision Household'").run();
  await env.DB.prepare("DELETE FROM people WHERE email = 'household.mapping@example.com'").run();
});

describe('mapping access, methods, and private inspection', () => {
  it('applies auth, People-area, module, CSRF, and method gates before reading uploads', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const peopleAdmin = await sessionCookie(61, 'people.mapping@example.com');
    const denied = [
      await sessionCookie(3, 'sarah.johnson@example.com'),
      await sessionCookie(2, 'pastor.david@example.com'),
      await sessionCookie(60, 'limited.mapping@example.com'),
    ];

    const anonymous = await get(PAGE);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toContain('/en/signin?next=');
    expect((await get(PAGE, { cookie: peopleAdmin })).status).toBe(200);
    expect((await get(PAGE, { cookie: admin })).status).toBe(200);
    for (const cookie of denied) {
      expect((await get(PAGE, { cookie })).status).toBe(403);
      expect((await post(INSPECT, 'body-must-not-be-read', { cookie })).status).toBe(403);
    }

    for (const path of [INSPECT, PREVIEW, COMMIT]) {
      const response = await get(path, { cookie: admin });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
    const profilesPut = await SELF.fetch(`${ORIGIN}${PROFILES}`, {
      method: 'PUT', headers: { cookie: admin, origin: ORIGIN }, body: 'ignored', redirect: 'manual',
    });
    expect(profilesPut.status).toBe(405);
    expect(profilesPut.headers.get('allow')).toBe('GET, POST');

    const crossOrigin = await mappingUpload(
      INSPECT,
      admin,
      sourceCsv(['name', 'email'], [['Private Cross Origin', 'cross-origin@example.com']]),
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

  it('returns only normalized headers, row count, and bounded issue metadata', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const privateValue = 'PRIVATE_INSPECTION_CELL_7391';
    const response = await mappingUpload(
      INSPECT,
      admin,
      sourceCsv([' Name ', 'E\u0301mail'], [[privateValue, 'inspect@example.com']]),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const text = await response.text();
    expect(text).not.toContain(privateValue);
    expect(JSON.parse(text)).toEqual({
      ok: true,
      headers: ['name', 'émail'],
      headerRowNumber: 1,
      dataRows: 1,
      issues: [],
    });
  });
});

describe('immutable mapping profiles and authoritative current bytes', () => {
  it('creates, lists, and gets profiles without persisting uploaded rows or sample values', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const privateValue = 'PRIVATE_PROFILE_ROW_7391';
    const csv = sourceCsv(['name', 'email'], [[privateValue, 'profile-row@example.com']]);
    const id = await createProfile(admin, csv, 'Example CRM', simpleMappingConfig());

    const list = await get(PROFILES, { cookie: admin });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      ok: true,
      profiles: [{ id, name: 'Example CRM', version: 1, createdByPersonId: 1 }],
    });
    const detail = await get(`${PROFILES}?id=${id}`, { cookie: admin });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      ok: true,
      profile: {
        id,
        expectedHeaders: ['name', 'email'],
        constants: { record_type: 'person' },
        enumTranslations: {},
      },
    });

    const raw = await env.DB.prepare(`SELECT name, expected_headers_json, field_mappings_json,
      constants_json, enum_translations_json FROM people_import_mappings WHERE id = ?`)
      .bind(id).first<Record<string, string>>();
    expect(raw).not.toBeNull();
    expect(JSON.stringify(raw)).not.toContain(privateValue);
    expect(JSON.parse(raw!.expected_headers_json)).toEqual(['name', 'email']);
    expect(Object.keys(raw!).sort()).toEqual([
      'constants_json', 'enum_translations_json', 'expected_headers_json',
      'field_mappings_json', 'name',
    ]);

    const duplicate = await mappingUpload(PROFILES, admin, csv, {
      profile_name: '  example crm  ',
      mapping_config: JSON.stringify(simpleMappingConfig()),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ ok: false, code: 'mapping_profile_conflict' });
    expect((await counts()).profiles).toBe(1);
  });

  it('previews and commits only current bytes with the saved profile, ignoring client authority fields', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const savedOnly = 'PRIVATE_PROFILE_CREATION_7391';
    const currentOnly = 'Current Mapping Example';
    const profileId = await createProfile(
      admin,
      sourceCsv(['name', 'email'], [[savedOnly, 'saved-only@example.com']]),
      'Current bytes profile',
      simpleMappingConfig(),
    );
    const current = sourceCsv(['name', 'email'], [[currentOnly, 'current-bytes@example.com']]);
    const before = await counts();

    const preview = await mappingUpload(PREVIEW, admin, current, {
      profile_id: String(profileId),
      mapping_config: JSON.stringify({ fieldMappings: {}, constants: {}, enumTranslations: {} }),
      model: JSON.stringify({ people: [{ email: 'tampered@example.com' }] }),
      role: 'admin',
      operation: 'merge',
    });
    expect(preview.status).toBe(200);
    const previewText = await preview.text();
    expect(previewText).not.toContain(savedOnly);
    expect(JSON.parse(previewText)).toMatchObject({
      ok: true,
      profile: { id: profileId, version: 1 },
      mappingIssues: [],
      preview: { ok: true, summary: { people: 1, households: 0, dependents: 0 } },
    });
    expect(await counts()).toEqual(before);

    const drift = await mappingUpload(
      PREVIEW,
      admin,
      sourceCsv(['email', 'name'], [['drift@example.com', 'PRIVATE_DRIFT_7391']]),
      { profile_id: String(profileId) },
    );
    expect(drift.status).toBe(200);
    const driftText = await drift.text();
    expect(driftText).not.toContain('PRIVATE_DRIFT_7391');
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
      model: 'client-model-is-not-authority',
      role: 'admin',
      operation: 'update',
      acknowledge_warnings: 'true',
    });
    expect(commit.status).toBe(201);
    expect(await commit.json()).toEqual({
      ok: true, counts: { people: 1, households: 0, dependents: 0 },
    });
    const inserted = await env.DB.prepare(`SELECT display_name, role, active, super_admin,
      admin_areas, finance FROM people WHERE email = ?`)
      .bind('current-bytes@example.com').first<Record<string, unknown>>();
    expect(inserted).toEqual({
      display_name: currentOnly,
      role: 'member',
      active: 1,
      super_admin: 0,
      admin_areas: '',
      finance: 0,
    });
    expect(await env.DB.prepare('SELECT 1 FROM people WHERE email = ?')
      .bind('saved-only@example.com').first()).toBeNull();
    const after = await counts();
    expect(after.people).toBe(before.people + 1);
    expect(after.emailLog).toBe(before.emailLog);
  });
});

describe('fresh preflight, warning acknowledgement, and atomic writes', () => {
  it('requires warning acknowledgement but never attaches to the existing household', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    await env.DB.prepare(`INSERT INTO households (name, address) VALUES
      ('Mapping Collision Household', 'Old Address')`).run();
    const csv = canonicalCsv([{
      record_type: 'person',
      display_name: 'Household Mapping Primary',
      email: 'household.mapping@example.com',
      active: 'true',
      household_key: 'mapping-household',
      household_name: 'Mapping Collision Household',
      household_address: 'New Address',
      household_role: 'adult',
      household_primary: 'true',
    }]);
    const profileId = await createProfile(admin, csv, 'Canonical warning', identityMappingConfig());
    const preview = await mappingUpload(PREVIEW, admin, csv, { profile_id: String(profileId) });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      ok: true,
      preview: { issues: [{ severity: 'warning', code: 'household_name_exists' }] },
    });

    const blocked = await mappingUpload(COMMIT, admin, csv, { profile_id: String(profileId) });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ ok: false, code: 'warnings_not_acknowledged' });
    const committed = await mappingUpload(COMMIT, admin, csv, {
      profile_id: String(profileId), acknowledge_warnings: 'true',
    });
    expect(committed.status).toBe(201);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM households WHERE lower(name) = lower(?)')
      .bind('Mapping Collision Household').first<{ n: number }>()).toEqual({ n: 2 });
  });

  it('rechecks late collisions and rolls the whole D1 batch back on a persistence failure', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const initial = sourceCsv(['name', 'email'], [['Late Mapping', 'late.mapping@example.com']]);
    const profileId = await createProfile(admin, initial, 'Fresh preflight', simpleMappingConfig());
    const preview = await mappingUpload(PREVIEW, admin, initial, { profile_id: String(profileId) });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ ok: true, preview: { issues: [] } });
    await env.DB.prepare(`INSERT INTO people (display_name, email, role)
      VALUES ('Late Existing', 'late.mapping@example.com', 'member')`).run();
    const beforeLateCommit = await counts();
    const late = await mappingUpload(COMMIT, admin, initial, { profile_id: String(profileId) });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ ok: false, code: 'import_conflict' });
    expect(await counts()).toEqual(beforeLateCommit);

    const atomic = sourceCsv(['name', 'email'], [
      ['Atomic Mapping One', 'atomic.mapping.one@example.com'],
      ['Atomic Mapping Two', 'atomic.mapping.two@example.com'],
    ]);
    await env.DB.prepare(`CREATE TRIGGER mapping_test_abort_people
      BEFORE INSERT ON people WHEN NEW.email = 'atomic.mapping.two@example.com'
      BEGIN SELECT RAISE(ABORT, 'test mapping persistence failure'); END`).run();
    const beforeAtomicCommit = await counts();
    const failed = await mappingUpload(COMMIT, admin, atomic, { profile_id: String(profileId) });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ ok: false, code: 'import_failed' });
    expect(await counts()).toEqual(beforeAtomicCommit);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE email LIKE 'atomic.mapping.%@example.com'")
      .first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe('canonical export to identity mapping round trip', () => {
  it('imports every bounded export part and re-exports an equivalent canonical row set', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    await env.DB.batch(Array.from({ length: 190 }, (_, index) => {
      const id = 4_000 + index;
      return env.DB.prepare(`INSERT INTO people
        (id, first_name, last_name, display_name, email, role, membership_status, active)
        VALUES (?, 'Portable', 'Mapping', ?, ?, 'member', 'regular', 1)`)
        .bind(id, `Portable Mapping ${id}`, `portable.mapping.${id}@example.com`);
    }));

    const firstDownload = await get(`${EXPORT}?part=1`, { cookie: admin });
    expect(firstDownload.status).toBe(200);
    const partCount = Number(firstDownload.headers.get('x-people-export-parts'));
    expect(partCount).toBeGreaterThan(1);
    const parts = [await firstDownload.text()];
    for (let part = 2; part <= partCount; part += 1) {
      const response = await get(`${EXPORT}?part=${part}`, { cookie: admin });
      expect(response.status).toBe(200);
      parts.push(await response.text());
    }
    for (const csv of parts) {
      const parsed = parseUtf8CsvWithPhysicalRowNumbers(new TextEncoder().encode(csv), CSV_LIMITS);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('canonical export part did not parse');
      expect(parsed.rows[0]).toEqual([...PEOPLE_IMPORT_HEADERS]);
      expect(parsed.rows.length - 1).toBeLessThanOrEqual(200);
    }

    const profileId = await createProfile(admin, parts[0], 'Canonical identity', identityMappingConfig());
    const sourceRows = parts.flatMap((csv) => {
      const parsed = parseUtf8CsvWithPhysicalRowNumbers(new TextEncoder().encode(csv), CSV_LIMITS);
      if (!parsed.ok) throw new Error('canonical source did not parse');
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

    await env.DB.prepare("UPDATE people SET email = 'retarget-' || id || '@example.com'").run();
    await env.DB.prepare("UPDATE households SET name = 'retarget-household-' || id").run();
    const before = await counts();
    let importedRows = 0;
    for (const csv of parts) {
      const response = await mappingUpload(COMMIT, admin, csv, { profile_id: String(profileId) });
      expect(response.status).toBe(201);
      const body = await response.json() as {
        counts: { people: number; households: number; dependents: number };
      };
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
      if (!parsed.ok) throw new Error('canonical target did not parse');
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
