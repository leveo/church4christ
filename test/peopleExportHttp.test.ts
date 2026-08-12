import { describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import type { CanonicalExportResult, CanonicalPeopleExportSource } from '../src/lib/peopleExport';
import type { PastoralNotesExportResult, PastoralNotesExportSource } from '../src/lib/pastoralNotesExport';
import {
  PEOPLE_NOTES_ACKNOWLEDGEMENT,
  PEOPLE_NOTES_FORM_MAX_BYTES,
  canExportPastoralNotes,
  canManagePeopleExport,
  handlePastoralNotesExport,
  handlePeopleExport,
  peopleExportJson,
  type PeopleExportRuntime,
} from '../src/lib/peopleExportHttp';
import type { SessionUser } from '../src/lib/types';

const db: AppDb = {
  prepare: vi.fn(() => { throw new Error('database must not be reached'); }),
  batch: vi.fn(() => { throw new Error('database must not be reached'); }),
};

const makeUser = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 7,
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

const grantedAdmin = makeUser({ adminAreas: ['people'] });
const superAdmin = makeUser({ isSuperAdmin: true });

const source: CanonicalPeopleExportSource = { today: '2026-08-12', people: [], dependents: [] };
const notesSource: PastoralNotesExportSource = { notes: [] };
const canonicalSuccess: CanonicalExportResult = {
  status: 'success',
  parts: [
    { number: 1, rowCount: 2, householdCount: 1, csv: 'header\r\npart-one\r\n' },
    { number: 2, rowCount: 1, householdCount: 0, csv: 'header\r\npart-two\r\n' },
  ],
};
const notesSuccess: PastoralNotesExportResult = {
  status: 'success',
  counts: { people: 1, notes: 2 },
  csv: 'person_ref,body\r\nperson-1,private\r\n',
};

function runtime(overrides: Partial<PeopleExportRuntime> = {}): PeopleExportRuntime {
  return {
    loadCanonical: vi.fn(async () => source),
    buildCanonical: vi.fn(() => canonicalSuccess),
    loadNotes: vi.fn(async () => notesSource),
    buildNotes: vi.fn(() => notesSuccess),
    appendAudit: vi.fn(async () => {}),
    ...overrides,
  };
}

function standardContext(url = 'https://church.example/admin/people/export.csv', over: {
  user?: SessionUser | null;
  modules?: Set<string>;
  backend?: 'd1' | 'supabase';
} = {}) {
  return {
    request: new Request(url),
    user: over.user === undefined ? grantedAdmin : over.user,
    modules: over.modules ?? new Set(['people']),
    db,
    backend: over.backend ?? 'd1',
    today: '2026-08-12',
  } as const;
}

function notesRequest(
  acknowledgement: string = PEOPLE_NOTES_ACKNOWLEDGEMENT,
  init: { body?: BodyInit; headers?: HeadersInit; method?: string } = {},
): Request {
  const body = init.body ?? new URLSearchParams({ acknowledgement });
  return new Request('https://church.example/admin/people/export-notes', {
    method: init.method ?? 'POST',
    body: init.method === 'GET' ? undefined : body,
    headers: init.headers,
  });
}

function notesContext(request = notesRequest(), over: {
  user?: SessionUser | null;
  modules?: Set<string>;
  backend?: 'd1' | 'supabase';
} = {}) {
  return {
    request,
    user: over.user === undefined ? superAdmin : over.user,
    modules: over.modules ?? new Set(['people']),
    db,
    backend: over.backend ?? 'd1',
    today: '2026-08-12',
  } as const;
}

describe('people export access', () => {
  it('fails module-off before role checks and requires a full People grant for standard export', () => {
    expect(canManagePeopleExport(null, new Set())).toBe('not_found');
    expect(canManagePeopleExport(grantedAdmin, new Set())).toBe('not_found');
    expect(canManagePeopleExport(null, new Set(['people']))).toBe('forbidden');
    expect(canManagePeopleExport(makeUser(), new Set(['people']))).toBe('forbidden');
    expect(canManagePeopleExport(grantedAdmin, new Set(['people']))).toBe('ok');
    expect(canManagePeopleExport(superAdmin, new Set(['people']))).toBe('ok');
  });

  it('allows pastoral-notes export only to a super admin', () => {
    expect(canExportPastoralNotes(superAdmin, new Set())).toBe('not_found');
    expect(canExportPastoralNotes(grantedAdmin, new Set(['people']))).toBe('forbidden');
    expect(canExportPastoralNotes(makeUser({ role: 'editor', isAdmin: false, isEditor: true }), new Set(['people']))).toBe('forbidden');
    expect(canExportPastoralNotes(superAdmin, new Set(['people']))).toBe('ok');
  });
});

describe('peopleExportJson', () => {
  it('emits private non-sniffable JSON and preserves a safe Allow header', async () => {
    const response = peopleExportJson(405, { ok: false, code: 'method_not_allowed' }, { Allow: 'GET' });
    expect(response.status).toBe(405);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('allow')).toBe('GET');
    expect(await response.json()).toEqual({ ok: false, code: 'method_not_allowed' });
  });
});

