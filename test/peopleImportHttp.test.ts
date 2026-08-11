import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb, AppDbResult, AppStatement } from '../src/lib/appDb';
import {
  PEOPLE_IMPORT_HEADERS,
  PEOPLE_IMPORT_LIMITS,
  parsePeopleImport,
  type PeopleImportHeader,
} from '../src/lib/peopleImport';
import {
  PeopleImportConflictError,
  PeopleImportNotReadyError,
  PeopleImportPersistenceError,
} from '../src/lib/peopleImportDb';
import type { SessionUser } from '../src/lib/types';
import {
  PEOPLE_IMPORT_MULTIPART_MAX_BYTES,
  canManagePeopleImport,
  peopleImportCommitErrorResponse,
  peopleImportJson,
  peopleImportTemplate,
  readPeopleImportFile,
} from '../src/lib/peopleImportHttp';
import * as templateRoute from '../src/pages/admin/people/import/template.csv';
import * as previewRoute from '../src/pages/admin/people/import/preview';
import * as commitRoute from '../src/pages/admin/people/import/commit';
import { peopleImportCsvBytes } from './fixtures/peopleImport';

const makeUser = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 1,
  email: 'admin@example.com',
  displayName: 'Admin',
  role: 'admin',
  isAdmin: true,
  isEditor: false,
  finance: 0,
  memberTeamIds: [],
  leaderTeamIds: [],
  lang: 'en',
  isSuperAdmin: false,
  adminAreas: [],
  ...over,
});

const grantedAdmin = makeUser({ adminAreas: ['people'] });
const superAdmin = makeUser({ isSuperAdmin: true });

function uploadRequest(
  file: File | string | null,
  acknowledgeWarnings?: string,
): Request {
  const form = new FormData();
  if (file !== null) form.set('csv', file);
  if (acknowledgeWarnings !== undefined) {
    form.set('acknowledge_warnings', acknowledgeWarnings);
  }
  return new Request('https://church.example/admin/people/import/preview', {
    method: 'POST',
    body: form,
  });
}

function multipartRequest(csvParts: Array<File | string>): Request {
  const form = new FormData();
  for (const part of csvParts) form.append('csv', part);
  return new Request('https://church.example/admin/people/import/preview', {
    method: 'POST',
    body: form,
  });
}

type ImportRecord = Partial<Record<PeopleImportHeader, string>>;

const personRecord = (email: string, overrides: ImportRecord = {}): ImportRecord => ({
  record_type: 'person',
  display_name: 'Imported Person',
  email,
  ...overrides,
});

const familyRecords = (suffix = 'one'): ImportRecord[] => [
  personRecord(`primary-${suffix}@example.com`, {
    display_name: `Primary ${suffix}`,
    household_key: `family-${suffix}`,
    household_name: `Family ${suffix}`,
    household_address: `${suffix} Main St`,
    household_phone: `555-${suffix}`,
    household_role: 'adult',
    household_primary: 'true',
  }),
  {
    record_type: 'dependent',
    display_name: `Dependent ${suffix}`,
    household_key: `family-${suffix}`,
    household_role: 'child',
  },
];

function endpointRequest(
  endpoint: 'preview' | 'commit',
  records: ImportRecord[],
  options: {
    acknowledgeWarnings?: string;
    fields?: Record<string, string>;
  } = {},
): Request {
  const form = new FormData();
  const bytes = new Uint8Array(peopleImportCsvBytes(records));
  form.set('csv', new File([bytes], 'people.csv', { type: 'text/csv' }));
  if (options.acknowledgeWarnings !== undefined) {
    form.set('acknowledge_warnings', options.acknowledgeWarnings);
  }
  for (const [key, value] of Object.entries(options.fields ?? {})) form.set(key, value);
  return new Request(`https://church.example/admin/people/import/${endpoint}`, {
    method: 'POST',
    body: form,
  });
}

