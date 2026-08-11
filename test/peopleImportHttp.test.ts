import { describe, expect, it } from 'vitest';
import { PEOPLE_IMPORT_HEADERS, PEOPLE_IMPORT_LIMITS, parsePeopleImport } from '../src/lib/peopleImport';
import type { SessionUser } from '../src/lib/types';
import {
  PEOPLE_IMPORT_MULTIPART_MAX_BYTES,
  canManagePeopleImport,
  peopleImportJson,
  peopleImportTemplate,
  readPeopleImportFile,
} from '../src/lib/peopleImportHttp';
import * as templateRoute from '../src/pages/admin/people/import/template.csv';

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
