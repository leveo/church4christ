import { hasAreaAccess } from './adminAreas';
import { csvCell } from './csv';
import {
  PEOPLE_IMPORT_HEADERS,
  PEOPLE_IMPORT_LIMITS,
  type PeopleImportHeader,
} from './peopleImport';
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
  code:
    | 'multipart_required'
    | 'multipart_invalid'
    | 'missing_file'
    | 'file_too_large'
    | 'file_type_invalid';
};

export type PeopleImportFileResult = PeopleImportFileError | {
  ok: true;
  bytes: Uint8Array;
  acknowledgeWarnings: boolean;
};

const fileError = (
  status: PeopleImportFileError['status'],
  code: PeopleImportFileError['code'],
): PeopleImportFileError => ({ ok: false, status, code });

function contentLengthOverLimit(request: Request): boolean {
  const raw = request.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return false;
  const length = Number(raw);
  return !Number.isSafeInteger(length) || length > PEOPLE_IMPORT_MULTIPART_MAX_BYTES;
}

async function boundedRequestBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > PEOPLE_IMPORT_MULTIPART_MAX_BYTES) {
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

export async function readPeopleImportFile(request: Request): Promise<PeopleImportFileResult> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    return fileError(415, 'multipart_required');
  }
  if (contentLengthOverLimit(request)) return fileError(413, 'file_too_large');

  let body: Uint8Array<ArrayBuffer> | null;
  try {
    body = await boundedRequestBody(request);
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
  if (file.size > PEOPLE_IMPORT_LIMITS.maxBytes) {
    return fileError(413, 'file_too_large');
  }
  if (!ACCEPTED_MIME_TYPES.has(file.type.toLowerCase())) {
    return fileError(415, 'file_type_invalid');
  }

  return {
    ok: true,
    bytes: new Uint8Array(await file.arrayBuffer()),
    acknowledgeWarnings: form.get('acknowledge_warnings') === 'true',
  };
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
