import { describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import type { CanonicalExportResult, CanonicalPeopleExportSource } from '../src/lib/peopleExport';
import { PEOPLE_IMPORT_HEADERS } from '../src/lib/peopleImport';
import {
  loadPeopleExportDiscovery,
  type StandardPeopleExportRuntime,
} from '../src/lib/peopleExportHttp';
import type { SessionUser } from '../src/lib/types';

const db: AppDb = {
  prepare: vi.fn(() => { throw new Error('database must not be reached'); }),
  batch: vi.fn(() => { throw new Error('database must not be reached'); }),
};

const grantedAdmin: SessionUser = {
  id: 7,
  email: 'admin@example.com',
  displayName: 'Admin',
  role: 'admin',
  isAdmin: true,
  isEditor: false,
  isSuperAdmin: false,
  adminAreas: ['people'],
  finance: 0,
  memberTeamIds: [],
  leaderTeamIds: [],
  lang: 'en',
};

const source: CanonicalPeopleExportSource = {
  today: '2026-08-12',
  people: [],
  dependents: [],
};
const canonicalHeader = `${PEOPLE_IMPORT_HEADERS.join(',')}\r\n`;

function context(over: {
  user?: SessionUser | null;
  modules?: Set<string>;
  method?: string;
  backend?: 'd1' | 'supabase';
} = {}) {
  return {
    request: new Request('https://church.example/admin/people/export', {
      method: over.method ?? 'GET',
    }),
    user: over.user === undefined ? grantedAdmin : over.user,
    modules: over.modules ?? new Set(['people']),
    db,
    backend: over.backend ?? 'd1',
    today: '2026-08-12',
  } as const;
}

function runtime(result: CanonicalExportResult, over: Partial<StandardPeopleExportRuntime> = {}): StandardPeopleExportRuntime {
  return {
    loadCanonical: vi.fn(async () => source),
    buildCanonical: vi.fn(() => result),
    ...over,
  };
}

const success: CanonicalExportResult = {
  status: 'success',
  parts: [
    { number: 1, rowCount: 200, householdCount: 80, csv: `${canonicalHeader}private-one` },
    { number: 2, rowCount: 33, householdCount: 12, csv: `${canonicalHeader}private-two` },
  ],
};

describe('loadPeopleExportDiscovery', () => {
  it('returns module 404 or full-People 403 before touching the snapshot', async () => {
    const ungranted: SessionUser = { ...grantedAdmin, adminAreas: [] };
    for (const [user, modules, status] of [
      [grantedAdmin, new Set<string>(), 404],
      [ungranted, new Set(['people']), 403],
      [null, new Set(['people']), 403],
    ] as const) {
      const loadCanonical = vi.fn(async () => { throw new Error('must not load'); });
      const result = await loadPeopleExportDiscovery(
        context({ user, modules }),
        runtime(success, { loadCanonical }),
      );
      expect(result.status).toBe('response');
      if (result.status === 'response') expect(result.response.status).toBe(status);
      expect(loadCanonical).not.toHaveBeenCalled();
    }
  });

  it('rejects HEAD, OPTIONS, and POST before touching the snapshot', async () => {
    for (const method of ['HEAD', 'OPTIONS', 'POST']) {
      const loadCanonical = vi.fn(async () => { throw new Error('must not load'); });
      const result = await loadPeopleExportDiscovery(
        context({ method }),
        runtime(success, { loadCanonical }),
      );
      expect(result.status).toBe('response');
      if (result.status === 'response') {
        expect(result.response.status).toBe(405);
        expect(result.response.headers.get('allow')).toBe('GET');
      }
      expect(loadCanonical).not.toHaveBeenCalled();
    }
  });

  it('returns numeric totals and an explicit safe link for every numbered part', async () => {
    const rt = runtime(success);
    await expect(loadPeopleExportDiscovery(context({ backend: 'supabase' }), rt)).resolves.toEqual({
      status: 'success',
      partCount: 2,
      totalRows: 233,
      totalHouseholds: 92,
      parts: [
        { number: 1, rowCount: 200, householdCount: 80, href: '/admin/people/export.csv?part=1' },
        { number: 2, rowCount: 33, householdCount: 12, href: '/admin/people/export.csv?part=2' },
      ],
    });
    expect(rt.loadCanonical).toHaveBeenCalledWith(db, '2026-08-12', 'supabase');
  });

  it('keeps an empty directory usable as one header-only part', async () => {
    const result = await loadPeopleExportDiscovery(context(), runtime({
      status: 'success',
      parts: [{ number: 1, rowCount: 0, householdCount: 0, csv: canonicalHeader }],
    }));
    expect(result).toEqual({
      status: 'success',
      partCount: 1,
      totalRows: 0,
      totalHouseholds: 0,
      parts: [{
        number: 1,
        rowCount: 0,
        householdCount: 0,
        href: '/admin/people/export.csv?part=1',
      }],
    });
  });

  it('returns only numeric repair counts and a generic PII-free error state', async () => {
    await expect(loadPeopleExportDiscovery(context(), runtime({
      status: 'repair_required',
      counts: { people: 4, dependents: 2, households: 1, issues: 3 },
    }))).resolves.toEqual({
      status: 'repair_required',
      counts: { people: 4, dependents: 2, households: 1, issues: 3 },
    });

    const failed = await loadPeopleExportDiscovery(context(), runtime(success, {
      loadCanonical: vi.fn(async () => { throw new Error('private@example.com'); }),
    }));
    expect(failed).toEqual({ status: 'error' });
    expect(JSON.stringify(failed)).not.toContain('private@example.com');
  });

  it('returns a generic state for malformed counts, parts, accessors, and proxy results', async () => {
    const validPart = { number: 1, rowCount: 0, householdCount: 0, csv: canonicalHeader };
    const invalidResults: unknown[] = [
      { status: 'repair_required', counts: { people: -1, dependents: 0, households: 0, issues: 1 } },
      { status: 'repair_required', counts: { people: 0, dependents: 0, households: 102, issues: 1 } },
      { status: 'success', parts: [{ ...validPart, number: 2 }] },
      { status: 'success', parts: [{ ...validPart, rowCount: 201 }] },
      { status: 'success', parts: [{ ...validPart, csv: 'private@example.com\r\n' }] },
      new Proxy(success, {}),
    ];
    const getterResult = { status: 'success', parts: [{ ...validPart }] };
    Object.defineProperty(getterResult.parts[0], 'rowCount', {
      enumerable: true,
      get: () => 0,
    });
    invalidResults.push(getterResult);

    for (const invalid of invalidResults) {
      const result = await loadPeopleExportDiscovery(
        context(),
        runtime(invalid as never),
      );
      expect(result).toEqual({ status: 'error' });
      expect(JSON.stringify(result)).not.toContain('private@example.com');
    }
  });

  it('uses real calendar validation before touching the snapshot', async () => {
    const loadCanonical = vi.fn(async () => source);
    const invalidContext = { ...context(), today: '2026-02-29' };
    await expect(loadPeopleExportDiscovery(
      invalidContext,
      runtime(success, { loadCanonical }),
    )).resolves.toEqual({ status: 'error' });
    expect(loadCanonical).not.toHaveBeenCalled();
  });
});
