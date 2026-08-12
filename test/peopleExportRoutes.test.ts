import { describe, expect, it } from 'vitest';
import type { SessionUser } from '../src/lib/types';
import * as standardRoute from '../src/pages/admin/people/export.csv';
import standardRouteSource from '../src/pages/admin/people/export.csv.ts?raw';
import notesPageSource from '../src/pages/admin/people/export-notes.astro?raw';
import peopleDirectorySource from '../src/pages/admin/people/index.astro?raw';

const makeUser = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 1,
  email: 'admin@example.com',
  displayName: 'Admin',
  role: 'admin',
  isAdmin: true,
  isEditor: false,
  isSuperAdmin: false,
  adminAreas: [],
  finance: 0,
  memberTeamIds: [],
  leaderTeamIds: [],
  lang: 'en',
  ...over,
});

describe('standard People export route', () => {
  it('exports GET and a hardened safe rejection for every other method', async () => {
    expect(typeof standardRoute.GET).toBe('function');
    expect(typeof standardRoute.ALL).toBe('function');
    const response = await standardRoute.ALL({} as never);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toEqual({ ok: false, code: 'method_not_allowed' });
  });

  it('rechecks module and full-People access before any database work', async () => {
    const throwingDb = {
      prepare() { throw new Error('database must not be reached'); },
      batch() { throw new Error('database must not be reached'); },
    };
    const context = (user: SessionUser | null, modules: Set<string>) => ({
      request: new Request('https://church.example/admin/people/export.csv'),
      locals: { user, modules, db: throwingDb, dbBackend: 'd1' },
    }) as never;

    expect((await standardRoute.GET(context(makeUser({ adminAreas: ['people'] }), new Set()))).status).toBe(404);
    expect((await standardRoute.GET(context(makeUser(), new Set(['people'])))).status).toBe(403);
  });

  it('keeps sensitive-notes code out of the standard-download route', () => {
    expect(standardRouteSource).not.toContain('loadPastoralNotesExport');
    expect(standardRouteSource).not.toContain('buildPastoralNotesExport');
    expect(standardRouteSource).not.toContain('appendAuditEvent');
  });
});

describe('pastoral-notes confirmation route source', () => {
  it('rechecks super-admin access before method handling and delegates POST to the bounded handler', () => {
    const accessAt = notesPageSource.indexOf('canExportPastoralNotes');
    const methodAt = notesPageSource.indexOf('Astro.request.method');
    expect(accessAt).toBeGreaterThan(-1);
    expect(methodAt).toBeGreaterThan(accessAt);
    expect(notesPageSource).toContain('handlePastoralNotesExport');
    expect(notesPageSource).toContain("method !== 'GET' && method !== 'POST'");
    expect(notesPageSource).toContain("{ Allow: 'GET, POST' }");
    expect(notesPageSource).not.toContain('.formData()');
  });

  it('renders an exact explicit sensitive-data acknowledgement without preloading notes', () => {
    expect(notesPageSource).toContain('name="acknowledgement"');
    expect(notesPageSource).toContain('value={PEOPLE_NOTES_ACKNOWLEDGEMENT}');
    expect(notesPageSource).toContain('required');
    expect(notesPageSource).toContain("t(lang, 'admin.peopleExport.notesWarning')");
    expect(notesPageSource).toContain("t(lang, 'admin.peopleExport.notesAudit')");
    expect(notesPageSource).not.toContain('loadPastoralNotesExport(db');
    expect(notesPageSource).not.toContain('loadCanonicalPeopleExport');
    expect(notesPageSource).not.toContain('buildCanonicalExportParts');
  });
});

describe('People directory export entries', () => {
  it('shows standard export to full-People admins and notes export only to super admins', () => {
    expect(peopleDirectorySource).toMatch(
      /hasPeople\s*&&\s*canManagePeople\s*&&[\s\S]*href="\/admin\/people\/export\.csv"/,
    );
    expect(peopleDirectorySource).toMatch(
      /hasPeople\s*&&\s*user\.isSuperAdmin\s*&&[\s\S]*href="\/admin\/people\/export-notes"/,
    );
    expect(peopleDirectorySource).toContain("admin.peopleExport.standardBody");
    expect(peopleDirectorySource).toContain("admin.peopleExport.notesWarning");
  });
});
