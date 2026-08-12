import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb, AppDbResult, AppStatement } from '../src/lib/appDb';
import { PEOPLE_IMPORT_HEADERS, type PeopleImportHeader } from '../src/lib/peopleImport';
import {
  createPeopleImportMapping,
  type CreatePeopleImportMappingInput,
} from '../src/lib/peopleImportMappingDb';
import type { SessionUser } from '../src/lib/types';
import * as inspectRoute from '../src/pages/admin/people/import/map/inspect';
import * as profilesRoute from '../src/pages/admin/people/import/map/profiles';
import * as previewRoute from '../src/pages/admin/people/import/map/preview';
import * as commitRoute from '../src/pages/admin/people/import/map/commit';

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

let actorId = 1;

function grantedAdmin(): SessionUser {
  return makeUser({ id: actorId, adminAreas: ['people'] });
}

function mappings(
  sources: Partial<Record<PeopleImportHeader, number>> = { display_name: 0, email: 1 },
): Record<PeopleImportHeader, number | null> {
  return Object.fromEntries(
    PEOPLE_IMPORT_HEADERS.map((header) => [header, sources[header] ?? null]),
  ) as Record<PeopleImportHeader, number | null>;
}

function config(
  sources?: Partial<Record<PeopleImportHeader, number>>,
  constants: Record<string, string> = { record_type: 'person' },
): string {
  return JSON.stringify({
    version: 999,
    expectedHeaders: ['client', 'controlled'],
    fieldMappings: mappings(sources),
    constants,
    enumTranslations: {},
  });
}

function multipartRequest(
  path: string,
  csv: string | null,
  fields: Array<[string, string]> = [],
): Request {
  const form = new FormData();
  if (csv !== null) form.append('csv', new File([csv], 'source.csv', { type: 'text/csv' }));
  for (const [name, value] of fields) form.append(name, value);
  return new Request(`https://church.example${path}`, { method: 'POST', body: form });
}

function context(
  request: Request,
  overrides: {
    user?: SessionUser | null;
    modules?: Set<string>;
    db?: AppDb;
    dbBackend?: 'd1' | 'supabase';
  } = {},
) {
  return {
    request,
    locals: {
      user: overrides.user === undefined ? grantedAdmin() : overrides.user,
      modules: overrides.modules ?? new Set(['people']),
      db: overrides.db ?? env.DB,
      dbBackend: overrides.dbBackend ?? 'd1',
    },
  } as never;
}

async function profile(
  overrides: Partial<CreatePeopleImportMappingInput> = {},
) {
  return createPeopleImportMapping(env.DB, {
    name: 'Default source',
    expectedHeaders: ['name', 'email'],
    fieldMappings: mappings(),
    constants: { record_type: 'person' },
    enumTranslations: {},
    createdByPersonId: actorId,
    ...overrides,
  });
}

async function importCounts(): Promise<Record<string, number>> {
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
        if (/FROM people(?:\s|$)/.test(sql)) {
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

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM people_import_mappings'),
    env.DB.prepare('DELETE FROM household_members'),
    env.DB.prepare('DELETE FROM households'),
    env.DB.prepare('DELETE FROM email_log'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  const actor = await env.DB.prepare(
    'INSERT INTO people (display_name, email) VALUES (?, ?) RETURNING id',
  ).bind('Mapping admin', 'mapping-admin@example.com').first<{ id: number }>();
  actorId = actor!.id;
});

describe('mapping route methods and authorization', () => {
  it('exports exact methods and safe 405 responses', async () => {
    for (const route of [inspectRoute, previewRoute, commitRoute]) {
      expect(typeof route.POST).toBe('function');
      expect(Reflect.get(route, 'GET')).toBeUndefined();
      const response = await route.ALL({} as never);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.json()).toEqual({ ok: false, code: 'method_not_allowed' });
    }

    expect(typeof profilesRoute.GET).toBe('function');
    expect(typeof profilesRoute.POST).toBe('function');
    const profilesAll = await profilesRoute.ALL({} as never);
    expect(profilesAll.status).toBe(405);
    expect(profilesAll.headers.get('allow')).toBe('GET, POST');
  });

  it('checks the module and full People grant before body reads or database access', async () => {
    const throwingDb: AppDb = {
      prepare: vi.fn(() => { throw new Error('database must not be reached'); }),
      batch: vi.fn(() => { throw new Error('database must not be reached'); }),
    };
    for (const route of [inspectRoute, profilesRoute, previewRoute, commitRoute]) {
      for (const [user, modules, status] of [
        [grantedAdmin(), new Set<string>(), 404],
        [makeUser({ id: actorId }), new Set(['people']), 403],
      ] as const) {
        let pulled = false;
        const request = new Request('https://church.example/admin/people/import/map/action', {
          method: 'POST',
          headers: { 'content-type': 'multipart/form-data; boundary=private' },
          body: new ReadableStream<Uint8Array>({
            pull() {
              pulled = true;
              throw new Error('body must not be read');
            },
          }, { highWaterMark: 0 }),
        });
        expect((await route.POST(context(request, { user, modules, db: throwingDb }))).status).toBe(status);
        expect(pulled).toBe(false);
      }
    }

    for (const [user, modules, status] of [
      [grantedAdmin(), new Set<string>(), 404],
      [makeUser({ id: actorId }), new Set(['people']), 403],
    ] as const) {
      const deniedGet = new Request('https://church.example/admin/people/import/map/profiles');
      expect((await profilesRoute.GET(context(deniedGet, {
        user, modules, db: throwingDb,
      }))).status).toBe(status);
    }
    expect(throwingDb.prepare).not.toHaveBeenCalled();
    expect(throwingDb.batch).not.toHaveBeenCalled();
  });
});