const routeContext = (
  request: Request,
  overrides: {
    user?: SessionUser | null;
    modules?: Set<string>;
    db?: AppDb;
    dbBackend?: 'd1' | 'supabase';
  } = {},
) => ({
  request,
  locals: {
    user: overrides.user === undefined ? grantedAdmin : overrides.user,
    modules: overrides.modules ?? new Set(['people']),
    db: overrides.db ?? env.DB,
    dbBackend: overrides.dbBackend ?? 'd1',
  },
}) as never;

async function resetImportTables(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM household_members'),
    env.DB.prepare('DELETE FROM households'),
    env.DB.prepare('DELETE FROM email_log'),
    env.DB.prepare('DELETE FROM people'),
  ]);
}

async function importTableCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ['people', 'households', 'household_members', 'email_log']) {
    counts[table] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n')) ?? -1;
  }
  return counts;
}

class LateCollisionDb implements AppDb {
  private peopleScans = 0;

  constructor(private readonly delegate: AppDb, private readonly email: string) {}

  prepare(sql: string): AppStatement {
    let bound = this.delegate.prepare(sql);
    const statement: AppStatement = {
      bind: (...values: unknown[]) => {
        bound = bound.bind(...values);
        return statement;
      },
      first: <T = unknown>(column?: string) => bound.first<T>(column),
      all: async <T = unknown>() => {
        if (sql.includes('FROM people')) {
          this.peopleScans += 1;
          if (this.peopleScans === 2) {
            await this.delegate.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)')
              .bind('Concurrent writer', this.email)
              .run();
          }
        }
        return bound.all<T>();
      },
      run: <T = unknown>() => bound.run<T>(),
    };
    return statement;
  }

  batch<T = unknown>(_statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    throw new Error('batch must not run after a late collision');
  }
}

describe('canManagePeopleImport', () => {
  it('returns not_found first when the people module is off', () => {
    expect(canManagePeopleImport(null, new Set())).toBe('not_found');
    expect(canManagePeopleImport(grantedAdmin, new Set())).toBe('not_found');
  });

  it('forbids anonymous, non-admin, and limited admins without the people grant', () => {
    const member = makeUser({ role: 'member', isAdmin: false, adminAreas: ['people'] });
    expect(canManagePeopleImport(null, new Set(['people']))).toBe('forbidden');
    expect(canManagePeopleImport(member, new Set(['people']))).toBe('forbidden');
    expect(canManagePeopleImport(makeUser(), new Set(['people']))).toBe('forbidden');
  });

  it('allows a people-granted limited admin and a super admin', () => {
    expect(canManagePeopleImport(grantedAdmin, new Set(['people']))).toBe('ok');
    expect(canManagePeopleImport(superAdmin, new Set(['people']))).toBe('ok');
  });
});

describe('peopleImportTemplate', () => {
  it('has the exact 18-column header and safe person/dependent example rows', () => {
    const template = peopleImportTemplate();
    const rows = template.trimEnd().split('\n');
    expect(rows).toHaveLength(3);
    expect(rows[0].split(',')).toEqual([...PEOPLE_IMPORT_HEADERS]);
    expect(PEOPLE_IMPORT_HEADERS).toHaveLength(18);

    const parsed = parsePeopleImport(new TextEncoder().encode(template), { today: '2026-08-11' });
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.model?.summary).toEqual({
      dataRows: 2,
      people: 1,
      dependents: 1,
      households: 1,
      inactivePeople: 0,
    });
  });
});

