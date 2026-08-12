import { describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  type CanonicalExportResult,
  type CanonicalPeopleExportSource,
} from '../src/lib/peopleExport';
import { PEOPLE_IMPORT_HEADERS, PEOPLE_IMPORT_LIMITS } from '../src/lib/peopleImport';
import {
  PASTORAL_NOTES_EXPORT_HEADERS,
  PASTORAL_NOTES_EXPORT_LIMITS,
  type PastoralNotesExportResult,
  type PastoralNotesExportSource,
} from '../src/lib/pastoralNotesExport';
import {
  PEOPLE_NOTES_ACKNOWLEDGEMENT,
  PEOPLE_NOTES_FORM_MAX_BYTES,
  canExportPastoralNotes,
  canManagePeopleExport,
  handlePastoralNotesExport,
  handlePeopleExport,
  peopleExportJson,
  validateCanonicalExportResult,
  validatePastoralNotesExportResult,
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
const canonicalHeader = `${PEOPLE_IMPORT_HEADERS.join(',')}\r\n`;
const notesHeader = `${PASTORAL_NOTES_EXPORT_HEADERS.join(',')}\r\n`;
const canonicalSuccess: CanonicalExportResult = {
  status: 'success',
  parts: [
    { number: 1, rowCount: 2, householdCount: 1, csv: `${canonicalHeader}part-one\r\n` },
    { number: 2, rowCount: 1, householdCount: 0, csv: `${canonicalHeader}part-two\r\n` },
  ],
};
const notesSuccess: PastoralNotesExportResult = {
  status: 'success',
  counts: { people: 1, notes: 2 },
  csv: `${notesHeader}person-1,private@example.com,Pastor,private,2026-08-12 09:00:00\r\n`,
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
  today?: string;
} = {}) {
  return {
    request: new Request(url),
    user: over.user === undefined ? grantedAdmin : over.user,
    modules: over.modules ?? new Set(['people']),
    db,
    backend: over.backend ?? 'd1',
    today: over.today ?? '2026-08-12',
  } as const;
}

function notesRequest(
  acknowledgement: string = PEOPLE_NOTES_ACKNOWLEDGEMENT,
  init: { body?: BodyInit; headers?: HeadersInit; method?: string } = {},
): Request {
  const body = init.body ?? new URLSearchParams({ acknowledgement });
  return new Request('https://church.example/admin/people/export-notes', {
    method: init.method ?? 'POST',
    body: init.method === 'GET' || init.method === 'HEAD' ? undefined : body,
    headers: init.headers,
  });
}

function notesContext(request = notesRequest(), over: {
  user?: SessionUser | null;
  modules?: Set<string>;
  backend?: 'd1' | 'supabase';
  today?: string;
} = {}) {
  return {
    request,
    user: over.user === undefined ? superAdmin : over.user,
    modules: over.modules ?? new Set(['people']),
    db,
    backend: over.backend ?? 'd1',
    today: over.today ?? '2026-08-12',
  } as const;
}