describe('standard people export handler', () => {
  it('gates before loading a snapshot', async () => {
    for (const [user, modules, status] of [
      [grantedAdmin, new Set<string>(), 404],
      [makeUser(), new Set(['people']), 403],
      [null, new Set(['people']), 403],
    ] as const) {
      const loadCanonical = vi.fn(async () => { throw new Error('must not load'); });
      const response = await handlePeopleExport(standardContext(undefined, { user, modules }), runtime({ loadCanonical }));
      expect(response.status).toBe(status);
      expect(loadCanonical).not.toHaveBeenCalled();
    }
  });

  it('returns one selected CSV part with fixed safe headers and backend propagation', async () => {
    const rt = runtime();
    const response = await handlePeopleExport(
      standardContext('https://church.example/admin/people/export.csv?part=2', { backend: 'supabase' }),
      rt,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="people-2026-08-12-part-2-of-2.csv"');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-people-export-part')).toBe('2');
    expect(response.headers.get('x-people-export-parts')).toBe('2');
    expect(response.headers.get('x-people-export-rows')).toBe('1');
    expect(response.headers.get('x-people-export-households')).toBe('0');
    expect(await response.text()).toBe('header\r\npart-two\r\n');
    expect(rt.loadCanonical).toHaveBeenCalledWith(db, '2026-08-12', 'supabase');
  });

  it('defaults to part one and rejects malformed, repeated, or out-of-range part selectors', async () => {
    const first = await handlePeopleExport(standardContext(), runtime());
    expect(first.headers.get('x-people-export-part')).toBe('1');
    for (const query of ['?part=', '?part=0', '?part=01', '?part=+1', '?part=1.0', '?part=1&part=2', '?part=3']) {
      const response = await handlePeopleExport(
        standardContext(`https://church.example/admin/people/export.csv${query}`),
        runtime(),
      );
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({ ok: false, code: 'invalid_part' });
    }
  });

  it('returns only bounded structural counts for repair-required data', async () => {
    const response = await handlePeopleExport(standardContext(), runtime({
      buildCanonical: vi.fn(() => ({
        status: 'repair_required',
        counts: { people: 4, dependents: 2, households: 1, issues: 3 },
      } satisfies CanonicalExportResult)),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      code: 'repair_required',
      counts: { people: 4, dependents: 2, households: 1, issues: 3 },
    });
  });

  it('converts snapshot and serializer exceptions to a generic PII-free failure', async () => {
    for (const rt of [
      runtime({ loadCanonical: vi.fn(async () => { throw new Error('private@example.com'); }) }),
      runtime({ buildCanonical: vi.fn(() => { throw new Error('private@example.com'); }) }),
    ]) {
      const response = await handlePeopleExport(standardContext(), rt);
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toBe('{"ok":false,"code":"export_failed"}');
      expect(body).not.toContain('private@example.com');
    }
  });
});