describe('readPeopleImportFile', () => {
  it('rejects a non-multipart request without reading its body', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
        throw new Error('body must not be read');
      },
    }, { highWaterMark: 0 });
    const request = new Request('https://church.example/import', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
    });

    await expect(readPeopleImportFile(request)).resolves.toEqual({
      ok: false,
      status: 415,
      code: 'multipart_required',
    });
    expect(pulled).toBe(false);
  });

  it('uses Content-Length only as a fast envelope rejection', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
        throw new Error('oversize body must not be read');
      },
    }, { highWaterMark: 0 });
    const request = new Request('https://church.example/import', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=bounded',
        'content-length': String(PEOPLE_IMPORT_MULTIPART_MAX_BYTES + 1),
      },
      body,
    });

    await expect(readPeopleImportFile(request)).resolves.toEqual({
      ok: false,
      status: 413,
      code: 'file_too_large',
    });
    expect(pulled).toBe(false);
  });

  it('counts a streaming envelope and cancels it before formData parsing when it exceeds the cap', async () => {
    let cancelled = false;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.close();
        sent = true;
        controller.enqueue(new Uint8Array(PEOPLE_IMPORT_MULTIPART_MAX_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('https://church.example/import', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=bounded' },
      body,
    });

    await expect(readPeopleImportFile(request)).resolves.toEqual({
      ok: false,
      status: 413,
      code: 'file_too_large',
    });
    expect(cancelled).toBe(true);
  });

  it('keeps an oversize response at 413 when stream cancellation rejects', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(PEOPLE_IMPORT_MULTIPART_MAX_BYTES + 1));
      },
      cancel() {
        cancelled = true;
        throw new Error('private stream cancellation detail');
      },
    });
    const request = new Request('https://church.example/import', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=bounded' },
      body,
    });

    await expect(readPeopleImportFile(request)).resolves.toEqual({
      ok: false,
      status: 413,
      code: 'file_too_large',
    });
    expect(cancelled).toBe(true);
  });

  it('maps malformed multipart and body-read failures to multipart_invalid', async () => {
    const malformed = new Request('https://church.example/import', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=broken' },
      body: 'not-a-multipart-envelope',
    });
    await expect(readPeopleImportFile(malformed)).resolves.toEqual({
      ok: false,
      status: 400,
      code: 'multipart_invalid',
    });

    const unreadable = new Request('https://church.example/import', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=broken' },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('private body-read detail'));
        },
      }, { highWaterMark: 0 }),
    });
    await expect(readPeopleImportFile(unreadable)).resolves.toEqual({
      ok: false,
      status: 400,
      code: 'multipart_invalid',
    });
  });

  it('distinguishes a missing csv from invalid or duplicate csv parts', async () => {
    await expect(readPeopleImportFile(uploadRequest(null))).resolves.toEqual({
      ok: false,
      status: 400,
      code: 'missing_file',
    });
    await expect(readPeopleImportFile(uploadRequest('not a file'))).resolves.toEqual({
      ok: false,
      status: 400,
      code: 'multipart_invalid',
    });

    const csv = () => new File(['ok'], 'people.csv', { type: 'text/csv' });
    for (const parts of [[csv(), csv()], [csv(), 'not a file'], ['not a file', csv()]]) {
      await expect(readPeopleImportFile(multipartRequest(parts))).resolves.toEqual({
        ok: false,
        status: 400,
        code: 'multipart_invalid',
      });
    }
  });

  it('allows only the explicit CSV MIME allowlist', async () => {
    for (const type of [
      'text/csv',
      'application/vnd.ms-excel',
      'application/octet-stream',
    ]) {
      const result = await readPeopleImportFile(uploadRequest(new File(['ok'], 'people.csv', { type })));
      expect(result.ok, type).toBe(true);
    }

    await expect(readPeopleImportFile(
      uploadRequest(new File(['no'], 'people.csv', { type: 'text/plain' })),
    )).resolves.toEqual({ ok: false, status: 415, code: 'file_type_invalid' });
  });

  it('accepts a file at 256 KiB and rejects one byte over', async () => {
    const atLimit = new File(
      [new Uint8Array(PEOPLE_IMPORT_LIMITS.maxBytes)],
      'at-limit.csv',
      { type: 'text/csv' },
    );
    const accepted = await readPeopleImportFile(uploadRequest(atLimit));
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.bytes.byteLength).toBe(PEOPLE_IMPORT_LIMITS.maxBytes);

    const tooLarge = new File(
      [new Uint8Array(PEOPLE_IMPORT_LIMITS.maxBytes + 1)],
      'too-large.csv',
      { type: 'text/csv' },
    );
    await expect(readPeopleImportFile(uploadRequest(tooLarge))).resolves.toEqual({
      ok: false,
      status: 413,
      code: 'file_too_large',
    });
  });

  it('recognizes only the literal warning acknowledgement string true', async () => {
    const csv = () => new File(['ok'], 'people.csv', { type: 'text/csv' });
    const accepted = await readPeopleImportFile(uploadRequest(csv(), 'true'));
    expect(accepted.ok && accepted.acknowledgeWarnings).toBe(true);

    for (const value of ['TRUE', '1', 'on', ' true ']) {
      const result = await readPeopleImportFile(uploadRequest(csv(), value));
      expect(result.ok && result.acknowledgeWarnings, value).toBe(false);
    }
  });
});