describe('mapping inspect and immutable profiles', () => {
  it('inspects only current bytes without returning source cells', async () => {
    const privateCell = 'DO-NOT-RETURN-PRIVATE-CELL';
    const response = await inspectRoute.POST(context(multipartRequest(
      '/admin/people/import/map/inspect',
      ` Name ,EMAIL\n${privateCell},ada@example.com\n`,
    )));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      headers: ['name', 'email'],
      headerRowNumber: 1,
      dataRows: 1,
      issues: [],
    });
    expect(text).not.toContain(privateCell);
  });

  it('creates from server-derived headers, then lists and gets an immutable profile', async () => {
    const create = await profilesRoute.POST(context(multipartRequest(
      '/admin/people/import/map/profiles',
      ' Name ,EMAIL\nAda,ada@example.com\n',
      [['profile_name', ' External source '], ['mapping_config', config()]],
    )));
    expect(create.status).toBe(201);
    const created = await create.json() as { profile: { id: number; expectedHeaders: string[] } };
    expect(created.profile.expectedHeaders).toEqual(['name', 'email']);

    const list = await profilesRoute.GET(context(new Request(
      'https://church.example/admin/people/import/map/profiles',
    )));
    expect(list.status).toBe(200);
    const listBody = await list.json() as { profiles: Array<Record<string, unknown>> };
    expect(listBody.profiles).toHaveLength(1);
    expect(Object.keys(listBody.profiles[0]).sort()).toEqual([
      'createdAt', 'createdByPersonId', 'id', 'name', 'version',
    ]);

    const detail = await profilesRoute.GET(context(new Request(
      `https://church.example/admin/people/import/map/profiles?id=${created.profile.id}`,
    )));
    expect(detail.status).toBe(200);
    expect((await detail.json() as { profile: { expectedHeaders: string[] } }).profile.expectedHeaders)
      .toEqual(['name', 'email']);

    for (const id of ['', '0', '-1', '01', '1.0']) {
      const invalid = await profilesRoute.GET(context(new Request(
        `https://church.example/admin/people/import/map/profiles?id=${encodeURIComponent(id)}`,
      )));
      expect(invalid.status, id).toBe(400);
      expect(await invalid.json()).toEqual({ ok: false, code: 'profile_id_invalid' });
    }
    expect((await profilesRoute.GET(context(new Request(
      'https://church.example/admin/people/import/map/profiles?id=99',
    )))).status).toBe(404);
  });

  it('maps duplicate names and malformed profile requests to stable safe errors', async () => {
    await profile({ name: 'Existing' });
    const duplicate = await profilesRoute.POST(context(multipartRequest(
      '/admin/people/import/map/profiles',
      'name,email\nAda,ada@example.com\n',
      [['profile_name', ' existing '], ['mapping_config', config()]],
    )));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ ok: false, code: 'mapping_profile_conflict' });

    for (const fields of [
      [['mapping_config', config()]] as Array<[string, string]>,
      [['profile_name', 'Missing config']] as Array<[string, string]>,
      [['profile_name', 'Bad config'], ['mapping_config', '{']] as Array<[string, string]>,
    ]) {
      const response = await profilesRoute.POST(context(multipartRequest(
        '/admin/people/import/map/profiles',
        'name,email\nAda,ada@example.com\n',
        fields,
      )));
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain('Ada');
    }
  });
});

