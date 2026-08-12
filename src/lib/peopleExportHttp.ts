import type { AppDb } from './appDb';
import { AUDIT_EVENT_KIND, type AppendAuditEventInput } from './auditDb';
import { hasAreaAccess } from './adminAreas';
import { isValidDateStr } from './dates';
import type { DbBackend } from './dbProvider';
import type {
  CanonicalExportPart,
  CanonicalExportResult,
  CanonicalPeopleExportSource,
} from './peopleExport';
import { PEOPLE_IMPORT_HEADERS, PEOPLE_IMPORT_LIMITS } from './peopleImport';
import {
  PASTORAL_NOTES_EXPORT_HEADERS,
  PASTORAL_NOTES_EXPORT_LIMITS,
  type PastoralNotesExportResult,
  type PastoralNotesExportSource,
} from './pastoralNotesExport';
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
  return isValidDateStr(today);
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

const CANONICAL_HEADER = `${PEOPLE_IMPORT_HEADERS.join(',')}\r\n`;
const NOTES_HEADER = `${PASTORAL_NOTES_EXPORT_HEADERS.join(',')}\r\n`;
const UTF8 = new TextEncoder();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPlainDataGraph(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
    if (
      Object.keys(descriptors).length !== expectedKeys.length + 1
      || !Object.hasOwn(descriptors, 'length')
      || expectedKeys.some((key) => !Object.hasOwn(descriptors, key))
    ) return false;
    return expectedKeys.every((key) => {
      const descriptor = descriptors[key];
      return descriptor !== undefined
        && Object.hasOwn(descriptor, 'value')
        && !descriptor.get
        && !descriptor.set
        && isPlainDataGraph(descriptor.value, seen);
    });
  }
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => (
    Object.hasOwn(descriptor, 'value')
    && !descriptor.get
    && !descriptor.set
    && isPlainDataGraph(descriptor.value, seen)
  ));
}

function clonePlainData(input: unknown): unknown | null {
  try {
    if (!isPlainDataGraph(input, new Set())) return null;
    // Structured clone rejects Proxy exotica even when their traps impersonate a
    // plain object. Validation below reads only this detached, immutable-in-scope
    // request snapshot, never the serializer-owned object again.
    return structuredClone(input);
  } catch {
    return null;
  }
}

function hasOnlyDataProperties(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key))) {
    return false;
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
      return false;
    }
  }
  return true;
}

function isBoundedCount(value: unknown, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= maximum;
}

function isBoundedCsv(value: unknown, header: string, maximumBytes: number): value is string {
  return typeof value === 'string'
    && value.startsWith(header)
    && UTF8.encode(value).byteLength <= maximumBytes;
}

/** Snapshot one untrusted serializer result before any header, audit, JSON, or byte sink. */
export function validateCanonicalExportResult(input: unknown): CanonicalExportResult | null {
  try {
    input = clonePlainData(input);
    if (!isPlainRecord(input) || Object.getOwnPropertySymbols(input).length !== 0) return null;
    if (input.status === 'repair_required') {
      if (!hasOnlyDataProperties(input, ['status', 'counts'])) return null;
      const counts = input.counts;
      if (!isPlainRecord(counts) || Object.getOwnPropertySymbols(counts).length !== 0) return null;
      if (!hasOnlyDataProperties(counts, ['people', 'dependents', 'households', 'issues'])) return null;
      const people = counts.people;
      const dependents = counts.dependents;
      const households = counts.households;
      const issues = counts.issues;
      if (
        !isBoundedCount(people, PEOPLE_IMPORT_LIMITS.maxDataRows + 1)
        || !isBoundedCount(dependents, PEOPLE_IMPORT_LIMITS.maxDataRows + 1)
        || !isBoundedCount(households, PEOPLE_IMPORT_LIMITS.maxHouseholds + 1)
        || !isBoundedCount(issues, PEOPLE_IMPORT_LIMITS.maxIssues)
      ) return null;
      return {
        status: 'repair_required',
        counts: { people, dependents, households, issues },
      };
    }
    if (input.status !== 'success' || !hasOnlyDataProperties(input, ['status', 'parts'])) return null;
    const partsInput = input.parts;
    if (
      !Array.isArray(partsInput)
      || Object.getPrototypeOf(partsInput) !== Array.prototype
      || partsInput.length < 1
      || partsInput.length > 25
    ) return null;
    const parts: CanonicalExportPart[] = [];
    for (let index = 0; index < partsInput.length; index += 1) {
      const part = partsInput[index];
      if (!isPlainRecord(part) || Object.getOwnPropertySymbols(part).length !== 0) return null;
      if (!hasOnlyDataProperties(part, ['number', 'rowCount', 'householdCount', 'csv'])) return null;
      const number = part.number;
      const rowCount = part.rowCount;
      const householdCount = part.householdCount;
      const csv = part.csv;
      if (
        number !== index + 1
        || !isBoundedCount(rowCount, PEOPLE_IMPORT_LIMITS.maxDataRows)
        || !isBoundedCount(householdCount, PEOPLE_IMPORT_LIMITS.maxHouseholds)
        || !isBoundedCsv(csv, CANONICAL_HEADER, PEOPLE_IMPORT_LIMITS.maxBytes)
      ) return null;
      parts.push({ number, rowCount, householdCount, csv });
    }
    return { status: 'success', parts };
  } catch {
    return null;
  }
}