describe('people export access', () => {
  it('fixes the sensitive-notes acknowledgement to the tracked literal', () => {
    expect(PEOPLE_NOTES_ACKNOWLEDGEMENT).toBe('EXPORT PASTORAL NOTES');
  });

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
    expect(await response.text()).toBe(`${canonicalHeader}part-two\r\n`);
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

  it('validates the calendar date before loading data or constructing download headers', async () => {
    for (const today of ['2026-02-29', '2026-13-01', 'not-a-date\"\r\nx-private: yes']) {
      const loadCanonical = vi.fn(async () => source);
      const response = await handlePeopleExport(
        standardContext(undefined, { today }),
        runtime({ loadCanonical }),
      );
      expect(response.status, today).toBe(500);
      expect(loadCanonical, today).not.toHaveBeenCalled();
      expect(response.headers.get('content-disposition'), today).toBeNull();
      expect(response.headers.get('x-private'), today).toBeNull();
      expect(await response.json()).toEqual({ ok: false, code: 'export_failed' });
    }
  });

  it('rejects malformed canonical repair counts without reflecting values or CSV headers', async () => {
    const invalidCounts = [
      { people: -1, dependents: 0, households: 0, issues: 1 },
      { people: 1.5, dependents: 0, households: 0, issues: 1 },
      { people: Number.NaN, dependents: 0, households: 0, issues: 1 },
      { people: Number.POSITIVE_INFINITY, dependents: 0, households: 0, issues: 1 },
      { people: 202, dependents: 0, households: 0, issues: 1 },
      { people: 0, dependents: 202, households: 0, issues: 1 },
      { people: 0, dependents: 0, households: 102, issues: 1 },
      { people: 0, dependents: 0, households: 0, issues: 101 },
      { people: 'private@example.com', dependents: 0, households: 0, issues: 1 },
    ];
    for (const counts of invalidCounts) {
      const response = await handlePeopleExport(standardContext(), runtime({
        buildCanonical: vi.fn(() => ({ status: 'repair_required', counts }) as never),
      }));
      expect(response.status, JSON.stringify(counts)).toBe(500);
      expect(response.headers.get('content-disposition')).toBeNull();
      expect(response.headers.get('x-people-export-rows')).toBeNull();
      expect(await response.text()).toBe('{"ok":false,"code":"export_failed"}');
    }
  });

  it('rejects malformed canonical parts, hostile accessors, and proxies at one result boundary', async () => {
    const tooLargeCsv = `${canonicalHeader}${'x'.repeat(PEOPLE_IMPORT_LIMITS.maxBytes)}`;
    class PartRecord {
      number = 1;
      rowCount = 0;
      householdCount = 0;
      csv = canonicalHeader;
    }
    const validPart = { number: 1, rowCount: 0, householdCount: 0, csv: canonicalHeader };
    const invalidResults: unknown[] = [
      { status: 'success', parts: [] },
      { status: 'success', parts: Array.from({ length: 26 }, (_, index) => ({ ...validPart, number: index + 1 })) },
      { status: 'success', parts: [{ ...validPart, number: 2 }] },
      { status: 'success', parts: [{ ...validPart, rowCount: -1 }] },
      { status: 'success', parts: [{ ...validPart, rowCount: 201 }] },
      { status: 'success', parts: [{ ...validPart, rowCount: 0.5 }] },
      { status: 'success', parts: [{ ...validPart, rowCount: Number.NaN }] },
      { status: 'success', parts: [{ ...validPart, householdCount: 101 }] },
      { status: 'success', parts: [{ ...validPart, csv: 'private@example.com\r\n' }] },
      { status: 'success', parts: [{ ...validPart, csv: tooLargeCsv }] },
      { status: 'success', parts: [new PartRecord()] },
      new Proxy(canonicalSuccess, {}),
    ];
    let getterCalls = 0;
    const getterResult = { status: 'success', parts: [{ ...validPart }] };
    Object.defineProperty(getterResult.parts[0], 'csv', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return getterCalls === 1 ? canonicalHeader : 'private@example.com';
      },
    });
    invalidResults.push(getterResult);

    for (const result of invalidResults) {
      const response = await handlePeopleExport(standardContext(), runtime({
        buildCanonical: vi.fn(() => result as never),
      }));
      expect(response.status).toBe(500);
      expect(response.headers.get('content-disposition')).toBeNull();
      expect(response.headers.get('x-people-export-part')).toBeNull();
      const body = await response.text();
      expect(body).toBe('{"ok":false,"code":"export_failed"}');
      expect(body).not.toContain('private@example.com');
    }
    expect(getterCalls).toBe(0);
  });

  it('returns a detached stable snapshot from the pure canonical validator', () => {
    const input = structuredClone(canonicalSuccess);
    const validated = validateCanonicalExportResult(input);
    expect(validated).toEqual(canonicalSuccess);
    expect(validated).not.toBe(input);
    if (validated?.status === 'success') {
      expect(validated.parts).not.toBe(input.parts);
      expect(validated.parts[0]).not.toBe(input.parts[0]);
      input.parts[0].rowCount = 199;
      expect(validated.parts[0].rowCount).toBe(2);
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
    for (const acknowledgement of ['', 'on', PEOPLE_NOTES_ACKNOWLEDGEMENT.toLowerCase(), ` ${PEOPLE_NOTES_ACKNOWLEDGEMENT}`]) {
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

  it('accepts a valid body without Content-Length and ignores a lying small length', async () => {
    const validBody = `acknowledgement=${encodeURIComponent('EXPORT PASTORAL NOTES')}`;
    const accepted = await handlePastoralNotesExport(notesContext(notesRequest('', {
      body: validBody,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })), runtime());
    expect(accepted.status).toBe(200);

    const lied = await handlePastoralNotesExport(notesContext(notesRequest('', {
      body: new Uint8Array(PEOPLE_NOTES_FORM_MAX_BYTES + 1),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '1',
      },
    })), runtime());
    expect(lied.status).toBe(413);
    expect(await lied.json()).toEqual({ ok: false, code: 'form_too_large' });
  });

  it('cancels an actual oversize stream and remains 413 when cancellation rejects', async () => {
    for (const cancelRejects of [false, true]) {
      let cancelled = false;
      let sent = false;
      const request = notesRequest('', {
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) return controller.close();
            sent = true;
            controller.enqueue(new Uint8Array(PEOPLE_NOTES_FORM_MAX_BYTES + 1));
          },
          cancel() {
            cancelled = true;
            if (cancelRejects) throw new Error('private cancellation detail');
          },
        }),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      const response = await handlePastoralNotesExport(notesContext(request), runtime());
      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(await response.json()).toEqual({ ok: false, code: 'form_too_large' });
    }
  });

  it('maps body-read failures and invalid UTF-8 to generic safe form errors', async () => {
    const unreadable = notesRequest('', {
      body: new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new Error('private body detail')); },
      }, { highWaterMark: 0 }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const invalidUtf8 = notesRequest('', {
      body: new Uint8Array([0x61, 0x63, 0x6b, 0x3d, 0xc3, 0x28]),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    for (const request of [unreadable, invalidUtf8]) {
      const response = await handlePastoralNotesExport(notesContext(request), runtime());
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toBe('{"ok":false,"code":"form_invalid"}');
      expect(body).not.toContain('private');
    }
  });

  it('releases the body reader after success, exact-limit, oversize, cancellation failure, and read failure', async () => {
    const valid = `acknowledgement=${encodeURIComponent(PEOPLE_NOTES_ACKNOWLEDGEMENT)}`;
    const exact = new Uint8Array(PEOPLE_NOTES_FORM_MAX_BYTES).fill(0x61);
    const overChunks = [
      new Uint8Array(PEOPLE_NOTES_FORM_MAX_BYTES - 3).fill(0x61),
      new Uint8Array(4).fill(0x62),
    ];
    const cases: Array<{ request: Request; status: number }> = [
      {
        request: notesRequest('', {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(valid.slice(0, 9)));
              controller.enqueue(new TextEncoder().encode(valid.slice(9)));
              controller.close();
            },
          }),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
        status: 200,
      },
      {
        request: notesRequest('', {
          body: new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(exact); controller.close(); },
          }),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
        status: 400,
      },
      {
        request: notesRequest('', {
          body: new ReadableStream<Uint8Array>({
            start(controller) { for (const chunk of overChunks) controller.enqueue(chunk); },
            cancel() { throw new Error('private cancellation detail'); },
          }),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
        status: 413,
      },
      {
        request: notesRequest('', {
          body: new ReadableStream<Uint8Array>({
            pull(controller) { controller.error(new Error('private read detail')); },
          }, { highWaterMark: 0 }),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
        status: 400,
      },
    ];
    for (const item of cases) {
      const response = await handlePastoralNotesExport(notesContext(item.request), runtime());
      expect(response.status).toBe(item.status);
      expect(item.request.body?.locked).toBe(false);
    }
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

  it('validates notes results and the calendar before audit or any sensitive byte/header sink', async () => {
    const invalidResults: unknown[] = [
      { status: 'repair_required', counts: { people: -1, notes: 0, issues: 1 } },
      { status: 'repair_required', counts: { people: 5002, notes: 0, issues: 1 } },
      { status: 'repair_required', counts: { people: 0, notes: 5002, issues: 1 } },
      { status: 'repair_required', counts: { people: 0, notes: 0, issues: 101 } },
      { status: 'success', counts: { people: -1, notes: 0 }, csv: notesHeader },
      { status: 'success', counts: { people: 0.5, notes: 0 }, csv: notesHeader },
      { status: 'success', counts: { people: Number.NaN, notes: 0 }, csv: notesHeader },
      { status: 'success', counts: { people: Number.POSITIVE_INFINITY, notes: 0 }, csv: notesHeader },
      { status: 'success', counts: { people: 5001, notes: 0 }, csv: notesHeader },
      { status: 'success', counts: { people: 0, notes: 5001 }, csv: notesHeader },
      { status: 'success', counts: { people: 0, notes: 0 }, csv: 'body,private@example.com\r\n' },
      {
        status: 'success',
        counts: { people: 0, notes: 0 },
        csv: `${notesHeader}${'x'.repeat(PASTORAL_NOTES_EXPORT_LIMITS.maxCsvBytes)}`,
      },
      new Proxy(notesSuccess, {}),
    ];
    let getterCalls = 0;
    const getterResult = { status: 'success', counts: { people: 1, notes: 2 }, csv: notesHeader };
    Object.defineProperty(getterResult.counts, 'notes', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return getterCalls === 1 ? 2 : 'private@example.com';
      },
    });
    invalidResults.push(getterResult);

    for (const result of invalidResults) {
      const appendAudit = vi.fn(async () => {});
      const response = await handlePastoralNotesExport(notesContext(), runtime({
        buildNotes: vi.fn(() => result as never),
        appendAudit,
      }));
      expect(response.status).toBe(500);
      expect(appendAudit).not.toHaveBeenCalled();
      expect(response.headers.get('content-disposition')).toBeNull();
      const body = await response.text();
      expect(body).toBe('{"ok":false,"code":"export_failed"}');
      expect(body).not.toContain('private@example.com');
    }
    expect(getterCalls).toBe(0);

    const loadNotes = vi.fn(async () => notesSource);
    const appendAudit = vi.fn(async () => {});
    const invalidDate = await handlePastoralNotesExport(
      notesContext(undefined, { today: '2026-02-29' }),
      runtime({ loadNotes, appendAudit }),
    );
    expect(invalidDate.status).toBe(500);
    expect(loadNotes).not.toHaveBeenCalled();
    expect(appendAudit).not.toHaveBeenCalled();
    expect(invalidDate.headers.get('content-disposition')).toBeNull();
  });

  it('returns a detached stable snapshot from the pure notes validator', () => {
    const input = structuredClone(notesSuccess);
    const validated = validatePastoralNotesExportResult(input);
    expect(validated).toEqual(notesSuccess);
    expect(validated).not.toBe(input);
    if (validated?.status === 'success') {
      expect(validated.counts).not.toBe(input.counts);
      input.counts.notes = 99;
      expect(validated.counts.notes).toBe(2);
    }
  });

  it('audits every repeated and concurrent accepted notes export exactly once and awaits all audits', async () => {
    const releases: Array<() => void> = [];
    const appendAudit = vi.fn(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    const rt = runtime({ appendAudit });
    let settled = 0;
    const pending = Array.from({ length: 4 }, () => (
      handlePastoralNotesExport(notesContext(), rt).then((response) => {
        settled += 1;
        return response;
      })
    ));
    await vi.waitFor(() => expect(appendAudit).toHaveBeenCalledTimes(4));
    expect(settled).toBe(0);
    expect(releases).toHaveLength(4);
    for (const release of releases) release();
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(appendAudit).toHaveBeenCalledTimes(4);
  });

  it('uses the validated notes snapshot when the serializer-owned result mutates during audit', async () => {
    const mutable = structuredClone(notesSuccess);
    const originalCsv = mutable.status === 'success' ? mutable.csv : '';
    const response = await handlePastoralNotesExport(notesContext(), runtime({
      buildNotes: vi.fn(() => mutable),
      appendAudit: vi.fn(async () => {
        if (mutable.status === 'success') {
          mutable.counts.people = 5_000;
          mutable.counts.notes = 5_000;
          mutable.csv = `${notesHeader}person-1,private@example.com,Changed,changed,2026-08-12 10:00:00\r\n`;
        }
      }),
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(originalCsv);
  });

  it('rejects GET, HEAD, and OPTIONS safely after authorization without reading a body', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const response = await handlePastoralNotesExport(
        notesContext(notesRequest('', { method })),
        runtime(),
      );
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('POST');
      expect(await response.json()).toEqual({ ok: false, code: 'method_not_allowed' });
    }
  });
});
