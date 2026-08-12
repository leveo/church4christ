import { hasAreaAccess } from './adminAreas';
import { csvCell } from './csv';
import type { PeopleImportHttpResultCode } from './peopleImportContract';
import {
  PEOPLE_IMPORT_HEADERS,
  PEOPLE_IMPORT_LIMITS,
  type PeopleImportDependent,
  type PeopleImportHeader,
  type PeopleImportHouseholdReference,
  type PeopleImportIssue,
  type PeopleImportPerson,
} from './peopleImport';
import {
  PeopleImportConflictError,
  PeopleImportNotReadyError,
  PeopleImportPersistenceError,
  type PeopleImportDbIssue,
  type PeopleImportPreflightResult,
  type PeopleImportValidationResult,
} from './peopleImportDb';
import type { SessionUser } from './types';

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * The whole multipart body is bounded before FormData parsing. The allowance
 * above the file cap covers boundaries and the small acknowledgement field.
 */
export const PEOPLE_IMPORT_MULTIPART_MAX_BYTES =
  PEOPLE_IMPORT_LIMITS.maxBytes + MULTIPART_OVERHEAD_BYTES;

const ACCEPTED_MIME_TYPES = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

export type PeopleImportAccess = 'ok' | 'not_found' | 'forbidden';

export function canManagePeopleImport(
  user: SessionUser | null,
  modules: Set<string>,
): PeopleImportAccess {
  if (!modules.has('people')) return 'not_found';
  return hasAreaAccess(user, 'people') ? 'ok' : 'forbidden';
}

export type PeopleImportFileError = {
  ok: false;
  status: 400 | 413 | 415;
  code: Extract<PeopleImportHttpResultCode,
    | 'multipart_required'
    | 'multipart_invalid'
    | 'missing_file'
    | 'file_too_large'
    | 'file_type_invalid'>;
};

export type PeopleImportFileResult = PeopleImportFileError | {
  ok: true;
  bytes: Uint8Array;
  acknowledgeWarnings: boolean;
};

export interface BoundedCsvMultipartOptions {
  maxBodyBytes: number;
  maxFileBytes: number;
}

export type BoundedCsvMultipartResult = PeopleImportFileError | {
  ok: true;
  bytes: Uint8Array;
  form: FormData;
};

const fileError = (
  status: PeopleImportFileError['status'],
  code: PeopleImportFileError['code'],
): PeopleImportFileError => ({ ok: false, status, code });

function contentLengthOverLimit(request: Request, maxBodyBytes: number): boolean {
  const raw = request.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return false;
  const length = Number(raw);
  return !Number.isSafeInteger(length) || length > maxBodyBytes;
}

async function boundedRequestBody(
  request: Request,
  maxBodyBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        try {
          await reader.cancel();
        } catch {
          // The envelope is already known to be too large; cancellation is best-effort.
        }
        return null;
      }
      chunks.push(value);
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

export async function readBoundedCsvMultipart(
  request: Request,
  options: BoundedCsvMultipartOptions,
): Promise<BoundedCsvMultipartResult> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    return fileError(415, 'multipart_required');
  }
  if (contentLengthOverLimit(request, options.maxBodyBytes)) return fileError(413, 'file_too_large');

  let body: Uint8Array<ArrayBuffer> | null;
  try {
    body = await boundedRequestBody(request, options.maxBodyBytes);
  } catch {
    return fileError(400, 'multipart_invalid');
  }
  if (body === null) return fileError(413, 'file_too_large');

  let form: FormData;
  try {
    form = await new Response(body, {
      headers: { 'content-type': contentType },
    }).formData();
  } catch {
    return fileError(400, 'multipart_invalid');
  }

  const csvParts = form.getAll('csv');
  if (csvParts.length === 0) return fileError(400, 'missing_file');
  if (csvParts.length !== 1 || !(csvParts[0] instanceof File)) {
    return fileError(400, 'multipart_invalid');
  }
  const file = csvParts[0];
  if (file.size > options.maxFileBytes) {
    return fileError(413, 'file_too_large');
  }
  if (!ACCEPTED_MIME_TYPES.has(file.type.toLowerCase())) {
    return fileError(415, 'file_type_invalid');
  }

  return {
    ok: true,
    bytes: new Uint8Array(await file.arrayBuffer()),
    form,
  };
}

export async function readPeopleImportFile(request: Request): Promise<PeopleImportFileResult> {
  const upload = await readBoundedCsvMultipart(request, {
    maxBodyBytes: PEOPLE_IMPORT_MULTIPART_MAX_BYTES,
    maxFileBytes: PEOPLE_IMPORT_LIMITS.maxBytes,
  });
  if (!upload.ok) return upload;
  return {
    ok: true,
    bytes: upload.bytes,
    acknowledgeWarnings: upload.form.get('acknowledge_warnings') === 'true',
  };
}

export interface PeopleImportPreviewIssue {
  severity: 'error' | 'warning';
  code: PeopleImportIssue['code'] | PeopleImportDbIssue['code'];
  row: number | null;
  field: PeopleImportHeader | null;
}