/** Snapshot one untrusted sensitive serializer result before audit or CSV exposure. */
export function validatePastoralNotesExportResult(input: unknown): PastoralNotesExportResult | null {
  try {
    input = clonePlainData(input);
    if (!isPlainRecord(input) || Object.getOwnPropertySymbols(input).length !== 0) return null;
    if (input.status === 'repair_required') {
      if (!hasOnlyDataProperties(input, ['status', 'counts'])) return null;
      const counts = input.counts;
      if (!isPlainRecord(counts) || Object.getOwnPropertySymbols(counts).length !== 0) return null;
      if (!hasOnlyDataProperties(counts, ['people', 'notes', 'issues'])) return null;
      const people = counts.people;
      const notes = counts.notes;
      const issues = counts.issues;
      if (
        !isBoundedCount(people, PASTORAL_NOTES_EXPORT_LIMITS.maxNotes + 1)
        || !isBoundedCount(notes, PASTORAL_NOTES_EXPORT_LIMITS.maxNotes + 1)
        || !isBoundedCount(issues, PASTORAL_NOTES_EXPORT_LIMITS.maxIssues)
      ) return null;
      return { status: 'repair_required', counts: { people, notes, issues } };
    }
    if (input.status !== 'success' || !hasOnlyDataProperties(input, ['status', 'counts', 'csv'])) {
      return null;
    }
    const counts = input.counts;
    if (!isPlainRecord(counts) || Object.getOwnPropertySymbols(counts).length !== 0) return null;
    if (!hasOnlyDataProperties(counts, ['people', 'notes'])) return null;
    const people = counts.people;
    const notes = counts.notes;
    const csv = input.csv;
    if (
      !isBoundedCount(people, PASTORAL_NOTES_EXPORT_LIMITS.maxNotes)
      || !isBoundedCount(notes, PASTORAL_NOTES_EXPORT_LIMITS.maxNotes)
      || !isBoundedCsv(csv, NOTES_HEADER, PASTORAL_NOTES_EXPORT_LIMITS.maxCsvBytes)
    ) return null;
    return { status: 'success', counts: { people, notes }, csv };
  } catch {
    return null;
  }
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
    const result = validateCanonicalExportResult(runtime.buildCanonical(source));
    if (result === null) return { status: 'error' };
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
    let totalRows = 0;
    let totalHouseholds = 0;
    const parts: PeopleExportDiscoveryPart[] = [];
    for (const part of result.parts) {
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
    const result = validateCanonicalExportResult(runtime.buildCanonical(source));
    if (result === null) return peopleExportJson(500, { ok: false, code: 'export_failed' });
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
    if (selected > result.parts.length) {
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
    const result = validatePastoralNotesExportResult(runtime.buildNotes(source));
    if (result === null) return peopleExportJson(500, { ok: false, code: 'export_failed' });
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