describe('mapping preview and commit server authority', () => {
  it('reloads the selected profile, ignores client model/config/role/op fields, and previews with zero writes', async () => {
    const selected = await profile({ name: 'Selected A' });
    await profile({
      name: 'Different B',
      fieldMappings: mappings({ display_name: 1, email: 0 }),
    });
    const before = await importCounts();
    const batch = vi.fn(() => { throw new Error('preview must not write'); });
    const readOnlyDb: AppDb = { prepare: (sql) => env.DB.prepare(sql), batch };
    const response = await previewRoute.POST(context(multipartRequest(
      '/admin/people/import/map/preview',
      'name,email\nAda,ada@example.com\n',
      [
        ['profile_id', String(selected.id)],
        ['mapping_config', config({ display_name: 1, email: 0 })],
        ['model', JSON.stringify({ people: [{ email: 'attacker@example.com', finance: 1 }] })],
        ['role', 'super-admin'],
        ['operation', 'update'],
      ],
    ), { db: readOnlyDb }));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      profile: { id: number; name: string; version: number };
      mappingIssues: unknown[];
      preview: { rows: Array<Record<string, unknown>> };
    };
    expect(body.profile).toEqual({ id: selected.id, name: 'Selected A', version: 1 });
    expect(body.mappingIssues).toEqual([]);
    expect(body.preview.rows[0]).toMatchObject({
      displayName: 'Ada', email: 'ada@example.com', role: 'member', row: 2,
    });
    expect(JSON.stringify(body)).not.toContain('attacker@example.com');
    expect(batch).not.toHaveBeenCalled();
    expect(await importCounts()).toEqual(before);
  });

  it('returns structural drift without preflight and validates profile ids safely', async () => {
    const selected = await profile();
    const prepare = vi.fn((sql: string) => {
      if (sql.includes('people_import_mappings')) return env.DB.prepare(sql);
      throw new Error('preflight must not run after header drift');
    });
    const db: AppDb = { prepare, batch: vi.fn() };
    const drift = await previewRoute.POST(context(multipartRequest(
      '/admin/people/import/map/preview',
      'email,name\nada@example.com,Ada\n',
      [['profile_id', String(selected.id)]],
    ), { db }));
    expect(drift.status).toBe(200);
    expect(await drift.json()).toMatchObject({
      ok: true,
      mappingIssues: [
        { code: 'header_drift', row: 1, column: 1, field: null },
        { code: 'header_drift', row: 1, column: 2, field: null },
      ],
      preview: null,
    });

    for (const id of ['0', '-1', '01', '1.0']) {
      const invalid = await previewRoute.POST(context(multipartRequest(
        '/admin/people/import/map/preview',
        'name,email\nAda,ada@example.com\n',
        [['profile_id', id]],
      )));
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ ok: false, code: 'profile_id_invalid' });
    }
  });

  it('commits only the fresh server transform and requires literal warning acknowledgement', async () => {
    const selected = await profile();
    const committed = await commitRoute.POST(context(multipartRequest(
      '/admin/people/import/map/commit',
      'name,email\nCommitted,committed@example.com\n',
      [
        ['profile_id', String(selected.id)],
        ['model', JSON.stringify({ people: [{ email: 'attacker@example.com' }] })],
        ['operation', 'update'],
      ],
    )));
    expect(committed.status).toBe(201);
    expect(await committed.json()).toEqual({
      ok: true,
      counts: { people: 1, households: 0, dependents: 0 },
    });
    expect(await env.DB.prepare('SELECT role FROM people WHERE email = ?')
      .bind('committed@example.com').first<string>('role')).toBe('member');
    expect(await env.DB.prepare('SELECT id FROM people WHERE email = ?')
      .bind('attacker@example.com').first()).toBeNull();

    const warningProfile = await profile({
      name: 'Households',
      expectedHeaders: ['name', 'email', 'key', 'household'],
      fieldMappings: mappings({
        display_name: 0, email: 1, household_key: 2, household_name: 3,
      }),
      constants: {
        record_type: 'person', household_role: 'adult', household_primary: 'true',
      },
    });
    const warningCsv = 'name,email,key,household\nOne,one@example.com,one,Same\nTwo,two@example.com,two,Same\n';
    for (const ack of [undefined, 'TRUE', '1']) {
      const fields: Array<[string, string]> = [['profile_id', String(warningProfile.id)]];
      if (ack !== undefined) fields.push(['acknowledge_warnings', ack]);
      const response = await commitRoute.POST(context(multipartRequest(
        '/admin/people/import/map/commit', warningCsv, fields,
      )));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, code: 'warnings_not_acknowledged' });
    }
    const accepted = await commitRoute.POST(context(multipartRequest(
      '/admin/people/import/map/commit', warningCsv,
      [['profile_id', String(warningProfile.id)], ['acknowledge_warnings', 'true']],
    )));
    expect(accepted.status).toBe(201);
  });

  it('maps preflight and late persistence conflicts without partial writes', async () => {
    const selected = await profile();
    await env.DB.prepare('INSERT INTO people (display_name, email) VALUES (?, ?)')
      .bind('Existing', 'collision@example.com').run();
    const existing = await commitRoute.POST(context(multipartRequest(
      '/admin/people/import/map/commit',
      'name,email\nCollision,collision@example.com\n',
      [['profile_id', String(selected.id)]],
    )));
    expect(existing.status).toBe(409);
    expect(await existing.json()).toEqual({ ok: false, code: 'import_conflict' });

    const lateEmail = 'late@example.com';
    const late = await commitRoute.POST(context(multipartRequest(
      '/admin/people/import/map/commit',
      `name,email\nLate,${lateEmail}\n`,
      [['profile_id', String(selected.id)]],
    ), { db: new LateCollisionDb(env.DB, lateEmail) }));
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ ok: false, code: 'import_conflict' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people WHERE email = ?')
      .bind(lateEmail).first<number>('n')).toBe(1);
  });
});