describe('peopleImportJson', () => {
  it('sets private no-store JSON headers, nosniff, and preserves endpoint headers', async () => {
    const response = peopleImportJson(405, { ok: false, code: 'method_not_allowed' }, {
      Allow: 'POST',
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('allow')).toBe('POST');
    expect(await response.json()).toEqual({ ok: false, code: 'method_not_allowed' });
  });
});

describe('people import template route', () => {
  const context = (user: SessionUser | null, modules: Set<string>) => ({
    locals: { user, modules },
  }) as never;

  it('exports GET and a safe method rejection for every other routed method', async () => {
    expect(typeof templateRoute.GET).toBe('function');
    const all = Reflect.get(templateRoute, 'ALL') as undefined | ((context: never) => Promise<Response>);
    expect(typeof all).toBe('function');

    const response = await all!({} as never);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toEqual({ ok: false, code: 'method_not_allowed' });
  });

  it('returns module-off 404 before grant handling and 403 without the people grant', async () => {
    expect((await templateRoute.GET(context(null, new Set()))).status).toBe(404);
    expect((await templateRoute.GET(context(makeUser(), new Set(['people'])))).status).toBe(403);
  });

  it('downloads the canonical private template for people-granted admins', async () => {
    const response = await templateRoute.GET(context(grantedAdmin, new Set(['people'])));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="church4christ-people-import.csv"',
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await response.text()).split('\n')[0]).toBe(PEOPLE_IMPORT_HEADERS.join(','));
  });
});

describe('people import preview and commit route guards', () => {
  const throwingDb: AppDb = {
    prepare: vi.fn(() => {
      throw new Error('database must not be reached');
    }),
    batch: vi.fn(() => {
      throw new Error('database must not be reached');
    }),
  };

  const context = (
    request: Request,
    user: SessionUser | null = grantedAdmin,
    modules: Set<string> = new Set(['people']),
    db: AppDb = env.DB,
  ) => ({
    request,
    locals: { request, user, modules, db, dbBackend: 'd1' },
  }) as never;

  it('exports POST plus a safe ALL 405 response on both endpoints', async () => {
    for (const route of [previewRoute, commitRoute]) {
      expect(typeof route.POST).toBe('function');
      expect(typeof route.ALL).toBe('function');
      const response = await route.ALL({} as never);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.json()).toEqual({ ok: false, code: 'method_not_allowed' });
    }
  });

  it('returns module 404 or grant 403 before reading the body or touching the database', async () => {
    for (const route of [previewRoute, commitRoute]) {
      for (const [user, modules, status] of [
        [grantedAdmin, new Set<string>(), 404],
        [makeUser(), new Set(['people']), 403],
      ] as const) {
        let pulled = false;
        const request = new Request('https://church.example/admin/people/import/action', {
          method: 'POST',
          headers: { 'content-type': 'multipart/form-data; boundary=private' },
          body: new ReadableStream<Uint8Array>({
            pull() {
              pulled = true;
              throw new Error('body must not be read');
            },
          }, { highWaterMark: 0 }),
        });

        expect((await route.POST(context(request, user, modules, throwingDb))).status).toBe(status);
        expect(pulled).toBe(false);
      }
    }
    expect(throwingDb.prepare).not.toHaveBeenCalled();
    expect(throwingDb.batch).not.toHaveBeenCalled();
  });
});