describe('pastoral notes export handler', () => {
  it('gates before reading the request body or loading notes', async () => {
    for (const [user, modules, status] of [
      [superAdmin, new Set<string>(), 404],
      [grantedAdmin, new Set(['people']), 403],
      [null, new Set(['people']), 403],
    ] as const) {
      let pulled = false;
      const request = notesRequest('', {
        body: new ReadableStream<Uint8Array>({
          pull() { pulled = true; throw new Error('body must not be read'); },
        }, { highWaterMark: 0 }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      const loadNotes = vi.fn(async () => { throw new Error('must not load'); });
      const response = await handlePastoralNotesExport(notesContext(request, { user, modules }), runtime({ loadNotes }));
      expect(response.status).toBe(status);
      expect(pulled).toBe(false);
      expect(loadNotes).not.toHaveBeenCalled();
    }
  });

  it('accepts only a bounded URL-encoded form with the exact literal acknowledgement', async () => {
    for (const acknowledgement of ['', 'on', PEOPLE_NOTES_ACKNOWLEDGEMENT.toUpperCase(), ` ${PEOPLE_NOTES_ACKNOWLEDGEMENT}`]) {
      const response = await handlePastoralNotesExport(notesContext(notesRequest(acknowledgement)), runtime());
      expect(response.status, acknowledgement).toBe(400);
      expect(await response.json()).toEqual({ ok: false, code: 'acknowledgement_required' });
    }

    const wrongType = await handlePastoralNotesExport(notesContext(notesRequest('', {
      body: 'acknowledgement=x',
      headers: { 'content-type': 'text/plain' },
    })), runtime());
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toEqual({ ok: false, code: 'form_required' });

    let pulled = false;
    const tooLarge = notesRequest('', {
      body: new ReadableStream<Uint8Array>({
        pull() { pulled = true; throw new Error('must not read'); },
      }, { highWaterMark: 0 }),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(PEOPLE_NOTES_FORM_MAX_BYTES + 1),
      },
    });
    const oversized = await handlePastoralNotesExport(notesContext(tooLarge), runtime());
    expect(oversized.status).toBe(413);
    expect(pulled).toBe(false);
    expect(await oversized.json()).toEqual({ ok: false, code: 'form_too_large' });
  });

  it('rejects unknown, repeated, malformed, and streamed-oversize form data', async () => {
    for (const body of [
      `acknowledgement=${encodeURIComponent(PEOPLE_NOTES_ACKNOWLEDGEMENT)}&unknown=x`,
      `acknowledgement=${encodeURIComponent(PEOPLE_NOTES_ACKNOWLEDGEMENT)}&acknowledgement=${encodeURIComponent(PEOPLE_NOTES_ACKNOWLEDGEMENT)}`,
      'acknowledgement=%ZZ',
    ]) {
      const response = await handlePastoralNotesExport(notesContext(notesRequest('', {
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })), runtime());
      expect(response.status, body).toBe(400);
      expect(await response.json()).toEqual({ ok: false, code: 'form_invalid' });
    }

    const response = await handlePastoralNotesExport(notesContext(notesRequest('', {
      body: new Uint8Array(PEOPLE_NOTES_FORM_MAX_BYTES + 1),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })), runtime());
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, code: 'form_too_large' });
  });

  it('awaits the PII-free audit before exposing notes bytes', async () => {
    const events: string[] = [];
    let releaseAudit!: () => void;
    let markAuditStarted!: () => void;
    const auditWait = new Promise<void>((resolve) => { releaseAudit = resolve; });
    const auditStarted = new Promise<void>((resolve) => { markAuditStarted = resolve; });
    const rt = runtime({
      buildNotes: vi.fn(() => { events.push('build'); return notesSuccess; }),
      appendAudit: vi.fn(async (_db, input) => {
        events.push('audit');
        expect(input).toEqual({
          kind: 'people_notes_export_generated',
          actorPersonId: 7,
          counts: { people: 1, notes: 2 },
        });
        markAuditStarted();
        await auditWait;
      }),
    });
    let settled = false;
    const pending = handlePastoralNotesExport(notesContext(), rt).then((response) => {
      settled = true;
      return response;
    });
    await auditStarted;
    expect(events).toEqual(['build', 'audit']);
    expect(settled).toBe(false);
    releaseAudit();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="pastoral-notes-2026-08-12.csv"');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe(notesSuccess.csv);
  });

  it('returns no CSV when repair is required or audit persistence fails', async () => {
    const appendAudit = vi.fn(async () => {});
    const repair = await handlePastoralNotesExport(notesContext(), runtime({
      buildNotes: vi.fn(() => ({
        status: 'repair_required',
        counts: { people: 2, notes: 3, issues: 1 },
      } satisfies PastoralNotesExportResult)),
      appendAudit,
    }));
    expect(repair.status).toBe(409);
    expect(await repair.json()).toEqual({
      ok: false,
      code: 'repair_required',
      counts: { people: 2, notes: 3, issues: 1 },
    });
    expect(appendAudit).not.toHaveBeenCalled();

    const failed = await handlePastoralNotesExport(notesContext(), runtime({
      appendAudit: vi.fn(async () => { throw new Error('private audit failure'); }),
    }));
    expect(failed.status).toBe(500);
    expect(failed.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await failed.text()).toBe('{"ok":false,"code":"export_failed"}');
  });

  it('rejects non-POST methods safely after authorization without reading a body', async () => {
    const response = await handlePastoralNotesExport(notesContext(notesRequest('', { method: 'GET' })), runtime());
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(await response.json()).toEqual({ ok: false, code: 'method_not_allowed' });
  });
});