function householdReferenceDto(household: PeopleImportHouseholdReference) {
  return {
    key: household.key,
    name: household.name,
    address: household.address,
    phone: household.phone,
    role: household.role,
    primary: household.primary,
  };
}

function personRowDto(person: PeopleImportPerson) {
  return {
    row: person.row,
    recordType: person.recordType,
    displayName: person.displayName,
    email: person.email,
    firstName: person.firstName,
    lastName: person.lastName,
    phone: person.phone,
    language: person.language,
    membershipStatus: person.membershipStatus,
    birthday: person.birthday,
    joinedOn: person.joinedOn,
    address: person.address,
    active: person.active,
    role: person.role,
    household: person.household === null ? null : householdReferenceDto(person.household),
  };
}

function dependentRowDto(dependent: PeopleImportDependent) {
  return {
    row: dependent.row,
    recordType: dependent.recordType,
    displayName: dependent.displayName,
    household: householdReferenceDto(dependent.household),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePreviewIssues(left: PeopleImportPreviewIssue, right: PeopleImportPreviewIssue): number {
  const severity = (left.severity === 'error' ? 0 : 1) - (right.severity === 'error' ? 0 : 1);
  if (severity !== 0) return severity;
  const row = (left.row ?? Number.MAX_SAFE_INTEGER) - (right.row ?? Number.MAX_SAFE_INTEGER);
  if (row !== 0) return row;
  const field = compareText(left.field ?? '', right.field ?? '');
  return field !== 0 ? field : compareText(left.code, right.code);
}

function previewIssues(
  parsed: PeopleImportValidationResult,
  preflight: PeopleImportPreflightResult,
): PeopleImportPreviewIssue[] {
  const supplied = [
    ...parsed.errors,
    ...parsed.warnings,
    ...preflight.errors,
    ...preflight.warnings,
  ];
  const alreadyTruncated = supplied.some((issue) => issue.code === 'issues_truncated');
  const concrete = supplied
    .filter((issue) => issue.code !== 'issues_truncated')
    .map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      row: issue.row,
      field: issue.field,
    } satisfies PeopleImportPreviewIssue))
    .sort(comparePreviewIssues);

  if (!alreadyTruncated && concrete.length <= PEOPLE_IMPORT_LIMITS.maxIssues) return concrete;
  return [
    ...concrete.slice(0, PEOPLE_IMPORT_LIMITS.maxIssues - 1),
    { severity: 'error', code: 'issues_truncated', row: null, field: null },
  ];
}

export function peopleImportPreviewDto(
  parsed: PeopleImportValidationResult,
  preflight: PeopleImportPreflightResult = { errors: [], warnings: [] },
) {
  const model = parsed.model;
  const summary = model === null
    ? { dataRows: 0, people: 0, dependents: 0, households: 0, inactivePeople: 0 }
    : {
        dataRows: model.summary.dataRows,
        people: model.summary.people,
        dependents: model.summary.dependents,
        households: model.summary.households,
        inactivePeople: model.summary.inactivePeople,
      };
  const rows = model === null
    ? []
    : [
        ...model.people.map(personRowDto),
        ...model.dependents.map(dependentRowDto),
      ].sort((left, right) => left.row - right.row);
  const households = model === null
    ? []
    : model.households.map((household) => ({
        key: household.key,
        name: household.name,
        address: household.address,
        phone: household.phone,
        primaryEmail: household.primaryEmail,
        peopleRows: household.people.map((person) => person.row),
        dependentRows: household.dependents.map((dependent) => dependent.row),
      }));

  return {
    ok: true as const,
    summary,
    rows,
    households,
    issues: previewIssues(parsed, preflight),
  };
}

export function peopleImportCommitErrorResponse(error: unknown): Response {
  if (error instanceof PeopleImportNotReadyError) {
    return peopleImportJson(400, { ok: false, code: 'validation_failed' });
  }
  if (error instanceof PeopleImportConflictError) {
    return peopleImportJson(409, { ok: false, code: 'import_conflict' });
  }
  if (error instanceof PeopleImportPersistenceError) {
    return peopleImportJson(500, { ok: false, code: 'import_failed' });
  }
  return peopleImportJson(500, { ok: false, code: 'generic_error' });
}

const examplePerson: Partial<Record<PeopleImportHeader, string>> = {
  record_type: 'person',
  display_name: 'Jordan Example',
  email: 'jordan.example@example.com',
  first_name: 'Jordan',
  last_name: 'Example',
  language: 'en',
  membership_status: 'visitor',
  active: 'true',
  household_key: 'example-family',
  household_name: 'Example Family',
  household_role: 'adult',
  household_primary: 'true',
};

const exampleDependent: Partial<Record<PeopleImportHeader, string>> = {
  record_type: 'dependent',
  display_name: 'Casey Example',
  household_key: 'example-family',
  household_role: 'child',
  household_primary: 'false',
};

export function peopleImportTemplate(): string {
  return [
    PEOPLE_IMPORT_HEADERS,
    PEOPLE_IMPORT_HEADERS.map((header) => examplePerson[header] ?? ''),
    PEOPLE_IMPORT_HEADERS.map((header) => exampleDependent[header] ?? ''),
  ].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

export function peopleImportJson(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(JSON.stringify(body), { status, headers });
}