describe('people import preview endpoint', () => {
  beforeEach(resetImportTables);

  it('maps multipart failures and envelope overflow through the endpoint', async () => {
    const malformed = new Request('https://church.example/admin/people/import/preview', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=broken' },
      body: 'private malformed body',
    });
    const malformedResponse = await previewRoute.POST(routeContext(malformed));
    expect(malformedResponse.status).toBe(400);
    expect(await malformedResponse.json()).toEqual({ ok: false, code: 'multipart_invalid' });
    expect(await (await previewRoute.POST(routeContext(new Request(
      'https://church.example/admin/people/import/preview',
      { method: 'POST', body: 'not multipart' },
    )))).json()).toEqual({ ok: false, code: 'multipart_required' });

    let pulled = false;
    const oversize = new Request('https://church.example/admin/people/import/preview', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=bounded',
        'content-length': String(PEOPLE_IMPORT_MULTIPART_MAX_BYTES + 1),
      },
      body: new ReadableStream<Uint8Array>({
        pull() {
          pulled = true;
          throw new Error('must fast reject');
        },
      }, { highWaterMark: 0 }),
    });
    const response = await previewRoute.POST(routeContext(oversize));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, code: 'file_too_large' });
    expect(pulled).toBe(false);
  });

  it('returns safe parser issues and skips DB preflight when pure errors exist', async () => {
    const db: AppDb = {
      prepare: vi.fn(() => {
        throw new Error('preflight must not run');
      }),
      batch: vi.fn(() => {
        throw new Error('batch must not run');
      }),
    };
    const privateValue = '<private-person-value>';
    const response = await previewRoute.POST(routeContext(endpointRequest('preview', [
      personRecord(privateValue),
    ]), { db }));
    const body = await response.json() as {
      ok: boolean;
      summary: unknown;
      rows: unknown[];
      households: unknown[];
      issues: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['households', 'issues', 'ok', 'rows', 'summary']);
    expect(body.rows).toEqual([]);
    expect(body.households).toEqual([]);
    expect(body.issues).toContainEqual({
      severity: 'error',
      code: 'invalid_email',
      row: 2,
      field: 'email',
    });
    expect(Object.keys(body.issues[0]).sort()).toEqual(['code', 'field', 'row', 'severity']);
    expect(JSON.stringify(body)).not.toContain(privateValue);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('returns an explicit normalized DTO and performs no writes', async () => {
    const before = await importTableCounts();
    const batch = vi.fn(() => {
      throw new Error('preview batch must not run');
    });
    const readOnlyDb: AppDb = {
      prepare: (sql) => env.DB.prepare(sql),
      batch,
    };

    const response = await previewRoute.POST(routeContext(
      endpointRequest('preview', familyRecords()),
      { db: readOnlyDb },
    ));
    const body = await response.json() as {
      ok: boolean;
      summary: Record<string, number>;
      rows: Array<Record<string, unknown>>;
      households: Array<Record<string, unknown>>;
      issues: unknown[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(body.summary).toEqual({
      dataRows: 2,
      people: 1,
      dependents: 1,
      households: 1,
      inactivePeople: 0,
    });
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      row: 2,
      recordType: 'person',
      displayName: 'Primary one',
      email: 'primary-one@example.com',
      firstName: null,
      lastName: null,
      phone: null,
      language: null,
      membershipStatus: 'visitor',
      birthday: null,
      joinedOn: null,
      address: null,
      active: true,
      role: 'member',
      household: {
        key: 'family-one',
        name: 'Family one',
        address: 'one Main St',
        phone: '555-one',
        role: 'adult',
        primary: true,
      },
    });
    expect(body.rows[1]).toEqual({
      row: 3,
      recordType: 'dependent',
      displayName: 'Dependent one',
      household: {
        key: 'family-one',
        name: 'Family one',
        address: 'one Main St',
        phone: '555-one',
        role: 'child',
        primary: false,
      },
    });
    expect(body.households).toEqual([{
      key: 'family-one',
      name: 'Family one',
      address: 'one Main St',
      phone: '555-one',
      primaryEmail: 'primary-one@example.com',
      peopleRows: [2],
      dependentRows: [3],
    }]);
    expect(body.issues).toEqual([]);
    expect('model' in body).toBe(false);
    expect(batch).not.toHaveBeenCalled();
    expect(await importTableCounts()).toEqual(before);
  });

  it('combines parser and DB warnings under one deterministic 100-issue cap', async () => {
    const records = Array.from({ length: 60 }, (_, index) => personRecord(
      `person-${index}@example.com`,
      {
        display_name: `Person ${index}`,
        household_key: `family-${index}`,
        household_name: 'Shared Family Name',
        household_role: 'adult',
        household_primary: 'true',
      },
    ));
    await env.DB.prepare('INSERT INTO households (name) VALUES (?)').bind('shared family name').run();

    const response = await previewRoute.POST(routeContext(endpointRequest('preview', records)));
    const body = await response.json() as {
      issues: Array<{ severity: string; code: string; row: number | null; field: string | null }>;
    };

    expect(response.status).toBe(200);
    expect(body.issues).toHaveLength(PEOPLE_IMPORT_LIMITS.maxIssues);
    expect(body.issues.filter((issue) => issue.code === 'issues_truncated')).toHaveLength(1);
    expect(body.issues.at(-1)).toEqual({
      severity: 'error',
      code: 'issues_truncated',
      row: null,
      field: null,
    });
    expect(body.issues.slice(0, 4).map(({ code, row }) => ({ code, row }))).toEqual([
      { code: 'duplicate_household_name', row: 2 },
      { code: 'household_name_exists', row: 2 },
      { code: 'duplicate_household_name', row: 3 },
      { code: 'household_name_exists', row: 3 },
    ]);
    expect(await importTableCounts()).toMatchObject({ people: 0, household_members: 0 });
  });
});

