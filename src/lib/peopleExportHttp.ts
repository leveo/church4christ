import type { AppDb } from './appDb';
import { AUDIT_EVENT_KIND, type AppendAuditEventInput } from './auditDb';
import { hasAreaAccess } from './adminAreas';
import type { DbBackend } from './dbProvider';
import type { CanonicalExportResult, CanonicalPeopleExportSource } from './peopleExport';
import type { PastoralNotesExportResult, PastoralNotesExportSource } from './pastoralNotesExport';
import type { SessionUser } from './types';

export const PEOPLE_NOTES_ACKNOWLEDGEMENT =
  'EXPORT PASTORAL NOTES' as const;
export const PEOPLE_NOTES_FORM_MAX_BYTES = 8 * 1024;

export type PeopleExportAccess = 'ok' | 'not_found' | 'forbidden';

export interface StandardPeopleExportRuntime {
  loadCanonical: (
    db: AppDb,
    today: string,
    backend: DbBackend,
  ) => Promise<CanonicalPeopleExportSource>;
  buildCanonical: (source: CanonicalPeopleExportSource) => CanonicalExportResult;
}

export interface PastoralNotesExportRuntime {
  loadNotes: (db: AppDb, backend: DbBackend) => Promise<PastoralNotesExportSource>;
  buildNotes: (source: PastoralNotesExportSource) => PastoralNotesExportResult;
  appendAudit: (db: AppDb, input: AppendAuditEventInput) => Promise<void>;
}

export interface PeopleExportRuntime
  extends StandardPeopleExportRuntime, PastoralNotesExportRuntime {}

export interface PeopleExportContext {
  request: Request;
  user: SessionUser | null;
  modules: Set<string>;
  db: AppDb;
  backend: DbBackend;
  today: string;
}

export interface PeopleExportDiscoveryPart {
  number: number;
  rowCount: number;
  householdCount: number;
  href: string;
}

export type PeopleExportDiscoveryResult =
  | { status: 'response'; response: Response }
  | {
      status: 'success';
      partCount: number;
      totalRows: number;
      totalHouseholds: number;
      parts: PeopleExportDiscoveryPart[];
    }
  | {
      status: 'repair_required';
      counts: { people: number; dependents: number; households: number; issues: number };
    }
  | { status: 'error' };

export function canManagePeopleExport(
  user: SessionUser | null,
  modules: Set<string>,
): PeopleExportAccess {
  if (!modules.has('people')) return 'not_found';
  return hasAreaAccess(user, 'people') ? 'ok' : 'forbidden';
}

export function canExportPastoralNotes(
  user: SessionUser | null,
  modules: Set<string>,
): PeopleExportAccess {
  if (!modules.has('people')) return 'not_found';
  return user?.isAdmin === true && user.isSuperAdmin ? 'ok' : 'forbidden';
}

function privateHeaders(headers: HeadersInit = {}): Headers {
  const out = new Headers(headers);
  out.set('cache-control', 'private, no-store');
  out.set('pragma', 'no-cache');
  out.set('x-content-type-options', 'nosniff');
  return out;
}

export function peopleExportJson(
  status: number,
  body: Record<string, unknown>,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = privateHeaders(headers);
  responseHeaders.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function accessResponse(access: PeopleExportAccess): Response | null {
  if (access === 'not_found') return peopleExportJson(404, { ok: false, code: 'not_found' });
  if (access === 'forbidden') return peopleExportJson(403, { ok: false, code: 'forbidden' });
  return null;
}

function validToday(today: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(today);
}

function requestedPart(request: Request): number | null {
  const values = new URL(request.url).searchParams.getAll('part');
  if (values.length === 0) return 1;
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) return null;
  const part = Number(values[0]);
  return Number.isSafeInteger(part) ? part : null;
}

function csvHeaders(filename: string): Headers {
  const headers = privateHeaders();
  headers.set('content-type', 'text/csv; charset=utf-8');
  headers.set('content-disposition', `attachment; filename="${filename}"`);
  return headers;
}

function structuralCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export async function loadPeopleExportDiscovery(
  context: PeopleExportContext,
  runtime: StandardPeopleExportRuntime,
): Promise<PeopleExportDiscoveryResult> {
  const denied = accessResponse(canManagePeopleExport(context.user, context.modules));
  if (denied) return { status: 'response', response: denied };
  if (context.request.method !== 'GET') {
    return {
      status: 'response',
      response: peopleExportJson(
        405,
        { ok: false, code: 'method_not_allowed' },
        { Allow: 'GET' },
      ),
    };
  }
  if (!validToday(context.today)) return { status: 'error' };

  try {
    const source = await runtime.loadCanonical(context.db, context.today, context.backend);
    const result = runtime.buildCanonical(source);
    if (result.status === 'repair_required') {
      return {
        status: 'repair_required',
        counts: {
          people: result.counts.people,
          dependents: result.counts.dependents,
          households: result.counts.households,
          issues: result.counts.issues,
        },
      };
    }
    if (result.parts.length === 0) return { status: 'error' };
    let totalRows = 0;
    let totalHouseholds = 0;
    const parts: PeopleExportDiscoveryPart[] = [];
    for (const [index, part] of result.parts.entries()) {
      if (
        part.number !== index + 1
        || !structuralCount(part.rowCount)
        || !structuralCount(part.householdCount)
      ) return { status: 'error' };
      totalRows += part.rowCount;
      totalHouseholds += part.householdCount;
      if (!Number.isSafeInteger(totalRows) || !Number.isSafeInteger(totalHouseholds)) {
        return { status: 'error' };
      }
      parts.push({
        number: part.number,
        rowCount: part.rowCount,
        householdCount: part.householdCount,
        href: `/admin/people/export.csv?part=${part.number}`,
      });
    }
    return {
      status: 'success',
      partCount: parts.length,
      totalRows,
      totalHouseholds,
      parts,
    };
  } catch {
    return { status: 'error' };
  }
}

export async function handlePeopleExport(
  context: PeopleExportContext,
  runtime: StandardPeopleExportRuntime,
): Promise<Response> {
  const denied = accessResponse(canManagePeopleExport(context.user, context.modules));
  if (denied) return denied;
  if (context.request.method !== 'GET') {
    return peopleExportJson(405, { ok: false, code: 'method_not_allowed' }, { Allow: 'GET' });
  }
  const selected = requestedPart(context.request);
  if (selected === null) return peopleExportJson(400, { ok: false, code: 'invalid_part' });
  if (!validToday(context.today)) return peopleExportJson(500, { ok: false, code: 'export_failed' });

  try {
    const source = await runtime.loadCanonical(context.db, context.today, context.backend);
    const result = runtime.buildCanonical(source);
    if (result.status === 'repair_required') {
      return peopleExportJson(409, {
        ok: false,
        code: 'repair_required',
        counts: {
          people: result.counts.people,
          dependents: result.counts.dependents,
          households: result.counts.households,
          issues: result.counts.issues,
        },
      });
    }
    if (result.parts.length === 0 || selected > result.parts.length) {
      return peopleExportJson(400, { ok: false, code: 'invalid_part' });
    }
    const part = result.parts[selected - 1];
    const headers = csvHeaders(
      `people-${context.today}-part-${part.number}-of-${result.parts.length}.csv`,
    );
    headers.set('x-people-export-part', String(part.number));
    headers.set('x-people-export-parts', String(result.parts.length));
    headers.set('x-people-export-rows', String(part.rowCount));
    headers.set('x-people-export-households', String(part.householdCount));
    return new Response(part.csv, { status: 200, headers });
  } catch {
    return peopleExportJson(500, { ok: false, code: 'export_failed' });
  }
}

type NotesFormResult =
  | { ok: true }
  | { ok: false; status: 400 | 413 | 415; code: 'acknowledgement_required' | 'form_invalid' | 'form_required' | 'form_too_large' };

function contentLengthTooLarge(request: Request): boolean {
  const raw = request.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return false;
  const size = Number(raw);
  return !Number.isSafeInteger(size) || size > PEOPLE_NOTES_FORM_MAX_BYTES;
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > PEOPLE_NOTES_FORM_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The request is already classified as oversized; cancellation is best-effort.
        }
        return null;
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function decodeFormComponent(value: string): string | null {
  if (/%(?![0-9a-f]{2})/i.test(value)) return null;
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

async function readNotesAcknowledgement(request: Request): Promise<NotesFormResult> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, status: 415, code: 'form_required' };
  }
  if (contentLengthTooLarge(request)) {
    return { ok: false, status: 413, code: 'form_too_large' };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedBody(request);
  } catch {
    return { ok: false, status: 400, code: 'form_invalid' };
  }
  if (bytes === null) return { ok: false, status: 413, code: 'form_too_large' };

  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, status: 400, code: 'form_invalid' };
  }
  const fields = body.split('&');
  if (fields.length !== 1) return { ok: false, status: 400, code: 'form_invalid' };
  const equals = fields[0].indexOf('=');
  if (equals < 0 || fields[0].indexOf('=', equals + 1) >= 0) {
    return { ok: false, status: 400, code: 'form_invalid' };
  }
  const name = decodeFormComponent(fields[0].slice(0, equals));
  const value = decodeFormComponent(fields[0].slice(equals + 1));
  if (name === null || value === null || name !== 'acknowledgement') {
    return { ok: false, status: 400, code: 'form_invalid' };
  }
  if (value !== PEOPLE_NOTES_ACKNOWLEDGEMENT) {
    return { ok: false, status: 400, code: 'acknowledgement_required' };
  }
  return { ok: true };
}

export async function handlePastoralNotesExport(
  context: PeopleExportContext,
  runtime: PastoralNotesExportRuntime,
): Promise<Response> {
  const denied = accessResponse(canExportPastoralNotes(context.user, context.modules));
  if (denied) return denied;
  if (context.request.method !== 'POST') {
    return peopleExportJson(405, { ok: false, code: 'method_not_allowed' }, { Allow: 'POST' });
  }
  const form = await readNotesAcknowledgement(context.request);
  if (!form.ok) return peopleExportJson(form.status, { ok: false, code: form.code });
  if (!validToday(context.today)) return peopleExportJson(500, { ok: false, code: 'export_failed' });

  try {
    const source = await runtime.loadNotes(context.db, context.backend);
    const result = runtime.buildNotes(source);
    if (result.status === 'repair_required') {
      return peopleExportJson(409, {
        ok: false,
        code: 'repair_required',
        counts: {
          people: result.counts.people,
          notes: result.counts.notes,
          issues: result.counts.issues,
        },
      });
    }
    await runtime.appendAudit(context.db, {
      kind: AUDIT_EVENT_KIND,
      actorPersonId: context.user!.id,
      counts: { people: result.counts.people, notes: result.counts.notes },
    });
    return new Response(result.csv, {
      status: 200,
      headers: csvHeaders(`pastoral-notes-${context.today}.csv`),
    });
  } catch {
    return peopleExportJson(500, { ok: false, code: 'export_failed' });
  }
}