describe('people import commit endpoint', () => {
  beforeEach(resetImportTables);

  it('rejects pure errors before DB work and preflight conflicts without writes', async () => {
    const unreachableDb: AppDb = {
      prepare: vi.fn(() => {
        throw new Error('DB must not run for parser errors');
      }),
      batch: vi.fn(() => {
        throw new Error('batch must not run for parser errors');
      }),
    };
    const invalid = await commitRoute.POST(routeContext(
      endpointRequest('commit', [personRecord('not-an-email')]),
      { db: unreachableDb },
    ));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ ok: false, code: 'validation_failed' });
    expect(unreachableDb.prepare).not.toHaveBeenCalled();

    await env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)')
      .bind('Existing', 'collision@example.com')
      .run();
    const before = await importTableCounts();
    const conflict = await commitRoute.POST(routeContext(endpointRequest('commit', [
      personRecord('collision@example.com'),
    ])));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ ok: false, code: 'import_conflict' });
    expect(await importTableCounts()).toEqual(before);
  });

  it('requires the literal warning acknowledgement and commits when it is present', async () => {
    const warnings = [
      personRecord('one@example.com', {
        household_key: 'one', household_name: 'Same Family',
        household_role: 'adult', household_primary: 'true',
      }),
      personRecord('two@example.com', {
        household_key: 'two', household_name: 'Same Family',
        household_role: 'adult', household_primary: 'true',
      }),
    ];

    for (const acknowledgeWarnings of [undefined, 'TRUE', '1']) {
      const response = await commitRoute.POST(routeContext(endpointRequest(
        'commit',
        warnings,
        { acknowledgeWarnings },
      )));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, code: 'warnings_not_acknowledged' });
      expect(await importTableCounts()).toMatchObject({ people: 0, households: 0 });
    }

    const committed = await commitRoute.POST(routeContext(endpointRequest(
      'commit',
      warnings,
      { acknowledgeWarnings: 'true' },
    )));
    expect(committed.status).toBe(201);
    expect(await committed.json()).toEqual({
      ok: true,
      counts: { people: 2, households: 2, dependents: 0 },
    });
  });

  it('treats replacement CSV bytes as authoritative and ignores hidden model fields', async () => {
    const records = familyRecords('replacement');
    const response = await commitRoute.POST(routeContext(endpointRequest('commit', records, {
      fields: {
        model: JSON.stringify({ people: [{ email: 'hidden@example.com', finance: 1 }] }),
        summary: JSON.stringify({ people: 999 }),
        issues: JSON.stringify([]),
      },
    })));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ok: true,
      counts: { people: 1, households: 1, dependents: 1 },
    });
    expect(await env.DB.prepare('SELECT id FROM people WHERE email = ?')
      .bind('primary-replacement@example.com').first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT id FROM people WHERE email = ?')
      .bind('hidden@example.com').first()).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM email_log').first<number>('n')).toBe(0);
  });

  it('maps a double submit and a collision between route and persistence preflights to 409', async () => {
    const records = [personRecord('double@example.com')];
    const first = await commitRoute.POST(routeContext(endpointRequest('commit', records)));
    expect(first.status).toBe(201);
    const afterFirst = await importTableCounts();

    const second = await commitRoute.POST(routeContext(endpointRequest('commit', records)));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ ok: false, code: 'import_conflict' });
    expect(await importTableCounts()).toEqual(afterFirst);

    await resetImportTables();
    const lateEmail = 'late@example.com';
    const lateDb = new LateCollisionDb(env.DB, lateEmail);
    const late = await commitRoute.POST(routeContext(
      endpointRequest('commit', [personRecord(lateEmail)]),
      { db: lateDb },
    ));
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ ok: false, code: 'import_conflict' });
    expect(await importTableCounts()).toMatchObject({ people: 1, households: 0, household_members: 0 });
  });

  it('maps typed and unknown failures without exposing caught details', async () => {
    const cases: Array<[unknown, number, string]> = [
      [new PeopleImportNotReadyError(), 400, 'validation_failed'],
      [new PeopleImportConflictError(), 409, 'import_conflict'],
      [new PeopleImportPersistenceError(), 500, 'import_failed'],
      [new Error('private@example.com SQL INSERT detail'), 500, 'generic_error'],
    ];
    for (const [error, status, code] of cases) {
      const response = peopleImportCommitErrorResponse(error);
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ ok: false, code });
      expect(text).not.toContain('private@example.com');
    }

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unknownDb: AppDb = {
      prepare: () => {
        throw new Error('private.person@example.com SELECT detail');
      },
      batch: vi.fn(),
    };
    const unknown = await commitRoute.POST(routeContext(
      endpointRequest('commit', [personRecord('private.person@example.com')]),
      { db: unknownDb },
    ));
    expect(unknown.status).toBe(500);
    expect(await unknown.json()).toEqual({ ok: false, code: 'generic_error' });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('maps an atomic batch persistence failure to import_failed', async () => {
    const db: AppDb = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async () => {
        throw new Error('private SQL CHECK detail');
      },
    };
    const response = await commitRoute.POST(routeContext(
      endpointRequest('commit', [personRecord('batch-failure@example.com')]),
      { db },
    ));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, code: 'import_failed' });
    expect(await importTableCounts()).toMatchObject({ people: 0, households: 0 });
  });
});
